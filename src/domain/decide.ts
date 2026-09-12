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
 * - the human actor is recorded as provenance on the event itself, so a
 *   decision is attributable in the audit trail rather than anonymous.
 *
 * This module also owns the inverse gate: `reopenableDecision` undoes a
 * decision. A reopen is never an edit or a delete — it appends a
 * decision_reopened event, and only a currently decided item may be reopened.
 * Ordinary reports can never reopen anything.
 *
 * Both builders only build events; they never mutate state. The fold remains
 * the sole source of truth.
 */

export type DecisionErrorCode =
  /** Subject resolves to no operational item. */
  | "item_not_found"
  /** Item exists but is open/resolved/decided — nothing to reconcile. */
  | "item_not_conflicted"
  /** Item already decided; reopen it first if it must change. */
  | "already_decided"
  /** Empty, or not among the currently conflicting canonical claims. */
  | "invalid_claim"
  /** Reopen was attempted on an item that is not currently decided. */
  | "item_not_decided"
  /** A human action was submitted without naming who authorized it. */
  | "missing_actor";

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
  /**
   * Who authorized the decision, supplied by the calling application from the
   * current human context. No model derives this value on its own.
   */
  actor?: string;
  /** Optional human-supplied reason, recorded verbatim. */
  note?: string;
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

  return withProvenance(
    {
      id: eventId,
      shiftId: state.shift.id,
      // Same canonical UTC timestamp form as every other stored event.
      occurredAt: normalizeIso(occurredAt),
      kind: "decision_recorded",
      subject: item.subject,
      description: `Human decision for ${item.subject}: ${trimmed}`,
      source: "human",
      claim: trimmed,
    },
    input,
  );
}

export interface ReopenableDecision {
  state: ShiftState;
  /** The subject whose decision is being undone. */
  subject: string;
  /** Who authorized the reopen. Required: an unattributed reopen is refused. */
  actor: string;
  eventId: string;
  occurredAt: string;
  /** Optional human-supplied reason, recorded verbatim. */
  reason?: string;
}

/**
 * Build the append-only event that undoes a decision. The gate is deliberately
 * narrow: only a currently decided item can be reopened, and only a named human
 * can ask for it. The prior decision is not touched — the fold keeps it on the
 * item and the original decision event stays in history.
 */
export function reopenableDecision(input: ReopenableDecision): OperationalEvent {
  const { state, subject, eventId, occurredAt } = input;

  const canonical = canonicalSubject(subject);
  const item = state.items.find((i) => i.canonicalSubject === canonical);
  if (!item) {
    throw new DecisionValidationError(`no operational item exists for subject "${subject.trim()}"`, "item_not_found");
  }
  if (item.status !== "decided") {
    throw new DecisionValidationError(
      `item "${item.subject}" is not decided (status: ${item.status}); there is no decision to reopen`,
      "item_not_decided",
    );
  }
  const actor = (input.actor ?? "").trim();
  if (!actor) {
    throw new DecisionValidationError("reopening a decision requires a named human actor", "missing_actor");
  }

  const reason = (input.reason ?? "").trim();
  const superseded = item.decision?.value ?? "the recorded decision";
  return {
    id: eventId,
    shiftId: state.shift.id,
    occurredAt: normalizeIso(occurredAt),
    kind: "decision_reopened",
    subject: item.subject,
    description: `Human reopened the decision for ${item.subject} (was: ${superseded})`,
    source: "human",
    actor,
    ...(reason ? { note: reason } : {}),
  };
}

/**
 * Provenance is attached only when supplied, and blank values are dropped
 * rather than stored: an empty actor would read as attributed in the audit
 * trail while naming nobody.
 */
function withProvenance(
  event: OperationalEvent,
  provenance: { actor?: string; note?: string },
): OperationalEvent {
  const actor = (provenance.actor ?? "").trim();
  const note = (provenance.note ?? "").trim();
  return {
    ...event,
    ...(actor ? { actor } : {}),
    ...(note ? { note } : {}),
  };
}
