/**
 * Keys never reach a log or an error. A provider's refusal can echo what it was sent (a proxy that
 * prints its request, a 401 that repeats the key it didn't take), so every text that leaves an
 * adapter goes through scrub(): the exact key values it was given, and anything shaped like a key.
 */

const HIDDEN = "[key hidden]";

/** Shapes of keys and the places they ride in, whatever the value. */
const SHAPED: RegExp[] = [
  /\bBearer\s+(?!\[key hidden\])[^\s"',}]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI, OpenRouter (sk-or-…), Anthropic (sk-ant-…)
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /([?&](?:key|api[_-]?key|token)=)(?!\[key hidden\])[^&\s"']+/gi,
  /((?:x-api-key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?)(?!\[key hidden\])[^\s"',}]+/gi,
];

/** The text with every given secret (8 characters or more) and every key-shaped string replaced. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(HIDDEN);
  for (const re of SHAPED) out = out.replace(re, (whole, lead?: unknown) => (typeof lead === "string" && whole.startsWith(lead) ? `${lead}${HIDDEN}` : HIDDEN));
  return out;
}

/** An Error whose message and stack hold no key, and whose cause (which may) is dropped. */
export function cleanError(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const clean = new Error(scrub(message, secrets));
  if (error instanceof Error && error.name === "TimeoutError") clean.name = "TimeoutError";
  return clean;
}
