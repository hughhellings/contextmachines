/**
 * `npx contextmachines ui` (or `test --ui`): the tester in a local web page, side by side like
 * TesterArmy. The steps tick off on the left, the live browser shows on the right, and when a test
 * ends the right side becomes its video with a "Go to" for every step.
 *
 * One engine: the page asks this server, which calls the same functions the terminal does (lookAt,
 * suggestTasks, runTest, writeRun, writeSaved), with the same safety rules, budgets and masking, and
 * writes the same files (runs/, tests/). No new dependency: Node's own http, server-sent events for
 * what happens, and JSON POSTs for what the person asks.
 *
 * It is a local server that can drive a browser, so it is locked down:
 * - it listens on 127.0.0.1 only, on a free port;
 * - every request needs the random token (in the URL for what the page loads, in a header for its asks);
 * - the Host header must be this server's own (127.0.0.1:<port> or localhost:<port>): a page on
 *   another site that points its own name at 127.0.0.1 (DNS rebinding) is refused;
 * - anything that changes something is a POST with the token in the x-cm-token header, JSON only, and
 *   from this page's own origin; a GET never starts or stops anything;
 * - the page loads nothing from the web, and every word from a site or an AI is shown as text, never as HTML.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join, relative } from "node:path";
import type { Browser } from "playwright";
import { hasSaved, listSaved, readSaved, savedPathFor, varsUsed, withoutSecrets, writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { BLOCKED_BY_WALL, BotWalled, WALL_NOT_RUN } from "../packages/scanner/src/tester/botwall.ts";
import { lookAt } from "../packages/scanner/src/tester/look.ts";
import { launch as launchBrowser } from "../packages/scanner/src/tester/record.ts";
import { DEFAULTS, newSignInGuard, runTest, STOPPED_BY_YOU, type RunOutcome } from "../packages/scanner/src/tester/run.ts";
import { placeholderNames, type Masker } from "../packages/scanner/src/tester/placeholders.ts";
import { accountHostsFor, createdAccounts, defaultStore, fieldValue, FIRST_STEPS, forgetSession, isMine, loadAccounts, markMine, markSignInOk, signInAllowed, MIN_SECRET_LENGTH, saveAccountForm, secretKey, sessionAge, sessionPathFor, siteAccessShown, TEST_ADDRESS, type Account, type FirstStep, type SecretStore } from "./accounts.ts";
import { maskAddress } from "./accounts-command.ts";
import { parseTotpSecret } from "../packages/scanner/src/tester/totp.ts";
import { accountFor, clerkKeepHostFor, ensureSession, runSignedIn, signedInCheckFor, signInByHand, siteAccessFor, type AccountUse, type SessionNeed } from "./signin.ts";
import { screencast, type Screencast, type ScreencastOptions } from "../packages/scanner/src/tester/screencast.ts";
import { CouldNotRun, type TestEvent, type TestResult } from "../packages/scanner/src/tester/types.ts";
import { aiTotals, timedAi, withAskSignal, type Ai, type AskTiming } from "./ai.ts";
import { publicUrl, redact, startUrl } from "./report.ts";
import { openerFor, openFile } from "./hand-off.ts";
import type { Colors } from "./term.ts";
import { accountSecrets, siteNotesFor } from "./knowledge.ts";
import { aiBrain, authPathFor, newRunDir, sessionHint, suiteSummary, writeRun } from "./test-command.ts";
import { EXPLORE_MINUTES, savedGoals, stuckAcross, suggestedPathFor, suggestTasks, taskCounts, tasksFrom, writeExplorePage, writeSuggested, type Task, type TaskEntry } from "./test-tasks.ts";
import { tokenCount } from "./term.ts";
import { a11yAcross, a11yGroups, a11yNotes, a11ySummary, type A11yResult } from "../packages/scanner/src/tester/a11y.ts";
import { uiPage } from "./ui-page.ts";
import { appPage, orderScreens } from "./app/ui/shell/page.ts";
import { runOverlays, runScreens } from "./app/ui/run/index.ts";
import { startPracticeSite } from "./app/sites/index.ts";
import { blockedResult, createApp, macNotify, type AppItemFields, type AppOptions } from "./app/wire.ts";

export interface UiOptions {
  outDir: string;
  testsDir: string;
  ai: Ai | undefined;
  vars: Record<string, string>;
  mask: (s: string) => string;
  allowHosts: string[];
  headed: boolean;
  maxActions: number;
  /** --minutes as given: per test, or explore's whole budget. */
  minutes?: number;
  /** The address to start with in the URL box. */
  url?: string;
  /** A port to listen on (0 or none: a free one). */
  port?: number;
  /** How the browser starts: launch() unless a test gives another. */
  launch?: (headed: boolean) => Promise<Browser>;
  screencast?: ScreencastOptions;
  /** How long a check waits for the page (tests make it short). */
  checkWaitMs?: number;
  /** How long a bot check is waited on to clear by itself (tests make it short). */
  wallWaitMs?: number;
  /** The project folder, where contextmachines.config.json is (default: where it was started). */
  projectDir?: string;
  /** Where account and site secrets are kept (default: the Keychain on a Mac; tests pass a file store). */
  store?: SecretStore;
  /** The environment secrets may also come from (default: the process's). */
  env?: NodeJS.ProcessEnv;
  /** --measured-only: no check is judged by an AI. */
  measuredOnly?: boolean;
  /** The app (cli/app): the practice site and the Mac notification. The `ui` command turns both on; tests leave them off. */
  app?: AppOptions;
  /** This server can't open a window on the person's own computer (a hosted one): Set up sign-in answers 409. */
  noWindow?: boolean;
}

export interface UiServer {
  /** The address to open: with the token in it. */
  url: string;
  origin: string;
  token: string;
  port: number;
  /** Stops any run (closing its browser), ends the event streams and closes the server. */
  close(): Promise<void>;
}

/** The token, as long as the person's own session would want: 32 random bytes, hex. */
export const newToken = () => randomBytes(32).toString("hex");

/** Whether a request's token is the server's: the same length and bytes, compared in constant time. */

/**
 * The safety line the page shows, true to the run it is about (C21): "signed out" only when no
 * account or saved session is in use.
 */
export function safetyLine(signedIn?: { host: string; label?: string }): string {
  if (!signedIn) return "Signed out, on the site you give: it never signs in, buys, posts, comments, likes, subscribes, sends or deletes.";
  const who = signedIn.label ? `Signed in as ${signedIn.label} on ${signedIn.host}` : `Signed in on ${signedIn.host}, with the session saved for it`;
  return `${who}. It won't press buy, post, comment, like, subscribe, send or delete buttons. It can still change this account's data. Use a test account or staging.`;
}

export function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request's Host header names this server: 127.0.0.1 or localhost on its own port. Anything
 * else is a page on another name that resolved to this machine (DNS rebinding), and is refused.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** What a file in a run's folder may be called, to be served: no folders, no dots first. */
