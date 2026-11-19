// Sign in with an account on any site (Sam, 2026-11): a per-host "it's my own account" kept apart from
// owned.json, the exact-host rule for an account's values, and the hand-over for a code we can't read.
// Offline: local fixture sites on 127.0.0.1 and localhost, a scripted brain, a file store. "A site that
// isn't yours" is a 127.0.0.1:<port> with nothing in owned.json.
//   node --test cli/signin-ok.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { act, accountHostRefused, refusedOnOwnAccount, type ActContext } from "../packages/scanner/src/tester/act.ts";
import { makeMasker, type Fresh } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { newSignInGuard } from "../packages/scanner/src/tester/run.ts";
import type { Action, DecideInput, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { accountHostsFor, accountResolver, fileStore, hostArg, isMine, markMine, markSignInOk, ownedHosts, parseAccounts, secretsPathFor, signInAllowed, signInOkPathFor, signInOkWords } from "./accounts.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { leakHits } from "./leak.ts";
import { serveMcp, type ChildLike } from "./mcp.ts";
import { accountFor, ensureSession, signInByHand, siteAccessFor } from "./signin.ts";
import { startUi } from "./ui-server.ts";

const temps: string[] = [];
const temp = (prefix = "cm-anysite-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const refs = (snapshot: string) => [...snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].map((m) => ({ ref: m[1]!, role: m[2]!, name: m[3]! }));
const find = (snapshot: string, role: RegExp, name: RegExp) => refs(snapshot).find((r) => role.test(r.role) && name.test(r.name))?.ref;

/** A scripted brain for a sign-in: fills what it sees with the account's names, presses on, never a value. */
function signInBrain(prompts: string[]): TesterBrain {
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
      for (const [name, value] of [[/^email$/i, "{admin.username}"], [/^password$/i, "{admin.password}"], [/^authenticator code$/i, "{admin.totp}"], [/^verification code$/i, "{admin.email_code}"]] as const) {
        const ref = find(s, /textbox/, name);
        const a = ref ? once(`fill ${name.source}`, { type: "fill", ref, value }) : undefined;
        if (a) return a;
      }
      const button = find(s, /button/, /^(send code|sign in|verify)$/i);
      const click = button ? once(`click ${button}`, { type: "click", ref: button }) : undefined;
      return click ?? { type: "done" };
    },
  };
}

const USER = "me.anysite@example.test";
const PASSWORD = "pw-LEAK-anysite-4c2e9b";

// ---------------------------------------------------------------------------------------------

