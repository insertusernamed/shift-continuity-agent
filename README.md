# Shift Handoff — autonomous shift handoff system (PoC)

Tracks operational events during a work shift and, at handoff time, surfaces **only
what still matters to the incoming shift**: unresolved work, unresolved problems,
conflicting information, and items requiring a human decision. Resolved history is
retained but never clutters the handoff.

Read [AGENTS.md](./AGENTS.md) before changing this repository — it is binding.

## Run locally

Requires Node.js 22+.

```bash
npm install
npm run dev        # dev server with auto-reload at http://127.0.0.1:7787
```

Other commands:

```bash
npm test           # full test suite (node:test via tsx)
npm run typecheck  # strict TypeScript, no emit
npm start          # run once without file watching
```

Configuration (optional): `PORT` (default 7787), `DATA_FILE` (default `data/shifts.json`).

To enable the real LLM interpreter, set all three and restart (see
[`.env.example`](./.env.example); never commit credentials):

```bash
LLM_BASE_URL=...   # any OpenAI-compatible endpoint, e.g. https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=...
```

## Strands agent mode (Amazon Bedrock, local only)

Beyond the deterministic UI paths, the server can expose a **Strands Agents SDK
agent** (`ShiftContinuityAgent`, `@strands-agents/sdk`) that orchestrates the
system through four typed tools: `report_event`, `get_shift_state`, `get_handoff`,
and `record_human_decision`. Every tool wraps an existing application service;
all state changes still flow through append-only events and the deterministic
fold. The agent decides *which tool to call*; the domain decides *what is true*.
It cannot resolve conflicts itself: `record_human_decision` refuses any call that
does not carry an explicit human-selected claim, so on a conflict the agent can
only surface the options and ask a human to choose.

Requirements for Strands mode: Node.js 22+, AWS credentials available through
the normal AWS credential chain (e.g. `AWS_PROFILE`), and:

```bash
BEDROCK_AGENT=1
AWS_REGION=ca-central-1          # or any region your profile grants
AWS_PROFILE=your-profile         # optional; any chain the AWS SDK supports
BEDROCK_MODEL_ID=ca.amazon.nova-lite-v1:0   # default if unset
npm start                        # or npm run dev
```

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
the product rather than chatting. AgentCore deployment does **not** exist yet;
the agent runs only in this local process.

Offline end-to-end agent verification (no AWS needed): `npx tsx scripts/agentSmoke.ts`.
The same script run with `BEDROCK_AGENT=1` and a valid AWS profile is the live
Bedrock smoke path.

Without any of the above the app runs fully offline: the deterministic interpreter
answers natural-language input and nothing ever calls the network. The model only
ever *interprets one sentence* into a candidate structured event; its output is
schema-validated locally (id/timestamps/shift id are structurally forbidden), and
a provider failure surfaces as a controlled `502` with no state change.

In the UI: **Load Demo Shift** seeds the Phase 6 scenario; **Report in plain words**
accepts natural-language reports; **Add Event (structured)** posts exact events;
conflicted items show a **Human decision** button per reported claim (recording one
flips the item to DECIDED and removes it from the handoff's human-review section);
**End Shift** freezes the shift and shows the handoff.

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
exists, is conflicted, chosen claim is one of the conflicting canonical claims)
and is final — later decision events and late contradictory reports stay in
history but cannot reopen the item. Decisions are only accepted through the
dedicated endpoint, never through the generic event path.

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
- Local Strands integration: one `ShiftContinuityAgent` (`@strands-agents/sdk`, Bedrock `ca.amazon.nova-lite-v1:0` by default) orchestrating the deterministic system through four typed tools, with an offline deterministic runner as fallback and per-invocation tool traces for demos.
- Deterministic normalization to cut false conflicts: subject canonicalization (configured aliases + narrow `"damaged case D104" → "d104"` shape) and claim normalization (explicit disposition vocabulary, unknown claims kept as normalized raw text).
- All automated tests run offline; no credentials, accounts, or network services.

## Explicitly Out of Scope

AgentCore deployment, AWS production infrastructure (IAM roles, queues, Lambda),
authentication, user accounts, organizations, role-based access, mobile apps,
SMS/email/Slack/Teams integration, voice recording, image/multimodal processing,
production databases, Docker/Kubernetes, metrics/observability platforms,
animations, branding, billing, multi-tenancy, sophisticated permissions,
multiple cooperating agents, agent memory services, and autonomous actions
against real workplace systems. This list is binding until explicitly changed
(AGENTS.md §1).

## Repository structure

```
src/
  domain/     pure logic: types, validation, subjects, claims, decisions, state fold, handoff (no I/O, no frameworks)
  store/      ShiftStore interface + JSON-file implementation
  http/       node:http server, API routes, embedded UI
  ingest/     EventInterpreter boundary: deterministic interpreter + optional real LLM adapter
  agent/      Strands ShiftContinuityAgent: typed tools over app services + Bedrock/offline runners
  demo/       seeded Phase 6 scenario
  main.ts     entrypoint
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
| `POST /api/shifts/:id/agent` | send a message to the Strands agent `{ message }` → response + tool trace |
| `POST /api/shifts/:id/items/:subject/decision` | record a human decision `{ claim }` on a conflicted item |
| `POST /api/shifts/:id/end` | end shift (blocks further events) |
| `POST /api/demo-shift` | seed the demo scenario |

`POST .../events/nl` failure modes: `400` for unparseable reports or schema-invalid
interpreter output, `502` when the configured LLM provider is unreachable — in every
failure case nothing is persisted.

`POST .../items/:subject/decision` failure modes: `400` for a missing/empty claim or
a claim outside the conflicting options, `404` for an unknown item, `409` when the
item is not conflicted or was already decided (with a machine-readable `code`),
`409` for an ended shift. Rejected decisions never mutate state.
