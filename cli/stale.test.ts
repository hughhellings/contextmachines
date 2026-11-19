// A saved test recorded under older rules (before intent coverage, 2026-11-18), re-run as it was saved:
// Sam's "sign in and can we add a trade please manual trade any entry?", whose step 2 "Save a manual
// trade" has one saved action (a click on "Add trade") and the check "Manual". Replayed, it ended NOT
// SURE with nothing more tried, and the trade was never added. Now: with an AI it is planned again from
// its goal (once), the trade is really saved, the pass is saved, and the next run replays with no AI.
// With none, it says an AI is needed. /tjb/ (a Save that does nothing) still never passes.
//   node --test cli/stale.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { PLAN_RULES, readSaved, writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { judgedOutcome } from "../packages/scanner/src/tester/judge.ts";
import { cardsFromSaved, runPlan } from "../packages/scanner/src/tester/plan.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { REPLANNED, REPLANNING, runTest, staleSteps, STALE_NEEDS_AI, STALE_OWNED } from "../packages/scanner/src/tester/run.ts";
import type { Action, CachedAction, DecideInput, PlannedStep, TestEvent, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { createDataApi } from "./app/data/api.ts";
import type { Project, TestDef } from "./app/contracts.ts";
import { startFixtureSite, type FixtureSite } from "./bench/site.ts";

let browser: Browser;
let site: FixtureSite;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-stale-"));
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
const done: Move = () => ({ type: "done" });

/** A scripted AI that counts every ask: the plan given, each step's moves in order, then "done". */
function brainOf(plan: PlannedStep[], moves: Record<number, Move[]>): TesterBrain & { asks: number; plans: number } {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  const brain = {
    asks: 0,
    plans: 0,
    async plan() {
      brain.asks++;
      brain.plans++;
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      brain.asks++;
      return (left[input.n]?.shift() ?? done)(input);
    },
  };
  return brain;
}

const GOAL = "sign in and can we add a trade please manual trade any entry?";
const OPEN: PlannedStep = { title: "Open add trade", intent: "From the app's navigation, open the trades area and choose to add a new trade.", check: { kind: "url_contains", text: "trade" } };
const SAVE_WORDS = { title: "Save a manual trade", intent: "Choose the manual trade option, fill in any entry with plainly made-up test values, and press the save or add button to submit it." };
const SAVED_CHECK: PlannedStep["check"] = { kind: "text_visible", text: "Trade saved" };
const T = (role: string, name: string) => ({ role, name, nth: 0 });

/** Sam's saved test, as it is on disk: step 2's only saved action is a click on "Add trade", checked by "Manual". */
const hughs = (prefix = "tj/"): SavedTest => ({
  version: 1,
  rules: 2,
  goal: GOAL,
  url: at(prefix),
  savedAt: "2026-11-18T20:00:00.000Z",
  steps: [
    { ...OPEN, actions: [{ type: "wait", ms: 500 }, { type: "click", target: T("link", "Trades") }] },
    { ...SAVE_WORDS, check: { kind: "text_visible", text: "Manual" }, actions: [{ type: "click", target: T("button", "Add trade") }] },
  ],
});

/** Today's plan for the goal, and what the AI does: the trade is filled in and saved, checked by what the save shows. */
const symbol = (s: string) => [click("button", "Add trade"), click("link", "Manual entry"), fill("textbox", "Symbol", s), fill("spinbutton", "Quantity", "1"), fill("spinbutton", "Entry price", "100"), click("button", "Save trade")];
const freshBrain = (sym: string) => brainOf([OPEN, { ...SAVE_WORDS, check: SAVED_CHECK }], { 1: [click("link", "Trades")], 2: symbol(sym) });
const saves = (from: number, prefix = "/tj/") => site.hits().slice(from).filter((h) => h.startsWith(`${prefix}trades/save`));
const ledgerHas = async (sym: string) => (await (await fetch(at("tj/trades"))).text()).includes(`<td>${sym}</td>`);

describe("staleSteps: a saved test that can't do what it says", () => {
  it("Sam's saved step 2 (a click on 'Add trade', check \"Manual\") is stale; a step that fills and saves isn't", () => {
    const stale = staleSteps(hughs());
    assert.equal(stale.any, true);
    assert.deepEqual(stale.steps.map((s) => s.i), [1]);
    assert.match(stale.steps[0]!.why, /nothing was typed/);
    const good: SavedTest = { ...hughs(), steps: [hughs().steps[0]!, { ...SAVE_WORDS, check: SAVED_CHECK, actions: [{ type: "click", target: T("button", "Add trade") }, { type: "fill", target: T("textbox", "Symbol"), value: "X" }, { type: "click", target: T("button", "Save trade") }] }] };
    assert.equal(staleSteps(good).any, false);
  });

  it("a save checked by its own words is stale even when its actions fill and save; a person's own check never is", () => {
    const acts: CachedAction[] = [{ type: "fill", target: T("textbox", "Symbol"), value: "X" }, { type: "click", target: T("button", "Save trade") }];
    const own: SavedTest = { ...hughs(), steps: [hughs().steps[0]!, { ...SAVE_WORDS, check: { kind: "text_visible", text: "Manual" }, actions: acts }] };
    assert.match(staleSteps(own).steps[0]?.why ?? "", /own words/);
    assert.equal(staleSteps(own, { skip: [1] }).any, false, "a check the person wrote stays theirs");
    // A draft's step (nothing saved yet) is the AI's to do anyway.
    const draft: SavedTest = { ...hughs(), draft: true, steps: [hughs().steps[0]!, { ...SAVE_WORDS, check: SAVED_CHECK }] };
    assert.equal(staleSteps(draft).any, false);
  });

  it("a saved plan that never saves what its goal asks to add is stale", () => {
    const opened: SavedTest = { ...hughs(), steps: [{ ...OPEN, check: { kind: "url_contains", text: "import" }, actions: [{ type: "click", target: T("link", "Trades") }, { type: "click", target: T("button", "Add trade") }] }] };
    const stale = staleSteps(opened);
    assert.equal(stale.dropsSave, true);
    assert.equal(stale.any, true);
  });
});

describe("Sam's saved test on the /tj/ ledger", () => {
  it("before (no AI): NOT SURE, saying an AI is needed, nothing saved and nothing written", async () => {
    const from = site.hits().length;
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: hughs(), checkWaitMs: 500 });
    assert.equal(out.result.verdict, "not_sure", JSON.stringify(out.result.steps, null, 1));
    assert.equal(out.result.replanned, undefined);
    const two = out.result.steps[1]!;
    assert.equal(two.verdict, "not_sure");
    assert.match(two.reason ?? "", /nothing was typed/);
    assert.ok((two.reason ?? "").includes(STALE_NEEDS_AI), String(two.reason));
    assert.equal(saves(from).length, 0);
    assert.equal(out.save, undefined);
  });

  it("after (an AI): planned again from its goal, the trade really saved, PASS; the next run replays it with 0 AI asks", async () => {
    const from = site.hits().length;
    const brain = freshBrain("QQSTALE");
    const events: TestEvent[] = [];
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: hughs(), brain, checkWaitMs: 1000, on: (e) => events.push(e) });
    assert.equal(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.equal(brain.plans, 1, "planned again once");
    assert.ok(out.result.replanned?.startsWith(REPLANNED), String(out.result.replanned));
    assert.match(out.result.replanned ?? "", /step 2/);
    assert.ok(events.some((e) => e.type === "phase" && e.words === REPLANNING), "the live view says so");
    assert.notEqual(out.result.replay, true);
    assert.equal(saves(from).length, 1, site.hits().slice(from).join(" "));
    assert.equal(await ledgerHas("QQSTALE"), true, "the ledger lists the new trade");
    assert.ok(out.save, "the pass is saved");
    assert.equal(out.save!.planRules, PLAN_RULES, "saved as passing today's planning rules");
    const file = join(dir(), "tests", "t.json");
    writeSaved(file, out.save!);
    const again = readSaved(file);
    assert.equal(staleSteps(again).any, false, "the new saved test isn't stale");
    assert.ok(again.steps[1]!.actions!.some((a) => a.type === "fill"), JSON.stringify(again.steps[1]));
    // The second run: a plain replay, no AI asked at all (an AI is there, and isn't needed).
    const from2 = site.hits().length;
    const idle = freshBrain("NEVER");
    const second = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: again, brain: idle, checkWaitMs: 1000 });
    assert.equal(second.result.verdict, "pass", JSON.stringify(second.result.steps, null, 1));
    assert.equal(second.result.replay, true);
    assert.equal(second.result.replanned, undefined);
    assert.equal(idle.asks, 0, "0 AI asks");
    assert.equal(saves(from2).length, 1, "the replay saved a trade too");
    assert.equal(second.save, undefined, "a plain replay rewrites nothing");
  });

  it("a re-plan happens at most once: a plan that still can't save ends NOT SURE, never another plan, never a PASS", async () => {
    // The planner keeps the old weak plan (check "Manual"); the AI only opens the wizard.
    const brain = brainOf([OPEN, { ...SAVE_WORDS, check: { kind: "text_visible", text: "Manual" } }], { 1: [click("link", "Trades")], 2: [click("button", "Add trade"), done, done] });
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: hughs(), brain, checkWaitMs: 500 });
    assert.notEqual(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.ok(brain.plans <= 2, `planChecked may send a plan back once (${brain.plans})`);
    assert.equal(out.save, undefined);
  });

  it("the broken ledger /tjb/: re-planned, the AI fills and presses Save, and it never passes", async () => {
    const from = site.hits().length;
    const brain = freshBrain("QQBROKE");
    const out = await runTest({ goal: GOAL, url: at("tjb/"), dir: dir(), browser, saved: hughs("tjb/"), brain, checkWaitMs: 500 });
    assert.ok(out.result.replanned);
    assert.notEqual(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.equal(out.save, undefined);
    assert.equal(saves(from, "/tjb/").length, 0);
  });

  it("on another address (--url in a suite, noHeal): not planned again, NOT SURE, and says why", async () => {
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: hughs(), brain: freshBrain("X"), noHeal: true, checkWaitMs: 500 });
    assert.equal(out.result.verdict, "not_sure");
    assert.equal(out.result.replanned, undefined);
    assert.match(out.result.steps[1]!.reason ?? "", /another address/);
  });

  it("a saved plan that never saves (passed under older rules) replays to NOT SURE with no AI, never PASS", async () => {
    const opened: SavedTest = { ...hughs(), steps: [{ ...OPEN, check: { kind: "url_contains", text: "import" }, actions: [{ type: "click", target: T("link", "Trades") }, { type: "click", target: T("button", "Add trade") }] }] };
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: opened, checkWaitMs: 500 });
    assert.equal(out.result.verdict, "not_sure", JSON.stringify(out.result.steps, null, 1));
    assert.match(out.result.steps[0]!.reason ?? "", /an AI is needed to plan it again/);
  });
});

