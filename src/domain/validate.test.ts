import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEvent } from "./validate.ts";
import { canonicalSubject } from "./subjects.ts";
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

  it("preserves the reported subject verbatim; canonical identity is derived separately", () => {
    const validated = validateEvent({ ...base, subject: "  Damaged   Case  D104 " });
    assert.equal(validated.subject, "  Damaged   Case  D104 ");
    assert.equal(canonicalSubject(validated.subject), "d104");
  });

  // blockedBy is canonicalized so causal links survive phrasing differences.
  it("canonicalizes blockedBy references", () => {
    const validated = validateEvent({ ...base, blockedBy: "  Damaged Case D104 " });
    assert.equal(validated.blockedBy, "d104");
  });
});

describe("photo evidence validation", () => {
  const photo = { id: "ev-1", fileName: "d104.png", contentType: "image/png", note: "D104 was crushed" };

  it("accepts image evidence metadata on an event", () => {
    const validated = validateEvent({ ...base, evidence: [photo] });
    assert.deepEqual(validated.evidence, [photo]);
  });

  it("treats absent evidence as absent, not empty", () => {
    assert.equal("evidence" in validateEvent(base), false);
  });

  it("rejects evidence whose content type is not an image", () => {
    rejectsWith({ ...base, evidence: [{ ...photo, contentType: "application/pdf" }] }, "contentType");
  });

  it("rejects malformed evidence entries", () => {
    rejectsWith({ ...base, evidence: "d104.png" }, "evidence");
    rejectsWith({ ...base, evidence: [{ ...photo, id: "" }] }, "id");
    rejectsWith({ ...base, evidence: [{ ...photo, fileName: "" }] }, "fileName");
    rejectsWith({ ...base, evidence: [{ ...photo, note: "" }] }, "note");
  });
});
