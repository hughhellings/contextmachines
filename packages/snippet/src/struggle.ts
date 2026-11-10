import { fieldKey } from "./page.ts";
import { run } from "./safe.ts";

/**
 * Struggle signals: how people behave when they're stuck, captured as shape
 * only (which control, how many times, how long; never what was typed).
 *
 *   hesitation      went back to a button 3+ times without pressing it (or twice, for 4s+ in
 *                   total): a pointer that merely rests on a button is not hesitating
 *   rage_click      3+ clicks on the same control within 1s
 *   crash           the app's own code threw an error just after the person pressed something
 *                   (never the message: only that it happened, and what they pressed)
 *   error_page      they landed on a "page not found" or "something went wrong" page
 *   missed_tap      on a touch screen, they kept tapping just next to a button (too small to hit)
 *   no_results      they searched and found nothing, twice or more in a row (one empty search is normal)
 *   dead_click      a click on something that looks clickable but nothing followed (a file
 *                   picker, pop-up or dialog opening counts as something)
 *   field_churn     the same field edited in 4+ separate bursts
 *   form_abandon    started filling a form, then left without submitting
 *   validation_loop tried to submit with invalid fields 2+ times (browser-blocked
 *                   submits fire "invalid" per field; apps flag aria-invalid); the
 *                   target is the first rejected field's name, so help can name it,
 *                   and control the form's button as this user sees it
 *   u_turn          went back to the page they came from within 3s of arriving, without
 *                   typing or submitting anything (moving on quickly is not a u-turn,
 *                   and nor is closing the tab or leaving the site)
 *   failed_drag     dragged something (a card, a row) 40px+ and let go, and it went back where it
 *                   started with nothing saved, twice on the same item: a drop the app wouldn't take
 *   searching       looked around for something without finding it: two or more of hovering
 *                   over many different controls, scrolling back and forth, opening menus or
 *                   tabs, find-in-page, going back and forth between two pages, for 15s+ with
 *                   no progress (no save, no form sent). Being lost sends nothing to the
 *                   server, so only the page can see it. The server judges it against what's
 *                   normal on that page.
 */
export type StruggleType = "hesitation" | "rage_click" | "dead_click" | "field_churn" | "form_abandon" | "validation_loop" | "u_turn" | "crash" | "error_page" | "missed_tap" | "no_results" | "searching" | "failed_drag";
/** The signs of searching that were seen (see SEARCH_SIGNS). */
export type SearchSign = "hovered" | "scrolled" | "menus" | "find" | "back_and_forth";

export interface Struggle {
  type: StruggleType;
  /** Normalised page path. */
  page: string;
  /** Control label (buttons) or field name (fields), when there is one. */
  target?: string;
  count?: number;
  durationMs?: number;
  /** Validation loops: the rejected field was empty, or filled but not accepted. */
  detail?: "empty" | "rejected";
  /** Validation loops: the form's button, labelled as on this user's page (variants and languages differ). */
  control?: string;
  /** Searching: which signs were seen. */
  signs?: SearchSign[];
}

/** How much of each sign counts: each alone is normal; two or more together, for a while, is hunting. */
const SEARCH_SIGNS: Record<SearchSign, number> = { hovered: 6, scrolled: 3, menus: 2, find: 1, back_and_forth: 2 };
/** On the page this long with no progress, before searching can be reported. */
export const SEARCHING_MIN_MS = 15_000;
/** Scrolling this far one way, then back, is one reversal (small wobbles aren't). */
const SCROLL_REVERSAL_PX = 250;
const OPENERS = "[aria-haspopup]:not([aria-haspopup='false']), [aria-expanded], [role='tab'], summary";

export interface StruggleOptions {
  report: (s: Struggle) => void;
  currentPath: () => string;
  /** A same-site address as a page path (as currentPath names pages), or undefined for another site. */
  pathOf?: (url: string) => string | undefined;
  /** True when a network request, navigation or meaningful DOM change happened since `since`. */
  somethingHappenedSince: (since: number) => boolean;
  /** Elements to ignore (our own UI). */
  isOwnUi: (el: Element) => boolean;
  labelOf: (el: Element) => string | undefined;
  clock?: () => number;
  deadClickWaitMs?: number;
}

const CLICKABLE = "button, a[href], [role='button'], [role='link'], [role='menuitem'], [role='tab'], input[type='submit'], input[type='button']";
const LOOKS_CLICKABLE = `${CLICKABLE}, [onclick], [tabindex]:not([tabindex='-1'])`;
const FIELD = "input:not([type='hidden']):not([type='submit']):not([type='button']), textarea, select, [contenteditable='true'], [role='textbox']";
/**
 * Controls the browser handles itself: a dropdown opens its list, a checkbox ticks, a label
 * focuses its field, a date box opens a picker. The page doesn't change, and nothing is wrong.
 */
/** The text of a region, piece by piece with gaps between (textContent runs "Customers" into "No customers"). */
function visibleText(root: Element | null): string {
  if (!root) return "";
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n && parts.length < 2000; n = walker.nextNode()) {
    // Code and hidden things aren't on screen: an inline script often holds the empty-state words itself.
    if (n.parentElement?.closest("script, style, noscript, template, [hidden], [aria-hidden='true']")) continue;
    if (n.textContent?.trim()) parts.push(n.textContent.trim());
  }
  return parts.join(" ");
}

