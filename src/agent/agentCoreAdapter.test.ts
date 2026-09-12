import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentCoreRequestSchema,
  createAgentCoreSessionProvider,
  createAgentCoreSessionRegistry,
  invokeAgentCoreShift,
  parseAgentCoreInvocationRequest,
} from "./agentCoreAdapter.ts";
import { DeterministicEventInterpreter } from "../ingest/interpreter.ts";
import { createDemoShift } from "../demo/demo.ts";
import { canonicalClaim } from "../domain/claims.ts";
import { InMemoryShiftStore } from "../store/inMemoryStore.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";

function seededStore(): { store: ShiftStore; shiftId: string } {
  const store = new InMemoryShiftStore((s) => {
    createDemoShift(s);
  });
  const shiftId = store.listShifts()[0]!.id;
  return { store, shiftId };
}

const interpreter = new DeterministicEventInterpreter();

describe("AgentCore request parsing", () => {
  it("accepts the standard AgentCore { prompt } contract", () => {
    const parsed = parseAgentCoreInvocationRequest({ prompt: "Aisle 7 is blocked." });
    assert.equal(parsed.userText, "Aisle 7 is blocked.");
    assert.equal(parsed.shiftId, undefined);
  });

  it("accepts the { shiftId, message } request contract", () => {
    const parsed = parseAgentCoreInvocationRequest({ shiftId: "abc", message: "Aisle 7 is blocked." });
    assert.equal(parsed.userText, "Aisle 7 is blocked.");
    assert.equal(parsed.shiftId, "abc");
  });

  it("message takes precedence over prompt when both are present", () => {
    const parsed = parseAgentCoreInvocationRequest({ prompt: "prompt text", message: "message text" });
    assert.equal(parsed.userText, "message text");
  });

  it("rejects requests with no message and no prompt", () => {
    assert.throws(() => parseAgentCoreInvocationRequest({}), /prompt|message/);
    assert.throws(() => parseAgentCoreInvocationRequest({ prompt: "  " }), /prompt|message/);
  });

  it("the request schema validates the same contract", () => {
    const schema = createAgentCoreRequestSchema();
    assert.equal(schema.safeParse({ prompt: "hi" }).success, true);
    assert.equal(schema.safeParse({ message: "hi", shiftId: "s" }).success, true);
    assert.equal(schema.safeParse({}).success, false);
  });
});

describe("AgentCore session registry", () => {
  it("returns the same seeded session for the same session id", () => {
    const registry = createAgentCoreSessionRegistry(8);
    const a = registry.get("session-1");
    const b = registry.get("session-1");
    assert.equal(a, b);
    assert.equal(a.store.getShift(a.shiftId)?.name, "Night Shift (demo)");
    // Demo scenario present: D104 is conflicted with the two seeded claims.
    const state = a.store.getShiftState(a.shiftId);
    const d104 = state?.items.find((i) => i.canonicalSubject === "d104");
    assert.equal(d104?.status, "conflicted");
    assert.deepEqual(d104?.claims.map((c) => c.canonicalValue).sort(), ["claims", "discard"]);
  });

  it("isolates sessions: each session gets its own store", () => {
    const registry = createAgentCoreSessionRegistry(8);
    const a = registry.get("session-a");
    const b = registry.get("session-b");
    assert.notEqual(a, b);
    assert.notEqual(a.shiftId, b.shiftId);
    a.store.appendEvent({
      id: crypto.randomUUID(),
      shiftId: a.shiftId,
      occurredAt: "2026-09-08T06:00:00Z",
      kind: "problem_reported",
      subject: "aisle 9",
      description: "aisle 9 blocked",
      source: "test",
    });
    assert.equal(a.store.getEvents(a.shiftId).length, 8);
    assert.equal(b.store.getEvents(b.shiftId).length, 7, "session b must not see session a's events");
  });

  it("evicts the oldest session at capacity", () => {
    const registry = createAgentCoreSessionRegistry(2);
    const a = registry.get("a");
    registry.get("b");
    registry.get("c"); // capacity 2 → evicts "a"
    const recreated = registry.get("a");
    assert.notEqual(recreated.store, a.store);
    assert.notEqual(recreated.shiftId, a.shiftId);
  });
});

