import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { FileEvidenceStore } from "../store/evidenceStore.ts";
import { DeterministicEventInterpreter } from "../ingest/interpreter.ts";
import { recordableDecision } from "../domain/decide.ts";
import { createDemoShift } from "./demo.ts";
import { appendDemoPhotoReport, demoScenarioProblems } from "./demoScenario.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let store: JsonFileShiftStore;
let evidenceStore: FileEvidenceStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "demo-scenario-"));
  store = new JsonFileShiftStore(join(dir, "shifts.json"));
  evidenceStore = new FileEvidenceStore(join(dir, "evidence"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seed exactly what the recording starts from. */
async function seedRecordingScenario() {
  const shift = createDemoShift(store);
  await appendDemoPhotoReport({
    store,
    evidenceStore,
    shiftId: shift.id,
    interpreter: new DeterministicEventInterpreter(),
    image: PNG,
    evidenceId: "demo-photo",
  });
  return shift;
}

function stateOf(shiftId: string) {
  const state = store.getShiftState(shiftId);
  assert.ok(state, "shift state must exist");
  return state;
}

describe("frozen demo scenario", () => {
  it("is ready for recording after the core beats plus the photo report", async () => {
    const shift = await seedRecordingScenario();
    assert.deepEqual(demoScenarioProblems(stateOf(shift.id)), []);
  });

  it("stores the photo evidence through the real ingestion path", async () => {
    const shift = await seedRecordingScenario();
    const state = stateOf(shift.id);
    const photoEvent = state.events.find((event) => (event.evidence ?? []).length > 0);

    assert.equal(photoEvent?.evidence?.[0]?.fileName, "aisle12-blocked.png");
    assert.equal(photoEvent?.evidence?.[0]?.note, "Aisle 12 is blocked.");
    assert.deepEqual(evidenceStore.read(photoEvent!.evidence![0]!.id), PNG);
    // …and its subject resolves later, so the handoff stays clean.
    assert.equal(state.items.find((item) => item.canonicalSubject === "aisle 12")?.status, "resolved");
  });

  it("reports the core scenario as unready before any photo is attached", () => {
    const shift = createDemoShift(store);
    const problems = demoScenarioProblems(stateOf(shift.id));
    assert.deepEqual(problems, [
      "aisle 12 should be resolved before the recording starts",
      "expected exactly 1 photo evidence attachment, found 0",
    ]);
  });

  it("catches a decision recorded before the recording starts", async () => {
    const shift = await seedRecordingScenario();
    const state = stateOf(shift.id);
    store.appendEvent(
      recordableDecision({
        state,
        subject: "damaged case D104",
        claim: "claims",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      }),
    );

    const problems = demoScenarioProblems(stateOf(shift.id));
    assert.ok(problems.some((p) => p.includes("no item may start decided")), problems.join("; "));
    assert.ok(problems.some((p) => p.includes("D104 should be conflicted")), problems.join("; "));
  });

  it("catches extra open work that would clutter the final handoff", async () => {
    const shift = await seedRecordingScenario();
    store.appendEvent({
      id: crypto.randomUUID(),
      shiftId: shift.id,
      occurredAt: "2026-09-08T05:30:00Z",
      kind: "problem_reported",
      subject: "dock door 4",
      description: "Dock door 4 stuck",
      source: "radio",
    });

    const problems = demoScenarioProblems(stateOf(shift.id));
    assert.deepEqual(problems, ["open work should be freezer inspection only, found dock door 4, freezer inspection"]);
  });

  // A repeated report must not quietly settle the contradiction: the conflict
  // survives until a human decides, which is the whole point being recorded.
  it("stays ready when a redundant report repeats an existing claim", async () => {
    const shift = await seedRecordingScenario();
    store.appendEvent({
      id: crypto.randomUUID(),
      shiftId: shift.id,
      occurredAt: "2026-09-08T05:40:00Z",
      kind: "status_claimed",
      subject: "damaged case D104",
      description: "Confirmed send to claims",
      claim: "send to claims",
      source: "operator",
    });

    const d104 = stateOf(shift.id).items.find((item) => item.canonicalSubject === "d104");
    assert.equal(d104?.status, "conflicted");
    assert.deepEqual([...new Set((d104?.claims ?? []).map((c) => c.canonicalValue))].sort(), ["claims", "discard"]);
    assert.deepEqual(demoScenarioProblems(stateOf(shift.id)), []);
  });
});
