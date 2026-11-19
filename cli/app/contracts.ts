/**
 * The app's shared contract: the types the six lanes (data, ui-shell, ui-run, protect, explore, sites)
 * build against. Types only, no runtime code: every import is `import type`, so nothing here loads the
 * engine. Engine and report types are reused, never copied. A lane that needs a change builds with a
 * local extension type and asks for the change in its INTEGRATE.md. See CONTRACTS.md beside this file.
 *
 * Rules the types carry (APP-PLAN 1, 7, 8):
 * - Run status and verdict are separate (C12): Stop gives status "cancelled", never verdict "fail".
 * - A verdict comes from measured checks; a judged check is labelled "judged" everywhere it shows.
 * - Issues come from measured signals only, severity from a fixed rule table (A3), never from the AI.
 * - No secret value is in any shape here: accounts are labels; evidence and log text are masked and redacted.
 * - A captcha or bot check is never solved by our code or the AI: an owned host gets a test-mode setup
 *   line (E10), otherwise the run is BLOCKED. A run never waits for a person (A1): a person helps only
 *   before the runs, in "Set up sign-in" under Accounts (a real window on their computer).
 */
import type { Check, Friction, PlannedStep, StepResult, SubAction, TestEvent, TestResult, TestVerdict, SignInCode } from "../../packages/scanner/src/tester/types.ts";
import type { SavedTest } from "../../packages/scanner/src/tester/cache.ts";
import type { A11yFinding, A11yResult } from "../../packages/scanner/src/tester/a11y.ts";

export type { Check, Friction, PlannedStep, StepResult, SubAction, TestEvent, TestResult, TestVerdict, SignInCode, SavedTest, A11yFinding, A11yResult };

// ===================================================================================================
// Ids and time
// ===================================================================================================

/** Ids are "<prefix>_<12 hex>" (prj, env, tst, run, iss, sch, grp, ho), made by the data lane. */
export type ProjectId = string;
export type EnvId = string;
export type TestId = string;
export type RunId = string;
export type IssueId = string;
export type ScheduleId = string;
export type GroupId = string;
export type HandOverId = string;
/** An ISO 8601 time: "2026-11-17T21:04:00.000Z". */
export type Iso = string;
/** Seconds into a run's video (as StepResult.at and SubAction.at). */
export type VideoSeconds = number;

// ===================================================================================================
// Projects and environments (A1; screens S1, S2, S8)
// ===================================================================================================

/** What kind of address an environment is (C3, C21). "production" shows a one-line warning on Discovery and new tests. */
export type EnvKind = "local" | "staging" | "production";

export interface Environment {
  id: EnvId;
  /** "Production", "Staging", "Local". */
  name: string;
  /** Origin plus optional path. http://localhost:* and 127.0.0.1 are allowed (C3). Never holds a secret (no user:pass@, no token query). */
  url: string;
  kind: EnvKind;
  /** Passed the D12 ownership check (accounts.ts isMine). Only an owned environment may sign up, pay, or be shown protection setup lines. */
  owned: boolean;
  /** Accounts may sign in here: owned, or the person said it's their own account (signin-ok.json). Never means owned. */
  signInOk: boolean;
  /** The project's default environment: exactly one per project has it. */
  default?: true;
}

export interface Project {
  id: ProjectId;
  name: string;
  /** The default environment's url (kept so apps/cloud Project.url still means the same). */
  url: string;
  /** At least one. The AI may only go to these environments' origins. */
  envs: Environment[];
  /** Agent instructions, at most 4,000 characters (A1). To the planner only; they cannot switch off any gate (C24). */
  instructions?: string;
  /**
   * What the tester should know about this site: the person's notes about how it works, at most 4,000
   * characters, kept in the project's contextmachines/context.md (the terminal reads the same file). To the
   * planner, the actor and the judges, fenced after their rules; they cannot switch off any rule, and a
   * text that looks like it holds a password, key or token is refused.
   */
  context?: string;
  /** --ai default: "claude-code" | "codex" | "none" ("none" replays saved tests only, $0). */
  ai: string;
  /** A test account's label, never a secret. */
  defaultAccount?: string;
  /** The project's folder: its config, tests, runs and sessions live there. */
  dir: string;
  createdAt: Iso;
  updatedAt: Iso;
}

