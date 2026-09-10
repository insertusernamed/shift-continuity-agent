import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { OperationalEvent, Shift, ShiftState } from "../domain/types.ts";
import { validateEvent, normalizeIso } from "../domain/validate.ts";
import { foldState } from "../domain/state.ts";
import { InMemoryShiftStore } from "./inMemoryStore.ts";
import type { ShiftStore } from "./jsonFileStore.ts";
import { StoreError } from "./jsonFileStore.ts";

/**
 * Durable, append-only persistence for the deployed AgentCore runtime.
 *
 * Design rule (AGENTS.md §7): the table stores *source events*, never folded
 * state. Current state is always recomputed with the same `foldState` the local
 * app uses, so DynamoDB cannot introduce a second version of the truth.
 *
 * Single table, `PK`/`SK`:
 *
 *   PK = SHIFT#<shiftId>   SK = META
 *     → shift metadata (name, startedAt, endedAt) + the shifts-index keys
 *   PK = SHIFT#<shiftId>   SK = EVENT#<occurredAt>#<eventId>
 *     → one immutable operational event
 *
 * The sort key makes chronological folding fall out of the key order: ISO 8601
 * UTC timestamps are fixed-width, so lexicographic order *is* chronological
 * order, and appending `<eventId>` after the timestamp keeps two events that
 * share a timestamp distinct instead of colliding.
 *
 * The table's shape lives here; the `DynamoDbPort` hides DynamoDB's wire format
 * (and makes the store unit-testable without a network or an emulator).
 */

/** One item in the single table. `pk`/`sk` are the table keys; the rest are fields. */
export interface DynamoDbItem {
  pk: string;
  sk: string;
  [field: string]: unknown;
}

/**
 * A conditional put, expressed semantically so DynamoDB expression strings stay
 * inside the AWS adapter:
 * - `mustNotExist` — reject if the item already exists (append-only safety).
 * - `absentAttribute` — the item may exist, but must not already set that field.
 */
export type PutCondition = { mustNotExist: true } | { absentAttribute: string };

/** Raised when a conditional write loses because the stored state contradicts it. */
export class ConditionalWriteError extends Error {}

/**
 * The only DynamoDB operations this store needs. Narrow by design: no scan, no
 * transactions, no streams (AGENTS.md §9 — nothing speculative).
 */
export interface DynamoDbPort {
  putIf(item: DynamoDbItem, condition: PutCondition): Promise<void>;
  get(pk: string, sk: string): Promise<DynamoDbItem | undefined>;
  /** Every item sharing a partition, sorted by sort key ascending. */
  queryPartition(pk: string): Promise<DynamoDbItem[]>;
  /** Shift metadata items through the shifts index, newest start first. */
  queryShiftsNewestFirst(): Promise<DynamoDbItem[]>;
}

/**
 * Async mirror of the synchronous `ShiftStore` contract. The domain is
 * intentionally synchronous and pure (AGENTS.md §5), so the durable store
 * exposes async I/O here and is adapted to the sync facade at the runtime
 * boundary via `hydrateShiftStore`.
 */
export interface AsyncShiftStore {
  createShift(name: string, startedAt?: string): Promise<Shift>;
  getShift(id: string): Promise<Shift | undefined>;
  listShifts(): Promise<Shift[]>;
  endShift(id: string, endedAt?: string): Promise<Shift>;
  appendEvent(event: OperationalEvent): Promise<void>;
  getEvents(shiftId: string): Promise<OperationalEvent[]>;
  getShiftState(shiftId: string): Promise<ShiftState | undefined>;
}

const SHIFT_PREFIX = "SHIFT#";
const EVENT_PREFIX = "EVENT#";
const META_SK = "META";
/** A single GSI is a concrete need, not speculation: `listShifts` queries it. */
const SHIFTS_INDEX_PK = "SHIFTS";

function shiftPartition(shiftId: string): string {
  return `${SHIFT_PREFIX}${shiftId}`;
}

function eventSortKey(event: OperationalEvent): string {
  return `${EVENT_PREFIX}${event.occurredAt}#${event.id}`;
}

function text(item: DynamoDbItem, field: string): string | undefined {
  const value = item[field];
  return typeof value === "string" ? value : undefined;
}

