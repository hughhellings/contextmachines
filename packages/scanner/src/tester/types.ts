/**
 * The agentic tester's words: a plan of steps, each with a check the browser measures; the one action
 * the AI may ask for at a time; and what each step and the whole test came to. No browser and no AI
 * here: the loop (run.ts) is handed its planner and its actor as functions.
 */
import type { A11yResult } from "./a11y.ts";

/** What a step must leave true, measured by the browser (check.ts). The AI never decides pass or fail of a measured check; a judged one is labelled. */
export type Check =
  | { kind: "text_visible"; text: string }
  | { kind: "url_contains"; text: string }
  | { kind: "element_visible"; role: string; name: string }
  | { kind: "title_contains"; text: string }
  /** The sign-in form is gone: no password field shows. What a sign-in (test --setup) checks when its goal names nothing to check. */
  | { kind: "password_gone" }
  /**
   * Signed in, measured (never judged): no password field and no code field shows, the page says
   * nothing like "check your email" or "wrong password", and the account's own signed-in check holds
   * (`text` visible, or the address contains `url`). `left`: the sign-in page's path, which the address
   * must have left (only when the run started on it). What a test account's sign-in ends with.
   */
  | { kind: "signed_in"; text?: string; url?: string; left?: string }
  /** The page's main video is playing: its time moves on while it is watched, and it isn't paused. */
  | { kind: "video_playing" }
  /** The page's main video is paused: it has played (its time isn't 0) and its time stands still. */
  | { kind: "video_paused" }
  /**
   * Judged, not measured: an AI that sees only the final screen decides whether `claim` holds (one
   * plain sentence, at most 200 characters). Only where no measured check can show it (a total being
   * right, what a chart draws). Its pass is always labelled "judged by AI", and its verdict never kept.
   */
  | { kind: "judged"; claim: string }
  /** W4: a file this run downloaded holds these words (read from the file itself: a CSV, JSON, text or PDF). */
  | { kind: "download_contains"; text: string }
  | { kind: "none" };

export const CHECK_KINDS = ["text_visible", "url_contains", "element_visible", "title_contains", "password_gone", "signed_in", "video_playing", "video_paused", "judged", "download_contains", "none"] as const;

/** Checks with nothing to say but their kind. */
export const BARE_CHECKS = ["none", "password_gone", "video_playing", "video_paused"] as const;

export interface PlannedStep {
  /** A few words for the checklist: "Open the docs". */
  title: string;
  /** What to do, for the actor: "Click the Docs link in the header". */
  intent: string;
  check: Check;
  /** The card's kind, when the plan came from the app's cards (shown live; the AI's own plans have none). */
  kind?: "act" | "assert" | "login";
}

/** The one thing the actor may ask for next. A ref names an element of the latest snapshot ("e12"). */
export type Action =
  | { type: "click"; ref: string; /** Said with a press again after a fill nudge (fill.ts): why the fields stay empty. */ why?: string }
  /** The pointer moved over it, nothing pressed: a menu that opens only on hover. */
  | { type: "hover"; ref: string }
  | { type: "fill"; ref: string; value: string }
  | { type: "select"; ref: string; value: string }
  /** Typed into what has keyboard focus (a search box a shortcut or a click just opened): no ref. */
  | { type: "type"; value: string }
  | { type: "press"; key: string; why?: string }
  /** With a ref: scrolls that box (a list or panel that scrolls by itself), not the page. */
  | { type: "scroll"; direction: "up" | "down"; ref?: string }
  | { type: "navigate"; url: string }
  | { type: "wait"; ms: number }
  // E7: more verbs, each through the same site guard and buy/post gate as a click.
  /** The browser's Back: to the page before, on the same site only. */
  | { type: "back" }
  | { type: "dblclick"; ref: string }
  /** A right-click: a site's own context menu. */
  | { type: "rightclick"; ref: string }
  /** A checkbox, radio or switch set on (check) or off (uncheck): nothing done when it already is. */
  | { type: "check"; ref: string }
  | { type: "uncheck"; ref: string }
  /**
   * Scrolls until these words of the page show: nothing pressed. W4: words not on the page yet are
   * scrolled for, as a person scrolls an endless list or one that draws only the rows in view; with a
   * ref, the list that element is in.
   */
  | { type: "scroll_to"; text: string; ref?: string }
  // W4: the widget verbs (widgets.ts), each through the same site guard and deny list as a click.
  /** A file given to a file field, its "Browse" button or a drop zone: a built-in sample (csv, json, png, pdf, txt, auto) or a file path the person's own words give. */
  | { type: "upload"; ref: string; value: string }
  /**
   * That element (by its ref, or with no ref by its words, `text`) dragged onto `to`: another ref, or
   * the words of where it goes (a column's name), as drop places rarely have a number.
   */
  | { type: "drag"; ref: string; to: string; text?: string }
  /** That element dragged by "x,y" pixels (right and down; negative: left and up). */
  | { type: "drag_at"; ref: string; value: string }
  /** A slider set to a number. */
  | { type: "slide"; ref: string; value: string }
  /** Tab n (from 1) shown: a window the page opened, or the first again. */
  | { type: "switch_tab"; value: string }
  /** A link or button pressed that downloads a file, and the file read. */
  | { type: "download"; ref: string }
  /** W5: a press at a point of the picture (CSS pixels of the screen), for what is only drawn (a canvas, a chart, a map): only in a step that had a picture. `what`: the words the AI sees drawn there, checked by the same deny rules as a button's. */
  | { type: "click_at"; x: number; y: number; what: string }
  | { type: "done" }
  | { type: "stuck"; why: string };

