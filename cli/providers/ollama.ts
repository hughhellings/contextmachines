/**
 * Ollama in its own format (/api/chat), so a JSON Schema in `format` holds the answer to it and
 * pictures go as the message's `images`. Nothing leaves the machine unless OLLAMA_HOST points away.
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#generate-a-chat-completion (model,
 * messages with images, stream false, format as a JSON Schema, prompt_eval_count, eval_count),
 * https://ollama.com/blog/structured-outputs.
 */
import { postJson, ProviderError, readJson, scrubbed, sentence } from "./http.ts";
import { scrub } from "./scrub.ts";
import { tokens, type AiAnswer, type AiUsage, type CallOptions, type ProviderAi } from "./types.ts";

export interface OllamaConfig {
  /** "http://localhost:11434" (no /api). */
  base: string;
  model: string;
  /** Only for a hosted Ollama that asks for one (sent as Bearer). */
  key?: string;
  via?: string;
}

/** OLLAMA_HOST as Ollama itself reads it: "0.0.0.0:11434", "localhost", "http://box:11434" all work. */
export function ollamaBase(host: string | undefined): string {
  const h = (host ?? "").trim();
  if (!h) return "http://localhost:11434";
  const withScheme = /^[a-z]+:\/\//i.test(h) ? h : `http://${h}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    // Not the value: it may hold something that shouldn't be printed.
    throw new Error("OLLAMA_HOST isn't an address: it should look like localhost:11434 or http://box:11434");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("OLLAMA_HOST must be an http:// or https:// address");
  if (!u.port && !/^[a-z]+:\/\/[^/]+:\d+/i.test(withScheme) && u.protocol === "http:") u.port = "11434";
  // 0.0.0.0 is where a server listens, not an address to call.
  if (u.hostname === "0.0.0.0") u.hostname = "localhost";
  return u.origin;
}

/** What Ollama says an answer took: prompt_eval_count in, eval_count out. No cache counts, no price. */
export function ollamaUsage(res: { model?: unknown; prompt_eval_count?: unknown; eval_count?: unknown }): AiUsage | undefined {
  if (res.prompt_eval_count === undefined && res.eval_count === undefined) return undefined;
  return { input: tokens(res.prompt_eval_count), cacheRead: 0, cacheWrite: 0, output: tokens(res.eval_count), ...(typeof res.model === "string" && res.model ? { model: res.model } : {}) };
}

type Reply = { model?: unknown; message?: { content?: string }; done_reason?: string; prompt_eval_count?: unknown; eval_count?: unknown };

export function ollamaChat(c: OllamaConfig, o: CallOptions = {}): ProviderAi {
  const via = c.via ?? "Ollama on this machine";
  const secrets = c.key ? [c.key] : [];
  return {
    model: c.model,
    via,
    async ask(system, question, schema, images) {
      try {
        const user = { role: "user", content: question, ...(images?.length ? { images: images.map((i) => i.base64) } : {}) };
        const reply = await postJson(
          {
            url: `${c.base}/api/chat`,
            headers: c.key ? { authorization: `Bearer ${c.key}` } : {},
            body: { model: c.model, messages: [{ role: "system", content: system }, user], stream: false, format: schema },
            via,
            base: c.base,
            secrets,
            hint: "is it running? (ollama serve)",
            notFound: `is the model pulled? ollama pull ${c.model}`,
          },
          o,
        );
        if (!reply.ok) throw new ProviderError(scrub(`${via} said ${reply.status}: ${sentence(reply.text, secrets)}`, secrets), reply.status);
        const res = readJson<Reply>(reply, via, secrets);
        const text = res.message?.content;
        if (!text) throw new ProviderError(`${via} gave no answer (${res.done_reason ?? "no reason given"})`);
        const usage = ollamaUsage(res);
        const answer: AiAnswer = { text, ...(usage ? { usage } : {}) };
        return answer;
      } catch (error) {
        throw scrubbed(error, secrets);
      }
    },
  };
}
