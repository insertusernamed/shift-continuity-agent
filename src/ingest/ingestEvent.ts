import type { OperationalEvent } from "../domain/types.ts";
import { validateEvent } from "../domain/validate.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { EventInterpreter } from "./interpreter.ts";

export interface IngestNaturalLanguageReportInput {
  store: ShiftStore;
  shiftId: string;
  interpreter: EventInterpreter;
  text: string;
  occurredAt?: string;
  now?: () => string;
}

/**
 * One ingestion path for HTTP and Strands. The interpreter proposes only the
 * event fields it owns; identity, time, validation, persistence, and state
 * derivation stay deterministic here and below.
 */
export async function ingestNaturalLanguageReport(
  input: IngestNaturalLanguageReportInput,
): Promise<OperationalEvent> {
  const interpreted = await input.interpreter.interpret({ text: input.text });
  const candidate: OperationalEvent = {
    ...interpreted,
    id: crypto.randomUUID(),
    shiftId: input.shiftId,
    occurredAt: input.occurredAt ?? (input.now?.() ?? new Date().toISOString()),
  };
  const event = validateEvent(candidate);
  input.store.appendEvent(event);
  return event;
}