const SERVABLE = /^(?!\.)[\w.-]+\.(webm|jpg|jpeg|png|html|json)$/;
const TYPES: Record<string, string> = { webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", html: "text/html; charset=utf-8", json: "application/json" };

const BODY_MAX = 64 * 1024;
/** A task isn't started with less than this left of explore's budget (as the terminal does). */
const LEAST_FOR_A_TASK_MS = 45_000;

type UiEvent = Record<string, unknown> & { type: string };

interface Job {
  kind: "suggest" | "run";
  abort: AbortController;
  browser?: Browser;
  /** Settles when the job's work is over (its browser closed). */
  done: Promise<void>;
}

/** One test to run in a job: a suggested task (a visitor's), a goal typed in, a saved test, or the app's step cards. */
interface Item extends AppItemFields {
  goal: string;
  url: string;
  area?: string;
  visitor?: boolean;
  saved?: SavedTest;
  /** A saved test's file: a healed pass rewrites it. */
  file?: string;
  /** The test account it runs as (picked in the page), for a goal typed in or a task ticked. */
  as?: string;
}

export async function startUi(o: UiOptions): Promise<UiServer> {
  const token = newToken();
  const launch = o.launch ?? launchBrowser;
  const store = o.store ?? defaultStore(o.outDir);
  const projectDir = o.projectDir ?? process.cwd();
  let port = 0;
  let origin = "";
  /** Everything said so far (but frames), so a page opened late (or reloaded) shows the same. */
  const log: UiEvent[] = [];
  /** Each run's latest frame: sent to a page that connects mid-run. */
  const lastFrame = new Map<string, UiEvent>();
  const clients = new Set<ServerResponse>();
  /** Each run's folder, by its id, for its video, photos and report. */
  const runDirs = new Map<string, string>();
  let job: Job | undefined;
  let seq = 0;
  /**
   * The list of suggested tasks on show, by its id: "Run selected" names the list it was ticked on,
   * and a list replaced since (a new Suggest) is refused, so ticks made on an old list never run
   * another list's tasks.
   */
  let list: { id: string; url: string; tasks: Task[] } | undefined;

  const send = (res: ServerResponse, e: UiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  let logLines = 0;
  const emit = (e: UiEvent) => {
    if (e.type === "frame") lastFrame.set(String(e.id), e);
    // App-log lines (E1) are replayed to a page opened late only up to a cap: the result carries the full log.
    else if (e.type !== "log" || logLines++ < 1000) log.push(e);
    for (const res of clients) send(res, e);
  };

  const savedList = () =>
    listSaved(o.testsDir).flatMap((file) => {
      try {
        const t = readSaved(file);
        return [{ file: relative(o.testsDir, file).split("\\").join("/"), goal: t.goal, url: publicUrl(t.url), host: basename(dirname(file)), ...(t.draft ? { draft: true } : {}), ...(t.visitor ? { visitor: true } : {}) }];
      } catch {
        return [];
      }
    });
  const fileUrl = (id: string, name: string) => `/files/${token}/${id}/${encodeURIComponent(name)}`;

  emit({ type: "hello", ai: o.ai ? o.ai.via : null, url: o.url ? publicUrl(o.url) : "", saved: savedList(), safety: safetyLine() });

  // -------------------------------------------------------------------------------------------
  // The jobs: suggest tasks, run tests. One at a time.

  const begin = (kind: Job["kind"], work: (j: Job) => Promise<void>): Job => {
    let finish!: () => void;
    const j: Job = { kind, abort: new AbortController(), done: new Promise<void>((r) => (finish = r)) };
    job = j;
    emit({ type: "busy", busy: kind });
    void (async () => {
      try {
        // Every AI ask in the job stops with it: an agent asked is killed, not left answering.
        await withAskSignal(j.abort.signal, () => work(j));
      } catch (error) {
        emit({ type: "error", words: j.abort.signal.aborted ? "Stopped." : redact(o.mask(error instanceof Error ? error.message.split("\n")[0]! : String(error))) });
      } finally {
        await j.browser?.close().catch(() => {});
        if (job === j) job = undefined;
        emit({ type: "busy", busy: null });
        finish();
      }
    })();
    return j;
  };

  /**
   * The work, or a stop: whichever comes first. A stopped job doesn't wait for an AI's answer or a
   * page still loading; what was left running fails on the closed browser, and is let go.
   */
  const untilStopped = <T>(j: Job, work: Promise<T>): Promise<T> => {
    work.catch(() => {});
    if (j.abort.signal.aborted) return Promise.reject(new Error(STOPPED_BY_YOU));
    return Promise.race([work, new Promise<never>((_, reject) => j.abort.signal.addEventListener("abort", () => reject(new Error(STOPPED_BY_YOU)), { once: true }))]);
  };

  const suggest = (url: string) => {
    // The list on show is gone the moment a new one is asked for: nothing ticked on it runs.
    list = undefined;
    emit({ type: "tasks", url: "", tasks: [], list: null });
    return begin("suggest", async (j) => {
      if (!o.ai) throw new Error("Suggesting tasks needs an AI: sign in to Claude Code or Codex, or set an API key, then start this again.");
      emit({ type: "phase", words: "Looking at the site" });
      j.browser = await launch(o.headed);
      let look: Awaited<ReturnType<typeof lookAt>>;
      try {
        look = await untilStopped(j, lookAt(url, { browser: j.browser, allowHosts: o.allowHosts, ...(o.wallWaitMs !== undefined ? { wallWaitMs: o.wallWaitMs } : {}) }));
      } catch (error) {
        if (!(error instanceof BotWalled) || j.abort.signal.aborted) throw error;
        // A bot check that stayed: a card on the start screen with the wall's photo, not an error. Nothing is suggested.
        emit({ type: "botwall", url: publicUrl(url), host: error.host, check: error.check, title: BLOCKED_BY_WALL, words: o.mask(error.message), ...(error.shot ? { shot: error.shot.toString("base64") } : {}) });
        return;
      }
      if (j.abort.signal.aborted) return;
      await j.browser.close().catch(() => {});
      j.browser = undefined;
      emit({ type: "phase", words: "Asking the AI for tasks" });
      const noted: AskTiming[] = [];
      const tasks = await untilStopped(j, suggestTasks(timedAi(o.ai, noted, Date.now()), look, savedGoals(o.testsDir, url)));
      if (j.abort.signal.aborted) return;
      if (!tasks.length) throw new Error("The AI suggested no task a signed-out visitor can do safely on this site: type a goal instead.");
      writeSuggested(suggestedPathFor(o.outDir, url), url, tasks);
      list = { id: `l${++seq}`, url, tasks };
      emit({ type: "tasks", url: publicUrl(url), tasks, list: list.id, looked: { pages: 1 + look.pages.length, ms: look.ms, ...(look.consent ? { consent: look.consent } : {}) } });
    });
  };

  const run = (items: Item[], explore: boolean, opts: { signUp?: boolean; noAi?: boolean } = {}) =>
    begin("run", async (j) => {
      const jobId = `j${++seq}`;
      const tests = items.map((it) => ({ ...it, id: `r${++seq}` }));
      const begun = Date.now();
      const budgetMs = (o.minutes ?? EXPLORE_MINUTES) * 60_000;
      const perTask = explore ? DEFAULTS.minutes : (o.minutes ?? DEFAULTS.minutes);
      const noted: AskTiming[] = [];
      const timed = o.ai && !opts.noAi ? timedAi(o.ai, noted, begun) : undefined;
      emit({ type: "job", id: jobId, explore, tests: tests.map((t) => ({ id: t.id, goal: o.mask(t.goal), url: publicUrl(t.url), area: t.area ?? "", replay: Boolean(t.saved) })) });
      const entries: TaskEntry[] = [];
      /** One sign-in guard for the whole job: a refused password stops that account for every test after it. */
      const guard = newSignInGuard();
      /** Sites whose bot check stopped a test: the rest of their tests aren't started. */
      const walled = new Set<string>();
      /** Each host's owner access (C15), worked out once for the job. */
      const sites = new Map<string, Awaited<ReturnType<typeof siteAccessFor>>>();
      for (const [i, t] of tests.entries()) {
        const n = i + 1;
        const task: Task = { goal: t.goal, area: t.area ?? "" };
        if (walled.has(new URL(t.url).host)) {
          emit({ type: "notrun", id: t.id, words: `not run: ${WALL_NOT_RUN}`, wall: true });
          entries.push({ task, n, notRun: WALL_NOT_RUN, ms: 0 });
          continue;
        }
        if (j.abort.signal.aborted) {
          emit({ type: "notrun", id: t.id, words: STOPPED_BY_YOU });
          entries.push({ task, n, notRun: STOPPED_BY_YOU, ms: 0 });
          continue;
        }
        const left = begun + budgetMs - Date.now();
        if (explore && left < LEAST_FOR_A_TASK_MS) {
          const why = `the ${o.minutes ?? EXPLORE_MINUTES}-minute budget ran out first`;
          emit({ type: "notrun", id: t.id, words: why });
          entries.push({ task, n, notRun: why, ms: 0 });
          continue;
        }
        // Nothing said which account to sign in as, and no one is there to pick (a group, a schedule): BLOCKED, written as a run.
        if (t.blocked) {
          const { runsDir, runDir } = newRunDir(o.outDir, t.goal);
          runDirs.set(t.id, runDir);
          emit({ type: "test", id: t.id, at: Date.now(), safety: safetyLine() });
          const result = blockedResult(t);
          const written = writeRun(runsDir, runDir, result, { tokens: "no AI", totals: undefined });
          app.afterRun(t.id, t, runDir, result, undefined, 0);
          emit({ type: "result", id: t.id, result: { ...result, url: publicUrl(result.url) }, report: fileUrl(t.id, "report.html"), shots: {}, stepUrls: {}, folder: relative(process.cwd(), runDir) || runDir, tokens: "no AI" });
          entries.push({ task, n, result, report: written.report, ms: 0 });
          continue;
        }
        // A saved test made as a test account signs in as that account; a goal or task, as the account picked for it (never a visitor's test).
        const label = t.visitor || t.saved?.visitor ? undefined : (t.saved?.as ?? t.as);
        let use: Extract<AccountUse, { account: unknown }> | undefined;
        if (label) {
          const found = accountFor({ dir: projectDir, outDir: o.outDir, url: t.url, label, store, ...(o.env ? { env: o.env } : {}) });
          if ("error" in found) {
            // Change 1: a sign-in that can't start (not confirmed, a sign-up or a test code on a host that isn't
            // yours, no such account) is a BLOCKED run with its code and fix, written and listed like any run.
            if (found.code) {
              const { runsDir, runDir } = newRunDir(o.outDir, t.goal);
              runDirs.set(t.id, runDir);
              emit({ type: "test", id: t.id, at: Date.now(), safety: safetyLine() });
              const result = blockedResult({ goal: t.goal, url: t.url, ...(t.cards ? { cards: t.cards } : {}), blocked: { reason: o.mask(found.error.startsWith(`${found.code}: `) ? found.error : `${found.code}: ${found.error}`), code: found.code } });
              const written = writeRun(runsDir, runDir, result, { tokens: "no AI", totals: undefined });
              app.afterRun(t.id, t, runDir, result, undefined, 0);
              emit({ type: "result", id: t.id, result: { ...result, url: publicUrl(result.url) }, report: fileUrl(t.id, "report.html"), shots: {}, stepUrls: {}, folder: relative(process.cwd(), runDir) || runDir, tokens: "no AI" });
              entries.push({ task, n, result, report: written.report, ms: 0 });
              continue;
            }
            emit({ type: "couldnt", id: t.id, words: found.error });
            entries.push({ task, n, couldNot: found.error, ms: 0 });
            continue;
          }
          use = found;
        }
        const missing = (t.saved ? varsUsed(t.saved).filter((v) => !(v in o.vars)) : placeholderNames(t.goal).filter((v) => !(v in o.vars))).filter((v) => !use?.resolver.has(v));
        if (missing.length) {
          const why = `it types ${missing.map((v) => `{${v}}`).join(", ")}: start this with --var ${missing[0]}=… (or CM_VAR_${missing[0]!.toUpperCase()})`;
          emit({ type: "couldnt", id: t.id, words: why });
          entries.push({ task, n, couldNot: why, ms: 0 });
          continue;
        }
        // A saved test there for this goal is replayed, as the terminal does.
        let saved = t.saved;
        const savedPath = t.file ?? savedPathFor(o.testsDir, t.goal, t.url);
        if (!saved && !t.cards && hasSaved(savedPath)) {
          try {
            const there = readSaved(savedPath);
            if (there.goal === t.goal && there.url === withoutSecrets(t.url)) saved = there;
          } catch {
            // planned afresh; a pass replaces it
          }
        }
        if (!saved && !timed && !t.replayable) {
          const why = "a new test needs an AI to plan and act: sign in to Claude Code or Codex, or set an API key, then start this again";
          emit({ type: "couldnt", id: t.id, words: why });
          entries.push({ task, n, couldNot: why, ms: 0 });
          continue;
        }
        if (!j.browser) {
          // A browser still starting when Stop is pressed is closed as soon as it's up: never left running.
          const starting = launch(o.headed);
          starting.then((b) => (j.abort.signal.aborted ? b.close().catch(() => {}) : undefined), () => {});
          j.browser = await untilStopped(j, starting).catch((error: unknown) => {
            if (j.abort.signal.aborted) return undefined;
            throw error;
          });
        }
        if (!j.browser) {
          emit({ type: "notrun", id: t.id, words: STOPPED_BY_YOU });
          entries.push({ task, n, notRun: STOPPED_BY_YOU, ms: 0 });
          continue;
        }
        // C15: the owner's tokens for this host, sent only there (once per host in the job).
        const hostKey = new URL(t.url).host;
        if (!sites.has(hostKey)) sites.set(hostKey, await siteAccessFor({ dir: projectDir, outDir: o.outDir, url: t.url, store, ...(o.env ? { env: o.env } : {}) }));
        const site = sites.get(hostKey)!;
        if (site.error) {
          emit({ type: "couldnt", id: t.id, words: site.error });
          entries.push({ task, n, couldNot: site.error, ms: 0 });
          continue;
        }
        const { runsDir, runDir } = newRunDir(o.outDir, t.goal);
        runDirs.set(t.id, runDir);
        // A test that may type a stored value (a --var or an account's) keeps its live screen and video: the
        // engine's cover (cover.ts) draws every box a stored value goes into as dots, seen painted before the
        // first key (a card only where that can't be seen). The sign-in is shown too, live and in its own video.
        // (The engine has the last word, in onPage's info.noMedia: a run that keeps no media shows no screen.)
        const NO_SCREEN = "This run keeps no video, so there's no live screen.";
        // The safety line for this run, as it really starts: with the session saved for this host, or signed out.
        const startsSignedIn = !(t.visitor || saved?.visitor) && (Boolean(use) || existsSync(authPathFor(o.outDir, t.url)));
        emit({ type: "test", id: t.id, at: Date.now(), safety: safetyLine(startsSignedIn ? { host: new URL(t.url).host, ...(use ? { label: use.account.label } : {}) } : undefined) });
        let cast: Screencast | undefined;
        /** The address each step ended on, as the live screen showed it. */
        let lastUrl = "";
        const stepUrls: Record<number, string> = {};
        /** The address shown at each moment of the video (seconds from its start), from the live screen's frames: the video's address bar follows it. */
        const urls: { t: number; url: string }[] = [];
        let videoBegan = 0;
        // A saved session for the host (test --setup's) is loaded for a saved test that isn't a visitor's, as the terminal does; a visitor is always signed out.
        const visitor = Boolean(t.visitor || saved?.visitor);
        const authPath = use ? sessionPathFor(o.outDir, t.url, use.account.label) : authPathFor(o.outDir, t.url);
        const signedIn = !visitor && (Boolean(use) || existsSync(authPath));
        const hint = visitor || use ? undefined : sessionHint(o.outDir, t.url, false);
        const mask = o.mask as Masker;
        /** The sign-in's live screen (it runs as its own run, before the test's): stopped when it ends. */
        let signInCast: Screencast | undefined;
        const stopSignInCast = async () => {
          const was = signInCast;
          signInCast = undefined;
          await was?.stop();
        };
        /** The test, signed in as its account first when it has one, and once more if its session had expired. */
        const signedInRun = async (go: (session: string | undefined, again: boolean, signInVideo?: string) => Promise<RunOutcome>): Promise<RunOutcome> => {
          if (!use) return go(signedIn ? authPath : undefined, false);
          const label = use.account.label;
          const need: SessionNeed = {
            outDir: o.outDir, url: t.url, account: use.account, resolver: use.resolver, mask, guard, runsDir: join(o.outDir, "runs"), allowHosts: o.allowHosts, headed: o.headed, store,
            ...(j.browser ? { browser: j.browser } : {}),
            ...(timed ? { brain: aiBrain(timed, use.resolver.names(), { signIn: true, signedIn: signedInCheckFor(use.account) }) } : {}),
            ...(site.owner ? { owner: site.owner } : {}),
            ...(opts.signUp ? { allowSignUp: true } : {}),
            say: (words) => emit({ type: "ev", id: t.id, e: { type: "phase", words: mask(words) } }),
            // The sign-in's page, live: every box a stored value goes into is dots before the first key (cover.ts).
            onPage: async (page, info) => {
              await stopSignInCast();
              if (info.noMedia) return;
              signInCast = await screencast(page, (f) => emit({ type: "frame", id: t.id, jpeg: f.jpeg, url: publicUrl(o.mask(f.url)) || o.mask(f.url) }), { ...o.screencast, ...(info.fields ? { fields: info.fields } : {}), ...(info.covered ? { covered: true } : {}) });
            },
            onCover: (c) => {
              if (c.up) emit({ type: "ev", id: t.id, e: { type: "phase", words: `${c.words}: hidden in the live screen and the video` } });
            },
            on: (e) => {
              if (j.abort.signal.aborted) return;
              if (e.type === "action" || e.type === "stepEnd") void signInCast?.after();
            },
          };
          // C20b: the chip says who the run is signed in as; the live screen shows the sign-in's page, its boxes as dots.
          const age = sessionAge(sessionPathFor(o.outDir, t.url, label));
          emit({ type: "session", id: t.id, words: age !== undefined ? `Signed in as ${label} (session from ${ago(age)})` : `Signing in as ${label}…` });
          emit({ type: "signin", id: t.id, state: "start", words: `Signing in as ${label}…` });
          const createdBefore = createdAccounts(o.outDir).length;
          const first = await ensureSession(need).finally(stopSignInCast);
          emit({ type: "signin", id: t.id, state: "end" });
          for (const made of createdAccounts(o.outDir).slice(createdBefore)) emit({ type: "ev", id: t.id, e: { type: "phase", words: `Created ${maskAddress(made.address)} on ${made.host} (listed under Created accounts)` } });
          if ("blocked" in first) emit({ type: "session", id: t.id, words: `Not signed in as ${label}` });
          else emit({ type: "session", id: t.id, words: first.how === "saved" || first.how === "checked" ? `Signed in as ${label} (session from ${ago(age ?? 0)})` : `Signed in as ${label} (just now${first.how === "replayed" ? ", from saved steps, no AI" : ""})` });
          const ran = await runSignedIn(need, async (session, again, signInVideo) => {
            await stopSignInCast();
            return go(session, again, signInVideo);
          }, first).finally(stopSignInCast);
          // A sign-in the site refused (a wrong password, a locked account…) is a BLOCKED run with its code and fix,
          // written and listed like any run: never only a "couldn't run" line.
          if (!ran.outcome && "blocked" in ran.session) return { result: blockedResult({ goal: t.goal, url: t.url, ...(t.cards ? { cards: t.cards } : {}), blocked: { reason: mask(ran.session.blocked), code: ran.session.code } }) };
          if (!ran.outcome) throw new CouldNotRun("the sign-in didn't happen");
          return ran.outcome;
        };
        const asked = noted.length;
        const t0 = Date.now();
        const notesNow = siteNotesFor(o.outDir, undefined, [...Object.values(o.vars), ...accountSecrets(use ? { use } : {})]);
        if (notesNow.problem) emit({ type: "ev", id: t.id, e: { type: "phase", words: `Your notes about this site weren't used: ${notesNow.problem}` } });
        const siteNotes = notesNow.notes;
        let result: TestResult;
        let save: Awaited<ReturnType<typeof runTest>>["save"];
        try {
          ({ result, save } = await untilStopped(j, signedInRun((session, _again, signInVideo) => (t.cards ? app.runCards(t) : runTest)({
            goal: t.goal, url: t.url, dir: runDir, browser: j.browser, signal: j.abort.signal,
            // What the tester should know about this site (contextmachines/context.md, the project's box): to every ask, fenced.
            ...(siteNotes ? { siteNotes } : {}),
            minutes: explore ? Math.min(perTask, (begun + budgetMs - Date.now()) / 60_000) : perTask,
            maxActions: o.maxActions, allowHosts: o.allowHosts, vars: o.vars,
            ...(site.owner ? { owner: site.owner } : {}), ...(site.ownedHost ? { ownedHost: true } : {}), ...(use ? { keepPopups: true } : {}),
            ...(o.checkWaitMs ? { checkWaitMs: o.checkWaitMs } : {}),
            ...(o.wallWaitMs !== undefined ? { wallWaitMs: o.wallWaitMs } : {}),
            ...(visitor ? { visitor: true } : {}),
            ...(timed ? { brain: aiBrain(timed, Object.keys(o.vars), { ...(visitor ? { visitor: true } : {}), ...(o.measuredOnly ? { measuredOnly: true } : {}) }) } : {}),
            ...(o.measuredOnly ? { measuredOnly: true } : {}),
            ...(saved ? { saved } : {}),
            ...(session ? { storageState: session, ...(use ? { writeBackTo: session } : {}) } : {}),
            ...(use ? { secrets: use.resolver, signedInAs: use.account.label, masker: mask, signInGuard: guard, accountHosts: accountHostsFor(o.outDir, t.url), ...(site.ownedHost ? {} : { notOwned: true }), ...(use.account.signInPage ? { signInPath: use.account.signInPage } : {}) } : {}),
            // The sign-in's own video (its boxes as dots), kept beside the test's as sign-in.webm.
            ...(signInVideo ? { signInVideo } : {}),
            ...(hint ? { signInHint: hint } : {}),
            ...app.runExtras(t.id, t),
            onPage: async (page, info) => {
              // The engine decides (the goal, the steps and the plan): a run that keeps no video shows no live screen either.
              if (info.noMedia) {
                emit({ type: "noscreen", id: t.id, words: NO_SCREEN });
                return;
              }
              videoBegan = Date.now();
              cast = await screencast(page, (f) => {
                lastUrl = publicUrl(o.mask(f.url)) || o.mask(f.url);
                if (/^https?:/.test(lastUrl) && urls.at(-1)?.url !== lastUrl) urls.push({ t: Math.max(0, (Date.now() - videoBegan) / 1000), url: lastUrl });
                emit({ type: "frame", id: t.id, jpeg: f.jpeg, url: lastUrl });
              }, { ...o.screencast, ...(info.fields ? { fields: info.fields } : {}), ...(info.covered ? { covered: true } : {}) });
            },
            // The live screen's frames show the card themselves; the phase line says it in words too.
            onCover: (c) => {
              if (c.up) emit({ type: "ev", id: t.id, e: { type: "phase", words: `${c.words}: hidden in the live screen and the video` } });
            },
            on: (e: TestEvent) => {
              if (j.abort.signal.aborted) return;
              emit({ type: "ev", id: t.id, e });
              // The ticker's server clock (C7): "Thinking… n s" counts from the real start, even after a reload.
              if (e.type === "working") emit({ type: "working", id: t.id, n: e.n, words: e.words, since: Date.now(), ai: /^Asking the AI/.test(e.words) });
              if (e.type === "stepEnd" && lastUrl) stepUrls[e.step.n] = lastUrl;
              if (e.type === "action" || e.type === "stepEnd") void cast?.after();
            },
          }))));
        } catch (error) {
          await cast?.stop();
          if (j.abort.signal.aborted) {
            emit({ type: "notrun", id: t.id, words: STOPPED_BY_YOU });
            entries.push({ task, n, notRun: STOPPED_BY_YOU, ms: Date.now() - t0 });
            continue;
          }
          const why = o.mask(error instanceof CouldNotRun ? error.message : error instanceof Error ? error.message.split("\n")[0]! : String(error));
          emit({ type: "couldnt", id: t.id, words: redact(why) });
          entries.push({ task, n, couldNot: why, ms: Date.now() - t0 });
          continue;
        }
        await cast?.stop();
        if (result.botWall) walled.add(new URL(t.url).host);
        const totals = aiTotals(noted.slice(asked));
        const tokens = totals?.tokens ? `${tokenCount(totals.tokens)} tokens` : totals?.asks ? `${totals.asks} AI asks` : "no AI";
        const written = writeRun(runsDir, runDir, result, { ...(totals?.asks && o.ai ? { via: o.ai.via } : {}), tokens, totals });
        // The app indexes it, files its issues and keeps the cards' clicks; the page gets `run`.
        app.afterRun(t.id, t, runDir, result, save, totals?.asks ?? 0);
        let savedTo: string | undefined;
        if (save) {
          // A healed saved test is rewritten at its own file, on its own address.
          // It keeps the app it was saved for (its identity): without it, the test is no longer "at home" on a preview address.
          writeSaved(savedPath, { ...(saved ? { ...save, url: saved.url, ...(saved.identity ? { identity: saved.identity } : {}) } : save), ...(use ? { as: use.account.label } : {}) }, o.mask);
          savedTo = savedPath;
        }
        emit({
          type: "result", id: t.id, result: { ...result, url: publicUrl(result.url) },
          ...(result.video ? { video: fileUrl(t.id, result.video) } : {}),
          ...(result.signInVideo ? { signInVideo: fileUrl(t.id, result.signInVideo) } : {}),
          report: fileUrl(t.id, "report.html"),
          shots: Object.fromEntries(result.steps.filter((s) => s.screenshot).map((s) => [s.n, fileUrl(t.id, s.screenshot!)])),
          stepUrls,
          // The run's own timeline of addresses (kept in result.json, so it survives a reload); the live screen's when the run kept none.
          ...(result.video ? { urls: result.urls?.length ? result.urls.map((u) => ({ t: u.t, url: publicUrl(u.url) })) : urls } : {}),
          folder: relative(process.cwd(), runDir) || runDir,
          ...(savedTo ? { saved: relative(process.cwd(), savedTo) || savedTo } : {}),
          tokens,
          ...(result.accessibility?.pages ? { a11y: a11yShown(result.accessibility) } : {}),
        });
        entries.push({ task, n, result, report: written.report, ...(savedTo ? { saved: savedTo } : {}), ms: result.ms });
      }
      const counts = taskCounts(entries);
      let page: string | undefined;
      if (explore && items[0]) {
        const totals = aiTotals(noted);
        page = writeExplorePage(o.outDir, items[0].url, entries, { ms: Date.now() - begun, ...(o.ai ? { via: o.ai.via } : {}), tokens: totals?.tokens ? `${tokenCount(totals.tokens)} tokens` : "" });
      }
      emit({
        type: "jobEnd", id: jobId, ms: Date.now() - begun, summary: `Tests ${suiteSummary(counts)}`, counts, replay: items.every((it) => it.saved), sites: new Set(items.map((it) => new URL(it.url).host)).size,
        stuck: stuckAcross(entries).map((s) => ({ says: s.says, n: s.n, times: s.times })),
        ...((a) => (a ? { a11y: a11yShown(a) } : {}))(a11yAcross(entries.map((e) => e.result?.accessibility))),
        ...(page ? { explore: relative(process.cwd(), page) || page } : {}),
      });
      emit({ type: "saved", saved: savedList() });
    });

  const stop = async () => {
    const j = job;
    if (!j) return false;
    j.abort.abort();
    // A hard stop: the browser is closed now, whatever it was doing.
    await j.browser?.close().catch(() => {});
    await j.done;
    return true;
  };

  // -------------------------------------------------------------------------------------------
  // The routes.

  const headers = (res: ServerResponse, extra: Record<string, string> = {}) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  };
  const reply = (res: ServerResponse, code: number, body: unknown) => {
    headers(res, { "Content-Type": "application/json" });
    res.writeHead(code).end(JSON.stringify(body));
  };
  const refuse = (res: ServerResponse, code: number, why: string) => {
    headers(res, { "Content-Type": "text/plain; charset=utf-8" });
    res.writeHead(code).end(`${why}\n`);
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks: Buffer[] = [];
      // A body too big is read to its end and dropped, so the answer still reaches the asker.
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > BODY_MAX) tooBig = true;
        else chunks.push(c);
      });
      req.on("end", () => {
        if (tooBig) return reject(new Error("too big"));
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new Error("not JSON"));
        }
      });
      req.on("error", reject);
    });

  /** The address typed in, as the terminal reads --url; nothing when it isn't one. */
  const addressOf = (v: unknown) => (typeof v === "string" && v.trim() ? startUrl(v.trim())?.href : undefined);

  const serveFile = (req: IncomingMessage, res: ServerResponse, id: string, name: string) => {
    // A live test's id, or an app run id (run_…) from history.
    const dir = runDirs.get(id) ?? app.dirOf(id);
    if (!dir || !SERVABLE.test(name)) return refuse(res, 404, "Not found.");
    const path = join(dir, name);
    if (!existsSync(path)) return refuse(res, 404, "Not found.");
    const size = statSync(path).size;
    const type = TYPES[name.split(".").pop()!.toLowerCase()]!;
    // The report is our own page (every word in it escaped); it runs only its own small script.
    headers(res, { "Content-Type": type, "Accept-Ranges": "bytes", ...(type.startsWith("text/html") ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } : {}) });
    // The video seeks: a range is answered with just that part.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.writeHead(416).end();
      }
      start = Math.max(0, start);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      res.writeHead(206);
      if (req.method === "HEAD") return res.end();
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.setHeader("Content-Length", String(size));
    res.writeHead(200);
    if (req.method === "HEAD") return res.end();
    return createReadStream(path).pipe(res);
  };

  // -------------------------------------------------------------------------------------------
  // C20a: the Test accounts panel's reads and writes. Never a value: only whether each is set.

  /** The panel for a site: its host, whether it is marked mine, its accounts (what is set, never a value), its site access, and the accounts sign-ups made. */
  const accountsView = (site: string) => {
    const url = addressOf(site);
    if (!url) return { ok: false, error: "Put in the site's address first." };
    const host = new URL(url).host;
    let config: ReturnType<typeof loadAccounts>;
    try {
      config = loadAccounts(projectDir);
    } catch (error) {
      return { ok: false, host, error: error instanceof Error ? error.message : String(error) };
    }
    const mine = isMine(o.outDir, host);
    // Accounts may sign in: marked as yours, or you said it's your own account there. Never "mine".
    const signInOk = signInAllowed(o.outDir, host);
    const has = (a: Account, f: "username" | "password" | "totp") => {
      const ref = a[f];
      if (ref === undefined) return f === "password" && a.first === "password" ? false : undefined;
      try {
        return fieldValue(a, f, { host, store, ...(o.env ? { env: o.env } : {}) }) !== undefined;
      } catch {
        return false;
      }
    };
    const accounts = [...config.accounts.values()].map((a) => {
      const age = sessionAge(sessionPathFor(o.outDir, url, a.label));
      return {
        label: a.label, first: a.first, whenToUse: a.whenToUse ?? "", signInPage: a.signInPage ?? "", signedIn: a.signedIn?.text ?? a.signedIn?.url ?? "",
        username: typeof a.username === "string" ? a.username : "", set: { username: has(a, "username"), password: has(a, "password"), totp: has(a, "totp") },
        session: age === undefined ? "" : `signed in ${ago(age)}`,
      };
    });
    const s = config.sites?.get(host);
    const created = createdAccounts(o.outDir).filter((c) => c.host === host).slice(-50).map((c) => ({ at: c.at, environment: c.environment, address: maskAddress(c.address), passed: c.passed, status: c.status }));
    return { ok: true, host, mine, signInOk, ...(byHand && byHand.host === host ? { byHand } : {}), accounts, site: s ? siteAccessShown(s) : [], created, warnings: config.warnings };
  };

  /**
   * "Set up sign-in" (A1, as e2e's test.setup and TesterArmy's prep test), for any account: a real browser
   * window on this computer, where the person signs in themselves once (types the code from their email
   * or phone, opens the magic link, solves a captcha, signs in with Google); a wait for their Done follows.
   * Nothing of the window is streamed or recorded. Then the account's signed-in check is measured, and
   * only then is the session saved, with only the site's own cookies. Runs never wait for a person.
   */
  let byHand: { label: string; host: string; state: "open" | "saved" | "failed"; words?: string } | undefined;
  const signInSetupNow = (url: string, label: string): [number, unknown] => {
    const host = new URL(url).host;
    if (o.noWindow) return [409, { ok: false, error: "Set up sign-in needs the app running on your own computer: it opens a browser window there." }];
    if (byHand?.state === "open") return [409, { ok: false, error: "A sign-in setup is already open: finish it first." }];
    const found = accountFor({ dir: projectDir, outDir: o.outDir, url, label, store, ...(o.env ? { env: o.env } : {}) });
    if ("error" in found) return [400, { ok: false, error: found.error }];
    if (found.account.first === "sign-up") return [400, { ok: false, error: `${label} signs up a new account on each run, so there's no sign-in to set up.` }];
    byHand = { label, host, state: "open" };
    void (async () => {
      const browser = await (o.launch ?? launchBrowser)(true).catch(() => undefined);
      if (!browser) {
        byHand = { label, host, state: "failed", words: "The browser didn't open." };
        return;
      }
      try {
        // Only the Clerk host's cookies to keep, read from the config: no testing token is made for a window a person uses.
        const clerkHost = clerkKeepHostFor({ dir: projectDir, outDir: o.outDir, url });
        const r = await signInByHand({ outDir: o.outDir, url, account: found.account, browser, ...(clerkHost ? { alsoKeep: [clerkHost] } : {}), done: () => app.handOver.pauseByHand({ testId: `setup-${label}`, host, label }) });
        byHand = "error" in r ? { label, host, state: "failed", words: r.error } : { label, host, state: "saved", words: `Signed in as ${label}: the session is saved, and runs reuse it with no one there.` };
      } catch (error) {
        byHand = { label, host, state: "failed", words: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 200) : "It didn't finish." };
      } finally {
        await browser.close().catch(() => {});
      }
    })();
    return [200, { ok: true, started: true }];
  };

  const accountsChange = (what: string, body: Record<string, unknown>): [number, unknown] => {
    const url = addressOf(body.url);
    if (!url) return [400, { ok: false, error: "Put in the site's address first." }];
    const host = new URL(url).host;
    const str = (k: string, max = 500) => (typeof body[k] === "string" ? (body[k] as string).slice(0, max) : undefined);
    if (what === "mine") {
      if (body.yes !== true) return [400, { ok: false, error: "Say yes to mark it as yours." }];
      markMine(o.outDir, host);
      return [200, { ok: true }];
    }
    if (what === "signin-ok") {
      // "I'm signing in with my own account on <host>": recorded apart from owned.json, never makes it "mine".
      if (body.yes !== true) return [400, { ok: false, error: "Say yes to confirm it's your own account there." }];
      markSignInOk(o.outDir, host);
      return [200, { ok: true }];
    }
    const label = str("label", 40) ?? "";
    if (!/^[a-z0-9_-]{1,32}$/.test(label)) return [400, { ok: false, error: "The label is 1 to 32 of a-z, 0-9, _ and -, like admin." }];
    // Forgetting is always allowed: after the "my own account" is taken back, its session can still be thrown away.
    if (what === "forget") {
      forgetSession(o.outDir, url, label, body.all === true);
      return [200, { ok: true }];
    }
    if (!signInAllowed(o.outDir, host)) return [403, { ok: false, error: `You haven't said you sign in with your own account on ${host}, so no account is kept for it. Confirm it in Test accounts first.` }];
    if (what === "setup" || what === "by-hand") return signInSetupNow(url, label);
    try {
      if (what === "save") {
        const first = str("first", 20) ?? "password";
        if (!(FIRST_STEPS as readonly string[]).includes(first)) return [400, { ok: false, error: "Pick how it signs in first." }];
        const username = str("username", 300)?.trim();
        saveAccountForm(projectDir, {
          label, first: first as FirstStep, ...(username ? { username } : {}),
          ...(str("whenToUse") !== undefined ? { whenToUse: str("whenToUse")! } : {}),
          ...(str("signInPage", 200) !== undefined ? { signInPage: str("signInPage", 200)! } : {}),
          ...(str("signedIn", 200) !== undefined ? { signedInText: str("signedIn", 200)! } : {}),
          ...(str("catcher", 200) ? { catcher: str("catcher", 200)! } : {}),
        });
        // A username that isn't a test address is a secret: kept in the store, never in the file.
        if (username && !TEST_ADDRESS.test(username)) store.set(secretKey(host, label, "username"), username);
        return [200, { ok: true }];
      }
      if (what === "secret") {
        const field = str("field", 20);
        const value = typeof body.value === "string" ? body.value : "";
        if (field !== "password" && field !== "totp" && field !== "username") return [400, { ok: false, error: "The field is password, totp or username." }];
        if (!value) return [400, { ok: false, error: "Nothing was given, so nothing was stored." }];
        if (field === "password" && value.length < MIN_SECRET_LENGTH) return [400, { ok: false, error: `A password under ${MIN_SECRET_LENGTH} characters isn't stored: is it the right value?` }];
        if (field === "totp") {
          try {
            parseTotpSecret(value);
          } catch {
            return [400, { ok: false, error: "That isn't an authenticator secret (the base32 key or the otpauth:// link)." }];
          }
          const account = loadAccounts(projectDir).accounts.get(label);
          if (account && !account.totp) saveAccountForm(projectDir, { label, first: account.first, totp: true });
        }
        store.set(secretKey(host, label, field), value);
        return [200, { ok: true, set: true }];
      }
    } catch (error) {
      // Said without the value: a store or config refusal never quotes what was sent.
      return [400, { ok: false, error: error instanceof Error ? error.message.split("\n")[0]!.slice(0, 300) : "It couldn't be saved." }];
    }
    return [404, { ok: false, error: "Not found." }];
  };

  // -------------------------------------------------------------------------------------------
  // The app (cli/app): its data API, plan-first runs, Discovery, Set up sign-in and schedules, on this
  // server's one job queue. Every route below still passes the token, Host and Origin checks first.

  const app = createApp({
    outDir: o.outDir, projectDir, ai: o.ai, vars: o.vars, mask: o.mask, allowHosts: o.allowHosts, headed: o.headed, ...(o.measuredOnly ? { measuredOnly: true } : {}),
    emit: (e) => emit(e), busy: () => Boolean(job), stop, run: (items, opts) => void run(items, false, opts), begin, launch,
    viewers: () => clients.size, runDirs, fileUrl, nextId: () => String(++seq), accountsView, accountsChange,
  }, o.app);
  const appScreens = orderScreens([...runScreens, ...runOverlays]);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host, port)) return refuse(res, 403, "This server only answers to its own address.");
    const u = new URL(req.url ?? "/", origin);
    const file = /^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    const given = file ? file[1] : (req.headers["x-cm-token"] ?? u.searchParams.get("t"));
    if (!tokenOk(given, token)) return refuse(res, 403, "This needs the address with its token: the one printed in the terminal.");
    let action = /^\/api\/(suggest|run|run-saved|stop|accounts\/(?:save|secret|mine|signin-ok|setup|by-hand|forget))$/.exec(u.pathname)?.[1];

    if (req.method === "POST") {
      // A change: the token in the header (never only in the URL), JSON, from this page's own origin.
      if (!tokenOk(req.headers["x-cm-token"], token)) return refuse(res, 403, "A change needs the token in the x-cm-token header.");
      if (req.headers.origin !== undefined && req.headers.origin !== origin && req.headers.origin !== origin.replace("127.0.0.1", "localhost")) return refuse(res, 403, "A change must come from this page.");
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return refuse(res, 415, "Changes are JSON.");
      if (!action && !u.pathname.startsWith("/api/")) return refuse(res, 404, "Not found.");
      let body: Record<string, unknown>;
      try {
        const parsed = await readJson(req);
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        return refuse(res, 400, "Changes are JSON, at most 64 KB.");
      }
      // The app's data API (contracts.ts ApiRoutes): the classic actions above keep their paths and win,
      // except /api/suggest, which both share: the classic one takes { url }, the app's { projectId }.
      if (action === "suggest" && body.url === undefined && typeof body.projectId === "string") action = undefined;
      if (!action) {
        const r = await app.data.dispatch("POST", u.pathname, body);
        return reply(res, r.status, r.body);
      }
      if (action === "stop") return reply(res, 200, { ok: true, stopped: await stop() });
      // C20a: the Test accounts panel. A value sent here is stored and never sent back, said or logged:
      // the answer is { set: true } at most.
      if (action.startsWith("accounts/")) return reply(res, ...accountsChange(action.slice(9), body));
      if (job) return reply(res, 409, { ok: false, error: "Something is running: stop it first." });
      if (action === "suggest") {
        const url = addressOf(body.url);
        if (!url) return reply(res, 400, { ok: false, error: "Put in the site's address, like https://en.wikipedia.org" });
        suggest(url);
        return reply(res, 202, { ok: true });
      }
      if (action === "run") {
        const url = addressOf(body.url);
        if (!url) return reply(res, 400, { ok: false, error: "Put in the site's address, like https://en.wikipedia.org" });
        const goal = typeof body.goal === "string" ? body.goal.trim().slice(0, 500) : "";
        // Ticked on a list: it must be the list on show now. One replaced since (a new Suggest) is
        // refused, and the tasks run are this server's own list's, by number.
        let picked: unknown[] = Array.isArray(body.tasks) ? body.tasks : [];
        if (!goal && body.list !== undefined) {
          if (!list || body.list !== list.id) return reply(res, 409, { ok: false, stale: true, error: "The list of tasks changed since you ticked it: tick the tasks again on the new list." });
          if (new URL(list.url).host !== new URL(url).host) return reply(res, 409, { ok: false, stale: true, error: "Those tasks were suggested for another site: suggest tasks for this one." });
          const numbers = Array.isArray(body.picked) ? body.picked.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < list!.tasks.length) : list.tasks.map((_, i) => i);
          picked = [...new Set(numbers)].sort((a, b) => a - b).map((n) => list!.tasks[n]);
        }
        // Suggested tasks are checked again here, as a fresh answer is: the page's word isn't taken for it.
        const tasks = tasksFrom({ tasks: picked }, { host: new URL(url).host });
        if (!goal && !tasks.length) return reply(res, 400, { ok: false, error: "Tick a task, or type a goal." });
        // The account picked for it (C20b): a typed goal or a ticked task then runs signed in as it.
        const as = typeof body.as === "string" && /^[a-z0-9_-]{1,32}$/.test(body.as) ? body.as : undefined;
        const items: Item[] = goal ? [{ goal, url, ...(as ? { as } : {}) }] : tasks.map((t) => (as ? { goal: t.goal, area: t.area, url, as } : { goal: t.goal, area: t.area, url, visitor: true }));
        run(items, body.explore === true && !goal, body.signUp === true ? { signUp: true } : {});
        return reply(res, 202, { ok: true });
      }
      if (action === "run-saved") {
        const files = listSaved(o.testsDir);
        const want = Array.isArray(body.files) ? new Set(body.files.filter((f): f is string => typeof f === "string")) : undefined;
        const items: Item[] = [];
        for (const f of files) {
          if (want && !want.has(relative(o.testsDir, f).split("\\").join("/"))) continue;
          try {
            const saved = readSaved(f);
            items.push({ goal: saved.goal, url: saved.url, saved, file: f, ...(saved.visitor ? { visitor: true } : {}) });
          } catch {
            // a file that can't be read isn't offered
          }
        }
        if (!items.length) return reply(res, 400, { ok: false, error: "There are no saved tests yet: a test that passes is saved." });
        run(items, false);
        return reply(res, 202, { ok: true });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD, POST");
      return refuse(res, 405, "Not allowed.");
    }
    if (action) {
      // Nothing changes on a GET: a link or an <img> pointed here does nothing.
      res.setHeader("Allow", "POST");
      return refuse(res, 405, "This is a change: it needs a POST.");
    }
    if (file) return serveFile(req, res, file[2]!, decodeURIComponent(file[3]!));
    if (u.pathname === "/") {
      // The app: shell, screens and overlays in one page, one script under the nonce.
      const nonce = randomBytes(16).toString("base64");
      headers(res, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.writeHead(200).end(req.method === "HEAD" ? undefined : appPage({ token, nonce, screens: appScreens }));
    }
    if (u.pathname === "/classic") {
      const nonce = randomBytes(16).toString("base64");
      headers(res, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.writeHead(200).end(req.method === "HEAD" ? undefined : uiPage({ token, nonce }));
    }
    if (u.pathname === "/events") {
      headers(res, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.writeHead(200);
      res.write("retry: 2000\n\n");
      for (const e of log) send(res, e);
      for (const e of lastFrame.values()) send(res, e);
      // What happened so far has been said: a page that has just opened may now show the start, if nothing runs.
      send(res, { type: "replayed", busy: job?.kind ?? null });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (u.pathname === "/api/state") return reply(res, 200, { ok: true, busy: job?.kind ?? null, saved: savedList() });
    if (u.pathname === "/api/accounts") return reply(res, 200, accountsView(u.searchParams.get("site") ?? ""));
    if (u.pathname.startsWith("/api/")) {
      // No GET starts work: the data API's GET routes only read.
      const r = await app.data.dispatch(req.method ?? "GET", u.pathname);
      return reply(res, r.status, r.body);
    }
    return refuse(res, 404, "Not found.");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) refuse(res, 500, "Something went wrong.");
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": still here\n\n");
  }, 15_000);
  heartbeat.unref();
  // Schedules fire only while the app is open (Q3), through this server's one job queue (C18).
  app.start();

  return {
    url: `${origin}/?t=${token}`,
    origin,
    token,
    port,
    async close() {
      clearInterval(heartbeat);
      await stop();
      await app.close();
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}


/**
 * `npx contextmachines ui` / `test --ui`: starts the server, prints its address, opens it (unless
 * --no-open) and keeps running until Ctrl-C, which stops any run (closing its browser) first.
 */
export async function runUiCommand(o: UiOptions & { open: boolean; out: NodeJS.WriteStream; c: Colors; signals?: NodeJS.EventEmitter }): Promise<number> {
  const { c, out } = o;
  let ui: UiServer;
  try {
    // The `ui` command starts the practice site with the app and posts a Mac notification when a run fails (settings can switch it off).
    ui = await startUi({ ...o, app: o.app ?? { practice: () => startPracticeSite(), notify: (title, body) => macNotify(title, body) } });
  } catch (error) {
    process.stderr.write(`${c.red("×")} The web view couldn't start: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  out.write(`\n  ${c.enabled ? c.badge("inverse", " ui ") : "ui"}  ${c.bold("The tester, in your browser")} ${c.dim(`· 127.0.0.1 only · AI: ${o.ai ? o.ai.via : "none (saved tests only)"}`)}\n\n`);
  out.write(`  ${c.cyan(ui.url)}\n\n`);
  out.write(`  ${c.dim("The address holds this session's token: anyone with it can run tests from this machine, so don't share it.")}\n`);
  out.write(`  ${c.dim("Runs are written to")} ${relative(process.cwd(), o.outDir) || o.outDir} ${c.dim("as the terminal writes them. A run goes on if the page is closed; Stop test there, or Ctrl-C here, stops it.")}\n\n`);
  if (o.open) {
    const opener = openerFor();
    if (!opener || !(await openFile(opener, ui.url))) out.write(`  ${c.dim("Open the address above in your browser.")}\n\n`);
  }
  const signals = o.signals ?? process;
  await new Promise<void>((resolve) => {
    const end = () => {
      signals.off("SIGINT", end);
      signals.off("SIGTERM", end);
      resolve();
    };
    signals.on("SIGINT", end);
    signals.on("SIGTERM", end);
  });
  out.write(`  ${c.dim("Stopping…")}\n`);
  await ui.close();
  return 0;
}

/** How long ago, in a few words. */
const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`);

/** The accessibility scan as the web page shows it: one sentence, then each kind with its findings. */
function a11yShown(r: A11yResult) {
  return { summary: a11ySummary(r), groups: a11yGroups(r), notes: a11yNotes(r) };
}