describe("a replayed step whose saved actions stop short is finished by the AI (the heal path)", () => {
  // Step 2 checked by what the save shows, and left out of the static check (the person's own check):
  // replayed, its one click opens the wizard; the rest of the step is handed to the AI.
  const shortSaved = (): SavedTest => ({ ...hughs(), steps: [hughs().steps[0]!, { ...hughs().steps[1]!, check: SAVED_CHECK }] });

  it("with an AI: 'healing' (unfinished), the AI fills and saves, PASS, and the saved test now does it", async () => {
    const from = site.hits().length;
    const brain = brainOf([], { 2: [click("link", "Manual entry"), fill("textbox", "Symbol", "QQHEAL"), fill("spinbutton", "Quantity", "1"), fill("spinbutton", "Entry price", "100"), click("button", "Save trade")] });
    const events: TestEvent[] = [];
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: shortSaved(), ownChecks: [1], brain, checkWaitMs: 1000, on: (e) => events.push(e) });
    assert.equal(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.equal(brain.plans, 0, "not planned again: only the step's rest was asked for");
    assert.ok(events.some((e) => e.type === "healing" && e.unfinished && e.ai && e.n === 2));
    assert.equal(out.result.steps[1]!.healed?.finished, true);
    assert.equal(saves(from).length, 1);
    assert.ok(out.save?.steps[1]!.actions!.some((a) => a.type === "fill"));
  });

  it("with no AI: NOT SURE, saying an AI is needed to finish it", async () => {
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: shortSaved(), ownChecks: [1], checkWaitMs: 500 });
    assert.equal(out.result.steps[1]!.verdict, "not_sure");
    assert.match(out.result.steps[1]!.reason ?? "", /an AI is needed to finish it/);
  });

  it("an AI that only says done is told what is left, and the step still can't pass", async () => {
    const brain = brainOf([], { 2: [done, done, done] });
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: shortSaved(), ownChecks: [1], brain, checkWaitMs: 500 });
    assert.notEqual(out.result.verdict, "pass");
  });
});