function toShift(item: DynamoDbItem): Shift {
  const shift: Shift = {
    id: text(item, "id") ?? "",
    name: text(item, "name") ?? "",
    startedAt: text(item, "startedAt") ?? "",
  };
  const endedAt = text(item, "endedAt");
  if (endedAt) shift.endedAt = endedAt;
  return shift;
}

export class DynamoDbShiftStore implements AsyncShiftStore {
  constructor(
    private readonly port: DynamoDbPort,
    /** Table name, for diagnostics/logging only. */
    readonly tableName: string,
  ) {}

  async createShift(name: string, startedAt?: string): Promise<Shift> {
    const shift: Shift = {
      id: crypto.randomUUID(),
      name: name.trim(),
      startedAt: normalizeIso(startedAt ?? new Date().toISOString()),
    };
    await this.writeShiftMeta(shift, { mustNotExist: true });
    return shift;
  }

  async getShift(id: string): Promise<Shift | undefined> {
    const item = await this.port.get(shiftPartition(id), META_SK);
    return item ? toShift(item) : undefined;
  }

  async listShifts(): Promise<Shift[]> {
    const items = await this.port.queryShiftsNewestFirst();
    return items.map(toShift);
  }

  async endShift(id: string, endedAt?: string): Promise<Shift> {
    const shift = await this.requireShift(id);
    if (shift.endedAt) throw new StoreError(`shift ${id} has already ended`);
    const ended: Shift = { ...shift, endedAt: normalizeIso(endedAt ?? new Date().toISOString()) };
    try {
      // Conditional so a concurrent end cannot be silently clobbered.
      await this.writeShiftMeta(ended, { absentAttribute: "endedAt" });
    } catch (err) {
      throw asStoreError(err, `shift ${id} has already ended`);
    }
    return ended;
  }

  async appendEvent(event: OperationalEvent): Promise<void> {
    const shift = await this.requireShift(event.shiftId);
    if (shift.endedAt) {
      throw new StoreError(`shift ${event.shiftId} has ended; no further events are accepted`);
    }
    const validated = validateEvent(event);
    try {
      // Append-only: an existing key means this event was already written.
      // Never last-write-wins for operational history.
      await this.port.putIf(
        {
          pk: shiftPartition(validated.shiftId),
          sk: eventSortKey(validated),
          event: validated,
        },
        { mustNotExist: true },
      );
    } catch (err) {
      throw asStoreError(
        err,
        `event ${validated.id} already exists for shift ${validated.shiftId}; refusing to overwrite history`,
      );
    }
  }

  async getEvents(shiftId: string): Promise<OperationalEvent[]> {
    const items = await this.port.queryPartition(shiftPartition(shiftId));
    return items
      .filter((item) => item.sk.startsWith(EVENT_PREFIX))
      .map((item) => validateEvent(item.event));
  }

  async getShiftState(shiftId: string): Promise<ShiftState | undefined> {
    const shift = await this.getShift(shiftId);
    if (!shift) return undefined;
    return foldState(shift, await this.getEvents(shiftId));
  }

  private async writeShiftMeta(shift: Shift, condition: PutCondition): Promise<void> {
    const item: DynamoDbItem = {
      pk: shiftPartition(shift.id),
      sk: META_SK,
      id: shift.id,
      name: shift.name,
      startedAt: shift.startedAt,
      // Shifts-index keys. Newest first is the index's descending sort key.
      gsi1pk: SHIFTS_INDEX_PK,
      gsi1sk: shift.startedAt,
    };
    if (shift.endedAt) item.endedAt = shift.endedAt;
    await this.port.putIf(item, condition);
  }

  private async requireShift(id: string): Promise<Shift> {
    const shift = await this.getShift(id);
    if (!shift) throw new StoreError(`unknown shift ${id}`);
    return shift;
  }
}

function asStoreError(err: unknown, message: string): Error {
  if (err instanceof ConditionalWriteError) return new StoreError(message);
  return err instanceof Error ? err : new Error(String(err));
}

/* ------------------------------------------------------------ AWS adapter */

export interface DynamoDbPortOptions {
  tableName: string;
  region?: string;
  /** Injected for tests/tools; production builds one DocumentClient. */
  client?: DynamoDBDocumentClient;
}

/**
 * The only place DynamoDB's wire format lives. `PK`/`SK` and the index keys are
 * mapped here; no `AttributeValue` types escape into the store or the domain.
 */
