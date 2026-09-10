# ShiftContinuityAgent (AgentCore app)

This package is the Amazon Bedrock AgentCore Runtime host for the repository's
existing Strands agent. It is deliberately thin:

```
AgentCore Runtime
  → app/ShiftContinuityAgent/main.ts      (AgentCore protocol: HTTP /invocations)
  → app/ShiftContinuityAgent/app.ts       (request → session → agent invocation)
  → src/agent/agentCoreAdapter.ts         (session registry + response envelope)
  → src/agent/shiftContinuityAgent.ts     (the existing ShiftContinuityAgent)
  → src/agent/tools.ts + src/domain       (deterministic tools, fold, decision gate)
```

There is no second agent implementation. The tools, deterministic state fold,
human-decision authorization gate, and request routing are the exact same
modules the local app (`src/main.ts`) uses.

## Request contract

`POST /invocations` (AgentCore protocol) accepts either:

```json
{ "prompt": "Aisle 7 is blocked." }
```

(the shape `agentcore invoke "<text>"` sends) or

```json
{ "shiftId": "...", "message": "Aisle 7 is blocked." }
```

`message` wins when both are present. Session identity comes from the AgentCore
`x-amzn-bedrock-agentcore-runtime-session-id` header; each session gets its own
isolated, demo-seeded in-process store.

The response is a JSON envelope:

```json
{
  "result": "Accepted: aisle 7 is open.",
  "ok": true,
  "toolTrace": [{ "tool": "report_event", "status": "success", "summary": "..." }],
  "state": { "...": "deterministic state projection" },
  "handoff": { "...": "when get_handoff ran" },
  "item": { "...": "when report_event / record_human_decision ran" },
  "decision": { "...": "when a human decision was recorded" }
}
```

## Model

Configured through the normal environment (`agentcore/agentcore.json` runtime
`envVars`): `AGENT_MODEL_PROVIDER=bedrock`, `AGENT_MODEL_ID`, `AWS_REGION`.
Credentials come from the AgentCore Runtime execution role in the cloud and
from the normal AWS credential chain during local development. No API keys are
stored here.

## Persistence

State is process-local (`src/store/inMemoryStore.ts`). AgentCore microVMs have
ephemeral filesystems, so the JSON-file store used by the local app would give
the illusion of persistence without providing it. State survives for the life
of a runtime session/VM and resets on cold start. See the repository README for
the full limitation.

## Local development

From the repository root:

```bash
agentcore dev --port 8090
agentcore dev --port 8090 "Aisle 7 is blocked."
```
