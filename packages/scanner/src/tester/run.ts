/**
 * The agentic tester's loop: a goal in, a checklist of steps out, each passed only when the browser
 * measures its check. The AI is handed in (TesterBrain): it plans the steps and picks one action at a
 * time from a numbered snapshot, and is never asked whether a step passed. Every action goes through
 * act.ts's safety rules. A saved test replays with no AI at all; where a saved element has gone, the
 * AI is asked for that step only and the step says it was healed.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator, Page, Response } from "playwright";
import { accessRefusal, type AccessRefusal, type OwnerAccess } from "./access.ts";
import { act, guardSite, labelOf, locateLive, locateSaved, onSite, refusedName, refusedOnOwnAccount, refusedPlace, refusedSignedOut, RULES, siteOf, type ActContext, type ErrorKind, type Outcome } from "./act.ts";
import { A_CHALLENGE, botWall, CHALLENGE_REFUSED, wallReason, WallWatch } from "./botwall.ts";
import type { SavedStep, SavedTest } from "./cache.ts";
import { checkFrom, PLAN_RULES, withoutSecrets } from "./cache.ts";
import { onConsentHost, rejectConsent } from "./consent.ts";
import { CHECK_WAIT_MS, codePageOn, deviceCheckOn, expected, verify, type Verified } from "./check.ts";
import { changeOf, observe, PLAN_SNAPSHOT_CHARS, SNAPSHOT_CHARS, type Snapshot, type SnapTarget } from "./observe.ts";
import { A11yLog } from "./a11y.ts";
import { FrictionLog, closesPopup, interactionsOf, openDialog, pageErrors, unnamedControl } from "./friction.ts";
import { launch, placeOptions, record, SIZE, sizeOptions, type Place, type Recording, type StorageState } from "./record.ts";
import { seeShadowRoots } from "./shadow.ts";
import { liveOnSight } from "./paygate.ts";
import { checkoutOf, providerOf } from "./paymode.ts";
import { payModeOf } from "./paysurface.ts";
import { fillPlaceholders, isPasswordName, makeMasker, placeholderNames, splitName, usesPlaceholder, type Fresh, type Masker, type Resolver } from "./placeholders.ts";
import { fieldFacts, madeUpValue, refusedMadeUp, requiredEmpty, varHint, type MadeUpRules } from "./values.ts";
import { attachAppLog, type AppLog } from "./applog.ts";
import { detectProtection, guardedSend, humanCheck, probePage, protectionEnd, unsolvedWidget, WIDGET_KINDS } from "./detect-botwall.ts";
import { maskOptions, SecretFields } from "./maskshot.ts";
import { SIGN_IN_OWN_VIDEO, SIGN_IN_SAVED, signedInCard, TYPING_CARD, VIDEO_CARD, VIDEO_DOTS, VIDEO_STILL_SHOWS } from "./cover.ts";
import { failedLine, networkWatch, pageSignature, POLL_MS, SETTLED_AGAIN_MS, SETTLED_WAIT_MS, waitForChange, waitWords, WAIT_MAX_MS } from "./waitfor.ts";
import { asideProblem, createsRecord, fillRecordOf, forAnotherPurpose, formFields, formKey, joinRecords, namedIn, newNudge, nudge, pressCandidate, sendsOn, shownFields, type FillRecord, type FormScan } from "./fill.ts";
import { gives, goalAsks, goalJudgeClaim, intentNeeds, intentShortfall, savePress, sendName, shortfallProblem, withoutChoices, withoutSignIn, type IntentNeeds } from "./intent.ts";
import type { AppLogEntry, ProtectionFinding } from "../../../../cli/app/contracts.ts";
import { ACTION_TYPES, CouldNotRun, NOT_SIGNING_IN, POINTER_VERBS, WIDGET_VERBS, type Action, type CachedAction, type Check, type ImageInput, type PlannedStep, type StartPage, type StepResult, type SubAction, type TesterBrain, type TestEvent, type TestResult, type TestVerdict } from "./types.ts";
import { afterSignIn } from "./signedin.ts";
import { fenceNotes, notesDigest, notesRecord, tidyNotes } from "./notes.ts";
import { choicesIn, MAX_RECOVERIES, optionProblem, recoveryFor, refusalIn, tryLine, type Choice, type Recovery } from "./recover.ts";
import { actOf, LIST_ADD, listLinks, proveWrite, safeToReopen, readPlain, urlKey, WriteWatch, type ProofAct, type Reading, type WriteProof } from "./proof.ts";
import { answerDialog, dialogNote, Downloads, downloadsOf, Tabs } from "./widgets.ts";
import { DRAWN, judgedOutcome, judgedPlanProblem, secondOpinionClaim, secondOpinionWanted, type JudgedOutcome } from "./judge.ts";
import { DRAWN_SHARE, drawnShare, maskedShot, NO_PICTURE_SECRET, PICTURES_FALLBACK_MAX, PICTURES_PER_TEST, ShotDesk } from "./shot.ts";

/** A control named like a save, never "Continue" or "Next" (which only go through a wizard): what clears a refusal the page showed. */
const SAVE_WORD = /\b(save|submit|add|create|confirm|record|place|publish|post|send|update)\b/i;

export const DEFAULTS = { maxActions: 25, maxPerStep: 8, minutes: 3, maxSteps: 8 } as const;

/** How many times a step's budget its first fills of distinct fields give back: a form of 30 fields is filled in whole, never without end. */
export const FORM_TURNS = 4;

/** Why a draft's step done for the first time is NOT SURE: it did nothing, or its check proves nothing. */
export function draftProvesNothing(didSomething: boolean, weak: string | undefined, check: string, mask: (s: string) => string = (s) => s): string {
  const what = weak ? `${didSomething ? "this draft's step's" : "its"} check (${check}) proves nothing: ${weak.replace(/, so it proves little$/, "")}` : "it measured only what was there before it";
  return mask(`${didSomething ? "" : "this draft's step did nothing, and "}${what}; the draft is kept, so give its step a check that only holds once it's done`);
}

/** Why a draft's step can't run with no AI: it has never been done, so there is nothing to replay. */
export const DRAFT_NO_AI = "this step of a draft test hasn't been done yet, and there's no AI to do it (--ai): run the draft once with an AI, and its pass is saved for replay";

/** How long a visitor's check waits for a big public site to settle (ads, players, late drawing). */
export const VISITOR_CHECK_WAIT_MS = 10_000;

/** Waits in a row the actor may ask for: one more ends the step. */
const MAX_WAITS = 2;
/** The rest of the page sent again on a second look in a step, at the same address, in characters. */
export const REST_AGAIN_CHARS = 4000;

export interface RunOptions {
  goal: string;
  url: string;
  /** Plans and acts. Without one, only a saved test can run, and a step that needs healing ends not sure. */
  brain?: TesterBrain;
  /** A saved test to replay. */
  saved?: SavedTest;
  /**
   * This run plans afresh because a saved test of this goal was recorded under older rules and couldn't
   * do what it says (staleSteps): why, in a person's words. The live view and the result say so. runTest
   * sets it itself when it is given such a saved test and an AI; the app's cards (runPlan) set it too.
   */
  replanned?: string;
  /**
   * The saved test's cards have ones the person wrote that aren't in `saved` (a card switched off, Login
   * cards for more than one account): it is never planned again from its goal over them (runPlan).
   */
  ownedCards?: true;
  /** The project's app name: a saved test of that app is at home on this address (healed and saved). */
  identity?: string;
  /** Steps the person gave (--steps): the planner keeps them and only adds checks. */
  given?: string[];
  /** The run's folder: video, photos. */
  dir: string;
  headed?: boolean;
  /** A browser to use instead of starting one (tests share one). */
  browser?: Browser;
  maxActions?: number;
  maxPerStep?: number;
  minutes?: number;
  allowHosts?: string[];
  vars?: Record<string, string>;
  on?: (event: TestEvent) => void;
  /** How long a check waits for the page to settle (default 5s). */
  checkWaitMs?: number;
  /** A saved browser session to start signed in with (test --setup's file, or an account's), for the first look and the run. */
  storageState?: string;
  /**
   * The account the run starts signed in as (with `storageState` and `secrets`: the app signed in first). The
   * planner is told, and plans nothing that opens, fills or submits the sign-in form (signedin.ts). Unset:
   * the label is read from the account's value names ({sam.password} → sam).
   */
  signedInAs?: string;
  /**
   * A test account's values ({admin.username}, {admin.password}), asked for by name. The AI is told
   * only the names; every value is added to the masker before the first look, so none reaches it.
   */
  secrets?: Resolver;
  /** The masker to use (and tell new values to), shared with whoever shows the run's words. Made from `vars` when not given. */
  masker?: Masker;
  /**
   * After a full pass of a test that didn't sign out, the session is written back here (C4): a site
   * that rotates its refresh token on every use keeps working on the next test.
   */
  writeBackTo?: string;
  /**
   * The sign-in guard shared by every run of a suite (hard rule 8): how many sign-in submits each
   * account has had, and the accounts whose password the site has said is wrong. One rejected
   * password stops that account; at most 3 submits per account in any case.
   */
  signInGuard?: SignInGuard;
  /** The sign-in page's path for this account (C4): a signed-in test that lands back on it has lost its session. */
  signInPath?: string;
  /** On a full pass, save the browser's session here (owner-only): what test --setup is for. */
  saveStateTo?: string;
  /** No video and no photos (a sign-in run: its screens would show what was typed). A test that types a --var value never keeps any either. */
  noMedia?: boolean;
  /**
   * Make up no values at all (test --setup): a sign-in is typed only from what it was given. A goal or
   * steps that use a {name} make nothing up either.
   */
  noMadeUp?: boolean;
  /**
   * What to say when a step needed a password nobody gave and this host has a saved session (or had
   * one): the session is missing or expired, and --setup signs in again. Said instead of the --var hint.
   */
  signInHint?: string;
  /** Find nothing again with the AI, and save nothing: the test runs somewhere other than its own address (--url in a suite). */
  noHeal?: boolean;
  /**
   * A visitor's test (a task suggested for a site): a consent wall is answered "no" as the site opens
   * (consent.<site> allowed only then), nothing that signs in is pressed, and a big public site gets
   * longer waits. Saved with the test, so a replay is done the same way.
   */
  visitor?: boolean;
  /**
   * Handed the recorded page as soon as it exists, before the site opens (the web view's live screen).
   * `noMedia`: this run keeps no video or photos (a sign-in run), so nothing of its screen may be shown
   * either. A run that may type a stored value keeps both, `covered`: its frames show the cover's card
   * while a stored value is typed or shows (cover.ts).
   */
  onPage?: (page: Page, info: { noMedia: boolean; fields?: SecretFields; /** The page has the cover (cover.ts): its frames never show a stored value. */ covered?: boolean }) => void | Promise<void>;
  /** The cover's card went up (a stored value is being typed) or came down: for the live screen's words. */
  onCover?: (e: { up: true; words: string } | { up: false }) => void;
  /**
   * The video of this run's sign-in (a run of its own just before, by ensureSession), with its boxes as
   * dots: copied into this run's folder as sign-in.webm, beside the run's own video.
   */
  signInVideo?: string;
  /** Stop: no further action is taken, and the step running ends not sure ("stopped by you"). Whoever aborts also closes the browser for a hard stop. */
  signal?: AbortSignal;
  /** How long, in all, the run waits for a bot check to clear by itself (BOT_WALL_WAIT_MS; tests make it short). */
  wallWaitMs?: number;
  /** E5: the longest one "wait" lasts while the browser watches the page for a change (WAIT_MAX_MS; tests make it short). */
  waitMaxMs?: number;
  /**
   * C7: this run signs in as (or signs up) a test account on `host`, a host where the person may sign
   * in (owned, or acknowledged), so a "send code / send link" button may be pressed there (at most 3 times). Ignored for a
   * visitor's test. `signUp`: its form may also ask for a name and a password.
   */
  codeSends?: { host: string; signUp?: boolean };
  /**
   * The exact hosts (port included) a test account's values may be typed on: the account's own, and
   * hosts marked as the person's or where they said it's their own account. With `secrets` and no list,
   * only the start host (failing closed: a caller that forgets gets the strict rule).
   */
  accountHosts?: string[];
  /** Signed in with the person's own account on a host that isn't marked as theirs (only acknowledged): see act.ts refusedOnOwnAccount. */
  notOwned?: boolean;
  /**
   * D14: this run may pay, in a provider's test mode only, on these hosts the person marked as theirs
   * (accounts' owned hosts). Never set for a visitor's test. Unset: the deny list stands as it is.
   */
  payments?: { owned: readonly string[]; /** Shared by every run of one test (a sign-in again runs it twice): one final pay press in all. */ finalPresses?: { n: number } };
  /**
   * C15: what the owner of the start site issued for it (a bypass secret, a service token, a basic-auth
   * login, a header of their own, a Clerk Testing Token), sent only to its exact host by guardSite.
   * Every value in it is masked from everything shown.
   */
  owner?: OwnerAccess;
  /** The start host is marked as the person's own: a bot check that stays there says which owner token to set (ACCESS_TOKEN_REQUIRED). */
  ownedHost?: boolean;
  /**
   * C13: a sign-in window the page opens on a host allowed for it (the provider's, given with
   * --allow-host) is left to finish and answer its opener, not closed. Nothing is done or typed in it.
   */
  keepPopups?: boolean;
  /** Hosts treated as a sign-in provider's beside the listed ones (a test's fake provider): nothing is typed there. */
  providerHosts?: string[];
  /** No check is judged by an AI: none is planned, no second opinion is asked, and a saved judged step is not sure. */
  measuredOnly?: boolean;
  /**
   * Steps (by their place in `saved.steps`, from 0) whose check the person wrote or edited (the app's
   * cards): a check you asked for never gets a second opinion. A saved Assert step never does either.
   */
  ownChecks?: readonly number[];
  /** E10: each protection the run meets, named, as it is found. */
  onProtection?: (f: ProtectionFinding) => void;
  /** E1: each new app-log line as it happens (site text: show it as text only). */
  onLog?: (e: AppLogEntry) => void;
  /** E9: the page's size, for the first look and the run (PHONE for a phone's width). Default SIZE. */
  viewport?: { width: number; height: number };
  /**
   * The person's notes about how the site works (notes.ts: "What the tester should know about this
   * site"): masked, fenced and given to the planner, the actor and both judges after their own rules,
   * changing none. Only their length and digest are recorded; a saved test passed with other notes is
   * planned again. The caller refuses notes that hold a secret (notesProblem) before they get here.
   */
  siteNotes?: string;
  /** W5: the browser's language and time zone (a de-DE or Arabic user, a user in Tokyo). Default: the machine's. */
  place?: Place;
}

/** What a stopped run says. */
export const STOPPED_BY_YOU = "stopped by you";

/** Shared by the runs of one suite: sign-in submits per account, and accounts the site said no to. */
export interface SignInGuard {
  submits: Map<string, number>;
  rejected: Set<string>;
  /** Accounts whose sign-in met "confirm it's a new device": not sent again in this run or suite (each send could mail the person). */
  deviceCheck?: Set<string>;
}

/** Sign-in submits one account may have in a run or a suite, whatever happens. */
export const MAX_SIGN_IN_SUBMITS = 3;

export const newSignInGuard = (): SignInGuard => ({ submits: new Map(), rejected: new Set(), deviceCheck: new Set() });

/** Words a page says when a password was refused or the account is now locked. */
export const CREDENTIAL_REFUSED = /\b(wrong (email|e-mail|username|user name|password|credentials)|incorrect (email|e-mail|username|password|credentials)|invalid (email|e-mail|username|password|credentials|login)|(password|email|e-mail|credentials) (is |are |was |were )?(incorrect|wrong|invalid|not right)|(doesn'?t|does not|didn'?t|did not) match|(account|user) (is |has been )?(locked|blocked|suspended)|too many (failed )?(attempts|tries|sign-in attempts))\b/i;

export interface RunOutcome {
  result: TestResult;
  /**
   * A test started with a saved session found itself signed out (it was sent to the sign-in page, or
   * a step needed a password): the session has expired. Whoever ran it may sign in again (with no AI)
   * and run the test once more, from step 1.
   */
  sessionExpired?: true;
  /** What to save for the next run: only after a full pass that wasn't a plain replay. */
  save?: Omit<SavedTest, "version" | "savedAt">;
}

/**
 * Hides --var values (and, told more mid-run, account values and codes) wherever they show: each
 * becomes its {name}, in every form a site may echo it (placeholders.ts). Longest first, so one inside
 * another doesn't leave a piece. A value of one or two characters is no secret, and hiding it would
 * break every word it is part of.
 */
export function masker(vars: Record<string, string> = {}): Masker {
  return makeMasker(vars);
}

/** A step that quietly does less than the goal: the browser, not the planner, decides what is refused. */
const SOFTENED = /\b(without (actually )?(clicking|pressing|sending|submitting|saving|deleting|paying|confirming)|stop(ping)? (just )?(before|short of)|do(n't| not) (actually )?(click|press|send|submit|pay|delete|confirm)|avoid (clicking|pressing|sending|submitting)|instead of (clicking|pressing|sending|submitting)|(only )?(locate|find) (the|a) .{0,40}\b(button|control) (but|and) (not|don't))/i;
/** A step that changes something on the page: it needs a check that shows it worked. */
const DOES = /\b(fill|type|search for|submit|save|send|sign in|log in|create|add|upload)\b/i;
/** Keeps or sends something: a step that does this always needs its own check. */
const KEEPS = /\b(fill|submit|save|send|sign in|log in|create|add|upload)\b/i;
/** A search on the way to a result (typed, then a result chosen) may leave its check to the next step. */
const onTheWay = (words: string) => /\bsearch/i.test(words) && !KEEPS.test(words);
/** A press that may lead to the next page of a wizard (its turn given back once for each new address). */
const POINTER_TURNS: ReadonlySet<string> = new Set(["click", "dblclick", "press"]);
/**
 * A step's words without the names of the controls it presses: "Click the \"Add trades\" button" opens
 * something, it doesn't add anything. Quoted names, the words between "the" and "button", "link",
 * "tab", "card", "tile", "menu", "dialog", "form", "page", "panel" or "options", and the "add" of "open
 * Add trades", are left out of what the step is read as doing, unless the name itself sends something
 * ("the Save button" still saves) or does something ("Add to cart", "Add member", "Fill in"). An
 * "Add …" name is only left out when the step says it opens or goes somewhere.
 */