export function createDynamoDbPort(options: DynamoDbPortOptions): DynamoDbPort {
  const TableName = options.tableName;
  const doc =
    options.client ??
    DynamoDBDocumentClient.from(new DynamoDBClient(options.region ? { region: options.region } : {}));

  const toStored = (item: DynamoDbItem): Record<string, unknown> => {
    const { pk, sk, gsi1pk, gsi1sk, ...fields } = item;
    return {
      PK: pk,
      SK: sk,
      ...fields,
      ...(gsi1pk !== undefined ? { GSI1PK: gsi1pk, GSI1SK: gsi1sk } : {}),
    };
  };

  const fromStored = (stored: Record<string, unknown>): DynamoDbItem => {
    const { PK, SK, GSI1PK, GSI1SK, ...fields } = stored;
    return {
      pk: String(PK),
      sk: String(SK),
      ...fields,
      ...(GSI1PK !== undefined ? { gsi1pk: GSI1PK, gsi1sk: GSI1SK } : {}),
    };
  };

  return {
    async putIf(item, condition) {
      const absent = "absentAttribute" in condition ? condition.absentAttribute : undefined;
      try {
        await doc.send(
          new PutCommand({
            TableName,
            Item: toStored(item),
            ConditionExpression: absent ? "attribute_not_exists(#absent)" : "attribute_not_exists(PK)",
            ...(absent ? { ExpressionAttributeNames: { "#absent": absent } } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          throw new ConditionalWriteError(`${item.pk}/${item.sk} failed condition`);
        }
        throw err;
      }
    },

    async get(pk, sk) {
      const result = await doc.send(new GetCommand({ TableName, Key: { PK: pk, SK: sk } }));
      return result.Item ? fromStored(result.Item) : undefined;
    },

    async queryPartition(pk) {
      const result = await doc.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? []).map(fromStored);
    },

    async queryShiftsNewestFirst() {
      const result = await doc.send(
        new QueryCommand({
          TableName,
          IndexName: "shiftsByStart",
          KeyConditionExpression: "GSI1PK = :g",
          ExpressionAttributeValues: { ":g": SHIFTS_INDEX_PK },
          ScanIndexForward: false,
        }),
      );
      return (result.Items ?? []).map(fromStored);
    },
  };
}

/* ------------------------------------------------- sync boundary adapter */

/**
 * The domain layer is synchronous, so the durable store is adapted to the
 * existing `ShiftStore` contract by hydrating a snapshot for the duration of one
 * invocation and flushing the appended events before the caller replies.
 *
 * This is why the domain never learns that DynamoDB exists: reads happen once,
 * the same synchronous `foldState`/tool code runs unchanged, and the newly
 * appended events are written with the same conditional-append guarantees.
 * `flush()` must be awaited before answering; the AgentCore runtime does that.
 */
export interface HydratedShiftStore {
  /** Synchronous facade over the hydrated snapshot. */
  store: ShiftStore;
  /** Persist every event appended through the facade, in order. */
  flush(): Promise<void>;
}

export async function hydrateShiftStore(
  durable: AsyncShiftStore,
  shiftId: string,
): Promise<HydratedShiftStore> {
  const shift = await durable.getShift(shiftId);
  if (!shift) throw new StoreError(`unknown shift ${shiftId}`);
  const events = await durable.getEvents(shiftId);

  const store = InMemoryShiftStore.fromSnapshot({ shifts: [shift], events });
  const persisted = new Set(events.map((event) => event.id));
  let flushed = false;

  return {
    store,
    async flush() {
      if (flushed) return;
      for (const event of store.getEvents(shiftId)) {
        if (persisted.has(event.id)) continue;
        await durable.appendEvent(event);
        persisted.add(event.id);
      }
      const current = store.getShift(shiftId);
      if (current?.endedAt && !shift.endedAt) await durable.endShift(shiftId, current.endedAt);
      flushed = true;
    },
  };
}

/**
 * Find the shift this runtime should use, creating and seeding the demo shift
 * only when the table is genuinely empty. With a durable store this runs once
 * per table, not once per process — which is the whole point of the milestone.
 */
export async function ensureSeededShift(store: AsyncShiftStore, seed: () => Promise<void>): Promise<Shift> {
  const existing = (await store.listShifts())[0];
  if (existing) return existing;
  await seed();
  const created = (await store.listShifts())[0];
  if (!created) throw new StoreError("seed did not create a shift");
  return created;
}
