/**
 * The app inside `contextmachines ui`: the data lane's API (projects, tests, runs, issues, schedules,
 * settings, export), the engine lanes' plan-first runs, Discovery and Set up sign-in, wired to ui-server's
 * one job queue. ui-server keeps its token, Host and Origin checks in front of every route here, and
 * stays the only place a browser starts (one at a time, C18).
 *
 * Kept out of ui-server.ts on purpose, so the server's own diff stays small: ui-server hands this
 * module an AppHost (its emit, its job runner, its browser launch) and calls back after each run.
 *
 * Engine events (E1 app log, E10 protection) are wired here by their contracts.ts names: runExtras()
 * passes `onLog` and `onProtection` to runTest. A run never waits for a person (A1): the only wait for
 * one is "Set up sign-in" under Accounts, before the runs (the HandOver waiter below).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { OUT_DIRS } from "./data/projects.ts";
import { chromium, type Browser } from "playwright";
import { readSaved, type SavedTest } from "../../packages/scanner/src/tester/cache.ts";
import type { RunOptions, RunOutcome } from "../../packages/scanner/src/tester/run.ts";
import { screencast, type Screencast } from "../../packages/scanner/src/tester/screencast.ts";
import type { SignInCode, StepResult, TestResult } from "../../packages/scanner/src/tester/types.ts";
import { isMine, signInAllowed, SESSION_MAX_AGE_MS, sessionAge, sessionPathFor } from "../accounts.ts";
import { timedAi, type AskTiming } from "../ai.ts";
import { publicUrl } from "../report.ts";
import { aiBrain, newRunDir, writeRun } from "../test-command.ts";
import { notesProblem } from "../knowledge.ts";
import { suggestTasks } from "../test-tasks.ts";
import { lookAt } from "../../packages/scanner/src/tester/look.ts";
import { BotWalled } from "../../packages/scanner/src/tester/botwall.ts";
import type { AccountSummary, AppLogEntry, Environment, Project, ExploreFinding, PlanStep, PracticeSite, ProtectionFinding, RunSource, SetupState, TestDef } from "./contracts.ts";
import { createDataApi, type StartExploreRequest, type StartRunRequest } from "./data/api.ts";
import type { ScheduledJob } from "./data/schedule.ts";
import { DataError } from "./data/util.ts";
import { goalSignsIn, namedIn, NOT_SIGNING_IN, pickAccount, quietAccount, type PickableAccount } from "./pick-account.ts";
import { splitSignIn } from "../../packages/scanner/src/tester/signedin.ts";
import { explore, exploreSummary, type ExploreRun } from "./engine/explore/explore.ts";
import { planTest, runPlan, savedFromCards, type PlannedRun } from "./engine/explore/plan.ts";
import { HandOver } from "./engine/protect/handover.ts";

/** What an app run adds to ui-server's run item. */
export interface AppItemFields {
  /** Step cards to run (plan first, E3): run as they are, switched-off ones "skipped". */
  cards?: PlanStep[];
  /** The test's saved file, for the cards' saved clicks (C5: an edited card has none). */
  previous?: SavedTest;
  /** Every enabled card has saved clicks: a replay that needs no AI. */
  replayable?: boolean;
  testId?: string;
  envId?: string;
  source?: RunSource;
  /** Filled by the run: which card each run step was. */
  planRun?: PlannedRun;
  /** Filled by the run: the cards' saved clicks were stale, so the test was planned again from its goal. */
  replanned?: true;
  /** Not run, and why (no one there to pick its account): ends BLOCKED with this reason and code, written as a run. */
  blocked?: { reason: string; code: SignInCode };
}

/** One test to run, as ui-server's run() takes it. */
export interface AppItem extends AppItemFields {
  goal: string;
  url: string;
  as?: string;
  file?: string;
  saved?: SavedTest;
  visitor?: boolean;
}

interface HostJob {
  abort: AbortController;
  browser?: Browser;
  done: Promise<void>;
}

/** What ui-server gives the app. */
export interface AppHost {
  outDir: string;
  projectDir: string;
  ai: import("../ai.ts").Ai | undefined;
  vars: Record<string, string>;
  mask: (s: string) => string;
  allowHosts: string[];
  headed: boolean;
  /** `ui --measured-only`: no check is judged by an AI, so none is planned either. */
  measuredOnly?: boolean;
  emit(e: Record<string, unknown> & { type: string }): void;
  busy(): boolean;
  stop(): Promise<boolean>;
  /** ui-server's run(): starts the job, synchronously sets it busy. */
  run(items: AppItem[], o: { noAi?: boolean }): void;
  /** ui-server's begin(): a job of its own (plan, Discovery), one at a time with the rest. */
  begin(kind: "suggest" | "run", work: (j: HostJob) => Promise<void>): HostJob;
  launch(headed: boolean): Promise<Browser>;
  /** Open /events streams: "Set up sign-in" waits for Done only while an app page is open. */
  viewers(): number;
  /** A live test's run folder, for /files. */
  runDirs: Map<string, string>;
  fileUrl(id: string, name: string): string;
  nextId(): string;
  /** C20a's accounts panel view for an address (labels and state, never a value). */
  accountsView(site: string): { ok: boolean; host?: string; accounts?: { label: string; first: string; whenToUse?: string; set: { password?: boolean } }[] };
  /** C20a's account changes (mine, save, secret), as the accounts panel sends them: [status, body]. */
  accountsChange?(what: "mine" | "signin-ok" | "setup" | "save" | "secret", body: Record<string, unknown>): [number, unknown];
}

