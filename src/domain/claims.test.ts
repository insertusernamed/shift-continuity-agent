import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalClaim, claimsEquivalent } from "./claims.ts";

describe("canonicalClaim: disposition vocabulary", () => {
  it("maps every 'claims' phrasing to the canonical concept", () => {
    for (const raw of ["claims", "send to claims", "send it to claims", "Send  to CLAIMS."]) {
      assert.equal(canonicalClaim(raw), "claims", `"${raw}" should canonicalize to "claims"`);
    }
  });

  it("maps every discard phrasing to the canonical concept", () => {
    for (const raw of ["discard", "discarded", "dispose", "disposed", "thrown away"]) {
      assert.equal(canonicalClaim(raw), "discard", `"${raw}" should canonicalize to "discard"`);
    }
  });

  it("normalizes casing, whitespace, and trailing punctuation", () => {
    assert.equal(canonicalClaim("  Discarded.  "), "discard");
  });

  it("retains unknown claims as normalized raw text instead of guessing", () => {
    assert.equal(canonicalClaim("Hold For Vendor Pickup"), "hold for vendor pickup");
    assert.equal(canonicalClaim("quarantine shelf 4"), "quarantine shelf 4");
  });
});

describe("claimsEquivalent: equality uses the canonical concept", () => {
  it("semantically identical mapped claims are equivalent", () => {
    assert.ok(claimsEquivalent("send to claims", "claims"));
    assert.ok(claimsEquivalent("discarded", "was disposed"));
  });

  it("genuinely different dispositions are NOT equivalent", () => {
    assert.ok(!claimsEquivalent("claims", "discard"));
  });

  it("unknown claims compare as their normalized text", () => {
    assert.ok(claimsEquivalent("Hold For Vendor Pickup", "hold for vendor pickup"));
    assert.ok(!claimsEquivalent("hold for vendor pickup", "hold for vendor 5"));
  });
});
