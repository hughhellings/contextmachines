// W4 (any-site plan section 11): the actions a click and a fill can't do. The rules first (which
// file an upload may send, how a browser confirm box is answered, what a downloaded file holds), then
// each action driven through the whole run, with no AI, on the zoo's own pages: a scripted actor
// names elements by number as the AI would, and the server's record (never the page) says whether
// it was really done. Then each saved test replays with no AI at all.
//   node --test cli/w4-actions.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { actionProblem, runTest, type RunOptions } from "../packages/scanner/src/tester/run.ts";
import type { Action, Check, DecideInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { accepts, answerDialog, downloadHolds, Downloads, dragBy, kindFor, pdfText, readDownload, SAMPLE_WORDS, slideValue, uploadFile } from "../packages/scanner/src/tester/widgets.ts";
import { refusedName, refusedPlace } from "../packages/scanner/src/tester/act.ts";
import { actionFrom } from "./test-command.ts";
import { farOne, oldOne, sliderLabel, sliderWant, teamOf } from "./bench/zoo/pages-actions.ts";
import { startZoo, zooOracle, type ZooServer } from "./bench/zoo/server.ts";
import type { Inst, Twin } from "./bench/zoo/kit.ts";

// ---------------------------------------------------------------------------------------------
// The rules.

describe("a browser confirm box is read, and said yes to only when it asks for the step's own thing", () => {
  const ask = (message: string, step: string, pressed?: string, type = "confirm") => answerDialog(type, message, { step, goal: step, ...(pressed ? { pressed } : {}), denied: refusedName });
  it("yes: it names what the step saves", () => {
    assert.equal(ask('Save the recipe "Tart-385" to your recipes?', 'Add a recipe named "Tart-385" and save it').accept, true);
    assert.equal(ask("Log this workout of 120 kg?", "Log a workout: weight 120").accept, true);
  });
  it("yes: a bare 'Are you sure?' right after pressing a control the step names", () => {
    assert.equal(ask("Are you sure?", "Fill in the name and press Save", "Save").accept, true);
    assert.equal(ask("Are you sure?", "Fill in the name and press Save", "Archive all").accept, false);
    assert.equal(ask("Are you sure?", "Fill in the name and press Save").accept, false, "with nothing pressed, a bare box is no");
  });
  it("no: deleting, paying, sending, losing work, leaving, or anything the step doesn't do", () => {
    for (const m of ["Also delete the old recipe \"Stew-1\"? This can't be undone.", "Pay £20.00 now?", "Send this to all 400 contacts?", "Leave without saving? Your recipe will be lost.", "Discard your draft recipe?", "Reset all settings?", "Undo the last save?"]) assert.equal(ask(m, "Add a recipe named Stew and save it", "Save").accept, false, m);
    assert.equal(ask("Turn on email notifications?", "Add a recipe named Stew and save it", "Save").accept, false);
  });
  it("no: a box whose consequence is in sentences: money, many people, public, a bin, a second thing (review F4)", () => {
    const boxes: [string, string][] = [
      ["Save your plan change? Your card will be charged $49.00 today.", "Change the plan to Pro and save it"],
      ["Save and notify all 40 team members?", "Edit the project name and save it"],
      ["Save and email this newsletter to all 2,000 subscribers?", "Write a newsletter titled Hello and save it"],
      ["Save and make this recipe visible to everyone on the internet?", "Add a recipe and save it"],
      ["Also move the old recipe 'Stew-1' to the bin?", "Add a recipe named Stew-2 and save it"],
      ["Save and renew the subscription for another year ($240)?", "Edit the subscription note and save it"],
    ];
    for (const [m, g] of boxes) assert.equal(answerDialog("confirm", m, { step: g, goal: g, pressed: "Save", denied: (w) => refusedName(w) ?? refusedPlace(w) }).accept, false, m);
  });
  it("the step's own words count, never the goal's: a box about a name the goal says, but no verb the step does, is no", () => {
    assert.equal(answerDialog("confirm", "Publish Stew-2 now?", { step: "Fill in the name", goal: "Add a recipe named Stew-2, save and publish it", pressed: "Next", denied: refusedName }).accept, false);
    assert.equal(answerDialog("confirm", "Keep Stew-2 as a draft?", { step: "Press Save draft", goal: "Add a recipe named Stew-2", pressed: "Save draft", denied: refusedName }).accept, false, "keep isn't this step's verb");
    assert.equal(answerDialog("confirm", "Update the recipe Stew-2?", { step: "Change the name and update the recipe", goal: "x", pressed: "Update", denied: refusedName }).accept, true);
  });
  it("an alert, a prompt and 'leave this page?' are never said yes to", () => {
    assert.equal(ask("Saved!", "save it", "Save", "alert").accept, false);
    assert.equal(ask("Your name?", "save it", "Save", "prompt").accept, false);
    assert.equal(ask("", "save it", "Save", "beforeunload").accept, false);
  });
});

describe("an upload sends a built-in test file, or a file the person's own words name, and never a secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-w4-files-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  it("the sample kinds, and auto by what the field accepts", () => {
    for (const kind of ["csv", "json", "png", "pdf", "txt"] as const) {
      const r = uploadFile(kind, { samples: dir });
      assert.ok("path" in r && r.sample === kind);
      const body = readFileSync((r as { path: string }).path);
      if (kind === "png") assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
      else if (kind === "pdf") assert.match(pdfText(body), new RegExp(SAMPLE_WORDS));
      else assert.match(body.toString(), new RegExp(SAMPLE_WORDS));
    }
    assert.equal((uploadFile("auto", { accept: "image/*", samples: dir }) as { sample: string }).sample, "png");
    assert.equal((uploadFile("auto", { accept: ".csv,text/csv", samples: dir }) as { sample: string }).sample, "csv");
    assert.equal((uploadFile("auto", { accept: "application/pdf", samples: dir }) as { sample: string }).sample, "pdf");
    assert.equal(kindFor(""), "txt");
    assert.equal(accepts(".pdf,application/pdf", "cm-sample.pdf"), true);
    assert.equal(accepts("image/*", "cm-sample.csv"), false);
    assert.equal(accepts("", "anything.bin"), true);
  });
  it("a file of the person's: only a whole path their words give, a plain file, never where secrets live", () => {
    const mine = join(dir, "receipt.pdf");
    writeFileSync(mine, "%PDF-1.4\n%%EOF\n");
    assert.ok("path" in uploadFile(mine, { fromPerson: `attach ${mine} and save` }));
    assert.match((uploadFile(mine, { fromPerson: "attach my receipt" }) as { refused: string }).refused, /only when the goal or steps name its whole path/);
    assert.match((uploadFile("receipt.pdf", { fromPerson: "attach receipt.pdf" }) as { refused: string }).refused, /isn't a sample kind/);
    mkdirSync(join(dir, ".ssh"), { recursive: true });
    const key = join(dir, ".ssh", "id_ed25519");
    writeFileSync(key, "not a key");
    assert.match((uploadFile(key, { fromPerson: `upload ${key}` }) as { refused: string }).refused, /keys and secrets/);
    const env = join(dir, ".env.local");
    writeFileSync(env, "A=1");
    assert.match((uploadFile(env, { fromPerson: `upload ${env}` }) as { refused: string }).refused, /keys and secrets/);
    assert.match((uploadFile(dir, { fromPerson: `upload ${dir}` }) as { refused: string }).refused, /isn't a file/);
    assert.match((uploadFile(join(dir, "gone.pdf"), { fromPerson: `upload ${join(dir, "gone.pdf")}` }) as { refused: string }).refused, /no file/);
  });
  it("a project's own files under a folder named dev or etc are fine; the system's own folders and a PEM key aren't (review F6 path)", () => {
    const fixture = join(dir, "dev", "myapp", "etc", "sample.csv");
    mkdirSync(join(dir, "dev", "myapp", "etc"), { recursive: true });
    writeFileSync(fixture, "name\nA\n");
    assert.ok("path" in uploadFile(fixture, { fromPerson: `attach ${fixture}` }), JSON.stringify(uploadFile(fixture, { fromPerson: `attach ${fixture}` })));
    const deck = join(dir, "talk.key");
    writeFileSync(deck, "PK\u0003\u0004 a Keynote deck");
    assert.ok("path" in uploadFile(deck, { fromPerson: `attach ${deck}` }));
    const pem = join(dir, "server.key");
    writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
    assert.match((uploadFile(pem, { fromPerson: `attach ${pem}` }) as { refused: string }).refused, /reads as a key/);
    for (const sys of ["/etc/hosts", "/private/etc/hosts", "/dev/null"]) assert.match((uploadFile(sys, { fromPerson: `attach ${sys}` }) as { refused: string }).refused, /keys and secrets/, sys);
  });
});

