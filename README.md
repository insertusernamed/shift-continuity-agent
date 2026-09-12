# Shift Handoff — autonomous shift handoff system (PoC)

Tracks operational events during a work shift and, at handoff time, surfaces **only
what still matters to the incoming shift**: unresolved work, unresolved problems,
conflicting information, and items requiring a human decision. Resolved history is
retained but never clutters the handoff.

Read [AGENTS.md](./AGENTS.md) before changing this repository — it is binding.

## The problem, in one minute

Shift handovers leak. Over one shift, problems get reported, cleared, re-reported, and
sometimes contradicted. The incoming shift gets either too much (forty events, no
signal) or too little (the one contradiction nobody noticed). The expensive failures — a
damaged case shipped because two reports disagreed, a missed inspection forgotten
entirely — are exactly what a naive summary drops.

**Who it is for:** shift leads and logistics supervisors in warehouses, plant
operations, and clinical handovers — anywhere work is continuous, reporting is informal
(radio, scanner, a photo), and the handover is the riskiest five minutes of the day.

**Why an agent:** reporting is natural language, so a model is the right tool for
interpreting a sentence and the wrong tool for owning state. This project splits those
jobs deliberately: the agent operates the product through tools, and a deterministic
engine owns operational truth. Concretely — the agent cannot invent current state (it
must query it), cannot decide a conflict on its own (the authorization gate is
model-independent), and cannot mutate anything bypassing validation and the append-only
log. The domain reasoning has no LLM, database, or web framework in its dependency path.

**Docs:** [architecture + diagrams](./docs/ARCHITECTURE.md) ·
[recording guide](./docs/RECORDING_GUIDE.md) ·
[shot list](./docs/SHOT_LIST.md) ·
[demo script](./docs/DEMO_SCRIPT.md) ·
[AI video prompts](./docs/AI_VIDEO_PROMPTS.md) ·
[still asset pack](./docs/video-assets/ASSET_PACK.md) ·
[Devpost draft](./docs/DEVPOST_DRAFT.md) ·
[MIT license](./LICENSE)

## Demo in one minute

```bash
npm install
npm run dev        # http://127.0.0.1:7787  (add BEDROCK_AGENT=1 for the real Bedrock model)
```

Then, in the UI: **Load Demo Shift** → look at **Current State** → ask the agent
*“What should we do with D104?”* (it refuses to decide) → click the human decision button
on D104 → look at **Handoff**. It now contains one line: the missed freezer inspection.
`?present=1` hides the editor chrome for recordings and screenshots. The narrated script
is in [`docs/DEMO_SCRIPT.md`](./docs/DEMO_SCRIPT.md); the exact commands and the
shot-by-shot plan are in [`docs/RECORDING_GUIDE.md`](./docs/RECORDING_GUIDE.md) and
[`docs/SHOT_LIST.md`](./docs/SHOT_LIST.md).

## Run locally

Requires Node.js 22+.

```bash
npm install
npm run dev        # dev server with auto-reload at http://127.0.0.1:7787
```

Other commands:

```bash
npm test           # full test suite (node:test via tsx), network-free
npm run typecheck  # strict TypeScript, no emit
npm start          # run once without file watching

npx tsx scripts/agentSmoke.ts            # LOCAL APP smoke (offline; set BEDROCK_AGENT=1 for live Bedrock)
npx tsx scripts/agentCoreLocalSmoke.ts   # local AgentCore smoke (needs the agentcore CLI + AWS credentials)
npx tsx scripts/agentCoreRemoteSmoke.ts  # deployed AgentCore runtime smoke (see AgentCore deployment)
npx tsx scripts/dynamoPersistenceCheck.ts  # read the deployed DynamoDB event log (needs AWS creds)
npx tsx scripts/resetDemo.ts             # reset + verify the frozen demo state for a recording take
npx tsx scripts/seedDemo.ts              # seed demo data without wiping (+ one photo-evidence report)
npx tsx scripts/captureScreenshots.ts    # capture docs/stills/*.png from a running app (headless Chrome)
```

Configuration (optional): `PORT` (default 7787), `DATA_FILE` (default `data/shifts.json`),
`EVIDENCE_DIR` (default `data/evidence`, local photo storage).

Storage selection (used by the AgentCore runtime entrypoint): `SHIFT_STORE` =
`memory` (default, per-session and ephemeral) | `json` (local durability) |
`dynamodb` (requires `SHIFT_TABLE_NAME`). The local app always uses the JSON file.

