import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldState } from "./state.ts";
import { buildHandoff } from "./handoff.ts";
import { validateEvent } from "./validate.ts";
import { recordableDecision, DecisionValidationError } from "./decide.ts";
import type { OperationalEvent, Shift, ShiftState } from "./types.ts";

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

/** D104 conflict: "send to claims" (scanner) vs "discarded" (operator). */
function conflictedEvents(): OperationalEvent[] {
  return [
    ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "marked send to claims", claim: "send to claims", source: "scanner" }),
    ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "another report says discarded", claim: "discarded", source: "operator" }),
  ];
}

function d104Item(state: ShiftState) {
  const item = state.items.find((i) => i.canonicalSubject === "d104");
  assert.ok(item, "expected a d104 item");
  return item;
}

describe("recordableDecision builds the append-only decision event", () => {
  it("produces a validated decision_recorded event naming the chosen claim", () => {
    const state = foldState(TEST_SHIFT, conflictedEvents());
    const event = recordableDecision({
      state,
      subject: "damaged case D104",
      claim: "send to claims",
      eventId: "decision-1",
      occurredAt: "2026-09-08T05:40:00Z",
    });
    assert.equal(event.kind, "decision_recorded");
    assert.equal(event.claim, "send to claims");
    assert.equal(event.id, "decision-1");
    assert.equal(event.shiftId, "shift-1");
    assert.equal(event.occurredAt, "2026-09-08T05:40:00.000Z");
    assert.ok(event.description.length > 0);
    assert.equal(event.source, "human");
    // It must pass the same schema gate as any other event.
    assert.deepEqual(validateEvent(event), event);
  });

  it("accepts an equivalent phrasing of a conflicting claim", () => {
    const state = foldState(TEST_SHIFT, conflictedEvents());
    // "claims" and "send to claims" are the same canonical concept.
    const event = recordableDecision({
      state,
      subject: "D104",
      claim: "claims",
      eventId: "decision-2",
      occurredAt: "2026-09-08T05:41:00Z",
    });
    assert.equal(event.claim, "claims");
  });
});

describe("scenario 1: decision resolves conflict", () => {
  const state = foldState(TEST_SHIFT, [
    ...conflictedEvents(),
    validateEvent(
      recordableDecision({ state: foldState(TEST_SHIFT, conflictedEvents()), subject: "damaged case D104", claim: "send to claims", eventId: "decision-1", occurredAt: "2026-09-08T05:40:00Z" }),
    ),
  ]);

  it("item lifecycle becomes decided with the chosen claim", () => {
    const item = d104Item(state);
    assert.equal(item.status, "decided");
    assert.equal(item.decision?.canonicalValue, "claims");
    assert.equal(item.decision?.value, "send to claims");
  });

  it("item no longer appears under human review", () => {
    const handoff = buildHandoff(state);
    assert.equal(handoff.requiresHumanReview.length, 0);
  });
});

describe("scenario 2: history preserved after decision", () => {
  const state = foldState(TEST_SHIFT, [
    ...conflictedEvents(),
    validateEvent(
      recordableDecision({ state: foldState(TEST_SHIFT, conflictedEvents()), subject: "damaged case D104", claim: "send to claims", eventId: "decision-1", occurredAt: "2026-09-08T05:40:00Z" }),
    ),
  ]);

  it("both original claims and the decision event remain in history", () => {
    assert.equal(state.events.length, 3);
    const item = d104Item(state);
    const history = state.events.filter((e) => item.contributingEventIds.includes(e.id));
    assert.deepEqual(history.map((e) => e.kind), ["status_claimed", "status_claimed", "decision_recorded"]);
  });

  it("competing claims remain visible on the item for audit", () => {
    const item = d104Item(state);
    assert.deepEqual(item.claims.map((c) => c.canonicalValue), ["claims", "discard"]);
    assert.equal(item.claims.length, 2);
  });
});

