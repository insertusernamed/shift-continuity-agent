import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LLMEventInterpreter, createInterpreterFromEnv } from "./llmInterpreter.ts";
import {
  ProviderError,
  type LlmClient,
  type LlmCompletion,
  type InterpretedEvent,
} from "./interpreter.ts";
import { InterpretationError } from "./interpreter.ts";

/** Deterministic fake: records the prompt, replays a canned completion. */
function fakeClient(reply: string | Error): LlmClient & { lastPrompt: string | undefined } {
  const fake = {
    lastPrompt: undefined as string | undefined,
    complete(prompt: string): Promise<LlmCompletion> {
      fake.lastPrompt = prompt;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ text: reply });
    },
  };
  return fake;
}

function validReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "problem_reported",
    subject: "Pallet 83",
    description: "Pallet 83 couldn't go out because aisle 7 was blocked",
    blockedBy: "aisle 7",
    ...overrides,
  });
}

describe("LLMEventInterpreter: happy path through the same contract", () => {
  it("returns a structured event with the same shape as the deterministic interpreter", async () => {
    const client = fakeClient(validReply());
    const interpreter = new LLMEventInterpreter(client);
    const event = await interpreter.interpret({ text: "pallet 83 can't move, aisle 7 blocked" });
    assert.equal(event.kind, "problem_reported");
    assert.equal(event.subject, "Pallet 83");
    assert.equal(event.blockedBy, "aisle 7");
    assert.match(client.lastPrompt ?? "", /pallet 83/, "the report text must be sent to the model");
  });

  it("rejects extra fields the schema does not allow (no identity/timestamp forging)", async () => {
    const client = fakeClient(validReply({ id: "forged", shiftId: "forged", occurredAt: "2026-01-01T00:00:00Z", source: "attacker" }));
    const interpreter = new LLMEventInterpreter(client);
    const event = await interpreter.interpret({ text: "pallet 83 blocked" });
    assert.equal((event as Record<string, unknown>).id, undefined, "interpreter output must not carry identity fields");
    assert.equal((event as Record<string, unknown>).occurredAt, undefined);
    assert.equal((event as Record<string, unknown>).shiftId, undefined);
    assert.equal(event.source, "llm", "source is set by the adapter, not the model");
  });
});

describe("LLMEventInterpreter: schema validation gates state", () => {
  const cases: Array<[string, string | Record<string, unknown>]> = [
    ["invalid JSON", "{not json"],
    ["non-object JSON", '"just a string"'],
    ["unknown kind", JSON.stringify({ kind: "everything_is_fine", subject: "x", description: "x" })],
    ["missing subject", JSON.stringify({ kind: "cleared", description: "x" })],
    ["empty subject", JSON.stringify({ kind: "cleared", subject: "   ", description: "x" })],
    ["missing description", JSON.stringify({ kind: "cleared", subject: "aisle 7" })],
    ["claim required for status_claimed", JSON.stringify({ kind: "status_claimed", subject: "D104", description: "x" })],
    ["non-string blockedBy", JSON.stringify({ kind: "problem_reported", subject: "x", description: "x", blockedBy: 7 })],
    ["claim on a kind that takes no claim", JSON.stringify({ kind: "cleared", subject: "aisle 7", description: "x", claim: "whatever" })],
    ["non-string claim", JSON.stringify({ kind: "status_claimed", subject: "x", description: "x", claim: 9 })],
    ["wrong-typed kind", JSON.stringify({ kind: 3, subject: "x", description: "x" })],
  ];
  for (const [name, reply] of cases) {
    it(`fails in a controlled way on ${name}`, async () => {
      const interpreter = new LLMEventInterpreter(fakeClient(typeof reply === "string" ? reply : JSON.stringify(reply)));
      await assert.rejects(
        () => interpreter.interpret({ text: "anything" }),
        (err: Error) => err instanceof InterpretationError && !(err instanceof ProviderError),
      );
    });
  }
});

describe("LLMEventInterpreter: provider failure", () => {
  it("maps a provider network failure to a controlled ProviderError", async () => {
    const interpreter = new LLMEventInterpreter(fakeClient(new Error("ECONNREFUSED")));
    await assert.rejects(
      () => interpreter.interpret({ text: "aisle 7 blocked" }),
      (err: Error) => err instanceof ProviderError,
    );
  });

  it("treats an empty completion as a controlled failure, not an event", async () => {
    const interpreter = new LLMEventInterpreter(fakeClient("   "));
    await assert.rejects(() => interpreter.interpret({ text: "aisle 7 blocked" }), InterpretationError);
  });
});

describe("createInterpreterFromEnv: credential-driven selection", () => {
  it("returns the deterministic interpreter when no LLM config is present", () => {
    const deterministic = createInterpreterFromEnv({});
    assert.equal(deterministic.constructor.name, "DeterministicEventInterpreter");
  });

  it("returns the LLM interpreter when config is present", () => {
    const llm = createInterpreterFromEnv({ LLM_BASE_URL: "http://localhost:9", LLM_API_KEY: "k", LLM_MODEL: "m" });
    assert.equal(llm.constructor.name, "LLMEventInterpreter");
  });

  it("is incomplete config -> deterministic fallback, never a half-wired adapter", () => {
    for (const env of [
      { LLM_BASE_URL: "http://localhost:9" },
      { LLM_API_KEY: "k" },
      { LLM_MODEL: "m" },
      { LLM_BASE_URL: "http://localhost:9", LLM_API_KEY: "k" },
    ]) {
      const chosen = createInterpreterFromEnv(env);
      assert.equal(chosen.constructor.name, "DeterministicEventInterpreter");
    }
  });
});
