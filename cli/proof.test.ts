// W3 proof (packages/scanner/src/tester/proof.ts): the expected value fixed before the press, then a
// fresh navigation must show it kept. The proof traps of plan section 7 must stay red: a save that
// silently fails next to a look-alike row, a draft restored from local storage, an optimistic row
// that rolls back after a 4xx, a 200 whose body says it failed. A delete counts only at exactly -1.
// Also the run's rule: the AI judge alone never passes a create, edit or delete.
//   node --test cli/proof.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import { hasMarker, makeMarker, markerIn, markNumber, markValue } from "../packages/scanner/src/tester/marker.ts";
import { baselines, countIn, errorShape, fold, judgeProof, proofPlan, proveWrite, quotedIn, readPlain, requestsSay, safeToReopen, strongValue, urlKey, WriteWatch, type ProofAct, type Reading } from "../packages/scanner/src/tester/proof.ts";
import type { Action, DecideInput, JudgeAnswer, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";

// ---------------------------------------------------------------------------------------------
// Pure parts

describe("proof: values and counting", () => {
  it("counts a value only as words of its own, any case and spacing", () => {
    assert.equal(countIn(fold("Test 7Q2K\nTestville  test 7q2k"), "Test 7Q2K"), 2);
    assert.equal(countIn(fold("Testville"), "Test"), 0);
    assert.equal(countIn(fold("Lunges, lunges; LUNGES"), "lunges"), 3);
    assert.equal(countIn(fold("“Morning run”"), '"Morning run"'), 1);
  });
  it("a strong value has letters and 3+ characters; numbers, dates, placeholders and addresses aren't", () => {
    assert.equal(strongValue("Lunges"), true);
    assert.equal(strongValue("37"), false);
    assert.equal(strongValue("2026-11-19"), false);
    assert.equal(strongValue("2026-11-18T09:00"), false);
    assert.equal(strongValue("{password}"), false);
    assert.equal(strongValue("https://example.com"), false);
    assert.equal(strongValue("ab"), false);
  });
  it("reads the goal's quoted words, straight or curly", () => {
    assert.deepEqual(quotedIn(`Add a contact named "Ada Lovelace" with notes “met at expo”, and rename it to 'Ada L'`), ["Ada Lovelace", "met at expo", "Ada L"]);
    assert.deepEqual(quotedIn("Add a trade please, any entry"), []);
  });
  it("an address that acts, or carries a typed value in its query, is never opened again", () => {
    const on = (u: string) => u.startsWith("http://site.test/");
    assert.equal(safeToReopen("http://site.test/notes", on), true);
    assert.equal(safeToReopen("http://site.test/orders", on), true);
    assert.equal(safeToReopen("http://site.test/notes/delete?id=3", on), false);
    assert.equal(safeToReopen("http://site.test/checkout", on), false);
    assert.equal(safeToReopen("http://site.test/logout", on), false);
    assert.equal(safeToReopen("http://site.test/trades/save?symbol=TEST", on), false);
    assert.equal(safeToReopen("http://site.test/notes?title=Lunch+plan", on, ["Lunch plan"]), false);
    assert.equal(safeToReopen("http://other.test/notes", on), false);
  });
  it("a body that says it failed is a failure though its status is 200", () => {
    assert.equal(errorShape({ data: null, errors: [{ message: "denied" }] }), "errors in its body");
    assert.equal(errorShape({ ok: false }), "ok: false in its body");
    assert.equal(errorShape({ success: false }), "success: false in its body");
    assert.equal(errorShape({ status: "error" }), 'status "error" in its body');
    assert.equal(errorShape({ error: "Name taken" }), "an error in its body");
    assert.equal(errorShape({ ok: true, id: 3 }), undefined);
    assert.equal(errorShape({ errors: [] }), undefined);
  });
  it("the request only supports, and only the one the press caused", () => {
    const reqs = [{ seq: 2, method: "POST", path: "/api/x", status: 200 }, { seq: 5, method: "POST", path: "/api/create", status: 200, failed: "200 with ok: false in its body" }];
    assert.equal(requestsSay(reqs, 5).ok, false);
    assert.match(requestsSay(reqs, 5).failed ?? "", /answered 200 with ok: false/);
    assert.equal(requestsSay(reqs, 2).ok, true);
    assert.equal(requestsSay(reqs, 9).caused.length, 0);
  });
});

const A = (seq: number, type: string, o: Partial<ProofAct> = {}): ProofAct => ({ seq, type, ...o });

describe("proof: the expected value is fixed from the goal and the actions, before the press", () => {
  it("a create: what was typed before the save, the goal's quoted name first", () => {
    const p = proofPlan(`Add a note named "Lunch plan" with notes "bring salad", save it`, [A(0, "click", { role: "button", name: "New note" }), A(1, "fill", { role: "textbox", name: "Title", value: "Lunch plan" }), A(2, "fill", { role: "textbox", name: "Notes", value: "bring salad" }), A(3, "click", { role: "button", name: "Save" })]);
    assert.deepEqual(p, { kind: "persists", values: ["Lunch plan", "bring salad"], since: 1, press: 3, from: "typed", all: true });
  });
  it("a rename: the last write (the new name), never the old one", () => {
    const p = proofPlan(`Add a contact named "Ada", then rename it to "Ada Byron"`, [A(0, "fill", { role: "textbox", name: "Name", value: "Ada" }), A(1, "click", { role: "button", name: "Add" }), A(2, "dblclick", { role: "cell", name: "Ada" }), A(3, "fill", { role: "textbox", name: "Rename", value: "Ada Byron" }), A(4, "press", { key: "Enter" })]);
    assert.equal(p.kind, "persists");
    assert.deepEqual(p.kind === "persists" && p.values, ["Ada Byron"]);
    assert.equal(p.kind === "persists" && p.since, 3);
  });
  it("a wizard whose later pages hold only numbers: the page with the name", () => {
    const p = proofPlan(`Create a workout named "Leg day" with 12 reps`, [A(0, "fill", { role: "textbox", name: "Name", value: "Leg day" }), A(1, "click", { role: "button", name: "Next" }), A(2, "fill", { role: "spinbutton", name: "Reps", value: "12" }), A(3, "click", { role: "button", name: "Next" }), A(4, "click", { role: "button", name: "Finish" })]);
    assert.deepEqual(p.kind === "persists" && p.values, ["Leg day"]);
  });
  it("a wizard whose quoted name is on its first page and a pick on its last: the name", () => {
    const p = proofPlan(`Create a recipe named "Broth-802" with cuisine Greek`, [A(0, "fill", { role: "textbox", name: "Title", value: "Broth-802" }), A(1, "click", { role: "button", name: "Next" }), A(2, "click", { role: "radio", name: "Greek" }), A(3, "click", { role: "button", name: "Next" }), A(4, "click", { role: "button", name: "Finish" })]);
    assert.deepEqual(p.kind === "persists" && p.values, ["Broth-802"]);
  });
  it("in a group with typing and a pick, the typing: a pick's words are on the form itself", () => {
    const p = proofPlan("Add a note please", [A(0, "fill", { role: "textbox", name: "Title", value: "Test" }), A(1, "click", { role: "radio", name: "Urgent" }), A(2, "click", { role: "button", name: "Save" })]);
    assert.deepEqual(p.kind === "persists" && p.values, ["Test"]);
  });
  it("words typed into a combobox to find a pick are not values; the pick is", () => {
    const p = proofPlan(`Add a trade with setup Swing`, [A(0, "fill", { role: "combobox", name: "Setup", value: "Swi" }), A(1, "click", { role: "option", name: "Swing" }), A(2, "click", { role: "button", name: "Save" })]);
    assert.deepEqual(p.kind === "persists" && p.values, ["Swing"]);
  });
  it("a combobox that takes the typed words as its value (no pick follows): the typing counts", () => {
    const p = proofPlan("add a manual trade for ABCXYZ, buy, any entry price", [A(0, "fill", { role: "combobox", name: "Symbol", value: "ABCXYZ" }), A(1, "fill", { role: "textbox", name: "Price", value: "1.1000" }), A(2, "click", { role: "button", name: "Continue" }), A(3, "click", { role: "button", name: "Save trade" })]);
    assert.deepEqual(p.kind === "persists" && p.values, ["ABCXYZ"]);
  });
  it("nothing typed (a wishlist): the goal's quoted name, looked for from the first save-like press", () => {
    const p = proofPlan(`Add "Ledger template" to the wishlist`, [A(0, "click", { role: "link", name: "Store" }), A(1, "click", { role: "button", name: "Add to wishlist" })]);
    assert.deepEqual(p, { kind: "persists", values: ["Ledger template"], since: 1, press: 1, from: "goal" });
  });
  it("a setting turned on: its state", () => {
    const p = proofPlan(`In settings, turn on "Due-date reminders" and make sure it stays on`, [A(0, "click", { role: "switch", name: "Due-date reminders" })]);
    assert.deepEqual(p, { kind: "toggle", name: "Due-date reminders", on: true, since: 0, press: 0 });
  });
  it("a delete: the named row, from the delete press", () => {
    const p = proofPlan(`Delete the note "Lunch plan"`, [A(0, "click", { role: "button", name: "Open Lunch plan" }), A(1, "click", { role: "button", name: "Delete" }), A(2, "click", { role: "button", name: "Yes" })]);
    assert.deepEqual(p, { kind: "gone", values: ["Lunch plan"], since: 1, press: 1 });
  });
  it("\"Remove the filter\" is not a delete", () => {
    assert.notEqual(proofPlan(`Remove the filter and show "Archived" items`, [A(0, "click", { role: "button", name: "Remove filter" })]).kind, "gone");
  });
  it("nothing to look for: unmeasured, never a pass by itself", () => {
    const p = proofPlan("Add a trade please, any entry", [A(0, "fill", { role: "spinbutton", name: "Qty", value: "1" }), A(1, "click", { role: "button", name: "Save" })]);
    assert.equal(p.kind, "none");
    assert.equal(judgeProof(p, new Map(), []).status, "unmeasured");
  });
});

describe("proof: the verdict from before and after (pure)", () => {
  const plan = { kind: "persists" as const, values: ["Lunges"], since: 1, press: 3, from: "typed" as const };
  const before = (n: number) => new Map([["http://s/", new Map([["Lunges", n]])]]);
  it("held only when it shows more often than before the save", () => {
    assert.equal(judgeProof(plan, before(1), [{ url: "http://s/", counts: { Lunges: 2 } }]).status, "held");
    const f = judgeProof(plan, before(1), [{ url: "http://s/", counts: { Lunges: 1 } }]);
    assert.equal(f.status, "failed");
    assert.match(f.why, /shows 1 time, no more than before the save \(1\)/);
  });
  it("a page first seen after the save counts only when the value was on no page before, and not after a failed request; a page that can't tell is unmeasured", () => {
    const weak = judgeProof(plan, before(0), [{ url: "http://s/n/7", counts: { Lunges: 1 } }]);
    assert.equal(weak.status, "held");
    assert.equal(weak.strength, "weak", "a row an earlier run left could explain it");
    assert.equal(judgeProof(plan, before(1), [{ url: "http://s/", counts: { Lunges: 2 } }]).strength, "strong");
    assert.equal(judgeProof(plan, before(1), [{ url: "http://s/n/7", counts: { Lunges: 1 } }]).status, "unmeasured");
    assert.equal(judgeProof(plan, before(0), [{ url: "http://s/n/7", counts: { Lunges: 1 } }], { requests: [{ seq: 3, method: "POST", path: "/api", status: 500, failed: "status 500" }] }).status, "failed");
  });
  it("shown after the press by the run itself, gone after a fresh load: failed (an optimistic row, a row added on screen only)", () => {
    const live = new Map([["http://s/", new Map([["Lunges", 1]])]]);
    const f = judgeProof(plan, before(0), [{ url: "http://s/", counts: { Lunges: 0 } }], { after: live });
    assert.equal(f.status, "failed");
    assert.match(f.why, /it was shown, not kept/);
    assert.equal(judgeProof(plan, before(0), [{ url: "http://s/", counts: { Lunges: 0 } }]).status, "unmeasured");
  });
  it("the same page with another query (\"?saved=1\") shares its before", () => {
    assert.equal(judgeProof(plan, before(1), [{ url: "http://s/?saved=1", counts: { Lunges: 2 } }]).status, "held");
  });
  it("a delete: exactly one fewer; the same, or two fewer, is not", () => {
    const gone = { kind: "gone" as const, values: ["Lunges"], since: 1, press: 1 };
    assert.equal(judgeProof(gone, before(3), [{ url: "http://s/", counts: { Lunges: 2 } }]).status, "held");
    assert.match(judgeProof(gone, before(3), [{ url: "http://s/", counts: { Lunges: 3 } }]).why, /still shows/);
    assert.match(judgeProof(gone, before(3), [{ url: "http://s/", counts: { Lunges: 1 } }]).why, /more than one went/);
    assert.equal(judgeProof(gone, new Map(), [{ url: "http://s/", counts: { Lunges: 0 } }]).status, "unmeasured");
  });
  it("the before is the highest count on any reading up to the press, per page", () => {
    const r: Reading[] = [{ seq: 0, url: "http://s/", text: fold("") }, { seq: 1, url: "http://s/", text: fold("Lunges") }, { seq: 4, url: "http://s/", text: fold("Lunges Lunges") }];
    assert.equal(baselines(r, ["Lunges"], 1).get("http://s/")?.get("Lunges"), 1);
  });
});

describe("marker (shared with W2)", () => {
  it("the same seed gives the same marker; it has a letter and a digit", () => {
    const m = makeMarker(42);
    assert.deepEqual(makeMarker(42), m);
    assert.match(m.code, /^(?=.*\d)(?=.*[A-Z])[2-9A-HJKMNP-Z]{4}$/);
    assert.equal(m.word, `Test ${m.code}`);
    assert.notEqual(makeMarker(43).code, m.code);
  });
  it("marks a text value, an email, keeps within a field's limit, and leaves numbers to markNumber", () => {
    const m = makeMarker("run-1");
    assert.equal(markValue({ type: "text" }, m), `Test ${m.code}`);
    assert.equal(markValue({ type: "text", value: "Test Client" }, m), `Test Client ${m.code}`);
    assert.equal(markValue({ type: "email", value: "test+cm@example.com" }, m), `test+cm-${m.code.toLowerCase()}@example.com`);
    assert.equal(markValue({ type: "number", value: "1" }, m), "1");
    const short = markValue({ type: "text", value: "Test Client", maxLength: 8 }, m);
    assert.ok(short.length <= 8 && short.endsWith(m.code), short);
    assert.equal(hasMarker(`a row: Test ${m.code} 37`, m), true);
    assert.equal(markerIn(`Test Client ${m.code}`), m.code);
    assert.match(markNumber(m, 0), /^\d{2,3}\.\d{3}[1-9]$/);
    assert.equal(markNumber(m, 1), markNumber(m, 1));
  });
});

// ---------------------------------------------------------------------------------------------
// The browser: the proof traps on a small local site

interface Row {
  name: string;
}
const state: Record<string, { rows: Row[]; on?: boolean; slow?: Row[] }> = {};
let server: Server;
let base = "";
let browser: Browser;
const dirs: string[] = [];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A list page with a form: `mode` picks how the save behaves. */
function page(id: string, mode: string): string {
  const s = state[id]!;
  const rows = s.rows.map((r) => `<tr><td>${esc(r.name)}</td><td><button type="button" class="del" data-n="${esc(r.name)}">Delete</button></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>List</title></head><body>
<h1>Notes</h1>
<label>Name <input id="name"></label> <button type="button" id="save">Save</button>
<label>Theme <button type="button" role="switch" id="sw" aria-checked="${s.on ? "true" : "false"}">Dark mode</button></label>
<p id="msg" role="status"></p>
<table><tbody id="rows">${rows}</tbody></table>
<p id="tick">Price: 0</p>
<script>
const MODE = ${JSON.stringify(mode)};
let n = 0; setInterval(() => { document.getElementById("tick").textContent = "Price: " + (++n); }, 100);
${mode.startsWith("draft") ? `const d = localStorage.getItem("draft"); if (d) document.getElementById("name").value = d; document.getElementById("name").addEventListener("input", (e) => localStorage.setItem("draft", e.target.value));` : ""}
document.getElementById("save").addEventListener("click", async () => {
  const name = document.getElementById("name").value;
  // An optimistic row, shown before the server answers.
  const tr = document.createElement("tr"); tr.innerHTML = "<td></td>"; tr.firstChild.textContent = name; document.getElementById("rows").appendChild(tr);
  const r = await fetch("/${id}/api/create?mode=" + MODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const body = await r.json().catch(() => ({}));
  if (MODE === "rollback" && !r.ok) tr.remove();
  document.getElementById("msg").textContent = "Saved";
});
document.querySelectorAll(".del").forEach((b) => b.addEventListener("click", async () => {
  await fetch("/${id}/api/delete?mode=" + MODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: b.dataset.n }) });
  b.closest("tr").remove();
}));
document.getElementById("sw").addEventListener("click", async (e) => {
  const on = e.target.getAttribute("aria-checked") !== "true";
  e.target.setAttribute("aria-checked", String(on));
  await fetch("/${id}/api/toggle?mode=" + MODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
});
</script></body></html>`;
}

before(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const [, id, , op] = u.pathname.split("/");
    const s = (state[id!] ??= { rows: [] });
    const mode = u.searchParams.get("mode") ?? "";
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { name?: string; on?: boolean };
        const json = (status: number, b: object) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(b));
        };
        if (op === "create") {
          if (mode === "silent" || mode === "draft-broken") return json(200, { ok: true });
          if (mode === "rollback") return json(422, { error: "Name taken" });
          if (mode === "error200") return json(200, { ok: false, errors: [{ message: "denied" }] });
          if (mode === "slow") {
            setTimeout(() => s.rows.push({ name: body.name ?? "" }), 2500);
            return json(200, { ok: true });
          }
          s.rows.push({ name: body.name ?? "" });
          return json(200, { ok: true });
        }
        if (op === "delete") {
          if (mode === "greedy") s.rows = s.rows.filter((r) => r.name !== body.name && !r.name.startsWith(String(body.name).split(" ")[0]!));
          else if (mode !== "stuck") {
            const i = s.rows.findIndex((r) => r.name === body.name);
            if (i >= 0) s.rows.splice(i, 1);
          }
          return json(200, { ok: true });
        }
        if (op === "toggle") {
          if (mode === "flaky") return json(500, { error: "Internal" });
          s.on = Boolean(body.on);
          return json(200, { ok: true });
        }
        json(404, {});
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page(id!, mode));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let ids = 0;
/** A fresh list: its id, its rows to start with, its address (`mode` in the query). */
function list(mode: string, rows: string[] = []): { id: string; url: string } {
  const id = `l${++ids}`;
  state[id] = { rows: rows.map((name) => ({ name })) };
  return { id, url: `${base}/${id}/?mode=${mode}` };
}