const SENDING_NAME = /\b(save|submit|send|create|post|publish|confirm|sign[ -]?(in|up)|log[ -]?in|register|upload)\b/i;
/** A name that does something itself ("Add to cart", "Add member", "Fill in", "Type your name"): never left out. */
const DOING_NAME = /\b(fill|type|enter|put|join|invite|cart|basket|bag|member|comment|reply|vote|follow|subscribe|buy|order|pay|book|reserve)\b/i;
/** The step says it opens or goes to something: only then is an "Add …" name read as a place ("Open Add trades"). */
const OPENS = /\b(open(?:s|ing)?|go(?:es|ing)? to|navigate to|start(?:s|ing)?|begin(?:s|ning)?)\b/i;
export const withoutControlNames = (words: string) => {
  const opens = OPENS.test(words.replace(/["“”][^"“”]{1,60}["“”]|‘[^‘’]{1,60}’/g, " "));
  const keep = (name: string) => (SENDING_NAME.test(name) || DOING_NAME.test(name) || (/\badd\b/i.test(name) && !opens) ? name : " ");
  return words
    .replace(/["“”][^"“”]{1,60}["“”]|‘[^‘’]{1,60}’/g, keep)
    .replace(/\b(?:the|its|a)\s+((?:[\w&+'’-]+\s+){1,4})(?=(?:button|link|tab|card|tile|menu|dialog|form|page|panel|options?)\b)/gi, (all, name: string) => all.replace(name, keep(name)))
    // "Open Add trades", "go to the add trade page": what is opened, not what is done.
    .replace(/\b(open(?:s|ing)?|go(?:es|ing)? to|navigate to)\s+(the\s+|an?\s+)?add\b/gi, "$1 $2");
};

/**
 * What's wrong with a plan, or nothing. The last step must measure something; a step that measures
 * nothing must be followed by one that does, and may only move about. And the plan must be the
 * goal's: a step that does less than the goal says ("find the Send button without clicking it") is
 * refused, so a goal that asks for something unsafe is planned as it is and stopped by the browser,
 * never turned into a harmless test that passes.
 */
export function planProblem(steps: readonly PlannedStep[], goal = "", o: { measuredOnly?: boolean; given?: readonly string[] } = {}): string | undefined {
  if (!steps.length) return "there are no steps";
  if (steps.length > DEFAULTS.maxSteps) return `there are ${steps.length} steps; at most ${DEFAULTS.maxSteps}`;
  for (const [i, s] of steps.entries()) {
    if (!s.title?.trim() || !s.intent?.trim()) return `step ${i + 1} needs a title and an intent`;
    if (!checkFrom(s.check)) return `step ${i + 1}'s check isn't one of text_visible, url_contains, element_visible, title_contains, video_playing, video_paused, download_contains, ${o.measuredOnly ? "" : "judged, "}none (with its text, role and name, or claim)`;
    if (SOFTENED.test(`${s.title} ${s.intent}`)) return `step ${i + 1} does less than the goal ("${s.intent.slice(0, 80)}"): plan exactly what the goal says; anything unsafe is stopped by the browser and reported`;
    if (s.check.kind === "element_visible" && !s.check.name.trim()) return `step ${i + 1}'s element_visible check needs the element's name`;
    if (s.check.kind === "none" && DOES.test(withoutChoices(withoutControlNames(`${s.title} ${s.intent}`))) && !onTheWay(`${s.title} ${s.intent}`)) return `step ${i + 1} fills in or submits something, so it needs a real check that shows it worked: what the page shows once it is saved (a message, the new entry in its list, its own page)${o.measuredOnly ? "" : "; when you can't see what that will say, a judged check about it"}`;
    if (s.check.kind === "none" && (i === steps.length - 1 || steps[i + 1]!.check.kind === "none")) {
      return i === steps.length - 1 ? "the last step must have a real check" : `step ${i + 1} has no check, so step ${i + 2} must have one`;
    }
  }
  // Judged checks (judge.ts): at most 2, a plain claim about the page, never on a step that types, none with --measured-only.
  const judged = judgedPlanProblem(steps, { ...o, goal });
  if (judged) return judged;
  const asked = refusedName(goal);
  if (asked && !steps.some((s) => refusedName(`${s.title} ${s.intent}`))) {
    return `the goal asks for something that may be refused (${asked.replace(/^.*? wasn't pressed: /, "")}): keep that step, as the goal says it; the browser stops it safely and reports it`;
  }
  return undefined;
}

/** E4: the checks measured after every action, so a step that already passed needs no "done" asked of the AI. */
export const EARLY_CHECKS: ReadonlySet<Check["kind"]> = new Set(["text_visible", "url_contains", "element_visible", "title_contains"]);

/**
 * E4: the next queued action, when it may be done without asking: nothing came up since (`hold`), the
 * page is still the one it was asked on (only a "done" outlives going elsewhere: the browser measures
 * it), and its element is in this look. Otherwise nothing, and the queue is dropped.
 */
export function queuedNext(queue: readonly Action[], askedAt: string, snap: Pick<Snapshot, "refs" | "url">, hold: boolean, asked: { refs?: Snapshot["refs"]; measured?: boolean } = {}): Action | undefined {
  const first = queue[0];
  if (!first || hold) return undefined;
  // A "done" given before the AI saw what the actions did is only taken when the browser measures it.
  if (first.type === "done" && asked.measured === false) return undefined;
  if (snap.url !== askedAt && first.type !== "done") return undefined;
  if (first.type === "stuck") return undefined;
  // W5: a point press is never done from the queue: its point is in a picture of the screen before the
  // actions ahead of it changed it.
  if (first.type === "click_at") return undefined;
  const asRef = "ref" in first ? first.ref : undefined;
  // W5: its element drawn again since (a form redrawn on the last key): the one with the same role and
  // name in this look, when it was the only one then and is the only one now.
  const redrawnRef = asRef && !snap.refs.has(asRef) ? sameIn(asked.refs?.get(asRef), snap.refs) : undefined;
  const next = redrawnRef ? ({ ...first, ref: redrawnRef } as Action) : first;
  if (actionProblem(next, snap)) return undefined;
  // The same number on a page that reloaded at the same address may be another element: its role and name must be the same.
  const was = asRef ? asked.refs?.get(asRef) : undefined;
  const now = "ref" in next && next.ref ? snap.refs.get(next.ref) : undefined;
  if (was && now && (was.role !== now.role || was.name !== now.name)) return undefined;
  return next;
}

/** W5: the number now of an element named in an earlier look, by its role and name, when it was and is the only one with them, with the same around it. */
export function sameIn(was: SnapTarget | undefined, refs: Snapshot["refs"]): string | undefined {
  if (!was || was.same !== 1 || !was.name.trim() || was.frame || !was.around) return undefined;
  const now = [...refs.values()].filter((t) => t.role === was.role && t.name === was.name && !t.frame);
  // The same around it too: "Approve" drawn in another record's row is another button.
  return now.length === 1 && now[0]!.same === 1 && now[0]!.around === was.around ? now[0]!.ref : undefined;
}

/** Why an action the AI gave can't be used on this snapshot, or nothing. */
export function actionProblem(action: unknown, snap: Pick<Snapshot, "refs">): string | undefined {
  const a = action as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || !(ACTION_TYPES as readonly string[]).includes(String(a.type))) return `the action must be one of ${ACTION_TYPES.join(", ")}`;
  const pointer = (POINTER_VERBS as readonly string[]).includes(String(a.type));
  if (pointer || a.type === "fill" || a.type === "select" || (a.type === "scroll" && typeof a.ref === "string" && a.ref)) {
    if (typeof a.ref !== "string" || !snap.refs.has(a.ref)) return `"${String(a.ref ?? "")}" isn't an element on the page now: use a number from the latest snapshot, like e12`;
    if (a.type === "scroll") return undefined;
    if (!pointer && (typeof a.value !== "string" || !a.value)) return `${a.type} needs a value`;
    if (!pointer && snap.refs.get(a.ref)?.role === "item") return `${a.ref} is an item, a row of words: an item can only be clicked or hovered over`;
  }
  if (a.type === "type" && (typeof a.value !== "string" || !a.value)) return "type needs a value: the words to type into what has focus";
  if (a.type === "press" && (typeof a.key !== "string" || !a.key)) return "press needs a key";
  if (a.type === "navigate" && (typeof a.url !== "string" || !a.url)) return "navigate needs a url";
  if (a.type === "scroll_to" && (typeof a.text !== "string" || !a.text.trim())) return "scroll_to needs text: words the page shows";
  if (a.type === "scroll_to" && typeof a.ref === "string" && a.ref && !snap.refs.has(a.ref)) return `"${a.ref}" isn't an element on the page now: give scroll_to the number of an element in the list to scroll, or no ref for the page`;
  // W4: the widget verbs.
  if ((WIDGET_VERBS as readonly string[]).includes(String(a.type))) {
    const byText = a.type === "drag" && !a.ref && typeof a.text === "string" && a.text.trim();
    if (!byText && (typeof a.ref !== "string" || !snap.refs.has(a.ref))) return `"${String(a.ref ?? "")}" isn't an element on the page now: use a number from the latest snapshot, like e12${a.type === "drag" ? ", or no ref and its words in text" : ""}`;
    if (a.type === "drag" && (typeof a.to !== "string" || !a.to.trim() || (/^e\d+$/.test(a.to.trim()) && !snap.refs.has(a.to.trim())))) return `drag needs "to": the number of the element to drop it on, or the words of where it goes (a column's name)`;
    if ((a.type === "slide" || a.type === "drag_at" || a.type === "upload") && (typeof a.value !== "string" || !a.value.trim())) return a.type === "slide" ? "slide needs a value: the number to set it to" : a.type === "drag_at" ? "drag_at needs a value: \"x,y\", the pixels to drag it by" : "upload needs a value: csv, json, png, pdf or txt (a built-in test file), auto, or a file path the goal gives";
  }
  if (a.type === "switch_tab" && (typeof a.value !== "string" || !/^\s*\d{1,2}\s*$/.test(a.value))) return "switch_tab needs a value: the tab's number, like 1";
  if (a.type === "click_at" && (typeof a.x !== "number" || typeof a.y !== "number" || !Number.isFinite(a.x) || !Number.isFinite(a.y))) return "click_at needs x and y: a point in the picture";
  if (a.type === "click_at" && (typeof a.what !== "string" || !a.what.trim())) return "click_at needs what: the words drawn at that point (or what the picture shows there), as you see them";
  return undefined;
}

/** W5: a page that asks to prove a person is there (in its own words): no point press, no picture to get past it. */
export const HUMAN_CHECK_WORDS = /\b(re)?captcha\b|\bh-?captcha\b|\bturnstile\b|i'?m not a robot|are you (a )?(human|robot)|verify (that )?you('| a)re (a )?human|prove you('| a)re (a )?human|human (check|verification)|bot (check|protection)|security check|slide to (verify|complete|unlock)|drag the (slider|puzzle|piece)|select all (images|squares|pictures)|complete the puzzle/i;
/** W5: what the AI is told when it presses at a point on a page with a human check. */
export const NO_POINT_HUMAN_CHECK = "click_at isn't used on a page with a human check (a captcha, a puzzle, a slider): the browser never answers one; use a number from the snapshot, or say stuck";

/** W5: a point press is only for a step that had a picture (the point is in it). */
export const NO_PICTURE_POINT = "click_at is only for a point in a picture of the screen, and none came in this step: use a number from the snapshot";

/** W5 (decision J): the words before a quote that make it something to press or find ("click", "the … button" after it is read too). */
const TO_FIND = /\b(click|clicks|clicking|press|pressing|tap|pick|picks|choose|chooses|open|opens|select|selects|find|go to|hit|tick|toggle|switch to|expand)\s+(?:on\s+|the\s+|a\s+|an\s+)?(?:\w+\s+){0,2}$/i;
/** The words before a quote that make it a value to type or a name to give, never something on the page yet. */
const A_VALUE = /\b(type|types|typing|enter|enters|fill|fills|write|writes|input|named|called|name|title|titled|set|search|search for|value|reads?|says?|shows?)\s+(?:in\s+|the\s+|a\s+|an\s+|it\s+)?(?:\w+\s+){0,1}$/i;
/** After the quote: what it is on the page ("Save" button, "Back" tile). */
const A_THING = /^\s*(button|link|tab|tile|option|menu|menu item|icon|item|card|row|entry|choice|area|region|square|pin|marker)\b/i;

/**
 * W5 (decision J): the quoted words the step names as something to press or find ('Click "Save"',
 * 'pick "Back" on the map', 'the "Export" button'), each 2 to 60 characters. A quoted value to type or a
 * name to give ('Type "Leg day 7" into the Name box') is left out: it isn't on the page until typed.
 */
function quotedIn(about: string): string[] {
  const out: string[] = [];
  for (const m of about.matchAll(/"([^"]{2,60})"|“([^”]{2,60})”|'([^']{2,60})'/g)) {
    const before = about.slice(Math.max(0, m.index! - 40), m.index!);
    const after = about.slice(m.index! + m[0].length, m.index! + m[0].length + 20);
    if (A_THING.test(after)) {
      out.push((m[1] ?? m[2] ?? m[3])!.trim());
      continue;
    }
    // The nearer of the two kinds of word before it says what it is; neither, and it is left out.
    const find = TO_FIND.exec(before)?.index ?? -1;
    const value = A_VALUE.exec(before)?.index ?? -1;
    if (find < 0 || value > find) continue;
    out.push((m[1] ?? m[2] ?? m[3])!.trim());
  }
  return out.filter(Boolean);
}

/**
 * W5 (decision J): the outline contradicts what the step is about: it names things in quotes, the whole
 * outline was shown (nothing cut for room), and none of them is anywhere in it. A picture may show what
 * the outline can't (a button drawn on a canvas, words in an image). Measured, no AI.
 */
export function outlineContradicts(snap: Pick<Snapshot, "text" | "hidden" | "usable">, about: string): boolean {
  if (!snap.usable.size || snap.hidden > 0) return false;
  const named = quotedIn(about);
  if (!named.length) return false;
  const text = norm(snap.text);
  return named.every((n) => !text.includes(norm(n)));
}

/**
 * An address typed to make the step's own address check hold, when neither the goal nor the step
 * names that address: the step is done on the page, as a person would, not by going to its check.
 */
export function checkGaming(action: Action, step: Pick<PlannedStep, "title" | "intent" | "check">, goal: string): string | undefined {
  if (action.type !== "navigate" || step.check.kind !== "url_contains") return undefined;
  const t = norm(step.check.text);
  if (!t || !norm(action.url).includes(t) || norm(`${goal} ${step.title} ${step.intent}`).includes(t)) return undefined;
  return `navigate goes straight to an address holding the check's words ("${clip(step.check.text, 60)}"), which proves nothing: do the step on the page (click, type, choose), or say stuck if it leads elsewhere`;
}

const absolute = (url: string, base: string) => {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
};

/** A check with its {name}s filled in from --var (or an account), so a check can be about a value nobody sees. */
function withVars(check: Check, vars: Record<string, string> | ((name: string) => string | undefined)): Check {
  const get = typeof vars === "function" ? vars : (n: string) => vars[n];
  const fill = (t: string) => fillPlaceholders(t, get);
  if (check.kind === "signed_in") return { ...check, ...(check.text ? { text: fill(check.text) } : {}), ...(check.url ? { url: fill(check.url) } : {}) };
  return !("text" in check) && !("name" in check) ? check : check.kind === "element_visible" ? { ...check, name: fill(check.name) } : { ...check, text: fill(check.text) };
}

/** Text cut to about `n` characters at a word, never mid-word. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${(at > n / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

const message = (error: unknown) => clip((error instanceof Error ? error.message : String(error)).split("\n")[0]!, 300);

/** Why the start page didn't open, in plain words: "nothing is answering at localhost:4599: is the app running?". */
export function openError(host: string, error: unknown): string {
  const said = message(error);
  if (/ERR_CONNECTION_REFUSED/.test(said)) return `nothing is answering at ${host}: is the app running?`;
  if (/ERR_NAME_NOT_RESOLVED/.test(said)) return `${host} wasn't found: check the address`;
  if (/ERR_BLOCKED_BY_CLIENT/.test(said)) return `${host} sends you to another site (add --allow-host for it)`;
  if (/ERR_CERT|ERR_SSL/.test(said)) return `${host}'s certificate isn't valid`;
  if (/Timeout|ERR_TIMED_OUT/i.test(said)) return `${host} didn't answer in time`;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(said)) return "there's no network connection";
  return `${host} couldn't be opened: ${said.replace(/^page\.goto: /, "")}`;
}

async function open(page: Page, url: string, visitor = false): Promise<Response | null> {
  let res: Response | null;
  try {
    res = await page.goto(url, { timeout: visitor ? 45_000 : 30_000, waitUntil: "domcontentloaded" });
    // A bot check often answers 503 (or 403): that is the check, said as such by whoever opened it, not a site that's down.
    if (res && res.status() >= 500 && !(await botWall(page))) throw new Error(`it answered ${res.status()}`);
  } catch (error) {
    throw new CouldNotRun(openError(new URL(url).host, error));
  }
  // A big public site goes on drawing after its first answer (ads, players): a little more, never long.
  if (visitor) await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
  return res;
}

/**
 * C15/C19: the start page's host asked for a login the run doesn't have (basic auth, Vercel's
 * protection) instead of showing the site: what, as a code, or nothing. Measured from its first answer.
 */
async function refusedAccess(page: Page, res: Response | null, owner?: OwnerAccess): Promise<AccessRefusal | undefined> {
  if (!res) return undefined;
  const status = res.status();
  if (status !== 401 && status !== 403 && !/vercel\.com$/i.test(new URL(page.url()).hostname)) return undefined;
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  return accessRefusal({ status, headers: await res.allHeaders().catch(() => res.headers()), url: page.url(), title, text }, owner);
}

/**
 * The start page opened as a visitor sees it: a consent wall answered "no" first (on the page, or on
 * a consent host it sent the browser to, allowed only while this runs). What was pressed, if anything.
 * A bot check in front of it is waited on first (`wall`), never answered: while one stands, nothing
 * on the page is pressed, a consent control included, and the caller says the site didn't let it in.
 */
export async function openAsVisitor(page: Page, url: string, consent: { open: boolean }, wall?: WallWatch): Promise<string | undefined> {
  consent.open = true;
  try {
    await open(page, url, true);
    if (wall && (await wall.stands(page))) return undefined;
    const said = await rejectConsent(page);
    if (onConsentHost(page.url())) throw new CouldNotRun(`${new URL(url).host} showed a consent page that couldn't be answered "no"`);
    return said;
  } finally {
    consent.open = false;
  }
}

/** A title or heading that says the page isn't there (C8). */
export const NOT_FOUND = /\b(not found|page not found|404|can['’]t (open|find)|cannot (open|find)|doesn['’]t exist|does not exist|no longer available)\b/i;

/**
 * Whether the page now says it isn't there, as a visitor would read it: it answered 404 or 410, or
 * its title or first heading says so. What it says (the title or heading), or nothing.
 */
export async function notFound(page: Page, o: { status?: boolean } = {}): Promise<string | undefined> {
  const read = await page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
      const h1 = (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim();
      return { status: nav?.responseStatus ?? 0, title: document.title.replace(/\s+/g, " ").trim(), h1 };
    })
    .catch(() => undefined);
  if (!read) return undefined;
  if (NOT_FOUND.test(read.title)) return read.title;
  if (NOT_FOUND.test(read.h1)) return read.h1;
  if (o.status !== false && (read.status === 404 || read.status === 410)) return read.title || read.h1 || `it answered ${read.status}`;
  return undefined;
}

/** An address as a person says it: host and path, no query. */
export function shortAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const lowerFirst = (s: string) => s.replace(/^./, (x) => x.toLowerCase());
const snapText = (snap: Snapshot) => `${snap.dialog ? `(A dialog is open: "${snap.dialog}")\n` : ""}${snap.text}`;
const hashOf = (path: string) => {
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
};

type End = Pick<StepResult, "verdict" | "reason" | "evidence" | "weak" | "judged" | "blockedGroup">;

/** The actor says it's stuck for want of a value: the runner may fill the required fields left empty. */
const MISSING_VALUES = /\b(values?|required|missing|empty|not (given|provided|specified|known|stated)|isn'?t (given|provided|specified|known)|don'?t (know|have)|unknown|no (data|details|information)|fill|fields?)\b/i;

/** Roles of a field that can take a made-up value. */
const FILLABLE = new Set(["textbox", "searchbox", "combobox", "listbox", "spinbutton"]);

/**
 * The required fields on the page still empty, each filled with a plainly made-up test value through
 * act() (so every safety rule holds); and the --var names of those it won't make up (a password).
 */
async function fillRequired(ctx: ActContext, snap: Snapshot, rules: MadeUpRules): Promise<{ outcomes: Outcome[]; needs: string[] }> {
  const outcomes: Outcome[] = [];
  const needs: string[] = [];
  for (const target of [...snap.refs.values()].filter((t) => FILLABLE.has(t.role)).slice(0, 12)) {
    const live = await locateLive(ctx.page, target.ref);
    if (!("el" in live)) continue;
    const el = live.el;
    const facts = await el.evaluate(fieldFacts, undefined, { timeout: 2000 }).catch(() => undefined);
    if (!facts || !requiredEmpty(facts)) continue;
    const made = refusedMadeUp(facts, rules) ?? madeUpValue(facts);
    if ("cannot" in made) {
      // A field a --var was given for is the actor's to fill with it: nothing to ask for.
      if (!("given" in made)) needs.push(made.varName);
      continue;
    }
    outcomes.push(await act(ctx, facts.tag === "select" ? { type: "select", ref: target.ref, value: "auto" } : { type: "fill", ref: target.ref, value: "auto" }, target));
  }
  return { outcomes, needs };
}

/** Clicks and keys that may send a form: an attempt ends with one. */
const sends = (a: CachedAction) => a.type === "click" || a.type === "dblclick" || (a.type === "press" && (a.key === "Enter" || a.key === "Space"));
const targetKey = (a: CachedAction) => ("target" in a && a.target ? `${a.type === "click" || a.type === "hover" ? a.type : "field"}\n${a.target.role}\n${a.target.name}\n${a.target.nth}` : "");

/**
 * A step's actions without the tries that failed: a field filled again after a send the browser saw
 * fail (a sign-in form shown again, a form the page sent back with an error, one it wouldn't send)
 * means that try didn't work, so the fields filled for it and the send itself are dropped. A replay
 * does only the try that worked. A send that worked (a search, then another) is kept.
 */
export function withoutFailedTries(actions: readonly CachedAction[], failed: (send: CachedAction) => boolean): CachedAction[] {
  let out = [...actions];
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    if (a.type !== "fill" && a.type !== "select") continue;
    const key = targetKey(a);
    let before = i - 1;
    while (before >= 0 && targetKey(out[before]!) !== key) before--;
    if (before < 0) continue;
    let send = i - 1;
    while (send > before && !sends(out[send]!)) send--;
    if (send <= before || !failed(out[send]!)) continue;
    // The failed try: from the first of the fields filled together before it, to its send.
    let from = before;
    while (from > 0 && (out[from - 1]!.type === "fill" || out[from - 1]!.type === "select")) from--;
    out = [...out.slice(0, from), ...out.slice(send + 1)];
    i = from - 1;
  }
  return out;
}

/** A step's title and intent with a renamed element's name changed, when a heal swapped exactly one name for one other. */
export function renamed(words: string, from: readonly CachedAction[], to: readonly CachedAction[]): string {
  const names = (as: readonly CachedAction[]) => [...new Set(as.flatMap((a) => ("target" in a && a.target?.name ? [a.target.name] : [])))];
  const gone = names(from).filter((n) => !names(to).includes(n));
  const added = names(to).filter((n) => !names(from).includes(n));
  if (gone.length !== 1 || added.length !== 1) return words;
  return words.split(gone[0]!).join(added[0]!);
}

/**
 * Whether an address check's words are only what the test typed: "search_query=zzqxvbn" after typing
 * "zzqxvbn test query" holds because a search box puts what was typed in the address, whatever the
 * site then shows. Each value in the check (after "=", with + and %20 as spaces) is compared.
 */
export function typedInUrl(check: string, typed: string): boolean {
  const said = norm(typed);
  if (said.length < 2) return false;
  const values = check.split(/[?&#]/).map((part) => {
    const value = part.includes("=") ? part.slice(part.indexOf("=") + 1) : part;
    try {
      return norm(decodeURIComponent(value.replace(/\+/g, " ")));
    } catch {
      return norm(value.replace(/\+/g, " "));
    }
  });
  return values.some((v) => v.length >= 2 && (said.includes(v) || v.includes(said)));
}

/** One action the actor took, for the loop guards: what it was, the page it was done on, and what came of it. */
export interface Turn {
  /** The action, as asked ("click e12"). */
  key: string;
  type: string;
  /** How a person says it: "Clicking on 'Search' button". */
  label: string;
  /** The page's fingerprint before it (Snapshot.keys), and what was on screen. */
  keys: string;
  screen: string;
  /** "ok" until the next look; then "no change" when that look is the same page, or the error's kind. */
  result: "ok" | "changed" | "no change" | ErrorKind;
}

/** The loop guards' room: the last actions looked at. */
export const RING = 8;

/**
 * Whether the actor is going round in circles (C6, teardown 4), and how to say so: the same action
 * on the same page a third time (a scroll counts only while what is on screen is the same, and 7
 * scrolls in a row is a loop however the page moves); a cycle of 2 to 4 actions done twice over from
 * the same page; or 3 in a row that changed nothing, or failed covered or gone. It only ever warns
 * the actor or ends the step, whose check is still measured: a guard never passes anything.
 */
export function loopGuard(ring: readonly Turn[]): { guard: "repeat" | "cycle" | "stalled" | "scrolling"; says: string; ends: string } | undefined {
  const last = ring.at(-1);
  if (!last) return undefined;
  for (let n = 2; n <= 4; n++) {
    if (ring.length < 2 * n) continue;
    const a = ring.slice(-2 * n, -n);
    const b = ring.slice(-n);
    if (new Set(b.map((t) => t.key)).size < 2) continue;
    if (a.every((t, i) => t.key === b[i]!.key && t.keys === b[i]!.keys)) {
      return { guard: "cycle", says: `You're going round in a cycle of ${n} actions (${b.map((t) => lowerFirst(t.label)).join(", then ")}) and the page comes back the same. Try something else, or say stuck. Going round again ends the step.`, ends: `the loop guard stopped it: a cycle of ${n} actions repeated on the same page` };
    }
  }
  const same = ring.filter((t) => t.key === last.key && t.keys === last.keys && (t.type !== "scroll" || t.screen === last.screen));
  if (same.length >= 3) {
    return { guard: "repeat", says: `You've done the same thing (${lowerFirst(last.label)}) ${same.length} times on a page that didn't change. Something may be open over it (see "open now"): use that, press Escape, or try another way. Doing it again ends the step.`, ends: `the loop guard stopped it: the same action (${lowerFirst(last.label)}) ${same.length} times on an unchanged page` };
  }
  const tail = ring.slice(-7);
  if (tail.length === 7 && tail.every((t) => t.type === "scroll")) {
    return { guard: "scrolling", says: "You've scrolled 7 times in a row. If what you need isn't showing, it may not be on this page: try another way, or say stuck.", ends: "the loop guard stopped it: 7 scrolls in a row found nothing" };
  }
  const run = ring.slice(-3);
  if (run.length === 3 && run.every((t) => t.result === "no change" || t.result === "covered" || t.result === "stale")) {
    return { guard: "stalled", says: "Your last 3 actions changed nothing on the page, or couldn't be done (covered, or gone). Look at what is open now and use it, press Escape, or say stuck. Another like them ends the step.", ends: "the loop guard stopped it: 3 actions in a row changed nothing or couldn't be done" };
  }
  return undefined;
}

/** Checks measured on the start page for C11: the ones about what the page shows (a video's, a sign-in's and none are left). */
const SHOWN_CHECKS = new Set(["text_visible", "url_contains", "element_visible", "title_contains"]);

/** Which planned steps (0-based) have a check that already holds on this page, before anything is done. */
export async function heldAtStart(page: Page, steps: readonly PlannedStep[], vars: Record<string, string> = {}): Promise<number[]> {
  const held: number[] = [];
  for (const [i, s] of steps.entries()) if (SHOWN_CHECKS.has(s.check.kind) && (await verify(page, withVars(s.check, vars), 0).catch(() => ({ ok: false }))).ok) held.push(i);
  return held;
}

/** A plan in a line, for the planner asked again. */
const lastPlan = (steps: readonly PlannedStep[]) => steps.map((s, i) => `${i + 1}. ${clip(s.title, 60)} (check: ${expected(s.check)})`).join("; ");

/** What the planner is told when its plan is sent back because checks already held on the start page (C11). */
export function heldProblem(steps: readonly PlannedStep[], held: readonly number[]): string {
  const which = held.map((i) => `step ${i + 1}'s check (${expected(steps[i]!.check)})`);
  const said = which.length === 1 ? which[0]! : `${which.slice(0, -1).join(", ")} and ${which.at(-1)}`;
  const last = lastPlan(steps);
  return `${said} already ${held.length === 1 ? "holds" : "hold"} on the start page before anything is done, so ${held.length === 1 ? "it proves" : "they prove"} nothing. Plan again, with a check for ${held.length === 1 ? "that step" : "those steps"} that only holds once the step is done: something that only appears after it, or the address or title it leads to. Your last plan was: ${last}`;
}

/**
 * A plan whose steps with no check (that aren't the last) are each joined onto the step after them:
 * one step that does both, with that step's check. Nothing when there is none to join, or when the step
 * after has no check either (it would leave a doing step unmeasured).
 */
export function joinUnchecked(steps: readonly PlannedStep[]): PlannedStep[] | undefined {
  const out: PlannedStep[] = [];
  let joined = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const next = steps[i + 1];
    if (s.check.kind === "none" && next && next.check.kind !== "none" && DOES.test(withoutChoices(withoutControlNames(`${s.title} ${s.intent}`)))) {
      out.push({ ...next, title: `${s.title}, then ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}`, intent: `${s.intent.trim().replace(/[.;,]?$/, ".")} Then: ${next.intent.trim()}` });
      i++;
      joined = true;
    } else out.push(s);
  }
  return joined ? out : undefined;
}

/**
 * One plan, checked before anything runs. A plan the rules refuse (planProblem: a judged check where the
 * goal names what to measure, too many steps...) is sent back once with the reason, and only a second
 * refusal ends the run. A step's check that already holds on the start page proves nothing (C11), and
 * checks the start page shows to be guesses: the plan is sent back once for those too, measured on the
 * page the planner saw. That ask only ever replaces the plan: a second one that is unusable, or no
 * answer, leaves the first, whose step is then flagged weak. At most 3 plan asks in all.
 * `heldAgain: false` (the app's Generate): only a refused plan is sent back.
 */
export async function planChecked(ask: (problem?: string) => Promise<PlannedStep[]>, page: Page, o: { goal: string; given?: readonly string[]; measuredOnly?: boolean; vars: Record<string, string>; known: KnownAtStart; mask: (s: string) => string; onAgain?: (words: string) => void; heldAgain?: false }): Promise<PlannedStep[]> {
  const rules = { ...(o.measuredOnly ? { measuredOnly: true } : {}), ...(o.given ? { given: o.given } : {}) };
  const asked = async (problem?: string) => {
    try {
      return await ask(problem);
    } catch (error) {
      throw new CouldNotRun(`the AI couldn't plan the test: ${o.mask(message(error))}`);
    }
  };
  let steps = await asked();
  const problem = planProblem(steps, o.goal, rules);
  if (problem) {
    o.onAgain?.("Planning again: the plan broke a rule");
    steps = await asked(o.mask(`Your plan can't be used: ${problem}. Plan again, keeping to that rule. Your last plan was: ${lastPlan(steps)}`));
    let still = planProblem(steps, o.goal, rules);
    // A step with no check that reads as doing something, before a step that has one: it is joined onto
    // that step (both done, the next step's check kept), never left without a check of its own.
    const joined = still ? joinUnchecked(steps) : undefined;
    if (still && joined && !planProblem(joined, o.goal, rules)) {
      o.onAgain?.("Planning again: a step with no check was joined onto the next one");
      steps = joined;
      still = undefined;
    }
    if (still) throw new CouldNotRun(`the AI's plan wasn't usable: ${o.mask(still)}`);
  }
  // The app's planner (heldAgain: false) shows those on the cards instead (lintPlan), with no second ask.
  if (o.heldAgain === false) return steps;
  const held = await heldAtStart(page, steps, o.vars);
  const guesses = checkGuesses(steps, o.goal, o.known);
  if (held.length || guesses.length) {
    o.onAgain?.(held.length ? "Planning again: a check already held on the start page" : "Planning again: a check was a guess");
    const said = [held.length ? heldProblem(steps, held) : "", guesses.length ? `${guesses.join(". ")}.${held.length ? "" : ` Your last plan was: ${lastPlan(steps)}`}` : ""].filter(Boolean).join(" Also: ");
    const again = await ask(o.mask(said)).catch(() => undefined);
    if (again && !planProblem(again, o.goal, rules)) steps = again;
  }
  return steps;
}

/** What the planner could know on the start page: every word in it (hidden ones too) and every address it links to. */
export interface KnownAtStart {
  text: string;
  addresses: string;
  /** The first part of the addresses the page's own links go to, most common first ("/symbols/"), for the planner. */
  paths: string[];
}

/** Read on the start page for checkGuesses: its words (with what its snapshot names) and its link addresses. */
export async function knownAtStart(page: Page, snapshot: string): Promise<KnownAtStart> {
  const k = await page
    .evaluate(() => ({ text: (document.body?.textContent ?? "").slice(0, 400_000), hrefs: [...document.querySelectorAll("a[href]")].slice(0, 5000).map((a) => a.getAttribute("href") ?? "").join(" ") }))
    .catch(() => ({ text: "", hrefs: "" }));
  const counts = new Map<string, number>();
  const here = page.url();
  for (const href of k.hrefs.split(" ")) {
    try {
      const u = new URL(href, here);
      if (u.origin !== new URL(here).origin) continue;
      const first = u.pathname.split("/").filter(Boolean)[0];
      if (!first || first.length > 40) continue;
      const part = `/${first}${u.pathname.length > first.length + 1 ? "/" : ""}`;
      counts.set(part, (counts.get(part) ?? 0) + 1);
    } catch {
      // not an address
    }
  }
  const paths = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([p]) => p);
  return { text: norm(`${k.text} ${snapshot} ${await page.title().catch(() => "")}`), addresses: norm(`${here} ${k.hrefs}`), paths };
}

const wordsIn = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
/** A word without its plain endings ("manually" → "manual", "trades" → "trade"). */
const stem = (w: string) => w.replace(/(ally|ly|ies|es|s|ed|ing)$/, "") || w;
/** Words that say a save happened: a check made of them is the outcome, not the form. */
const OUTCOME_WORDS = /\b(saved|added|created|submitted|sent|posted|published|success|successful(ly)?|thank(s| you)|confirmed|done|recorded|updated|complete(d)?)\b/i;

/** The phrases a step's intent says it types: quoted after "type", "enter", "fill" or "search for", or the word right after. */
export function typedBy(intent: string): string[] {
  const out: string[] = [];
  const verb = /\b(?:type|types|typing|enter|enters|fill(?:s)?(?: in)?|search(?:es)? for|look(?:s)? up)\s+(?:in\s+)?(?:"([^"]+)"|“([^”]+)”|'([^']+)'|([^"“”',.;:]+))/gi;
  for (const m of intent.matchAll(verb)) {
    // Unquoted: the first word, and the capitalised ones after it ("Alan Turing into the box").
    const bare = m[4]?.trim().split(/\s+/) ?? [];
    const upTo = bare.findIndex((w, k) => k > 0 && !/^[A-Z0-9]/.test(w));
    const said = (m[1] ?? m[2] ?? m[3] ?? bare.slice(0, upTo < 0 ? bare.length : upTo).join(" ")).trim();
    if (said && !/^(the|a|an|it|its|into|in|your|their|this|that)$/i.test(said)) out.push(said);
  }
  return out;
}

/**
 * What is wrong with a plan's checks that the start page can tell, measured with no AI: a check on
 * the words its own step types (a search box and its address show them whatever the site does), an
 * address part the planner can't have seen (not in the goal, the start address or any link on the
 * page), or words that are the goal's in a form the site may never write ("downloaded" for "Download").
 * It only ever sends a plan back once, like a check that already holds (C11): no check is relaxed.
 */
export function checkGuesses(steps: readonly PlannedStep[], goal: string, known: KnownAtStart): string[] {
  const out: string[] = [];
  const g = norm(goal);
  const goalWords = wordsIn(goal).filter((w) => w.length >= 4);
  for (const [i, s] of steps.entries()) {
    const c = s.check;
    if (c.kind === "signed_in" || (!("text" in c) && c.kind !== "element_visible")) continue;
    const text = "text" in c ? c.text : c.name;
    const t = norm(text);
    if (!t) continue;
    const said = `step ${i + 1}'s check (${expected(c)})`;
    // A step that saves, checked by a word of its own (the option it picks, the form, the button): the
    // form shows that before anything is saved ("Manual" on a wizard that says "Manually…").
    if (checksOwnWords(s)) {
      out.push(`${said} is the step's own words (the option it picks, the form or the button): the form shows them before anything is saved, so it proves nothing. Check what shows once it is saved: a success message, the new entry in its list, or its own page${c.kind === "text_visible" ? "; or a judged check about that" : ""}`);
      continue;
    }
    const typed = typedBy(s.intent);
    // The last step's check must prove the goal: when the goal's only word for the result is what
    // is typed, it stays (and the run flags it as proving little) rather than become a guess.
    if (i < steps.length - 1 && typed.some((v) => norm(v).includes(t) || (c.kind === "url_contains" && typedInUrl(text, v)))) {
      out.push(`${said} is the words the step types itself: a search box, and often the address and title, show them whatever the site does. A search on the way to a result may have check none, with the next step checking what the result shows`);
      continue;
    }
    if (c.kind === "url_contains") {
      const fromGoal = g.includes(t) || wordsIn(text).every((w) => g.includes(w));
      if (!fromGoal && !known.addresses.includes(t)) out.push(`${said} is an address part that isn't in the goal, the start address or any link on the page: a guess about a page you haven't seen. Use a word of the goal, or an address part a link in the snapshot shows`);
      continue;
    }
    if (g.includes(t) || known.text.includes(t)) continue;
    const variant = wordsIn(text).find((w) => !g.includes(w) && !known.text.includes(w) && goalWords.some((gw) => gw !== w && (w.startsWith(gw.slice(0, Math.max(4, gw.length - 2))) || gw.startsWith(w.slice(0, Math.max(4, w.length - 2))))));
    if (variant) out.push(`${said} writes the goal's word in a form ("${variant}") that isn't on the page or in the goal: the site may write it differently. Use the goal's own words, words on the page, or the address or title`);
  }
  // The goal asks to add or save something and no step fills it in and saves it (the planner dropped
  // the save: "Open add trade" alone, checked by the page it opens). Sent back once; if it stays, the
  // run can't pass on its checks alone (the goal judge must confirm it).
  if (planDropsSave(steps, goal)) out.push(`the goal asks for something to be added or saved, and no step fills it in and saves it: plan that as one step (made-up test values where the goal gives none, then its save or add button pressed), checked by what shows once it is saved`);
  return out;
}

/**
 * A step that saves, checked by words of its own (the option it picks, the form, the button): the form
 * shows them before anything is saved ("Manual" on a wizard that says "Manually…"). checkGuesses sends
 * such a plan back; a saved test with one was recorded under older rules (staleSteps).
 */
export function checksOwnWords(s: PlannedStep): boolean {
  const c = s.check;
  if (!needsOf(s).submit || (c.kind !== "text_visible" && c.kind !== "element_visible")) return false;
  const text = c.kind === "text_visible" ? c.text : c.name;
  if (!norm(text) || OUTCOME_WORDS.test(text)) return false;
  const own = new Set(wordsIn(`${s.title} ${s.intent}`).map(stem));
  const words = wordsIn(text).filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => own.has(stem(w)));
}

