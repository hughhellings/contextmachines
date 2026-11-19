// W3 proof on page shapes the zoo doesn't have (the W3 review's findings 1-6), with a scripted AI:
//   1. a write sent by a GET link (a no-JavaScript "Add to cart", a "Join class" link): reopening must
//      never repeat it;
//   2. a classic form save (POST, then a 303 redirect to the new row): a save that worked;
//   3. a catalog name from the goal, with the change kept on another page: unmeasured, not failed;
//   4. a table whose buttons carry screen-reader-only names ("Bin, Lunch"): a delete is exactly -1;
//   5. a save whose request answered 500 while the page keeps the row in local storage: never held;
//   6. a row an earlier run left with a marker-looking name: not this run's (only its own marker is).
//   node --test cli/proof-shapes.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import { makeMarker } from "../packages/scanner/src/tester/marker.ts";
import { actedByLoad, judgeProof, proofPlan, requestsSay, safeToReopen, type ProofPlan } from "../packages/scanner/src/tester/proof.ts";

// ---------------------------------------------------------------------------------------------
// Pure parts

describe("proof shapes: pure rules", () => {
  it("a redirect after a save is a save that worked; a 4xx/5xx isn't; a retry of the same request that worked is", () => {
    assert.equal(requestsSay([{ seq: 2, method: "POST", path: "/items", status: 303 }], 2).ok, true);
    assert.equal(requestsSay([{ seq: 2, method: "POST", path: "/items", status: 302 }], 2).failed, undefined);
    assert.match(requestsSay([{ seq: 2, method: "POST", path: "/items", status: 500, failed: "status 500" }], 2).failed ?? "", /status 500/);
    const retried = [
      { seq: 2, method: "POST", path: "/api/create", status: 503, failed: "status 503" },
      { seq: 2, method: "POST", path: "/api/create", status: 200, late: true },
    ];
    assert.equal(requestsSay(retried, 2).ok, true);
    // A late request is never the save itself (a beacon after the press), only a retry.
    assert.equal(requestsSay([{ seq: 2, method: "POST", path: "/beacon", status: 500, failed: "status 500", late: true }], 2).failed, undefined);
  });
  it("a page reached by a plain GET from a press at or after the save, with no write of its own, is never reopened", () => {
    const navs = [
      { seq: 1, url: "http://s/notes" }, // a menu link before the save
      { seq: 3, url: "http://s/shop?add-to-cart=7" }, // the save press itself was a GET link
      { seq: 4, url: "http://s/items/2", viaWrite: true }, // a POST's 303 to the new row
      { seq: 5, url: "http://s/list" }, // a page a fetch save then went to
    ];
    const requests = [{ seq: 5, method: "POST", path: "/api/save", status: 200 }];
    const acted = actedByLoad(navs, requests, 3);
    assert.deepEqual([...acted], ["http://s/shop?add-to-cart=7"]);
    // The word list is a backstop for what the page loads didn't show.
    const on = () => true;
    for (const u of ["http://s/shop?add-to-cart=7", "http://s/classes/join?id=3", "http://s/subscribe", "http://s/posts/4/like", "http://s/events/2/rsvp"]) assert.equal(safeToReopen(u, on), false, u);
    for (const u of ["http://s/shop", "http://s/classes", "http://s/likes", "http://s/books"]) assert.equal(safeToReopen(u, on), true, u);
  });
  it("a name from the goal on a catalog page fails only where the run ended or saw it rise; elsewhere it's unmeasured", () => {
    const plan: ProofPlan = { kind: "persists", values: ["Yoga"], since: 1, press: 1, from: "goal" };
    const before = new Map([["http://s/classes", new Map([["Yoga", 1]])]]);
    const m = [{ url: "http://s/classes", counts: { Yoga: 1 } }];
    assert.equal(judgeProof(plan, before, m, { endUrl: "http://s/classes/mine" }).status, "unmeasured");
    // The one-click wishlist heart that sends nothing: the run ended on that page, so it can tell.
    assert.equal(judgeProof(plan, before, m, { endUrl: "http://s/classes" }).status, "failed");
    // A typed value keeps the old rule (the page listed it before and shows it no more often).
    assert.equal(judgeProof({ ...plan, from: "typed" }, before, m, { endUrl: "http://s/classes/mine" }).status, "failed");
  });
  it("when the goal quotes several typed values, all must show kept together: a save that drops the notes isn't held", () => {
    const acts = [
      { seq: 1, type: "fill", role: "textbox", name: "Name", value: "Press-608" },
      { seq: 2, type: "fill", role: "textbox", name: "Notes", value: "checked twice" },
      { seq: 3, type: "click", role: "button", name: "Done" },
    ];
    const plan = proofPlan('Add a workout named "Press-608" with notes "checked twice", save it', acts);
    assert.equal(plan.kind === "persists" && plan.all, true);
    const before = new Map([["http://s/", new Map([["Press-608", 0], ["checked twice", 0]])]]);
    const dropped = judgeProof(plan, before, [{ url: "http://s/", counts: { "Press-608": 1, "checked twice": 0 } }]);
    assert.equal(dropped.status, "unmeasured", dropped.why);
    assert.match(dropped.why, /doesn't show there with it/);
    assert.equal(judgeProof(plan, before, [{ url: "http://s/", counts: { "Press-608": 1, "checked twice": 1 } }]).status, "held");
    // One quoted name, other typed words: any of them is enough, as before.
    const one = proofPlan('Add a workout named "Press-608", save it', acts);
    assert.equal(one.kind === "persists" && one.all === true, false);
  });
  it("a failed save request is never held, however the page looks", () => {
    const plan: ProofPlan = { kind: "persists", values: ["Lunch"], since: 1, press: 2, from: "typed" };
    const before = new Map([["http://s/", new Map([["Lunch", 0]])]]);
    const p = judgeProof(plan, before, [{ url: "http://s/", counts: { Lunch: 1 } }], { requests: [{ seq: 2, method: "POST", path: "/save", status: 500, failed: "status 500" }] });
    assert.equal(p.status, "failed");
    assert.match(p.why, /only in this browser/);
    const gone: ProofPlan = { kind: "gone", values: ["Lunch"], since: 2, press: 2 };
    assert.equal(judgeProof(gone, new Map([["http://s/", new Map([["Lunch", 1]])]]), [{ url: "http://s/", counts: { Lunch: 0 } }], { requests: [{ seq: 2, method: "POST", path: "/del", status: 200, failed: "200 with ok: false in its body" }] }).status, "failed");
  });
  it("only this run's own marker makes a first-seen page strong; another run's marker-looking name is weak", () => {
    const mine = makeMarker();
    let other = makeMarker();
    while (other.code === mine.code) other = makeMarker();
    const plan = (v: string): ProofPlan => ({ kind: "persists", values: [v], since: 1, press: 2, from: "typed" });
    const before = new Map([["http://s/new", new Map<string, number>()]]);
    const at = (v: string) => [{ url: "http://s/items/1", counts: { [v]: 1 } }];
    assert.equal(judgeProof(plan(mine.word), before, at(mine.word), { marker: mine }).strength, "strong");
    assert.equal(judgeProof(plan(other.word), before, at(other.word), { marker: mine }).strength, "weak");
    assert.equal(judgeProof(plan(mine.word), before, at(mine.word)).strength, "weak");
    assert.equal(judgeProof(plan("Testing ABC3"), before, at("Testing ABC3"), { marker: mine }).strength, "weak");
  });
});

// ---------------------------------------------------------------------------------------------
// Runs on local pages, with a scripted AI

type Move = { type: string; [k: string]: unknown } | { pick: "click" | "fill"; role: string; name: string; value?: string };
function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1]! : "e9999";
}
function scripted(plan: unknown[], moves: Move[], judge?: () => unknown) {
  const left: Move[] = [...moves];
  return {
    async plan() {
      return plan;
    },
    async decide(input: { snapshot: string }) {
      const move = left.shift() ?? { type: "done" };
      if ("pick" in move) {
        const m = move as { pick: "click" | "fill"; role: string; name: string; value?: string };
        const ref = refIn(input.snapshot, m.role, m.name);
        return m.pick === "click" ? { type: "click", ref } : { type: m.pick, ref, value: m.value ?? "" };
      }
      return move;
    },
    ...(judge ? { judge: async () => judge() } : {}),
  };
}
const step = (title: string, check: unknown) => ({ title, intent: title, check });
const page = (t: string, b: string) => `<!doctype html><html><head><title>${t}</title><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body>${b}</body></html>`;
const holds = (q: string) => () => ({ reasoning: "ok", evidence: [q], verdict: "holds" });

