/**
 * The tester's benchmark (tonight-plan.md section 2): a dozen local fixture tasks and six public-site
 * tasks, each run fresh with the AI, then saved and replayed, and scored against a right answer the
 * bench measures itself (the page the run ended on, the fixture server's request log), never an AI.
 *
 *   env -u ANTHROPIC_API_KEY node cli/bench/bench.ts --ai claude-code [--set fixture|real|all|app|pay] [--only id,id] [--label before] [--repeat 2] [--parallel 4]
 *   node cli/bench/bench.ts --ai none --set app     (no AI: the harness, the sites and the measured parts only)
 *   node cli/bench/bench.ts --compare before after
 *   node cli/bench/bench.ts --merge before-fx-1 before-fx-2 before-real --label before
 *   env -u ANTHROPIC_API_KEY node cli/bench/bench.ts --ai claude-code --set zoo --repeat 3 --replay off [--seed N]
 *
 * In-process, through the engine's own entry points (runTest, aiBrain, timedAi, writeSaved/readSaved),
 * so it runs on any version of the engine with no change to it. Runs land in $TMPDIR/cm-bench-<label>/,
 * never the repo; the numbers in cli/bench/results/<label>.json, with no snapshots or prompts.
 * Not in npm test: it needs a real AI and, for the real set, the web.
 *
 * --parallel N runs N tasks at once, each worker with its own browser and its own practice sites, so
 * no request log, variant or ledger is shared. Real-site tasks still run one at a time. Timings are
 * less steady than at 1 (the machine is shared), so the table says so and --compare warns when the
 * two runs differ in it. --set app is the app build's practice sites (app/sites), --set pay the
 * pay practice checkouts (bench/pay); both are run by app-bench.ts.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, Page } from "playwright";
import { readSaved, withoutSecrets, writeSaved } from "../../packages/scanner/src/tester/cache.ts";
import { launch } from "../../packages/scanner/src/tester/record.ts";
import { masker, runTest, type RunOptions, type RunOutcome } from "../../packages/scanner/src/tester/run.ts";
import { CouldNotRun, type TestResult, type TesterBrain } from "../../packages/scanner/src/tester/types.ts";
import type { A11yKind } from "../../packages/scanner/src/tester/a11y.ts";
import { aiTotals, pickAi, timedAi, type Ai, type AskTiming } from "../ai.ts";
import { colors } from "../term.ts";
import { ACT_SYSTEM, aiBrain, writeRun } from "../test-command.ts";
import { runFromUrl, suggestedPathFor } from "../test-tasks.ts";
import { startFixtureSite, type FixtureSite } from "./site.ts";
import { ANY_SITE_SETS, JUDGE_TASKS, TASKS, testSetOf, type BenchTask, type Oracle, type TestSet } from "./tasks.ts";
import { formatZooGrid, needsZoo, runZooTask, ZOO_SET, zooTasks } from "./zoo/bench.ts";
import { startZoo, type ZooServer } from "./zoo/server.ts";
import type { Twin } from "./zoo/kit.ts";
import { JUDGE_SYSTEM } from "../../packages/scanner/src/tester/judge.ts";
import { AUTH_TASKS, authTotals, formatAuthTable, runAuthTask, type AuthRow } from "./auth-bench.ts";
import { APP_SET, PAY_SET, noAiBrain, runAppTask, runPayTask } from "./app-bench.ts";
import { startAppSites, type AppSites } from "../app/sites/index.ts";
import { startPaySites, type PaySites } from "./pay/sites.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
export const RESULTS_DIR = join(HERE, "results");
/** The first words of the actor's system prompt: how a decision is told from a plan in the AI's asks. */
const DECIDE = ACT_SYSTEM.slice(0, 48);
/** The first words of the judge's system prompt: a judge's ask, counted apart from the actor's and the planner's. */
const JUDGE = JUDGE_SYSTEM.slice(0, 48);
/** Every task, the judge set's too: --only finds any of them. */
export const ALL_TASKS: readonly BenchTask[] = [...TASKS, ...JUDGE_TASKS];
/** A task on a public site (its address is whole), not the fixture site. */
export const onWeb = (t: Pick<BenchTask, "url">) => /^https?:\/\//.test(t.url);
const mask = masker({});
const clipped = (s: string, n = 200) => mask(s.replace(/\s+/g, " ").trim()).slice(0, n);

// ---------------------------------------------------------------------------------------------
// The answer sampler: where the run's page is, independent of what the engine says about itself.

export interface EndState {
  url: string;
  title: string;
  /** For each of the oracle's visibleText words: whether it showed. */
  visible: Record<string, boolean>;
}

/** Samples the recorded page every 500 ms and after each main-frame navigation; the last sample before it closes is the end state. */
export class Sampler {
  last?: EndState;
  private texts: string[];
  constructor(texts: string[] = []) {
    this.texts = texts;
  }
  attach(page: Page): void {
    let busy = false;
    const sample = async () => {
      if (busy || page.isClosed()) return;
      busy = true;
      try {
        const url = page.url();
        const title = await page.title();
        const visible: Record<string, boolean> = {};
        // What a person sees: the page, and a frame on screen in it (a provider's overlay), as check.ts reads it.
        const frames = [];
        for (const f of page.frames()) {
          if (f === page.mainFrame() || frames.length >= 8) continue;
          const box = await f.frameElement().then((e) => e.boundingBox()).catch(() => null);
          if (box && box.width >= 40 && box.height >= 40) frames.push(f);
        }
        for (const t of this.texts) {
          visible[t] = await page.getByText(t).filter({ visible: true }).count().then((n) => n > 0, () => false);
          for (const f of frames) if (!visible[t]) visible[t] = await f.getByText(t).filter({ visible: true }).count().then((n) => n > 0, () => false);
        }
        if (!page.isClosed() && page.url() === url) this.last = { url: withoutSecrets(url), title: mask(title), visible };
      } catch {
        // the page went away mid-sample: the last whole sample stands
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void sample(), 500);
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) void sample();
    });
    page.on("load", () => void sample());
    page.on("close", () => clearInterval(timer));
    void sample();
  }
}

// ---------------------------------------------------------------------------------------------
// Scoring: all measured.

const stripHash = (u: string) => u.replace(/#.*$/, "");
const hitOf = (hits: readonly string[], want: string) => hits.some((h) => h === want || h.startsWith(want));

/** Whether the oracle holds for a run's end state and its slice of the server log; what didn't, in words. */
export function judgeOracle(o: Oracle, end: EndState | undefined, hits: readonly string[]): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  const url = end ? stripHash(end.url) : "";
  const urlOk = o.urlMatches ? Boolean(end) && o.urlMatches.test(url) : undefined;
  const titleOk = o.titleMatches ? Boolean(end) && o.titleMatches.test(end!.title) : undefined;
  if (o.urlOrTitle) {
    if (!urlOk && !titleOk) failed.push(`neither the end address nor its title matched (${clipped(url, 120)} · "${clipped(end?.title ?? "", 60)}")`);
  } else {
    if (urlOk === false) failed.push(`the end address didn't match ${o.urlMatches} (${clipped(url, 120)})`);
    if (titleOk === false) failed.push(`the end title didn't match ${o.titleMatches} ("${clipped(end?.title ?? "", 60)}")`);
  }
  for (const t of o.visibleText ?? []) if (!end?.visible[t]) failed.push(`"${t}" didn't show at the end`);
  for (const want of [...(o.hit ? [o.hit] : []), ...(o.hits ?? [])]) if (!hitOf(hits, want)) failed.push(`the site never saw ${want}`);
  for (const bad of o.noHit ?? []) if (hitOf(hits, bad)) failed.push(`the site saw ${bad}`);
  return { ok: failed.length === 0, failed };
}

export type Verdict = TestResult["verdict"] | "could_not" | "error" | "skipped" | "suggested" | "explored";

/**
 * Right, and a false pass: a PASS whose right answer fails, or on a task that shouldn't pass. A pass
 * with judged steps on a task where a measured check fits (`judged: "forbidden"`), or without any
 * where only a judged one can tell (`"required"`), isn't right either.
 */
export function score(task: Pick<BenchTask, "expect" | "suggest" | "judged">, verdict: Verdict, oracleOk: boolean, judgedSteps = 0): { right: boolean; falsePass: boolean } {
  if (task.suggest) return { right: verdict === "suggested" && oracleOk, falsePass: false };
  const judgedOk = task.judged === "forbidden" ? judgedSteps === 0 : task.judged === "required" ? judgedSteps > 0 : true;
  const right = task.expect === "pass" ? verdict === "pass" && oracleOk && (verdict !== "pass" || judgedOk) : task.expect === "blocked" ? verdict === "blocked" && oracleOk : verdict !== "pass" && verdict !== "skipped" && verdict !== "error" && oracleOk;
  const falsePass = verdict === "pass" && !(task.expect === "pass" && oracleOk);
  return { right, falsePass };
}

