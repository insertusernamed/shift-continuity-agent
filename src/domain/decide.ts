import type { OperationalEvent, ShiftState } from "./types.ts";
import { canonicalSubject } from "./subjects.ts";
import { canonicalClaim } from "./claims.ts";
import { normalizeIso } from "./validate.ts";

/**
 * Human-review decision gate (human-review-loop milestone).
 *
 * A decision is just another append-only OperationalEvent — no separate
 * decision table (AGENTS.md §7). This module is the validation gate that
 * decides whether recording one is legitimate *right now*:
 *
 * - the subject must resolve to an existing operational item,
 * - that item must currently be conflicted (open/resolved/decided are all refused),
 * - the chosen claim must be one of the conflicting canonical concepts —
 *   the human picks between what was reported; the system never invents options,
 * - equivalent phrasings of a conflicting claim are accepted ("claims" for
 *   "send to claims"), because conflict comparison is by canonical concept.
 *
 * It builds the event; it never mutates state. The fold remains the sole
 * source of truth.
 */

export type DecisionErrorCode =
  /** Subject resolves to no operational item. */
  | "item_not_found"
  /** Item exists but is open/resolved/decided — nothing to reconcile. */
  | "item_not_conflicted"
  /** Item already decided; decisions are final in this PoC. */
  | "already_decided"
  /** Empty, or not among the currently conflicting canonical claims. */
  | "invalid_claim";

export class DecisionValidationError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason so HTTP layers can map status without parsing text. */
    readonly code: DecisionErrorCode,
  ) {
    super(message);
  }
}

export interface RecordableDecision {
  state: ShiftState;
  /** The subject the decision is about; canonical identity is derived from it. */
  subject: string;
  /** The chosen claim, raw text; must canonically match a conflicting claim. */
  claim: string;
  eventId: string;
  occurredAt: string;
}

/** Build a validated, append-only decision event for a currently conflicted item. */
export function recordableDecision(input: RecordableDecision): OperationalEvent {
  const { state, subject, claim, eventId, occurredAt } = input;

  const canonical = canonicalSubject(subject);
  const item = state.items.find((i) => i.canonicalSubject === canonical);
  if (!item) {
    throw new DecisionValidationError(`no operational item exists for subject "${subject.trim()}"`, "item_not_found");
  }
  if (item.status === "decided") {
    throw new DecisionValidationError(
      `item "${item.subject}" has already been decided (${item.decision?.value}); decisions are final in this PoC`,
      "already_decided",
    );
  }
  if (item.status !== "conflicted") {
    throw new DecisionValidationError(
      `item "${item.subject}" is not conflicted (status: ${item.status}); there is nothing to reconcile`,
      "item_not_conflicted",
    );
  }

  const trimmed = claim.trim();
  if (!trimmed) {
    throw new DecisionValidationError("decision claim must be a non-empty value", "invalid_claim");
  }

  const chosen = canonicalClaim(trimmed);
  const available = [...new Set(item.claims.map((c) => c.canonicalValue))];
  if (!available.includes(chosen)) {
    throw new DecisionValidationError(
      `"${trimmed}" is not one of the conflicting claims for "${item.subject}"; allowed: ${available.join(", ")}`,
      "invalid_claim",
    );
  }

  return {
    id: eventId,
    shiftId: state.shift.id,
    // Same canonical UTC timestamp form as every other stored event.
    occurredAt: normalizeIso(occurredAt),
    kind: "decision_recorded",
    subject: item.subject,
    description: `Human decision for ${item.subject}: ${trimmed}`,
    source: "human",
    claim: trimmed,
  };
}
