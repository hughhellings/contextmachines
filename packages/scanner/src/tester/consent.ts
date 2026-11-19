/**
 * A cookie or consent wall, answered "no" with no AI, before a visitor's test starts. Big sites put
 * one in front of everything: a banner on the page, or a whole page of its own on a host made for it
 * (consent.<site>, or the owner's shared consent host). Only a control that reads like rejecting or
 * keeping to what is needed is pressed; one that accepts is never.
 */
import type { Frame, Page } from "playwright";
import { refusedName, refusedSignedOut, siteOf } from "./act.ts";

/**
 * A consent host: its first label is "consent" (consent.youtube.com, consent.google.com). The test
 * may be sent to one when it opens its first page, and only then: see guardSite's `consent`.
 */
export const CONSENT_HOST = /^consent\.[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Whether an address is on a consent host (any site's): what the page now shows is a consent page. */
export function onConsentHost(address: string): boolean {
  try {
    return CONSENT_HOST.test(new URL(address).hostname);
  } catch {
    return false;
  }
}

/**
 * The consent hosts another site may send its first visit to, and the sites that do: Google's, for
 * YouTube and Google's own. Any other consent host counts only when it is the site's own
 * (consent.youtube.com for www.youtube.com).
 */
export const SHARED_CONSENT_HOSTS: Record<string, RegExp> = {
  "consent.google.com": /^(youtube\.com|google\.[a-z]{2,3}(\.[a-z]{2})?)$/,
};

/**
 * Whether a test that starts at `start` may be sent to this consent host while its first page opens:
 * a consent host of the start's own registrable domain, or one listed in SHARED_CONSENT_HOSTS for it.
 * "consent.<anything>" is not enough: consent.evil.example is another site.
 */
export function consentHostFor(address: string, start: string): boolean {
  try {
    const host = new URL(address).hostname.toLowerCase();
    if (!CONSENT_HOST.test(host)) return false;
    const site = siteOf(new URL(start).hostname);
    if (siteOf(host) === site) return true;
    return SHARED_CONSENT_HOSTS[host]?.test(site) ?? false;
  } catch {
    return false;
  }
}

/**
 * A control's words that refuse what isn't needed: "Reject all", "Reject the use of cookies…",
 * "Decline", "Necessary cookies only", "Continue without accepting", "Don't allow". The whole name, and short: never
 * one that accepts or allows, and never one that says no and then does something else ("Reject and
 * subscribe", "Decline and delete my account").
 */
const REJECTS = /^(reject|decline|refuse|deny|disagree)( all| everything| optional| additional| non-?essential| all cookies| cookies| optional cookies| additional cookies| non-?essential cookies| the use of cookies( and other data)?( for the purposes described)?)?$|^(use |allow )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?$|^(necessary|essential) cookies only$|^continue without (accepting|agreeing)( to cookies)?$|^(no,? thanks|i do not accept|do not accept)$|^(don['’]?t|do not) allow( all)?( cookies)?$/i;
/** What a control that rejects may also look for in a frame: found by its start, then held to REJECTS whole. */
const REJECTS_START = /^(reject|decline|refuse|deny|disagree|use only|only|strictly|necessary|essential|required|allow only|continue without|no,? thanks|i do not accept|do not accept|don['’]?t allow|do not allow)\b/i;
/** Words that say yes somewhere in a control's name ("Reject optional, accept all"): never pressed. */
const ACCEPTS = /\b(accept all|agree and|(?<!(don['’]?t|do not) )allow all|i agree|i accept)\b/i;

/** Whether a control with these words rejects consent, and never accepts it. */
export function rejectsConsent(name: string): boolean {
  const words = name.replace(/\s+/g, " ").trim();
  if (!words || words.length > 90) return false;
  // Whatever it seems to say, a name the deny list refuses is never pressed.
  if (refusedName(words) || refusedSignedOut(words)) return false;
  return !/^(accept|agree|allow all|ok\b|got it)/i.test(words) && REJECTS.test(words) && !ACCEPTS.test(words);
}

/** Runs in a frame: whether it shows words a consent wall uses. Self-contained. */
function readsLikeConsent(): boolean {
  const words = (document.body?.innerText ?? "").slice(0, 20_000).toLowerCase();
  return /\bcookies?\b|\bconsent\b|\bprivacy (choices|settings|preferences)\b|before you continue/.test(words);
}

/** The first visible control in a frame whose name rejects consent. */
async function rejectIn(frame: Frame): Promise<{ click(): Promise<void>; name: string } | undefined> {
  if (!(await frame.evaluate(readsLikeConsent).catch(() => false))) return undefined;
  for (const role of ["button", "link"] as const) {
    const all = frame.getByRole(role, { name: REJECTS_START });
    const count = Math.min(await all.count().catch(() => 0), 8);
    for (let i = 0; i < count; i++) {
      const el = all.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const name = ((await el.getAttribute("aria-label").catch(() => null)) || (await el.innerText({ timeout: 1000 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!rejectsConsent(name)) continue;
      return { name, click: () => el.click({ timeout: 8000 }) };
    }
  }
  return undefined;
}

/**
 * Answers a consent wall "no", if one shows: on the page itself, or in one of its frames (many walls
 * are a frame of their own). Waits a little for one to appear, as most are drawn after the page.
 * Returns what was pressed ("Reject all"), or nothing when there was no wall.
 */
export async function rejectConsent(page: Page, { waitMs = 3000, goneMs = 12_000 }: { waitMs?: number; goneMs?: number } = {}): Promise<string | undefined> {
  const until = Date.now() + waitMs;
  do {
    for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
      const found = await rejectIn(frame);
      if (!found) continue;
      const before = page.url();
      const clicked = await found.click().then(() => true, () => false);
      if (!clicked) continue;
      // A wall on a page of its own sends the browser back to the site: wait for that to land.
      if (onConsentHost(before)) await page.waitForURL((u) => !onConsentHost(u.href), { timeout: 15_000 }).catch(() => {});
      // A wall on the page says "Saving your choice" for a while, and may load the page again: answered
      // only once no wall shows, so the test's first look isn't of the wall going away.
      const gone = Date.now() + goneMs;
      while (Date.now() < gone) {
        await page.waitForTimeout(400);
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        if (!(await wallShows(page))) break;
      }
      await page.waitForTimeout(300);
      return found.name;
    }
    if (Date.now() >= until) break;
    await page.waitForTimeout(400);
  } while (Date.now() < until);
  return undefined;
}

/** Whether a consent wall still shows: a reject control visible in the page or a frame, or an open dialog that reads like one. */
async function wallShows(page: Page): Promise<boolean> {
  for (const frame of page.frames()) if (await rejectIn(frame).catch(() => undefined)) return true;
  return page.evaluate(() => {
    for (const el of document.querySelectorAll("dialog[open], [role=dialog], [aria-modal=true]")) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!r.width || !r.height || st.display === "none" || st.visibility === "hidden") continue;
      if (/\bcookies?\b|\bconsent\b|before you continue|saving your choice/i.test((el.textContent ?? "").slice(0, 5000))) return true;
    }
    return false;
  }).catch(() => false);
}
