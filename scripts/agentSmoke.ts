/** Offline smoke: boots the real server in-process (no AWS), exercises the agent path, prints results. */
import { rmSync } from "node:fs";
import { startServer } from "../src/http/server.ts";
import { JsonFileShiftStore } from "../src/store/jsonFileStore.ts";

const DATA_FILE = "/tmp/shift-agent-smoke.json";
try { rmSync(DATA_FILE, { force: true }); } catch {}

const store = new JsonFileShiftStore(DATA_FILE);
const server = await startServer({ store, port: 7791 });
const base = server.url;

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

  // Scenario 3+4: conflict surfaced, agent refuses to choose.
  const vague = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Just pick whichever one makes sense for D104." });
  check("agent refuses autonomous decision", vague.status === 200 && /human decision is required/i.test(vague.body.response), JSON.stringify(vague.body.response));
  check("no decision tool invoked on vague request", !vague.body.toolTrace.some((t: any) => t.tool === "record_human_decision"));
  const state3 = await api("GET", `/api/shifts/${shiftId}/state`);
  const d104 = state3.body.items.find((i: any) => i.canonicalSubject === "d104");
  check("D104 still conflicted", d104?.status === "conflicted");

  // Scenario 5: explicit human decision through the agent.
  const explicit = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "Send D104 to claims." });
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

  // Scenario 6: tool failure — no success claim, no mutation.
  const nonsense = await api("POST", `/api/shifts/${shiftId}/agent`, { message: "the vibes are off today" });
  check("uninterpretable report surfaces tool failure", nonsense.status === 502 && nonsense.body.ok === false, JSON.stringify(nonsense.body.error ?? nonsense.body.response));
  const eventsAfter = await api("GET", `/api/shifts/${shiftId}/events`);
  const beforeCount = eventsAfter.body.length;
  check("failed report mutated nothing", nonsense.status === 502 && (await api("GET", `/api/shifts/${shiftId}/events`)).body.length === beforeCount);

  // Restart persistence.
  server.close();
  const store2 = new JsonFileShiftStore(DATA_FILE);
  const server2 = await startServer({ store: store2, port: 7791 });
  const state5 = await api("GET", `/api/shifts/${shiftId}/state`);
  const d104c = state5.body.items.find((i: any) => i.canonicalSubject === "d104");
  check("decision survives restart", d104c?.status === "decided");
  check("history retained after restart", (await api("GET", `/api/shifts/${shiftId}/events`)).body.length === beforeCount);

  // Original deterministic NL path still works (same restarted server).
  const { body: nlShift } = await api("POST", "/api/shifts", { name: "NL check" });
  const nl = await api("POST", `/api/shifts/${nlShift.id}/events/nl`, { text: "Pallet 83 couldn't go out because aisle 7 is blocked." });
  check("deterministic NL ingestion still works", nl.status === 201 && nl.body.blockedBy === "aisle 7");

  server2.close();
} finally {
  server.close();
}
