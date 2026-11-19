// D14 end to end: runTest on the pay practice sites (bench/pay/sites.ts) with a scripted planner and
// actor, no AI and no network. Test-mode checkouts PASS (paid or declined, as the goal says), live ones
// end BLOCKED with no pay request, a payment is never tried twice, and with payments off nothing pays.
//   node --test cli/pay-run.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { changeOf, type Snapshot } from "../packages/scanner/src/tester/observe.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest, type RunOptions } from "../packages/scanner/src/tester/run.ts";
import { CouldNotRun, type Action, type Check, type PlannedStep, type TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { CARDS, HOSTS, startPaySites, type Ledger, type PaySites } from "./bench/pay/sites.ts";
import { judgeLedger } from "./bench/pay/tasks.ts";

type Move = Action | { pick: "click" | "fill"; role: string; name: string; value?: string };

function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1]! : "e9999";
}

function scripted(plan: PlannedStep[], moves: Record<number, Move[]>): TesterBrain {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  return {
    async plan() {
      return plan;
    },
    async decide(input) {
      const move = left[input.n]?.shift() ?? { type: "done" };
      if ("pick" in move) {
        const ref = refIn(input.snapshot, move.role, move.name);
        return move.pick === "click" ? { type: "click", ref } : { type: "fill", ref, value: move.value ?? "" };
      }
      return move;
    },
  };
}

const step = (title: string, check: Check): PlannedStep => ({ title, intent: title, check });
const click = (name: string, role = "button"): Move => ({ pick: "click", role, name });
const fill = (name: string, value: string): Move => ({ pick: "fill", role: "textbox", name, value });

const STRIPE_VARS = { email: "ada@example.com", expiry: "12 / 34", cvc: "123", name: "Ada Lovelace" };
const STRIPE_FORM: Move[] = [fill("Email", "{email}"), fill("Card number", "{card}"), fill("Expiration", "{expiry}"), fill("CVC", "{cvc}"), fill("Cardholder name", "{name}")];

let browser: Browser;
let sites: PaySites;
const dirs: string[] = [];

