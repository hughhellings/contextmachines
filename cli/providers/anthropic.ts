/**
 * Anthropic's Messages API by fetch, so pictures go with the question without changing the SDK call.
 * Docs: https://docs.anthropic.com/en/api/messages (x-api-key, anthropic-version, system, base64 image
 * blocks), https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs (output_config.format,
 * as ai.ts's anthropic() sends it), https://docs.anthropic.com/en/api/errors (429, 529 overloaded).
 */
import { postJson, ProviderError, readJson, scrubbed, sentence } from "./http.ts";
import { scrub } from "./scrub.ts";
import { tokens, type AiAnswer, type AiUsage, type AskImage, type CallOptions, type ProviderAi } from "./types.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicConfig {
  /** Without /v1: "https://api.anthropic.com". */
  base: string;
  key: string;
  model: string;
  via?: string;
  maxTokens?: number;
}

/** What Anthropic says an answer took (ai.ts's anthropicUsage). It gives no price. */
export function anthropicUsage(res: { model?: unknown; usage?: Record<string, unknown> | null }): AiUsage | undefined {
  const u = res.usage;
  if (!u) return undefined;
  return { input: tokens(u.input_tokens), cacheRead: tokens(u.cache_read_input_tokens), cacheWrite: tokens(u.cache_creation_input_tokens), output: tokens(u.output_tokens), ...(typeof res.model === "string" && res.model ? { model: res.model } : {}) };
}

/** The user turn: pictures first, then the question (the docs' advice for images). */
export function anthropicContent(question: string, images: readonly AskImage[] = []): string | object[] {
  if (!images.length) return question;
  return [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.base64 } })), { type: "text", text: question }];
}

type Reply = { content?: { type?: string; text?: string }[]; stop_reason?: string; model?: unknown; usage?: Record<string, unknown> | null };

export function anthropicMessages(c: AnthropicConfig, o: CallOptions = {}): ProviderAi {
  const via = c.via ?? "Anthropic API";
  const secrets = [c.key];
  // Its errors say "Anthropic said 400: …", as ai.ts's SDK-based ask did (report.test.ts holds those words).
  const said = (c.via ?? "Anthropic API").replace(/ API$/, "");
  return {
    model: c.model,
    via,
    async ask(system, question, schema, images) {
      try {
        const reply = await postJson(
          {
            url: `${c.base}/v1/messages`,
            headers: { "x-api-key": c.key, "anthropic-version": ANTHROPIC_VERSION },
            body: { model: c.model, max_tokens: c.maxTokens ?? 16000, system, output_config: { format: { type: "json_schema", schema } }, messages: [{ role: "user", content: anthropicContent(question, images) }] },
            via: said,
            base: c.base,
            secrets,
            notFound: "is the model right? set --model",
          },
          o,
        );
        if (!reply.ok) throw new ProviderError(scrub(`${said} said ${reply.status}: ${sentence(reply.text, secrets)}`, secrets), reply.status);
        const res = readJson<Reply>(reply, via, secrets);
        const text = res.content?.find((b) => b.type === "text")?.text;
        if (!text) throw new ProviderError(`${via} gave no answer (${res.stop_reason ?? "no reason given"})`);
        const usage = anthropicUsage(res);
        const answer: AiAnswer = { text, ...(usage ? { usage } : {}) };
        return answer;
      } catch (error) {
        throw scrubbed(error, secrets);
      }
    },
  };
}
