import { ASKS_TO_PAY, FIRST_RUN_PATH, MADE_UP_LINE, SIGN_UP_PATH, type ScreenReview } from "./checks.ts";
import { controlDestroys, RISKY_BUTTON, type Saying } from "./scan.ts";
import { SIGN_IN_PATH, type Trail, type TrailKind, type Wall } from "./stand-in.ts";

/**
 * Journeys: the funnels and processes of an app, walked to their end as far as a browser with nothing
 * real behind it can. One sealed browser, as a made-up new account, presses through sign-up's
 * aftermath, onboarding, the main action and whatever else a new person is offered. Every save is
 * answered in the browser and kept (see Seal.keepSaves), so the screens move on as if it had worked.
 *
 * What that shows: where a path goes, how long it is, what stands in it. What it can't: anything that
 * follows from an answer, since all of them are this run's. So nothing here is ever a finding or a
 * check. A walk that ends on an error says the walk couldn't follow it, "finished" says the screens
 * moved on and no more, and what would touch the outside world is "stopped here": never pressed, or
 * caught on the trail the moment a press tried it, and never passed.
 *
 * The parts here are plain: what's a stop, whether a press moved anything on, what to do next, what
 * the journeys are, and how each came out. The browser's side is the Drive (see crawlSite's `walk`).
 */

/** The most time all journeys get, from when they start. */
export const JOURNEYS_MOST_MS = 150_000;
/** What they're given when the rest of a run ends early: the only way they can add to a run. */
export const JOURNEYS_LEAST_MS = 30_000;
/** One journey's time, and the main journey's or the first run's. */
const JOURNEY_MOST_MS = 25_000;
const MAIN_JOURNEY_MOST_MS = 60_000;
/** Journeys walked in one run. Everything found is listed, walked or not. Time (JOURNEYS_MOST_MS) is what ends most walks: this is for an app with no end of them. */
const MOST_JOURNEYS = 40;
/** Steps in one journey, and in the main journey or the first run. */
const STEPS_MOST = 12;
const MAIN_STEPS_MOST = 20;
/** Other choices of one choice taken from a group, each walked as a journey of its own: every other one of a few (see MOST_GROUP), and one beside them. */
const BRANCHES_MOST = 4;
/** Steps a stop can come after a choice and still be that choice's doing. */
const STEPS_FROM_CHOICE = 2;
/** Second looks at a flow with nothing to do yet, each as long as a press gets, while each sees something new. */
const LOOKS_FOR_MORE = 3;
/** More choices than this are a catalogue: one stands for the rest. */
const MOST_GROUP = 4;
/** Screens opened only to look, in the session the main journey left. */
const MOST_LOOKS = 16;
/** How long the looks wait for a main journey that saved, before making do with whatever saved. */
const TOUR_BY_MS = 100_000;
/** Steps that moved on, in a journey that saved, for its session to be worth looking at. */
const MOVES_TO_LOOK = 2;
/** Times the looks are taken, each on the session of one journey that saved. */
const MOST_TOURS = 2;
/** How long a press gets to show what it did. */
export const STEP_WAIT_MS = 2500;
/**
 * A step that moved nothing on is done with once the page has been still this long, with nothing
 * left loading: waiting the whole STEP_WAIT_MS on each was most of a journey's time. Longer than the
 * beat an app gives before it goes on by itself (a chat "typing", a pause for another pick), and a
 * second look for what a flow is still drawing gets longer still. One of several choices gets the
 * whole wait: picking one is what an app most often waits a beat on, for another to be picked.
 */
export const STEP_STILL_MS = 1800;
export const STEP_STILL_MORE_MS = 2000;
/** Steps in a row that move nothing before that's a loop: what a flag saved where the app can't see it looks like. */
const SAME_SCREEN_MOST = 3;
/** Stops listed that no press was needed for: enough to name a run's upgrade and connect buttons. */
const MOST_STOPS = 12;

/** Said wherever the journeys are, so "finished" is only ever read one way. */
export const JOURNEY_LEGEND = "Finished means the screens moved on with saves answered in the browser. It says nothing about your real server.";

/**
 * payment: takes money. email: sends a message to someone. third_party: an outside account or
 * service (a bank, OAuth, a webhook). file: asks for a real file. account: makes or changes a real
 * account. paywall: asks to upgrade. destroys, sign_out: left alone. leaves_site: goes to another site.
 * download: puts something on this machine or a printer. disconnects: lets go of an outside account.
 */
export type StopKind = "payment" | "email" | "third_party" | "disconnects" | "file" | "account" | "paywall" | "destroys" | "sign_out" | "leaves_site" | "download";

export type JourneyOutcome =
  /** The screens moved on to the end. Never "works": see JOURNEY_LEGEND. */
  | "finished"
  /** It came to something this run never does for real. */
  | "stopped_here"
  /** The walk couldn't go on: a pretend answer, a turn-down, a loop or nothing to press. Never a fault of the app. */
  | "couldnt_follow"
  /** Time or steps ran out. */
  | "not_finished"
  /** It was found and never got under way. */
  | "not_reached";

export type CouldntFollow = "no_next" | "turned_down" | "after_pretend" | "sent_away" | "loop";

/** Whether what was saved was seen again. unknown is all that's said otherwise: never that it was lost. */
export type SavedShown = "seen" | "unknown";

export interface JourneyStep {
  /** The screen it was on. */
  screen: string;
  did: "open" | "press" | "fill" | "stop";
  label?: string;
  /** What showed a press moved anything on, when something did. */
  moved?: Moved;
  /** A save was answered on this step. */
  saved?: true;
  /** It's what the journey came for. */
  goal?: true;
  /** A choice taken and left for another on the same screen, where nothing had moved: walked, and no part of the way to value. */
  left?: true;
}

export interface WalkedJourney {
  name: string;
  /** The screen it started from. */
  from: string;
  main: boolean;
  outcome: JourneyOutcome;
  why?: CouldntFollow | "time" | "steps";
  /** What it stopped at, and what kind of thing that is. */
  stop?: { kind: StopKind; label: string; byLabel: boolean };
  /** Why it was never walked, in a few plain words. */
  because?: string;
  /** The one of several choices that led to its stop: the walk's pick, which says nothing of the others. */
  pick?: { label: string; of: number };
  /** It's the walk of the first run, or one of its choices. */
  firstRun?: true;
  steps: JourneyStep[];
  saved?: SavedShown;
  /** Boxes a sign-up asks for, when it's the sign-up: it's never counted as steps. */
  fields?: number;
  /** Only read from the code: no screen was seen to offer it. */
  fromCode?: true;
  /** It came out where an earlier journey had been, so it wasn't walked twice: that one's name. */
  joins?: string;
  seenWith: "stand-in";
}

/** Steps to first value on the main journey: only ever what this walk did. atLeast: a screen was opened by address, so a person may need more. */
export interface StepsToValue {
  presses: number;
  fields: number;
  screens: number;
  atLeast: boolean;
  /** The screen the count starts on, opened by address: what comes before it isn't in it. */
  from: string;
  /** It starts where a new account starts, so only the sign-up is left out. */
  fromFirstRun: boolean;
  to: string;
  /** No main action finished: this is the first thing saved, and no more than that. */
  firstSave?: true;
}

/** A screen opened in the session a walk left, for what it asks of a new account. */
export interface WalkedView {
  path: string;
  gate?: ScreenReview["gate"];
  locked: ScreenReview["locked"];
  rows: number;
  lines: string[];
  /** Saves were answered in this session before it was opened. */
  afterSave: boolean;
  heldData?: ScreenReview["heldData"];
}

export interface JourneyReport {
  status: "walked" | "not_walked";
  message: string;
  legend: string;
  limitSeconds: number;
  seconds: number;
  journeys: WalkedJourney[];
  /** Found, and no walk got to them, by name. */
  notFinished: string[];
  notReached: { name: string; because: string; from?: string; fromCode?: true }[];
  /** Controls that say they destroy or sign out: never pressed, whatever they were. */
  leftAlone: number;
  /** What the code read calls the main action, when it did. */
  mainAction?: string;
  /** Screens opened only to look. */
  looked: string[];
  toValue?: StepsToValue;
  /** What the code read adds was never read in time: the list is only what the screens offered. */
  noCodeHints?: boolean;
  views: WalkedView[];
}

/** What came of a press, by what showed it (see movedOn). */
export type Moved = "address" | "step" | "dialog" | "list";

/** A screen as a step needs it. */
export interface StepLook {
  path: string;
  /** The address is one a press can move on to: not a public page, nor what can't-exist draws. */
  placed: boolean;
  heading?: string;
  /** "Step 2 of 4", where it says. */
  marker?: string;
  /** Which boxes are on show, and nothing of what's in them. */
  fieldsKey: string;
  /** What an open pop-up says of itself. */
  dialog?: string;
  rows: number;
  text: string;
  /** Still working: a spinner, a busy mark. */
  busy: boolean;
  wall?: Wall["kind"];
  /** An alert that says something went wrong. */
  alert?: string;
  /** What's drawn is a crash, whatever the address did. */
  crashed?: boolean;
}

export interface StepControl {
  /** Finds it on the page. */
  mark: string;
  label: string;
  /** A card's first line, where a label runs on: what it's called. */
  title?: string;
  /** Where it goes, when that's an address. */
  href?: string;
  /** Opens elsewhere or saves a file: it leaves the page however it reads. */
  away?: boolean;
  where: "dialog" | "main" | "nav" | "floating";
  disabled: boolean;
  /** Drawn to be the thing to press. */
  primary: boolean;
  /** Controls side by side with the same look share this. */
  group: string;
  /** It sends the form in view. */
  submits?: boolean;
  says: Saying;
}

export interface StepForm {
  key: string;
  label?: string;
  inDialog: boolean;
  /** Names, labels and autocomplete of its boxes, for telling one that asks for a card. Never what's in them. */
  hints?: string;
  /** It's one box, and nothing says it has to be filled. */
  optionalBox?: boolean;
  /** It asks for a card or the like, and can't be typed into. */
  stop?: StopKind;
}

export interface ScreenNow extends StepLook {
  controls: StepControl[];
  form?: StepForm;
  /** Boxes that take a file, on show or hidden behind a button. */
  files: number;
  /** A lone box with no form, sent with Enter. */
  looseBox: boolean;
  /** Boxes on show outside any form, search aside. */
  looseFields: number;
  /** Names, labels and autocomplete of every box on show, in a form or not. Never what's in them. */
  boxHints?: string;
  /** A box on show that no made-up value goes in. */
  asks?: StopKind;
}

