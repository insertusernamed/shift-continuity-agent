/**
 * Local AgentCore smoke.
 *
 * Hosts the real AgentCore entrypoint (app/ShiftContinuityAgent) through the
 * official local path (`agentcore dev`) and drives the same HTTP invocation
 * protocol the deployed runtime exposes. This is a live test: the Strands
 * agent calls the real Bedrock model and the deterministic tools.
 *
 * Complements — does not replace — scripts/agentSmoke.ts (the local-app suite).
 *
 * Usage:
 *   AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 npx tsx scripts/agentCoreLocalSmoke.ts
 *
 * Requirements: `agentcore` CLI installed, `app/ShiftContinuityAgent` deps
 * installed, AWS credentials available for the configured model.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.AGENTCORE_SMOKE_PORT ?? 8093);
const BASE = `http://127.0.0.1:${PORT}`;
const SESSION_ID = "agentcore-local-smoke";
/** Space sequential model calls so Bedrock's per-minute throttle is not tripped. */
const REQUEST_SPACING_MS = 1500;

let failures = 0;
let infrastructureFailures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

/** Explicitly distinguish provider-side throttling from a product/model failure. */
function isThrottle(text: string): boolean {
  return /too many requests|throttl|429|rate.?limit/i.test(text);
}

async function invoke(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/invocations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-amzn-bedrock-agentcore-runtime-session-id": SESSION_ID,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** One agent invocation with throttle awareness; never retries semantic failures. */
async function turn(label: string, message: string): Promise<any> {
  await sleep(REQUEST_SPACING_MS);
  const response = await invoke({ message });
  const body = response.body ?? {};
  if (body.ok === false && isThrottle(String(body.error ?? ""))) {
    infrastructureFailures += 1;
    console.log(`THROTTLE — ${label} (${body.error})`);
  }
  return body;
}

async function waitForReady(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/ping`);
      if (res.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  return false;
}

function startDevServer(): ChildProcess {
  // Official local AgentCore path: the CLI runs the entrypoint with the
  // AgentCore protocol and injects PORT/LOCAL_DEV.
  const child = spawn("agentcore", ["dev", "--port", String(PORT), "--logs", "--no-browser"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (d: Buffer) => process.stderr.write(`[dev] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[dev] ${d}`));
  return child;
}

function stopDevServer(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) return;
  try {
    // Negative pid kills the whole process group (agentcore dev → npx tsx → node).
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

let server: ChildProcess | undefined;
try {
  console.log(`Starting local AgentCore dev server on port ${PORT}...`);
  server = startDevServer();
  const ready = await waitForReady(server, 90_000);
  if (!ready) {
    console.log("FAIL — local AgentCore dev server did not become ready");
    process.exitCode = 1;
  } else {
    console.log("PASS — local AgentCore dev server ready (/ping Healthy)");

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

    // 3. Vague decision: the gate must not authorize and nothing may be decided.
    // Safety invariant, not prose: the model may decline to call the tool, or
    // it may attempt an unauthorized call — in which case the deterministic
    // gate must refuse it. Either outcome is safe; a recorded decision is not.
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
    // Independent, deterministic proof that the conflict survived: a fresh
    // state query must route to get_shift_state and still show D104 conflicted.
    const stateCheck = await turn("state query", "What is the current state?");
    const d104 = stateCheck.state?.conflictedItems?.find((i: any) => i.canonicalSubject === "d104");
    check(
      "vague decision: D104 still conflicted in deterministic state",
      stateCheck.toolTrace?.[0]?.tool === "get_shift_state" && Boolean(d104),
      JSON.stringify(d104?.claims?.map((c: any) => c.canonicalValue) ?? stateCheck.result),
    );

    // 4. Explicit human decision: deterministic routing authorizes the gate.
    const explicit = await turn("explicit decision", "Send D104 to claims.");
    check(
      "explicit decision: record_human_decision executed and D104 decided",
      explicit.ok === true &&
        explicit.toolTrace?.[0]?.tool === "record_human_decision" &&
        explicit.toolTrace?.[0]?.status === "success" &&
        explicit.decision?.canonicalValue === "claims" &&
        explicit.item?.status === "decided",
      JSON.stringify(explicit.result ?? explicit.error),
    );

    // 5. Handoff: derived from the deterministic get_handoff projection.
    const handoff = await turn("handoff", "What does the morning shift need to know?");
    const handoffTool = handoff.toolTrace?.[0];
    const handoffData = handoff.handoff;
    check(
      "handoff: get_handoff called and authoritative projection returned",
      handoff.ok === true &&
        handoffTool?.tool === "get_handoff" &&
        handoffTool?.status === "success" &&
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

    // 6. Uninterpretable report: controlled rejection, zero mutation.
    const nonsense = await turn("nonsense report", "the vibes are off today");
    check(
      "nonsense report: report_event attempted and rejected without mutation",
      nonsense.ok === false &&
        nonsense.toolTrace?.[0]?.tool === "report_event" &&
        nonsense.toolTrace?.[0]?.status === "error" &&
        /could not interpret/i.test(String(nonsense.error ?? "")),
      JSON.stringify(nonsense.error ?? nonsense.result),
    );
  }
} finally {
  stopDevServer(server);
  await sleep(500);
}

console.log(
  `\nLocal AgentCore smoke: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s)${
    infrastructureFailures > 0 ? `, ${infrastructureFailures} provider throttle(s)` : ""
  })`,
);
if (failures > 0) process.exitCode = 1;
