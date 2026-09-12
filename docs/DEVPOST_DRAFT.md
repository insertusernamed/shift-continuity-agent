# Devpost draft

## Elevator pitch

**Shift Handoff** is an agent that turns a messy pile of shift events into a handoff
containing only what still matters — and it refuses to decide a conflict for you. The
model runs the tools; a deterministic domain engine owns the truth.

## The problem

Shift handovers leak. During one shift, problems get reported, cleared, re-reported, and
sometimes contradicted. The incoming shift gets either too much (forty events, no
signal) or too little (the one contradiction nobody noticed). The expensive failures —
a damaged case shipped because two reports disagreed about it, a missed inspection
forgotten entirely — are exactly the things a naive summary drops.

## Who it is for

Shift leads and logistics supervisors in warehouses, plant operations, and clinical
handovers: any environment where work is continuous, reporting is informal, and the
handover is the riskiest five minutes of the day.

## Why an agent matters here

Reporting is natural language. People say *"pallet 83 couldn't go out because aisle 7 is
blocked"*, not `{kind: problem_reported, blockedBy: aisle_7}`. An LLM is the right tool
for that one step — interpreting a sentence — and the wrong tool for everything else.

So the architecture is strict about it:

- **The model interprets and operates; it never owns state.** Current state is computed
  by folding an append-only event log. If the agent wants to know something, it calls a
  tool.
- **The model cannot resolve conflicts — or undo decisions.** `record_human_decision`
  and `reopen_human_decision` both require explicit authorization present in
  `invocationState`, populated deterministically from the human's actual words before the
  model runs. "Just pick whichever makes sense for D104" authorizes nothing; "was D104
  decided correctly?" is a question, not an instruction to reopen; the gates refuse even
  if the model tries. Who authorized a human action, and why, come from the application
  context — the reopen tool takes no actor argument, so the model cannot invent one.
- **Nothing bypasses validation.** The interpreter proposes; strict local schema
  validation disposes. A provider failure is a controlled error with zero state change.
- **The system works with the LLM off.** The default interpreter is deterministic, so
  every test and the whole product run offline.

The result is an agent you can actually put in front of a shift change: it is flexible
where language is messy, and uncompromising where operational truth is at stake.

## Key features

- **Deterministic handoff projection** — open work, unresolved problems, conflicts, and
  human-decision items only. Resolved work is a count, not clutter; history is retained
  but never repeated.
- **Chronological fold with conflict visibility** — contradictory claims on one subject
  stay conflicted until a human reconciles them; a later report can never silently win.
- **Model-independent human-decision gate** — authorization for `record_human_decision`
  is detected deterministically from the current request (subject + explicitly selected
  known claim) and re-checked inside the tool.
- **Append-only decision provenance and reopen** — a decision records who made it
  (`actor`) and an optional note; it is undone only by appending `decision_reopened`,
  which returns the item to conflict while the superseded decision stays on the record.
  Human decisions and reopen actions are append-only, attributed, and auditable.
- **Natural-language reporting with a validated interpreter boundary** — deterministic
  baseline by default; optional LLM (`EventInterpreter`) whose output is schema-checked,
  with identity fields structurally forbidden.
- **Photo evidence** — attach an image plus a short note; the note rides the same
  interpretation/validation pipeline while the image is preserved as evidence metadata
  on the event and rendered in history.
- **Tool trace on every agent turn** — the UI and the AgentCore envelope both report
  which tool ran and whether it succeeded, so "the agent is really operating the
  product" is visible, not asserted.
- **One agent, two hosts** — the identical Strands agent runs locally and on Amazon
  Bedrock AgentCore Runtime (CodeZip), with per-session state and no duplicated logic.
- **309 automated tests, all network-free** — no credentials, no accounts, no live LLM
  required for the suite, including WCAG AA contrast math checked against the rendered
  design tokens.

## Tech stack

- **TypeScript (strict)** on **Node.js 22+**, `node:test` via `tsx`, no build step for
  the UI.
- **Strands Agents SDK** (`@strands-agents/sdk`) for the agent loop and typed tools.
- **Amazon Bedrock** for the model — Claude Haiku 4.5
  (`global.anthropic.claude-haiku-4-5-20251001-v1:0`) over the Converse API, with an
  explicit provider switch (`AGENT_MODEL_PROVIDER`) that also supports OpenAI models on
  the bedrock-runtime OpenAI-compatible Responses endpoint.
- **Amazon Bedrock AgentCore Runtime** for hosting (`@aws/agentcore` CLI, CodeZip, CDK
  under the hood; IAM execution role created by the CLI).
- **node:http + server-rendered vanilla JS UI** — deliberately framework-free at this
  size; no SPA, no build pipeline.
- **JSON-file append-only store** behind a `ShiftStore` interface locally; in-memory
  per-session store on AgentCore.

## What makes it original

Most "agent + operations" demos put the model in the middle and hope. This one puts the
model at the edge and makes the failure modes explicit:

1. **Authority is not a prompt.** Human authority to decide is a data check on the
   current request, evaluated before the model runs and enforced inside the tool. A
   jailbroken prompt cannot produce a decision, and a vague request cannot either.
2. **State can't be hallucinated, only queried.** There is no "summarize the history"
   path. The agent's answers about state come from the same fold the UI renders, so the
   chat and the dashboard can never disagree.
3. **Conflict is first-class, not a summary artifact.** Contradiction is detected by the
   domain, preserved in history, surfaced in the handoff, and closable only by a recorded
   human decision.
4. **The same reasoning is testable offline.** Because interpretation, validation, fold,
   and gating are separable, the interesting behaviors — dependent resolution,
   chronology, unauthorized decisions, uninterpretable reports, photo reports with no
   orphaned bytes — are ordinary unit tests.

## Links

- Architecture (with diagrams): [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- Recording guide (commands, viewport, exact turns): [`docs/RECORDING_GUIDE.md`](./RECORDING_GUIDE.md)
- Shot list for the video: [`docs/SHOT_LIST.md`](./SHOT_LIST.md)
- Demo script (story + 30-second cut): [`docs/DEMO_SCRIPT.md`](./DEMO_SCRIPT.md)
- AI video prompts: [`docs/AI_VIDEO_PROMPTS.md`](./AI_VIDEO_PROMPTS.md)
- Still asset inventory: [`docs/video-assets/ASSET_PACK.md`](./video-assets/ASSET_PACK.md)
- Project README (local run, AgentCore deploy, scope, limitations): [`README.md`](../README.md)
