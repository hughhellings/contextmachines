/**
 * Tests in code: exact Playwright steps and agent steps in one test, on the tester's engine.
 *
 *   const agent = await createAgent(page, { start: url, brain, cache: "tests/.cm/search.json" });
 *   await page.getByRole("button", { name: "Search" }).click();              // exact, the developer's own
 *   await agent.act("Type AAPL and open the Apple row", { check: { kind: "url_contains", text: "symbol=AAPL" } });
 *   await agent.assert({ kind: "text_visible", text: "AAPL chart" });        // measured by the browser
 *   const report = await agent.finish();                                       // the verdict; the cache is written on a pass
 *
 * The engine's guarantees hold here as in `contextmachines test`: the AI picks one action at a time
 * and never decides pass or fail (the browser measures each check); every action goes through act()'s
 * safety rules (no paying, buying, deleting, sending; no leaving the site); a bot check is waited on,
 * never answered, and is BLOCKED; values reach the AI and the cache only as {name} handles; a test
 * that passed replays from its cache with no AI at all.
 *
 * A step that doesn't pass throws an AgentStepError whose `verdict` says what it was ("blocked",
 * "failed", "not_sure") and whose message starts with it ("BLOCKED: …"): a test runner shows it as
 * such. `{ soft: true }` returns the step instead. Steps after one that didn't pass are skipped.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";
import { act, guardSite, labelOf, locateLive, locateSaved, onSite, RULES, type ActContext, type Outcome } from "../../packages/scanner/src/tester/act.ts";
import { sendHeldByWidget } from "../../packages/scanner/src/tester/detect-botwall.ts";
import { A_CHALLENGE, CHALLENGE_REFUSED, wallReason, WallWatch } from "../../packages/scanner/src/tester/botwall.ts";
import { checkFrom, withoutSecrets } from "../../packages/scanner/src/tester/cache.ts";
import { expected, verify, type Verified } from "../../packages/scanner/src/tester/check.ts";
import { changeOf, observe, SNAPSHOT_CHARS, type Snapshot } from "../../packages/scanner/src/tester/observe.ts";
import { fillPlaceholders, isPasswordName, makeMasker, placeholderNames, splitName, usesPlaceholder, type Masker, type Resolver } from "../../packages/scanner/src/tester/placeholders.ts";
import { actionProblem, checkGaming, clip, CREDENTIAL_REFUSED, loopGuard, MAX_SIGN_IN_SUBMITS, newSignInGuard, RING, type SignInGuard, type Turn } from "../../packages/scanner/src/tester/run.ts";
import type { Action, CachedAction, Check, DecideInput, StartPage, StepVerdict, TestVerdict } from "../../packages/scanner/src/tester/types.ts";

export type { Action, Check, DecideInput, StartPage, StepVerdict, TestVerdict } from "../../packages/scanner/src/tester/types.ts";

/** The cache file's format. A change to what is saved, or to the engine's matching rules, starts it cold. */
export const CACHE_VERSION = 1;
const DEFAULT_PER_STEP = 8;
const DEFAULT_CHECK_WAIT_MS = 5000;
/** A saved element is waited for this long before it counts as gone. */
const FIND_WAIT_MS = 3000;

/**
 * The AI, handed in. `decide` is the engine's actor (TesterBrain.decide: the CLI's `aiBrain` fits).
 * `check` turns an assert's words into one of the checks the browser can measure: it is asked once,
 * what it gives is shown in the step and cached, and it never says pass or fail.
 */
export interface AgentBrain {
  decide(input: DecideInput): Promise<Action>;
  check?(words: string, page: StartPage): Promise<Check>;
}

export interface AgentOptions {
  /** The site the test is on (its address): the agent never leaves it. Defaults to the page's address now. */
  start?: string;
  brain?: AgentBrain;
  /** The replay cache: a JSON file, one per test. Without it nothing is saved and every step asks the AI. */
  cache?: string;
  /** false: the cache is read, never written (CI). Default true. */
  updateCache?: boolean;
  /** The test's name, told to the AI as the goal of each step. */
  name?: string;
  /** Values typed by handle: the AI writes {email}, the browser types the value. Never shown to the AI or saved. */
  vars?: Record<string, string>;
  /** A test account's values ({admin.password}), asked for only when typed. */
  secrets?: Resolver;
  /** Other hosts the test may go to. */
  allowHosts?: string[];
  /** The most actions one agent step may take. Default 8. */
  maxPerStep?: number;
  /** How long a check is tried for before it fails. Default 5000. */
  checkWaitMs?: number;
  /** How long a bot check is waited on, in all, before the step is BLOCKED. */
  wallWaitMs?: number;
  /** false: a saved element that has gone is NOT SURE, the AI isn't asked. Default true (with a brain). */
  heal?: boolean;
  /** Each step as it ends. */
  on?: (step: AgentStep) => void;
  /** Sign-in tries shared between agents (a suite): no account gets more than 3 submits, and a refused password isn't typed again. */
  signInGuard?: SignInGuard;
}

