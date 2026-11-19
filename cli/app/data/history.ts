/**
 * A2: run history, read from the run folders the CLI and the web view already write
 * (<project>/contextmachines/runs/<slug>/<stamp>/result.json). Nothing is copied: the disk is the
 * truth, and the index is only a cache keyed by each file's size and time. A result.json that can't
 * be read is skipped and reported, never a crash.
 *
 * The app may add two small files beside a run's result.json:
 * - app-run.json (RunMeta): what the app knows that the engine doesn't (source, test id, environment,
 *   the plan as run, status, FLAKY, the app log until E1 puts it in result.json). Written by the integrator.
 * - rating.json: Helpful / Not helpful (C14), owner-only, never sent anywhere.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { withoutSecrets } from "../../../packages/scanner/src/tester/cache.ts";
import type { A11yResult, AppLogEntry, AppVerdict, BlockedGroup, EnvId, HandOverRecord, PlanStep, ProjectId, ProtectionFinding, Rating, RunRecord, RunSource, RunStatus, RunSummary, TestId, TestResult } from "../contracts.ts";
import { outDirOf, type AppStore } from "./projects.ts";
import { bad, clip, isObj, notFound, nowIso, readJson, stableId, writeJson } from "./util.ts";

export const META_FILE = "app-run.json";
export const RATING_FILE = "rating.json";
/** "stopped by you" (run.ts STOPPED_BY_YOU): a run the person stopped is cancelled, never a FAIL (C12). */
export const STOPPED_BY_YOU = "stopped by you";
/** Files a run folder may serve or export: no folders, no dot files (as apps/cloud's SERVABLE). */
export const SERVABLE = /^(?!\.)[\w.-]+\.(webm|jpg|jpeg|png|html|json)$/;

/** What the app keeps beside a run's result.json. Every field is optional; the engine's result stays the truth. */
export interface RunMeta {
  source?: RunSource;
  testId?: TestId;
  envId?: EnvId;
  name?: string;
  status?: RunStatus;
  /** Only "flaky" overrides the engine's verdict (E6). */
  verdict?: "flaky";
  plan?: PlanStep[];
  log?: AppLogEntry[];
  a11y?: A11yResult;
  protection?: ProtectionFinding[];
  handovers?: HandOverRecord[];
  looks?: RunRecord["looks"];
  aiAsks?: number;
  judged?: boolean;
}

interface Cached {
  key: string;
  result: TestResult & Record<string, unknown>;
  meta: RunMeta;
}

export interface Indexed {
  runs: RunSummary[];
  skipped: { path: string; why: string }[];
}

/** Where every result.json under a runs folder is: runs/<slug>/<stamp>/ and runs/<name>/ (explore), never through a link. */
export function resultFiles(runsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || e === "latest") continue;
      const path = join(dir, e);
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (st.isFile() && e === "result.json") out.push(path);
    }
  };
  walk(runsDir, 0);
  return out;
}

