# Recording guide

Everything needed to record the demo against the frozen UI. Nothing here is a mock-up:
these commands run the real deterministic engine, and optionally the real Bedrock agent.

The spoken script and shot-by-shot plan live in [`SHOT_LIST.md`](SHOT_LIST.md).
The static assets live in [`stills/`](stills/) and are described in
[`AI_VIDEO_PROMPTS.md`](AI_VIDEO_PROMPTS.md).

---

## 1. What you need

- Node 20+ (`node --version`) and npm.
- Google Chrome, for `scripts/captureScreenshots.ts`. `CHROME_PATH` overrides the
  default macOS location.
- For the live agent: the `shift-handoff` AWS profile with Bedrock access (see the
  AgentCore section of the README). No keys are stored in the repo.

Offline mode needs no network and no AWS account. The tool trace still appears — the
deterministic runner answers instead of the model.

## 2. Viewport lock

Record at **1440×810 CSS px — exactly 16:9 — with the browser at 100% zoom.**

Why this size: the app column is 1140px wide, so at 1440 it fills ~83% of the frame
instead of sitting in wide margins. Body text then lands at roughly 19px in a 1920×1080
timeline, which stays legible on a laptop and on a phone.

- In Chrome, size the content area to 1440×810 and confirm zoom is 100% (`Cmd`/`Ctrl`+`0`).
- The repo's stills are captured at 2× device scale, so each PNG is **2880×1620**. In a
  1920×1080 timeline that is a 66% scale; you can punch in up to ~1.3× before it softens.
- If you must record at 1920×1080 instead, keep zoom at 100%. The layout simply gains
  side margin; nothing breaks.

## 3. Reset the demo state — before every take

```bash
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts
```

This wipes the JSON store and the evidence directory, seeds the frozen scenario through
the same code path the app uses, and **exits non-zero if the resulting state does not
match the recorded scenario**. Any other `DATA_FILE`/`EVIDENCE_DIR` pair works, but the
same pair must be used for the app.

## 4. Start the app

Offline (deterministic runner, no AWS):

```bash
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence PORT=7799 npm start
```

Live agent (recommended for the video):

```bash
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence PORT=7799 \
  BEDROCK_AGENT=1 AGENT_MODEL_PROVIDER=bedrock \
  AGENT_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0 \
  AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 npm start
```

Pass `AGENT_MODEL_ID` explicitly: with `AGENT_MODEL_PROVIDER=bedrock` and no model id the
default is Nova Lite (`ca.amazon.nova-lite-v1:0`), which is not the model the recorded
takes were validated against. The port is only a suggestion — keep it consistent with
`BASE_URL` in step 10.

## 5. Open the app

```
http://127.0.0.1:7799/?present=1
```

`?present=1` hides the shift admin and the manual event editor, so on camera you see only
the operator-facing product. Drop the query string if you want to show the manual editor.

## 6. What the frozen state contains

Nine events, five items:

| Item | Outcome |
| --- | --- |
| Aisle 7 | RESOLVED — reported blocked 02:11Z, cleared 03:04Z |
| Pallet 83 | RESOLVED — blocked by aisle 7 at 02:37Z, completed 03:21Z |
| Aisle 12 | RESOLVED — photo report 04:02Z, cleared 04:35Z |
| Freezer inspection | **OPEN** — missed at 04:46Z |
| Damaged case D104 | **CONFLICT** — "send to claims" 05:02Z vs "discarded" 05:14Z |

One photo-evidence attachment is already stored, on the Aisle 12 report.

> The UI renders each event's time in your machine's local timezone, so the on-screen
> clock differs from the UTC values above. That is expected; the ordering is what matters.

## 7. Order of interactions

Run these in order. The "Keep in frame" column says what should be visible on camera.

| # | Action / exact text | Expected visible result | Keep in frame | Still |
| --- | --- | --- | --- | --- |
| 1 | (already loaded) — do not type anything | Header, one-sentence explanation, status legend (OPEN / CONFLICT / DECIDED / RESOLVED), agent entry point | Header + **Talk to the shift agent** | `01-hero-and-agent.png` |
| 2 | Scroll to **Event history** — do not type | The routine reports and their resolutions are already folded: Aisle 7 reported then cleared, Pallet 83 reported then completed, Aisle 12 reported by photo then cleared | **Event history** | — |
| 3 | In **Report → Photo evidence**: **Choose File**, pick your photo, note `Aisle 12 is blocked.`, **Attach photo** | Inline success; Aisle 12 becomes **OPEN**; the thumbnail and note appear in Event history | **Report** panel + start of **Event history** | `06-photo-evidence.png` |
| 4 | Type `Aisle 12 is clear now.` → **Send** | Trace shows `report_event` (cleared); Aisle 12 returns to RESOLVED, so the final handoff stays clean | Agent panel + **Tool trace** | — |
| 5 | Scroll to **Current state** — do not type | Damaged case D104 shows **CONFLICT** with both reported claims and the "Human decision required" callout with two buttons | **Current state** panel | `02-dashboard-conflict.png` |
| 6 | Type `Just pick whichever makes sense for D104.` → **Send** | Reply says the conflict needs a human; trace contains **no** `record_human_decision`; D104 still CONFLICT | **Tool trace** | `03-tool-trace.png` |
| 7 | Type `Send D104 to claims.` → **Send** | Trace shows `record_human_decision` succeeding; D104 becomes **DECIDED** | **Tool trace**, then **Current state** | `04-decision-recorded.png` |
| 8 | Type `What does the morning shift need to know?` → **Send** | Reply comes from `get_handoff`; handoff shows **Requires action 1** (freezer inspection) and **Requires human review 0** | **Handoff** panel | `05-handoff.png` |

