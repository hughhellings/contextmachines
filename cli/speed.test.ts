// E4 (several actions per AI turn, no "done" asked once the check holds), E7 (more verbs, each
// through the site guard and the buy/post gate) and E9 (a phone's width), on a tiny local site with
// a scripted brain: no AI and no network.
//   node --test cli/speed.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Browser } from "playwright";
import { readSaved, writeSaved } from "../packages/scanner/src/tester/cache.ts";
import { launch, PHONE } from "../packages/scanner/src/tester/record.ts";
import { actionProblem, queuedNext, runTest, type RunOptions } from "../packages/scanner/src/tester/run.ts";
import type { Action, Check, DecideInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { ACT_SYSTEM, ACTION_SCHEMA, actionFrom, actionsFrom } from "./test-command.ts";
import { startUi } from "./ui-server.ts";

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

interface Site {
  url: string;
  otherUrl: string;
  otherHits: string[];
  posted: string[];
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const site = { posted: [] as string[], otherHits: [] as string[] } as Site;
  const other: Server = createServer((req, res) => {
    site.otherHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>Partner page</h1>");
  });
  await new Promise<void>((done) => other.listen(0, done));
  site.otherUrl = `http://localhost:${(other.address() as AddressInfo).port}/`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST") site.posted.push(url.pathname);
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    const out = `<p id="o" style="position:fixed;top:0;right:0;background:#fff"></p>`;
    switch (url.pathname) {
      case "/":
        return html(page("Speed shop", `<nav><a href="/docs">Docs</a></nav><h1>Speed shop</h1>
          <form action="/results"><label>Search <input type="search" name="q"></label> <button>Go</button></form>
          <button onclick="fetch('/did-pay',{method:'POST'})">Pay now</button>`));
      case "/results":
        return html(page("Results", `<h1>Results page</h1><p>Found ${url.searchParams.get("q")?.replace(/[<>&]/g, "") ?? ""}</p>`));
      case "/docs":
        return html(page("Docs", `<h1>Docs home</h1><a href="/">Home</a> <a href="/verbs">Verbs</a>`));
      case "/verbs":
        return html(page("Verbs", `${out}<h1>Verbs</h1>
          <div role="region" aria-label="Long list" tabindex="0" style="height:90px;overflow:auto;border:1px solid" onscroll="o.textContent='Box scrolled'">${Array.from({ length: 30 }, (_, i) => `<p><a href="#r${i + 1}">Row ${i + 1}</a></p>`).join("")}</div>
          <button type="button" ondblclick="o.textContent='Double clicked'">Twice</button>
          <button type="button" oncontextmenu="event.preventDefault();o.textContent='Menu opened'">Options</button>
          <label><input type="checkbox" onchange="o.textContent=this.checked?'Archived on':'Archived off'"> Show archived</label>
          <label><input type="checkbox" onchange="fetch('/did-subscribe',{method:'POST'})"> Subscribe to newsletter</label>
          <button type="button" ondblclick="fetch('/did-delete',{method:'POST'})">Delete account</button>
          <button type="button" oncontextmenu="event.preventDefault();fetch('/did-pay',{method:'POST'})">Pay now</button>
          <a href="/docs" target="_blank">Docs in a new tab</a>
          <button type="button" onclick="window.open('${site.otherUrl}popup')">Partner</button>
          <div style="height:3000px"></div><p>Footer note</p>
          <script>addEventListener("scroll",()=>{if(scrollY>1500)o.textContent='Reached the end'})</script>`));
      case "/form":
        return html(page("Form", `<form method="post" action="/saved"><label>Name <input name="n"></label><button>Save</button></form>`));
      case "/saved":
        return html(page("Saved", `<h1>Saved it</h1><a href="/docs">Docs</a>`));
      case "/filter":
        return html(page("Filter", `<label class="t"><input type="checkbox" ${url.searchParams.get("open") ? "checked" : ""} style="opacity:0;position:absolute;width:1px;height:1px"><span style="display:inline-block;width:14px;height:14px;border:1px solid"></span> Only open</label>
          ${url.searchParams.get("open") ? "<h2>Open ones only</h2>" : ""}<script>document.querySelector("input").onchange=(e)=>{location.href=e.target.checked?"/filter?open=1":"/filter"}</script>`));
      case "/swap":
        // A form sent to its own address: the page reloads there, and the same numbers name other buttons.
        return html(page("Swap", req.method === "POST"
          ? `<p id="o"></p><form method="post" action="/swap"><button>Add</button></form><button type="button" onclick="fetch('/did-clear',{method:'POST'})">Clear</button> <button type="button" onclick="o.textContent='Kept'">Keep</button>`
          : `<p id="o"></p><form method="post" action="/swap"><button>Add</button></form><button type="button" onclick="o.textContent='Kept'">Keep</button>`));
      case "/late":
        return html(page("Late", `<button type="button" onclick="setTimeout(()=>o.textContent='Late hello',1500)">Say it late</button><p id="o"></p>`));
      case "/width":
        return html(page("Width", `<meta name="viewport" content="width=device-width"><p id="w"></p><script>w.textContent='width '+innerWidth+(matchMedia('(pointer: coarse)').matches?' touch':'')</script>`));
      default:
        return html(page("Nothing", "<p>nothing</p>"));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  site.close = async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => other.close(() => done()));
  };
  return site;
}

