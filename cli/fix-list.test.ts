// The fix list, through the real command: a real browser, a small app on this machine, a real git
// folder holding its source, and a scripted AI whose answers are mostly bad on purpose.
//   node --test cli/fix-list.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const cli = fileURLToPath(new URL("./contextmachines.ts", import.meta.url));
const browser = existsSync(chromium.executablePath());

const REPORTS_SOURCE = `export function Reports({ count }) {
  return <main>
    <h1>Your Tidyledger reports</h1>
    <p>Based on {count} closed reports</p>
    <p>Upgrade to Team to read this report</p>
  </main>;
}
`;
const RULES_SOURCE = `export const keepFor = (plan) => {
  const keepDays = plan === "free" ? 30 : 365;
  return keepDays;
};
`;

/** What the app draws: its bug, or none, by what a test sets. */
const state = { closed: "1 closed reports", extra: "" };
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title} | Tidyledger</title></head><body><nav><a href="/">Home</a> <a href="/reports">Reports</a> <a href="/inbox">Inbox</a></nav><main>${body}</main></body></html>`;
const app = () => createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  const path = new URL(req.url!, "http://x").pathname;
  if (path === "/reports") res.end(page("Reports", `<h1>Your Tidyledger reports</h1><p>Based on ${state.closed}</p><p>Upgrade to Team to read this report</p><a href="/">Back home</a>`));
  else if (path === "/inbox") res.end(page("Inbox", `<h1>Tidyledger inbox</h1><p>Nothing has arrived for you yet</p>${state.extra}`));
  else if (path === "/") res.end(page("Home", `<h1>Tidyledger keeps your books</h1><p>Everything in one quiet place.</p>`));
  else {
    res.statusCode = 404;
    res.end(page("Not found", "<h1>Not found</h1>"));
  }
});

type Items = (screens: Record<string, string>) => unknown[];
/** The screen ids a question gave, by address. */
const screenIds = (question: string) => Object.fromEntries([...question.matchAll(/^\[(s\d+)\] (\S+)/gm)].map((m) => [m[2]!, m[1]!]));

/** Answers the review by what a test sets, and the reading with nothing much. */
function scriptedAi(asked: string[], items: { now: Items; fail: boolean }) {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { messages } = JSON.parse(body) as { messages: { content: string }[] };
      const [system, question] = [messages[0]!.content, messages[1]!.content];
      asked.push(`${system}\n${question}`);
      res.setHeader("content-type", "application/json");
      if (!system.includes("You review a web product")) return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ product: "A place to keep books.", mainAction: null, journeys: [] }) } }] }));
      if (items.fail) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { message: "the review broke" } }));
      }
      // What an OpenAI-style server says an answer took: its prompt tokens include the cached ones.
      res.end(JSON.stringify({ model: "fake-model", usage: { prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1500 } }, choices: [{ message: { content: JSON.stringify({ items: items.now(screenIds(question)) }) } }] }));
    });
  });
}

const real = (s: Record<string, string>) => ({ problem: "paywall_first", screen: s["/reports"]!, title: "The report asks for an upgrade before showing any result", fix: "Show the first report in full, then ask for the upgrade", quotes: [{ screen: s["/reports"]!, words: "Upgrade to Team to read this report" }], code: [] });
const invented = (s: Record<string, string>) => ({ ...real(s), title: "A checkout appears first", quotes: [{ screen: s["/reports"]!, words: "Pay now to continue with this" }] });
const absentLine = (s: Record<string, string>) => ({ ...real(s), problem: "surprise_rule", title: "A hidden limit stops uploads", quotes: [], code: [{ file: "src/rules.ts", quote: "const uploadLimit = plan === 'free' ? 3 : 100;" }] });
const inventedFile = (s: Record<string, string>) => ({ ...real(s), problem: "surprise_rule", title: "Another hidden limit on files", quotes: [], code: [{ file: "src/nowhere.ts", quote: "const keepDays = plan === free;" }] });
const taste = (s: Record<string, string>) => ({ ...real(s), title: "The report page looks dated" });
const noProof = (s: Record<string, string>) => ({ ...real(s), title: "Something here is wrong", quotes: [], code: [] });
const madeUpNumber = (s: Record<string, string>) => ({ ...real(s), title: "It needs 40 reports before anything shows" });
const realRule = (s: Record<string, string>) => ({ ...real(s), problem: "surprise_rule", title: "Free plans keep only the last 30 days", fix: "Say so before anything is uploaded", quotes: [], code: [{ file: "src/rules.ts", quote: `const keepDays = plan === "free" ? 30 : 365;` }] });

describe("the fix list, end to end", { skip: browser ? false : "no browser installed" }, () => {
  let site: Server;
  let ai: Server;
  let dir: string;
  let url: string;
  const asked: string[] = [];
  const items: { now: Items; fail: boolean } = { now: () => [], fail: false };

  const run = (args: string[], cwd = dir) =>
    new Promise<{ code: number | null; text: string }>((done) => {
      const { CI: _ci, ANTHROPIC_API_KEY: _key, ...env } = process.env;
      const base = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;
      const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...env, OPENAI_BASE_URL: base, OPENAI_API_KEY: "local", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", (code) => done({ code, text }));
    });
  const learn = async (out: string, ...args: string[]) => {
    const ran = await run(["learn", url, "--out", join(dir, out), "--minutes", "1", "--pages", "8", ...(args.includes("none") ? [] : ["--ai", "openai-compatible", "--model", "scripted"]), ...args]);
    const read = (file: string) => readFileSync(join(dir, out, file), "utf8");
    return { ...ran, map: JSON.parse(read("map.json")) as Record<string, any>, fix: read("FIX.md"), product: read("PRODUCT.md") };
  };

  before(async () => {
    site = app();
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    ai = scriptedAi(asked, items);
    await new Promise<void>((done) => ai.listen(0, "127.0.0.1", done));
    dir = mkdtempSync(join(tmpdir(), "cm-fix-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/Reports.tsx"), REPORTS_SOURCE);
    writeFileSync(join(dir, "src/rules.ts"), RULES_SOURCE);
    writeFileSync(join(dir, "src/Inbox.tsx"), "export const Inbox = () => <main><h1>Tidyledger inbox</h1><p>Nothing has arrived for you yet</p></main>;\n");
    writeFileSync(join(dir, "src/Home.tsx"), "export const Home = () => <h1>Tidyledger keeps your books</h1>;\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "src"], { cwd: dir });
  });
  after(() => {
    site.close();
    ai.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a developer a short, checked list, with where to change each, and drops every bad answer", { timeout: 120_000 }, async () => {
    asked.length = 0;
    items.now = (s) => [invented(s), absentLine(s), inventedFile(s), taste(s), noProof(s), madeUpNumber(s), real(s)];
    const { code, text, map, fix, product } = await learn("first");
    assert.equal(code, 0, text);

    // What came through.
    const fixes = map.fixes as { status: string; from: string; kind: string; title: string; where?: { file: string; line?: number }; evidence: string[] }[];
    const proven = fixes.filter((f) => f.status === "proven");
    const predicted = fixes.filter((f) => f.status === "predicted");
    assert.deepEqual(predicted.map((f) => f.title), ["The report asks for an upgrade before showing any result"]);
    assert.equal(predicted[0]!.from, "review");
    assert.deepEqual(predicted[0]!.where, { file: "src/Reports.tsx", line: 5, code: "<p>Upgrade to Team to read this report</p>" });
    const plural = proven.find((f) => f.kind === "wording")!;
    assert.match(plural.title, /Plural bug/);
    assert.equal(plural.where?.file, "src/Reports.tsx");
    assert.equal(plural.where?.line, 4, "found through the template, not the drawn number");

    // What didn't, and why, on record.
    assert.deepEqual(map.learner.review.dropped, { "words not on that screen": 1, "code quote not in the file": 1, "code file not in the repository": 1, taste: 1, "no evidence": 1, "a number with no source": 1 });
    assert.equal(map.learner.review.raised, 7);
    assert.equal(map.learner.review.kept, 1);
    const all = JSON.stringify(map.fixes);
    for (const bad of ["A checkout appears first", "hidden limit", "looks dated", "Something here is wrong", "needs 40 reports"]) assert.ok(!all.includes(bad), bad);

    // The terminal: each part's screens with what was found under the screen it was seen on, then the
    // list, no all-clear, the counts, and the hand-off.
    assert.match(text, /^✓ \[public\] \d+ screens?/m);
    assert.match(text, /^ {2}× \/\S+ +\d+\.\ds +\d+ found\n {4}⚑ /m);
    assert.match(text, /^ {4}⚑ Plural bug/m);
    assert.ok(text.indexOf("⚑ Plural bug") < text.indexOf("Fix first"), text);
    assert.doesNotMatch(text, /Issues\s+none/);
    assert.ok(text.indexOf("Fix first") < text.indexOf("Screens"), text);
    assert.doesNotMatch(text, /^ +(Product|Main action|Actions|Wrote) {2}/m, "those are in PRODUCT.md, and --verbose");
    assert.match(text, /\d\. proven +[^]*src\/Reports\.tsx:4[^]*\d\. predicted +[^]*src\/Reports\.tsx:5/);
    // The out folder here is a long temporary path: the sentence names the file, and the path follows whole.
    // Then, with no person at a terminal (a pipe here), no menu: one plain line with the page, as a log reads (the list is just above).
    assert.match(text.replace(/\s+/g, " "), /→ Hand (\S*FIX\.md to your coding agent|FIX\.md to your coding agent \S+\/FIX\.md) The page: \S+\/report\.html $/);
    assert.doesNotMatch(text, /Enter done/);
    assert.match(text, /^ℹ learning \S+ · AI: [^\n]*saves stopped/m);
    // What the AI said it took, as e2e's AI row: the reading's server said nothing of it, the review's did.
    assert.match(text, /^ {8}AI {2}2\.5k tokens · 75% cached · \d+ asks · fake-model · \S+$/m);
    assert.match(text, /^✓ \[ai review\] [^\n]* {2}ai 2\.5k tokens · 75% cached$/m);

    // The files: report.html too, with no --html, its cards the list's own.
    const html = readFileSync(join(dir, "first", "report.html"), "utf8");
    assert.match(html, /<article class="fix" id="fix-1">[^]*Plural bug/);
    assert.ok(product.indexOf("## Fix first") < product.indexOf("## What it is"));
    assert.match(fix, /## Proven[^]*## Predicted/);
    assert.match(fix, /\*\*Do this:\*\* Show the first report in full, then ask for the upgrade/);
    assert.match(fix, /\*\*Evidence:\*\* On \/reports: "Upgrade to Team to read this report"/);
    assert.match(fix, /`src\/Reports\.tsx:4`/);
    assert.match(fix, /AI raised|evidence that held up/);

    // Kept apart by their kind in the map.
    assert.equal(map.findings.length, 0);
    assert.equal(proven.filter((f) => f.from === "finding").length, 0);

    // What left the machine: the drawn words, and no address of a repository file's contents.
    const question = asked.find((q) => q.includes("You review a web product"))!;
    assert.match(question, /Upgrade to Team to read this report/);
    assert.ok(!question.includes("keepDays"), "no code goes unless a code read has run");
  });

  it("takes a real rule's line, and points at it", { timeout: 120_000 }, async () => {
    items.now = (s) => [realRule(s)];
    const { map } = await learn("rule");
    const rule = (map.fixes as { kind: string; where?: unknown; evidence: string[] }[]).find((f) => f.kind === "surprise_rule")!;
    assert.deepEqual(rule.where, { file: "src/rules.ts", line: 2, code: `const keepDays = plan === "free" ? 30 : 365;` });
    assert.match(rule.evidence[0]!, /^src\/rules\.ts:2: /);
  });

  it("fails a build on proven items, never on a prediction alone", { timeout: 120_000 }, async () => {
    items.now = (s) => [real(s)];
    assert.equal((await learn("fail-proven", "--fail-on-issues")).code, 1);
    state.closed = "1 closed report";
    const fine = await learn("fail-predicted", "--fail-on-issues");
    state.closed = "1 closed reports";
    assert.equal(fine.map.fixes.filter((f: { status: string }) => f.status === "proven").length, 0);
    assert.equal(fine.map.fixes.length, 1);
    assert.equal(fine.code, 0, fine.text);
  });

  it("says in a comparison what got fixed and what's new", { timeout: 180_000 }, async () => {
    items.now = () => [];
    await learn("before");
    state.closed = "1 closed report";
    state.extra = "<p>You have 1 open tasks</p>";
    await learn("after");
    state.closed = "1 closed reports";
    state.extra = "";
    const compared = await run(["diff", join(dir, "before/map.json"), join(dir, "after/map.json")]);
    assert.match(compared.text, /✅ Fixed on `\/reports`: Plural bug: "Based on 1 closed reports"/);
    assert.match(compared.text, /🔧 New to fix on `\/inbox`: Plural bug: "You have 1 open tasks"/);
    assert.equal((await run(["diff", join(dir, "before/map.json"), join(dir, "after/map.json"), "--fail-on-new-issues"])).code, 1);
  });

  it("leaves what was measured standing when the review fails, and says so", { timeout: 120_000 }, async () => {
    items.fail = true;
    const { code, text, map, fix } = await learn("failed");
    items.fail = false;
    assert.equal(code, 0, text);
    assert.match(text, /The AI's review of the screens didn't work/);
    assert.equal(map.learner.review.why, "failed");
    assert.ok(map.fixes.length > 0);
    assert.match(fix, /## Not checked[^]*The AI didn't review the screens/);
  });

  it("with no AI, gives what it measured and says that's all it did", { timeout: 120_000 }, async () => {
    asked.length = 0;
    const { text, map, fix } = await learn("no-ai", "--ai", "none");
    assert.equal(asked.length, 0);
    assert.equal(map.learner.review.why, "no-ai");
    assert.ok(map.fixes.every((f: { status: string }) => f.status === "proven") && map.fixes.length > 0);
    assert.match(text, /Fix first/);
    assert.doesNotMatch(text, /reviews the screens/);
    assert.match(fix, /there's no AI to review the screens/);
  });

  it("tells a developer honestly when it found nothing, and why", { timeout: 120_000 }, async () => {
    state.closed = "1 closed report";
    items.now = (s) => [invented(s), taste(s)];
    const { text, map, fix, product } = await learn("clean");
    state.closed = "1 closed reports";
    assert.deepEqual(map.fixes, []);
    assert.doesNotMatch(text, /Fix first/);
    assert.match(text, /Findings {2}none found · 3 screens measured · the AI raised \d+, none held up\n/, "in one line: FIX.md says the rest");
    assert.match(fix.replace(/\s+/g, " "), /raised 2 items, and none had evidence that held up/);
    assert.doesNotMatch(text.replace(/\s+/g, " "), /→ Hand/);
    assert.match(fix, /doesn't mean there's nothing/);
    assert.match(product, /## Fix first\n\nNothing to fix was found/);
  });
});