/** Empty searches this close together are one person looking for one thing. */
const SEARCH_RUN_MS = 90_000;
const SEARCH_SETTLE_MS = 1200;
/** One of many of a kind (a recipe, a ticket, a home): a quick look and back is browsing, not turning back. */
const anItem = (path: string) => /\/:id(\/|$)/.test(path.replace(/\/~[^/]*$/, ""));
/** How server-rendered pages show a rejected form: a message near it. */
const ERROR_NOTE = "[role='alert'], .error, .errors, .err, .alert-danger, .alert-error, .invalid-feedback, .form-error, [class*='error-message']";
/** In an empty field this long without typing: unsure what it wants. */
const FIELD_STALL_MS = 8000;
/** Boxes for finding something (a search, a filter, a ⌘K command menu): never a form to fill in. */
const SEARCH_BOX = "input[type='search'], [role='searchbox'], [role='combobox'], [role='search'] input, input[name*='search' i], input[name='q'], input[name='query'], input[placeholder*='search' i], input[aria-label*='search' i], input[placeholder*='filter' i], input[aria-label*='filter' i], input[placeholder*='command' i], input[placeholder*='jump to' i], input[placeholder*='find' i]"
  // The same in the languages most sites are in: German, French, Spanish, Italian, Dutch, Portuguese.
  + ["such", "recherch", "buscar", "búsqueda", "cerca", "zoek", "pesquis", "procurar", "filtr"].map((w) => `, input[placeholder*='${w}' i], input[aria-label*='${w}' i], input[name*='${w}' i]`).join("");