/** The browser, as a journey sees it: everything goes through the sealed page in crawlSite. */
export interface Drive {
  /** A fresh start: nothing saved, nothing kept in the browser. */
  reset(): Promise<void>;
  /** Opens an address of the app. False when it couldn't be, by the seal's rule or the page's. */
  open(path: string): Promise<boolean>;
  /**
   * What's on screen once it stops changing, or, with `before`, once it's moved on from that, for as
   * long as a press gets. With `anyChange`, what's drawn differing from it is enough: a chat's next choices.
   * Patient: only moving on ends the wait, never the page going still (see STEP_STILL_MS).
   */
  look(before?: StepLook, anyChange?: boolean, patient?: boolean): Promise<ScreenNow>;
  press(mark: string): Promise<boolean>;
  /** Fills and sends the form in view, unless mayGo says no: "stopped" with nothing typed. */
  fill(inDialog: boolean, mayGo: (says: Saying) => boolean): Promise<"sent" | "stopped" | "nothing">;
  /** Types into a lone box and sends it. */
  loose(): Promise<boolean>;
  review(path: string, afterSave: boolean): Promise<ScreenReview | undefined>;
  /** Everything on the trail so far. */
  trail(): readonly Trail[];
  /** Words of what was saved that this text says. */
  keptIn(text: string): string[];
  /** Opens an address as a fresh load would, with nothing left of what the app kept for this tab. */
  reopen(path: string): Promise<boolean>;
  /** Only what's read from here on counts for keptServedIn. */
  forgetServed(): void;
  /** Words of what was saved that this text says and a read since forgetServed really handed the page: what shows it came from what was kept, and not from the app's own memory. */
  keptServedIn(text: string): string[];
  /** A label that can stand as the app's own words: a made-up row's is blanked. */
  plain(text: string): string;
  /** The walk is to end now. */
  stopped(): boolean;
  /** The app's own origin: what a link has to be on, not to be leaving. */
  origin: string;
}

/** Walks the screens of one run: what a press is taken for, and what's found to press. */
export interface Journey {
  name: string;
  /** The screen it starts from. */
  start: string;
  /** The address that screen was really seen at, when that says more than the screen's name: a wizard's ?step= is its place. */
  opens?: string;
  /** Presses from the start that get to where this one begins. */
  via: string[];
  /** The control it's for. */
  goal?: string;
  /** What it's for in words, for telling which of many choices leads there: its name, and what the code says it does. */
  seek?: string;
  main?: boolean;
  firstRun?: boolean;
  /** In words like the main action's: it's given the main journey's time, and may have to find its way. */
  long?: boolean;
  /** Another choice of a journey whose choice came to a stop: its goal lies along that way, and it's tried once. */
  chose?: boolean;
  /** One of those after the first: it waits for everything else, as each is a whole walk again. */
  later?: boolean;
  /** Only read from the code: nothing was seen to offer it. */
  fromCode?: boolean;
  /**
   * Another choice on the screen a journey stopped at, walked on from there in the same session with
   * nothing reset: the way there is that journey's, already walked. Only good straight after it.
   */
  resume?: Resume;
}

/** Where a journey that stopped left the session, for another choice on that screen to go on from. */
export interface Resume {
  now: ScreenNow;
  steps: JourneyStep[];
  pressed: string[];
  sent: string[];
  moved: number;
  saved: boolean;
  unknownSave: boolean;
  /** What the journey's first screen said. */
  words: string;
  trodden: string[];
}

/** What the code read says, as checked labels and addresses. No source reaches the scanner. */
export interface JourneyHints {
  main?: string;
  /** public: on a screen anyone can open, where only what reads as real is of any interest. */
  actions: { screen: string; label: string; does: string; public?: boolean }[];
  screens: { path: string }[];
}

const FIRST_WORDS = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Words that take a person on, ahead of those that put it off. */
const ONWARD = /^(?:continue|next|proceed|done|finish|get started|let.s go|start|begin|i.m ready|got it|ok(?:ay)?|save (?:and|&) (?:continue|next)|take me|go to\b|looks good|fortfahren|weiter|continuer|suivant|continuar|siguiente|avanti)\b/i;
const PUT_OFF = /^(?:skip|not now|maybe later|later|no thanks|i.ll do (?:it|this) later|überspringen|passer|omitir|saltar)\b/i;
/** What starts something on a screen: add a record, begin an import, make a new one. */
const ENTRY = /^(?:\+\s*)?(?:add|new|create|import|upload|start|set up|log|record|enter|hinzufügen|neu|erstellen|importieren|ajouter|nouveau|créer|importer|añadir|nuevo|crear|importar|aggiungi|nuovo|crea|toevoegen|nieuw|adicionar|novo)\b/i;

/** What sends a form with no form around it. */
const SENDS_ON = /^(?:save|submit|add|create|confirm|apply|update|finish|done|log)\b/i;

/** Words of an entry that makes a record, rather than bringing many in. */
const MAKES = /^(?:\+\s*)?(?:add|new|create|log|record|enter)\b/i;

const SIGN_OUT = /\b(?:log ?out|log ?off|sign ?out|abmelden|ausloggen|déconnexion|se déconnecter|cerrar sesión|uitloggen|\besci\b|\bsair\b)/i;
const PAYS = /\b(?:pay|payment|buy|purchase|checkout|check out|place (?:my |your )?order|billing portal|card details|bezahlen|kaufen|zur kasse|payer|acheter|pagar|comprar|acquista|afrekenen)\b/i;
const CONNECTS = /^(?:re-?)?(?:connect|link|authori[sz]e|sync|integrate|verbinden|connecter|conectar|collega)\b/i;
const DISCONNECTS = /^(?:disconnect|unlink|unsync|deauthori[sz]e|trennen|déconnecter)\b/i;
const OUTSIDE_SIGN_IN = /^(?:continue|log ?in|sign ?in|sign ?up)\s+(?:with|using|via)\s+\S+/i;
/** A bare "Send" is a chat's arrow as often as not: it needs to say what goes, and what no word says is on the trail. */
const SENDS = /^(?:re-?)?send\s+(?:\S+\s+){0,3}?(?:invite|invitation|e-?mail|link|code|message to|reset|verification)\b|^(?:re-?)?invite\b|^share\b|^(?:e-?mail|notify|mail)\b/i;
const MAKES_ACCOUNT = /^(?:sign ?up|register|create (?:a |an |your |my )?(?:free )?account|join\b)/i;
const CLOSES_ACCOUNT = /^(?:close|deactivate|cancel) (?:my |your |the )?(?:account|subscription|membership|plan)\b|^(?:change|reset|update) (?:my |your )?(?:password|e-?mail)\b/i;
const SAVES_OUT = /download|print|export|herunterladen|exportieren|drucken|imprimer|imprimir/i;
/** An offer of what a paid plan does: "See it with Pro". */
const WITH_THE_PLAN = /\bwith (?:pro|premium|plus|business)$/i;
/** A trial starts a plan, and usually takes a card: "Start 5-day free trial". */
const STARTS_TRIAL = /\b(?:start|begin|try)\b.*\btrial\b|\b(?:free|\d+[- ]day) trial\b/i;
/** Fields no made-up value goes in. */
const CARD_FIELD = /(?:^|\s)cc-(?:number|csc|exp|name|given-name|family-name|type)\b|\b(?:cvc|cvv|iban|card ?number|cardnumber|sort ?code|account ?number)\b/i;
/**
 * What a screen says when something real has just been done, which no label or address warned of. A
 * walk's answers are pretend, so this is one more thing it stopped at, and it can't count as finished.
 */
const SAYS_PAID_NOW = /\b(?:(?:charged|took|taken|debited|billed)\b[^.!?\n]{0,40}\b(?:card|account)\b|payment (?:received|successful|complete[d]?|confirmed|taken)|thanks? (?:you )?for your (?:payment|purchase|order)|order (?:placed|confirmed))/i;
const SAYS_SENT_NOW = /\b(?:e-?mails? (?:was |were |has been |have been )?(?:sent|on (?:its|their) way)|(?:has|have) an e-?mail|invit(?:e|ation)s? (?:was |were |has been |have been )?sent|sent (?:you |them )?(?:an? )?(?:e-?mail|invit\w+)|check your (?:e-?mail|inbox))\b/i;
/** What a page draws when it's fallen over: what a boundary says, or the error itself. In the page, by way of its source (see readStep). */
export const CRASH_WORDS = /\b(?:something went wrong|this page (?:has )?crashed|application error|unexpected (?:application )?error|an error (?:has )?occurred|typeerror|referenceerror|cannot read propert(?:y|ies)|is not a function|undefined is not)\b|^oops\b/i;

/** What a control's address says, whatever its label does. */
function stopOfAddress(href: string | undefined, origin: string | undefined): StopKind | undefined {
  if (!href) return undefined;
  if (/^mailto:/i.test(href)) return "email";
  if (/^(?:tel|sms):/i.test(href)) return "email";
  try {
    const url = new URL(href, origin ?? "http://local.invalid");
    if (origin && url.origin !== new URL(origin).origin) return /o?auth|authorize|connect/i.test(url.pathname) ? "third_party" : "leaves_site";
  } catch {
    return "leaves_site";
  }
  return undefined;
}

/**
 * Whether a control is one this run doesn't press, and why, from what it says and where it goes.
 * Word lists can be wrong both ways, which is why what comes of one is worded "reads like": a
 * harmless "Share" costs a journey its end, and what no label says is caught by the trail anyway.
 */
export function stopOf(says: Saying, target: { href?: string | undefined; away?: boolean | undefined; origin?: string | undefined } = {}): StopKind | undefined {
  const text = FIRST_WORDS(says.text);
  if (SIGN_OUT.test(text)) return "sign_out";
  if (controlDestroys(says)) return "destroys";
  const address = stopOfAddress(target.href, target.origin);
  if (address) return address;
  if (target.away) return "leaves_site";
  if (OUTSIDE_SIGN_IN.test(text)) return "third_party";
  if (MAKES_ACCOUNT.test(text) || CLOSES_ACCOUNT.test(text)) return "account";
  if (ASKS_TO_PAY.test(text) || WITH_THE_PLAN.test(text) || STARTS_TRIAL.test(text)) return "paywall";
  if (PAYS.test(text)) return "payment";
  if (DISCONNECTS.test(text)) return "disconnects";
  if (CONNECTS.test(text)) return "third_party";
  if (SENDS.test(text)) return "email";
  // What's off-limits to any press of this run's, whatever this list missed.
  if (RISKY_BUTTON.test(text)) return SAVES_OUT.test(text) ? "download" : "destroys";
  return undefined;
}

/** A field a form may ask for that no made-up value goes in, by its autocomplete, name or label. */
export function stopOfField(hint: string): StopKind | undefined {
  if (CARD_FIELD.test(hint)) return "payment";
  return /\bpass(?:word|wd|code)\b/i.test(hint) ? "account" : undefined;
}

