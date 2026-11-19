// Login checks the way e2e and TesterArmy do them (decision A1, 2026-11-18), on the local auth fixture:
//   change 8: a run never waits for a person; "Set up sign-in" (Accounts, or accounts setup <label>) is the
//             only wait, once, before the runs. A run whose session is missing or gone ends BLOCKED.
//   change 1: every BLOCKED sign-in in the app is a saved run result (verdict, code, fix, later steps not run).
//   change 2: "confirm it's a new device" pages end BLOCKED DEVICE_CHECK, the password sent once.
//   change 5: a code by text ends BLOCKED SMS_CODE_NEEDED with its own fix.
//   change 3: a sign-in provider's test code (Clerk's 424242), on hosts marked as yours only.
//   change 4: Clerk's Testing Token gets past Clerk's bot protection on your own host; the key goes nowhere else.
// No AI (a scripted brain), no network, no real account.
//   node --test cli/login-parity.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { DEVICE_CHECK_WORDS, deviceCheckIn, verify } from "../packages/scanner/src/tester/check.ts";
import { makeMasker, type Fresh } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { newSignInGuard, runTest } from "../packages/scanner/src/tester/run.ts";
import { SIGN_IN_CODES, type Action, type DecideInput, type TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { accountResolver, AccountConfigError, fileStore, markMine, markSignInOk, parseAccounts, secretsPathFor } from "./accounts.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { accountFor, codeFix, ensureSession, signInByHand, siteAccessFor } from "./signin.ts";
import type { Ai } from "./ai.ts";
import { startUi, type UiServer } from "./ui-server.ts";

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-parity-"));
  temps.push(d);
  return d;
};

const refs = (snapshot: string) => [...snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].map((m) => ({ ref: m[1]!, role: m[2]!, name: m[3]! }));
const find = (snapshot: string, role: RegExp, name: RegExp) => refs(snapshot).find((r) => role.test(r.role) && name.test(r.name))?.ref;

/** A scripted sign-in brain: fills what it sees with the account's names (a texted code as {admin.sms_code}), presses on, never a value. */
function signInBrain(prompts: string[] = [], o: { noCodes?: boolean } = {}): TesterBrain {
  const did = new Set<string>();
  return {
    async plan(goal, url, given, start) {
      prompts.push(JSON.stringify({ goal, url, given, start }));
      return [{ title: "Sign in", intent: goal, check: { kind: "signed_in", text: "Sign out" } }];
    },
    async decide(input: DecideInput): Promise<Action> {
      prompts.push(JSON.stringify(input));
      const s = input.snapshot;
      const once = (key: string, a: Action): Action | undefined => (did.has(`${input.url}|${key}`) ? undefined : (did.add(`${input.url}|${key}`), a));
      const texted = /texted/i.test(s);
      // The real AI may give up at a code it knows it can't have (seen in the CLI probe): stuck, never a guess.
      if (o.noCodes && find(s, /textbox/, /^verification code$/i)) return { type: "stuck", why: "the page asks for a code that was texted to a phone, which can't be typed" } as Action;
      for (const [name, value] of [[/^email$/i, "{admin.username}"], [/^password$/i, "{admin.password}"], [/^verification code$/i, texted ? "{admin.sms_code}" : "{admin.email_code}"]] as const) {
        const ref = find(s, /textbox/, name);
        const a = ref ? once(`fill ${name.source}`, { type: "fill", ref, value }) : undefined;
        if (a) return a;
      }
      const button = find(s, /button/, /^(send code|sign in|verify|continue)$/i);
      const click = button ? once(`click ${button}`, { type: "click", ref: button }) : undefined;
      return click ?? { type: "done" };
    },
  };
}

const USER = "me.parity@example.test";
const PASSWORD = "pw-LEAK-pa" + "rity-7d1e3a";
const CLERK_USER = "me+clerk_test@example.test";
const CLERK_SK = "sk_test_LEAKp" + "arity0c1d2e3f";
const hash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);

let site: AuthSite;
let browser: Browser;
before(async () => {
  site = await startAuthSite({ users: [{ username: USER, password: PASSWORD }], owner: { clerkSecretKey: CLERK_SK } });
  browser = await launch(false);
});
after(async () => {
  await browser?.close();
  await site?.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A project folder with these accounts (and sites), the password stored, the host said OK (or marked yours). */
function project(accounts: Record<string, unknown>, o: { mine?: boolean; sites?: Record<string, unknown> } = {}) {
  const dir = temp();
  writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts, ...(o.sites ? { sites: o.sites } : {}) }));
  const out = join(dir, "contextmachines");
  const store = fileStore(secretsPathFor(out));
  const host = new URL(site.url).host;
  for (const label of Object.keys(accounts)) store.set(`${host}/${label}/password`, PASSWORD);
  if (o.mine) markMine(out, host);
  else markSignInOk(out, host);
  return { dir, out, store, host };
}

