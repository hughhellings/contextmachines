/**
 * Proven checks: what's measurably wrong on a screen, read from the real browser with no AI. Each
 * is a measurement (a text wider than its box, a floating box on top of a field at the field's
 * centre, a drawn "undefined"), and a false item costs more than a missed one, so every check here
 * asks what else could look the same and stays quiet when it can't tell.
 *
 * Two kinds of function live here. Those marked "in the page" run in the browser, and take nothing
 * from this file: they are sent as text. The rest are plain functions over what those measured.
 *
 * What made-up data does to this: layout, wording templates and structure are the app's own and
 * real whoever is looking. Numbers, names and rows are invented, so a value from a made-up row is
 * never the basis of an item (see the filters in scan.ts).
 */

/** Something measured wrong on a screen. Apart from Finding: these are about what's drawn, and they also come from stand-in screens. */
export interface ScreenCheck {
  /**
   * cut_off: a control's label doesn't fit its box. covered: something floats over a field or
   * button at its centre. wording: a broken template in drawn text. overflow: the page runs off
   * sideways at phone width. unreachable: a control is off the side at phone width and nothing
   * scrolls to it. broken_image: an image on show failed to load. console_error: the page logged
   * an error of its own as it loaded. failed_request: a file of the app's own failed to load.
   */
  kind: "cut_off" | "covered" | "wording" | "overflow" | "unreachable" | "broken_image" | "console_error" | "failed_request";
  /** The first screen it was measured on. */
  screen: string;
  /** Every screen it was measured on, the first among them: one sidebar is one thing to fix. */
  screens: string[];
  /** What's wrong, in the app's own words: the label, the phrase, the image's or file's path, the first line logged. */
  target: string;
  /** What was measured. */
  evidence: string;
  /** The window it was measured at, when that matters. */
  at?: "desktop" | "phone";
  /** For wording: which kind of template broke. */
  wording?: "count" | "missing_value" | "placeholder";
  /** For covered: what's on top. */
  by?: string;
  /** For covered: the lines of what's on top, as its code would hold them. */
  byWords?: string[];
  /** For covered: what's on top is a cookie banner. */
  cookieBanner?: true;
  /** For cut_off: the width it has, as labels in boxes of one width have one cause. */
  room?: number;
  /** Where it sits on the photo of the screen at that width, when it has a place. */
  box?: Box;
  /** A photo showing it, when the screen's own photo can't: taken at phone width, or with the cookie banner still up. */
  proof?: Buffer;
  /** Seen on a screen only the stand-in reached. Layout and wording there are real; the data isn't, and nothing here rests on it. */
  seenWith?: "stand-in";
  /** Only the new-account walk saw it (see NewUserReport). */
  newUser?: true;
  /** The look with one row saw it (see oneRowLook), so that look's photo shows it, where a photo with more rows may not. */
  oneRow?: true;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A screen as a reader of it needs it, holding only what was on screen. For a review of the screen: no values typed, no addresses. */
export interface ScreenReview {
  path: string;
  /** Its main heading. */
  heading?: string;
  /**
   * What a person reads, in order, navigation aside: at most MOST_LINES lines. On a stand-in screen a
   * line that carries a made-up row's value is MADE_UP_LINE instead, so nobody judges it. Empty for
   * a run on a real session, where what's on screen is someone's. Off the stand-in it holds no table
   * cell: with no sign-in in the way, a local app's rows are its real database.
   */
  text: string[];
  /** Controls, with what state each is in. */
  controls: ReviewControl[];
  /** What's shown as locked or paid. */
  locked: { label: string; why: "icon" | "badge" | "says" | "asks" }[];
  /** Empty states on the screen, and the action next to each, if there is one. */
  empty: { text: string; next?: string }[];
  /** What stands in front of the product here, if anything. */
  gate?: "sign_in" | "no_access" | "paywall" | "failed";
  /** The screen wasn't the real thing: see ScreenCheck.seenWith. */
  seenWith?: "stand-in";
  /** Made-up rows were drawn here. */
  madeUpData?: true;
  /** Seen as a brand-new account: no rows, no setup. */
  account?: "new";
  /**
   * This run decided what the screen's data was. refused: a call of its own went unanswered. empty: a
   * call was answered here with nothing in it. What such a screen says about having nothing is no
   * measure of the app.
   */
  heldData?: "refused" | "empty";
}

export interface ReviewControl {
  label: string;
  kind: "button" | "link" | "field" | "tab" | "menu";
  where: "nav" | "main" | "floating";
  /** Only what isn't the plain state. */
  states?: ("disabled" | "selected" | "checked" | "expanded" | "required" | "read_only")[];
}

/**
 * The new-account walk: the app as a person who has just signed up finds it. No rows, no finished
 * setup, the same seal. All of it is seen as a made-up account, and stays marked.
 */
export interface NewUserReport {
  /** walked: at least one screen drew for the new account. not_walked: nothing did, and message says why. */
  status: "walked" | "not_walked";
  message: string;
  /** The screen a new person sees first, past the sign-in. */
  first?: string;
  /** What was seen, in the order it was opened. */
  screens: ScreenReview[];
  /** Photos of those, with seenWith; kept apart from ScanResult.screens, which may show the same address with made-up rows. */
  photos: { path: string; width: number; height: number; jpeg: Buffer; seenWith: "stand-in" }[];
  /** First-run addresses (onboarding, welcome, setup) that were to be opened, and what came of each. */
  firstRun: { path: string; opened: boolean; landed?: string; why?: string }[];
  /** Addresses that drew nothing for the new account, with why. */
  notReached: { path: string; why: string }[];
  /**
   * How long the walk spent on each of its screens, in ms, by address: from the screen opening to the
   * next one (or the walk's end), as the walk's own clock had it. Only said once the walk is over,
   * as nothing of the walk is said while it goes; kept apart from the screens, which go to the AI.
   */
  took?: Record<string, number>;
}

/** The phone a screen is measured at: the width a great many phones have, and tall enough to matter. */
export const PHONE = { width: 390, height: 844 };
/** Lines of text kept for a screen, and how long each may be. */
export const MOST_LINES = 90;
const LINE_LENGTH = 160;
/** Said in place of a line that carries a made-up value. */
export const MADE_UP_LINE = "(made-up row)";

/** Where a table's values are, its row headers among them: a customer's name is often one. Column headers are the app's own words. */
export const TABLE_CELLS = "td, tbody th, [role=cell], [role=gridcell], [role=rowheader]";

/** One run of text as drawn: what sits on one block, in page order. */
export interface DrawnLine {
  text: string;
  /** Set in a typewriter font: how an app shows a value as it is, on purpose. */
  mono: boolean;
  /** In navigation or a sidebar: on every screen, and no part of what the screen says. */
  chrome: boolean;
  /** In a table's cell (see TABLE_CELLS). */
  cell?: boolean;
}

export interface Drawn {
  lines: DrawnLine[];
  /** The page shows code: words like null are probably about code. */
  code: boolean;
  lang: string;
}

/**
 * In the page: the text as drawn, block by block, each block holding only its own inline text, so
 * "<b>1</b> trades" is one line and a number stacked over its caption is two. What's in code, in a
 * box to type in, or isn't drawn isn't here.
 */
export function readDrawn(): Drawn {
  const lines: DrawnLine[] = [];
  const blocks = new Map<Element, { parts: string[]; mono: boolean; chrome: boolean; cell: boolean }>();
  const blockOf = (el: Element): Element => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const display = getComputedStyle(e).display;
      if (!display.startsWith("inline") && display !== "contents") return e;
    }
    return document.body;
  };
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), n = 0; node && n < 20_000; node = walker.nextNode(), n++) {
    const parent = node.parentElement;
    const words = node.textContent ?? "";
    if (!parent || !words.trim() || parent.closest("script, style, noscript, code, pre, kbd, samp, textarea, select, option, [contenteditable=true], template")) continue;
    if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const box = parent.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2 || box.right <= 0 || box.left >= document.documentElement.scrollWidth) continue;
    const block = blockOf(parent);
    const had = blocks.get(block);
    const mono = /mono|courier|consolas|menlo/i.test(getComputedStyle(parent).fontFamily);
    if (had) {
      had.parts.push(words);
      had.mono ||= mono;
    } else blocks.set(block, { parts: [words], mono, chrome: parent.closest("nav, aside, [role=navigation], [role=complementary], footer, [role=contentinfo]") !== null, cell: parent.closest("td, tbody th, [role=cell], [role=gridcell], [role=rowheader]") !== null });
  }
  for (const { parts, mono, chrome, cell } of blocks.values()) {
    const text = parts.join("").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, mono, chrome, cell });
  }
  const code = [...document.querySelectorAll("code, pre, kbd, samp")].some((el) => el.getBoundingClientRect().width > 0);
  return { lines, code, lang: document.documentElement.lang.toLowerCase() };
}

