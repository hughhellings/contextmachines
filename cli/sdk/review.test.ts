// Review fixes: each test failed before its fix (see STATUS.md, Review). Real browser on 127.0.0.1,
// scripted brains, no AI and no network.
//   node --test cli/sdk/*.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { RULES } from "../../packages/scanner/src/tester/act.ts";
import { launch } from "../../packages/scanner/src/tester/record.ts";
import { startFixtureSite, type FixtureSite } from "../bench/site.ts";
import { checkFromAnswer } from "./brain.ts";
import { AgentStepError, CACHE_VERSION, createAgent, isCachedAction, readCache, type Action, type DecideInput } from "./index.ts";

let browser: Browser;
let site: FixtureSite;
const contexts: BrowserContext[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-sdk-review-"));
  dirs.push(d);
  return d;
};
async function newPage(): Promise<Page> {
  const c = await browser.newContext();
  contexts.push(c);
  return c.newPage();
}
const at = (path: string) => new URL(path, site.url).href;

before(async () => {
  browser = await launch();
  site = await startFixtureSite();
});
after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("review fixes", () => {
  it("R1: a value written literally in a check reaches neither the AI nor the report", async () => {
    const secret = "Zq9Kestrelmoor";
    const seen: string[] = [];
    const page = await newPage();
    const agent = await createAgent(page, {
      start: site.url,
      vars: { place: secret },
      checkWaitMs: 200,
      brain: { async decide(i: DecideInput): Promise<Action> { seen.push(JSON.stringify(i)); return { type: "done" }; } },
    });
    await page.goto(at("/suggest"));
    const step = await agent.act("look at the page", { check: { kind: "text_visible", text: `${secret} Harbour` }, soft: true });
    assert.ok(seen.length > 0, "the AI was asked");
    assert.ok(!seen.join("\n").includes(secret), "the AI never saw the value");
    assert.ok(seen.some((s) => s.includes("{place} Harbour")), "the AI saw the handle in its place");
    assert.ok(!JSON.stringify(step).includes(secret), "the step holds no value");
    const report = await agent.finish();
    assert.ok(!JSON.stringify(report).includes(secret), "the report holds no value");
  });

  it("R2: a cache entry with an action that isn't one starts cold, never crashes the engine", async () => {
    assert.equal(isCachedAction({ type: "click" }), false);
    assert.equal(isCachedAction({ type: "fill", target: { role: "textbox", name: "x" } }), false, "fill needs a value");
    assert.equal(isCachedAction({ type: "click", target: { role: "button", name: "Go", nth: 0 } }), true);
    const cache = join(tmp(), "bad.json");
    const good = { kind: "act", words: "ok", actions: [{ type: "press", key: "Escape" }] };
    writeFileSync(cache, JSON.stringify({ version: CACHE_VERSION, rules: RULES, site: "x", steps: [{ kind: "act", words: "go", actions: [{ type: "click" }] }, good] }));
    const read = readCache(cache);
    assert.equal(read.size, 1, "the bad entry is dropped, the good one kept");
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, cache, checkWaitMs: 200 });
    await page.goto(at("/palette"));
    const thrown = await agent.act("go", { check: { kind: "url_contains", text: "zzz" } }).then(() => undefined, (e: unknown) => e);
    assert.ok(thrown instanceof AgentStepError, `a typed step error, not an engine TypeError: ${String(thrown)}`);
    assert.equal(thrown.verdict, "not_sure");
    assert.match(thrown.message, /isn't in the cache/);
    assert.equal((await agent.finish()).verdict, "not_sure");
  });

  it("R3: an error nobody expected (the page closed mid-step) is a kept NOT SURE step; finish() never says pass or writes the cache", async () => {
    const cache = join(tmp(), "crash.json");
    const page = await newPage();
    const agent = await createAgent(page, {
      start: site.url,
      cache,
      checkWaitMs: 200,
      brain: { async decide(): Promise<Action> { await page.close(); return { type: "done" }; } },
    });
    await page.goto(at("/palette"));
    const thrown = await agent.act("open the chart", { check: { kind: "text_visible", text: "AAPL chart" } }).then(() => undefined, (e: unknown) => e);
    assert.ok(thrown instanceof AgentStepError, `typed: ${String(thrown)}`);
    assert.equal(thrown.verdict, "not_sure");
    assert.match(thrown.message, /^NOT SURE: step 1 \(open the chart\): the step stopped with an error/);
    const report = await agent.finish();
    assert.equal(report.verdict, "not_sure");
    assert.equal(report.steps.length, 1);
    assert.equal(existsSync(cache), false, "no cache from a crashed test");
  });

  it("R3b: a misused check is still a plain TypeError (the developer's mistake, not a verdict)", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url });
    await assert.rejects(agent.assert({ kind: "nonsense" } as never), TypeError);
    await assert.rejects(agent.act("x", { check: { kind: "nonsense" } as never }), TypeError);
  });

  it("R4: a test with no steps tested nothing, so it is NOT SURE, never a pass", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url });
    const report = await agent.finish();
    assert.equal(report.verdict, "not_sure");
    assert.equal(report.replay, false);
  });

  it("R5: a skipped step's error names the step that didn't pass, and why", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, checkWaitMs: 100 });
    await page.goto(at("/palette"));
    await agent.assert({ kind: "text_visible", text: "no such words here" }, { soft: true });
    const thrown = await agent.assert({ kind: "text_visible", text: "Search" }).then(() => undefined, (e: unknown) => e);
    assert.ok(thrown instanceof AgentStepError);
    assert.equal(thrown.verdict, "skipped");
    assert.match(thrown.message, /^SKIPPED: step 2 .*step 1 \(Check that .*\) was FAIL: the check didn't hold/);
  });

  it("R6: an act with no check where nothing was done is NOT SURE, and isn't cached", async () => {
    const cache = join(tmp(), "nothing.json");
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, cache, brain: { async decide(): Promise<Action> { return { type: "done" }; } } });
    await page.goto(at("/palette"));
    const step = await agent.act("do the thing", { soft: true });
    assert.equal(step.verdict, "not_sure", JSON.stringify(step));
    assert.equal((await agent.finish()).verdict, "not_sure");
    assert.equal(existsSync(cache), false);
  });

  it("R7: a first run of only check asserts isn't called a replay", async () => {
    const page = await newPage();
    const agent = await createAgent(page, { start: site.url, checkWaitMs: 1000 });
    await page.goto(at("/palette"));
    await agent.assert({ kind: "text_visible", text: "Search" });
    const report = await agent.finish();
    assert.equal(report.verdict, "pass");
    assert.equal(report.replay, false);
  });

  it("R8: JSON that isn't an object is no check (no TypeError from the parser)", () => {
    assert.equal(checkFromAnswer("null"), undefined);
    assert.equal(checkFromAnswer("[1]"), undefined);
    assert.equal(checkFromAnswer('"text_visible"'), undefined);
  });
});