/** Limits as types (no runtime code here): agent instructions at most 4,000 characters, at most 30 steps. */
export type InstructionsMax = 4000;
export type StepsMax = 30;

// ===================================================================================================
// Tests and plan steps (E3, U2, U3; C2, C4, C5)
// ===================================================================================================

/** The badge on a step card. Old saved steps read as "act", or "assert" when check.kind !== "none" (C4). */
export type StepKind = "act" | "assert" | "login";

/**
 * How a check is decided. "measured": the browser measures the Check (check.ts). "judged": an AI looked
 * (Wave 1 AI judge); it is labelled "judged" in every pill, card, report and export, and never makes PASS alone.
 */
export type CheckMode = "measured" | "judged";

/** A step card: the engine's PlannedStep plus what the editor needs. */
export interface PlanStep extends PlannedStep {
  /** Stable within the test, so the editor can move cards: "s1", "s2", … */
  id: string;
  kind: StepKind;
  checkMode: CheckMode;
  /** Switched off: shown, not run, reported "skipped". */
  enabled: boolean;
  /** kind "login": which test account (label only). The card's picker lists labels from GET /api/accounts. */
  accountLabel?: string;
  /**
   * The intent or check was edited since its actions were saved (C5): its saved actions are dropped, so
   * the next run asks the AI for this step only and replays the rest.
   */
  edited?: true;
  /** Set before Run when a check names words never seen on the page (E3 bar): shown on the card, run still allowed. */
  warning?: string;
}

export interface TestDef {
  id: TestId;
  projectId: ProjectId;
  name: string;
  /** The sentence it was generated from. */
  goal: string;
  steps: PlanStep[];
  /**
   * The account it signs in as before step 1 when no Login card says so: a test saved from a run that
   * signed in first (the app signs in, so the run's sign-in steps were never saved). A label only.
   */
  account?: string;
  /** The environment it runs on unless the Run menu picks another (C13). */
  envId?: EnvId;
  groupIds?: GroupId[];
  /** "describe" from the Describe tab, "discovery" from Explore, "learned" from a saved SavedTest on disk. */
  origin: "describe" | "discovery" | "learned";
  /** The SavedTest file it is written to, relative to the project dir (rules 2). */
  file?: string;
  createdAt: Iso;
  updatedAt: Iso;
  /** Filled by the data lane for lists: the last run and the pass rate over the last 10 (BLOCKED left out). */
  last?: RunSummary;
  passRate?: number;
}

/** Discovery tab limits (E8). Defaults: 12 steps, 15 minutes, stop after 3 failures in a row. */
export interface ExploreLimits {
  maxSteps: number;
  maxMinutes: number;
  maxFailsInRow: number;
}

// ===================================================================================================
// Runs (A2; screens S4, S5, S6; C12, C14)
// ===================================================================================================

/** Where the run is in its life. Separate from its verdict (C12). "skipped_busy": a schedule fired while a run was going (C18). */
export type RunStatus = "queued" | "running" | "completed" | "cancelled" | "error" | "interrupted" | "skipped_busy";

/** The engine's verdict plus FLAKY (E6): amber, never shown as PASS. */
export type AppVerdict = TestVerdict | "flaky";

/** Why a BLOCKED run was blocked (C12), shown on its card. */
export type BlockedGroup = "environment" | "credentials" | "bot_wall" | "setup" | "automation" | "safety_gate";

export type RunSource = "manual" | "scheduled" | "explore" | "group" | "api";

