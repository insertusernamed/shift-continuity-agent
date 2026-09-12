# Demo script

The story and the short cut. The **full shot-by-shot plan** — durations, narration,
screen actions, crops, and still mapping — is in [`SHOT_LIST.md`](SHOT_LIST.md).
Commands, the locked viewport, the exact agent text for every turn, and what should be on
screen after each one are in [`RECORDING_GUIDE.md`](RECORDING_GUIDE.md).

Everything runs against the real app with the real agent; nothing here is a mock-up.

## Setup

Run the two commands in [`RECORDING_GUIDE.md`](RECORDING_GUIDE.md) §3–§4 — reset the
frozen demo state, then start the app against it — and open
`http://127.0.0.1:7799/?present=1`.

Without Bedrock the same script works offline: the agent answers from the deterministic
runner instead of the model, and the tool trace still appears.

Have a photo ready on the desktop (a damaged carton, a blocked aisle — anything real).
Rename it `aisle12-blocked.png` if you want it to match the sample stills. The photo
shipped in the seed is a code-drawn placeholder, so swap in a real one before the final take.

## The story in one line

> A shift's events are messy. The handoff should contain only what still matters — and
> when two reports contradict each other, only a human may decide.

## 30-second cut

Record the 30-second cut if the submission form limits you; otherwise use the 3:45 plan in
[`SHOT_LIST.md`](SHOT_LIST.md).

| Time | On screen | Say |
| --- | --- | --- |
| 0:00 | Header + status key | "Every shift ends with a handoff. Most of it is noise, and the one contradiction nobody noticed is the part that hurts." |
| 0:06 | State is already seeded ([`RECORDING_GUIDE.md`](RECORDING_GUIDE.md) §3) | "A night shift: nine events — a blocked aisle, work that finished, a photo report, a missed freezer inspection, and one damaged case with two conflicting reports." |
| 0:12 | Scroll to **Current state** | "The deterministic engine already resolved what events closed, and it flags D104 as conflicted. Not a guess — a fold over the append-only log." |
| 0:18 | Type *"What should we do with D104?"* → Send, point at the tool trace | "The agent asks the engine for state. It reads the conflict back to me and refuses to choose." |
| 0:24 | Click **send to claims**, then show **Handoff** | "I decide. The conflict closes, and the handoff collapses to the one thing that is actually still open: the freezer inspection." |
| 0:29 | Cut | "The model runs the tools. The domain owns the truth." |

## The full plan in five beats

1. **Initial shift** — reset the frozen state and open the operator view.
2. **Routine reports and resolutions** — show the event log, where Aisle 7 and Pallet 83
   were reported and already resolved.
3. **Photo evidence** — attach a photo with the note `Aisle 12 is blocked.`, watch it
   become an event with the image stored as evidence, then resolve it with
   `Aisle 12 is clear now.`
4. **The conflict, and the refusal** — D104 shows CONFLICT with two reported claims. Ask
   the agent to pick one; it refuses and calls no decision tool.
5. **The human decision, then the handoff** — `Send D104 to claims.` authorizes the
   decision; the handoff collapses to the one open item, the missed freezer inspection.

**Optional sixth beat (secondary).** On the DECIDED D104 card, put
`Claims ticket was created in error` in **Reason (optional)** and click **Reopen decision**.
D104 returns to CONFLICT with the superseded decision still on the record and the reopen
attributed to whoever is named in **Acting as**; click **send to claims** to settle it again.
This is the audit-trail beat — a decision is undone by appending, never by rewriting. The
main 3:45 script does not need it; see the optional shot in
[`SHOT_LIST.md`](SHOT_LIST.md) and the optional ninth beat in
[`RECORDING_GUIDE.md`](RECORDING_GUIDE.md).

Narration, timings, framing, and which still belongs to each beat: [`SHOT_LIST.md`](SHOT_LIST.md).

## Delivery notes

- Keep the pointer on the **tool trace** whenever the agent answers — it is the most
  convincing thing on screen.
- Do not narrate the implementation; narrate the shift. Judges remember "the agent
  refused to pick", not "the fold is deterministic".
- If Bedrock throttles mid-recording, that is a provider limit, not a product failure:
  pause 60 seconds and re-record that beat.
- Font size: the app column is 1140px wide, so record at 1440×810 with the browser at
  100% zoom (see [`RECORDING_GUIDE.md`](RECORDING_GUIDE.md) §2).
