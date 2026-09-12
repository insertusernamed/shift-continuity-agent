/**
 * Prove that the deployed runtime's operational history is durable.
 *
 * This constructs a brand-new `DynamoDbShiftStore` in a *separate process* from
 * the AgentCore runtime and reads the same table. Nothing is shared with the
 * runtime except the table itself, so anything printed here was genuinely
 * persisted, not held in a live microVM's memory.
 *
 * Usage (see README "Persistence"):
 *
 *   # List every shift in the table.
 *   SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
 *     AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
 *     npx tsx scripts/dynamoPersistenceCheck.ts
 *
 *   # Inspect exactly one shift (the id a remote smoke run printed).
 *   SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
 *     AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
 *     npx tsx scripts/dynamoPersistenceCheck.ts <shiftId>
 *
 * With an explicit shift id, only that shift is read — there is no fallback to
 * "some other shift", so a typo fails loudly instead of printing unrelated
 * history.
 */
import { resolveShiftStoreConfig } from "../src/store/shiftStoreFactory.ts";
import { createDynamoDbPort, DynamoDbShiftStore, type AsyncShiftStore } from "../src/store/dynamoDbStore.ts";
import type { Shift } from "../src/domain/types.ts";

/** Resolve the deployed table, refusing to run against anything else. */
function resolveTableName(): string {
  let config;
  try {
    config = resolveShiftStoreConfig({ ...process.env, SHIFT_STORE: process.env.SHIFT_STORE ?? "dynamodb" });
  } catch (err) {
    usage(err instanceof Error ? err.message : String(err));
  }
  if (config.kind !== "dynamodb" || !config.tableName) {
    usage(`this check reads the deployed table, so it needs SHIFT_STORE=dynamodb (got ${config.kind})`);
  }
  return config.tableName;
}

function usage(reason: string): never {
  console.error(
    `Persistence check: ${reason}\n\n` +
      `  SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \\\n` +
      `    AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \\\n` +
      `    npx tsx scripts/dynamoPersistenceCheck.ts [shiftId]\n`,
  );
  process.exit(2);
}

const requestedShiftId = process.argv[2];
const tableName = resolveTableName();
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

const store: AsyncShiftStore = new DynamoDbShiftStore(
  createDynamoDbPort({ tableName, ...(region ? { region } : {}) }),
  tableName,
);

const shifts = requestedShiftId ? await resolveRequestedShift(requestedShiftId) : await store.listShifts();
console.log(`table ${tableName}: ${shifts.length} shift(s)${requestedShiftId ? " (requested)" : ""}`);

for (const shift of shifts) {
  const state = await store.getShiftState(shift.id);
  if (!state) continue;
  console.log(`\nshift ${shift.id} — "${shift.name}" (${state.events.length} events)`);
  for (const event of state.events) {
    const attribution = event.actor ? `  by ${event.actor}` : "";
    const reason = event.note ? `  (“${event.note}”)` : "";
    console.log(
      `  ${event.occurredAt}  ${event.kind.padEnd(18)} ${event.subject}${event.claim ? ` → ${event.claim}` : ""}${attribution}${reason}`,
    );
  }
  for (const item of state.items) {
    const claims = item.claims.map((c) => c.canonicalValue).join(" | ");
    const decision = item.decision
      ? `  decided=${item.decision.canonicalValue}${item.decision.actor ? ` by ${item.decision.actor}` : ""}`
      : "";
    const reopened = item.reopened ? `  reopened${item.reopened.note ? ` (“${item.reopened.note}”)` : ""}` : "";
    console.log(`  [${item.status.toUpperCase()}] ${item.canonicalSubject}${claims ? `  claims=${claims}` : ""}${decision}${reopened}`);
  }
}

if (shifts.length === 0) {
  console.log("\nno shifts yet — invoke the deployed runtime at least once first");
  process.exit(1);
}

/** Read exactly one shift, never substituting a different one. */
async function resolveRequestedShift(shiftId: string): Promise<Shift[]> {
  const shift = await store.getShift(shiftId);
  if (!shift) {
    console.error(`Persistence check: no shift "${shiftId}" in ${tableName}`);
    process.exit(1);
  }
  return [shift];
}
