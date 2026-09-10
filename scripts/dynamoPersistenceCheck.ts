/**
 * Prove that the deployed runtime's operational history is durable.
 *
 * This constructs a brand-new `DynamoDbShiftStore` in a *separate process* from
 * the AgentCore runtime and reads the same table. Nothing is shared with the
 * runtime except the table itself, so anything printed here was genuinely
 * persisted, not held in a live microVM's memory.
 *
 * Usage (see README "Persistence"):
 *   SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
 *     AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
 *     npx tsx scripts/dynamoPersistenceCheck.ts
 */
import { resolveShiftStoreConfig } from "../src/store/shiftStoreFactory.ts";
import { createDynamoDbPort, DynamoDbShiftStore } from "../src/store/dynamoDbStore.ts";

const config = resolveShiftStoreConfig({ ...process.env, SHIFT_STORE: process.env.SHIFT_STORE ?? "dynamodb" });
if (config.kind !== "dynamodb" || !config.tableName) {
  console.error("this check requires SHIFT_STORE=dynamodb and SHIFT_TABLE_NAME");
  process.exit(2);
}

const store = new DynamoDbShiftStore(
  createDynamoDbPort({ tableName: config.tableName, ...(config.region ? { region: config.region } : {}) }),
  config.tableName,
);

const shifts = await store.listShifts();
console.log(`table ${config.tableName}: ${shifts.length} shift(s)`);

for (const shift of shifts) {
  const state = await store.getShiftState(shift.id);
  if (!state) continue;
  console.log(`\nshift ${shift.id} — "${shift.name}" (${state.events.length} events)`);
  for (const event of state.events) {
    console.log(`  ${event.occurredAt}  ${event.kind.padEnd(18)} ${event.subject}${event.claim ? ` → ${event.claim}` : ""}`);
  }
  for (const item of state.items) {
    const claims = item.claims.map((c) => c.canonicalValue).join(" | ");
    const decision = item.decision ? `  decided=${item.decision.canonicalValue}` : "";
    console.log(`  [${item.status.toUpperCase()}] ${item.canonicalSubject}${claims ? `  claims=${claims}` : ""}${decision}`);
  }
}

if (shifts.length === 0) {
  console.log("\nno shifts yet — invoke the deployed runtime at least once first");
  process.exit(1);
}
