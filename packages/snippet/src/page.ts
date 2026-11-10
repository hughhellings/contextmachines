import { isOwnUi, OWN_UI } from "./own.ts";
import { scrub } from "./redact.ts";

/**
 * Reads what a page *is* from its structure, not its pixels: forms and their
 * fields, buttons, headings and embedded frames, including open shadow roots
 * and same-origin iframes. Never reads values: only labels authored by the
 * site, field names and types, and whether fields are required.
 */

export interface PageField {
  name: string;
  label?: string;
  type: string;
  required: boolean;
}

export interface PageForm {
  name?: string;
  /** Normalised path the form posts to, when it is a classic form. */
  action?: string;
  method?: string;
  fields: PageField[];
  submitLabels: string[];
}

export interface PageButton {
  label: string;
  /** Index into `forms` when the button belongs to a form. */
  form?: number;
  /** Not on screen when read: inside a closed menu or panel. */
  hidden?: true;
}

export interface PageFrame {
  origin: string;
  title?: string;
  /** Same-origin frames are read like the page; cross-origin frames are opaque by design. */
  sameOrigin: boolean;
}

export interface PageSnapshot {
  title?: string;
  headings: string[];
  forms: PageForm[];
  buttons: PageButton[];
  frames: PageFrame[];
}

/**
 * Text a site has marked private for other tools (PostHog, Hotjar, FullStory, Sentry) or for us:
 * never read. Sites that already mask an account menu or a balance are covered without doing anything.
 */
const PRIVATE = "[data-ctx-private], [data-private], .ph-no-capture, [data-ph-no-capture], .ph-mask, [data-hj-suppress], .fs-mask, .fs-exclude, [data-sentry-mask], .sentry-mask";
/**
 * "Welcome back, Jane" → "Welcome back, [name]": a greeting is followed by the user's own name.
 * Not when it's followed by an ordinary word ("Welcome back", "Welcome to Acme", "Hi there").
 */
const GREETING = /\b(welcome(?: back)?|hi|hello|hey|good (?:morning|afternoon|evening)|signed in as|logged in as)([,!:]?\s+)(?!(?:back|to|there|everyone|all|again|aboard|home)\b)[^,.!?|·–—-]{1,40}/gi;

const LIMITS = { forms: 20, fieldsPerForm: 40, buttons: 40, headings: 10, headingCandidates: 200, frames: 10, label: 80, roots: 50 } as const;
const FIELD_SELECTOR = "input, select, textarea, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox']";
const BUTTON_SELECTOR = "button, [role='button'], input[type='submit'], input[type='button'], a[role='button']";
const SKIP_INPUT_TYPES = new Set(["hidden"]);

/**
 * A document the browser shows as a page: HTML. A JSON reply, a text file or an image opened at its
 * own address (an API link, a download shown in place) gets a document too, but it is data.
 */
export function isScreenDocument(doc: Document): boolean {
  const type = doc.contentType;
  return !type || /html/i.test(type);
}

