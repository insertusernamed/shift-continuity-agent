import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShiftStoreConfig, createAsyncShiftStore } from "./shiftStoreFactory.ts";
import { DynamoDbShiftStore, type DynamoDbPort } from "./dynamoDbStore.ts";
import { validateEvent } from "../domain/validate.ts";

/** Minimal port stub: only proves which storage the factory selected. */
function stubPort(): DynamoDbPort {
  return {
    async putIf() {},
    async get() {
      return undefined;
    },
    async queryPartition() {
      return [];
    },
    async queryShiftsNewestFirst() {
      return [];
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shift-store-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shift store configuration", () => {
  it("defaults to the in-memory store when nothing is configured", () => {
    const config = resolveShiftStoreConfig({});
    assert.equal(config.kind, "memory");
  });

  it("selects the durable stores explicitly, never by guessing", () => {
    assert.equal(resolveShiftStoreConfig({ SHIFT_STORE: "dynamodb", SHIFT_TABLE_NAME: "t" }).kind, "dynamodb");
    assert.equal(resolveShiftStoreConfig({ SHIFT_STORE: "json", DATA_FILE: "x.json" }).kind, "json");
    assert.equal(resolveShiftStoreConfig({ SHIFT_STORE: "memory" }).kind, "memory");
  });

  it("reads the table name and region for the DynamoDB store", () => {
    const config = resolveShiftStoreConfig({
      SHIFT_STORE: "dynamodb",
      SHIFT_TABLE_NAME: "shift-events",
      AWS_REGION: "ca-central-1",
    });
    assert.equal(config.tableName, "shift-events");
    assert.equal(config.region, "ca-central-1");
  });

  it("rejects an unknown store kind instead of silently falling back", () => {
    assert.throws(() => resolveShiftStoreConfig({ SHIFT_STORE: "postgres" }), /SHIFT_STORE/);
  });

  it("rejects a DynamoDB selection with no table name", () => {
    assert.throws(
      () => resolveShiftStoreConfig({ SHIFT_STORE: "dynamodb" }),
      /SHIFT_TABLE_NAME/,
    );
  });

  it("builds a DynamoDB-backed store for the dynamodb kind", () => {
    const store = createAsyncShiftStore(
      resolveShiftStoreConfig({ SHIFT_STORE: "dynamodb", SHIFT_TABLE_NAME: "shift-events" }),
      { port: stubPort() },
    );
    assert.ok(store instanceof DynamoDbShiftStore);
  });

  it("builds a durable json-backed store for the json kind", async () => {
    const file = join(dir, "shifts.json");
    const store = createAsyncShiftStore(resolveShiftStoreConfig({ SHIFT_STORE: "json", DATA_FILE: file }));

    const shift = await store.createShift("Night Shift", "2026-09-08T02:00:00Z");
    await store.appendEvent(
      validateEvent({
        id: crypto.randomUUID(),
        shiftId: shift.id,
        occurredAt: "2026-09-08T02:11:00Z",
        kind: "problem_reported",
        subject: "aisle 7",
        description: "aisle 7 blocked",
        source: "test",
      }),
    );

    // A second store over the same file = a restart with no in-process state.
    const reopened = createAsyncShiftStore(resolveShiftStoreConfig({ SHIFT_STORE: "json", DATA_FILE: file }));
    assert.equal((await reopened.getEvents(shift.id)).length, 1);
    assert.equal((await reopened.getShiftState(shift.id))?.items[0]?.status, "open");
  });
});
