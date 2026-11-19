/**
 * E8 Discovery, "test the whole site": a crawl of the project's own origins that measures, page by
 * page, what is plainly broken, and files each as a finding with its evidence and its time in the
 * run's video. No AI is asked and nothing is judged: a broken link is a status code, a console error
 * is a line the page wrote, a dead button is a press after which nothing at all happened.
 *
 * Safety, the same as a test run's and stricter:
 * - The browser is fenced by act.ts guardSite (a navigation or redirect to another site is stopped
 *   before it is sent), and links are followed only to the project's exact origins.
 * - Only GET page loads are made. A link that reads like signing out, paying or deleting is not
 *   followed. A button is pressed only when act.ts's deny list (pay, buy, send, post, delete, bot
 *   check...) and the sign-in words let it, and never a form's submit.
 * - While a button is probed, any request it makes other than a GET is stopped before it is sent and
 *   counted ("it would have sent something"): a press in Discovery never writes to the site.
 * - A bot check is never answered: the crawl stops and says so.
 * Severity is not set here: the data lane's fixed rule table sets it (A3).
 */
import type { Browser, Page, Request, Response } from "playwright";
import { guardSite, refusedName, refusedSignedOut } from "./act.ts";
import { A11Y_KINDS, A11yLog } from "./a11y.ts";
import { botWall } from "./botwall.ts";
import { withoutSecrets } from "./cache.ts";
import { openDialog, pageErrors } from "./friction.ts";
import { record, type Recording } from "./record.ts";
import type { AppLogEntry, Evidence, ExploreFinding, ExploreLimits, ExploreReport, IssueOccurrence, RunId, TestId } from "../../../../cli/app/contracts.ts";

/** Discovery's defaults (APP-PLAN E8): 12 pages, 15 minutes, stop after 3 failed page loads in a row. */
export const EXPLORE_DEFAULTS: ExploreLimits = { maxSteps: 12, maxMinutes: 15, maxFailsInRow: 3 };
/** Buttons pressed on one page, at most. */
export const BUTTONS_PER_PAGE = 6;
/** How long a press is given to do anything at all. */
export const PRESS_WAIT_MS = 700;
/** Lines of site text are clipped to this (contracts: AppLogEntry.text). */
const TEXT_MAX = 300;

/** Words on a link that are never followed: signing out, and anything the deny list stops. */
const SIGNS_OUT = /\b(sign(ing)?[ -]?out|log(ging)?[ -]?(out|off))\b/i;
const SIGN_OUT_PATH = /\/(log[-_]?out|sign[-_]?out|log[-_]?off)\b/i;
/** A link's address that reads like doing something, not showing a page. */
const DOES_PATH = /\/(delete|destroy|remove|unsubscribe|cancel|checkout|pay|purchase|buy|order)\b/i;
/** A query name or value that asks for the same ("?action=delete", "?logout"). "order" is left out: "?sort=order" shows a page. */
const DOES_QUERY = /^(log[-_]?out|sign[-_]?out|log[-_]?off|delete|destroy|remove|unsubscribe|cancel|checkout|pay|purchase|buy)$/i;

/**
 * Why an address reads like signing out or doing something rather than showing a page, or nothing.
 * Read on the path and on the query, so "/users/sign_out" and "/item?action=delete" are both caught.
 * Used for links before they are followed, and for every request a pressed button makes (a GET can
 * sign out or delete as well as a POST can).
 */
export function doesSomething(u: string): string | undefined {
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return undefined;
  }
  if (SIGN_OUT_PATH.test(x.pathname)) return "it reads like signing out";
  if (DOES_PATH.test(x.pathname)) return "its address reads like doing something, not showing a page";
  for (const [k, v] of x.searchParams) if (DOES_QUERY.test(k) || DOES_QUERY.test(v)) return "its address reads like doing something, not showing a page";
  return undefined;
}