/** One row of history (S6) and of a test's last-10 list. Built from contextmachines/runs/**\/result.json. */
export interface RunSummary {
  id: RunId;
  projectId: ProjectId;
  testId?: TestId;
  /** The test's name, or its goal cut to 80 characters. */
  name: string;
  envId?: EnvId;
  /** Masked, without secrets. */
  url: string;
  status: RunStatus;
  /** Only when status is "completed". */
  verdict?: AppVerdict;
  blockedGroup?: BlockedGroup;
  /** One line: the first failed step's reason, the stop reason, or the BLOCKED reason. */
  reason?: string;
  code?: SignInCode;
  source: RunSource;
  startedAt: Iso;
  ms?: number;
  steps: number;
  passed: number;
  /** Every action came from the saved test. */
  replay: boolean;
  /** AI asks made (plan + decide + judge). 0 for a pure replay. */
  aiAsks?: number;
  /** The run's folder, relative to the project dir: "contextmachines/runs/2026-11-17/…". Shown as ~/… or a link (U4). */
  dir: string;
  /** File names inside dir, served at /files/<token>/<runId>/<name>. */
  video?: string;
  issues?: number;
  /** A judged check took part in the verdict: the pill says "judged". */
  judged?: boolean;
}

/** A run in full, for the result screen (S5). */
export interface RunRecord {
  summary: RunSummary;
  /** The engine's result, unchanged (url masked). */
  result: TestResult;
  /** The plan as it was run, with kinds and modes; absent for runs from before E3. */
  plan?: PlanStep[];
  /** E1 app log; absent before E1 lands. */
  log?: AppLogEntry[];
  a11y?: A11yResult;
  protection?: ProtectionFinding[];
  handovers?: HandOverRecord[];
  /** Per step: the masked snapshot text the AI was given, and why the verdict (C10). Never a secret. */
  looks?: { step: number; at: VideoSeconds; snapshot: string; why?: string }[];
  rating?: Rating;
}

/** Helpful / Not helpful on the result card (C14). Kept in the run folder (0600), never sent anywhere. */
export interface Rating {
  helpful: boolean;
  note?: string;
  at: Iso;
}

// ===================================================================================================
// App log (E1, #53)
// ===================================================================================================

export type AppLogKind = "console" | "pageerror" | "request_failed" | "http_error" | "navigation";

/** One line of what the page did. Text is masked (--var values) and redacted (leak.ts) before it is stored or sent. */
export interface AppLogEntry {
  kind: AppLogKind;
  /** console: its level. pageerror / request_failed / http_error: "error"; 4xx: "warn". navigation: "info". */
  level: "error" | "warn" | "info" | "debug";
  /** The message, clipped to 300 characters. Untrusted site text. */
  text: string;
  /** The step it happened in (0: before the first step). */
  step: number;
  at: VideoSeconds;
  /** The request's or page's url, masked, without query secrets. */
  url?: string;
  method?: string;
  status?: number;
  /** Repeats of the same line within a step, collapsed. */
  count?: number;
}

// ===================================================================================================
// Issues (A3, A4; screen S7; C23)
// ===================================================================================================

export type IssueKind = "failed_step" | "console_error" | "page_error" | "http_error" | "friction" | "a11y" | "explore";
export type IssueStatus = "open" | "resolved" | "false_positive";
/** 1 lowest .. 5 highest, from the fixed rule table only. */
export type Severity = 1 | 2 | 3 | 4 | 5;

/** What was measured, masked and redacted. Rendered as text only, and inside the untrusted-data fence in prompts (C23). */
export interface Evidence {
  /** Always "measured": issues never come from an AI's opinion (Q4). */
  source: "measured";
  kind: IssueKind;
  /** The line or sentence itself, at most 300 characters. */
  text: string;
  url?: string;
  method?: string;
  status?: number;
  /** a11y: the finding; failed_step: expected vs found; friction: its kind. */
  a11y?: A11yFinding;
  expected?: { expected: string; found: string };
  friction?: Friction["kind"];
}

export interface IssueOccurrence {
  runId: RunId;
  testId?: TestId;
  testName: string;
  step: number;
  /** "Go to M:SS" in that run's video. */
  videoAt: VideoSeconds;
  at: Iso;
  evidence: Evidence;
}

export interface Issue {
  id: IssueId;
  projectId: ProjectId;
  /** Dedupe key: kind + route (ids normalised) + message words. */
  key: string;
  kind: IssueKind;
  title: string;
  severity: Severity;
  status: IssueStatus;
  firstSeen: Iso;
  lastSeen: Iso;
  count: number;
  /** Newest first; the data lane may cap the list (count stays true). */
  occurrences: IssueOccurrence[];
  /** A resolved issue that came back. */
  reopenedAt?: Iso;
}

