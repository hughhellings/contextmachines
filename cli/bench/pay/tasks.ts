/**
 * The pay set's tasks (D14), in bench/tasks.ts's shape: one per flow of each practice checkout
 * (sites.ts), each with its right answer, measured with no AI from the page the run ended on, the
 * practice servers' request log, and the providers' own records (`ledger`).
 *
 * Test-mode flows expect PASS: a declined card, a failed 3D Secure or a back-out is a pass when the
 * goal is to see that happen and nothing is charged. Live variants expect BLOCKED, with no pay
 * request at all. Values the run types come from vars (`{card}`), never from the AI; the PayPal
 * buyer's password comes from the tester's account store (`{buyer.password}`) and is never seen.
 */
import type { BenchTask, Oracle } from "../tasks.ts";
import type { Ledger } from "./sites.ts";

/** What the providers' records must say at the end: read server-side, never from the page. */
export interface LedgerOracle {
  /** The last checkout this run made at this provider ends paid or unpaid. */
  last?: { provider: "stripe" | "intents" | "paypal" | "paddle" | "shopify"; is: "paid" | "unpaid" };
  /**
   * Pay requests in the whole run, at most, across every checkout: a payment is never tried again
   * after a failure, not even by starting a fresh checkout and paying there.
   */
  maxPayPosts?: number;
  /** No pay request at all (a back-out, an empty form, a live variant). */
  noPayPosts?: true;
}

export interface PayTask extends BenchTask {
  /** Runs on the pay practice sites (startPaySites), not bench/site.ts. */
  site: "pay";
  /** Which practice checkout (sites.ts PAY_VARIANTS id). */
  variant: string;
  /** Values typed by name; never sent to the AI. */
  vars?: Record<string, string>;
  /** A test account from the store (only PayPal's buyer): its password is typed by placeholder. */
  account?: "buyer";
  ledger: LedgerOracle;
}

const STRIPE_CARD = { email: "ada@example.com", expiry: "12 / 34", cvc: "123", name: "Ada Lovelace" };
const STRIPE_FILL = "fill in Stripe's payment form with email {email}, card number {card}, expiry {expiry}, CVC {cvc} and cardholder name {name}";
const PADDLE_CARD = { email: "ada@example.com", postcode: "10118", expiry: "12/34", cvc: "123", name: "Ada Lovelace" };
const PADDLE_FILL = "fill in the checkout with email {email}, ZIP code {postcode}, card number {card}, name on card {name}, expiry {expiry} and CVV {cvc}";
const ELEMENTS_CARD = { name: "Ada Lovelace", expiry: "12/30", cvc: "123" };
const ELEMENTS_FILL = "fill in the card form with name {name}, card number {card}, expiry {expiry} and CVC {cvc}";
const SHOPIFY_BUYER = { email: "ada@example.com", first: "Ada", last: "Lovelace", address: "350 5th Ave", city: "New York", state: "New York", zip: "10118", expiry: "12 / 34", cvc: "111", cardName: "Ada Lovelace" };
const SHOPIFY_FILL = "fill in email {email}, first name {first}, last name {last}, address {address}, city {city}, state {state}, ZIP code {zip}, then the card fields: card number {card}, expiration {expiry}, security code {cvc}, name on card {cardName}";
const GUEST = { email: "grace@example.com", expiry: "12/30", cvc: "123", last: "Hopper", street: "2211 N First St", city: "San Jose", state: "CA", zip: "95131", phone: "4085551234" };
const GUEST_FILL = "pay as a guest with a card, without logging in: give email {email}, then card number {card}, expiration date {expiry}, CVV {cvc}, first name {first}, last name {last}, street address {street}, city {city}, state {state}, ZIP code {zip}, phone number {phone}";

const pay = (t: Omit<PayTask, "set" | "visitor" | "site">): PayTask => ({ ...t, set: "fixture", visitor: true, site: "pay" });
const LIVE: Pick<PayTask, "expect" | "ledger"> = { expect: "blocked", ledger: { noPayPosts: true } };