/** What's measured on a screen at one width. */
export interface Measured {
  width: number;
  height: number;
  /** Labels of controls in reach at this width. */
  labels: string[];
  cut: { label: string; needs: number; has: number; title: boolean; box: Box; fontStoodIn: boolean; narrow: boolean }[];
  covered: { label: string; by: string; words: string[]; cookie: boolean; box: Box; x: number; y: number }[];
  /** Controls a third of which or more is under the box asked about. */
  under: string[];
  overflow?: { excess: number; starts: string; text: string; fontStoodIn: boolean };
  /** Controls in the page's flow past the side of the window, with nothing that scrolls to them. */
  offside: { label: string; box: Box }[];
  images: string[];
}

/**
 * In the page: everything that takes the layout as it now is. See each part for what it won't
 * take for a problem. Nothing is left changed: a control scrolled to is scrolled back.
 */
export function measureLayout(options: { under?: Box | undefined }): Measured {
  const root = (document.scrollingElement ?? document.documentElement) as HTMLElement;
  const width = root.clientWidth;
  const height = window.innerHeight;
  const area = width * height;
  const said = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const place = (r: DOMRect): Box => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.closest("[aria-hidden=true], [inert]") === null;
  };
  const nameOf = (el: Element): string => {
    const field = el as HTMLInputElement;
    if (el.matches("input, select, textarea")) return said(field.labels?.[0]?.textContent || el.getAttribute("aria-label") || field.placeholder || field.value || field.name);
    return said(el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title"));
  };

  /** Faces far narrower than any fallback, by name: with one of these kept out, a label too wide for its box proves nothing. */
  const narrowFace = (el: Element) => /condensed|narrow|compressed|oswald|bebas|anton|fjalla|league gothic|pathway gothic|teko|saira extra/i.test(getComputedStyle(el).fontFamily);
  /** Whether the first font the element asks for is being drawn, or a fallback in its place. */
  const canvas = document.createElement("canvas").getContext("2d");
  const fonts = new Map<string, boolean>();
  const fontStoodIn = (el: Element): boolean => {
    const first = getComputedStyle(el).fontFamily.split(",")[0]?.replace(/["']/g, "").trim() ?? "";
    if (!first || !canvas || /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|BlinkMacSystemFont)$/i.test(first)) return false;
    const known = fonts.get(first);
    if (known !== undefined) return known;
    const sample = "Hamburgefonstiv 0123456789";
    const widthIn = (font: string) => {
      canvas.font = font;
      return canvas.measureText(sample).width;
    };
    const missing = ["monospace", "serif"].every((generic) => widthIn(`72px "${first}", ${generic}`) === widthIn(`72px ${generic}`));
    fonts.set(first, missing);
    return missing;
  };

  /**
   * Cut-off text: a label on a button, a tab or a link in the navigation whose text runs past the
   * box that clips it, the control itself or something in it. Measured on the text alone, as a
   * ripple or a badge in a button can make its scrollWidth larger with every word on show. Not
   * screen-reader text, not a rail that hides whole labels (the clipping box is outside the control,
   * or nothing of the label is left inside it), and not a link in a table or a list of content,
   * where cutting a long name is the design.
   */
  const CONTROLS = "button, [role=button], [role=tab], [role=menuitem], nav a[href], aside a[href], header a[href], [role=navigation] a[href], [role=tablist] a[href], [role=menu] a[href], [role=menubar] a[href], [role=toolbar] a[href]";
  const cut: Measured["cut"] = [];
  const textWidth = (el: Element): number => {
    let left = Infinity;
    let right = -Infinity;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width === 0) continue;
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
    }
    return right > left ? right - left : 0;
  };
  /** How much of the text is on show: what's left of it inside every box that clips it, up to the control. A text range measures all of it either way. */
  const drawnWidth = (el: Element, control: Element): number => {
    let most = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      let left = box.left;
      let right = box.right;
      for (let e: Element | null = node.parentElement; e; e = e === control ? null : e.parentElement) {
        if (getComputedStyle(e).overflowX === "visible") continue;
        const clip = e.getBoundingClientRect();
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      most = Math.max(most, right - left);
    }
    return most;
  };
  /** Less of a label on show than this is no label cut short: a rail folded to its icons, on purpose. */
  const FEWEST_DRAWN = 10;
  for (const control of [...document.querySelectorAll(CONTROLS)].slice(0, 400)) {
    if (!shown(control) || control.closest("table, [role=grid], [role=table], [role=row], [role=listbox], select")) continue;
    const box = control.getBoundingClientRect();
    if (box.right <= 0 || box.left >= width) continue;
    for (const part of [control, ...control.querySelectorAll("*")].slice(0, 12)) {
      const style = getComputedStyle(part);
      if (style.textOverflow !== "ellipsis" && !/hidden|clip/.test(style.overflowX)) continue;
      const inner = part.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (inner < 16 || part.scrollWidth <= part.clientWidth || !said(part.textContent)) continue;
      const needs = textWidth(part);
      if (needs <= inner + 1 || drawnWidth(part, control) < FEWEST_DRAWN) continue;
      const label = said(control.textContent);
      cut.push({ label, needs: Math.round(needs), has: Math.round(inner), title: said(control.getAttribute("title") || part.getAttribute("title")) === label, box: place(box), fontStoodIn: fontStoodIn(part), narrow: narrowFace(part) });
      break;
    }
  }

  /**
   * Something covering a control: what's on top, at its centre or over a good part of it, is floating (fixed or sticky), holds
   * nothing of the control, and stays on top when the control is scrolled to the middle of the
   * window, so a person can't get it out of the way. A dialog over the page, a tooltip or a
   * notice isn't this: covering what's behind it is what those are for. Nor is a floating panel
   * with its own close button, or anything over such a panel: a person can put it away.
   */
  const FLOATS = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select, button, [role=button]";
  /** Says it's about cookies and has answers to give, unlike the small "Cookie choices" pill it may leave behind. */
  const isBanner = (el: Element) => /cookie|consent/i.test(el.textContent ?? "") && el.querySelector("button, [role=button], a[href]") !== null;
  /** A person can put it away: then it isn't in their way for long, and a panel only a developer sees usually can be. */
  const closable = (el: Element | undefined) => el !== undefined && [...el.querySelectorAll("button, [role=button]")].some((b) => /^(?:×|✕|x|close|dismiss|hide)(?:\s|$)/i.test(said(b.getAttribute("aria-label") || (b as HTMLElement).innerText)));
  const floater = (el: Element): Element | undefined => {
    for (let e: Element | null = el.parentElement; e && e !== document.body; e = e.parentElement) if (/fixed|sticky/.test(getComputedStyle(e).position)) return e;
    return undefined;
  };
  const floatAt = (el: Element, x: number, y: number): Element | undefined => {
    if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el) || (el as HTMLInputElement).labels?.[0]?.contains(top)) return undefined;
    for (let e: Element | null = top; e && e !== document.body; e = e.parentElement) {
      const position = getComputedStyle(e).position;
      if (position !== "fixed" && position !== "sticky") continue;
      const r = e.getBoundingClientRect();
      if (e.contains(el) || r.width * r.height >= area * 0.6) return undefined;
      const banner = isBanner(e);
      if (e.closest("dialog, [role=dialog], [role=alertdialog], [aria-modal=true], [role=tooltip], [role=status], [role=alert]") && !banner) return undefined;
      if (!banner && (closable(e) || closable(floater(el)))) return undefined;
      return e;
    }
    return undefined;
  };
  /** On top at the centre, or over a third of a grid across the control: half a text box hidden is hidden, wherever its centre falls. */
  const floatOver = (el: Element): Element | undefined => {
    const box = el.getBoundingClientRect();
    const hits = new Map<Element, number>();
    // Running off the window, a control's centre is the only fair test: the rest of it may be all a person has.
    if (box.top < 0 || box.left < 0 || box.bottom > height || box.right > width) return floatAt(el, box.left + box.width / 2, box.top + box.height / 2);
    for (const across of [0.25, 0.5, 0.75]) {
      for (const down of [0.25, 0.5, 0.75]) {
        const float = floatAt(el, box.left + box.width * across, box.top + box.height * down);
        if (!float) continue;
        if (across === 0.5 && down === 0.5) return float;
        hits.set(float, (hits.get(float) ?? 0) + 1);
      }
    }
    return [...hits].find(([, count]) => count >= 3)?.[0];
  };
  const stillOver = (el: Element): Element | undefined => {
    const scrolled: [Element, number, number][] = [];
    for (let e: Element | null = el.parentElement; e; e = e.parentElement) scrolled.push([e, e.scrollLeft, e.scrollTop]);
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const over = floatOver(el);
    for (const [e, left, top] of scrolled) {
      e.scrollLeft = left;
      e.scrollTop = top;
    }
    return over;
  };
  const covered: Measured["covered"] = [];
  const under: string[] = [];
  const candidates = [...document.querySelectorAll(FLOATS)].slice(0, 200).filter((el) => {
    const r = el.getBoundingClientRect();
    return shown(el) && r.width >= 16 && r.height >= 12 && !(el as HTMLButtonElement).disabled;
  });
  for (const el of candidates) {
    const label = nameOf(el);
    if (!label) continue;
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const asked = options.under;
    if (asked) {
      const across = Math.min(box.right, asked.x + asked.w) - Math.max(box.left, asked.x);
      const down = Math.min(box.bottom, asked.y + asked.h) - Math.max(box.top, asked.y);
      if (across > 0 && down > 0 && across * down >= box.width * box.height * 0.3) under.push(label);
    }
    if (!floatOver(el)) continue;
    const float = stillOver(el);
    if (!float) continue;
    const drawnText = (float as HTMLElement).innerText ?? "";
    const text = said(drawnText);
    const words = [...new Set(drawnText.split(/\n+/).map(said).filter((line) => line.length >= 3 && line.length <= 120))].slice(0, 8);
    covered.push({ label, by: text.slice(0, 80) || said(float.getAttribute("aria-label")) || float.tagName.toLowerCase(), words, cookie: isBanner(float), box: place(box), x: Math.round(x), y: Math.round(y) });
  }

  /**
   * The page running off sideways, for a person who can scroll it there. A page that never said
   * it fits a phone (no width=device-width) is drawn wider and scaled by a real phone, so it isn't
   * this. Where it starts: the first thing past the edge whose parent isn't.
   */
  const pageStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : pageStyle;
  const stops = (value: string) => value === "hidden" || value === "clip";
  const noSideways = stops(pageStyle.overflowX) || stops(bodyStyle.overflowX);
  const fitsPhones = /width\s*=\s*device-width/i.test(document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? "");
  const excess = root.scrollWidth - root.clientWidth;
  let overflow: Measured["overflow"];
  if (excess >= 8 && !noSideways && fitsPhones) {
    const inScroller = (el: Element) => {
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).overflowX !== "visible") return true;
      return false;
    };
    const all = [...document.body.querySelectorAll("*")].slice(0, 6000);
    const first = all.find((el) => {
      const parent = el.parentElement;
      return el.getBoundingClientRect().right > width + 4 && shown(el) && getComputedStyle(el).position !== "fixed" && !inScroller(el) && parent !== null && parent.getBoundingClientRect().right <= width + 4;
    }) ?? all.reverse().find((el) => el.scrollWidth > width + 4 && shown(el) && !inScroller(el)); // text running out of a box that fits
    overflow = { excess, starts: first ? first.tagName.toLowerCase() : "", text: first ? said((first as HTMLElement).innerText).slice(0, 80) : "", fontStoodIn: first ? fontStoodIn(first) : false };
  }

  /**
   * A control off the side of a page that won't scroll there. Something moved off on purpose
   * doesn't count: a closed drawer (taken out of the flow, or moved by a transform), a slider's
   * next slide, anything inside a box of its own that scrolls, by a person or by the arrows beside it.
   */
  const offside: Measured["offside"] = [];
  const labels: string[] = [];
  const BUTTONS = "button, [role=button]";
  const inWindow = (el: Element) => {
    const r = el.getBoundingClientRect();
    return shown(el) && r.left >= 0 && r.right <= width;
  };
  /** Laid over the box's contents, not among them: a button that scrolls away with the rest can't be what brings it back. */
  const overlaid = (el: Element, box: Element) => {
    for (let e: Element | null = el; e && e !== box; e = e.parentElement) if (/absolute|fixed/.test(getComputedStyle(e).position)) return true;
    return false;
  };
  /** What it holds sits in one row, in a track of its own or not. A root or a card stacks what it holds, and what it clips is no strip to move. */
  const oneRow = (box: Element) => {
    let items = [...box.children];
    for (let up = 0; items.length === 1 && up < 4; up++) items = [...items[0]!.children];
    const row = items.filter(shown).map((item) => item.getBoundingClientRect());
    return row.every((item) => item.top < row[0]!.bottom && item.bottom > row[0]!.top);
  };
  /** Just above, below or level with the box: what's further off is about something else. */
  const ARROW_GAP = 64;
  const nextTo = (el: Element, box: Element) => {
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return r.top - b.bottom <= ARROW_GAP && b.top - r.bottom <= ARROW_GAP;
  };
  /** Buttons round a box, up to two wrappers out: arrows often sit in a box of their own, for a fade or a place below the strip. */
  const besideBox = (box: Element) => {
    const beside: Element[] = [];
    for (let e = box.parentElement, up = 0; e && up < 2; e = e.parentElement, up++) beside.push(...e.querySelectorAll(BUTTONS));
    return beside.filter((button) => !box.contains(button) && nextTo(button, box));
  };
  /** A strip with hidden overflow that really overflows, and a button laid over it or beside it that can move it. With none, what's past its edge stays out of reach. */
  const hasArrows = (box: Element) => getComputedStyle(box).overflowX === "hidden" && box.scrollWidth > box.clientWidth && oneRow(box) && [...[...box.querySelectorAll(BUTTONS)].filter((button) => overlaid(button, box)), ...besideBox(box)].some(inWindow);
  for (const el of [...document.querySelectorAll("a[href], button, [role=button], input:not([type=hidden]), select, textarea")].slice(0, 500)) {
    if (!shown(el)) continue;
    const label = nameOf(el);
    if (!label) continue;
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    if (x >= 0 && x < width) {
      labels.push(label);
      continue;
    }
    if (!noSideways || el.closest("[class*=carousel i], [class*=swiper i], [class*=slick i], [class*=slider i], [aria-roledescription=carousel]")) continue;
    let moved = false;
    for (let e: Element | null = el; e && e !== document.body && !moved; e = e.parentElement) {
      const style = getComputedStyle(e);
      moved = style.position === "fixed" || style.position === "absolute" || style.transform !== "none" || style.translate !== "none" || /auto|scroll/.test(style.overflowX) || hasArrows(e);
    }
    if (!moved) offside.push({ label, box: place(box) });
  }

  const images = [...document.images].filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc && !img.currentSrc.startsWith("data:") && shown(img)).map((img) => img.currentSrc);
  return { width, height, labels: [...new Set(labels)], cut, covered, under, ...(overflow ? { overflow } : {}), offside, images };
}