// ===================================================================================================
// Site protection (E10, C1, C27) and "Set up sign-in" (A1: the only wait for a person, before any run)
// ===================================================================================================

export type ProtectionKind = "recaptcha" | "hcaptcha" | "turnstile" | "clerk_bot" | "auth0_bot" | "cloudflare_challenge" | "vercel_protection" | "netlify_protection" | "basic_auth" | "unknown_captcha";

/** A protection the run met. Detection only: nothing here solves or evades anything. */
export interface ProtectionFinding {
  kind: ProtectionKind;
  /** In plain words: "Google reCAPTCHA v2", "Cloudflare Turnstile". */
  name: string;
  host: string;
  /** Page path (masked) where it was seen. */
  page: string;
  /** The host passed the D12 ownership check. */
  owned: boolean;
  /** A provider test key / test mode was detected (e.g. reCAPTCHA's published test site key): the run can pass. */
  testMode: boolean;
  /** It stood in the way: the run (or a step) is BLOCKED with blockedGroup "bot_wall" unless a person solved it. */
  blocking: boolean;
  /** The one-line test-mode setup. Only when owned (C27); never for a host the user doesn't own. Holds no secret value, only names. */
  setup?: string;
  /** The provider's own docs page for its test mode. */
  docUrl?: string;
  /** What was measured: the script host, the widget's sitekey prefix (never a secret), the response header. */
  evidence: string;
  step?: number;
  at?: VideoSeconds;
}

/**
 * "sign_in_setup": the person signs in themselves in "Set up sign-in" (A1), before any run. The others are
 * read only, from runs made before A1, when a run could pause mid-way for a person.
 */
export type HandOverReason = "sign_in_setup" | "captcha" | "bot_check" | "by_hand_login" | "sign_in_code" | "other";

/**
 * A wait for a person: today only "Set up sign-in" under Accounts (a real browser window on their own
 * computer, nothing streamed). A run never waits for a person (A1). Our code never solves a check.
 */
export interface HandOverRequest {
  id: HandOverId;
  /** The live test it belongs to (ui-server's test id) and its run, when known. */
  testId: string;
  runId?: RunId;
  reason: HandOverReason;
  protection?: ProtectionFinding;
  /** Only in records from before A1: what a person typed mid-run, a code or a sign-in link. */
  wants?: "code" | "link";
  /** The account's label (never a value). */
  account?: string;
  /** "Sign in there yourself, then press Done." */
  words: string;
  host: string;
  startedAt: Iso;
  /** It gives up at this time (nothing is saved). Default 5 minutes. */
  deadline: Iso;
}

export type HandOverOutcome = "resumed" | "timedOut" | "cancelled";

export interface HandOverRecord {
  request: HandOverRequest;
  outcome: HandOverOutcome;
  endedAt: Iso;
  /** Always "person" when resumed: never "ai" or "code". */
  by?: "person";
  /** The session was saved for later runs (accounts.ts sessionPathFor). */
  sessionSaved?: boolean;
}

// ===================================================================================================
// Accounts, groups, schedules, setup state (S1, S8; C18, C20a/b, C22)
// ===================================================================================================

/** A test account as the app may see it: labels and state only, never a value (C20a). */
export interface AccountSummary {
  label: string;
  host: string;
  firstStep: string;
  /** The account's "When to use" note (a few words, never a value): a run's goal picks an account by it. */
  whenToUse?: string;
  /** A saved session exists, and its age. */
  session?: { ageMs: number; fresh: boolean };
  /** What is missing to use it, in one line ("No password stored"). */
  problem?: string;
}

export interface Group {
  id: GroupId;
  projectId: ProjectId;
  name: string;
  testIds: TestId[];
}

export type SchedulePreset = "hourly" | "daily" | "weekdays" | "cron";

