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
import { seedRemoteSmokeShift, smokePreconditionProblems } from "../demo/smokeScenario.ts";
import { canonicalClaim } from "../domain/claims.ts";
import { InMemoryShiftStore } from "../store/inMemoryStore.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { AsyncShiftStore } from "../store/dynamoDbStore.ts";

function seededStore(): { store: ShiftStore; shiftId: string } {
  const store = new InMemoryShiftStore((s) => {
    createDemoShift(s);
  });
  const shiftId = store.listShifts()[0]!.id;
  return { store, shiftId };
}

/**
 * Uncached durable store for tests: unlike the JSON adapter, every call sees
 * the latest state, which is how the real DynamoDB store behaves and what makes
 * shift targeting observable.
 */
class FakeDurableStore implements AsyncShiftStore {
  private readonly inner = new InMemoryShiftStore();
  async createShift(name: string, startedAt?: string) { return this.inner.createShift(name, startedAt); }
  async getShift(id: string) { return this.inner.getShift(id); }
  async listShifts() { return this.inner.listShifts(); }
  async endShift(id: string, endedAt?: string) { return this.inner.endShift(id, endedAt); }
  async appendEvent(event: Parameters<ShiftStore["appendEvent"]>[0]) { this.inner.appendEvent(event); }
  async getEvents(shiftId: string) { return this.inner.getEvents(shiftId); }
  async getShiftState(shiftId: string) { return this.inner.getShiftState(shiftId); }
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

  it("serves the session's own shift when no selector is supplied", async () => {
    const provider = createAgentCoreSessionProvider({ env: {} });
    const session = await provider.get("session-a");
    const again = await provider.get("session-a", session.shiftId);
    assert.equal(again.shiftId, session.shiftId, "the session's own shift is a valid selector");
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

  it("hydrates an explicitly requested shift instead of the default seeded shift", async () => {
    const durable = new FakeDurableStore();
    const provider = createAgentCoreSessionProvider({ env: durableEnv(), durableStore: durable });
    const fallback = await provider.get("session-1");
    assert.equal(fallback.store.getShift(fallback.shiftId)?.name, "Night Shift (demo)");

    const smoke = await seedRemoteSmokeShift(durable, "run-1", "2026-09-11T07:00:00Z");
    const targeted = await provider.get("session-1", smoke.id);

    assert.equal(targeted.shiftId, smoke.id);
    assert.equal(targeted.store.getShift(targeted.shiftId)?.name, "remote-smoke-run-1");
    assert.notEqual(targeted.shiftId, fallback.shiftId, "the request selector must win over the default");
  });

  it("a targeted write lands on the requested shift and never on the default shift", async () => {
    const durable = new FakeDurableStore();
    const provider = createAgentCoreSessionProvider({ env: durableEnv(), durableStore: durable });
    const fallback = await provider.get("session-1");
    const smoke = await seedRemoteSmokeShift(durable, "run-1", "2026-09-11T07:00:00Z");

    const targeted = await provider.get("session-1", smoke.id);
    const envelope = await invokeAgentCoreShift({
      store: targeted.store,
      shiftId: targeted.shiftId,
      userText: "Aisle 9 is blocked.",
      interpreter,
      mode: "deterministic",
    });
    assert.equal(envelope.ok, true);
    await targeted.flush?.();

    const inSmoke = (state: Awaited<ReturnType<FakeDurableStore["getShiftState"]>>) =>
      state?.items.some((item) => item.canonicalSubject === "aisle 9") ?? false;
    assert.equal(inSmoke(await durable.getShiftState(smoke.id)), true);
    assert.equal(
      inSmoke(await durable.getShiftState(fallback.shiftId)),
      false,
      "the default shift must not receive another shift's events",
    );
  });

  it("a prior run's decided shift cannot contaminate a later run's seeded shift", async () => {
    const durable = new FakeDurableStore();
    const provider = createAgentCoreSessionProvider({ env: durableEnv(), durableStore: durable });
    await provider.get("session-1");

    // Run 1 decides D104 and then finishes.
    const first = await seedRemoteSmokeShift(durable, "run-1", "2026-09-11T07:00:00Z");
    const runOne = await provider.get("session-1", first.id);
    await invokeAgentCoreShift({
      store: runOne.store,
      shiftId: runOne.shiftId,
      userText: "Send D104 to claims.",
      actor: "Shift Supervisor",
      interpreter,
      mode: "deterministic",
    });
    await runOne.flush?.();
    assert.equal(
      (await durable.getShiftState(first.id))?.items.find((i) => i.canonicalSubject === "d104")?.status,
      "decided",
    );

    // Run 2 seeds its own shift and sees the exact initial preconditions.
    const second = await seedRemoteSmokeShift(durable, "run-2", "2026-09-11T07:01:00Z");
    const runTwo = await provider.get("session-1", second.id);
    const runTwoState = await durable.getShiftState(runTwo.shiftId);
    assert.ok(runTwoState);
    assert.deepEqual(smokePreconditionProblems(runTwoState), []);

    // Run 1's history is still intact and attributed.
    const firstDecision = (await durable.getEvents(first.id)).find((e) => e.kind === "decision_recorded");
    assert.equal(firstDecision?.actor, "Shift Supervisor");
  });

  it("rejects an unknown requested shift instead of falling back to the default", async () => {
    const durable = new FakeDurableStore();
    const provider = createAgentCoreSessionProvider({ env: durableEnv(), durableStore: durable });
    await provider.get("session-1");

    await assert.rejects(() => provider.get("session-1", "no-such-shift"), /unknown shift/i);
  });

  it("refuses a shift selector in ephemeral mode rather than silently ignoring it", async () => {
    const provider = createAgentCoreSessionProvider({ env: {} });
    await assert.rejects(() => provider.get("session-a", "any-shift"), /durable/i);
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