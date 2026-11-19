// The web view's server (ui-server.ts): its token, its Host check, changes only by POST, every word
// from a site or an AI shown as text, and Stop really closing the browser. A real browser on a tiny
// local site, and a scripted AI: no network.
//   node --test cli/ui.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import type { PlannedStep } from "../packages/scanner/src/tester/types.ts";
import type { Ai } from "./ai.ts";
import { ACT_SYSTEM, PLAN_SYSTEM } from "./test-command.ts";
import { SUGGEST_SYSTEM } from "./test-tasks.ts";
import { hostAllowed, startUi, tokenOk, type UiOptions, type UiServer } from "./ui-server.ts";

// ---------------------------------------------------------------------------------------------
// A site, and a scripted AI that answers the suggest ask, the planner and the actor.

const EVIL = `<img src=x onerror="window.__pwned=1">`;
let site: Server;
let siteUrl = "";

const pageOf = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function startSite(): Promise<void> {
  site = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const html = (s: string) => res.writeHead(200, { "content-type": "text/html" }).end(s);
    if (url.pathname === "/") return html(pageOf("Fixture Wiki", `<h1>Fixture Wiki</h1><form action="/results" role="search"><input type="search" name="q" aria-label="Search"> <button>Search</button></form><a href="/about">About</a>`));
    if (url.pathname === "/about") return html(pageOf("About", `<h1>About this wiki</h1>`));
    if (url.pathname === "/results") return html(pageOf("Results", `<h1>Results for ${(url.searchParams.get("q") ?? "").replace(/[<>&]/g, "")}</h1>`));
    res.writeHead(404).end();
  });
  return new Promise((done) => site.listen(0, "127.0.0.1", () => {
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    done();
  }));
}

type Move = { click: string; role?: string } | { fill: string; value: string } | { wait: number } | "done";

/** For each goal, its steps and the moves of each step; the actor waits `slowMs` before each answer when asked to. */
function fakeAi(tasks: unknown[], plans: Record<string, { steps: PlannedStep[]; moves: Record<number, Move[]> }>, o: { slowMs?: number } = {}): Ai {
  const left = new Map(Object.entries(plans).map(([goal, p]) => [goal, Object.fromEntries(Object.entries(p.moves).map(([n, m]) => [n, [...m]]))]));
  const refOf = (snapshot: string, name: string, role = "\\w+") => new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot)?.[1] ?? "e9999";
  return {
    via: "a scripted AI",
    async ask(system: string, question: string) {
      if (system === SUGGEST_SYSTEM) return { text: JSON.stringify({ tasks }) };
      const goal = /^Goal(?: of the whole test)?: (.*)$/m.exec(question)?.[1] ?? "";
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ steps: plans[goal]?.steps.map((s) => ({ ...s, check: { text: "", role: "", name: "", ...s.check } })) ?? [] }) };
      if (system === ACT_SYSTEM) {
        if (o.slowMs) await new Promise((r) => setTimeout(r, o.slowMs).unref());
        const n = Number(/^Step (\d+) of/m.exec(question)?.[1]);
        const move = left.get(goal)?.[n]?.shift() ?? "done";
        const snapshot = question.slice(question.indexOf("<page_snapshot"));
        const base = { ref: "", value: "", key: "", direction: "", url: "", ms: 0, why: "" };
        const a = move === "done" ? { action: "done" } : "click" in move ? { action: "click", ref: refOf(snapshot, move.click, move.role) } : "fill" in move ? { action: "fill", ref: refOf(snapshot, move.fill), value: move.value } : { action: "wait", ms: move.wait };
        return { text: JSON.stringify({ ...base, ...a }) };
      }
      throw new Error(`unexpected ask: ${system.slice(0, 40)}`);
    },
  } as unknown as Ai;
}

