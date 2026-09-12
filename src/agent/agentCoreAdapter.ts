import { z } from "zod";
import { createDemoShift } from "../demo/demo.ts";
import { seedCoreDemoShiftInto } from "../demo/demoScenario.ts";
import { InMemoryShiftStore } from "../store/inMemoryStore.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import {
  ensureSeededShift,
  hydrateShiftStore,
  type AsyncShiftStore,
} from "../store/dynamoDbStore.ts";
import { createAsyncShiftStore, resolveShiftStoreConfig } from "../store/shiftStoreFactory.ts";
import { DeterministicEventInterpreter, type EventInterpreter } from "../ingest/interpreter.ts";
import {
  createShiftContinuityAgent,
  type AgentMode,
  type BedrockAgentConfig,
  type AgentRunner,
} from "./shiftContinuityAgent.ts";
import type { AgentItemView, HandoffToolResult, ShiftStateToolResult, ToolTrace } from "./tools.ts";

/**
 * Request contract for the AgentCore runtime entrypoint. Both shapes are
 * accepted so the standard `agentcore invoke "text"` (which sends
 * `{ prompt }`) and the task's conceptual `{ shiftId, message }` contract
 * work unchanged. `message` wins when both are present.
 */
export interface AgentCoreRequest {
  prompt?: string;
  message?: string;
  shiftId?: string;
  /** Who the request acts on behalf of; required for attributed human actions. */
  actor?: string;
}

export interface AgentCoreInvocationEnvelope {
  /** Textual agent response, displayed by `agentcore invoke`. */
  result: string;
  ok: boolean;
  /** Tool trace from the invocation (empty when nothing was called). */
  toolTrace: ToolTrace[];
  /** Deterministic state when the last tool exposed it (state/report/decision). */
  state?: ShiftStateToolResult;
  /** Deterministic handoff when get_handoff was the last tool. */
  handoff?: HandoffToolResult;
  /** Resulting item when report_event or record_human_decision ran. */
  item?: AgentItemView;
  /** Recorded decision value when a human decision was recorded. */
  decision?: AgentItemView["decision"];
  /** Controlled failure detail when ok is false. */
  error?: string;
}

/**
 * Runtime request schema. The shape is intentionally permissive (both
 * contract styles are accepted) but at least one non-empty text field is
 * required, so the runtime rejects an empty invocation with a controlled 400
 * before any model call happens.
 */
export function createAgentCoreRequestSchema() {
  return z
    .object({
      prompt: z.string().optional(),
      message: z.string().optional(),
      shiftId: z.string().optional(),
      actor: z.string().optional(),
    })
    .refine((data) => (data.message ?? data.prompt ?? "").trim().length > 0, {
      message: "a non-empty 'prompt' or 'message' is required",
    });
}

/**
 * Deterministic pre-validation of an incoming invocation. Returns the text
 * that will drive the agent and an optional shift selector. Throws on a
 * request with no usable text; the runtime maps that to a 400 before the
 * model is ever called.
 */
