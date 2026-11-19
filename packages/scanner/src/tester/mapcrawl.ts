/**
 * The look-only map (any-site plan 5.2 and 5.3, wave M1): a walk of the project's own origins, signed
 * in when it is given the run's account session, that records the app's parts (forms with their
 * fields, choices and buttons, lists with one sample row and their row controls, switches, filters,
 * entry buttons, counts and totals, empty-state words) and names features from them by fixed rules
 * (mapnames.ts). Under map mode's hold (mapmode.ts) for the whole session: nothing it does, and
 * nothing the pages do by themselves, can store anything. No AI.
 *
 *   - Breadth first, then depth: every top-level section found in the start page's navigation is
 *     opened before anything deeper; then the area with the fewest views seen goes next. Only
 *     addresses found on pages are opened, never invented ones. Views with the same address pattern
 *     (ids as :id, query values dropped, but a hash route and a ?tab= kept) are one view: a list of
 *     50 rows is one part, and only its first row's links are followed. The navigation is a <nav> or
 *     <header>, or a list that is a menu wherever it is (a side menu of plain links), and a button in
 *     the navigation is pressed once to see where it goes or what it shows.
 *   - A state of a page its address doesn't name (a tab not shown, a section a navigation button
 *     shows) is a view of its own, reached by pressing its way there from a fresh load. A menu a
 *     control opens ("⋯", "More actions") has its items named and pressed like any control.
 *   - Within a view, untried controls first: a control already tried on a view of the same layout
 *     isn't tried again.
 *   - Save is pressed on forms whose target is the same origin, after they are filled with the
 *     learner's made-up test values (values.ts), never a password, code or card; the request it sends
 *     is held and kept as the clue to which form posts where. A wizard's Next is followed to its end.
 *   - Never pressed, even held: sign out, and the deny list's floor (paying, buying, ordering,
 *     sending, inviting, publishing, deleting, cancelling): those are recorded with why.
 *   - Links that read like signing out or commanding (mapmode.ts getActs), and every link inside a
 *     notification, inbox or alert area, are never followed.
 *   - After every page, the account's signed-in check (check.ts verify, signed_in) runs: when it fails,
 *     that branch stops with "session lost while holding writes", the caller's signInAgain gives a
 *     new session (or the walk stops), and the walk carries on in a new browser context. The address
 *     that was open when the session was lost is never opened again, whatever its words.
 *   - What a page shows is masked before it is kept (defaultMask: emails, phone numbers, long numbers;
 *     then the caller's mask), and page addresses keep a query value only when it is a plain word.
 *   - The browser context is closed at the end, its storage with it, and never saved anywhere.
 *
 * Output: MapRun, in the shape of learn's map.json (schemaVersion "map-1", `actions` as features),
 * with the walk's parts under `mapMode` (a documented extension, read by cli/bench/mapscore.ts).
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { guardSite, refusedName } from "./act.ts";
import { withoutSecrets } from "./cache.ts";
import { verify } from "./check.ts";
import { getActs, holdForMapping, LEAKED_COVERS, pathPattern, valuePart, type HeldClue, type MapHold, type MapHoldCounts } from "../mapmode.ts";
import { featuresOf, type MapControl, type MapFeature, type MapField, type MapForm, type MapRowAction, type MapView } from "./mapnames.ts";
import { SIZE, type StorageState } from "./record.ts";
import type { Check } from "./types.ts";
import { madeUpValue, neverMadeUp, type FieldFacts } from "./values.ts";

export interface MapLimits {
  /** Views opened, at most. */
  views: number;
  minutes: number;
  /** Presses on one view, at most (forms, rows, switches, other controls). */
  pressesPerView: number;
  /** Times the walk may sign in again after losing its session. */
  signIns: number;
}
/** The time cap (the plan's "map in about 5 minutes") is the one that binds on a big app; views only stop a runaway. */
export const MAP_DEFAULTS: MapLimits = { views: 60, minutes: 5, pressesPerView: 14, signIns: 2 };

export interface MapOptions {
  url: string;
  browser: Browser;
  /** The project's origins; the start URL's origin is always one. */
  origins?: string[];
  /** The run's account session: a storageState file or the state itself. Never written back. */
  storageState?: string | StorageState;
  /** The account's signed-in check, run after every page (signin.ts signedInCheckFor). */
  signedIn?: Extract<Check, { kind: "signed_in" }>;
  /** Who the walk is signed in as (a label, never a secret), for the map. */
  signedInAs?: string;
  /** A new session after the walk lost its own (signin.ts ensureSession with force), or undefined to stop. */
  signInAgain?: () => Promise<string | StorageState | undefined>;
  limits?: Partial<MapLimits>;
  mask?: (s: string) => string;
  signal?: AbortSignal;
  on?: (e: { type: "view"; n: number; path: string } | { type: "session_lost"; path: string } | { type: "press"; words: string }) => void;
}

export interface MapRun {
  schemaVersion: "map-1";
  /** Marks this map.json as map mode's (mapscore.ts reads `actions` with their verb and entity). */
  kind: "mapmode-1";
  url: string;
  signedInAs?: string;
  createdAt: string;
  ms: number;
  /** The features, as learn's actions: id, name, pages, onScreen, plus verb, entity, controls. */
  actions: MapFeature[];
  /** Left empty on purpose: views are under mapMode, and a screen is not a feature. */
  screens: never[];
  mapMode: {
    views: MapView[];
    held: HeldClue[];
    hold: MapHoldCounts;
    /** Non-GET writes that got an answer at the route layer while mapping. Always 0; see writesLeftCovers for what it can't see. */
    writesLeft: number;
    /** What writesLeft counts and what it can't: said beside the number wherever it's shown (mapmode.ts LEAKED_COVERS). */
    writesLeftCovers: string;
    session: { checks: number; lost: string[]; signedInAgain: number };
    /** Addresses found but not opened when the walk stopped. */
    queueLeft: string[];
    stoppedBecause: "done" | "views" | "time" | "stopped" | "session_lost" | "failed";
    limits: MapLimits;
  };
}

/** How long a press is given to do something. */
const PRESS_MS = 900;
/** How long typing is given to send something by itself (a delayed autosave). */
const TYPED_WAIT_MS = 1_600;
/** How long a page is given to settle (late forms, hidden hosts). */
const SETTLE_MS = 3_000;
const SETTLE_MIN_MS = 900;
/** Signing out, or changing who is signed in ("Switch user", "Log in as", "Not you?"): the walk never does either. */
const SIGNS_OUT = /\b(sign(ing)?[ -]?out|log(ging)?[ -]?(out|off)|switch (user|account|organi[sz]ation|org|team|workspace|company|tenant|profile)s?|impersonate|(log|sign) in as|not you\b)/i;
const FLOOR_EXTRA = /\b(go live|connect (your |an |a )?(account|bank|stripe|card)|delete (my |your |the )?account|close (my |your )?account)\b/i;
/** Removing or clearing a view control, not data: pressed like any read. */
const VIEW_OBJECT = /\b(filters?|sort(ing)?|search|selection)\b/i;

/** Why the walk never presses a control with these words (sign out, the deny list's floor), or undefined. */
export function floorOf(words: string): string | undefined {
  const w = words.replace(/\s+/g, " ").trim();
  if (!w) return undefined;
  if (SIGNS_OUT.test(w)) return `"${w.slice(0, 60)}" wasn't pressed: it reads like signing out`;
  if (FLOOR_EXTRA.test(w)) return `"${w.slice(0, 60)}" wasn't pressed: it reads like going live, connecting an account or closing one`;
  if (VIEW_OBJECT.test(w) && /^(remove|clear|reset|delete)\b/i.test(w)) return undefined;
  return refusedName(w);
}

// ---------------------------------------------------------------------------------------------
// What a view shows, read in the page (self-contained: it runs there).

interface RawField {
  sel: string;
  tag: string;
  type: string;
  role: string;
  label: string;
  name: string;
  placeholder: string;
  autocomplete: string;
  inputMode: string;
  required: boolean;
  value: string;
  pattern: string;
  min: string;
  max: string;
  step: string;
  minLength: number;
  maxLength: number;
  options: string[];
  group: string;
}
interface RawGroup {
  sel: string;
  heading: string;
  fields: RawField[];
  submits: { sel: string; name: string }[];
  formAction: string;
  /** The form's method ("get" or "post"), or "" for a group with no <form>. */
  formMethod: string;
  password: boolean;
  search: boolean;
  dialog: boolean;
}
interface RawList {
  heading: string;
  kind: "table" | "list" | "rows";
  columns: string[];
  rows: number;
  sample: string;
  actions: { sel: string; name: string; href: string }[];
  firstLinks: { href: string; words: string; notif: boolean }[];
}
interface RawView {
  title: string;
  h1: string;
  groups: RawGroup[];
  lists: RawList[];
  switches: { heading: string; names: string[]; sels: string[] }[];
  buttons: { sel: string; name: string; nav: boolean; menu: boolean }[];
  /** Tabs (role=tab): each one not shown yet is a state of the view of its own. */
  tabs: { sel: string; name: string; selected: boolean; href: string }[];
  links: { href: string; words: string; nav: boolean; notif: boolean; method: string; inList: boolean }[];
  counts: string[];
  empty: string[];
  fieldSels: string[];
  layout: string;
}

