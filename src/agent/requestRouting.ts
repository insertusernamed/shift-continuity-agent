import { canonicalClaim } from "../domain/claims.ts";
import { canonicalSubject } from "../domain/subjects.ts";
import type { HumanDecisionAuthorization } from "./tools.ts";

/**
 * Deterministic request routing for the Strands agent.
 *
 * The model is the orchestrator of tool selection, but it must never be the
 * authority on two things: (1) whether the current request legally authorizes
 * a human decision, and (2) which obvious kind of request this is. This module
 * answers both deterministically; the Strands loop still invokes the tools and
 * the tool gate still validates every decision call (§ Part 1/4).
 */

/** Explicit claims a human may select. Must stay aligned with domain/claims. */
const CLAIM = "(?<claim>claims|discard(?:ed)?|salvage|donat(?:e|ion))";

/** Letter-led identifier containing a digit, with optional container words. */
const SUBJECT = "(?:the\\s+)?(?:damaged\\s+)?(?:case\\s+)?(?<subject>[A-Za-z]+\\d+[A-Za-z0-9-]*)";

const IMPERATIVE = new RegExp(`\\b(?:send|move|route|mark|set)\\s+${SUBJECT}\\s+(?:to\\s+)?${CLAIM}\\b`, "i");
const WANT_DIRECT = new RegExp(
  `\\b(?:i\\s+)?(?:want|need)\\s+${SUBJECT}\\s+(?:(?:to\\s+)?(?:be\\s+)?(?:sent|moved|marked|routed|going|go)\\s+(?:to\\s+)?)?${CLAIM}\\b`,
  "i",
);
const WANT_TO_IMPERATIVE = new RegExp(
  `\\b(?:i\\s+)?(?:want|need)\\s+to\\s+(?:send|move|route|mark|set)\\s+${SUBJECT}\\s+(?:to\\s+)?${CLAIM}\\b`,
  "i",
);
const CHOOSE = new RegExp(`\\b(?:choose|pick|select)\\s+${CLAIM}\\s+(?:for|on)\\s+${SUBJECT}\\b`, "i");
const FOR = new RegExp(`\\bfor\\s+${SUBJECT}\\s*[,:]?\\s+(?:use|go\\s+with|we\\s+(?:use|go\\s+with))\\s+${CLAIM}\\b`, "i");
const DECLARATIVE = new RegExp(
  `\\b${SUBJECT}\\s+(?:should|must)\\s+(?:go|be\\s+(?:sent|marked|routed|moved))\\s+(?:to\\s+)?${CLAIM}\\b`,
  "i",
);

/**
 * Conservative parser used only to establish that a human explicitly selected
 * a value for the current request. It never chooses a value and does not
 * inspect history. The decision tool performs the authoritative validation.
 */
export function extractExplicitHumanDecision(text: string): HumanDecisionAuthorization | undefined {
  const patterns = [IMPERATIVE, WANT_DIRECT, WANT_TO_IMPERATIVE, CHOOSE, FOR, DECLARATIVE];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const subject = match.groups?.subject;
    const claim = match.groups?.claim;
    if (!subject || !claim) continue;
    return {
      subject,
      canonicalSubject: canonicalSubject(subject),
      claim,
      canonicalClaim: canonicalClaim(claim),
    };
  }
  return undefined;
}

/**
 * A reopen the current request explicitly asks for. It deliberately carries no
 * actor: who is acting is application context, not something parsed out of the
 * user's words, and the agent attaches it before invoking the tool.
 */
export interface ReopenRequest {
  subject: string;
  canonicalSubject: string;
  reason?: string;
}

/**
 * Explicit reopen phrasings. Conservative by construction: an undo verb is
 * required, it must name a specific subject, and questions or hedges
 * ("was D104 decided correctly?", "maybe we should change D104") never qualify.
 * "Reconsider it" is refused because it names no subject.
 */
const REOPEN_SUBJECT = new RegExp(
  `\\b(?:reopen|re-open|reconsider|undo)\\b(?:\\s+(?:the\\s+)?(?:decision|choice)\\s+(?:on|for))?\\s+${SUBJECT}\\b`,
  "i",
);

