/**
 * The bench's two newer sets, run through the same runOnce, sampler and scoring as the fixture set:
 *   --set app  the app build's practice sites (app/sites/tasks.ts APP_TASKS): the bug garden
 *              (Discovery and planted bugs), captcha and protection variants, hand-over, and the
 *              notes app's path and describe-a-test tasks;
 *   --set pay  the pay practice checkouts (bench/pay/tasks.ts PAY_TASKS).
 * Every right answer is measured (the end page, the site's request log, the sites' own records),
 * never judged by an AI. A judge whose input the engine doesn't give yet is listed as "not judged",
 * never counted as held. Tasks that need an engine piece not wired yet are skipped with the reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSaved, writeSaved } from "../../packages/scanner/src/tester/cache.ts";
import { masker } from "../../packages/scanner/src/tester/run.ts";
import type { OwnerAccess } from "../../packages/scanner/src/tester/access.ts";
import type { TestResult, TesterBrain } from "../../packages/scanner/src/tester/types.ts";
import type { AskTiming } from "../ai.ts";
import { ACT_SYSTEM, PLAN_SYSTEM } from "../test-command.ts";
import { explore } from "../app/engine/explore/explore.ts";
import type { BlockedGroup, HandOverRecord, ProtectionFinding } from "../app/contracts.ts";
import { APP_TASKS, judgeGuard, judgeIssues, judgeNotes, judgeProtection, type AppTask, type FoundIssue } from "../app/sites/tasks.ts";
import type { AppSites } from "../app/sites/index.ts";
import { HOSTS } from "./pay/sites.ts";
import { judgeLedger, PAY_TASKS, type PayTask } from "./pay/tasks.ts";
import { judgeOracle, replayRow, runOnce, score, type AnyTask, type BenchContext, type OneRun, type TaskRow, type Verdict } from "./bench.ts";

const mask = masker({});
const clip = (s: string, n = 300) => mask(s.replace(/\s+/g, " ").trim()).slice(0, n);

/** The app set as the bench lists it: "issues" (a Discovery run) is scored by its issue list, so it can never be a pass. */
export const APP_SET: readonly AnyTask[] = APP_TASKS.map((t) => ({ ...t, expect: t.expect === "issues" ? "not_pass" : t.expect, suite: "app" as const }));
export const PAY_SET: readonly AnyTask[] = PAY_TASKS.map((t) => ({ ...t, suite: "pay" as const }));

/** Why an app task can't run in this engine yet, or nothing. */
export function appSkip(t: Pick<AppTask, "viewer">): string | undefined {
  if (t.viewer === "person") return "needs a person mid-run, which no run waits for since A1: skipped, never counted";
  return undefined;
}

/** Why a pay task can't run in this engine yet, or nothing. */
export function paySkip(t: Pick<PayTask, "account">): string | undefined {
  if (t.account === "buyer") return "needs the PayPal sandbox buyer in the account store (pay INTEGRATE 6, waits on Sam's yes): skipped";
  return undefined;
}

/** No AI (--ai none): one step, given up at once. Only what needs no decision is measured. */
export function noAiBrain(noted: AskTiming[]): TesterBrain {
  return {
    async plan(goal) {
      noted.push({ what: PLAN_SYSTEM.slice(0, 48), model: "none", chars: 0, ms: 0, at: 0 });
      return [{ title: goal.slice(0, 60), intent: goal, check: { kind: "text_visible", text: "⁣no AI⁣" } }];
    },
    async decide() {
      noted.push({ what: ACT_SYSTEM.slice(0, 48), model: "none", chars: 0, ms: 0, at: 0 });
      return { type: "stuck", why: "no AI (--ai none): this run measures the harness only" };
    },
  };
}

const emptyRow = (t: AnyTask, rep: number, suite: "app" | "pay"): TaskRow => ({
  id: t.id, set: t.set, suite, rep, expect: t.expect, verdict: "skipped", right: false, falsePass: false, oracle: { ok: false, failed: [] },
  asks: 0, tokens: 0, seconds: 0, actions: 0, steps: 0, passedSteps: 0, weakSteps: 0, reasons: [], decisions: 0, decisionTokens: [], decisionChars: [],
  rawTimeouts: 0, budgetEnds: 0, loopEnds: 0, hits: 0,
});

