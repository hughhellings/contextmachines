/**
 * A quick look at a site, with no AI, before tasks are suggested for it: the home page opened as a
 * visitor (a consent wall answered "no"), then what a person sees first, read from the page: its
 * title, headings, the main navigation's links, search boxes and main buttons. Then a few of the
 * navigation's pages on the same site, each read the same way. Facts only, kept small, about 30s.
 * All of it is the site's text: untrusted, said to the AI as such (cli/test-tasks.ts).
 */
import type { Browser } from "playwright";
import { guardSite, onSite, refusedName, refusedSignedOut } from "./act.ts";
import { botWall, BotWalled, WallWatch } from "./botwall.ts";
import { maskOptions } from "./maskshot.ts";
import { launch, SIZE } from "./record.ts";
import { notFound, openAsVisitor, shortAddress } from "./run.ts";

export interface PageLook {
  url: string;
  title: string;
  headings: string[];
  /** Links in the page's navigation (header, nav, menus), on the same site: words and address. */
  nav: { words: string; url: string }[];
  /** Search boxes, by the name a person reads on them. */
  search: string[];
  /** Buttons a person sees first, by their words. */
  buttons: string[];
  /** Whether a video player shows. */
  video: boolean;
}

export interface SiteLook {
  url: string;
  host: string;
  home: PageLook;
  /** A few of the navigation's pages, read the same way. */
  pages: PageLook[];
  /** The consent wall answered on the way in, by what was pressed. */
  consent?: string;
  /**
   * The address asked for showed "not found" to a visitor (a private chart layout, a page gone), so
   * the look, and the tasks, are of the site's home page (`url`) instead: what was asked, and what it said.
   */
  movedFrom?: { url: string; said: string };
  ms: number;
}

