/**
 * The Action's two passes, end to end through run.ts, with a stand-in CLI (fake-cli.ts) so no browser
 * or AI is needed: the AI pass runs only for the test that needs it, only with a key, and only that
 * pass sees the key; the merged result is what JUnit, the summary and the status say.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const HERE = import.meta.dirname;

function run(inputs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cm-ci-2pass-"));
  mkdirSync(join(root, "repo", "contextmachines", "tests", "shop.example"), { recursive: true });
  // The files the stand-in CLI reports on, so the AI pass can check its --grep picks one test alone.
  for (const name of ["ok", "broken", "renamed", ...(inputs.FAKE_CLI_EXTRA ? ["renamed-old"] : [])]) writeFileSync(join(root, "repo", "contextmachines", "tests", "shop.example", `${name}.json`), JSON.stringify({ goal: name }));
  const log = join(root, "cli.log");
  writeFileSync(log, "");
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|INPUT_|CONTEXTMACHINES_|RUNNER_|ACTIONS_)|_API_KEY$/.test(k)));
  const r = spawnSync(process.execPath, [join(HERE, "run.ts")], {
    encoding: "utf8",
    env: { ...base, FAKE_CLI_LOG: log, GITHUB_TOKEN: "ghs_shouldneverreachthecli", GITHUB_WORKSPACE: join(root, "repo"), RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary.md"), GITHUB_OUTPUT: join(root, "out.txt"), INPUT_CLI: join(HERE, "fake-cli.ts"), INPUT_COMMENT: "false", ...inputs },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; key: string | null; github: string | null; ran: string[] });
  const outputs = Object.fromEntries(readFileSync(join(root, "out.txt"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { exit: r.status, stdout: r.stdout, calls, outputs, summary: readFileSync(join(root, "summary.md"), "utf8"), junit: readFileSync(outputs.junit!, "utf8") };
}

describe("two passes: AI only when needed", () => {
  it("with a key: one replay with no key, then one AI pass for the not-sure test only, merged", () => {
    const r = run({ INPUT_ANTHROPIC_API_KEY: "sk-ant-fake-key-for-test-0001", INPUT_AI_MAX_TOKENS: "200000" });
    assert.equal(r.calls.length, 2, r.stdout);
    assert.equal(r.calls[1]!.args[r.calls[1]!.args.indexOf("--max-tokens") + 1], "200000", "the AI pass carries its cap");
    assert.ok(r.calls[0]!.args.includes("none") && r.calls[0]!.key === null, "the replay pass has no AI and no key");
    assert.deepEqual(r.calls[1]!.args.slice(r.calls[1]!.args.indexOf("--ai"), r.calls[1]!.args.indexOf("--ai") + 2), ["--ai", "anthropic"]);
    assert.equal(r.calls[1]!.args[r.calls[1]!.args.indexOf("--grep") + 1], "shop.example/renamed.json");
    assert.deepEqual(r.calls[1]!.ran, ["renamed"]);
    assert.equal(r.calls[1]!.key, "sk-ant-fake-key-for-test-0001");
    assert.ok(r.calls.every((c) => c.github === null), "no GitHub token reached the CLI");
    assert.equal(r.exit, 1, "still a fail: the broken test is not re-run");
    assert.equal(r.outputs.passed, "2");
    assert.equal(r.outputs["not-sure"], "0");
    assert.match(r.summary, /AI asked for 1 test/);
    assert.match(r.summary, /1 saved test healed/);
    assert.match(r.junit, /tests="3" failures="1" errors="0"/);
    const shown = r.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
    assert.ok(!`${shown}${r.summary}${r.junit}`.includes("sk-ant-fake-key"), "the key is only ever given to GitHub's mask");
  });

  it("with no key: one replay only, and it says how to let an AI help", () => {
    const r = run({});
    assert.equal(r.calls.length, 1);
    assert.equal(r.exit, 1);
    assert.equal(r.outputs["not-sure"], "1");
    assert.match(r.stdout, /set anthropic-api-key/);
    assert.match(r.summary, /replayed with no AI/);
  });

  it("a key with no ai-max-tokens: one replay only, no key given to the CLI, and it says to set a cap", () => {
    const r = run({ INPUT_ANTHROPIC_API_KEY: "sk-ant-fake-key-for-test-0001" });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.key, null);
    assert.match(r.stdout, /set ai-max-tokens/);
  });

  it("ai: never with a key: one replay only", () => {
    const r = run({ INPUT_ANTHROPIC_API_KEY: "sk-ant-fake-key-for-test-0001", INPUT_AI: "never" });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.key, null);
  });

  it("fail-job false: exit 0, the counts still told", () => {
    const r = run({ INPUT_FAIL_JOB: "false" });
    assert.equal(r.exit, 0);
    assert.equal(r.outputs.state, "failure");
  });

  it("review: a failed test whose name starts like the not-sure one's gets no AI (the --grep picks one file)", () => {
    const r = run({ INPUT_ANTHROPIC_API_KEY: "sk-ant-fake-key-for-test-0001", INPUT_AI_MAX_TOKENS: "200000", FAKE_CLI_EXTRA: "1" });
    assert.equal(r.calls.length, 2, r.stdout);
    assert.deepEqual(r.calls[0]!.ran.sort(), ["broken", "ok", "renamed", "renamed-old"]);
    assert.deepEqual(r.calls[1]!.ran, ["renamed"], "only the not-sure test ran with the AI");
    assert.equal(r.outputs.failed, "2", "renamed-old is still a fail");
    assert.equal(r.exit, 1);
  });
});
