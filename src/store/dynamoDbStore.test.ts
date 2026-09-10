import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DynamoDbShiftStore,
  ConditionalWriteError,
  type DynamoDbItem,
  type DynamoDbPort,
  type PutCondition,
} from "./dynamoDbStore.ts";
import { InMemoryShiftStore } from "./inMemoryStore.ts";
import { StoreError } from "./jsonFileStore.ts";
import { validateEvent } from "../domain/validate.ts";
import { recordableDecision } from "../domain/decide.ts";
import { createDemoShift } from "../demo/demo.ts";
import type { OperationalEvent } from "../domain/types.ts";

/**
 * Deterministic in-memory implementation of the narrow DynamoDB port.
 *
 * It is not a mock: it implements the port's contract for real (including the
 * conditional-put rejection), so the store's concurrency semantics are actually
 * exercised without any network or DynamoDB local emulator.
 */
class FakeDynamoPort implements DynamoDbPort {
  private readonly items = new Map<string, DynamoDbItem>();
  /** Counts conditional-put rejections, so tests can prove a write was attempted. */
  rejects = 0;

  private static key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async putIf(item: DynamoDbItem, condition: PutCondition): Promise<void> {
    const existing = this.items.get(FakeDynamoPort.key(item.pk, item.sk));
    if ("mustNotExist" in condition && existing) {
      this.rejects += 1;
      throw new ConditionalWriteError(`${item.pk}/${item.sk} already exists`);
    }
    if ("absentAttribute" in condition && existing && existing[condition.absentAttribute] !== undefined) {
      this.rejects += 1;
      throw new ConditionalWriteError(`${item.pk}/${item.sk} already has ${condition.absentAttribute}`);
    }
    // Merge so an update keeps fields the caller did not restate.
    this.items.set(FakeDynamoPort.key(item.pk, item.sk), { ...existing, ...item });
  }

  async get(pk: string, sk: string): Promise<DynamoDbItem | undefined> {
    return this.items.get(FakeDynamoPort.key(pk, sk));
  }

  async queryPartition(pk: string): Promise<DynamoDbItem[]> {
    return [...this.items.values()]
      .filter((item) => item.pk === pk)
      .sort((a, b) => a.sk.localeCompare(b.sk));
  }

  async queryShiftsNewestFirst(): Promise<DynamoDbItem[]> {
    // Mirrors the real GSI: only index entries, descending by the index sort key.
    return [...this.items.values()]
      .filter((item) => item.gsi1pk === "SHIFTS")
      .sort((a, b) => String(b.gsi1sk).localeCompare(String(a.gsi1sk)));
  }
}

function makeEvent(shiftId: string, overrides: Partial<OperationalEvent> = {}): OperationalEvent {
  return validateEvent({
    id: crypto.randomUUID(),
    shiftId,
    occurredAt: "2026-09-08T02:11:00Z",
    kind: "problem_reported",
    subject: "aisle 7",
    description: "aisle 7 blocked",
    source: "test",
    ...overrides,
  });
}

let port: FakeDynamoPort;
let store: DynamoDbShiftStore;

beforeEach(() => {
  port = new FakeDynamoPort();
  store = new DynamoDbShiftStore(port, "shift-events");
});