/** A {name} anywhere in these words: the test types a --var value. */
const usesVar = usesPlaceholder;

/** A stored value's name that is who the account is, not a secret: shown by a signed-in page's own words. */
const IDENTITY_NAME = /(^|\.)(username|user|email|login|name|phone)$/i;

/** How long a signed-in run's video shows its "Signed in as …" card before the site opens. */
export const SIGNED_IN_CARD_MS = 1200;

/**
 * An action that types (or opens) a stored value: a {name} in what it types or the address it opens,
 * or any value the masker hides typed as itself. The cover's card is up while it is done.
 */
export function typesStored(action: { type: string; value?: string; url?: string }, known: readonly (readonly [string, string])[] = []): boolean {
  const said = action.type === "fill" || action.type === "type" ? (action.value ?? "") : action.type === "navigate" ? (action.url ?? "") : "";
  if (!said) return false;
  return usesVar(said) || known.some(([, v]) => v.length >= 3 && said.includes(v));
}

/**
 * An action that types more than a username or an email: a password, a code, a key or a --var (by its
 * {name}, or typed as itself). While it is typed, any change in the page's own words puts the card up.
 */
export function typesSecret(action: { type: string; value?: string; url?: string }, known: readonly (readonly [string, string])[] = []): boolean {
  const said = action.type === "fill" || action.type === "type" ? (action.value ?? "") : action.type === "navigate" ? (action.url ?? "") : "";
  if (!said) return false;
  if (placeholderNames(said).some((n) => !IDENTITY_NAME.test(n))) return true;
  return known.some(([name, v]) => v.length >= 3 && !IDENTITY_NAME.test(name) && said.includes(v));
}

/** The sign-in's own video, in a signed-in run's folder. */
export const SIGN_IN_VIDEO_FILE = "sign-in.webm";

/** What the result says about a video with stored values in it: boxes as dots, where the sign-in is, what a card stands in for. */
export function videoNote(n: { signedIn?: boolean; signInVideo?: boolean; masked?: number; carded?: number }): string {
  const parts: string[] = [];
  if (n.signedIn) parts.push(n.signInVideo ? `${SIGN_IN_OWN_VIDEO} (${SIGN_IN_VIDEO_FILE}); this one opens on a card saying who it's signed in as.` : `${SIGN_IN_SAVED}, so there is no sign-in to show: the video opens on a card saying who it's signed in as.`);
  if (n.masked) parts.push(VIDEO_DOTS);
  if (n.carded) parts.push(`A card stands in for ${n.carded === 1 ? "the stored value" : `${n.carded} stored values`} typed where the box couldn't be masked first.`);
  parts.push(VIDEO_CARD, VIDEO_STILL_SHOWS);
  return parts.join(" ");
}

