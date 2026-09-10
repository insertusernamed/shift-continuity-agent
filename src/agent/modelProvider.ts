import { BedrockModel, type Model } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { getTokenProvider } from "@aws/bedrock-token-generator";

/**
 * Explicit model-provider selection. The provider is never inferred from the
 * model id: AGENT_MODEL_PROVIDER decides how the model is reached, and
 * AGENT_MODEL_ID names the model or Bedrock inference profile. The legacy
 * BEDROCK_MODEL_ID environment variable remains a fallback so existing
 * deployments keep working unchanged.
 */
export type AgentModelProvider = "bedrock" | "bedrock-openai";

export interface AgentModelConfig {
  provider: AgentModelProvider;
  modelId: string;
  region?: string;
  maxTokens?: number;
  temperature?: number;
}

export const DEFAULT_MODEL_ID: Record<AgentModelProvider, string> = {
  bedrock: "ca.amazon.nova-lite-v1:0",
  "bedrock-openai": "global.openai.gpt-5.6-luna",
};

/** Resolve the agent model config from the normal process environment. */
export function resolveAgentModelConfig(env: Record<string, string | undefined>): AgentModelConfig {
  const provider = env.AGENT_MODEL_PROVIDER ?? "bedrock";
  if (provider !== "bedrock" && provider !== "bedrock-openai") {
    throw new Error(
      `invalid AGENT_MODEL_PROVIDER '${provider}': expected 'bedrock' (Nova via Converse) or 'bedrock-openai' (Luna via Responses API)`,
    );
  }
  const modelId = env.AGENT_MODEL_ID ?? env.BEDROCK_MODEL_ID ?? DEFAULT_MODEL_ID[provider];
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  return { provider, modelId, region };
}

/**
 * Build the Strands Model for the selected provider.
 *
 * - `bedrock` (Nova): the existing BedrockModel over the Converse API, signed
 *   with SigV4 via the normal AWS SDK credential chain.
 * - `bedrock-openai` (Luna): the SDK's OpenAIModel over the Responses API,
 *   pointed at the bedrock-runtime OpenAI-compatible endpoint
 *   (`/openai/v1/responses`), authenticated with a short-term bearer token
 *   derived from the standard AWS credential chain by
 *   `@aws/bedrock-token-generator`. No keys are ever stored or hardcoded.
 *
 * Construction performs no network I/O.
 */
export function createAgentModel(config: AgentModelConfig): Model {
  if (config.provider === "bedrock-openai") {
    const region = resolveRegion(config.region);
    return new OpenAIModel({
      api: "responses",
      modelId: config.modelId,
      maxTokens: config.maxTokens ?? 700,
      temperature: config.temperature ?? 0,
      clientConfig: { baseURL: bedrockRuntimeResponsesBaseUrl(region) },
      apiKey: createBedrockBearerTokenApiKey(region),
    });
  }
  return new BedrockModel({
    region: config.region,
    modelId: config.modelId,
    maxTokens: config.maxTokens ?? 700,
    temperature: config.temperature ?? 0,
    stream: true,
  });
}

function bedrockRuntimeResponsesBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

/**
 * Async apiKey setter for the OpenAI SDK: mints a fresh Bedrock bearer token
 * on demand from the normal AWS credential chain (AWS_PROFILE / AWS_REGION or
 * any chain the AWS SDK supports). Caching/refresh is handled by the token
 * generator, so long-running agents survive the token's maximum lifetime.
 */
function createBedrockBearerTokenApiKey(region: string): () => Promise<string> {
  const provideToken = getTokenProvider({ region });
  return async () => {
    try {
      return await provideToken();
    } catch (cause) {
      throw new Error(
        `failed to mint Bedrock bearer token for region '${region}' | verify your AWS credentials and network connectivity`,
        { cause },
      );
    }
  };
}

function resolveRegion(region: string | undefined): string {
  if (!region) {
    throw new Error(
      "bedrock-openai requires an AWS region: pass region in the agent config or set AWS_REGION / AWS_DEFAULT_REGION",
    );
  }
  return region;
}