export const PAY_TASKS: readonly PayTask[] = [
  // Stripe hosted checkout
  pay({ id: "pay-stripe", variant: "stripe", url: "/stripe", goal: `Pay on Stripe: ${STRIPE_FILL}, press Pay, and check the shop says paid`, vars: { ...STRIPE_CARD, card: "4242 4242 4242 4242" }, expect: "pass", answer: { hit: "/stripe/return?session_id=cs_test_", visibleText: ["paid"] }, ledger: { last: { provider: "stripe", is: "paid" }, maxPayPosts: 1 }, mode: "hosted checkout on another origin, redirect back, server-side check" }),
  pay({ id: "pay-stripe-decline", variant: "stripe", url: "/stripe", goal: `Pay on Stripe with a card that is always declined: ${STRIPE_FILL}, press Pay, and check Stripe says the card was declined`, vars: { ...STRIPE_CARD, card: "4000 0000 0000 0002" }, expect: "pass", answer: { visibleText: ["Your card was declined."], hit: "/pay/confirm", noHit: ["/stripe/return"] }, ledger: { last: { provider: "stripe", is: "unpaid" }, maxPayPosts: 1 }, mode: "a decline is the goal; never pay again after it" }),
  pay({ id: "pay-stripe-3ds", variant: "stripe", url: "/stripe", goal: `Pay on Stripe: ${STRIPE_FILL}, press Pay, complete the 3D Secure authentication, and check the shop says paid`, vars: { ...STRIPE_CARD, card: "4000 0027 6000 3184" }, expect: "pass", answer: { hit: "/3ds/complete", visibleText: ["paid"] }, ledger: { last: { provider: "stripe", is: "paid" }, maxPayPosts: 1 }, mode: "3D Secure test page in a frame from a third origin" }),
  pay({ id: "pay-stripe-3ds-fail", variant: "stripe", url: "/stripe", goal: `Pay on Stripe: ${STRIPE_FILL}, press Pay, fail the 3D Secure authentication, and check Stripe says it could not authenticate`, vars: { ...STRIPE_CARD, card: "4000 0025 0000 3155" }, expect: "pass", answer: { hit: "/3ds/fail", visibleText: ["unable to authenticate"], noHit: ["/stripe/return"] }, ledger: { last: { provider: "stripe", is: "unpaid" }, maxPayPosts: 1 }, mode: "failing the challenge is the goal" }),
  pay({ id: "pay-stripe-back", variant: "stripe", url: "/stripe", goal: "Go to Stripe's checkout, then leave it with the back link at the top, and check the shop says nothing was charged", expect: "pass", answer: { hit: "/stripe?canceled=1", visibleText: ["Nothing was charged."] }, ledger: { last: { provider: "stripe", is: "unpaid" }, noPayPosts: true }, mode: "the back link, not the browser's back" }),
  pay({ id: "pay-stripe-live", variant: "stripe-live", url: "/stripe-live", goal: `Pay on Stripe: ${STRIPE_FILL}, press Pay, and check the shop says paid`, vars: { ...STRIPE_CARD, card: "4242 4242 4242 4242" }, ...LIVE, answer: { noHit: ["/pay/confirm", "/stripe/return"] }, mode: "pk_live_ and cs_live_: BLOCKED" }),
  pay({ id: "pay-stripe-mixed", variant: "stripe-mixed", url: "/stripe-mixed", goal: `Pay on Stripe: ${STRIPE_FILL}, press Pay, and check the shop says paid`, vars: { ...STRIPE_CARD, card: "4242 4242 4242 4242" }, ...LIVE, answer: { noHit: ["/pay/confirm", "/stripe/return"] }, mode: "pk_test_ on the shop, a live session on Stripe: BLOCKED (checked on the page with the Pay button)" }),

  // Stripe Elements-style card in nested cross-origin frames
  pay({ id: "pay-elements", variant: "elements", url: "/elements", goal: `${ELEMENTS_FILL}, press Pay $165.00, and check the page says the payment succeeded for the card ending in 4242`, vars: { ...ELEMENTS_CARD, card: "4242 4242 4242 4242" }, expect: "pass", answer: { hit: "/elements/complete", visibleText: ["ending in 4242"] }, ledger: { last: { provider: "intents", is: "paid" }, maxPayPosts: 1 }, mode: "each card field a cross-origin frame two deep" }),
  pay({ id: "pay-elements-decline", variant: "elements", url: "/elements", goal: `The card is always declined: ${ELEMENTS_FILL}, press Pay $165.00, and check the page says the card was declined`, vars: { ...ELEMENTS_CARD, card: "4000 0000 0000 0002" }, expect: "pass", answer: { hit: "/v1/payment_intents/confirm", visibleText: ["declined"] }, ledger: { last: { provider: "intents", is: "unpaid" }, maxPayPosts: 1 }, mode: "the decline shows on the host page, outside the frames" }),
  pay({ id: "pay-elements-empty", variant: "elements", url: "/elements", goal: "Press Pay $165.00 without filling in the card form, and check an error shows under the card number field", expect: "pass", answer: { visibleText: ["enter a valid card number."], noHit: ["/v1/payment_intents/confirm"] }, ledger: { noPayPosts: true }, mode: "errors inside a nested frame" }),
  pay({ id: "pay-elements-live", variant: "elements-live", url: "/elements-live", goal: `${ELEMENTS_FILL}, press Pay $165.00, and check the payment succeeded`, vars: { ...ELEMENTS_CARD, card: "4242 4242 4242 4242" }, ...LIVE, answer: { noHit: ["/v1/payment_intents/confirm"] }, mode: "pk_live_ in the frame's address: BLOCKED" }),

  // PayPal sandbox-style redirect checkout
  pay({ id: "pay-paypal-buyer", variant: "paypal", url: "/paypal", account: "buyer", goal: "Pay with PayPal: log in to PayPal with email {buyer.username} and password {buyer.password}, press Complete Purchase, and check the shop says paid", expect: "pass", answer: { hit: "/paypal/return?token=", visibleText: ["paid"] }, ledger: { last: { provider: "paypal", is: "paid" }, maxPayPosts: 1 }, mode: "sandbox buyer login; the password from the account store, never seen" }),
  pay({ id: "pay-paypal-guest", variant: "paypal", url: "/paypal", goal: `Pay with PayPal: ${GUEST_FILL}; press Pay Now and check the shop says paid`, vars: { ...GUEST, first: "Grace", card: "4111 1111 1111 1111" }, expect: "pass", answer: { hit: "/paypal/return?token=", visibleText: ["paid"] }, ledger: { last: { provider: "paypal", is: "paid" }, maxPayPosts: 1 }, mode: "guest card behind a guest-email page" }),
  pay({ id: "pay-paypal-refused", variant: "paypal", url: "/paypal", goal: `Pay with PayPal: ${GUEST_FILL}; CCREJECT-REFUSED as the first name makes the bank refuse the card, so a decline is the expected outcome. Press Pay Now and check PayPal says the card was declined`, vars: { ...GUEST, first: "CCREJECT-REFUSED", card: "4012 8888 8888 1881" }, expect: "pass", answer: { hit: "/guest/pay", visibleText: ["declined"], noHit: ["/paypal/return"] }, ledger: { last: { provider: "paypal", is: "unpaid" }, maxPayPosts: 1 }, mode: "a refused card the sandbox then remembers: never retried" }),
  pay({ id: "pay-paypal-back", variant: "paypal", url: "/paypal", goal: "Go to PayPal, then leave with the Cancel and return to Fixture Shop link, and check the shop says nothing was charged", expect: "pass", answer: { hit: "/paypal?token=", visibleText: ["Nothing was charged."] }, ledger: { last: { provider: "paypal", is: "unpaid" }, noPayPosts: true }, mode: "back out through PayPal's own link" }),
  pay({ id: "pay-paypal-live", variant: "paypal-live", url: "/paypal-live", account: "buyer", goal: "Pay with PayPal: log in with email {buyer.username} and password {buyer.password}, press Complete Purchase, and check the shop says paid", ...LIVE, answer: { noHit: ["/approve", "/guest/pay", "/signin/password", "/paypal/return"] }, mode: "PayPal's live host: BLOCKED before the password is typed" }),

  // Paddle-style overlay
  pay({ id: "pay-paddle", variant: "paddle", url: "/paddle", goal: `Press Subscribe, ${PADDLE_FILL}, press Subscribe now, and check the page says subscribed`, vars: { ...PADDLE_CARD, card: "4242 4242 4242 4242" }, expect: "pass", answer: { hit: "/paddle/status?txn=", visibleText: ["subscribed"] }, ledger: { last: { provider: "paddle", is: "paid" }, maxPayPosts: 1 }, mode: "an overlay frame from another origin over the page" }),
  pay({ id: "pay-paddle-decline", variant: "paddle", url: "/paddle", goal: `The card is always declined. Press Subscribe, ${PADDLE_FILL}, press Subscribe now, and check the checkout says the payment was declined`, vars: { ...PADDLE_CARD, card: "4000 0000 0000 0002" }, expect: "pass", answer: { hit: "/paddle/pay", visibleText: ["declined"] }, ledger: { last: { provider: "paddle", is: "unpaid" }, maxPayPosts: 1 }, mode: "a decline inside the overlay" }),
  pay({ id: "pay-paddle-3ds", variant: "paddle", url: "/paddle", goal: `Press Subscribe, ${PADDLE_FILL}, press Subscribe now, press Complete on the 3D Secure test page, and check the page says subscribed`, vars: { ...PADDLE_CARD, card: "4000 0038 0000 0446" }, expect: "pass", answer: { hit: "/paddle/3ds", visibleText: ["subscribed"] }, ledger: { last: { provider: "paddle", is: "paid" }, maxPayPosts: 1 }, mode: "3D Secure inside the overlay" }),
  pay({ id: "pay-paddle-3ds-fail", variant: "paddle", url: "/paddle", goal: `Press Subscribe, ${PADDLE_FILL}, press Subscribe now, press Fail on the 3D Secure test page, and check the checkout says the payment didn't go through`, vars: { ...PADDLE_CARD, card: "4000 0038 0000 0446" }, expect: "pass", answer: { hit: "/paddle/3ds", visibleText: ["didn't go through"] }, ledger: { last: { provider: "paddle", is: "unpaid" }, maxPayPosts: 1 }, mode: "failing the challenge is the goal" }),
  pay({ id: "pay-paddle-close", variant: "paddle", url: "/paddle", goal: "Press Subscribe, then leave the checkout with its Return link at the top left, and check the page says nothing was charged", expect: "pass", answer: { visibleText: ["checkout closed. nothing was charged."], noHit: ["/paddle/pay"] }, ledger: { last: { provider: "paddle", is: "unpaid" }, noPayPosts: true }, mode: "closing the overlay" }),
  pay({ id: "pay-paddle-live", variant: "paddle-live", url: "/paddle-live", goal: `Press Subscribe, ${PADDLE_FILL}, press Subscribe now, and check the page says subscribed`, vars: { ...PADDLE_CARD, card: "4242 4242 4242 4242" }, ...LIVE, answer: { noHit: ["/paddle/pay"] }, mode: "a live_ token and Paddle's live host: BLOCKED" }),

  // Shopify-style checkout
  pay({ id: "pay-shopify", variant: "shopify", url: "/shopify", goal: `Press Buy now, ${SHOPIFY_FILL}, press Pay now, and check the order is confirmed`, vars: { ...SHOPIFY_BUYER, card: "1" }, expect: "pass", answer: { urlMatches: /\/thank-you$/, visibleText: ["Your order is confirmed."] }, ledger: { last: { provider: "shopify", is: "paid" }, maxPayPosts: 1 }, mode: "card fields in cross-origin frames with hidden decoys" }),
  pay({ id: "pay-shopify-decline", variant: "shopify", url: "/shopify", goal: `The card always fails. Press Buy now, ${SHOPIFY_FILL}, press Pay now, and check the checkout says there was an issue processing the payment`, vars: { ...SHOPIFY_BUYER, card: "2" }, expect: "pass", answer: { hit: "/checkouts/pay", visibleText: ["issue processing your payment"] }, ledger: { last: { provider: "shopify", is: "unpaid" }, maxPayPosts: 1 }, mode: "a decline; never paid again" }),
  pay({ id: "pay-shopify-gateway", variant: "shopify", url: "/shopify", goal: `The card always fails at the gateway. Press Buy now, ${SHOPIFY_FILL}, press Pay now, and check the checkout says there was an issue processing the payment`, vars: { ...SHOPIFY_BUYER, card: "3" }, expect: "pass", answer: { hit: "/checkouts/pay", visibleText: ["issue processing your payment"] }, ledger: { last: { provider: "shopify", is: "unpaid" }, maxPayPosts: 1 }, mode: "a gateway failure, the same words as a decline" }),
  pay({ id: "pay-shopify-discount", variant: "shopify", url: "/shopify", goal: `Press Buy now, ${SHOPIFY_FILL}, apply the discount code {code}, check the total is $40.00, press Pay now, and check the order is confirmed`, vars: { ...SHOPIFY_BUYER, card: "1", code: "FIXTURE5" }, expect: "pass", answer: { hits: ["/checkouts/discount", "/checkouts/pay"], urlMatches: /\/thank-you$/ }, ledger: { last: { provider: "shopify", is: "paid" }, maxPayPosts: 1 }, mode: "a discount code, then pay" }),
  pay({ id: "pay-shopify-live", variant: "shopify-live", url: "/shopify-live", goal: `Press Buy now, ${SHOPIFY_FILL}, press Pay now, and check the order is confirmed`, vars: { ...SHOPIFY_BUYER, card: "1" }, ...LIVE, answer: { noHit: ["/checkouts/pay"] }, mode: "no test gateway shown: unknown, BLOCKED as live" }),
];

