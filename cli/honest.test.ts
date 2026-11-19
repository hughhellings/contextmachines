// The "add a trade" false pass (2026-11-18), reproduced on the fixture site's trade ledger
// (bench/trade-site.ts) with a scripted AI that does what the real run's AI did: a step whose intent
// says to fill in a manual trade and save it, checked by the word "Manual", whose only action was
// "Add trade" (an import wizard that already says "Manually, from a file or by connecting the
// platform"). That was a PASS; it must never be one. A run that really fills and saves, checked by
// what the save shows, still passes. Also: a wait on a settled page is cut short, and the goal judge.
//   node --test cli/honest.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { checkGuesses, needsOf, planDropsSave, runTest } from "../packages/scanner/src/tester/run.ts";
import { goalAsks, goalJudgeClaim, intentNeeds, intentShortfall, savePress, withoutSignIn } from "../packages/scanner/src/tester/intent.ts";
import { networkWatch, waitForChange, waitWords } from "../packages/scanner/src/tester/waitfor.ts";
import type { Action, DecideInput, JudgeAnswer, JudgeInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { startFixtureSite, type FixtureSite } from "./bench/site.ts";
import { PLAN_SYSTEM } from "./test-command.ts";

let browser: Browser;
let site: FixtureSite;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-honest-"));
  dirs.push(d);
  return d;
};
const at = (path: string) => new URL(path, site.url).href;

