import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { buildHandoff } from "../domain/handoff.ts";
import { recordableDecision } from "../domain/decide.ts";
import { validateEvent } from "../domain/validate.ts";
import { createDemoShift } from "./demo.ts";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("seeded demo shift", () => {
  it("produces the expected handoff: freezer action + D104 review", () => {
    dir = mkdtempSync(join(tmpdir(), "demo-"));
    const store = new JsonFileShiftStore(join(dir, "shifts.json"));

    const shift = createDemoShift(store);

    assert.equal(shift.name, "Night Shift (demo)");
    const state = store.getShiftState(shift.id);
    assert.ok(state);
    assert.equal(state.events.length, 7, "all seven demo events are retained");

    const handoff = buildHandoff(state);
    assert.deepEqual(
      handoff.requiresAction.map((i) => i.subject),
      ["freezer inspection"],
    );
    assert.deepEqual(
      handoff.requiresHumanReview.map((i) => i.subject),
      ["damaged case D104"],
    );
    assert.equal(handoff.requiresHumanReview[0]?.claims.length, 2);
    assert.equal(handoff.resolvedDuringShiftCount, 2);
    assert.equal(shift.endedAt, undefined, "demo shift stays open so a human decision can be recorded");
  });

  it("keeps resolved aisle/pallet events in history but out of the handoff", () => {
    dir = mkdtempSync(join(tmpdir(), "demo-"));
    const store = new JsonFileShiftStore(join(dir, "shifts.json"));
    const shift = createDemoShift(store);
    const state = store.getShiftState(shift.id)!;

    const subjects = state.events.map((e) => e.subject.toLowerCase());
    assert.ok(subjects.includes("aisle 7"));
    assert.ok(subjects.includes("pallet 83"));

    const handoff = buildHandoff(state);
    const handoffSubjects = [...handoff.requiresAction, ...handoff.requiresHumanReview].map((i) =>
      i.subject.toLowerCase(),
    );
    assert.ok(!handoffSubjects.includes("aisle 7"));
    assert.ok(!handoffSubjects.includes("pallet 83"));
  });

  it("after recording the human decision, handoff contains only the freezer inspection", () => {
    dir = mkdtempSync(join(tmpdir(), "demo-"));
    const store = new JsonFileShiftStore(join(dir, "shifts.json"));
    const shift = createDemoShift(store);

    const before = buildHandoff(store.getShiftState(shift.id)!);
    assert.equal(before.requiresHumanReview.length, 1, "D104 starts conflicted");

    const decision = recordableDecision({
      state: store.getShiftState(shift.id)!,
      subject: "damaged case D104",
      claim: "send to claims",
      eventId: crypto.randomUUID(),
      occurredAt: "2026-09-08T05:40:00Z",
    });
    store.appendEvent(validateEvent(decision));

    const state = store.getShiftState(shift.id)!;
    const d104 = state.items.find((i) => i.canonicalSubject === "d104");
    assert.equal(d104?.status, "decided");
    assert.equal(d104?.decision?.canonicalValue, "claims");

    const after = buildHandoff(state);
    assert.deepEqual(after.requiresHumanReview, [], "D104 leaves human review");
    assert.deepEqual(after.requiresAction.map((i) => i.subject), ["freezer inspection"]);
    assert.equal(after.decidedDuringShiftCount, 1);
    assert.equal(state.events.length, 8, "nothing removed from history");
  });

  it("rejects a decision that is not one of the conflicting claims", () => {
    dir = mkdtempSync(join(tmpdir(), "demo-"));
    const store = new JsonFileShiftStore(join(dir, "shifts.json"));
    const shift = createDemoShift(store);

    assert.throws(
      () =>
        recordableDecision({
          state: store.getShiftState(shift.id)!,
          subject: "damaged case D104",
          claim: "donate",
          eventId: crypto.randomUUID(),
          occurredAt: "2026-09-08T05:40:00Z",
        }),
      /not one of the conflicting claims/,
    );
  });
});
