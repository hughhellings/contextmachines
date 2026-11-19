// The SDK's brain over the CLI's AI plumbing, with a fake AI that answers JSON as a real one would:
// the same prompts and parsing as `contextmachines test`, no AI and no network.
//   node --test cli/sdk/*.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../../packages/scanner/src/tester/record.ts";
import type { Ai } from "../ai.ts";
import { startFixtureSite, type FixtureSite } from "../bench/site.ts";
import { agentBrainFrom, ASSERT_SYSTEM, checkFromAnswer } from "./brain.ts";
import { createAgent } from "./index.ts";

/** A fake AI: answers each ask from `reply`, and keeps every question it was asked. */
function fakeAi(reply: (system: string, question: string) => object | string): Ai & { asked: string[] } {
  const asked: string[] = [];
  return {
    via: "a fake AI",
    model: "fake",
    asked,
    async ask(system, question) {
      asked.push(question);
      const r = reply(system, question);
      return { text: typeof r === "string" ? r : JSON.stringify(r) };
    },
  };
}
const refIn = (q: string, role: string, name: string) => new RegExp(`\\[(e\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(q)?.[1] ?? "e9999";
const blank = { ref: "", value: "", key: "", direction: "", url: "", ms: 0, why: "" };

let browser: Browser;
let site: FixtureSite;
before(async () => {
  browser = await launch();
  site = await startFixtureSite();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

describe("checkFromAnswer", () => {
  it("keeps a check the browser can measure, and nothing else", () => {
    assert.deepEqual(checkFromAnswer('{"kind":"text_visible","text":"AAPL chart","role":"","name":""}'), { kind: "text_visible", text: "AAPL chart" });
    assert.deepEqual(checkFromAnswer('```json\n{"kind":"element_visible","text":"","role":"heading","name":"AAPL chart"}\n```'), { kind: "element_visible", role: "heading", name: "AAPL chart" });
    assert.equal(checkFromAnswer('{"kind":"none","text":"","role":"","name":""}'), undefined, "none measures nothing");
    assert.equal(checkFromAnswer('{"kind":"text_visible","text":"  ","role":"","name":""}'), undefined);
    assert.equal(checkFromAnswer('{"kind":"element_visible","text":"","role":"button","name":""}'), undefined, "an element needs its name");
    assert.equal(checkFromAnswer('{"kind":"passed"}'), undefined, "never a verdict");
    assert.equal(checkFromAnswer("not json"), undefined);
  });
});

describe("agentBrainFrom", () => {
  it("drives a mixed test through the CLI's actor prompt and the assert prompt, with the page as untrusted data", async () => {
    let turn = 0;
    const ai = fakeAi((system, q) => {
      if (system === ASSERT_SYSTEM) return { kind: "element_visible", text: "", role: "heading", name: "AAPL chart" };
      turn++;
      if (turn === 1) return { ...blank, action: "fill", ref: refIn(q, "searchbox", "Symbol, ISIN, or CUSIP"), value: "AAPL" };
      if (turn === 2) return { ...blank, action: "click", ref: refIn(q, "item", "AAPL Apple Inc") };
      return { ...blank, action: "done" };
    });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const agent = await createAgent(page, { start: site.url, brain: agentBrainFrom(ai), checkWaitMs: 1500 });
      await page.goto(new URL("/palette", site.url).href);
      await page.getByRole("button", { name: "Search (⌘K)" }).click();
      await agent.act("Type AAPL and open the Apple row", { check: { kind: "url_contains", text: "symbol=AAPL" } });
      const said = await agent.assert("the heading says AAPL chart");
      const report = await agent.finish();
      assert.equal(report.verdict, "pass", JSON.stringify(report.steps, null, 1));
      assert.deepEqual(said.check, { kind: "element_visible", role: "heading", name: "AAPL chart" });
      assert.ok(ai.asked.every((q) => /<page_snapshot untrusted="true">/.test(q)), "the page goes to the AI wrapped as untrusted");
      assert.ok(ai.asked.some((q) => q.startsWith("Assertion: the heading says AAPL chart")));
    } finally {
      await context.close();
    }
  });

  it("an answer that isn't a check is NOT SURE, never a pass", async () => {
    const ai = fakeAi(() => ({ kind: "none", text: "", role: "", name: "" }));
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const agent = await createAgent(page, { start: site.url, brain: agentBrainFrom(ai), checkWaitMs: 300 });
      await page.goto(new URL("/palette", site.url).href);
      const step = await agent.assert("everything looks right", { soft: true });
      assert.equal(step.verdict, "not_sure", JSON.stringify(step));
    } finally {
      await context.close();
    }
  });
});