export const ACTION_TYPES = ["click", "hover", "fill", "select", "type", "press", "scroll", "navigate", "wait", "back", "dblclick", "rightclick", "check", "uncheck", "scroll_to", "upload", "drag", "drag_at", "slide", "switch_tab", "download", "click_at", "done", "stuck"] as const;

/** W4 verbs that act on an element by its ref and take a value (or, for drag, a second ref). */
export const WIDGET_VERBS = ["upload", "drag", "drag_at", "slide", "download"] as const;

/** E7 verbs that act on an element by its ref, as click does. */
export const POINTER_VERBS = ["click", "hover", "dblclick", "rightclick", "check", "uncheck"] as const;

/**
 * An element as it can be found again on another run: by its role and accessible name, the nth of
 * those. A plain clickable row has role "item" (its name is its words). The rest is optional, and
 * only used by saved tests with matching rules 2 (cache.ts): what it is inside, a link's address or
 * its words when role and name alone won't find it, its test id, and how many matched when it was saved.
 */
export interface Target {
  role: string;
  name: string;
  nth: number;
  /** The nearest named element (or open widget) it is inside: an item is looked for there. */
  within?: { role: string; name: string };
  /** A link's own address (same site, nothing secret in it), for one hidden from roles or with no name. */
  href?: string;
  /** Its first visible words (masked), for one with neither a name nor an address. */
  text?: string;
  /** Where it sits, when several share its role and name: the heading it is under ("h:Invoice B") or its row's other words ("r:…"). */
  near?: string;
  /** Its data-testid (or data-test, data-qa): when saved, it must match exactly one element. */
  testid?: string;
  /** How many matched its role and name when it was saved: a different count now means it can't be told which is meant. */
  of?: number;
  /** It is inside an embedded page of the same site: that frame's path (no query, masked), and which of the frames with that path. */
  frame?: { path: string; nth: number };
}

/** An action as it was done, kept for replay: its element by role and name, never a ref, a snapshot or a typed secret. */
export type CachedAction =
  | { type: "click"; target: Target }
  | { type: "hover"; target: Target }
  | { type: "fill"; target: Target; value: string; /** A plainly fake test value the browser made up (the actor said "auto"). */ madeUp?: true }
  | { type: "select"; target: Target; value: string; madeUp?: true }
  /** Typed into what had focus: `into` is that element when it could be named, focused again on replay; without it, whatever has focus then. */
  | { type: "type"; value: string; into?: Target; madeUp?: true }
  | { type: "press"; key: string }
  | { type: "scroll"; direction: "up" | "down"; /** The box scrolled, when not the page. */ target?: Target }
  | { type: "navigate"; url: string }
  | { type: "wait"; ms: number }
  | { type: "back" }
  | { type: "dblclick" | "rightclick" | "check" | "uncheck"; target: Target }
  | { type: "scroll_to"; text: string; /** The list scrolled, when not the page. */ target?: Target }
  | { type: "upload"; target: Target; value: string }
  /** What is dragged (its element, or its words) and where it is dropped (an element, or words). */
  | { type: "drag"; target?: Target; from?: string; to?: Target; onto?: string }
  | { type: "drag_at"; target: Target; value: string }
  | { type: "slide"; target: Target; value: string }
  | { type: "switch_tab"; value: string }
  | { type: "download"; target: Target }
  /** W5: a press at a point, with the words of what was there (replayed only where the same words are, at the same screen size). `what`: the words the AI saw drawn there; `vw`/`vh`: the screen's size. */
  | { type: "click_at"; x: number; y: number; name: string; what?: string; vw?: number; vh?: number };

