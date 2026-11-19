/**
 * The accessibility scan: eight measured rules, read from the page with no AI and no extra library.
 * One self-contained `page.evaluate` walks the page (at most 5,000 elements, 1.5 seconds), and the
 * accessibility tree Chromium itself computes is used to confirm a control really has no name. It is
 * read-only: it never clicks, focuses or scrolls.
 *
 * This is not friction. Friction is where a user got stuck in this run; this is what the pages the run
 * reached would do to a person using a screen reader, a keyboard or a small screen. It is shown in
 * its own "Accessibility" section.
 *
 * What it leaves out on purpose (each rule says why): hidden and aria-hidden elements, images under
 * 2x2 pixels (trackers), ids inside an <svg>'s <defs>, links inside a sentence of text (WCAG 2.5.8's
 * inline exception), a small control with room around it (2.5.8's spacing exception), and native
 * checkboxes and radios the page hasn't sized (2.5.8's user-agent exception). Frames aren't scanned.
 */
import type { Page } from "playwright";

export type A11yKind = "no_name" | "img_no_alt" | "no_lang" | "field_no_label" | "placeholder_only" | "heading_order" | "duplicate_id" | "small_target";

/** One issue on one page. `what` and `page` are masked, and `what` is at most 60 characters. */
export interface A11yFinding {
  kind: A11yKind;
  /** The element in a few words: its role and name, or its first words. */
  what: string;
  /** The WCAG success criterion it falls under: "WCAG 4.1.2". */
  wcag: string;
  /** The page's path, with no query and nothing that reads like a secret. */
  page: string;
}

/** Each kind in plain words, for reports: one and many, and its WCAG reference. */
export const A11Y_KINDS: Record<A11yKind, { one: string; many: string; wcag: string; why: string }> = {
  no_name: { one: "control with no name", many: "controls with no name", wcag: "WCAG 4.1.2", why: "A screen reader announces it as just \"button\" or \"link\", with nothing to say what it does." },
  img_no_alt: { one: "image with no text alternative", many: "images with no text alternative", wcag: "WCAG 1.1.1", why: "It has no alt text, so a screen reader can't say what it shows (alt=\"\" marks one as decoration)." },
  no_lang: { one: "page with no language set", many: "pages with no language set", wcag: "WCAG 3.1.1", why: "The page doesn't say its language, so a screen reader may read it in the wrong voice." },
  field_no_label: { one: "form field with no label", many: "form fields with no label", wcag: "WCAG 1.3.1, 3.3.2", why: "Nothing tells a person what to type here." },
  placeholder_only: { one: "field labelled only by its placeholder", many: "fields labelled only by their placeholder", wcag: "WCAG 1.3.1, 3.3.2", why: "Its only label is placeholder text, which disappears as soon as someone types." },
  heading_order: { one: "heading problem", many: "heading problems", wcag: "WCAG 1.3.1", why: "Headings are how many people find their way around a page: it should have a main heading, and levels shouldn't be skipped going down." },
  duplicate_id: { one: "id used more than once", many: "ids used more than once", wcag: "best practice (WCAG 4.1.1 was removed in WCAG 2.2)", why: "Labels and ARIA references that point at this id may find the wrong element." },
  small_target: { one: "target smaller than 24 by 24 pixels", many: "targets smaller than 24 by 24 pixels", wcag: "WCAG 2.5.8", why: "It is hard to hit with a finger or an unsteady hand, and nothing gives it room." },
};

/** The order kinds are listed in. */
export const A11Y_ORDER = Object.keys(A11Y_KINDS) as A11yKind[];

/** At most this many findings of one kind on one page; the rest are counted. */
export const A11Y_PER_KIND = 10;
/** At most this many pages are scanned in one run. */
export const A11Y_MAX_PAGES = 20;
/** Elements walked on one page, at most. */
export const A11Y_MAX_ELEMENTS = 5000;
/** How long one page's scan may take. */
export const A11Y_TIMEOUT_MS = 1500;

