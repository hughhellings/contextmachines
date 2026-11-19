// A site behind a bot check: found with no AI (botwall.ts), waited on for a check that clears by
// itself, never answered or got past; the look suggests nothing and says so (exit 3), a run ends
// BLOCKED (exit 4), the rest of a task list isn't started, and the web view shows a card. Pages that
// only mention a CAPTCHA, or carry a small reCAPTCHA badge, are not walls. A guard keeps evasion out.
// A real browser on a tiny local site, and a scripted AI: no network.
//   node --test cli/botwall.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext } from "playwright";
import { A_CAPTCHA, A_CHALLENGE, BLOCKED_BY_WALL, BOT_WALL_WAIT_MS, botWall, BotWalled, CLOUDFLARE, WALL_NOT_RUN, wallReason, WallWatch } from "../packages/scanner/src/tester/botwall.ts";
import { refusedName } from "../packages/scanner/src/tester/act.ts";
import { savedPathFor, writeSaved } from "../packages/scanner/src/tester/cache.ts";
import { lookAt } from "../packages/scanner/src/tester/look.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import type { Action, DecideInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import type { Ai } from "./ai.ts";
import { colors } from "./term.ts";
import { ACT_SYSTEM, PLAN_SYSTEM, runSuite, TEST_EXIT, VERDICT_EXIT } from "./test-command.ts";
import { explorePage, runFromUrl, SUGGEST_SYSTEM, suggestedPathFor, tasksFrom, writeSuggested, type UrlOptions } from "./test-tasks.ts";
import { testReportPage } from "./test-report.ts";
import { startUi, type UiServer } from "./ui-server.ts";

// ---------------------------------------------------------------------------------------------
// The site: a shop, a Cloudflare-shaped challenge in front of some pages, one that clears by itself,
// and pages that only look a little like one.

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Shaped like Cloudflare's challenge page. Its "Verify you are human" tells the site when it's pressed: it never must be. */
const CHALLENGE = (extra = "") => `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta name="robots" content="noindex,nofollow"></head>
<body><div class="main-wrapper" role="main"><div class="main-content"><h1 class="zone-name-title h1">shop.fixture</h1>
<h2>Performing security verification</h2><div class="spinner" aria-hidden="true">◌</div>
<label><input type="checkbox" onclick="fetch('/clicked')"> Verify you are human</label>
<p>This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.</p></div></div>
<div class="footer"><div>Ray ID: <code>8f1a2b3c4d5e6f70</code></div><div>Performance &amp; security by Cloudflare</div></div>
<script>window._cf_chl_opt = { cvId: "3" };${extra}</script></body></html>`;

const NAV = `<header><nav><a href="/about">About</a> <a href="/members">Members</a> <a href="/deals">Deals</a></nav></header>`;
const HOME = page("Fixture Shop", `${NAV}<main><h1>Welcome to Fixture Shop</h1><form action="/results" role="search"><input type="search" name="q" aria-label="Search"> <button>Search</button></form><h2>New in</h2></main>`);

const LOREM = "Websites use many signals to tell people from programs, and the trade-offs between friction and protection are real. ".repeat(14);
/** An article about CAPTCHAs: it says the words a challenge says, in the middle of its own long text and links. */
const ARTICLE = page("How CAPTCHAs work, and why you see them", `${NAV}<main><article><h1>How CAPTCHAs work</h1><p>${LOREM}</p>
<p>You may have met a page that says "Just a moment..." and "Performing security verification", or a box that asks you to "Verify you are human". A CAPTCHA, or a reCAPTCHA, may ask you to "Press &amp; Hold".</p>
<p>${LOREM}</p><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/read/${i}">Further reading ${i}</a></li>`).join("")}</ul></article></main>`);
/** A sign-in page with a small reCAPTCHA box in its form, beside its own content. */
const LOGIN = page("Sign in · Fixture Shop", `${NAV}<main><h1>Sign in</h1><p>Welcome back to Fixture Shop. Sign in to see your orders, your saved addresses and your wish list.</p>
<form><label>Email <input type="email" name="e"></label> <label>Password <input type="password" name="p"></label>
<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" width="304" height="78" title="reCAPTCHA"></iframe><button>Sign in</button></form>
<p>New here? <a href="/register">Make an account</a>. <a href="/help">Help</a></p></main>`);
/** A page that is only a big CAPTCHA frame. */
const CAPTCHA_ONLY = page("shop.fixture", `<iframe src="https://newassets.hcaptcha.com/captcha/v1/static/hcaptcha.html" style="position:fixed;inset:0;width:100%;height:100%;border:0" title="hCaptcha"></iframe>`);

const TOP = `<nav><a href="/a">Home</a> <a href="/b">Pricing</a> <a href="/c">Docs</a> <a href="/d">Blog</a></nav>`;
const PROSE = "We protect websites from attacks with a global network, filtering traffic at the edge and keeping your services online. ".repeat(20);
/** Normal pages that carry a challenge's words, name or frame: none is a wall. */
const NOT_WALLS: Record<string, string> = {
  "login-verify": page("Sign in · Acme", `${TOP}<main><h1>Sign in</h1><form><label>Email <input type=email></label><label>Password <input type=password></label><p>Please verify you are human:</p><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x" width=304 height=78></iframe><button>Sign in</button></form><a href="/forgot">Forgot password?</a></main>`),
  "login-verify-text": page("Sign in · Acme", `${TOP}<main><h1>Sign in</h1><form><label>Email <input type=email></label><label>Password <input type=password></label><p>Please verify you are human</p><button>Sign in</button></form></main>`),
  "contact-turnstile": page("Contact us · Acme", `${TOP}<main><h1>Contact us</h1><form><input name=n placeholder=Name><textarea></textarea><p>Please complete the security check before sending.</p><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/x/normal" width=300 height=65></iframe><button>Send</button></form></main>`),
  "walkie": page("Walkie · Acme", `${TOP}<main><h1>Walkie talkie</h1><p>Press and hold the big button to talk to your team.</p><button>Talk</button></main>`),
  "ddosguard-home": page("DDoS-Guard — DDoS protection, CDN and hosting", `${TOP}<main><h1>DDoS protection for your business</h1><p>${PROSE}</p>${Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">Product ${i}</a>`).join(" ")}</main>`),
  "ddosguard-review": page("Review: is DDoS-Guard any good?", `${TOP}<main><h1>Our review of DDoS-Guard</h1><p>${PROSE}</p></main>`),
  "poem": page("Just a moment of calm: a short poem", `${TOP}<main><h1>Just a moment of calm</h1><p>Breathe in, breathe out. A short poem about patience.</p></main>`),
  "hidden-hcaptcha": page("Shop · Acme", `${TOP}<main><h1>Shop</h1><p>${PROSE}</p><div style="visibility:hidden;position:absolute;top:-10000px;left:0;width:100%"><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" style="width:100vw;height:100vh;border:0"></iframe></div></main>`),
  "clear-hcaptcha": page("Shop · Acme", `${TOP}<main><h1>Shop</h1><p>${PROSE}</p><div style="opacity:0;position:fixed;inset:0;pointer-events:none"><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" style="width:100%;height:100%;border:0"></iframe></div></main>`),
  "offscreen-hcaptcha": page("Shop · Acme", `${TOP}<main><h1>Shop</h1><p>${PROSE}</p><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge" style="position:absolute;top:-5000px;left:0;width:100vw;height:100vh;border:0"></iframe></main>`),
};
/** Challenge pages the detector must still find, and what it calls each. */
const MORE_WALLS: Record<string, string> = {
  // Cloudflare's current wording, under a title of the site's own and with no frame.
  "cf-verifying": page("example.com", `<h1>example.com</h1><p>Verifying you are human. This may take a few seconds.</p><p>example.com needs to review the security of your connection before proceeding.</p><p>Ray ID: 8f1a2b3c4d5e6f70</p><p>Performance &amp; security by Cloudflare</p>`),
  "cf-moment-please": page("Just a moment, please", `<p>One moment.</p><script>window._cf_chl_opt = { cvId: "3" };</script>`),
  "px-hold": page("Access to this page has been denied", `<h1>Before we continue...</h1><p>Press &amp; Hold to confirm you are a human (and not a bot).</p><div id="px-captcha"></div><p>Reference ID 123</p>`),
};
const WANT_WALL: Record<string, string> = { "cf-verifying": CLOUDFLARE, "cf-moment-please": CLOUDFLARE, "px-hold": "HUMAN's bot check" };
/** A long page of its own with a same-origin "Press & Hold" over it: not found as a wall, and its button is never pressed. */
const HOLD_MODAL = page("Fixture Shop · News", `${NAV}<main><h1>News</h1><p>${PROSE}</p>${Array.from({ length: 12 }, (_, i) => `<a href="/read/${i}">Story ${i}</a>`).join(" ")}</main>
<div role="dialog" aria-label="Before we continue" style="position:fixed;inset:20% 30%;background:#fff;border:1px solid #000"><p>Before we continue, confirm you are a human.</p><button onclick="fetch('/clicked')">Press &amp; Hold</button></div>`);