/** What a screen says was just done for real, if it says that: words of its own, which were never there before the press. */
export function saidDone(before: StepLook, after: StepLook): { kind: StopKind; words: string } | undefined {
  for (const [kind, says] of [["payment", SAYS_PAID_NOW], ["email", SAYS_SENT_NOW]] as const) {
    const words = says.exec(after.text)?.[0];
    if (words && !says.test(before.text)) return { kind, words };
  }
  return undefined;
}

/** The trail's kinds that end a journey. A file chooser is only somewhere a person would have to choose. */
const STOPPING: Partial<Record<TrailKind, StopKind>> = { payment: "payment", email: "email", third_party: "third_party", leaves_site: "leaves_site", account: "account", sign_out: "sign_out", destroys: "destroys", file: "file" };

/** What on the trail stops a journey, if anything did. */
export function trailStop(trail: readonly Trail[]): { kind: StopKind; label: string } | undefined {
  for (const step of trail) {
    const kind = STOPPING[step.kind];
    if (kind) return { kind, label: step.where };
  }
  return undefined;
}

/**
 * What shows a press moved anything on. Only what stays: a new address that's a screen, another
 * step, a pop-up opened or closed, more rows. Words on a button changing, a spinner, a toast and an
 * alert saying it went wrong are none of those.
 */
export function movedOn(before: StepLook, after: StepLook): Moved | undefined {
  if (after.alert && after.alert !== before.alert) return undefined;
  if (after.crashed && !before.crashed) return undefined;
  if (after.path !== before.path) return after.placed ? "address" : undefined;
  if (after.busy) return undefined;
  if (after.dialog !== before.dialog) return "dialog";
  if (after.marker !== before.marker && after.marker) return "step";
  if (after.fieldsKey !== before.fieldsKey && (after.heading !== before.heading || !before.fieldsKey || !after.fieldsKey)) return "step";
  // A wizard's own rows are its furniture: more of them shows a choice taken, and that's no step.
  return after.rows > before.rows && !after.marker ? "list" : undefined;
}

/** What's drawn, as far as telling two reads of one screen apart goes. */
export const drawnAs = (now: StepLook & { controls?: readonly StepControl[]; form?: StepForm | undefined }) => `${now.path}|${now.text.length}|${(now.controls ?? []).map((c) => c.label).join()}|${now.fieldsKey}|${now.dialog}|${now.form?.key}`;

/**
 * Whether a look can stop reading: what's drawn has held between two reads and isn't loading, and,
 * after a press, it's moved on (or, with anyChange, differs at all), or the page has been still a
 * while with nothing loading (stillFor: since anything on it last changed). A screen that's still
 * isn't said to have moved: that's only ever what movedOn says.
 */
export function stepSettled(o: { was: ScreenNow; now: ScreenNow; before?: StepLook | undefined; anyChange?: boolean | undefined; patient?: boolean | undefined; stillFor: number; quiet: boolean }): boolean {
  const { was, now, before } = o;
  if (drawnAs(was) !== drawnAs(now) || now.busy || now.wall === "loading" || now.wall === "blank") return false;
  if (!before) return true;
  if (o.anyChange ? drawnAs(before) !== drawnAs(now) : movedOn(before, now) !== undefined) return true;
  return !o.patient && o.quiet && o.stillFor >= (o.anyChange ? STEP_STILL_MORE_MS : STEP_STILL_MS);
}

export type StepChoice =
  /** of: the group it was taken from. beyond: the first of each other group on show, which may read the same and go elsewhere. */
  | { do: "press"; control: StepControl; branches?: StepControl[]; of?: StepControl[]; beyond?: StepControl[] }
  | { do: "fill"; inDialog: boolean }
  | { do: "loose" }
  /** others: the choices on show beside it, a way on that needs nothing real. */
  | { do: "stop"; kind: StopKind; label: string; byLabel: boolean; others?: StepControl[] }
  | { do: "wall" }
  /** Nothing is left to do here. */
  | { do: "end" };

/** How far along a journey is, for choosing its next step. */
export interface StepState {
  goal?: string | undefined;
  seek?: string | undefined;
  /** This journey's way of pressing: "screen|label" of what's been pressed. */
  pressed: ReadonlySet<string>;
  /** Forms already sent. */
  sent: ReadonlySet<string>;
  moved: number;
  /** It's just been brought here: the first screen of what it came for, whatever it took to arrive. */
  arrived?: boolean;
  /** What it came for has been pressed: nothing that wasn't on the way is its business now. */
  goalPressed?: boolean;
  firstRun: boolean;
  origin?: string | undefined;
}

const sameLabel = (a: string, b: string) => FIRST_WORDS(a) === FIRST_WORDS(b);
const pressKey = (now: StepLook, label: string) => `${now.path}|${now.marker ?? ""}|${now.heading ?? ""}|${FIRST_WORDS(label)}`;

const looseKey = (now: StepLook) => `loose|${now.path}|${now.fieldsKey}`;

/** Controls side by side that look alike: what's offered as a choice. */
function groupsOf(controls: readonly StepControl[]): StepControl[][] {
  const groups = new Map<string, StepControl[]>();
  for (const c of controls) if (c.group) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  return [...groups.values()].filter((group) => group.length >= 2);
}

/** The start of a word: "manual" and "manually" are one. */
const stems = (text: string) => new Set(FIRST_WORDS(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4).map((word) => word.slice(0, 5)));

/**
 * Which of a group leads where this journey is going, as far as the words say. A word most of them
 * share says nothing, so each counts for less the more of them have it. With nothing to go by it's
 * the first, as a person would take.
 */
function bestChoice(group: readonly StepControl[], seek: string | undefined): StepControl {
  const wanted = stems(seek ?? "");
  const has = new Map(group.map((c) => [c, stems(`${c.label} ${c.says.text}`)]));
  const weigh = (c: StepControl) => [...has.get(c)!].filter((stem) => wanted.has(stem)).reduce((sum, stem) => sum + 1 / [...has.values()].filter((words) => words.has(stem)).length, 0);
  return group.reduce((best, c) => (weigh(c) > weigh(best) ? c : best), group[0]!);
}

/** A screen with more to go: it says so, or holds a pop-up, or it's the first run still. */
function inFlow(now: ScreenNow, state: StepState): boolean {
  return Boolean(now.marker) || Boolean(now.dialog) || (state.firstRun && (state.moved === 0 || FIRST_RUN_PATH.test(now.path)));
}

/**
 * The next step, in one strict order. A wall ends it. What's open comes first, then what asks for
 * something real, then a form, then what it's here for, then the way on, then one of a group of
 * choices (the others become journeys of their own), then the thing drawn to be pressed. Past the
 * first move, anything of that last kind needs the screen to say there's more: on a plain screen
 * the journey has got where it was going, and a button left there isn't part of it.
 */
export function chooseStep(now: ScreenNow, state: StepState): StepChoice {
  if (now.wall) return now.wall === "paywall" ? { do: "stop", kind: "paywall", label: now.heading ?? now.path, byLabel: false } : { do: "wall" };
  const flow = inFlow(now, state);
  // A bar stuck to the window is no part of the way on, but for the one that holds the way on: a wizard's Continue often sits in one.
  const open = now.dialog ? now.controls.filter((c) => c.where === "dialog") : now.controls.filter((c) => c.where === "main" || (c.where === "floating" && (ONWARD.test(c.label) || SENDS_ON.test(c.label))));
  const stops = new Map(open.map((c) => [c, stopOf(c.says, { href: c.href, away: c.away, origin: state.origin })]));
  // What it came for is pressed once: a heading that's changed makes it look new, and it isn't.
  const usable = open.filter((c) => !c.disabled && !stops.get(c) && !state.pressed.has(pressKey(now, c.label)) && !(c.submits && now.form && state.sent.has(now.form.key)) && !(state.goalPressed && state.goal && sameLabel(c.label, state.goal)));
  const untried = now.form && !state.sent.has(now.form.key) ? now.form : undefined;
  const choices = [...groupsOf(usable)];
  if (now.asks) return { do: "stop", kind: now.asks, label: now.asks === "payment" ? "the card details" : "the password box", byLabel: true };
  if (untried?.stop) return { do: "stop", kind: untried.stop, label: untried.label ?? "the form", byLabel: true };
  if (state.goal) {
    const goal = now.controls.find((c) => sameLabel(c.label, state.goal!) && !c.disabled);
    const kind = goal && stopOf(goal.says, { href: goal.href, away: goal.away, origin: state.origin });
    if (goal && kind) return { do: "stop", kind, label: goal.label, byLabel: true };
    if (goal && !state.goalPressed && !state.pressed.has(pressKey(now, goal.label))) return { do: "press", control: goal };
  }
  // One box that needn't be filled, beside choices on a way that's under way, is a reply: the choices are what it's asking.
  if (untried && !(untried.optionalBox && flow && (choices.length || now.files > 0))) return { do: "fill", inDialog: untried.inDialog };
  // Pressed, and all it did was stay: that's where this journey ends, and what else is on the screen isn't part of it.
  if (state.goalPressed && state.moved === 0 && !flow) return { do: "end" };
  const typedHere = state.sent.has(looseKey(now));
  if (now.looseFields > 0 && !typedHere && (flow || state.moved > 0)) return { do: "loose" };
  if (typedHere) {
    const send = usable.find((c) => SENDS_ON.test(c.label));
    if (send) return { do: "press", control: send };
  }
  const onward = usable.find((c) => ONWARD.test(c.label)) ?? usable.find((c) => PUT_OFF.test(c.label));
  if (onward) return { do: "press", control: onward };
  if (now.files > 0) return { do: "stop", kind: "file", label: "the file choice", byLabel: false, ...(choices[0] ? { others: choices[0] } : {}) };
  const opening = (state.moved === 0 && !state.goalPressed) || state.arrived === true;
  if (opening || flow) {
    if (choices[0]) {
      const control = bestChoice(choices[0], state.seek);
      // Cards go with cards: filters beside them are choices of another kind.
      return { do: "press", control, of: choices[0], beyond: choices.slice(1).map((group) => group[0]!).filter((c) => !control.title || c.title), branches: opening && !flow && choices[0].length <= MOST_GROUP ? choices[0].filter((c) => c !== control) : [] };
    }
    const primary = usable.find((c) => c.primary) ?? usable.find((c) => SENDS_ON.test(c.label) && !/^(?:add|log)\b/i.test(c.label));
    if (primary) return { do: "press", control: primary };
    if (now.looseBox && !typedHere) return { do: "loose" };
    if (usable.length === 1) return { do: "press", control: usable[0]! };
    const stuck = open.find((c) => !c.disabled && stops.get(c) && stops.get(c) !== "destroys" && stops.get(c) !== "sign_out");
    if (stuck && usable.length === 0) return { do: "stop", kind: stops.get(stuck)!, label: stuck.label, byLabel: true };
  }
  return { do: "end" };
}