To enable the real LLM interpreter, set all three and restart (see
[`.env.example`](./.env.example); never commit credentials):

```bash
LLM_BASE_URL=...   # any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=...
```

## Strands agent mode (Amazon Bedrock)

Beyond the deterministic UI paths, the server can expose a **Strands Agents SDK
agent** (`ShiftContinuityAgent`, `@strands-agents/sdk`) that orchestrates the
system through five typed tools: `report_event`, `get_shift_state`, `get_handoff`,
`record_human_decision`, and `reopen_human_decision`. Every tool wraps an existing
application service; all state changes still flow through append-only events and
the deterministic fold. The agent decides *which tool to call*; the domain decides
*what is true*.

It cannot resolve conflicts or undo decisions itself. `record_human_decision`
refuses any call that does not carry an explicit human-selected claim, and
`reopen_human_decision` refuses any call that does not carry an explicit human
request naming the item — so on a conflict the agent can only surface the options
and ask a human to choose. Who is acting (`actor`) and why (`note`/`reason`) come
from the application's human context, never from the model: the reopen tool takes
no actor argument at all, so it cannot fabricate one.

Requirements for Strands mode: Node.js 22+, AWS credentials available through
the normal AWS credential chain (e.g. `AWS_PROFILE`), and:

```bash
BEDROCK_AGENT=1
AWS_REGION=ca-central-1          # or any region your profile grants
AWS_PROFILE=your-profile         # optional; any chain the AWS SDK supports
AGENT_MODEL_PROVIDER=bedrock     # explicit provider, never inferred from the model id
AGENT_MODEL_ID=ca.amazon.nova-lite-v1:0   # default for bedrock if unset
npm start                        # or npm run dev
```

**Providers.** `AGENT_MODEL_PROVIDER=bedrock` (default) uses the SDK's
`BedrockModel` over the Converse API — the original Nova path; any Bedrock
inference profile works, e.g. Claude Haiku 4.5:
`AGENT_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0`. For OpenAI
GPT-5.6 Luna, select the Responses-API provider:

```bash
AGENT_MODEL_PROVIDER=bedrock-openai
AGENT_MODEL_ID=global.openai.gpt-5.6-luna
```

`bedrock-openai` uses the SDK's `OpenAIModel` (`api: "responses"`) pointed at
the bedrock-runtime OpenAI-compatible endpoint
(`https://bedrock-runtime.{region}.amazonaws.com/openai/v1`), exactly where AWS
serves the Luna cross-region inference profiles. Authentication is a short-term
bearer token derived on demand from the normal AWS credential chain by
`@aws/bedrock-token-generator` — no keys are ever stored or hardcoded.
`AGENT_MODEL_ID` falls back to the legacy `BEDROCK_MODEL_ID`.

