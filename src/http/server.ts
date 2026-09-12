import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OperationalEvent } from "../domain/types.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import { StoreError } from "../store/jsonFileStore.ts";
import { ValidationError } from "../domain/validate.ts";
import { buildHandoff } from "../domain/handoff.ts";
import { recordableDecision, reopenableDecision, DecisionValidationError } from "../domain/decide.ts";
import { canonicalSubject } from "../domain/subjects.ts";
import { createDemoShift } from "../demo/demo.ts";
import { DeterministicEventInterpreter, InterpretationError, ProviderError, type EventInterpreter } from "../ingest/interpreter.ts";
import { ingestNaturalLanguageReport } from "../ingest/ingestEvent.ts";
import { ingestPhotoEvidence, PhotoEvidenceError } from "../ingest/ingestPhotoEvidence.ts";
import type { EvidenceStore } from "../store/evidenceStore.ts";
import { createShiftContinuityAgent, type BedrockAgentConfig } from "../agent/shiftContinuityAgent.ts";
import { renderUi } from "./ui.ts";

export interface RunningServer {
  url: string;
  port: number;
  /**
   * Resolves only after shutdown completes, including idle keep-alive socket
   * teardown, so restart harnesses can rebind the same port without racing.
   */
  close(): Promise<void>;
}

