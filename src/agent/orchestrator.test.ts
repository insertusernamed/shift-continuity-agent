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

/**
 * Fake model that records the system prompt handed to the provider on every
 * stream call, then drives a real tool through the loop like
 * ToolUseRecordingModel. Proves the routing-directive middleware injects only
 * into the first model call of an invocation.
 */
class DirectiveCapturingModel extends Model {
  systemPrompts: string[] = [];
  private calls = 0;

  updateConfig(): void {}

  getConfig(): { modelId?: string } {
    return { modelId: "directive-capturing-model" };
  }

  async *stream(_messages: unknown, options?: { systemPrompt?: unknown }): AsyncGenerator<ModelStreamEvent> {
    this.calls += 1;
    this.systemPrompts.push(typeof options?.systemPrompt === "string" ? options.systemPrompt : JSON.stringify(options?.systemPrompt));
    if (this.calls === 1) {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "report_event", toolUseId: "call_1" },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: JSON.stringify({ report: "the vibes are off today" }) },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: "done" } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

/**
 * Fake model that drives a real tool through the Strands loop: the first
 * stream call emits a tool-use block, the second (after the tool result) a
 * plain text end-turn. Emits the full delta→stop sequence because the SDK
 * aggregates blocks only at block-stop.
 */
class ToolUseRecordingModel extends Model {
  private calls = 0;
  private readonly toolName: string;
  private readonly toolInput: Record<string, unknown>;
  private readonly textAfterTool: string;

  constructor(options: { toolName: string; toolInput: Record<string, unknown>; textAfterTool?: string }) {
    super();
    this.toolName = options.toolName;
    this.toolInput = options.toolInput;
    this.textAfterTool = options.textAfterTool ?? "done";
  }

  updateConfig(): void {}

  getConfig(): { modelId?: string } {
    return { modelId: "fake-tool-use-model" };
  }

  async *stream(): AsyncGenerator<ModelStreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: this.toolName, toolUseId: "call_1" },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: JSON.stringify(this.toolInput) },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
      return;
    }
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield { type: "modelContentBlockDeltaEvent", delta: { type: "textDelta", text: this.textAfterTool } };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  }
}