export interface ReplayRow {
  verdict: Verdict;
  /** The actor's and planner's asks (a judge's are in judgeAsks): 0 on a clean replay. */
  asks: number;
  /** The judge's asks: a saved judged step asks again on every replay, and says so here. */
  judgeAsks?: number;
  tokens: number;
  seconds: number;
  /** Every step came from the saved test. */
  allReplayed: boolean;
  /** PASS, no AI asked, every step replayed. */
  hit: boolean;
  /** The replay passed, but the server saw a wrong address (a noHit): a silent wrong-element replay. */
  wrong: boolean;
  oracleOk: boolean;
}

/** A replay hit: PASS, no AI asked, every step replayed. */
export const replayHit = (r: Pick<ReplayRow, "verdict" | "asks" | "allReplayed">) => r.verdict === "pass" && r.asks === 0 && r.allReplayed;

export interface TaskRow {
  id: string;
  set: BenchTask["set"];
  /** A task of --set app (app/sites), --set pay (bench/pay) or --set zoo (bench/zoo). */
  suite?: "app" | "pay" | "zoo";
  /** The test set (plan 9b): D, H1, H2, SI, R, fx, jd. SI never counts toward "any site". */
  testSet?: TestSet;
  /** A zoo task's twin, and its page (the widget class). */
  twin?: Twin;
  widget?: string;
  /** The goal was really done, whatever the twin expects (measured): what a judge should agree with. */
  truth?: boolean;
  /** Records the run made, and how many are still there at the end (cleanup rate). */
  cleanup?: { created: number; left: number };
  /** Effects the floor forbids that happened anyway (an order, a change to data the run didn't make). */
  forbidden?: string[];
  rep: number;
  /** The label of the run it came from, in a merged file. */
  source?: string;
  expect: BenchTask["expect"];
  verdict: Verdict;
  /** "access": the site asked for an owner's login or token the run didn't have (app set). */
  blockedBy?: "safety" | "bot check" | "access" | "setup";
  right: boolean;
  falsePass: boolean;
  /** Judges that had no input from this engine (app set): the row is then never counted right. */
  notJudged?: string[];
  /** The right answer was reached (the oracle holds), whatever the tester said: a FAIL here is a false fail. */
  reached?: boolean;
  oracle: { ok: boolean; failed: string[] };
  asks: number;
  tokens: number;
  seconds: number;
  actions: number;
  steps: number;
  passedSteps: number;
  weakSteps: number;
  /** Why each step that didn't pass ended (the engine's words, masked, clipped). */
  reasons: string[];
  decisions: number;
  /** The actor's input tokens per decision (fresh, cache read, cache written), when the AI said. */
  decisionTokens: number[];
  /** The actor's question size per decision, in characters (system + question). */
  decisionChars: number[];
  /** History lines or errors holding a raw Playwright timeout ("Timeout 8000ms exceeded"). */
  rawTimeouts: number;
  /** Steps that ended "8 actions weren't enough"-style, on the step budget. */
  budgetEnds: number;
  /** Steps ended by a loop guard ("the same thing three times on an unchanged page", or a later guard). */
  loopEnds: number;
  end?: EndState;
  /** The engine's own end address (P0-12), when it says one: whether it agrees with the sampler. */
  endUrlAgrees?: boolean;
  hits: number;
  /** Passed steps an AI judged (0 when none). */
  judgedSteps?: number;
  /** The judge's asks in the fresh run (also counted in asks). */
  judgeAsks?: number;
  /** Pictures sent to the AI in the fresh run. */
  pictures?: number;
  /** A pass with judged steps: its report.html says "Judged by AI" (false: a pass shown as measured). */
  labelled?: boolean;
  /** The fresh run's accessibility scan: pages, issues counted by kind, each page's scan time, and whether the task's expected counts held. */
  a11y?: A11yRow;
  replay?: ReplayRow;
  changed?: ReplayRow;
  note?: string;
  runDir?: string;
}

export interface Meta {
  head: string;
  diff: string;
  at: string;
  node: string;
  playwright: string;
  ai?: string;
  sources?: { label: string; head: string; diff: string; at: string }[];
  /** Tasks run at once (--parallel), when more than 1: timings are then less steady. */
  parallel?: number;
  /** Wall-clock seconds for the whole run, start to end. */
  wallSeconds?: number;
}

export interface Totals {
  tasks: number;
  runs: number;
  pass: number;
  fail: number;
  blocked: number;
  blockedSafety: number;
  blockedBotCheck: number;
  notSure: number;
  couldNot: number;
  skipped: number;
  right: number;
  falsePasses: number;
  /** The right answer was reached, but the tester didn't say PASS. */
  falseFails: number;
  asks: number;
  replayAsks: number;
  tokens: number;
  tokensPerPass: number | null;
  medianDecisionTokens: number | null;
  medianDecisionChars: number | null;
  /** The median time one page's accessibility scan took, across every fresh run (the bar is 300 ms). */
  a11yMedianMs?: number | null;
  medianSeconds: number | null;
  seconds: number;
  actions: number;
  replays: number;
  replayHits: number;
  replayHitRate: number | null;
  changedReplays: number;
  changedWrong: number;
  rawTimeouts: number;
  budgetEnds: number;
  loopEnds: number;
  weakSteps: number;
  /** Passes with a judged step, and those whose report didn't say so (must be 0). */
  judgedPasses?: number;
  unlabelled?: number;
  judgeAsks?: number;
  pictures?: number;
}

export interface Spread {
  between: [string, string];
  ids: number;
  /** Share of shared tasks whose verdict was the same both times. */
  verdictAgreement: number;
  /** |a - b| / mean, over the shared tasks' sums. */
  tokens: number | null;
  seconds: number | null;
  actions: number | null;
  passes: [number, number];
  right: [number, number];
  /** The median of each task's own |a - b| / mean, for tokens and seconds. */
  medianTaskTokens: number | null;
  medianTaskSeconds: number | null;
}

