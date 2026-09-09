import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Narrow boundary for photo-evidence bytes (AGENTS.md §5). The event log keeps
 * only evidence metadata, so this store owns the bytes and nothing else — a
 * deployed implementation could swap in object storage without touching the
 * domain or HTTP layers.
 */
export interface EvidenceStore {
  save(id: string, bytes: Buffer): void;
  read(id: string): Buffer | undefined;
  /** Idempotent: used to drop bytes whose event could not be appended. */
  remove(id: string): void;
}

/** Ids arrive from request paths, so they must be path-safe by construction. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class EvidenceStoreError extends Error {}

/**
 * Local-filesystem evidence storage for the PoC. One file per evidence id in a
 * single directory. Not shared across processes or hosts — this is submission-
 * prep storage for a single-instance demo, not production media storage.
 */
export class FileEvidenceStore implements EvidenceStore {
  constructor(private readonly directory: string) {}

  save(id: string, bytes: Buffer): void {
    if (!SAFE_ID.test(id)) throw new EvidenceStoreError(`unsafe evidence id: ${JSON.stringify(id)}`);
    mkdirSync(this.directory, { recursive: true });
    // Atomic write (temp + rename), matching the event store's crash-safety.
    const target = join(this.directory, id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }

  read(id: string): Buffer | undefined {
    if (!SAFE_ID.test(id)) return undefined;
    const target = join(this.directory, id);
    return existsSync(target) ? readFileSync(target) : undefined;
  }

  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    rmSync(join(this.directory, id), { force: true });
  }
}
