import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldState } from "./state.ts";
import { buildHandoff } from "./handoff.ts";
import { validateEvent } from "./validate.ts";
import { recordableDecision, reopenableDecision, DecisionValidationError } from "./decide.ts";
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

function decide(state: ShiftState, claim: string, eventId: string, occurredAt: string, actor?: string): OperationalEvent {
  return validateEvent(
    recordableDecision({
      state,
      subject: "damaged case D104",
      claim,
      eventId,
      occurredAt,
      ...(actor ? { actor } : {}),
    }),
  );
}

/** D104 decided "claims" by a named human, on top of the two conflicting claims. */
function decidedEvents(actor = "Shift Supervisor"): OperationalEvent[] {
  const conflicted = conflictedEvents();
  return [...conflicted, decide(foldState(TEST_SHIFT, conflicted), "send to claims", "decision-1", "2026-09-08T05:40:00Z", actor)];
}

function d104Item(state: ShiftState) {
  const item = state.items.find((i) => i.canonicalSubject === "d104");
  assert.ok(item, "expected a d104 item");
  return item;
}

describe("reopenableDecision builds the append-only reopen event", () => {
  const decided = foldState(TEST_SHIFT, decidedEvents());

  it("produces a validated decision_reopened event for a decided item", () => {
    const event = reopenableDecision({
      state: decided,
      subject: "D104",
      actor: "Shift Supervisor",
      reason: "Claims ticket was created in error",
      eventId: "reopen-1",
      occurredAt: "2026-09-08T06:05:00Z",
    });
    assert.equal(event.kind, "decision_reopened");
    assert.equal(event.id, "reopen-1");
    assert.equal(event.shiftId, "shift-1");
    assert.equal(event.occurredAt, "2026-09-08T06:05:00.000Z");
    assert.equal(event.actor, "Shift Supervisor");
    assert.equal(event.note, "Claims ticket was created in error");
    assert.equal(event.source, "human");
    // It must pass the same schema gate as any other event.
    assert.deepEqual(validateEvent(event), event);
  });

  it("accepts a reopen with no reason", () => {
    const event = reopenableDecision({
      state: decided,
      subject: "damaged case D104",
      actor: "Shift Supervisor",
      eventId: "reopen-2",
      occurredAt: "2026-09-08T06:06:00Z",
    });
    assert.equal(event.note, undefined);
  });

  it("refuses a reopen with no named actor", () => {
    assert.throws(
      () =>
        reopenableDecision({
          state: decided,
          subject: "D104",
          actor: "   ",
          eventId: "reopen-x",
          occurredAt: "2026-09-08T06:07:00Z",
        }),
      (err: unknown) => err instanceof DecisionValidationError && err.code === "missing_actor",
    );
  });
});

describe("scenario: explicit reopen returns a decided item to conflict", () => {
  const decided = foldState(TEST_SHIFT, decidedEvents());
  const reopened = foldState(TEST_SHIFT, [
    ...decidedEvents(),
    validateEvent(
      reopenableDecision({ state: decided, subject: "D104", actor: "Shift Supervisor", reason: "Claims ticket was created in error", eventId: "reopen-1", occurredAt: "2026-09-08T06:05:00Z" }),
    ),
  ]);

  it("moves the item from decided back to conflicted", () => {
    assert.equal(d104Item(decided).status, "decided");
    assert.equal(d104Item(reopened).status, "conflicted");
  });

  it("keeps the original conflicting claims available for the next decision", () => {
    const item = d104Item(reopened);
    const concepts = [...new Set(item.claims.map((c) => c.canonicalValue))].sort();
    assert.deepEqual(concepts, ["claims", "discard"]);
  });

  it("preserves the superseded decision in history rather than deleting it", () => {
    const item = d104Item(reopened);
    assert.equal(item.decision?.canonicalValue, "claims", "the prior decision stays visible on the item");
    assert.equal(item.decision?.actor, "Shift Supervisor");
    const kinds = reopened.events.filter((e) => item.contributingEventIds.includes(e.id)).map((e) => e.kind);
    assert.deepEqual(kinds, ["status_claimed", "status_claimed", "decision_recorded", "decision_reopened"]);
  });

  it("keeps the reopen actor and reason in history", () => {
    const event = reopened.events.find((e) => e.kind === "decision_reopened");
    assert.ok(event);
    assert.equal(event.actor, "Shift Supervisor");
    assert.equal(event.note, "Claims ticket was created in error");
  });

  it("exposes the reopen on the item so the reason is readable without parsing history", () => {
    const item = d104Item(reopened);
    assert.ok(item.reopened, "a reopened item should carry the reopen record");
    assert.equal(item.reopened.eventId, "reopen-1");
    assert.equal(item.reopened.occurredAt, "2026-09-08T06:05:00.000Z");
    assert.equal(item.reopened.actor, "Shift Supervisor");
    assert.equal(item.reopened.note, "Claims ticket was created in error");
    // The superseded decision is still a decision, not a reopen record.
    assert.equal(d104Item(decided).reopened, undefined);
  });

  it("clears the reopen record once a new decision is recorded", () => {
    const redecided = foldState(TEST_SHIFT, [
      ...decidedEvents(),
      validateEvent(reopenableDecision({ state: decided, subject: "D104", actor: "Shift Supervisor", reason: "wrong ticket", eventId: "reopen-1", occurredAt: "2026-09-08T06:05:00Z" })),
      decide(reopened, "discarded", "decision-2", "2026-09-08T06:12:00Z", "Shift Supervisor"),
    ]);
    assert.equal(d104Item(redecided).reopened, undefined);
  });

  it("returns the item to the human-review queue, and a new decision removes it again", () => {
    assert.equal(buildHandoff(decided).requiresHumanReview.length, 0);
    assert.equal(buildHandoff(decided).decidedDuringShiftCount, 1);

    assert.equal(buildHandoff(reopened).requiresHumanReview.length, 1);
    assert.equal(buildHandoff(reopened).requiresHumanReview[0]?.canonicalSubject, "d104");
    assert.equal(buildHandoff(reopened).decidedDuringShiftCount, 0);

    const redecided = foldState(TEST_SHIFT, [
      ...decidedEvents(),
      validateEvent(
        reopenableDecision({ state: decided, subject: "D104", actor: "Shift Supervisor", eventId: "reopen-1", occurredAt: "2026-09-08T06:05:00Z" }),
      ),
      decide(reopened, "discarded", "decision-2", "2026-09-08T06:12:00Z", "Shift Supervisor"),
    ]);
    const item = d104Item(redecided);
    assert.equal(item.status, "decided");
    assert.equal(item.decision?.canonicalValue, "discard", "the newer decision replaces the superseded one");
    assert.equal(buildHandoff(redecided).requiresHumanReview.length, 0);
    assert.equal(buildHandoff(redecided).decidedDuringShiftCount, 1);
    // Both decisions and the reopen all remain on the record.
    assert.equal(redecided.events.length, 5);
    assert.equal(item.contributingEventIds.length, 5);
  });
});

