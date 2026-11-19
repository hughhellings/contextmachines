// Sign-in, checkpoint 1 (AUTH C21, C1a, C1b, C2, C3, C4, and the fixture, the inbox API and the leak
// check), offline: a real browser on the local auth fixture, a scripted brain, a fake Keychain. The
// real Keychain is touched only under a throwaway service name, and what is written is deleted.
//   node --test cli/auth.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { readSaved, writeSaved } from "../packages/scanner/src/tester/cache.ts";
import { verify } from "../packages/scanner/src/tester/check.ts";
import { makeMasker, placeholderNames, PLACEHOLDER } from "../packages/scanner/src/tester/placeholders.ts";
import { valueFor } from "../packages/scanner/src/tester/act.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import type { Action, Check, DecideInput, PlannedStep, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { agentEnv } from "./ai.ts";
import type { AskTiming } from "./ai.ts";
import { accountEnvName, accountProblem, accountResolver, AccountConfigError, fileStore, isMine, keychainStore, loadAccounts, markMine, ownedPathFor, parseAccounts, secretKey, type SecretRunner } from "./accounts.ts";
import { AUTH_TASKS, authTotals, runAuthTask, type BrainFor } from "./bench/auth-bench.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { leakForms, leakHits } from "./leak.ts";
import { signedInCheckFor, upgradeSignInSteps } from "./signin.ts";
import { ignoreAuth } from "./test-command.ts";
import { uiPage } from "./ui-page.ts";
import { safetyLine } from "./ui-server.ts";

const temp = (p = "cm-auth-") => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------------------------------------
// The scripted brain: it reads only what the AI would be shown (and records it, for the leak check).

const refs = (snapshot: string) => [...snapshot.matchAll(/\[(e\d+)\] (\w+) "([^"]*)"/g)].map((m) => ({ ref: m[1]!, role: m[2]!, name: m[3]! }));
const find = (snapshot: string, role: RegExp, name: RegExp) => refs(snapshot).find((r) => role.test(r.role) && name.test(r.name))?.ref;

function scriptedBrain(prompts: string[]): BrainFor {
  return (noted: AskTiming[], use) => ({
    async plan(goal, url, given, start) {
      prompts.push(JSON.stringify({ goal, url, given, start }));
      noted.push({ what: "plan", model: "scripted", chars: 0, ms: 0, at: 0 });
      if (use.signIn) return [{ title: "Sign in", intent: goal, check: use.signedIn }];
      if (/account settings/i.test(goal)) return [{ title: "Open Account settings", intent: "Click the Account settings link", check: { kind: "url_contains", text: "/app/settings" } }];
      return [{ title: "Open Page 3", intent: "Click the Page 3 link", check: { kind: "url_contains", text: "/page/3" } }];
    },
    async decide(input: DecideInput): Promise<Action> {
      prompts.push(JSON.stringify(input));
      noted.push({ what: "decide", model: "scripted", chars: input.snapshot.length, ms: 0, at: 0 });
      const s = input.snapshot;
      const h = input.history.join("\n");
      if (!use.signIn) {
        const link = find(s, /link/, /account settings|^page 3$/i);
        return /Clicking/.test(h) || !link ? { type: "done" } : { type: "click", ref: link };
      }
      const lastFill = h.lastIndexOf("Filling");
      const lastClick = h.lastIndexOf("Clicking on");
      const email = find(s, /textbox/, /^email$/i);
      const password = find(s, /textbox/, /^password$/i);
      const filledUser = h.includes("{admin.username}");
      const filledPw = h.includes("{admin.password}");
      if (email && !filledUser) return { type: "fill", ref: email, value: "{admin.username}" };
      if (password && !filledPw) return { type: "fill", ref: password, value: "{admin.password}" };
      const send = find(s, /button/, /^continue$/i) ?? find(s, /button/, /^sign in$/i);
      if (lastFill > lastClick && send) return { type: "click", ref: send };
      if (!email && !password && !filledUser && send && !h.includes("Clicking")) return { type: "click", ref: send };
      return { type: "done" };
    },
  });
}