describe("the app: a saved test card run from the Tests list", () => {
  it("stale cards are planned again; on PASS the card gets the new steps (name and account kept), and the next run replays with 0 AI asks", async () => {
    const projectDir = dir();
    const api = createDataApi({ dataDir: join(dir(), "app"), defaultDir: projectDir, emit: () => {}, startRun: async () => "run_aaaaaaaaaaaa" });
    const p = (await api.dispatch("POST", "/api/projects", { url: at("tj/") })).body as unknown as { project: Project };
    // Sam's card, as the app holds it: his test's cards, with its saved clicks in its file.
    const made = (await api.dispatch("POST", `/api/projects/${p.project.id}/tests`, { name: "Add a manual trade", goal: GOAL, steps: cardsFromSaved(hughs()), account: "trader", origin: "learned" })).body as unknown as { test: TestDef };
    const test = made.test;
    const file = join(projectDir, test.file!);
    writeSaved(file, { ...hughs(), as: "trader" });
    api.tests.takeActions(test.id, { s1: hughs().steps[0]!.actions!, s2: hughs().steps[1]!.actions! });
    const previous = readSaved(file);
    const from = site.hits().length;
    const brain = freshBrain("QQAPP");
    const out = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 1000, cards: api.tests.get(test.id).test.steps, previous });
    assert.equal(out.replanned, true);
    assert.equal(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.ok(out.shown.replanned);
    assert.equal(saves(from).length, 1);
    // What wire.ts afterRun does with a passing re-plan.
    api.tests.takePlan(test.id, out.save!.steps, out.save!.planRules);
    const after = api.tests.get(test.id).test;
    assert.equal(after.name, "Add a manual trade");
    assert.equal(after.account, "trader");
    assert.deepEqual(after.steps.map((s) => s.check), [OPEN.check, SAVED_CHECK]);
    const written = readSaved(file);
    assert.equal(written.as, "trader");
    assert.equal(written.draft, undefined);
    assert.equal(staleSteps(written).any, false);
    // The next run from the card: a replay, no AI asked.
    const idle = freshBrain("NEVER");
    const next = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain: idle, checkWaitMs: 1000, cards: after.steps, previous: written });
    assert.equal(next.replanned, undefined);
    assert.equal(next.result.verdict, "pass", JSON.stringify(next.result.steps, null, 1));
    assert.equal(idle.asks, 0);
  });

  it("with no AI (a schedule), the stale card replays to NOT SURE saying an AI is needed", async () => {
    const out = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, checkWaitMs: 500, cards: cardsFromSaved(hughs()), previous: hughs() });
    assert.equal(out.replanned, undefined);
    assert.equal(out.result.verdict, "not_sure");
    assert.ok((out.shown.steps[1]!.reason ?? "").includes(STALE_NEEDS_AI), String(out.shown.steps[1]!.reason));
  });
});

