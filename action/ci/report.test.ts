/**
 * Summary, comment and JUnit from a real run's files: fixtures/suite.json is what
 * `contextmachines test --json --ai none` printed on cli/bench/site.ts (three saved tests on a
 * live port, and the same three left over from a port that had closed), and fixtures/cm/runs/ holds
 * each run's result.json. fixtures/cli-junit.xml is the CLI's own JUnit from that run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as action from "../run.ts";
import { cell, code, idOf, junit, loadRuns, markdown, MAX_COMMENT, mergeSuites, needsAi, redact, statusOf, suiteExit, type SuiteJson } from "./report.ts";

const FIX = join(import.meta.dirname, "fixtures");
const suite = JSON.parse(readFileSync(join(FIX, "suite.json"), "utf8")) as SuiteJson;
const runs = loadRuns(suite, FIX);
const live = suite.tests!.find((t) => t.verdict === "pass")!.host;

describe("from a real run's report JSON", () => {
  it("reads each run's result.json by host and name", () => {
    assert.equal(suite.tests!.length, 6);
    assert.equal(runs.size, 3);
    assert.equal(runs.get(`${live}/pricing-shows-plans`)!.verdict, "fail");
    assert.equal(runs.get(`${live}/open-the-documentation`)!.verdict, "not_sure");
  });

  it("writes JUnit with the CLI's counts: 1 failure, 4 errors (1 not sure, 3 couldn't run)", () => {
    const xml = junit(suite, runs);
    const head = /<testsuites name="contextmachines test" tests="(\d+)" failures="(\d+)" errors="(\d+)"/;
    const ours = head.exec(xml)!.slice(1);
    const cli = head.exec(readFileSync(join(FIX, "cli-junit.xml"), "utf8"))!.slice(1);
    assert.deepEqual(ours, ["6", "1", "4"]);
    assert.deepEqual(ours, cli);
    assert.match(xml, /<testcase name="pricing-shows-plans" classname="localhost-\d+" time="[\d.]+">\n {4}<failure type="fail" message="step 1 \(pricing shows the plans\): expected the page shows &quot;Pricing plans&quot;, found the page shows &quot;Home Pricing&quot;"\/>/);
    assert.match(xml, /<testcase name="open-the-documentation"[^>]*>\n {4}<error type="not_sure" message="step 1 \(open the documentation\): can&apos;t find Clicking on &apos;Documentation&apos; link; no AI/);
    assert.match(xml, /<error type="couldnt_run" message="nothing is answering at localhost:\d+: is the app running\?"\/>/);
    assert.match(xml, /✓ 1 open the about page \(passed, replayed\)\n {4}check: the address contains &quot;\/about&quot;/);
    // Well formed enough for any CI: every testcase closed, nothing unescaped.
    assert.equal((xml.match(/<testcase /g) ?? []).length, (xml.match(/<\/testcase>/g) ?? []).length);
  });

  it("writes the job summary: headline, one row a test, why each didn't pass", () => {
    const md = markdown(suite, runs, { environment: "preview", url: "https://shop-git-fix-acme.vercel.app/?x-vercel-protection-bypass=s3cr3tbypassvalue12345678", sha: "0123456789abcdef0123456789abcdef01234567", runUrl: "https://github.com/acme/shop/actions/runs/9#artifacts", aiTests: 0, version: "0.2.0" });
    assert.match(md, /^### 🔴 Context Machines on preview: 6 saved tests · 1 passed · 1 failed · 1 not sure · 3 couldn't run/);
    assert.match(md, /\| `pricing-shows-plans` \| `localhost-\d+` \| ❌ fail \| 0\/1 \|/);
    assert.match(md, /\| `open-the-about-page` \| `localhost-\d+` \| ✅ pass \| 1\/1 \|/);
    assert.match(md, /expected the page shows "Pricing plans", found the page shows "Home Pricing"/);
    assert.match(md, /commit `0123456`/);
    assert.match(md, /replayed with no AI/);
    // The bypass secret never reaches the summary.
    assert.doesNotMatch(md, /s3cr3tbypass/);
    assert.match(md, /x-vercel-protection-bypass=REDACTED/);
  });

  it("the status a Deployment Check reads: only all-pass is success", () => {
    assert.deepEqual(statusOf(suite), { state: "failure", description: "1/6 passed, 1 failed, 1 not sure, 3 couldn't run" });
    const passing = { ...suite, exit: 0, ok: true, summary: { tests: 1, passed: 1, failed: 0, notSure: 0, blocked: 0, couldNot: 0 }, tests: suite.tests!.filter((t) => t.verdict === "pass") };
    assert.equal(statusOf(passing).state, "success");
    const unsure = { ...suite, exit: 4, summary: { tests: 1, passed: 0, failed: 0, notSure: 1, blocked: 0, couldNot: 0 } };
    assert.equal(statusOf(unsure).state, "error");
    assert.equal(statusOf({ ok: false, exit: 2, error: "no tests" }).state, "error");
  });
});

describe("AI only when needed", () => {
  it("plans a second pass only for tests not sure for want of an AI, and only with a key", () => {
    assert.deepEqual(needsAi(suite, runs, { hasKey: true, ai: "auto" }), [`${live}/open-the-documentation`]);
    assert.deepEqual(needsAi(suite, runs, { hasKey: false, ai: "auto" }), []);
    assert.deepEqual(needsAi(suite, runs, { hasKey: true, ai: "never" }), []);
  });

  it("never re-runs a failed test, nor one today's engine won't heal on another address", () => {
    const moved = new Map(runs);
    const doc = structuredClone(moved.get(`${live}/open-the-documentation`)!);
    doc.steps[0]!.reason = "can't find a saved element; a test run on another address (--url) isn't healed";
    moved.set(`${live}/open-the-documentation`, doc);
    assert.deepEqual(needsAi(suite, moved, { hasKey: true, ai: "auto" }), []);
    assert.ok(!needsAi(suite, runs, { hasKey: true, ai: "auto" }).some((id) => id.endsWith("pricing-shows-plans")));
  });

  it("merges the AI pass over the replay: that test's verdict replaced, counts and exit redone", () => {
    const fixed = { ...suite.tests!.find((t) => t.verdict === "not_sure")!, verdict: "pass", passed: 1, healed: 1 };
    const merged = mergeSuites(suite, { ok: true, exit: 0, ms: 4000, ai: { asks: 2 }, tests: [fixed] });
    assert.equal(merged.tests!.length, 6);
    assert.deepEqual({ ...merged.summary }, { tests: 6, passed: 2, failed: 1, notSure: 0, blocked: 0, couldNot: 3, healed: 1, weak: 0 });
    assert.equal(merged.exit, 1);
    assert.equal(merged.ms, (suite.ms ?? 0) + 4000);
    assert.equal(mergeSuites(suite, undefined), suite);
    assert.equal(idOf(fixed), `${live}/open-the-documentation`);
  });

  it("the exit is the CLI's: fail beats not sure beats couldn't run", () => {
    const t = (verdict: string) => ({ name: "t", host: "h", verdict });
    assert.equal(suiteExit([t("pass")]), 0);
    assert.equal(suiteExit([t("pass"), t("not_sure")]), 4);
    assert.equal(suiteExit([t("couldnt_run"), t("pass")]), 3);
    assert.equal(suiteExit([t("not_sure"), t("fail")]), 1);
    assert.equal(suiteExit([]), 2);
  });
});

describe("site text is untrusted", () => {
  const hostile = structuredClone(suite);
  const runs2 = new Map(runs);
  const bad = structuredClone(runs2.get(`${live}/pricing-shows-plans`)!);
  bad.steps[0]!.evidence = { expected: "the page shows \"Pricing plans\"", found: "the page shows \"@everyone see #12 <details><summary>x</summary> https://evil.example **bold** ‮gnp.exe\"" };
  runs2.set(`${live}/pricing-shows-plans`, bad);

  it("nothing from the site pings, links an issue, opens a tag or reorders text in the comment", () => {
    const md = markdown(hostile, runs2, { environment: "preview" }, MAX_COMMENT);
    assert.match(md, /`"@everyone`/);
    assert.doesNotMatch(md, /[^`"]@everyone/);
    assert.match(md, /`#12`/);
    assert.match(md, /`https:\/\/evil.example`/);
    assert.doesNotMatch(md, /<details><summary>x/);
    assert.match(md, /\\\*\\\*bold\\\*\\\*/);
    assert.ok(!md.includes("‮"));
  });

  it("a comment too long for GitHub is cut to fit, keeping the headline and table", () => {
    const many = structuredClone(suite);
    many.tests = Array.from({ length: 900 }, (_, i) => ({ ...suite.tests![1]!, name: `t-${i}-${"x".repeat(60)}` }));
    const md = markdown(many, new Map(), {}, MAX_COMMENT);
    assert.ok(md.length <= MAX_COMMENT, String(md.length));
    assert.match(md, /^### /);
  });

  it("cell, code and redact agree with the older Action's (action/run.ts)", () => {
    const samples = [
      "@team look at #4 and GH-5 https://x.y/z www.a.b",
      "a <b>c</b> & d `e` *f* [g](h) | i ~j~ 1. k",
      "‮abc​\u0007 tab\there",
      "https://user:pw@preview.app/a/0123456789abcdef?x-vercel-protection-bypass=abcdefabcdef1234567890&ok=1",
      "token=abc123" + "def456ghi789 Bearer abcdefgh" + "12345678 sk-ant-api03-aaaaaaa" + "aaaaaaaaaaaaaaaaaaaaa ghp_aaaaaaaaaa" + "aaaaaaaaaaaaaaa",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc password: hunter2 password is required",
    ];
    for (const s of samples) {
      assert.equal(cell(s), action.cell(s), s);
      assert.equal(code(s), action.code(s), s);
      assert.equal(redact(s), action.redact(s), s);
    }
  });
});