export function parseAgentCoreInvocationRequest(raw: unknown): { userText: string; shiftId?: string; actor?: string } {
  const schema = createAgentCoreRequestSchema();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid AgentCore request: ${parsed.error.issues[0]?.message ?? "unexpected shape"}`);
  }
  const userText = (parsed.data.message ?? parsed.data.prompt ?? "").trim();
  if (!userText) {
    throw new Error("AgentCore request must include a non-empty 'prompt' or 'message'");
  }
  const actor = parsed.data.actor?.trim();
  return { userText, shiftId: parsed.data.shiftId, ...(actor ? { actor } : {}) };
}

/** One AgentCore context: a store plus the shift it operates on. */
export interface AgentCoreSession {
  store: ShiftStore;
  shiftId: string;
  /**
   * Persist events appended during this invocation. Absent for the ephemeral
   * per-session store, which has nothing to persist. The runtime must await it
   * before replying.
   */
  flush?(): Promise<void>;
}

/**
 * Per-session store registry for the AgentCore entrypoint. Each runtime
 * session gets its own isolated, demo-seeded in-process store so conversations
 * cannot leak state between sessions. Bounded (LRU) because a local dev server
 * may serve many sessions; on AgentCore Runtime each microVM serves one
 * session, so this holds one entry there. State is ephemeral by design
 * (see README persistence limitation).
 */
export function createAgentCoreSessionRegistry(maxSessions = 32): { get(sessionId: string): AgentCoreSession } {
  const sessions = new Map<string, AgentCoreSession>();

  function get(sessionId: string): AgentCoreSession {
    const existing = sessions.get(sessionId);
    if (existing) {
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    if (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const store = new InMemoryShiftStore((s) => {
      createDemoShift(s);
    });
    const session: AgentCoreSession = { store, shiftId: store.listShifts()[0]!.id };
    sessions.set(sessionId, session);
    return session;
  }

  return { get };
}

/**
 * How a runtime invocation obtains its store. Two strategies, chosen by
 * configuration rather than scattered environment checks:
 *
 * - `memory` (default) — the existing per-session, per-process store. Sessions
 *   stay isolated, and state is lost on cold start. Unchanged behavior.
 * - `json` / `dynamodb` — one shared durable store. The demo shift is seeded
 *   once (the first time the table/file is empty), then every invocation reads
 *   its events, runs the same synchronous domain code, and flushes whatever it
 *   appended. This is what makes state survive a cold start.
 */
export interface AgentCoreSessionProvider {
  get(sessionId: string): Promise<AgentCoreSession>;
}

export interface AgentCoreSessionProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable durable store; production builds one from env. */
  durableStore?: AsyncShiftStore;
}

export function createAgentCoreSessionProvider(
  options: AgentCoreSessionProviderOptions = {},
): AgentCoreSessionProvider {
  const env = options.env ?? process.env;
  const config = resolveShiftStoreConfig(env);

  if (config.kind === "memory") {
    const registry = createAgentCoreSessionRegistry(MAX_AGENTCORE_SESSIONS);
    return { async get(sessionId) {
      return registry.get(sessionId);
    } };
  }

  // One `ensure` per process: concurrent invocations share the same promise, so
  // a cold start cannot decide twice to seed a second demo shift.
  const durable = options.durableStore ?? createAsyncShiftStore(config);
  const shiftId: Promise<string> = ensureSeededShift(durable, async () => {
    await seedCoreDemoShiftInto(durable);
  }).then((shift) => shift.id);

  return {
    async get() {
      const id = await shiftId;
      const hydrated = await hydrateShiftStore(durable, id);
      return { store: hydrated.store, shiftId: id, flush: () => hydrated.flush() };
    },
  };
}

const MAX_AGENTCORE_SESSIONS = 32;

export interface InvokeAgentCoreShiftOptions {
  store: ShiftStore;
  shiftId: string;
  userText: string;
  /** Display identity for any human action this invocation performs. */
  actor?: string;
  interpreter?: EventInterpreter;
  mode?: AgentMode;
  bedrock?: BedrockAgentConfig;
  /** Test-only: inject a runner (production AgentCore mode uses the Strands runner). */
  runner?: AgentRunner;
}

/**
 * Drive one AgentCore invocation through the existing ShiftContinuityAgent.
 * This is the single entrypoint reused by the deployed runtime: the same
 * deterministic tools, domain fold, decision gate, and request routing as the
 * local app — AgentCore only hosts the process. Construction performs no
 * network I/O; the runner decides whether a model is involved.
 */
export async function invokeAgentCoreShift(
  options: InvokeAgentCoreShiftOptions,
): Promise<AgentCoreInvocationEnvelope> {
  const agent = createShiftContinuityAgent({
    store: options.store,
    shiftId: options.shiftId,
    interpreter: options.interpreter ?? new DeterministicEventInterpreter(),
    mode: options.mode ?? "bedrock",
    bedrock: options.bedrock,
    runner: options.runner,
  });
  const result = await agent.invoke(options.userText, options.actor ? { actor: options.actor } : undefined);
  const envelope: AgentCoreInvocationEnvelope = {
    result: result.response,
    ok: result.ok,
    toolTrace: result.toolTrace,
  };
  if (result.state) envelope.state = result.state;
  if (result.handoff) envelope.handoff = result.handoff;
  if (result.item) envelope.item = result.item;
  if (result.decision) envelope.decision = result.decision;
  if (result.error) envelope.error = result.error;
  return envelope;
}