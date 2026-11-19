// The web view's Test accounts panel and signed-in runs (AUTH C20a, C20b), driven in a real browser:
// an account is added through the panel, its password and authenticator secret set, and three
// signed-in tests run from the page with no terminal step. The bars: 0 secret hits in the page, every
// route's answer and the event stream; 3/3 pass; no frame of the live screen sent while signing in.
// Offline: the local auth fixture, a scripted AI, a file store (never the Keychain).
//   node --test cli/ui-accounts.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import type { PlannedStep } from "../packages/scanner/src/tester/types.ts";
import { fileStore, isMine, secretsPathFor, signInAllowed } from "./accounts.ts";
import type { Ai } from "./ai.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { leakHits } from "./leak.ts";
import { ACT_SYSTEM, PLAN_SYSTEM } from "./test-command.ts";
import { startUi, type UiServer } from "./ui-server.ts";

const USER = "qa.ui.u7c1e9@example.test";
const PASSWORD = "pw-LEAK-ui" + "-7c1e9a5Fq";
const TOTP = "JBSWY3DPEHPK3PXPLEAKUIZCREQXAFQZ";

type Move = { click: string; role?: string } | { fill: string; value: string } | "done";
const SIGN_IN = "Sign in with {admin.username} and {admin.password}";
const GOALS: Record<string, { steps: PlannedStep[]; moves: Record<number, Move[]> }> = {
  [SIGN_IN]: { steps: [{ title: "Sign in", intent: "Fill the email and password and press Sign in", check: { kind: "text_visible", text: "Sign out" } }], moves: { 1: [{ fill: "Email", value: "{admin.username}" }, { fill: "Password", value: "{admin.password}" }, { click: "Sign in", role: "button" }] } },
  "Open Account settings": { steps: [{ title: "Open Account settings", intent: "Click Account settings", check: { kind: "text_visible", text: "Plan: Free" } }], moves: { 1: [{ click: "Account settings" }] } },
  "Open Reports": { steps: [{ title: "Open Reports", intent: "Click Reports", check: { kind: "text_visible", text: "No reports yet" } }], moves: { 1: [{ click: "Reports" }] } },
  "See the dashboard": { steps: [{ title: "See the dashboard", intent: "Look at the dashboard", check: { kind: "text_visible", text: "Welcome back" } }], moves: { 1: ["done"] } },
};

/** A scripted AI: plans and acts by goal, and keeps every question it was asked (for the leak check). */
function fakeAi(asked: string[]): Ai {
  const left = new Map<string, Record<string, Move[]>>();
  const refOf = (snapshot: string, name: string, role = "\\w+") => new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(snapshot)?.[1] ?? "e9999";
  return {
    via: "a scripted AI",
    async ask(system: string, question: string) {
      asked.push(question);
      const goal = /^Goal(?: of the whole test)?: (.*)$/m.exec(question)?.[1] ?? "";
      // The account's sign-in, whatever it adds (an authenticator code, once its secret is set).
      const plan = GOALS[goal] ?? (goal.startsWith("Sign in with {admin.username}") ? GOALS[SIGN_IN] : undefined);
      if (system === PLAN_SYSTEM) {
        // Each new plan of a goal acts afresh.
        if (plan) left.set(goal, Object.fromEntries(Object.entries(plan.moves).map(([n, m]) => [n, [...m]])));
        return { text: JSON.stringify({ steps: plan?.steps.map((s) => ({ ...s, check: { text: "", role: "", name: "", ...s.check } })) ?? [] }) };
      }
      if (system === ACT_SYSTEM) {
        const n = Number(/^Step (\d+) of/m.exec(question)?.[1]);
        const move = left.get(goal)?.[n]?.shift() ?? "done";
        const snapshot = question.slice(question.indexOf("<page_snapshot"));
        const base = { ref: "", value: "", key: "", direction: "", url: "", ms: 0, why: "" };
        const a = move === "done" ? { action: "done" } : "click" in move ? { action: "click", ref: refOf(snapshot, move.click, move.role) } : { action: "fill", ref: refOf(snapshot, move.fill), value: move.value };
        return { text: JSON.stringify({ ...base, ...a }) };
      }
      throw new Error(`unexpected ask: ${system.slice(0, 40)}`);
    },
  } as unknown as Ai;
}

/** The event stream, read as the page reads it, every line kept in order. */
function listen(ui: UiServer) {
  const seen: Record<string, unknown>[] = [];
  let raw = "";
  const req = request({ host: "127.0.0.1", port: ui.port, path: `/events?t=${ui.token}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      raw += c;
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (data) seen.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return {
    seen,
    raw: () => raw,
    close: () => req.destroy(),
    async until(want: (e: Record<string, unknown>) => boolean, ms = 120_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (seen.some(want)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no such event; saw ${seen.map((e) => e.type).join(", ")}`);
    },
  };
}

let browser: Browser;
let site: AuthSite;
let ui: UiServer;
const dir = mkdtempSync(join(tmpdir(), "cm-ui-acct-"));
const project = join(dir, "project");
const outDir = join(project, "contextmachines");
const asked: string[] = [];

