/**
 * The cover: what keeps a stored value out of the live screen, the video and the step photos of a run
 * that keeps them (a signed-in run, a sign-in itself, a run that types a --var or an account's value).
 * It is drawn by the page itself, so whatever captures the page (Chromium's screencast for the live
 * screen, Playwright's video, a photo) captures it too. All of it runs in every frame of every page of
 * the run's browser context (a popup too), before the page's own scripts:
 *
 * - The mask: a box's text drawn as dots (-webkit-text-security: disc; where an engine has no such
 *   thing, drawn transparent), by a constructed style sheet (one a page's CSP doesn't stop), with a
 *   selector of high specificity, in the document and in every open shadow root found. It is on:
 *   - secure fields always (passwords, card and code fields, by SECURE_FIELDS);
 *   - every text box, while a stored value is typed ("armed"): put on, and seen painted (two frames,
 *     and every box's computed style read back in every frame of the page) before the first key;
 *   - every box a stored value went into afterwards, by a marker attribute: the box typed into, any box
 *     whose value changed while armed (a box the page drew again mid-typing), a box drawn again in its
 *     place (the same name, id, label), and any box whose value holds a stored value (on the run's own
 *     site). Marked before the frame that would show it is painted (requestAnimationFrame).
 * - The card ("Typing a stored value"): only where the mask can't be seen painted first (a frame that
 *   can't be read, a box the mask doesn't reach). Put up and painted before the first key, in the top
 *   layer, and taken away once the step's action is over and no box the run typed a secret into shows
 *   a value unmasked (a box in another site's frame counts as showing one: it can't be read).
 * - The guard: before every frame the page draws, every field's value and the page's own words are
 *   compared against the run's stored values, held only as salted hashes (the values never go into the
 *   page). A box that holds one is masked; the page's own words that show a password, a code or a key
 *   put a card up for that frame, whatever the run is doing. Only on the run's own site (and hosts it
 *   was allowed), which was given the values anyway. The account's username or email in the page's own
 *   words is shown (a signed-in page shows it in its header); in a box, it is dots. While a password, a
 *   code, a key or a --var is typed ("strict"), any change in the page's own words puts the card up too:
 *   a page may echo part of it (a code's slots, a suggestion list), which no hash of the whole finds.
 *   The guard looks again in a MutationObserver too, so a change the page makes after our own frame
 *   callback is masked or covered in that same frame. Just before the first key the run reads the box
 *   back as dots (maskedAt), once any code made for it is held; not, the card.
 *
 * The card is aria-hidden, inert, lets every click through, and keeps its words in a closed shadow root,
 * so the outline, the checks and the actions never see it. It is kept on top: re-attached at once if the
 * page removes it, raised again over a dialog or popover the page opens. The AI's pictures are not made
 * while it is up (a run with a stored value sends none). Every arm, paint, show and hide is logged with
 * its time, so a test can measure that nothing was typed with the page unmasked.
 */
import { randomBytes, randomInt } from "node:crypto";
import type { BrowserContext, Disposable, Locator, Page } from "playwright";
import { SECURE_FIELDS, type SecretFields } from "./maskshot.ts";

/** The card's colour: a flat dark blue, so a frame of it is easy to tell by its pixels. */
export const COVER_COLOR = "#1E2A44";
/** The card's words while a stored value is typed. */
export const TYPING_CARD = "Typing a stored value";
/** The card's words while the page itself shows a stored value (the guard). */
export const SHOWS_CARD = "A stored value is on the page";
/** Said under the card. */
export const COVER_SUB = "Hidden in the live screen and the video";
/** What the page's own words may still show, said with every note about a covered video. */
export const VIDEO_STILL_SHOWS = "The page's own words, such as the account's name, can still show.";
/** What the result and the report say about stored values typed in a video: boxes as dots. */
export const VIDEO_DOTS = "Stored values typed in it show as dots in their boxes.";
/** What they say when a card stood in for a moment the boxes couldn't be masked, or the page showed a stored value. */
export const VIDEO_CARD = "A card stands in for any moment a box couldn't be masked first, or the page's own words showed a password, code or key.";
/** Shortest stored value looked for in a field's value; in the page's words, MIN_TEXT (shorter ones match ordinary words). */
export const MIN_FIELD = 3;
export const MIN_TEXT = 6;

export interface CoverEvent {
  /** Date.now() when it happened. */
  t: number;
  /** "assumed": the card was put up but the page drew no frame to prove it (a hidden window: nothing is captured then either). */
  kind: "show" | "painted" | "assumed" | "hide" | "unpainted" | "kept" | "failed" | "arm" | "masked" | "unmasked" | "disarm";
  words?: string;
}

/** The stored values as the guard holds them: hashes of their normalised form, by two salted bases. */
export interface Held {
  /** Each length to look for in a field's value, and in the page's words. */
  field: number[];
  text: number[];
  /** First hashes, for a quick no; then "first.second" for a yes. */
  first: number[];
  keys: string[];
  b1: number;
  b2: number;
}