describe("a downloaded file is read for its words", () => {
  it("text, CSV and JSON as they are; a PDF from its streams, compressed or not; a packed file is said so", () => {
    assert.equal(readDownload("a.csv", Buffer.from("name\nTart-1\n")).what, "a CSV file");
    assert.match(readDownload("a.csv", Buffer.from("name\nTart-1\n")).text, /Tart-1/);
    const flate = deflateSync(Buffer.from("BT /F1 12 Tf (Invoice for Test Client) Tj ET"));
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"), flate, Buffer.from("\nendstream\nendobj\n%%EOF\n")]);
    assert.match(readDownload("x.pdf", pdf).text, /Invoice for Test Client/);
    assert.match(readDownload("x.xlsx", Buffer.from("PK\u0003\u0004rest")).what, /packed/);
    assert.match(readDownload("x.bin", Buffer.from([1, 0, 2, 0])).what, /not text/);
  });
  it("download_contains holds only on a file that has the words; what was found instead is said", () => {
    const d = (name: string, text: string) => ({ name, bytes: text.length, text, what: "a CSV file", sha: "", at: 0 });
    assert.equal(downloadHolds([d("a.csv", "name\nTart-1")], "tart-1").ok, true);
    assert.match(downloadHolds([], "x").found, /no file was downloaded/);
    assert.match(downloadHolds([d("a.csv", "name\nOther")], "Tart-1").found, /a\.csv .* holds "name Other"/);
  });
  it("drag_at's pixels and slide's number are read strictly", () => {
    assert.deepEqual(dragBy("120,-40"), { x: 120, y: -40 });
    assert.equal(dragBy("0,0"), undefined);
    assert.equal(dragBy("9000,0"), undefined);
    assert.equal(dragBy("right a bit"), undefined);
    assert.equal(slideValue("40"), 40);
    assert.equal(slideValue("1,200"), 1200);
    assert.equal(slideValue("40%"), 40);
    assert.equal(slideValue("max"), undefined);
  });
});

