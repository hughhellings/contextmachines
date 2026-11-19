/**
 * Google's Gemini API in its own format (generateContent), not its OpenAI layer: pictures as
 * inlineData, a JSON Schema the model is held to, and usage with cached and thinking tokens apart.
 * Docs: https://ai.google.dev/api/generate-content (systemInstruction, contents, generationConfig,
 * usageMetadata), https://ai.google.dev/gemini-api/docs/structured-output (responseMimeType,
 * responseJsonSchema), https://ai.google.dev/gemini-api/docs/api-key (x-goog-api-key header),
 * https://ai.google.dev/gemini-api/docs/image-understanding (inlineData mimeType + data).
 */
import { postJson, ProviderError, readJson, scrubbed, sentence } from "./http.ts";
import { scrub } from "./scrub.ts";
import { tokens, type AiAnswer, type AiUsage, type AskImage, type CallOptions, type ProviderAi } from "./types.ts";

export interface GeminiConfig {
  /** Up to the version: "https://generativelanguage.googleapis.com/v1beta". */
  base: string;
  key: string;
  model: string;
  via?: string;
}

/**
 * What Gemini says an answer took. promptTokenCount includes the cached part (cachedContentTokenCount);
 * thinking tokens (thoughtsTokenCount) are billed as output, so they count as output here. No price.
 */
export function geminiUsage(res: { modelVersion?: unknown; usageMetadata?: Record<string, unknown> | null }, asked: string): AiUsage | undefined {
  const u = res.usageMetadata;
  if (!u) return undefined;
  const cached = tokens(u.cachedContentTokenCount);
  const model = typeof res.modelVersion === "string" && res.modelVersion ? res.modelVersion : asked;
  return { input: Math.max(0, tokens(u.promptTokenCount) - cached), cacheRead: cached, cacheWrite: 0, output: tokens(u.candidatesTokenCount) + tokens(u.thoughtsTokenCount), model };
}

/** The user turn's parts: the question, then each picture as inlineData. */
export function geminiParts(question: string, images: readonly AskImage[] = []): object[] {
  return [{ text: question }, ...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.base64 } }))];
}

type Reply = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  modelVersion?: unknown;
  usageMetadata?: Record<string, unknown> | null;
};

export function geminiGenerate(c: GeminiConfig, o: CallOptions = {}): ProviderAi {
  const via = c.via ?? "Google Gemini API";
  const secrets = [c.key];
  // The model goes in the path: "models/gemini-2.5-pro" or a tuned "tunedModels/…" as given.
  const path = c.model.includes("/") ? c.model : `models/${c.model}`;
  const post = (generationConfig: object, question: string, system: string, images?: readonly AskImage[]) =>
    postJson(
      {
        url: `${c.base}/${path.split("/").map(encodeURIComponent).join("/")}:generateContent`,
        // In a header, never the ?key= query: an address ends up in logs and proxies.
        headers: { "x-goog-api-key": c.key },
        body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: geminiParts(question, images) }], generationConfig },
        via,
        base: c.base,
        secrets,
        notFound: "is the model right? set --model",
      },
      o,
    );
  return {
    model: c.model,
    via,
    async ask(system, question, schema, images) {
      try {
        let reply = await post({ responseMimeType: "application/json", responseJsonSchema: schema }, question, system, images);
        // A model or schema the JSON Schema field won't take: JSON only, with the schema in the question.
        if (reply.status === 400) reply = await post({ responseMimeType: "application/json" }, `${question}\n\nAnswer with JSON only, following this JSON Schema:\n${JSON.stringify(schema)}`, system, images);
        if (!reply.ok) throw new ProviderError(scrub(`${via} said ${reply.status}: ${sentence(reply.text, secrets)}`, secrets), reply.status);
        const res = readJson<Reply>(reply, via, secrets);
        if (res.promptFeedback?.blockReason) throw new ProviderError(`${via} refused the question (${res.promptFeedback.blockReason})`);
        const cand = res.candidates?.[0];
        const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
        if (!text) throw new ProviderError(`${via} gave no answer (${cand?.finishReason ?? "no reason given"})`);
        const usage = geminiUsage(res, c.model);
        const answer: AiAnswer = { text, ...(usage ? { usage } : {}) };
        return answer;
      } catch (error) {
        throw scrubbed(error, secrets);
      }
    },
  };
}
