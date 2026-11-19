// The agentic tester, checked with a real browser on a tiny local site and a scripted planner and
// actor: no AI and no network.
//   node --test cli/tester.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import type { Browser } from "playwright";
import { onSite, refusedName, saidBy, siteOf, valueFor } from "../packages/scanner/src/tester/act.ts";
import { findSaved, hostSlug, listSaved, readSaved, savedPathFor, slugOf, varsUsed, withoutSecrets, writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { closesPopup, frictionCount, FrictionLog, interactionsOf, unnamedControl } from "../packages/scanner/src/tester/friction.ts";
import { compact } from "../packages/scanner/src/tester/observe.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { actionProblem, clip, DRAFT_NO_AI, masker, openError, planProblem, renamed, runTest, withoutFailedTries, type RunOptions } from "../packages/scanner/src/tester/run.ts";
import { addressPart, noStartersWhy, startersFrom, writeStarters } from "../packages/scanner/src/tester/starters.ts";
import type { WalkedJourney } from "../packages/scanner/src/journeys.ts";
import { CouldNotRun, type Action, type CachedAction as CachedActionT, type Check, type DecideInput, type PlannedStep, type StartPage, type TesterBrain, type TestEvent } from "../packages/scanner/src/tester/types.ts";
import { colors } from "./term.ts";
import { FILL_HELD } from "../packages/scanner/src/tester/fill.ts";
import { actionFrom, actQuestion, ACT_SYSTEM, authPathFor, Checklist, GENERIC_NAMES, PLAN_SYSTEM, reportsWord, sessionHint, setupPathFor, signInPlan, stepNotes } from "./test-command.ts";
import { askRoots, claudeAskArgs, claudeAskEnv, CLAUDE_QUIET_ENV, CODEX_QUIET } from "./ai.ts";
import { madeUpValue, refusedMadeUp, varHint, type FieldFacts } from "../packages/scanner/src/tester/values.ts";
import { testReportPage } from "./test-report.ts";
import { junitXml } from "./test-junit.ts";
import { ignoreAuth, missingVars, onOrigin, suiteExit, suiteSummary, varsFromEnv } from "./test-command.ts";

// ---------------------------------------------------------------------------------------------
// The site: two pages, a search box, a button, an off-site link, "Pay now", "Delete account", a sign-in.

interface Site {
  url: string;
  /** Another site, on another host name: what reaches it got out. */
  otherUrl: string;
  otherHits: string[];
  /** The search button's words: "Go", or after a redesign "Search now". */
  searchButton: string;
  posted: string[];
  close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

async function startSite(): Promise<Site> {
  const site = { searchButton: "Go", posted: [] as string[], otherHits: [] as string[] } as Site;
  const other: Server = createServer((req, res) => {
    site.otherHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" }).end("<h1>Partner page</h1>");
  });
  // Every address of this machine: "localhost" reaches it however it resolves.
  await new Promise<void>((done) => other.listen(0, done));
  site.otherUrl = `http://localhost:${(other.address() as AddressInfo).port}/`;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST") site.posted.push(`${url.pathname} ${body}`);
      const html = (content: string) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(content);
      };
      if (url.pathname === "/") {
        return html(page("Fixture Shop", `<nav><a href="/docs">Docs</a> <a href="https://other.example/">Elsewhere</a> <a href="/out">Leave</a> <a href="/login">Sign in page</a></nav>
          <h1>Welcome to Fixture Shop</h1>
          <form action="/search"><label>Search <input type="search" name="q"></label> <button>${site.searchButton}</button></form>
          <button onclick="document.getElementById('said').textContent='Hello there'">Say hello</button><p id="said"></p>
          <button>Pay now</button> <button>Delete account</button>`));
      }
      const deleteButton = (words = "Delete account") => `<button type="button" onclick="fetch('/did-delete',{method:'POST'});document.getElementById('o').textContent='ACCOUNT DELETED'">${words}</button>`;
      // Keys: a harmless button, then one that must never be pressed, reached with Tab.
      if (url.pathname === "/keys") return html(page("Keys", `<button type="button" onclick="document.getElementById('o').textContent='Hello there'">Say hello</button>${deleteButton()}<p id="o"></p>`));
      if (url.pathname === "/keys-form") return html(page("Keys form", `<form method="post" action="/did-save"><label>Name <input name="n"></label><button>Save</button>${deleteButton()}</form><p id="o"></p>`));
      if (url.pathname === "/image-form") return html(page("Message", `<form method="post" action="/did-send"><label>Message <input name="m"></label><input type="image" alt="Send" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></form>`));
      // An icon button with no name, after one that must never be pressed.
      if (url.pathname === "/icons") return html(page("Icons", `${deleteButton()}<button type="button" onclick="document.getElementById('o').textContent='Icon pressed'"><svg width="12" height="12"></svg></button><p id="o"></p>`));
      if (url.pathname === "/confirm") return html(page("Confirm", `<button type="button" onclick="document.getElementById('d').hidden=false">Clear list</button><div role="dialog" id="d" hidden aria-label="Are you sure?"><p>Delete 3 invoices?</p>${deleteButton("OK")}<button type="button">Cancel</button></div><p id="o"></p>`));
      if (url.pathname === "/comment") return html(page("Comment", `<h1>Your order</h1><div role="textbox" contenteditable="true" aria-label="Comment" style="min-height:2em;border:1px solid"></div>`));
      // A save the site answers (W3: a save whose request answers 404 is never a pass).
      if (url.pathname === "/did-save" && req.method === "POST") return html(page("Saved", `<h1>Saved</h1>`));
      if (url.pathname === "/required") return html(page("New client", `<h1>New client</h1><form method="post" action="/did-save"><label>Name <input name="name" required></label> <label>Email <input name="email" type="email" required></label> <button>Save client</button></form>`));
      // A form that asks for more than the goal gives, and one that needs a password nobody gave.
      if (url.pathname === "/new-client") return html(page("New client", `<h1>New client</h1><form method="post" action="/client-saved"><label>Name <input name="name" required></label> <label>Email <input name="client_email" type="email" required></label> <label>Billing address <input name="address" required></label> <label>VAT number <input name="vat" required></label> <label>Country <select name="country" required><option value="">Choose…</option><option>United Kingdom</option></select></label> <button>Save client</button></form>`));
      if (url.pathname === "/client-saved") return html(page("Saved", `<h1>Client saved</h1>`));
      // A learn-style starter's trap: the form's address already holds the check's "/trades".
      if (url.pathname === "/trades/new") return html(page("New trade", `<h1>New trade</h1><form method="post" action="/trades"><label>Symbol <input name="s" required></label> <button>Save trade</button></form>`));
      if (url.pathname === "/trades") return html(page("Trades", `<h1>Trades</h1>`));
      // A GET lookup: what is typed comes back in the address, encoded.
      if (url.pathname === "/lookup") return html(page("Lookup", `<form action="/find"><label>Account email <input name="q"></label> <button>Look up</button></form>`));
      if (url.pathname === "/find") return html(page("Found", `<h1>Account lookup</h1><p>Nothing for this account</p>`));
      // A contact form whose button only says "Submit": pressing it sends a message.
      if (url.pathname === "/contact") return html(page("Contact us", `<h1>Get in touch</h1><form method="post" action="/contact-sent"><label>Name <input name="name" required></label> <label>Email <input type="email" name="email" required></label> <label>Your message <textarea name="message" required></textarea></label> <button>Submit</button></form>`));
      if (url.pathname === "/contact-sent") return html(page("Thanks", `<h1>Thanks, we'll be in touch</h1>`));
      // A sign-in that says it failed and shows its form again, at the same address.
      if (url.pathname === "/strict-login") {
        const form = new URLSearchParams(body);
        if (req.method === "POST" && form.get("email") === "tester@fixture.test" && form.get("password")) return html(page("Home", `<h1>Signed in as tester</h1>`));
        return html(page("Sign in", `${req.method === "POST" ? "<p>Wrong email or password</p>" : ""}<form method="post" action="/strict-login"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`));
      }
      if (url.pathname === "/join") return html(page("Join", `<h1>Join</h1><form method="post" action="/client-saved"><label>Email <input name="email" type="email" required></label> <label>Password <input name="password" type="password" required></label> <button>Join</button></form>`));
      if (url.pathname === "/popup") return html(page("Partners", `<button type="button" onclick="window.open('${site.otherUrl}track?leak=1')">Open partner</button>`));
      if (url.pathname === "/docs") return html(page("Docs", "<h1>Documentation</h1><p>Locators find elements on the page.</p><a href='/'>Home</a>"));
      if (url.pathname === "/search") return html(page("Search", `<h1>Results for ${(url.searchParams.get("q") ?? "").replace(/[<>&]/g, "")}</h1>`));
      if (url.pathname === "/out") {
        res.writeHead(302, { location: "http://other.example/landing" });
        return res.end();
      }
      if (url.pathname === "/login") return html(page("Sign in", `<h1>Sign in</h1><form method="post" action="/welcome"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`));
      if (url.pathname === "/welcome") {
        const form = new URLSearchParams(body);
        const email = form.get("email") ?? "";
        // A sign-in with a password leaves a session cookie: what test --setup keeps.
        if (form.get("password")) res.setHeader("set-cookie", "sid=fixture-session-cookie; Path=/; HttpOnly");
        return html(page("Welcome", `<h1>Welcome back, ${email.replace(/[<>&]/g, "")}</h1>`));
      }
      if (url.pathname === "/account") return html(/sid=fixture-session-cookie/.test(req.headers.cookie ?? "") ? page("Account", "<h1>Your account</h1><p>Signed in</p>") : page("Account", "<h1>Please sign in</h1>"));
      // What a new user trips over: a cookie banner, a button with no name that opens a browser alert,
      // and a form that marks its field not valid.
      if (url.pathname === "/friction") {
        return html(page("Details", `<div role="dialog" aria-label="Cookies" id="ck"><p>We use cookies.</p><button type="button" onclick="document.getElementById('ck').remove()">Reject all</button> <button type="button" onclick="document.getElementById('ck').remove()">Accept all</button></div>
          <button type="button" onclick="alert('Fill in your details');document.getElementById('f').hidden=false"><svg width="12" height="12"></svg></button>
          <form id="f" hidden novalidate onsubmit="event.preventDefault();var e=document.getElementById('em');if(!e.value){e.setAttribute('aria-invalid','true');document.getElementById('err').textContent='Enter an email'}else{e.removeAttribute('aria-invalid');document.getElementById('err').textContent='';document.getElementById('o').textContent='Details saved'}">
          <label for="em">Email</label> <input id="em" aria-describedby="err"> <span id="err"></span> <button>Save</button></form><p id="o"></p>`));
      }
      res.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  site.close = async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => other.close(() => done()));
  };
  return site;
}

// ---------------------------------------------------------------------------------------------
// A scripted AI: the plan given, and for each step a list of moves, each picking an element by role and name.

type Move = Action | { pick: "click" | "fill" | "select"; role: string; name: string; value?: string };

/** The number of an element in the snapshot the actor was shown. */
function refIn(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot);
  return m ? m[1]! : "e9999";
}

interface Scripted extends TesterBrain {
  asks: number;
  seen: DecideInput[];
  /** The page the planner was shown. */
  start?: StartPage;
}

function scripted(plan: PlannedStep[], moves: Record<number, Move[]>): Scripted {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  let last: Move | undefined;
  const brain: Scripted = {
    asks: 0,
    seen: [],
    async plan(_goal, _url, _given, start) {
      brain.asks++;
      if (start) brain.start = start;
      return plan;
    },
    async decide(input) {
      brain.asks++;
      brain.seen.push(input);
      // Told a save was held for empty fields (fill.ts): this actor presses it again, as it is.
      const move = last && FILL_HELD.test(input.problem ?? "") ? last : (last = left[input.n]?.shift() ?? { type: "done" });
      if ("pick" in move) {
        const ref = refIn(input.snapshot, move.role, move.name);
        return move.pick === "click" ? { type: "click", ref } : { type: move.pick, ref, value: move.value ?? "" };
      }
      return move;
    },
  };
  return brain;
}

const step = (title: string, check: Check): PlannedStep => ({ title, intent: title, check });

let browser: Browser;
let site: Site;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-tester-"));
  dirs.push(d);
  return d;
};
const run = (o: Partial<RunOptions> & Pick<RunOptions, "goal">) => runTest({ url: site.url, dir: dir(), browser, checkWaitMs: 600, ...o });

before(async () => {
  browser = await launch();
  site = await startSite();
});
// Each test starts with nothing sent to the site.
beforeEach(() => {
  if (site) site.posted.length = 0;
});
after(async () => {
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("a test that passes", () => {
  it("ticks each step off on a measured check, records a video and a photo per step, and saves the test", async () => {
    const brain = scripted([step("Open the docs", { kind: "url_contains", text: "/docs" }), step("See the docs", { kind: "text_visible", text: "Locators find elements" })], {
      1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }],
    });
    const { result, save } = await run({ goal: "open the docs", brain });
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.steps.map((s) => s.verdict), ["passed", "passed"]);
    assert.equal(result.steps[0]!.actions[0]!.label, "Clicking on 'Docs' link");
    assert.ok(result.video);
    assert.ok(result.steps.every((s) => s.screenshot));
    assert.ok(save, "a full pass is saved");
    assert.deepEqual(save!.steps[0]!.actions, [{ type: "click", target: { role: "link", name: "Docs", nth: 0, of: 1 } }]);
    // The page went to the actor as untrusted data.
    assert.match(actQuestion(brain.seen[0]!), /<page_snapshot untrusted="true">[\s\S]*\[e\d+\] link "Docs"/);
  });
});