interface Site {
  url: string;
  clicked: number;
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const site = { clicked: 0 } as Site;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const html = (content: string, status = 200) => res.writeHead(status, { "content-type": "text/html" }).end(content);
    if (url.pathname === "/clicked") {
      site.clicked++;
      return res.writeHead(204).end();
    }
    if (url.pathname === "/") return html(HOME);
    if (url.pathname === "/about") return html(page("About · Fixture Shop", `${NAV}<h1>About Fixture Shop</h1>`));
    if (url.pathname === "/deals") return html(page("Deals · Fixture Shop", `${NAV}<h1>Deals of the day</h1>`));
    if (url.pathname === "/wall" || url.pathname === "/members") return html(CHALLENGE(), 403);
    // Shows the challenge for about 1.5s, then (as a check that clears by itself does) loads the page again, let in.
    if (url.pathname === "/clears") return /(^|;\s*)cleared=1/.test(req.headers.cookie ?? "") ? html(HOME) : html(CHALLENGE(`setTimeout(function () { document.cookie = "cleared=1; path=/"; location.reload(); }, 1500);`), 403);
    if (url.pathname === "/ddos") return html(page("DDoS-Guard", `<p>Checking your browser before accessing shop.fixture.</p><script src="/.well-known/ddos-guard/check?context=free_splash"></script>`), 503);
    if (url.pathname === "/denied") return html(page("Access Denied", `<h1>Access Denied</h1><p>You don't have permission to access this page on this server.</p><p>Reference #18.9c2b1402.1731753600.4f1e2d</p><p>https://errors.edgesuite.net/18.9c2b1402</p>`), 403);
    if (url.pathname === "/forbidden") return html(page("Access denied", `${NAV}<h1>Access denied</h1><p>Your account can't see this page. Ask an admin of your team.</p>`), 403);
    if (url.pathname === "/article") return html(ARTICLE);
    if (url.pathname === "/login") return html(LOGIN);
    if (url.pathname === "/captcha") return html(CAPTCHA_ONLY);
    if (url.pathname === "/hold") return html(HOLD_MODAL);
    const fixture = /^\/fx\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (fixture && (NOT_WALLS[fixture] ?? MORE_WALLS[fixture])) return html((NOT_WALLS[fixture] ?? MORE_WALLS[fixture])!);
    // Like Cloudflare's non-interactive check: the challenge for about 5.5s, then a cookie and the page again.
    if (url.pathname === "/slow") return /(^|;\s*)slowok=1/.test(req.headers.cookie ?? "") ? html(HOME) : html(CHALLENGE(`setTimeout(function () { document.cookie = "slowok=1; path=/"; location.reload(); }, 5500);`), 403);
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  site.close = () => new Promise<void>((done) => server.close(() => done()));
  return site;
}

// ---------------------------------------------------------------------------------------------
// A scripted AI: the suggest ask, the planner and the actor, by their system prompts.

type Move = Action | { pick: "click"; role: string; name: string };

function refIn(snapshot: string, role: string, name: string): string {
  return new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot)?.[1] ?? "e9999";
}

interface FakeAi extends Ai {
  asked: { system: string; question: string }[];
}

