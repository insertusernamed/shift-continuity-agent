import type { OperationalEvent } from "../domain/types.ts";
import { canonicalSubject } from "../domain/subjects.ts";

/**
 * What an interpreter owes the pipeline: structured, schema-checked intent
 * for one reported event. OccurredAt is supplied by the caller (deterministic
 * clock), never by the interpreter — timestamps are not interpreter work (§6).
 */
export interface InterpretationRequest {
  text: string;
}

export interface EventInterpreter {
  interpret(request: InterpretationRequest): Promise<InterpretedEvent>;
}

/** InterpretedEvent mirrors OperationalEvent minus identity/timestamps. */
export type InterpretedEvent = Omit<OperationalEvent, "id" | "shiftId" | "occurredAt">;

/**
 * Provider-neutral completion boundary: the LLM adapter depends on this,
 * never on a vendor SDK (AGENTS.md §5). Any OpenAI-compatible endpoint is
 * wrapped behind it, so tests inject deterministic fakes.
 */
export interface LlmCompletion {
  text: string;
}

export interface LlmClient {
  complete(prompt: string): Promise<LlmCompletion>;
}

/**
 * Rule-based interpreter: the always-available offline baseline. Matches
 * case-insensitively but preserves the reporter's subject casing; anything
 * unparseable fails loudly instead of guessing.
 */
export class DeterministicEventInterpreter implements EventInterpreter {
  async interpret(request: InterpretationRequest): Promise<InterpretedEvent> {
    const text = request.text.trim();

    // Disposition claim: "damaged case D104 should go to claims" / "... was discarded"
    const disposition = text.match(
      /^(.+?)\s+(?:should\s+)?(?:go\s+to|was|is)\s+(claims|discarded|discard|salvage|donation|return to vendor)$/i,
    );
    if (disposition) {
      return {
        kind: "status_claimed",
        subject: disposition[1]!.trim(),
        description: text,
        source: "nl-ingest",
        claim: normalizeDisposition(disposition[2]!.toLowerCase()),
      };
    }

    // Causal problem: "Pallet 83 couldn't go out because aisle 7 is blocked."
    const causal = text.match(/^(.+?)\s+(?:couldn't|could not|cannot|can't)\b(.*)$/i);
    if (causal) {
      const because = causal[2]!.match(/because\s+(.+?)\s+(?:is|are|was)\s+blocked/i);
      return {
        kind: "problem_reported",
        subject: causal[1]!.trim(),
        description: text,
        source: "nl-ingest",
        ...(because ? { blockedBy: canonicalSubject(because[1]!) } : {}),
      };
    }

    if (/\b(cleared|unblocked|open again)\b/i.test(text)) {
      return {
        kind: "cleared",
        subject: stripResolutionPhrases(text),
        description: text,
        source: "nl-ingest",
      };
    }

    if (/\b(completed|done|finished)\b/i.test(text)) {
      return {
        kind: "work_completed",
        subject: stripResolutionPhrases(text),
        description: text,
        source: "nl-ingest",
      };
    }

    throw new InterpretationError(`could not interpret report: "${text}"`);
  }
}

/** "aisle 7 is cleared" -> "aisle 7"; "pallet 83 completed" -> "pallet 83". */
function stripResolutionPhrases(s: string): string {
  return s
    .replace(/\b(is|are|was|now)\b/gi, " ")
    .replace(/\b(cleared|unblocked|open again|completed|done|finished)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDisposition(raw: string): string {
  if (raw.startsWith("discard")) return "discarded";
  if (raw === "claims") return "send to claims";
  return raw;
}

export class InterpretationError extends Error {}

/** Controlled failure for provider/network problems during interpretation. */
export class ProviderError extends InterpretationError {}
