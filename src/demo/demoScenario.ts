import type { OperationalEvent, Shift, ShiftState } from "../domain/types.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import { InMemoryShiftStore } from "../store/inMemoryStore.ts";
import type { AsyncShiftStore } from "../store/dynamoDbStore.ts";
import type { EvidenceStore } from "../store/evidenceStore.ts";
import type { EventInterpreter } from "../ingest/interpreter.ts";
import { ingestPhotoEvidence } from "../ingest/ingestPhotoEvidence.ts";
import { createDemoShift } from "./demo.ts";

/**
 * The frozen recording scenario.
 *
 * `createDemoShift` seeds the core beats; the photo beat below adds one more,
 * because a one-click demo cannot show an image report appearing. Together they
 * produce the state a recording starts from:
 *
 *   aisle 7        blocked at 02:11 → cleared at 03:04        → resolved
 *   pallet 83      blocked by aisle 7 → completed at 03:21     → resolved
 *   aisle 12       photo report at 04:02 → cleared at 04:35    → resolved
 *   freezer insp.  missed at 04:46                             → open
 *   damaged case D104  "send to claims" vs "discarded"         → conflicted (undecided)
 *
 * `demoScenarioProblems` is the machine check for exactly that: the UI freeze is
 * worthless if the demo state can drift silently, so the reset command refuses
 * to report success unless this returns no problems.
 */
export const DEMO_PHOTO_REPORT = {
  note: "Aisle 12 is blocked.",
  fileName: "aisle12-blocked.png",
  contentType: "image/png",
  occurredAt: "2026-09-08T04:02:00Z",
} as const;

export const DEMO_PHOTO_CLEARED: Omit<OperationalEvent, "id" | "shiftId"> = {
  occurredAt: "2026-09-08T04:35:00Z",
  kind: "cleared",
  subject: "aisle 12",
  description: "Aisle 12 cleared",
  source: "radio",
};

/**
 * Append the photo-evidence beat: a report carrying an image, then its cleanup.
 * Uses the same ingestion path as the UI, so the seeded evidence is real.
 */
export async function appendDemoPhotoReport(input: {
  store: ShiftStore;
  evidenceStore: EvidenceStore;
  shiftId: string;
  interpreter: EventInterpreter;
  image: Buffer;
  evidenceId?: string;
}): Promise<OperationalEvent> {
  const event = await ingestPhotoEvidence({
    store: input.store,
    evidenceStore: input.evidenceStore,
    shiftId: input.shiftId,
    interpreter: input.interpreter,
    note: DEMO_PHOTO_REPORT.note,
    image: input.image,
    contentType: DEMO_PHOTO_REPORT.contentType,
    fileName: DEMO_PHOTO_REPORT.fileName,
    occurredAt: DEMO_PHOTO_REPORT.occurredAt,
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
  });
  input.store.appendEvent({ ...DEMO_PHOTO_CLEARED, id: crypto.randomUUID(), shiftId: input.shiftId });
  return event;
}

/**
 * Seed the core demo beats into an async (durable) store.
 *
 * The seven events come from the one canonical scenario via `createDemoShift`, so
 * there is no second copy of the demo data. The photo-evidence beat is omitted
 * deliberately: its bytes live on the local filesystem, which the durable runtime
 * does not have (see the README persistence section).
 *
 * `name`/`startedAt` are overridable so an isolated caller (the remote smoke)
 * can seed a distinctly named shift from the same event definitions instead of
 * copying them.
 */
export async function seedCoreDemoShiftInto(
  store: AsyncShiftStore,
  options: { name?: string; startedAt?: string } = {},
): Promise<Shift> {
  const template = new InMemoryShiftStore((s) => {
    createDemoShift(s);
  });
  const source = template.listShifts()[0]!;
  const shift = await store.createShift(options.name ?? source.name, options.startedAt ?? source.startedAt);
  for (const event of template.getEvents(source.id)) {
    await store.appendEvent({ ...event, shiftId: shift.id });
  }
  return shift;
}

/** Human-readable reasons the state is not the frozen recording scenario. */
export function demoScenarioProblems(state: ShiftState): string[] {
  const problems: string[] = [];
  const statusOf = (canonicalSubject: string) =>
    state.items.find((item) => item.canonicalSubject === canonicalSubject);

  for (const subject of ["aisle 7", "pallet 83", "aisle 12"]) {
    if (statusOf(subject)?.status !== "resolved") {
      problems.push(`${subject} should be resolved before the recording starts`);
    }
  }
  if (statusOf("freezer inspection")?.status !== "open") {
    problems.push("freezer inspection should be the one open item");
  }

  const d104 = statusOf("d104");
  if (d104?.status !== "conflicted") {
    problems.push("damaged case D104 should be conflicted and undecided");
  }
  // Canonical values (see claims.ts): "send to claims" → claims, "discarded" → discard.
  const claims = new Set((d104?.claims ?? []).map((claim) => claim.canonicalValue));
  if (claims.size !== 2 || !claims.has("claims") || !claims.has("discard")) {
    problems.push(`D104 should carry the two conflicting claims claims/discard, found ${[...claims].join(" / ") || "(none)"}`);
  }

  if (state.items.some((item) => item.status === "decided")) {
    problems.push("no item may start decided — the human decision is recorded on camera");
  }

  const evidence = state.events.flatMap((event) => event.evidence ?? []);
  if (evidence.length !== 1) {
    problems.push(`expected exactly 1 photo evidence attachment, found ${evidence.length}`);
  }

  const actionSubjects = state.items
    .filter((item) => item.status === "open")
    .map((item) => item.canonicalSubject)
    .sort();
  if (actionSubjects.join(",") !== "freezer inspection") {
    problems.push(`open work should be freezer inspection only, found ${actionSubjects.join(", ") || "(none)"}`);
  }

  return problems;
}
