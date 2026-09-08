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

Without them the app runs fully offline: the deterministic interpreter answers
natural-language input and nothing ever calls the network. The model only ever
*interprets one sentence* into a candidate structured event; its output is
schema-validated locally (id/timestamps/shift id are structurally forbidden), and
a provider failure surfaces as a controlled `502` with no state change.

In the UI: **Load Demo Shift** seeds the Phase 6 scenario; **Report in plain words**
accepts natural-language reports; **Add Event (structured)** posts exact events;
**End Shift** freezes the shift and shows the handoff.

## How the handoff works (the core product)

Events fold, in `occurredAt` order, into **operational items**:

| Status | Meaning | Handoff treatment |
| --- | --- | --- |
| `open` | problem/work still outstanding | **Requires action** |
| `conflicted` | contradictory claims on one subject | **Requires human review** |
| `resolved` | cleared/completed by a later event | counted only |
| `decided` | reconciled by an explicit decision | counted only |

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
- Deterministic normalization to cut false conflicts: subject canonicalization (configured aliases + narrow `"damaged case D104" → "d104"` shape) and claim normalization (explicit disposition vocabulary, unknown claims kept as normalized raw text).
- All tests run offline; no credentials, accounts, or network services.

## Explicitly Out of Scope

AWS deployment, AgentCore, Bedrock, Strands, authentication, user accounts,
organizations, role-based access, mobile apps, SMS/email/Slack/Teams integration,
voice recording, image processing, production databases, Docker/Kubernetes,
metrics/observability platforms, animations, branding, billing, multi-tenancy,
sophisticated permissions, multiple AI agents, and autonomous actions against real
workplace systems. This list is binding until explicitly changed (AGENTS.md §1).

## Repository structure

```
src/
  domain/     pure logic: types, validation, subjects, claims, state fold, handoff (no I/O, no frameworks)
  store/      ShiftStore interface + JSON-file implementation
  http/       node:http server, API routes, embedded UI
  ingest/     EventInterpreter boundary: deterministic interpreter + optional real LLM adapter
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
| `POST /api/shifts/:id/end` | end shift (blocks further events) |
| `POST /api/demo-shift` | seed the demo scenario |

`POST .../events/nl` failure modes: `400` for unparseable reports or schema-invalid
interpreter output, `502` when the configured LLM provider is unreachable — in every
failure case nothing is persisted.
