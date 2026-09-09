import { Agent, BedrockModel, Model, type Message } from "@strands-agents/sdk";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { EventInterpreter } from "../ingest/interpreter.ts";
import { canonicalClaim } from "../domain/claims.ts";
import { canonicalSubject } from "../domain/subjects.ts";
import {
  createShiftContinuityTools,
  type AgentItemView,
  type HandoffToolResult,
  type HumanDecisionAuthorization,
  type ShiftContinuityTools,
  type ShiftStateToolResult,
  type ToolName,
  type ToolTrace,
  type ToolFailure,
} from "./tools.ts";

/**
 * The system prompt is deliberately explicit about the source of truth and
 * human authority. The Strands agent may choose tools, but it cannot decide
 * the operational state or resolve a conflict in prose.
 */
export const SHIFT_CONTINUITY_SYSTEM_PROMPT = [
  "You are ShiftContinuityAgent, a concise operational shift assistant.",
  "Operational truth comes only from the deterministic tools and domain state.",
  "Never invent current state and never rely on remembered conversation state when state matters.",
  "Use get_shift_state whenever the user's question depends on current state.",
  "Use get_handoff for handoff contents; do not author an authoritative handoff yourself.",
  "Use report_event for incoming operational reports. Never claim an event was stored unless report_event succeeded.",
  "Never resolve conflicting claims yourself and never make a human-authority decision.",
  "Only call record_human_decision after the human explicitly selected one of the available claims in the current request.",
  "If a human has not selected a claim, surface the conflicting options and say that human review is required.",
  "Surface human review only when the deterministic system marks something conflicted.",
  "Treat tool errors as real failures and report them concisely without claiming success.",
  "Prefer concise operational responses.",
].join("\n");

export type AgentMode = "deterministic" | "bedrock";

/** Narrow model-independent boundary used by deterministic tests and offline routing. */
export interface AgentRunner {
  invoke(userText: string, invocationState: Record<string, unknown>): Promise<{ response: string }>;
}

export interface BedrockAgentConfig {
  region?: string;
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
  profile?: string;
}

export interface ShiftContinuityAgentDependencies {
  store: ShiftStore;
  shiftId: string;
  interpreter: EventInterpreter;
  /** Inject a runner for tests; production Bedrock mode uses StrandsAgentRunner. */
  runner?: AgentRunner;
  mode?: AgentMode;
  bedrock?: BedrockAgentConfig;
  now?: () => string;
  onToolCall?: (tool: ToolName, trace: ToolTrace) => void;
}

export interface ShiftContinuityAgentResult {
  ok: boolean;
  response: string;
  toolTrace: ToolTrace[];
  state?: ShiftStateToolResult;
  handoff?: HandoffToolResult;
  item?: AgentItemView;
  decision?: AgentItemView["decision"];
  error?: string;
}

export interface ShiftContinuityAgent {
  invoke(userText: string): Promise<ShiftContinuityAgentResult>;
  getTrace(): ToolTrace[];
}

/**
 * Create one primary ShiftContinuityAgent. All state-changing tool callbacks
 * are created once here and are shared by either runner; the runner only
 * controls how the agent chooses among those tools.
 */
export function createShiftContinuityAgent(
  dependencies: ShiftContinuityAgentDependencies,
): ShiftContinuityAgent {
  const trace: ToolTrace[] = [];
  const tools = createShiftContinuityTools({
    store: dependencies.store,
    shiftId: dependencies.shiftId,
    interpreter: dependencies.interpreter,
    now: dependencies.now,
    onTrace: (entry) => {
      trace.push(entry);
      dependencies.onToolCall?.(entry.tool, entry);
    },
  });

  const runner = dependencies.runner ?? (
    dependencies.mode === "bedrock"
      ? new StrandsAgentRunner({ tools, bedrock: dependencies.bedrock })
      : new DeterministicAgentRunner(tools)
  );

  return {
    async invoke(userText: string): Promise<ShiftContinuityAgentResult> {
      const startTrace = trace.length;
      const authorization = extractExplicitHumanDecision(userText);
      const invocationState: Record<string, unknown> = {};
      if (authorization) invocationState.humanDecisionAuthorization = authorization;

      try {
        const runnerResult = await runner.invoke(userText, invocationState);
        const invocationTrace = trace.slice(startTrace);
        return {
          ...projectAuthoritativeResult(runnerResult.response, tools.getObservations()),
          toolTrace: invocationTrace,
        };
      } catch (error) {
        const invocationTrace = trace.slice(startTrace);
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          response: `Agent failed: ${message}`,
          toolTrace: invocationTrace,
          error: message,
        };
      }
    },
    getTrace: () => [...trace],
  };
}

