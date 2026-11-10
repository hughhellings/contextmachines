import { describeFields, intentOf, normalizeUrl, parseBody, readMessage, routeKeysOf } from "@contextmachines/snippet/capture";
import { CapturedEventSchema, placeEvent, placePath, type CapturedEvent } from "@contextmachines/schemas";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request, type Response, type Route } from "playwright";
import { brokenWording, findBanner, FIRST_RUN_PATH, fixedLabel, MADE_UP_LINE, measureLayout, mergeChecks, NOT_THE_APPS_ERROR, PHONE, readDrawn, readReview, REVIEW_WORDS, reviewLines, SAYS_NO_SESSION, SAYS_TURNED_AWAY, SIGN_UP_PATH, TABLE_CELLS, type Banner, type Box, type Drawn, type Measured, type NewUserReport, type ScreenCheck, type ScreenReview, type Wording } from "./checks.ts";
import { fixesFor, SENTENCE, type FieldState, type Rejection } from "./form-values.ts";
import { CRASH_WORDS, findJourneys, JOURNEYS_LEAST_MS, JOURNEYS_MOST_MS, JourneyWalk, readStep, signUpJourney, STEP_STILL_MORE_MS, STEP_STILL_MS, STEP_WAIT_MS, stepSettled, stopOf, stopOfField, type Drive, type JourneyHints, type JourneyReport, type ScreenNow, type WalkedJourney } from "./journeys.ts";
import { PAGE_TURNER, nothingOwn, otherState, pressOrder, remember, uniqueCount, type Control, type PressMemory } from "./priorities.ts";
import { answerSessionReads, isLocalHost, NOWHERE_PATH, oneRowOf, proxyPrefix, readWall, sameWords, Seal, serverDecides, SIGN_IN_PATH, STAND_IN_EMAIL, standInRefusal, WALL_WORDS, type Drawing, type Reply, type SealVerdict, type StandInConfig, type StandInReport, type Wall } from "./stand-in.ts";

export { mergeChecks, SAYS_PAID } from "./checks.ts";
export { standInRefusal } from "./stand-in.ts";
export type { NotReached, StandInConfig, StandInReport, StandInStatus } from "./stand-in.ts";
export type { NewUserReport, ReviewControl, ScreenCheck, ScreenReview } from "./checks.ts";
export { JOURNEY_LEGEND, JOURNEYS_MOST_MS } from "./journeys.ts";
export type { JourneyHints, JourneyOutcome, JourneyReport, JourneyStep, StepsToValue, StopKind, WalkedJourney, WalkedView } from "./journeys.ts";

/**
 * The learner: walks a site in a headless browser so the site model exists before real
 * users arrive.
 *
 * Safety model (read-only by construction): one rule decides every request (see judge, at the
 * end of this file). What it can show is a harmless read passes; everything else is held back.
 * - Reads (GET/HEAD/OPTIONS/QUERY) reach the site unless something in them says they act: a command
 *   in the address, a CSRF-style key, a value the learner typed, a press that said it destroys.
 *   Every other request is stopped in the browser and reported as a blocked write. A GraphQL
 *   request goes through only when every operation in it can be read and is a query.
 * - The only exception is the login step, which may submit its form.
 * - Other hosts get reads only. A write the page's code sends to one just after a press (a back end
 *   on another domain) is a stopped save, answered in the browser; anything else to one is refused,
 *   a read carrying what was typed and a consent, ad or analytics host's call among them.
 * - A GET that writes and has an innocent address, sent by nothing that says so, can't be told from
 *   a read by anyone outside the server. This is why a signed-in run belongs on a test account.
 * - Links are followed. Buttons that only move between screens are pressed, to
 *   find screens with no link to them (most single-page apps); anything that
 *   could act (delete, pay, upgrade, sign out, submit a form, sign in elsewhere) is
 *   not, and any write it tried would be blocked anyway. Learning presses some of these (see
 *   RISKY_WHEN_LEARNING), never paying, upgrading, signing out or signing in elsewhere. After a
 *   press that says it acts (deletes, sends: "Email everyone"), everything is held, reads too
 *   (see saysActs); with realWrites (--create), only after one that says it destroys, so a send
 *   goes through. Links that say they act and other origins are never visited (see linksHeldBack); one page per URL pattern. A start
 *   that names a folder (/examples/react/) keeps the learner inside that folder.
 * - Page structure (forms, required fields, buttons: labels only) is read by the
 *   real snippet running in the scan's browser, so a scan learns exactly what
 *   real users' visits would.
 * - Learning what each button does, without doing it: forms are filled with test values and
 *   their save buttons pressed, and every write that follows is stopped in the browser and
 *   answered with a harmless "OK" of our own, so the app moves on (to the next wizard step, to
 *   the record's page) exactly as if it had saved. Nothing reaches the site's server. Each
 *   stopped write is recorded as an action, with the button that caused it and its fields. A
 *   classic form that sends by loading a new page is answered with "nothing to show" (204), so the
 *   browser stays on the real page: a reply of ours is never shown, read or photographed as a screen.
 * - A page that came back as an error (4xx/5xx, or a page that says it's missing) is not a screen.
 *   On live connections, only messages of a protocol's exact upkeep or read shape (joining,
 *   heartbeats, a subscription) pass, so the page keeps working; every other message, binary
 *   included, is held back. A connection no filter can reach doesn't exist: SharedWorkers,
 *   WebTransport and WebRTC are taken away, and a worker's WebSocket never connects.
 * - A link answered as a file to download, or with data (a JSON body), is no screen.
 * - Hard limits on pages, time and pace. A page whose main thread hangs is stopped, not waited for.
 * - Captured traffic goes through the snippet's own normalisation and redaction.
 * - Every screen is measured as it's looked at, at desktop and phone width (see checks.ts). That
 *   only reads: the window is resized and put back, and the one thing done to a page is to answer a
 *   cookie banner the private way, and bring it back by undoing that, on a run with no real session.
 * - The stand-in pass (see stand-in.ts) comes after all of this, in a browser of its own, and goes by
 *   a rule of its own ahead of the one above: only the local dev server's files leave the browser.
 *   The journeys (see journeys.ts) are the one pass that presses behind a sign-in, under that seal
 *   and no other way, and what they see stays out of everything above.
 */

export interface LoginField {
  selector: string;
  /** Name of the environment variable holding the value. Secrets never live in config. */
  env: string;
}

export interface LoginConfig {
  url: string;
  fields: LoginField[];
  submit: string;
  /** Login succeeded if the URL afterwards contains this. */
  successUrlContains?: string;
}

export interface ScanConfig {
  startUrl: string;
  /**
   * Origins whose API traffic is captured and protected. Defaults to the start URL's origin; hosts
   * that share its registrable domain (api.acme.com for www.acme.com) always count too.
   */
  origins?: string[];
  /**
   * Other addresses that are part of the same site, scanned as well: the app at
   * https://app.acme.com when the scan starts at https://www.acme.com. Their pages are
   * recorded as "//app.acme.com/path"; their API traffic is protected like the start's.
   */
  siteOrigins?: string[];
  maxPages?: number;
  maxDurationMs?: number;
  navigationTimeoutMs?: number;
  /** Pause between pages, to be gentle on the site's servers. */
  delayMs?: number;
  /** Extra path patterns never to visit (added to the built-in list). */
  excludePaths?: string[];
  allowValues?: string[];
  login?: LoginConfig;
  /**
   * A session saved after signing in by hand (Playwright storage state), for sites
   * with single sign-on or two-step sign-in: nobody hands a password to the scan.
   */
  storageState?: string;
  /** Press buttons that move between screens (default true). */
  exploreButtons?: boolean;
  /**
   * Fill forms with test values and press their save buttons, answering every write with a
   * harmless "OK" of our own so nothing reaches the server (default true). Off: writes are
   * stopped with an error instead, and forms are left alone.
   */
  learnActions?: boolean;
  maxButtonsPerPage?: number;
  /**
   * Photograph each screen (and each step and pop-up), with where its buttons and fields sit, so
   * reports can show a problem on its screen (default true). Use a test account: what's on
   * screen is in the photo.
   */
  screenshots?: boolean;
  /** The built snippet, to read page structure (defaults to the one in this repository). */
  snippetFile?: string;
  /**
   * Let the learner's saves through for real, on a test account the person runs it on (creating a
   * quiz to reach its editor). A write passes only if nothing anywhere in it says it destroys (its
   * address, its body read as text, its headers), and buttons that say so are never pressed. That
   * is as far as anyone can read a request: best effort, not proof. Default false.
   */
  realWrites?: boolean;
  /** Told as each screen is learned, for progress; standIn says it was the stand-in pass that learned it. */
  onScreen?: (path: string, count: number, named?: string, standIn?: boolean) => void;
  /** Told as the public crawl goes back to a screen it has looked at, to press its buttons and fill its forms there: for progress, as onScreen. */
  onPressing?: (path: string) => void;
  /** Every page gets its look and nothing is pressed, and the pass ends when they've all had it: for a pass where what's measured is the point (see standInPass). */
  looksOnly?: boolean;
  /**
   * Only the count wording is read on each screen, and its photo taken: no snippet read, no review,
   * no layout. For a pass that keeps nothing else (see oneRowLook). Its counts still have to last.
   */
  countsOnly?: boolean;
  /**
   * Hands the sealed page over to this instead of crawling, and ends when it does: the one way
   * anything presses under the seal (see Drive). It runs under a held seal or not at all.
   */
  walk?: (drive: Drive) => Promise<void>;
  /** Told each problem the moment it's first seen (see Finding), for a live status line. Its count is 1 then. */
  onFinding?: (finding: Finding) => void;
  /**
   * Told what was measured as soon as it can't be taken back: a public screen's at once, a new
   * account's once that screen is shown to be the app's, and anything else when its pass has
   * reached something. Everything told here stays in the result.
   */
  onChecks?: (checks: ScreenCheck[]) => void;
  /**
   * With this, the last look (see oneRowLook) doesn't hold up the return: it's handed over here, and
   * the checks in the result are only whole once it's done. What comes after a scan can start on
   * what it needs, which that look adds nothing to.
   */
  onLastLook?: (look: Promise<void>) => void;
  /**
   * With this, the journeys are walked (see journeys.ts): in a sealed browser of their own, from when
   * the new account has been walked, beside the rest of the run. They're handed over here so nothing
   * has to wait for them, and they end when `stop` says, or at their time limit.
   */
  onJourneys?: (journeys: JourneysUnderWay) => void;
  /** For a screen saying what the run is at, and nothing else: told as the pass behind a sign-in moves on (see ScanStage). */
  onStage?: (stage: ScanStage) => void;
  /** For the passes of one run: told what a pass has so far, once for each screen it finishes. */
  measured?: (seen: ScanResult) => void;
  /** For the public crawl: told, once, when its links are looked through and a sign-in stood in the way of one. What's left of it is pressing, unless its share of the time ended the look first: whole says which. */
  onWall?: (seen: ScanResult, whole: boolean) => void;
  /** Told about once a second, and as the learning moves from one phase to the next (see ScanProgress). */
  onProgress?: (progress: ScanProgress) => void;
  /** Stops exploring early (Ctrl+C, say): what was learned so far is still returned, with stoppedBy "interrupted". */
  signal?: AbortSignal;
  /**
   * Keep numbers in what the snippet reads as written ("Pro at $9 a month"), for a run signed out,
   * where no one's records are on screen. Default: on when signed out, and never when signed in
   * (login, storageState or realWrites), whatever this says: then a balance or an account number stays masked.
   */
  keepNumbers?: boolean;
  /**
   * After the public crawl, walk the signed-in product of a local, client-rendered app as a made-up
   * user, with every data call answered in the browser and nothing but the dev server's files
   * leaving it (see stand-in.ts). Refused with login, storageState or realWrites, and anywhere
   * but a local address. What it reached is marked (see seenWith); it gives no findings.
   *
   * Given as a function, it's asked once the public crawl is over, with what that crawl saw and the
   * protected addresses that only showed a sign-in form: what to try often can't be known before
   * then, and nothing back means there is no pass.
   */
  standIn?: StandInConfig | ((crawl: ScanResult, walls: readonly string[]) => Promise<StandInConfig | undefined> | StandInConfig | undefined);
  /**
   * A run on this machine stays on this machine from its first request: a local app's own page
   * still points at the real sign-in, the real database and the real trackers, and a developer
   * asking what their app does hasn't asked for any of those to hear from it. Nothing goes to a
   * host that isn't local, and the browser can't resolve one. Set by the CLI for a local address
   * with no real session; on by itself with standIn, where it can run at all.
   */
  stayLocal?: boolean;
  /**
   * With stayLocal: address prefixes this app's dev server hands on to another server ("/backend"),
   * or "*" when it does and what's handed on couldn't be read. Same-origin to a browser and a real
   * service behind it, so a prefix counts as another host: nothing goes there. With "*" nothing can
   * tell a page from a proxy's, so the page's own calls are held, and its pages and files can't be.
   */
  proxied?: string[];
}

/** The journeys of a run, going on beside it. */
export interface JourneysUnderWay {
  /** Over: the walk ended, its browser is closed. */
  done: Promise<void>;
  /** Ends the walk where it is. What's been walked stays. */
  stop: () => void;
  /** The walking over, the journey it was on in soFar: sooner than done, which waits for the browser to close. */
  walked: Promise<void>;
  /** Ended, or has had the least it's given when a run has nothing else left to do. */
  atLeast: Promise<void>;
  /** How it stands now: everything walked so far, and what hasn't been. */
  soFar: () => JourneyReport;
  /** Told about each journey as it ends. */
  listen: (tell: (journey: WalkedJourney) => void) => void;
  /** The browsers it walks in at once once the new account's walk is over, each under a seal of its own. */
  browsers: number;
  /** How many of those browsers have walked a journey to its end, so far. */
  walkedIn: () => number;
  /** How many journeys have been begun, so far. */
  begun: () => number;
}

/** Where a run has got to, for a live status line. */
export interface ScanProgress {
  /** Screens learned so far (pagesVisited). */
  screens: number;
  maxPages: number;
  elapsedMs: number;
  /** "opening": starting the browser, signing in, loading the start page; "exploring"; "finishing": tidying up what was learned. */
  phase: "opening" | "exploring" | "finishing";
}

export interface ScanResult {
  pagesVisited: string[];
  events: CapturedEvent[];
  blockedWrites: { method: string; path: string; graphqlOperation?: string; seenWith?: "stand-in" }[];
  errors: string[];
  stoppedBy: "complete" | "max_pages" | "max_duration" | "interrupted";
  loggedIn: boolean;
  /** Screens found by pressing a button rather than following a link. */
  foundByButtons: string[];
  /** Where the scan started: its pages have plain paths. */
  startOrigin: string;
  /** A photo of each screen, named as the snippet names it (with its step or pop-up), and where things sit on it. */
  screens: ScreenPhoto[];
  /** Problems the browser saw for itself while exploring (see Finding), each once with how often. */
  findings: Finding[];
  /** What was measured wrong on the screens (see ScreenCheck), one for each thing to fix. Stand-in screens' are marked. */
  checks: ScreenCheck[];
  /** Each screen as a reader of it needs it (see ScreenReview), holding only what was on screen. */
  reviews: ScreenReview[];
  /** Photos from the look with one row (see oneRowLook): a count of one is on these. */
  oneRowPhotos?: ScanResult["screens"];
  /** What a brand-new account finds (see NewUserReport), when the app could be walked that way. */
  newUser?: NewUserReport;
  /** Milliseconds spent on each step, summed over the run: where the time went. */
  timings: Record<string, number>;
  /** The start page's HTTP status (its first page load, after redirects), when it answered. */
  startStatus?: number;
  /** The start page's title, which tells a bot check's "Just a moment…" from a sign-in. Only for the CLI's own message. */
  startTitle?: string;
  /** The start page's answer asked for credentials (WWW-Authenticate): a sign-in, not a bot wall. */
  startAsksSignIn?: boolean;
  /** Why the start page couldn't be loaded at all (the network or its certificate), when it couldn't. */
  startError?: string;
  /**
   * The start page's path, where it ended up after any redirects ("/" that redirects to "/login" is
   * "/login"), whenever it answered. Set even when it's no screen (an error page, a document that
   * isn't a web page), so "the site is down" can be told from "nothing was found": with startStatus,
   * this is what says how the start went, not pagesVisited.
   */
  startPath?: string;
  /**
   * The host a start address sent the browser on to when that's another site altogether, in which
   * case nothing was learned (pagesVisited is empty). A move on the same site (apex to www, http to
   * https) isn't this: there startOrigin is where it landed.
   */
  startLeftFor?: string;
  /** Pages that came back as errors (a status of 400 or more, or a page saying it's missing): never screens. */
  errorPages: { path: string; status: number }[];
  /** Links not followed and reads not sent because they might act, and why (see HeldBack): what a run gave up to stay read-only. */
  linksHeldBack: HeldBack[];
  /** For a start below "/": the folder the learner kept to, and how many links outside it it left alone. */
  scope?: { path: string; skipped: number };
  /** Events left out because they weren't valid (a blank frame's page, say): counted, never sent on. */
  invalidEvents: number;
  /**
   * Writes the page sends by itself, stopped like any other but not in blockedWrites or the events,
   * since no press explains them. "beacon": sendBeacon, a ping or a keepalive fetch; "cdn": the CDN's
   * own upkeep; "unprompted": never followed a press of ours; "repeats": followed three or more
   * different controls, or came on three or more screens, with nothing typed in it.
   */
  /** Screens each screen's links and presses were seen to lead to, by address. */
  links: Record<string, string[]>;
  ambientWrites: { method: string; path: string; graphqlOperation?: string; count: number; why: "beacon" | "cdn" | "unprompted" | "repeats"; seenWith?: "stand-in" }[];
  /** Hosts a local run didn't contact, though a page asked it to (see ScanConfig.stayLocal). */
  stayedAway?: string[];
  /** The same for addresses on the app's own host that its dev server hands on (see ScanConfig.proxied). */
  proxiedHeld?: string[];
  /** The dev server hands on addresses this run couldn't read, so its pages and files may have gone through it. */
  proxyUnread?: boolean;
  /**
   * The one real address behind a screen's template, when only one was seen and it's a name, not an
   * id: /guides/:id is a claim that there are many, and the page opened was /guides/getting-started.
   */
  addresses?: Record<string, string>;
  /** How the stand-in pass went, when one was asked for. */
  standIn?: StandInReport;
  /** Screens seen only as the stand-in user, by path: all they show is made-up data, and they prove nothing. */
  seenWith?: Record<string, "stand-in">;
  /**
   * A fingerprint of what each screen drew, its words and pictures, by path. Never the words: only
   * enough to tell that two addresses drew the same thing (a retired route that falls through to the
   * sign-in page), whatever title each set.
   */
  drawn?: Record<string, string>;
}

/**
 * Something provably wrong that the learner saw happen, never an opinion: a button that did nothing
 * at all, the site's own script crashing, a request of the site's that failed, a link to a missing
 * page. Each kind has guards against false alarms, since a wrong one costs more than a missed one.
 */
export interface Finding {
  kind: "does_nothing" | "crashes" | "request_fails" | "broken_link";
  /** The screen it happened on (for a broken link, the screen with the link). */
  screen: string;
  /**
   * The button's label, the error's first line, the request ("GET /api/stats", or with its host when
   * it isn't the start's: "GET api.acme.com/stats") or the link's address, as a pattern (/clients/:id).
   */
  target: string;
  /** What proves it: the status, the network error, or the script file the error came from. */
  evidence: string;
  /** The button pressed just before, for a crash or a failed request a press set off. */
  after?: string;
  count: number;
}

export interface ScreenPhoto {
  path: string;
  width: number;
  height: number;
  jpeg: Buffer;
  /** `href` on a link is where it leads, with no query or fragment: only its path is ever read. */
  boxes: { label: string; kind: "button" | "field" | "link"; x: number; y: number; w: number; h: number; hiddenIn?: string; href?: string }[];
  /** Taken as the stand-in user: the app's real screen, showing data that was made up. */
  seenWith?: "stand-in";
  madeUpData?: true;
}

const VIEWPORT = { width: 1280, height: 800 };
/** A local run's floor: names that aren't this machine's don't resolve, whatever a page's rules were never shown (see stayLocal). */
const LOCAL_ONLY_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]"];
/** Fewer characters than this drawn on a page, and it isn't compared with any other (see ScanResult.drawn). */
const MIN_DRAWN_WORDS = 20;
/** How long the last look at the stand-in's screens may take (see lookSignedOut). */
const SIGNED_OUT_MS = 45_000;
/** Writes to one address before "mostly unprompted" means anything. */
const OWN_WRITE_COUNT = 5;
/** An address made of words, not of an id: no long number, no @, and a hyphen or letters to read. */
const NAMED_ADDRESS = /^(?:\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\/?$/i;
/**
 * Says who is visiting, and where to read about it, in any site's logs: added after the browser's
 * own words (see visitorAgent), as crawlers do, so a site's browser sniffing works as it does for
 * everyone else.
 */
const USER_AGENT = "ContextMachines/0.1 (+https://github.com/hughhellings/contextmachines)";
const MAX_SCREEN_PHOTOS = 60;
/** Query keys tried as routes in one run (see confirmRoutes): a site has one or two at most. */
const MAX_ROUTE_KEYS = 4;

/**
 * Buttons never pressed. Writes are blocked at the network whatever is pressed, so
 * what's left to avoid is what acts without one: ending the session, leaving for
 * another sign-in or payment page, deleting, downloading. Form submits are never pressed.
 */
export const RISKY_BUTTON = /delete|remove|destroy|erase|trash|purge|wipe|discard|archive|\bclear\b|\bempty\b|truncate|\bdrop\b|log ?out|sign ?out|unsubscribe|revoke|deactivate|close account|pay\b|buy|purchase|checkout|billing portal|\bupgrade|subscribe (?:to|for) (?:the )?(?:pro|team|premium|plus|business|enterprise)\b|start (?:a |my |your )?(?:free )?trial|continue with|google|apple|microsoft|github|download|print|export|löschen|entfernen|abmelden|ausloggen|kündigen|bezahlen|kaufen|zur kasse|drucken|herunterladen|exportieren|supprimer|déconnexion|se déconnecter|payer|acheter|imprimer|eliminar|borrar|cerrar sesión|pagar|comprar|imprimir|elimina|\besci\b|acquista|verwijderen|uitloggen|afrekenen|excluir|\bsair\b/i;
/**
 * When learning, every write is answered by us and never reaches the site, and everything after a
 * press that says it destroys is held (see heldUntil), so a button that deletes or exports is safe to
 * press: it's what we need to learn. What stays off-limits is what acts outside our reach: ending
 * the session, leaving for payment, a plan or another sign-in, printing. A press that says it sends
 * ("Email everyone") is made, but what follows it is held, read or not (see saysActs). With
 * realWrites this isn't used: only a press that says it destroys is held, so a send goes through.
 */
export const RISKY_WHEN_LEARNING = /log ?out|sign ?out|unsubscribe|deactivate|close account|pay\b|buy|purchase|checkout|billing portal|\bupgrade|subscribe (?:to|for) (?:the )?(?:pro|team|premium|plus|business|enterprise)\b|start (?:a |my |your )?(?:free )?trial|continue with|google|apple|microsoft|github|print|abmelden|ausloggen|kündigen|konto (löschen|schließen)|bezahlen|kaufen|zur kasse|drucken|déconnexion|se déconnecter|payer|acheter|imprimer|cerrar sesión|pagar|comprar|imprimir|\besci\b|acquista|uitloggen|afrekenen|\bsair\b/i;
/** A number kept for drama: no phone can ever have it, so it's plainly made up, in the page as here. */
const FICTIONAL_PHONE = "+447700900123";
/** A plausible test value for a field, from its type and its name or placeholder. */
function testValue(type: string, hint: string): string {
  if (type === "email" || /e-?mail/.test(hint)) return "learner@example.test";
  if (type === "url" || /site|url|link/.test(hint)) return "https://example.test";
  if (/birth|\bdob\b/.test(hint)) return "1990-01-15"; // a date to come is never someone's birthday
  if (type === "datetime-local") return "2026-01-15T09:00";
  if (type === "time") return "09:00";
  if (type === "date" || /date/.test(hint)) return "2027-01-15";
  if (type === "tel" || /phone|mobile|tel/.test(hint)) return FICTIONAL_PHONE;
  if (type === "number") return "10";
  if (type === "textarea") return SENTENCE;
  return "Test";
}
/** What a box really takes: one that brings up the number keyboard wants a number, whatever its type says. */
const fieldType = (type: string, inputMode: string | null, hint = "") => (/^(numeric|decimal)$/.test(inputMode ?? "") || NAMES_A_NUMBER.test(hint) ? "number" : type);
/** A box that's plainly for a number, whatever its type says. */
const NAMES_A_NUMBER = /\b(?:amount|price|size|qty|quantity|total|cost|fee|commission|lots?|volume)\b/;

/** An address as written (/entwürfe/löschen), not percent-encoded. */
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** Where the learner's snippet sends: https, or an https page (every real site) may not send to it at all. Never leaves the browser. */
const SCAN_ENDPOINT = "https://learner.invalid/v1/events";
const DEFAULT_SNIPPET = fileURLToPath(new URL("../../snippet/dist/snippet.min.js", import.meta.url));
const SKIP_EXTENSIONS = /\.(pdf|zip|gz|tar|dmg|exe|msi|csv|xlsx?|docx?|pptx?|mp4|mov|mp3|png|jpe?g|gif|svg|webp|ico)$/i;
/** How the browser says a page load turned into a download (a reply sent as an attachment). */
const DOWNLOAD_STARTED = /download is starting/i;
/** Methods that only read. QUERY is HTTP's newer read with a body (a search), safe like GET by definition. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "QUERY"]);
const CAPTURED_TYPES = new Set(["xhr", "fetch"]);
/** Our answer to every write we stop: success, with an id, so the app moves on as if it had saved. */
const MAX_WIZARD_STEPS = 6;
/** How many times a form the page turned down is corrected and sent again (see tryAgain). */
const FORM_RETRIES = 2;
/** The share of a run in which every page a link reaches gets its look before pages are pressed through. */
const LOOK_SHARE = 0.4;
/** Once that share is up, how many pages get a look for each one pressed through. */
const LOOKS_A_TURN = 3;
/** A list's opening entry that only asks you to choose ("Select…", "---Your name---"). */
const CHOOSE_PROMPT = /^\s*(?:[-–—*\s]+|(?:please )?(?:select|choose|pick)\b.*|[-–—*]{2,}.*)$/i;
/** Views of one document in a row with nothing new on them, before the rest are left alone (see dullViews). */
const DULL_VIEWS = 5;
/** Words that say a line on the page is about what's wrong with a form, in the wordings forms use. */
const SOUNDS_WRONG = /\b(?:required|invalid|must|should|at least|at most|minimum|maximum|minimal|please|can.?t be|cannot be|too (?:short|long|low|high|small|large|many|few)|doesn.t (?:meet|match)|does not (?:meet|match)|don.t match|do not match|not valid|not allowed|not a valid|incorrect|missing|error)\b/i;
/** Where forms put a message of their own, in any language. */
const ERROR_PLACE = "[role=alert], [aria-live=assertive], .error, .errors, .err, .invalid-feedback, .field-error, .form-error, .alert-danger, .help-block.with-errors";
/** Long enough for the snippet to read a new step's structure and finish a live-connection action. */
const SNIPPET_SETTLE_MS = 1700;
/** The same for a walk that presses, with no snippet to wait for: long enough for a click to reach the app. */
const WALK_SETTLE_MS = 200;
/** How long a journey's look waits between reads of a page that's still drawing, and the least it waits. */
const STEP_POLL_MS = 350;
const STEP_POLL_LEAST_MS = 50;
const WALK_ACTION_MS = 1200;
const WALK_MOST_BOXES = 24;
const WALK_OFFER_MS = 500;
/** Buttons that move a wizard on without saving anything. */
const ONWARD = /^(continue|next|skip( for now)?|done|finish|get started)\b/;
/** The last step's button in a pop-up wizard: it sends what was filled in (answered by us). */
const SEND_ON = /^(submit|send|apply|confirm|save|create|book|place|finish)\b/i;
const SIMULATED_REPLY = JSON.stringify({ ok: true, id: "1", data: {}, result: { data: { json: { id: "1" } } } });
/**
 * Addresses a CDN keeps for itself on every site it serves (Cloudflare's /cdn-cgi/: its bot check,
 * email protection, analytics): the CDN's requests, never the product's actions.
 */
const CDN_OWN = /^\/cdn-cgi\//;
/** Files the host serves at its edge and no build holds (a platform's analytics, a CDN's scripts): off that host they're missing, with nothing wrong in the app. */
const PLATFORM_OWN = /^\/(?:_vercel|cdn-cgi)\//;
/** Checks whose target is whatever a control or a box says. */
const MEASURED_WORDS = new Set<ScreenCheck["kind"]>(["cut_off", "covered", "unreachable", "overflow", "console_error"]);
/** Findings whose target is what a control says or what a page threw, and not an address. */
const DRAWN_FINDINGS = new Set<Finding["kind"]>(["does_nothing", "crashes"]);
/** A script that is a page's styles: without it, its layout says nothing. */
const CSS_BY_SCRIPT = /tailwind|twind|unocss|windi/i;
/** How long a floating box or a drawn word must last to count: a notice comes and goes, and a page may draw a hole before its data. */
const STILL_THERE_MS = 1200;
/** What a phone-width layout gets to settle in. */
const PHONE_SETTLE_MS = 150;
/** The share of a run's time that may go on phone width. */
const PHONE_SHARE = 0.1;
/** A label may be this much too wide with a fallback font in place of one this run kept out, and prove nothing. */
const FONT_MARGIN = 0.05;
/** How many pixels a page may run over with such a font. */
const FONT_OVERFLOW = 24;
/** What a banner gets to finish sliding in. */
const BANNER_SETTLE_MS = 500;
/** Screens looked at again with the cookie banner brought back, in one pass. */
const MOST_BANNER_LOOKS = 6;
const MOST_REVIEWS = MAX_SCREEN_PHOTOS + 20;
/**
 * Hosts on every kind of site and no one's product: consent managers, ads and analytics. They follow
 * a press as surely as a save does, and are never what it was for. Known by their own domains, or by
 * a word in front of any domain (consent.example.net, px.ads.example.com).
 */
const BACKGROUND_DOMAIN = /(^|\.)(cookielaw\.org|onetrust\.com|cookiebot\.com|usercentrics\.eu|consensu\.org|trustarc\.com|didomi\.io|privacy-center\.org|sp-prod\.net|osano\.com|iubenda\.com|cookieyes\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|amazon-adsystem\.com|adsrvr\.org|criteo\.com|taboola\.com|outbrain\.com|rubiconproject\.com|pubmatic\.com|moatads\.com|quantserve\.com|scorecardresearch\.com|google-analytics\.com|googletagmanager\.com|app-measurement\.com|segment\.io|segment\.com|mixpanel\.com|amplitude\.com|heapanalytics\.com|posthog\.com|hotjar\.com|clarity\.ms|fullstory\.com|plausible\.io|matomo\.cloud|statcounter\.com|nr-data\.net|browser-intake-datadoghq\.com|sentry\.io|bugsnag\.com|lr-ingest\.io)$/i;
const BACKGROUND_WORD = /^(consent|cmp|fundingchoices\w*|ads?|adservice|pixel|analytics|telemetry|tracking)$/i;
export const backgroundHost = (hostname: string): boolean => BACKGROUND_DOMAIN.test(hostname) || hostname.slice(0, -baseDomain(hostname).length).split(/[.-]/).some((word) => BACKGROUND_WORD.test(word));
/**
 * A tag manager's container: served from an analytics host, but its job is to add other code to the
 * page (a chat widget, a form's script), and a button may do no more than tell it that it was pressed
 * (a push onto its data layer). Kept away, it's a background request like any tag, so a page with one
 * can still have a dead button; only a press that told it something isn't one (see confirmNothing).
 * Says the name of the data layer it reads, or undefined for any other request.
 */
const tagManager = (url: URL): string | undefined => (/(^|\.)googletagmanager\.com$/i.test(url.hostname) && /^\/gtm\.js$/i.test(url.pathname) ? url.searchParams.get("l") || "dataLayer" : undefined);
/**
 * What a page puts off for its first seconds is run ahead before one of its buttons is called dead
 * (see settlesAhead): loaders that wait for the page to be drawn ask for their script within these.
 */
const AHEAD_MS = 15_000;
/** How long a press gets to do something (anything at all) before it counts as having done nothing. */
const NOTHING_WAIT_MS = 1500;
/** The second, careful look at a button that seemed to do nothing: a longer wait, from a fresh load. */
const NOTHING_CONFIRM_MS = 2000;
/** Buttons that may rightly do nothing as a page first loads: closing what isn't open, undoing nothing, the last page of a list. */
const MAY_DO_NOTHING = /close|dismiss|cancel|hide|collapse|clear|reset|undo|redo|back|prev|next|less|^[×x✕‹›«»<>←→]$|^\d+$/i;
/** The most the careful second looks may spend on one page: a slow page must not eat the run's other pages. */
const NOTHING_BUDGET_MS = 8000;
/** A label that says it works on what's been chosen: with nothing chosen, doing nothing is right. */
const NAMES_A_SELECTION = /\b(selected|selection|checked|ticked|chosen|bulk)\b/i;
/** A script error counts if it came within this long of a press or a page load of ours. */
const CRASH_WINDOW_MS = 2000;
/** What follows one of our made-up answers this soon may be our doing: an app surprised by the reply. */
const AFTER_OUR_ANSWER_MS = 3000;
/** How long a press still explains a write that follows it. */
const PRESS_EXPLAINS_MS = 5000;
/**
 * What code leaves in an address when it builds it from a field our made-up answer doesn't have:
 * /items/undefined, ?slug=null, /users/[object Object]. Ours whenever we've answered anything.
 */
const MISSING_VALUE = /^(undefined|null|NaN|\[object Object\])$/;
const hasMissingValue = (url: URL) => decoded(url.pathname).split("/").some((part) => MISSING_VALUE.test(part)) || [...url.searchParams.values()].some((v) => MISSING_VALUE.test(v));
/**
 * Errors that are the network's (reported as failed requests), the browser's, hidden from us, or
 * ours: a page finding a connection missing that the learner took away (see noLooseSockets).
 */
const NOT_A_CRASH = /^(uncaught )?(script error\.?$|resizeobserver loop)|failed to fetch|networkerror|load failed|aborterror|the (operation|user) (was )?aborted|signal is aborted|net::err_|\b(SharedWorker|WebTransport|WebSocketStream|RTCPeerConnection)\b/i;
/** Network errors that are the server's or the network's doing, not ours (we abort, and navigating away cancels). */
const SERVER_UNREACHABLE = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_NAME_NOT_RESOLVED|ERR_INVALID_RESPONSE/;
/** A page that says it's missing: a 404 that shows the app instead (a single-page app's fallback) is no broken link. */
const SAYS_MISSING = /not found|404|doesn.t exist|does not exist|no longer (exists|available)|page (is )?missing|can.t be found|cannot be found/i;
const FINDING_ORDER: Finding["kind"][] = ["crashes", "request_fails", "broken_link", "does_nothing"];
/**
 * A page that answers 200 but says it's missing (a "soft 404"), by its main heading or title: "Page
 * not found", "404", "This page doesn't exist". Only the whole heading counts, so a report called
 * "404 errors this week" or a "Lost and found" page is still a screen.
 */
const SOFT_MISSING = /^(?:error\s*)?404(?:\s*(?:[-:|–—]|error\b|not found\b|page\b)|$)|^(?:(?:the )?page )?not found\b|\b(?:page|file|content)\s+(?:was\s+)?not\s+found\b|(?:could\s*n.t|can.?t|cannot)\s+be\s+found|(?:does\s*n.t|does not|no longer)\s+exists?\b/i;
/** Longer than this, a page is a real page that mentions "not found", not a missing-page notice. */
const SOFT_MISSING_MAX_TEXT = 1500;
/**
 * The most private answer a cookie banner offers, in its common wordings ("Reject all", "Reject
 * optional", "Necessary cookies only", "Continue without accepting"). Never one that accepts
 * anything optional: "Accept optional" and "Accept all" don't match, "Accept only essential" does.
 */
export const DECLINE_COOKIES = /^(?:(?:reject|decline|refuse|deny|disable|disallow)(?: all| optional| non-?essential| additional| other| unnecessary)?(?: cookies)?|(?:(?:only|use|allow|accept|continue with|save) )?(?:only )?(?:strictly )?(?:necessary|essential|required)(?: cookies)?(?: only)?|continue without (?:accepting|agreeing|cookies)|no,? thanks|(?:i )?(?:do not|don.t) (?:accept|agree|consent))$/i;
/** How long a page gets to draw something worth reading (a heading, or its main text) before it's read anyway. */
const CONTENT_WAIT_MS = 3000;
/** The site's own requests stopping for this long counts as the page having loaded what it needs. */
const QUIET_MS = 500;
/** How long the page and its made-up rows stay still before a pass that reads only counts reads them. */
const STILL_NOW_MS = 600;
/** The least time a page gets for its forms and buttons, however little of the run is left per page. */
const PAGE_MIN_MS = 6000;

/** The file a folder's app opens with: /parabank/index.htm, /app/default.aspx. */
const FRONT_DOOR = /^(?:index|default|home|main|start)\.[A-Za-z0-9]+$/i;

/**
 * The part of a site a start address is about. Only a start that plainly names a folder keeps to
 * it: one ending in "/" (/examples/react/dist/). A start through a script that serves the whole app
 * (/web/index.php/auth/login) keeps to the script's folder (/web/), as does a folder's front door
 * (/parabank/index.htm → /parabank/). Anything else is one screen, not a folder: a start at
 * /posts/new or /app/dashboard says nothing about the app stopping at /posts/ or /app/, and the
 * sections beside it are as much the product, so the learner has the whole site, as from "/".
 */
export function scopeOf(pathname: string): string {
  const parts = pathname.split("/");
  // A part before the last that looks like a file (index.php, app.cgi) is the app's front door.
  const script = parts.slice(0, -1).findIndex((part, i) => i > 0 && /\.[A-Za-z0-9]+$/.test(part));
  if (script > 0) return `${parts.slice(0, script).join("/")}/`;
  if (pathname.endsWith("/")) return pathname;
  return FRONT_DOOR.test(parts.at(-1) ?? "") ? pathname.replace(/[^/]*$/, "") : "/";
}

/** Whether a path is inside a scope: the folder itself, with or without its last "/", or below it. */
export function inScope(pathname: string, scope: string): boolean {
  const folder = scope.replace(/\/+$/, "");
  return folder === "" || pathname === folder || pathname.startsWith(`${folder}/`);
}

/** The deepest folder two paths share: where a start that redirected elsewhere still belongs. */
function sharedFolder(a: string, b: string): string {
  const x = a.split("/").slice(1, -1);
  const y = b.split("/").slice(1, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return `/${x.slice(0, n).map((part) => `${part}/`).join("")}`;
}

/** Whether a page that loaded fine is a "missing page" notice, from its main heading or title and how much it says. */
export function saysMissing(page: { title: string; heading: string; textLength: number }): boolean {
  if (page.textLength > SOFT_MISSING_MAX_TEXT) return false;
  // A title is usually "<what> | <site>": its first part is what the page says it is.
  const title = page.title.split(/\s+[|·–—-]\s+/)[0] ?? "";
  return [page.heading, title].some((text) => SOFT_MISSING.test(text.trim()));
}

/**
 * Runs in the page before anything else: counts everything a press could do that leaves no mark on
 * the page's structure (copying, storing, playing, scrolling, sending on a live connection), and
 * every change to that structure, so "nothing happened" can be proved rather than guessed. The
 * learner's own marks (data-ctx-*) and the snippet's own storage are left out.
 */
function watchEffects() {
  type Fn = (...args: unknown[]) => unknown;
  const seen = { changes: 0, effects: 0, lastChange: 0, active: null as Element | null, snap: () => "", same: (_: string) => false, ahead: async (_: number, _fromNow?: boolean): Promise<number | "busy"> => 0 };
  Object.defineProperty(window, "__ctxSeen", { value: seen });
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.attributeName?.startsWith("data-ctx")) continue;
      seen.changes++;
      seen.lastChange = performance.now();
    }
  });
  const watch = (root: Node) => observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  watch(document);
  const count = (owner: object | undefined, name: string, when?: (self: unknown, args: unknown[]) => boolean) => {
    const o = owner as Record<string, Fn> | undefined;
    const original = o?.[name];
    if (!o || typeof original !== "function") return;
    o[name] = function (this: unknown, ...args: unknown[]) {
      if (!when || when(this, args)) seen.effects++;
      return original.apply(this, args);
    };
  };
  // Components draw inside their own shadow roots, which the page's observer can't see into.
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = attach.call(this, init);
    watch(root);
    return root;
  };
  // A keepalive fetch outlives its page, so it's what trackers use, but the browser doesn't say so
  // of a request: told to the learner here (see noteWrite).
  const fetched = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (init?.keepalive || (input instanceof Request && input.keepalive)) {
      const tell = (window as unknown as { __ctxKeepalive?: (url: string, method: string) => void }).__ctxKeepalive;
      tell?.(new URL(input instanceof Request ? input.url : String(input), location.href).href, init?.method ?? (input instanceof Request ? input.method : "GET"));
    }
    return fetched.call(this, input as RequestInfo, init);
  } as typeof fetch;
  const notOurs = (_: unknown, args: unknown[]) => !String(args[0]).startsWith("ctx:");
  count(Storage.prototype, "setItem", notOurs);
  count(Storage.prototype, "removeItem", notOurs);
  count(Storage.prototype, "clear");
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (cookie?.set) {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: cookie.get,
      set(value: string) {
        if (!String(value).startsWith("__ctx_visit")) seen.effects++;
        cookie.set!.call(this, value);
      },
    });
  }
  if (typeof Clipboard !== "undefined") for (const name of ["writeText", "write"]) count(Clipboard.prototype, name);
  for (const name of ["execCommand"]) count(Document.prototype, name);
  for (const name of ["pushState", "replaceState", "back", "forward", "go"]) count(History.prototype, name);
  for (const name of ["open", "postMessage", "scrollTo", "scrollBy", "scroll", "alert", "confirm", "prompt", "print", "focus"]) count(window, name);
  for (const name of ["scrollIntoView", "scrollTo", "scrollBy", "requestFullscreen", "requestPointerLock"]) count(Element.prototype, name);
  for (const name of ["focus", "blur"]) count(HTMLElement.prototype, name);
  // A hidden file field opened by a button, a form checked or sent from code.
  for (const name of ["click", "showPicker", "select", "setCustomValidity"]) count(HTMLInputElement.prototype, name);
  for (const name of ["submit", "requestSubmit", "reportValidity", "reset"]) count(HTMLFormElement.prototype, name);
  for (const name of ["play", "pause", "load"]) count(HTMLMediaElement.prototype, name);
  // A sound made in code (a "Test sound" button) leaves no mark on the page either.
  count(typeof AudioScheduledSourceNode !== "undefined" ? AudioScheduledSourceNode.prototype : undefined, "start");
  for (const name of ["show", "showModal", "close"]) count(typeof HTMLDialogElement !== "undefined" ? HTMLDialogElement.prototype : undefined, name);
  count(WebSocket.prototype, "send");
  count(typeof Worker !== "undefined" ? Worker.prototype : undefined, "postMessage");
  count(typeof MessagePort !== "undefined" ? MessagePort.prototype : undefined, "postMessage");
  count(typeof BroadcastChannel !== "undefined" ? BroadcastChannel.prototype : undefined, "postMessage");
  if (typeof IDBObjectStore !== "undefined") for (const name of ["put", "add", "delete", "clear"]) count(IDBObjectStore.prototype, name);
  for (const name of ["share", "vibrate", "requestMIDIAccess"]) count(navigator, name);
  if (typeof speechSynthesis !== "undefined") count(speechSynthesis, "speak");
  if (typeof Notification !== "undefined") count(Notification as unknown as object, "requestPermission");
  // Asking the browser for something it shows itself (where you are, the camera, a saved sign-in, a
  // payment sheet, a file or a device): a person sees a prompt or a picker, though the page doesn't
  // change, and this headless browser answers "no" without showing anything.
  if (typeof Clipboard !== "undefined") for (const name of ["readText", "read"]) count(Clipboard.prototype, name);
  if (typeof Geolocation !== "undefined") for (const name of ["getCurrentPosition", "watchPosition"]) count(Geolocation.prototype, name);
  if (typeof MediaDevices !== "undefined") for (const name of ["getUserMedia", "getDisplayMedia", "selectAudioOutput"]) count(MediaDevices.prototype, name);
  if (typeof CredentialsContainer !== "undefined") for (const name of ["get", "create", "store"]) count(CredentialsContainer.prototype, name);
  if (typeof PaymentRequest !== "undefined") for (const name of ["show", "canMakePayment"]) count(PaymentRequest.prototype, name);
  if (typeof Permissions !== "undefined") count(Permissions.prototype, "query");
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) count(window, name);
  const devices = navigator as unknown as Record<string, object | undefined>;
  for (const [api, name] of [["bluetooth", "requestDevice"], ["usb", "requestDevice"], ["hid", "requestDevice"], ["serial", "requestPort"]] as const) count(devices[api], name);
  for (const type of ["scroll", "hashchange", "popstate", "selectionchange"]) addEventListener(type, () => void seen.effects++, { capture: true, passive: true });
  // What's typed or ticked isn't structure: a "Clear" button that empties a field changes only values.
  const values = () => [...document.querySelectorAll("input, select, textarea")].map((f) => {
    const x = f as HTMLInputElement;
    return x.type === "checkbox" || x.type === "radio" ? String(x.checked) : x.value;
  }).join("\u0001");
  // What the page has put off until later (a timer, an interval, an animation frame, an idle
  // callback): a widget's loader asks for its script then, and the button it wires does nothing until
  // it has. Waiting it out costs seconds a page and can't tell a loader from a carousel, so each is
  // kept here and, when a button is about to be called dead, run ahead of time on a clock of the
  // page's own (see seen.ahead and settlesAhead). The originals stay at hand for the snippet, whose
  // own timers aren't the page's.
  type Later = { kind: "timer" | "frame" | "idle"; run: Fn; args: unknown[]; due: number; every?: number; id: unknown };
  const realNow = performance.now.bind(performance);
  const RealDate = Date;
  const realDate = Date.now;
  let offset = 0;
  let ahead = false;
  const now = () => realNow() + offset;
  const later = new Map<string, Later>();
  const timers = window as unknown as Record<string, Fn>;
  const original: Record<string, Fn> = {};
  for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "cancelIdleCallback"]) {
    if (typeof timers[name] === "function") original[name] = timers[name]!;
  }
  Object.defineProperty(window, "__ctxTimers", { value: original });
  /** Puts `run` off as the page asked, and keeps it, with when it's due on the page's clock. */
  const keep = (kind: Later["kind"], set: string, cancel: string, delay: (args: unknown[]) => number, every: boolean) => {
    const start = original[set];
    if (!start || !original[cancel]) return;
    timers[set] = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] !== "function") return start.apply(this, args);
      const run = args[0] as Fn;
      // Run ahead, what's put off again moves the clock on, however soon it asked: a loop that
      // re-arms itself at once can't hold the clock still.
      const wait = Math.max(ahead ? (kind === "timer" ? 4 : 50) : 0, delay(args));
      const entry: Later = { kind, run, args: kind === "timer" ? args.slice(2) : [], due: now() + wait, id: undefined };
      if (every) entry.every = Math.max(4, wait);
      args[0] = function (this: unknown, ...a: unknown[]) {
        if (entry.every) entry.due = now() + entry.every;
        else later.delete(`${kind}:${String(entry.id)}`);
        return run.apply(this, a);
      };
      entry.id = start.apply(this, args);
      later.set(`${kind}:${String(entry.id)}`, entry);
      return entry.id;
    };
  };
  keep("timer", "setTimeout", "clearTimeout", (args) => Number(args[1]) || 0, false);
  keep("timer", "setInterval", "clearInterval", (args) => Number(args[1]) || 0, true);
  keep("frame", "requestAnimationFrame", "cancelAnimationFrame", () => 16, false);
  keep("idle", "requestIdleCallback", "cancelIdleCallback", () => 0, false);
  // Either clear ends either kind of timer, as in the browser.
  for (const [cancel, kind] of [["clearTimeout", "timer"], ["clearInterval", "timer"], ["cancelAnimationFrame", "frame"], ["cancelIdleCallback", "idle"]] as const) {
    const stop = original[cancel];
    if (!stop) continue;
    timers[cancel] = function (this: unknown, ...args: unknown[]) {
      later.delete(`${kind}:${String(args[0])}`);
      return stop.apply(this, args);
    };
  }
  /**
   * Runs what the page put off, now, in the order it's due, with the page's clock (performance.now,
   * Date.now, a new Date()) moved on to each one's time: for its first `until` ms since it loaded,
   * or, `fromNow`, for `until` ms from where its clock stands, as what a first run set off (a script,
   * a fetch, a message) puts off its own work from then. What it runs is the page's own code, so
   * whatever it asks for is asked for, and a refused script is seen as refused. Says how many of
   * what it ran was code not run ahead before (a carousel's next slide is the same code again), or
   * "busy" when it never stops putting things off, so it can't be said what comes of them.
   */
  const ranBefore = new Set<string>();
  const aheadOf = async (until: number, fromNow = false, budget = 1000) => {
    if (performance.now !== now) {
      performance.now = now;
      RealDate.now = () => realDate() + offset;
      // A new Date() with nothing given is the clock too: a loader may count its seconds with it.
      (window as unknown as { Date: DateConstructor }).Date = new Proxy(RealDate, {
        construct: (target, args: unknown[], newTarget) => Reflect.construct(target, args.length ? args : [RealDate.now()], newTarget),
        apply: () => new RealDate(RealDate.now()).toString(),
      });
    }
    const end = fromNow ? now() + until : Math.max(until, now() + 100);
    // The same code run over and over (a 1ms interval) is only its own clock-watching: past its
    // first runs, it's run at most once in every slice of the time ahead, so a fast loop can't
    // pass for work that never ends, while one that watches the clock still sees it move.
    const slice = Math.max(4, (end - now()) / 400);
    const runs = new Map<string, { n: number; at: number }>();
    let ran = 0;
    let fresh = 0;
    // Timers that do real work cost real time: past its share of the run, it can't be said.
    const began = realDate();
    ahead = true;
    try {
      for (;;) {
        let next: [string, Later] | undefined;
        for (const pair of later) if (pair[1].due <= end && (!next || pair[1].due < next[1].due)) next = pair;
        if (!next) break;
        const [key, entry] = next;
        const code = String(entry.run).slice(0, 500);
        const often = runs.get(code) ?? { n: 0, at: -Infinity };
        if (often.n >= 50 && entry.due < often.at + slice) {
          entry.due = often.at + slice;
          continue;
        }
        if (++ran > 4000 || realDate() - began > budget) return "busy" as const;
        if (entry.due > now()) offset += entry.due - now();
        runs.set(code, { n: often.n + 1, at: now() });
        if (!ranBefore.has(code)) {
          ranBefore.add(code);
          fresh++;
        }
        if (entry.every) entry.due = now() + entry.every;
        else {
          later.delete(key);
          original[entry.kind === "timer" ? "clearTimeout" : entry.kind === "frame" ? "cancelAnimationFrame" : "cancelIdleCallback"]?.call(window, entry.id);
        }
        try {
          entry.run.apply(window, entry.kind === "frame" ? [now()] : entry.kind === "idle" ? [{ didTimeout: false, timeRemaining: () => 50 }] : entry.args);
        } catch {
          // the page's own error, run early: nothing to go on
        }
        // What it chained on a promise runs before the next one, as it would have.
        for (let i = 0; i < 4; i++) await null;
      }
    } finally {
      ahead = false;
    }
    if (now() < end) offset += end - now();
    return fresh;
  };
  seen.ahead = aheadOf;
  seen.snap = () => {
    seen.active = document.activeElement;
    return [seen.changes, seen.effects, location.href, scrollX, scrollY, values()].join("|");
  };
  // The focus moving onto the button the learner is pressing (see confirmNothing) is the click, not its effect.
  seen.same = (before: string) => {
    const active = document.activeElement;
    return (active === seen.active || active?.hasAttribute("data-ctx-pressing") === true) && seen.snap() === before;
  };
}