let cart: string[] = [];
let joined: string[] = [];
let rows: string[] = [];
let items: string[] = [];
const server: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url ?? "/", "http://x");
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    if (u.pathname === "/shop") {
      if (u.searchParams.get("add-to-cart") === "7") cart.push("Blue Mug");
      return html(page("Shop", `<h1>Shop</h1><ul><li>Blue Mug <a href="/shop?add-to-cart=7">Add to cart</a></li><li>Red Mug</li></ul><p>${cart.map((c) => `In your cart: ${c}`).join("<br>")}</p>`));
    }
    if (u.pathname === "/classes") return html(page("Classes", `<h1>Classes</h1><p>Yoga, Monday 10:00 <a href="/classes/join?id=3">Join class</a></p>`));
    if (u.pathname === "/classes/join") {
      joined.push("Yoga");
      return html(page("Your classes", `<h1>Your classes</h1><ul>${joined.map((r) => `<li>${r}, Monday 10:00</li>`).join("")}</ul>`));
    }
    if (u.pathname === "/rows" && req.method === "GET") return html(page("Notes", `<h1>Notes</h1><p id="c">${rows.length} notes</p><table>${rows.map((r) => `<tr><td>${r}</td><td><button onclick="fetch('/rows/del',{method:'POST',body:'${r}'}).then(()=>{this.closest('tr').remove();document.getElementById('c').textContent=document.querySelectorAll('tr').length+' note left'})">Bin<span class="sr-only">, ${r}</span></button></td></tr>`).join("")}</table>`));
    if (u.pathname === "/rows/del" && req.method === "POST") {
      rows = rows.filter((r) => r !== body);
      return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (u.pathname === "/local") return html(page("Notes", `<h1>Notes</h1><ul id="l"></ul><label>Name <input id="n"></label><button onclick="var v=document.getElementById('n').value;var a=JSON.parse(localStorage.getItem('n')||'[]');a.push(v);localStorage.setItem('n',JSON.stringify(a));fetch('/local/save',{method:'POST',body:v});draw()">Save</button><script>function draw(){document.getElementById('l').innerHTML=JSON.parse(localStorage.getItem('n')||'[]').map(function(x){return '<li>'+x+'</li>'}).join('')}draw()</script>`));
    if (u.pathname === "/local/save") return res.writeHead(500, { "content-type": "application/json" }).end(`{"error":"db down"}`);
    if (u.pathname === "/items/new") return html(page("New item", `<h1>New item</h1><form method="post" action="/items"><label>Name <input name="name"></label><button>Save</button></form>`));
    if (u.pathname === "/items" && req.method === "POST") {
      items.push(new URLSearchParams(body).get("name") ?? "");
      return res.writeHead(303, { location: `/items/${items.length}` }).end();
    }
    if (/^\/items\/\d+$/.test(u.pathname)) {
      const i = Number(u.pathname.split("/")[2]) - 1;
      return html(page("Item", `<h1>${items[i] ?? "?"}</h1><p>${i === items.length - 1 && i > 0 ? "Created just now" : "Created yesterday"}</p>`));
    }
    if (u.pathname === "/f/new") return html(page("New item", `<h1>New item</h1><label>Name <input id="n"></label><button onclick="fetch('/f/save',{method:'POST',body:document.getElementById('n').value}).then(r=>r.json()).then(j=>location.href='/items/'+j.id)">Save</button>`));
    if (u.pathname === "/f/save") return res.writeHead(200, { "content-type": "application/json" }).end(`{"id":1}`); // broken: drops the row, points at row 1
    res.writeHead(404).end("nf");
  });
});
let url = "";
let browser: Browser;
before(async () => {
  await new Promise<void>((d) => server.listen(0, "127.0.0.1", d));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  server.close();
});
const run = (start: string, o: Record<string, unknown>) => runTest({ url: url + start, dir: mkdtempSync(join(tmpdir(), "cm-proof-shapes-")), browser, checkWaitMs: 600, noMedia: true, ...o } as Parameters<typeof runTest>[0]);

