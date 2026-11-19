/**
 * The CI Action's work: run the repository's saved tests (contextmachines/tests/) in a real browser,
 * on a deployment's address when it is given one (every Vercel preview), and tell GitHub how it went.
 *
 *   1. A pending commit status on the tested commit ("contextmachines - preview"), so a Vercel
 *      Deployment Check or a required check waits for it.
 *   2. Every saved test replayed with no AI at all: the AI key isn't even in the CLI's environment.
 *   3. Only the tests that were "not sure" because there was no AI (a draft, or a saved element that
 *      has gone) run again with the AI, and only when a key was given. A failed test is never re-run:
 *      a check that didn't hold is the answer.
 *   4. JUnit XML, the job summary, one comment on the pull request (edited on later runs, never
 *      repeated), outputs, and the final commit status. The job fails unless every test passed.
 *
 * The tests are copied into the work dir first, so the runs, their videos and any healed test land
 * there (and in the artifact), never in the checkout.
 *
 * Inputs come as INPUT_<NAME> from the Action, or CONTEXTMACHINES_<NAME> to run it the same way
 * locally. On Vercel's repository_dispatch (vercel.deployment.ready) the address, environment and
 * commit come from the event when the inputs leave them empty. Only Node's own modules are imported.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marker, pullRequestFor, setStatus, upsertComment, type GitHub } from "./github.ts";
import { idOf, junit, loadRuns, markdown, MAX_COMMENT, mergeSuites, needsAi, redact, statusOf, type Context, type SuiteJson } from "./report.ts";

/** An address as given: Vercel's event (and so a workflow passing it on as `url`) may leave out the scheme. */
export const asAddress = (raw: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);

type Env = Record<string, string | undefined>;

/** Namespaced on purpose: bare names like URL are set by other tools (some hosts set URL to the site). */
export const inputFrom = (env: Env) => (name: string) => {
  const key = name.toUpperCase().replace(/-/g, "_");
  return (env[`INPUT_${key}`] || env[`CONTEXTMACHINES_${key}`] || "").trim();
};

/** What the triggering event says, from GITHUB_EVENT_PATH: a pull request, or Vercel's deployment event. */
export interface EventFacts {
  pr?: number;
  sha?: string;
  url?: string;
  environment?: string;
}

export function eventFacts(event: unknown): EventFacts {
  if (!event || typeof event !== "object") return {};
  const e = event as { pull_request?: { number?: number; head?: { sha?: string } }; number?: number; action?: string; client_payload?: { url?: string; environment?: string; git?: { sha?: string } } };
  const facts: EventFacts = {};
  const pr = e.pull_request?.number ?? e.number;
  if (typeof pr === "number") facts.pr = pr;
  if (typeof e.pull_request?.head?.sha === "string") facts.sha = e.pull_request.head.sha;
  // Vercel's vercel.deployment.ready: the deployment's address, its environment and its commit.
  const p = e.client_payload;
  if (p && typeof p === "object") {
    if (typeof p.url === "string" && p.url) facts.url = asAddress(p.url);
    if (typeof p.environment === "string" && p.environment) facts.environment = p.environment;
    if (typeof p.git?.sha === "string") facts.sha = p.git.sha;
  }
  return facts;
}

/**
 * A Vercel Protection Bypass for Automation secret, put on the address the way Vercel reads it from
 * a query string: the CLI carries --url's query onto every saved test's address, and its redact()
 * keeps "bypass" values out of every file and line it writes.
 */
export function withBypass(url: string, secret: string): string {
  if (!secret) return url;
  const u = new URL(url);
  u.searchParams.set("x-vercel-protection-bypass", secret);
  u.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return u.href;
}

/**
 * The CLI's environment: none of the GitHub credentials, none of this Action's inputs (the bypass
 * secret travels in the address, the AI key only as itself and only in the AI pass), and on the
 * replay pass no AI key at all, so a pure replay can't ask an AI by accident.
 */
export function cliEnv(env: Env, ai?: { key: string }): Env {
  const drop = (k: string) =>
    ["GITHUB_TOKEN", "GH_TOKEN"].includes(k) || k.startsWith("ACTIONS_") || k.startsWith("INPUT_") || /^CONTEXTMACHINES_(?!VAR_)/.test(k) ||
    /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|MISTRAL|OPENROUTER|AI_GATEWAY|GROQ|XAI|DEEPSEEK)_API_KEY$/.test(k);
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !drop(k)));
  return ai ? { ...kept, ANTHROPIC_API_KEY: ai.key } : kept;
}

