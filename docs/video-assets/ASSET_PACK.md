# AI video asset pack

Asset **inventory** for the submission: which still exists, what it shows, and the
caption it carries. The final video is **not** generated in this repository.

- Motion prompts, durations, camera moves, and intro/outro placement → [AI_VIDEO_PROMPTS.md](../AI_VIDEO_PROMPTS.md).
- Shot order, narration, and framing → [SHOT_LIST.md](../SHOT_LIST.md).
- Commands, viewport, and the frozen demo state → [RECORDING_GUIDE.md](../RECORDING_GUIDE.md).

Regenerate the stills at any time (the bytes are deterministic for a given demo state):

```bash
# 1. reset the store to the frozen demo state
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts

# 2. start the local app against that data
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence PORT=7799 npm start

# 3. drive headless Chrome and capture docs/stills/*.png
BASE_URL=http://127.0.0.1:7799 npx tsx scripts/captureScreenshots.ts

# 4. reset again — the capture records the human decision, which the take must not inherit
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts
```

Captures are 1440×810 CSS px (exactly 16:9) at 2× density — **2880×1620 PNGs** — except the
two element-clipped stills, which are 2× their section size. Requires Google Chrome
(`CHROME_PATH` overrides the default location).

## Stills

| # | File | Shows | Suggested on-screen caption |
| --- | --- | --- | --- |
| 1 | [`../stills/01-hero-and-agent.png`](../stills/01-hero-and-agent.png) | Title, one-sentence explanation, status legend, agent entry point | "Shift handoff: only what still matters." |
| 2 | [`../stills/02-dashboard-conflict.png`](../stills/02-dashboard-conflict.png) | Current State with the D104 conflict, its two reported claims, and the human-decision buttons | "Two reports disagree. The engine refuses to pick." |
| 3 | [`../stills/03-tool-trace.png`](../stills/03-tool-trace.png) | One real agent turn with its tool trace (`✓ get_handoff → …`) | "The agent asks the engine — and shows you the call." |
| 4 | [`../stills/04-decision-recorded.png`](../stills/04-decision-recorded.png) | The same item after the human decision: DECIDED, attributed to **Shift Supervisor**, with the labelled **Reopen decision** action and its optional reason field | "A human decided — and it is attributed. The event log recorded it." |
| 5 | [`../stills/05-handoff.png`](../stills/05-handoff.png) | The handoff after the decision: one action item, no review items | "The handoff collapses to the one thing still open." |
| 6 | [`../stills/06-photo-evidence.png`](../stills/06-photo-evidence.png) | Photo evidence attached to its event in the append-only history | "Photos are evidence — interpreted as a note, never as truth." |
| 7 | [`../stills/07-decision-reopened.png`](../stills/07-decision-reopened.png) | The same item after the decision is **reopened**: back to CONFLICT, the reopened claim still visible, the reopen attributed with its reason, and the claim buttons available again | "Undo is an append, not a rewrite: the decision stays on the record." |

Asset 6 uses a **placeholder** image drawn in code by `scripts/seedDemo.ts`. Swap in a
real photo of a damaged carton or a blocked aisle before the final render.

## Motion prompts and intro/outro cut

Moved to [AI_VIDEO_PROMPTS.md](../AI_VIDEO_PROMPTS.md): one row per still with the tool
prompt, camera motion, duration, transition, overlay text, and intro/transition/outro
placement, plus a suggested 26-second cut and the motion-prompt guardrails. Stills 5 and 6
are element crops rather than 16:9, so that file also covers how to matte them. Still 7 is
for the optional reopen beat (see `docs/RECORDING_GUIDE.md`); the main cut does not need it.

## What the pack deliberately excludes

No generated "assistant avatar", no synthetic voice clones, no footage of a real named
warehouse or employer, and no claim of production readiness. If a clip implies durable
production readiness, cut it — see the "Persistence" section
of the README for exactly what the deployment does and does not keep.