export async function runTest(o: RunOptions): Promise<RunOutcome> {
  // A visitor's saved test replays as a visitor.
  if (o.saved?.visitor && !o.visitor) o = { ...o, visitor: true };
  // A saved test recorded under older rules whose steps can't do what they say (or whose save is checked
  // by its own words) isn't replayed into a NOT SURE: with an AI it is planned again from its goal, once,
  // under today's rules (every check of a fresh plan, the account as before). Not on another address
  // (--url in a suite: nothing there is healed or saved), and never over steps the person wrote (their
  // Assert steps and own checks: a plan from the goal knows nothing of them, so it would drop them).
  // The person's notes, as the saved test's identity keeps them: a digest of their masked words (notes.ts).
  const notesId = notesDigest(o.siteNotes ? (o.masker ?? masker(o.vars ?? {}))(tidyNotes(o.siteNotes)) : undefined);
  const re = o.saved ? replanOf(o.saved, { ...(o.ownChecks ? { ownChecks: o.ownChecks } : {}), ...(o.ownedCards ? { owned: true } : {}), ai: Boolean(o.brain), ...(o.noHeal ? { noHeal: true } : {}), notes: notesId }) : undefined;
  const stale = re?.stale;
  if (o.saved && re?.why) {
    const { saved: _stale, ownChecks: _own, ownedCards: _cards, ...fresh } = o;
    o = { ...fresh, replanned: re.why };
  }
  /** The stale saved steps of a replay that wasn't planned again (no AI, another address, or steps the person wrote), by place. */
  const staleAt = new Map((o.saved && stale ? stale.steps : []).map((x) => [x.i, x.why]));
  const staleSays = staleFix({ ai: Boolean(o.brain), ...(o.noHeal ? { noHeal: true } : {}), owned: Boolean(re?.owned) });
  // A visitor is signed out: a saved session (test --setup's) is never loaded into a visitor's test,
  // whoever asked, so its clicks can't act on the person's own account.
  if (o.visitor && o.storageState) {
    const { storageState: _signedIn, ...signedOut } = o;
    o = signedOut;
  }
  if (o.payments && o.visitor) throw new CouldNotRun("a visitor's test never pays: payments are only for a test of a site marked as yours");
  /** D14: the run's pay state (one final pay press per run), or nothing when it may not pay. */
  const pay = o.payments && !o.visitor ? { owned: o.payments.owned, finalPresses: o.payments.finalPresses ?? { n: 0 } } : undefined;
  const maxActions = o.maxActions ?? DEFAULTS.maxActions;
  const maxPerStep = o.maxPerStep ?? DEFAULTS.maxPerStep;
  const allowHosts = o.allowHosts ?? [];
  const vars = o.vars ?? {};
  const mask = o.masker ?? masker(vars);
  if (o.masker) for (const [name, value] of Object.entries(vars)) mask.add(name, value);
  /** The accessibility scan: each same-site page the run reaches, once, measured with no AI (a11y.ts). Read only. */
  const a11y = new A11yLog(mask);
  /** Scans the page as it is now, unless it is another site's or a bot check stands in front of it. Never throws. */
  const scanA11y = async (p: Page) => {
    if (walled || !sameSite(p.url())) return;
    await a11y.scan(p).catch(() => undefined);
  };
  // Every account value is known to the masker before anything is looked at, so the first look, the
  // plan and every ask after it see {admin.username}, never the value.
  const secretNames = o.secrets ? o.secrets.names().filter((n) => o.secrets!.has(n)) : [];
  for (const name of secretNames) {
    const value = o.secrets!.peek?.(name) ?? o.secrets!.get(name);
    if (value) mask.add(name, value, true);
  }
  // The owner's tokens (C15) are never shown either, in any form.
  for (const value of o.owner?.values ?? []) mask.add("site.access", value, true);
  // D14: card values are test numbers, but never shown either (the masker knows secrets by name only).
  if (pay) for (const n of ["card", "cvc", "expiry"]) if (vars[n]) mask.add(n, vars[n], true);
  /** A value by its placeholder, at type time: a --var, or an account's (told to the masker first). */
  const lookup = (name: string): string | undefined => {
    if (name in vars) return vars[name];
    const value = o.secrets?.has(name) ? o.secrets.get(name) : undefined;
    if (value) mask.add(name, value, true);
    return value;
  };
  const guard = o.signInGuard ?? newSignInGuard();
  /** The person's notes as every ask sees them: masked now, every value known (notes.ts). */
  const notes = o.siteNotes && tidyNotes(o.siteNotes) ? mask(tidyNotes(o.siteNotes)) : undefined;
  const planNotes = notes ? fenceNotes(notes, "plan") : undefined;
  /** Recovery tries after a refusal the site explained, the whole run's (recover.ts). */
  const recoveries: NonNullable<TestResult["recoveries"]> = [];
  /** The choice controls (selects, radio groups) the run's looks showed, by label, as last seen: the form may be a page or a step back when the site refuses it (recover.ts). */
  const choices = new Map<string, Choice>();
  /** The names the AI may write as {name}: never a value. */
  const typeNames = [...Object.keys(vars), ...secretNames.filter((n) => !(n in vars))];
  const emit = (e: TestEvent) => o.on?.(e);
  const begun = Date.now();
  let deadline = begun + (o.minutes ?? DEFAULTS.minutes) * 60_000;
  const browser = o.browser ?? (await launch(o.headed ?? false));
  /** An embedded page's address on the test's site: only then are its elements offered. */
  const sameSite = (u: string) => onSite(u, o.url, allowHosts);
  /** Every address the recorded page went to, and the last: where the run ended. */
  const urls: { t: number; url: string }[] = [];
  let endUrl: string | undefined;
  let startWarning: string | undefined;
  const addressOf = (u: string) => mask(withoutSecrets(u));
  let rec: Recording | undefined;
  /** The first look's session at its end, carried into the recorded run (C4: a rotated token). */
  let lookState: StorageState | undefined;
  /** The test found itself signed out of the session it started with. */
  let sessionExpired = false;
  /** A sign-in code for the result (C19): the site refused the account's password, or the guard stopped it. */
  let signInCode: TestResult["code"];
  /** When this run last asked the site to send a code or link: messages before it are never read. */
  let lastCodeSend = begun;
  const steps: StepResult[] = [];
  const kept: SavedStep[] = [];
  let actions = 0;
  let stopped: string | undefined;
  let replay = false;
  let healedAny = false;
  /** A draft's step was done for the first time (it had nothing to replay): a pass saves what was done. */
  let draftDone = false;
  let video: string | undefined;
  /** The recorded page's cover (cover.ts): undefined in a run that keeps no media. */
  let cover: Recording["cover"];
  /** Stored values typed under the cover's card (the mask couldn't be seen first). */
  let typedCovered = 0;
  /** Stored values typed into boxes masked as dots, the page in view. */
  let typedMasked = 0;
  /** The sign-in's own video, copied beside this run's (sign-in.webm). */
  let signInVideo: string | undefined;
  /** The card is up, as the caller was told (onCover). */
  let cardUp = false;
  /** The action being done types a stored value (the cover is armed, or its card up, for it). */
  let typingNow = false;
  /** The card taken away when nothing typed shows any more (cover.ts), the caller told once. */
  let cardChecks = Promise.resolve();
  const cardDown = (): Promise<void> => (cardChecks = cardChecks.then(async () => {
    if (!cover?.active || !(await cover.release())) return;
    if (cardUp) o.onCover?.({ up: false });
    cardUp = false;
  }));
  /** Where a new user might get stuck: what the run met, each said once. */
  const friction = new FrictionLog();
  /** E2: the fields a secret was typed into, painted over in every picture with the secure fields. */
  const secretFields = new SecretFields();
  /** E10: the protections met (each kind once per page). A run never waits for a person (A1): a check that stands ends it BLOCKED. */
  const protections: ProtectionFinding[] = [];
  /** E1: what the recorded page did. */
  let appLog: AppLog | undefined;
  /** The step running now, for what happens outside an action (a browser alert). */
  let current = 0;
  /** W4: the name of the control being pressed now (a browser confirm right after it may be about it), and what boxes said. */
  let pressedNow: string | undefined;
  const dialogNotes: string[] = [];
  // A bot check is waited on (out of one short budget for each browser context: the first look's,
  // then the recorded one's), never answered. One that stays ends the step it's met in BLOCKED, and
  // the steps after it don't run.
  let watch = new WallWatch(o.wallWaitMs);
  let walled: string | undefined;
  const metWall = (check: string, step: number): End => {
    walled = check;
    friction.add("bot_check", step, `A bot check stood in front of the site (${check}) and didn't let the test browser in`);
    // On a host the person owns (C15): the fix is an owner token, never getting past the check.
    if (o.ownedHost) {
      signInCode = "ACCESS_TOKEN_REQUIRED";
      return { verdict: "blocked", reason: `ACCESS_TOKEN_REQUIRED: ${wallReason(check)}. ${o.owner?.kinds.tokens ? "The owner token set for this site didn't let it through: check it is this deployment's" : "This site is yours: set a bypass token for it (a Vercel bypass secret, a Cloudflare Access service token, or a header your firewall lets through) with npx contextmachines accounts site"}` };
    }
    return { verdict: "blocked", reason: wallReason(check) };
  };
  /** The site asked for a login the run doesn't have (basic auth, Vercel's protection): BLOCKED with its code. */
  const metRefusal = (r: AccessRefusal): End => {
    signInCode = r.code;
    const fix = r.code === "AUTH_BASIC_REQUIRED" ? "set the site's basic-auth login with npx contextmachines accounts site basic" : "set the deployment's bypass secret (Protection Bypass for Automation) with npx contextmachines accounts site vercel, or CM_SITE_VERCEL_BYPASS";
    return { verdict: "blocked", reason: `${r.code}: ${r.why}: ${o.ownedHost ? fix : "it is sent only to a host you've marked as yours (npx contextmachines accounts mine <host>)"}` };
  };
  /** A sign-in plans no judged check, and --measured-only none at all. */
  const measuredOnly = Boolean(o.measuredOnly || o.saveStateTo);
  /**
   * The account this run starts signed in as, when the app signed in first (a session and the account's
   * values): its planner plans nothing that signs in (signedin.ts). Never a sign-in run itself (saveStateTo),
   * a visitor's, or a goal about being signed out or a sign-in meant to fail.
   */
  const signedInAs = o.storageState && o.secrets && !o.saveStateTo && !o.visitor && !NOT_SIGNING_IN.test(o.goal) ? (o.signedInAs ?? o.secrets.names().map((n) => n.split(".")[0]!).find(Boolean) ?? "the test account") : undefined;
  /** Where pictures for the AI are made and checked (shot.ts): our own blank page, made on first use. */
  let desk: ShotDesk | undefined;
  /** Pictures sent to the AI in this run, and the screens they showed. */
  let pictures = 0;
  const picturedScreens = new Set<string>();
  /** The run keeps no pictures (a sign-in, a test that types a value): none goes to the AI either. */
  let mediaOff = Boolean(o.noMedia);
  /** The judge has been asked for a second opinion in this test (at most once). */
  let secondAsked = false;
  /** The goal judge's word, once every step passed. */
  let goalJudge: TestResult["goalJudge"];
  /** W3: the measured proof that a write was kept (proof.ts). */
  let writeProof: WriteProof | undefined;
  /** A check standing now: botwall.ts's, waited on, or a site's own picture check (it never clears by itself). */
  const standsNow = async (page: Page): Promise<string | undefined> => (await watch.stands(page)) ?? (await humanCheck(page));
  let namedAt = "";
  /** E10: what protects the page, named (the setup line only for a host the person owns), each kind once per page. */
  const named = async (page: Page, step: number, at: number, response?: Response | null): Promise<ProtectionFinding[]> => {
    namedAt = page.url();
    const fs = detectProtection(await probePage(page, { mask, ...(response ? { response } : {}) }), Boolean(o.ownedHost), { clerkToken: Boolean(o.owner?.clerk), step, at });
    for (const f of fs) {
      // Each kind once per page. A widget probed before it drew (the start page, read at once) can be filed as
      // not blocking; a later probe that finds it blocking replaces that entry, so the stronger reading wins.
      const was = protections.findIndex((x) => x.kind === f.kind && x.page === f.page);
      if (was >= 0) {
        if (f.blocking && !protections[was]!.blocking) {
          protections[was] = f;
          o.onProtection?.(f);
        }
        continue;
      }
      if (protections.length >= 50) continue;
      protections.push(f);
      o.onProtection?.(f);
    }
    return fs;
  };
  const stood = (name: string, step: number) => {
    walled = name;
    friction.add("bot_check", step, `A bot check stood in front of the site (${name}) and didn't let the test browser in`);
  };
  /** A check that stood, with no person to pass it: BLOCKED, named, with its setup line on a host the person owns. */
  const metCheck = (check: string, step: number, findings: readonly ProtectionFinding[]): End => {
    const pe = protectionEnd(findings);
    if (pe && WIDGET_KINDS.includes(pe.finding.kind)) {
      stood(pe.finding.name, step);
      return { verdict: "blocked", reason: mask(pe.reason), blockedGroup: "bot_wall" };
    }
    const wall = metWall(check, step);
    const setup = pe?.finding.owned && pe.finding.setup ? ` Setup: ${pe.finding.setup}` : "";
    return { ...wall, reason: mask(`${wall.reason}${setup}`), blockedGroup: "bot_wall" };
  };
  /** C13: a sign-in window kept open on a host allowed for it, in a run that asks for that. */
  const keepPopup = o.keepPopups ? (u: string) => !onSite(u, o.url, []) && onSite(u, o.url, allowHosts) : undefined;
  const guardWith = (consent: { open: boolean }) => ({ consent: () => consent.open, ...(o.owner ? { owner: o.owner } : {}), ...(keepPopup ? { keepPopup } : {}), ...(pay ? { alsoAllow: (u: string) => Boolean(providerOf(u)) } : {}) });
  try {
   body: {
    // The plan: the saved one, or the AI's (checked by machine, asked again once if it's not usable).
    let plan: (PlannedStep & { actions?: CachedAction[] })[];
    emit({ type: "phase", words: "Opening the site" });
    if (o.saved) {
      plan = o.saved.steps;
      replay = true;
    } else {
      if (!o.brain) throw new CouldNotRun("there's no AI to plan the steps");
      // A first look, not recorded: the planner sees the page the test starts on (and plans no step
      // to open it), and the video starts with the test's first action, not a page waiting on the AI.
      let start: StartPage | undefined;
      /** The plan, made while the first look's page is still open (its checks are measured there). */
      let planned: PlannedStep[] | undefined;
      /** A bot check that stayed in front of the start page: nothing is planned (no AI is asked), and the test is BLOCKED. */
      let wallAtLook: { check: string; shot?: string; ms: number } | undefined;
      /** The site asked for a login the run doesn't have before it showed (C15). */
      let refusedAtLook: AccessRefusal | undefined;
      /** E10: what stood at the first look, named. */
      let lookFindings: ProtectionFinding[] = [];
      const look = await browser.newContext({ ...sizeOptions(o.viewport ?? SIZE), ...placeOptions(o.place), acceptDownloads: false, serviceWorkers: "block", ...(o.storageState ? { storageState: o.storageState } : {}) });
      await seeShadowRoots(look);
      const keepLookState = async () => {
        if (o.storageState) lookState = await look.storageState({ indexedDB: true }).catch(() => undefined);
      };
      try {
        const page = await look.newPage();
        const consent = { open: false };
        await guardSite(page, o.url, allowHosts, guardWith(consent));
        const t0 = Date.now();
        let first: Response | null = null;
        if (o.visitor) await openAsVisitor(page, o.url, consent, watch);
        else first = await open(page, o.url);
        refusedAtLook = await refusedAccess(page, first, o.owner);
        // E10: what stands is named. Nobody is asked to get past it (A1): the run ends BLOCKED.
        if (refusedAtLook) await named(page, 1, 0, first);
        const wall = refusedAtLook ? undefined : await standsNow(page);
        if (wall) lookFindings = await named(page, 1, 0, first);
        if (refusedAtLook) {
          // Nothing to plan on: no AI is asked.
        } else if (wall) {
          // The photo of the wall is kept, as a step's would be (unless the run keeps none).
          let shot: string | undefined;
          if (!o.noMedia && !(typeNames.length && usesVar([o.goal, ...(o.given ?? [])].join("\n")))) {
            mkdirSync(o.dir, { recursive: true });
            shot = await page.screenshot({ path: join(o.dir, "step-1.jpg"), type: "jpeg", quality: 70, timeout: 10_000, ...maskOptions(page) }).then(() => "step-1.jpg", () => undefined);
          }
          wallAtLook = { check: wall, ms: Date.now() - t0, ...(shot ? { shot } : {}) };
        } else {
          const snap = await observe(page, mask, undefined, PLAN_SNAPSHOT_CHARS, { onSite: sameSite });
          const known = await knownAtStart(page, snapText(snap));
          start = { url: snap.url, title: snap.title, snapshot: snapText(snap), ...(known.paths.length ? { addresses: known.paths.map((p) => mask(withoutSecrets(p))) } : {}), ...(signedInAs ? { signedInAs } : {}) };
          emit({ type: "phase", words: o.replanned ? (o.replanned === NOTES_CHANGED ? NOTES_REPLANNING : REPLANNING) : "Planning the steps" });
          const brain = o.brain;
          planned = await planChecked((problem) => (planNotes ? brain.plan(o.goal, o.url, o.given, start, problem, planNotes) : brain.plan(o.goal, o.url, o.given, start, problem)), page, { goal: o.goal, ...(o.given ? { given: o.given } : {}), measuredOnly, vars, known, mask, onAgain: (words) => emit({ type: "phase", words }) });
          // A run as an account starts signed in already (the app signed in first): the planner was told, and as
          // a guard no step opens, fills or submits the sign-in form; a step that signed in and did more keeps the rest.
          if (planned && signedInAs) {
            let after = afterSignIn(planned, o.goal, signedInAs, { measuredOnly });
            if (after.problem) {
              // Asked once more for a real check of what comes after; an unusable answer leaves the guard's plan.
              emit({ type: "phase", words: "Planning again: the run is already signed in" });
              const again = await brain.plan(o.goal, o.url, o.given, start, mask(`${after.problem}. Your last plan was: ${planned.map((s, i) => `${i + 1}. ${clip(s.title, 60)} (check: ${expected(s.check)})`).join("; ")}`), ...(planNotes ? [planNotes] : [])).catch(() => undefined);
              const next = again && !planProblem(again, o.goal, { measuredOnly, ...(o.given ? { given: o.given } : {}) }) ? afterSignIn(again, o.goal, signedInAs, { measuredOnly }) : undefined;
              if (next && !next.problem) after = next;
            }
            planned = after.steps;
            if (after.changed.length) emit({ type: "phase", words: mask(`Already signed in as ${signedInAs}: ${after.changed.length === 1 ? after.changed[0]! : `${after.changed.length} planned steps changed (${after.changed.join("; ")})`}`) });
          }
        }
      } finally {
        await keepLookState();
        await look.close().catch(() => {});
      }
      if (wallAtLook || !start || !planned) {
        const check = wallAtLook?.check ?? "the site's bot check";
        const only: PlannedStep = { title: "Open the site", intent: `Open ${mask(o.url)}`, check: { kind: "none" } };
        emit({ type: "planned", steps: [only], replay: false });
        emit({ type: "step", n: 1 });
        const step: StepResult = { n: 1, ...only, ...(refusedAtLook ? metRefusal(refusedAtLook) : metCheck(check, 1, lookFindings)), ...(signInCode ? { code: signInCode } : {}), actions: [], ms: wallAtLook?.ms ?? 0, at: 0, ...(wallAtLook?.shot ? { screenshot: wallAtLook.shot } : {}) };
        steps.push(step);
        emit({ type: "stepEnd", step });
        break body;
      }
      plan = planned;
    }
    // A test that may type a stored value (an account's, a --var) keeps its video, photos and live
    // screen, with the cover (cover.ts): secure fields' text is masked in every frame, and a card stands
    // over the page from just before a stored value is typed until no field shows it. The AI's pictures
    // keep the old rule: a run with a stored value to type sends none (shot.ts).
    // The actor is told every name it may type, so the plan's words can't say it won't type one.
    const typesVar = secretNames.length > 0 || (typeNames.length > 0 && (!o.saved || usesVar(JSON.stringify([o.goal, o.given ?? [], plan]))));
    if (typesVar) mediaOff = true;
    // The session the first look ended with: a site that rotates its token on every use has already
    // replaced the saved one, which would now be refused as reused.
    const session = lookState ?? o.storageState;
    // The cover only where there is something to keep out of the frames: a visitor's run with no stored value gets no script.
    const covers = Boolean(signedInAs || session || typeNames.length || secretNames.length || mask.every().length);
    const coverHosts = [siteOf(new URL(o.url).hostname), ...allowHosts, ...(o.accountHosts ?? [])];
    rec = await record(o.dir, browser, { ...(session ? { storageState: session } : {}), ...(o.noMedia ? { noMedia: true } : {}), fields: secretFields, ...(o.viewport ? { viewport: o.viewport } : {}), ...(o.place ? { place: o.place } : {}), ...(covers ? { cover: true, coverHosts } : {}) });
    // W4: the run's tabs. Without a cover, a window the page opens on the site (window.open) is kept
    // and shown, and `page` stands for whichever tab is shown; with one (stored values to hide), every
    // window is followed in the first tab as before, as only the first tab is covered.
    const tabs = new Tabs(rec.page);
    const keepTabs = !rec.cover;
    const page = keepTabs ? tabs.page : rec.page;
    if (keepTabs) rec.follow(() => tabs.active);
    // W4: every file the run's pages download, read for its words (download_contains).
    const downloads = new Downloads(rec.context);
    // A file is taken only for a step that checks one (this one or one to come), or a download action.
    downloads.want = () => plan.slice(Math.max(0, current - 1)).some((s) => s.check.kind === "download_contains");
    // W4: when the run last sent something to the site (a save, not a page read), from any tab.
    let siteWriteAt = 0;
    rec.context.on("request", (r) => {
      try {
        if (r.method() !== "GET" && r.method() !== "HEAD" && r.method() !== "OPTIONS" && sameSite(r.url())) siteWriteAt = Date.now();
      } catch {
        // an address that can't be read isn't the site's
      }
    });
    const recording = rec;
    cover = rec.cover;
    // The guard (cover.ts) covers any frame whose fields or words show a stored value: a password, a code,
    // a key, a --var; never a username or an email, which a signed-in page shows in its header all the time.
    // In a box, every stored value is dots (the username and email too).
    cover?.holdFor(() => mask.every().filter(([name]) => !IDENTITY_NAME.test(name)).map(([, v]) => v), () => mask.every().map(([, v]) => v));
    await cover?.sync();
    // E1: the app log, from the first address on, each line tied to its step and the video's time.
    appLog = attachAppLog(page, { step: () => current, at: () => recording.at(), mask, ...(o.onLog ? { onEntry: o.onLog } : {}) });
    // What is loading: a wait on a page with nothing loading ends after a few seconds (waitfor.ts).
    const network = networkWatch(page, { own: sameSite });
    // Where the page went, as the video shows it: the address bar after a reload, and where the run ended.
    page.on("framenavigated", (f) => {
      if (f !== page.mainFrame() || !/^https?:/.test(f.url())) return;
      const at = addressOf(f.url());
      endUrl = at;
      if (urls.at(-1)?.url !== at && urls.length < 200) urls.push({ t: recording.at(), url: at });
    });
    if (o.onPage) await o.onPage(page, { noMedia: Boolean(o.noMedia), fields: secretFields, ...(cover ? { covered: true } : {}) });
    // A run that starts signed in as an account: the video opens on a card saying so, as the sign-in
    // itself was never recorded (it ran with no screen). The live screen shows its own card then.
    if (o.signInVideo && signedInAs && existsSync(o.signInVideo)) {
      try {
        copyFileSync(o.signInVideo, join(o.dir, SIGN_IN_VIDEO_FILE));
        signInVideo = SIGN_IN_VIDEO_FILE;
      } catch {
        signInVideo = undefined;
      }
    }
    if (cover && signedInAs) {
      await page.setContent(signedInCard(mask(signedInAs), signInVideo ? SIGN_IN_OWN_VIDEO : SIGN_IN_SAVED)).catch(() => {});
      await page.waitForTimeout(SIGNED_IN_CARD_MS).catch(() => {});
    }
    // A browser alert, confirm or prompt is answered and noted: a person had to answer it. W4: a confirm
    // is read, and said yes to only when it asks for what the step does and its words pass the deny
    // list (widgets.ts answerDialog); everything else is dismissed (as Playwright would). The actor is told.
    const onDialog = (d: import("playwright").Dialog) => {
      const step = plan[Math.max(0, current - 1)];
      const a = answerDialog(d.type(), d.message(), { step: step ? `${step.title}. ${step.intent}` : "", goal: o.goal, ...(pressedNow ? { pressed: pressedNow } : {}), denied: (w) => refusedName(w) ?? refusedPlace(w) ?? (o.visitor ? refusedSignedOut(w) : undefined) ?? (o.secrets && o.notOwned && !o.visitor ? refusedOnOwnAccount(w) : undefined) });
      const said = dialogNote(d, a, clip);
      friction.add("popup", Math.max(1, current), mask(said.charAt(0).toUpperCase() + said.slice(1)));
      dialogNotes.push(mask(said));
      void (a.accept ? d.accept() : d.dismiss()).catch(() => {});
    };
    page.on("dialog", onDialog);
    tabs.onNew = (p) => p.on("dialog", onDialog);
    const consent = { open: false };
    const offSite = await guardSite(rec.page, o.url, allowHosts, { ...guardWith(consent), ...(keepTabs ? { tabs } : {}) });
    // A fresh context: the first look's cookies (a check's clearance among them) went with it, so a
    // check that cleared by itself there may stand again here, and is given its own short wait.
    watch = new WallWatch(o.wallWaitMs);
    let opened: Response | null = null;
    if (o.visitor) {
      const rejected = await openAsVisitor(page, o.url, consent, watch);
      if (rejected) friction.add("popup", 1, mask(`A consent wall stood in front of the site: answered with '${clip(rejected, 60)}'`));
    } else opened = await open(page, o.url);
    const refusedAtOpen = await refusedAccess(page, opened, o.owner);
    emit({ type: "planned", steps: plan.map(({ title, intent, check }) => ({ title, intent, check })), replay });
    // A start address that shows "not found": said once, never acted on, as the 404 may be the bug the test is about.
    const gone = await notFound(page);
    if (gone) startWarning = mask(`${shortAddress(page.url())} shows "${clip(gone, 60)}" when it opens`);
    // A bot check in front of the start page (a replay meets it here; a fresh run, in its first look,
    // unless it came up since): the first step is BLOCKED with the wall's photo, and nothing more runs.
    // E10: the start page's protections are named, blocking or not (a test key is said as such).
    const startFindings = await named(page, 1, recording.at(), opened);
    const wallAtOpen = refusedAtOpen ? "" : await standsNow(page);
    const openEnd: End | undefined = wallAtOpen ? metCheck(wallAtOpen, 1, startFindings) : undefined;
    if (wallAtOpen || refusedAtOpen) {
      for (const [i, planned] of plan.entries()) {
        const n = i + 1;
        const base = { n, title: mask(planned.title), intent: mask(planned.intent), check: planned.check };
        if (i === 0) {
          emit({ type: "step", n });
          const shot = await recording.shot("step-1.jpg");
          const step: StepResult = { ...base, ...(refusedAtOpen ? metRefusal(refusedAtOpen) : openEnd!), ...(signInCode ? { code: signInCode } : {}), actions: [], ms: 0, at: recording.at(), ...(shot ? { screenshot: shot } : {}) };
          steps.push(step);
          emit({ type: "stepEnd", step });
        } else {
          const skipped: StepResult = { ...base, verdict: "skipped", actions: [], ms: 0, at: recording.at() };
          steps.push(skipped);
          emit({ type: "stepEnd", step: skipped });
        }
      }
      break body;
    }
    // The start page, as it opened: scanned before anything is done on it.
    if (!gone) await scanA11y(page);
    const given = [o.goal, ...(o.given ?? []), ...plan.map((s) => s.intent)].join("\n");
    // A sign-in, or a goal that names its values, makes nothing up: a made-up email beside a real password is a failed sign-in.
    const madeUp: MadeUpRules = { none: Boolean(o.noMadeUp) || usesVar([o.goal, ...(o.given ?? [])].join("\n")), varNames: typeNames };
    const fromPerson = [o.goal, ...(o.given ?? [])].join("\n");
    // A saved test's targets are found by the matching rules it was saved under; one saved before they had a number, as it always was.
    const rules = o.saved ? o.saved.rules : RULES;
    /** Codes and links made when typed ({admin.totp}, {admin.email_code}): only messages after the last "send code" press, or the run's start. */
    // A code sent to the person's own inbox or phone is never waited for (A1): the step ends BLOCKED
    // CODE_NEEDS_PERSON (SMS_CODE_NEEDED for a text), and "Set up sign-in" under Accounts is the fix.
    const accountHost = new URL(o.url).host;
    const fresh = o.secrets?.fresh ? (name: string, on?: string) => o.secrets!.fresh!(name, { since: lastCodeSend, mask, allowedHosts: [new URL(o.url).host, ...allowHosts], host: accountHost, ...(on ? { typedOn: on } : {}), ...(o.signal ? { signal: o.signal } : {}) }) : undefined;
    const ctx: ActContext = {
      page, start: o.url, allowHosts, values: { vars, resolve: lookup, given, madeUp, fromPerson, ...(fresh ? { fresh } : {}), ...(o.noMedia || cover ? {} : { recording: true }) }, mask, offSite,
      ...(o.visitor ? { visitor: true } : {}), ...(rules ? { rules } : {}),
      ...(o.codeSends && !o.visitor ? { codeSends: { host: o.codeSends.host, ...(o.codeSends.signUp ? { signUp: true } : {}), count: { n: 0 } } } : {}),
      // An account's values go only to its exact hosts: the start host alone when the caller named none.
      ...(o.secrets ? { accountHosts: (o.accountHosts?.length ? o.accountHosts : [accountHost]).map((h) => h.toLowerCase()), accountNames: new Set(o.secrets.names()) } : {}),
      // The person's own account on a site that isn't theirs: no votes, ratings, reports, carts or security changes either.
      ...(o.secrets && o.notOwned && !o.visitor ? { notOwned: true } : {}),
      // Just before the first key of a stored value: any code made for it joins the guard, and the box it
      // goes into is read back as dots (the page may have drawn it again since the mask was armed); not, the card.
      ...(cover ? { beforeKey: async (el: Locator) => {
        if (!cover || !typingNow) return true;
        await cover.sync();
        if (cover.active || (await cover.maskedAt(el))) return true;
        if (!(await cover.show(TYPING_CARD))) return false;
        if (typedMasked > 0) typedMasked--;
        typedCovered++;
        if (!cardUp) o.onCover?.({ up: true, words: TYPING_CARD });
        cardUp = true;
        return true;
      } } : {}),
      ...(o.providerHosts?.length ? { providerHosts: o.providerHosts } : {}),
      secretFields,
      ...(pay ? { pay } : {}),
      ...(o.saved && new URL(o.saved.url).origin !== new URL(o.url).origin ? { savedOrigin: new URL(o.saved.url).origin } : {}),
      ...(keepTabs ? { tabs } : {}),
    };
    /** The last look: what is new since is shown first in the next. */
    let lastSnap: Snapshot | undefined;
    /** E4: the address of the page the AI was last asked about (any step): a next look there sends less of the rest. */
    let askedOn: string | undefined;
    let lastShot: { file: string; hash: string; n: number } | undefined;
    // Each check as the page is before anything is done: a step that only looks proves little when
    // what it looks for was there from the start (a link in the menu on every page).
    const atStart: boolean[] = [];
    for (const s of plan) atStart.push(s.check.kind !== "none" && s.check.kind !== "judged" && (await verify(page, withVars(s.check, lookup), 0)).ok);
    /**
     * W3 proof (proof.ts): a run whose goal makes, changes or deletes something (or a step that saves)
     * keeps, from its first action, what each action gave and the page's plain text right before each
     * action: the "before" is fixed before any press. And the write requests each press caused, as
     * support. At the end, a fresh load must show the change kept; the AI judge alone never passes it.
     */
    const recordWrite = goalAsks(o.goal).changes || plan.some((s) => needsOf(s).submit);
    const proofOn = recordWrite || LIST_ADD.test(o.goal);
    const proofActs: ProofAct[] = [];
    const readings: Reading[] = [];
    let listsRead = false;
    let proofSeq = 0;
    let lastActionAt = Date.now();
    const writes = proofOn ? new WriteWatch(page, sameSite) : undefined;

    /**
     * A masked picture of the screen for the AI (section 5.1), or nothing: only when the outline lists
     * nothing usable, or `about` is about something drawn and a canvas, svg or image covers 15% of the
     * screen; never in a run that keeps no pictures; at most 6 a test; never the same picture twice to
     * the actor (what a canvas draws isn't in the outline, so the picture itself is compared). The
     * judge's one look is never cut for a picture the actor had.
     */
    const pictureFor = async (snap: Snapshot, about: string, n: number, who: "actor" | "judge", afterPoint = false): Promise<ImageInput | undefined> => {
      if (!o.brain?.sees || mediaOff || cover?.active || pictures >= PICTURES_FALLBACK_MAX) return undefined;
      const empty = snap.usable.size === 0;
      // W5 (decision J): past the usual 6, a picture only when the outline is empty or contradicts the step.
      const contradicts = !empty && outlineContradicts(snap, about);
      if (pictures >= PICTURES_PER_TEST && !empty && !contradicts) return undefined;
      // W5: after a point press, what it drew (never in the outline) is pictured once, within the 6.
      if (!empty && !contradicts && !afterPoint && !(DRAWN.test(about) && (await page.evaluate(drawnShare).catch(() => 0)) >= DRAWN_SHARE)) return undefined;
      desk ??= new ShotDesk(browser);
      const shot = await maskedShot(page, { mask, anySecret: mask.every().length > 0, desk, fields: secretFields });
      if ("none" in shot) {
        if (shot.none.startsWith(NO_PICTURE_SECRET)) emit({ type: "working", n, words: NO_PICTURE_SECRET, at: recording.at() });
        return undefined;
      }
      const seen = createHash("sha1").update(shot.jpeg).digest("hex");
      if (who === "actor" && picturedScreens.has(seen)) return undefined;
      pictures++;
      picturedScreens.add(seen);
      return { mime: "image/jpeg", data: shot.jpeg };
    };
    /**
     * One claim judged on the screen as it is now, by a separate AI that sees only this page (judge.ts),
     * its answer checked by machine. Never a pass without quotes found on the page.
     */
    const judgeNow = async (claim: string, n: number, typed: readonly string[] = [], before?: string): Promise<JudgedOutcome & { image: boolean }> => {
      if (measuredOnly) return { verdict: "not_sure", reason: "this step's check is judged by AI, and judged checks are off for this run (--measured-only)", image: false };
      if (!o.brain?.judge) return { verdict: "not_sure", reason: "this step's check is judged by AI, and there's no AI to judge it", image: false };
      emit({ type: "working", n, words: mask(`Asking an AI to judge: "${clip(claim, 80)}"`), at: recording.at() });
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      const snap = await observe(page, mask, undefined, PLAN_SNAPSHOT_CHARS, { onSite: sameSite });
      const outline = snapText(snap);
      const image = await pictureFor(snap, claim, n, "judge");
      let answer: unknown;
      try {
        answer = await o.brain.judge({ claim: mask(claim), url: snap.url, title: snap.title, outline, ...(image ? { image } : {}), ...(notes ? { notes } : {}) });
      } catch (error) {
        return { verdict: "not_sure", reason: mask(`the AI judge didn't answer: ${message(error)}`), image: Boolean(image) };
      }
      const out = judgedOutcome(answer, outline, Boolean(image), { typed, ...(before !== undefined ? { before } : {}) });
      return { verdict: out.verdict, reason: mask(out.reason), image: Boolean(image) };
    };

    /** What the steps just before this one did when they had no check: theirs is this step's to prove. */
    let carried: CachedAction[] = [];
    /** W4: every value the run has typed, in any step, with when its step began: a file the page made itself holding one shows nothing saved. */
    const typedInRun: { value: string; at: number }[] = [];
    for (const [i, planned] of plan.entries()) {
      const n = i + 1;
      const base = { n, title: mask(planned.title), intent: mask(planned.intent), check: planned.check };
      if (steps.some((s) => s.verdict !== "passed")) {
        const skipped: StepResult = { ...base, verdict: "skipped", actions: [], ms: 0, at: recording.at() };
        steps.push(skipped);
        emit({ type: "stepEnd", step: skipped });
        continue;
      }
      if (o.signal?.aborted) {
        stopped = STOPPED_BY_YOU;
        const notRun: StepResult = { ...base, verdict: "not_sure", reason: STOPPED_BY_YOU, actions: [], ms: 0, at: recording.at() };
        steps.push(notRun);
        emit({ type: "stepEnd", step: notRun });
        continue;
      }
      emit({ type: "step", n });
      current = n;
      const t0 = Date.now();
      // A signed-in test that finds itself on the sign-in page has lost its session (C4): nothing more
      // is done or asked, so whoever ran it can sign in again with no AI and run it once more.
      // (A test that starts on the sign-in page itself is left to do its steps.)
      if (o.storageState && shortAddress(page.url()) !== shortAddress(o.url) && !plan.slice(0, i).some((s) => SIGNS_OUT.test(`${s.title} ${s.intent}`)) && (await signedOutNow(page, o.signInPath))) {
        sessionExpired = true;
        const gone: StepResult = { ...base, verdict: "not_sure", reason: mask(`the saved session has expired: the site sent the test to sign in (${shortAddress(page.url())})`), actions: [], ms: 0, at: recording.at() };
        steps.push(gone);
        emit({ type: "stepEnd", step: gone });
        continue;
      }
      const at = recording.at();
      const subs: SubAction[] = [];
      const done: CachedAction[] = [];
      let end: End | undefined;
      let healed: StepResult["healed"];
      /** The saved actions that didn't work (the missing one and those after it), and where the AI's own began in `done`. */
      let healFrom: CachedAction[] | undefined;
      let healStart = 0;
      /** Values it won't make up that this step needed: the --var names to pass. */
      const needs = new Set<string>();
      /** Actions that worked since the last value it wouldn't make up: one that went on past it wasn't stopped by it. */
      let sinceNeed = 0;
      /** A password wanted where a session was saved: the session is gone, and --setup is the way back, not a --var. */
      const sessionGone = () => Boolean(o.signInHint) && needs.has("password");
      const needWords = () => (sessionGone() ? o.signInHint! : `it needs values it won't make up: ${varHint([...needs])}`);
      const note = (sub: SubAction) => {
        subs.push(sub);
        emit({ type: "action", n, action: sub });
      };
      const stoppedBefore = (label: string, cached?: true) => note({ label: `Stopped before ${lowerFirst(label)}`, at: recording.at(), blocked: true, ...(cached ? { cached } : {}) });
      /** Time spent waiting on the page in this step, not on the AI. */
      let waitedMs = 0;
      /** The first action that didn't work the first time, in a person's words. */
      let retried: string | undefined;
      /** Sends the browser saw fail: the form wasn't sent, the page showed an error, or the sign-in form is still there. */
      const failedSends = new WeakSet<CachedAction>();
      /**
       * Intent coverage (intent.ts): what the step's words say must be done (type values, save or
       * submit). Not for a person's Assert step or a sign-in step (its check is the session); a step that
       * signs in and does more ("Sign in and add a trade") is held to the rest of its words.
       */
      const wants: IntentNeeds = needsOf(planned);
      /**
       * A step that saves, judged by an AI: the page as the step began, so a judge's quotes that were all
       * there already (a row an earlier run left, typed with the same made-up values) pass nothing.
       */
      const judgedBefore = wants.submit && !measuredOnly && o.brain?.judge && (planned.check.kind === "judged" || i === plan.length - 1) ? await observe(page, mask, undefined, PLAN_SNAPSHOT_CHARS, { onSite: sameSite }).then(snapText).catch(() => undefined) : undefined;
      /** Presses the browser tried in this step that didn't work (for "never pressed 'Save'"). */
      const triedFailed: CachedAction[] = [];
      /**
       * The first save-like press after the step's last typing, in a step that saves: its name, whether
       * the check already held just before it, the action, and how many values had been given then (a
       * value typed after it starts again). A "Close" or "Back to trades" after a save that worked
       * doesn't replace it.
       */
      let lastSend: { name: string; held: boolean; action: CachedAction; given: number } | undefined;
      /** Presses in this step that read like a save (savePress), done: a refusal stands only until the next one. */
      let savesPressed = 0;
      const givenSoFar = () => done.filter((a) => gives(a)).length;
      /** What the step's intent still needs that its actions don't show, or nothing. */
      const shortfall = () => intentShortfall(wants, done.filter((a) => !failedSends.has(a)), [...triedFailed, ...done.filter((a) => failedSends.has(a))]);
      /** The AI was told once that the intent isn't done yet. */
      let toldShort = false;
      /**
       * Fill the form like a real user (fill.ts): the forms this step held a press for, what each form
       * showed at its last press that went through (by formKey), the actor's line for what it left
       * empty, and the scan taken for the nudge (reused by the press right after it).
       */
      const fillNudge = newNudge();
      const fillPages = new Map<string, FillRecord>();
      let fillHeld = false;
      let fillKept: string | undefined;
      let preScan: { action: unknown; scan: FormScan } | undefined;
      /** The form a press is in, read in the page (never a value said anywhere: only labels and whether each is empty). */
      const scanFor = async (action: Parameters<typeof act>[1]): Promise<FormScan | undefined> => {
        const where = action.type === "press" ? { el: page.locator(":focus") } : "ref" in action && action.ref ? await locateLive(page, action.ref) : "target" in action && action.target ? await locateSaved(page, action.target, rules) : undefined;
        if (!where || !("el" in where)) return undefined;
        return where.el.first().evaluate(formFields, undefined, { timeout: 2000 }).catch(() => undefined);
      };
      /** The press as fill.ts reads it: its type, its key or its control's role and name. */
      const pressOf = (type: string, key: string | undefined, target: { role?: string; name?: string } | undefined) => ({ type, ...(type === "press" ? { key } : {}), ...(target ? { target } : {}) });
      /** A press that sends the form it is in on: a save, the form's own submit button, Enter in a one-line box (fill.ts). */
      const sendsForm = (scan: FormScan, pa: ReturnType<typeof pressOf>) => sendsOn(scan, pa) || (pa.type !== "press" && savePress(pa));
      /** A press the browser would refuse anyway (pay, place an order, delete, a dialog that removes something; a visitor's sign-up): never held to fill more first. */
      const refusedAnyway = (name: string, scan: FormScan) => refusedName(name) ?? (scan.dialog ? refusedName(scan.dialog) : undefined) ?? (ctx.notOwned ? refusedOnOwnAccount(name) : undefined) ?? (ctx.visitor ? refusedSignedOut(name) : undefined);
      /** The step makes a new record (not an edit of one): the only step the nudge holds a press in. */
      const createsHere = createsRecord(`${planned.title}. ${planned.intent}`);
      /** Boxes for another purpose (a search, a finder, a code) the actor was told once to leave empty in this step, by label. */
      const asideHeld = new Set<string>();
      /** The site refused an account's password just now, or the sign-in guard stopped another try: the step ends here. */
      let refusedEnd: End | undefined;
      /** An account whose password was typed in this step and not yet sent. */
      let passwordFor: string | undefined;
      /** Something other than a stored value was typed since the last send (a username typed as itself). */
      let typedOwn = false;
      /** This step typed an account's stored or made value (a sign-in step), and whether one was its authenticator code. */
      let typedAccount = false;
      let typedTotp = false;
      let typedPassword = false;
      /** E10: a captcha box stood in front of a send in this step. */
      let heldEnd: End | undefined;
      /**
       * E10: a press (or Enter) that would send a form whose captcha box no one has passed: nothing is
       * pressed, and the step is BLOCKED with the provider named. Read only: the box itself is never touched.
       */
      const widgetHolds = async (action: Parameters<typeof act>[1], target?: Parameters<typeof act>[2]): Promise<Outcome | undefined> => {
        // A double-click is two clicks: held as one is (it could send the form past the box twice over).
        if (!(action.type === "click" || action.type === "dblclick" || (action.type === "press" && (action.key === "Enter" || action.key === "Space")))) return undefined;
        const where = action.type === "press" ? { el: page.locator(":focus") } : "ref" in action ? await locateLive(page, action.ref) : "target" in action ? await locateSaved(page, action.target, rules) : undefined;
        if (!where || !("el" in where) || !(await guardedSend(where.el.first()))) return undefined;
        const h = await widgetStands();
        if (!h) return undefined;
        heldEnd = h;
        const name = target?.name ?? ("target" in action ? action.target.name : "");
        return { blocked: heldEnd.reason ?? "a check stood in the way", label: action.type === "press" ? `Pressing ${action.key}` : `Clicking on '${clip(mask(name), 60)}'` };
      };
      /**
       * A captcha box on the page that blocks and that no one has passed: the step's BLOCKED end, named.
       * Nothing when there is none.
       */
      const widgetStands = async (): Promise<End | undefined> => {
        const fs = await named(page, n, recording.at());
        const f = fs.find((x) => x.blocking && WIDGET_KINDS.includes(x.kind));
        if (!f || !(await unsolvedWidget(page))) return undefined;
        return metCheck(f.name, n, fs);
      };
      /**
       * act(), with what it met noted for "where a new user might get stuck": the dialog it closed,
       * the nameless control it used, the errors the page showed after it, how long it waited.
       */
      const tracked = async (action: Parameters<typeof act>[1], target?: Parameters<typeof act>[2], to?: Parameters<typeof act>[3]): Promise<Outcome> => {
        // Hard rule 8: a password the site said no to is never typed again, and no account gets more
        // than 3 sign-in submits, so a test can't lock an account out.
        if ((action.type === "fill" || action.type === "type") && action.value) {
          const pw = placeholderNames(action.value).find(isPasswordName);
          const who = pw ? (splitName(pw).label ?? pw) : undefined;
          if (who && guard.rejected.has(who)) {
            signInCode = "AUTH_CREDENTIAL_INVALID";
            return { blocked: `AUTH_CREDENTIAL_INVALID: ${who}'s password was already refused by the site in this run, so it isn't typed again (that could lock the account)`, label: `Typing ${who}'s password` };
          }
          if (who && guard.deviceCheck?.has(who)) {
            signInCode = "DEVICE_CHECK";
            return { blocked: `DEVICE_CHECK: ${who}'s sign-in already met a "confirm it's a new device" page in this run, so it isn't sent again (each send could mail the person)`, label: `Typing ${who}'s password` };
          }
        }
        const pressing = ((action.type === "click" || action.type === "dblclick") && /^(button|link|menuitem|item)$/.test(target?.role ?? ("target" in action ? action.target.role : "button"))) || (action.type === "press" && action.key === "Enter");
        if (pressing && passwordFor && (guard.submits.get(passwordFor) ?? 0) >= MAX_SIGN_IN_SUBMITS) {
          signInCode = "AUTH_ACCOUNT_LOCKED_OUT";
          return { blocked: `AUTH_ACCOUNT_LOCKED_OUT: ${passwordFor} has had ${MAX_SIGN_IN_SUBMITS} sign-in tries already, the most a run or a suite allows, so it isn't sent again`, label: `Sending ${passwordFor}'s sign-in` };
        }
        const closing = action.type === "click" || (action.type === "press" && action.key === "Escape");
        const dialog = closing ? await openDialog(page) : undefined;
        const looks = action.type === "click" || action.type === "press" || action.type === "fill" || action.type === "select" || action.type === "type";
        const before = looks ? await pageErrors(page) : [];
        const urlBefore = page.url();
        const t = Date.now();
        const sendsBefore = ctx.codeSends?.count.n ?? 0;
        // D14: a live checkout (or a provider's page whose test mode can't be seen) ends the run BLOCKED
        // on sight, before anything is typed into it, before and after every action.
        const liveNow = async () => (pay ? liveOnSight((await payModeOf(page).catch(() => undefined)) ?? { mode: "unknown", providers: [], sightings: [], mayPay: false, reason: "the checkout couldn't be read" }, Boolean(checkoutOf(page.url()))) : undefined);
        const liveBefore = await liveNow();
        if (liveBefore) return { blocked: liveBefore, label: "Going on at the checkout" };
        const held = await widgetHolds(action, target);
        if (held) return held;
        // A step that saves: the check is measured right before each press after its typing, so a check
        // that already held then (the form's own words) is known to prove nothing the save did.
        const pressName = action.type === "press" ? `${action.key}` : (target?.name ?? ("target" in action ? (action.target as { name?: string }).name : "") ?? "");
        // Only a press that reads like a save (Enter in a field, or "Save trade", "Add", "OK"): a click on a
        // suggestion, a toggle or "Upload file" after the typing isn't the save (intent.ts savePress).
        const pressTarget = action.type === "press" ? undefined : (target ?? ("target" in action ? (action.target as { role?: string; name?: string }) : undefined));
        const isSend = wants.submit && savePress({ type: action.type, ...(action.type === "press" ? { key: action.key } : {}), ...(pressTarget ? { target: pressTarget } : {}) }) && (!wants.fill || done.some((a) => gives(a))) && !(lastSend && lastSend.given === givenSoFar());
        // What the form this press sends shows, right before it is pressed: kept on the step (fill.ts).
        const fillPress = pressOf(action.type, action.type === "press" ? action.key : undefined, pressTarget);
        const fillRead = wants.submit && !o.saveStateTo && pressCandidate(fillPress) ? (preScan?.action === action ? preScan.scan : await scanFor(action)) : undefined;
        const fillScan = fillRead && !fillRead.signIn && !fillRead.search && sendsForm(fillRead, fillPress) ? fillRead : undefined;
        preScan = undefined;
        const heldPreSend = isSend && EARLY_CHECKS.has(planned.check.kind) ? (await verify(page, withVars(planned.check, lookup), 0).catch(() => ({ ok: false }))).ok : false;
        // W3: the page's plain text right before this action, and the write requests it causes.
        const proofAt = proofSeq++;
        if (proofOn && readings.length < 80) readings.push({ seq: proofAt, url: urlKey(page.url()), text: await readPlain(page) });
        // W3: before the run first types into a form it will save (or saves), the site's own lists of what the goal makes (the start page,
        // links named like it: "add a trade" → "Trades") are read once in a background tab, a plain page
        // load, so the proof can tell a row this save added from one an earlier run left.
        if (proofOn && !listsRead && wants.submit && (isSend || action.type === "fill" || action.type === "type" || action.type === "select")) {
          listsRead = true;
          const links = await page.$$eval("a[href]", (as) => as.map((a) => ({ text: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href })).slice(0, 400)).catch(() => [] as { text: string; href: string }[]);
          const here = urlKey(page.url());
          const lists = [...new Set([o.url, ...listLinks(o.goal, links.filter((l) => sameSite(l.href)))].map(urlKey))].filter((u) => u !== here && safeToReopen(u, sameSite)).slice(0, 3);
          // A separate browser with the run's cookies (the run's own context closes new tabs).
          const state = lists.length ? await page.context().storageState().catch(() => undefined) : undefined;
          const ctx = lists.length ? await browser.newContext({ ...(state ? { storageState: state } : {}), viewport: page.viewportSize() ?? undefined, serviceWorkers: "block", acceptDownloads: false }).catch(() => undefined) : undefined;
          for (const u of ctx ? lists : []) {
            const tab = await ctx!.newPage().catch(() => undefined);
            if (!tab) break;
            try {
              await tab.goto(u, { waitUntil: "load", timeout: 8000 });
              await tab.waitForTimeout(400);
              if (readings.length < 80) readings.push({ seq: proofAt, url: urlKey(tab.url()), text: await readPlain(tab) });
            } catch { /* not read: the proof treats it as first seen after the save */ }
            await tab.close().catch(() => {});
          }
          await ctx?.close().catch(() => {});
        }
        writes?.begin(proofAt);
        // A stored value (an account's, a --var, a code) typed in a run that keeps a video: every text box
        // is masked as dots, seen painted in every frame, before the first key, and the box it goes into
        // stays dots. Where that can't be seen (a frame that can't be read, a box the mask doesn't reach),
        // the card goes up instead, drawn, and stays until no field shows it. Neither: not typed.
        const typing = Boolean(cover) && typesStored(action as { type: string; value?: string; url?: string }, mask.every());
        typingNow = typing;
        if (cover && typing) {
          if (await cover.arm(typesSecret(action as { type: string; value?: string; url?: string }, mask.every()))) typedMasked++;
          else {
            if (!(await cover.show(TYPING_CARD))) {
              await cover.disarm();
              return { error: "a stored value isn't typed now: its box couldn't be masked or the screen covered first (the video would show it)", label: "Typing a stored value" };
            }
            typedCovered++;
            if (!cardUp) o.onCover?.({ up: true, words: TYPING_CARD });
            cardUp = true;
          }
        }
        // The guard knows every value the run holds now (a code read from an email joins them).
        if (cover && !typing) await cover.sync();
        // The card comes down only once the action is over and the page has settled (act waits for it),
        // never while a press is still sending the form: the next page may draw the value again.
        pressedNow = action.type === "press" ? undefined : (target?.name ?? ("target" in action ? (action.target as { name?: string }).name : undefined));
        dialogNotes.length = 0;
        tabs.takeNotes();
        let outcome = await act(ctx, action, target, to).finally(async () => {
          writes?.end();
          lastActionAt = Date.now();
          // The field just typed into is kept by the element itself, whatever found it, and stays dots.
          if (typing) await cover?.markTyped();
          if (typing) await cover?.disarm();
          typingNow = false;
          pressedNow = undefined;
          await cardDown();
        });
        if (proofOn && "done" in outcome) proofActs.push(actOf(proofAt, outcome.done));
        // W4: what a browser box asked and how it was answered, and a window opened or closed, said to the actor.
        const told = [...dialogNotes.splice(0), ...tabs.takeNotes()];
        if (told.length && "done" in outcome) outcome = { ...outcome, note: [outcome.note, ...told].filter(Boolean).join("; ") };
        else if (told.length && "error" in outcome) outcome = { ...outcome, error: `${outcome.error}; ${told.join("; ")}` };
        const liveAfter = "done" in outcome ? await liveNow() : undefined;
        if (liveAfter) return { blocked: liveAfter, label: outcome.label };
        // A "send code" press: a code or link is read only from messages after it.
        if ((ctx.codeSends?.count.n ?? 0) > sendsBefore) lastCodeSend = t;
        // Only what the page took to answer (act measures it: what the action started, a page it went
        // to, a wait asked for), never the tool's own time: an action that failed waited on its timeout.
        if ("done" in outcome) waitedMs += outcome.settledMs ?? Date.now() - t;
        // A value it wouldn't type is the test's want, not the site's: only what the page did counts.
        if ("error" in outcome && !outcome.needs && !/^didn't (type|make up)|^didn't click: .*leads off the site|isn't one it presses/.test(outcome.error)) retried ??= `${lowerFirst(outcome.label)} didn't work the first time`;
        if (!("done" in outcome)) {
          // A press that didn't work (not one refused or held): "it tried to press 'Save' and couldn't".
          const t = target ?? ("target" in action ? (action.target as { role: string; name: string; nth: number }) : undefined);
          if ("error" in outcome && t && (action.type === "click" || action.type === "dblclick") && sendName(t.name) && (!wants.fill || done.some((a) => gives(a)))) triedFailed.push({ type: action.type, target: t } as CachedAction);
          return outcome;
        }
        const d = outcome.done;
        if (fillScan) fillPages.set(formKey(fillScan), fillRecordOf(fillScan, mask));
        // (a "Continue" or "Next" back through a wizard isn't a save: only one named like a save, or Enter)
        if (savePress(d) && (d.type === "press" || SAVE_WORD.test("target" in d ? (d.target?.name ?? "") : ""))) savesPressed++;
        if (isSend) lastSend = { name: clip(mask(pressName), 60), held: heldPreSend, action: d, given: givenSoFar() };
        const unnamed = unnamedControl(d);
        if (unnamed) friction.add("unnamed_control", n, `Had to use ${unnamed} with no accessible name`);
        if (d.type === "click" && closesPopup(d.target.name, dialog)) friction.add("popup", n, mask(`Closed a pop-up${dialog ? ` ('${dialog}')` : ""} with '${d.target.name.slice(0, 40)}'`));
        if (d.type === "press" && dialog && !(await openDialog(page))) friction.add("popup", n, mask(`Closed a pop-up ('${dialog}') with Escape`));
        if (outcome.note && /^the form wasn't sent/.test(outcome.note)) friction.add("validation", n, `The form wasn't sent: ${outcome.note.replace(/^the form wasn't sent: /, "")}`);
        const newErrors = looks ? (await pageErrors(page)).filter((e) => !before.includes(e)) : [];
        for (const said of newErrors) friction.add("validation", n, mask(`The page showed an error: ${said}`));
        if (sends(d) && (/^the form wasn't sent/.test(outcome.note ?? "") || newErrors.length || (page.url() === urlBefore && (await page.locator("input[type=password]:visible").count().catch(() => 0)) > 0))) failedSends.add(d);
        if (d.type === "fill" || d.type === "type") {
          for (const name of placeholderNames(d.value)) {
            const { label, field } = splitName(name);
            if (label) typedAccount = true;
            if (label && field === "totp") typedTotp = true;
            if (label && isPasswordName(name)) typedPassword = true;
          }
          const pw = placeholderNames(d.value).find(isPasswordName);
          if (pw) passwordFor = splitName(pw).label ?? pw;
          // A value typed as itself (not a stored one) beside the password: a refusal may be that value's fault.
          else if (!usesPlaceholder(d.value)) typedOwn = true;
        }
        // A sign-in is sent by a button (or a link acting as one), or Enter: not by a click into a field.
        const sentSignIn = ((d.type === "click" || d.type === "dblclick") && /^(button|link|menuitem|item)$/.test(d.target.role)) || (d.type === "press" && d.key === "Enter");
        if (sentSignIn && passwordFor && !/^the form wasn't sent/.test(outcome.note ?? "")) {
          // A sign-in was sent: counted, and the page read for a refusal (measured, no AI).
          const who = passwordFor;
          const ownWords = typedOwn;
          passwordFor = undefined;
          typedOwn = false;
          guard.submits.set(who, (guard.submits.get(who) ?? 0) + 1);
          const words = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
          const refused = CREDENTIAL_REFUSED.exec(words);
          // Refused with only stored values typed: the stored credential is wrong, and isn't tried again.
          if (refused && !ownWords) {
            guard.rejected.add(who);
            const locked = /locked|blocked|suspended|too many/i.test(refused[0]);
            signInCode = locked ? "AUTH_ACCOUNT_LOCKED_OUT" : "AUTH_CREDENTIAL_INVALID";
            refusedEnd = {
              verdict: "blocked",
              reason: mask(`${signInCode}: the site said "${refused[0]}" after ${who}'s sign-in was sent, so it isn't tried again this run (more tries could lock the account). ${locked ? "Unlock the account, or use another test account." : `Check ${who}'s stored password, then sign in again.`}`),
            };
          } else if (!refused) {
            // "We sent you an email to confirm it's you", with nothing to type: a new-device check. No one is
            // waited for, and the sign-in isn't sent again (each send could mail the person again).
            const device = await deviceCheckOn(page);
            if (device) {
              (guard.deviceCheck ??= new Set()).add(who);
              signInCode = "DEVICE_CHECK";
              refusedEnd = { verdict: "blocked", reason: mask(`DEVICE_CHECK: the site said "${device}" after ${who}'s sign-in was sent: it asks to confirm a new device, which a run never waits for, so it isn't sent again`), blockedGroup: "credentials" };
            }
          }
        }
        if (sentSignIn) typedOwn = false;
        return outcome;
      };

      // The check, measured before anything is done: one that already holds proves little, and says so.
      const check = withVars(planned.check, lookup);
      const heldBefore = planned.check.kind !== "none" && planned.check.kind !== "judged" && (await verify(page, check, 0)).ok;
      /** This step was passed by a second opinion: its saved check is the judged claim, never the guess it overruled. */
      let judgedClaim: string | undefined;
      const failedEnd = (v: Verified, why?: string): End => ({ verdict: "failed", reason: mask(`the check didn't hold: ${v.expected}${why ? ` (${why})` : ""}`), evidence: { expected: mask(v.expected), found: mask(v.found) } });
      /**
       * A step that did nothing but wait, whose check already held before it, measured nothing it did:
       * that is never a pass, whoever says done (a "Buy" step on a page that already shows its check's words).
       * Nor is one whose intent the browser would refuse (buy, pay, delete…) that did nothing at all.
       */
      const provedNothing = (): string | undefined => {
        // A draft's first run says it its own way, below.
        if (!heldBefore || done.some((a) => a.type !== "wait") || (replay && !planned.actions)) return undefined;
        const unsafe = refusedName(`${base.title} ${base.intent}`);
        if (!done.length && !unsafe) return undefined;
        return mask(`nothing was done in this step${done.length ? " but waiting" : ""}, and its check (${expected(check)}) already held before it, so it proves nothing`);
      };
      const passedEnd = (): End => {
        const nothing = provedNothing();
        if (nothing) return { verdict: "not_sure", reason: nothing };
        const words = "text" in planned.check && planned.check.text ? norm(planned.check.text) : "";
        // A check on words the test itself typed or went to holds without the site doing anything.
        // Words typed by a step on the way with no check of its own (a search) count as this step's too.
        const own = words && [...carried, ...done].some((a) => ((a.type === "fill" || a.type === "type") && (norm(a.value).includes(words) || (planned.check.kind === "url_contains" && typedInUrl(planned.check.text, a.value)))) || (a.type === "navigate" && planned.check.kind === "url_contains" && norm(a.url).includes(words)));
        // A step that did something must change what its check sees; one that only looks, what the test began with.
        const weak = (planned as SavedStep).assert && !done.length ? undefined : (done.length ? heldBefore : atStart[i]) ? `its check already held before ${done.length ? "the step" : "the test"}, so it proves little` : own ? "the test typed its check's words itself, so it proves little" : undefined;
        // A step that saves or submits, checked by something that already showed before it pressed save
        // (the form's own words, a wizard's subtitle): that shows nothing the save did. Decision 4.
        if (wants.submit && EARLY_CHECKS.has(planned.check.kind) && done.length && (heldBefore || lastSend?.held)) {
          const when = lastSend?.held ? `before '${lastSend.name}' was pressed` : "when the step began";
          return { verdict: "not_sure", reason: mask(`its check (${expected(check)}) already held ${when}, so it shows nothing the save did: a step that saves needs a check of what the save shows (a message, the new entry in its list, its own page)`) };
        }
        // W4: a file the page built itself (a blob: or data: address, not sent by the server) is the
        // page's own words: one holding words the test typed shows nothing was saved. NOT SURE.
        if (planned.check.kind === "download_contains") {
          const file = downloadsOf(page)?.holding(planned.check.text);
          const has = (t: string) => norm(t).length >= 3 && (norm(t).includes(words) || words.includes(norm(t)));
          const typedAt = [...typedInRun, ...typedHere().map((value) => ({ value, at: t0 }))].filter((t) => has(t.value)).map((t) => t.at);
          // Typed by the test, and nothing was ever sent to the site after: the page's own memory.
          if (file?.fromPage && typedAt.length && !(siteWriteAt > Math.min(...typedAt))) return { verdict: "not_sure", reason: mask(`the file (${file.name}) was made by the page itself, not sent by the server, and it holds words the test typed, with nothing sent to the site after they were typed: it shows what the page holds, not that anything was saved`) };
          if (file?.fromPage && !weak) return { verdict: "passed", weak: "the page made the file itself (the server didn't send it), so it proves only what the page shows" };
        }
        return { verdict: "passed", ...(weak ? { weak } : {}) };
      };
      // The AI gave up, or the budget ran out: the check is still measured. It not holding is a
      // measured FAIL, with its evidence; only what can't be measured stays "not sure".
      const giveUp = async (why: string): Promise<End> => {
        if (planned.check.kind === "none" || planned.check.kind === "judged") return { verdict: "not_sure", reason: mask(why) };
        const v = await verify(page, check, 0);
        return v.ok ? { verdict: "not_sure", reason: mask(`${why}; its check holds, but the step wasn't finished`) } : failedEnd(v, why);
      };
      /** A bot check the page shows now, waited on; one that stays ends the step BLOCKED. */
      const wallNow = async (): Promise<End | undefined> => {
        const check = await standsNow(page);
        if (!check) {
          // E10: a new page's protections are named as the run meets them, blocking or not.
          if (page.url() !== namedAt) await named(page, n, recording.at());
          return undefined;
        }
        const fs = await named(page, n, recording.at());
        return metCheck(check, n, fs);
      };
      /** A safety stop: a bot check's own control ("Press & Hold") that wasn't pressed is the wall, said as such. */
      const blockedBy = (why: string): End => {
        if (heldEnd) return heldEnd;
        if (why.endsWith(CHALLENGE_REFUSED)) return metWall(A_CHALLENGE, n);
        // A code or link that couldn't be had (C19): no message while the inbox answered is the app's
        // FAIL; an inbox that didn't answer is BLOCKED; a message whose code isn't certain, not sure.
        const code = /^(CODE_NOT_RECEIVED|CODE_SOURCE_UNAVAILABLE|CODE_NOT_SURE|CODE_NEEDS_PERSON|SMS_CODE_NEEDED|TEST_CODE_NOT_ALLOWED): /.exec(why)?.[1] as Fresh extends infer F ? (F extends { code: infer C } ? C : never) : never;
        if (code) {
          signInCode = code;
          // A code that went to the person's own inbox or phone (a text too): no one is waited for, so BLOCKED, never a pass.
          if (code === "CODE_NEEDS_PERSON" || code === "SMS_CODE_NEEDED" || code === "TEST_CODE_NOT_ALLOWED") return { verdict: "blocked", reason: mask(why), blockedGroup: "credentials" };
          return { verdict: code === "CODE_NOT_RECEIVED" ? "failed" : code === "CODE_NOT_SURE" ? "not_sure" : "blocked", reason: mask(why) };
        }
        return { verdict: "blocked", reason: mask(why) };
      };
      /** What this step (and the steps on the way it carries) typed: a judge's quote of only these proves nothing. */
      const typedHere = () => [...carried, ...done].flatMap((a) => (a.type === "fill" || a.type === "type" ? [a.value] : []));
      const measure = async (): Promise<End | Verified> => {
        const off = offSite();
        if (off) return { verdict: "blocked", reason: mask(off) };
        const wall = await wallNow();
        if (wall) return wall;
        if (planned.check.kind === "judged") {
          // Judged, not measured: one ask of the judge, never retried, its pass always labelled.
          let j = await judgeNow(planned.check.claim, n, typedHere(), judgedBefore);
          if (j.verdict === "fails") {
            // The page may still be finishing what the step started (a total worked out, a list
            // loading), as a measured check is waited on: a page that changes within the check's wait
            // is judged once more. One that doesn't change keeps its "fails".
            const w = await waitForChange({ signature: pageSignature(page), everyMs: 250, maxMs: o.checkWaitMs ?? (o.visitor ? VISITOR_CHECK_WAIT_MS : CHECK_WAIT_MS), ...(o.signal ? { signal: o.signal } : {}) });
            if (w.end === "changed") j = await judgeNow(planned.check.claim, n, typedHere(), judgedBefore);
          }
          if (j.verdict === "holds") return { ...passedEnd(), judged: { by: "check", reason: j.reason, image: j.image } };
          if (j.verdict === "fails") return { verdict: "failed", reason: mask(`the AI judge said the claim doesn't hold: "${planned.check.claim}"`), evidence: { expected: mask(planned.check.claim), found: j.reason } };
          return { verdict: "not_sure", reason: j.reason };
        }
        emit({ type: "working", n, words: mask(`Checking ${expected(check)}`), at: recording.at() });
        const t = Date.now();
        const v = await verify(page, check, o.checkWaitMs ?? (o.visitor ? VISITOR_CHECK_WAIT_MS : undefined));
        // A check that held after a wait waited on the page; one that never held waited on its own timeout.
        if (v.ok) waitedMs += Date.now() - t;
        // An address or title that holds on a page saying it isn't there ("Symbol not found") proves
        // nothing the goal asked: not sure, never a pass (unless the goal is about such a page).
        if (v.ok && (planned.check.kind === "url_contains" || planned.check.kind === "title_contains") && !NOT_FOUND.test(`${o.goal} ${planned.check.text}`)) {
          // Said in its title or heading (a bare 404 status, as a form posted to a stub, isn't enough).
          const gone = await notFound(page, { status: false });
          if (gone) return { verdict: "not_sure", reason: mask(`its check holds (${expected(check)}), but the page says "${clip(gone, 80)}"`) };
        }
        return v.ok ? passedEnd() : v;
      };

      /**
       * W1-D2: the planner's own guessed check on the last step didn't hold, though the step's actions
       * finished (the actor said done, or stuck on that check). The judge is asked once, with the goal's
       * words; only a "holds" with quotes found on the page passes it, labelled, with the check it overruled.
       */
      const secondLook = async (failed: End): Promise<End> => {
        if (failed.verdict !== "failed" || !failed.evidence || secondAsked || !o.brain?.judge) return failed;
        // The person's own check (an Assert step, or a card they edited) is never overruled.
        if ((planned as SavedStep).assert || o.ownChecks?.includes(i)) return failed;
        if (!secondOpinionWanted({ check: planned.check, last: i === plan.length - 1, failedOnCheck: true, ownActions: !planned.actions && !healFrom && !subs.some((x) => x.blocked), measuredOnly, goal: o.goal, ...(o.given ? { given: o.given } : {}) })) return failed;
        secondAsked = true;
        const claim = secondOpinionClaim(o.goal);
        const j = await judgeNow(claim, n, typedHere(), judgedBefore);
        if (j.verdict !== "holds") return { ...failed, reason: `${failed.reason ?? ""}. An AI judge also looked: ${j.reason}` };
        judgedClaim = claim;
        return { verdict: "passed", judged: { by: "second opinion", reason: j.reason, image: j.image, overruled: `the planned check didn't hold: ${failed.evidence.expected} (${failed.evidence.found})` } };
      };

      // Replay: each saved action as it was; a missing element hands the rest of the step to the AI.
      let needAi = !planned.actions;
      /** The saved actions all worked but stop short of what the step says: what is left, for the AI (or the reason with none). */
      let unfinished: string | undefined;
      /** A saved element that has gone, or a saved action that no longer worked, in a person's words. */
      let missing: string | undefined;
      const heal = !o.noHeal && Boolean(o.brain);
      if (planned.actions) {
        for (const [k, saved] of planned.actions.entries()) {
          if (o.signal?.aborted) {
            stopped = STOPPED_BY_YOU;
            end = { verdict: "not_sure", reason: STOPPED_BY_YOU };
            break;
          }
          const target = "target" in saved ? saved.target : undefined;
          if (target) {
            const looked = Date.now();
            // Found again by its saved identity, waited for a little; one that more (or fewer) now match
            // than when it was saved is never clicked by its place alone: it is healed, or not sure.
            let why = "";
            let found = false;
            while (!found) {
              const r = await locateSaved(page, target, rules);
              if ("el" in r) found = await r.el.first().waitFor({ state: "attached", timeout: Math.max(250, 3000 - (Date.now() - looked)) }).then(() => true, () => false);
              else why = r.ambiguous ? r.missing : "";
              if (found || Date.now() - looked >= 3000) break;
              await page.waitForTimeout(250);
            }
            // Waiting for an element that has gone is the test's, not the page's.
            if (found) waitedMs += Date.now() - looked;
            if (!found && o.storageState && (await signedOutNow(page, o.signInPath))) {
              // Gone because the session is: not healed (that would ask the AI to sign in), said as expired.
              sessionExpired = true;
              end = { verdict: "not_sure", reason: mask(`the saved session has expired: the site sent the test to sign in (${shortAddress(page.url())})`) };
              break;
            }
            if (!found) {
              missing = `${labelOf(saved, mask)}${why ? ` (${mask(why)})` : ""}`;
              emit({ type: "healing", n, missing, ai: heal });
              healFrom = planned.actions.slice(k);
              healStart = done.length;
              needAi = true;
              break;
            }
          }
          // A saved save pressed while the form says it isn't complete ("1 still open") with fields a real
          // user would fill still empty (recorded before the nudge): the rest of the step is handed to the
          // AI once, as for a saved element that has gone, so the record is made whole. With no AI, it replays.
          if (heal && wants.submit && !o.saveStateTo && (saved.type === "click" || saved.type === "dblclick" || saved.type === "press")) {
            const pa = pressOf(saved.type, saved.type === "press" ? saved.key : undefined, "target" in saved ? saved.target : undefined);
            const scan = pressCandidate(pa) ? await scanFor(saved) : undefined;
            if (scan) preScan = { action: saved, scan };
            const left = scan && scan.status.length && !scan.signIn && !scan.search && sendsForm(scan, pa) && !refusedAnyway(pa.type === "press" ? String(pa.key) : (pa.target?.name ?? ""), scan) ? shownFields(scan).empty.length : 0;
            if (scan && left) {
              preScan = undefined;
              missing = mask(`the rest of the record: the form still said "${clip(scan.status[0]!, 60)}" with ${left} field${left === 1 ? "" : "s"} a real user would fill still empty at its save`);
              emit({ type: "healing", n, missing, ai: heal, unfinished: true });
              healFrom = planned.actions.slice(k);
              healStart = done.length;
              needAi = true;
              break;
            }
          }
          const outcome = await tracked(saved);
          actions++;
          if ("blocked" in outcome) {
            stoppedBefore(outcome.label, true);
            end = blockedBy(outcome.blocked);
            break;
          }
          if ("error" in outcome) {
            note({ label: outcome.label, at: recording.at(), error: mask(outcome.error), cached: true });
            missing = outcome.label;
            healFrom = planned.actions.slice(k);
            healStart = done.length;
            emit({ type: "healing", n, missing: outcome.label, ai: heal });
            needAi = true;
            break;
          }
          note({ label: outcome.label, at: recording.at(), cached: true });
          done.push(outcome.done);
          if (refusedEnd) {
            end = refusedEnd;
            break;
          }
          const wall = await wallNow();
          if (wall) {
            end = wall;
            break;
          }
        }
        // Every saved action worked, but they stop short of what the step says (recorded under older
        // rules: "fill in… and save" with only a click on "Add trade"): the rest of the step is handed to
        // the AI, as for a saved element that has gone, never ended with nothing more tried. It can still
        // only pass under every rule a fresh step has (values typed, a save pressed, the check after it).
        const short = !end && !needAi ? shortfall() : undefined;
        if (short && !short.tried) {
          unfinished = short.why;
          missing = `what is left of this step (${short.why.replace(/^its intent/, "its words")})`;
          emit({ type: "healing", n, missing, ai: heal, unfinished: true });
          healFrom = [];
          healStart = done.length;
          needAi = true;
        }
        if (!end && !needAi) {
          const m = await measure();
          end = "verdict" in m ? m : failedEnd(m);
        }
      }

      // An Assert card not run before: measured first, where the step before left the page. When it
      // holds, nothing is asked of the AI; when it doesn't, the AI is asked as for any draft step.
      if (!end && needAi && (planned as SavedStep).assert && !planned.actions && !offSite() && (await verify(page, check, Math.min(o.checkWaitMs ?? 3000, 3000))).ok) {
        const m = await measure();
        if ("verdict" in m) end = m;
      }
      // Fresh (or healing): one action at a time, chosen by the AI from what is on the page now.
      if (!end && needAi) {
        if (!o.brain || (o.noHeal && planned.actions)) {
          end = unfinished
            ? { verdict: "not_sure", reason: mask(`its saved actions worked, but the step didn't do all it says: ${unfinished}; ${o.noHeal && o.brain ? "a test run on another address (--url) isn't healed or planned again" : staleAt.has(i) ? staleSays : "an AI is needed to finish it (run it with --ai)"}`) }
            : { verdict: "not_sure", reason: !planned.actions ? DRAFT_NO_AI : o.noHeal ? `can't find ${missing ?? "a saved element"}; a test run on another address (--url) isn't healed` : `can't find ${missing ?? "a saved element"}; no AI to find another way (--ai)` };
        }
        const history: string[] = [];
        /** Looks taken in this step, for the second look's shorter rest of the page. */
        let looks = 0;
        // Finishing a step whose saved actions stopped short: the AI is told first what is left to do.
        let problem: string | undefined = unfinished ? mask(shortfallProblem(unfinished)) : undefined;
        let unusable = 0;
        let checkRetried = false;
        let own = 0;
        /**
         * A long form: each field filled for the first time in the step gives its turn back (and its
         * place in the run's actions), up to FORM_TURNS times the step's budget: a step that fills in
         * every field a form shows (fill.ts) isn't cut short by the form's size. Each is a distinct field
         * filled once, so it can't run away.
         */
        const filledFields = new Set<string>();
        let formTurns = 0;
        /** A wizard: each address the step reaches for the first time by a press gives that turn back too, up to the step's budget again. */
        const reached = new Set<string>([mask(withoutSecrets(page.url()))]);
        let pageTurns = 0;
        let waits = 0;
        /** Waits asked for in this step: the first on a settled page is cut short sooner than a later one. */
        let stepWaits = 0;
        /** The page's signature when the AI last looked. */
        let seenSig: string | undefined;
        /** Required fields were filled with made-up values once, when the AI was stuck on missing values. */
        let autoFilled = false;
        /** The last refusal the page showed in this step (a role=alert's words), and this step's recovery tries. */
        let stepRefusal: string | undefined;
        /** savesPressed when stepRefusal was last seen: a save pressed after it, with no refusal on the next look, clears it. */
        let refusalAtSave = 0;
        const tries: Recovery[] = [];
        /**
         * After the actor gives up (stuck, or a done whose check didn't hold) on a form the site refused for a
         * reason it explained: one more bounded try with another option the form offers, or BLOCKED with
         * SEED_DATA_MISSING when it has none, or nothing (the step ends as before). Never a pass.
         */
        const recover = (): ReturnType<typeof recoveryFor> => {
          if (actions >= maxActions) return undefined;
          const plan = recoveryFor({ alerts: stepRefusal ? [stepRefusal] : [], choices, submitted: Boolean(lastSend) || done.some((a) => savePress(a)), tried: tries, goal: mask(o.goal), ...(notes ? { notes } : {}), ...(o.ownedHost ? { ownedHost: true } : {}), ...(lastSend ? { sendName: lastSend.name } : {}), max: MAX_RECOVERIES });
          if (plan?.kind === "try" && !plan.again) {
            tries.push(plan.recovery);
            const { reminded: _r, ...kept } = plan.recovery;
            recoveries.push({ step: n, ...kept });
            history.push(tryLine(plan.recovery, tries.length, MAX_RECOVERIES));
            // Room to go back, change it and save again (each try at most 4 turns; the run's budget still holds).
            own = Math.max(0, own - 4);
            note({ label: mask(`The site refused it: trying another '${plan.recovery.control}' (try ${tries.length} of ${MAX_RECOVERIES})`), at: recording.at() });
            emit({ type: "working", n, words: mask(`The site refused the form: trying another '${plan.recovery.control}'`), at: recording.at() });
          }
          return plan;
        };
        /** The last actions, for the loop guards; the one just done, said with what it changed at the next look. */
        const ring: Turn[] = [];
        let pending: { at: number; turn: Turn } | undefined;
        /** Guards that have warned the actor once in this step: the next time ends it. */
        const warned = new Set<string>();
        /** The actor has had its one picture in this step. */
        let picturedStep = false;
        /** W5: a picture came with the latest ask (each ask is on its own: the AI sees a picture only with the ask it came with), so a point press (click_at) from that answer is in it. */
        let pointOk = false;
        /** W5: a point press just worked: what it drew shows only in a picture, so the next ask may have one more. */
        let pointAgain = false;
        /** W5: the AI said stuck once in this step and was shown a picture for it (decision J): never twice. */
        let stuckPictured = false;
        /** W5: a picture taken for the next ask. */
        let forcedImage: ImageInput | undefined;
        /** E4: the actions the AI said come next (`then`), and the address it was looking at when it said so. */
        let queue: Action[] = [];
        let queuedAt = "";
        let queuedRefs: Snapshot["refs"] | undefined;
        while (!end) {
          if (o.signal?.aborted) {
            stopped = STOPPED_BY_YOU;
            end = { verdict: "not_sure", reason: STOPPED_BY_YOU };
            break;
          }
          if (Date.now() > deadline) {
            stopped = `the ${o.minutes ?? DEFAULTS.minutes}-minute limit was reached`;
            end = await giveUp(`stopped: ${stopped}`);
            break;
          }
          if (actions >= maxActions) {
            stopped = `all ${maxActions} actions were used`;
            end = await giveUp(`stopped: ${stopped} (--max-actions)`);
            break;
          }
          if (own >= maxPerStep) {
            end = await giveUp(`${maxPerStep} actions weren't enough to finish this step`);
            break;
          }
          emit({ type: "working", n, words: "Capturing page snapshot", at: recording.at() });
          const before = lastSnap;
          // A second look in the step at the same page sends less of the rest of it (what is open, new
          // and on screen is chosen as ever): only what is shown can be used, and the cut is said.
          // E4: so does the first look of a step on the page the AI was last asked about, in the step before.
          const again = (looks > 0 || askedOn === mask(withoutSecrets(page.url()))) && before !== undefined && before.url === mask(withoutSecrets(page.url()));
          const snap = await observe(page, mask, lastSnap, SNAPSHOT_CHARS, { onSite: sameSite, ...(again ? { restCap: REST_AGAIN_CHARS } : {}) });
          // The page as the AI saw it: a wait it asks for ends at once if the page changed since (waitfor.ts).
          seenSig = await pageSignature(page)().catch(() => undefined);
          looks++;
          lastSnap = snap;
          for (const c of choicesIn(snap.text)) choices.set(c.label, c);
          // The site's refusal stands while the page shows it, and after the actor goes a page back to change
          // the form; once a save is pressed again and the next look shows no refusal, it took: never a
          // second try (and a second save) after a save that worked.
          const refusedNow = refusalIn(snap.alerts);
          if (refusedNow) {
            stepRefusal = refusedNow;
            refusalAtSave = savesPressed;
          } else if (stepRefusal && savesPressed > refusalAtSave) stepRefusal = undefined;
          // A try's new value, as the form shows it after the actor changed it.
          const lastTry = tries.at(-1);
          if (lastTry && lastTry.to === undefined) {
            const now = choices.get(lastTry.control)?.selected;
            if (now && now !== lastTry.from) {
              lastTry.to = now;
              const rec = recoveries.at(-1);
              if (rec) rec.to = now;
            }
          }
          // What the last action changed, said after it in the history (C5), and what the guards count.
          if (pending) {
            if (pending.turn.result === "ok" && before) {
              const said = changeOf(before, snap);
              history[pending.at] = `${history[pending.at]} ${said}`;
              pending.turn.result = said === "→ no change on the page" ? "no change" : "changed";
              if (said.startsWith("→ went to ") && POINTER_TURNS.has(pending.turn.type) && !reached.has(snap.url) && pageTurns < maxPerStep) {
                reached.add(snap.url);
                own--;
                pageTurns++;
              }
            }
            // A queued try that didn't work (an error, no change, or only focus on the control pressed): the
            // rest of the queue is dropped and the AI asked, so the stop-after-tries guard (which reads the
            // history when it is asked) counts each try, as with one action an ask.
            if (failedLine(history[pending.at] ?? "")) queue = [];
            const fired = loopGuard(ring);
            pending = undefined;
            if (fired && warned.has(fired.guard)) {
              // The planner's guessed check on the last step, going round on it: the same one second
              // opinion as a "done" or "stuck" gets (fx-dupes: it kept going back off the right page).
              end = await secondLook(await giveUp(fired.ends));
              break;
            }
            if (fired) {
              warned.add(fired.guard);
              problem = problem ? `${problem} ${fired.says}` : fired.says;
            }
          }
          // The wind-down: the last turns are said, and the very last may only conclude.
          // (A budget of 1 or 2, a test's, has no room for one.)
          const turnsLeft = maxPerStep >= 3 ? maxPerStep - own : Infinity;
          const lastTurn = turnsLeft <= 1;
          if (turnsLeft === 2) problem = `${problem ? `${problem} ` : ""}You have 2 turns left in this step: one more action, then you must say done or stuck.`;
          if (lastTurn) problem = `${problem ? `${problem} ` : ""}This is your last turn in this step: say done if its intent is achieved, or stuck. Any other action ends the step.`;
          let action: Action;
          // E4: the next of the actions the AI gave last time, without asking again, when nothing has
          // come up since (a problem, a guard, the wind-down), the page is where it was, and it still
          // fits this look. Otherwise what is left of them is dropped and the AI is asked.
          const next = queuedNext(queue, queuedAt, snap, Boolean(problem) || turnsLeft <= 2, { refs: queuedRefs, measured: planned.check.kind !== "none" && planned.check.kind !== "judged" });
          queue = next ? queue.slice(1) : [];
          if (next) {
            action = next;
            emit({ type: "working", n, words: "Doing the next action the AI gave", at: recording.at() });
          } else {
            emit({ type: "working", n, words: "Asking the AI for the next action", at: recording.at() });
            try {
              // Every word here is masked: no --var value reaches the AI, not even in what went wrong.
              // A picture only when the outline can't show what the step needs (a chart, a canvas), at most one a
              // step, and on a page it can act on from the outline, only once the step has done something:
              // what the action drew is what the outline can't show ("→ no change on the page").
              const about = `${planned.title} ${planned.intent} ${planned.check.kind === "judged" ? planned.check.claim : ""}`;
              // W5: an outline that contradicts the step is pictured on its first look too (decision J).
              const image = forcedImage ?? (pointAgain ? await pictureFor(snap, about, n, "actor", true) : undefined) ?? (forcedImage || pointAgain || picturedStep || (looks === 1 && snap.usable.size > 0 && !outlineContradicts(snap, about)) ? undefined : await pictureFor(snap, about, n, "actor"));
              pointAgain = false;
              forcedImage = undefined;
              if (image) picturedStep = true;
              pointOk = Boolean(image);
              const input = { goal: mask(o.goal), step: { title: base.title, intent: base.intent, check: planned.check }, n, of: plan.length, url: snap.url, title: snap.title, snapshot: snapText(snap), history, vars: o.noMedia || typesVar ? typeNames : [], ...(problem ? { problem: mask(problem) } : {}), ...(image ? { image } : {}), ...(o.place ? { place: o.place } : {}), ...(notes ? { notes } : {}) };
              const many = o.brain!.decideMany ? await o.brain!.decideMany(input) : [await o.brain!.decide(input)];
              action = many[0]!;
              // W5: nothing is queued after a point press, nor is a point press queued: each is asked with its own picture.
              queue = action.type === "click_at" ? [] : many.slice(1);
              const pointAt = queue.findIndex((a) => a.type === "click_at");
              if (pointAt >= 0) queue = queue.slice(0, pointAt);
              queuedAt = snap.url;
              queuedRefs = snap.refs;
              askedOn = snap.url;
            } catch (error) {
              end = { verdict: "not_sure", reason: `the AI didn't answer: ${mask(message(error))}` };
              break;
            }
          }
          problem = undefined;
          if (lastTurn && action?.type !== "done" && action?.type !== "stuck") {
            end = await giveUp(`${maxPerStep} actions weren't enough to finish this step (its last turn didn't conclude)`);
            break;
          }
          // (An address off the site is left to the browser's own block, which says so.)
          problem = actionProblem(action, snap) ?? (action.type === "click_at" && !pointOk ? NO_PICTURE_POINT : undefined) ?? (action.type === "navigate" && !sameSite(absolute(action.url, page.url())) ? undefined : checkGaming(action, planned, o.goal));
          // W5: never a point press on a page with a human check (a captcha box, a puzzle, a slider): it
          // could answer it. Read only; the check itself is never touched.
          if (!problem && action.type === "click_at") {
            const fs = await named(page, n, recording.at()).catch(() => [] as ProtectionFinding[]);
            const w = fs.find((x) => WIDGET_KINDS.includes(x.kind) || x.kind === "unknown_captcha");
            if (w || HUMAN_CHECK_WORDS.test(snap.text)) problem = `${NO_POINT_HUMAN_CHECK}${w ? ` (${w.name})` : ""}`;
          }
          // Once the site has refused the form in this step, a recovery never picks an option that costs money
          // (a "(Pro)" option opens a paywall) or creates something the goal and the person's notes don't ask for.
          if (!problem && (stepRefusal || tries.length)) {
            // A select's value, or a click on a radio button or a list's option (a custom listbox): the same rule.
            const picked = action.type === "select" ? String(action.value ?? "") : action.type === "click" ? (() => {
              const el = snap.refs.get(action.ref);
              return el && /^(option|radio|menuitemradio|menuitem|treeitem|tab)$/.test(el.role) ? el.name : undefined;
            })() : undefined;
            if (picked) problem = optionProblem(picked, { goal: mask(o.goal), ...(notes ? { notes } : {}) });
          }
          if (problem) {
            if (++unusable >= 2) end = { verdict: "not_sure", reason: mask(`the AI's answers couldn't be used: ${problem}`) };
            continue;
          }
          if (action.type === "stuck") {
            // Stuck for want of a value the goal didn't give: the required fields left empty get plainly
            // made-up test values, once, and the AI goes on. A password or a card is never made up.
            if (!autoFilled && MISSING_VALUES.test(String(action.why ?? "")) && actions < maxActions) {
              autoFilled = true;
              const filled = await fillRequired(ctx, snap, madeUp);
              for (const n of filled.needs) needs.add(n);
              if (filled.needs.length) sinceNeed = 0;
              const did: string[] = [];
              for (const outcome of filled.outcomes) {
                actions++;
                if ("blocked" in outcome) {
                  stoppedBefore(outcome.label);
                  end = blockedBy(outcome.blocked);
                  break;
                }
                if ("error" in outcome) {
                  if (outcome.needs) {
                    needs.add(outcome.needs);
                    sinceNeed = 0;
                  }
                  note({ label: outcome.label, at: recording.at(), error: mask(outcome.error) });
                  continue;
                }
                // (the made-up fills of the same form don't count as going on past what it wouldn't make up)
                note({ label: outcome.label, at: recording.at() });
                done.push(outcome.done);
                if (proofOn) proofActs.push(actOf(proofSeq++, outcome.done));
                did.push(outcome.label);
              }
              if (end) break;
              if (did.length) {
                history.push(...did);
                problem = `You said stuck (${clip(mask(String(action.why ?? "")), 120)}). The browser filled the required empty fields with made-up test values: ${did.join("; ")}. Carry on with the step.`;
                continue;
              }
            }
            // E10: stuck in front of a captcha box no one has passed: that box is why, said as BLOCKED with its name.
            const boxed = await widgetStands();
            if (boxed) {
              end = boxed;
              break;
            }
            // Stuck after the site refused the form for a reason it explained: another option of the form, or SEED_DATA_MISSING.
            const rec = recover();
            if (rec?.kind === "try") {
              problem = mask(`You said stuck (${clip(mask(String(action.why ?? "")), 120)}). ${rec.says}`);
              continue;
            }
            if (rec?.kind === "seed") {
              signInCode ??= "SEED_DATA_MISSING";
              end = { verdict: "blocked", blockedGroup: "setup", reason: mask(rec.reason) };
              break;
            }
            // W5 (decision J): stuck where the outline doesn't show what the step needs (a choice drawn on a
            // canvas, words in a picture): one picture of the screen, once a step, and the AI is asked again.
            if (!needs.size && !pointOk && !stuckPictured && own < maxPerStep - 1 && !HUMAN_CHECK_WORDS.test(`${String(action.why ?? "")}\n${snap.text}`)) {
              stuckPictured = true;
              const about = `${planned.title} ${planned.intent}`;
              forcedImage = await pictureFor(snap, about, n, "actor", true);
              if (forcedImage) {
                problem = "You said stuck. A picture of the screen comes with the page now: if what you need is drawn there (on a canvas, a map, a chart or a picture) with no number in the snapshot, use it (click_at {x, y, what} presses a point of it); if it isn't there either, say stuck again.";
                continue;
              }
            }
            const why = `the AI was stuck: ${clip(mask(String(action.why ?? "")), 300)}`;
            end = await giveUp(needs.size ? `${why}; ${needWords()}` : why);
            // Stuck because the planner's guessed check can't hold on the page the step reached (the
            // TradingView case): the same one second opinion. Never when it was stuck for a value it needs.
            if (!needs.size) end = await secondLook(end);
            break;
          }
          if (action.type === "done") {
            const m = await measure();
            // The check holds, but the step's intent isn't done (nothing typed, or no save after the
            // typing): the AI is told once what is left. Said again, the step ends (the guard after the loop).
            const short = "verdict" in m && m.verdict === "passed" && !toldShort && own < maxPerStep - 1 ? shortfall() : undefined;
            if (short) {
              toldShort = true;
              problem = mask(shortfallProblem(short.why));
              continue;
            }
            if (!("verdict" in m)) {
              const rec = recover();
              if (rec?.kind === "try") {
                problem = mask(`You said done, but the check didn't hold: expected ${m.expected}; found ${m.found}. ${rec.says}`);
                continue;
              }
              if (rec?.kind === "seed") {
                signInCode ??= "SEED_DATA_MISSING";
                end = { verdict: "blocked", blockedGroup: "setup", reason: mask(rec.reason) };
                continue;
              }
            }
            if ("verdict" in m) end = m;
            else if (!checkRetried && own < maxPerStep - 1) {
              // Said done too soon, maybe: told what was measured, once. It still can't make the check pass.
              checkRetried = true;
              problem = `You said done, but the check didn't hold: expected ${m.expected}; found ${m.found}. Keep going if there's more to do, or say stuck.`;
            } else end = await secondLook(failedEnd(m));
            continue;
          }
          if (action.type === "wait") {
            if (waits >= MAX_WAITS) {
              // Waiting on a page that already shows what the step checks for is a "done" the AI
              // didn't say: the measured check decides, and passedEnd still flags one that proves little.
              if (planned.check.kind !== "none" && (await verify(page, check, 0)).ok) {
                note({ label: "The AI kept waiting, but the check already holds", at: recording.at() });
                end = passedEnd();
              } else end = await giveUp(`the AI kept waiting and nothing came of it`);
              break;
            }
            waits++;
            // E5 waitFor: the browser waits, reading the page every 3 s with no AI, and asks the AI again
            // only when the page changed, the step's check holds, or the wait is used up.
            emit({ type: "working", n, words: "Waiting for the page to change", at: recording.at() });
            const maxMs = Math.max(1, Math.min(o.waitMaxMs ?? WAIT_MAX_MS, deadline - Date.now()));
            const w = await waitForChange({ signature: pageSignature(page), ...(planned.check.kind !== "none" ? { holds: async () => (await verify(page, check, 0)).ok } : {}), ...(o.signal ? { signal: o.signal } : {}), maxMs, everyMs: Math.min(POLL_MS, maxMs), quiet: network.quiet, settledMs: stepWaits++ ? SETTLED_AGAIN_MS : SETTLED_WAIT_MS, ...(seenSig ? { seen: seenSig } : {}) });
            const waited: CachedAction = { type: "wait", ms: Math.min(w.ms, WAIT_MAX_MS) };
            const label = labelOf(waited, mask);
            note({ label, at: recording.at() });
            done.push(waited);
            // Said as any action is: what the page did by the next look is added to it ("→ no change on the page").
            history.push(label);
            const turn: Turn = { key: "wait", type: "wait", label, keys: snap.keys, screen: snap.screen, result: "ok" };
            ring.push(turn);
            if (ring.length > RING) ring.shift();
            pending = { at: history.length - 1, turn };
            if (w.end === "timeout") problem = waitWords(w);
            continue;
          } else waits = 0;
          // Going back off the page the last step's own action led to, because the planner's guessed
          // check didn't hold there: the second opinion looks at that page first (once). Only a "holds"
          // with quotes from the page passes; otherwise the actor goes back as it asked.
          if (action.type === "back" && i === plan.length - 1 && done.length > 0 && !secondAsked && planned.check.kind !== "none") {
            const v = await verify(page, check, 0);
            if (!v.ok && !offSite() && !(await standsNow(page))) {
              const e = await secondLook(failedEnd(v));
              if (e.verdict === "passed") {
                end = e;
                break;
              }
            }
          }
          // Typing goes to what has focus: the element the look said had it, when it has a number (so it is saved).
          const target = "ref" in action && action.ref ? snap.refs.get(action.ref) : action.type === "type" && snap.focusRef ? snap.refs.get(snap.focusRef) : undefined;
          // W4: a drag named by words has no element of the snapshot (its words go on as they are).
          // The same element named again is the same action, whatever number it had.
          const key = target ? `${action.type}\n${target.role}\n${target.name}\n${target.nth}\n${"value" in action ? action.value : ""}` : JSON.stringify(action);
          // Fill like a real user (fill.ts): in a step that makes a record, typing into a box for another
          // purpose (a search, a "nearest …" finder, a code, one whose note says it isn't part of the record)
          // that the goal and step don't name is held once, and the actor is told to leave it. Never a verdict.
          if (action.type === "fill" && target && wants.submit && createsHere && !o.saveStateTo) {
            const me = (await scanFor(action))?.fields.find((f) => f.self);
            const label = me?.label || target.name;
            if (me && forAnotherPurpose(me) && !asideHeld.has(label.toLowerCase()) && !namedIn(label, `${o.goal} ${planned.title} ${planned.intent}`)) {
              asideHeld.add(label.toLowerCase());
              queue = [];
              history.push(mask(`Didn't type into '${clip(label, 60)}': a box for another purpose than this record`));
              problem = mask(asideProblem(label));
              continue;
            }
          }
          // Fill the form like a real user (fill.ts): right before a press that sends the form on, in a step
          // that saves, a form still showing empty fields a real user would fill holds the press once (per
          // form, at most MAX_FILL_HOLDS a step) and the actor is told which. Never a verdict, never a press.
          const fillPress = pressOf(action.type, action.type === "press" ? action.key : undefined, target);
          const fillRead = wants.submit && !o.saveStateTo && pressCandidate(fillPress) ? await scanFor(action) : undefined;
          if (fillRead) preScan = { action, scan: fillRead };
          if (fillRead && sendsForm(fillRead, fillPress)) {
            const scan = fillRead;
            const pressName = action.type === "press" ? action.key : (target?.name ?? "");
            // Held only in a step that makes a new record (an edit isn't filled out beyond its goal), and
            // never before a press the browser would refuse anyway (pay, place an order, delete…).
            const held = createsHere && !refusedAnyway(pressName, scan) ? nudge(fillNudge, scan, pressName, mask) : undefined;
            if (held) {
              fillHeld = true;
              queue = [];
              preScan = undefined;
              history.push(mask(`Held '${clip(pressName, 60)}' once: the form still shows ${held.empty.length} empty field${held.empty.length === 1 ? "" : "s"}`));
              emit({ type: "working", n, words: mask(`Holding '${clip(pressName, 60)}': ${held.empty.length} field${held.empty.length === 1 ? "" : "s"} shown still empty`), at: recording.at() });
              problem = held.says;
              continue;
            }
            const why = "why" in action && typeof action.why === "string" ? action.why.trim() : "";
            // Pressed again after a hold: the actor's one line, or plainly that it gave none (the report says so).
            if (fillHeld && (why || shownFields(scan).empty.length)) fillKept = why ? mask(clip(why, 200)) : (fillKept ?? "no reason given");
          }
          // W4: a drag's second element, where it is dropped.
          const dropOn = action.type === "drag" && /^e\d+$/.test(action.to) ? snap.refs.get(action.to) : undefined;
          const outcome = await tracked(action, target, dropOn);
          actions++;
          own++;
          if (action.type === "click_at" && "done" in outcome) pointAgain = true;
          if (!("error" in outcome) && !("blocked" in outcome) && (action.type === "fill" || action.type === "select") && target && formTurns < maxPerStep * FORM_TURNS) {
            const field = `${target.role}\n${target.name}\n${target.nth}`;
            if (!filledFields.has(field)) {
              filledFields.add(field);
              own--;
              // Past the step's own budget, the run's count gives the field back too.
              if (formTurns >= maxPerStep) actions--;
              formTurns++;
            }
          }
          if ("blocked" in outcome) {
            stoppedBefore(outcome.label);
            end = blockedBy(outcome.blocked);
            break;
          }
          const turn: Turn = { key, type: action.type, label: outcome.label, keys: snap.keys, screen: snap.screen, result: "error" in outcome ? (outcome.kind ?? "other") : "ok" };
          ring.push(turn);
          if (ring.length > RING) ring.shift();
          if ("error" in outcome) {
            queue = [];
            if (outcome.needs) {
              needs.add(outcome.needs);
              sinceNeed = 0;
            }
            note({ label: outcome.label, at: recording.at(), error: mask(outcome.error) });
            history.push(`${outcome.label}: didn't work (${mask(outcome.error)})`);
          } else {
            sinceNeed++;
            note({ label: outcome.label, at: recording.at() });
            history.push(outcome.note ? `${outcome.label}: ${outcome.note}` : outcome.label);
            done.push(outcome.done);
          }
          pending = { at: history.length - 1, turn };
          if (refusedEnd) {
            end = refusedEnd;
            break;
          }
          // After any action: a bot check that came up is waited on, never answered; one that stays ends the step.
          const wall = await wallNow();
          if (wall) {
            end = wall;
            break;
          }
          // E4: a check this action made hold ends the step passed, with no AI asked to say done. Only a
          // plain check that didn't hold before the step, and only a pass that proves something (not weak).
          // (A wait never reaches here: the E5 wait branch above continues the loop.)
          if (!("error" in outcome) && !heldBefore && EARLY_CHECKS.has(planned.check.kind) && !shortfall() && (await verify(page, check, 0)).ok) {
            const m = await measure();
            if ("verdict" in m && m.verdict === "passed" && !m.weak) {
              end = m;
              break;
            }
          }
        }
      }

      // Intent coverage: a step whose words say to type values and save can't pass on a check that held
      // before that was done (one click on the way made it hold). A save-like press that was tried and
      // couldn't be pressed is a FAIL that says so; otherwise NOT SURE. Never a pass.
      // A draft's step done for the first time must have done something its check can see: one that
      // did nothing, or whose check held before it, would be saved as a test that proves nothing.
      // (A sign-in step in a run that started signed in is passed by the session: its check held before it by design.)
      if (replay && !planned.actions && !(planned as SavedStep).assert && !(o.storageState && planned.check.kind === "signed_in") && end?.verdict === "passed" && (!done.length || end.weak)) {
        end = { verdict: "not_sure", reason: draftProvesNothing(done.length > 0, end.weak, expected(check), mask) };
      }
      // A save's check that held right before the save was pressed and not after it was about the form,
      // not what the save shows: the page moved on, which is no failure of the site. NOT SURE, never FAIL.
      // A save the browser saw fail (the form wasn't sent, an error showed) stays the FAIL it is.
      if (end?.verdict === "failed" && end.evidence && wants.submit && lastSend?.held && !failedSends.has(lastSend.action) && !shortfall()) {
        end = { verdict: "not_sure", reason: mask(`its check (${expected(check)}) held before '${lastSend.name}' was pressed and not after: it was about the form, not what the save shows, so it can't tell whether the save worked`), evidence: end.evidence };
      }
      if (end?.verdict === "passed") {
        const short = shortfall();
        if (short) end = short.tried ? { verdict: "failed", reason: mask(`the step didn't do what it says: ${short.why}`) } : { verdict: "not_sure", reason: mask(`its check held, but the step didn't do all it says: ${short.why}, so the check proves nothing`) };
      }
      // A stale saved step (recorded under older rules) that couldn't be planned again and didn't pass: says what would fix it.
      if (staleAt.has(i) && end && end.verdict === "not_sure" && end.reason !== STOPPED_BY_YOU && !end.reason?.includes("recorded under older rules")) end = { ...end, reason: `${end.reason ?? "it didn't finish"}; ${staleSays}` };
      // Healed only when it worked: the saved actions that didn't, and what the AI did instead.
      if (healFrom && end?.verdict === "passed") {
        const to = done.slice(healStart);
        healed = unfinished ? { from: [mask(unfinished)], to: to.map((a) => labelOf(a, mask)), finished: true } : { from: healFrom.map((a) => labelOf(a, mask)), to: to.map((a) => labelOf(a, mask)) };
      }

      // The page as the step left it, scanned once per path (a replay too: no AI is needed).
      if (end?.verdict !== "blocked") await scanA11y(page);
      // The photo at the step's end; the same as the last one (nothing changed) is shown once. A stored
      // value that still shows keeps the card up, and the photo is of the card.
      await cardDown();
      let shot = await recording.shot(`step-${n}.jpg`);
      let sameShotAs: number | undefined;
      if (shot) {
        const hash = hashOf(join(o.dir, shot));
        if (lastShot && hash && hash === lastShot.hash) {
          rmSync(join(o.dir, shot), { force: true });
          shot = lastShot.file;
          sameShotAs = lastShot.n;
        } else lastShot = { file: shot, hash, n };
      }
      // A1: a step that ended on a page asking for a code the account can't have (it went to the person's own
      // inbox or phone, and no run waits for a person): BLOCKED with its code, measured on the page, whatever
      // the AI said. A code by text is SMS_CODE_NEEDED; one by email, CODE_NEEDS_PERSON. Never a FAIL of the site.
      // Only on a sign-in step (it typed one of the account's values, or wanted its password), and never after
      // the step typed its own authenticator code: a code page then is the site refusing that code (a FAIL or
      // NOT SURE stands), and a code field later in a signed-in test is the site's own feature, not a sign-in.
      // A run that started signed in (a saved session) has signed in already: only a step that typed the password again counts.
      const signInStep = o.storageState ? typedPassword : typedAccount || needs.has("password") || needs.has("username") || /\b(sign|log)[ -]?(in|on)\b|\blogin\b/i.test(`${planned.title} ${planned.intent}`);
      if (end && end.verdict !== "passed" && end.verdict !== "blocked" && !signInCode && signInStep && !typedTotp && (o.secrets as { byPerson?: boolean } | undefined)?.byPerson) {
        const asked = await codePageOn(page);
        const label = o.secrets!.names()[0]?.split(".")[0] ?? "the account";
        if (asked) {
          signInCode = asked === "sms" ? "SMS_CODE_NEEDED" : "CODE_NEEDS_PERSON";
          end = { verdict: "blocked", blockedGroup: "credentials", reason: mask(`${signInCode}: the page asks for a ${asked === "sms" ? "code texted to a phone" : "code sent to your own inbox"} for ${label}, which Context Machines can't read and a run never waits for: none was guessed`) };
        }
      }
      // A test that started signed in and was sent back to sign in has lost its session (C4): said, so
      // whoever ran it can sign in again with no AI and run it once more.
      if (o.storageState && end && end.verdict !== "passed" && !signInCode && (needs.has("password") || (await signedOutNow(page, o.signInPath)))) sessionExpired = true;
      // A step that didn't pass for want of a value it won't make up is BLOCKED, never FAIL: the site
      // isn't broken, the run had nothing to type. A sign-in says to add an account (AUTH_ACCOUNT_NEEDED);
      // anything else, which --var to pass (VALUE_NEEDED). A saved session that's gone keeps its own words.
      // Only when the missing value is why it stopped: a sign-in with no account to sign in as (it can't go on
      // without the password), or anything else where nothing worked after the value it wouldn't make up.
      // A run that had an account (its values, or its session) is never told to add one: its own words stand.
      const signIn = needs.has("password") || needs.has("username") || (needs.has("email") && /\b(sign|log)[ -]?(in|on)\b|\blogin\b/i.test(`${planned.title} ${planned.intent}`));
      const stoppedByNeed = signIn ? !o.secrets && !o.storageState : sinceNeed === 0;
      if (needs.size && stoppedByNeed && end && end.verdict !== "passed" && end.verdict !== "blocked" && !sessionGone()) {
        const code = signIn ? "AUTH_ACCOUNT_NEEDED" : "VALUE_NEEDED";
        signInCode ??= code;
        const why = signIn ? accountNeeded([...needs], o.url) : `VALUE_NEEDED: it needs values it won't make up, so it stopped (the site isn't at fault): ${varHint([...needs])}`;
        end = { verdict: "blocked", reason: mask(`${why}${end.reason && !/--var|--setup/.test(end.reason) ? ` (where it stopped: ${end.reason})` : ""}`), blockedGroup: signIn ? "credentials" : "setup", ...(end.evidence ? { evidence: end.evidence } : {}) };
      } else if (needs.size && end && end.verdict !== "passed" && !/--var|--setup/.test(end.reason ?? "")) end = { ...end, reason: `${end.reason ?? "it didn't finish"}; ${needWords()}` };
      const fillRec = joinRecords(fillPages.values(), fillKept);
      const step: StepResult = {
        ...base,
        ...end!,
        ...(fillRec ? { fill: fillRec } : {}),
        ...(needs.size && !sessionGone() ? { needs: [...needs] } : {}),
        actions: subs,
        ms: Date.now() - t0,
        at,
        ...(shot ? { screenshot: shot } : {}),
        ...(sameShotAs ? { sameShotAs } : {}),
        ...(healed ? { healed } : {}),
        ...(planned.actions && !healFrom ? { replayed: true as const } : {}),
      };
      if (healed) healedAny = true;
      if (replay && !planned.actions && done.length) draftDone = true;
      friction.stepEnd(n, { actions: subs.filter((sub) => !sub.blocked).length, interactions: interactionsOf(done), ...(retried ? { retried: mask(retried) } : {}), waitedMs });
      steps.push(step);
      // What a replay does: the try that worked. A heal that renamed one element renames it in the step's words too.
      const keptActions = withoutFailedTries(done, (a) => failedSends.has(a));
      const words = (w: string) => (healFrom && healed ? renamed(w, healFrom, done.slice(healStart)) : w);
      kept.push({ title: words(planned.title), intent: words(planned.intent), check: judgedClaim ? { kind: "judged", claim: judgedClaim } : planned.check, actions: keptActions, ...((planned as SavedStep).assert && !keptActions.length ? { assert: true as const } : {}) });
      carried = planned.check.kind === "none" ? [...carried, ...done] : [];
      for (const a of done) if (a.type === "fill" || a.type === "type") typedInRun.push({ value: a.value, at: t0 });
      emit({ type: "stepEnd", step });
    }
    // The goal judge: every step passed in a run whose goal asks for something to be added, saved or
    // changed, so a separate AI (the judge, never the actor) looks once at the final page as text (never
    // a picture: the run may have typed stored values) with the browser's own record of what was done,
    // and says whether that was done. Its "fails" makes the test NOT SURE with its reason; it never makes
    // anything a pass. Goals that only open, find or look are left to their measured checks (asked there,
    // the judge read "in the embedded help panel" as a failure when Help rightly opened as its own page).
    // Not for a replay that changed nothing (it passed this judge when it was saved), a sign-in (--setup),
    // --measured-only, a run with no judge, or one whose last step the judge already passed here.
    // A plan with no step that saves what the goal asks to add (the planner dropped it) can't pass on its
    // checks alone: only the judge's "holds" keeps that pass; anything else, or no judge, is NOT SURE.
    const replayedOnly = replay && !healedAny && !draftDone;
    /** The last step said NOT SURE, with why (only ever from a pass: nothing here passes anything). */
    const notSure = (why: string) => {
      const last = steps.at(-1)!;
      const said: StepResult = { ...last, verdict: "not_sure", reason: mask(why) };
      steps[steps.length - 1] = said;
      emit({ type: "stepEnd", step: said });
    };
    // W3 proof: every step passed in a run that makes, changes or deletes something. What it typed
    // or picked (fixed before the press) must show kept after a fresh load of the page; a proof that
    // failed is NOT SURE, never a pass, and the AI judge is not asked then. A write passed by the AI
    // judge alone (a judged check, a second opinion) with no measured proof is NOT SURE too.
    if (proofOn && steps.length > 0 && steps.every((s) => s.verdict === "passed") && !o.signal?.aborted) {
      emit({ type: "working", n: steps.at(-1)!.n, words: "Opening the page again to check the change was kept", at: recording.at() });
      const links = await page.$$eval("a[href]", (as) => as.map((a) => ({ text: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href })).slice(0, 400)).catch(() => [] as { text: string; href: string }[]);
      const listPages = [o.url, ...listLinks(o.goal, links.filter((l) => sameSite(l.href)))];
      writeProof = await proveWrite({ listPages, goal: o.goal, acts: proofActs, readings, requests: writes?.list ?? [], navigations: writes?.navs ?? [], endUrl: page.url(), endText: await readPlain(page), lastActionAt, browser, from: page.context(), onSite: sameSite, viewport: page.viewportSize() }).catch((error: unknown) => ({ status: "unmeasured" as const, kind: "none" as const, why: `the change couldn't be looked for again: ${message(error)}` }));
      writeProof = { ...writeProof, why: mask(writeProof.why), ...(writeProof.seen ? { seen: writeProof.seen.map((x) => ({ ...x, value: mask(x.value), url: mask(x.url) })) } : {}) };
      if (writeProof.status === "failed") notSure(`every step's check held, but opening the page again didn't confirm the change was kept: ${writeProof.why}`);
      else if (recordWrite && steps.some((s) => s.judged) && !(writeProof.status === "held" && writeProof.strength === "strong")) notSure(`only an AI judge passed this, and an AI judge alone can't pass something made, changed or deleted: it has to be measured, and ${writeProof.status === "held" ? `${writeProof.why}, which a row left by an earlier run could explain too` : writeProof.why}`);
    }
    const allPassed = steps.length > 0 && steps.every((s) => s.verdict === "passed");
    const dropped = allPassed && !replayedOnly && planDropsSave(plan, o.goal);
    const asks = goalAsks(o.goal);
    if (allPassed && !replayedOnly && !o.signal?.aborted && (dropped || (asks.changes && !steps.at(-1)?.judged))) {
      const last = steps.at(-1)!;
      const droppedWhy = "the goal asks for something to be added or saved, and no step of the plan filled it in and saved it";
      if (o.brain?.judge && !measuredOnly) {
        emit({ type: "working", n: last.n, words: "Asking an AI whether the goal was achieved", at: recording.at() });
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
        const snap = await observe(page, mask, undefined, PLAN_SNAPSHOT_CHARS, { onSite: sameSite }).catch(() => undefined);
        let verdict: JudgedOutcome = { verdict: "not_sure", reason: "the page couldn't be read for the AI judge" };
        if (snap) {
          const outline = snapText(snap);
          const record = steps.map((s) => `Step ${s.n} "${s.title}": ${s.actions.filter((a) => !a.blocked).map((a) => `${a.label}${a.error ? " (didn't work)" : ""}`).join("; ") || "nothing done"}`);
          const typed = kept.flatMap((k) => (k.actions ?? []).flatMap((a) => (a.type === "fill" || a.type === "type" ? [a.value] : [])));
          try {
            const answer = await o.brain.judge({ claim: goalJudgeClaim(mask(o.goal)), url: snap.url, title: snap.title, outline, done: record.map(mask), ...(notes ? { notes } : {}) });
            verdict = judgedOutcome(answer, outline, false, { typed });
          } catch (error) {
            verdict = { verdict: "not_sure", reason: `the AI judge didn't answer: ${message(error)}` };
          }
        }
        goalJudge = { verdict: verdict.verdict, reason: mask(verdict.reason) };
        if (verdict.verdict === "fails") notSure(`every step's check held, but an AI judge that looked at where the test ended says the goal wasn't achieved: ${verdict.reason}`);
        else if (dropped && verdict.verdict !== "holds") notSure(`${droppedWhy}, and the AI judge couldn't confirm it was done: ${verdict.reason}`);
        // W3: a plan with no saving step, passed by the judge's "holds" alone: never a pass of a write without a measured proof.
        else if (dropped && !(writeProof?.status === "held" && writeProof.strength === "strong")) notSure(`${droppedWhy}, and only the AI judge said it was done: an AI judge alone can't pass something made or changed${writeProof ? ` (${writeProof.why})` : ""}`);
        // The last step's check held before it did anything (weak), and the judge couldn't confirm the goal:
        // nothing measured shows the change the goal asks for. NOT SURE, never a pass.
        else if (last.weak && verdict.verdict !== "holds") notSure(`the last step's check (${expected(last.check)}) already held before the step, so it shows nothing the step did, and the AI judge couldn't confirm the goal: ${verdict.reason}`);
      } else if (dropped) notSure(`${droppedWhy}, so its checks can't show it was done`);
    }
    writes?.stop();
    // A replay of a saved test whose plan never saves what its goal asks to add (saved under older
    // rules, before the goal judge): it passed no judge when it was saved, so its checks alone can't pass it now.
    if (allPassed && replayedOnly && o.saved && stale?.dropsSave && !o.signal?.aborted) {
      const last = steps.at(-1)!;
      const said: StepResult = { ...last, verdict: "not_sure", reason: mask(`the goal asks for something to be added or saved, and no saved step fills it in and saves it, so its checks can't show it was done; ${o.brain || o.noHeal ? staleSays : "this saved test was recorded under older rules, and an AI is needed to plan it again (run it with --ai)"}`) };
      steps[steps.length - 1] = said;
      emit({ type: "stepEnd", step: said });
    }
    // A sign-in that passed: its session is kept for the tests after it (never printed, owner-only).
    if (o.saveStateTo && steps.length && steps.every((s) => s.verdict === "passed")) await recording.saveState(o.saveStateTo);
    // A test that passed and didn't sign out hands its session back (C4): a rotated token is kept.
    else if (o.writeBackTo && o.storageState && steps.length && steps.every((s) => s.verdict === "passed") && !plan.some((s) => SIGNS_OUT.test(`${s.title} ${s.intent}`))) await recording.saveState(o.writeBackTo).catch(() => {});
   }
  } finally {
    appLog?.stop();
    // The video is only written once the browser's context closes: whatever happened above.
    video = rec ? await rec.finish() : undefined;
    await desk?.close();
    if (!o.browser) await browser.close().catch(() => {});
  }
  const first = steps.find((s) => s.verdict !== "passed");
  const verdict: TestVerdict = !first ? "pass" : first.verdict === "failed" ? "fail" : first.verdict === "blocked" ? "blocked" : "not_sure";
  const result: TestResult = {
    goal: mask(o.goal),
    url: mask(o.url),
    verdict,
    steps,
    passed: steps.filter((s) => s.verdict === "passed").length,
    ms: Date.now() - begun,
    startedAt: new Date(begun).toISOString(),
    ...(video ? { video } : {}),
    ...(video && signInVideo ? { signInVideo } : {}),
    ...(video && (signedInAs || typedCovered || typedMasked) ? { videoNote: videoNote({ signedIn: Boolean(signedInAs), signInVideo: Boolean(signInVideo), masked: typedMasked, carded: typedCovered }) } : {}),
    actions,
    ...(replay ? { replay: true } : {}),
    ...(stopped ? { stopped } : {}),
    friction: friction.all,
    ...(walled ? { botWall: walled } : {}),
    ...(endUrl ? { endUrl } : {}),
    ...(urls.length ? { urls } : {}),
    ...(startWarning ? { startWarning } : {}),
    ...(steps.some((s) => s.verdict === "passed" && s.judged) ? { judged: steps.filter((s) => s.verdict === "passed" && s.judged).length } : {}),
    ...(pictures ? { pictures } : {}),
    ...(goalJudge ? { goalJudge } : {}),
    ...(writeProof ? { proof: writeProof } : {}),
    ...(o.replanned ? { replanned: mask(o.replanned === NOTES_CHANGED ? NOTES_REPLANNED : `${REPLANNED}. Why: ${o.replanned}.`) } : {}),
    ...(notes ? { siteNotes: notesRecord(notes)! } : {}),
    ...(recoveries.length ? { recoveries } : {}),
    ...(signInCode ? { code: signInCode } : {}),
    accessibility: a11y.result(),
    ...(appLog?.entries().length ? { log: appLog.entries() } : {}),
    ...(protections.length ? { protection: protections } : {}),
  };
  // A draft that passed is saved as a plain test, whatever it took: its first pass is what clears it.
  // A run on another address (--url in a suite) saves nothing: its test is the one at its own address.
  const save = verdict === "pass" && !o.noHeal && (!replay || healedAny || draftDone || o.saved?.draft) ? { goal: o.goal, url: o.url, steps: kept, rules: RULES, planRules: PLAN_RULES, ...(o.visitor ? { visitor: true as const } : {}), ...(o.identity ? { identity: o.identity } : {}), ...(notesId ? { notes: notesId } : {}) } : undefined;
  return { result, ...(save ? { save } : {}), ...(sessionExpired && verdict !== "pass" ? { sessionExpired: true as const } : {}) };
}

