// Fixes after the reviews of "sign in on any site": each one proved on local fixtures only
// (127.0.0.1 and localhost on this machine), with no AI.
//
// - a code made while the page moved to another host is not typed there (checked again before typing)
// - "constructor" / "__proto__" are never a host marked mine or said OK
// - a sign-in page that would leave the site (//evil.example) is refused; signInStart stays on the site
// - an account's values go only to hosts on its own site, never to another site said OK for another account
// - a code to the person's own inbox, with no one to type it: BLOCKED before the browser opens, nothing sent
// - forgetting a session works after the "my own account" is taken back
// - a default port is no port; --allow-host with a port allows that port
// - two accounts with one address still count as the account's own in a "send code" form

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { act, accountHostRefused, onSite, type ActContext } from "../packages/scanner/src/tester/act.ts";
import { makeMasker, type Fresh } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { accountHostsFor, accountResolver, codeNeedsPerson, fileStore, forgetSignInOk, hostArg, isMine, markMine, markSignInOk, parseAccounts, AccountConfigError, secretsPathFor, sessionPathFor, signInAllowed } from "./accounts.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { signInStart } from "./signin.ts";
import { startUi } from "./ui-server.ts";

const temps: string[] = [];
const temp = (prefix = "cm-anysite-fix-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as { port: number }).port)));
const close = (s: Server) => new Promise<void>((ok) => s.close(() => ok()));

describe("host lists hold only what was said", () => {
  it("a built-in name (constructor, __proto__) is never marked mine or said OK", () => {
    const out = join(temp(), "cm");
    for (const h of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(isMine(out, h), false, h);
      assert.equal(signInAllowed(out, h), false, h);
    }
    markSignInOk(out, "127.0.0.1:4000");
    markMine(out, "127.0.0.1:4001");
    for (const h of ["constructor", "__proto__", "valueOf"]) {
      assert.equal(isMine(out, h), false, h);
      assert.equal(signInAllowed(out, h), false, h);
    }
    forgetSignInOk(out, "constructor");
    assert.equal(signInAllowed(out, "127.0.0.1:4000"), true, "forgetting a built-in name changes nothing");
  });

  it("a default port is no port: example.com:443 is the host an https address has", () => {
    assert.equal(hostArg("example.com:443"), "example.com");
    assert.equal(hostArg("https://example.com:443/"), "example.com");
    assert.equal(hostArg("example.com:80"), "example.com");
    assert.equal(hostArg("example.com:8443"), "example.com:8443");
    const out = join(temp(), "cm");
    markSignInOk(out, hostArg("shop.example.com:443")!);
    assert.equal(signInAllowed(out, new URL("https://shop.example.com/login").host), true);
  });

  it("--allow-host with a port allows that host on that port only", () => {
    const start = "http://127.0.0.1:4000/";
    assert.equal(onSite("http://localhost:4517/authorize", start, ["localhost:4517"]), true);
    assert.equal(onSite("http://localhost:4518/authorize", start, ["localhost:4517"]), false);
    assert.equal(onSite("http://localhost:4518/authorize", start, ["localhost"]), true, "a bare host name: any port, as before");
  });
});

describe("a sign-in page stays on the site", () => {
  it("one that a browser reads as another site is refused", () => {
    for (const bad of ["//evil.example/login", "/\\evil.example/login", "/\\/evil.example", "/log in"]) {
      assert.throws(() => parseAccounts({ accounts: { admin: { username: "a@example.test", signInPage: bad } } }), AccountConfigError, bad);
    }
    assert.equal(parseAccounts({ accounts: { admin: { username: "a@example.test", signInPage: "/auth/login?next=/app" } } }).accounts.get("admin")?.signInPage, "/auth/login?next=/app");
  });

  it("signInStart never leaves the test's site, whatever it is given", () => {
    assert.equal(signInStart({ signInPage: "//evil.example/login" }, "https://shop.example.com/app"), "https://shop.example.com/app");
    assert.equal(signInStart({ signInPage: "/\\evil.example/login" }, "https://shop.example.com/app"), "https://shop.example.com/app");
    assert.equal(signInStart({ signInPage: "/login" }, "https://shop.example.com/app"), "https://shop.example.com/login");
  });
});

describe("an account's values go only to its own site", () => {
  it("a host said OK for another site's account is not one of this account's hosts", () => {
    const out = join(temp(), "cm");
    markSignInOk(out, "a.example.com");
    markSignInOk(out, "auth.example.com");
    markSignInOk(out, "other.example.net");
    markMine(out, "localhost:3000");
    assert.deepEqual(accountHostsFor(out, "https://a.example.com/app"), ["a.example.com", "auth.example.com"]);
    assert.deepEqual(accountHostsFor(out, "https://other.example.net/"), ["other.example.net"]);
    // A test account on a host marked mine (your own app): every host marked mine or said OK, as before.
    markMine(out, "127.0.0.1:9000");
    assert.deepEqual(accountHostsFor(out, "http://localhost:3000/").sort(), ["127.0.0.1:9000", "a.example.com", "auth.example.com", "localhost:3000", "other.example.net"]);
    // Your real account on a site that isn't yours: never your own app's hosts or another site's.
    assert.deepEqual(accountHostsFor(out, "https://a.example.com/app"), ["a.example.com", "auth.example.com"]);
  });

  it("refused on another site with no one-line fix offered; on the same site, the fix is named", () => {
    const ctx = { accountHosts: ["a.example.com"], accountNames: new Set(["admin.password"]), values: { vars: {}, given: "" }, notOwned: true } as Pick<ActContext, "accountHosts" | "accountNames" | "values" | "notOwned">;
    const other = accountHostRefused(ctx, "{admin.password}", "https://evil.example/login", "https://evil.example/login")!;
    assert.match(other, /a different site from a\.example\.com\. Your account's values are typed only on its own site/);
    assert.doesNotMatch(other, /accounts sign-in/);
    // A test account on your own app (marked mine) may sign in on your own auth server elsewhere: the fix is named.
    const ownApp = accountHostRefused({ ...ctx, notOwned: false }, "{admin.password}", "http://localhost:8080/login", "http://localhost:8080/login")!;
    assert.match(ownApp, /a different site from a\.example\.com\. If localhost:8080 is where you sign in to a\.example\.com, say so once: npx contextmachines accounts sign-in localhost:8080/);
    const sibling = accountHostRefused(ctx, "{admin.password}", "https://auth.example.com/login", "https://auth.example.com/login")!;
    assert.match(sibling, /another host of the same site.*npx contextmachines accounts sign-in auth\.example\.com/);
  });

  describe("in a browser", () => {
    let browser: Browser;
    before(async () => {
      browser = await launch(false);
    });
    after(async () => {
      await browser?.close();
    });

    const codePage = (goTo?: string) => `<!doctype html><title>Code</title><main><label>Verification code <input id="c" name="c"></label></main>
<script>document.getElementById("c").addEventListener("input", (e) => fetch("/got?v=" + encodeURIComponent(e.target.value)));
${goTo ? `setTimeout(() => (location.href = ${JSON.stringify(goTo)}), 300)` : ""}</script>`;

    it("a code made while the page moved to another host is not typed there", async () => {
      const got: string[] = [];
      const b = createServer((req, res) => {
        if (req.url!.startsWith("/got")) got.push(req.url!);
        res.writeHead(200, { "content-type": "text/html" }).end(codePage());
      });
      const bPort = await listen(b);
      const bUrl = `http://localhost:${bPort}/login`;
      const a = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end(codePage(bUrl)));
      const aUrl = `http://127.0.0.1:${await listen(a)}/login`;
      const page = await browser.newPage();
      try {
        await page.goto(aUrl);
        // The code takes a while (a person typing it, an inbox): the page goes to B meanwhile.
        const fresh = (): Promise<Fresh> => new Promise((ok) => setTimeout(() => ok({ value: "654321" }), 1200));
        const ctx: ActContext = { page, start: aUrl, allowHosts: ["localhost"], values: { vars: {}, given: "", fresh }, mask: makeMasker(), offSite: () => undefined, accountHosts: [new URL(aUrl).host], accountNames: new Set(["admin.email_code"]) };
        const r = await act(ctx, { type: "fill", target: { role: "textbox", name: "Verification code", nth: 0 }, value: "{admin.email_code}" });
        await new Promise((ok) => setTimeout(ok, 300));
        assert.ok("blocked" in r && /nothing was typed/.test(r.blocked), JSON.stringify(r).slice(0, 300));
        assert.match(page.url(), new RegExp(`localhost:${bPort}`), "the page did move");
        assert.deepEqual(got.filter((g) => g.includes("654321")), [], "B never got the code");
      } finally {
        await page.close();
        await close(a);
        await close(b);
      }
    });

    it("a code still gets typed when the page stays put", async () => {
      const got: string[] = [];
      const a = createServer((req, res) => {
        if (req.url!.startsWith("/got")) got.push(req.url!);
        res.writeHead(200, { "content-type": "text/html" }).end(codePage());
      });
      const aUrl = `http://127.0.0.1:${await listen(a)}/login`;
      const page = await browser.newPage();
      try {
        await page.goto(aUrl);
        const fresh = (): Promise<Fresh> => new Promise((ok) => setTimeout(() => ok({ value: "654321" }), 300));
        const ctx: ActContext = { page, start: aUrl, allowHosts: [], values: { vars: {}, given: "", fresh }, mask: makeMasker(), offSite: () => undefined, accountHosts: [new URL(aUrl).host], accountNames: new Set(["admin.email_code"]) };
        const r = await act(ctx, { type: "fill", target: { role: "textbox", name: "Verification code", nth: 0 }, value: "{admin.email_code}" });
        assert.ok("done" in r, JSON.stringify(r).slice(0, 300));
        assert.equal(await page.locator("#c").inputValue(), "654321");
      } finally {
        await page.close();
        await close(a);
      }
    });

    it("two accounts with one address: the 'send code' form still holds the account's own value", async () => {
      const a = createServer((_req, res) => void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Sign in</title><main><form onsubmit="event.preventDefault(); document.title='sent'"><p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username"></p><button type="submit">Send code</button></form></main>`));
      const aUrl = `http://127.0.0.1:${await listen(a)}/code`;
      const page = await browser.newPage();
      try {
        await page.goto(aUrl);
        const mask = makeMasker();
        mask.add("admin.username", "me.same@example.test", true);
        mask.add("coder.username", "me.same@example.test", true);
        const ctx = (): ActContext => ({ page, start: aUrl, allowHosts: [], values: { vars: {}, given: "" }, mask, offSite: () => undefined, accountHosts: [new URL(aUrl).host], accountNames: new Set(["coder.username"]), codeSends: { host: new URL(aUrl).host, count: { n: 0 } } });
        // Someone else's address: refused, named plainly (no "{name}", each word of the field once).
        await page.fill("#email", "stranger@example.test");
        const no = await act(ctx(), { type: "click", target: { role: "button", name: "Send code", nth: 0 } });
        assert.ok("blocked" in no, JSON.stringify(no));
        assert.match(no.blocked, /fill it with \{coder\.username\}/);
        assert.doesNotMatch(no.blocked, /\{name\}|email email/);
        // The account's own (two accounts share it): pressed.
        await page.fill("#email", "me.same@example.test");
        const yes = await act(ctx(), { type: "click", target: { role: "button", name: "Send code", nth: 0 } });
        assert.ok("done" in yes, JSON.stringify(yes));
        assert.equal(await page.title(), "sent");
      } finally {
        await page.close();
        await close(a);
      }
    });
  });
});

describe("a code no one can type is never asked for", () => {
  let site: AuthSite;
  before(async () => {
    site = await startAuthSite({ users: [{ username: "me.code@example.test", password: "pw-LEAK-anyfix-91ab" }] });
  });
  after(async () => {
    await site?.close();
  });

  it("codeNeedsPerson: only a code or link to the person's own inbox or phone (a run never waits for a person)", () => {
    const parsed = parseAccounts({ accounts: {
      coder: { first: "email-code", username: "me.code@example.test" },
      texter: { first: "sms-code", username: "me.code@example.test" },
      caught: { first: "email-code", username: "me.code@example.test", codes: [{ catcher: "http://127.0.0.1:8025" }] },
      admin: { username: "me.code@example.test", password: { keychain: true } },
    } }).accounts;
    const store = fileStore(secretsPathFor(join(temp(), "cm")));
    const r = (label: string) => accountResolver(parsed.get(label)!, { host: "127.0.0.1:4000", store, env: {} });
    assert.match(codeNeedsPerson(parsed.get("coder")!, r("coder"), "http://127.0.0.1:4000") ?? "", /a run never waits for a person, so nothing was sent\. Fix: press Set up sign-in for coder under Accounts/);
    assert.match(codeNeedsPerson(parsed.get("texter")!, r("texter"), "http://127.0.0.1:4000") ?? "", /a code by text.*QA account that doesn't sign in by text/);
    assert.equal(codeNeedsPerson(parsed.get("caught")!, r("caught"), "http://127.0.0.1:4000"), undefined, "a mail catcher reads it");
    assert.equal(codeNeedsPerson(parsed.get("admin")!, r("admin"), "http://127.0.0.1:4000"), undefined, "a password needs no one");
  });

  for (const setup of [false, true]) {
    it(`the terminal, ${setup ? "test --setup --as" : "a saved test run as the account"}: BLOCKED CODE_NEEDS_PERSON (never a pass) before anything reaches the site`, async () => {
      const dir = temp();
      writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts: { coder: { first: "email-code", username: "me.code@example.test", signInPage: "/code", signedIn: { text: "Sign out" } } } }));
      const url = new URL("/app", site.url).href;
      if (!setup) {
        // A saved test that runs as coder: replayed with no AI, as a schedule or CI would.
        const tests = join(dir, "contextmachines", "tests", "site");
        mkdirSync(tests, { recursive: true });
        writeFileSync(join(tests, "welcome.json"), JSON.stringify({ version: 1, rules: 2, goal: "See Welcome back", url, as: "coder", steps: [{ title: "See the greeting", intent: "Look for Welcome back", check: { kind: "text_visible", text: "Welcome back" }, actions: [] }], savedAt: new Date().toISOString() }));
        markSignInOk(join(dir, "contextmachines"), new URL(site.url).host);
      }
      const hitsBefore = site.hits().length;
      const r = await new Promise<{ code: number | null; out: string }>((done) => {
        const { CI: _ci, ANTHROPIC_API_KEY: _key, ...rest } = process.env;
        const args = [join(import.meta.dirname, "contextmachines.ts"), "test", ...(setup ? ["--setup", "--as", "coder", "--yes", "--url", url] : []), "--ai", "none"];
        const child = spawn(process.execPath, args, { cwd: dir, env: { ...rest, NO_COLOR: "1", CM_SECRET_STORE: "file" }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (out += c));
        child.on("close", (code) => done({ code, out }));
      });
      // --setup: BLOCKED (exit 4). The saved suite says a test whose sign-in was blocked "couldn't run" (exit 3), as it always has.
      assert.equal(r.code, setup ? 4 : 3, r.out);
      assert.match(r.out, setup ? /BLOCKED CODE_NEEDS_PERSON: coder signs in with a code by email/ : /couldn't run: CODE_NEEDS_PERSON: coder signs in with a code by email/);
      assert.match(r.out, /nothing was sent/);
      assert.doesNotMatch(r.out, /PASS/);
      assert.equal(site.hits().length, hitsBefore, `the site saw nothing: ${site.hits().slice(hitsBefore).join(", ")}`);
    });
  }
});

describe("the classic page forgets a session after 'my own account' is taken back", () => {
  it("forget answers 200 with no acknowledgement; save is still refused", async () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts: { admin: { username: "me.forget@example.test", password: { keychain: true } } } }));
    const outDir = join(dir, "contextmachines");
    mkdirSync(join(outDir, ".auth"), { recursive: true });
    const url = "http://127.0.0.1:4999/app";
    const session = sessionPathFor(outDir, url, "admin");
    writeFileSync(session, JSON.stringify({ cookies: [], origins: [] }));
    const ui = await startUi({ outDir, testsDir: join(outDir, "tests"), ai: undefined, vars: {}, mask: makeMasker(), allowHosts: [], headed: false, maxActions: 5, projectDir: dir, store: fileStore(secretsPathFor(outDir)), env: {} });
    const post = async (path: string, body: unknown) => (await fetch(`${ui.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": ui.token }, body: JSON.stringify(body) })).status;
    try {
      assert.equal(signInAllowed(outDir, "127.0.0.1:4999"), false);
      assert.equal(await post("/api/accounts/save", { url, label: "admin", first: "password" }), 403);
      assert.equal(await post("/api/accounts/forget", { url, label: "admin" }), 200);
      assert.equal(existsSync(session), false, "the session is gone");
    } finally {
      await ui.close();
    }
  });
});
