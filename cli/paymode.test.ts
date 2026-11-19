// The pay gate's pure parts (D14), moved from bench/pay: paymode.ts (the providers' documented
// markers, live wins, unknown blocks, keys cut) and paygate.ts (start vs final presses, live on
// sight, never retry, owned hosts only).
//   node --test cli/paymode.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkoutOf, cut, keysIn, payMode, providerHost, providerOf, redact, type PayMode, type PaySurface } from "../packages/scanner/src/tester/paymode.ts";
import { liveOnSight, payGate, pressKind, type GateInput } from "../packages/scanner/src/tester/paygate.ts";
const mode = (s: PaySurface) => payMode(s).mode;

const CASES: [string, PaySurface, PayMode][] = [
  // Stripe
  ["Stripe hosted test session", { urls: ["https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6"] }, "test"],
  ["Stripe hosted live session", { urls: ["https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6"] }, "live"],
  ["Stripe Checkout with no session id", { urls: ["https://checkout.stripe.com/pay"] }, "unknown"],
  ["Stripe Elements frame with a test key in its hash", { urls: ["https://shop.example/", "https://js.stripe.com/v3/elements-inner-card-abc.html#apiKey=pk_test_51AbCdEf&locale=en"] }, "test"],
  ["Stripe Elements frame with a live key", { urls: ["https://js.stripe.com/v3/elem" + "ents-inner-card-abc.html#apiKey=pk_l" + "ive_51AbCdEf"] }, "live"],
  ["Stripe frame, no key anywhere", { urls: ["https://js.stripe.com/v3/elements-inner-card-abc.html"] }, "unknown"],
  ["a pk_test_ page whose session is live", { urls: ["https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4"], keys: ["pk_test_51AbCdEf"] }, "live"],
  ["Stripe test Payment Link", { urls: ["https://buy.stripe.com/test_28o5kn0Ab"] }, "test"],
  ["Stripe live Payment Link", { urls: ["https://buy.stripe.com/28o5kn0Ab"] }, "live"],
  // Review: a test key alone, with no Stripe page, frame or script, says nothing (was "test").
  ["a Stripe test key on a page with no Stripe page, frame or script", { urls: ["https://shop.example/"], keys: ["sk_test_51AbCdEf"] }, "unknown"],
  ["a stale pk_test_ in the source of a page another gateway runs", { urls: ["https://shop.example/checkout", "https://js.unknowngateway.example/pay.js"], keys: ["pk_test_oldleftover1"] }, "unknown"],
  ["a page that prints a pk_test_ key in its words", { urls: ["https://shop.example/checkout"], text: ["docs: use pk_test_abcdef123"] }, "unknown"],
  ["a sandbox_-looking variable name with no Braintree seen", { urls: ["https://shop.example/checkout"], keys: ["sandbox_feature_enabledx"] }, "unknown"],
  ["a Stripe test key with a Stripe frame on the page", { urls: ["https://shop.example/", "https://js.stripe.com/v3/elements-inner-card-abc.html"], keys: ["pk_test_51AbCdEf"] }, "test"],
  ["a live key alone still reads live", { urls: ["https://shop.example/"], keys: ["pk_live_51AbCdEf"] }, "live"],
  // PayPal
  ["PayPal sandbox checkout", { urls: ["https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T"] }, "test"],
  ["PayPal live checkout", { urls: ["https://www.paypal.com/checkoutnow?token=5O190127TN364715T"] }, "live"],
  ["PayPal's SDK script alone says nothing", { urls: ["https://shop.example/", "https://www.paypal.com/sdk/js?client-id=AbC&currency=USD"] }, "unknown"],
  ["PayPal button frame in the sandbox", { urls: ["https://www.paypal.com/sdk/js?client-id=AbC", "https://www.paypal.com/smart/buttons?env=sandbox&clientID=AbC"] }, "test"],
  ["PayPal button frame in production", { urls: ["https://www.paypal.com/smart/buttons?env=production&clientID=AbC"] }, "live"],
  ["PayPal SDK with the sandbox shortcut id", { urls: ["https://www.paypal.com/sdk/js?client-id=sb"] }, "test"],
  // Paddle
  ["Paddle sandbox frame", { urls: ["https://sandbox-buy.paddle.com/checkout?txn=txn_01"] }, "test"],
  ["Paddle live frame", { urls: ["https://buy.paddle.com/checkout?txn=txn_01"] }, "live"],
  ["Paddle.js with a test token", { urls: ["https://cdn.paddle.com/paddle/v2/paddle.js"], keys: ["test_7d279f61a3499fed520f7cd8c08"] }, "test"],
  ["Paddle.js with a live token", { urls: ["https://cdn.paddle.com/paddle/v2/paddle.js"], keys: ["live_7d279f61a3499fed520f7cd8c08"] }, "live"],
  ["Paddle.js set to sandbox", { urls: ["https://cdn.paddle.com/paddle/v2/paddle.js"], keys: ['Paddle.Environment.set("sandbox")'] }, "test"],
  ["Paddle sandbox frame but a live token on the page", { urls: ["https://sandbox-buy.paddle.com/checkout"], keys: ["live_7d279f61a3499fed520f7cd8c08"] }, "live"],
  ["a test_ token with no provider seen counts for nothing", { urls: ["https://shop.example/"], keys: ["test_7d279f61a3499fed520f7cd8c08"] }, "unknown"],
  ["Paddle sandbox API key alone (no Paddle script or frame)", { urls: [], keys: ["pdl_sdbx_apikey_01abcdef"] }, "unknown"],
  ["Paddle sandbox API key with Paddle's script", { urls: ["https://cdn.paddle.com/paddle/v2/paddle.js"], keys: ["pdl_sdbx_apikey_01abcdef"] }, "test"],
  ["Paddle live API key", { urls: [], keys: ["pdl_live_apikey_01abcdef"] }, "live"],
  // Shopify
  ["Shopify checkout with the test gateway", { urls: ["https://shop.myshopify.com/checkouts/cn/Z2Nw"], text: ["Payment\n(for testing) Bogus Gateway"] }, "test"],
  ["Shopify checkout without it", { urls: ["https://shop.myshopify.com/checkouts/cn/Z2Nw"], text: ["Payment\nCredit card"] }, "unknown"],
  ["Shopify checkout on a custom domain", { urls: ["https://shop.example.com/checkouts/cn/Z2Nw"] }, "unknown"],
  ["the Bogus Gateway words with no Shopify seen count for nothing", { urls: ["https://shop.example/"], text: ["(for testing) Bogus Gateway"] }, "unknown"],
  // Others, never "test" by mistake
  ["Adyen test host", { urls: ["https://checkoutshopper-test.adyen.com/checkoutshopper/sdk.js"] }, "test"],
  ["Adyen live host", { urls: ["https://checkoutshopper-live.adyen.com/checkoutshopper/sdk.js"] }, "live"],
  ["Braintree production key", { urls: [], keys: ["production_abc123de_xyz987fg"] }, "live"],
  ["Square sandbox", { urls: ["https://sandbox.web.squarecdn.com/v1/square.js"] }, "test"],
  ["Square live", { urls: ["https://web.squarecdn.com/v1/square.js"] }, "live"],
  // Mixed providers
  ["Stripe test and PayPal live on one page", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://www.paypal.com/checkoutnow?token=X"] }, "live"],
  ["Stripe test and an unknown Braintree frame", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://assets.braintreegateway.com/web/3/hosted-fields.html"] }, "unknown"],
  // Review: more gateways, seen so a Stripe test frame next to them is never "test" in all.
  ["Stripe test next to a Razorpay live key", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://checkout.razorpay.com/v1/checkout.js"], keys: ["rzp_live_abcdefgh"] }, "live"],
  ["Stripe test next to a Razorpay script with no key", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://checkout.razorpay.com/v1/checkout.js"] }, "unknown"],
  ["Stripe test next to Authorize.net's live Accept.js", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://js.authorize.net/v1/Accept.js"] }, "live"],
  ["Authorize.net sandbox Accept.js", { urls: ["https://jstest.authorize.net/v1/Accept.js"] }, "test"],
  ["Stripe test next to a Mollie frame", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://js.mollie.com/v1/mollie.js"] }, "unknown"],
  ["Stripe test next to a Klarna live script", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://x.klarnacdn.net/kp/lib/v1/api.js"] }, "unknown"],
  ["Stripe test next to a Checkout.com frame", { urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://js.checkout.com/framesv2.js"] }, "unknown"],
  // Nothing
  ["no provider at all", { urls: ["https://shop.example/cart"], text: ["Pay now"] }, "unknown"],
  ["an empty surface", { urls: [] }, "unknown"],
  ["addresses that don't parse", { urls: ["not a url", "javascript:alert(1)", "about:blank"] }, "unknown"],
  // Practice hosts read as the provider's
  ["practice Stripe host", { urls: ["http://checkout.stripe.localhost:5000/c/pay/cs_test_abcdef12"] }, "test"],
  ["practice PayPal live host", { urls: ["http://www.paypal.localhost:5000/checkoutnow?token=X"] }, "live"],
  ["a look-alike that isn't PayPal", { urls: ["https://www.sandbox.paypal.com.evil.example/checkoutnow"] }, "unknown"],
  // A key or session id counts wherever it shows (the shop's own page holds the publishable key); the host needn't be Stripe's.
  // Review: a look-alike host carrying a test session id is not Stripe's test mode (was "test").
  ["a cs_test_ id on a host that isn't Stripe's", { urls: ["https://checkout-stripe.com/c/pay/cs_test_abcdef12"] }, "unknown"],
  ["a cs_live_ id on a host that isn't Stripe's", { urls: ["https://checkout-stripe.com/c/pay/cs_live_abcdef12"] }, "live"],
];

describe("payMode", () => {
  for (const [name, surface, want] of CASES) it(`${name}: ${want}`, () => assert.equal(mode(surface), want));

  it("only test may pay; unknown and live never", () => {
    assert.equal(payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12"] }).mayPay, true);
    assert.equal(payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_live_abcdef12"] }).mayPay, false);
    assert.equal(payMode({ urls: ["https://shop.example/"] }).mayPay, false);
    assert.equal(payMode({ urls: ["https://shop.myshopify.com/checkouts/cn/Z"] }).mayPay, false);
  });

  it("a frame that couldn't be read stops test: it may hold a live key", () => {
    const r = payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12"], unread: 1 });
    assert.equal(r.mode, "unknown");
    assert.equal(r.mayPay, false);
    assert.match(r.reason, /couldn't be read/);
    assert.equal(payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_live_abcdef12"], unread: 1 }).mode, "live");
  });

  it("never puts a key from an address's path in its evidence", () => {
    const r = payMode({ urls: ["https://js.stripe.com/v3/pk_live_SuperSecretKey123/frame", "https://buy.paddle.com/pdl_live_PathSecret456/x"] });
    const said = JSON.stringify(r);
    for (const bit of ["SuperSecretKey123", "PathSecret456"]) assert.ok(!said.includes(bit), `evidence leaked ${bit}`);
  });

  it("says each provider's own mode", () => {
    const r = payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12", "https://www.paypal.com/checkoutnow?token=X"] });
    assert.deepEqual(r.providers.sort((a, b) => a.provider.localeCompare(b.provider)), [{ provider: "paypal", mode: "live" }, { provider: "stripe", mode: "test" }]);
    assert.match(r.reason, /paypal is live/);
  });

  it("never puts a whole key or session id in its evidence or reason", () => {
    const secret = "sk_liv" + "e_51Ve" + "rySecr" + "etValu" + "e999";
    const r = payMode({ urls: ["https://checkout.stripe.com/c/pa" + "y/cs_live_SessionSecret777", "https://js.stripe." + "com/v3/x.html#apiKey=pk_live_" + "PublishSecret888"], keys: [secret], text: [`key ${secret}`] });
    const said = JSON.stringify(r);
    for (const bit of ["VerySecretValue999", "SessionSecret777", "PublishSecret888"]) assert.ok(!said.includes(bit), `evidence leaked ${bit}`);
    assert.ok(r.sightings.some((s) => s.why.includes("sk_live_…")));
  });
});

describe("helpers", () => {
  it("keysIn finds each kind of key in a page's source", () => {
    const src = `<script>Stripe("pk_test_${""}51AbCdEf"); Paddle.Initialize({token:"live_7d279f61a34${""}99fed520f7cd8c08"}); var s = "cs_live_${""}abcdef12";</script>`;
    assert.deepEqual(keysIn(src).sort(), ["cs_live_abcdef12", "live_7d279f61a3499fed520f7cd8c08", "pk_test_51AbCdEf"]);
  });
  it("redact cuts every key in some text", () => {
    assert.equal(redact("a pk_live_AbCdEf123 and rzp_test_XyZ98765"), "a pk_live_… and rzp_test_…");
  });
  it("providerOf goes by host only: a key in a query never makes an address a provider's", () => {
    assert.equal(providerOf("https://checkout.stripe.com/c/pay/cs_test_abcdef12"), "stripe");
    assert.equal(providerOf("http://www.sandbox.paypal.localhost:5000/checkoutnow?token=X"), "paypal");
    assert.equal(providerOf("https://evil.example/?x=pk_live_abcdefgh"), undefined);
    assert.equal(providerOf("https://evil.example/c/pay/cs_test_abcdef12"), undefined);
    assert.equal(providerOf("https://www.sandbox.paypal.com.evil.example/"), undefined);
    assert.equal(providerOf("not a url"), undefined);
  });
  it("providerOf: a Shopify checkout path on another host is not Shopify's (a pay run never goes there); checkoutOf still sees a checkout", () => {
    assert.equal(providerOf("https://evil.example/checkouts/cn/Z2Nw"), undefined);
    assert.equal(providerOf("https://evil.example/checkouts/c/Z2Nw"), undefined);
    assert.equal(providerOf("https://shop.myshopify.com/checkouts/cn/Z2Nw"), "shopify");
    assert.equal(providerOf("http://fixture-dev.myshopify.localhost:5000/checkouts/cn/Z"), "shopify");
    assert.equal(checkoutOf("https://evil.example/checkouts/cn/Z2Nw"), "shopify");
    assert.equal(checkoutOf("https://checkout.stripe.com/c/pay/cs_test_abcdef12"), "stripe");
    assert.equal(checkoutOf("not a url"), undefined);
  });
  it("cut keeps the prefix only", () => {
    assert.equal(cut("pk_live_51AbCdEf"), "pk_live_…");
    assert.equal(cut("pdl_sdbx_apikey_01"), "pdl_sdbx_…");
    assert.equal(cut("whatever"), "wha…");
  });
  it("providerHost reads a practice .localhost name as .com, and nothing else", () => {
    assert.equal(providerHost("checkout.stripe.localhost"), "checkout.stripe.com");
    assert.equal(providerHost("WWW.PAYPAL.COM."), "www.paypal.com");
    assert.equal(providerHost("127.0.0.1"), "127.0.0.1");
    assert.equal(providerHost("localhost"), "localhost");
  });
});

// ---------------------------------------------------------------------------------------------
// paygate.ts

const TEST = payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_test_abcdef12"] });
const LIVE = payMode({ urls: ["https://checkout.stripe.com/c/pay/cs_live_abcdef12"] });
const UNKNOWN = payMode({ urls: ["https://shop.example/"] });
const base: GateInput = { name: "Pay", mode: TEST, owned: true, paymentsOn: true, finalPresses: 0, onProvider: false };

describe("pressKind", () => {
  for (const n of ["Pay with PayPal", "Pay on Stripe", "Buy now", "Subscribe", "Checkout", "Check out", "Proceed to checkout", "Continue to Payment", "Pay with Debit or Credit Card", "Upgrade"]) {
    it(`"${n}" only starts a checkout`, () => assert.equal(pressKind(n), "start"));
  }
  for (const n of ["Pay", "Pay now", "Pay Now", "Pay $165.00", "Complete Purchase", "Subscribe now", "Place order", "Confirm payment", "Pay with PayPal and place my order now please",
    // Review: these charge a stored method in one press (were "start").
    "Pay with card ending 4242", "Pay with saved card", "Pay with Apple Pay", "Pay with Google Pay", "Pay with Link", "Pay with Shop Pay", "Pay with balance"]) {
    it(`"${n}" is final`, () => assert.equal(pressKind(n), "final"));
  }
  for (const n of ["Subscribe", "Buy now", "Upgrade"]) {
    it(`"${n}" on a provider's page pays: final there (review)`, () => assert.equal(pressKind(n, true), "final"));
  }
  it(`"Pay with Debit or Credit Card" on PayPal's page still only opens the card form`, () => assert.equal(pressKind("Pay with Debit or Credit Card", true), "start"));
});

describe("payGate", () => {
  it("a final press in test mode on an owned host is allowed", () => assert.equal(payGate(base).allow, true));
  it("payments off: never", () => assert.equal(payGate({ ...base, paymentsOn: false }).allow, false));
  it("a host that isn't yours: never", () => assert.equal(payGate({ ...base, owned: false }).allow, false));
  it("live: never, start or final", () => {
    assert.equal(payGate({ ...base, mode: LIVE }).allow, false);
    assert.equal(payGate({ ...base, mode: LIVE, name: "Pay with PayPal" }).allow, false);
  });
  it("unknown: a start press may go to the checkout, a final press may not", () => {
    assert.equal(payGate({ ...base, mode: UNKNOWN, name: "Pay with PayPal" }).allow, true);
    const r = payGate({ ...base, mode: UNKNOWN, name: "Pay now" });
    assert.equal(r.allow, false);
    assert.match(r.allow ? "" : r.why, /test mode can't be seen/);
  });
  it("Stripe Checkout's \"Subscribe\" counts as the one payment: a second one is refused (review)", () => {
    assert.deepEqual(payGate({ ...base, name: "Subscribe", onProvider: true }), { allow: true, kind: "final" });
    assert.equal(payGate({ ...base, name: "Subscribe", onProvider: true, finalPresses: 1 }).allow, false);
  });
  it("\"Pay with card ending 4242\" on an unknown checkout is refused (review)", () => {
    assert.equal(payGate({ ...base, mode: UNKNOWN, name: "Pay with card ending 4242" }).allow, false);
  });
  it("after one final press, no final press again; a start press still may", () => {
    assert.equal(payGate({ ...base, finalPresses: 1 }).allow, false);
    assert.equal(payGate({ ...base, finalPresses: 1, name: "Pay on Stripe" }).allow, true);
  });
});

describe("liveOnSight", () => {
  it("stops a run on a live checkout, and only then", () => {
    assert.match(liveOnSight(LIVE) ?? "", /^BLOCKED: a live checkout/);
    assert.equal(liveOnSight(TEST), undefined);
    assert.equal(liveOnSight(UNKNOWN), undefined);
  });
  it("on a provider's own checkout page, unknown stops the run too (review: Shopify live was typed into)", () => {
    assert.match(liveOnSight(UNKNOWN, true) ?? "", /^BLOCKED: a checkout whose test mode can't be seen/);
    assert.equal(liveOnSight(TEST, true), undefined);
  });
});
