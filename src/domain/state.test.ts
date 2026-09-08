import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldState } from "./state.ts";
import { validateEvent } from "./validate.ts";
import type { OperationalEvent, Shift } from "./types.ts";

const TEST_SHIFT: Shift = { id: "shift-1", name: "Test Shift", startedAt: "2026-09-08T02:00:00.000Z" };

// Deterministic local helper: every event in these tests is fully valid,
// so tests stay focused on state behavior rather than validation.
function ev(partial: Omit<OperationalEvent, "id" | "shiftId" | "source"> & { source?: string }): OperationalEvent {
  const candidate: OperationalEvent = {
    id: partial.occurredAt + "-" + partial.kind + "-" + partial.subject,
    shiftId: "shift-1",
    source: partial.source ?? "radio",
    ...partial,
  };
  return validateEvent(candidate);
}

function itemFor(items: ReturnType<typeof foldState>["items"], subjectPart: string) {
  const item = items.find((i) => i.subject.toLowerCase().includes(subjectPart.toLowerCase()));
  assert.ok(item, `expected an item matching "${subjectPart}"`);
  return item;
}

describe("scenario 1: unresolved item survives", () => {
  it("freezer inspection appears as open", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "freezer inspection missed" }),
    ]);
    const item = itemFor(state.items, "freezer");
    assert.equal(item.status, "open");
    assert.equal(item.category, "issue");
    assert.equal(item.openedAt, "2026-09-08T04:46:00.000Z");
  });
});

describe("scenario 2: resolved problem disappears", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked by pallet jack" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
  ]);

  it("aisle 7 is not unresolved", () => {
    const item = itemFor(state.items, "aisle 7");
    assert.equal(item.status, "resolved");
    assert.equal(item.resolvedByEventId, "2026-09-08T03:04:00Z-cleared-aisle 7");
  });

  it("historical events still exist", () => {
    assert.equal(state.events.length, 2);
  });
});

describe("scenario 3: dependent work eventually resolves", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked" }),
    ev({ occurredAt: "2026-09-08T02:37:00Z", kind: "problem_reported", subject: "pallet 83", description: "pallet 83 cannot be worked", blockedBy: "aisle 7" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
    ev({ occurredAt: "2026-09-08T03:21:00Z", kind: "work_completed", subject: "pallet 83", description: "pallet 83 completed" }),
  ]);

  it("neither aisle 7 nor pallet 83 is unresolved", () => {
    assert.equal(itemFor(state.items, "aisle 7").status, "resolved");
    assert.equal(itemFor(state.items, "pallet 83").status, "resolved");
  });

  it("keeps the causal link as explanatory context", () => {
    assert.equal(itemFor(state.items, "pallet 83").blockedBySubjectKey, "aisle 7");
  });

  it("keeps all four events in history", () => {
    assert.equal(state.events.length, 4);
  });
});

describe("scenario 6: chronology matters", () => {
  it("a backdated older event never overwrites newer state", () => {
    // Events arrive out of chronological order (late scanner sync): the
    // "cleared" event is appended to the list BEFORE the backdated block report.
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
      ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked" }),
    ]);
    const item = itemFor(state.items, "aisle 7");
    assert.equal(item.status, "resolved", "older event must not reopen a cleared item");
    assert.equal(item.openedAt, "2026-09-08T02:11:00.000Z", "openedAt reflects the older report");
    assert.equal(item.resolvedAt, "2026-09-08T03:04:00.000Z");
    assert.deepEqual(state.events.map((e) => e.occurredAt), [
      "2026-09-08T02:11:00.000Z",
      "2026-09-08T03:04:00.000Z",
    ], "events are presented chronologically regardless of arrival order");
  });
});

describe("scenario 7: complete history remains available", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
  ]);

  it("resolved item still exposes its opening and resolving events", () => {
    const item = itemFor(state.items, "aisle 7");
    const history = eventsForItem(state, item.id);
    assert.deepEqual(history.map((e) => e.kind), ["problem_reported", "cleared"]);
    assert.equal(history.length, 2);
  });
});

function eventsForItem(state: ReturnType<typeof foldState>, itemId: string) {
  const item = state.items.find((i) => i.id === itemId);
  assert.ok(item, "item should exist");
  return state.events.filter((e) => item.contributingEventIds.includes(e.id));
}
