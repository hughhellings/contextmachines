/**
 * Owner access (AUTH C15, D2, D11): what a site's owner issued for their own site (a Vercel bypass
 * secret, a Cloudflare Access service token, a basic-auth login, one header of their own, a marker),
 * sent only to that exact host; and the one named exception, a Clerk Testing Token, sent as a query
 * parameter only, to /v1/ on the Frontend API host the owner's own publishable key names.
 *
 * The values are built and checked in cli/accounts.ts, where the allowlist of header names and
 * the refused names live. Here: only the exact-host rule, the Clerk rule, and what a page that turned
 * the browser away was asking for. guardSite (act.ts) is the only place that sends any of it: through
 * route.fetch with no redirect followed, then route.fulfill, so a redirect to another host never
 * carries it. Never through route.continue or route.fallback, and never as a browser or context
 * option (a guard test, cli/access.test.ts, reads the code for each).
 */

/** What may go to one owner host this run. Every value in it is a secret, masked from everything shown. */
export interface OwnerAccess {
  /** The exact host, port included ("staging.example.com", "127.0.0.1:4517"): never a subdomain or a sibling. */
  host: string;
  /** Header name (lower case) → value. */
  headers: Readonly<Record<string, string>>;
  /** A Clerk Testing Token, for the Frontend API host decoded from the owner's publishable key. */
  clerk?: { fapiHost: string; token: string };
  /** What was set, so a refusal can say what's missing. */
  kinds: { basic: boolean; vercel: boolean; tokens: boolean };
  /** Every secret value in it (and the forms it is sent in), for the masker. */
  values: readonly string[];
}

/** The only header names ever sent: an owner's own x- header, a basic-auth login, Cloudflare Access's pair. */
const HEADER_NAME = /^(x-[a-z0-9-]{1,60}|authorization|cf-access-client-(id|secret))$/;

const parse = (url: string): URL | undefined => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u : undefined;
  } catch {
    return undefined;
  }
};

/** A host on this machine, where plain http stays on it. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$|\.localhost(:\d+)?$/i;

/**
 * The owner's headers for this address, or nothing: only when its host is exactly the owner's, and
 * over https (plain http only on this machine), so a token never crosses the network in clear text.
 */
export function ownerHeadersFor(access: OwnerAccess | undefined, url: string): Record<string, string> | undefined {
  if (!access) return undefined;
  const u = parse(url);
  if (!u || u.host !== access.host) return undefined;
  if (u.protocol !== "https:" && !LOOPBACK.test(u.host)) return undefined;
  const out = Object.fromEntries(Object.entries(access.headers).filter(([k, v]) => HEADER_NAME.test(k) && typeof v === "string" && v.length > 0));
  return Object.keys(out).length ? out : undefined;
}

/** This address with the Clerk Testing Token added, or nothing: only for /v1/ on the owner's Frontend API host. */
export function clerkTokenUrl(access: OwnerAccess | undefined, url: string): string | undefined {
  if (!access?.clerk) return undefined;
  const u = parse(url);
  if (!u || u.host !== access.clerk.fapiHost || !u.pathname.startsWith("/v1/")) return undefined;
  if (u.protocol !== "https:" && !LOOPBACK.test(u.host)) return undefined;
  u.searchParams.set("__clerk_testing_token", access.clerk.token);
  return u.href;
}

/** A page that turned the browser away before the site showed: what it asked for, as a code, and why in words. */
export interface AccessRefusal {
  code: "AUTH_BASIC_REQUIRED" | "VERCEL_BYPASS_REQUIRED";
  why: string;
}

/**
 * Whether the first answer of a site was its host asking for a login the run doesn't have: HTTP basic
 * auth (a 401 that says Basic), or Vercel's deployment protection (a 401 or 403 from Vercel saying
 * "Authentication Required", or a hop to vercel.com's sign-in). Measured, no AI.
 */
export function accessRefusal(a: { status: number; headers: Record<string, string>; url: string; title: string; text: string }, access?: OwnerAccess): AccessRefusal | undefined {
  const host = parse(a.url)?.host ?? a.url.slice(0, 60);
  if (a.status === 401 && /^\s*basic\b/i.test(a.headers["www-authenticate"] ?? "")) {
    return { code: "AUTH_BASIC_REQUIRED", why: access?.kinds.basic ? `${host} refused the basic-auth login set for it` : `${host} asks for a basic-auth login (a browser sign-in box), and none is set for it` };
  }
  const vercel = /vercel/i.test(a.headers["server"] ?? "") || "x-vercel-id" in a.headers;
  const vercelLogin = /(^|\.)vercel\.com$/i.test(parse(a.url)?.hostname ?? "") && /sso-api|\/login/i.test(parse(a.url)?.pathname ?? "");
  if (vercelLogin || (vercel && (a.status === 401 || a.status === 403) && /authentication required|vercel authentication|log in to vercel/i.test(`${a.title} ${a.text.slice(0, 2000)}`))) {
    return { code: "VERCEL_BYPASS_REQUIRED", why: access?.kinds.vercel ? `${host} still asked for a Vercel login with the bypass secret set: is it this deployment's?` : `${host} is behind Vercel's deployment protection, and no bypass secret is set for it` };
  }
  return undefined;
}

/**
 * Sign-in providers' own pages, where nothing is ever typed (C13, D6): Google, Microsoft and Apple
 * forbid or don't allow automated sign-in, and GitHub is left out for now. Their exact hosts and any
 * host under them.
 */
export const PROVIDER_HOSTS: readonly string[] = [
  "accounts.google.com", "accounts.youtube.com",
  "login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net", "account.microsoft.com", "account.live.com",
  "appleid.apple.com", "idmsa.apple.com", "account.apple.com",
  "github.com",
];

/** Whether an address is a sign-in provider's page (listed, or one a test names). */
export function onProvider(url: string, extra: readonly string[] = []): boolean {
  const u = parse(url);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  if (extra.some((x) => x.toLowerCase() === u.host.toLowerCase() || x.toLowerCase() === h)) return true;
  return PROVIDER_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}