export interface AgentStep {
  n: number;
  kind: "act" | "assert" | "code";
  title: string;
  verdict: StepVerdict;
  /** Why it wasn't passed, in one sentence (masked). */
  reason?: string;
  /** A failed check: what was expected and what the page had instead. */
  evidence?: { expected: string; found: string };
  /** The check the browser measured. */
  check?: Check;
  /** The assert's check was made from its words by the AI (and cached): shown so it can be read. */
  derived?: true;
  /** It passed, but its check proves little: why. */
  weak?: string;
  /** What was done, as a person says it (masked). */
  actions: string[];
  /** Every action came from the cache, with no AI. */
  replayed?: true;
  /** A saved element had gone, and the AI found another way: never silent. */
  healed?: { from: string[]; to: string[] };
  /** AI calls this step made. */
  aiCalls: number;
  ms: number;
}

export interface AgentReport {
  verdict: TestVerdict;
  steps: AgentStep[];
  /** AI calls the whole test made: 0 on a full replay. */
  aiCalls: number;
  /** Every agent step came from the cache. */
  replay: boolean;
  /** Where the cache was written, when it was. */
  cacheWritten?: string;
}

/** A step that didn't pass, thrown: `verdict` says what it was. */
export class AgentStepError extends Error {
  override name = "AgentStepError";
  readonly verdict: Exclude<StepVerdict, "passed">;
  readonly step: AgentStep;
  constructor(step: AgentStep) {
    super(`${verdictWord(step.verdict)}: step ${step.n} (${step.title})${step.reason ? `: ${step.reason}` : ""}`);
    this.verdict = step.verdict as Exclude<StepVerdict, "passed">;
    this.step = step;
  }
}

const verdictWord = (v: StepVerdict) => ({ passed: "PASS", failed: "FAIL", blocked: "BLOCKED", not_sure: "NOT SURE", skipped: "SKIPPED" })[v];

export interface StepOptions {
  /** Return the step whatever its verdict, instead of throwing when it didn't pass. */
  soft?: boolean;
}

export interface ActOptions extends StepOptions {
  /** What must be true after it, measured by the browser. Without one it ends when the AI says done (weak). */
  check?: Check;
}

export interface Agent {
  readonly page: Page;
  /** An agent step: the AI picks actions from the page until `check` holds. Replayed from the cache when it can be. */
  act(intent: string, o?: ActOptions): Promise<AgentStep>;
  /** A measured check: one of ours, or words the AI turns into one (once, cached). Never judged. */
  assert(check: Check | string, o?: StepOptions): Promise<AgentStep>;
  /** The developer's own Playwright code as a named step: an error in it is a FAIL, leaving the site is BLOCKED. */
  step(title: string, fn: (page: Page) => Promise<unknown>, o?: StepOptions): Promise<AgentStep>;
  /** The test's verdict; writes the cache when every step passed and something new was learned. */
  finish(): Promise<AgentReport>;
}

/** One saved agent step, by kind and words (and which time those words came up). */
interface SavedEntry {
  kind: "act" | "assert";
  words: string;
  check?: Check;
  actions?: CachedAction[];
}

interface CacheFile {
  version: number;
  rules: number;
  site: string;
  steps: SavedEntry[];
}

const keyOf = (kind: string, words: string, nth: number) => `${kind}\n${words.trim().replace(/\s+/g, " ")}\n${nth}`;