interface Args {
  /** The window property this run's controls are kept under (random per run). */
  key: string;
  secure?: string;
  color?: string;
  sub?: string;
  /** The hosts the held values may be looked for on (the run's site, its allowed hosts). */
  hosts?: string[];
  held?: Held | null;
  /** The marker attribute that masks a box, and the selectors of every text box (while armed) and of a marked box: boosted. */
  mark?: string;
  entry?: string;
  marked?: string;
  /** The stored values looked for in boxes (the username and email too): a box that holds one is masked. */
  fheld?: Held | null;
  /** true arms (every text box masked), false disarms (the boxes changed meanwhile stay masked); absent leaves it. */
  typing?: boolean;
  /** With typing: true, a password, a code, a key or a --var is typed (not only a username or email): any change in the page's own words while armed puts the card up (a page that echoes part of what is typed). */
  strict?: boolean;
  /** Card words: a string puts the card up (top frame only), null takes it down; absent leaves it. */
  words?: string | null;
  /** Node only: hash these values (nothing is touched in a page). */
  hashOnly?: { values: string[]; b1: number; b2: number };
}

/**
 * Runs in the page (every frame, every new document, before the page's own scripts), and in Node only
 * to hash (`hashOnly`), so the page and Node hash alike. Self-contained: it is sent as source.
 */