/** Deterministic reopen authorization for the current request, if any. */
export function extractExplicitReopenRequest(text: string): ReopenRequest | undefined {
  const match = text.match(REOPEN_SUBJECT);
  const subject = match?.groups?.subject;
  if (!subject) return undefined;
  const reason = extractReason(text);
  return {
    subject,
    canonicalSubject: canonicalSubject(subject),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The optional "why" a human typed. Only an explicit causal marker counts, so
 * the reason recorded in the audit trail is the human's words rather than a
 * paraphrase an agent invented.
 */
function extractReason(text: string): string | undefined {
  const match = text.match(/\b(?:because|reason:)\s+(.+)$/i);
  const reason = match?.[1]?.trim().replace(/[.;]+$/, "").trim();
  return reason ? reason.slice(0, 200) : undefined;
}

export type AgentRequestIntent = "report" | "state" | "handoff" | "decision" | "reopen";

/**
 * Deterministic intent for one user request. Operational reports — including
 * odd or uninterpretable ones — default to `report` so the validated ingestion
 * pipeline gets the chance to accept or reject them instead of the model
 * silently answering an unrelated state question.
 */
export function classifyAgentRequest(text: string): AgentRequestIntent {
  // Reopen is checked first and deliberately wins over decision: if a request
  // both asks to reopen and looks like it names a claim, treating it as a
  // reopen cannot silently settle a conflict, which is the safer failure.
  if (extractExplicitReopenRequest(text)) return "reopen";
  if (extractExplicitHumanDecision(text)) return "decision";
  if (looksLikeHandoffQuestion(text)) return "handoff";
  if (looksLikeStateQuestion(text)) return "state";
  return "report";
}

/**
 * Per-invocation system-prompt directive derived from deterministic routing.
 * The Strands agent stays the orchestrator: it still picks and calls the tool,
 * but for obvious cases it is told authoritatively what to do instead of being
 * left to guess. Returns undefined when no directive applies.
 */
export function routingDirective(invocationState: Record<string, unknown>): string | undefined {
  const reopen = invocationState.reopenAuthorization;
  if (isReopenAuthorization(reopen)) {
    return [
      "Deterministic human authorization (authoritative for this request): the human explicitly asked to",
      `reopen the decision on ${reopen.subject}. Call reopen_human_decision with subject="${reopen.subject}"`,
      "exactly. The actor and reason are supplied by the application; do not invent or alter them.",
    ].join(" ");
  }
  const authorization = invocationState.humanDecisionAuthorization;
  if (isHumanDecisionAuthorization(authorization)) {
    return [
      "Deterministic human authorization (authoritative for this request): the human explicitly selected",
      `"${authorization.claim}" for ${authorization.subject}. Call record_human_decision with`,
      `subject="${authorization.subject}" and claim="${authorization.claim}" exactly.`,
      "Do not choose between claims yourself; the human already chose.",
    ].join(" ");
  }
  if (invocationState.routingIntent === "report") {
    return [
      "Deterministic routing (authoritative for this request): the current user message is an operational",
      "report, even if it sounds odd or cannot be interpreted. Call report_event with the full user text as",
      "the report and let the deterministic validator accept or reject it. Do not call get_shift_state or",
      "get_handoff instead, and do not answer from memory.",
    ].join(" ");
  }
  if (invocationState.routingIntent === "state") {
    return [
      "Deterministic routing (authoritative for this request): the user is asking about current operational",
      "state. Call get_shift_state and answer only from its result; never recalculate state or answer from",
      "memory. If any item is conflicted, present the conflicting claims and say a human decision is required.",
      "Do NOT call record_human_decision: no human selected a claim in this request, so it is not authorized",
      "and the tool will refuse.",
    ].join(" ");
  }
  return undefined;
}

function looksLikeHandoffQuestion(text: string): boolean {
  return /\b(?:handoff|what(?:'s| is) left|morning shift|next shift|remaining)\b/i.test(text);
}

function looksLikeStateQuestion(text: string): boolean {
  return /\b(?:current state|what should we do|what do we do|conflict|conflicted|pick|choose|decide|review|open items?)\b/i.test(text);
}

export function isReopenAuthorization(value: unknown): value is ReopenRequest & { actor: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReopenRequest & { actor: string }>;
  return typeof candidate.subject === "string"
    && typeof candidate.canonicalSubject === "string"
    && typeof candidate.actor === "string"
    && candidate.actor.trim().length > 0;
}

export function isHumanDecisionAuthorization(value: unknown): value is HumanDecisionAuthorization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HumanDecisionAuthorization>;
  return typeof candidate.subject === "string"
    && typeof candidate.claim === "string"
    && typeof candidate.canonicalSubject === "string"
    && typeof candidate.canonicalClaim === "string";
}