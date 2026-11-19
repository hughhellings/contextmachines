/**
 * The zoo as a bench set (--set zoo): every page under its four twins, as bench tasks, each run on a
 * fresh instance of the page (its own records and ledger), scored by the server's own record
 * (server.ts zooOracle), never by an AI. Fresh runs only: a zoo run is never replayed (plan 9d,
 * "scoring uses fresh runs with replay off").
 *
 * The D set runs each page under one fixed seed and skin. --seed N runs every page under seed N with
 * the skin the seed picks: that is H1 (fresh seeds each night, totals only).
 */
import { join } from "node:path";
import { masker } from "../../../packages/scanner/src/tester/run.ts";
import { ACT_SYSTEM } from "../../test-command.ts";
import { JUDGE_SYSTEM } from "../../../packages/scanner/src/tester/judge.ts";
import { blockedByOf } from "../app-bench.ts";
import { runOnce, score, type AnyTask, type BenchContext, type TaskRow, type Verdict } from "../bench.ts";
import type { TestSet } from "../tasks.ts";
import { EXPECT, TWINS, type Twin } from "./kit.ts";
import { instanceOf, ZOO_FILES, ZOO_PAGES, zooOracle, type ZooServer } from "./server.ts";

const mask = masker({});
const clip = (s: string, n = 200) => mask(s.replace(/\s+/g, " ").trim()).slice(0, n);

export interface ZooTask extends AnyTask {
  suite: "zoo";
  zoo: { page: string; twin: Twin; seed: number; skin?: (typeof ZOO_PAGES)[number]["skin"] };
}

/** The D set's seed for a page: fixed, so D runs compare across waves. */
export const dSeed = (i: number) => 1000 + i * 37;

/**
 * The zoo's tasks: D (each page's fixed seed and skin) or, with `seed`, H1 (that seed for every page,
 * the skin the seed picks). The goal is the page's own words for the seed.
 */
export function zooTasks(seed?: number): ZooTask[] {
  return ZOO_PAGES.flatMap((p, i) =>
    TWINS.map((twin): ZooTask => {
      const s = seed ?? dSeed(i);
      const skin = seed === undefined ? p.skin : undefined;
      const probe = instanceOf(p, twin, s, skin);
      const testSet: TestSet = seed === undefined ? "D" : "H1";
      return {
        id: `zoo-${p.id}-${twin}`,
        set: "zoo",
        testSet,
        twin,
        suite: "zoo",
        visitor: true,
        url: `zoo:${p.id}/${twin}`,
        goal: p.goal({ v: probe.v, twin, filesDir: ZOO_FILES }),
        expect: EXPECT[twin],
        answer: {},
        mode: `${p.widget}: ${p.modes[twin]}`,
        zoo: { page: p.id, twin, seed: s, ...(skin ? { skin } : {}) },
      };
    }),
  );
}

export const ZOO_SET: readonly ZooTask[] = zooTasks();

