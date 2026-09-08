import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEvent, subjectKey } from "./validate.ts";
import type { OperationalEvent } from "./types.ts";

const base: OperationalEvent = {
  id: "e1",
  shiftId: "shift-1",
  occurredAt: "2026-09-08T02:11:00Z",
  kind: "problem_reported",
  subject: "aisle 7",
  description: "aisle 7 blocked",
  source: "radio",
};

function rejectsWith(candidate: unknown, messagePart: string) {
  assert.throws(() => validateEvent(candidate), (err: Error) => err.message.includes(messagePart));
}

describe("event validation", () => {
  it("accepts a valid event unchanged", () => {
    const canonical: OperationalEvent = { ...base, occurredAt: "2026-09-08T02:11:00.000Z" };
    assert.deepEqual(validateEvent(base), canonical);
  });

  it("rejects missing required fields", () => {
    rejectsWith({ ...base, subject: "" }, "subject");
    rejectsWith({ ...base, description: "" }, "description");
    rejectsWith({ ...base, source: "" }, "source");
    rejectsWith({ ...base, shiftId: "" }, "shiftId");
    rejectsWith({ ...base, occurredAt: "" }, "occurredAt");
  });

  it("rejects unknown kinds", () => {
    rejectsWith({ ...base, kind: "vibes" }, "kind");
  });

  it("rejects non-ISO timestamps", () => {
    rejectsWith({ ...base, occurredAt: "yesterday" }, "occurredAt");
    rejectsWith({ ...base, occurredAt: "2026-13-45T99:00:00Z" }, "occurredAt");
  });

  it("requires claim for status_claimed events", () => {
    rejectsWith({ ...base, kind: "status_claimed" }, "claim");
  });

  it("requires claim for decision_recorded events", () => {
    rejectsWith({ ...base, kind: "decision_recorded" }, "claim");
  });

  it("normalizes subject keys so differently-cased reports match one item", () => {
    assert.equal(subjectKey("Aisle 7"), subjectKey("aisle 7"));
    assert.equal(subjectKey("  Damaged   Case  D104 "), subjectKey("damaged case d104"));
  });

  it("rejects empty claim values", () => {
    rejectsWith({ ...base, kind: "status_claimed", claim: "" }, "claim");
    rejectsWith({ ...base, kind: "status_claimed", claim: "   " }, "claim");
  });
});
