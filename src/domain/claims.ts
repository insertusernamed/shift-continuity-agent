/**
 * Deterministic claim normalization (milestone Part 2).
 *
 * Conflict detection compares canonical claim concepts, not raw strings, so
 * "send to claims" and "claims" are recognized as the same disposition and do
 * not create a false conflict. The mapping is an explicit table — deterministic,
 * no LLM involved (AGENTS.md §6) — and unknown claims are retained as
 * normalized raw text rather than guessed at.
 *
 * Extending the vocabulary is a one-line table edit; genuinely different
 * canonical concepts still conflict.
 */

const CLAIM_VOCABULARY: Readonly<Record<string, string>> = {
  // claims disposition
  claims: "claims",
  claim: "claims",
  "send to claims": "claims",
  "send it to claims": "claims",
  "send to the claims": "claims",
  "to claims": "claims",
  "goes to claims": "claims",
  "went to claims": "claims",

  // discard / disposal
  discard: "discard",
  discarded: "discard",
  dispose: "discard",
  disposed: "discard",
  "dispose of": "discard",
  "disposed of": "discard",
  "was disposed": "discard",
  "was disposed of": "discard",
  "was discarded": "discard",
  "throw away": "discard",
  "thrown away": "discard",
  "throw it away": "discard",
  "throw out": "discard",
  "thrown out": "discard",
  trash: "discard",
  trashed: "discard",

  // other common dispositions, kept explicit so behavior is auditable
  salvage: "salvage",
  donation: "donate",
  donate: "donate",
  "return to vendor": "return to vendor",
  rtv: "return to vendor",
};

/** Canonical concept for a raw claim string; unknown claims pass through normalized. */
export function canonicalClaim(raw: string): string {
  const normalized = normalizeClaim(raw);
  return CLAIM_VOCABULARY[normalized] ?? normalized;
}

/** Equality for conflict comparison: canonical concepts, never raw strings. */
export function claimsEquivalent(a: string, b: string): boolean {
  return canonicalClaim(a) === canonicalClaim(b);
}

function normalizeClaim(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
}
