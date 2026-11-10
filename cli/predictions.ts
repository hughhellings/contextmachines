/**
 * "Might trip people up": where a new person is likely to get stuck, guessed from the map a run wrote.
 * These are hypotheses, not findings: nothing here was seen to go wrong. Each one comes from a plain
 * rule over what the map holds (screens, journeys, the saves and the buttons that make them, setup
 * steps), says what it was based on, and stays quiet unless that is clear. No AI and no opinions about
 * taste: a guess with no structural reason behind it ("looks confusing") is not made.
 *
 * Checked without a browser: node --test cli/predictions.test.ts
 */
import { asSentence, screenName, type ProductMap } from "./report.ts";

export interface Prediction {
  /** Which rule made it. */
  kind: "sign_in_first" | "needs_setup_first" | "unclear_button" | "destructive_beside_main" | "long_journey";
  /** The screen it is about, as the map names screens. */
  screen: string;
  /** The button, action or journey it is about. */
  target: string;
  /** What in the map it rests on, and the guess drawn from it. */
  why: string;
}

/** Real maps carry the main action's id beside its label; older ones only the label. */
type Learned = Omit<ProductMap, "mainAction"> & { mainAction: { id?: string; label: string } | null };
type Action = ProductMap["actions"][number];

/**
 * What the learner saw on each screen beyond what the map keeps, by the screen's path: the words on
 * its visible buttons (one entry per button, so two buttons with the same words show twice), and on
 * its links and any other control, shown or tucked in a menu. Only used to judge; none of it is
 * written anywhere.
 */
export interface Seen {
  controls?: Record<string, { buttons: readonly string[]; links: readonly string[] }>;
}

/** At most this many: a short list people read beats a long one they skip. */
const MOST = 6;