export interface AppSchedule {
  id: ScheduleId;
  projectId: ProjectId;
  preset: SchedulePreset;
  /** 5-field cron; derived from the preset unless preset is "cron". */
  cron: string;
  /** IANA zone: "Europe/London". */
  timeZone: string;
  /** What it runs: a group, one test, or every saved test. */
  target: { group: GroupId } | { test: TestId } | { all: true };
  envId?: EnvId;
  /** Always "none" until a spend cap exists (section 4). */
  ai: "none";
  enabled: boolean;
  /** It only fires while `contextmachines ui` is open (Q3). */
  lastFired?: Iso;
  lastSkippedBusy?: Iso;
  createdAt: Iso;
}

export interface AppSettings {
  /** macOS notification on a failed run (osascript via execFile + argv, C22). */
  notifyOnFail: boolean;
  /** Ask once before Discovery on a production environment (Q7). */
  confirmProduction: boolean;
}

/** The first-run checklist (S1): told truthfully. */
export interface SetupState {
  ai: { via: string | null; ready: boolean; words: string };
  browser: { ready: boolean; words: string };
  /** The practice site's address, when the sites lane has one running. */
  practiceUrl?: string;
}

// ===================================================================================================
// Data API (served by ui-server; GET reads, POST changes; token in x-cm-token; JSON only)
// ===================================================================================================

export type ApiOk<T> = { ok: true } & T;
export type ApiErr = { ok: false; error: string; /** 409 on stale data or a busy runner. */ stale?: boolean; busy?: boolean };
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** `:name` segments are path parameters. The server only takes GET, HEAD and POST, so deletes are POSTs. No GET starts work (C11). */
export interface ApiRoutes {
  // setup
  "GET /api/setup": { req: void; res: SetupState };
  // projects
  "GET /api/projects": { req: void; res: { projects: Project[] } };
  "POST /api/projects": { req: { name?: string; url: string; kind?: EnvKind }; res: { project: Project } };
  "GET /api/projects/:id": { req: void; res: { project: Project } };
  "POST /api/projects/:id": { req: Partial<Pick<Project, "name" | "instructions" | "context" | "ai" | "defaultAccount" | "envs">>; res: { project: Project } };
  "POST /api/projects/:id/delete": { req: void; res: {} };
  // tests
  "GET /api/projects/:id/tests": { req: void; res: { tests: TestDef[] } };
  "POST /api/projects/:id/tests": { req: Pick<TestDef, "name" | "goal" | "steps" | "origin"> & Partial<Pick<TestDef, "envId" | "groupIds">>; res: { test: TestDef } };
  "GET /api/tests/:id": { req: void; res: { test: TestDef; runs: RunSummary[] } };
  "POST /api/tests/:id": { req: Partial<Pick<TestDef, "name" | "goal" | "steps" | "envId" | "groupIds">>; res: { test: TestDef } };
  "POST /api/tests/:id/delete": { req: void; res: {} };
  /** Plan first (E3): one AI ask, returns cards, starts no browser run. */
  "POST /api/plan": { req: { projectId: ProjectId; envId?: EnvId; goal: string }; res: { steps: PlanStep[] } };
  /** "Suggest tests": one look at the site and one AI ask; goals a signed-out visitor can try safely. */
  "POST /api/suggest": { req: { projectId: ProjectId; envId?: EnvId }; res: { tasks: { goal: string; area: string }[] } };
  // runs (start returns 202; progress comes on /events)
  "POST /api/runs": { req: { projectId: ProjectId; envId?: EnvId; testId?: TestId; steps?: PlanStep[]; goal?: string; groupId?: GroupId; all?: boolean; source?: RunSource }; res: { runId: RunId } };
  "POST /api/explore": { req: { projectId: ProjectId; envId?: EnvId; limits?: Partial<ExploreLimits>; confirmedProduction?: boolean }; res: { runId: RunId } };
  "POST /api/stop": { req: void; res: { stopped: boolean } };
  "GET /api/projects/:id/runs": { req: void; res: { runs: RunSummary[]; skipped?: { path: string; why: string }[] } };
  "GET /api/runs/:id": { req: void; res: { run: RunRecord } };
  "POST /api/runs/:id/rating": { req: Omit<Rating, "at">; res: { rating: Rating } };
  "POST /api/runs/:id/export": { req: void; res: { file: string } };
  // issues
  "GET /api/projects/:id/issues": { req: void; res: { issues: Issue[]; counts: Record<IssueStatus, number> } };
  "GET /api/issues/:id": { req: void; res: { issue: Issue } };
  "POST /api/issues/:id/status": { req: { status: IssueStatus }; res: { issue: Issue } };
  /** Markdown, leak-checked, site text inside the untrusted-data fence, lines clipped to 300 (A4, C23). */
  "GET /api/issues/:id/prompt": { req: void; res: { prompt: string } };
  // accounts (labels only)
  "GET /api/projects/:id/accounts": { req: void; res: { accounts: AccountSummary[] } };
  /** Marks an environment's host as the person's own (D12), as `accounts mine <host>` does. Needs yes: true. */
  "POST /api/projects/:id/owned": { req: { envId: EnvId; yes: true }; res: { project: Project } };
  /** Says the person signs in with their own account on an environment's host (signin-ok.json), as `accounts sign-in <host>` does. Needs yes: true. Never makes it owned. */
  "POST /api/projects/:id/signin-ok": { req: { envId: EnvId; yes: true }; res: { project: Project } };
  /**
   * "Set up sign-in" (A1): opens a real browser window on this computer, where the person signs in as the
   * account themselves (a code by email or text, a magic link, a captcha, Google). Nothing is streamed; a
   * wait for their Done follows, then the signed-in check is measured and only then is the session saved.
   * Later runs reuse it with no one there. 409 on a hosted server.
   */
  "POST /api/projects/:id/sign-in-setup": { req: { envId?: EnvId; label: string }; res: { started: true } };
  /** Adds or changes a test account on an environment where accounts may sign in (owned, or signInOk). The password goes to the secret store and never comes back. */
  "POST /api/projects/:id/accounts": { req: { envId?: EnvId; label: string; username?: string; password?: string }; res: { accounts: AccountSummary[]; /** The project as it is now: the first account saved becomes its default. */ project?: Project } };
  // groups and schedules
  "GET /api/projects/:id/groups": { req: void; res: { groups: Group[] } };
  "POST /api/projects/:id/groups": { req: Pick<Group, "name" | "testIds"> & { id?: GroupId }; res: { group: Group } };
  "POST /api/groups/:id/delete": { req: void; res: {} };
  "GET /api/projects/:id/schedules": { req: void; res: { schedules: AppSchedule[] } };
  "POST /api/projects/:id/schedules": { req: Pick<AppSchedule, "preset" | "timeZone" | "target" | "enabled"> & Partial<Pick<AppSchedule, "cron" | "envId" | "id">>; res: { schedule: AppSchedule } };
  "POST /api/schedules/:id/delete": { req: void; res: {} };
  // settings
  "GET /api/settings": { req: void; res: { settings: AppSettings } };
  "POST /api/settings": { req: Partial<AppSettings>; res: { settings: AppSettings } };
  // "Set up sign-in" (A1): only valid while that setup is open
  "POST /api/handover/:id/done": { req: void; res: {} };
  "POST /api/handover/:id/cancel": { req: void; res: {} };
}