/** Hard ceilings on what a request may ask for, whatever it sends (a typo, a NaN, a null). */
export const EXPLORE_CEILINGS: ExploreLimits = { maxSteps: 200, maxMinutes: 120, maxFailsInRow: 50 };

/** The limits to use: each given one when it is a sane number, clamped to the ceilings; else the default. */
export function exploreLimits(given?: Partial<ExploreLimits>): ExploreLimits {
  const pick = (k: keyof ExploreLimits, least: number): number => {
    const v: unknown = given?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < least) return EXPLORE_DEFAULTS[k];
    return Math.min(EXPLORE_CEILINGS[k], k === "maxMinutes" ? v : Math.floor(v));
  };
  return { maxSteps: pick("maxSteps", 0), maxMinutes: pick("maxMinutes", 0), maxFailsInRow: pick("maxFailsInRow", 1) };
}

export interface ExplorePage {
  n: number;
  /** Path (masked, no query secrets). */
  path: string;
  title: string;
  status?: number;
  /** Seconds into the video when the page was opened. */
  at: number;
  /** Where it was linked from, and by what words. */
  from?: { path: string; words: string };
  /** On-origin links it has (paths), at most 50. */
  links: string[];
  /** Controls left alone on it, and why (the gate). */
  leftAlone: string[];
  /** It couldn't be opened: why. */
  failed?: string;
  /** A redirect to another site was stopped before it went: the guard's words. */
  stoppedOffSite?: string;
}

/** What Discovery gives back: the contract's report, plus the page map, the app log and a summary. */
export interface ExploreRun extends ExploreReport {
  pages: ExplorePage[];
  log: AppLogEntry[];
  /** Plain English, one paragraph. */
  summary: string;
  ms: number;
  /** The run's video in its folder, when one was kept. */
  video?: string;
  /** A bot check stood in front of a page: its name. The crawl stopped; it is never answered. */
  blocked?: string;
  /** Requests other than GET that a pressed button tried to send: stopped before they went. */
  writesHeld: number;
  /** Requests a pressed button sent on the person's own site (ExploreOptions.owned): fetch or XHR on its origins only. */
  writesSent?: number;
  /** Off-site navigations the guard stopped before they were sent (links and redirects). */
  offSiteStopped: number;
}

export type ExploreEvent =
  | { type: "phase"; words: string }
  | { type: "page"; n: number; path: string; at: number }
  | { type: "finding"; finding: ExploreFinding }
  | { type: "working"; n: number; words: string; at: number }
  | { type: "end"; report: ExploreRun };

export interface ExploreOptions {
  url: string;
  /** The project's origins ("http://127.0.0.1:3000"); the start URL's origin is always one. */
  origins?: string[];
  browser: Browser;
  /** The run's folder: video. */
  dir: string;
  limits?: Partial<ExploreLimits>;
  /** Hides values (--var, account values) in every word kept. */
  mask?: (s: string) => string;
  on?: (e: ExploreEvent) => void;
  signal?: AbortSignal;
  storageState?: string;
  noMedia?: boolean;
  /** Press buttons to find dead ones (default true). */
  pressButtons?: boolean;
  /** The recorded page, for the live screen. */
  onPage?: (page: Page) => void | Promise<void>;
  /**
   * The start host is the person's own (D12, and for production their yes, Q7). Then a press may send
   * the page's own requests (fetch or XHR, on the project's origins), so a server error behind a
   * button shows. Still only for a control the deny list lets through; never a form's submit, a page
   * load that isn't a GET, or a request whose address reads like signing out or deleting.
   */
  owned?: boolean;
}

/** A page that takes this long to open is filed as slow. */
export const SLOW_PAGE_MS = 3_000;