export function readView(): RawView {
  const w = window as unknown as { __cmMapN?: number };
  const T = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  // The page's own globals can hide the browser's (a page's "const CSS = ..."): an escape of our own.
  const cssEscape = (v: string) => v.replace(/^(-?)(\d)/, (_m, dash: string, d: string) => `${dash}\\3${d} `).replace(/[^\w-]/g, (c) => `\\${c}`);
  const mark = (el: Element) => {
    let m = el.getAttribute("data-cm-map");
    if (!m) {
      w.__cmMapN = (w.__cmMapN ?? 0) + 1;
      m = String(w.__cmMapN);
      el.setAttribute("data-cm-map", m);
    }
    return `[data-cm-map="${m}"]`;
  };
  /** A selector that survives a redraw when the element has an id or a name; else its mark. */
  const selOf = (el: Element) => {
    const id = el.getAttribute("id");
    if (id && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) return `#${cssEscape(id)}`;
    const name = el.getAttribute("name");
    if (name && el.tagName !== "BUTTON" && document.querySelectorAll(`${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`).length === 1) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    return mark(el);
  };
  const H = "h1,h2,h3,h4,h5,h6,[role=heading],legend";
  const headingOf = (el: Element): string => {
    let cur: Element | null = el;
    let steps = 0;
    while (cur && cur !== document.body && steps < 300) {
      let sib = cur.previousElementSibling;
      while (sib && steps++ < 300) {
        if (sib.matches(H) && shown(sib)) return T(sib.textContent);
        const inner = [...sib.querySelectorAll(H)].filter(shown).pop();
        if (inner) return T(inner.textContent);
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return "";
  };
  const nameOf = (el: Element) => {
    const by = el.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
    const img = el.querySelector("img[alt]")?.getAttribute("alt");
    return T(el.getAttribute("aria-label") || labelled || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("title") || img || "").slice(0, 80);
  };
  const labelOf = (el: Element) => {
    const f = el as HTMLInputElement;
    const by = el.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
    const own = (l: HTMLLabelElement) => [...l.childNodes].filter((n) => n.nodeType === 3 || (n as Element).tagName === "SPAN").map((n) => n.textContent ?? "").join(" ");
    return T(el.getAttribute("aria-label") || labelled || (f.labels?.[0] ? own(f.labels[0]) : "") || el.getAttribute("placeholder") || "").slice(0, 60);
  };
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [role=combobox], [contenteditable="true"]';
  const BUTTON = 'button, [role=button], [role=menuitem], input[type=button], input[type=submit]';
  const isSwitch = (el: Element) => el.getAttribute("role") === "switch";
  const fieldEls = [...document.querySelectorAll(FIELD)].filter((el) => shown(el) && !isSwitch(el) && !(el.getAttribute("role") === "combobox" && el.tagName === "DIV" && el.querySelector("input")));
  const rowOf = (el: Element) => el.closest("tr, li, [role=row]");
  const buttonEls = [...document.querySelectorAll(BUTTON)].filter((el) => shown(el) && !isSwitch(el) && !/^(radio|tab|option|menuitemradio|checkbox)$/.test(el.getAttribute("role") ?? ""));
  const LISTISH = "table, ul, ol, [role=list], [role=grid], [role=table]";

  // Forms: each <form>, and each group of fields around the button that sends them.
  /**
   * Groups, keyed by their box. A loose group is fields with no box of their own (laid out straight
   * in the page): its button is the first one after its fields with no heading, field or form between
   * (a "New card" box and its "Save card"), or none (Enter sends it).
   */
  const containers = new Map<Element, { box: Element; fields: Element[]; loose: boolean; submit?: Element }>();
  const headings = [...document.querySelectorAll(H)].filter(shown);
  const between = (a: Element, b: Element, els: Element[]) => els.some((x) => x !== a && x !== b && !x.contains(a) && !x.contains(b) && a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && x.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  for (const el of fieldEls) {
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    let box: Element | null = form ?? el.closest("dialog, [role=dialog]");
    let loose = false;
    let submit: Element | undefined;
    if (!box) {
      let cur: Element | null = el.parentElement;
      while (cur && cur !== document.body) {
        // A form group never holds the page's own heading, its lists or another form: stop below them.
        if (cur.querySelector("h1, form") || [...cur.querySelectorAll(LISTISH)].some((l) => !l.contains(el) && shown(l) && !l.closest("[role=listbox]"))) break;
        if (buttonEls.some((b) => cur!.contains(b) && !rowOf(b))) {
          box = cur;
          break;
        }
        cur = cur.parentElement;
      }
      if (!box) {
        loose = true;
        submit = buttonEls.find((b) => !b.closest("form") && !rowOf(b) && el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && !between(el, b, [...headings, ...fieldEls, ...document.querySelectorAll("form, table, ul, ol")]));
        box = el.parentElement ?? el;
      }
    }
    if (rowOf(el) && !box.contains(rowOf(el)!)) continue; // a box inside a row: the row's own editor
    const key = loose ? (submit ?? el) : box;
    const c = containers.get(key) ?? { box, fields: [], loose, ...(submit ? { submit } : {}) };
    c.fields.push(el);
    containers.set(key, c);
  }
  const SUBMIT = /^(save|add|create|submit|done|next|continue|send|post|update|apply|confirm|finish|keep|go|search|ok|sign in|log in|register|upload|import|invite|publish|book)\b/i;
  const groups: RawGroup[] = [];
  for (const c of containers.values()) {
    const box = c.box;
    const radios = new Set<string>();
    const fields: RawField[] = [];
    for (const el of c.fields) {
      const f = el as HTMLInputElement;
      const type = (el.getAttribute("type") ?? (el.tagName === "INPUT" ? "text" : el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("role") ?? "")).toLowerCase();
      if (type === "radio") {
        if (radios.has(f.name)) continue;
        radios.add(f.name);
      }
      const group = type === "radio" ? f.name : "";
      const options = el.tagName === "SELECT" ? [...(el as HTMLSelectElement).options].filter((o) => o.value !== "" && !o.disabled).map((o) => T(o.label)).slice(0, 12)
        : type === "radio" ? [...document.querySelectorAll(`input[type=radio][name="${cssEscape(f.name)}"]`)].map((r) => T((r as HTMLInputElement).labels?.[0]?.textContent || (r as HTMLInputElement).value)).slice(0, 12) : [];
      const fieldset = type === "radio" ? T(el.closest("fieldset")?.querySelector("legend")?.textContent) : "";
      fields.push({ sel: selOf(el), tag: el.tagName.toLowerCase(), type, role: el.getAttribute("role") ?? "", label: fieldset || labelOf(el) || T(f.name), name: f.name ?? "", placeholder: el.getAttribute("placeholder") ?? "", autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(), inputMode: el.getAttribute("inputmode") ?? "", required: f.required || el.getAttribute("aria-required") === "true", value: el.tagName === "SELECT" ? "" : type === "checkbox" || type === "radio" ? "" : (el as HTMLElement).isContentEditable ? T(el.textContent) : f.value ?? "", pattern: el.getAttribute("pattern") ?? "", min: el.getAttribute("min") ?? "", max: el.getAttribute("max") ?? "", step: el.getAttribute("step") ?? "", minLength: typeof f.minLength === "number" ? f.minLength : -1, maxLength: typeof f.maxLength === "number" ? f.maxLength : -1, options, group });
    }
    // Radio buttons drawn as buttons (role=radio in a radiogroup): one choice field.
    for (const rg of [...box.querySelectorAll("[role=radiogroup]")].filter(shown)) {
      const opts = [...rg.querySelectorAll("[role=radio]")];
      if (!opts.length) continue;
      const by = rg.getAttribute("aria-labelledby");
      fields.push({ sel: selOf(opts[0]!), tag: "button", type: "radio", role: "radio", label: T(rg.getAttribute("aria-label") || (by ? document.getElementById(by)?.textContent : "")), name: "", placeholder: "", autocomplete: "", inputMode: "", required: false, value: "", pattern: "", min: "", max: "", step: "", minLength: -1, maxLength: -1, options: opts.map((o) => nameOf(o)).slice(0, 12), group: "" });
    }
    const submits = (c.loose ? (c.submit ? [c.submit] : []) : buttonEls.filter((b) => box.contains(b) && !rowOf(b) && !b.closest("[role=radiogroup]"))).map((b) => ({ sel: selOf(b), name: nameOf(b), el: b }));
    submits.sort((a, b) => Number(SUBMIT.test(b.name)) - Number(SUBMIT.test(a.name)) || Number((b.el as HTMLButtonElement).type === "submit") - Number((a.el as HTMLButtonElement).type === "submit"));
    const form = box.tagName === "FORM" ? (box as HTMLFormElement) : null;
    const firstField = c.fields[0]!;
    // The nearest heading before its first field, inside it; else the nearest before it.
    const inner = [...box.querySelectorAll(H)].filter((h) => shown(h) && h.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    groups.push({
      sel: box === document.body ? "body" : selOf(box),
      heading: c.loose ? headingOf(firstField) : T(box.getAttribute("aria-label")) || T(inner?.textContent) || headingOf(box),
      fields,
      submits: submits.map(({ sel, name }) => ({ sel, name })),
      formAction: form ? form.action : "",
      // Only a method the form says: a script's form (onSubmit) has none, and what it sends says what it does.
      formMethod: form ? (form.getAttribute("method") ?? "").toLowerCase() : "",
      password: c.loose ? c.fields.some((f) => f.getAttribute("type") === "password") : Boolean(box.querySelector("input[type=password]")),
      search: Boolean(box.matches("[role=search]") || box.closest("[role=search]") || box.querySelector("input[type=search]") || (form && /search/i.test(form.action)) || (fields.length === 1 && /^(q|query|s|search)$/i.test(fields[0]!.name))),
      dialog: Boolean(box.closest("dialog, [role=dialog]")),
    });
  }
  const inGroup = (el: Element) => [...containers.values()].some((c) => (c.loose ? c.fields.includes(el) || c.submit === el : c.box.contains(el)));

  const NOTIF = /notif|inbox|alert|bell|mention|messages?\b|unread/i;
  /** Inside a notification, inbox or alert area: its links are never followed. */
  const notifIn = (a: Element) => {
    for (let x: Element | null = a; x && x !== document.body; x = x.parentElement) {
      if (NOTIF.test(`${x.id} ${typeof x.className === "string" ? x.className : ""} ${x.getAttribute("aria-label") ?? ""} ${x.getAttribute("role") === "alert" || x.getAttribute("role") === "log" ? "alert" : ""}`)) return true;
    }
    return false;
  };
  // Lists: tables, lists outside the header and navigation, and repeated rows of the same controls.
  const lists: RawList[] = [];
  const rowActions = (row: Element, rowText: string) => {
    const strip = (name: string) => {
      let n = name;
      for (const cell of [...row.querySelectorAll("td, th, strong, span, b, a")].map((c) => T(c.textContent)).filter((t) => t.length >= 3 && t.length < 80)) if (n !== cell) n = n.split(cell).join(" ");
      return T(n.replace(rowText && rowText.length >= 3 && n !== rowText ? rowText : "\u0000", " ")) || name;
    };
    const acts = [...row.querySelectorAll(BUTTON)].filter((b) => shown(b) && !isSwitch(b)).map((b) => ({ sel: selOf(b), name: strip(nameOf(b)), href: "" }));
    const links = [...row.querySelectorAll("a[href]")].filter(shown).map((a) => ({ href: (a as HTMLAnchorElement).href, words: T(a.textContent) || a.getAttribute("aria-label") || "", notif: notifIn(a) }));
    // A link in a row that names a job ("Remove", "Edit", "Archive") is one of the row's controls too.
    for (const a of links) if (/^(edit|rename|update|change|delete|remove|trash|archive|unarchive|publish|approve|reject|complete|mark|duplicate|copy|cancel|close|reopen)\b/i.test(a.words)) acts.push({ sel: "", name: strip(a.words), href: a.href });
    return { acts, links };
  };
  const navLike = (el: Element) => Boolean(el.closest("header, nav, [role=navigation], footer, [role=listbox], [role=menu], [role=tablist]"));
  /** A link's place, roughly: its path with number-bearing parts as :id, and a hash route. */
  const linkKey = (href: string) => {
    try {
      const x = new URL(href, location.href);
      const route = /^#!?\//.test(x.hash) ? x.hash.split("?")[0]! : "";
      return `${x.pathname}${route}`.split("/").filter(Boolean).map((p) => (/\d/.test(p) ? ":id" : p)).join("/");
    } catch {
      return href;
    }
  };
  const main = document.querySelector("main, [role=main]");
  /** A side menu: in an aside, or a box its code calls a sidebar or side menu. */
  const sideLike = (el: Element) => Boolean(el.closest("aside, [class*=sidebar i], [class*=sidenav i], [class*=side-nav i], [id*=sidebar i], [class*=menu i]:not(li)"));
  /**
   * A list that is a menu, not data, though it isn't in a <nav>: every item is one short link and
   * nothing else, the links go to different places, and the list is a side menu, outside the page's
   * main part, or leads to two or more different sections.
   */
  const menuList = (l: Element): boolean => {
    const items = [...l.children].filter((c) => c.matches("li, [role=listitem]"));
    if (items.length < 2) return false;
    for (const it of items) {
      if (it.querySelectorAll("a[href]").length !== 1 || it.querySelector(`${BUTTON}, ${FIELD}`) || T((it as HTMLElement).innerText).length > 40) return false;
    }
    const keys = items.map((it) => linkKey((it.querySelector("a[href]") as HTMLAnchorElement).href));
    const distinct = new Set(keys);
    if (distinct.size < Math.min(3, items.length) || distinct.size / items.length < 0.6) return false;
    const parents = new Set(keys.map((k) => k.split("/").slice(0, -1).join("/")));
    return sideLike(l) || (main !== null && !main.contains(l)) || parents.size >= 2;
  };
  const menus = new Set([...document.querySelectorAll("ul, ol, [role=list]")].filter((l) => !navLike(l) && menuList(l)));
  const inMenu = (el: Element) => [...menus].some((m) => m.contains(el));
  for (const t of [...document.querySelectorAll("table, [role=grid], [role=table]")].filter((t) => shown(t) && !navLike(t))) {
    const rows = [...t.querySelectorAll("tr, [role=row]")].filter((r) => !r.querySelector("th") && !r.closest("thead"));
    const first = rows.find(shown);
    const ra = first ? rowActions(first, "") : { acts: [], links: [] };
    lists.push({ heading: T(t.querySelector("caption")?.textContent) || headingOf(t), kind: "table", columns: [...t.querySelectorAll("th, [role=columnheader]")].map((h) => T(h.textContent)).filter(Boolean).slice(0, 12), rows: rows.length, sample: first ? T((first as HTMLElement).innerText).slice(0, 160) : "", actions: ra.acts, firstLinks: ra.links });
  }
  for (const l of [...document.querySelectorAll("ul, ol, [role=list]")].filter((l) => !navLike(l) && !menus.has(l) && !l.closest("table") && !l.querySelector(FIELD))) {
    const items = [...l.children].filter((c) => c.matches("li, [role=listitem]"));
    const heading = headingOf(l);
    if (!shown(l) && !(items.length === 0 && heading)) continue;
    if (!items.length && !(heading && (l.id || l.previousElementSibling?.matches(H)))) continue;
    const first = items.find(shown);
    const ra = first ? rowActions(first, "") : { acts: [], links: [] };
    lists.push({ heading, kind: "list", columns: [], rows: items.length, sample: first ? T((first as HTMLElement).innerText).slice(0, 160) : "", actions: ra.acts, firstLinks: ra.links });
  }
  // Repeated rows: two or more siblings of one tag, each with the same controls and no fields.
  const seenParents = new Set<Element>();
  for (const b of buttonEls) {
    let row: Element | null = null;
    for (let x: Element | null = b.parentElement; x && x !== document.body; x = x.parentElement) {
      const p: Element | null = x.parentElement;
      const tag = x.tagName;
      if (p && [...p.children].filter((s) => s.tagName === tag && s.querySelector(BUTTON)).length >= 2) {
        row = x;
        break;
      }
    }
    if (!row || row.closest(LISTISH) || inGroup(row) || navLike(row) || row.querySelector(FIELD)) continue;
    const parent = row.parentElement!;
    if (seenParents.has(parent)) continue;
    seenParents.add(parent);
    const siblings = [...parent.children].filter((s) => s.tagName === row.tagName && s.querySelector(BUTTON) && shown(s));
    const sig = (s: Element) => [...s.querySelectorAll(BUTTON)].filter((x) => !isSwitch(x)).map((x) => nameOf(x).replace(/\d+/g, "#")).join("|");
    const same = siblings.filter((s) => sig(s) === sig(siblings[0]!));
    if (same.length < 2 || !sig(same[0]!)) continue;
    for (const r of same) r.setAttribute("data-cm-row", "1");
    const first = same[0]!;
    const own = T([...first.childNodes].filter((n) => !(n as Element).matches?.(BUTTON)).map((n) => n.textContent).join(" "));
    const ra = rowActions(first, own);
    lists.push({ heading: headingOf(first), kind: "rows", columns: [], rows: same.length, sample: T((first as HTMLElement).innerText).slice(0, 160), actions: ra.acts, firstLinks: ra.links });
  }
  const inList = (el: Element) => Boolean(el.closest("table, [role=grid], [role=table], [data-cm-row]") || (el.closest("li") && !navLike(el) && !inMenu(el)));

  // Switches, grouped by their heading.
  const switches: RawView["switches"] = [];
  for (const s of [...document.querySelectorAll('[role=switch], input[type=checkbox][role=switch]')].filter(shown)) {
    const heading = headingOf(s) || T(document.querySelector("h1")?.textContent);
    let g = switches.find((x) => x.heading === heading);
    if (!g) switches.push((g = { heading, names: [], sels: [] }));
    g.names.push(nameOf(s).replace(/\b(on|off)$/i, "").trim() || labelOf(s));
    g.sels.push(selOf(s));
  }

  const menuOf = (b: Element) => b.closest("[role=menu], [role=menubar], menu, [role=listbox]");
  const buttons = buttonEls.filter((b) => !inGroup(b) && !inList(b) && !b.closest("[role=radiogroup]")).map((b) => ({ sel: selOf(b), name: nameOf(b), nav: navLike(b) && !menuOf(b), menu: Boolean(menuOf(b)) || b.getAttribute("role") === "menuitem" }));
  const links = [...document.querySelectorAll("a[href]")].map((a) => ({ href: (a as HTMLAnchorElement).href, words: (T(a.textContent) || a.getAttribute("aria-label") || a.getAttribute("title") || "").slice(0, 80), nav: navLike(a) || inMenu(a) || (sideLike(a) && !inList(a)), notif: notifIn(a), method: (a.getAttribute("data-method") || a.getAttribute("data-turbo-method") || "").toLowerCase(), inList: inList(a) }));
  const tabs = [...document.querySelectorAll("[role=tab]")].filter(shown).map((t) => ({ sel: selOf(t), name: nameOf(t), selected: t.getAttribute("aria-selected") === "true" || t.getAttribute("aria-current") === "page", href: (t as HTMLAnchorElement).href ?? "" }));

  const leaves = [...document.querySelectorAll("body *")].filter((e) => e.children.length <= 2 && !e.querySelector(H) && shown(e) && !e.closest("script, style, header, nav"));
  const counts: string[] = [];
  const empty: string[] = [];
  for (const e of leaves) {
    const t = T((e as HTMLElement).innerText);
    if (!t || t.length > 120) continue;
    if (counts.length < 10 && !counts.includes(t) && (/^[\p{L} ]{2,30}:\s*[£$€]?\s?\d[\d,.]*\s*\p{L}{0,12}$/u.test(t) || /^\d[\d,.]*\s+\p{L}+( \p{L}+)?$/u.test(t) || /\b(showing|total|balance)\b.*\d/i.test(t) || /\b\d+ of \d+\b/.test(t))) counts.push(t);
    if (empty.length < 10 && !empty.includes(t) && /\b(no [\p{L} ]{1,30} yet|nothing (here|yet|to show)|none yet|(is|are) empty|no results|no matches|you have no|get started)\b/iu.test(t)) empty.push(t);
  }
  return {
    title: document.title,
    h1: T(document.querySelector("h1")?.textContent) || T([...document.querySelectorAll("h2")].find(shown)?.textContent),
    groups,
    lists,
    switches,
    buttons,
    tabs,
    links,
    counts,
    empty,
    fieldSels: fieldEls.map(selOf),
    layout: `${groups.map((g) => g.fields.length).join(",")}|${lists.map((l) => l.kind).join(",")}|${switches.length}|${Math.min(9, buttons.length)}`,
  };
}

// ---------------------------------------------------------------------------------------------

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** Query keys that choose what a page shows (a tab, a section), not what it lists: their values are part of a view's identity. */
const VIEW_KEYS = /^(tab|view|section|panel|pane|screen|mode|subpage|settings?)$/i;
/** A hash route (#/clients, #!/clients), as a single-page app's router writes one; a plain #anchor is the same page. */
export const hashRoute = (x: URL) => {
  const route = /^#!?\//.test(x.hash) ? x.hash.replace(/^#!?/, "") : "";
  // "#/" is the router's start: the page itself.
  return route === "/" ? "" : route;
};
/**
 * A view's identity: its address with ids as :id and query values dropped, but a hash route kept (as
 * its own pattern) and the value of a key that picks a tab or section (?tab=billing) kept.
 */
export const viewKey = (u: string) => {
  try {
    const x = new URL(u);
    const route = hashRoute(x);
    const picks = [...x.searchParams].filter(([k, v]) => VIEW_KEYS.test(k) && /^[\w-]{1,30}$/.test(v)).map(([k, v]) => `${k}=${v.toLowerCase()}`).sort();
    return `${x.origin}${pathPattern(x).split("?")[0]}${picks.length ? `?${picks.join("&")}` : ""}${route ? `#${pathPattern(new URL(route, "http://x")).split("?")[0]}` : ""}`;
  } catch {
    return u;
  }
};

/**
 * The walk's own masking, under the caller's: emails, phone numbers, long numbers and card-like runs
 * in what a page shows (a sample row, a heading) are replaced, so a map never carries them.
 */
export function defaultMask(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "{email}")
    .replace(/(?<![\w.])\+?\d[\d ().-]{7,}\d(?![\w])/g, (m) => (/^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(m) ? m : "{number}"))
    .replace(/\b\d{5,}\b/g, "{number}");
}

/** A page address as a map shows it: a value-shaped path part as :value, a query value kept only when it is a plain word. */
export function shownPath(x: URL): string {
  const parts = x.pathname.split("/");
  const path = parts.map((p, i) => (p && valuePart(p, parts[i - 1]) ? ":value" : p)).join("/");
  const q = [...x.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${/^[a-z][\w-]{0,30}$/i.test(v) && !/\d{3,}/.test(v) ? encodeURIComponent(v) : ":value"}`);
  const route = hashRoute(x);
  return `${path}${q.length ? `?${q.join("&")}` : ""}${route ? `#${shownPath(new URL(route, "http://x")).replace(/^\//, "/")}` : ""}`;
}

/** Map a site, look only, under map mode's hold. */
export async function mapSite(o: MapOptions): Promise<MapRun> {
  const limits: MapLimits = { ...MAP_DEFAULTS, ...Object.fromEntries(Object.entries(o.limits ?? {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0)) };
  /** The caller's mask: for addresses (shownPath already masks their values). */
  const callerMask = o.mask ?? ((s: string) => s);
  /** For what a page shows: the walk's own masking under the caller's. */
  const mask = (s: string) => defaultMask(callerMask(s));
  const begun = Date.now();
  const deadline = begun + limits.minutes * 60_000;
  const origins = new Set([originOf(o.url), ...(o.origins ?? []).map(originOf)].filter(Boolean));
  const start = new URL(o.url);
  const startDir = start.pathname.endsWith("/") ? start.pathname : start.pathname.replace(/[^/]*$/, "");
  const pathOf = (u: string) => {
    try {
      const x = new URL(withoutSecrets(new URL(u).href));
      return callerMask(`${origins.size > 1 ? x.origin : ""}${shownPath(x)}`).slice(0, 200);
    } catch {
      return mask(u).slice(0, 200);
    }
  };
  const areaOf = (u: string) => {
    try {
      const p = new URL(u).pathname;
      return p.startsWith(startDir) ? (p.slice(startDir.length).split("/")[0] ?? "") : p.split("/")[1] ?? "";
    } catch {
      return "";
    }
  };
  const clip = (s: string, n = 200) => mask(s.replace(/\s+/g, " ").trim()).slice(0, n);
  const emit = (e: Parameters<NonNullable<MapOptions["on"]>>[0]) => {
    try {
      o.on?.(e);
    } catch {
      // a listener's error never stops the walk
    }
  };

  const views: MapView[] = [];
  const clues: HeldClue[] = [];
  const counts: MapHoldCounts = { held: 0, wsFramesHeld: 0, wsRefused: 0, beaconsHeld: 0, graphqlReadsPassed: 0, leaked: 0, redirectsChecked: 0, speculationRemoved: 0 };
  const session = { checks: 0, lost: [] as string[], signedInAgain: 0 };
  let stoppedBecause: MapRun["mapMode"]["stoppedBecause"] = "done";
  /** Controls tried, by view layout: untried ones first, and each once per layout. */
  const tried = new Set<string>();
  const seenViews = new Set<string>();
  /** A step that shows a state of a page its address alone doesn't (a tab, a section a button shows). */
  type Step = { sel: string; name: string; kind?: "tab" | "nav" };
  const queue: { url: string; depth: number; area: string; top: boolean; from?: { path: string; words: string }; via?: Step[] }[] = [{ url: o.url, depth: 0, area: areaOf(o.url), top: true }];
  const queued = new Set([viewKey(o.url)]);
  /** Addresses never opened again: opening one ended the session (a "Switch user" link, whatever its words). */
  const neverFollow = new Set<string>();

  let state = o.storageState;
  let context!: BrowserContext;
  let page!: Page;
  let hold!: MapHold;
  /** Clue numbers from earlier contexts carry on, so they stay unique in the map. */
  let clueBase = 0;
  const open = async () => {
    context = await o.browser.newContext({ viewport: SIZE, serviceWorkers: "block", acceptDownloads: false, ...(state ? { storageState: state as string } : {}) });
    page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    // The site guard first and the hold after it: Playwright runs the route added last first, so every
    // request meets the hold before anything else can answer it (the guard answers page loads itself).
    await guardSite(page, o.url, [...origins].map((x) => new URL(x).host).filter((h) => h !== start.host));
    hold = await holdForMapping(context, { keepOn: (u) => origins.has(originOf(u)) });
  };
  /** Moves this context's clues and counts into the walk's, numbered on. */
  const harvest = () => {
    for (const c of hold.clues.splice(0)) clues.push({ ...c, n: clueBase + c.n });
    clueBase = clues.length ? clues.at(-1)!.n : clueBase;
    for (const k of Object.keys(counts) as (keyof MapHoldCounts)[]) counts[k] += hold.counts[k];
    for (const k of Object.keys(hold.counts) as (keyof MapHoldCounts)[]) hold.counts[k] = 0;
  };
  /** Clue numbers (walk-wide) for this context's clues from index i. */
  /**
   * Requests a page sends by itself (on load, on a timer: a token refresh, a presence ping) are the
   * page's, never a press's: any method and path first seen with no press under way is one of those.
   */
  const ambient = new Set<string>();
  /** The view being walked, and a fresh load of it (for a menu's items, each pressed from a fresh load). */
  let currentView: MapView | undefined;
  let reloadForMenu: () => Promise<void> = async () => {};
  const keyOf = (c: Pick<HeldClue, "method" | "path">) => `${c.method} ${c.path}`;
  const cluesSince = (i: number) => {
    for (const c of hold.clues) if (!c.press) ambient.add(keyOf(c));
    return hold.clues.slice(i).filter((c) => !ambient.has(keyOf(c))).map((c) => clueBase + c.n);
  };
  await open();

  const settle = async (p: Page) => {
    await p.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
    // A page that draws itself late (a hidden host, a list it fetches): wait until it stops changing.
    // At least SETTLE_MIN_MS, then until three looks in a row agree, at most SETTLE_MS.
    let last = "";
    let same = 0;
    const from = Date.now();
    while (Date.now() < from + SETTLE_MS) {
      const now = await p.evaluate(() => `${document.body?.innerHTML.length ?? 0}|${[...document.querySelectorAll("[hidden]")].length}|${document.body?.innerText.length ?? 0}`).catch(() => "");
      same = now && now === last ? same + 1 : 0;
      last = now;
      if (same >= 2 && Date.now() - from >= SETTLE_MIN_MS) break;
      await p.waitForTimeout(250);
    }
  };
  const goto = async (u: string): Promise<boolean> => {
    // A hash route on the page already open would only change the hash: the page is loaded afresh instead,
    // so each view starts from its own load (and a press's leftovers go with the old one).
    const target = new URL(u);
    const was = (() => {
      try {
        return new URL(page.url());
      } catch {
        return undefined;
      }
    })();
    if (target.hash && was && was.href.split("#")[0] === target.href.split("#")[0]) await page.goto("about:blank").catch(() => null);
    const res = await page.goto(u, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
    await settle(page);
    return Boolean(res) || (target.hash !== "" && page.url().split("#")[0] === target.href.split("#")[0]);
  };
  /** Opens a state of a page: its address, then the presses that show it (a tab), each settled. */
  const openState = async (u: string, via: readonly Step[] = []): Promise<boolean> => {
    if (!(await goto(u))) return false;
    for (const st of via) {
      // The same page marks its controls the same way on each load: read it so the step's mark is there.
      await page.evaluate(readView).catch(() => undefined);
      const ok = await page.locator(st.sel).first().click({ timeout: 2_000 }).then(() => true, () => false);
      if (!ok) return false;
      await settle(page);
    }
    return true;
  };
  const stillSignedIn = async (): Promise<boolean> => {
    if (!o.signedIn) return true;
    session.checks++;
    return (await verify(page, o.signedIn, 1_000).catch(() => ({ ok: false }))).ok;
  };

  try {
    while (queue.length) {
      if (o.signal?.aborted) {
        stoppedBecause = "stopped";
        break;
      }
      if (Date.now() >= deadline) {
        stoppedBecause = "time";
        break;
      }
      if (views.length >= limits.views) {
        stoppedBecause = "views";
        break;
      }
      // Breadth first: top-level sections before anything deeper; then the area least seen.
      const areaSeen = (a: string) => views.filter((v) => v.area === a).length;
      queue.sort((a, b) => Number(b.top) - Number(a.top) || areaSeen(a.area) - areaSeen(b.area) || a.depth - b.depth);
      const next = queue.shift()!;
      if (neverFollow.has(viewKey(next.url))) continue;
      const res = await openState(next.url, next.via);
      if (!res) continue;
      if (!origins.has(originOf(page.url()))) continue;
      // A page without the signed-in words (a 404, a bare page) isn't a lost session: the start page says which.
      if (!(await stillSignedIn()) && !(await goto(o.url).then(() => stillSignedIn()).then(async (ok) => (ok ? (await openState(next.url, next.via), true) : false)))) {
        session.lost.push(pathOf(next.url));
        emit({ type: "session_lost", path: pathOf(next.url) });
        // The address that ended it is never opened again, in this session or the next: whatever its words
        // ("Switch user"), signing in again only to walk into it would spend a real sign-in for nothing.
        neverFollow.add(viewKey(next.url));
        const came = next.from ? views.find((v) => v.path === next.from!.path) : undefined;
        if (came) came.leftAlone.push(clip(`"${next.from!.words.slice(0, 60)}" isn't followed again: the session was lost after it was opened`));
        const again = session.signedInAgain < limits.signIns && o.signInAgain ? await o.signInAgain().catch(() => undefined) : undefined;
        harvest();
        await context.close().catch(() => {});
        if (!again) {
          stoppedBecause = "session_lost";
          break;
        }
        session.signedInAgain++;
        state = again;
        await open();
        // Carry on with the rest of the queue in the new session (not the address that ended the last one).
        continue;
      }
      const raw = await page.evaluate(readView).catch(() => undefined);
      if (!raw) continue;
      const viaNames = (next.via ?? []).map((st) => st.name);
      const key = `${viewKey(page.url())}|${raw.layout}|${viaNames.join(">")}`;
      if (seenViews.has(key)) continue;
      seenViews.add(key);
      const view: MapView = {
        n: views.length + 1,
        path: pathOf(page.url()),
        pattern: pathPattern(new URL(page.url())),
        area: areaOf(page.url()),
        depth: next.depth,
        title: clip(raw.title, 120),
        heading: clip(raw.h1, 120),
        ...(next.from ? { from: next.from } : {}),
        ...(viaNames.length ? { via: viaNames.map((n) => clip(n, 60)) } : {}),
        forms: [],
        lists: raw.lists.map((l) => ({ heading: clip(l.heading, 80), kind: l.kind, columns: l.columns.map((c) => clip(c, 40)), rows: l.rows, ...(l.sample ? { sample: clip(l.sample, 160) } : {}), rowActions: [] })),
        switches: raw.switches.map((s) => ({ heading: clip(s.heading, 80), names: s.names.map((n) => clip(n, 60)), held: [] })),
        controls: [],
        counts: raw.counts.map((c) => clip(c, 80)),
        empty: raw.empty.map((c) => clip(c, 120)),
        leftAlone: [],
        partlySeen: [],
      };
      views.push(view);
      currentView = view;
      emit({ type: "view", n: view.n, path: view.path });
      const here = page.url();
      // What the page sent by itself on load, held: a read by POST leaves it partly seen.
      for (const c of hold.clues.filter((c) => c.at >= 0 && !c.press && c.page === pathPattern(new URL(here)))) {
        const said = `a request it sends by itself was held (${c.method} ${c.path})`;
        if (!view.partlySeen.includes(said)) view.partlySeen.push(said);
      }

      // Links: breadth first from the navigation; a list's rows are one part, so only its first row's links.
      for (const l of raw.links) {
        if (!/^https?:/.test(l.href) || !origins.has(originOf(l.href))) continue;
        const why = SIGNS_OUT.test(l.words) ? "it reads like signing out" : l.notif ? "it's inside a notification or inbox area" : l.method && l.method !== "get" ? `it sends a ${l.method.toUpperCase()}` : getActs(l.href);
        if (why) {
          const said = clip(`"${l.words.slice(0, 60)}" wasn't followed: ${why}`);
          if (!view.leftAlone.includes(said)) view.leftAlone.push(said);
          // A link that would do something is still one of the app's controls (never one that signs out or notifies).
          if (!l.notif && !SIGNS_OUT.test(l.words) && l.words && !view.controls.some((c) => c.name === clip(l.words, 60))) view.controls.push({ name: clip(l.words, 60), kind: "other", held: [], notPressed: clip(`a link, not followed: ${why}`) });
          continue;
        }
        const k = viewKey(l.href);
        if (queued.has(k) || neverFollow.has(k)) continue;
        if (l.inList) continue; // taken from the first row below
        queued.add(k);
        queue.push({ url: l.href, depth: next.depth + 1, area: areaOf(l.href), top: next.depth === 0 && l.nav, from: { path: view.path, words: clip(l.words, 80) } });
      }
      for (const l of raw.lists) {
        for (const fl of l.firstLinks.slice(0, 3)) {
          if (fl.notif || !/^https?:/.test(fl.href) || !origins.has(originOf(fl.href)) || getActs(fl.href) || SIGNS_OUT.test(fl.words)) continue;
          const k = viewKey(fl.href);
          if (queued.has(k)) continue;
          queued.add(k);
          queue.push({ url: fl.href, depth: next.depth + 1, area: areaOf(fl.href), top: false, from: { path: view.path, words: clip(fl.words, 80) } });
        }
      }

      // Tabs: each tab not shown is a state of this view of its own, reached by pressing it (a tab that
      // is a link to another address is followed as a link above).
      const via = next.via ?? [];
      const baseVia = via.filter((st) => st.kind !== "tab");
      const stateKey = (steps: readonly Step[]) => `${viewKey(here)}|via:${steps.map((st) => st.name).join(">")}`;
      for (const t of raw.tabs) {
        if (!t.name || (t.href && /^https?:/.test(t.href) && viewKey(t.href) !== viewKey(here))) continue;
        const steps = [...baseVia, { sel: t.sel, name: t.name, kind: "tab" as const }];
        const k = stateKey(steps);
        // The tab shown on load is this view itself.
        if (t.selected && via.length === baseVia.length) {
          queued.add(k);
          continue;
        }
        if (t.selected || queued.has(k) || steps.length > 3) continue;
        const why = floorOf(t.name);
        if (why) {
          view.leftAlone.push(clip(why));
          continue;
        }
        queued.add(k);
        queue.push({ url: here, via: steps, depth: next.depth + 1, area: view.area, top: false, from: { path: view.path, words: clip(t.name, 80) } });
      }

      // Presses, under the hold. Each starts from a fresh load of the view.
      let presses = 0;
      const budget = () => presses < limits.pressesPerView && Date.now() < deadline && !o.signal?.aborted;
      // A fresh load of the view, marked again the same way (the same page draws the same marks), so the
      // controls read on its first load can still be found.
      const reload = async () => {
        await openState(here, via);
        await page.evaluate(readView).catch(() => undefined);
      };
      reloadForMenu = reload;
      const fresh = async () => {
        if (page.url() !== here || (await page.evaluate(() => document.querySelector("[data-cm-pressed]") !== null).catch(() => true))) await reload();
      };
      const tryOnce = (name: string) => {
        const k = `${view.pattern}|${raw.layout}|${name}`;
        if (tried.has(k)) return false;
        tried.add(k);
        return true;
      };

      // 0. Buttons in the navigation (a single-page app's menu): each pressed once in the whole walk; one that
      // goes somewhere is queued like a link, one that shows another part of the page is a state of its own.
      let navPresses = 0;
      for (const b of raw.buttons) {
        if (!b.nav || !b.name || /\b(filters?|sort|search)\b|^\s*(\+|new|add|create)\b/i.test(b.name)) continue;
        if (SIGNS_OUT.test(b.name) || floorOf(b.name)) {
          const why = floorOf(b.name) ?? `"${b.name.slice(0, 60)}" wasn't pressed: it reads like signing out`;
          if (!view.leftAlone.includes(clip(why))) view.leftAlone.push(clip(why));
          continue;
        }
        if (navPresses >= 12 || !budgetLeft() || tried.has(`nav:${b.name}`)) continue;
        tried.add(`nav:${b.name}`);
        navPresses++;
        await fresh();
        const sigOf = (r: RawView | undefined) => (r ? `${r.h1}|${r.layout}|${r.title}` : "");
        const before = sigOf(await page.evaluate(readView).catch(() => undefined));
        const n0 = hold.clues.length;
        hold.pressing(b.name);
        await page.locator(b.sel).first().click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(PRESS_MS);
        hold.pressing(undefined);
        await page.evaluate(() => document.body?.setAttribute("data-cm-pressed", "1")).catch(() => {});
        const held = cluesSince(n0);
        if (held.length) view.controls.push({ name: clip(b.name, 60), kind: "other", held, outcome: "sent something, held" });
        if (page.url() !== here) {
          const k = viewKey(page.url());
          if (origins.has(originOf(page.url())) && !queued.has(k) && !neverFollow.has(k) && !getActs(page.url())) {
            queued.add(k);
            queue.push({ url: page.url(), depth: next.depth + 1, area: areaOf(page.url()), top: next.depth === 0, from: { path: view.path, words: clip(b.name, 80) } });
          }
          continue;
        }
        await settle(page);
        const after = sigOf(await page.evaluate(readView).catch(() => undefined));
        if (after && after !== before && via.length < 3) {
          const steps = [...via, { sel: b.sel, name: b.name, kind: "nav" as const }];
          const k = stateKey(steps);
          if (!queued.has(k)) {
            queued.add(k);
            queue.push({ url: here, via: steps, depth: next.depth + 1, area: view.area, top: next.depth === 0, from: { path: view.path, words: clip(b.name, 80) } });
          }
        }
      }
      if (navPresses) await reload();

      // 1. Forms: fill with made-up values, press Save (held), follow Next to the end.
      for (const g of raw.groups) {
        if (!budget()) break;
        const form: MapForm = { heading: clip(g.heading, 80), fields: g.fields.map(fieldOf), ...(g.submits[0] ? { submit: clip(g.submits[0].name, 60) } : { submit: "Enter" }), presses: [], steps: 1, outcome: "", held: [], ...(g.search ? { search: true } : {}), ...(g.formMethod === "get" || g.formMethod === "post" ? { method: g.formMethod } : {}), via: "page" };
        view.forms.push(form);
        const why = g.password ? "it has a password field (a sign-in, a sign-up or a password change)" : g.formAction && !origins.has(originOf(g.formAction)) ? "it sends to another site" : g.submits[0] ? floorOf(g.submits[0].name) : undefined;
        if (why) {
          form.notPressed = clip(why);
          continue;
        }
        if (!tryOnce(`form:${g.heading}:${g.fields.map((f) => f.label).join(",")}`)) continue;
        await fresh();
        presses++;
        await sendForm(g, form);
        await reload();
      }

      // 2. Row controls, on the first row only (a list of 50 rows is one part).
      for (const [i, l] of raw.lists.entries()) {
        const names = new Set<string>();
        for (const a of l.actions) {
          if (names.has(a.name)) continue;
          names.add(a.name);
          const act: MapRowAction = { name: clip(a.name, 60), held: [] };
          view.lists[i]!.rowActions.push(act);
          if (!a.sel) {
            const acts = getActs(a.href);
            act.outcome = acts ? `a link, not followed: ${acts}` : "a link, followed as a page";
            continue;
          }
          const why = floorOf(a.name);
          if (why) {
            act.notPressed = clip(why);
            continue;
          }
          if (!budget() || !tryOnce(`row:${l.heading}:${a.name}`)) continue;
          await fresh();
          presses++;
          const items = await pressRow(a.sel, act);
          await reload();
          // A row menu ("⋯", "More actions"): its items are the row's controls too.
          if (items.length) {
            const found = await exploreMenu(a.sel, items.filter((n) => !names.has(n)), budget);
            presses += found.pressed;
            for (const c of found.controls) {
              names.add(c.name);
              view.lists[i]!.rowActions.push({ name: c.name, held: c.held, ...(c.outcome ? { outcome: c.outcome } : {}), ...(c.notPressed ? { notPressed: c.notPressed } : {}) });
            }
            await reload();
          }
        }
      }

      // 3. Switches: the first of each group, to see that it saves when pressed (held).
      for (const [i, s] of raw.switches.entries()) {
        if (!budget() || !s.sels[0] || !tryOnce(`switch:${s.heading}`)) continue;
        await fresh();
        presses++;
        const n0 = hold.clues.length;
        hold.pressing(s.names[0]);
        await page.locator(s.sels[0]).first().click({ timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(PRESS_MS);
        hold.pressing(undefined);
        view.switches[i]!.held = cluesSince(n0);
        await reload();
      }

      // 4. Other controls: filters, entries ("New project"), anything else named and not on the floor.
      for (const b of raw.buttons) {
        if (!b.name) continue;
        const kind: MapControl["kind"] = /\b(filters?|sort|show (all|archived|active))\b/i.test(b.name) ? "filter" : /^\s*(\+|new|add|create)\b/i.test(b.name) ? "entry" : /\bsearch\b/i.test(b.name) ? "search" : "other";
        const ctl: MapControl = { name: clip(b.name, 60), kind, held: [] };
        if (b.nav && kind === "other") continue;
        view.controls.push(ctl);
        const why = floorOf(b.name);
        if (why) {
          ctl.notPressed = clip(why);
          view.leftAlone.push(clip(why));
          continue;
        }
        if (!budget() || !tryOnce(`button:${b.name}`)) continue;
        await fresh();
        presses++;
        const items = await pressControl(b.sel, ctl, view);
        await reload();
        if (items.length) {
          const found = await exploreMenu(b.sel, items.filter((n) => !raw.buttons.some((x) => x.name === n)), budget);
          presses += found.pressed;
          view.controls.push(...found.controls);
          await reload();
        }
      }
    }
  } catch (error) {
    stoppedBecause = "failed";
    void error;
  } finally {
    harvest();
    await context.close().catch(() => {});
  }
  dropAmbient(views, clues);
  const actions = featuresOf(views, clues);
  return {
    schemaVersion: "map-1",
    kind: "mapmode-1",
    url: pathOf(o.url),
    ...(o.signedInAs ? { signedInAs: o.signedInAs } : {}),
    createdAt: new Date(begun).toISOString(),
    ms: Date.now() - begun,
    actions,
    screens: [],
    mapMode: { views, held: clues, hold: counts, writesLeft: counts.leaked, writesLeftCovers: LEAKED_COVERS, session, queueLeft: queue.map((q) => pathOf(q.url)), stoppedBecause, limits },
  };

  /** A field as the map keeps it: never its value. */
  function fieldOf(f: RawField): MapField {
    const never = neverMadeUp(factsOf(f));
    return { label: clip(f.label, 60), type: f.role === "combobox" ? "combobox" : f.type, required: f.required, ...(f.options.length ? { choices: f.options.map((c) => clip(c, 40)) } : {}), ...(f.value.trim() ? { prefilled: true } : {}), ...(never ? { leftEmpty: never.cannot } : f.type === "file" ? { leftEmpty: "a file (none is attached while mapping)" } : {}) };
  }

  /** Fills a group and sends it, held; a Next that shows new fields is followed, up to 6 steps. */
  async function sendForm(g: RawGroup, form: MapForm): Promise<void> {
    const typedFrom = hold.clues.length;
    hold.pressing("(typing)");
    await fill(g.fields);
    // Typing alone sent something: it saves as you type (held all the same).
    // Long enough for a delayed autosave to go (held), so typing alone shows it.
    await page.waitForTimeout(TYPED_WAIT_MS);
    const typed = cluesSince(typedFrom);
    hold.pressing(undefined);
    if (typed.length) form.savesAsYouType = typed;
    let group = g;
    for (let step = 0; step < 6; step++) {
      const submit = group.submits[0];
      const n0 = hold.clues.length;
      const before = page.url();
      hold.pressing(submit?.name ?? "Enter");
      emit({ type: "press", words: submit?.name ?? "Enter" });
      if (submit) {
        form.presses.push(clip(submit.name, 60));
        await page.locator(submit.sel).first().click({ timeout: 2_000 }).catch(() => {});
      } else {
        const last = [...group.fields].reverse().find((f) => !/^(checkbox|radio|select|file)$/.test(f.type));
        if (last) await page.locator(last.sel).first().press("Enter", { timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(PRESS_MS);
      await page.evaluate(() => document.body?.setAttribute("data-cm-pressed", "1")).catch(() => {});
      hold.pressing(undefined);
      const sent = cluesSince(n0);
      if (sent.length) {
        form.held = sent;
        const c = hold.clues.find((x) => clueBase + x.n === sent[0])!;
        form.outcome = `sent ${c.method} ${c.path}, held${sent.length > 1 ? ` (and ${sent.length - 1} more)` : ""}`;
        return;
      }
      if (page.url() !== before) {
        form.outcome = `went to ${pathOf(page.url())} and sent nothing else`;
        return;
      }
      const shownErr = await page.evaluate(() => [...document.querySelectorAll('[role=alert], .error, .err, [aria-live=assertive], [aria-invalid=true] ~ *')].map((e) => (e.textContent ?? "").trim()).filter(Boolean).join(" · ").slice(0, 160)).catch(() => "");
      // A next step: fields that weren't there before.
      const now = await page.evaluate(readView).catch(() => undefined);
      // A last step may show no field at all (a review): then the same box's buttons say what's next.
      const next = now?.groups.find((x) => x.sel === group.sel) ?? now?.groups.find((x) => x.submits.some((s) => s.sel === submit?.sel)) ?? (await buttonsIn(group.sel).then((submits) => (submits.length ? { ...group, fields: [], submits } : undefined)));
      const newFields = next ? next.fields.filter((f) => !group.fields.some((o) => o.sel === f.sel)) : [];
      if (next && (newFields.length || (next.submits[0] && next.submits[0].name !== submit?.name))) {
        form.steps++;
        for (const f of newFields) if (!form.fields.some((x) => x.label === f.label)) form.fields.push(fieldOf(f));
        hold.pressing("(typing)");
        await fill(newFields);
        hold.pressing(undefined);
        group = next;
        continue;
      }
      form.outcome = shownErr ? `the page stopped it: "${clip(shownErr, 120)}"` : form.steps > 1 ? "multi-step, rest unseen" : "nothing was sent";
      return;
    }
    form.outcome = "multi-step, rest unseen";
  }

  /** The shown buttons in a box, the likeliest sender first (a wizard's Save once Next has gone). */
  async function buttonsIn(sel: string): Promise<{ sel: string; name: string }[]> {
    return page.evaluate((boxSel) => {
      const box = document.querySelector(boxSel);
      if (!box) return [];
      const SUBMIT = /^(save|add|create|submit|done|next|continue|send|post|update|apply|confirm|finish|keep|go|ok|upload|import|book)\b/i;
      const w = window as unknown as { __cmMapN?: number };
      return [...box.querySelectorAll("button, [role=button], input[type=button], input[type=submit]")]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && b.getAttribute("role") !== "switch" && !b.closest("tr, li, [role=radiogroup]");
        })
        .map((b) => {
          let m = b.getAttribute("data-cm-map");
          if (!m) {
            w.__cmMapN = (w.__cmMapN ?? 0) + 1;
            m = String(w.__cmMapN);
            b.setAttribute("data-cm-map", m);
          }
          return { sel: `[data-cm-map="${m}"]`, name: (b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 80) };
        })
        .sort((a, b) => Number(SUBMIT.test(b.name)) - Number(SUBMIT.test(a.name)) || Number(/^(back|previous|cancel)\b/i.test(a.name)) - Number(/^(back|previous|cancel)\b/i.test(b.name)));
    }, sel).catch(() => []);
  }

  /** Fills fields with made-up test values: never a password, code, card or file. */
  async function fill(fields: readonly RawField[]): Promise<void> {
    for (const f of fields) {
      if (!budgetLeft()) return;
      const el = page.locator(f.sel).first();
      if (!(await el.isVisible().catch(() => false))) continue;
      if (neverMadeUp(factsOf(f)) || f.type === "file") continue;
      try {
        if (f.tag === "select") {
          const v = await el.evaluate((s) => [...(s as HTMLSelectElement).options].find((x) => x.value !== "" && !x.disabled)?.value ?? "");
          if (v) await el.selectOption(v, { timeout: 2_000 });
        } else if (f.type === "radio") {
          await el.click({ timeout: 2_000 });
        } else if (f.type === "checkbox") {
          if (f.required) await el.check({ timeout: 2_000 });
        } else if (f.role === "combobox") {
          await el.click({ timeout: 2_000 });
          await page.waitForTimeout(400);
          let opt = page.locator("[role=option]:visible").first();
          if (!(await opt.count())) {
            await el.pressSequentially("a", { timeout: 2_000 });
            await page.waitForTimeout(500);
            opt = page.locator("[role=option]:visible").first();
          }
          await opt.click({ timeout: 2_000 }).catch(() => {});
        } else if (!f.value.trim()) {
          const made = madeUpValue(factsOf(f));
          if ("value" in made) await el.fill(made.value, { timeout: 2_000 });
        }
      } catch {
        // a field that won't take a value: left as it is
      }
    }
  }
  function budgetLeft() {
    return Date.now() < deadline && !o.signal?.aborted;
  }

  /** Presses a row's control: an editor that opens in the row is filled and sent with Enter (held). */
  async function pressRow(sel: string, act: MapRowAction): Promise<string[]> {
    const shownBefore = await shownButtonNames();
    const before = new Set(await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((e) => e.outerHTML.slice(0, 120))).catch(() => [] as string[]));
    const url = page.url();
    const n0 = hold.clues.length;
    hold.pressing(act.name);
    await page.locator(sel).first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(PRESS_MS);
    await page.evaluate(() => document.body?.setAttribute("data-cm-pressed", "1")).catch(() => {});
    if (page.url() !== url) {
      act.outcome = `went to ${pathOf(page.url())}`;
      const k = viewKey(page.url());
      if (origins.has(originOf(page.url())) && !queued.has(k) && !getActs(page.url())) {
        queued.add(k);
        queue.push({ url: page.url(), depth: 1, area: areaOf(page.url()), top: false, from: { path: pathOf(url), words: act.name } });
      }
    } else {
      // A box it opened (an inline rename): filled and sent with Enter.
      const opened = await page.evaluate((seen) => {
        const el = [...document.querySelectorAll("input:not([type=hidden]), textarea")].find((e) => !seen.includes(e.outerHTML.slice(0, 120)) && (e as HTMLElement).offsetParent !== null) as HTMLInputElement | undefined;
        if (!el) return undefined;
        el.setAttribute("data-cm-open", "1");
        const by = el.getAttribute("aria-labelledby");
        return (el.getAttribute("aria-label") || (by ? document.getElementById(by)?.textContent : "") || el.labels?.[0]?.textContent || el.placeholder || el.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
      }, [...before]).catch(() => undefined);
      if (opened !== undefined) {
        if (opened) act.field = clip(opened, 60);
        const box = page.locator("[data-cm-open]").first();
        await box.fill("Test", { timeout: 2_000 }).catch(() => {});
        await box.press("Enter", { timeout: 2_000 }).catch(() => {});
        await page.waitForTimeout(PRESS_MS);
      }
      const sent = cluesSince(n0).map((n) => hold.clues.find((x) => clueBase + x.n === n)!);
      act.outcome = sent.length ? `sent ${sent[0]!.method} ${sent[0]!.path}, held` : opened !== undefined ? "opened a box in the row; Enter sent nothing" : "nothing was sent";
      hold.pressing(undefined);
      act.held = cluesSince(n0);
      if (!sent.length && opened === undefined) {
        const items = (await shownButtonNames()).filter((n) => !shownBefore.includes(n));
        if (items.length) act.outcome = `opened a menu: ${clip(items.join(", "), 120)}`;
        return items;
      }
      return [];
    }
    hold.pressing(undefined);
    act.held = cluesSince(n0);
    return [];
  }

  /** The names of the buttons and menu items shown now (a menu a press opened shows new ones). */
  async function shownButtonNames(): Promise<string[]> {
    return page.evaluate(() => {
      const T = (x: string | null | undefined) => (x ?? "").replace(/\s+/g, " ").trim();
      const out: string[] = [];
      for (const b of document.querySelectorAll("button, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=option], a[role=menuitem]")) {
        const r = b.getBoundingClientRect();
        const st = getComputedStyle(b);
        if (!(r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none")) continue;
        const name = T(b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title")).slice(0, 80);
        if (name && !out.includes(name)) out.push(name);
      }
      return out;
    }).catch(() => []);
  }

  /**
   * Presses an item of a menu a control opens ("⋯" then "Duplicate"): from a fresh load, the opener,
   * then the item by its name. What it does is recorded on `ctl` as pressControl does.
   */
  async function pressMenuItem(openerSel: string, item: string, ctl: MapControl, view: MapView): Promise<void> {
    await page.locator(openerSel).first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(400);
    const found = await page.evaluate((name) => {
      for (const b of document.querySelectorAll("[data-cm-item]")) b.removeAttribute("data-cm-item");
      for (const b of document.querySelectorAll("button, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=option], a[role=menuitem]")) {
        const r = b.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue;
        const n = (b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (n === name) {
          b.setAttribute("data-cm-item", "1");
          return true;
        }
      }
      return false;
    }, item).catch(() => false);
    if (!found) {
      ctl.outcome = "the menu didn't show it again";
      return;
    }
    await pressControl("[data-cm-item]", ctl, view);
  }

  /** Explores a menu's items: each named, the floor's left alone, the rest pressed (held) within the budget. */
  async function exploreMenu(openerSel: string, items: readonly string[], budget: () => boolean): Promise<{ pressed: number; controls: MapControl[] }> {
    let pressed = 0;
    const controls: MapControl[] = [];
    for (const item of items.slice(0, 8)) {
      const ctl: MapControl = { name: clip(item, 60), kind: /^\s*(\+|new|add|create)\b/i.test(item) ? "entry" : "other", held: [] };
      controls.push(ctl);
      const why = floorOf(item);
      if (why) {
        ctl.notPressed = clip(why);
        continue;
      }
      if (!budget()) break;
      if (pressed > 0) await reloadForMenu();
      pressed++;
      await pressMenuItem(openerSel, item, ctl, currentView!);
    }
    return { pressed, controls };
  }

  /** Presses another control: a form it opens is mapped (and sent, held); a page it opens is queued. */
  async function pressControl(sel: string, ctl: MapControl, view: MapView): Promise<string[]> {
    const url = page.url();
    const shownBefore = await shownButtonNames();
    const before = new Set((await page.evaluate(readView).catch(() => undefined))?.fieldSels ?? []);
    const n0 = hold.clues.length;
    hold.pressing(ctl.name);
    await page.locator(sel).first().click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(PRESS_MS);
    await page.evaluate(() => document.body?.setAttribute("data-cm-pressed", "1")).catch(() => {});
    hold.pressing(undefined);
    ctl.held = cluesSince(n0);
    if (page.url() !== url) {
      ctl.outcome = viewKey(page.url()) === viewKey(url) ? `showed the same view with other data (${pathOf(page.url())})` : `went to ${pathOf(page.url())}`;
      const k = viewKey(page.url());
      if (origins.has(originOf(page.url())) && !queued.has(k) && !getActs(page.url())) {
        queued.add(k);
        queue.push({ url: page.url(), depth: view.depth + 1, area: areaOf(page.url()), top: false, from: { path: view.path, words: ctl.name } });
      }
      return [];
    }
    const now = await page.evaluate(readView).catch(() => undefined);
    // A form it opened: a dialog, or a group with a field that wasn't on the page before the press.
    const g = now?.groups.find((x) => x.fields.some((f) => !before.has(f.sel)));
    if (g) {
      const form: MapForm = { heading: clip(g.heading, 80), fields: g.fields.map(fieldOf), ...(g.submits[0] ? { submit: clip(g.submits[0].name, 60) } : { submit: "Enter" }), entry: ctl.name, presses: [], steps: 1, outcome: "", held: [], ...(g.formMethod === "get" || g.formMethod === "post" ? { method: g.formMethod } : {}), via: "entry" };
      view.forms.push(form);
      const why = g.password ? "it has a password field" : g.submits[0] ? floorOf(g.submits[0].name) : undefined;
      if (why) form.notPressed = clip(why);
      else await sendForm(g, form);
      ctl.outcome = "opened a form";
      return [];
    }
    const first = hold.clues.find((x) => clueBase + x.n === ctl.held[0]);
    ctl.outcome = first ? `sent ${first.method} ${first.path}, held` : "nothing new";
    if (first) return [];
    // A menu it opened: the items that weren't shown before the press.
    const items = (await shownButtonNames()).filter((n) => !shownBefore.includes(n) && n !== ctl.name);
    if (items.length) ctl.outcome = `opened a menu: ${clip(items.join(", "), 120)}`;
    return items;
  }
}

/**
 * After the walk, with every clue in hand: a request the pages send by themselves (seen with no press
 * under way, or under two or more different presses: a token refresh on a timer) is taken off every
 * press it happened to fall in, so it never names a form's verb.
 */
export function dropAmbient(views: MapView[], clues: readonly HeldClue[]): void {
  const key = (c: HeldClue) => `${c.method} ${c.path} ${c.fields.join(",")} ${c.graphql?.operations.join(",") ?? ""}`;
  const presses = new Map<string, Set<string>>();
  for (const c of clues) {
    const k = key(c);
    if (!presses.has(k)) presses.set(k, new Set());
    presses.get(k)!.add(c.press ?? "");
  }
  const ambient = new Set(clues.filter((c) => presses.get(key(c))!.has("") || presses.get(key(c))!.size >= 2).map((c) => c.n));
  const keep = (ns: number[]) => ns.filter((n) => !ambient.has(n));
  for (const v of views) {
    for (const f of v.forms) {
      const had = f.held.length;
      f.held = keep(f.held);
      if (f.savesAsYouType) {
        f.savesAsYouType = keep(f.savesAsYouType);
        if (!f.savesAsYouType.length) delete f.savesAsYouType;
      }
      if (had && !f.held.length) f.outcome = "nothing was sent but the page's own background requests";
    }
    for (const l of v.lists) for (const a of l.rowActions) a.held = keep(a.held);
    for (const g of v.switches) g.held = keep(g.held);
    for (const c of v.controls) c.held = keep(c.held);
  }
}

/** A raw field as values.ts reads one, for made-up values and the never-made-up rule. */
function factsOf(f: RawField): FieldFacts {
  return {
    tag: f.tag,
    type: f.type,
    hint: [f.name, f.label, f.placeholder, f.autocomplete].filter(Boolean).join(" ").toLowerCase(),
    label: f.label,
    placeholder: f.placeholder,
    autocomplete: f.autocomplete,
    inputMode: f.inputMode,
    required: f.required,
    value: f.value,
    pattern: f.pattern,
    min: f.min,
    max: f.max,
    step: f.step,
    minLength: f.minLength,
    maxLength: f.maxLength,
    ...(f.options.length ? { options: f.options.map((x) => [x, x] as [string, string]) } : {}),
  };
}

/** The map as mapscore.ts and learn's readers take it. */
export const mapJson = (run: MapRun) => JSON.stringify(run, null, 2);
