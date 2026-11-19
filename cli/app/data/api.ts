/**
 * The data API: handlers for contracts.ts ApiRoutes, mounted by the integrator inside ui-server's
 * handle() after its token, Host and Origin checks:
 *
 *   const data = createDataApi({ dataDir, defaultDir: process.cwd(), isOwned: isMine, secrets, ... });
 *   if (url.pathname.startsWith("/api/")) { const r = await data.dispatch(req.method, url.pathname, body); return json(r.status, r.body); }
 *
 * GET reads, POST changes; no GET starts work (C11). Every body is checked here, never trusted as typed.
 * Routes that drive the browser or the AI (setup, plan, runs, explore, stop, Set up sign-in) call the
 * functions the integrator passes in DataDeps, after this layer has checked the project and environment
 * (the AI stays on the project's origins); without them they answer 501.
 */
import { join } from "node:path";
import { NOT_SIGNING_IN, pickAccount } from "../pick-account.ts";
import type { AccountSummary, ApiResult, EnvId, Environment, ExploreFinding, ExploreLimits, Handlers, IssueId, LiveEventNew, PlanStep, Project, ProjectId, RouteKey, RunId, RunSource, RunSummary, SetupState, TestDef } from "../contracts.ts";
import { exportRun } from "./export.ts";
import { History, writeRunMeta, type RunMeta } from "./history.ts";
import { IssueStore, signalsOf } from "./issues.ts";
import { AppStore, outDirOf, type IsOwned, type IsSignInOk } from "./projects.ts";
import { fixPrompt } from "./prompt.ts";
import { AppScheduler, type Runner, type ScheduleEvent } from "./schedule.ts";
import { checkSteps, Tests } from "./tests.ts";
import { bad, DataError, isObj } from "./util.ts";

export interface StartRunRequest {
  project: Project;
  env: Environment;
  test?: TestDef;
  /** The test's saved actions by step id (never sent to the page): replay these, ask the AI for the rest (C5). */
  actions?: Record<string, unknown[]>;
  steps?: PlanStep[];
  goal?: string;
  groupId?: string;
  /** Every test in the project ("Run all"). */
  all?: boolean;
  source: RunSource;
}

export interface StartExploreRequest {
  project: Project;
  env: Environment;
  limits: ExploreLimits;
}

export interface DataDeps {
  /** The app's folder: projects.json, issues.json, exports/. Owner-only, git-ignored. */
  dataDir: string;
  /** Where a new project's folder is (the folder `contextmachines ui` runs in). */
  defaultDir: string;
  /** D12: accounts.ts isMine. */
  isOwned?: IsOwned;
  /** accounts.ts signInAllowed: owned, or the person said it's their own account there. */
  isSignInOk?: IsSignInOk;
  /** Secret values the run knows, by name, for the leak checks of prompts and exports. Never sent anywhere. */
  secrets?: () => Record<string, string>;
  /** Labels only (C20a). Default: none listed. */
  /** The accounts on an environment's address (the project's own address when none is given). */
  accounts?: (p: Project, env?: Environment) => AccountSummary[] | Promise<AccountSummary[]>;
  setup?: () => Promise<SetupState>;
  plan?: (r: { project: Project; env: Environment; goal: string }) => Promise<PlanStep[]>;
  /** "Suggest tests" (ui-server's look and suggest ask). */
  suggest?: (r: { project: Project; env: Environment; goals: string[] }) => Promise<{ goal: string; area: string }[]>;
  /** Marks a host as the person's own (accounts.ts markMine). */
  own?: (r: { project: Project; env: Environment }) => void;
  /** "Set up sign-in" (A1): opens a window on this computer where the person signs in as the account once (ui-server's accounts/setup). Throws a DataError when refused. */
  signInSetup?: (r: { project: Project; env: Environment; label: string }) => void;
  /** Records that the person signs in with their own account on a host (accounts.ts markSignInOk). Never makes it owned. */
  signInOk?: (r: { project: Project; env: Environment }) => void;
  /** Saves a test account for an owned environment; the password to the secret store. Throws a DataError when refused. */
  saveAccount?: (r: { project: Project; env: Environment; label: string; username?: string; password?: string }) => void;
  startRun?: (r: StartRunRequest) => Promise<RunId>;
  explore?: (r: StartExploreRequest) => Promise<RunId>;
  stop?: () => Promise<boolean>;
  /** Done and Give up for an open "Set up sign-in". A run never waits for a person, so there is nothing else. */
  handover?: { done(id: string): Promise<void>; cancel(id: string): Promise<void> };
  /** The ui job runner, for schedules (one browser at a time, C18). */
  runner?: Runner;
  /** Live events to /events (run, issues, schedule). */
  emit?: (e: LiveEventNew) => void;
}

