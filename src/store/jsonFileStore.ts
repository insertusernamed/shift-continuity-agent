import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationalEvent, Shift, ShiftState } from "../domain/types.ts";
import { validateEvent, normalizeIso } from "../domain/validate.ts";
import { foldState } from "../domain/state.ts";

/**
 * Narrow persistence interface so domain logic and higher layers never
 * depend on how/where data is stored (AGENTS.md §5). A future SQLite
 * implementation would replace this without touching domain code.
 */
export interface ShiftStore {
  createShift(name: string, startedAt?: string): Shift;
  getShift(id: string): Shift | undefined;
  listShifts(): Shift[];
  endShift(id: string, endedAt?: string): Shift;
  appendEvent(event: OperationalEvent): void;
  getEvents(shiftId: string): OperationalEvent[];
  getShiftState(shiftId: string): ShiftState | undefined;
}

interface StoredData {
  shifts: Shift[];
  events: OperationalEvent[];
}

/**
 * JSON-file persistence for the PoC. One file, atomic rename on write.
 * Chosen over SQLite because it needs no native tooling and is trivially
 * inspectable; the ShiftStore interface keeps it replaceable.
 */
export class JsonFileShiftStore implements ShiftStore {
  private data: StoredData;

  constructor(private readonly filePath: string) {
    this.data = existsSync(filePath) ? this.read() : { shifts: [], events: [] };
  }

  createShift(name: string, startedAt?: string): Shift {
    const shift: Shift = {
      id: crypto.randomUUID(),
      name: name.trim(),
      startedAt: startedAt ?? new Date().toISOString(),
    };
    this.data.shifts.unshift(shift);
    this.persist();
    return shift;
  }

  getShift(id: string): Shift | undefined {
    return this.data.shifts.find((s) => s.id === id);
  }

  listShifts(): Shift[] {
    // Newest first: unshift() on create means storage order is already recency order.
    return [...this.data.shifts];
  }

  endShift(id: string, endedAt?: string): Shift {
    const shift = this.getExisting(id);
    if (shift.endedAt) throw new StoreError(`shift ${id} has already ended`);
    shift.endedAt = normalizeIso(endedAt ?? new Date().toISOString());
    this.persist();
    return shift;
  }

  appendEvent(event: OperationalEvent): void {
    const shift = this.getExisting(event.shiftId);
    if (shift.endedAt) {
      throw new StoreError(`shift ${event.shiftId} has ended; no further events are accepted`);
    }
    this.data.events.push(validateEvent(event));
    this.persist();
  }

  getEvents(shiftId: string): OperationalEvent[] {
    return this.data.events
      .filter((e) => e.shiftId === shiftId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  getShiftState(shiftId: string): ShiftState | undefined {
    const shift = this.getShift(shiftId);
    if (!shift) return undefined;
    return foldState(shift, this.getEvents(shiftId));
  }

  private getExisting(id: string): Shift {
    const shift = this.getShift(id);
    if (!shift) throw new StoreError(`unknown shift ${id}`);
    return shift;
  }

  private read(): StoredData {
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as StoredData;
    return { shifts: raw.shifts ?? [], events: raw.events ?? [] };
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Atomic write: temp file + rename, so a crash never truncates the store.
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

export class StoreError extends Error {}
