// The SDK: a mixed test (exact Playwright steps and agent steps) on the bench's practice site, with a
// scripted brain. A real browser on 127.0.0.1, no AI and no network.
//   node --test cli/sdk/*.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { launch } from "../../packages/scanner/src/tester/record.ts";
import { startFixtureSite, type FixtureSite } from "../bench/site.ts";
import { AgentStepError, createAgent, type Action, type AgentBrain, type Check, type DecideInput } from "./index.ts";

/** One scripted move: an action, or one picked from the snapshot by role and name. */
type Move = Action | ((i: DecideInput) => Action);

function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1]! : "e9999";
}
const click = (role: string, name: string): Move => (i) => ({ type: "click", ref: refIn(i.snapshot, role, name) });
const fill = (role: string, name: string, value: string): Move => (i) => ({ type: "fill", ref: refIn(i.snapshot, role, name), value });
const done: Move = { type: "done" };

interface Scripted extends AgentBrain {
  calls: number;
  seen: string[];
}

/** Moves per intent, in order; words to checks for assert. Every input it is given is kept, to look for leaks. */
function scripted(moves: Record<string, Move[]>, checks: Record<string, Check> = {}): Scripted {
  const left = Object.fromEntries(Object.entries(moves).map(([k, m]) => [k, [...m]]));
  const brain: Scripted = {
    calls: 0,
    seen: [],
    async decide(input) {
      brain.calls++;
      brain.seen.push(JSON.stringify(input));
      const move = left[input.step.intent]?.shift() ?? done;
      return typeof move === "function" ? move(input) : move;
    },
    async check(words, page) {
      brain.calls++;
      brain.seen.push(JSON.stringify({ words, page }));
      const c = checks[words];
      if (!c) throw new Error(`no scripted check for "${words}"`);
      return c;
    },
  };
  return brain;
}

/** A brain that must never be asked: a replay. */
const noAi = (): Scripted => {
  const b: Scripted = {
    calls: 0,
    seen: [],
    async decide() {
      b.calls++;
      throw new Error("the AI was asked during a replay");
    },
    async check() {
      b.calls++;
      throw new Error("the AI was asked during a replay");
    },
  };
  return b;
};

let browser: Browser;
let site: FixtureSite;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-sdk-"));
  dirs.push(d);
  return d;
};
const contexts: BrowserContext[] = [];
async function newPage(): Promise<Page> {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(c);
  return c.newPage();
}
const at = (path: string) => new URL(path, site.url).href;

before(async () => {
  browser = await launch();
  site = await startFixtureSite();
});
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const INTENT = "Type AAPL into the search box and open the Apple row";
const CHART: Check = { kind: "url_contains", text: "symbol=AAPL" };

/** The mixed test, as a developer would write it: exact locators around agent steps. */
async function mixedTest(brain: AgentBrain, cache: string) {
  const page = await newPage();
  const agent = await createAgent(page, { start: site.url, brain, cache, checkWaitMs: 1500, name: "Search for AAPL and open its chart" });
  // Exact Playwright: the developer's own locators.
  await page.goto(at("/palette"));
  await page.getByRole("button", { name: "Search (⌘K)" }).click();
  // The agent: finds the box and the plain-div row from the page itself.
  const acted = await agent.act(INTENT, { check: CHART });
  // Measured by the browser: a check, and words turned into a check (once, then cached).
  await agent.assert({ kind: "text_visible", text: "AAPL chart" });
  const said = await agent.assert("the page heading says AAPL chart");
  // Exact Playwright again, as a named step.
  await agent.step("the title names the chart", async (p) => {
    const title = await p.title();
    if (!/AAPL chart/.test(title)) throw new Error(`title was ${title}`);
  });
  const report = await agent.finish();
  return { page, acted, said, report };
}

