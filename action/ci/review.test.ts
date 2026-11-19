/**
 * Tests for what the review found (STATUS.md, Review): each one failed before its fix. Run.ts runs
 * with the stand-in CLI (fake-cli.ts) and a fake GitHub on port 0. No browser, no AI, no real GitHub.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { markdown, statusOf, junit, type SuiteJson, type RunResult } from "./report.ts";
import { asAddress, grepPicks, parseSuite, scrubber } from "./run.ts";

const HERE = import.meta.dirname;
const TOKEN = "ghs_reviewtokenreviewtokenreview0001";
const REPO = "acme/shop";
const SHA = "1".repeat(40);
let fake: FakeGitHub;

before(async () => {
  fake = await startFakeGitHub({ token: TOKEN, repo: REPO });
  fake.pulls.set(SHA, [{ number: 21, state: "open", head: { sha: SHA } }]);
});
after(async () => {
  await fake.close();
});

function allText(dir: string): string {
  let text = "";
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) text += allText(p);
    else text += readFileSync(p, "utf8");
  }
  return text;
}

/** run.ts with the stand-in CLI, async (the fake GitHub lives in this process). */
function run(inputs: Record<string, string>, o: { summaryIsDir?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cm-ci-review-"));
  const tests = join(root, "repo", "contextmachines", "tests", "shop.example");
  mkdirSync(tests, { recursive: true });
  for (const name of ["ok", "broken", "renamed"]) writeFileSync(join(tests, `${name}.json`), JSON.stringify({ goal: name }));
  const log = join(root, "cli.log");
  writeFileSync(log, "");
  const summary = join(root, "summary.md");
  if (o.summaryIsDir) mkdirSync(summary);
  const event = join(root, "event.json");
  writeFileSync(event, JSON.stringify({ action: "vercel.deployment.ready", client_payload: { environment: "preview", url: "shop-abc123-acme.vercel.app", git: { sha: SHA } } }));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|INPUT_|CONTEXTMACHINES_|RUNNER_|ACTIONS_|FAKE_CLI_)|_API_KEY$/.test(k)));
  const env = {
    ...base, FAKE_CLI_LOG: log, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: fake.api, GITHUB_EVENT_PATH: event, GITHUB_WORKSPACE: join(root, "repo"), RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: join(root, "out.txt"), INPUT_CLI: join(HERE, "fake-cli.ts"), INPUT_GITHUB_TOKEN: TOKEN, ...inputs,
  };
  const before = fake.statuses.length;
  return new Promise<{ exit: number | null; stdout: string; calls: { args: string[] }[]; statuses: string[]; root: string; summary: string; comment: string }>((done) => {
    const child = spawn(process.execPath, [join(HERE, "run.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    child.on("close", (exit) => {
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[] });
      const s = o.summaryIsDir ? "" : (() => { try { return readFileSync(summary, "utf8"); } catch { return ""; } })();
      done({ exit, stdout, calls, statuses: fake.statuses.slice(before).map((x) => x.state), root, summary: s, comment: (fake.comments.get(21) ?? []).map((c) => c.body).join("\n") });
    });
  });
}

describe("review: the address", () => {
  it("a url input with no scheme (Vercel's payload url, passed on by the workflow template) is run as https", async () => {
    assert.equal(asAddress("shop-abc.vercel.app"), "https://shop-abc.vercel.app");
    assert.equal(asAddress("http://localhost:3000"), "http://localhost:3000");
    const r = await run({ INPUT_URL: "shop-abc123-acme.vercel.app", INPUT_COMMENT: "false" });
    assert.notEqual(r.exit, 2, r.stdout);
    const args = r.calls[0]!.args;
    assert.equal(args[args.indexOf("--url") + 1], "https://shop-abc123-acme.vercel.app");
  });
});

