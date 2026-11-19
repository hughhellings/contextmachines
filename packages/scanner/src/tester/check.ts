/**
 * Whether a step's check holds, measured in the browser with no AI: words visible on the page, the
 * address, an element by role and name, or the title. It waits a little (up to 5s) for a page still
 * settling, then says what was expected and what was there instead.
 */
import type { Frame, Page } from "playwright";
import { withoutSecrets } from "./cache.ts";
import { deepText } from "./shadow.ts";
import type { Check } from "./types.ts";
import { downloadHolds, downloadsOf } from "./widgets.ts";

export const CHECK_WAIT_MS = 5000;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The check in words: what a reader expects. */
export function expected(check: Check): string {
  switch (check.kind) {
    case "text_visible":
      return `the page shows "${check.text}"`;
    case "url_contains":
      return `the address contains "${check.text}"`;
    case "element_visible":
      return `a ${check.role}${check.name ? ` named "${check.name}"` : ""} is visible`;
    case "title_contains":
      return `the title contains "${check.text}"`;
    case "password_gone":
      return "the sign-in form is gone (no password field shows)";
    case "signed_in":
      return `signed in: no password or code field shows${check.left ? `, the address has left ${check.left}` : ""}${check.text ? `, and the page shows "${check.text}"` : check.url ? `, and the address contains "${check.url}"` : ""}`;
    case "video_playing":
      return "the page's video is playing (its time moves on)";
    case "video_paused":
      return "the page's video is paused (it has played, and its time stands still)";
    case "judged":
      return `an AI judges: "${check.claim}"`;
    case "download_contains":
      return `a file downloaded in this run holds "${check.text}"`;
    case "none":
      return "nothing to measure (a step on the way)";
  }
}

export interface Verified {
  ok: boolean;
  expected: string;
  found: string;
}

/** The page's main video now: the largest one showing, in the page itself. */
export interface VideoState {
  time: number;
  paused: boolean;
  ended: boolean;
}

/** Runs in the page: the largest visible <video>'s time and state, or null when none shows. Self-contained. */
function mainVideo(): VideoState | null {
  let best: HTMLVideoElement | undefined;
  let area = 0;
  for (const v of document.querySelectorAll("video")) {
    const r = v.getBoundingClientRect();
    const a = r.width * r.height;
    if (r.width >= 50 && r.height >= 30 && a > area) {
      best = v;
      area = a;
    }
  }
  return best ? { time: best.currentTime, paused: best.paused, ended: best.ended } : null;
}

/** How long a video is watched to tell playing from paused. */
export const VIDEO_WATCH_MS = 1500;

/**
 * Whether a video is playing or paused, measured: two readings of the main video's time, a moment
 * apart. Playing: its time moved on and it isn't paused. Paused: it is paused, has played (time past
 * 0), and its time stood still. Exported for tests: it takes the two readings.
 */
export function videoVerdict(kind: "video_playing" | "video_paused", a: VideoState | null, b: VideoState | null): { ok: boolean; found: string } {
  if (!a || !b) return { ok: false, found: "there's no video showing on the page" };
  const moved = b.time - a.time;
  const at = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const state = `${b.paused ? "paused" : b.ended ? "ended" : "not paused"}, its time ${moved > 0.05 ? `went from ${at(a.time)} to ${at(b.time)}` : `stayed at ${at(b.time)}`}`;
  if (kind === "video_playing") return { ok: moved >= 0.3 && !b.paused, found: `the video is ${state}` };
  // Paused, not stalled: a video waiting for data stands still too, but isn't paused.
  return { ok: b.paused && moved < 0.05 && b.time > 0, found: `the video is ${state}` };
}

