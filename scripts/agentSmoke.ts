/** Offline smoke: boots the real server in-process (no AWS), exercises the agent path, prints results. */
import { rmSync } from "node:fs";
import { startServer } from "../src/http/server.ts";
import { awaitReadiness } from "../src/http/readiness.ts";
import { JsonFileShiftStore } from "../src/store/jsonFileStore.ts";
import { resolveAgentModelConfig } from "../src/agent/modelProvider.ts";

// Bedrock mode is opt-in exactly like src/main.ts: BEDROCK_AGENT=1 + the
// normal AWS environment (profile, region, AGENT_MODEL_PROVIDER,
// AGENT_MODEL_ID / legacy BEDROCK_MODEL_ID). Unset = the offline
// deterministic agent; no AWS call ever happens.
const bedrock = process.env.BEDROCK_AGENT === "1" ? {} : undefined;
const agentModelConfig = bedrock ? resolveAgentModelConfig(process.env) : undefined;

const DATA_FILE = "/tmp/shift-agent-smoke.json";
try { rmSync(DATA_FILE, { force: true }); } catch {}

const store = new JsonFileShiftStore(DATA_FILE);
const server = await startServer({ store, port: 7791, bedrock });
// Hoisted so the finally block can close it even on mid-run failure.
let server2: Awaited<ReturnType<typeof startServer>> | undefined;
const base = server.url;
console.log(`Agent mode: ${bedrock && agentModelConfig ? `${agentModelConfig.provider} (${agentModelConfig.modelId} @ ${agentModelConfig.region ?? "region from AWS env"})` : "offline deterministic"}`);

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

function check(label: string, condition: boolean, detail?: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) process.exitCode = 1;
}