export type RouteKey = keyof ApiRoutes;
export type ReqOf<K extends RouteKey> = ApiRoutes[K]["req"];
export type ResOf<K extends RouteKey> = ApiRoutes[K]["res"];
/** The `:name` parameters a route key needs. */
export type ParamsOf<K extends string> = K extends `${string}:${infer P}/${infer Rest}` ? { [k in P]: string } & ParamsOf<`/${Rest}`> : K extends `${string}:${infer P}` ? { [k in P]: string } : {};

/** A data-lane handler, mounted by the integrator inside ui-server's handle() after its token, Host and Origin checks. */
export type Handler<K extends RouteKey> = (params: ParamsOf<K>, body: ReqOf<K>) => Promise<{ status: number; body: ApiResult<ResOf<K>> }>;
export type Handlers = { [K in RouteKey]?: Handler<K> };

// ===================================================================================================
// Live event stream (/events, SSE): today's events, and the additions
// ===================================================================================================

/** What ui-server sends today (ui-server.ts emit calls), typed for the UI lanes. Field sets beyond these are not promised. */
export type LiveEventNow =
  | { type: "hello"; ai: string | null; url: string; saved: unknown[]; safety: string }
  | { type: "busy"; busy: string | null }
  | { type: "replayed"; busy: string | null }
  | { type: "error"; words: string }
  | { type: "phase"; words: string }
  | { type: "tasks"; url: string; tasks: unknown[]; list: string | null }
  | { type: "botwall"; url: string; host: string; check: string; title: string; words: string; shot?: string }
  | { type: "job"; id: string; explore: boolean; tests: { id: string; goal: string; url: string; area: string; replay: boolean }[] }
  | { type: "test"; id: string; at: number; safety: string; noScreen?: string }
  | { type: "ev"; id: string; e: TestEvent }
  | { type: "frame"; id: string; jpeg: string; url: string }
  | { type: "noscreen"; id: string; words: string }
  | { type: "notrun"; id: string; words: string; wall?: boolean }
  | { type: "couldnt"; id: string; words: string }
  | { type: "result"; id: string; result: TestResult }
  | { type: "jobEnd"; id: string; ms: number; summary: string; counts: Record<string, number>; replay: boolean; sites: number }
  | { type: "saved"; saved: unknown[] };