export type StepVerdict = "passed" | "failed" | "blocked" | "not_sure" | "skipped";
export type TestVerdict = "pass" | "fail" | "blocked" | "not_sure";

/** One thing done inside a step, as a person would say it: "Clicking on 'Docs' link". */
export interface SubAction {
  label: string;
  /** Seconds into the video. */
  at: number;
  /** It was tried and didn't work: why (the step goes on). */
  error?: string;
  /** Replayed from the saved test, with no AI asked. */
  cached?: true;
  /** A safety stop: it was not done. */
  blocked?: true;
}

export interface StepResult {
  n: number;
  title: string;
  intent: string;
  check: Check;
  verdict: StepVerdict;
  /** Why it wasn't passed, in one sentence. */
  reason?: string;
  /** For a failed check: what was expected, and what the page had instead. */
  evidence?: { expected: string; found: string };
  actions: SubAction[];
  ms: number;
  /** Seconds into the video where the step began. */
  at: number;
  /** The photo at the step's end, a file name in the run's folder. */
  screenshot?: string;
  /** Nothing changed since this step's photo: the same one is shown. */
  sameShotAs?: number;
  /** It passed, but its check proves little: why (it held before the step, or the test typed its words itself). */
  weak?: string;
  /** A saved action's element wasn't there, so the AI found another way: what was, and what is now. Never silent. */
  /**
   * `finished`: nothing saved was missing, but the saved actions stopped short of what the step says
   * (recorded under older rules): `from` says what was left, and the AI did `to` to finish it.
   */
  healed?: { from: string[]; to: string[]; finished?: true };
  /** Every action came from the saved test. */
  replayed?: true;
  /** Values it won't make up that the step needed (a password, a card): the --var names to pass. */
  needs?: string[];
  /**
   * An AI judged this step, not the browser: its check is a judged one ("check"), or the planner's own
   * guessed check didn't hold and the judge was asked once with the goal's words ("second opinion").
   * Shown as "judged by AI" wherever the step is shown. `overruled`: the planned check that didn't hold.
   */
  judged?: { by: "check" | "second opinion"; reason: string; image: boolean; overruled?: string };
  /**
   * A step that saves: what the forms it sent showed at the press (fill.ts): fields a real user would
   * fill, how many had a value, and the labels left empty (never a value). `kept`: the actor's one line
   * for leaving them empty after it was asked.
   */
  fill?: { shown: number; filled: number; empty: string[]; kept?: string; status?: string[] };
  /** E10: a BLOCKED step's group, when the engine measured it (a protection that stood in the way: "bot_wall"). */
  blockedGroup?: import("../../../../cli/app/contracts.ts").BlockedGroup;
}

/**
 * Where a new user might get stuck, as the run met it: facts the browser measured, never an AI's
 * opinion. A pop-up that had to be closed, a step that took many actions or a second try, a control
 * with no name that had to be used, a validation error the page showed, a step that waited long, a
 * bot check that stood in front of the site and didn't let the browser in.
 */
export type FrictionKind = "popup" | "many_actions" | "retry" | "unnamed_control" | "validation" | "slow" | "bot_check";

export const FRICTION_KINDS = ["popup", "many_actions", "retry", "unnamed_control", "validation", "slow", "bot_check"] as const;

export interface Friction {
  kind: FrictionKind;
  /** The step it was met in. */
  step: number;
  /** What happened, in one plain sentence, with --var values masked: "Closed a pop-up ('Cookies') with 'Reject all'". */
  says: string;
}