async function signIn(p: ReturnType<typeof project>, label: string, o: { env?: NodeJS.ProcessEnv; prompts?: string[]; noCodes?: boolean } = {}) {
  const url = new URL("/app", site.url).href;
  const use = accountFor({ dir: p.dir, outDir: p.out, url, label, store: p.store, env: o.env ?? {} });
  if ("error" in use) return { refused: use };
  const access = await siteAccessFor({ dir: p.dir, outDir: p.out, url, store: p.store, env: o.env ?? {}, clerkApi: site.url });
  assert.equal(access.error, undefined, access.error ?? "");
  const r = await ensureSession({ outDir: p.out, url, account: use.account, resolver: use.resolver, mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(p.out, "runs"), brain: signInBrain(o.prompts ?? [], { noCodes: o.noCodes }), ...(access.owner ? { owner: access.owner } : {}) });
  return { r, account: use.account };
}

// ---------------------------------------------------------------------------------------------

describe("the codes and their fix lines", () => {
  it("DEVICE_CHECK, SMS_CODE_NEEDED and TEST_CODE_NOT_ALLOWED are sign-in codes, each with its own fix", () => {
    for (const c of ["DEVICE_CHECK", "SMS_CODE_NEEDED", "TEST_CODE_NOT_ALLOWED"] as const) assert.ok(SIGN_IN_CODES.includes(c), c);
    const url = "http://127.0.0.1:4567/app";
    assert.match(codeFix("DEVICE_CHECK", { label: "admin" }, url), /confirm a new device.*QA account with this check turned off.*mail catcher.*test mode/);
    assert.match(codeFix("SMS_CODE_NEEDED", { label: "admin" }, url), /texted admin a code.*QA account that doesn't sign in by text.*test mode/);
    assert.match(codeFix("TEST_CODE_NOT_ALLOWED", { label: "admin" }, url), /isn't marked as yours/);
    // Every code that needs a person points at Set up sign-in, never at a pop-up during a run.
    for (const c of ["CODE_NEEDS_PERSON", "AUTH_SESSION_EXPIRED", "SMS_CODE_NEEDED", "DEVICE_CHECK"] as const) {
      const fix = codeFix(c, { label: "admin" }, url);
      assert.match(fix, /Set up sign-in for admin under Accounts|accounts setup admin/, c);
      assert.doesNotMatch(fix, /type it when asked|run the test from the app/i, c);
    }
  });

  it("the device-check words: a 'confirm it's you' page with nothing to type, never a code page", () => {
    for (const t of ["We sent you an email to confirm it's you", "Is this you? Approve this sign-in from your other device", "New device detected: check your email", "Verify it's you"]) assert.ok(DEVICE_CHECK_WORDS.test(t), t);
    for (const t of ["Welcome back", "Enter your code", "Wrong password"]) assert.equal(DEVICE_CHECK_WORDS.test(t), false, t);
  });
});

describe("change 2: confirm a new device", () => {
  it("a password account at /device-check ends BLOCKED DEVICE_CHECK, not AUTH_SESSION_EXPIRED, and the password was sent once", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/device-check", signedIn: { text: "Sign out" } } });
    const before = site.hits().filter((h) => h === "POST /device-check").length;
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.code, "DEVICE_CHECK", r.blocked);
    assert.match(r.blocked, /^DEVICE_CHECK: .*confirm a new device/);
    assert.equal(site.hits().filter((h) => h === "POST /device-check").length - before, 1, "the sign-in was sent once, never again");
    assert.equal(r.result?.verdict, "blocked");
  });

  it("the signed-in check names it too (a saved step that lands there)", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/device-check", site.url).href);
      await page.getByLabel("Email").fill(USER);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByText("Confirm it's you").first().waitFor();
      const v = await verify(page, { kind: "signed_in", text: "Sign out" }, 0);
      assert.equal(v.ok, false);
      assert.match(v.found, /asks to confirm a new device/);
    } finally {
      await page.close();
    }
  });
});