function install(a: Args): unknown {
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");
  const power = (b: number, n: number) => {
    let p = 1;
    for (let k = 0; k < n; k++) p = Math.imul(p, b);
    return p;
  };
  const whole = (s: string, b: number) => {
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (Math.imul(h, b) + s.charCodeAt(k)) | 0;
    return h >>> 0;
  };
  if (a.hashOnly) {
    const { values, b1, b2 } = a.hashOnly;
    const ns = [...new Set(values.map(norm).filter((v) => v.length >= 3))];
    const field = [...new Set(ns.map((v) => v.length))].sort((x, y) => x - y);
    const text = field.filter((n) => n >= 6);
    return { field, text, first: ns.map((v) => whole(v, b1)), keys: ns.map((v) => `${whole(v, b1)}.${whole(v, b2)}`), b1, b2 } satisfies Held;
  }
  const W = window as unknown as Record<string, unknown>;
  type Api = (cmd: string, x?: unknown) => unknown;
  let api = W[a.key] as Api | undefined;
  if (typeof api !== "function") {
    const top = window.top === window;
    const secure = a.secure ?? "input[type=password]";
    const color = a.color ?? "#1E2A44";
    let sub = a.sub ?? "";
    let words: string | null = null;
    let held: Held | null = null;
    let firsts = new Set<number>();
    let keys = new Set<string>();
    /** The box values held (the username and email too), as hash sets. */
    let fheld: Held | null = null;
    let ffirsts = new Set<number>();
    let fkeys = new Set<string>();
    const markAttr = a.mark ?? "data-cm-dots";
    const entrySel = a.entry ?? "input, textarea";
    const markedSel = a.marked ?? `[${markAttr}], [${markAttr}] *`;
    let typing = false;
    let strict = false;
    /** The page's own words when a password, code or key began to be typed: any change while armed puts the card up. */
    let armWords: string | null = null;
    let echoHit = false;
    /** The document this window's controls watch (a frame's first about:blank window is reused by its next document). */
    let doc: Document | null = null;
    /** Each box's value when the mask was armed: one that changed (or is new) by the time it is disarmed stays masked. */
    let snap = new Map<Element, string>();
    /** The boxes masked by the marker, and what names them (so one drawn again in its place is masked too). */
    const marks = new Set<Element>();
    const ids = new Set<string>();
    let allowed = false;
    let hit = false;
    let textHit = false;
    let dirty = true;
    let looping = false;
    const typed = new Set<Element>();
    const roots = new Set<ShadowRoot>();
    const over = new WeakSet<Element>();
    let host: HTMLElement | undefined;
    let titleEl: HTMLElement | undefined;
    let subEl: HTMLElement | undefined;
    let shownWords = "";
    let here = "";
    try {
      here = new URL(self.origin).hostname.toLowerCase();
    } catch {
      here = "";
    }

    // The mask: dots where the engine draws them, else no text at all.
    let discs = false;
    try {
      discs = CSS.supports("-webkit-text-security", "disc");
    } catch {
      discs = false;
    }
    const MASK = discs ? "-webkit-text-security:disc!important;text-shadow:none!important" : "color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important";
    let sheet: CSSStyleSheet | undefined;
    const paintSheet = () => {
      try {
        sheet?.replaceSync(`${secure}{${MASK}} ${markedSel}{${MASK}}${typing ? ` ${entrySel}{${MASK}}` : ""}`);
      } catch {
        // the sheet is gone: armed() reads it back and says no
      }
    };
    try {
      sheet = new CSSStyleSheet();
    } catch {
      sheet = undefined;
    }
    paintSheet();
    const adopt = (d: Document | ShadowRoot) => {
      try {
        if (sheet && !d.adoptedStyleSheets.includes(sheet)) d.adoptedStyleSheets = [...d.adoptedStyleSheets, sheet];
      } catch {
        // nothing to adopt into here
      }
    };

    // Matching: a value's normalised form somewhere in a string, by rolling hashes.
    const foundIn = (s: string, lens: number[], hd: Held | null, fs: Set<number>, ks: Set<string>) => {
      if (!hd || !s) return false;
      const n = norm(s);
      for (const L of lens) {
        if (n.length < L) break;
        const pw = power(hd.b1, L - 1);
        let h = 0;
        for (let k = 0; k < n.length; k++) {
          if (k >= L) h = (h - Math.imul(n.charCodeAt(k - L), pw)) | 0;
          h = (Math.imul(h, hd.b1) + n.charCodeAt(k)) | 0;
          if (k >= L - 1 && fs.has(h >>> 0)) {
            const w = n.slice(k - L + 1, k + 1);
            if (ks.has(`${h >>> 0}.${whole(w, hd.b2)}`)) return true;
          }
        }
      }
      return false;
    };
    const found = (s: string, lens: number[]) => foundIn(s, lens, held, firsts, keys);
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);
    const wordsOf = (root: Node, boxesToo = true) => {
      const out: string[] = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (SKIP.has(t.parentElement?.tagName ?? "") || (!boxesToo && t.parentElement?.isContentEditable) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let t = walk.nextNode(); t; t = walk.nextNode()) out.push(t.nodeValue ?? "");
      return out.join("");
    };
    const findRoots = () => {
      // Open shadow roots, looked for before every frame (a component may attach one with no other
      // change to the page); a closed one can't be found.
      for (const r of roots) if (!r.host.isConnected) roots.delete(r);
      for (const e of Array.from(document.querySelectorAll("*"))) {
        const r = e.shadowRoot;
        if (r && e !== host && !roots.has(r)) addRoot(r);
      }
    };
    /** The shadow roots in the page now. */
    const liveRoots = (): ShadowRoot[] => Array.from(roots).filter((r) => r.host.isConnected && r.host.ownerDocument === document);
    // The boxes: every text box of the document and its open shadow roots, its value, what names it.
    const BOXES = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable]:not([contenteditable=false])";
    const boxes = (): Element[] => {
      const out: Element[] = [];
      for (const p of [document, ...liveRoots()] as (Document | ShadowRoot)[]) for (const e of Array.from(p.querySelectorAll(BOXES))) if (e !== host) out.push(e);
      return out;
    };
    const valueOf = (e: Element): string => ((e as HTMLElement).isContentEditable ? (e.textContent ?? "") : "value" in e ? String((e as HTMLInputElement).value ?? "") : "");
    const nameOf = (e: Element): string => {
      const k = ["name", "id", "autocomplete", "aria-label", "placeholder"].map((n) => e.getAttribute(n) ?? "");
      return k.some(Boolean) ? `${e.tagName}|${k.join("|")}` : "";
    };
    const markBox = (e: Element) => {
      if (!e.hasAttribute(markAttr)) e.setAttribute(markAttr, "");
      marks.add(e);
      const k = nameOf(e);
      if (k) ids.add(k);
    };
    const isBox = (e: Element | null): e is Element => Boolean(e && (e.matches?.(BOXES) || (e as HTMLElement).isContentEditable));
    /** The box is drawn masked now (its computed style, read back). */
    const maskedNow = (e: Element): boolean => {
      try {
        const st = getComputedStyle(e);
        return discs ? st.getPropertyValue("-webkit-text-security") === "disc" : st.color === "rgba(0, 0, 0, 0)" && st.getPropertyValue("-webkit-text-fill-color") === "rgba(0, 0, 0, 0)";
      } catch {
        return false;
      }
    };
    const shownBox = (e: Element): boolean => {
      const r = e.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const st = getComputedStyle(e);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    /**
     * Before each frame: every box that should be masked is marked (its marker put back if the page took
     * it off; one drawn again in a marked one's place; one that holds a stored value, on the run's site).
     * True when a box holds a password, a code or a key and still isn't drawn masked (the card then).
     */
    const remask = (): boolean => {
      for (const e of marks) {
        if (!e.isConnected) marks.delete(e);
        else if (!e.hasAttribute(markAttr)) e.setAttribute(markAttr, "");
      }
      const looking = allowed && ((fheld && fkeys.size) || (held && keys.size));
      if (!ids.size && !looking && !marks.size) return false;
      let bad = false;
      for (const e of boxes()) {
        const v = valueOf(e);
        if (!v) continue;
        const secret = Boolean(looking && held && found(v, held.field));
        if (!e.hasAttribute(markAttr) && ((ids.size && ids.has(nameOf(e))) || secret || (looking && fheld && foundIn(v, fheld.field, fheld, ffirsts, fkeys)))) markBox(e);
        // A box holding a password, a code or a key, or any box marked as holding a stored value (a
        // username too), that the page draws plain anyway (its own !important rule): the card.
        if ((secret || e.hasAttribute(markAttr)) && !maskedNow(e) && shownBox(e)) bad = true;
      }
      return bad;
    };
    /** Armed and seen: the sheet is in the document and every open shadow root, and every box shown is drawn masked. */
    const armedNow = (): boolean => {
      if (!typing || !sheet) return false;
      try {
        if (!document.adoptedStyleSheets.includes(sheet)) return false;
        for (const r of liveRoots()) if (!r.adoptedStyleSheets.includes(sheet)) return false;
        if (!Array.from(sheet.cssRules).some((r) => r.cssText.includes("text-security") || r.cssText.includes("transparent"))) return false;
        return boxes().every((e) => !shownBox(e) || maskedNow(e));
      } catch {
        return false;
      }
    };
    /** The page's own words, every open shadow root's too, in one string (a value split across components is found). */
    const pageWords = (boxesToo: boolean) => [document.documentElement, ...liveRoots()].map((p) => wordsOf(p, boxesToo)).join("");
    const scan = (): boolean => {
      if (!document.documentElement) return false;
      if (dirty) {
        dirty = false;
        textHit = Boolean(held && allowed && keys.size && held.text.length) && found(pageWords(true), held!.text);
        // While a password, a code or a key is typed: any change in the page's words (not a box's own) may
        // echo part of it (a suggestion list, a code's slots, a mirror), which no hash of the whole finds.
        echoHit = typing && strict && armWords !== null && pageWords(false) !== armWords;
      }
      return textHit || echoHit;
    };

    // The card.
    const style = (el: HTMLElement, props: Record<string, string>) => {
      for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
    };
    const build = () => {
      host = document.createElement("cm-cover");
      host.setAttribute("aria-hidden", "true");
      host.inert = true;
      style(host, {
        position: "fixed", inset: "0", top: "0", left: "0", width: "100vw", height: "100vh", "max-width": "none", "max-height": "none", margin: "0", padding: "0", border: "none",
        "z-index": "2147483647", "pointer-events": "none", background: color, display: "flex", "align-items": "center", "justify-content": "center",
        opacity: "1", visibility: "visible", transform: "none", filter: "none", "clip-path": "none", overflow: "hidden", color: "#FFFFFF",
      });
      const shadow = host.attachShadow({ mode: "closed" });
      const card = document.createElement("div");
      style(card, { "font-family": "system-ui, -apple-system, sans-serif", "text-align": "center", color: "#FFFFFF", padding: "24px" });
      titleEl = document.createElement("div");
      style(titleEl, { "font-size": "28px", "font-weight": "600" });
      subEl = document.createElement("div");
      style(subEl, { "font-size": "15px", "margin-top": "10px", opacity: "0.75" });
      card.append(titleEl, subEl);
      shadow.append(card);
    };
    const want = (): string | null => (top && words !== null ? words : hit ? "A stored value is on the page" : null);
    const isOpen = () => {
      try {
        return host!.matches(":popover-open");
      } catch {
        return true;
      }
    };
    const raise = () => {
      if (!host) return;
      try {
        if (!host.hasAttribute("popover")) host.setAttribute("popover", "manual");
        // Raised above anything the page put in the top layer since (a modal dialog, a popover, full screen).
        const others = Array.from(document.querySelectorAll("dialog:modal, :popover-open, :fullscreen")).filter((e) => e !== host);
        const fresh = others.some((e) => !over.has(e));
        if (fresh && isOpen()) host.hidePopover();
        if (!isOpen()) host.showPopover();
        for (const e of others) over.add(e);
      } catch {
        // no top layer here: the fixed box with the highest z-index stands
      }
    };
    const render = () => {
      const w = want();
      if (w === null) {
        if (host?.isConnected) {
          try {
            if (isOpen()) host.hidePopover();
          } catch {
            // never shown as a popover
          }
          host.remove();
        }
        return;
      }
      const root = document.documentElement;
      if (!root) return;
      if (!host) build();
      if (shownWords !== `${w}\n${sub}`) {
        shownWords = `${w}\n${sub}`;
        titleEl!.textContent = w;
        subEl!.textContent = sub;
      }
      if (host!.parentNode !== root) root.appendChild(host!);
      raise();
    };
    /** The guard's look: the page as it is now. Fails closed. */
    const look = (full = true) => {
      try {
        adopt(document);
        // Shadow roots a script makes are adopted as they are made; one the parser makes is found before its first frame.
        if (full && document.documentElement) findRoots();
        const unmasked = document.documentElement ? remask() : false;
        hit = scan() || unmasked;
      } catch {
        hit = Boolean((held && allowed) || (typing && strict));
      }
    };
    const tick = () => {
      requestAnimationFrame(tick);
      look();
      render();
    };
    const loop = () => {
      if (looping) return;
      looping = true;
      requestAnimationFrame(tick);
    };
    const changed: MutationCallback = (list) => {
      dirty = true;
      for (const m of list) {
        if (m.type === "attributes" && m.target instanceof Element) over.delete(m.target);
        // An element put in the page with an open shadow root (a component): adopted before paint. (The
        // page's prototypes are never touched, so a closed root, or one attached to an element already in
        // the page, is found by the next frame's look.)
        if (m.type === "childList") {
          for (const n of Array.from(m.addedNodes)) {
            if (!(n instanceof Element) || n === host) continue;
            for (const e of [n, ...Array.from(n.querySelectorAll("*"))]) if (e.shadowRoot && !roots.has(e.shadowRoot)) addRoot(e.shadowRoot);
          }
        }
      }
      // Looked at again at once, before the frame is painted: a change the page makes after our own frame
      // callback (in its own, in a ResizeObserver) is masked, or covered, in that same frame.
      look(false);
      render();
    };
    const watch = (r: Node) => {
      try {
        new MutationObserver(changed).observe(r, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "value", markAttr] });
      } catch {
        // nothing to watch
      }
    };
    // The browser's own "fill out this field" bubble quotes a box's value: never for a box that holds a stored value.
    const quiet = (ev: Event) => {
      const t = ev.target;
      if (t instanceof Element && (typing || t.hasAttribute(markAttr))) ev.preventDefault();
    };
    function addRoot(r: ShadowRoot) {
      roots.add(r);
      adopt(r);
      watch(r);
      r.addEventListener("invalid", quiet, true);
      dirty = true;
    }
    /** Watches this window's document (again when a reused window has a new one). */
    const hookDoc = () => {
      if (doc === document) return;
      doc = document;
      for (const r of roots) if (r.host.ownerDocument !== document) roots.delete(r);
      looping = false;
      dirty = true;
      watch(document);
      adopt(document);
      // A page that replaces its adopted sheets another way drops ours: put back as the document fills in.
      document.addEventListener("readystatechange", () => adopt(document));
      document.addEventListener("DOMContentLoaded", () => adopt(document));
      document.addEventListener("beforetoggle", reraise, true);
      document.addEventListener("toggle", reraise, true);
      document.addEventListener("fullscreenchange", reraise, true);
      document.addEventListener("invalid", quiet, true);
      // Page state that only changes by a property (a field filled by script) is read every frame, by the loop.
      document.addEventListener("input", () => (dirty = true), true);
    };
    const reraise = (e: Event) => {
      if (e.target === host) return;
      if (e.target instanceof Element) over.delete(e.target);
      queueMicrotask(() => {
        if (want() !== null) raise();
      });
    };
    hookDoc();

    const marked = (): boolean => Array.from(typed).some((e) => {
      if (!e.isConnected) return false;
      // A field inside another site's frame: its value can't be read, so it counts as showing one.
      if (e instanceof HTMLIFrameElement) return true;
      if (!valueOf(e)) return false;
      // Shown, and not drawn as dots.
      return shownBox(e) && !maskedNow(e);
    });
    const mark = (): boolean => {
      let el: Element | null = document.activeElement;
      for (;;) {
        if (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        else if (el instanceof HTMLIFrameElement) {
          let inner: Document | null = null;
          try {
            inner = el.contentDocument;
          } catch {
            inner = null;
          }
          // Another site's frame: the frame itself is kept (fail closed).
          if (!inner) break;
          if (!inner.activeElement || inner.activeElement === inner.body) break;
          el = inner.activeElement;
        } else break;
      }
      if (!el || el === document.body) return false;
      typed.add(el);
      if (isBox(el)) markBox(el);
      return true;
    };

    api = (cmd: string, x?: unknown): unknown => {
      const b = (x ?? {}) as Args;
      if (cmd === "set") {
        hookDoc();
        if (b.sub !== undefined) sub = b.sub;
        if (b.hosts) allowed = b.hosts.some((h) => here === h || here.endsWith(`.${h}`));
        if (b.held !== undefined) {
          held = b.held;
          firsts = new Set(held?.first ?? []);
          keys = new Set(held?.keys ?? []);
          dirty = true;
        }
        if (b.words !== undefined) words = top ? b.words : null;
        if (b.fheld !== undefined) {
          fheld = b.fheld;
          ffirsts = new Set(fheld?.first ?? []);
          fkeys = new Set(fheld?.keys ?? []);
        }
        if (b.typing === true && b.strict && !strict) {
          strict = true;
          dirty = true;
          try {
            armWords = document.documentElement ? pageWords(false) : "";
          } catch {
            armWords = null;
          }
        }
        if (b.typing === true && !typing) {
          typing = true;
          dirty = true;
          try {
            snap = new Map(boxes().map((e) => [e, valueOf(e)] as const));
          } catch {
            snap = new Map();
          }
          paintSheet();
        } else if (b.typing === false && typing) {
          // Every box whose value changed while armed (or that is new since) stays masked, and the one with the keyboard.
          try {
            for (const e of boxes()) {
              const v = valueOf(e);
              if (v && snap.get(e) !== v) markBox(e);
            }
            const act = document.activeElement;
            if (isBox(act)) markBox(act);
          } catch {
            // nothing more to mark
          }
          typing = false;
          strict = false;
          armWords = null;
          echoHit = false;
          dirty = true;
          snap = new Map();
          paintSheet();
        }
        loop();
        render();
        return true;
      }
      if (cmd === "state") {
        look();
        const w = want();
        let shown = 0;
        try {
          shown = boxes().filter(shownBox).length;
        } catch {
          shown = 1;
        }
        return { up: w !== null && Boolean(host?.isConnected) && isOpen(), words: top && words !== null, hit, marked: marked(), armed: armedNow(), discs, marks: Array.from(marks).filter((e) => e.isConnected).length, shown };
      }
      if (cmd === "mark") return mark();
      return undefined;
    };
    W[a.key] = api;
  }
  const { key: _k, secure: _s, color: _c, mark: _m, entry: _e, marked: _d, ...rest } = a;
  return api("set", rest);
}

