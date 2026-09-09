import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { DeterministicEventInterpreter, ProviderError, type EventInterpreter } from "../ingest/interpreter.ts";
import { validateEvent } from "../domain/validate.ts";
import { createShiftContinuityTools, type HumanDecisionAuthorization } from "./tools.ts";

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

function authorizedDecision(subject: string, claim: string): HumanDecisionAuthorization {
  return {
    subject,
    canonicalSubject: "d104",
    claim,
    canonicalClaim: claim === "claims" ? "claims" : "discard",
  };
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