describe("change 5: a code by text", () => {
  it("a password account that meets an SMS code page ends BLOCKED SMS_CODE_NEEDED with the SMS fix; no code is guessed", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/sms", signedIn: { text: "Sign out" } } });
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.code, "SMS_CODE_NEEDED", r.blocked);
    assert.match(r.blocked, /QA account that doesn't sign in by text/);
    assert.match(r.blocked, /test mode/);
    assert.equal(site.refusals("/sms-code"), 0, "no code was typed");
    assert.equal(site.signIns("/sms"), 0);
  });

  it("the same when the AI gives up at the code instead of typing its name: measured on the page, SMS_CODE_NEEDED, never 'expired'", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/sms", signedIn: { text: "Sign out" } } });
    const { r } = await signIn(p, "admin", { noCodes: true });
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.code, "SMS_CODE_NEEDED", r.blocked);
    assert.match(r.blocked, /QA account that doesn't sign in by text/);
  });

  it("an authenticator code page is never taken for a code sent to the person", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/mfa", signedIn: { text: "Sign out" } } });
    // /mfa asks for an authenticator code: never taken for a code sent to the person.
    const { r } = await signIn(p, "admin", { noCodes: true });
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.notEqual(r.code, "CODE_NEEDS_PERSON", "an authenticator's code is made here, not sent to a person");
  });

  it("an sms-code account ends BLOCKED before the browser opens: nothing sent", async () => {
    const p = project({ admin: { first: "sms-code", username: USER, signInPage: "/sms", signedIn: { text: "Sign out" } } });
    const before = site.hits().length;
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r && r.code === "SMS_CODE_NEEDED", JSON.stringify(r).slice(0, 300));
    assert.match(r.blocked, /Set up sign-in for admin/);
    assert.equal(site.hits().length, before, "the site wasn't opened");
  });
});

describe("change 3: a sign-in provider's test code", () => {
  const clerkAccount = { first: "email-code", username: CLERK_USER, signInPage: "/clerk/sign-in", signedIn: { text: "Sign out" }, codes: [{ testCode: "424242" }] };

  it("the config takes { testCode } and refuses a malformed one", () => {
    const a = parseAccounts({ accounts: { c: clerkAccount } }).accounts.get("c")!;
    assert.equal(a.testCode, "424242");
    assert.throws(() => parseAccounts({ accounts: { c: { ...clerkAccount, codes: [{ testCode: "42 42" }] } } }), AccountConfigError);
    assert.throws(() => parseAccounts({ accounts: { c: { ...clerkAccount, codes: [{ testCode: "424242", catcher: "http://127.0.0.1:8025" }] } } }), AccountConfigError);
  });

  it("on a host marked as yours: the test code is typed, it signs in, the session is saved, and no one was asked", async () => {
    const p = project({ admin: clerkAccount }, { mine: true });
    const before = site.signIns("/clerk");
    const { r } = await signIn(p, "admin");
    assert.ok(r && "path" in r, JSON.stringify(r).slice(0, 400));
    assert.equal(site.signIns("/clerk") - before, 1);
    assert.equal(site.refusals("/clerk"), 0);
    assert.ok(existsSync(r.path));
  });

  it("on a host only said OK (not yours): refused before the browser opens, TEST_CODE_NOT_ALLOWED", async () => {
    const p = project({ admin: clerkAccount });
    const before = site.hits().length;
    const got = await signIn(p, "admin");
    assert.ok("refused" in got && got.refused?.code === "TEST_CODE_NOT_ALLOWED", JSON.stringify(got).slice(0, 300));
    assert.match(got.refused?.error ?? "", /isn't marked as yours/);
    assert.equal(site.hits().length, before, "nothing was opened");
  });

  it("the resolver itself never hands the test code out for a host that isn't yours", async () => {
    const a = parseAccounts({ accounts: { admin: clerkAccount } }).accounts.get("admin")!;
    const store = fileStore(secretsPathFor(join(temp(), "cm")));
    const opts = { since: 0, mask: makeMasker(), allowedHosts: ["127.0.0.1:1"], host: "127.0.0.1:1" };
    const notMine = (await accountResolver(a, { host: "127.0.0.1:1", store, env: {} }).fresh!("admin.email_code", opts)) as Fresh;
    assert.ok("code" in notMine && notMine.code === "TEST_CODE_NOT_ALLOWED");
    const mine = (await accountResolver(a, { host: "127.0.0.1:1", store, env: {}, owned: true }).fresh!("admin.email_code", opts)) as Fresh;
    assert.deepEqual(mine, { value: "424242" });
  });
});

describe("change 4: Clerk's Testing Token for bot protection", () => {
  const botAccount = { first: "email-code", username: CLERK_USER, signInPage: "/clerk/bot-sign-in", signedIn: { text: "Sign out" }, codes: [{ testCode: "424242" }] };

  it("without the Clerk key: BLOCKED ACCESS_TOKEN_REQUIRED at the bot check, nothing solved", async () => {
    const p = project({ admin: botAccount }, { mine: true });
    const before = site.signIns("/clerk");
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.code, "ACCESS_TOKEN_REQUIRED", r.blocked);
    assert.equal(site.signIns("/clerk"), before);
    assert.ok(r.result?.protection?.some((f) => f.kind === "clerk_bot" && f.blocking), JSON.stringify(r.result?.protection));
  });

  it("with the key (on your own host): a Testing Token is made, the page lets the form through, and it signs in; the key reaches no other host", async () => {
    const sites = { [new URL(site.url).host]: { clerk: { publishableKey: site.clerkPublishableKey, secretKey: { env: "CM_SITE_CLERK_SECRET_KEY" } } } };
    const p = project({ admin: botAccount }, { mine: true, sites });
    const tokensBefore = site.clerkTokens().length;
    const otherBefore = site.otherLog().length;
    const before = site.signIns("/clerk");
    const { r } = await signIn(p, "admin", { env: { CM_SITE_CLERK_SECRET_KEY: CLERK_SK } });
    assert.ok(r && "path" in r, JSON.stringify(r).slice(0, 400));
    assert.equal(site.signIns("/clerk") - before, 1);
    assert.ok(site.clerkTokens().length > tokensBefore, "a Testing Token was made");
    const other = site.otherLog().slice(otherBefore);
    assert.ok(other.some((x) => x.path === "/v1/client" && x.query.includes("__clerk_testing_token")), "the token went to the Frontend API's /v1/");
    for (const x of other) for (const h of Object.values(x.headers)) assert.notEqual(h, hash(CLERK_SK), `${x.path} got the secret key`);
    for (const x of other) assert.ok(!x.headers.authorization, `${x.path} got an authorization header`);
  });

  it("on a host only said OK (not yours): BLOCKED BOT_CHECK_NEEDS_PERSON, the fix is Set up sign-in, never 'expired'", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/clerk/bot-sign-in", signedIn: { text: "Sign out" } } });
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.code, "BOT_CHECK_NEEDS_PERSON", r.blocked);
    assert.match(r.blocked, /pass the check there yourself once/);
    assert.doesNotMatch(r.blocked, /accounts site clerk/, "no owner setup line for a host that isn't yours");
  });

  it("the key is refused for a host only said OK (never sent there)", async () => {
    const sites = { [new URL(site.url).host]: { clerk: { publishableKey: site.clerkPublishableKey, secretKey: { env: "CM_SITE_CLERK_SECRET_KEY" } } } };
    const p = project({ admin: { ...botAccount, codes: undefined, first: "password", password: { keychain: true } } }, { sites });
    const tokensBefore = site.clerkTokens().length;
    const access = await siteAccessFor({ dir: p.dir, outDir: p.out, url: site.url, store: p.store, env: { CM_SITE_CLERK_SECRET_KEY: CLERK_SK }, clerkApi: site.url });
    assert.equal(access.owner, undefined);
    assert.equal(site.clerkTokens().length, tokensBefore, "no token made for a host that isn't yours");
  });
});

