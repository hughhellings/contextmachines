/**
 * What every provider here gives: the same ask as ai.ts's Ai (system, question, JSON Schema), with
 * optional pictures (masked screenshots), and the same answer shape (AiAnswer, AiUsage). The types
 * are ai.ts's own, so an adapter drops in where `compatible()` or `anthropic()` is used today.
 */
import type { AiAnswer, AiUsage } from "../ai.ts";

export type { AiAnswer, AiUsage };

/** A picture sent with the question: a screenshot, already masked by the caller. */
export interface AskImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** The bytes, base64 (no "data:" prefix). */
  base64: string;
}

/** One provider's ask, the shape ai.ts's AskJson takes, plus pictures. */
export interface ProviderAi {
  model: string;
  /** How it's named to the person: "OpenAI API", "Ollama on this machine". */
  via: string;
  ask(system: string, question: string, schema: object, images?: readonly AskImage[]): Promise<AiAnswer>;
}

/** How a request is made: shared by every wire format. Tests swap fetch, sleep and the clock. */
export interface CallOptions {
  /** Each attempt's own limit (default ai.ts's ANSWER_TIMEOUT_MS, 5 minutes). */
  timeoutMs?: number;
  /** Retries after the first try, on 408/409/429/5xx/529 and dropped connections (default 3). */
  retries?: number;
  /** The first wait before a retry; it doubles each time, with jitter (default 1000). */
  baseDelayMs?: number;
  /** The longest single wait, Retry-After included (default 30000): a longer one fails now instead. */
  maxDelayMs?: number;
  /** The run's stop (ai.ts's withAskSignal): ends an attempt or a wait at once. */
  signal?: () => AbortSignal | undefined;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** The answer's usage built from a number the provider said, or 0 (as ai.ts's tokens()). */
export const tokens = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
