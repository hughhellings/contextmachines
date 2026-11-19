/**
 * One POST to an AI provider, the way every adapter here makes it: a time limit on each attempt, the
 * run's stop, and retries with backoff when the provider says to slow down or is briefly down. Every
 * error it throws is scrubbed of keys (scrub.ts) and names the provider, the status and its sentence.
 */
import { cleanError, scrub } from "./scrub.ts";
import type { CallOptions } from "./types.ts";

/** ai.ts's ANSWER_TIMEOUT_MS: a local model loading, or a busy provider, but never forever. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Statuses worth another try: a timeout (408), a conflict some gateways send under load (409), too
 * many requests (429), a server error (5xx) and Anthropic's overloaded (529). Never a 4xx about the
 * request itself (400, 401, 403, 404, 413, 422): trying again sends the same mistake again.
 */
export const RETRY_STATUS = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;

/** Connection failures worth another try: dropped mid-way. A refused or unknown host isn't (nothing is there). */
const RETRY_CONNECTION = /ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|other side closed|socket hang up/i;

/** Thrown for a provider's own refusal: the status is kept for callers (withLight reads 429 in the words). */
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    if (status !== undefined) this.status = status;
  }
}

/**
 * The sentence in an AI server's refusal (as ai.ts's refusal()): {"error":{"message":…}},
 * {"error":"…"} (Ollama), or Gemini's in a list of one. Cut to 160 characters.
 */
export function sentence(body: string, secrets: readonly string[] = []): string {
  // Scrubbed before it is cut: a cut through a key would leave a piece no scrub could recognise.
  const cut = (text: string) => scrub(text.trim(), secrets).slice(0, 160);
  let said: unknown;
  try {
    said = JSON.parse(body);
  } catch {
    return cut(body);
  }
  const one = (Array.isArray(said) ? said[0] : said) as { error?: { message?: unknown } | string; message?: unknown } | null | undefined;
  const words = typeof one?.error === "string" ? one.error : (one?.error?.message ?? one?.message);
  return typeof words === "string" && words.trim() ? cut(words) : cut(body);
}

/** Why a connection failed, in the fewest words (as ai.ts's connectionReason). */
export function connectionReason(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const said = cause as { message?: unknown; code?: unknown; errors?: unknown[] } | null;
  const first = said?.errors?.[0] as { code?: unknown; message?: unknown } | undefined;
  const reasons = [said?.code, first?.code, said?.message, first?.message, (error as { message?: unknown } | null)?.message];
  return reasons.find((r): r is string => typeof r === "string" && r.trim() !== "") ?? "";
}

/** How long Retry-After asks for, in ms: seconds or an HTTP date. Undefined when it says neither. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A wait that a stop ends at once. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onStop);
      resolve();
    }, ms);
    const onStop = () => {
      clearTimeout(timer);
      reject(new Error("stopped"));
    };
    signal?.addEventListener("abort", onStop, { once: true });
  });
}

/** Said by an ask that was stopped (ai.ts's ASK_STOPPED, same words so callers match either). */
export const STOPPED = "the AI's answer wasn't waited for: stopped";

export interface Post {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** "OpenAI API": who is named in errors. */
  via: string;
  /** The address named when it can't be reached (the adapter's base, as ai.ts names it); else the URL's origin. */
  base?: string;
  /** Values never to appear in an error: the key. */
  secrets: readonly string[];
  /** Said after "couldn't reach …" (Ollama: "is it running? (ollama serve)"). */
  hint?: string;
  /** Added to a 404's error: what a 404 usually means for this provider. */
  notFound?: string;
}

/** A sent request's answer: the status and the body, read once. */
export interface Reply {
  status: number;
  ok: boolean;
  text: string;
}

/**
 * POSTs JSON and returns the reply once it is final: a 2xx, or a status not worth retrying (the caller
 * decides about 400, as the OpenAI format falls back on it). Throws, scrubbed, when the retries run
 * out, the time runs out, the stop is pressed, or nothing answers.
 */
export async function postJson(p: Post, o: CallOptions = {}): Promise<Reply> {
  const doFetch = o.fetch ?? fetch;
  const wait = o.sleep ?? sleep;
  const random = o.random ?? Math.random;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, o.retries ?? 3);
  const base = o.baseDelayMs ?? 1000;
  const most = o.maxDelayMs ?? 30_000;
  const host =
    p.base ??
    (() => {
      try {
        return new URL(p.url).origin;
      } catch {
        return p.url;
      }
    })();
  const fail = (message: string, status?: number) => new ProviderError(scrub(message, p.secrets), status);

  for (let attempt = 0; ; attempt++) {
    const stop = o.signal?.();
    if (stop?.aborted) throw fail(STOPPED);
    const timeout = AbortSignal.timeout(timeoutMs);
    let reply: Reply | undefined;
    let retryable = "";
    let after: number | undefined;
    try {
      const res = await doFetch(p.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...p.headers },
        body: JSON.stringify(p.body),
        signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
      });
      const text = await res.text();
      reply = { status: res.status, ok: res.ok, text };
      if (!res.ok && RETRY_STATUS(res.status)) {
        retryable = `${p.via} said ${res.status}: ${sentence(text, p.secrets)}`;
        after = retryAfterMs(res.headers.get("retry-after"));
      }
    } catch (error) {
      if (stop?.aborted) throw fail(STOPPED);
      if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        throw fail(`${p.via} didn't answer in ${timeoutMs >= 60_000 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs / 1000}s`}`);
      }
      const reason = connectionReason(error);
      if (!RETRY_CONNECTION.test(reason)) throw fail(`couldn't reach ${p.via} at ${host}${reason ? `: ${reason}` : ""}${p.hint ? `; ${p.hint}` : ""}`);
      retryable = `${p.via} dropped the connection: ${reason}`;
    }
    if (!retryable && reply) {
      if (reply.ok || reply.status === 400) return reply;
      throw fail(`${p.via} said ${reply.status}: ${sentence(reply.text, p.secrets)}${reply.status === 404 && p.notFound ? ` (${p.notFound})` : ""}`, reply.status);
    }
    if (attempt >= retries) throw fail(`${retryable}${retries ? ` (after ${retries + 1} tries)` : ""}`, reply?.status);
    // Exponential, each wait a random half to all of it, so many runs told to slow down at once don't all come back together.
    const backoff = Math.round(base * 2 ** attempt * (0.5 + random() / 2));
    const ms = after ?? backoff;
    if (ms > most) throw fail(`${retryable} (it asked to wait ${Math.ceil(ms / 1000)}s, longer than ${Math.round(most / 1000)}s)`, reply?.status);
    try {
      await wait(ms, stop);
    } catch {
      throw fail(STOPPED);
    }
  }
}

/** The reply's JSON, or a clear error (a proxy's HTML page, say). */
export function readJson<T>(reply: Reply, via: string, secrets: readonly string[]): T {
  try {
    return JSON.parse(reply.text) as T;
  } catch {
    throw new ProviderError(scrub(`${via} answered with something that isn't JSON: ${scrub(reply.text.trim(), secrets).slice(0, 80)}`, secrets), reply.status);
  }
}

/**
 * Any error from an adapter, scrubbed, every time: a ProviderError too, since some carry words the
 * server chose (a stop reason, a block reason) that were never scrubbed where they were thrown.
 */
export function scrubbed(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof ProviderError) return new ProviderError(scrub(error.message, secrets), error.status);
  return cleanError(error, secrets);
}

/** A data URL for an image, for the formats that take one. */
export const dataUrl = (mimeType: string, base64: string) => `data:${mimeType};base64,${base64}`;