export interface TestResult {
  goal: string;
  url: string;
  verdict: TestVerdict;
  steps: StepResult[];
  passed: number;
  ms: number;
  startedAt: string;
  /** The run's video, a file name in its folder, when one was recorded. */
  video?: string;
  /** What the video shows of stored values, said plainly: boxes as dots, where the sign-in is, what a card stands in for. */
  videoNote?: string;
  /** The sign-in's own video (sign-in.webm), in the run's folder, for a run that signed in just before it began. */
  signInVideo?: string;
  /** Actions taken, all steps together. */
  actions: number;
  /** Replayed from a saved test. */
  replay?: boolean;
  /** Something stopped the whole test early (a budget, the clock). */
  stopped?: string;
  /** Where a new user might get stuck: what the run met on the way (empty when nothing). */
  friction: Friction[];
  /** The accessibility scan of the same-site pages it reached (a11y.ts): measured with no AI. */
  accessibility?: A11yResult;
  /** A bot check stood in front of the site and stayed: its name ("Cloudflare's bot check"). The test is BLOCKED, never a FAIL. */
  botWall?: string;
  /** The address the run ended on (masked, without secrets). */
  endUrl?: string;
  /** Every address the page went to, in order, with seconds into the video (masked, without secrets). */
  urls?: { t: number; url: string }[];
  /** The start address showed "not found" (a 404, or a title or heading that says so): said, never acted on, in a run given its address. */
  startWarning?: string;
  /** Why a sign-in couldn't go on, as a code a pipeline can act on (C19): the site refused the password, or the guard stopped more tries. */
  code?: SignInCode;
  /** How many passed steps an AI judged rather than the browser measured: said beside the verdict wherever it is shown. */
  judged?: number;
  /**
   * The goal judge (run.ts): once every step passed, a separate AI looked at the final page (text only,
   * no picture) and the browser's record of what was done, and said whether the goal was achieved.
   * "fails" made the test NOT SURE with its reason; "holds" or "not_sure" left the pass as it was.
   */
  goalJudge?: { verdict: "holds" | "fails" | "not_sure"; reason: string };
  /**
   * W3: the measured proof that a write was kept (proof.ts): held, failed (the run is then NOT SURE)
   * or unmeasured, with what was looked for, where, and the counts before the save and after a fresh load.
   */
  proof?: import("./proof.ts").WriteProof;
  /**
   * A saved test recorded under older rules whose saved steps couldn't do what they say (stale.ts):
   * it was planned again from its goal under today's rules, and this says why, in plain words.
   */
  replanned?: string;
  /** Pictures of the screen sent to the AI in this run (fields that could hold a secret blacked out): a count, never the pictures. */
  pictures?: number;
  /** E1: what the page did (console, page errors, failed requests, 4xx/5xx, navigations), masked and redacted. Site text: show as text only. */
  log?: import("../../../../cli/app/contracts.ts").AppLogEntry[];
  /** E10: the protections the run met (captchas, challenge pages, host protection), named; the setup line only for an owned host. */
  protection?: import("../../../../cli/app/contracts.ts").ProtectionFinding[];
  /** The person's notes about the site that this run was given (notes.ts): their length and SHA-256 only, never their words. */
  siteNotes?: { chars: number; sha256: string };
  /** Recovery tries after a refusal the site explained (recover.ts): which step, the page's words, the control, what it was and became. */
  recoveries?: { step: number; refusal: string; control: string; from?: string; options: string[]; to?: string }[];
  /** Only in runs from before A1 (a person passed a check or typed a code mid-run): read, never made now. */
  handovers?: import("../../../../cli/app/contracts.ts").HandOverRecord[];
}

/**
 * Sign-in and site-access codes (C19), each with a one-line fix. Each is BLOCKED but
 * CODE_NOT_RECEIVED, a FAIL: the inbox answered the whole time and the app sent nothing (likely an
 * app bug); and CODE_NOT_SURE, not sure: a message came, but its code or link wasn't certain.
 * The last three are about getting onto a site the person owns at all (C15): it asked for a basic-auth
 * login, for a Vercel login, or showed a bot check, and no owner token for it was set.
 * CODE_NEEDS_PERSON: the site sent a code or link to the person's own inbox, which a run never waits
 * for (A1: "Set up sign-in" under Accounts, once, with the person there, is the fix). SMS_CODE_NEEDED:
 * the same for a code by text. DEVICE_CHECK: the site asked to confirm a new device ("check your email
 * to confirm it's you"). TEST_CODE_NOT_ALLOWED: a sign-in provider's test code (Clerk's 424242) is set
 * for an account, and the host isn't marked as yours, so it is never typed there. BOT_CHECK_NEEDS_PERSON:
 * a captcha or bot check stood in front of signing in on a host that isn't yours (on yours it is
 * ACCESS_TOKEN_REQUIRED): never solved by code, so a person passes it once in "Set up sign-in". SIGN_IN_NOT_CONFIRMED: no one said this is their own account on that host.
 * AUTH_ACCOUNT_NEEDED: a step signs in and no account was given to sign in as (it never makes one up);
 * ACCOUNT_NOT_CHOSEN: the project has several accounts and nothing said which; VALUE_NEEDED: a step
 * needs a value it won't make up (a card, a message). All three BLOCKED: the site isn't broken.
 * SEED_DATA_MISSING: the site refused a save for a reason it explained (a verified account takes no manual
 * trades), and the form had no other choice it may use (recover.ts): BLOCKED, the fix is to add what the
 * site needs or say which to use in the person's notes (e2e's and TesterArmy's name for it).
 */