const clip = (s: string, n = TEXT_MAX) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** A page's identity for "seen": origin, path and query, no hash. */
const pageKey = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.search}`;
  } catch {
    return u;
  }
};

export async function explore(o: ExploreOptions): Promise<ExploreRun> {
  const limits = exploreLimits(o.limits);
  const mask = o.mask ?? ((s: string) => s);
  const origins = new Set([originOf(o.url), ...(o.origins ?? []).map(originOf)].filter(Boolean));
  const inOrigins = (u: string) => origins.has(originOf(u));
  const pathOf = (u: string) => {
    try {
      // withoutSecrets reads a whole address only: a bare path would come back with its ?token= in it.
      const x = new URL(withoutSecrets(new URL(u).href));
      const own = `${x.pathname}${x.search}`;
      return mask(origins.size > 1 ? `${x.origin}${own}` : own).slice(0, 200);
    } catch {
      return mask(u).slice(0, 200);
    }
  };
  /** Site text with every address in it read through withoutSecrets ("failed: https://…?access_token=…"), then masked. */
  const scrub = (s: string) => mask(s.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, (u) => withoutSecrets(u)).replace(/(^|[\s"'(])(\/[^\s"'<>?#]*\?[^\s"'<>)]+)/g, (_m, pre: string, rel: string) => pre + pathOf(new URL(rel, o.url).href)));
  const emit = (e: ExploreEvent) => {
    try {
      o.on?.(e);
    } catch {
      // A listener's error never stops the crawl.
    }
  };
  const begun = Date.now();
  const deadline = begun + limits.maxMinutes * 60_000;
  const findings: ExploreFinding[] = [];
  const log: AppLogEntry[] = [];
  const pages: ExplorePage[] = [];
  let offSiteNavigations = 0;
  let offSiteStopped = 0;
  let writesHeld = 0;
  /** Requests a press sent on an owned site (ExploreOptions.owned). */
  let writesSent = 0;
  let blocked: string | undefined;
  let stoppedBecause: ExploreReport["stoppedBecause"] = "done";
  let step = 0;

  emit({ type: "phase", words: "Opening the site" });
  const rec: Recording = await record(o.dir, o.browser, { ...(o.storageState ? { storageState: o.storageState } : {}), ...(o.noMedia ? { noMedia: true } : {}) });
  const { page, context } = rec;
  const extraHosts = [...origins].map((x) => new URL(x).host).filter((h) => h !== new URL(o.url).host);
  const offSite = await guardSite(page, o.url, extraHosts);
  if (o.onPage) await o.onPage(page);

  /** A finding, said once per kind + page + words. */
  const said = new Set<string>();
  const find = (kind: ExploreFinding["kind"], title: string, evidence: Omit<Evidence, "source" | "kind" | "text"> & { text: string }) => {
    const text = clip(scrub(evidence.text));
    const key = `${kind}\n${evidence.url ?? ""}\n${text}`;
    if (said.has(key)) return;
    const finding: ExploreFinding = { kind, title: clip(scrub(title), 120), step, at: rec.at(), evidence: { ...evidence, source: "measured", kind, text } };
    if (held) return void held.push(finding);
    keep(finding, key);
  };
  const keep = (finding: ExploreFinding, key = `${finding.kind}\n${finding.evidence.url ?? ""}\n${finding.evidence.text}`) => {
    if (said.has(key)) return;
    said.add(key);
    findings.push(finding);
    emit({ type: "finding", finding });
  };
  /**
   * While a button is pressed, findings wait here: when the press had a write stopped by us, the
   * errors that follow (a "Failed to fetch" the page didn't catch) are our doing, never the site's.
   */
  let held: ExploreFinding[] | undefined;
  const logLine = (e: Omit<AppLogEntry, "step" | "at">) => {
    const text = clip(scrub(e.text));
    const last = log.at(-1);
    if (last && last.kind === e.kind && last.text === text && last.step === step && last.url === e.url) {
      last.count = (last.count ?? 1) + 1;
      return;
    }
    log.push({ ...e, text, step, at: rec.at() });
  };

  // What the page did, measured: the app log, and findings from it.
  /** Navigation responses of the main frame are the page's own status, not a resource's. */
  const mainDoc = (req: Request) => req.isNavigationRequest() && req.frame() === page.mainFrame();
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    // The browser's own line for a failed resource repeats what the network listener records.
    if (/^Failed to load resource\b/.test(m.text())) return;
    const where = pathOf(page.url());
    logLine({ kind: "console", level: m.type() === "error" ? "error" : "warn", text: m.text(), url: where });
    if (m.type() === "error") find("console_error", `Console error on ${where}`, { text: m.text(), url: where });
  });
  page.on("pageerror", (err) => {
    const where = pathOf(page.url());
    const text = `${err.name}: ${err.message}`.split("\n")[0]!;
    logLine({ kind: "pageerror", level: "error", text, url: where });
    find("page_error", `Uncaught error on ${where}`, { text, url: where });
  });
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "failed";
    // The guard's own stops and loads cut short by the next navigation are not the site's failures.
    if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(failure) || !inOrigins(req.url()) || mainDoc(req)) return;
    const where = pathOf(req.url());
    logLine({ kind: "request_failed", level: "error", text: `${req.method()} ${where} failed: ${failure}`, url: where, method: req.method() });
    find("http_error", `${req.method()} ${where} failed`, { text: `${req.method()} ${where} failed: ${failure}`, url: where, method: req.method() });
  });
  page.on("response", (res: Response) => {
    const req = res.request();
    if (!inOrigins(res.url()) || mainDoc(req) || res.status() < 400) return;
    const where = pathOf(res.url());
    const line = `${req.method()} ${where} answered ${res.status()}`;
    logLine({ kind: "http_error", level: res.status() >= 500 ? "error" : "warn", text: line, url: where, method: req.method(), status: res.status() });
    find("http_error", `${res.status()} on ${req.method()} ${where}`, { text: `${line} (on ${pathOf(page.url())})`, url: where, method: req.method(), status: res.status() });
  });
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    const u = f.url();
    if (u === "about:blank" || u.startsWith("chrome-error:")) return;
    if (!inOrigins(u)) offSiteNavigations++;
    else logLine({ kind: "navigation", level: "info", text: `Opened ${pathOf(u)}`, url: pathOf(u) });
  });
  /** Presses being probed: a pop-up, a file picker or a request each count as "did something". */
  const probe = { on: false, requests: 0, dialogs: 0, choosers: 0, popups: 0 };
  page.on("dialog", (d) => {
    if (probe.on) probe.dialogs++;
    void d.dismiss().catch(() => {});
  });
  page.on("filechooser", () => {
    if (probe.on) probe.choosers++;
  });
  page.on("request", () => {
    if (probe.on) probe.requests++;
  });
  context.on("page", (p) => {
    if (p !== page && probe.on) probe.popups++;
  });
  // On top of the guard: while a press is probed, nothing but a GET is sent anywhere.
  await context.route("**/*", (route) => {
    // A GET that reads like signing out or deleting ("/account/remove", "?action=delete") is stopped too.
    const req = route.request();
    if (probe.on && (req.method() !== "GET" || doesSomething(req.url()))) {
      if (o.owned && (req.resourceType() === "fetch" || req.resourceType() === "xhr") && inOrigins(req.url()) && !doesSomething(req.url())) {
        writesSent++;
        return route.fallback();
      }
      writesHeld++;
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });

  const a11y = new A11yLog(mask);
  const queue: { url: string; from?: { path: string; words: string } }[] = [{ url: o.url }];
  const queued = new Set([pageKey(o.url)]);
  let failsInRow = 0;

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
      if (step >= limits.maxSteps) {
        stoppedBecause = "steps";
        break;
      }
      const next = queue.shift()!;
      step++;
      const at = rec.at();
      const entry: ExplorePage = { n: step, path: pathOf(next.url), title: "", at, links: [], leftAlone: [], ...(next.from ? { from: next.from } : {}) };
      pages.push(entry);
      emit({ type: "page", n: step, path: entry.path, at });
      let res: Response | null = null;
      const opening = Date.now();
      try {
        // A stopped redirect leaves an error page loading behind it: one more try when it cut in.
        res = await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(async (error: unknown) => {
          if (!/interrupted by another navigation/.test(String(error))) throw error;
          await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
          return page.goto(next.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        });
      } catch (error) {
        const stopped = offSite();
        if (stopped) {
          // A link that leads off the site (a redirect): stopped before it was sent. Not the site's failure.
          offSiteStopped++;
          entry.stoppedOffSite = clip(mask(stopped), 200);
          await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
          continue;
        }
        entry.failed = clip(mask(error instanceof Error ? error.message.split("\n")[0]! : String(error)), 200);
        if (++failsInRow >= limits.maxFailsInRow) {
          stoppedBecause = "fails_in_row";
          break;
        }
        continue;
      }
      const stopped = offSite();
      if (stopped) {
        offSiteStopped++;
        entry.stoppedOffSite = clip(mask(stopped), 200);
      }
      entry.status = res?.status();
      // A page that is slow to answer is friction a person feels: measured from the request to its first paintable answer.
      const openMs = Date.now() - opening;
      if (res && res.status() < 400 && openMs >= SLOW_PAGE_MS) find("friction", `Slow page: ${entry.path} took ${(openMs / 1000).toFixed(1)} s to open`, { text: `GET ${entry.path} took ${(openMs / 1000).toFixed(1)} s to answer`, url: entry.path, friction: "slow" });
      await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
      // Late console lines and fetches a page makes as it starts.
      await page.waitForTimeout(400).catch(() => {});
      entry.title = clip(scrub(await page.title().catch(() => "")), 120);
      if (!inOrigins(page.url())) {
        // Never expected (the guard stops it first); counted, and the crawl goes no further from here.
        continue;
      }
      if (res && res.status() >= 400) {
        const status = res.status();
        const fromWords = next.from ? ` (the link "${next.from.words}" on ${next.from.path})` : "";
        find("http_error", next.from ? `Broken link: ${entry.path} answers ${status}` : `${entry.path} answers ${status}`, { text: `GET ${entry.path} answered ${status}${fromWords}`, url: entry.path, method: "GET", status });
        logLine({ kind: "http_error", level: status >= 500 ? "error" : "warn", text: `GET ${entry.path} answered ${status}`, url: entry.path, method: "GET", status });
        if (status >= 500 && ++failsInRow >= limits.maxFailsInRow) {
          stoppedBecause = "fails_in_row";
          break;
        }
        continue;
      }
      failsInRow = 0;
      const wall = await botWall(page);
      if (wall) {
        blocked = wall;
        stoppedBecause = "done";
        break;
      }
      // Accessibility, measured once per path.
      emit({ type: "working", n: step, words: "Checking accessibility", at: rec.at() });
      const scan = await a11y.scan(page);
      for (const f of scan?.findings ?? []) find("a11y", `${A11Y_KINDS[f.kind].one.replace(/^./, (c) => c.toUpperCase())}: ${f.what}`, { text: `${f.what} (${f.wcag}) on ${f.page}`, url: f.page, a11y: f });
      // Friction the page shows by itself: a validation error, a pop-up over it.
      for (const e of await pageErrors(page)) find("friction", `The page shows an error: ${e}`, { text: e, url: entry.path, friction: "validation" });
      const dialog = await openDialog(page);
      if (dialog) find("friction", `A pop-up covers ${entry.path}`, { text: `A pop-up ("${dialog}") showed when ${entry.path} opened`, url: entry.path, friction: "popup" });

      // Links: on the project's origins only, never one that signs out or does something.
      const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].slice(0, 500).map((a) => ({ href: (a as HTMLAnchorElement).href, words: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || a.getAttribute("aria-label") || a.getAttribute("title") || "", method: (a.getAttribute("data-method") || a.getAttribute("data-turbo-method") || "").toLowerCase() }))).catch(() => [] as { href: string; words: string; method: string }[]);
      for (const l of links) {
        if (!/^https?:/.test(l.href) || !inOrigins(l.href)) continue;
        // A link a script turns into a DELETE or POST (Rails' data-method, Turbo's data-turbo-method) is a button.
        const does = SIGNS_OUT.test(l.words) ? "it reads like signing out" : l.method && l.method !== "get" ? `it sends a ${l.method.toUpperCase()}, not a page load` : doesSomething(l.href);
        const why = does ? `"${clip(l.words, 60)}" wasn't followed: ${does}` : refusedName(l.words);
        if (why) {
          if (!entry.leftAlone.includes(clip(mask(why), 200))) entry.leftAlone.push(clip(mask(why), 200));
          continue;
        }
        const key = pageKey(l.href);
        if (entry.links.length < 50 && !entry.links.includes(pathOf(l.href))) entry.links.push(pathOf(l.href));
        if (queued.has(key)) continue;
        queued.add(key);
        queue.push({ url: l.href, from: { path: entry.path, words: clip(mask(l.words), 80) } });
      }

      if (o.pressButtons !== false) await pressButtons(page, entry);
    }
  } finally {
    emit({ type: "phase", words: "Saving the video" });
  }
  const video = await rec.finish();
  if (offSiteNavigations > 0) {
    // The guard failed: say it loudly rather than hand back a report that claims 0.
    throw new Error(`Discovery left the project's origins ${offSiteNavigations} time(s): the guard failed, and nothing from this run should be trusted`);
  }
  const report: ExploreRun = {
    limits,
    steps: step,
    offSiteNavigations: 0,
    stoppedBecause,
    findings,
    pages,
    log,
    summary: "",
    ms: Date.now() - begun,
    ...(video ? { video } : {}),
    ...(blocked ? { blocked } : {}),
    writesHeld,
    ...(writesSent ? { writesSent } : {}),
    offSiteStopped,
  };
  report.summary = exploreSummary(report, [...origins].map((x) => new URL(x).host));
  emit({ type: "end", report });
  return report;

  /** Presses the page's plain buttons one at a time; one after which nothing at all happened is dead. */
  async function pressButtons(p: Page, entry: ExplorePage): Promise<void> {
    const here = p.url();
    const buttons = await p.evaluate((max) => {
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const out: { i: number; name: string; words: string }[] = [];
      const all = [...document.querySelectorAll('button, [role="button"], input[type="button"]')];
      for (const [i, el] of all.entries()) {
        if (out.length >= max * 3) break;
        const b = el as HTMLButtonElement;
        if (b.disabled || el.getAttribute("aria-disabled") === "true" || !shown(el)) continue;
        // A form's submit is never pressed: it sends the form.
        if (el.tagName === "BUTTON" && (b.type === "submit" || b.type === "reset") && b.form) continue;
        // A link styled as a button is crawled as a link.
        if (el.closest("a[href]")) continue;
        const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        const name = tidy(el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).value || el.getAttribute("title"));
        // Every name it has is read by the gates: an icon button "🗑" titled "Delete" is a delete button.
        const words = [el.getAttribute("aria-label"), el.textContent, (el as HTMLInputElement).value, el.getAttribute("title")].map(tidy).filter(Boolean).join(" / ");
        el.setAttribute("data-cm-explore", String(i));
        out.push({ i, name, words });
      }
      return out;
    }, BUTTONS_PER_PAGE).catch(() => [] as { i: number; name: string; words: string }[]);
    let pressed = 0;
    for (const b of buttons) {
      if (pressed >= BUTTONS_PER_PAGE || Date.now() >= deadline || o.signal?.aborted) break;
      const why = !b.words ? undefined : refusedName(b.words) ?? refusedSignedOut(b.words) ?? (SIGNS_OUT.test(b.words) ? `"${b.words}" wasn't pressed: it reads like signing out` : undefined);
      if (why) {
        const said = clip(mask(why), 200);
        if (!entry.leftAlone.includes(said)) entry.leftAlone.push(said);
        continue;
      }
      // An unnamed control is left to the a11y scan: what it does can't be said.
      if (!b.name) continue;
      if (pageKey(p.url()) !== pageKey(here)) {
        const back = await p.goto(here, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
        if (!back) break;
        await p.evaluate(() => {
          const all = [...document.querySelectorAll('button, [role="button"], input[type="button"]')];
          for (const [i, el] of all.entries()) el.setAttribute("data-cm-explore", String(i));
        }).catch(() => {});
      }
      const el = p.locator(`[data-cm-explore="${b.i}"]`).first();
      if (!(await el.count().catch(() => 0))) continue;
      emit({ type: "working", n: step, words: `Pressing "${clip(mask(b.name), 40)}"`, at: rec.at() });
      // Watch the page for any change at all while it is pressed. Some presses change nothing in the
      // page and still do their job: a copy to the clipboard, a scroll ("Back to top"), print, a sound,
      // full screen, a setting kept in storage. Those calls are counted, so such a button is never "dead".
      await p.evaluate(() => {
        const w = window as unknown as { __cmMut?: number; __cmObs?: MutationObserver; __cmDid?: number; __cmWrapped?: boolean; __cmScroll?: string };
        w.__cmDid = 0;
        w.__cmScroll = `${window.scrollX},${window.scrollY}`;
        if (!w.__cmWrapped) {
          w.__cmWrapped = true;
          const count = <T extends object>(o: T | undefined, k: string, call = true) => {
            const f = o ? (o as Record<string, unknown>)[k] : undefined;
            if (typeof f !== "function") return;
            try {
              (o as Record<string, unknown>)[k] = function (this: unknown, ...a: unknown[]) {
                w.__cmDid = (w.__cmDid ?? 0) + 1;
                return call ? (f as (...x: unknown[]) => unknown).apply(this, a) : undefined;
              };
            } catch {
              // a read-only method: left as it is
            }
          };
          for (const k of ["scrollTo", "scrollBy", "scroll"]) count(window, k);
          for (const k of ["scrollIntoView", "scrollTo", "scrollBy", "requestFullscreen"]) count(Element.prototype, k);
          count(navigator.clipboard, "writeText");
          count(navigator.clipboard, "write");
          count(document, "execCommand");
          // print is counted, never opened: a print dialog would hold the page.
          count(window, "print", false);
          count(HTMLMediaElement.prototype, "play");
          for (const k of ["setItem", "removeItem"]) count(Storage.prototype, k);
        }
        w.__cmMut = 0;
        w.__cmObs?.disconnect();
        w.__cmObs = new MutationObserver((list) => {
          for (const m of list) if (!(m.type === "attributes" && m.attributeName === "data-cm-explore")) w.__cmMut = (w.__cmMut ?? 0) + 1;
        });
        w.__cmObs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      }).catch(() => {});
      const focusBefore = await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? "").catch(() => "");
      Object.assign(probe, { on: true, requests: 0, dialogs: 0, choosers: 0, popups: 0 });
      const urlBefore = p.url();
      const heldBefore = writesHeld;
      held = [];
      const clicked = await el.click({ timeout: 2_000 }).then(() => true, () => false);
      await p.waitForTimeout(PRESS_WAIT_MS).catch(() => {});
      probe.on = false;
      const during = held;
      held = undefined;
      // A write we stopped makes its own errors: only a press that sent nothing has its errors kept.
      if (writesHeld === heldBefore) for (const f of during) keep(f);
      pressed++;
      if (!clicked) continue;
      const mutations = await p.evaluate(() => {
        const w = window as unknown as { __cmMut?: number; __cmObs?: MutationObserver; __cmDid?: number; __cmScroll?: string };
        w.__cmObs?.disconnect();
        const scrolled = w.__cmScroll !== `${window.scrollX},${window.scrollY}` ? 1 : 0;
        return (w.__cmMut ?? 0) + (w.__cmDid ?? 0) + scrolled;
      }).catch(() => -1);
      if (mutations === -1) continue; // the page went away: it did something
      const focusAfter = await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? "").catch(() => "");
      // Focus moving onto the button itself is what any click does: only a move elsewhere counts.
      const focusMoved = focusAfter !== focusBefore && !/data-cm-explore/.test(focusAfter);
      const nothing = mutations === 0 && p.url() === urlBefore && probe.requests === 0 && probe.dialogs === 0 && probe.choosers === 0 && probe.popups === 0 && !focusMoved;
      if (nothing) find("explore", `Dead button: "${clip(b.name, 60)}" on ${entry.path}`, { text: `Pressed "${clip(b.name, 80)}" on ${entry.path}: nothing changed on the page, no request was made, nothing opened (watched for ${PRESS_WAIT_MS} ms)`, url: entry.path });
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What each finding is called in the summary. */
function nounOf(f: ExploreFinding): string {
  if (f.kind === "http_error") return f.title.startsWith("Broken link") ? "broken link" : (f.evidence.status ?? 0) >= 500 ? "server error" : "failed request";
  if (f.kind === "console_error") return "console error";
  if (f.kind === "page_error") return "page error";
  if (f.kind === "a11y") return "accessibility issue";
  if (f.kind === "friction") return "friction note";
  if (f.kind === "explore") return "dead button";
  return "failed step";
}

