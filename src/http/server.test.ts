import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { JsonFileShiftStore } from "../store/jsonFileStore.ts";
import { FileEvidenceStore } from "../store/evidenceStore.ts";

let server: Awaited<ReturnType<typeof startServer>> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "shift-api-"));
  const store = new JsonFileShiftStore(join(dir, "shifts.json"));
  const evidenceDir = join(dir, "evidence");
  server = await startServer({ store, port: 0, evidenceStore: new FileEvidenceStore(evidenceDir) });
  return {
    baseUrl: server.url,
    evidenceDir,
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

  it("regression: close() resolves only after full shutdown, so the port can be rebound immediately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shift-close-"));
    try {
      const store = new JsonFileShiftStore(join(dir, "shifts.json"));
      const first = await startServer({ store, port: 0 });
      const closePromise = first.close();
      assert.ok(closePromise instanceof Promise, "close() must return a promise the smoke harness can await");
      await closePromise;

      // Immediate rebind on the same port: only safe if close() fully released it.
      const second = await startServer({ store, port: first.port });
      server = second;
      const res = await fetch(second.url + "/api/shifts");
      assert.equal(res.status, 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  describe("decision provenance and reopen endpoint", () => {
    async function makeDecidedApp(actor = "Shift Supervisor") {
      const app = await makeApp();
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims", source: "scanner",
      });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
        occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator",
      });
      await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/items/d104/decision`, { claim: "send to claims", actor });
      return { app, shiftId: shift.id as string };
    }

    it("records the acting human and an optional note on the decision event", async () => {
      const app = await makeApp();
      try {
        const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
        await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
          occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "damaged case D104", description: "send to claims", claim: "send to claims", source: "scanner",
        });
        await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
          occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "D104", description: "discarded", claim: "discarded", source: "operator",
        });

        const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/items/d104/decision`, {
          claim: "send to claims",
          actor: "Shift Supervisor",
          note: "scanner label was correct",
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.event.actor, "Shift Supervisor");
        assert.equal(res.body.event.note, "scanner label was correct");
        assert.equal(res.body.item.decision.actor, "Shift Supervisor");

        // Provenance is part of the append-only history, not a side channel.
        const events = await api(app.baseUrl, "GET", `/api/shifts/${shift.id}/events`);
        const decision = events.body.find((e: any) => e.kind === "decision_recorded");
        assert.equal(decision.actor, "Shift Supervisor");
      } finally {
        app.cleanup();
      }
    });

    it("reopens a decided item: it returns to human review and history keeps the decision", async () => {
      const { app, shiftId } = await makeDecidedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/reopen`, {
          actor: "Shift Supervisor",
          reason: "Claims ticket was created in error",
        });

        assert.equal(res.status, 200);
        assert.equal(res.body.event.kind, "decision_reopened");
        assert.equal(res.body.event.actor, "Shift Supervisor");
        assert.equal(res.body.item.status, "conflicted");
        assert.equal(res.body.item.decision.canonicalValue, "claims", "the superseded decision stays visible");

        const handoff = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/handoff`);
        assert.equal(handoff.body.requiresHumanReview.length, 1);
        assert.equal(handoff.body.decidedDuringShiftCount, 0);

        // A new explicit human decision settles it again, and the original
        // decision event is still on the record.
        const redecorate = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/decision`, { claim: "discard", actor: "Shift Supervisor" });
        assert.equal(redecorate.status, 200);
        assert.equal(redecorate.body.item.status, "decided");
        assert.equal(redecorate.body.item.decision.canonicalValue, "discard");

        const events = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/events`);
        assert.deepEqual(
          events.body.map((e: any) => e.kind),
          ["status_claimed", "status_claimed", "decision_recorded", "decision_reopened", "decision_recorded"],
        );
      } finally {
        app.cleanup();
      }
    });

    it("409 when reopening an item that is not decided", async () => {
      const app = await makeApp();
      try {
        const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "Night Shift" });
        await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events`, {
          occurredAt: "2026-09-08T04:46:00Z", kind: "problem_reported", subject: "freezer inspection", description: "missed", source: "radio",
        });
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/items/${encodeURIComponent("freezer inspection")}/reopen`, { actor: "Shift Supervisor" });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, "item_not_decided");
        assert.match(res.body.error, /not decided/i);
      } finally {
        app.cleanup();
      }
    });

    it("400 when reopening without naming who authorized it", async () => {
      const { app, shiftId } = await makeDecidedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/items/d104/reopen`, {});
        assert.equal(res.status, 400);
        assert.equal(res.body.code, "missing_actor");

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        assert.equal(state.body.items[0].status, "decided", "a refused reopen must not mutate state");
      } finally {
        app.cleanup();
      }
    });

    it("regression: decision_reopened cannot be smuggled through the generic event endpoint", async () => {
      const { app, shiftId } = await makeDecidedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/events`, {
          occurredAt: "2026-09-08T06:05:00Z", kind: "decision_reopened", subject: "damaged case D104", description: "bypass attempt", source: "operator",
        });
        assert.equal(res.status, 400);
        assert.match(res.body.error, /reopen/i);

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        assert.equal(state.body.items[0].status, "decided", "state must be unchanged");
      } finally {
        app.cleanup();
      }
    });

    it("attributes an agent-routed decision and reopen to the actor the client supplied", async () => {
      const { app, shiftId } = await makeDecidedApp("Dana");
      try {
        const reopen = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, {
          message: "Reopen D104 because the disposal record was wrong",
          actor: "Dana",
        });
        assert.equal(reopen.status, 200);
        assert.equal(reopen.body.ok, true);
        assert.deepEqual(reopen.body.toolTrace.map((t: any) => t.tool), ["reopen_human_decision"]);
        assert.equal(reopen.body.item.status, "conflicted");

        const decide = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, {
          message: "Send D104 to claims.",
          actor: "Dana",
        });
        assert.equal(decide.status, 200);
        assert.equal(decide.body.decision.actor, "Dana");
        assert.equal(decide.body.item.status, "decided");
      } finally {
        app.cleanup();
      }
    });

    it("refuses an agent reopen when the client supplies no actor", async () => {
      const { app, shiftId } = await makeDecidedApp();
      try {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shiftId}/agent`, { message: "Reopen D104" });
        assert.equal(res.status, 502);
        assert.deepEqual(res.body.toolTrace.map((t: any) => t.tool), ["reopen_human_decision"]);
        assert.equal(res.body.toolTrace[0].status, "error");
        assert.match(res.body.error, /human authorization/i);

        const state = await api(app.baseUrl, "GET", `/api/shifts/${shiftId}/state`);
        assert.equal(state.body.items[0].status, "decided");
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

// Submission-prep milestone: photo evidence rides the same pipeline as text,
// so these tests pin the storage/serving boundary and the rejection paths.
describe("photo evidence API", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("stores a photo, attaches it to the interpreted event, and serves it back", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });
      const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events/photo`, {
        note: "Aisle 7 is blocked.",
        image: PNG.toString("base64"),
        contentType: "image/png",
        fileName: "aisle7.png",
        occurredAt: "2026-09-08T02:11:00Z",
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, "problem_reported");
      assert.equal(res.body.subject, "Aisle 7");
      assert.equal(res.body.source, "photo-ingest");
      assert.equal(res.body.evidence.length, 1);
      assert.equal(res.body.evidence[0].fileName, "aisle7.png");
      assert.equal(res.body.evidence[0].note, "Aisle 7 is blocked.");

      // The evidence is part of history, and the state fold picked the event up.
      const state = await api(app.baseUrl, "GET", `/api/shifts/${shift.id}/state`);
      assert.equal(state.body.events.length, 1);
      assert.equal(state.body.items[0].status, "open");

      const img = await fetch(`${app.baseUrl}/api/shifts/${shift.id}/evidence/${res.body.evidence[0].id}`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    } finally {
      app.cleanup();
    }
  });

  it("accepts a data-URL image, which is what a browser file input gives us", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });
      const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events/photo`, {
        note: "Aisle 7 is blocked.",
        image: `data:image/png;base64,${PNG.toString("base64")}`,
        contentType: "image/png",
        fileName: "aisle7.png",
      });
      assert.equal(res.status, 201);
    } finally {
      app.cleanup();
    }
  });

  // An uninterpretable note must not create an event *or* leave bytes behind.
  it("rejects an uninterpretable note with nothing persisted and nothing stored", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });
      const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events/photo`, {
        note: "the vibes are off today",
        image: PNG.toString("base64"),
        contentType: "image/png",
        fileName: "vibes.png",
      });
      assert.equal(res.status, 400);
      const events = await api(app.baseUrl, "GET", `/api/shifts/${shift.id}/events`);
      assert.deepEqual(events.body, []);
      assert.deepEqual(existsSync(app.evidenceDir) ? readdirSync(app.evidenceDir) : [], []);
    } finally {
      app.cleanup();
    }
  });

  it("rejects a non-image attachment and a missing note", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });
      for (const body of [
        { note: "Aisle 7 is blocked.", image: PNG.toString("base64"), contentType: "application/pdf", fileName: "x.pdf" },
        { note: "   ", image: PNG.toString("base64"), contentType: "image/png", fileName: "x.png" },
        { note: "Aisle 7 is blocked.", image: "", contentType: "image/png", fileName: "x.png" },
      ]) {
        const res = await api(app.baseUrl, "POST", `/api/shifts/${shift.id}/events/photo`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
      }
    } finally {
      app.cleanup();
    }
  });

  it("404s for unknown evidence and for an unknown shift", async () => {
    const app = await makeApp();
    try {
      const { body: shift } = await api(app.baseUrl, "POST", "/api/shifts", { name: "S" });
      const missing = await fetch(`${app.baseUrl}/api/shifts/${shift.id}/evidence/does-not-exist`);
      assert.equal(missing.status, 404);
      const photo = await api(app.baseUrl, "POST", "/api/shifts/nope/events/photo", {
        note: "Aisle 7 is blocked.",
        image: PNG.toString("base64"),
        contentType: "image/png",
        fileName: "x.png",
      });
      assert.equal(photo.status, 404);
    } finally {
      app.cleanup();
    }
  });
});