export type SignInCode = "AUTH_CREDENTIAL_INVALID" | "AUTH_ACCOUNT_LOCKED_OUT" | "AUTH_CREDENTIAL_UNAVAILABLE" | "AUTH_SESSION_EXPIRED" | "CODE_NOT_RECEIVED" | "CODE_SOURCE_UNAVAILABLE" | "CODE_NOT_SURE" | "SIGNUP_NOT_ALLOWED" | "AUTH_BASIC_REQUIRED" | "VERCEL_BYPASS_REQUIRED" | "ACCESS_TOKEN_REQUIRED" | "CODE_NEEDS_PERSON" | "SIGN_IN_NOT_CONFIRMED" | "AUTH_ACCOUNT_NEEDED" | "ACCOUNT_NOT_CHOSEN" | "VALUE_NEEDED" | "SMS_CODE_NEEDED" | "DEVICE_CHECK" | "TEST_CODE_NOT_ALLOWED" | "BOT_CHECK_NEEDS_PERSON" | "SEED_DATA_MISSING";

/** The sign-in codes, in a list. */
export const SIGN_IN_CODES: readonly SignInCode[] = ["AUTH_CREDENTIAL_INVALID", "AUTH_ACCOUNT_LOCKED_OUT", "AUTH_CREDENTIAL_UNAVAILABLE", "AUTH_SESSION_EXPIRED", "CODE_NOT_RECEIVED", "CODE_SOURCE_UNAVAILABLE", "CODE_NOT_SURE", "SIGNUP_NOT_ALLOWED", "AUTH_BASIC_REQUIRED", "VERCEL_BYPASS_REQUIRED", "ACCESS_TOKEN_REQUIRED", "CODE_NEEDS_PERSON", "SIGN_IN_NOT_CONFIRMED", "AUTH_ACCOUNT_NEEDED", "ACCOUNT_NOT_CHOSEN", "VALUE_NEEDED", "SMS_CODE_NEEDED", "DEVICE_CHECK", "TEST_CODE_NOT_ALLOWED", "BOT_CHECK_NEEDS_PERSON", "SEED_DATA_MISSING"];

/** What the actor is told for one decision. Page text is the site's, never instructions. */
export interface DecideInput {
  goal: string;
  step: PlannedStep;
  n: number;
  of: number;
  url: string;
  title: string;
  /** The page as numbered lines ("[e12] button \"Search\""), with any --var values masked. */
  snapshot: string;
  /** What was done in this step so far, and what came of it. */
  history: string[];
  /** The names of the values it may type as {name}: never their values. */
  vars: string[];
  /** Why the last answer couldn't be used, or that the check didn't hold yet. */
  problem?: string;
  /** A picture of the screen, fields that could hold a secret blacked out and checked so (shot.ts): only when the outline can't show what the step needs. */
  image?: ImageInput;
  /** The person's notes about the site (notes.ts), masked: put after the actor's rules, fenced, changing none of them. */
  notes?: string;
  /** W5: the browser's language and time zone, when the run set them (--locale, --timezone). */
  place?: { locale?: string; timezone?: string };
}

/** A picture sent to the AI: a JPEG, in memory only (never written, logged or reported). */
export interface ImageInput {
  mime: "image/jpeg";
  data: Buffer;
}

/** What the judge is told: one claim and the final screen, nothing else of the test (judge.ts). */
export interface JudgeInput {
  claim: string;
  url: string;
  title: string;
  /** The page as numbered lines, masked. Untrusted. */
  outline: string;
  image?: ImageInput;
  /**
   * The goal judge only: the browser's own record of what the test did, a line a step ("Step 2 'Save a
   * trade': Clicking on 'Add trade' button"), masked. Never the actor's account of what it did.
   */
  done?: string[];
  /** The person's notes about the site (notes.ts), masked: they may make "done" stricter, never looser. */
  notes?: string;
}