export interface BenchResult {
  label: string;
  meta: Meta;
  tasks: TaskRow[];
  totals: Totals;
  spread?: Spread[];
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The totals, with each task weighed once: a task run twice (--repeat, or two merged runs) counts as
 * the mean of its runs, so a total is comparable whatever the repeats. Counts may then be fractional.
 */
export function totalsOf(rows: readonly TaskRow[]): Totals {
  const byId = new Map<string, TaskRow[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const per = (f: (r: TaskRow) => number) => round([...byId.values()].reduce((n, rs) => n + mean(rs.map(f)), 0));
  const is = (f: (r: TaskRow) => boolean) => per((r) => (f(r) ? 1 : 0));
  const pass = is((r) => r.verdict === "pass");
  const tokens = per((r) => r.tokens + (r.replay?.tokens ?? 0) + (r.changed?.tokens ?? 0));
  const replays = rows.filter((r) => r.replay);
  const changed = rows.filter((r) => r.changed);
  const replayHits = replays.filter((r) => r.replay!.hit).length;
  const secondsById = [...byId.values()].map((rs) => mean(rs.filter((r) => r.verdict !== "skipped").map((r) => r.seconds))).filter((s) => s > 0);
  return {
    tasks: byId.size,
    runs: rows.length,
    pass,
    fail: is((r) => r.verdict === "fail"),
    blocked: is((r) => r.verdict === "blocked"),
    blockedSafety: is((r) => r.verdict === "blocked" && r.blockedBy === "safety"),
    blockedBotCheck: is((r) => r.verdict === "blocked" && r.blockedBy === "bot check"),
    notSure: is((r) => r.verdict === "not_sure"),
    couldNot: is((r) => r.verdict === "could_not" || r.verdict === "error"),
    skipped: is((r) => r.verdict === "skipped"),
    right: is((r) => r.right),
    falsePasses: is((r) => r.falsePass),
    falseFails: is((r) => Boolean(r.reached) && r.verdict !== "pass"),
    asks: per((r) => r.asks),
    replayAsks: per((r) => (r.replay?.asks ?? 0) + (r.changed?.asks ?? 0)),
    tokens,
    tokensPerPass: pass ? round(tokens / pass, 0) : null,
    medianDecisionTokens: median(rows.flatMap((r) => r.decisionTokens)),
    medianDecisionChars: median(rows.flatMap((r) => r.decisionChars)),
    medianSeconds: secondsById.length ? round(median(secondsById)!, 1) : null,
    seconds: per((r) => r.seconds + (r.replay?.seconds ?? 0) + (r.changed?.seconds ?? 0)),
    actions: per((r) => r.actions),
    replays: replays.length,
    replayHits,
    replayHitRate: replays.length ? round(replayHits / replays.length, 3) : null,
    changedReplays: changed.length,
    changedWrong: changed.filter((r) => r.changed!.wrong).length,
    rawTimeouts: per((r) => r.rawTimeouts),
    budgetEnds: per((r) => r.budgetEnds),
    loopEnds: per((r) => r.loopEnds ?? 0),
    weakSteps: per((r) => r.weakSteps),
    judgedPasses: is((r) => r.verdict === "pass" && (r.judgedSteps ?? 0) > 0),
    unlabelled: rows.filter((r) => r.verdict === "pass" && (r.judgedSteps ?? 0) > 0 && r.labelled !== true).length,
    judgeAsks: per((r) => (r.judgeAsks ?? 0) + (r.replay?.judgeAsks ?? 0) + (r.changed?.judgeAsks ?? 0)),
    pictures: per((r) => r.pictures ?? 0),
    a11yMedianMs: median(rows.flatMap((r) => r.a11y?.ms ?? [])),
  };
}

// ---------------------------------------------------------------------------------------------
// The measuring stick's metrics (any-site plan 9c): per test set, per twin and per widget class.

export interface Metrics {
  /** Runs (every repeat counts), and distinct tasks. */
  n: number;
  tasks: number;
  right: number;
  falsePasses: number;
  /**
   * The most the true false-pass rate can be at 95% confidence, from what was seen: about 3/n when
   * none was seen (the rule of three), more when some were.
   */
  falsePassBound: number;
  /** BLOCKED on a run that should pass (a trap or a task twin): the tester stopped something harmless. */
  overBlocks: number;
  /** BLOCKED on a run that should stop (the needs-owner twin, a safety task). */
  rightBlocks: number;
  /** Runs that should stop, of n (rightBlocks counts against these). */
  shouldBlock: number;
  notSure: number;
  /** Of the runs that made records, the share that left none behind (null when none made any). */
  cleanupRate: number | null;
  cleanupRuns: number;
  /** Tasks right on every repeat, of the tasks. */
  allRepeats: number;
  /** Runs where an AI judge was asked and the truth is known: how often "pass" matched the truth. */
  judgeAgreement: number | null;
  judgedRuns: number;
  /** Runs where something the floor forbids happened (an order, a change to data the run didn't make). */
  forbidden: number;
  asksPerRun: number;
  medianSeconds: number | null;
}

/** The upper 95% bound on a rate from k events in n runs: 3/n at k = 0, a Wilson upper bound above it. */
export function rateBound(k: number, n: number): number {
  if (n <= 0) return 1;
  if (k === 0) return Math.min(1, 3 / n);
  const z = 1.96;
  const p = k / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + spread) / (1 + (z * z) / n));
}

export function metricsOf(rows: readonly TaskRow[]): Metrics {
  const ran = rows.filter((r) => r.verdict !== "skipped");
  const n = ran.length;
  const byId = new Map<string, TaskRow[]>();
  for (const r of ran) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const fp = ran.filter((r) => r.falsePass).length;
  const made = ran.filter((r) => (r.cleanup?.created ?? 0) > 0);
  const judged = ran.filter((r) => ((r.judgedSteps ?? 0) > 0 || (r.judgeAsks ?? 0) > 0) && r.truth !== undefined);
  return {
    n,
    tasks: byId.size,
    right: ran.filter((r) => r.right).length,
    falsePasses: fp,
    falsePassBound: round(rateBound(fp, n), 3),
    overBlocks: ran.filter((r) => r.verdict === "blocked" && r.expect === "pass").length,
    rightBlocks: ran.filter((r) => r.verdict === "blocked" && r.expect === "blocked").length,
    shouldBlock: ran.filter((r) => r.expect === "blocked").length,
    notSure: ran.filter((r) => r.verdict === "not_sure").length,
    cleanupRate: made.length ? round(made.filter((r) => r.cleanup!.left === 0).length / made.length, 3) : null,
    cleanupRuns: made.length,
    allRepeats: [...byId.values()].filter((rs) => rs.every((r) => r.right)).length,
    judgeAgreement: judged.length ? round(judged.filter((r) => (r.verdict === "pass") === r.truth).length / judged.length, 3) : null,
    judgedRuns: judged.length,
    forbidden: ran.filter((r) => r.forbidden?.length).length,
    asksPerRun: n ? round(ran.reduce((a, r) => a + r.asks, 0) / n, 1) : 0,
    medianSeconds: median(ran.map((r) => r.seconds)),
  };
}

const METRIC_HEAD = ["group", "runs (n)", "tasks", "right", "false pass (95% bound)", "over-block", "right-block", "not sure", "cleanup", "right all repeats", "judge agrees", "forbidden", "asks/run", "median s"] as const;

function metricCells(name: string, m: Metrics): string[] {
  const pc = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  return [
    name, String(m.n), String(m.tasks), `${m.right}/${m.n}`,
    `${m.falsePasses} (≤ ~${(m.falsePassBound * 100).toFixed(1)}%)`,
    String(m.overBlocks), m.shouldBlock ? `${m.rightBlocks}/${m.shouldBlock}` : "-", String(m.notSure),
    m.cleanupRuns ? `${pc(m.cleanupRate)} of ${m.cleanupRuns}` : "-", `${m.allRepeats}/${m.tasks}`,
    m.judgedRuns ? `${pc(m.judgeAgreement)} of ${m.judgedRuns}` : "-", String(m.forbidden), num(m.asksPerRun, 1), num(m.medianSeconds, 1),
  ];
}

/**
 * The metrics table: every test set, the "any site" sets together (never D, SI, fx or jd), each
 * zoo twin and each zoo page. Each line says its n: "0 false passes" over n runs still allows a true
 * rate up to about 3/n.
 */
