/**
 * Reset the local store to the exact state the recording starts from.
 *
 * `scripts/seedDemo.ts` *adds* a demo shift (useful while iterating); this
 * script *resets* — it wipes the JSON store and the evidence directory first,
 * then seeds through the same code path, so the state a recording begins from
 * is always identical and matches the captured stills in docs/stills/.
 *
 * Usage (defaults shown; see docs/RECORDING_GUIDE.md):
 *   DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence \
 *     npx tsx scripts/resetDemo.ts
 *
 * Exits non-zero if the resulting state does not match the recorded scenario,
 * because a demo that silently drifts is worse than one that fails loudly.
 */
import { existsSync, rmSync } from "node:fs";
import { JsonFileShiftStore } from "../src/store/jsonFileStore.ts";
import { demoScenarioProblems } from "../src/demo/demoScenario.ts";

const DATA_FILE = process.env.DATA_FILE ?? "data/shifts.json";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "data/evidence";

for (const target of [DATA_FILE, `${DATA_FILE}.tmp`, EVIDENCE_DIR]) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`wiped ${target}`);
  }
}

// Import after the wipe so the seeder writes into a clean store. It reads the
// same env vars, so there is exactly one seeding implementation.
await import("./seedDemo.ts");

const store = new JsonFileShiftStore(DATA_FILE);
const shifts = store.listShifts();
const problems: string[] = [];

if (shifts.length !== 1) problems.push(`expected exactly 1 shift, found ${shifts.length}`);

const shift = shifts[0];
if (shift) {
  const state = store.getShiftState(shift.id);
  if (!state) problems.push(`could not derive state for shift ${shift.id}`);
  else problems.push(...demoScenarioProblems(state));
}

if (problems.length > 0) {
  console.error("\ndemo reset FAILED:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`\ndemo ready: 1 shift, ${store.getEvents(shift!.id).length} events, ` +
  "3 resolved · 1 open (freezer inspection) · 1 conflicted (damaged case D104), 1 photo attachment");
console.log("start the app with the same DATA_FILE/EVIDENCE_DIR, then open /?present=1");