/** Runs in the page: two frames drawn (so the last change is on screen); false when none was drawn in time. */
function twoFrames(): Promise<boolean> {
  return new Promise((done) => {
    const t = setTimeout(() => done(false), 400);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(t);
      done(true);
    }));
  });
}

/** A frame's cover state: the card up, a stored value shows, a typed box shows unmasked, the mask armed and seen, dots drawn, boxes marked. */
export interface CoverState {
  up: boolean;
  words: boolean;
  hit: boolean;
  marked: boolean;
  armed: boolean;
  discs: boolean;
  marks: number;
  /** Text boxes shown in the frame now. */
  shown: number;
}

/** Runs in the page: a frame's cover state. */
function stateOf(key: string): CoverState | undefined {
  const api = (window as unknown as Record<string, unknown>)[key];
  return typeof api === "function" ? (api as (c: string) => CoverState)("state") : undefined;
}

/** Runs in the page: the field that has the keyboard now is kept as one a secret was typed into. */
function markIn(key: string): boolean {
  const api = (window as unknown as Record<string, unknown>)[key];
  return typeof api === "function" ? Boolean((api as (c: string) => unknown)("mark")) : false;
}

/** Runs in the page, for each field a secret was typed into (by a locator): it shows a value now, not drawn as dots. */
function showsValue(els: Element[]): boolean {
  return els.some((e) => {
    if (!e.isConnected) return false;
    const v = "value" in e ? String((e as HTMLInputElement).value ?? "") : (e as HTMLElement).isContentEditable ? (e.textContent ?? "") : "";
    if (!v) return false;
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    if (!(r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none")) return false;
    const masked = s.getPropertyValue("-webkit-text-security") === "disc" || (s.color === "rgba(0, 0, 0, 0)" && s.getPropertyValue("-webkit-text-fill-color") === "rgba(0, 0, 0, 0)");
    return !masked;
  });
}

/** Specificity raised by ids no page has, so a page's own `!important` rule rarely beats the mask. */
const BOOST = ":not(#cm-no-id-1):not(#cm-no-id-2):not(#cm-no-id-3)";
const SECURE_INPUTS = SECURE_FIELDS.filter((s) => s.startsWith("input")).map((s) => `${s}${BOOST}`).join(", ");
/** Every text box, masked while a stored value is typed (buttons, boxes to tick and the like aren't text). */
const ENTRY = [
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]):not([type=range]):not([type=color])",
  "textarea",
  "[contenteditable]:not([contenteditable=false])",
  "[contenteditable]:not([contenteditable=false]) *",
].map((s) => `${s}${BOOST}`).join(", ");

