import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { FileEvidenceStore } from "../store/evidenceStore.ts";
import { DeterministicEventInterpreter, InterpretationError } from "./interpreter.ts";
import { ingestPhotoEvidence, PhotoEvidenceError } from "./ingestPhotoEvidence.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let shiftStore: JsonFileShiftStore;
let evidenceStore: FileEvidenceStore;
let shiftId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "photo-ingest-"));
  shiftStore = new JsonFileShiftStore(join(dir, "shifts.json"));
  evidenceStore = new FileEvidenceStore(join(dir, "evidence"));
  shiftId = shiftStore.createShift("Night Shift").id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Names of files actually written to evidence storage; [] if none were. */
function storedFiles(): string[] {
  const evidenceDir = join(dir, "evidence");
  return existsSync(evidenceDir) ? readdirSync(evidenceDir) : [];
}

function ingest(overrides: Partial<Parameters<typeof ingestPhotoEvidence>[0]> = {}) {
  return ingestPhotoEvidence({
    store: shiftStore,
    evidenceStore,
    shiftId,
    interpreter: new DeterministicEventInterpreter(),
    note: "Aisle 7 is blocked.",
    image: PNG,
    contentType: "image/png",
    fileName: "aisle7.png",
    occurredAt: "2026-09-08T02:11:00Z",
    evidenceId: "ev-1",
    ...overrides,
  });
}

describe("ingestPhotoEvidence", () => {
  it("attaches photo evidence to the event the note interprets to", async () => {
    const event = await ingest();

    assert.equal(event.kind, "problem_reported");
    assert.equal(event.subject, "Aisle 7");
    assert.equal(event.source, "photo-ingest");
    assert.deepEqual(event.evidence, [
      { id: "ev-1", fileName: "aisle7.png", contentType: "image/png", note: "Aisle 7 is blocked." },
    ]);
    // Persisted through the normal store path, so state is derived from it.
    assert.deepEqual(shiftStore.getEvents(shiftId), [event]);
    assert.deepEqual(shiftStore.getShiftState(shiftId)?.items[0]?.status, "open");
  });

  it("stores the image bytes under the evidence id", async () => {
    await ingest();
    assert.deepEqual(evidenceStore.read("ev-1"), PNG);
  });

  it("interprets the note through the same validated pipeline as text reports", async () => {
    // Disposition phrasing reaches the disposition branch, not a photo-specific one.
    const event = await ingest({ note: "Damaged case D104 should go to claims" });
    assert.equal(event.kind, "status_claimed");
    assert.equal(event.claim, "send to claims");
    assert.equal(event.evidence?.length, 1);
  });

  it("refuses unsupported image types without storing anything", async () => {
    await assert.rejects(ingest({ contentType: "application/pdf" }), PhotoEvidenceError);
    assert.deepEqual(shiftStore.getEvents(shiftId), []);
    assert.deepEqual(storedFiles(), []);
  });

  it("refuses an empty image or an empty note", async () => {
    await assert.rejects(ingest({ image: Buffer.alloc(0) }), PhotoEvidenceError);
    await assert.rejects(ingest({ note: "   " }), PhotoEvidenceError);
    assert.deepEqual(shiftStore.getEvents(shiftId), []);
  });

  // The image never bypasses validation: an uninterpretable note fails loudly.
  it("rejects an uninterpretable note and mutates nothing", async () => {
    await assert.rejects(ingest({ note: "the vibes are off today" }), InterpretationError);
    assert.deepEqual(shiftStore.getEvents(shiftId), []);
    assert.equal(evidenceStore.read("ev-1"), undefined);
  });

  it("leaves no orphaned bytes when the shift no longer accepts events", async () => {
    shiftStore.endShift(shiftId);
    await assert.rejects(ingest());
    assert.equal(evidenceStore.read("ev-1"), undefined);
  });
});
