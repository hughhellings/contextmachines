/**
 * E10: which protection a site put in front of the test browser, by name, and, for a site the person
 * owns, the one line that turns on the provider's own test mode. Detection only: this file reads the
 * page and never clicks, types, focuses or waits for a widget. It builds on the tester's detector
 * (packages/scanner/src/tester/botwall.ts: whether a check stands) and access.ts (basic auth and
 * Vercel's protection), and adds the provider's name, its test keys and the setup line.
 *
 * THE RULE (hard): nothing here, and nothing that uses it, gets past a check. A site the person doesn't
 * own gets a plain BLOCKED with no setup line (C27). A site they own gets the provider's test-mode
 * setup, which the owner applies on their side. A person may get past a check by hand in the
 * window "Set up sign-in" opens, before any run (A1). The AI and our code never do.
 *
 * Like botwall.ts, this file is a detector, so it names the widgets' scripts, frames and classes. The
 * repo's evasion guard (cli/botwall.test.ts) lets only detector files name them. See INTEGRATE.md.
 *
 * The doc links and test keys were written from memory (Nov 2026) and have not been checked online:
 * DOCS_CHECKED is false until someone opens each link.
 */
import type { Locator, Page, Response } from "playwright";
import { botWall, CLOUDFLARE } from "./botwall.ts";
import { accessRefusal } from "./access.ts";
import { withoutSecrets } from "./cache.ts";
import { withoutPathSecrets } from "./applog.ts";
import type { BlockedGroup, DetectProtection, ProtectionFinding, ProtectionKind, ProtectionProbe } from "../../../../cli/app/contracts.ts";

/** Every doc URL and test key below came from memory. Nobody has opened them to check. */
export const DOCS_CHECKED = false;

// ---------------------------------------------------------------------------------------------------
// The providers' published test keys (public values, not secrets)
// ---------------------------------------------------------------------------------------------------

/** Google's reCAPTCHA v2 test keys: every check passes, and the widget says it is for testing. */
export const RECAPTCHA_TEST = { site: "6LeIxAcTAAAAAJcZVRqy" + "Hh71UMIEGNQ_MXjiZKhI", secret: "6LeIxAcTAAAAAGG-vFI1" + "TnRWxMZNFuojJ4WifJWe" } as const;
/** hCaptcha's test keys ("publisher" account): every check passes. */
export const HCAPTCHA_TEST = { site: "10000000-ffff-ffff-ffff-000000000001", secret: "0x0000000000000000000000000000000000000000" } as const;
/** hCaptcha Enterprise's other test site keys: a safe user, and a user flagged as a bot. */
const HCAPTCHA_OTHER_TEST = ["20000000-ffff-ffff-ffff-000000000002", "30000000-ffff-ffff-ffff-000000000003"];
/** Turnstile's test site keys. 1x passes, 2x blocks and 3x forces an interactive challenge. AA is visible and BB invisible. */
export const TURNSTILE_TEST = {
  passVisible: "1x00000000000000000000AA",
  passInvisible: "1x00000000000000000000BB",
  blockVisible: "2x00000000000000000000AB",
  blockInvisible: "2x00000000000000000000BB",
  interactive: "3x00000000000000000000FF",
  secretPass: "1x0000000000000000000000000000000AA",
} as const;
const TURNSTILE_TEST_KEY = /^[123]x0{20}(AA|AB|BB|FF)$/;

// ---------------------------------------------------------------------------------------------------
// Docs and setup lines
// ---------------------------------------------------------------------------------------------------

/** The provider's own page on its test mode. These links are from memory and unchecked (DOCS_CHECKED). */
export const DOC_URLS: Record<ProtectionKind, string> = {
  recaptcha: "https://developers.google.com/recaptcha/docs/faq",
  hcaptcha: "https://docs.hcaptcha.com/#integration-testing-test-keys",
  turnstile: "https://developers.cloudflare.com/turnstile/troubleshooting/testing/",
  cloudflare_challenge: "https://developers.cloudflare.com/waf/custom-rules/skip/",
  clerk_bot: "https://clerk.com/docs/testing/overview",
  auth0_bot: "https://auth0.com/docs/secure/attack-protection/bot-detection",
  vercel_protection: "https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation",
  netlify_protection: "https://docs.netlify.com/security/secure-access-to-sites/password-protection/",
  basic_auth: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Authentication",
  unknown_captcha: "",
};
const VERCEL_FIREWALL_DOC = "https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules";

