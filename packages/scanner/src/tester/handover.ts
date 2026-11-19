/**
 * "Set up sign-in" (A1, as e2e's test.setup and TesterArmy's prep test): the only place a person is
 * waited for. A run never waits for a person; a code, a link, a captcha or a "confirm it's you" page in
 * a run ends it BLOCKED with a code and the fix. Before the runs, under Accounts, the person presses
 * "Set up sign-in": a real browser window opens on their own computer (nothing of it is streamed or
 * recorded), they sign in there themselves (type the email or SMS code, open the magic link, solve a
 * captcha, pass Google), and press Done in the app. The signed-in check is then measured (signin.ts
 * signInByHand), and only then is the session saved. Later runs reuse it with no one there.
 *
 * THE RULE (hard): this controller never acts on a page. It only waits for the person's Done or Give up,
 * and nothing they type passes through it. With no app page open, nothing is asked.
 */
import type { HandOverId, HandOverRequest, LiveEventOf } from "../../../../cli/app/contracts.ts";

/** How long a person has to finish signing in before the setup gives up (nothing saved). */
export const HANDOVER_TIMEOUT_MS = 5 * 60_000;

/** What the setup pop-up says while the window is open. */
export const SET_UP_WORDS = (label: string) => `A browser window opened on this computer. Sign in there yourself as ${label}: type the code from your email or phone, open the sign-in link, or solve the check there. Then press Done. Nothing of the window is recorded, and only this site's own cookies are kept.`;

export type HandOverEvent = LiveEventOf<"handover">;

export interface HandOverDeps {
  /** How many app pages are open now (ui-server's /events streams). 0: nothing is asked. */
  viewers: () => number;
  /** Sends a live event (ui-server's send). */
  emit: (e: HandOverEvent) => void;
  now?: () => number;
  timeoutMs?: number;
  newId?: () => HandOverId;
}

interface Open {
  request: HandOverRequest;
  done: () => void;
  cancel: () => void;
}

let seq = 0;
const defaultId = (): HandOverId => `ho_${Date.now().toString(16).slice(-8)}${(seq++ % 0x10000).toString(16).padStart(4, "0")}`;

/** One per ui-server. Holds the open "Set up sign-in" waits (one at a time in practice). */
export class HandOver {
  private readonly open = new Map<HandOverId, Open>();
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly newId: () => HandOverId;
  private readonly deps: HandOverDeps;

  constructor(deps: HandOverDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? HANDOVER_TIMEOUT_MS;
    this.newId = deps.newId ?? defaultId;
  }

  /** Whether an app page is open now, where the person could press Done. */
  watched(): boolean {
    return this.deps.viewers() > 0;
  }

  /** The open setup for this id (the pop-up after a reload), if any. */
  pendingFor(testId: string): HandOverRequest | undefined {
    for (const o of this.open.values()) if (o.request.testId === testId) return o.request;
    return undefined;
  }

  /**
   * "Set up sign-in": a real browser window was opened on the person's own computer, where they sign in
   * themselves. This only waits for their Done (true) or Give up (false), or the time running out (false).
   * With no app page open: false at once, nothing asked. Done is never taken on trust: the caller measures
   * the signed-in check afterwards (signInByHand).
   */
  async pauseByHand(p: { testId: string; host: string; label: string; signal?: AbortSignal }): Promise<boolean> {
    if (this.deps.viewers() <= 0 || p.signal?.aborted) return false;
    const t0 = this.now();
    const id = this.newId();
    const request: HandOverRequest = {
      id, testId: p.testId, reason: "sign_in_setup", account: p.label,
      words: SET_UP_WORDS(p.label),
      host: p.host, startedAt: new Date(t0).toISOString(), deadline: new Date(t0 + this.timeoutMs).toISOString(),
    };
    const outcome = await new Promise<"resumed" | "timedOut" | "cancelled">((resolve) => {
      let finished = false;
      const finish = (o: "resumed" | "timedOut" | "cancelled") => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        p.signal?.removeEventListener("abort", onAbort);
        this.open.delete(id);
        resolve(o);
      };
      const timer = setTimeout(() => finish("timedOut"), this.timeoutMs);
      const onAbort = () => finish("cancelled");
      p.signal?.addEventListener("abort", onAbort, { once: true });
      this.open.set(id, { request, done: () => finish("resumed"), cancel: () => finish("cancelled") });
      this.deps.emit({ type: "handover", id: p.testId, state: "needed", request });
    });
    if (outcome === "resumed") this.deps.emit({ type: "handover", id: p.testId, state: "resumed", handover: id, by: "person" });
    else this.deps.emit(outcome === "timedOut" ? { type: "handover", id: p.testId, state: "timedOut", handover: id } : { type: "handover", id: p.testId, state: "cancelled", handover: id });
    return outcome === "resumed";
  }

  /** The person pressed Done (POST /api/handover/:id/done). */
  done(id: HandOverId): { ok: true } | { ok: false; error: string } {
    const o = this.open.get(id);
    if (!o) return { ok: false, error: "that sign-in setup isn't open" };
    o.done();
    return { ok: true };
  }

  /** The person gave up (POST /api/handover/:id/cancel): nothing is saved. */
  cancel(id: HandOverId): { ok: true } | { ok: false; error: string } {
    const o = this.open.get(id);
    if (!o) return { ok: false, error: "that sign-in setup isn't open" };
    o.cancel();
    return { ok: true };
  }
}
