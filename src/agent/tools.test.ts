import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { DeterministicEventInterpreter, ProviderError, type EventInterpreter } from "../ingest/interpreter.ts";
import { validateEvent } from "../domain/validate.ts";
import { createShiftContinuityTools, type HumanDecisionAuthorization, type ReopenAuthorization } from "./tools.ts";

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories = [];
});

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "shift-agent-tools-"));
  temporaryDirectories.push(directory);
  const store = new JsonFileShiftStore(join(directory, "shifts.json"));
  const shift = store.createShift("Night Shift", "2026-09-08T02:00:00Z");
  return { store, shift };
}

function seedConflict(store: JsonFileShiftStore, shiftId: string): void {
  store.appendEvent(validateEvent({
    id: "claim-1",
    shiftId,
    occurredAt: "2026-09-08T05:02:00Z",
    kind: "status_claimed",
    subject: "damaged case D104",
    description: "send to claims",
    claim: "send to claims",
    source: "scanner",
  }));
  store.appendEvent(validateEvent({
    id: "claim-2",
    shiftId,
    occurredAt: "2026-09-08T05:14:00Z",
    kind: "status_claimed",
    subject: "D104",
    description: "discarded",
    claim: "discarded",
    source: "operator",
  }));
}

function authorizedDecision(subject: string, claim: string, actor?: string): HumanDecisionAuthorization {
  return {
    subject,
    canonicalSubject: "d104",
    claim,
    canonicalClaim: claim === "claims" ? "claims" : "discard",
    ...(actor ? { actor } : {}),
  };
}

function authorizedReopen(actor: string, reason?: string): ReopenAuthorization {
  return { subject: "D104", canonicalSubject: "d104", actor, ...(reason ? { reason } : {}) };
}

/** D104 decided "claims" by a named human, on top of the two conflicting claims. */
function seedDecidedDecision(store: JsonFileShiftStore, shiftId: string, actor = "Shift Supervisor"): void {
  store.appendEvent(validateEvent({
    id: "decision-1",
    shiftId,
    occurredAt: "2026-09-08T05:40:00Z",
    kind: "decision_recorded",
    subject: "damaged case D104",
    description: "human decision",
    claim: "send to claims",
    source: "human",
    actor,
  }));
}

describe("ShiftContinuity tools", () => {
  it("reports a routine event through the existing interpreter and deterministic store path", async () => {
    const { store, shift } = makeStore();
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T02:11:00Z",
    });

    const result = await tools.reportEvent.invoke({ report: "Aisle 7 is blocked." });

    assert.equal(result.ok, true);
    assert.equal(result.event.kind, "problem_reported");
    assert.equal(result.item.status, "open");
    assert.equal(store.getEvents(shift.id).length, 1);
    assert.deepEqual(tools.getTrace().map((trace) => [trace.tool, trace.status]), [["report_event", "success"]]);
  });

  it("gets current state and handoff from deterministic projections rather than conversation text", async () => {
    const { store, shift } = makeStore();
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T02:11:00Z",
    });
    await tools.reportEvent.invoke({ report: "Aisle 7 is blocked." });

    const state = await tools.getShiftState.invoke({});
    const handoff = await tools.getHandoff.invoke({});

    assert.equal(state.ok, true);
    assert.equal(state.openItems[0]?.subject, "Aisle 7");
    assert.equal(state.openItems[0]?.status, "open");
    assert.equal(handoff.ok, true);
    assert.equal(handoff.requiresAction[0]?.subject, "Aisle 7");
    assert.deepEqual(handoff.requiresHumanReview, []);
  });

  it("exposes competing claims and refuses an unauthorized autonomous decision", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });

    const state = await tools.getShiftState.invoke({});
    const refusal = await tools.recordHumanDecision.invoke({ subject: "D104", claim: "claims" });

    assert.equal(state.ok, true);
    if (state.ok) {
      assert.equal(state.conflictedItems[0]?.status, "conflicted");
      assert.deepEqual(state.conflictedItems[0]?.claims.map((claim) => claim.canonicalValue), ["claims", "discard"]);
    }
    assert.equal(refusal.ok, false);
    assert.match(refusal.error.message, /explicit human decision/i);
    assert.equal(store.getEvents(shift.id).length, 2);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "conflicted");
  });

  it("records an explicit human choice through the existing decision gate", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T05:40:00Z",
    });

    const result = await tools.recordHumanDecision.invoke(
      { subject: "D104", claim: "claims" },
      { invocationState: { humanDecisionAuthorization: authorizedDecision("D104", "claims") } } as never,
    );

    assert.equal(result.ok, true);
    assert.equal(result.item.status, "decided");
    assert.equal(result.item.decision?.canonicalValue, "claims");
    assert.equal(store.getEvents(shift.id).length, 3);
    assert.equal(tools.getTrace().at(-1)?.tool, "record_human_decision");
  });

  it("returns a tool failure without mutating state when the report provider fails", async () => {
    const { store, shift } = makeStore();
    const failingInterpreter: EventInterpreter = {
      interpret: async () => {
        throw new ProviderError("LLM provider failed: unavailable");
      },
    };
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: failingInterpreter,
    });

    const result = await tools.reportEvent.invoke({ report: "Aisle 7 is blocked." });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /provider failed/i);
    assert.equal(store.getEvents(shift.id).length, 0);
    assert.equal(tools.getTrace()[0]?.status, "error");
  });
});