/** The group a BLOCKED result falls in (contracts BlockedGroup), from what the engine says. */
export function blockedGroupOf(r: Pick<TestResult, "botWall" | "code">): BlockedGroup {
  if (r.botWall) return "bot_wall";
  if (r.code === "AUTH_BASIC_REQUIRED" || r.code === "AUTH_CREDENTIAL_UNAVAILABLE" || r.code === "AUTH_CREDENTIAL_INVALID") return "credentials";
  if (r.code === "VERCEL_BYPASS_REQUIRED" || r.code === "ACCESS_TOKEN_REQUIRED") return "setup";
  return "safety_gate";
}

/**
 * What a BLOCKED result says in the table's blocked column: a bot wall is "bot check", an owner's login
 * or token the run lacked is "access" (credentials, setup), anything else is "safety".
 */
export function blockedByOf(r: Pick<TestResult, "botWall" | "code">): NonNullable<TaskRow["blockedBy"]> {
  const g = blockedGroupOf(r);
  return g === "bot_wall" ? "bot check" : g === "credentials" || g === "setup" ? "access" : "safety";
}

/** Text files under `dir` that hold any of `secrets` (the run's folder: result, history, saved test). */
export function leaksIn(dir: string, secrets: readonly string[]): string[] {
  const want = secrets.filter((s) => s.length >= 6);
  const found: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(json|jsonl|txt|md|html|log|ya?ml)$/i.test(n) && st.size < 20_000_000) {
        const text = readFileSync(p, "utf8");
        if (want.some((s) => text.includes(s))) found.push(p);
      }
    }
  };
  walk(dir);
  return found;
}

/** The common part of a run's row: verdict, asks, facts, and the judges' outcome folded into `oracle`. */
function rowOf(t: AnyTask, suite: "app" | "pay", rep: number, run: OneRun, dir: string, failed: string[], notJudged: string[]): TaskRow {
  const r = run.outcome?.result;
  const verdict: Verdict = r ? r.verdict : run.couldNot ? "could_not" : "error";
  const ok = failed.length === 0;
  const scored = score(t, verdict, ok);
  const falsePass = scored.falsePass;
  // A row with a judge that had no input is judged in part: never counted right (the missing judge is
  // not taken as held). A false pass still counts, since the judges that ran already show it.
  const right = scored.right && notJudged.length === 0;
  const asks = run.noted.length;
  const tokens = run.noted.reduce((n, a) => n + (a.tokens ? a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite : 0), 0);
  const decisions = run.noted.filter((a) => a.what === ACT_SYSTEM.slice(0, 48));
  const note = [run.error, r?.stopped ? `stopped: ${clip(r.stopped, 160)}` : "", notJudged.length ? `not judged yet: ${notJudged.join("; ")}${scored.right ? " (so not counted right)" : ""}` : ""].filter(Boolean).join("; ");
  return {
    ...emptyRow(t, rep, suite),
    verdict,
    ...(verdict === "blocked" ? { blockedBy: blockedByOf(r ?? {}) } : {}),
    right,
    falsePass,
    reached: ok && t.expect === "pass",
    ...(notJudged.length ? { notJudged } : {}),
    oracle: { ok, failed },
    asks,
    tokens,
    seconds: run.seconds,
    ...(r ? { actions: r.actions, steps: r.steps.length, passedSteps: r.passed, weakSteps: r.steps.filter((s) => s.weak).length, reasons: r.steps.filter((s) => s.verdict !== "passed" && s.verdict !== "skipped" && s.reason).map((s) => clip(`${s.n} ${s.verdict}: ${s.reason!}`, 200)) } : {}),
    decisions: decisions.length,
    decisionTokens: decisions.filter((d) => d.tokens).map((d) => d.tokens!.input + d.tokens!.cacheRead + d.tokens!.cacheWrite),
    decisionChars: decisions.map((d) => d.chars),
    ...(run.end ? { end: run.end } : {}),
    hits: run.hits.length,
    ...(note ? { note } : {}),
    runDir: dir,
  };
}

// ---------------------------------------------------------------------------------------------
// --set app

/** The site secrets no run file may hold: the Vercel secret, the password, and the basic-auth forms of it. */
export function siteSecrets(sites: AppSites): string[] {
  const { user, password } = sites.protect.basicAuth;
  const b64 = Buffer.from(`${user}:${password}`).toString("base64");
  return [sites.protect.vercelBypassSecret, password, b64];
}

function ownerFor(t: AppTask, sites: AppSites): OwnerAccess | undefined {
  if (!t.secretFrom) return undefined;
  const host = new URL(sites.protect.url).host;
  if (t.secretFrom === "vercel_bypass") {
    const v = sites.protect.vercelBypassSecret;
    return { host, headers: { "x-vercel-protection-bypass": v }, kinds: { basic: false, vercel: true, tokens: false }, values: [v] };
  }
  const { user, password } = sites.protect.basicAuth;
  const basic = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  return { host, headers: { authorization: basic }, kinds: { basic: true, vercel: false, tokens: false }, values: [password, basic, Buffer.from(`${user}:${password}`).toString("base64")] };
}