describe("ShiftContinuityAgent", () => {
  it("registers the typed application tools and system prompt on the real Strands loop", async () => {
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
      "reopen_human_decision",
    ]);
    assert.equal(model.systemPrompt, SHIFT_CONTINUITY_SYSTEM_PROMPT);
    assert.deepEqual(runner.toolNames, [
      "report_event",
      "get_shift_state",
      "get_handoff",
      "record_human_decision",
      "reopen_human_decision",
    ]);
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

    // Semantic behavior, not exact prose: no decision tool call, the item
    // stays conflicted, and the response says human input is required.
    assert.deepEqual(calls, ["get_shift_state"]);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "conflicted");
    assert.match(result.response, /(conflict|human review|human decision|decision is required|human input)/i);
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

  it("routes a report through the same tool under either the bedrock or bedrock-openai provider", async () => {
    for (const provider of ["bedrock", "bedrock-openai"] as const) {
      const { store, shift } = makeStore();
      const tools = createShiftContinuityTools({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
        now: () => "2026-09-08T02:11:00Z",
      });
      const model = new ToolUseRecordingModel({ toolName: "report_event", toolInput: { report: "Aisle 7 is blocked." } });
      const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider, modelId: "global.openai.gpt-5.6-luna" } });

      const result = await runner.invoke("Aisle 7 is blocked.", {});

      assert.equal(result.response, "done");
      assert.equal(store.getEvents(shift.id).length, 1);
      const item = store.getShiftState(shift.id)?.items[0];
      assert.equal(item?.status, "open");
      assert.equal(tools.getTrace()[0]?.tool, "report_event");
      assert.equal(tools.getTrace()[0]?.status, "success");
    }
  });

  it("allows record_human_decision when the deterministic layer pre-authorized it", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
      now: () => "2026-09-08T05:40:00Z",
    });
    const model = new ToolUseRecordingModel({
      toolName: "record_human_decision",
      toolInput: { subject: "D104", claim: "claims" },
    });
    const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock", modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0" } });

    const result = await runner.invoke("Send D104 to claims.", {
      routingIntent: "decision",
      humanDecisionAuthorization: {
        subject: "D104",
        canonicalSubject: "d104",
        claim: "claims",
        canonicalClaim: "claims",
      },
    });

    assert.equal(result.response, "done");
    const trace = tools.getTrace()[0];
    assert.equal(trace?.tool, "record_human_decision");
    assert.equal(trace?.status, "success");
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "decided");
  });

  it("routes an uninterpretable report through report_event with zero mutation", async () => {
    const { store, shift } = makeStore();
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });
    const model = new ToolUseRecordingModel({
      toolName: "report_event",
      toolInput: { report: "the vibes are off today" },
      textAfterTool: "report rejected",
    });
    const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock" } });

    const result = await runner.invoke("the vibes are off today", { routingIntent: "report" });

    assert.equal(result.response, "report rejected");
    const trace = tools.getTrace()[0];
    assert.equal(trace?.tool, "report_event");
    assert.equal(trace?.status, "error");
    assert.match(trace?.summary ?? "", /could not interpret/i);
    assert.equal(store.getEvents(shift.id).length, 0);
  });

  it("injects the deterministic routing directive into the first model call only", async () => {
    const { store, shift } = makeStore();
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });
    const model = new DirectiveCapturingModel();
    const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock" } });

    const result = await runner.invoke("the vibes are off today", { routingIntent: "report" });

    assert.equal(result.response, "done");
    assert.equal(model.systemPrompts.length, 2);
    // First model call carries the base prompt plus the routing directive.
    assert.match(model.systemPrompts[0]!, /shift assistant/i);
    assert.match(model.systemPrompts[0]!, /Deterministic routing/);
    assert.match(model.systemPrompts[0]!, /report_event/);
    // Later loop calls (summarizing the tool result) do not re-route.
    assert.doesNotMatch(model.systemPrompts[1]!, /Deterministic routing/);
  });

  it("keeps the human-decision authorization gate model-independent under bedrock-openai", async () => {
    const { store, shift } = makeStore();
    seedConflict(store, shift.id);
    const tools = createShiftContinuityTools({
      store,
      shiftId: shift.id,
      interpreter: new DeterministicEventInterpreter(),
    });
    // The model attempts an autonomous decision with no human authorization
    // in invocationState; the tool itself must refuse regardless of provider.
    const model = new ToolUseRecordingModel({
      toolName: "record_human_decision",
      toolInput: { subject: "D104", claim: "claims" },
    });
    const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock-openai", modelId: "global.openai.gpt-5.6-luna" } });

    const result = await runner.invoke("Handle D104 however you think is best.", {});

    assert.equal(result.response, "done");
    const trace = tools.getTrace()[0];
    assert.equal(trace?.tool, "record_human_decision");
    assert.equal(trace?.status, "error");
    assert.match(trace?.summary ?? "", /explicit human decision/i);
    assert.equal(store.getEvents(shift.id).length, 2);
    assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "conflicted");
  });

  describe("reopen authorization is model-independent", () => {
    function seedDecidedDecision(store: JsonFileShiftStore, shiftId: string): void {
      store.appendEvent(validateEvent({
        id: "decision-1",
        shiftId,
        occurredAt: "2026-09-08T05:40:00Z",
        kind: "decision_recorded",
        subject: "damaged case D104",
        description: "human decision",
        claim: "send to claims",
        source: "human",
        actor: "Shift Supervisor",
      }));
    }

    it("refuses a reopen the model attempts with no human authorization", async () => {
      const { store, shift } = makeStore();
      seedConflict(store, shift.id);
      seedDecidedDecision(store, shift.id);
      const tools = createShiftContinuityTools({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
      });
      const model = new ToolUseRecordingModel({ toolName: "reopen_human_decision", toolInput: { subject: "D104" } });
      const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock" } });

      await runner.invoke("Was D104 decided correctly?", { routingIntent: "reopen" });

      const trace = tools.getTrace()[0];
      assert.equal(trace?.tool, "reopen_human_decision");
      assert.equal(trace?.status, "error");
      assert.match(trace?.summary ?? "", /human authorization/i);
      assert.equal(store.getEvents(shift.id).length, 3, "a refused reopen appends nothing");
      assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "decided");
    });

    it("allows a pre-authorized reopen and keeps the superseded decision on the record", async () => {
      const { store, shift } = makeStore();
      seedConflict(store, shift.id);
      seedDecidedDecision(store, shift.id);
      const tools = createShiftContinuityTools({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
        now: () => "2026-09-08T06:05:00Z",
      });
      const model = new ToolUseRecordingModel({ toolName: "reopen_human_decision", toolInput: { subject: "D104" } });
      const runner = new StrandsAgentRunner({ tools, model, bedrock: { provider: "bedrock" } });

      await runner.invoke("Reopen D104 because the disposal record was wrong", {
        routingIntent: "reopen",
        reopenAuthorization: {
          subject: "D104",
          canonicalSubject: "d104",
          actor: "Shift Supervisor",
          reason: "the disposal record was wrong",
        },
      });

      const trace = tools.getTrace()[0];
      assert.equal(trace?.status, "success");
      assert.equal(store.getEvents(shift.id).length, 4);
      const state = store.getShiftState(shift.id);
      assert.equal(state?.items[0]?.status, "conflicted");
      assert.equal(state?.items[0]?.decision?.canonicalValue, "claims", "the prior decision stays visible");
    });
  });

  describe("actor provenance comes from the application context", () => {
    function seedDecidedDecision(store: JsonFileShiftStore, shiftId: string): void {
      store.appendEvent(validateEvent({
        id: "decision-1",
        shiftId,
        occurredAt: "2026-09-08T05:40:00Z",
        kind: "decision_recorded",
        subject: "damaged case D104",
        description: "human decision",
        claim: "send to claims",
        source: "human",
        actor: "Shift Supervisor",
      }));
    }

    it("attributes an agent-routed decision to the actor the application supplied", async () => {
      const { store, shift } = makeStore();
      seedConflict(store, shift.id);
      const agent = createShiftContinuityAgent({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
        now: () => "2026-09-08T05:40:00Z",
      });

      const result = await agent.invoke("Send D104 to claims.", { actor: "Shift Supervisor" });

      assert.equal(result.ok, true);
      assert.equal(result.decision?.actor, "Shift Supervisor");
      assert.equal(store.getEvents(shift.id).at(-1)?.actor, "Shift Supervisor");
    });

    it("reopens through the agent, recording the actor and reason on the event", async () => {
      const { store, shift } = makeStore();
      seedConflict(store, shift.id);
      seedDecidedDecision(store, shift.id);
      const agent = createShiftContinuityAgent({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
        now: () => "2026-09-08T06:05:00Z",
      });

      const result = await agent.invoke("Reopen D104 because the disposal record was wrong", { actor: "Shift Supervisor" });

      assert.equal(result.ok, true);
      assert.equal(result.item?.status, "conflicted");
      const event = store.getEvents(shift.id).at(-1);
      assert.equal(event?.kind, "decision_reopened");
      assert.equal(event?.actor, "Shift Supervisor");
      assert.equal(event?.note, "the disposal record was wrong");
    });

    it("does not authorize a reopen when the application supplies no actor", async () => {
      const { store, shift } = makeStore();
      seedConflict(store, shift.id);
      seedDecidedDecision(store, shift.id);
      const agent = createShiftContinuityAgent({
        store,
        shiftId: shift.id,
        interpreter: new DeterministicEventInterpreter(),
      });

      const result = await agent.invoke("Reopen D104");

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /human authorization/i);
      assert.equal(store.getEvents(shift.id).length, 3);
      assert.equal(store.getShiftState(shift.id)?.items[0]?.status, "decided");
    });
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
