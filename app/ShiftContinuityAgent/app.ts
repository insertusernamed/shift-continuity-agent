import { BedrockAgentCoreApp, type RequestContext } from "bedrock-agentcore/runtime";
import { createInterpreterFromEnv } from "../../src/ingest/llmInterpreter.ts";
import { resolveAgentModelConfig } from "../../src/agent/modelProvider.ts";
import {
  createAgentCoreRequestSchema,
  createAgentCoreSessionProvider,
  invokeAgentCoreShift,
  parseAgentCoreInvocationRequest,
} from "../../src/agent/agentCoreAdapter.ts";
import { describeShiftStore, resolveShiftStoreConfig } from "../../src/store/shiftStoreFactory.ts";

/** Fallback session id when the runtime does not supply one (local curl/dev). */
const DEFAULT_SESSION = "default-session";

/**
 * AgentCore Runtime host for the existing ShiftContinuityAgent.
 *
 * This is deliberately thin glue: AgentCore hosts the process and owns the
 * invocation/session protocol, while every piece of operational truth — tools,
 * deterministic fold, human-decision gate, request routing — is the exact same
 * code the local app runs (src/agent, src/domain). No second agent
 * implementation exists.
 *
 * Storage is selected by configuration (SHIFT_STORE): the default is the
 * ephemeral per-session store, and `dynamodb` swaps in the durable append-only
 * event log. Either way the domain layer is unaware — it only ever sees the
 * synchronous ShiftStore contract.
 *
 * Model configuration comes from the normal environment (AGENT_MODEL_PROVIDER,
 * AGENT_MODEL_ID, AWS_REGION), set for the runtime in agentcore/agentcore.json.
 */
export function createShiftContinuityAgentCoreApp(env: NodeJS.ProcessEnv = process.env): BedrockAgentCoreApp {
  const storeConfig = resolveShiftStoreConfig(env);
  console.log(describeShiftStore(storeConfig));

  const sessions = createAgentCoreSessionProvider({ env });
  // Same interpreter selection as src/main.ts: deterministic unless LLM_* env
  // is configured, in which case natural-language reports may be interpreted
  // by an LLM. Either way the report_event tool validates before any mutation.
  const interpreter = createInterpreterFromEnv(env);
  const model = resolveAgentModelConfig(env);

  return new BedrockAgentCoreApp({
    invocationHandler: {
      requestSchema: createAgentCoreRequestSchema(),
      async process(request, context: RequestContext) {
        const { userText, shiftId } = parseAgentCoreInvocationRequest(request);
        const session = await sessions.get(context.sessionId || DEFAULT_SESSION);
        const envelope = await invokeAgentCoreShift({
          store: session.store,
          shiftId: shiftId ?? session.shiftId,
          userText,
          interpreter,
          mode: "bedrock",
          bedrock: {
            provider: model.provider,
            modelId: model.modelId,
            region: model.region,
          },
        });

        // Durable storage writes after the synchronous domain work. If the write
        // fails we must not report success: the history the agent just claimed to
        // append is not actually persisted.
        try {
          await session.flush?.();
        } catch (err) {
          console.error("ShiftStore flush failed:", err instanceof Error ? err.message : err);
          return {
            ...envelope,
            ok: false,
            error: `persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        return envelope;
      },
    },
  });
}