// ---------------------------------------------------------------------------------------------

describe("C21: the footer line and the safety line", () => {
  it("the footer draws its top line once, on its own layer, and says an account may be picked", () => {
    const html = uiPage({ token: "token", nonce: "n" });
    const rule = /\.boxfoot \{([^}]*)\}/.exec(html)?.[1] ?? "";
    assert.ok(rule, "the .boxfoot rule is there");
    assert.doesNotMatch(rule, /box-shadow/);
    assert.match(rule, /border-top: 1px solid var\(--line\)/);
    assert.match(rule, /isolation: isolate/);
    assert.match(html, /Each task runs signed out, as a visitor, unless you pick an account\./);
  });

  it("the safety line is true to the run: signed out, or signed in as whom", () => {
    assert.match(safetyLine(), /^Signed out/);
    const signedIn = safetyLine({ host: "staging.example.com", label: "admin" });
    assert.match(signedIn, /^Signed in as admin on staging\.example\.com\./);
    assert.match(signedIn, /It can still change this account's data/);
    assert.doesNotMatch(signedIn, /signed out|never signs in/i);
    assert.match(safetyLine({ host: "x.test" }), /^Signed in on x\.test, with the session saved for it/);
  });

  it("in a real browser at 420, 800 and 900 px, scrolling a 14-task list: no shadow, and nothing crosses the footer's words", async () => {
    const browser = await launch(false);
    try {
      for (const width of [420, 800, 900]) {
        const page = await browser.newPage({ viewport: { width, height: 700 } });
        const html = uiPage({ token: "token", nonce: "n" }).replace(/<script[\s\S]*?<\/script>/g, "");
        await page.setContent(html);
        await page.evaluate(() => {
          const box = document.getElementById("tasksbox")!;
          box.hidden = false;
          const ul = document.getElementById("tasks")!;
          for (let i = 1; i <= 14; i++) {
            const li = document.createElement("li");
            li.textContent = `Task ${i}: a suggested task with enough words to wrap on a narrow screen`;
            li.style.padding = "12px";
            li.style.borderBottom = "1px solid #ccc";
            ul.append(li);
          }
        });
        for (const y of [0, 200, 400, 800]) {
          await page.mouse.wheel(0, y);
          await page.waitForTimeout(50);
          const r = await page.evaluate(() => {
            const foot = document.querySelector("#tasksbox .boxfoot") as HTMLElement;
            const words = foot.querySelector("span.muted") as HTMLElement;
            const s = getComputedStyle(foot);
            const b = words.getBoundingClientRect();
            const inView = b.bottom > 0 && b.top < innerHeight;
            const hit = inView ? document.elementFromPoint(b.left + Math.min(20, b.width / 2), b.top + b.height / 2) : null;
            return { shadow: s.boxShadow, isolation: s.isolation, covered: inView && hit !== null && !foot.contains(hit) };
          });
          assert.equal(r.shadow, "none", `${width}px`);
          assert.equal(r.isolation, "isolate", `${width}px`);
          assert.equal(r.covered, false, `something lay across the footer's words at ${width}px, scrolled ${y}`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
});

describe("C1b: one placeholder grammar, and a masker that learns mid-run", () => {
  it("reads {name} and {label.field}, and nothing looser", () => {
    assert.deepEqual(placeholderNames("Sign in as {admin.username} with {admin.password}, then {query} and {a.b.c} {9x} {}"), ["admin.username", "admin.password", "query"]);
    assert.deepEqual([..."{admin.password}".matchAll(PLACEHOLDER)].map((m) => m[1]), ["admin.password"]);
  });

  it("a value added mid-run is masked in the next line, in every form a page may echo it", () => {
    const mask = makeMasker({ email: "me@test.dev" });
    const pw = "pw-LEAK-a1 b2\"c3<d4>";
    assert.equal(mask(`x ${pw} y`), `x ${pw} y`, "not known yet");
    mask.add("admin.password", pw);
    for (const form of [pw, encodeURIComponent(pw), encodeURIComponent(pw).replace(/%20/g, "+"), JSON.stringify(pw).slice(1, -1), pw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), Buffer.from(pw).toString("base64").replace(/=+$/, ""), pw.toUpperCase(), pw.slice(0, 8)]) {
      const said = mask(`before ${form} after`);
      assert.match(said, /\{admin\.password\}/, `the form ${form} was masked`);
      assert.equal(leakHits({ pw }, [{ where: "x", text: said }]).length, 0, `nothing of it is left in: ${said}`);
    }
    assert.equal(mask("write me@test.dev"), "write {email}");
  });

  it("a cut-off value is masked: a label clipped to its first 9 characters", () => {
    const mask = makeMasker();
    mask.add("admin.username", "qa.leak.u7c1e9@example.test");
    assert.equal(mask("Signed in as qa.leak.u…"), "Signed in as {admin.username}…");
  });
});

describe("the leak check", () => {
  it("finds a value in each of its forms, and names the value, never prints it", () => {
    const v = "pw-LEAK-7c<1e\"9a 5Fq&";
    const forms = leakForms(v);
    assert.ok(forms.length >= 9, forms.map((f) => f.form).join(", "));
    for (const f of forms) {
      const hits = leakHits({ "admin.password": v }, [{ where: "file", text: `…${f.text}…` }]);
      assert.equal(hits.length, 1, f.form);
      assert.equal(hits[0]!.value, "admin.password");
      assert.ok(!JSON.stringify(hits).includes(v));
    }
    // base64 inside a longer base64 (user:password), at any alignment.
    for (const before of ["a:", "ab:", "abc:"]) assert.equal(leakHits({ v }, [{ where: "b", text: Buffer.from(`${before}${v}`).toString("base64") }]).length, 1, before);
    assert.equal(leakHits({ v }, [{ where: "c", text: "nothing here at all" }]).length, 0);
  });
});

describe("C1a: accounts, their secrets, and what reaches the AI", () => {
  it("refuses each bad config in one line (12 cases)", () => {
    const bad: [unknown, RegExp][] = [
      [{ accounts: [] }, /should be an object of label/],
      [{ accounts: { "Bad Label": {} } }, /1 to 32 of a-z/],
      [{ accounts: { admin: { password: "hunter22" } } }, /is a secret, so it can't sit in .*Keychain or an env var/],
      [{ accounts: { admin: { totp: "JBSWY3DPEHPK3PXP" } } }, /admin\.totp is a secret/],
      [{ accounts: { admin: { password: { env: "AWS_SECRET_ACCESS_KEY" } } } }, /must start with CM_/],
      [{ accounts: { admin: { password: { file: "/etc/passwd" } } } }, /should be \{ "keychain": true \} or \{ "env": "CM_…" \}/],
      [{ accounts: { admin: { password: { keychain: "yes" } } } }, /should be \{ "keychain": true \}/],
      [{ accounts: { admin: { username: "sam@realcompany.co.uk" } } }, /isn't a test address/],
      [{ accounts: { "a-b": {}, a_b: {} } }, /share the env names/],
      [{ accounts: { admin: { first: "carrier-pigeon" } } }, /first is "carrier-pigeon"/],
      [{ accounts: { admin: { whenToUse: "x".repeat(501) } } }, /at most 500/],
      [{ accounts: { admin: { signInPage: "login" } } }, /should be a path on the site/],
    ];
    for (const [raw, said] of bad) {
      assert.throws(() => parseAccounts(raw), (e: unknown) => e instanceof AccountConfigError && said.test(e.message) && !e.message.includes("\n"), JSON.stringify(raw));
    }
  });

  it("ignores a \"mine\" in the committed config, warns on words that look like a secret, and warns with no signed-in check", () => {
    const c = parseAccounts({ mine: ["evil.example"], accounts: { admin: { password: { keychain: true }, howToSignIn: "use otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", signedIn: { text: "Sign out" } }, member: { password: { env: "CM_ACCOUNT_MEMBER_PASSWORD" } } } });
    assert.ok(c.warnings.some((w) => /"mine" in contextmachines\.config\.json is ignored/.test(w)));
    assert.ok(c.warnings.some((w) => /howToSignIn holds what looks like an otpauth/.test(w)));
    assert.ok(c.warnings.some((w) => /"member" has no signed-in check/.test(w)));
    assert.deepEqual(c.envNames, ["CM_ACCOUNT_MEMBER_PASSWORD"]);
  });

  it("refuses words the AI reads that hold the stored password, and a password under 6 characters", () => {
    const account = parseAccounts({ accounts: { admin: { username: "a@example.test", password: { keychain: true }, howToSignIn: "type Tr0ub4dor&3 into the box" } } }).accounts.get("admin")!;
    const store = fileStore(join(temp(), "s.json"));
    store.set(secretKey("h.test", "admin", "password"), "Tr0ub4dor&3");
    assert.match(accountProblem(account, accountResolver(account, { host: "h.test", store, env: {} }))!, /howToSignIn holds admin's password/);
    store.set(secretKey("h.test", "admin", "password"), "abc12");
    assert.match(accountProblem(account, accountResolver(account, { host: "h.test", store, env: {} }))!, /shorter than 6/);
  });

  it("an env var beats the Keychain, per environment first", () => {
    const account = parseAccounts({ accounts: { admin: { username: "a@example.test", password: { keychain: true } } } }).accounts.get("admin")!;
    const store = fileStore(join(temp(), "s.json"));
    store.set(secretKey("h.test", "admin", "password"), "from-the-store");
    assert.equal(accountResolver(account, { host: "h.test", store, env: {} }).get("admin.password"), "from-the-store");
    assert.equal(accountResolver(account, { host: "h.test", store, env: { CM_ACCOUNT_ADMIN_PASSWORD: "from-the-env" } }).get("admin.password"), "from-the-env");
    assert.equal(accountResolver(account, { host: "h.test", store, env: { CM_ACCOUNT_ADMIN_PASSWORD: "plain", CM_ACCOUNT_ADMIN_STAGING_PASSWORD: "staging" }, environment: "staging" }).get("admin.password"), "staging");
    assert.equal(accountEnvName("new-user", "password", "live"), "CM_ACCOUNT_NEW_USER_LIVE_PASSWORD");
  });

  it("the Keychain gets each value on stdin, base64, never in its arguments; 200 random values round-trip", () => {
    const items = new Map<string, string>();
    const calls: { program: string; args: string[]; stdin: string }[] = [];
    const fake: SecretRunner = (program, args, stdin) => {
      calls.push({ program, args, stdin });
      if (args[0] === "-i") {
        const m = /-a "([^"]+)" -w "([^"]+)"/.exec(stdin);
        if (!m) return { code: 1, out: "" };
        items.set(m[1]!, m[2]!);
        return { code: 0, out: "" };
      }
      if (args[0] === "find-generic-password") {
        const v = items.get(args[args.indexOf("-a") + 1]!);
        return v === undefined ? { code: 44, out: "" } : { code: 0, out: `${v}\n` };
      }
      return { code: 0, out: "" };
    };
    const store = keychainStore("contextmachines-test-fake", fake);
    const chars = Array.from("abcXYZ019 \"'\\\n\t$`!é漢😀;&|<>{}");
    for (let i = 0; i < 200; i++) {
      const v = Array.from({ length: 1 + ((i * 7) % 40) }, (_, k) => chars[(i * 31 + k * 17) % chars.length]).join("") + i;
      store.set(`h.test/admin/password`, v);
      assert.equal(store.get(`h.test/admin/password`), v, JSON.stringify(v));
      const write = calls.filter((c) => c.args[0] === "-i").at(-1)!;
      assert.equal(write.program, "/usr/bin/security");
      assert.ok(!write.args.join(" ").includes(v), "never in the arguments");
      assert.ok(!write.stdin.includes(v) || v.length < 3, "base64 on stdin, never the value itself");
    }
    assert.ok(calls.every((c) => c.program === "/usr/bin/security"), "at its absolute path, never through PATH");
  });

  it("the real Keychain, under a throwaway service, round-trips awkward values and is cleaned up", { skip: process.platform !== "darwin" }, () => {
    const service = `contextmachines-test-${Math.random().toString(36).slice(2, 10)}`;
    const store = keychainStore(service);
    const key = "127.0.0.1-1/admin/password";
    try {
      try {
        store.set(key, "probe-value-1");
      } catch {
        return; // no Keychain here (a locked one, no one to ask): the file store is used instead
      }
      for (const v of ['quote " and \\ back', "new\nline", "é and 漢 and 😀", "  spaces  "]) {
        store.set(key, v);
        assert.equal(store.get(key), v);
      }
    } finally {
      store.delete(key);
      assert.equal(store.get(key), undefined, "deleted");
    }
  });

  it("none of 8 planted account, site or config-named values reach the AI's process", () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ accounts: { admin: { username: "a@example.test", password: { env: "CM_MY_ADMIN_PW" } }, ops: { password: { env: "VERCEL_AUTOMATION_BYPASS_SECRET" } } } }));
    loadAccounts(dir);
    const planted: Record<string, string> = {
      CM_ACCOUNT_ADMIN_PASSWORD: "plant-1-x9", CM_ACCOUNT_ADMIN_STAGING_USERNAME: "plant-2-x9", CM_ACCOUNT_ADMIN_TOTP: "plant-3-x9", CM_SITE_STAGING_VERCEL_BYPASS: "plant-4-x9",
      CM_SITE_LIVE_HEADER: "plant-5-x9", CM_VAR_PASSWORD: "plant-6-x9", CM_MY_ADMIN_PW: "plant-7-x9", VERCEL_AUTOMATION_BYPASS_SECRET: "plant-8-x9",
    };
    for (const agent of ["claude", "codex"] as const) {
      const env = agentEnv(agent, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...planted });
      // A fake agent: a child process that prints every value it was given.
      const seen = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env, encoding: "utf8" }).stdout;
      for (const [name, value] of Object.entries(planted)) assert.ok(!seen.includes(value), `${name} reached the ${agent} process`);
    }
  });

  it("\"mine\" is per machine, owner-only, beside a .gitignore that keeps .auth/ out of git", () => {
    const out = temp();
    assert.equal(isMine(out, "127.0.0.1:4000"), false);
    markMine(out, "127.0.0.1:4000");
    assert.equal(isMine(out, "127.0.0.1:4000"), true);
    assert.equal(isMine(out, "ci.example.com", "ci.example.com"), true, "CI names its host with --owner-host");
    assert.equal(statSync(ownedPathFor(out)).mode & 0o777, 0o600);
    assert.equal(statSync(join(out, ".auth")).mode & 0o777, 0o700);
    ignoreAuth(out);
    assert.match(readFileSync(join(out, ".gitignore"), "utf8"), /^\.auth\/$/m);
    const f = fileStore(join(out, ".auth", "secrets.json"));
    f.set("k", "v-123456");
    assert.equal(statSync(join(out, ".auth", "secrets.json")).mode & 0o777, 0o600);
  });
});

describe("the accounts command", () => {
  it("stores a password from stdin on a host marked yours only, and its list shows no value (0 leak hits)", async () => {
    const dir = temp();
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ url: "http://127.0.0.1:4555/", accounts: { admin: { username: "qa.cmd@example.test", password: { keychain: true }, signedIn: { text: "Sign out" } } } }));
    const env = { CM_SECRET_STORE: "file" };
    const said: string[] = [];
    const output = { write: (t: string) => (said.push(String(t)), true), isTTY: false, columns: 100 } as unknown as NodeJS.WriteStream;
    const { Readable } = await import("node:stream");
    const input = (text: string) => Object.assign(Readable.from([text]), { isTTY: false }) as unknown as NodeJS.ReadStream;
    const { runAccountsCommand } = await import("./accounts-command.ts");
    const pw = "pw-LEAK-cmd-8f2e1a";
    const errs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => (errs.push(String(t)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await runAccountsCommand(["secret", "admin", "password"], { dir, env, input: input(`${pw}\n`), output }), 2, "refused: no one to ask (no terminal) and no --yes, so it isn't said to be your own account there");
      assert.equal(await runAccountsCommand(["mine", "127.0.0.1:4555"], { dir, env, output }), 2, "no one to ask, no --yes: not marked");
      assert.equal(await runAccountsCommand(["mine", "127.0.0.1:4555", "--yes"], { dir, env, output }), 0);
      assert.equal(await runAccountsCommand(["secret", "admin", "password"], { dir, env, input: input(`${pw}\n`), output }), 0);
      assert.equal(await runAccountsCommand([], { dir, env, output }), 0);
    } finally {
      process.stderr.write = write;
    }
    const stored = JSON.parse(readFileSync(join(dir, "contextmachines", ".auth", "secrets.json"), "utf8")) as Record<string, string>;
    assert.equal(stored["127.0.0.1:4555/admin/password"], pw);
    assert.equal(statSync(join(dir, "contextmachines", ".auth", "secrets.json")).mode & 0o777, 0o600);
    const text = [...said, ...errs].join("");
    assert.match(text, /password set/);
    assert.equal(leakHits({ pw }, [{ where: "accounts output", text }]).length, 0, text);
  });
});