/** The cache, when it is there and of this version and these rules: anything else is started cold. */
export function readCache(path: string): Map<string, SavedEntry> {
  const out = new Map<string, SavedEntry>();
  if (!existsSync(path)) return out;
  let file: CacheFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
  } catch {
    return out;
  }
  if (file?.version !== CACHE_VERSION || file.rules !== RULES || !Array.isArray(file.steps)) return out;
  const seen = new Map<string, number>();
  for (const s of file.steps) {
    if ((s?.kind !== "act" && s?.kind !== "assert") || typeof s.words !== "string") continue;
    const check = s.check === undefined ? undefined : checkFrom(s.check);
    if (s.check !== undefined && !check) continue;
    const base = keyOf(s.kind, s.words, 0).replace(/\n0$/, "");
    const nth = seen.get(base) ?? 0;
    seen.set(base, nth + 1);
    // A saved action that isn't one (a hand edit, a bad merge) drops the whole entry: that step starts cold,
    // never half-replayed, and never a crash inside the engine.
    if (s.actions !== undefined && (!Array.isArray(s.actions) || !s.actions.every(isCachedAction))) continue;
    out.set(keyOf(s.kind, s.words, nth), { kind: s.kind, words: s.words, ...(check ? { check } : {}), ...(Array.isArray(s.actions) ? { actions: s.actions } : {}) });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTarget = (v: unknown) => isObj(v) && typeof v.role === "string" && typeof v.name === "string";
/** The shape the engine's own reader (cache.ts actionFrom) requires of a saved action. */
export function isCachedAction(v: unknown): v is CachedAction {
  if (!isObj(v)) return false;
  switch (v.type) {
    case "click":
    case "hover":
      return isTarget(v.target);
    case "fill":
    case "select":
      return isTarget(v.target) && typeof v.value === "string";
    case "type":
      return typeof v.value === "string" && (v.into === undefined || isTarget(v.into));
    case "press":
      return typeof v.key === "string";
    case "scroll":
      return v.target === undefined || isTarget(v.target);
    case "back":
      return true;
    case "dblclick":
    case "rightclick":
    case "check":
    case "uncheck":
      return isTarget(v.target);
    case "scroll_to":
      return typeof v.text === "string";
    case "navigate":
      return typeof v.url === "string";
    case "wait":
      return typeof v.ms === "number";
    default:
      return false;
  }
}

const firstLine = (e: unknown) => clip((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "", 300);
const snapText = (snap: Snapshot) => `${snap.dialog ? `(A dialog is open: "${snap.dialog}")\n` : ""}${snap.text}`;

/** A check with its {name}s filled in, so it can be about a value the AI never sees. */
function withValues(check: Check, get: (name: string) => string | undefined): Check {
  const fill = (t: string) => fillPlaceholders(t, get);
  if (check.kind === "signed_in") return { ...check, ...(check.text ? { text: fill(check.text) } : {}), ...(check.url ? { url: fill(check.url) } : {}) };
  if (check.kind === "element_visible") return { ...check, name: fill(check.name) };
  return "text" in check ? { ...check, text: fill(check.text) } : check;
}

/** A check as the AI and the report may see it: any value written in it is shown as its {name}. */
function maskedCheck(check: Check, mask: (s: string) => string): Check {
  const out: Record<string, unknown> = { ...check };
  for (const [k, v] of Object.entries(out)) if (k !== "kind" && k !== "role" && typeof v === "string") out[k] = mask(v);
  return out as unknown as Check;
}

type End = Pick<AgentStep, "verdict" | "reason" | "evidence" | "weak">;

/**
 * An agent on a page the developer owns. Its site guard goes on now, before the developer's own
 * steps: nothing in the test (their locator steps included) navigates to another site.
 */
export async function createAgent(page: Page, options: AgentOptions = {}): Promise<Agent> {
  const start = options.start ?? page.url();
  if (!/^https?:/.test(start)) throw new TypeError("createAgent needs the site's address: pass { start: url }, or open the page first");
  const allowHosts = options.allowHosts ?? [];
  const vars = options.vars ?? {};
  const mask: Masker = makeMasker(vars);
  const secretNames = options.secrets ? options.secrets.names().filter((n) => options.secrets!.has(n)) : [];
  for (const name of secretNames) {
    const value = options.secrets!.peek?.(name) ?? options.secrets!.get(name);
    if (value) mask.add(name, value, true);
  }
  const lookup = (name: string): string | undefined => {
    if (name in vars) return vars[name];
    const value = options.secrets?.has(name) ? options.secrets.get(name) : undefined;
    if (value) mask.add(name, value, true);
    return value;
  };
  const typeNames = [...Object.keys(vars), ...secretNames.filter((n) => !(n in vars))];
  const maxPerStep = options.maxPerStep ?? DEFAULT_PER_STEP;
  const checkWaitMs = options.checkWaitMs ?? DEFAULT_CHECK_WAIT_MS;
  const brain = options.brain;
  const heal = options.heal !== false && Boolean(brain);
  const sameSite = (u: string) => onSite(u, start, allowHosts);
  const offSite = await guardSite(page, start, allowHosts);
  const watch = new WallWatch(options.wallWaitMs);
  const saved = options.cache ? readCache(options.cache) : new Map<string, SavedEntry>();
  const learned: SavedEntry[] = [];
  const occurrences = new Map<string, number>();
  const steps: AgentStep[] = [];
  let aiCalls = 0;
  /** Something was learned that the cache doesn't have: a fresh step, a heal, a new check. */
  let fresh = false;
  let lastSnap: Snapshot | undefined;

  const nextKey = (kind: "act" | "assert", words: string) => {
    const base = `${kind}\n${words.trim().replace(/\s+/g, " ")}`;
    const nth = occurrences.get(base) ?? 0;
    occurrences.set(base, nth + 1);
    return keyOf(kind, words, nth);
  };
  const stoppedEarly = () => steps.some((s) => s.verdict !== "passed");
  /** The step, kept and told; thrown when it didn't pass, unless soft. */
  const finishStep = (step: AgentStep, o: StepOptions = {}): AgentStep => {
    steps.push(step);
    options.on?.(step);
    if (step.verdict !== "passed" && !o.soft) throw new AgentStepError(step);
    return step;
  };
  const skipped = (kind: AgentStep["kind"], title: string, o?: StepOptions) => {
    const first = steps.find((s) => s.verdict !== "passed" && s.verdict !== "skipped") ?? steps.find((s) => s.verdict !== "passed");
    const why = first ? `step ${first.n} (${first.title}) was ${verdictWord(first.verdict)}${first.reason ? `: ${first.reason}` : ""}` : "an earlier step didn't pass";
    return finishStep({ n: steps.length + 1, kind, title: mask(title), verdict: "skipped", reason: clip(`an earlier step didn't pass: ${why}`, 400), actions: [], aiCalls: 0, ms: 0 }, o);
  };
  /**
   * A step's body, run so that an error nobody expected (the page closed, the engine threw) is still a
   * step: NOT SURE, kept, and thrown as an AgentStepError. Without this the step would be missing and
   * finish() would say pass, and write the cache, over a test that crashed.
   */
  const contained = async (kind: AgentStep["kind"], title: string, o: StepOptions, body: () => Promise<AgentStep>): Promise<AgentStep> => {
    const before = steps.length;
    const t0 = Date.now();
    try {
      return await body();
    } catch (error) {
      if (error instanceof AgentStepError || steps.length > before) throw error;
      return finishStep({ n: steps.length + 1, kind, title: mask(title), verdict: "not_sure", reason: mask(`the step stopped with an error: ${firstLine(error)}`), actions: [], aiCalls: 0, ms: Date.now() - t0 }, o);
    }
  };

  /** A safety stop, said as what it was: a bot check's own control is the wall; a code that couldn't be had has its own verdict. */
  const blockedBy = (why: string): End => {
    if (why.endsWith(CHALLENGE_REFUSED)) return { verdict: "blocked", reason: wallReason(A_CHALLENGE) };
    const code = /^(CODE_NOT_RECEIVED|CODE_SOURCE_UNAVAILABLE|CODE_NOT_SURE): /.exec(why)?.[1];
    if (code) return { verdict: code === "CODE_NOT_RECEIVED" ? "failed" : code === "CODE_NOT_SURE" ? "not_sure" : "blocked", reason: mask(why) };
    return { verdict: "blocked", reason: mask(why) };
  };
  /** Left the site, or a bot check that stays: BLOCKED. */
  const stopNow = async (): Promise<End | undefined> => {
    const off = offSite();
    if (off) return { verdict: "blocked", reason: mask(off) };
    const wall = await watch.stands(page);
    return wall ? { verdict: "blocked", reason: wallReason(wall) } : undefined;
  };
  const failedEnd = (v: Verified, why?: string): End => ({ verdict: "failed", reason: mask(`the check didn't hold: ${v.expected}${why ? ` (${why})` : ""}`), evidence: { expected: mask(v.expected), found: mask(v.found) } });

  const ctx: ActContext = {
    page,
    start,
    allowHosts,
    values: { vars, resolve: lookup, given: options.name ?? "", madeUp: { varNames: typeNames }, fromPerson: options.name ?? "" },
    mask,
    offSite,
    rules: RULES,
  };

  const guard = options.signInGuard ?? newSignInGuard();
  /** An account whose password was typed and not yet sent, and whether a value of the test's own was typed beside it. */
  let passwordFor: string | undefined;
  let typedOwn = false;
  /**
   * act(), under the engine's sign-in rule (run.ts, hard rule 8): a password the site refused is never
   * typed again, and no account gets more than 3 sign-in submits, so a test can't lock an account out.
   */
  const guarded = async (action: Parameters<typeof act>[1], target?: Parameters<typeof act>[2]): Promise<Outcome> => {
    if ((action.type === "fill" || action.type === "type") && action.value) {
      const pw = placeholderNames(action.value).find(isPasswordName);
      const who = pw ? (splitName(pw).label ?? pw) : undefined;
      if (who && guard.rejected.has(who)) return { blocked: `AUTH_CREDENTIAL_INVALID: ${who}'s password was already refused by the site, so it isn't typed again (that could lock the account)`, label: `Typing ${who}'s password` };
    }
    const role = target?.role ?? ("target" in action && action.target ? action.target.role : "button");
    const pressing = ((action.type === "click" || action.type === "dblclick") && /^(button|link|menuitem|item)$/.test(role)) || (action.type === "press" && action.key === "Enter");
    if (pressing && passwordFor && (guard.submits.get(passwordFor) ?? 0) >= MAX_SIGN_IN_SUBMITS) {
      return { blocked: `AUTH_ACCOUNT_LOCKED_OUT: ${passwordFor} has had ${MAX_SIGN_IN_SUBMITS} sign-in tries already, the most allowed, so it isn't sent again`, label: `Sending ${passwordFor}'s sign-in` };
    }
    // E10, as runTest does it: a press that would send a form whose captcha box no one has passed is
    // never made. The SDK has no hand-over, so the step is BLOCKED with the provider named.
    if (action.type === "click" || action.type === "dblclick" || (action.type === "press" && (action.key === "Enter" || action.key === "Space"))) {
      const where = action.type === "press" ? { el: page.locator(":focus") } : "ref" in action ? await locateLive(page, action.ref) : "target" in action ? await locateSaved(page, action.target, RULES) : undefined;
      const held = where && "el" in where ? await sendHeldByWidget(page, where.el.first(), { mask }) : undefined;
      if (held) {
        const name = target?.name ?? ("target" in action ? action.target.name : "");
        return { blocked: held.reason, label: action.type === "press" ? `Pressing ${action.key}` : `Clicking on '${clip(mask(name), 60)}'` };
      }
    }
    const outcome = await act(ctx, action, target);
    if (!("done" in outcome)) return outcome;
    const d = outcome.done;
    if (d.type === "fill" || d.type === "type") {
      const pw = placeholderNames(d.value).find(isPasswordName);
      if (pw) passwordFor = splitName(pw).label ?? pw;
      else if (!usesPlaceholder(d.value)) typedOwn = true;
    }
    const sent = ((d.type === "click" || d.type === "dblclick") && /^(button|link|menuitem|item)$/.test(d.target.role)) || (d.type === "press" && d.key === "Enter");
    if (sent && passwordFor && !/^the form wasn't sent/.test(outcome.note ?? "")) {
      const who = passwordFor;
      const own = typedOwn;
      passwordFor = undefined;
      typedOwn = false;
      guard.submits.set(who, (guard.submits.get(who) ?? 0) + 1);
      const words = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const refused = CREDENTIAL_REFUSED.exec(words);
      // Refused with only stored values typed: the stored password is wrong, and isn't tried again.
      if (refused && !own) {
        guard.rejected.add(who);
        const locked = /locked|blocked|suspended|too many/i.test(refused[0]);
        return { blocked: `${locked ? "AUTH_ACCOUNT_LOCKED_OUT" : "AUTH_CREDENTIAL_INVALID"}: the site said "${refused[0]}" after ${who}'s sign-in was sent, so it isn't tried again`, label: `Sent: ${outcome.label}` };
      }
    }
    if (sent) typedOwn = false;
    return outcome;
  };

  async function actStep(intent: string, o: ActOptions = {}): Promise<AgentStep> {
    if (stoppedEarly()) return skipped("act", intent, o);
    const check = o.check === undefined ? undefined : checkFrom(o.check);
    if (o.check !== undefined && !check) throw new TypeError(`agent.act: ${JSON.stringify(o.check)} isn't a check the browser can measure`);
    return contained("act", intent, o, () => actBody(intent, check, o));
  }

  async function actBody(intent: string, check: Check | undefined, o: ActOptions): Promise<AgentStep> {
    const n = steps.length + 1;
    const t0 = Date.now();
    const key = nextKey("act", intent);
    const entry = saved.get(key);
    // The person's own words for this step: what they gave may be typed as it is, anything else is labelled made up.
    ctx.values = { ...ctx.values, given: [options.name ?? "", intent].join("\n"), fromPerson: [options.name ?? "", intent].join("\n") };
    const filled = check ? withValues(check, lookup) : undefined;
    const heldBefore = filled && filled.kind !== "none" ? (await verify(page, filled, 0)).ok : false;
    const labels: string[] = [];
    const done: CachedAction[] = [];
    let calls = 0;
    let end: End | undefined;
    let needAi = !entry?.actions;
    let healFrom: CachedAction[] | undefined;
    let healStart = 0;

    const measure = async (): Promise<End | Verified> => {
      const stop = await stopNow();
      if (stop) return stop;
      if (!filled || filled.kind === "none") {
        // No check and nothing done proves nothing at all (the engine won't save such a step either).
        if (!done.some((a) => a.type !== "wait")) return { verdict: "not_sure", reason: "nothing was done and the step has no check, so nothing was tested: give it a check" };
        return { verdict: "passed", weak: "it has no check, so nothing was measured: assert what it should leave true" };
      }
      const v = await verify(page, filled, checkWaitMs);
      if (!v.ok) return v;
      if (heldBefore && !done.some((a) => a.type !== "wait")) return { verdict: "not_sure", reason: mask(`nothing was done but its check (${expected(filled)}) already held before it, so it proves nothing`) };
      return { verdict: "passed", ...(heldBefore ? { weak: "its check already held before the step, so it proves little" } : {}) };
    };
    const giveUp = async (why: string): Promise<End> => {
      if (!filled || filled.kind === "none") return { verdict: "not_sure", reason: mask(why) };
      const v = await verify(page, filled, 0);
      return v.ok ? { verdict: "not_sure", reason: mask(`${why}; its check holds, but the step wasn't finished`) } : failedEnd(v, why);
    };

    // Replay: each saved action as it was, found again by its saved identity; a gone one hands the rest to the AI.
    if (entry?.actions) {
      for (const [k, act1] of entry.actions.entries()) {
        const target = "target" in act1 ? act1.target : undefined;
        if (target) {
          const looked = Date.now();
          let found = false;
          while (!found && Date.now() - looked < FIND_WAIT_MS) {
            const r = await locateSaved(page, target, RULES);
            if ("el" in r) found = await r.el.first().waitFor({ state: "attached", timeout: Math.max(250, FIND_WAIT_MS - (Date.now() - looked)) }).then(() => true, () => false);
            if (!found) await page.waitForTimeout(250);
          }
          if (!found) {
            healFrom = entry.actions.slice(k);
            healStart = done.length;
            needAi = true;
            break;
          }
        }
        const outcome = await guarded(act1);
        if ("blocked" in outcome) {
          labels.push(outcome.label.startsWith("Sent: ") ? outcome.label.slice(6) : `Stopped before ${outcome.label}`);
          end = blockedBy(outcome.blocked);
          break;
        }
        if ("error" in outcome) {
          labels.push(`${outcome.label}: didn't work (${mask(outcome.error)})`);
          healFrom = entry.actions.slice(k);
          healStart = done.length;
          needAi = true;
          break;
        }
        labels.push(outcome.label);
        done.push(outcome.done);
        const stop = await stopNow();
        if (stop) {
          end = stop;
          break;
        }
      }
      if (!end && !needAi) {
        const m = await measure();
        end = "verdict" in m ? m : failedEnd(m);
      }
    }

    // Fresh, or healing: one action at a time, chosen by the AI from the page as it is now.
    if (!end && needAi) {
      if (!brain || (entry?.actions && !heal)) {
        end = { verdict: "not_sure", reason: !entry?.actions ? "this step isn't in the cache and there's no AI to do it (pass a brain)" : `a saved element has gone (${mask(labelOf(healFrom?.[0] ?? entry.actions[0]!, mask))}) and the AI isn't asked to find another way` };
      }
      const history: string[] = [];
      const ring: Turn[] = [];
      const warned = new Set<string>();
      let pending: { at: number; turn: Turn } | undefined;
      let problem: string | undefined;
      let unusable = 0;
      let own = 0;
      let checkRetried = false;
      while (!end) {
        if (own >= maxPerStep) {
          end = await giveUp(`${maxPerStep} actions weren't enough to finish this step`);
          break;
        }
        const before = lastSnap;
        const snap = await observe(page, mask, lastSnap, SNAPSHOT_CHARS, { onSite: sameSite });
        lastSnap = snap;
        if (pending) {
          if (pending.turn.result === "ok" && before) {
            const said = changeOf(before, snap);
            history[pending.at] = `${history[pending.at]} ${said}`;
            pending.turn.result = said === "→ no change on the page" ? "no change" : "changed";
          }
          const fired = loopGuard(ring);
          pending = undefined;
          if (fired && warned.has(fired.guard)) {
            end = await giveUp(fired.ends);
            break;
          }
          if (fired) {
            warned.add(fired.guard);
            problem = problem ? `${problem} ${fired.says}` : fired.says;
          }
        }
        let action: Action;
        try {
          calls++;
          aiCalls++;
          // Every word here is masked: no value reaches the AI, not even in what went wrong.
          action = await brain!.decide({ goal: mask(options.name ?? intent), step: { title: mask(intent), intent: mask(intent), check: check ? maskedCheck(check, mask) : { kind: "none" } }, n, of: n, url: snap.url, title: snap.title, snapshot: snapText(snap), history, vars: typeNames, ...(problem ? { problem: mask(problem) } : {}) });
        } catch (error) {
          end = { verdict: "not_sure", reason: `the AI didn't answer: ${mask(firstLine(error))}` };
          break;
        }
        problem = actionProblem(action, snap) ?? checkGaming(action, { title: intent, intent, check: check ?? { kind: "none" } }, options.name ?? intent);
        if (problem) {
          if (++unusable >= 2) end = { verdict: "not_sure", reason: mask(`the AI's answers couldn't be used: ${problem}`) };
          continue;
        }
        if (action.type === "stuck") {
          end = await giveUp(`the AI was stuck: ${clip(mask(String(action.why ?? "")), 300)}`);
          break;
        }
        if (action.type === "done") {
          const m = await measure();
          if ("verdict" in m) end = m;
          else if (!checkRetried && own < maxPerStep - 1) {
            // Said done too soon, maybe: told what was measured, once. It still can't make the check pass.
            checkRetried = true;
            problem = `You said done, but the check didn't hold: expected ${m.expected}; found ${m.found}. Keep going if there's more to do, or say stuck.`;
          } else end = failedEnd(m);
          continue;
        }
        const target = "ref" in action && action.ref ? snap.refs.get(action.ref) : action.type === "type" && snap.focusRef ? snap.refs.get(snap.focusRef) : undefined;
        const turnKey = target ? `${action.type}\n${target.role}\n${target.name}\n${target.nth}\n${"value" in action ? action.value : ""}` : JSON.stringify(action);
        const outcome: Outcome = await guarded(action, target);
        own++;
        if ("blocked" in outcome) {
          labels.push(outcome.label.startsWith("Sent: ") ? outcome.label.slice(6) : `Stopped before ${outcome.label}`);
          end = blockedBy(outcome.blocked);
          break;
        }
        const turn: Turn = { key: turnKey, type: action.type, label: outcome.label, keys: snap.keys, screen: snap.screen, result: "error" in outcome ? (outcome.kind ?? "other") : "ok" };
        ring.push(turn);
        if (ring.length > RING) ring.shift();
        if ("error" in outcome) {
          labels.push(`${outcome.label}: didn't work (${mask(outcome.error)})`);
          history.push(`${outcome.label}: didn't work (${mask(outcome.error)})`);
        } else {
          labels.push(outcome.label);
          history.push(outcome.note ? `${outcome.label}: ${outcome.note}` : outcome.label);
          done.push(outcome.done);
        }
        pending = { at: history.length - 1, turn };
        const stop = await stopNow();
        if (stop) {
          end = stop;
          break;
        }
      }
    }

    const healed = healFrom && end?.verdict === "passed" ? { from: healFrom.map((a) => labelOf(a, mask)), to: done.slice(healStart).map((a) => labelOf(a, mask)) } : undefined;
    const replayed = Boolean(entry?.actions) && !healFrom && calls === 0;
    if (end?.verdict === "passed" && !replayed) fresh = true;
    learned.push({ kind: "act", words: intent, ...(check ? { check } : {}), actions: done });
    return finishStep({
      n, kind: "act", title: mask(intent), ...end!, ...(check ? { check: maskedCheck(check, mask) } : {}),
      actions: labels.map((l) => mask(l)), ...(replayed ? { replayed: true as const } : {}), ...(healed ? { healed } : {}),
      aiCalls: calls, ms: Date.now() - t0,
    }, o);
  }

  async function assertStep(what: Check | string, o: StepOptions = {}): Promise<AgentStep> {
    const title = typeof what === "string" ? what : `Check that ${expected(what)}`;
    if (stoppedEarly()) return skipped("assert", title, o);
    if (typeof what !== "string" && !checkFrom(what)) throw new TypeError(`agent.assert: ${JSON.stringify(what)} isn't a check the browser can measure`);
    return contained("assert", title, o, () => assertBody(what, title, o));
  }

  async function assertBody(what: Check | string, title: string, o: StepOptions): Promise<AgentStep> {
    const n = steps.length + 1;
    const t0 = Date.now();
    let calls = 0;
    let check: Check | undefined;
    let derived = false;
    let end: End | undefined;
    if (typeof what !== "string") {
      check = checkFrom(what);
      if (!check) throw new TypeError(`agent.assert: ${JSON.stringify(what)} isn't a check the browser can measure`);
    } else {
      // Words: the check they mean, from the cache, or from the AI once. Only ever a check: the browser measures it.
      derived = true;
      const entry = saved.get(nextKey("assert", what));
      check = entry?.check;
      if (!check) {
        if (!brain?.check) end = { verdict: "not_sure", reason: brain ? "the brain can't turn words into a check (it has no check()): pass a check instead" : "this assert isn't in the cache and there's no AI to turn its words into a check" };
        else {
          try {
            calls++;
            aiCalls++;
            const snap = await observe(page, mask, undefined, SNAPSHOT_CHARS, { onSite: sameSite });
            check = checkFrom(await brain.check(mask(what), { url: snap.url, title: snap.title, snapshot: snapText(snap) }));
            if (!check) end = { verdict: "not_sure", reason: "the AI's answer wasn't a check the browser can measure" };
            else fresh = true;
          } catch (error) {
            end = { verdict: "not_sure", reason: `the AI didn't answer: ${mask(firstLine(error))}` };
          }
        }
      }
    }
    if (!end && check?.kind === "none") end = { verdict: "not_sure", reason: "there's nothing to measure in this check" };
    if (!end && check) {
      end = await stopNow();
      if (!end) {
        const v = await verify(page, withValues(check, lookup), checkWaitMs);
        end = v.ok ? { verdict: "passed" } : failedEnd(v);
      }
    }
    if (typeof what === "string") learned.push({ kind: "assert", words: what, ...(check ? { check } : {}) });
    return finishStep({ n, kind: "assert", title: mask(title), ...end!, ...(check ? { check: maskedCheck(check, mask) } : {}), ...(derived && check ? { derived: true as const } : {}), actions: [], aiCalls: calls, ms: Date.now() - t0 }, o);
  }

  async function codeStep(title: string, fn: (page: Page) => Promise<unknown>, o: StepOptions = {}): Promise<AgentStep> {
    if (stoppedEarly()) return skipped("code", title, o);
    return contained("code", title, o, () => codeBody(title, fn, o));
  }

  async function codeBody(title: string, fn: (page: Page) => Promise<unknown>, o: StepOptions): Promise<AgentStep> {
    const n = steps.length + 1;
    const t0 = Date.now();
    let end: End;
    try {
      await fn(page);
      end = (await stopNow()) ?? { verdict: "passed" };
    } catch (error) {
      // An address the guard stopped shows in Playwright as a failed navigation: it is the stop, BLOCKED.
      const off = offSite();
      end = off ? { verdict: "blocked", reason: mask(off) } : { verdict: "failed", reason: mask(firstLine(error)) };
    }
    return finishStep({ n, kind: "code", title: mask(title), ...end, actions: [], aiCalls: 0, ms: Date.now() - t0 }, o);
  }

  async function finish(): Promise<AgentReport> {
    const first = steps.find((s) => s.verdict !== "passed");
    // No step at all tested nothing: never a pass.
    const verdict: TestVerdict = !steps.length ? "not_sure" : !first ? "pass" : first.verdict === "failed" ? "fail" : first.verdict === "blocked" ? "blocked" : "not_sure";
    // A replay is about what the AI would have done: acts and worded asserts. Asserts of a check never ask it.
    const agentSteps = steps.filter((s) => s.kind === "act" || s.derived);
    const replay = agentSteps.length > 0 && steps.every((s) => s.verdict !== "skipped") && agentSteps.every((s) => s.replayed || (s.derived && s.aiCalls === 0));
    let cacheWritten: string | undefined;
    // Saved only from a pass, and only when something new was learned: a replay leaves the file as it was.
    if (verdict === "pass" && options.cache && options.updateCache !== false && (fresh || learned.length !== saved.size)) {
      const file: CacheFile = { version: CACHE_VERSION, rules: RULES, site: new URL(start).host, steps: learned };
      // Handles, never values: a value that got in anyway (an address with it) is masked to its {name}.
      const text = mask(withoutSecretsDeep(JSON.stringify(file, null, 2)));
      mkdirSync(dirname(options.cache), { recursive: true });
      const tmp = `${options.cache}.tmp`;
      writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
      renameSync(tmp, options.cache);
      cacheWritten = options.cache;
    }
    return { verdict, steps: [...steps], aiCalls, replay, ...(cacheWritten ? { cacheWritten } : {}) };
  }

  return { page, act: actStep, assert: assertStep, step: codeStep, finish };
}

/** Saved addresses lose their secret-looking query values (a token in a link), as the engine's own cache does. */
function withoutSecretsDeep(json: string): string {
  return json.replace(/"(url|href)": "(https?:[^"]*)"/g, (_all, k: string, u: string) => `"${k}": ${JSON.stringify(withoutSecrets(u))}`);
}