describe("the acknowledgement: kept apart, never 'mine'", () => {
  it("markSignInOk lets an account sign in, and never makes the host yours (owner-only file)", () => {
    const out = join(temp(), "cm");
    assert.equal(signInAllowed(out, "127.0.0.1:4555"), false);
    markSignInOk(out, "127.0.0.1:4555");
    assert.equal(signInAllowed(out, "127.0.0.1:4555"), true);
    assert.equal(isMine(out, "127.0.0.1:4555"), false, "the acknowledgement does not make isMine true");
    assert.equal("127.0.0.1:4555" in ownedHosts(out), false);
    assert.equal(signInAllowed(out, "127.0.0.1:4556"), false, "exact host, port included");
    assert.equal(statSync(signInOkPathFor(out)).mode & 0o777, 0o600);
    assert.equal(statSync(join(out, ".auth")).mode & 0o777, 0o700);
    // A host marked mine may sign in too, with nothing said.
    markMine(out, "localhost:3000");
    assert.equal(signInAllowed(out, "localhost:3000"), true);
    // An account on a host that isn't marked mine: its own, and hosts on its own site only (never localhost:3000, another site).
    assert.deepEqual(accountHostsFor(out, "http://127.0.0.1:9000/login"), ["127.0.0.1:9000", "127.0.0.1:4555"]);
  });

  it("the words, the host as typed, and the config can't say it", () => {
    assert.equal(signInOkWords("shop.example.com"), "I'm signing in with my own account on shop.example.com. The tester still won't post, pay, send or delete there.");
    assert.equal(hostArg("localhost:3000"), "localhost:3000");
    assert.equal(hostArg("https://Shop.Example.com/"), "shop.example.com");
    for (const bad of ["shop.example.com/login", "a b.com", "https://", "", "x:99999999"]) assert.equal(hostArg(bad), undefined, bad);
    const parsed = parseAccounts({ signInOk: ["evil.example"], accounts: { admin: { username: "a@example.test", password: { keychain: true }, signedIn: { text: "x" }, signInOk: true } } });
    assert.equal(parsed.warnings.filter((w) => /signInOk .*is ignored/.test(w)).length, 2, parsed.warnings.join("\n"));
  });

  it("accounts sign-in: needs a yes (a terminal or --yes), and --remove takes it back", async () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ url: "http://127.0.0.1:4555/" }));
    const out = join(dir, "contextmachines");
    const said: string[] = [];
    const output = { write: (t: string) => (said.push(String(t)), true), isTTY: false, columns: 100 } as unknown as NodeJS.WriteStream;
    const { runAccountsCommand } = await import("./accounts-command.ts");
    const errs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => (errs.push(String(t)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await runAccountsCommand(["sign-in", "127.0.0.1:4555"], { dir, env: { CM_SECRET_STORE: "file" }, output }), 2, "no one to ask, no --yes");
      assert.match(errs.join(""), /no one to ask here: run it at a terminal, or add --yes/);
      assert.equal(await runAccountsCommand(["sign-in", "127.0.0.1:4555/login"], { dir, env: { CM_SECRET_STORE: "file" }, output }), 2, "a path isn't a host");
      assert.equal(await runAccountsCommand(["sign-in", "127.0.0.1:4555", "--yes"], { dir, env: { CM_SECRET_STORE: "file" }, output }), 0);
      assert.equal(signInAllowed(out, "127.0.0.1:4555"), true);
      assert.equal(isMine(out, "127.0.0.1:4555"), false);
      assert.match(said.join(""), /It isn't marked as yours: sign-ups, payments and site access stay off there/);
      assert.equal(await runAccountsCommand(["sign-in", "127.0.0.1:4555", "--remove"], { dir, env: { CM_SECRET_STORE: "file" }, output }), 0);
      assert.equal(signInAllowed(out, "127.0.0.1:4555"), false);
    } finally {
      process.stderr.write = write;
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("sign-in on a site that isn't yours", () => {
  let site: AuthSite;
  let browser: Browser;
  before(async () => {
    site = await startAuthSite({ users: [{ username: USER, password: PASSWORD }] });
    browser = await launch(false);
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });
  const project = () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts: { admin: { username: USER, password: { keychain: true }, signInPage: "/login", signedIn: { text: "Sign out" } }, "new-user": { first: "sign-up", signedIn: { text: "Sign out" } } }, sites: { [new URL(site.url).host]: { header: { name: "x-qa-bypass", value: { keychain: true } } } } }));
    const out = join(dir, "contextmachines");
    const store = fileStore(secretsPathFor(out));
    store.set(`${new URL(site.url).host}/admin/password`, PASSWORD);
    store.set(`${new URL(site.url).host}/site/header`, "owner-header-LEAK-value-0001");
    return { dir, out, store };
  };

  it("refused until you say so: accountFor names the fix, ensureSession is SIGN_IN_NOT_CONFIRMED", async () => {
    const { dir, out, store } = project();
    const url = new URL("/app", site.url).href;
    const no = accountFor({ dir, outDir: out, url, label: "admin", store });
    assert.ok("error" in no && /accounts sign-in 127\.0\.0\.1:\d+/.test(no.error), JSON.stringify(no));
    const account = parseAccounts(JSON.parse(readFileSync(join(dir, "contextmachines.config.json"), "utf8"))).accounts.get("admin")!;
    const r = await ensureSession({ outDir: out, url, account, resolver: accountResolver(account, { host: new URL(site.url).host, store, env: {} }), mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(out, "runs"), brain: signInBrain([]) });
    assert.ok("blocked" in r && r.code === "SIGN_IN_NOT_CONFIRMED", JSON.stringify(r));
    assert.equal(site.signIns("/login"), 0, "nothing was signed in");
  });

  it("allowed after the acknowledgement: signs in, saves the session, and the host is still not yours", async () => {
    const { dir, out, store } = project();
    const host = new URL(site.url).host;
    markSignInOk(out, host);
    const url = new URL("/app", site.url).href;
    const use = accountFor({ dir, outDir: out, url, label: "admin", store });
    assert.ok("account" in use, JSON.stringify(use));
    const prompts: string[] = [];
    const before = site.signIns("/login");
    const mask = makeMasker();
    const r = await ensureSession({ outDir: out, url, account: use.account, resolver: use.resolver, mask, guard: newSignInGuard(), browser, runsDir: join(out, "runs"), brain: signInBrain(prompts) });
    assert.ok("path" in r && r.how === "planned", JSON.stringify(r).slice(0, 400));
    assert.equal(r.result?.code, undefined);
    assert.equal(site.signIns("/login") - before, 1);
    assert.ok(existsSync(r.path));
    // Still owned-only: no site access, no owner token sent, and the AI never saw the password.
    const access = await siteAccessFor({ dir, outDir: out, url, store, env: {} });
    assert.equal(access.ownedHost, false);
    assert.equal(access.owner, undefined, "no owner token on a host you only sign in on");
    assert.match(access.warning ?? "", /isn't marked as yours/);
    assert.deepEqual(leakHits({ password: PASSWORD }, [{ where: "AI prompts", text: prompts.join("\n") }]), []);
    // A sign-up account stays refused there.
    const signUp = accountFor({ dir, outDir: out, url: new URL("/signup", site.url).href, label: "new-user", store });
    assert.ok("error" in signUp && /SIGNUP_NOT_ALLOWED/.test(signUp.error));
    // Within 10 minutes: the saved session, no browser work.
    const again = await ensureSession({ outDir: out, url, account: use.account, resolver: use.resolver, mask, guard: newSignInGuard(), browser, runsDir: join(out, "runs") });
    assert.ok("path" in again && again.how === "saved");
  });

  it("test --as with no one at a terminal and no --yes: a usage exit, nothing opened", async () => {
    const { dir } = project();
    const r = await new Promise<{ code: number | null; out: string }>((done) => {
      const { CI: _ci, ANTHROPIC_API_KEY: _key, ...rest } = process.env;
      const child = spawn(process.execPath, [join(import.meta.dirname, "contextmachines.ts"), "test", "open the reports", "--as", "admin", "--url", new URL("/app", site.url).href, "--ai", "none"], { cwd: dir, env: { ...rest, NO_COLOR: "1", CM_SECRET_STORE: "file" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("close", (code) => done({ code, out }));
    });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /there's no one to ask here: run it at a terminal, or add --yes/);
    assert.equal(existsSync(join(dir, "contextmachines", "runs")), false, "nothing ran");
  });

  it("the MCP server still types CM_VAR_ only on this machine or a host marked yours, never one only said OK", async () => {
    const asked: { url: string; vars: boolean }[] = [];
    const spawnCli = (args: string[], o: { cwd: string; vars: boolean }): ChildLike => {
      asked.push({ url: args[args.indexOf("--url") + 1]!, vars: o.vars });
      const ee = new EventEmitter() as EventEmitter & ChildLike;
      Object.assign(ee, { stdout: new PassThrough(), stderr: new PassThrough(), stop: () => setTimeout(() => ee.emit("close", null, "SIGTERM"), 5) });
      setTimeout(() => ee.emit("close", 3, null), 5);
      return ee;
    };
    const outDir = temp();
    markSignInOk(outDir, "shop.signed-in.test");
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const done = serveMcp(input, output, { outDir, cwd: outDir, allowHosts: [], measuredOnly: false }, { spawnCli, version: "test", waitMs: 60_000, log: () => {} });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_test", arguments: { goal: "Type {password} into Password", url: "https://shop.signed-in.test/login" } } })}\n`);
    await new Promise((ok) => setTimeout(ok, 80));
    input.end();
    await done;
    assert.deepEqual(asked.map((a) => a.vars), [false]);
  });
});

// ---------------------------------------------------------------------------------------------
// The exact-host rule: an account's values go only to the host they're for.

/** Host A redirects its /login to host B (same machine, another port); B's form posts to B and logs what came. */
async function twoHosts(): Promise<{ a: string; b: string; posts: string[]; close(): Promise<void> }> {
  const posts: string[] = [];
  const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
  const b = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push(body);
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>B</title><main><h1>Thanks</h1></main>");
      });
      return;
    }
    if (req.url === "/buttons") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>B</title><main><button type="button">Vote</button> <button type="button">Notify me</button> <button type="button">Open reports</button></main>`);
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Sign in</title><main><h1>Sign in</h1><form method="post" action="/login"><p><label for="email">Email</label> <input id="email" name="email" type="email"></p><p><label for="password">Password</label> <input id="password" name="password" type="password"></p><p><label for="otp">Authenticator code</label> <input id="otp" name="otp"></p><p><button type="submit">Sign in</button></p></form></main>`);
  });
  const bPort = await listen(b);
  const a = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${bPort}${req.url}` }).end();
  });
  const aPort = await listen(a);
  return { a: `http://127.0.0.1:${aPort}`, b: `http://127.0.0.1:${bPort}`, posts, close: async () => {
    await new Promise((ok) => a.close(() => ok(undefined)));
    await new Promise((ok) => b.close(() => ok(undefined)));
  } };
}