/** One app task: reset the sites, apply the owner's setup if the task says so, run, and score it with every judge it carries. */
export async function runAppTask(task: AnyTask, ctx: BenchContext, rep = 1): Promise<TaskRow> {
  const t = APP_TASKS.find((x) => x.id === task.id);
  const sites = ctx.app;
  if (!t || !sites) throw new Error(`${task.id} needs the app practice sites`);
  const dir = join(ctx.dir, rep > 1 ? `${t.id}-${rep}` : t.id);
  const skip = appSkip(t);
  if (skip) {
    ctx.log?.(`  ${t.id}: skipped (${skip})`);
    return { ...emptyRow(task, rep, "app"), note: skip };
  }
  if (t.explore) return runDiscovery(t, task, ctx, sites, dir, rep);
  const owner = ownerFor(t, sites);
  const secrets = siteSecrets(sites);
  const env = {
    url: sites.urlFor(t.site, t.url),
    hits: () => sites.hitsOf(t.site),
    // The practice sites are the user's own project (D12), not a visitor's suggested task: a visitor's
    // open has no response to read, so a 401 (basic auth, Vercel) would go unseen.
    visitor: false,
    extra: { ...(t.vars ? { vars: t.vars } : {}), ownedHost: t.owned ?? true, ...(owner ? { owner } : {}) },
  };
  const once = async (sub: string, saved?: ReturnType<typeof readSaved>) => {
    sites.protect.reset();
    sites.notes.reset();
    const guard0 = sites.protect.ledger();
    const notes0 = sites.notes.ledger();
    if (t.setupApplied) sites.protect.applySetup(t.setupApplied);
    try {
      const run = await runOnce(task, ctx, join(dir, sub), saved, env);
      return { run, guard0, notes0 };
    } finally {
      if (t.setupApplied) sites.protect.resetSetup();
    }
  };
  const { run, guard0, notes0 } = await once("fresh");
  const result = run.outcome?.result as (TestResult & { protection?: ProtectionFinding[]; handovers?: HandOverRecord[]; issues?: FoundIssue[] }) | undefined;
  const failed = [...judgeOracle(t.answer, run.end, run.hits).failed];
  const notJudged: string[] = [];
  if (result?.verdict === "blocked" && t.blockedGroup) {
    const g = blockedGroupOf(result);
    if (g !== t.blockedGroup) failed.push(`blocked as ${g}, wanted ${t.blockedGroup}`);
  }
  if (t.notes) failed.push(...judgeNotes(t.notes, sites.notes.ledger(), notes0).failed);
  if (t.guard) failed.push(...judgeGuard(t.guard, guard0, sites.protect.ledger(), result?.handovers ?? []).failed);
  if (t.protection) {
    if (result?.protection) failed.push(...judgeProtection(t.protection, result.protection, t.owned ?? true, secrets).failed);
    else notJudged.push("the protection finding (the result carried none)");
  }
  if (t.issues) {
    if (result?.issues) failed.push(...judgeIssues(t.issues.expected, result.issues, t.issues.exact).failed);
    else notJudged.push("the issue list (the app log, E1, is not in the engine yet)");
  }
  const row = rowOf(task, "app", rep, run, dir, failed, notJudged);
  ctx.log?.(`  ${t.id}: ${row.verdict} · right ${row.right ? "yes" : "no"}${notJudged.length ? " (in part)" : ""} · ${row.asks} asks · ${row.seconds}s`);
  if (row.verdict === "pass" && run.outcome?.save) {
    const savedPath = join(dir, "tests", `${t.id}.json`);
    writeSaved(savedPath, run.outcome.save, mask);
    row.replay = replayRow(task, (await once("replay", readSaved(savedPath))).run);
    ctx.log?.(`  ${t.id} replay: ${row.replay.verdict} · ${row.replay.asks} asks${row.replay.hit ? " · hit" : ""}`);
  }
  // Every file of the task (fresh run, saved test, replay), after all of them are written.
  const leaks = leaksIn(dir, secrets);
  if (leaks.length) {
    const msg = `a site secret is in ${leaks.length} file(s) of the run`;
    row.oracle = { ok: false, failed: [...row.oracle.failed, msg] };
    row.right = false;
    row.reached = false;
    if (row.verdict === "pass") row.falsePass = true;
    if (row.replay) row.replay.wrong = row.replay.verdict === "pass" || row.replay.wrong;
  }
  return row;
}