/**
 * Real Strands SDK runner. Bedrock receives the typed application tools and
 * performs the normal model → tool → model loop. The tools themselves never
 * leave this process and remain the only path to event/state mutation.
 */
export class StrandsAgentRunner implements AgentRunner {
  private readonly agent: Agent;
  private readonly tools: ShiftContinuityTools;
  readonly modelId: string | undefined;
  readonly toolNames: readonly ToolName[];

  constructor(config: {
    tools: ShiftContinuityTools;
    bedrock?: BedrockAgentConfig;
    /** Test-only model injection; production wires BedrockModel here. */
    model?: Model;
  }) {
    this.tools = config.tools;
    const bedrockConfig = config.bedrock ?? {};
    if (bedrockConfig.profile && !process.env.AWS_PROFILE) {
      // The AWS SDK's normal profile credential chain is used. No credentials
      // are read or copied into application state.
      process.env.AWS_PROFILE = bedrockConfig.profile;
    }

    const model = config.model ?? new BedrockModel({
      region: bedrockConfig.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      modelId: bedrockConfig.modelId ?? process.env.BEDROCK_MODEL_ID ?? "ca.amazon.nova-lite-v1:0",
      maxTokens: bedrockConfig.maxTokens ?? 700,
      temperature: bedrockConfig.temperature ?? 0,
      stream: true,
    });
    this.modelId = model.getConfig().modelId;
    this.toolNames = config.tools.tools.map((tool) => tool.name as ToolName);

    this.agent = new Agent({
      name: "ShiftContinuityAgent",
      description: "Orchestrates deterministic shift continuity tools.",
      systemPrompt: SHIFT_CONTINUITY_SYSTEM_PROMPT,
      model,
      tools: [...config.tools.tools],
      printer: false,
      retryStrategy: null,
    });
  }

  async invoke(userText: string, invocationState: Record<string, unknown>): Promise<{ response: string }> {
    const result = await this.agent.invoke(userText, { invocationState });
    return { response: extractMessageText(result.lastMessage) };
  }

  getApplicationToolTrace(): ToolTrace[] {
    return this.tools.getTrace();
  }
}

/** Assistant text lives in textBlock content blocks. */
function extractMessageText(message: Message): string {
  return message.content
    .map((block) => (block.type === "textBlock" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * Offline runner. It deliberately drives the same Strands tool objects through
 * their direct invocation API, but chooses a tool with small deterministic
 * routing rules so the product remains usable without AWS credentials.
 */
export class DeterministicAgentRunner implements AgentRunner {
  constructor(private readonly tools: ShiftContinuityTools) {}

  async invoke(userText: string, invocationState: Record<string, unknown>): Promise<{ response: string }> {
    const authorization = invocationState.humanDecisionAuthorization;
    if (isHumanDecisionAuthorization(authorization)) {
      await this.tools.recordHumanDecision.invoke(
        { subject: authorization.subject, claim: authorization.claim },
        { invocationState } as never,
      );
      return { response: "" };
    }

    if (looksLikeHandoffQuestion(userText)) {
      await this.tools.getHandoff.invoke({});
    } else if (looksLikeStateQuestion(userText)) {
      await this.tools.getShiftState.invoke({});
    } else {
      await this.tools.reportEvent.invoke({ report: userText });
    }
    return { response: "" };
  }
}

/**
 * Conservative parser used only to establish that a human explicitly selected
 * a value for the current request. It never chooses a value and does not
 * inspect history. The decision tool performs the authoritative validation.
 */
export function extractExplicitHumanDecision(text: string): HumanDecisionAuthorization | undefined {
  const imperative = text.match(
    /\b(?:send|move|route|mark)\s+(?:the\s+)?(?:damaged\s+)?(?:case\s+)?([A-Za-z]+\d+)\s+(?:to\s+)?(claims|discard(?:ed)?|salvage|donate)\b/i,
  );
  const declarative = text.match(
    /\b(?:damaged\s+)?(?:case\s+)?([A-Za-z]+\d+)\s+(?:should|must)\s+(?:go|be\s+(?:sent|marked))\s+(?:to\s+)?(claims|discard(?:ed)?|salvage|donate)\b/i,
  );
  const match = imperative ?? declarative;
  if (!match) return undefined;
  const subject = match[1]!;
  const claim = match[2]!;
  return {
    subject,
    canonicalSubject: canonicalSubject(subject),
    claim,
    canonicalClaim: canonicalClaim(claim),
  };
}

function projectAuthoritativeResult(
  runnerResponse: string,
  observations: ReturnType<ShiftContinuityTools["getObservations"]>,
): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  switch (observations.lastTool) {
    case "reportEvent":
      return projectReportResult(observations.reportEvent);
    case "shiftState":
      return projectStateResult(observations.shiftState);
    case "handoff":
      return projectHandoffResult(observations.handoff);
    case "humanDecision":
      return projectDecisionResult(observations.humanDecision);
    default:
      return { ok: true, response: runnerResponse };
  }
}

function projectReportResult(
  observation: ReturnType<ShiftContinuityTools["getObservations"]>["reportEvent"],
): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  if (!observation) return { ok: false, response: "Tool failed: report_event returned no result", error: "missing report_event result" };
  if (!observation.ok) return projectFailure(observation);
  return {
    ok: true,
    response: `Accepted: ${observation.item.subject} is ${observation.item.status}.`,
    item: observation.item,
  };
}

function projectStateResult(
  observation: ReturnType<ShiftContinuityTools["getObservations"]>["shiftState"],
): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  if (!observation) return { ok: false, response: "Tool failed: get_shift_state returned no result", error: "missing state result" };
  if (!observation.ok) return projectFailure(observation);
  const response = observation.conflictedItems.length > 0
    ? `Current state: ${observation.conflictedItems.map((item) => `${item.subject} has conflicting reports (${item.claims.map((claim) => claim.value).join(" vs ")})`).join("; ")}. A human decision is required.`
    : `${observation.openItems.length} open item(s), ${observation.decidedItems.length} decided item(s).`;
  return { ok: true, response, state: observation };
}

