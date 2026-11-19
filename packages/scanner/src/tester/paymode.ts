/**
 * Is this checkout in the payment provider's test mode? (D14: pay only on owned hosts with the
 * provider in test mode; live keys are BLOCKED.) A pure function over what the browser can see: the
 * page's address, every frame's address, script sources, keys written in the page, and its words.
 *
 * The answer is "test", "live" or "unknown", per provider and in all:
 *   - a live marker anywhere wins, whatever else the page shows (a pk_test_ page that sends to a
 *     cs_live_ session is live);
 *   - a provider seen with no marker either way is unknown;
 *   - no provider seen at all is unknown (a gateway we don't know may be taking real money);
 *   - only "test" may pay (`mayPay`). Unknown is treated as live.
 *
 * Markers, as the providers document them (from memory of their docs; not re-fetched this session,
 * as this lane may not open real sites):
 *   Stripe   keys pk_/sk_/rk_ + test_/live_ (https://docs.stripe.com/keys); Checkout Session ids
 *            cs_test_/cs_live_, hosted at checkout.stripe.com/c/pay/<id>
 *            (https://docs.stripe.com/payments/checkout); test Payment Links at
 *            buy.stripe.com/test_<id> (https://docs.stripe.com/payment-links); Elements frames on
 *            js.stripe.com carry the publishable key in their address.
 *   PayPal   sandbox hosts www.sandbox.paypal.com and api-m.sandbox.paypal.com, live without
 *            "sandbox" (https://developer.paypal.com/api/rest/urls/,
 *            https://developer.paypal.com/tools/sandbox/); the JS SDK is served from www.paypal.com
 *            for both, so /sdk/js alone says nothing; its button frames carry env=sandbox or
 *            env=production; client-id=sb is the SDK's sandbox shortcut. A client id alone doesn't
 *            say which (e2e-paypal's lib/paypal.ts says the same).
 *   Paddle   API keys pdl_sdbx_ / pdl_live_, client-side tokens test_ / live_, Paddle.js
 *            Environment.set("sandbox"), sandbox hosts sandbox-*.paddle.com
 *            (https://developer.paddle.com/build/tools/sandbox,
 *            https://developer.paddle.com/paddlejs/methods/paddle-environment-set).
 *   Shopify  no key and no sandbox host on the checkout; the test gateway shows as
 *            "(for testing) Bogus Gateway" (https://help.shopify.com/en/manual/checkout-settings/test-orders).
 *            Without it a Shopify checkout is unknown, so blocked.
 *   Others   seen only so a checkout with them is never "test" by mistake: Adyen
 *            checkoutshopper-test / -live hosts; Braintree sandbox_ / production_ tokenization keys
 *            and api.sandbox.braintreegateway.com; Square sandbox.web.squarecdn.com,
 *            squareupsandbox.com, app ids sandbox-sq0idb- / sq0idp-; Razorpay rzp_test_ / rzp_live_
 *            keys and checkout.razorpay.com; Authorize.net jstest./test. (sandbox) vs js./accept.
 *            hosts; Checkout.com sandbox.checkout.com vs its other hosts; Mollie js.mollie.com;
 *            Klarna *.playground.klarna.com (test) vs its other hosts. (Review addition, from
 *            memory, unverified: what matters is that their presence alone stops "test".)
 *
 * A test marker that is only a key or words (not an address) counts only for a provider whose page,
 * frame or script is on the surface (by its host). A stale pk_test_ in a page's source, or a page
 * that prints one, can't make a checkout run by some other gateway "test". A live marker counts
 * wherever it shows.
 *
 * Practice hosts: a host under .localhost is read as the same name under .com (checkout.stripe.localhost
 * as checkout.stripe.com). .localhost only ever reaches this machine, so this lets the local practice
 * sites (sites.ts) go through exactly the rules a real checkout does.
 *
 * Evidence never holds a whole key or session id: the prefix and "…" only.
 */

export type PayMode = "test" | "live" | "unknown";
export type Provider = "stripe" | "paypal" | "paddle" | "shopify" | "adyen" | "braintree" | "square" | "razorpay" | "authorizenet" | "checkoutcom" | "mollie" | "klarna";

/** What the browser sees of a checkout: the page and every frame, as the engine can read them. */
export interface PaySurface {
  /** The page's address, every frame's address (all depths), and script sources. */
  urls: readonly string[];
  /** Key-like strings written in the page or its frames' source (keysIn finds them). Optional: urls and text are scanned too. */
  keys?: readonly string[];
  /** The visible words of the page and its frames. */
  text?: readonly string[];
  /** Frames still on the page whose insides couldn't be read: what they hold is unknown, so never "test". */
  unread?: number;
}

