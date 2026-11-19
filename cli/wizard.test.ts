// Adding one manual trade through a copy of a real signed-in ledger's import wizard (bench/si-site.ts),
// with a scripted AI: a platform tile and a "Manual entry" card that move on by themselves, a symbol
// combobox whose whole form is redrawn on every key, a fill table, review, "Save trade". The ledger's
// own record (its log line <prefix>ledger/saved?…) is the right answer. Also the engine pieces the
// real AI's runs on it needed: a planner step that only opens "Add trades", a wizard's pages giving a
// step its turns back, an amount typed as text, and a date box's value said plainly.
//   node --test cli/wizard.test.ts
import { FILL_HELD } from "../packages/scanner/src/tester/fill.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { planProblem, runTest, withoutControlNames } from "../packages/scanner/src/tester/run.ts";
import { explainError } from "../packages/scanner/src/tester/act.ts";
import { madeUpValue, type FieldFacts } from "../packages/scanner/src/tester/values.ts";
import type { Action, DecideInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { startFixtureSite, type FixtureSite } from "./bench/site.ts";
import { ACT_SYSTEM, PLAN_SYSTEM } from "./test-command.ts";

let browser: Browser;
let site: FixtureSite;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-wizard-"));
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
  if (!m) throw new Error(`no ${role} ${name} in the snapshot:\n${snapshot.slice(0, 4000)}`);
  return m[1]!;
}
const click = (role: string, name: string): Move => (i) => ({ type: "click", ref: refOf(i.snapshot, role, name) });
const fill = (role: string, name: string, value: string): Move => (i) => ({ type: "fill", ref: refOf(i.snapshot, role, name), value });
const done: Move = () => ({ type: "done" });

function brainOf(plan: PlannedStep[], moves: Record<number, Move[]>): TesterBrain {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  let last: Move | undefined;
  return {
    async plan() {
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      // Told a save was held for empty fields (fill.ts): this actor presses it again, as it is.
      if (last && FILL_HELD.test(input.problem ?? "")) return last(input);
      last = left[input.n]?.shift() ?? done;
      return last(input);
    },
  };
}

const GOAL = "add a trade please manual trade any entry";
const ONE: PlannedStep = { title: "Add a manual trade", intent: "Open Add trades, choose MetaTrader 5 and manual entry, fill in the trade with test values, then continue and press Save trade.", check: { kind: "text_visible", text: "ABCXYZ saved" } };
/** The whole way, in one step: three presses that each lead to a new page, four fields, Continue, Save. */
const wholeWay: Move[] = [
  click("button", "Add trades"),
  click("button", "MetaTrader 5"),
  click("button", "Manual entry"),
  fill("combobox", "Symbol", "ABCXYZ"),
  fill("textbox", "dateTime for fill 1", "2026-11-18T09:00"),
  fill("textbox", "size for fill 1", "0.1"),
  fill("textbox", "price for fill 1", "1.0850"),
  click("button", "Continue"),
  click("button", "Save trade"),
];
const saved = (prefix: string, from: number) => site.hits().slice(from).filter((h) => h.startsWith(`${prefix}ledger/saved?`));

