# Shot list

The shot-by-shot plan for the ~3:45 demo video. Every shot runs against the real app on
the frozen demo state; nothing is a mock-up.

- Commands, viewport, exact agent text, expected results, and framing: [`RECORDING_GUIDE.md`](RECORDING_GUIDE.md).
- Motion prompts for the six stills: [`AI_VIDEO_PROMPTS.md`](AI_VIDEO_PROMPTS.md).
- Stills: [`stills/`](stills/) (2880×1620 PNGs at the locked 1440×810 viewport).

**Total planned runtime: 3:45** (within the 3:00–4:00 target).

---

## Timing at a glance

| Shot | In | Out | Duration | Still |
| --- | --- | --- | --- | --- |
| 1 — Cold open | 0:00 | 0:12 | 0:12 | — |
| 2 — What this is | 0:12 | 0:32 | 0:20 | `01-hero-and-agent.png` |
| 3 — Routine reports resolve | 0:32 | 0:58 | 0:26 | — |
| 4 — Photo evidence | 0:58 | 1:30 | 0:32 | `06-photo-evidence.png` |
| 5 — The conflict | 1:30 | 1:56 | 0:26 | `02-dashboard-conflict.png` |
| 6 — The agent refuses | 1:56 | 2:26 | 0:30 | `03-tool-trace.png` |
| 7 — The human decides | 2:26 | 2:56 | 0:30 | `04-decision-recorded.png` |
| 8 — The handoff | 2:56 | 3:22 | 0:26 | `05-handoff.png` |
| 9 — Where it runs / close | 3:22 | 3:45 | 0:23 | — |

---

## Shot 1 — Cold open

- **Duration:** 0:12
- **What is visible:** No UI yet. A dark title card in the app's own type. Text only.
- **Narration:** *"Every shift ends the same way. Someone hands over a pile of notes — and the one thing that still matters gets buried in it."*
- **Screen action:** Title card; fade from black.
- **Zoom/crop:** n/a. Title card is generated in the editor, same typeface and ink as the app header.
- **Still:** none.

## Shot 2 — What this is

- **Duration:** 0:20
- **What is visible:** The app header: wordmark, one-sentence explanation, status legend, and the agent entry point. The frozen shift is already loaded.
- **Narration:** *"This is a shift handoff agent. Underneath, a deterministic engine folds an append-only event log into operational items — so the handoff contains only what still matters."*
- **Screen action:** Load `http://127.0.0.1:7799/?present=1`. Hold at the top of the page; let the header and legend settle. No typing.
- **Zoom/crop:** Full frame at 1440×810. This is the establishing shot, so nothing is cropped.
- **Still:** `01-hero-and-agent.png`

## Shot 3 — Routine reports resolve

- **Duration:** 0:26
- **What is visible:** Event history, oldest first: Aisle 7 reported blocked, then cleared; Pallet 83 reported blocked by Aisle 7, then completed; Aisle 12 reported with a photo, then cleared.
- **Narration:** *"Nine events. Aisle 7 was blocked at two in the morning and cleared by three — so it is resolved. Pallet 83 was stuck behind it and is done. Nobody has to read any of that at handover."*
- **Screen action:** Scroll to Event History. Slow scroll down the list, pause on the Aisle 12 line so the evidence thumbnail is on screen.
- **Zoom/crop:** Full width. Optional 1.2× punch-in on the Aisle 12 row so the thumbnail reads.
- **Still:** none (the thumbnail motif is `06-photo-evidence.png`).

## Shot 4 — Photo evidence

- **Duration:** 0:32
- **What is visible:** The Report panel's photo-evidence control; then the new Aisle 12 item in Current State; then the attached image in Event history.
- **Narration:** *"Reports are not always text. I attach a photo and one line — 'Aisle 12 is blocked.' The note is interpreted exactly like a typed report: same validation, same event log. The image is stored as evidence on the event, and it never gets to interpret itself."*
- **Screen action:** Choose the photo file, type the note, click **Attach photo**. Pause on the inline success. Scroll to Event history to show the thumbnail. Then type `Aisle 12 is clear now.` and **Send** — the agent records the resolution and the item leaves the handoff.
- **Zoom/crop:** Full frame for the attach; then a 1.3× punch-in on the evidence row (still `06-photo-evidence.png` is a tighter crop of the same element).
- **Still:** `06-photo-evidence.png`

