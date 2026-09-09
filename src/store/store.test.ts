import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "./jsonFileStore.ts";
import { validateEvent } from "../domain/validate.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shift-store-"));
  file = join(dir, "shifts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

describe("JsonFileShiftStore", () => {
  it("creates a shift with generated id and start time", () => {
    const store = new JsonFileShiftStore(file);
    const shift = store.createShift("Night Shift");
    assert.ok(shift.id.length > 0);
    assert.equal(shift.name, "Night Shift");
    assert.ok(shift.startedAt);
    assert.equal(shift.endedAt, undefined);
  });

  it("appends events and returns them chronologically", () => {
    const store = new JsonFileShiftStore(file);
    const shift = store.createShift("Night Shift");
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T03:04:00Z" }));
    store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T02:11:00Z" }));
    const events = store.getEvents(shift.id);
    assert.deepEqual(events.map((e) => e.occurredAt), [
      "2026-09-08T02:11:00.000Z",
      "2026-09-08T03:04:00.000Z",
    ]);
  });

  it("folds events into domain state", () => {
    const store = new JsonFileShiftStore(file);
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

  it("returns undefined state for unknown shift", () => {
    const store = new JsonFileShiftStore(file);
    assert.equal(store.getShiftState("nope"), undefined);
  });

  it("refuses events for an ended shift", () => {
    const store = new JsonFileShiftStore(file);
    const shift = store.createShift("Night Shift");
    store.endShift(shift.id, "2026-09-08T06:00:00Z");
    assert.throws(
      () => store.appendEvent(makeEvent(shift.id)),
      (err: Error) => err.message.includes("ended"),
    );
  });

  it("endShift sets endedAt once and rejects double-ending", () => {
    const store = new JsonFileShiftStore(file);
    const shift = store.createShift("Night Shift");
    const ended = store.endShift(shift.id, "2026-09-08T06:00:00Z");
    assert.equal(ended.endedAt, "2026-09-08T06:00:00.000Z");
    assert.throws(() => store.endShift(shift.id, "2026-09-08T07:00:00Z"), /already ended/);
  });

  it("persists across instances (survives restart)", () => {
    const first = new JsonFileShiftStore(file);
    const shift = first.createShift("Night Shift");
    first.appendEvent(makeEvent(shift.id));

    const second = new JsonFileShiftStore(file);
    const loaded = second.getShift(shift.id);
    assert.ok(loaded, "shift should survive a restart");
    assert.equal(loaded.name, "Night Shift");
    assert.equal(second.getEvents(shift.id).length, 1);
  });

  it("lists shifts newest first", () => {
    const store = new JsonFileShiftStore(file);
    store.createShift("Night Shift");
    store.createShift("Day Shift");
    const names = store.listShifts().map((s) => s.name);
    assert.deepEqual(names, ["Day Shift", "Night Shift"]);
  });

  it("a recorded human decision survives restart with its full history", () => {
    const first = new JsonFileShiftStore(file);
    const shift = first.createShift("Night Shift");
    first.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "claims", claim: "send to claims", source: "scanner" }));
    first.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator" }));
    first.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "human decision", claim: "send to claims", source: "human" }));

    // Simulate an application restart: a brand-new store over the same file.
    const second = new JsonFileShiftStore(file);
    const state = second.getShiftState(shift.id);
    assert.ok(state);
    const d104 = state.items.find((i) => i.canonicalSubject === "d104");
    assert.ok(d104);
    assert.equal(d104.status, "decided");
    assert.equal(d104.decision?.canonicalValue, "claims");
    assert.equal(state.events.length, 3, "both claims and the decision remain in history");
  });
});