describe("a check that doesn't hold", () => {
  it("fails the step with what was expected and what was there, and saves nothing", async () => {
    const brain = scripted([step("Open the docs", { kind: "text_visible", text: "Pricing plans" })], { 1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }, { type: "done" }] });
    const { result, save } = await run({ goal: "docs show pricing", brain });
    assert.equal(result.verdict, "fail");
    const s = result.steps[0]!;
    assert.equal(s.verdict, "failed");
    assert.match(s.evidence!.expected, /Pricing plans/);
    assert.match(s.evidence!.found, /Documentation/);
    assert.ok(s.screenshot);
    assert.equal(save, undefined);
  });
});

describe("safety", () => {
  it("blocks a link to another site before it is followed", async () => {
    const brain = scripted([step("Go elsewhere", { kind: "url_contains", text: "other" })], { 1: [{ pick: "click", role: "link", name: "Elsewhere" }] });
    const { result } = await run({ goal: "go elsewhere", brain });
    assert.equal(result.verdict, "blocked");
    assert.match(result.steps[0]!.reason!, /off the site.*other\.example/);
  });

  it("blocks a navigation to another site, and a redirect to one", async () => {
    const nav = await run({ goal: "navigate away", brain: scripted([step("Go", { kind: "url_contains", text: "x" })], { 1: [{ type: "navigate", url: "https://other.example/" }] }) });
    assert.equal(nav.result.verdict, "blocked");
    assert.match(nav.result.steps[0]!.reason!, /other\.example is another site/);
    const redirect = await run({ goal: "leave by redirect", brain: scripted([step("Leave", { kind: "url_contains", text: "landing" })], { 1: [{ pick: "click", role: "link", name: "Leave" }] }) });
    assert.equal(redirect.result.verdict, "blocked");
    assert.match(redirect.result.steps[0]!.reason!, /other\.example/);
  });

  it("an allowed host may be visited", () => {
    assert.equal(onSite("https://docs.example.com/x", "https://www.example.com/"), true);
    assert.equal(onSite("https://example.co.uk/", "https://shop.example.co.uk/"), true);
    assert.equal(onSite("https://accounts.google.com/", "https://www.example.com/"), false);
    assert.equal(onSite("https://auth.partner.dev/", "https://www.example.com/", ["partner.dev"]), true);
    assert.equal(onSite("javascript:alert(1)", "https://www.example.com/"), false);
    assert.equal(siteOf("a.b.example.com"), "example.com");
  });

  it("never presses Pay now or Delete account", async () => {
    for (const name of ["Pay now", "Delete account"]) {
      const { result } = await run({ goal: `press ${name}`, brain: scripted([step(`Press ${name}`, { kind: "text_visible", text: "done" })], { 1: [{ pick: "click", role: "button", name }] }) });
      assert.equal(result.verdict, "blocked", name);
      assert.match(result.steps[0]!.reason!, name === "Pay now" ? /paying/ : /deleting/);
    }
    assert.deepEqual(site.posted, [], "nothing was sent to the site");
    for (const name of ["Buy now", "Subscribe", "Place order", "Send message", "Send invite", "Checkout", "Close account"]) assert.ok(refusedName(name), name);
    for (const name of ["Search", "Sign in", "Docs", "Add filter", "Sender settings"]) assert.equal(refusedName(name), undefined, name);
  });

  it("ends not sure when the AI names an element that isn't on the page", async () => {
    const brain = scripted([step("Click it", { kind: "text_visible", text: "Hello there" })], { 1: [{ type: "click", ref: "e9999" }, { type: "click", ref: "e8888" }] });
    const { result } = await run({ goal: "invented", brain });
    assert.equal(result.verdict, "not_sure");
    assert.match(result.steps[0]!.reason!, /couldn't be used: "e8888" isn't an element/);
    assert.equal(result.actions, 0, "nothing was done with a made-up element");
    // The second ask was told what was wrong with the first.
    assert.match(brain.seen[1]!.problem!, /e9999/);
  });

  it("types a password only from a --var, and no secret nobody gave", () => {
    const values = { vars: { password: "hunter2-secret" }, given: "sign in" };
    assert.deepEqual(valueFor("{password}", values, true), { value: "hunter2-secret" });
    assert.ok("refused" in valueFor("hunter2-secret", values, true));
    assert.ok("refused" in valueFor("sk-live-abcdefghijklmnopqrstuvwxyz123", values, false));
    assert.ok("refused" in valueFor("{nope}", values, false));
    assert.deepEqual(valueFor("locator", values, false), { value: "locator" });
  });
});

describe("the saved test", () => {
  const plan = [step("Search for locator", { kind: "text_visible", text: "Results for locator" })];
  const moves = () => ({ 1: [{ pick: "fill" as const, role: "searchbox", name: "Search", value: "locator" }, { pick: "click" as const, role: "button", name: "Go" }, { type: "done" as const }] });

  it("replays with no AI asked, and its checks still run", async () => {
    site.searchButton = "Go";
    const first = await run({ goal: "search for locator", brain: scripted(plan, moves()) });
    assert.equal(first.result.verdict, "pass");
    const file = join(dir(), "tests", `${slugOf("search for locator")}.json`);
    writeSaved(file, first.save!);
    const saved = readSaved(file);
    const brain = scripted([], {});
    const again = await run({ goal: "search for locator", brain, saved });
    assert.equal(again.result.verdict, "pass");
    assert.equal(brain.asks, 0, "no AI asked on a replay");
    assert.equal(again.result.replay, true);
    assert.ok(again.result.steps[0]!.replayed);
    assert.ok(again.result.steps[0]!.actions.every((a) => a.cached));
    assert.equal(again.save, undefined, "a plain replay changes nothing saved");
  });

  it("asks the AI for a step whose button was renamed, and says it healed", async () => {
    site.searchButton = "Go";
    const first = await run({ goal: "search for locator", brain: scripted(plan, moves()) });
    const file = join(dir(), "t.json");
    writeSaved(file, first.save!);
    site.searchButton = "Search now";
    try {
      const brain = scripted([], { 1: [{ pick: "click", role: "button", name: "Search now" }, { type: "done" }] });
      const events: string[] = [];
      const healed = await run({ goal: "search for locator", brain, saved: readSaved(file), on: (e) => void (e.type === "healing" && events.push(e.missing)) });
      assert.equal(healed.result.verdict, "pass");
      const s = healed.result.steps[0]!;
      assert.deepEqual(s.healed, { from: ["Clicking on 'Go' button"], to: ["Clicking on 'Search now' button"] }, "only what no longer worked, and what replaced it");
      assert.deepEqual(events, ["Clicking on 'Go' button"], "the healing was said as it happened");
      // E4: the click made the check hold, so no "done" is asked for.
      assert.equal(brain.asks, 1, "the AI was asked for that step only");
      assert.ok(healed.save, "the healed test is saved again");
      assert.equal(healed.save!.steps[0]!.actions!.at(-1)!.type, "click");
      assert.ok(testReportPage(healed.result, { dir: "/nowhere" }).includes("Healed:"));
    } finally {
      site.searchButton = "Go";
    }
  });
});

describe("--var values", () => {
  it("are typed but never shown: not in the result, the saved test, the report or the AI's question", async () => {
    const vars = { email: "tester@fixture.test", password: "hunter2-secret" };
    const brain = scripted(
      [step("Open sign in", { kind: "text_visible", text: "Sign in" }), step("Sign in as {email}", { kind: "text_visible", text: "Welcome back, {email}" })],
      {
        1: [{ pick: "click", role: "link", name: "Sign in page" }, { type: "done" }],
        2: [{ pick: "fill", role: "textbox", name: "Email", value: "{email}" }, { pick: "fill", role: "textbox", name: "Password", value: "{password}" }, { pick: "click", role: "button", name: "Sign in" }, { type: "done" }],
      },
    );
    const d = dir();
    const { result, save } = await runTest({ goal: "sign in as {email}", url: site.url, dir: d, browser, vars, brain, checkWaitMs: 600 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => s.reason)));
    assert.ok(site.posted.some((p) => p.includes("hunter2-secret")), "the real value was typed");
    site.posted.length = 0;
    const file = join(d, "saved.json");
    writeSaved(file, save!, masker(vars));
    const texts = { result: JSON.stringify(result), saved: readFileSync(file, "utf8"), report: testReportPage(result, { dir: d }), asked: JSON.stringify(brain.seen.map(actQuestion)) };
    for (const [where, text] of Object.entries(texts)) {
      assert.ok(!text.includes("hunter2-secret"), `password in ${where}`);
      assert.ok(!text.includes("tester@fixture.test"), `email in ${where}`);
    }
    assert.ok(result.steps[1]!.actions.some((a) => a.label === "Filling '{password}' into 'Password' textbox"));
    assert.match(texts.saved, /"value": "\{password\}"/);
    // The page showed the email after signing in: the actor saw only its name.
    assert.ok(brain.seen.every((s) => !s.snapshot.includes("tester@fixture.test")));
    // The video and photos are kept, with the cover: the values were typed into boxes drawn as dots. The
    // page's own words echo the email after signing in ("Welcome back, …"), as a header names who is
    // signed in: those show in the video like the page does.
    assert.ok(readdirSync(d).includes("run.webm"));
    assert.match(String(result.videoNote), /show as dots in their boxes/);
  });
});

describe("the parts without a browser", () => {
  it("a plan must end on a real check, and a step without one must be followed by one", () => {
    const none: Check = { kind: "none" };
    const real: Check = { kind: "url_contains", text: "/x" };
    assert.equal(planProblem([step("a", none), step("b", real)]), undefined);
    assert.match(planProblem([step("a", real), step("b", none)])!, /last step/);
    assert.match(planProblem([step("a", none), step("b", none), step("c", real)])!, /step 2 must have one/);
    assert.match(planProblem([])!, /no steps/);
    assert.match(planProblem([step("a", { kind: "nope" } as unknown as Check)])!, /isn't one of/);
  });

  it("numbers only what can be used, finds the open dialog, and masks values", () => {
    const yaml = [
      '- generic [active] [ref=e1]:',
      '  - link "Docs" [ref=e2] [cursor=pointer]:',
      '    - /url: /docs',
      '  - heading "Hi me@x.dev" [level=1] [ref=e3]',
      '  - textbox "Email" [ref=e4]: me@x.dev',
      '  - dialog "Cookies" [ref=e5]:',
      '    - button "Reject all" [ref=e6]',
      '  - paragraph [ref=e7]: Some words',
    ].join("\n");
    const snap = compact(yaml, masker({ email: "me@x.dev" }));
    assert.deepEqual([...snap.refs.keys()], ["e2", "e4", "e6"]);
    assert.equal(snap.dialog, "Cookies");
    assert.match(snap.text, /\[e4\] textbox "Email": \{email\}/);
    assert.ok(!snap.text.includes("me@x.dev"));
    assert.ok(!snap.text.includes("/url"));
    assert.equal(actionProblem({ type: "click", ref: "e3" }, snap)?.includes("e3"), true, "a heading isn't offered");
    assert.equal(actionProblem({ type: "click", ref: "e2" }, snap), undefined);
    assert.match(actionProblem({ type: "hack" }, snap)!, /must be one of/);
  });

  it("reads the AI's answer as one action of the fixed set", () => {
    assert.deepEqual(actionFrom({ action: "click", ref: "e2", value: "", key: "", direction: "", url: "", ms: 0, why: "" }), { type: "click", ref: "e2" });
    assert.deepEqual(actionFrom({ action: "wait", ms: 99999 }), { type: "wait", ms: 5000 });
    assert.deepEqual(actionFrom({ action: "stuck", why: "" }), { type: "stuck", why: "no reason given" });
    assert.equal(actionProblem(actionFrom({ action: "rm -rf" }), { refs: new Map() })?.startsWith("the action must be"), true);
  });

  it("the report has a go-to for each step and nothing it shouldn't run", () => {
    const html = testReportPage(
      { goal: "<script>x</script>", url: "https://a.test/", verdict: "pass", passed: 1, ms: 1000, startedAt: new Date().toISOString(), actions: 1, video: "run.webm", steps: [{ n: 1, title: "Open", intent: "Open it", check: { kind: "none" }, verdict: "passed", actions: [{ label: "Clicking on 'A' link", at: 12.4 }], ms: 900, at: 12 }], friction: [] },
      { dir: "/nowhere" },
    );
    assert.ok(html.includes("Go to 0:12.4") || html.includes("Go to 0:12.0"));
    assert.ok(html.includes('<video id="video" src="run.webm"'));
    assert.ok(!html.includes("<script>x</script>"));
  });
});

// ---------------------------------------------------------------------------------------------
// What review runs found.

const at = (path: string) => new URL(path, site.url).href;

describe("the plan is the goal's", () => {
  it("refuses a plan that quietly does less than the goal, so it can't pass in its place", () => {
    const softened = [
      step("Open the invoice", { kind: "text_visible", text: "Invoice" }),
      { title: "Find the Send control", intent: "Locate the Send invoice button without clicking it", check: { kind: "element_visible", role: "button", name: "Send invoice" } } as PlannedStep,
    ];
    assert.match(planProblem(softened, "send this invoice to the client and check its status shows Sent")!, /does less than the goal/);
    // Dropping the step outright doesn't get past either: the goal asks for something that may be refused.
    assert.match(planProblem([step("Check the status", { kind: "text_visible", text: "Sent" })], "send this invoice to the client and check its status shows Sent")!, /keep that step/);
    // Planned as the goal says it, it's usable: the browser stops it.
    assert.equal(planProblem([{ title: "Send the invoice", intent: "Press the Send invoice button", check: { kind: "text_visible", text: "Sent" } }], "send this invoice"), undefined);
  });

  it("refuses checks that prove nothing: an element with no name, no check on a step that fills in", () => {
    assert.match(planProblem([step("See a box", { kind: "element_visible", role: "textbox", name: "" })])!, /needs the element's name/);
    assert.match(planProblem([{ title: "Fill in the invoice", intent: "Fill in the details", check: { kind: "none" } }, step("See it", { kind: "text_visible", text: "Saved" })])!, /fills in or submits/);
  });

  it("a goal that needs a refused press plans it as it is, and the run ends BLOCKED, never PASS", async () => {
    const brain = scripted([{ title: "Delete the account", intent: "Press Delete account", check: { kind: "text_visible", text: "ACCOUNT DELETED" } }], { 1: [{ pick: "click", role: "button", name: "Delete account" }] });
    const { result, save } = await run({ goal: "delete my account and check it says deleted", url: at("keys"), brain });
    assert.equal(result.verdict, "blocked");
    assert.equal(save, undefined);
    assert.deepEqual(site.posted, []);
  });

  it("the planner sees the page the browser is already on, and the video starts at the first step", async () => {
    const brain = scripted([step("Open the docs", { kind: "url_contains", text: "/docs" })], { 1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }] });
    const { result } = await run({ goal: "open the docs", brain });
    assert.equal(result.verdict, "pass");
    assert.match(brain.start!.snapshot, /heading "Welcome to Fixture Shop"/);
    assert.match(brain.start!.url, /127\.0\.0\.1/);
    assert.ok(result.steps[0]!.at < 3, `step 1 starts ${result.steps[0]!.at}s into the video, not after the planning`);
  });
});

