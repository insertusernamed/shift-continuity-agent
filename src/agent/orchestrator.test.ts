import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Model, type ModelStreamEvent } from "@strands-agents/sdk";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { DeterministicEventInterpreter, ProviderError, type EventInterpreter } from "../ingest/interpreter.ts";
import { validateEvent } from "../domain/validate.ts";
import {
  createShiftContinuityAgent,
  StrandsAgentRunner,
  SHIFT_CONTINUITY_SYSTEM_PROMPT,
  type AgentRunner,
} from "./shiftContinuityAgent.ts";
import { createShiftContinuityTools } from "./tools.ts";

let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories = [];
});

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "shift-agent-orchestration-"));
  temporaryDirectories.push(directory);
  const store = new JsonFileShiftStore(join(directory, "shifts.json"));
  const shift = store.createShift("Night Shift", "2026-09-08T02:00:00Z");
  return { store, shift };
}

function seedConflict(store: JsonFileShiftStore, shiftId: string): void {
  for (const [id, subject, claim, occurredAt] of [
    ["claim-1", "damaged case D104", "send to claims", "2026-09-08T05:02:00Z"],
    ["claim-2", "D104", "discarded", "2026-09-08T05:14:00Z"],
  ] as const) {
    store.appendEvent(validateEvent({
      id,
      shiftId,
      occurredAt,
      kind: "status_claimed",
      subject,
      description: claim,
      claim,
      source: "test",
    }));
  }
}

/**
 * Minimal fake Strands model: captures the tool specs and system prompt the
 * real agent loop hands to the provider, then emits a plain text response.
 * Proves the Strands wiring without any network access. Emits the full
 * delta→stop sequence because the SDK aggregates blocks only at block-stop.
 */
class RecordingModel extends Model {
  toolSpecs?: Array<{ name: string }>;
  systemPrompt?: unknown;
  private config: { modelId?: string } = { modelId: "test-model" };

  updateConfig(modelConfig: Partial<{ modelId?: string }>): void {
    this.config = { ...this.config, ...modelConfig };
  }

  getConfig(): { modelId?: string } {
    return this.config;
  }

  async *stream(_messages: unknown, options?: { systemPrompt?: unknown; toolSpecs?: Array<{ name: string }> }): AsyncGenerator<ModelStreamEvent> {
    this.toolSpecs = options?.toolSpecs;
    this.systemPrompt = options?.systemPrompt;
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "done" } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

describe("ShiftContinuityAgent", () => {
  it("registers the four typed application tools and system prompt on the real Strands loop", async () => {
    const { store, shift } = makeStore();
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });
    const model = new RecordingModel();
    const runner = new StrandsAgentRunner({ tools, model, bedrock: { region: "ca-central-1", modelId: "ca.amazon.nova-lite-v1:0" } });

    const result = await runner.invoke("status please", {});

    assert.equal(result.response, "done");
    assert.deepEqual(model.toolSpecs?.map((spec) => spec.name), [
      "report_event",
      "get_shift_state",
      "get_handoff",
      "record_human_decision",
    ]);
    assert.equal(model.systemPrompt, SHIFT_CONTINUITY_SYSTEM_PROMPT);
    assert.deepEqual(runner.toolNames, ["report_event", "get_shift_state", "get_handoff", "record_human_decision"]);
  });

  it("routes a routine report through report_event and exposes deterministic state", async () => {
    const { store, shift } = makeStore();
    const calls: string[] = [];
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T02:11:00Z",
      onToolCall: (name) => calls.push(name),
    });

    const result = await agent.invoke("Aisle 7 is blocked.");

    assert.equal(result.ok, true);
    assert.equal(result.response, "Accepted: Aisle 7 is open.");
    assert.deepEqual(calls, ["report_event"]);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "open");
  });

  it("records a resolution through report_event so the item leaves the handoff", async () => {
    const { store, shift } = makeStore();
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T03:04:00Z",
    });
    await agent.invoke("Aisle 7 is blocked.");

    const result = await agent.invoke("Aisle 7 is clear now.");

    assert.equal(result.ok, true);
    assert.match(result.response, /Accepted: Aisle 7 is resolved\./);
    const item = store.getShiftState(shift.id)?.items[0];
    assert.equal(item?.status, "resolved");
  });

  it("answers state questions from the deterministic handoff, not the runner's wording", async () => {
    const { store, shift } = makeStore();
    store.appendEvent(validateEvent({
      id: "freezer-1",
      shiftId: shift.id,
      occurredAt: "2026-09-08T04:46:00Z",
      kind: "problem_reported",
      subject: "freezer inspection",
      description: "missed",
      source: "test",
    }));
    const silentRunner: AgentRunner = {
      invoke: async () => ({ response: "Nothing remains, all clear." }),
    };
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      runner: silentRunner,
    });

    // The silent runner never calls a tool, so the agent must surface that it
    // has no deterministic answer rather than parroting the runner's claim.
    const result = await agent.invoke("What's left for morning shift?");

    assert.equal(result.response, "Nothing remains, all clear.");
    assert.equal(result.handoff, undefined);

    // With the tool actually invoked, the handoff contents are authoritative.
    const routedAgent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });
    const routed = await routedAgent.invoke("What's left for morning shift?");
    assert.equal(routed.handoff?.requiresAction[0]?.subject, "freezer inspection");
    assert.match(routed.response, /freezer inspection/i);
  });

  it("does not call record_human_decision when the user asks the agent to choose", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const calls: string[] = [];
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      onToolCall: (name) => calls.push(name),
    });

    const result = await agent.invoke("Just pick whichever one makes sense for D104.");

    assert.deepEqual(calls, ["get_shift_state"]);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "conflicted");
    assert.match(result.response, /human decision is required/i);
    assert.match(result.response, /send to claims vs discarded/i);
  });

  it("records an explicit human choice through the validated decision tool", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const calls: string[] = [];
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T05:40:00Z",
      onToolCall: (name) => calls.push(name),
    });

    const result = await agent.invoke("Send D104 to claims.");

    assert.deepEqual(calls, ["record_human_decision"]);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "decided");
    assert.equal(result.decision?.canonicalValue, "claims");
    assert.match(result.response, /Recorded human decision/i);
  });

  it("does not claim success when report_event fails", async () => {
    const { store, shift } = makeStore();
    const failingInterpreter: EventInterpreter = {
      interpret: async () => {
        throw new ProviderError("LLM provider failed: unavailable");
      },
    };
    const agent = createShiftContinuityAgent({
      store,
      shiftId: shift.id,
      interpreter: failingInterpreter,
    });

    const result = await agent.invoke("Aisle 7 is blocked.");

    assert.equal(result.ok, false);
    assert.match(result.response, /Tool failed/i);
    assert.equal(store.getEvents(shift.id).length, 0);
  });
});