/**
 * AUTH_ACCOUNT_NEEDED's words: the step signs in and no account was given, so it couldn't sign in (it
 * never makes up a password or a sign-in name). The fix in the app's words and the terminal's. Names only, never a value.
 */
export function accountNeeded(needs: readonly string[], url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // the address as given
  }
  return `AUTH_ACCOUNT_NEEDED: this step signs in, and no account was given to sign in as, so it couldn't sign in (it never makes up a password or the name an account signs in with; the site isn't at fault). Add an account under Accounts and confirm it's your own account on ${host}, then run it again (in a terminal: add one to "accounts" in contextmachines.config.json and run with --as <label>, or ${varHint(needs)})`;
}



/** A step that signs in: its check is the session's (intent coverage leaves it to the sign-in's own rules). */
const SIGNS_IN = /\b(sign|log)[ -]?(in|on)\b|\blogin\b/i;

/**
 * Intent coverage (intent.ts): what a step's words say must be done (type values, save or submit).
 * Nothing for a person's Assert step or a sign-in step (its check is the session); a step that signs in
 * and does more ("Sign in and add a trade") is held to the rest of its words.
 */
export function needsOf(s: PlannedStep): IntentNeeds {
  if ((s as SavedStep).assert || s.check.kind === "signed_in") return { fill: false, submit: false };
  return SIGNS_IN.test(`${s.title} ${s.intent}`) ? intentNeeds("", withoutSignIn(`${s.title}. ${s.intent}`)) : intentNeeds(s.title, s.intent);
}

