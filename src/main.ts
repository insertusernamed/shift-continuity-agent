import { startServer } from "./http/server.ts";
import { JsonFileShiftStore } from "./store/jsonFileStore.ts";
import { createInterpreterFromEnv } from "./ingest/llmInterpreter.ts";

const PORT = Number(process.env.PORT ?? 7787);
const DATA_FILE = process.env.DATA_FILE ?? "data/shifts.json";

// Offline by default: without LLM_BASE_URL / LLM_API_KEY / LLM_MODEL the
// deterministic interpreter is used and nothing ever calls the network.
const interpreter = createInterpreterFromEnv(process.env);

// Strands agent mode is opt-in (BEDROCK_AGENT=1). Region/profile/model come
// from the normal AWS environment; no credentials are ever read here.
const bedrock = process.env.BEDROCK_AGENT === "1" ? {} : undefined;

const store = new JsonFileShiftStore(DATA_FILE);
const server = await startServer({ store, port: PORT, interpreter, bedrock });

console.log(`Shift Handoff PoC running at ${server.url}`);
console.log(`Data file: ${DATA_FILE}`);
console.log(`Interpreter: ${interpreter.constructor.name}`);
if (interpreter.constructor.name !== "DeterministicEventInterpreter") {
  console.log(`LLM: ${process.env.LLM_MODEL} @ ${process.env.LLM_BASE_URL}`);
}
if (bedrock) {
  console.log(`Strands agent: Bedrock (${process.env.AWS_REGION ?? "region from AWS env"})`);
} else {
  console.log("Strands agent: offline deterministic mode (set BEDROCK_AGENT=1 for Bedrock)");
}