function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1]! : "e9999";
}

/** A move: an action, or one whose ref is the element of this role and name in the snapshot it is given. */
type Move = Action | { pick: Action["type"]; role: string; name: string; value?: string; direction?: "up" | "down" };
const resolve = (m: Move, snapshot: string): Action =>
  "pick" in m ? ({ type: m.pick, ref: refIn(snapshot, m.role, m.name), ...(m.value !== undefined ? { value: m.value } : {}), ...(m.direction ? { direction: m.direction } : {}) } as Action) : m;

interface Scripted extends TesterBrain {
  asks: number;
  seen: DecideInput[];
}

/** Each AI turn of step n gives one batch of moves (the first, then its `then`); out of turns: done. */
function batched(plan: PlannedStep[], turns: Record<number, Move[][]>): Scripted {
  const left = Object.fromEntries(Object.entries(turns).map(([n, t]) => [n, [...t]]));
  const brain: Scripted = {
    asks: 0,
    seen: [],
    async plan() {
      return plan;
    },
    async decide(input) {
      return (await brain.decideMany!(input))[0]!;
    },
    async decideMany(input) {
      brain.asks++;
      brain.seen.push(input);
      const turn = left[input.n]?.shift() ?? [{ type: "done" }];
      return turn.map((m) => resolve(m, input.snapshot));
    },
  };
  return brain;
}

const step = (title: string, check: Check): PlannedStep => ({ title, intent: title, check });

let browser: Browser;
let site: Site;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-speed-"));
  dirs.push(d);
  return d;
};
const run = (o: Partial<RunOptions> & Pick<RunOptions, "goal">) => runTest({ url: site.url, dir: dir(), browser, checkWaitMs: 600, ...o });
const at = (path: string) => new URL(path, site.url).href;

