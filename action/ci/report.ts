/**
 * What a CI run of the saved tests says, from the CLI's own data: the suite JSON that
 * `contextmachines test --json` prints, and each run's result.json beside its report. From those,
 * the job summary and the pull request comment (markdown) and JUnit XML.
 *
 * Only Node's own modules: the Action runs from a bare checkout of itself. Everything in here is
 * pure, so the tests feed it a real run's files (fixtures/).
 *
 * Site text is untrusted. It lands in a comment in the reviewer's own repository, where "@team"
 * pings, "#12" links an issue and "<details>" reshapes the page, so all of it goes through cell() or
 * code(). Addresses and error text go through redact() first: a preview's bypass token must never
 * reach a comment (GitHub masks secrets in logs only). cell, code and redact are copies of the ones in
 * action/run.ts (report.test.ts checks they agree), kept here so this folder imports nothing else.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// The CLI's data. Fields this code doesn't know are ignored.
// ---------------------------------------------------------------------------------------------

export type Verdict = "pass" | "fail" | "blocked" | "not_sure" | "couldnt_run" | "not_run";

export interface SuiteTest {
  name: string;
  host: string;
  file?: string;
  ms?: number;
  verdict: Verdict | string;
  url?: string;
  passed?: number;
  steps?: number;
  healed?: number;
  draft?: boolean;
  friction?: unknown[];
  report?: string;
  error?: string;
  why?: string;
}

export interface SuiteJson {
  ok: boolean;
  exit: number;
  summary?: { tests: number; passed: number; failed: number; notSure: number; blocked: number; couldNot: number; notRun?: number; healed?: number; weak?: number };
  ms?: number;
  ai?: { asks?: number; tokens?: number } | null;
  tests?: SuiteTest[];
  error?: string;
}

export interface RunCheck {
  kind: string;
  text?: string;
  role?: string;
  name?: string;
  url?: string;
  left?: string;
}

export interface RunStep {
  n: number;
  title: string;
  check: RunCheck;
  verdict: "passed" | "failed" | "blocked" | "not_sure" | "skipped" | string;
  reason?: string;
  evidence?: { expected: string; found: string };
  replayed?: boolean;
  healed?: { from: string[]; to: string[] };
  weak?: string;
}

/** A run's result.json (the engine's TestResult, as writeRun keeps it). */
export interface RunResult {
  goal: string;
  url: string;
  verdict: string;
  steps: RunStep[];
  passed: number;
  ms: number;
  stopped?: string;
  friction?: { step: number; says: string }[];
}

/** A test's id in a suite: its host folder and name ("localhost-3000/open-the-docs"), as --grep matches it. Names repeat across hosts. */
export const idOf = (t: Pick<SuiteTest, "host" | "name">) => `${t.host}/${t.name}`;