/** Words a page shows when a sign-in hasn't finished (or didn't work): a code or a link to wait for, a wrong password, a lock. */
export const NOT_SIGNED_IN = /\b(check your (e-?mail|inbox|phone)|we('ve| have)? (just )?sent (you )?(a|an|the) (code|link|e-?mail|message|text)|enter (the |your |a )?(\d-digit |six-digit )?(code|verification code|confirmation code|security code|one[- ]time (pass)?code|authentication code|2fa code)|verify (it's|it is) you|wrong (email|e-mail|username|user name|password)|incorrect (email|e-mail|username|password)|invalid (email|e-mail|username|password|credentials|login)|(password|email) (is )?(incorrect|wrong|invalid)|(sign[- ]?in|log[- ]?in|login|authentication) (failed|was unsuccessful|unsuccessful|error)|(don't|do not|didn't|did not) match (our records|any account)|(account|user) (is )?(locked|blocked|suspended)|too many (attempts|tries|sign-in attempts))\b/i;

/**
 * Words a page shows when the site asks to confirm a new device or that it's really you, by email or
 * another device, with no code to type (DEVICE_CHECK): a run never waits for that, and never sends the
 * sign-in again (each send could mail the person again).
 */
export const DEVICE_CHECK_WORDS = /\b(new (device|browser|location) (detected|sign[- ]?in|login|log[- ]?in)|unrecogni[sz]ed (device|browser)|confirm (it'?s|it is) (really )?you|verify (it'?s|it is) (really )?you|(confirm|approve|verify) (this|your) (sign[- ]?in|login|log[- ]?in)|(confirm|verify) (this|your) (device|browser)|device (verification|approval|confirmation)|we (sent|emailed) you an? (e-?mail|link|message) to (confirm|approve|verify))\b/i;

/** Words that say it is the sign-in asking (it's you, an email sent to confirm): enough on any page. */
const DEVICE_CHECK_STRONG = /\b(confirm|verify) (it'?s|it is) (really )?you\b|\bwe (sent|emailed) you an? (e-?mail|link|message) to (confirm|approve|verify)\b|\bdevice (verification|approval|confirmation)\b/i;

/**
 * A new-device check on this page, measured: its words, only while the page is still the sign-in's
 * ("it's you", an email sent to confirm, "check your email", or an address on the sign-in's way), never a
 * signed-in page that talks about devices ("Add new device", "Approve this device" in a settings list).
 */
export function deviceCheckIn(text: string, url: string): string | undefined {
  const words = DEVICE_CHECK_WORDS.exec(text)?.[0];
  if (!words) return undefined;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    // no address: the words alone decide
  }
  const onTheWay = /\/(log-?in|sign-?in|signon|auth|verify|verification|confirm|device|challenge|2fa|mfa|checkpoint)\b/i.test(path);
  return DEVICE_CHECK_STRONG.test(text) || NOT_SIGNED_IN.test(text) || onTheWay ? words : undefined;
}

/** Runs in the page (each frame): what tells a signed-in page from a half-way one. Self-contained. */
function signInState(): { password: number; code: number; providers: number; text: string } {
  const shown = (e: Element) => (e as HTMLElement).offsetParent !== null || (e as HTMLElement).getClientRects().length > 0;
  // Into open shadow roots too: a sign-in form may be a web component.
  const all = (sel: string): Element[] => {
    const out: Element[] = [];
    const walk = (root: Document | ShadowRoot, depth: number) => {
      out.push(...root.querySelectorAll(sel));
      if (depth > 4) return;
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    };
    walk(document, 0);
    return out;
  };
  const fields = (all("input") as HTMLInputElement[]).filter(shown);
  const password = fields.filter((e) => e.type === "password").length;
  const said = (e: HTMLInputElement) => [e.name, e.id, e.getAttribute("autocomplete"), e.getAttribute("aria-label"), e.placeholder, ...[...(e.labels ?? [])].map((l) => l.textContent)].join(" ").toLowerCase();
  const texty = (e: HTMLInputElement) => /^(text|tel|number|)$/.test(e.type);
  let code = fields.filter((e) => e.getAttribute("autocomplete") === "one-time-code" || (texty(e) && /\b(otp|one[- ]?time|verification|confirmation code|2fa|mfa|totp|auth(entication)? code|security code|sign-in code|login code|digit \d)\b/.test(said(e)))).length;
  // A code split into one-digit boxes (four or more), whatever they are called.
  if (fields.filter((e) => texty(e) && e.maxLength === 1).length >= 4) code++;
  // Only a provider's buttons ("Continue with Google"): a sign-in page, not a signed-in one.
  const providers = all("button, a, [role=button]").filter((e) => shown(e) && /^(continue|sign in|log in|login|sign up) with (google|github|microsoft|apple|facebook|gitlab|linkedin|x|twitter|sso|saml|okta|email)$/i.test((e.textContent ?? "").replace(/\s+/g, " ").trim())).length;
  return { password, code, providers, text: (document.body?.innerText ?? "").slice(0, 20_000) };
}