/**
 * Runs in the page: whether the document is data rather than a page. Its body is a single JSON
 * value (an API's answer sent as text/html), alone or in a lone <pre> as a browser shows JSON; or
 * bare text in a document with no script that could draw anything. Marks of the learner's own are
 * left out.
 */
function isDataDocument(): boolean {
  const body = document.body;
  if (!body) return false;
  const kids = [...body.children].filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(el.tagName) && !el.getAttributeNames().some((a) => a.startsWith("data-ctx")));
  const own = [...body.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? "").join("").trim();
  const text = kids.length === 0 ? own : kids.length === 1 && kids[0]!.tagName === "PRE" && !own ? (kids[0]!.textContent ?? "").trim() : "";
  if (!text) return false;
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  return kids.length === 0 && document.scripts.length === 0;
}

/** Runs in the page: the lines of text on it now, to tell later what's new. */
function readLines(): string[] {
  return (document.body?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3000);
}

/**
 * Runs in the page, after a save that went nowhere: what the browser and the page say about each
 * field in `root` (a form, the open pop-up, or with none the fields outside any form). The browser's
 * validity and limits; aria-invalid and what aria-describedby links to; the words beside the field;
 * and anything that's newly on the page and reads as an error. Each field is marked to be found again.
 */
function readRejection({ root, before, wrong, place }: { root: string | null; before: string[]; wrong: string; place: string }): Rejection | null {
  const scopes = root ? [...document.querySelectorAll(root)] : [document.body];
  const area = scopes[scopes.length - 1];
  if (!area) return null;
  const known = new Set(before);
  const WRONG = new RegExp(wrong, "i");
  const fresh = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l && l.length <= 200 && !known.has(l));
  const inPlace = new Set([...document.querySelectorAll(place)].flatMap((el) => fresh((el as HTMLElement).innerText ?? "")));
  const message = [...new Set(fresh(document.body.innerText ?? ""))].filter((l) => inPlace.has(l) || WRONG.test(l));
  const FIELDS = "input, select, textarea";
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest("[hidden],[aria-hidden=true]"); };
  for (const el of document.querySelectorAll("[data-ctx-fix]")) el.removeAttribute("data-ctx-fix");
  const fields: FieldState[] = [];
  [...area.querySelectorAll(FIELDS)].forEach((el, i) => {
    const f = el as HTMLInputElement;
    const type = (f.getAttribute("type") || f.tagName).toLowerCase();
    if (!shown(f) || f.disabled || f.readOnly || (!root && f.closest("form")) || ["hidden", "submit", "button", "reset", "image", "search"].includes(type)) return;
    f.setAttribute("data-ctx-fix", String(i));
    const linked = ["aria-describedby", "aria-errormessage"].flatMap((a) => (f.getAttribute(a) ?? "").split(/\s+/)).flatMap((id) => (id ? [document.getElementById(id)?.textContent ?? ""] : []));
    // The widest group around it with no other field: its label, its hint, its own error.
    let around: Element = f;
    while (around.parentElement && around.parentElement !== area && around.parentElement.querySelectorAll(FIELDS).length === 1) around = around.parentElement;
    const beside = f.tagName === "SELECT" ? "" : ((around as HTMLElement).innerText ?? "").slice(0, 300);
    const own = fresh(`${beside}\n${linked.join("\n")}`).filter((l) => message.includes(l) || WRONG.test(l));
    const select = f as unknown as HTMLSelectElement;
    fields.push({
      mark: String(i), tag: f.tagName.toLowerCase(), type, inputMode: f.getAttribute("inputmode") ?? "",
      hint: `${f.name} ${f.id} ${f.getAttribute("placeholder") ?? ""} ${f.labels?.[0]?.textContent ?? ""} ${f.getAttribute("aria-label") ?? ""}`.toLowerCase(),
      placeholder: f.getAttribute("placeholder") ?? "",
      value: type === "checkbox" || type === "radio" ? (f.checked ? "checked" : "") : f.value,
      min: f.getAttribute("min") ?? "", max: f.getAttribute("max") ?? "", step: f.getAttribute("step") ?? "",
      minLength: f.tagName === "SELECT" ? -1 : f.minLength, maxLength: f.tagName === "SELECT" ? -1 : f.maxLength, pattern: f.getAttribute("pattern") ?? "",
      invalid: !f.validity.valid,
      flagged: f.getAttribute("aria-invalid") === "true" || own.length > 0 || f.matches(".is-invalid, .invalid, .input-error, .ng-invalid.ng-touched"),
      says: [f.validationMessage, ...linked, beside].join(" ").replace(/\s+/g, " ").trim().slice(0, 500),
      ...(f.tagName === "SELECT" ? { options: [...select.options].filter((o) => o.value && !o.disabled).map((o) => o.value) } : {}),
    });
  });
  return { fields, message: message.slice(0, 4).join(" ") };
}

/**
 * Domains where each name below is someone else's site (anyone's app on herokuapp.com, vercel.app,
 * github.io): two hosts under one of these share nothing. The best known of the Public Suffix
 * List's shared hosting entries.
 */
const SHARED_HOSTING = /(^|\.)(github\.io|gitlab\.io|herokuapp\.com|vercel\.app|netlify\.app|pages\.dev|workers\.dev|web\.app|firebaseapp\.com|appspot\.com|azurewebsites\.net|azurestaticapps\.net|cloudfront\.net|amazonaws\.com|onrender\.com|fly\.dev|railway\.app|glitch\.me|surge\.sh|ngrok\.io|ngrok-free\.app|ngrok\.app|blogspot\.com|wordpress\.com|wixsite\.com|myshopify\.com|repl\.co|replit\.app|deno\.dev|csb\.app|stackblitz\.io|webflow\.io|framer\.app|bubbleapps\.io|translate\.goog)$/i;

/**
 * The registrable part of a host (app.acme.co.uk → acme.co.uk), so a site's own script host and its
 * API host (api.acme.com) count as its own. A host on shared hosting is a site to itself.
 */
function baseDomain(hostname: string): string {
  if (SHARED_HOSTING.test(hostname)) return hostname;
  const parts = hostname.split(".");
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1)!)) return hostname;
  const n = parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3 ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** The browser's own User-Agent with ours after it: what it would say to any site, and who is asking. */
async function visitorAgent(browser: Browser): Promise<string> {
  const blank = await browser.newPage();
  try {
    return `${await blank.evaluate(() => navigator.userAgent)} ${USER_AGENT}`;
  } finally {
    await blank.close();
  }
}

/**
 * Error text with its opaque runs taken out whole, before anything cuts it short: 24 or more hex or
 * base64-like characters holding a digit or as many capitals as random text has. A long word, a
 * camelCase name or a CONSTANT_NAME stays.
 */
export function withoutTokens(text: string): string {
  return text.replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, (run) => {
    const capitals = run.replace(/[^A-Z]/g, "").length;
    return /\d/.test(run) || /^[0-9a-f]+$/i.test(run) || (/[a-z]/.test(run) && capitals * 4 >= run.length) ? "…" : run;
  });
}

/** An error's first line, short, with anything that looks like someone's details taken out, a word with a long number whole. */
export function firstLine(text: string): string {
  return withoutTokens((text.split("\n")[0] ?? "").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "…@…")).replace(/[\w-]*\d{6,}[\w-]*/g, "…").trim().slice(0, 160);
}

/**
 * Learns a site: the public crawl, then, when config.standIn asks for it, the stand-in pass. With
 * no standIn, this is the public crawl and nothing else.
 */
export async function scanSite(config: ScanConfig, env: Record<string, string | undefined> = process.env): Promise<ScanResult> {
  const { standIn, ...plain } = config;
  const told = new Map<string, ScreenCheck>();
  /** Says each check once. What's said is kept: however a pass ends, nothing said goes missing from the result. */
  const tell: Tell = (checks) => {
    const fresh = checks.filter((check) => {
      const key = [check.kind, check.target, check.by ?? "", check.at ?? "", check.seenWith ?? "", check.newUser ?? "", check.screen].join("|");
      return told.has(key) ? false : Boolean(told.set(key, check));
    });
    try {
      if (fresh.length) config.onChecks?.(fresh);
    } catch {
      // only a report of what was seen
    }
  };
  if (!standIn) {
    const result = await crawlSite({ ...plain, measured: (seen) => tell(seen.checks) }, env);
    tell(result.checks);
    result.checks = mergeChecks(result.checks);
    return result;
  }
  plain.stayLocal ??= standInRefusal(config) === undefined;
  const walls = new Set<string>();
  // A check at an address that was only a wall is dropped if the stand-in gets past it, so it isn't told.
  const public_ = (checks: readonly ScreenCheck[]) => checks.filter((check) => !walls.has(withoutView(check.screen)));
  let crawled: () => void = () => {};
  const crawlOver = new Promise<void>((done) => (crawled = done));
  let pass: Promise<StandInReport | undefined> | undefined;
  let finished: ScanResult | undefined;
  const merge = () => {
    if (finished) finished.checks = mergeChecks([...finished.checks, ...told.values()]);
  };
  /** What's behind the sign-in goes on beside the pressing: two browsers with nothing between them. Given all there is to know so far, and the crawl itself to read at the end. */
  const begin = (seen: ScanResult, crawl: ScanResult, whole: boolean) => {
    pass = (async () => {
      const asked = typeof standIn === "function" ? await standIn(seen, [...walls]) : standIn;
      const merged = config.onLastLook && ((look: Promise<void>) => config.onLastLook!(look.then(merge)));
      return asked ? standInPass(asked, { ...config, ...(merged ? { onLastLook: merged } : {}) }, crawl, walls, env, tell, crawlOver, whole) : undefined;
    })();
    // Waited for below: a failure here is the run's to report, once the crawl is over.
    pass.catch(() => {});
  };
  const crawlBegun = Date.now();
  const result = await crawlSite({
    ...plain,
    measured: (seen) => tell(public_(seen.checks)),
    onWall: (seen, whole) => begin({ ...seen, pagesVisited: [...seen.pagesVisited], events: [...seen.events], errorPages: [...seen.errorPages] }, seen, whole),
    // The run isn't finishing while what's behind the sign-in has only begun.
    onProgress: (p) => config.onProgress?.(pass && p.phase === "finishing" ? { ...p, phase: "exploring" } : p),
  }, env, undefined, walls).finally(() => {
    crawled();
    config.onStage?.({ kind: "public-over" });
  });
  result.timings["public pass"] = Date.now() - crawlBegun;
  tell(public_(result.checks));
  if (!pass) begin(result, result, true);
  const report = await pass;
  if (report) result.standIn = report;
  finished = result;
  merge();
  return result;
}

/**
 * Where a run with a sign-in in the way has got to. public-over: the public crawl is done. waiting:
 * the new account has been walked, and the stand-in's pass with rows waits for what the AI is making,
 * if anything, then goes on beside the pressing. new-user: the new account's walk, as it will be
 * reported, once the public crawl is over too.
 */
export type ScanStage = { kind: "public-over" } | { kind: "waiting" } | { kind: "new-user"; walk: NewUserReport };

/** Says what can't be taken back, each thing once (see ScanConfig.onChecks). A listener's mistake never stops the learning. */
type Tell = (checks: readonly ScreenCheck[]) => void;

/** What a page asks for by itself, as opposed to a page, a script, a style or a picture it needs to draw. */
const PAGE_CALLS = new Set(["fetch", "xhr", "eventsource", "ping"]);

const withoutView = (path: string) => path.replace(/\/~[^/]*$/, "") || "/";

const STAND_IN_MESSAGES = {
  no_adapter: "Nothing the stand-in user opened asked for a session it could answer, so only the public pages were learned.",
  not_rendered: "The stand-in user got no further than the public pages, so nothing from that pass was kept.",
  not_checked: "The app's own page couldn't be read in time, so nothing shows the browser decides who sees it. The stand-in user didn't start.",
  not_shown: "The stand-in user got something to draw, but nothing shows it's a screen of the product, so nothing from that pass was kept.",
  server: "The server draws this app's pages itself, so a stand-in user in the browser can't reach them. Only the public pages were learned.",
};

/** Whether reading this address could do anything: the same test a link in the crawl must pass. */
const plainRead = (url: URL) => linkActs(url, undefined, true) === undefined && !changesList(url) && !graphqlGetActs(url);

/**
 * The second pass, in a new browser with nothing of the first in it. Everything that can stop it
 * stops it before the app is loaded, and comes back as a status: a pass that didn't work never
 * reads as one that did. What it learned goes into the result only if it reached something.
 */
async function standInPass(standIn: StandInConfig, config: ScanConfig, result: ScanResult, walls: Set<string>, env: Record<string, string | undefined>, tell: Tell, crawlOver: Promise<void>, publicKnown: boolean): Promise<StandInReport> {
  const report = (status: StandInReport["status"], message: string, extra: Partial<StandInReport> = {}): StandInReport => ({ status, message, reached: [], notReached: [], asked: [], errors: [], ...extra });
  const refused = standInRefusal(config);
  if (refused) return report("refused", refused);
  // Where the public crawl landed is the site. A move to anywhere else isn't what was asked for.
  const start = new URL(new URL(config.startUrl).pathname + new URL(config.startUrl).search, result.startOrigin);
  const away = standInRefusal({ startUrl: start.href });
  if (away) return report("refused", away);
  if (config.signal?.aborted) return report("skipped", "The run was stopped before the stand-in user could start.");
  if (result.startError || result.startLeftFor || result.startStatus === undefined || result.startStatus >= 500) return report("skipped", "The site didn't load, so the stand-in user didn't start.");
  // A sign-in form drawn at a protected address says nothing about what's there: to the pass, that
  // address is still to be seen.
  let publicScreens = result.pagesVisited.filter((path) => !walls.has(path));
  const wallsBefore = new Set(walls);
  const sealFor = (given: StandInConfig) => new Seal({ start, config: { ...given, proxied: [...(given.proxied ?? []), ...(config.proxied ?? [])] }, publicScreens, opened: walls, background: backgroundHost, graphqlRead: (body, type) => onlyGraphqlReads(body, type), readable: plainRead });
  let seal = sealFor(standIn);
  if (seal.unknownProvider) return report("unknown_provider", `The stand-in user doesn't know the sign-in library "${firstLine(standIn.provider ?? "")}", so only the public pages were learned.`, { notReached: seal.notReached });
  const serverSays = (path: string | undefined) => report("server_auth", path ? `The server decides what ${path} shows, so a stand-in user in the browser can't reach it. Only the public pages were learned.` : STAND_IN_MESSAGES.server, { notReached: seal.notReached });
  /** Whether the server stands in the way of this seal's addresses, leaving out those already read. */
  const serverStops = async (known: ReadonlySet<string>): Promise<StandInReport | undefined> => {
    const server = await serverDecides(start, seal.addresses.filter((href) => seal.isPage(new URL(href)) && seal.mayAsk(new URL(href)) && !known.has(href)), (url) => plainRead(url) && seal.isPage(url));
    seal.shell = server.shell;
    if (server.unread) return report("not_checked", STAND_IN_MESSAGES.not_checked, { notReached: seal.notReached });
    // Named only if it's true of that page: one it sent away, or one of its own that isn't for everybody anyway.
    if (server.bounced || server.own?.length) return serverSays(server.bounced ?? server.own?.find((path) => !seal.publicScreens.has(path) && !SIGN_IN_PATH.test(path)));
    return undefined;
  };
  const stops = await serverStops(new Set());
  if (stops) return stops;

  const { standIn: _standIn, stayLocal: _stayLocal, origins: _origins, siteOrigins: _siteOrigins, onFinding: _onFinding, onChecks: _onChecks, onLastLook: _onLastLook, onJourneys, onStage: _onStage, onPressing: _onPressing, ...shared } = config;
  // The new account goes first: a first run is what matters most, and it's quick. It comes out of
  // the same time limit, so a full pass can't leave it none and it can't add to the run.
  const limit = standIn.maxDurationMs ?? config.maxDurationMs ?? 120_000;
  const walkBegun = Date.now();
  const saw: { nowhere?: Drawing; addresses?: Record<string, string> } = {};
  // The journeys need what a new account meets first, and no more: they start once the walk has drawn that, and take its other screens as they come.
  let journeys: JourneysFed | undefined;
  const journeysAt = (nowhere: Drawing | undefined, addresses: Record<string, string>) => ({ start, shell: seal.shell, publicScreens, walls: [...walls], nowhere, addresses });
  const seen = onJourneys ? (so: NewUserSoFar) => {
    if (journeys) return journeys.more(so);
    // The first run is walked first, so it has to be among them: on the screens, or every way to it opened.
    const firstRunOn = findJourneys({ screens: so.screens, first: so.screens[0]?.path, firstRun: so.firstRun.filter((f) => f.opened && !f.landed).map((f) => f.path) }).journeys.some((journey) => journey.firstRun);
    if (!firstRunOn && !so.firstKnown) return;
    journeys = walkJourneys(standIn, shared, journeysAt(so.nowhere, so.addresses), { ...so, first: so.screens[0]?.path }, result, env);
    onJourneys(journeys);
  } : undefined;
  // With the look cut short, a page it hadn't got to can't be told from the new account's own, so what's said waits for the crawl.
  result.newUser = await newUserWalk(standIn, shared, { start, shell: seal.shell, publicScreens, walls: [...walls], limitMs: Math.min(WALK_MOST_MS, limit * WALK_SHARE), sayNow: publicKnown, saw, ...(seen ? { seen } : {}) }, result, env, tell);
  if (publicKnown) tell(result.checks.filter((check) => check.newUser));
  const walked = Date.now() - walkBegun;
  if (onJourneys && result.newUser.status === "walked") {
    const all = { screens: result.newUser.screens, firstRun: result.newUser.firstRun, addresses: saw.addresses ?? {} };
    if (journeys) journeys.more(all);
    else onJourneys(journeys = walkJourneys(standIn, shared, journeysAt(saw.nowhere, saw.addresses ?? {}), { ...all, first: result.newUser.first }, result, env));
  }
  // Whatever the walk came to, no more of its screens are coming.
  journeys?.walkOver(result.newUser.status === "walked");
  // Only now does the browser need what the AI was making while it walked. A wait that's ended by Ctrl-C isn't waited out.
  const stopped = new Promise<undefined>((done) => config.signal?.addEventListener("abort", () => done(undefined), { once: true }));
  config.onStage?.({ kind: "waiting" });
  const more = standIn.later ? await Promise.race([standIn.later, stopped]) : undefined;
  /**
   * The pass with rows, under a seal made from what's known now. It only reads addresses, so it
   * needn't wait for the pressing. The seal's public screens are those known when it begins, and
   * they decide what the pass skips as learned, what counts as sent away, and which screens get the
   * signed-out look: a public screen the pressing finds later costs this pass a visit, and may be
   * told as the stand-in's while it runs, but it's the public crawl's all the same once both are
   * over (see fresh below), so nothing reported comes of it.
   */
  const rowsPass = async (): Promise<{ crawl: ScanResult; walls: Set<string> } | StandInReport> => {
    const read = new Set(seal.addresses);
    const wallsNow = new Set(walls);
    seal = sealFor({ ...standIn, ...more, addresses: [...new Set([...(more?.addresses ?? standIn.addresses ?? []), ...[...wallsNow].filter((path) => !wallsBefore.has(path))])] });
    const stopsNow = await serverStops(read);
    if (stopsNow) return stopsNow;
    const opened = result.pagesVisited.length;
    const earlier = Object.values(result.timings).reduce((sum, ms) => sum + ms, 0);
    try {
      const crawl = await crawlSite({
        ...shared,
        startUrl: start.href,
        maxPages: standIn.maxPages ?? config.maxPages ?? 50,
        // The walk came out of this limit; the wait for the AI didn't, and isn't the browser's time.
        maxDurationMs: Math.max(1000, limit - walked),
        // Masked, as for anyone signed in: nothing here is true, and it mustn't read as if it were.
        keepNumbers: false,
        // Pressing here gives no finding, so what this pass is for is measuring every screen it can reach, and then it's over.
        looksOnly: true,
        onScreen: (path, n, named) => config.onScreen?.(path, opened + n, named, true),
        // Told as one run: the public crawl's own "finishing" isn't the end of it.
        onProgress: (p) => config.onProgress?.({ ...p, screens: opened + p.screens, maxPages: (config.maxPages ?? 50) + (standIn.maxPages ?? config.maxPages ?? 50), elapsedMs: earlier + p.elapsedMs, phase: p.phase === "opening" ? "exploring" : p.phase }),
      }, env, seal);
      return { crawl, walls: wallsNow };
    } catch (error) {
      if (!seal.held) return report("seal_failed", `The stand-in user didn't run: ${message(error)}. The app was never opened that way.`);
      return report("not_rendered", STAND_IN_MESSAGES.not_rendered, { ...(seal.adapter ? { provider: seal.adapter } : {}), notReached: seal.notReached, asked: seal.asked, errors: [message(error)] });
    }
  };
  const early = rowsPass();
  // What the new account saw is only its own once every public page is known: it's said then, whether or not the pass with rows is over.
  await crawlOver;
  publicScreens = result.pagesVisited.filter((path) => !walls.has(path));
  result.newUser = withoutPublic(result.newUser, publicScreens);
  config.onStage?.({ kind: "new-user", walk: result.newUser });
  result.checks = result.checks.flatMap((check) => {
    if (!check.newUser) return [check];
    const screens = check.screens.filter((path) => !publicScreens.includes(path));
    return screens.length ? [{ ...check, screen: screens[0]!, screens }] : [];
  });
  tell(result.checks.filter((check) => check.newUser));
  const first = await early;
  // Pressing may have found an address that only showed a sign-in after the pass began: the pass goes by every one of them, so it goes again. Rare, as the code read names most.
  const rows = !("status" in first) && !config.signal?.aborted && [...walls].some((path) => !first.walls.has(path)) ? await rowsPass() : first;
  if ("status" in rows) return rows;
  const pass = rows.crawl;
  if (pass.stoppedBy === "interrupted") result.stoppedBy = "interrupted";
  const fresh = pass.pagesVisited.filter((path) => !publicScreens.includes(path) && !seal.openToAll.has(path));
  const sorted = seal.sort(fresh);
  seal.notReached.push(...sorted.unclear.map((path) => ({ path, why: "unclear" as const })), ...sorted.notShown.map((path) => ({ path, why: "not_shown" as const })));
  const notReached = [...seal.notReached, ...pass.errorPages.map(({ path }) => ({ path, why: "error_page" as const }))];
  const about = { ...(seal.adapter ? { provider: seal.adapter } : {}), notReached, asked: seal.asked, errors: pass.errors, stoppedBy: pass.stoppedBy, rowsShown: sorted.withData.length > 0 };
  if (seal.serverDecided) return serverSays(seal.serverDecided);
  if (!seal.adapter) return report("no_adapter", STAND_IN_MESSAGES.no_adapter, about);
  // A screen that drew with the session never read drew without it: a public page the first crawl
  // didn't get to, and nothing the stand-in can say it reached.
  if (fresh.length === 0 || !seal.sessionRead) {
    const hint = seal.sessionRead ? "" : " The app didn't read the session where the stand-in expected it: it may keep it under a key of its own (storageKey).";
    return report("not_rendered", `${STAND_IN_MESSAGES.not_rendered}${hint}`, about);
  }
  if (sorted.shown.length === 0) return report("not_shown", STAND_IN_MESSAGES.not_shown, about);
  const notNew = new Set(result.checks);
  addStandIn(result, pass, new Set(sorted.shown), seal.openToAll, new Set([...seal.notReached.map((n) => n.path), NOWHERE_PATH]));
  const final = { ...standIn, ...more };
  tell(result.checks.filter((check) => !notNew.has(check)));
  if (seal.filled > 0) {
    const look = oneRowLook(final, shared, { start, shell: seal.shell, publicScreens, screens: sorted.shown, vouched: (path) => seal.vouches(path) }, result, env, tell);
    if (config.onLastLook) config.onLastLook(look);
    else await look;
  }
  return report("reached", `Seen as a made-up user with made-up data: ${sorted.shown.length} screen${sorted.shown.length === 1 ? "" : "s"} past the public pages. No real server saw that user, and no findings come from these screens.`, { ...about, reached: sorted.shown });
}

/** The longest the look with one row may take, and the screens it opens. */
const ONE_ROW_MS = 60_000;
const ONE_ROW_SCREENS = 16;

/**
 * Every screen that drew rows, once more with each list cut to exactly one. The new account has
 * already drawn a count of nothing; this is the count of one, the one that shows a word that never
 * changes with its number. Whatever an AI invented, a run asks this, so the item doesn't come and go
 * with how many rows there were. It keeps only what it's for: everything else was measured already.
 */
async function oneRowLook(standIn: StandInConfig, shared: Omit<ScanConfig, "standIn">, at: { start: URL; shell: string | undefined; publicScreens: string[]; screens: string[]; vouched: (path: string) => boolean }, result: ScanResult, env: Record<string, string | undefined>, tell: Tell): Promise<void> {
  if (shared.signal?.aborted || !standIn.rows) return;
  const addresses = at.screens.slice(0, ONE_ROW_SCREENS);
  // A screen is shown by what it drew, and that says nothing of what a read of its address would do.
  const seal = new Seal({ start: at.start, config: { ...standIn, rows: oneRowOf(standIn.rows), addresses, tryOnly: addresses.filter((path) => !at.vouched(path)), proxied: [...(standIn.proxied ?? []), ...(shared.proxied ?? [])] }, publicScreens: at.publicScreens, background: backgroundHost, graphqlRead: (body, type) => onlyGraphqlReads(body, type), readable: plainRead });
  seal.shell = at.shell;
  const { onScreen: _onScreen, ...quietly } = shared;
  const shown = new Set(addresses);
  // The screens were proven before this began: all that's left to it is the count it's for.
  const isCount = (check: ScreenCheck) => check.kind === "wording" && check.wording === "count" && shown.has(check.screen);
  const counts = (checks: readonly ScreenCheck[]) => checks.filter(isCount).map((check) => ({ ...check, oneRow: true as const }));
  const pass = await crawlSite({ ...quietly, startUrl: at.start.href, maxPages: addresses.length + 1, maxDurationMs: ONE_ROW_MS, keepNumbers: false, countsOnly: true, measured: (seen) => (seal.sessionRead ? tell(counts(seen.checks)) : undefined) }, env, seal, undefined, true).catch(() => undefined);
  if (!pass || !seal.sessionRead) return;
  result.checks.push(...counts(pass.checks));
  result.oneRowPhotos = pass.screens.filter((shot) => shown.has(withoutView(shot.path)));
  for (const [step, ms] of Object.entries(pass.timings)) result.timings[`one-row ${step}`] = ms;
}