describe("DynamoDbShiftStore", () => {
  it("creates a shift and appends an event that can be read back", async () => {
    const shift = await store.createShift("Night Shift", "2026-09-08T02:00:00Z");
    await store.appendEvent(makeEvent(shift.id));

    const events = await store.getEvents(shift.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.subject, "aisle 7");
    assert.equal(events[0]?.occurredAt, "2026-09-08T02:11:00.000Z");
    assert.equal((await store.getShift(shift.id))?.name, "Night Shift");
  });

  it("returns events in deterministic chronological order regardless of append order", async () => {
    const shift = await store.createShift("Night Shift");
    await store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T03:04:00Z", kind: "cleared" }));
    await store.appendEvent(makeEvent(shift.id, { occurredAt: "2026-09-08T02:11:00Z" }));

    const events = await store.getEvents(shift.id);
    assert.deepEqual(
      events.map((e) => e.occurredAt),
      ["2026-09-08T02:11:00.000Z", "2026-09-08T03:04:00.000Z"],
    );
  });

  it("keeps two events with the same timestamp distinct and in a stable order", async () => {
    const shift = await store.createShift("Night Shift");
    const first = makeEvent(shift.id, { subject: "aisle 7", description: "aisle 7 blocked" });
    const second = makeEvent(shift.id, { subject: "aisle 9", description: "aisle 9 blocked" });
    await store.appendEvent(first);
    await store.appendEvent(second);

    const events = await store.getEvents(shift.id);
    assert.equal(events.length, 2, "same-timestamp events must not collapse into one");
    assert.deepEqual(new Set(events.map((e) => e.id)), new Set([first.id, second.id]));
    // Re-reading returns the identical order (deterministic tie-break, not insertion luck).
    assert.deepEqual((await store.getEvents(shift.id)).map((e) => e.id), events.map((e) => e.id));
  });

  it("refuses to silently overwrite an existing event (conditional append)", async () => {
    const shift = await store.createShift("Night Shift");
    const event = makeEvent(shift.id);
    await store.appendEvent(event);

    await assert.rejects(() => store.appendEvent(event), (err: Error) => {
      assert.ok(err instanceof StoreError, "must surface as the store's own error type");
      assert.match(err.message, /already exists/);
      return true;
    });

    assert.equal(port.rejects, 1);
    assert.equal((await store.getEvents(shift.id)).length, 1, "the original event is untouched");
  });

  it("isolates shifts from one another", async () => {
    const night = await store.createShift("Night Shift");
    const day = await store.createShift("Day Shift");
    await store.appendEvent(makeEvent(night.id, { subject: "aisle 7" }));
    await store.appendEvent(makeEvent(day.id, { subject: "aisle 12" }));

    assert.deepEqual((await store.getEvents(night.id)).map((e) => e.subject), ["aisle 7"]);
    assert.deepEqual((await store.getEvents(day.id)).map((e) => e.subject), ["aisle 12"]);
  });

  it("lists shifts newest first", async () => {
    await store.createShift("Night Shift", "2026-09-08T02:00:00Z");
    await store.createShift("Day Shift", "2026-09-08T14:00:00Z");
    assert.deepEqual((await store.listShifts()).map((s) => s.name), ["Day Shift", "Night Shift"]);
  });

  it("folds the same state as the existing stores over the same events", async () => {
    const inMemory = new InMemoryShiftStore((s) => {
      createDemoShift(s);
    });
    const demoShiftId = inMemory.listShifts()[0]!.id;
    const demoEvents = inMemory.getEvents(demoShiftId);

    const shift = await store.createShift("Night Shift (demo)", "2026-09-08T02:00:00Z");
    for (const event of demoEvents) {
      await store.appendEvent({ ...event, shiftId: shift.id });
    }

    const fromDynamo = await store.getShiftState(shift.id);
    const fromMemory = inMemory.getShiftState(demoShiftId);
    assert.ok(fromDynamo && fromMemory);
    // Item identity and status are what the handoff is built from; ids differ per store.
    const shape = (state: NonNullable<typeof fromDynamo>) =>
      state.items
        .map((i) => `${i.canonicalSubject}:${i.status}:${i.claims.map((c) => c.canonicalValue).sort().join("|")}`)
        .sort();
    assert.deepEqual(shape(fromDynamo), shape(fromMemory));
    assert.equal(fromDynamo.events.length, demoEvents.length);
  });

  it("keeps a human decision in history and in the folded state across a new store instance", async () => {
    const shift = await store.createShift("Night Shift");
    await store.appendEvent(
      makeEvent(shift.id, {
        occurredAt: "2026-09-08T05:02:00Z",
        kind: "status_claimed",
        subject: "damaged case D104",
        description: "claims",
        claim: "send to claims",
        source: "scanner",
      }),
    );
    await store.appendEvent(
      makeEvent(shift.id, {
        occurredAt: "2026-09-08T05:14:00Z",
        kind: "status_claimed",
        subject: "damaged case D104",
        description: "discarded",
        claim: "discarded",
        source: "operator",
      }),
    );
    const conflicted = await store.getShiftState(shift.id);
    const decision = recordableDecision({
      state: conflicted!,
      subject: "damaged case D104",
      claim: "claims",
      eventId: crypto.randomUUID(),
      occurredAt: "2026-09-08T05:40:00Z",
    });
    await store.appendEvent(decision);

    // A brand-new store instance over the same port = a cold start with no in-process state.
    const coldStart = new DynamoDbShiftStore(port, "shift-events");
    const state = await coldStart.getShiftState(shift.id);
    assert.ok(state);
    assert.equal(state.events.length, 3, "both claims and the decision remain in history");
    const d104 = state.items.find((i) => i.canonicalSubject === "d104");
    assert.equal(d104?.status, "decided");
    assert.equal(d104?.decision?.canonicalValue, "claims");
  });

  it("carries an ended shift's endedAt across a new store instance", async () => {
    const shift = await store.createShift("Night Shift");
    await store.appendEvent(makeEvent(shift.id));
    await store.endShift(shift.id, "2026-09-08T06:00:00Z");

    const coldStart = new DynamoDbShiftStore(port, "shift-events");
    const reloaded = await coldStart.getShift(shift.id);
    assert.equal(reloaded?.endedAt, "2026-09-08T06:00:00.000Z");
    await assert.rejects(() => coldStart.appendEvent(makeEvent(shift.id)), (err: Error) => {
      assert.match(err.message, /ended/);
      return true;
    });
    await assert.rejects(() => coldStart.endShift(shift.id, "2026-09-08T07:00:00Z"), /already ended/);
  });

  it("rejects an unknown shift instead of inventing one", async () => {
    await assert.rejects(() => store.appendEvent(makeEvent("nope")), /unknown shift/);
    assert.equal(await store.getShiftState("nope"), undefined);
  });

  it("preserves photo evidence metadata through the wire round-trip", async () => {
    const shift = await store.createShift("Night Shift");
    await store.appendEvent(
      makeEvent(shift.id, {
        subject: "aisle 12",
        evidence: [
          { id: "ev-1", fileName: "aisle12-blocked.png", contentType: "image/png", note: "Aisle 12 is blocked." },
        ],
      }),
    );
    const [event] = await store.getEvents(shift.id);
    assert.deepEqual(event?.evidence, [
      { id: "ev-1", fileName: "aisle12-blocked.png", contentType: "image/png", note: "Aisle 12 is blocked." },
    ]);
  });
});
