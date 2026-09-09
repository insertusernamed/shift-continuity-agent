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

  describe("human decision endpoint", () => {
    async function makeConflictedApp() {
      const app = await makeApp();
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "missed", source: "radio",
      });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims", source: "scanner",
      });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator",
      });
      return { app, shiftId: shift.id as string };
    }

    it("records a valid decision: item becomes decided and leaves human review", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, { claim: "send to claims" });
        assert.equal(res.status, 200);
        assert.equal(res.body.item.status, "decided");
        assert.equal(res.body.item.decision.canonicalValue, "claims");

        const handoff = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/handoff`);
        assert.equal(handoff.body.requiresHumanReview.length, 0);
        assert.equal(handoff.body.decidedDuringShiftCount, 1);
      } finally {
        app.cleanup();
      }
    });

    it("404 for an unknown item", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/pallet-99/decision`, { claim: "claims" });
        assert.equal(res.status, 404);
        assert.match(res.body.error, /no operational item/i);
      } finally {
        app.cleanup();
      }
    });

    it("409 when the item is not conflicted", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/${encodeURIComponent("freezer inspection")}/decision`, { claim: "claims" });
        assert.equal(res.status, 409);
        assert.match(res.body.error, /not conflicted/i);
      } finally {
        app.cleanup();
      }
    });

    it("400 for a claim outside the conflicting options", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, { claim: "donate" });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /donate/i);

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        const d104 = state.body.items.find((i: any) => i.canonicalSubject === "d104");
        assert.equal(d104.status, "conflicted", "rejected decision must not mutate state");
      } finally {
        app.cleanup();
      }
    });

    it("400 for a malformed body (missing claim)", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, {});
        assert.equal(res.status, 400);
        assert.match(res.body.error, /claim/i);
      } finally {
        app.cleanup();
      }
    });

    it("409 for a second decision after the item is already decided", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const first = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, { claim: "claims" });
        assert.equal(first.status, 200);
        const second = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, { claim: "discard" });
        assert.equal(second.status, 409);
        assert.match(second.body.error, /already/i);
      } finally {
        app.cleanup();
      }
    });

    it("regression: decision_recorded cannot be smuggled through the generic event endpoint", async () => {
      const { app, shiftId } = await makeConflictedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/events`, {
          occurredAt: "2026-09-08T05:40:00Z", kind: "decision_recorded", subject: "damaged case D104", description: "bypass attempt", claim: "send to claims", source: "operator",
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /decision_recorded/i);

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        const d104 = state.body.items.find((i: any) => i.canonicalSubject === "d104");
        assert.equal(d104.status, "conflicted", "state must be unchanged");
      } finally {
        app.cleanup();
      }
    });
  });

  describe("shift agent endpoint", () => {
    async function makeAgentApp() {
      const app = await makeApp();
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
      return { app, shiftId: shift.id as string };
    }

    it("routes a routine report through the agent and mutates deterministic state", async () => {
      const { app, shiftId } = await makeAgentApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, { message: "Aisle 7 is blocked." });
        assert.equal(res.status, 200);
        assert.equal(res.body.ok, true);
        assert.match(res.body.response, /Aisle 7/i);
        assert.deepEqual(res.body.toolTrace.map((t: any) => t.tool), ["report_event"]);

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        const aisle = state.body.items.find((i: any) => i.canonicalSubject === "aisle 7");
        assert.equal(aisle.status, "open", "agent must mutate state only through the deterministic path");
      } finally {
        app.cleanup();
      }
    });

    it("rejects a blank message and an unknown shift", async () => {
      const { app, shiftId } = await makeAgentApp();
      try {
        const blank = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, { message: "   " });
        assert.equal(blank.status, 400);

        const unknown = await api(app.baseUrl, "POST", "/api/shifts/nope/agent", { message: "hello" });
        assert.equal(unknown.status, 404);
      } finally {
        app.cleanup();
      }
    });

    it("refuses to decide a conflict autonomously but records an explicit human choice", async () => {
      const { app, shiftId } = await makeAgentApp();
      try {
        await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/events`, {
          occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims", source: "scanner",
        });
        await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/events`, {
          occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator",
        });

        const vague = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, { message: "Just pick whichever one makes sense for D104." });
        assert.equal(vague.status, 200);
        assert.match(vague.body.response, /human decision is required/i);
        assert.deepEqual(vague.body.toolTrace.map((t: any) => t.tool), ["get_shift_state"], "no decision tool may run without explicit human choice");

        const explicit = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, { message: "Send D104 to claims." });
        assert.equal(explicit.status, 200);
        assert.equal(explicit.body.decision?.canonicalValue, "claims");

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        const d104 = state.body.items.find((i: any) => i.canonicalSubject === "d104");
        assert.equal(d104.status, "decided");
      } finally {
        app.cleanup();
      }
    });
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