describe("decision provenance comes from the application context, not the model", () => {
  it("attributes a decision to the actor supplied by the caller", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T05:40:00Z",
    });

    const result = await tools.recordHumanDecision.invoke(
      { subject: "D104", claim: "claims" },
      { invocationState: { humanDecisionAuthorization: authorizedDecision("D104", "claims", "Shift Supervisor") } } as never,
    );

    assert.equal(result.ok, true);
    assert.equal(result.event.actor, "Shift Supervisor");
    assert.equal(result.item.decision?.actor, "Shift Supervisor");
  });

  it("leaves provenance absent when the caller supplies none (no inventing an actor)", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({ store, shiftId: shift.id, interpreter: new DeterministicEventInterpreter() });

    const result = await tools.recordHumanDecision.invoke(
      { subject: "D104", claim: "claims" },
      { invocationState: { humanDecisionAuthorization: authorizedDecision("D104", "claims") } } as never,
    );

    assert.equal(result.ok, true);
    assert.equal(result.event.actor, undefined);
  });
});

describe("reopen_human_decision", () => {
  it("refuses to reopen without explicit human authorization, and mutates nothing", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    seedDecidedDecision(store, shift.id);
    const tools = createShiftContinuityTools({ store, shiftId: shift.id, interpreter: new DeterministicEventInterpreter() });

    const refusal = await tools.reopenHumanDecision.invoke({ subject: "D104" });

    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, "human_authorization_required");
    assert.equal(store.getEvents(shift.id).length, 3, "no event may be appended by a refused reopen");
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "decided");
    assert.equal(tools.getTrace().at(-1)?.tool, "reopen_human_decision");
  });

  it("reopens a decided item when a human explicitly authorized it, keeping the prior decision", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    seedDecidedDecision(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T06:05:00Z",
    });

    const result = await tools.reopenHumanDecision.invoke(
      { subject: "D104" },
      { invocationState: { reopenAuthorization: authorizedReopen("Shift Supervisor", "Claims ticket was created in error") } } as never,
    );

    assert.equal(result.ok, true);
    assert.equal(result.event.kind, "decision_reopened");
    assert.equal(result.event.actor, "Shift Supervisor");
    assert.equal(result.event.note, "Claims ticket was created in error");
    assert.equal(result.item.status, "conflicted");
    assert.equal(result.item.decision?.canonicalValue, "claims", "the superseded decision stays on the item");
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "conflicted");
  });

  it("refuses to reopen an item that is only conflicted, even with authorization", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({ store, shiftId: shift.id, interpreter: new DeterministicEventInterpreter() });

    const result = await tools.reopenHumanDecision.invoke(
      { subject: "D104" },
      { invocationState: { reopenAuthorization: authorizedReopen("Shift Supervisor") } } as never,
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "item_not_decided");
    assert.equal(store.getEvents(shift.id).length, 2);
  });

  it("ignores a reopen authorization for a different subject", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    seedDecidedDecision(store, shift.id);
    const tools = createShiftContinuityTools({ store, shiftId: shift.id, interpreter: new DeterministicEventInterpreter() });

    const result = await tools.reopenHumanDecision.invoke(
      { subject: "pallet 83" },
      { invocationState: { reopenAuthorization: authorizedReopen("Shift Supervisor") } } as never,
    );

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "human_authorization_required");
    assert.equal(store.getEvents(shift.id).length, 3);
  });
});