function fakeAi(tasks: unknown[], plans: Record<string, { steps: PlannedStep[]; moves: Record<number, Move[]> }>): FakeAi {
  const left = new Map(Object.entries(plans).map(([goal, p]) => [goal, Object.fromEntries(Object.entries(p.moves).map(([n, m]) => [n, [...m]]))]));
  const ai: FakeAi = {
    model: "scripted",
    via: "a scripted AI",
    asked: [],
    async ask(system: string, question: string) {
      ai.asked.push({ system, question });
      if (system === SUGGEST_SYSTEM) return { text: JSON.stringify({ tasks }) };
      const goal = /^Goal(?: of the whole test)?: (.*)$/m.exec(question)?.[1] ?? "";
      if (system === PLAN_SYSTEM) return { text: JSON.stringify({ steps: plans[goal]?.steps.map((s) => ({ ...s, check: { text: "", role: "", name: "", ...s.check } })) ?? [] }) };
      if (system === ACT_SYSTEM) {
        const n = Number(/^Step (\d+) of/m.exec(question)?.[1]);
        const move: Move = left.get(goal)?.[n]?.shift() ?? { type: "done" };
        const snapshot = question.slice(question.indexOf("<page_snapshot"));
        const a: Record<string, unknown> = "pick" in move ? { action: move.pick, ref: refIn(snapshot, move.role, move.name) } : { ...move, action: move.type };
        return { text: JSON.stringify({ ref: "", value: "", key: "", direction: "", url: "", ms: 0, why: "", ...a }) };
      }
      throw new Error(`unexpected ask: ${system.slice(0, 40)}`);
    },
  } as FakeAi;
  return ai;
}

function scriptedBrain(plan: PlannedStep[], moves: Record<number, Move[]>): TesterBrain & { planned: number; decided: number } {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  const brain = {
    planned: 0,
    decided: 0,
    async plan() {
      brain.planned++;
      return plan;
    },
    async decide(input: DecideInput): Promise<Action> {
      brain.decided++;
      const move = left[input.n]?.shift() ?? { type: "done" };
      return "pick" in move ? { type: "click", ref: refIn(input.snapshot, move.role, move.name) } : move;
    },
  };
  return brain;
}

function sink(): NodeJS.WriteStream & { text: string } {
  const s = new Writable({
    write(chunk, _enc, done) {
      s.text += String(chunk);
      done();
    },
  }) as unknown as NodeJS.WriteStream & { text: string };
  s.text = "";
  return s;
}

let browser: Browser;
let site: Site;
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-wall-"));
  dirs.push(d);
  return d;
};
const at = (path: string) => new URL(path, site.url).href;
/** Short waits for a check that stays: the rule's ~10s is the default; the one that clears is given it. */
const STAYS_MS = 1500;

