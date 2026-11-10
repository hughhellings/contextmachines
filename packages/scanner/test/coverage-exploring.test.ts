import type { CapturedEvent } from "@contextmachines/schemas";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanConfig, type ScanResult } from "../src/scan.ts";

/**
 * Reaching the product's real work, each trap beside the look-alike that must be left alone: a start
 * on one screen of many, forms that say what they want (the browser's rules, a message beside the
 * field, a line at the top, a wizard step with no number given) next to forms with no complaint, a
 * press that wipes the fields beside the next button, a required list that brings out its button,
 * a list that only exists once something's added, hubs, panels and hash views that eat a run.
 */
let site: Server;
let url: string;
const received: { method: string; path: string; body: string }[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

const routes: Record<string, string> = {
  // A start on one screen of many: the other sections are as much the product.
  "/posts/new": page("New post", `<a href="/tasks">Tasks</a>`),
  "/tasks": page("Tasks", `<p>Everything to do.</p>`),

  // The browser's own rules: a length, a range with a step, and a pattern.
  "/native": page("Apply", `<form id="f"><label>About you <textarea name="about" required minlength="60"></textarea></label>
    <label>Amount <input name="amount" type="number" min="18000" step="500" required></label>
    <label>Ref <input name="ref" pattern="[A-Z]{2}[0-9]{4}" required></label><button>Apply now</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); fetch("/api/native", { method: "POST", body: new FormData(f) }); };</script>`),

  // The script's own check, its message beside the field and the field marked.
  "/message": page("Contact", `<form id="f" novalidate><div><label>Message <textarea name="message" id="m"></textarea></label><div id="e" hidden></div></div><button>Send</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); const ok = m.value.length >= 80;
      e_ = document.getElementById("e"); e_.hidden = ok; e_.textContent = ok ? "" : "Message must be minimal 80 characters"; m.setAttribute("aria-invalid", String(!ok));
      if (ok) fetch("/api/message", { method: "POST", body: JSON.stringify({ message: m.value }) }); };</script>`),

  // A line at the top of the form, naming no field, about a date that hasn't come yet.
  "/register": page("Book", `<div id="top"></div><form id="f" novalidate><label>Name <input name="name"></label><label>Arrival <input name="start" type="date"></label><button>Create</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); const ok = new Date(f.start.value).getTime() > Date.now();
      document.getElementById("top").textContent = ok ? "" : "Pick a date in the future, please";
      if (ok) fetch("/api/register", { method: "POST", body: JSON.stringify({ name: f.name.value }) }); };</script>`),

  // A test file the form won't take, and a save button with something drawn over it.
  "/attach": page("Support", `<form id="f" novalidate><label>Topic <input name="topic"></label><label>Attachment <input type="file" name="a" id="a"></label><div id="e"></div><button>Send it</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); const none = a.files.length === 0; document.getElementById("e").textContent = none ? "" : "File should be empty"; a.classList.toggle("is-invalid", !none);
      if (none) fetch("/api/support", { method: "POST", body: "{}" }); };</script>`),
  "/covered": page("Join", `<form id="f"><label>Name <input name="who"></label><button>Join us</button></form><div style="position:fixed;inset:0;background:#0003"></div>
    <script>f.onsubmit = (e) => { e.preventDefault(); fetch("/api/join", { method: "POST", body: "{}" }); };</script>`),

  // A stepper beside the page's real button: a number that changes is no reason to start over.
  "/product": page("Product", `<main><button id="d">Less</button><input id="q" value="1"><button id="u">More</button><button id="a">Add it</button></main>
    <script>d.onclick = () => { q.value = Number(q.value) - 1; }; u.onclick = () => { q.value = Number(q.value) + 1; }; a.onclick = () => fetch("/api/add", { method: "POST", body: "{}" });</script>`),

  // What's typed the first time: a date of birth that's been, and sentences in a message box.
  "/about-you": page("About you", `<form id="f"><label>Date of birth <input name="dob" type="date"></label><label>Message <textarea name="message"></textarea></label><button>Tell us</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); if (new Date(f.dob.value) < new Date("2020-01-01") && f.message.value.length > 30) fetch("/api/about", { method: "POST", body: "{}" }); };</script>`),

  // A list whose first entry only asks you to choose, though it has a value of its own.
  "/plans": page("Plans", `<form id="f"><label>Plan <select name="plan"><option value="choose">Choose a plan</option><option value="pro">Pro</option></select></label><button>Pick it</button></form>
    <script>f.onsubmit = (e) => { e.preventDefault(); if (f.plan.value === "pro") fetch("/api/plan", { method: "POST", body: "{}" }); };</script>`),

  // Forms that use up a page's time, with the page's real button after them.
  "/busy-forms": page("Busy", `<main>${["a", "b", "c", "d"].map((n) => `<form onsubmit="event.preventDefault(); fetch('/api/${n}', { method: 'POST', body: '{}' })"><label>${n} <input name="${n}"></label><button>Send ${n}</button></form>`).join("")}
    <button onclick="fetch('/api/real', { method: 'POST', body: '{}' })">Real work</button></main>`),

  // A collection of pages made alike, each with its own number of cards, and a page unlike them last.
  "/brands": page("Brands", `${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map((n) => `<a href="/brands/${n}">${n}</a> `).join("")}<a href="/brands/more/note">Note</a>`),
  "/brands/more/note": page("Note", `<button>Something else</button>`),

  // An address that takes something other than a page load, with a framework's page for trying it out.
  "/tryit": page("Things", `<a href="/api/things">The API</a>`),

  // No complaint at all: a form that does its work in the page is sent once.
  "/local": page("Notes", `<form id="f"><label>Note <input name="note"></label><button>Keep</button></form><ul id="l"></ul>
    <script>let sends = 0; f.onsubmit = (e) => { e.preventDefault(); sends++; l.innerHTML += "<li>kept</li>"; fetch("/seen/local?n=" + sends); };</script>`),

  // Refused, with nothing said about why: nothing to go on, so not pressed for nothing.
  "/mute": page("Quiet form", `<form id="f"><label>Note <input name="note"></label><button>Try</button></form>
    <script>let sends = 0; f.onsubmit = (e) => { e.preventDefault(); sends++; fetch("/seen/mute?n=" + sends); };</script>`),

  // A sign-in beside a button that only sounds like the next step: pressed, it changes nothing on the page.
  "/enter": page("Sign in", `<form id="f"><label>Email <input name="email" type="email"></label><button>Sign in</button></form><button type="button" id="o">Continue with email link</button>
    <script>f.onsubmit = (e) => { e.preventDefault(); fetch("/api/session", { method: "POST", body: "{}" }); }; o.onclick = () => fetch("/seen/onward");</script>`),

  // A toggle that names its other state, the way a password box's eye does.
  "/eye": page("Password", `<main><label>Password <input id="p" type="password"></label><button type="button" id="t">Show password</button></main>
    <script>t.onclick = () => { const shown = p.type === "password"; p.type = shown ? "text" : "password"; t.textContent = shown ? "Hide password" : "Show password"; fetch("/seen/eye?" + (shown ? "show" : "hide")); };</script>`),

  // A button whose new words are the next step, not its other state: pressed again, it saves.
  "/inline": page("Project", `<main><p id="n">Website refresh</p><button type="button" id="e">Edit project</button></main>
    <script>e.onclick = () => { if (e.textContent === "Edit project") { n.contentEditable = "true"; e.textContent = "Save project"; } else fetch("/api/started", { method: "POST", body: "{}" }); };</script>`),

  // A wizard in a pop-up: a step that turns a number down without saying what it wants.
  "/homes": page("Homes", `<button id="o">Apply</button><dialog id="d"><div id="step"></div></dialog>
    <script>const steps = [
        '<label>Monthly income <input name="income" inputmode="numeric"></label><div class="err" id="err"></div><button id="n">Continue</button>',
        '<p>Thanks, last step</p><label>Employer <input name="employer"></label><button id="n">Submit</button>'];
      let at = 0; const draw = () => { step.innerHTML = steps[at]; document.getElementById("n").onclick = () => {
        if (at === 0) { const v = Number(step.querySelector("input").value); if (v < 2500) { document.getElementById("err").textContent = "Your income doesn't meet the requirement."; return; } at = 1; draw(); }
        else { fetch("/api/applications", { method: "POST", body: "{}" }); d.close(); } }; };
      o.onclick = () => { at = 0; draw(); d.showModal(); };</script>`),

  // A press that saves and draws the page again: the list beside the next button comes back empty.
  "/ticket": page("Ticket", `<div id="app"></div>
    <script>const draw = () => { app.innerHTML = '<textarea id="reply"></textarea><button id="s">Send</button><select id="c"><option value="">-</option><option>Bug</option></select><button id="x">Close ticket</button>';
        document.getElementById("s").onclick = async () => { if (!document.getElementById("reply").value) return; await fetch("/api/replies", { method: "POST", body: "{}" }); draw(); };
        document.getElementById("x").onclick = () => { if (document.getElementById("c").value) fetch("/api/close", { method: "POST", body: "{}" }); };
      }; draw();</script>`),

  // A required list that brings out its button, which leads to a screen only reached that way.
  "/bank/index.html": page("Bank", `<div id="app"></div><script>
    const draw = () => { const h = location.hash;
      if (h === "#/account") app.innerHTML = window.who ? "<h2>Welcome</h2><p>Your accounts</p>" : "<p>Sign in first</p>";
      else { app.innerHTML = '<form id="f"><select id="s" required><option value="">---Your name---</option><option value="1">Ann</option></select> <button id="b" hidden>Login</button></form>';
        document.getElementById("s").onchange = (e) => { document.getElementById("b").hidden = !e.target.value; };
        document.getElementById("f").onsubmit = (e) => { e.preventDefault(); window.who = 1; location.hash = "#/account"; }; } };
    addEventListener("hashchange", draw); location.hash ||= "#/customer"; draw();</script>`),

  // A list that exists only once something's added, kept only in the page, its controls with it.
  "/todo": page("todos", `<header><input id="box" placeholder="What needs to be done?"></header><ul id="l"></ul><div id="foot"></div>
    <script>box.onkeydown = (e) => { if (e.key !== "Enter" || !box.value) return; l.innerHTML += "<li>" + box.value + "</li>"; box.value = "";
      foot.innerHTML = '<button id="clear">Clear list</button>'; document.getElementById("clear").onclick = () => { fetch("/api/cleared", { method: "POST", body: "{}" }); l.innerHTML = ""; foot.innerHTML = ""; }; };</script>`),

  // An API explorer: one document, many hash views made alike, each worth nothing more.
  "/docs/index.html": page("API docs", `${Array.from({ length: 12 }, (_, i) => `<a href="#/op${i}">Operation ${i}</a> `).join("")}<button>Authorize</button>`),
};

/** Two lists with the same toolbar in their main content, each button sending to its own list: both are their own. */
const TOOLBAR = ["New", "Export", "Archive", "Duplicate", "Share"];
const twin = (name: string, more: string) => page(name, `<main>${more}<p>All your ${name.toLowerCase()} in one place.</p>${TOOLBAR.map((b) => `<button type="button" onclick="fetch('/api/${name.toLowerCase()}/${b.toLowerCase()}', { method: 'POST', body: '{}' })">${b}</button>`).join("")}</main>`);

const shop = (i: string) => page(`Product ${i}`, `<div style="position:fixed;right:0;top:0"><button onclick="fetch('/seen/panel')">Open chat</button></div>
  <main><button onclick="fetch('/api/cart/${i}', { method: 'POST', body: '{}' })">Add number ${i}</button></main>`);

beforeAll(async () => {
  site = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      received.push({ method: req.method ?? "GET", path: u.pathname + u.search, body });
      const html = (content: string) => res.writeHead(200, { "content-type": "text/html" }).end(content);
      const fixed = routes[u.pathname];
      if (fixed) return html(fixed);
      const product = /^\/shop\/([a-z]+)$/.exec(u.pathname);
      if (u.pathname === "/api/things") return res.writeHead(405, { "content-type": "text/html" }).end(page("Things - REST framework", `<p>${"Try this address out with the form below. ".repeat(20)}</p><form><label>Name <input name="n"></label><button>POST</button></form><script>$("x");</script>`));
      if (/^\/brands\/\w+$/.test(u.pathname)) return html(page("Brand", `${"<div class=card><button>Add</button></div>".repeat(2 + u.pathname.length % 5)}`));
      if (u.pathname === "/twins") return html(page("Lists", `<a href="/twin/projects">Projects</a> <a href="/twin/invoices">Invoices</a>`));
      if (u.pathname === "/twin/projects") return html(twin("Projects", ""));
      if (u.pathname === "/twin/invoices") return html(twin("Invoices", `<label>Due by <input name="due" type="date"></label>`));
      if (u.pathname === "/shop") return html(page("Shop", ["hammer", "saw", "drill", "plane"].map((n) => `<a href="/shop/${n}">${n}</a> `).join("")));
      if (product) return html(shop(product[1]!));
      // A hub of one-click pages, the first few slow to press through.
      if (u.pathname === "/hub") return html(page("Examples", Array.from({ length: 20 }, (_, i) => `<a href="/ex${i}">Example ${i}</a> `).join("")));
      const busy = /^\/ex([0-4])$/.exec(u.pathname);
      if (busy) return html(page(`Busy example ${busy[1]}`, Array.from({ length: 10 }, (_, i) => `<button>Press ${busy[1]}-${i}</button>`).join("")));
      if (/^\/ex\d+$/.test(u.pathname)) return html(page(`Example ${u.pathname.slice(3)}`, `<p>One example.</p>`));
      if (u.pathname.startsWith("/seen/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      res.writeHead(404, { "content-type": "text/html" }).end(page("Not found", ""));
    });
  });
  await new Promise<void>((resolve) => site.listen(0, resolve));
  url = `http://localhost:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => void (await new Promise((resolve) => site.close(resolve))));

const learn = (path: string, more: Partial<ScanConfig> = {}): Promise<ScanResult> => scanSite({ startUrl: `${url}${path}`, maxPages: 30, maxDurationMs: 25_000, delayMs: 0, screenshots: false, ...more });
const writes = (result: ScanResult) => result.blockedWrites.map((w) => `${w.method} ${w.path}`);
const labels = (result: ScanResult) => result.events.filter((e): e is Extract<CapturedEvent, { kind: "page" }> => e.kind === "page").flatMap((e) => (e.snapshot.buttons ?? []).map((b) => b.label));

describe("a start on one screen", () => {
  it("still has the rest of the site", async () => {
    const result = await learn("/posts/new");
    expect(result.pagesVisited).toContain("/tasks");
    expect(result.scope).toBeUndefined();
  }, 40_000);
});

describe("forms that say what they want", () => {
  it("meets the browser's own rules", async () => {
    const result = await learn("/native");
    expect(writes(result)).toContain("POST /api/native");
  }, 40_000);

  it("meets a message beside the field", async () => {
    const result = await learn("/message");
    expect(writes(result)).toContain("POST /api/message");
  }, 40_000);

  it("meets a message that names no field", async () => {
    const result = await learn("/register");
    expect(writes(result)).toContain("POST /api/register");
  }, 40_000);

  it("gets a wizard past a step that only says no", async () => {
    const result = await learn("/homes");
    expect(writes(result)).toContain("POST /api/applications");
  }, 40_000);

  it("does without a file the form won't take", async () => {
    const result = await learn("/attach");
    expect(writes(result)).toContain("POST /api/support");
  }, 40_000);

  it("presses a save button that something's drawn over", async () => {
    const result = await learn("/covered");
    expect(writes(result)).toContain("POST /api/join");
  }, 40_000);

  it("gets it right first time where it can tell: a birthday that's been, a message in words", async () => {
    const result = await learn("/about-you");
    expect(writes(result)).toContain("POST /api/about");
  }, 40_000);

  it("takes a list's real first choice, not the one asking you to choose", async () => {
    const result = await learn("/plans");
    expect(writes(result)).toContain("POST /api/plan");
  }, 40_000);

  it("sends a form with no complaint just once", async () => {
    received.length = 0;
    await learn("/local");
    expect(received.filter((r) => r.path.startsWith("/seen/local"))).toHaveLength(1);
  }, 40_000);

  it("doesn't press again when nothing says what's wrong", async () => {
    received.length = 0;
    await learn("/mute");
    expect(received.filter((r) => r.path.startsWith("/seen/mute"))).toHaveLength(1);
  }, 40_000);
});

describe("a press that can't do anything new", () => {
  it("isn't a wizard's next step when it moved nothing on", async () => {
    received.length = 0;
    await learn("/enter");
    // Once on the form's way through and once as a button: never again and again as each step of a wizard.
    expect(received.filter((r) => r.path === "/seen/onward").length).toBeLessThanOrEqual(2);
  }, 40_000);

  it("isn't a toggle's other state, pressed again to go back to how the page loaded", async () => {
    received.length = 0;
    await learn("/eye");
    // Pressed once: not again from a fresh load only to press it back.
    expect(received.filter((r) => r.path === "/seen/eye?show")).toHaveLength(1);
    expect(received.filter((r) => r.path === "/seen/eye?hide")).toEqual([]);
  }, 40_000);

  it("is a button's new words when they're the next step, not its other state", async () => {
    const result = await learn("/inline");
    expect(writes(result)).toContain("POST /api/started");
  }, 40_000);
});

describe("a press that changes the page", () => {
  it("doesn't cost the buttons beside it their turn", async () => {
    const result = await learn("/ticket");
    expect(writes(result)).toEqual(expect.arrayContaining(["POST /api/replies", "POST /api/close"]));
  }, 40_000);
});

describe("a press that only changes a number", () => {
  it("leaves the page as it is for the next button", async () => {
    received.length = 0;
    const result = await learn("/product");
    expect(writes(result)).toContain("POST /api/add");
    expect(received.filter((r) => r.method === "GET" && r.path === "/product").length).toBeLessThanOrEqual(4);
  }, 40_000);
});

describe("what has to be chosen or added first", () => {
  it("chooses from a required list, and presses the button that brings out", async () => {
    const result = await learn("/bank/index.html");
    expect(result.pagesVisited).toContain("/bank/index.html#/account");
  }, 40_000);

  it("shows a list with something in it, and presses what that brought out", async () => {
    const result = await learn("/todo", { screenshots: true });
    expect(labels(result)).toContain("Clear list");
    expect(result.screens[0]!.boxes.map((b) => b.label)).toContain("Clear list");
    expect(writes(result)).toContain("POST /api/cleared");
  }, 40_000);
});

describe("time goes where it's needed", () => {
  it("leaves a page's buttons their turn when its forms have used its time", async () => {
    const result = await learn("/busy-forms", { maxDurationMs: 14_000 });
    expect(writes(result)).toContain("POST /api/real");
  }, 40_000);

  it("samples pages made alike, and gets to what's different sooner", async () => {
    const result = await learn("/brands");
    expect(result.pagesVisited.indexOf("/brands/more/note")).toBeLessThanOrEqual(5);
  }, 40_000);

  it("takes a 405 for an API's address, not a screen, whatever it shows", async () => {
    const result = await learn("/tryit");
    expect(result.pagesVisited).not.toContain("/api/things");
    expect(result.findings).toEqual([]);
  }, 40_000);

  it("presses a page's own button on each page, the chat on it once", async () => {
    received.length = 0;
    const result = await learn("/shop", { maxPages: 12, maxDurationMs: 40_000 });
    const carts = writes(result).filter((w) => w.startsWith("POST /api/cart")).length;
    expect(carts).toBeGreaterThanOrEqual(2);
    expect(received.filter((r) => r.path === "/seen/panel").length).toBe(1);
  }, 60_000);

  it("presses a page's own buttons though another page's read the same", async () => {
    const result = await learn("/twins", { maxDurationMs: 60_000 });
    const sent = (name: string) => new Set(writes(result).filter((w) => w.startsWith(`POST /api/${name}/`))).size;
    expect(sent("projects")).toBe(TOOLBAR.length);
    expect(sent("invoices")).toBe(TOOLBAR.length);
  }, 90_000);

  it("looks at every page a hub links to before pressing through one", async () => {
    const result = await learn("/hub", { maxDurationMs: 25_000, maxPages: 40 });
    expect(result.pagesVisited.filter((p) => /^\/ex\d+$/.test(p)).length).toBeGreaterThanOrEqual(15);
  }, 40_000);

  it("leaves a document's hash views once they've stopped showing anything new", async () => {
    received.length = 0;
    const result = await learn("/docs/index.html");
    const views = result.pagesVisited.filter((p) => p.includes("#/"));
    expect(views[0]).toMatch(/^\/docs\/index\.html#\/op/);
    expect(views.length).toBeLessThanOrEqual(7);
    expect(views.length).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