export interface AppOptions {
  /** Start the practice site (sites lane) with the app, for "Try the practice site". */
  practice?: () => Promise<PracticeSite>;
  /** A Mac notification on a failed run (C22). Absent: none. */
  notify?: (title: string, body: string) => void;
}

/** A check that only holds on the sign-in page itself ("address contains /login", "page shows Sign in"). */
function signInPageCheck(c: PlanStep["check"]): boolean {
  const SIGN_IN = /\b(?:log|sign)[ _-]?(?:in|on)\b|^\/?(?:login|signin|auth)\b/i;
  if (c.kind === "url_contains" || c.kind === "title_contains" || c.kind === "text_visible") return SIGN_IN.test(c.text);
  if (c.kind === "element_visible") return SIGN_IN.test(c.name);
  return false;
}

/**
 * A test whose login card signs in as an account is signed in by the app before step 1 (C20b). So the
 * steps before that card (opening the sign-in page) are passed over, and the card itself says it is
 * signed in already: it goes into the app and types nothing. Without an account, the cards as they are.
 */
export function signedInFirst(cards: PlanStep[], as: string | undefined): { cards: PlanStep[]; signInWords?: (label: string) => string; skipped: Set<number> } {
  const skipped = new Set<number>();
  let first = as ? cards.findIndex((c) => c.enabled && c.kind === "login" && c.accountLabel === as) : -1;
  if (first < 0) return { cards, skipped };
  // A planner often writes the sign-in as two or more Login cards ("Open the sign in page", then
  // "Sign in"). The app has signed in already, so all but the last of that run are passed over too:
  // a card checking "address contains /login" could never hold once signed in.
  const isLogin = (c: PlanStep | undefined) => Boolean(c && c.kind === "login" && (!c.accountLabel || c.accountLabel === as));
  let last = first;
  for (let j = first + 1; j < cards.length; j++) {
    if (!cards[j]!.enabled) continue;
    if (!isLogin(cards[j])) break;
    last = j;
  }
  first = last;
  // A Login card that signs in and does more ("Sign in and open Settings"): the app signs in, and the rest
  // runs as a card of its own, with the card's real check (a judged one of what it did when its check only
  // said "signed in"). Never a step about being signed out or a sign-in meant to fail (splitSignIn).
  const mixed = splitSignIn(cards[first]!);
  if (mixed) {
    const c = cards[first]!;
    const rest = mixed.unchecked ? { ...mixed.rest, check: { kind: "judged", claim: `The page shows this was done: ${mixed.rest.title}`.slice(0, 200) } as const } : mixed.rest;
    const after: PlanStep = { ...c, id: `${c.id}-after`, title: rest.title, intent: rest.intent, check: rest.check, kind: "act", checkMode: rest.check.kind === "judged" ? "judged" : "measured" };
    delete (after as Partial<PlanStep>).accountLabel;
    cards = [...cards.slice(0, first), { ...c, title: mixed.signIn.title, intent: "Sign in", check: mixed.signIn.check }, after, ...cards.slice(first + 1)];
  }
  const out = cards.map((c, i) => {
    // The card the app signed in for checks the session: a sign-in page check could never hold now, and an
    // address guess ("address contains dashboard", when the app lands on /app) is the later cards' to check.
    // Never a card about being signed out or a sign-in meant to fail.
    if (i === first && (signInPageCheck(c.check) || c.check.kind === "url_contains") && !NOT_SIGNING_IN.test(`${c.title} ${c.intent}`)) return { ...c, check: { kind: "signed_in" } as const };
    if (i >= first || !c.enabled) return c;
    skipped.add(i);
    return { ...c, enabled: false };
  });
  return { cards: out, skipped, signInWords: (label) => `You are already signed in as ${label}: go into the signed-in part of the app (the sign-in page or link takes you there now). Type nothing.` };
}

/**
 * A run that couldn't start because nothing said which account to sign in as (a group, a schedule, a
 * saved test with no one to ask): BLOCKED, its login card saying why, the rest not run. Written like any run.
 */
export function blockedResult(t: Pick<AppItem, "goal" | "url" | "cards" | "blocked">, startedAt = new Date().toISOString()): TestResult {
  const why = t.blocked?.reason ?? "it couldn't start";
  const cards = (t.cards ?? []).filter((c) => c.enabled);
  let said = false;
  const steps: StepResult[] = (cards.length ? cards : [{ title: t.goal, intent: t.goal, check: { kind: "none" }, kind: "login" } as Pick<PlanStep, "title" | "intent" | "check" | "kind">]).map((c, i) => {
    const here = !said && c.kind === "login";
    if (here) said = true;
    return { n: i + 1, title: c.title, intent: c.intent, check: c.check, verdict: here ? "blocked" : "skipped", ...(here ? { reason: why, code: t.blocked?.code } : { reason: said ? "not run: the sign-in before it ended BLOCKED" : "not run: the test couldn't start" }), actions: [], ms: 0, at: 0 } as StepResult;
  });
  if (!said && steps[0]) Object.assign(steps[0], { verdict: "blocked", reason: why });
  return { goal: t.goal, url: t.url, verdict: "blocked", steps, passed: 0, ms: 0, startedAt, actions: 0, friction: [], ...(t.blocked ? { code: t.blocked.code } : {}) };
}