/** The goal asks for something to be added, saved, created or sent, and no step of the plan saves anything. */
export function planDropsSave(steps: readonly PlannedStep[], goal: string): boolean {
  return goalAsks(goal).saves && !steps.some((s) => needsOf(s).submit);
}

/** A saved step that can't do what it says under today's rules: its place (from 0), and why, in a person's words. */
export interface StaleStep {
  i: number;
  why: string;
}

/** What the result says when a saved test was planned again (staleSteps). */
export const REPLANNED = "This saved test was recorded under older rules and didn't do what it says, so it was planned again from its goal under today's rules";

/** What the live view says while it is planned again. */
export const REPLANNING = "Planning again under today's rules: this saved test was recorded under older rules and didn't do what it says";

/** What a stale saved step says when there is no AI to do it again. */
export const STALE_NEEDS_AI = "this saved test was recorded under older rules, and an AI is needed to do this step again (run it with --ai)";

/** What a stale saved step says on another address (--url in a suite: nothing there is healed or saved). */
export const STALE_OTHER_ADDRESS = "this saved test was recorded under older rules, and a test run on another address (--url) isn't planned again";

/** What a stale saved test with steps the person wrote says: it is never planned again over them. */
export const STALE_OWNED = "this saved test was recorded under older rules, and it has steps you wrote (an Assert check, or a step you edited or switched off), so it isn't planned again from its goal over them: plan it again in the editor";

