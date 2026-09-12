/**
 * Remote AgentCore smoke.
 *
 * Invokes the DEPLOYED Amazon Bedrock AgentCore Runtime through the official
 * programmatic path (AWS SDK `InvokeAgentRuntime`), proving the hosted agent
 * still calls the same deterministic tools and still enforces the
 * human-decision gate.
 *
 * ISOLATION: the deployed runtime persists its event log in DynamoDB, so a run
 * must never reuse another run's shift. Each run seeds its own uniquely named
 * shift from the canonical scenario and targets it (by id) on every request, so
 * runs are repeatable and prior history is preserved rather than cleared.
 *
 * This is an integration test against real AWS infrastructure — it is not
 * mocked. Complements scripts/agentSmoke.ts (local app) and
 * scripts/agentCoreLocalSmoke.ts (local AgentCore host).
 *
 * Usage:
 *   SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
 *     AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
 *     npx tsx scripts/agentCoreRemoteSmoke.ts
 *
 * Optional: AGENT_RUNTIME_ARN overrides the ARN recorded by `agentcore deploy`
 * in agentcore/.cli/deployed-state.json; AGENTCORE_SMOKE_RUN_ID overrides the
 * generated run id (useful to re-inspect one run's shift).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { canonicalClaim } from "../src/domain/claims.ts";
import { seedRemoteSmokeShift, smokePreconditionProblems } from "../src/demo/smokeScenario.ts";
import { createAsyncShiftStore, resolveShiftStoreConfig } from "../src/store/shiftStoreFactory.ts";
import type { AsyncShiftStore } from "../src/store/dynamoDbStore.ts";

const REGION = process.env.AWS_REGION ?? "ca-central-1";
const STATE_FILE = "agentcore/.cli/deployed-state.json";
/** Space sequential model calls so Bedrock's per-minute throttle is not tripped. */
const REQUEST_SPACING_MS = Number(process.env.AGENTCORE_SMOKE_SPACING_MS ?? 6000);
/** Bounded backoff between attempts when AWS returns a documented transient throttle. */
const THROTTLE_BACKOFF_MS = Number(process.env.AGENTCORE_SMOKE_BACKOFF_MS ?? 30_000);
const MAX_ATTEMPTS = Number(process.env.AGENTCORE_SMOKE_MAX_ATTEMPTS ?? 3);
const ACTOR = process.env.AGENTCORE_SMOKE_ACTOR ?? "Shift Supervisor";
const REOPEN_REASON = "the disposal record was wrong";

let failures = 0;
let throttles = 0;

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

/** Provider-side throttling must be reported distinctly, never retried into green. */
function isThrottle(text: string): boolean {
  return /too many requests|throttl|429|rate.?limit/i.test(text);
}

/* --------------------------------------------------- seeding the run's shift */

function resolveStoreConfig() {
  let config;
  try {
    config = resolveShiftStoreConfig({ ...process.env, SHIFT_STORE: process.env.SHIFT_STORE ?? "dynamodb" });
  } catch (err) {
    usageError(err instanceof Error ? err.message : String(err));
  }
  if (config.kind !== "dynamodb") {
    usageError(
      `the deployed runtime persists its event log in DynamoDB, so this smoke needs the same table (got SHIFT_STORE=${config.kind})`,
    );
  }
  return config;
}

function usageError(reason: string): never {
  console.error(
    `Remote AgentCore smoke: ${reason}\n\n` +
      `Each run seeds and targets its own shift in the deployed table, so both must be set:\n\n` +
      `  SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \\\n` +
      `    AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \\\n` +
      `    npx tsx scripts/agentCoreRemoteSmoke.ts\n`,
  );
  process.exit(2);
}

function resolveRuntimeArn(): string {
  if (process.env.AGENT_RUNTIME_ARN) return process.env.AGENT_RUNTIME_ARN;
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
    targets?: Record<string, { resources?: { runtimes?: Record<string, { runtimeArn?: string }> } }>;
  };
  for (const target of Object.values(state.targets ?? {})) {
    for (const runtime of Object.values(target.resources?.runtimes ?? {})) {
      if (runtime.runtimeArn) return runtime.runtimeArn;
    }
  }
  throw new Error(`no runtime ARN found in ${STATE_FILE}; set AGENT_RUNTIME_ARN`);
}

const storeConfig = resolveStoreConfig();
const runId = process.env.AGENTCORE_SMOKE_RUN_ID ?? randomUUID();
const runtimeArn = resolveRuntimeArn();
const client = new BedrockAgentCoreClient({ region: REGION });
/** One session for the run; correctness comes from the shift id, not the session. */
const sessionId = `agentcore-remote-smoke-${runId}`;