/** What was found on the page by the cookie banner step. */
export interface Banner {
  box: Box;
  /** Stays where it is as the page scrolls, so it's in the same place on any page. */
  fixed: boolean;
}

/**
 * In the page: a cookie banner and its privacy-preserving answer. The button is what's looked for
 * first, in anything floating or anything marked as a banner, since an app's own banner is often
 * a plain box with no name of its own. It's kept on the window so the click can come later.
 */
export function findBanner(decline: string): Banner | undefined {
  const say = (el: Element) => ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").replace(/[\s.!]+$/, "").trim();
  const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  const refuse = new RegExp(decline, "i");
  const named = [...document.querySelectorAll("[role=dialog], [role=alertdialog], dialog, [aria-modal=true], [id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [id*=gdpr i], [class*=gdpr i]")];
  const inNamed = named.filter((el) => /cookie|consent|privacy/i.test(el.textContent ?? "") && shown(el)).flatMap((banner) => [...banner.querySelectorAll("button, [role=button], a")]);
  const floating = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const position = getComputedStyle(e).position;
      if (position === "fixed" || position === "sticky") return e;
    }
    return undefined;
  };
  const anywhere = [...document.querySelectorAll("button, [role=button]")].filter((b) => refuse.test(say(b)) && /cookie|consent/i.test(floating(b)?.textContent ?? ""));
  const no = [...inNamed, ...anywhere].find((b) => shown(b) && refuse.test(say(b)));
  if (!no) return undefined;
  (window as unknown as { __ctxDecline?: Element }).__ctxDecline = no;
  const float = floating(no);
  // The box a person sees: a fixed wrapper may span the window and let clicks through.
  let drawn: Element = no;
  for (let e: Element | null = no; e && float?.contains(e); e = e.parentElement) {
    const style = getComputedStyle(e);
    if (style.pointerEvents !== "none" && (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none")) drawn = e;
  }
  const box = drawn.getBoundingClientRect();
  return { box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) }, fixed: float !== undefined && getComputedStyle(float).position === "fixed" };
}