/**
 * A saved test recorded under weaker rules, read with no AI and no page: the steps whose saved actions
 * can't do what their own words say (intent coverage: "fill in… and save" with only a click on "Add
 * trade"), the steps that save checked by their own words ("Manual": checkGuesses refuses that plan
 * today), and whether the goal asks to add something no step saves (planDropsSave). A step with nothing
 * saved yet (a draft's, or a card the person edited), an Assert step, and the steps in `skip` (the
 * person's own checks) are left out. A test that passed under today's planning rules (planRules) is
 * never stale: what it saved passed intent coverage, the pre-save check and the goal judge. Such a test
 * must not just replay and end NOT SURE: with an AI it is planned again from its goal; with none, its
 * steps say an AI is needed.
 */
export function staleSteps(test: Pick<SavedTest, "goal" | "steps" | "planRules">, o: { skip?: readonly number[] } = {}): { steps: StaleStep[]; dropsSave: boolean; any: boolean } {
  if ((test.planRules ?? 0) >= PLAN_RULES) return { steps: [], dropsSave: false, any: false };
  const steps: StaleStep[] = [];
  for (const [i, s] of test.steps.entries()) {
    if (!s.actions || s.assert || o.skip?.includes(i)) continue;
    const short = intentShortfall(needsOf(s), s.actions, []);
    if (short) steps.push({ i, why: `step ${i + 1} ("${clip(s.title, 60)}") only has saved clicks that don't do what it says (${short.why.replace(/^its intent says/, "it says")})` });
    else if (checksOwnWords(s)) steps.push({ i, why: `step ${i + 1} ("${clip(s.title, 60)}") saves something, but its check (${expected(s.check)}) is the step's own words, which the form shows before anything is saved` });
  }
  // Only a test that was saved as done (every step has its actions): a draft's steps are the AI's to do anyway.
  const dropsSave = test.steps.every((s) => s.actions) && planDropsSave(test.steps, test.goal);
  return { steps, dropsSave, any: steps.length > 0 || dropsSave };
}

