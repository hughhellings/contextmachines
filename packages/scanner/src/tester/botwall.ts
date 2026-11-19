/**
 * A bot check in front of a site: Cloudflare's "Just a moment...", a CAPTCHA, DataDome, Akamai,
 * DDoS-Guard, HUMAN's "Press & Hold". Found with no AI, from strong signals only, so a normal page is
 * never taken for one: a page that is mostly the challenge, not one that mentions the word captcha or
 * carries a small reCAPTCHA badge beside its own content.
 *
 * THE RULE (hard, no exceptions): Context Machines never tries to get past a bot check or CAPTCHA.
 * - No solving it, no clicking "I am human", no pressing and holding.
 * - No stealth plugins, no user-agent or fingerprint changes, no turning off navigator.webdriver.
 * - No retry loops meant to wear the check down.
 * It may wait a short time (about 10s in all, BOT_WALL_WAIT_MS) for a check that clears by itself
 * with no input, as some do. If the check is still there, it stops and says so honestly. A guard
 * test (cli/botwall.test.ts) fails if evasion of any kind is added to the tester.
 */
import type { Page } from "playwright";
import { CouldNotRun } from "./types.ts";

/** How long, in all, a run waits for a bot check to clear by itself. Never input, only time. */
export const BOT_WALL_WAIT_MS = 10_000;

export const CLOUDFLARE = "Cloudflare's bot check";
export const A_CAPTCHA = "a CAPTCHA";
export const THE_SITES = "the site's bot check";

/** What every place that shows a run stopped by one says: the terminal, report.html, the explore page, the web view. */
export const BLOCKED_BY_WALL = "Blocked by the site's bot check";

/** Why a task wasn't started: an earlier one on the same site met the wall. */
export const WALL_NOT_RUN = "the site's bot check stopped the browser";

/** The step's reason when a check stayed. */
export function wallReason(check: string): string {
  return `the site's bot check (${check}) stopped the browser; Context Machines doesn't get past bot checks`;
}

/** The one message when the look at a site met a wall that stayed. */
export function botWallWords(host: string, check: string): string {
  return `${host} checks for bots (${check}) and didn't let the test browser in. Context Machines doesn't get past bot checks. Try a site you own, its staging address, or ask the owner to let the tester through.`;
}

/** The look met a bot check that stayed: nothing is suggested and nothing runs. Exit 3, "couldn't run". */
export class BotWalled extends CouldNotRun {
  override name = "BotWalled";
  readonly host: string;
  readonly check: string;
  /** A photo of the wall (JPEG), when one could be taken. */
  readonly shot?: Buffer;
  constructor(host: string, check: string, shot?: Buffer) {
    super(botWallWords(host, check));
    this.host = host;
    this.check = check;
    if (shot) this.shot = shot;
  }
}

/**
 * Titles the challenge pages use. Each counts when the title is that alone (and its `needs` holds),
 * or when it only starts so and `partly` holds: by default, a page that is mostly the challenge.
 */
const TITLES: { re: RegExp; exact: RegExp; name: (m: Marks) => string; needs?: (m: Marks) => boolean; partly?: (m: Marks) => boolean }[] = [
  // "Just a moment of calm" is a blog post: only the bare title, or the title with Cloudflare's challenge script.
  { re: /^just a moment\b/i, exact: /^just a moment\s*(\.{3}|…)?$/i, name: () => CLOUDFLARE, partly: (m) => m.cfChallenge },
  { re: /^attention required!?\s*\|\s*cloudflare/i, exact: /^attention required!?\s*\|\s*cloudflare$/i, name: () => CLOUDFLARE },
  { re: /^checking your browser\b/i, exact: /^checking your browser( before accessing\b.*)?\s*(\.{3}|…)?$/i, name: (m) => (m.cloudflare ? CLOUDFLARE : m.ddosGuard ? "DDoS-Guard's bot check" : THE_SITES) },
  // "Access denied" alone is a plain 403 of the site's own: only with the bot service's own marks.
  { re: /^access denied\b/i, exact: /^access denied$/i, name: (m) => (m.akamai ? "Akamai's bot check" : CLOUDFLARE), needs: (m) => m.cloudflare || m.akamai },
  // DDoS-Guard's own page is titled that alone; a page that only names it (a review, the vendor's home) is not one.
  { re: /ddos-guard/i, exact: /^ddos-guard$/i, name: () => "DDoS-Guard's bot check", partly: (m) => m.ddosGuard && mostlyChallenge(m) },
];

