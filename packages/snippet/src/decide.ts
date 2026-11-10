import type { EvalContext } from "@contextmachines/rules-core";
import type { DecideRequest, DecideResponse } from "@contextmachines/schemas";

export interface DecideClientOptions {
  endpoint: string;
  key: string;
  sessionId: string;
  fetch: typeof fetch;
  /** Requests beyond this are dropped rather than queued: decisions are only useful in the moment. */
  maxInFlight?: number;
  timeoutMs?: number;
}

/**
 * Asks the decision service about rules that need server-side judgment.
 * Never throws; resolves to undefined on any failure (fail open).
 */
export class DecideClient {
  private inFlight = 0;
  private userId: string | undefined;
  private userHash: string | undefined;
  private readonly opts: DecideClientOptions;

  constructor(opts: DecideClientOptions) {
    this.opts = opts;
  }

  identify(userId: string | undefined, userHash?: string) {
    this.userId = userId;
    this.userHash = userId && userHash && /^[a-f0-9]{64}$/.test(userHash) ? userHash : undefined;
  }

  async decide(context: EvalContext): Promise<DecideResponse | undefined> {
    if (this.inFlight >= (this.opts.maxInFlight ?? 2)) return undefined;
    this.inFlight++;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000) : undefined;
    try {
      const body: DecideRequest = { v: 1, key: this.opts.key, sessionId: this.opts.sessionId, context };
      if (this.userId) body.userId = this.userId;
      if (this.userId && this.userHash) body.userHash = this.userHash;
      const res = await this.opts.fetch(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
        credentials: "omit",
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as DecideResponse;
      return json && json.v === 1 && Array.isArray(json.outcomes) ? json : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.inFlight--;
    }
  }
}
