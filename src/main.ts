import { startServer } from "./http/server.ts";
import { JsonFileShiftStore } from "./store/jsonFileStore.ts";

const PORT = Number(process.env.PORT ?? 7787);
const DATA_FILE = process.env.DATA_FILE ?? "data/shifts.json";

const store = new JsonFileShiftStore(DATA_FILE);
const server = await startServer({ store, port: PORT });

console.log(`Shift Handoff PoC running at ${server.url}`);
console.log(`Data file: ${DATA_FILE}`);