describe("change 8: Set up sign-in, and runs that never wait", () => {
  const codeAccount = { first: "email-code", username: USER, signInPage: "/code", signedIn: { text: "Sign out" } };
  const magicAccount = { first: "magic-link", username: USER, signInPage: "/magic", signedIn: { text: "Sign out" } };
  const latest = (re: RegExp) => [...site.minted()].reverse().find((v) => re.test(v))!;

  it("/code: the person types the code in the window once; a later run reuses it with no one there", async () => {
    const p = project({ admin: codeAccount });
    const a = parseAccounts({ accounts: { admin: codeAccount } }).accounts.get("admin")!;
    const set = await signInByHand({ outDir: p.out, url: new URL("/app", site.url).href, account: a, browser, done: async (page: Page) => {
      await page.getByLabel("Email").fill(USER);
      await page.getByRole("button", { name: "Send code" }).click();
      await page.getByLabel("Verification code").fill(latest(/^\d{6}$/));
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/app/);
      return true;
    } });
    assert.ok("path" in set, JSON.stringify(set));
    const sent = site.minted().length;
    const { r } = await signIn(p, "admin");
    assert.ok(r && "path" in r && r.how === "saved", JSON.stringify(r).slice(0, 300));
    assert.equal(site.minted().length, sent, "no new code was asked for");
  });

  it("/magic: the person opens the link in the window once; with the session deleted, the run ends BLOCKED with the fix, no pop-up, nothing sent", async () => {
    const p = project({ admin: magicAccount });
    const a = parseAccounts({ accounts: { admin: magicAccount } }).accounts.get("admin")!;
    const set = await signInByHand({ outDir: p.out, url: new URL("/app", site.url).href, account: a, browser, done: async (page: Page) => {
      await page.getByLabel("Email").fill(USER);
      await page.getByRole("button", { name: "Send me a link" }).click();
      await page.getByText("Check your email").first().waitFor();
      await page.goto(new URL(`/magic/verify?token=${latest(/^LEAK-/)}`, site.url).href);
      await page.waitForURL(/\/app/);
      return true;
    } });
    assert.ok("path" in set, JSON.stringify(set));
    assert.ok((await signIn(p, "admin")).r && "path" in (await signIn(p, "admin")).r!);
    rmSync(set.path);
    const sent = site.minted().length;
    const hits = site.hits().length;
    const { r } = await signIn(p, "admin");
    assert.ok(r && "blocked" in r && r.code === "CODE_NEEDS_PERSON", JSON.stringify(r).slice(0, 300));
    assert.match(r.blocked, /Set up sign-in for admin under Accounts/);
    assert.equal(site.minted().length, sent);
    assert.equal(site.hits().length, hits, "the site wasn't opened");
  });

  it("Set up sign-in that isn't finished (no signed-in page): nothing is saved", async () => {
    const p = project({ admin: codeAccount });
    const a = parseAccounts({ accounts: { admin: codeAccount } }).accounts.get("admin")!;
    const set = await signInByHand({ outDir: p.out, url: new URL("/app", site.url).href, account: a, browser, done: async () => true });
    assert.ok("error" in set && /doesn't look signed in/.test(set.error), JSON.stringify(set));
    assert.equal(readdirSync(join(p.out, ".auth")).filter((f) => f.includes("@admin.json")).length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Change 1 and 8 in the app: a blocked sign-in is a run result, never only "couldn't run"; and the app's
// "Set up sign-in" opens a window (here a headless one, the person scripted on its page) and saves the session.

function events(ui: UiServer) {
  const seen: Record<string, unknown>[] = [];
  let buf = "";
  const req = request({ host: "127.0.0.1", port: ui.port, path: `/events?t=${ui.token}`, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let k: number;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data) seen.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return {
    seen,
    close: () => req.destroy(),
    async next(want: (e: Record<string, unknown>) => boolean, ms = 60_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const e = seen.find(want);
        if (e) return e;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no such event; saw ${seen.map((e) => e.type).join(", ")}`);
    },
  };
}

describe("change 1 and 8 in the app", () => {
  async function app(accounts: Record<string, unknown>, o: { mine?: boolean; launch?: () => Promise<Browser> } = {}) {
    const p = project(accounts, o);
    mkdirSync(p.out, { recursive: true });
    // An AI is set up (a run needs one to start), and any ask of it fails the test: a blocked sign-in asks none.
    const ai = { via: "an AI that must not be asked", ask: async () => { throw new Error("the AI was asked"); } } as unknown as Ai;
    const ui = await startUi({ outDir: p.out, testsDir: join(p.out, "tests"), ai, vars: {}, mask: makeMasker(), allowHosts: [], headed: false, maxActions: 5, projectDir: p.dir, store: p.store, env: {}, ...(o.launch ? { launch: o.launch } : {}) });
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${ui.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": ui.token }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { ...p, ui, post };
  }

  for (const [name, accounts, label, code, mine] of [
    ["an email code with no inbox (/code)", { admin: { first: "email-code", username: USER, signInPage: "/code", signedIn: { text: "Sign out" } } }, "admin", "CODE_NEEDS_PERSON", false],
    ["a code by text (/sms)", { admin: { first: "sms-code", username: USER, signInPage: "/sms", signedIn: { text: "Sign out" } } }, "admin", "SMS_CODE_NEEDED", false],
    ["a test code on a host that isn't yours (/clerk)", { admin: { first: "email-code", username: CLERK_USER, signInPage: "/clerk/sign-in", signedIn: { text: "Sign out" }, codes: [{ testCode: "424242" }] } }, "admin", "TEST_CODE_NOT_ALLOWED", false],
    ["no such account", { admin: { username: USER, password: { keychain: true } } }, "nobody", "AUTH_ACCOUNT_NEEDED", false],
  ] as const) {
    it(`${name}: a BLOCKED run result with ${code}, its fix, the later steps not run; result.json written; no pop-up`, async () => {
      const a = await app(accounts as Record<string, unknown>, { mine });
      const ev = events(a.ui);
      try {
        assert.equal((await a.post("/api/run", { url: new URL("/app", site.url).href, goal: "Open the dashboard and check it says Dashboard", as: label })).status, 202);
        const res = (await ev.next((e) => e.type === "result" || e.type === "couldnt")) as { type: string; result?: { verdict: string; code?: string; steps: { verdict: string; reason?: string; code?: string }[] }; folder?: string };
        assert.equal(res.type, "result", JSON.stringify(res));
        assert.equal(res.result!.verdict, "blocked");
        assert.equal(res.result!.code, code);
        assert.match(res.result!.steps[0]!.reason ?? "", new RegExp(`^${code}: `));
        assert.ok(res.result!.steps.slice(1).every((s) => s.verdict === "skipped"));
        assert.ok(res.folder && existsSync(join(res.folder, "result.json")), "written like any run");
        assert.equal(JSON.parse(readFileSync(join(res.folder, "result.json"), "utf8")).code, code);
        assert.equal(ev.seen.filter((e) => e.type === "handover").length, 0, "no pop-up");
        assert.equal(ev.seen.filter((e) => e.type === "couldnt").length, 0, "never only couldn't run");
      } finally {
        ev.close();
        await a.ui.close();
      }
    });
  }

  it("Set up sign-in in the app: the window opens, the person types the code there and presses Done; the session is saved; a run then reuses it", async () => {
    const holder: { b?: Browser } = {};
    const a = await app({ admin: { first: "email-code", username: USER, signInPage: "/code", signedIn: { text: "Sign out" } } }, { launch: async () => (holder.b = await launch(false)) });
    const ev = events(a.ui);
    try {
      await ev.next((e) => e.type === "busy" || e.type === "hello" || e.type === "replayed", 5000).catch(() => undefined);
      const url = new URL("/app", site.url).href;
      assert.equal((await a.post("/api/accounts/setup", { url, label: "admin" })).status, 200);
      const needed = (await ev.next((e) => e.type === "handover" && e.state === "needed")) as { request: { id: string; reason: string; account: string; words: string } };
      assert.equal(needed.request.reason, "sign_in_setup");
      assert.equal(needed.request.account, "admin");
      // The person, at the window on their computer.
      const page = holder.b!.contexts()[0]!.pages()[0]!;
      await page.getByLabel("Email").fill(USER);
      await page.getByRole("button", { name: "Send code" }).click();
      await page.getByLabel("Verification code").fill(latestCode());
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/app/);
      assert.equal((await a.post(`/api/handover/${needed.request.id}/done`, {})).status, 200);
      let state = "";
      for (let k = 0; k < 100 && state !== "saved" && state !== "failed"; k++) {
        await new Promise((r) => setTimeout(r, 100));
        state = ((await (await fetch(`${a.ui.origin}/api/accounts?t=${a.ui.token}&site=${encodeURIComponent(url)}`)).json()) as { byHand?: { state: string } }).byHand?.state ?? "";
      }
      assert.equal(state, "saved");
      // A later sign-in as admin (what a run does first): the saved session, no code asked, no person.
      const sent = site.minted().length;
      const { r } = await signIn(a, "admin");
      assert.ok(r && "path" in r && r.how === "saved", JSON.stringify(r).slice(0, 300));
      assert.equal(site.minted().length, sent, "no code was asked for");
      assert.deepEqual(ev.seen.filter((e) => e.type === "handover").map((e) => e.state), ["needed", "resumed"], "only the setup's wait");
    } finally {
      ev.close();
      await a.ui.close();
    }
  });

  const latestCode = () => [...site.minted()].reverse().find((v) => /^\d{6}$/.test(v))!;
});

// ---------------------------------------------------------------------------------------------
// The review's findings (2026-11-18): no wrong BLOCKED, no device words on a signed-in page, a device
// check remembered for the job, a test code only on a host that is yours where it is typed, no token minted.

describe("review: a code field is BLOCKED only on a sign-in step", () => {
  /** Types `value` into the code field, presses Verify, then says done. */
  const codeBrain = (value: string, title: string): TesterBrain => {
    let n = 0;
    return {
      async plan() {
        return [{ title, intent: title, check: { kind: "text_visible", text: "Phone verified" } }];
      },
      async decide(input: DecideInput): Promise<Action> {
        n++;
        const field = find(input.snapshot, /textbox/, /^verification code$/i);
        const button = find(input.snapshot, /button/, /^verify$/i);
        if (n === 1 && field) return { type: "fill", ref: field, value };
        if (n === 2 && button) return { type: "click", ref: button };
        return { type: "done" };
      },
    };
  };
  const passwordAccount = () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signedIn: { text: "Sign out" } } });
    const url = new URL("/settings/phone", site.url).href;
    const use = accountFor({ dir: p.dir, outDir: p.out, url, label: "admin", store: p.store, env: {} });
    assert.ok(!("error" in use));
    return { p, url, use };
  };

  it("a signed-in test of a broken 'verify your phone' feature is not BLOCKED SMS_CODE_NEEDED (the site's failure shows)", async () => {
    const { p, url, use } = passwordAccount();
    const state = join(p.out, "state.json");
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const { result } = await runTest({ goal: "Verify my phone number", url, dir: join(p.out, "run-a"), browser, brain: codeBrain("123456", "Verify my phone number"), storageState: state, secrets: use.resolver, noMedia: true });
    assert.notEqual(result.verdict, "blocked", JSON.stringify(result.steps[0]).slice(0, 400));
    assert.notEqual(result.code, "SMS_CODE_NEEDED");
    assert.notEqual(result.code, "CODE_NEEDS_PERSON");
  });

  it("the same with no saved session, on a step that isn't a sign-in", async () => {
    const { p, url, use } = passwordAccount();
    const { result } = await runTest({ goal: "Verify my phone number", url, dir: join(p.out, "run-b"), browser, brain: codeBrain("123456", "Verify my phone number"), secrets: use.resolver, noMedia: true });
    assert.notEqual(result.verdict, "blocked", JSON.stringify(result.steps[0]).slice(0, 400));
    assert.notEqual(result.code, "SMS_CODE_NEEDED");
  });

  it("a TOTP account whose code the site refuses (no 'authenticator' word on the page) is never CODE_NEEDS_PERSON", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, totp: { keychain: true }, signInPage: "/mfa-plain", signedIn: { text: "Sign out" } } });
    p.store.set(`${p.host}/admin/totp`, "JBSWY3DPEHPK3PXP");
    const url = new URL("/app", site.url).href;
    const use = accountFor({ dir: p.dir, outDir: p.out, url, label: "admin", store: p.store, env: {} });
    assert.ok(!("error" in use), "error" in use ? use.error : "");
    const did = new Set<string>();
    const brain: TesterBrain = {
      async plan(goal) {
        return [{ title: "Sign in", intent: goal, check: { kind: "signed_in", text: "Sign out" } }];
      },
      async decide(input: DecideInput): Promise<Action> {
        const s = input.snapshot;
        for (const [name, value] of [[/^email$/i, "{admin.username}"], [/^password$/i, "{admin.password}"], [/^verification code$/i, "{admin.totp}"]] as const) {
          const ref = find(s, /textbox/, name);
          if (ref && !did.has(`${input.url}|${name.source}`)) {
            did.add(`${input.url}|${name.source}`);
            return { type: "fill", ref, value };
          }
        }
        const button = find(s, /button/, /^(sign in|verify)$/i);
        if (button && !did.has(`${input.url}|click`)) {
          did.add(`${input.url}|click`);
          return { type: "click", ref: button };
        }
        return { type: "done" };
      },
    };
    const before = site.hits().filter((h) => h === "POST /mfa-plain/code").length;
    const r = await ensureSession({ outDir: p.out, url, account: use.account, resolver: use.resolver, mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(p.out, "runs"), brain });
    assert.ok("blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.ok(site.hits().filter((h) => h === "POST /mfa-plain/code").length - before >= 1, "the authenticator code was typed and sent");
    assert.notEqual(r.code, "CODE_NEEDS_PERSON", r.blocked);
    assert.notEqual(r.code, "SMS_CODE_NEEDED", r.blocked);
  });
});

describe("review: device words only on a page still in the sign-in", () => {
  it("a signed-in page about devices is not a device check", () => {
    for (const t of ["+ Add new device", "Open in new browser tab", "Approve this device", "Sign-in from a new browser on Nov 17", "Add a new location", "unrecognized sign-in blocked"]) {
      assert.equal(deviceCheckIn(`Dashboard. ${t}. Sign out`, "http://app.test/app/devices"), undefined, t);
    }
    assert.equal(DEVICE_CHECK_WORDS.test("+ Add new device"), false);
  });

  it("the fixture's 'confirm it's you' page still is, and so is a device word on the sign-in's own address", () => {
    assert.ok(deviceCheckIn("Confirm it's you. We sent you an email to confirm it's you.", "http://app.test/dashboard"));
    assert.ok(deviceCheckIn("New device detected", "http://app.test/login/challenge"));
    assert.equal(deviceCheckIn("New device detected", "http://app.test/settings"), undefined);
  });

  it("the signed-in check passes on a signed-in page that shows 'Add new device'", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL("/devices", site.url).href);
      const v = await verify(page, { kind: "signed_in", text: "Sign out" }, 0);
      assert.equal(v.ok, true, v.found);
    } finally {
      await page.close();
    }
  });

  it("a device check met once isn't sent again in the same job: the next sign-in ends DEVICE_CHECK with nothing sent", async () => {
    const p = project({ admin: { username: USER, password: { keychain: true }, signInPage: "/device-check", signedIn: { text: "Sign out" } } });
    const url = new URL("/app", site.url).href;
    const use = accountFor({ dir: p.dir, outDir: p.out, url, label: "admin", store: p.store, env: {} });
    assert.ok(!("error" in use));
    const guard = newSignInGuard();
    const need = { outDir: p.out, url, account: use.account, resolver: use.resolver, mask: makeMasker(), guard, browser, runsDir: join(p.out, "runs"), brain: signInBrain() };
    const posts = () => site.hits().filter((h) => h === "POST /device-check").length;
    const before = posts();
    const first = await ensureSession(need);
    assert.ok("blocked" in first && first.code === "DEVICE_CHECK", JSON.stringify(first).slice(0, 300));
    assert.equal(posts() - before, 1);
    const second = await ensureSession(need);
    assert.ok("blocked" in second && second.code === "DEVICE_CHECK", JSON.stringify(second).slice(0, 300));
    assert.equal(posts() - before, 1, "not sent again");
  });
});

describe("review: a test code is typed only on a host that is yours", () => {
  const clerkAccount = { first: "email-code", username: CLERK_USER, signInPage: "/clerk/sign-in", signedIn: { text: "Sign out" }, codes: [{ testCode: "424242" }] };
  it("refused on a sign-in host that is only said OK, given on the start host and on another host marked yours", async () => {
    const a = parseAccounts({ accounts: { admin: clerkAccount } }).accounts.get("admin")!;
    const store = fileStore(secretsPathFor(join(temp(), "cm")));
    const r = accountResolver(a, { host: "app.test", store, env: {}, owned: true, ownedHost: (h) => h === "app.test" || h === "auth.app.test" });
    const opts = (typedOn: string) => ({ since: 0, mask: makeMasker(), allowedHosts: ["app.test"], host: "app.test", typedOn });
    const portal = (await r.fresh!("admin.email_code", opts("accounts.app.test"))) as Fresh;
    assert.ok("code" in portal && portal.code === "TEST_CODE_NOT_ALLOWED", JSON.stringify(portal));
    assert.deepEqual(await r.fresh!("admin.email_code", opts("app.test")), { value: "424242" });
    assert.deepEqual(await r.fresh!("admin.email_code", opts("auth.app.test")), { value: "424242" });
    // With no owned-host check given, only the start host.
    const bare = accountResolver(a, { host: "app.test", store, env: {}, owned: true });
    const off = (await bare.fresh!("admin.email_code", opts("auth.app.test"))) as Fresh;
    assert.ok("code" in off && off.code === "TEST_CODE_NOT_ALLOWED");
  });

  it("accountFor wires the owned-host check: a host marked yours later is accepted", async () => {
    const p = project({ admin: clerkAccount }, { mine: true });
    const url = new URL("/app", site.url).href;
    const use = accountFor({ dir: p.dir, outDir: p.out, url, label: "admin", store: p.store, env: {} });
    assert.ok(!("error" in use));
    const opts = (typedOn: string) => ({ since: 0, mask: makeMasker(), allowedHosts: [p.host], host: p.host, typedOn });
    const other = (await use.resolver.fresh!("admin.email_code", opts("portal.example.test"))) as Fresh;
    assert.ok("code" in other && other.code === "TEST_CODE_NOT_ALLOWED");
    markMine(p.out, "portal.example.test");
    assert.deepEqual(await use.resolver.fresh!("admin.email_code", opts("portal.example.test")), { value: "424242" });
  });
});

describe("review: Set up sign-in makes no Clerk testing token", () => {
  it("clerkKeepHostFor reads the Clerk host from the config, only on a host marked yours, with no request", async () => {
    const { clerkKeepHostFor } = await import("./signin.ts");
    const pk = `pk_test_${Buffer.from("clerk.fixture.test$").toString("base64")}`;
    const host = new URL(site.url).host;
    const mine = project({ admin: { username: USER, password: { keychain: true } } }, { mine: true, sites: { [host]: { clerk: { publishableKey: pk, secretKey: { keychain: true } } } } });
    const tokensBefore = site.hits().filter((h) => /testing_tokens/.test(h)).length;
    assert.equal(clerkKeepHostFor({ dir: mine.dir, outDir: mine.out, url: site.url }), "clerk.fixture.test");
    assert.equal(site.hits().filter((h) => /testing_tokens/.test(h)).length, tokensBefore, "no testing token was made");
    const said = project({ admin: { username: USER, password: { keychain: true } } }, { sites: { [host]: { clerk: { publishableKey: pk, secretKey: { keychain: true } } } } });
    assert.equal(clerkKeepHostFor({ dir: said.dir, outDir: said.out, url: site.url }), undefined);
  });
});