/** New events for the app. */
export type LiveEventNew =
  /**
   * The working ticker (C7, U4): sent beside each `ev` whose e.type is "working", with the server's wall
   * clock, so "Thinking... n s" counts from the real start. It ends at the next action, stepEnd or result.
   */
  | { type: "working"; id: string; n: number; words: string; since: number; ai: boolean }
  /** A protection was detected in a live test (E10). */
  | { type: "protection"; id: string; finding: ProtectionFinding }
  /** "Set up sign-in" (A1): waiting for the person's Done in the window on their computer, and how it ended. */
  | { type: "handover"; id: string; state: "needed"; request: HandOverRequest }
  | { type: "handover"; id: string; state: "resumed"; handover: HandOverId; by: "person" }
  | { type: "handover"; id: string; state: "timedOut"; handover: HandOverId }
  | { type: "handover"; id: string; state: "cancelled"; handover: HandOverId }
  /** One E1 app-log line, live. */
  | { type: "log"; id: string; entry: AppLogEntry }
  /** The run was stored and indexed: lists can refresh. Carries the app run id for the result route. */
  | { type: "run"; id: string; summary: RunSummary }
  /** Issues changed after a run (new, reopened, or more occurrences). */
  | { type: "issues"; projectId: ProjectId; changed: IssueId[] }
  /** A schedule fired, or was skipped because a run was going (C18). */
  | { type: "schedule"; scheduleId: ScheduleId; state: "fired" | "skipped_busy"; runId?: RunId };

export type LiveEvent = LiveEventNow | LiveEventNew;
export type LiveEventType = LiveEvent["type"];
export type LiveEventOf<T extends LiveEventType> = Extract<LiveEvent, { type: T }>;

// ===================================================================================================
// UI screen modules (ui-shell, ui-run lanes)
// ===================================================================================================

/**
 * Hash routes (C11). Reloading on any of them shows the same screen; moving between them never stops a run.
 * "#/" start (S1), "#/p/:pid/tests" (S2), "#/p/:pid/tests/new" (S3), "#/p/:pid/tests/:tid" (test page),
 * "#/p/:pid/runs" (S6), "#/p/:pid/runs/:rid" (S5), "#/p/:pid/live" (S4), "#/p/:pid/issues" (S7),
 * "#/p/:pid/issues/:iid", "#/p/:pid/accounts", "#/p/:pid/settings".
 */
export type AppRoute =
  | "/"
  | "/p/:pid/tests"
  | "/p/:pid/tests/new"
  | "/p/:pid/tests/:tid"
  | "/p/:pid/runs"
  | "/p/:pid/runs/:rid"
  | "/p/:pid/live"
  | "/p/:pid/issues"
  | "/p/:pid/issues/:iid"
  | "/p/:pid/accounts"
  | "/p/:pid/settings";

/** The browser-side API client. Adds x-cm-token and JSON for POSTs; never throws on an HTTP error (it returns ApiErr). */
export interface ApiClient {
  call<K extends RouteKey>(route: K, params: ParamsOf<K>, body?: ReqOf<K>): Promise<ApiResult<ResOf<K>>>;
  /** A run file's address: /files/<token>/<runId>/<name>. */
  fileUrl(runId: RunId, name: string): string;
}