/** Runs in the page: what a person sees first. Self-contained. */
function readPage(): Omit<PageLook, "url" | "title"> {
  const words = (el: Element | null | undefined) => (el?.getAttribute("aria-label") || (el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const unique = (list: string[], n: number, max = 80) => [...new Set(list.filter((w) => w && w.length <= max))].slice(0, n);
  const headings = unique([...document.querySelectorAll("h1, h2, h3, [role=heading]")].filter(shown).map(words), 15, 100);
  const navLinks = [...document.querySelectorAll("header a[href], nav a[href], [role=navigation] a[href], [role=menubar] a[href], aside a[href], [role=banner] a[href]")].filter(shown);
  const seen = new Set<string>();
  const nav: { words: string; url: string }[] = [];
  for (const a of navLinks) {
    const w = words(a);
    const url = (a as HTMLAnchorElement).href;
    if (!w || w.length > 60 || seen.has(url) || !/^https?:/.test(url)) continue;
    seen.add(url);
    nav.push({ words: w, url });
    if (nav.length >= 30) break;
  }
  const search = unique([...document.querySelectorAll("input[type=search], [role=searchbox], input[name=q], input[name=search], input[name=search_query], form[role=search] input:not([type=hidden])")].filter(shown).map((el) => (el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || el.getAttribute("title") || (el as HTMLInputElement).name || "Search").trim()), 4);
  const buttons = unique([...document.querySelectorAll("main button, main [role=button], [role=main] button, header button, button")].filter(shown).map(words), 20, 50);
  const video = [...document.querySelectorAll("video")].some(shown);
  return { headings, nav, search, buttons, video };
}

/** How long the whole look may take, and how many of the navigation's pages it opens. */
export const LOOK_MS = 30_000;
export const LOOK_PAGES = 3;

/**
 * Looks at a site as a visitor: the home page, then up to `pages` of its navigation's pages on the
 * same site (never one whose words read like signing in, paying or deleting). Throws CouldNotRun when
 * the home page doesn't open, and BotWalled when a bot check stands in front of it and doesn't clear
 * by itself within a short wait (botwall.ts): nothing is then suggested, and nothing runs. A nav page
 * behind a bot check is skipped, quietly.
 */
export async function lookAt(asked: string, o: { browser?: Browser; headed?: boolean; allowHosts?: string[]; pages?: number; ms?: number; wallWaitMs?: number } = {}): Promise<SiteLook> {
  const begun = Date.now();
  let url = asked;
  const until = begun + (o.ms ?? LOOK_MS);
  const allowHosts = o.allowHosts ?? [];
  const browser = o.browser ?? (await launch(o.headed ?? false));
  const context = await browser.newContext({ viewport: SIZE, acceptDownloads: false, serviceWorkers: "block" });
  try {
    await context.clearPermissions();
    const page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    const consent = { open: false };
    await guardSite(page, url, allowHosts, { consent: () => consent.open });
    const watch = new WallWatch(o.wallWaitMs);
    let rejected = await openAsVisitor(page, url, consent, watch);
    let wall = await watch.stands(page);
    // A start address that shows "not found" to a signed-out visitor (a private layout, a removed
    // page) has no tasks of its own: the site's home page is looked at, and suggested for, instead.
    let movedFrom: SiteLook["movedFrom"];
    const origin = `${new URL(url).origin}/`;
    const gone = wall ? undefined : await notFound(page);
    if (gone && withoutQuery(url) !== origin) {
      movedFrom = { url, said: gone.replace(/\s+/g, " ").trim().slice(0, 80) };
      url = origin;
      rejected = (await openAsVisitor(page, url, consent, watch)) ?? rejected;
      wall = await watch.stands(page);
    }
    if (wall) {
      const shot = await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000, ...maskOptions(page) }).catch(() => undefined);
      throw new BotWalled(new URL(url).host, wall, shot);
    }
    const read = async (): Promise<PageLook> => ({ url: page.url(), title: await page.title().catch(() => ""), ...(await page.evaluate(readPage).catch(() => ({ headings: [], nav: [], search: [], buttons: [], video: false }))) });
    const home = await read();
    const pages: PageLook[] = [];
    const want = o.pages ?? LOOK_PAGES;
    const homeAt = new URL(home.url);
    const targets = home.nav.filter((n) => {
      const to = new URL(n.url);
      return onSite(n.url, url, allowHosts) && `${to.pathname}${to.search}` !== `${homeAt.pathname}${homeAt.search}` && !refusedName(n.words) && !refusedSignedOut(n.words) && !/\b(help|privacy|terms|cookies?|legal|about us|contact|careers|jobs|press|advertis\w*|policy|policies)\b/i.test(n.words);
    });
    for (const target of targets.slice(0, want)) {
      if (Date.now() + 8000 > until) break;
      const ok = await page.goto(target.url, { timeout: Math.min(15_000, until - Date.now()), waitUntil: "domcontentloaded" }).then(() => true, () => false);
      if (!ok || !onSite(page.url(), url, allowHosts)) continue;
      await page.waitForTimeout(800);
      if (await botWall(page)) continue;
      pages.push(await read());
    }
    return { url, host: new URL(url).host, home, pages, ...(rejected ? { consent: rejected } : {}), ...(movedFrom ? { movedFrom } : {}), ms: Date.now() - begun };
  } finally {
    await context.close().catch(() => {});
    if (!o.browser) await browser.close().catch(() => {});
  }
}

/** An address without its query and fragment. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The one line said when the look moved to the home page: 'www.example.com/chart/x/ shows "Chart Not Found" to a signed-out visitor; using https://www.example.com/ instead'. */
export function movedLine(look: Pick<SiteLook, "url" | "movedFrom">): string | undefined {
  return look.movedFrom ? `${shortAddress(look.movedFrom.url)} shows "${look.movedFrom.said.slice(0, 60)}" to a signed-out visitor; using ${look.url} instead` : undefined;
}

/** A page's address as the AI is told it: no query and no fragment, where a token or a person's words may be. */
function addressOnly(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/** The look in plain lines, as the AI reads it (untrusted: wrapped by whoever asks). Capped in size. */
export function lookText(look: SiteLook, cap = 6000): string {
  const pageLines = (p: PageLook, n: number) => [
    `${n ? `Page ${n}` : "Home page"}: "${p.title}" at ${addressOnly(p.url)}`,
    ...(p.headings.length ? [`  Headings: ${p.headings.join(" | ")}`] : []),
    ...(p.search.length ? [`  Search boxes: ${p.search.join(" | ")}`] : []),
    ...(p.nav.length ? [`  Navigation: ${p.nav.map((l) => l.words).join(" | ")}`] : []),
    ...(p.buttons.length ? [`  Buttons: ${p.buttons.join(" | ")}`] : []),
    ...(p.video ? ["  A video player shows."] : []),
  ];
  const text = [pageLines(look.home, 0), ...look.pages.map((p, i) => pageLines(p, i + 1))].flat().join("\n");
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}
