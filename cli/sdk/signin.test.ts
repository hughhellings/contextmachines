// The SDK under the engine's sign-in rule: a password the site refused is BLOCKED and never typed
// again, and the password reaches neither the AI nor the report. Local auth fixture, scripted brain.
//   node --test cli/sdk/*.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../../packages/scanner/src/tester/record.ts";
import { newSignInGuard } from "../../packages/scanner/src/tester/run.ts";
import { startAuthSite, type AuthSite } from "../bench/auth-site.ts";
import { createAgent, type Action, type AgentBrain, type DecideInput } from "./index.ts";

const refIn = (s: string, role: string, name: string) => new RegExp(`\\[(e\\d+)\\] ${role} "${name}"`).exec(s)?.[1] ?? "e9999";
type Move = (i: DecideInput) => Action;
const signInMoves: Move[] = [
  (i) => ({ type: "fill", ref: refIn(i.snapshot, "textbox", "Email"), value: "{email}" }),
  (i) => ({ type: "fill", ref: refIn(i.snapshot, "textbox", "Password"), value: "{password}" }),
  (i) => ({ type: "click", ref: refIn(i.snapshot, "button", "Sign in") }),
  () => ({ type: "done" }),
];
function brainOf(moves: Move[]): AgentBrain & { seen: string[] } {
  const left = [...moves];
  const b = { seen: [] as string[], async decide(i: DecideInput): Promise<Action> {
    b.seen.push(JSON.stringify(i));
    return (left.shift() ?? (() => ({ type: "done" }) as Action))(i);
  } };
  return b;
}

let browser: Browser;
let site: AuthSite;
before(async () => {
  browser = await launch();
  site = await startAuthSite();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

describe("sign-in rule", () => {
  it("a refused password ends the step BLOCKED (AUTH_CREDENTIAL_INVALID), and is never typed again", async () => {
    const wrong = "pw-wrong-Kestrel-77";
    const guard = newSignInGuard();
    const run = async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const brain = brainOf(signInMoves);
        const agent = await createAgent(page, { start: site.url, brain, vars: { email: "admin@example.test", password: wrong }, signInGuard: guard, checkWaitMs: 500 });
        await page.goto(new URL("/login", site.url).href);
        const step = await agent.act("Sign in", { check: { kind: "url_contains", text: "/app" }, soft: true });
        return { step, brain, report: await agent.finish() };
      } finally {
        await context.close();
      }
    };
    const from = site.hits().length;
    const first = await run();
    assert.equal(first.step.verdict, "blocked", JSON.stringify(first.step));
    assert.match(first.step.reason ?? "", /^AUTH_CREDENTIAL_INVALID: the site said "Wrong email/);
    assert.equal(first.report.verdict, "blocked");
    assert.ok(!first.brain.seen.join("\n").includes(wrong), "the AI never saw the password");
    assert.ok(!JSON.stringify(first.report).includes(wrong), "the report holds no password");
    // The same account in a second test (a suite, one guard): the password isn't typed again.
    const second = await run();
    assert.equal(second.step.verdict, "blocked");
    assert.match(second.step.reason ?? "", /^AUTH_CREDENTIAL_INVALID: password's password was already refused/);
    const posts = site.hits().slice(from).filter((h) => h === "POST /login").length;
    assert.equal(posts, 1, `one sign-in was sent in all: ${site.hits().slice(from).join(" ")}`);
  });
});
