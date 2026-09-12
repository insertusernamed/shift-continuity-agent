/**
 * Pure domain types for the shift handoff system.
 *
 * This module must stay free of I/O, frameworks, and vendor dependencies
 * (see AGENTS.md §5). These types are the contract the tests describe.
 */

/** What an operational event asserts happened. */
export type EventKind =
  /** A problem exists and is not yet handled (blocked, broken, missed, damaged). */
  | "problem_reported"
  /** An obstructing condition ended ("aisle 7 cleared", "compressor fixed"). */
  | "cleared"
  /** A piece of work was finished ("pallet 83 completed"). */
  | "work_completed"
  /** A neutral assertion of a value, e.g. a disposition claim ("send to claims"). */
  | "status_claimed"
  /** A human reconciled an item/conflict or decided its outcome. */
  | "decision_recorded"
  /** A human explicitly reopened a prior decision; the item returns to conflicted. */
  | "decision_reopened";

/** Lifecycle of an operational item. */
export type ItemStatus =
  | "open" // still relevant; belongs in handoff "requires action"
  | "resolved" // closed by a later event; history only
  | "conflicted" // contradictory claims; needs human review
  | "decided"; // closed by an explicit human decision

export type ItemCategory =
  /** A problem or piece of work that can be cleared/completed. */
  | "issue"
  /** An asserted value about a subject (e.g. disposition of damaged goods). */
  | "disposition";

/**
 * Photo evidence attached to a report (submission-prep milestone). The bytes
 * live in local storage keyed by id; only metadata is part of the event, so
 * the append-only log stays small and the fold stays deterministic.
 */
export interface EvidenceAttachment {
  id: string;
  /** Original file name as supplied by the reporter (display only). */
  fileName: string;
  /** MIME type; images only — evidence is photographic by definition here. */
  contentType: string;
  /** Short human note captured with the photo. */
  note?: string;
}

/** Something reported during a shift. The append-only source of truth. */
export interface OperationalEvent {
  id: string;
  shiftId: string;
  /** ISO 8601 UTC timestamp. Chronology is by this field, not arrival order. */
  occurredAt: string;
  kind: EventKind;
  /** The entity this event is about, e.g. "aisle 7", "case D104". */
  subject: string;
  description: string;
  /** Who or how this was reported, e.g. "radio", "scanner", "operator". */
  source: string;
  /** Required for status_claimed and decision_recorded: the asserted value. */
  claim?: string;
  /** Optional causal context: the subject that caused this problem, e.g. pallet blocked because "aisle 7" is blocked. Explanatory only — never auto-resolves anything. */
  blockedBy?: string;
  /** Optional photo evidence attached to this report (see EvidenceAttachment). */
  evidence?: EvidenceAttachment[];
  /**
   * Who authorized a human action (decision_recorded / decision_reopened), as a
   * display identity such as "Shift Supervisor". Supplied by the application
   * from the current human context; never invented by a model, and optional so
   * decisions recorded before provenance existed stay readable.
   */
  actor?: string;
  /** Optional human-supplied reason recorded with a decision or reopen. */
  note?: string;
}

/** One asserted value attached to a disposition item. */
export interface DispositionClaim {
  eventId: string;
  /** Raw reported text, preserved for history/display. */
  value: string;
  /** Canonical concept used for conflict comparison (see claims.ts). */
  canonicalValue: string;
  occurredAt: string;
  /** Provenance, present when the claim came from an attributed human action. */
  actor?: string;
  note?: string;
}

/**
 * A recorded reopening of a decision. Kept on the item so the reason behind an
 * undo is readable without re-deriving it from the event log.
 */
export interface ReopenRecord {
  eventId: string;
  occurredAt: string;
  actor?: string;
  note?: string;
}

/**
 * The current known state of something that may matter to the next shift.
 * Derived by folding events in chronological order; never stored as truth.
 */
export interface OperationalItem {
  id: string;
  shiftId: string;
  category: ItemCategory;
  subject: string;
  /** Canonical identity used to match events about the same subject (see subjects.ts). */
  canonicalSubject: string;
  description: string;
  status: ItemStatus;
  openedAt: string;
  openedByEventId: string;
  /** Every event that contributed to this item, in chronological order. */
  contributingEventIds: string[];
  /** Populated for disposition items; contradictory claims are all kept. */
  claims: DispositionClaim[];
  /**
   * Present once a human decision reconciled the item. After an explicit
   * reopen this holds the superseded decision, so the audit trail stays intact.
   */
  decision?: DispositionClaim;
  /** Present only while a decided item is reopened and awaiting a new decision. */
  reopened?: ReopenRecord;
  blockedByCanonicalSubject?: string;
  resolvedAt?: string;
  resolvedByEventId?: string;
}

/** A single period of work. */
export interface Shift {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
}

/** Full derived view of one shift: history plus current item state. */
export interface ShiftState {
  shift: Shift;
  /** All events, sorted chronologically. Never truncated. */
  events: OperationalEvent[];
  items: OperationalItem[];
}

/** The handoff: only what the incoming shift still needs to act on. */
export interface ShiftHandoff {
  shiftId: string;
  shiftName: string;
  /** Unresolved problems and work, oldest first. */
  requiresAction: OperationalItem[];
  /** Contradictory information that a human must reconcile. */
  requiresHumanReview: OperationalItem[];
  /** Count of items closed by events during the shift (noise, not repeated). */
  resolvedDuringShiftCount: number;
  /** Count of items closed by explicit human decision. */
  decidedDuringShiftCount: number;
}