export interface Router {
  /** The current route, its pattern and params. */
  current(): { route: AppRoute; params: Record<string, string>; query: URLSearchParams };
  go(path: string): void;
  href(path: string): string;
  onChange(fn: () => void): () => void;
}

export interface EventStream {
  on<T extends LiveEventType>(type: T, fn: (e: LiveEventOf<T>) => void): () => void;
  /** Every event so far in this page (the server replays its log on connect). */
  history(): readonly LiveEvent[];
  connected(): boolean;
}

/** Small DOM helpers the shell gives every screen, so screen code stays self-contained. Text is always set as textContent. */
export interface UiKit {
  el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string): HTMLElementTagNameMap[K];
  /** One of the page's own icons by name ("okc", "badc", "mehc", "monitor", "x", …). */
  icon(name: string, cls?: string): HTMLElement;
  /** "1:07" (or "1:07.4" with fine). */
  clock(s: VideoSeconds, fine?: boolean): string;
  /** "2m ago". */
  ago(iso: Iso): string;
  /** A verdict pill: PASS / FAIL / BLOCKED / NOT SURE / FLAKY, plus "judged" when asked. */
  pill(v: AppVerdict | RunStatus, o?: { judged?: boolean }): HTMLElement;
  toast(words: string): void;
}

export interface ScreenCtx {
  api: ApiClient;
  router: Router;
  events: EventStream;
  ui: UiKit;
  params: Record<string, string>;
  /** The chosen project, when the route has :pid and it exists. */
  project?: Project;
  /** Narrow layout (under 768 px). Screens must work at 390 px with no horizontal scroll. */
  narrow: boolean;
}

/**
 * A screen. render() fills root (the shell owns the rail and top bar) and returns a cleanup, called when
 * the route changes. css uses only the page's colour tokens (--bg, --fg, --muted, --line, --card, --pass,
 * --fail, --warn, --primary, …), so light and dark both work. The server inlines render's source with
 * Function.prototype.toString under the page's nonce, so render must be self-contained: no imports, no
 * references to anything outside its own body except ctx and browser globals.
 */
export interface ScreenModule {
  id: string;
  routes: AppRoute[];
  css: string;
  render(root: HTMLElement, ctx: ScreenCtx): void | (() => void);
}

// ===================================================================================================
// Engine lanes (protect, explore) and practice sites
// ===================================================================================================

/** Protect lane: detection from what the page loaded. Pure: never clicks, types or waits for a widget. */
export interface ProtectionProbe {
  /** Script, frame and request urls the page loaded; response headers of the main document; visible text (masked). */
  scripts: string[];
  frames: string[];
  headers: Record<string, string>;
  status: number;
  url: string;
  title: string;
  text: string;
  /** Widget attributes found (data-sitekey etc.). Site keys are public, never secrets. */
  sitekeys: { kind: ProtectionKind; key: string }[];
}
export type DetectProtection = (probe: ProtectionProbe, owned: boolean) => ProtectionFinding[];

/** Explore lane: a measured finding the explore run files into issues. Severity is set by the data lane's rule table, never here. */
export interface ExploreFinding {
  kind: Exclude<IssueKind, "explore"> | "explore";
  title: string;
  step: number;
  at: VideoSeconds;
  evidence: Evidence;
}
export interface ExploreReport {
  limits: ExploreLimits;
  steps: number;
  offSiteNavigations: 0;
  stoppedBecause: "steps" | "time" | "fails_in_row" | "done" | "stopped";
  findings: ExploreFinding[];
}

/** Sites lane: a practice site on 127.0.0.1, for tests and the S1 "Try the practice site" button. */
export interface PracticeSite {
  name: string;
  url: string;
  /** What is planted: "500 on POST /api/cart", "console error on /search", "reCAPTCHA test key on /signup". */
  plants: string[];
  close(): Promise<void>;
}
export type StartPracticeSite = (o?: { port?: number }) => Promise<PracticeSite>;
