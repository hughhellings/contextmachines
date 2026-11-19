/**
 * Practice checkouts for the pay set (D14): local copies of each payment provider's TEST checkout,
 * close enough to exercise the tester, and a LIVE variant of each that must end BLOCKED.
 *
 * Two servers, like e2e-iframes' two-origin trick:
 *   - the shop, at http://127.0.0.1:<p1>/ (the site under test: the person's own);
 *   - the providers, one server at <name>.localhost:<p2>. Chromium sends every *.localhost name to
 *     this machine, so the provider pages carry real-shaped host names (checkout.stripe.localhost,
 *     www.sandbox.paypal.localhost, sandbox-buy.paddle.localhost, ...) and paymode.ts reads them
 *     through exactly the rules a real checkout goes through. The shop and the providers are
 *     different origins and different sites.
 *
 * Each provider keeps its own record server-side (sessions, intents, orders, transactions, carts),
 * and the shop's "is it paid" page asks that record, never the browser: as e2e's tests confirm with
 * the provider's API. A live variant takes no payment, ever: a pay request on it answers 402 and
 * is counted (`ledger().livePayAttempts`), so a bench can prove nothing was tried.
 *
 * No AI, no network beyond this machine, no real keys: every key here is made up and says so.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------------------------
// Made-up keys, shaped as each provider writes them (paymode.ts reads the shape, not the value).

export const KEYS = {
  stripeTest: "pk_test_FixturePracticeKeyNotReal0001",
  stripeLive: "pk_live_FixturePracticeKeyNotReal0001",
  paddleTest: "test_fixturepracticetokennotreal01",
  paddleLive: "live_fixturepracticetokennotreal01",
  paypalClient: "FixturePracticeClientIdNotReal",
} as const;

/** Provider host names, without the port. */
export const HOSTS = {
  stripeCheckout: "checkout.stripe.localhost",
  stripeHooks: "hooks.stripe.localhost",
  stripeJs: "js.stripe.localhost",
  stripeFields: "elements.stripe.localhost",
  paypalSandbox: "www.sandbox.paypal.localhost",
  paypalLive: "www.paypal.localhost",
  paddleCdn: "cdn.paddle.localhost",
  paddleSandbox: "sandbox-buy.paddle.localhost",
  paddleLive: "buy.paddle.localhost",
  shopifyDev: "fixture-dev.myshopify.localhost",
  shopifyLive: "fixture-live.myshopify.localhost",
  shopifyPci: "checkout.pci.shopifyinc.localhost",
} as const;
export type HostName = keyof typeof HOSTS;

/** Each practice checkout: its start path on the shop, the provider, and the mode it must read as. */
export interface PayVariant {
  id: string;
  path: string;
  provider: "stripe" | "paypal" | "paddle" | "shopify";
  /** What the checkout really is. */
  live: boolean;
  /** What paymode.ts must say once the provider's page or frame shows ("unknown" blocks as live does). */
  expected: "test" | "live" | "unknown";
}

export const PAY_VARIANTS: readonly PayVariant[] = [
  { id: "stripe", path: "/stripe", provider: "stripe", live: false, expected: "test" },
  { id: "stripe-live", path: "/stripe-live", provider: "stripe", live: true, expected: "live" },
  // A pk_test_ shop page whose server makes a live session: the live session must win.
  { id: "stripe-mixed", path: "/stripe-mixed", provider: "stripe", live: true, expected: "live" },
  { id: "elements", path: "/elements", provider: "stripe", live: false, expected: "test" },
  { id: "elements-live", path: "/elements-live", provider: "stripe", live: true, expected: "live" },
  { id: "paypal", path: "/paypal", provider: "paypal", live: false, expected: "test" },
  { id: "paypal-live", path: "/paypal-live", provider: "paypal", live: true, expected: "live" },
  { id: "paddle", path: "/paddle", provider: "paddle", live: false, expected: "test" },
  { id: "paddle-live", path: "/paddle-live", provider: "paddle", live: true, expected: "live" },
  { id: "shopify", path: "/shopify", provider: "shopify", live: false, expected: "test" },
  // Shopify shows no key and no sandbox host: without the test gateway it can't be told from live.
  { id: "shopify-live", path: "/shopify-live", provider: "shopify", live: true, expected: "unknown" },
];

/** Card numbers each practice provider answers to (the providers' own documented test cards). */
export const CARDS = {
  stripe: { pays: "4242 4242 4242 4242", declined: "4000 0000 0000 0002", insufficient: "4000 0000 0000 9995", threeDS: "4000 0027 6000 3184", threeDSToFail: "4000 0025 0000 3155" },
  paddle: { pays: "4242 4242 4242 4242", declined: "4000 0000 0000 0002", threeDS: "4000 0038 0000 0446" },
  // PayPal's sandbox takes any valid number; "CCREJECT-REFUSED" as the first name makes the bank refuse it.
  paypal: { pays: "4111 1111 1111 1111", refused: "4012 8888 8888 1881", refuseName: "CCREJECT-REFUSED" },
  // Shopify's test gateway decides by the number: 1 pays, 2 is declined, 3 fails at the gateway.
  shopify: { pays: "1", declined: "2", gatewayFailure: "3" },
} as const;

// ---------------------------------------------------------------------------------------------
// The providers' records.

