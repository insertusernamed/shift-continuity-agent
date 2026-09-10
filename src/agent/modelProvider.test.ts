import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BedrockModel } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { createAgentModel, resolveAgentModelConfig, type AgentModelConfig } from "./modelProvider.ts";

describe("agent model provider selection", () => {
  it("defaults to the existing Nova bedrock provider and model id", () => {
    const config = resolveAgentModelConfig({});
    assert.equal(config.provider, "bedrock");
    assert.equal(config.modelId, "ca.amazon.nova-lite-v1:0");
  });

  it("keeps the legacy BEDROCK_MODEL_ID override working for the bedrock provider", () => {
    const config = resolveAgentModelConfig({ BEDROCK_MODEL_ID: "ca.amazon.nova-lite-v1:0" });
    assert.equal(config.provider, "bedrock");
    assert.equal(config.modelId, "ca.amazon.nova-lite-v1:0");
  });

  it("selects the Luna bedrock-openai provider from AGENT_MODEL_PROVIDER + AGENT_MODEL_ID", () => {
    const config = resolveAgentModelConfig({
      AGENT_MODEL_PROVIDER: "bedrock-openai",
      AGENT_MODEL_ID: "global.openai.gpt-5.6-luna",
      AWS_REGION: "ca-central-1",
    });
    assert.equal(config.provider, "bedrock-openai");
    assert.equal(config.modelId, "global.openai.gpt-5.6-luna");
    assert.equal(config.region, "ca-central-1");
  });

  it("defaults the model id to the Luna inference profile when only the provider is set", () => {
    const config = resolveAgentModelConfig({ AGENT_MODEL_PROVIDER: "bedrock-openai" });
    assert.equal(config.provider, "bedrock-openai");
    assert.equal(config.modelId, "global.openai.gpt-5.6-luna");
  });

  it("rejects an invalid provider configuration", () => {
    assert.throws(
      () => resolveAgentModelConfig({ AGENT_MODEL_PROVIDER: "anthropic-direct" }),
      /invalid AGENT_MODEL_PROVIDER/,
    );
  });
});

describe("agent model construction", () => {
  it("builds the existing BedrockModel for the Nova provider", () => {
    const model = createAgentModel({ provider: "bedrock", modelId: "ca.amazon.nova-lite-v1:0", region: "ca-central-1" });
    assert.ok(model instanceof BedrockModel);
    assert.equal(model.getConfig().modelId, "ca.amazon.nova-lite-v1:0");
  });

  it("builds the SDK OpenAI Responses model pointed at bedrock-runtime for Luna", () => {
    const config: AgentModelConfig = {
      provider: "bedrock-openai",
      modelId: "global.openai.gpt-5.6-luna",
      region: "ca-central-1",
    };
    const model = createAgentModel(config);
    assert.ok(model instanceof OpenAIModel);
    assert.equal(model.api, "responses");
    assert.equal(model.getConfig().modelId, "global.openai.gpt-5.6-luna");
    const client = (model as unknown as { _client: { baseURL: string } })._client;
    assert.equal(client.baseURL, "https://bedrock-runtime.ca-central-1.amazonaws.com/openai/v1");
  });

  it("refuses to build a Luna model without a resolvable region", () => {
    assert.throws(
      () => createAgentModel({ provider: "bedrock-openai", modelId: "global.openai.gpt-5.6-luna" }),
      /AWS region/i,
    );
  });
});