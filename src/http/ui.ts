/**
 * Server-rendered shell + vanilla JS client. No framework, no build step
 * (AGENTS.md §4/§9): the PoC needs functional clarity, not polish.
 */

const KIND_OPTIONS = [
  ["problem_reported", "Problem reported"],
  ["cleared", "Cleared / unblocked"],
  ["work_completed", "Work completed"],
  ["status_claimed", "Status claimed (needs claim)"],
  ["decision_recorded", "Decision recorded (needs claim)"],
] as const;

const STATUS_LABELS: Record<string, string> = {
  open: "OPEN",
  resolved: "RESOLVED",
  conflicted: "CONFLICT",
  decided: "DECIDED",
};

export function renderUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shift Handoff</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 820px; padding: 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  button { padding: .35rem .8rem; cursor: pointer; }
  input, select { padding: .3rem; margin: .15rem 0; }
  form { display: grid; gap: .4rem; max-width: 480px; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  ul { padding-left: 1.2rem; } li { margin: .2rem 0; }
  .badge { font-size: .72rem; font-weight: 700; padding: .1rem .4rem; border-radius: .6rem; color: #fff; }
  .badge.open { background: #b45309; } .badge.conflicted { background: #b91c1c; }
  .badge.resolved { background: #6b7280; } .badge.decided { background: #1d4ed8; }
  .card { border: 1px solid #ccc; border-radius: 6px; padding: .6rem .8rem; margin: .4rem 0; }
  .muted { color: #666; } .error { color: #b91c1c; min-height: 1.2em; }
  section { margin-bottom: 1rem; }
</style>
</head>
<body>
<h1>Shift Handoff</h1>

<section>
  <div class="row">
    <select id="shiftSelect"></select>
    <button id="loadBtn">Load</button>
    <input id="newShiftName" placeholder="New shift name">
    <button id="createBtn">Create Shift</button>
    <button id="demoBtn">Load Demo Shift</button>
  </div>
  <p id="shiftMeta" class="muted"></p>
  <p id="error" class="error"></p>
</section>

<section id="eventSection" hidden>
  <h2>Report in plain words</h2>
  <div class="row">
    <input id="nlText" placeholder="Pallet 83 couldn't go out because aisle 7 is blocked" style="flex:1">
    <button id="nlBtn">Add</button>
  </div>
  <p class="muted">Understood shapes: problems with/without cause, cleared, completed, dispositions ("case D104 should go to claims"). Anything else is refused, not guessed.</p>
  <h2>Add Event (structured)</h2>
  <form id="eventForm">
    <div class="row">
      <label>When <input type="datetime-local" id="occurredAt" required></label>
      <label>Kind <select id="kind">${KIND_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    </div>
    <label>Subject <input id="subject" placeholder="aisle 7" required></label>
    <label>Description <input id="description" placeholder="what happened" required></label>
    <label id="claimLabel" hidden>Claim <input id="claim" placeholder="e.g. send to claims"></label>
    <div class="row">
      <label>Blocked by (optional) <input id="blockedBy" placeholder="aisle 7"></label>
      <label>Source <input id="source" value="operator"></label>
    </div>
    <button type="submit">Add Event</button>
  </form>
  <button id="endBtn">End Shift</button>
</section>

<section id="historySection" hidden>
  <h2>EVENT HISTORY</h2>
  <ul id="historyList"></ul>
</section>

<section id="stateSection" hidden>
  <h2>CURRENT STATE</h2>
  <div id="stateList"></div>
</section>

<section id="handoffSection" hidden>
  <h2>HANDOFF</h2>
  <div id="handoffContent"></div>
</section>

<script>
const $ = (id) => document.getElementById(id);
const KINDS_WITH_CLAIM = new Set(["status_claimed", "decision_recorded"]);
const STATUS_LABELS = ${JSON.stringify(STATUS_LABELS)};

let currentShift = null;

function showError(msg) { $("error").textContent = msg || ""; }

async function api(path, options) {
  const res = await fetch(path, options && { ...options, headers: { "content-type": "application/json" } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.status);
  return body;
}

function localNowForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

async function refreshShiftList() {
  const shifts = await api("/api/shifts");
  $("shiftSelect").innerHTML = shifts
    .map((s) => \`<option value="\${s.id}">\${s.name}\${s.endedAt ? " (ended)" : ""}</option>\`)
    .join("");
  if (currentShift) $("shiftSelect").value = currentShift.id;
}

async function loadShift() {
  showError("");
  const id = $("shiftSelect").value;
  if (!id) return;
  const [state, handoff] = await Promise.all([api(\`/api/shifts/\${id}/state\`), api(\`/api/shifts/\${id}/handoff\`)]);
  currentShift = state.shift;

  const ended = Boolean(currentShift.endedAt);
  $("shiftMeta").textContent = \`\${currentShift.name} — started \${fmt(currentShift.startedAt)}\${ended ? " — ended " + fmt(currentShift.endedAt) : ""}\`;
  $("eventSection").hidden = ended;
  $("endBtn").disabled = ended;

  $("historySection").hidden = false;
  $("historyList").innerHTML = state.events
    .map((e) => \`<li><strong>\${fmt(e.occurredAt)}</strong> \${esc(e.subject)} — \${esc(e.description)} <span class="muted">[\${e.kind}]\${e.claim ? " claim: " + esc(e.claim) : ""}</span></li>\`)
    .join("") || "<li class='muted'>No events yet.</li>";

  $("stateSection").hidden = false;
  $("stateList").innerHTML = state.items
    .map((i) => itemCard(i, false))
    .join("") || "<p class='muted'>No operational items yet.</p>";

  $("handoffSection").hidden = false;
  $("handoffContent").innerHTML = renderHandoff(handoff);
}

function itemCard(i) {
  const claims = (i.claims || []).map((c) => \`<li>\${esc(c.value)} <span class="muted">(\${fmt(c.occurredAt)})</span></li>\`).join("");
  const decision = i.decision ? \`<p><strong>Decision:</strong> \${esc(i.decision.value)}</p>\` : "";
  return \`<div class="card"><strong>\${esc(i.subject)}</strong> <span class="badge \${i.status}">\${STATUS_LABELS[i.status] || i.status}</span>
    <p>\${esc(i.description)}</p>\${claims ? "<ul>" + claims + "</ul>" : ""}\${decision}\${i.blockedByCanonicalSubject ? \`<p class="muted">blocked by: \${esc(i.blockedByCanonicalSubject)}</p>\` : ""}</div>\`;
}

function renderHandoff(h) {
  const action = h.requiresAction.map((i) => \`<li>\${esc(i.subject)} — \${esc(i.description)}</li>\`).join("");
  const review = h.requiresHumanReview.map((i) =>
    \`<li>\${esc(i.subject)}: conflicting reports — \${i.claims.map((c) => "“" + esc(c.value) + "”").join(" vs ")} — requires human review</li>\`).join("");
  return \`
    <h3>Requires action</h3>
    \${action ? "<ul>" + action + "</ul>" : "<p class='muted'>Nothing outstanding.</p>"}
    <h3>Requires human review</h3>
    \${review ? "<ul>" + review + "</ul>" : "<p class='muted'>No conflicts.</p>"}
    <p class="muted">Resolved during shift: \${h.resolvedDuringShiftCount} · Decided: \${h.decidedDuringShiftCount}</p>\`;
}

function fmt(iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("kind").addEventListener("change", () => { $("claimLabel").hidden = !KINDS_WITH_CLAIM.has($("kind").value); });

$("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  try {
    await api(\`/api/shifts/\${currentShift.id}/events\`, {
      method: "POST",
      body: JSON.stringify({
        occurredAt: new Date($("occurredAt").value).toISOString(),
        kind: $("kind").value,
        subject: $("subject").value,
        description: $("description").value,
        claim: $("claim").value || undefined,
        blockedBy: $("blockedBy").value || undefined,
        source: $("source").value || "operator",
      }),
    });
    $("eventForm").reset();
    $("source").value = "operator";
    $("occurredAt").value = localNowForInput();
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("createBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api("/api/shifts", { method: "POST", body: JSON.stringify({ name: $("newShiftName").value }) });
    $("newShiftName").value = "";
    await refreshShiftList();
    $("shiftSelect").selectedIndex = 0;
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("demoBtn").addEventListener("click", async () => {
  showError("");
  try {
    const shift = await api("/api/demo-shift", { method: "POST" });
    currentShift = shift;
    await refreshShiftList();
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("loadBtn").addEventListener("click", loadShift);

$("nlBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api(\`/api/shifts/\${currentShift.id}/events/nl\`, {
      method: "POST",
      body: JSON.stringify({ text: $("nlText").value, occurredAt: new Date($("occurredAt").value).toISOString() }),
    });
    $("nlText").value = "";
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("endBtn").addEventListener("click", async () => {
  showError("");
  try {
    await api(\`/api/shifts/\${currentShift.id}/end\`, { method: "POST" });
    await loadShift();
  } catch (err) { showError(err.message); }
});

$("occurredAt").value = localNowForInput();
refreshShiftList().then(loadShift).catch(() => {});
</script>
</body>
</html>`;
}