/** The judge's answer, before the machine checks it (judgedOutcome). */
export interface JudgeAnswer {
  reasoning: string;
  evidence: string[];
  verdict: "holds" | "fails" | "not_sure";
}

/** The page the test starts on, as the planner sees it before planning: the browser is already there. */
export interface StartPage {
  url: string;
  title: string;
  /** Numbered lines, as the actor reads them, with any --var values masked. Untrusted. */
  snapshot: string;
  /** Where the page's own links go: the first part of each address, most common first ("/symbols/"). Untrusted. */
  addresses?: string[];
  /** The run starts signed in as this account (the app signed in first): the planner plans nothing that signs in (signedin.ts). */
  signedInAs?: string;
}

/** Planner and actor, handed in by whoever runs the test (the CLI asks an AI; tests script them). */
export interface TesterBrain {
  /**
   * `problem`: why the last plan is sent back (a step's check already held on the start page, so it
   * proves nothing): asked once, and only ever to plan again, never to pass or fail anything.
   * `instructions` (C24): the project's agent instructions, fenced as notes (plan.ts fenceInstructions); the planner's only, no gate reads them.
   */
  plan(goal: string, url: string, given?: string[], start?: StartPage, problem?: string, instructions?: string): Promise<PlannedStep[]>;
  decide(input: DecideInput): Promise<Action>;
  /** A separate ask (never the actor's): whether one claim holds on the final screen. Missing: judged checks are not sure. */
  judge?(input: JudgeInput): Promise<JudgeAnswer>;
  /** The AI takes pictures of the screen. */
  sees?: boolean;
  /**
   * E4: the next action and up to 3 more after it, on the same page (open the search, type, press
   * Enter). Optional: a brain without it is asked one action at a time. Each one after the first is
   * done only once the browser has looked again: dropped when one before it failed, the page went
   * elsewhere, its element is gone, or the step's check already holds.
   */
  decideMany?(input: DecideInput): Promise<Action[]>;
}

/** Something about the run that should be shown as it happens. */
export type TestEvent =
  | { type: "phase"; words: string }
  | { type: "planned"; steps: PlannedStep[]; replay: boolean }
  | { type: "step"; n: number }
  | { type: "action"; n: number; action: SubAction }
  /** A saved element has gone: `ai` says whether the AI is asked to find another way (with none, the step is not sure). */
  | { type: "healing"; n: number; missing: string; ai: boolean; /** Nothing saved is missing: the saved actions stopped short of what the step says, and `missing` is what is left. */ unfinished?: true }
  /** What the run is doing now inside a step, between actions: "Capturing page snapshot", "Asking the AI for the next action". Shown by the web view; the terminal leaves it. */
  | { type: "working"; n: number; words: string; /** Seconds into the video when it began. */ at?: number }
  | { type: "stepEnd"; step: StepResult };

/** The run couldn't happen: no browser, the site didn't answer. Exit 3, not a failed test. */
export class CouldNotRun extends Error {
  override name = "CouldNotRun";
}

/**
 * Words that say a goal or step is about being signed out, or a sign-in meant to fail: it must not be
 * run signed in as an account, nor have its check turned into "signed in".
 */
export const NOT_SIGNING_IN = /\b(?:sign(?:ed|s|ing)?[ -]?out|log(?:ged|s|ging)?[ -]?(?:out|off)|not (?:signed|logged)[ -]?in|without (?:signing|logging)[ -]?in|(?:wrong|bad|invalid|incorrect|unknown|empty|blank|missing|fake) (?:password|e-?mail|username|credentials|details|log[ -]?in|sign[ -]?in)|(?:password|e-?mail|username|credentials) (?:is |are )?(?:wrong|invalid|incorrect)|(?:sign|log)[ -]?in (?:fails?|failed|failing|errors?|is (?:rejected|refused|denied))|redirect(?:s|ed)? (?:you )?(?:back )?to (?:the )?(?:log|sign)[ -]?in|(?:sends?|takes?|bounces?|goes|kicks?) (?:you )?(?:back )?to (?:the )?(?:log|sign)[ -]?in|as an? (?:visitor|guest|anonymous)|anonymous(?:ly)?|logged-out)\b|\{bad\.|\{wrong\./i;