/** Words for the checklist when no AI is set up for this session. */
export const NO_AI_WORDS = "No AI is set up for this session, so saved tests replay but new tests can't be planned.";
export const NEEDS_AI = "New tests need an AI: sign in to Claude Code (run `claude`) or Codex (run `codex`) once in a terminal, then start `contextmachines ui` again.";

/**
 * A Mac notification, safe from injection (C22): the title and words are passed to osascript as
 * arguments, never put inside the script's text.
 */
export function macNotify(title: string, body: string, run: typeof execFile = execFile): void {
  if (process.platform !== "darwin" && run === execFile) return;
  run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title.slice(0, 120), body.slice(0, 240)], () => {});
}

/** A Discovery run as a test result, so history, the result screen and issues read it like any run. */
export function exploreResult(r: ExploreRun, url: string, startedAt: string): TestResult {
  const steps: StepResult[] = r.pages.map((p, i) => ({
    n: i + 1,
    title: `Open ${p.path}`,
    intent: p.from ? `Follow "${p.from.words}" from ${p.from.path}` : "Open the start page",
    check: { kind: "none" },
    verdict: p.failed || p.stoppedOffSite ? "failed" : "passed",
    ...(p.failed ? { reason: p.failed } : p.stoppedOffSite ? { reason: p.stoppedOffSite } : {}),
    actions: [],
    ms: 0,
    at: p.at,
  }));
  // A finding fails the page it was found on, said in its words: never a FAIL with every step ticked green.
  for (const f of r.findings) {
    const s = steps.find((x) => x.n === f.step) ?? steps.at(-1);
    if (!s) continue;
    s.reason = (s.verdict === "passed" ? `found: ${f.title}` : `${s.reason ? `${s.reason}; ` : ""}${f.title}`).slice(0, 300);
    s.verdict = "failed";
  }
  const failed = r.findings.length > 0 || steps.some((s) => s.verdict === "failed");
  return {
    goal: "Explore the site and find bugs",
    url,
    // A crawl you stopped, or one that opened no page, measured too little to PASS: NOT SURE (history shows a stop as cancelled).
    verdict: r.blocked ? "blocked" : failed ? "fail" : r.stoppedBecause === "stopped" || !steps.length ? "not_sure" : "pass",
    steps,
    passed: steps.filter((s) => s.verdict === "passed").length,
    ms: r.ms,
    startedAt,
    ...(r.video ? { video: r.video } : {}),
    actions: r.pages.length,
    friction: [],
    ...(r.blocked ? { botWall: r.blocked } : {}),
    ...(r.stoppedBecause === "stopped" ? { stopped: "stopped by you" } : {}),
  };
}

