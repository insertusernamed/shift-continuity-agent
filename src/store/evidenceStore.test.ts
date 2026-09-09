import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvidenceStore, EvidenceStoreError } from "./evidenceStore.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shift-evidence-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileEvidenceStore", () => {
  it("saves bytes and reads them back unchanged", () => {
    const store = new FileEvidenceStore(dir);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    store.save("ev-1", bytes);
    assert.deepEqual(store.read("ev-1"), bytes);
  });

  it("keeps distinct ids separate", () => {
    const store = new FileEvidenceStore(dir);
    store.save("ev-1", Buffer.from("first"));
    store.save("ev-2", Buffer.from("second"));
    assert.equal(store.read("ev-1")?.toString(), "first");
    assert.equal(store.read("ev-2")?.toString(), "second");
  });

  it("returns undefined for an unknown id instead of throwing", () => {
    const store = new FileEvidenceStore(dir);
    assert.equal(store.read("never-saved"), undefined);
  });

  // Used to clean up bytes when the append that was supposed to claim them
  // fails, so a rejected report never leaves orphaned files behind.
  it("removes stored bytes, and tolerates removing something absent", () => {
    const store = new FileEvidenceStore(dir);
    store.save("ev-1", Buffer.from("x"));
    store.remove("ev-1");
    assert.equal(store.read("ev-1"), undefined);
    store.remove("ev-1");
  });

  it("creates its directory on first save", () => {
    const nested = join(dir, "evidence");
    const store = new FileEvidenceStore(nested);
    store.save("ev-1", Buffer.from("x"));
    assert.deepEqual(readdirSync(nested), ["ev-1"]);
  });

  // The id comes from a URL path segment; it must never escape the store dir.
  it("refuses ids that could escape the store directory", () => {
    const store = new FileEvidenceStore(dir);
    for (const bad of ["../escape", "a/b", "..", "", ".hidden", "a\\b", "space id"]) {
      assert.throws(() => store.save(bad, Buffer.from("x")), EvidenceStoreError, `save should reject ${JSON.stringify(bad)}`);
      assert.equal(store.read(bad), undefined, `read should refuse ${JSON.stringify(bad)}`);
    }
  });
});