describe("the add-trade wizard (si-site.ts)", () => {
  it("filled and saved through the wizard: PASS, and the ledger recorded it", async () => {
    const from = site.hits().length;
    const { result } = await runTest({ goal: GOAL, url: at("si/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: wholeWay }), checkWaitMs: 1500 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    const lines = saved("/si/", from);
    assert.equal(lines.length, 1, site.hits().slice(from).join(" "));
    assert.match(lines[0]!, /symbol=ABCXYZ&side=BUY/);
    // Typed into the combobox although the form was redrawn on each key: no "gone from the page" error.
    assert.ok(result.steps[0]!.actions.every((a) => !a.error), JSON.stringify(result.steps[0]!.actions));
  });

  it("the same where \"Save trade\" does nothing: never a PASS, nothing recorded", async () => {
    const from = site.hits().length;
    const { result } = await runTest({ goal: GOAL, url: at("sib/brief"), dir: dir(), browser, brain: brainOf([{ ...ONE, check: { kind: "text_visible", text: "ABCXYZ saved" } }], { 1: wholeWay }), checkWaitMs: 800 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saved("/sib/", from).length, 0);
  });

  it("a verified account picked first: the save is refused, never a PASS, nothing recorded", async () => {
    const from = site.hits().length;
    const { result } = await runTest({ goal: GOAL, url: at("sil/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: wholeWay }), checkWaitMs: 1500 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saved("/sil/", from).length, 0);
    // It got as far as pressing "Save trade": the ledger was asked, and said no.
    assert.ok(site.hits().slice(from).includes("/sil/api/trades"), site.hits().slice(from).join(" "));
  });

  it("what the refusal says stays in the actor's history, after it goes back a page", async () => {
    let seen: readonly string[] = [];
    const look: Move = (i) => ((seen = i.history), { type: "stuck", why: "looked" } as Action);
    await runTest({ goal: GOAL, url: at("sil/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: [...wholeWay, click("button", "Back"), look] }), checkWaitMs: 300 });
    const said = seen.find((h) => h.startsWith("Clicking on 'Save trade'")) ?? "";
    assert.match(said, /the page says "Nothing was saved\. This account is verified/, seen.join("\n"));
  });

  it("the same, with the ledger account chosen in \"Account\": PASS, recorded once", async () => {
    const from = site.hits().length;
    const pick: Move = (i) => ({ type: "select", ref: refOf(i.snapshot, "combobox", "Account"), value: "Manual ledger · Main" });
    const way = [...wholeWay.slice(0, 3), pick, ...wholeWay.slice(3)];
    const { result } = await runTest({ goal: GOAL, url: at("sil/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: way }), checkWaitMs: 1500 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saved("/sil/", from).length, 1);
  });

  it("one press on \"Add trades\", checked by the subtitle's \"Manual\": never a PASS", async () => {
    const step: PlannedStep = { ...ONE, check: { kind: "text_visible", text: "Manual" } };
    const { result } = await runTest({ goal: GOAL, url: at("si/brief"), dir: dir(), browser, brain: brainOf([step], { 1: [click("button", "Add trades")] }), checkWaitMs: 500 });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
  });

  it("each new page a press leads to gives the step its turn back (a wizard fits a small budget)", async () => {
    const from = site.hits().length;
    // 9 actions, 4 of them new fields: 5 left, over a budget of 4 unless the 5 new pages count.
    const { result } = await runTest({ goal: GOAL, url: at("si/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: wholeWay }), checkWaitMs: 1500, maxPerStep: 4 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(saved("/si/", from).length, 1);
  });

  it("going round the same pages gives nothing back: the budget still ends a loop", async () => {
    const back: Move[] = Array.from({ length: 12 }, (_, i) => (i % 2 ? click("link", "Trades") : click("link", "Brief")));
    const { result } = await runTest({ goal: GOAL, url: at("si/brief"), dir: dir(), browser, brain: brainOf([ONE], { 1: back }), checkWaitMs: 300, maxPerStep: 4 });
    assert.notEqual(result.verdict, "pass");
    assert.ok(result.steps[0]!.actions.length <= 6, `${result.steps[0]!.actions.length} actions`);
  });
});

describe("the planner's rules around a wizard", () => {
  const none = { kind: "none" } as const;
  const judged = { kind: "judged", claim: "The page confirms the new trade was saved." } as const;
  it("a step that only opens \"Add trades\" may have no check; one that saves still needs one", () => {
    const open: PlannedStep = { title: "Open manual trade entry", intent: 'Click the "Add trades" button and choose the manual entry option in the wizard that opens.', check: none };
    const save: PlannedStep = { title: "Fill and save trade", intent: "Fill in the manual trade form with made-up test values and press its save button.", check: judged };
    assert.equal(planProblem([open, save], GOAL), undefined);
    assert.equal(planProblem([{ ...open, title: "Open Add trades", intent: "Click the Add trades button in the rail." }, save], GOAL), undefined);
    assert.match(planProblem([{ ...save, check: none }, { ...save, check: { kind: "text_visible", text: "saved" } }], GOAL) ?? "", /fills in or submits/);
    assert.match(planProblem([{ title: "Save it", intent: "Click the Save button", check: none }, { ...save, check: { kind: "text_visible", text: "saved" } }], GOAL) ?? "", /fills in or submits/);
    assert.match(planProblem([open, { ...open, title: "Choose manual" }, save], GOAL) ?? "", /step 1 has no check, so step 2 must have one/);
    // A real "add" behind a button name is still refused with no check.
    const vacuous: PlannedStep = { title: "Look", intent: "See the basket", check: { kind: "text_visible", text: "Basket" } };
    for (const intent of ['Click the "Add to cart" button', "Click the Add to cart button", 'Press the "Add member" button for bob', "Use the add item form", 'Click "Type your name", then the Next button']) {
      assert.match(planProblem([{ title: "Do it", intent, check: none }, vacuous], "add the mug to my basket") ?? "", /fills in or submits/, intent);
    }
  });
  it("control names are left out, unless they send", () => {
    assert.doesNotMatch(withoutControlNames('Open Add trades: click the "Add trades" button'), /Add trades/);
    assert.doesNotMatch(withoutControlNames('Click the "Add trades" button in the main navigation and choose the manual entry option to open the trade form.'), /\badd\b/i);
    // Without an "open", an "Add …" name is what the step does; names that add or fill are always kept.
    assert.match(withoutControlNames('Click the "Add trades" button'), /Add trades/);
    assert.match(withoutControlNames('Open the shop and click the "Add to basket" button'), /Add to basket/);
    assert.match(withoutControlNames('Open the team page and press the Add member button'), /Add member/);
    assert.match(withoutControlNames('Click "Fill in" on the open form'), /Fill in/);
    assert.match(withoutControlNames('Press the "Save trade" button'), /Save trade/);
    assert.match(withoutControlNames("Fill in the form and click the Add button"), /Fill in/);
  });
  it("the planner is told never to plan two moving-only steps in a row", () => {
    assert.match(PLAN_SYSTEM, /Never two none steps in a row/);
  });
  it("the actor is told to put right what the page says is wrong, never a payment, sign-in or bot check", () => {
    assert.match(ACT_SYSTEM, /put it right with the form's own controls/);
    assert.match(ACT_SYSTEM, /Never to get past a payment, a sign-in, a paywall or a bot check/);
  });
});

describe("values and errors on a trade form", () => {
  const facts = (over: Partial<FieldFacts>): FieldFacts => ({ tag: "input", type: "text", hint: "", label: "", placeholder: "", autocomplete: "", inputMode: "", required: false, value: "", pattern: "", min: "", max: "", step: "", minLength: -1, maxLength: -1, ...over });
  it("an amount typed as text gets a number, a name still gets words", () => {
    assert.deepEqual(madeUpValue(facts({ hint: "fl-size-0 size for fill 1", label: "size for fill 1" })), { value: "1" });
    assert.deepEqual(madeUpValue(facts({ hint: "fl-price-0 price for fill 1" })), { value: "1" });
    assert.deepEqual(madeUpValue(facts({ hint: "product name" })), { value: "Test Client" });
  });
  it("a date box given a value in another shape is told how it is written, not that it is hidden", async () => {
    const said = await explainError("locator.fill: Error: Malformed value\nCall log:\n  - waiting for element to be visible, enabled and editable", { verb: "fill it" });
    assert.match(said.error, /2026-11-18T09:00/);
    assert.doesNotMatch(said.error, /isn't visible/);
  });
});
