import { startServer } from "./http/server.ts";
import { JsonFileShiftStore } from "./store/jsonFileStore.ts";
import { FileEvidenceStore } from "./store/evidenceStore.ts";
import { createInterpreterFromEnv } from "./ingest/llmInterpreter.ts";
import { resolveAgentModelConfig } from "./agent/modelProvider.ts";

const PORT = Number(process.env.PORT ?? 7787);
const DATA_FILE = process.env.DATA_FILE ?? "data/shifts.json";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "data/evidence";

// Offline by default: without LLM_BASE_URL / LLM_API_KEY / LLM_MODEL the
// deterministic interpreter is used and nothing ever calls the network.
const interpreter = createInterpreterFromEnv(process.env);

// Strands agent mode is opt-in (BEDROCK_AGENT=1). The provider/model/region
// come from the normal AWS environment (AGENT_MODEL_PROVIDER, AGENT_MODEL_ID,
// AWS_REGION); no credentials are ever read here.
const bedrock = process.env.BEDROCK_AGENT === "1" ? {} : undefined;
const agentModelConfig = bedrock
  ? resolveAgentModelConfig(process.env)
  : undefined;

const store = new JsonFileShiftStore(DATA_FILE);
// Photo evidence bytes live beside the event log: local, single-instance, and
// deliberately not production media storage.
const evidenceStore = new FileEvidenceStore(EVIDENCE_DIR);
const server = await startServer({ store, port: PORT, interpreter, bedrock, evidenceStore });

console.log(`Shift Handoff PoC running at ${server.url}`);
console.log(`Data file: ${DATA_FILE}`);
console.log(`Photo evidence dir: ${EVIDENCE_DIR}`);
console.log(`Interpreter: ${interpreter.constructor.name}`);
if (interpreter.constructor.name !== "DeterministicEventInterpreter") {
  console.log(`LLM: ${process.env.LLM_MODEL} @ ${process.env.LLM_BASE_URL}`);
}
if (bedrock && agentModelConfig) {
  console.log(`Strands agent: ${agentModelConfig.provider} (${agentModelConfig.modelId} @ ${agentModelConfig.region ?? "region from AWS env"})`);
} else {
  console.log("Strands agent: offline deterministic mode (set BEDROCK_AGENT=1 for Bedrock)");
}