/** What a journey came to, once nothing more can be done: moved on, with nothing left in the way, or not. */
export function endOf(now: ScreenNow, state: Pick<StepState, "moved" | "sent">): { outcome: "finished" } | { outcome: "couldnt_follow"; why: CouldntFollow } {
  const blocked = Boolean(now.dialog) || Boolean(now.marker && stepsLeft(now.marker)) || Boolean(now.form && !state.sent.has(now.form.key));
  return state.moved > 0 && !blocked ? { outcome: "finished" } : { outcome: "couldnt_follow", why: "no_next" };
}

/** "Step 2 of 4" has more to come, and "Step 4 of 4" hasn't. A stepper's name for where it is says neither. */
function stepsLeft(marker: string): boolean {
  const [, at, of] = /(\d+)\D+(\d+)/.exec(marker) ?? [];
  return at !== undefined && at !== of;
}

/** Why a walk that's been ended by a wall ended: never a fault of the app. */
function wallWhy(now: ScreenNow, saved: boolean): CouldntFollow {
  if (saved) return "after_pretend";
  return now.wall === "sign_in" || !now.placed ? "sent_away" : "turned_down";
}

/** The rest of a group, a choice of which came to a stop: all of a few, and of a catalogue the one that reads least like what was tried. */
function otherChoices(tried: StepControl | undefined, group: readonly StepControl[]): StepControl[] {
  const others = group.filter((c) => c !== tried);
  if (group.length <= MOST_GROUP) return [...others].sort((a, b) => Number(MAKES.test(b.title ?? b.label)) - Number(MAKES.test(a.title ?? a.label))).slice(0, BRANCHES_MOST);
  const words = stems(tried?.says.text ?? "");
  const shared = (c: StepControl) => [...stems(c.says.text)].filter((stem) => words.has(stem)).length;
  return others.reduce<StepControl[]>((least, c) => (!least[0] || shared(c) < shared(least[0]) ? [c] : least), []);
}

/** One journey from a fresh start: every step, how it came out, and what stopped it. */
export async function walkOne(journey: Journey, drive: Drive, branch: (from: Journey, via: string[]) => void, joined: (now: StepLook, journey: Journey) => WalkedJourney | undefined = () => undefined, deadline: number = Date.now() + (journey.main || journey.firstRun || journey.long ? MAIN_JOURNEY_MOST_MS : JOURNEY_MOST_MS), again: (from: Journey, other: StepControl, nth: number, pressedGoal: boolean, resume?: Resume) => void = () => {}): Promise<WalkedJourney> {
  const resume = journey.resume;
  const steps: JourneyStep[] = resume ? resume.steps.map((step) => ({ ...step })) : [];
  const seenWith = "stand-in" as const;
  const name = drive.plain(journey.name);
  const from = journey.start;
  const base = { name, from, main: journey.main === true, ...(journey.firstRun ? { firstRun: true as const } : {}), seenWith };
  const done = (end: Partial<WalkedJourney> & { outcome: JourneyOutcome }): WalkedJourney => ({ ...base, ...end, steps });
  let now: ScreenNow;
  if (resume) now = resume.now;
  else {
    await drive.reset();
    if (!(await drive.open(journey.opens ?? journey.start))) return done({ outcome: "not_reached", because: "the address couldn't be opened" });
    steps.push({ screen: journey.start, did: "open" });
    now = await drive.look();
  }
  for (const label of resume ? [] : journey.via) {
    const control = now.controls.find((c) => sameLabel(c.label, label));
    if (!control || !(await drive.press(control.mark))) return done({ outcome: "not_reached", because: "the way there wasn't drawn again" });
    steps.push({ screen: now.path, did: "press", label: drive.plain(label) });
    now = await drive.look();
  }
  const words = resume ? resume.words : now.text;
  const goalOnShow = !journey.goal || now.controls.some((c) => sameLabel(c.label, journey.goal!));
  // Sent off to the first run: what it's for lies past that, and that walk is the first run's, not this one's to report.
  if (!goalOnShow && !journey.firstRun && now.path !== journey.start && FIRST_RUN_PATH.test(now.path)) return done({ outcome: "not_reached", because: `a new account is sent to ${now.path} first` });
  if (!goalOnShow && !journey.main && !journey.long && !journey.chose) return done({ outcome: "not_reached", because: NOT_ON_SHOW });
  const state: Omit<StepState, "pressed" | "sent"> & { pressed: Set<string>; sent: Set<string> } = { goal: journey.goal, seek: journey.seek ?? journey.name, pressed: new Set<string>(resume?.pressed), sent: new Set<string>(resume?.sent), moved: resume ? resume.moved : journey.via.length, arrived: !resume && journey.via.length > 0, firstRun: journey.firstRun === true, origin: drive.origin };
  const trodden = resume ? [...resume.trodden] : [...journey.via];
  /** Looks left after this step for what's still to come. */
  let patience = LOOKS_FOR_MORE;
  /** Steps in a row that moved nothing, on one screen. */
  let idle = 0;
  let idleOn = "";
  const trailSince = (at: number) => drive.trail().slice(at);
  /** How far the trail has been read: what a press set off late, after its look ended, is read before the next press, or before the walk's end. */
  let readTo = drive.trail().length;
  let saved = resume?.saved ?? false;
  let unknownSave = resume?.unknownSave ?? false;
  let leftFirstRun = false;
  /** The last choice taken from a group, and where in the steps. */
  let pick: { control: StepControl; of: StepControl[]; beyond: StepControl[]; step: number; walked: boolean } | undefined;
  /**
   * Where the stop was decided, steps since the choice that led to it (its stop step aside) that
   * only pressed: nothing moved on, nothing saved, nothing typed. Only then is this screen still
   * the one that offered the choice.
   */
  const sinceChoice = () => (pick ? steps.slice(pick.step, -1) : []);
  const stillAtChoice = () => sinceChoice().every((step) => step.did === "press" && !step.moved && !step.saved);
  const onScreen = (other: StepControl) => now.controls.some((c) => c === other || (sameLabel(c.label, other.label) && !c.disabled && !stopOf(c.says, { href: c.href, away: c.away, origin: state.origin })));
  const resumeHere = (other: StepControl): Resume => {
    // The stop wasn't pressed, and a choice of the same group as this one was taken and left, where it changed nothing.
    const left = pick && stillAtChoice() && [...pick.of, ...pick.beyond].some((c) => sameLabel(c.label, other.label)) ? pick.step : steps.length;
    return {
      now,
      // What the earlier journey came for is no goal of this one: a walk from the start presses it on the way, unmarked.
      steps: steps.slice(0, -1).map(({ goal: _goal, ...step }, n) => (n >= left ? { ...step, left: true as const } : step)),
      pressed: [...state.pressed], sent: [...state.sent], moved: state.moved, saved, unknownSave, words, trodden: [...trodden],
    };
  };
  /** It came to a stop: what took it there, and the other ways on, each tried once. still: nothing was tried for real to get to it, only seen, or a file asked for and none given. */
  const stoppedAt = (stop: NonNullable<WalkedJourney["stop"]>, beside: readonly StepControl[] = [], still = false): WalkedJourney => {
    const fromPick = pick && steps.length - pick.step <= STEPS_FROM_CHOICE + 1 ? pick : undefined;
    const others = beside.length ? otherChoices(undefined, beside) : fromPick && !fromPick.walked ? [...fromPick.beyond, ...otherChoices(fromPick.control, fromPick.of)].slice(0, BRANCHES_MOST) : [];
    if (!journey.chose) {
      // The first other choice still on this screen goes on from here: walking the way here again would only take it back to this screen.
      // Choices beside the stop are on this screen as it is; a choice that led to it left the screen as it offered them only if nothing since moved it on.
      const fromChoice = beside.length === 0;
      const here = still && (!fromChoice || stillAtChoice()) ? others.findIndex((other) => onScreen(other)) : -1;
      others.forEach((other, nth) => again(journey, other, nth, state.goalPressed === true, nth === here ? resumeHere(other) : undefined));
    }
    return done({ outcome: "stopped_here", stop, ...(fromPick ? { pick: { label: drive.plain(fromPick.control.title ?? fromPick.control.label), of: fromPick.of.length + fromPick.beyond.length } } : {}) });
  };
  /** What a press set off, read before anything is made of what it drew. */
  const afterAction = (at: number): WalkedJourney | undefined => {
    const trail = trailSince(at);
    readTo = at + trail.length;
    if (!trail.length || !steps.length) return undefined;
    if (trail.some((t) => t.kind === "kept")) saved = true;
    if (trail.some((t) => t.kind === "save")) unknownSave = true;
    if (trail.some((t) => t.kind === "kept" || t.kind === "save")) steps.at(-1)!.saved = true;
    const stop = trailStop(trail);
    if (!stop) return undefined;
    steps.push({ screen: now.path, did: "stop", label: drive.plain(stop.label) });
    // A file chooser given no file is the one way out that leaves the page where it was: nothing went anywhere.
    return stoppedAt({ ...stop, label: drive.plain(stop.label), byLabel: false }, [], stop.kind === "file" && trail.every((t) => t.kind === "file"));
  };
  const limit = journey.main || journey.firstRun || journey.long ? MAIN_STEPS_MOST : STEPS_MOST;
  for (let n = 0; ; n++) {
    // Looks that wait for more are no steps, though they can't go on for ever either.
    if (steps.length > limit || n >= limit * 3) return done({ outcome: "not_finished", why: "steps" });
    if (drive.stopped() || Date.now() > deadline) return done({ outcome: "not_finished", why: "time" });
    const key = `${now.path}|${now.marker ?? ""}|${now.heading ?? ""}|${now.fieldsKey}`;
    idle = key === idleOn ? idle + 1 : 0;
    idleOn = key;
    if (idle >= SAME_SCREEN_MOST) return done({ outcome: "couldnt_follow", why: "loop" });
    const choice = chooseStep(now, state);
    // A reply box in a flow may be early: what it's a reply to can still be on its way, with choices.
    if (choice.do === "fill" && now.form?.optionalBox && (now.marker || now.dialog) && state.sent.size > 0 && patience === LOOKS_FOR_MORE) {
      patience--;
      now = await drive.look(now, true);
      idleOn = "";
      continue;
    }
    if (choice.do === "stop") {
      steps.push({ screen: now.path, did: "stop", label: drive.plain(choice.label) });
      return stoppedAt({ kind: choice.kind, label: drive.plain(choice.label), byLabel: choice.byLabel }, choice.others, true);
    }
    if (choice.do === "wall") return done({ outcome: "couldnt_follow", why: wallWhy(now, saved || unknownSave) });
    if (choice.do === "end") {
      // A flow that's still on may be drawing what's next: a chat types its question before it offers the answers.
      if (patience === 0 || !(now.dialog || /\d/.test(now.marker ?? ""))) break;
      patience--;
      const was = now;
      now = await drive.look(now, true);
      // A look that saw nothing change was still for as long as the drive waits (see STEP_STILL_MORE_MS): another would see the same.
      if (drawnAs(was) === drawnAs(now)) patience = 0;
      idleOn = "";
      continue;
    }
    patience = LOOKS_FOR_MORE;
    // What came after the last look is the last press's, and read as its before anything else is pressed.
    const late = afterAction(readTo);
    if (late) return late;
    const at = drive.trail().length;
    const before = now;
    let did: JourneyStep | undefined;
    let goalNow = false;
    if (choice.do === "press") {
      state.pressed.add(pressKey(now, choice.control.label));
      // A choice branches once: a choice inside a choice is what makes a walk a tree with no end.
      if (!journey.via.length && !journey.chose) for (const other of (choice.branches ?? []).slice(0, BRANCHES_MOST)) branch(journey, [...trodden, other.label]);
      trodden.push(choice.control.label);
      goalNow = journey.goal !== undefined && sameLabel(choice.control.label, journey.goal);
      state.goalPressed ||= goalNow;
      if (!(await drive.press(choice.control.mark))) return done({ outcome: "couldnt_follow", why: "no_next" });
      did = { screen: before.path, did: "press", label: drive.plain(choice.control.label), ...(goalNow ? { goal: true as const } : {}) };
      if (choice.of) pick = { control: choice.control, of: choice.of, beyond: choice.beyond ?? [], step: steps.length, walked: Boolean(choice.branches?.length) };
    } else if (choice.do === "fill") {
      state.sent.add(now.form!.key);
      // Sending the form is pressing what sends it.
      goalNow = journey.goal !== undefined && sameLabel(now.form!.label ?? "", journey.goal);
      state.goalPressed ||= goalNow;
      let blocked: Saying | undefined;
      const went = await drive.fill(choice.inDialog, (says) => {
        if (!stopOf({ ...says, around: "" })) return true;
        blocked = says;
        return false;
      });
      if (went === "stopped") {
        const label = blocked?.text ?? now.form!.label ?? "the form";
        steps.push({ screen: now.path, did: "stop", label: drive.plain(label) });
        return done({ outcome: "stopped_here", stop: { kind: stopOf(blocked ?? { text: label, around: "", marks: "" }) ?? "account", label: drive.plain(label), byLabel: true } });
      }
      if (went === "nothing") continue;
      did = { screen: before.path, did: "fill", label: drive.plain(now.form!.label || "the form"), ...(goalNow ? { goal: true as const } : {}) };
    } else {
      state.sent.add(looseKey(now));
      if (!(await drive.loose())) continue;
      did = { screen: before.path, did: "fill", label: "the box" };
    }
    steps.push(did);
    now = await drive.look(before, false, choice.do === "press" && choice.of !== undefined);
    const ended = afterAction(at);
    if (ended) return ended;
    // A crash is what a pretend answer can cause: it ends the walk here and is never a move on.
    if (now.crashed && !before.crashed) return done({ outcome: "couldnt_follow", why: saved || unknownSave ? "after_pretend" : "no_next" });
    const said = saidDone(before, now);
    if (said) {
      steps.push({ screen: now.path, did: "stop", label: drive.plain(said.words) });
      return stoppedAt({ kind: said.kind, label: drive.plain(said.words), byLabel: false });
    }
    const moved = movedOn(before, now);
    state.arrived = goalNow && moved !== undefined;
    if (moved) {
      did.moved = moved;
      state.moved++;
      idleOn = "";
    }
    if (now.path !== before.path && !now.placed) return done({ outcome: "couldnt_follow", why: "sent_away" });
    // Out of the first run: that's where it ends, and what a new account does next is another journey.
    if (journey.firstRun && moved && FIRST_RUN_PATH.test(before.path) && !FIRST_RUN_PATH.test(now.path)) {
      leftFirstRun = true;
      break;
    }
    // Five ways in to one place are one journey with five doors: what lies past it has been walked.
    const earlier = steps.length <= 2 + journey.via.length && (!journey.goal || trodden.some((label) => sameLabel(label, journey.goal!))) ? joined(now, journey) : undefined;
    if (earlier) {
      const { outcome, why, stop, saved: wasSaved, pick: wasPicked } = earlier;
      return done({ outcome, ...(why ? { why } : {}), ...(stop ? { stop } : {}), ...(wasSaved ? { saved: wasSaved } : {}), ...(wasPicked ? { pick: wasPicked } : {}), joins: earlier.name });
    }
    if (did.did === "fill" && now.alert && now.alert !== before.alert && !moved) return done({ outcome: "couldnt_follow", why: saved || unknownSave ? "after_pretend" : "turned_down" });
  }
  // A press that acted after its look ended is still the walk's: read before anything is said of how it ended.
  const late = afterAction(readTo);
  if (late) return late;
  if (now.wall) return done({ outcome: "couldnt_follow", why: wallWhy(now, saved || unknownSave) });
  // It went looking for what it came for and never saw it: that's no walk's end, it's a journey that never began.
  if (journey.goal && !state.goalPressed && steps.length === 1 + journey.via.length) return done({ outcome: "not_reached", because: NOT_ON_SHOW });
  const end = leftFirstRun ? { outcome: "finished" as const } : endOf(now, state);
  // Another choice is tried to see where it goes: a screen moved on and nothing saved says nothing was got done.
  if (end.outcome === "finished" && journey.chose && !saved && !unknownSave) return done({ outcome: "couldnt_follow", why: "no_next" });
  // It came for something it never got to press, so whatever moved on, what it's named for didn't happen.
  if (end.outcome === "finished" && journey.goal && !state.goalPressed) return done({ outcome: "couldnt_follow", why: "no_next", ...(saved || unknownSave ? { saved: "unknown" as const } : {}) });
  // Past a save nothing moved: that answer was this run's, and it's the walk that can't say what comes next.
  if (end.outcome === "couldnt_follow") return done(saved || unknownSave ? { outcome: "couldnt_follow", why: "after_pretend", saved: "unknown" } : end);
  if (!saved && !unknownSave) return done(end);
  if (!saved) return done({ ...end, saved: "unknown" });
  // Saved rows are said to show only once a fresh load drew them from a read of what the seal kept: an
  // app's memory of its own can echo them, so that's cleared, and each word has to have been handed
  // over. What the journey's first screen said already proves nothing, as it may be a word of the app's.
  drive.forgetServed();
  const there = await drive.reopen(now.path).then((ok) => (ok ? drive.look() : undefined));
  const fresh = there ? drive.keptServedIn(there.text).filter((word) => !drive.keptIn(words).includes(word)) : [];
  return done({ ...end, saved: fresh.length ? "seen" : "unknown" });
}