// Base64 inflates an image by ~4/3, so the body limit has to clear the image
// limit with headroom. Both stay small: evidence is a demo feature, not a
// media pipeline.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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
  /** Bedrock configuration for the Strands agent; omitted = offline deterministic agent. */
  bedrock?: BedrockAgentConfig;
  /** Photo-evidence byte storage; omitted = photo reports are refused, text still works. */
  evidenceStore?: EvidenceStore;
}): Promise<RunningServer> {
  const { store } = options;
  const interpreter = options.interpreter ?? new DeterministicEventInterpreter();
  const nodeServer = createServer((req, res) => {
    handle(req, res, store, interpreter, options.bedrock, options.evidenceStore).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      // Surface unexpected failures loudly; never swallow them silently.
      console.error(err);
    });
  });

  let shutdown: Promise<void> | undefined;

  return new Promise<RunningServer>((resolve) => {
    nodeServer.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = nodeServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          // Idempotent: double-close (test hooks, harness + finally) returns
          // the same shutdown; ERR_SERVER_NOT_RUNNING never escapes.
          shutdown ??= new Promise<void>((resolveClose) => {
            nodeServer.closeIdleConnections();
            nodeServer.close(() => resolveClose());
          });
          return shutdown;
        },
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: ShiftStore,
  interpreter: EventInterpreter,
  bedrock?: BedrockAgentConfig,
  evidenceStore?: EvidenceStore,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderUi());
    return;
  }

  const isShiftRoute = parts[0] === "api" && parts[1] === "shifts";
  const isDemoRoute = url.pathname === "/api/demo-shift";
  if (!isShiftRoute && !isDemoRoute) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  // POST /api/demo-shift — seed the Phase 6 demo scenario.
  if (isDemoRoute) {
    if (method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    sendJson(res, 201, createDemoShift(store));
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
      if (body.kind === "decision_recorded" || body.kind === "decision_reopened") {
        // Human-authority events are gated: they must pass the decision/reopen
        // validation endpoints, not arrive as raw events (§7 — no silent state
        // mutation, and no anonymous human action).
        const route = body.kind === "decision_recorded" ? "decision" : "reopen";
        return sendJson(res, 400, {
          error: `${body.kind} events must go through POST /api/shifts/:id/items/:subject/${route}`,
        });
      }
      try {
        // The HTTP body is untrusted input; validateEvent at the store
        // boundary is the schema gate (§6) before anything persists.
        const event = {
          id: crypto.randomUUID(),
          shiftId,
          occurredAt: body.occurredAt as string,
          kind: body.kind as OperationalEvent["kind"],
          subject: body.subject as string,
          description: body.description as string,
          source: typeof body.source === "string" && body.source.trim() ? body.source : "operator",
          ...(typeof body.claim === "string" ? { claim: body.claim } : {}),
          ...(typeof body.blockedBy === "string" ? { blockedBy: body.blockedBy } : {}),
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
      const interpreted = await interpreter.interpret({ text });
      const event = {
        ...interpreted,
        id: crypto.randomUUID(),
        shiftId,
        occurredAt: typeof body.occurredAt === "string" && body.occurredAt ? body.occurredAt : new Date().toISOString(),
      };
      store.appendEvent(event);
      sendJson(res, 201, event);
    } catch (err) {
      // Provider/network failures upstream are 502: nothing was interpreted,
      // so nothing can be persisted (§6). Schema-invalid interpreter output
      // and unparseable reports are client errors; nothing is persisted in
      // any failure case.
      if (err instanceof ProviderError) {
        return sendJson(res, 502, { error: err.message });
      }
      if (err instanceof InterpretationError || err instanceof ValidationError) {
        return sendJson(res, 400, { error: err.message });
      }
      sendDomainError(res, err);
    }
    return;
  }

  // POST /api/shifts/:id/events/photo — photo + note → interpreted event with
  // the image preserved as evidence metadata. The image never reaches the
  // interpreter: the note is interpreted exactly like a text report, so photo
  // reports go through the same validation gate as everything else.
  if (sub === "events" && parts[4] === "photo" && method === "POST") {
    if (!store.getShift(shiftId)) return sendJson(res, 404, { error: "unknown shift" });
    if (!evidenceStore) return sendJson(res, 501, { error: "photo evidence storage is not configured" });
    const body = await readJson(req, res);
    if (body === undefined) return;

    const rawImage = typeof body.image === "string" ? body.image : "";
    if (!rawImage.trim()) return sendJson(res, 400, { error: "image is required (base64 or data URL)" });
    let image: { bytes: Buffer; contentType?: string };
    try {
      image = decodeImageField(rawImage);
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    if (image.bytes.length > MAX_IMAGE_BYTES) {
      return sendJson(res, 413, { error: `image exceeds ${MAX_IMAGE_BYTES} bytes` });
    }
    const declaredType = typeof body.contentType === "string" ? body.contentType.trim() : "";
    const contentType = declaredType || image.contentType || "";
    if (!contentType) {
      return sendJson(res, 400, { error: "contentType is required when the image is not a data URL" });
    }

    try {
      const event = await ingestPhotoEvidence({
        store,
        evidenceStore,
        shiftId,
        interpreter,
        note: typeof body.note === "string" ? body.note : "",
        image: image.bytes,
        contentType,
        fileName: typeof body.fileName === "string" ? body.fileName : "",
        ...(typeof body.occurredAt === "string" && body.occurredAt ? { occurredAt: body.occurredAt } : {}),
      });
      sendJson(res, 201, event);
    } catch (err) {
      if (err instanceof ProviderError) return sendJson(res, 502, { error: err.message });
      if (
        err instanceof PhotoEvidenceError ||
        err instanceof InterpretationError ||
        err instanceof ValidationError
      ) {
        return sendJson(res, 400, { error: err.message });
      }
      sendDomainError(res, err);
    }
    return;
  }

  // GET /api/shifts/:id/evidence/:evidenceId — the stored image bytes. Metadata
  // (content type) comes from the event, so history stays the source of truth.
  if (sub === "evidence" && parts[4] !== undefined && method === "GET") {
    if (!evidenceStore) return sendJson(res, 501, { error: "photo evidence storage is not configured" });
    const state = store.getShiftState(shiftId);
    if (!state) return sendJson(res, 404, { error: "unknown shift" });
    const evidenceId = decodeURIComponent(parts[4]);
    const attachment = state.events
      .flatMap((e) => e.evidence ?? [])
      .find((ev) => ev.id === evidenceId);
    if (!attachment) return sendJson(res, 404, { error: "unknown evidence" });
    const bytes = evidenceStore.read(evidenceId);
    if (!bytes) return sendJson(res, 404, { error: "evidence file is missing" });
    res.writeHead(200, {
      "content-type": attachment.contentType,
      "content-length": bytes.length,
      "cache-control": "private, max-age=3600",
    });
    res.end(bytes);
    return;
  }

  // POST /api/shifts/:id/agent — Strands orchestration over deterministic tools.
  if (sub === "agent" && method === "POST") {
    if (!store.getShift(shiftId)) return sendJson(res, 404, { error: "unknown shift" });
    const body = await readJson(req, res);
    if (body === undefined) return;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return sendJson(res, 400, { error: "message is required" });
    // Who the request acts on behalf of. Optional here (the agent still refuses
    // any human action without it) but required in practice for attributed
    // decisions and reopens.
    const actor = typeof body.actor === "string" ? body.actor.trim() : "";
    try {
      const agent = createShiftContinuityAgent({ store, shiftId, interpreter, mode: bedrock ? "bedrock" : "deterministic", bedrock });
      const result = await agent.invoke(message, actor ? { actor } : undefined);
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (err) {
      // Agent construction/loop failures are upstream-of-tool: controlled 502,
      // and nothing was appended because tools own all mutation.
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
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

  // POST /api/shifts/:id/items/:subject/decision — a human reconciles a
  // conflicted item. The decision is validated against the current folded
  // state, then appended as an ordinary decision_recorded event through the
  // normal store path; state is re-derived from events, never written directly.
  if (sub === "items" && parts[5] === "decision" && method === "POST") {
    const subject = decodeURIComponent(parts[4] ?? "");
    const body = await readJson(req, res);
    if (body === undefined) return;
    if (typeof body.claim !== "string" || !body.claim.trim()) {
      return sendJson(res, 400, { error: 'decision body must include a non-empty "claim"' });
    }
    const state = store.getShiftState(shiftId);
    if (!state) return sendJson(res, 404, { error: "unknown shift" });
    try {
      const decision = recordableDecision({
        state,
        subject,
        claim: body.claim,
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        ...(typeof body.actor === "string" ? { actor: body.actor } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      store.appendEvent(decision);
      const updated = store.getShiftState(shiftId);
      const item = updated?.items.find((i) => i.canonicalSubject === canonicalSubject(subject));
      sendJson(res, 200, { event: decision, item });
    } catch (err) {
      sendDecisionError(res, err);
    }
    return;
  }

  // POST /api/shifts/:id/items/:subject/reopen — a human explicitly undoes the
  // decision on one decided item. Like a decision, this is validated against
  // the current folded state and appended as an ordinary event; the prior
  // decision is never edited or removed.
  if (sub === "items" && parts[5] === "reopen" && method === "POST") {
    const subject = decodeURIComponent(parts[4] ?? "");
    const body = await readJson(req, res);
    if (body === undefined) return;
    const state = store.getShiftState(shiftId);
    if (!state) return sendJson(res, 404, { error: "unknown shift" });
    try {
      const reopened = reopenableDecision({
        state,
        subject,
        actor: typeof body.actor === "string" ? body.actor : "",
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      });
      store.appendEvent(reopened);
      const updated = store.getShiftState(shiftId);
      const item = updated?.items.find((i) => i.canonicalSubject === canonicalSubject(subject));
      sendJson(res, 200, { event: reopened, item });
    } catch (err) {
      sendDecisionError(res, err);
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function sendDecisionError(res: ServerResponse, err: unknown): void {
  if (err instanceof DecisionValidationError) {
    const status =
      err.code === "item_not_found" ? 404
      : err.code === "item_not_conflicted" || err.code === "already_decided" || err.code === "item_not_decided" ? 409
      : 400;
    sendJson(res, status, { error: err.message, code: err.code });
    return;
  }
  // Includes StoreError "shift has ended" → 409 via the shared mapping.
  sendDomainError(res, err);
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

/**
 * Browsers hand us a data URL from FileReader; the API also accepts bare
 * base64. Everything else (empty, non-base64, zero bytes) is refused here so
 * nothing downstream has to guess what the image was.
 */
function decodeImageField(raw: string): { bytes: Buffer; contentType?: string } {
  const dataUrl = raw.match(/^data:([^;,]+);base64,(.*)$/s);
  const base64 = (dataUrl ? dataUrl[2]! : raw).replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("image must be base64 or a base64 data URL");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) throw new Error("image decoded to zero bytes");
  return dataUrl ? { bytes, contentType: dataUrl[1]! } : { bytes };
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
