import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { buildHandoff } from "../domain/handoff.ts";
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
    assert.ok(shift.endedAt, "demo shift ends with a ready handoff");
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
});
