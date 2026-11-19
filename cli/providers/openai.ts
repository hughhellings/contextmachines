/**
 * The OpenAI Chat Completions format: OpenAI itself, OpenRouter, the Vercel AI Gateway, LM Studio,
 * a company proxy, any server that speaks it. Docs: https://platform.openai.com/docs/api-reference/chat/create
 * (messages, response_format json_schema, image_url content parts, usage.prompt_tokens_details).
 */
import { dataUrl, postJson, ProviderError, readJson, scrubbed, sentence } from "./http.ts";
import { scrub } from "./scrub.ts";
import { tokens, type AiAnswer, type AiUsage, type AskImage, type CallOptions, type ProviderAi } from "./types.ts";

export interface OpenAiConfig {
  /** Up to and including the version, without the trailing slash: "https://api.openai.com/v1". */
  base: string;
  /** Empty for a server that takes none (a local one). */
  key: string;
  model: string;
  via: string;
  hint?: string;
  /** "developer" for OpenAI's own API (its docs: developer messages replace system from o1 on); default "system". */
  systemRole?: "system" | "developer";
}

/** A price the provider said, as a number or a string of one; anything else is none. */
const dollars = (n: unknown) => {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
};

/**
 * What an OpenAI-style server says an answer took (ai.ts's compatibleUsage): prompt tokens include the
 * cached ones, counted apart (cached_tokens, and OpenRouter's cache_write_tokens); a price only where
 * the server says one (OpenRouter's usage.cost).
 */
export function openAiUsage(data: { model?: unknown; usage?: Record<string, unknown> | null }): AiUsage | undefined {
  const u = data.usage;
  if (!u) return undefined;
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const [cached, written] = [tokens(details?.cached_tokens), tokens(details?.cache_write_tokens)];
  const costUsd = dollars(u.cost);
  return { input: Math.max(0, tokens(u.prompt_tokens) - cached - written), cacheRead: cached, cacheWrite: written, output: tokens(u.completion_tokens), ...(costUsd !== undefined ? { costUsd } : {}), ...(typeof data.model === "string" && data.model ? { model: data.model } : {}) };
}

/** The user message: plain text, or text then each picture as an image_url part with a data URL. */
export function userContent(question: string, images: readonly AskImage[] = []): string | object[] {
  if (!images.length) return question;
  return [{ type: "text", text: question }, ...images.map((i) => ({ type: "image_url", image_url: { url: dataUrl(i.mimeType, i.base64) } }))];
}

type Reply = { choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; model?: unknown; usage?: Record<string, unknown> | null };

export function openAiChat(c: OpenAiConfig, o: CallOptions = {}): ProviderAi {
  const secrets = c.key ? [c.key] : [];
  const post = (body: object) =>
    postJson({ url: `${c.base}/chat/completions`, headers: c.key ? { authorization: `Bearer ${c.key}` } : {}, body, via: c.via, base: c.base, secrets, ...(c.hint ? { hint: c.hint } : {}), notFound: "is the model right? set --model" }, o);
  return {
    model: c.model,
    via: c.via,
    async ask(system, question, schema, images) {
      try {
        const system_ = { role: c.systemRole ?? "system", content: system };
        let reply = await post({ model: c.model, messages: [system_, { role: "user", content: userContent(question, images) }], response_format: { type: "json_schema", json_schema: { name: "answer", schema } } });
        // Some servers take JSON but not a schema: the schema goes in the question instead (as ai.ts does).
        if (reply.status === 400) {
          const asked = `${question}\n\nAnswer with JSON only, following this JSON Schema:\n${JSON.stringify(schema)}`;
          reply = await post({ model: c.model, messages: [system_, { role: "user", content: userContent(asked, images) }], response_format: { type: "json_object" } });
        }
        if (!reply.ok) throw new ProviderError(scrub(`${c.via} said ${reply.status}: ${sentence(reply.text, secrets)}`, secrets), reply.status);
        const data = readJson<Reply>(reply, c.via, secrets);
        const choice = data.choices?.[0];
        const text = choice?.message?.content;
        if (!text) throw new ProviderError(scrub(`${c.via} gave no answer${choice?.message?.refusal ? `: it refused (${scrub(choice.message.refusal, secrets).slice(0, 120)})` : choice?.finish_reason ? ` (${choice.finish_reason})` : ""}`, secrets));
        const usage = openAiUsage(data);
        const answer: AiAnswer = { text, ...(usage ? { usage } : {}), ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) };
        return answer;
      } catch (error) {
        throw scrubbed(error, secrets);
      }
    },
  };
}
