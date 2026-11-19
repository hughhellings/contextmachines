/**
 * The Action, end to end, on this machine: what GitHub and Vercel would do, played locally.
 *
 *   node action/ci/simulate.ts
 *
 * It starts the bench's practice site (cli/bench/site.ts) and a fake GitHub (fake-github.ts),
 * writes a repository with three saved tests (sim-site.ts) and runs run.ts the way action.yml does,
 * with the CLI from this checkout (the `cli` input), no AI and no network beyond 127.0.0.1:
 *
 *   1. Vercel's vercel.deployment.ready for a preview at the site's own address: PR found from the
 *      commit, comment posted, status pending then failure (one test fails, one is not sure).
 *   2. The next preview, at a new address (127.0.0.1 instead of localhost: another origin, as every
 *      Vercel preview has), behind a bypass secret: the same comment is updated, never a second one,
 *      and the secret appears nowhere.
 *   3. A push that fixes it, run with only the passing test: status success, comment updated again.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureSite } from "../../cli/bench/site.ts";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { writeSimTests } from "./sim-site.ts";

const HERE = import.meta.dirname;
const CLI = resolve(HERE, "..", "..", "cli", "contextmachines.ts");
const RUN = join(HERE, "run.ts");
const TOKEN = "ghs_simulatedtokensimulatedtoken0001";
const REPO = "acme/shop";
const SHA = "5e1f0c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f";
const PR = 12;
export const BYPASS = "sim0bypass0secret0value0000000001";

export interface SimRun {
  exit: number | null;
  stdout: string;
  outputs: Record<string, string>;
  summary: string;
  work: string;
}

export interface Simulation {
  runs: SimRun[];
  github: Pick<FakeGitHub, "comments" | "statuses" | "requests">;
  /** Every file the runs wrote (work dirs), for looking for what must never be written. */
  written: string;
  /** Every request the practice site answered (path and query). */
  siteHits: string[];
}

