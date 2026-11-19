/**
 * E5, two parts.
 *
 * 1. waitFor: when the actor says "wait", the browser waits for it, cheaply. It reads a signature of
 *    the page every ~3 s (no AI), and comes back to the AI only when the page has changed, or the
 *    step's measured check now holds, or the wait is used up. A slow report that appears after 20 s
 *    costs one more model call, not seven. Nothing here passes a step: the check is still measured by
 *    run.ts after it.
 *
 * 2. The failures-in-a-row guard: a TesterBrain wrapper that reads the history run.ts already gives
 *    the actor. After 3 tries in a row that didn't work (an error, a press that changed nothing, an
 *    answer that couldn't be used, a "done" whose check didn't hold) it tells the actor once to change
 *    approach; after 5 it answers "stuck" itself, without asking the model, so the step ends with a
 *    verdict (run.ts's giveUp measures the check, as ever). It never says done, so it never passes.
 */
import type { Page, Request } from "playwright";
import type { Action, DecideInput, TesterBrain } from "./types.ts";

/** How often the page is read while waiting. */
export const POLL_MS = 3_000;
/** The longest one wait lasts before the AI is asked again. */
export const WAIT_MAX_MS = 30_000;
/**
 * A step's first wait on a settled page (nothing loading: see networkWatch) ends after this long with
 * no change: nothing is coming, so 30 s of waiting would only pad the run. (Seen on a real app:
 * "Waiting 30.0s" before every run's first click: the AI saw the page while it was still drawing,
 * asked to wait, and the page finished before the wait began, so nothing changed after.)
 */
export const SETTLED_WAIT_MS = 3_000;
/** A later wait in the same step (the AI expects something): it is cut short only after this long. */
export const SETTLED_AGAIN_MS = 15_000;
/** A request to another site in flight longer than this is a stuck beacon or a long poll: not loading. The site's own count however long they take. */
export const LOADING_REQUEST_MS = 10_000;
/** A request started or finished, or a socket message, this recently: the page is still busy. */
export const BUSY_MS = 2_000;

export type WaitEnd = "changed" | "held" | "timeout" | "stopped";