/** The stored values as the guard holds them (hashes only), by the page's own code run in Node. */
export function hashHeld(values: readonly string[], b1: number, b2: number): Held {
  return install({ key: "", hashOnly: { values: [...values], b1, b2 } }) as Held;
}

const oddBase = () => (randomInt(1, 2 ** 31) * 2 + 1) >>> 0;

export interface CoverOptions {
  /** The fields a secret was typed into, by locator (as well as by element). */
  fields?: SecretFields;
  /** The hosts the guard looks for stored values on (default: none, so it holds nothing). */
  hosts?: readonly string[];
}

export class Cover {
  readonly log: CoverEvent[] = [];
  private words: string | undefined;
  private script: Disposable | undefined;
  private heldScript: Disposable | undefined;
  private heldKey = "";
  private typingScript: Disposable | undefined;
  private armedNow = false;
  private secrets: () => readonly string[] = () => [];
  private boxValues: () => readonly string[] = () => [];
  private readonly key = `__cm${randomBytes(6).toString("hex")}`;
  /** The marker attribute that masks a box: random per run, so a page's own rule can't name it. */
  private readonly mark = `data-cm${randomBytes(4).toString("hex")}`;
  private readonly b1 = oddBase();
  private readonly b2 = oddBase();
  private readonly page: Page;
  private readonly context: BrowserContext;
  private readonly fields: SecretFields | undefined;
  private readonly hosts: string[];
  private readonly now: () => number;
  private constructor(page: Page, o: CoverOptions, now: () => number = Date.now) {
    this.page = page;
    this.context = page.context();
    this.fields = o.fields;
    this.hosts = [...new Set((o.hosts ?? []).map((h) => h.toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "")).filter(Boolean))];
    this.now = now;
  }

  /** Adds the cover's script to every new document of the context (the one way it is added). */
  private add(args: Args): Promise<Disposable | undefined> {
    return this.context.addInitScript(install, args).catch(() => undefined);
  }

  /** Runs `args` in every frame of every page open now. */
  private async everywhere(args: Args): Promise<void> {
    for (const p of this.context.pages()) for (const f of p.frames()) await f.evaluate(install, args).catch(() => {});
  }

  /** What every frame is given first: the mask's selectors and where the guard may look. */
  private base(): Args {
    const boost = ":not(#cm-no-id-1):not(#cm-no-id-2):not(#cm-no-id-3)";
    return { key: this.key, secure: SECURE_INPUTS, color: COVER_COLOR, sub: COVER_SUB, hosts: this.hosts, mark: this.mark, entry: ENTRY, marked: `[${this.mark}]${boost}, [${this.mark}] *${boost}` };
  }

  /** The mask and the guard on every page of the page's context from now on (and the one open now); the card is put up by show(). */
  static async attach(page: Page, fields?: SecretFields | CoverOptions): Promise<Cover> {
    const o: CoverOptions = fields && "locators" in fields ? { fields } : ((fields as CoverOptions | undefined) ?? {});
    const c = new Cover(page, o);
    const args = c.base();
    await c.add(args);
    await c.everywhere(args);
    // A document opened after the card was taken away (a navigation already under way) never keeps it.
    const tidy = () => {
      if (!c.words) void page.evaluate(install, { key: c.key, words: null }).catch(() => {});
    };
    page.on("domcontentloaded", tidy);
    page.on("load", tidy);
    return c;
  }

  /** The card is up (or being put up) for typing. */
  get active(): boolean {
    return this.words !== undefined;
  }

  /**
   * The stored values the guard looks for, read again at each sync (a code read from an email joins
   * them). Hashed in Node; the values never go into the page.
   */
  holdFor(secrets: () => readonly string[], boxValues?: () => readonly string[]): void {
    this.secrets = secrets;
    this.boxValues = boxValues ?? secrets;
  }

  /** Brings the guard's values up to date in every page and every document to come. */
  async sync(): Promise<void> {
    const values = [...new Set(this.secrets())].filter((v) => v.length >= MIN_FIELD).sort();
    const held = hashHeld(values, this.b1, this.b2);
    const inBoxes = [...new Set([...this.boxValues(), ...values])].filter((v) => v.length >= MIN_FIELD).sort();
    const fheld = hashHeld(inBoxes, this.b1, this.b2);
    const k = `${held.keys.join(",")}|${fheld.keys.join(",")}`;
    if (k === this.heldKey) return;
    this.heldKey = k;
    await this.heldScript?.dispose().catch(() => {});
    const args: Args = { key: this.key, held, fheld };
    this.heldScript = await this.add(args);
    await this.everywhere(args);
  }

  /** The mask is armed (every text box drawn as dots) for a stored value being typed. */
  get armed(): boolean {
    return this.armedNow;
  }

  /**
   * Masks every text box of every frame of the page (and of every document opened while armed), and
   * waits until each frame has drawn it and reads every box back masked: true then, and the stored value
   * may be typed with the page in view. False when that can't be seen in some frame (one that can't be
   * read, a box the mask doesn't reach): the card is the fallback then.
   */
  async arm(strict = true): Promise<boolean> {
    if (this.page.isClosed()) return false;
    await this.sync();
    const args: Args = { ...this.base(), typing: true, ...(strict ? { strict: true } : {}) };
    if (!this.armedNow) {
      this.armedNow = true;
      this.log.push({ t: this.now(), kind: "arm" });
      this.typingScript = await this.add(args);
    }
    for (let k = 0; k < 3; k++) {
      try {
        const frames = this.page.frames();
        for (const f of frames) {
          try {
            await f.evaluate(install, args);
          } catch (error) {
            if (!f.isDetached()) throw error;
          }
        }
        const drawn = await Promise.all(frames.map((f) => f.evaluate(twoFrames).catch(() => f.isDetached())));
        const states: (CoverState | "gone" | null)[] = await Promise.all(frames.map((f) => f.evaluate(stateOf, this.key).then((s): CoverState | null => s ?? null, (): "gone" | null => (f.isDetached() ? "gone" : null))));
        const seen = states.every((s) => s === "gone" || Boolean(s?.armed));
        // Seen painted: the page's own frame drew two frames, and so did every other frame that shows a box
        // (a frame the browser stops drawing, one hidden or scrolled away, shows no box to draw).
        const main = this.page.mainFrame();
        const painted = frames.every((f, i) => drawn[i] || (f !== main && (states[i] === "gone" || (states[i] as CoverState | null)?.shown === 0)));
        if (seen && painted) {
          this.log.push({ t: this.now(), kind: "masked" });
          return true;
        }
      } catch {
        // the page is between documents: the init script arms the next one; tried again
      }
      await this.page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    }
    this.log.push({ t: this.now(), kind: "unmasked" });
    return false;
  }

  /**
   * Just before the first key: the box the value goes into is drawn as dots now (its computed style read
   * back), and its frame is still armed. False when it isn't, or can't be read: the card then.
   */
  async maskedAt(el: Locator): Promise<boolean> {
    if (!this.armedNow || this.page.isClosed()) return false;
    return el
      .evaluate(
        (e, key) => {
          const st = getComputedStyle(e);
          const dots = st.getPropertyValue("-webkit-text-security") === "disc" || (st.color === "rgba(0, 0, 0, 0)" && st.getPropertyValue("-webkit-text-fill-color") === "rgba(0, 0, 0, 0)");
          const api = (window as unknown as Record<string, unknown>)[key];
          const s = typeof api === "function" ? ((api as (c: string) => { armed?: boolean })("state")) : undefined;
          return dots && Boolean(s?.armed);
        },
        this.key,
        { timeout: 2000 },
      )
      .catch(() => false);
  }

  /** Takes the mask off the boxes no stored value went into; every box one went into (or changed while armed) stays dots. */
  async disarm(): Promise<void> {
    if (!this.armedNow) return;
    this.armedNow = false;
    await this.typingScript?.dispose().catch(() => {});
    this.typingScript = undefined;
    await this.everywhere({ ...this.base(), typing: false });
    this.log.push({ t: this.now(), kind: "disarm" });
  }

  /** Every frame's cover state now (tests and the proof read it). */
  async states(): Promise<CoverState[]> {
    const out: CoverState[] = [];
    for (const f of this.page.frames()) {
      const s = await f.evaluate(stateOf, this.key).catch(() => undefined);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Puts the card up and waits until the page has drawn it: true then. False when it couldn't be put
   * on the page open now; nothing secret may be typed then.
   */
  async show(words = TYPING_CARD, sub = COVER_SUB): Promise<boolean> {
    if (this.page.isClosed()) return false;
    await this.sync();
    const args: Args = { key: this.key, words, sub };
    if (this.words === undefined) {
      this.log.push({ t: this.now(), kind: "show", words });
      this.words = words;
      this.script = await this.add(args);
    }
    for (let k = 0; k < 3; k++) {
      try {
        await this.page.evaluate(install, args);
        const drawn = await this.page.evaluate(twoFrames);
        const s = await this.page.evaluate(stateOf, this.key);
        if (s?.up && s.words) {
          this.log.push({ t: this.now(), kind: drawn ? "painted" : "assumed", words });
          return true;
        }
      } catch {
        // the page is between documents: the init script puts it on the next one; tried again
      }
      await this.page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    }
    this.log.push({ t: this.now(), kind: "failed", words });
    return false;
  }

  /**
   * Keeps the field that has the keyboard now (the one just typed into) as holding a secret, by the
   * element itself: a locator by a look's reference stops finding it once the page is looked at again.
   */
  async markTyped(): Promise<void> {
    if (this.page.isClosed()) return;
    // Every frame marks its own box with the keyboard (another site's frame included: its own copy of the mask).
    for (const f of this.page.frames()) await f.evaluate(markIn, this.key).catch(() => false);
  }

  /** Whether a field the run typed a secret into shows a value now, or the guard sees a stored value, in any frame; true when that can't be read. */
  private async secretShows(): Promise<boolean> {
    if (this.page.isClosed()) return false;
    await this.sync();
    for (const f of this.page.frames()) {
      let s: ReturnType<typeof stateOf>;
      try {
        s = await f.evaluate(stateOf, this.key);
      } catch {
        // A frame gone between listing and asking shows nothing; any other can't be read.
        if (f.isDetached()) continue;
        return true;
      }
      if (!s) {
        if (f === this.page.mainFrame()) return true;
        continue;
      }
      if (s.marked || s.hit) return true;
    }
    for (const loc of this.fields?.locators() ?? []) {
      try {
        if (await loc.evaluateAll(showsValue)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Takes the card away once nothing typed shows: no field a secret went into shows a value (the form
   * was sent, the page moved on, the field was emptied) and the guard sees none on the page. Kept up
   * otherwise. True when it is down. Called once the action is over, never during it.
   */
  async release(): Promise<boolean> {
    if (this.words === undefined) return true;
    if (await this.secretShows()) {
      if (this.log.at(-1)?.kind !== "kept") this.log.push({ t: this.now(), kind: "kept", words: this.words });
      return false;
    }
    await this.hide();
    return true;
  }

  /** Takes the card away now, whatever shows (the run is over). The guard still covers a stored value the page shows. */
  async hide(): Promise<void> {
    if (this.words === undefined) return;
    const words = this.words;
    this.words = undefined;
    this.log.push({ t: this.now(), kind: "hide", words });
    await this.script?.dispose().catch(() => {});
    this.script = undefined;
    if (this.page.isClosed()) return;
    await this.page.evaluate(install, { key: this.key, words: null }).catch(() => {});
    await this.page.evaluate(twoFrames).catch(() => {});
    this.log.push({ t: this.now(), kind: "unpainted", words });
  }
}

/** Said under the "Signed in as" card when the sign-in was recorded in its own video (sign-in.webm). */
export const SIGN_IN_OWN_VIDEO = "The sign-in is in its own video, with its boxes as dots";
/** Said under it when the run used a session saved earlier (nothing was typed to sign in). */
export const SIGN_IN_SAVED = "Signed in earlier: this run reused the saved session";

/** A card page for the start of a video: who the run is signed in as, and where its sign-in is. */
export function signedInCard(label: string, sub = SIGN_IN_SAVED): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head><body style="margin:0;background:${COVER_COLOR};color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center;padding:24px"><div style="font-size:28px;font-weight:600">Signed in as ${esc(label)}</div><div style="font-size:15px;margin-top:10px;opacity:.75">${esc(sub)}</div></div></body></html>`;
}