before(async () => {
  browser = await launch();
  site = await startSite();
});
after(async () => {
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A page of the site, in a context where the challenge services' frames are answered offline. */
async function opened(path: string): Promise<{ context: BrowserContext; page: import("playwright").Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/^https:\/\/(www\.google\.com\/recaptcha|newassets\.hcaptcha\.com|challenges\.cloudflare\.com)\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><div>I'm not a robot</div>" }));
  const p = await context.newPage();
  await p.goto(at(path), { waitUntil: "load" });
  await p.waitForTimeout(150);
  return { context, page: p };
}

// ---------------------------------------------------------------------------------------------

describe("the detector, with no AI", () => {
  it("names a challenge from strong signals: Cloudflare's page, a page that is only a CAPTCHA, DDoS-Guard, Akamai's denial", async () => {
    for (const [path, want] of [["wall", CLOUDFLARE], ["captcha", A_CAPTCHA], ["ddos", "DDoS-Guard's bot check"], ["denied", "Akamai's bot check"]] as const) {
      const { context, page: p } = await opened(path);
      try {
        assert.equal(await botWall(p), want, path);
      } finally {
        await context.close();
      }
    }
  });

  it("a normal page is never one: an article about CAPTCHAs, a sign-in with a small reCAPTCHA box, a plain 'Access denied', the home page", async () => {
    for (const path of ["article", "login", "forbidden", ""]) {
      const { context, page: p } = await opened(path);
      try {
        if (path === "login") assert.ok(p.frames().some((f) => /google\.com\/recaptcha/.test(f.url())), "the reCAPTCHA frame loaded");
        assert.equal(await botWall(p), undefined, path || "home");
      } finally {
        await context.close();
      }
    }
  });
});

describe("the detector, on pages that only look a little like a wall", () => {
  it("a sign-in or contact form saying 'verify you are human' or 'complete the security check', a walkie-talkie's 'press and hold', titles that name DDoS-Guard or start 'Just a moment', and hidden or off-screen challenge frames are not walls", async () => {
    for (const name of Object.keys(NOT_WALLS)) {
      const { context, page: p } = await opened(`fx/${name}`);
      try {
        assert.equal(await botWall(p), undefined, name);
      } finally {
        await context.close();
      }
    }
  });

  it("still finds Cloudflare's 'Verifying you are human' under the site's own title, a 'Just a moment' title with Cloudflare's script, and HUMAN's Press & Hold", async () => {
    for (const [name, want] of Object.entries(WANT_WALL)) {
      const { context, page: p } = await opened(`fx/${name}`);
      try {
        assert.equal(await botWall(p), want, name);
      } finally {
        await context.close();
      }
    }
  });

  it("a site whose home page is a sign-in that says 'Please verify you are human' is looked at, not taken for a wall", async () => {
    const look = await lookAt(at("fx/login-verify-text"), { browser, wallWaitMs: STAYS_MS, pages: 0 });
    assert.equal(look.home.title, "Sign in · Acme");
  });
});

describe("the wait for a check to clear by itself", () => {
  it("is about 10s at most, and never runs past what it's given", async () => {
    assert.ok(BOT_WALL_WAIT_MS <= 10_000, `BOT_WALL_WAIT_MS is ${BOT_WALL_WAIT_MS}`);
    const { context, page: p } = await opened("wall");
    try {
      const t0 = Date.now();
      assert.equal(await new WallWatch(1000).stands(p), CLOUDFLARE);
      const took = Date.now() - t0;
      assert.ok(took >= 1000 && took < 1000 + 700, `waited ${took}ms`);
    } finally {
      await context.close();
    }
  });
});

describe("the look at a site behind a bot check", () => {
  it("waits a little, presses nothing, and throws BotWalled with the one message and a photo", async () => {
    const t0 = Date.now();
    const error = await lookAt(at("wall"), { browser, wallWaitMs: STAYS_MS }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BotWalled, String(error));
    const host = new URL(site.url).host;
    assert.equal(error.message, `${host} checks for bots (Cloudflare's bot check) and didn't let the test browser in. Context Machines doesn't get past bot checks. Try a site you own, its staging address, or ask the owner to let the tester through.`);
    assert.ok(error.shot && error.shot.length > 1000, "a photo of the wall");
    const took = Date.now() - t0;
    assert.ok(took >= STAYS_MS, "it waited for the check to clear by itself");
    assert.ok(took < STAYS_MS + 2000, `it waited no longer than it was given (${took}ms)`);
    assert.equal(site.clicked, 0, "the challenge was never pressed");
  });

  it("from the terminal: no suggestions, no AI asked, the message, exit 3", async () => {
    const ai = fakeAi([{ goal: "Open the home page, wait for the 'Performing security verification' check to finish, and see the forum home page title", area: "home" }], {});
    const o = urlOptions(ai, { url: at("wall") });
    const exit = await runFromUrl(o);
    assert.equal(exit, TEST_EXIT.couldNot);
    assert.equal(ai.asked.length, 0, "nothing was asked of the AI");
    assert.deepEqual(o.said, [`couldNot: ${new URL(site.url).host} checks for bots (Cloudflare's bot check) and didn't let the test browser in. Context Machines doesn't get past bot checks. Try a site you own, its staging address, or ask the owner to let the tester through.`]);
    assert.ok(!existsSync(suggestedPathFor(o.outDir, at("wall"))), "no list was kept");
    assert.equal(site.clicked, 0);
  });

  it("a check that clears by itself (about 1.5s) is waited out, and the look carries on", async () => {
    const look = await lookAt(at("clears"), { browser });
    assert.equal(look.home.title, "Fixture Shop");
    assert.ok(look.home.headings.includes("Welcome to Fixture Shop"));
  });

  it("a nav page behind a bot check is skipped quietly", async () => {
    const look = await lookAt(site.url, { browser, pages: 3, wallWaitMs: STAYS_MS });
    const titles = look.pages.map((p) => p.title);
    assert.deepEqual(titles, ["About · Fixture Shop", "Deals · Fixture Shop"]);
  });
});

describe("a run that meets a bot check", () => {
  it("at the start: no plan asked for, the step BLOCKED with the reason, the test BLOCKED (exit 4), its photo kept", async () => {
    const brain = scriptedBrain([{ title: "See the forum", intent: "Wait for the page", check: { kind: "title_contains", text: "Forex" } }], {});
    const d = dir();
    const t0 = Date.now();
    const { result, save } = await runTest({ goal: "See the forum home page", url: at("wall"), dir: d, browser, visitor: true, brain, wallWaitMs: STAYS_MS });
    const took = Date.now() - t0;
    assert.ok(took < STAYS_MS + 2000, `it waited no longer than it was given (${took}ms)`);
    assert.equal(brain.planned, 0, "no AI asked to plan a wall");
    assert.equal(brain.decided, 0);
    assert.equal(result.verdict, "blocked");
    assert.equal(VERDICT_EXIT[result.verdict], 4);
    assert.equal(result.botWall, CLOUDFLARE);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]!.verdict, "blocked");
    assert.equal(result.steps[0]!.reason, "the site's bot check (Cloudflare's bot check) stopped the browser; Context Machines doesn't get past bot checks");
    assert.ok(result.steps[0]!.screenshot && existsSync(join(d, result.steps[0]!.screenshot)), "the photo is kept");
    assert.ok(result.friction.some((f) => f.kind === "bot_check" && /^A bot check stood in front of the site/.test(f.says)));
    assert.equal(save, undefined);
    assert.equal(site.clicked, 0);
    // The report says it plainly, in amber, not as a FAIL; the site's words stay escaped.
    const html = testReportPage({ ...result, goal: "<b>x</b>" }, { dir: d });
    assert.match(html, /<span class="verdict blocked">BLOCKED<\/span>/);
    assert.match(html, new RegExp(`<p class="wall"><b>${BLOCKED_BY_WALL.replace("'", "&#39;")}</b> \\(Cloudflare&#39;s bot check\\)`));
    assert.doesNotMatch(html, /<b>x<\/b>/);
  });

  it("after an action: the step that led there is BLOCKED and the steps after it don't run", async () => {
    const brain = scriptedBrain([
      { title: "Open the members page", intent: "Click Members", check: { kind: "text_visible", text: "Members area" } },
      { title: "Open deals", intent: "Click Deals", check: { kind: "text_visible", text: "Deals of the day" } },
    ], { 1: [{ pick: "click", role: "link", name: "Members" }] });
    const { result } = await runTest({ goal: "Open the members page, then the deals", url: site.url, dir: dir(), browser, visitor: true, brain, wallWaitMs: STAYS_MS, checkWaitMs: 300 });
    assert.equal(result.verdict, "blocked");
    assert.equal(result.botWall, CLOUDFLARE);
    assert.deepEqual(result.steps.map((s) => s.verdict), ["blocked", "skipped"]);
    assert.match(result.steps[0]!.reason ?? "", /^the site's bot check \(Cloudflare's bot check\) stopped the browser/);
    assert.equal(brain.decided, 1, "no AI asked again once the wall stood");
    assert.equal(site.clicked, 0);
  });

  it("a replay meets it at the start: the first step BLOCKED, the rest not run", async () => {
    const saved = { version: 1 as const, savedAt: new Date().toISOString(), goal: "See the deals", url: at("wall"), steps: [
      { title: "Open deals", intent: "Click Deals", check: { kind: "text_visible" as const, text: "Deals of the day" }, actions: [] },
      { title: "See them", intent: "Look", check: { kind: "text_visible" as const, text: "Deals" }, actions: [] },
    ] };
    const { result } = await runTest({ goal: saved.goal, url: saved.url, dir: dir(), browser, saved, wallWaitMs: STAYS_MS });
    assert.equal(result.verdict, "blocked");
    assert.deepEqual(result.steps.map((s) => s.verdict), ["blocked", "skipped"]);
    assert.equal(result.botWall, CLOUDFLARE);
  });

  it("a check that takes about 5.5s to clear, under the default ~10s wait: met again in the recorded browser (the look's clearance went with its context), waited out again, and the run passes", async () => {
    const brain = scriptedBrain([{ title: "Open about", intent: "Click About", check: { kind: "text_visible", text: "About Fixture Shop" } }], { 1: [{ pick: "click", role: "link", name: "About" }] });
    const { result } = await runTest({ goal: "Open the about page", url: at("slow"), dir: dir(), browser, visitor: true, brain, checkWaitMs: 1000 });
    assert.equal(result.botWall, undefined, JSON.stringify(result.steps));
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
    assert.equal(brain.planned, 1);
  });

  it("a same-origin 'Press & Hold' over a page of its own (not found as a wall) is never pressed: the step ends BLOCKED as a bot check", async () => {
    const before = site.clicked;
    assert.equal(await (async () => {
      const { context, page: p } = await opened("hold");
      try {
        return await botWall(p);
      } finally {
        await context.close();
      }
    })(), undefined, "the detector doesn't see it: the second layer has to hold");
    const brain = scriptedBrain([{ title: "Read the news", intent: "Close the box and read", check: { kind: "text_visible", text: "Story 3" } }], { 1: [{ pick: "click", role: "button", name: "Press & Hold" }] });
    const { result } = await runTest({ goal: "Read the news", url: at("hold"), dir: dir(), browser, visitor: true, brain, wallWaitMs: STAYS_MS, checkWaitMs: 300 });
    assert.equal(site.clicked, before, "the button was never pressed");
    assert.equal(result.verdict, "blocked", JSON.stringify(result.steps));
    assert.equal(result.steps[0]!.reason, wallReason(A_CHALLENGE));
    assert.equal(result.botWall, A_CHALLENGE);
    assert.ok(result.friction.some((f) => f.kind === "bot_check"));
  });

  it("the actor is told never to press a bot check, and the words of one are refused whatever the page", () => {
    assert.match(ACT_SYSTEM, /Never press, tick or hold anything of a bot check or CAPTCHA/);
    for (const name of ["Verify you are human", "I'm not a robot", "I am not a bot", "Press & Hold", "Press and hold to confirm", "I am human"]) assert.match(refusedName(name) ?? "", /belongs to a bot check/, name);
    for (const name of ["Press and hold to talk", "Human resources", "Robots in film", "CAPTCHA"]) assert.equal(refusedName(name), undefined, name);
  });

  it("a check that clears by itself is waited out, and the run carries on normally", async () => {
    const brain = scriptedBrain([{ title: "Open about", intent: "Click About", check: { kind: "text_visible", text: "About Fixture Shop" } }], { 1: [{ pick: "click", role: "link", name: "About" }] });
    const { result } = await runTest({ goal: "Open the about page", url: at("clears"), dir: dir(), browser, visitor: true, brain, checkWaitMs: 1000 });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
    assert.equal(result.botWall, undefined);
    assert.equal(brain.planned, 1);
  });
});