describe("proof shapes: runs", { concurrency: 1 }, () => {
  it("1a: a GET 'Add to cart' link is never opened again: one mug, not two", async () => {
    cart = [];
    const brain = scripted([step("Add Blue Mug to the cart", { kind: "text_visible", text: "In your cart: Blue Mug" })], [{ pick: "click", role: "link", name: "Add to cart" }, { type: "done" }], holds("Blue Mug"));
    const { result } = await run("/shop", { goal: 'Add "Blue Mug" to the cart', brain });
    assert.equal(cart.length, 1, `one mug asked; the cart has ${cart.length}: ${JSON.stringify(result.proof)}`);
    assert.equal(result.verdict, "pass", JSON.stringify(result.proof));
  });
  it("1b: a GET 'Join class' link is never opened again: one sign-up, and the catalog page doesn't fail it", async () => {
    joined = [];
    const brain = scripted([step("Go to the Yoga class page", { kind: "text_visible", text: "Your classes" })], [{ pick: "click", role: "link", name: "Join class" }, { type: "done" }], holds("Your classes"));
    const { result } = await run("/classes", { goal: 'Register for the "Yoga" class', brain });
    assert.equal(joined.length, 1, `one sign-up asked; ${joined.length} made`);
    assert.notEqual(result.proof?.status, "failed", JSON.stringify(result.proof));
  });
  it("2: a classic form save (POST, then 303 to the new row) is a pass", async () => {
    items = ["Old item"];
    const brain = scripted([step("Create an item named Lunch box", { kind: "text_visible", text: "Created just now" })], [{ pick: "fill", role: "textbox", name: "Name", value: "Lunch box" }, { pick: "click", role: "button", name: "Save" }, { type: "done" }], holds("Created just now"));
    const { result } = await run("/items/new", { goal: 'Create an item named "Lunch box"', brain });
    assert.deepEqual(items, ["Old item", "Lunch box"]);
    assert.equal(result.verdict, "pass", JSON.stringify({ steps: result.steps, proof: result.proof }));
  });
  it("4: a working delete on a table with screen-reader-only names is exactly -1: a pass", async () => {
    rows = ["Lunch", "Dinner"];
    const brain = scripted([step("Delete the note Lunch", { kind: "text_visible", text: "1 note left" })], [{ pick: "click", role: "button", name: "Bin , Lunch" }, { type: "done" }], holds("Dinner"));
    const { result } = await run("/rows", { goal: 'Delete the note "Lunch"', brain });
    assert.deepEqual(rows, ["Dinner"]);
    assert.equal(result.verdict, "pass", JSON.stringify(result.proof));
    assert.equal(result.proof?.kind, "gone");
  });
  it("5: a save answered 500 whose row lives only in local storage is never a pass", async () => {
    const brain = scripted([step("Save a note named Lunch", { kind: "text_visible", text: "Lunch" })], [{ pick: "fill", role: "textbox", name: "Name", value: "Lunch" }, { pick: "click", role: "button", name: "Save" }, { type: "done" }], holds("Notes"));
    const { result } = await run("/local", { goal: 'Save a note named "Lunch"', brain });
    assert.equal(result.verdict, "not_sure", JSON.stringify(result.proof));
    assert.equal(result.proof?.status, "failed");
  });
  it("6: an earlier run's marker-looking row, shown by a broken save, is not this run's proof", async () => {
    items = ["Test 7Q2K"];
    const brain = scripted([step("Save an item named Test 7Q2K", { kind: "judged", claim: "The item Test 7Q2K was created" })], [{ pick: "fill", role: "textbox", name: "Name", value: "Test 7Q2K" }, { pick: "click", role: "button", name: "Save" }, { type: "done" }], holds("Created yesterday"));
    const { result } = await run("/f/new", { goal: 'Create an item named "Test 7Q2K"', brain });
    assert.notEqual(result.verdict, "pass", JSON.stringify(result.proof));
  });
});