/**
 * The saved tests a --grep picks, the way the CLI picks them (test-command.ts runSuite over cache.ts
 * listSaved): "<host>/<name>.json" and the goal, lowercased, containing the words. The AI pass checks
 * its --grep picks exactly the one test it is for, so no other test (a failed one) gets an AI.
 */
export function grepPicks(testsDir: string, grep: string): string[] {
  const want = grep.toLowerCase();
  const files: string[] = [];
  const look = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (entry.endsWith(".json")) files.push(path);
      else if (depth === 0 && statSync(path, { throwIfNoEntry: false })?.isDirectory()) look(path, 1);
    }
  };
  look(testsDir, 0);
  return files.filter((file) => {
    let goal = "";
    try {
      const g = (JSON.parse(readFileSync(file, "utf8")) as { goal?: unknown }).goal;
      if (typeof g === "string") goal = g;
    } catch {
      // unreadable: the CLI still lists it, by its path
    }
    return `${relative(testsDir, file)}\n${goal}`.toLowerCase().includes(want);
  });
}

/** The CLI's printed result, or why there isn't one: anything but a suite object is no result. */
export function parseSuite(stdout: string, status: number | null): SuiteJson {
  const none = { ok: false, exit: status || 1, error: `the test command printed no result (exit ${status ?? "none"})` } as SuiteJson;
  try {
    const v = JSON.parse(stdout) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as SuiteJson).exit !== "number") return none;
    const suite = v as SuiteJson;
    if (suite.tests !== undefined && !Array.isArray(suite.tests)) return none;
    return suite;
  } catch {
    return none;
  }
}

/** Every value this run must never write or post, replaced wherever it appears (GitHub masks the log only). */
export function scrubber(secrets: readonly string[]): (text: string) => string {
  const said = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => said.reduce((t, s) => t.split(s).join("REDACTED"), text);
}

/** Every string in a value scrubbed: before markdown escapes a secret ("pw-1" becomes "pw\\-1") past a literal match. */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)])) as T;
  return value;
}

/** Text files in the artifact folder, with the secrets taken out (a page that echoes its address puts one there). */
export function scrubFiles(dir: string, scrub: (text: string) => string): number {
  let changed = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(d, entry);
      const st = statSync(path, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(path);
      else if (st?.isFile() && [".json", ".html", ".xml", ".txt", ".md", ".log", ".csv"].includes(extname(entry).toLowerCase())) {
        const text = readFileSync(path, "utf8");
        const clean = scrub(text);
        if (clean !== text) {
          writeFileSync(path, clean);
          changed++;
        }
      }
    }
  };
  walk(dir);
  return changed;
}

/**
 * Site text the CLI prints reaches the log. A line of it starting "::" would be a workflow command,
 * so GitHub is told to ignore commands until a token only this run knows.
 */
function quietly<T>(work: () => T): T {
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  try {
    return work();
  } finally {
    console.log(`::${token}::`);
  }
}

function stop(message: string, code = 1): never {
  console.log(`::error::${message}`);
  process.exit(code);
}

