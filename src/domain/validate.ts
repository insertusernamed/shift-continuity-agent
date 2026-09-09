import type { EvidenceAttachment, OperationalEvent, EventKind } from "./types.ts";
import { canonicalSubject } from "./subjects.ts";

const EVENT_KINDS: readonly EventKind[] = [
  "problem_reported",
  "cleared",
  "work_completed",
  "status_claimed",
  "decision_recorded",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** ISO 8601 instant check; also rejects impossible dates like 2026-13-45. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === normalizeIso(value);
}

/** Canonicalize to the UTC ISO form we use everywhere. */
export function normalizeIso(value: string): string {
  return new Date(value).toISOString();
}

/**
 * Schema validation for events arriving from any source (UI, seed, LLM).
 * Validation is deterministic domain logic; nothing bypasses it.
 * The raw subject is preserved for history/display; canonical identity is
 * derived separately by the fold (see subjects.ts).
 */
export function validateEvent(candidate: unknown): OperationalEvent {
  if (typeof candidate !== "object" || candidate === null) {
    throw new ValidationError("event must be an object");
  }
  const e = candidate as Record<string, unknown>;

  for (const field of ["id", "shiftId", "occurredAt", "subject", "description", "source"] as const) {
    if (!isNonEmptyString(e[field])) {
      throw new ValidationError(`event field "${field}" must be a non-empty string`);
    }
  }
  if (!EVENT_KINDS.includes(e.kind as EventKind)) {
    throw new ValidationError(`event kind "${String(e.kind)}" is not a known kind`);
  }
  if (!isIsoTimestamp(e.occurredAt)) {
    throw new ValidationError(`event field "occurredAt" must be a valid ISO 8601 timestamp`);
  }

  const event = candidate as OperationalEvent;
  if (event.kind === "status_claimed" || event.kind === "decision_recorded") {
    if (!isNonEmptyString(event.claim)) {
      throw new ValidationError(`event kind "${event.kind}" requires a non-empty "claim"`);
    }
  }

  // Photo evidence metadata is schema-checked here like any other field: the
  // bytes are stored outside the event, but what the event claims about them
  // must be well-formed before it becomes history.
  if ("evidence" in e && e.evidence !== undefined) {
    if (!Array.isArray(e.evidence) || e.evidence.length === 0) {
      throw new ValidationError('event field "evidence" must be a non-empty array when present');
    }
    for (const item of e.evidence) validateEvidence(item);
  }

  // blockedBy is causal context only; canonicalize it so links survive
  // phrasing ("aisle 7" and "blocked aisle 7" refer to the same subject).
  const normalized: OperationalEvent = { ...event, occurredAt: normalizeIso(event.occurredAt) };
  if (isNonEmptyString(normalized.blockedBy)) {
    normalized.blockedBy = canonicalSubject(normalized.blockedBy);
  } else {
    delete normalized.blockedBy;
  }
  return normalized;
}

function validateEvidence(candidate: unknown): asserts candidate is EvidenceAttachment {
  if (typeof candidate !== "object" || candidate === null) {
    throw new ValidationError('evidence must be an object with "id", "fileName", and "contentType"');
  }
  const e = candidate as Record<string, unknown>;
  for (const field of ["id", "fileName", "contentType"] as const) {
    if (!isNonEmptyString(e[field])) {
      throw new ValidationError(`evidence field "${field}" must be a non-empty string`);
    }
  }
  if (!(e.contentType as string).startsWith("image/")) {
    throw new ValidationError(`evidence "contentType" must be an image type, got "${String(e.contentType)}"`);
  }
  // Present-but-blank notes fail loudly rather than being silently dropped.
  if ("note" in e && e.note !== undefined && !isNonEmptyString(e.note)) {
    throw new ValidationError('evidence "note" must be a non-empty string when present');
  }
}

export class ValidationError extends Error {}
