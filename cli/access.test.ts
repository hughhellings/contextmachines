// Login checkpoint 3 (AUTH C15, C19, C13): owner access sent only to the owner's exact host, the
// verdict codes for a site that turns the browser away, and sign-in providers' pages (nothing typed
// there, a sign-in window left to answer its opener). Offline: the local auth fixture, a scripted
// brain, no AI, no network.
//   node --test cli/access.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { accessRefusal, clerkTokenUrl, onProvider, ownerHeadersFor, PROVIDER_HOSTS, type OwnerAccess } from "../packages/scanner/src/tester/access.ts";
import { act, guardSite, type ActContext } from "../packages/scanner/src/tester/act.ts";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { newSignInGuard, runTest } from "../packages/scanner/src/tester/run.ts";
import { SIGN_IN_CODES, type Action, type DecideInput, type PlannedStep, type TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { AccountConfigError, accountResolver, clerkFapiHost, fileStore, headerNameProblem, markMine, markSignInOk, mintClerkTestingToken, ownerAccessFor, parseAccounts, secretsPathFor } from "./accounts.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { AUTH_TASKS, runAuthTask, type BrainFor } from "./bench/auth-bench.ts";
import { codeFix, ensureSession, keepOnly, signInByHand, withoutProviders, type SessionNeed } from "./signin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const temp = (p = "cm-access-") => mkdtempSync(join(tmpdir(), p));
const HEADER = { name: "x-qa-bypass", value: "owner-LEAK-hdr-6f1d2c9a7b3e5d4c" };
const VERCEL = "vercel-LEAK-bypass-91aa3c7e5d";
const BASIC = { username: "team", password: "basic-LEAK-pw-77c1e2" };
const CLERK_SK = "sk_test_LEAKc" + "lerk0b9f4e2a1c";

const access = (host: string, extra: Partial<OwnerAccess> = {}): OwnerAccess => ({ host, headers: { [HEADER.name]: HEADER.value }, kinds: { basic: false, vercel: false, tokens: true }, values: [HEADER.value], ...extra });

/** A brain that plans the given steps and clicks or fills by name; "done" when it has nothing left. */
type Move = { click: string; role?: string } | { fill: string; value: string } | { wait: number } | "done";
function scripted(steps: PlannedStep[], moves: Record<number, Move[]> = {}): TesterBrain {
  const left = Object.fromEntries(Object.entries(moves).map(([n, m]) => [n, [...m]]));
  const refOf = (snapshot: string, name: string, role = "\\w+") => new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(snapshot)?.[1] ?? "e9999";
  return {
    async plan() {
      return steps;
    },
    async decide(input: DecideInput): Promise<Action> {
      const m = left[input.n]?.shift() ?? "done";
      if (m === "done") return { type: "done" };
      if ("click" in m) return { type: "click", ref: refOf(input.snapshot, m.click, m.role) };
      if ("fill" in m) return { type: "fill", ref: refOf(input.snapshot, m.fill), value: m.value };
      return { type: "wait", ms: m.wait };
    },
  };
}

let browser: Browser;
let site: AuthSite;
const dirs: string[] = [];
before(async () => {
  browser = await launch(false);
  site = await startAuthSite({ owner: { header: HEADER, vercel: VERCEL, basic: BASIC, clerkSecretKey: CLERK_SK } });
});
after(async () => {
  await site?.close();
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = temp();
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------------------------
// C15: the rules, without a browser.

describe("C15: owner access goes to the owner's exact host only", () => {
  it("headers for the exact host and port; none for a subdomain, a sibling, another port, another scheme's host or a provider", () => {
    const a = access("staging.example.com");
    assert.deepEqual(ownerHeadersFor(a, "https://staging.example.com/app"), { [HEADER.name]: HEADER.value });
    // Never in clear text over the network: plain http only to this machine (review fix).
    assert.equal(ownerHeadersFor(a, "http://staging.example.com/x?y=1"), undefined);
    for (const u of ["https://api.staging.example.com/", "https://example.com/", "https://staging.example.com.evil.test/", "https://staging.example.com:8443/", "https://other.vercel.app/", "https://accounts.google.com/", "ftp://staging.example.com/", "not a url"]) assert.equal(ownerHeadersFor(a, u), undefined, u);
    const v = access("my-app-git-main.vercel.app");
    assert.equal(ownerHeadersFor(v, "https://my-app-git-other.vercel.app/"), undefined, "a sibling vercel.app host gets nothing");
    assert.equal(ownerHeadersFor(undefined, "https://staging.example.com/"), undefined);
  });

  it("only allowlisted header names are ever sent, whatever the object holds", () => {
    const a = access("h.test", { headers: { "x-qa-bypass": "v1", authorization: "Basic eA==", "cf-access-client-id": "id", cookie: "sid=1", forwarded: "for=1.2.3.4", host: "evil", "": "x" } });
    assert.deepEqual(Object.keys(ownerHeadersFor(a, "https://h.test/")!).sort(), ["authorization", "cf-access-client-id", "x-qa-bypass"]);
  });

  it("a Clerk Testing Token goes as a query parameter to /v1/ on the Frontend API host only", () => {
    const a = access("app.test", { clerk: { fapiHost: "clerk.app.test", token: "tok123" } });
    assert.equal(clerkTokenUrl(a, "https://clerk.app.test/v1/client?x=1"), "https://clerk.app.test/v1/client?x=1&__clerk_testing_token=tok123");
    for (const u of ["https://clerk.app.test/npm/clerk.js", "https://clerk.app.test/v2/client", "https://app.test/v1/client", "https://x.clerk.app.test/v1/client", "https://clerk.app.test/xv1/"]) assert.equal(clerkTokenUrl(a, u), undefined, u);
    assert.equal(ownerHeadersFor(a, "https://clerk.app.test/v1/client"), undefined, "the Frontend API gets no header");
  });

  it("an owner's own header: x- names only, never one that says who or where the browser is", () => {
    assert.equal(headerNameProblem("x-qa-bypass"), undefined);
    assert.equal(headerNameProblem("X-Staging-Key"), undefined);
    for (const bad of ["authorization", "forwarded", "true-client-ip", "x-forwarded-for", "x-real-ip", "x-client-ip", "x-originating-ip", "x-cluster-client-ip", "x-remote-addr", "x-my-ip", "x-agent-name", "x-fingerprint", "x-crawler", "x-bot", "x-vercel-protection-bypass", "x-contextmachines-test", "x-clerk-token", "x-", "x-has space"]) assert.ok(headerNameProblem(bad), bad);
  });

  it("the config: a secret is never a plain string, env names are CM_ only, a bad header name is refused, and the Frontend API host is read from the key", () => {
    const pk = `pk_test_${Buffer.from("clerk.app.test$").toString("base64")}`;
    assert.equal(clerkFapiHost(pk), "clerk.app.test");
    assert.equal(clerkFapiHost("pk_test_!!"), undefined);
    const ok = parseAccounts({ sites: { "Staging.Example.com": { vercelBypass: { env: "CM_SITE_VERCEL_BYPASS" }, header: { name: "x-qa-bypass", value: { keychain: true } }, clerk: { publishableKey: pk, secretKey: { env: "CM_SITE_CLERK_SECRET_KEY" } }, basic: { username: "team", password: { keychain: true } }, marker: true } } });
    const s = ok.sites!.get("staging.example.com")!;
    assert.equal(s.clerk!.fapiHost, "clerk.app.test");
    assert.ok(ok.envNames.includes("CM_SITE_VERCEL_BYPASS") && ok.envNames.includes("CM_SITE_CLERK_SECRET_KEY"), "the env names are kept from the AI");
    const refusals: unknown[] = [
      { sites: { "a.test": { vercelBypass: "plain-secret" } } },
      { sites: { "a.test": { vercelBypass: { env: "AWS_SECRET_ACCESS_KEY" } } } },
      { sites: { "a.test": { header: { name: "x-forwarded-for", value: { keychain: true } } } } },
      { sites: { "a.test": { header: { name: "x-ok", value: "inline" } } } },
      { sites: { "https://a.test/path": {} } },
      { sites: { "a.test": { clerk: { publishableKey: "nope", secretKey: { keychain: true } } } } },
      { sites: { "a.test": { userAgent: "x" } } },
    ];
    for (const r of refusals) assert.throws(() => parseAccounts(r), AccountConfigError, JSON.stringify(r));
  });

  it("a Testing Token is made with a test key only, never a live one", async () => {
    await assert.rejects(mintClerkTestingToken("sk_live_abc", { fetch: (async () => new Response("{}")) as typeof fetch }), /test secret key/);
    const token = await mintClerkTestingToken(CLERK_SK, { api: site.url });
    assert.match(token, /^cltt_/);
  });

  it("ownerAccessFor: nothing unless the host is marked mine; every value it carries is listed for the masker", async () => {
    const out = join(dir(), "cm");
    const host = new URL(site.url).host;
    const config = parseAccounts({ sites: { [host]: { header: { name: HEADER.name, value: { keychain: true } }, basic: { username: BASIC.username, password: { keychain: true } }, clerk: { publishableKey: site.clerkPublishableKey, secretKey: { env: "CM_SITE_CLERK_SECRET_KEY" } } } } });
    const store = fileStore(secretsPathFor(out));
    store.set(`${host}/site/header`, HEADER.value);
    store.set(`${host}/site/basic_password`, BASIC.password);
    const env = { CM_SITE_CLERK_SECRET_KEY: CLERK_SK };
    const notMine = await ownerAccessFor({ config, outDir: out, url: site.url, store, env, clerkApi: site.url });
    assert.equal(notMine.access, undefined);
    assert.match(notMine.warning ?? "", /isn't marked as yours/);
    markMine(out, host);
    const got = await ownerAccessFor({ config, outDir: out, url: site.url, store, env, clerkApi: site.url });
    assert.ok(got.access, got.error ?? "no access");
    assert.equal(got.access.host, host);
    assert.equal(got.access.headers[HEADER.name], HEADER.value);
    assert.equal(got.access.headers.authorization, `Basic ${Buffer.from(`${BASIC.username}:${BASIC.password}`).toString("base64")}`);
    assert.equal(got.access.clerk!.fapiHost, new URL(site.otherUrl).host);
    for (const v of [HEADER.value, BASIC.password, CLERK_SK, got.access.clerk!.token]) assert.ok(got.access.values.includes(v), "every secret is listed for the masker");
    // A short header value is refused: one that lets traffic through should be long and random.
    store.set(`${host}/site/header`, "short");
    assert.match((await ownerAccessFor({ config, outDir: out, url: site.url, store, env, clerkApi: site.url })).error ?? "", /shorter than 16/);
    // Nothing set for a field it names: said before any browser starts.
    store.delete(`${host}/site/header`);
    assert.match((await ownerAccessFor({ config, outDir: out, url: site.url, store, env, clerkApi: site.url })).error ?? "", /no value for the header x-qa-bypass/);
  });

  it("a login page is told apart: basic auth's 401, Vercel's protection; a plain 401 or 403 isn't one", () => {
    assert.equal(accessRefusal({ status: 401, headers: { "www-authenticate": 'Basic realm="x"' }, url: "https://a.test/", title: "", text: "" })?.code, "AUTH_BASIC_REQUIRED");
    assert.equal(accessRefusal({ status: 401, headers: { server: "Vercel" }, url: "https://a.vercel.app/", title: "Authentication Required", text: "" })?.code, "VERCEL_BYPASS_REQUIRED");
    assert.equal(accessRefusal({ status: 200, headers: {}, url: "https://vercel.com/sso-api?url=x", title: "", text: "" })?.code, "VERCEL_BYPASS_REQUIRED");
    assert.equal(accessRefusal({ status: 401, headers: { "www-authenticate": "Bearer" }, url: "https://a.test/", title: "Sign in", text: "" }), undefined);
    assert.equal(accessRefusal({ status: 403, headers: {}, url: "https://a.test/", title: "Forbidden", text: "Authentication required" }), undefined, "not Vercel's: a site's own 403");
  });
});

// ---------------------------------------------------------------------------------------------
// C15 in a real browser, on the fixture: the owner host, the hops, the one Clerk exception.

describe("C15 in the browser: where the owner's values went", () => {
  it("/walled opens with the header; three redirects to another host carry none of it; the Clerk token reaches only /v1/ on its Frontend API", async () => {
    const host = new URL(site.url).host;
    const fapi = new URL(site.otherUrl).host;
    const token = await mintClerkTestingToken(CLERK_SK, { api: site.url });
    const a = access(host, { headers: { [HEADER.name]: HEADER.value, authorization: `Basic ${Buffer.from(`${BASIC.username}:${BASIC.password}`).toString("base64")}` }, clerk: { fapiHost: fapi, token } });
    const context = await browser.newContext();
    // A page the router answered (route.fulfill) counts as a public one to Chromium, which then asks
    // before it calls another local port: granted here, in this test's own context only, so the
    // fetch hop and the Clerk call can reach the fixture's other instance at all.
    await context.grantPermissions(["local-network-access"]);
    try {
      const page = await context.newPage();
      await guardSite(page, site.url, ["localhost"], { owner: a });
      const before = site.otherLog().length;
      await page.goto(new URL("/walled", site.url).href);
      assert.match(await page.locator("h1").innerText(), /Walled App/);
      await page.goto(new URL("/basic", site.url).href);
      assert.match(await page.locator("h1").innerText(), /Basic area/);
      // The three hops: the page's background fetch, a GET link and a POST form, each 302 to the other host.
      await page.goto(new URL("/hop", site.url).href);
      await page.getByText(/Status: all good/).waitFor({ timeout: 10_000 });
      await page.getByRole("link", { name: "Our docs" }).click();
      await page.waitForURL(/\/landing\?via=get/);
      await page.goto(new URL("/hop", site.url).href);
      await page.getByRole("button", { name: "Continue to the docs" }).click();
      await page.waitForURL(/\/landing\?via=post/);
      await page.goto(new URL("/clerk", site.url).href);
      await page.getByText(/Clerk test mode: on/).waitFor({ timeout: 10_000 });
      const other = site.otherLog().slice(before);
      // /hop was opened twice, so its background fetch hopped twice.
      assert.equal(other.filter((r) => r.path === "/landing").length, 2, `the link's and the form's hops reached the other host: ${JSON.stringify(other.map((r) => r.path))}`);
      assert.ok(other.some((r) => r.path === "/api/ping"), "the background fetch's hop reached the other host");
      const hashed = (v: string) => import("node:crypto").then((c) => c.createHash("sha256").update(v).digest("hex").slice(0, 12));
      const secretHashes = await Promise.all([HEADER.value, a.headers.authorization!, token].map(hashed));
      for (const r of other) {
        for (const name of [HEADER.name, "authorization", "x-vercel-protection-bypass", "cf-access-client-secret"]) assert.ok(!(name in r.headers), `${r.path} got ${name}`);
        for (const h of Object.values(r.headers)) assert.ok(!secretHashes.includes(h), `${r.path} got an owner value`);
      }
      const tokened = other.filter((r) => r.query.includes("__clerk_testing_token"));
      assert.deepEqual([...new Set(tokened.map((r) => r.path))], ["/v1/client"], "exactly one non-owner destination for the token: the Frontend API's /v1/");
      assert.ok(other.some((r) => r.path === "/npm/clerk.js" && !r.query.includes("__clerk_testing_token")), "the Frontend API's other paths get no token");
    } finally {
      await context.close();
    }
  });

  it("route.continue and route.fallback never carry headers, and no browser or context option sends any (guard)", () => {
    const testerDir = join(here, "../packages/scanner/src/tester");
    const files = [...readdirSync(testerDir).filter((f) => f.endsWith(".ts")).map((f) => join(testerDir, f)), ...readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(here, f))];
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const f of files) {
      const text = code(readFileSync(f, "utf8"));
      for (const m of text.matchAll(/route\.(continue|fallback)\s*\(([^)]*)\)/g)) assert.equal(m[2]!.trim(), "", `${f}: route.${m[1]} is given ${m[2]}`);
      assert.doesNotMatch(text, /extraHTTPHeaders|httpCredentials|setExtraHTTPHeaders/, `${f} sets headers another way`);
      if (!f.endsWith("access.ts") && !f.endsWith("act.ts") && !f.endsWith("accounts.ts")) assert.doesNotMatch(text, /ownerHeadersFor\(|clerkTokenUrl\(/, `${f} builds owner headers`);
    }
    // In guardSite, an owner value goes out only through route.fetch, then route.fulfill.
    const act = code(readFileSync(join(testerDir, "act.ts"), "utf8"));
    const owner = act.slice(act.indexOf("const ownerRoute"), act.indexOf("await context.route("));
    assert.match(owner, /route\.fetch\(\{ headers: \{ \.\.\.sent, \.\.\.extra \}, maxRedirects: 0/);
    assert.match(owner, /route\.fulfill\(\{ response: res \}\)/);
    assert.doesNotMatch(owner, /route\.(continue|fallback)/);
  });
});

// ---------------------------------------------------------------------------------------------
// C19: the codes a site that turns the browser away ends with, each from one fixture case.

describe("C19: verdict codes for a site the browser can't get onto", () => {
  const open = (route: string, o: { owner?: OwnerAccess; mine?: boolean } = {}) => runTest({
    goal: "Open the page and see it", url: new URL(route, site.url).href, dir: join(dir(), "run"), browser, wallWaitMs: 500, checkWaitMs: 1500,
    brain: scripted([{ title: "See the page", intent: "Look at the page", check: { kind: "text_visible", text: route === "/vercel" ? "This is the preview" : route === "/basic" ? "Only for the team" : "Welcome to the walled app" } }]),
    ...(o.owner ? { owner: o.owner } : {}), ...(o.mine ? { ownedHost: true } : {}),
  });

  it("ACCESS_TOKEN_REQUIRED: a bot check on a host you own, no token; with the token it passes", async () => {
    const none = await open("/walled", { mine: true });
    assert.equal(none.result.verdict, "blocked");
    assert.equal(none.result.code, "ACCESS_TOKEN_REQUIRED");
    assert.match(none.result.steps[0]!.reason ?? none.result.steps[0]!.title, /./);
    const notMine = await open("/walled");
    assert.equal(notMine.result.verdict, "blocked");
    assert.equal(notMine.result.code, undefined, "on a host not marked yours it is the plain bot-check block");
    const host = new URL(site.url).host;
    const ok = await open("/walled", { mine: true, owner: access(host) });
    assert.equal(ok.result.verdict, "pass", JSON.stringify(ok.result.steps.map((s) => s.reason)));
    assert.doesNotMatch(JSON.stringify(ok.result), new RegExp(HEADER.value), "the header's value is in no result");
  });

  it("AUTH_BASIC_REQUIRED and VERCEL_BYPASS_REQUIRED, and each passes with its owner value", async () => {
    const host = new URL(site.url).host;
    const basic = await open("/basic", { mine: true });
    assert.equal(basic.result.code, "AUTH_BASIC_REQUIRED");
    assert.equal(basic.result.verdict, "blocked");
    const vercel = await open("/vercel", { mine: true });
    assert.equal(vercel.result.code, "VERCEL_BYPASS_REQUIRED");
    const both = access(host, { headers: { authorization: `Basic ${Buffer.from(`${BASIC.username}:${BASIC.password}`).toString("base64")}`, "x-vercel-protection-bypass": VERCEL, "x-vercel-set-bypass-cookie": "true" }, kinds: { basic: true, vercel: true, tokens: true } });
    assert.equal((await open("/basic", { mine: true, owner: both })).result.verdict, "pass");
    assert.equal((await open("/vercel", { mine: true, owner: both })).result.verdict, "pass");
  });

  it("the sign-in codes, each from one fixture case: a refused password, a locked account, no value, an expired session that may not be renewed", async () => {
    const out = join(dir(), "cm");
    const host = new URL(site.url).host;
    markMine(out, host);
    const store = fileStore(secretsPathFor(out));
    const accountOn = (route: string, extra: Record<string, unknown> = {}) => parseAccounts({ accounts: { admin: { first: "password", username: "admin@example.test", password: { keychain: true }, signInPage: route, signedIn: { text: "Sign out" }, ...extra } } }).accounts.get("admin")!;
    const signInBrain: TesterBrain = {
      async plan(goal) {
        return [{ title: "Sign in", intent: goal, check: { kind: "signed_in", text: "Sign out" } }];
      },
      async decide(input) {
        const r = (role: string, name: RegExp) => [...input.snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].find((m) => m[2] === role && name.test(m[3]!))?.[1];
        const h = input.history.join("\n");
        if (!h.includes("{admin.username}") && r("textbox", /^email$/i)) return { type: "fill", ref: r("textbox", /^email$/i)!, value: "{admin.username}" };
        if (!h.includes("{admin.password}") && r("textbox", /^password$/i)) return { type: "fill", ref: r("textbox", /^password$/i)!, value: "{admin.password}" };
        if (!h.includes("Clicking") && r("button", /^sign in$/i)) return { type: "click", ref: r("button", /^sign in$/i)! };
        return { type: "done" };
      },
    };
    const need = (account: ReturnType<typeof accountOn>, extra: Partial<SessionNeed> = {}): SessionNeed => ({
      outDir: out, url: new URL(account.signInPage!, site.url).href, account, resolver: accountResolver(account, { host, store, env: {} }), mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(out, "runs"), brain: signInBrain, ...extra,
    });
    // No password stored: said before the browser starts.
    store.delete(`${host}/admin/password`);
    const none = await ensureSession(need(accountOn("/login")));
    assert.ok("blocked" in none && none.code === "AUTH_CREDENTIAL_UNAVAILABLE", JSON.stringify(none).slice(0, 300));
    // The site says the password is wrong.
    store.set(`${host}/admin/password`, "wrong-LEAK-pw-0001");
    const wrong = await ensureSession(need(accountOn("/login")));
    assert.ok("blocked" in wrong && wrong.code === "AUTH_CREDENTIAL_INVALID", JSON.stringify(wrong).slice(0, 300));
    // The site has locked the account (three wrong tries already, by someone else).
    for (let k = 0; k < 3; k++) await fetch(new URL("/lockout", site.url), { method: "POST", body: new URLSearchParams({ email: "admin@example.test", password: "x" }) });
    const locked = await ensureSession(need(accountOn("/lockout")));
    assert.ok("blocked" in locked && locked.code === "AUTH_ACCOUNT_LOCKED_OUT", JSON.stringify(locked).slice(0, 300));
    // A session that has expired, with --relogin never.
    store.set(`${host}/admin/password`, "pw-fixture-admin-1");
    const expired = await ensureSession(need(accountOn("/login"), { relogin: "never" }), { force: true });
    assert.ok("blocked" in expired && expired.code === "AUTH_SESSION_EXPIRED", JSON.stringify(expired).slice(0, 300));
  });

  it("every code has a one-line fix, and each is made by a fixture case (here, codes.test.ts, auth.test.ts, signin-ok.test.ts or the auth bench tasks)", () => {
    assert.equal(SIGN_IN_CODES.length, 21, "the plan's 10, CODE_NOT_SURE, recovery's SEED_DATA_MISSING, the any-site sign-in's CODE_NEEDS_PERSON and SIGN_IN_NOT_CONFIRMED, the app's AUTH_ACCOUNT_NEEDED, ACCOUNT_NOT_CHOSEN and VALUE_NEEDED, and A1's SMS_CODE_NEEDED, DEVICE_CHECK, TEST_CODE_NOT_ALLOWED and BOT_CHECK_NEEDS_PERSON");
    // auth-bench.ts's tasks name the code each must end with; codes.test.ts runs them and asserts it.
    const listed = ["access.test.ts", "codes.test.ts", "auth.test.ts", "signin-ok.test.ts", "login-parity.test.ts", "app/use-account.test.ts", "tester.test.ts", "knowledge.test.ts", "bench/auth-bench.ts"];
    // The public repository leaves out tests that reach unpublished code: there, a code made only in one of those isn't looked for.
    const unpublished = listed.some((f) => !existsSync(join(here, f)));
    const tests = listed.filter((f) => existsSync(join(here, f))).map((f) => readFileSync(join(here, f), "utf8")).join("\n");
    for (const code of SIGN_IN_CODES) {
      const fix = codeFix(code, { label: "admin" }, "https://staging.example.com/");
      assert.ok(fix && fix.length > 20 && !fix.includes("\n"), `${code} has a one-line fix`);
      const made = new RegExp(`(code|verdict)[^\\n]{0,80}"${code}"|"${code}"[^\\n]{0,80}(code|verdict)`);
      if (!unpublished || made.test(tests)) assert.match(tests, made, `${code} is produced by a fixture case`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C13: providers' pages and sign-in windows.

describe("C13: sign-in providers", () => {
  it("the listed hosts are Google's, Microsoft's, Apple's and GitHub's sign-in pages, and their subdomains", () => {
    for (const u of ["https://accounts.google.com/signin", "https://login.microsoftonline.com/common", "https://login.live.com/", "https://appleid.apple.com/auth", "https://github.com/login", "https://foo.accounts.google.com/"]) assert.ok(onProvider(u), u);
    for (const u of ["https://www.google.com/", "https://example.com/", "https://notgithub.com/", "https://microsoft.com/"]) assert.ok(!onProvider(u), u);
    assert.ok(onProvider("http://localhost:4000/authorize", ["localhost:4000"]));
    assert.ok(PROVIDER_HOSTS.includes("accounts.google.com") && PROVIDER_HOSTS.includes("appleid.apple.com"));
  });

  it("nothing is typed on a provider's page, even with --allow-host for it (a routed accounts.google.com, no network)", async () => {
    const context = await browser.newContext();
    try {
      await context.route("https://accounts.google.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Sign in</title><label for=e>Email</label><input id=e type=email><button>Next</button>` }));
      const page = await context.newPage();
      await page.goto("https://accounts.google.com/signin");
      const ctx: ActContext = { page, start: "https://accounts.google.com/", allowHosts: [], values: { vars: { email: "x@example.test" }, resolve: () => undefined }, mask: makeMasker(), offSite: () => undefined } as unknown as ActContext;
      const target = { role: "textbox", name: "Email", nth: 0 };
      for (const a of [{ type: "fill", target, value: "{email}" }, { type: "type", value: "x" }, { type: "press", key: "Enter" }] as const) {
        const out = await act(ctx, a as never);
        assert.ok("blocked" in out && /sign-in provider's page/.test(out.blocked), `${a.type}: ${JSON.stringify(out)}`);
      }
      assert.equal(await page.locator("#e").inputValue(), "", "nothing reached the field");
      // A test's own fake provider is named the same way.
      const fake = await context.newPage();
      await fake.goto(new URL("/authorize?client_id=x", site.otherUrl).href);
      const ctx2 = { ...ctx, page: fake, start: site.url, allowHosts: ["localhost"], providerHosts: [new URL(site.otherUrl).host] } as ActContext;
      const out = await act(ctx2, { type: "fill", target: { role: "textbox", name: "Email", nth: 0 }, value: "x@example.test" });
      assert.ok("blocked" in out, JSON.stringify(out));
    } finally {
      await context.close();
    }
  });

  it("the redirect handoff reaches the provider with the app's redirect_uri, and stops there", async () => {
    const out = await runTest({
      goal: "Continue with Fixture ID and reach its sign-in page", url: new URL("/oauth/start", site.url).href, dir: join(dir(), "run"), browser, allowHosts: ["localhost"], providerHosts: [new URL(site.otherUrl).host], checkWaitMs: 2000,
      brain: scripted([{ title: "Continue with Fixture ID", intent: "Click Continue with Fixture ID", check: { kind: "text_visible", text: "Sign in to Fixture ID" } }], { 1: [{ click: "Continue with Fixture ID" }] }),
    });
    assert.equal(out.result.verdict, "pass", JSON.stringify(out.result.steps.map((s) => s.reason)));
    assert.match(out.result.endUrl ?? "", /\/authorize\?/);
    assert.ok(site.hits().includes("/_event/provider/authorize"));
    assert.ok(!site.hits().includes("/_event/provider/typed"), "nothing was sent from the provider's form");
  });

  it("a sign-in window on an allowed host is left to answer its opener (and, since W4 keeps opened windows as tabs, without the rule too)", async () => {
    const run = (keep: boolean) => runTest({
      goal: "Sign in with Fixture ID in its window", url: new URL("/oauth/popup", site.url).href, dir: join(dir(), "run"), browser, allowHosts: ["localhost"], providerHosts: [new URL(site.otherUrl).host], checkWaitMs: 4000, ...(keep ? { keepPopups: true } : {}),
      brain: scripted([{ title: "Continue with Fixture ID", intent: "Click Continue with Fixture ID", check: { kind: "text_visible", text: "signed in as oauth.user" } }], { 1: [{ click: "Continue with Fixture ID" }, { wait: 1500 }] }),
    });
    const kept = await run(true);
    assert.equal(kept.result.verdict, "pass", JSON.stringify(kept.result.steps.map((s) => s.reason)));
    // W4: a window the page opens is kept as a tab the run can switch to (switch_tab), no longer closed,
    // so without the rule it is left to answer its opener too; the site guard still holds in it.
    const plain = await run(false);
    assert.equal(plain.result.verdict, "pass", JSON.stringify(plain.result.steps.map((s) => s.reason)));
  });

  it("by hand: a scripted person signs in on the provider's page; the saved session keeps 0 of its cookies or storage, and works", async () => {
    const out = join(dir(), "cm");
    const account = parseAccounts({ accounts: { admin: { first: "by-hand", signInPage: "/oauth/start", signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
    const provider = new URL(site.otherUrl);
    const person = async (page: import("playwright").Page) => {
      // What a person does in the window: continue, sign in at the provider, land back in the app.
      await page.getByRole("link", { name: "Continue with Fixture ID" }).click();
      await page.waitForURL(/\/authorize\?/);
      await page.evaluate(() => localStorage.setItem("idp_device", "provider-LEAK-store"));
      await page.getByLabel("Email").fill("admin@example.test");
      await page.getByLabel("Password").fill("pw-fixture-admin-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/app$/);
      return true;
    };
    const done = await signInByHand({ outDir: out, url: new URL("/app", site.url).href, account, browser, done: person, alsoKeep: ["accounts.google.com"] });
    assert.ok("path" in done, JSON.stringify(done));
    const saved = JSON.parse(readFileSync(done.path, "utf8")) as { cookies: { domain: string; name: string }[]; origins: { origin: string }[] };
    assert.equal(saved.cookies.filter((c) => c.domain.includes(provider.hostname)).length, 0, "no provider cookie is kept");
    assert.equal(saved.origins.filter((o) => o.origin.includes(provider.host)).length, 0, "no provider storage is kept");
    assert.ok(saved.cookies.some((c) => c.name === "sid"), "the app's own session is kept");
    assert.ok(done.dropped.cookies >= 1 && done.dropped.origins >= 1, JSON.stringify(done.dropped));
    assert.equal(statSync(done.path).mode & 0o777, 0o600);
    // It works: a page of the app opens signed in.
    const ctx = await browser.newContext({ storageState: done.path });
    const page = await ctx.newPage();
    await page.goto(new URL("/app", site.url).href);
    assert.match(await page.locator("body").innerText(), /Signed in as admin@example\.test/);
    await ctx.close();
    // Not signed in (cancelled, or the check doesn't hold): nothing saved.
    const out2 = join(dir(), "cm");
    assert.ok("error" in (await signInByHand({ outDir: out2, url: new URL("/app", site.url).href, account, browser, done: async () => false })));
    assert.ok("error" in (await signInByHand({ outDir: out2, url: new URL("/app", site.url).href, account, browser, done: async () => true })));
    assert.ok(!existsSync(join(out2, ".auth")) || readdirSync(join(out2, ".auth")).length === 0, "nothing was saved");
    // An expired by-hand session is never signed in again by a run (on a host you said is your own account): the fix is Set up sign-in.
    markSignInOk(out, new URL(site.url).host);
    const again = await ensureSession({ outDir: out, url: new URL("/app", site.url).href, account, resolver: accountResolver(account, { host: new URL(site.url).host, store: fileStore(secretsPathFor(out)), env: {} }), mask: makeMasker(), guard: newSignInGuard(), browser, runsDir: join(out, "runs") }, { force: true });
    assert.ok("blocked" in again && again.code === "AUTH_SESSION_EXPIRED" && /Set up sign-in for .* under Accounts/.test(again.blocked) && /accounts setup /.test(again.blocked), JSON.stringify(again).slice(0, 300));
  });

  it("keepOnly and withoutProviders: a provider's cookies and storage never stay", () => {
    const state = { cookies: [{ name: "a", value: "1", domain: ".google.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const }, { name: "b", value: "2", domain: "accounts.google.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const }, { name: "s", value: "3", domain: ".app.example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }, { name: "t", value: "4", domain: "tracker.example.net", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const }], origins: [{ origin: "https://accounts.google.com", localStorage: [] }, { origin: "https://app.example.com", localStorage: [] }] };
    const kept = keepOnly(state, ["app.example.com", "accounts.google.com"]);
    assert.deepEqual(kept.state.cookies.map((c) => c.name), ["s"]);
    assert.deepEqual(kept.state.origins.map((o) => o.origin), ["https://app.example.com"]);
    assert.deepEqual(withoutProviders(state).cookies.map((c) => c.name).sort(), ["s", "t"]);
  });

  it("guard: the by-hand window is launched as every run's browser (nothing hidden), and only act.ts decides where typing goes", () => {
    const signin = readFileSync(join(here, "signin.ts"), "utf8");
    const byHand = signin.slice(signin.indexOf("export async function signInByHand"));
    assert.match(byHand, /await launch\(true\)/, "the same launch as every run, headed");
    assert.doesNotMatch(byHand, /chromium\.launch|args\s*:|ignore\w*Args|headless\s*:\s*false/);
    const act = readFileSync(join(here, "../packages/scanner/src/tester/act.ts"), "utf8");
    const at = act.indexOf("onProvider(page.url(), ctx.providerHosts)");
    assert.ok(at > 0 && at < act.indexOf("switch (cached.type)", at), "the provider check comes before any action is done");
  });
});

// ---------------------------------------------------------------------------------------------
// The bench's checkpoint 3 tasks, with a scripted brain: each right, 0 leaks, 0 owner hops.

describe("the auth bench's checkpoint 3 tasks (scripted brain)", () => {
  const brainFor: BrainFor = (noted, _use) => ({
    async plan(goal) {
      noted.push({ what: "plan", model: "scripted", chars: 0, ms: 0, at: 0 });
      if (/Reports/.test(goal)) return [{ title: "Open Reports", intent: "Click Reports", check: { kind: "text_visible", text: "Quarterly numbers" } }];
      if (/its sign-in page opens/.test(goal)) return [{ title: "Continue with Fixture ID", intent: "Click Continue with Fixture ID", check: { kind: "text_visible", text: "Sign in to Fixture ID" } }];
      return [{ title: "Sign in with Fixture ID", intent: "Click Continue with Fixture ID", check: { kind: "text_visible", text: "signed in as oauth.user" } }];
    },
    async decide(input) {
      noted.push({ what: "decide", model: "scripted", chars: 0, ms: 0, at: 0 });
      if (input.history.some((h) => h.includes("Clicking"))) return { type: "done" };
      const ref = [...input.snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].find((m) => /^(Reports|Continue with Fixture ID)$/.test(m[3]!))?.[1];
      return ref ? { type: "click", ref } : { type: "done" };
    },
  });
  for (const id of ["au-wall-token", "au-wall-none", "au-hop", "au-oauth-handoff", "au-oauth-popup"]) {
    it(id, async () => {
      const task = AUTH_TASKS.find((t) => t.id === id)!;
      const prompts: string[] = [];
      const row = await runAuthTask(task, { browser, brainFor, dir: dir(), prompts });
      assert.deepEqual(row.leaks, []);
      assert.equal(row.ownerHops, 0);
      assert.equal(row.right, true, JSON.stringify(row, null, 1));
      assert.equal(row.falsePass, false);
      if (id === "au-wall-none") assert.equal(row.asks, 0, "a wall in front: no AI is asked");
    });
  }
});

// ---------------------------------------------------------------------------------------------
// C22: the docs say what is built.

describe("C22: the README and PRIVACY.md", () => {
  const readme = readFileSync(join(here, "README.md"), "utf8");
  const privacy = readFileSync(join(here, "PRIVACY.md"), "utf8");
  it("every test flag is in the README", async () => {
    const { TEST_OPTIONS } = await import("./test-command.ts");
    const flags = [...new Set(TEST_OPTIONS.flatMap(([f]) => [...f.matchAll(/--[a-z][\w-]*/g)].map((m) => m[0])))];
    const missing = flags.filter((f) => !new RegExp(`\`[^\`]*${f}\\b`).test(readme));
    assert.deepEqual(missing, [], `flags not in the README: ${missing.join(", ")}`);
  });
  it("every account, site and environment key the config takes is in the README", () => {
    const keys = ["first", "username", "password", "totp", "signInPage", "signedIn", "whenToUse", "howToSignIn", "codes", "catcher", "testCode", "signUpDomain", "sites", "vercelBypass", "cfAccess", "basic", "header", "clerk", "publishableKey", "secretKey", "marker", "environments", "signUps", "keychain"];
    const missing = keys.filter((k) => !readme.includes(`"${k}"`) && !readme.includes(`\`${k}\``));
    assert.deepEqual(missing, []);
    for (const first of ["password", "email-code", "magic-link", "sign-up", "by-hand"]) assert.ok(readme.includes(`\`${first}\``), first);
    for (const code of SIGN_IN_CODES) assert.ok(readme.includes(`\`${code}\``), code);
    assert.match(readme, /Never use it to let traffic past a firewall: anyone can send it/);
    assert.match(readme, /never a personal one: the window shows it is automated/);
  });
  it("PRIVACY.md names the Keychain service and the four files", () => {
    assert.match(privacy, /service `contextmachines`/);
    for (const f of [".auth/secrets.json", ".auth/owned.json", ".auth/created.jsonl", ".auth/<host>@<label>.json"]) assert.ok(privacy.includes(f), f);
    assert.match(privacy, /sent only to that exact host/);
  });
});