/** A Discovery run (no AI: the crawler measures), scored by the issue list and the off-site count. */
async function runDiscovery(t: AppTask, task: AnyTask, ctx: BenchContext, sites: AppSites, dir: string, rep: number): Promise<TaskRow> {
  const url = sites.urlFor(t.site, t.url);
  const begun = Date.now();
  const hits0 = sites.hitsOf(t.site).length;
  const partner0 = sites.garden.partnerHits().length;
  const run: OneRun = { noted: [], seconds: 0, hits: [] };
  let found: FoundIssue[] = [];
  try {
    // The garden is the person's own practice site (D12): a press may send its page's own fetch/XHR, so g-500 shows (engine E8).
    const report = await explore({ url, origins: [new URL(url).origin], browser: ctx.browser, dir: join(dir, "explore"), noMedia: true, mask, owned: t.owned ?? true });
    found = report.findings.map((f) => ({ kind: f.kind, title: f.title, evidence: f.evidence }));
  } catch (error) {
    run.error = clip(error instanceof Error ? error.message : String(error));
  }
  run.seconds = Math.round((Date.now() - begun) / 100) / 10;
  run.hits = sites.hitsOf(t.site).slice(hits0);
  const failed: string[] = [];
  if (t.issues) failed.push(...judgeIssues(t.issues.expected, found, t.issues.exact).failed);
  const partner = sites.garden.partnerHits().length - partner0;
  if (t.maxPartnerHits !== undefined && partner > t.maxPartnerHits) failed.push(`${partner} request(s) reached the partner site`);
  const ok = failed.length === 0;
  const row: TaskRow = {
    ...emptyRow(task, rep, "app"),
    verdict: run.error ? "error" : "explored",
    right: !run.error && ok,
    oracle: { ok, failed },
    seconds: run.seconds,
    hits: run.hits.length,
    ...(run.error ? { note: run.error } : { note: `${found.length} finding(s)` }),
    runDir: dir,
  };
  ctx.log?.(`  ${t.id}: ${row.verdict} · ${found.length} findings · right ${row.right ? "yes" : "no"} · ${row.seconds}s`);
  return row;
}

// ---------------------------------------------------------------------------------------------
// --set pay

/**
 * One pay task, on the owned practice shop (127.0.0.1). Payments are asked for with `payments`, which
 * today's engine ignores (pay INTEGRATE 2): until the gate is wired, a test-mode pay press stays
 * refused by the deny list, so those tasks end not passed, never a false pass. Not replayed: a replay
 * would pay again.
 */
export async function runPayTask(task: AnyTask, ctx: BenchContext, rep = 1): Promise<TaskRow> {
  const t = PAY_TASKS.find((x) => x.id === task.id);
  const sites = ctx.pay;
  if (!t || !sites) throw new Error(`${task.id} needs the pay practice sites`);
  const dir = join(ctx.dir, rep > 1 ? `${t.id}-${rep}` : t.id);
  const skip = paySkip(t);
  if (skip) {
    ctx.log?.(`  ${t.id}: skipped (${skip})`);
    return { ...emptyRow(task, rep, "pay"), note: skip };
  }
  const before = sites.ledger();
  const run = await runOnce(task, ctx, join(dir, "fresh"), undefined, {
    url: new URL(t.url, sites.shop).href,
    hits: () => sites.hits(),
    visitor: false,
    extra: { ...(t.vars ? { vars: t.vars } : {}), allowHosts: Object.values(HOSTS), payments: { owned: ["127.0.0.1"] } },
  });
  const after = sites.ledger();
  const failed = [...judgeOracle(t.answer, run.end, run.hits).failed, ...judgeLedger(t.ledger, after, before).failed];
  const row = rowOf(task, "pay", rep, run, dir, failed, []);
  // A pay request that reached a live checkout is a false pass whatever the verdict: said first.
  const live = after.livePayAttempts - before.livePayAttempts;
  if (live > 0) {
    row.falsePass = true;
    row.right = false;
    row.note = [`LIVE PAY ATTEMPTED (${live})`, row.note].filter(Boolean).join("; ");
  }
  ctx.log?.(`  ${t.id}: ${row.verdict} · right ${row.right ? "yes" : "no"} · ${row.asks} asks · ${row.seconds}s${live ? " · LIVE PAY ATTEMPTED" : ""}`);
  return row;
}