const SEARCH = "Search for turing and see the results";
const ABOUT = `Open the about page ${EVIL}`;
const PLANS = {
  [SEARCH]: { steps: [{ title: "Search for turing", intent: "Type turing into Search and press Search", check: { kind: "text_visible", text: "Results for turing" } }] as PlannedStep[], moves: { 1: [{ fill: "Search", value: "turing" }, { click: "Search", role: "button" }] } as Record<number, Move[]> },
  [ABOUT]: { steps: [{ title: `Open <b>About</b> ${EVIL}`, intent: "Click About", check: { kind: "text_visible", text: "About this wiki" } }] as PlannedStep[], moves: { 1: [{ click: "About" }] } as Record<number, Move[]> },
};

// ---------------------------------------------------------------------------------------------
// Talking to the server as anything on this machine could: raw requests, with any Host header.

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The classic page's address (the app took /). */
const classic = (ui: UiServer) => ui.url.replace("/?t=", "/classic?t=");

const post = (ui: UiServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  raw(ui.port, "POST", path, { "content-type": "application/json", "x-cm-token": ui.token, ...headers }, JSON.stringify(body));

/** The event stream, read as the page reads it. */
function listen(ui: UiServer) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { want: (e: Record<string, unknown>) => boolean; done: (e: Record<string, unknown>) => void }[] = [];
  let stop = () => {};
  const req = request({ host: "127.0.0.1", port: ui.port, path: `/events?t=${ui.token}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const e = JSON.parse(data.slice(6)) as Record<string, unknown>;
        seen.push(e);
        for (const w of [...waiters]) if (w.want(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.done(e);
        }
      }
    });
  });
  req.on("error", () => {});
  req.end();
  stop = () => req.destroy();
  return {
    seen,
    close: () => stop(),
    next(want: (e: Record<string, unknown>) => boolean, ms = 60_000): Promise<Record<string, unknown>> {
      const had = seen.find(want);
      if (had) return Promise.resolve(had);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no such event in ${ms}ms; saw ${seen.map((e) => e.type).join(", ")}`)), ms);
        waiters.push({ want, done: (e) => (clearTimeout(timer), resolve(e)) });
      });
    },
  };
}

let browser: Browser;
const dirs: string[] = [];
const servers: UiServer[] = [];

function options(ai: Ai | undefined, extra: Partial<UiOptions> = {}): UiOptions {
  const d = mkdtempSync(join(tmpdir(), "cm-ui-"));
  dirs.push(d);
  const outDir = join(d, "cm");
  return { outDir, testsDir: join(outDir, "tests"), ai, vars: {}, mask: (s) => s, allowHosts: [], headed: false, maxActions: 25, checkWaitMs: 1500, ...extra };
}
async function open(o: UiOptions): Promise<UiServer> {
  const ui = await startUi(o);
  servers.push(ui);
  return ui;
}

