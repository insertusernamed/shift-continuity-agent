import { Agent, InvokeModelStage, Model, TextBlock, type Message, type SystemPrompt } from "@strands-agents/sdk";
import type { ShiftStore } from "../store/jsonFileStore.ts";
import type { EventInterpreter } from "../ingest/interpreter.ts";
import { createAgentModel, resolveAgentModelConfig, type AgentModelProvider } from "./modelProvider.ts";
import { classifyAgentRequest, extractExplicitHumanDecision, isHumanDecisionAuthorization, routingDirective } from "./requestRouting.ts";
import {
  createShiftContinuityTools,
  type AgentItemView,
  type HandoffToolResult,
  type ShiftContinuityTools,
  type ShiftStateToolResult,
  type ToolName,
  type ToolTrace,
  type ToolFailure,
} from "./tools.ts";

/**
 * The system prompt is deliberately explicit about the source of truth and
 * human authority. The Strands agent may choose tools, but it cannot decide
 * the operational state or resolve a conflict in prose. Routing rules are
 * spelled out so the model does not substitute a state read for a report or
 * guess whether a decision is authorized — those two facts are established
 * deterministically (see requestRouting.ts) before the model runs.
 */
export const SHIFT_CONTINUITY_SYSTEM_PROMPT = [
  "You are ShiftContinuityAgent, a concise operational shift assistant.",
  "Operational truth comes only from the deterministic tools and domain state.",
  "Never invent current state and never rely on remembered conversation state when state matters.",
  "Routing:",
  "- If the user is reporting something observed or done in the operation — even if it sounds odd or uninterpretable, e.g. \"Aisle 7 is blocked\", \"Pallet 83 is finished\", \"The freezer inspection was missed\", \"the vibes are off today\" — call report_event with the full user text and let the deterministic validator accept or reject it. Do not substitute get_shift_state merely because a conflict exists.",
  "- Use get_shift_state when the user is asking about current state (e.g. \"what's the state\", \"is D104 still conflicted\", \"what should we do\").",
  "- Use get_handoff when the user is asking what the incoming shift needs to know (e.g. \"handoff\", \"what's left\", \"morning shift\").",
  "- Resolution updates are reports too: call report_event for \"Aisle 7 is clear now\".",
  "Human authority:",
  "- Never resolve conflicting claims yourself and never make a human-authority decision.",
  "- Only call record_human_decision when invocationState contains explicit human authorization (a human selected one of the available claims in the current request). Never fabricate that selection.",
  "- If a human has not selected a claim, surface the conflicting options and say that human review is required.",
  "- Surface human review only when the deterministic system marks something conflicted.",
  "Honesty:",
  "- Treat tool errors as real failures and report them concisely without claiming success.",
  "- Never claim an event was stored unless report_event succeeded.",
  "- Prefer concise operational responses.",
].join("\n");

export type AgentMode = "deterministic" | "bedrock";

/** Narrow model-independent boundary used by deterministic tests and offline routing. */
export interface AgentRunner {
  invoke(userText: string, invocationState: Record<string, unknown>): Promise<{ response: string }>;
}

export interface BedrockAgentConfig {
  /** Explicit provider: 'bedrock' (Nova via Converse) or 'bedrock-openai' (Luna via Responses API). */
  provider?: AgentModelProvider;
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
      // Deterministic, model-independent pre-processing: whether this request
      // legally authorizes a human decision, and what kind of request it is.
      // The tool gate still rejects any unauthorized decision call, and the
      // runner injects a routing directive from this state for obvious cases.
      const authorization = extractExplicitHumanDecision(userText);
      const invocationState: Record<string, unknown> = {
        routingIntent: classifyAgentRequest(userText),
      };
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

    // Explicit provider selection (AGENT_MODEL_PROVIDER) + explicit model id
    // (AGENT_MODEL_ID, legacy BEDROCK_MODEL_ID fallback). The provider decides
    // the model adapter; the model id is never used to guess the provider.
    const resolved = resolveAgentModelConfig(process.env);
    const model = config.model ?? createAgentModel({
      provider: bedrockConfig.provider ?? resolved.provider,
      modelId: bedrockConfig.modelId ?? resolved.modelId,
      region: bedrockConfig.region ?? resolved.region,
      maxTokens: bedrockConfig.maxTokens ?? 700,
      temperature: bedrockConfig.temperature ?? 0,
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

    // Deterministic routing nudge: when the pre-invocation classifier or the
    // human-decision authorizer produced a directive, append it to the system
    // prompt for the FIRST model call only. The model still selects and calls
    // the tool (Strands stays the orchestrator), but it no longer has to guess
    // the obvious intent. Later loop calls summarize tool results and are not
    // re-routed.
    this.agent.addMiddleware(InvokeModelStage.Input, (context) => {
      const directive = routingDirective(context.invocationState);
      if (!directive || context.messages.length !== 1) return context;
      return {
        ...context,
        systemPrompt: appendSystemPromptDirective(context.systemPrompt, directive),
      };
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

    switch (classifyAgentRequest(userText)) {
      case "handoff":
        await this.tools.getHandoff.invoke({});
        break;
      case "state":
        await this.tools.getShiftState.invoke({});
        break;
      default:
        await this.tools.reportEvent.invoke({ report: userText });
    }
    return { response: "" };
  }
}

/** Append a routing directive to the system prompt, preserving any base prompt. */
function appendSystemPromptDirective(prompt: SystemPrompt | undefined, directive: string): SystemPrompt {
  if (prompt === undefined) return directive;
  if (typeof prompt === "string") return `${prompt}\n\n${directive}`;
  return [...prompt, new TextBlock(directive)];
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