// Review findings (2026-11-19): a re-plan never goes over steps the person wrote; a test saved today is
// never "recorded under older rules"; a judged save isn't passed by a row an earlier run left.
const ZZ: SavedTest["steps"][number] = { title: "My own check", intent: "Check the page shows my word", check: { kind: "text_visible", text: "ZZNEVER" }, actions: [], assert: true };
/** The AI finishing Sam's step 2 after its one saved click (the wizard is open). */
const finishBrain = (sym: string) => brainOf([OPEN, { ...SAVE_WORDS, check: SAVED_CHECK }], { 2: symbol(sym).slice(1) });

describe("a stale saved test with steps the person wrote is never planned again over them", () => {
  it("CLI: Sam's test plus his own Assert step (false on the page): not planned again, never PASS, nothing saved, and says how to fix it", async () => {
    const withAssert: SavedTest = { ...hughs(), steps: [...hughs().steps, ZZ] };
    assert.equal(staleSteps(withAssert).any, true);
    const brain = finishBrain("QQOWN");
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: withAssert, brain, checkWaitMs: 500 });
    assert.equal(brain.plans, 0, "no plan from the goal");
    assert.equal(out.result.replanned, undefined);
    assert.notEqual(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.equal(out.save, undefined, "the person's Assert step is never written away");
    const two = out.result.steps[1]!;
    assert.equal(two.verdict, "not_sure");
    assert.ok((two.reason ?? "").includes(STALE_OWNED), String(two.reason));
    assert.equal(out.result.steps.length, 3, "the Assert step is still in the run");
  });

  it("app: an Assert card and a switched-off card stop the re-plan; the cards are left as they were", async () => {
    const cards = [...cardsFromSaved(hughs()), { title: "Delete every trade", intent: "Delete every trade in the ledger", check: { kind: "text_visible" as const, text: "No trades" }, id: "s3", kind: "act" as const, checkMode: "measured" as const, enabled: false }, { title: "My own check", intent: "Check the page shows my word", check: ZZ.check, id: "s4", kind: "assert" as const, checkMode: "measured" as const, enabled: true }];
    const brain = finishBrain("QQCARD");
    const out = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500, cards, previous: { ...hughs(), steps: [...hughs().steps, ZZ] } });
    assert.equal(out.replanned, undefined);
    assert.equal(brain.plans, 0);
    assert.notEqual(out.result.verdict, "pass", JSON.stringify(out.result.steps, null, 1));
    assert.equal(out.save, undefined);
    assert.deepEqual(out.shown.steps.map((s) => s.n), [1, 2, 3, 4], "every card still shown");
    // A switched-off card alone (no Assert) stops it too: a plan from the goal might do what was switched off.
    const off = cards.slice(0, 3);
    const brain2 = finishBrain("QQOFF");
    const out2 = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain: brain2, checkWaitMs: 500, cards: off, previous: hughs() });
    assert.equal(out2.replanned, undefined);
    assert.equal(brain2.plans, 0);
    assert.notEqual(out2.result.verdict, "pass");
    assert.ok((out2.shown.steps[1]!.reason ?? "").includes(STALE_OWNED), String(out2.shown.steps[1]!.reason));
  });
});