const short = (key: string) => (key.length > 12 ? `${key.slice(0, 8)}…` : key);

/** The one-line test-mode setup for the owner. Names and public test keys only, never a secret of theirs. */
export function setupLine(kind: ProtectionKind, host: string, o: { v3?: boolean; checkpoint?: boolean; clerkLive?: boolean } = {}): string {
  switch (kind) {
    case "recaptcha":
      return o.v3
        ? `reCAPTCHA v3 has no test key: give this environment its own key and let your server accept that key's tokens whatever the score (or use the v2 test keys, site key ${RECAPTCHA_TEST.site}, with data-size="invisible").`
        : `On this environment use Google's test keys (site key ${RECAPTCHA_TEST.site}, secret ${RECAPTCHA_TEST.secret}) with data-size="invisible", so every check passes and no box needs a press.`;
    case "hcaptcha":
      return `On this environment use hCaptcha's test keys (site key ${HCAPTCHA_TEST.site}, secret ${HCAPTCHA_TEST.secret}) with data-size="invisible", so every check passes and no box needs a press.`;
    case "turnstile":
      return `On this environment use Turnstile's always-pass test keys: site key ${TURNSTILE_TEST.passVisible} (or ${TURNSTILE_TEST.passInvisible} for invisible) and secret ${TURNSTILE_TEST.secretPass}.`;
    case "cloudflare_challenge":
      return `In Cloudflare, add a WAF custom rule that skips the challenge on ${host} for a header only your tests send, and store that header with npx contextmachines accounts site header --url ${host} (or use an Access service token: accounts site cf-id and cf-secret).`;
    case "clerk_bot":
      return o.clerkLive
        ? `Clerk's Testing Tokens work on development instances only: point this environment at your Clerk development instance (pk_test_ key), then store its secret key with npx contextmachines accounts site clerk --url ${host}.`
        : `Add "clerk" with your publishable key for ${host} under "sites" in contextmachines.config.json, and store the development instance's secret key with npx contextmachines accounts site clerk --url ${host}: each run then gets a Clerk Testing Token, which skips bot protection.`;
    case "auth0_bot":
      return `In the Auth0 dashboard (Security > Attack Protection > Bot Detection) on your test tenant, add the test machine's IP address to the allowlist or set Bot Detection to Never.`;
    case "vercel_protection":
      return o.checkpoint
        ? `Add a Vercel Firewall custom rule that bypasses the challenge for a header only your tests send, and store that header with npx contextmachines accounts site header --url ${host}.`
        : `Turn on Protection Bypass for Automation in the Vercel project and store its secret with npx contextmachines accounts site vercel --url ${host} (it is sent as x-vercel-protection-bypass to this host only).`;
    case "netlify_protection":
      return `Protect this deploy with a basic-auth login (a Basic-Auth rule in _headers) and store it with npx contextmachines accounts site basic --url ${host}.`;
    case "basic_auth":
      return `Add "basic" for ${host} under "sites" in contextmachines.config.json and store its password with npx contextmachines accounts site basic --url ${host}.`;
    case "unknown_captcha":
      return `Context Machines doesn't know this check's test mode: turn the check off on this environment, or ask its provider for test keys.`;
  }
}

// ---------------------------------------------------------------------------------------------------
// The probe: what the page loaded and shows (read only)
// ---------------------------------------------------------------------------------------------------

/** A widget found in the page by its attributes. */
export interface ProbeWidget {
  kind: ProtectionKind;
  key: string;
  /** data-size="invisible": it runs on submit, with no box to press. */
  invisible: boolean;
  /** It has a box on screen. */
  shown: boolean;
}