/** What's known of something not on a screen: not that it isn't offered, as one press may bring it. */
const NOT_ON_SHOW = "it wasn't on the first screen there, and what opens it wasn't found";

/** An address a new account can open as it stands: nothing in it stands for a record. */
const STANDS_ALONE = /^\/[^:]*$/;
/** Words past this aren't a control's: they're a box of text that happens to be pressable. */
const MOST_LABEL = 48;
/** What a label read from the code holds when it's a name in the code and no word on a screen. */
const NAME_IN_CODE = /^[a-z]+[A-Z]|^[A-Z]{1,3}$|^[^\p{L}]*\p{Ll}*$|[?.…]$/u;

/**
 * In the page: everything a step goes by, in one read. Each control gets a mark to be pressed by.
 * Only what a person could press, with what it says of itself; what's in a box is never read.
 */
export function readStep(o: { clickable: string; wrong: string; crash: string }): Omit<ScreenNow, "path" | "placed" | "wall"> {
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest("[aria-hidden=true], [inert]"); };
  const read = (window as unknown as { __ctxRead?: { says: (e: Element) => Saying; searchBox: (e: Element) => boolean } }).__ctxRead;
  const windowArea = innerWidth * innerHeight;
  const dialog = [...document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")].filter((el) => shown(el) && !/cookie|consent/i.test(clean(el.textContent).slice(0, 400))).pop();
  const inChrome = (el: Element) => !dialog?.contains(el) && (el.closest("nav, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]") !== null || (el.closest("header, footer") !== null && el.closest("main, [role=main], article, section") === null));
  const floats = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const position = getComputedStyle(e).position;
      if ((position === "fixed" || position === "sticky") && e.getBoundingClientRect().width * e.getBoundingClientRect().height < windowArea * 0.6) return true;
    }
    return false;
  };
  const solid = (el: Element) => {
    const paint = getComputedStyle(el).backgroundColor;
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(paint)?.[1];
    return paint !== "transparent" && (alpha === undefined || Number(alpha) > 0.5) && paint !== getComputedStyle(document.body).backgroundColor;
  };
  for (const el of document.querySelectorAll("[data-ctx-step]")) el.removeAttribute("data-ctx-step");
  const boxes = new Map<Element, number>();
  const groupOf = (el: Element) => {
    let box = el.parentElement;
    if (box && box.children.length === 1) box = box.parentElement;
    if (!box) return "";
    if (!boxes.has(box)) boxes.set(box, boxes.size + 1);
    return `${boxes.get(box)}|${el.tagName}|${[...el.classList].filter((name) => !/active|selected|current|hover|focus/i.test(name)).sort().join(".")}`;
  };
  const MOST_CONTROLS = 160; // a catalogue of cards, and no more
  const controls: Omit<ScreenNow, "path" | "placed" | "wall">["controls"] = [];
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll(`${o.clickable}, a[href], input[type=submit], input[type=button]`)) {
    if (seen.has(el) || !shown(el) || controls.length >= MOST_CONTROLS) continue;
    seen.add(el);
    const b = el as HTMLButtonElement & HTMLAnchorElement;
    const label = clean(el.getAttribute("aria-label") || b.innerText || b.value || el.getAttribute("title")).slice(0, 80);
    if (!label) continue;
    const mark = String(controls.length + 1);
    el.setAttribute("data-ctx-step", mark);
    const title = clean(el.getAttribute("aria-label") || (el.querySelector("b, strong, h1, h2, h3, h4") as HTMLElement | null)?.innerText || (b.innerText ?? "").split("\n").find((line) => line.trim())).slice(0, 80);
    const href = el.matches("a[href]") ? b.getAttribute("href") ?? undefined : undefined;
    const where = dialog?.contains(el) ? "dialog" as const : floats(el) ? "floating" as const : inChrome(el) ? "nav" as const : "main" as const;
    controls.push({
      mark, label, ...(title && title !== label ? { title } : {}), where, disabled: b.disabled === true || el.getAttribute("aria-disabled") === "true",
      primary: solid(el) || /\b(?:primary|cta)\b/i.test(b.className?.toString?.() ?? ""),
      group: groupOf(el),
      says: read?.says(el) ?? { text: label, around: "", marks: "" },
      ...(href !== undefined ? { href: b.href } : {}),
      ...(el.matches("[target=_blank], [download]") ? { away: true } : {}),
    });
  }
  const scope: ParentNode = dialog ?? document;
  const search = (f: Element) => read?.searchBox(f) === true || /search|filter/i.test(`${f.getAttribute("placeholder") ?? ""} ${f.getAttribute("aria-label") ?? ""}`);
  const boxesIn = (root: ParentNode) => [...root.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]):not([type=button]), select, textarea")].filter(shown);
  const hintOf = (f: Element) => clean(`${f.getAttribute("type") ?? ""} ${f.getAttribute("autocomplete") ?? ""} ${f.getAttribute("name") ?? ""} ${f.id} ${f.getAttribute("placeholder") ?? ""} ${f.getAttribute("aria-label") ?? ""} ${(f as HTMLInputElement).labels?.[0]?.textContent ?? ""}`);
  const forms = [...scope.querySelectorAll("form")].filter((f) => shown(f) && !inChrome(f) && !f.closest("[role=search]") && !boxesIn(f).every(search));
  const formNow = forms.find((f) => f.querySelector("button:not([type=button]):not([type=reset]), input[type=submit]") || boxesIn(f).length === 1);
  const submit = formNow?.querySelector("button:not([type=button]):not([type=reset]), input[type=submit]");
  const sends = submit?.getAttribute("data-ctx-step");
  if (sends) for (const control of controls) if (control.mark === sends) control.submits = true;
  const fields = boxesIn(scope);
  const loose = fields.filter((f) => !f.closest("form") && !search(f) && !inChrome(f));
  const alone = loose.length === 1 && (() => {
    let around: Element = loose[0]!;
    while (around.parentElement && around.parentElement !== document.body && around.parentElement.children.length === 1) around = around.parentElement;
    return (around.parentElement ?? around).querySelector("button, [role=button], input[type=submit], input[type=button]") === null;
  })();
  const stepWords = /\bstep\s+(\d+)\s*(?:of|\/|von|de|sur)\s*(\d+)\b/i.exec(document.body?.innerText ?? "");
  const progress = document.querySelector("[role=progressbar][aria-valuenow]:not([hidden])");
  const current = document.querySelector("[aria-current=step]");
  const marker = stepWords ? `${stepWords[1]} of ${stepWords[2]}` : current && shown(current) ? clean((current as HTMLElement).innerText).slice(0, 40) : progress ? `${progress.getAttribute("aria-valuenow")} of ${progress.getAttribute("aria-valuemax") ?? "100"}` : undefined;
  const wrong = new RegExp(o.wrong, "i");
  const alert = [...document.querySelectorAll("[role=alert], [aria-live=assertive]")].filter(shown).map((el) => clean((el as HTMLElement).innerText)).find((text) => wrong.test(text));
  const rowsDrawn = [...document.querySelectorAll("tr, li, [role=row], [role=listitem]")].filter((el) => shown(el) && !inChrome(el));
  const heading = [...document.querySelectorAll("h1, h2, h3, [role=heading]")].filter((el) => shown(el) && !inChrome(el)).map((el) => clean((el as HTMLElement).innerText)).find(Boolean);
  const crash = new RegExp(o.crash, "i");
  const opening = clean((document.querySelector("main, [role=main]") as HTMLElement | null)?.innerText ?? document.body?.innerText).slice(0, 400);
  return {
    fieldsKey: fields.map((f) => f.getAttribute("name") || f.id || f.getAttribute("placeholder") || f.tagName).join(","),
    rows: rowsDrawn.length, text: clean(document.body?.innerText).slice(0, 6000),
    busy: [...document.querySelectorAll("[aria-busy=true], [role=progressbar]:not([aria-valuenow]):not([aria-valuemax]), [class*=spinner], [class*=skeleton]")].some(shown),
    controls, files: [...scope.querySelectorAll("input[type=file]:not([disabled])")].length, looseBox: alone, looseFields: loose.length,
    boxHints: fields.filter((f) => !inChrome(f) && !search(f)).map(hintOf).join(" ").slice(0, 2000),
    ...(crash.test(heading ?? "") || crash.test(opening) ? { crashed: true } : {}),
    ...(heading ? { heading: heading.slice(0, 120) } : {}),
    ...(marker ? { marker } : {}),
    ...(dialog ? { dialog: clean(dialog.getAttribute("aria-label") ?? dialog.querySelector("h1, h2, h3, [role=heading]")?.textContent ?? dialog.textContent).slice(0, 120) } : {}),
    ...(alert ? { alert: alert.slice(0, 160) } : {}),
    ...(formNow ? { form: { key: `${formNow.getAttribute("action") ?? ""}|${boxesIn(formNow).map(hintOf).join(",").slice(0, 400)}`, ...(submit ? { label: clean((submit as HTMLElement).innerText || (submit as HTMLInputElement).value).slice(0, 80) } : {}), inDialog: dialog !== undefined, hints: boxesIn(formNow).map(hintOf).join(" ").slice(0, 2000), ...(boxesIn(formNow).length === 1 && !boxesIn(formNow)[0]!.matches("[required]") ? { optionalBox: true } : {}) } } : {}),
  };
}