export interface WaitOptions {
  /** The page's signature now: cheap, no AI (see pageSignature). */
  signature: () => Promise<string>;
  /** The step's measured check holds now (optional). */
  holds?: () => Promise<boolean>;
  everyMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  /**
   * Nothing is loading now (see networkWatch). With it, a wait whose page hasn't changed after
   * `settledMs` (default SETTLED_WAIT_MS) while nothing is loading ends then, as a timeout.
   */
  quiet?: () => Promise<boolean>;
  settledMs?: number;
  /**
   * The page's signature when the AI last saw it. A page that changed between that look and the wait
   * (it finished drawing while the AI was deciding) ends the wait at once as "changed".
   */
  seen?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitOutcome {
  end: WaitEnd;
  /** A timeout cut short because nothing was loading. */
  settled?: true;
  polls: number;
  ms: number;
}

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Waits until the page changes, the check holds, or time is up. Never asks the AI. */
export async function waitForChange(o: WaitOptions): Promise<WaitOutcome> {
  const every = Math.max(50, o.everyMs ?? POLL_MS);
  const max = Math.max(every, o.maxMs ?? WAIT_MAX_MS);
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const begun = now();
  const first = await o.signature().catch(() => "");
  let polls = 0;
  if (o.seen !== undefined && first && first !== o.seen) return { end: "changed", polls, ms: now() - begun };
  while (now() - begun < max) {
    if (o.signal?.aborted) return { end: "stopped", polls, ms: now() - begun };
    await sleep(Math.min(every, max - (now() - begun)));
    polls++;
    if (o.signal?.aborted) return { end: "stopped", polls, ms: now() - begun };
    if (o.holds && (await o.holds().catch(() => false))) return { end: "held", polls, ms: now() - begun };
    const fp = await o.signature().catch(() => first);
    if (fp !== first) return { end: "changed", polls, ms: now() - begun };
    if (o.quiet && now() - begun >= (o.settledMs ?? SETTLED_WAIT_MS) && (await o.quiet().catch(() => false))) return { end: "timeout", settled: true, polls, ms: now() - begun };
  }
  return { end: "timeout", polls, ms: now() - begun };
}

/**
 * Runs in the page, self-contained: what a person would see change. The address, the title, the
 * visible text and the number of elements; not a clock's seconds (digits are folded) so a ticking
 * timer alone doesn't count as "changed".
 */
function readSignature(): string {
  const text = (document.body?.innerText ?? "").replace(/\d/g, "0").replace(/\s+/g, " ").slice(0, 200_000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return `${location.href}\n${document.title}\n${document.querySelectorAll("*").length}\n${h}`;
}

/** A page's signature for waitForChange. */
export function pageSignature(page: Page): () => Promise<string> {
  return () => page.evaluate(readSignature).catch(() => `gone:${page.url()}`);
}

/**
 * Whether anything is loading on a page. Loading: its document hasn't finished loading; a request to
 * the site itself is in flight, however long (a slow report, an event stream or a long poll: the wait
 * runs its full length, as before); a request to another site started less than LOADING_REQUEST_MS ago
 * (an older one is a stuck beacon); or any request started or finished, or a socket message came, in
 * the last BUSY_MS. Watches the page's requests from when it is made; `stop` stops watching.
 */
export function networkWatch(page: Page, o: { now?: () => number; own?: (url: string) => boolean } = {}): { quiet: () => Promise<boolean>; stop: () => void } {
  const now = o.now ?? Date.now;
  const inFlight = new Map<Request, { at: number; own: boolean }>();
  let last = now();
  const busy = () => {
    last = now();
  };
  const start = (r: Request) => {
    busy();
    let own = true;
    try {
      own = o.own ? o.own(r.url()) : true;
    } catch {
      own = true;
    }
    if (inFlight.size < 500) inFlight.set(r, { at: now(), own });
  };
  const end = (r: Request) => {
    busy();
    inFlight.delete(r);
  };
  const socket = (ws: { on: (e: "framereceived", f: () => void) => unknown }) => {
    ws.on("framereceived", busy);
  };
  page.on("request", start);
  page.on("requestfinished", end);
  page.on("requestfailed", end);
  page.on("websocket", socket);
  return {
    async quiet() {
      const t = now();
      if (t - last < BUSY_MS) return false;
      for (const r of inFlight.values()) if (r.own || t - r.at < LOADING_REQUEST_MS) return false;
      const ready = await page.evaluate(() => document.readyState).catch(() => "complete");
      return ready === "complete";
    },
    stop() {
      page.off("request", start);
      page.off("requestfinished", end);
      page.off("requestfailed", end);
      page.off("websocket", socket);
    },
  };
}

/** The words the actor is told when the wait ended without the page changing. */
export function waitWords(w: WaitOutcome): string {
  if (w.end === "changed") return `The browser waited ${(w.ms / 1000).toFixed(0)}s and the page changed: look again.`;
  if (w.end === "held") return `The browser waited ${(w.ms / 1000).toFixed(0)}s and the step's check now holds: say done if the step is achieved.`;
  if (w.end === "stopped") return "The wait was stopped.";
  if (w.settled) return `The browser waited ${(w.ms / 1000).toFixed(0)}s: nothing on the page changed and nothing is loading. Go on with the step; if you know something is still coming, wait again (a second wait lasts longer), or say stuck.`;
  return `The browser waited ${(w.ms / 1000).toFixed(0)}s and nothing on the page changed: try another way, or say stuck.`;
}

// ---------------------------------------------------------------------------------------------
// The failures-in-a-row guard

/** Tries in a row that didn't work before the actor is told to change approach. */
export const CHANGE_APPROACH_AT = 3;
/** Tries in a row that didn't work before the step ends with a verdict. */
export const VERDICT_AT = 5;

/** A history line (run.ts's words) that says the try didn't work. */
export function failedLine(line: string): boolean {
  // A wait that changed nothing is waiting, not a failed try.
  if (/^Waiting\b/.test(line)) return false;
  if (/: didn't work \(|→ no change on the page$/.test(line)) return true;
  // A press whose only change was focus landing on the very control pressed: nothing happened.
  const pressed = /^Clicking on '(.+?)'/.exec(line)?.[1];
  const focus = /→ focus moved to \[e\d+\] [\w-]+ "(.*?)"(?: \[focused\])?$/.exec(line)?.[1];
  return pressed !== undefined && focus !== undefined && focus === pressed;
}

/** A problem (run.ts's words) that says the last answer or the check failed. */
export function failedProblem(problem: string | undefined): boolean {
  return Boolean(problem && /couldn't be used|isn't one of|not in the snapshot|the check didn't hold|You said done, but|doesn't name|no such element|wasn't pressed|changed nothing/i.test(problem));
}

export const CHANGE_APPROACH_WORDS = `Your last ${CHANGE_APPROACH_AT} tries in a row didn't work. Change approach: use a different element or another route to the same place, close what is in the way, or scroll to find it. If there is truly no way, say stuck.`;
export const VERDICT_WORDS = `${VERDICT_AT} tries in a row didn't work, so the step ends here`;

export interface GuardState {
  /** Steps whose actor has been told to change approach. */
  warned: Set<number>;
  /** Model calls the guard saved by answering "stuck" itself. */
  ended: number;
}

/**
 * Wraps a brain with the failures-in-a-row guard. The count is per step and reads only what run.ts
 * already tells the actor (`history`, `problem`), so it works on today's runTest with no engine edit.
 */
export function guardBrain<B extends TesterBrain>(brain: B): B & { guard: GuardState } {
  const guard: GuardState = { warned: new Set(), ended: 0 };
  /** Per step: the history length at the last ask, and the failed answers since the last line that worked. */
  const seen = new Map<number, { lines: number; answers: number }>();
  const wrapped = Object.create(brain) as B & { guard: GuardState };
  wrapped.guard = guard;
  wrapped.plan = (...args: Parameters<TesterBrain["plan"]>) => brain.plan(...args);
  /** The guard's word on this ask: a "stuck" that ends the step, or the input to ask with (maybe with the change-approach line). */
  const gate = (input: DecideInput): { end: Action } | { ask: DecideInput } => {
    // The first ask of a step (no lines yet, nothing gone wrong) starts its count afresh, and a history
    // shorter than last time is a new run of the same step number: a brain kept across retries or
    // tests in a group never carries one run's failures into the next.
    let s = seen.get(input.n);
    if (!s || (input.history.length === 0 && !input.problem) || input.history.length < s.lines) {
      s = { lines: 0, answers: 0 };
      guard.warned.delete(input.n);
    }
    // run.ts completes each try's line with what it changed before the next ask, so every line is final here.
    let trailing = 0;
    for (let i = input.history.length - 1; i >= 0 && failedLine(input.history[i]!); i--) trailing++;
    // A line that worked since the last ask clears the failed answers counted before it.
    if (input.history.length > s.lines && trailing < input.history.length - s.lines) s.answers = 0;
    // An answer that couldn't be used, or a "done" whose check didn't hold, adds no line: only a problem.
    if (failedProblem(input.problem) && input.history.length === s.lines) s.answers++;
    s.lines = input.history.length;
    seen.set(input.n, s);
    const inRow = trailing + s.answers;
    if (inRow >= VERDICT_AT) {
      guard.ended++;
      return { end: { type: "stuck", why: VERDICT_WORDS } };
    }
    if (inRow >= CHANGE_APPROACH_AT && !guard.warned.has(input.n)) {
      guard.warned.add(input.n);
      return { ask: { ...input, problem: input.problem ? `${input.problem} ${CHANGE_APPROACH_WORDS}` : CHANGE_APPROACH_WORDS } };
    }
    return { ask: input };
  };
  wrapped.decide = async (input: DecideInput): Promise<Action> => {
    const g = gate(input);
    return "end" in g ? g.end : brain.decide(g.ask);
  };
  // The speed lane's batched ask (E7) goes through the same count: without this, Object.create would
  // hand run.ts the inner brain's decideMany and skip the guard.
  if (brain.decideMany) {
    const many = brain.decideMany.bind(brain);
    wrapped.decideMany = async (input: DecideInput): Promise<Action[]> => {
      const g = gate(input);
      return "end" in g ? [g.end] : many(g.ask);
    };
  }
  return wrapped;
}