describe("a check that doesn't hold is a FAIL, whatever the AI says", () => {
  it("measures the check when the AI says it's stuck: FAIL with what was expected and found", async () => {
    const brain = scripted([step("See Google", { kind: "text_visible", text: "Welcome to Google" })], { 1: [{ type: "stuck", why: "The page is Fixture Shop" }] });
    const { result } = await run({ goal: "check the page says Welcome to Google", brain });
    assert.equal(result.verdict, "fail");
    const s = result.steps[0]!;
    assert.match(s.evidence!.expected, /Welcome to Google/);
    assert.match(s.evidence!.found, /Fixture Shop/);
    assert.match(s.reason!, /the AI was stuck: The page is Fixture Shop/, "the AI's why is kept, as a note");
  });

  it("keeps the evidence when the AI says done, is told the check didn't hold, then says stuck", async () => {
    const brain = scripted([step("See pricing", { kind: "text_visible", text: "Pricing plans" })], { 1: [{ type: "done" }, { type: "stuck", why: "no pricing here" }] });
    const { result } = await run({ goal: "pricing", brain });
    assert.equal(result.steps[0]!.verdict, "failed");
    assert.ok(result.steps[0]!.evidence);
  });

  it("stops a run of waits on an unchanged page, says nothing changed, and measures", async () => {
    const brain = scripted([step("See it", { kind: "text_visible", text: "Never here" })], { 1: Array.from({ length: 8 }, () => ({ type: "wait", ms: 50 }) as Action) });
    // E5: each wait is the browser watching the page for a change, with no AI (waitfor.ts); kept short here.
    const { result } = await run({ goal: "wait for it", brain, waitMaxMs: 400 });
    assert.equal(result.steps[0]!.verdict, "failed");
    assert.match(result.steps[0]!.reason!, /kept waiting/);
    assert.equal(result.steps[0]!.actions.length, 2, "two waits, then it stopped");
    assert.ok(brain.seen.some((d) => d.history.some((h) => h.endsWith("→ no change on the page"))));
  });

  it("passes a step whose check holds once its action is done, measured, with no 'done' asked (E4)", async () => {
    const brain = scripted([step("Open the docs", { kind: "url_contains", text: "/docs" })], { 1: [{ pick: "click", role: "link", name: "Docs" }, ...Array.from({ length: 6 }, () => ({ type: "wait", ms: 50 }) as Action)] });
    const { result } = await run({ goal: "open the docs", brain });
    assert.equal(result.steps[0]!.verdict, "passed");
    assert.equal(result.verdict, "pass");
    // The kept-waiting path, for a check that holds late, is in speed.test.ts.
    assert.deepEqual(result.steps[0]!.actions.map((a) => a.label), ["Clicking on 'Docs' link"]);
    assert.equal(brain.asks, 2, "the plan and the click");
  });

  it("flags a check that already held before the step", async () => {
    const brain = scripted([step("Say hello", { kind: "text_visible", text: "Say hello" })], { 1: [{ pick: "click", role: "button", name: "Say hello" }, { type: "done" }] });
    const { result } = await run({ goal: "say hello", url: at("keys"), brain });
    assert.equal(result.verdict, "pass");
    assert.match(result.steps[0]!.weak!, /already held before the step/);
  });
});