/**
 * Does what the run does: reads the page's plain text before each action, keeps each action, watches
 * the write requests each press causes; then proves. `steps`: what to do, in order.
 */
async function run(goal: string, url: string, steps: ((p: Page) => Promise<ProofAct>)[], o: { draft?: string } = {}) {
  const context = await browser.newContext();
  try {
    const p = await context.newPage();
    if (o.draft) await context.addInitScript((d) => localStorage.setItem("draft", d), o.draft);
    await p.goto(url);
    const onSite = (u: string) => u.startsWith(base);
    const writes = new WriteWatch(p, onSite);
    const readings: Reading[] = [];
    const acts: ProofAct[] = [];
    let lastActionAt = Date.now();
    for (const [seq, step] of steps.entries()) {
      readings.push({ seq, url: urlKey(p.url()), text: await readPlain(p) });
      writes.begin(seq);
      const a = await step(p);
      await p.waitForTimeout(300);
      writes.end();
      lastActionAt = Date.now();
      acts.push({ ...a, seq });
    }
    return await proveWrite({ goal, acts, readings, requests: writes.list, endUrl: p.url(), endText: await readPlain(p), lastActionAt, browser, from: context, onSite, viewport: p.viewportSize(), watchMs: 1500 });
  } finally {
    await context.close();
  }
}
const typeName = (v: string) => async (p: Page): Promise<ProofAct> => {
  await p.fill("#name", v);
  return { seq: 0, type: "fill", role: "textbox", name: "Name", value: v };
};
const save = async (p: Page): Promise<ProofAct> => {
  await p.click("#save");
  return { seq: 0, type: "click", role: "button", name: "Save" };
};
const deleteRow = (v: string) => async (p: Page): Promise<ProofAct> => {
  await p.click(`.del[data-n="${v}"]`);
  return { seq: 0, type: "click", role: "button", name: "Delete" };
};
const flip = async (p: Page): Promise<ProofAct> => {
  await p.click("#sw");
  return { seq: 0, type: "click", role: "switch", name: "Dark mode" };
};

