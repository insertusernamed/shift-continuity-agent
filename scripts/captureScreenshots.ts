/**
 * Capture clean stills of the demo flow for the submission video.
 *
 * Drives headless Chrome over the DevTools protocol (no extra dependencies —
 * Node's built-in fetch/WebSocket) against a *running* app, so the stills show
 * the real UI with real deterministic state, not a mock-up.
 *
 * Usage: run the two commands in docs/RECORDING_GUIDE.md — reset the frozen demo
 * state, start the app against it, then point this script at that server:
 *
 *   DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence npx tsx scripts/resetDemo.ts
 *   DATA_FILE=data/stills/shifts.json EVIDENCE_DIR=data/stills/evidence PORT=7799 npx tsx src/main.ts
 *   BASE_URL=http://127.0.0.1:7799 npx tsx scripts/captureScreenshots.ts
 *
 * Captures into docs/stills/ at the locked recording viewport (1440×810 CSS px,
 * exactly 16:9, at 2× density = 2880×1620 PNGs). In a 1920×1080 timeline that is
 * a 66% scale — crisp, and up to ~1.3× punch-in before softening. The decision
 * stills require the decision to be recorded, which this script does by clicking
 * the UI's own human-decision button — the same path a person takes, so the
 * stills cannot show state the app could not produce.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:7777";
const OUT_DIR = process.env.OUT_DIR ?? "docs/stills";
// The locked recording viewport (see docs/RECORDING_GUIDE.md): 1440×810 CSS px —
// exactly 16:9 — with no browser zoom. The app column is 1140px wide, so it fills
// ~83% of the frame instead of sitting in wide margins, and body text lands at
// ~19px in a 1080p timeline. Stills are captured at deviceScaleFactor 2, so each
// PNG is 2880×1620: scale to 66% for a 1:1 fit in 1080p, or punch in for a crop.
const WIDTH = Number(process.env.STILL_WIDTH ?? 1440);
const HEIGHT = Number(process.env.STILL_HEIGHT ?? 810);
const PIXEL_RATIO = Number(process.env.STILL_PIXEL_RATIO ?? 2);
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9333);

mkdirSync(OUT_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--disable-gpu",
    "--user-data-dir=" + join(process.env.TMPDIR ?? "/tmp", `shift-stills-${Date.now()}`),
    "about:blank",
  ],
  { stdio: "ignore" },
);
chrome.unref();

try {
  const target = await waitForTarget();
  const cdp = await connect(target);
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: PIXEL_RATIO,
    mobile: false,
  });

  await navigate(cdp, `${BASE_URL}/?present=1`);
  await waitFor(cdp, `document.querySelectorAll("#stateList .card").length > 0 && !document.getElementById("error").textContent`);

  // 1. Hero: title, one-sentence explanation, and the agent entry point.
  await scrollToTop(cdp);
  await shoot(cdp, "01-hero-and-agent.png");

  // 2. Dashboard with the active conflict and its human-decision buttons.
  await scrollTo(cdp, "#stateSection");
  await shoot(cdp, "02-dashboard-conflict.png");

  // 3. Tool trace: one real agent turn, showing which tool ran and its result.
  await scrollToTop(cdp);
  await evaluate(cdp, `
    document.getElementById("agentText").value = "What does the morning shift need to know?";
    document.getElementById("agentBtn").click();
  `);
  await waitFor(cdp, `!document.getElementById("agentTrace").hidden`);
  await scrollTo(cdp, "#agentSection");
  await shoot(cdp, "03-tool-trace.png");

  // 4. Human decision: click the conflicted item's own "send to claims" button.
  await evaluate(cdp, `
    [...document.querySelectorAll(".decisionBtn")].find(b => b.textContent.includes("claims")).click();
  `);
  await waitFor(cdp, `document.querySelector("#stateList .card--decided") !== null`);
  await scrollTo(cdp, "#stateSection");
  await shoot(cdp, "04-decision-recorded.png");

  // 5. Final handoff: the conflict is gone, one open item remains.
  await shootElement(cdp, "#handoffSection", "05-handoff.png");

  // 6. Photo evidence as it appears in the append-only history.
  await scrollTo(cdp, "#historySection");
  await shootElement(cdp, ".evidence", "06-photo-evidence.png");

  console.log(`Captured 6 stills into ${OUT_DIR}/`);
} finally {
  chrome.kill();
}

/* ---------------------------------------------------------------- CDP plumbing */

interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
}

async function waitForTarget(): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("headless Chrome did not expose a page target in time");
}

async function connect(wsUrl: string): Promise<Cdp> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message}`));
    else waiter.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  await cdp.send("Page.navigate", { url });
  await waitFor(cdp, `document.readyState === "complete"`);
  // The client fetches its state after load; give the microtask queue a tick.
  await sleep(400);
}

async function evaluate(cdp: Cdp, expression: string): Promise<unknown> {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return result.result?.value;
}

async function waitFor(cdp: Cdp, expression: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) {
      await settle(cdp);
      return;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

/**
 * Screenshots come from the compositor surface, so a DOM update that has not
 * painted yet would capture the previous frame. Waiting two animation frames
 * plus a beat guarantees the still matches the state we just asserted.
 */
async function settle(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300))))`);
}

async function scrollToTop(cdp: Cdp): Promise<void> {
  await evaluate(cdp, `window.scrollTo({ top: 0, behavior: "instant" })`);
  await settle(cdp);
}

async function scrollTo(cdp: Cdp, selector: string): Promise<void> {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "start", behavior: "instant" })`);
  await settle(cdp);
}

async function shoot(cdp: Cdp, fileName: string): Promise<void> {
  const result = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, fileName), Buffer.from(result.data, "base64"));
  console.log(`  ${fileName}`);
}

/** Clip strictly to an element's box, for section-level stills. */
async function shootElement(cdp: Cdp, selector: string, fileName: string): Promise<void> {
  const box = (await evaluate(
    cdp,
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
       return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }; })()`,
  )) as { x: number; y: number; width: number; height: number };
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(join(OUT_DIR, fileName), Buffer.from(result.data, "base64"));
  console.log(`  ${fileName}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