/** Why a BLOCKED run was blocked, from what the engine measured (C12). */
export function blockedGroupOf(r: Pick<TestResult, "botWall" | "code" | "steps" | "stopped">): BlockedGroup {
  if (r.botWall) return "bot_wall";
  if (r.code === "BOT_CHECK_NEEDS_PERSON") return "bot_wall";
  if (r.code === "AUTH_BASIC_REQUIRED" || r.code === "VERCEL_BYPASS_REQUIRED" || r.code === "ACCESS_TOKEN_REQUIRED") return "environment";
  if (r.code === "VALUE_NEEDED" || r.code === "SEED_DATA_MISSING") return "setup";
  if (r.code) return "credentials";
  const why = r.steps.find((s) => s.verdict === "blocked")?.reason ?? r.stopped ?? "";
  if (/bot check|captcha|challenge/i.test(why)) return "bot_wall";
  if (/\b(safety|gate|won't (buy|pay|post|send|delete|order)|purchase|payment|off the site|another site|left the site)\b/i.test(why)) return "safety_gate";
  if (/\b(needs?|--var|no value|password|sign(ed)? in|account)\b/i.test(why)) return "credentials";
  if (/\b(not found|404|couldn't (open|reach|load)|refused|timed? out|offline|dns)\b/i.test(why)) return "environment";
  if (/\b(set ?up|config)\b/i.test(why)) return "setup";
  return "automation";
}

function checkResult(v: unknown): v is TestResult & Record<string, unknown> {
  return isObj(v) && typeof v.goal === "string" && typeof v.url === "string" && typeof v.verdict === "string" && ["pass", "fail", "blocked", "not_sure"].includes(v.verdict) && Array.isArray(v.steps) && v.steps.every((s) => isObj(s) && typeof s.n === "number" && typeof s.verdict === "string");
}

export class History {
  private readonly store: AppStore;
  private readonly cache = new Map<string, Cached>();
  /** runId → its folder, filled as projects are indexed. */
  private readonly dirs = new Map<string, { dir: string; projectId: ProjectId }>();
  /** The test a run belongs to, when the app's meta doesn't say (a learned test's file). */
  testIdFor: (projectId: ProjectId, goal: string, url: string) => TestId | undefined = () => undefined;

  constructor(store: AppStore) {
    this.store = store;
  }

  private read(file: string): Cached | { why: string } {
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return { why: "gone" };
    const dir = join(file, "..");
    const metaSt = statSync(join(dir, META_FILE), { throwIfNoEntry: false });
    const key = `${st.size}:${st.mtimeMs}:${metaSt ? `${metaSt.size}:${metaSt.mtimeMs}` : "-"}`;
    const hit = this.cache.get(file);
    if (hit && hit.key === key) return hit;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      return { why: `not JSON (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 80) : "unreadable"})` };
    }
    if (!checkResult(parsed)) return { why: "not a test result" };
    const meta = readJson<RunMeta>(join(dir, META_FILE));
    const c: Cached = { key, result: parsed, meta: isObj(meta) ? meta : {} };
    this.cache.set(file, c);
    return c;
  }

  private summary(projectId: ProjectId, projectDir: string, file: string, c: Cached, envId?: EnvId): RunSummary {
    const r = c.result;
    const m = c.meta;
    const dir = relative(projectDir, join(file, "..")).split(sep).join("/");
    const id = stableId("run", dir);
    // result.json exists, so the run is over: a "queued" or "running" left in the meta is stale. A run the
    // person stopped is cancelled whatever the meta says (C12: never a FAIL).
    const metaStatus = m.status === "queued" || m.status === "running" ? undefined : m.status;
    const status: RunStatus = r.stopped === STOPPED_BY_YOU ? "cancelled" : (metaStatus ?? "completed");
    // FLAKY (E6) only re-labels a run that passed or failed across its tries; it never hides a BLOCKED or NOT SURE.
    const verdict: AppVerdict | undefined = status === "completed" ? (m.verdict === "flaky" && (r.verdict === "pass" || r.verdict === "fail") ? "flaky" : r.verdict) : undefined;
    const firstBad = r.steps.find((s) => s.verdict === "failed" || s.verdict === "blocked" || s.verdict === "not_sure");
    const reason = firstBad?.reason ?? r.stopped ?? r.botWall ?? r.startWarning;
    const ai = isObj(r.ai) ? (r.ai as Record<string, unknown>) : undefined;
    const asks = m.aiAsks ?? (typeof ai?.asks === "number" ? ai.asks : r.replay ? 0 : undefined);
    const testId = m.testId ?? this.testIdFor(projectId, r.goal, r.url);
    if (!envId) {
      try {
        const origin = new URL(r.url).origin;
        envId = this.store.project(projectId).envs.find((e) => new URL(e.url).origin === origin)?.id;
      } catch {
        // not an address: no environment
      }
    }
    // Judged: a step whose check is judged, a step an AI's look passed (its `judged` is an object: by
    // "check" or "second opinion"), or a result that counts its judged steps.
    const judged = m.judged ?? ((typeof (r as { judged?: unknown }).judged === "number" && ((r as { judged?: number }).judged ?? 0) > 0) || r.steps.some((s) => (s.check as { kind: string }).kind === "judged" || Boolean((s as unknown as Record<string, unknown>).judged)));
    return {
      id,
      projectId,
      ...(testId ? { testId } : {}),
      name: clip(m.name ?? r.goal, 80),
      ...((m.envId ?? envId) ? { envId: m.envId ?? envId } : {}),
      url: withoutSecrets(r.url),
      status,
      ...(verdict ? { verdict } : {}),
      ...(verdict === "blocked" ? { blockedGroup: blockedGroupOf(r) } : {}),
      ...(reason ? { reason: clip(reason, 300) } : {}),
      ...(r.code ? { code: r.code } : {}),
      source: m.source ?? "manual",
      startedAt: typeof r.startedAt === "string" ? r.startedAt : nowIso(new Date(statSync(file).mtimeMs)),
      ms: typeof r.ms === "number" ? r.ms : 0,
      steps: r.steps.length,
      passed: typeof r.passed === "number" ? r.passed : r.steps.filter((s) => s.verdict === "passed").length,
      // A replay is one the AI took no part in: a card run with a new step asks it, though runTest ran it as a replay.
      replay: r.replay === true && !asks,
      ...(typeof asks === "number" ? { aiAsks: asks } : {}),
      dir,
      ...(typeof r.video === "string" && SERVABLE.test(r.video) ? { video: r.video } : {}),
      ...(judged ? { judged: true } : {}),
    };
  }

  /** Every run of a project, newest first, matching the disk exactly. */
  index(projectId: ProjectId): Indexed {
    const p = this.store.project(projectId);
    const runsDir = join(outDirOf(p), "runs");
    const runs: RunSummary[] = [];
    const skipped: Indexed["skipped"] = [];
    const origins = new Map(p.envs.map((e) => [new URL(e.url).origin, e.id]));
    const seen = new Set<string>();
    for (const file of resultFiles(runsDir)) {
      seen.add(file);
      const c = this.read(file);
      if ("why" in c) {
        skipped.push({ path: relative(p.dir, file).split(sep).join("/"), why: c.why });
        continue;
      }
      let origin = "";
      try {
        origin = new URL(c.result.url).origin;
      } catch {
        // an address that isn't one: not this project's
      }
      if (!origins.has(origin)) continue;
      const s = this.summary(p.id, p.dir, file, c, origins.get(origin));
      this.dirs.set(s.id, { dir: join(file, ".."), projectId: p.id });
      runs.push(s);
    }
    for (const f of this.cache.keys()) if (f.startsWith(runsDir + sep) && !seen.has(f)) this.cache.delete(f);
    runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.dir < b.dir ? 1 : -1));
    return { runs, skipped };
  }

  /** A run's folder, looking through every project once if it isn't known yet. */
  locate(runId: string): { dir: string; projectId: ProjectId } {
    if (!/^run_[0-9a-f]{12}$/.test(runId)) throw notFound("run");
    let found = this.dirs.get(runId);
    if (!found) {
      for (const p of this.store.projects()) this.index(p.id);
      found = this.dirs.get(runId);
    }
    if (!found) throw notFound("run");
    return found;
  }

  /** The summary of the run in a folder (after it is written), indexing its project. */
  summaryOfDir(runDir: string): RunSummary | undefined {
    const want = resolve(runDir);
    const file = join(want, "result.json");
    for (const p of this.store.projects()) {
      if (!file.startsWith(resolve(outDirOf(p), "runs") + sep)) continue;
      const hit = this.index(p.id).runs.find((r) => resolve(p.dir, r.dir) === want);
      if (hit) return hit;
    }
    return undefined;
  }

  record(runId: string): RunRecord {
    const { dir, projectId } = this.locate(runId);
    const file = join(dir, "result.json");
    const c = this.read(file);
    if ("why" in c) throw notFound("run");
    const p = this.store.project(projectId);
    const summary = this.summary(projectId, p.dir, file, c);
    const r = c.result;
    const m = c.meta;
    const log = m.log ?? (Array.isArray(r.log) ? (r.log as AppLogEntry[]) : undefined);
    const a11y = m.a11y ?? (isObj(r.a11y) ? (r.a11y as unknown as A11yResult) : undefined);
    const rating = this.rating(runId);
    return {
      summary,
      result: { ...r, url: withoutSecrets(r.url) },
      ...(m.plan ? { plan: m.plan } : {}),
      ...(log ? { log } : {}),
      ...(a11y ? { a11y } : {}),
      ...(m.protection ? { protection: m.protection } : {}),
      ...(m.handovers ? { handovers: m.handovers } : Array.isArray(r.handovers) ? { handovers: r.handovers as HandOverRecord[] } : {}),
      ...(m.looks ? { looks: m.looks } : {}),
      ...(rating ? { rating } : {}),
    };
  }

  rating(runId: string): Rating | undefined {
    const { dir } = this.locate(runId);
    const r = readJson<Rating>(join(dir, RATING_FILE));
    return isObj(r) && typeof r.helpful === "boolean" ? r : undefined;
  }

  rate(runId: string, body: unknown, now = new Date()): Rating {
    const { dir } = this.locate(runId);
    if (!isObj(body) || typeof body.helpful !== "boolean") throw bad("Say helpful: true or false.");
    const rating: Rating = { helpful: body.helpful, ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim().slice(0, 500) } : {}), at: nowIso(now) };
    writeJson(join(dir, RATING_FILE), rating);
    return rating;
  }
}

/** The integrator writes this beside result.json when the app starts or ends a run (owner-only). */
export function writeRunMeta(runDir: string, meta: RunMeta): void {
  const was = readJson<RunMeta>(join(runDir, META_FILE));
  writeJson(join(runDir, META_FILE), { ...(isObj(was) ? was : {}), ...meta });
}