describe("a test saved under today's rules is never planned again for being stale", () => {
  const opened = (): SavedTest => ({ ...hughs(), steps: [{ ...OPEN, check: { kind: "url_contains", text: "import" }, actions: [{ type: "click", target: T("link", "Trades") }, { type: "click", target: T("button", "Add trade") }] }] });

  it("a plan with no save step that the goal judge passed (planRules) isn't stale; one with no number is", () => {
    assert.equal(staleSteps(opened()).any, true);
    assert.equal(staleSteps({ ...opened(), planRules: PLAN_RULES }).any, false);
    assert.equal(staleSteps({ ...hughs(), planRules: PLAN_RULES }).any, false);
  });

  it("the number survives the file, and its replay asks no AI and plans nothing", async () => {
    const file = join(dir(), "t.json");
    writeSaved(file, { ...opened(), planRules: PLAN_RULES });
    const again = readSaved(file);
    assert.equal(again.planRules, PLAN_RULES);
    const idle = freshBrain("NEVER");
    const out = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved: again, brain: idle, checkWaitMs: 500 });
    assert.equal(out.result.replanned, undefined);
    assert.equal(idle.plans, 0);
    assert.equal(idle.asks, 0);
  });

  it("app cards keep the number only while they are the file's steps as they were", async () => {
    const marked = { ...hughs(), planRules: PLAN_RULES };
    const idle = freshBrain("NEVER");
    const out = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain: idle, checkWaitMs: 500, cards: cardsFromSaved(marked), previous: marked });
    assert.equal(out.replanned, undefined, "as filed: not stale");
    // A card edited since: the number no longer holds for the cards, and the stale step is planned again.
    const edited = cardsFromSaved(marked).map((c, k) => (k === 0 ? { ...c, intent: `${c.intent} `, edited: true as const } : c));
    const brain = brainOf([], { 1: [click("link", "Trades")], 2: symbol("QQEDIT").slice(1) });
    const out2 = await runPlan({ goal: GOAL, url: at("tj/"), dir: dir(), browser, brain, checkWaitMs: 500, cards: edited, previous: marked });
    assert.equal(out2.replanned, undefined, "an edited card is the person's: never planned over");
  });
});

