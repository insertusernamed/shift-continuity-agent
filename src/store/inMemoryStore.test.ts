import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryShiftStore } from "./inMemoryStore.ts";
import { validateEvent } from "../domain/validate.ts";

function makeEvent(shiftId: string, overrides: Partial<Parameters<typeof validateEvent>[0]> = {}) {
  return validateEvent({
    id: crypto.randomUUID(),
    shiftId,
    occurredAt: "2026-09-08T02:11:00Z",
    kind: "problem_reported",
    subject: "aisle 7",
    description: "aisle 7 blocked",
    source: "test",
    ...overrides,
  });
}

/**
 * InMemoryShiftStore backs the AgentCore runtime entrypoint: AgentCore
 * microVMs have ephemeral filesystems, so a JSON file would be misleading
 * ("persistence" that silently vanishes). The store implements the same
 * ShiftStore contract as JsonFileShiftStore and reuses the exact same domain
 * services (validateEvent, foldState) so the deployed agent behaves
 * identically — except that state is process-local and resets on cold start.
 */
describe("InMemoryShiftStore", () => {
  it("creates a shift with generated id and start time", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    assert.ok(shift.id.length > 0);
    assert.equal(shift.name, "Night Shift");
    assert.ok(shift.startedAt);
    assert.equal(shift.endedAt, undefined);
  });

  it("appends events and returns them chronologically", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T03:04:00Z" }));
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T02:11:00Z" }));
    assert.deepEqual(
      store.getEvents(shift.id).map((e) => e.occurredAt),
      ["2026-09-08T02:11:00.000Z", "2026-09-08T03:04:00.000Z"],
    );
  });

  it("folds events into domain state through the deterministic fold", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T02:11:00Z" }));
    store.appendEvent(
      makeEvent(shift.id, { occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", description: "aisle 7 cleared" }),
    );
    const state = store.getShiftState(shift.id);
    assert.ok(state);
    assert.equal(state.events.length, 2);
    assert.equal(state.items[0]?.status, "resolved");
  });

  it("a conflicted item becomes decided through a recorded human decision", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "claims", claim: "send to claims", source: "scanner" }));
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator" }));
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "human decision", claim: "send to claims", source: "human" }));
    const state = store.getShiftState(shift.id);
    const d104 = state?.items.find((i) => i.canonicalSubject === "d104");
    assert.equal(d104?.status, "decided");
    assert.equal(d104?.decision?.canonicalValue, "claims");
    assert.equal(state?.events.length, 3, "both claims and the decision remain in history");
  });

  it("returns undefined state for unknown shift", () => {
    const store = new InMemoryShiftStore();
    assert.equal(store.getShiftState("nope"), undefined);
  });

  it("refuses events for an unknown or ended shift", () => {
    const store = new InMemoryShiftStore();
    assert.throws(() => store.appendEvent(makeEvent("nope")), /unknown shift/);
    const shift = store.createShift("Night Shift");
    store.endShift(shift.id, "2026-09-08T06:00:00Z");
    assert.throws(
      () => store.appendEvent(makeEvent(shift.id)),
      (err: Error) => err.message.includes("ended"),
    );
  });

  it("endShift sets endedAt once and rejects double-ending", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    const ended = store.endShift(shift.id, "2026-09-08T06:00:00Z");
    assert.equal(ended.endedAt, "2026-09-08T06:00:00.000Z");
    assert.throws(() => store.endShift(shift.id, "2026-09-08T07:00:00Z"), /already ended/);
  });

  it("lists shifts newest first", () => {
    const store = new InMemoryShiftStore();
    store.createShift("Night Shift");
    store.createShift("Day Shift");
    assert.deepEqual(
      store.listShifts().map((s) => s.name),
      ["Day Shift", "Night Shift"],
    );
  });

  it("rejects malformed events through validateEvent at the store boundary", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    assert.throws(
      () =>
        store.appendEvent({
          id: crypto.randomUUID(),
          shiftId: shift.id,
          occurredAt: "not-a-date",
          kind: "problem_reported",
          subject: "aisle 7",
          description: "aisle 7 blocked",
          source: "test",
        }),
      /occurredAt/,
    );
  });

  it("is process-local by design: a new instance starts empty", () => {
    const store = new InMemoryShiftStore();
    const shift = store.createShift("Night Shift");
    store.appendEvent(makeEvent(shift.id));
    // A second instance has no shared state — this documents the AgentCore
    // runtime persistence limitation (ephemeral per-VM state).
    const fresh = new InMemoryShiftStore();
    assert.equal(fresh.getShift(shift.id), undefined);
    assert.equal(fresh.getEvents(shift.id).length, 0);
  });
});