try {
  // Seed the demo scenario (open shift, freezer inspection + D104 conflict).
  const demo = await api("POST", "/api/demo-shift");
  const shiftId: string = demo.body.id;
  check("demo shift seeded open", demo.status === 201 && !demo.body.endedAt);

  // Scenario 1: routine report through the agent.
  const report = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Aisle 7 is blocked." });
  check("agent reports routine event", report.status === 200 && report.body.ok === true, JSON.stringify(report.body.response));
  check("tool trace shows report_event", report.body.toolTrace?.[0]?.tool === "report_event" && report.body.toolTrace?.[0]?.status === "success");
  const state1 = await api("GET", `/api/shifts/${shiftId}/state`);
  const aisle = state1.body.items.find((i: any) => i.canonicalSubject === "aisle 7");
  check("deterministic state: aisle 7 open", aisle?.status === "open");

  // Scenario 2: resolution through the agent.
  const clear = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Aisle 7 is clear now." });
  const state2 = await api("GET", `/api/shifts/${shiftId}/state`);
  const aisle2 = state2.body.items.find((i: any) => i.canonicalSubject === "aisle 7");
  check("agent records resolution; aisle 7 resolved", clear.status === 200 && aisle2?.status === "resolved");

  // Scenario 3+4: conflict surfaced, agent refuses to choose. The check is
  // semantic, not prose-exact: no decision tool call, response signals that
  // human input is required, and the item stays conflicted (checked below).
  const vague = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Just pick whichever one makes sense for D104." });
  check("agent refuses autonomous decision", vague.status === 200 && /(conflict|human review|human decision|decision is required|human input)/i.test(vague.body.response), JSON.stringify(vague.body.response));
  check("no decision tool invoked on vague request", !vague.body.toolTrace.some((t: any) => t.tool === "record_human_decision"));
  const state3 = await api("GET", `/api/shifts/${shiftId}/state`);
  const d104 = state3.body.items.find((i: any) => i.canonicalSubject === "d104");
  check("D104 still conflicted", d104?.status === "conflicted");

  // Scenario 5: explicit human decision through the agent, attributed to the
  // acting human the client supplied.
  const explicit = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Send D104 to claims.", actor: "Shift Supervisor" });
  check("explicit decision recorded", explicit.status === 200 && explicit.body.decision?.canonicalValue === "claims", JSON.stringify(explicit.body.response));
  check("tool trace shows record_human_decision", explicit.body.toolTrace?.[0]?.tool === "record_human_decision");
  const state4 = await api("GET", `/api/shifts/${shiftId}/state`);
  const d104b = state4.body.items.find((i: any) => i.canonicalSubject === "d104");
  check("D104 decided via deterministic fold", d104b?.status === "decided" && d104b?.decision?.canonicalValue === "claims");

  // Scenario 8: handoff exactly reflects the deterministic generator.
  const agentHandoff = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "What's left for morning shift?" });
  const directHandoff = await api("GET", `/api/shifts/${shiftId}/handoff`);
  const agentActions = agentHandoff.body.handoff?.requiresAction.map((i: any) => i.canonicalSubject) ?? [];
  const directActions = directHandoff.body.requiresAction.map((i: any) => i.canonicalSubject);
  check("agent handoff equals deterministic handoff", agentHandoff.status === 200
    && JSON.stringify(agentActions) === JSON.stringify(directActions)
    && agentHandoff.body.handoff.requiresHumanReview.length === 0
    && directHandoff.body.requiresHumanReview.length === 0,
    `actions=${JSON.stringify(directActions)}`);

  // Scenario 9: decision provenance and explicit reopen. The agent may only
  // undo a decision the human named, and may never invent who authorized it.
  const reopenWithoutActor = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Reopen D104" });
  check("reopen refused without a named human", reopenWithoutActor.status === 502
    && reopenWithoutActor.body.toolTrace?.[0]?.tool === "reopen_human_decision"
    && reopenWithoutActor.body.toolTrace?.[0]?.status === "error"
    && /human authorization/i.test(reopenWithoutActor.body.error ?? ""),
    JSON.stringify(reopenWithoutActor.body.error ?? reopenWithoutActor.body.response));

  const reopened = await api("POST", `/api/shifts/${shiftId}/agent`, {
    message: "Reopen D104 because the disposal record was wrong",
    actor: "Shift Supervisor",
  });
  check("explicit reopen returns the item to conflict", reopened.status === 200
    && reopened.body.item?.status === "conflicted"
    && reopened.body.toolTrace?.[0]?.tool === "reopen_human_decision",
    JSON.stringify(reopened.body.response));
  check("the superseded decision stays attributed on the item",
    reopened.body.item?.decision?.canonicalValue === "claims" && reopened.body.item?.decision?.actor === "Shift Supervisor");
  const reopenedHandoff = await api("GET", `/api/shifts/${shiftId}/handoff`);
  check("reopened item reappears under human review",
    reopenedHandoff.body.requiresHumanReview.length === 1 && reopenedHandoff.body.decidedDuringShiftCount === 0);

  const redecided = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Send D104 to discard.", actor: "Shift Supervisor" });
  check("a new explicit decision settles it again", redecided.status === 200
    && redecided.body.item?.status === "decided"
    && redecided.body.item?.decision?.canonicalValue === "discard",
    JSON.stringify(redecided.body.response));
  const finalHandoff = await api("GET", `/api/shifts/${shiftId}/handoff`);
  check("decided item leaves human review again",
    finalHandoff.body.requiresHumanReview.length === 0 && finalHandoff.body.decidedDuringShiftCount === 1);

  const trail = await api("GET", `/api/shifts/${shiftId}/events`);
  const humanEvents = trail.body.filter((e: any) => e.kind === "decision_recorded" || e.kind === "decision_reopened");
  check("every human action is attributed in the append-only history",
    humanEvents.length === 3 && humanEvents.every((e: any) => e.actor === "Shift Supervisor"),
    `${humanEvents.length} human events`);
  check("the reopen reason is recorded verbatim",
    humanEvents.some((e: any) => e.kind === "decision_reopened" && e.note === "the disposal record was wrong"));

  // Scenario 6: the agent must route the odd report to report_event and let
  // the validated interpreter reject it — proving the controlled rejection
  // path (no success claim, no mutation), not merely any 502.
  const nonsense = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "the vibes are off today" });
  const nonsenseTrace = nonsense.body.toolTrace?.[0];
  check("uninterpretable report routes to report_event and is rejected", nonsense.status === 502 && nonsense.body.ok === false
    && nonsenseTrace?.tool === "report_event" && nonsenseTrace?.status === "error"
    && /could not interpret/i.test(nonsense.body.error ?? ""),
    JSON.stringify(nonsense.body.error ?? nonsense.body.response));
  const eventsAfter = await api("GET", `/api/shifts/${shiftId}/events`);
  const beforeCount = eventsAfter.body.length;
  check("failed report mutated nothing", nonsense.status === 502 && (await api("GET", `/api/shifts/${shiftId}/events`)).body.length === beforeCount);

  // Restart persistence. close() fully releases the port (including idle
  // keep-alive sockets), and the readiness poll confirms the new instance is
  // answering before any product request — connection errors are tolerated
  // ONLY inside that poll, never around real requests.
  await server.close();
  const store2 = new JsonFileShiftStore(DATA_FILE);
  server2 = await startServer({ store: store2, port: 7791, bedrock });
  await awaitReadiness({ url: server2.url, timeoutMs: 10_000, pollMs: 100 });
  const state5 = await api("GET", `/api/shifts/${shiftId}/state`);
  const d104c = state5.body.items.find((i: any) => i.canonicalSubject === "d104");
  check("decision survives restart", d104c?.status === "decided");
  check("history retained after restart", (await api("GET", `/api/shifts/${shiftId}/events`)).body.length === beforeCount);

  // Original deterministic NL path still works (same restarted server).
  const { body: nlShift } = await api("POST", "/api/shifts", { name: "NL check" });
  const nl = await api("POST", `/api/shifts/${nlShift.id}/events/nl`, { text: "Pallet 83 couldn't go out because aisle 7 is blocked." });
  check("deterministic NL ingestion still works", nl.status === 201 && nl.body.blockedBy === "aisle 7");

} finally {
  await server2?.close();
  await server.close();
}
