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

export class DecisionValidationError extends Error {}

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
    throw new DecisionValidationError(`no operational item exists for subject "${subject.trim()}"`);
  }
  if (item.status === "decided") {
    throw new DecisionValidationError(
      `item "${item.subject}" has already been decided (${item.decision?.value}); decisions are final in this PoC`,
    );
  }
  if (item.status !== "conflicted") {
    throw new DecisionValidationError(`item "${item.subject}" is not conflicted (status: ${item.status}); there is nothing to reconcile`);
  }

  const trimmed = claim.trim();
  if (!trimmed) {
    throw new DecisionValidationError("decision claim must be a non-empty value");
  }

  const chosen = canonicalClaim(trimmed);
  const available = [...new Set(item.claims.map((c) => c.canonicalValue))];
  if (!available.includes(chosen)) {
    throw new DecisionValidationError(
      `"${trimmed}" is not one of the conflicting claims for "${item.subject}"; allowed: ${available.join(", ")}`,
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
