import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicEventInterpreter, ProviderError, type EventInterpreter } from "./interpreter.ts";
import { startServer } from "../http/server.ts";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";

describe("DeterministicEventInterpreter", () => {
  const interpreter = new DeterministicEventInterpreter();

  it("parses the Phase 5 example sentence with causal context", async () => {
    const event = await interpreter.interpret({ text: "Pallet 83 couldn't go out because aisle 7 is blocked." });
    assert.equal(event.kind, "problem_reported");
    assert.equal(event.subject, "Pallet 83");
    assert.equal(event.blockedBy, "aisle 7");
  });

  it("parses a cleared report", async () => {
    const event = await interpreter.interpret({ text: "aisle 7 is cleared" });
    assert.equal(event.kind, "cleared");
    assert.equal(event.subject, "aisle 7");
  });

  it("parses a completion report", async () => {
    const event = await interpreter.interpret({ text: "pallet 83 completed" });
    assert.equal(event.kind, "work_completed");
    assert.equal(event.subject, "pallet 83");
  });

  it("parses a disposition claim", async () => {
    const event = await interpreter.interpret({ text: "damaged case D104 should go to claims" });
    assert.equal(event.kind, "status_claimed");
    assert.equal(event.subject, "damaged case D104");
    assert.equal(event.claim, "send to claims");
  });

  it("refuses to guess on unparseable input", async () => {
    await assert.rejects(
      () => interpreter.interpret({ text: "the vibes are off today" }),
      (err: Error) => err.message.includes("could not interpret"),
    );
  });
});

describe("NL ingestion endpoint", () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let dir: string | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function makeApp(interpreter?: EventInterpreter) {
    dir = mkdtempSync(join(tmpdir(), "ingest-"));
    const store = new JsonFileShiftStore(join(dir, "shifts.json"));
    server = await startServer({ store, port: 0, interpreter });
    const { body: shift } = await api("POST", "/api/shifts", { name: "Night Shift" });
    return { store, shiftId: shift.id as string };
  }

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(server!.url + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  }

  it("persists a natural-language report through the deterministic interpreter", async () => {
    const { shiftId } = await makeApp(); // default wiring: deterministic interpreter, no LLM
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, {
      text: "Pallet 83 couldn't go out because aisle 7 is blocked.",
      occurredAt: "2026-09-08T02:37:00Z",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, "problem_reported");
    assert.equal(res.body.blockedBy, "aisle 7");
  });

  it("validates interpreter output against the event schema before persisting", async () => {
    // Simulated misbehaving LLM: confidently returns invalid structured output.
    const badInterpreter: EventInterpreter = {
      // Deliberately malformed: TS types can't express hostile LLM output.
      interpret: (() => ({ kind: "everything_is_fine", subject: "", description: "" })) as unknown as EventInterpreter["interpret"],
    };
    const { shiftId, store } = await makeApp(badInterpreter);
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, { text: "anything" });
    assert.equal(res.status, 400);
    assert.equal(store.getEvents(shiftId).length, 0, "invalid output must not mutate state");
  });

  it("rejects empty text", async () => {
    const { shiftId } = await makeApp();
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, { text: "   " });
    assert.equal(res.status, 400);
  });

  it("model result flows through the same deterministic engine path as manual entry", async () => {
    const scripted: EventInterpreter = {
      interpret: async () => ({ kind: "status_claimed", subject: "D104", description: "damaged, to claims", source: "llm", claim: "send to claims" }),
    };
    const { shiftId, store } = await makeApp(scripted);
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, { text: "case D104 is damaged, send it to claims", occurredAt: "2026-09-08T05:02:00Z" });
    assert.equal(res.status, 201);
    assert.equal(res.body.source, "llm");
    // Same store + same fold as manual entry: one item, claim attached.
    const state = store.getShiftState(shiftId);
    assert.equal(state?.items.length, 1);
    assert.equal(state?.items[0]?.claims[0]?.value, "send to claims");
    assert.equal(state?.items[0]?.canonicalSubject, "d104");
  });

  it("provider failure returns a controlled 502 and mutates nothing", async () => {
    const failing: EventInterpreter = {
      interpret: async () => {
        throw new ProviderError("LLM provider failed: HTTP 503");
      },
    };
    const { shiftId, store } = await makeApp(failing);
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, { text: "aisle 7 blocked" });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /provider/i);
    assert.equal(store.getEvents(shiftId).length, 0, "no event may be written on provider failure");
  });

  it("schema-invalid model output returns 400 and mutates nothing", async () => {
    const hostile: EventInterpreter = {
      interpret: async () => ({ kind: "everything_is_fine", subject: "", description: "" }) as unknown as EventInterpreter extends { interpret(r: never): Promise<infer T> } ? T : never,
    };
    const { shiftId, store } = await makeApp(hostile);
    const res = await api("POST", `/api/shifts/${shiftId}/events/nl`, { text: "anything" });
    assert.equal(res.status, 400);
    assert.equal(store.getEvents(shiftId).length, 0);
  });
});