**Deterministic routing (model-independent).** Before the model runs, the
request is classified deterministically: explicit human-decision phrasings
("Send D104 to claims", "For D104, use claims") populate `invocationState`
authorization so the tool gate can accept them, vague ones ("Pick whichever
makes sense") never do, and operational reports — even uninterpretable ones —
route to `report_event` so the validated ingestion pipeline rejects them
safely. State questions ("what should we do with D104?") are directed to
`get_shift_state` so the model answers from deterministic state and surfaces the
conflict for human review instead of asking a clarifying question. Obvious cases
get a per-request system-prompt directive injected on the first model call;
Strands remains the orchestrator and the decision tool gate stays authoritative.

No AWS keys belong in code or `.env` — only profile/region configuration. With
`BEDROCK_AGENT` unset, the same agent endpoint runs in **offline deterministic
mode**: a rule-based runner drives the identical tool objects with zero network
access, so demos and tests never need AWS.

Talk to the agent via the UI (**Talk to Shift Agent**) or:

```bash
curl -X POST http://127.0.0.1:7787/api/shifts/$SHIFT_ID/agent \
  -H 'content-type: application/json' \
  -d '{"message": "Aisle 7 is blocked."}'
```

The response includes `toolTrace` — one entry per tool the agent invoked with a
success/error summary — so demos can show that Strands is genuinely operating
the product rather than chatting. This local HTTP process is the **LOCAL APP**;
the same agent is also deployable to Amazon Bedrock AgentCore Runtime (see
**AgentCore deployment** below), which hosts the identical agent, tools, and
domain logic.

Offline end-to-end agent verification (no AWS needed): `npx tsx scripts/agentSmoke.ts`.
The same script run with `BEDROCK_AGENT=1` and a valid AWS profile is the live
Bedrock smoke path.

Without any of the above the app runs fully offline: the deterministic interpreter
answers natural-language input and nothing ever calls the network. The model only
ever *interprets one sentence* into a candidate structured event; its output is
schema-validated locally (id/timestamps/shift id are structurally forbidden), and
a provider failure surfaces as a controlled `502` with no state change.

In the UI: **Load Demo Shift** seeds the Phase 6 scenario; **Report** takes a plain-text
report or a photo plus note, and (behind the disclosure) an exact structured event;
**Current State** marks each item OPEN / RESOLVED / CONFLICT / DECIDED, with a
**Human decision** button per reported claim on conflicted items (recording one flips the
item to DECIDED, attributes it to whoever is named in **Acting as**, and removes it from
the handoff's human-review section). A decided item shows its decision, actor and note
plus a labelled **Reopen decision** action with an optional reason; reopening returns the
item to CONFLICT and puts it back under human review. Decision and reopen buttons are
disabled while a request is in flight, so a double click cannot record the same human
action twice. The agent panel shows the reply and the tool trace for every turn;
**End Shift** freezes the shift.
`?present=1` (or the **Presentation view** button) hides the shift admin and manual
editor for recording and screenshots.

## Photo evidence (submission-prep scope)

A report can carry one photo plus a short note. The image is **evidence, never an
interpreter**: the note goes through exactly the same pipeline as a typed report, and the
image is preserved as metadata on the resulting event.

```
image bytes + note → interpretation → schema validation → append-only event → deterministic fold
```

- `POST /api/shifts/:id/events/photo` accepts `{ note, image, contentType, fileName? }`,
  where `image` is base64 or a browser data URL (PNG/JPEG/WebP/GIF, ≤ 2 MiB).
- `GET /api/shifts/:id/evidence/:evidenceId` serves the stored bytes; the content type
  comes from the event, so history stays the source of truth.
- Bytes live in `EVIDENCE_DIR` (local disk) behind the narrow `EvidenceStore` interface;
  `FileEvidenceStore` is single-instance storage for this PoC, not production media
  storage.
- Nothing is written for a rejected report: the note is interpreted and validated
  *before* any bytes are stored, and the bytes are removed again if the append fails. An
  uninterpretable note (e.g. *“the vibes are off today”*) produces a `400` with zero
  events and zero files.

Model-backed image understanding is deliberately **not** implemented — see
[Explicitly Out of Scope](#explicitly-out-of-scope).

## AgentCore deployment (Amazon Bedrock AgentCore Runtime)

Two distinct ways to run the same agent. There is only one implementation of the
agent, tools, deterministic fold, and decision gate — AgentCore only hosts it.

| | LOCAL APP | AGENTCORE DEPLOYMENT |
| --- | --- | --- |
| Entrypoint | `src/main.ts` (`npm run dev`) | `app/ShiftContinuityAgent/main.ts` (CodeZip) |
| Protocol | project HTTP API (`/api/...`) | AgentCore `/invocations` + `/ping` |
| Persistence | JSON file (`data/shifts.json`), survives restart | in-process memory, **resets on cold start** |
| Model credentials | local AWS credential chain | runtime execution role |
| State | seeded demo shift per AgentCore session | seeded demo shift per AgentCore session |

Both paths use `src/agent/*` and `src/domain/*` unchanged.

### Prerequisites

- Node.js 22+ (the runtime target is `NODE_22`)
- `npm install -g @aws/agentcore` (CLI used here: **0.28.1**)
- AWS credentials via the normal chain: `AWS_PROFILE=shift-handoff`
- Region: `ca-central-1` (configured in `agentcore/aws-targets.json`)
- Model: `global.anthropic.claude-haiku-4-5-20251001-v1:0`, provider `bedrock`
  (configured as runtime `envVars` in `agentcore/agentcore.json`)

### Request contract

`POST /invocations` accepts either `{ "prompt": "..." }` (what `agentcore invoke`
sends) or `{ "shiftId": "...", "message": "...", "actor": "Shift Supervisor" }`.
The response is a JSON envelope: `result` (agent text), `ok`, `toolTrace`, and —
when the tool exposed them — `state`, `handoff`, `item`, `decision`.

Shift identity is application context, never model reasoning. With a durable store
the runtime hosts many shifts, so `shiftId` selects exactly which one to hydrate,
and an unknown id fails explicitly instead of silently operating on a different
shift. Without a durable store each session gets its own isolated, demo-seeded
store and a selector is refused (there is only ever the one shift). `actor` is the
display identity passed through to any human action the request authorizes.

### Local AgentCore test

```bash
# Host the AgentCore entrypoint locally (official dev server)
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore dev --port 8090
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore dev --port 8090 "Aisle 7 is blocked."

# Or run the full local AgentCore smoke (spawns the dev server, drives all scenarios)
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 npx tsx scripts/agentCoreLocalSmoke.ts
```

### Deploy

```bash
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore deploy --dry-run   # inspect proposed resources
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore deploy --yes       # CodeZip deploy
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore status
```

### Remote invocation

```bash
# Official CLI
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore invoke --session-id "<33+ char session id>" "Aisle 7 is blocked."

# Remote smoke: official InvokeAgentRuntime SDK path, all scenarios, isolated per run
SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
  AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
  npx tsx scripts/agentCoreRemoteSmoke.ts
```

The remote smoke reads the runtime ARN from `agentcore/.cli/deployed-state.json`
(or `AGENT_RUNTIME_ARN`). Because the deployed runtime is durable, each run seeds
its own uniquely named shift — from the canonical demo scenario, so no events are
duplicated — into the same table, verifies the exact starting state before
asserting anything, and targets that shift by id on every request. Runs therefore
never reuse, mutate, or clear another run's history; the run's shift id is printed
at the end. It spaces requests, and retries **only** documented transient AWS
throttling (429 / "Too many requests") with bounded backoff — never a semantic,
tool, validation, or authorization failure.

### Observability

The runtime role gets CloudWatch Logs and X-Ray write access by default, and the
AgentCore SDK forwards OTLP traces locally. To watch invocations:

```bash
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore logs --runtime ShiftContinuityAgent
# CloudWatch log group: /aws/bedrock-agentcore/runtimes/{agent-id}-DEFAULT
```

### Cleanup

```bash
agentcore remove all                       # reset local agentcore.json
AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 agentcore deploy --yes   # tears down the stack
# The DynamoDB table has removal policy DESTROY, so the stack delete above drops it
# (and the operational history in it). Delete it directly if the stack is already gone:
#   aws dynamodb delete-table --table-name ShiftContinuityAgent-shift-events --region ca-central-1
# Delete the CDK bootstrap stack too if the account no longer needs it:
#   aws cloudformation delete-stack --stack-name CDKToolkit --region ca-central-1
```

AWS resources for the deployment: the AgentCore Runtime, its IAM execution role/policy,
CloudWatch log group, the CDK staging bucket, and the `ShiftContinuityAgent-shift-events`
DynamoDB table. Nothing else (no Cognito, API Gateway, Lambda, streams, or memory).

### Persistence

The deployed AgentCore runtime persists the **append-only operational event log** in
DynamoDB (`src/store/dynamoDbStore.ts`). Current state is never stored: it is
deterministically reconstructed from those events with the same fold the local app
uses, so DynamoDB cannot become a second source of truth.

One table, `ShiftContinuityAgent-shift-events`, on-demand billing, one index
(`shiftsByStart`, needed by `listShifts`). The runtime role is granted exactly
`dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:PutItem` — no `dynamodb:*`.

| | `PK` | `SK` | Contents |
| --- | --- | --- | --- |
| Shift | `SHIFT#<shiftId>` | `META` | name, startedAt, endedAt, index keys |
| Event | `SHIFT#<shiftId>` | `EVENT#<occurredAt>#<eventId>` | one immutable event |

ISO 8601 UTC timestamps are fixed-width, so the sort key sorts chronologically, and
the trailing `eventId` keeps two events that share a timestamp distinct instead of
colliding. Appends are **conditional** (`attribute_not_exists(PK)`): re-appending an
existing event fails loudly rather than overwriting history.

Storage is selected explicitly by `SHIFT_STORE` — `memory` (default, per-session and
ephemeral), `json` (local durability), or `dynamodb`. The domain layer never sees the
choice: the runtime hydrates a snapshot, runs the same synchronous domain code, and
flushes appended events before replying. If a flush fails the invocation reports
failure rather than claiming a write that did not happen.

Verify the deployed history at any time (a fresh store in a separate process):

```bash
# List every shift in the table
SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
  AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
  npx tsx scripts/dynamoPersistenceCheck.ts

# Inspect exactly one shift (the id a remote smoke run printed); with an explicit
# id there is no fallback to another shift, so a typo fails loudly.
SHIFT_STORE=dynamodb SHIFT_TABLE_NAME=ShiftContinuityAgent-shift-events \
  AWS_PROFILE=shift-handoff AWS_REGION=ca-central-1 \
  npx tsx scripts/dynamoPersistenceCheck.ts <shiftId>
```

**Smoke-run shifts.** Each remote smoke run leaves its own `remote-smoke-<runId>`
shift behind, by design: that is what makes runs repeatable, and it means history is
never cleared to make a test pass. They are tiny and harmless, and deleting them is
optional — never a prerequisite for a green run. To remove them, list the shifts
with the command above and delete each shift's partition items:

```bash
aws dynamodb query --table-name ShiftContinuityAgent-shift-events --region ca-central-1 \
  --key-condition-expression "PK = :pk" --expression-attribute-values '{":pk":{"S":"SHIFT#<shiftId>"}}' \
  --query 'Items[].{PK:PK,SK:SK}' --output json
# then, for each returned PK/SK pair:
aws dynamodb delete-item --table-name ShiftContinuityAgent-shift-events --region ca-central-1 \
  --key '{"PK":{"S":"SHIFT#<shiftId>"},"SK":{"S":"<SK>"}}'
```

**Remaining limitations.** This is a hackathon deployment, not production persistence:

- Photo-evidence **bytes** still live on the local filesystem, so the deployed runtime
  does not store images — only event metadata. The demo seed on AgentCore therefore
  omits the photo beat.
- The first cold start seeds the demo shift only when the table is empty; two processes
  racing on an empty table could each seed one (no cross-process lock).
- No TTL, no backups/PITR, no point-in-time recovery, and `agentcore remove` deletes the
  table (removal policy `DESTROY`).
- Event ids are unique per `(occurredAt, id)` key; a duplicate id replayed at a
  *different* timestamp is not deduplicated.
- Isolated smoke shifts accumulate in the table (one per remote run). That is
  intentional, not leakage: no run ever writes to, reads, or clears another run's
  shift.

## Screenshots and submission assets

`docs/stills/` holds seven stills of the real UI captured from a running app:
hero/agent, dashboard with the active conflict, a live tool trace, the recorded human
decision (with its attribution and reopen action), the final handoff, photo evidence in
history, and — for the optional reopen beat — the item back under human review.
`07-decision-reopened.png` is the only still the main 3:45 cut does not need.

```bash
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence PORT=7799 npm start
BASE_URL=http://127.0.0.1:7799 npx tsx scripts/captureScreenshots.ts
DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts  # leave the store pristine for the take
```

`captureScreenshots.ts` drives headless Chrome over the DevTools protocol (no extra npm
dependency) at the locked recording viewport — 1440×810 CSS px (exactly 16:9) at 2×
density, so each full-frame PNG is 2880×1620 — and clicks the UI's own decision button, so
the stills cannot show state the app could not actually produce. It requires Google
Chrome locally (`CHROME_PATH` overrides the default binary path) and a *running* app; it
mutates that app's data by recording one decision.

`resetDemo.ts` wipes the store, seeds the frozen scenario through the same code path the
app uses, and exits non-zero if the result does not match — so a recording can never start
from a drifted demo state.

Captions and the asset inventory are in
[`docs/video-assets/ASSET_PACK.md`](./docs/video-assets/ASSET_PACK.md); motion prompts,
camera moves, and intro/outro placement are in
[`docs/AI_VIDEO_PROMPTS.md`](./docs/AI_VIDEO_PROMPTS.md); the shot-by-shot plan is in
[`docs/SHOT_LIST.md`](./docs/SHOT_LIST.md).

## Design and accessibility

The UI is one server-rendered page with no framework and no build step. It is designed as
an **operational console**, not an AI landing page: a neutral surface system, a single
accent for action, four semantic status tokens, and hierarchy carried by type scale and
spacing rather than by color.

- **Tokens.** Everything visual is a CSS custom property declared once in `:root`
  (`src/http/ui.ts`): ink (`--ink-1/2/3`), surfaces (`--surface-0..3`), lines
  (`--line-1/2`, `--line-strong`), accent and focus (`--accent`, `--focus`), the four
  status pairs (`--open/--conflict/--resolved/--decided-ink|-bg`), the trace palette, a
  spacing scale (`--space-1..7`) and radii (`--radius-xs/sm/md`). One place to audit.
- **Status is never color-only.** Each of OPEN / CONFLICT / RESOLVED / DECIDED renders as
  a chip with an inline SVG icon **and** an uppercase word, so the states stay separable
  in grayscale, for color-blind readers, and in a compressed screen recording. The
  colored left rail on an item card is a secondary cue; the resolved rail is deliberately
  quiet because that state should recede.
- **Contrast is enforced by test.** `src/http/ui.test.ts` parses the rendered tokens and
  computes WCAG contrast for 20 text pairs and 5 non-text pairs (input borders, focus
  ring). Text is ≥ 4.5:1; control boundaries and the focus ring are ≥ 3:1. Current
  tightest text pair: meta text on the page background, 5.08:1.
- **Keyboard and focus.** Every control is a native `input`/`select`/`button`/`summary`,
  so Tab order is document order, Enter submits the agent and report forms, and Space
  activates a decision button. A single `:focus-visible` ring (`2px solid #2f6fb5`,
  5.2:1 on white) appears on every stop; a skip link jumps to `#main`.
- **Structure for assistive tech.** `header`/`main` landmarks, exactly one `h1` (the
  product wordmark), `section` + `h2` per panel with `h3` per item, `label for` on all 22
  controls, `role="alert"` for the error banner, and `aria-live="polite"` regions for the
  agent reply, tool trace, and report results. ARIA is used only where an element has no
  native equivalent (the decision group and the live regions).
- **Motion.** The only animation is a 120ms color transition on controls; the stylesheet
  respects `prefers-reduced-motion: reduce`.
- **Layout.** Independent left/right columns (`7fr / 4.3fr`) at ≥1000px, single column
  below; the composition was measured at 1440×810 (the locked recording size) to keep the
  conflict, the decision callout and the handoff visible next to the agent, with no dead
  space between panels.

`?present=1` hides the setup toolbar and the manual event editor so recordings and stills
show only the operator-facing product.

## How the handoff works (the core product)

Events fold, in `occurredAt` order, into **operational items**:

| Status | Meaning | Handoff treatment |
| --- | --- | --- |
| `open` | problem/work still outstanding | **Requires action** |
| `conflicted` | contradictory claims on one subject | **Requires human review** |
| `resolved` | cleared/completed by a later event | counted only |
| `decided` | reconciled by an explicit human decision | counted only |

A conflict is closed by a human, never by the system: recording a decision on a
conflicted item appends an ordinary `decision_recorded` event through the normal
store path. The decision is validated against the current folded state (item
exists, is conflicted, chosen claim is one of the conflicting canonical claims).
Ordinary reports can never undo it: later claims and later decision events stay in
history without changing the item.

The one way back out of `decided` is an explicit, attributed **reopen**.
`decision_reopened` is appended — never an edit or a delete — the item returns to
`conflicted` with its original competing claims, and the superseded decision stays
visible on the item and in history until a new human decision settles it. Only a
currently `decided` item may be reopened, only a named human may ask for it, and a
second reopen without an intervening decision is refused. Decisions and reopens are
only accepted through their dedicated endpoints, never through the generic event
path.

**Provenance.** Both human actions carry who authorized them — `actor` (a display
identity such as `Shift Supervisor`) and an optional `note`/`reason`. Both live on
the event itself, so the audit trail is append-only like everything else and
survives persistence unchanged; the history view and the item cards both show them.
`actor` is optional in the schema so decisions recorded before provenance existed
remain readable.

The LLM (or rule-based interpreter) is an **interpreter, not the source of truth**:
`natural language → structured extraction → schema validation → deterministic domain engine → state`.
It is injectable (`EventInterpreter`); the default is a deterministic pattern matcher,
so the system fully works with no LLM configured.

## Current PoC Scope

- Single-user, local, single JSON-file persistence (`ShiftStore` interface; SQLite would slot in behind it).
- Domain engine: chronological fold, resolution, conflict detection, decision reconciliation, handoff projection.
- Framework-free HTTP API + one functional embedded UI page (no build step, no SPA framework).
- Seeded demo scenario (`POST /api/demo-shift`) matching the Phase 6 expectation.
- Natural-language ingestion behind `EventInterpreter` with a deterministic baseline interpreter that refuses to guess on unparseable input.
- Optional real LLM interpreter (`LLMEventInterpreter` over an `OpenAiCompatibleClient`, env-configured, provider-neutral `LlmClient` boundary) with strict local schema validation of model output.
- Local Strands integration: one `ShiftContinuityAgent` (`@strands-agents/sdk`) orchestrating the deterministic system through five typed tools, with an offline deterministic runner as fallback and per-invocation tool traces for demos. Explicit provider selection (`AGENT_MODEL_PROVIDER`): `bedrock` (Nova via `BedrockModel` Converse, `ca.amazon.nova-lite-v1:0` by default) or `bedrock-openai` (GPT-5.6 Luna via the SDK's OpenAI Responses model on the bedrock-runtime OpenAI-compatible endpoint, `global.openai.gpt-5.6-luna` by default), both authenticated through the normal AWS credential chain.
- Deterministic normalization to cut false conflicts: subject canonicalization (configured aliases + narrow `"damaged case D104" → "d104"` shape) and claim normalization (explicit disposition vocabulary, unknown claims kept as normalized raw text).
- Photo evidence: an image plus a note can be attached to a report; the note rides the normal interpretation/validation pipeline while the image is stored locally (`EvidenceStore`) and shown as evidence on the event in history. No model sees the pixels.
- AgentCore deployment: the same Strands agent hosted on Amazon Bedrock AgentCore Runtime (CodeZip, `ca-central-1`), invoked through the AgentCore `/invocations` protocol with a JSON envelope carrying the agent response, tool trace, and resulting state; per-session in-memory state (see the AgentCore persistence limitation above).
- Demo/presentation readiness: seeded demo shift, a presentation view, a demo-flow guide in the header, a reset/seed script, and a headless-Chrome screenshot script producing `docs/stills/`.
- Durable operational event history for the deployed AgentCore runtime in a single DynamoDB table, selected with `SHIFT_STORE`, with the domain fold unchanged.
- Decision provenance and explicit reopen: decisions and reopens are append-only, attributed (`actor` plus optional `note`/`reason`), and auditable; a reopen returns an item to conflict without touching the original decision, and both are gated by deterministic authorization that the model cannot fabricate.
- 321 automated tests, all network-free; no credentials, accounts, or network services required.

## Explicitly Out of Scope

AWS production infrastructure beyond the AgentCore Runtime and its single DynamoDB
table (queues, Lambda, API Gateway, Cognito, application S3 storage, AgentCore
Memory/Gateway, DynamoDB streams/TTL/backups),
production-grade data operations (multi-region replication, point-in-time recovery,
migrations, retention policy), authentication, user accounts, organizations,
role-based access, verified identity (the decision `actor` is a client-supplied
display string, so it is an audit annotation and not proof of who acted), mobile apps,
SMS/email/Slack/Teams integration, voice recording, production databases,
Docker/Kubernetes, metrics/observability platforms, branding, billing, multi-tenancy,
sophisticated permissions, multiple cooperating agents, agent memory services, CI/CD,
and autonomous actions against real workplace systems.

Image handling is scoped narrowly: **model-backed image interpretation, OCR, video, and
cloud media pipelines are out of scope.** Photo evidence exists as an attachment whose
accompanying note is interpreted textually, and whose bytes are stored locally — the
model never receives the image.

This list is binding until explicitly changed (AGENTS.md §1).

## Repository structure

```
src/
  domain/     pure logic: types, validation, subjects, claims, decisions, state fold, handoff (no I/O, no frameworks)
  store/      ShiftStore interface + JSON-file, in-memory, and DynamoDB implementations
              + shiftStoreFactory (explicit SHIFT_STORE selection)
              + EvidenceStore interface + local-file implementation (photo evidence bytes)
  http/       node:http server, API routes, embedded UI
  ingest/     EventInterpreter boundary: deterministic interpreter + optional real LLM adapter
              + photo-evidence ingestion (note interpreted, image attached as metadata)
  agent/      Strands ShiftContinuityAgent: typed tools over app services + Bedrock/offline runners
              + modelProvider (explicit provider/model selection) + requestRouting (deterministic routing/authorization)
              + agentCoreAdapter (AgentCore request parsing, per-session stores, response envelope)
  demo/       seeded Phase 6 scenario
  main.ts     LOCAL APP entrypoint
app/
  ShiftContinuityAgent/  AGENTCORE entrypoint (main.ts/app.ts) — thin host over src/, no duplicated logic
agentcore/
  agentcore.json         AgentCore project spec: CodeZip runtime + provider/model env
  aws-targets.json       deployment target (account, region)
  cdk/                   generated CDK infrastructure (IAM role + AgentCore Runtime)
scripts/
  agentSmoke.ts            local app smoke (offline/live Bedrock)
  agentCoreLocalSmoke.ts   local AgentCore smoke via `agentcore dev`
  agentCoreRemoteSmoke.ts  deployed runtime smoke via InvokeAgentRuntime
  resetDemo.ts             reset + verify the frozen demo state for a recording take
  seedDemo.ts              seed demo data without wiping (+ one photo-evidence report)
  captureScreenshots.ts    headless-Chrome capture of the demo stills
docs/
  ARCHITECTURE.md          boundaries + mermaid diagrams
  RECORDING_GUIDE.md       commands, viewport lock, exact turns, framing
  SHOT_LIST.md             shot-by-shot plan for the ~3:45 video
  AI_VIDEO_PROMPTS.md      per-still motion prompts, durations, transitions, placement
  DEMO_SCRIPT.md           story + 30-second cut
  DEVPOST_DRAFT.md         elevator pitch, features, tech stack, originality
  video-assets/            still asset inventory (captions)
  stills/                  captured UI stills (regenerate with scripts/captureScreenshots.ts)
```

Tests live beside the code they test (`*.test.ts`). Domain tests encode the seven
product scenarios (unresolved survives, resolved disappears, dependent resolution,
conflict visibility, noise omission, chronology, history retention).

## API

| Method & path | Purpose |
| --- | --- |
| `POST /api/shifts` | create shift `{ name }` |
| `GET /api/shifts` | list shifts (newest first) |
| `GET /api/shifts/:id/state` | events (chronological) + current items |
| `GET /api/shifts/:id/handoff` | the handoff projection |
| `POST /api/shifts/:id/events` | append structured event |
| `POST /api/shifts/:id/events/nl` | natural-language report → validated event |
| `POST /api/shifts/:id/events/photo` | photo + note report `{ note, image, contentType, fileName? }` → validated event with evidence metadata |
| `GET /api/shifts/:id/evidence/:evidenceId` | the stored evidence image bytes |
| `POST /api/shifts/:id/agent` | send a message to the Strands agent `{ message, actor? }` → response + tool trace (`actor` is the identity recorded on any human action the turn performs) |
| `POST /api/shifts/:id/items/:subject/decision` | record a human decision `{ claim, actor?, note? }` on a conflicted item |
| `POST /api/shifts/:id/items/:subject/reopen` | append a reopen `{ actor, reason? }` for a currently decided item |
| `POST /api/shifts/:id/end` | end shift (blocks further events) |
| `POST /api/demo-shift` | seed the demo scenario |

`POST .../events/nl` failure modes: `400` for unparseable reports or schema-invalid
interpreter output, `502` when the configured LLM provider is unreachable — in every
failure case nothing is persisted.

`POST .../events/photo` failure modes: `400` for a missing/blank note, no image data,
invalid base64, or a non-image content type; `413` when the decoded image exceeds 2 MiB;
`404` for an unknown shift; `409` for an ended shift; `501` when no evidence store is
configured. In every failure case nothing is persisted **and** no image file is written
(or a file already written is removed).

`POST .../items/:subject/decision` failure modes: `400` for a missing/empty claim or
a claim outside the conflicting options, `404` for an unknown item, `409` when the
item is not conflicted or was already decided (with a machine-readable `code`),
`409` for an ended shift. Rejected decisions never mutate state.

`POST .../items/:subject/reopen` failure modes: `400` (`missing_actor`) when no actor is
supplied, `404` for an unknown item, `409` (`item_not_decided`) when the item is not
currently decided, `409` for an ended shift. A refused reopen appends nothing:
the item and its history are untouched.