export function formatMetrics(rows: readonly TaskRow[]): string {
  const groups: [string, TaskRow[]][] = [];
  const sets = [...new Set(rows.map((r) => r.testSet ?? "other"))];
  for (const s of sets) groups.push([`set ${s}${s === "SI" ? " (never any-site)" : ""}`, rows.filter((r) => (r.testSet ?? "other") === s)]);
  const anySite = rows.filter((r) => r.testSet && ANY_SITE_SETS.includes(r.testSet));
  groups.push(["any site (H1+H2+R)", anySite]);
  const zoo = rows.filter((r) => r.twin);
  for (const t of ["task", "broken", "trap", "needs_owner"] as const) if (zoo.some((r) => r.twin === t)) groups.push([`twin ${t}`, zoo.filter((r) => r.twin === t)]);
  for (const w of [...new Set(zoo.map((r) => r.widget ?? "?"))]) groups.push([`page ${w}`, zoo.filter((r) => r.widget === w)]);
  const body = groups.map(([g, rs]) => metricCells(g, metricsOf(rs)));
  const widths = METRIC_HEAD.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (c: readonly string[]) => c.map((x, i) => pad(x, widths[i]!)).join("  ").trimEnd();
  return [
    "metrics (plan 9c): n is runs, every repeat counted; 0 false passes over n runs still allows a true rate up to about 3/n (95%)",
    line(METRIC_HEAD),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// The table.

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(d || 1));
const shortVerdict = (r: TaskRow) => (r.verdict === "blocked" ? `blocked (${r.blockedBy ?? "?"})` : r.verdict);
const replayCell = (r?: ReplayRow) => (!r ? "-" : `${r.hit ? "hit" : `miss:${r.verdict}`} / ${r.asks}${r.judgeAsks ? `+${r.judgeAsks}j` : ""} / ${r.wrong ? "WRONG" : "ok"}`);
const judgedCell = (r: TaskRow) => (r.judgedSteps ? `${r.judgedSteps} judged${r.labelled === false ? " UNLABELLED" : ""}` : r.judgeAsks ? `${r.judgeAsks} ask${r.judgeAsks === 1 ? "" : "s"}` : "");

/** Runs BLOCKED because the site asked for an owner's login or token (app set). */
const accessBlocks = (rows: readonly TaskRow[]) => rows.filter((r) => r.verdict === "blocked" && r.blockedBy === "access").length;
/** Runs with a judge that had no input (app set). */
const partlyJudged = (rows: readonly TaskRow[]) => rows.filter((r) => r.notJudged?.length).length;

export const TABLE_COLUMNS = ["task", "verdict", "right?", "false pass", "judged", "asks", "tokens", "s", "actions", "replay (hit / asks / wrong)", "changed (hit / asks / wrong)"] as const;

export function formatTable(result: Pick<BenchResult, "label" | "tasks" | "totals" | "meta" | "spread">): string {
  const rows = result.tasks.map((r) => [
    `${r.id}${r.source ? ` [${r.source}]` : r.rep > 1 ? `#${r.rep}` : ""}`,
    shortVerdict(r),
    r.right ? "yes" : "NO",
    r.falsePass ? "FALSE PASS" : r.reached && r.verdict !== "pass" ? "(reached)" : "",
    judgedCell(r),
    String(r.asks),
    String(r.tokens),
    r.seconds.toFixed(1),
    String(r.actions),
    replayCell(r.replay),
    replayCell(r.changed),
  ]);
  const widths = TABLE_COLUMNS.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();
  const t = result.totals;
  const out = [
    `bench ${result.label} · head ${result.meta.head.slice(0, 7)} · diff ${result.meta.diff.slice(0, 7)} · ${result.meta.at}${result.meta.ai ? ` · AI ${result.meta.ai}` : ""}`,
    ...(result.meta.wallSeconds !== undefined ? [`wall time ${num(result.meta.wallSeconds, 1)} s · parallel ${result.meta.parallel ?? 1}`] : []),
    ...((result.meta.parallel ?? 1) > 1 ? [PARALLEL_NOTE] : []),
    "",
    line(TABLE_COLUMNS),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    `totals (${t.tasks} tasks, ${t.runs} runs; a task run more than once counts as its mean)`,
    `  pass ${num(t.pass)} · fail ${num(t.fail)} · blocked ${num(t.blocked)} (safety ${num(t.blockedSafety)}, bot check ${num(t.blockedBotCheck)}${accessBlocks(result.tasks) ? `, access ${accessBlocks(result.tasks)}` : ""}) · not sure ${num(t.notSure)} · couldn't run ${num(t.couldNot)} · skipped ${num(t.skipped)}`,
    `  right ${num(t.right)} of ${t.tasks}${partlyJudged(result.tasks) ? ` (${partlyJudged(result.tasks)} judged in part, not counted right)` : ""} · false passes ${num(t.falsePasses)} · reached the answer but not passed ${num(t.falseFails ?? 0)}`,
    `  asks ${num(t.asks)} fresh + ${num(t.replayAsks)} on replay · tokens ${num(t.tokens)} · tokens per passed task ${num(t.tokensPerPass)}`,
    `  median tokens per decision ${num(t.medianDecisionTokens)} · median characters per decision ${num(t.medianDecisionChars)}`,
    `  median seconds ${num(t.medianSeconds)} · seconds in all ${num(t.seconds)} · actions ${num(t.actions)}`,
    `  replay hit rate ${t.replayHitRate === null ? "-" : `${Math.round(t.replayHitRate * 100)}%`} (${t.replayHits}/${t.replays}) · changed: ${t.changedWrong} silent wrong of ${t.changedReplays}`,
    `  raw timeouts in history ${num(t.rawTimeouts)} · steps ended on the action budget ${num(t.budgetEnds)} · by a loop guard ${num(t.loopEnds)} · weak steps ${num(t.weakSteps)}`,
    ...(t.judgedPasses || t.judgeAsks || t.pictures ? [`  judged passes ${num(t.judgedPasses ?? 0)} (unlabelled ${t.unlabelled ?? 0}) · judge asks ${num(t.judgeAsks ?? 0)} · pictures sent ${num(t.pictures ?? 0)}`] : []),
  ];
  for (const s of result.spread ?? []) out.push(spreadLine(s));
  if (result.tasks.some((r) => r.testSet || r.twin)) out.push("", formatMetrics(result.tasks).trimEnd());
  const grid = formatZooGrid(result.tasks);
  if (grid) out.push("", "zoo: each page under its four twins, every repeat (x = a wrong verdict, !FP = a false pass, (right/runs))", grid.trimEnd());
  const notes = result.tasks.filter((r) => r.note || !r.oracle.ok || r.reasons.length);
  if (notes.length) {
    out.push("", "notes");
    for (const r of notes) {
      const bits = [...(r.note ? [r.note] : []), ...(!r.oracle.ok ? [`answer: ${r.oracle.failed.join("; ")}`] : []), ...r.reasons.map((x) => `step: ${x}`)];
      out.push(`  ${r.id}${r.source ? ` [${r.source}]` : r.rep > 1 ? `#${r.rep}` : ""}: ${bits.join(" | ").slice(0, 600)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/**
 * A row of an --ai none run whose verdict needed a decision: the harness gave up, the tester never
 * tried. It is never right (a "fail" there says nothing about a task that must not pass) and never a pass.
 */
export function noAiRow(r: TaskRow): Pick<TaskRow, "right" | "reached" | "note"> {
  return { right: false, reached: false, note: ["no AI: this verdict is the harness giving up, not the tester", r.note].filter(Boolean).join("; ") };
}

/** Said with every table and compare of a run at --parallel above 1. */
export const PARALLEL_NOTE = "note: tasks ran in parallel, so per-task seconds are less steady than at --parallel 1 (compare seconds only between runs at the same --parallel)";

const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
const spreadLine = (s: Spread) =>
  `  noise ${s.between[0]} vs ${s.between[1]} (${s.ids} tasks): verdicts agree ${pct(s.verdictAgreement)} · tokens ±${pct(s.tokens)} · seconds ±${pct(s.seconds)} · actions ±${pct(s.actions)} · passes ${s.passes[0]} vs ${s.passes[1]} · right ${s.right[0]} vs ${s.right[1]} · per-task median ±tokens ${pct(s.medianTaskTokens)}, ±seconds ${pct(s.medianTaskSeconds)}`;

const rel = (a: number, b: number) => (a + b === 0 ? 0 : Math.abs(a - b) / ((a + b) / 2));

/** How much two runs of the same tasks differ: the noise floor. */
export function spreadOf(a: BenchResult, b: BenchResult): Spread {
  const ids = a.tasks.map((r) => r.id).filter((id) => b.tasks.some((r) => r.id === id));
  const pick = (res: BenchResult, id: string) => res.tasks.filter((r) => r.id === id);
  const sum = (res: BenchResult, f: (r: TaskRow) => number) => ids.reduce((n, id) => n + mean(pick(res, id).map(f)), 0);
  const tok = (r: TaskRow) => r.tokens;
  const sec = (r: TaskRow) => r.seconds;
  const agree = ids.filter((id) => pick(a, id)[0]?.verdict === pick(b, id)[0]?.verdict).length;
  const has = ids.length > 0;
  return {
    between: [a.label, b.label],
    ids: ids.length,
    verdictAgreement: has ? round(agree / ids.length, 3) : 0,
    tokens: has ? round(rel(sum(a, tok), sum(b, tok)), 3) : null,
    seconds: has ? round(rel(sum(a, sec), sum(b, sec)), 3) : null,
    actions: has ? round(rel(sum(a, (r) => r.actions), sum(b, (r) => r.actions)), 3) : null,
    passes: [ids.filter((id) => pick(a, id)[0]?.verdict === "pass").length, ids.filter((id) => pick(b, id)[0]?.verdict === "pass").length],
    right: [ids.filter((id) => pick(a, id)[0]?.right).length, ids.filter((id) => pick(b, id)[0]?.right).length],
    medianTaskTokens: median(ids.map((id) => round(rel(mean(pick(a, id).map(tok)), mean(pick(b, id).map(tok))), 3))),
    medianTaskSeconds: median(ids.map((id) => round(rel(mean(pick(a, id).map(sec)), mean(pick(b, id).map(sec))), 3))),
  };
}

/** Several labelled runs as one file (BEFORE: two fixture runs and the real run), with the noise between runs of the same tasks. */
export function mergeResults(label: string, parts: readonly BenchResult[]): BenchResult {
  const tasks = parts.flatMap((p) => p.tasks.map((r) => ({ ...r, source: r.source ?? p.label })));
  const spread: Spread[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (parts[i]!.tasks.some((r) => parts[j]!.tasks.some((s) => s.id === r.id))) spread.push(spreadOf(parts[i]!, parts[j]!));
  const first = parts[0]?.meta;
  return {
    label,
    meta: { head: first?.head ?? "", diff: first?.diff ?? "", at: new Date().toISOString(), node: process.version, playwright: first?.playwright ?? "", ...(first?.ai ? { ai: first.ai } : {}), sources: parts.map((p) => ({ label: p.label, head: p.meta.head, diff: p.meta.diff, at: p.meta.at })) },
    tasks,
    totals: totalsOf(tasks),
    ...(spread.length ? { spread } : {}),
  };
}

/** BEFORE vs AFTER, per task and in total, with a delta column. No browser. */
export function formatCompare(before: BenchResult, after: BenchResult): string {
  const ids = [...new Set([...before.tasks.map((r) => r.id), ...after.tasks.map((r) => r.id)])];
  const of = (res: BenchResult, id: string) => res.tasks.filter((r) => r.id === id);
  const verdicts = (rs: TaskRow[]) => (rs.length ? [...new Set(rs.map(shortVerdict))].join(",") : "-");
  const m = (rs: TaskRow[], f: (r: TaskRow) => number) => (rs.length ? mean(rs.map(f)) : null);
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? "-" : `${b - a >= 0 ? "+" : ""}${num(round(b - a, 1), 1)}`);
  const head = ["task", "verdict before → after", "right", "tokens", "Δ", "s", "Δ", "actions", "Δ", "replay hit"];
  const rows = ids.map((id) => {
    const a = of(before, id);
    const b = of(after, id);
    const ra = m(a, (r) => (r.right ? 1 : 0));
    const rb = m(b, (r) => (r.right ? 1 : 0));
    const [ta, tb, sa, sb, aa, ab] = [m(a, (r) => r.tokens), m(b, (r) => r.tokens), m(a, (r) => r.seconds), m(b, (r) => r.seconds), m(a, (r) => r.actions), m(b, (r) => r.actions)];
    const hit = (rs: TaskRow[]) => (rs.some((r) => r.replay) ? `${rs.filter((r) => r.replay?.hit).length}/${rs.filter((r) => r.replay).length}` : "-");
    return [id, `${verdicts(a)} → ${verdicts(b)}`, `${num(ra === null ? null : round(ra, 2), 2)} → ${num(rb === null ? null : round(rb, 2), 2)}`, `${num(ta === null ? null : round(ta, 0))} → ${num(tb === null ? null : round(tb, 0))}`, delta(ta, tb), `${num(sa === null ? null : round(sa, 1), 1)} → ${num(sb === null ? null : round(sb, 1), 1)}`, delta(sa, sb), `${num(aa === null ? null : round(aa, 1), 1)} → ${num(ab === null ? null : round(ab, 1), 1)}`, delta(aa, ab), `${hit(a)} → ${hit(b)}`];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();
  const tb = before.totals;
  const ta = after.totals;
  const keys: (keyof Totals)[] = ["pass", "fail", "blocked", "blockedSafety", "blockedBotCheck", "notSure", "couldNot", "skipped", "right", "falsePasses", "falseFails", "asks", "replayAsks", "tokens", "tokensPerPass", "medianDecisionTokens", "medianDecisionChars", "medianSeconds", "seconds", "actions", "replayHitRate", "changedWrong", "rawTimeouts", "budgetEnds", "loopEnds", "weakSteps"];
  const tw = Math.max(...keys.map((k) => k.length));
  const out = [
    `compare ${before.label} (head ${before.meta.head.slice(0, 7)}, diff ${before.meta.diff.slice(0, 7)}) → ${after.label} (head ${after.meta.head.slice(0, 7)}, diff ${after.meta.diff.slice(0, 7)})`,
    "",
    line(head),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    "",
    "totals (each task weighed once)",
    ...keys.map((k) => {
      const a = tb[k] as number | null;
      const b = ta[k] as number | null;
      const d = a === null || b === null ? "-" : `${b - a >= 0 ? "+" : ""}${num(round(b - a, 3), 2)}${a ? ` (${b - a >= 0 ? "+" : ""}${Math.round(((b - a) / a) * 100)}%)` : ""}`;
      return `  ${pad(k, tw)}  ${pad(num(a, 2), 10)} → ${pad(num(b, 2), 10)}  ${d}`;
    }),
  ];
  const [pa, pb] = [before.meta.parallel ?? 1, after.meta.parallel ?? 1];
  if (pa !== pb) out.push(`  note: ${before.label} ran at --parallel ${pa} and ${after.label} at --parallel ${pb}: seconds are not comparable`);
  else if (pa > 1) out.push(`  ${PARALLEL_NOTE}`);
  for (const s of before.spread ?? []) out.push(spreadLine(s).replace("  noise", "  noise (before)"));
  for (const s of after.spread ?? []) out.push(spreadLine(s).replace("  noise", "  noise (after)"));
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------
// Running a task.

export interface BenchContext {
  browser: Browser;
  site?: FixtureSite;
  /** Where this task's runs go. */
  dir: string;
  /**
   * A brain that notes each ask it makes in `noted` (the AI's, through timedAi; a test's, scripted).
   * `use`: the names of the values the run may type, and whether it is a visitor's test (app and pay tasks).
   */
  brainFor(noted: AskTiming[], begun: number, use?: { vars: string[]; visitor: boolean }): TesterBrain;
  /** The app build's practice sites (--set app): this worker's own. */
  app?: AppSites;
  /** The pay practice checkouts (--set pay): this worker's own. */
  pay?: PaySites;
  /** The zoo (--set zoo): this worker's own. */
  zoo?: ZooServer;
  /** No replay after a pass: scoring uses fresh runs only (--replay off). */
  noReplay?: boolean;
  /** The AI as runFromUrl takes it, for a suggest task. */
  ai?: Ai;
  wallWaitMs?: number;
  /** How long a check waits for the page (offline tests make it short). */
  checkWaitMs?: number;
  minutes?: number;
  log?: (line: string) => void;
}

const sink = () => new Writable({ write: (_c, _e, done) => done() }) as unknown as NodeJS.WriteStream;

function addressOf(task: BenchTask, site?: FixtureSite): string {
  if (onWeb(task)) return task.url;
  if (!site) throw new Error(`${task.id} needs the fixture site`);
  return new URL(task.url, site.url).href;
}

function asksOf(noted: readonly AskTiming[]): { asks: number; tokens: number; decisions: AskTiming[]; judgeAsks: number } {
  const totals = aiTotals(noted);
  return { asks: noted.length, tokens: totals?.tokens ?? 0, decisions: noted.filter((a) => a.what === DECIDE), judgeAsks: noted.filter((a) => a.what === JUDGE).length };
}

/** Passed steps an AI judged. */
const judgedOf = (r?: TestResult) => (r ? r.steps.filter((s) => s.verdict === "passed" && s.judged).length : 0);

/** Whether a run's report.html labels its judged steps, read from the file the CLI writes. */
function labelledIn(dir: string): boolean {
  try {
    return readFileSync(join(dir, "report.html"), "utf8").includes("Judged by AI");
  } catch {
    return false;
  }
}

const RAW_TIMEOUT = /Timeout \d+ms exceeded/;

function factsOf(result: TestResult) {
  const lines = result.steps.flatMap((s) => [s.reason ?? "", ...s.actions.map((a) => `${a.label} ${a.error ?? ""}`)]);
  return {
    actions: result.actions,
    steps: result.steps.length,
    passedSteps: result.passed,
    weakSteps: result.steps.filter((s) => s.weak).length,
    reasons: result.steps.filter((s) => s.verdict !== "passed" && s.verdict !== "skipped" && s.reason).map((s) => clipped(`${s.n} ${s.verdict}: ${s.reason!}`)),
    rawTimeouts: lines.filter((l) => RAW_TIMEOUT.test(l)).length,
    budgetEnds: result.steps.filter((s) => /actions? (weren't|wasn't) enough|ran out of actions|action budget/i.test(s.reason ?? "")).length,
    loopEnds: result.steps.filter((s) => /same thing (three|3) times|loop|cycle|going round/i.test(s.reason ?? "")).length,
  };
}

/** Where a run goes and what it is given, when not the bench fixture site's visitor test (app and pay tasks). */
export interface RunEnv {
  url: string;
  /** The site's request log so far (path + query). */
  hits: () => string[];
  visitor?: boolean;
  /** More run options: vars, owner access, allowed hosts, and options a later engine reads (payments). */
  extra?: Partial<RunOptions> & Record<string, unknown>;
}

export interface OneRun {
  outcome?: RunOutcome;
  error?: string;
  couldNot?: boolean;
  noted: AskTiming[];
  seconds: number;
  hits: string[];
  end?: EndState;
}

export async function runOnce(task: BenchTask, ctx: BenchContext, dir: string, saved?: ReturnType<typeof readSaved>, env?: RunEnv): Promise<OneRun> {
  const noted: AskTiming[] = [];
  const begun = Date.now();
  const sampler = new Sampler(task.answer.visibleText ?? []);
  const hitsNow = env ? env.hits : () => ctx.site?.hits() ?? [];
  const from = hitsNow().length;
  const visitor = env?.visitor ?? true;
  mkdirSync(dir, { recursive: true });
  const run: OneRun = { noted, seconds: 0, hits: [] };
  try {
    run.outcome = await runTest({
      goal: task.goal,
      url: env?.url ?? addressOf(task, ctx.site),
      dir,
      browser: ctx.browser,
      ...(visitor ? { visitor: true } : {}),
      brain: env ? ctx.brainFor(noted, begun, { vars: Object.keys(env.extra?.vars ?? {}), visitor }) : ctx.brainFor(noted, begun),
      // The person's notes about the site, as a project's context.md gives them (notes.ts).
      ...(task.siteNotes ? { siteNotes: task.siteNotes } : {}),
      ...env?.extra,
      ...(saved ? { saved } : {}),
      ...(ctx.wallWaitMs !== undefined ? { wallWaitMs: ctx.wallWaitMs } : {}),
      ...(ctx.checkWaitMs !== undefined ? { checkWaitMs: ctx.checkWaitMs } : {}),
      ...(ctx.minutes !== undefined ? { minutes: ctx.minutes } : {}),
      onPage: (page) => sampler.attach(page),
    });
  } catch (error) {
    run.couldNot = error instanceof CouldNotRun;
    run.error = clipped(error instanceof Error ? error.message : String(error), 300);
  }
  run.seconds = round((Date.now() - begun) / 1000, 1);
  run.hits = hitsNow().slice(from);
  if (sampler.last) run.end = sampler.last;
  if (run.outcome) {
    const totals = aiTotals(noted);
    writeRun(dirname(dir), dir, run.outcome.result, { tokens: `${totals?.tokens ?? 0} tokens`, totals });
  }
  return run;
}

export interface A11yRow {
  pages: number;
  counts: Partial<Record<A11yKind, number>>;
  ms: number[];
  /** Only for a task that says its counts (BenchTask.a11y). */
  ok?: boolean;
  why?: string;
}

/** A run's scan as a bench row: always recorded (its time too), and checked against a task's expected counts. */
export function a11yRowOf(task: BenchTask, result: TestResult | undefined): A11yRow | undefined {
  const r = result?.accessibility;
  if (!r) return undefined;
  const counts: Partial<Record<A11yKind, number>> = {};
  for (const f of r.findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  for (const m of r.more ?? []) counts[m.kind] = (counts[m.kind] ?? 0) + m.n;
  const row: A11yRow = { pages: r.pages, counts, ms: r.ms ?? [] };
  if (!task.a11y) return row;
  const kinds = new Set([...Object.keys(task.a11y), ...Object.keys(counts)]) as Set<A11yKind>;
  const off = [...kinds].filter((k) => (task.a11y![k] ?? 0) !== (counts[k] ?? 0)).map((k) => `${k} ${counts[k] ?? 0} (expected ${task.a11y![k] ?? 0})`);
  return { ...row, ok: !off.length, ...(off.length ? { why: `the accessibility scan counted ${off.join(", ")}` } : {}) };
}

/** A task's oracle with its accessibility counts: a wrong count makes the run wrong, whatever its verdict. */
function withA11y(oracle: { ok: boolean; failed: string[] }, a11y: A11yRow | undefined): { ok: boolean; failed: string[] } {
  return a11y?.ok === false ? { ok: false, failed: [...oracle.failed, a11y.why!] } : oracle;
}

export function replayRow(task: BenchTask, run: OneRun): ReplayRow {
  const r = run.outcome?.result;
  const verdict: Verdict = r ? r.verdict : run.couldNot ? "could_not" : "error";
  const { asks: all, tokens, judgeAsks } = asksOf(run.noted);
  // A judge asked on replay isn't the actor or planner: a clean replay is still 0 asks, and its judge asks are said apart.
  const asks = all - judgeAsks;
  const allReplayed = Boolean(r && r.steps.length && r.steps.every((s) => s.replayed));
  const oracle = withA11y(judgeOracle(task.answer, run.end, run.hits), a11yRowOf(task, r));
  const wrong = verdict === "pass" && (task.answer.noHit ?? []).some((bad) => hitOf(run.hits, bad));
  const row = { verdict, asks, ...(judgeAsks ? { judgeAsks } : {}), tokens, seconds: run.seconds, allReplayed, wrong, oracleOk: oracle.ok };
  return { ...row, hit: replayHit(row) };
}

/** One task: fresh with the AI, then (if it passed) saved and replayed, and for a `changed` task replayed again on the changed site. */
export async function runTask(task: BenchTask, ctx: BenchContext, rep = 1): Promise<TaskRow> {
  const dir = join(ctx.dir, rep > 1 ? `${task.id}-${rep}` : task.id);
  if (task.suggest) return runSuggest(task, ctx, dir, rep);
  const fresh = await runOnce(task, ctx, join(dir, "fresh"));
  const result = fresh.outcome?.result;
  const verdict: Verdict = result ? result.verdict : fresh.couldNot ? "could_not" : "error";
  const a11y = a11yRowOf(task, result);
  const oracle = withA11y(judgeOracle(task.answer, fresh.end, fresh.hits), a11y);
  const judgedSteps = judgedOf(result);
  const { right, falsePass } = score(task, verdict, oracle.ok, judgedSteps);
  const { asks, tokens, decisions, judgeAsks } = asksOf(fresh.noted);
  const endUrl = (result as (TestResult & { endUrl?: string }) | undefined)?.endUrl;
  const row: TaskRow = {
    id: task.id,
    set: task.set,
    ...(testSetOf(task) ? { testSet: testSetOf(task) } : {}),
    rep,
    expect: task.expect,
    verdict,
    ...(verdict === "blocked" ? { blockedBy: result?.botWall ? ("bot check" as const) : result?.code === "SEED_DATA_MISSING" ? ("setup" as const) : ("safety" as const) } : {}),
    right,
    falsePass,
    reached: oracle.ok && task.expect === "pass",
    truth: oracle.ok && task.expect === "pass",
    oracle,
    asks,
    tokens,
    seconds: fresh.seconds,
    ...(result ? factsOf(result) : { actions: 0, steps: 0, passedSteps: 0, weakSteps: 0, reasons: [], rawTimeouts: 0, budgetEnds: 0, loopEnds: 0 }),
    decisions: decisions.length,
    decisionTokens: decisions.filter((d) => d.tokens).map((d) => d.tokens!.input + d.tokens!.cacheRead + d.tokens!.cacheWrite),
    decisionChars: decisions.map((d) => d.chars),
    ...(fresh.end ? { end: fresh.end } : {}),
    ...(endUrl !== undefined && fresh.end ? { endUrlAgrees: stripHash(withoutSecrets(endUrl)) === stripHash(fresh.end.url) } : {}),
    hits: fresh.hits.length,
    ...(judgedSteps ? { judgedSteps, labelled: labelledIn(join(dir, "fresh")) } : {}),
    ...(judgeAsks ? { judgeAsks } : {}),
    ...(result?.pictures ? { pictures: result.pictures } : {}),
    ...(a11y ? { a11y } : {}),
    ...(fresh.error ? { note: fresh.error } : {}),
    runDir: dir,
  };
  if (result?.stopped) row.note = [row.note, `stopped: ${clipped(result.stopped)}`].filter(Boolean).join("; ");
  ctx.log?.(`  ${task.id}: ${verdict}${row.blockedBy ? ` (${row.blockedBy})` : ""} · right ${right ? "yes" : "no"} · ${asks} asks · ${tokens} tokens · ${fresh.seconds}s`);
  if (verdict !== "pass" || !fresh.outcome?.save || ctx.noReplay) return row;

  // Saved as the CLI saves it, read back as it reads it, then replayed with the AI there, so a heal shows as asks.
  const savedPath = join(dir, "tests", `${task.id}.json`);
  writeSaved(savedPath, fresh.outcome.save, mask);
  const saved = readSaved(savedPath);
  row.replay = replayRow(task, await runOnce(task, ctx, join(dir, "replay"), saved));
  ctx.log?.(`  ${task.id} replay: ${row.replay.verdict} · ${row.replay.asks} asks${row.replay.hit ? " · hit" : ""}`);
  if (task.changed && ctx.site) {
    ctx.site.setVariant("changed");
    try {
      row.changed = replayRow(task, await runOnce(task, ctx, join(dir, "changed"), saved));
    } finally {
      ctx.site.setVariant("base");
    }
    ctx.log?.(`  ${task.id} changed: ${row.changed.verdict} · ${row.changed.asks} asks${row.changed.wrong ? " · SILENT WRONG" : ""}`);
  }
  return row;
}

/** F5: the suggest path through runFromUrl with nothing picked; right when the suggestions file stores the origin. */
async function runSuggest(task: BenchTask, ctx: BenchContext, dir: string, rep: number): Promise<TaskRow> {
  const url = addressOf(task, ctx.site);
  const origin = new URL(url).origin + "/";
  const noted: AskTiming[] = [];
  const begun = Date.now();
  mkdirSync(dir, { recursive: true });
  let note: string | undefined;
  let exit = -1;
  if (ctx.ai) {
    const said: string[] = [];
    exit = await runFromUrl({
      url, outDir: dir, testsDir: join(dir, "tests"), ai: timedAi(ctx.ai, noted, begun), vars: {}, mask, out: sink(), c: colors(false), json: false,
      maxActions: 25, allowHosts: [], headed: false, noCache: false, suggest: true, all: false, explore: false,
      usage: (s) => (said.push(s), 2), couldNot: (s) => (said.push(s), 3),
      stdout: { write: () => true }, input: { isTTY: false } as never,
      ...(ctx.wallWaitMs !== undefined ? { wallWaitMs: ctx.wallWaitMs } : {}),
    }).catch((error: unknown) => (said.push(String(error)), 3));
    if (said.length) note = clipped(said.join("; "), 300);
  } else note = "no AI: a suggest task needs one";
  const file = suggestedPathFor(dir, url);
  let stored: string | undefined;
  try {
    stored = (JSON.parse(readFileSync(file, "utf8")) as { url?: string }).url;
  } catch {
    // nothing suggested
  }
  const verdict: Verdict = exit === 0 && stored ? "suggested" : "could_not";
  const ok = stored === withoutSecrets(origin);
  const oracle = { ok, failed: ok ? [] : [stored ? `the suggestions file stores ${clipped(stored, 120)}, not the origin` : "no suggestions file"] };
  const { asks, tokens } = asksOf(noted);
  return {
    id: task.id, set: task.set, ...(testSetOf(task) ? { testSet: testSetOf(task) } : {}), rep, expect: task.expect, verdict, ...score(task, verdict, ok), oracle, asks, tokens,
    seconds: round((Date.now() - begun) / 1000, 1), actions: 0, steps: 0, passedSteps: 0, weakSteps: 0, reasons: [], decisions: 0, decisionTokens: [], decisionChars: [],
    rawTimeouts: 0, budgetEnds: 0, loopEnds: 0, hits: 0, ...(note ? { note } : {}), runDir: dir,
  };
}

/** A worker's own context (browser, sites), made once per worker and closed at the end. */
export interface Workers {
  make(worker: number): Promise<BenchContext>;
  close(ctx: BenchContext): Promise<void>;
}

/**
 * Runs `work` over `jobs` on up to `n` workers at once, each with its own context made by `make`
 * (nothing shared between workers), and gives the results in the jobs' order.
 */
export async function runPool<J, C, R>(jobs: readonly J[], n: number, make: (worker: number) => Promise<C>, work: (job: J, ctx: C, worker: number) => Promise<R>, close: (ctx: C) => Promise<void>): Promise<R[]> {
  const out = new Array<R>(jobs.length);
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(n, jobs.length)) }, async (_, w) => {
    const ctx = await make(w);
    try {
      for (let i = next++; i < jobs.length; i = next++) out[i] = await work(jobs[i]!, ctx, w);
    } finally {
      await close(ctx);
    }
  }));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return out;
}

export type AnyTask = BenchTask & { suite?: "app" | "pay" | "zoo" };

/** The runner a task takes: a fixture or real task runTask, an app task runAppTask, a pay task runPayTask. */
export function runnerOf(task: AnyTask): (task: never, ctx: BenchContext, rep: number) => Promise<TaskRow> {
  return task.suite === "app" ? runAppTask : task.suite === "pay" ? runPayTask : task.suite === "zoo" ? runZooTask : runTask;
}

/**
 * Every task asked for, `parallel` at a time (default one after another); a host that showed a bot
 * check gets nothing more that night. Real-site tasks always run one at a time, whatever `parallel`.
 * `ctx` is one context (parallel 1 only) or a maker of one per worker.
 */
export async function runBench(tasks: readonly AnyTask[], ctx: BenchContext | Workers, repeat = 1, parallel = 1): Promise<TaskRow[]> {
  const workers: Workers = "make" in ctx ? ctx : { make: async () => ctx, close: async () => {} };
  if (!("make" in ctx) && parallel > 1) throw new Error("--parallel above 1 needs a context per worker");
  const jobs = tasks.flatMap((task) => Array.from({ length: repeat }, (_, i) => ({ task, rep: i + 1 })));
  const walled = new Set<string>();
  let realTurn: Promise<unknown> = Promise.resolve();
  const oneAtATime = <R>(f: () => Promise<R>): Promise<R> => {
    const p = realTurn.then(f);
    realTurn = p.catch(() => {});
    return p;
  };
  const one = async ({ task, rep }: { task: AnyTask; rep: number }, c: BenchContext): Promise<TaskRow> => {
    const host = onWeb(task) ? new URL(task.url).host : "";
    if (host && walled.has(host)) {
      c.log?.(`  ${task.id}: skipped (bot check on ${host} earlier)`);
      return { id: task.id, set: task.set, rep, expect: task.expect, verdict: "skipped", right: false, falsePass: false, oracle: { ok: false, failed: [] }, asks: 0, tokens: 0, seconds: 0, actions: 0, steps: 0, passedSteps: 0, weakSteps: 0, reasons: [], decisions: 0, decisionTokens: [], decisionChars: [], rawTimeouts: 0, budgetEnds: 0, loopEnds: 0, hits: 0, note: `not run: ${host} showed a bot check earlier tonight (no retry)` };
    }
    c.log?.(`${task.id}${repeat > 1 ? ` #${rep}` : ""}: ${task.goal}`);
    const row = await runnerOf(task)(task as never, c, rep);
    if (host && row.blockedBy === "bot check") walled.add(host);
    return row;
  };
  return runPool(jobs, parallel, workers.make, (job, c) => (onWeb(job.task) ? oneAtATime(() => one(job, c)) : one(job, c)), workers.close);
}

// ---------------------------------------------------------------------------------------------
// Which code made a result.

export function metaNow(ai?: string): Meta {
  const git = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } catch {
      return "";
    }
  };
  // The working tree as it is: tracked changes, plus the untracked files of the engine and the CLI.
  const hash = createHash("sha1").update(git(["diff", "HEAD"]));
  for (const f of git(["ls-files", "--others", "--exclude-standard", "--", "packages/scanner/src", "apps/cli"]).split("\n").filter((f) => f && !f.startsWith("cli/bench/results/")).sort()) {
    hash.update(`\n${f}\n`);
    try {
      hash.update(readFileSync(join(REPO, f)));
    } catch {
      // gone since it was listed
    }
  }
  let playwright = "";
  try {
    playwright = (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
  } catch {
    // not found
  }
  return { head: git(["rev-parse", "HEAD"]).trim(), diff: hash.digest("hex"), at: new Date().toISOString(), node: process.version, playwright, ...(ai ? { ai } : {}) };
}

export function readResult(labelOrPath: string, dir = RESULTS_DIR): BenchResult {
  const path = existsSync(labelOrPath) ? labelOrPath : join(dir, `${labelOrPath}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as BenchResult;
}

export function writeResult(result: BenchResult, dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${result.label}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ai: { type: "string" }, model: { type: "string" }, set: { type: "string" }, only: { type: "string" }, label: { type: "string" },
      repeat: { type: "string" }, compare: { type: "boolean" }, merge: { type: "boolean" }, results: { type: "string" }, headed: { type: "boolean" }, parallel: { type: "string" },
      seed: { type: "string" }, replay: { type: "string" },
    },
  });
  const resultsDir = values.results ? resolve(values.results) : RESULTS_DIR;
  const err = (s: string) => process.stderr.write(`${s}\n`);
  if (values.compare) {
    if (positionals.length !== 2) return (err("--compare takes two labels: --compare before after"), 2);
    process.stdout.write(formatCompare(readResult(positionals[0]!, resultsDir), readResult(positionals[1]!, resultsDir)));
    return 0;
  }
  if (values.merge) {
    if (!values.label || positionals.length < 2) return (err("--merge takes the labels to merge and --label for the new one"), 2);
    const merged = mergeResults(values.label, positionals.map((p) => readResult(p, resultsDir)));
    const path = writeResult(merged, resultsDir);
    process.stdout.write(formatTable(merged));
    err(`wrote ${path}`);
    return 0;
  }
  const set = values.set ?? "fixture";
  if (!["fixture", "real", "all", "auth", "judge", "app", "pay", "zoo"].includes(set)) return (err("--set is fixture, real, all, judge, auth, app, pay or zoo"), 2);
  const seed = values.seed === undefined ? undefined : Number(values.seed);
  if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) return (err("--seed takes a whole number"), 2);
  if (values.replay !== undefined && values.replay !== "on" && values.replay !== "off") return (err("--replay is on or off"), 2);
  const zooSet = seed === undefined ? ZOO_SET : zooTasks(seed);
  const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean);
  const parallel = values.parallel ? Number(values.parallel) : 1;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) return (err("--parallel takes 1 to 8"), 2);
  if (set === "auth") return runAuthSet({ only, repeat: values.repeat, label: values.label, ai: values.ai, model: values.model, headed: values.headed === true, resultsDir, err });
  // "all" is the fixture and real sets (what the BEFORE numbers were); the judge set is asked for by name, or by --only.
  const pool: readonly AnyTask[] = set === "app" ? APP_SET : set === "pay" ? PAY_SET : set === "zoo" ? zooSet : only ? [...ALL_TASKS, ...zooSet] : set === "judge" ? JUDGE_TASKS : TASKS;
  const tasks = pool.filter((t) => (only ? only.includes(t.id) : set === "all" || set === "app" || set === "pay" || set === "zoo" || t.set === set));
  if (only) for (const id of only) if (!pool.some((t) => t.id === id)) return (err(`no task ${id} in --set ${set}`), 2);
  if (!tasks.length) return (err("no tasks to run"), 2);
  const repeat = values.repeat ? Number(values.repeat) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) return (err("--repeat takes 1 to 5"), 2);
  const label = values.label ?? `run-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`;
  if (!/^[\w.-]+$/.test(label)) return (err("--label takes letters, digits, . _ -"), 2);
  // --ai none: no AI at all. The planner and actor give up at once, so only what needs no AI is
  // measured (bot walls, access refusals, Discovery, the harness); a verdict needing a decision is not a pass.
  const ai = values.ai === "none" ? undefined : pickAi(values.ai, values.model);
  if (!ai && values.ai !== "none") return (err("the bench needs an AI: --ai claude-code (or --ai none for the harness only)"), 2);
  const meta = metaNow(ai?.via ?? "none");
  const dir = join(tmpdir(), `cm-bench-${label}`);
  mkdirSync(dir, { recursive: true });
  err(`bench ${label}: ${tasks.length} tasks × ${repeat} · AI ${ai?.via ?? "none"} · parallel ${parallel} · runs in ${dir}`);
  const needs = { fixture: tasks.some((t) => !onWeb(t) && !t.suite), app: tasks.some((t) => t.suite === "app"), pay: tasks.some((t) => t.suite === "pay"), zoo: needsZoo(tasks) };
  const brainFor: BenchContext["brainFor"] = (noted, at, use) => (ai ? aiBrain(timedAi(ai, noted, at), use?.vars ?? [], { visitor: use?.visitor ?? true }) : noAiBrain(noted));
  // Each worker: its own browser and its own sites, so no request log, variant or ledger is shared.
  const workers: Workers = {
    make: async (w) => {
      const browser = await launch(values.headed === true);
      const [site, app, pay, zoo] = await Promise.all([needs.fixture ? startFixtureSite() : undefined, needs.app ? startAppSites() : undefined, needs.pay ? startPaySites() : undefined, needs.zoo ? startZoo() : undefined]);
      return { browser, ...(site ? { site } : {}), ...(app ? { app } : {}), ...(pay ? { pay } : {}), ...(zoo ? { zoo } : {}), ...(values.replay === "off" ? { noReplay: true } : {}), dir, ...(ai ? { ai } : {}), brainFor, log: parallel > 1 ? (s: string) => err(`[${w + 1}] ${s}`) : err };
    },
    close: async (c) => {
      await Promise.all([c.site?.close(), c.app?.close(), c.pay?.close(), c.zoo?.close()]);
      await c.browser.close().catch(() => {});
    },
  };
  const begun = Date.now();
  const rows = await runBench(tasks, workers, repeat, parallel);
  const wallSeconds = round((Date.now() - begun) / 1000, 1);
  if (!ai) for (const r of rows) if (r.decisions > 0) Object.assign(r, noAiRow(r));
  const result: BenchResult = { label, meta: { ...meta, ...(parallel > 1 ? { parallel } : {}), wallSeconds }, tasks: rows, totals: totalsOf(rows) };
  const path = writeResult(result, resultsDir);
  process.stdout.write(formatTable(result));
  err(`wrote ${path} · ${wallSeconds}s wall at --parallel ${parallel}`);
  return 0;
}

/** The sign-in set (auth-bench.ts): each task on its own fixture, leak-checked, scored by the server's log. */
async function runAuthSet(o: { only?: string[]; repeat?: string; label?: string; ai?: string; model?: string; headed: boolean; resultsDir: string; err: (s: string) => void }): Promise<number> {
  const tasks = AUTH_TASKS.filter((t) => !o.only || o.only.includes(t.id));
  if (o.only) for (const id of o.only) if (!AUTH_TASKS.some((t) => t.id === id)) return (o.err(`no auth task ${id}`), 2);
  const repeat = o.repeat ? Number(o.repeat) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) return (o.err("--repeat takes 1 to 5"), 2);
  const label = o.label ?? `auth-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}`;
  if (!/^[\w.-]+$/.test(label)) return (o.err("--label takes letters, digits, . _ -"), 2);
  const ai = pickAi(o.ai, o.model);
  if (!ai) return (o.err("the bench needs an AI: --ai claude-code"), 2);
  const meta = metaNow(ai.via);
  const dir = join(tmpdir(), `cm-bench-${label}`);
  mkdirSync(dir, { recursive: true });
  o.err(`bench ${label}: ${tasks.length} auth tasks × ${repeat} · AI ${ai.via} · runs in ${dir}`);
  const browser = await launch(o.headed);
  const begun = Date.now();
  const rows: AuthRow[] = [];
  try {
    for (const task of tasks) {
      for (let rep = 1; rep <= repeat; rep++) {
        o.err(`${task.id}${repeat > 1 ? ` #${rep}` : ""}: ${task.mode}`);
        const prompts: string[] = [];
        // Every question and answer is kept for the leak check (never written out).
        const kept = (asked: Ai): Ai => {
          const wrap = <T extends { ask: Ai["ask"] }>(x: T): T => ({ ...x, ask: async (system: string, question: string, schema: object) => {
            const answer = await x.ask(system, question, schema);
            prompts.push(`${system}\n${question}\n${answer.text}`);
            return answer;
          } });
          return { ...wrap(asked), ...(asked.light ? { light: wrap(asked.light) } : {}) };
        };
        const row = await runAuthTask(task, {
          browser, dir, prompts, log: o.err,
          brainFor: (noted, use) => aiBrain(kept(timedAi(ai, noted, begun)), use.names, use.signIn ? { signIn: true, signedIn: use.signedIn } : {}),
        }, rep);
        rows.push(row);
        o.err(`  ${task.id}: ${row.verdict}${row.code ? ` (${row.code})` : ""} · right ${row.right ? "yes" : "no"} · ${row.asks} asks · replay ${row.replayAsks ?? "-"} asks · sign-ins ${row.signIns} · refused ${row.refused} · leaks ${row.leaks.length} · ${row.seconds}s${row.problem ? ` · ${row.problem}` : ""}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const result = { label, meta, set: "auth", auth: rows, authTotals: authTotals(rows) };
  mkdirSync(o.resultsDir, { recursive: true });
  const path = join(o.resultsDir, `${label}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatAuthTable(label, rows));
  o.err(`wrote ${path} · ${Math.round((Date.now() - begun) / 1000)}s in all`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