/** How apps say a search found nothing. */
const EMPTY_STATE = new RegExp([
  "\\b(no (results|matches|items|records|customers|products|articles|people|users|entries|commands)\\b|no matching\\b|nothing (found|matche[sd])|0 results|didn'?t match any|no .{1,30} match(es|ed)?\\b)",
  "\\bkeine (ergebnisse|treffer|einträge|eintraege|übereinstimmung)|\\bnichts gefunden|\\b0 treffer|\\bkeine? .{1,30} gefunden", // de
  "\\baucun(e)? (résultat|correspondance|élément)|\\brien (trouvé|ne correspond)|\\b0 résultat", // fr
  "\\bsin resultados|\\bningún resultado|\\bno se (encontr|hall)|\\bno hay resultados|\\b0 resultados", // es
  "\\bnessun risultato|\\bnessuna corrispondenza|\\b0 risultati", // it
  "\\bgeen (resultaten|resultaat|treffers|overeenkomsten)|\\bniets gevonden", // nl
  "\\bnenhum resultado|\\bsem resultados|\\bnão (foram encontrad|encontramos)", // pt
].join("|"), "i");
/** A tap this close to a button (CSS pixels), on nothing clickable, is a miss. */
const MISS_RADIUS = 16;
const MISS_WINDOW_MS = 15_000;
const MAX_TAP_CANDIDATES = 400;
/** An error within this long of a press counts as the press breaking something. */
const CRASH_AFTER_PRESS_MS = 2000;
const HARMLESS = /ResizeObserver loop|Script error\.?$|Non-Error promise rejection/i;
/** Error pages say so in their title or main heading, in the words sites actually use. */
const ERROR_PAGE = /^\s*(?:error\s*)?(?:404|500)\b|page not found|page (?:doesn'?t|does not) exist|something went wrong|internal server error|^\s*not found\s*$/i;
const ERROR_PAGE_WAIT_MS = 800;
const sameSite = (a: string, b: string) => {
  const site = (o: string) => new URL(o).hostname.split(".").slice(-2).join(".");
  return site(a) === site(b);
};
const IN_DIALOG = "dialog, [role='dialog'], [role='alertdialog']";
const BROWSER_HANDLED = `${FIELD}, option, label, summary, video, audio, [role='combobox'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider'], [role='option']`;

export type StruggleCapture = (() => void) & {
  /** SPA navigation: treat as leaving the page. */
  pageChanged: () => void;
  /** A search came back: empty or not (from its reply). */
  searched: (empty: boolean) => void;
  /** A write request was sent: the touched forms count as submitted. */
  /** Returns whether the field a failed reply blames is on this page. */
  markSubmitted: (ok?: boolean, field?: string) => boolean;
};

/** The element the user actually touched, through open shadow roots (web components). */
export function eventOrigin(e: Event): Element | null {
  const first = typeof e.composedPath === "function" ? e.composedPath()[0] : undefined;
  return first instanceof Element ? first : e.target instanceof Element ? e.target : null;
}

/** Bigger than any button: 120px tall, or the area of a 400×100 tile. */
const PANEL_HEIGHT = 120;
const PANEL_AREA = 40_000;

export function installStruggleCapture(doc: Document, opts: StruggleOptions): StruggleCapture {
  const now = opts.clock ?? (() => Date.now());
  const win = doc.defaultView;
  const reported = new Set<string>(); // one report per (type, page, target) per page view

  const submitLabel = (form: Element) => {
    const button = form.querySelector("button:not([type=button]):not([type=reset]), input[type=submit]");
    return button ? opts.labelOf(button) : undefined;
  };
  const report = (s: Struggle) =>
    run(() => {
      const key = `${s.type}|${s.page}|${s.target ?? ""}`;
      if (reported.has(key)) return;
      reported.add(key);
      opts.report(s);
    });

  // A control repeated down a list (a "Save" on every post) is part of the list, not a decision:
  // passing over them while reading is neither hesitating nor hunting.
  const repeats = new Map<string, { n: number; at: number }>();
  const repeatedLabel = (label: string | undefined) => {
    if (!label) return false;
    const seen = repeats.get(label);
    if (seen && now() - seen.at < 2000) return seen.n >= 3;
    let n = 0;
    for (const other of doc.querySelectorAll(CLICKABLE)) if (opts.labelOf(other) === label && ++n >= 3) break;
    repeats.set(label, { n, at: now() });
    return n >= 3;
  };

  // ---- searching: looking around without finding what they came for ----
  // A tab, step or pop-up of a screen ("/settings/~display") is the same screen to someone hunting through it.
  const screenOf = (path: string) => path.replace(/\/~[^/]*$/, "") || "/";
  const hunt = { page: screenOf(opts.currentPath()), since: now(), hovered: new Set<string>(), reversals: 0, menus: 0, find: 0, backForth: 0, y: win?.scrollY ?? 0, dir: 0, travel: 0, told: false };
  /** Set once the signs are there but the time isn't yet: someone who looks around, then goes still, is still lost. */
  let huntTimer: ReturnType<typeof setTimeout> | undefined;
  const resetHunt = (keepBackAndForth = false) => {
    if (huntTimer !== undefined) clearTimeout(huntTimer);
    huntTimer = undefined;
    Object.assign(hunt, { page: screenOf(opts.currentPath()), since: now(), reversals: 0, menus: 0, find: 0, dir: 0, travel: 0, y: win?.scrollY ?? 0, told: false });
    hunt.hovered.clear();
    if (!keepBackAndForth) hunt.backForth = 0;
  };
  const checkHunt = () =>
    run(() => {
      const page = hunt.page;
      const seen: Record<SearchSign, number> = { hovered: hunt.hovered.size, scrolled: hunt.reversals, menus: hunt.menus, find: hunt.find, back_and_forth: hunt.backForth };
      const signs = (Object.keys(SEARCH_SIGNS) as SearchSign[]).filter((k) => seen[k] >= SEARCH_SIGNS[k]);
      const elapsed = now() - hunt.since;
      if (hunt.told || signs.length < 2) return;
      if (elapsed < SEARCHING_MIN_MS) {
        if (huntTimer === undefined) huntTimer = setTimeout(() => {
          huntTimer = undefined;
          checkHunt();
        }, SEARCHING_MIN_MS - elapsed + 50);
        return;
      }
      hunt.told = true;
      report({ type: "searching", page, count: hunt.hovered.size, durationMs: Math.round(elapsed), signs });
    });
  const onScroll = () =>
    run(() => {
      const y = win?.scrollY ?? 0;
      const moved = y - hunt.y;
      if (Math.abs(moved) < 1) return;
      const dir = Math.sign(moved);
      if (hunt.dir !== 0 && dir !== hunt.dir) {
        if (hunt.travel >= SCROLL_REVERSAL_PX) hunt.reversals++;
        hunt.travel = 0;
      }
      hunt.travel += Math.abs(moved);
      hunt.dir = dir;
      hunt.y = y;
      checkHunt();
    });
  const onHuntClick = (e: Event) =>
    run(() => {
      const target = eventOrigin(e);
      if (!target || opts.isOwnUi(target) || !target.closest(OPENERS)) return;
      hunt.menus++;
      checkHunt();
    });
  const onKey = (e: Event) =>
    run(() => {
      const k = e as KeyboardEvent;
      if ((k.metaKey || k.ctrlKey) && k.key?.toLowerCase() === "f") {
        hunt.find++;
        checkHunt();
      }
    });

  // ---- drags that didn't take: moved, let go, and back where it started with nothing saved ----
  // Only things made to be dragged (a grab or move cursor, draggable, or marked as such), so
  // selecting text or nudging the page never counts.
  let lastWriteAt = -Infinity;
  const DRAG_MIN_PX = 40;
  const draggable = (el: Element) =>
    el.closest("[draggable='true'], [aria-grabbed], [aria-roledescription*='drag' i], [data-rbd-drag-handle-draggable-id], [data-dnd-kit-draggable]") ??
    (() => {
      for (let n: Element | null = el; n && n !== doc.body; n = n.parentElement) {
        const cursor = doc.defaultView?.getComputedStyle(n).cursor ?? "";
        if (cursor === "grab" || cursor === "move" || cursor === "grabbing") return n;
      }
      return null;
    })();
  /** Where an element sits: its parent and position among its siblings. */
  const placeOf = (el: Element) => ({ parent: el.parentElement, index: el.parentElement ? [...el.parentElement.children].indexOf(el) : -1 });
  let dragging: { el: Element; x: number; y: number; at: number; place: ReturnType<typeof placeOf>; label: string } | undefined;
  const failedDrags = new Map<string, number>();
  const onDown = (e: Event) =>
    run(() => {
      const m = e as MouseEvent;
      if (m.button !== 0 || pointer === "touch") return;
      const target = eventOrigin(e);
      if (!target || opts.isOwnUi(target)) return;
      const el = draggable(target);
      if (!el) return;
      dragging = { el, x: m.clientX, y: m.clientY, at: now(), place: placeOf(el), label: opts.labelOf(el) ?? (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) };
    });
  const onUp = (e: Event) =>
    run(() => {
      const d = dragging;
      dragging = undefined;
      const m = e as MouseEvent;
      if (!d || Math.hypot(m.clientX - d.x, m.clientY - d.y) < DRAG_MIN_PX) return;
      const upAt = now();
      setTimeout(() => run(() => {
        // Back where it started (or the same item drawn again in the same place), and nothing saved.
        const el = d.el.isConnected ? d.el : null;
        const same = el ? placeOf(el) : undefined;
        if (!same || same.parent !== d.place.parent || same.index !== d.place.index || lastWriteAt >= upAt) return;
        const n = (failedDrags.get(d.label) ?? 0) + 1;
        failedDrags.set(d.label, n);
        if (n >= 2) report({ type: "failed_drag", page: opts.currentPath(), target: d.label, count: n });
      }), 500);
    });

  // ---- hesitation: hovering a button repeatedly / for long without pressing ----
  // Not over a card or panel that happens to be clickable (a dashboard tile, a list row
  // of content): people rest the pointer on what they are reading, without deciding anything.
  const isPanel = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.height > PANEL_HEIGHT || r.width * r.height > PANEL_AREA;
  };
  const hover = new Map<Element, { enters: number; total: number; enteredAt?: number; pressed: boolean }>();
  // Touch screens have no hover: the "mouseover" a browser fires for each tap is not someone hovering.
  let pointer = "mouse";
  const onPointer = (e: Event) => {
    pointer = (e as PointerEvent).pointerType || pointer;
  };
  const onOver = (e: Event) =>
    run(() => {
      if (pointer === "touch") return;
      const el = eventOrigin(e)?.closest(CLICKABLE) ?? null;
      if (!el || opts.isOwnUi(el) || isPanel(el)) return;
      const h = hover.get(el) ?? { enters: 0, total: 0, pressed: false };
      if (h.enteredAt === undefined) {
        h.enters++;
        h.enteredAt = now();
      }
      hover.set(el, h);
      // Different things looked at, by what they say: a list's repeated button counts once.
      if (hunt.hovered.size < 50) hunt.hovered.add(opts.labelOf(el) ?? `#${hover.size}`);
      checkHunt();
    });
  const onOut = (e: Event) =>
    run(() => {
      const el = eventOrigin(e)?.closest(CLICKABLE) ?? null;
      const h = el ? hover.get(el) : undefined;
      if (!el || !h || h.enteredAt === undefined) return;
      const related = (e as MouseEvent).relatedTarget;
      if (related instanceof Node && el.contains(related)) return;
      h.total += now() - h.enteredAt;
      h.enteredAt = undefined;
      if (!h.pressed && (h.enters >= 3 || (h.enters >= 2 && h.total >= 4000)) && !repeatedLabel(opts.labelOf(el))) report({ type: "hesitation", page: opts.currentPath(), target: opts.labelOf(el) ?? "", count: h.enters, durationMs: Math.round(h.total) });
    });

  // ---- rage and dead clicks ----
  let clicks: { el: Element; at: number }[] = [];
  /** A navigation our own help started ("Take me there") is not the user turning back. */
  let ownUiClickAt = -Infinity;
  /** A real page load the browser has started (a link, or a form posting to the server): the click worked. */
  let navigationStartedAt = -Infinity;
  const markIfNavigating = (e: Event, at: number) =>
    setTimeout(() => {
      if (!e.defaultPrevented) navigationStartedAt = Math.max(navigationStartedAt, at);
    }, 0);
  /**
   * The browser or another window took over after a click: a file picker (apps open one by
   * clicking a hidden file input), a sign-in pop-up, a print or share dialog. The page doesn't
   * change, but the click worked.
   */
  let browserTookOverAt = -Infinity;
  /** The page's own script broke after a press: that press is a crash, not a dead click. */
  let crashedAt = -Infinity;
  const onClick = (e: Event) =>
    run(() => {
      const target = eventOrigin(e);
      if (target?.matches("input[type='file']")) browserTookOverAt = now();
      if (target && opts.isOwnUi(target)) ownUiClickAt = now();
      if (!target || opts.isOwnUi(target)) return;
      const el = target.closest(LOOKS_CLICKABLE) ?? target;
      const at = now();
      const h = hover.get(el);
      if (h) h.pressed = true;

      // A plain link to another document starts loading it, unless the app handles the click itself.
      const link = target.closest("a[href]") as HTMLAnchorElement | null;
      if (link && !link.target && link.getAttribute("href") !== "#" && !/^(#|javascript:)/i.test(link.getAttribute("href") ?? "")) markIfNavigating(e, at);

      clicks = clicks.filter((c) => at - c.at < 1000);
      clicks.push({ el, at });
      const same = clicks.filter((c) => c.el === el).length;
      if (same >= 3) report({ type: "rage_click", page: opts.currentPath(), target: opts.labelOf(el) ?? el.tagName.toLowerCase(), count: same });

      // Dead click: something that looks clickable, nothing happened afterwards. A submit the
      // browser blocked for invalid fields is not dead: that is the validation-loop signal.
      // A short label ending in a caret ("Open ▾") looks like a menu, whatever the page made it.
      const caret = !target.closest(LOOKS_CLICKABLE) && /^.{1,40}\s?[▾▼⌄⏷˅▿]$/.test((el.textContent ?? "").trim());
      if (!target.closest(BROWSER_HANDLED) && (target.closest(LOOKS_CLICKABLE) || caret || (win && win.getComputedStyle(el).cursor === "pointer"))) {
        const page = opts.currentPath();
        setTimeout(
          () =>
            run(() => {
              // A slow page load is not a dead click: the next page is on its way.
              // Nor one that moved them (closed a pop-up, changed step) or broke the page: that's a crash.
              if (!opts.somethingHappenedSince(at) && lastInvalidAnyAt < at && navigationStartedAt < at && browserTookOverAt < at && crashedAt < at && opts.currentPath() === page && el.isConnected) report({ type: "dead_click", page, target: opts.labelOf(el) ?? el.tagName.toLowerCase() });
            }),
          opts.deadClickWaitMs ?? 1000,
        );
      }
    });

  // ---- field churn and form progress (field names only) ----
  const fieldBursts = new Map<string, { bursts: number; lastAt: number }>();
  const touchedForms = new Map<Element, Set<string>>();
  /** Forms in a pop-up: typing into one and closing it is leaving it, even after one field. */
  const dialogForms = new WeakSet<Element>();
  const submittedForms = new WeakSet<Element>();
  /** The field last typed in, per form: what a form with no name of its own is known by when left. */
  const lastTouched = new Map<Element, string>();
  const invalidSubmits = new Map<Element, number>();
  const fieldName = (el: Element) => fieldKey(el);
  /** Fields edited since the last save went through. */
  const editedSinceSave = new Set<string>();
  const onInput = (e: Event) =>
    run(() => {
      const el = eventOrigin(e)?.closest(FIELD) ?? null;
      if (!el || opts.isOwnUi(el)) return;
      const name = fieldName(el);
      if (!name) return;
      const at = now();
      typedOnPage = true;
      editedSinceSave.add(name);
      // Choosing a file is one choice, not editing: a failing upload shows up as the upload failing.
      if (el.matches("input[type='file']")) return;
      const f = fieldBursts.get(name) ?? { bursts: 0, lastAt: 0 };
      if (at - f.lastAt > 2000) f.bursts++; // a new burst of editing after a pause
      f.lastAt = at;
      fieldBursts.set(name, f);
      if (f.bursts >= 4) report({ type: "field_churn", page: opts.currentPath(), target: name, count: f.bursts });
      // Typing in a search or command box is looking for something, not filling in a form (re-editing
      // one again and again still counts, above: that's someone who can't find it).
      if (el.matches(SEARCH_BOX)) return;
      const form = el.closest("form") ?? doc.body;
      const set = touchedForms.get(form) ?? new Set<string>();
      set.add(name);
      touchedForms.set(form, set);
      lastTouched.set(form, name);
      if (el.closest(IN_DIALOG)) dialogForms.add(form);
    });
  // ---- stalling in a field: in it, empty, typing nothing, for a long while ----
  let fieldWait: ReturnType<typeof setTimeout> | undefined;
  const stopFieldWait = () => {
    if (fieldWait !== undefined) clearTimeout(fieldWait);
    fieldWait = undefined;
  };
  const onFieldFocus = (e: Event) =>
    run(() => {
      stopFieldWait();
      const el = eventOrigin(e)?.closest(FIELD) ?? null;
      if (!el || opts.isOwnUi(el) || el.matches(SEARCH_BOX) || el.matches("select, input[type=checkbox], input[type=radio], input[type=file]")) return;
      if ((el as HTMLInputElement).value) return;
      const name = fieldName(el);
      if (!name) return;
      const page = opts.currentPath();
      fieldWait = setTimeout(() => run(() => {
        fieldWait = undefined;
        // Still there, still empty, page in view: unsure what to put.
        if (doc.activeElement === el && !(el as HTMLInputElement).value && doc.visibilityState !== "hidden" && opts.currentPath() === page) {
          report({ type: "hesitation", page, target: name, durationMs: FIELD_STALL_MS });
        }
      }), FIELD_STALL_MS);
    });
  const lastInvalidAt = new Map<Element, number>();
  const countedOnSubmitAt = new Map<Element, number>();
  let lastInvalidAnyAt = -1;
  const firstRejected = new Map<Element, string>();
  const rejectedHow = new Map<Element, "empty" | "rejected">();
  /** Empty, or filled but refused: from the browser's validity flags or the value's length, never the value. */
  const how = (field: Element): "empty" | "rejected" => {
    const input = field as HTMLInputElement;
    if (input.validity?.valueMissing) return "empty";
    return typeof input.value === "string" && input.value.length === 0 ? "empty" : "rejected";
  };
  const countInvalidAttempt = (form: Element) => {
    const n = (invalidSubmits.get(form) ?? 0) + 1;
    invalidSubmits.set(form, n);
    const detail = rejectedHow.get(form);
    const control = submitLabel(form);
    if (n >= 2) report({ type: "validation_loop", page: opts.currentPath(), target: firstRejected.get(form) ?? (form.getAttribute("name") || form.id), count: n, ...(detail ? { detail } : {}), ...(control ? { control } : {}) });
  };
  // Browser validation blocks the submit and fires "invalid" on each bad field: one burst = one attempt.
  const onInvalid = (e: Event) =>
    run(() => {
      const field = eventOrigin(e);
      if (!field || opts.isOwnUi(field)) return;
      const form = field.closest("form") ?? doc.body;
      const at = now();
      lastInvalidAnyAt = at;
      const last = lastInvalidAt.get(form);
      lastInvalidAt.set(form, at);
      const newAttempt = last === undefined || at - last > 300;
      // The first field the browser rejects in an attempt is the one to name.
      if (newAttempt && fieldName(field)) {
        firstRejected.set(form, fieldName(field));
        rejectedHow.set(form, how(field));
      }
      if (newAttempt) countInvalidAttempt(form);
    });
  // Apps that validate themselves let the submit through and flag fields aria-invalid.
  const onSubmit = (e: Event) =>
    run(() => {
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (!form) return;
      typedOnPage = true;
      submittedForms.add(form);
      // A form the app doesn't handle itself posts to the server: a page load is under way.
      markIfNavigating(e, now());
      const flagged = form.querySelector("[aria-invalid='true']");
      if (flagged) {
        countedOnSubmitAt.set(form, now());
        if (fieldName(flagged)) {
          firstRejected.set(form, fieldName(flagged));
          rejectedHow.set(form, how(flagged));
        }
        countInvalidAttempt(form);
      }
    });
  /**
   * Called by the host loop when a write request follows: counts as submitting the touched forms (SPAs rarely fire submit).
   * A failed one whose reply blames a field on this page is the form being rejected, as if the page
   * had flagged that field (many apps only show a vague line of text).
   */
  const markSubmitted = (ok = true, field?: string): boolean => {
    lastWriteAt = now();
    const blamed = !ok && field ? [...doc.querySelectorAll("input, select, textarea")].find((f) => (f as HTMLInputElement).name === field || f.id === field) : undefined;
    if (blamed) run(() => {
      const form = blamed.closest("form") ?? doc.body;
      // Already counted from the page's own flags for this submit.
      if (now() - (countedOnSubmitAt.get(form) ?? -Infinity) < 3000) return;
      firstRejected.set(form, fieldName(blamed) || field!);
      rejectedHow.set(form, how(blamed));
      countInvalidAttempt(form);
    });
    // Saved: editing those fields again is writing (an autosaving form), not struggling. A save that
    // failed leaves them counting.
    if (ok) {
      for (const name of editedSinceSave) fieldBursts.delete(name);
      editedSinceSave.clear();
    }
    for (const form of touchedForms.keys()) submittedForms.add(form);
    // Getting somewhere ends a search.
    resetHunt();
    return blamed !== undefined;
  };

  // ---- forms the server rejected (multi-page sites) ----
  // A server-rendered site answers a bad submit with a new page whose fields are marked
  // aria-invalid. Each such page is a fresh document, so the count of rejections is kept
  // for this tab (session storage: a number and a time, nothing else) for two minutes.
  run(() => {
    // The form the server sent back: a field it marked, or (no field marked) an error message by a
    // form that came back with an error status or with what they typed still in it.
    const marked = doc.querySelector("form [aria-invalid='true']");
    const status = (win?.performance?.getEntriesByType?.("navigation")[0] as { responseStatus?: number } | undefined)?.responseStatus ?? 0;
    const bounced = marked ? undefined : [...doc.querySelectorAll("form")].find((f) => {
      const near = [f, f.previousElementSibling, f.parentElement].filter((x): x is Element => x !== null);
      const said = near.some((x) => x.matches(ERROR_NOTE) || x.querySelector(ERROR_NOTE) !== null);
      const refilled = [...f.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea")].some((x) => (x as HTMLInputElement).value !== "");
      return said && ((status >= 400 && status < 500) || refilled);
    });
    const flagged = marked ?? bounced ?? null;
    // A form posted to another address and sent back there (/recipes for the form at /recipes/new):
    // it's the page they filled it in on.
    const here = opts.currentPath();
    const sentFrom = bounced && doc.referrer ? opts.pathOf?.(doc.referrer) : undefined;
    // Sent again from the page it came back on: still the form from where it started.
    const fromKey = `ctx:formfrom:${here}`;
    const from = sentFrom === here ? run(() => win?.sessionStorage?.getItem(fromKey) ?? undefined) : sentFrom;
    if (from && sentFrom !== here) run(() => win?.sessionStorage?.setItem(fromKey, from));
    const where = from ?? here;
    const key = `ctx:rejected:${where}`;
    const store = win?.sessionStorage;
    if (!store) return;
    if (!flagged) {
      store.removeItem(key);
      return;
    }
    let previous: { n: number; at: number } | undefined;
    try {
      previous = JSON.parse(store.getItem(key) ?? "null") ?? undefined;
    } catch {
      previous = undefined;
    }
    const n = (previous && now() - previous.at < 120_000 ? previous.n : 0) + 1;
    store.setItem(key, JSON.stringify({ n, at: now() }));
    const control = submitLabel(flagged.closest("form") ?? doc.body);
    // No field named: the form is known by its button ("Save recipe").
    const target = marked ? fieldName(marked) : control ?? "";
    if (n >= 2) report({ type: "validation_loop", page: where, target, count: n, detail: marked ? how(marked) : "rejected", ...(control ? { control } : {}) });
  });

  // ---- u-turns across full page loads (multi-page sites) ----
  // Each page is a fresh document, so the last two pages are kept for this tab (their addresses
  // and when they were reached, nothing else): back on the page before last within 3s of reaching
  // the last one, without typing or sending anything there, is a u-turn on it.
  const TRAIL = "ctx:trail";
  const trailNow = (): { exact: string; path: string; at: number; did?: boolean }[] => {
    try {
      const t = JSON.parse(win?.sessionStorage?.getItem(TRAIL) ?? "[]") as unknown;
      return Array.isArray(t) ? (t as { exact: string; path: string; at: number; did?: boolean }[]).slice(-2) : [];
    } catch {
      return [];
    }
  };
  const saveTrail = (t: ReturnType<typeof trailNow>) => run(() => win?.sessionStorage?.setItem(TRAIL, JSON.stringify(t.slice(-2))));
  const arrive = () =>
    run(() => {
      if (!win?.location || !win.sessionStorage) return;
      const here = { exact: win.location.pathname + win.location.search, path: opts.currentPath(), at: Date.now() };
      const t = trailNow();
      const last = t[t.length - 1];
      const before = t.length > 1 ? t[t.length - 2] : undefined;
      if (before && last && here.exact === before.exact && here.exact !== last.exact && here.at - last.at < 3000 && !last.did && !anItem(last.path)) {
        report({ type: "u_turn", page: last.path, durationMs: here.at - last.at });
      }
      saveTrail([...(last ? [last] : []), here]);
    });
  arrive();
  // Back to a page the browser kept (the back-forward cache): an arrival too, though nothing reloads.
  win?.addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) arrive(); });
  /** Typed or sent something on this page: leaving it quickly isn't turning back. */
  const didSomethingHere = () =>
    run(() => {
      const t = trailNow();
      const last = t[t.length - 1];
      if (last && !last.did) saveTrail([...t.slice(0, -1), { ...last, did: true }]);
    });
  doc.addEventListener("input", didSomethingHere, { capture: true, passive: true, once: true });
  doc.addEventListener("submit", didSomethingHere, { capture: true, passive: true, once: true });

  // ---- leaving the page: abandonment and u-turns ----
  let arrivedAt = now();
  let arrivedPath = opts.currentPath();

  // ---- searches that find nothing ----
  let emptySearches = 0;
  let lastSearchAt = -Infinity;
  const searched = (empty: boolean) =>
    run(() => {
      const at = now();
      if (!empty || at - lastSearchAt > SEARCH_RUN_MS) emptySearches = 0;
      lastSearchAt = at;
      if (!empty) return;
      emptySearches++;
      if (emptySearches >= 2) report({ type: "no_results", page: opts.currentPath(), count: emptySearches });
    });
  // Searches done in the browser (filtering a list) send nothing: read the screen after typing in a search box.
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSearchInput = (e: Event) =>
    run(() => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || !el.matches(SEARCH_BOX) || opts.isOwnUi(el)) return;
      if (searchTimer !== undefined) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => run(() => {
        searchTimer = undefined;
        if (!(el as HTMLInputElement).value?.trim()) return;
        // Where its results show: the list it controls, the pop-up it's in (a ⌘K menu), or the page.
        const controls = el.getAttribute("aria-controls");
        const results = (controls ? doc.getElementById(controls) : null) ?? el.closest(IN_DIALOG) ?? doc.querySelector("main") ?? doc.body;
        searched(EMPTY_STATE.test(visibleText(results)));
      }), SEARCH_SETTLE_MS);
    });
  doc.addEventListener("input", onSearchInput, { capture: true, passive: true });

  // ---- the app breaking: errors after a press, and error pages ----
  /** The last press, for "it broke right after I pressed X". */
  let lastPress: { label: string; at: number } | undefined;
  const onPress = (e: Event) =>
    run(() => {
      const target = eventOrigin(e);
      if (!target || opts.isOwnUi(target)) return;
      lastPress = { label: opts.labelOf(target.closest(LOOKS_CLICKABLE) ?? target) ?? "", at: now() };
      if (pointer === "touch" && e instanceof MouseEvent) checkMissedTap(target, e.clientX, e.clientY);
    });
  // A tap that lands on nothing, just beside a button: twice near the same one and it is too small to hit.
  const misses = new Map<Element, { count: number; at: number }>();
  const checkMissedTap = (target: Element, x: number, y: number) => {
    if (target.closest(LOOKS_CLICKABLE) || target.closest(BROWSER_HANDLED)) return;
    let nearest: Element | undefined;
    let best = MISS_RADIUS + 1;
    for (const el of [...doc.querySelectorAll(CLICKABLE)].slice(0, MAX_TAP_CANDIDATES)) {
      if (opts.isOwnUi(el)) continue;
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (r.width > 0 && d <= MISS_RADIUS && d < best) {
        best = d;
        nearest = el;
      }
    }
    if (!nearest) return;
    const at = now();
    const m = misses.get(nearest);
    const count = m && at - m.at < MISS_WINDOW_MS ? m.count + 1 : 1;
    misses.set(nearest, { count, at });
    if (count >= 2) report({ type: "missed_tap", page: opts.currentPath(), target: opts.labelOf(nearest) ?? nearest.tagName.toLowerCase(), count });
  };
  doc.addEventListener("click", onPress, { capture: true, passive: true });
  doc.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  doc.addEventListener("pointerover", onPointer, { capture: true, passive: true });
  const onAppError = (e: Event) =>
    run(() => {
      if (!lastPress || now() - lastPress.at > CRASH_AFTER_PRESS_MS) return; // nobody caused it: background noise
      if (e instanceof ErrorEvent) {
        // Another site's script ("Script error.", no file) or a known harmless browser warning.
        if (!e.filename || HARMLESS.test(e.message ?? "")) return;
        const origin = run(() => new URL(e.filename).origin);
        if (origin && win && origin !== win.location.origin && !sameSite(origin, win.location.origin)) return;
      }
      crashedAt = now();
      report({ type: "crash", page: opts.currentPath(), ...(lastPress.label ? { target: lastPress.label } : {}) });
    });
  win?.addEventListener("error", onAppError);
  win?.addEventListener("unhandledrejection", onAppError);
  let errorPageTimer: ReturnType<typeof setTimeout> | undefined;
  /** Read once the page has drawn: its status, or a title or main heading that says it is an error. */
  const checkErrorPage = (first: boolean) => {
    if (errorPageTimer !== undefined) clearTimeout(errorPageTimer);
    const page = opts.currentPath();
    errorPageTimer = setTimeout(() => run(() => {
      errorPageTimer = undefined;
      if (opts.currentPath() !== page) return;
      const nav = first ? (win?.performance?.getEntriesByType?.("navigation")[0] as (PerformanceEntry & { responseStatus?: number }) | undefined) : undefined;
      const heading = doc.querySelector("h1")?.textContent ?? "";
      // 404/410: the page doesn't exist; 5xx: the server broke. A 400 or 422 re-showing a form is a normal "fix this" reply.
      const status = nav?.responseStatus ?? 0;
      if (status === 404 || status === 410 || status >= 500 || ERROR_PAGE.test(doc.title) || ERROR_PAGE.test(heading)) report({ type: "error_page", page });
    }), ERROR_PAGE_WAIT_MS);
  };
  checkErrorPage(true);
  let cameFrom: string | undefined;
  /** The exact addresses (not the screen names): ticket 1041 then ticket 1042 is moving on, not going back. */
  const exactPath = () => (win?.location ? win.location.pathname + win.location.search + win.location.hash : opts.currentPath());
  let cameFromExact: string | undefined;
  let arrivedExact = exactPath();
  let typedOnPage = false;
  const onLeave = (reason: "navigate" | "unload") =>
    run(() => {
      const at = now();
      const goingTo = opts.currentPath();
      // On to the next step of the same pop-up or wizard: still filling it in, so what they typed carries on.
      const nextStep = reason === "navigate" && goingTo.includes("/~") && arrivedPath.includes("/~") && screenOf(goingTo) === screenOf(arrivedPath);
      if (!nextStep) {
        for (const [form, fields] of touchedForms) {
          const named = form instanceof HTMLFormElement ? form.getAttribute("name") || form.id : "";
          if (!submittedForms.has(form) && (fields.size >= 2 || dialogForms.has(form))) report({ type: "form_abandon", page: arrivedPath, target: named || (form instanceof HTMLFormElement ? "" : lastTouched.get(form) ?? ""), count: fields.size });
        }
      }
      const helpNavigated = at - ownUiClickAt < 1000;
      // Back to the page they just came from, after looking at it: one search across both pages.
      const backAndForth = reason === "navigate" && goingTo === cameFrom && goingTo !== arrivedPath && at - arrivedAt >= 3000 && !helpNavigated;
      checkHunt();
      // Another tab or view of the same screen: still the same search.
      const sameScreen = reason === "navigate" && screenOf(goingTo) === screenOf(arrivedPath);
      // Closing a pop-up or stepping back within one screen is not a u-turn: having a quick look is normal.
      // Saving something there is doing something, however quickly.
      const savedHere = lastWriteAt >= arrivedAt;
      if (reason === "navigate" && !sameScreen && at - arrivedAt < 3000 && !typedOnPage && !savedHere && !helpNavigated && cameFrom !== undefined && goingTo === cameFrom && goingTo !== arrivedPath && exactPath() === cameFromExact) {
        if (!anItem(arrivedPath)) report({ type: "u_turn", page: arrivedPath, durationMs: at - arrivedAt });
      }
      // Reset per-page state.
      if (backAndForth) {
        hunt.backForth++;
        hunt.told = false;
        hunt.page = screenOf(goingTo);
      } else if (!sameScreen) resetHunt();
      if (!nextStep) {
        touchedForms.clear();
        lastTouched.clear();
      }
      fieldBursts.clear();
      // Another tab of the same screen: what they pressed and were told there still stands.
      if (!sameScreen) {
        hover.clear();
        reported.clear();
        failedDrags.clear();
      }
      typedOnPage = false;
      cameFrom = arrivedPath;
      cameFromExact = arrivedExact;
      arrivedExact = exactPath();
      arrivedAt = at;
      if (reason === "navigate") checkErrorPage(false);
      arrivedPath = goingTo;
    });

  doc.addEventListener("mouseover", onOver, { capture: true, passive: true });
  win?.addEventListener("scroll", onScroll, { passive: true });
  doc.addEventListener("mousedown", onDown, { capture: true, passive: true });
  doc.addEventListener("mouseup", onUp, { capture: true, passive: true });
  doc.addEventListener("click", onHuntClick, { capture: true, passive: true });
  doc.addEventListener("keydown", onKey, { capture: true, passive: true });
  doc.addEventListener("mouseout", onOut, { capture: true, passive: true });
  doc.addEventListener("click", onClick, { capture: true, passive: true });
  doc.addEventListener("input", onInput, { capture: true, passive: true });
  doc.addEventListener("focusin", onFieldFocus, { capture: true, passive: true });
  doc.addEventListener("focusout", stopFieldWait, { capture: true, passive: true });
  doc.addEventListener("input", stopFieldWait, { capture: true, passive: true });
  doc.addEventListener("submit", onSubmit, { capture: true, passive: true });
  doc.addEventListener("invalid", onInvalid, { capture: true, passive: true });
  // Inside web components, "invalid" and "submit" never reach the document: listen in each
  // open shadow root the user touches (found on the way of their clicks and typing).
  const watchedRoots = new Set<ShadowRoot>();
  const watchShadows = (e: Event) =>
    run(() => {
      if (typeof e.composedPath !== "function") return;
      for (const node of e.composedPath()) {
        if (!(node instanceof ShadowRoot) || watchedRoots.has(node) || watchedRoots.size >= 50) continue;
        watchedRoots.add(node);
        node.addEventListener("invalid", onInvalid, { capture: true, passive: true });
        node.addEventListener("submit", onSubmit, { capture: true, passive: true });
      }
    });
  doc.addEventListener("click", watchShadows, { capture: true, passive: true });
  doc.addEventListener("focusin", watchShadows, { capture: true, passive: true });
  const onPageHide = () => onLeave("unload");
  win?.addEventListener("pagehide", onPageHide);
  // Script-started page loads (sign in with Google/Apple, payment redirects) don't come from a
  // link we can see: the browser announces them here, before the other site starts loading.
  const onLeaving = () => {
    navigationStartedAt = now();
  };
  win?.addEventListener("beforeunload", onLeaving);
  // A picker, dialog or pop-up takes focus from the page; a new tab hides it.
  const onTakenOver = () => {
    browserTookOverAt = now();
  };
  win?.addEventListener("blur", onTakenOver);
  doc.addEventListener("visibilitychange", onTakenOver);

  return Object.assign(
    () => {
      doc.removeEventListener("mouseover", onOver, { capture: true });
      win?.removeEventListener("scroll", onScroll);
      doc.removeEventListener("mousedown", onDown, { capture: true });
      doc.removeEventListener("mouseup", onUp, { capture: true });
      if (huntTimer !== undefined) clearTimeout(huntTimer);
      doc.removeEventListener("click", onHuntClick, { capture: true });
      doc.removeEventListener("keydown", onKey, { capture: true });
      doc.removeEventListener("mouseout", onOut, { capture: true });
      doc.removeEventListener("click", onClick, { capture: true });
      doc.removeEventListener("input", onInput, { capture: true });
      doc.removeEventListener("submit", onSubmit, { capture: true });
      doc.removeEventListener("invalid", onInvalid, { capture: true });
      doc.removeEventListener("click", watchShadows, { capture: true });
      doc.removeEventListener("focusin", watchShadows, { capture: true });
      for (const root of watchedRoots) {
        root.removeEventListener("invalid", onInvalid, { capture: true });
        root.removeEventListener("submit", onSubmit, { capture: true });
      }
      win?.removeEventListener("pagehide", onPageHide);
      win?.removeEventListener("beforeunload", onLeaving);
      win?.removeEventListener("blur", onTakenOver);
      doc.removeEventListener("click", onPress, { capture: true });
      doc.removeEventListener("input", onSearchInput, { capture: true });
      if (searchTimer !== undefined) clearTimeout(searchTimer);
      doc.removeEventListener("pointerdown", onPointer, { capture: true });
      doc.removeEventListener("pointerover", onPointer, { capture: true });
      win?.removeEventListener("error", onAppError);
      win?.removeEventListener("unhandledrejection", onAppError);
      if (errorPageTimer !== undefined) clearTimeout(errorPageTimer);
      doc.removeEventListener("visibilitychange", onTakenOver);
    },
    { pageChanged: () => onLeave("navigate"), markSubmitted, searched },
  );
}