before(async () => {
  browser = await launch();
  await startSite();
});
after(async () => {
  for (const ui of servers) await ui.close().catch(() => {});
  await browser?.close();
  await new Promise<void>((done) => site.close(() => done()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("the token", () => {
  it("is compared whole, in constant time; nothing, a prefix or another value is refused", () => {
    const token = "a".repeat(64);
    assert.equal(tokenOk(token, token), true);
    for (const bad of [undefined, "", "a".repeat(63), "a".repeat(65), "b".repeat(64), ["x"], 42]) assert.equal(tokenOk(bad, token), false, String(bad));
  });

  it("every route needs it: the page, the events, the state, the files; with it, the page loads", async () => {
    const ui = await open(options(undefined));
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
    for (const path of ["/", "/classic", "/classic?t=nope", "/api/projects", "/?t=", "/?t=nope", `/?t=${ui.token.slice(0, 63)}`, "/events", "/api/state", `/files/${"0".repeat(64)}/r1/run.webm`]) {
      const a = await raw(ui.port, "GET", path);
      assert.equal(a.status, 403, path);
      assert.doesNotMatch(a.body, /<script/);
    }
    // Both pages: the app at / and the classic page at /classic, each under its own nonce, loading nothing from the web.
    const classicPage = await raw(ui.port, "GET", `/classic?t=${ui.token}`);
    assert.equal(classicPage.status, 200);
    assert.match(String(classicPage.headers["content-security-policy"]), /default-src 'none'; script-src 'nonce-[^']+'/);
    assert.doesNotMatch(classicPage.body, /<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/i);
    const page = await raw(ui.port, "GET", `/?t=${ui.token}`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'; script-src 'nonce-[^']+'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    // It loads nothing from the web.
    assert.doesNotMatch(page.body, /<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/i);
    assert.equal((await raw(ui.port, "GET", `/api/state?t=${ui.token}`)).status, 200);
  });

  it("listens on 127.0.0.1 only", async () => {
    const ui = await open(options(undefined));
    assert.equal(new URL(ui.url).hostname, "127.0.0.1");
  });
});

describe("the Host check (DNS rebinding)", () => {
  it("answers only to its own address: 127.0.0.1 or localhost on its own port", async () => {
    assert.equal(hostAllowed("127.0.0.1:5000", 5000), true);
    assert.equal(hostAllowed("localhost:5000", 5000), true);
    for (const h of [undefined, "", "127.0.0.1", "127.0.0.1:5001", "evil.example:5000", "localhost.evil.example:5000", "127.0.0.1.nip.io:5000", "[::1]:5000"]) assert.equal(hostAllowed(h, 5000), false, String(h));
    const ui = await open(options(undefined));
    // A page on another name that points at this machine sends its own name: refused, token or not.
    for (const host of [`evil.example:${ui.port}`, `127.0.0.1:${ui.port + 1}`, "127.0.0.1"]) {
      assert.equal((await raw(ui.port, "GET", `/?t=${ui.token}`, { host })).status, 403, host);
      assert.equal((await post(ui, "/api/stop", {}, { host })).status, 403, host);
    }
    assert.equal((await raw(ui.port, "GET", `/?t=${ui.token}`, { host: `localhost:${ui.port}` })).status, 200);
  });
});

describe("changes only by POST, with the token in its header", () => {
  it("a GET never starts or stops anything", async () => {
    const ui = await open(options(fakeAi([{ goal: SEARCH, area: "search" }], PLANS)));
    for (const action of ["suggest", "run", "run-saved", "stop"]) {
      const a = await raw(ui.port, "GET", `/api/${action}?t=${ui.token}&url=${encodeURIComponent(siteUrl)}`);
      assert.equal(a.status, 405, action);
      assert.equal(a.headers.allow, "POST");
    }
    const state = JSON.parse((await raw(ui.port, "GET", `/api/state?t=${ui.token}`)).body);
    assert.equal(state.busy, null);
  });

  it("refuses a POST with the token only in the URL, without JSON, or from another page", async () => {
    const ui = await open(options(fakeAi([], PLANS)));
    const noHeader = await raw(ui.port, "POST", `/api/stop?t=${ui.token}`, { "content-type": "application/json" }, "{}");
    assert.equal(noHeader.status, 403);
    // What a form on another site could send: no custom header, text/plain.
    assert.equal((await raw(ui.port, "POST", `/api/run?t=${ui.token}`, { "content-type": "text/plain" }, JSON.stringify({ url: siteUrl, goal: "x" }))).status, 403);
    assert.equal((await raw(ui.port, "POST", "/api/run", { "content-type": "text/plain", "x-cm-token": ui.token }, JSON.stringify({ url: siteUrl, goal: "x" }))).status, 415);
    assert.equal((await post(ui, "/api/run", { url: siteUrl, goal: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(ui, "/api/run", { url: siteUrl, goal: "x" }, { "x-cm-token": "f".repeat(64) })).status, 403);
    assert.equal((await raw(ui.port, "PUT", `/?t=${ui.token}`)).status, 405);
    assert.equal(JSON.parse((await raw(ui.port, "GET", `/api/state?t=${ui.token}`)).body).busy, null);
    // A body that isn't JSON, or is too big.
    assert.equal((await raw(ui.port, "POST", "/api/run", { "content-type": "application/json", "x-cm-token": ui.token }, "{nope")).status, 400);
    assert.equal((await raw(ui.port, "POST", "/api/run", { "content-type": "application/json", "x-cm-token": ui.token }, JSON.stringify({ goal: "x".repeat(70_000) }))).status, 400);
  });

  it("serves only its runs' own files, by name: no folders, no other runs", async () => {
    const ui = await open(options(undefined));
    for (const path of [`/files/${ui.token}/r1/..%2F..%2Fetc%2Fpasswd`, `/files/${ui.token}/r1/.video`, `/files/${ui.token}/nope/run.webm`, `/files/${ui.token}/r1/x.sh`]) assert.equal((await raw(ui.port, "GET", path)).status, 404, path);
  });
});

describe("a run, side by side", () => {
  it("suggests tasks, runs the picked ones with the same engine and files, streams the live screen, and serves the video so it seeks", async () => {
    const o = options(fakeAi([{ goal: SEARCH, area: "search" }, { goal: "Sign in to your account", area: "account" }], PLANS));
    const ui = await open(o);
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/suggest", { url: siteUrl })).status, 202);
      const tasks = await ev.next((e) => e.type === "tasks" && Boolean(e.list));
      // The sign-in task was never offered.
      assert.deepEqual((tasks.tasks as { goal: string }[]).map((t) => t.goal), [SEARCH]);
      await ev.next((e) => e.type === "busy" && e.busy === null && ev.seen.indexOf(e) > ev.seen.indexOf(tasks));
      // A task the page sends is checked again: one that signs in is dropped.
      assert.equal((await post(ui, "/api/run", { url: siteUrl, tasks: [{ goal: "Log in with your password", area: "account" }] })).status, 400);
      assert.equal((await post(ui, "/api/run", { url: siteUrl, tasks: [{ goal: SEARCH, area: "search" }] })).status, 202);
      // One thing at a time.
      assert.equal((await post(ui, "/api/suggest", { url: siteUrl })).status, 409);
      const result = await ev.next((e) => e.type === "result");
      const r = result.result as { verdict: string; steps: { actions: { label: string }[] }[] };
      assert.equal(r.verdict, "pass", JSON.stringify(r.steps));
      // The sub-actions as the terminal has them, and what it did between them.
      const evs = ev.seen.filter((e) => e.type === "ev").map((e) => e.e as { type: string; words?: string });
      assert.ok(evs.some((e) => e.type === "working" && e.words === "Capturing page snapshot"));
      // Each, with its moment in the video, for its Go to.
      assert.ok(evs.filter((e) => e.type === "working").every((e) => typeof (e as { at?: unknown }).at === "number"));
      assert.ok(evs.some((e) => e.type === "working" && /^Checking the page shows "Results for turing"/.test(e.words ?? "")));
      assert.match(r.steps[0]!.actions.map((a) => a.label).join(" / "), /Filling 'turing' into 'Search' searchbox \/ Clicking on 'Search' button/);
      // The live screen: JPEG frames, with the page's address.
      // (Under load the very first frame can come before the first page, as about:blank: the page's frame is the one checked.)
      const frame = ev.seen.find((e) => e.type === "frame" && e.url !== "about:blank");
      assert.ok(frame, "a frame of the live screen");
      assert.ok(Buffer.from(String(frame.jpeg), "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG");
      assert.match(String(frame.url), /^http:\/\/127\.0\.0\.1:\d+\//);
      // The video's address bar follows the frames: the address at each moment of it.
      const urls = result.urls as { t: number; url: string }[];
      assert.ok(urls.length >= 2 && urls[0]!.t >= 0 && urls.some((u) => /\/results\?q=turing/.test(u.url)), JSON.stringify(urls));
      // The same files as the terminal: a run folder with its report, and the pass saved as a visitor's test.
      assert.match(String(result.saved), /tests\/127\.0\.0\.1-\d+\/search-for-turing-and-see-the-results\.json$/);
      const end = await ev.next((e) => e.type === "jobEnd");
      assert.equal(end.summary, "Tests 1 passed · 0 failed · 0 not sure");
      // The video, served by range so the page can seek it.
      const video = await raw(ui.port, "GET", String(result.video), { range: "bytes=0-99" });
      assert.equal(video.status, 206);
      assert.match(String(video.headers["content-range"]), /^bytes 0-99\/\d+$/);
      assert.equal(video.headers["content-type"], "video/webm");
      assert.equal((await raw(ui.port, "GET", String(result.report))).status, 200);
    } finally {
      ev.close();
    }
  });

  it("every word from a site or the AI is shown as text: a goal and a step with HTML in them run nothing in the page", async () => {
    const ui = await open(options(fakeAi([], PLANS)));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, goal: ABOUT })).status, 202);
      await ev.next((e) => e.type === "jobEnd");
    } finally {
      ev.close();
    }
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(classic(ui)); // the classic page moved to /classic when / became the app
      // A finished run is a click away from the start.
      await page.locator("#showlast").waitFor({ timeout: 15_000 });
      await page.click("#showlast");
      await page.locator(".result .badge").waitFor({ timeout: 15_000 });
      assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined);
      // Shown, as typed: the words, not an image or bold text.
      assert.equal(await page.locator("#steps img, #steps b, .testhead img, #card img[src='x']").count(), 0);
      assert.ok((await page.locator("#title").textContent())!.includes(EVIL));
      assert.ok((await page.locator("#steps").textContent())!.includes(`Open <b>About</b> ${EVIL}`));
      assert.equal(await page.locator(".result .badge").textContent(), "PASS");
      // Finished: a Go to for the step, and the video in the frame.
      assert.match((await page.locator("#steps .goto").first().textContent()) ?? "", /^Go to \d:\d\d$/);
      assert.equal(await page.locator("#video").isVisible(), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  it("Stop really stops: the run ends at once, its browser is closed, and nothing after it runs", async () => {
    const launched: Browser[] = [];
    const slow = fakeAi([], {
      [SEARCH]: { steps: [{ title: "Search for turing", intent: "Type turing", check: { kind: "text_visible", text: "Results for turing" } }], moves: { 1: [{ wait: 100 }] } },
      [ABOUT]: PLANS[ABOUT],
    }, { slowMs: 60_000 });
    const ui = await open(options(slow, { launch: async () => { const b = await launch(); launched.push(b); return b; } }));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, tasks: [{ goal: SEARCH, area: "search" }, { goal: "Open the about page", area: "navigation" }] })).status, 202);
      // The actor is asked, and takes its time: the run is mid-step.
      await ev.next((e) => e.type === "ev" && (e.e as { type: string; words?: string }).words === "Asking the AI for the next action");
      assert.equal(launched.length, 1);
      assert.equal(launched[0]!.isConnected(), true);
      const t0 = Date.now();
      const stopped = await post(ui, "/api/stop", {});
      assert.equal(stopped.status, 200);
      assert.equal(JSON.parse(stopped.body).stopped, true);
      assert.ok(Date.now() - t0 < 15_000, "Stop didn't wait for the AI");
      assert.equal(launched[0]!.isConnected(), false, "the browser was closed");
      const notRun = ev.seen.filter((e) => e.type === "notrun");
      assert.equal(notRun.length, 2, JSON.stringify(ev.seen.filter((e) => e.type !== "frame" && e.type !== "ev")));
      assert.ok(notRun.every((e) => e.words === "stopped by you"));
      assert.ok(!ev.seen.some((e) => e.type === "result"));
      assert.equal(JSON.parse((await raw(ui.port, "GET", `/api/state?t=${ui.token}`)).body).busy, null);
      // Free again: a new run may start.
      assert.equal((await post(ui, "/api/stop", {})).status, 200);
    } finally {
      ev.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// After the third trial.

describe("ticks are for the list they were made on", () => {
  it("a new Suggest replaces the list at once; Run selected for the old list is refused, and the new list runs its own tasks by number", async () => {
    const lists = [[{ goal: SEARCH, area: "search" }], [{ goal: "Open the about page", area: "navigation" }, { goal: SEARCH, area: "search" }]];
    let asked = 0;
    const base = fakeAi([], PLANS);
    const ai = { ...base, async ask(system: string, question: string, schema: object) {
      if (system === SUGGEST_SYSTEM) return { text: JSON.stringify({ tasks: lists[Math.min(asked++, lists.length - 1)] }) };
      return base.ask(system, question, schema);
    } } as Ai;
    const ui = await open(options(ai));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/suggest", { url: siteUrl })).status, 202);
      const first = await ev.next((e) => e.type === "tasks" && Boolean(e.list));
      await ev.next((e) => e.type === "busy" && e.busy === null && ev.seen.indexOf(e) > ev.seen.indexOf(first));
      assert.equal((await post(ui, "/api/suggest", { url: siteUrl })).status, 202);
      // The old list is cleared the moment a new one is asked for.
      const cleared = await ev.next((e) => e.type === "tasks" && e.list === null && ev.seen.indexOf(e) > ev.seen.indexOf(first));
      assert.deepEqual(cleared.tasks, []);
      const second = await ev.next((e) => e.type === "tasks" && Boolean(e.list) && e.list !== first.list);
      await ev.next((e) => e.type === "busy" && e.busy === null && ev.seen.indexOf(e) > ev.seen.indexOf(second));
      // Ticks made on the first list: refused, nothing runs.
      const stale = await post(ui, "/api/run", { url: siteUrl, list: first.list, picked: [0] });
      assert.equal(stale.status, 409);
      assert.match(JSON.parse(stale.body).error, /changed since you ticked it/);
      assert.equal((await post(ui, "/api/run", { url: siteUrl, list: "l999", picked: [0] })).status, 409);
      assert.ok(!ev.seen.some((e) => e.type === "job"));
      // On the new list, number 2 is its own second task, whatever the page says the goal is.
      assert.equal((await post(ui, "/api/run", { url: siteUrl, list: second.list, picked: [1], tasks: [{ goal: "Open the about page", area: "x" }] })).status, 202);
      const job = await ev.next((e) => e.type === "job");
      assert.deepEqual((job.tests as { goal: string }[]).map((t) => t.goal), [SEARCH]);
      await ev.next((e) => e.type === "jobEnd");
    } finally {
      ev.close();
    }
  });

  it("in the page, the old list is hidden while a new one is asked for, and the new one is said to be new", async () => {
    let release!: () => void;
    let asked = 0;
    const base = fakeAi([], PLANS);
    const ai = { ...base, async ask(system: string, question: string, schema: object) {
      if (system === SUGGEST_SYSTEM) {
        if (asked++ === 1) await new Promise<void>((r) => (release = r));
        return { text: JSON.stringify({ tasks: asked === 1 ? [{ goal: SEARCH, area: "search" }] : [{ goal: "Open the about page", area: "navigation" }] }) };
      }
      return base.ask(system, question, schema);
    } } as Ai;
    const ui = await open(options(ai));
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(classic(ui)); // the classic page moved to /classic when / became the app
      await page.fill("#url", siteUrl);
      await page.click("#suggest");
      await page.locator("#tasks li").first().waitFor({ timeout: 30_000 });
      assert.equal(await page.locator("#newlist").isVisible(), false);
      await page.click("#suggest");
      await page.waitForFunction(() => document.getElementById("tasksbox")!.hidden, null, { timeout: 30_000 });
      assert.equal(await page.locator("#suggest").isDisabled(), true);
      while (!release) await new Promise((r) => setTimeout(r, 50));
      release();
      await page.locator("#tasks li", { hasText: "Open the about page" }).waitFor({ timeout: 30_000 });
      assert.equal(await page.locator("#newlist").isVisible(), true);
    } finally {
      await context.close();
    }
  });
});

describe("the live screen, when the plan types a --var value", () => {
  it("the screen stays live and the video is kept; {code}'s box is dots, no card, and the value is in no event", async () => {
    const goal = "Enter the access code and see the results";
    const plans = { [goal]: { steps: [{ title: "Fill the code", intent: "Fill {code} into Search and press Search", check: { kind: "text_visible", text: "Results for" } }] as PlannedStep[], moves: { 1: [{ fill: "Search", value: "{code}" }, { click: "Search", role: "button" }] } as Record<number, Move[]> } };
    const ui = await open(options(fakeAi([], plans), { vars: { code: "S3CRET-ACCESS-CODE-991" } }));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, goal })).status, 202);
      await ev.next((e) => e.type === "jobEnd");
      assert.ok(!ev.seen.some((e) => e.type === "noscreen"), "the page keeps its live screen");
      assert.ok(ev.seen.filter((e) => e.type === "frame").length > 0, "frames were sent");
      assert.ok(!ev.seen.some((e) => e.type === "ev" && /^Typing a stored value/.test(String((e.e as { words?: string }).words))), "no card: the box was masked as dots");
      const r = ev.seen.find((e) => e.type === "result") as { video?: string; result: { videoNote?: string } } | undefined;
      assert.ok(r?.video, "the video was kept");
      assert.match(String(r?.result.videoNote), /show as dots in their boxes/);
      assert.doesNotMatch(JSON.stringify(ev.seen.filter((e) => e.type !== "frame")), /S3CRET-ACCESS-CODE-991/);
    } finally {
      ev.close();
    }
  });
});

