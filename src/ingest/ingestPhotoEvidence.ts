import type { OperationalEvent } from "../domain/types.ts";
import { validateEvent } from "../domain/validate.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { EvidenceStore } from "../store/evidenceStore.ts";
import type { EventInterpreter } from "./interpreter.ts";

export interface IngestPhotoEvidenceInput {
  store: ShiftStore;
  evidenceStore: EvidenceStore;
  shiftId: string;
  interpreter: EventInterpreter;
  /** Short human note; this is what gets interpreted into the event. */
  note: string;
  image: Buffer;
  contentType: string;
  fileName: string;
  occurredAt?: string;
  now?: () => string;
  /** Injectable for tests; generated in production. */
  evidenceId?: string;
}

/** Image types the demo accepts. Anything else is refused, not sniffed. */
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Photo evidence ingestion (submission-prep milestone). One path, same shape as
 * the text pipeline:
 *
 *   image bytes + note → interpretation → schema validation → append-only event
 *   → deterministic fold
 *
 * The image is only ever *evidence metadata*: it is never interpreted by the
 * model and never reaches the fold. The note is interpreted exactly like a
 * text report, so image reports cannot bypass validation. Bytes are written
 * only after interpretation and validation succeed, and are removed again if
 * the event cannot be appended — a rejected report leaves nothing behind.
 */
export async function ingestPhotoEvidence(input: IngestPhotoEvidenceInput): Promise<OperationalEvent> {
  const note = input.note.trim();
  if (!note) {
    throw new PhotoEvidenceError("a photo report needs a short note describing what it shows");
  }
  if (input.image.length === 0) {
    throw new PhotoEvidenceError("photo has no image data");
  }
  if (!ALLOWED_IMAGE_TYPES.has(input.contentType)) {
    throw new PhotoEvidenceError(
      `unsupported photo type "${input.contentType}" (use PNG, JPEG, WebP, or GIF)`,
    );
  }

  // Interpretation and validation come first: a note we cannot understand must
  // fail before any bytes are written, so nothing is stored for a rejected report.
  const interpreted = await input.interpreter.interpret({ text: note });

  const evidenceId = input.evidenceId ?? crypto.randomUUID();
  const candidate: OperationalEvent = {
    ...interpreted,
    id: crypto.randomUUID(),
    shiftId: input.shiftId,
    occurredAt: input.occurredAt ?? (input.now?.() ?? new Date().toISOString()),
    source: "photo-ingest",
    evidence: [
      {
        id: evidenceId,
        fileName: input.fileName.trim() || "photo",
        contentType: input.contentType,
        note,
      },
    ],
  };
  const event = validateEvent(candidate);

  input.evidenceStore.save(evidenceId, input.image);
  try {
    input.store.appendEvent(event);
  } catch (err) {
    input.evidenceStore.remove(evidenceId);
    throw err;
  }
  return event;
}

/** Malformed photo input (missing note, no bytes, unsupported type). */
export class PhotoEvidenceError extends Error {}