describe("proof: fresh navigation, on a page that ticks (a live page)", () => {
  it("a save that worked: held, on the run's own row only", async () => {
    const l = list("ok", ["Leg days", "Leg day"]);
    const p = await run(`Add a note named "Leg day", save it`, l.url, [typeName("Leg day"), save]);
    assert.equal(p.status, "held", p.why);
    assert.match(p.why, /"Leg day" shows 2 times, 1 more than before the save \(1\)/);
    assert.equal(p.requests?.[0]?.status, 200);
  });

  it("ended on a list page first seen after the save: still a strong proof from the page read before it", async () => {
    const l = list("ok");
    const toList = async (p: Page): Promise<ProofAct> => {
      await p.goto(l.url.replace("/?", "/list?"));
      return { seq: 0, type: "navigate" };
    };
    const p = await run(`Add a note named "Leg day", save it`, l.url, [typeName("Leg day"), save, toList]);
    assert.equal(p.status, "held", p.why);
    assert.equal(p.strength, "strong", p.why);
  });

  it("TRAP silent failure next to a look-alike row (same name already listed): failed", async () => {
    const l = list("silent", ["Leg day", "Leg days"]);
    const p = await run(`Add a new note named "Leg day", save it`, l.url, [typeName("Leg day"), save]);
    assert.equal(p.status, "failed", p.why);
    assert.match(p.why, /no more than before the save/);
  });

  it("TRAP an optimistic row that rolls back after a 4xx: failed, and the 422 is said", async () => {
    const l = list("rollback");
    const p = await run(`Add a note named "Brunch", save it`, l.url, [typeName("Brunch"), save]);
    assert.equal(p.status, "failed", p.why);
    assert.equal(p.requests?.[0]?.failed, "status 422");
  });

  it("TRAP an optimistic row that stays, with a 200 whose body says it failed: failed", async () => {
    const l = list("error200");
    const p = await run(`Add a note named "Brunch", save it`, l.url, [typeName("Brunch"), save]);
    assert.equal(p.status, "failed", p.why);
    assert.match(p.why, /answered 200 with errors in its body|200 with ok: false/);
  });

  it("TRAP a draft restored from local storage into the field: the field never counts", async () => {
    const l = list("draft-broken");
    const p = await run(`Add a note named "Picnic", save it`, l.url, [typeName("Picnic"), save], { draft: "Picnic" });
    assert.equal(p.status, "failed", p.why);
  });

  it("a slow save (kept 2.5 s after it answers): held, within the retry budget", async () => {
    const l = list("slow");
    const p = await run(`Add a note named "Slowpoke", save it`, l.url, [typeName("Slowpoke"), save]);
    assert.equal(p.status, "held", p.why);
  });

  it("a delete of exactly one row: held; a delete that took two rows, or none: failed", async () => {
    const ok = list("ok", ["Leg day", "Arm day", "Leg day"]);
    const held = await run(`Delete the note "Leg day"`, ok.url, [deleteRow("Leg day")]);
    assert.equal(held.status, "held", held.why);
    const two = list("greedy", ["Leg day", "Leg day x", "Arm day"]);
    // The row named "Leg day" goes, and so does "Leg day x": "Leg day" shows twice before, never after.
    const many = await run(`Delete the note "Leg day"`, two.url, [deleteRow("Leg day")]);
    assert.equal(many.status, "failed", many.why);
    assert.match(many.why, /more than one went/);
    const none = list("stuck", ["Leg day"]);
    const still = await run(`Delete the note "Leg day"`, none.url, [deleteRow("Leg day")]);
    assert.equal(still.status, "failed", still.why);
    assert.match(still.why, /still shows/);
  });

  it("a setting turned on: held when the server kept it, failed when a reload shows it off", async () => {
    const ok = list("ok");
    const on = await run(`Turn on "Dark mode"`, ok.url, [flip]);
    assert.equal(on.status, "held", on.why);
    const broken = list("flaky");
    const p = await run(`Turn on "Dark mode"`, broken.url, [flip]);
    assert.equal(p.status, "failed", p.why);
    assert.match(p.why, /off again, and the save's request .* answered status 500/);
  });

  it("the plain text leaves out fields, toasts and option lists", async () => {
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.setContent(`<p>Row: Kale</p><input value="Kale"><textarea>Kale</textarea><div role="status">Saved Kale</div><ul role="listbox"><li role="option">Kale</li></ul><select><option>Kale</option></select><div class="Toast-x">Kale</div><p hidden>Kale</p><p>Ka<b>le</b> soup</p>`);
    const text = await readPlain(p);
    assert.equal(countIn(text, "Kale"), 2, text);
    await context.close();
  });
});

// ---------------------------------------------------------------------------------------------
// The run: the proof decides, and the judge alone never passes a write

type Move = (input: DecideInput) => Action;
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const refOf = (snapshot: string, role: string, name: string) => {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${reEsc(name)}`).exec(snapshot);
  if (!m) throw new Error(`no ${role} ${name} in:\n${snapshot.slice(0, 2000)}`);
  return m[1]!;
};
function brainOf(plan: PlannedStep[], moves: Move[], judge?: () => JudgeAnswer): TesterBrain {
  const left = [...moves];
  return {
    async plan() {
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      return (left.shift() ?? (() => ({ type: "done" }) as Action))(input);
    },
    ...(judge ? { async judge() {
      return judge();
    } } : {}),
  };
}
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-proof-"));
  dirs.push(d);
  return d;
};
const STEP = (check: PlannedStep["check"]): PlannedStep => ({ title: "Add the note", intent: 'Type "Leg day" into Name and press Save to save it.', check });
const moves: Move[] = [(i) => ({ type: "fill", ref: refOf(i.snapshot, "textbox", "Name"), value: "Leg day" }), (i) => ({ type: "click", ref: refOf(i.snapshot, "button", "Save") })];

describe("proof in the run", () => {
  it("a save that worked, checked by its row: PASS, with the proof kept on the result", async () => {
    const l = list("ok", ["Arm day"]);
    const { result } = await runTest({ goal: `Add a note named "Leg day", save it`, url: l.url, dir: dir(), browser, brain: brainOf([STEP({ kind: "text_visible", text: "Leg day" })], moves), checkWaitMs: 800, noMedia: true });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps, null, 1));
    assert.equal(result.proof?.status, "held", JSON.stringify(result.proof));
  });

  it("a silent failure whose look-alike row makes the check hold: NOT SURE, never PASS", async () => {
    const l = list("silent", ["Leg day"]);
    const { result } = await runTest({ goal: `Add a new note named "Leg day", save it`, url: l.url, dir: dir(), browser, brain: brainOf([STEP({ kind: "text_visible", text: "Saved" })], moves), checkWaitMs: 800, noMedia: true });
    assert.equal(result.verdict, "not_sure", JSON.stringify(result.steps, null, 1));
    assert.match(result.steps.at(-1)!.reason ?? "", /didn.t confirm the change was kept/);
    assert.equal(result.proof?.status, "failed");
  });

  it("a write passed only by the AI judge, with nothing to measure: NOT SURE", async () => {
    const l = list("ok");
    const judgeStep: PlannedStep = { title: "Add a note", intent: "Type 12 into Name and press Save to save it.", check: { kind: "judged", claim: "The new note is in the list" } };
    const brain = brainOf([judgeStep], [(i) => ({ type: "fill", ref: refOf(i.snapshot, "textbox", "Name"), value: "12" }), (i) => ({ type: "click", ref: refOf(i.snapshot, "button", "Save") })], () => ({ verdict: "holds", reason: "the list shows it", quotes: ["12"] }) as unknown as JudgeAnswer);
    const { result } = await runTest({ goal: "Add a note please, any number", url: l.url, dir: dir(), browser, brain, checkWaitMs: 800, noMedia: true });
    assert.notEqual(result.verdict, "pass", JSON.stringify({ steps: result.steps, proof: result.proof }, null, 1));
  });
});

it("the kept-check also looks at the site's own list of what the goal makes", async () => {
  const { listLinks, goalThings } = await import("../packages/scanner/src/tester/proof.ts");
  assert.deepEqual(goalThings("can we add a trade please"), ["trade"]);
  const links = [{ text: "Brief", href: "/brief" }, { text: "Trades", href: "/trades" }, { text: "Calendar", href: "/calendar" }, { text: "Settings", href: "/settings" }];
  assert.deepEqual(listLinks("can we add a trade please", links), ["/trades"]);
  assert.deepEqual(listLinks("Add a new contact to the contacts list", [{ text: "Contacts", href: "/c" }, { text: "Companies", href: "/co" }]), ["/c"]);
  assert.deepEqual(listLinks("book a class", [{ text: "Classes", href: "/classes" }, { text: "Book now", href: "/book" }]), ["/classes", "/book"]);
  assert.deepEqual(listLinks("save it please", links), []);
});