/** The sign-in state of the page and every frame in it (a sign-in form in an iframe is still a sign-in form). */
async function signInStateAll(page: Page): Promise<{ password: number; code: number; providers: number; text: string }> {
  const s = await page.evaluate(signInState);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const f = await frame.evaluate(signInState).catch(() => undefined);
    if (!f) continue;
    s.password += f.password;
    s.code += f.code;
    s.providers += f.providers;
  }
  return s;
}

/**
 * The words of a "confirm it's a new device" page, measured with no AI: shown with no password field and
 * no code field to type into (a page with a code field is a code to type, not this). Nothing when it isn't one.
 */
export async function deviceCheckOn(page: Page): Promise<string | undefined> {
  const s = await signInStateAll(page).catch(() => undefined);
  if (!s || s.password || s.code) return undefined;
  return deviceCheckIn(s.text, page.url());
}

/**
 * A page asking for a sign-in code sent to the person, measured with no AI: "sms" when it says the code
 * was texted (a text, SMS, a phone), "code" for any other code field, nothing when there's no code field
 * to fill or it is an authenticator's.
 */
export async function codePageOn(page: Page): Promise<"sms" | "code" | undefined> {
  const s = await signInStateAll(page).catch(() => undefined);
  // An authenticator's code is made on this machine (totp), never a code sent to the person.
  if (!s?.code || /\bauthenticator\b|\bauthentication app\b/i.test(s.text)) return undefined;
  return /\b(text(ed)?( message)?|sms|phone( number)?|mobile)\b/i.test(s.text) ? "sms" : "code";
}


async function signedIn(page: Page, check: Extract<Check, { kind: "signed_in" }>): Promise<{ ok: boolean; found: string }> {
  const s = await signInStateAll(page);
  // Said as evidence: never a token the address carries (a magic link's, a callback's).
  const url = withoutSecrets(page.url());
  if (s.password) return { ok: false, found: `a password field still shows, at ${url}` };
  if (s.code) return { ok: false, found: `a code field shows (the sign-in isn't finished), at ${url}` };
  if (s.providers) return { ok: false, found: `the page offers to sign in with a provider ("Continue with …"), at ${url}` };
  const half = NOT_SIGNED_IN.exec(s.text);
  const device = deviceCheckIn(s.text, url);
  if (device) return { ok: false, found: `the site asks to confirm a new device ("${half ? half[0] : device}"), at ${url}` };
  if (half) return { ok: false, found: `the page says "${half[0]}", at ${url}` };
  if (check.left) {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      // not an address
    }
    if (path.replace(/\/+$/, "") === check.left.replace(/\/+$/, "")) return { ok: false, found: `the address is still the sign-in page (${url})` };
  }
  if (check.text && !norm(s.text).includes(norm(check.text))) return { ok: false, found: `the page doesn't show "${check.text}", at ${url}` };
  if (check.url && !norm(url).includes(norm(check.url))) return { ok: false, found: `the address is ${url}` };
  return { ok: true, found: "" };
}

/** The page's embedded frames a person can see now (the frame element on screen, not tiny), at most 8. */
async function shownFrames(page: Page): Promise<Frame[]> {
  const out: Frame[] = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame() || out.length >= 8) continue;
    const box = await f.frameElement().then((e) => e.boundingBox()).catch(() => null);
    if (box && box.width >= 40 && box.height >= 40) out.push(f);
  }
  return out;
}