const ONLY_PUBLIC = "Nothing drew for a new account past the public pages.";

/** The new-account walk's share of the stand-in's time, and the most it takes. */
const WALK_SHARE = 0.4;
const WALK_MOST_MS = 60_000;
/** Addresses it opens, and screens it may add from following links: enough to meet the first run and the empty screens around it. */
const WALK_ADDRESSES = 12;
const WALK_PAGES = 12;

/**
 * The app as a person finds it who has just signed up: in the same seal, a made-up session on an
 * account made a minute ago, no rows, no finished setup. Addresses a signed-in person is sent on
 * from (the sign-in itself) come first, as where they land is what a new person sees first. It only
 * looks: nothing is pressed, and what's seen is kept apart from the rest of the run.
 *
 * What an empty account draws has no rows to prove a screen by (see Seal.sort), and needs none:
 * the session was read, the app drew something other than a wall, and an address that can't exist
 * doesn't draw the same. What only drew for everybody isn't this walk's to report. A wall that's a
 * wall for the app's own reasons (asking for a plan, turning someone away) is what a new person
 * sees, so it's kept, as the gate it is.
 */
async function newUserWalk(standIn: StandInConfig, shared: Omit<ScanConfig, "standIn">, at: { start: URL; shell: string | undefined; publicScreens: string[]; walls: string[]; limitMs: number; sayNow: boolean; saw: { nowhere?: Drawing; addresses?: Record<string, string> }; seen?: (so: NewUserSoFar) => void }, result: ScanResult, env: Record<string, string | undefined>, tell: Tell): Promise<NewUserReport> {
  const nothing = (message: string): NewUserReport => ({ status: "not_walked", message, screens: [], photos: [], firstRun: [], notReached: [] });
  if (shared.signal?.aborted) return nothing("The run was stopped before the new account could be walked.");
  const ways = result.pagesVisited.filter((path) => SIGN_IN_PATH.test(path) || SIGN_UP_PATH.test(path));
  const firstRun = [...new Set([...(standIn.firstRun ?? []), ...(standIn.addresses ?? []).filter((address) => FIRST_RUN_PATH.test(address))])];
  const addresses = [...new Set([...ways, ...at.walls, ...firstRun, ...(standIn.addresses ?? []), ...(standIn.walkAddresses ?? [])])].slice(0, WALK_ADDRESSES);
  // What the crawl opened or the code read named can be read. The rest are strings, opened sealed and never read.
  const stoodBehind = new Set([...ways, ...at.walls, ...(standIn.addresses ?? [])]);
  const seal = new Seal({ start: at.start, config: { ...standIn, rows: {}, addresses, tryOnly: addresses.filter((path) => !stoodBehind.has(path)), proxied: [...(standIn.proxied ?? []), ...(shared.proxied ?? [])] }, publicScreens: at.publicScreens, opened: at.walls, background: backgroundHost, graphqlRead: (body, type) => onlyGraphqlReads(body, type), readable: plainRead, newAccount: true });
  if (seal.unknownProvider) return nothing("The sign-in library isn't one the stand-in knows, so the new account wasn't walked.");
  seal.shell = at.shell;
  // It goes on beside the pressing, so it says nothing of how far the run has got.
  const { onScreen: _onScreen, onProgress: _onProgress, ...quietly } = shared;
  // A page that drew the same for everybody isn't the new account's, whichever address it's at.
  const everybodys = new Set(at.publicScreens);
  const theirs = (path: string) => !everybodys.has(path) && !seal.likeNowhere(path);
  /** Each first-run address, and whether it opened as itself among these screens. */
  const firstRunOf = (paths: ReadonlySet<string>) => firstRun.map((path) => {
    const landed = seal.landed.get(path);
    const stopped = seal.notReached.find((n) => n.path === path)?.why;
    const opened = paths.has(landed ?? path) && !stopped;
    return { path, opened, ...(landed && landed !== path ? { landed } : {}), ...(!opened ? { why: stopped ?? (landed ? "sent_away" : "not_opened") } : {}) };
  });
  // Where a new account is sent first: once those have been opened, what comes first for one is known.
  const firstOnes = [...new Set([...ways, ...firstRun])];
  const tellSeen = (seen: ScanResult) => {
    if (!at.seen || !seal.sessionRead || !seal.nowhere) return;
    const screens = seen.reviews.filter((review) => theirs(review.path));
    if (!screens.length) return;
    const paths = new Set(screens.map((review) => review.path));
    at.seen({ screens, firstRun: firstRunOf(paths), addresses: Object.fromEntries([...seal.drawn].map(([path, drew]) => [path, drew.href])), nowhere: seal.nowhere, firstKnown: firstOnes.every((path) => seal.landed.has(path) || seal.notReached.some((n) => n.path === path)) });
  };
  // With what can't exist looked at, and every public page known, nothing later changes what a screen of theirs is, so it's said as it's measured.
  const measured = (seen: ScanResult) => {
    tellSeen(seen);
    if (!at.sayNow || !seal.sessionRead || !seal.nowhere) return;
    const stands = new Set(seen.reviews.map((review) => review.path).filter(theirs));
    tell(seen.checks.filter((check) => stands.has(check.screen)).map((check) => ({ ...check, newUser: true as const })));
  };
  /**
   * The walk's own clock (see NewUserReport.took): the crawl tells `measured` before each address it
   * opens and once at its end, so the time between two tells is one address's, and goes to the screen
   * it reviewed then, a wall of the app's own included. An address that drew nothing is nobody's time.
   */
  const took: Record<string, number> = {};
  let toldAt: number | undefined;
  let reviewed = 0;
  const timed = (seen: ScanResult) => {
    const now = Date.now();
    const review = seen.reviews[reviewed];
    if (review && toldAt !== undefined) took[review.path] = (took[review.path] ?? 0) + (now - toldAt);
    reviewed = seen.reviews.length;
    toldAt = now;
    measured(seen);
  };
  let pass: ScanResult;
  try {
    pass = await crawlSite({ ...quietly, startUrl: at.start.href, maxPages: WALK_PAGES, maxDurationMs: at.limitMs, keepNumbers: false, measured: timed }, env, seal, undefined, true);
  } catch (error) {
    return nothing(`The new account wasn't walked: ${message(error)}.`);
  }
  if (!seal.sessionRead) return nothing("The app didn't take the new account's session, so nothing was seen as one.");
  if (seal.nowhere) at.saw.nowhere = seal.nowhere;
  at.saw.addresses = Object.fromEntries([...seal.drawn].map(([path, drew]) => [path, drew.href]));
  const kept = pass.reviews.filter((review) => theirs(review.path));
  const paths = new Set(kept.map((review) => review.path));
  const firstRunSeen = firstRunOf(paths);
  const notReached = seal.notReached.filter((n) => !paths.has(n.path)).map((n) => ({ path: n.path, why: n.why }));
  if (kept.length === 0) return { ...nothing(ONLY_PUBLIC), firstRun: firstRunSeen, notReached };
  result.checks.push(...pass.checks.filter((check) => paths.has(check.screen)).map((check) => ({ ...check, newUser: true as const })));
  for (const [step, ms] of Object.entries(pass.timings)) result.timings[`new-user ${step}`] = ms;
  const screens = kept.map((review) => ({ ...review, account: "new" as const }));
  const first = screens[0]!.path;
  return {
    status: "walked",
    message: walkedMessage(screens.length),
    first, screens,
    photos: pass.screens.filter((shot) => paths.has(withoutView(shot.path))).map((shot) => ({ path: shot.path, width: shot.width, height: shot.height, jpeg: shot.jpeg, seenWith: "stand-in" as const })),
    firstRun: firstRunSeen, notReached,
    // Only the screens it kept, by the address each is listed at.
    took: Object.fromEntries(screens.flatMap((screen) => {
      const ms = took[screen.path];
      return ms === undefined ? [] : [[screen.path, ms]];
    })),
  };
}

/** What the new account's walk has seen so far, told as it goes (see newUserWalk). */
interface NewUserSoFar {
  screens: ScreenReview[];
  firstRun: NewUserReport["firstRun"];
  addresses: Record<string, string>;
  nowhere: Drawing;
  /** Every address a new account is sent on from, and every first-run one, has been opened: what a new account meets first is among the screens. */
  firstKnown: boolean;
}

/**
 * Browsers the journeys walk in at once. Each is a whole browser under a seal of its own, so no two
 * browsers share a trail, a save or a session, and each journey in one is reset first (see Drive.reset); most of a journey's time is waiting on its page, so a
 * few side by side get through more in the same time. Fewer on a small machine: the rest of the run
 * goes on beside them, and it's what the list waits for.
 */
const JOURNEY_BROWSERS_MOST = 3;
/** Before the new account's walk is over: that walk is what the rest of the run waits for, so it isn't crowded. */
const JOURNEY_BROWSERS_EARLY = 1;
/** CONTEXTMACHINES_JOURNEY_BROWSERS sets it, from 1 to the most, to see how a smaller machine does. */
const journeyBrowsers = (env: Record<string, string | undefined>) => {
  const asked = Number(env.CONTEXTMACHINES_JOURNEY_BROWSERS);
  if (Number.isInteger(asked) && asked >= 1) return Math.min(JOURNEY_BROWSERS_MOST, asked);
  return Math.max(1, Math.min(JOURNEY_BROWSERS_MOST, Math.floor(availableParallelism() / 4), Math.floor(totalmem() / (4 * 2 ** 30))));
};

/** The journeys under way, with what feeds them while the new account is still being walked. */
interface JourneysFed extends JourneysUnderWay {
  /** Screens the new account has drawn since. */
  more: (seen: Pick<NewUserSoFar, "screens" | "firstRun" | "addresses">) => void;
  /** The new account's walk is over, and no more screens come. With widen, it came to something, and the rest of the browsers start. */
  walkOver: (widen: boolean) => void;
}

/**
 * The journeys, on their way beside the rest of the run: sealed browsers of their own, in which
 * saves stay (see Seal.keepSaves) and every step is read from the page. Nothing from these browsers
 * goes into the result: no findings, no checks, no saves. Its report is its own (see journeys.ts).
 * They start as soon as the new account has drawn where it begins, with one browser, and the
 * screens it draws after that are journeys for the queue as they come; once its walk is over the
 * rest of the browsers join in. Each browser has its own seal, made the same way.
 */
function walkJourneys(standIn: StandInConfig, shared: Omit<ScanConfig, "standIn">, at: { start: URL; shell: string | undefined; publicScreens: string[]; walls: string[]; nowhere: Drawing | undefined; addresses: Record<string, string> }, seen: Pick<NewUserSoFar, "screens" | "firstRun"> & { first: string | undefined }, result: ScanResult, env: Record<string, string | undefined>, browsers = journeyBrowsers(env)): JourneysFed {
  const stopping = new AbortController();
  const signal = shared.signal ? AbortSignal.any([shared.signal, stopping.signal]) : stopping.signal;
  const sealFor = () => {
    const seal = new Seal({ start: at.start, config: { ...standIn, rows: {}, addresses: [], proxied: [...(standIn.proxied ?? []), ...(shared.proxied ?? [])] }, publicScreens: at.publicScreens, opened: at.walls, background: backgroundHost, graphqlRead: (body, type) => onlyGraphqlReads(body, type), readable: plainRead, newAccount: true, keepSaves: true });
    seal.shell = at.shell;
    if (at.nowhere) seal.nowhere = at.nowhere;
    return seal;
  };
  const sealOf = new WeakMap<Drive, Seal>();
  const fed = new Set<string>();
  /** The screens not given yet, each once and in the order they were seen. */
  const found = (more: Pick<NewUserSoFar, "screens" | "firstRun">, addresses: Record<string, string>) => {
    const screens = more.screens.filter((screen) => !fed.has(screen.path));
    for (const screen of screens) fed.add(screen.path);
    return { found: findJourneys({ screens, addresses, first: seen.first, firstRun: more.firstRun.filter((f) => f.opened && !f.landed).map((f) => f.path) }), nav: [...new Set(screens.map((screen) => screen.path))] };
  };
  const first = found(seen, at.addresses);
  const walk = new JourneyWalk(first.found, { nav: first.nav, signUp: () => signUpJourney(result.reviews), saved: (drive) => sealOf.get(drive)?.holdsSaves === true });
  const screensOver = walk.more();
  if (standIn.later) void standIn.later.then((more) => walk.addHints((more as { journeyHints?: JourneyHints } | undefined)?.journeyHints), () => walk.close());
  else walk.close();
  const limit = setTimeout(() => stopping.abort(), JOURNEYS_MOST_MS);
  limit.unref?.();
  const { onScreen: _onScreen, onProgress: _onProgress, ...quietly } = shared;
  let walkedEnd = () => {};
  const walkEnded = new Promise<void>((resolve) => { walkedEnd = resolve; });
  let allDone = () => {};
  const done = new Promise<void>((resolve) => { allDone = resolve; }).finally(() => clearTimeout(limit));
  let started = 0;
  let walking = 0;
  let open = 0;
  /** One more browser on the walk: the walk is the same one, and only its own seal is this browser's. */
  const another = () => {
    if (signal.aborted || started >= browsers || (started > 0 && open === 0)) return;
    started++;
    walking++;
    open++;
    const seal = sealFor();
    // Its walking is over when its walk is, before its browser has closed; or with the browser, where it never got to walk.
    let over = false;
    const walkOver = () => {
      if (over) return;
      over = true;
      if (--walking === 0) walkedEnd();
    };
    void crawlSite({ ...quietly, startUrl: at.start.href, maxPages: 1, maxDurationMs: JOURNEYS_MOST_MS + 5000, keepNumbers: false, screenshots: false, signal, walk: (drive) => {
      sealOf.set(drive, seal);
      return walk.run(drive).finally(walkOver);
    } }, env, seal, undefined, true)
      .then(() => {}, () => {})
      .finally(() => {
        walkOver();
        if (--open === 0) allDone();
      });
  };
  for (let n = 0; n < Math.min(browsers, JOURNEY_BROWSERS_EARLY); n++) another();
  // Stopped before a browser could start (Ctrl-C as the new account's walk was ending): there's nothing to wait for.
  if (started === 0) {
    walkedEnd();
    allDone();
  }
  const walked = Promise.race([walkEnded, done]);
  const atLeast = Promise.race([done, new Promise<void>((resolve) => { const floor = setTimeout(resolve, JOURNEYS_LEAST_MS); floor.unref?.(); })]);
  return {
    done, atLeast, walked, browsers,
    walkedIn: () => walk.walkedIn,
    begun: () => walk.started,
    stop: () => stopping.abort(),
    soFar: () => walk.report(JOURNEYS_MOST_MS),
    listen: (tell) => walk.listen(tell),
    more: (more) => {
      const next = found(more, more.addresses);
      walk.add(next.found, next.nav);
    },
    walkOver: (widen) => {
      for (let n = started; widen && n < browsers; n++) another();
      screensOver();
    },
  };
}

const walkedMessage = (screens: number) => `Seen as a made-up new account with no data: ${screens} screen${screens === 1 ? "" : "s"}. No real server saw it.`;

/**
 * The walk with what turned out to be public taken back out. It may begin before the crawl has
 * found every public page, and a page that draws the same for everybody isn't the new account's,
 * whichever came to it first.
 */
function withoutPublic(walk: NewUserReport, publicScreens: readonly string[]): NewUserReport {
  const everybodys = new Set(publicScreens);
  const screens = walk.screens.filter((screen) => !everybodys.has(screen.path));
  if (screens.length === walk.screens.length) return walk;
  const firstRun = walk.firstRun.map((seen) => {
    if (!seen.opened || !everybodys.has(seen.landed ?? seen.path)) return seen;
    return { path: seen.path, opened: false, ...(seen.landed ? { landed: seen.landed } : {}), why: "sent_away" };
  });
  if (screens.length === 0) return { status: "not_walked", message: ONLY_PUBLIC, screens, photos: [], firstRun, notReached: walk.notReached };
  return { ...walk, message: walkedMessage(screens.length), first: screens[0]!.path, screens, photos: walk.photos.filter((shot) => !everybodys.has(withoutView(shot.path))), firstRun };
}

/**
 * Adds what the pass saw that the public crawl didn't. A screen both saw stays the public one, so
 * nothing made-up lands on a true screen, unless all the public crawl saw at that address was a
 * sign-in form: then what's there is the screen, and the form goes. Findings stay out altogether,
 * as everything that follows a made-up answer proves nothing, and in that pass everything does
 * (see savedAt). A public page the first crawl missed comes along too, unmarked: it drew the same
 * for nobody at all, with no made-up data on it (see lookSignedOut).
 */
function addStandIn(result: ScanResult, pass: ScanResult, reached: Set<string>, openToAll: ReadonlySet<string>, shut: ReadonlySet<string>) {
  const fresh = new Set([...reached, ...openToAll]);
  const walled = (path: string) => fresh.has(withoutView(path));
  result.pagesVisited = result.pagesVisited.filter((path) => !fresh.has(path));
  result.screens = result.screens.filter((shot) => !walled(shot.path));
  result.events = result.events.filter((e) => !((e.kind === "route" || e.kind === "page" || e.kind === "interaction") && walled(e.path)));
  result.checks = result.checks.filter((check) => check.newUser || !walled(check.screen));
  result.reviews = result.reviews.filter((review) => !walled(review.path));
  // A page anyone can open was no stand-in's to mark.
  const unmarked = <T extends { seenWith?: "stand-in"; madeUpData?: true }>(seen: T): T => {
    const { seenWith: _seenWith, madeUpData: _madeUpData, ...rest } = seen;
    return rest as T;
  };
  result.checks.push(...pass.checks.filter((check) => fresh.has(withoutView(check.screen))).map((check) => (openToAll.has(withoutView(check.screen)) ? unmarked(check) : check)));
  result.reviews.push(...pass.reviews.filter((review) => fresh.has(withoutView(review.path))).map((review) => (openToAll.has(withoutView(review.path)) ? unmarked(review) : review)));
  const known = new Set(result.pagesVisited);
  const lastT = result.events.reduce((last, event) => Math.max(last, event.t), 0);
  result.seenWith ??= {};
  for (const path of reached) result.seenWith[path] = "stand-in";
  result.pagesVisited.push(...fresh);
  result.foundByButtons.push(...pass.foundByButtons.filter((path) => fresh.has(path)));
  const photos = pass.screens.filter((shot) => fresh.has(withoutView(shot.path))).slice(0, Math.max(0, MAX_SCREEN_PHOTOS - result.screens.length));
  for (const shot of photos) {
    if (openToAll.has(withoutView(shot.path))) {
      result.screens.push(shot);
      continue;
    }
    result.seenWith[shot.path] = "stand-in";
    result.screens.push({ ...shot, seenWith: "stand-in", madeUpData: true });
  }
  for (const event of pass.events) {
    if (event.kind === "route" || event.kind === "page" || event.kind === "interaction") {
      // What drew at an address that stayed shut was no screen, whatever the snippet read of it.
      if (known.has(withoutView(event.path)) || shut.has(withoutView(event.path))) continue;
      // An address the app moved on from (/reports to /reports/overview) was never a page of its own
      // here, but it's a screen all the same, and only the made-up user saw it.
      if (!openToAll.has(withoutView(event.path))) result.seenWith[withoutView(event.path)] = "stand-in";
    }
    if (CapturedEventSchema.safeParse({ ...event, t: lastT + event.t }).success) result.events.push({ ...event, t: lastT + event.t });
    else result.invalidEvents++;
  }
  result.blockedWrites.push(...pass.blockedWrites.map((write) => ({ ...write, seenWith: "stand-in" as const })));
  // What the app sends by itself as the stand-in is told apart: it's neither a form nor a tracker.
  result.ambientWrites.push(...pass.ambientWrites.map((write) => ({ ...write, seenWith: "stand-in" as const })));
  for (const path of fresh) if (pass.addresses?.[path]) (result.addresses ??= {})[path] = pass.addresses[path];
  for (const path of fresh) if (pass.drawn?.[path]) (result.drawn ??= {})[path] = pass.drawn[path];
  const held = new Set(result.linksHeldBack.map((h) => `${h.path} ${h.why}`));
  result.linksHeldBack.push(...pass.linksHeldBack.filter((h) => !held.has(`${h.path} ${h.why}`)));
  for (const [from, to] of Object.entries(pass.links)) if (fresh.has(from) || !known.has(from)) result.links[from] = [...new Set([...(result.links[from] ?? []), ...to])];
  for (const [step, ms] of Object.entries(pass.timings)) result.timings[step] = (result.timings[step] ?? 0) + ms;
  result.invalidEvents += pass.invalidEvents;
}

/**
 * The crawl itself. With a seal, this is the stand-in pass: the seal goes ahead of every other rule.
 * With walls, the public crawl notes each screen that was only a sign-in form at some other
 * address, for the pass to come; looking changes nothing it does. With lookOnly, screens are looked
 * at and nothing on them is pressed (see newUserWalk).
 */