describe("scenario: reopen is refused unless the item is currently decided", () => {
  const openState = foldState(TEST_SHIFT, [
    ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "missed" }),
  ]);
  const conflicted = foldState(TEST_SHIFT, conflictedEvents());

  it("refuses to reopen an open item", () => {
    assert.throws(
      () =>
        reopenableDecision({ state: openState, subject: "freezer inspection", actor: "Shift Supervisor", eventId: "reopen-x", occurredAt: "2026-09-08T06:05:00Z" }),
      (err: unknown) => err instanceof DecisionValidationError && err.code === "item_not_decided" && /not decided/.test(err.message),
    );
  });

  it("refuses to reopen an already-conflicted item", () => {
    assert.throws(
      () =>
        reopenableDecision({ state: conflicted, subject: "D104", actor: "Shift Supervisor", eventId: "reopen-x", occurredAt: "2026-09-08T06:05:00Z" }),
      (err: unknown) => err instanceof DecisionValidationError && err.code === "item_not_decided",
    );
  });

  it("refuses to reopen a subject that has no item", () => {
    assert.throws(
      () =>
        reopenableDecision({ state: conflicted, subject: "pallet 99", actor: "Shift Supervisor", eventId: "reopen-x", occurredAt: "2026-09-08T06:05:00Z" }),
      (err: unknown) => err instanceof DecisionValidationError && err.code === "item_not_found",
    );
  });

  it("refuses a second reopen without a new decision in between", () => {
    const decided = foldState(TEST_SHIFT, decidedEvents());
    const reopened = foldState(TEST_SHIFT, [
      ...decidedEvents(),
      validateEvent(reopenableDecision({ state: decided, subject: "D104", actor: "Shift Supervisor", eventId: "reopen-1", occurredAt: "2026-09-08T06:05:00Z" })),
    ]);
    assert.throws(
      () =>
        reopenableDecision({ state: reopened, subject: "D104", actor: "Shift Supervisor", eventId: "reopen-2", occurredAt: "2026-09-08T06:08:00Z" }),
      (err: unknown) => err instanceof DecisionValidationError && err.code === "item_not_decided",
    );
  });
});

describe("scenario: ordinary late reports never reopen a decision", () => {
  it("a late contradictory claim leaves the item decided", () => {
    const state = foldState(TEST_SHIFT, [
      ...decidedEvents(),
      ev({ occurredAt: "2026-09-08T06:20:00Z", kind: "status_claimed", subject: "D104", description: "late report says salvage", claim: "salvage" }),
    ]);
    assert.equal(d104Item(state).status, "decided");
    assert.equal(buildHandoff(state).requiresHumanReview.length, 0);
  });

  it("a late resolution leaves the item decided and does not resurrect the conflict", () => {
    const state = foldState(TEST_SHIFT, [
      ...decidedEvents(),
      ev({ occurredAt: "2026-09-08T06:21:00Z", kind: "cleared", subject: "D104", description: "no longer an issue" }),
    ]);
    assert.equal(d104Item(state).status, "decided");
  });
});

describe("fold is defensive about a reopen event with nothing to reopen", () => {
  it("a stray reopen on an open item does not manufacture a conflict", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "missed" }),
      validateEvent({ id: "reopen-stray", shiftId: "shift-1", occurredAt: "2026-09-08T06:05:00Z", kind: "decision_reopened", subject: "freezer inspection", description: "stray reopen", source: "human", actor: "Shift Supervisor" }),
    ]);
    const item = state.items.find((i) => i.canonicalSubject === "freezer inspection");
    assert.ok(item);
    assert.equal(item.status, "open");
  });
});
