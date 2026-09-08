import type { LlmClient, LlmCompletion } from "./interpreter.ts";

/**
 * Minimal OpenAI-compatible chat-completions adapter (no SDK, no new
 * dependency — AGENTS.md §9). Any endpoint speaking the standard
 * POST {base}/chat/completions shape works, so base URL / key / model all
 * come from configuration, never hardcoded credentials.
 *
 * Structured-output support varies across endpoints, so the adapter does not
 * trust response_format alone: the LLMEventInterpreter always enforces the
 * JSON schema locally regardless of what the provider supports.
 */
export class OpenAiCompatibleClient implements LlmClient {
  constructor(
    private readonly config: { baseUrl: string; apiKey: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(prompt: string): Promise<LlmCompletion> {
    const url = joinCompletionsPath(this.config.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
      });
    } catch (err) {
      throw new ProviderTransportError(err instanceof Error ? err.message : String(err));
    }

    if (!response.ok) {
      throw new ProviderTransportError(`provider returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderTransportError("provider returned a non-JSON response body");
    }

    const text = extractMessageText(body);
    if (text === undefined) {
      throw new ProviderTransportError("provider response is missing choices[0].message.content");
    }
    return { text };
  }
}

function joinCompletionsPath(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function extractMessageText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as Record<string, unknown>)?.message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  // Some providers return content as an array of parts; concatenate text parts.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : ""))
      .join("");
    return joined.trim().length > 0 ? joined : undefined;
  }
  return undefined;
}

export class ProviderTransportError extends Error {}
