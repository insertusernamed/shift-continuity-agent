import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldState } from "./state.ts";
import { buildHandoff } from "./handoff.ts";
import { validateEvent } from "./validate.ts";
import type { OperationalEvent, Shift } from "./types.ts";

const TEST_SHIFT: Shift = { id: "shift-1", name: "Test Shift", startedAt: "2026-09-08T02:00:00.000Z" };

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

describe("scenario 4: conflict remains visible", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims", source: "scanner" }),
    ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator" }),
  ]);
  const handoff = buildHandoff(state);

  it("D104 is identified as conflicted", () => {
    assert.equal(itemFor(state.items, "D104").status, "conflicted");
  });

  it("appears in handoff under human review", () => {
    assert.equal(handoff.requiresHumanReview.length, 1);
    assert.equal(handoff.requiresHumanReview[0]?.subject, "damaged case D104");
    assert.equal(handoff.requiresHumanReview[0]?.status, "conflicted");
  });

  it("keeps both contradictory claims", () => {
    const item = itemFor(state.items, "D104");
    assert.deepEqual(item.claims.map((c) => c.value), ["send to claims", "discarded"]);
  });

  it("a decision reconciles the conflict", () => {
    const reconciled = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded" }),
      ev({ occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "shift lead: went to claims", claim: "send to claims", source: "shift-lead" }),
    ]);
    assert.equal(itemFor(reconciled.items, "D104").status, "decided");
    assert.equal(buildHandoff(reconciled).requiresHumanReview.length, 0);
  });
});

describe("scenario 5: noise is omitted", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked" }),
    ev({ occurredAt: "2026-09-08T02:37:00Z", kind: "problem_reported", subject: "pallet 83", description: "cannot be worked", blockedBy: "aisle 7" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
    ev({ occurredAt: "2026-09-08T03:21:00Z", kind: "work_completed", subject: "pallet 83", description: "pallet 83 completed" }),
    ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "freezer inspection missed" }),
  ]);
  const handoff = buildHandoff(state);

  it("handoff contains only the unresolved item", () => {
    assert.equal(handoff.requiresAction.length, 1);
    assert.equal(handoff.requiresAction[0]?.subject, "freezer inspection");
    assert.equal(handoff.requiresHumanReview.length, 0);
  });

  it("reports resolved counts without repeating resolved items", () => {
    assert.equal(handoff.resolvedDuringShiftCount, 2);
    assert.equal(handoff.decidedDuringShiftCount, 0);
  });
});

describe("phase 6 demo scenario: exact handoff expectation", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "aisle 7 blocked" }),
    ev({ occurredAt: "2026-09-08T02:37:00Z", kind: "problem_reported", subject: "pallet 83", description: "pallet 83 cannot be worked because aisle 7 is blocked", blockedBy: "aisle 7" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "aisle 7 cleared" }),
    ev({ occurredAt: "2026-09-08T03:21:00Z", kind: "work_completed", subject: "pallet 83", description: "pallet 83 completed" }),
    ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "freezer inspection missed" }),
    ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "marked send to claims", claim: "send to claims", source: "scanner" }),
    ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "was discarded", claim: "discarded", source: "operator" }),
  ]);
  const handoff = buildHandoff(state);

  it("requires action: freezer inspection", () => {
    assert.equal(handoff.requiresAction.length, 1);
    assert.equal(handoff.requiresAction[0]?.subject, "freezer inspection");
  });

  it("human review: D104 conflict", () => {
    assert.equal(handoff.requiresHumanReview.length, 1);
    assert.equal(handoff.requiresHumanReview[0]?.subject, "damaged case D104");
  });

  it("aisle and pallet resolved counts", () => {
    assert.equal(handoff.resolvedDuringShiftCount, 2);
  });

  it("full history retained: 7 events", () => {
    assert.equal(state.events.length, 7);
  });
});