/** A screen that is only for signing in, by its address or its title (a heading can be a sidebar's login box). */
const SIGN_IN_PATH = /(^|[/#_.-])(log-?in|sign-?in|signin|auth)([/#_.?-]|$)/i;
const SIGN_IN_TITLE = /\b(log ?in|sign ?in)\b/i;
/**
 * Any sign that a newcomer can get in: making an account in the words sites use for it, in the
 * languages the learner already reads, or a business's own door (asking for access or a demo, which
 * is how a B2B product lets people in). Only ever keeps the guess quiet, so a wide net is the safe way.
 */
const SIGN_UP = /\b(sign ?up|signup|register|registration|create (an |your |a )?(free )?account|create one|(get|open) an account|new account|new here|(don.t|do not) have an account|need an account|no account|get started|start (for )?free|try (it )?(for )?free|free trial|join|request (early )?access|get access|request a demo|book a demo|get a demo|contact sales|talk to sales|registrieren|konto erstellen|konto anlegen|s.inscrire|inscription|registrarse|reg[ií]strate|crear (una )?cuenta|cadastr(ar|e)|criar (uma )?conta|registrati|iscriviti|crea(re)? un account|registreren)\b|cr[ée]er un compte/i;
/** A screen for getting into an account rather than using the product: signing in, or getting back a lost password. */
const ACCOUNT_DOOR = /(^|[/#_.-])(forgot|reset|recover)(-?password)?([/#_.?-]|$)|password/i;

/**
 * Button words that say an action happens but not which one. On a screen with one save the screen
 * says the rest; beside other saves, people have to guess which button does what.
 */
const GENERIC = /^(submit|ok|okay|go|send|save|continue|next|yes|confirm|done|apply|proceed|enter|click here)$/i;

/** Actions that destroy or stop something, in the words buttons use, or a DELETE request. */
const DESTRUCTIVE = /\b(delete|remove|shut ?down|reset|erase|wipe|destroy|discard|deactivate|terminate)\b/i;

/** A step counter on a screen ("Step 2", "2 of 4", "2/4"): the journey shows how far along people are. */
const STEP_MARKER = /\bstep \d|\b\d+ of \d+\b|\b\d+ ?\/ ?\d+\b/i;
/** A journey this long, with no counter, leaves people unsure how much is left. */
const LONG_JOURNEY = 5;

/**
 * Where a new person is likely to get stuck, most likely to matter first. Each rule is precise
 * enough that a map without the problem stays quiet; a map too thin to judge gives nothing.
 */
export function predict(map: Learned, seen: Seen = {}): Prediction[] {
  const saves = map.actions.filter((a) => a.kind !== "read");
  const main = mainActionOf(map, saves);
  const ranked: { rank: number; p: Prediction }[] = [];
  const add = (rank: number, p: Prediction) => ranked.push({ rank, p });

  const wall = signInFirst(map, seen);
  if (wall) add(0, wall);
  for (const p of needsSetupFirst(map)) add(p.target === main?.name ? 1 : 4, p);
  for (const p of unclearButtons(map, saves, seen)) add(main && p.screen === main.pages[0] ? 2 : 5, p);
  for (const p of destructiveBesideMain(map, saves, main)) add(3, p);
  for (const p of longJourneys(map, saves)) add(6, p);

  // Stable within a rank, so the same map always reads the same way; one guess about the same thing
  // in the same place is said once, however many rules or requests led to it.
  const said = new Set<string>();
  return ranked
    .map((r, k) => ({ ...r, k }))
    .sort((a, b) => a.rank - b.rank || a.k - b.k)
    .filter(({ p }) => {
      const key = `${p.kind}\n${p.screen}\n${p.target.trim().toLowerCase()}`;
      if (said.has(key)) return false;
      said.add(key);
      return true;
    })
    .slice(0, MOST)
    .map((r) => r.p);
}

/** The main action's save: by its id, else by the label on its button. */
function mainActionOf(map: Learned, saves: readonly Action[]): Action | undefined {
  const m = map.mainAction;
  if (!m) return undefined;
  const label = m.label.trim().toLowerCase();
  return saves.find((a) => m.id && a.id === m.id) ?? saves.find((a) => (a.onScreen ?? a.name).trim().toLowerCase() === label);
}

/** A screen's name for a sentence: as the site's screens are named, with one record's details left out. */
function named(map: Learned, path: string): string {
  return screenName(map.screens, path);
}

/**
 * The first screen is only for signing in, and nothing anywhere offers a way to make an account: a
 * newcomer without one may have no way in. The start screen is the one at the start address, or the
 * only screen there is (a start that sent the browser elsewhere).
 *
 * "Nothing anywhere" must be true, so it is only said when:
 * - the run covered everything it could reach (one stopped by time or a page limit may simply not
 *   have got to the sign-up page);
 * - no button or link on any screen offers to sign up, in its words or where it goes, including a
 *   link to another host (the common split: app.example.com/login linking "Sign up free" to
 *   www.example.com/signup);
 * - something public was reachable besides the way in. A site that is nothing but a sign-in door
 *   is a company's own tool or a business product, whose accounts are handed out, not signed up for;
 * - most screens weren't open without a session, where a stand-in pass ran to tell. Where they
 *   were, the app is public: newcomers use it without an account.
 */
function signInFirst(map: Learned, seen: Seen): Prediction | undefined {
  if (map.learner?.stoppedBy !== "complete") return undefined;
  let startPath = "/";
  try {
    const u = new URL(map.url);
    startPath = `${u.pathname}${u.hash}`;
  } catch {
    // An address that isn't one: only the single-screen case can name the start.
  }
  const trim = (p: string) => p.replace(/\/+$/, "") || "/";
  const start = map.screens.find((s) => trim(s.path) === trim(startPath)) ?? (map.screens.length === 1 ? map.screens[0] : undefined);
  const signIn = (s: { path: string; title?: string | null }) => SIGN_IN_PATH.test(s.path) || SIGN_IN_TITLE.test(s.title ?? "");
  if (!start || !signIn(start)) return undefined;
  if (map.screens.every((s) => signIn(s) || ACCOUNT_DOOR.test(s.path))) return undefined;
  // Only a stand-in pass tells open screens from the product behind the sign-in: without one, every screen seen was open.
  const passRan = map.screens.some((s) => s.seenWith) || map.learner?.standIn?.status === "reached" || map.learner?.standIn?.status === "no_adapter";
  const open = map.screens.filter((s) => !s.seenWith && !signIn(s) && !ACCOUNT_DOOR.test(s.path));
  if (passRan && open.length * 2 > map.screens.length) return undefined;
  const words = [
    ...map.screens.flatMap((s) => [s.path, s.title ?? "", ...s.headings]),
    ...Object.values(seen.controls ?? {}).flatMap((c) => [...c.buttons, ...c.links]),
    ...map.actions.flatMap((a) => [a.name, a.onScreen ?? "", a.request]),
    ...map.journeys.map((j) => j.name),
  ];
  if (words.some((w) => SIGN_UP.test(w.replace(/[/_-]+/g, " ")))) return undefined;
  return {
    kind: "sign_in_first",
    screen: start.path,
    target: named(map, start.path),
    why: "The first screen asks people to sign in, and it saw no way to sign up or make an account, so someone new may have no way in.",
  };
}

/**
 * A setup step (one action needs another done first) whose first part is off the journey people
 * follow to the second: following any journey there, they reach the action before they could have
 * done what it needs. Only judged when both actions' screens are known; a journey that meets the
 * first part on the way is a way in, and then nothing is said.
 */
function needsSetupFirst(map: Learned): Prediction[] {
  const byId = new Map(map.actions.filter((a) => a.id).map((a) => [a.id as string, a]));
  const out: Prediction[] = [];
  const told = new Set<string>();
  for (const step of map.setupSteps ?? []) {
    const action = byId.get(step.action);
    const needed = byId.get(step.requires);
    const at = action?.pages[0];
    if (!action || !needed || !at || !needed.pages.length) continue;
    // Every journey that reaches the action must miss what it needs: one that passes it first is the way in.
    const reaching = map.journeys.filter((j) => j.screens.includes(at));
    const misses = (j: { screens: string[] }) => !needed.pages.some((p) => j.screens.slice(0, j.screens.indexOf(at) + 1).includes(p));
    const journey = reaching[0];
    if (!journey || !reaching.every(misses)) continue;
    const key = `${action.name}\n${needed.name}`;
    if (told.has(key)) continue;
    told.add(key);
    out.push({
      kind: "needs_setup_first",
      screen: at,
      target: action.name,
      why: `"${action.name}" needs "${needed.name}" done first${step.why ? ` (${aside(step.why)})` : ""}, but the journey "${journey.name}" never passes ${named(map, needed.pages[0] as string)}, so people following it may get there too soon.`,
    });
  }
  return out;
}

/** A sentence set inside another: no capital to start (unless it starts an acronym), no full stop. */
function aside(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return /^\p{Lu}\p{Ll}/u.test(t) ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : t;
}

/**
 * A button that doesn't say what it does, beside other saves on the same screen: a generic word
 * ("Submit", "OK"), no words at all (an icon), or the same words as another button there that saves
 * something else.
 *
 * One press can send several requests (a search box asks for suggestions, saves the page's state
 * and sends a beacon), so saves with the same words on one screen are one button here: the map
 * alone can't tell them from two buttons. Two buttons with the same words are only believed when
 * the screen itself was seen to show that label on two buttons.
 */
function unclearButtons(map: Learned, saves: readonly Action[], seen: Seen): Prediction[] {
  const out: Prediction[] = [];
  const words = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const onScreens = new Set(saves.flatMap((a) => a.pages.slice(0, 1)));
  for (const screen of onScreens) {
    const buttons = new Map<string, Action[]>();
    for (const a of saves) {
      if (a.pages[0] !== screen || a.onScreen === undefined || a.onScreen === null) continue;
      buttons.set(words(a.onScreen), [...(buttons.get(words(a.onScreen)) ?? []), a]);
    }
    const shownLabels = (seen.controls?.[screen]?.buttons ?? []).map(words);
    for (const [key, sends] of buttons) {
      const label = (sends[0]!.onScreen as string).trim();
      const wordless = !/\p{L}/u.test(label);
      const names = [...new Set(sends.map((a) => a.name))];
      const twin = !wordless && new Set(sends.map((a) => a.request)).size > 1 && names.length > 1 && shownLabels.filter((l) => l === key).length > 1;
      const others = buttons.size - 1;
      if (twin) {
        out.push({
          kind: "unclear_button",
          screen,
          target: label,
          why: `"${label}" is on more than one button on ${named(map, screen)}, and they save different things (${names.slice(0, 3).map((n) => `"${n}"`).join(", ")}), so people may press the wrong one or hold back.`,
        });
        continue;
      }
      if (others < 1 || !(wordless || GENERIC.test(label))) continue;
      const shown = wordless ? (label ? `a button marked only "${label}"` : "a button with no words") : `"${label}"`;
      // What it really does, when every request it sent goes by one name that isn't its label.
      const does = names.length === 1 && names[0]!.toLowerCase() !== label.toLowerCase();
      out.push({
        kind: "unclear_button",
        screen,
        target: label || sends[0]!.name,
        why: `${shown} sits with ${others} other ${others === 1 ? "save" : "saves"} on ${named(map, screen)}, and its words don't say what it does${does ? ` (it is "${names[0]}")` : ""}, so people may press the wrong one or hold back.`,
      });
    }
  }
  return out;
}

/**
 * Something that destroys or stops things, on the same screen as the main action: one press from
 * where people spend the most time. Whether it also looks like the main button isn't in the map, so
 * this says only where it is.
 */
function destructiveBesideMain(map: Learned, saves: readonly Action[], main: Action | undefined): Prediction[] {
  if (!main?.pages.length) return [];
  const where = new Set(main.pages);
  return saves
    .filter((a) => a !== main && a.pages.some((p) => where.has(p)) && (a.request.startsWith("DELETE ") || DESTRUCTIVE.test(`${a.onScreen ?? ""} ${a.name}`)))
    .map((a) => {
      const screen = a.pages.find((p) => where.has(p)) as string;
      const label = a.onScreen || a.name;
      return {
        kind: "destructive_beside_main" as const,
        screen,
        target: label,
        why: `"${label}" (${a.name}) is on the same screen as the main action, "${asSentence(map.mainAction?.label ?? "")}", so someone reaching for one may press the other.`,
      };
    });
}

/**
 * A long journey that ends in a save, with no screen on it counting the steps: people can't tell how
 * much is left, and may give up before the save.
 */
function longJourneys(map: Learned, saves: readonly Action[]): Prediction[] {
  const saveScreens = new Set(saves.flatMap((a) => a.pages));
  return map.journeys
    .filter((j) => j.screens.length >= LONG_JOURNEY && saveScreens.has(j.screens[j.screens.length - 1] as string))
    .filter((j) => !j.screens.some((p) => {
      const s = map.screens.find((x) => x.path === p);
      return s && [s.title ?? "", ...s.headings].some((t) => STEP_MARKER.test(t));
    }))
    .map((j) => ({
      kind: "long_journey" as const,
      screen: j.screens[j.screens.length - 1] as string,
      target: j.name,
      why: `"${j.name}" takes ${j.screens.length} screens before anything is saved, and none of them shows a step count, so people may not know how much is left.`,
    }));
}