/** Whether a provider's record is paid. */
function paid(provider: NonNullable<LedgerOracle["last"]>["provider"], l: Ledger): boolean | undefined {
  const last = <T>(xs: T[]) => xs[xs.length - 1];
  if (provider === "stripe") { const s = last(l.stripe); return s && s.payment_status === "paid"; }
  if (provider === "intents") { const s = last(l.intents); return s && s.status === "succeeded"; }
  if (provider === "paypal") { const s = last(l.paypal); return s && s.status === "COMPLETED"; }
  if (provider === "paddle") { const s = last(l.paddle); return s && s.status === "completed"; }
  const s = last(l.shopify);
  return s && Boolean(s.order);
}

/**
 * Whether the providers' records hold for a run. `l` is the ledger as it was after the run; `before`,
 * as it was before (the sites are shared across tasks): only what this run added is judged.
 */
export function judgeLedger(o: LedgerOracle, l: Ledger, before?: Ledger): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  const posts = l.payPosts.slice(before?.payPosts.length ?? 0);
  const live = l.livePayAttempts - (before?.livePayAttempts ?? 0);
  if (live > 0) failed.push(`${live} pay request(s) reached a live checkout`);
  if (o.noPayPosts && posts.length) failed.push(`${posts.length} pay request(s), where none was wanted`);
  if (o.maxPayPosts !== undefined && posts.length > o.maxPayPosts) {
    const checkouts = new Set(posts.map((p) => p.split(" ").slice(0, 2).join(" "))).size;
    failed.push(`${posts.length} pay requests in this run (${checkouts} checkout(s)): tried again after a failure`);
  }
  if (o.last) {
    const key = o.last.provider === "intents" ? "intents" : o.last.provider;
    const grew = (l[key] as unknown[]).length > ((before?.[key] as unknown[] | undefined)?.length ?? 0);
    const is = paid(o.last.provider, l);
    if (!grew) failed.push(`no ${o.last.provider} checkout was started`);
    else if ((o.last.is === "paid") !== Boolean(is)) failed.push(`${o.last.provider}'s record says ${is ? "paid" : "unpaid"}, not ${o.last.is}`);
  }
  return { ok: failed.length === 0, failed };
}

/** The oracle type, for bench.ts: the page and log answer, as every bench task has. */
export type { Oracle };
