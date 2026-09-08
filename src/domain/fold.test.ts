import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { foldState } from "./state.ts";
import { buildHandoff } from "./handoff.ts";
import { validateEvent } from "./validate.ts";
import { registerSubjectAliases, resetSubjectAliases } from "./subjects.ts";
import type { OperationalEvent, Shift } from "./types.ts";

beforeEach(() => resetSubjectAliases());

const TEST_SHIFT: Shift = { id: "shift-1", name: "Test Shift", startedAt: "2026-09-08T02:00:00.000Z" };

function ev(partial: Omit<OperationalEvent, "id" | "shiftId" | "source"> & { source?: string }): OperationalEvent {
  const candidate: OperationalEvent = {
    id: partial.occurredAt + "-" + partial.kind + "-" + partial.subject,
    shiftId: "shift-1",
    source: partial.source ?? "radio",
    ...partial,
  };
  return validateEvent(candidate);
}

function itemFor(items: ReturnType<typeof foldState>["items"], subjectPart: string) {
  const item = items.find((i) => i.subject.toLowerCase().includes(subjectPart.toLowerCase()));
  assert.ok(item, `expected an item matching "${subjectPart}"`);
  return item;
}

describe("subject alias resolution through the fold", () => {
  it("D104 and 'damaged case D104' land on one operational item", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "D104", description: "claims", claim: "send to claims", source: "scanner" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "damaged case D104", description: "discarded", claim: "discarded", source: "operator" }),
    ]);
    assert.equal(state.items.length, 1, "equivalent subjects must merge into one item");
    assert.equal(itemFor(state.items, "D104").status, "conflicted");
  });

  it("preserves each reported subject string for display; identity is separate", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "D104", description: "claims", claim: "send to claims" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "Damaged Case D104", description: "discarded", claim: "discarded" }),
    ]);
    const item = itemFor(state.items, "D104");
    assert.deepEqual(state.events.map((e) => e.subject), ["D104", "Damaged Case D104"]);
    assert.equal(item.canonicalSubject, "d104");
  });

  it("configured aliases merge subjects that share no structural shape", () => {
    registerSubjectAliases({ "compressor two": "compressor 2" });
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "compressor 2", description: "overheating" }),
      ev({ occurredAt: "2026-09-08T02:30:00Z", kind: "problem_reported", subject: "Compressor Two", description: "overheating again" }),
    ]);
    assert.equal(state.items.length, 1);
  });

  it("does not merge unrelated subjects with the same number", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T02:11:00Z", kind: "problem_reported", subject: "pallet 83", description: "blocked" }),
      ev({ occurredAt: "2026-09-08T02:12:00Z", kind: "problem_reported", subject: "bin 83", description: "blocked" }),
    ]);
    assert.equal(state.items.length, 2, "bare-number identifiers must keep their container word");
  });
});

describe("claim normalization through the fold", () => {
  it("equivalent dispositions ('send to claims' then 'claims') do NOT create a conflict", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "case D104", description: "send to claims", claim: "send to claims", source: "scanner" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "case D104", description: "claims", claim: "claims", source: "operator" }),
    ]);
    const item = itemFor(state.items, "D104");
    assert.equal(item.status, "open", "same canonical disposition must stay open, not conflicted");
    assert.equal(buildHandoff(state).requiresHumanReview.length, 0);
  });

  it("different canonical dispositions ('send to claims' then 'discarded') DO conflict", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "case D104", description: "send to claims", claim: "send to claims", source: "scanner" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "case D104", description: "discarded", claim: "discarded", source: "operator" }),
    ]);
    const item = itemFor(state.items, "D104");
    assert.equal(item.status, "conflicted");
    assert.equal(buildHandoff(state).requiresHumanReview.length, 1);
  });

  it("unknown but identical claims behave normally (no false conflict, no merge)", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "case D104", description: "hold", claim: "Hold For Vendor Pickup" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "case D104", description: "hold again", claim: "hold for vendor pickup" }),
    ]);
    assert.equal(itemFor(state.items, "D104").status, "open");
  });

  it("unknown differing claims still conflict — normalization never hides real contradictions", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "case D104", description: "hold", claim: "hold for vendor pickup" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "case D104", description: "quarantine", claim: "quarantine shelf 4" }),
    ]);
    assert.equal(itemFor(state.items, "D104").status, "conflicted");
  });

  it("raw claim text stays available in history and on the item", () => {
    const state = foldState(TEST_SHIFT, [
      ev({ occurredAt: "2026-09-08T05:02:00Z", kind: "status_claimed", subject: "case D104", description: "send to claims", claim: "send to claims", source: "scanner" }),
      ev({ occurredAt: "2026-09-08T05:14:00Z", kind: "status_claimed", subject: "case D104", description: "discarded", claim: "discarded", source: "operator" }),
    ]);
    const item = itemFor(state.items, "D104");
    assert.deepEqual(item.claims.map((c) => c.value), ["send to claims", "discarded"], "raw claim values are preserved on the item");
    assert.deepEqual(state.events.map((e) => e.claim), ["send to claims", "discarded"], "raw claim values are preserved in history");
  });
});