/**
 * The journeys a new account's screens offer. No AI: a first run, what each empty state offers,
 * what starts something on a screen. Anything that reads as real money, mail or another service
 * needs no browser at all: it's listed as stopped here, and what says it destroys or signs out is
 * only counted.
 */
export function findJourneys(input: { screens: readonly ScreenReview[]; addresses?: Readonly<Record<string, string>>; first?: string | undefined; firstRun: readonly string[] }): { journeys: Journey[]; stops: WalkedJourney[]; leftAlone: number } {
  const journeys: Journey[] = [];
  const stops = new Map<string, WalkedJourney>();
  const had = new Set<string>();
  let leftAlone = 0;
  const add = (journey: Journey) => {
    const key = `${journey.start}|${FIRST_WORDS(journey.goal ?? "")}`;
    const opens = input.addresses?.[journey.start];
    if (!had.has(key)) journeys.push({ ...journey, ...(opens ? { opens } : {}) });
    had.add(key);
  };
  const stopFor = (label: string, from: string, kind: StopKind) => {
    const key = FIRST_WORDS(label);
    if (!stops.has(key) && stops.size < MOST_STOPS) stops.set(key, { name: label, from, main: false, outcome: "stopped_here", stop: { kind, label, byLabel: true }, steps: [{ screen: from, did: "stop", label }], seenWith: "stand-in" });
  };
  // A folder's own "setup" page says nothing of a first run: that's something an address says from the top.
  for (const path of input.firstRun) if (path.split("/").length === 2) add({ name: "First run", start: path, via: [], firstRun: true });
  if (input.first && FIRST_RUN_PATH.test(input.first)) add({ name: "First run", start: input.first, via: [], firstRun: true });
  for (const screen of input.screens) {
    // A sign-in or a template of an address is no place a new account can start from.
    if (SIGN_IN_PATH.test(screen.path) || SIGN_UP_PATH.test(screen.path) || !STANDS_ALONE.test(screen.path)) continue;
    const usableLabel = (label: string) => label !== MADE_UP_LINE && label.length > 0 && label.length <= MOST_LABEL;
    for (const empty of screen.empty) {
      if (!empty.next || !usableLabel(empty.next)) continue;
      const kind = stopOf({ text: empty.next, around: "", marks: "" });
      if (kind === "destroys" || kind === "sign_out") leftAlone++;
      else if (kind) stopFor(empty.next, screen.path, kind);
      else add({ name: empty.next, start: screen.path, via: [], goal: empty.next });
    }
    for (const control of screen.controls) {
      if (!usableLabel(control.label) || control.kind === "field" || control.states?.includes("disabled")) continue;
      const kind = stopOf({ text: control.label, around: "", marks: "" });
      if (control.where === "floating") continue;
      if (kind === "destroys" || kind === "sign_out") {
        leftAlone++;
        continue;
      }
      if (control.where !== "main") continue;
      if (kind) stopFor(control.label, screen.path, kind);
      else if (ENTRY.test(control.label)) add({ name: control.label, start: screen.path, via: [], goal: control.label });
    }
    for (const item of screen.locked) if (item.why !== "says" && usableLabel(item.label)) stopFor(item.label, screen.path, "paywall");
  }
  return { journeys, stops: [...stops.values()], leftAlone };
}

/** The sign-up, from what the public pass drew: its boxes, and where a real one starts. It's never pressed: a real sign-up usually sends an email, and what's behind it is walked as a made-up account instead. */
export function signUpJourney(reviews: readonly ScreenReview[]): WalkedJourney[] {
  const form = reviews.find((review) => SIGN_UP_PATH.test(review.path) && review.controls.some((c) => c.kind === "field"));
  if (!form) return [];
  const fields = form.controls.filter((c) => c.kind === "field").length;
  const submit = form.controls.find((c) => c.kind === "button" && c.where === "main" && stopOf({ text: c.label, around: "", marks: "" }) === "account") ?? form.controls.find((c) => c.kind === "button" && c.where === "main");
  const label = submit?.label ?? "the sign-up form";
  const stopped = (name: string, kind: StopKind, stop: string): WalkedJourney => ({ name, from: form.path, main: false, outcome: "stopped_here", stop: { kind, label: stop, byLabel: true }, steps: [{ screen: form.path, did: "open" }, { screen: form.path, did: "stop", label: stop }], seenWith: "stand-in" });
  return [
    { ...stopped("Sign up", "account", label), fields },
    ...form.controls.filter((c) => OUTSIDE_SIGN_IN.test(c.label)).slice(0, 4).map((c) => stopped(c.label, "third_party", c.label)),
  ];
}

const wordsOf = (text: string) => new Set(FIRST_WORDS(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3));

/** Whether a label read from the code is the main action as the code names it: most of its words. */
function isMain(label: string, main: string): boolean {
  const said = wordsOf(main);
  const here = [...wordsOf(label)];
  return sameLabel(label, main) || (here.length > 0 && here.filter((word) => said.has(word)).length * 3 >= Math.max(here.length, said.size) * 2);
}

/** How far a journey really went: the steps that moved anything on. */
const movesIn = (walked: WalkedJourney | undefined) => walked?.steps.filter((step) => step.moved).length ?? 0;

