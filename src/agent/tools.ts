import { tool, type InvokableTool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import type { OperationalEvent, OperationalItem, ShiftHandoff } from "../domain/types.ts";
import { buildHandoff } from "../domain/handoff.ts";
import { recordableDecision, DecisionValidationError } from "../domain/decide.ts";
import { canonicalClaim } from "../domain/claims.ts";
import { canonicalSubject } from "../domain/subjects.ts";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { EventInterpreter } from "../ingest/interpreter.ts";
import { ingestNaturalLanguageReport } from "../ingest/ingestEvent.ts";

export interface HumanDecisionAuthorization {
  subject: string;
  canonicalSubject: string;
  claim: string;
  canonicalClaim: string;
}

export type ToolName =
  | "report_event"
  | "get_shift_state"
  | "get_handoff"
  | "record_human_decision";

export interface ToolTrace {
  tool: ToolName;
  status: "success" | "error";
  summary: string;
}

export interface ToolFailure {
  ok: false;
  error: { message: string; code?: string };
}

export interface AgentItemView {
  id: string;
  subject: string;
  canonicalSubject: string;
  description: string;
  status: OperationalItem["status"];
  claims: Array<{ value: string; canonicalValue: string }>;
  decision?: { value: string; canonicalValue: string };
  blockedByCanonicalSubject?: string;
}

export interface ShiftStateToolResult {
  ok: true;
  shift: {
    id: string;
    name: string;
    startedAt: string;
    endedAt?: string;
    status: "open" | "ended";
  };
  openItems: AgentItemView[];
  conflictedItems: AgentItemView[];
  decidedItems: AgentItemView[];
}

export interface HandoffToolResult {
  ok: true;
  shiftId: string;
  shiftName: string;
  requiresAction: AgentItemView[];
  requiresHumanReview: AgentItemView[];
  resolvedDuringShiftCount: number;
  decidedDuringShiftCount: number;
}

export interface ReportEventToolResult {
  ok: true;
  event: OperationalEvent;
  item: AgentItemView;
  humanAttentionRequired: boolean;
}

export interface HumanDecisionToolResult {
  ok: true;
  event: OperationalEvent;
  item: AgentItemView;
}

export interface ReportEventInput {
  report: string;
  occurredAt?: string;
}

export interface HumanDecisionInput {
  subject: string;
  claim: string;
}

export type ReportEventTool = InvokableTool<ReportEventInput, ReportEventToolResult | ToolFailure>;

export type ShiftStateTool = InvokableTool<Record<string, never>, ShiftStateToolResult | ToolFailure>;

export type HandoffTool = InvokableTool<Record<string, never>, HandoffToolResult | ToolFailure>;

export type HumanDecisionTool = InvokableTool<HumanDecisionInput, HumanDecisionToolResult | ToolFailure>;

export type ToolObservationName = "reportEvent" | "shiftState" | "handoff" | "humanDecision";

export interface ToolObservations {
  lastTool?: ToolObservationName;
  reportEvent?: ReportEventToolResult | ToolFailure;
  shiftState?: ShiftStateToolResult | ToolFailure;
  handoff?: HandoffToolResult | ToolFailure;
  humanDecision?: HumanDecisionToolResult | ToolFailure;
}

export interface ShiftContinuityToolDependencies {
  store: ShiftStore;
  shiftId: string;
  interpreter: EventInterpreter;
  now?: () => string;
  onTrace?: (trace: ToolTrace) => void;
}

export interface ShiftContinuityTools {
  reportEvent: ReportEventTool;
  getShiftState: ShiftStateTool;
  getHandoff: HandoffTool;
  recordHumanDecision: HumanDecisionTool;
  tools: readonly InvokableTool<unknown, unknown>[];
  getTrace(): ToolTrace[];
  getObservations(): ToolObservations;
  clearTrace(): void;
}

/**
 * Create the only tools exposed to ShiftContinuityAgent. Every mutating tool
 * delegates to an existing application/domain service; no tool writes derived
 * state directly.
 */
export function createShiftContinuityTools(dependencies: ShiftContinuityToolDependencies): ShiftContinuityTools {
  const traces: ToolTrace[] = [];
  const observations: ToolObservations = {};

  function trace(entry: ToolTrace): void {
    traces.push(entry);
    dependencies.onTrace?.(entry);
  }

  function currentState() {
    const state = dependencies.store.getShiftState(dependencies.shiftId);
    if (!state) throw new Error(`unknown shift ${dependencies.shiftId}`);
    return state;
  }

  const reportEvent = tool({
    name: "report_event",
    description:
      "Interpret one worker's natural-language operational report, validate it, append it to the current shift, and return the deterministic resulting item state. Never claim acceptance if this tool returns ok=false.",
    inputSchema: z.object({
      report: z.string().min(1).describe("The worker's natural-language report."),
      occurredAt: z.string().min(1).optional().describe("Optional ISO timestamp for the report."),
    }),
    callback: async (input) => {
      try {
        const event = await ingestNaturalLanguageReport({
          store: dependencies.store,
          shiftId: dependencies.shiftId,
          interpreter: dependencies.interpreter,
          text: input.report,
          occurredAt: input.occurredAt,
          now: dependencies.now,
        });
        const state = currentState();
        const item = state.items.find((candidate) => candidate.canonicalSubject === canonicalSubject(event.subject));
        if (!item) throw new Error("accepted event did not produce a deterministic operational item");
        const result: ReportEventToolResult = {
          ok: true,
          event,
          item: toItemView(item),
          humanAttentionRequired: item.status === "open" || item.status === "conflicted",
        };
        observations.reportEvent = result;
        observations.lastTool = "reportEvent";
        trace({
          tool: "report_event",
          status: "success",
          summary: `accepted — ${item.subject} ${item.status.toUpperCase()}`,
        });
        return result;
      } catch (error) {
        const failure = failureResult(error);
        observations.reportEvent = failure;
        observations.lastTool = "reportEvent";
        trace({ tool: "report_event", status: "error", summary: failure.error.message });
        return failure;
      }
    },
  });

  const getShiftState = tool({
    name: "get_shift_state",
    description:
      "Read the deterministic current state of the shift. Use this whenever the user's question depends on what is currently true; do not infer state from conversation memory.",
    inputSchema: z.object({}),
    callback: () => {
      try {
        const state = currentState();
        const result: ShiftStateToolResult = {
          ok: true,
          shift: {
            ...state.shift,
            status: state.shift.endedAt ? "ended" : "open",
          },
          openItems: state.items.filter((item) => item.status === "open").map(toItemView),
          conflictedItems: state.items.filter((item) => item.status === "conflicted").map(toItemView),
          decidedItems: state.items.filter((item) => item.status === "decided").map(toItemView),
        };
        observations.shiftState = result;
        observations.lastTool = "shiftState";
        trace({
          tool: "get_shift_state",
          status: "success",
          summary: `read — ${result.openItems.length} open, ${result.conflictedItems.length} conflicted`,
        });
        return result;
      } catch (error) {
        const failure = failureResult(error);
        observations.shiftState = failure;
        observations.lastTool = "shiftState";
        trace({ tool: "get_shift_state", status: "error", summary: failure.error.message });
        return failure;
      }
    },
  });

  const getHandoff = tool({
    name: "get_handoff",
    description:
      "Return the authoritative deterministic handoff projection. Do not invent, remove, or resolve items in this result; present its requiresAction and requiresHumanReview contents.",
    inputSchema: z.object({}),
    callback: () => {
      try {
        const handoff = buildHandoff(currentState());
        const result = toHandoffView(handoff);
        observations.handoff = result;
        observations.lastTool = "handoff";
        trace({
          tool: "get_handoff",
          status: "success",
          summary: `read — ${result.requiresAction.length} action, ${result.requiresHumanReview.length} human review`,
        });
        return result;
      } catch (error) {
        const failure = failureResult(error);
        observations.handoff = failure;
        observations.lastTool = "handoff";
        trace({ tool: "get_handoff", status: "error", summary: failure.error.message });
        return failure;
      }
    },
  });

  const recordHumanDecision = tool({
    name: "record_human_decision",
    description:
      "Append a human decision for a currently conflicted item. Only call this when the user explicitly selected the claim in the current request. Never choose between conflicting claims yourself. The tool rejects calls without explicit human authorization.",
    inputSchema: z.object({
      subject: z.string().min(1).describe("The conflicted operational subject."),
      claim: z.string().min(1).describe("The exact claim selected explicitly by a human."),
    }),
    callback: (input, context?: ToolContext) => {
      try {
        const authorization = context?.invocationState.humanDecisionAuthorization;
        if (!isAuthorizedDecision(authorization, input.subject, input.claim)) {
          const failure: ToolFailure = {
            ok: false,
            error: {
              message: "explicit human decision required; the agent cannot choose between conflicting claims",
              code: "human_authorization_required",
            },
          };
          observations.humanDecision = failure;
          observations.lastTool = "humanDecision";
          trace({ tool: "record_human_decision", status: "error", summary: failure.error.message });
          return failure;
        }

        const state = currentState();
        const event = recordableDecision({
          state,
          subject: input.subject,
          claim: input.claim,
          eventId: crypto.randomUUID(),
          occurredAt: dependencies.now?.() ?? new Date().toISOString(),
        });
        dependencies.store.appendEvent(event);
        const updated = currentState();
        const item = updated.items.find((candidate) => candidate.canonicalSubject === canonicalSubject(input.subject));
        if (!item) throw new Error("recorded decision did not produce a deterministic operational item");
        const result: HumanDecisionToolResult = { ok: true, event, item: toItemView(item) };
        observations.humanDecision = result;
        observations.lastTool = "humanDecision";
        trace({
          tool: "record_human_decision",
          status: "success",
          summary: `recorded — ${item.subject} DECIDED: ${item.decision?.value ?? input.claim}`,
        });
        return result;
      } catch (error) {
        const failure = failureResult(error);
        observations.humanDecision = failure;
        observations.lastTool = "humanDecision";
        trace({ tool: "record_human_decision", status: "error", summary: failure.error.message });
        return failure;
      }
    },
  });

  return {
    reportEvent,
    getShiftState,
    getHandoff,
    recordHumanDecision,
    tools: [reportEvent, getShiftState, getHandoff, recordHumanDecision],
    getTrace: () => [...traces],
    getObservations: () => ({
      ...observations,
      ...(observations.reportEvent ? { reportEvent: observations.reportEvent } : {}),
      ...(observations.shiftState ? { shiftState: observations.shiftState } : {}),
      ...(observations.handoff ? { handoff: observations.handoff } : {}),
      ...(observations.humanDecision ? { humanDecision: observations.humanDecision } : {}),
    }),
    clearTrace: () => {
      traces.length = 0;
      delete observations.lastTool;
      delete observations.reportEvent;
      delete observations.shiftState;
      delete observations.handoff;
      delete observations.humanDecision;
    },
  };
}

function isAuthorizedDecision(
  authorization: unknown,
  subject: string,
  claim: string,
): authorization is HumanDecisionAuthorization {
  if (!authorization || typeof authorization !== "object") return false;
  const candidate = authorization as Partial<HumanDecisionAuthorization>;
  return candidate.canonicalSubject === canonicalSubject(subject)
    && candidate.canonicalClaim === canonicalClaim(claim);
}

function toItemView(item: OperationalItem): AgentItemView {
  return {
    id: item.id,
    subject: item.subject,
    canonicalSubject: item.canonicalSubject,
    description: item.description,
    status: item.status,
    claims: item.claims.map((claim) => ({ value: claim.value, canonicalValue: claim.canonicalValue })),
    ...(item.decision ? { decision: { value: item.decision.value, canonicalValue: item.decision.canonicalValue } } : {}),
    ...(item.blockedByCanonicalSubject ? { blockedByCanonicalSubject: item.blockedByCanonicalSubject } : {}),
  };
}

function toHandoffView(handoff: ShiftHandoff): HandoffToolResult {
  return {
    ok: true,
    shiftId: handoff.shiftId,
    shiftName: handoff.shiftName,
    requiresAction: handoff.requiresAction.map(toItemView),
    requiresHumanReview: handoff.requiresHumanReview.map(toItemView),
    resolvedDuringShiftCount: handoff.resolvedDuringShiftCount,
    decidedDuringShiftCount: handoff.decidedDuringShiftCount,
  };
}

function failureResult(error: unknown): ToolFailure {
  if (error instanceof DecisionValidationError) {
    return { ok: false, error: { message: error.message, code: error.code } };
  }
  return {
    ok: false,
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}