export function snapshotPage(doc: Document, normalizePath: (url: string) => string | undefined): PageSnapshot {
  const snapshot: PageSnapshot = { headings: [], forms: [], buttons: [], frames: [] };
  const title = clean(doc.title, LIMITS.label, keepNumbers);
  if (title) snapshot.title = title;

  const roots = collectRoots(doc);
  const formIndex = new Map<Element, number>();

  snapshot.headings = readHeadings(roots);

  for (const root of roots) {

    for (const form of root.querySelectorAll("form")) {
      if (snapshot.forms.length >= LIMITS.forms) break;
      // A form or a field counts only if it's on screen now: a tabbed page often keeps every section
      // in the document with the others hidden, and their fields are no part of the section showing.
      if (!shown(form)) continue;
      const entry: PageForm = { fields: [], submitLabels: [] };
      const name = clean(form.getAttribute("name") ?? form.getAttribute("aria-label") ?? form.id);
      if (name) entry.name = name;
      const action = form.getAttribute("action");
      if (action) {
        const path = normalizePath(action);
        if (path) entry.action = path;
      }
      const method = form.getAttribute("method");
      if (method) entry.method = method.toUpperCase();
      for (const el of form.querySelectorAll(FIELD_SELECTOR)) {
        if (entry.fields.length >= LIMITS.fieldsPerForm) break;
        if (!shown(el)) continue;
        const field = describeField(el, root);
        if (field) entry.fields.push(field);
      }
      formIndex.set(form, snapshot.forms.length);
      snapshot.forms.push(entry);
    }

    // Fields outside any <form> (common in single-page apps) form one implicit group per root.
    const loose = [...root.querySelectorAll(FIELD_SELECTOR)].filter((el) => !el.closest("form") && shown(el));
    if (loose.length > 0 && snapshot.forms.length < LIMITS.forms) {
      const entry: PageForm = { name: "(no form element)", fields: [], submitLabels: [] };
      for (const el of loose.slice(0, LIMITS.fieldsPerForm)) {
        const field = describeField(el, root);
        if (field) entry.fields.push(field);
      }
      if (entry.fields.length > 0) snapshot.forms.push(entry);
    }

    for (const el of root.querySelectorAll(BUTTON_SELECTOR)) {
      if (snapshot.buttons.length >= LIMITS.buttons) break;
      if (isOwnUi(el)) continue; // our own UI
      // The close button of an error or a toast belongs to that message, which came and goes: no control of the page's.
      if (el.parentElement && inMessage(el.parentElement)) continue;
      const label = buttonLabel(el);
      if (!label) continue;
      const button: PageButton = { label };
      if (!shown(el)) button.hidden = true;
      const owner = el.closest("form");
      const index = owner ? formIndex.get(owner) : undefined;
      if (index !== undefined) {
        button.form = index;
        const form = snapshot.forms[index];
        const type = (el.getAttribute("type") ?? (el.tagName === "BUTTON" ? "submit" : "")).toLowerCase();
        if (form && type === "submit" && !form.submitLabels.includes(label)) form.submitLabels.push(label);
      }
      snapshot.buttons.push(button);
    }

    for (const frame of root.querySelectorAll("iframe")) {
      if (snapshot.frames.length >= LIMITS.frames) break;
      const src = frame.getAttribute("src");
      if (!src) continue;
      let origin: string;
      try {
        origin = new URL(src, doc.baseURI).origin;
      } catch {
        continue;
      }
      const entry: PageFrame = { origin, sameOrigin: origin === originOf(doc) };
      const frameTitle = clean(frame.getAttribute("title"));
      if (frameTitle) entry.title = frameTitle;
      snapshot.frames.push(entry);
    }
  }
  return snapshot;
}

/**
 * Numbers in the site's own words (headings, the title, button labels) are kept as written, not
 * masked. Off by default: on a live product those words can carry a user's records and amounts.
 * Turned on only where nothing personal is on screen, such as a learner reading a site with no one
 * signed in, so "404 Not Found" or "Step 3 of 5" stay readable.
 */
let keepNumbers = false;
export function setKeepNumbers(on: boolean): void {
  keepNumbers = on;
}

const HEADING = "h1, h2, h3, [role='heading']";
/** Where a page's own content is. */
const MAIN = "main, article, [role='main']";
/**
 * Parts repeated on every page that never name it: menus, sidebars and the footer ("Customer
 * login" in a sidebar, "Subscription" in a footer). Their headings are not read at all.
 */
const SITE_PARTS = "nav, aside, footer, [role='navigation'], [role='complementary'], [role='contentinfo']";
/**
 * The site's header: a banner, or a top-level <header> carrying the menu (a <nav> or a row of
 * links). A <header> with no menu at the top of the page is the page's own title band (a hero),
 * and a <header> inside the main content, an article or a section is that part's own (the same
 * rule browsers use for the banner landmark).
 */
