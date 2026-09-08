import type { OperationalEvent, Shift } from "../domain/types.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";

/**
 * The Phase 6 demo scenario. Seeded as real persisted events through the
 * normal store path, so the demo exercises the same pipeline as live use.
 */
export function createDemoShift(store: ShiftStore): Shift {
  const shift = store.createShift("Night Shift (demo)", "2026-09-08T02:00:00Z");

  const events: OperationalEvent[] = [
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "Aisle 7 blocked by a stray pallet jack", source: "radio" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T02:37:00Z", kind: "problem_reported", subject: "pallet 83", description: "Pallet 83 cannot be worked because aisle 7 is blocked", source: "radio", blockedBy: "aisle 7" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "Aisle 7 cleared", source: "radio" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T03:21:00Z", kind: "work_completed", subject: "pallet 83", description: "Pallet 83 completed", source: "scanner" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "Freezer inspection missed", source: "radio" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "Marked send to claims", claim: "send to claims", source: "scanner" },
    { id: crypto.randomUUID(), shiftId: shift.id, occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "Another report says it was discarded", claim: "discarded", source: "operator" },
  ];

  for (const event of events) store.appendEvent(event);

  store.endShift(shift.id, "2026-09-08T06:00:00Z");
  return shift;
}