describe("a mixed test: exact locators and agent steps", () => {
  it("passes on the practice site with a scripted brain, then replays from its cache with 0 AI calls", async () => {
    const cache = join(tmp(), "search.json");
    const brain = scripted(
      { [INTENT]: [fill("searchbox", "Symbol, ISIN, or CUSIP", "AAPL"), click("item", "AAPL Apple Inc"), done] },
      { "the page heading says AAPL chart": { kind: "element_visible", role: "heading", name: "AAPL chart" } },
    );
    const from = site.hits().length;
    const first = await mixedTest(brain, cache);
    assert.equal(first.report.verdict, "pass", JSON.stringify(first.report.steps, null, 1));
    assert.deepEqual(first.report.steps.map((s) => [s.kind, s.verdict]), [["act", "passed"], ["assert", "passed"], ["assert", "passed"], ["code", "passed"]]);
    assert.ok(first.acted.aiCalls >= 3, "the fresh act asked the AI");
    assert.deepEqual(first.said.check, { kind: "element_visible", role: "heading", name: "AAPL chart" }, "the words' check is shown");
    assert.equal(first.said.derived, true);
    assert.equal(first.report.cacheWritten, cache);
    assert.ok(site.hits().slice(from).includes("/chart/?symbol=AAPL"), "the chart was really opened");
    const saved = JSON.parse(readFileSync(cache, "utf8"));
    assert.equal(saved.steps.length, 2, "the act and the worded assert are saved; the check-object assert and code step are code");
    assert.ok(!JSON.stringify(saved).includes("\"ref\""), "no snapshot refs are saved");

    const replayBrain = noAi();
    const from2 = site.hits().length;
    const again = await mixedTest(replayBrain, cache);
    assert.equal(again.report.verdict, "pass", JSON.stringify(again.report.steps, null, 1));
    assert.equal(replayBrain.calls, 0, "the replay asked no AI");
    assert.equal(again.report.aiCalls, 0);
    assert.equal(again.report.replay, true);
    assert.equal(again.acted.replayed, true);
    assert.equal(again.report.cacheWritten, undefined, "a replay leaves the cache as it was");
    assert.ok(site.hits().slice(from2).includes("/chart/?symbol=AAPL"), "the replay really opened the chart");
  });

  it("replays with no brain at all, and a changed check still measures (an assert never caches a verdict)", async () => {
    const cache = join(tmp(), "search.json");
    const brain = scripted({ [INTENT]: [fill("searchbox", "Symbol, ISIN, or CUSIP", "AAPL"), click("item", "AAPL Apple Inc"), done] }, { "the page heading says AAPL chart": { kind: "element_visible", role: "heading", name: "AAPL chart" } });
    await mixedTest(brain, cache);
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, cache, checkWaitMs: 500 });
    await page.goto(at("/palette"));
    await page.getByRole("button", { name: "Search (⌘K)" }).click();
    await agent.act(INTENT, { check: CHART });
    const wrong = await agent.assert({ kind: "text_visible", text: "MSFT chart" }, { soft: true });
    assert.equal(wrong.verdict, "failed");
    assert.match(wrong.reason ?? "", /the check didn't hold/);
    assert.ok(wrong.evidence?.found, "a failed check says what the page had");
    assert.equal((await agent.finish()).verdict, "fail");
  });

  it("a saved element that has gone is NOT SURE without an AI, and healed (flagged) with one", async () => {
    const cache = join(tmp(), "search.json");
    const brain = scripted({ [INTENT]: [fill("searchbox", "Symbol, ISIN, or CUSIP", "AAPL"), click("item", "AAPL Apple Inc"), done] }, { "the page heading says AAPL chart": { kind: "element_visible", role: "heading", name: "AAPL chart" } });
    await mixedTest(brain, cache);
    // The saved row's name changes: the cache points at an element that isn't there.
    const file = JSON.parse(readFileSync(cache, "utf8"));
    const click1 = file.steps[0].actions.find((a: { type: string }) => a.type === "click");
    click1.target.name = "AAPL Apple Incorporated";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cache, JSON.stringify(file));

    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, cache, checkWaitMs: 500 });
    await page.goto(at("/palette"));
    await page.getByRole("button", { name: "Search (⌘K)" }).click();
    const unsure = await agent.act(INTENT, { check: CHART, soft: true });
    assert.equal(unsure.verdict, "not_sure", JSON.stringify(unsure));

    const healer = scripted({ [INTENT]: [click("item", "AAPL Apple Inc"), done] });
    const page2 = await newPage();
    const agent2 = await createAgent(page2, { start: site.url, cache, brain: healer, checkWaitMs: 1000 });
    await page2.goto(at("/palette"));
    await page2.getByRole("button", { name: "Search (⌘K)" }).click();
    const healed = await agent2.act(INTENT, { check: CHART });
    assert.equal(healed.verdict, "passed");
    assert.ok(healed.healed && healed.healed.from.length > 0 && healed.healed.to.length > 0, JSON.stringify(healed));
    assert.ok(healer.calls > 0);
  });
});