/** Words a count of one can follow when what's before it reads as a sentence. "Tier 1 customers" and "Day 1 rewards" name a thing, and don't. */
const LEADS_TO_COUNT = new Set("on from in of across with over after for have has had got found showing shows show only just last past next about least most total all by to and or than within contains containing includes including using added see selected remove delete view you've we've".split(" "));
/** What sits between the count and its noun: "1 closed trades". Never a noun: "1 day trades" and "1 bed apartments" are fine English. */
const COUNT_WORD = /^(?:[a-z]{2,}[^e\W]ed|more|other|new|open|active|free|unread|pending|remaining|recent|total|extra|additional|valid|previous|upcoming|live|unique|different)$/;
/** Words that end a noun phrase. Anything else after it ("1 sales rep", "1 savings account", "1 news item") may make it a compound. */
const ENDS_PHRASE = new Set("in on of to for from this that last these so far at by and or are were have had left remaining ago yet needed required before until with you your per · • | – — -".split(" "));
/** Words ending in s that aren't plurals, or are plurals a count of one can fairly say. */
const NOT_PLURAL = new Set("news series species means always perhaps sometimes besides towards afterwards across plus minus thanks times pants scissors glasses maths physics economics analytics statistics has was does goes says this its his hers yes gas lens canvas atlas christmas paris james texas tennis kansas".split(" "));
/** Other languages, where only a list of common screen words is safe: their plurals have no one ending, and many a singular looks like one. */
const OTHER_PLURALS: Record<string, Set<string>> = {
  de: new Set("Dateien Ergebnisse Nachrichten Aufgaben Projekte Kommentare Tage Stunden Minuten Sekunden".split(" ")),
  es: new Set("elementos archivos resultados usuarios días horas minutos segundos mensajes comentarios tareas proyectos".split(" ")),
  fr: new Set("éléments fichiers résultats utilisateurs jours heures secondes commentaires tâches projets".split(" ")),
  it: new Set("elementi risultati utenti giorni ore minuti secondi messaggi commenti progetti".split(" ")),
  nl: new Set("bestanden resultaten gebruikers dagen uren berichten opmerkingen taken projecten".split(" ")),
  pt: new Set("itens arquivos resultados usuários dias horas minutos segundos mensagens comentários tarefas projetos".split(" ")),
};

