import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncShiftStore } from "../store/dynamoDbStore.ts";
import { createAsyncShiftStore, resolveShiftStoreConfig } from "../store/shiftStoreFactory.ts";
import {
  remoteSmokeShiftName,
  seedRemoteSmokeShift,
  smokePreconditionProblems,
} from "./smokeScenario.ts";

/**
 * The remote smoke must be isolated per run when DynamoDB is durable. These
 * tests are network-free: they exercise the same durable contract the deployed
 * runtime uses, backed by the local JSON store.
 */
describe("remote smoke isolation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "remote-smoke-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const durable = (name: string): AsyncShiftStore =>
    createAsyncShiftStore(resolveShiftStoreConfig({ SHIFT_STORE: "json", DATA_FILE: join(dir, `${name}.json`) }));

  it("derives a distinct, identifiable shift name per run id", () => {
    assert.equal(remoteSmokeShiftName("abc123"), "remote-smoke-abc123");
    assert.notEqual(remoteSmokeShiftName("run-1"), remoteSmokeShiftName("run-2"));
  });

  it("seeds the canonical scenario so the exact preconditions hold", async () => {
    const store = durable("preconditions");
    const shift = await seedRemoteSmokeShift(store, "run-1", "2026-09-11T07:00:00Z");

    const state = await store.getShiftState(shift.id);
    assert.ok(state);
    assert.deepEqual(smokePreconditionProblems(state), []);
    assert.equal(shift.name, "remote-smoke-run-1");
  });

  it("gives each run its own shift id, so runs cannot collide", async () => {
    const store = durable("distinct");
    const first = await seedRemoteSmokeShift(store, "run-1", "2026-09-11T07:00:00Z");
    const second = await seedRemoteSmokeShift(store, "run-2", "2026-09-11T07:01:00Z");

    assert.notEqual(first.id, second.id);
    assert.equal((await store.listShifts()).length, 2);
  });

  it("a completed earlier run cannot contaminate a later run's initial state", async () => {
    const store = durable("contamination");
    const first = await seedRemoteSmokeShift(store, "run-1", "2026-09-11T07:00:00Z");

    // Run 1 does what the remote smoke does: reports, resolves and decides.
    await store.appendEvent({
      id: crypto.randomUUID(),
      shiftId: first.id,
      occurredAt: "2026-09-11T07:10:00Z",
      kind: "decision_recorded",
      subject: "damaged case D104",
      description: "decided claims",
      source: "test",
      claim: "send to claims",
      actor: "Shift Supervisor",
    });

    const second = await seedRemoteSmokeShift(store, "run-2", "2026-09-11T07:02:00Z");
    const secondState = await store.getShiftState(second.id);
    assert.ok(secondState);
    assert.deepEqual(smokePreconditionProblems(secondState), []);

    // And run 1's history is untouched by the second seed.
    const firstState = await store.getShiftState(first.id);
    assert.equal(firstState?.items.find((i) => i.canonicalSubject === "d104")?.status, "decided");
    assert.equal(firstState?.items.find((i) => i.canonicalSubject === "freezer inspection")?.status, "open");
  });

  it("flags an already-decided D104 as a setup problem instead of a downstream failure", async () => {
    const store = durable("decided");
    const shift = await seedRemoteSmokeShift(store, "run-1", "2026-09-11T07:00:00Z");
    await store.appendEvent({
      id: crypto.randomUUID(),
      shiftId: shift.id,
      occurredAt: "2026-09-11T07:10:00Z",
      kind: "decision_recorded",
      subject: "damaged case D104",
      description: "decided claims",
      source: "test",
      claim: "send to claims",
    });

    const problems = smokePreconditionProblems((await store.getShiftState(shift.id))!);
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => /D104/.test(problem)), JSON.stringify(problems));
    assert.ok(problems.some((problem) => /undecided/.test(problem)), JSON.stringify(problems));
  });

  it("flags a state that is missing the conflict entirely", async () => {
    const store = durable("missing");
    await seedRemoteSmokeShift(store, "run-1", "2026-09-11T07:00:00Z");
    const shift = (await store.listShifts())[0]!;

    const problems = smokePreconditionProblems({
      shift,
      events: [],
      items: [],
    });
    assert.ok(problems.some((p) => /freezer inspection/.test(p)));
    assert.ok(problems.some((p) => /D104/.test(p)));
  });
});