describe("AgentCore durable session provider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentcore-durable-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const durableEnv = () => ({ SHIFT_STORE: "json", DATA_FILE: join(dir, "shifts.json") });

  it("keeps the ephemeral per-session behavior when no durable store is configured", async () => {
    const provider = createAgentCoreSessionProvider({ env: {} });
    const a = await provider.get("session-a");
    const b = await provider.get("session-b");
    assert.notEqual(a.shiftId, b.shiftId, "sessions must stay isolated by default");
    assert.equal(a.flush, undefined, "the ephemeral store has nothing to flush");
  });

  it("seeds the demo shift exactly once, not once per session", async () => {
    const provider = createAgentCoreSessionProvider({ env: durableEnv() });
    const a = await provider.get("session-a");
    const b = await provider.get("session-b");
    assert.equal(a.shiftId, b.shiftId, "a durable store is shared, not per-session");
    assert.equal(a.store.listShifts().length, 1);
    assert.equal(a.store.getShift(a.shiftId)?.name, "Night Shift (demo)");
  });

  it("persists an appended event so a fresh provider instance still sees it (cold start)", async () => {
    const before = createAgentCoreSessionProvider({ env: durableEnv() });
    const session = await before.get("session-1");
    const eventsBefore = session.store.getEvents(session.shiftId).length;
    const envelope = await invokeAgentCoreShift({
      store: session.store,
      shiftId: session.shiftId,
      userText: "Aisle 9 is blocked.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    await session.flush?.();

    // A brand-new provider over the same file = a new process with no in-memory state.
    const after = createAgentCoreSessionProvider({ env: durableEnv() });
    const reopened = await after.get("session-1");
    assert.equal(reopened.shiftId, session.shiftId, "the same shift must be found again");
    assert.equal(reopened.store.getEvents(reopened.shiftId).length, eventsBefore + 1);
    assert.equal(
      reopened.store.getShiftState(reopened.shiftId)?.items.find((i) => i.canonicalSubject === "aisle 9")?.status,
      "open",
    );
  });

  it("persists a human decision so the folded state survives a fresh provider instance", async () => {
    const before = createAgentCoreSessionProvider({ env: durableEnv() });
    const session = await before.get("session-1");
    const envelope = await invokeAgentCoreShift({
      store: session.store,
      shiftId: session.shiftId,
      userText: "Send D104 to claims.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.item?.status, "decided");
    await session.flush?.();

    const coldStart = await createAgentCoreSessionProvider({ env: durableEnv() }).get("any-session");
    const d104 = coldStart.store
      .getShiftState(coldStart.shiftId)
      ?.items.find((i) => i.canonicalSubject === "d104");
    assert.equal(d104?.status, "decided");
    assert.equal(d104?.decision?.canonicalValue, "claims");
    assert.equal(d104?.claims.length, 2, "both original claims remain in history");
  });

  it("does not persist a failed report", async () => {
    const provider = createAgentCoreSessionProvider({ env: durableEnv() });
    const session = await provider.get("session-1");
    const before = session.store.getEvents(session.shiftId).length;
    const envelope = await invokeAgentCoreShift({
      store: session.store,
      shiftId: session.shiftId,
      userText: "the vibes are off today",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, false);
    await session.flush?.();

    const coldStart = await createAgentCoreSessionProvider({ env: durableEnv() }).get("any");
    assert.equal(coldStart.store.getEvents(coldStart.shiftId).length, before);
  });

  it("surfaces an invalid store configuration instead of silently degrading", () => {
    assert.throws(() => createAgentCoreSessionProvider({ env: { SHIFT_STORE: "postgres" } }), /SHIFT_STORE/);
    assert.throws(() => createAgentCoreSessionProvider({ env: { SHIFT_STORE: "dynamodb" } }), /SHIFT_TABLE_NAME/);
  });
});

describe("AgentCore invocation envelope (deterministic runner, network-free)", () => {
  it("routine report: ok envelope with report_event trace and resulting state", async () => {
    const { store, shiftId } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Aisle 7 is blocked.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.toolTrace[0]?.tool, "report_event");
    assert.equal(envelope.toolTrace[0]?.status, "success");
    assert.equal(envelope.item?.canonicalSubject, "aisle 7");
    assert.equal(envelope.item?.status, "open");
  });

  it("vague decision request: no decision call and conflict remains visible", async () => {
    const { store, shiftId } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Just pick whichever makes sense for D104.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.ok(!envelope.toolTrace.some((t) => t.tool === "record_human_decision"));
    assert.equal(envelope.state?.conflictedItems.some((i) => i.canonicalSubject === "d104"), true);
  });

  it("explicit decision request: gate authorizes, decision recorded, item decided", async () => {
    const { store, shiftId } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Send D104 to claims.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.toolTrace[0]?.tool, "record_human_decision");
    assert.equal(envelope.toolTrace[0]?.status, "success");
    assert.equal(envelope.decision?.canonicalValue, "claims");
    assert.equal(envelope.item?.status, "decided");
    const state = store.getShiftState(shiftId);
    assert.equal(state?.items.find((i) => i.canonicalSubject === "d104")?.status, "decided");
  });

  it("handoff envelope equals the deterministic handoff generator", async () => {
    const { store, shiftId } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "What does the morning shift need to know?",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.toolTrace[0]?.tool, "get_handoff");
    assert.ok(envelope.handoff);
    assert.deepEqual(
      envelope.handoff.requiresHumanReview.map((i) => i.canonicalSubject),
      ["d104"],
    );
    assert.equal(envelope.handoff.requiresHumanReview[0]?.status, "conflicted");
  });

  it("uninterpretable report fails safely with zero mutation", async () => {
    const { store, shiftId } = seededStore();
    const before = store.getEvents(shiftId).length;
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "the vibes are off today",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.toolTrace[0]?.tool, "report_event");
    assert.equal(envelope.toolTrace[0]?.status, "error");
    assert.match(envelope.error ?? "", /could not interpret/);
    assert.equal(store.getEvents(shiftId).length, before, "a failed report must not mutate state");
  });

  it("unknown shift surfaces a controlled error envelope", async () => {
    const { store } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId: "nope",
      userText: "Aisle 7 is blocked.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, false);
    assert.ok(envelope.error);
  });

  it("attributes a remote decision to the actor carried in the invocation request", async () => {
    const { store, shiftId } = seededStore();
    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Send D104 to claims.",
      actor: "Shift Supervisor",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.decision?.actor, "Shift Supervisor");
    const decision = store.getEvents(shiftId).find((e) => e.kind === "decision_recorded");
    assert.equal(decision?.actor, "Shift Supervisor");
    // The event stores the selected claim (canonical "claims"), not the request
    // prose — the remote smoke's readback relies on exactly this contract.
    assert.equal(canonicalClaim(decision?.claim ?? ""), "claims");
  });

  it("reopens a decision remotely when the request names the actor, keeping the prior decision", async () => {
    const { store, shiftId } = seededStore();
    await invokeAgentCoreShift({ store, shiftId, userText: "Send D104 to claims.", actor: "Shift Supervisor", interpreter, mode: "deterministic" });

    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Reopen D104 because the disposal record was wrong",
      actor: "Shift Supervisor",
      interpreter,
      mode: "deterministic",
    });

    assert.equal(envelope.ok, true);
    assert.equal(envelope.toolTrace[0]?.tool, "reopen_human_decision");
    assert.equal(envelope.toolTrace[0]?.status, "success");
    assert.equal(envelope.item?.status, "conflicted");
    assert.equal(envelope.item?.decision?.canonicalValue, "claims");

    const reopened = store.getEvents(shiftId).find((e) => e.kind === "decision_reopened");
    assert.equal(reopened?.actor, "Shift Supervisor");
    assert.equal(reopened?.note, "the disposal record was wrong");
  });

  it("refuses a remote reopen that supplies no actor", async () => {
    const { store, shiftId } = seededStore();
    await invokeAgentCoreShift({ store, shiftId, userText: "Send D104 to claims.", actor: "Shift Supervisor", interpreter, mode: "deterministic" });
    const before = store.getEvents(shiftId).length;

    const envelope = await invokeAgentCoreShift({
      store,
      shiftId,
      userText: "Reopen D104",
      interpreter,
      mode: "deterministic",
    });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.toolTrace[0]?.status, "error");
    assert.match(envelope.error ?? "", /human authorization/i);
    assert.equal(store.getEvents(shiftId).length, before);
    assert.equal(store.getShiftState(shiftId)?.items.find((i) => i.canonicalSubject === "d104")?.status, "decided");
  });
});