describe("the actor sees what the browser would say", () => {
  it("marks required fields left empty, and says when a form wasn't sent", async () => {
    const brain = scripted([step("Save a client", { kind: "text_visible", text: "Client saved" })], {
      1: [{ pick: "fill", role: "textbox", name: "Name", value: "Acme" }, { pick: "click", role: "button", name: "Save client" }, { type: "stuck", why: "it won't save" }],
    });
    const { result } = await run({ goal: "save a client", url: at("required"), brain });
    assert.match(brain.seen[0]!.snapshot, /textbox "Email" \[required, empty\]/);
    assert.match(brain.seen[0]!.snapshot, /can't be sent until these are right: .*Email/);
    assert.match(brain.seen[2]!.history.at(-1)!, /Clicking on 'Save client' button: the form wasn't sent: Email/);
    assert.equal(result.steps[0]!.verdict, "failed");
    assert.deepEqual(site.posted, [], "the browser didn't send it");
  });
});

describe("keys press what has focus, and it is read first", () => {
  const press = (keys: string[]) => keys.map((key) => ({ type: "press", key }) as Action);

  for (const key of ["Enter", "Space"]) {
    it(`Tab then ${key} on 'Delete account' is blocked, and nothing is sent`, async () => {
      const brain = scripted([step("Say hello", { kind: "text_visible", text: "Hello there" })], { 1: press(["Tab", "Tab", key]) });
      const { result } = await run({ goal: "say hello", url: at("keys"), brain });
      assert.equal(result.verdict, "blocked");
      assert.match(result.steps[0]!.reason!, /"Delete account" wasn't pressed/);
      assert.deepEqual(site.posted, []);
    });
  }

  it("Enter on a focused Delete button inside a form is read as that button, not the form's Save", async () => {
    const brain = scripted([step("Save", { kind: "text_visible", text: "Saved" })], { 1: press(["Tab", "Tab", "Tab", "Enter"]) });
    const { result } = await run({ goal: "save", url: at("keys-form"), brain });
    assert.equal(result.verdict, "blocked");
    assert.match(result.steps[0]!.reason!, /Delete account/);
    assert.deepEqual(site.posted, []);
  });

  it("Enter in a field whose form's only button is an image 'Send' is blocked", async () => {
    const brain = scripted([step("Write", { kind: "text_visible", text: "Sent" })], { 1: [{ pick: "fill", role: "textbox", name: "Message", value: "hi" }, { type: "press", key: "Enter" }] });
    const { result } = await run({ goal: "write hi", url: at("image-form"), brain });
    assert.equal(result.verdict, "blocked");
    assert.match(result.steps[0]!.reason!, /Enter would submit a form whose button is "Send"/);
    assert.deepEqual(site.posted, []);
  });

  it("a blocked action is listed as stopped, not as done", async () => {
    const brain = scripted([step("Press it", { kind: "text_visible", text: "x" })], { 1: [{ pick: "click", role: "button", name: "Delete account" }] });
    const { result } = await run({ goal: "press", url: at("keys"), brain });
    const sub = result.steps[0]!.actions[0]!;
    assert.equal(sub.label, "Stopped before clicking on 'Delete account' button");
    assert.equal(sub.blocked, true);
    assert.match(testReportPage(result, { dir: "/nowhere" }), /class="stopped">Stopped before clicking/);
  });

  it("'OK' in a dialog that reads like deleting is not pressed", async () => {
    const brain = scripted([step("Clear the list", { kind: "text_visible", text: "Cleared" })], { 1: [{ pick: "click", role: "button", name: "Clear list" }, { pick: "click", role: "button", name: "OK" }] });
    const { result } = await run({ goal: "clear the list", url: at("confirm"), brain });
    assert.equal(result.verdict, "blocked");
    assert.match(result.steps[0]!.reason!, /says yes to a dialog/);
    assert.deepEqual(site.posted, []);
  });
});

describe("replaying an element with no name", () => {
  it("finds the nth element with no name, never the nth of its role ('Delete account')", async () => {
    const saved: SavedTest = { version: 1, goal: "press the icon", url: at("icons"), savedAt: "", steps: [{ title: "Press the icon", intent: "Press the icon button", check: { kind: "text_visible", text: "Icon pressed" }, actions: [{ type: "click", target: { role: "button", name: "", nth: 0 } }] }] };
    const { result } = await run({ goal: saved.goal, url: saved.url, saved });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    assert.deepEqual(site.posted, []);
  });
});

describe("the check is the site's doing", () => {
  it("words typed into an editable box don't count as on the page", async () => {
    const brain = scripted([step("Confirm the order", { kind: "text_visible", text: "Order confirmed" })], {
      1: [{ pick: "fill", role: "textbox", name: "Comment", value: "Order confirmed" }, { type: "done" }, { type: "done" }],
    });
    const { result } = await run({ goal: "the order says Order confirmed", url: at("comment"), brain });
    assert.equal(result.verdict, "fail");
  });

  it("an address the test typed itself is flagged", async () => {
    const brain = scripted([step("See success", { kind: "url_contains", text: "success" })], { 1: [{ type: "navigate", url: "/nothing?success" }, { type: "done" }] });
    const { result } = await run({ goal: "success", brain });
    assert.match(result.steps[0]!.weak ?? "", /typed its check's words itself/);
  });
});

describe("other sites", () => {
  it("a popup to another site sends nothing before it is closed, and the step is blocked", async () => {
    site.otherHits.length = 0;
    const brain = scripted([step("Open the partner", { kind: "text_visible", text: "Partner page" })], { 1: [{ pick: "click", role: "button", name: "Open partner" }, { type: "done" }] });
    const { result } = await run({ goal: "open the partner", url: at("popup"), brain });
    assert.equal(result.verdict, "blocked");
    assert.match(result.steps[0]!.reason!, /new tab.*--allow-host localhost to allow it/);
    await new Promise((done) => setTimeout(done, 300));
    assert.deepEqual(site.otherHits, [], "the other site got nothing");
  });

  it("an off-site link says how to allow it", async () => {
    const brain = scripted([step("Go elsewhere", { kind: "url_contains", text: "other" })], { 1: [{ pick: "click", role: "link", name: "Elsewhere" }] });
    const { result } = await run({ goal: "go elsewhere", brain });
    assert.match(result.steps[0]!.reason!, /add --allow-host other\.example to allow it/);
  });

  it("each name on a shared host is its own site", () => {
    assert.equal(onSite("https://evil.vercel.app/", "https://myapp.vercel.app/"), false);
    assert.equal(onSite("https://bob.github.io/", "https://alice.github.io/"), false);
    assert.equal(onSite("https://docs.myapp.vercel.app/", "https://myapp.vercel.app/"), true);
    assert.equal(siteOf("x.bucket.s3.amazonaws.com"), "bucket.s3.amazonaws.com");
    assert.equal(siteOf("www.example.com"), "example.com");
  });

  it("a site that isn't there can't be run, said in plain words", async () => {
    // A port nothing listens on: one just closed.
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    await assert.rejects(run({ goal: "open", url: `http://127.0.0.1:${port}/`, brain: scripted([], {}) }), (e: unknown) => {
      assert.ok(e instanceof CouldNotRun, String(e));
      assert.match(e.message, new RegExp(`nothing is answering at 127\\.0\\.0\\.1:${port}: is the app running\\?`));
      return true;
    });
    assert.equal(openError("x.test", new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at http://x.test/")), "x.test wasn't found: check the address");
  });
});

describe("the deny list", () => {
  it("refuses the many ways of saying pay, send, publish, delete or cancel", () => {
    for (const name of ["Remove", "Trash", "Empty trash", "Discard", "Post", "Reply", "Publish", "Share", "Submit review", "Yes, I'm sure", "Book now", "Reserve", "Transfer", "Withdraw", "Add funds", "Place bid", "Pledge", "Tip", "PayPal", "Google Pay", "Cancel subscription", "Cancel my account", "Unsubscribe", "Revoke", "Leave team", "Sending", "Deleting", "Send invoice"]) assert.ok(refusedName(name), name);
    for (const name of ["Payments", "Posts", "Shared with me", "Subscriptions", "Submit", "Confirm", "OK", "Search", "Sender settings", "Docs", "Reports"]) assert.equal(refusedName(name), undefined, name);
  });
});

describe("--var values, when a check fails", () => {
  it("never reach the reason, the evidence or any question to the AI", async () => {
    const vars = { email: "secret.person@corp.example" };
    const brain = scripted([step("See me", { kind: "text_visible", text: "{email}" })], { 1: [{ type: "done" }, { type: "done" }] });
    const { result } = await run({ goal: "the page shows {email}", vars, brain });
    assert.equal(result.verdict, "fail");
    for (const [where, text] of Object.entries({ result: JSON.stringify(result), asked: JSON.stringify(brain.seen), questions: JSON.stringify(brain.seen.map(actQuestion)) })) {
      assert.ok(!text.includes("secret.person@corp.example"), `the value is in ${where}`);
    }
    assert.match(result.steps[0]!.reason!, /\{email\}/);
  });
});

describe("what a run leaves behind", () => {
  it("a photo the same as the last step's is kept once, and the report says so", async () => {
    const brain = scripted([step("Say hello", { kind: "text_visible", text: "Hello there" }), step("Look again", { kind: "text_visible", text: "Hello there" })], { 1: [{ pick: "click", role: "button", name: "Say hello" }, { type: "done" }], 2: [{ type: "done" }] });
    const d = dir();
    const { result } = await runTest({ goal: "hello", url: at("keys"), dir: d, browser, checkWaitMs: 600, brain });
    assert.equal(result.verdict, "pass");
    assert.equal(result.steps[1]!.sameShotAs, 1);
    assert.equal(result.steps[1]!.screenshot, "step-1.jpg");
    assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".jpg")), ["step-1.jpg"]);
    const html = testReportPage(result, { dir: d });
    assert.match(html, /looked the same as at the end of step 1/);
    assert.match(html, /poster="step-1\.jpg"/);
    assert.ok(!html.includes("base64"), "photos are beside the page, not inside it too");
  });

  it("slugs end on a word, saved tests are kept per host and found by the start of their name", () => {
    assert.equal(slugOf("check the page says example domain and has a more information link"), "check-the-page-says-example-domain-and");
    const tests = join(dir(), "tests");
    const a = savedPathFor(tests, "open the docs", "https://staging.example.com/");
    const b = savedPathFor(tests, "open the docs", "http://localhost:3000/");
    assert.notEqual(a, b);
    assert.match(b, /localhost-3000/);
    for (const f of [a, b]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "{}");
    }
    assert.equal(findSaved(tests, "open-the").length, 2);
    assert.deepEqual(findSaved(tests, "nothing"), []);
    assert.equal(clip("the AI was stuck: the current page is example domain at https://example.com", 40), "the AI was stuck: the current page is…");
  });

  it("in a pipe, each step is one line as it ends, with what it did under it", () => {
    let text = "";
    const out = { write: (s: string) => ((text += s), true), columns: 80, isTTY: false } as unknown as NodeJS.WriteStream;
    const list = new Checklist(out, colors(false), false);
    list.start("Opening the site");
    const events: TestEvent[] = [
      { type: "phase", words: "Opening the site" },
      { type: "phase", words: "Planning the steps" },
      { type: "planned", steps: [step("Open the docs", { kind: "none" })], replay: false },
      { type: "step", n: 1 },
      { type: "action", n: 1, action: { label: "Clicking on 'Docs' link", at: 1 } },
      { type: "stepEnd", step: { n: 1, title: "Open the docs", intent: "", check: { kind: "none" }, verdict: "passed", actions: [], ms: 1200, at: 0 } },
    ];
    for (const e of events) list.event(e);
    assert.equal(text.match(/Opening the site/g)?.length, 1);
    assert.ok(!text.includes("›"));
    assert.match(text, /✓ 1 +Open the docs +1\.2s\n +Clicking on 'Docs' link\n/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("made-up values for what the goal didn't give", () => {
  const field = (over: Partial<FieldFacts>): FieldFacts => ({ tag: "input", type: "text", hint: "", label: "", placeholder: "", autocomplete: "", inputMode: "", required: true, value: "", pattern: "", min: "", max: "", step: "", minLength: -1, maxLength: -1, ...over });
  const value = (over: Partial<FieldFacts>) => {
    const made = madeUpValue(field(over), new Date("2026-11-16"));
    return "value" in made ? made.value : `CANNOT ${made.varName}`;
  };

  it("are plainly fake, fit the field, and are never a password, a card or an ID", () => {
    assert.equal(value({ type: "email", hint: "client_email email" }), "test+cm@example.com");
    assert.equal(value({ hint: "address billing address" }), "1 Test Street");
    assert.equal(value({ hint: "vat vat number" }), "TEST-001");
    assert.equal(value({ hint: "reg_no reg. no." }), "TEST-001");
    assert.equal(value({ hint: "name name" }), "Test Client");
    assert.equal(value({ hint: "company" }), "Test Company Ltd");
    assert.equal(value({ hint: "code", pattern: "[A-Z]{3}-\\d{2}" }), "AAA-11");
    assert.equal(value({ type: "number", hint: "amount", min: "5" }), "5");
    assert.equal(value({ tag: "select", type: "", hint: "client", options: [["acme", "Acme Ltd"], ["globex", "Globex"]] }), "Acme Ltd");
    assert.equal(value({ hint: "name", maxLength: 4 }), "Test");
    for (const over of [{ type: "password", hint: "pw" }, { hint: "password" }, { hint: "card number" }, { hint: "cvc" }, { hint: "account number" }, { hint: "iban" }, { hint: "one-time code" }, { hint: "passport number" }, { autocomplete: "one-time-code", hint: "x" }]) {
      assert.match(value(over), /^CANNOT /, JSON.stringify(over));
    }
    assert.equal(value({ type: "password", hint: "pw" }), "CANNOT password");
    assert.match(varHint(["password", "password"]), /^pass --var password=… and say \{password\}/);
  });

  it("the actor may say auto: the browser fills a fitting fake value, labels it made-up, and saves it as it was typed", async () => {
    const brain = scripted([step("Save a client called Acme", { kind: "text_visible", text: "Client saved" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Name", value: "Acme" },
        { pick: "fill", role: "textbox", name: "Email", value: "auto" },
        { pick: "fill", role: "textbox", name: "Billing address", value: "auto" },
        { pick: "fill", role: "textbox", name: "VAT number", value: "auto" },
        { pick: "fill", role: "combobox", name: "Country", value: "auto" },
        { pick: "click", role: "button", name: "Save client" },
        { type: "done" },
      ],
    });
    const { result, save } = await run({ goal: "save a client called Acme", url: at("new-client"), brain });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    const labels = result.steps[0]!.actions.map((a) => a.label);
    assert.ok(labels.includes("Filling made-up 'test+cm@example.com' into 'Email' textbox"), labels.join("\n"));
    assert.ok(labels.includes("Filling made-up '1 Test Street' into 'Billing address' textbox"));
    assert.ok(labels.includes("Selecting made-up 'United Kingdom' in 'Country' combobox"));
    assert.match(site.posted.join(), /client_email=test%2Bcm%40example.com&address=1\+Test\+Street&vat=TEST-001&country=United\+Kingdom/);
    // Saved as typed: a replay types the same values with no AI.
    assert.deepEqual(save!.steps[0]!.actions![1], { type: "fill", target: { role: "textbox", name: "Email", nth: 0, of: 1 }, value: "test+cm@example.com", madeUp: true });
    const file = join(dir(), "t.json");
    writeSaved(file, save!);
    assert.equal((readSaved(file).steps[0]!.actions![1] as { madeUp?: true }).madeUp, true);
    // And a replay types the same, with no AI, still saying it was made up.
    const replay = await run({ goal: "save a client called Acme", url: at("new-client"), saved: readSaved(file) });
    assert.equal(replay.result.verdict, "pass");
    assert.ok(replay.result.steps[0]!.actions.some((a) => a.label === "Filling made-up 'test+cm@example.com' into 'Email' textbox" && a.cached));
  });

  it("knows a value the person said, whole, whatever its case or spacing", () => {
    const goal = "Create an invoice for  Acme Ltd and check it says £100.00";
    assert.equal(saidBy("acme ltd", goal), true);
    assert.equal(saidBy("Acme", goal), true);
    assert.equal(saidBy("100.00", goal), true);
    assert.equal(saidBy("", goal), true, "an empty value types nothing");
    assert.equal(saidBy("Acme Test Client", goal), false);
    assert.equal(saidBy("Ac", goal), false, "not inside a longer word");
    assert.equal(saidBy("10", goal), false, "not inside a longer number");
    assert.equal(saidBy("Lee Test Client", goal), false);
  });

  it("a value the AI put in the plan, from neither the goal nor a --var, is labelled made-up too, and saved so", async () => {
    // The planner wrote the values into the step: the actor types them as given, and they're still made up.
    const brain = scripted([step("Save a client called Test Client with email test@example.com", { kind: "text_visible", text: "Client saved" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Name", value: "Test Client" },
        { pick: "fill", role: "textbox", name: "Email", value: "test@example.com" },
        { pick: "fill", role: "textbox", name: "Billing address", value: "auto" },
        { pick: "fill", role: "textbox", name: "VAT number", value: "auto" },
        { pick: "fill", role: "combobox", name: "Country", value: "auto" },
        { pick: "click", role: "button", name: "Save client" },
        { type: "done" },
      ],
    });
    const { result, save } = await run({ goal: "save a new client", url: at("new-client"), brain });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    const labels = result.steps[0]!.actions.map((a) => a.label);
    assert.ok(labels.includes("Filling made-up 'Test Client' into 'Name' textbox"), labels.join("\n"));
    assert.ok(labels.includes("Filling made-up 'test@example.com' into 'Email' textbox"), labels.join("\n"));
    assert.deepEqual(save!.steps[0]!.actions![0], { type: "fill", target: { role: "textbox", name: "Name", nth: 0, of: 1 }, value: "Test Client", madeUp: true });
    // A value the goal gives, or a --var, is not made up.
    const given = scripted([step("Save a client called Acme", { kind: "text_visible", text: "Client saved" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Name", value: "Acme" },
        { pick: "fill", role: "textbox", name: "Email", value: "{email}" },
        { pick: "fill", role: "textbox", name: "Billing address", value: "1 Test Street" },
        { pick: "fill", role: "textbox", name: "VAT number", value: "VAT-1" },
        { pick: "select", role: "combobox", name: "Country", value: "United Kingdom" },
        { pick: "click", role: "button", name: "Save client" },
        { type: "done" },
      ],
    });
    const second = await run({ goal: "save a client called Acme at 1 Test Street, VAT number VAT-1, email {email}", url: at("new-client"), brain: given, vars: { email: "someone@example.com" } });
    const said = second.result.steps[0]!.actions.map((a) => a.label);
    assert.ok(said.includes("Filling 'Acme' into 'Name' textbox"), said.join("\n"));
    assert.ok(said.includes("Filling '1 Test Street' into 'Billing address' textbox"), said.join("\n"));
    assert.ok(said.includes("Filling 'VAT-1' into 'VAT number' textbox"), said.join("\n"));
    assert.ok(said.some((l) => /^Filling '.*' into 'Email' textbox$/.test(l) && !l.includes("someone@")), said.join("\n"));
  });

  it("when the AI is stuck on missing values, the required empty fields get made-up values once, and it goes on", async () => {
    const brain = scripted([step("Save a client called Acme", { kind: "text_visible", text: "Client saved" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Name", value: "Acme" },
        { type: "stuck", why: "the goal doesn't give an email, billing address or VAT number, which are required" },
        { pick: "click", role: "button", name: "Save client" },
        { type: "done" },
      ],
    });
    const { result } = await run({ goal: "save a client called Acme", url: at("new-client"), brain });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    assert.match(brain.seen[2]!.problem!, /filled the required empty fields with made-up test values/);
    assert.ok(!result.steps[0]!.actions.some((a) => /Name/.test(a.label) && /made-up/.test(a.label)), "a field already filled is left as it is");
    assert.match(site.posted.join(), /name=Acme&client_email=test%2Bcm%40example.com/);
  });

  it("never makes up a password: the step says which --var to pass, and nothing is sent", async () => {
    const brain = scripted([step("Join with an email", { kind: "text_visible", text: "Client saved" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Password", value: "auto" },
        { type: "stuck", why: "the password is required and not given" },
      ],
    });
    const { result } = await run({ goal: "join", url: at("join"), brain });
    const s = result.steps[0]!;
    assert.notEqual(s.verdict, "passed");
    // Next to a password, the email is the real one it signs in with: not made up either.
    assert.deepEqual(s.needs, ["password", "email"]);
    assert.match(s.reason!, /--var password=… .*and say \{password\}/);
    assert.match(s.actions[0]!.error!, /needs a password, which is only typed from --var password/);
    assert.ok(!s.actions.some((a) => /Password/.test(a.label) && !a.error), "no password was typed");
    assert.deepEqual(site.posted, []);
    assert.match(stepNotes(s, colors(false)).join("\n"), /needs: --var password=…/);
  });

  it("a sign-in with no account to sign in as ends BLOCKED AUTH_ACCOUNT_NEEDED with the fix, never FAIL", async () => {
    const brain = scripted([{ ...step("Sign in with email", { kind: "text_visible", text: "Client saved" }), intent: "Fill the Email and Password fields with test values and press Sign in" }], {
      1: [
        { pick: "fill", role: "textbox", name: "Password", value: "auto" },
        { type: "stuck", why: "the sign-in needs a real account, which I must not make up" },
      ],
    });
    const { result } = await run({ goal: "Sign in and check the Brief page loads", url: at("join"), brain });
    const s = result.steps[0]!;
    assert.equal(s.verdict, "blocked", s.reason ?? "");
    assert.equal(result.verdict, "blocked");
    assert.equal(result.code, "AUTH_ACCOUNT_NEEDED");
    assert.match(s.reason!, /^AUTH_ACCOUNT_NEEDED: /);
    assert.match(s.reason!, /Add an account under Accounts and confirm it's your own account on /);
    assert.doesNotMatch(s.reason!, /typed nothing/, "it may have typed a made-up email first");
    assert.match(s.reason!, /--var password=…/);
    assert.equal(s.blockedGroup, "credentials");
    assert.deepEqual(site.posted, []);
  });

  it("a value it won't make up that isn't a sign-in (a message) ends BLOCKED VALUE_NEEDED", async () => {
    const brain = scripted([step("Send a message", { kind: "text_visible", text: "Thanks" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Your message", value: "auto" },
        { type: "stuck", why: "the message is required and wasn't given" },
      ],
    });
    const { result } = await run({ goal: "send a message", url: at("contact"), brain });
    const s = result.steps[0]!;
    assert.ok(s.needs?.includes("message"), JSON.stringify(s));
    assert.equal(s.verdict, "blocked", s.reason ?? "");
    assert.equal(result.code, "VALUE_NEEDED");
    assert.match(s.reason!, /^VALUE_NEEDED: .*--var message=…/);
    assert.deepEqual(site.posted, []);
  });

  it("a value it wouldn't make up that it went on past isn't why the step failed: not BLOCKED (review 5)", async () => {
    const brain = scripted([step("Fill in the name", { kind: "text_visible", text: "Thanks" })], {
      1: [
        { pick: "fill", role: "textbox", name: "Your message", value: "auto" },
        { pick: "fill", role: "textbox", name: "Name", value: "Acme" },
        { type: "stuck", why: "the thanks page never showed" },
      ],
    });
    const { result } = await run({ goal: "fill in the name", url: at("contact"), brain });
    const s = result.steps[0]!;
    assert.ok(s.needs?.includes("message"), JSON.stringify(s));
    assert.notEqual(s.verdict, "blocked", s.reason ?? "");
    assert.notEqual(result.code, "VALUE_NEEDED");
    assert.doesNotMatch(s.reason ?? "", /^VALUE_NEEDED/);
  });

  it("a sign-in run that had an account is never told to add one (review 6)", async () => {
    const secrets = { names: () => ["sam.username", "sam.password"], has: () => true, get: () => undefined, peek: () => undefined, fresh: () => undefined };
    const brain = scripted([{ ...step("Sign in with email", { kind: "text_visible", text: "Client saved" }), intent: "Fill the Email and Password fields and press Sign in" }], {
      1: [
        { pick: "fill", role: "textbox", name: "Password", value: "auto" },
        { type: "stuck", why: "the sign-in didn't take" },
      ],
    });
    const { result } = await run({ goal: "Sign in and check the Brief page loads", url: at("join"), brain, secrets: secrets as never });
    const s = result.steps[0]!;
    assert.notEqual(result.code, "AUTH_ACCOUNT_NEEDED", s.reason ?? "");
    assert.doesNotMatch(s.reason ?? "", /AUTH_ACCOUNT_NEEDED|no account was given/);
    assert.deepEqual(site.posted, []);
  });
});

describe("the AI starts with nothing of the person's", () => {
  it("Claude Code runs with no tools, settings, CLAUDE.md, memory, skills or servers, from an empty folder", () => {
    const args = claudeAskArgs({ text: "sys" }, { type: "object" });
    for (const [flag, value] of [["--tools", ""], ["--setting-sources", ""], ["--system-prompt", "sys"]] as const) assert.equal(args[args.indexOf(flag) + 1], value, flag);
    for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "-p"]) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes("--append-system-prompt"), "its own system prompt replaces the default, which holds the project's details");
    const env = claudeAskEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", GITHUB_TOKEN: "t", CLAUDE_CODE_SAFE_MODE: "0", GIT_AUTHOR_NAME: "Someone" });
    assert.deepEqual(CLAUDE_QUIET_ENV, { CLAUDE_CODE_SAFE_MODE: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    for (const [k, v] of Object.entries(CLAUDE_QUIET_ENV)) assert.equal(env[k], v, k);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });

  it("Codex reads no AGENTS.md, memories or tools of theirs", () => {
    const c = CODEX_QUIET.filter((_, i) => i % 2 === 1);
    for (const want of ["project_doc_max_bytes=0", "web_search=\"disabled\"", "features.memories=false", "features.shell_tool=false"]) assert.ok(c.includes(want), want);
  });

  it("the planner and the actor are told to make up only plainly generic test names", () => {
    assert.ok(PLAN_SYSTEM.includes(GENERIC_NAMES) && ACT_SYSTEM.includes(GENERIC_NAMES));
    assert.match(GENERIC_NAMES, /never a real person's name.*whoever runs this test/);
    assert.match(ACT_SYSTEM, /value "auto"/);
  });
});

// ---------------------------------------------------------------------------------------------
// The command, as a person runs it: a child process, against the fixture site, with no AI.

const CLI = join(import.meta.dirname, "contextmachines.ts");

/** Runs `contextmachines test …` in a child (the fixture site is served from this process, so never sync). */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const { CI: _ci, ANTHROPIC_API_KEY: _key, ...rest } = process.env;
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("CM_VAR_")));
    const child = spawn(process.execPath, [CLI, "test", ...args], { env: { ...clean, NO_COLOR: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** A saved test of one step on the fixture site. */
const savedTest = (goal: string, path: string, check: Check, actions: SavedTest["steps"][number]["actions"]): Omit<SavedTest, "version" | "savedAt"> => ({ goal, url: at(path), steps: [{ title: goal, intent: goal, check, actions }] });

/** Every file under a folder, as text: to look for what must never be written. */
function allText(root: string): string {
  let text = "";
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && !/\.(webm|jpg)$/.test(entry.name)) text += `${p}\n${readFileSync(p, "utf8")}\n`;
    }
  };
  walk(root);
  return text;
}

describe("the suite: every saved test, replayed", () => {
  it("runs each one with no AI, says each test's steps and the whole suite's line, writes JUnit, and exits 0 only when all passed", async () => {
    const out = join(dir(), "cm");
    const tests = join(out, "tests", hostSlug(site.url));
    writeSaved(join(tests, "open-the-docs.json"), savedTest("open the docs", "", { kind: "url_contains", text: "/docs" }, [{ type: "click", target: { role: "link", name: "Docs", nth: 0 } }]));
    writeSaved(join(tests, "docs-show-pricing.json"), savedTest("docs show pricing", "", { kind: "text_visible", text: "Pricing plans" }, [{ type: "click", target: { role: "link", name: "Docs", nth: 0 } }]));
    writeSaved(join(tests, "search-renamed.json"), savedTest("search for locator", "", { kind: "text_visible", text: "Results for" }, [{ type: "click", target: { role: "button", name: "Search now", nth: 0 } }]));
    assert.deepEqual(listSaved(join(out, "tests")).map((f) => basename(f)), ["docs-show-pricing.json", "open-the-docs.json", "search-renamed.json"]);
    const junit = join(out, "junit.xml");
    const ran = await cli(["--out", out, "--ai", "none", "--junit", junit, "--json", "--minutes", "1"]);
    assert.equal(ran.code, 1, ran.stderr);
    const said = JSON.parse(ran.stdout);
    assert.deepEqual(said.summary, { tests: 3, passed: 1, failed: 1, notSure: 1, blocked: 0, couldNot: 0, healed: 0, weak: 0 });
    assert.match(ran.stderr, /Tests {2}1 passed · 1 failed · 1 not sure/);
    // Each test's checklist, one line a step, and why the one that needs healing couldn't be.
    assert.match(ran.stderr, /open-the-docs[^\n]*\n {4}✓ 1 +open the docs/);
    assert.match(ran.stderr, /no AI to find another way/);
    // Nothing was healed with no AI: nothing says it was, and the file is as it was.
    assert.doesNotMatch(ran.stderr, /healed|saved test updated|asking the AI/);
    assert.match(ran.stderr, /expected the words "Pricing plans"|Pricing plans/);
    const xml = readFileSync(junit, "utf8");
    assert.match(xml, /<testsuites name="contextmachines test" tests="3" failures="1" errors="1"/);
    assert.match(xml, /<testcase name="open-the-docs" classname="127\.0\.0\.1-\d+" time="[\d.]+">\n {4}<system-out>/);
    assert.match(xml, /<testcase name="docs-show-pricing"[^>]*>\n {4}<failure type="fail" message="step 1/);
    assert.match(xml, /<testcase name="search-renamed"[^>]*>\n {4}<error type="not_sure"/);
    // Each run kept its own report.
    assert.ok(said.tests.every((t: { report?: string }) => t.report && existsSync(resolve(t.report))));

    // --grep: only those whose name or goal has the words. All passed: exit 0.
    const one = await cli(["--out", out, "--ai", "none", "--grep", "open the", "--json"]);
    assert.equal(one.code, 0, one.stderr);
    assert.deepEqual(JSON.parse(one.stdout).tests.map((t: { name: string }) => t.name), ["open-the-docs"]);
    const none = await cli(["--out", out, "--ai", "none", "--grep", "nothing like this"]);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /No saved test matches/);
  });

  it("--url runs the tests saved for that site; with --junit or --grep it moves only one site's tests, and refuses tests of several", async () => {
    const out = join(dir(), "cm");
    writeSaved(join(out, "tests", hostSlug(site.url), "open-the-docs.json"), savedTest("open the docs", "", { kind: "url_contains", text: "/docs" }, [{ type: "click", target: { role: "link", name: "Docs", nth: 0 } }]));
    writeSaved(join(out, "tests", "en.wikipedia.org", "search.json"), { goal: "search", url: "https://en.wikipedia.org/", steps: [{ title: "Search", intent: "search", check: { kind: "url_contains", text: "/wiki/" }, actions: [{ type: "click", target: { role: "link", name: "Wiki", nth: 0 } }] }] });
    const own = await cli(["--out", out, "--ai", "none", "--url", site.url, "--json"]);
    assert.equal(own.code, 0, own.stderr);
    assert.deepEqual(JSON.parse(own.stdout).tests.map((t: { name: string }) => t.name), ["open-the-docs"]);
    const ran = await cli(["--out", out, "--ai", "none", "--url", site.url, "--junit", join(out, "j.xml")]);
    assert.equal(ran.code, 2, ran.stderr);
    assert.match(ran.stderr, /these are for 2 sites \(127\.0\.0\.1:\d+, en\.wikipedia\.org\): pick one site's with --grep/);
  });

  it("with no saved tests, says where they'd be and exits 2", async () => {
    const ran = await cli(["--out", join(dir(), "cm"), "--ai", "none"]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /There are no saved tests in .*tests yet/);
  });

  it("the suite's words, exit, JUnit escaping, and a test run on another origin", () => {
    assert.equal(suiteSummary({ passed: 5, failed: 1, notSure: 0, blocked: 0, couldNot: 0 }), "5 passed · 1 failed · 0 not sure");
    assert.equal(suiteSummary({ passed: 0, failed: 0, notSure: 0, blocked: 2, couldNot: 1 }), "0 passed · 0 failed · 0 not sure · 2 blocked · 1 couldn't run");
    const r = (verdict: "pass" | "fail" | "not_sure" | "blocked") => ({ name: "t", host: "h", ms: 1, result: { verdict } as never });
    assert.equal(suiteExit([r("pass"), r("pass")]), 0);
    assert.equal(suiteExit([r("pass"), r("not_sure")]), 4);
    assert.equal(suiteExit([r("blocked"), { name: "x", host: "h", ms: 0, couldNot: "down" }]), 3);
    assert.equal(suiteExit([r("not_sure"), r("fail")]), 1);
    const xml = junitXml([{ name: "a<b>&\"c\"", host: "h", ms: 1500, couldNot: "site \u0007down <now>" }], 1500);
    assert.match(xml, /name="a&lt;b&gt;&amp;&quot;c&quot;"/);
    assert.match(xml, /<error type="couldnt_run" message="site down &lt;now&gt;"\/>/);
    assert.ok(!xml.includes("\u0007"));
    assert.equal(onOrigin("http://localhost:3000/invoices/new?x=1", "https://preview-42.example.dev/"), "https://preview-42.example.dev/invoices/new?x=1");
    assert.equal(onOrigin("http://localhost:3000/a", undefined), "http://localhost:3000/a");
  });
});

describe("log in once", () => {
  it("--setup signs in, keeps the session owner-only and git-ignored, never shows a value, and later tests on that host start signed in", async () => {
    const out = join(dir(), "cm");
    const host = hostSlug(site.url);
    // The sign-in's steps, kept from an earlier --setup: it replays with no AI.
    const setupFile = join(out, ".auth", `${host}.setup.json`);
    const goal = "log in with {email} and {password}";
    writeSaved(setupFile, savedTest(goal, "login", { kind: "text_visible", text: "Welcome back" }, [
      { type: "fill", target: { role: "textbox", name: "Email", nth: 0 }, value: "{email}" },
      { type: "fill", target: { role: "textbox", name: "Password", nth: 0 }, value: "{password}" },
      { type: "click", target: { role: "button", name: "Sign in", nth: 0 } },
    ]));
    // The password from the environment, the email from --var.
    const ran = await cli(["--setup", goal, "--url", at("login"), "--out", out, "--ai", "none", "--var", "email=tester@fixture.test"], { CM_VAR_PASSWORD: "hunter2-secret" });
    assert.equal(ran.code, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /Signed in +session saved to .*\.auth\/127\.0\.0\.1-\d+\.json \(git-ignored, only you can read it\)/);
    assert.ok(site.posted.some((p) => p.includes("hunter2-secret")), "the real password was typed");
    const auth = join(out, ".auth", `${host}.json`);
    assert.equal(statSync(auth).mode & 0o777, 0o600);
    assert.match(readFileSync(auth, "utf8"), /fixture-session-cookie/);
    assert.ok(readFileSync(join(out, ".gitignore"), "utf8").split("\n").includes(".auth/"));
    // Never shown or written: not the values, not the session.
    for (const [where, text] of Object.entries({ stdout: ran.stdout, stderr: ran.stderr, files: allText(out).replace(readFileSync(auth, "utf8"), "") })) {
      assert.ok(!text.includes("hunter2-secret"), `password in ${where}`);
      assert.ok(!text.includes("tester@fixture.test"), `email in ${where}`);
      assert.ok(!text.includes("fixture-session-cookie"), `session in ${where}`);
    }
    // A sign-in run keeps its video and photos like any run: its boxes are dots (cover.ts, dots.test.ts).
    const runs = join(out, "runs", slugOf(goal));
    const media = readdirSync(runs, { recursive: true }).map(String).filter((f) => /\.(webm|jpg)$/.test(f));
    assert.ok(media.some((f) => f.endsWith("run.webm")) && media.some((f) => /step-\d+\.jpg$/.test(f)), media.join(","));

    // A saved test on that host now starts signed in; --signed-out starts without.
    writeSaved(join(out, "tests", host, "see-my-account.json"), savedTest("see my account", "account", { kind: "text_visible", text: "Signed in" }, []));
    const signedIn = await cli(["--out", out, "--ai", "none", "--json"]);
    assert.equal(signedIn.code, 0, signedIn.stderr);
    assert.match(signedIn.stderr, /see-my-account · 127\.0\.0\.1:\d+ · signed in/);
    const signedOut = await cli(["--out", out, "--ai", "none", "--signed-out"]);
    assert.equal(signedOut.code, 1, signedOut.stderr);
    // One goal, too.
    const single = await cli(["see-my-account", "--out", out, "--ai", "none"]);
    assert.equal(single.code, 0, single.stderr);
    assert.match(single.stdout, /signed in/);
  });

  it("a value the sign-in names but nobody gave is asked for, never made up", async () => {
    const ran = await cli(["--setup", "log in with {email} and {password}", "--url", at("login"), "--out", join(dir(), "cm"), "--ai", "none", "--var", "email=a@b.test"]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /pass --var password=… \(or CM_VAR_PASSWORD\)/);
    assert.deepEqual(site.posted, []);
  });

  it("values come from --var or CM_VAR_<NAME>; the .gitignore line is added once", () => {
    assert.deepEqual(varsFromEnv({ CM_VAR_PASSWORD: "x", CM_VAR_API_KEY: "y", CM_VAR_EMPTY: "", PASSWORD: "no", CM_VARS: "no" }), { password: "x", api_key: "y" });
    assert.deepEqual(missingVars("log in with {email} and {password}", { email: "e" }), ["password"]);
    assert.deepEqual(varsUsed({ version: 1, goal: "", url: "", savedAt: "", steps: [{ title: "", intent: "", check: { kind: "none" }, actions: [{ type: "fill", target: { role: "textbox", name: "P", nth: 0 }, value: "{password}" }] }] }), ["password"]);
    const out = dir();
    writeFileSync(join(out, ".gitignore"), ".session.json");
    ignoreAuth(out);
    ignoreAuth(out);
    assert.equal(readFileSync(join(out, ".gitignore"), "utf8"), ".session.json\n.auth/\n");
  });
});

describe("where a new user might get stuck", () => {
  it("notes the pop-ups it closed, a control with no name, a validation error and a step of many actions: facts, in the result and the report", async () => {
    const saved: SavedTest = {
      version: 1, goal: "save my details", url: at("friction"), savedAt: "",
      steps: [{
        title: "Save my details", intent: "Fill in the email and save", check: { kind: "text_visible", text: "Details saved" },
        actions: [
          { type: "click", target: { role: "button", name: "Reject all", nth: 0 } },
          { type: "click", target: { role: "button", name: "", nth: 0 } },
          { type: "click", target: { role: "button", name: "Save", nth: 0 } },
          { type: "fill", target: { role: "textbox", name: "Email", nth: 0 }, value: "a@b.test" },
          { type: "click", target: { role: "button", name: "Save", nth: 0 } },
        ],
      }],
    };
    const { result } = await run({ goal: saved.goal, url: saved.url, saved });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    const said = result.friction.map((f) => `${f.kind} ${f.step}: ${f.says}`);
    assert.ok(said.includes("popup 1: Closed a pop-up ('Cookies') with 'Reject all'"), said.join("\n"));
    assert.ok(said.includes("popup 1: The page showed a browser alert box ('Fill in your details'), which was dismissed"), said.join("\n"));
    assert.ok(said.includes("unnamed_control 1: Had to use a button with no accessible name"), said.join("\n"));
    assert.ok(said.includes("validation 1: The page showed an error: Email: Enter an email"), said.join("\n"));
    assert.ok(said.includes("many_actions 1: Took 5 actions"), said.join("\n"));
    const html = testReportPage(result, { dir: "/nowhere" });
    assert.match(html, /<h2>Where a new user might get stuck<\/h2>/);
    assert.match(html, /Closed a pop-up \(&#39;Cookies&#39;\) with &#39;Reject all&#39;/);
    assert.match(junitXml([{ name: "t", host: "h", ms: 1, result }], 1), /where a user might get stuck \(step 1\): Took 5 actions/);
  });

  it("a plain run notes nothing, and the report has no such section", async () => {
    const brain = scripted([step("Open the docs", { kind: "url_contains", text: "/docs" })], { 1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }] });
    const { result } = await run({ goal: "open the docs", brain });
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.friction, []);
    assert.ok(!testReportPage(result, { dir: "/nowhere" }).includes("Where a new user might get stuck"));
  });

  it("counts, second tries and waits are measured; a cookie answer is a pop-up wherever it sits; a value's word is never site text", () => {
    const log = new FrictionLog();
    log.stepEnd(1, { actions: 3, waitedMs: 5000 });
    assert.equal(log.all.length, 0);
    log.stepEnd(2, { actions: 4, retried: "clicking on 'Save' button didn't work the first time", waitedMs: 6200 });
    log.stepEnd(2, { actions: 4, waitedMs: 0 });
    assert.deepEqual(log.all.map((f) => `${f.kind}: ${f.says}`), ["many_actions: Took 4 actions", "retry: Needed a second try: clicking on 'Save' button didn't work the first time", "slow: Waited 6.2s on the page"]);
    assert.ok(closesPopup("Accept all cookies", undefined));
    assert.ok(closesPopup("Reject all", undefined));
    assert.ok(closesPopup("Close", "Newsletter"));
    assert.ok(!closesPopup("Close", undefined), "a Close button outside a dialog closes nothing anyone was stuck on");
    assert.ok(!closesPopup("Save", "Edit client"));
    assert.equal(unnamedControl({ type: "click", target: { role: "button", name: "", nth: 0 } }), "a button");
    assert.equal(unnamedControl({ type: "click", target: { role: "link", name: "Docs", nth: 0 } }), undefined);
    assert.equal(frictionCount(1), "1 place a user might get stuck");
    assert.equal(frictionCount(2), "2 places a user might get stuck");
  });
});

// ---------------------------------------------------------------------------------------------
// learn writes your first tests: a draft for each journey walked to its end.

describe("starter tests from learn's journeys", () => {
  const walked = (over: Partial<WalkedJourney>): WalkedJourney => ({ name: "Open the docs", from: "/", main: false, outcome: "finished", steps: [{ screen: "/", did: "open" }, { screen: "/", did: "press", label: "Docs" }], ends: "/docs", seenWith: "stand-in", ...over });

  it("makes a draft for each finished journey, each step checking the address it reaches, and nothing for the rest", () => {
    const tests = startersFrom([
      walked({}),
      walked({ name: "New client", from: "/clients", steps: [{ screen: "/clients", did: "open" }, { screen: "/clients", did: "press", label: "Change plan", left: true }, { screen: "/clients", did: "press", label: "Add client" }, { screen: "/clients/new", did: "fill", label: "Save client", saved: true }], ends: "/client-saved/:id" }),
      // Its last check would hold on the screen it starts on ("/clients/" is in "/clients/new"): it would prove nothing.
      walked({ name: "New client, back to the list", from: "/clients", steps: [{ screen: "/clients", did: "open" }, { screen: "/clients", did: "press", label: "Add client" }, { screen: "/clients/new", did: "fill", label: "Save client", saved: true }], ends: "/clients/:id" }),
      walked({ name: "Add trade", from: "/trades/new", steps: [{ screen: "/trades/new", did: "open" }, { screen: "/trades/new", did: "fill", label: "Save trade", saved: true }], ends: "/trades" }),
      walked({ name: "Upgrade", outcome: "stopped_here" }),
      walked({ name: "Edit invoice", from: "/invoices/:id" }),
      walked({ name: "Same place again", joins: "Open the docs" }),
      walked({ name: "From the code", fromCode: true }),
      // Its last step stays on the screen: nothing it reaches can be measured.
      walked({ name: "Say hello", ends: "/" }),
      // The same name twice is one test.
      walked({ name: "open the docs!" }),
    ], `${site.url}?from=learn`);
    assert.deepEqual(tests.map((t) => t.goal), ["Open the docs", "New client"]);
    assert.deepEqual(tests[0], { goal: "Open the docs", url: site.url, steps: [{ title: "Click 'Docs'", intent: "Click 'Docs'", check: { kind: "url_contains", text: "/docs" } }], draft: true });
    const client = tests[1]!;
    assert.equal(client.url, at("clients"));
    // The choice it left is no part of the way.
    assert.deepEqual(client.steps.map((s) => s.title), ["Click 'Add client'", "Fill in and send the form ('Save client')"]);
    assert.deepEqual(client.steps.map((s) => s.check), [{ kind: "url_contains", text: "/clients/new" }, { kind: "url_contains", text: "/client-saved/" }]);
    // A form is filled with plainly made-up values, never real ones.
    assert.match(client.steps[1]!.intent, /made-up test values .*"auto"/);
    assert.ok(client.steps.every((s) => !("actions" in s)));
    assert.equal(addressPart("/invoices/:id/edit"), "/invoices/");
    assert.equal(addressPart("/:team"), undefined);
    assert.equal(addressPart("/"), undefined);
  });

  it("writes each under tests/<host>/, never over a file that's there, and reads back as a draft", () => {
    const testsDir = join(dir(), "tests");
    const tests = startersFrom([walked({})], site.url);
    const [file] = writeStarters(testsDir, tests);
    assert.equal(file, savedPathFor(testsDir, "Open the docs", site.url));
    const read = readSaved(file!);
    assert.equal(read.draft, true);
    assert.equal(read.steps[0]!.actions, undefined);
    // A person's own test (or an earlier starter they changed) is never replaced.
    writeFileSync(file!, readFileSync(file!, "utf8").replace("Click 'Docs'", "Open the documentation"));
    assert.deepEqual(writeStarters(testsDir, tests), []);
    assert.match(readFileSync(file!, "utf8"), /Open the documentation/);
  });

  it("only a draft may have a step with nothing to replay, and a draft's last step must measure something", () => {
    const d = dir();
    const write = (name: string, data: unknown) => {
      writeFileSync(join(d, name), JSON.stringify(data));
      return join(d, name);
    };
    const step = { title: "Open the docs", intent: "Click 'Docs'", check: { kind: "url_contains", text: "/docs" } };
    assert.throws(() => readSaved(write("plain.json", { version: 1, goal: "g", url: site.url, steps: [step] })), /has a step that isn't one/);
    assert.throws(() => readSaved(write("weak.json", { version: 1, goal: "g", url: site.url, draft: true, steps: [{ ...step, check: { kind: "none" } }] })), /last step checks nothing/);
    assert.equal(readSaved(write("draft.json", { version: 1, goal: "g", url: site.url, draft: true, steps: [step] })).draft, true);
  });

  it("a draft's first run has the AI do each step, and its pass saves a plain test that replays with no AI", async () => {
    const [draft] = startersFrom([walked({})], site.url);
    const saved = { ...draft!, version: 1 as const, savedAt: "" };
    const brain = scripted([], { 1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }] });
    const { result, save } = await run({ goal: saved.goal, saved, brain });
    assert.equal(result.verdict, "pass");
    assert.equal(brain.asks, 1, "no plan asked for: the draft is the plan (and no 'done': the click made the check hold)");
    assert.ok(save, "the draft's pass is saved");
    assert.deepEqual(save!.steps[0]!.actions, [{ type: "click", target: { role: "link", name: "Docs", nth: 0, of: 1 } }]);
    const file = join(dir(), "t.json");
    writeSaved(file, save!);
    const plain = readSaved(file);
    assert.equal(plain.draft, undefined);
    const again = await run({ goal: plain.goal, saved: plain });
    assert.equal(again.result.verdict, "pass");
    assert.equal(again.save, undefined);
  });

  it("with no AI, a draft's step is not sure, saying how to record it", async () => {
    const [draft] = startersFrom([walked({})], site.url);
    const { result, save } = await run({ goal: draft!.goal, saved: { ...draft!, version: 1, savedAt: "" } });
    assert.equal(result.verdict, "not_sure");
    assert.equal(result.steps[0]!.reason, DRAFT_NO_AI);
    assert.equal(save, undefined);
  });

  it("the suite runs drafts with the rest, says which are drafts, and leaves them drafts when they can't pass", async () => {
    const out = join(dir(), "cm");
    const [file] = writeStarters(join(out, "tests"), startersFrom([walked({})], site.url));
    const before = readFileSync(file!, "utf8");
    const ran = await cli(["--out", out, "--ai", "none", "--json", "--minutes", "1"]);
    assert.equal(ran.code, 4, ran.stderr);
    const said = JSON.parse(ran.stdout);
    assert.equal(said.tests[0].draft, true);
    assert.equal(said.tests[0].verdict, "not_sure");
    assert.match(ran.stderr, /open-the-docs · 127\.0\.0\.1:\d+ · draft/);
    assert.match(ran.stderr, /run the draft once with an AI/);
    assert.match(ran.stderr, /no AI: drafts, and steps that need healing, are not sure/);
    assert.match(ran.stderr, /a draft's first run needs an AI/);
    assert.doesNotMatch(ran.stderr, /replayed, no AI/);
    assert.equal(readFileSync(file!, "utf8"), before);
  });
});

// ---------------------------------------------------------------------------------------------
// What the second trial run found: each with the case that showed it.

describe("a sign-in types only what it was given", () => {
  const vars = { email: "tester@fixture.test", password: "hunter2-secret" };
  const signIn = (email: string) => scripted([step("Sign in", { kind: "password_gone" })], {
    1: [
      { pick: "fill", role: "textbox", name: "Email", value: email },
      { pick: "fill", role: "textbox", name: "Password", value: "{password}" },
      { pick: "click", role: "button", name: "Sign in" },
      { pick: "fill", role: "textbox", name: "Email", value: "{email}" },
      { pick: "fill", role: "textbox", name: "Password", value: "{password}" },
      { pick: "click", role: "button", name: "Sign in" },
      { type: "done" },
    ],
  });

  it("refuses a made-up email next to a password (--setup, a goal with {vars}, or none): the real password never goes with a fake name", async () => {
    for (const o of [{ noMadeUp: true, goal: "sign in" }, { goal: "log in with {email} and {password}" }, { goal: "sign in", vars: { password: vars.password } }]) {
      site.posted.length = 0;
      const { result } = await run({ url: at("strict-login"), vars, brain: signIn("auto"), ...o });
      const s = result.steps[0]!;
      assert.match(s.actions[0]!.error ?? "", /didn't make up a value/, JSON.stringify(o));
      assert.ok(!site.posted.some((p) => p.includes("test%2Bcm")), `a made-up email was sent: ${site.posted.join()} ${JSON.stringify(o)}`);
    }
  });

  it("saves only the try that worked: a send the page answered with its sign-in form again is dropped", async () => {
    const { result, save } = await run({ goal: "log in with {email} and {password}", url: at("strict-login"), vars, brain: signIn("wrong@fixture.test") });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps[0]));
    assert.ok(site.posted.some((p) => p.includes("wrong%40fixture.test")), "the first try was sent");
    const kept = save!.steps[0]!.actions!;
    assert.deepEqual(kept.map((a) => (a.type === "fill" ? a.value : a.type)), ["{email}", "{password}", "click"], JSON.stringify(kept));
    // A search, then another: both sends worked, and both are kept.
    const search = (q: string): CachedActionT => ({ type: "fill", target: { role: "searchbox", name: "Search", nth: 0 }, value: q });
    const go: CachedActionT = { type: "click", target: { role: "button", name: "Go", nth: 0 } };
    assert.equal(withoutFailedTries([search("a"), go, search("b"), go], () => false).length, 4);
    assert.equal(withoutFailedTries([search("a"), go, search("b"), go], (a) => a === go).length, 2);
  });

  it("checks a sign-in is really signed in (C3), unless the goal says what to check; a refused stored password is BLOCKED, never tried again", async () => {
    const planned = [step("Sign in", { kind: "element_visible", role: "button", name: "Sign out" })];
    assert.deepEqual(signInPlan(planned, "log in with {email} and {password}")[0]!.check, { kind: "signed_in" });
    assert.deepEqual(signInPlan(planned, "log in with {email} and {password} and check it says Signed in as")[0]!.check, planned[0]!.check);
    // An account's own check wins, whatever the goal says.
    assert.deepEqual(signInPlan(planned, "log in and check it says Signed in as", { kind: "signed_in", text: "Sign out" })[0]!.check, { kind: "signed_in", text: "Sign out" });
    const once = scripted([step("Sign in", { kind: "password_gone" })], { 1: [{ pick: "fill", role: "textbox", name: "Email", value: "{email}" }, { pick: "fill", role: "textbox", name: "Password", value: "{password}" }, { pick: "click", role: "button", name: "Sign in" }, { type: "done" }] });
    const ok = await run({ goal: "log in with {email} and {password}", url: at("strict-login"), vars, noMadeUp: true, brain: once });
    assert.equal(ok.result.verdict, "pass", JSON.stringify(ok.result.steps[0]));
    const bad = await run({ goal: "log in with {email} and {password}", url: at("strict-login"), vars: { ...vars, email: "nobody@fixture.test" }, noMadeUp: true, brain: scripted([step("Sign in", { kind: "password_gone" })], { 1: [{ pick: "fill", role: "textbox", name: "Email", value: "{email}" }, { pick: "fill", role: "textbox", name: "Password", value: "{password}" }, { pick: "click", role: "button", name: "Sign in" }, { type: "done" }, { type: "done" }] }) });
    // The stored values were refused ("Wrong email or password"): BLOCKED with its code, after one submit, never a second.
    assert.equal(bad.result.verdict, "blocked", JSON.stringify(bad.result.steps[0]));
    assert.equal(bad.result.code, "AUTH_CREDENTIAL_INVALID");
    assert.match(bad.result.steps[0]!.reason!, /AUTH_CREDENTIAL_INVALID/);
    assert.equal(bad.result.steps[0]!.actions.filter((a) => /Sign in/.test(a.label)).length, 1);
  });

  it("a missing session says to sign in again with --setup, not to pass a password", async () => {
    const brain = scripted([step("Join", { kind: "text_visible", text: "Client saved" })], { 1: [{ type: "stuck", why: "the password is required and not given" }] });
    const { result } = await run({ goal: "join", url: at("join"), brain, signInHint: "the session saved for x is missing: sign in again with npx contextmachines test --setup" });
    const s = result.steps[0]!;
    assert.match(s.reason!, /sign in again with npx contextmachines test --setup/);
    assert.doesNotMatch(s.reason!, /--var password/);
    assert.equal(s.needs, undefined);
    const out = dir();
    const url = at("account");
    assert.equal(sessionHint(out, url, false), undefined, "a host that never had a session gets the --var hint");
    writeSaved(setupPathFor(out, url), savedTest("log in with {email} and {password}", "login", { kind: "password_gone" }, [{ type: "click", target: { role: "button", name: "Sign in", nth: 0 } }]));
    assert.match(sessionHint(out, url, false)!, /is missing: sign in again with npx contextmachines test --setup "log in with \{email\} and \{password\}"/);
    writeFileSync(authPathFor(out, url), "{}");
    assert.match(sessionHint(out, url, false)!, /no longer signed in/);
    assert.match(sessionHint(out, url, true)!, /--signed-out/);
  });
});

describe("healing is said only when it happened", () => {
  const saved = (): SavedTest => ({ version: 1, goal: "search for locator", url: site.url, savedAt: "", steps: [{ title: "Search, then press Go", intent: "Type locator and press Go", check: { kind: "text_visible", text: "Results for locator" }, actions: [{ type: "fill", target: { role: "searchbox", name: "Search", nth: 0 }, value: "locator" }, { type: "click", target: { role: "button", name: "Go", nth: 0 } }] }] });

  it("with no AI, a missing element is not sure, says there's no AI, and nothing is healed or saved", async () => {
    site.searchButton = "Search now";
    try {
      const events: TestEvent[] = [];
      const { result, save } = await run({ goal: "search for locator", saved: saved(), on: (e) => void events.push(e) });
      const s = result.steps[0]!;
      assert.equal(s.verdict, "not_sure");
      assert.equal(s.healed, undefined);
      assert.equal(s.reason, "can't find Clicking on 'Go' button; no AI to find another way (--ai)");
      assert.equal(save, undefined);
      assert.deepEqual(events.filter((e) => e.type === "healing").map((e) => (e as { ai: boolean }).ai), [false]);
      assert.ok(!result.friction.some((f) => f.kind === "slow"), "waiting for the gone element isn't the page being slow");
      // In the checklist: no "asking the AI", and no "healed".
      let text = "";
      const out = { write: (t: string) => ((text += t), true), columns: 100, isTTY: false } as unknown as NodeJS.WriteStream;
      const list = new Checklist(out, colors(false), false);
      list.event({ type: "planned", steps: [step("Search", { kind: "none" })], replay: true });
      for (const e of events) list.event(e);
      assert.doesNotMatch(text, /asking the AI|healed/);
      assert.match(text, /no AI to find another way/);
    } finally {
      site.searchButton = "Go";
    }
  });

  it("run on another address (--url in a suite), nothing is healed or saved, and the AI isn't asked", async () => {
    site.searchButton = "Search now";
    try {
      const brain = scripted([], { 1: [{ pick: "click", role: "button", name: "Search now" }, { type: "done" }] });
      const { result, save } = await run({ goal: "search for locator", saved: saved(), brain, noHeal: true });
      assert.equal(result.verdict, "not_sure");
      assert.match(result.steps[0]!.reason!, /another address \(--url\) isn't healed/);
      assert.equal(brain.asks, 0);
      assert.equal(save, undefined);
    } finally {
      site.searchButton = "Go";
    }
  });

  it("a heal shows only what failed and what replaced it, and renames the element in the step's words", async () => {
    site.searchButton = "Search now";
    try {
      const brain = scripted([], { 1: [{ pick: "click", role: "button", name: "Search now" }, { type: "done" }] });
      const { result, save } = await run({ goal: "search for locator", saved: saved(), brain });
      assert.equal(result.verdict, "pass");
      assert.deepEqual(result.steps[0]!.healed, { from: ["Clicking on 'Go' button"], to: ["Clicking on 'Search now' button"] });
      assert.equal(save!.steps[0]!.title, "Search, then press Search now");
      assert.equal(save!.steps[0]!.intent, "Type locator and press Search now");
      assert.match(testReportPage(result, { dir: "/nowhere" }), /Healed:<\/strong> <span class="old">Clicking on &#39;Go&#39; button<\/span>/);
      const xml = junitXml([{ name: "t", host: "h", ms: 1, result }], 1);
      assert.match(xml, /<properties><property name="healed" value="1"\/><\/properties>/);
      assert.match(xml, /<system-err>healed: 1 step found another way, and the saved test was rewritten: commit it/);
    } finally {
      site.searchButton = "Go";
    }
    assert.equal(renamed("Press 'Save invoice'", [{ type: "click", target: { role: "button", name: "Save invoice", nth: 0 } }], [{ type: "click", target: { role: "button", name: "Store invoice", nth: 0 } }]), "Press 'Store invoice'");
    assert.equal(renamed("Press Save", [{ type: "click", target: { role: "button", name: "Save", nth: 0 } }], []), "Press Save", "no single name replaced it: left as it was");
  });

  it("a passing suite still says what was healed or proves little", () => {
    assert.equal(suiteSummary({ passed: 5, failed: 0, notSure: 0, blocked: 0, couldNot: 0, healed: 1, weak: 1 }), "5 passed · 0 failed · 0 not sure · 1 healed · 1 with a check that proves little");
    assert.equal(reportsWord(1), "report");
    assert.equal(reportsWord(2), "reports");
  });
});

describe("where a user might get stuck, measured fairly", () => {
  it("one form filled and sent is one thing to do; a check that never held isn't the page being slow", async () => {
    const fill = (name: string): CachedActionT => ({ type: "fill", target: { role: "textbox", name, nth: 0 }, value: "x" });
    const click = (name: string): CachedActionT => ({ type: "click", target: { role: "button", name, nth: 0 } });
    assert.equal(interactionsOf([{ type: "select", target: { role: "combobox", name: "Client", nth: 0 }, value: "Acme Ltd" }, fill("Amount"), fill("Ref"), click("Save invoice")]), 1);
    assert.equal(interactionsOf([click("Reject all"), click(""), click("Save"), fill("Email"), click("Save")]), 4);
    const log = new FrictionLog();
    log.stepEnd(1, { actions: 4, interactions: 1, waitedMs: 0 });
    assert.deepEqual(log.all, []);
    const saved: SavedTest = { version: 1, goal: "docs show pricing", url: site.url, savedAt: "", steps: [{ title: "Open the docs", intent: "Open the docs", check: { kind: "text_visible", text: "Pricing plans" }, actions: [{ type: "click", target: { role: "link", name: "Docs", nth: 0 } }] }] };
    const { result } = await runTest({ goal: saved.goal, url: site.url, saved, dir: dir(), browser, checkWaitMs: 5300 });
    assert.equal(result.verdict, "fail");
    assert.ok(!result.friction.some((f) => f.kind === "slow"), JSON.stringify(result.friction));
  });
});

describe("a draft proves something before it's saved", () => {
  it("a /x/new -> /x starter whose check held from the start, done with nothing, stays a draft and is not sure", async () => {
    const draft: SavedTest = { version: 1, goal: "Add trade", url: at("trades/new"), savedAt: "", draft: true, steps: [{ title: "Fill in and send the form ('Save trade')", intent: "Fill in the form and send it", check: { kind: "url_contains", text: "/trades" } }] };
    const lazy = scripted([], { 1: [{ type: "done" }] });
    const { result, save } = await run({ goal: draft.goal, url: draft.url, saved: draft, brain: lazy });
    assert.equal(result.verdict, "not_sure");
    assert.match(result.steps[0]!.reason!, /did nothing.*proves nothing.*the draft is kept/);
    assert.equal(save, undefined);
    assert.deepEqual(site.posted, []);
    // Even when it did the step: a check that held before it proves nothing.
    const busy = scripted([], { 1: [{ pick: "fill", role: "textbox", name: "Symbol", value: "auto" }, { pick: "click", role: "button", name: "Save trade" }, { type: "done" }] });
    const again = await run({ goal: draft.goal, url: draft.url, saved: draft, brain: busy });
    assert.equal(again.result.verdict, "not_sure");
    assert.equal(again.save, undefined);
  });

  it("a saved test that does nothing and checks nothing isn't read; one whose last step checks nothing isn't either", () => {
    const d = dir();
    const write = (name: string, data: unknown) => {
      writeFileSync(join(d, name), JSON.stringify(data));
      return join(d, name);
    };
    assert.throws(() => readSaved(write("none.json", { version: 1, goal: "g", url: site.url, steps: [{ title: "Look", intent: "look", check: { kind: "none" }, actions: [] }] })), /last step checks nothing/);
    assert.throws(() => readSaved(write("idle.json", { version: 1, goal: "g", url: site.url, steps: [{ title: "Look", intent: "look", check: { kind: "none" }, actions: [] }, { title: "See", intent: "see", check: { kind: "text_visible", text: "x" }, actions: [] }] })), /does nothing and checks nothing/);
    assert.throws(() => readSaved(write("two.json", { version: 1, goal: "g", url: site.url, steps: [{ title: "A", intent: "a", check: { kind: "none" }, actions: [{ type: "scroll", direction: "down" }] }, { title: "B", intent: "b", check: { kind: "none" }, actions: [{ type: "scroll", direction: "down" }] }, { title: "C", intent: "c", check: { kind: "text_visible", text: "x" }, actions: [] }] })), /step 1 checks nothing, so step 2 must check something/);
  });

  it("learn says why it wrote no starter tests", () => {
    const walkedJ = (over: Partial<WalkedJourney>): WalkedJourney => ({ name: "Open the docs", from: "/", main: false, outcome: "finished", steps: [{ screen: "/", did: "open" }, { screen: "/", did: "press", label: "Docs" }], ends: "/docs", seenWith: "stand-in", ...over });
    assert.match(noStartersWhy({ status: "not_walked", message: "Journeys weren't walked: they need the made-up user past the sign-in.", journeys: [] }, site.url), /^No starter tests written: Journeys weren't walked: they need the made-up user past the sign-in\. Try npx contextmachines test --url http:\/\/[^ ]+ to pick tasks$/);
    // Only the site's origin: a token in the start address's query is never printed.
    assert.match(noStartersWhy({ status: "not_walked", journeys: [] }, "https://app.example.com/start?bypass=s3cret"), /Try npx contextmachines test --url https:\/\/app\.example\.com to pick tasks$/);
    assert.doesNotMatch(noStartersWhy({ status: "walked", journeys: [] }, "https://app.example.com/start?bypass=s3cret"), /s3cret/);
    assert.match(noStartersWhy({ status: "walked", journeys: [walkedJ({ outcome: "stopped_here" })] }, site.url), /no journey was walked to its end\. Try npx contextmachines test --url .* to pick tasks$/);
    assert.match(noStartersWhy({ status: "walked", journeys: [walkedJ({ ends: "/" })] }, site.url), /would prove nothing/);
    assert.match(noStartersWhy({ status: "walked", journeys: [walkedJ({})] }, site.url), /already in tests\//);
  });
});

describe("--var values the site echoes back changed", () => {
  it("are masked encoded in an address, with + for a space, and in another case, before the AI or any file sees them", async () => {
    const m = masker({ email: "Secret.Person@corp.example", who: "Test Person Two" });
    assert.equal(m("/find?q=secret.person%40corp.example&n=Test+Person+Two&o=test%20person%20two SECRET.PERSON@CORP.EXAMPLE"), "/find?q={email}&n={who}&o={who} {email}");
    const vars = { email: "secret person@corp.example" };
    const brain = scripted([step("Look up the account", { kind: "text_visible", text: "Welcome" })], { 1: [{ pick: "fill", role: "textbox", name: "Account email", value: "{email}" }, { pick: "click", role: "button", name: "Look up" }, { type: "done" }, { type: "done" }] });
    const { result } = await run({ goal: "look up {email}", url: at("lookup"), vars, brain });
    const encoded = [encodeURIComponent(vars.email), encodeURIComponent(vars.email).replace(/%20/g, "+"), "secret+person"];
    for (const [where, text] of Object.entries({ asked: JSON.stringify(brain.seen), questions: JSON.stringify(brain.seen.map(actQuestion)), result: JSON.stringify(result), junit: junitXml([{ name: "t", host: "h", ms: 1, result }], 1) })) {
      for (const form of encoded) assert.ok(!text.toLowerCase().includes(form.toLowerCase()), `${form} in ${where}`);
    }
    assert.ok(brain.seen.some((s) => s.url.includes("q={email}")), brain.seen.map((s) => s.url).join(" "));
  });

  it("a test that types a --var value keeps its video and photos, its box drawn as dots while and after it is typed", async () => {
    const d = dir();
    const brain = scripted([step("Look up the account", { kind: "text_visible", text: "Account lookup" })], { 1: [{ pick: "fill", role: "textbox", name: "Account email", value: "{email}" }, { pick: "click", role: "button", name: "Look up" }, { type: "done" }] });
    const covers: string[] = [];
    const { result } = await runTest({ goal: "look up {email}", url: at("lookup"), dir: d, browser, checkWaitMs: 600, vars: { email: "secret.person@corp.example" }, brain, onCover: (c) => covers.push(c.up ? "up" : "down") });
    assert.equal(result.verdict, "pass");
    assert.equal(result.video, "run.webm");
    assert.ok(readdirSync(d).some((f) => /^step-\d+\.jpg$/.test(f)), "a step photo");
    assert.deepEqual(covers, [], "no card: {email}'s box was dots before it was typed");
    assert.match(String(result.videoNote), /show as dots in their boxes/);
  });
});

describe("a message is never sent, whatever its button says", () => {
  it("a contact form's Submit is blocked, its message is never made up, and nothing is posted", async () => {
    const brain = scripted([step("Send the contact form", { kind: "text_visible", text: "Thanks" })], {
      1: [{ type: "stuck", why: "the goal gives no values for the required fields" }, { pick: "click", role: "button", name: "Submit" }, { type: "done" }],
    });
    const { result } = await run({ goal: "fill in the contact form", url: at("contact"), brain });
    const s = result.steps[0]!;
    assert.equal(s.verdict, "blocked", JSON.stringify(s));
    assert.match(s.reason!, /"Submit" wasn't pressed: it would send a message \(its form has a field for a message/);
    assert.ok(!s.actions.some((a) => /Your message/.test(a.label) && !a.error), "the message wasn't made up");
    assert.deepEqual(site.posted, []);
    assert.deepEqual(refusedMadeUp({ tag: "textarea", type: "", hint: "notes", signIn: false }), { cannot: "a message, which is the person's to write", varName: "message" });
    // A form with no message in it is pressed as before.
    const save = scripted([step("Save a client", { kind: "url_contains", text: "/did-save" })], { 1: [{ pick: "fill", role: "textbox", name: "Name", value: "Acme" }, { pick: "fill", role: "textbox", name: "Email", value: "auto" }, { pick: "click", role: "button", name: "Save client" }, { type: "done" }] });
    const saved = (await run({ goal: "save a client called Acme", url: at("required"), brain: save })).result;
    assert.equal(saved.verdict, "pass", JSON.stringify({ steps: saved.steps, proof: saved.proof }));
  });
});

describe("a secret in the address stays out of what's written", () => {
  it("a bypass token is left out of the saved test and the JUnit file", async () => {
    const token = "notarealbypassnotarealbypass";
    assert.equal(withoutSecrets(`https://pr-1.example.dev/new?x-vercel-protection-bypass=${token}&tab=2`), "https://pr-1.example.dev/new?tab=2");
    assert.equal(withoutSecrets("https://user:pw@example.com/a?id=12"), "https://example.com/a?id=12");
    assert.equal(onOrigin("http://localhost:3000/new?tab=2", `https://pr-1.example.dev/?x-vercel-protection-bypass=${token}`), `https://pr-1.example.dev/new?tab=2&x-vercel-protection-bypass=${token}`);
    const brain = scripted([step("Open the docs", { kind: "url_contains", text: "/docs" })], { 1: [{ pick: "click", role: "link", name: "Docs" }, { type: "done" }] });
    const { result, save } = await run({ goal: "open the docs", url: `${site.url}?x-vercel-protection-bypass=${token}`, brain });
    assert.equal(result.verdict, "pass");
    assert.ok(!junitXml([{ name: "t", host: "h", ms: 1, result }], 1).includes(token));
    const file = join(dir(), "t.json");
    writeSaved(file, save!);
    assert.ok(!readFileSync(file, "utf8").includes(token));
  });
});

describe("the AI's folder names nobody", () => {
  it("on Windows, Claude Code and Codex start outside the person's profile", () => {
    const me = userInfo().username;
    const roots = askRoots("win32", { ProgramData: "C:\\ProgramData", SystemDrive: "C:", PUBLIC: `C:\\Users\\${me}x` }, `C:\\Users\\${me}\\AppData\\Local\\Temp`);
    assert.ok(roots.length > 0);
    for (const r of roots) assert.ok(!r.toLowerCase().includes(me.toLowerCase()), r);
    assert.equal(roots[0], "C:\\ProgramData");
    assert.deepEqual(askRoots("darwin", {}, "/var/folders/x/T"), ["/var/folders/x/T"]);
  });
});