/**
 * "1 Details" with "2 Shipping" on the same page: a numbered step, and its number a position. The
 * same word after both ("1 Trades", "2 Trades") is two counts, so that stays one.
 */
function numberedStep(line: string, lines: readonly string[]): boolean {
  const first = /^1 (\p{Lu}\p{L}*)$/u.exec(line)?.[1];
  return first !== undefined && lines.some((other) => {
    const next = /^2 (\p{Lu}\p{L}*)/u.exec(other)?.[1];
    return next !== undefined && next !== first;
  });
}

/** A count of one with a plural noun, if the line has one: "on 1 closed trades". */
export function countMismatch(line: string, lang = ""): string | undefined {
  const words = line.split(" ");
  const language = lang.split("-")[0] ?? "";
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "1") continue;
    const before = words[i - 1];
    const fits = before === undefined || /[:(·•|,–—-]$/.test(before) || LEADS_TO_COUNT.has(before.toLowerCase());
    if (!fits) continue;
    const other = OTHER_PLURALS[language];
    const next = words[i + 1];
    if (next === undefined) continue;
    // Elsewhere only at the start of a line or after a mark: no other language's lead words are listed.
    if (other && (before === undefined || /[:(·•|]$/.test(before)) && words.length <= 8) {
      const bare = next.replace(/[.,;:!?)]+$/, "");
      if (other.has(bare)) return `1 ${bare}`;
    }
    if (language && language !== "en") continue;
    const nounAt = next && COUNT_WORD.test(next) && !/hundred/.test(next) ? i + 2 : i + 1;
    const raw = words[nounAt];
    if (raw === undefined) continue;
    const noun = raw.replace(/[.,;:!?)\]]+$/, "");
    const closed = noun !== raw || nounAt === words.length - 1;
    const after = words[nounAt + 1]?.toLowerCase();
    if (!closed && !(after && ENDS_PHRASE.has(after))) continue;
    const lower = /^[A-Z][a-z]+$/.test(noun) && words.length === 2 ? noun.toLowerCase() : noun;
    if (!/^[a-z]{3,}s$/.test(lower) || /(?:ss|us|is)$/.test(lower) || NOT_PLURAL.has(lower)) continue;
    return words.slice(i, nounAt + 1).join(" ").replace(/[.,;:!?)\]]+$/, "");
  }
  return undefined;
}