describe("a drop place named as a state is never dropped on (review F1)", () => {
  it("Deleted, Published, Sent, Paid, Trash, Cancelled: no; Done, Review, Draft, In progress: yes", () => {
    for (const w of ["Deleted", "Published column", "Sent", "Paid", "Trash", "Cancelled", "Recycle bin", "Archived"]) assert.ok(refusedPlace(w), w);
    for (const w of ["Done", "Review", "Draft", "In progress", "To do", "Backlog", "Blocked"]) assert.equal(refusedPlace(w), undefined, w);
  });
});

describe("the new verbs are checked before they are done, and read from the AI's answer", () => {
  const snap = { refs: new Map([["e3", { ref: "e3", role: "button", name: "Choose a PDF", nth: 0 }], ["e4", { ref: "e4", role: "slider", name: "Target", nth: 0 }]]) };
  it("actionProblem", () => {
    assert.equal(actionProblem({ type: "upload", ref: "e3", value: "pdf" }, snap), undefined);
    assert.match(actionProblem({ type: "upload", ref: "e3", value: "" }, snap)!, /upload needs a value/);
    assert.match(actionProblem({ type: "slide", ref: "e9", value: "4" }, snap)!, /isn't an element/);
    assert.equal(actionProblem({ type: "drag", ref: "", text: "Card A", to: "Done" }, snap), undefined);
    assert.equal(actionProblem({ type: "drag", ref: "e3", to: "e4" }, snap), undefined);
    assert.match(actionProblem({ type: "drag", ref: "e3", to: "e77" }, snap)!, /drag needs "to"/);
    assert.match(actionProblem({ type: "switch_tab", value: "two" }, snap)!, /tab's number/);
    assert.equal(actionProblem({ type: "switch_tab", value: "2" }, snap), undefined);
    assert.equal(actionProblem({ type: "scroll_to", text: "Row 90", ref: "e4" }, snap), undefined);
  });
  it("actionFrom", () => {
    assert.deepEqual(actionFrom({ action: "drag", ref: "", text: "Card A", to: "Done" }), { type: "drag", ref: "", to: "Done", text: "Card A" });
    assert.deepEqual(actionFrom({ action: "upload", ref: "e3", value: "pdf" }), { type: "upload", ref: "e3", value: "pdf" });
    assert.deepEqual(actionFrom({ action: "scroll_to", text: "Row 90", ref: "e4" }), { type: "scroll_to", text: "Row 90", ref: "e4" });
    assert.deepEqual(actionFrom({ action: "switch_tab", value: "1" }), { type: "switch_tab", value: "1" });
  });
});

// ---------------------------------------------------------------------------------------------
// Each action through the whole run, on the zoo's pages, with a scripted actor.

/**
 * An element's number in the snapshot the actor was shown. A field or slider the seed labelled only by
 * a placeholder has no name: then the only one of its role (the zoo's forms have one).
 */
function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  if (m) return m[1]!;
  const any = role === "textbox" || role === "slider" ? new RegExp(`\\[(e\\d+)\\] ${role}\\b`).exec(snapshot) : null;
  return any ? any[1]! : "e9999";
}

/** A move: an action, or one whose ref is found in the snapshot it is shown. */
type Move = Action | ((input: DecideInput) => Action);

function scripted(plan: PlannedStep[], moves: Record<number, Move[]>): TesterBrain & { seen: DecideInput[] } {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  let waits = 0;
  const brain = {
    seen: [] as DecideInput[],
    async plan() {
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      brain.seen.push(input);
      const m = left[input.n]?.shift() ?? { type: "done" };
      const a = typeof m === "function" ? m(input) : m;
      // What it names isn't drawn yet (a form that shows after a moment): wait, and ask the same again.
      if ("ref" in a && a.ref === "e9999" && waits++ < 6) {
        left[input.n]!.unshift(m);
        return { type: "wait", ms: 700 };
      }
      return a;
    },
  };
  return brain;
}
const step = (title: string, check: Check, intent = title): PlannedStep => ({ title, intent, check });
const click = (role: string, name: string): Move => (i) => ({ type: "click", ref: refIn(i.snapshot, role, name) });
const fill = (role: string, name: string, value: string): Move => (i) => ({ type: "fill", ref: refIn(i.snapshot, role, name), value });

let browser: Browser;
let zoo: ZooServer;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-w4-"));
  dirs.push(d);
  return d;
};
before(async () => {
  browser = await launch();
  zoo = await startZoo({ filesDir: dir() });
});
after(async () => {
  await zoo?.close();
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const open = (page: string, twin: Twin, seed = 1000) => zoo.open(page, twin, seed);
const goal = (inst: Inst) => inst.page.goal({ v: inst.v, twin: inst.twin, filesDir: inst.filesDir });
const runOn = (inst: Inst, brain: TesterBrain, o: Partial<RunOptions> = {}) => runTest({ url: zoo.startUrl(inst), dir: dir(), browser, checkWaitMs: 1500, goal: goal(inst), brain, noMedia: true, ...o });

describe("each W4 action, through the run, on the zoo", { concurrency: 3 }, () => {
  it("drag: a card by its number onto a column by its words; the server has it in Done; the saved test replays", async () => {
    const inst = open("drag-board", "task");
    const v = inst.v;
    const { result, save } = await runOn(inst, scripted([step("Move the card to Done", { kind: "text_visible", text: "Moved to Done" })], { 1: [(i) => ({ type: "drag", ref: refIn(i.snapshot, "button", v.name), to: "Done column" })] }));
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => [s.reason, s.actions])));
    assert.deepEqual(zooOracle(inst).failed, []);
    assert.ok(save, "a pass is saved");
    const again = open("drag-board", "task");
    const replay = await runTest({ url: zoo.startUrl(again), dir: dir(), browser, checkWaitMs: 1500, goal: goal(again), noMedia: true, saved: { ...save!, url: zoo.startUrl(again), version: 1, savedAt: "" } });
    assert.equal(replay.result.verdict, "pass");
    assert.deepEqual(zooOracle(again).failed, [], "the replay moved it too, with no AI");
  });
  it("drag: a pointer-driven board whose cards have no number, by the card's words", async () => {
    const inst = open("drag-board", "trap");
    const { result } = await runOn(inst, scripted([step("Move the card to Done", { kind: "text_visible", text: "Moved to Done" })], { 1: [{ type: "drag", ref: "", text: inst.v.name, to: "Done" }] }));
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => [s.reason, s.actions])));
    assert.deepEqual(zooOracle(inst).failed, []);
  });
  it("drag: never onto a Trash zone (nothing deleted); the broken board doesn't keep the move", async () => {
    const inst = open("drag-board", "task");
    const { result } = await runOn(inst, scripted([step("Move the card", { kind: "text_visible", text: "Card deleted" })], { 1: [(i) => ({ type: "drag", ref: refIn(i.snapshot, "button", inst.v.name), to: "Trash" })] }));
    assert.equal(result.verdict, "blocked");
    assert.deepEqual(zooOracle(inst).forbidden, []);
    const broken = open("drag-board", "broken");
    // Its words say "Moved to Done" for a while: a fresh load shows what the server kept.
    const b = await runOn(broken, scripted([step("Move the card to Done", { kind: "none" }), step("Reload and look", { kind: "text_visible", text: "Moved to Done" })], { 1: [(i) => ({ type: "drag", ref: refIn(i.snapshot, "button", broken.v.name), to: "Done column" })], 2: [{ type: "navigate", url: zoo.startUrl(broken) }] }));
    assert.equal(zooOracle(broken).done, false);
    assert.notEqual(b.result.verdict, "pass");
  });
  it("drag_at: by pixels onto the Trash zone is refused, read under the pointer before letting go (review F2)", async () => {
    const inst = open("drag-board", "task");
    const p = await browser.newPage();
    await p.goto(zoo.startUrl(inst));
    const a = (await p.locator(`[data-card="${inst.v.name}"]`).boundingBox())!;
    const b = (await p.locator('[data-col="__trash"]').boundingBox())!;
    await p.close();
    const by = `${Math.round(b.x + b.width / 2 - (a.x + a.width / 2))},${Math.round(b.y + b.height / 2 - (a.y + a.height / 2))}`;
    const { result } = await runOn(inst, scripted([step("Move the card a little", { kind: "text_visible", text: "Card deleted" })], { 1: [(i) => ({ type: "drag_at", ref: refIn(i.snapshot, "button", inst.v.name), value: by })] }));
    assert.equal(result.verdict, "blocked", JSON.stringify(result.steps.map((s) => [s.reason, s.actions])));
    assert.deepEqual(zooOracle(inst).forbidden, []);
  });
  it("downloads: a file nothing asks for is cancelled, never kept; one waited for is read (review F6)", async () => {
    const inst = open("export-download", "task");
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const files = new Downloads(context);
      const p = await context.newPage();
      await p.goto(zoo.startUrl(inst));
      await p.click("text=Download CSV");
      await p.waitForTimeout(800);
      await files.settled();
      assert.equal(files.list.length, 0);
      assert.equal(files.refused, 1);
      files.want = () => true;
      await p.click("text=Download CSV");
      const got = await files.next(8000);
      assert.ok(got && !got.fromPage, "the server's own file, read");
    } finally {
      await context.close();
    }
  });
  it("slide: a native range and an ARIA slider in steps of 5 set to the number; the server keeps it", async () => {
    for (const twin of ["task", "trap"] as const) {
      const inst = open("slider", twin);
      const want = sliderWant(inst.v);
      const { result } = await runOn(inst, scripted([step("Set the target and save", { kind: "text_visible", text: `Saved target: ${want}` }, `Set ${sliderLabel(inst.v)} to ${want} and press Save settings`)], { 1: [(i) => ({ type: "slide", ref: refIn(i.snapshot, "slider", sliderLabel(inst.v)), value: String(want) }), click("button", "Save settings")] }));
      assert.equal(result.verdict, "pass", `${twin}: ${JSON.stringify(result.steps.map((s) => [s.reason, s.actions]))}`);
      assert.deepEqual(zooOracle(inst).failed, [], twin);
      assert.ok(result.steps[0]!.actions.some((a) => /Setting .* to/.test(a.label)));
    }
  });
  it("switch_tab: a picker window the page opens is shown, answers back to its form, closes, and the run is back on tab 1", async () => {
    const inst = open("popup-picker", "task");
    const v = inst.v;
    const brain = scripted(
      [step("Name it and open the picker", { kind: "text_visible", text: "Choose an owner" }), step("Choose the owner", { kind: "text_visible", text: `${teamOf(v)} Choose owner` }), step("Save it", { kind: "text_visible", text: v.name }, `Press ${v.labels.save}`)],
      { 1: [fill("textbox", v.labels.name, v.name), click("button", "Choose owner…")], 2: [click("button", teamOf(v))], 3: [click("button", v.labels.save)] },
    );
    const { result } = await runOn(inst, brain);
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => [s.reason, s.actions])));
    assert.deepEqual(zooOracle(inst).failed, [], "the owner chosen in the window was saved");
    const told = brain.seen.flatMap((s) => s.history).join("\n");
    assert.match(told, /opened a new window/);
    assert.match(told, /back on tab 1/);
  });
  it("switch_tab: moves between the first tab and a window still open", async () => {
    const inst = open("popup-picker", "trap");
    const v = inst.v;
    const brain = scripted(
      [step("Open the picker and look back", { kind: "text_visible", text: "Choose owner…" }, "Open the owner picker, then go back to the form")],
      { 1: [click("button", "Choose owner…"), { type: "switch_tab", value: "1" }, { type: "switch_tab", value: "3" }] },
    );
    const { result } = await runOn(inst, brain);
    const labels = result.steps[0]!.actions.map((a) => `${a.label}${a.error ? ` x ${a.error}` : ""}`).join("\n");
    assert.match(labels, /Switching to tab 1/);
    assert.match(labels, /Switching to tab 3 x there's no tab 3: the tabs are 1 to 2/);
    // Its check held from the start (the form's own button), so the run says it proves little: not a fail.
    assert.notEqual(result.verdict, "fail");
    assert.ok(v.name.length > 0);
  });
  it("scroll_to: a row far down a list that loads as it scrolls, and in a box that draws only the rows in view", async () => {
    for (const twin of ["task", "trap"] as const) {
      const inst = open("infinite-list", twin);
      const far = farOne(inst.v);
      const box = (i: DecideInput) => /\[(e\d+)\] button "Favourite /.exec(i.snapshot)?.[1];
      const { result } = await runOn(inst, scripted([step("Favourite it", { kind: "text_visible", text: "★" }, `Find ${far} and press its star`)], { 1: [(i) => ({ type: "scroll_to", text: far, ...(twin === "trap" ? { ref: box(i)! } : {}) }), click("button", `Favourite ${far}`)] }));
      assert.deepEqual(zooOracle(inst).failed, [], `${twin}: ${JSON.stringify(result.steps.map((s) => [s.reason, s.actions]))}`);
      assert.ok(result.steps[0]!.actions.some((a) => /Scrolling to/.test(a.label) && !a.error), twin);
    }
  });
  it("a last step whose check held before it, with a judge that can't confirm the goal, is never a pass (bench: infinite-list broken)", async () => {
    const inst = open("infinite-list", "broken");
    const far = farOne(inst.v);
    const brain = {
      ...scripted([step("Find the book", { kind: "text_visible", text: far }), step("Star it", { kind: "text_visible", text: far }, `Click the star next to ${far}, then see it under Favourites`)], { 1: [{ type: "scroll_to", text: far }], 2: [click("button", `Favourite ${far}`)] }),
      async judge() {
        return { reasoning: "the Favourites list shows another name", evidence: [], verdict: "not_sure" as const };
      },
    };
    const { result } = await runOn(inst, brain);
    assert.equal(zooOracle(inst).done, false);
    assert.notEqual(result.verdict, "pass", JSON.stringify([result.goalJudge, result.steps.map((s) => [s.verdict, s.weak, s.reason])]));
  });
  it("confirm: the save's own box is said yes to; a box offering to delete is refused; the run is told", async () => {
    for (const twin of ["task", "trap"] as const) {
      const inst = open("confirm-save", twin);
      const v = inst.v;
      const brain = scripted([step("Add it and save", { kind: "text_visible", text: v.name }, `Fill in the name ${v.name} and press ${v.labels.save}`)], { 1: [fill("textbox", v.labels.name, v.name), click("button", v.labels.save)] });
      const { result } = await runOn(inst, brain);
      assert.deepEqual(zooOracle(inst).failed, [], `${twin}: ${JSON.stringify(result.steps.map((s) => [s.reason, s.actions]))}`);
      assert.deepEqual(zooOracle(inst).forbidden, [], `${twin}: nothing old was deleted`);
      assert.ok(inst.records.some((r) => r.name === oldOne(v)), "the old record is still there");
      const told = [...brain.seen.flatMap((s) => s.history), ...result.friction.map((f) => f.says)].join("\n");
      assert.match(told, /which was accepted/);
      if (twin === "trap") assert.match(told, /delete the old .* which was dismissed: it reads like deleting/);
    }
  });
  it("download: the file is read, and download_contains passes only when it holds the saved name", async () => {
    for (const twin of ["task", "trap", "broken"] as const) {
      const inst = open("export-download", twin);
      const v = inst.v;
      const exporter = twin === "trap" ? `Export ${v.skin.plural}` : "Download CSV";
      const role = twin === "trap" ? "button" : "link";
      const { result } = await runOn(inst, scripted(
        [step("Add it and save", { kind: "text_visible", text: v.name }, `Fill in ${v.name} and press ${v.labels.save}`), step("Download the export", { kind: "download_contains", text: v.name })],
        { 1: [fill("textbox", v.labels.name, v.name), click("button", v.labels.save)], 2: [(i) => ({ type: "download", ref: refIn(i.snapshot, role, exporter) })] },
      ));
      if (twin === "broken") {
        assert.equal(zooOracle(inst).done, false);
        assert.notEqual(result.verdict, "pass", "the file doesn't hold the saved name");
        assert.match(result.steps[1]!.evidence?.found ?? result.steps[1]!.reason ?? "", /holds "name/);
      } else {
        assert.equal(result.verdict, "pass", `${twin}: ${JSON.stringify(result.steps.map((s) => [s.reason, s.actions]))}`);
        assert.deepEqual(zooOracle(inst).failed, [], twin);
      }
    }
  });
  it("upload: a built-in PDF through a styled button and onto a drop zone; the person's own file by its path", async () => {
    for (const twin of ["task", "trap"] as const) {
      const inst = open("upload-sample", twin);
      const v = inst.v;
      const picker = twin === "trap" ? "Drop a PDF here" : "Choose a PDF";
      const { result } = await runOn(inst, scripted([step("Attach and save", { kind: "text_visible", text: "cm-sample.pdf (" }, `Fill in ${v.name}, attach a PDF and press ${v.labels.save}`)], { 1: [fill("textbox", v.labels.name, v.name), (i) => ({ type: "upload", ref: refIn(i.snapshot, "button", picker), value: "pdf" }), click("button", v.labels.save)] }));
      assert.equal(result.verdict, "pass", `${twin}: ${JSON.stringify(result.steps.map((s) => [s.reason, s.actions]))}`);
      assert.deepEqual(zooOracle(inst).failed, [], twin);
    }
    const inst = open("upload", "task");
    const v = inst.v;
    const path = /attach the file (\S+),/.exec(goal(inst))![1]!;
    const { result } = await runOn(inst, scripted([step("Attach and save", { kind: "text_visible", text: "bytes" }, `Fill in ${v.name}, attach the file and press ${v.labels.save}`)], { 1: [fill("textbox", v.labels.name, v.name), (i) => ({ type: "upload", ref: /\[(e\d+)\] button "(?:Receipt|Choose File)/.exec(i.snapshot)?.[1] ?? "e9999", value: path }), click("button", v.labels.save)] }));
    assert.deepEqual(zooOracle(inst).failed, [], JSON.stringify(result.steps.map((s) => [s.reason, s.actions])));
  });
  it("upload: never a file the goal doesn't name, and never in a visitor's test", async () => {
    const inst = open("upload-sample", "task");
    const { result } = await runOn(inst, scripted([step("Attach", { kind: "text_visible", text: "Attached" })], { 1: [(i) => ({ type: "upload", ref: refIn(i.snapshot, "button", "Choose a PDF"), value: "/etc/hosts" }), { type: "stuck", why: "no file" }] }));
    assert.match(result.steps[0]!.actions[0]!.error ?? "", /keys and secrets|only when the goal/);
    assert.equal(inst.files.size, 0);
    const visit = open("upload-sample", "task");
    const r = await runOn(visit, scripted([step("Attach", { kind: "text_visible", text: "Attached" })], { 1: [(i) => ({ type: "upload", ref: refIn(i.snapshot, "button", "Choose a PDF"), value: "pdf" })] }), { visitor: true });
    assert.equal(r.result.verdict, "blocked");
    assert.equal(visit.files.size, 0);
  });
});