/** One zoo task: a fresh instance, one fresh run (no replay), scored by the server's record. */
export async function runZooTask(task: AnyTask, ctx: BenchContext, rep = 1): Promise<TaskRow> {
  const z = (task as ZooTask).zoo;
  const zoo = ctx.zoo;
  if (!z || !zoo) throw new Error(`${task.id} needs the zoo server`);
  const dir = join(ctx.dir, rep > 1 ? `${task.id}-${rep}` : task.id);
  const inst = zoo.open(z.page, z.twin, z.seed, z.skin);
  const run = await runOnce(task, ctx, join(dir, "fresh"), undefined, {
    url: zoo.startUrl(inst),
    hits: () => inst.hits,
    // The zoo stands in for the person's own app (an owned host), not a visitor's suggested task.
    visitor: false,
    extra: { ownedHost: true, ...(ZOO_PAGES.find((p) => p.id === z.page)?.run ?? {}) },
  });
  const verdictOf = zooOracle(inst, task.expect);
  const r = run.outcome?.result;
  const verdict: Verdict = r ? r.verdict : run.couldNot ? "could_not" : "error";
  const judgedSteps = r ? r.steps.filter((s) => s.verdict === "passed" && s.judged).length : 0;
  const { right, falsePass } = score(task, verdict, verdictOf.ok);
  const decisions = run.noted.filter((a) => a.what === ACT_SYSTEM.slice(0, 48));
  const judgeAsks = run.noted.filter((a) => a.what === JUDGE_SYSTEM.slice(0, 48)).length;
  const note = [run.error, r?.stopped ? `stopped: ${clip(r.stopped, 160)}` : "", verdictOf.forbidden.length ? `FORBIDDEN: ${verdictOf.forbidden.join("; ")}` : ""].filter(Boolean).join("; ");
  const row: TaskRow = {
    id: task.id,
    set: task.set,
    suite: "zoo",
    testSet: task.testSet,
    twin: z.twin,
    widget: z.page,
    rep,
    expect: task.expect,
    verdict,
    ...(verdict === "blocked" ? { blockedBy: blockedByOf(r ?? {}) } : {}),
    right,
    falsePass,
    reached: verdictOf.ok && task.expect === "pass",
    truth: verdictOf.done,
    cleanup: verdictOf.cleanup,
    ...(verdictOf.forbidden.length ? { forbidden: verdictOf.forbidden } : {}),
    oracle: { ok: verdictOf.ok, failed: verdictOf.failed.map((f) => clip(f, 240)) },
    asks: run.noted.length,
    tokens: run.noted.reduce((n, a) => n + (a.tokens ? a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite : 0), 0),
    seconds: run.seconds,
    actions: r?.actions ?? 0,
    steps: r?.steps.length ?? 0,
    passedSteps: r?.passed ?? 0,
    weakSteps: r ? r.steps.filter((s) => s.weak).length : 0,
    reasons: r ? r.steps.filter((s) => s.verdict !== "passed" && s.verdict !== "skipped" && s.reason).map((s) => clip(`${s.n} ${s.verdict}: ${s.reason!}`)) : [],
    decisions: decisions.length,
    decisionTokens: decisions.filter((d) => d.tokens).map((d) => d.tokens!.input + d.tokens!.cacheRead + d.tokens!.cacheWrite),
    decisionChars: decisions.map((d) => d.chars),
    rawTimeouts: 0,
    budgetEnds: r ? r.steps.filter((s) => /actions? (weren't|wasn't) enough|ran out of actions|action budget/i.test(s.reason ?? "")).length : 0,
    loopEnds: 0,
    ...(run.end ? { end: run.end } : {}),
    hits: run.hits.length,
    ...(judgedSteps ? { judgedSteps } : {}),
    ...(judgeAsks ? { judgeAsks } : {}),
    ...(note ? { note } : {}),
    runDir: dir,
  };
  ctx.log?.(`  ${task.id}: ${verdict}${row.blockedBy ? ` (${row.blockedBy})` : ""} · right ${right ? "yes" : "no"}${falsePass ? " · FALSE PASS" : ""} · done ${verdictOf.done ? "yes" : "no"} · ${row.asks} asks · ${run.seconds}s`);
  return row;
}

/** The zoo server a worker needs, when its tasks have any zoo task. */
export const needsZoo = (tasks: readonly AnyTask[]) => tasks.some((t) => t.suite === "zoo");
export type { ZooServer };

// ---------------------------------------------------------------------------------------------
// The per-page, per-twin grid.

const short = (r: TaskRow) => `${r.verdict === "blocked" ? `blocked:${r.blockedBy ?? "?"}` : r.verdict === "not_sure" ? "not-sure" : r.verdict}${r.falsePass ? "!FP" : r.right ? "" : "x"}`;

/**
 * Page × twin, each cell the verdicts of its repeats in order: "x" marks a wrong verdict, "!FP" a
 * false pass. Then each page's right count.
 */
export function formatZooGrid(rows: readonly TaskRow[]): string {
  const zoo = rows.filter((r) => r.suite === "zoo");
  if (!zoo.length) return "";
  const pages = [...new Set(zoo.map((r) => r.widget!))];
  const cell = (p: string, t: Twin) => {
    const rs = zoo.filter((r) => r.widget === p && r.twin === t).sort((a, b) => a.rep - b.rep);
    return rs.length ? `${rs.map(short).join(" ")} (${rs.filter((r) => r.right).length}/${rs.length})` : "-";
  };
  const head = ["page", ...TWINS.map((t) => `${t} (want ${EXPECT[t]})`)];
  const body = pages.map((p) => [p, ...TWINS.map((t) => cell(p, t))]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (c: readonly string[]) => `| ${c.map((x, i) => x.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(head), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...body.map(line)].join("\n") + "\n";
}