/** Steps to first value, counted from the main journey as walked and nothing else. */
export function stepsToValue(journeys: readonly WalkedJourney[]): StepsToValue | undefined {
  // Where the main action needs a record first, the first thing a new account can save is as far as a walk can say.
  const savers = journeys.filter((j) => j.outcome === "finished" && j.saved !== undefined);
  const main = journeys.find((j) => j.main && j.outcome === "finished") ?? savers.find((j) => j.firstRun) ?? savers.reduce<WalkedJourney | undefined>((most, j) => (!most || movesIn(j) > movesIn(most) ? j : most), undefined);
  if (!main) return undefined;
  // What came after the first save is the journey's and no part of getting there.
  const goal = main.steps.findIndex((s) => s.goal);
  const first = main.steps.findIndex((s, n) => s.saved && n >= goal);
  const counted = first >= 0 ? main.steps.slice(0, first + 1) : main.steps;
  // A choice taken and left on its screen for the one that got here was walked, and is no step of the way.
  const moved = counted.filter((s) => s.did !== "open" && !s.left);
  return {
    presses: moved.filter((s) => s.did === "press").length,
    fields: moved.filter((s) => s.did === "fill").length,
    screens: new Set(counted.map((s) => s.screen)).size,
    atLeast: true,
    from: main.from,
    fromFirstRun: main.firstRun === true,
    to: moved.at(-1)?.label ?? main.name,
    ...(main.main ? {} : { firstSave: true as const }),
  };
}

/**
 * The walk of a run. Journeys come in waves: from the new account's screens as each is seen, and
 * from the code read whenever that's done. They're walked main first, then the first run, then the
 * rest, by one drive or by several at once (see run), each in a browser and under a seal of its
 * own. What's been walked is always there to read, in the order the walks began whichever ended
 * first: a run that stops the walk at any moment has all of it, and is told what wasn't reached.
 */
export class JourneyWalk {
  private readonly queue: Journey[] = [];
  /** In the order they were taken from the queue, never the order they ended in. */
  private readonly walked: WalkedJourney[] = [];
  private readonly stops: WalkedJourney[] = [];
  private readonly notReached: JourneyReport["notReached"] = [];
  private readonly views: WalkedView[] = [];
  private readonly had = new Set<string>();
  private readonly looks: string[] = [];
  private readonly looked = new Set<string>();
  /** Screens the looks really came out on: one a redirect lands on, however many addresses go there, is one look. */
  private readonly landed = new Set<string>();
  private leftAlone = 0;
  /** Stops the screens offered, apart from the code's: as many as MOST_STOPS, however many waves they come in. */
  private screenStops = 0;
  /** Being walked now, on one drive or another. */
  private readonly walking = new Set<Journey>();
  /** For each drive, the one journey that goes on from where its last one stopped (see Journey.resume): only that drive's session is there. */
  private readonly goingOn = new Map<Drive, Journey>();
  private readonly resumedOn = new Map<Journey, Drive>();
  /** For each drive, the journey whose session it's left in. */
  private readonly lastOn = new Map<Drive, WalkedJourney>();
  /** The drives walking now. */
  private readonly drives = new Set<Drive>();
  /** Every drive that has walked a journey to its end. */
  private readonly walkedOn = new Set<Drive>();
  /** One drive looks around at a time: the looks are one list, and each screen is opened once. */
  private touring = false;
  /** A drive found the looks taken while they were: it's woken when they're done, and only then, or two idle drives would wake each other for ever. */
  private tourWaited = false;
  /** Waves still to come: the code read's, and any more of the screens (see more). None left, the queue takes no more. */
  private sources = 1;
  private closed = false;
  private hinted = false;
  private waiting: (() => void)[] = [];
  private readonly begun = Date.now();
  private ended: number | undefined;
  private main: string | undefined;
  private mainWords = new Set<string>();
  /** Where each journey came out on its first move, and the journey. */
  private readonly arrivals = new Map<string, WalkedJourney | Journey>();
  private readonly told: ((journey: WalkedJourney) => void)[] = [];
  private readonly walkedFrom = new Map<WalkedJourney, Journey>();
  /** When each walked journey was taken from the queue, for keeping them in that order. */
  private readonly takenAt = new Map<WalkedJourney, number>();
  private taken = 0;
  private readonly toured = new Set<string>();
  private readonly signUp: () => WalkedJourney[];
  private readonly saved: (drive: Drive) => boolean;

  constructor(found: ReturnType<typeof findJourneys>, options: { nav: readonly string[]; signUp: () => WalkedJourney[]; saved: (drive: Drive) => boolean }) {
    this.signUp = options.signUp;
    this.saved = options.saved;
    this.add(found, options.nav);
  }

  /**
   * More of what the new account's screens offer, as they're seen: the journeys go on the queue, its
   * stops and what was left alone are counted once. Each screen is to be given once, in the order it
   * was seen, so the queue's order is the one all of them at once would have had.
   */
  add(found: ReturnType<typeof findJourneys>, nav: readonly string[] = []): void {
    for (const stop of found.stops) {
      if (this.screenStops >= MOST_STOPS || this.stops.some((had) => sameLabel(had.name, stop.name))) continue;
      this.stops.push(stop);
      this.screenStops++;
    }
    this.leftAlone += found.leftAlone;
    this.looks.push(...nav.filter((path) => !this.looks.includes(path)));
    for (const journey of found.journeys) this.enqueue(journey);
  }

  /** One more wave of screens to come: the queue isn't closed until what this hands back is called. */
  more(): () => void {
    this.sources++;
    let over = false;
    return () => {
      if (over) return;
      over = true;
      this.close();
    };
  }

  private enqueue(journey: Journey): Journey | undefined {
    const key = `${journey.start}|${journey.via.join(" ")}|${FIRST_WORDS(journey.goal ?? "")}`;
    if (this.had.has(key)) return undefined;
    this.had.add(key);
    this.queue.push(journey);
    this.news();
    return journey;
  }

  /** Wakes every drive waiting for something to do. */
  private news(): void {
    for (const wake of this.waiting.splice(0)) wake();
  }

  /** What the code read found, once it has. Nothing here is source: labels and addresses that were checked. */
  addHints(hints: JourneyHints | undefined): void {
    this.hinted = hints !== undefined;
    if (!hints) return this.close();
    this.main = hints.main;
    const mainAction = hints.actions.find((action) => hints.main !== undefined && sameLabel(action.label, hints.main));
    this.mainWords = stems(`${hints.main ?? ""} ${mainAction?.does ?? ""}`);
    for (const had of this.walked) this.noteMain(had);
    // What the new account never drew comes first: its screens were looked at already.
    this.looks.unshift(...hints.screens.map((screen) => screen.path).filter((path) => STANDS_ALONE.test(path)));
    for (const action of hints.actions) {
      const says = { text: action.label, around: action.does, marks: "" };
      if (controlDestroys(says)) {
        this.leftAlone++;
        continue;
      }
      if (NAME_IN_CODE.test(action.label) || action.label.length > MOST_LABEL) continue;
      const main = hints.main !== undefined && isMain(action.label, hints.main);
      const kind = stopOf({ text: action.label, around: "", marks: "" });
      // A public screen is the public pass's, and what's on one is only news when it reads as real: "Send reset link".
      if (action.public && !["email", "payment", "third_party", "account"].includes(kind ?? "")) continue;
      if (!STANDS_ALONE.test(action.screen)) {
        this.notReached.push({ name: action.label, because: "it needs a record to exist", from: action.screen, fromCode: true });
        continue;
      }
      if (kind === "sign_out") {
        this.leftAlone++;
        continue;
      }
      if (kind) {
        if (!this.stops.some((stop) => sameLabel(stop.name, action.label))) this.stops.push({ name: action.label, from: action.screen, main: false, outcome: "stopped_here", stop: { kind, label: action.label, byLabel: true }, steps: [{ screen: action.screen, did: "stop", label: action.label }], fromCode: true, seenWith: "stand-in" });
        continue;
      }
      if (main && !this.walked.some((had) => had.main)) for (const had of [...this.walked, ...this.queue]) if (sameLabel(had.name, action.label)) had.main = true;
      const walkedThere = this.walked.some((had) => sameLabel(had.name, action.label) && had.from === action.screen) || [...this.walking].some((had) => sameLabel(had.name, action.label) && had.start === action.screen);
      if (!walkedThere) this.enqueue({ name: action.label, start: action.screen, via: [], goal: action.label, seek: `${action.label} ${action.does}`, fromCode: true, ...(main ? { main: true } : {}) });
    }
    this.close();
  }

  /** A journey that pressed the main action is the main journey, whatever it set out to do. */
  private noteMain(walked: WalkedJourney): void {
    // One that set out for it and stopped short isn't it, if another got there.
    if (walked.outcome !== "finished" && this.walked.some((had) => had.main && had.outcome === "finished")) walked.main = false;
    if (!this.main || !walked.steps.some((step) => step.label && sameLabel(step.label, this.main!))) return;
    // The way from the first run is the one a new account takes, whatever else got there by address.
    if (!walked.firstRun && this.walked.some((had) => had.main && had.firstRun && had.outcome === "finished")) return;
    for (const had of this.walked) had.main = false;
    walked.main = true;
  }

  /** How many journeys a drive has taken to walk, so far. */
  get started(): number {
    return this.taken;
  }

  /** How many drives have walked a journey to its end. */
  get walkedIn(): number {
    return this.walkedOn.size;
  }

  /** Told about each journey as it ends. */
  listen(tell: (journey: WalkedJourney) => void): void {
    this.told.push(tell);
  }

  /** One wave fewer to come (see more): with none left, the queue takes no more. */
  close(): void {
    this.sources = Math.max(0, this.sources - 1);
    if (this.sources === 0) this.closed = true;
    this.news();
  }

  private next(drive: Drive): Journey | undefined {
    // What's in words like the main action's is likely on its way, where another door to it has been seen.
    const near = (journey: Journey) => this.mainWords.size > 0 && [...stems(`${journey.name} ${journey.seek ?? ""}`)].filter((stem) => this.mainWords.has(stem)).length >= 2;
    // What makes a record is what a first value rests on: ahead of bringing one in, which ends at a file.
    // The first run is the way every new account goes, so it comes first: the code's word on what's main coming early (a read
    // kept from the last run) mustn't push it out of time. The main journey is next, and then the first run's first other choice,
    // ahead of the rest as before. Its choices after that wait for everything else, as any journey's do: each is the whole first
    // run again, for one more way out of it.
    const rank = (journey: Journey) => (journey.later ? 6 : journey.firstRun && !journey.chose ? 0 : journey.main ? 1 : journey.firstRun ? 1.5 : near(journey) ? 2 : MAKES.test(journey.name) ? 3 : journey.via.length ? 5 : 4);
    // Going on from where this drive's last one stopped costs no walk back there, and is only good now.
    const own = this.goingOn.get(drive);
    this.goingOn.delete(drive);
    // What goes on from another drive's session is that drive's to take, while it's walking: anyone else walks it from the start.
    for (const queued of this.queue) {
      const on = this.resumedOn.get(queued);
      if (queued.resume && queued !== own && (on === drive || !on || !this.drives.has(on))) {
        delete queued.resume;
        this.resumedOn.delete(queued);
      }
    }
    let best = own ? this.queue.indexOf(own) : -1;
    if (best < 0) this.queue.forEach((journey, i) => { if (!journey.resume && (best < 0 || rank(journey) < rank(this.queue[best]!))) best = i; });
    if (best < 0) return undefined;
    const next = this.queue.splice(best, 1)[0]!;
    this.resumedOn.delete(next);
    return near(next) ? { ...next, long: true } : next;
  }