function projectHandoffResult(
  observation: ReturnType<ShiftContinuityTools["getObservations"]>["handoff"],
): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  if (!observation) return { ok: false, response: "Tool failed: get_handoff returned no result", error: "missing handoff result" };
  if (!observation.ok) return projectFailure(observation);
  return { ok: true, response: renderHandoffResponse(observation), handoff: observation };
}

function projectDecisionResult(
  observation: ReturnType<ShiftContinuityTools["getObservations"]>["humanDecision"],
): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  if (!observation) return { ok: false, response: "Tool failed: record_human_decision returned no result", error: "missing decision result" };
  if (!observation.ok) return projectFailure(observation);
  return {
    ok: true,
    response: `Recorded human decision: ${observation.item.subject} is decided as ${observation.item.decision?.value ?? observation.event.claim}.`,
    item: observation.item,
    decision: observation.item.decision,
  };
}

function projectFailure(observation: ToolFailure): Omit<ShiftContinuityAgentResult, "toolTrace"> {
  return {
    ok: false,
    response: `Tool failed: ${observation.error.message}`,
    error: observation.error.message,
  };
}

function renderHandoffResponse(handoff: HandoffToolResult): string {
  const actions = handoff.requiresAction.map((item) => `${item.subject}: ${item.description}`);
  const reviews = handoff.requiresHumanReview.map(
    (item) => `${item.subject} has conflicting reports ${item.claims.map((claim) => claim.value).join(" vs ")}; human review is required`,
  );
  return [
    actions.length > 0 ? `Requires action: ${actions.join("; ")}.` : "No unresolved action items.",
    reviews.length > 0 ? `Requires human review: ${reviews.join("; ")}.` : "No conflicts require human review.",
  ].join(" ");
}

function looksLikeHandoffQuestion(text: string): boolean {
  return /\b(?:handoff|what(?:'s| is) left|morning shift|next shift|remaining)\b/i.test(text);
}

function looksLikeStateQuestion(text: string): boolean {
  return /\b(?:current state|what should we do|what do we do|conflict|conflicted|pick|choose|decide|review|open items?)\b/i.test(text);
}

function isHumanDecisionAuthorization(value: unknown): value is HumanDecisionAuthorization {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HumanDecisionAuthorization>;
  return typeof candidate.subject === "string"
    && typeof candidate.claim === "string"
    && typeof candidate.canonicalSubject === "string"
    && typeof candidate.canonicalClaim === "string";
}