export interface Sighting {
  provider: Provider;
  /** "unknown" here: the provider is present, and this sign says nothing about the mode. */
  mode: PayMode;
  /** Where it was seen, with keys cut to their prefix. */
  why: string;
}

export interface PayModeResult {
  mode: PayMode;
  /** Every provider seen, each with its own mode. */
  providers: { provider: Provider; mode: PayMode }[];
  sightings: Sighting[];
  /** True only when every provider seen is in test mode, and at least one was seen. */
  mayPay: boolean;
  /** One line for a report or a BLOCKED reason. Never holds a whole key. */
  reason: string;
}

/** Key-like tokens: each kept with what it says. Order matters: the first that matches a token wins. */
const KEY_RULES: { re: RegExp; provider: Provider; mode: PayMode; name: string; needsProvider?: true }[] = [
  { re: /\b(?:pk|sk|rk)_test_[A-Za-z0-9]{6,}/g, provider: "stripe", mode: "test", name: "a Stripe test key" },
  { re: /\b(?:pk|sk|rk)_live_[A-Za-z0-9]{6,}/g, provider: "stripe", mode: "live", name: "a Stripe live key" },
  { re: /\bcs_test_[A-Za-z0-9]{6,}/g, provider: "stripe", mode: "test", name: "a Stripe test Checkout Session" },
  { re: /\bcs_live_[A-Za-z0-9]{6,}/g, provider: "stripe", mode: "live", name: "a Stripe live Checkout Session" },
  { re: /\bpdl_sdbx_[A-Za-z0-9_]{6,}/g, provider: "paddle", mode: "test", name: "a Paddle sandbox API key" },
  { re: /\bpdl_live_[A-Za-z0-9_]{6,}/g, provider: "paddle", mode: "live", name: "a Paddle live API key" },
  { re: /\bsandbox_[a-z0-9]{6,}_[a-z0-9]{6,}/g, provider: "braintree", mode: "test", name: "a Braintree sandbox key" },
  { re: /\bproduction_[a-z0-9]{6,}_[a-z0-9]{6,}/g, provider: "braintree", mode: "live", name: "a Braintree production key" },
  { re: /\bsandbox-sq0idb-[A-Za-z0-9_-]{6,}/g, provider: "square", mode: "test", name: "a Square sandbox app id" },
  { re: /\bsq0idp-[A-Za-z0-9_-]{6,}/g, provider: "square", mode: "live", name: "a Square app id" },
  { re: /\brzp_test_[A-Za-z0-9]{6,}/g, provider: "razorpay", mode: "test", name: "a Razorpay test key" },
  { re: /\brzp_live_[A-Za-z0-9]{6,}/g, provider: "razorpay", mode: "live", name: "a Razorpay live key" },
  // test_/live_ tokens (Paddle client tokens, Adyen client keys) are too plain to name a provider on
  // their own: they count only for a provider already seen some other way.
  { re: /\btest_[A-Za-z0-9]{20,}/g, provider: "paddle", mode: "test", name: "a test client token", needsProvider: true },
  { re: /\blive_[A-Za-z0-9]{20,}/g, provider: "paddle", mode: "live", name: "a live client token", needsProvider: true },
];

/** Every key-like token in some text (a page's source, an address): for PaySurface.keys. */
export function keysIn(text: string): string[] {
  const out = new Set<string>();
  for (const r of KEY_RULES) for (const m of text.matchAll(r.re)) out.add(m[0]);
  return [...out];
}

/** A key cut to its prefix, for evidence: "pk_live_…". */
export function cut(key: string): string {
  const m = /^((?:pk|sk|rk|cs)_(?:test|live)_|pdl_(?:sdbx|live)_|rzp_(?:test|live)_|sandbox_|production_|sandbox-sq0idb-|sq0idp-|test_|live_)/.exec(key);
  return `${m ? m[1] : key.slice(0, 3)}…`;
}

/** Some text with every key-like token in it cut to its prefix (for evidence that quotes an address). */
export function redact(text: string): string {
  let out = text;
  for (const r of KEY_RULES) out = out.replace(r.re, (k) => cut(k));
  return out;
}

/** A host as the rules read it: lower case, no trailing dot, a practice .localhost name as .com. */
export function providerHost(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h.endsWith(".localhost") ? `${h.slice(0, -".localhost".length)}.com` : h;
}

const under = (h: string, domain: string) => h === domain || h.endsWith(`.${domain}`);

