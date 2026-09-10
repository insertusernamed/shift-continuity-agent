# AI video prompts

Image-to-video prompts for the six stills in [`stills/`](stills/), for tools such as
Runway, Veo, Pika, or Kling. The final video is **not** generated in this repository;
this file only supplies prompts, camera moves, durations, and placement.

The stills are captured from the real UI on the frozen demo state — see
[`RECORDING_GUIDE.md`](RECORDING_GUIDE.md) to regenerate them and
[`SHOT_LIST.md`](SHOT_LIST.md) for where each one lands in the cut.

**Framing caveat:** stills 1–4 are full-frame **2880×1620 (exactly 16:9)**.
Stills 5 and 6 are **element crops** (`05-handoff.png` is 812×628, `06-photo-evidence.png`
is 1050×252). Do not stretch them. Either matte them onto a neutral 16:9 background, or
use them as punch-ins inside the full-frame screen recording.

---

## 1. `stills/01-hero-and-agent.png` — 2880×1620, 16:9

- **Shows:** Header, one-sentence explanation, status legend, agent entry point.
- **16:9 usage:** Native. This is the establishing shot; use it full-frame.
- **Duration:** 5 s
- **Motion prompt:** *"Static UI screenshot of a clean operational dashboard in a bright browser window. Almost nothing moves: a very slight parallax drift, a soft window reflection sliding slowly across the screen. Text stays perfectly sharp and unwarped."*
- **Camera motion:** Slow push in, 2–3%.
- **Transition:** Fade from black at the start; cut to shot 2 on the beat.
- **Overlay text:** `Shift handoff — only what still matters.`
- **Placement:** **Intro.**

## 2. `stills/02-dashboard-conflict.png` — 2880×1620, 16:9

- **Shows:** Current State with the D104 conflict, its two reported claims, the human-decision buttons.
- **16:9 usage:** Native. Crop the top edge if you want the D104 card centred.
- **Duration:** 6 s
- **Motion prompt:** *"Static UI screenshot. The red conflict card gives one soft pulse and stops. A cursor glides in from the right and hovers over a decision button without clicking. Everything else is still and the text stays crisp."*
- **Camera motion:** Slight pan right, then hold.
- **Transition:** Cross-dissolve from the previous shot.
- **Overlay text:** `Two reports disagree. The engine refuses to pick.`
- **Placement:** **Intro / transition** into the conflict beat.

## 3. `stills/03-tool-trace.png` — 2880×1620, 16:9

- **Shows:** One real agent turn with its monospace tool trace.
- **16:9 usage:** Native. This is the strongest still for a 16:9 frame; consider holding it longer.
- **Duration:** 6 s
- **Motion prompt:** *"Static screenshot of a UI with a dark monospace code panel. A single line of the panel reveals itself left to right, character by character, as if typed; a small green checkmark appears at the end. No other motion, no text distortion."*
- **Camera motion:** Slow push in on the trace panel.
- **Transition:** Cut on the checkmark appearing.
- **Overlay text:** `The agent asks the engine — and shows you the call.`
- **Placement:** **Transition** into the refusal beat.

## 4. `stills/04-decision-recorded.png` — 2880×1620, 16:9

- **Shows:** The same item after the human decision: DECIDED.
- **16:9 usage:** Native. Crop toward the D104 card to emphasise the badge change.
- **Duration:** 4 s
- **Motion prompt:** *"Static UI screenshot. A status badge transitions from red CONFLICT to blue DECIDED with one soft highlight sweep, and the card's border eases from red to blue. Nothing else moves."*
- **Camera motion:** Static with a barely perceptible drift.
- **Transition:** Cut to the handoff on the badge landing.
- **Overlay text:** `A human decided. The event log recorded it.`
- **Placement:** **Transition** — the human-in-the-loop beat.

## 5. `stills/05-handoff.png` — 812×628, element crop

- **Shows:** The handoff after the decision: one action item, zero review items, and the counts.
- **16:9 usage:** Matte onto a neutral background (the app's page colour) inside a 16:9 frame, or place it as a punch-in over the full-frame screen recording. Never stretch to fill.
- **Duration:** 4 s
- **Motion prompt:** *"Static screenshot of a document-style panel on a neutral background. List rows settle into place with a gentle fade and a counter ticks once. Nothing else moves; text remains sharp."*
- **Camera motion:** Slow pull back.
- **Transition:** Fade to black.
- **Overlay text:** `The handoff collapses to the one thing still open.`
- **Placement:** **Outro** — the payoff.

## 6. `stills/06-photo-evidence.png` — 1050×252, element crop

- **Shows:** Photo evidence attached to its event in the append-only history.
- **16:9 usage:** Matte onto a neutral background inside a 16:9 frame, or use as a punch-in. Never stretch.
- **Duration:** 4 s
- **Motion prompt:** *"A small photo thumbnail pinned inside a UI list. The image has a faint handheld micro-shake and a soft scan-line highlight passes over it once. The surrounding UI stays perfectly still and its text stays sharp."*
- **Camera motion:** Slow push in on the thumbnail.
- **Transition:** Whip-free cut back to the wider UI, or dissolve.
- **Overlay text:** `Photos are evidence — interpreted as a note, never as truth.`
- **Placement:** **Transition** during the photo-evidence beat.

---

## Suggested 26-second intro/outro cut

Cinematic intro → product proof → payoff. Order matters more than length.

| Slot | Asset | Caption | Audio / VO |
| --- | --- | --- | --- |
| 0:00–0:04 | Generated cold open (no still) — a dim, empty aisle, one distant light | "Every shift ends the same way." | low ambient hum, one radio squawk |
| 0:04–0:09 | Still 1 + Still 2 (crossfade) | "A pile of events. One contradiction nobody noticed." | VO: "Handover is where the risk hides." |
| 0:09–0:15 | Still 3 (tool trace) | "The agent operates the product — you can see every tool call." | keystroke tick as the trace types |
| 0:15–0:19 | Still 4 | "It refuses to decide for you." | short silence, then a soft click |
| 0:19–0:22 | Still 6 (matted) | "Evidence, interpreted as a note — never as truth." | shutter click |
| 0:22–0:26 | Still 5 (matted) + closing card | "The handoff: only what still matters." | music resolves |

---

## Guardrails

- Never ask a tool to *generate* UI text, dashboards, or code from scratch — only to
  animate the supplied still. Generated text is unreadable and reads as fabricated.
- Prefer "static screen, subtle move" over "camera flies through a holographic
  dashboard". The credibility of this project is that the screens are real.
- Keep captions as separate overlays, not baked into the generated video, so they stay
  sharp and can be corrected without a re-render.
- Keep motion subtle and short. A wobbling UI reads as fake, and most tools add
  compression artefacts to text when the frame moves.
- If a tool invents charts, counters, agent chatter, or extra panels, re-roll that clip.
- If a clip implies durable persistence or production readiness, cut it. See the
  "Persistence" section of the README for exactly what the deployment keeps.