function runAction(env: Record<string, string>): Promise<{ exit: number | null; stdout: string }> {
  return new Promise((done) => {
    // The parent's AI keys and GitHub variables never leak into the simulation.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|INPUT_|CONTEXTMACHINES_|RUNNER_|ACTIONS_|CI$)|_API_KEY$/.test(k)));
    const child = spawn(process.execPath, [RUN], { env: { ...base, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stdout += c));
    child.on("close", (exit) => done({ exit, stdout }));
  });
}

function readOutputs(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function allText(dir: string): string {
  let text = "";
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !/\.(webm|jpg|png)$/.test(e.name)) text += `${p}\n${readFileSync(p, "utf8")}\n`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return text;
}

export async function simulate(o: { log?: (line: string) => void } = {}): Promise<Simulation> {
  const log = o.log ?? (() => {});
  const root = mkdtempSync(join(tmpdir(), "cm-ci-sim-"));
  const site = await startFixtureSite();
  const github = await startFakeGitHub({ token: TOKEN, repo: REPO });
  github.pulls.set(SHA, [{ number: PR, state: "open", head: { sha: SHA } }]);
  const repoDir = join(root, "repo");
  writeSimTests(join(repoDir, "contextmachines"), site.url);
  const runs: SimRun[] = [];
  let siteHits: string[] = [];
  try {
    const one = async (n: number, event: unknown, inputs: Record<string, string>) => {
      const dir = join(root, `run-${n}`);
      mkdirSync(dir, { recursive: true });
      const eventFile = join(dir, "event.json");
      writeFileSync(eventFile, JSON.stringify(event));
      const env = {
        GITHUB_ACTIONS: "true",
        GITHUB_API_URL: github.api,
        GITHUB_SERVER_URL: "https://github.example",
        GITHUB_REPOSITORY: REPO,
        GITHUB_RUN_ID: String(100 + n),
        GITHUB_WORKFLOW: "contextmachines",
        GITHUB_JOB: "test",
        GITHUB_EVENT_NAME: "repository_dispatch",
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_SHA: "0".repeat(40),
        GITHUB_WORKSPACE: repoDir,
        GITHUB_OUTPUT: join(dir, "outputs.txt"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        RUNNER_TEMP: dir,
        INPUT_GITHUB_TOKEN: TOKEN,
        INPUT_CLI: CLI,
        INPUT_MINUTES: "1",
        ...inputs,
      };
      log(`run ${n}: ${JSON.stringify(inputs)}`);
      const r = await runAction(env);
      const outputs = readOutputs(env.GITHUB_OUTPUT);
      runs.push({ exit: r.exit, stdout: r.stdout, outputs, summary: existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, "utf8") : "", work: outputs["work-dir"] ?? "" });
      log(`run ${n}: exit ${r.exit}, state ${outputs.state ?? "?"}, comments on #${PR}: ${github.comments.get(PR)?.length ?? 0}`);
    };
    const dispatch = (url: string) => ({ action: "vercel.deployment.ready", client_payload: { environment: "preview", url, git: { sha: SHA, shortSha: SHA.slice(0, 7) } } });
    // 1. A preview at the site's own address.
    await one(1, dispatch(site.url), {});
    // 2. The next preview: a new origin, behind a bypass secret.
    const moved = new URL(site.url);
    moved.hostname = "127.0.0.1";
    await one(2, dispatch(moved.href), { INPUT_VERCEL_BYPASS_SECRET: BYPASS });
    // 3. Only the passing test: success.
    await one(3, dispatch(site.url), { INPUT_GREP: "about" });
  } finally {
    siteHits = site.hits();
    await site.close();
    await github.close();
  }
  return { runs, github: { comments: github.comments, statuses: github.statuses, requests: github.requests }, written: runs.map((r) => allText(r.work)).join("\n"), siteHits };
}

/** The done bar, as checks: each a name and whether it held. */
export function verify(sim: Simulation): { name: string; ok: boolean; detail: string }[] {
  const [r1, r2, r3] = sim.runs;
  const comments = sim.github.comments.get(PR) ?? [];
  const states = sim.github.statuses.filter((s) => s.sha === SHA).map((s) => s.state);
  const posts = sim.github.requests.filter((q) => q.method === "POST" && q.path.endsWith(`/issues/${PR}/comments`)).length;
  const patches = sim.github.requests.filter((q) => q.method === "PATCH").length;
  // "::add-mask::<secret>" is how GitHub is told to hide it: GitHub never shows that line.
  const everything = [sim.written,
    ...sim.runs.map((r) => `${r.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n")}\n${r.summary}\n${JSON.stringify(r.outputs)}`), JSON.stringify(sim.github.statuses), comments.map((c) => c.body).join("\n")].join("\n");
  const check = (name: string, ok: boolean, detail = "") => ({ name, ok, detail });
  return [
    check("run 1 exits 1 (a test failed)", r1?.exit === 1, `exit ${r1?.exit}`),
    check("run 2 exits 1 on the new origin", r2?.exit === 1, `exit ${r2?.exit}`),
    check("run 3 exits 0 (only the passing test)", r3?.exit === 0, `exit ${r3?.exit}`),
    check("run 2 ran on the new origin", /127\.0\.0\.1/.test(r2?.summary ?? ""), ""),
    // Review: the summary's footer names the --url whatever happened; the runs' own addresses show where they ran.
    check("run 2's tests themselves ran on 127.0.0.1", (() => {
      try {
        const urls = ((JSON.parse(readFileSync(join(r2!.work, "suite.json"), "utf8")) as { tests?: { url?: string }[] }).tests ?? []).map((t) => t.url).filter(Boolean) as string[];
        return urls.length > 0 && urls.every((u) => new URL(u).hostname === "127.0.0.1");
      } catch {
        return false;
      }
    })(), ""),
    check("exactly one PR comment, created once then updated twice", comments.length === 1 && posts === 1 && patches === 2, `comments ${comments.length}, POST ${posts}, PATCH ${patches}`),
    check("the comment shows the last run", /🟢 Context Machines on preview: 1 saved test · 1 passed/.test(comments[0]?.body ?? ""), (comments[0]?.body ?? "").split("\n")[1] ?? ""),
    check("statuses: pending, failure, pending, failure, pending, success", states.join(",") === "pending,failure,pending,failure,pending,success", states.join(",")),
    check("status name is the one a Deployment Check waits for", sim.github.statuses.every((s) => s.context === "contextmachines - preview"), ""),
    check("job summary written each run", sim.runs.every((r) => /^### .*Context Machines on preview/.test(r.summary)), ""),
    check("JUnit written each run", sim.runs.every((r) => r.outputs.junit && existsSync(r.outputs.junit) && /<testsuites /.test(readFileSync(r.outputs.junit, "utf8"))), ""),
    check("run 1 JUnit: 3 tests, 1 failure, 1 error", /tests="3" failures="1" errors="1"/.test(r1?.outputs.junit ? readFileSync(r1.outputs.junit, "utf8") : ""), ""),
    check("artifact folder has each run's report and video", sim.runs.every((r) => existsSync(join(r.work, "out", "runs")) && readdirSync(join(r.work, "out", "runs")).length > 0), ""),
    check("outputs say the counts", r1?.outputs.passed === "1" && r1.outputs.failed === "1" && r1.outputs["not-sure"] === "1" && r1.outputs.pr === String(PR), JSON.stringify(r1?.outputs ?? {})),
    check("no AI was asked (no key; replay only)", sim.runs.every((r) => !/AI asked for/.test(r.summary) && /replayed with no AI/.test(r.summary)), ""),
    check("run 2 sent the bypass secret to the site (as Vercel reads it)", sim.siteHits.some((h) => h.includes(`x-vercel-protection-bypass=${BYPASS}`)), ""),
    check("run 2's summary shows the address with the secret redacted", /x-vercel-protection-bypass=REDACTED/.test(r2?.summary ?? ""), ""),
    check("the bypass secret appears nowhere it was written or posted", !everything.includes(BYPASS), ""),
    check("the GitHub token appears nowhere it was written or posted", !everything.includes(TOKEN), ""),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sim = await simulate({ log: (l) => console.log(l) });
  const results = verify(sim);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail && !r.ok ? ` (${r.detail})` : ""}`);
  const comment = sim.github.comments.get(PR)?.[0]?.body;
  if (comment) console.log(`\nThe comment on #${PR} now reads:\n\n${comment}\n`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