before(async () => {
  browser = await launch();
  site = await startSite();
});
beforeEach(() => {
  site.posted.length = 0;
  site.otherHits.length = 0;
});
after(async () => {
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("E4: several actions per AI turn", () => {
  it("does a batch (fill, then Enter) on one ask, and a check the batch made hold ends the step with no 'done' asked", async () => {
    const brain = batched([step("Search for shoes", { kind: "text_visible", text: "Results page" })], {
      1: [[{ pick: "fill", role: "searchbox", name: "Search", value: "shoes" }, { type: "press", key: "Enter" }]],
    });
    const { result } = await run({ goal: "search for shoes", brain });
    assert.equal(result.verdict, "pass");
    assert.equal(brain.asks, 1, "one ask for the whole step");
    assert.deepEqual(result.steps[0]!.actions.map((a) => a.label), ["Filling 'shoes' into 'Search' searchbox", "Pressing Enter"]);
    assert.equal(result.steps[0]!.weak, undefined);
  });

  it("drops the rest of a batch once the page goes elsewhere, and asks again there", async () => {
    const brain = batched([step("Open the docs home", { kind: "text_visible", text: "Docs home" }), step("Go home", { kind: "url_contains", text: "/verbs" })], {
      // e1 on the next page could be anything: never done there blind.
      1: [[{ pick: "click", role: "link", name: "Docs" }, { pick: "click", role: "button", name: "Pay now" }]],
      2: [[{ pick: "click", role: "link", name: "Verbs" }]],
    });
    const { result } = await run({ goal: "open the docs", brain });
    assert.equal(result.verdict, "pass");
    assert.equal(result.steps[0]!.actions.length, 1, "the click on the old page's Pay now was dropped");
    assert.deepEqual(site.posted, []);
  });

  it("drops the rest of a batch whose first action cannot be used, and asks again", async () => {
    const brain = batched([step("Search", { kind: "text_visible", text: "Results page" })], {
      1: [[{ type: "click", ref: "e9999" } as Action, { type: "press", key: "Enter" }], [{ pick: "fill", role: "searchbox", name: "Search", value: "hats" }, { type: "press", key: "Enter" }]],
    });
    const { result } = await run({ goal: "search", brain });
    assert.equal(result.verdict, "pass");
    // The bad ref is refused by machine (an unusable answer), so its batch is gone with it.
    assert.equal(brain.asks, 2);
    assert.ok(!result.steps[0]!.actions.some((a) => a.label === "Pressing Enter" && a.error));
  });

  it("still asks for done when the check held before the step (a pass that proves little isn't taken early)", async () => {
    const brain = batched([step("Look at the shop", { kind: "text_visible", text: "Speed shop" })], {
      1: [[{ pick: "fill", role: "searchbox", name: "Search", value: "x" }]],
    });
    const { result } = await run({ goal: "look", brain });
    assert.equal(brain.asks, 2, "the fill, then done");
    assert.equal(result.steps[0]!.verdict, "passed");
  });

  it("doesn't pass early on words the test typed itself", async () => {
    const brain = batched([step("Search shoes", { kind: "url_contains", text: "q=shoes" })], {
      1: [[{ pick: "fill", role: "searchbox", name: "Search", value: "shoes" }, { type: "press", key: "Enter" }]],
    });
    const { result } = await run({ goal: "search", brain });
    assert.equal(brain.asks, 2, "the batch, then a done the AI said");
    assert.ok(result.steps[0]!.weak);
  });

  it("a check that holds only later is still measured when the AI keeps waiting", async () => {
    const brain = batched([step("Say it", { kind: "text_visible", text: "Late hello" })], {
      1: [[{ pick: "click", role: "button", name: "Say it late" }], ...Array.from({ length: 6 }, () => [{ type: "wait", ms: 1000 } as Action])],
    });
    const { result } = await run({ goal: "say it", url: at("late"), brain });
    assert.equal(result.verdict, "pass");
    assert.ok(result.steps[0]!.actions.some((a) => /kept waiting, but the check already holds/.test(a.label)), JSON.stringify(result.steps[0]!.actions));
  });

  it("keeps the buy/post gate on every action of a batch", async () => {
    const brain = batched([step("Search then pay", { kind: "text_visible", text: "Paid" })], {
      1: [[{ pick: "fill", role: "searchbox", name: "Search", value: "shoes" }, { pick: "click", role: "button", name: "Pay now" }]],
    });
    const { result } = await run({ goal: "search and pay", brain });
    assert.equal(result.verdict, "blocked");
    assert.deepEqual(site.posted, []);
  });

  it("queuedNext: only on the page it was asked on, with nothing come up, and its element there", () => {
    const refs = new Map([["e1", { ref: "e1", role: "button", name: "Go", nth: 0 }]]);
    const snap = { url: "http://x/a", refs };
    const click: Action = { type: "click", ref: "e1" };
    assert.deepEqual(queuedNext([click], "http://x/a", snap, false), click);
    assert.equal(queuedNext([click], "http://x/b", snap, false), undefined, "the page went elsewhere");
    assert.deepEqual(queuedNext([{ type: "done" }], "http://x/b", snap, false), { type: "done" }, "done is measured wherever it is");
    assert.equal(queuedNext([click], "http://x/a", snap, true), undefined, "a problem or the wind-down");
    assert.equal(queuedNext([{ type: "click", ref: "e2" }], "http://x/a", snap, false), undefined, "its element is gone");
    assert.equal(queuedNext([{ type: "stuck", why: "x" }], "http://x/a", snap, false), undefined, "stuck is asked, never queued");
    assert.equal(queuedNext([], "http://x/a", snap, false), undefined);
    // Review: a number that now names another element (a reload at the same address) is not used blind.
    const asked = new Map([["e1", { ref: "e1", role: "button", name: "Keep", nth: 0 }]]);
    assert.equal(queuedNext([click], "http://x/a", snap, false, { refs: asked }), undefined, "e1 was Keep when asked, is Go now");
    assert.deepEqual(queuedNext([click], "http://x/a", snap, false, { refs }), click);
    // Review: a "done" said before seeing the page is taken only when the browser measures the check.
    assert.equal(queuedNext([{ type: "done" }], "http://x/a", snap, false, { measured: false }), undefined, "check none: the AI is asked");
    assert.deepEqual(queuedNext([{ type: "done" }], "http://x/a", snap, false, { measured: true }), { type: "done" });
  });

  it("a queued number is not used after the page reloads at the same address and it names another element", async () => {
    const brain = batched([step("Press the two buttons", { kind: "text_visible", text: "Kept" })], {
      1: [[{ pick: "click", role: "button", name: "Add" }, { pick: "click", role: "button", name: "Keep" }], [{ pick: "click", role: "button", name: "Keep" }]],
    });
    const { result } = await run({ goal: "press the two buttons until the page says Kept", url: at("swap"), brain });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => [s.verdict, s.reason])));
    assert.ok(!site.posted.includes("/did-clear"), `the old number for Keep was not clicked on the new page: ${JSON.stringify(result.steps[0]!.actions.map((a) => a.label))}`);
    assert.equal(brain.asks, 2);
  });

  it("a queued done on a step with no check is not taken: the AI is asked once it has seen the page", async () => {
    const brain = batched([step("Open the docs", { kind: "none" }), step("See the docs", { kind: "text_visible", text: "Docs home" })], {
      1: [[{ pick: "click", role: "link", name: "Docs" }, { type: "done" }]],
    });
    await run({ goal: "open the docs", brain });
    assert.equal(brain.seen.filter((x) => x.n === 1).length, 2, "the done was asked for after the click, not taken from the batch");
  });

  it("the AI's answer: then holds up to 3 more actions, each read like the first", () => {
    const base = { ref: "", value: "", key: "", direction: "", url: "", ms: 0, why: "", text: "" };
    const got = actionsFrom({ ...base, action: "click", ref: "e3", then: [{ ...base, action: "type", value: "AAPL" }, { ...base, action: "press", key: "Enter" }, { ...base, action: "done" }, { ...base, action: "back" }] });
    assert.deepEqual(got, [{ type: "click", ref: "e3" }, { type: "type", value: "AAPL" }, { type: "press", key: "Enter" }, { type: "done" }]);
    assert.deepEqual(actionsFrom({ ...base, action: "done" }), [{ type: "done" }]);
    assert.ok((ACTION_SCHEMA.required as string[]).includes("then"));
    assert.match(ACT_SYSTEM, /then: up to 3 more actions/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("E7: more verbs, through the site guard and the buy/post gate", () => {
  const verbs = (moves: Move[], check: Check, url = at("verbs")) => {
    const brain = batched([step("Do it", check)], { 1: moves.map((m) => [m]) });
    return run({ goal: "use the page", url, brain }).then((o) => ({ ...o, brain }));
  };

  it("the AI's answer is read for each new verb", () => {
    const base = { ref: "e4", value: "", key: "", direction: "down", url: "", ms: 0, why: "", text: "Footer note" };
    assert.deepEqual(actionFrom({ ...base, action: "back" }), { type: "back" });
    assert.deepEqual(actionFrom({ ...base, action: "dblclick" }), { type: "dblclick", ref: "e4" });
    assert.deepEqual(actionFrom({ ...base, action: "rightclick" }), { type: "rightclick", ref: "e4" });
    assert.deepEqual(actionFrom({ ...base, action: "check" }), { type: "check", ref: "e4" });
    assert.deepEqual(actionFrom({ ...base, action: "uncheck" }), { type: "uncheck", ref: "e4" });
    // W4: scroll_to may name the list to scroll in (its ref).
    assert.deepEqual(actionFrom({ ...base, action: "scroll_to" }), { type: "scroll_to", text: "Footer note", ref: "e4" });
    assert.deepEqual(actionFrom({ ...base, ref: "", action: "scroll_to" }), { type: "scroll_to", text: "Footer note" });
    assert.deepEqual(actionFrom({ ...base, action: "scroll" }), { type: "scroll", direction: "down", ref: "e4" });
    assert.deepEqual(actionFrom({ ...base, ref: "", action: "scroll" }), { type: "scroll", direction: "down" });
    const refs = new Map([["e4", { ref: "e4", role: "button", name: "x", nth: 0 }]]);
    assert.equal(actionProblem({ type: "dblclick", ref: "e5" }, { refs }), `"e5" isn't an element on the page now: use a number from the latest snapshot, like e12`);
    assert.equal(actionProblem({ type: "scroll_to", text: " " }, { refs }), "scroll_to needs text: words the page shows");
    assert.equal(actionProblem({ type: "scroll", direction: "down", ref: "e5" }, { refs }), `"e5" isn't an element on the page now: use a number from the latest snapshot, like e12`);
    assert.equal(actionProblem({ type: "scroll", direction: "down" }, { refs }), undefined);
  });

  it("double-click", async () => {
    const { result } = await verbs([{ pick: "dblclick", role: "button", name: "Twice" }], { kind: "text_visible", text: "Double clicked" });
    assert.equal(result.verdict, "pass");
    assert.equal(result.steps[0]!.actions[0]!.label, "Double-clicking on 'Twice' button");
  });

  it("right-click opens a site's own menu", async () => {
    const { result } = await verbs([{ pick: "rightclick", role: "button", name: "Options" }], { kind: "text_visible", text: "Menu opened" });
    assert.equal(result.verdict, "pass");
  });

  it("check and uncheck; check again does nothing, and is said as done", async () => {
    const on = await verbs([{ pick: "check", role: "checkbox", name: "Show archived" }], { kind: "text_visible", text: "Archived on" });
    assert.equal(on.result.verdict, "pass");
    const off = await verbs([{ pick: "check", role: "checkbox", name: "Show archived" }, { pick: "uncheck", role: "checkbox", name: "Show archived" }], { kind: "text_visible", text: "Archived off" });
    assert.equal(off.result.verdict, "pass");
    const notBox = await verbs([{ pick: "check", role: "button", name: "Twice" }, { type: "stuck", why: "x" }], { kind: "text_visible", text: "never" });
    assert.match(notBox.result.steps[0]!.actions[0]!.error ?? "", /isn't a checkbox/);
  });

  it("check on a hidden styled box whose change reloads the page: done, saved, and replayed", async () => {
    const d = dir();
    const brain = batched([step("Only open", { kind: "text_visible", text: "Open ones only" })], { 1: [[{ pick: "check", role: "checkbox", name: "Only open" }]] });
    const first = await runTest({ goal: "only open", url: at("filter"), dir: d, browser, brain, checkWaitMs: 600 });
    assert.equal(first.result.verdict, "pass", JSON.stringify(first.result.steps[0]));
    assert.equal(first.result.steps[0]!.actions[0]!.error, undefined);
    assert.equal(brain.asks, 1);
    const again = await runTest({ goal: "only open", url: at("filter"), dir: dir(), browser, saved: { ...first.save!, version: 1, savedAt: "" }, checkWaitMs: 600 });
    assert.equal(again.result.verdict, "pass");
  });

  it("scroll in a box scrolls that box, not the page", async () => {
    const { result } = await verbs([{ pick: "scroll", role: "link", name: "Row 1", direction: "down" }], { kind: "text_visible", text: "Box scrolled" });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    assert.equal(result.steps[0]!.actions[0]!.label, "Scrolling down in 'Row 1' link");
  });

  it("scroll_to brings words of the page into view, pressing nothing", async () => {
    const { result } = await verbs([{ type: "scroll_to", text: "Footer note" }], { kind: "text_visible", text: "Reached the end" });
    assert.equal(result.verdict, "pass");
    const none = await verbs([{ type: "scroll_to", text: "No such words" }, { type: "stuck", why: "x" }], { kind: "text_visible", text: "never" });
    // W4: it scrolls to the end (loading more) before it says the words aren't there.
    assert.match(none.result.steps[0]!.actions[0]!.error ?? "", /didn't find 'No such words'/, JSON.stringify(none.result.steps[0]!.actions));
  });

  it("back goes to the page before; on the first page there is none", async () => {
    const brain = batched([step("Open docs", { kind: "url_contains", text: "/docs" }), step("Go back", { kind: "text_visible", text: "Speed shop" })], {
      1: [[{ pick: "click", role: "link", name: "Docs" }]],
      2: [[{ type: "back" }]],
    });
    const { result } = await run({ goal: "docs and back", brain });
    assert.equal(result.verdict, "pass");
    assert.equal(result.steps[1]!.actions[0]!.label, "Going back");
    const first = await verbs([{ type: "back" }, { type: "stuck", why: "x" }], { kind: "text_visible", text: "never" });
    assert.match(first.result.steps[0]!.actions[0]!.error ?? "", /didn't go back/);
    assert.match(first.result.endUrl ?? "", /\/verbs$/);
  });

  it("back never sends a form again", async () => {
    const brain = batched([step("Save", { kind: "text_visible", text: "Saved it" }), step("Open docs", { kind: "text_visible", text: "Docs home" }), step("Go back", { kind: "text_visible", text: "never" })], {
      1: [[{ pick: "fill", role: "textbox", name: "Name", value: "Test" }, { pick: "click", role: "button", name: "Save" }]],
      2: [[{ pick: "click", role: "link", name: "Docs" }]],
      3: [[{ type: "back" }]],
    });
    const { result } = await run({ goal: "save, docs, back", url: at("form"), brain });
    assert.deepEqual(result.steps.map((s) => s.verdict), ["passed", "passed", "blocked"]);
    assert.match(result.steps[2]!.reason ?? "", /send the form again/);
    assert.deepEqual(site.posted, ["/saved"]);
  });

  it("a new tab of this site is followed in the test's tab; one to another site is closed before it loads", async () => {
    const same = await verbs([{ pick: "click", role: "link", name: "Docs in a new tab" }], { kind: "text_visible", text: "Docs home" });
    assert.equal(same.result.verdict, "pass");
    const off = await verbs([{ pick: "click", role: "button", name: "Partner" }, { type: "done" }], { kind: "text_visible", text: "Partner page" });
    assert.notEqual(off.result.verdict, "pass");
    assert.deepEqual(site.otherHits, []);
  });

  it("the buy/post gate: a double-click on Delete, a right-click on Pay, a check of Subscribe are each refused", async () => {
    for (const [move, why] of [
      [{ pick: "dblclick", role: "button", name: "Delete account" }, /delet/i],
      [{ pick: "rightclick", role: "button", name: "Pay now" }, /pay/i],
      [{ pick: "check", role: "checkbox", name: "Subscribe to newsletter" }, /subscri/i],
    ] as const) {
      const { result } = await verbs([move as Move], { kind: "text_visible", text: "never" });
      assert.equal(result.verdict, "blocked", JSON.stringify(move));
      assert.match(result.steps[0]!.reason ?? "", why);
    }
    assert.deepEqual(site.posted, []);
  });

  it("a saved test with the new verbs replays them with no AI", async () => {
    const d = dir();
    const brain = batched([step("Do it", { kind: "text_visible", text: "Double clicked" })], { 1: [[{ type: "scroll_to", text: "Footer note" }, { pick: "dblclick", role: "button", name: "Twice" }]] });
    const first = await runTest({ goal: "verbs", url: at("verbs"), dir: d, browser, brain, checkWaitMs: 600 });
    assert.equal(first.result.verdict, "pass");
    assert.ok(first.save);
    const file = join(d, "saved.json");
    writeSaved(file, first.save!);
    const saved = readSaved(file);
    assert.deepEqual(saved.steps[0]!.actions!.map((a) => a.type), ["scroll_to", "dblclick"]);
    const again = await runTest({ goal: "verbs", url: at("verbs"), dir: dir(), browser, saved, checkWaitMs: 600 });
    assert.equal(again.result.verdict, "pass");
    assert.equal(again.result.replay, true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("E9: a phone's width", () => {
  it("lays the page out at 390 px with touch, and records the video at that size", async () => {
    const d = dir();
    const brain = batched([step("See the width", { kind: "text_visible", text: "width 390 touch" })], {});
    const { result } = await runTest({ goal: "width", url: at("width"), dir: d, browser, brain, checkWaitMs: 600, viewport: PHONE });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    assert.ok(result.video && existsSync(join(d, result.video)));
    // A WebM's first frame says its size: 390 × 844 (EBML PixelWidth 0xB0 / PixelHeight 0xBA).
    const { readFileSync } = await import("node:fs");
    const head = readFileSync(join(d, result.video!)).subarray(0, 400);
    const size = (id: number) => {
      const i = head.indexOf(Buffer.from([id, 0x82]));
      return i >= 0 ? head.readUInt16BE(i + 2) : -1;
    };
    assert.deepEqual([size(0xb0), size(0xba)], [PHONE.width, PHONE.height]);
  });

  it("the web view reads at a phone's width (no sideways scroll), and a portrait live screen gets the phone frame", async () => {
    const d = dir();
    const ui = await startUi({ outDir: join(d, "cm"), testsDir: join(d, "cm", "tests"), ai: undefined, vars: {}, mask: (s) => s, allowHosts: [], headed: false, maxActions: 25, port: 0 });
    const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    try {
      const p = await context.newPage();
      // The app took / (ui lane); the classic page, with its #live screen, is at /classic. Both read at 390 px.
      await p.goto(ui.url);
      await p.waitForLoadState("domcontentloaded");
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll at 390 px (the app)");
      await p.goto(ui.url.replace("/?t=", "/classic?t="));
      await p.waitForLoadState("domcontentloaded");
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll at 390 px (classic)");
      // A frame as the live screen sends it for a run at PHONE: portrait.
      const shot = await (await browser.newPage({ viewport: PHONE })).screenshot({ type: "jpeg" });
      await p.evaluate((src) => new Promise<void>((done) => {
        const img = document.getElementById("live") as HTMLImageElement;
        img.addEventListener("load", () => done(), { once: true });
        img.src = src;
      }), `data:image/jpeg;base64,${shot.toString("base64")}`);
      assert.equal(await p.evaluate(() => document.querySelector(".window")?.classList.contains("phone")), true);
    } finally {
      await context.close();
      await ui.close();
    }
  });

  it("runs a whole batched test at phone width", async () => {
    const brain = batched([step("Search for shoes", { kind: "text_visible", text: "Results page" })], {
      1: [[{ pick: "fill", role: "searchbox", name: "Search", value: "shoes" }, { type: "press", key: "Enter" }]],
    });
    const { result } = await run({ goal: "search", brain, viewport: PHONE });
    assert.equal(result.verdict, "pass");
    assert.equal(brain.asks, 1);
  });
});