/** One plain paragraph: what was explored, what was found, and what was left alone. */
export function exploreSummary(r: Pick<ExploreRun, "pages" | "findings" | "ms" | "stoppedBecause" | "limits" | "blocked" | "writesHeld" | "offSiteStopped"> & { writesSent?: number }, hosts: string[]): string {
  const opened = r.pages.filter((p) => !p.failed && !p.stoppedOffSite).length;
  const counts = new Map<string, number>();
  for (const f of r.findings) counts.set(nounOf(f), (counts.get(nounOf(f)) ?? 0) + 1);
  const found = r.findings.length ? `found ${plural(r.findings.length, "problem")}: ${[...counts.entries()].map(([k, n]) => plural(n, k)).join(", ")}` : "found no problems it could measure";
  const why = r.blocked ? `It stopped at ${r.blocked}, which it never answers.` : r.stoppedBecause === "steps" ? `It stopped at its limit of ${r.limits.maxSteps} pages.` : r.stoppedBecause === "time" ? `It stopped at its limit of ${r.limits.maxMinutes} minutes.` : r.stoppedBecause === "fails_in_row" ? `It stopped after ${r.limits.maxFailsInRow} pages in a row failed to open.` : r.stoppedBecause === "stopped" ? "You stopped it." : "It ran out of new pages to open.";
  const alone = new Set(r.pages.flatMap((p) => p.leftAlone)).size;
  const safe = [`It stayed on ${hosts.join(", ")}`, alone ? `left ${plural(alone, "control")} alone that pay, post, send, delete or sign out` : "", r.writesHeld ? `stopped ${plural(r.writesHeld, "request")} a pressed button tried to send` : "", r.writesSent ? `let ${plural(r.writesSent, "request")} a pressed button made go to your own site` : "", r.offSiteStopped ? `stopped ${plural(r.offSiteStopped, "link")} that led off the site` : ""].filter(Boolean);
  return `Explored ${plural(opened, "page")} in ${Math.max(1, Math.round(r.ms / 1000))} s and ${found}. ${why} ${safe.join(", ")}.`;
}

/**
 * Findings as the data lane files them (A3): one occurrence each, with its video time. Severity and
 * the dedupe key are the data lane's, from its fixed rule table.
 */
export function findingsToOccurrences(report: Pick<ExploreReport, "findings">, run: { runId: RunId; testId?: TestId; testName: string; at: string }): { kind: ExploreFinding["kind"]; title: string; occurrence: IssueOccurrence }[] {
  return report.findings.map((f) => ({
    kind: f.kind,
    title: f.title,
    occurrence: { runId: run.runId, ...(run.testId ? { testId: run.testId } : {}), testName: run.testName, step: f.step, videoAt: f.at, at: run.at, evidence: f.evidence },
  }));
}
