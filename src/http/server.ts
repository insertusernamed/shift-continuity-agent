import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import { StoreError } from "../store/jsonFileStore.ts";
import { ValidationError } from "../domain/validate.ts";
import { buildHandoff } from "../domain/handoff.ts";
import { createDemoShift } from "../demo/demo.ts";
import { DeterministicEventInterpreter, InterpretationError, type EventInterpreter } from "../ingest/interpreter.ts";
import { renderUi } from "./ui.ts";

export interface RunningServer {
  url: string;
  port: number;
  close(): void;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Plain node:http server. Deliberately framework-free (AGENTS.md §5/§9):
 * the API surface is small and explicit routing is easier to audit than
 * framework magic at this size.
 */
export function startServer(options: {
  store: ShiftStore;
  port?: number;
  /** Natural-language interpreter; injectable so tests never call an LLM. */
  interpreter?: EventInterpreter;
}): RunningServer {
  const { store } = options;
  const interpreter = options.interpreter ?? new DeterministicEventInterpreter();
  const nodeServer = createServer((req, res) => {
    handle(req, res, store, interpreter).catch((err) => {
      sendJson(res, 500, { error: "internal error" });
      // Surface unexpected failures loudly; never swallow them silently.
      console.error(err);
    });
  });

  return new Promise((resolve) => {
    nodeServer.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = nodeServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => nodeServer.close(),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: ShiftStore,
  interpreter: EventInterpreter,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderUi());
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "shifts") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  // /api/shifts
  if (parts.length === 2) {
    if (method === "POST") {
      const body = await readJson(req, res);
      if (body === undefined) return;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        sendJson(res, 400, { error: "shift name is required" });
        return;
      }
      sendJson(res, 201, store.createShift(name));
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, store.listShifts());
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const shiftId = parts[2]!;
  const sub = parts[3];

  // /api/shifts/:id/events  (parts[4] === undefined keeps /events/nl below out of this branch)
  if (sub === "events" && parts[4] === undefined) {
    if (method === "GET") {
      if (!store.getShift(shiftId)) return sendJson(res, 404, { error: "unknown shift" });
      sendJson(res, 200, store.getEvents(shiftId));
      return;
    }
    if (method === "POST") {
      const body = await readJson(req, res);
      if (body === undefined) return;
      try {
        const event = {
          id: crypto.randomUUID(),
          shiftId,
          occurredAt: body.occurredAt,
          kind: body.kind,
          subject: body.subject,
          description: body.description,
          source: typeof body.source === "string" && body.source.trim() ? body.source : "operator",
          claim: body.claim,
          blockedBy: body.blockedBy,
        };
        store.appendEvent(event);
        sendJson(res, 201, event);
      } catch (err) {
        sendDomainError(res, err);
      }
      return;
    }
  }

  // POST /api/shifts/:id/events/nl — natural-language report → structured event.
  if (sub === "events" && parts[4] === "nl" && method === "POST") {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return sendJson(res, 400, { error: "text is required" });
    try {
      const interpreted = interpreter.interpret({ text });
      const event = {
        ...interpreted,
        id: crypto.randomUUID(),
        shiftId,
        occurredAt: typeof body.occurredAt === "string" && body.occurredAt ? body.occurredAt : new Date().toISOString(),
      };
      store.appendEvent(event);
      sendJson(res, 201, event);
    } catch (err) {
      // Both a failed interpretation and schema-invalid interpreter output
      // are client errors; nothing is persisted in either case (§6).
      if (err instanceof InterpretationError || err instanceof ValidationError) {
        return sendJson(res, 400, { error: err.message });
      }
      sendDomainError(res, err);
    }
    return;
  }

  // /api/shifts/:id/state
  if (sub === "state" && method === "GET") {
    const state = store.getShiftState(shiftId);
    if (!state) return sendJson(res, 404, { error: "unknown shift" });
    sendJson(res, 200, state);
    return;
  }

  // /api/shifts/:id/handoff
  if (sub === "handoff" && method === "GET") {
    const state = store.getShiftState(shiftId);
    if (!state) return sendJson(res, 404, { error: "unknown shift" });
    sendJson(res, 200, buildHandoff(state));
    return;
  }

  // /api/shifts/:id/end
  if (sub === "end" && method === "POST") {
    try {
      sendJson(res, 200, store.endShift(shiftId));
    } catch (err) {
      sendDomainError(res, err);
    }
    return;
  }

  // POST /api/demo-shift — seed the Phase 6 demo scenario.
  if (url.pathname === "/api/demo-shift" && method === "POST") {
    sendJson(res, 201, createDemoShift(store));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendDomainError(res: ServerResponse, err: unknown): void {
  if (err instanceof ValidationError) {
    sendJson(res, 400, { error: err.message });
    return;
  }
  if (err instanceof StoreError) {
    const conflict = err.message.includes("ended");
    sendJson(res, conflict ? 409 : 404, { error: err.message });
    return;
  }
  throw err;
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: "body too large" });
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