/** What one address says: its provider and mode, or nothing when it isn't a provider's. */
function fromUrl(raw: string): Sighting[] {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [];
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return [];
  const h = providerHost(u.hostname);
  const path = u.pathname;
  const where = redact(`${h}${path.replace(/\/(cs|test)_[A-Za-z0-9_]+/g, "/$1_…")}`).slice(0, 80);
  const s = (provider: Provider, mode: PayMode, what: string): Sighting[] => [{ provider, mode, why: `${what} (${where})` }];
  const params = new URLSearchParams(`${u.search.slice(1)}&${u.hash.slice(1)}`);

  if (under(h, "stripe.com") || under(h, "stripe.network")) {
    if (h === "buy.stripe.com") return s("stripe", /^\/test_/.test(path) ? "test" : "live", /^\/test_/.test(path) ? "a test Payment Link" : "a live Payment Link");
    if (h === "checkout.stripe.com" && !/\/cs_(test|live)_/.test(path)) return s("stripe", "unknown", "Stripe Checkout with no session id");
    return s("stripe", "unknown", "a Stripe page or frame");
  }
  if (under(h, "paypal.com") || under(h, "paypalobjects.com")) {
    if (/(^|\.)sandbox\.paypal\.com$/.test(h)) return s("paypal", "test", "PayPal's sandbox");
    const env = params.get("env");
    if (env === "sandbox") return s("paypal", "test", "PayPal with env=sandbox");
    if (env === "production") return s("paypal", "live", "PayPal with env=production");
    if (params.get("client-id") === "sb") return s("paypal", "test", "PayPal's sandbox client id");
    // The SDK script and static files are served from the live hosts for the sandbox too.
    if (/^\/sdk\/js/.test(path) || under(h, "paypalobjects.com")) return s("paypal", "unknown", "PayPal's script");
    return s("paypal", "live", "PayPal's live site");
  }
  if (under(h, "paddle.com")) {
    if (/^sandbox-/.test(h)) return s("paddle", "test", "Paddle's sandbox");
    if (h === "cdn.paddle.com") return s("paddle", "unknown", "Paddle's script");
    return s("paddle", "live", "Paddle's live site");
  }
  if (under(h, "myshopify.com") || under(h, "shopifyinc.com") || /^\/checkouts\/(cn|c)\//.test(path)) return s("shopify", "unknown", "a Shopify checkout");
  if (under(h, "adyen.com") || under(h, "adyenpayments.com")) {
    if (/-test\./.test(h) || /^test\./.test(h)) return s("adyen", "test", "Adyen's test host");
    if (/-live/.test(h) || /^live\./.test(h)) return s("adyen", "live", "Adyen's live host");
    return s("adyen", "unknown", "an Adyen page");
  }
  if (under(h, "braintreegateway.com") || under(h, "braintree-api.com")) {
    if (/(^|\.)sandbox\./.test(h)) return s("braintree", "test", "Braintree's sandbox");
    return s("braintree", "unknown", "a Braintree page or frame");
  }
  if (under(h, "squareupsandbox.com") || h === "sandbox.web.squarecdn.com") return s("square", "test", "Square's sandbox");
  if (under(h, "squareup.com") || under(h, "squarecdn.com")) return s("square", h === "web.squarecdn.com" ? "live" : "unknown", "Square's site");
  if (under(h, "razorpay.com")) return s("razorpay", "unknown", "a Razorpay page or script");
  if (under(h, "authorize.net")) {
    if (/^(jstest|test|apitest|sandbox)\./.test(h)) return s("authorizenet", "test", "Authorize.net's sandbox");
    return s("authorizenet", /^(js|accept|api|secure)\./.test(h) ? "live" : "unknown", "Authorize.net's site");
  }
  if (under(h, "checkout.com")) return s("checkoutcom", /(^|\.)sandbox\./.test(h) ? "test" : "unknown", "a Checkout.com page or script");
  if (under(h, "mollie.com")) return s("mollie", "unknown", "a Mollie page or script");
  if (under(h, "klarna.com") || under(h, "klarnacdn.net") || under(h, "klarnaservices.com")) return s("klarna", /(^|\.)playground\./.test(h) ? "test" : "unknown", "a Klarna page or script");
  return [];
}

/**
 * The payment provider an address belongs to, by its host alone, or undefined. For deciding whether a
 * page or frame is a provider's (navigation, "owned" in a pay run): a key in a query string never
 * makes an address a provider's.
 */
export function providerOf(url: string): Provider | undefined {
  const p = checkoutOf(url);
  // A Shopify checkout path ("/checkouts/c/") on any other host is the shop's own page, not Shopify's.
  if (p !== "shopify") return p;
  const h = providerHost(new URL(url).hostname);
  return under(h, "myshopify.com") || under(h, "shopifyinc.com") ? p : undefined;
}

/**
 * The provider whose checkout an address is: by host, or by Shopify's checkout path on a shop's own
 * domain. For what a press there does and what is stopped on sight; never for where a run may go
 * (that is providerOf).
 */
export function checkoutOf(url: string): Provider | undefined {
  return fromUrl(url)[0]?.provider;
}

/** Words that say test mode, counted only for a provider already seen. */
const TEXT_RULES: { re: RegExp; provider: Provider; mode: PayMode; name: string }[] = [
  { re: /\(for testing\)\s*Bogus Gateway/i, provider: "shopify", mode: "test", name: "Shopify's test gateway" },
  { re: /Paddle\.Environment\.set\(\s*["']sandbox["']\s*\)/, provider: "paddle", mode: "test", name: "Paddle.js set to sandbox" },
];

const order: Record<PayMode, number> = { live: 3, unknown: 2, test: 1 };

/** The checkout's mode: see the comment at the top. Pure; no network, no clock. */
export function payMode(surface: PaySurface): PayModeResult {
  const sightings: Sighting[] = [];
  for (const url of surface.urls) sightings.push(...fromUrl(url));
  // Providers seen by an address (their page, frame or script). Keys and words say "test" only for these.
  const seen = new Set(sightings.map((s) => s.provider));
  const keyText = [...(surface.keys ?? []), ...surface.urls, ...(surface.text ?? [])];
  const loose: Sighting[] = [];
  for (const t of keyText) {
    for (const r of KEY_RULES) {
      for (const m of t.matchAll(r.re)) {
        const sight: Sighting = { provider: r.provider, mode: r.mode, why: `${r.name} ${cut(m[0])}` };
        if (r.needsProvider) loose.push(sight);
        // A test key with no page, frame or script of its provider: the provider is there, its mode isn't shown.
        else if (sight.mode === "test" && !seen.has(r.provider)) sightings.push({ ...sight, mode: "unknown", why: `${sight.why}, but no ${r.provider} page, frame or script` });
        else sightings.push(sight);
      }
    }
  }
  // Words count only for their own provider, seen by an address: a page can't make itself "test" by
  // printing "Bogus Gateway".
  for (const t of [...(surface.text ?? []), ...(surface.keys ?? [])]) for (const r of TEXT_RULES) if (r.re.test(t) && seen.has(r.provider)) sightings.push({ provider: r.provider, mode: r.mode, why: r.name });
  // A plain test_/live_ token goes to every provider that uses them and was seen by an address.
  for (const l of loose) for (const p of ["paddle", "adyen", "mollie"] as const) if (seen.has(p)) sightings.push({ ...l, provider: p });

  // Per provider: live wins, then test, and "unknown" only when no sign said either.
  const rank: Record<PayMode, number> = { live: 3, test: 2, unknown: 1 };
  const byProvider = new Map<Provider, PayMode>();
  for (const s of sightings) {
    const now = byProvider.get(s.provider);
    if (!now || rank[s.mode] > rank[now]) byProvider.set(s.provider, s.mode);
  }
  const providers = [...byProvider].map(([provider, mode]) => ({ provider, mode }));
  // In all: the worst provider's mode, and unknown when none was seen.
  let mode: PayMode = providers.length ? providers.reduce<PayMode>((m, p) => (order[p.mode] > order[m] ? p.mode : m), "test") : "unknown";
  // A frame that couldn't be read may hold a live key: never "test" then.
  const unread = surface.unread ?? 0;
  if (unread > 0 && mode === "test") mode = "unknown";
  const mayPay = mode === "test";
  const reason = unread > 0 && providers.length && providers.every((p) => p.mode === "test")
    ? `${unread} frame(s) couldn't be read, so test mode can't be shown: treated as live`
    : !providers.length
    ? "no payment provider's test mode could be seen, so it is treated as live"
    : mayPay
      ? `test mode: ${providers.map((p) => p.provider).join(", ")}`
      : `${providers.filter((p) => p.mode !== "test").map((p) => `${p.provider} is ${p.mode === "live" ? "live" : "not shown to be in test mode"}`).join("; ")}: ${mode === "live" ? "live payments are never made" : "treated as live"}`;
  return { mode, providers, sightings, mayPay, reason };
}