describe("Stop, at any moment", () => {
  it("pressed while the browser is still starting: the browser is closed as soon as it's up, in the web view and after it closes", async () => {
    const started: { closed: boolean }[] = [];
    const slowLaunch = async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const b = { closed: false, async close() { b.closed = true; }, isConnected: () => !b.closed };
      started.push(b);
      return b as unknown as Browser;
    };
    const ui = await open(options(fakeAi([], PLANS), { launch: slowLaunch }));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, goal: SEARCH })).status, 202);
      await new Promise((r) => setTimeout(r, 300));
      const stopped = await post(ui, "/api/stop", {});
      assert.equal(JSON.parse(stopped.body).stopped, true);
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(started.length, 1);
      assert.equal(started[0]!.closed, true, "the browser that came up after Stop was closed");
      assert.ok(ev.seen.some((e) => e.type === "notrun"));
    } finally {
      ev.close();
    }
  });

  it("after Stop, nothing is left spinning, and a reload opens on the start with the last run a click away", async () => {
    const slow = fakeAi([], { [SEARCH]: { steps: [{ title: "Search for turing", intent: "Type turing", check: { kind: "text_visible", text: "Results for turing" } }], moves: { 1: [{ wait: 100 }] } } }, { slowMs: 60_000 });
    const ui = await open(options(slow));
    const ev = listen(ui);
    const context = await browser.newContext();
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, goal: SEARCH })).status, 202);
      await ev.next((e) => e.type === "ev" && (e.e as { words?: string }).words === "Asking the AI for the next action");
      assert.equal((await post(ui, "/api/stop", {})).status, 200);
      const page = await context.newPage();
      await page.goto(classic(ui)); // the classic page moved to /classic when / became the app
      await page.locator("#showlast").waitFor({ timeout: 15_000 });
      assert.equal(await page.locator("#start").isVisible(), true, "the start page, not the stopped run");
      assert.equal(await page.locator("#url").isVisible(), true);
      await page.click("#showlast");
      await page.locator(".result .badge").waitFor({ timeout: 15_000 });
      assert.equal(await page.locator(".result .badge").textContent(), "NOT RUN");
      assert.equal(await page.locator("#steps .spin").count(), 0, "no spinner is left on a stopped run");
      assert.ok((await page.locator("#steps .sub.s-stopped").count()) >= 1);
    } finally {
      ev.close();
      await context.close();
    }
  });
});

describe("tasks not run are counted", () => {
  it("explore on a budget too short for any task: the line says they weren't run, and it isn't a pass", async () => {
    const ui = await open(options(fakeAi([], PLANS), { minutes: 0.5 }));
    const ev = listen(ui);
    try {
      assert.equal((await post(ui, "/api/run", { url: siteUrl, tasks: [{ goal: SEARCH, area: "search" }, { goal: "Open the about page", area: "navigation" }], explore: true })).status, 202);
      const end = await ev.next((e) => e.type === "jobEnd");
      assert.equal(end.summary, "Tests 0 passed · 0 failed · 0 not sure · 2 not run");
      assert.equal((end.counts as { notRun: number }).notRun, 2);
    } finally {
      ev.close();
    }
  });
});
