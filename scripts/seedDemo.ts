/**
 * Seed the demo shift for screenshots/recording.
 *
 * The UI's "Load Demo Shift" button seeds the canonical 7-event story
 * (src/demo/demo.ts). This script seeds the same story plus the photo-evidence
 * beat from src/demo/demoScenario.ts, so the history shows a stored image and
 * the final handoff still collapses to the single open item (the missed
 * freezer inspection).
 *
 * This script *adds* a shift. For the recording, use scripts/resetDemo.ts —
 * it wipes first and then verifies the scenario.
 *
 * Usage:
 *   DATA_FILE=data/shifts.json EVIDENCE_DIR=data/evidence npx tsx scripts/seedDemo.ts
 *
 * Safe and offline: it writes the JSON store and the evidence directory
 * directly, through the same domain/store path the app uses. It does not touch
 * the network and does not read credentials.
 */
import { deflateSync } from "node:zlib";
import { JsonFileShiftStore } from "../src/store/jsonFileStore.ts";
import { FileEvidenceStore } from "../src/store/evidenceStore.ts";
import { DeterministicEventInterpreter } from "../src/ingest/interpreter.ts";
import { createDemoShift } from "../src/demo/demo.ts";
import { appendDemoPhotoReport } from "../src/demo/demoScenario.ts";

const DATA_FILE = process.env.DATA_FILE ?? "data/shifts.json";
const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "data/evidence";

const store = new JsonFileShiftStore(DATA_FILE);
const evidenceStore = new FileEvidenceStore(EVIDENCE_DIR);
const shift = createDemoShift(store);

const photo = await appendDemoPhotoReport({
  store,
  evidenceStore,
  shiftId: shift.id,
  interpreter: new DeterministicEventInterpreter(),
  image: renderBlockedAislePhoto(),
});

console.log(`Seeded demo shift ${shift.id} (${shift.name})`);
console.log(`Photo evidence: ${photo.evidence?.[0]?.id} (${EVIDENCE_DIR}/) attached to "${photo.subject}"`);
console.log(`Open ${DATA_FILE} with: DATA_FILE=${DATA_FILE} EVIDENCE_DIR=${EVIDENCE_DIR} npm start`);

/**
 * Placeholder still: a warehouse floor with a fallen carton across an aisle.
 * Drawn in code (stdlib zlib, no image libraries) so the repo carries no
 * binary test fixture; swap in a real photo for the final recording.
 */
function renderBlockedAislePhoto(): Buffer {
  const width = 320;
  const height = 220;
  const pixels = Buffer.alloc(width * height * 3);

  const put = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
  };
  const box = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, rgb);
  };

  // Floor with a subtle perspective gradient, then pallets, then the obstruction.
  for (let y = 0; y < height; y++) {
    const shade = 214 - Math.round((y / height) * 46);
    box(0, y, width - 1, y, [shade, shade - 6, shade - 18]);
  }
  box(0, 0, width - 1, 58, [186, 191, 199]); // back wall
  box(0, 58, width - 1, 60, [150, 155, 163]); // wall base line
  for (const x of [24, 96, 168, 240]) box(x, 20, x + 56, 54, [176, 163, 143]); // stacked pallets

  // The pallet that fell across aisle 12, with a shadow.
  box(70, 132, 250, 172, [120, 84, 48]);
  box(70, 132, 250, 140, [146, 104, 60]);
  box(58, 172, 258, 178, [150, 148, 142]);
  for (let i = 0; i < 40; i++) box(84 + i, 140 + i, 90 + i, 146 + i, [176, 62, 48]); // damage stripe

  return encodePng(width, height, pixels);
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