export function createApp(host: AppHost, opts: AppOptions = {}) {
  let practice: PracticeSite | undefined;
  if (opts.practice) opts.practice().then((p) => (practice = p), () => {});

  // A1: one "Set up sign-in" waiter per server (Done / Give up for the window on the person's computer).
  const handOver = new HandOver({ viewers: () => host.viewers(), emit: (e) => host.emit(e as never) });

  const browserReady = (): SetupState["browser"] => {
    try {
      const path = chromium.executablePath();
      return existsSync(path) ? { ready: true, words: "Chromium is installed." } : { ready: false, words: "Chromium isn't installed yet: run `npx playwright install chromium`." };
    } catch {
      return { ready: false, words: "Chromium isn't installed yet: run `npx playwright install chromium`." };
    }
  };

  /** The run items for a test (its cards, and its saved file's clicks). */
  const itemForTest = (project: { dir: string; defaultAccount?: string }, env: Environment, test: TestDef, source: RunSource, steps?: PlanStep[], askNow = false): AppItem => {
    const file = test.file ? join(project.dir, test.file) : undefined;
    let previous: SavedTest | undefined;
    if (file && existsSync(file)) {
      try {
        previous = readSaved(file);
      } catch {
        // planned afresh for the steps with no clicks
      }
    }
    const cards = steps ?? test.steps;
    return { ...cardsItem(cards, env, test.goal, previous, project, askNow, test.account), ...(file ? { file } : {}), testId: test.id, envId: env.id, source };
  };

  /** The accounts that may sign in on an environment (owned, or confirmed as your own): labels and "when to use" only. */
  const accountsOn = (env: Environment): PickableAccount[] => {
    if (!env.owned && !env.signInOk) return [];
    const v = host.accountsView(env.url);
    return v.ok && v.accounts ? v.accounts.map((a) => ({ label: a.label, ...(a.whenToUse ? { whenToUse: a.whenToUse } : {}) })) : [];
  };

  /**
   * Each enabled Login card signs in as the account that fits (as TesterArmy: every project account is
   * there for every test): its own, the one the goal names, the default, the only one, or the one the
   * goal's words match. Several and nothing said which: `ask` (the editor asks; a run with no one there
   * ends BLOCKED ACCOUNT_NOT_CHOSEN). No account at all: the cards as they are (the engine ends a sign-in
   * that needs values BLOCKED AUTH_ACCOUNT_NEEDED).
   */
  const withAccounts = (cards: PlanStep[], env: Environment, goal: string, project?: Pick<Project, "defaultAccount">): { cards: PlanStep[]; ask?: string } => {
    if (!cards.some((c) => c.enabled && c.kind === "login")) return { cards };
    const accounts = accountsOn(env);
    if (!accounts.length) return { cards };
    let ask: string | undefined;
    const labels = new Set(accounts.map((a) => a.label));
    const out = cards.map((c) => {
      if (!c.enabled || c.kind !== "login") return c;
      // A Login card with no account that is about a sign-in meant to fail, or being signed out, or that types
      // its own values ({bad.password}): a negative test, left as it is, never signed in for.
      if (!c.accountLabel && (NOT_SIGNING_IN.test(`${c.title} ${c.intent}`) || [...`${c.title} ${c.intent}`.matchAll(/\{([\w-]+)(?:\.[\w-]+)?\}/g)].some((m) => !labels.has(m[1]!)))) return c;
      const pick = pickAccount({ goal, ...(c.accountLabel ? { step: c.accountLabel } : {}), ...(project?.defaultAccount ? { defaultAccount: project.defaultAccount } : {}), accounts });
      if ("label" in pick) return pick.label === c.accountLabel ? c : { ...c, accountLabel: pick.label };
      if ("ask" in pick) ask ??= pick.ask;
      return c;
    });
    return { cards: out, ...(ask ? { ask } : {}) };
  };

  /**
   * The account a test with no Login card signs in as before step 1: its own (a test saved from a run that
   * signed in first: TestDef.account, or its file's `as`), else, for a goal that signs in (goalSignsIn, as
   * the goal path picks), the account that fits (pickAccount). A test saved before its account was kept
   * ("sign in and open patterns", saved as only "Open the patterns page") so signs in again, never running
   * signed out into the sign-in page. Never for a goal about being signed out or a sign-in meant to fail.
   */
  const testAccount = (env: Environment, goal: string, own: string | undefined, project?: Pick<Project, "defaultAccount">): { label?: string; ask?: string } => {
    if (NOT_SIGNING_IN.test(goal)) return {};
    const accounts = accountsOn(env);
    // Its own account and none here at all (deleted since, or none added on this address): said, never run signed out.
    if (!accounts.length) return own ? { ask: `This test signs in as ${own}, and there's no ${own} account on this address. Add ${own} under Accounts, or run it on the address it was saved on.` } : {};
    // A saved test replays as it was saved: one saved signed out isn't signed in behind the person's back.
    if (!own && !goalSignsIn(goal) && !namedIn(goal, accounts)) return {};
    const pick = pickAccount({ goal, ...(own ? { step: own } : {}), ...(project?.defaultAccount ? { defaultAccount: project.defaultAccount } : {}), accounts });
    if ("label" in pick) return { label: pick.label };
    if ("ask" in pick) return { ask: own ? `This test signs in as ${own}, and there's no ${own} account on this address (it has ${accounts.map((a) => a.label).join(", ")}). Add ${own} under Accounts, or run it on the address it was saved on.` : pick.ask };
    return {};
  };

  const cardsItem = (given: PlanStep[], env: Environment, goal: string, previous?: SavedTest, project?: Pick<Project, "defaultAccount">, askNow = false, account?: string): AppItem => {
    const withAcc = withAccounts(given, env, goal, project);
    const cards = withAcc.cards;
    let ask = withAcc.ask;
    const plan = savedFromCards(cards, { goal, url: env.url, ...(previous ? { previous } : {}) });
    // Login cards sign in as their account (labels only; C20b resolves the values). Only where accounts may sign in.
    const login = cards.find((c) => c.enabled && c.kind === "login" && c.accountLabel);
    let as = login?.accountLabel;
    // No Login card at all: the test's own account, or the one its goal signs in as, signs in first. A Login
    // card switched off is the person's say that it runs signed out: never signed in for behind their back.
    if (!as && !cards.some((c) => c.kind === "login")) {
      const own = testAccount(env, goal, account ?? (previous?.visitor ? undefined : previous?.as), project);
      as = own.label;
      ask ??= own.ask;
    }
    if (ask && askNow) throw new DataError(409, ask);
    return { goal, url: env.url, cards, ...(previous ? { previous } : {}), replayable: !plan.test.draft, envId: env.id, ...(as ? { as } : {}), ...(ask ? { blocked: { reason: `ACCOUNT_NOT_CHOSEN: ${ask}`, code: "ACCOUNT_NOT_CHOSEN" as const } } : {}) };
  };

  /** A login card runs only where accounts may sign in: owned, or the person said it's their own account. */
  const refuseLoginWithoutOk = (cards: PlanStep[] | undefined, env: Environment, account?: string) => {
    if (!env.owned && !env.signInOk && (account || cards?.some((c) => c.enabled && c.kind === "login"))) throw new DataError(409, `A login step signs in only where you've said it's your own account, and you haven't for ${new URL(env.url).host}. Confirm it under Accounts, or switch the login step off.`);
  };

  const startRun = async (r: StartRunRequest, noAi = false): Promise<string> => {
    const source = r.source;
    let items: AppItem[];
    if (r.test) {
      refuseLoginWithoutOk(r.steps ?? r.test.steps, r.env, r.test.account);
      // Run from the editor (its steps sent): an account it can't pick is asked there. A saved test run from a list: BLOCKED.
      items = [itemForTest(r.project, r.env, r.test, source, r.steps, Boolean(r.steps))];
    } else if (r.steps) {
      refuseLoginWithoutOk(r.steps, r.env);
      items = [{ ...cardsItem(r.steps, r.env, r.goal ?? r.steps.find((s) => s.enabled)?.title ?? "A test", undefined, r.project, true), source }];
    } else if (r.groupId) {
      const group = data.store.groups(r.project.id).find((g) => g.id === r.groupId);
      const tests = (group?.testIds ?? []).flatMap((id) => {
        try {
          return [data.tests.get(id).test];
        } catch {
          return [];
        }
      });
      if (!tests.length) throw new DataError(400, "That group has no tests yet.");
      for (const t of tests) refuseLoginWithoutOk(t.steps, r.env, t.account);
      items = tests.map((t) => itemForTest(r.project, r.env, t, source));
    } else if (r.all) {
      // "Run all": every test in the project, each signing in as its account (no one to ask: BLOCKED).
      const tests = data.tests.list(r.project.id);
      if (!tests.length) throw new DataError(400, "This project has no tests yet.");
      for (const t of tests) refuseLoginWithoutOk(t.steps, r.env, t.account);
      items = tests.map((t) => itemForTest(r.project, r.env, t, source));
    } else if (r.goal) {
      // Run straight from the goal: a goal that signs in signs in as the account that fits first (the
      // engine then starts signed in), never typing values it would have to make up.
      const goal = r.goal.slice(0, 500);
      const accounts = accountsOn(r.env);
      let as: string | undefined;
      // Not a goal about being signed out, a sign-in meant to fail, or only a visit to the sign-in page.
      if (accounts.length && (goalSignsIn(goal) || (namedIn(goal, accounts) && !NOT_SIGNING_IN.test(goal)))) {
        const pick = pickAccount({ goal, ...(r.project.defaultAccount ? { defaultAccount: r.project.defaultAccount } : {}), accounts });
        if ("ask" in pick) throw new DataError(409, pick.ask);
        if ("label" in pick) as = pick.label;
      } else {
        // A goal quiet about signing in ("add a trade") runs as the account that's clear, so a site behind a
        // sign-in is tested signed in instead of the tester meeting its sign-in page with no account to use.
        as = quietAccount({ goal, ...(r.project.defaultAccount ? { defaultAccount: r.project.defaultAccount } : {}), accounts });
      }
      items = [{ goal, url: r.env.url, envId: r.env.id, source, ...(as ? { as } : {}) }];
    } else throw new DataError(400, "Say what to run.");
    if (host.busy()) throw new DataError(409, "A test is running: stop it first, or wait for it to end.");
    host.run(items, { noAi });
    // The run's own id comes with its `run` event once it is written; until then the job runs live on #/p/:pid/live.
    return `run_pending_${host.nextId()}`;
  };

  /** Schedules (C18): the scheduler calls this only when nothing runs; saved steps only, no AI, every gate on (C25). */
  const startScheduled = (job: ScheduledJob): string | undefined => {
    const project = data.store.project(job.projectId);
    const env = data.store.envFor(project.id, job.envId);
    const all = data.tests.list(project.id);
    const tests = "group" in job.target ? (data.store.groups(project.id).find((g) => g.id === (job.target as { group: string }).group)?.testIds ?? []).map((id) => all.find((t) => t.id === id)).filter((t): t is TestDef => Boolean(t)) : "test" in job.target ? all.filter((t) => t.id === (job.target as { test: string }).test) : all;
    if (!tests.length) throw new Error("This schedule has no tests to run.");
    // No run waits for a person (A1): a sign-in that needs a code no one can read ends BLOCKED CODE_NEEDS_PERSON, never PASS.
    const items = tests.filter((t) => env.owned || env.signInOk || !t.account && !t.steps.some((s) => s.enabled && s.kind === "login")).map((t) => itemForTest(project, env, t, "scheduled"));
    if (!items.length) throw new Error("Every test here signs in, and you haven't said you sign in on this address.");
    host.run(items, { noAi: true });
    return undefined;
  };

  const plan = async (r: { project: { instructions?: string; context?: string }; env: Environment; goal: string }): Promise<PlanStep[]> => {
    if (!host.ai) throw new DataError(400, NEEDS_AI);
    if (host.busy()) throw new DataError(409, "A test is running: stop it first, or wait for it to end.");
    let out: Awaited<ReturnType<typeof planTest>> | undefined;
    let failed: string | undefined;
    const ai = host.ai;
    const j = host.begin("suggest", async (job) => {
      try {
        host.emit({ type: "phase", words: "Looking at the site to plan the steps" });
        job.browser = await host.launch(host.headed);
        const noted: AskTiming[] = [];
        // The notes as a run takes them: checked again here (a context.md edited by hand or pulled from git may be
        // over the limit or hold a secret), refused whole with why, never cut.
        const notesWrong = r.project.context ? notesProblem(r.project.context, Object.values(host.vars)) : undefined;
        if (notesWrong) host.emit({ type: "phase", words: `Your notes about this site weren't used: ${notesWrong}` });
        const siteNotes = notesWrong ? undefined : r.project.context;
        out = await planTest({ goal: r.goal, url: r.env.url, brain: aiBrain(timedAi(ai, noted, Date.now()), Object.keys(host.vars), host.measuredOnly ? { measuredOnly: true } : {}), browser: job.browser, allowHosts: host.allowHosts, vars: host.vars, mask: host.mask, ...(host.measuredOnly ? { measuredOnly: true } : {}), ...(r.project.instructions ? { instructions: r.project.instructions } : {}), ...(siteNotes ? { siteNotes } : {}) });
      } catch (error) {
        failed = job.abort.signal.aborted ? "Stopped." : host.mask(error instanceof Error ? error.message.split("\n")[0]! : String(error));
      }
    });
    await j.done;
    if (failed) throw new DataError(400, failed.replace(/^\w/, (c) => c.toUpperCase()));
    if (!out) throw new DataError(400, "Nothing was planned.");
    if (out.blocked) throw new DataError(400, `${out.blocked} stands in front of the start page, so nothing was planned. Context Machines never answers a bot check.`);
    return out.steps;
  };

  /** "Suggest tests": one look at the site (lookAt) and one AI ask (suggestTasks), as the terminal's --suggest. */
  const suggest = async (r: { env: Environment; goals: string[] }): Promise<{ goal: string; area: string }[]> => {
    if (!host.ai) throw new DataError(400, NEEDS_AI);
    if (host.busy()) throw new DataError(409, "A test is running: stop it first, or wait for it to end.");
    let tasks: { goal: string; area: string }[] = [];
    let failed: string | undefined;
    const ai = host.ai;
    const j = host.begin("suggest", async (job) => {
      try {
        host.emit({ type: "phase", words: "Looking at the site" });
        job.browser = await host.launch(host.headed);
        const look = await lookAt(r.env.url, { browser: job.browser, allowHosts: host.allowHosts });
        host.emit({ type: "phase", words: "Asking the AI for tests" });
        tasks = await suggestTasks(timedAi(ai, [], Date.now()), look, r.goals);
      } catch (error) {
        failed = job.abort.signal.aborted ? "Stopped." : error instanceof BotWalled ? `${error.check} stands in front of the site, so nothing was suggested. Context Machines never answers a bot check.` : host.mask(error instanceof Error ? error.message.split("\n")[0]! : String(error));
      }
    });
    await j.done;
    if (failed) throw new DataError(400, failed.replace(/^\w/, (c) => c.toUpperCase()));
    if (!tasks.length) throw new DataError(400, "The AI suggested no test a signed-out visitor can do safely here: describe one instead.");
    return tasks.map((t) => ({ goal: host.mask(t.goal), area: host.mask(t.area) }));
  };

  /** Discovery (E8): one crawl job on the chosen environment's origin only; findings filed as issues. */
  const startExplore = async (r: StartExploreRequest): Promise<string> => {
    if (host.busy()) throw new DataError(409, "A test is running: stop it first, or wait for it to end.");
    const url = r.env.url;
    host.begin("run", async (j) => {
      const jobId = `j${host.nextId()}`;
      const id = `r${host.nextId()}`;
      const goal = "Explore the site and find bugs";
      const startedAt = new Date().toISOString();
      host.emit({ type: "job", id: jobId, explore: true, tests: [{ id, goal, url: publicUrl(url), area: "", replay: false }] });
      j.browser = await host.launch(host.headed);
      const { runsDir, runDir } = newRunDir(host.outDir, goal);
      host.runDirs.set(id, runDir);
      host.emit({ type: "test", id, at: Date.now(), safety: "Signed out, on this address only: it opens pages and presses buttons that only show things. Anything that would send, pay, post or delete is stopped before it goes." });
      let cast: Screencast | undefined;
      let report: ExploreRun;
      try {
        report = await explore({
          url, origins: [url], browser: j.browser, dir: runDir, limits: r.limits, mask: host.mask, signal: j.abort.signal,
          onPage: async (page) => {
            cast = await screencast(page, (f) => host.emit({ type: "frame", id, jpeg: f.jpeg, url: publicUrl(host.mask(f.url)) || host.mask(f.url) }));
          },
          // The live screen has no step list for a crawl (pages are found as it goes): it shows each page and
          // finding as the phase line, and the full page list once the result comes.
          on: (e) => {
            const words = e.type === "phase" ? e.words : e.type === "page" ? `Page ${e.n}: ${e.path}` : e.type === "working" ? e.words : e.type === "finding" ? `Found: ${e.finding.title}` : "";
            if (words) host.emit({ type: "ev", id, e: { type: "phase", words } });
          },
        });
      } finally {
        await cast?.stop();
      }
      const result = exploreResult(report, url, startedAt);
      const summary = exploreSummary(report, [new URL(url).host]);
      writeRun(runsDir, runDir, result, { tokens: "no AI", totals: undefined });
      host.emit({ type: "result", id, result: { ...result, url: publicUrl(result.url) }, ...(result.video ? { video: host.fileUrl(id, result.video) } : {}), report: host.fileUrl(id, "report.html"), shots: {}, stepUrls: {}, folder: relative(process.cwd(), runDir) || runDir, tokens: "no AI", summary });
      written(id, runDir, { source: "explore", envId: r.env.id, findings: report.findings, log: report.log });
      host.emit({ type: "jobEnd", id: jobId, ms: report.ms, summary, counts: { [result.verdict]: 1 }, replay: false, sites: 1, stuck: [] });
    });
    return `run_pending_${host.nextId()}`;
  };

  // `ui --out <dir>`: the project in the folder the server started in has its runs there.
  OUT_DIRS.set(resolve(host.projectDir), host.outDir);
  const data = createDataApi({
    dataDir: join(host.outDir, "app"),
    defaultDir: host.projectDir,
    // D12: owned is read live from accounts.ts, never trusted from the page or the file.
    isOwned: (outDir, hostName) => isMine(outDir, hostName),
    // Accounts may sign in: owned, or the person said it's their own account there (signin-ok.json). Never "owned".
    isSignInOk: (outDir, hostName) => signInAllowed(outDir, hostName),
    secrets: () => ({ ...host.vars }),
    accounts: (p, env) => {
      const url = env?.url ?? p.url;
      const v = host.accountsView(url);
      if (!v.ok || !v.accounts) return [];
      return v.accounts.map((a): AccountSummary => {
        const age = sessionAge(sessionPathFor(host.outDir, url, a.label));
        return { label: a.label, host: v.host ?? "", firstStep: a.first, ...(a.whenToUse ? { whenToUse: a.whenToUse } : {}), ...(age === undefined ? {} : { session: { ageMs: age, fresh: age < SESSION_MAX_AGE_MS } }), ...(a.first === "password" && !a.set.password ? { problem: "No password stored" } : {}) };
      });
    },
    setup: async () => ({
      ai: host.ai ? { via: host.ai.via, ready: true, words: `Using ${host.ai.via}.` } : { via: null, ready: false, words: NO_AI_WORDS },
      browser: browserReady(),
      ...(practice ? { practiceUrl: practice.url } : {}),
    }),
    plan: (r) => plan(r),
    suggest: (r) => suggest(r),
    own: (r) => {
      if (!host.accountsChange) throw new DataError(501, "Marking a site as yours isn't wired into this server yet.");
      const [status, body] = host.accountsChange("mine", { url: r.env.url, yes: true });
      if (status !== 200) throw new DataError(status, String((body as { error?: string }).error ?? "It couldn't be marked as yours."));
    },
    signInSetup: (r) => {
      if (!host.accountsChange) throw new DataError(501, "Set up sign-in isn't wired into this server yet.");
      const [status, body] = host.accountsChange("setup", { url: r.env.url, label: r.label });
      if (status !== 200) throw new DataError(status, String((body as { error?: string }).error ?? "It couldn't start."));
    },
    signInOk: (r) => {
      if (!host.accountsChange) throw new DataError(501, "Confirming your own account isn't wired into this server yet.");
      const [status, body] = host.accountsChange("signin-ok", { url: r.env.url, yes: true });
      if (status !== 200) throw new DataError(status, String((body as { error?: string }).error ?? "It couldn't be confirmed."));
    },
    saveAccount: (r) => {
      if (!host.accountsChange) throw new DataError(501, "Adding an account isn't wired into this server yet.");
      const said = (x: [number, unknown]) => {
        if (x[0] !== 200) throw new DataError(x[0], String((x[1] as { error?: string }).error ?? "It couldn't be saved."));
      };
      said(host.accountsChange("save", { url: r.env.url, label: r.label, first: "password", ...(r.username ? { username: r.username } : {}) }));
      if (r.password) said(host.accountsChange("secret", { url: r.env.url, label: r.label, field: "password", value: r.password }));
    },
    startRun: (r) => startRun(r),
    explore: (r) => startExplore(r),
    stop: () => host.stop(),
    // "Set up sign-in" (A1): the person's Done or Give up for the window on their computer. Nothing else.
    handover: {
      done: async (id) => {
        if (!handOver.done(id).ok) throw new DataError(409, "That sign-in setup is no longer waiting for you.");
      },
      cancel: async (id) => {
        if (!handOver.cancel(id).ok) throw new DataError(409, "That sign-in setup is no longer waiting for you.");
      },
    },
    runner: { busy: () => host.busy(), start: (j) => startScheduled(j) },
    // The data lane's `run` event carries the app run id as its id; ui-server sends its own with the live test id (written()).
    emit: (e) => {
      if (e.type !== "run") host.emit(e as never);
    },
  });

  /** After a run's result.json is written: index it, file its issues, keep the cards' clicks, tell the page. */
  const written = (liveId: string, runDir: string, meta: { source?: RunSource; testId?: string; envId?: string; plan?: PlanStep[]; findings?: ExploreFinding[]; log?: AppLogEntry[]; aiAsks?: number }) => {
    // A saved test's run is titled with the test's name, as the Tests list shows it, not its goal.
    let name: string | undefined;
    try {
      name = meta.testId ? data.tests.get(meta.testId).test.name : undefined;
    } catch {
      name = undefined;
    }
    try {
      const { summary } = data.onRunWritten(runDir, { source: meta.source ?? "manual", ...(name ? { name } : {}), ...(meta.testId ? { testId: meta.testId } : {}), ...(meta.envId ? { envId: meta.envId } : {}), ...(meta.plan ? { plan: meta.plan } : {}), ...(meta.findings ? { findings: meta.findings } : {}), ...(meta.log?.length ? { log: meta.log } : {}), ...(meta.aiAsks !== undefined ? { aiAsks: meta.aiAsks } : {}) });
      if (!summary) return;
      host.emit({ type: "run", id: liveId, summary });
      if (summary.verdict === "fail" && opts.notify && data.store.settings().notifyOnFail) opts.notify("A test failed", `${summary.name}: ${summary.reason ?? "it failed"}`);
    } catch {
      // The run is on disk either way; the app's index catches up on its next read.
    }
  };

  return {
    data,
    handOver,
    /** ui-server's run(), for an item with cards: runs them as they are (runPlan), the result with every card. */
    runCards(t: AppItem) {
      return async (o: RunOptions): Promise<RunOutcome> => {
        const { saved: _saved, ...rest } = o;
        const { cards, signInWords, skipped } = signedInFirst(t.cards!, t.as);
        const out = await runPlan({ ...rest, cards, ...(signInWords ? { signInWords } : {}), ...(t.previous ? { previous: t.previous } : {}) });
        t.planRun = out.plan;
        // The steps before the login card weren't switched off by the person: they were passed by signing in first.
        // (A test planned again from its goal shows the new plan's steps: no card was skipped in it.)
        const shown = skipped.size && !out.replanned ? { ...out.shown, steps: out.shown.steps.map((st, i) => (skipped.has(i) ? { ...st, reason: `not run: the test signed in as ${t.as} before it started` } : st)) } : out.shown;
        if (out.replanned) t.replanned = true;
        const { shown: _shown, plan: _plan, replanned: _replanned, ...outcome } = out;
        return { ...outcome, result: shown };
      };
    },
    /**
     * Extra run options by their engine-lane names (E1 onLog, E10 onProtection). A run never waits for a
     * person (A1): a check, a code or a link ends it BLOCKED, whoever is watching, as a schedule's would.
     */
    runExtras(liveId: string, _t: AppItem): object {
      return {
        // E1 masks its lines; masked again here (--var values) before they reach the page or the replay.
        onLog: (entry: AppLogEntry) => host.emit({ type: "log", id: liveId, entry: { ...entry, text: host.mask(String(entry.text ?? "")), ...(entry.url ? { url: host.mask(entry.url) } : {}) } }),
        onProtection: (finding: ProtectionFinding) => host.emit({ type: "protection", id: liveId, finding }),
      };
    },
    /** After writeRun in ui-server's job loop. */
    afterRun(liveId: string, t: AppItem, runDir: string, result: TestResult, save: RunOutcome["save"], aiAsks?: number) {
      // A test planned again from its goal (its saved clicks were recorded under older rules and couldn't do
      // what its cards say) that passed: its cards become the new plan's steps, with their clicks, so the
      // next run replays them with no AI. Its name and the account it signs in as are kept.
      if (t.testId && t.replanned && save && result.verdict === "pass") {
        try {
          data.tests.takePlan(t.testId, save.steps, save.planRules, undefined, save.notes);
        } catch {
          // a learned test (not held by the app) has its new steps in its own file, already written
        }
      } else if (t.testId && t.planRun && save && result.verdict === "pass") {
      // A pass keeps the cards' new clicks with the test (by card id), so the next run replays them.
        const byCard: Record<string, unknown[]> = {};
        for (const [k, cardIndex] of t.planRun.order.entries()) {
          const card = t.cards?.[cardIndex];
          const actions = save.steps[k]?.actions;
          if (card && actions) byCard[card.id] = actions;
        }
        try {
          data.tests.takeActions(t.testId, byCard);
        } catch {
          // a learned test (not held by the app) keeps its clicks in its own file, already written
        }
      }
      const log = (result as TestResult & { log?: AppLogEntry[] }).log;
      written(liveId, runDir, { ...(t.source ? { source: t.source } : {}), ...(t.testId ? { testId: t.testId } : {}), ...(t.envId ? { envId: t.envId } : {}), ...(t.cards && !t.replanned ? { plan: t.cards } : {}), ...(log ? { log } : {}), ...(aiAsks !== undefined ? { aiAsks } : {}) });
    },
    /** The folder of an app run id (run_…), for /files/<token>/<runId>/<name>. */
    dirOf(runId: string): string | undefined {
      if (!/^run_[0-9a-f]{12}$/.test(runId)) return undefined;
      try {
        return data.history.locate(runId).dir;
      } catch {
        return undefined;
      }
    },
    start() {
      data.scheduler.start();
    },
    async close() {
      data.scheduler.stop();
      await practice?.close().catch(() => {});
    },
  };
}

export type App = ReturnType<typeof createApp>;