before(async () => {
  mkdirSync(project, { recursive: true });
  browser = await launch(false);
  site = await startAuthSite({ users: [{ username: USER, password: PASSWORD }] });
  ui = await startUi({ outDir, testsDir: join(outDir, "tests"), ai: fakeAi(asked), vars: {}, mask: makeMasker(), allowHosts: [], headed: false, maxActions: 25, checkWaitMs: 2000, projectDir: project, store: fileStore(secretsPathFor(outDir)), env: {} });
});
after(async () => {
  await ui?.close();
  await site?.close();
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every answer the page got from the server's /api routes, as text. */
function answers(page: Page) {
  const got: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/api/")) void r.text().then((t) => got.push(`${r.url()} ${t}`), () => {});
  });
  return got;
}

describe("C20a: the Test accounts panel", () => {
  it("adds an account, sets its password and authenticator secret, and no value is ever in the page, an answer or the event stream", async () => {
    const ev = listen(ui);
    const page = await browser.newPage();
    const got = answers(page);
    try {
      await page.goto(ui.url.replace("/?t=", "/classic?t=")); // the classic page moved to /classic when / became the app
      const appUrl = new URL("/app", site.url).href;
      await page.locator("#url").fill(appUrl);
      await page.locator("#url").dispatchEvent("change");
      await page.locator("#acctbtn").click();
      // Not yours and not said: no account form, only the question "it's my own account".
      await page.locator("#notok").waitFor();
      assert.equal(await page.locator("#mine").isHidden(), true);
      assert.match(await page.locator("#notok").innerText(), /I'm signing in with my own account on 127\.0\.0\.1:\d+\. The tester still won't post, pay, send or delete there\./);
      await page.getByRole("button", { name: "Yes, it's my own account" }).click();
      await page.locator("#mine").waitFor();
      // Said, never "mine": sign-ups, payments and site access stay off there.
      assert.equal(isMine(outDir, new URL(site.url).host), false, "the acknowledgement doesn't make the host yours");
      assert.equal(signInAllowed(outDir, new URL(site.url).host), true);
      await page.locator("#a-label").fill("admin");
      await page.locator("#a-first").selectOption("password");
      await page.locator("#a-username").fill(USER);
      await page.locator("#a-page").fill("/login");
      await page.locator("#a-signedin").fill("Sign out");
      await page.locator("#a-when").fill("The fixture app's only user.");
      await page.locator("#a-save").click();
      await page.locator("#acctlist li").first().waitFor();
      await page.locator("#a-password").fill(PASSWORD);
      await page.locator("#a-pwbtn").click();
      await page.getByText("(set · type a new one to change it)").waitFor();
      await page.locator("#a-totp").fill(TOTP);
      await page.locator("#a-totpbtn").click();
      await page.locator("#a-totpset").getByText("(set)").waitFor();
      assert.equal(await page.locator("#a-password").inputValue(), "", "the field is emptied once it is sent");
      // Stored, and the config holds no value: only where each is.
      const store = fileStore(secretsPathFor(outDir));
      const host = new URL(site.url).host;
      assert.equal(store.get(`${host}/admin/password`), PASSWORD);
      assert.equal(store.get(`${host}/admin/totp`), TOTP);
      const config = readFileSync(join(project, "contextmachines.config.json"), "utf8");
      assert.deepEqual(JSON.parse(config).accounts.admin.password, { keychain: true });
      assert.deepEqual(JSON.parse(config).accounts.admin.totp, { keychain: true });
      // The 0-hits bar: the page as it is now, every answer, the event stream.
      await page.waitForTimeout(300);
      const places = [{ where: "page HTML", text: await page.content() }, { where: "route answers", text: got.join("\n") }, { where: "event stream", text: ev.raw() }, { where: "config", text: config }];
      assert.ok(got.some((g) => g.includes('"set":true')), "a secret's answer is { set: true }");
      assert.deepEqual(leakHits({ password: PASSWORD, totp: TOTP }, places), []);
      // A host nobody said is theirs keeps nothing, until it is said (and saying it never makes it "mine").
      const post = (path: string, body: Record<string, unknown>) => page.evaluate(async ([token, p, b]) => (await fetch(p as string, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": token as string }, body: JSON.stringify(b) })).status, [ui.token, path, body] as const);
      assert.equal(await post("/api/accounts/secret", { url: site.otherUrl, label: "admin", field: "password", value: "pw-LEAK-other-01" }), 403);
      assert.equal(await post("/api/accounts/signin-ok", { url: site.otherUrl }), 400, "it needs a yes");
      assert.equal(await post("/api/accounts/signin-ok", { url: site.otherUrl, yes: true }), 200);
      assert.equal(await post("/api/accounts/secret", { url: site.otherUrl, label: "admin", field: "password", value: "pw-LEAK-other-01" }), 200);
      assert.equal(isMine(outDir, new URL(site.otherUrl).host), false);
    } finally {
      ev.close();
      await page.close();
    }
  });
});

describe("C20b: signed-in runs from the page", () => {
  it("3 signed-in tests run from the page with the account picked: 3/3 pass, 0 secret hits, and no frame while signing in", async () => {
    const ev = listen(ui);
    const page = await browser.newPage();
    const got = answers(page);
    try {
      await page.goto(ui.url.replace("/?t=", "/classic?t=")); // the classic page moved to /classic when / became the app
      await page.locator("#url").fill(new URL("/app", site.url).href);
      await page.locator("#url").dispatchEvent("change");
      await page.locator("#acctbtn").click();
      await page.locator("#mine").waitFor();
      await page.locator("#acctclose").click();
      await page.locator("#as").selectOption("admin");
      const results: Record<string, unknown>[] = [];
      for (const goal of ["Open Account settings", "Open Reports", "See the dashboard"]) {
        const before = ev.seen.length;
        await page.locator("#goal").fill(goal);
        await page.locator("#rungoal").click();
        await ev.until((e) => e.type === "jobEnd" && ev.seen.indexOf(e) >= before);
        const r = ev.seen.slice(before).find((e) => e.type === "result");
        assert.ok(r, `a result for ${goal}: ${JSON.stringify(ev.seen.slice(before).filter((e) => e.type === "couldnt"))}`);
        results.push(r);
        // Back to the start for the next one.
        await page.locator("#again").click();
      }
      assert.deepEqual(results.map((r) => (r.result as { verdict: string }).verdict), ["pass", "pass", "pass"]);
      // Signed in once (the first test), then from the saved session.
      assert.equal(site.signIns(), 1, "one sign-in for three tests");
      const chips = ev.seen.filter((e) => e.type === "session").map((e) => e.words as string);
      assert.ok(chips.some((w) => /^Signing in as admin/.test(w)) && chips.some((w) => /^Signed in as admin \(session from/.test(w)), JSON.stringify(chips));
      // The sign-in is shown live (its boxes as dots, cover.ts): frames come between its start and its end.
      let signingIn = false;
      let framesWhileSigningIn = 0;
      let signIns = 0;
      for (const e of ev.seen) {
        if (e.type === "signin") {
          signingIn = e.state === "start";
          if (signingIn) signIns++;
        }
        if (e.type === "frame" && signingIn) framesWhileSigningIn++;
      }
      assert.equal(signIns, 3, "each test said when its sign-in began and ended");
      assert.ok(framesWhileSigningIn > 0, "the sign-in's own page was streamed");
      // The live screen says who it signs in as.
      assert.ok(ev.seen.some((e) => e.type === "signin" && e.state === "start" && /^Signing in as admin…$/.test(String(e.words))));
      // The saved tests carry the account they ran as.
      const savedDir = join(outDir, "tests");
      assert.ok(existsSync(savedDir));
      const places = [{ where: "page HTML", text: await page.content() }, { where: "route answers", text: got.join("\n") }, { where: "event stream", text: ev.raw() }, { where: "AI questions", text: asked.join("\n") }];
      assert.deepEqual(leakHits({ password: PASSWORD, totp: TOTP }, places), []);
      // The username is a test address, so the config and the panel may show it; the AI and the run's own words never do.
      assert.deepEqual(leakHits({ username: USER }, places.filter((p) => p.where !== "route answers" && p.where !== "page HTML")), []);
      assert.ok(asked.some((q) => q.includes("{admin.password}")), "the AI was told the handle, not the value");
    } finally {
      ev.close();
      await page.close();
    }
  });

  it("a sign-in that can't happen: the chip says it isn't signed in, never 'Signing in…' left up", async () => {
    // An account with no password stored: blocked before the browser opens (AUTH_CREDENTIAL_UNAVAILABLE).
    const configPath = join(project, "contextmachines.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { accounts: Record<string, unknown> };
    config.accounts.nopw = { first: "password", username: "nopw@example.test", password: { keychain: true }, signedIn: { text: "Sign out" } };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const ev = listen(ui);
    try {
      await new Promise((ok) => setTimeout(ok, 200));
      const before = ev.seen.length;
      const res = await fetch(`${ui.origin}/api/run`, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": ui.token }, body: JSON.stringify({ goal: "See the dashboard", url: new URL("/app", site.url).href, as: "nopw" }) });
      assert.equal(res.status, 202);
      await ev.until((e) => e.type === "jobEnd" && ev.seen.indexOf(e) >= before);
      const chips = ev.seen.slice(before).filter((e) => e.type === "session").map((e) => e.words as string);
      assert.deepEqual(chips.slice(-1), ["Not signed in as nopw"], JSON.stringify(chips));
      // A blocked sign-in is a run of its own (BLOCKED, with its code), never only "couldn't run".
      assert.ok(ev.seen.slice(before).some((e) => (e.type === "couldnt" || e.type === "result") && /AUTH_CREDENTIAL_UNAVAILABLE/.test(JSON.stringify(e))), JSON.stringify(ev.seen.slice(before).filter((e) => e.type === "result")).slice(0, 600));
    } finally {
      ev.close();
    }
  });
});