Steps 3–4 are the live report → resolution beat, and the demonstration of photo
evidence: the note is interpreted like any typed report, goes through the same
validation, lands in the append-only log, and the image is stored and attached to the
event. Aisle 12 is used deliberately — it is already resolved in the frozen state, so
re-reporting and clearing it leaves the final handoff identical to `05-handoff.png`
(3 resolved, 1 decided).

If Bedrock throttles or you are short on time, steps 3–4 are the ones to drop. The seeded
state already contains a photo-evidence report, so the feature still appears in Event
history and in `06-photo-evidence.png`.

Steps 6 and 7 are the safety story and must not be skipped: the agent must refuse with no
decision tool, and the explicit sentence must authorize the decision.

### Optional ninth beat — reopen the decision (secondary, ~25s)

The main 3:45 script above stays as it is. If you have room, this beat proves the audit
trail is reversible without being destroyed, and it has its own still:

| # | Action / exact text | Expected visible result | Keep in frame | Still |
| --- | --- | --- | --- | --- |
| 9 | On the DECIDED D104 card, type `Claims ticket was created in error` in **Reason (optional)** and press **Reopen decision** | D104 returns to **CONFLICT**; the card shows the reopened (superseded) decision and `Reopened by Shift Supervisor — "Claims ticket was created in error"`; the two claim buttons come back; the confirmation reads *Decision reopened…* | **Current state**, D104 card | `07-decision-reopened.png` |

Then re-record the decision with **Send D104 to claims.** so the handoff returns to its
frozen shape (3 resolved, 1 decided). If you take this beat, say the line plainly: *the
original decision is not deleted — a reopen appends an event, and the item needs a new
human choice.*

Everything on the card is attributed to whoever is named in **Acting as** (default
`Shift Supervisor`). That field is on camera on purpose: it is where the human identity a
decision is recorded under comes from.

## 8. Framing

- At 1440 wide the page is two columns: left = **Talk to the shift agent** + **Report**,
  right = **Current state** + **Handoff**. **Event history** spans the full width.
- Scroll anchors, if you drive the page by script: `#agentSection`, `#stateSection`,
  `#handoffSection`, `#historySection`.
- Close crops that work well: the D104 card in the right column, and the monospace trace
  directly under the agent reply.
- Hide the browser bookmarks bar before recording; it costs about 30px of frame and adds
  visual noise the judges do not need.

## 9. Between takes

Re-run step 3. The decision button and the capture script both mutate the store, so never
start a second take from the previous take's state. `resetDemo.ts` is the only supported
way to get back to the recorded starting point.

## 10. Capture the stills

With the app running from step 4:

```bash
BASE_URL=http://127.0.0.1:7799 npx tsx scripts/captureScreenshots.ts
```

Writes the seven PNGs into `docs/stills/`. It records the human decision by clicking the
UI's own decision button, so **re-run step 3 afterwards** to leave the store pristine.

Open `docs/stills/gallery.html` in a browser to review all seven at once — it uses relative
paths, so it works straight from the filesystem with no server.

## 11. Known recording risks

- **Bedrock throttling.** Space agent turns ~20–30 seconds apart; the 3:45 cut does this
  naturally. A 429 is a provider limit, not a product failure — pause and redo the beat.
  Do not add retries to make a flaky take look green.
- **Persistence.** The local app writes a JSON file, so state survives a restart on the
  recording machine but is not shared beyond it. The deployed AgentCore runtime keeps its
  event log in DynamoDB; see the README "Persistence" section for exactly what is and is
  not durable.
- **The seeded photo is a placeholder** drawn in code by `scripts/seedDemo.ts`. Attach a
  real photo of a damaged carton or a blocked aisle before the final take.

## 12. Verify the setup before you roll

```bash
npm test          # all tests, network-free
npm run typecheck
```

Both must pass. If they do not, fix that first — a recording made against a broken tree
is wasted work.