describe("C2: a password only by its handle, only into a password field", () => {
  const values = { vars: {}, given: "", resolve: (n: string) => ({ "admin.password": "pw-LEAK-zz9", "admin.username": "u@example.test" })[n] };
  it("refuses a password placeholder aimed at a box that shows what is typed", () => {
    assert.match((valueFor("{admin.password}", values, false) as { refused: string }).refused, /only typed into a password field/);
    assert.deepEqual(valueFor("{admin.password}", values, true), { value: "pw-LEAK-zz9" });
    assert.deepEqual(valueFor("{admin.username}", values, false), { value: "u@example.test" });
    assert.match((valueFor("{member.password}", values, true) as { refused: string }).refused, /there's no value for \{member\.password\}/);
    assert.match((valueFor("hunter2-typed", values, true) as { refused: string }).refused, /only takes a --var value/);
  });
});

describe("C3: signed in, measured", () => {
  let site: AuthSite;
  let browser: Browser;
  before(async () => {
    site = await startAuthSite({ users: [{ username: "t@example.test", password: "pw-trap-123" }] });
    browser = await launch(false);
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  it("the three traps fail the check; a dialog sign-in on / passes it", async () => {
    const check = signedInCheckFor({ signedIn: { text: "Sign out" } });
    for (const trap of ["/trap-email", "/trap-code", "/trap-wrong"]) {
      const page = await browser.newPage();
      await page.goto(new URL(trap, site.url).href);
      await page.fill("#email", "t@example.test");
      await page.fill("#password", "pw-trap-123");
      await page.click("button[type=submit]");
      await page.waitForLoadState("domcontentloaded");
      for (const c of [check, { kind: "signed_in" } as Check]) {
        const v = await verify(page, c, 500);
        assert.equal(v.ok, false, `${trap} with ${JSON.stringify(c)}: ${v.found}`);
      }
      await page.close();
    }
    const page = await browser.newPage();
    await page.goto(new URL("/modal", site.url).href);
    await page.click("#open");
    await page.fill("#m-email", "t@example.test");
    await page.fill("#m-password", "pw-trap-123");
    await page.click("text=Continue");
    assert.equal((await verify(page, check)).ok, true);
    assert.match(page.url(), /\/modal$/, "the address never changed");
    await page.close();
  });

  it("an old saved sign-in ending with password_gone is upgraded on load, and then fails on the code trap", async () => {
    const out = temp();
    const file = join(out, "old.setup.json");
    writeSaved(file, { goal: "log in", url: site.url, steps: [{ title: "Sign in", intent: "Sign in", check: { kind: "password_gone" }, actions: [] as never }] });
    const raw = JSON.parse(readFileSync(file, "utf8")) as { steps: { check: Check; actions?: unknown }[] };
    raw.steps[0]!.actions = [{ type: "wait", ms: 0 }];
    writeFileSync(file, JSON.stringify(raw));
    const upgraded = upgradeSignInSteps(readSaved(file), signedInCheckFor({ signedIn: { text: "Sign out" }, signInPage: "/trap-code" }));
    assert.deepEqual(upgraded.steps.at(-1)!.check, { kind: "signed_in", text: "Sign out", left: "/trap-code" });
    const page = await browser.newPage();
    await page.goto(new URL("/trap-code", site.url).href);
    await page.fill("#email", "t@example.test");
    await page.fill("#password", "pw-trap-123");
    await page.click("button[type=submit]");
    assert.equal((await verify(page, { kind: "password_gone" }, 300)).ok, true, "the old check passes the trap: the bug");
    assert.equal((await verify(page, upgraded.steps.at(-1)!.check, 300)).ok, false, "the upgraded one doesn't");
    await page.close();
  });
});

describe("the fixture's Mailpit-shaped inbox", () => {
  it("lists, searches, opens, empties, and can be made to fail", async () => {
    const site = await startAuthSite();
    try {
      site.sendMail({ to: "a@example.test", subject: "Your code", text: "Your code is 123456" });
      site.sendMail({ to: "b@example.test", subject: "Hello", text: "hi" });
      const api = (p: string, init?: RequestInit) => fetch(new URL(p, site.url), init);
      const list = (await (await api("/api/v1/messages")).json()) as { messages: { ID: string; To: { Address: string }[] }[]; total: number };
      assert.equal(list.total, 2);
      const found = (await (await api("/api/v1/search?query=to:a@example.test")).json()) as { messages: { ID: string }[] };
      assert.equal(found.messages.length, 1);
      const one = (await (await api(`/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string; Subject: string };
      assert.match(one.Text, /123456/);
      await api("/api/v1/messages", { method: "DELETE" });
      assert.equal(((await (await api("/api/v1/messages")).json()) as { total: number }).total, 0);
      site.setMailDown(true);
      assert.equal((await api("/api/v1/messages")).status, 503);
    } finally {
      await site.close();
    }
  });
});

describe("C4 and the checkpoint 1 tasks, with a scripted brain", () => {
  let browser: Browser;
  let dir: string;
  before(async () => {
    browser = await launch(false);
    dir = temp("cm-auth-bench-");
  });
  after(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Checkpoint 2's tasks (codes, links, sign-ups) have their own brain and tests: codes.test.ts.
  for (const task of AUTH_TASKS.filter((t) => !t.first && !t.totp && ["sign-in", "expired", "rotate", "lockout", "trap"].includes(t.kind))) {
    it(`${task.id}: ${task.mode}`, async () => {
      const prompts: string[] = [];
      const row = await runAuthTask(task, { browser, brainFor: scriptedBrain(prompts), dir, prompts });
      assert.equal(row.leaks.length, 0, JSON.stringify(row.leaks));
      assert.equal(row.right, true, JSON.stringify(row, null, 1));
      assert.equal(row.falsePass, false);
      if (task.kind === "sign-in") {
        assert.equal(row.replayAsks, 0, "the replay asked the AI nothing");
        assert.ok(prompts.some((p) => p.includes("{admin.username}")), "the AI was told the handle");
      }
      if (task.kind === "lockout") {
        assert.ok(row.refused <= 1, `${row.refused} refused submits`);
        assert.equal(row.code, "AUTH_CREDENTIAL_INVALID");
      }
      if (task.kind === "rotate") assert.equal(row.signIns, 1, "ten tests, one sign-in");
      if (task.kind === "expired") assert.equal(row.relogins, 1);
      if (task.kind === "trap") assert.equal(row.sessionSaved, false, "no half-signed-in session is saved");
    });
  }

  it("the echo page reaches the brain as {admin.username}, never the address", async () => {
    const prompts: string[] = [];
    const row = await runAuthTask(AUTH_TASKS[0]!, { browser, brainFor: scriptedBrain(prompts), dir, prompts }, 9);
    assert.equal(row.right, true);
    const site = await startAuthSite({ users: [{ username: "qa.leak" + "9.u7c1e9@example.test", password: "pw-LEAK-9" + "-7c1e9a5Fq" }] });
    try {
      const { runTest } = await import("../packages/scanner/src/tester/run.ts");
      const account = parseAccounts({ accounts: { admin: { username: "qa.leak9.u7c1e9@example.test", password: { keychain: true }, signInPage: "/login", signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
      const out = temp();
      const store = fileStore(join(out, "s.json"));
      store.set(secretKey(new URL(site.url).host, "admin", "password"), "pw-LEAK-9-7c1e9a5Fq");
      const resolver = accountResolver(account, { host: new URL(site.url).host, store, env: {} });
      // Signed in by hand in the browser, then a test on /echo, which prints the address back.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(new URL("/login", site.url).href);
      await page.fill("#email", "qa.leak9.u7c1e9@example.test");
      await page.fill("#password", "pw-LEAK-9" + "-7c1e9a5Fq");
      await page.click("button[type=submit]");
      const state = join(out, "state.json");
      writeFileSync(state, JSON.stringify(await context.storageState()));
      await context.close();
      const seen: string[] = [];
      const brain: TesterBrain = {
        async plan(_goal, _url, _given, start) {
          seen.push(JSON.stringify(start));
          return [{ title: "Read the profile", intent: "Look at the profile", check: { kind: "text_visible", text: "Profile" } } satisfies PlannedStep];
        },
        async decide(input) {
          seen.push(JSON.stringify(input));
          return { type: "done" };
        },
      };
      await runTest({ goal: "Read the profile", url: new URL("/echo", site.url).href, dir: join(out, "run"), browser, brain, storageState: state, secrets: resolver });
      const text = seen.join("\n");
      assert.match(text, /\{admin\.username\}/, "the page's address reached it as its handle");
      assert.equal(leakHits({ user: "qa.leak9.u7c1e9@example.test", pw: "pw-LEAK-9-7c1e9a5Fq" }, [{ where: "prompts", text }]).length, 0);
    } finally {
      await site.close();
    }
  });

  it("a test that signs out never writes its session back, so the shared one stays signed in", async () => {
    const site = await startAuthSite({ users: [{ username: "so@example.test", password: "pw-signout-1" }] });
    try {
      const { runTest } = await import("../packages/scanner/src/tester/run.ts");
      const out = temp();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(new URL("/login", site.url).href);
      await page.fill("#email", "so@example.test");
      await page.fill("#password", "pw-signout-1");
      await page.click("button[type=submit]");
      const state = join(out, "session.json");
      writeFileSync(state, JSON.stringify(await context.storageState()));
      await context.close();
      const before = readFileSync(state, "utf8");
      const brain: TesterBrain = {
        async plan() {
          return [{ title: "Sign out", intent: "Click Sign out", check: { kind: "url_contains", text: "/" } } satisfies PlannedStep];
        },
        async decide(input) {
          const link = find(input.snapshot, /link/, /^sign out$/i);
          return input.history.length || !link ? { type: "done" } : { type: "click", ref: link };
        },
      };
      const { result } = await runTest({ goal: "Sign out", url: new URL("/app", site.url).href, dir: join(out, "run"), browser, brain, storageState: state, writeBackTo: state });
      assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
      assert.equal(readFileSync(state, "utf8"), before, "the sign-out test's session wasn't written back");
      const check = await browser.newContext({ storageState: state });
      const p2 = await check.newPage();
      await p2.goto(new URL("/app", site.url).href);
      assert.match(await p2.locator("body").innerText(), /Signed in as/);
      await check.close();
    } finally {
      await site.close();
    }
  });

  it("totals add up", () => {
    const t = authTotals([{ id: "a", rep: 1, expect: "pass", verdict: "pass", right: true, falsePass: false, asks: 2, replayAsks: 0, signIns: 2, refused: 0, reused: 0, sessionSaved: true, modesOk: true, leaks: [], seconds: 1, runDir: "" }]);
    assert.equal(t.right, 1);
    assert.equal(t.leaks, 0);
    assert.ok(existsSync(dir));
    mkdirSync(join(dir, "x"), { recursive: true });
  });
});