const VALUE = "(?:undefined|null|NaN)";
const LEFT_IN = [
  new RegExp(`^${VALUE}$`),
  new RegExp(`[$€£¥]\\s?${VALUE}\\b`),
  new RegExp(`\\b${VALUE}\\s?%`),
  new RegExp(`^[\\p{L} ]{1,28}:\\s*${VALUE}$`, "u"),
  new RegExp(`^(?:hi|hello|hey|welcome(?: back)?|good (?:morning|afternoon|evening))[,! ]+(?:undefined|null)\\b`, "i"),
  /\bNaN\b/,
  /\bundefined undefined\b/,
];
/** Written out, about the words: a line of more than this many words is prose. */
const PROSE_WORDS = 14;
const SAYS_TEMPLATE = /\b(?:use|insert|variable|placeholder|merge (?:tag|field)|template|token|syntax|such as|e\.?g\.?|for example|like)\b/i;
const PLACEHOLDER = /\{\{\s*[A-Za-z_][\w.]*\s*\}\}|(?<![\\$\w}])\{[A-Za-z_][\w.]*\}(?![{\w])|\$\{[A-Za-z_][\w.]*\}|%\{[A-Za-z_]\w*\}/;
/** Words that say a page is listing types or values: on it, a "null" alone on a line is one of them. */
const TYPE_WORDS = /^(?:true|false|string|number|boolean|object|array|integer|void|nil|none)$/;

export interface Wording {
  problem: "count" | "missing_value" | "placeholder";
  /** The phrase. */
  phrase: string;
  /** The whole line it's in. */
  line: string;
  /** That line is a table's cell (see TABLE_CELLS): a row's value, and only the phrase is the app's. */
  cell?: boolean;
}

/** Broken templates in what's drawn. What a page about code says, or says as prose, is left alone. */
export function brokenWording(drawn: Drawn): Wording[] {
  const found: Wording[] = [];
  const seen = new Set<string>();
  const add = (problem: Wording["problem"], phrase: string, line: string, cell: boolean | undefined) => {
    if (seen.has(`${problem} ${line}`)) return;
    seen.add(`${problem} ${line}`);
    found.push({ problem, phrase, line, ...(cell ? { cell } : {}) });
  };
  const listsTypes = drawn.lines.some((line) => TYPE_WORDS.test(line.text));
  const texts = drawn.lines.map((line) => line.text);
  /** The word is talked about in a sentence elsewhere on the page: it's a subject here, not a hole. */
  const talkedAbout = (word: string) => texts.some((text) => text.split(" ").length > 5 && text.toLowerCase().split(/[^\p{L}]+/u).includes(word.toLowerCase()));
  for (const { text, mono, cell } of drawn.lines) {
    if (mono) continue;
    const count = countMismatch(text, drawn.lang);
    if (count && !numberedStep(text, texts)) add("count", count, text, cell);
    if (text.split(" ").length > PROSE_WORDS || drawn.code) continue;
    if (text.includes("[object Object]")) add("missing_value", "[object Object]", text, cell);
    const literal = !listsTypes && LEFT_IN.some((rule) => rule.test(text)) ? /undefined|null|NaN/.exec(text)?.[0] : undefined;
    if (literal && !talkedAbout(literal)) add("missing_value", literal, text, cell);
    const hole = PLACEHOLDER.exec(text)?.[0];
    if (hole && !SAYS_TEMPLATE.test(text)) add("placeholder", hole, text, cell);
  }
  return found;
}

/**
 * Labels a person reads as fixed words. What's cut off and looks like data (an email, a number, a
 * file's name, a long sentence) is a value in a narrow box, and a tooltip with all of it says the
 * cut is on purpose.
 */
export function fixedLabel(label: string, title: boolean): boolean {
  return !title && label.length >= 3 && label.length <= 40 && label.split(" ").length <= 5 && !/[@/\\_\d]|\.\w{2,4}$/.test(label);
}

/** Words that say a screen has nothing in it yet, as what a line says for itself. */
const SAYS_EMPTY = [
  /^(?:there (?:are|is) )?no \p{L}+(?: \p{L}+){0,2} (?:yet|found|here|available|to show|to display|so far)\b/iu,
  /^no (?:data|results?|items?|records?|entries|activity|history|matches)\b/i,
  /^nothing (?:here|to show|to see|yet|found)\b/i,
  /^you (?:have|'ve got|don.t have|do not have) (?:no|any)\b/i,
  /^you haven.t \p{L}+/iu,
  /^(?:add|create|import|upload|connect|start by|get started by) .{0,60}\bto (?:get started|begin|see|start)\b/i,
  /^(?:noch )?keine \p{L}+/iu,
  /^(?:aucun|aucune|pas encore)\b/iu,
  /^(?:no hay|todavía no|aún no|sin \p{L}+ (?:todavía|aún))\b/iu,
];
/** Words on a control that asks for money, or a line saying something is paid for. */
export const ASKS_TO_PAY = /^(?:upgrade|subscribe|go pro|get pro|unlock|buy now|start (?:free )?trial|choose (?:a )?plan|see plans|view plans|upgrade to \p{L}+)\b/iu;
export const SAYS_PAID = /\b(?:upgrade to|available on (?:the )?\p{L}+|(?:pro|premium|paid|business|enterprise) (?:plan|feature|only)|requires? (?:a |the )?\p{L}+ plan|locked)\b/iu;
const PAID_BADGE = /^(?:pro|premium|plus|paid|business|enterprise|locked)$/i;

/** What's read from a page for a review: see ScreenReview. */
export interface Reviewed {
  heading?: string;
  controls: ReviewControl[];
  locked: ScreenReview["locked"];
  empty: ScreenReview["empty"];
  text: string[];
}

/** In the page: controls with their states, what's locked or paid, and empty states with what's offered beside them. Nothing inside `leaveOut`, when it's given. */
export function readReview(words: { empty: string[]; asks: string; says: string; badge: string; leaveOut?: string }): Omit<Reviewed, "text"> {
  const said = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => el.getBoundingClientRect().width > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.closest("[aria-hidden=true], [inert]") === null && !(words.leaveOut && el.closest(words.leaveOut));
  const chrome = (el: Element) => el.closest("nav, aside, [role=navigation], [role=complementary], [role=tablist]") !== null;
  const floats = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const position = getComputedStyle(e).position;
      if ((position === "fixed" || position === "sticky") && e.getBoundingClientRect().width < window.innerWidth * 0.8) return true;
    }
    return false;
  };
  const asks = new RegExp(words.asks, "iu");
  const paid = new RegExp(words.says, "iu");
  const badge = new RegExp(words.badge, "i");
  const empties = words.empty.map((rule) => new RegExp(rule, "iu"));
  const controls: ReviewControl[] = [];
  const locked: ScreenReview["locked"] = [];
  const noted = new Set<string>();
  const note = (label: string, why: ScreenReview["locked"][number]["why"]) => {
    if (!label || noted.has(label) || locked.length >= 24) return;
    noted.add(label);
    locked.push({ label: label.slice(0, 120), why });
  };
  const named = new Set<string>();
  for (const el of document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], a[href], input:not([type=hidden]), select, textarea")) {
    if (!shown(el)) continue;
    const field = el as HTMLInputElement;
    const isField = el.matches("input, select, textarea");
    const label = said(isField ? field.labels?.[0]?.textContent || el.getAttribute("aria-label") || field.placeholder || field.name : el.getAttribute("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("title")).slice(0, 80);
    if (!label) continue;
    const icon = el.querySelector("[class*=lucide-lock], [data-icon=lock], [data-lucide=lock], [class~=lock], [class*=-lock-], [class$=-lock], [aria-label=locked i]");
    if (icon) note(label, "icon");
    const tag = [...el.querySelectorAll("span, small, em, b, strong, i, sup")].find((part) => badge.test(said(part.textContent)));
    if (tag && said(tag.textContent) !== label) note(label, "badge");
    if (asks.test(label)) note(label, "asks");
    const where = floats(el) ? "floating" as const : chrome(el) ? "nav" as const : "main" as const;
    const key = `${label}|${where}`;
    if (named.has(key) || controls.length >= 70) continue; // what fits a reader, not every row of a table
    named.add(key);
    const states: NonNullable<ReviewControl["states"]> = [];
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) states.push("selected");
    if (field.checked || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true") states.push("checked");
    if (el.getAttribute("aria-expanded") === "true") states.push("expanded");
    if (field.required) states.push("required");
    if (field.readOnly) states.push("read_only");
    const kind = isField ? "field" as const : el.matches("[role=tab]") ? "tab" as const : el.matches("[role=menuitem]") ? "menu" as const : el.matches("a[href]") ? "link" as const : "button" as const;
    controls.push({ label, kind, where, ...(states.length ? { states } : {}) });
  }
  const empty: ScreenReview["empty"] = [];
  const blocks = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, td, div, span")].slice(0, 5000);
  const actionNear = (el: Element): string | undefined => {
    for (let box: Element | null = el, up = 0; box && box !== document.body && up < 5; box = box.parentElement, up++) {
      if (said((box as HTMLElement).innerText).length > 500) return undefined;
      const action = [...box.querySelectorAll("button, [role=button], a[href]")].find((c) => shown(c) && !chrome(c) && !(c as HTMLButtonElement).disabled && !/^(?:close|dismiss|cancel|×|x)$/i.test(said((c as HTMLElement).innerText)));
      if (action) return said(action.getAttribute("aria-label") || (action as HTMLElement).innerText).slice(0, 80) || undefined;
    }
    return undefined;
  };
  for (const el of blocks) {
    if (empty.length >= 12) break;
    // A block that holds a cell is a row, or a card around a table: its text is the cells'.
    if (!shown(el) || chrome(el) || floats(el) || el.closest("option, select, button, a") || (words.leaveOut && el.querySelector(words.leaveOut))) continue;
    const text = said((el as HTMLElement).innerText);
    if (!text || text.length > 140 || [...el.children].some((c) => said((c as HTMLElement).innerText) === text)) continue;
    if (paid.test(text)) note(text, "says");
    if (!empties.some((rule) => rule.test(text)) || empty.some((e) => e.text === text.slice(0, 140))) continue;
    const next = actionNear(el);
    empty.push({ text: text.slice(0, 140), ...(next ? { next } : {}) });
  }
  const heading = [...document.querySelectorAll("h1, h2, h3, [role=heading]")].filter((el) => shown(el) && !chrome(el)).map((el) => said((el as HTMLElement).innerText)).find(Boolean);
  return { ...(heading ? { heading: heading.slice(0, 120) } : {}), controls, locked, empty };
}

export const REVIEW_WORDS = { empty: SAYS_EMPTY.map((rule) => rule.source), asks: ASKS_TO_PAY.source, says: SAYS_PAID.source, badge: PAID_BADGE.source };

/** The lines of a screen for a review, in order, navigation aside, table cells only if `cells` says so, and with `blank` taking out what can't stand as it was drawn. */
export function reviewLines(drawn: Drawn, blank: (line: string) => string | undefined, cells: boolean): string[] {
  const lines: string[] = [];
  for (const { text, chrome, cell } of drawn.lines) {
    if (chrome || (cell && !cells) || lines.length >= MOST_LINES) continue;
    const kept = blank(text);
    if (kept !== undefined && kept !== lines[lines.length - 1]) lines.push(kept.slice(0, LINE_LENGTH));
  }
  return lines;
}

/**
 * One item for each thing to fix: a sidebar label cut off on fifteen screens is one line of code.
 * What's seen on real screens and on stand-in ones is kept apart, and what the new-account walk
 * saw alone stays marked as that.
 */
export function mergeChecks(checks: readonly ScreenCheck[]): ScreenCheck[] {
  const merged = new Map<string, ScreenCheck>();
  for (const check of checks) {
    const key = [check.kind, check.target, check.by ?? "", check.at ?? "", check.seenWith ?? ""].join("|");
    const had = merged.get(key);
    if (!had) {
      merged.set(key, { ...check, screens: [...check.screens] });
      continue;
    }
    had.screens = [...new Set([...had.screens, ...check.screens])];
    if (!check.newUser) delete had.newUser;
    if (check.oneRow) had.oneRow = true;
    had.proof ??= check.proof;
  }
  const order: ScreenCheck["kind"][] = ["covered", "wording", "overflow", "unreachable", "cut_off", "broken_image", "failed_request", "console_error"];
  return [...merged.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.screens.length - a.screens.length);
}

/** The words an address can hold that say it's for the first run. */
export const FIRST_RUN_PATH = /on-?boarding|(?:^|\/)(?:welcome|get(?:ting)?-?started|first-?run|set-?up|quick-?start|intro|tour)(?:\/|$)/i;
/** Addresses a signed-in person is usually sent on from. */
export const SIGN_UP_PATH = /(?:^|\/)(?:sign-?up|register|join|create-?account)(?:\/|$)/i;

/** What to trim from a line logged to the console: a message about the network says nothing about the code. */
export const NOT_THE_APPS_ERROR = /^failed to load resource|net::err_|blocked by (?:cors|client)|cors policy|content security policy|\[vite\]|\[hmr\]|websocket|failed to fetch|networkerror|load failed|abort|resizeobserver loop|download the react devtools/i;
/** A sign-in library saying nobody is signed in, which it can say with no request made: the normal state of a visitor, with no 401 to go by. */
export const SAYS_NO_SESSION = /\bauth ?session ?missing\b/i;
/**
 * A logged line saying a request was turned away. Beside a 401 or 403 from the site's own server in
 * the same load it's the normal answer to a visitor with no session, passed on by a fetch wrapper
 * or an auth client: the app is behaving, and nothing there needs fixing.
 */
export const SAYS_TURNED_AWAY = /\b40[13]\b|\bunauthori[sz]ed\b|\bunauthenticated\b|\bforbidden\b|\bnot (?:authenticated|authori[sz]ed|logged in|signed in)\b|\bsession (?:missing|expired)\b|\bjwt expired\b/i;