/** What the contract's probe doesn't carry yet (INTEGRATE.md asks for these fields). */
export interface ProbeMarks {
  widgets: ProbeWidget[];
  /** Clerk's bot-protection mount point is on the page. */
  clerkCaptcha: boolean;
  /** Clerk's publishable key, if the page names one (public; pk_test_ or pk_live_). */
  clerkKey?: string;
  /** A captcha box on an Auth0 login page. */
  auth0Captcha: boolean;
  /** reCAPTCHA's badge (v3 or invisible). */
  recaptchaBadge: boolean;
  /** botwall.ts's verdict: the check that stands, in its words, or nothing. */
  wall?: string;
  /** Netlify's password page form. */
  netlifyPassword: boolean;
}

export type ProbePlus = ProtectionProbe & { marks?: ProbeMarks };

interface InPage {
  scripts: string[];
  resources: string[];
  title: string;
  text: string;
  widgets: ProbeWidget[];
  clerkCaptcha: boolean;
  clerkKey?: string;
  auth0Captcha: boolean;
  recaptchaBadge: boolean;
  netlifyPassword: boolean;
}

/** Runs in the page: reads, never acts. Self-contained. */
function readInPage(): InPage {
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const widgets: ProbeWidget[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-sitekey]"))) {
    const cls = ` ${(el.getAttribute("class") ?? "").toLowerCase()} `;
    const kind: ProtectionKind = / cf-turnstile /.test(cls) ? "turnstile" : / h-captcha /.test(cls) ? "hcaptcha" : / g-recaptcha /.test(cls) ? "recaptcha" : "unknown_captcha";
    widgets.push({ kind, key: (el.getAttribute("data-sitekey") ?? "").slice(0, 80), invisible: (el.getAttribute("data-size") ?? "") === "invisible", shown: shown(el) });
  }
  const keyed = document.querySelector("[data-clerk-publishable-key]");
  const clerkKey = keyed?.getAttribute("data-clerk-publishable-key") ?? undefined;
  return {
    scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean).slice(0, 200),
    resources: performance.getEntriesByType("resource").map((e) => e.name).slice(0, 400),
    title: document.title,
    text: ((document.body as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
    widgets,
    clerkCaptcha: Boolean(document.getElementById("clerk-captcha")),
    ...(clerkKey ? { clerkKey: clerkKey.slice(0, 120) } : {}),
    auth0Captcha: Boolean(document.querySelector("input[name=captcha], [class*=captcha], [id*=captcha]")),
    recaptchaBadge: Boolean(document.querySelector(".grecaptcha-badge")),
    netlifyPassword: Boolean(document.querySelector("form[action*='.netlify'], input[name=password][form*=netlify]")),
  };
}

/**
 * What the page loaded and shows, for detectProtection. It only reads the page. `response` is the
 * main document's answer (its status and headers). `mask` hides known values in the page's words.
 */
export async function probePage(page: Page, o: { response?: Response | null; mask?: (s: string) => string } = {}): Promise<ProbePlus> {
  const mask = o.mask ?? ((s: string) => s);
  const read = await page.evaluate(readInPage).catch((): InPage => ({ scripts: [], resources: [], title: "", text: "", widgets: [], clerkCaptcha: false, auth0Captcha: false, recaptchaBadge: false, netlifyPassword: false }));
  const frames = page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url()).filter((u) => /^https?:/.test(u));
  const headers = o.response ? await o.response.allHeaders().catch(() => o.response!.headers()) : {};
  const wall = (await botWall(page).catch(() => undefined)) ?? (await humanCheck(page));
  const scripts = [...new Set([...read.scripts, ...read.resources])];
  const sitekeys = [...read.widgets.map((w) => ({ kind: w.kind, key: w.key })), ...keysFromUrls([...scripts, ...frames])];
  return {
    // Masked (the run's values), not cut: a script's query carries the site key (render=, k=) the detector reads.
    scripts: scripts.map(mask),
    frames: frames.map(mask),
    headers: safeHeaders(headers),
    status: o.response?.status() ?? 200,
    // The address as a finding may show it: no user or password, no token in the query or path, and the run's values masked.
    url: mask(withoutPathSecrets(withoutSecrets(page.url()))),
    title: mask(read.title),
    text: mask(read.text),
    sitekeys,
    marks: {
      widgets: read.widgets,
      clerkCaptcha: read.clerkCaptcha,
      ...(read.clerkKey ? { clerkKey: read.clerkKey } : {}),
      auth0Captcha: read.auth0Captcha,
      recaptchaBadge: read.recaptchaBadge,
      ...(wall ? { wall } : {}),
      netlifyPassword: read.netlifyPassword,
    },
  };
}