  /**
   * The screens again, in a session that has something saved: an upgrade ask or a wait for value
   * shows once there's a record to wait on. A walk starts each journey afresh, so the journey
   * that saved it is walked again if another came after on this drive, the main journey first.
   * Only one drive looks at a time; the others go on walking.
   */
  private async lookAround(drive: Drive): Promise<void> {
    if (this.touring) {
      this.tourWaited = true;
      return;
    }
    this.touring = true;
    try {
      let lookingIn = this.lastOn.get(drive);
      const savers = this.walked.filter((walked) => walked.saved !== undefined);
      const saver = savers.find((walked) => walked.main) ?? savers.reduce<WalkedJourney | undefined>((most, walked) => (movesIn(walked) > movesIn(most) ? walked : most), undefined);
      if (saver && !this.toured.has(saver.name) && this.toured.size < MOST_TOURS) {
        this.toured.add(saver.name);
        const journey = this.walkedFrom.get(saver);
        if (journey && lookingIn !== saver) await walkOne(journey, drive, () => {}).catch(() => undefined);
        lookingIn = saver;
        this.lastOn.set(drive, saver);
        this.looks.unshift(...[...this.looked].filter((path) => !this.looks.includes(path)));
        this.looked.clear();
        this.landed.clear();
      }
      await this.tour(drive, lookingIn);
    } finally {
      this.touring = false;
      if (this.tourWaited) {
        this.tourWaited = false;
        this.news();
      }
    }
  }

  /** Screens opened to look, with no press: this is what meets an upgrade ask or a wait for value. */
  private async tour(drive: Drive, lookingIn: WalkedJourney | undefined): Promise<void> {
    while (this.looks.length && this.landed.size < MOST_LOOKS && !drive.stopped()) {
      const path = this.looks.shift()!;
      // An address that stands for a record ("/notes/:id") opens nothing of its own.
      if (this.looked.has(path) || !STANDS_ALONE.test(path)) continue;
      this.looked.add(path);
      drive.forgetServed();
      if (!(await drive.open(path))) continue;
      const now = await drive.look();
      if (this.landed.has(now.path)) continue;
      this.landed.add(now.path);
      // Another screen of the app drew what was saved, from a read of it: that's as good as the journey's own fresh load.
      if (lookingIn?.saved === "unknown" && drive.keptServedIn(now.text).length) lookingIn.saved = "seen";
      // What the app's own menu offers comes before what's been seen.
      const menu = now.controls.filter((c) => c.where === "nav" && c.href?.startsWith(drive.origin) && !stopOf(c.says)).map((c) => new URL(c.href!).pathname);
      this.looks.unshift(...new Set(menu.filter((address) => !this.looked.has(address) && !this.looks.includes(address))));
      // What only shows with something saved is as much a stop as what shows from the start.
      for (const control of now.controls.filter((c) => c.where === "main")) {
        const kind = stopOf(control.says, { href: control.href, away: control.away, origin: drive.origin });
        if ((kind === "paywall" || kind === "third_party" || kind === "payment" || kind === "disconnects") && !this.stops.some((stop) => sameLabel(stop.name, control.label)) && this.stops.length < MOST_STOPS * 2) {
          const label = drive.plain(control.label);
          this.stops.push({ name: label, from: now.path, main: false, outcome: "stopped_here", stop: { kind, label, byLabel: true }, steps: [{ screen: now.path, did: "stop", label }], seenWith: "stand-in" });
        }
      }
      const afterSave = this.saved(drive);
      const review = await drive.review(now.path, afterSave);
      if (!review) continue;
      const had = this.views.findIndex((view) => view.path === now.path);
      if (had >= 0) this.views.splice(had, 1);
      this.views.push({ path: now.path, ...(now.wall === "paywall" ? { gate: "paywall" as const } : {}), locked: review.locked, rows: now.rows, lines: review.text, afterSave, ...(review.heldData ? { heldData: review.heldData } : {}) });
    }
  }

  /** Journeys walked or being walked, those that came out where another had aside: what MOST_JOURNEYS counts. */
  private count(): number {
    return this.walked.filter((walked) => !walked.joins).length + this.walking.size;
  }

  /**
   * Walks on this drive until the queue's done or the drive says stop. Several drives may walk at
   * once, each called with its own: each takes the next journey as it's free, a journey that goes on
   * from a stop stays with the drive whose session it's in, and none ends while another may still
   * find more to walk.
   */
  async run(drive: Drive): Promise<void> {
    this.drives.add(drive);
    try {
      while (!drive.stopped()) {
        const journey = this.count() < MOST_JOURNEYS ? this.next(drive) : undefined;
        if (!journey) {
          await this.lookAround(drive);
          if (this.count() >= MOST_JOURNEYS || (this.closed && !this.queue.length && !this.walking.size && !this.touring)) break;
          await new Promise<void>((done) => {
            const wait = setInterval(() => { if (drive.stopped()) wake(); }, 200);
            const wake = () => {
              clearInterval(wait);
              done();
            };
            wait.unref?.();
            this.waiting.push(wake);
          });
          continue;
        }
        const at = this.taken++;
        this.walking.add(journey);
        const branch = (from: Journey, via: string[]) => this.enqueue({ name: `${from.name} › ${via.at(-1)}`, start: from.start, via });
        const joined = (now: StepLook, from: Journey) => {
          if (from.goal === undefined || from.firstRun) return undefined;
          const key = `${now.path}|${now.marker ?? ""}|${now.heading ?? ""}`;
          const had = this.arrivals.get(key);
          if (!had) this.arrivals.set(key, from);
          return had && had !== from ? this.walked.find((walked) => walked.name === (had as Journey).name) : undefined;
        };
        // Where it pressed what it came for, the other choice lies past that, as the first one did.
        const again = (from: Journey, other: StepControl, nth: number, pressedGoal: boolean, resume?: Resume) => {
          const queued = this.enqueue({ ...from, name: `${from.name} › ${other.title ?? other.label}`, via: from.goal && pressedGoal ? [...from.via, from.goal] : from.via, goal: other.label, seek: other.says.text, chose: true, later: nth > 0 && !resume, ...(resume ? { resume } : {}) });
          if (resume && queued) {
            this.goingOn.set(drive, queued);
            this.resumedOn.set(queued, drive);
          }
        };
        const walked = await walkOne(journey, drive, branch, joined, undefined, again).catch((): WalkedJourney => ({ name: drive.plain(journey.name), from: journey.start, main: journey.main === true, outcome: "couldnt_follow", why: "no_next", steps: [], seenWith: "stand-in" }));
        this.walking.delete(journey);
        this.noteMain(walked);
        // Kept in the order it was taken in: what ended first on another drive doesn't jump the list.
        const after = this.walked.findIndex((had) => (this.takenAt.get(had) ?? 0) > at);
        this.walked.splice(after < 0 ? this.walked.length : after, 0, walked);
        this.takenAt.set(walked, at);
        // Walked again for the looks, it's from the start: the session it went on from is gone.
        const { resume: _resume, ...fromStart } = journey;
        this.walkedFrom.set(walked, fromStart);
        this.lastOn.set(drive, walked);
        this.walkedOn.add(drive);
        for (const tell of this.told) {
          try {
            tell(walked);
          } catch {
            // a listener's mistake never stops the walk
          }
        }
        this.news();
        // A journey that got somewhere and saved has left the session worth looking at, and needn't be walked again to get it: the code's word on what's main may come too late.
        const gotSomewhere = walked.saved !== undefined && movesIn(walked) >= MOVES_TO_LOOK;
        if (!this.goingOn.has(drive) && ((walked.main && walked.saved !== undefined) || gotSomewhere || Date.now() - this.begun > TOUR_BY_MS)) await this.lookAround(drive);
      }
    } finally {
      this.drives.delete(drive);
      if (!this.drives.size) this.ended = Date.now();
      this.news();
    }
  }

  /** How it stands right now: the same words whether the walk ended or was cut off. */
  report(limitMs: number): JourneyReport {
    const signUp = this.signUp();
    // What the sign-up's own look found isn't found again by the code read.
    const stops = this.stops.filter((stop) => !signUp.some((up) => sameLabel(up.stop?.label ?? up.name, stop.name)));
    const journeys = [...signUp, ...this.walked.filter((j) => j.outcome !== "not_reached"), ...stops].sort((a, b) => Number(b.main) - Number(a.main));
    // Said already: the same name from the same screen. "Save" on one screen says nothing of "Save" on another.
    const said = (name: string, from: string) => journeys.some((j) => sameLabel(j.name, name) && j.from === from);
    const onScreen = (journey: Journey) => `${journey.name} on ${journey.start}${journey.fromCode ? ", read from the code" : ""}`;
    const notFinished = [...new Set([...this.walking, ...this.queue].filter((journey) => !said(journey.name, journey.start)).map(onScreen))];
    const toValue = stepsToValue(journeys);
    // A name the code gives a record's screen may have been walked on another, which has no address of its own to tell them by: that one's been said.
    const notReached = [...this.notReached, ...this.walked.filter((j) => j.outcome === "not_reached").map((j) => ({ name: j.name, from: j.from, because: j.because ?? "it never got under way" }))]
      .filter((n, i, all) => (STANDS_ALONE.test(n.from ?? "") ? !said(n.name, n.from ?? "") : !journeys.some((j) => sameLabel(j.name, n.name))) && all.findIndex((other) => sameLabel(other.name, n.name) && other.from === n.from) === i);
    const total = journeys.length + notFinished.length + notReached.length;
    return {
      status: "walked",
      message: `${total} ${total === 1 ? "journey" : "journeys"} found, walked as a made-up new account where they could be. No real server saw any of it.`,
      legend: JOURNEY_LEGEND,
      limitSeconds: Math.round(limitMs / 1000),
      // The limit stops them: what's left is closing a browser, and no more of the walk.
      seconds: Math.min(Math.round(limitMs / 1000), Math.round(((this.ended ?? Date.now()) - this.begun) / 1000)),
      journeys,
      notFinished,
      notReached,
      leftAlone: this.leftAlone,
      ...(this.main ? { mainAction: this.main } : {}),
      looked: this.views.map((view) => view.path),
      ...(toValue ? { toValue } : {}),
      ...(!this.hinted ? { noCodeHints: true as const } : {}),
      views: this.views,
    };
  }
}