// Seed this run's own shift through the normal durable store path, then prove
// the starting state before asserting anything about agent behavior: a stale
// shift must surface as a setup error, not as a misleading model failure.
const seedStore = createAsyncShiftStore(storeConfig);
const shift = await seedRemoteSmokeShift(seedStore, runId);
const preconditions = smokePreconditionProblems((await seedStore.getShiftState(shift.id))!);
if (preconditions.length > 0) {
  console.error(`SETUP FAIL — seeded shift ${shift.id} ("${shift.name}") is not the canonical smoke scenario:`);
  for (const problem of preconditions) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Remote AgentCore smoke`);
console.log(`  runtime:  ${runtimeArn}`);
console.log(`  region:   ${REGION}`);
console.log(`  table:    ${storeConfig.tableName}`);
console.log(`  run id:   ${runId}`);
console.log(`  shift:    ${shift.id} ("${shift.name}")`);
console.log(`  session:  ${sessionId}\n`);

/* ------------------------------------------------------------- invocations */

/**
 * One remote invocation. Returns the parsed response envelope, or a synthetic
 * error envelope when the runtime returned a non-JSON payload.
 */
async function invoke(message: string, actor?: string): Promise<any> {
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    runtimeSessionId: sessionId,
    contentType: "application/json",
    accept: "application/json",
    payload: new TextEncoder().encode(
      JSON.stringify({ message, shiftId: shift.id, ...(actor ? { actor } : {}) }),
    ),
  });
  const response = await client.send(command);
  const text = (await response.response?.transformToString()) ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `unparsable response: ${text.slice(0, 300)}` };
  }
}

/** True when the attempt already changed state, so re-issuing it could double-apply. */
function hasSuccessfulMutation(envelope: any): boolean {
  return (envelope?.toolTrace ?? []).some(
    (t: any) =>
      (t.tool === "report_event" || t.tool === "record_human_decision" || t.tool === "reopen_human_decision") &&
      t.status === "success",
  );
}

/**
 * One scenario turn with bounded, throttle-only backoff.
 *
 * Retries happen ONLY for documented transient AWS throttling, and only when
 * the attempt did not already apply a mutation (so a retry can never
 * double-apply a report, a human decision, or a reopen). Semantic failures, tool
 * errors, validation errors, and unauthorized decisions are returned as-is —
 * this never retries model behavior into a green result.
 */
async function turn(label: string, message: string, actor?: string): Promise<any> {
  let envelope: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await sleep(REQUEST_SPACING_MS);
    envelope = await invoke(message, actor);
    if (envelope?.ok === true) return envelope;
    if (!isThrottle(String(envelope?.error ?? ""))) return envelope;
    if (hasSuccessfulMutation(envelope)) return envelope;
    throttles += 1;
    console.log(`THROTTLE — ${label} attempt ${attempt}/${MAX_ATTEMPTS} (${envelope.error})`);
    if (attempt < MAX_ATTEMPTS) await sleep(THROTTLE_BACKOFF_MS * attempt);
  }
  return envelope;
}

// 1. Routine report.
const report = await turn("routine report", "Aisle 7 is blocked.");
check(
  "routine report: report_event called and aisle 7 open",
  report.ok === true &&
    report.toolTrace?.[0]?.tool === "report_event" &&
    report.toolTrace?.[0]?.status === "success" &&
    report.item?.canonicalSubject === "aisle 7" &&
    report.item?.status === "open",
  JSON.stringify(report.result ?? report.error),
);

// 2. Resolution.
const resolve = await turn("resolution", "Aisle 7 is clear now.");
check(
  "resolution: aisle 7 resolved",
  resolve.ok === true &&
    resolve.toolTrace?.[0]?.tool === "report_event" &&
    resolve.toolTrace?.[0]?.status === "success" &&
    resolve.item?.canonicalSubject === "aisle 7" &&
    resolve.item?.status === "resolved",
  JSON.stringify(resolve.result ?? resolve.error),
);

// 3. Vague decision: safety invariant — nothing decided, conflict survives.
const vague = await turn("vague decision", "Just pick whichever makes sense for D104.");
const vagueDecisionCalls = (vague.toolTrace ?? []).filter((t: any) => t.tool === "record_human_decision");
const vagueRecorded = vagueDecisionCalls.some((t: any) => t.status === "success") || Boolean(vague.decision);
const vagueRefused = vagueDecisionCalls.every(
  (t: any) => t.status === "error" && /human_authorization_required|explicit human decision required/i.test(t.summary),
);
check(
  "vague decision: nothing decided (unauthorized attempt refused by the gate, if attempted)",
  !vagueRecorded && vagueRefused,
  JSON.stringify({ decision: vague.decision ?? null, trace: vagueDecisionCalls }),
);
check(
  "vague decision: response asks for human review without deciding",
  /(conflict|human review|human decision|decision is required|human input)/i.test(String(vague.result ?? "")),
  JSON.stringify(vague.result),
);
const stateCheck = await turn("state query", "What is the current state?");
const d104 = stateCheck.state?.conflictedItems?.find((i: any) => i.canonicalSubject === "d104");
check(
  "vague decision: D104 still conflicted in deterministic remote state",
  stateCheck.toolTrace?.[0]?.tool === "get_shift_state" && Boolean(d104),
  JSON.stringify(d104?.claims?.map((c: any) => c.canonicalValue) ?? stateCheck.result),
);

// 4. Explicit human decision, attributed to the acting human.
const explicit = await turn("explicit decision", "Send D104 to claims.", ACTOR);
check(
  "explicit decision: record_human_decision executed and D104 decided",
  explicit.ok === true &&
    explicit.toolTrace?.[0]?.tool === "record_human_decision" &&
    explicit.toolTrace?.[0]?.status === "success" &&
    explicit.decision?.canonicalValue === "claims" &&
    explicit.decision?.actor === ACTOR &&
    explicit.item?.status === "decided",
  JSON.stringify(explicit.result ?? explicit.error),
);

// 5. Handoff: authoritative deterministic projection.
const handoff = await turn("handoff", "What does the morning shift need to know?");
const handoffData = handoff.handoff;
check(
  "handoff: get_handoff called and authoritative projection returned",
  handoff.ok === true &&
    handoff.toolTrace?.[0]?.tool === "get_handoff" &&
    handoff.toolTrace?.[0]?.status === "success" &&
    Boolean(handoffData) &&
    Array.isArray(handoffData.requiresAction) &&
    Array.isArray(handoffData.requiresHumanReview),
  JSON.stringify(handoff.result ?? handoff.error),
);
check(
  "handoff: decided D104 no longer requires human review; freezer inspection still requires action",
  Boolean(handoffData) &&
    !handoffData.requiresHumanReview.some((i: any) => i.canonicalSubject === "d104") &&
    handoffData.requiresAction.some((i: any) => i.canonicalSubject === "freezer inspection"),
  JSON.stringify(handoffData?.requiresAction?.map((i: any) => i.canonicalSubject)),
);

// 6. Explicit reopen: the only way back out of a decision, and only when the
// human names the item and supplies the authorization context.
const reopened = await turn("reopen decision", `Reopen D104 because ${REOPEN_REASON}`, ACTOR);
check(
  "reopen: reopen_human_decision executed and D104 conflicted again",
  reopened.ok === true &&
    reopened.toolTrace?.[0]?.tool === "reopen_human_decision" &&
    reopened.toolTrace?.[0]?.status === "success" &&
    reopened.item?.status === "conflicted" &&
    reopened.item?.decision?.canonicalValue === "claims",
  JSON.stringify(reopened.result ?? reopened.error),
);

/* --------------------------------------------------- persisted-state readback */

// A store instance constructed after the turns, reading the real table: anything
// found here was persisted, not held in this process.
const persisted: AsyncShiftStore = createAsyncShiftStore(storeConfig);
const persistedState = await persisted.getShiftState(shift.id);
const persistedD104 = persistedState?.items.find((item) => item.canonicalSubject === "d104");
check(
  "persisted: aisle 7 resolution and freezer inspection survived in the durable log",
  persistedState?.items.find((i) => i.canonicalSubject === "aisle 7")?.status === "resolved" &&
    persistedState?.items.find((i) => i.canonicalSubject === "freezer inspection")?.status === "open",
  JSON.stringify(persistedState?.items.map((i) => `${i.canonicalSubject}:${i.status}`)),
);
check(
  "persisted: D104 carries both original conflicting claims",
  (persistedD104?.claims ?? []).map((claim) => claim.canonicalValue).sort().join(",") === "claims,discard",
  JSON.stringify(persistedD104?.claims?.map((c) => c.canonicalValue)),
);
check(
  "persisted: D104 is conflicted again with the superseded decision retained",
  persistedD104?.status === "conflicted" && persistedD104?.decision?.canonicalValue === "claims",
  JSON.stringify({ status: persistedD104?.status, decision: persistedD104?.decision?.canonicalValue }),
);
const persistedHistory = persistedState?.events ?? [];
const recorded = persistedHistory.find((event) => event.kind === "decision_recorded");
const reopenEvent = persistedHistory.find((event) => event.kind === "decision_reopened");
check(
  "persisted: attributed decision_recorded in the append-only history",
  recorded?.actor === ACTOR && canonicalClaim(recorded?.claim ?? "") === "claims",
  JSON.stringify({ actor: recorded?.actor, claim: recorded?.claim }),
);
check(
  "persisted: decision_reopened with actor and verbatim reason",
  reopenEvent?.actor === ACTOR && reopenEvent?.note === REOPEN_REASON,
  JSON.stringify({ actor: reopenEvent?.actor, note: reopenEvent?.note }),
);

console.log(
  `\nRemote AgentCore smoke: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s)${
    throttles > 0 ? `, ${throttles} provider throttle(s)` : ""
  })`,
);
console.log(`Run shift: ${shift.id} ("${shift.name}")`);
if (failures > 0) process.exitCode = 1;
