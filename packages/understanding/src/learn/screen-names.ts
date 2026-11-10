import { isHeld } from "./label-gate.ts";
import { singular } from "./naming.ts";

/**
 * What to call each screen, worked out across the whole site, not one page at a time. A page's
 * own words only name it when no other screen uses them: a title or heading repeated on several
 * screens ("demosite", "XYZ Bank", a "Customer Login" sidebar, a help panel left open) is the
 * site's, not the page's. So, in order:
 *   1. its first heading (the page sends its own h1 first), when no other screen has it;
 *   2. its own part of the title ("ParaBank | Services" → "Services"; "Login - Toolshop" → "Login");
 *   3. any later heading of its own;
 *   4. its address in words ("/basic_auth" → "Basic auth", "#/manager/addCust" → "Add cust").
 * The site's start screen keeps the site's name ("todos" for the list at "/#/").
 * A screen whose address takes an id goes by its address: what it shows is whichever record the
 * learner opened ("/article/:id" is "Article", not one article's headline, or someone's name).
 * A view inside a screen (a tab or pop-up, "/~agents") is named after its screen: "Home: agents".
 * Two screens that would still share a name are told apart by their addresses.
 */
export interface NamedScreen {
  path: string;
  title?: string | null | undefined;
  headings: readonly string[];
}

/** Names longer than this were cut short when read (the page reader keeps 80 characters). */
const READ_LIMIT = 80;
/** "Login - Practice Software Testing - Toolshop", "ParaBank | Services", "React • TodoMVC". */
const TITLE_PARTS = /\s+[|·•–—-]\s+|\s+::\s+/;
/** Leading or trailing emoji, symbols and bullets: "📋 Testing Guide", "» Settings", "Done ✅". */
const DECORATION = /^(?:[\p{Extended_Pictographic}\p{So}\p{Sm}\p{Pd}·•›»️‍*|>]\s*)+|(?:\s*[\p{Extended_Pictographic}\p{So}️‍])+$/gu;
/** Segments that mean "this folder's own page": /parabank/index.htm is /parabank. */
const INDEX_PAGE = /^(index|default|home)(\.[a-z]+)?$/i;
const FILE_EXTENSION = /\.(html?|php|aspx?|jsp|cgi)$/i;

export function screenNames(screens: readonly NamedScreen[]): Map<string, string> {
  const bases = new Map<string, NamedScreen>();
  for (const s of screens) if (!bases.has(baseOf(s.path)) || baseOf(s.path) === s.path) bases.set(baseOf(s.path), s);

  // How many different screens use each heading and each title part (a screen's views count once).
  const headingUse = countUses([...bases.values()].map((s) => tidyAll(s.headings)));
  const titleUse = countUses([...bases.values()].map((s) => titleParts(s.title)));
  const shared = (use: Map<string, number>, text: string) => (use.get(text.toLowerCase()) ?? 0) >= 2;

  const root = rootOf([...bases.keys()]);
  const fromPath = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [base, s] of bases) {
    if (base.includes(":id")) {
      fromPath.set(base, pathName(base, 1));
      continue;
    }
    const headings = tidyAll(s.headings);
    const parts = titleParts(s.title);
    const ownParts = parts.filter((p) => !shared(titleUse, p));
    const isRoot = routeOf(base).join("/") === root.join("/");
    const name =
      (headings[0] && !shared(headingUse, headings[0]) ? headings[0] : undefined) ??
      (ownParts.length ? ownParts[0] : undefined) ??
      headings.find((h) => !shared(headingUse, h)) ??
      (isRoot ? headings[0] ?? parts[0] : undefined);
    if (name) names.set(base, shorten(name));
    else fromPath.set(base, pathName(base, 1));
  }
  // Screens named from their address alike ("/manager/list", "/customer/list") take one more part
  // of it, when that tells them apart.
  const alike = new Map<string, string[]>();
  for (const [base, name] of fromPath) alike.set(name.toLowerCase(), [...(alike.get(name.toLowerCase()) ?? []), base]);
  for (const group of alike.values()) {
    const longer = group.map((base) => pathName(base, 2));
    const distinct = group.length > 1 && new Set(longer.map((n) => n.toLowerCase())).size === group.length;
    group.forEach((base, i) => names.set(base, distinct ? longer[i]! : fromPath.get(base)!));
  }

  // Any two screens still named alike are told apart (unless they are one route written two ways): one record of a list ("/dynamic_loading/:id"
  // beside "/dynamic_loading") is "… (one item)"; others take the last word of their own address.
  const byName = new Map<string, string[]>();
  for (const [base, name] of names) byName.set(name.toLowerCase(), [...(byName.get(name.toLowerCase()) ?? []), base]);
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const plain = [...group].sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const base of plain.slice(1)) {
      // The same route written another way ("/#/" for "", "/home" for "/") is the same screen.
      if (routeOf(base).join("/") === routeOf(plain[0]!).join("/")) continue;
      const name = names.get(base)!;
      const last = unhashed(base).split("/").filter((x) => x && x !== "#" && x !== "#!").at(-1) ?? "";
      const tell = last === ":id" ? "one item" : words(last.replace(FILE_EXTENSION, ""));
      if (tell && tell.toLowerCase() !== name.toLowerCase()) names.set(base, `${name} (${tell})`);
    }
  }

  const out = new Map<string, string>();
  for (const s of screens) {
    const base = baseOf(s.path);
    const named = names.get(base) ?? pathName(base, 1);
    const view = /\/~([^/]*)$/.exec(s.path)?.[1];
    out.set(s.path, view && view !== "view" ? `${named.replace(/[.:!]+$/, "")}: ${words(view)}` : named);
  }
  return out;
}

