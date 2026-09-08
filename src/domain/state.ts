import type {
  DispositionClaim,
  OperationalEvent,
  OperationalItem,
  Shift,
  ShiftState,
  ItemStatus,
  ItemCategory,
} from "./types.ts";
import { subjectKey } from "./validate.ts";

/**
 * Deterministic state machine: folds a chronological event log into the
 * current operational state. This is the core product logic.
 *
 * Rules:
 * - Events are applied in occurredAt order, never arrival order, so a
 *   backdated older event cannot overwrite a newer known state.
 * - Nothing is discarded: every event lands in history and in the
 *   contributing set of the item it touched.
 * - Contradictory disposition claims are all kept and flip the item to
 *   "conflicted" until an explicit decision reconciles it.
 * - A genuinely newer problem report reopens a resolved item; that is a
 *   new fact, not an old one overwriting new state.
 */
export function foldState(shift: Shift, events: OperationalEvent[]): ShiftState {
  const chronological = [...events].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt),
  );

  const items = new Map<string, OperationalItem>();

  for (const event of chronological) {
    applyEvent(items, event);
  }

  return {
    shift,
    events: chronological,
    items: [...items.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
  };
}

function itemId(shiftId: string, key: string): string {
  return `${shiftId}:${key}`;
}

function newItem(event: OperationalEvent, category: ItemCategory): OperationalItem {
  const key = subjectKey(event.subject);
  const item: OperationalItem = {
    id: itemId(event.shiftId, key),
    shiftId: event.shiftId,
    category,
    subject: event.subject.trim(),
    subjectKey: key,
    description: event.description,
    status: "open",
    openedAt: event.occurredAt,
    openedByEventId: event.id,
    contributingEventIds: [event.id],
    claims: [],
  };
  if (event.blockedBy) item.blockedBySubjectKey = event.blockedBy;
  return item;
}

function applyEvent(items: Map<string, OperationalItem>, event: OperationalEvent): void {
  const key = subjectKey(event.subject);
  let item = items.get(itemId(event.shiftId, key));

  if (!item) {
    const category: ItemCategory =
      event.kind === "status_claimed" || event.kind === "decision_recorded"
        ? "disposition"
        : "issue";
    item = newItem(event, category);
    // A "cleared"/"work_completed" as the first event for a subject still
    // yields an item so no data is silently dropped; it starts resolved.
    if (event.kind === "cleared" || event.kind === "work_completed") {
      item.status = "resolved";
      item.resolvedAt = event.occurredAt;
      item.resolvedByEventId = event.id;
    }
    if (event.kind === "status_claimed") item.claims.push(toClaim(event));
    if (event.kind === "decision_recorded") {
      item.decision = toClaim(event);
      item.status = "decided";
    }
    items.set(item.id, item);
    return;
  }

  item.contributingEventIds.push(event.id);

  switch (event.kind) {
    case "problem_reported": {
      // A newer report of the same problem reopens it; chronological order
      // guarantees this cannot be an older event overwriting newer state.
      item.status = "open";
      item.description = event.description;
      if (event.blockedBy) item.blockedBySubjectKey = event.blockedBy;
      break;
    }
    case "cleared":
    case "work_completed": {
      if (item.status !== "decided") {
        item.status = "resolved";
        item.resolvedAt = event.occurredAt;
        item.resolvedByEventId = event.id;
      }
      break;
    }
    case "status_claimed": {
      item.claims.push(toClaim(event));
      if (isContradictory(item.claims)) {
        item.status = "conflicted";
      }
      break;
    }
    case "decision_recorded": {
      item.decision = toClaim(event);
      item.status = "decided";
      break;
    }
  }
}

function toClaim(event: OperationalEvent): DispositionClaim {
  return { eventId: event.id, value: event.claim!, occurredAt: event.occurredAt };
}

/** Two different values for the same subject are contradictory. */
function isContradictory(claims: DispositionClaim[]): boolean {
  return new Set(claims.map((c) => c.value)).size > 1;
}

/** Status helper for callers that filter unresolved items. */
export function isUnresolved(status: ItemStatus): boolean {
  return status === "open" || status === "conflicted";
}