describe("scenario 3: invalid decision rejected", () => {
  const events = conflictedEvents();
  const before = foldState(TEST_SHIFT, events);

  it("rejects a claim that is not one of the conflicting concepts", () => {
    assert.throws(
      () =>
        recordableDecision({
          state: before,
          subject: "damaged case D104",
          claim: "donate",
          eventId: "decision-x",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && /donate/.test(err.message) && /claims/.test(err.message),
    );
  });

  it("rejects an empty claim", () => {
    assert.throws(
      () =>
        recordableDecision({
          state: before,
          subject: "damaged case D104",
          claim: "   ",
          eventId: "decision-x",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      DecisionValidationError,
    );
  });

  it("state is unchanged after rejections: item remains conflicted, history intact", () => {
    const after = foldState(TEST_SHIFT, events);
    assert.deepEqual(after.items, before.items);
    assert.equal(after.events.length, 2);
    assert.equal(d104Item(after).status, "conflicted");
  });
});

describe("scenario 4: cannot decide non-conflicted items", () => {
  const state = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "aisle 7", description: "blocked" }),
    ev({ occurredAt: "2026-09-08T03:04:00Z", kind: "cleared", subject: "aisle 7", description: "cleared" }),
    ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "missed" }),
  ]);

  it("rejects a decision on an open item", () => {
    assert.throws(
      () =>
        recordableDecision({
          state,
          subject: "freezer inspection",
          claim: "claims",
          eventId: "decision-x",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && /not conflicted/.test(err.message),
    );
  });

  it("rejects a decision on a resolved item", () => {
    assert.throws(
      () =>
        recordableDecision({
          state,
          subject: "aisle 7",
          claim: "claims",
          eventId: "decision-x",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && /not conflicted/.test(err.message),
    );
  });

  it("rejects a decision on a subject that has no item at all", () => {
    assert.throws(
      () =>
        recordableDecision({
          state,
          subject: "pallet 99",
          claim: "claims",
          eventId: "decision-x",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && /no operational item/.test(err.message),
    );
  });
});

describe("scenario 5: repeated decision behavior", () => {
  it("builder rejects a second decision once the item is decided", () => {
    const decided = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent(
        recordableDecision({ state: foldState(TEST_SHIFT, conflictedEvents()), subject: "damaged case D104", claim: "send to claims", eventId: "decision-1", occurredAt: "2026-09-08T05:40:00Z" }),
      ),
    ]);
    assert.throws(
      () =>
        recordableDecision({
          state: decided,
          subject: "damaged case D104",
          claim: "discarded",
          eventId: "decision-2",
          occurredAt: "2026-09-08T05:50:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && /already/.test(err.message),
    );
  });

  it("fold keeps the first decision even if a later decision event exists (stickiness)", () => {
    const state = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent({ id: "decision-1", shiftId: "shift-1", occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "human decision", claim: "send to claims", source: "human" }),
      validateEvent({ id: "decision-2", shiftId: "shift-1", occurredAt: "2026-09-08T05:50:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "second decision", claim: "discarded", source: "human" }),
    ]);
    const item = d104Item(state);
    assert.equal(item.status, "decided");
    assert.equal(item.decision?.canonicalValue, "claims", "first decision wins");
    assert.equal(item.contributingEventIds.length, 4, "second decision stays in history but has no effect");
  });

  it("a claim arriving after the decision does not reopen the item", () => {
    const state = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent({ id: "decision-1", shiftId: "shift-1", occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "human decision", claim: "send to claims", source: "human" }),
      validateEvent({ id: "late-claim", shiftId: "shift-1", occurredAt: "2026-09-08T05:55:00Z", kind: "status_claimed", subject: "damaged case D104", description: "late contradictory report", claim: "salvage", source: "operator" }),
    ]);
    const item = d104Item(state);
    assert.equal(item.status, "decided", "decision is sticky against later claims");
    assert.equal(item.claims.length, 3, "late claim retained for audit");
  });
});

describe("scenario 6: handoff correctness around the decision", () => {
  const before = foldState(TEST_SHIFT, conflictedEvents());
  const after = foldState(TEST_SHIFT, [
    ...conflictedEvents(),
    validateEvent(
      recordableDecision({ state: before, subject: "damaged case D104", claim: "send to claims", eventId: "decision-1", occurredAt: "2026-09-08T05:40:00Z" }),
    ),
  ]);

  it("before: D104 is under human review", () => {
    const handoff = buildHandoff(before);
    assert.equal(handoff.requiresHumanReview.length, 1);
    assert.equal(handoff.requiresHumanReview[0]?.canonicalSubject, "d104");
    assert.equal(handoff.decidedDuringShiftCount, 0);
  });

  it("after: D104 leaves human review and moves the decided count", () => {
    const handoff = buildHandoff(after);
    assert.equal(handoff.requiresHumanReview.length, 0);
    assert.equal(handoff.decidedDuringShiftCount, 1);
    assert.equal(handoff.resolvedDuringShiftCount, 0);
  });
});

describe("decision by equivalent subject phrasing", () => {
  it("deciding 'D104' resolves the item opened as 'damaged case D104'", () => {
    const conflicted = foldState(TEST_SHIFT, conflictedEvents());
    const state = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent(
        recordableDecision({ state: conflicted, subject: "D104", claim: "discarded", eventId: "decision-1", occurredAt: "2026-09-08T05:40:00Z" }),
      ),
    ]);
    const item = d104Item(state);
    assert.equal(item.status, "decided");
    assert.equal(item.decision?.canonicalValue, "discard");
  });
});

describe("scenario 7: decision provenance", () => {
  const conflicted = foldState(TEST_SHIFT, conflictedEvents());

  it("records the human actor on the append-only event", () => {
    const event = recordableDecision({
      state: conflicted,
      subject: "damaged case D104",
      claim: "send to claims",
      actor: "Shift Supervisor",
      eventId: "decision-1",
      occurredAt: "2026-09-08T05:40:00Z",
    });
    assert.equal(event.actor, "Shift Supervisor");
    assert.equal(event.note, undefined);
    assert.deepEqual(validateEvent(event), event);
  });

  it("records an optional note alongside the actor", () => {
    const event = recordableDecision({
      state: conflicted,
      subject: "damaged case D104",
      claim: "claims",
      actor: "Shift Supervisor",
      note: "scanner label was correct",
      eventId: "decision-1",
      occurredAt: "2026-09-08T05:40:00Z",
    });
    assert.equal(event.note, "scanner label was correct");
  });

  it("survives the fold onto the item so the audit trail is readable", () => {
    const state = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent(
        recordableDecision({
          state: conflicted,
          subject: "damaged case D104",
          claim: "send to claims",
          actor: "Shift Supervisor",
          note: "scanner label was correct",
          eventId: "decision-1",
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      ),
    ]);
    const item = d104Item(state);
    assert.equal(item.status, "decided", "provenance must not change the lifecycle result");
    assert.equal(item.decision?.canonicalValue, "claims");
    assert.equal(item.decision?.actor, "Shift Supervisor");
    assert.equal(item.decision?.note, "scanner label was correct");
  });

  it("keeps a decision without provenance readable (backward compatibility)", () => {
    const state = foldState(TEST_SHIFT, [
      ...conflictedEvents(),
      validateEvent({ id: "legacy-decision", shiftId: "shift-1", occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "human decision", claim: "send to claims", source: "human" }),
    ]);
    const item = d104Item(state);
    assert.equal(item.status, "decided");
    assert.equal(item.decision?.actor, undefined);
  });
});