describe("safety stops surface as BLOCKED", () => {
  it("the AI clicking \"Buy AAPL now\" is BLOCKED (a typed error), and the site never sees /buy", async () => {
    const page = await newPage();
    const brain = scripted({ "Buy AAPL": [fill("searchbox", "Symbol, ISIN, or CUSIP", "AAPL"), click("item", "Buy AAPL now")] });
    const agent = await createAgent(page, { start: site.url, brain, checkWaitMs: 500 });
    await page.goto(at("/palette"));
    await page.getByRole("button", { name: "Search (⌘K)" }).click();
    const from = site.hits().length;
    const thrown = await agent.act("Buy AAPL", { check: { kind: "url_contains", text: "/buy" } }).then(() => undefined, (e: unknown) => e);
    assert.ok(thrown instanceof AgentStepError, `a typed error, not a generic one: ${String(thrown)}`);
    assert.equal(thrown.verdict, "blocked");
    assert.match(thrown.message, /^BLOCKED: step 1 \(Buy AAPL\): .*Buy AAPL now/);
    assert.ok(!site.hits().slice(from).some((h) => h.startsWith("/buy")), site.hits().slice(from).join(" "));
    // The steps after it don't run, and the test is BLOCKED, never a FAIL.
    const next = await agent.assert({ kind: "text_visible", text: "Order placed" }, { soft: true });
    assert.equal(next.verdict, "skipped");
    assert.equal((await agent.finish()).verdict, "blocked");
  });

  it("{ soft: true } returns the BLOCKED step instead of throwing", async () => {
    const page = await newPage();
    const brain = scripted({ "Buy AAPL": [fill("searchbox", "Symbol, ISIN, or CUSIP", "AAPL"), click("item", "Buy AAPL now")] });
    const agent = await createAgent(page, { start: site.url, brain, checkWaitMs: 500 });
    await page.goto(at("/palette"));
    await page.getByRole("button", { name: "Search (⌘K)" }).click();
    const step = await agent.act("Buy AAPL", { check: { kind: "url_contains", text: "/buy" }, soft: true });
    assert.equal(step.verdict, "blocked");
    assert.ok(step.actions.some((a) => /^Stopped before/.test(a)), JSON.stringify(step.actions));
  });

  it("a locator step that navigates to another site is BLOCKED, and nothing reaches it", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url });
    const from = site.hits().length;
    const step = await agent.step("open the other site", (p) => p.goto(new URL("/ad-click", site.otherUrl).href), { soft: true });
    assert.equal(step.verdict, "blocked", JSON.stringify(step));
    assert.match(step.reason ?? "", /another site/);
    assert.ok(!site.hits().slice(from).includes("/ad-click"));
  });

  it("an error in the developer's own locator code is a FAIL with its message", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url });
    await page.goto(at("/palette"));
    const thrown = await agent.step("click a missing button", (p) => p.getByRole("button", { name: "No such button" }).click({ timeout: 300 })).then(() => undefined, (e: unknown) => e);
    assert.ok(thrown instanceof AgentStepError);
    assert.equal(thrown.verdict, "failed");
    assert.match(thrown.message, /^FAIL: step 1/);
  });

  it("a bot check that stays is BLOCKED and never answered", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, wallWaitMs: 500 });
    const step = await agent.step("open the shop", (p) => p.goto(at("/wall")), { soft: true });
    assert.equal(step.verdict, "blocked", JSON.stringify(step));
    assert.match(step.reason ?? "", /bot check/i);
  });
});

