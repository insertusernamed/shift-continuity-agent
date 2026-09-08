import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";

let server: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "shift-api-"));
  const store = new JsonFileShiftStore(join(dir, "shifts.json"));
  server = await startServer({ store, port: 0 });
  return {
    baseUrl: server.url,
    cleanup: () => {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function api(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
}

describe("HTTP API", () => {
  it("serves the UI page at /", async () => {
    const app = await makeApp();
    try {
      const res = await fetch(app.baseUrl + "/");
      assert.equal(res.status, 200);
      assert.match(await res.text(), /EVENT HISTORY|Add Event|End Shift/i);
    } finally {
      app.cleanup();
    }
  });

  it("creates a shift and rejects a blank name", async () => {
    const app = await makeApp();
    try {
      const created = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
      assert.equal(created.status, 201);
      assert.equal(created.body.name, "Night Shift");

      const blank = await api(app.baseUrl, "POST", "/api/shifts", { name: "   " });
      assert.equal(blank.status, 400);
    } finally {
      app.cleanup();
    }
  });

  it("accepts a valid event and rejects an invalid one without partial writes", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });

      const good = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T02:11:00Z",
        kind: "problem_reported",
        subject: "aisle 7",
        description: "aisle 7 blocked",
        source: "radio",
      });
      assert.equal(good.status, 201);

      const bad = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "not-a-date",
        kind: "problem_reported",
        subject: "x",
        description: "x",
        source: "x",
      });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /occurredAt/i);

      const events = await api(app.baseUrl, "GET", `/api/shifts/${shift.id}/events`);
      assert.equal(events.body.length, 1, "invalid event must not be persisted");
    } finally {
      app.cleanup();
    }
  });

  it("regression: POST /api/demo-shift seeds the demo scenario (guard must not 404 it)", async () => {
    const app = await makeApp();
    try {
      const res = await api(app.baseUrl, "POST", "/api/demo-shift");
      assert.equal(res.status, 201);
      assert.match(res.body.name, /demo/i);
      const handoff = await api(app.baseUrl, "GET", `/api/shifts/${res.body.id}/handoff`);
      assert.equal(handoff.body.requiresAction[0].subject, "freezer inspection");
    } finally {
      app.cleanup();
    }
  });

  it("returns 404 for unknown shift resources", async () => {
    const app = await makeApp();
    try {
      const missing = await api(app.baseUrl, "GET", "/api/shifts/nope/state");
      assert.equal(missing.status, 404);
    } finally {
      app.cleanup();
    }
  });

  it("end-to-end: seed events, view state, end shift, get handoff", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
      const eid = shift.id;
      const ev = (n: number, body: Record<string, unknown>) =>
        api(app.baseUrl, "POST", `/api/shifts/${eid}/events`, { occurredAt: `2026-09-08T0${n}:00:00Z`, ...body });

      await ev(2, { kind: "problem_reported", subject: "aisle 7", description: "blocked", source: "radio" });
      await ev(3, { kind: "cleared", subject: "aisle 7", description: "cleared", source: "radio" });
      await ev(4, { kind: "problem_reported", subject: "freezer inspection", description: "missed", source: "radio" });
      await ev(5, { kind: "status_claimed", subject: "case D104", description: "claims", claim: "send to claims", source: "scanner" });
      await ev(5, { kind: "status_claimed", subject: "case D104", description: "discarded", claim: "discarded", source: "operator" });

      const state = await api(app.baseUrl, "GET", `/api/shifts/${eid}/state`);
      assert.equal(state.status, 200);
      assert.equal(state.body.items.length, 3);

      const ended = await api(app.baseUrl, "POST", `/api/shifts/${eid}/end`);
      assert.equal(ended.status, 200);
      assert.ok(ended.body.endedAt);

      const handoff = await api(app.baseUrl, "GET", `/api/shifts/${eid}/handoff`);
      assert.equal(handoff.status, 200);
      assert.equal(handoff.body.requiresAction.length, 1);
      assert.equal(handoff.body.requiresAction[0].subject, "freezer inspection");
      assert.equal(handoff.body.requiresHumanReview.length, 1);
      assert.equal(handoff.body.requiresHumanReview[0].subject, "case D104");
      assert.equal(handoff.body.resolvedDuringShiftCount, 1);

      const blocked = await api(app.baseUrl, "POST", `/api/shifts/${eid}/events`, {
        occurredAt: "2026-09-08T09:00:00Z",
        kind: "problem_reported",
        subject: "late arrival",
        description: "after end",
        source: "radio",
      });
      assert.equal(blocked.status, 409);
    } finally {
      app.cleanup();
    }
  });
});