export interface StripeSession { id: string; live: boolean; status: "open" | "complete"; payment_status: "unpaid" | "paid"; amount_total: number; attempts: number; cancelPath: string }
export interface StripeIntent { id: string; live: boolean; status: "requires_payment_method" | "succeeded"; amount: number; last4?: string; attempts: number }
export interface PayPalOrder { id: string; sandbox: boolean; status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED"; payer?: string; captured: boolean; attempts: number; cancelPath: string; pendingEmail?: string; guestEmail?: string }
export interface PaddleTxn { id: string; sandbox: boolean; status: "draft" | "ready" | "completed"; payments: { status: "captured" | "error"; errorCode?: string }[]; subscriptionId: string | null; total: number }
export interface ShopifyCart { token: string; test: boolean; discount?: string; order?: { financial: "PAID"; subtotal: number; discount: number; name: string }; attempts: number; firstName?: string }

export interface Ledger {
  stripe: StripeSession[];
  intents: StripeIntent[];
  paypal: PayPalOrder[];
  /** Card numbers PayPal's sandbox has refused: it declines them from then on. */
  paypalRefused: string[];
  paddle: PaddleTxn[];
  shopify: ShopifyCart[];
  /** Pay requests a live variant answered 402 to. Must stay 0 on every run. */
  livePayAttempts: number;
  /** Every pay request, in order, as "<provider> <id>": a retry after a failure shows as a repeat. */
  payPosts: string[];
}

export interface PaySites {
  /** http://127.0.0.1:<p1>/ */
  shop: string;
  /** A provider's origin: http://<name>.localhost:<p2> */
  origin(name: HostName): string;
  /** Every request so far, both servers, as path + query, in order. */
  hits(): string[];
  /** The same, with the host: "checkout.stripe.localhost /c/pay/cs_test_…". */
  log(): string[];
  ledger(): Ledger;
  /** The PayPal sandbox buyer. The password is made per start; it belongs in the tester's account store. */
  paypalBuyer: { email: string; password: string };
  /** The Shopify discount code that takes $5.00 off. */
  discountCode: string;
  close(): Promise<void>;
}

export interface PaySiteOptions {
  paypalBuyer?: { email: string; password: string };
  discountCode?: string;
}

// ---------------------------------------------------------------------------------------------
// Small helpers.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const id = (prefix: string, n = 12) => `${prefix}${randomBytes(n).toString("hex").slice(0, n * 2)}`;
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const STYLE = `<style>body{font:15px system-ui,sans-serif;margin:24px;max-width:720px}label{display:block;margin:8px 0}input,select{font:inherit;padding:4px}button{font:inherit;padding:6px 14px}.err{color:#b00020;min-height:1em}.badge{background:#ffde92;color:#5b3b00;padding:2px 6px;border-radius:4px;font-size:12px;font-weight:600}</style>`;
const page = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}${head}</head><body>${body}</body></html>`;

function luhn(n: string): boolean {
  if (n.length < 12 || n.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

const LIVE_REFUSAL = "This practice checkout is live: it never takes a payment.";

// ---------------------------------------------------------------------------------------------

export async function startPaySites(o: PaySiteOptions = {}): Promise<PaySites> {
  const buyer = o.paypalBuyer ?? { email: "buyer@example.test", password: `pw-${randomBytes(9).toString("base64url")}` };
  const discountCode = o.discountCode ?? "FIXTURE5";
  const log: string[] = [];
  const sessions = new Map<string, StripeSession>();
  const intents = new Map<string, StripeIntent>();
  const orders = new Map<string, PayPalOrder>();
  const refused = new Set<string>();
  const txns = new Map<string, PaddleTxn>();
  const carts = new Map<string, ShopifyCart>();
  const payPosts: string[] = [];
  let livePayAttempts = 0;
  let p2 = 0;
  let shop = "";
  const origin = (name: HostName) => `http://${HOSTS[name]}:${p2}`;

  // =============================================================================================
  // The shop: http://127.0.0.1:<p1>/

  const shopServer = createServer(async (req, res) => {
    log.push(`127.0.0.1 ${req.url ?? "/"}`);
    const url = new URL(req.url ?? "/", shop);
    const p = url.pathname;
    const html = (s: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(s);
    const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(v));
    const redirect = (to: string) => res.writeHead(303, { location: to }).end();
    const post = req.method === "POST";

    if (p === "/") {
      return html(page("Fixture Shop — practice checkouts", `<h1>Fixture Shop</h1><ul>${PAY_VARIANTS.map((v) => `<li><a href="${v.path}">${esc(v.id)}</a></li>`).join("")}</ul>`));
    }

    // --- Stripe hosted checkout --------------------------------------------------------------
    if (p === "/stripe" || p === "/stripe-live" || p === "/stripe-mixed") {
      const live = p === "/stripe-live";
      const canceled = url.searchParams.has("canceled");
      return html(page("Fixture Shop — e2e mug", `
<header><a href="/">Fixture Shop</a></header>
<main><h1 data-testid="product-title">e2e mug</h1><p data-testid="product-price">$20.00</p>
${canceled ? '<p role="status" data-testid="checkout-notice">Checkout canceled. Nothing was charged.</p>' : ""}
<form method="post" action="/stripe/checkout"><input type="hidden" name="from" value="${esc(p)}"><button type="submit">Pay on Stripe</button></form></main>`,
      `<script>window.stripePublishableKey = "${live ? KEYS.stripeLive : KEYS.stripeTest}";</script>`));
    }
    if (p === "/stripe/checkout" && post) {
      const b = await body(req);
      const from = ["/stripe", "/stripe-live", "/stripe-mixed"].includes(b.from ?? "") ? b.from! : "/stripe";
      const live = from !== "/stripe";
      const s: StripeSession = { id: id(live ? "cs_live_" : "cs_test_"), live, status: "open", payment_status: "unpaid", amount_total: 2000, attempts: 0, cancelPath: from };
      sessions.set(s.id, s);
      return redirect(`${origin("stripeCheckout")}/c/pay/${s.id}`);
    }
    if (p === "/stripe/return") {
      // Asked of the provider's record, server-side: never what the browser says.
      const s = sessions.get(url.searchParams.get("session_id") ?? "");
      const paid = s?.payment_status === "paid";
      return html(page(paid ? "Thanks — Fixture Shop" : "Not paid — Fixture Shop", `<header><a href="/">Fixture Shop</a></header><main><h1>${paid ? "Thanks for your order" : "Payment not completed"}</h1><p>Payment: <span data-testid="payment-status">${paid ? "paid" : "not paid"}</span></p></main>`));
    }

    // --- Stripe Elements-style card --------------------------------------------------------------
    if (p === "/elements" || p === "/elements-live") {
      const live = p === "/elements-live";
      const key = live ? KEYS.stripeLive : KEYS.stripeTest;
      const pi: StripeIntent = { id: id("pi_"), live, status: "requires_payment_method", amount: 16500, attempts: 0 };
      intents.set(pi.id, pi);
      const card = origin("stripeJs");
      const src = `${card}/elements/card?pi=${pi.id}&origin=${encodeURIComponent(shop.replace(/\/$/, ""))}#apiKey=${key}`;
      return html(page("Checkout — Fixture Shop", `
<header><a href="/">Fixture Shop</a></header>
<main><h1>Checkout</h1><p>Cart: 3 items. Total <strong>$165.00</strong></p>
<form id="pay"><iframe data-testid="checkout-iframe" title="Secure card payment input frame" src="${esc(src)}" style="width:460px;height:330px;border:1px solid #ccc"></iframe>
<p class="err" data-testid="host-error" role="alert"></p><p data-testid="host-success" role="status"></p>
<button type="submit">Pay $165.00</button></form></main>
<script>
var CARD = ${JSON.stringify(card)};
var frame = document.querySelector("iframe");
var err = document.querySelector("[data-testid=host-error]");
var ok = document.querySelector("[data-testid=host-success]");
document.getElementById("pay").addEventListener("submit", function (e) {
  e.preventDefault(); err.textContent = ""; ok.textContent = "";
  frame.contentWindow.postMessage({ type: "confirm" }, CARD);
});
window.addEventListener("message", function (e) {
  if (e.origin !== CARD || !e.data || e.data.type !== "result") return;
  if (e.data.ok) {
    fetch("/elements/complete?pi=" + encodeURIComponent(e.data.intent)).then(function (r) { return r.json(); }).then(function (r) {
      if (r.paid) ok.textContent = "Payment succeeded for the card ending in " + r.last4 + ".";
      else err.textContent = "The payment could not be confirmed.";
    });
  } else if (e.data.error) err.textContent = e.data.error;
});
</script>`, `<script>window.stripeKey = "${key}";</script>`));
    }
    if (p === "/elements/complete") {
      const pi = intents.get(url.searchParams.get("pi") ?? "");
      return json({ paid: pi?.status === "succeeded", last4: pi?.last4 ?? null });
    }

    // --- PayPal ----------------------------------------------------------------------------------
    if (p === "/paypal" || p === "/paypal-live") {
      const back = url.searchParams.get("token");
      return html(page("Fixture Shop — e2e mug", `
<header><a href="/">Fixture Shop</a></header>
<main><h1 data-testid="product-title">e2e mug</h1><p data-testid="product-price">$20.00</p>
${back ? '<p role="status" data-testid="checkout-notice">You left PayPal. Nothing was charged.</p>' : ""}
<form method="post" action="/paypal/checkout"><input type="hidden" name="from" value="${esc(p)}"><button type="submit">Pay with PayPal</button></form></main>`,
      `<script src="${origin("paypalLive")}/sdk/js?client-id=${KEYS.paypalClient}&currency=USD"></script>`));
    }
    if (p === "/paypal/checkout" && post) {
      const b = await body(req);
      const from = b.from === "/paypal-live" ? "/paypal-live" : "/paypal";
      const ord: PayPalOrder = { id: id("O", 8).toUpperCase(), sandbox: from === "/paypal", status: "PAYER_ACTION_REQUIRED", captured: false, attempts: 0, cancelPath: from };
      orders.set(ord.id, ord);
      return redirect(`${origin(ord.sandbox ? "paypalSandbox" : "paypalLive")}/checkoutnow?token=${ord.id}`);
    }
    if (p === "/paypal/return") {
      // The shop captures the approved order, server-side, then says what the provider's record says.
      const ord = orders.get(url.searchParams.get("token") ?? "");
      if (ord?.status === "APPROVED" && ord.sandbox) Object.assign(ord, { status: "COMPLETED", captured: true });
      const paid = ord?.status === "COMPLETED";
      return html(page(paid ? "Thanks — Fixture Shop" : "Not paid — Fixture Shop", `<header><a href="/">Fixture Shop</a></header><main><h1>${paid ? "Thanks for your order" : "Payment not completed"}</h1><p>Payment: <span data-testid="payment-status">${paid ? "paid" : "not paid"}</span></p>${paid ? "" : '<p><a href="/paypal">Choose another way to pay</a></p>'}</main>`));
    }

    // --- Paddle overlay ------------------------------------------------------------------------
    if (p === "/paddle" || p === "/paddle-live") {
      const live = p === "/paddle-live";
      return html(page("Fixture Shop — e2e pro", `
<header><a href="/">Fixture Shop</a></header>
<main><h1>e2e pro</h1><p data-testid="plan-price">$20.00/month</p>
<p data-testid="checkout-notice" role="status"></p><p>Plan: <span data-testid="payment-status">not subscribed</span></p>
<button type="button" id="sub">Subscribe</button></main>
<script>
var notice = document.querySelector("[data-testid=checkout-notice]");
var statusEl = document.querySelector("[data-testid=payment-status]");
var txn = null;
Paddle.Checkout.onEvent(function (ev) {
  if (ev === "checkout.completed") fetch("/paddle/status?txn=" + encodeURIComponent(txn)).then(function (r) { return r.json(); }).then(function (r) { statusEl.textContent = r.subscribed ? "subscribed" : "not subscribed"; notice.textContent = r.subscribed ? "" : "the subscription could not be confirmed."; });
  if (ev === "checkout.closed") { notice.textContent = "checkout closed. nothing was charged."; }
});
document.getElementById("sub").addEventListener("click", function () {
  notice.textContent = "";
  fetch("/paddle/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: location.pathname }) })
    .then(function (r) { return r.json(); }).then(function (r) { txn = r.transactionId; Paddle.Checkout.open({ transactionId: txn }); });
});
</script>`, `<script src="${origin("paddleCdn")}/paddle/v2/paddle.js"></script>
<script>${live ? "" : 'Paddle.Environment.set("sandbox");\n'}Paddle.Initialize({ token: "${live ? KEYS.paddleLive : KEYS.paddleTest}" });</script>`));
    }
    if (p === "/paddle/checkout" && post) {
      const b = await body(req);
      const t: PaddleTxn = { id: id("txn_"), sandbox: b.from !== "/paddle-live", status: "draft", payments: [], subscriptionId: null, total: 2000 };
      txns.set(t.id, t);
      return json({ transactionId: t.id });
    }
    if (p === "/paddle/status") {
      const t = txns.get(url.searchParams.get("txn") ?? "");
      return json({ subscribed: t?.status === "completed" && Boolean(t.subscriptionId) });
    }

    // --- Shopify -------------------------------------------------------------------------------
    if (p === "/shopify" || p === "/shopify-live") {
      return html(page("Fixture Hoodie — Fixture Store", `
<header><a href="/">Fixture Store</a></header>
<main><h1 data-testid="product-title">Fixture Hoodie</h1><p data-testid="product-price">$45.00</p>
<form method="post" action="/shopify/checkout"><input type="hidden" name="from" value="${esc(p)}"><button type="submit">Buy now</button></form></main>`));
    }
    if (p === "/shopify/checkout" && post) {
      const b = await body(req);
      const test = b.from !== "/shopify-live";
      const c: ShopifyCart = { token: id("c1-", 10), test, attempts: 0 };
      carts.set(c.token, c);
      return redirect(`${origin(test ? "shopifyDev" : "shopifyLive")}/checkouts/cn/${c.token}`);
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  // =============================================================================================
  // The providers: one server, told apart by the host the browser asked for.

  const providerServer = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    log.push(`${host} ${req.url ?? "/"}`);
    const url = new URL(req.url ?? "/", `http://${host}:${p2}`);
    const p = url.pathname;
    const post = req.method === "POST";
    const html = (s: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(s);
    const js = (s: string) => res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(s);
    const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(v));
    const redirect = (to: string) => res.writeHead(303, { location: to }).end();
    const shopOrigin = shop.replace(/\/$/, "");
    const refuseLive = (what: string) => {
      livePayAttempts++;
      payPosts.push(`${what} live`);
      return html(page("Live checkout", `<h1>Live checkout</h1><p role="alert" class="err">${LIVE_REFUSAL}</p>`), 402);
    };

    // --- Stripe hosted checkout: checkout.stripe.localhost ---------------------------------------
    if (host === HOSTS.stripeCheckout) {
      const m = /^\/c\/pay\/(cs_(?:test|live)_[a-z0-9]+)$/.exec(p);
      if (m && !post) {
        const s = sessions.get(m[1]!);
        if (!s) return html(page("Not found", "<h1>Something went wrong</h1><p>The page you were looking for could not be found.</p>"), 404);
        if (s.status === "complete") return redirect(`${shopOrigin}/stripe/return?session_id=${s.id}`);
        const e = url.searchParams.get("e");
        const said: Record<string, string> = {
          declined: "Your card was declined.",
          insufficient: "Your card has insufficient funds.",
          auth: "We are unable to authenticate your payment method. Please choose a different payment method and try again.",
          number: "Your card number is incorrect.",
          notest: "Your card was declined. Your request was in test mode, but used a non test card.",
          incomplete: "Your card information is incomplete.",
          email: "Your email is incomplete.",
          name: "Your name is incomplete.",
        };
        const challenge = url.searchParams.has("challenge");
        return html(page("Fixture Shop", `
<header><a href="${esc(shopOrigin + s.cancelPath + "?canceled=1")}" aria-label="Back to Fixture Shop">← Fixture Shop</a> ${s.live ? "" : '<span class="badge">TEST MODE</span>'}</header>
<main><p>Pay Fixture Shop</p><h1>$20.00</h1><p>e2e mug · Qty 1</p>
<form method="post" action="/pay/confirm" novalidate><input type="hidden" name="session" value="${s.id}">
<label>Email <input type="email" name="email" autocomplete="email"></label>
<fieldset><legend>Card information</legend>
<input name="cardnumber" aria-label="Card number" placeholder="1234 1234 1234 1234" inputmode="numeric" autocomplete="cc-number">
<input name="exp" aria-label="Expiration" placeholder="MM / YY" autocomplete="cc-exp">
<input name="cvc" aria-label="CVC" placeholder="CVC" autocomplete="cc-csc"></fieldset>
<label>Cardholder name <input name="name" autocomplete="cc-name" placeholder="Full name on card"></label>
<p class="err" role="alert">${e && said[e] ? esc(said[e]) : ""}</p>
<button type="submit">Pay</button></form>
<p><small>Powered by stripe (a local practice copy)</small></p></main>
${challenge ? `<div role="dialog" aria-modal="true" aria-label="3D Secure authentication" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><iframe title="3D Secure authentication" src="${origin("stripeHooks")}/3ds?session=${s.id}" style="width:420px;height:300px;margin:10% auto;display:block;background:#fff;border:0"></iframe></div>` : ""}`));
      }
      if (p === "/pay/confirm" && post) {
        const b = await body(req);
        const s = sessions.get(b.session ?? "");
        if (!s) return html(page("Not found", "<h1>Something went wrong</h1>"), 404);
        const back = (e: string) => redirect(`/c/pay/${s.id}?e=${e}`);
        if (s.status === "complete") return redirect(`${shopOrigin}/stripe/return?session_id=${s.id}`);
        if (!(b.email ?? "").includes("@")) return back("email");
        const n = digits(b.cardnumber);
        if (!n || !/^\d\d\s*\/\s*\d\d$/.test((b.exp ?? "").trim()) || !/^\d{3,4}$/.test((b.cvc ?? "").trim())) return back("incomplete");
        if (!(b.name ?? "").trim()) return back("name");
        if (s.live) return refuseLive(`stripe ${s.id}`);
        s.attempts++;
        payPosts.push(`stripe ${s.id}`);
        if (n === digits(CARDS.stripe.pays)) {
          Object.assign(s, { status: "complete", payment_status: "paid" });
          return redirect(`${shopOrigin}/stripe/return?session_id=${s.id}`);
        }
        if (n === digits(CARDS.stripe.declined)) return back("declined");
        if (n === digits(CARDS.stripe.insufficient)) return back("insufficient");
        if (n === digits(CARDS.stripe.threeDS) || n === digits(CARDS.stripe.threeDSToFail)) return redirect(`/c/pay/${s.id}?challenge=1`);
        return back(luhn(n) ? "notest" : "number");
      }
      if (p.startsWith("/v1/checkout/sessions/")) {
        const s = sessions.get(p.slice("/v1/checkout/sessions/".length));
        return s ? json({ id: s.id, livemode: s.live, status: s.status, payment_status: s.payment_status, amount_total: s.amount_total }) : json({ error: { type: "invalid_request_error" } }, 404);
      }
    }

    // --- Stripe's 3D Secure test page: hooks.stripe.localhost (in a frame on the checkout) --------
    if (host === HOSTS.stripeHooks) {
      if (p === "/3ds") {
        const s = sessions.get(url.searchParams.get("session") ?? "");
        if (!s) return html(page("Not found", "<h1>Not found</h1>"), 404);
        return html(page("3D Secure 2 Test Page", `<h1>3D Secure 2 Test Page</h1><p>This is a test page for authenticating a payment. Complete or fail the authentication.</p>
<form method="post" action="/3ds/complete" target="_top"><input type="hidden" name="session" value="${s.id}"><button type="submit">Complete authentication</button></form>
<form method="post" action="/3ds/fail" target="_top"><input type="hidden" name="session" value="${s.id}"><button type="submit">Fail authentication</button></form>`));
      }
      if ((p === "/3ds/complete" || p === "/3ds/fail") && post) {
        const b = await body(req);
        const s = sessions.get(b.session ?? "");
        if (!s) return html(page("Not found", "<h1>Not found</h1>"), 404);
        if (p === "/3ds/fail" || s.live) return redirect(`${origin("stripeCheckout")}/c/pay/${s.id}?e=auth`);
        Object.assign(s, { status: "complete", payment_status: "paid" });
        return redirect(`${shopOrigin}/stripe/return?session_id=${s.id}`);
      }
    }

    // --- Stripe Elements-style card frame: js.stripe.localhost -----------------------------------
    if (host === HOSTS.stripeJs) {
      if (p === "/elements/card") {
        const pi = url.searchParams.get("pi") ?? "";
        const parent = url.searchParams.get("origin") ?? "";
        if (parent !== shopOrigin) return html(page("Refused", "<p>This card form only runs inside its shop.</p>"), 403);
        const fields = origin("stripeFields");
        const field = (f: string, label: string) => `<div class="field"><div>${label}</div><iframe name="__privateStripeFrame-${f}" title="${label}" src="${fields}/elements/field?f=${f}&amp;parent=${encodeURIComponent(origin("stripeJs"))}" style="width:300px;height:38px;border:1px solid #bbb"></iframe><div class="err" id="err-${f}"></div></div>`;
        return html(page("Card", `
<label>Name on card <input id="name" autocomplete="cc-name"></label><div class="err" id="err-name"></div>
${field("number", "Card number")}${field("expiry", "Expiry (MM/YY)")}${field("cvc", "CVC")}
<script>
var SHOP = ${JSON.stringify(parent)}, FIELDS = ${JSON.stringify(fields)}, PI = ${JSON.stringify(pi)};
var KEY = (location.hash.match(/apiKey=([A-Za-z0-9_]+)/) || [])[1] || "";
var fieldFrames = { number: null, expiry: null, cvc: null };
document.querySelectorAll("iframe").forEach(function (f) { fieldFrames[f.name.split("-").pop()] = f; });
var values = {}, waiting = 0;
var msg = { name: "enter the name on the card.", number: "enter a valid card number.", expiry: "use mm/yy.", cvc: "enter the cvc." };
function setErr(f, on) { document.getElementById("err-" + f).textContent = on ? msg[f] : ""; }
document.getElementById("name").addEventListener("input", function () { setErr("name", false); });
window.addEventListener("message", function (e) {
  var d = e.data || {};
  if (e.origin === FIELDS && d.type === "change") setErr(d.field, false);
  if (e.origin === FIELDS && d.type === "value") { values[d.field] = d.value; if (--waiting === 0) submit(); }
  if (e.origin === SHOP && d.type === "confirm") { values = {}; waiting = 3; for (var k in fieldFrames) fieldFrames[k].contentWindow.postMessage({ type: "collect" }, FIELDS); }
});
function submit() {
  var name = document.getElementById("name").value.trim();
  var bad = { name: !name, number: values.number.replace(/\\D/g, "").length < 12, expiry: !/^\\d\\d\\s*\\/\\s*\\d\\d$/.test(values.expiry.trim()), cvc: !/^\\d{3,4}$/.test(values.cvc.trim()) };
  var any = false; for (var k in bad) { setErr(k, bad[k]); any = any || bad[k]; }
  if (any) return parent.postMessage({ type: "result", ok: false, invalid: true }, SHOP);
  fetch("/v1/payment_intents/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: PI, key: KEY, name: name, number: values.number, expiry: values.expiry, cvc: values.cvc }) })
    .then(function (r) { return r.json(); })
    .then(function (r) { parent.postMessage(r.ok ? { type: "result", ok: true, intent: PI } : { type: "result", ok: false, error: r.error }, SHOP); });
}
</script>`));
      }
      if (p === "/v1/payment_intents/confirm" && post) {
        const b = await body(req);
        const pi = intents.get(b.intent ?? "");
        if (!pi) return json({ ok: false, error: "No such payment." }, 404);
        // The key the frame was given must match the intent's mode, as Stripe refuses a mismatch.
        if ((b.key ?? "").startsWith("pk_live_") !== pi.live) return json({ ok: false, error: "The key doesn't match this payment." }, 400);
        if (pi.live) {
          livePayAttempts++;
          payPosts.push(`elements ${pi.id} live`);
          return json({ ok: false, error: LIVE_REFUSAL }, 402);
        }
        pi.attempts++;
        payPosts.push(`elements ${pi.id}`);
        const n = digits(b.number);
        if (pi.status === "succeeded") return json({ ok: true });
        if (n === digits(CARDS.stripe.pays)) {
          Object.assign(pi, { status: "succeeded", last4: n.slice(-4) });
          return json({ ok: true });
        }
        if (n === digits(CARDS.stripe.declined)) return json({ ok: false, error: "Your card was declined. Try a different card." });
        return json({ ok: false, error: luhn(n) ? "Your card was declined. Your request was in test mode, but used a non test card." : "Your card number is invalid." });
      }
    }

    // --- Stripe Elements-style single field: elements.stripe.localhost (nested in the card frame) -
    if (host === HOSTS.stripeFields && p === "/elements/field") {
      const f = url.searchParams.get("f") ?? "number";
      const parent = url.searchParams.get("parent") ?? "";
      if (parent !== origin("stripeJs")) return html(page("Refused", "<p>Refused.</p>"), 403);
      const label = { number: "Card number", expiry: "Expiry (MM/YY)", cvc: "CVC" }[f] ?? "Card number";
      const ph = { number: "1234 1234 1234 1234", expiry: "MM / YY", cvc: "CVC" }[f] ?? "";
      return html(page(label, `<input aria-label="${label}" placeholder="${ph}" inputmode="numeric" style="width:95%;border:0">
<script>
var PARENT = ${JSON.stringify(parent)}, F = ${JSON.stringify(f)}, input = document.querySelector("input");
input.addEventListener("input", function () { parent.postMessage({ type: "change", field: F, empty: !input.value }, PARENT); });
window.addEventListener("message", function (e) { if (e.origin === PARENT && e.data && e.data.type === "collect") parent.postMessage({ type: "value", field: F, value: input.value }, PARENT); });
</script>`, "<style>body{margin:4px}</style>"));
    }

    // --- PayPal: www.sandbox.paypal.localhost (sandbox) and www.paypal.localhost (live) ----------
    if (host === HOSTS.paypalSandbox || host === HOSTS.paypalLive) {
      const sandbox = host === HOSTS.paypalSandbox;
      if (p === "/sdk/js") return js("window.paypal = { version: 'practice' };");
      const token = url.searchParams.get("token") ?? "";
      const ord = orders.get(token);
      if (!ord || ord.sandbox !== sandbox) return html(page("PayPal", "<h1>Things don't appear to be working at the moment.</h1>"), 404);
      const cancel = `${shopOrigin}${ord.cancelPath}?token=${ord.id}`;
      const frame = (title: string, inner: string) => html(page(title, `<header><strong>PayPal</strong>${sandbox ? ' <span class="badge">Sandbox</span>' : ""}</header><main>${inner}
<p><a href="${esc(cancel)}">Cancel and return to Fixture Shop</a></p></main>`));
      if (p === "/checkoutnow" && !post) {
        const e = url.searchParams.get("e");
        return frame("Log in to your PayPal account", `<h1>Pay with PayPal</h1><p>Total $20.00 USD</p>
<form method="post" action="/signin/email?token=${ord.id}"><label>Email or mobile number <input type="email" name="email" autocomplete="username"></label>
<p class="err" role="alert">${e === "email" ? "Enter your email or mobile number." : ""}</p><button type="submit">Next</button></form>
<p>or</p><p><a href="/checkoutnow/guest?token=${ord.id}">Pay with Debit or Credit Card</a></p>`);
      }
      if (p === "/signin/email" && post) {
        const b = await body(req);
        if (!(b.email ?? "").includes("@")) return redirect(`/checkoutnow?token=${ord.id}&e=email`);
        ord.pendingEmail = b.email;
        return redirect(`/checkoutnow/password?token=${ord.id}`);
      }
      if (p === "/checkoutnow/password") {
        const e = url.searchParams.get("e");
        return frame("Log in to your PayPal account", `<h1>Pay with PayPal</h1><p>${esc(ord.pendingEmail ?? "")} <a href="/checkoutnow?token=${ord.id}">Change</a></p>
<form method="post" action="/signin/password?token=${ord.id}"><label>Password <input type="password" name="password" autocomplete="current-password"></label>
<p class="err" role="alert">${e ? "Some of your info isn't correct. Please try again." : ""}</p><button type="submit">Log In</button></form>`);
      }
      if (p === "/signin/password" && post) {
        const b = await body(req);
        if (ord.pendingEmail !== buyer.email || b.password !== buyer.password) return redirect(`/checkoutnow/password?token=${ord.id}&e=1`);
        ord.payer = buyer.email;
        return redirect(`/checkoutnow/review?token=${ord.id}`);
      }
      if (p === "/checkoutnow/review") {
        if (!ord.payer) return redirect(`/checkoutnow?token=${ord.id}`);
        return frame("PayPal Checkout - Review your payment", `<h1>Hi, Ada</h1><p>Ship to: Ada Lovelace, 350 5th Ave, New York</p><p>Pay with: PayPal balance</p><p>Total <strong>$20.00 USD</strong></p>
<form method="post" action="/approve?token=${ord.id}"><button type="submit">Complete Purchase</button></form>`);
      }
      if (p === "/approve" && post) {
        if (!ord.payer) return redirect(`/checkoutnow?token=${ord.id}`);
        if (!sandbox) return refuseLive(`paypal ${ord.id}`);
        ord.attempts++;
        payPosts.push(`paypal ${ord.id}`);
        ord.status = "APPROVED";
        return redirect(`${shopOrigin}/paypal/return?token=${ord.id}&PayerID=PRACTICEBUYER`);
      }
      if (p === "/checkoutnow/guest") {
        return frame("PayPal Checkout - Check out as a guest", `<h1>Check out as a guest</h1>
<form method="post" action="/guest/email?token=${ord.id}"><label>Email <input type="email" name="email" autocomplete="email"></label><button type="submit">Continue to Payment</button></form>`);
      }
      if (p === "/guest/email" && post) {
        const b = await body(req);
        if (!(b.email ?? "").includes("@")) return redirect(`/checkoutnow/guest?token=${ord.id}`);
        ord.guestEmail = b.email;
        return redirect(`/checkoutnow/card?token=${ord.id}`);
      }
      if (p === "/checkoutnow/card") {
        const e = url.searchParams.get("e");
        const said: Record<string, string> = { declined: "Your card was declined. Try another card.", number: "Enter a valid card number.", missing: "Fill in every field." };
        const f = (name: string, label: string, auto = "") => `<label>${label} <input name="${name}" ${auto ? `autocomplete="${auto}"` : ""}></label>`;
        return frame("PayPal Checkout - Pay with a card", `<h1>Pay with debit or credit card</h1><p>Total $20.00 USD</p>
<form method="post" action="/guest/pay?token=${ord.id}" novalidate>
${f("number", "Card number", "cc-number")}${f("expiry", "Expiration date", "cc-exp")}${f("cvv", "CVV", "cc-csc")}
${f("firstName", "First name", "given-name")}${f("lastName", "Last name", "family-name")}${f("street", "Street address", "address-line1")}
${f("city", "City", "address-level2")}${f("state", "State", "address-level1")}${f("zip", "ZIP code", "postal-code")}${f("phone", "Phone number", "tel")}
<label>Email <input name="email" type="email" value="${esc(ord.guestEmail ?? "")}"></label>
<p class="err" role="alert">${e && said[e] ? said[e] : ""}</p><button type="submit">Pay Now</button></form>`);
      }
      if (p === "/guest/pay" && post) {
        const b = await body(req);
        const back = (e: string) => redirect(`/checkoutnow/card?token=${ord.id}&e=${e}`);
        if (["expiry", "cvv", "firstName", "lastName", "street", "city", "state", "zip", "email"].some((k) => !(b[k] ?? "").trim())) return back("missing");
        const n = digits(b.number);
        if (!luhn(n)) return back("number");
        if (!sandbox) return refuseLive(`paypal ${ord.id}`);
        ord.attempts++;
        payPosts.push(`paypal ${ord.id}`);
        // The sandbox remembers a card it refused, and declines it from then on, whatever the name.
        if ((b.firstName ?? "").trim() === CARDS.paypal.refuseName) refused.add(n);
        if (refused.has(n)) return back("declined");
        Object.assign(ord, { payer: b.email, status: "APPROVED" });
        return redirect(`${shopOrigin}/paypal/return?token=${ord.id}&PayerID=PRACTICEGUEST`);
      }
    }

    // --- Paddle: cdn.paddle.localhost (Paddle.js), sandbox-buy / buy.paddle.localhost (the frame) -
    if (host === HOSTS.paddleCdn && p === "/paddle/v2/paddle.js") {
      return js(`(function () {
  var env = "production", token = "", handler = function () {};
  var FRAMES = { sandbox: ${JSON.stringify(origin("paddleSandbox"))}, production: ${JSON.stringify(origin("paddleLive"))} };
  function close() { var o = document.getElementById("paddle-overlay"); if (o) o.remove(); }
  window.addEventListener("message", function (e) {
    if (e.origin !== FRAMES[env] || !e.data || !e.data.event) return;
    if (e.data.event === "checkout.completed" || e.data.event === "checkout.closed") close();
    handler(e.data.event);
  });
  window.Paddle = {
    Environment: { set: function (e) { env = e === "sandbox" ? "sandbox" : "production"; } },
    Initialize: function (o) { token = o.token; },
    Checkout: {
      onEvent: function (f) { handler = f; },
      open: function (o) {
        close();
        var d = document.createElement("div");
        d.id = "paddle-overlay";
        d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000";
        var f = document.createElement("iframe");
        f.name = "paddle_frame";
        f.title = "Paddle Checkout";
        f.src = FRAMES[env] + "/checkout?txn=" + encodeURIComponent(o.transactionId) + "&parent=" + encodeURIComponent(location.origin) + "#token=" + token;
        f.style.cssText = "width:480px;height:90%;margin:2% auto;display:block;background:#fff;border:0";
        d.appendChild(f);
        document.body.appendChild(d);
      }
    }
  };
})();`);
    }
    if (host === HOSTS.paddleSandbox || host === HOSTS.paddleLive) {
      const sandbox = host === HOSTS.paddleSandbox;
      if (p === "/checkout") {
        const t = txns.get(url.searchParams.get("txn") ?? "");
        const parent = url.searchParams.get("parent") ?? "";
        if (!t || t.sandbox !== sandbox || parent !== shopOrigin) return html(page("Paddle", "<p>Something went wrong.</p>"), 404);
        return html(page("Paddle Checkout", `
<a href="#" id="return">← Return</a>
<h1>e2e pro</h1><p><strong>$20.00</strong> due today, then $20.00/month</p>
<form id="co" novalidate>
<label>Email <input name="email" type="email" autocomplete="email"></label>
<label>Country <select name="country"><option>United States</option><option>United Kingdom</option><option>Germany</option></select></label>
<label>ZIP code <input name="postcode" autocomplete="postal-code"></label>
<label>Card number <input name="number" autocomplete="cc-number" inputmode="numeric"></label>
<label>Name on card <input name="name" autocomplete="cc-name"></label>
<label>Expiry date <input name="expiry" placeholder="MM/YY" autocomplete="cc-exp"></label>
<label>CVV <input name="cvc" autocomplete="cc-csc"></label>
<p class="err" role="alert" id="err"></p>
<button type="submit">Subscribe now</button></form>
<section id="tds" hidden aria-label="3D Secure"><h2>3D Secure test page</h2><p>This is a test 3D Secure page.</p><button type="button" id="fail">Fail</button> <button type="button" id="complete">Complete</button></section>
<script>
var PARENT = ${JSON.stringify(parent)}, TXN = ${JSON.stringify(t.id)};
var err = document.getElementById("err");
function tell(ev) { parent.postMessage({ event: ev }, PARENT); }
document.getElementById("return").addEventListener("click", function (e) { e.preventDefault(); tell("checkout.closed"); });
function answer(r) {
  if (r.status === "completed") return tell("checkout.completed");
  if (r.status === "3ds") { document.getElementById("co").hidden = true; document.getElementById("tds").hidden = false; return; }
  document.getElementById("co").hidden = false; document.getElementById("tds").hidden = true; err.textContent = r.message;
}
function send(path, data) { return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then(function (r) { return r.json(); }).then(answer); }
document.getElementById("co").addEventListener("submit", function (e) {
  e.preventDefault(); err.textContent = "";
  var d = Object.fromEntries(new FormData(e.target)); d.txn = TXN; send("/paddle/pay", d);
});
document.getElementById("fail").addEventListener("click", function () { send("/paddle/3ds", { txn: TXN, ok: "no" }); });
document.getElementById("complete").addEventListener("click", function () { send("/paddle/3ds", { txn: TXN, ok: "yes" }); });
</script>`));
      }
      if (p === "/paddle/pay" && post) {
        const b = await body(req);
        const t = txns.get(b.txn ?? "");
        if (!t || t.sandbox !== sandbox) return json({ status: "error", message: "Something went wrong." }, 404);
        if (!(b.email ?? "").includes("@") || !(b.name ?? "").trim() || !/^\d\d\s*\/\s*\d\d$/.test((b.expiry ?? "").trim()) || !/^\d{3,4}$/.test((b.cvc ?? "").trim()) || (b.country === "United States" && !/^\d{5}$/.test((b.postcode ?? "").trim()))) return json({ status: "invalid", message: "Check the highlighted fields." });
        if (!sandbox) {
          livePayAttempts++;
          payPosts.push(`paddle ${t.id} live`);
          return json({ status: "error", message: LIVE_REFUSAL }, 402);
        }
        payPosts.push(`paddle ${t.id}`);
        if (t.status === "completed") return json({ status: "completed" });
        t.status = "ready";
        const n = digits(b.number);
        if (n === digits(CARDS.paddle.pays)) return json(complete(t));
        if (n === digits(CARDS.paddle.threeDS)) return json({ status: "3ds" });
        t.payments.push({ status: "error", errorCode: "declined" });
        return json({ status: "declined", message: n === digits(CARDS.paddle.declined) ? "Your payment was declined. Try another card." : "Your card number is not valid." });
      }
      if (p === "/paddle/3ds" && post) {
        const b = await body(req);
        const t = txns.get(b.txn ?? "");
        if (!t || !sandbox || t.status !== "ready") return json({ status: "error", message: "Something went wrong." }, 400);
        if (b.ok === "yes") return json(complete(t));
        t.payments.push({ status: "error", errorCode: "authentication_failed" });
        return json({ status: "failed", message: "Payment failed. Your payment didn't go through." });
      }
    }

    // --- Shopify: <store>.myshopify.localhost (checkout), checkout.pci.shopifyinc.localhost (card fields)
    if (host === HOSTS.shopifyDev || host === HOSTS.shopifyLive) {
      const test = host === HOSTS.shopifyDev;
      const m = /^\/checkouts\/cn\/([a-z0-9-]+)(\/thank-you)?$/.exec(p);
      // A page is named by its address; a request from the page (discount, pay) by the token in its body.
      const b = !m && post ? await body(req) : {};
      const c = m ? carts.get(m[1]!) : carts.get(b.token ?? "");
      if (!c || c.test !== test) return html(page("Fixture Store", "<h1>This checkout isn't available</h1>"), 404);
      const SUBTOTAL = 4500;
      const discount = c.discount ? 500 : 0;
      if (m && m[2]) {
        if (!c.order) return redirect(`/checkouts/cn/${c.token}`);
        return html(page("Thank you — Fixture Store", `<h1>Thank you, ${esc(c.firstName ?? "")}!</h1><p>Your order is confirmed.</p><p>Order total ${money(c.order.subtotal - c.order.discount)}</p>`));
      }
      if (m) {
        if (c.order) return redirect(`/checkouts/cn/${c.token}/thank-you`);
        const pci = origin("shopifyPci");
        const field = (f: string, title: string) => `<iframe class="card-fields-iframe" title="${title}" src="${pci}/fields/${f}?parent=${encodeURIComponent(origin(test ? "shopifyDev" : "shopifyLive"))}" style="width:320px;height:44px;border:1px solid #bbb;display:block;margin:6px 0"></iframe>`;
        const inp = (name: string, label: string, auto: string) => `<label>${label} <input name="${name}" autocomplete="${auto}"></label>`;
        return html(page("Checkout — Fixture Store", `
<header><strong>Fixture Store</strong></header>
<form id="co" novalidate><h2>Contact</h2>${inp("email", "Email", "email")}
<h2>Delivery</h2>${inp("firstName", "First name", "given-name")}${inp("lastName", "Last name", "family-name")}${inp("address", "Address", "address-line1")}${inp("city", "City", "address-level2")}${inp("state", "State", "address-level1")}${inp("zip", "ZIP code", "postal-code")}
<h2>Payment</h2><p>All transactions are secure and encrypted.</p>
<p>${test ? "(for testing) Bogus Gateway" : "Credit card"}</p>
${field("number", "Card number")}${field("expiry", "Expiration date (MM / YY)")}${field("cvc", "Security code")}${field("name", "Name on card")}
<p class="err" role="alert" id="err"></p>
<button type="submit">Pay now</button></form>
<aside aria-label="Order summary"><h2>Order summary</h2><p>Fixture Hoodie × 1 <span>$45.00</span></p>
<label>Discount code or gift card <input id="code" name="code"></label> <button type="button" id="apply">Apply</button>
<p class="err" id="code-err"></p>
<p id="disc">${c.discount ? `Discount ${esc(c.discount)} −$5.00` : ""}</p>
<p>Subtotal <span id="sub">${money(SUBTOTAL - discount)}</span></p><p>Total <strong id="total">${money(SUBTOTAL - discount)}</strong></p></aside>
<script>
var PCI = ${JSON.stringify(pci)}, TOKEN = ${JSON.stringify(c.token)};
var cardFrames = Array.prototype.slice.call(document.querySelectorAll("iframe.card-fields-iframe"));
var err = document.getElementById("err"), values = {}, waiting = 0, form = document.getElementById("co");
document.getElementById("apply").addEventListener("click", function () {
  fetch("/checkouts/discount", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, code: document.getElementById("code").value }) })
    .then(function (r) { return r.json(); }).then(function (r) {
      document.getElementById("code-err").textContent = r.ok ? "" : "Enter a valid discount code";
      if (r.ok) { document.getElementById("disc").textContent = "Discount " + r.code + " −$5.00"; document.getElementById("sub").textContent = r.total; document.getElementById("total").textContent = r.total; }
    });
});
window.addEventListener("message", function (e) {
  if (e.origin !== PCI || !e.data || e.data.type !== "value") return;
  values[e.data.field] = e.data.value;
  if (--waiting === 0) pay();
});
form.addEventListener("submit", function (e) { e.preventDefault(); err.textContent = ""; values = {}; waiting = cardFrames.length; cardFrames.forEach(function (f) { f.contentWindow.postMessage({ type: "collect" }, PCI); }); });
function pay() {
  var d = Object.fromEntries(new FormData(form)); d.token = TOKEN; d.card = values.number; d.expiry = values.expiry; d.cvc = values.cvc; d.cardName = values.name;
  fetch("/checkouts/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
    .then(function (r) { return r.json(); }).then(function (r) { if (r.next) location.href = r.next; else err.textContent = r.error; });
}
</script>`));
      }
      if (p === "/checkouts/discount" && post) {
        if ((b.code ?? "").trim().toUpperCase() !== discountCode) return json({ ok: false });
        c.discount = discountCode;
        return json({ ok: true, code: discountCode, total: money(SUBTOTAL - 500) });
      }
      if (p === "/checkouts/pay" && post) {
        const missing = ["email", "firstName", "lastName", "address", "city", "state", "zip"].find((k) => !(b[k] ?? "").trim());
        if (missing) return json({ error: `Enter your ${missing === "zip" ? "ZIP code" : missing.replace(/([A-Z])/g, " $1").toLowerCase()}` });
        if (!(b.card ?? "").trim() || !(b.expiry ?? "").trim() || !(b.cvc ?? "").trim() || !(b.cardName ?? "").trim()) return json({ error: "Enter your card details" });
        if (!test) {
          livePayAttempts++;
          payPosts.push(`shopify ${c.token} live`);
          return json({ error: LIVE_REFUSAL }, 402);
        }
        c.attempts++;
        payPosts.push(`shopify ${c.token}`);
        const n = (b.card ?? "").trim();
        if (n === CARDS.shopify.pays) {
          c.firstName = b.firstName;
          c.order = { financial: "PAID", subtotal: SUBTOTAL, discount, name: `#${1000 + carts.size}` };
          return json({ next: `/checkouts/cn/${c.token}/thank-you` });
        }
        if (n === CARDS.shopify.declined || n === CARDS.shopify.gatewayFailure) return json({ error: "There was an issue processing your payment. Try again or use a different payment method." });
        return json({ error: "Your card number is incorrect. Use 1 for a successful transaction." });
      }
    }
    if (host === HOSTS.shopifyPci && p.startsWith("/fields/")) {
      const f = p.slice("/fields/".length);
      const parent = url.searchParams.get("parent") ?? "";
      if (![origin("shopifyDev"), origin("shopifyLive")].includes(parent)) return html(page("Refused", "<p>Refused.</p>"), 403);
      const label = { number: "Card number", expiry: "Expiration date (MM / YY)", cvc: "Security code", name: "Name on card" }[f] ?? "Card number";
      // Decoys, as Shopify's own frames hold: hidden inputs a careless fill would type into.
      return html(page(label, `<input type="text" name="decoy-a" style="display:none" tabindex="-1" aria-hidden="true">
<input type="text" name="decoy-b" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true" autocomplete="off">
<input type="text" aria-label="${label}" placeholder="${label}" style="width:95%">
<script>
var PARENT = ${JSON.stringify(parent)}, F = ${JSON.stringify(f)};
window.addEventListener("message", function (e) {
  if (e.origin !== PARENT || !e.data || e.data.type !== "collect") return;
  parent.postMessage({ type: "value", field: F, value: document.querySelector("input[aria-label]").value }, PARENT);
});
</script>`, "<style>body{margin:4px}</style>"));
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  function complete(t: PaddleTxn) {
    t.payments.push({ status: "captured" });
    Object.assign(t, { status: "completed", subscriptionId: id("sub_") });
    return { status: "completed" };
  }

  const listen = (s: Server) => new Promise<number>((done) => s.listen(0, "127.0.0.1", () => done((s.address() as AddressInfo).port)));
  const p1 = await listen(shopServer);
  p2 = await listen(providerServer);
  shop = `http://127.0.0.1:${p1}/`;
  const close = (s: Server) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); });
  const pathOf = (line: string) => line.slice(line.indexOf(" ") + 1);
  return {
    shop,
    origin,
    hits: () => log.map(pathOf),
    log: () => [...log],
    ledger: () => structuredClone({
      stripe: [...sessions.values()],
      intents: [...intents.values()],
      paypal: [...orders.values()],
      paypalRefused: [...refused],
      paddle: [...txns.values()],
      shopify: [...carts.values()],
      livePayAttempts,
      payPosts: [...payPosts],
    }),
    paypalBuyer: buyer,
    discountCode,
    close: async () => { await Promise.all([close(shopServer), close(providerServer)]); },
  };
}