describe("a judged check on a step that saves, passed only by what was there before", () => {
  it("judgedOutcome: quotes all on the page when the step began are NOT SURE; one new quote holds", () => {
    const before = '[e1] heading "Trades"\n[e2] row "QQOLD Long 1 100"';
    const after = '[e1] heading "Trades"\n[e3] status "Trade saved"\n[e2] row "QQOLD Long 1 100"';
    const old = judgedOutcome({ verdict: "holds", evidence: ["QQOLD Long 1 100"], reasoning: "the list shows it" }, after, false, { before });
    assert.equal(old.verdict, "not_sure");
    assert.match(old.reason, /already on the page when this step began/);
    const fresh = judgedOutcome({ verdict: "holds", evidence: ["Trade saved", "QQOLD Long 1 100"], reasoning: "saved" }, after, false, { before });
    assert.equal(fresh.verdict, "holds");
    assert.equal(judgedOutcome({ verdict: "holds", evidence: ["QQOLD Long 1 100"], reasoning: "x" }, after, false).verdict, "holds", "no `before`: as it was");
  });

  it("a replay typing the same made-up values as an earlier run: the judge quoting the old row passes nothing", async () => {
    await fetch(at("tj/trades/save?symbol=QQOLD&side=Long&quantity=1&price=100"));
    const steps: SavedTest["steps"] = [
      { ...OPEN, actions: [{ type: "click", target: T("link", "Trades") }] },
      { ...SAVE_WORDS, check: { kind: "judged", claim: "The trade is saved, or the trades list lists it" }, actions: [{ type: "click", target: T("button", "Add trade") }, { type: "click", target: T("link", "Manual entry") }, { type: "fill", target: T("textbox", "Symbol"), value: "QQOLD" }, { type: "fill", target: T("spinbutton", "Quantity"), value: "1" }, { type: "fill", target: T("spinbutton", "Entry price"), value: "100" }, { type: "click", target: T("button", "Save trade") }] },
    ];
    const saved: SavedTest = { ...hughs(), planRules: PLAN_RULES, steps };
    const judgeQuoting = (pick: (outline: string) => string[]) => ({ ...brainOf([], {}), sees: false, async judge(input: { outline: string }) { return { verdict: "holds", evidence: pick(input.outline), reasoning: "the list shows the trade" }; } });
    const rowOf = (outline: string) => /row "([^"]*QQOLD[^"]*)"/.exec(outline)?.[1] ?? outline.split("\n").find((l) => l.includes("QQOLD"))!.replace(/^\s*\[[a-z]*\d+\]\s?/i, "");
    const oldOnly = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved, brain: judgeQuoting((o) => [rowOf(o)]) as unknown as TesterBrain, checkWaitMs: 500 });
    assert.notEqual(oldOnly.result.verdict, "pass", JSON.stringify(oldOnly.result.steps, null, 1));
    assert.match(oldOnly.result.steps[1]!.reason ?? "", /already on the page when this step began/);
    // The judge quoting what the save shows ("Trade saved"): it passes, as before.
    const shown = await runTest({ goal: GOAL, url: at("tj/"), dir: dir(), browser, saved, brain: judgeQuoting((o) => ["Trade saved", rowOf(o)]) as unknown as TesterBrain, checkWaitMs: 500 });
    assert.equal(shown.result.verdict, "pass", JSON.stringify(shown.result.steps, null, 1));
  });
});

describe("app data: Tests.write and takePlan", () => {
  it("a second test with the same long goal gets its own numbered file (it used to loop for ever)", async () => {
    const projectDir = dir();
    const api = createDataApi({ dataDir: join(dir(), "app"), defaultDir: projectDir, emit: () => {}, startRun: async () => "run_aaaaaaaaaaaa" });
    const p = (await api.dispatch("POST", "/api/projects", { url: at("tj/") })).body as unknown as { project: Project };
    const one = (await api.dispatch("POST", `/api/projects/${p.project.id}/tests`, { goal: GOAL, steps: cardsFromSaved(hughs()) })).body as unknown as { test: TestDef };
    const two = (await api.dispatch("POST", `/api/projects/${p.project.id}/tests`, { goal: GOAL, steps: cardsFromSaved(hughs()) })).body as unknown as { test: TestDef };
    assert.ok(one.test.file && two.test.file);
    assert.notEqual(one.test.file, two.test.file);
    assert.match(two.test.file!, /-2\.json$/);
  });

  it("takePlan keeps the test's own account and never takes one picked for a single run", async () => {
    const projectDir = dir();
    const api = createDataApi({ dataDir: join(dir(), "app"), defaultDir: projectDir, emit: () => {}, startRun: async () => "run_aaaaaaaaaaaa" });
    const p = (await api.dispatch("POST", "/api/projects", { url: at("tj/") })).body as unknown as { project: Project };
    const made = (await api.dispatch("POST", `/api/projects/${p.project.id}/tests`, { goal: GOAL, steps: cardsFromSaved(hughs()) })).body as unknown as { test: TestDef };
    const steps = [{ ...OPEN, actions: [{ type: "click" as const, target: T("link", "Trades") }] }, { ...SAVE_WORDS, check: SAVED_CHECK, actions: [{ type: "click" as const, target: T("button", "Save trade") }] }];
    api.tests.takePlan(made.test.id, steps, PLAN_RULES);
    const after = api.tests.get(made.test.id).test;
    assert.equal(after.account, undefined);
    assert.deepEqual(after.steps.map((s) => s.title), [OPEN.title, SAVE_WORDS.title]);
    assert.equal(readSaved(join(projectDir, after.file!)).planRules, PLAN_RULES);
  });
});
