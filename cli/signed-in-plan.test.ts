// A run that starts signed in as an account (the app signed in first): the planner is told, and no step
// opens, fills or submits the sign-in form (packages/scanner/src/tester/signedin.ts). Pure checks, then
// the engine on the local auth fixture (127.0.0.1) with a scripted brain: no AI, no real account.
//   node --test cli/signed-in-plan.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { kindOf, splitSignIns } from "../packages/scanner/src/tester/plan.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import { afterSignIn, onlySignsIn, signedInLine, splitSignIn, withoutSignIn } from "../packages/scanner/src/tester/signedin.ts";
import type { PlannedStep, StartPage, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { accountResolver, fileStore, parseAccounts, secretKey } from "./accounts.ts";
import { signedInFirst } from "./app/wire.ts";
import type { PlanStep } from "./app/contracts.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";

/** The plan Sam's real run made from "sign in and go to the patterns page", already signed in. */
const HUGHS_PLAN: PlannedStep[] = [
  { title: "Open the sign-in form", intent: "Find and open the app's sign-in or log-in form from the current page.", check: { kind: "none" } },
  { title: "Sign in and open Patterns", intent: "Fill in the sign-in form with auto test credentials, submit it, then click the Patterns link in the app's navigation to open the patterns page.", check: { kind: "url_contains", text: "/patterns" } },
];

describe("the sign-in part of a step's words", () => {
  it("is taken out, and the rest kept as written", () => {
    assert.equal(withoutSignIn("Sign in and open Patterns"), "Open Patterns");
    assert.equal(withoutSignIn(HUGHS_PLAN[1]!.intent), "Click the Patterns link in the app's navigation to open the patterns page.");
    assert.equal(withoutSignIn("Open Patterns after signing in"), "Open Patterns");
    assert.equal(withoutSignIn("Log in, then open reports"), "Open reports");
    for (const only of ["Open the sign-in form", "Sign in", "Log in as admin", "Type the email and password and press Sign in", "Sign in with {sam.username} and {sam.password}"]) assert.equal(withoutSignIn(only), "", only);
    assert.equal(withoutSignIn("Open reports"), "Open reports");
  });
  it("a goal that only signs in", () => {
    for (const g of ["Sign in", "Log in as admin", "sign in and check you're signed in"]) assert.ok(onlySignsIn(g), g);
    for (const g of ["Sign in and open the Settings page", "sign in and go to the patterns page", "Sign in with a wrong password", "Sign out"]) assert.ok(!onlySignsIn(g), g);
  });
});

describe("afterSignIn: the plan of a run already signed in", () => {
  it("Sam's plan: the sign-in form step is dropped, the mixed step keeps 'Open Patterns' and its real check", () => {
    const out = afterSignIn(HUGHS_PLAN, "sign in and go to the patterns page", "sam");
    assert.equal(out.problem, undefined);
    assert.deepEqual(out.steps, [{ title: "Open Patterns", intent: "Click the Patterns link in the app's navigation to open the patterns page.", check: { kind: "url_contains", text: "/patterns" } }]);
    assert.equal(out.changed.length, 2);
  });
  it("a mixed step whose check only said 'signed in' gets a real one asked for, never 'signed in'", () => {
    const out = afterSignIn([{ title: "Sign in and open Settings", intent: "Sign in, then open Settings", check: { kind: "signed_in" } }], "Sign in and open the Settings page", "sam");
    assert.ok(out.problem && /already signed in as "sam"/.test(out.problem));
    assert.equal(out.steps.length, 1);
    assert.equal(out.steps[0]!.title, "Open Settings");
    assert.equal(out.steps[0]!.check.kind, "judged");
    const measured = afterSignIn([{ title: "Sign in and open Settings", intent: "Sign in, then open Settings", check: { kind: "signed_in" } }], "Sign in and open the Settings page", "sam", { measuredOnly: true });
    assert.equal(measured.steps[0]!.check.kind, "none");
    // With a checked step after it, no check of its own is needed (as the planner's rules allow).
    const onTheWay = afterSignIn([{ title: "Sign in and open Settings", intent: "Sign in, then open Settings", check: { kind: "signed_in" } }, { title: "Check the plan", intent: "Look at the plan", check: { kind: "text_visible", text: "Plan: Free" } }], "Sign in and check the plan", "sam");
    assert.equal(onTheWay.problem, undefined);
    assert.deepEqual(onTheWay.steps.map((s) => s.check.kind), ["none", "text_visible"]);
  });
  it("never turns a later real check into a weaker one", () => {
    const later: PlannedStep[] = [
      { title: "Sign in", intent: "Sign in with the account", check: { kind: "url_contains", text: "/dashboard" } },
      { title: "Open reports", intent: "Click Reports", check: { kind: "url_contains", text: "/reports" } },
      { title: "Check the empty state", intent: "Look at the list", check: { kind: "text_visible", text: "No reports yet" } },
    ];
    const out = afterSignIn(later, "Sign in, open reports and check it's empty", "sam");
    assert.deepEqual(out.steps, later.slice(1));
  });
  it("a goal that only signs in is one step, passed by the measured signed-in check alone", () => {
    const out = afterSignIn([{ title: "Open the sign-in page", intent: "Click Sign in", check: { kind: "url_contains", text: "/login" } }, { title: "Sign in", intent: "Type the email and password", check: { kind: "signed_in" } }], "Sign in", "sam");
    assert.equal(out.steps.length, 1);
    assert.deepEqual(out.steps[0]!.check, { kind: "signed_in" });
    assert.equal((out.steps[0] as { assert?: boolean }).assert, true);
  });
  it("leaves goals about signing out or a sign-in meant to fail as planned", () => {
    for (const goal of ["Sign out and check the home page", "Sign in with a wrong password and check you stay on /login", "Check /app sends you to the login page when signed out"]) {
      const plan: PlannedStep[] = [{ title: "Sign in with a wrong password", intent: "Type {bad.email} and {bad.password}", check: { kind: "url_contains", text: "/login" } }];
      assert.deepEqual(afterSignIn(plan, goal, "sam").steps, plan, goal);
    }
    // A step about signing out, in a goal that signs in, is kept too.
    const out = afterSignIn([{ title: "Sign out", intent: "Click Sign out", check: { kind: "text_visible", text: "Sign in" } }], "Sign in, then sign out", "sam");
    assert.equal(out.steps[0]!.title, "Sign out");
  });
  it("review: a later step whose words never sign in keeps its own measured signed-in check", () => {
    const plan: PlannedStep[] = [
      { title: "Open Reports", intent: "Click Reports", check: { kind: "url_contains", text: "/reports" } },
      { title: "Reload and check you're still signed in", intent: "Reload the page", check: { kind: "signed_in" } },
    ];
    const out = afterSignIn(plan, "Sign in, open reports, reload and check you stay signed in", "sam");
    assert.deepEqual(out.steps, plan);
    assert.equal(out.problem, undefined);
  });
  it("review: a step titled only 'Sign in' whose words go on, checked there, keeps that real check", () => {
    const out = afterSignIn([{ title: "Sign in", intent: "Sign in with {sam.username} and {sam.password}, then open the Patterns page", check: { kind: "url_contains", text: "/patterns" } }], "Sign in and go to patterns", "sam");
    assert.deepEqual(out.steps, [{ title: "Open the Patterns page", intent: "Open the Patterns page", check: { kind: "url_contains", text: "/patterns" } }]);
    // A title that never said it, over words that only sign in: the title and its real check stay; nothing names a value.
    const titled = afterSignIn([{ title: "Open Patterns", intent: "Fill {sam.username} and {sam.password} and press Enter", check: { kind: "url_contains", text: "/patterns" } }], "Sign in and go to patterns", "sam");
    assert.deepEqual(titled.steps.map((s) => [s.title, s.check]), [["Open Patterns", { kind: "url_contains", text: "/patterns" }]]);
    assert.ok(!/\{sam\./.test(titled.steps[0]!.intent));
    // The same words with only a signed-in check: the sign-in form, dropped.
    const form = afterSignIn([{ title: "Fill the form", intent: "Type {sam.username} and {sam.password} and press Enter", check: { kind: "signed_in" } }, { title: "Open Reports", intent: "Click Reports", check: { kind: "url_contains", text: "/reports" } }], "Sign in and open reports", "sam");
    assert.deepEqual(form.steps.map((s) => s.title), ["Open Reports"]);
  });
  it("review: words that only say what signing in shows ('e.g. …') are not a step of their own", () => {
    const step: PlannedStep = { title: "Sign in", intent: "Type {admin.username} and {admin.password} and submit. E.g. the app then shows a Settings link.", check: { kind: "element_visible", role: "link", name: "Settings" } };
    assert.equal(withoutSignIn("Sign in, e.g. with the email field"), "");
    assert.equal(splitSignIn(step), undefined);
    const out = afterSignIn([step, { title: "Open Settings", intent: "Click Settings", check: { kind: "url_contains", text: "settings" } }], "Sign in and open the Settings page", "admin");
    assert.deepEqual(out.steps.map((s) => [s.title, s.check.kind]), [["Sign in", "element_visible"], ["Open Settings", "url_contains"]]);
    assert.ok(!/\{admin\./.test(out.steps[0]!.intent));
  });
  it("review: a goal that names somewhere to get to is not 'only sign in'", () => {
    for (const g of ["Sign in to see Patterns", "Log in to the billing page", "Sign in to open settings"]) assert.ok(!onlySignsIn(g), g);
    for (const g of ["Sign in with the test account", "Sign in to the app.", "Log in as admin and check you're logged in"]) assert.ok(onlySignsIn(g), g);
    assert.equal(withoutSignIn("Sign in to open settings"), "Open settings");
    // Every step only signed in, for a goal that asks for more: never one "signed in" step, and the planner is asked again.
    const out = afterSignIn([{ title: "Sign in", intent: "Sign in", check: { kind: "signed_in" } }], "Log in to the billing page", "sam");
    assert.notEqual(out.steps[0]!.check.kind, "signed_in");
    assert.ok(out.problem);
  });
  it("the planner is told it is signed in and must not plan the sign-in form", () => {
    const line = signedInLine("sam");
    assert.match(line, /ALREADY SIGNED IN as the test account "sam"/);
    assert.match(line, /no step to open, fill or submit the sign-in form/);
  });
});

describe("the cards path (Generate, then Run)", () => {
  it("Generate splits a step that signs in and does more into a Login card and an Act card", () => {
    const out = splitSignIns([{ title: "Sign in and open Settings", intent: "Fill {sam.username} and {sam.password}, submit, then click Account settings", check: { kind: "url_contains", text: "/app/settings" } }]);
    assert.equal(out.problem, undefined);
    assert.deepEqual(out.steps.map((s) => [s.title, s.check.kind, kindOf(s)]), [["Sign in", "signed_in", "login"], ["Open Settings", "url_contains", "act"]]);
    const asked = splitSignIns([{ title: "Sign in and open Settings", intent: "Sign in, then open Settings", check: { kind: "signed_in" } }]);
    assert.ok(asked.problem);
    assert.equal(asked.steps[1]!.check.kind, "judged");
    assert.equal(splitSignIns([{ title: "Sign in with a wrong password", intent: "Type {bad.password}", check: { kind: "text_visible", text: "Wrong" } }], false, "a wrong password is refused").steps.length, 1);
  });
  it("Run: a saved mixed Login card signs in by the app, and the rest runs as its own card with its real check", () => {
    const card: PlanStep = { id: "s1", title: "Sign in and open Settings", intent: "Sign in, then click Account settings", check: { kind: "url_contains", text: "/app/settings" }, kind: "login", checkMode: "measured", enabled: true, accountLabel: "sam" };
    const out = signedInFirst([card], "sam");
    assert.deepEqual(out.cards.map((c) => [c.title, c.kind, c.check.kind]), [["Sign in", "login", "signed_in"], ["Open Settings", "act", "url_contains"]]);
    assert.ok(out.signInWords);
    assert.equal(splitSignIn({ title: "Sign in", intent: "Sign in", check: { kind: "signed_in" } }), undefined);
    // review: a card titled only "Sign in" whose words go on to Settings, checked there, keeps that check on the rest.
    const titled: PlanStep = { ...card, title: "Sign in", intent: "Sign in, then open Settings" };
    assert.deepEqual(signedInFirst([titled], "sam").cards.map((c) => [c.title, c.kind, c.check]), [["Sign in", "login", { kind: "signed_in" }], ["Open Settings", "act", { kind: "url_contains", text: "/app/settings" }]]);
  });
});

describe("the engine, already signed in, on the local auth fixture", () => {
  let site: AuthSite;
  let browser: Browser;
  let state: string;
  let out: string;
  let resolver: ReturnType<typeof accountResolver>;
  before(async () => {
    site = await startAuthSite({ users: [{ username: "si@example.test", password: "pw-signedin-1" }] });
    browser = await launch(false);
    out = mkdtempSync(join(tmpdir(), "cm-signedin-"));
    const account = parseAccounts({ accounts: { sam: { username: "si@example.test", password: { keychain: true }, signInPage: "/login", signedIn: { text: "Sign out" } } } }).accounts.get("sam")!;
    const store = fileStore(join(out, "s.json"));
    store.set(secretKey(new URL(site.url).host, "sam", "password"), "pw-signedin-1");
    resolver = accountResolver(account, { host: new URL(site.url).host, store, env: {} });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(new URL("/login", site.url).href);
    await page.fill("#email", "si@example.test");
    await page.fill("#password", "pw-signedin-1");
    await page.click("button[type=submit]");
    state = join(out, "state.json");
    writeFileSync(state, JSON.stringify(await context.storageState()));
    await context.close();
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** A planner that plans as Sam's did (the sign-in form first), and records what it was shown. */
  const brainFor = (starts: (StartPage | undefined)[], decided: string[]): TesterBrain => ({
    async plan(goal, _url, _given, start) {
      starts.push(start);
      if (/^sign in$/i.test(goal)) return [{ title: "Open the sign-in form", intent: "Open the sign-in form", check: { kind: "none" } }, { title: "Sign in", intent: "Type the email and password and press Sign in", check: { kind: "signed_in" } }];
      return [
        { title: "Open the sign-in form", intent: "Find and open the app's sign-in or log-in form from the current page.", check: { kind: "none" } },
        { title: "Sign in and open Settings", intent: "Fill in the sign-in form with auto test credentials, submit it, then click the Account settings link to open the settings page.", check: { kind: "url_contains", text: "/app/settings" } },
      ];
    },
    async decide(input) {
      decided.push(input.step.title);
      const link = [...input.snapshot.matchAll(/\[(e\d+)\] link "([^"]*)"/g)].find((m) => /account settings/i.test(m[2]!))?.[1];
      return input.history.length || !link ? { type: "done" } : { type: "click", ref: link };
    },
  });

  it("'Sign in and open the Settings page': one step opens Settings, PASS on its address", async () => {
    const starts: (StartPage | undefined)[] = [];
    const decided: string[] = [];
    const { result } = await runTest({ goal: "Sign in and open the Settings page", url: new URL("/app", site.url).href, dir: join(out, "settings"), browser, brain: brainFor(starts, decided), storageState: state, secrets: resolver, signedInAs: "sam", maxPerStep: 4 });
    assert.equal(starts[0]?.signedInAs, "sam", "the planner was told");
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
    assert.deepEqual(result.steps.map((s) => [s.title, s.check.kind]), [["Open Settings", "url_contains"]]);
    assert.ok(decided.every((t) => t === "Open Settings"));
    assert.equal(site.signIns("/login"), 1, "no sign-in beyond the one that made the session");
  });
  it("'Sign in' alone: PASS on the measured signed-in check, no AI asked to act", async () => {
    const decided: string[] = [];
    const { result } = await runTest({ goal: "Sign in", url: new URL("/app", site.url).href, dir: join(out, "only"), browser, brain: brainFor([], decided), storageState: state, secrets: resolver, signedInAs: "sam" });
    assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
    assert.deepEqual(result.steps.map((s) => [s.title, s.check.kind]), [["Signed in", "signed_in"]]);
    assert.equal(decided.length, 0);
  });
  it("without the account's values (a session alone, as before), the plan is as planned", async () => {
    const starts: (StartPage | undefined)[] = [];
    const { result } = await runTest({ goal: "Sign in and open the Settings page", url: new URL("/app", site.url).href, dir: join(out, "plain"), browser, brain: brainFor(starts, []), storageState: state, maxPerStep: 3 });
    assert.equal(starts[0]?.signedInAs, undefined);
    assert.equal(result.steps.length, 2);
  });
});
