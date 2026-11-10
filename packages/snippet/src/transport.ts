import type { CapturedEvent, EventBatch } from "@contextmachines/schemas";
import { run, takeErrorCount } from "./safe.ts";

export interface TransportOptions {
  endpoint: string;
  key: string;
  sessionId: string;
  /** The returning-browser id, when the site turned it on (rememberBrowser). */
  browserId?: string | undefined;
  /** The page's original fetch, captured before we wrap it, so our own calls are never observed. */
  fetch: typeof fetch;
  sendBeacon?: (url: string, data: Blob) => boolean;
  maxBatch?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  clock?: () => number;
  /** The page's language now (<html lang>), read as each batch is sent. */
  lang?: () => string | undefined;
  /** Phone, tablet or computer. */
  device?: "phone" | "tablet" | "computer";
  /** Called with the parsed JSON body of a successful response, when there is one (e.g. a delivery). */
  onResponse?: (body: unknown) => void;
}

/**
 * Bounded, batched delivery. Memory is capped (oldest events dropped and counted),
 * delivery is best-effort, and nothing here can block or break the page.
 */
export class Transport {
  private queue: CapturedEvent[] = [];
  private dropped = 0;
  private timer: unknown;
  private inFlight = false;
  private userId: string | undefined;
  private userHash: string | undefined;
  private plan: string | undefined;
  private role: string | undefined;
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly flushIntervalMs: number;

  private readonly opts: TransportOptions;

  constructor(opts: TransportOptions) {
    this.opts = opts;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxQueue = opts.maxQueue ?? 500;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
  }

  identify(userId: string | undefined, plan?: string, role?: string, userHash?: string): void {
    this.userId = userId;
    this.userHash = userId && userHash && /^[a-f0-9]{64}$/.test(userHash) ? userHash : undefined;
    // Plans and roles are short codes ("free", "admin"); anything else is dropped rather than sent.
    this.plan = shortCode(plan);
    this.role = shortCode(role);
  }

  push(event: CapturedEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      const overflow = this.queue.length - this.maxQueue;
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
    if (this.queue.length >= this.maxBatch) void this.flush();
    else this.schedule();
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.inFlight || this.queue.length === 0) return;
    const events = this.queue.splice(0, this.maxBatch);
    this.inFlight = true;
    try {
      const res = await this.opts.fetch(this.opts.endpoint, {
        method: "POST",
        // text/plain is CORS-simple: no preflight round trip, and identical to what sendBeacon sends.
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(this.batch(events)),
        keepalive: true,
        credentials: "omit",
      });
      if (!res.ok && res.status >= 500) this.requeue(events);
      else if (res.ok && this.opts.onResponse && (res.headers.get("content-type") ?? "").includes("json")) {
        const body: unknown = await res.json().catch(() => undefined);
        if (body !== undefined) run(() => this.opts.onResponse?.(body));
      }
    } catch {
      this.requeue(events);
    } finally {
      this.inFlight = false;
    }
    if (this.queue.length > 0) this.schedule();
  }

  /** Last-chance delivery when the page is hidden or unloading. */
  flushOnExit(): void {
    run(() => {
      if (this.queue.length === 0 || !this.opts.sendBeacon) return;
      const events = this.queue.splice(0, this.maxBatch);
      // Marked final: the page is closing and the reply will never be read.
      const blob = new Blob([JSON.stringify({ ...this.batch(events), final: true })], { type: "text/plain;charset=UTF-8" });
      if (!this.opts.sendBeacon(this.opts.endpoint, blob)) this.requeue(events);
    });
  }

  stop(): void {
    this.cancelTimer();
  }

  private batch(events: CapturedEvent[]): EventBatch {
    const batch: EventBatch = {
      v: 1,
      key: this.opts.key,
      sessionId: this.opts.sessionId,
      sentAt: (this.opts.clock ?? Date.now)(),
      events,
    };
    if (this.userId) batch.userId = this.userId;
    if (this.userId && this.userHash) batch.userHash = this.userHash;
    else if (this.opts.browserId) batch.browserId = this.opts.browserId;
    if (this.plan) batch.plan = this.plan;
    if (this.role) batch.role = this.role;
    if (this.opts.device) batch.device = this.opts.device;
    const lang = this.opts.lang?.()?.slice(0, 2).toLowerCase();
    if (lang && /^[a-z]{2}$/.test(lang)) batch.lang = lang;
    if (this.dropped > 0) {
      batch.dropped = this.dropped;
      this.dropped = 0;
    }
    const errors = takeErrorCount();
    if (errors > 0) batch.errors = errors;
    return batch;
  }

  private requeue(events: CapturedEvent[]): void {
    this.queue.unshift(...events);
    if (this.queue.length > this.maxQueue) {
      const overflow = this.queue.length - this.maxQueue;
      this.queue.splice(this.queue.length - overflow, overflow);
      this.dropped += overflow;
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }
}

const shortCode = (s: string | undefined) => (s !== undefined && /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : undefined);