/** Headers that carry a session or a credential: never kept in the probe, which the detector doesn't need them for. */
const SECRET_HEADERS = /^(set-cookie|cookie|authorization|proxy-authorization|x-vercel-protection-bypass|x-vercel-set-bypass-cookie|cf-access-[\w-]+|x-api-key|x-auth-token)$/i;
/** The main document's headers, keys in lower case, without the ones that carry a secret. */
export const safeHeaders = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).filter(([k]) => !SECRET_HEADERS.test(k)).map(([k, v]) => [k.toLowerCase(), v]));

// ---------------------------------------------------------------------------------------------------
// The providers' marks
// ---------------------------------------------------------------------------------------------------

const RECAPTCHA_URL = /^https?:\/\/(www\.)?(google|recaptcha)\.(com|net)\/recaptcha\/(api|enterprise|api2|releases)\b/i;
const RECAPTCHA_ENTERPRISE = /\/recaptcha\/enterprise/i;
const HCAPTCHA_URL = /^https?:\/\/([\w-]+\.)*hcaptcha\.com\//i;
const TURNSTILE_URL = /^https?:\/\/challenges\.cloudflare\.com\/(turnstile|cdn-cgi\/challenge-platform\/[\w/.-]*turnstile)/i;
const CF_CHALLENGE_URL = /\/cdn-cgi\/challenge-platform\//i;
const CLERK_URL = /clerk(\.browser)?(\.min)?\.js\b|@clerk\/clerk-js|^https?:\/\/[\w-]+\.clerk\.accounts\.dev\/|^https?:\/\/clerk\.[\w.-]+\/(v1|npm)\//i;
const AUTH0_URL = /^https?:\/\/([\w-]+\.)*auth0\.com\/|^https?:\/\/cdn\.auth0\.com\//i;

/** Site keys named in a script's or frame's address: v3's render=, the anchor's k=, hCaptcha's sitekey=. */
function keysFromUrls(urls: readonly string[]): { kind: ProtectionKind; key: string }[] {
  const out: { kind: ProtectionKind; key: string }[] = [];
  for (const u of urls) {
    if (RECAPTCHA_URL.test(u)) {
      const m = /[?&](render|k)=([\w-]{20,60})/.exec(u);
      if (m && m[2] !== "explicit") out.push({ kind: "recaptcha", key: m[2]! });
    } else if (HCAPTCHA_URL.test(u)) {
      const m = /[?&#]sitekey=([\w-]{20,60})/.exec(u);
      if (m) out.push({ kind: "hcaptcha", key: m[1]! });
    } else if (TURNSTILE_URL.test(u)) {
      const m = /\/(0x[\w-]{10,40}|[123]x0{20}[A-F]{2})(\/|$|\?)/.exec(u);
      if (m) out.push({ kind: "turnstile", key: m[1]! });
    }
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};
const pathOf = (url: string) => {
  try {
    const path = new URL(withoutPathSecrets(url)).pathname;
    // A masked value reads as {name}, not %7Bname%7D.
    return path.replace(/%7B([\w.-]{1,60})%7D/gi, "{$1}").slice(0, 120);
  } catch {
    return "/";
  }
};
const urlHostPath = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 80);
  } catch {
    return u.slice(0, 80);
  }
};