/** The options runFromUrl takes, with a scripted AI and nothing interactive. */
function urlOptions(ai: Ai, extra: Partial<UrlOptions> = {}): UrlOptions & { said: string[]; out: NodeJS.WriteStream & { text: string } } {
  const outDir = join(dir(), "cm");
  const said: string[] = [];
  const out = sink();
  return {
    url: site.url, outDir, testsDir: join(outDir, "tests"), ai, vars: {}, mask: (s) => s, out, c: colors(false), json: false,
    maxActions: 25, allowHosts: [], headed: false, noCache: false, suggest: false, all: false, explore: false, wallWaitMs: STAYS_MS,
    usage: (w) => (said.push(`usage: ${w}`), 2), couldNot: (w) => (said.push(`couldNot: ${w}`), 3),
    input: { isTTY: false } as never, said, ...extra,
  } as UrlOptions & { said: string[]; out: NodeJS.WriteStream & { text: string } };
}

const MEMBERS = "Open the members page and see the members area";
const ABOUT = "Open the about page";
const DEALS = "Open the deals page";
const PLANS = {
  [MEMBERS]: { steps: [{ title: "Open members", intent: "Click Members", check: { kind: "text_visible", text: "Members area" } }] as PlannedStep[], moves: { 1: [{ pick: "click", role: "link", name: "Members" }] } as Record<number, Move[]> },
  [ABOUT]: { steps: [{ title: "Open about", intent: "Click About", check: { kind: "text_visible", text: "About Fixture Shop" } }] as PlannedStep[], moves: { 1: [{ pick: "click", role: "link", name: "About" }] } as Record<number, Move[]> },
  [DEALS]: { steps: [{ title: "Open deals", intent: "Click Deals", check: { kind: "text_visible", text: "Deals of the day" } }] as PlannedStep[], moves: { 1: [{ pick: "click", role: "link", name: "Deals" }] } as Record<number, Move[]> },
};
const TASKS = [{ goal: MEMBERS, area: "account" }, { goal: ABOUT, area: "navigation" }, { goal: DEALS, area: "shopping" }];