/**
 * Words a challenge page shows. They count only on a page that is mostly the challenge and has no
 * fields of its own: a sign-in or contact form that says "Please verify you are human" beside a small
 * box is a normal page.
 */
const TEXTS = /\bperforming security verification\b|\bverify(ing)? (that )?you are (a )?human\b|\bchecking if the site connection is secure\b|\bplease complete the security check\b|\bneeds to review the security of your connection\b/i;
/** HUMAN's (PerimeterX's) "Press & Hold": only with its own marks, as "press and hold the button to talk" is a normal page. */
const PRESS_HOLD = /\bpress (&|and) hold\b/i;

/**
 * Words on a control that belong to a bot check: "Verify you are human", "I'm not a robot", "Press &
 * Hold". Never pressed (act.ts refuses them), whether or not the page was found to be a wall.
 */
export const CHALLENGE_CONTROL = /\bverify(ing)? (that )?(you are|you'?re|i am|i'?m) (a )?human\b|\b(i am|i'?m|you are|you'?re)( not a (ro)?bot| (a )?human)\b|\bnot a (ro)?bot\b|\bpress\s*&\s*hold\b|\bpress and hold (to )?(confirm|verify|prove|continue)\b|\bconfirm (that )?you('| a)?re (a )?human\b/i;
/** Why such a control wasn't pressed: the end of act.ts's refusal, which run.ts reads to end the step as a wall. */
export const CHALLENGE_REFUSED = "it belongs to a bot check, and Context Machines doesn't get past bot checks";
/** The wall's name when it was only known by its control. */
export const A_CHALLENGE = "a challenge on the page";

/** Frames the challenge services draw in, and what each is called. */
const FRAMES: { re: RegExp; name: string }[] = [
  { re: /^https?:\/\/challenges\.cloudflare\.com\//i, name: CLOUDFLARE },
  { re: /^https?:\/\/([\w-]+\.)*hcaptcha\.com\//i, name: A_CAPTCHA },
  { re: /^https?:\/\/(www\.)?(google|recaptcha)\.(com|net)\/recaptcha\//i, name: A_CAPTCHA },
  { re: /^https?:\/\/([\w-]+\.)*captcha-delivery\.com\//i, name: "DataDome's bot check" },
];

interface Marks {
  /** The page's visible words, squeezed, cut to a few thousand. */
  text: string;
  length: number;
  links: number;
  /** Fields of the page's own (a challenge's live in its frame). */
  fields: number;
  cloudflare: boolean;
  /** Cloudflare's challenge script itself, not only its name. */
  cfChallenge: boolean;
  akamai: boolean;
  /** HUMAN's (PerimeterX's) challenge. */
  perimeterX: boolean;
  ddosGuard: boolean;
}

/** Runs in the page: what it shows and whose marks it carries. Self-contained. */
function readMarks(): Marks {
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const text = ((document.body as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
  const html = document.documentElement.outerHTML.slice(0, 300_000);
  return {
    text: text.slice(0, 4000),
    length: text.length,
    links: [...document.querySelectorAll("a[href]")].filter(shown).length,
    fields: [...document.querySelectorAll("input:not([type=hidden]), textarea, select")].filter(shown).length,
    cloudflare: /cdn-cgi\/challenge-platform|_cf_chl_opt|\bcf-chl-|challenges\.cloudflare\.com/i.test(html) || /\bray id\b|\bcloudflare\b/i.test(text),
    cfChallenge: /cdn-cgi\/challenge-platform|_cf_chl_opt/i.test(html),
    akamai: /\bakamai\b|edgesuite\.net/i.test(html) || /\breference #\s*[\d.a-f]+/i.test(text),
    perimeterX: /px-captcha|_pxhd|_pxAppId|perimeterx|px-cdn\.net|pxchk\.net/i.test(html) || /\breference id\b/i.test(text),
    // Its check script, not its name: a page's title is in the HTML too.
    ddosGuard: /\.well-known\/ddos-guard|check\.ddos-guard\.net|ddos-guard\.net\/(js|check)|__ddg\d/i.test(html),
  };
}

/** Runs in the page: whether a frame's element can be seen (not hidden, not see-through, up its ancestors). */
function shownFrame(el: Element): boolean {
  if (getComputedStyle(el).visibility !== "visible") return false;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (st.display === "none" || Number(st.opacity) < 0.1) return false;
  }
  return true;
}

/** Whether the page is mostly the challenge: few words and few links, as a challenge page has. */
const mostlyChallenge = (m: Marks) => m.length <= 1500 && m.links <= 8;
/** Whether the page has nothing of its own beside a frame: barely any words, no links to speak of, no fields. */
const bare = (m: Marks) => m.length <= 600 && m.links <= 3 && m.fields === 0;

/**
 * The bot check the page shows now, by a short name a person reads ("Cloudflare's bot check",
 * "a CAPTCHA", "the site's bot check"), or nothing. Never touches the page: it only reads it.
 */
export async function botWall(page: Page): Promise<string | undefined> {
  const marks = await page.evaluate(readMarks).catch(() => undefined);
  if (!marks) return undefined;
  const title = (await page.title().catch(() => "")).replace(/\s+/g, " ").trim();
  for (const t of TITLES) {
    if (!t.re.test(title)) continue;
    if (t.needs && !t.needs(marks)) continue;
    if (t.exact.test(title) || (t.partly ?? mostlyChallenge)(marks)) return t.name(marks);
  }
  // The challenge's words, on a page that is mostly them and has no fields of its own.
  if (mostlyChallenge(marks) && marks.fields === 0) {
    if (TEXTS.test(marks.text)) return marks.cloudflare ? CLOUDFLARE : THE_SITES;
    if (PRESS_HOLD.test(marks.text) && marks.perimeterX) return "HUMAN's bot check";
  }
  const view = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const kind = FRAMES.find((f) => f.re.test(frame.url()));
    if (!kind) continue;
    // A badge or a box inside a form beside the page's own content is not a wall; a frame that
    // covers much of the window, or one on a page with nothing else, is. Only what is seen counts: an
    // invisible CAPTCHA parks its challenge frame hidden or off screen until it's needed.
    const handle = await frame.frameElement().catch(() => null);
    if (!handle) continue;
    const seen = await handle.evaluate(shownFrame).catch(() => false);
    const box = seen ? await handle.boundingBox().catch(() => null) : null;
    if (!box) continue;
    const w = Math.max(0, Math.min(box.x + box.width, view.width) - Math.max(box.x, 0));
    const h = Math.max(0, Math.min(box.y + box.height, view.height) - Math.max(box.y, 0));
    if (w * h < 100) continue;
    if (w * h >= 0.4 * view.width * view.height || bare(marks)) return kind.name;
  }
  return undefined;
}

/**
 * Waits for a bot check to clear by itself, out of one budget (BOT_WALL_WAIT_MS) for each browser
 * context that opens the site: the page is read again every half second, and nothing is ever pressed
 * or typed. A context's cookies (a check's clearance among them) go with it, so a new one starts afresh.
 */
export class WallWatch {
  private leftMs: number;
  constructor(ms: number = BOT_WALL_WAIT_MS) {
    this.leftMs = Math.max(0, ms);
  }

  /** The check still standing once what's left of the wait is used, or nothing (there was none, or it cleared). */
  async stands(page: Page): Promise<string | undefined> {
    let found = await botWall(page);
    if (!found) return undefined;
    const until = Date.now() + this.leftMs;
    while (Date.now() < until) {
      const ok = await page.waitForTimeout(Math.min(500, Math.max(0, until - Date.now()))).then(() => true, () => false);
      if (!ok) break;
      const now = await botWall(page);
      if (now) {
        found = now;
        continue;
      }
      // Gone, or the page is between loads (a check that clears loads the page again): read once more when it has loaded.
      // Never past the budget (a timeout of 0 would mean no limit at all).
      const left = until - Date.now();
      if (left > 0) await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, left) }).catch(() => {});
      const after = await botWall(page);
      if (!after) {
        this.leftMs = Math.max(0, until - Date.now());
        return undefined;
      }
      found = after;
    }
    this.leftMs = 0;
    return found;
  }
}