/** Why a stale saved test was planned again, in a person's words: the first stale step's reason. */
export function staleWhy(stale: ReturnType<typeof staleSteps>): string {
  return stale.steps[0]?.why ?? "the goal asks for something to be added or saved, and no saved step fills it in and saves it";
}

/**
 * Whether a saved test is planned again from its goal in this run, and if not, why not: it is stale
 * (staleSteps), an AI is there, it isn't on another address (noHeal), and it has no step the person
 * wrote (`owned`: an Assert step, one of their own checks, or, for the app's cards, a card they edited or
 * switched off). A plan from the goal knows nothing of those, so it is never put over them: such a test
 * replays, its stale steps finished by the AI where they can be, and says how to fix it.
 */
export function replanOf(saved: Pick<SavedTest, "goal" | "steps" | "planRules" | "notes" | "draft">, o: { ownChecks?: readonly number[]; owned?: boolean; ai: boolean; noHeal?: boolean; notes?: string }): { stale: ReturnType<typeof staleSteps>; owned: boolean; why?: string } {
  const stale = staleSteps(saved, { ...(o.ownChecks ? { skip: o.ownChecks } : {}) });
  const owned = Boolean(o.owned) || saved.steps.some((s) => s.assert) || Boolean(o.ownChecks?.length);
  const able = o.ai && !o.noHeal && !owned;
  if (stale.any && able) return { stale, owned, why: staleWhy(stale) };
  // The person's notes about the site changed since it passed (or it passed with none and has some now):
  // planned again from its goal, so the notes are planned with ("a trade has two executions"). Never a
  // draft (its steps are the AI's to do anyway, with the notes), and never over steps the person wrote.
  const notesChanged = o.notes !== undefined && !saved.draft && saved.steps.every((s) => s.actions) && (saved.notes ?? "") !== o.notes;
  return { stale, owned, ...(notesChanged && able ? { why: NOTES_CHANGED } : {}) };
}

/** replanOf's reason when the person's notes about the site changed since the saved test passed. */
export const NOTES_CHANGED = "your notes about this site changed since this test was saved";

/** What the result says when a saved test was planned again because the notes changed. */
export const NOTES_REPLANNED = "This saved test was planned again from its goal because your notes about this site (What the tester should know about this site) changed since it was saved";

/** What the live view says while it is planned again for the notes. */
export const NOTES_REPLANNING = "Planning again: your notes about this site changed since this test was saved";

/** What a stale saved step that wasn't planned again adds to its NOT SURE: what would fix it. */
export function staleFix(o: { ai: boolean; noHeal?: boolean; owned: boolean }): string {
  return o.noHeal && o.ai ? STALE_OTHER_ADDRESS : o.owned && o.ai ? STALE_OWNED : STALE_NEEDS_AI;
}

/** A step that signs out: its test gets its own copy of the session and never writes it back. */
export const SIGNS_OUT = /\b(sign(ing)?[ -]?out|log(ging)?[ -]?(out|off))\b/i;

/**
 * Whether the page is a sign-in page now: the account's sign-in page, or a password field showing on
 * an address that reads like one (/login, /sign-in, /auth…). Measured, no AI.
 */
export async function signedOutNow(page: Page, signInPath?: string): Promise<boolean> {
  let path = "";
  try {
    path = new URL(page.url()).pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
  if (signInPath && path === signInPath.replace(/\/+$/, "")) return true;
  const password = await page.locator("input[type=password]:visible").count().catch(() => 0);
  return password > 0 && /(log|sign)[-_]?(in|on)|\bauth|session|account\/login/i.test(path);
}
