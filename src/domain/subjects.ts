/**
 * Deterministic subject identity (milestone Part 1).
 *
 * Events are matched by canonical subject, not raw text, so equivalent
 * phrasings of the same entity land on one operational item instead of
 * splitting into false duplicates. Two merge mechanisms, both conservative:
 *
 * 1. explicitly configured aliases (normalized key -> canonical subject)
 * 2. a narrow structural shape: [qualifier adjectives] container ID
 *    ("damaged case D104" -> "d104"), only when the identifier is a
 *    letter-led token containing a digit
 *
 * Deliberately NO fuzzy/edit-distance matching: failing to merge is safer
 * than merging unrelated operational items (AGENTS.md §7).
 */

/** Letter-led identifier containing a digit: "d104", "a1", "d-104". Bare numbers ("83") are too ambiguous to strip a container for. */
const ID_TOKEN = /^[a-z][a-z-]*\d+[a-z0-9-]*$/;

const QUALIFIERS: ReadonlySet<string> = new Set([
  "damaged", "broken", "opened", "unopened", "wet", "crushed", "leaking", "frozen", "expired",
]);

const CONTAINERS: ReadonlySet<string> = new Set([
  "case", "pallet", "box", "bag", "crate", "tote", "sku",
]);

const aliases = new Map<string, string>();

/** Register alias mappings; keys and values are canonicalized on the way in. */
export function registerSubjectAliases(map: Record<string, string>): void {
  for (const [from, to] of Object.entries(map)) {
    aliases.set(normalizeText(from), normalizeText(to));
  }
}

/** Test isolation hook: clears configured aliases. */
export function resetSubjectAliases(): void {
  aliases.clear();
}

/** Canonical identity for a reported subject string. */
export function canonicalSubject(subject: string): string {
  const normalized = normalizeText(subject);
  const aliased = aliases.get(normalized);
  if (aliased) return aliased;
  return stripQualifierAndContainer(normalized);
}

function normalizeText(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "");
}

/**
 * "damaged case D104" -> "d104"; "case D104" -> "d104"; "D104" -> "d104".
 * Anything not matching the [qualifier]* container ID shape is returned
 * unchanged. Bare-number identifiers ("pallet 83") keep their container so
 * an unrelated "bin 83" can never merge with "pallet 83".
 */
function stripQualifierAndContainer(s: string): string {
  const words = s.split(" ");
  let i = 0;
  while (i < words.length - 2 && QUALIFIERS.has(words[i]!)) i++;
  const isContainerPlusId =
    words.length - i === 2 && CONTAINERS.has(words[i]!) && ID_TOKEN.test(words[i + 1]!);
  return isContainerPlusId ? words[i + 1]! : s;
}
