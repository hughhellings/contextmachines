import type { LearnedPage, SiteModelSnapshot } from "./learner.ts";
import { isRead } from "./naming.ts";

/**
 * The screens a person would name, out of the pages the learner keeps. The learner keeps every
 * address a page was read under, which is right for counting where people go, but not every one
 * is a screen of its own:
 *   - A view inside a screen (a tab, a step, a pop-up: "/~agents") has no address anyone can open.
 *     It is listed under its screen.
 *   - A route that shows exactly what another shows (same title, headings, buttons and fields) is
 *     that screen: an API-doc page's "#/Accounts" anchors, "/#/" next to the app's own address,
 *     "/index.htm" or "/home" next to its folder. Listed under that screen too.
 *   - A piece of HTML the page fetches for itself ("load more" at /feed/2) is a read, not a screen,
 *     even when something opened it at its own address: it has no title, as only a whole document has.
 * The learner's own pages are untouched: this is how they are shown to people and to the AI.
 */
export interface ScreenView {
  /** The view's own path, as the learner keeps it ("/~agents", "/docs/index.html#/Accounts"). */
  path: string;
  /** How to show it under its screen: "agents", "#/Accounts". */
  name: string;
}

export interface Screen extends LearnedPage {
  /** The views, tabs and look-alike routes folded into this screen, in path order. */
  views?: ScreenView[];
}

/**
 * Routes of one document that all read the same, this many or more, are a document that ignores its
 * route (an API-doc page's anchors). Two alike are not enough: a single-page app can be read a step
 * behind as it moves on, so its next screen briefly carries the last one's words.
 */
const LOOK_ALIKES = 3;

/** Segments that mean "this folder's own page": /parabank/index.htm and /home are their folder. */
const INDEX_PAGE = /^(index|default|home)(\.[a-z]+)?$/i;
const EMPTY_ROUTE = /\/#!?\/$/;

export function screensOf(site: Pick<SiteModelSnapshot, "pages" | "actions">): Screen[] {
  const fetched = new Set(site.actions.filter((a) => !a.graphqlOperation && isRead(a)).map((a) => a.path));
  const pages = site.pages.filter((p) => !(fetched.has(p.path) && !p.snapshot.title?.trim()));
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const parentOf = new Map<string, string>();

  // Tabs, steps and pop-ups belong to the screen at the address they were opened on.
  for (const p of pages) {
    const base = tabBase(p.path);
    if (base !== undefined) parentOf.set(p.path, base);
  }

  // Routes of one document (its hash routes, its index page) that look the same are one screen.
  const looks = new Map(pages.map((p) => [p.path, signature(p)]));
  const byDocument = new Map<string, LearnedPage[]>();
  for (const p of pages) {
    if (parentOf.has(p.path)) continue;
    const doc = documentOf(p.path);
    if (doc === p.path) continue;
    byDocument.set(doc, [...(byDocument.get(doc) ?? []), p]);
  }
  for (const [doc, routes] of byDocument) {
    const own = byPath.get(doc);
    const count = new Map<string, number>();
    for (const r of routes) count.set(looks.get(r.path)!, (count.get(looks.get(r.path)!) ?? 0) + 1);
    // With no page at the document's own address, the shortest of the look-alikes stands for them all (it has the photo).
    const first = new Map<string, string>();
    for (const r of [...routes].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))) if (!first.has(looks.get(r.path)!)) first.set(looks.get(r.path)!, r.path);
    for (const r of routes) {
      const look = looks.get(r.path)!;
      const sameAsDocument = own !== undefined && looks.get(own.path) === look;
      if (sameAsDocument) parentOf.set(r.path, doc);
      else if ((count.get(look) ?? 0) >= LOOK_ALIKES) {
        const into = own ? doc : first.get(look)!;
        if (into !== r.path) parentOf.set(r.path, into);
      }
    }
    // A document's empty route is the document, whatever moment it was read at. And once a document
    // has shown it ignores its route, a route that adds no words of its own is another of them,
    // caught as it drew or as it failed, not a screen beside the look-alikes.
    if (!own) continue;
    const folded = routes.filter((r) => parentOf.has(r.path)).length;
    for (const r of routes) {
      if (parentOf.has(r.path)) continue;
      if (EMPTY_ROUTE.test(r.path) ? sameWords(r, own) || sameWords(own, r) : folded >= LOOK_ALIKES && sameWords(r, own)) parentOf.set(r.path, doc);
    }
  }

  // Folded into a screen that is itself folded: into that one's screen.
  const top = (path: string): string => {
    const seen = new Set<string>();
    let at = path;
    while (parentOf.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at)!;
    }
    return at;
  };

  const screens = new Map<string, Screen>();
  for (const p of pages) if (!parentOf.has(p.path)) screens.set(p.path, { ...p });
  for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!parentOf.has(p.path)) continue;
    const at = top(p.path);
    // A screen seen only through its views (the document itself never read) is shown as the first of them.
    const screen = screens.get(at) ?? screens.set(at, { ...p, path: at }).get(at)!;
    screen.views = [...(screen.views ?? []), { path: p.path, name: viewName(p.path, at) }];
  }
  return [...screens.values()];
}

/** The address a tab or step path belongs to: "/setup/~connect" → "/setup", "/~agents" → "/". */
export function tabBase(path: string): string | undefined {
  const at = path.lastIndexOf("/~");
  return at < 0 ? undefined : path.slice(0, at) || "/";
}

/** The document a route lives in: "/docs/index.html#/Accounts" → "/docs/index.html"; "/parabank/index.htm" → "/parabank"; "/home" → "/". */
function documentOf(path: string): string {
  const hash = path.search(/\/?#!?\//);
  if (hash >= 0) return path.slice(0, hash) || "/";
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 0 && INDEX_PAGE.test(segments.at(-1)!)) return `/${segments.slice(0, -1).join("/")}`;
  return path;
}

/**
 * Whether a adds nothing to b: the same title, and one's headings all among the other's, so one
 * document read at different moments. Without headings to compare, an app with one title says
 * nothing by its words, so its controls tell: a page with neither was caught before it drew.
 */
function sameWords(a: LearnedPage, b: LearnedPage): boolean {
  if ((a.snapshot.title ?? "") !== (b.snapshot.title ?? "")) return false;
  const [x, y] = [a.snapshot.headings, b.snapshot.headings];
  if (x.length > 0 && y.length > 0) return x.every((h) => y.includes(h)) || y.every((h) => x.includes(h));
  if (x.length > 0) return false;
  return controls(a) === NO_CONTROLS || controls(a) === controls(b);
}

/** What can be pressed and filled in on a screen. */
function controls(p: LearnedPage): string {
  return JSON.stringify([p.snapshot.buttons.map((b) => b.label), p.snapshot.forms.map((f) => f.fields.map((x) => x.name))]);
}
const NO_CONTROLS = "[[],[]]";

/** What a screen shows, as far as its words and controls go. */
function signature(p: LearnedPage): string {
  return JSON.stringify([p.snapshot.title ?? "", p.snapshot.headings, controls(p)]);
}

function viewName(path: string, screen: string): string {
  const tab = /\/~([^/]*)$/.exec(path)?.[1];
  if (tab !== undefined) return tab.replace(/^\d+/, "").replace(/[-_]+/g, " ").trim() || tab;
  const hash = path.search(/\/?#!?\//);
  if (hash >= 0) return path.slice(hash).replace(/^\//, "");
  return path.startsWith(screen) && path !== screen ? path.slice(screen === "/" ? 1 : screen.length + 1) : path;
}