/** Each test's result.json, read from beside its report, by test id. A missing one is left out. */
export function loadRuns(suite: SuiteJson, baseDir: string): Map<string, RunResult> {
  const runs = new Map<string, RunResult>();
  for (const t of suite.tests ?? []) {
    if (!t.report) continue;
    const file = join(dirname(resolve(baseDir, t.report)), "result.json");
    if (!existsSync(file)) continue;
    try {
      runs.set(idOf(t), JSON.parse(readFileSync(file, "utf8")) as RunResult);
    } catch {
      // unreadable: the suite line still says the verdict
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Two passes, one result. The first replays with no AI; the second, only for the tests that need an
// AI, runs those again with one. The second pass's verdict replaces the first's for those tests.
// ---------------------------------------------------------------------------------------------

/** The engine's words for a step that only an AI could do (run.ts): a draft's, or a saved element that has gone. */
const NEEDS_AI = [/no AI to find another way/, /there's no AI to do it/];
/** A test moved to another address isn't healed by today's engine: an AI pass there would only cost. */
const NOT_HEALED_HERE = /isn't healed/;

/**
 * The tests worth a second pass with an AI: "not sure" only because there was no AI. Nothing when the
 * Action has no AI key or was told never to use one. A test that failed is never re-run with an AI:
 * a failed check is the answer, and an AI must not get a second try at it.
 */
export function needsAi(suite: SuiteJson, runs: Map<string, RunResult>, o: { hasKey: boolean; ai: "auto" | "never" | "always" }): string[] {
  if (!o.hasKey || o.ai === "never") return [];
  return (suite.tests ?? [])
    .filter((t) => t.verdict === "not_sure")
    .filter((t) => {
      const run = runs.get(idOf(t));
      // No result.json to read: the suite's own line says not sure, so it may need one.
      if (!run) return true;
      const unsure = run.steps.filter((s) => s.verdict === "not_sure");
      return unsure.some((s) => NEEDS_AI.some((re) => re.test(s.reason ?? ""))) && !unsure.some((s) => NOT_HEALED_HERE.test(s.reason ?? ""));
    })
    .map(idOf);
}

/** The first pass, with the tests the second pass ran replaced by its results, and the counts redone. */
export function mergeSuites(first: SuiteJson, second: SuiteJson | undefined): SuiteJson {
  if (!second?.tests?.length) return first;
  const again = new Map(second.tests.map((t) => [idOf(t), t]));
  const tests = (first.tests ?? []).map((t) => again.get(idOf(t)) ?? t);
  const count = (v: string) => tests.filter((t) => t.verdict === v).length;
  const notRun = count("not_run");
  const summary = {
    tests: tests.length,
    passed: count("pass"),
    failed: count("fail"),
    notSure: count("not_sure"),
    blocked: count("blocked"),
    couldNot: count("couldnt_run"),
    ...(notRun ? { notRun } : {}),
    healed: tests.filter((t) => t.healed).length,
    weak: first.summary?.weak ?? 0,
  };
  const exit = suiteExit(tests);
  const ai = second.ai ?? first.ai ?? null;
  return { ok: exit === 0, exit, summary, ms: (first.ms ?? 0) + (second.ms ?? 0), ai, tests };
}

/** The CLI's suite exit (test-command.ts suiteExit): fail beats not sure beats couldn't run. */
export function suiteExit(tests: readonly SuiteTest[]): number {
  if (!tests.length) return 2;
  if (tests.some((t) => t.verdict === "fail")) return 1;
  if (tests.some((t) => t.verdict === "not_sure" || t.verdict === "not_run")) return 4;
  if (tests.some((t) => t.verdict === "blocked" || t.verdict === "couldnt_run")) return 3;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Site text in markdown (copies of action/run.ts: report.test.ts checks they agree).
// ---------------------------------------------------------------------------------------------

const LIVE_WORD = /@[A-Za-z0-9]|#\d|\bGH-\d|:\/\/|\bwww\./i;
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

function oneLine(text: string, max: number): string {
  const flat = String(text).replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

/** Site text as plain words in markdown: nothing in it pings, links, or formats. */
export function cell(text: string, max = 300): string {
  return oneLine(text, max)
    .split(/( )/)
    .map((word) => (word === " " || word === "" ? word : LIVE_WORD.test(word) ? codeSpan(word) : plainWord(word)))
    .join("");
}

/** Site text as code: shown exactly, never a ping or a link. */
export function code(text: string, max = 300): string {
  return codeSpan(oneLine(text, max));
}

function plainWord(word: string): string {
  return word.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]()#!|~=+-]/g, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2");
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const SECRET_NAME = /(^|[-_.])(access|api|apikey|auth|bypass|code|credential|credentials|jwt|key|nonce|otp|pass|passwd|password|pwd|secret|session|sessionid|sid|sig|signature|state|ticket|token)s?($|[-_.])|token|secret|password|apikey|signature|credential/i;
const SWITCH = /^(true|false|yes|no|on|off|[01])$/i;
const TOKEN_LIKE = /^(?=.*\d)(?=.*[a-z])[\w~+/=%.-]{20,}$/i;
const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{12,}$/;
const SECRET_LABEL = /(?<![\w-])([\w.-]*(?:password|passwd|pwd|passphrase|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|credential)[\w.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>()]+)/gi;
const NOT_A_SECRET = /^["']?(true|false|yes|no|on|off|[01]|undefined|null|none|nil|empty|missing|required|invalid|expired|incorrect|wrong|unknown|reset|must|is|was|not|cannot|should|your|the|an?|for|REDACTED)["']?$/i;
const KNOWN_KEY = /\b(?:(?:sk|rk)[-_](?:live|test|proj|ant)[-_][\w-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|A(?:KI|SI)A[0-9A-Z]{16}|AIza[\w-]{30,}|npm_[A-Za-z0-9]{30,})\b/g;
const LONG_HEX = /(?<![\w.-])[0-9a-f]{32,}(?![\w-]|\.\w)/gi;
const OPAQUE_RUN = /(?<![\w.-])(?!(?=[\w-]{24,39}(?![\w-]))[\w-]*(?:[A-Z][a-z]{3,}[\w-]*){3})(?:(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d]{24,}|(?=[\w-]*?[A-Za-z\d]{10})(?=[\w-]*?[A-Za-z]\d+(?=[A-Za-z])[\w-]*?[A-Za-z]\d+[A-Za-z])[\w-]{24,})(?![\w-]|\.\w)/g;

/** Text without what would let someone else in (the CLI's redact, as action/run.ts copies it). */
export function redact(text: string): string {
  return String(text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]+@/gi, "$1")
    .replace(/([?&#;][^=&#\s"'<>()]{1,80}=)([^&#\s"'<>()]+)/g, (all, name: string, value: string) => ((SECRET_NAME.test(name.slice(1, -1)) && !SWITCH.test(value)) || TOKEN_LIKE.test(value) ? `${name}REDACTED` : all))
    .replace(/(\bhttps?:\/\/[^/\s?#"'<>()]+)(\/[^\s?#"'<>()]*)/gi, (_all, host: string, path: string) => `${host}${path.split("/").map((part) => (OPAQUE_SEGMENT.test(part) ? ":id" : part)).join("/")}`)
    .replace(/\b((?:proxy-)?authorization|x-api-key)(["']?\s*[=:]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"'<>()]+/gi, "$1$2REDACTED")
    .replace(/\b([Bb]earer|BEARER|[Bb]asic|BASIC)\s+(?=\S*(?:\d|[a-z][A-Z]|=))[A-Za-z0-9._~+/=-]{8,}/g, "$1 REDACTED")
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, "REDACTED")
    .replace(SECRET_LABEL, (all, name: string, joint: string, value: string) => (NOT_A_SECRET.test(value) ? all : `${name}${joint}REDACTED`))
    .replace(KNOWN_KEY, "REDACTED")
    .replace(LONG_HEX, "REDACTED")
    .replace(OPAQUE_RUN, "REDACTED");
}

// ---------------------------------------------------------------------------------------------
// Markdown: the job summary and the comment.
// ---------------------------------------------------------------------------------------------

/** GitHub refuses a comment over 65,536 characters; this leaves room for the marker. */
export const MAX_COMMENT = 60_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const VERDICT_WORDS: Record<string, string> = { pass: "✅ pass", fail: "❌ fail", blocked: "⛔ blocked", not_sure: "❔ not sure", couldnt_run: "⚠️ couldn't run", not_run: "– not run" };

/** What a step's check expected, in words (check.ts expected(), for the kinds a summary shows). */
export function expectedOf(check: RunCheck): string {
  switch (check.kind) {
    case "text_visible":
      return `the page shows "${check.text ?? ""}"`;
    case "url_contains":
      return `the address contains "${check.text ?? ""}"`;
    case "title_contains":
      return `the title contains "${check.text ?? ""}"`;
    case "element_visible":
      return `a ${check.role ?? "element"}${check.name ? ` named "${check.name}"` : ""} is visible`;
    case "password_gone":
      return "the sign-in form is gone";
    case "signed_in":
      return "signed in";
    case "none":
      return "nothing to measure (a step on the way)";
    default:
      return check.kind;
  }
}

export interface Context {
  /** Which deployment: "preview", "production", or the job's own words. */
  environment?: string;
  /** The address the tests ran on (shown redacted). */
  url?: string;
  /** The commit tested, shown short. */
  sha?: string;
  /** The workflow run, where the artifact is. */
  runUrl?: string;
  /** Whether an AI was asked in this run (and for how many tests). */
  aiTests?: number;
  /** The Action's version, or "from source". */
  version?: string;
}

/**
 * The first step that didn't pass, in a line: why the test isn't a pass. Redacted whole: the evidence
 * is site text, and a page that shows its own address ("?token=...") would otherwise put it in a comment.
 */
function firstProblem(t: SuiteTest, run: RunResult | undefined): string {
  return redact(problemOf(t, run));
}

function problemOf(t: SuiteTest, run: RunResult | undefined): string {
  if (t.error) return t.error;
  if (t.why) return t.why;
  const s = run?.steps.find((x) => x.verdict !== "passed" && x.verdict !== "skipped");
  if (!s) return run?.stopped ?? "";
  if (s.evidence) return `step ${s.n} (${s.title}): expected ${s.evidence.expected}, found ${s.evidence.found}`;
  return `step ${s.n} (${s.title}): ${s.reason ?? `expected ${expectedOf(s.check)}`}`;
}

/** The headline: one line a reviewer reads first. */
export function headline(suite: SuiteJson, ctx: Context): string {
  const s = suite.summary;
  const where = ctx.environment ? ` on ${cell(ctx.environment, 40)}` : "";
  if (!s || !suite.tests?.length) return `### ⚠️ Context Machines${where}: the saved tests didn't run`;
  const mark = s.failed ? "🔴" : s.passed === s.tests ? "🟢" : "🟡";
  const counts = [`${s.passed} passed`, `${s.failed} failed`, `${s.notSure} not sure`, ...(s.blocked ? [`${s.blocked} blocked`] : []), ...(s.couldNot ? [`${s.couldNot} couldn't run`] : []), ...(s.notRun ? [`${s.notRun} not run`] : [])];
  return `### ${mark} Context Machines${where}: ${plural(s.tests, "saved test")} · ${counts.join(" · ")}`;
}

/**
 * A code span in a table cell: GitHub splits a table row at every "|" before it reads code spans, so a
 * file named "a| @team |.json" would end the span and ping. "\|" is a "|" inside a table's code span.
 */
export const inTable = (span: string) => span.replace(/\|/g, "\\|");

/** The job summary, or (with `max`) the pull request comment cut to fit. */
export function markdown(suite: SuiteJson, runs: Map<string, RunResult>, ctx: Context, max = Infinity): string {
  const blocks: { text: string; optional?: boolean }[] = [{ text: headline(suite, ctx) }];
  if (!suite.tests?.length) blocks.push({ text: cell(redact(suite.error ?? "the test command printed no result"), 1000) });
  else {
    const rows = suite.tests.map((t) => {
      const notes = [t.healed ? `${plural(t.healed, "step")} healed` : "", t.draft ? "draft" : "", t.friction?.length ? `${plural(t.friction.length, "place")} a user might get stuck` : ""].filter(Boolean).join("; ");
      const steps = t.steps !== undefined ? `${t.passed ?? 0}/${t.steps}` : "";
      return `| ${inTable(code(t.name, 120))} | ${inTable(code(t.host, 80))} | ${VERDICT_WORDS[t.verdict] ?? cell(t.verdict, 40)} | ${steps} | ${notes} |`;
    });
    blocks.push({ text: `| Test | Site | Result | Steps | Notes |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}` });
    // Why each test that didn't pass didn't: what was expected and what was there.
    const problems = suite.tests.filter((t) => t.verdict !== "pass").map((t) => `- ${code(t.name, 120)}: ${cell(firstProblem(t, runs.get(idOf(t))), 400)}`);
    if (problems.length) blocks.push({ text: `<details open><summary>Why ${problems.length === 1 ? "it" : "they"} didn't pass</summary>\n\n${problems.join("\n")}\n\n</details>`, optional: true });
    const healed = suite.tests.filter((t) => t.healed).length;
    if (healed) blocks.push({ text: `${plural(healed, "saved test")} healed: the updated ${healed === 1 ? "file is" : "files are"} in the workflow artifact (tests/). Commit ${healed === 1 ? "it" : "them"}, or ${healed === 1 ? "it heals" : "they heal"} again on every run.` });
  }
  const facts = [
    ctx.url ? `on ${code(redact(ctx.url), 200)}` : "",
    ctx.sha ? `commit ${code(ctx.sha.slice(0, 7), 10)}` : "",
    ctx.aiTests ? `AI asked for ${plural(ctx.aiTests, "test")}` : "replayed with no AI",
    suite.ms !== undefined ? `${Math.round(suite.ms / 100) / 10}s` : "",
    ctx.runUrl ? `[videos and reports](${ctx.runUrl})` : "",
    `Context Machines${ctx.version ? ` ${cell(ctx.version, 30)}` : ""}`,
  ].filter(Boolean);
  blocks.push({ text: `<sub>${facts.join(" · ")}</sub>` });
  const join_ = (bs: typeof blocks) => bs.map((b) => b.text).join("\n\n");
  let body = join_(blocks);
  while (body.length > max && blocks.some((b) => b.optional)) {
    blocks.splice(blocks.map((b) => b.optional).lastIndexOf(true), 1);
    body = join_(blocks);
  }
  // Only a test list a site made enormous could still be over: cut at a line.
  return body.length > max ? `${body.slice(0, body.lastIndexOf("\n", max - 80))}\n\n_Cut short to fit a comment; the rest is in the job summary._` : body;
}

// ---------------------------------------------------------------------------------------------
// JUnit XML: the shape every CI reads. One <testcase> per saved test; a fail is a <failure>, and a
// test that was blocked, not sure, or couldn't run is an <error>: none of them passed.
// ---------------------------------------------------------------------------------------------

const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const x = (s: unknown) => String(s ?? "").replace(INVALID, "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
const secs = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(3);

function stepsText(t: SuiteTest, run: RunResult | undefined): string {
  if (!run) return t.error ? redact(t.error) : t.verdict;
  const mark: Record<string, string> = { passed: "✓", failed: "✗", blocked: "■", not_sure: "?", skipped: "-" };
  const lines = [`${run.goal} · ${redact(run.url)}`];
  for (const s of run.steps) {
    lines.push(`${mark[s.verdict] ?? "?"} ${s.n} ${s.title} (${s.verdict}${s.replayed ? ", replayed" : ""}${s.healed ? ", healed" : ""})`);
    if (s.verdict !== "skipped") lines.push(`    check: ${expectedOf(s.check)}`);
    if (s.evidence) lines.push(`    expected ${s.evidence.expected}`, `    found ${s.evidence.found}`);
    else if (s.reason && s.verdict !== "passed") lines.push(`    ${s.reason}`);
  }
  return redact(lines.join("\n"));
}

export function junit(suite: SuiteJson, runs: Map<string, RunResult>): string {
  const tests = (suite.tests ?? []).filter((t) => t.verdict !== "not_run");
  const failures = tests.filter((t) => t.verdict === "fail").length;
  const errors = tests.filter((t) => t.verdict !== "fail" && t.verdict !== "pass").length;
  const total = secs(suite.ms);
  const cases = tests.map((t) => {
    const run = runs.get(idOf(t));
    const open = `  <testcase name="${x(t.name)}" classname="${x(t.host)}" time="${secs(t.ms)}">`;
    const msg = x(firstProblem(t, run).slice(0, 500));
    const said = t.verdict === "pass" ? "" : t.verdict === "fail" ? `\n    <failure type="fail" message="${msg}"/>` : `\n    <error type="${x(t.verdict)}" message="${msg}"/>`;
    return `${open}${said}\n    <system-out>${x(stepsText(t, run))}</system-out>\n  </testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="contextmachines test" tests="${tests.length}" failures="${failures}" errors="${errors}" time="${total}">
 <testsuite name="contextmachines" tests="${tests.length}" failures="${failures}" errors="${errors}" skipped="0" time="${total}">
${cases.join("\n")}
 </testsuite>
</testsuites>
`;
}

// ---------------------------------------------------------------------------------------------
// The commit status: what a Vercel Deployment Check (or a branch rule) waits on.
// ---------------------------------------------------------------------------------------------

export type StatusState = "pending" | "success" | "failure" | "error";

/** The state and its one line (GitHub keeps 140 characters) for a finished suite. */
export function statusOf(suite: SuiteJson): { state: StatusState; description: string } {
  const s = suite.summary;
  if (!s || !suite.tests?.length) return { state: "error", description: "The saved tests didn't run" };
  const counts = `${s.passed}/${s.tests} passed${s.failed ? `, ${s.failed} failed` : ""}${s.notSure ? `, ${s.notSure} not sure` : ""}${s.blocked ? `, ${s.blocked} blocked` : ""}${s.couldNot ? `, ${s.couldNot} couldn't run` : ""}`;
  // Only every test passing is a success: a deployment check must never go green on "not sure".
  // A result saying exit 0 while a test didn't pass is not a success either.
  const allPassed = suite.tests.every((t) => t.verdict === "pass");
  const failed = suite.exit === 1 || (suite.exit === 0 && suite.tests.some((t) => t.verdict === "fail"));
  const state: StatusState = suite.exit === 0 && allPassed ? "success" : failed ? "failure" : "error";
  return { state, description: counts.slice(0, 140) };
}
