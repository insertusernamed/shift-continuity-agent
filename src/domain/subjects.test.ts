import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSubject,
  registerSubjectAliases,
  resetSubjectAliases,
} from "./subjects.ts";

beforeEach(() => resetSubjectAliases());

describe("canonicalSubject: casing and whitespace", () => {
  it("is case-insensitive and whitespace-insensitive", () => {
    assert.equal(canonicalSubject("Aisle 7"), canonicalSubject("aisle 7"));
    assert.equal(canonicalSubject("  Damaged   Case  D104 "), canonicalSubject("damaged case d104"));
  });
});

describe("canonicalSubject: D104 family merges to one identity", () => {
  it("all reported forms of the same case share one canonical identity", () => {
    const forms = ["D104", "case D104", "Case D104", "damaged case D104"];
    const identities = new Set(forms.map(canonicalSubject));
    assert.equal(identities.size, 1, `expected one identity, got ${[...identities].join(", ")}`);
  });

  it("keeps the identifier readable in the canonical form", () => {
    assert.equal(canonicalSubject("Damaged Case D104"), "d104");
  });
});

describe("canonicalSubject: conservative by design", () => {
  it("does not strip 'case' when no ID-like token follows (no merge of unrelated subjects)", () => {
    assert.equal(canonicalSubject("case of soda"), canonicalSubject("case of soda"));
    assert.notEqual(canonicalSubject("case of soda"), "soda");
  });

  it("never merges subjects that differ in their identifier", () => {
    assert.notEqual(canonicalSubject("damaged case D104"), canonicalSubject("damaged case D105"));
  });

  it("leaves ordinary subjects untouched apart from normalization", () => {
    assert.equal(canonicalSubject("freezer inspection"), "freezer inspection");
    assert.equal(canonicalSubject("Pallet 83"), "pallet 83");
  });

  it("does not attempt fuzzy or edit-distance matching", () => {
    // One character apart but semantically unrelated: must stay distinct.
    assert.notEqual(canonicalSubject("forklift 1"), canonicalSubject("forklift 2"));
  });
});

describe("canonicalSubject: configurable aliases", () => {
  it("maps a normalized input key to its configured canonical subject", () => {
    registerSubjectAliases({ "forklift two": "forklift 2" });
    assert.equal(canonicalSubject("Forklift  Two"), "forklift 2");
  });

  it("does not merge subjects with no configured alias", () => {
    registerSubjectAliases({ "forklift two": "forklift 2" });
    assert.notEqual(canonicalSubject("forklift 3"), canonicalSubject("forklift 2"));
  });

  it("unregistered subjects pass through canonicalization unchanged", () => {
    registerSubjectAliases({ "forklift two": "forklift 2" });
    assert.equal(canonicalSubject("compressor"), "compressor");
  });
});
