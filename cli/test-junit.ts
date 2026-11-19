/**
 * JUnit XML for `contextmachines test --junit <file>`: the shape every CI reads (GitHub, GitLab,
 * Jenkins, CircleCI). One <testcase> per saved test, its steps in <system-out>. A FAIL is a
 * <failure>; a test that was blocked, not sure, or couldn't run is an <error>: none of them passed.
 * Every word from the site or the AI is escaped, and characters XML can't hold are dropped.
 */
import { expected } from "../packages/scanner/src/tester/check.ts";
import type { TestResult } from "../packages/scanner/src/tester/types.ts";
import { publicUrl } from "./report.ts";

export interface SuiteEntry {
  /** The saved test's name: its file name without .json, or the goal's slug. */
  name: string;
  /** Its host ("localhost-3000"): the class name CI groups by. */
  host: string;
  /** The result, when it ran. */
  result?: TestResult;
  /** Why it couldn't run, when it didn't. */
  couldNot?: string;
  ms: number;
}

// XML 1.0 can't hold most control characters, even escaped.
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const x = (s: unknown) => String(s ?? "").replace(INVALID, "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
const secs = (ms: number) => (ms / 1000).toFixed(3);

/** The steps, as plain lines: what CI shows under the test. */
function stepsText(r: TestResult): string {
  const mark = { passed: "✓", failed: "✗", blocked: "■", not_sure: "?", skipped: "-" } as const;
  // The address as it may be shown: a bypass token in it stays out of a file CI keeps.
  const lines = [`${r.goal} · ${publicUrl(r.url)}`];
  for (const s of r.steps) {
    lines.push(`${mark[s.verdict]} ${s.n} ${s.title} (${s.verdict}${s.judged && s.verdict === "passed" ? ", judged by AI" : ""}${s.replayed ? ", replayed" : ""}${s.healed ? ", healed" : ""})`);
    if (s.verdict !== "skipped") lines.push(`    check: ${expected(s.check)}`);
    if (s.weak && s.verdict === "passed") lines.push(`    note: ${s.weak}`);
    if (s.judged && s.verdict === "passed") lines.push(`    judged by AI, not measured: ${s.judged.reason}`, ...(s.judged.overruled ? [`    ${s.judged.overruled}`] : []));
    if (s.healed) lines.push(`    healed: ${s.healed.from.join(", ")} -> ${s.healed.to.join(", ") || "nothing more was needed"}`);
    if (s.evidence) lines.push(`    expected ${s.evidence.expected}`, `    found ${s.evidence.found}`);
    else if (s.reason && s.verdict !== "passed") lines.push(`    ${s.reason}`);
  }
  for (const f of r.friction ?? []) lines.push(`where a user might get stuck (step ${f.step}): ${f.says}`);
  return lines.join("\n");
}

/** The first step that didn't pass, in one line: the failure's message. */
function firstProblem(r: TestResult): string {
  const s = r.steps.find((t) => t.verdict !== "passed" && t.verdict !== "skipped");
  if (!s) return r.stopped ?? r.verdict;
  return `step ${s.n} (${s.title}) ${s.verdict.replace("_", " ")}: ${s.reason ?? (s.evidence ? `expected ${s.evidence.expected}` : "")}`.slice(0, 500);
}

export function junitXml(entries: readonly SuiteEntry[], totalMs: number): string {
  const failures = entries.filter((e) => e.result?.verdict === "fail").length;
  const errors = entries.filter((e) => !e.result || e.result.verdict === "blocked" || e.result.verdict === "not_sure").length;
  const cases = entries.map((e) => {
    const open = `  <testcase name="${x(e.name)}" classname="${x(e.host)}" time="${secs(e.ms)}">`;
    if (!e.result) return `${open}\n    <error type="couldnt_run" message="${x(e.couldNot ?? "couldn't run")}"/>\n  </testcase>`;
    const r = e.result;
    const said = r.verdict === "pass" ? "" : r.verdict === "fail" ? `\n    <failure type="fail" message="${x(firstProblem(r))}"/>` : `\n    <error type="${r.verdict}" message="${x(firstProblem(r))}"/>`;
    // A pass that was healed, or whose check proves little, is marked where CI shows it, not only in the log.
    const healed = r.steps.filter((t) => t.healed).length;
    const weak = r.steps.filter((t) => t.weak && t.verdict === "passed").length;
    // A pass with a step an AI judged (not measured) is marked too.
    const judged = r.steps.filter((t) => t.judged && t.verdict === "passed").length;
    const props = healed || weak || judged ? `\n    <properties>${healed ? `<property name="healed" value="${healed}"/>` : ""}${weak ? `<property name="weak_checks" value="${weak}"/>` : ""}${judged ? `<property name="judged" value="${judged}"/>` : ""}</properties>` : "";
    const err = [
      ...(healed ? [`healed: ${healed} step${healed === 1 ? "" : "s"} found another way, and the saved test was rewritten: commit it, or it heals again on every run`] : []),
      ...r.steps.filter((t) => t.weak && t.verdict === "passed").map((t) => `step ${t.n} (${t.title}): ${t.weak}`),
    ];
    return `${open}${props}${said}\n    <system-out>${x(stepsText(r))}</system-out>${err.length ? `\n    <system-err>${x(err.join("\n"))}</system-err>` : ""}\n  </testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="contextmachines test" tests="${entries.length}" failures="${failures}" errors="${errors}" time="${secs(totalMs)}">
 <testsuite name="contextmachines" tests="${entries.length}" failures="${failures}" errors="${errors}" skipped="0" time="${secs(totalMs)}">
${cases.join("\n")}
 </testsuite>
</testsuites>
`;
}