## Shot 5 — The conflict

- **Duration:** 0:26
- **What is visible:** Current State. Damaged case D104 is marked **CONFLICT**, with both reported claims — "send to claims" and "discarded" — and the "Human decision required" callout with two buttons. Freezer inspection shows **OPEN**.
- **Narration:** *"And then the part that actually hurts. Two reports disagree about damaged case D104 — one says send it to claims, one says it was discarded. The engine will not guess. It keeps both claims visible and escalates."*
- **Screen action:** Scroll to Current State. Hover the D104 card; do not click. Let the two claims sit on screen long enough to read.
- **Zoom/crop:** Start full frame, then a slow 1.25× push-in to the D104 card for the last third of the shot.
- **Still:** `02-dashboard-conflict.png`

## Shot 6 — The agent refuses

- **Duration:** 0:30
- **What is visible:** The agent reply and the monospace tool trace underneath it.
- **Narration:** *"So I ask the agent to just sort it out. Watch the trace — it calls the state tool, reads the contradiction back to me, and stops. A human has to choose. The model runs the tools; the domain owns the truth."*
- **Screen action:** Type `Just pick whichever makes sense for D104.` and **Send**. Point the cursor at the trace line. The reply must say the conflict needs a human, and the trace must contain **no** `record_human_decision`.
- **Zoom/crop:** 1.3× punch-in on the trace block (`03-tool-trace.png` is that crop). Keep the reply line above it in frame for context.
- **Still:** `03-tool-trace.png`

## Shot 7 — The human decides

- **Duration:** 0:30
- **What is visible:** The trace after the explicit sentence, then the D104 card changing to **DECIDED**.
- **Narration:** *"Now I decide, in plain words. That is real authorization, so the decision tool is allowed to run and the decision is appended as an ordinary event — validated against the current state."*
- **Screen action:** Type `Send D104 to claims.` and **Send**. Let the trace appear, then scroll to Current State so the badge flips to DECIDED and the review callout disappears.
- **Zoom/crop:** Full frame, then a 1.25× push-in on the D104 card as it changes.
- **Still:** `04-decision-recorded.png`

## Shot 8 — The handoff

- **Duration:** 0:26
- **What is visible:** The Handoff panel: **Requires action 1** — freezer inspection; **Requires human review 0** — no conflicts; and the counts (3 resolved, 1 decided, closed items counted not listed).
- **Narration:** *"And this is the product. One line for morning: the freezer inspection was missed. The conflict is gone, the resolved work is a count, and every event is still in history."*
- **Screen action:** Type `What does the morning shift need to know?` and **Send**. Scroll to Handoff and hold. Do not scroll away — this is the payoff shot.
- **Zoom/crop:** Start at 1.2× on the Handoff panel so the "Requires action 1" line is large; pull back to full frame on the last beat.
- **Still:** `05-handoff.png`

## Shot 9 — Where it runs, and close

- **Duration:** 0:23
- **What is visible:** Either the README's AgentCore deployment section or `agentcore status` output showing the runtime READY, then a closing title card.
- **Narration:** *"Same agent, same tools, same domain — the local app and Amazon Bedrock AgentCore Runtime are two hosts for one  implementation. 254 automated tests, all offline. The deployed runtime keeps its event log in DynamoDB, so state survives a cold start."*
- **Screen action:** Cut to a clean capture of the deployment section. Then fade to the closing card.
- **Zoom/crop:** Full frame; text should be large and unmoving so it stays sharp.
- **Still:** none. Closing card in the app's type: *"Shift Handoff — the model runs the tools. The domain owns the truth."*

---

## Editing notes

- Keep the **tool trace** on screen whenever the agent answers. It is the single most convincing element in the video.
- Do not narrate the implementation. Narrate the shift. Judges remember "the agent refused to pick," not "the fold is deterministic."
- Do not speed up the agent turns; the brief wait is what makes the trace feel real. If a turn throttles, pause and re-record that beat rather than cutting around it.
- Cut the shots in order. The narrative is chronological and the final handoff only makes sense after the decision.
- Shot 4 is the safest shot to drop if the video runs long; the stills still prove the feature.