describe("a task list on a site whose bot check stops a task", () => {
  it("--pick: the tasks after it aren't started, said as not run; BLOCKED, not FAIL; exit 4; no AI spent on them", async () => {
    const ai = fakeAi(TASKS, PLANS);
    const o = urlOptions(ai);
    writeSuggested(suggestedPathFor(o.outDir, site.url), site.url, tasksFrom({ tasks: TASKS }));
    const exit = await runFromUrl({ ...o, pick: "1,2,3" });
    assert.equal(exit, TEST_EXIT.unsure, `${o.said.join("\n")}\n${o.out.text}`);
    assert.match(o.out.text, /■ BLOCKED .*\n {4}■ Blocked by the site's bot check \(Cloudflare's bot check\) · Context Machines doesn't get past bot checks/);
    assert.match(o.out.text, /Task 2\/3 {2}Open the about page · not run: the site's bot check stopped the browser/);
    assert.match(o.out.text, /Task 3\/3 {2}Open the deals page · not run: the site's bot check stopped the browser/);
    assert.match(o.out.text, /Tests {2}0 passed · 0 failed · 0 not sure · 1 blocked · 2 not run/);
    assert.match(o.out.text, /2 tasks not run: the site's bot check stopped the browser\n/);
    assert.doesNotMatch(o.out.text, /FAIL/);
    assert.ok(!ai.asked.some((a) => /^Goal(?: of the whole test)?: Open the (about|deals) page$/m.test(a.question)), "no AI asked for the tasks not run");
    assert.equal(site.clicked, 0);
  });

  it("--explore: the site page says Blocked by the site's bot check, and the rest are not run", async () => {
    const ai = fakeAi(TASKS, PLANS);
    const o = urlOptions(ai, { explore: true });
    const exit = await runFromUrl(o);
    assert.equal(exit, TEST_EXIT.unsure, `${o.said.join("\n")}\n${o.out.text}`);
    const pageFile = /Site {2}\s+(\S+index\.html)/.exec(o.out.text)?.[1];
    assert.ok(pageFile, o.out.text);
    const runs = join(o.outDir, "runs");
    const explore = readdirSync(runs).find((f) => f.includes("-explore-"))!;
    const html = readFileSync(join(runs, explore, "index.html"), "utf8");
    assert.match(html, /<span class="verdict blocked">BLOCKED<\/span>/);
    assert.match(html, /Blocked by the site&#39;s bot check \(Cloudflare&#39;s bot check\)/);
    assert.equal((html.match(/NOT RUN/g) ?? []).length, 2);
    const json = JSON.parse(readFileSync(join(runs, explore, "explore.json"), "utf8")) as { tasks: { verdict: string; why?: string; botWall?: string }[] };
    assert.deepEqual(json.tasks.map((t) => t.verdict), ["blocked", "not_run", "not_run"]);
    assert.equal(json.tasks[1]!.why, WALL_NOT_RUN);
    // The page needs no browser, and every word in it is escaped.
    const evil = explorePage(site.url, [{ task: { goal: "<img src=x>", area: "x" }, n: 1, ms: 1, result: { goal: "", url: site.url, verdict: "blocked", steps: [], passed: 0, ms: 1, startedAt: "", actions: 0, friction: [], botWall: "<b>wall</b>" } }], { ms: 1, dir: join(runs, explore) });
    assert.doesNotMatch(evil, /<img src=x>|<b>wall<\/b>/);
  });
});

describe("the saved tests of a site whose bot check stops one", () => {
  it("the terminal suite starts no more tests on that host: said as not run, BLOCKED not FAIL, exit 4", async () => {
    const d = dir();
    const outDir = join(d, "cm");
    const testsDir = join(outDir, "tests");
    const wallGoal = "Check the members page";
    const dealsGoal = "Open the deals page";
    const wallFile = savedPathFor(testsDir, wallGoal, at("wall"));
    const dealsFile = savedPathFor(testsDir, dealsGoal, at("deals"));
    writeSaved(wallFile, { goal: wallGoal, url: at("wall"), steps: [{ title: "See members", intent: "Look", check: { kind: "text_visible", text: "Members area" }, actions: [] }] });
    writeSaved(dealsFile, { goal: dealsGoal, url: at("deals"), steps: [{ title: "See deals", intent: "Look", check: { kind: "text_visible", text: "Deals of the day" }, actions: [] }] });
    const dealsAt = statSync(dealsFile).mtimeMs;
    const out = sink();
    const said: string[] = [];
    const exit = await runSuite({ outDir, testsDir, vars: {}, mask: (w) => w, ai: undefined, out, c: colors(false), json: false, signedOut: true, minutes: 2, maxActions: 25, allowHosts: [], headed: false, wallWaitMs: STAYS_MS,
      usage: (w) => (said.push(w), 2), couldNot: (w) => (said.push(w), 3) });
    assert.equal(exit, TEST_EXIT.unsure, `${said.join("\n")}\n${out.text}`);
    assert.match(out.text, /Blocked by the site's bot check \(Cloudflare's bot check\)/);
    assert.match(out.text, /open-the-deals-page .*· not run: the site's bot check stopped the browser/);
    assert.match(out.text, /0 passed · 0 failed · 0 not sure · 1 blocked · 1 not run/);
    assert.match(out.text, /1 test not run: the site's bot check stopped the browser/);
    assert.doesNotMatch(out.text, /FAIL/);
    assert.equal(statSync(dealsFile).mtimeMs, dealsAt, "the test not run was left as it was");
    assert.equal(readdirSync(join(outDir, "runs")).length, 1, "only the walled test opened the browser");
  });
});

describe("the tasks suggested", () => {
  it("drop any task about waiting for or passing a security verification, a CAPTCHA, 'verify you are human' or a bot check", () => {
    const kept = tasksFrom({ tasks: [
      { goal: "Open the home page, wait for the 'Performing security verification' check to finish, and see the forum home page title", area: "home" },
      { goal: "Wait for the security check to finish and open the calendar", area: "calendar" },
      { goal: "Pass the CAPTCHA and open the forum", area: "forum" },
      { goal: "Verify you are human and see the news", area: "news" },
      { goal: "Get past the bot check and open the market page", area: "market" },
      { goal: "Tick I'm not a robot and open the forum", area: "forum" },
      { goal: "Tick the box that says I am not a bot, then see the home page", area: "home" },
      { goal: "Click the checkbox in the challenge widget and see the forum home", area: "forum" },
      { goal: "Wait for the Turnstile check to finish and see the shop", area: "shop" },
      { goal: "Open the calendar page and see this week's events", area: "calendar" },
      { goal: "Read the article about how CAPTCHAs work", area: "article" },
      { goal: "Click the 'CAPTCHA' entry in the glossary and see its definition page", area: "glossary" },
    ] }, { host: "www.example.com" });
    assert.deepEqual(kept.map((t) => t.goal), ["Open the calendar page and see this week's events", "Read the article about how CAPTCHAs work", "Click the 'CAPTCHA' entry in the glossary and see its definition page"]);
  });

  it("the suggest prompt says never to suggest them", () => {
    assert.match(SUGGEST_SYSTEM, /Never suggest waiting for, passing or solving a security verification, a CAPTCHA, a "verify you are human" check or any other bot check/);
  });
});

describe("the web view", () => {
  it("the start screen shows the bot check as a card with its photo, not a red FAIL, and nothing is suggested", async () => {
    const ai = fakeAi(TASKS, PLANS);
    const d = dir();
    const outDir = join(d, "cm");
    const ui: UiServer = await startUi({ outDir, testsDir: join(outDir, "tests"), ai, vars: {}, mask: (s) => s, allowHosts: [], headed: false, maxActions: 25, wallWaitMs: STAYS_MS });
    const context = await browser.newContext();
    try {
      const p = await context.newPage();
      await p.goto(ui.url.replace("/?t=", "/classic?t=")); // the classic page moved to /classic when / became the app
      await p.fill("#url", at("wall"));
      await p.click("#suggest");
      await p.locator("#wallbox").waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(await p.locator("#walltitle").textContent(), "Blocked by the site's bot check");
      assert.match((await p.locator("#wallwords").textContent()) ?? "", /checks for bots \(Cloudflare's bot check\) and didn't let the test browser in\. Context Machines doesn't get past bot checks\./);
      assert.match((await p.locator("#wallshot").getAttribute("src")) ?? "", /^data:image\/jpeg;base64,/);
      assert.equal(await p.locator("#wallshot").isVisible(), true);
      assert.equal(await p.locator("#tasksbox").isVisible(), false);
      assert.equal(await p.locator("#error").isVisible(), false);
      assert.equal(await p.locator("#wallbox .badge").textContent(), "BLOCKED");
      assert.equal(ai.asked.length, 0);
      assert.equal(site.clicked, 0);
    } finally {
      await context.close();
      await ui.close();
    }
  });
});

describe("no stealth, no evasion", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scanner = join(here, "../packages/scanner/src");
  const tester = join(scanner, "tester");
  /** Every non-test .ts under a folder, its subfolders too (a new file or folder is checked without a change here). */
  const tsUnder = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) return [];
    const path = join(root, e.name);
    if (e.isDirectory()) return tsUnder(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") ? [path] : [];
  });
  // Comments may name what is never done (botwall.ts states the rule); only code counts.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  // apps/action too: the CI action's code moved there from cli/ci (wave2) and keeps the same guard.
  const everywhere = [...tsUnder(here), ...tsUnder(scanner), ...tsUnder(join(here, "../action"))];
  /** The tester's own code: its folder, and the CLI files that run tests, show them or ask the AI. */
  const testerFiles = [...tsUnder(tester), ...tsUnder(here).filter((f) => /[\\/](test-[\w-]+|ui-[\w-]+|ai|botwall)\.ts$/.test(f))];
  /** Evasion of any kind, anywhere in the CLI or the scanner. */
  const EVASION = [
    /web\W{0,8}driver/i, /stealth/i, /AutomationControlled/, /disable-blink-features/i, /ignoreDefaultArgs/, /(playwright|puppeteer)-extra/i,
    /2captcha|anti-?captcha|capsolver|capmonster|nopecha/i, /solve\w*\W{0,3}captcha|captcha\W{0,3}solv/i,
    /defineProperty\s*\(\s*(window\.|globalThis\.)?navigator\b/, /navigator\s*\)?\s*\[/, /sec-ch-ua/i, /Mozilla\/5\.0/, /frameLocator/, /setExtraHTTPHeaders/,
    /launchPersistentContext|connectOverCDP/,
  ];
  /** A challenge's own frames and controls, named by address or selector: only the detector (botwall.ts) may name them. */
  const CHALLENGE_PARTS = /challenges\.cloudflare\.com|hcaptcha\.com|google\.com\/recaptcha|recaptcha\.net|captcha-delivery\.com|#challenge-|cf-turnstile|px-captcha|g-recaptcha|h-captcha/i;
  /**
   * Who may name those parts: the two detectors (botwall.ts finds a wall, detect-botwall.ts names the
   * provider), and the practice site that imitates the widgets (cli/app/sites/protect.ts). Each by
   * its exact path, never a folder: a driver beside them gets no pass. Every file still meets every EVASION check.
   */
  const MAY_NAME = [join(tester, "botwall.ts"), join(tester, "detect-botwall.ts"), join(here, "app", "sites", "protect.ts")];
  const MAY_NAME_PARTS = (file: string) => MAY_NAME.includes(file);
  /** The cover: a file that may add an init script (it draws over the recorded page; nothing more). */
  const COVER = join(tester, "cover.ts");
  /** W5: the other one, by its exact path: every shadow root made open, so a closed one is read like an open one (as e2e does). */
  const SHADOW = join(tester, "shadow.ts");
  /** What the tester's code never sets, though the scanner's honest user agent (its own name added) may. */
  const TESTER_ONLY = [/user-?agent/i, /user_agent/i, /fingerprint/i, /addInitScript/, /\bchannel\s*:/];

  it("no evasion anywhere in the CLI or the scanner, no challenge part named outside the detector, and the tester sets no user agent or init script", () => {
    assert.ok(everywhere.some((f) => f.endsWith("contextmachines.ts")) && everywhere.some((f) => f.endsWith("botwall.ts")), "the files are found");
    for (const file of everywhere) {
      const text = code(readFileSync(file, "utf8"));
      for (const re of EVASION) assert.doesNotMatch(text, re, `${file} matches ${re}`);
      if (!MAY_NAME_PARTS(file)) assert.doesNotMatch(text, CHALLENGE_PARTS, `${file} names a challenge's frame or control`);
    }
    // The list is exact: a stray file named like the detector gets no pass.
    assert.ok(!MAY_NAME_PARTS(join(tester, "evade-botwall.ts")) && !MAY_NAME_PARTS(join(here, "botwall.ts")) && !MAY_NAME_PARTS(join(here, "app", "engine", "protect", "detect-botwall.ts")) && !MAY_NAME_PARTS(join(here, "bench", "pay", "driver.ts")) && !MAY_NAME_PARTS(join(here, "app", "sites", "person.ts")));
    for (const file of testerFiles) {
      const text = code(readFileSync(file, "utf8"));
      // One file by its exact path may add an init script: the cover (cover.ts), which draws a card and a
      // mask style sheet over the recorded page so no frame shows a stored value. It changes nothing a site
      // could read about the browser: checked below, word by word.
      for (const re of TESTER_ONLY) if (!((file === COVER || file === SHADOW) && re.source === "addInitScript")) assert.doesNotMatch(text, re, `${file} matches ${re}`);
    }
    const cover = code(readFileSync(COVER, "utf8"));
    assert.equal(cover.match(/addInitScript\(/g)?.length, 1, "the cover adds its own script (the mask, the guard, the card), in one place, and nothing else");
    assert.match(cover, /addInitScript\(install, args\)/);
    for (const word of [/\bnavigator\b/, /\bdefineProperty\b/, /\bObject\.(?:assign|setPrototypeOf)\b/, /\bwindow\.chrome\b/, /\bplugins\b/, /\bpermissions\b/, /\bscreen\.\w/, /\bdevicePixelRatio\b/, /\bHTMLCanvasElement\b|\bWebGL/, /\bDate\.prototype|\bIntl\b/, /\bfetch\b|XMLHttpRequest|sendBeacon/]) {
      assert.doesNotMatch(cover, word, `cover.ts touches ${word}`);
    }
    // W5: shadow.ts adds one script, openShadowRoots, which only wraps attachShadow; it touches nothing else a site could read.
    const shadow = code(readFileSync(SHADOW, "utf8"));
    assert.equal(shadow.match(/addInitScript\(/g)?.length, 1, "shadow.ts adds one script, in one place");
    assert.match(shadow, /addInitScript\(openShadowRoots\)/);
    const script = /export function openShadowRoots\(\): void \{([\s\S]*?)\n\}/.exec(shadow)?.[1] ?? "";
    assert.match(script, /Element\.prototype\.attachShadow = function/);
    assert.doesNotMatch(script.replace(/Element\.prototype\.attachShadow/g, ""), /\.prototype\b/, "it changes no other prototype");
    for (const word of [/\bnavigator\b/, /\bdefineProperty\b/, /\bObject\.(?:assign|setPrototypeOf)\b/, /\bwindow\.chrome\b/, /\bplugins\b/, /\bpermissions\b/, /\bscreen\.\w/, /\bdevicePixelRatio\b/, /\bHTMLCanvasElement\b|\bWebGL/, /\bDate\.prototype|\bIntl\b/, /\bfetch\b|XMLHttpRequest|sendBeacon/, /toString/]) {
      assert.doesNotMatch(script, word, `openShadowRoots touches ${word}`);
    }
  });

  it("the browser is launched, and its contexts made, with an allowlisted set of options only", () => {
    // W5: locale and timezoneId, only ever the person's own --locale/--timezone (record.ts placeOptions, checked below).
    const allowed = new Set(["handleSIGINT", "handleSIGTERM", "handleSIGHUP", "headless", "chromiumSandbox", "viewport", "width", "height", "recordVideo", "dir", "size", "storageState", "acceptDownloads", "serviceWorkers", "locale", "timezoneId"]);
    /** The text of a call's arguments, its parentheses balanced. */
    const argsAt = (text: string, open: number) => {
      let depth = 0;
      for (let k = open; k < text.length; k++) {
        if (text[k] === "(") depth++;
        else if (text[k] === ")" && --depth === 0) return text.slice(open + 1, k);
      }
      return text.slice(open + 1);
    };
    let calls = 0;
    for (const file of [...testerFiles, ...tsUnder(here)]) {
      const text = code(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/\b(?:chromium\.launch|\.newContext)\s*\(/g)) {
        calls++;
        let args = argsAt(text, m.index! + m[0].length - 1);
        // A spread of a named object is that object's own keys, written out in the same file.
        for (const spread of args.matchAll(/\.\.\.([A-Za-z_$][\w$]*)\b(?!\s*[.?(])/g)) {
          const def = new RegExp(`const ${spread[1]}\\s*=\\s*\\{([^}]*)\\}`).exec(text);
          assert.ok(def, `${file}: a spread of ${spread[1]} into a browser launch or context, whose keys can't be read`);
          args += `, ${def[1]}`;
        }
        for (const key of args.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g)) assert.ok(allowed.has(key[1]!), `${file}: the browser is given '${key[1]}', which isn't allowlisted`);
      }
    }
    assert.ok(calls >= 4, `the launch and context calls are found (${calls})`);
    // W5: the place a run is given is the person's own: placeOptions passes locale and timezoneId from it, and nothing else.
    const rec = code(readFileSync(join(tester, "record.ts"), "utf8"));
    const place = /export function placeOptions\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(rec)?.[1] ?? "";
    assert.ok(place, "placeOptions is found");
    for (const key of place.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) assert.ok(["locale", "timezoneId"].includes(key[1]!), `placeOptions gives '${key[1]}'`);
  });

  it("would catch the evasions a review tried", () => {
    const tries = [
      `context.addInitScript(() => Object.defineProperty(navigator, "plugins", { get: () => [1] }))`,
      `page.setExtraHTTPHeaders({ "sec-ch-ua": "x" })`,
      `globalThis[nav]["web" + "driver"] = false`,
      `const ua = "Mozilla/5.0 (Macintosh)"`,
      `page.locator("#challenge-stage input[type=checkbox]").click()`,
      `page.frameLocator("iframe[src*=challenges]").locator("input").check()`,
    ];
    for (const t of tries) assert.ok([...EVASION, CHALLENGE_PARTS, ...TESTER_ONLY].some((re) => re.test(code(t))), t);
  });
});