const testKey = (kind: ProtectionKind, key: string): { test: boolean; passes: boolean } => {
  if (kind === "recaptcha") return { test: key === RECAPTCHA_TEST.site, passes: key === RECAPTCHA_TEST.site };
  if (kind === "hcaptcha") {
    if (key === HCAPTCHA_TEST.site || key === HCAPTCHA_OTHER_TEST[0]) return { test: true, passes: true };
    return { test: key === HCAPTCHA_OTHER_TEST[1], passes: false };
  }
  if (kind === "turnstile") return { test: TURNSTILE_TEST_KEY.test(key), passes: /^1x/.test(key) };
  return { test: false, passes: false };
};

// ---------------------------------------------------------------------------------------------------
// detectProtection
// ---------------------------------------------------------------------------------------------------

export interface DetectOptions {
  /** A Clerk Testing Token is set up for this host (OwnerAccess.clerk): bot protection is skipped. */
  clerkToken?: boolean;
  step?: number;
  at?: number;
}

/**
 * Every protection the probe shows, named, with its test mode and whether it stands in the way. Pure.
 * `setup` and `docUrl` are given only when `owned` is true (C27).
 */
export const detectProtection: DetectProtection & ((probe: ProbePlus, owned: boolean, o?: DetectOptions) => ProtectionFinding[]) = (probe: ProbePlus, owned: boolean, o: DetectOptions = {}) => {
  const host = hostOf(probe.url);
  const page = pathOf(probe.url);
  const marks = probe.marks;
  const urls = [...probe.scripts, ...probe.frames];
  const out: ProtectionFinding[] = [];
  const add = (kind: ProtectionKind, name: string, f: { testMode: boolean; blocking: boolean; evidence: string; setupOpts?: Parameters<typeof setupLine>[2]; doc?: string }) => {
    if (out.some((x) => x.kind === kind)) return;
    out.push({
      kind,
      name,
      host,
      page,
      owned,
      testMode: f.testMode,
      blocking: f.blocking,
      // A check already in test mode that doesn't block needs nothing done: no setup line to act on.
      ...(owned && !(f.testMode && !f.blocking) ? { setup: setupLine(kind, host, f.setupOpts) } : {}),
      ...(owned && (f.doc ?? DOC_URLS[kind]) ? { docUrl: f.doc ?? DOC_URLS[kind] } : {}),
      evidence: f.evidence.slice(0, 300),
      ...(o.step !== undefined ? { step: o.step } : {}),
      ...(o.at !== undefined ? { at: o.at } : {}),
    });
  };
  const wall = marks?.wall;
  const headers = probe.headers;

  // Host-level protection first: nothing of the site showed.
  const refusal = accessRefusal({ status: probe.status, headers, url: probe.url, title: probe.title, text: probe.text });
  const netlify = /netlify/i.test(headers["server"] ?? "") || "x-nf-request-id" in headers;
  const vercel = /vercel/i.test(headers["server"] ?? "") || "x-vercel-id" in headers;
  if (netlify && (probe.status === 401 || marks?.netlifyPassword || /\bpassword protected\b|\bthis site is protected\b/i.test(probe.text))) {
    add("netlify_protection", "Netlify site protection", { testMode: false, blocking: true, evidence: `HTTP ${probe.status} from Netlify (${"x-nf-request-id" in headers ? "x-nf-request-id" : "server: Netlify"})${marks?.netlifyPassword ? ", password form" : ""}` });
  } else if (refusal?.code === "VERCEL_BYPASS_REQUIRED") {
    add("vercel_protection", "Vercel Deployment Protection", { testMode: false, blocking: true, evidence: `HTTP ${probe.status} from Vercel: ${refusal.why}` });
  } else if (refusal?.code === "AUTH_BASIC_REQUIRED") {
    add("basic_auth", "HTTP basic auth", { testMode: false, blocking: true, evidence: `HTTP 401 with www-authenticate: Basic` });
  }
  if (vercel && (/vercel security checkpoint/i.test(probe.title) || /challenge/i.test(headers["x-vercel-mitigated"] ?? ""))) {
    add("vercel_protection", "Vercel Security Checkpoint", { testMode: false, blocking: true, evidence: `${/checkpoint/i.test(probe.title) ? "title: Vercel Security Checkpoint" : ""}${headers["x-vercel-mitigated"] ? ` x-vercel-mitigated: ${headers["x-vercel-mitigated"].slice(0, 20)}` : ""}`.trim(), setupOpts: { checkpoint: true }, doc: VERCEL_FIREWALL_DOC });
  }

  // Cloudflare's challenge page (not Turnstile in a form): botwall.ts says it stands, or Cloudflare says it challenged.
  const cfMitigated = /challenge/i.test(headers["cf-mitigated"] ?? "");
  const cfScript = urls.some((u) => CF_CHALLENGE_URL.test(u) && !TURNSTILE_URL.test(u));
  if (wall === CLOUDFLARE || cfMitigated) {
    add("cloudflare_challenge", "Cloudflare challenge page", { testMode: false, blocking: true, evidence: [cfMitigated ? "cf-mitigated: challenge" : "", wall ? `bot check stands (${wall})` : "", cfScript ? "challenge-platform script" : ""].filter(Boolean).join("; ") });
  }

  // Login providers whose bot checks wrap a captcha: named as the provider, not the captcha inside.
  const clerk = urls.some((u) => CLERK_URL.test(u)) || Boolean(marks?.clerkKey);
  if (clerk && marks?.clerkCaptcha) {
    const live = /^pk_live_/.test(marks.clerkKey ?? "");
    const token = Boolean(o.clerkToken) && !live;
    add("clerk_bot", "Clerk bot protection", { testMode: token, blocking: !token, evidence: `Clerk script${marks.clerkKey ? ` (${marks.clerkKey.slice(0, 8)}… key)` : ""} and its bot-protection mount on the page${token ? "; Testing Token set" : ""}`, setupOpts: { clerkLive: live } });
  }
  const auth0 = /(^|\.)auth0\.com$/i.test(host.replace(/:\d+$/, "")) || urls.some((u) => AUTH0_URL.test(u));
  if (auth0 && (marks?.auth0Captcha || urls.some((u) => RECAPTCHA_URL.test(u) || HCAPTCHA_URL.test(u)))) {
    add("auth0_bot", "Auth0 Bot Detection", { testMode: false, blocking: true, evidence: `Auth0 login page with a captcha${wall ? ` (bot check stands: ${wall})` : ""}` });
  }
  const wrapped = out.some((f) => f.kind === "clerk_bot" || f.kind === "auth0_bot");

  // The captcha widgets.
  if (!wrapped) {
    const widgets = marks?.widgets ?? [];
    const keyOf = (kind: ProtectionKind) => widgets.find((w) => w.kind === kind)?.key ?? probe.sitekeys.find((k) => k.kind === kind)?.key;
    const widgetOf = (kind: ProtectionKind) => widgets.find((w) => w.kind === kind);

    const recaptchaScript = urls.find((u) => RECAPTCHA_URL.test(u));
    if (recaptchaScript || widgetOf("recaptcha")) {
      const key = keyOf("recaptcha") ?? "";
      const enterprise = urls.some((u) => RECAPTCHA_ENTERPRISE.test(u));
      const w = widgetOf("recaptcha");
      const v3 = !w && (urls.some((u) => RECAPTCHA_URL.test(u) && /[?&]render=(?!explicit)[\w-]{20,}/.test(u)) || Boolean(marks?.recaptchaBadge));
      const t = testKey("recaptcha", key);
      const needsPress = Boolean(w?.shown && !w.invisible);
      const blocking = (wall !== undefined && !t.passes) || (needsPress && !(t.passes && w?.invisible));
      add("recaptcha", `Google reCAPTCHA ${enterprise ? "Enterprise" : v3 ? "v3" : "v2"}`, { testMode: t.test, blocking, evidence: [recaptchaScript ? `script ${urlHostPath(recaptchaScript)}` : "", key ? `sitekey ${short(key)}${t.test ? " (Google's test key)" : ""}` : "", w ? (w.invisible ? "invisible widget" : "checkbox widget") : v3 ? "score only (v3)" : ""].filter(Boolean).join("; "), setupOpts: { v3 } });
    }

    const hcaptchaScript = urls.find((u) => HCAPTCHA_URL.test(u));
    if (hcaptchaScript || widgetOf("hcaptcha")) {
      const key = keyOf("hcaptcha") ?? "";
      const w = widgetOf("hcaptcha");
      const t = testKey("hcaptcha", key);
      const needsPress = Boolean(w?.shown && !w.invisible);
      const blocking = (wall !== undefined && !t.passes) || (needsPress && !(t.passes && w?.invisible)) || (t.test && !t.passes);
      add("hcaptcha", "hCaptcha", { testMode: t.test, blocking, evidence: [hcaptchaScript ? `script ${urlHostPath(hcaptchaScript)}` : "", key ? `sitekey ${short(key)}${t.test ? " (hCaptcha's test key)" : ""}` : "", w ? (w.invisible ? "invisible widget" : "checkbox widget") : ""].filter(Boolean).join("; ") });
    }

    const turnstileScript = urls.find((u) => TURNSTILE_URL.test(u));
    if (turnstileScript || widgetOf("turnstile")) {
      const key = keyOf("turnstile") ?? "";
      const w = widgetOf("turnstile");
      const t = testKey("turnstile", key);
      // A test key's own promise decides: 1x passes; 2x blocks; 3x always asks a person. A real key in view may ask.
      const blocking = t.test ? !t.passes : wall !== undefined || Boolean(w?.shown && !w.invisible);
      add("turnstile", "Cloudflare Turnstile", { testMode: t.test, blocking, evidence: [turnstileScript ? `script ${urlHostPath(turnstileScript)}` : "", key ? `sitekey ${short(key)}${t.test ? ` (Turnstile's ${t.passes ? "always-pass" : /^3x/.test(key) ? "always-interactive" : "always-block"} test key)` : ""}` : "", w ? (w.invisible ? "invisible widget" : "widget") : ""].filter(Boolean).join("; ") });
    }
  }

  // A check stands that none of the above names: an unknown captcha, said honestly.
  if (wall && !out.some((f) => f.blocking)) {
    add("unknown_captcha", wall, { testMode: false, blocking: true, evidence: `bot check stands (${wall})` });
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------
// What the run says
// ---------------------------------------------------------------------------------------------------

/** The step's BLOCKED reason for a finding that stands in the way, in one line. */
export function protectionReason(f: ProtectionFinding): string {
  const base = `${f.host} uses ${f.name}, and it stood in the way of the test browser. Context Machines doesn't get past bot checks`;
  if (!f.owned) return `${base}. Only the site's owner can turn on a test mode for it; try a site you own, or its staging address.`;
  if (f.testMode) return `${base}. A test key is set, but this one ${f.kind === "turnstile" ? "is a blocking or interactive test key" : "still needs a press"}: ${f.setup ?? ""}`.trim();
  return `${base}. This site is yours: ${f.setup ?? ""}`.trim();
}

/** The run's end when a protection stands: BLOCKED in the bot_wall group, or nothing when none blocks. */
export function protectionEnd(findings: readonly ProtectionFinding[]): { verdict: "blocked"; reason: string; blockedGroup: BlockedGroup; finding: ProtectionFinding } | undefined {
  const f = findings.find((x) => x.blocking);
  if (!f) return undefined;
  const group: BlockedGroup = f.kind === "basic_auth" || f.kind === "vercel_protection" || f.kind === "netlify_protection" ? "environment" : "bot_wall";
  return { verdict: "blocked", reason: protectionReason(f), blockedGroup: group, finding: f };
}

/** Whether a finding is one a person can get past by hand (in Set up sign-in's window): a widget or a challenge page, not a login wall. */
export function canHandOver(f: ProtectionFinding): boolean {
  if (!f.blocking) return false;
  if (f.kind === "basic_auth" || f.kind === "netlify_protection") return false;
  return f.kind !== "vercel_protection" || f.name === "Vercel Security Checkpoint";
}

// ---------------------------------------------------------------------------------------------------
// What the run asks while it goes (run.ts). Read only, like everything above.
// ---------------------------------------------------------------------------------------------------

/** What a site's own "type the word in the picture" check is called in a step's reason. */
export const HUMAN_CHECK = "a \"verify you are human\" picture check";

/**
 * A site's own human check that botwall.ts doesn't take for a wall because it has a field: a page
 * whose title or main heading asks the visitor to prove they are human, with a field that asks for the
 * word, text or characters in a picture. Both must hold, so a sign-up form that mentions robots isn't one.
 */
export async function humanCheck(page: Page): Promise<string | undefined> {
  const found = await page
    .evaluate(() => {
      const ASKS = /\b(verify (that )?you('re| are) (a )?human|are you (a )?(human|robot)|prove (that )?you('re| are) (human|not a robot)|human verification)\b/i;
      const PICTURE = /\b(word|words|text|characters|letters|code)\b.{0,30}\b(picture|image)\b|\btype (the )?(word|text|characters|letters) you see\b/i;
      const head = `${document.title} ${document.querySelector("h1")?.textContent ?? ""}`;
      if (!ASKS.test(head)) return false;
      const fields = Array.from(document.querySelectorAll("input:not([type=hidden]), textarea")) as HTMLInputElement[];
      return fields.some((f) => {
        const label = `${f.labels?.[0]?.textContent ?? ""} ${f.getAttribute("aria-label") ?? ""} ${f.getAttribute("placeholder") ?? ""}`;
        return PICTURE.test(label);
      });
    })
    .catch(() => false);
  return found ? HUMAN_CHECK : undefined;
}

/**
 * Whether pressing (or pressing Enter in) this element would send a form that holds a captcha widget
 * no one has passed (its answer field is empty): the send the check stands in front of. Read only.
 */
export async function guardedSend(el: Locator): Promise<boolean> {
  return el
    .evaluate((e) => {
      const form = (e as HTMLButtonElement).form ?? e.closest("form");
      if (!form) return false;
      return Array.from(form.querySelectorAll("[data-sitekey]")).some((w) => {
        if ((w.getAttribute("data-size") ?? "") === "invisible") return false;
        const answer = w.querySelector("textarea[name$='-response'], input[name$='-response']") as HTMLTextAreaElement | null;
        return !answer || !answer.value;
      });
    }, undefined, { timeout: 2000 })
    .catch(() => false);
}

/** Whether a captcha widget on the page is still unpassed (is it gone?). Read only; a failed read is "still there". */
export async function unsolvedWidget(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("[data-sitekey]")).some((w) => {
        if ((w.getAttribute("data-size") ?? "") === "invisible") return false;
        const answer = w.querySelector("textarea[name$='-response'], input[name$='-response']") as HTMLTextAreaElement | null;
        return !answer || !answer.value;
      }),
    )
    .catch(() => true);
}

/** The kinds that sit in a form (a box to pass before a send), not in front of the whole site. */
export const WIDGET_KINDS: readonly ProtectionKind[] = ["recaptcha", "hcaptcha", "turnstile", "clerk_bot", "auth0_bot"];

/**
 * E10 for every caller (a run never waits for a person): the BLOCKED reason when a press would send a form whose
 * captcha box no one has passed, or nothing. `el` is what the press lands on (the focused element for
 * Enter or Space). Read only: the box is never touched, and nothing is pressed here.
 */
export async function sendHeldByWidget(page: Page, el: Locator, o: { owned?: boolean; mask?: (s: string) => string } = {}): Promise<{ reason: string; finding: ProtectionFinding } | undefined> {
  if (!(await guardedSend(el))) return undefined;
  const f = detectProtection(await probePage(page, o.mask ? { mask: o.mask } : {}), Boolean(o.owned)).find((x) => x.blocking && WIDGET_KINDS.includes(x.kind));
  if (!f || !(await unsolvedWidget(page))) return undefined;
  return { reason: protectionReason(f), finding: f };
}