/** An account as the page sees it: its label, its "when to use" words and its state, never a value (C20a). */
const shownAccount = (a: AccountSummary): AccountSummary => ({ label: a.label, host: a.host, firstStep: a.firstStep, ...(a.whenToUse ? { whenToUse: String(a.whenToUse).slice(0, 200) } : {}), ...(a.session ? { session: { ageMs: a.session.ageMs, fresh: a.session.fresh } } : {}), ...(a.problem ? { problem: a.problem } : {}) });

export const EXPLORE_DEFAULTS: ExploreLimits = { maxSteps: 12, maxMinutes: 15, maxFailsInRow: 3 };

type Route = { method: "GET" | "POST"; parts: string[]; key: RouteKey };

export function createDataApi(deps: DataDeps) {
  const store = new AppStore(deps.dataDir, { ...(deps.isOwned ? { isOwned: deps.isOwned } : {}), ...(deps.isSignInOk ? { isSignInOk: deps.isSignInOk } : {}) });
  const history = new History(store);
  const tests = new Tests(store, history);
  const issues = new IssueStore(deps.dataDir);
  const emit = deps.emit ?? (() => {});
  const secrets = () => (deps.secrets ? deps.secrets() : {});
  const scheduler = new AppScheduler(store, deps.runner ?? { busy: () => true, start: () => undefined }, (e: ScheduleEvent) => emit(e));

  const project = (id: string) => store.project(id);
  const runsOf = (projectId: ProjectId): { runs: RunSummary[]; skipped: { path: string; why: string }[] } => {
    const { runs, skipped } = history.index(projectId);
    const per = issues.perRun(projectId);
    return { runs: runs.map((r) => (per.get(r.id) ? { ...r, issues: per.get(r.id)! } : r)), skipped };
  };

  /** Files issues for one indexed run (idempotent). */
  const fileRun = (s: RunSummary, findings?: ExploreFinding[]): IssueId[] => {
    const rec = history.record(s.id);
    const signals = signalsOf({ result: rec.result, ...(rec.log ? { log: rec.log } : {}), ...(rec.a11y ? { a11y: rec.a11y } : {}), ...(findings ? { findings } : {}), cancelled: s.status === "cancelled" });
    return issues.fileRun(s.projectId, s, signals);
  };
  /** Runs on disk not filed yet (written before the app, or while it was closed), oldest first. */
  const syncIssues = (projectId: ProjectId) => {
    const filed = new Set(issues.data.filed[projectId] ?? []);
    for (const r of [...history.index(projectId).runs].reverse()) if (!filed.has(r.id) && r.status !== "running" && r.status !== "queued") fileRun(r);
  };

  /** C18: one browser at a time. A run or Discovery asked for while one is going is refused, never queued beside it. */
  const busyCheck = () => {
    if (deps.runner?.busy()) throw new DataError(409, "A test is running: stop it first, or wait for it to end.");
  };
  /** Test ids that are this project's (its own and the learned ones on disk); any other id is refused (groups, schedules). */
  const ownTestIds = (projectId: ProjectId, raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    const mine = new Set(tests.list(projectId).map((t) => t.id));
    const other = raw.find((t) => typeof t === "string" && !mine.has(t));
    if (other !== undefined) throw bad("A group or schedule can only hold this project's own tests.");
  };
  const notWired = (what: string) => new DataError(501, `${what} isn't wired into this server yet.`);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const envOf = (projectId: string, envId: unknown): Environment => store.envFor(projectId, envId as EnvId | undefined);

  const handlers: Handlers = {
    "GET /api/setup": async () => {
      if (!deps.setup) throw notWired("The setup check");
      return ok(await deps.setup());
    },
    "GET /api/projects": async () => ok({ projects: store.projects() }),
    "POST /api/projects": async (_p, body) => {
      if (!isObj(body)) throw bad("Send the site's address.");
      return ok({ project: store.createProject({ url: body.url, name: body.name, kind: body.kind, dir: deps.defaultDir }) }, 201);
    },
    "GET /api/projects/:id": async (p) => ok({ project: project(p.id) }),
    "POST /api/projects/:id": async (p, body) => ok({ project: store.updateProject(p.id, body) }),
    "POST /api/projects/:id/delete": async (p) => {
      store.deleteProject(p.id);
      issues.deleteProject(p.id);
      return ok({});
    },
    "GET /api/projects/:id/tests": async (p) => ok({ tests: tests.list(p.id) }),
    "POST /api/projects/:id/tests": async (p, body) => ok({ test: tests.create(p.id, body) }, 201),
    "GET /api/tests/:id": async (p) => ok(tests.get(p.id)),
    "POST /api/tests/:id": async (p, body) => ok({ test: tests.update(p.id, body) }),
    "POST /api/tests/:id/delete": async (p) => {
      tests.delete(p.id);
      return ok({});
    },
    "POST /api/plan": async (_p, body) => {
      if (!isObj(body) || typeof body.projectId !== "string") throw bad("Say which project.");
      const goal = str(body.goal)?.trim();
      if (!goal) throw bad("Say what to test, in a sentence.");
      if (!deps.plan) throw notWired("Planning");
      const pr = project(body.projectId);
      const env = envOf(pr.id, body.envId);
      const steps = checkSteps(await deps.plan({ project: pr, env, goal: goal.slice(0, 1000) }));
      // Each Login card comes back signed in as the account that fits (the goal's "as admin", the
      // default, the only one): only where accounts may sign in. Unsure: left for the editor to ask.
      if ((env.owned || env.signInOk) && steps.some((c) => c.enabled && c.kind === "login") && deps.accounts) {
        // The accounts on this environment's address, never the project's own when they differ.
        const accounts = await deps.accounts(pr, env);
        for (const c of steps) {
          if (!c.enabled || c.kind !== "login") continue;
          // A card about being signed out, a sign-in meant to fail, or one typing its own values: no account.
          if (NOT_SIGNING_IN.test(`${c.title} ${c.intent}`) || /\{[\w-]+(?:\.[\w-]+)?\}/.test(`${c.title} ${c.intent}`)) continue;
          const pick = pickAccount({ goal, ...(c.accountLabel ? { step: c.accountLabel } : {}), ...(pr.defaultAccount ? { defaultAccount: pr.defaultAccount } : {}), accounts });
          if ("label" in pick) c.accountLabel = pick.label;
        }
      }
      return ok({ steps });
    },
    "POST /api/suggest": async (_p, body) => {
      if (!isObj(body) || typeof body.projectId !== "string") throw bad("Say which project.");
      if (!deps.suggest) throw notWired("Suggesting tests");
      const pr = project(body.projectId);
      const goals = tests.list(pr.id).map((t) => t.goal);
      const tasks = await deps.suggest({ project: pr, env: envOf(pr.id, body.envId), goals });
      return ok({ tasks: tasks.slice(0, 10).map((t) => ({ goal: String(t.goal).slice(0, 300), area: String(t.area ?? "").slice(0, 60) })) });
    },
    "POST /api/runs": async (_p, body) => {
      if (!isObj(body) || typeof body.projectId !== "string") throw bad("Say which project.");
      const pr = project(body.projectId);
      const test = typeof body.testId === "string" ? tests.get(body.testId).test : undefined;
      if (test && test.projectId !== pr.id) throw bad("That test isn't this project's.");
      const env = envOf(pr.id, body.envId ?? test?.envId);
      const steps = body.steps === undefined ? undefined : checkSteps(body.steps);
      const goal = str(body.goal)?.trim();
      const all = body.all === true;
      if (!test && !steps && !goal && typeof body.groupId !== "string" && !all) throw bad("Say what to run: a test, steps, a goal, a group or all.");
      if (typeof body.groupId === "string" && !store.data.groups.some((g) => g.id === body.groupId && g.projectId === pr.id)) throw bad("That group isn't this project's.");
      if (!deps.startRun) throw notWired("Running a test");
      busyCheck();
      const source: RunSource = ["manual", "group", "api"].includes(body.source as string) ? (body.source as RunSource) : "manual";
      const runId = await deps.startRun({ project: pr, env, ...(test ? { test, actions: tests.actionsOf(test.id) } : {}), ...(steps ? { steps } : {}), ...(goal ? { goal: goal.slice(0, 1000) } : {}), ...(typeof body.groupId === "string" ? { groupId: body.groupId } : {}), ...(all ? { all: true } : {}), source });
      return ok({ runId }, 202);
    },
    "POST /api/explore": async (_p, body) => {
      if (!isObj(body) || typeof body.projectId !== "string") throw bad("Say which project.");
      const pr = project(body.projectId);
      const env = envOf(pr.id, body.envId);
      if (env.kind === "production" && store.settings().confirmProduction && body.confirmedProduction !== true) throw bad("This is a production address. Confirm once before Discovery: the buy, post and delete gate stays on, and sign-ups stay off.");
      const l = isObj(body.limits) ? body.limits : {};
      const num = (v: unknown, d: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), max) : d);
      const limits: ExploreLimits = { maxSteps: num(l.maxSteps, EXPLORE_DEFAULTS.maxSteps, 30), maxMinutes: num(l.maxMinutes, EXPLORE_DEFAULTS.maxMinutes, 60), maxFailsInRow: num(l.maxFailsInRow, EXPLORE_DEFAULTS.maxFailsInRow, 10) };
      if (!deps.explore) throw notWired("Discovery");
      busyCheck();
      return ok({ runId: await deps.explore({ project: pr, env, limits }) }, 202);
    },
    "POST /api/stop": async () => {
      if (!deps.stop) throw notWired("Stop");
      return ok({ stopped: await deps.stop() });
    },
    "GET /api/projects/:id/runs": async (p) => ok(runsOf(p.id)),
    "GET /api/runs/:id": async (p) => ok({ run: history.record(p.id) }),
    "POST /api/runs/:id/rating": async (p, body) => ok({ rating: history.rate(p.id, body) }),
    "POST /api/runs/:id/export": async (p) => {
      const { dir } = history.locate(p.id);
      const rec = history.record(p.id);
      return ok({ file: exportRun(dir, join(deps.dataDir, "exports"), { name: rec.summary.name, secrets: secrets() }) });
    },
    "GET /api/projects/:id/issues": async (p) => {
      project(p.id);
      syncIssues(p.id);
      return ok(issues.list(p.id));
    },
    "GET /api/issues/:id": async (p) => ok({ issue: issues.get(p.id) }),
    "POST /api/issues/:id/status": async (p, body) => ok({ issue: issues.setStatus(p.id, isObj(body) ? body.status : undefined) }),
    "GET /api/issues/:id/prompt": async (p) => {
      const issue = issues.get(p.id);
      const pr = project(issue.projectId);
      const testId = issue.occurrences[0]?.testId;
      let steps: string[] | undefined;
      if (testId) {
        try {
          steps = tests.get(testId).test.steps.filter((s) => s.enabled).map((s) => s.title);
        } catch {
          // the test was deleted since: the prompt goes without its steps
        }
      }
      return ok({ prompt: fixPrompt({ issue, project: pr, ...(steps ? { steps } : {}), secrets: secrets() }) });
    },
    "GET /api/projects/:id/accounts": async (p) => {
      const pr = project(p.id);
      const list = deps.accounts ? await deps.accounts(pr) : [];
      // Labels and state only, whatever the source handed back (C20a).
      return ok({ accounts: list.map(shownAccount) });
    },
    "POST /api/projects/:id/owned": async (p, body) => {
      const pr = project(p.id);
      if (!isObj(body) || body.yes !== true) throw bad("Say yes to mark it as yours.");
      if (!deps.own) throw notWired("Marking a site as yours");
      deps.own({ project: pr, env: envOf(pr.id, body.envId) });
      return ok({ project: project(p.id) });
    },
    "POST /api/projects/:id/signin-ok": async (p, body) => {
      const pr = project(p.id);
      if (!isObj(body) || body.yes !== true) throw new DataError(403, "Say yes to confirm it's your own account there.");
      if (!deps.signInOk) throw notWired("Confirming your own account");
      deps.signInOk({ project: pr, env: envOf(pr.id, body.envId) });
      return ok({ project: project(p.id) });
    },
    "POST /api/projects/:id/sign-in-setup": async (p, body) => {
      const pr = project(p.id);
      if (!isObj(body)) throw bad("Say which account.");
      if (!deps.signInSetup) throw notWired("Set up sign-in");
      const env = envOf(pr.id, body.envId);
      if (!env.owned && !env.signInOk) throw new DataError(403, `You haven't said you sign in with your own account on ${new URL(env.url).host}. Confirm it in Accounts first.`);
      const label = str(body.label)?.trim() ?? "";
      if (!/^[a-z0-9_-]{1,32}$/.test(label)) throw bad("The label is 1 to 32 of a-z, 0-9, _ and -, like admin.");
      deps.signInSetup({ project: pr, env, label });
      return ok({ started: true as const });
    },
    "POST /api/projects/:id/accounts": async (p, body) => {
      const pr = project(p.id);
      if (!isObj(body)) throw bad("Send the account.");
      if (!deps.saveAccount) throw notWired("Adding an account");
      const env = envOf(pr.id, body.envId);
      if (!env.owned && !env.signInOk) throw new DataError(403, `You haven't said you sign in with your own account on ${new URL(env.url).host}. Confirm it in Accounts first.`);
      const label = str(body.label)?.trim() ?? "";
      if (!/^[a-z0-9_-]{1,32}$/.test(label)) throw bad("The label is 1 to 32 of a-z, 0-9, _ and -, like admin.");
      const username = str(body.username)?.trim().slice(0, 300);
      const password = str(body.password);
      deps.saveAccount({ project: pr, env, label, ...(username ? { username } : {}), ...(password ? { password } : {}) });
      // The first account saved is the project's default test account (Settings shows it, and runs that sign in use it).
      const now = pr.defaultAccount ? pr : store.updateProject(pr.id, { defaultAccount: label });
      const list = deps.accounts ? await deps.accounts(pr) : [];
      return ok({ accounts: list.map(shownAccount), project: now });
    },
    "GET /api/projects/:id/groups": async (p) => ok({ groups: store.groups(p.id) }),
    "POST /api/projects/:id/groups": async (p, body) => {
      project(p.id);
      if (isObj(body)) ownTestIds(p.id, body.testIds);
      return ok({ group: store.saveGroup(p.id, body) });
    },
    "POST /api/groups/:id/delete": async (p) => {
      store.deleteGroup(p.id);
      return ok({});
    },
    "GET /api/projects/:id/schedules": async (p) => ok({ schedules: scheduler.list(p.id) }),
    "POST /api/projects/:id/schedules": async (p, body) => {
      project(p.id);
      const target = isObj(body) ? (body as Record<string, unknown>).target : undefined;
      if (isObj(target) && typeof target.test === "string") ownTestIds(p.id, [target.test]);
      return ok({ schedule: scheduler.save(p.id, body) });
    },
    "POST /api/schedules/:id/delete": async (p) => {
      scheduler.delete(p.id);
      return ok({});
    },
    "GET /api/settings": async () => ok({ settings: store.settings() }),
    "POST /api/settings": async (_p, body) => ok({ settings: store.updateSettings(body) }),
    "POST /api/handover/:id/done": async (p) => {
      if (!deps.handover) throw notWired("Set up sign-in");
      await deps.handover.done(p.id);
      return ok({});
    },
    "POST /api/handover/:id/cancel": async (p) => {
      if (!deps.handover) throw notWired("Set up sign-in");
      await deps.handover.cancel(p.id);
      return ok({});
    },
  };

  const routes: Route[] = (Object.keys(handlers) as RouteKey[]).map((key) => {
    const [method, path] = key.split(" ") as ["GET" | "POST", string];
    return { method, parts: path.split("/").filter(Boolean), key };
  });

  /** Finds the route for a request: its key and its path parameters. */
  function match(method: string, pathname: string): { key: RouteKey; params: Record<string, string> } | { status: 404 | 405 } {
    const m = method === "HEAD" ? "GET" : method;
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let okay = true;
      for (let i = 0; i < parts.length && okay; i++) {
        const want = r.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(":")) {
          if (!/^[\w-]{1,64}$/.test(got)) okay = false;
          else params[want.slice(1)] = got;
        } else if (want !== got) okay = false;
      }
      if (!okay) continue;
      pathMatched = true;
      if (r.method === m) return { key: r.key, params };
    }
    return { status: pathMatched ? 405 : 404 };
  }

  /** Answers one API request. Never throws: errors come back as { ok: false, error } with a status. */
  async function dispatch(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: ApiResult<object> }> {
    const found = match(method, pathname);
    if ("status" in found) return { status: found.status, body: { ok: false, error: found.status === 405 ? "That method isn't allowed here." : "There's no such route." } };
    const h = handlers[found.key] as ((p: Record<string, string>, b: unknown) => Promise<{ status: number; body: ApiResult<object> }>) | undefined;
    try {
      return await h!(found.params, body);
    } catch (error) {
      if (error instanceof DataError) return { status: error.status, body: { ok: false, error: error.message, ...(error.status === 409 ? { busy: /busy|running/i.test(error.message) } : {}) } };
      return { status: 500, body: { ok: false, error: "Something went wrong reading the app's data." } };
    }
  }

  /**
   * For the integrator, after a run's result.json is written: keeps the app's meta beside it, indexes it,
   * files its issues, and emits `run` and `issues`. Returns the summary and the issues it changed.
   */
  function onRunWritten(runDir: string, meta?: RunMeta & { findings?: ExploreFinding[] }): { summary?: RunSummary; changed: IssueId[] } {
    if (meta) {
      const { findings: _f, ...rest } = meta;
      if (Object.keys(rest).length) writeRunMeta(runDir, rest);
    }
    const summary = history.summaryOfDir(runDir);
    if (!summary) return { changed: [] };
    const changed = fileRun(summary, meta?.findings);
    emit({ type: "run", id: summary.id, summary });
    if (changed.length) emit({ type: "issues", projectId: summary.projectId, changed });
    return { summary, changed };
  }

  return { handlers, dispatch, match, onRunWritten, scheduler, store, history, tests, issues, syncIssues, outDirOf };
}

export type DataApi = ReturnType<typeof createDataApi>;

function ok<T extends object>(value: T, status = 200): { status: number; body: { ok: true } & T } {
  return { status, body: { ok: true, ...value } };
}