before(async () => {
  browser = await launch();
  site = await startFixtureSite();
});
after(async () => {
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Move = (input: DecideInput) => Action;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function refOf(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${esc(name)}`).exec(snapshot);
  if (!m) throw new Error(`no ${role} ${name} in the snapshot:\n${snapshot.slice(0, 3000)}`);
  return m[1]!;
}
const click = (role: string, name: string): Move => (i) => ({ type: "click", ref: refOf(i.snapshot, role, name) });
const fill = (role: string, name: string, value: string): Move => (i) => ({ type: "fill", ref: refOf(i.snapshot, role, name), value });
const wait: Move = () => ({ type: "wait", ms: 5000 });
const done: Move = () => ({ type: "done" });

/** A scripted AI: the plan given, each step's moves in order, then "done". An optional judge. */
function brainOf(plan: PlannedStep[], moves: Record<number, Move[]>, judge?: (input: JudgeInput) => JudgeAnswer): TesterBrain & { seen: DecideInput[]; judged: JudgeInput[] } {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  const brain = {
    seen: [] as DecideInput[],
    judged: [] as JudgeInput[],
    async plan() {
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      brain.seen.push(input);
      return (left[input.n]?.shift() ?? done)(input);
    },
    ...(judge
      ? {
          async judge(input: JudgeInput) {
            brain.judged.push(input);
            return judge(input);
          },
        }
      : {}),
  };
  return brain;
}

const GOAL = "sign in and can we add a trade please manual trade any entry?";
/** The real run's plan, word for word. */
const OPEN: PlannedStep = { title: "Open add trade", intent: "From the app's navigation, open the trades area and choose to add a new trade.", check: { kind: "url_contains", text: "trade" } };
const SAVE = (check: PlannedStep["check"]): PlannedStep => ({ title: "Save a manual trade", intent: "Choose the manual trade option, fill in any entry with plainly made-up test values, and press the save or add button to submit it.", check });
const MANUAL: PlannedStep["check"] = { kind: "text_visible", text: "Manual" };
const SAVED: PlannedStep["check"] = { kind: "text_visible", text: "Trade saved" };
const fillAndSave: Move[] = [click("button", "Add trade"), click("link", "Manual entry"), fill("textbox", "Symbol", "TEST"), fill("spinbutton", "Quantity", "1"), fill("spinbutton", "Entry price", "100"), click("button", "Save trade")];
const saves = (from: number) => site.hits().slice(from).filter((h) => h.startsWith("/tj/trades/save"));

describe("the add-a-trade false pass", () => {
  it("the real run's plan and actions (one click on 'Add trade', check \"Manual\") is never a PASS", async () => {
    const from = site.hits().length;
    const brain = brainOf([OPEN, SAVE(MANUAL)], { 1: [click("link", "Trades")], 2: [click("button", "Add trade")] });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    const two = result.steps[1]!;
    assert.equal(two.verdict, "not_sure", JSON.stringify(two));
    assert.match(two.reason ?? "", /fill|save|submit/i);
    assert.equal(saves(from).length, 0, "nothing was saved");
  });

  it("filled and saved, but checked by \"Manual\" (on the form before Save): NOT SURE, never PASS", async () => {
    const brain = brainOf([OPEN, SAVE(MANUAL)], { 1: [click("link", "Trades")], 2: fillAndSave });
    const { result } = await runTest({ goal: GOAL, url: at("tjb/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    // /tjb/'s Save does nothing: the form still says "Manual", which it said before Save was pressed.
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(result.steps[1]!.verdict, "not_sure", JSON.stringify(result.steps[1]));
    assert.match(result.steps[1]!.reason ?? "", /before .*Save trade.* was pressed/);
  });

  it("really filled and saved, checked by \"Trade saved\": PASS, and the trade is saved", async () => {
    const from = site.hits().length;
    const brain = brainOf([OPEN, SAVE(SAVED)], { 1: [click("link", "Trades")], 2: fillAndSave });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 1000 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saves(from).length, 1, site.hits().slice(from).join(" "));
  });

  it("an AI that says done after only opening the wizard is told once what is left, then NOT SURE", async () => {
    const brain = brainOf([OPEN, SAVE({ kind: "url_contains", text: "import" })], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), done, done] });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.equal(result.steps[1]!.verdict, "not_sure", JSON.stringify(result.steps[1]));
    assert.ok(brain.seen.some((s) => /hasn't been done/.test(s.problem ?? "")), "the AI was told what the intent still needs");
  });

  it("a save-like button that couldn't be pressed is a FAIL that says so", () => {
    const needs = intentNeeds(SAVE(MANUAL).title, SAVE(MANUAL).intent);
    const target = { role: "button", name: "Save trade", nth: 0 };
    const short = intentShortfall(needs, [{ type: "fill", target: { role: "textbox", name: "Symbol", nth: 0 }, value: "TEST" }], [{ type: "click", target }]);
    assert.ok(short);
    assert.equal(short!.tried, true);
    assert.match(short!.why, /never pressed 'Save trade'|'Save trade' couldn't be pressed/);
  });
});

describe("intent coverage", () => {
  const T = (role: string, name: string) => ({ role, name, nth: 0 });
  it("reads what an intent needs done", () => {
    assert.deepEqual(intentNeeds("Save a manual trade", SAVE(MANUAL).intent), { fill: true, submit: true });
    assert.deepEqual(intentNeeds("Open add trade", OPEN.intent), { fill: false, submit: false });
    assert.deepEqual(intentNeeds("Open the docs", "Click Docs in the header"), { fill: false, submit: false });
    assert.deepEqual(intentNeeds("Search for AAPL", "Open the search and type AAPL"), { fill: true, submit: false });
    assert.deepEqual(intentNeeds("Enter the shop", "Enter the store from the home page"), { fill: false, submit: false });
    assert.deepEqual(intentNeeds("Create an account", "Fill in the sign-up form and press Create account"), { fill: true, submit: true });
    assert.deepEqual(intentNeeds("Add both items", "Add both items to the basket"), { fill: false, submit: false });
  });
  it("the save must come after the typing", () => {
    const needs = { fill: true, submit: true };
    const fillA = { type: "fill" as const, target: T("textbox", "Symbol"), value: "TEST" };
    const clickAdd = { type: "click" as const, target: T("button", "Add trade") };
    const clickSave = { type: "click" as const, target: T("button", "Save trade") };
    assert.ok(intentShortfall(needs, [clickAdd]));
    assert.ok(intentShortfall(needs, [clickAdd, fillA]), "typed, never saved");
    assert.equal(intentShortfall(needs, [clickAdd, fillA, clickSave]), undefined);
    assert.equal(intentShortfall(needs, [fillA, { type: "press", key: "Enter" }]), undefined, "Enter sends a form");
    assert.equal(intentShortfall({ fill: true, submit: false }, [fillA]), undefined);
  });
});

describe("the planner is told, and sent back, about a save's check", () => {
  it("says a save is checked by what shows after it", () => {
    assert.match(PLAN_SYSTEM, /saves, adds, creates or submits/);
  });
  it("a check on a word of the step's own form or option is sent back", () => {
    const out = checkGuesses([OPEN, SAVE(MANUAL)], GOAL, { text: "brief trades", addresses: "", paths: [] });
    assert.ok(out.some((s) => /step 2's check .*the step's own words/.test(s)), out.join("\n"));
    assert.equal(checkGuesses([OPEN, SAVE(SAVED)], GOAL, { text: "brief trades", addresses: "/trades", paths: [] }).filter((s) => /own words/.test(s)).length, 0);
  });
});

describe("a wait on a settled page", () => {
  it("ends in a few seconds when nothing is loading, not 30", async () => {
    const brain = brainOf([OPEN], { 1: [wait, click("link", "Trades")] });
    const t = Date.now();
    const { result } = await runTest({ goal: "Open the trades", url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
    const label = result.steps[0]!.actions[0]!.label;
    const s = Number(/Waiting (\d+(?:\.\d+)?)s/.exec(label)?.[1]);
    assert.ok(s <= 4, label);
    assert.ok(Date.now() - t < 20_000);
  });
});

describe("the goal judge", () => {
  const holds = (): JudgeAnswer => ({ reasoning: "The page says the trade was saved.", evidence: ["Trade saved"], verdict: "holds" });
  const fails = (): JudgeAnswer => ({ reasoning: "Nothing was entered or saved; the page is an import wizard.", evidence: [], verdict: "fails" });
  const unsure = (): JudgeAnswer => ({ reasoning: "Can't tell.", evidence: [], verdict: "not_sure" });

  it("a pass the judge says plainly missed the goal is NOT SURE with its reason, text only", async () => {
    const brain = brainOf([OPEN, SAVE({ kind: "url_contains", text: "import" })], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), click("link", "Manual entry")] }, fails);
    // (the intent here only opens: coverage alone wouldn't catch it)
    brain.plan = async () => [OPEN, { title: "Open the manual form", intent: "Open the manual entry form.", check: { kind: "url_contains", text: "manual" } }];
    const { result } = await runTest({ goal: "Add a trade by hand and save it", url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.equal(result.verdict, "not_sure", JSON.stringify(result, null, 1));
    assert.match(result.goalJudge?.reason ?? "", /Nothing was entered/);
    assert.equal(brain.judged.length, 1);
    assert.equal(brain.judged[0]!.image, undefined, "no picture");
    assert.ok(brain.judged[0]!.done?.length, "the judge got the step log");
    assert.equal(brain.judged[0]!.claim, goalJudgeClaim("Add a trade by hand and save it"));
  });

  it("never turns a pass into anything but NOT SURE, and a judge's not sure or holds keeps the PASS", async () => {
    for (const j of [holds, unsure]) {
      const brain = brainOf([OPEN, SAVE(SAVED)], { 1: [click("link", "Trades")], 2: fillAndSave }, j);
      const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 1000 });
      assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
      assert.equal(brain.judged.length, 1);
    }
  });

  it("is never asked when a step didn't pass, or with --measured-only", async () => {
    const brain = brainOf([OPEN, SAVE(MANUAL)], { 1: [click("link", "Trades")], 2: [click("button", "Add trade")] }, holds);
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.notEqual(result.verdict, "pass");
    assert.equal(brain.judged.length, 0);
    const b2 = brainOf([OPEN, SAVE(SAVED)], { 1: [click("link", "Trades")], 2: fillAndSave }, fails);
    const r2 = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain: b2, checkWaitMs: 1000, measuredOnly: true });
    assert.equal(r2.result.verdict, "pass");
    assert.equal(b2.judged.length, 0);
  });
});

// The review of the first fix (2026-11-18): each finding, reproduced, then held.
describe("review: intent words", () => {
  it("\"add\", \"record\" or \"log\" with values to fill in is a save (Sam's own words)", () => {
    assert.deepEqual(intentNeeds("Add a manual trade", "Choose manual entry, fill in any entry with plainly made-up test values, and click Add."), { fill: true, submit: true });
    assert.deepEqual(intentNeeds("Log a trade", "Fill in the trade form and record it"), { fill: true, submit: true });
    assert.deepEqual(intentNeeds("Post a comment", "Write a comment and post it"), { fill: true, submit: true });
    // With nothing to fill in, adding is a click like any other.
    assert.deepEqual(intentNeeds("Add both items", "Add both items to the basket"), { fill: false, submit: false });
  });
  it("a save word in a name or a description isn't one to do", () => {
    assert.equal(intentNeeds("Open deals", "Open the deals page and check the Save 20% banner").submit, false);
    assert.equal(intentNeeds("Rename the note", "Type a new title; it saves automatically").submit, false);
    assert.equal(intentNeeds("Open project", "Click Create to open the new project page").submit, false);
    assert.deepEqual(intentNeeds("Go to checkout", "Click Checkout to enter the checkout"), { fill: false, submit: false });
  });
  it("a sign-in step that does more is held to the rest of its words", () => {
    assert.equal(withoutSignIn("Sign in and add a trade. Sign in with the saved account, then fill in a trade and save it"), "add a trade. fill in a trade. save it");
    assert.deepEqual(needsOf({ title: "Sign in and add a trade", intent: "Sign in with the saved account, then fill in a trade with made-up values and save it", check: SAVED }), { fill: true, submit: true });
    assert.deepEqual(needsOf({ title: "Sign in", intent: "Enter the email and password and press Sign in", check: { kind: "signed_in" } } as PlannedStep), { fill: false, submit: false });
    assert.deepEqual(needsOf({ title: "Sign in", intent: "Enter the email and password and press Sign in", check: { kind: "url_contains", text: "/brief" } }), { fill: false, submit: false });
  });
  it("only a press named like a save, or Enter, sends (not a suggestion, a tab or 'Upload file')", () => {
    assert.equal(savePress({ type: "click", target: { role: "link", name: "Upload file" } }), false);
    assert.equal(savePress({ type: "click", target: { role: "option", name: "Add AAPL" } }), false);
    assert.equal(savePress({ type: "click", target: { role: "button", name: "Save trade" } }), true);
    assert.equal(savePress({ type: "press", key: "Meta+Enter" }), true);
    const fillA = { type: "fill" as const, target: { role: "textbox", name: "Symbol", nth: 0 }, value: "TEST" };
    assert.ok(intentShortfall({ fill: true, submit: true }, [fillA, { type: "click", target: { role: "link", name: "Upload file", nth: 0 } }]));
  });
  it("ticking boxes and choosing radios fill a form; a failed 'Continue' isn't a failed save", () => {
    const tick = { type: "check" as const, target: { role: "checkbox", name: "I agree", nth: 0 } };
    const save = { type: "click" as const, target: { role: "button", name: "Save", nth: 0 } };
    assert.equal(intentShortfall({ fill: true, submit: true }, [tick, save]), undefined);
    const short = intentShortfall({ fill: true, submit: true }, [], [{ type: "click", target: { role: "button", name: "Continue", nth: 0 } }]);
    assert.equal(short?.tried, false);
  });
  it("reads what a goal asks for", () => {
    assert.deepEqual(goalAsks(GOAL), { saves: true, changes: true });
    assert.deepEqual(goalAsks("Add both items to the basket and check the total is right"), { saves: false, changes: false });
    assert.deepEqual(goalAsks("Open Help in the embedded help panel"), { saves: false, changes: false });
    assert.deepEqual(goalAsks("change my name in settings please, any test name"), { saves: false, changes: true });
    assert.deepEqual(goalAsks("Log in and open settings"), { saves: false, changes: false });
  });
});

describe("review: false passes the first fix let through", () => {
  const ADD = (check: PlannedStep["check"]): PlannedStep => ({ title: "Add a manual trade", intent: "Choose manual entry, fill in any entry with plainly made-up test values, and click Add.", check });
  it("\"Add a manual trade\", typed one field and never saved, checked by \"Manual\": not a PASS", async () => {
    const from = site.hits().length;
    const brain = brainOf([OPEN, ADD(MANUAL)], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), click("link", "Manual entry"), fill("textbox", "Symbol", "TEST")] });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saves(from).length, 0);
  });
  it("a click on 'Upload file' after the typing isn't the save: not a PASS", async () => {
    const brain = brainOf([OPEN, SAVE({ kind: "text_visible", text: "CSV exports from most platforms work" })], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), click("link", "Manual entry"), fill("textbox", "Symbol", "TEST"), click("link", "Upload file")] });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
  });
  it("an 'OK' pressed after a save that worked doesn't make the save's check look old", async () => {
    const from = site.hits().length;
    const brain = brainOf([OPEN, SAVE({ kind: "text_visible", text: "QQOKAY" })], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), click("link", "Manual entry"), fill("textbox", "Symbol", "QQOKAY"), fill("spinbutton", "Quantity", "1"), fill("spinbutton", "Entry price", "100"), click("button", "Save trade"), click("button", "OK")] });
    const { result } = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 1000 });
    assert.equal(result.steps[1]!.verdict, "passed", JSON.stringify(result.steps[1]));
    assert.equal(saves(from).length, 1);
  });
  describe("a plan that dropped the save (only 'Open add trade')", () => {
    const run = async (judge?: () => JudgeAnswer, throws = false) => {
      const brain = brainOf([OPEN], { 1: [click("link", "Trades")] }, judge ? () => { if (throws) throw new Error("timed out"); return judge(); } : undefined);
      return (await runTest({ goal: GOAL, url: at("tjb/"), dir: dir(), browser, brain, checkWaitMs: 500 })).result;
    };
    it("is NOT SURE when the judge errs, isn't sure, or there is no judge", async () => {
      for (const r of [await run(() => ({ reasoning: "x", evidence: [], verdict: "holds" }), true), await run(() => ({ reasoning: "Can't tell.", evidence: [], verdict: "not_sure" })), await run()]) {
        assert.equal(r.verdict, "not_sure", JSON.stringify(r.steps));
        assert.match(r.steps[0]!.reason ?? "", /no step of the plan filled it in and saved it/);
      }
    });
    it("is sent back to the planner once", () => {
      assert.equal(planDropsSave([OPEN], GOAL), true);
      assert.equal(planDropsSave([OPEN, SAVE(SAVED)], GOAL), false);
      assert.ok(checkGuesses([OPEN], GOAL, { text: "brief trades", addresses: "", paths: [] }).some((s) => /no step fills it in and saves it/.test(s)));
    });
  });
  it("the goal judge isn't asked when the goal only opens something", async () => {
    const brain = brainOf([OPEN], { 1: [click("link", "Trades")] }, () => ({ reasoning: "It opened as its own page, not in the panel.", evidence: [], verdict: "fails" }));
    const { result } = await runTest({ goal: "Open the trades", url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.equal(result.verdict, "pass");
    assert.equal(brain.judged.length, 0);
  });
});

describe("review: waits", () => {
  it("a page that changed between the AI's look and its wait ends the wait at once", async () => {
    let t = 0;
    const w = await waitForChange({ signature: async () => "drawn", seen: "loading", sleep: async (ms) => void (t += ms), now: () => t });
    assert.equal(w.end, "changed");
    assert.equal(w.ms, 0);
  });
  it("a settled cut is said so, and a second wait in a step is cut later", async () => {
    let t = 0;
    const w = await waitForChange({ signature: async () => "a", quiet: async () => true, settledMs: 15_000, sleep: async (ms) => void (t += ms), now: () => t });
    assert.equal(w.end, "timeout");
    assert.ok(w.ms >= 15_000 && w.ms < 30_000, String(w.ms));
    assert.match(waitWords(w), /nothing is loading/);
  });
  it("the site's own slow request is loading however long; another site's old one isn't", async () => {
    const handlers = new Map<string, (x: unknown) => void>();
    let t = 0;
    const fake = { on: (e: string, f: (x: unknown) => void) => handlers.set(e, f), off: () => {}, evaluate: async () => "complete" };
    const req = (url: string) => ({ url: () => url });
    const own = networkWatch(fake as never, { now: () => t, own: (u) => u.startsWith("https://app.") });
    const mine = req("https://app.example/api/report");
    handlers.get("request")!(mine);
    t = 60_000;
    assert.equal(await own.quiet(), false, "the site's own request, 60 s in");
    handlers.get("requestfinished")!(mine);
    t += 5_000;
    assert.equal(await own.quiet(), true);
    handlers.get("request")!(req("https://beacon.other/v1/events"));
    t += 1_000;
    assert.equal(await own.quiet(), false, "just started");
    t += 11_000;
    assert.equal(await own.quiet(), true, "another site's beacon, 12 s in");
  });
  it("a wait on a report that takes 14 s lasts until it comes", async () => {
    const brain = brainOf([{ title: "Open the report", intent: "Wait for the report to load", check: { kind: "text_visible", text: "Report ready" } }], { 1: [wait] });
    const { result } = await runTest({ goal: "Open the report", url: at("slow-report"), dir: dir(), browser, brain, checkWaitMs: 500 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
  });
});
