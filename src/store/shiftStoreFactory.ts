import type { OperationalEvent, Shift, ShiftState } from "../domain/types.ts";
import { JsonFileShiftStore } from "./jsonFileStore.ts";
import type { ShiftStore } from "./jsonFileStore.ts";
import { createDynamoDbPort, DynamoDbShiftStore, type AsyncShiftStore, type DynamoDbPort } from "./dynamoDbStore.ts";

/**
 * How the runtime picks its persistent store.
 *
 * Selection is explicit (`SHIFT_STORE`), never inferred from environment
 * heuristics — the same discipline the model provider uses. `memory` stays the
 * default so existing local/AgentCore-dev behavior is unchanged; a deployment
 * opts in to durability by setting `SHIFT_STORE=dynamodb`.
 */
export type ShiftStoreKind = "memory" | "json" | "dynamodb";

export interface ShiftStoreConfig {
  kind: ShiftStoreKind;
  /** File used by the `json` kind (local durability). */
  dataFile: string;
  /** Directory holding photo-evidence bytes (always local for this PoC). */
  evidenceDir: string;
  /** Table used by the `dynamodb` kind. */
  tableName?: string;
  region?: string;
}

const KINDS: readonly ShiftStoreKind[] = ["memory", "json", "dynamodb"];

export function resolveShiftStoreConfig(env: NodeJS.ProcessEnv): ShiftStoreConfig {
  const requested = (env.SHIFT_STORE ?? "memory").trim().toLowerCase();
  if (!KINDS.includes(requested as ShiftStoreKind)) {
    throw new Error(`SHIFT_STORE must be one of ${KINDS.join(", ")}, got "${requested}"`);
  }
  const kind = requested as ShiftStoreKind;
  const tableName = env.SHIFT_TABLE_NAME?.trim();
  if (kind === "dynamodb" && !tableName) {
    throw new Error("SHIFT_STORE=dynamodb requires SHIFT_TABLE_NAME");
  }

  const config: ShiftStoreConfig = {
    kind,
    dataFile: env.DATA_FILE ?? "data/shifts.json",
    evidenceDir: env.EVIDENCE_DIR ?? "data/evidence",
  };
  if (tableName) config.tableName = tableName;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (region) config.region = region;
  return config;
}

/** One line for the startup log — no event contents, ever. */
export function describeShiftStore(config: ShiftStoreConfig): string {
  if (config.kind === "dynamodb") return `ShiftStore: DynamoDB (${config.tableName})`;
  if (config.kind === "json") return `ShiftStore: JSON file (${config.dataFile})`;
  return "ShiftStore: in-memory (ephemeral)";
}

/** Adapts the synchronous JSON store to the async durable contract. */
class AsyncJsonShiftStore implements AsyncShiftStore {
  constructor(private readonly inner: JsonFileShiftStore) {}

  async createShift(name: string, startedAt?: string): Promise<Shift> {
    return this.inner.createShift(name, startedAt);
  }
  async getShift(id: string): Promise<Shift | undefined> {
    return this.inner.getShift(id);
  }
  async listShifts(): Promise<Shift[]> {
    return this.inner.listShifts();
  }
  async endShift(id: string, endedAt?: string): Promise<Shift> {
    return this.inner.endShift(id, endedAt);
  }
  async appendEvent(event: OperationalEvent): Promise<void> {
    this.inner.appendEvent(event);
  }
  async getEvents(shiftId: string): Promise<OperationalEvent[]> {
    return this.inner.getEvents(shiftId);
  }
  async getShiftState(shiftId: string): Promise<ShiftState | undefined> {
    return this.inner.getShiftState(shiftId);
  }
}

/**
 * Build the async durable store for a container-runtime config. `port` is
 * injectable so the DynamoDB path can be exercised without AWS.
 */
export function createAsyncShiftStore(
  config: ShiftStoreConfig,
  deps: { port?: DynamoDbPort } = {},
): AsyncShiftStore {
  if (config.kind === "dynamodb") {
    const tableName = config.tableName!;
    const port =
      deps.port ??
      createDynamoDbPort({ tableName, ...(config.region ? { region: config.region } : {}) });
    return new DynamoDbShiftStore(port, tableName);
  }
  if (config.kind === "json") {
    return new AsyncJsonShiftStore(new JsonFileShiftStore(config.dataFile));
  }
  throw new Error("the in-memory store is per-session and has no async durable form");
}

/** Narrow view for callers that only need the synchronous contract. */
export type { ShiftStore };
