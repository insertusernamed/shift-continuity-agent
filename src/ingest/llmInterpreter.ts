import type { EventKind } from "../domain/types.ts";
import {
  InterpretationError,
  ProviderError,
  type EventInterpreter,
  type InterpretedEvent,
  type InterpretationRequest,
  type LlmClient,
} from "./interpreter.ts";
import { OpenAiCompatibleClient } from "./openaiClient.ts";
import { DeterministicEventInterpreter } from "./interpreter.ts";

/**
 * Real LLM interpreter (milestone Part 3). The model's ONLY job is turning
 * one messy human sentence into a candidate structured event; it never sees
 * history and never decides current state. Everything it returns passes
 * through strict local schema validation before the deterministic engine
 * touches state (AGENTS.md §6):
 *
 *   human text → LLM extraction → schema validation → domain engine
 *
 * Identity fields (id, shiftId, occurredAt) are structurally forbidden in
 * the model output and stripped outright, so the model cannot forge them.
 */
export class LLMEventInterpreter implements EventInterpreter {
  constructor(private readonly client: LlmClient) {}

  async interpret(request: InterpretationRequest): Promise<InterpretedEvent> {
    let completion: string;
    try {
      const result = await this.client.complete(buildPrompt(request.text));
      completion = result.text;
    } catch (err) {
      // Provider/network problems are controlled failures (§6: fail safely).
      throw new ProviderError(`LLM provider failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (typeof completion !== "string" || completion.trim().length === 0) {
      throw new InterpretationError("LLM returned an empty completion");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(completion);
    } catch {
      throw new InterpretationError("LLM output is not valid JSON");
    }
    return validateModelOutput(parsed);
  }
}

/** System rules the model must follow; also mirrored by the local validator. */
function buildPrompt(reportText: string): string {
  return [
    "Convert the following workplace shift report into exactly one operational event.",
    'Reply with ONLY a JSON object, no prose, no code fences, shaped as:',
    '{ "kind": "problem_reported" | "cleared" | "work_completed" | "status_claimed",',
    '  "subject": string,          // the entity, e.g. "aisle 7", "case D104"',
    '  "description": string,      // the report text, lightly cleaned',
    '  "claim"?: string,           // REQUIRED for status_claimed: the asserted value',
    '  "blockedBy"?: string        // subject that causes this problem, if stated',
    "}",
    "Rules: kind/subject/description are always required; no id, timestamps, or shift id;",
    "if the text is not a clear operational report, reply with the single word UNKNOWN.",
    "",
    "Report: " + reportText,
  ].join("\n");
}

const MODEL_KINDS: ReadonlySet<string> = new Set(["problem_reported", "cleared", "work_completed", "status_claimed"]);

/**
 * Schema gate for model output. Returns only the whitelisted fields with
 * whitelisted types; anything else is a controlled failure. Note the model
 * is NOT allowed to emit source: the adapter stamps it, deterministically.
 */
function validateModelOutput(parsed: unknown): InterpretedEvent {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InterpretationError("LLM output must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;

  if (typeof o.kind !== "string" || !MODEL_KINDS.has(o.kind)) {
    throw new InterpretationError(`LLM output has unknown or missing "kind"`);
  }
  if (!isCleanString(o.subject) || !isCleanString(o.description)) {
    throw new InterpretationError('LLM output requires non-empty "subject" and "description" strings');
  }
  if (o.kind === "status_claimed") {
    if (!isCleanString(o.claim)) {
      throw new InterpretationError('LLM output for status_claimed requires a non-empty "claim"');
    }
  } else if ("claim" in o) {
    // A claim is only meaningful on a claimed status; anything else is
    // out of schema and fails loudly rather than being dropped (§6).
    throw new InterpretationError('LLM output "claim" is only valid for status_claimed');
  }
  // Present-but-malformed optional fields fail loudly: silently dropping a
  // field the model emitted would be guessing (AGENTS.md §6).
  if ("blockedBy" in o && !isCleanString(o.blockedBy)) {
    throw new InterpretationError('LLM output "blockedBy" must be a non-empty string when present');
  }

  const event: InterpretedEvent = {
    kind: o.kind as EventKind,
    subject: o.subject,
    description: o.description,
    source: "llm",
  };
  if (isCleanString(o.claim)) event.claim = o.claim;
  if (isCleanString(o.blockedBy)) event.blockedBy = o.blockedBy;
  return event;
}

function isCleanString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export interface LlmEnvConfig {
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
}

/**
 * Chooses the interpreter from environment config. All three variables are
 * required together — a half-configured adapter must never exist, so the
 * deterministic interpreter remains the offline default (AGENTS.md §6).
 */
export function createInterpreterFromEnv(env: LlmEnvConfig): EventInterpreter {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = env;
  if (LLM_BASE_URL && LLM_API_KEY && LLM_MODEL) {
    return new LLMEventInterpreter(
      new OpenAiCompatibleClient({ baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL }),
    );
  }
  return new DeterministicEventInterpreter();
}