before(async () => {
  browser = await launch();
  sites = await startPaySites();
});
after(async () => {
  await browser?.close();
  await sites?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** One run on the practice shop, paying allowed on 127.0.0.1 (the shop) unless `payments` says otherwise. */
async function run(path: string, brain: TesterBrain, o: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cm-pay-"));
  dirs.push(dir);
  const before: Ledger = sites.ledger();
  const from = sites.hits().length;
  const out = await runTest({ url: new URL(path, sites.shop).href, goal: "pay", dir, browser, brain, checkWaitMs: 1500, visitor: false, payments: { owned: ["127.0.0.1"] }, allowHosts: [], ...o });
  return { out, before, after: sites.ledger(), hits: sites.hits().slice(from), reasons: out.result.steps.map((s) => s.reason ?? "").join(" | ") };
}

describe("D14: paying in a provider's test mode, on an owned host", () => {
  it("Stripe hosted checkout, test card: PASS, paid once, the card number never shown", async () => {
    const brain = scripted(
      [step("Open Stripe's checkout", { kind: "url_contains", text: "/c/pay/cs_test_" }), step("Pay with the test card", { kind: "text_visible", text: "Thanks for your order" })],
      { 1: [click("Pay on Stripe"), { type: "done" }], 2: [...STRIPE_FORM, click("Pay"), { type: "done" }] },
    );
    const r = await run("/stripe", brain, { vars: { ...STRIPE_VARS, card: CARDS.stripe.pays } });
    assert.equal(r.out.result.verdict, "pass", r.reasons);
    const j = judgeLedger({ last: { provider: "stripe", is: "paid" }, maxPayPosts: 1 }, r.after, r.before);
    assert.ok(j.ok, j.failed.join("; "));
    assert.ok(!JSON.stringify(r.out.result).includes("4242"), "the card number is masked everywhere in the result");
  });

  it("a declined card is the goal: PASS, one pay request; pressing Pay again is BLOCKED (never retried)", async () => {
    const brain = scripted(
      [
        step("Open Stripe's checkout", { kind: "url_contains", text: "/c/pay/cs_test_" }),
        step("Pay with the declined card", { kind: "text_visible", text: "Your card was declined." }),
        step("Try again", { kind: "text_visible", text: "Thanks for your order" }),
      ],
      { 1: [click("Pay on Stripe"), { type: "done" }], 2: [...STRIPE_FORM, click("Pay"), { type: "done" }], 3: [click("Pay")] },
    );
    const r = await run("/stripe", brain, { vars: { ...STRIPE_VARS, card: CARDS.stripe.declined } });
    const [s1, s2, s3] = r.out.result.steps;
    assert.equal(s1?.verdict, "passed", r.reasons);
    assert.equal(s2?.verdict, "passed", r.reasons);
    assert.equal(s3?.verdict, "blocked", r.reasons);
    assert.match(s3?.reason ?? "", /never tried again/);
    const j = judgeLedger({ last: { provider: "stripe", is: "unpaid" }, maxPayPosts: 1 }, r.after, r.before);
    assert.ok(j.ok, j.failed.join("; "));
  });

  it("one final press across runs of one test (a sign-in again runs it twice): the second run's Pay is BLOCKED", async () => {
    const payments = { owned: ["127.0.0.1"], finalPresses: { n: 0 } };
    const brain = () => scripted(
      [step("Open Stripe's checkout", { kind: "url_contains", text: "/c/pay/cs_test_" }), step("Pay with the test card", { kind: "text_visible", text: "Thanks for your order" })],
      { 1: [click("Pay on Stripe"), { type: "done" }], 2: [...STRIPE_FORM, click("Pay"), { type: "done" }] },
    );
    const vars = { ...STRIPE_VARS, card: CARDS.stripe.declined };
    const first = await run("/stripe", brain(), { vars, payments });
    const second = await run("/stripe", brain(), { vars, payments });
    assert.equal(payments.finalPresses.n, 1, first.reasons);
    assert.equal(second.out.result.steps[1]?.verdict, "blocked", second.reasons);
    assert.match(second.reasons, /never tried again/);
    const j = judgeLedger({ maxPayPosts: 1 }, second.after, first.before);
    assert.ok(j.ok, j.failed.join("; "));
  });

  it("PayPal sandbox, guest card: PASS through PayPal's own pages, paid once", async () => {
    const vars = { email: "grace@example.com", card: CARDS.paypal.pays, expiry: "12/30", cvc: "123", first: "Grace", last: "Hopper", street: "2211 N First St", city: "San Jose", state: "CA", zip: "95131", phone: "4085551234" };
    const brain = scripted(
      [step("Go to PayPal", { kind: "text_visible", text: "Pay with PayPal" }), step("Pay as a guest", { kind: "text_visible", text: "Thanks for your order" })],
      {
        1: [click("Pay with PayPal"), { type: "done" }],
        2: [
          click("Pay with Debit or Credit Card", "link"), fill("Email", "{email}"), click("Continue to Payment"),
          fill("Card number", "{card}"), fill("Expiration date", "{expiry}"), fill("CVV", "{cvc}"), fill("First name", "{first}"), fill("Last name", "{last}"),
          fill("Street address", "{street}"), fill("City", "{city}"), fill("State", "{state}"), fill("ZIP code", "{zip}"), fill("Phone number", "{phone}"),
          click("Pay Now"), { type: "done" },
        ],
      },
    );
    const r = await run("/paypal", brain, { vars, maxPerStep: 20 });
    assert.equal(r.out.result.verdict, "pass", r.reasons);
    const j = judgeLedger({ last: { provider: "paypal", is: "paid" }, maxPayPosts: 1 }, r.after, r.before);
    assert.ok(j.ok, j.failed.join("; "));
  });
});

describe("D14: live (or unknown) checkouts end BLOCKED with no pay request", () => {
  const live: [string, string, Move[]][] = [
    ["/stripe-live", "a pk_live_ shop page, stopped before anything is pressed", [click("Pay on Stripe"), ...STRIPE_FORM, click("Pay")]],
    ["/stripe-mixed", "a pk_test_ shop page that opens a live session, stopped on Stripe's page", [click("Pay on Stripe"), ...STRIPE_FORM, click("Pay")]],
    ["/paypal-live", "PayPal's live host, stopped before the email is typed", [click("Pay with PayPal"), fill("Email or mobile number", "buyer@example.test"), click("Next")]],
    ["/paddle-live", "a live_ Paddle token", [click("Subscribe")]],
    ["/elements-live", "pk_live_ in the card frame's address", [click("Pay $165.00")]],
    ["/shopify-live", "a Shopify checkout with no test gateway (unknown)", [click("Buy now"), click("Pay now")]],
  ];
  for (const [path, what, moves] of live) {
    it(`${path}: ${what}`, async () => {
      const brain = scripted([step("Pay", { kind: "text_visible", text: "Thanks for your order" })], { 1: moves });
      const r = await run(path, brain, { vars: { ...STRIPE_VARS, card: CARDS.stripe.pays } });
      assert.equal(r.out.result.verdict, "blocked", r.reasons);
      assert.match(r.reasons, /live|test mode can't be seen/);
      const j = judgeLedger({ noPayPosts: true }, r.after, r.before);
      assert.ok(j.ok, j.failed.join("; "));
      assert.equal(r.after.livePayAttempts, r.before.livePayAttempts);
    });
  }
});

describe("D14: what stays as it was", () => {
  it("payments off: the deny list stands (\"Pay on Stripe\" isn't pressed, no checkout is made)", async () => {
    const brain = scripted([step("Open Stripe's checkout", { kind: "url_contains", text: "/c/pay/" })], { 1: [click("Pay on Stripe")] });
    const r = await run("/stripe", brain, { payments: undefined });
    assert.equal(r.out.result.verdict, "blocked", r.reasons);
    assert.match(r.reasons, /paying or moving money/);
    assert.equal(r.after.stripe.length, r.before.stripe.length);
  });

  it("a host not marked as yours: nothing pays", async () => {
    const brain = scripted([step("Open Stripe's checkout", { kind: "url_contains", text: "/c/pay/" })], { 1: [click("Pay on Stripe")] });
    const r = await run("/stripe", brain, { payments: { owned: ["shop.example"] } });
    assert.equal(r.out.result.verdict, "blocked", r.reasons);
    assert.match(r.reasons, /only on a site marked as yours/);
    assert.equal(r.after.stripe.length, r.before.stripe.length);
  });

  it("a visitor's test never pays", async () => {
    await assert.rejects(run("/stripe", scripted([], {}), { visitor: true }), CouldNotRun);
  });

  it("a navigate action to a provider's page is still another site", async () => {
    const brain = scripted([step("Go to Stripe", { kind: "url_contains", text: "stripe" })], { 1: [{ type: "navigate", url: `${sites.origin("stripeCheckout")}/c/pay/cs_test_x` }] });
    const r = await run("/stripe", brain, { goal: "go to Stripe's page" });
    assert.equal(r.out.result.verdict, "blocked", r.reasons);
    assert.match(r.reasons, new RegExp(`${HOSTS.stripeCheckout}.* is another site`));
  });
});

describe("D14: the command", () => {
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
    const { CI: _ci, ANTHROPIC_API_KEY: _key, ...rest } = process.env;
    const child = spawn(process.execPath, [join(import.meta.dirname, "contextmachines.ts"), "test", ...args], { env: { ...rest, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => done({ code, out }));
  });

  it("--pay refuses a host not marked as yours, before anything opens", async () => {
    const out = mkdtempSync(join(tmpdir(), "cm-pay-cli-"));
    dirs.push(out);
    const r = await cli(["buy the mug", "--pay", "--url", new URL("/stripe", sites.shop).href, "--out", out, "--ai", "none"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--pay pays only on a host you've marked as yours/);
  });

  it("--pay goes with one goal, not the saved tests", async () => {
    const r = await cli(["--pay", "--out", mkdtempSync(join(tmpdir(), "cm-pay-cli-")), "--ai", "none"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /--pay goes with one test/);
  });
});

describe("a masked address", () => {
  it("a value masked inside a port (\"5{cvc}0\") doesn't break the actor's history (it threw Invalid URL)", () => {
    const snap = (url: string) => ({ url, keys: url, usable: new Set<string>(), open: [] as string[] }) as unknown as Snapshot;
    assert.match(changeOf(snap("http://127.0.0.1:5{cvc}0/stripe"), snap("http://checkout.stripe.localhost:5{cvc}0/c/pay/cs_test_x")), /went to/);
  });
});