/** One screen's name, worked out against the rest of the site. */
export function screenName(screens: readonly NamedScreen[], path: string): string {
  return screenNames(screens).get(path) ?? pathName(baseOf(path), 1);
}

/**
 * The names of a learned site's screens (its pages as the learner keeps them), worked out once per
 * snapshot of the site: reports and guidance ask for one name at a time.
 */
const learnedNames = new WeakMap<object, Map<string, string>>();
export function learnedScreenName(pages: readonly { path: string; snapshot: { title?: string | undefined; headings: readonly string[] } }[], path: string): string {
  let names = learnedNames.get(pages);
  if (!names) {
    names = screenNames(pages.map((p) => ({ path: p.path, title: p.snapshot.title, headings: p.snapshot.headings })));
    learnedNames.set(pages, names);
  }
  return names.get(path) ?? pathName(baseOf(path), 1);
}

/** A screen's name read from its address alone: "/setup/connect_bank" → "Connect bank". */
export function pathName(path: string, parts = 1): string {
  const route = routeOf(path);
  const own = route.filter((s) => s !== ":id");
  // "/profile/:id" is a profile; "/infinite_scroll/:id" a page of the infinite scroll. One of a
  // plural is one thing: "/articles/:id" is an article (the list beside it is the Articles).
  const picked = own.slice(-parts).map((s, i, all) => {
    const word = s.replace(FILE_EXTENSION, "");
    return i === all.length - 1 && route.at(-1) === ":id" && /^[a-z]+$/i.test(word) ? singular(word) : word;
  });
  return picked.length ? capitalise(picked.map(words).join(" ")) : "Home";
}

/** The path a screen's view belongs to: "/setup/~connect-your-bank" → "/setup". */
function baseOf(path: string): string {
  return path.replace(/\/~[^/]*$/, "") || "/";
}

/** A hash route after a file ("/x/index.html#/Accounts"), with its marker a part of its own as elsewhere. */
function unhashed(path: string): string {
  return path.replace(/([^/])#(!?)\//, "$1/#$2/");
}

/** A path's route as segments, without the hash marker or a folder's index page. */
function routeOf(path: string): string[] {
  // "/api-docs/index.html#/Accounts" is the Accounts route of the page at /api-docs, and
  // "/index.php?page=invoices" the invoices route of the page at the root.
  return unhashed(path).replace(/\?[^=/]+=/, "/").split("/").filter((s) => s && s !== "#" && s !== "#!" && !INDEX_PAGE.test(s));
}

/** The deepest route every screen sits under ("/examples/react/dist" for a TodoMVC at that address). */
function rootOf(paths: string[]): string[] {
  const routes = paths.map(routeOf);
  let common = routes[0] ?? [];
  for (const r of routes) {
    let n = 0;
    while (n < common.length && n < r.length && common[n] === r[n]) n++;
    common = common.slice(0, n);
  }
  return common;
}

function tidyAll(texts: readonly string[]): string[] {
  return texts.map(tidy).filter((t): t is string => t !== undefined);
}

/** Characters with no look of their own (U+2060 word joiner, soft hyphens, direction marks). The joiners inside emoji and some scripts stay. */
const INVISIBLE = /(?![\u200C\u200D])\p{Cf}/gu;
/** What the page reader leaves where it hid something personal ("[number] front" for a dated title). */
const REDACTED = /\[(?:number|email|token|name)\]/;
/** The shortest text worth calling a repeat: "Bye Bye" and "Walla Walla" are names. */
const MIN_REPEAT = 8;

/** A name as people would say it: no decoration, no codes for words not yet confirmed, nothing hidden by the reader. */
function tidy(text: string | null | undefined): string | undefined {
  if (!text || isHeld(text) || REDACTED.test(text)) return undefined;
  const out = once(text.replace(INVISIBLE, "").replace(DECORATION, "").replace(/\s+/g, " ").trim());
  return /\p{L}/u.test(out) ? out : undefined;
}

/**
 * The text once, when it is the same text again: a page drawing one heading twice for phones and
 * computers, with no gap, and maybe cut short by the reader on the second time round.
 */
function once(text: string): string {
  for (let n = MIN_REPEAT; n < text.length; n++) {
    const rest = text.slice(n).trimStart();
    if (rest.length * 2 < n) break;
    if (text.startsWith(rest)) return text.slice(0, n).trimEnd();
  }
  return text;
}

function titleParts(title: string | null | undefined): string[] {
  return tidyAll((title ?? "").split(TITLE_PARTS));
}

function countUses(lists: string[][]): Map<string, number> {
  const uses = new Map<string, number>();
  for (const list of lists) for (const text of new Set(list.map((t) => t.toLowerCase()))) uses.set(text, (uses.get(text) ?? 0) + 1);
  return uses;
}

/** Text cut short when read ends mid-word: end it at a word, with an ellipsis. */
function shorten(name: string): string {
  if (name.length < READ_LIMIT) return name;
  const cut = name.slice(0, READ_LIMIT).replace(/\s+\S*$/, "");
  return `${cut.replace(/[\s,;:.-]+$/, "")}…`;
}

/** "addCust" → "add cust", "basic_auth" → "basic auth", "connect-your-bank" → "connect your bank". */
function words(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_.+]+/g, " ").trim().toLowerCase();
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