describe("review: never a pass, and never left pending, on a result that isn't one", () => {
  it("a CLI that prints null: the job fails and the status is error, not stuck on pending", async () => {
    const r = await run({ FAKE_CLI_PRINT: "null", INPUT_COMMENT: "false" });
    assert.notEqual(r.exit, 0, r.stdout);
    assert.deepEqual(r.statuses, ["pending", "error"]);
    assert.equal(parseSuite("[1]", 0).exit, 1);
    assert.equal(parseSuite('{"ok":true}', 0).exit, 1);
  });

  it("a result saying exit 0 with no tests: the job fails, the status is error", async () => {
    const r = await run({ FAKE_CLI_PRINT: JSON.stringify({ ok: true, exit: 0, tests: [] }), INPUT_COMMENT: "false" });
    assert.notEqual(r.exit, 0);
    assert.deepEqual(r.statuses, ["pending", "error"]);
  });

  it("a result saying exit 0 while a test is not sure: not a success", async () => {
    const said = { ok: true, exit: 0, summary: { tests: 1, passed: 0, failed: 0, notSure: 1, blocked: 0, couldNot: 0 }, tests: [{ name: "t", host: "h", verdict: "not_sure" }] };
    const r = await run({ FAKE_CLI_PRINT: JSON.stringify(said), INPUT_COMMENT: "false" });
    assert.notEqual(r.exit, 0);
    assert.deepEqual(r.statuses, ["pending", "error"]);
    assert.equal(statusOf(said as SuiteJson).state, "error");
  });

  it("run.ts breaking after the pending status still sets an error status", async () => {
    const r = await run({ INPUT_COMMENT: "false" }, { summaryIsDir: true });
    assert.equal(r.exit, 1, r.stdout);
    assert.deepEqual(r.statuses, ["pending", "error"]);
    assert.match(r.stdout, /Context Machines broke/);
  });
});

describe("review: secrets a page shows", () => {
  it("a short bypass secret a page prints as bare text reaches no comment, summary, JUnit or artifact file", async () => {
    const secret = "pw-12345";
    const r = await run({ INPUT_VERCEL_BYPASS_SECRET: secret, FAKE_CLI_ECHO: "1" });
    // The stand-in CLI did put it in its result.json (as a real page could).
    assert.ok(r.calls.length >= 1);
    assert.match(r.comment, /Your code is REDACTED/, r.comment);
    const shown = r.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
    const work = join(r.root, "contextmachines-test");
    for (const [where, text] of [["comment", r.comment], ["summary", r.summary], ["stdout", shown], ["work dir", allText(work)]] as const) assert.ok(!text.includes(secret), `the secret is in the ${where}`);
  });

  it("scrubber takes out every given value, longest first, and ignores empty ones", () => {
    const s = scrubber(["", "abcd", "abcdef"]);
    assert.equal(s("x abcdef y abcd"), "x REDACTED y REDACTED");
  });
});

describe("review: site text in the comment and JUnit", () => {
  const suite: SuiteJson = { ok: false, exit: 1, summary: { tests: 1, passed: 0, failed: 1, notSure: 0, blocked: 0, couldNot: 0 }, tests: [{ name: "a| @team |b", host: "h", verdict: "fail", report: "r/report.html" }] };
  const runs = new Map<string, RunResult>([["h/a| @team |b", { goal: "g", url: "https://h/", verdict: "fail", passed: 0, ms: 1, steps: [{ n: 1, title: "t", check: { kind: "text_visible", text: "x" }, verdict: "failed", evidence: { expected: "x", found: "the page shows https://h/p?token=abcdef123456&session=zz9" } }] }]]);

  it("a test name with a | can't end its code span in the table and ping", () => {
    const md = markdown(suite, runs, {});
    const row = md.split("\n").find((l) => l.startsWith("| `a"))!;
    assert.ok(row.includes("`a\\| @team \\|b`"), row);
  });

  it("evidence is redacted: a query token a page shows doesn't reach the comment or the JUnit", () => {
    const md = markdown(suite, runs, {});
    const xml = junit(suite, runs);
    for (const text of [md, xml]) {
      assert.ok(!text.includes("abcdef123456"), text);
      assert.ok(!text.includes("zz9"), text);
    }
  });
});

describe("review: --grep picks like the CLI", () => {
  it("'<host>/<name>.json' picks that file alone; a bare '<host>/<name>' also picks a longer name", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-ci-grep-"));
    mkdirSync(join(dir, "shop"));
    for (const n of ["login", "login-old"]) writeFileSync(join(dir, "shop", `${n}.json`), JSON.stringify({ goal: n }));
    assert.equal(grepPicks(dir, "shop/login.json").length, 1);
    assert.equal(grepPicks(dir, "shop/login").length, 2);
    assert.equal(grepPicks(dir, "SHOP/LOGIN-OLD.JSON").length, 1);
  });
});