/** One page's scan. */
export interface A11yPageScan {
  page: string;
  findings: A11yFinding[];
  /** Findings past A11Y_PER_KIND, counted by kind. */
  more: Partial<Record<A11yKind, number>>;
  /** The page had more elements than were walked: only the first A11Y_MAX_ELEMENTS were scanned. */
  cut?: true;
  /** The scan couldn't finish (too slow, or the page went away): its findings are what was read, often none. */
  error?: string;
  ms: number;
}

export interface ScanOptions {
  /** Chromium's accessibility tree (ariaSnapshot, mode "ai") when the caller has one already. */
  tree?: string;
  timeoutMs?: number;
  maxElements?: number;
}

/** What the page-side walk returns: raw, unmasked, unclipped. */
interface Raw {
  kind: A11yKind;
  role: string;
  what: string;
}
interface Walked {
  found: Raw[];
  cut: boolean;
}

/**
 * Runs in the page, self-contained: the walk. Only reads; never clicks, focuses or scrolls.
 * Exported for tests that want the raw rules; callers use scanPage.
 */
export function walkPage(limits: { maxElements: number; budgetMs: number }): Walked {
  const started = performance.now();
  const found: Raw[] = [];
  const all = document.body ? Array.from(document.body.querySelectorAll("*")) : [];
  const cut = all.length > limits.maxElements;
  const els = all.slice(0, limits.maxElements);
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  const hiddenCache = new Map<Element, boolean>();
  /** Hidden from everyone: display none, visibility hidden, the hidden attribute, or aria-hidden on it or a parent. */
  const hidden = (el: Element): boolean => {
    const known = hiddenCache.get(el);
    if (known !== undefined) return known;
    let h = false;
    if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) h = true;
    else if (el.parentElement && el.parentElement !== document.documentElement) h = hidden(el.parentElement);
    hiddenCache.set(el, h);
    return h;
  };
  const visible = (el: Element): boolean => {
    if (hidden(el)) return false;
    const vis = (el as HTMLElement).checkVisibility?.({ visibilityProperty: true } as CheckVisibilityOptions);
    if (vis === false) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const byId = (id: string) => document.getElementById(id);
  /** The text a reader would hear for an element's content: its text, images' alt, and aria-labels inside it. */
  const contentText = (el: Element): string => {
    const parts: string[] = [];
    const visit = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push(n.textContent ?? "");
        return;
      }
      if (!(n instanceof Element)) return;
      if (n.getAttribute("aria-hidden") === "true") return;
      if (n instanceof HTMLElement && n.hidden) return;
      if (n.tagName === "SCRIPT" || n.tagName === "STYLE" || n.tagName === "TEMPLATE") return;
      const label = n.getAttribute("aria-label");
      if (label && squash(label)) {
        parts.push(` ${label} `);
        return;
      }
      if (n.tagName === "IMG" || (n.tagName === "INPUT" && (n as HTMLInputElement).type === "image")) {
        parts.push(` ${n.getAttribute("alt") ?? ""} `);
        return;
      }
      if (n.tagName.toLowerCase() === "title" && n.parentElement?.tagName.toLowerCase() === "svg") {
        parts.push(` ${n.textContent ?? ""} `);
        return;
      }
      for (const c of Array.from(n.childNodes)) visit(c);
    };
    for (const c of Array.from(el.childNodes)) visit(c);
    return squash(parts.join(" "));
  };
  const labelledBy = (el: Element): string => {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    return squash(ids.split(/\s+/).map((id) => { const t = byId(id); return t ? (t.getAttribute("aria-label") || t.textContent || "") : ""; }).join(" "));
  };
  /** A native field's label: label[for], a wrapping label, aria-labelledby, aria-label, title. */
  const fieldLabel = (el: Element): string => {
    const named = labelledBy(el) || squash(el.getAttribute("aria-label")) ;
    if (named) return named;
    const labels = (el as HTMLInputElement).labels;
    if (labels) for (const l of Array.from(labels)) { const t = contentText(l); if (t) return t; }
    return squash(el.getAttribute("title"));
  };
  const NAME_FROM_CONTENT = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "option", "treeitem", "cell", "heading"]);
  /** A control's accessible name, close to how a browser works it out. */
  const controlName = (el: Element, role: string): string => {
    const named = labelledBy(el) || squash(el.getAttribute("aria-label"));
    if (named) return named;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const t = (el as HTMLInputElement).type;
      if (t === "submit") return squash((el as HTMLInputElement).value) || "Submit";
      if (t === "reset") return squash((el as HTMLInputElement).value) || "Reset";
      if (t === "button") return squash((el as HTMLInputElement).value) || squash(el.getAttribute("title"));
      if (t === "image") return squash(el.getAttribute("alt")) || squash((el as HTMLInputElement).value) || squash(el.getAttribute("title"));
      return fieldLabel(el) || squash(el.getAttribute("placeholder"));
    }
    if (tag === "SELECT" || tag === "TEXTAREA") return fieldLabel(el) || squash(el.getAttribute("placeholder"));
    const labels = (el as HTMLButtonElement).labels;
    if (labels) for (const l of Array.from(labels)) { const t = contentText(l); if (t) return t; }
    if (NAME_FROM_CONTENT.has(role)) {
      const t = contentText(el);
      if (t) return t;
    }
    return squash(el.getAttribute("title"));
  };
  const ROLE_CONTROLS = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton"]);
  /** A control's role, or "" for an element that isn't one. */
  const roleOf = (el: Element): string => {
    const explicit = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0] ?? "";
    if (explicit) return ROLE_CONTROLS.has(explicit) ? explicit : "";
    const tag = el.tagName;
    if (tag === "BUTTON") return "button";
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : "";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const t = (el as HTMLInputElement).type;
      if (t === "hidden") return "";
      if (t === "submit" || t === "reset" || t === "button" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      return "textbox";
    }
    if (tag === "SUMMARY") return "button";
    return "";
  };
  /** A native form field (input that isn't a button, select, textarea): it gets the label rules, not no_name. */
  const isField = (el: Element): boolean => {
    if (el.hasAttribute("role")) return false;
    if (el.tagName === "SELECT" || el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return !["hidden", "submit", "button", "image", "reset"].includes((el as HTMLInputElement).type);
  };
  /** A few words that point at an element with no name: its id, or a class, or what is inside it. */
  const hint = (el: Element): string => {
    if (el.id) return `#${el.id}`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    if (cls) return `.${cls}`;
    if (el.querySelector("svg")) return "with an icon";
    if (el.querySelector("img")) return "with an image";
    return "";
  };
  const describe = (role: string, name: string, el: Element): string => (name ? `${role} "${name}"` : `${role}${hint(el) ? ` ${hint(el)}` : ""}`);

  // no_lang
  const lang = (document.documentElement.getAttribute("lang") ?? "").trim();
  if (!lang) found.push({ kind: "no_lang", role: "page", what: "the page doesn't say its language" });
  else if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) found.push({ kind: "no_lang", role: "page", what: `lang="${lang}" isn't a language` });

  const targets: { el: Element; r: DOMRect; small: boolean; what: string }[] = [];
  const headings: { level: number; text: string }[] = [];
  const ids = new Map<string, number>();

  for (let i = 0; i < els.length; i++) {
    if ((i & 255) === 0 && performance.now() - started > limits.budgetMs) return { found, cut: true };
    const el = els[i]!;
    // A copy the page hides (a mobile menu's, with display:none) isn't counted: only ids on show twice.
    if (el.id && !el.closest("defs") && !hidden(el) && (el as HTMLElement).checkVisibility?.() !== false) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    const tag = el.tagName;
    const explicitRole = (el.getAttribute("role") ?? "").trim().split(/\s+/)[0] ?? "";

    // Headings
    const hn = /^H([1-6])$/.exec(tag);
    if ((hn && !explicitRole) || explicitRole === "heading") {
      if (visible(el)) {
        const level = explicitRole === "heading" ? Number(el.getAttribute("aria-level")) || 2 : Number(hn![1]);
        headings.push({ level, text: contentText(el) });
      }
      continue;
    }

    // Images
    if (tag === "IMG" || (tag === "INPUT" && (el as HTMLInputElement).type === "image") || explicitRole === "img") {
      if (explicitRole === "presentation" || explicitRole === "none") continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const named = labelledBy(el) || squash(el.getAttribute("aria-label")) || squash(el.getAttribute("title"));
      const ok = explicitRole === "img" && tag !== "IMG" ? !!named : el.hasAttribute("alt") || !!named;
      if (!ok) {
        const raw = el.getAttribute("src") ?? "";
        const src = raw.startsWith("data:") ? "" : (raw.split(/[?#]/)[0]!.split("/").pop() ?? "");
        found.push({ kind: "img_no_alt", role: "img", what: `image${src ? ` "${src}"` : hint(el) ? ` ${hint(el)}` : ""}` });
      }
      if (tag !== "INPUT") continue;
    }

    const role = roleOf(el);
    if (!role) continue;
    if (!visible(el)) continue;
    const name = controlName(el, role);

    if (isField(el)) {
      const label = fieldLabel(el);
      if (!label) {
        const ph = squash(el.getAttribute("placeholder"));
        if (ph) found.push({ kind: "placeholder_only", role, what: `${role} with placeholder "${ph}"` });
        else found.push({ kind: "field_no_label", role, what: describe(role, "", el) });
      }
    } else if (!name) {
      found.push({ kind: "no_name", role, what: describe(role, "", el) });
    }

    // Targets for 2.5.8. A native checkbox or radio the page hasn't sized is the browser's own size (exempt).
    if (role === "textbox" || role === "searchbox") {
      // Text fields count as targets for spacing, never as small ones themselves.
      targets.push({ el, r: el.getBoundingClientRect(), small: false, what: "" });
      continue;
    }
    const r = el.getBoundingClientRect();
    // Visually hidden (1 or 2 pixels, clipped: a "Skip to content" link until it has focus): not a target to point at.
    if (r.width <= 2 || r.height <= 2) continue;
    let small = r.width < 24 || r.height < 24;
    if (small && tag === "INPUT" && ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
      const st = (el as HTMLElement).style;
      if (!st.width && !st.height) small = false;
    }
    if (small && role === "link") {
      // Inline: a link inside a sentence (its parent's text is longer than its own).
      // The block it sits in (past inline wrappers such as <b> or <span>) has text beside it.
      const own = squash(el.textContent);
      let block = el.parentElement;
      for (let k = 0; block && k < 6 && getComputedStyle(block).display.startsWith("inline"); k++) block = block.parentElement;
      const around = squash(block?.textContent);
      if (around.length > own.length && getComputedStyle(el).display.startsWith("inline")) small = false;
    }
    targets.push({ el, r, small, what: describe(role, name, el) });
  }

  // Small targets, with the spacing exception: a 24px circle on each small target's centre must not
  // touch another target, or another small target's circle.
  const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const distToRect = (p: { x: number; y: number }, r: DOMRect) => {
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    return Math.hypot(dx, dy);
  };
  for (const t of targets) {
    if (!t.small) continue;
    const c = centre(t.r);
    const crowded = targets.some((o) => {
      if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) return false;
      if (distToRect(c, o.r) < 12) return true;
      if (o.small) {
        const oc = centre(o.r);
        return Math.hypot(c.x - oc.x, c.y - oc.y) < 24;
      }
      return false;
    });
    if (crowded) found.push({ kind: "small_target", role: "", what: `${t.what} (${Math.round(t.r.width)}x${Math.round(t.r.height)})` });
  }

  // Headings: a main heading, and no level skipped going down.
  if (headings.length && !headings.some((h) => h.level === 1)) found.push({ kind: "heading_order", role: "heading", what: "the page has no main heading (h1)" });
  else if (!headings.length) found.push({ kind: "heading_order", role: "heading", what: "the page has no headings at all" });
  for (let k = 1; k < headings.length; k++) {
    const a = headings[k - 1]!, b = headings[k]!;
    if (b.level > a.level + 1) found.push({ kind: "heading_order", role: "heading", what: `h${a.level} then h${b.level} "${b.text}"` });
  }

  for (const [id, n] of ids) if (n > 1) found.push({ kind: "duplicate_id", role: "", what: `id "${id}" (${n} times)` });

  return { found, cut };
}

/** How many unnamed controls of each role Chromium's own accessibility tree lists. */
export function unnamedInTree(tree: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of tree.split("\n")) {
    const m = /^\s*- ([a-z]+)(\s+"|\s|:|$)/.exec(line);
    if (!m || m[2]!.trim() === '"') continue;
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

/** A page's path as shown: no query, no secrets, each path part that reads like a token replaced. */
export function pagePath(url: string, mask: (s: string) => string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return mask(url.split(/[?#]/)[0]!.slice(0, 80));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return mask(`${u.protocol}${u.pathname}`.slice(0, 80));
  const parts = u.pathname.split("/").map((p) => (/^(?=.*\d)(?=.*[a-z])[\w~+=%.-]{20,}$/i.test(p) ? "{token}" : p));
  return mask(parts.join("/") || "/");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Scans one page. Every word that leaves the page goes through `mask`, and `what` is clipped to 60
 * characters. It never throws: a scan that can't finish says why in `error`.
 */
export async function scanPage(page: Page, mask: (s: string) => string, o: ScanOptions = {}): Promise<A11yPageScan> {
  const started = Date.now();
  const timeoutMs = o.timeoutMs ?? A11Y_TIMEOUT_MS;
  const path = pagePath(page.url(), mask);
  const base = { page: path, findings: [] as A11yFinding[], more: {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), timeoutMs); });
  try {
    const walk = page.evaluate(walkPage, { maxElements: o.maxElements ?? A11Y_MAX_ELEMENTS, budgetMs: Math.max(50, timeoutMs - 200) });
    walk.catch(() => undefined);
    const got = await Promise.race([walk, late]);
    if (got === "late") return { ...base, error: `the scan took too long (over ${(timeoutMs / 1000).toFixed(1)} seconds)`, ms: Date.now() - started };
    let raw = got.found;
    // A control the walk thinks has no name is kept only when Chromium's own tree agrees.
    if (raw.some((r) => r.kind === "no_name")) {
      const left = Math.max(100, timeoutMs - (Date.now() - started));
      const tree = o.tree ?? (await Promise.race([page.ariaSnapshot({ mode: "ai", timeout: left }).catch(() => ""), late.then(() => "")]));
      if (tree) {
        const unnamed = unnamedInTree(tree);
        raw = raw.filter((r) => {
          if (r.kind !== "no_name") return true;
          const n = unnamed.get(r.role) ?? 0;
          if (n <= 0) return false;
          unnamed.set(r.role, n - 1);
          return true;
        });
      }
    }
    const findings: A11yFinding[] = [];
    const more: Partial<Record<A11yKind, number>> = {};
    const seen: Partial<Record<A11yKind, number>> = {};
    for (const r of raw) {
      const n = (seen[r.kind] = (seen[r.kind] ?? 0) + 1);
      if (n > A11Y_PER_KIND) {
        more[r.kind] = (more[r.kind] ?? 0) + 1;
        continue;
      }
      findings.push({ kind: r.kind, what: clip(mask(r.what.replace(/\s+/g, " ").trim()), 60), wcag: A11Y_KINDS[r.kind].wcag, page: path });
    }
    return { page: path, findings, more, ...(got.cut ? { cut: true as const } : {}), ms: Date.now() - started };
  } catch (error) {
    const said = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    return { ...base, error: mask(`the page couldn't be scanned: ${clip(said, 120)}`), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** What a run's result carries (TestResult.accessibility). */
export interface A11yResult {
  pages: number;
  /** The pages scanned, as pagePath gives them (no query, tokens taken out). */
  paths?: string[];
  /** How long each page's scan took, in ms, in the order scanned. */
  ms?: number[];
  findings: A11yFinding[];
  /** Findings past the per-page, per-kind cap, counted. */
  more?: { page: string; kind: A11yKind; n: number }[];
  /** Pages with more elements than were walked. */
  cut?: number;
  /** Pages whose scan couldn't finish, and why. */
  failed?: { page: string; why: string }[];
}

/** The pages a run reached, each scanned once (the first time), at most A11Y_MAX_PAGES. */
export class A11yLog {
  readonly scans: A11yPageScan[] = [];
  private readonly paths = new Set<string>();
  private readonly mask: (s: string) => string;
  private readonly max: number;
  constructor(mask: (s: string) => string = (s) => s, max = A11Y_MAX_PAGES) {
    this.mask = mask;
    this.max = max;
  }

  /** Whether this page would be scanned now: a path not seen yet, and room left. */
  wants(url: string): boolean {
    return this.scans.length < this.max && !this.paths.has(pagePath(url, this.mask));
  }

  /** Scans the page if its path is new and there's room; otherwise does nothing. */
  async scan(page: Page, o: ScanOptions = {}): Promise<A11yPageScan | undefined> {
    if (!this.wants(page.url())) return undefined;
    const key = pagePath(page.url(), this.mask);
    this.paths.add(key);
    const s = await scanPage(page, this.mask, o);
    this.scans.push(s);
    return s;
  }

  /** Every issue counted, the capped ones too. */
  counts(): Partial<Record<A11yKind, number>> {
    const c: Partial<Record<A11yKind, number>> = {};
    for (const s of this.scans) {
      for (const f of s.findings) c[f.kind] = (c[f.kind] ?? 0) + 1;
      for (const [k, n] of Object.entries(s.more) as [A11yKind, number][]) c[k] = (c[k] ?? 0) + n;
    }
    return c;
  }

  total(): number {
    return Object.values(this.counts()).reduce((a, b) => a + (b ?? 0), 0);
  }

  /** "7 issues on 2 pages: 3 controls with no name, 2 images with no text alternative, …" */
  summary(): string {
    return a11ySummary(this.result());
  }

  result(): A11yResult {
    const more = this.scans.flatMap((s) => (Object.entries(s.more) as [A11yKind, number][]).map(([kind, n]) => ({ page: s.page, kind, n })));
    const cut = this.scans.filter((s) => s.cut).length;
    const failed = this.scans.filter((s) => s.error).map((s) => ({ page: s.page, why: s.error! }));
    return {
      pages: this.scans.length,
      ...(this.scans.length ? { paths: this.scans.map((x) => x.page), ms: this.scans.map((x) => x.ms) } : {}),
      findings: this.scans.flatMap((s) => s.findings),
      ...(more.length ? { more } : {}),
      ...(cut ? { cut } : {}),
      ...(failed.length ? { failed } : {}),
    };
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A result in one sentence: "7 issues on 2 pages: 3 controls with no name, …", or "No accessibility issues found on 2 pages". */
export function a11ySummary(r: A11yResult): string {
  const counts: Partial<Record<A11yKind, number>> = {};
  for (const f of r.findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  for (const m of r.more ?? []) counts[m.kind] = (counts[m.kind] ?? 0) + m.n;
  const total = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
  const pages = plural(r.pages, "page", "pages");
  if (!r.pages) return "No pages were scanned for accessibility";
  const tail = [r.cut ? `${plural(r.cut, "page was", "pages were")} only scanned for the first ${A11Y_MAX_ELEMENTS.toLocaleString("en")} elements` : "", r.failed?.length ? `${plural(r.failed.length, "page", "pages")} couldn't be scanned` : ""].filter(Boolean);
  const after = tail.length ? ` (${tail.join("; ")})` : "";
  if (!total) return `No accessibility issues found on ${pages}${after}`;
  const parts = A11Y_ORDER.filter((k) => counts[k]).map((k) => plural(counts[k]!, A11Y_KINDS[k].one, A11Y_KINDS[k].many));
  return `${plural(total, "issue", "issues")} on ${pages}: ${parts.join(", ")}${after}`;
}

/** The terminal's one line, after friction: "Accessibility: 7 issues on 2 pages (see the report)". */
export function a11yLine(r: A11yResult): string {
  const s = a11ySummary(r);
  const short = s.split(":")[0]!;
  return /^No /.test(s) ? `Accessibility: ${s.charAt(0).toLowerCase()}${s.slice(1)}` : `Accessibility: ${short} (see the report)`;
}

/** One kind of issue, ready to show: its heading, WCAG reference and why it matters, its findings, and the capped rest per page. */
export interface A11yGroup {
  kind: A11yKind;
  title: string;
  wcag: string;
  why: string;
  items: { what: string; page: string }[];
  more: { page: string; n: number }[];
}

/** A result's findings grouped by kind, in A11Y_ORDER: what the report, the web view and the site page show. */
export function a11yGroups(r: A11yResult | undefined): A11yGroup[] {
  if (!r?.pages) return [];
  return A11Y_ORDER.filter((k) => r.findings.some((f) => f.kind === k) || r.more?.some((m) => m.kind === k)).map((kind) => ({
    kind,
    title: A11Y_KINDS[kind].many.replace(/^./, (x) => x.toUpperCase()),
    wcag: A11Y_KINDS[kind].wcag,
    why: A11Y_KINDS[kind].why,
    items: r.findings.filter((f) => f.kind === kind).map((f) => ({ what: f.what, page: f.page })),
    more: (r.more ?? []).filter((m) => m.kind === kind).map((m) => ({ page: m.page, n: m.n })),
  }));
}

/**
 * Several runs' scans as one, for a whole site (the explore page): a page reached by more than one run
 * counts once, from the first run that scanned it.
 */
export function a11yAcross(results: (A11yResult | undefined)[]): A11yResult | undefined {
  const seen = new Set<string>();
  const out: A11yResult = { pages: 0, findings: [] };
  for (const r of results) {
    if (!r?.pages) continue;
    // A result from before paths were kept counts its pages as it said.
    const named = r.paths ?? [...new Set([...r.findings.map((f) => f.page), ...(r.more ?? []).map((m) => m.page), ...(r.failed ?? []).map((f) => f.page)])];
    const fresh = named.filter((p) => !seen.has(p));
    out.pages += r.paths ? fresh.length : r.pages - (named.length - fresh.length);
    out.findings.push(...r.findings.filter((f) => fresh.includes(f.page)));
    const more = (r.more ?? []).filter((m) => fresh.includes(m.page));
    if (more.length) out.more = [...(out.more ?? []), ...more];
    const failed = (r.failed ?? []).filter((f) => fresh.includes(f.page));
    if (failed.length) out.failed = [...(out.failed ?? []), ...failed];
    if (r.cut) out.cut = (out.cut ?? 0) + r.cut;
    for (const p of fresh) seen.add(p);
  }
  if (!out.pages) return undefined;
  out.paths = [...seen];
  return out;
}

/** The notes under a result: pages only partly walked, and pages whose scan couldn't finish. */
export function a11yNotes(r: A11yResult): string[] {
  return [
    r.cut ? `${r.cut === 1 ? "One page was" : `${r.cut} pages were`} only scanned for its first ${A11Y_MAX_ELEMENTS.toLocaleString("en")} elements.` : "",
    ...(r.failed ?? []).map((f) => `${f.page} couldn't be scanned: ${f.why}.`),
  ].filter(Boolean);
}
