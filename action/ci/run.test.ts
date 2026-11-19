/** The Action's own decisions: what the event says, the bypass, and what the CLI's environment holds. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cliEnv, eventFacts, inputFrom, withBypass } from "./run.ts";

describe("the triggering event", () => {
  it("reads Vercel's vercel.deployment.ready: address, environment, commit", () => {
    const f = eventFacts({ action: "vercel.deployment.ready", client_payload: { url: "shop-abc123-acme.vercel.app", environment: "preview", git: { sha: "a".repeat(40), shortSha: "aaaaaaa" } } });
    assert.deepEqual(f, { url: "https://shop-abc123-acme.vercel.app", environment: "preview", sha: "a".repeat(40) });
  });

  it("reads a pull request: its number and head commit (not the merge commit GITHUB_SHA names)", () => {
    assert.deepEqual(eventFacts({ pull_request: { number: 7, head: { sha: "b".repeat(40) } } }), { pr: 7, sha: "b".repeat(40) });
    assert.deepEqual(eventFacts(undefined), {});
    assert.deepEqual(eventFacts({ client_payload: { url: 5 } }), {});
  });
});

describe("the bypass secret", () => {
  it("goes on the address the way Vercel reads it, keeping what was there", () => {
    const u = new URL(withBypass("https://p.vercel.app/a?b=1", "s3cret"));
    assert.equal(u.searchParams.get("x-vercel-protection-bypass"), "s3cret");
    assert.equal(u.searchParams.get("x-vercel-set-bypass-cookie"), "true");
    assert.equal(u.searchParams.get("b"), "1");
    assert.equal(withBypass("https://p.vercel.app/", ""), "https://p.vercel.app/");
  });
});

describe("the CLI's environment", () => {
  const env = {
    PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "t", GH_TOKEN: "t", ACTIONS_RUNTIME_TOKEN: "t", INPUT_GITHUB_TOKEN: "t", INPUT_ANTHROPIC_API_KEY: "k",
    INPUT_VERCEL_BYPASS_SECRET: "b", CONTEXTMACHINES_GITHUB_TOKEN: "t", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CM_VAR_EMAIL: "e", CONTEXTMACHINES_VAR_X: "x", GITHUB_REPOSITORY: "a/b",
  };
  it("the replay pass gets no GitHub credential, no input and no AI key; test values (CM_VAR_) stay", () => {
    const e = cliEnv(env);
    assert.deepEqual(Object.keys(e).sort(), ["CM_VAR_EMAIL", "CONTEXTMACHINES_VAR_X", "GITHUB_REPOSITORY", "HOME", "PATH"]);
  });
  it("the AI pass gets the AI key as ANTHROPIC_API_KEY, and still no GitHub credential", () => {
    const e = cliEnv(env, { key: "sk-x" });
    assert.equal(e.ANTHROPIC_API_KEY, "sk-x");
    assert.equal(e.GITHUB_TOKEN, undefined);
    assert.equal(e.INPUT_GITHUB_TOKEN, undefined);
    assert.equal(e.OPENAI_API_KEY, undefined);
  });
  it("inputs come from INPUT_ or CONTEXTMACHINES_, trimmed", () => {
    const input = inputFrom({ INPUT_TESTS_DIR: " x ", CONTEXTMACHINES_GREP: "y", URL: "z" });
    assert.equal(input("tests-dir"), "x");
    assert.equal(input("grep"), "y");
    assert.equal(input("url"), "");
  });
});

describe("action.yml and run.ts agree", () => {
  it("every input is passed as INPUT_<NAME> and read by run.ts, and nothing else is", async () => {
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(new URL("./action.yml", import.meta.url), "utf8");
    const src = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    const inputs = [...yml.slice(yml.indexOf("\ninputs:"), yml.indexOf("\noutputs:")).matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]!);
    const passed = [...yml.matchAll(/^ {8}INPUT_([A-Z_]+): \$\{\{ inputs\.([a-z-]+) \}\}$/gm)].map((m) => [m[1]!, m[2]!] as const);
    const read = new Set([...src.matchAll(/input\("([a-z-]+)"\)/g)].map((m) => m[1]!));
    // "artifact" is the upload step's own.
    assert.deepEqual(inputs.filter((i) => i !== "artifact").sort(), passed.map(([, i]) => i).sort());
    for (const [env, name] of passed) assert.equal(env, name.toUpperCase().replace(/-/g, "_"));
    // work-dir is for running it locally (CONTEXTMACHINES_WORK_DIR); the Action uses the runner's temp folder.
    read.delete("work-dir");
    assert.deepEqual([...read].sort(), passed.map(([, i]) => i).sort());
    const outputs = [...yml.matchAll(/steps\.run\.outputs\.([a-z-]+)/g)].map((m) => m[1]!);
    for (const o of outputs) assert.match(src, new RegExp(`output\\(\`${o}=`), o);
  });
});