const BANNER = "[role='banner']";
const SECTIONING = "main, article, section, [role='main']";
const MENU = "nav, [role='navigation']";
const MENU_LINKS = 4;

/**
 * The page's headings, its own name first: an h1 in the main content, then an h1 anywhere else
 * that is not the site's header, then the main content's other headings, then the rest, then the
 * site header's. Within each, h1 before h2 before h3, then in page order. Each heading appears once.
 *
 * Not read: headings in menus, sidebars and the footer; in messages (an alert, a status line, a
 * sign-in error: "Username and password do not match", which can carry what someone typed); in a
 * cookie or consent pop-up; and headings not on screen (a closed panel, another tab's content).
 */
function readHeadings(roots: ParentNode[]): string[] {
  const found: { text: string; rank: number; level: number; order: number }[] = [];
  for (const root of roots) {
    for (const h of root.querySelectorAll(HEADING)) {
      if (found.length >= LIMITS.headingCandidates) break;
      if (h.closest(PRIVATE) || h.closest(SITE_PARTS) || isOwnUi(h) || inMessage(h) || inConsentDialog(h) || inListItem(h) || !onScreen(h)) continue;
      const text = clean(spacedText(h), LIMITS.label, keepNumbers);
      if (!text) continue;
      const level = levelOf(h);
      found.push({ text, rank: rankOf(h, level), level, order: found.length });
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.level - b.level || a.order - b.order);
  return [...new Set(found.map((f) => f.text))].slice(0, LIMITS.headings);
}

/**
 * A heading that titles one item of a list is the item's, not the page's: an article in a feed, a
 * product card, a result. Often someone's own words (a post's title), and never the page's name (a
 * profile is not named after the first post on it). Known by where it sits: inside a link (a card
 * names the page it opens), or inside a list item or article that repeats beside look-alikes.
 */
const ITEM = "li, article, [role='listitem'], [role='article']";
function inListItem(h: Element): boolean {
  if (h.closest("a[href]")) return true;
  // Plain boxes repeated side by side are left alone: on a product's own pages they are its features ("Automatic sync").
  const item = h.closest(ITEM);
  return item !== null && lookAlikes(item);
}

/** At least one sibling of the same tag and class with a heading of its own: items of one list. */
function lookAlikes(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  return [...parent.children].some((c) => c !== el && c.tagName === el.tagName && c.className === el.className && c.querySelector(HEADING) !== null);
}

/** 0: an h1 in the main content; 1: an h1 elsewhere; 2: the main content; 3: elsewhere; 4: the site's header. */
function rankOf(h: Element, level: number): number {
  if (inSiteHeader(h)) return 4;
  const main = h.closest(MAIN) !== null;
  if (level === 1) return main ? 0 : 1;
  return main ? 2 : 3;
}

function inSiteHeader(h: Element): boolean {
  if (h.closest(BANNER)) return true;
  const header = h.closest("header");
  if (!header || header.parentElement?.closest(SECTIONING)) return false;
  return header.querySelector(MENU) !== null || header.querySelectorAll("a[href]").length >= MENU_LINKS;
}

/**
 * A message on the page, not a heading of it: an alert or status region, or a small box the site
 * names as an error, alert, toast or flash message ("error-message-container", data-test="error").
 * Only a small box counts, so a page-wide wrapper with "error" in a class name is not mistaken for one.
 */
const MESSAGE_ROLE = "[role='alert'], [role='status'], [aria-live='assertive'], [aria-live='polite']";
const MESSAGE_NAME = /^(error|errors|alert|alerts|toast|toasts|flash|snackbar|notice)$/i;
const MESSAGE_NAME_STOP = /^(page|view|screen|boundary|layout|app)$/i;
const MESSAGE_SIZE = 300;
const MESSAGE_DEPTH = 4;

function inMessage(h: Element): boolean {
  let n: Element | null = h;
  for (let depth = 0; n && depth < MESSAGE_DEPTH; depth++, n = n.parentElement) {
    if ((n.textContent ?? "").length > MESSAGE_SIZE) return false;
    if (n.matches(MESSAGE_ROLE)) return true;
    const names = [n.id, n.getAttribute("class"), n.getAttribute("data-test"), n.getAttribute("data-testid")].join(" ").split(/\s+/).filter(Boolean);
    for (const name of names) {
      const pieces = name.replace(/([a-z])([A-Z])/g, "$1-$2").split(/[-_]+/);
      if (pieces.some((p) => MESSAGE_NAME.test(p)) && !pieces.some((p) => MESSAGE_NAME_STOP.test(p))) return true;
    }
  }
  return false;
}

/**
 * Inside a cookie or consent pop-up: the site asking about cookies, not a place in the product.
 * Consent managers name the pop-up, or the box it sits in, after what it is for.
 */
const DIALOG = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
const CONSENT = /cookie|consent|gdpr|privacy[ _-]?(choices|preferences|settings|cent(er|re))/i;

export function inConsentDialog(el: Element): boolean {
  const dialog = el.closest(DIALOG);
  if (!dialog) return false;
  for (let n: Element | null = dialog; n && n !== el.ownerDocument.body; n = n.parentElement) {
    if (CONSENT.test(`${n.getAttribute("aria-label") ?? ""} ${n.id} ${n.getAttribute("class") ?? ""}`)) return true;
  }
  return false;
}

/** On screen as the page is read. The browser's own check when it has one (fast); else styles up the tree. */
function onScreen(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(el, { visibilityProperty: true });
  return shown(el);
}

function levelOf(h: Element): number {
  const tag = /^H([1-6])$/.exec(h.tagName)?.[1];
  if (tag) return Number(tag);
  const aria = Number(h.getAttribute("aria-level"));
  return aria >= 1 && aria <= 6 ? aria : 2; // role=heading with no level is a level 2 heading
}

/** A small, stable fingerprint so unchanged pages are not re-sent. */
export function snapshotSignature(s: PageSnapshot): string {
  return JSON.stringify([s.title, s.headings, s.forms.map((f) => [f.name, f.action, f.fields.map((x) => [x.name, x.type, x.required]), f.submitLabels]), s.buttons.map((b) => [b.label, b.form]), s.frames.map((f) => f.origin)]);
}

/**
 * Finds the visible control (button, link-button, submit) whose label matches,
 * across open shadow roots and same-origin frames. Used to point at or press
 * the exact thing a guidance step refers to. Ignores our own UI.
 */
export function findControlByLabel(doc: Document, label: string): HTMLElement | undefined {
  const want = normalise(label);
  if (!want) return undefined;
  for (const root of collectRoots(doc)) {
    for (const el of root.querySelectorAll(`${BUTTON_SELECTOR}, a[href]`)) {
      if (isOwnUi(el)) continue;
      const own = buttonLabel(el);
      if (own && normalise(own) === want && isVisible(el)) return el as HTMLElement;
    }
  }
  return undefined;
}

/** The form field a snapshot labelled `label` (or named it, when it had no label). Never reads values. */
export function findFieldByLabel(doc: Document, label: string): HTMLElement | undefined {
  const want = normalise(label);
  if (!want) return undefined;
  for (const root of collectRoots(doc)) {
    for (const el of root.querySelectorAll(FIELD_SELECTOR)) {
      if (isOwnUi(el)) continue;
      // Its label, its name, or its name written as words ("guest_name" or "Guest name").
      const name = el.getAttribute("name") ?? "";
      const asWords = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
      const own = [fieldLabel(el, root), name, asWords].filter((x): x is string => Boolean(x));
      if (own.some((o) => normalise(o) === want) && isVisible(el)) return el as HTMLElement;
    }
  }
  return undefined;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** On screen: not inside anything hidden or closed (a menu's items, a collapsed panel). */
function shown(el: Element): boolean {
  if (el.closest("[hidden], [aria-hidden='true'], [inert], details:not([open]) > :not(summary)")) return false;
  const view = el.ownerDocument.defaultView;
  for (let n: Element | null = el; n && n !== el.ownerDocument.body; n = n.parentElement) {
    const style = view?.getComputedStyle(n);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
}

function isVisible(el: Element): boolean {
  const html = el as HTMLElement;
  if (html.hidden || html.getAttribute("aria-hidden") === "true") return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/** The document plus every open shadow root and same-origin iframe document inside it. */
function collectRoots(doc: Document): ParentNode[] {
  const roots: ParentNode[] = [doc];
  for (let i = 0; i < roots.length && roots.length < LIMITS.roots; i++) {
    const root = roots[i] as ParentNode;
    for (const el of root.querySelectorAll("*")) {
      if (roots.length >= LIMITS.roots) break;
      if (el.shadowRoot && !el.matches(OWN_UI)) roots.push(el.shadowRoot); // never read our own UI
      if (el.tagName === "IFRAME") {
        try {
          const inner = (el as HTMLIFrameElement).contentDocument;
          if (inner && inner !== doc && originOf(inner) === originOf(doc)) roots.push(inner);
        } catch {
          // cross-origin: opaque by design
        }
      }
    }
  }
  return roots;
}

function describeField(el: Element, root: ParentNode): PageField | undefined {
  if (isOwnUi(el)) return undefined;
  const tag = el.tagName.toLowerCase();
  const type = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : tag === "select" ? "select" : tag === "textarea" ? "textarea" : (el.getAttribute("role") ?? "editable");
  if (SKIP_INPUT_TYPES.has(type) || type === "submit" || type === "button") return undefined;
  const label = fieldLabel(el, root);
  const name = fieldKey(el, label);
  if (!name) return undefined;
  const field: PageField = { name, type, required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true" };
  if (label) field.label = label;
  return field;
}

/**
 * What a field is called in everything we send: its name or id, or, when it has
 * neither (common in apps that keep form state in code), its label made into a key.
 */
export function fieldKey(el: Element, label = fieldLabel(el, el.getRootNode() as ParentNode)): string {
  return clean(el.getAttribute("name") || el.id || "", 64) ?? slug(label ?? "");
}

export function fieldLabel(el: Element, root: ParentNode): string | undefined {
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => labelText(byId(root, id))).join(" ");
    if (clean(text)) return clean(text);
  }
  if (el.id) {
    const forLabel = (root as Document | ShadowRoot).querySelector?.(`label[for="${cssEscape(el.id)}"]`);
    if (forLabel) return clean(labelText(forLabel));
  }
  const wrapping = el.closest("label");
  if (wrapping) return clean(labelText(wrapping));
  // A label just before the field that isn't tied to it (no for=): hand-written forms often do this.
  const before = el.previousElementSibling;
  if (before?.tagName === "LABEL" && !before.getAttribute("for")) return clean(labelText(before));
  const placeholder = el.getAttribute("placeholder");
  return placeholder ? clean(placeholder) : undefined;
}

/** Label text with any form controls inside it removed, so a field's own value can never leak in. */
function labelText(el: Element | null): string {
  if (!el) return "";
  const copy = el.cloneNode(true) as Element;
  for (const control of copy.querySelectorAll("input, textarea, select, [contenteditable]")) control.remove();
  return copy.textContent ?? "";
}

/** Repeated controls here are the product's own words: menus, tabs, toolbars. */
const CHROME = "nav, header, footer, aside, [role='navigation'], [role='menubar'], [role='menu'], [role='tablist'], [role='toolbar']";
const SELECTED = /^([A-Z][A-Za-z ]{1,30}):\s+\S/;
const MIN_PEERS = 3;
const MAX_PEERS = 30;
const CARD_LENGTH = 40;

/**
 * The label a user sees on a control (aria-label, title, value or text), scrubbed and truncated.
 *
 * A control repeated down a list usually names its own item, and items are users' data: tag
 * names, account names, record titles ("Delete the tag Urgent", "Delete the tag Phase 2"). So
 * when several look-alike controls sit side by side with different labels, only the words they
 * share are kept ("Delete the tag"); with none in common, no label is sent. Menus, tabs and
 * links to different screens are the product's own words and are kept. A switcher's current
 * choice ("Account: Personal") is dropped, keeping "Account". A card (a clickable
 * block of several separate texts) is not labelled by its contents.
 */
export function controlLabel(el: Element): string | undefined {
  const own = buttonLabel(el);
  if (!own || el instanceof HTMLFormElement) return own;
  // A switcher showing what is selected ("Account: Personal", "Workspace: Acme"): the choice is the user's.
  const switcher = SELECTED.exec(own);
  if (switcher) return switcher[1];
  if (el.closest(CHROME)) return own;
  const peers = peerControls(el);
  const labels = peers.map((p) => buttonLabel(p)).filter((l): l is string => l !== undefined);
  if (labels.length >= MIN_PEERS && new Set(labels).size > 1 && !toDifferentScreens(peers) && !namedByDeveloper(peers)) return sharedWords(labels);
  return isCard(el) ? undefined : own;
}

/** Look-alike controls next to this one (same tag and class), up to three levels up. */
function peerControls(el: Element): Element[] {
  let node: Element = el;
  for (let depth = 0; depth < 3; depth++) {
    const parent = node.parentElement;
    if (!parent) break;
    const tag = node.tagName;
    const cls = node.className;
    const same = [...parent.children].filter((c) => c.tagName === tag && c.className === cls).slice(0, MAX_PEERS);
    if (same.length >= MIN_PEERS) {
      if (node === el) return same;
      const pick = el.tagName.toLowerCase() + (el.classList[0] ? `.${cssEscape(el.classList[0])}` : "");
      return same.map((p) => p.querySelector(pick)).filter((c): c is Element => c !== null);
    }
    node = parent;
  }
  return [];
}

/**
 * A row of the product's own buttons ("Send reminder", "Archive", "Duplicate") is told apart from
 * a list of someone's items by how it was built: each button has its own fixed identifier (id,
 * name, data-action, data-testid) written by a developer, with no record numbers in it. Items
 * generated from someone's data have none, or ones carrying record ids.
 */
const DEV_ID = /^[A-Za-z][A-Za-z_-]{1,40}$/;
function namedByDeveloper(peers: Element[]): boolean {
  const ids = peers.map((p) => p.getAttribute("data-action") ?? p.getAttribute("data-testid") ?? p.getAttribute("name") ?? p.id ?? "");
  return ids.every((id) => DEV_ID.test(id)) && new Set(ids).size === ids.length;
}

/** Links to different screens are navigation; links to the same kind of screen are records. */
function toDifferentScreens(peers: Element[]): boolean {
  const firsts = new Set(peers.map((p) => p.closest("a[href]")?.getAttribute("href")?.replace(/^https?:\/\/[^/]+/, "").split(/[/?#]/).filter(Boolean)[0]).filter(Boolean));
  return firsts.size >= MIN_PEERS;
}

function sharedWords(labels: string[]): string | undefined {
  const split = labels.map((l) => l.split(" "));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((w) => w[n] === first[n])) n++;
  const shared = first.slice(0, n).join(" ");
  return shared.length >= 2 ? shared : undefined;
}

/** A clickable block of several separate texts (an account card, a list row), not a button. */
function isCard(el: Element): boolean {
  if (el.getAttribute("aria-label") || el.getAttribute("title")) return false;
  if ((el.textContent ?? "").trim().length <= CARD_LENGTH) return false;
  let texts = 0;
  for (const child of el.querySelectorAll("*")) if (child.children.length === 0 && (child.textContent ?? "").trim()) texts++;
  return texts >= 3;
}

/** Only text the site wrote: never what someone typed into a field. */
function buttonLabel(el: Element): string | undefined {
  if (el.closest(PRIVATE)) return undefined;
  if (el instanceof HTMLFormElement) return clean(el.getAttribute("name") || el.id);
  const isButtonInput = el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type);
  const raw =
    el.getAttribute("aria-label") ??
    el.getAttribute("title") ??
    (isButtonInput ? (el as HTMLInputElement).value : undefined) ??
    (el.matches("input, textarea, select, [contenteditable]") ? "" : boxedText(el)) ??
    "";
  return clean(raw, LIMITS.label, keepNumbers);
}

/**
 * A control's text as it reads on screen: words in separate boxes stay apart ("<span>06</span>
 * <span>How do my invoices get in?</span>" in a flex row is not "06How do my invoices get in?"), and a
 * number standing in a box of its own in front is the item's place in a list, not part of its name.
 */
const BOXED_LIMIT = 60;
function boxedText(el: Element): string {
  if (el.querySelectorAll("*").length > BOXED_LIMIT) return el.textContent ?? "";
  const view = el.ownerDocument.defaultView;
  const pieces: string[] = [];
  let line = "";
  const walk = (node: Node, row: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) line += child.textContent ?? "";
      else if (child instanceof Element) {
        const display = view?.getComputedStyle(child).display ?? "inline";
        const own = child.tagName === "BR" || BLOCK.test(child.tagName) || row || !/^(inline|contents)$/.test(display);
        if (!own) {
          walk(child, false);
          continue;
        }
        pieces.push(line);
        line = "";
        walk(child, /(flex|grid)/.test(display));
        pieces.push(line);
        line = "";
      }
    }
  };
  walk(el, /(flex|grid)/.test(view?.getComputedStyle(el).display ?? ""));
  pieces.push(line);
  const words = pieces.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (words.length > 1 && /^(\d{1,3}|#)[.):]?$/.test(words[0]!)) words.shift();
  return words.join(" ");
}

function byId(root: ParentNode, id: string): Element | null {
  return (root as Document | ShadowRoot).getElementById?.(id) ?? root.querySelector(`#${cssEscape(id)}`);
}

function originOf(doc: Document): string {
  try {
    return new URL(doc.URL).origin;
  } catch {
    return "null";
  }
}

/**
 * An element's text with its line breaks and blocks apart: "already<br>hold" is "already hold",
 * and "<a>Accounts</a><p>account operations</p>" is "Accounts account operations", not "Accountsaccount".
 * Only what is drawn counts: a heading holding one copy for phones and one for computers is read once.
 */
const BLOCK = /^(P|DIV|LI|UL|OL|DL|DT|DD|TABLE|TR|TD|TH|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION)$/;
function spacedText(el: Element): string {
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node instanceof Element) out += node.tagName === "BR" ? " " : !onScreen(node) ? "" : BLOCK.test(node.tagName) ? ` ${spacedText(node)} ` : spacedText(node);
  }
  return out;
}

/** Characters with no look of their own (U+2060 word joiner, soft hyphens, direction marks): not words. Joiners in emoji and some scripts stay. */
const FORMAT_CHARACTERS = /(?![\u200C\u200D])\p{Cf}/gu;

/**
 * Page text, made safe to send: personal-data patterns scrubbed, the name after a greeting
 * removed, and every number of two or more digits replaced by "#" (record numbers, amounts,
 * balances, dates differ per user; "Step 2" and "2FA" are kept), unless `numbers` says to keep them.
 */
export function clean(text: string | null | undefined, max: number = LIMITS.label, numbers = false): string | undefined {
  if (!text) return undefined;
  const scrubbed = scrub(text.replace(FORMAT_CHARACTERS, "").replace(/\s+/g, " ").trim()).replace(GREETING, "$1$2[name]");
  const out = (numbers ? scrubbed : scrubbed.replace(/\d[\d,.]*\d/g, "#")).slice(0, max);
  return out || undefined;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\#.:[\]()\s]/g, "\\$&");
}
