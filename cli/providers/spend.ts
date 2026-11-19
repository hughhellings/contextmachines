/**
 * The spend guard. A run with no one watching (CI, a schedule, the local cloud's queue) that uses an AI
 * billed per token must say up front how much it may spend: --max-tokens, --max-usd, or the same in
 * CONTEXTMACHINES_MAX_TOKENS / CONTEXTMACHINES_MAX_USD. Without one it is refused before anything
 * is asked. A cap given to any run (watched or not) is kept: once the run has spent it, the next ask
 * fails with a sentence that says so.
 *
 * Measured, not guessed: tokens are what each answer said it took; dollars only where the provider
 * says a price (OpenRouter). A dollar cap on a provider that gives no price can't be kept, so it is
 * refused rather than quietly ignored. An answer that says no tokens counts its request's size in
 * characters / 3 (more than real text takes), so a silent provider can't run past a token cap.
 *
 * What it can't stop: asks already on their way when the cap is reached. Each is checked before it is
 * sent, so a run goes over by at most what the asks in flight take.
 */
import type { Ai, AiAnswer, AskMore } from "../ai.ts";

export interface SpendCap {
  maxTokens?: number;
  maxUsd?: number;
}

/** Said when the cap is reached: the run's AI stops asking. */
export const CAP_REACHED = "the run's AI spend cap was reached";

/** No one is watching: CI, or a run the local cloud or a schedule started (CONTEXTMACHINES_UNATTENDED=1). */
export function unattended(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (v: string | undefined) => Boolean(v && v.trim() !== "" && !/^(0|false|no)$/i.test(v.trim()));
  return on(env.CI) || on(env.CONTEXTMACHINES_UNATTENDED);
}

/**
 * The cap from the flags, else the environment. Throws a sentence for a value that isn't a positive
 * number (never a silent no-cap).
 */
export function readCap(flags: { maxTokens?: string | undefined; maxUsd?: string | undefined }, env: NodeJS.ProcessEnv = process.env): SpendCap {
  const pick = (flag: string | undefined, flagName: string, envName: string) => (flag !== undefined ? { raw: flag, from: flagName } : { raw: env[envName], from: envName });
  const tokens = pick(flags.maxTokens, "--max-tokens", "CONTEXTMACHINES_MAX_TOKENS");
  const usd = pick(flags.maxUsd, "--max-usd", "CONTEXTMACHINES_MAX_USD");
  const cap: SpendCap = {};
  if (tokens.raw !== undefined && tokens.raw.trim() !== "") {
    const n = Number(tokens.raw.trim().replace(/_/g, ""));
    if (!Number.isInteger(n) || n < 1) throw new Error(`${tokens.from} takes a whole number of tokens, like 200000`);
    cap.maxTokens = n;
  }
  if (usd.raw !== undefined && usd.raw.trim() !== "") {
    const n = Number(usd.raw.trim().replace(/^\$/, ""));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${usd.from} takes dollars, like 2.50`);
    cap.maxUsd = n;
  }
  return cap;
}

/** Whether the AI's answers say a price: today only OpenRouter's do (usage.cost). */
export const saysPrice = (ai: Pick<Ai, "via">) => ai.via === "OpenRouter";

/**
 * The run's AI with the cap kept, or a sentence saying why the run can't start. No AI, or an AI on
 * this machine or on the person's plan, needs no cap; a cap given is kept on any AI that says tokens.
 */
export function guardSpend(ai: Ai | undefined, cap: SpendCap, o: { unattended: boolean }): { ai: Ai | undefined } | { refuse: string } {
  if (!ai) return { ai };
  const capped = cap.maxTokens !== undefined || cap.maxUsd !== undefined;
  if (cap.maxUsd !== undefined && cap.maxTokens === undefined && !saysPrice(ai)) {
    return { refuse: `${ai.via} doesn't say what an answer costs, so a dollar cap can't be kept: give --max-tokens instead (or as well)` };
  }
  if (!capped) {
    if (ai.paid && o.unattended) {
      return { refuse: `${ai.via} bills per token and no one is watching this run (CI or a schedule): give it a cap, like --max-tokens 200000${saysPrice(ai) ? " or --max-usd 2" : ""} (or CONTEXTMACHINES_MAX_TOKENS), or use --ai none (no AI, $0)` };
    }
    return { ai };
  }
  return { ai: withCap(ai, cap) };
}

/**
 * The same AI, its light model too, sharing one count: before each ask, the spend so far plus what the
 * asks in flight are expected to take is held against the cap.
 */
export function withCap(ai: Ai, cap: SpendCap): Ai {
  let tokens = 0;
  let usd = 0;
  let pending = 0;
  // A dollar cap with no token cap is only kept while every answer says its price: one that doesn't stops the run's asks.
  let unpriced = false;
  const dollarsOnly = cap.maxUsd !== undefined && cap.maxTokens === undefined;
  const over = () => (cap.maxTokens !== undefined && tokens + pending >= cap.maxTokens) || (cap.maxUsd !== undefined && usd >= cap.maxUsd) || (dollarsOnly && unpriced);
  const said = () => [cap.maxTokens !== undefined ? `${Math.round(tokens)} of ${cap.maxTokens} tokens` : "", cap.maxUsd !== undefined ? `$${usd.toFixed(4)} of $${cap.maxUsd}` : ""].filter(Boolean).join(", ");
  const kept = <T extends Pick<Ai, "model" | "ask">>(asked: T): T => ({
    ...asked,
    async ask(system: string, question: string, schema: object, more?: AskMore): Promise<AiAnswer> {
      if (dollarsOnly && unpriced) throw new Error(`${CAP_REACHED}: ${ai.via} gave an answer with no price, so the dollar cap can't be kept; give --max-tokens as well`);
      if (over()) throw new Error(`${CAP_REACHED} (${said()}): no more questions to ${ai.via} in this run`);
      // What it is expected to take until it says: its size in characters / 3 (pictures as base64 / 4, as bytes).
      const guess = Math.ceil((system.length + question.length) / 3) + (more?.images ?? []).reduce((n, i) => n + Math.ceil(i.data.length / 3), 0);
      pending += guess;
      try {
        const answer = await asked.ask(system, question, schema, more);
        const u = answer.usage;
        tokens += u ? u.input + u.cacheRead + u.cacheWrite + u.output : guess + Math.ceil(answer.text.length / 3);
        const price = answer.costUsd ?? u?.costUsd;
        if (price === undefined) unpriced = true;
        usd += price ?? 0;
        return answer;
      } catch (error) {
        // A failed answer may still say what it took (as timedAi notes it).
        const u = (error as { usage?: AiAnswer["usage"] } | null)?.usage;
        // One that says nothing (a timeout, a dropped connection) may still have been billed: its guess
        // counts. That over-counts an ask that never reached the provider, the safe side for a cap.
        tokens += u ? u.input + u.cacheRead + u.cacheWrite + u.output : guess;
        throw error;
      } finally {
        pending -= guess;
      }
    },
  });
  return { ...kept(ai), ...(ai.light ? { light: kept(ai.light) } : {}) };
}
