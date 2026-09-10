import type { OperationalEvent, Shift, ShiftState } from "../domain/types.ts";
import { validateEvent, normalizeIso } from "../domain/validate.ts";
import { foldState } from "../domain/state.ts";
import type { ShiftStore } from "./jsonFileStore.ts";
import { StoreError } from "./jsonFileStore.ts";

/**
 * Process-local ShiftStore for the AgentCore Runtime entrypoint.
 *
 * AgentCore microVMs have ephemeral filesystems, so the JSON-file store would
 * be misleading here: writes would vanish on cold start, and the container
 * filesystem is not a persistence contract. This store implements the same
 * ShiftStore interface and reuses the exact same domain services
 * (validateEvent, foldState), so the deployed agent behaves identically to
 * the local app — the only difference is that state is per-process and resets
 * when the VM restarts. That limitation is documented in the README; it is
 * not disguised as production persistence.
 */
/** A snapshot of stored data, used to hydrate an in-memory facade. */
export interface ShiftStoreSnapshot {
  shifts: Shift[];
  events: OperationalEvent[];
}

export class InMemoryShiftStore implements ShiftStore {
  private readonly shifts: Shift[] = [];
  private readonly events: OperationalEvent[] = [];

  constructor(seed?: (store: ShiftStore) => void) {
    seed?.(this);
  }

  /**
   * Hydrate from already-validated stored data, preserving ids and timestamps
   * exactly. Used by the durable-store boundary so the synchronous domain code
   * runs unchanged over data loaded from DynamoDB.
   */
  static fromSnapshot(snapshot: ShiftStoreSnapshot): InMemoryShiftStore {
    const store = new InMemoryShiftStore();
    store.shifts.push(...snapshot.shifts);
    store.events.push(...snapshot.events);
    return store;
  }

  createShift(name: string, startedAt?: string): Shift {
    const shift: Shift = {
      id: crypto.randomUUID(),
      name: name.trim(),
      startedAt: startedAt ?? new Date().toISOString(),
    };
    this.shifts.unshift(shift);
    return shift;
  }

  getShift(id: string): Shift | undefined {
    return this.shifts.find((s) => s.id === id);
  }

  listShifts(): Shift[] {
    // Newest first: unshift() on create means storage order is already recency order.
    return [...this.shifts];
  }

  endShift(id: string, endedAt?: string): Shift {
    const shift = this.getExisting(id);
    if (shift.endedAt) throw new StoreError(`shift ${id} has already ended`);
    shift.endedAt = normalizeIso(endedAt ?? new Date().toISOString());
    return shift;
  }

  appendEvent(event: OperationalEvent): void {
    const shift = this.getExisting(event.shiftId);
    if (shift.endedAt) {
      throw new StoreError(`shift ${event.shiftId} has ended; no further events are accepted`);
    }
    this.events.push(validateEvent(event));
  }

  getEvents(shiftId: string): OperationalEvent[] {
    return this.events
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
}