async function once(page: Page, check: Check): Promise<{ ok: boolean; found: string }> {
  switch (check.kind) {
    case "video_playing":
    case "video_paused": {
      const a = await page.evaluate(mainVideo);
      await page.waitForTimeout(VIDEO_WATCH_MS);
      const b = await page.evaluate(mainVideo);
      return videoVerdict(check.kind, a, b);
    }
    case "none":
      return { ok: true, found: "" };
    // Never measured: the run asks the AI judge (run.ts), and nothing here may pass it.
    case "judged":
      return { ok: false, found: "this check is judged by an AI, not measured by the browser" };
    case "signed_in":
      return signedIn(page, check);
    // W4: read from the file the site gave, never from the page: a download still arriving is waited for.
    case "download_contains": {
      const d = downloadsOf(page);
      if (!d) return { ok: false, found: "this run doesn't watch downloads" };
      await d.settled();
      return downloadHolds(d.list, check.text);
    }
    case "password_gone": {
      const shown = await page.locator("input[type=password]").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null || (e as HTMLElement).getClientRects().length > 0).length).catch(() => 0);
      return { ok: shown === 0, found: `a password field still shows, at ${withoutSecrets(page.url())}` };
    }
    case "url_contains": {
      const url = page.url();
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // an address that isn't encoded as it says: read as it is
      }
      return { ok: norm(decoded).includes(norm(check.text)) || norm(url).includes(norm(check.text)), found: `the address is ${withoutSecrets(url)}` };
    }
    case "title_contains": {
      const title = await page.title();
      return { ok: norm(title).includes(norm(check.text)), found: `the title is "${title}"` };
    }
    case "text_visible": {
      // The page's own words: what anyone typed into it (a comment box, an editor) doesn't count, or
      // a test could make its check hold by typing the words itself.
      // W5: shadow roots' words count too (a web component's list, a design system's toast).
      const text = await page.evaluate(deepText).catch(() => "");
      if (norm(text).includes(norm(check.text))) return { ok: true, found: "" };
      // What a person sees includes an embedded frame on screen (a provider's checkout or 3-D Secure challenge).
      for (const f of await shownFrames(page)) {
        const inner = await f.evaluate(deepText).catch(() => "");
        if (norm(inner).includes(norm(check.text))) return { ok: true, found: "" };
      }
      const start = text.replace(/\s+/g, " ").trim().slice(0, 160);
      return { ok: false, found: start ? `the page shows "${start}${text.length > 160 ? "…" : ""}"` : "the page shows no text" };
    }
    case "element_visible": {
      const role = check.role as Parameters<Page["getByRole"]>[0];
      const want = check.name ? page.getByRole(role, { name: check.name }) : page.getByRole(role);
      const count = await want.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 10); i++) if (await want.nth(i).isVisible().catch(() => false)) return { ok: true, found: "" };
      for (const f of await shownFrames(page)) {
        const inFrame = check.name ? f.getByRole(role, { name: check.name }) : f.getByRole(role);
        const n = await inFrame.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 10); i++) if (await inFrame.nth(i).isVisible().catch(() => false)) return { ok: true, found: "" };
      }
      const others = await page.getByRole(role).evaluateAll((els) => els.slice(0, 40).map((e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean).slice(0, 5)).catch(() => [] as string[]);
      return { ok: false, found: others.length ? `the ${check.role}s visible are ${others.map((o) => `"${o}"`).join(", ")}` : `there's no ${check.role} on the page` };
    }
  }
}

/** The check, tried until it holds or `waitMs` has gone. */
export async function verify(page: Page, check: Check, waitMs = CHECK_WAIT_MS): Promise<Verified> {
  const until = Date.now() + waitMs;
  let last = { ok: false, found: "" };
  do {
    last = await once(page, check).catch((error: unknown) => ({ ok: false, found: `it couldn't be measured: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }));
    if (last.ok || Date.now() >= until) break;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  return { ok: last.ok, expected: expected(check), found: last.found };
}