describe("an account's values are typed only on its exact host", () => {
  let browser: Browser;
  let hosts: Awaited<ReturnType<typeof twoHosts>>;
  before(async () => {
    browser = await launch(false);
    hosts = await twoHosts();
  });
  after(async () => {
    await browser?.close();
    await hosts?.close();
  });

  const run = async (out: string) => {
    const account = parseAccounts({ accounts: { admin: { username: USER, password: { keychain: true }, signInPage: "/login", signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
    const store = fileStore(secretsPathFor(out));
    store.set(`${new URL(hosts.a).host}/admin/password`, PASSWORD);
    const resolver = accountResolver(account, { host: new URL(hosts.a).host, store, env: {} });
    return ensureSession({ outDir: out, url: `${hosts.a}/app`, account, resolver, mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(out, "runs"), brain: signInBrain([]) });
  };

  it("a sign-in that goes to another port types nothing there, until that host is said too", async () => {
    const out = join(temp(), "cm");
    markSignInOk(out, new URL(hosts.a).host);
    const before = hosts.posts.length;
    const r = await run(out);
    assert.ok("blocked" in r, JSON.stringify(r).slice(0, 300));
    assert.match(r.blocked, new RegExp(`nothing was typed: \\{admin\\.username\\} is for ${new URL(hosts.a).host.replace(/\./g, "\\.")}, and this field is on ${new URL(hosts.b).host.replace(/\./g, "\\.")}`));
    assert.equal(hosts.posts.length - before, 0, "host B got nothing");
    // Said for B too: the values are typed there (B is where you sign in).
    markSignInOk(out, new URL(hosts.b).host);
    await run(out);
    assert.ok(hosts.posts.slice(before).some((p) => p.includes(encodeURIComponent(PASSWORD)) || p.includes(PASSWORD)), "typed on B once said");
  });

  it("a code is never made or asked of a person for a field on the wrong host; a --var keeps its own rule", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${hosts.b}/login`);
      let made = 0;
      const fresh = (): Promise<Fresh> => {
        made++;
        return Promise.resolve({ value: "123456" });
      };
      const ctx: ActContext = { page, start: `${hosts.a}/login`, allowHosts: [], values: { vars: { otp: "999111" }, given: "", fresh }, mask: makeMasker(), offSite: () => undefined, accountHosts: [new URL(hosts.a).host], accountNames: new Set(["admin.totp"]) };
      const r = await act(ctx, { type: "fill", target: { role: "textbox", name: "Authenticator code", nth: 0 }, value: "{admin.totp}" });
      assert.ok("blocked" in r && /\{admin\.totp\} is for/.test(r.blocked), JSON.stringify(r));
      assert.equal(made, 0, "fresh was never called");
      const v = await act(ctx, { type: "fill", target: { role: "textbox", name: "Authenticator code", nth: 0 }, value: "{otp}" });
      assert.ok("done" in v, JSON.stringify(v));
      assert.equal(accountHostRefused(ctx, "{otp}", page.url(), page.url()), undefined);
    } finally {
      await page.close();
    }
  });

  it("with your own account on a site that isn't yours: no votes or 'notify me'; on yours, as before", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${hosts.b}/buttons`);
      const ctx = (notOwned: boolean): ActContext => ({ page, start: `${hosts.b}/buttons`, allowHosts: [], values: { vars: {}, given: "" }, mask: makeMasker(), offSite: () => undefined, ...(notOwned ? { notOwned: true } : {}) });
      for (const name of ["Vote", "Notify me"]) {
        const r = await act(ctx(true), { type: "click", target: { role: "button", name, nth: 0 } });
        assert.ok("blocked" in r && /your own account doesn't vote/.test(r.blocked), JSON.stringify(r));
        assert.ok("done" in (await act(ctx(false), { type: "click", target: { role: "button", name, nth: 0 } })), name);
      }
      assert.ok("done" in (await act(ctx(true), { type: "click", target: { role: "button", name: "Open reports", nth: 0 } })));
      assert.match(refusedOnOwnAccount("Change your password") ?? "", /security settings/);
      assert.equal(refusedOnOwnAccount("Sign in"), undefined, "signing in itself is the point");
    } finally {
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A code we can't read (A1): a run never waits for a person. "Set up sign-in" once, with the person
// typing it in a window on their own computer, saves the session; runs reuse it, or end BLOCKED.

describe("a code sent to your own inbox, on a site that isn't yours", () => {
  let site: AuthSite;
  let browser: Browser;
  before(async () => {
    site = await startAuthSite({ users: [{ username: USER, password: PASSWORD }] });
    browser = await launch(false);
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });
  // No catcher: the code goes to the person's own inbox (here the fixture's, which only the "person" reads).
  const account = () => parseAccounts({ accounts: { admin: { first: "email-code", username: USER, signInPage: "/code", signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
  const latestCode = () => [...site.minted()].reverse().find((v) => /^\d{6}$/.test(v))!;

  const sign = async (out: string, prompts: string[] = [], mask = makeMasker(), force = false) => {
    const a = account();
    const host = new URL(site.url).host;
    const store = fileStore(secretsPathFor(out));
    const resolver = accountResolver(a, { host, store, env: {} });
    return ensureSession({ outDir: out, url: new URL("/app", site.url).href, account: a, resolver, mask, guard: newSignInGuard(), browser, runsDir: join(out, "runs"), brain: signInBrain(prompts) }, { force });
  };
  /** The person, at the window Set up sign-in opened: types the address, asks for the code, reads it from their inbox, types it. */
  const person = async (page: Page) => {
    await page.getByLabel("Email").fill(USER);
    await page.getByRole("button", { name: "Send code" }).click();
    await page.getByLabel("Verification code").fill(latestCode());
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/app/);
    return true;
  };

  it("a run never waits: BLOCKED CODE_NEEDS_PERSON before the browser opens, no code sent, the fix is Set up sign-in", async () => {
    const out = join(temp(), "cm");
    markSignInOk(out, new URL(site.url).host);
    const sentBefore = site.minted().length;
    const hitsBefore = site.hits().length;
    const none = await sign(out);
    assert.ok("blocked" in none && none.code === "CODE_NEEDS_PERSON", JSON.stringify(none).slice(0, 400));
    assert.match(none.blocked, /Set up sign-in for admin under Accounts/);
    assert.match(none.blocked, /accounts setup admin --url http:\/\/127\.0\.0\.1:\d+/);
    assert.match(none.blocked, /a run never waits for a person, so nothing was sent/);
    assert.equal(none.result, undefined, "no run started");
    assert.equal(site.minted().length, sentBefore, "no code was sent");
    assert.equal(site.hits().slice(hitsBefore).length, 0, "the site wasn't opened at all");
  });

  it("Set up sign-in: the person types the code in the window, the session is saved; runs then reuse it with no one there, and the code is in no file", async () => {
    const out = join(temp(), "cm");
    markSignInOk(out, new URL(site.url).host);
    const a = account();
    const set = await signInByHand({ outDir: out, url: new URL("/app", site.url).href, account: a, browser, done: person });
    assert.ok("path" in set, JSON.stringify(set));
    const code = latestCode();
    const prompts: string[] = [];
    const again = await sign(out, prompts);
    assert.ok("path" in again && again.how === "saved", JSON.stringify(again).slice(0, 300));
    assert.equal(prompts.length, 0, "no AI asked");
    // Ten minutes on, the saved session is checked (its signed-in words), and still used: no code, no person.
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(set.path, old, old);
    const sentBefore = site.minted().length;
    const checked = await sign(out);
    assert.ok("path" in checked && checked.how === "checked", JSON.stringify(checked).slice(0, 300));
    assert.equal(site.minted().length, sentBefore, "no code sent");
    const files = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(join(d, f.name)) : [join(d, f.name)])) : []);
    assert.deepEqual(leakHits({ code }, files(out).map((f) => ({ where: f, text: readFileSync(f, "utf8") }))), []);
  });

  it("the saved session expired: BLOCKED AUTH_SESSION_EXPIRED with the Set up sign-in fix, no code sent, no pop-up", async () => {
    const out = join(temp(), "cm");
    markSignInOk(out, new URL(site.url).host);
    const set = await signInByHand({ outDir: out, url: new URL("/app", site.url).href, account: account(), browser, done: person });
    assert.ok("path" in set);
    site.expireAll();
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(set.path, old, old);
    const sentBefore = site.minted().length;
    const r = await sign(out);
    assert.ok("blocked" in r && r.code === "AUTH_SESSION_EXPIRED", JSON.stringify(r).slice(0, 400));
    assert.match(r.blocked, /saved session on 127\.0\.0\.1:\d+ no longer works/);
    assert.match(r.blocked, /Set up sign-in for admin under Accounts/);
    assert.equal(site.minted().length, sentBefore, "no code sent");
    // Found signed out mid-run (force): the same, never a wait.
    const forced = await sign(out, [], makeMasker(), true);
    assert.ok("blocked" in forced && forced.code === "AUTH_SESSION_EXPIRED");
  });

  it("Set up sign-in in the app: refused where you haven't said so, and with no one watching it ends with nothing saved", async () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts: { sso: { first: "by-hand", signedIn: { text: "Sign out" } } } }));
    const outDir = join(dir, "contextmachines");
    mkdirSync(outDir, { recursive: true });
    const ui = await startUi({ outDir, testsDir: join(outDir, "tests"), ai: undefined, vars: {}, mask: makeMasker(), allowHosts: [], headed: false, maxActions: 5, projectDir: dir, store: fileStore(secretsPathFor(outDir)), env: {}, launch: () => launch(false) });
    const post = async (path: string, body: unknown) => (await fetch(`${ui.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": ui.token }, body: JSON.stringify(body) })).status;
    try {
      const url = new URL("/app", site.url).href;
      assert.equal(await post("/api/accounts/setup", { url, label: "sso" }), 403);
      markSignInOk(outDir, new URL(site.url).host);
      assert.equal(await post("/api/accounts/setup", { url, label: "sso" }), 200);
      let state = "";
      for (let k = 0; k < 100 && state !== "failed" && state !== "saved"; k++) {
        await new Promise((ok) => setTimeout(ok, 100));
        const v = (await (await fetch(`${ui.origin}/api/accounts?t=${ui.token}&site=${encodeURIComponent(url)}`)).json()) as { byHand?: { state: string } };
        state = v.byHand?.state ?? "";
      }
      assert.equal(state, "failed", "no one watching to press Done: nothing saved");
      assert.equal(existsSync(join(outDir, ".auth", `${new URL(site.url).host.replace(/[^\w.-]+/g, "-")}@sso.json`)), false);
    } finally {
      await ui.close();
    }
  });
});
