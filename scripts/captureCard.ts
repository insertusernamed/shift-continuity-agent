/**
 * Render a static HTML card to a PNG with headless Chrome.
 *
 * Why this exists: the repository commits images that are *not* UI screenshots —
 * the README architecture diagram, and the still cards used by the submission
 * video. Each must be reproducible from a text source committed beside it, so they
 * can be reviewed and regenerated after a change instead of being hand-edited in an
 * image tool, which would make them unverifiable.
 *
 * The cards themselves are static HTML (no JS, no webfonts, system stack only), so a
 * plain Chrome screenshot is deterministic and needs no extra dependency.
 *
 * Usage:
 *   npx tsx scripts/captureCard.ts docs/architecture.html docs/architecture.png 1560 1300
 *   npx tsx scripts/captureCard.ts <in.html> <out.png> [width] [height]
 *
 * Requires Google Chrome locally (CHROME_PATH overrides the default path).
 * Captures at device scale 1, so the PNG is exactly the size given — 1560×1300 for
 * the README diagram, 1920×1080 for a 16:9 video card.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [input, output, widthArg, heightArg] = process.argv.slice(2);

if (!input || !output) {
  console.error("usage: npx tsx scripts/captureCard.ts <input.html> <out.png> [width] [height]");
  process.exit(2);
}

if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}\nSet CHROME_PATH to the Chrome binary and retry.`);
  process.exit(1);
}

const inputPath = resolve(input);
if (!existsSync(inputPath)) {
  console.error(`input card not found: ${inputPath}`);
  process.exit(1);
}

const outputPath = resolve(output);
mkdirSync(dirname(outputPath), { recursive: true });

const width = Number(widthArg ?? 1920);
const height = Number(heightArg ?? 1080);

const result = spawnSync(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--window-size=${width},${height}`,
    `--screenshot=${outputPath}`,
    // Let layout and the first paint settle before the capture.
    "--virtual-time-budget=2500",
    `file://${inputPath}`,
  ],
  { stdio: "inherit" },
);

if (result.status !== 0 || !existsSync(outputPath)) {
  console.error(`capture failed (chrome exit ${result.status ?? "?"})`);
  process.exit(1);
}

console.log(`wrote ${output} (${width}×${height}, ${(statSync(outputPath).size / 1024).toFixed(0)} KB)`);