async function crawlSite(config: ScanConfig, env: Record<string, string | undefined>, seal?: Seal, walls?: Set<string>, lookOnly = false): Promise<ScanResult> {
  /** Where the scan started; where it landed, if the start address moved it on the same site (see adoptLanding). */
  let start = new URL(config.startUrl);
  // A user name and password in the address stay out of the browser: a page whose own address holds
  // them can't use fetch() at all, and its scripts could read them. Sent only to the start's origin.
  const httpCredentials = start.username || start.password ? { username: decoded(start.username), password: decoded(start.password), origin: start.origin } : undefined;
  start.username = start.password = "";
  const site = new Set([start.origin, ...(config.siteOrigins ?? [])]);
  const origins = new Set([...(config.origins ?? [start.origin]), ...site]);
  /** The query keys this site routes by, once two of their values have shown different documents (see confirmRoutes). */
  const routeKeys: string[] = [];
  /** An address the way the snippet reads it, so the crawl and the snippet agree on what a screen is. */
  const place = (href: string) => normalizeUrl(href, start.href, routeKeys);
  /** A screen's identity: its path, plus its address when that isn't where the scan started. */
  const screen = (href: string) => {
    const n = place(href);
    return n ? placePath(n.path, new URL(n.origin).host, start.host) : undefined;
  };
  /** A start below "/" keeps the learner in its folder, on the start's own address (see scopeOf). */
  let scope = scopeOf(start.pathname);
  const skippedOutside = new Set<string>();
  const inside = (url: URL) => url.origin !== start.origin || inScope(url.pathname, scope);
  const maxPages = config.maxPages ?? 50;
  const deadline = Date.now() + (config.maxDurationMs ?? 120_000);
  const navTimeout = config.navigationTimeoutMs ?? 15_000;
  /** Signed in, the site's writes would land as that person: anything uncertain is left alone. */
  const signedIn = Boolean(config.login || config.storageState || seal);
  const excludes = config.excludePaths?.length ? new RegExp(config.excludePaths.join("|"), "i") : undefined;
  /** Never learned, even when the site's own navigation led there: what the person left out, and addresses that act. */
  const leftOut = (url: URL) => excludes?.test(url.pathname) === true || commandIn(url, signedIn) !== undefined;
  const allowValues = new Set(config.allowValues ?? []);
  const proxied = config.stayLocal === true ? config.proxied ?? [] : [];
  /** An address on the app's own host that goes on to another server (see ScanConfig.proxied). With what's handed on unread, a call may be, and a page has to load anyway. */
  const handedOn = (url: URL, call: boolean) => url.host === start.host && url.pathname !== start.pathname && (proxyPrefix(proxied, url) !== undefined || (call && proxied.includes("*")));
  /** A host this run stays away from (see ScanConfig.stayLocal): the seal has its own rule, and it's stricter. */
  const offLimits = (url: URL, call = false) => config.stayLocal === true && /^(?:https?|wss?):$/.test(url.protocol) && (!isLocalHost(url.hostname) || handedOn(url, call));
  const stayedAway = new Set<string>();
  const proxiedHeld = new Set<string>();
  /** Says what was stayed away from: a host, or the part of this one a dev proxy takes. */
  const noteAway = (url: URL) => {
    if (!isLocalHost(url.hostname)) stayedAway.add(url.hostname);
    else proxiedHeld.add(proxyPrefix(proxied, url) ?? `/${url.pathname.split("/")[1] ?? ""}`);
  };

  /**
   * Whose requests are the site's own: the origins above, and any host that shares the start's
   * registrable domain (api.acme.com for www.acme.com, or another port on the same machine), where
   * single-page apps keep their API. Their reads are recorded and their writes answered by us, as
   * the start's are. Pages are another matter: only the site's origins are crawled.
   */
  const apiOrigin = (origin: string) => {
    if (origins.has(origin)) return true;
    try {
      const url = new URL(origin);
      return /^https?:$/.test(url.protocol) && baseDomain(url.hostname) === baseDomain(start.hostname);
    } catch {
      return false;
    }
  };
  /** A real account's screens, or what a run really saved: what's drawn there is someone's, so only its structure goes on from here. */
  const realSession = Boolean(config.login || config.storageState || config.realWrites);
  const masked = (text: string) => (realSession ? text.replace(/\d/g, "#") : text);
  // Numbers are masked on those too: balances and account numbers are on screen.
  const keepNumbers = !realSession && config.keepNumbers !== false;
  const interrupted = () => config.signal?.aborted === true;
  // Under the seal what the app's server would answer is answered from here, and what's left is its own files, from
  // the server on this machine the seal is for: no pause between pages. That's being gentle, not being safe.
  const pause = seal ? 0 : config.delayMs ?? 250;

  const result: ScanResult = { pagesVisited: [], events: [], blockedWrites: [], errors: [], stoppedBy: "complete", loggedIn: false, foundByButtons: [], startOrigin: start.origin, screens: [], findings: [], checks: [], reviews: [], timings: {}, errorPages: [], linksHeldBack: [], invalidEvents: 0, ambientWrites: [], links: {} };
  /** Progress for a live status line (see ScanProgress): told about once a second, and at each change of phase. */
  const begun = Date.now();
  let stage: ScanProgress["phase"] = "opening";
  const tell = () => {
    try {
      config.onProgress?.({ screens: result.pagesVisited.length, maxPages, elapsedMs: Date.now() - begun, phase: stage });
    } catch {
      // a listener's mistake never stops the learning
    }
  };
  const moveTo = (next: ScanProgress["phase"]) => {
    stage = next;
    tell();
  };
  const ticking = config.onProgress ? setInterval(tell, 1000) : undefined;
  ticking?.unref?.();
  tell();
  const snippetFile = config.snippetFile ?? DEFAULT_SNIPPET;
  /** A walk that presses reads what it needs for itself: the snippet is most of a new account's time, and a walk's report is its own. */
  const walking = config.walk !== undefined;
  const snippet = !walking && existsSync(snippetFile) ? readFileSync(snippetFile, "utf8") : undefined;
  if (!snippet && !walking) result.errors.push(`page structure not read: snippet not found at ${snippetFile} (run npm run build:snippet)`);
  let phase: "login" | "crawl" = config.login ? "login" : "crawl";
  /** The sign-in form has been sent: what the login step may do ends with the first move that follows. */
  let signingIn = false;
  const learn = config.learnActions !== false;
  /**
   * Buttons never pressed (see RISKY_BUTTON). When learning, every write is answered by us and what
   * follows is held, so a Delete may be pressed; with --create, writes really go through, so it never is.
   */
  const riskyPress = learn && !config.realWrites && !walking ? RISKY_WHEN_LEARNING : RISKY_BUTTON;
  /** Writes we stopped: the snippet records those (with the button behind each); the scan records the rest. */
  const stopped = new WeakSet<Request>();
  /**
   * Saves we stopped that the page hasn't reported yet: a form that saves and moves straight on to
   * another page can take its report with it. Kept by the learner itself, and added at the end.
   */
  const unreported: Extract<CapturedEvent, { kind: "network" }>[] = [];
  let pressedAt = -Infinity;
  /** When the learner last changed the page (pressed, typed, dragged): a page loaded since is still as it came. */
  let touchedAt = -Infinity;
  /** The form being sent, for the save it makes when it sends by loading a page (see the route below). */
  let submitting: { label?: string; tag: string; page?: string } | undefined;
  let t = 0;
  /**
   * Until when everything but assets is held, on any host (see judge): set by a press on a control
   * that says it destroys or commands, since what it sends may look like any read. Ended early only
   * by the learner's own next page load, which leaves whatever that page had in hand behind.
   */
  let heldUntil = 0;
  /** Whether the last press said it acts: its "Are you sure?" gets a yes only while the hold is on. */
  let pressActed = false;
  const holdFor = (says: Saying) => {
    pressActed = config.realWrites ? controlDestroys(says) : saysActs(says);
    if (pressActed) heldUntil = Date.now() + HOLD_MS;
  };
  /** What the learner typed into the page, search boxes aside (see carriesTyped). */
  const typed = new Set<string>();
  /** The same, search boxes included: a write carrying one of these is plainly what was typed being saved. */
  const everTyped = new Set<string>();
  let typedAt = -Infinity;
  const noteTyped = (value: string, searchBox = false) => {
    typedAt = Date.now();
    if (!searchBox) typed.add(value);
    if (value.length >= 4) everTyped.add(value);
  };
  /** The one rule, with what it needs to know from this run (see judge). */
  const guard: Guard = {
    crawling: () => phase === "crawl",
    own: (origin) => apiOrigin(origin),
    holding: () => Date.now() < heldUntil,
    pressedToAdd: () => pressedAt > typedAt && pressAdds(submitting?.label),
    typed, signedIn, realWrites: config.realWrites === true, get startHref() { return start.href; },
  };
  /** Says a link or read was held back, once for each address and reason. */
  const heldPaths = new Set<string>();
  const holdBack = (url: URL, why: HeldBack["why"], read = false) => {
    const path = screen(url.href) ?? url.pathname;
    if (heldPaths.has(`${path} ${why}`)) return;
    heldPaths.add(`${path} ${why}`);
    result.linksHeldBack.push({ path, why, ...(read ? { read } : {}) });
  };
  /** When a redirect's hop was last held: the page load that led to it ends without a page, by our doing. */
  let heldHopAt = -Infinity;
  /** POSTs we let through as GraphQL reads: the snippet's report of one isn't a save. */
  const graphqlReads = new Set<string>();

  /**
   * What the learner saw go wrong (see Finding). A problem we could have caused ourselves is never
   * one: an error just after we stopped or answered one of the site's requests, a request we
   * aborted, a record the app asked for by the made-up id our answers carry.
   */
  const issues = new Map<string, Finding>();
  const addFinding = (found: Omit<Finding, "count">) => {
    if (seal) return; // in the stand-in pass every answer is ours: nothing that follows proves anything
    // The app's words, on their way to FIX.md as a check's are (see addCheck): on a real session, with no digits.
    const f = { ...found, ...(DRAWN_FINDINGS.has(found.kind) ? { target: masked(found.target) } : {}), ...(found.after ? { after: masked(found.after) } : {}) };
    const key = `${f.kind}|${f.screen}|${f.target}`;
    const had = issues.get(key);
    if (had) return void had.count++;
    issues.set(key, { ...f, count: 1 });
    try {
      config.onFinding?.({ ...f, count: 1 });
    } catch {
      // a listener's mistake never stops the learning
    }
  };
  /** What's measured is told in the app's own words, and those go to FIX.md and on to another AI: on a real session, with no digits. */
  const addCheck = (check: Omit<ScreenCheck, "screens" | "seenWith">) => {
    const words = MEASURED_WORDS.has(check.kind) ? { target: masked(check.target), ...(check.by ? { by: masked(check.by) } : {}), ...(check.byWords ? { byWords: check.byWords.map(masked) } : {}) } : {};
    result.checks.push({ ...check, ...words, screens: [check.screen], ...(seal ? { seenWith: "stand-in" as const } : {}) });
  };
  /** A broken template. On a real session, or in a table's cell, the line around it is a customer's, and only the template is the app's. */
  const addWording = (w: Wording, shown: string) => addCheck({ kind: "wording", wording: w.problem, screen: shown, target: (realSession || w.cell ? w.phrase : w.line).slice(0, 120), evidence: `drawn on the page: "${w.phrase}"` });
  /** Requests we stopped or answered on the site, and when we last did: what follows may be our doing. */
  const aborted = new WeakSet<Request>();
  /** Calls the seal had answered with nothing as this page load began (see ScreenReview.heldData). */
  let emptiedAtLoad = 0;
  /** What this page load went without, by our doing (see heldFrom): what it then draws may be our doing too. */
  let without = { calls: false, styles: false, fonts: false };
  /** Errors the page logged as it loaded, and images of its own that came back as anything but images: judged once it's drawn (see checkScreen). */
  let logged: { text: string; file: string }[] = [];
  /** The site's own server, or an API on its domain, said 401 or 403 in this load (see SAYS_TURNED_AWAY). */
  let turnedAway = false;
  const failedImages = new Map<string, number>();
  /** A request of the page's that went nowhere. What it was for says what the page can no longer be judged on. */
  const heldFrom = (request: Request, url: URL) => {
    aborted.add(request);
    const type = request.resourceType();
    if (type === "font" || (type === "stylesheet" && /font/i.test(url.href))) without.fonts = true;
    else if (type === "stylesheet" || (type === "script" && CSS_BY_SCRIPT.test(url.href))) without.styles = true;
    else if (CAPTURED_TYPES.has(type) && !backgroundHost(url.hostname)) without.calls = true;
  };
  let interferedAt = -Infinity;
  /** This page load went without a script a local run refused: what it then fails at is ours, not the app's. */
  let withoutItsCode = false;
  /**
   * The screens whose page went without such a script on any load this run, a frame's included: a
   * loader may ask for it only later, or only once a visit, so the load that's judged last may not
   * have asked yet. Only that page's buttons are silenced by it.
   */
  const refusedOn = new Set<string>();
  /**
   * The screens whose page started a worker of its own. What a worker loads (importScripts) reaches
   * the route as "other", not as a script, so on such a page anything of that kind a local run
   * refused may have been the worker's code.
   */
  const workersOn = new Set<string>();
  /** The data layers of tag managers a local run kept from each screen (see tagManager). */
  const tagsKeptFrom = new Map<string, Set<string>>();
  /** A page's put-off work is being run ahead (see settlesAhead), and when that last ended. */
  let runningAhead = false;
  let aheadAt = -Infinity;
  /** What follows a run ahead may be its doing, but only on the page it ran on: a fresh load is the site's again. */
  const justAhead = () => runningAhead || (aheadAt >= loadedAt && Date.now() - aheadAt < AFTER_OUR_ANSWER_MS);
  /** It went without a stylesheet or an analytics tag: that may touch how it loaded, and holds up nothing a press does. */
  let withoutExtras = false;
  const refusedUs = () => withoutItsCode || (withoutExtras && pressedAt <= loadedAt);
  /** When we last answered or held back one of the site's own saves (not its CDN's upkeep). */
  let savedAt = -Infinity;
  let answered = 0;
  const byOurId = (href: string) => {
    if (answered === 0) return false;
    const url = new URL(href);
    return hasMissingValue(url) || /(^|\/)1(\/|$)/.test(url.pathname) || [...url.searchParams.values()].includes("1");
  };
  let loadedAt = -Infinity;
  let lastPress: string | undefined;
  /** Anything a press set off outside the page (a request, a dialog, a new tab, a download, a navigation). */
  let outsideEffects = 0;
  let exploring = true;
  /** When we last loaded a page ourselves: what a page sends as it loads isn't explained by the press before. */
  let openedAt = -Infinity;
  /** What each address written to did this run, to tell what a press explains from what the page sends anyway. */
  const writesSeen = new Map<string, { method: string; path: string; graphqlOperation?: string; count: number; pressed: number; controls: Set<string>; screens: Set<string>; beacon: boolean; carried: boolean; cdn: boolean }>();
  /** Addresses sent a keepalive fetch, as "METHOD path" (see watchEffects). */
  const keptAlive = new Set<string>();
  const noteWrite = (request: Request, path: string, graphqlOperation: string | undefined, body: string | undefined) => {
    const method = request.method().toUpperCase();
    const key = `${method} ${path} ${graphqlOperation ?? ""}`;
    const seen = writesSeen.get(key) ?? { method, path, ...(graphqlOperation ? { graphqlOperation } : {}), count: 0, pressed: 0, controls: new Set<string>(), screens: new Set<string>(), beacon: false, carried: false, cdn: CDN_OWN.test(path) };
    writesSeen.set(key, seen);
    seen.count++;
    if (request.resourceType() === "ping") seen.beacon = true;
    // In the address as well as the body: a form sent by GET carries what was typed there.
    const sent = decoded(`${request.url()} ${body ?? ""}`.replace(/\+/g, " "));
    if ([...everTyped].some((value) => sent.includes(value))) seen.carried = true;
    let where: string | undefined;
    try { where = screen(request.frame().url()); } catch { /* a worker's request: from no screen of its own */ }
    if (where) seen.screens.add(where);
    const acted = Math.max(pressedAt, touchedAt);
    if (Date.now() - acted < PRESS_EXPLAINS_MS && acted > openedAt) {
      seen.pressed++;
      seen.controls.add(submitting?.label ?? "typed");
    }
  };
  /** Why a write is the page's own and no one's action, or undefined when a press explains it (see ambientWrites). */
  const ambientWhy = (w: { method: string; path: string; count: number; pressed: number; controls: Set<string>; screens: Set<string>; beacon: boolean; carried: boolean; cdn: boolean }) => {
    if (w.cdn) return "cdn" as const;
    if (w.carried) return undefined;
    if (w.beacon || keptAlive.has(`${w.method} ${w.path}`)) return "beacon" as const;
    if (w.pressed === 0) return "unprompted" as const;
    // Sent over and over, and only now and then after a press: the page's own, and the press a coincidence.
    if (w.count >= OWN_WRITE_COUNT && w.pressed * 2 < w.count) return "unprompted" as const;
    // A tracker follows whatever is pressed; a real action follows its own button, even on many
    // screens ("Add to cart" on every product). Only POST: PATCH and DELETE name a thing to change.
    return w.method === "POST" && (w.controls.size >= 3 || (w.screens.size >= 3 && w.controls.size !== 1)) ? "repeats" as const : undefined;
  };
  const ownHost = (hostname: string) => [...origins].some((o) => baseDomain(new URL(o).hostname) === baseDomain(hostname));

  /** Only events the site model takes are kept: one it would refuse (a blank frame's "page") is counted instead. */
  const keep = (event: CapturedEvent) => {
    if (CapturedEventSchema.safeParse(event).success) result.events.push(event);
    else result.invalidEvents++;
  };
  /** Runs one step of the learning and adds its time to result.timings. */
  const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const from = Date.now();
    try {
      return await run();
    } finally {
      result.timings[step] = (result.timings[step] ?? 0) + Date.now() - from;
    }
  };

  let browser: Browser | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  /** The watchdog closed the page: a hung run ends here, with what it has. */
  let overran = false;
  try {
    browser = await launchBrowser(seal?.browserArgs ?? (config.stayLocal ? LOCAL_ONLY_ARGS : undefined));
    const context = await browser.newContext({
      serviceWorkers: "block", acceptDownloads: false, userAgent: await visitorAgent(browser), viewport: VIEWPORT,
      ...(httpCredentials ? { httpCredentials } : {}),
      // A site's content security policy would stop the snippet sending what it read to the learner
      // (an address the site never named): the learner is the site's own tool, in its own browser.
      bypassCSP: true,
      ...(config.storageState ? { storageState: config.storageState } : {}),
      // The journeys ask for less motion, as a person may: an app that honours it draws the same
      // screens without the pauses of its animations, and nothing this browser sees is a finding.
      ...(walking ? { reducedMotion: "reduce" as const } : {}),
    });
    context.setDefaultNavigationTimeout(navTimeout);
    // A box that can't be typed in costs a step, not half a minute of the journeys' time.
    if (walking) context.setDefaultTimeout(WALK_ACTION_MS);
    if (config.storageState) result.loggedIn = true;
    let main: Page | undefined;
    /** The page of the last, signed-out look (see lookSignedOut): what it draws is never a screen of this pass. */
    let signedOutLook: Page | undefined;
    context.on("page", (p) => void (main && p !== main ? p.close().catch(() => {}) : undefined)); // pop-ups are never followed

    /**
     * Once a site has been given a made-up answer, what it keeps of it is ours: a sign-in form's reply
     * kept in localStorage is read by every page after, and the crash that causes is no fault of the
     * site's. So what the browser held just before the first such answer is kept (see the route below)
     * and put back before the next fresh load: localStorage, sessionStorage, and the cookies a script
     * could have set. Cookies only the server can set are left alone: nothing of ours is in them, and
     * a sign-in rotating its session must survive.
     */
    let earlier: Promise<{ origin: string; local: Record<string, string>; session: Record<string, string>; cookies: Awaited<ReturnType<typeof context.cookies>> }> | undefined;
    const keepEarlierState = async () => {
      if (walking) return; // what the app keeps of an answer is how a journey moves on: see Seal.keepSaves
      earlier ??= (async () => {
        const [stores, cookies] = await Promise.all([
          main!.evaluate(() => ({ origin: location.origin, local: { ...localStorage }, session: { ...sessionStorage } })).catch(() => ({ origin: "", local: {}, session: {} })),
          context.cookies().catch(() => []),
        ]);
        return { ...stores, cookies };
      })();
      // A page stuck in a synchronous request can't answer: the write mustn't wait on it for ever.
      await Promise.race([earlier, new Promise((resolve) => setTimeout(resolve, 500))]);
    };
    const forgetOurAnswers = async () => {
      if (!earlier || !main) return;
      const kept = await earlier;
      earlier = undefined;
      await main.evaluate((was) => {
        if (location.origin !== was.origin) return;
        for (const [store, values] of [[localStorage, was.local], [sessionStorage, was.session]] as const) {
          store.clear();
          for (const [key, value] of Object.entries(values)) store.setItem(key, value);
        }
        // The page is about to go: what it saves as it closes mustn't undo this.
        for (const name of ["setItem", "removeItem", "clear"] as const) Storage.prototype[name] = () => {};
      }, { origin: kept.origin, local: kept.local, session: kept.session }).catch(() => {});
      const id = (c: { name: string; domain: string; path: string }) => `${c.name}|${c.domain}|${c.path}`;
      const before = new Map(kept.cookies.map((c) => [id(c), c]));
      for (const c of (await context.cookies().catch(() => [])).filter((c) => !c.httpOnly && before.get(id(c))?.value !== c.value)) {
        await context.clearCookies({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
        const was = before.get(id(c));
        if (was) await context.addCookies([was]).catch(() => {});
      }
    };
    /** Just before a fresh page load of ours. */
    const beforeLoad = async () => {
      await forgetOurAnswers();
      openedAt = Date.now();
      without = { calls: false, styles: false, fonts: false };
      logged = [];
      turnedAway = false;
    };

    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return route.abort();
      }
      const origin = url.origin;
      // A page load we don't let through is answered "nothing to show" (204): the browser stays on
      // the page it was on, as it does for any 204, instead of showing an error page of its own.
      const pageLoad = request.isNavigationRequest();
      /** A frame inside the page. A pop-up's first load has no frame yet to ask, and is no frame inside anything. */
      const inFrame = () => {
        try {
          return request.frame().parentFrame() !== null;
        } catch {
          return false;
        }
      };
      // A frame inside the page can't stay where it was: it's refused outright, or the page's load waits on it for ever.
      const refuse = () => (pageLoad && !(seal && inFrame()) ? route.fulfill({ status: 204 }) : route.abort("blockedbyclient"));
      const worker = url.searchParams.has(WORKER_MARK);
      const body = request.postData() ?? undefined;
      /** The seal's answer to a save it stopped, when it has one of its own. */
      let sealedReply: Reply | undefined;
      // First of all, ahead of the rule below: that one lets other hosts' reads through, and here nothing may.
      if (seal) {
        let sealed: SealVerdict;
        try {
          sealed = seal.judge({ method, type: worker ? "script" : request.resourceType(), url, headers: request.headers(), body, inFrame: inFrame(), popUp: pageLoad && isPopUp(request, main) });
        } catch {
          sealed = { act: "refuse" }; // a seal that can't decide is shut
        }
        if (sealed.act === "refuse") {
          heldFrom(request, url);
          return refuse();
        }
        if (sealed.act === "answer") {
          aborted.add(request);
          return route.fulfill(sealedFulfill(sealed.reply, request.headers().origin, origin));
        }
        if (sealed.act === "shell" || sealed.act === "file") {
          // Allowed by the seal, and still under the read-only rule. Nothing here is sent by the browser (see Seal.browserArgs).
          const ruled = judge({ method, type: worker ? "script" : request.resourceType(), url, headers: request.headers(), body, navigation: pageLoad }, guard);
          const shell = sealed.act === "shell" && !(pageLoad && isPopUp(request, main));
          const file = ruled.act === "pass" && sealed.act === "file" ? await seal.readFile({ method, type: worker ? "script" : request.resourceType(), url: withoutMark(url), headers: request.headers() }) : undefined;
          if (ruled.act === "pass" && shell) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: seal.shell ?? "" });
          if (!file) {
            heldFrom(request, url);
            return refuse();
          }
          if (worker) return route.fulfill({ status: file.status, ...(file.contentType ? { contentType: file.contentType } : {}), body: withoutSockets(file.body.toString(), url.searchParams.get(WORKER_MARK) === "module") });
          return route.fulfill({ status: file.status, ...(file.contentType ? { contentType: file.contentType } : {}), body: file.body });
        }
        if (sealed.act === "save") sealedReply = sealed.reply ?? { status: 200, contentType: "application/json", body: SIMULATED_REPLY };
      }
      if (worker) {
        try {
          const asked = screen(request.frame().page().url());
          if (asked) workersOn.add(asked);
        } catch {
          // a worker started by a worker: its page started one already
        }
        if (offLimits(url)) {
          noteAway(url);
          return route.abort("blockedbyclient");
        }
        return startWithoutSockets(route, url);
      }
      const ruled: Verdict = sealedReply ? { act: "stop" } : judge({ method, type: request.resourceType(), url, headers: request.headers(), body, navigation: pageLoad }, guard);
      // A read of someone else's is fine by the read-only rule. A local run has its own, and doesn't send it.
      const call = PAGE_CALLS.has(request.resourceType());
      const verdict: Verdict = ruled.act === "pass" && offLimits(url, call) ? { act: "refuse" } : ruled;
      const type = request.resourceType();
      // Run ahead, the page's timers may send it elsewhere (a session's timeout): it stays where it is.
      if (runningAhead && pageLoad && !inFrame()) return refuse();
      if (pageLoad && !inFrame() && !isPopUp(request, main) && verdict.act === "pass") withoutItsCode = withoutExtras = false;
      if (verdict.act === "refuse" && offLimits(url, call)) {
        noteAway(url);
        // What stands on a library this run kept from the page falls over without it, on this load
        // and at any press after. A font link or an analytics tag stops no button (one is on half
        // of all pages, and a tag queues its calls), so those cover the load alone, or a local run
        // with Google Fonts on it could prove nothing at all.
        /** The screen whose page asked: a frame's is its page's, and a worker's the page open now. */
        const asker = () => {
          try {
            return screen(request.frame().page().url());
          } catch {
            return main ? screen(main.url()) : undefined;
          }
        };
        const layer = type === "script" ? tagManager(url) : undefined;
        if (layer) {
          const asked = asker();
          if (asked) tagsKeptFrom.set(asked, (tagsKeptFrom.get(asked) ?? new Set()).add(layer));
        }
        const workersCode = type === "other" && workersOn.has(asker() ?? "\u0000");
        if ((type === "script" || workersCode) && !backgroundHost(url.hostname)) {
          withoutItsCode = true;
          const asked = asker();
          if (asked) refusedOn.add(asked);
        }
        else if (type === "script" || type === "stylesheet") withoutExtras = true;
      }
      if (verdict.act === "pass") {
        // A pop-up is never followed, and goes where a redirect's hops can't be seen (see Fetch.enable below).
        if (pageLoad && isPopUp(request, main)) return refuse();
        if (!SAFE_METHODS.has(method) && onlyGraphqlReads(body, request.headers()["content-type"])) graphqlReads.add(graphqlRead(place(request.url())?.path ?? "", parseBody(body).graphqlOperation));
        // A save let through by --create is still sorted from what the page sends by itself.
        else if (!SAFE_METHODS.has(method) && config.realWrites && phase === "crawl") noteWrite(request, place(request.url())?.path ?? "?", parseBody(body).graphqlOperation, body);
        return route.continue();
      }
      /**
       * A back end on another domain (a hosted database, api.other-domain.com): a write the page's own
       * code sends right after a press is a stopped save like any other, answered here so it never
       * leaves the browser. A read isn't a save, nor is a GraphQL one, nor a consent, ad or analytics
       * host's call (see backgroundHost), and anything else to another host is refused.
       */
      const beacon = type === "ping";
      const parsed = parseBody(body);
      const elsewhere = !apiOrigin(origin);
      const hostedSave = phase === "crawl" && learn && CAPTURED_TYPES.has(type) && !SAFE_METHODS.has(method) && !backgroundHost(url.hostname) && !onlyGraphqlReads(body, request.headers()["content-type"]) && Date.now() - Math.max(pressedAt, touchedAt) < PRESS_EXPLAINS_MS;
      if (verdict.act === "refuse" && !hostedSave) {
        heldFrom(request, url);
        // A page finds out when its request is refused, as it never would in a real browser, and a
        // script may throw for it. A beacon's sender can't tell.
        if (CAPTURED_TYPES.has(type)) interferedAt = Date.now();
        return refuse(); // third parties: read-only too
      }
      // Answered here, so the app carries on. A request to the site's API host (api.acme.com from
      // www.acme.com) is a cross-origin one: our answer says the page may read it.
      const from = request.headers().origin;
      const cors = from && from !== origin ? { "access-control-allow-origin": from, "access-control-allow-credentials": "true", vary: "Origin" } : undefined;
      if (verdict.act === "hold") {
        interferedAt = Date.now();
        holdBack(url, verdict.why, !pageLoad);
        aborted.add(request);
        stopped.add(request);
        if (pageLoad || !CAPTURED_TYPES.has(request.resourceType()) || !learn) return refuse();
        answered++;
        savedAt = interferedAt; // a made-up answer like any other: what follows it proves nothing
        await keepEarlierState();
        return route.fulfill({ status: 200, contentType: "application/json", body: SIMULATED_REPLY, ...(cors ? { headers: cors } : {}) });
      }
      const n = place(request.url());
      const path = n && elsewhere ? placePath(n.path, new URL(n.origin).host, start.host) : n?.path ?? "?";
      const blocked: ScanResult["blockedWrites"][number] = { method, path };
      if (parsed.graphqlOperation) blocked.graphqlOperation = parsed.graphqlOperation;
      // A GraphQL read stopped by a press that acts is still a read, whatever the snippet says of it.
      const onlyReads = !SAFE_METHODS.has(method) && onlyGraphqlReads(body, request.headers()["content-type"]);
      if (onlyReads) graphqlReads.add(graphqlRead(n?.path ?? "", parsed.graphqlOperation));
      // A save sent as a read: recorded as sent, marked as what it does, with what the address carried.
      const sent = SAFE_METHODS.has(method) ? { as: method, data: Object.fromEntries(url.searchParams) as unknown, marks: { save: true as const } } : { as: onlyReads ? "QUERY" : method, data: parsed.data, marks: {} };
      noteWrite(request, path, parsed.graphqlOperation, body);
      const upkeep = n !== undefined && CDN_OWN.test(n.path);
      // A beacon's reply is never read, so nothing can follow from it.
      if (!beacon) interferedAt = Date.now();
      if (!beacon && !upkeep) {
        savedAt = interferedAt;
        answered++;
        await keepEarlierState();
      }
      // Sorted into saves and what the page sends by itself when the run ends (see ambientWhy).
      result.blockedWrites.push(blocked);
      stopped.add(request);
      // A classic form that sends by loading a page (method="post"): the page it would load is the
      // server's, which we can't know, and a reply of ours shown as a page would be read and
      // photographed as a screen. So the save is recorded here, as the snippet would record a fetch
      // (what was sent, from which button, on which page), and the browser stays where it was.
      if (pageLoad) {
        if (phase === "crawl" && n && learn && Date.now() - pressedAt < 5000) {
          const where = submitting?.page ?? screen(request.frame().url());
          const op = intentOf(sent.data, true);
          keep({
            t: ++t, kind: "network", method: sent.as, ...sent.marks, path: n.path, queryKeys: n.queryKeys, fields: describeFields(sent.data, allowValues),
            // Two buttons of one form that send different values are two actions; the pressed one's goes with the form.
            ...(op ? { graphqlOperation: op } : {}),
            trigger: { type: "submit", tag: submitting?.tag ?? "form", ...(submitting?.label ? { label: submitting.label } : {}), ...(where ? { page: where } : {}) },
          });
        }
        return route.fulfill({ status: 204 });
      }
      // Only what followed a press of ours: a page's own background writes (telemetry) aren't anyone's action.
      if (phase === "crawl" && n && !CDN_OWN.test(n.path) && Date.now() - pressedAt < 5000) {
        // The snippet doesn't watch other hosts, and a save sent as a read is dropped with the reads: which button it followed is said here.
        const trigger = (elsewhere || SAFE_METHODS.has(method)) && submitting ? { trigger: { type: "click" as const, tag: submitting.tag, ...(submitting.label ? { label: submitting.label } : {}), ...(submitting.page ? { page: submitting.page } : {}) } } : {};
        unreported.push({ t: ++t, kind: "network", method: sent.as, ...sent.marks, path, queryKeys: n.queryKeys, fields: describeFields(sent.data, allowValues), ...(parsed.graphqlOperation ? { graphqlOperation: parsed.graphqlOperation } : {}), ...trigger });
      }
      // Never sent: answered here, so the app carries on as if it had saved.
      if (learn && sealedReply) return route.fulfill(sealedFulfill(sealedReply, from, origin));
      if (learn) return route.fulfill({ status: 200, contentType: "application/json", body: SIMULATED_REPLY, ...(cors ? { headers: cors } : {}) });
      return route.abort("blockedbyclient");
    });
    // Live connections: the connection itself is real (pages need it to draw), but only messages
    // known to keep it up or to ask for data reach the server (see socketUpkeep). Everything else is
    // held back: a message we can't read (another protocol, or binary) may be a save or a delete as
    // easily as anything. One that followed a press of ours, or names an action, is a stopped write.
    await context.routeWebSocket(/.*/, (ws) => {
      // Opening one is a GET: an address that commands, or carries what was typed, is never opened.
      const opens = new URL(ws.url().replace(/^ws/, "http"));
      if (!seal && offLimits(opens)) {
        noteAway(opens);
        return void ws.close();
      }
      if (phase === "crawl" && (commandIn(opens) === "command" || carriesTyped(opens, undefined, typed) || guard.holding())) return void ws.close();
      // Sealed, the page's side stays open and nothing is behind it: a socket that fails sends a dev
      // server's client into reloading the page, and an open one with nobody there reaches no one.
      const server = seal ? undefined : ws.connectToServer();
      ws.onMessage((message) => {
        const fine = typeof message === "string" && socketUpkeep(message) && !guard.holding() && !carriesTyped(new URL(start.origin), message, typed);
        if (phase !== "crawl" || fine) return server?.send(message);
        const action = typeof message === "string" ? readMessage(message) : undefined;
        interferedAt = Date.now();
        if (!action && Date.now() - pressedAt >= 5000) return; // the page's own background chatter
        let path = "/";
        try { path = place(ws.url().replace(/^ws/, "http"))?.path ?? "/"; } catch { /* kept as "/" */ }
        const name = action?.operation ?? (typeof message === "string" ? "message" : "binary");
        result.blockedWrites.push({ method: "WS", path, graphqlOperation: `ws:${name}` });
        savedAt = interferedAt;
      });
    });

    // What no filter can reach doesn't exist, in pages or in workers (see noLooseSockets).
    await context.addInitScript(noLooseSockets);
    if (seal) {
      await context.exposeBinding("__ctxStandInRead", (_source, adapter: string) => seal.noteSessionRead(adapter));
      await context.addInitScript(answerSessionReads, seal.recipes());
    }
    await context.addInitScript(readControls);
    // No file ever goes into a walk: a chooser is where a person would have to pick one, and it's noted as that.
    if (walking && seal) {
      await context.exposeBinding("__ctxFilePicker", () => seal.note("file", "the file choice"));
      await context.addInitScript(refuseFilePickers);
    }
    // Before the snippet, so what it does itself is told apart (see watchEffects).
    await context.exposeBinding("__ctxKeepalive", (_source, href: string, method: string) => {
      const n = place(href);
      if (n) keptAlive.add(`${method.toUpperCase()} ${apiOrigin(n.origin) ? n.path : placePath(n.path, new URL(n.origin).host, start.host)}`);
    });
    await context.addInitScript(watchEffects);
    context.on("request", (request) => {
      if (!request.url().startsWith(SCAN_ENDPOINT)) outsideEffects++;
    });
    context.on("page", () => void outsideEffects++);
    /** Saves let through for real (--create): with those stopped, how many saves a page has tried to send. */
    let passedWrites = 0;
    context.on("request", (request) => {
      if (config.realWrites && !SAFE_METHODS.has(request.method().toUpperCase()) && !request.url().startsWith(SCAN_ENDPOINT)) passedWrites++;
    });
    const sentSoFar = () => result.blockedWrites.filter((w) => !CDN_OWN.test(w.path)).length + passedWrites;
    // An API host of the site's own, seen for the first time: the snippet watches it from the next page on.
    const apis = new Set<string>();
    context.on("request", (request) => {
      let origin: string;
      try { origin = new URL(request.url()).origin; } catch { return; }
      if (origins.has(origin) || apis.has(origin) || !apiOrigin(origin)) return;
      apis.add(origin);
      void context.addInitScript({ content: `window.__ctxApis=${JSON.stringify([...apis])};` }).catch(() => {});
    });
    /**
     * The site's own requests still loading. A page counts as loaded once these stop, whatever its
     * adverts and trackers do: a page full of ads is never quiet, and waiting on it wasted most of
     * a run. Streams that never end (live updates, video) don't count.
     */
    const loading = new Map<Request, number>();
    let trafficAt = 0;
    const ownTraffic = (request: Request) => {
      if (request.url().startsWith(SCAN_ENDPOINT) || ["eventsource", "websocket", "media", "ping"].includes(request.resourceType())) return false;
      try { return ownHost(new URL(request.url()).hostname); } catch { return false; }
    };
    context.on("request", (request) => {
      if (!ownTraffic(request)) return;
      loading.set(request, Date.now());
      trafficAt = Date.now();
    });
    const loaded = (request: Request) => void (loading.delete(request) && (trafficAt = Date.now()));
    context.on("requestfinished", loaded);
    context.on("requestfailed", loaded);

    /**
     * Hosts other than the site's that are its API for certain: the page called them itself (fetch or
     * XHR) and they answered. A host that merely shares the site's domain (cdn., metrics.) or its
     * machine (another port on localhost: a dev tool's live-reload server) is no part of the product
     * until it does.
     */
    const answeringApis = new Set<string>();
    context.on("requestfinished", (request) => {
      if (!CAPTURED_TYPES.has(request.resourceType())) return;
      void request.response().then((response) => {
        if (response && response.status() < 500) answeringApis.add(new URL(request.url()).origin);
      }).catch(() => {});
    });
    /** Failed requests to API hosts not yet known to answer: reported at the end, if one has answered by then. */
    const maybeFailures: { origin: string; finding: Omit<Finding, "count"> }[] = [];
    /**
     * A request of the site's that failed on the server or the network: a 5xx, the server not
     * answering, an API read whose address doesn't exist (see missingRead), or an image of the site's
     * own on show, broken (see shownBroken). The site's own requests are
     * those to the addresses it's learned at, and its fetches and XHRs to an API host that answered
     * others (see answeringApis): anything else (a script from a cdn. host, a dev server's other port)
     * isn't the product's to fail. Pages themselves are left to broken links, and writes count only
     * when they really went through (--create): ours are answered by us.
     */
    /**
     * A read answered 404 is often how an app says "none yet", however it says it: JSON, plain text or
     * nothing at all. It's a missing address only when a framework answered (a whole error page, not
     * the words "Not found" sent as text/html), or when the page then says something went wrong.
     */
    const missingRead = async (type: string, text: () => Promise<string>) => {
      if (/json/i.test(type)) return false;
      if (/html/i.test(type) && /<(!doctype|html|head|title|body|h1|pre)\b/i.test(await text().catch(() => ""))) return true;
      // Only the page that asked can be saying so: an alert on the next page isn't about this read.
      const asked = main?.url();
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (main?.url() !== asked) return false;
      return (await main?.evaluate(() => [...document.querySelectorAll("[role=alert], [aria-live=assertive]")].some((el) =>
        el.checkVisibility() && /error|fail|wrong|could ?n.t|couldn.t|unable|problem/i.test((el as HTMLElement).innerText))).catch(() => false)) === true;
    };
    /**
     * Whether an image of the page's own that failed is on show, broken: a person sees it. A fallback
     * in its place (an avatar's initials), or a hidden one, a person doesn't.
     */
    const shownBroken = async (src: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await main?.evaluate((src) => [...document.images].some((img) => img.src === src && img.complete && img.naturalWidth === 0 && img.checkVisibility()), src).catch(() => false)) === true;
    };
    context.on("response", (response) => {
      const request = response.request();
      if ((response.status() === 401 || response.status() === 403) && ownHost(new URL(response.url()).hostname)) turnedAway = true;
      if (request.resourceType() !== "image" || aborted.has(request)) return;
      // A dev server's answer to a file it doesn't have is the app's page, with a 200.
      if (response.status() >= 400 || /text\/html/i.test(response.headers()["content-type"] ?? "")) failedImages.set(request.url(), response.status());
    });
    /** A file of the app's own that the page needed and didn't get, and the response that shows it. */
    const failedFile = (request: Request, url: URL, status: number, where: string) => {
      if (!["script", "stylesheet", "font"].includes(request.resourceType()) || !origins.has(url.origin) || status < 400 || PLATFORM_OWN.test(url.pathname)) return;
      if (!seal && status >= 500) return; // a finding already (see below)
      addCheck({ kind: "failed_request", screen: screen(where) ?? "/", target: `GET ${url.pathname}`, evidence: `the ${request.resourceType()} came back ${status}` });
    };
    const noteFailure = async (request: Request, errorText?: string) => {
      if (phase !== "crawl" || !exploring || aborted.has(request) || stopped.has(request) || refusedUs()) return;
      // Nothing that follows one of our made-up answers is proof about the site.
      if (Date.now() - savedAt < AFTER_OUR_ANSWER_MS) return;
      // Nor what its timers did when run ahead of time (see settlesAhead).
      if (justAhead()) return;
      const type = request.resourceType();
      if (type === "document") return;
      const h = request.headers();
      if (h.purpose === "prefetch" || h["sec-purpose"] !== undefined || h["next-router-prefetch"] !== undefined) return;
      const method = request.method().toUpperCase();
      if (!SAFE_METHODS.has(method) && !config.realWrites) return;
      const url = place(request.url());
      if (!url || byOurId(request.url())) return;
      const own = origins.has(url.origin);
      if (!own && !(CAPTURED_TYPES.has(type) && apiOrigin(url.origin))) return;
      let where = main?.url() ?? start.href;
      try { where = request.frame().url() || where; } catch { /* a worker's request: the page it's for */ }
      const sincePress = pressedAt > loadedAt && Date.now() - pressedAt < 5000;
      // A browser gives up on a stylesheet with a bad answer, so a file's failure can come as either event.
      if (!sincePress && method === "GET") failedFile(request, new URL(request.url()), (await request.response().catch(() => null))?.status() ?? 0, where);
      let evidence: string | undefined;
      if (errorText) {
        if (SERVER_UNREACHABLE.test(errorText)) evidence = errorText.replace(/^net::/, "");
      } else {
        const response = await request.response();
        const status = response?.status() ?? 0;
        // A 503 is the server saying it's busy for now (overloaded, throttling a burst of loads, down
        // for maintenance): a moment's state, not something wrong with the product.
        if (status >= 500 && status !== 503) evidence = String(status);
        else if (status === 404 && method === "GET" && response) {
          if (CAPTURED_TYPES.has(type) && (await missingRead(response.headers()["content-type"] ?? "", () => response.text()))) evidence = "404";
          else if (type === "image" && own && (await shownBroken(request.url()))) evidence = "404";
        }
      }
      if (!evidence) return;
      // Another host's request names its host, so it doesn't read as a missing file of the site's own.
      const target = `${method} ${url.origin === start.origin ? "" : new URL(url.origin).host}${url.path}`;
      const finding = { kind: "request_fails" as const, screen: screen(where) ?? "/", target, evidence, ...(sincePress && lastPress ? { after: lastPress } : {}) };
      if (own || answeringApis.has(url.origin)) addFinding(finding);
      else maybeFailures.push({ origin: url.origin, finding });
    };
    context.on("requestfinished", (request) => void noteFailure(request).catch(() => {}));
    context.on("requestfailed", (request) => void noteFailure(request, request.failure()?.errorText ?? "failed").catch(() => {}));

    // The real snippet reads each page's structure; its batches come here instead of to a server.
    if (snippet) {
      // Started once the document exists, as a real install would be (only structure is needed here, not requests).
      // With the browser's own timers, not the ones the page's are kept by (see watchEffects): its flush isn't the page's work.
      // Signed out, numbers are kept as written ("Pro at $9 a month"): no one's records are on screen.
      // Signed in, they're masked, as the live snippet masks them (see keepNumbers).
      // The site's API hosts found so far (see apiOrigin) are watched too, from the next page loaded.
      await context.addInitScript({ content: `document.addEventListener("DOMContentLoaded",function(){window.__ctx={q:[["init",{key:"pk_test_sitescanner",endpoint:${JSON.stringify(SCAN_ENDPOINT)},captureOrigins:${JSON.stringify([...origins])}.concat(window.__ctxApis||[]),keepNumbers:${keepNumbers},buttonIntents:true,routeKeys:window.__ctxRouteKeys||[]}]]};\n(function(setTimeout,clearTimeout,setInterval,clearInterval){\n${snippet}\n}).apply(this,["setTimeout","clearTimeout","setInterval","clearInterval"].map(function(n){return (window.__ctxTimers||{})[n]||window[n];}));\n});` });
      await context.route(`${SCAN_ENDPOINT}*`, async (route) => {
        try {
          const batch = JSON.parse(route.request().postData() ?? "{}") as { events?: CapturedEvent[] };
          // Pages are told apart by address: the batch comes from the page it describes. Only the
          // page itself, on the site, describes the product: a frame inside it (a blank one, an
          // advert's) or the browser's own error page doesn't.
          const frame = route.request().frame();
          const from = new URL(frame.url());
          const host = from.host;
          // The signed-out look draws the sign-in form at a protected address: that's a check, not the screen.
          // Its snippet reports whenever its batch is sent, which under load can be before the look is over.
          if (phase === "crawl" && frame.parentFrame() === null && site.has(from.origin) && frame.page() !== signedOutLook) {
            for (const e of batch.events ?? []) {
              // What a person would cause: screens and views, presses, and the requests they send.
              // Stuck-moment guesses about a robot mean nothing, and are left out.
              if (e.kind !== "page" && e.kind !== "route" && e.kind !== "interaction" && e.kind !== "network") continue;
              let kept = placeEvent(e, host, start.host);
              // Reads are recorded by the scan itself (above); writes come from here.
              if (kept.kind === "network" && (SAFE_METHODS.has(kept.method) || CDN_OWN.test(kept.path))) continue;
              // A GraphQL read: recorded as a read below, not a save.
              if (kept.kind === "network" && graphqlReads.has(graphqlRead(kept.path, kept.graphqlOperation))) continue;
              // A write we answered ourselves: what it sends is real, how it went is not.
              if (kept.kind === "network" && !SAFE_METHODS.has(kept.method)) {
                const { status: _s, failed: _f, errorCode: _c, result: _r, ...rest } = kept;
                kept = rest;
                const k = kept;
                const i = unreported.findIndex((w) => w.method === k.method && w.path === k.path);
                if (i >= 0) unreported.splice(i, 1);
              }
              keep({ ...kept, t: ++t });
            }
          }
        } catch {
          // a batch we can't read is skipped, never fatal
        }
        return route.fulfill({ status: 204 });
      });
    }

    context.on("requestfinished", (request) => void record(request).catch(() => {}));
    const record = async (request: Request) => {
      // Reads are recorded here (the snippet starts after the page's first requests); writes come
      // from the snippet, with the button behind each.
      // Sealed, every read was answered by us: what came back says nothing about the site (see Seal.asked).
      if (seal || phase !== "crawl" || !CAPTURED_TYPES.has(request.resourceType())) return;
      // A framework fetching the next page's data (Next.js on hover): page plumbing, not an action.
      const h = request.headers();
      if (h.rsc !== undefined || h["next-router-prefetch"] !== undefined || h["next-router-state-tree"] !== undefined || /[?&]_rsc=/.test(request.url())) return;
      if (snippet && stopped.has(request)) return;
      const url = place(request.url());
      if (!url || !apiOrigin(url.origin) || CDN_OWN.test(url.path)) return;
      // Asked for by our made-up answer, not by the site: an address it left a hole in, or its id just
      // after we gave it. Only a query field named for an id: ?page=1 is the site's own.
      const asked = new URL(request.url());
      if (answered > 0 && (hasMissingValue(asked) || (Date.now() - savedAt < AFTER_OUR_ANSWER_MS && [...asked.searchParams].some(([key, value]) => value === "1" && /id$/i.test(key))))) return;
      const response = await request.response();
      const sent = request.postData() ?? undefined;
      const parsed = parseBody(sent);
      const event: CapturedEvent = {
        t: ++t,
        kind: "network",
        // A GraphQL read, named or not, reads as a save if it's filed as a POST. QUERY is what it is.
        method: onlyGraphqlReads(sent, request.headers()["content-type"]) ? "QUERY" : request.method().toUpperCase(),
        path: url.path,
        queryKeys: url.queryKeys,
        fields: describeFields(parsed.data, allowValues),
        status: response?.status() ?? 0,
      };
      if (parsed.graphqlOperation) event.graphqlOperation = parsed.graphqlOperation;
      keep(event);
    };

    /**
     * Where the start address finally landed is the site: apex to www, or http to https, moves the
     * whole site to that origin, so it's what links, screens and the snippet's reports are judged by
     * from then on. Done as the page arrives, not after it has settled, as its first report comes
     * soon after. Another site altogether isn't adopted (see startLeftFor).
     */
    let openingStart = false;
    const adoptLanding = (href: string) => {
      const url = new URL(href);
      if (!/^https?:$/.test(url.protocol) || phase !== "crawl" || site.has(url.origin)) return;
      if (url.hostname !== start.hostname && baseDomain(url.hostname) !== baseDomain(start.hostname)) return;
      site.add(url.origin);
      origins.add(url.origin);
      start = url;
      result.startOrigin = url.origin;
      apis.add(url.origin);
      void context.addInitScript({ content: `window.__ctxApis=${JSON.stringify([...apis])};` }).catch(() => {});
    };
    const page: Page = await context.newPage();
    // "Are you sure?": yes when learning (what follows is answered by us), no otherwise. One about
    // destroying something starts the hold, and a press that acts gets a yes only while it's held.
    // With --create no such question ever gets a yes: writes really go through there.
    page.on("dialog", (d) => {
      // A journey says no to every question: a yes is a press this run didn't choose, and one about destroying something ends it.
      if (walking) {
        if (saysDestroys(d.message())) seal?.note("destroys", "a question about destroying something");
        // "Leave this page?" is the one yes: a no would keep the next journey from starting.
        return void (d.type() === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {});
      }
      const risky = saysDestroys(d.message());
      if (risky) pressActed = true;
      if (risky) heldUntil = Date.now() + HOLD_MS;
      const yes = learn && phase === "crawl" && !(config.realWrites && (risky || pressActed)) && (!pressActed || guard.holding());
      void (yes ? d.accept() : d.dismiss()).catch(() => {});
    });
    main = page;
    const cdp = await context.newCDPSession(page);
    // Playwright hides a redirect's hops from context.route, so a harmless address could answer 302
    // to a destructive one. Each hop is paused here instead and put to the same rule. (Asking for
    // the hops by route.fetch would swap the browser's own connection for Node's, which streams
    // nothing and which bot walls turn away.) Workers' requests come through here too.
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: httpCredentials !== undefined });
    // With this session in the way, a server's request for a password stops here first.
    cdp.on("Fetch.authRequired", (e) => {
      const ours = httpCredentials && new URL(e.request.url).origin === httpCredentials.origin;
      cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: ours ? { response: "ProvideCredentials", username: httpCredentials.username, password: httpCredentials.password } : { response: "Default" } }).catch(() => {});
    });
    /** Where each request that isn't a GET or HEAD is going, by CDP's id: its redirect may replay it. */
    const sentTo = new Map<string, string>();
    cdp.on("Fetch.requestPaused", (e) => {
      const url = new URL(e.request.url);
      const method = e.request.method.toUpperCase();
      const replays = method !== "GET" && method !== "HEAD";
      const hopAllowed = () => {
        if (e.redirectedRequestId === undefined) return true;
        const from = sentTo.get(e.redirectedRequestId);
        sentTo.delete(e.redirectedRequestId);
        if (offLimits(url, e.resourceType !== "Document")) {
          noteAway(url);
          interferedAt = heldHopAt = Date.now();
          return false;
        }
        const verdict = judge({ method, type: e.resourceType.toLowerCase(), url, headers: e.request.headers, ...(e.request.postData !== undefined ? { body: e.request.postData } : {}), navigation: e.resourceType === "Document" }, guard);
        // A 307 or 308 sends its body on: only to the address it was meant for (http to https, apex to www).
        if (verdict.act === "pass" && !(phase === "crawl" && replays && from !== url.pathname)) return true;
        interferedAt = heldHopAt = Date.now();
        if (verdict.act === "stop" && !SAFE_METHODS.has(method)) result.blockedWrites.push({ method, path: place(url.href)?.path ?? "?" });
        else holdBack(url, "redirect", e.resourceType !== "Document");
        return false;
      };
      const allowed = hopAllowed();
      if (allowed && replays) sentTo.set(e.requestId, url.pathname);
      const sent = allowed ? cdp.send("Fetch.continueRequest", { requestId: e.requestId }) : cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: 204 });
      sent.catch(() => {}); // the page has gone
    });
    // A page's main thread that stops (a loop that never ends) stops every step with it, so it's
    // checked from outside, and what's running is ended. The page lives on and the run moves past it.
    let beating = false;
    heartbeat = setInterval(() => {
      if (beating) return;
      beating = true;
      void Promise.race([page.evaluate(() => 1).then(() => true, () => true), new Promise<boolean>((resolve) => void setTimeout(resolve, STUCK_MS, false).unref())]).then(async (alive) => {
        if (!alive) {
          result.errors.push(`${screen(page.url()) ?? "a page"}: stopped responding, so what it was running was ended`);
          await cdp.send("Runtime.terminateExecution").catch(() => {});
        }
        beating = false;
      });
    }, STUCK_MS);
    heartbeat.unref();
    // The last word on --minutes: whatever a page is doing, closing it ends every step waiting on it.
    watchdog = setTimeout(() => {
      overran = true;
      result.stoppedBy = "max_duration";
      void page.close({ runBeforeUnload: false }).catch(() => {});
    }, Math.max(0, deadline - Date.now()) + WATCHDOG_MARGIN_MS);
    page.on("dialog", () => void outsideEffects++);
    page.on("download", () => void outsideEffects++);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (signingIn) phase = "crawl"; // sent: the page it led to is the site's, and its saves are as real as any
      outsideEffects++;
      loadedAt = Date.now(); // a page's own scripts run before it has finished loading
      if (openingStart) adoptLanding(frame.url());
    });
    page.on("domcontentloaded", () => void (loadedAt = Date.now()));
    page.on("load", () => void (loadedAt = Date.now()));
    /**
     * The site's own script crashing, just after a press or a page load of ours. Only an error thrown
     * in the site's own files counts (its address, or a host of its own like its CDN): third parties'
     * errors, errors with no file, and anything soon after we stopped or answered one of its requests
     * (an app surprised by our answer) are left out. Only the first line and the file name are kept.
     */
    page.on("pageerror", (error) => {
      outsideEffects++; // a button whose handler threw did something: it crashed (reported below, if it's the site's)
      const now = Date.now();
      if (phase !== "crawl" || !exploring || now - Math.max(pressedAt, loadedAt) > CRASH_WINDOW_MS || now - interferedAt < 3000 || refusedUs() || justAhead()) return;
      const text = firstLine(`${error.name && !error.message.startsWith(error.name) ? `${error.name}: ` : ""}${error.message}`);
      if (!text || NOT_A_CRASH.test(text) || NOT_A_CRASH.test(error.message)) return;
      // Where it was thrown: the stack's top frame, never anything further down.
      const top = (error.stack ?? "").split("\n").find((l) => /^\s+at /.test(l));
      const from = top && /(https?:\/\/[^\s)]+?):\d+:\d+/.exec(top)?.[1];
      if (!from) return;
      let file: URL;
      try { file = new URL(from); } catch { return; }
      if (!ownHost(file.hostname)) return;
      const name = /\.[cm]?js$/i.test(file.pathname) ? file.pathname.split("/").pop()! : "a script in the page";
      addFinding({ kind: "crashes", screen: screen(page.url()) ?? "/", target: text, evidence: name, ...(pressedAt > loadedAt && lastPress ? { after: lastPress } : {}) });
    });
    // Kept for now: only when the page has drawn can it be said what this load went without.
    page.on("console", (entry) => {
      if (seal || entry.type() !== "error" || phase !== "crawl" || !exploring || pressedAt > loadedAt) return;
      if (logged.length < 20) logged.push({ text: firstLine(entry.text()), file: entry.location().url });
    });
    /** Waits, at most `ms`, for the site's own requests to stop (see `loading`), or only those started since `from`. */
    const waitForQuiet = async (ms: number, from = -Infinity) => {
      const until = Date.now() + ms;
      // A request still open after 10s is a long poll or a stalled one: it's not what the page waits on.
      const stillLoading = () => [...loading.values()].some((since) => since >= from && Date.now() - since < 10_000);
      while (Date.now() < until && !interrupted() && (stillLoading() || Date.now() - trafficAt < QUIET_MS)) await page.waitForTimeout(100);
    };
    // The site's own requests quiet, or 5s: sites that poll are never quiet.
    const settle = () => waitForQuiet(Math.min(navTimeout, 5000));
    /** After a press: a moment for what it set off, not a full page's wait. */
    const settleQuick = () => waitForQuiet(2000);
    /**
     * Waits, at most a few seconds, until the page shows something worth reading (a heading, or its
     * main text): a single-page app draws after it loads, and read too early it looks empty.
     */
    const waitForContent = () =>
      page.waitForFunction(() => {
        const said = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").trim();
        if ([...document.querySelectorAll("h1, h2, h3, [role=heading]")].some((h) => said(h) !== "")) return true;
        return said(document.querySelector("main, [role=main]") ?? document.body).length > 200;
      }, undefined, { timeout: Math.max(0, Math.min(CONTENT_WAIT_MS, deadline - Date.now())), polling: 100 }).then(() => true, () => false);
    /**
     * A journey's wait for a page: what's worth reading (see waitForContent), or something in the
     * page itself to press or type in. A chat or a wizard often has no heading and little text, and
     * waiting out CONTENT_WAIT_MS on each was time for nothing: the step's own look (see Drive.look)
     * waits for what's drawn to hold still, whatever this let through.
     */
    const waitForSomethingToDo = () =>
      page.waitForFunction(() => {
        const said = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").trim();
        if ([...document.querySelectorAll("h1, h2, h3, [role=heading]")].some((h) => said(h) !== "")) return true;
        if (said(document.querySelector("main, [role=main]") ?? document.body).length > 200) return true;
        const chrome = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]";
        return [...document.querySelectorAll("button, [role=button], input:not([type=hidden]), textarea, select")].some((el) => !el.closest(chrome) && (el as HTMLElement).getBoundingClientRect().width > 0);
      }, undefined, { timeout: Math.max(0, Math.min(CONTENT_WAIT_MS, deadline - Date.now())), polling: 100 }).then(() => true, () => false);
    /**
     * Waits until the snippet has read the page as it is now. It reads half a second after the page
     * loads, and again a second and a half after it last changes (never more than 3s on), so a page
     * that stopped changing is read already, and waiting a fixed time on every page was waste.
     */
    const snippetCaughtUp = (ms = 3000) =>
      page.waitForFunction(() => {
        const seen = (window as unknown as { __ctxSeen?: { lastChange: number } }).__ctxSeen;
        const loaded = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.domContentLoadedEventEnd ?? 0;
        if (!seen || !loaded) return false;
        return performance.now() >= Math.max(loaded + 600, seen.lastChange > loaded ? seen.lastChange + 1600 : 0);
      }, undefined, { timeout: ms, polling: 100 }).catch(() => {});
    /**
     * After the learner acted: when one of the site's writes was just answered or held back by us,
     * the full wait (SNIPPET_SETTLE_MS) for the snippet to finish recording it; otherwise only until
     * it has read the page as it now is.
     */
    const caughtUp = () => (walking ? page.waitForTimeout(WALK_SETTLE_MS) : Date.now() - savedAt < SNIPPET_SETTLE_MS * 2 ? page.waitForTimeout(SNIPPET_SETTLE_MS) : snippetCaughtUp(SNIPPET_SETTLE_MS));
    /** The page as it came (nothing pressed or typed since it loaded): what a fresh load would give. */
    let loadedAs: { href: string; url: string; at: number } | undefined;
    const isFresh = (href: string) => loadedAs !== undefined && loadedAs.href === href && loadedAs.url === page.url() && touchedAt < loadedAs.at;
    /** Loads a page afresh for the next step, unless it's still as it came. */
    const load = async (href: string) => {
      if (isFresh(href)) return;
      heldUntil = 0; // what the last press set off stops with its page
      const source = clientRoutes.get(href);
      if (source) {
        await load(source);
        await pressLink(href);
      } else {
        await beforeLoad();
        await page.goto(href, { waitUntil: "domcontentloaded" });
        await settle();
      }
      loadedAs = { href, url: page.url(), at: Date.now() };
    };
    const touch = () => void (touchedAt = Date.now());
    /** Where each link in the queue was found (see pressLink). */
    const linkSources = new Map<string, string>();
    /** Addresses that only work when pressed (a router in the page, on a host that answers 404 to the rest): reached that way, from the page linking to them. */
    const clientRoutes = new Map<string, string>();
    /**
     * Presses the link to `target` on the page that's open, as a person would: on a single-page app
     * the page may handle it with no request at all. Says what came of it: the status of the page
     * that loaded, "client" if the address changed with no load, or undefined if neither happened
     * or the link isn't there any more.
     */
    const pressLink = async (target: string): Promise<number | "client" | undefined> => {
      const bare = target.split("#")[0];
      let status: number | undefined;
      const answer = (response: Response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) status = response.status();
      };
      page.on("response", answer);
      try {
        const there = await page.evaluate(({ bare, risky }) => {
          const link = [...document.querySelectorAll("a[href]:not([download])")].find((a) => (a as HTMLAnchorElement).href.split("#")[0] === bare) as HTMLAnchorElement | undefined;
          if (!link || new RegExp(risky, "i").test(link.innerText)) return false;
          link.removeAttribute("target");
          link.click();
          return true;
        }, { bare, risky: riskyPress.source }).catch(() => false);
        if (!there) return undefined;
        touch();
        await page.waitForURL((url) => url.href.split("#")[0] === bare, { timeout: 2000, waitUntil: "commit" }).catch(() => {});
        await settle();
      } finally {
        page.off("response", answer);
      }
      return status ?? (page.url().split("#")[0] === bare ? "client" : undefined);
    };
    /** The end of the time this page gets (see pageDeadline), or of the run. */
    let pageDeadline = deadline;
    const pageTimeUp = () => interrupted() || Date.now() > Math.min(deadline, pageDeadline);
    /**
     * Where the page is, what's open on it, and which of its fields have something in them: a press
     * that changes none of these left it as it was. A page drawn again after a save can look the same
     * with every field emptied, and a button beside them then does nothing for a reason of our own
     * making. A value that only changed (a quantity's "+") is no reason to load the page again.
     */
    const pageShape = () =>
      page.evaluate(() => {
        const fields = [...document.querySelectorAll("input, textarea, select")] as HTMLInputElement[];
        return `${location.href}|${document.querySelectorAll("dialog[open], [role=dialog], [aria-expanded=true]").length}|${fields.length}|${fields.map((f) => (f.type === "checkbox" || f.type === "radio" ? (f.checked ? 1 : 0) : f.value ? 1 : 0)).join("")}`;
      }).catch(() => "");
    /**
     * Starts watching for anything at all to happen: the returned check waits until `ms` have passed
     * since, then says whether nothing did (no change on the page or outside it, see watchEffects).
     */
    const watchForNothing = async () => {
      const snap = await page.evaluate(() => (window as unknown as { __ctxSeen?: { snap: () => string } }).__ctxSeen?.snap()).catch(() => undefined);
      const outside = outsideEffects;
      const from = Date.now();
      const same = async () => snap !== undefined && outsideEffects === outside
        && (await page.evaluate((s) => (window as unknown as { __ctxSeen?: { same: (s: string) => boolean } }).__ctxSeen?.same(s) === true, snap).catch(() => false));
      return async (ms: number) => {
        if (!(await same())) return false;
        await page.waitForTimeout(Math.max(0, ms - (Date.now() - from)));
        return same();
      };
    };
    /**
     * Whether what the page put off for its first seconds (see seen.ahead), run now, leaves it asking
     * for nothing a local run refuses: a widget's loader asks for its script on a timer, and the
     * button it wires does nothing until it has. Every frame runs its own, on its own clock; what
     * they set off (a request, a frame drawn late) is let finish, and its own put-off work run in
     * turn, a few rounds at most. A carousel or a clock re-arming itself runs a few times and is
     * done, so it neither holds the page up nor hides a dead button. False when the page was still
     * putting things off after that, or the run's time ran out: it can't be said then.
     */
    const settlesAhead = async (refused: () => boolean) => {
      runningAhead = true;
      // Never past the run's end, and only a moment past the page's own.
      const limit = Math.min(deadline, Math.max(pageDeadline, Date.now() + 1000));
      const left = () => limit - Date.now();
      // A script asked for that wasn't before is new work, though the same helper put it off (a
      // loader in steps): its own put-off work is still to run. A poll asks for the same again.
      const askedAhead = new Set<string>();
      let scripts = 0;
      const onScript = (request: { resourceType(): string; url(): string }) => {
        if (request.resourceType() !== "script" || askedAhead.has(request.url())) return;
        askedAhead.add(request.url());
        scripts++;
      };
      page.on("request", onScript);
      try {
        for (let round = 0; round < 4; round++) {
          const frames = page.frames();
          // The first round runs the page's first seconds; each after it, what the last set off put off
          // from then (a loader's script that waits again once it's in).
          const from = Date.now();
          scripts = 0;
          const ran = await Promise.all(frames.map((frame) => frame.evaluate(([until, fromNow, budget]) => {
            const seen = (window as unknown as { __ctxSeen?: { ahead: (until: number, fromNow: boolean, budget: number) => Promise<number | "busy"> } }).__ctxSeen;
            return seen ? seen.ahead(until, fromNow, budget) : 0;
          }, [AHEAD_MS, round > 0, Math.max(1, Math.min(1000, left()))] as const).catch(() => 0)));
          if (ran.includes("busy") || left() <= 0) return false;
          // What it set off reaches the route, and its requests finish, before it's judged: a long
          // poll open since before isn't what it set off.
          await page.waitForTimeout(Math.min(100, left()));
          await waitForQuiet(Math.min(1500, left()), from);
          const drawn = page.frames().filter((frame) => !frames.includes(frame));
          await Promise.all(drawn.map((frame) => frame.waitForLoadState("domcontentloaded", { timeout: Math.max(1, Math.min(1500, left())) }).catch(() => {})));
          if (refused()) return false;
          if (!drawn.length && !scripts && ran.every((n) => n === 0)) return true;
        }
        return false;
      } finally {
        page.off("request", onScript);
        runningAhead = false;
        aheadAt = Date.now();
        touch(); // its page is no longer as it loaded
      }
    };
    /** Has the snippet send what it has now: the learner moves on faster than a page would close. */
    const flushSnippet = async () => {
      if (!snippet) return;
      await page.evaluate(() => (window as unknown as { __ctx?: { handle?: { flush?: () => Promise<void> } } }).__ctx?.handle?.flush?.()).catch(() => {});
    };
    /**
     * A photo of the screen as it is now, named as the snippet named it (its latest route, which
     * carries the step or pop-up), with where each visible button, link and field sits.
     */
    const photographed = new Set<string>();
    /** With `again`, this photo takes the place of an earlier one of the screen: it now shows more than it did. */
    const photograph = async (again = false) => {
      if (config.screenshots === false || (!again && result.screens.length >= MAX_SCREEN_PHOTOS)) return;
      await flushSnippet();
      const path = [...result.events].reverse().find((e) => e.kind === "route")?.path;
      if (!path || (!again && photographed.has(path))) return;
      photographed.add(path);
      try {
        const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
        const boxes = await page.evaluate(() => {
          const out: ScreenPhoto["boxes"] = [];
          const text = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
          for (const el of document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], a[href], input:not([type=hidden]), select, textarea")) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || el.closest("[aria-hidden=true],[hidden]")) continue;
            const field = el.matches("input, select, textarea");
            const f = el as HTMLInputElement;
            const label = field ? text(f.labels?.[0]?.textContent || f.getAttribute("aria-label") || f.name || f.placeholder) : text(el.getAttribute("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).value);
            if (!label) continue;
            const link = !field && el.matches("a[href]") ? (el as HTMLAnchorElement) : undefined;
            out.push({ label, kind: field ? "field" : link ? "link" : "button", x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), ...(link ? { href: link.origin + link.pathname } : {}) });
            if (out.length >= 300) break;
          }
          // Buttons that exist but aren't on screen, tucked in a closed menu: placed on the button that opens it.
          for (const el of document.querySelectorAll("button, [role=menuitem], a[href]")) {
            if (out.length >= 300) break;
            if (el.getBoundingClientRect().width > 0) continue;
            const menu = el.closest("[role=menu], [role=listbox], [hidden], [aria-hidden=true]");
            if (!menu) continue;
            const opener = (menu.id ? document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`) : null)
              ?? menu.parentElement?.querySelector("[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded]");
            const r = opener?.getBoundingClientRect();
            const label = text(el.getAttribute("aria-label") || el.textContent);
            const openerLabel = opener ? text(opener.getAttribute("aria-label") || (opener as HTMLElement).innerText) : "";
            if (!r || r.width < 4 || !label || !openerLabel || r.top > innerHeight) continue;
            out.push({ label, kind: "button", x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), hiddenIn: openerLabel });
          }
          return out;
        });
        const earlier = result.screens.findIndex((shot) => shot.path === path);
        if (earlier >= 0) result.screens[earlier] = { path, ...VIEWPORT, jpeg, boxes };
        else if (result.screens.length < MAX_SCREEN_PHOTOS) result.screens.push({ path, ...VIEWPORT, jpeg, boxes });
        if (withoutView(path) !== path) await timed("checks", () => checkView(path));
      } catch (error) {
        result.errors.push(`${path}: photo not taken (${message(error)})`);
      }
    };
    /** A photo under the address it's known by, whatever the snippet last said: a walk that only looks has no views to tell apart. */
    const photoAs = async (path: string) => {
      const jpeg = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => undefined);
      if (jpeg) result.screens.push({ path, ...VIEWPORT, jpeg, boxes: [] });
    };
    // Waits for the snippet to read the page (it does so once the page stops changing), then collects it.
    const readStructure = async () => {
      if (!snippet) return;
      await snippetCaughtUp();
      await flushSnippet();
    };
    /**
     * Until the page and the made-up rows have stopped coming for a moment, at most `ms`: what a
     * pass that reads only counts waits for, in place of the snippet's read and the measuring.
     */
    let stillAt: { filled: number; at: number } | undefined;
    const stillNow = async (ms = 2500) => {
      const until = Date.now() + ms;
      let filled = seal?.filled ?? 0;
      // No row has come since the page was last found still: that stillness still counts.
      let since = stillAt && stillAt.filled === filled ? stillAt.at : Date.now();
      while (Date.now() < until && !interrupted()) {
        const quiet = await page.evaluate((q) => {
          const seen = (window as unknown as { __ctxSeen?: { lastChange: number } }).__ctxSeen;
          return !seen || performance.now() - seen.lastChange >= q;
        }, STILL_NOW_MS).catch(() => true);
        if ((seal?.filled ?? 0) !== filled) {
          filled = seal?.filled ?? 0;
          since = Date.now();
        }
        if (quiet && Date.now() - since >= STILL_NOW_MS) return void (stillAt = { filled, at: since });
        await page.waitForTimeout(100).catch(() => {});
      }
      stillAt = undefined;
    };

    /** Runs something with the window at phone width, and always puts it back. */
    const atPhone = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      try {
        await page.setViewportSize(PHONE);
        await page.waitForTimeout(PHONE_SETTLE_MS);
        return await read();
      } catch {
        return undefined;
      } finally {
        await page.setViewportSize(VIEWPORT).catch(() => {});
        await page.waitForTimeout(60).catch(() => {});
      }
    };
    const measure = async (under?: Box): Promise<Measured | undefined> => {
      await page.evaluate(() => Promise.race([document.fonts.ready.then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 300))])).catch(() => {});
      return page.evaluate(measureLayout, { under }).catch(() => undefined);
    };
    const proofPhoto = () => page.screenshot({ type: "jpeg", quality: 60 }).catch(() => undefined);
    /** A value that went out in a made-up row, or the made-up user: never the basis of an item. */
    const madeUp = (text: string) => seal !== undefined && (text.includes(STAND_IN_EMAIL) || text.includes(STAND_IN_EMAIL.split("@")[0]!) || seal.carriesRow(text));
    /** A control named for a record. A row's values come back reformatted ("closed +$125"), so with made-up rows a number in a name is enough. */
    const namedForARow = (label: string) => madeUp(label) || (seal !== undefined && /\d/.test(label));
    const size = (m: Measured) => `${m.width}×${m.height}`;
    /** Looks at the screen again with the cookie banner brought back, by undoing what answering it left behind. Answered again after. */
    let bannerLooks = 0;
    const bannerAsked = new Set<string>();
    const bringBannerBack = async (controls: readonly string[], shown: string) => {
      const unseen = controls.filter((label) => !bannerAsked.has(label));
      // Never on a real account: what changed as the banner was answered could be its session.
      if (!consent || unseen.length === 0 || bannerLooks >= MOST_BANNER_LOOKS || Date.now() > deadline || config.login || config.storageState || config.realWrites) return;
      bannerLooks++;
      for (const label of unseen) bannerAsked.add(label);
      const { local, session, cookies } = consent;
      await page.evaluate((keys) => {
        for (const key of keys.local) localStorage.removeItem(key);
        for (const key of keys.session) sessionStorage.removeItem(key);
      }, { local, session }).catch(() => {});
      for (const name of cookies) await context.clearCookies({ name }).catch(() => {});
      await beforeLoad();
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await settle();
      await page.waitForFunction(findBanner, DECLINE_COOKIES.source, { timeout: 2500, polling: 100 }).catch(() => {});
      await page.waitForTimeout(BANNER_SETTLE_MS).catch(() => {});
      const found = await measure();
      const wanted = new Set(controls);
      const proof = found?.covered.some((c) => c.cookie && wanted.has(c.label)) ? await proofPhoto() : undefined;
      for (const c of found?.covered ?? []) {
        if (c.cookie && wanted.has(c.label) && !namedForARow(c.label)) addCheck({ kind: "covered", screen: shown, target: c.label, at: "desktop", by: c.by, byWords: c.words, cookieBanner: true, box: c.box, evidence: `at ${size(found!)}, the top element at the centre of the control is the cookie banner, and scrolling doesn't move it away`, ...(proof ? { proof } : {}) });
      }
      await declineCookies();
      loadedAs = { href: page.url(), url: page.url(), at: Date.now() };
    };
    /** A cut-off label that stands: fixed words, none of them a made-up value, and past what a fallback font in place of one this run kept out could account for. */
    const fair = (cut: Measured["cut"][number]) => fixedLabel(cut.label, cut.title) && !madeUp(cut.label) && (!without.fonts || !cut.fontStoodIn || (!cut.narrow && (cut.needs - cut.has) / cut.needs >= FONT_MARGIN));
    const fontNote = (cut: Measured["cut"][number]) => (without.fonts && cut.fontStoodIn ? ", in a fallback font: this run doesn't load fonts from other hosts" : "");
    /** Keeps what's still so a moment later: what comes and goes isn't a fault of the screen. */
    let phoneSpent = 0;
    const lastedBefore = new Set<string>();
    const lasting = async <T>(found: T[], again: () => Promise<T[]>, same: (a: T, b: T) => boolean, key: (item: T) => string): Promise<T[]> => {
      // What has lasted once needn't be waited for again: a sidebar doesn't change from screen to screen.
      if (found.every((item) => lastedBefore.has(key(item)))) return found;
      await page.waitForTimeout(STILL_THERE_MS).catch(() => {});
      const now = await again();
      const kept = found.filter((item) => now.some((other) => same(item, other)));
      for (const item of kept) lastedBefore.add(key(item));
      return kept;
    };
    /**
     * The proven checks on the screen that's open: see checks.ts for what each measures. Each time
     * it asks what this run did to the page. A page that went without its styles has no layout to
     * judge; one that went without a font is judged only past what a fallback font can account for;
     * one whose calls were refused, or answered with a guess at their shape, can't be blamed for a
     * hole in its words, as an answer of ours may have made it. A copy of a screen already measured
     * (the next item of a list) keeps what's quick: at phone width it would only say the same again.
     */
    const checkScreen = async (shown: string, filledBefore: number, guessedBefore: number, copy: boolean) => {
      if (Date.now() > deadline) return;
      const holesOurs = () => without.calls || (seal !== undefined && (seal.sessionFieldsBlank || seal.filled > filledBefore || seal.guessed > guessedBefore));
      const stands = (w: Wording) => (w.problem === "count" ? !madeUp(w.phrase) : !holesOurs() && !madeUp(w.line));
      const words = async () => {
        const drawn = await page.evaluate(readDrawn).catch((): Drawn | undefined => undefined);
        return drawn ? brokenWording(drawn).filter(stands) : [];
      };
      const wording = await lasting(await words(), words, (a, b) => a.problem === b.problem && a.phrase === b.phrase, (w) => `${w.problem} ${w.line}`);
      for (const w of wording) addWording(w, shown);
      if (config.countsOnly) {
        // No measuring to give late rows their moment: they're waited for instead.
        await stillNow();
        if (seal) for (const w of await words()) if (w.problem === "count" && !wording.some((had) => had.phrase === w.phrase)) addWording(w, shown);
        logged = [];
        turnedAway = false;
        return;
      }

      const desktop = await measure(consent?.desktop);
      if (!desktop) return;
      const covering = async (seen: Measured["covered"]) => lasting(seen.filter((c) => !namedForARow(c.label)), async () => (await measure())?.covered ?? [], (a, b) => a.label === b.label && a.by === b.by, (c) => `${c.label} ${c.by}`);
      if (!without.styles) {
        for (const c of desktop.cut.filter(fair)) addCheck({ kind: "cut_off", screen: shown, target: c.label, at: "desktop", room: c.has, box: c.box, evidence: `its text needs ${c.needs}px and has ${c.has}px, at ${size(desktop)}${fontNote(c)}` });
        const held = await covering(desktop.covered);
        for (const c of held) addCheck({ kind: "covered", screen: shown, target: c.label, at: "desktop", by: c.by, byWords: c.words, ...(c.cookie ? { cookieBanner: true as const } : {}), box: c.box, evidence: `at ${size(desktop)}, the top element at the centre of the control is something else, and scrolling doesn't move it away` });
        const under = desktop.under.filter((label) => !madeUp(label) && !held.some((c) => c.label === label));
        const atPhoneFrom = Date.now();
        // A short run spends its time reaching screens: phone width has a share of it and no more.
        const phone = copy || phoneSpent > (config.maxDurationMs ?? 120_000) * PHONE_SHARE ? undefined : await atPhone(async () => {
          const read = await measure(consent?.phone);
          if (!read) return undefined;
          const stay = await covering(read.covered);
          const noted = read.cut.filter(fair).length + stay.length + read.offside.length + (read.overflow ? 1 : 0);
          return { read, stay, proof: noted > 0 ? await proofPhoto() : undefined };
        });
        phoneSpent += Date.now() - atPhoneFrom;
        if (phone) {
          const { read, stay, proof } = phone;
          const shot = proof ? { proof } : {};
          for (const c of read.cut.filter(fair)) addCheck({ kind: "cut_off", screen: shown, target: c.label, at: "phone", room: c.has, box: c.box, ...shot, evidence: `its text needs ${c.needs}px and has ${c.has}px, at ${size(read)}${fontNote(c)}` });
          for (const c of stay) addCheck({ kind: "covered", screen: shown, target: c.label, at: "phone", by: c.by, byWords: c.words, ...(c.cookie ? { cookieBanner: true as const } : {}), box: c.box, ...shot, evidence: `at ${size(read)}, the top element at the centre of the control is something else, and scrolling doesn't move it away` });
          const over = read.overflow;
          if (over && !madeUp(over.text) && !(seal && seal.filled > filledBefore && !over.text) && !(without.fonts && over.fontStoodIn && over.excess < FONT_OVERFLOW)) addCheck({ kind: "overflow", screen: shown, target: over.text ? `<${over.starts}> "${over.text}"` : "the page", at: "phone", ...shot, evidence: `the page is ${over.excess}px wider than the ${read.width}px window, and scrolls sideways` });
          const reachable = new Set(desktop.labels);
          for (const c of read.offside.filter((c) => reachable.has(c.label) && !madeUp(c.label))) addCheck({ kind: "unreachable", screen: shown, target: c.label, at: "phone", box: c.box, ...shot, evidence: `it sits at x ${c.box.x} of a ${read.width}px window, and the page doesn't scroll sideways` });
        }
        if (under.length > 0) await bringBannerBack(under, shown);
      }

      // A count drawn from rows that came in late is there by now: the measuring takes a moment, and asks nothing more of the page.
      if (seal) for (const w of await words()) if (w.problem === "count" && !wording.some((had) => had.phrase === w.phrase)) addWording(w, shown);

      // An image from a made-up row, or a file named by one, is no fault of the app's.
      if (!seal || seal.filled === filledBefore) {
        for (const src of desktop.images) {
          const status = failedImages.get(src);
          const n = place(src);
          if (status === undefined || !n || !origins.has(n.origin) || issues.has(`request_fails|${shown}|GET ${n.path}`)) continue;
          addCheck({ kind: "broken_image", screen: shown, target: new URL(src).pathname, evidence: status >= 400 ? `the image came back ${status}, and shows broken` : "the address answered with a page, not an image, and shows broken" });
        }
      }
      if (!without.calls && !refusedUs() && Date.now() - interferedAt >= 3000) {
        for (const { text, file } of logged) {
          let from: URL | undefined;
          try { from = new URL(file); } catch { /* no file: nothing shows it's the app's */ }
          if (!from || !text || NOT_THE_APPS_ERROR.test(text) || NOT_A_CRASH.test(text) || !ownHost(from.hostname) || SAYS_NO_SESSION.test(text) || (turnedAway && SAYS_TURNED_AWAY.test(text))) continue;
          addCheck({ kind: "console_error", screen: shown, target: text, evidence: `logged by ${from.pathname.split("/").pop() || "the page"} as the page loaded` });
        }
      }
      logged = [];
      turnedAway = false;
    };
    /**
     * A view a press opened (a dialog, a step): what it takes no answer of ours to judge. Words
     * that may hold a hole wait for a fresh load, as what follows a press may follow a made-up reply.
     */
    const checkView = async (path: string) => {
      if (Date.now() - savedAt < AFTER_OUR_ANSWER_MS || Date.now() > deadline) return;
      const shown = withoutView(path);
      await reviewScreen(path, seal?.filled ?? 0);
      const drawn = await page.evaluate(readDrawn).catch((): Drawn | undefined => undefined);
      for (const w of drawn ? brokenWording(drawn) : []) if (w.problem === "count" && !madeUp(w.phrase)) addWording(w, shown);
      const layout = without.styles ? undefined : await measure();
      for (const c of layout?.cut.filter(fair) ?? []) addCheck({ kind: "cut_off", screen: shown, target: c.label, at: "desktop", room: c.has, box: c.box, evidence: `its text needs ${c.needs}px and has ${c.has}px, at ${size(layout!)}${fontNote(c)}` });
    };
    /**
     * What the screen shows, for a reader of it. What's on a real session's screen is someone's, so
     * only its structure is kept. With no sign-in in the way, a local app's tables are its real
     * database, so off the stand-in no table cell is kept: everything else is the app's own words.
     */
    const reviewScreen = async (path: string, filledBefore: number, gate?: ScreenReview["gate"]) => {
      if (result.reviews.length >= MOST_REVIEWS) return;
      const [drawn, read] = await Promise.all([page.evaluate(readDrawn).catch(() => undefined), page.evaluate(readReview, { ...REVIEW_WORDS, leaveOut: seal ? "" : TABLE_CELLS }).catch(() => undefined)]);
      if (!drawn || !read) return;
      const plain = (text: string) => (madeUp(text) ? MADE_UP_LINE : realSession ? masked(text) : withoutTokens(text));
      const review: ScreenReview = {
        path, ...(read.heading ? { heading: plain(read.heading) } : {}),
        text: realSession ? [] : reviewLines(drawn, plain, seal !== undefined),
        controls: read.controls.map((control) => ({ ...control, label: plain(control.label) })),
        locked: read.locked.map((item) => ({ ...item, label: plain(item.label) })),
        empty: read.empty.map((item) => ({ ...item, text: plain(item.text), ...(item.next ? { next: plain(item.next) } : {}) })),
        ...(gate ? { gate } : {}),
        ...(seal ? { seenWith: "stand-in" as const } : {}),
        ...(seal && seal.filled > filledBefore ? { madeUpData: true as const } : {}),
        ...(without.calls ? { heldData: "refused" as const } : seal && seal.emptied > emptiedAtLoad ? { heldData: "empty" as const } : {}),
      };
      const earlier = result.reviews.findIndex((had) => had.path === path);
      if (earlier >= 0) result.reviews[earlier] = review;
      else result.reviews.push(review);
      return review;
    };

    /** Still with the session: what the app draws at an address it can't have (see Seal.sort). */
    const lookAtNowhere = async (on: Page) => {
      if (!await on.goto(new URL(NOWHERE_PATH, start).href, { waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null)) return;
      await on.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
      const look = () => on.evaluate(readWall, WALL_WORDS).catch(() => undefined);
      let drew = await look();
      if (!drew || drew.kind === "loading" || drew.kind === "blank") {
        await on.waitForTimeout(2000).catch(() => {});
        drew = await look();
      }
      if (drew) seal!.nowhere = { path: screen(on.url()) ?? NOWHERE_PATH, text: drew.text, heading: drew.heading };
    };

    /**
     * Each screen the stand-in reached, looked at once more with no session in the browser. One
     * that draws the same, with no made-up rows behind it, never needed a user: it's a public page
     * the first crawl didn't get to, and "seen with made-up data" would be false of it. All sealed
     * as before, and time-limited: a screen not looked at stays marked, the cautious way round.
     */
    const lookSignedOut = async () => {
      const until = Date.now() + SIGNED_OUT_MS;
      // A page of its own: the one before may have been closed at the time limit, which is when this matters most.
      main = undefined;
      const looking = await context.newPage();
      main = looking;
      if (seal!.drawn.size > 0 && !seal!.nowhere) await lookAtNowhere(looking);
      if (lookOnly) return void (await looking.close().catch(() => {}));
      await context.addInitScript(() => { (window as unknown as { __ctxSignedOut?: boolean }).__ctxSignedOut = true; });
      seal!.signedOut = true;
      signedOutLook = looking;
      for (const [shown, { href, text }] of seal!.drawn) {
        if (Date.now() > until || interrupted()) break;
        if (seal!.publicScreens.has(shown)) continue;
        const filled = seal!.filled;
        const opened = await looking.goto(href, { waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null);
        if (!opened) continue; // still the page before: nothing to compare
        await looking.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
        const now = await looking.evaluate(readWall, WALL_WORDS).catch(() => undefined);
        if (now && !now.kind && sameWords(now.text, text) && seal!.filled === filled) seal!.openToAll.add(shown);
      }
      await looking.close().catch(() => {});
    };

    // Proved before the app is ever opened: a seal that doesn't hold ends the pass here.
    await seal?.check(page, browser);
    // A walk that presses has one way to run: under this seal, held, and with no real session anywhere near.
    if (walking && (!seal?.held || config.login || config.storageState || config.realWrites)) throw new Error("a walk that presses needs the seal, and only the seal");
    // First of all, so a screen can be told from it the moment it's measured.
    if (seal && !walking && !interrupted()) await timed("nowhere", () => lookAtNowhere(page));

    if (config.login) {
      try {
        await page.goto(config.login.url, { waitUntil: "domcontentloaded" });
        for (const field of config.login.fields) {
          const value = env[field.env];
          if (value === undefined) throw new Error(`login value missing: set ${field.env}`);
          await page.fill(field.selector, value);
        }
        signingIn = true;
        await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), page.click(config.login.submit)]);
        await page.waitForLoadState("networkidle", { timeout: navTimeout }).catch(() => {});
        result.loggedIn = config.login.successUrlContains ? page.url().includes(config.login.successUrlContains) : true;
        if (!result.loggedIn) result.errors.push("login did not reach the expected page");
      } catch (error) {
        result.errors.push(`login failed: ${message(error)}`);
      }
      phase = "crawl";
      signingIn = false;
    }

    /**
     * Presses each button on the page that only moves between screens, from a fresh load each
     * time, and returns the new addresses it led to (same site only). Writes stay blocked.
     */
    /**
     * A small test file in each file field, of a type it accepts, so "Upload" and "Import" can be
     * pressed: the save it leads to is answered by us, so the file never leaves the browser.
     */
    const chooseFiles = async () => {
      if (walking) return; // a journey is never given a file, made up or not
      for (const input of await page.$$("input[type=file]").catch(() => [])) {
        const accept = ((await input.getAttribute("accept").catch(() => null)) ?? "").split(",").map((a) => a.trim()).find((a) => a.startsWith("."));
        const ext = accept ?? ".csv";
        touch();
        await input.setInputFiles({ name: `learner-test${ext}`, mimeType: ext === ".csv" ? "text/csv" : "application/octet-stream", buffer: Buffer.from("name,value\ntest,1\n") }).catch(() => {});
      }
    };

    const CLICKABLE = "button, [role=button], [role=link], [role=menuitem], [role=tab], a:not([href]), [onclick], [data-ctx-press]";
    /**
     * Things that only look pressable (a list row, a card with the hand cursor and a click handler),
     * marked so they're pressed too: the outermost of each, and the first of each repeated kind,
     * since every row of a list leads to the same screen.
     */
    const markPressable = () =>
      page.evaluate(() => {
        const kinds = new Set<string>();
        // A line of text counts too: a sign-in screen's "Forgot your password?" is often a <p> that routes on click.
        const all = [...document.body.querySelectorAll("div, li, tr, article, section, span, td, img, p, h1, h2, h3, h4, h5, h6")].slice(0, 4000) as HTMLElement[];
        for (const el of all) {
          if (el.closest("a[href], button, [role=button], [role=link], [role=menuitem], [role=tab], [onclick], label, input, select, textarea, [data-ctx-press]")) continue;
          if (getComputedStyle(el).cursor !== "pointer" || (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer")) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          const kind = `${el.tagName}.${[...el.classList].sort().join(".")}`;
          if (kinds.has(kind)) continue;
          kinds.add(kind);
          el.setAttribute("data-ctx-press", "");
        }
      }).catch(() => {});
    /** Visible buttons on screen now (never a form's submit: forms are learned on their own), and where each sits (see Control). */
    const controls = (): Promise<Control[]> =>
      markPressable().then(() => page.$$eval(CLICKABLE, (els, turner) => {
        const TURNS = new RegExp(turner, "i");
        const windowArea = innerWidth * innerHeight;
        return els.flatMap((el) => {
          const b = el as HTMLElement;
          const rect = b.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || b.closest("[aria-hidden=true]")) return [];
          if (b instanceof HTMLButtonElement && (b.disabled || (b.form && b.type === "submit"))) return [];
          const label = (b.getAttribute("aria-label") || b.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
          if (!label) return [];
          // A header or footer inside the content (an article's, a card's) is the content's own.
          const edge = b.closest("header, footer");
          const shell = !!b.closest("nav, [role=navigation], [role=banner], [role=contentinfo]") || (!!edge && !edge.parentElement?.closest("main, [role=main], article, section"));
          // Fixed to the window, unless it's the whole app that's fixed there.
          let floating = false;
          for (let e: HTMLElement | null = b; e && e !== document.body && !floating; e = e.parentElement) {
            const position = getComputedStyle(e).position;
            if (position !== "fixed" && position !== "sticky") continue;
            const r = e.getBoundingClientRect();
            floating = r.width * r.height < windowArea * 0.6;
          }
          const turnerPlace = "[class*=pagination i], [class*=pager i], [aria-label*=pagination i], [class*=carousel i], [class*=swiper i], [class*=slick i], [aria-roledescription=carousel]";
          return [{
            label, shell, floating, inMain: !!b.closest("main, [role=main]"), turner: TURNS.test(label) || !!b.closest(turnerPlace),
            kind: `${b.tagName}.${[...b.classList].sort().join(".")}<${b.parentElement?.tagName}.${[...(b.parentElement?.classList ?? [])].sort().join(".")}`, spot: `${Math.round(rect.left / 24)},${Math.round(rect.top / 24)}`,
          }];
        });
      }, PAGE_TURNER.source)).catch(() => [] as Control[]);

    /** What's been pressed on the site so far: the same buttons on every page are pressed once (see pressOrder). */
    const pressMemory: PressMemory = new Map();
    /** Screens where Enter in a lone box added something: a fresh load of them may need adding to again. */
    const addsWithEnter = new Set<string>();
    const pressButtons = async (href: string): Promise<string[]> => {
      const visibleLabels = () => controls().then((all) => all.map((c) => c.label));
      /**
       * Presses the first button with this label. Says whether it was a plain, working button, one
       * that must do something when pressed ("button"): not disabled, not a form's submit (the
       * browser may rightly stop it), not already on (a selected tab, a pressed toggle), not a
       * row or link that only looks pressable.
       */
      const press = async (wanted: string) => {
        touch();
        const where = screen(href);
        submitting = { label: wanted, tag: "button", ...(where ? { page: where } : {}) };
        // Read before pressing: what it sends goes out with the click.
        const says = await sayingOf(wanted);
        if (config.realWrites && controlDestroys(says)) return false;
        const stillHeld = guard.holding();
        holdFor(says);
        if (stillHeld) heldUntil = Date.now() + HOLD_MS; // the second step of "Delete", then "Yes"
        return pressIt(wanted);
      };
      /** What a control says about itself, however it says it (see readControls). */
      const sayingOf = (wanted: string) =>
        page.evaluate(({ wanted, sel }) => {
          const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0 && ((e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)) === wanted);
          return el ? (window as unknown as { __ctxRead?: { says: (e: Element) => Saying } }).__ctxRead?.says(el) : undefined;
        }, { wanted, sel: CLICKABLE }).then((s) => s ?? { text: wanted, around: "", marks: "" }, () => ({ text: wanted, around: "", marks: "" }));
      const pressIt = (wanted: string, click = true) =>
        markPressable().then(() => page.evaluate(({ wanted, sel, click }) => {
          const el = [...document.querySelectorAll(sel)].find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && ((e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)) === wanted;
          }) as HTMLElement | undefined;
          if (!el) return false;
          const b = el as HTMLButtonElement;
          const plain = el.matches("button, [role=button]") && !el.matches("a, [data-ctx-press]")
            && !b.disabled && !el.closest("[aria-disabled=true], fieldset:disabled, [inert]")
            && !(b.form && (b.type === "submit" || b.type === "reset"))
            && !el.matches("[aria-pressed=true], [aria-selected=true], [aria-checked=true], [aria-expanded=true], [aria-current]:not([aria-current=false])")
            && !/\b(active|selected|current|checked|is-active)\b/i.test(el.getAttribute("class") ?? "")
            && getComputedStyle(el).pointerEvents !== "none";
          if (click) {
            // Marked, so what it says once pressed can be told from what it revealed (see ownNewLabel).
            for (const was of document.querySelectorAll("[data-ctx-pressed]")) was.removeAttribute("data-ctx-pressed");
            el.setAttribute("data-ctx-pressed", "");
            el.click();
          }
          return plain ? "button" : "other";
        }, { wanted, sel: CLICKABLE, click })).catch(() => false as const);
      /**
       * A second, careful look at a button that seemed to do nothing, from a fresh load, pressed as a
       * person presses it: the fields beside it filled in first (a button that works on what's typed
       * next to it), then pointed at with the mouse (so what hovering shows isn't put down to the
       * press), then a real click at its middle (a page may rightly ignore a click made by script),
       * with the screen photographed before and after. Reported only if nothing at all happened, not
       * even a pixel changing. Never reported: the current one of a group of buttons (see below).
       */
      const confirmNothing = async (label: string, quiet: string[], until: number) => {
        await load(href);
        if (Date.now() > until || screen(page.url()) !== screen(href)) return false;
        // The mouse off every button, so none is drawn hovered when the group is compared.
        await page.mouse.move(0, 0);
        const look = await page.evaluate(({ wanted, sel, selection }) => {
          const say = (e: Element) => (e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
          const named = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0 && say(e) === wanted);
          // A label two controls share says nothing about either, and a reload may swap them.
          if (named.length !== 1) return null;
          const el = named[0] as HTMLElement;
          const shown = (e: Element) => e.getBoundingClientRect().width > 0 && e.checkVisibility();
          const box = "input[type=checkbox], input[type=radio], [role=checkbox], [role=radio]";
          const ticked = (b: Element) => (b as HTMLInputElement).checked === true || b.getAttribute("aria-checked") === "true";
          // "Archive selected" with boxes left unticked does nothing, rightly.
          if (new RegExp(selection, "i").test(wanted) && [...document.querySelectorAll(box)].some((b) => shown(b) && !ticked(b))) return null;
          // The current one of a group: buttons side by side (tabs, a view switcher, a button bar),
          // the others all drawn alike and this one drawn apart (the chosen tab's colour). Pressing
          // what's already chosen rightly does nothing. A wrapper around each (a list item) counts as
          // the button, since the "chosen" mark is often on the wrapper.
          let item: Element = el;
          for (let up = 0; up < 2 && item.parentElement && item.parentElement.children.length === 1; up++) item = item.parentElement;
          const drawn = (wrap: Element, b: Element) => {
            const st = getComputedStyle(b);
            return [wrap.getAttribute("class"), b.getAttribute("class"), st.backgroundColor, st.color, st.borderColor, st.fontWeight, st.textDecorationLine, getComputedStyle(wrap).backgroundColor].join("|");
          };
          const peers = [...(item.parentElement?.children ?? [])].filter((p) => p !== item && p.tagName === item.tagName).flatMap((p) => {
            const b = p.matches(sel) ? p : p.querySelector(sel);
            return b && b.getBoundingClientRect().width > 0 ? [{ label: say(b), look: drawn(p, b) }] : [];
          });
          const current = peers.length >= 2 && new Set(peers.map((p) => p.look)).size === 1 && peers[0]!.look !== drawn(item, el);
          // The fields it sits with: its form, or the two levels around it.
          let around: Element = el.closest("form") ?? el;
          if (around === el) for (let up = 0; up < 2 && around.parentElement && around.parentElement !== document.body; up++) around = around.parentElement;
          const fields = [...around.querySelectorAll("input, textarea")].flatMap((f, i) => {
            const x = f as HTMLInputElement;
            const type = (x.getAttribute("type") || "text").toLowerCase();
            if (x.disabled || x.readOnly || x.value || x.getBoundingClientRect().width === 0 || !["text", "email", "url", "tel", "number", "search", "textarea", "date"].includes(x.tagName === "TEXTAREA" ? "textarea" : type)) return [];
            x.setAttribute("data-ctx-beside", String(i));
            return [{ i, type: x.tagName === "TEXTAREA" ? "textarea" : type, hint: `${x.name} ${x.placeholder}`.toLowerCase(), search: (window as unknown as { __ctxRead?: { searchBox: (e: Element) => boolean } }).__ctxRead?.searchBox(x) === true }];
          });
          // What it may need chosen first: the first box or choice of each kind in its form, table or
          // group, and a list still on its blank option. Never one that signs up for something.
          const group = el.closest("form, table") ?? around;
          const groups = new Set<string>();
          const ticks = [...group.querySelectorAll(box)].flatMap((b, i) => {
            const name = b.getAttribute("name") ?? b.getAttribute("role") ?? "";
            if (!shown(b) || ticked(b) || (b as HTMLInputElement).disabled || groups.has(name) || /newsletter|marketing|offers|subscribe/i.test(b.closest("label")?.textContent ?? "")) return [];
            groups.add(name);
            b.setAttribute("data-ctx-tick", String(i));
            return [i];
          });
          const lists = [...group.querySelectorAll("select")].flatMap((s, i) => {
            const option = [...s.options].find((o) => o.value && !o.disabled);
            if (!shown(s) || s.disabled || s.value || !option) return [];
            s.setAttribute("data-ctx-choose", String(i));
            return [{ i, value: option.value }];
          });
          return { current, peers: peers.map((p) => p.label), fields, ticks, lists };
        }, { wanted: label, sel: CLICKABLE, selection: NAMES_A_SELECTION.source }).catch(() => null);
        if (!look) return false;
        // Unless every one of the group did nothing too: then it's no different from the rest.
        if (look.current && !look.peers.every((p) => quiet.includes(p))) return false;
        const filling = look.fields.length + look.ticks.length + look.lists.length > 0;
        if (filling) touch();
        for (const f of look.fields.slice(0, 4)) {
          noteTyped(testValue(f.type, f.hint), f.search);
          await page.locator(`[data-ctx-beside="${f.i}"]`).fill(testValue(f.type, f.hint)).catch(() => {});
        }
        for (const i of look.ticks.slice(0, 4)) await page.locator(`[data-ctx-tick="${i}"]`).click({ timeout: 1000 }).catch(() => {});
        for (const l of look.lists.slice(0, 4)) await page.selectOption(`[data-ctx-choose="${l.i}"]`, l.value).catch(() => {});
        if (filling) await settleQuick();
        // A plain, working button (see pressIt), found without pressing it.
        if ((await pressIt(label, false)) !== "button") return false;
        const spot = await page.evaluate(({ wanted, sel }) => {
          const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0 && ((e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)) === wanted) as HTMLElement | undefined;
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const top = document.elementFromPoint(x, y);
          if (!top || !(top === el || el.contains(top))) return null; // covered: a person couldn't press it either
          // Clicking moves the focus onto it, as clicking anything does: that alone isn't something happening.
          el.setAttribute("data-ctx-pressing", "");
          return { x, y };
        }, { wanted: label, sel: CLICKABLE }).catch(() => null);
        if (!spot) return false;
        await page.mouse.move(spot.x, spot.y);
        await page.waitForTimeout(500);
        // The focus is the first thing a click does, and all a menu shown on focus needs (the
        // :focus-within dropdowns of CSS frameworks), so anything new on show when it's focused is
        // that press working. Otherwise the click is measured from the button already focused, so a
        // focus ring is in both photos, and never blurred after, which would close what it opened.
        const onShow = () => page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).length).catch(() => -1);
        const showing = await onShow();
        touch(); // what focusing opened stays open: the next look needs the page afresh
        await page.evaluate(() => (document.querySelector("[data-ctx-pressing]") as HTMLElement | null)?.focus({ preventScroll: true })).catch(() => {});
        await page.waitForTimeout(300);
        if ((await onShow()) !== showing) return false;
        const photo = await page.screenshot();
        const check = await watchForNothing();
        touch();
        const where = screen(href);
        submitting = { label, tag: "button", ...(where ? { page: where } : {}) };
        holdFor(await sayingOf(label));
        // A tag manager kept away from this page (see tagManager): a press that told it something
        // went to code the run refused, so it can't be said to do nothing.
        const layers = [...(tagsKeptFrom.get(screen(href) ?? "/") ?? [])];
        const told = () => (layers.length ? page.evaluate((names) => names.map((n) => { const l = (window as unknown as Record<string, unknown>)[n]; return Array.isArray(l) ? l.length : -1; }).join(), layers).catch(() => "?") : Promise.resolve(""));
        const toldBefore = await told();
        pressedAt = Date.now();
        lastPress = label;
        await page.mouse.click(spot.x, spot.y);
        if (!(await check(NOTHING_CONFIRM_MS))) return false;
        if ((await told()) !== toldBefore) return false;
        return photo.equals(await page.screenshot());
      };
      /** What the control just pressed says now, and whether it's marked as a toggle (aria-pressed): its new words may be only its other state, nothing it revealed. */
      const ownNewLabel = () =>
        page.evaluate(() => {
          const el = document.querySelector("[data-ctx-pressed]") as HTMLElement | null;
          return el && el.getBoundingClientRect().width > 0 ? { label: (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80), toggle: el.hasAttribute("aria-pressed") } : undefined;
        }).catch(() => undefined);
      const risky = riskyPress;

      // From the page itself, freshly loaded (exploring its forms may have moved on), with its fields
      // filled in, since that can bring out what wasn't there (a list to choose from before its
      // button shows, a list of items with buttons of their own).
      await load(href).catch(() => {});
      const ready = async () => {
        if (!learn) return 0;
        await chooseFiles();
        // A list kept only in the page (nothing saved anywhere) is gone after a load: what was added is added again.
        const addAgain = addsWithEnter.has(screen(href) ?? "") && !(await page.evaluate(() => /\bTest\b/.test(document.body.innerText)).catch(() => true));
        // What filling in saves by itself (a list that saves on change) finishes before anything is pressed,
        // so it isn't put down to that button.
        const filled = await fillLooseFields(addAgain);
        if (filled) { await page.waitForTimeout(700); await settle(); await flushSnippet(); }
        return filled;
      };
      /** Fields outside any form are filled on this load, so a press may be turned down over them. */
      let filledLoose = (await ready()) > 0;
      const present = await controls();
      const onScreen = new Set(present.map((c) => c.label));
      // What to press, from a fresh load each time: a button, or a button then something it revealed
      // (a menu's items, a pop-up's buttons). What's the same on every page is pressed once on the
      // site, and the page's own buttons go first (see pressOrder).
      const sequences: string[][] = pressOrder(present.filter((c) => !risky.test(c.label)), pressMemory, config.maxButtonsPerPage ?? 12).map((l) => [l]);
      const queued = new Set(sequences.map((q) => q.join(" › ")));
      const found: string[] = [];
      /** Plain buttons that did nothing at all when pressed: looked at again, carefully, at the end. */
      const quiet: string[] = [];
      const before = screen(href);
      let presses = 0;
      // The page is loaded afresh only when the last press changed something (moved, opened, saved):
      // most presses (a tab, an accordion, a button that does nothing) leave it as it was.
      let needLoad = false;
      while (sequences.length && presses < (config.maxButtonsPerPage ?? 12) * 2) {
        // However short of time, a page's best button gets its press: it's why the page was chosen.
        if (presses > 0 ? pageTimeUp() : interrupted() || Date.now() > deadline) break;
        const sequence = sequences.shift()!;
        presses++;
        try {
          // The last press may have taken this button away while leaving the page looking the same.
          if (!needLoad && sequence.length === 1 && !(await visibleLabels()).includes(sequence[0]!)) needLoad = true;
          if (needLoad || sequence.length > 1) {
            await load(href);
            filledLoose = (await ready()) > 0;
          } else if (presses > 1) await page.keyboard.press("Escape").catch(() => {});
          needLoad = true; // until this press is known to have left the page as it was
          const shape = await pageShape();
          let ok = true;
          /** What's on the page before a press beside filled-in fields, in case it's turned down over them. */
          let sending: Awaited<ReturnType<typeof beforeSending>> | undefined;
          let pressStart = Date.now();
          // A single press of a plain button is watched: did it do anything at all?
          let check: Awaited<ReturnType<typeof watchForNothing>> | undefined;
          for (const label of sequence) {
            const watching = sequence.length === 1 && !MAY_DO_NOTHING.test(label) ? await watchForNothing() : undefined;
            sending = sequence.length === 1 && filledLoose ? await beforeSending() : undefined;
            pressedAt = Date.now();
            pressStart = pressedAt;
            lastPress = label;
            const pressed = await press(label);
            if (!pressed) { ok = false; break; }
            if (sequence.length === 1) remember(present.find((c) => c.label === label), pressMemory);
            if (pressed === "button") check = watching;
            await page.waitForTimeout(400);
            await settleQuick();
          }
          if (!ok) continue;
          const url = new URL(page.url());
          const pattern = screen(url.href);
          const moved = site.has(url.origin) && pattern !== undefined && pattern !== before;
          if (!moved && check && (await check(NOTHING_WAIT_MS))) quiet.push(sequence[0]!);
          if (!moved && sending) await tryAgain(null, sending, () => { pressedAt = Date.now(); return press(sequence[0]!); });
          // Still here: what it revealed (a menu's items) is pressed next, one level deep. A toggle
          // in its other state ("Show password" become "Hide password") isn't among them: pressed
          // again it only goes back to how the page loaded. New words that are a next step ("Edit"
          // become "Save") are pressed like anything else it revealed.
          if (!moved && sequence.length === 1) {
            const itself = await ownNewLabel();
            const toggledBack = itself && (itself.toggle || otherState(sequence[0]!, itself.label)) ? itself.label : undefined;
            for (const label of await visibleLabels()) {
              const next = [...sequence, label];
              if (onScreen.has(label) || label === toggledBack || risky.test(label) || queued.has(next.join(" › "))) continue;
              queued.add(next.join(" › "));
              sequences.push(next);
            }
          }
          // A pop-up with a form (invite, add, edit): filled and saved too, the write answered by us.
          if (learn && !(await fillAndSave(true))) await walkPopUp();
          // A save we answered can draw the page again as if new, whatever its shape says.
          const changed = moved || sequence.length > 1 || savedAt >= pressStart || (await pageShape()) !== shape;
          // The snippet re-reads a page that changed; one that didn't needs no wait (a tab is read at once).
          if (changed) await snippetCaughtUp(SNIPPET_SETTLE_MS);
          else await page.waitForTimeout(150);
          await flushSnippet();
          needLoad = changed || guard.holding(); // the hold ends with a fresh load, and a held press shows nothing true
          if (moved && pattern && !leftOut(url)) {
            if (!/^#!?\/./.test(url.hash)) url.hash = ""; // hash routes are screens (a bare "#/" is the page itself)
            found.push(url.href);
          }
        } catch {
          // a button that errors or hangs is just skipped
        }
      }
      const confirmUntil = Date.now() + NOTHING_BUDGET_MS;
      /** This page went without a script of its own that the run refused: none of its buttons can be said to do nothing. */
      const withoutOwnCode = () => withoutItsCode || refusedOn.has(before ?? "/");
      const dead: string[] = [];
      for (const label of quiet.slice(0, 4)) {
        if (pageTimeUp() || Date.now() > confirmUntil) break;
        if (seal) break; // a second look is for a finding, and this pass gives none
        if (withoutOwnCode()) break;
        if (await confirmNothing(label, quiet, confirmUntil).catch(() => false)) dead.push(label);
      }
      // Each second look loads the page afresh, so it may not yet have asked for what it puts off: on
      // a local run, which refuses what it asks other hosts for, that is run ahead first, once, and
      // only on a page with a button about to be called dead. Elsewhere nothing is refused.
      if (dead.length && !withoutOwnCode() && (config.stayLocal !== true || (await settlesAhead(withoutOwnCode)))) {
        for (const label of dead) addFinding({ kind: "does_nothing", screen: before ?? "/", target: label, evidence: "nothing changed on screen, and no request, navigation or dialog followed" });
      }
      return found;
    };

    /**
     * A cookie banner, answered the most private way (see DECLINE_COOKIES), so screens are learned
     * and photographed as people see them once it's gone. Banners usually sit fixed over the page,
     * so "shown" is judged by size, not by having a layout parent (a fixed element has none).
     */
    /** Where a cookie banner sat, and what answering it changed in the browser, so it can be brought back (see bringBannerBack). */
    let consent: { desktop: Box | undefined; phone: Box | undefined; local: string[]; session: string[]; cookies: string[] } | undefined;
    /** What says the site was answered: what a banner's answer leaves behind. */
    const consentState = async () => ({
      ...(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })).catch(() => ({ local: {} as Record<string, string>, session: {} as Record<string, string> }))),
      cookies: await context.cookies().catch(() => []),
    });
    /** Answers a cookie banner the privacy-preserving way. Asked again before a photo: a banner may come late. */
    const declineCookies = async () => {
      if (!(await page.evaluate(findBanner, DECLINE_COOKIES.source).catch(() => undefined))) return;
      // A banner often slides in: where it's going is what matters.
      await page.waitForTimeout(consent ? 0 : BANNER_SETTLE_MS);
      const banner: Banner | undefined = await page.evaluate(findBanner, DECLINE_COOKIES.source).catch(() => undefined);
      if (!banner) return;
      const was = await consentState();
      const click = () => page.evaluate(() => (window as unknown as { __ctxDecline?: HTMLElement }).__ctxDecline?.click()).catch(() => {});
      let onPhone: Box | undefined;
      if (banner.fixed && !consent) onPhone = await atPhone(async () => {
        await page.waitForTimeout(BANNER_SETTLE_MS);
        return (await page.evaluate(findBanner, DECLINE_COOKIES.source).catch(() => undefined))?.box;
      });
      await click();
      await page.waitForTimeout(400);
      const now = await consentState();
      const changed = (before: Record<string, string>, after: Record<string, string>) => Object.keys(after).filter((key) => after[key] !== before[key]);
      const cookie = (c: { name: string; value: string }) => `${c.name}=${c.value}`;
      const hadCookies = new Set(was.cookies.map(cookie));
      if (banner.fixed && !consent) consent = { desktop: banner.box, phone: onPhone, local: changed(was.local, now.local), session: changed(was.session, now.session), cookies: now.cookies.filter((c) => !hadCookies.has(cookie(c))).map((c) => c.name) };
    };

    /**
     * A pop-up with steps and no form (an "Apply" wizard): each step filled in, then "Continue",
     * until it sends (answered by us), closes or stops moving.
     */
    const walkPopUp = async () => {
      for (let step = 0; step < MAX_WIZARD_STEPS && !pageTimeUp(); step++) {
        const before = await page.evaluate(() => document.querySelector("dialog[open], [role=dialog]")?.textContent?.slice(0, 400) ?? null).catch(() => null);
        if (before === null) return;
        await fillLooseFields();
        const stepButton = () => page.evaluate(({ onward, send, risky }) => {
          const dialog = [...document.querySelectorAll("dialog[open], [role=dialog]")].pop();
          const buttons = [...(dialog?.querySelectorAll("button, [role=button]") ?? [])] as HTMLElement[];
          const text = (b: HTMLElement) => (b.innerText || b.getAttribute("aria-label") || "").trim();
          const b = buttons.find((x) => new RegExp(onward, "i").test(text(x))) ?? buttons.find((x) => new RegExp(send, "i").test(text(x)) && !new RegExp(risky, "i").test(text(x)));
          if (!b) return undefined;
          b.setAttribute("data-ctx-next", "");
          return (window as unknown as { __ctxRead?: { says: (e: Element) => Saying } }).__ctxRead?.says(b) ?? { text: text(b), around: dialog?.textContent ?? "", marks: "" };
        }, { onward: ONWARD.source, send: SEND_ON.source, risky: riskyPress.source }).catch(() => undefined);
        // Read before it fires, as with any press: the request goes out with the click.
        const pressStep = async () => {
          const says = await stepButton();
          if (!says || (config.realWrites && controlDestroys(says))) return false;
          holdFor(says);
          pressedAt = Date.now();
          await page.evaluate(() => (document.querySelector("[data-ctx-next]") as HTMLElement | null)?.click()).catch(() => {});
          await page.evaluate(() => document.querySelector("[data-ctx-next]")?.removeAttribute("data-ctx-next")).catch(() => {});
          return true;
        };
        const stepFields = () => page.evaluate(() => [...(document.querySelector("dialog[open], [role=dialog]")?.querySelectorAll("input, select, textarea") ?? [])].map((f) => (f as HTMLInputElement).name || f.id).join() || null).catch(() => null);
        const fieldsWere = await stepFields();
        const sending = await beforeSending();
        if (!(await pressStep())) return;
        touch();
        await page.waitForTimeout(600);
        await settle();
        await caughtUp();
        await flushSnippet();
        // The same fields still: it hasn't moved on, and may have said what it wants.
        if (fieldsWere !== null && (await stepFields()) === fieldsWere) await tryAgain("dialog[open], [role=dialog]", sending, pressStep);
        await photograph();
        const after = await page.evaluate(() => document.querySelector("dialog[open], [role=dialog]")?.textContent?.slice(0, 400) ?? null).catch(() => null);
        if (after === null || after === before) return; // it sent and closed, or a step it can't get past
      }
    };

    /**
     * Forms already sent, by where they send and what they ask: one on every page (a sidebar's
     * sign-in, a footer's newsletter box) is learned once, and the page's own form gets its turn.
     */
    const sentForms = new Set<string>();
    /**
     * Sends a box the way a person does: Enter pressed on the keyboard with the box focused (apps
     * listen for the key on the box, or on the page), then a moment for the page to take it: the
     * box emptying, the page changing, or a new page loading. Says whether the box emptied into
     * something new on the page: a list it added to.
     */
    const sendWithEnter = async (selector: string) => {
      const box = await page.$(selector).catch(() => null);
      if (!box) return false;
      await box.focus().catch(() => {});
      const size = () => page.evaluate(() => document.body.querySelectorAll("*").length).catch(() => 0);
      const sized = await size();
      const changes = await page.evaluate(() => (window as unknown as { __ctxSeen?: { changes: number } }).__ctxSeen?.changes ?? 0).catch(() => 0);
      pressedAt = Date.now();
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForFunction(({ box, changes }) => {
        const field = box as HTMLInputElement;
        return !field.isConnected || field.value === "" || ((window as unknown as { __ctxSeen?: { changes: number } }).__ctxSeen?.changes ?? 0) > changes;
      }, { box, changes }, { timeout: 1500, polling: 100 }).catch(() => {});
      const emptied = await box.evaluate((field) => (field as HTMLInputElement).value === "").catch(() => false);
      return emptied && (await size()) > sized;
    };
    /** What a press beside a form has to be compared with, to tell whether it went anywhere (see tryAgain). */
    const beforeSending = async () => ({ sent: sentSoFar(), url: page.url(), lines: await page.evaluate(readLines).catch(() => [] as string[]) });
    /**
     * A form tells you what it wants. When a press sent nothing, stayed where it was, and the browser
     * or the page says what's wrong (a field's validity, aria-invalid, the message beside it), the
     * fields it points at get a value that meets it (see fixesFor) and the press is made again, at
     * most FORM_RETRIES times. A press that went through, or a page with no complaint, is left alone.
     */
    const tryAgain = async (root: string | null, before: Awaited<ReturnType<typeof beforeSending>>, again: () => Promise<unknown>) => {
      // Only the run's own end stops this: a page's time spent on a form that was turned down at the last step is lost for nothing.
      for (let attempt = 0; attempt < FORM_RETRIES && !interrupted() && Date.now() <= deadline; attempt++) {
        if (sentSoFar() !== before.sent || page.url() !== before.url) return;
        const seen = await page.evaluate(readRejection, { root, before: before.lines, wrong: SOUNDS_WRONG.source, place: ERROR_PLACE }).catch(() => null);
        if (!seen) return;
        const fixes = fixesFor(seen, attempt);
        if (fixes.length === 0) return;
        touch();
        for (const fix of fixes.slice(0, 12)) {
          const field = page.locator(`[data-ctx-fix="${fix.mark}"]`).first();
          // A corrected value is typed like any other: a request carrying it is a save (see carriesTyped).
          if (fix.kind === "fill") noteTyped(fix.value);
          if (fix.kind === "select") await field.selectOption(fix.value).catch(() => {});
          else if (fix.kind === "check") await field.check().catch(() => {});
          else if (fix.kind === "clear") await field.setInputFiles([]).catch(() => {});
          else await field.fill(fix.value).catch(() => {});
        }
        await again();
        await page.waitForTimeout(700);
        await settle();
        await caughtUp();
        await flushSnippet();
      }
    };
    /**
     * Fills the first form on screen (or in an open pop-up) not sent before with test values and
     * presses its save button. The write it causes is answered by us (see above), so nothing is saved anywhere.
     */
    const fillAndSave = async (inPopUpOnly: boolean, mayGo?: (says: Saying) => boolean): Promise<boolean | "stopped"> => {
      const plan = await page.evaluate(
        ({ popUpOnly, risky, sent, sentence, prompt, phone }) => {
          const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest("[hidden],[aria-hidden=true]"); };
          const scope = popUpOnly ? [...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog]")].filter(shown) : [document];
          // The page's own forms before a header's search or a footer's newsletter box.
          const place = (f: Element) => (f.closest("main, [role=main]") ? 0 : f.closest("header, nav, footer, aside, [role=banner], [role=navigation], [role=contentinfo], [role=search]") ? 2 : 1);
          const forms = scope.flatMap((s) => [...s.querySelectorAll("form")]).filter(shown).sort((a, b) => place(a) - place(b));
          const RISKY = new RegExp(risky, "i");
          const read = (window as unknown as { __ctxRead?: { says: (e: Element) => Saying; searchBox: (e: Element) => boolean } }).__ctxRead;
          const TYPED = ["text", "email", "url", "tel", "number", "input", "textarea"];
          const said = (b: Element) => ((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          // Marks from a form filled before on this page (one that sent without leaving it) would point at that form.
          for (const el of document.querySelectorAll("[data-ctx-learn], [data-ctx-learn-submit], [data-ctx-learn-enter], [data-ctx-learn-form]")) for (const mark of ["data-ctx-learn", "data-ctx-learn-submit", "data-ctx-learn-enter", "data-ctx-learn-form"]) el.removeAttribute(mark);
          for (const form of forms) {
            const allButtons = [...form.querySelectorAll("button:not([type=button]):not([type=reset]), input[type=submit]")];
            const buttons = allButtons.filter(shown);
            // A button can wait for the form: greyed out or not drawn until what it needs is chosen (a
            // list to pick a name from, then "Login"). That one's pressed once the form is filled in.
            const waiting = (b: Element) => !shown(b) || (b as HTMLButtonElement).disabled;
            const submit = buttons.find((b) => !waiting(b) && !RISKY.test(said(b))) ?? (buttons.some((b) => !waiting(b)) ? undefined : allButtons.find((b) => !RISKY.test(said(b) || (b.textContent ?? ""))));
            // Where it sends (without a session id carried in the address, ";jsessionid=…"), what it
            // asks and how it's sent. A single-page app's form often has no address and fields with no
            // names: each field's type and placeholder or label, and the button's words, tell two apart.
            const field = (f: Element) => {
              const x = f as HTMLInputElement;
              return x.name || x.id || `${(x.getAttribute("type") || x.tagName).toLowerCase()}:${(x.getAttribute("placeholder") || x.getAttribute("aria-label") || x.labels?.[0]?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)}`;
            };
            const kind = `${(form.getAttribute("action") ?? "").replace(/;[^?#]*/, "")}|${[...form.querySelectorAll("input, select, textarea")].map(field).sort().join(",")}|${submit ? said(submit).slice(0, 40) : ""}`;
            if (sent.includes(kind)) continue;
            // A form with one box to type in and no button at all ("What needs to be done?") is sent
            // the way a person sends it: Enter in that box.
            const typed = [...form.querySelectorAll("input, textarea")].filter((f) => shown(f) && TYPED.includes(((f.getAttribute("type") || f.tagName).toLowerCase())));
            const enter = !submit && buttons.length === 0 && typed.length === 1;
            if (!submit && !enter) continue;
            form.setAttribute("data-ctx-learn-form", "");
            submit?.setAttribute("data-ctx-learn-submit", "");
            if (enter) typed[0]!.setAttribute("data-ctx-learn-enter", "");
            const steps: { i: number; kind: "fill" | "select" | "check"; value: string; search?: boolean }[] = [];
            [...form.querySelectorAll("input, select, textarea")].forEach((el, i) => {
              const f = el as HTMLInputElement;
              const type = (f.getAttribute("type") || f.tagName).toLowerCase();
              if (!shown(f) || f.disabled || f.readOnly || ["hidden", "submit", "button", "reset", "file", "image"].includes(type)) return;
              f.setAttribute("data-ctx-learn", String(i));
              const hint = `${f.name} ${f.id} ${f.getAttribute("placeholder") ?? ""} ${f.labels?.[0]?.textContent ?? ""}`.toLowerCase();
              if (f.tagName === "SELECT") {
                const choices = [...(f as unknown as HTMLSelectElement).options].filter((o) => o.value && !o.disabled);
                const option = choices.find((o) => !new RegExp(prompt, "i").test(o.text)) ?? choices[0];
                if (option) steps.push({ i, kind: "select", value: option.value });
                return;
              }
              if (type === "checkbox" || type === "radio") { if (f.required) steps.push({ i, kind: "check", value: "" }); return; }
              const pattern = f.getAttribute("pattern");
              const digits = pattern && /^(?:\[0-9\]|\\d)\{(\d+)\}$/.exec(pattern);
              const value = digits ? "123456789012345678".slice(0, Number(digits[1]))
                : type === "email" || /e-?mail/.test(hint) ? "learner@example.test"
                : type === "tel" || /phone|mobile/.test(hint) ? phone
                : /birth|\bdob\b/.test(hint) ? "1990-01-15"
                : type === "number" || /^(numeric|decimal)$/.test(f.getAttribute("inputmode") ?? "") || /\b(?:amount|price|total|qty|quantity|count|age)\b/.test(hint) ? String(Math.max(Number(f.min) || 0, 1) * 10)
                : type === "date" ? "2026-01-15" : type === "time" ? "09:00" : type === "datetime-local" ? "2026-01-15T09:00"
                : type === "url" || /website|url/.test(hint) ? "https://example.test"
                : type === "password" ? "Learner-pass-123"
                : /company|organi[sz]ation|business/.test(hint) ? "Test Ltd"
                : /name|title/.test(hint) ? "Test name"
                : f.tagName === "TEXTAREA" ? sentence : "Test";
              steps.push({ i, kind: "fill", value, search: read?.searchBox(f) === true });
            });
            return { kind, steps, enter, label: submit ? said(submit).slice(0, 80) : undefined, tag: submit ? submit.tagName.toLowerCase() : "input", says: submit ? read?.says(submit) : undefined };
          }
          return null;
        },
        { popUpOnly: inPopUpOnly, risky: riskyPress.source, sent: [...sentForms], sentence: SENTENCE, prompt: CHOOSE_PROMPT.source, phone: FICTIONAL_PHONE },
      ).catch(() => null);
      if (!plan) return false;
      sentForms.add(plan.kind);
      const says = plan.says ?? { text: plan.label ?? "", around: "", marks: "" };
      // With --create a form goes for real: not one that says it destroys, nor a button with no words at all.
      if (config.realWrites && (controlDestroys(says) || (!plan.enter && !plan.label))) return true;
      // A journey's form that reads as real is left as it is: nothing typed, nothing sent.
      if (mayGo && !mayGo(says)) return "stopped";
      touch();
      for (const s of plan.steps) {
        const field = page.locator(`[data-ctx-learn="${s.i}"]`).first();
        // A choice goes with the save too, but a list's value is the site's own, so it matches anything.
        noteTyped(s.value, s.kind !== "fill" || s.search);
        if (s.kind === "select") await field.selectOption(s.value).catch(() => {});
        else if (s.kind === "check") await field.check().catch(() => {});
        else await field.fill(s.value).catch(() => {});
      }
      await chooseFiles();
      const where = screen(page.url());
      submitting = { tag: plan.tag, ...(plan.label ? { label: plan.label } : {}), ...(where ? { page: where } : {}) };
      const sending = await beforeSending();
      const send = async () => {
        holdFor(says);
        pressedAt = Date.now();
        if (plan.enter) await sendWithEnter("[data-ctx-learn-enter]");
        else {
          // A consent pop-up or an advert over the page takes the click: the button itself is pressed instead.
          const button = page.locator("[data-ctx-learn-submit]").first();
          await button.click({ timeout: 2000 }).catch(() => button.evaluate((b) => (b as HTMLElement).click()).catch(() => {}));
        }
      };
      await send();
      await page.waitForTimeout(700);
      await settle();
      await caughtUp();
      await flushSnippet();
      await tryAgain("[data-ctx-learn-form]", sending, send);
      return true;
    };

    /**
     * Boards and sortable lists: drags something made to be dragged into each list that looks like
     * the one it's in (the other columns), as a person would, from a fresh load each time. The
     * save it causes is answered by us, so it's learned without anything reaching the site.
     */
    const tryDrags = async (href: string) => {
      await load(href).catch(() => {});
      const plans = await page.evaluate(() => {
        const grabbable = (el: Element) => {
          const c = getComputedStyle(el).cursor;
          return el.getAttribute("draggable") === "true" || c === "grab" || c === "move" || el.hasAttribute("aria-grabbed");
        };
        const items = [...document.querySelectorAll("body *")].filter((el) => grabbable(el) && el.getBoundingClientRect().width > 0).slice(0, 2);
        const out: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
        for (const item of items) {
          const list = item.parentElement;
          if (!list || !list.className) continue;
          const sel = "." + [...list.classList].map((c) => CSS.escape(c)).join(".");
          const r = item.getBoundingClientRect();
          for (const other of [...document.querySelectorAll(sel)].filter((o) => o !== list).slice(0, 4)) {
            const t = other.getBoundingClientRect();
            if (t.width === 0) continue;
            out.push({ from: { x: r.left + r.width / 2, y: r.top + r.height / 2 }, to: { x: t.left + t.width / 2, y: t.top + Math.min(t.height / 2, 120) } });
          }
        }
        return out.slice(0, 6);
      }).catch(() => []);
      for (const plan of plans) {
        if (pageTimeUp()) break;
        try {
          await load(href);
          touch();
          await page.mouse.move(plan.from.x, plan.from.y);
          await page.mouse.down();
          await page.mouse.move(plan.to.x, plan.to.y, { steps: 12 });
          await page.waitForTimeout(150);
          await page.mouse.up();
          await page.waitForTimeout(600);
          await settle();
          await caughtUp();
          await flushSnippet();
        } catch {
          // a drag that errors is just skipped
        }
      }
    };

    /**
     * Keyboard-first apps: opens the command menu (⌘K or Ctrl+K) and runs each command in it, from a
     * fresh load each time. The menu is the app's, not a page's: once its commands are learned, or
     * once it hasn't opened on a few pages, it isn't looked for again.
     */
    let commandMenu: { opened: boolean; misses: number } = { opened: false, misses: 0 };
    const tryCommandMenu = async (href: string) => {
      if (commandMenu.opened || commandMenu.misses >= 3) return;
      const open = async () => {
        touch();
        for (const keys of ["Meta+k", "Control+k"]) {
          await page.keyboard.press(keys).catch(() => {});
          await page.waitForTimeout(400);
          const opened = await page.$("[role=dialog] [role=combobox], [role=dialog] input, [role=listbox] [role=option]").catch(() => null);
          if (opened) return true;
        }
        return false;
      };
      await load(href).catch(() => {});
      if (!(await open())) {
        commandMenu.misses++;
        return;
      }
      commandMenu = { ...commandMenu, opened: true };
      const commands = (await page.$$eval("[role=option]", (els) => els.map((e) => ((e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)).filter(Boolean)).catch(() => [] as string[]))
        .filter((c) => !riskyPress.test(c) && !saysActs({ text: c, around: "", marks: "" })).slice(0, 10);
      for (const command of commands) {
        if (pageTimeUp()) break;
        try {
          await load(href);
          if (!(await open())) break;
          await page.keyboard.type(command, { delay: 20 });
          await page.waitForTimeout(300);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(700);
          await settle();
          await caughtUp();
          await flushSnippet();
        } catch {
          // a command that errors is just skipped
        }
      }
    };

    /**
     * Test values in the fields that aren't in a form (a reply box, an inline editor), and a choice in
     * each loose list: what a person does before pressing the button next to them. Returns how many.
     * With `enter`, a lone box with no button beside it (a to-do list's "What needs to be done?") is
     * sent with Enter, as that's the only way a person can.
     */
    const fillLooseFields = async (enter = false) => {
      const fields = await page.$$eval("input, textarea", (els, kinds) =>
        els.flatMap((el, i) => {
          const f = el as HTMLInputElement;
          const type = (f.getAttribute("type") || "text").toLowerCase();
          const r = f.getBoundingClientRect();
          if (r.width === 0 || f.disabled || f.readOnly || f.closest("form") || ![...kinds, "text", "email", "url", "tel", "number", "search", "textarea", "date"].includes(f.tagName === "TEXTAREA" ? "textarea" : type)) return [];
          if (type === "search" || (f.getAttribute("role") === "combobox" && kinds.length === 0)) return [];
          f.setAttribute("data-ctx-type", String(i));
          // Alone: the group it sits in (its parent, past wrappers that hold only the box) has no other
          // box and no button. Not wider: a list it adds to may have buttons of its own (a to-do's
          // "Clear completed"), and those don't send it.
          let around: Element = f;
          while (around.parentElement && around.parentElement !== document.body && around.parentElement.children.length === 1) around = around.parentElement;
          around = around.parentElement ?? around;
          const alone = f.tagName !== "TEXTAREA" && around.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select").length === 1
            && around.querySelector("button, [role=button], input[type=submit], input[type=button]") === null;
          return [{ i, type: f.tagName === "TEXTAREA" ? "textarea" : type, inputMode: f.getAttribute("inputmode"), hint: `${f.name} ${f.placeholder} ${f.id} ${f.labels?.[0]?.textContent ?? ""}`.toLowerCase(), alone, offers: f.getAttribute("role") === "combobox", search: (window as unknown as { __ctxRead?: { searchBox: (e: Element) => boolean } }).__ctxRead?.searchBox(f) === true }];
        }), walking ? ["datetime-local", "time"] : [],
      ).catch(() => [] as { i: number; type: string; inputMode: string | null; hint: string; alone: boolean; offers: boolean; search: boolean }[]);
      // A lone box is only ever sent with Enter: typed into and left unsent, it would sit half-filled
      // in every photo that follows, which no person leaves it as.
      const filling = fields.filter((f) => enter || !f.alone);
      if (filling.length > 0) touch();
      let added = false;
      for (const f of filling.slice(0, walking ? WALK_MOST_BOXES : 8)) {
        const selector = `[data-ctx-type="${f.i}"]`;
        const value = testValue(fieldType(f.type, f.inputMode, walking ? f.hint : ""), f.hint);
        noteTyped(value, f.search);
        // A form that's drawn again as it's typed in loses its marks, and keeps its order.
        const box = walking ? page.locator("input, textarea").nth(f.i) : page.locator(selector);
        await box.fill(value).catch(() => {});
        // A box that offers a list wants something off the list: made-up words in one are turned down at the end of a form, not at the box.
        if (walking && f.offers) {
          await box.fill("").catch(() => {});
          await box.click({ timeout: WALK_ACTION_MS }).catch(() => {});
          const offered = page.locator("[role=option]:visible").first();
          await offered.click({ timeout: WALK_OFFER_MS }).catch(() => box.fill(value).catch(() => {}));
        }
        if (enter && f.alone) {
          submitting = { tag: "input" };
          if (await sendWithEnter(selector)) added = true;
        }
      }
      // The list now has something in it: that's how people see this screen, and what's read and
      // photographed, before anything else is done to what was just added.
      if (added) {
        addsWithEnter.add(screen(page.url()) ?? "");
        await snippetCaughtUp(SNIPPET_SETTLE_MS);
        await photograph(true);
      }
      // A loose box to tick ("I confirm these details are correct"); never one that signs up for something.
      await page.$$eval("input[type=checkbox]", (els) => {
        for (const el of els) {
          const c = el as HTMLInputElement;
          const text = (c.closest("label")?.textContent ?? "").toLowerCase();
          if (!c.closest("form") && !c.checked && !c.disabled && c.getBoundingClientRect().width > 0 && !/newsletter|marketing|offers|subscribe/.test(text)) c.click();
        }
      }).catch(() => {});
      // A loose list that saves when changed (a ticket's category): its first real choice.
      pressedAt = Date.now();
      const lists = await page.$$eval("select", (els, prompt) =>
        els.flatMap((el, i) => {
          const sel = el as HTMLSelectElement;
          if (sel.closest("form") || sel.disabled || sel.getBoundingClientRect().width === 0) return [];
          const choices = [...sel.options].filter((o) => o.value && !o.disabled && o.value !== sel.value);
          const option = choices.find((o) => !new RegExp(prompt, "i").test(o.text)) ?? choices[0];
          if (!option) return [];
          sel.setAttribute("data-ctx-pick", String(i));
          return [{ i, value: option.value }];
        }), CHOOSE_PROMPT.source,
      ).catch(() => [] as { i: number; value: string }[]);
      if (lists.length > 0) touch();
      for (const l of lists.slice(0, 4)) await page.selectOption(`[data-ctx-pick="${l.i}"]`, l.value).catch(() => {});
      return filling.length + lists.length;
    };
    /**
     * Forms that save as you type (no Save button): types a test value into each field, then waits
     * for the save to go out. Writes are answered by us, as always.
     */
    const typeIntoFields = async () => {
      if (!(await fillLooseFields(true))) return false;
      await page.waitForTimeout(1500);
      await settle();
      await caughtUp();
      await flushSnippet();
      return true;
    };

    /**
     * The sealed page as a journey sees it (see Drive). Nothing here has a way out of its own: every
     * press and page load goes through the route above, the seal first and the read-only rule behind it.
     */
    const journeyDrive = (sealed: Seal): Drive => ({
      reset: async () => {
        heldUntil = 0;
        // What the last journey left in the tab's own storage, as a draft, isn't the next one's: clearing the origin's data leaves it.
        await page.evaluate(() => sessionStorage.clear()).catch(() => {});
        await page.goto("about:blank").catch(() => {});
        sealed.forget();
        sentForms.clear();
        typed.clear();
        everTyped.clear();
        await cdp.send("Storage.clearDataForOrigin", { origin: start.origin, storageTypes: "all" }).catch(() => {});
      },
      open: async (path) => {
        const url = new URL(path, start);
        if (url.origin !== start.origin || !plainRead(url) || !sealed.isPage(url) || interrupted()) return false;
        heldUntil = 0;
        await beforeLoad();
        if (!(await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null))) return false;
        await settle();
        await declineCookies();
        await waitForSomethingToDo();
        return true;
      },
      origin: start.origin,
      look: async (before, anyChange, patient) => {
        const read = async (): Promise<ScreenNow> => {
          await markPressable();
          const seen = await page.evaluate(readStep, { clickable: CLICKABLE, wrong: SOUNDS_WRONG.source, crash: CRASH_WORDS.source }).catch((): ReturnType<typeof readStep> => ({ fieldsKey: "", rows: 0, text: "", busy: false, controls: [], files: 0, looseBox: false, looseFields: 0 }));
          const wall = await page.evaluate(readWall, WALL_WORDS).catch((): Wall => ({ kind: "blank", text: "", rows: 0, fields: 0, listed: "" }));
          const path = screen(page.url()) ?? new URL(page.url()).pathname;
          const placed = !sealed.publicScreens.has(path) && !sealed.drawsNowhere(path, wall.text, wall.heading) && !hasMissingValue(new URL(page.url()));
          const asks = seen.form?.hints ? stopOfField(seen.form.hints) : undefined;
          const form = seen.form && { ...seen.form, ...(asks ? { stop: asks } : {}) };
          // A box asks the same with no form around it.
          const anyBox = !asks && seen.boxHints ? stopOfField(seen.boxHints) : undefined;
          // A control named for the made-up user or a row is no step of anyone's journey.
          const controls = seen.controls.filter((control) => !madeUp(control.label));
          // What's got controls isn't blank, whatever a pop-up over the whole page does to the rest of it.
          const kind = wall.kind === "blank" && controls.length > 0 ? undefined : wall.kind;
          return { ...seen, controls, form, path, placed, ...(kind ? { wall: kind } : {}), ...(anyBox ? { asks: anyBox } : {}) };
        };
        await settleQuick();
        const began = Date.now();
        let now = await read();
        let was: ScreenNow | undefined;
        const until = began + STEP_WAIT_MS;
        // Drawing, or a chat still typing: read again until it's stopped, and after a press until it's moved on or the page has gone still, for as long as a press gets.
        while (Date.now() < until && !interrupted()) {
          // Still: nothing on the page has changed for a while, and this look has waited at least that long since the press.
          const sinceChange = await page.evaluate(() => { const seen = (window as unknown as { __ctxSeen?: { lastChange: number } }).__ctxSeen; return seen ? performance.now() - seen.lastChange : 0; }).catch(() => 0);
          const quiet = ![...loading.values()].some((since) => Date.now() - since < 10_000) && Date.now() - trafficAt >= QUIET_MS;
          const stillFor = Math.min(sinceChange, Date.now() - began + WALK_SETTLE_MS);
          // Nothing on the page has changed for as long as two reads a poll apart: the next read would be this one, so it stands for it.
          const held = sinceChange >= STEP_POLL_MS && quiet ? now : was;
          if (held && stepSettled({ was: held, now, before, anyChange, patient, stillFor, quiet })) break;
          // Waiting out the stillness a press is given: woken when it's due, not a poll after.
          const due = before && !patient && quiet && held === now ? (anyChange ? STEP_STILL_MORE_MS : STEP_STILL_MS) - stillFor : STEP_POLL_MS;
          await page.waitForTimeout(Math.max(STEP_POLL_LEAST_MS, Math.min(STEP_POLL_MS, due))).catch(() => {});
          was = now;
          now = await read();
        }
        return now;
      },
      press: async (mark) => {
        const control = page.locator(`[data-ctx-step="${mark}"]`).first();
        const says = await control.evaluate((el) => (window as unknown as { __ctxRead?: { says: (e: Element) => Saying } }).__ctxRead?.says(el)).catch(() => undefined);
        // Read again at the moment of pressing: a page may have changed what it says since it was chosen.
        if (!says || ["destroys", "sign_out"].includes(stopOf(says) ?? "")) return false;
        holdFor(says);
        submitting = { tag: "button", ...(says.text ? { label: says.text.slice(0, 80) } : {}) };
        pressedAt = Date.now();
        touch();
        const sending = await beforeSending();
        // A cookie pop-up or an advert over the page takes the click: the control itself is pressed instead.
        const click = () => control.click({ timeout: 1500 }).catch(() => control.evaluate((b) => (b as HTMLElement).click()).catch(() => {}));
        await click();
        await page.waitForTimeout(WALK_SETTLE_MS).catch(() => {});
        // A press beside boxes that said what they want gets those fixed, as a form's does.
        await tryAgain(null, sending, click);
        return true;
      },
      fill: async (inDialog, mayGo) => {
        // A journey keeps its own count of what it's sent: to a reply box in a chat, every step is a new form.
        sentForms.clear();
        const went = await fillAndSave(inDialog, mayGo);
        return went === "stopped" ? "stopped" : went ? "sent" : "nothing";
      },
      loose: async () => (await fillLooseFields(true)) > 0,
      review: async (path, afterSave) => reviewScreen(path, afterSave ? -1 : sealed.filled),
      trail: () => sealed.trail,
      keptIn: (text) => sealed.keptIn(text),
      async reopen(path) {
        await page.evaluate(() => sessionStorage.clear()).catch(() => {});
        return this.open(path);
      },
      forgetServed: () => sealed.forgetServed(),
      keptServedIn: (text) => sealed.keptServedIn(text),
      plain: (text) => (madeUp(text) ? MADE_UP_LINE : withoutTokens(text)),
      stopped: () => interrupted(),
    });

    /** Goes through a page's forms as a person would: fill, save, and on through a wizard's steps. */
    /** Where a step of a form is and what the page says there: the same before and after a press, and the press moved nothing on. */
    const stepNow = () => page.evaluate(() => `${location.href}|${document.body.innerText}`).catch(() => undefined);
    const learnForms = async (href: string): Promise<string[]> => {
      const found: string[] = [];
      try {
        await load(href);
        // Fields outside any form (one that saves as you type): typed into once.
        await typeIntoFields();
        for (let step = 0; step < MAX_WIZARD_STEPS && (step === 0 || !pageTimeUp()); step++) {
          if (!(await fillAndSave(false))) {
            // A step with nothing to fill: move on the way a person would ("Continue", "Skip for now").
            // Read before it fires, as with any press. Only one on show: a person can't press a hidden one.
            const says = await page.evaluate((onward) => {
              const b = [...document.querySelectorAll("button, [role=button], a:not([href])")].find((e) => e.checkVisibility() && new RegExp(onward, "i").test(((e as HTMLElement).innerText || "").trim()));
              if (!b) return undefined;
              b.setAttribute("data-ctx-next", "");
              return (window as unknown as { __ctxRead?: { says: (e: Element) => Saying } }).__ctxRead?.says(b) ?? { text: (b as HTMLElement).innerText, around: "", marks: "" };
            }, ONWARD.source).catch(() => undefined);
            if (!says || (config.realWrites && controlDestroys(says))) break;
            holdFor(says);
            const was = await stepNow();
            pressedAt = Date.now();
            await page.evaluate(() => {
              const b = document.querySelector("[data-ctx-next]") as HTMLElement | null;
              b?.removeAttribute("data-ctx-next");
              b?.click();
            }).catch(() => {});
            touch();
            await page.waitForTimeout(600);
            await settle();
            await caughtUp();
            await flushSnippet();
            // A step that left the page saying what it said, at the same address, moved nothing on: the next would only press that button again.
            if (was !== undefined && was === (await stepNow())) break;
          }
          await photograph();
          const url = new URL(page.url());
          if (site.has(url.origin) && screen(url.href) !== screen(href) && !leftOut(url)) found.push(url.href);
        }
      } catch {
        // a form that errors is skipped
      }
      return found;
    };

    const seenPatterns = new Set<string>();
    /**
     * Pages to visit, best first. A big product hides its few real screens among many of one kind
     * (admin, help, settings), so the learner takes turns between the site's parts instead of
     * following links in order, and puts links from long directories (a sidebar of 160 settings,
     * a footer of help articles) after the rest.
     */
    const queue: { href: string; listed: boolean; from?: string }[] = [{ href: start.href, listed: false }];
    const queued = (href: string) => queue.some((q) => q.href === href);
    if (seal) {
      // Public screens are learned already. The start is looked at again (signed in, it may be
      // something else, and its links are the way in), and so is any address asked for by name.
      for (const path of seal.publicScreens) seenPatterns.add(path);
      seenPatterns.delete(screen(start.href) ?? "");
      for (const href of seal.addresses) {
        seenPatterns.delete(screen(href) ?? "");
        if (!queued(href)) queue.push({ href, listed: false });
      }
    }
    const partOf = (pattern: string) => pattern.replace(/^\/?#!?/, "").split("/").filter(Boolean)[0] ?? "";
    const visitsByPart = new Map<string, number>();
    /** The folder a page sits in: /brands/acme and /brands/zeta are items of /brands. */
    const parentOf = (pattern: string) => pattern.replace(/\/[^/]*$/, "");
    /** Collections shown to repeat (two of their items made alike): one or two are a fair sample, so the rest wait. */
    const repeating = new Set<string>();
    const next = () => {
      let best = 0;
      let bestScore = Infinity;
      queue.forEach((q, i) => {
        const pattern = screen(q.href) ?? "";
        const score = (visitsByPart.get(partOf(pattern)) ?? 0) * 4 + (q.listed ? 6 : 0) + (repeating.has(parentOf(pattern)) ? 100 : 0);
        if (score < bestScore) [best, bestScore] = [i, score];
      });
      return queue.splice(best, 1)[0]!;
    };
    /** Screens already learned in full, by their make-up: a copy of one isn't pressed through again. */
    const learnedKinds = new Map<string, number>();
    /**
     * Hash views of one document (an API explorer's "#/Accounts"), and how many in a row showed nothing
     * that hadn't been on another: each costs a full page's wait, and past a few, the rest are the same.
     */
    const dullViews = new Map<string, { made: Set<string>; dull: number }>();
    const finishedDocuments = new Set<string>();
    const hashAt = (pattern: string) => pattern.search(/\/?#!?\//);
    const inFinished = (pattern: string) => hashAt(pattern) >= 0 && finishedDocuments.has(pattern.slice(0, hashAt(pattern)));
    const kindOf = () =>
      page.evaluate(() => {
        // Which fields and buttons, not how many: a list of 9 cards and a list of 12 are made alike.
        const fields = new Set([...document.querySelectorAll("input:not([type=hidden]), select, textarea")].map((f) => (f as HTMLInputElement).name || f.id));
        const buttons = new Set([...document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], a:not([href])")].map((b) => (b as HTMLElement).innerText.trim().slice(0, 40)));
        return [...fields].sort().join(",") + "|" + [...buttons].sort().join(",");
      }).catch(() => "");
    const loginPattern = config.login ? screen(config.login.url) : undefined;
    /** Queues the page's links: on the site, inside the scope, not yet seen. Each says whether it sits in a long list (a directory, not the way through). */
    const queueLinks = async (from: string) => {
      await confirmRoutes();
      // A link that says it downloads (<a download>) is to a file, never a screen.
      const links = await page.$$eval("a[href]:not([download])", (as) =>
        as.map((a) => {
          const list = a.closest("aside, nav, footer, ul, ol, [role=navigation]");
          const says = (window as unknown as { __ctxRead?: { says: (e: Element) => Saying } }).__ctxRead?.says(a);
          const box = a.getBoundingClientRect();
          const seen = box.width > 0 && box.height > 0 && a.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !a.closest("[hidden], [inert], [aria-hidden=true]");
          return { href: (a as HTMLAnchorElement).href, listed: !!list && list.querySelectorAll("a[href]").length >= 20, says, seen };
        }),
      ).catch(() => [] as { href: string; listed: boolean; says?: Saying; seen?: boolean }[]);
      for (const link of links) {
        let url: URL;
        try {
          url = new URL(link.href);
        } catch {
          continue;
        }
        if (!site.has(url.origin) || !/^https?:$/.test(url.protocol)) continue;
        if (excludes?.test(url.pathname) || SKIP_EXTENSIONS.test(url.pathname)) continue;
        const held = linkActs(url, link.says, signedIn);
        if (held) {
          holdBack(url, held);
          continue;
        }
        if (offLimits(url)) {
          noteAway(url);
          continue;
        }
        if (!inside(url)) {
          skippedOutside.add(`${url.origin}${url.pathname}`);
          continue;
        }
        // Hash routes (#/active) are screens; other anchors aren't, nor is a bare "#/" (the page itself).
        if (!/^#!?\/./.test(url.hash)) url.hash = "";
        const pattern = screen(url.href);
        // A hidden section's link is still worth following, but it's no way from what was on screen:
        // a page keeping all its tabs in the document would lend each tab the others' links.
        if (link.seen) ledTo(from, pattern);
        if (!pattern || seenPatterns.has(pattern) || pattern === loginPattern || inFinished(pattern)) continue;
        if (answered > 0 && hasMissingValue(url)) continue; // built from one of our answers: no address of the site's
        const found = queue.find((q) => q.href === url.href);
        if (found) found.listed &&= link.listed; // linked plainly anywhere: not just a directory entry
        else {
          // A link that may have come from one of our made-up answers can't be the site's broken link.
          queue.push({ href: url.href, listed: link.listed, ...(savedAt > (loadedAs?.at ?? 0) ? {} : { from }) });
          linkSources.set(url.href, page.url());
        }
      }
    };
    /** Queues a screen a form or a button led to, when it's new and inside the scope. */
    const queueFound = (found: string) => {
      const pattern = screen(found);
      if (!pattern || seenPatterns.has(pattern) || queued(found) || !inside(new URL(found)) || inFinished(pattern) || offLimits(new URL(found))) return false;
      if (answered > 0 && hasMissingValue(new URL(found))) return false;
      queue.push({ href: found, listed: false });
      return true;
    };

    /** Documents that aren't web pages (an API's XML description, a JSON file, plain text): never screens. */
    const notPages = new Set<string>();
    /** Says a person can get from one screen to another: only what was seen, so a journey can be checked against it. */
    const ledTo = (from: string, to: string | undefined) => {
      if (!to || to === from) return;
      const next = (result.links[from] ??= []);
      if (!next.includes(to)) next.push(to);
    };
    /**
     * Sites that route by their query (index.php?page=invoices, ?title=Main_Page) have one path and
     * many screens. A key is taken for a route only when two of its values answer with different
     * documents, since ?view=grid and ?view=list are one document drawn twice. Asked outside the
     * page, so a site's failure to answer can't become a finding, and through the one rule like
     * anything else; a redirect is left unfollowed, so no hop goes unjudged.
     */
    const triedRouteKeys = new Set<string>();
    const confirmRoutes = async () => {
      const here = await page.$$eval("a[href]:not([download])", (as) => as.map((a) => (a as HTMLAnchorElement).href)).catch(() => [] as string[]);
      const hrefs = here.filter((href) => URL.canParse(href) && site.has(new URL(href).origin));
      for (const key of routeKeysOf(hrefs, page.url())) {
        if (triedRouteKeys.has(key) || triedRouteKeys.size >= MAX_ROUTE_KEYS) continue;
        triedRouteKeys.add(key);
        const byValue = new Map(hrefs.flatMap((href) => {
          const url = new URL(href);
          const value = url.searchParams.get(key);
          // This read is Node's and goes round the route, so round the seal too: sealed, it isn't made.
          const fine = !seal && judge({ method: "GET", type: "fetch", url, headers: {}, navigation: false }, guard).act === "pass" && !offLimits(url);
          return value !== null && fine && !linkActs(url, undefined, signedIn) ? [[value, url] as const] : [];
        }));
        const read = async (url: URL) => {
          const answer = await context.request.get(url.href, { maxRedirects: 0, timeout: 5000 }).catch(() => undefined);
          if (!answer?.ok() || !/html/i.test(answer.headers()["content-type"] ?? "")) return undefined;
          return documentName(await answer.text().catch(() => ""));
        };
        const [one, two] = await Promise.all([...byValue.values()].slice(0, 2).map(read));
        if (!one || !two || one === two) continue;
        routeKeys.push(key);
        await context.addInitScript({ content: `window.__ctxRouteKeys=${JSON.stringify(routeKeys)};` }).catch(() => {});
      }
    };

    /**
     * Breadth before depth: a page gets a look first (loaded, read, photographed, its links queued),
     * and is pressed through later, so one button-heavy hub can't use the time every other page
     * needed. Pages wait here, and the ones with the most that's unique to them go first.
     */
    const waiting: { href: string; shown: string; controls: Control[]; forms: string[]; grabbable: boolean }[] = [];
    /** Forms of pages already pressed through, by where they send and what they ask. */
    const formsDone = new Set<string>();
    // Measuring a screen is time apart: it mustn't cost a screen that was to be looked at.
    const lookTimeOver = () => Date.now() - begun - (result.timings.checks ?? 0) > (config.maxDurationMs ?? 120_000) * LOOK_SHARE;
    /** Looks since a page was last pressed through: past the look share, the two take turns. */
    let looks = 0;
    const nextToPress = () => {
      const worth = (w: (typeof waiting)[number]) => uniqueCount(w.controls, pressMemory) + 5 * w.forms.filter((f) => !formsDone.has(f)).length;
      let best = 0;
      waiting.forEach((w, i) => { if (worth(w) > worth(waiting[best]!)) best = i; });
      return waiting.splice(best, 1)[0]!;
    };
    /** Forms, drags, the command menu and buttons, on a page that's had its look. */
    const pressThrough = async ({ href, shown, controls, forms, grabbable }: (typeof waiting)[number]) => {
      // Nothing here of its own to press or send (only the site's furniture, pressed already): it gets
      // the least any page gets. Buttons in its main content are its own, however another page's read.
      const allSeen = nothingOwn(controls.filter((c) => !riskyPress.test(c.label)), pressMemory) && forms.every((form) => formsDone.has(form));
      for (const form of forms) formsDone.add(form);
      config.onPressing?.(shown);
      // This page's share of the time left, so one heavy page can't use the whole run: what's left
      // spread over the pages waiting, but never less than PAGE_MIN_MS, nor more than 40% of it.
      const begunPage = Date.now();
      const left = deadline - begunPage;
      const share = allSeen ? PAGE_MIN_MS : Math.max(PAGE_MIN_MS, Math.min(left * 0.4, left / Math.max(1, waiting.length + 1 + queue.length / 4)));
      // Forms take longest: they get most of it, not all, so its buttons still get their turn.
      pageDeadline = begunPage + share * 0.6;
      try {
        if (learn) {
          for (const found of await timed("forms", () => learnForms(href))) {
            ledTo(shown, screen(found));
            queueFound(found);
          }
          // Typing in may have added something with links of its own (a to-do's "Active" filter).
          await queueLinks(shown);
        }
        pageDeadline = Math.max(begunPage + share, Date.now() + PAGE_MIN_MS / 2);
        if (learn && grabbable && !pageTimeUp()) await timed("drags", () => tryDrags(href));
        if (learn && !pageTimeUp()) await timed("commands", () => tryCommandMenu(href));
        if (config.exploreButtons !== false && !pageTimeUp()) {
          for (const found of await timed("buttons", () => pressButtons(href))) {
            ledTo(shown, screen(found));
            if (queueFound(found)) result.foundByButtons.push(screen(found)!);
          }
        }
      } catch (error) {
        result.errors.push(`${shown}: ${message(error)}`);
      }
      pageDeadline = deadline;
    };
    if (config.walk && seal) {
      page.on("filechooser", () => seal.note("file", "the file choice"));
      await config.walk(journeyDrive(seal));
      return result;
    }
    let pagesFull = false;
    /** The real addresses opened for each screen (see ScanResult.addresses). */
    const realAddresses = new Map<string, Set<string>>();
    /** Addresses opened so far: the stand-in pass gives up early on an app it finds no library in (see Seal.giveUp). */
    let looked = 0;
    let wallTold = false;
    while (queue.length > 0 || waiting.length > 0) {
      config.measured?.(result);
      if (walls?.size && !wallTold && (queue.length === 0 || lookTimeOver())) {
        wallTold = true;
        await flushSnippet();
        config.onWall?.(result, queue.length === 0);
      }
      if (interrupted()) {
        result.stoppedBy = "interrupted";
        break;
      }
      // Enough pages seen: the ones already seen are still pressed through.
      if (result.pagesVisited.length >= maxPages && queue.length > 0) {
        pagesFull = true;
        queue.length = 0;
      }
      if (Date.now() > deadline) {
        result.stoppedBy = "max_duration";
        break;
      }
      if (overran) break;
      if (seal?.giveUp(looked)) break;
      if (waiting.length > 0 && (queue.length === 0 || (lookTimeOver() && looks >= LOOKS_A_TURN))) {
        looks = 0;
        await pressThrough(nextToPress());
        // The watchdog may have closed the page by now: the run ends with what it has, not with this wait's error.
        if (pause) await page.waitForTimeout(pause).catch(() => {});
        continue;
      }
      if (queue.length === 0) break;
      looks++;
      const { from: linkedFrom, ...nextUp } = next();
      let { href } = nextUp;
      const here = screen(href);
      if (!here || seenPatterns.has(here)) continue;
      seenPatterns.add(here);
      looked++;
      visitsByPart.set(partOf(here), (visitsByPart.get(partOf(here)) ?? 0) + 1);
      const isStart = href === start.href && result.startStatus === undefined && result.startError === undefined;
      pageDeadline = deadline;
      const filledBefore = seal?.filled ?? 0;
      stillAt = undefined; // a new screen's rows are its own to wait for
      const guessedBefore = seal?.guessed ?? 0;
      emptiedAtLoad = seal?.emptied ?? 0;
      // Sealed, the server is asked about an address only if it can be, and before the browser opens it.
      if (seal) {
        const answer = await seal.documentFor(href);
        if (answer === "decided") {
          seal.serverDecided = here;
          break;
        }
        if (answer !== "shell") {
          seal.notReached.push({ path: here, why: answer });
          continue;
        }
      }
      openingStart = isStart;

      try {
        const response = await timed("load", async () => {
          heldUntil = 0; // what the last press set off stops with its page
          await beforeLoad();
          const r = await page.goto(href, { waitUntil: "domcontentloaded" }).catch((error: unknown) => {
            if (isStart && !DOWNLOAD_STARTED.test(message(error))) result.startError = message(error);
            throw error;
          });
          await settle();
          await declineCookies();
          // A start that moved to another address of the site is reloaded there from now on.
          if (isStart && new URL(page.url()).origin !== new URL(href).origin && site.has(new URL(page.url()).origin)) href = page.url();
          loadedAs = { href, url: page.url(), at: Date.now() };
          return r;
        });
        openingStart = false;
        let status = response?.status() ?? 0;
        if (isStart && response) {
          result.startStatus = status;
          const title = await page.title().catch(() => "");
          if (title.trim()) result.startTitle = title.trim().slice(0, 120);
          if (response.headers()["www-authenticate"]) result.startAsksSignIn = true;
        }
        if (stage === "opening") moveTo("exploring");
        const landedUrl = new URL(page.url());
        const landed = site.has(landedUrl.origin) ? screen(landedUrl.href) : undefined;
        if (isStart && response) result.startPath = landed ?? here;
        // A start that left for another site altogether: that site isn't what was asked for, and
        // nothing on it is learned.
        if (isStart && /^https?:$/.test(landedUrl.protocol) && !site.has(landedUrl.origin)) {
          result.startLeftFor = landedUrl.host;
          continue;
        }
        // A link is broken only if pressing it fails. A direct load of a page a router in the browser
        // draws gets the host's 404 (a single-page app on a static host), though a person following
        // the link sees the page: pressed from where it was found, it's that page.
        let clientRouted = false;
        const source = linkSources.get(href);
        if (linkedFrom && source && (status === 404 || status === 410) && !byOurId(href)) {
          const pressed = await timed("load", async () => {
            await load(source);
            return pressLink(href);
          });
          if (pressed === "client") {
            clientRouted = true;
            status = 200;
            clientRoutes.set(href, source);
            loadedAs = { href, url: page.url(), at: Date.now() };
          } else if (pressed !== status) {
            // It didn't fail the same way when pressed: nothing proven, and no page of its own to read.
            result.errorPages.push({ path: here, status });
            continue;
          }
        }
        // Only a web page is a screen: a link to a service's XML description (a WSDL), a JSON file or
        // plain text shows the browser's own view of a document. No type said: the browser sniffs a page.
        const type = clientRouted ? "" : response?.headers()["content-type"] ?? "";
        if (type && !/html/i.test(type)) {
          notPages.add(landed ?? here);
          if (isStart) result.errors.push(`the start address isn't a web page (${type.split(";")[0]!.trim()})`);
          continue;
        }
        // Nor is data sent as a web page: a body that is a single JSON value, alone or in a lone <pre>
        // (an API's answer, served as text/html), or bare text with nothing to draw anything else.
        if (await page.evaluate(isDataDocument).catch(() => false)) {
          notPages.add(landed ?? here);
          if (isStart) result.errors.push("the start address isn't a web page (data)");
          continue;
        }
        // A single-page app draws after it loads: what it says is read once it has said something.
        await timed("read", waitForContent);
        const shows = await page.evaluate(() => ({
          title: document.title,
          heading: ((document.querySelector("h1") ?? document.querySelector("h2, h3, [role=heading]")) as HTMLElement | null)?.innerText ?? "",
          text: document.body?.innerText ?? "",
          fields: document.querySelectorAll("input:not([type=hidden]), select, textarea").length,
          pictures: [...document.images].map((img) => img.currentSrc || img.src).join(" ") + ` ${document.querySelectorAll("svg, canvas, video").length}`,
        })).catch(() => ({ title: "", heading: "", text: "", fields: 0, pictures: "" }));
        // An error page is no screen of the product: a 5xx; a 4xx that says it's missing or says next
        // to nothing (a 404 that shows the app anyway, a single-page app's fallback, is a screen);
        // or a page that loads fine but is only a "page not found" notice.
        const says = SAYS_MISSING.test(shows.text);
        const short = shows.text.trim().length < 300;
        const soft = status > 0 && status < 400 && saysMissing({ title: shows.title, heading: shows.heading, textLength: shows.text.trim().length });
        // So is a 405: an address that takes something else than a page load is an API's, whatever it
        // shows a browser (a framework's page for trying it out).
        const errorPage = status >= 500 || status === 405 || (status >= 400 && (says || (short && shows.fields === 0))) || soft;
        // A link to a page that isn't there (after any redirects). Its address is recorded as a pattern,
        // as screens are (/clients/:id, never someone's name or email), and what the page says isn't kept.
        if (linkedFrom && !byOurId(href) && ((status >= 500 && status !== 503) || ((status === 404 || status === 410) && (says || short)) || soft)) {
          addFinding({ kind: "broken_link", screen: linkedFrom, target: here, evidence: soft ? `${status}, but the page says it's missing` : String(status) });
        }
        if (errorPage) {
          result.errorPages.push({ path: here, status });
          continue;
        }
        // The stand-in pass counts only what really drew, and says what stopped the rest by name
        // (the start stays: its links are still the way in, if it has any). A page still drawing
        // gets one more look: a screen that is merely slow isn't a wall.
        let drew: Wall | undefined;
        let values: string[] = [];
        if (seal) {
          const look = () => page.evaluate(readWall, WALL_WORDS).catch((): Wall => ({ kind: "blank", text: "", rows: 0, fields: 0, listed: "" }));
          drew = await look();
          if (drew.kind === "loading" || drew.kind === "blank") {
            await page.waitForTimeout(2000).catch(() => {});
            await settleQuick();
            drew = await look();
          }
          // Values that came for an earlier screen say nothing of this one.
          values = seal.filled > filledBefore ? seal.valuesIn(drew.text) : [];
          const shut = drew.kind ?? (landed && landed !== here && seal.publicScreens.has(landed) ? "sent_away" as const : seal.sameAsSeen(landed ?? here, { ...drew, values }) ? "unclear" as const : undefined);
          if (shut) {
            seal.notReached.push({ path: here, why: shut });
            // A wall of the app's own is what a new person sees here: that's the finding, if there's one.
            if (lookOnly && (shut === "paywall" || shut === "no_access" || shut === "failed")) {
              const path = landed ?? here;
              seal.landed.set(here, path);
              await timed("photo", () => photoAs(path));
              await timed("checks", () => reviewScreen(path, filledBefore, shut));
            }
            continue;
          }
        }
        // An address that only sent this run to the sign-in has a screen behind it, whatever else
        // the crawl saw: it's the first place to look past the sign-in.
        if (walls && landed && landed !== here && !SIGN_IN_PATH.test(here) && (SIGN_IN_PATH.test(landed) || (await page.evaluate(readWall, WALL_WORDS).catch(() => undefined))?.kind === "sign_in")) walls.add(here);
        seal?.landed.set(here, landed ?? here);
        // Where it landed is the screen (a redirect from "/" to "/login" is the sign-in screen), when
        // that's on the site; one already learned isn't learned twice.
        if (landed && landed !== here) {
          if (seenPatterns.has(landed)) continue;
          seenPatterns.add(landed);
        }
        // A start that redirected out of its folder (to a sign-in page, say) widens the folder to
        // what the two share, or nothing would be inside it.
        if (isStart && landedUrl.origin === start.origin && !inScope(landedUrl.pathname, scope)) {
          scope = sharedFolder(scope.endsWith("/") ? scope : `${scope}/`, landedUrl.pathname);
        }
        const shown = landed ?? here;
        result.pagesVisited.push(shown);
        // A page with next to nothing on it says nothing by matching another.
        const words = shows.text.replace(/\s+/g, " ").trim();
        if (words.length >= MIN_DRAWN_WORDS) (result.drawn ??= {})[shown] = createHash("sha256").update(JSON.stringify([words, shows.pictures])).digest("hex").slice(0, 16);
        const named = !config.login && !config.storageState && shown.includes(":") && NAMED_ADDRESS.test(new URL(page.url()).pathname) ? new URL(page.url()).pathname : undefined;
        config.onScreen?.(shown, result.pagesVisited.length, named);
        if (seal && drew) {
          seal.drawn.set(shown, { href: page.url(), text: drew.text, values, heading: drew.heading, rows: drew.rows, fields: drew.fields, listed: drew.listed });
        }
        realAddresses.set(shown, new Set([...(realAddresses.get(shown) ?? []), new URL(page.url()).pathname]));
        if (walls && !SIGN_IN_PATH.test(shown) && (await page.evaluate(readWall, WALL_WORDS).catch(() => undefined))?.kind === "sign_in") walls.add(shown);
        tell();
        keep({ t: ++t, kind: "route", path: shown });
        await timed("read", config.countsOnly ? () => stillNow() : readStructure);
        await timed("load", declineCookies);
        await timed("photo", () => (lookOnly ? photoAs(shown) : photograph()));
        if (!config.countsOnly) await timed("checks", () => reviewScreen(shown, filledBefore));
        await queueLinks(shown);

        const made = await kindOf();
        const kind = `${partOf(shown)}#${made}`;
        const copies = learnedKinds.get(kind) ?? 0;
        learnedKinds.set(kind, copies + 1);
        await timed("checks", () => checkScreen(shown, filledBefore, guessedBefore, copies > 0));
        // Rows that came in late are there by now, and they're what shows this screen drew the app's own data.
        const firstLook = seal?.drawn.get(shown);
        if (seal && firstLook && seal.filled > filledBefore) {
          const now = await page.evaluate(readWall, WALL_WORDS).catch(() => undefined);
          const lateValues = now ? seal.valuesIn(now.text) : [];
          if (now && lateValues.length > firstLook.values.length) seal.drawn.set(shown, { ...firstLook, values: lateValues, listed: now.listed, rows: Math.max(firstLook.rows ?? 0, now.rows) });
        }
        if (hashAt(shown) >= 0) {
          const holder = shown.slice(0, hashAt(shown));
          const views = dullViews.get(holder) ?? { made: new Set<string>(), dull: 0 };
          views.dull = views.made.has(made) ? views.dull + 1 : 0;
          views.made.add(made);
          dullViews.set(holder, views);
          if (views.dull >= DULL_VIEWS) {
            finishedDocuments.add(holder);
            for (let i = queue.length - 1; i >= 0; i--) if (inFinished(screen(queue[i]!.href) ?? "")) queue.splice(i, 1);
          }
        }
        if (copies >= 1) { // made just like a screen already learned: nothing new to press
          if (parentOf(shown)) repeating.add(parentOf(shown));
          continue;
        }
        if (lookOnly || config.looksOnly) continue;

        waiting.push({
          href, shown, controls: await controls(),
          forms: await page.$$eval("form", (els) => els.filter((f) => f.getBoundingClientRect().width > 0).map((f) => `${f.getAttribute("action") ?? ""}|${[...f.querySelectorAll("input, select, textarea")].map((x) => (x as HTMLInputElement).name || x.id || x.tagName).sort().join(",")}`)).catch(() => [] as string[]),
          // Nothing made to be dragged, nothing to load the page afresh for.
          grabbable: await page.$$eval("body *", (els) => els.some((el) => {
            if (el.getAttribute("draggable") === "true" || el.hasAttribute("aria-grabbed")) return true;
            const c = getComputedStyle(el).cursor;
            return c === "grab" || c === "move";
          })).catch(() => true),
        });
      } catch (error) {
        // A link answered with a file (a download) is a file, not a screen, and nothing went wrong.
        if (DOWNLOAD_STARTED.test(message(error))) {
          notPages.add(here);
          if (isStart) result.errors.push("the start address isn't a web page (a file to download)");
        } else if (!overran && !(/ERR_ABORTED/.test(message(error)) && Date.now() - heldHopAt < 2000)) result.errors.push(`${here}: ${message(error)}`);
      }
      if (pause) await page.waitForTimeout(pause).catch(() => {});
    }

    config.measured?.(result);
    if (pagesFull && result.stoppedBy === "complete") result.stoppedBy = "max_pages";
    // Stopped while the last page was being learned: still stopped early, not complete.
    if (interrupted() && result.stoppedBy === "complete") result.stoppedBy = "interrupted";
    moveTo("finishing");
    if (seal && !interrupted()) await timed("signed-out", lookSignedOut).catch(() => {});
    if (stayedAway.size) result.stayedAway = [...stayedAway].sort();
    if (proxiedHeld.size) result.proxiedHeld = [...proxiedHeld].sort();
    if (proxied.includes("*")) result.proxyUnread = true;
    // Under a real account an address can hold someone's name: only a run with none keeps it.
    if (!config.login && !config.storageState) {
      for (const [shown, opened] of realAddresses) {
        const [only] = opened;
        if (opened.size === 1 && only && shown.includes(":") && NAMED_ADDRESS.test(only)) (result.addresses ??= {})[shown] = only;
      }
    }
    // Let in-flight requestfinished handlers settle; closing the browser cancels requests, and that's ours.
    await page.waitForTimeout(50).catch(() => {});
    exploring = false;
    for (const { origin, finding } of maybeFailures) if (answeringApis.has(origin)) addFinding(finding);
    // What the page sends by itself, sorted from what a press explains.
    const ambient = new Map([...writesSeen].flatMap(([key, w]) => {
      const why = ambientWhy(w);
      return why ? [[key, why] as const] : [];
    }));
    const isAmbient = (w: { method: string; path: string; graphqlOperation?: string }) => ambient.has(`${w.method} ${w.path} ${w.graphqlOperation ?? ""}`);
    result.ambientWrites = [...writesSeen].flatMap(([key, w]) => {
      const why = ambient.get(key);
      return why ? [{ method: w.method, path: w.path, ...(w.graphqlOperation ? { graphqlOperation: w.graphqlOperation } : {}), count: w.count, why }] : [];
    });
    result.blockedWrites = result.blockedWrites.filter((w) => !isAmbient(w));
    result.events = result.events.filter((e) => e.kind !== "network" || SAFE_METHODS.has(e.method) || !isAmbient(e));
    for (const save of unreported) if (!isAmbient(save)) keep(save);
    // An error page's or a document's own reading by the snippet (its address, its "page"), unless
    // the same address was also a real screen: it isn't one, and isn't photographed as one.
    const screensSeen = new Set(result.pagesVisited);
    const errorPaths = new Set([...result.errorPages.map((e) => e.path), ...notPages].filter((p) => !screensSeen.has(p)));
    result.events = result.events.filter((e) => !((e.kind === "route" || e.kind === "page" || e.kind === "interaction") && errorPaths.has(withoutView(e.path))));
    result.screens = result.screens.filter((shot) => !errorPaths.has(withoutView(shot.path)));
    if (scope !== "/") result.scope = { path: scope, skipped: skippedOutside.size };
    result.findings = [...issues.values()].sort((a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind) || a.screen.localeCompare(b.screen));
    // A script's crash on what turned out to be no screen isn't the product's.
    result.findings = result.findings.filter((f) => f.kind !== "crashes" || !errorPaths.has(f.screen));
    await context.close();
  } finally {
    clearInterval(ticking);
    clearInterval(heartbeat);
    clearTimeout(watchdog);
    await browser?.close();
  }
  return result;
}

/**
 * The read-only guard. Three rounds of "these words are dangerous" lists were each beaten by the next
 * way of sending the same thing, so the shape is the other way round: what goes out is decided by an
 * allow rule (judge), and what it can't show to be a harmless read is held back and answered here.
 * The word lists below only say what a request is telling us. None of them is what keeps a site safe
 * from a method, a body or a socket the rule has never heard of: those are simply not let through.
 *
 * What this can't prove: a GET with an innocent address, from a control that says nothing, that
 * writes anyway (/x/7/go behind a button labelled "Go") looks exactly like a read from out here.
 * Only the site's server knows. That's why signed-in runs are stricter, and belong on a test account.
 */

/** How long after a press that acts everything but assets is held (long enough for a slow handler). */
const HOLD_MS = 5000;
/** A page that doesn't answer for this long has a stuck main thread: what's running is ended. */
const STUCK_MS = 8000;
/** How far past its time limit a run may go, for a step already under way, before its page is closed. */
const WATCHDOG_MARGIN_MS = 15_000;
/** Marks a worker's script in its address, for the route, which takes it off again (see noLooseSockets). */
const WORKER_MARK = "ctx-stub";

/** A link not followed, or a read not sent (read), and what stopped it. */
export interface HeldBack {
  path: string;
  /**
   * "label": its words or icon say it acts. "command": a command in its address. "token": a CSRF-style
   * key in its address. "uncertain": signed in, and it could go either way. "press": just after a
   * press that said it acts. "redirect": an address it redirected to would have been held. "graphql":
   * an operation that isn't a query, or can't be read.
   */
  why: "label" | "command" | "token" | "uncertain" | "press" | "redirect" | "graphql";
  read?: boolean;
}

/** Everything a request says for itself, for judge. */
export interface Outgoing {
  method: string;
  /** Playwright's resource type: "document", "fetch", "script"… */
  type: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | undefined;
  navigation: boolean;
}

/** What judge needs to know about the run. */
export interface Guard {
  /** False while signing in, which may send its form. */
  crawling: () => boolean;
  /** Whether an origin is the site's own (see apiOrigin). */
  own: (origin: string) => boolean;
  /** Whether a press that acts was just made (see heldUntil). */
  holding: () => boolean;
  /** Whether a press that adds or buys came after the typing (see pressAdds). */
  pressedToAdd?: () => boolean;
  typed: Set<string>;
  signedIn: boolean;
  realWrites: boolean;
  startHref: string;
}

export type Verdict =
  | { act: "pass" }
  /** A write to someone else's host: dropped. */
  | { act: "refuse" }
  /** A read that might act: not sent, answered here. */
  | { act: "hold"; why: HeldBack["why"] }
  /** A save: not sent, recorded as one, answered here. */
  | { act: "stop" };

/** What a control says about itself: its words, the pop-up around it, and its code's marks (classes, icons, handlers). */
export interface Saying {
  text: string;
  around: string;
  marks: string;
}

/** Commands whatever else they might be, first or last in a part of an address: delete-invoice, /invoices/7/delete. */
const VERBS = new Set("delete remove destroy erase purge wipe discard approve reject publish unpublish unlike unfollow unsubscribe accept decline logout logoff signout revoke deactivate cancel unblock unban abmelden ausloggen loeschen löschen entfernen kuendigen kündigen supprimer deconnexion déconnexion eliminar borrar elimina verwijderen uitloggen excluir".split(" "));
/** Commands that also name things, so only their place says which: /posts/5/like, /vote?id=1, /follow/42, but not /likes. */
const ACTIONS = new Set("vote upvote downvote like fave favorite favourite star follow hide flag subscribe block ban".split(" "));
/** Commands that also name a listing or a page, so they never count as a query key or before an id: /archive/2019, ?report=weekly. */
const LISTINGS = new Set("archive trash report confirm reset clear empty drop truncate del rm".split(" "));
/** Commands when they're followed by what they act on: reset-data, clear-cache (see aboutPassword for reset-password). */
const OBJECT_VERBS = new Set("reset clear empty truncate drop".split(" "));
/** What says a write destroys something, anywhere in it (--create), and in a control's words. */
const DESTROY_WORDS = new Set("delete deletion remove removal destroy erase purge wipe trash discard unsubscribe deactivate revoke archive clear empty truncate drop löschen loeschen entfernen supprimer eliminar borrar elimina verwijderen excluir".split(" "));
/** The same said by a control's code: an icon's class, a button's id. Words like "clear" and "drop" are layout there. */
const MARK_WORDS = new Set("delete remove destroy erase trash bin danger destructive".split(" "));
/** A control's first word that says it sends something out of the app, whatever follows: "Remind them". */
const SEND_WORDS = new Set("notify remind reinvite".split(" "));
/**
 * A first word that sends only when the rest says to whom or what goes out ("Email everyone", "Send
 * reminders"): alone it's a tab, a single invite or a form's own button ("Send", "Send report").
 */
const MAIL_WORDS = new Set("send resend email invite message".split(" "));
const RECIPIENTS = new Set("everyone everybody all members users customers team them clients subscribers reminder reminders invite invites invitation invitations newsletter campaign blast broadcast".split(" "));
/** Words before the verb that change nothing ("Yes, delete it"). */
const POLITE = new Set("yes ok okay please really permanently".split(" "));
/** "Close" alone is a pop-up's way out: only these say it of an account, whole, in a control's words or a part of an address. */
const CLOSE_ACCOUNT = /^close (?:my )?account$/;
const ACCOUNT_CLOSE = /account\/close(?:[/.;]|$)/i;
const LISTS = "cart|basket|trolley|wish ?list";
const LIST_VERBS = "add|update|change|remove|delete|clear|empty";
const BEFORE_LIST = "(?: ?(?:item|items|product))?";
/**
 * A cart-like list being changed, said by one part of an address: add_to_cart, add-to-basket, updateCart, cart-add.
 * "Bag" only with its "to": /add-bag is a plain create page in a shop for bags, as /add-client is. So are /clients/add and /posts/new.
 */
const LIST_CHANGE = new RegExp(`^(?:(?:${LIST_VERBS})${BEFORE_LIST}(?: ?(?:to|into|from|2))?(?: ?(?:my|the))? ?(?:${LISTS})|(?:add|remove)${BEFORE_LIST} ?(?:to|into|from|2)(?: ?(?:my|the))? ?bag|(?:${LISTS}|bag) ?(?:${LIST_VERBS}))$`);
/** The same said by two: /cart/add/5, /wishlist/add, /shopping-cart/update. */
const LIST_PART = new RegExp(`(?:^| )(?:${LISTS}|bag)$`);
const LIST_VERB = new RegExp(`^(?:${LIST_VERBS})$`, "i");
/** Query keys of a listing: a noun like /archive with only these is that listing, not a command. */
const READ_KEY = /^(page|p|per_?page|limit|offset|sort|order|q|query|s|search|filter|tag|category|cat|lang|locale|year|month|week|day|date|from|to|view|tab|ref|fbclid|gclid|utm_\w+)$/i;
/** The keys a server signs a state-changing link with, the well-known GET-with-token pattern. */
const TOKEN_KEY = /^(_?csrf(_?token)?|csrfmiddlewaretoken|_?xsrf(_?token)?|_?token|authenticity_token|_?nonce|_?wpnonce|sig|signature|auth)$/i;
/** Keys whose value says what to do (WordPress's action=trash, Rails's _method=delete). */
const ACTION_KEY = /^(_?action|_?method|do|op|cmd|command|task)$/i;
/** A link that says where to go back to once done has something to be done first. Too common to act on when signed out. */
const RETURN_KEY = /^(goto|return|return_?to|back|redirect|redirect_?(to|uri|url)|continue|next)$/i;
/** Field names of a search box, and their query keys. */
const SEARCH_KEY = /^(q|query|s|search)$/i;
/** Resource types that can't be the point of a press, and that a page can't draw without. */
const ASSET_TYPES = new Set(["script", "stylesheet", "image", "font", "media"]);
const LOOKS_LIKE_ID = /^(\d+|[0-9a-f-]{8,}|[a-z0-9_-]*\d[a-z0-9_-]{5,})$/i;

/**
 * A press that says it adds or buys: what makes a number under a how-many key a save. Anything else
 * ("Get a quote", or the box being filled in) is asking what that many would come to.
 */
export const pressAdds = (label: string | undefined) => /\b(add|buy|order|basket|cart|bag)\b/i.test(label ?? "");
/** How many of a thing a press acts on, and no bound of a filter: quantity, item_qty, not min_qty. */
const howMany = (key: string) => {
  const words = wordsIn(key);
  return /^(?:qty|quantity)$/.test(words.at(-1) ?? "") && !words.some((w) => /^(?:min|max|from|to)$/.test(w));
};
/** Whole words: split on anything that isn't a letter or digit, and on camelCase humps, in lower case. */
const wordsIn = (text: string) => text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** log-out, signOut, sign_off: two words, whatever joins them. */
const signsOut = (words: string[]) => words.some((w, i) => (w === "log" || w === "sign") && (words[i + 1] === "out" || words[i + 1] === "off"));
/** mark-read, markAllAsRead. */
const marksRead = (words: string[]) => words[0] === "mark" && words.some((w) => /^(read|unread|seen|done|complete)$/.test(w));

/** The parts of an address that say something: its path and hash route, without extensions, matrix values or /api/v1. */
function addressParts(url: URL): string[] {
  const hashRoute = /^#!?\//.test(url.hash) ? url.hash.replace(/^#!?/, "").split("?")[0]! : "";
  return decoded(url.pathname + hashRoute).split("/").map((part) => part.replace(/;.*$/, "").replace(/\.[a-z0-9]{1,6}$/i, "")).filter((part) => part && !/^(api|rest|v\d+)$/i.test(part));
}

/** Whether an address changes a cart, a basket or a wishlist: a site's GET can do that (see judge). Reading one is /cart, and /cart/5. */
function changesList(url: URL): boolean {
  const said = addressParts(url).map((part) => wordsIn(part).join(" "));
  const inList = said.some((part) => LIST_PART.test(part));
  if (said.some((part, i) => LIST_CHANGE.test(part) || (LIST_VERB.test(part) && said.slice(0, i).some((before) => LIST_PART.test(before))))) return true;
  return [...url.searchParams].some(([key, value]) => LIST_CHANGE.test(wordsIn(key).join(" ")) || (ACTION_KEY.test(key) && (LIST_CHANGE.test(wordsIn(value).join(" ")) || (inList && LIST_VERB.test(value)))));
}

/**
 * Whether an address commands something, from where its words sit: a word's whole part of the path,
 * or its first or last word, or a query key. Never part of a word, so /catalog-outlet and
 * /design-outline are safe, and never a query value (status=removed), but for the keys that hold
 * an action. Signed in (strict), what could go either way counts too.
 */
export function commandIn(url: URL, strict = false): "command" | "token" | "uncertain" | undefined {
  const parts = addressParts(url);
  const said = parts.map(wordsIn);
  const aboutPassword = said.flat().some((w) => /^pass(word|wd)?$/.test(w));
  const listing = [...url.searchParams.keys()].every((key) => READ_KEY.test(key));
  for (const [i, words] of said.entries()) {
    const first = words[0];
    if (first === undefined) continue;
    if (signsOut(words) || marksRead(words) || CLOSE_ACCOUNT.test(words.join(" ")) || VERBS.has(first) || VERBS.has(words.at(-1)!)) return "command";
    if (words.length > 1) {
      if (OBJECT_VERBS.has(first) && !aboutPassword) return "command";
      continue;
    }
    if (!ACTIONS.has(first) && !LISTINGS.has(first)) continue;
    if (first === "reset" && aboutPassword) continue;
    const isLast = i === parts.length - 1;
    const acts = isLast ? parts.length >= 3 || LOOKS_LIKE_ID.test(parts[i - 1] ?? "") || !listing || (parts.length === 2 && OBJECT_VERBS.has(first)) : i === parts.length - 2 && ACTIONS.has(first) && LOOKS_LIKE_ID.test(parts[i + 1]!);
    if (acts) return "command";
    if (strict) return "uncertain";
  }
  for (const [key, value] of url.searchParams) {
    if (TOKEN_KEY.test(key)) return "token";
    const words = wordsIn(key);
    const first = words[0] ?? "";
    if ((VERBS.has(first) && words.at(-1) !== "url") || (words.length === 1 && ACTIONS.has(first))) return "command";
    if (ACTION_KEY.test(key) && wordsIn(value).some((w) => VERBS.has(w) || ACTIONS.has(w) || LISTINGS.has(w))) return "command";
    if (strict && RETURN_KEY.test(key)) return "uncertain";
  }
  return ACCOUNT_CLOSE.test(parts.join("/")) || changesList(url) ? "command" : undefined;
}

/** The command a control's words open or end with ("Delete", "Konto löschen", "Yes, delete it"), if any. */
function labelVerb(text: string): string | undefined {
  const words = wordsIn(text).filter((w) => !POLITE.has(w));
  const first = words[0];
  if (first === undefined) return undefined;
  if (signsOut(words.slice(0, 3))) return "logout";
  if (marksRead(words) || /^move to (the )?(trash|bin|archive)/.test(words.join(" "))) return "mark";
  if (first === "cancel" && words.length === 1) return undefined; // a pop-up's way out
  if (CLOSE_ACCOUNT.test(words.join(" "))) return "close";
  if (first === "reset" && words.some((w) => /^pass(word|wd)?$/.test(w))) return undefined;
  if (VERBS.has(first) || ACTIONS.has(first) || LISTINGS.has(first)) return first;
  return VERBS.has(words.at(-1)!) ? words.at(-1) : undefined;
}

/** Whether anywhere in some text something says it destroys. */
export function saysDestroys(text: string): boolean {
  const words = wordsIn(text);
  return words.some((w, i) => DESTROY_WORDS.has(w) || (w === "close" && (words[i + 1] === "account" || (words[i + 1] === "my" && words[i + 2] === "account"))));
}

/** Whether a control, by any of its words or marks, says it destroys. */
export function controlDestroys(says: Saying): boolean {
  return saysDestroys(`${says.text} ${says.around}`) || wordsIn(says.marks).some((w) => MARK_WORDS.has(w));
}

/** Whether a control says it does something a read mustn't: destroys, signs out, sends, or commands. */
export function saysActs(says: Saying): boolean {
  return labelVerb(says.text) !== undefined || controlDestroys(says) || saysSends(says.text);
}

/** Whether a control's words say it sends: a sending verb first, or mail and who it goes to (see SEND_WORDS). */
function saysSends(text: string): boolean {
  const [first = "", ...rest] = wordsIn(text).join(" ").replace(/\be mail\b/g, "email").split(" ").filter((w) => !POLITE.has(w));
  return SEND_WORDS.has(first) || (MAIL_WORDS.has(first) && rest.some((w) => RECIPIENTS.has(w)));
}

/**
 * Why a link on the site is not to be followed, if it isn't: its address commands, or its words do
 * whatever its address. A word that also names a page counts only away from that page: "Follow"
 * leading to /follow is that page, "Follow" leading to /users/alice/go is the command.
 */
export function linkActs(url: URL, says: Saying | undefined, strict = false): HeldBack["why"] | undefined {
  const address = commandIn(url, strict);
  if (address) return address;
  if (!says) return undefined;
  const verb = labelVerb(says.text);
  const named = verb !== undefined && LISTINGS.has(verb) && wordsIn(says.text).length === 1; // a menu's "Archive" is a page
  if (verb && !named && (VERBS.has(verb) || verb === "logout" || verb === "mark" || verb === "close" || !wordsIn(decoded(url.pathname + url.hash)).some((w) => w.startsWith(verb)))) return "label";
  if (wordsIn(says.marks).some((w) => MARK_WORDS.has(w))) return "label";
  if (strict && (verb || wordsIn(says.text).some((w) => VERBS.has(w) || ACTIONS.has(w)))) return "uncertain";
  return undefined;
}

/**
 * Whether a request carries a value the learner typed: then it's a save, whatever its method (a
 * form with no method, a mailing list's JSONP), and never sent. Long values anywhere in it; short
 * ones only as a whole query value, or "Test" and "10" would match half the web. A search key is
 * left out. A short number says nothing under most keys (page=10, limit=10, min_price=10): only as
 * how many, after a press that adds or buys, since a quote sends the same.
 */
export function carriesTyped(url: URL, body: string | undefined, typed: Set<string>, added = false): boolean {
  if (typed.size === 0) return false;
  const address = decoded(url.pathname + url.search).replace(/\+/g, " ");
  const values = [...url.searchParams].filter(([key]) => !SEARCH_KEY.test(key)).map(([, value]) => value);
  return [...typed].some((value) => {
    if (/^\d{1,4}$/.test(value)) return added && [...url.searchParams].some(([key, sent]) => sent === value && howMany(key));
    const needle = value.replace(/^\+/, ""); // a "+" in an address may arrive as a space
    return value.length >= 6 ? address.includes(needle) || (body?.includes(needle) ?? false) : values.includes(value);
  });
}

/** A body read as text: percent-encoded forms decoded, and a false flag ({"_destroy":false}) saying nothing. */
function bodyText(body: string): string {
  const text = body.slice(0, 256 * 1024).replace(/\+/g, " ").replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => decoded(encoded));
  return text.replace(/["']?[\w[\]-]*(?:destroy|delete|remove|discard|purge|trash|archive)[\w[\]-]*["']?\s*[:=]\s*["']?(?:false|0|null|no)?["']?(?=[\s,&}\]]|$)/gi, " ");
}

/**
 * Whether a write says anywhere that it destroys: the DELETE method, its path and query, a method
 * override in a header, or its body read as text (a form, JSON, multipart, raw GraphQL, so key names
 * and every value count), a soft delete (deleted: true) included.
 */
function writeDestroys(r: Outgoing): boolean {
  return r.method === "DELETE" || saysDestroys(decoded(r.url.pathname + r.url.search)) || ACCOUNT_CLOSE.test(decoded(r.url.pathname)) || messageDestroys(r);
}

/** The same for what a request carries beyond its address, for a read as well as a write. */
function messageDestroys(r: Outgoing): boolean {
  if (Object.entries(r.headers).some(([name, value]) => /^x-.*(method|action|operation)/i.test(name) && saysDestroys(value))) return true;
  if (r.body === undefined) return false;
  const text = bodyText(r.body);
  return saysDestroys(text) || /\b(?:is_?)?deleted["']?\s*[:=]\s*["']?(?:true|1)\b/i.test(text);
}

/**
 * The one rule: every request, redirect hops included, comes through here. A value the learner typed
 * makes it a save on the site's own hosts (it goes to no one else's), and so does a read's address that changes a cart. A press that acts holds everything but files. Past that, an asset always passes
 * (its name is nobody's command: DeleteDialog-9f8e7d.js is a chunk), someone else's read passes,
 * the site's own read passes only if nothing in it says it acts, and a write passes only if it's
 * shown to be a GraphQL read, or --create allows it and nothing in it says it destroys.
 */
export function judge(r: Outgoing, g: Guard): Verdict {
  const own = g.own(r.url.origin);
  const read = SAFE_METHODS.has(r.method);
  if (!g.crawling()) return read || own ? { act: "pass" } : { act: "refuse" };
  const asset = ASSET_TYPES.has(r.type);
  if (carriesTyped(r.url, r.body, g.typed, g.pressedToAdd?.()) && !(g.realWrites && own)) return own ? { act: "stop" } : { act: "refuse" };
  // The start was asked for by name, on whichever of the site's addresses it lands (apex to www).
  const start = new URL(g.startHref);
  const isStart = r.url.pathname === start.pathname && r.url.search === start.search;
  // A file's name is nobody's command: /js/add-to-cart.js is a script. A cart changed by a GET is a save, wherever it's sent from.
  if (read && own && !asset && !isStart && changesList(r.url)) return { act: "stop" };
  // An "image" with no file name may be a beacon doing what the press meant (new Image().src = "/rm/7").
  if (g.holding() && (!asset || !/\.[a-z0-9]{1,8}$/i.test(r.url.pathname))) return read ? { act: "hold", why: "press" } : own ? { act: "stop" } : { act: "refuse" };
  if (read) {
    if (asset || !own || isStart) return { act: "pass" };
    if (graphqlGetActs(r.url)) return { act: "hold", why: "graphql" };
    const why = messageDestroys(r) ? "command" : commandIn(r.url, g.signedIn);
    return why ? { act: "hold", why } : { act: "pass" };
  }
  if (!own) return { act: "refuse" };
  if (onlyGraphqlReads(r.body, r.headers["content-type"])) return { act: "pass" };
  return g.realWrites && !writeDestroys(r) ? { act: "pass" } : { act: "stop" };
}

/** What a document calls itself: its title and first heading, as sent. */
function documentName(html: string): string {
  const inner = (tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html)?.[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() ?? "";
  return `${inner("title")}|${inner("h1")}`.replace(/^\|$/, "");
}

/** A pop-up's first page load has no frame to show for it yet, and it's never the main page. */
function isPopUp(request: Request, main: Page | undefined): boolean {
  try {
    return request.frame().page() !== main;
  } catch {
    return true;
  }
}

/** What a GraphQL read is known by, to tell it from a mutation sent to the same address. */
const graphqlRead = (path: string, operation: string | undefined) => `${path} ${operation ?? ""}`;

/** The GraphQL operations a request body carries: one, or a batch of them (Apollo, Relay). */
function graphqlOperations(body: string | undefined): { query?: string; name: string }[] {
  if (!body) return [];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  return (Array.isArray(json) ? json : [json]).flatMap((op) => {
    if (!op || typeof op !== "object") return [];
    const o = op as { query?: unknown; operationName?: unknown };
    if (typeof o.query !== "string" && typeof o.operationName !== "string") return [];
    return [{ ...(typeof o.query === "string" ? { query: o.query } : {}), name: typeof o.operationName === "string" ? o.operationName : "" }];
  });
}

/**
 * The kind of each operation a GraphQL document defines ("query", "mutation", "subscription"),
 * wherever it sits: after a fragment or a comment as well as first. Strings and comments are left
 * out, and so is everything inside braces and brackets (fields, arguments, default values).
 */
function operationKinds(query: string): string[] {
  const text = query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, " ");
  const kinds: string[] = [];
  let depth = 0;
  for (const [token] of text.matchAll(/[{}()]|[A-Za-z_]\w*/g)) {
    if (token === "{" || token === "(") depth++;
    else if (token === "}" || token === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /^(query|mutation|subscription)$/.test(token)) kinds.push(token);
  }
  if (/^\s*\{/.test(text)) kinds.push("query"); // the shorthand "{ invoices { id } }"
  return kinds;
}

/** A GraphQL document that can be read, and does nothing but query. A persisted id or an empty text can't be. */
function readableQuery(query: string | undefined): boolean {
  if (!query?.includes("{")) return false;
  const kinds = operationKinds(query);
  return kinds.length > 0 && kinds.every((kind) => kind === "query");
}

/** Whether a POST is GraphQL and every operation in it, named or not, batched or not, is a readable query. */
function onlyGraphqlReads(body: string | undefined, contentType: string | undefined): boolean {
  if (/graphql/i.test(contentType ?? "") && !/json/i.test(contentType ?? "")) return readableQuery(body);
  const operations = graphqlOperations(body);
  return operations.length > 0 && operations.every((op) => readableQuery(op.query));
}

/** Whether a GET is a GraphQL request that isn't a readable query. A search for "query=shoes" isn't GraphQL at all. */
function graphqlGetActs(url: URL): boolean {
  const query = url.searchParams.get("query");
  if (query?.includes("{") && operationKinds(query).some((kind) => kind !== "query")) return true;
  const asks = query !== null || url.searchParams.has("operationName") || url.searchParams.has("extensions");
  return asks && /(^|\/)(graphql|gql)(\/|$)/i.test(url.pathname) && !readableQuery(query ?? undefined);
}

/** Read-only verbs that open an RPC method's name (getBalance, list). Not "query": its statement can say anything. */
const READ_VERB = /^(get|list|fetch|find|search|read|load|lookup|count|describe|watch|subscribe|unsubscribe|ping|pong|heartbeat|status|info|version)$/i;

/**
 * Whether an RPC method only reads, from its whole name: its last part (invoices.list, eth_getBalance)
 * opens with a read verb and goes on to name nothing else it does (getAndClear, findAndModify).
 */
function rpcReads(method: string): boolean {
  const words = wordsIn(method.split(/[./:_]/).pop()!);
  return words[0] !== undefined && READ_VERB.test(words[0]) && !words.slice(1).some((w) => /^(and|or|then|with)$/.test(w) || VERBS.has(w) || LISTINGS.has(w) || ACTIONS.has(w));
}

/**
 * Whether an outgoing message on a live connection is, exactly, one of the upkeep or read messages of
 * a protocol in wide use: every key and every value in its place, so nothing can ride along. Socket.IO
 * and Engine.IO's own packets, STOMP's control frames, Firebase, DDP, graphql-ws and
 * subscriptions-transport-ws, ActionCable, Phoenix, Pusher, JSON-RPC methods that read by their
 * whole name, and the plain ping and subscribe most hand-written sockets use. Nothing else is:
 * while learning, it's held back.
 */
export function socketUpkeep(text: string): boolean {
  // Engine.IO's ping, pong, upgrade and noop; Socket.IO's connect and disconnect (with a namespace or a token); Firebase's keepalive.
  if (/^(?:0|[23](?:probe)?|[56]|4[01](?:\/[^,{]*,?)?(?:\{.*\})?)$/s.test(text)) return true;
  // STOMP's frames that send nothing, with headers and no body. Not ACK: it consumes what it names.
  if (/^(?:CONNECT|STOMP|SUBSCRIBE|UNSUBSCRIBE|DISCONNECT)\r?\n(?:[^\r\n:]+:[^\r\n]*\r?\n)*\r?\n?\0?$/.test(text) || /^[\r\n]*$/.test(text)) return true;
  if (/^(?:ping|pong|heartbeat|keepalive|hb)$/i.test(text.trim())) return true;
  const event = /^42(?:\/[^,[]*,)?\d*(\[.*\])$/s.exec(text);
  let json: unknown;
  try {
    json = text.length <= 64 * 1024 ? JSON.parse(event ? event[1]! : text) : undefined;
  } catch {
    return false;
  }
  if (event) return Array.isArray(json) && /^(ping|pong|heartbeat|keepalive|subscribe|unsubscribe)$/.test(String(json[0])) && !saysDestroys(text);
  // Phoenix: [join_ref, ref, topic, event, payload], and a LiveView form's validate, which saves nothing.
  if (Array.isArray(json)) {
    if (json.length !== 5 || typeof json[3] !== "string") return false;
    const payload = json[4] as { type?: unknown; event?: unknown } | null;
    return /^(phx_join|phx_leave|heartbeat)$/.test(json[3]) || (json[3] === "event" && payload?.type === "form" && payload.event === "validate");
  }
  if (!json || typeof json !== "object") return false;
  const o = json as Record<string, unknown>;
  const only = (keys: string) => Object.keys(o).every((key) => keys.split(" ").includes(key));
  if (typeof o.msg === "string") { // DDP
    if (o.msg === "connect") return only("msg version support session");
    if (o.msg === "sub") return only("msg id name params");
    return /^(ping|pong|unsub)$/.test(o.msg) && only("msg id");
  }
  if (typeof o.jsonrpc === "string" || (typeof o.method === "string" && "params" in o && "id" in o)) {
    return typeof o.method === "string" && only("jsonrpc method params id") && rpcReads(o.method) && !saysDestroys(JSON.stringify(o.params ?? ""));
  }
  if (typeof o.command === "string") return /^(subscribe|unsubscribe)$/.test(o.command) && only("command identifier"); // ActionCable
  if (o.t === "c" || o.t === "d") { // Firebase: its control pings; a listen, a stop, stats, a sign-in
    const d = o.d as Record<string, unknown> | null;
    if (!only("t d") || !d || typeof d !== "object") return false;
    if (o.t === "c") return (d.t === "p" || d.t === "o") && Object.keys(d).every((key) => key === "t" || key === "d");
    const body = Object.keys((d.b ?? {}) as object);
    const keys = { q: "p h q t", n: "p h q t", s: "c", auth: "cred", gauth: "cred", unauth: "" }[String(d.a)];
    return keys !== undefined && Object.keys(d).every((key) => key === "r" || key === "a" || key === "b") && body.every((key) => keys.split(" ").includes(key));
  }
  if (typeof o.event === "string" && /^pusher:(ping|pong|subscribe|unsubscribe)$/.test(o.event)) return only("event data channel");
  if (typeof o.event === "string" && "topic" in o) return /^(phx_join|phx_leave|heartbeat)$/.test(o.event) && only("topic event payload ref join_ref"); // Phoenix's older form
  // graphql-ws and subscriptions-transport-ws, and only with their own keys: a "complete" with a taskId is an app's.
  if (o.type === "connection_init") return only("type payload");
  if (o.type === "connection_terminate" || o.type === "ka") return only("type");
  if (o.type === "complete" || o.type === "stop") return only("id type") && o.id !== undefined;
  if ((o.type === "subscribe" || o.type === "start") && "payload" in o) {
    const query = (o.payload as { query?: unknown } | null)?.query;
    if (!only("id type payload") || typeof query !== "string" || !query.includes("{")) return false;
    const kinds = operationKinds(query);
    return kinds.length > 0 && kinds.every((kind) => kind === "query" || kind === "subscription");
  }
  // The plain ping and subscribe of a hand-written socket: one name, and nothing else that could say anything.
  const names = [o.type, o.event, o.action, o.op].filter((name) => name !== undefined);
  if (names.length !== 1 || typeof names[0] !== "string" || !only("type event action op id ts timestamp time channel channels topic topics room stream streams")) return false;
  return /^(ping|pong|heartbeat|keepalive|subscribe|unsubscribe)$/i.test(names[0]) && !saysDestroys(text);
}

/**
 * Runs before anything else in every page and every worker: no connection may exist that can't be
 * filtered. WebSockets are filtered by context.routeWebSocket, which only reaches pages, so a worker
 * gets one that never connects, and fails as it would on a network that blocks them. SharedWorker's
 * requests never pass the route at all, so it's taken away with WebTransport, WebSocketStream and
 * WebRTC (a data channel sends anything): a page falls back to what it does in a browser without
 * them. Every new worker is started with this same code ahead of its script. A file's script gets
 * it from the route (the mark in its address says so, see startWithoutSockets), which keeps the
 * worker's own address for its relative imports; a blob's or a data address's is read and rewritten here.
 */
function noLooseSockets() {
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of ["SharedWorker", "WebTransport", "WebSocketStream", "RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try {
      delete scope[name];
    } catch {
      // not deletable here: covered below
    }
    if (typeof scope[name] !== "undefined") Object.defineProperty(scope, name, { value: undefined, configurable: true, writable: true });
  }
  if (typeof document === "undefined") {
    class ClosedSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      url: string;
      protocol = "";
      extensions = "";
      bufferedAmount = 0;
      binaryType = "blob";
      onopen: unknown = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      onclose: unknown = null;
      constructor(url: string) {
        super();
        this.url = String(url);
        setTimeout(() => {
          this.readyState = 3;
          for (const event of [new Event("error"), new CloseEvent("close", { code: 1006 })]) {
            this.dispatchEvent(event);
            (this[`on${event.type}` as "onerror"] as ((e: Event) => void) | null)?.(event);
          }
        });
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    scope.WebSocket = ClosedSocket;
  }
  const RealWorker = scope.Worker as (new (url: string | URL, options?: WorkerOptions) => Worker) | undefined;
  if (!RealWorker) return;
  const source = `(${noLooseSockets})();\n`;
  const guarded = (given: string | URL, options?: WorkerOptions) => {
    const url = new URL(String(given), location.href);
    const module = options?.type === "module";
    if (url.protocol === "blob:" || url.protocol === "data:") {
      const read = new XMLHttpRequest();
      read.open("GET", url.href, false);
      read.send();
      // A module's imports run before its first line, so what must come first is an import itself.
      const first = module ? `import "data:text/javascript,${encodeURIComponent(source)}";\n` : source;
      return URL.createObjectURL(new Blob([first + read.responseText], { type: "text/javascript" }));
    }
    url.searchParams.set("ctx-stub", module ? "module" : "classic");
    return url.href;
  };
  scope.Worker = class Worker extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(guarded(url, options), options);
    }
  };
}

/** The seal's reply as the browser needs it: from another host, it must say the page may read it. */
function sealedFulfill(reply: Reply, from: string | undefined, origin: string) {
  const cors: Record<string, string> = from && from !== origin ? { "access-control-allow-origin": from, "access-control-allow-credentials": "true", vary: "Origin" } : {};
  return { status: reply.status, ...(reply.body !== undefined ? { body: reply.body } : {}), ...(reply.contentType ? { contentType: reply.contentType } : {}), headers: { ...reply.headers, ...cors } };
}

/** What must run ahead of a worker's script (see noLooseSockets). */
function withoutSockets(script: string, module: boolean): string {
  const source = `(${noLooseSockets})();\n`;
  return (module ? `import "data:text/javascript,${encodeURIComponent(source)}";\n` : source) + script;
}

/** An address as the app wrote it, without the mark the page's script put on it. */
function withoutMark(url: URL): URL {
  const plain = new URL(url);
  plain.searchParams.delete(WORKER_MARK);
  return plain;
}

/** A worker's script, fetched and given what must run ahead of it (see noLooseSockets). Unfetched, there's no worker. */
async function startWithoutSockets(route: Route, url: URL): Promise<void> {
  try {
    const module = url.searchParams.get(WORKER_MARK) === "module";
    const response = await route.fetch({ url: withoutMark(url).href });
    const { "content-security-policy": _policy, "content-length": _length, "content-encoding": _encoding, ...headers } = response.headers();
    await route.fulfill({ response, headers, body: withoutSockets(await response.text(), module) });
  } catch {
    await route.abort("blockedbyclient").catch(() => {});
  }
}

/**
 * Runs in the page before anything else: how a control says what it does, for the learner to read
 * before pressing it. An icon-only bin has no words, only a title, a class or a drawing's name.
 */
function readControls() {
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const says = (el: Element) => {
    const b = el as HTMLButtonElement;
    const parts = [...el.querySelectorAll("i, svg, use, span, img")].slice(0, 12);
    return {
      text: clean([el.getAttribute("aria-label"), b.innerText, b.value, b.title, ...parts.map((p) => p.getAttribute("alt") ?? p.querySelector?.("title")?.textContent)].filter(Boolean).join(" ")).slice(0, 200),
      around: clean(el.closest("dialog, [role=dialog], [role=alertdialog]")?.textContent).slice(0, 400),
      marks: clean([
        ...["class", "id", "name", "data-action", "data-method", "data-turbo-method", "onclick", "formaction"].map((a) => el.getAttribute(a)),
        b.form?.getAttribute("action"), b.form?.querySelector<HTMLInputElement>("[name=_method]")?.value,
        ...parts.flatMap((p) => ["class", "href", "xlink:href", "data-icon", "data-lucide", "src"].map((a) => p.getAttribute(a))),
      ].filter(Boolean).join(" ")).slice(0, 800),
    };
  };
  const searchBox = (el: Element) => {
    const f = el as HTMLInputElement;
    return f.type === "search" || /^(q|query|s|search)$/i.test(f.name) || f.closest("[role=search]") !== null || /search/i.test(f.form?.getAttribute("action") ?? "");
  };
  Object.defineProperty(window, "__ctxRead", { value: { says, searchBox } });
}

/** Runs in the page: a file picker opens nothing, and says it was asked for (see Drive). */
function refuseFilePickers() {
  const scope = window as unknown as Record<string, unknown> & { __ctxFilePicker?: () => void };
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    if (typeof scope[name] !== "function") continue;
    scope[name] = () => {
      scope.__ctxFilePicker?.();
      return Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
    };
  }
}

/**
 * The browser, with its sandbox on: sites run in it. Only where the sandbox can't start (a container
 * without user namespaces, running as root) does it go without, and says so once. Signals are the
 * command's to handle: Playwright's own handlers would close the browser under a run still writing.
 */
async function launchBrowser(args: string[] = []): Promise<Browser> {
  const signals = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args };
  let sandboxed: Browser | undefined;
  try {
    sandboxed = await chromium.launch({ ...signals, chromiumSandbox: true });
    // Some systems let it start and kill it at its first page.
    await (await sandboxed.newPage()).close();
    return sandboxed;
  } catch {
    await sandboxed?.close().catch(() => {});
    const browser = await chromium.launch({ ...signals, chromiumSandbox: false });
    console.warn("Warning: the browser's sandbox couldn't start here, so sites run without it. Only learn sites you trust from this machine.");
    return browser;
  }
}

function message(error: unknown): string {
  return withoutTokens((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "").slice(0, 200) || "error";
}