function readEvent(file: string | undefined): unknown {
  if (!file || !existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function main(env: Env = process.env): Promise<number> {
  const input = inputFrom(env);
  const facts = eventFacts(readEvent(env.GITHUB_EVENT_PATH));
  const key = input("key");
  if (!/^[A-Za-z0-9_.-]*$/.test(key)) stop(`Context Machines: \`key\` may hold letters, digits, ".", "-" and "_" (it was "${key}").`, 2);
  const ai = (input("ai") || "auto") as "auto" | "never";
  if (!["auto", "never"].includes(ai)) stop(`Context Machines: \`ai\` is "auto" (only for tests that need it) or "never" (it was "${ai}").`, 2);
  const minutes = input("minutes") || "3";
  const environment = input("environment") || facts.environment || (facts.pr ? "pull request" : "ci");
  const bypass = input("vercel-bypass-secret");
  if (bypass) console.log(`::add-mask::${bypass}`);
  const keyGiven = input("anthropic-api-key");
  if (keyGiven) console.log(`::add-mask::${keyGiven}`);
  // No one watches CI: the CLI refuses an AI billed per token without a cap (providers/spend.ts), so the AI pass needs one.
  const maxTokens = input("ai-max-tokens");
  if (maxTokens && !/^[1-9]\d*$/.test(maxTokens)) stop(`Context Machines: \`ai-max-tokens\` is a whole number of tokens, like 200000 (it was "${maxTokens}").`, 2);
  if (keyGiven && !maxTokens && ai !== "never") console.log("Not asking an AI: set ai-max-tokens (the most tokens each AI pass may take) beside anthropic-api-key; with no one watching, a paid AI needs a cap.");
  const aiKey = maxTokens ? keyGiven : "";
  const rawUrl = input("url") || facts.url || "";
  let url = "";
  if (rawUrl) {
    try {
      url = withBypass(asAddress(rawUrl), bypass);
    } catch {
      stop(`Context Machines: \`url\` isn't an address (${redact(rawUrl).slice(0, 200)}).`, 2);
    }
  }
  const sha = input("sha") || facts.sha || env.GITHUB_SHA || "";
  const repo = env.GITHUB_REPOSITORY ?? "";
  const token = input("github-token");
  const runUrl = env.GITHUB_RUN_ID && repo ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const gh: GitHub | undefined = token && repo ? { api: env.GITHUB_API_URL || "https://api.github.com", repo, token, warn: (m) => console.log(`::warning::${m}`) } : undefined;
  const statusName = input("status-name") || `contextmachines - ${environment}`;
  const wantStatus = input("status") !== "false" && Boolean(gh) && Boolean(sha);

  const local = input("cli");
  const versionFile = new URL("./version.txt", import.meta.url);
  const version = local ? "from source" : existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : "latest";
  const cli = local ? [process.execPath, resolve(local)] : ["npx", "--yes", `contextmachines@${version}`];
  const work = resolve(input("work-dir") || join(env.RUNNER_TEMP || tmpdir(), key ? `contextmachines-test-${key}` : "contextmachines-test"));
  mkdirSync(work, { recursive: true });
  const output = (line: string) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  // Said first, so the artifact step has a folder even when the run stops part way.
  output(`work-dir=${work}`);

  if (wantStatus) await setStatus(gh!, { sha, state: "pending", context: statusName, description: "Running the saved tests", ...(runUrl ? { targetUrl: runUrl } : {}) });

  const from = resolve(env.GITHUB_WORKSPACE || process.cwd(), input("tests-dir") || "contextmachines");
  const saved = join(from, "tests");
  if (!existsSync(saved)) {
    if (wantStatus) await setStatus(gh!, { sha, state: "error", context: statusName, description: "No saved tests in the repository", ...(runUrl ? { targetUrl: runUrl } : {}) });
    stop(`Context Machines: there are no saved tests in ${redact(saved)}. Run \`npx contextmachines test "<goal>" --url <address>\` locally (a test that passes is saved there) and commit contextmachines/tests/, or set tests-dir.`, 2);
  }
  const out = join(work, "out");
  rmSync(out, { recursive: true, force: true });
  cpSync(saved, join(out, "tests"), { recursive: true });

  const grep = input("grep");
  const pass = (label: string, extra: string[], aiArgs: string[], penv: Env) => {
    // --junit keeps a suite run a suite run on an address with nothing saved for it (a new preview):
    // without it the CLI would suggest tasks for the site instead.
    const args = ["test", "--out", out, "--json", "--junit", join(work, `junit-${label}.xml`), "--minutes", minutes, ...aiArgs, ...(url ? ["--url", url] : []), ...extra];
    console.log(`::group::${label === "replay" ? "Replaying the saved tests, no AI" : `Running ${extra.at(-1) ?? ""} again with the AI`}${url ? ` on ${redact(url)}` : ""}`);
    const result = quietly(() => spawnSync(cli[0]!, [...cli.slice(1), ...args], { cwd: work, env: penv as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }));
    console.log("::endgroup::");
    if (result.error) return { ok: false, exit: 2, error: `Context Machines couldn't start (${result.error.message})` } as SuiteJson;
    return parseSuite(String(result.stdout), result.status);
  };

  const first = pass("replay", grep ? ["--grep", grep] : [], ["--ai", "none"], cliEnv(env));
  const runs = loadRuns(first, work);
  const planned = needsAi(first, runs, { hasKey: Boolean(aiKey), ai });
  // --grep is words, not a name: "shop/login.json" alone must pick "shop/login.json" alone, or a
  // test that failed ("shop/login.json-old", a goal naming it) would get an AI's second try.
  const again = planned.filter((id) => {
    const picks = grepPicks(join(out, "tests"), `${id}.json`);
    if (picks.length !== 1) console.log(`Not asking an AI about ${redact(id)}: no --grep picks that test alone (it picks ${picks.length}).`);
    return picks.length === 1;
  });
  let suite = first;
  if (again.length) {
    // One run per test that needs it. --grep matches "<host>/<name>.json" as words, so only that test's own result is kept.
    const seconds: SuiteJson[] = again.map((id, i) => pass(`ai-${i + 1}`, ["--grep", `${id}.json`], ["--ai", "anthropic", "--max-tokens", maxTokens], cliEnv(env, { key: aiKey })));
    const tests = seconds.flatMap((s, i) => (s.tests ?? []).filter((t) => idOf(t) === again[i]));
    const second: SuiteJson = { ok: false, exit: 0, ms: seconds.reduce((n, s) => n + (s.ms ?? 0), 0), ai: seconds.find((s) => s.ai)?.ai ?? null, tests };
    suite = mergeSuites(first, second);
    for (const [name, run] of loadRuns(second, work)) runs.set(name, run);
  } else if (!planned.length && first.tests?.some((t) => t.verdict === "not_sure")) {
    console.log(keyGiven || ai === "never" ? "Not asking an AI: `ai` is never, or no test that was not sure can be helped by one here." : "Some tests were not sure because there was no AI: set anthropic-api-key to let an AI find another way for those tests only.");
  }

  const pr = Number(input("pr")) || facts.pr || (gh && sha && input("comment") !== "false" ? await pullRequestFor(gh, sha) : undefined);
  const ctx: Context = { environment, ...(url ? { url } : {}), ...(sha ? { sha } : {}), ...(runUrl ? { runUrl: `${runUrl}#artifacts` } : {}), aiTests: again.length, version };
  const scrub = scrubber([bypass, keyGiven, token, ...(bypass ? [encodeURIComponent(bypass)] : []), ...(keyGiven ? [encodeURIComponent(keyGiven)] : [])]);
  scrubFiles(work, scrub);
  suite = scrubDeep(suite, scrub);
  for (const [name, r] of runs) runs.set(name, scrubDeep(r, scrub));
  const junitFile = join(work, "junit.xml");
  writeFileSync(junitFile, scrub(junit(suite, runs)));
  writeFileSync(join(work, "suite.json"), scrub(`${JSON.stringify(suite, null, 2)}\n`));
  const summary = scrub(markdown(suite, runs, ctx));
  quietly(() => console.log(`\n${summary}\n`));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  const s = suite.summary;
  output(`junit=${junitFile}`);
  output(`tests=${s?.tests ?? 0}`);
  output(`passed=${s?.passed ?? 0}`);
  output(`failed=${s?.failed ?? 0}`);
  output(`not-sure=${s?.notSure ?? 0}`);
  output(`pr=${pr ?? ""}`);

  if (input("comment") === "false") console.log("Not commenting (comment: false): the result is in the job summary.");
  else if (!pr) console.log("No pull request for this commit: the result is in the job summary only.");
  else if (!gh) console.log("::warning::Context Machines has no github-token to comment with. The result is in the job summary.");
  else {
    const done = await upsertComment(gh, pr, marker(env.GITHUB_WORKFLOW ?? "", env.GITHUB_JOB ?? "", `${key}${key ? "-" : ""}${environment}`), scrub(markdown(suite, runs, ctx, MAX_COMMENT)));
    if (done.done !== "skipped") console.log(`${done.done === "posted" ? "Posted" : "Updated"} the comment on #${pr}.`);
  }

  const final = statusOf(suite);
  output(`state=${final.state}`);
  if (wantStatus) await setStatus(gh!, { sha, state: final.state, context: statusName, description: final.description, ...(runUrl ? { targetUrl: runUrl } : {}) });
  // The job passes only when the status is a success: never on a result that says exit 0 but isn't every test passing.
  const exit = final.state === "success" ? 0 : suite.exit || 1;
  if (exit !== 0 && input("fail-job") !== "false") console.log(`::error::Context Machines: ${final.description}. What was expected and what was there are in the job summary and each run's report.`);
  return input("fail-job") === "false" ? 0 : exit;
}

/**
 * main(), and when it throws after the pending status was set, an error status, so a Deployment Check
 * or a required check is never left waiting on "pending" (the plain pull request workflow has no
 * step after the Action to say it broke).
 */
export async function guarded(env: Env = process.env): Promise<number> {
  try {
    return await main(env);
  } catch (error) {
    console.log(`::error::Context Machines broke: ${redact((error as Error)?.message ?? String(error)).slice(0, 300)}`);
    const input = inputFrom(env);
    const facts = eventFacts(readEvent(env.GITHUB_EVENT_PATH));
    const token = input("github-token");
    const repo = env.GITHUB_REPOSITORY ?? "";
    const sha = input("sha") || facts.sha || env.GITHUB_SHA || "";
    if (token && repo && sha && input("status") !== "false") {
      const environment = input("environment") || facts.environment || (facts.pr ? "pull request" : "ci");
      await setStatus({ api: env.GITHUB_API_URL || "https://api.github.com", repo, token, warn: (m) => console.log(`::warning::${m}`) }, { sha, state: "error", context: input("status-name") || `contextmachines - ${environment}`, description: "The run broke before the tests finished" });
    }
    return 1;
  }
}

// Run when started as the Action; imported by the tests, it only lends its helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await guarded());