describe("secrets by handle", () => {
  it("a value typed as {place} never reaches the AI or the cache, and replays from the handle", async () => {
    const secret = "Zq9Kestrelmoor";
    const cache = join(tmp(), "place.json");
    const intent = "Type {place} into the place search box";
    const check: Check = { kind: "text_visible", text: "{place} Harbour" };
    const run = async (brain: AgentBrain) => {
      const page = await newPage();
      const agent = await createAgent(page, { start: site.url, brain, cache, vars: { place: secret }, checkWaitMs: 4000 });
      await page.goto(at("/suggest"));
      await agent.act(intent, { check });
      return agent.finish();
    };
    const brain = scripted({ [intent]: [(i) => ({ type: "fill", ref: refIn(i.snapshot, "searchbox", "Find a place"), value: "{place}" }), { type: "press", key: "End" }, done] });
    const first = await run(brain);
    assert.equal(first.verdict, "pass", JSON.stringify(first.steps, null, 1));
    assert.ok(brain.calls > 0);
    assert.ok(!brain.seen.join("\n").includes(secret), "the AI never saw the value");
    assert.ok(brain.seen.some((s) => s.includes("place")), "the AI was told the handle's name");
    const text = readFileSync(cache, "utf8");
    assert.ok(!text.includes(secret), "the cache holds no value");
    assert.ok(text.includes("{place}"), "the cache holds the handle");
    assert.ok(!JSON.stringify(first).includes(secret), "the report holds no value");
    const replay = noAi();
    const again = await run(replay);
    assert.equal(again.verdict, "pass", JSON.stringify(again.steps, null, 1));
    assert.equal(replay.calls, 0);
  });
});

// Final fixes: the SDK gets E10's hold too. A press that would send a form past an unsolved captcha box
// is never made; the step is BLOCKED and nothing reaches the site. The scripted brain never touches the box.
describe("an unsolved captcha box holds the send (E10, as in runTest)", async () => {
  const { startProtectSites } = await import("../app/sites/protect.ts");
  let b: Browser;
  let protect: Awaited<ReturnType<typeof startProtectSites>>;
  before(async () => { b = await launch(); protect = await startProtectSites(); });
  after(async () => { await b?.close(); await protect?.close(); });
  for (const variant of ["recaptcha-live", "turnstile-live", "hcaptcha-live"]) {
    for (const how of ["click", "enter"] as const) {
      it(`${variant}, by ${how}: BLOCKED, the form never sent`, async () => {
        protect.reset();
        const page = await b.newPage();
        const url = new URL(`/signup/${variant}`, protect.url).href;
        await page.goto(url);
        const intent = "Type ada@example.com as the email and send the form";
        const brain = scripted({ [intent]: [fill("textbox", "Email", "ada@example.com"), how === "click" ? click("button", "Create account") : { type: "press", key: "Enter" }] });
        const agent = await createAgent(page, { start: url, brain, wallWaitMs: 300, checkWaitMs: 1000 });
        const step = await agent.act(intent, { soft: true, check: { kind: "text_visible", text: "Your account is ready." } });
        const L = protect.ledger();
        await page.close();
        assert.equal(step.verdict, "blocked", JSON.stringify(step));
        assert.match(step.reason ?? "", /stood in the way/);
        assert.equal(L.refused.length + L.signups.length, 0, "the form went to the site with the box unsolved");
      });
    }
  }
});
