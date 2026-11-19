/**
 * The MCP server (mcp.ts, mcp-tools.ts). In process, with the child CLI faked: the handshake, the
 * tool list, every error code, notifications, waiting and get_result, the busy refusal, cancel,
 * run_saved with nothing saved, argument limits, and stdout holding only JSON-RPC across 200 scripted
 * messages. Then a scripted client over real stdio: the server in its own process, running this CLI
 * (bin.mjs) as its child against the bench's local fixture site, with no AI and no network.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { checkGoal, checkUrl, clean, shapeTest, UNTRUSTED } from "./mcp-tools.ts";
import { MCP_PROTOCOLS, serveMcp, stepLine, type ChildLike, type McpSettings } from "./mcp.ts";
import { startFixtureSite, type FixtureSite } from "./bench/site.ts";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stopped = false;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  stop(): void {
    this.stopped = true;
    setImmediate(() => this.emit("close", null, "SIGTERM"));
  }
  /** Prints `json` on stdout and ends with `code`. */
  finish(json: unknown, code = 0): void {
    this.stdout.end(typeof json === "string" ? json : `${JSON.stringify(json, null, 2)}\n`);
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

const PASS_RESULT = {
  ok: true, exit: 0, goal: "Open the About page", url: "http://localhost:9/", verdict: "pass", passed: 1, ms: 900, startedAt: "", actions: 1, friction: [], endUrl: "http://localhost:9/about",
  steps: [{ n: 1, title: "Open About", intent: "Open the About page", check: { kind: "url_contains", text: "/about" }, verdict: "passed", actions: [], ms: 500, at: 0, screenshot: "step-1.jpg" }],
  files: { result: "contextmachines/runs/open-the-about-page/x/result.json", report: "contextmachines/runs/open-the-about-page/x/report.html", video: "contextmachines/runs/open-the-about-page/x/video.webm" },
};

interface Harness {
  send(message: unknown): void;
  raw(text: string): void;
  /** The next message it writes for request `id`. */
  answer(id: string | number): Promise<Record<string, any>>;
  lines: string[];
  children: FakeChild[];
  close(): Promise<void>;
  settings: McpSettings;
}

function harness(o: { waitMs?: number; outDir?: string; settings?: Partial<McpSettings> } = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  const children: FakeChild[] = [];
  const waiters: { id: string | number; done: (m: Record<string, any>) => void }[] = [];
  const outDir = o.outDir ?? mkdtempSync(join(tmpdir(), "cm-mcp-"));
  const settings: McpSettings = { outDir, cwd: outDir, allowHosts: [], measuredOnly: false, ...o.settings };
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      lines.push(line);
      const m = JSON.parse(line);
      const w = waiters.findIndex((x) => x.id === m.id);
      if (w >= 0) waiters.splice(w, 1)[0]!.done(m);
    }
  });
  const served = serveMcp(input, output, settings, {
    version: "9.9.9",
    waitMs: o.waitMs ?? 2000,
    log: () => {},
    spawnCli: (args) => {
      const child = new FakeChild(args);
      children.push(child);
      return child;
    },
  });
  return {
    send: (m) => input.write(`${JSON.stringify(m)}\n`),
    raw: (t) => input.write(t),
    answer: (id) => new Promise((done) => {
      const had = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
      if (had) done(had);
      else waiters.push({ id, done });
    }),
    lines, children, settings,
    close: async () => {
      input.end();
      await served;
    },
  };
}

const call = (id: number | string, name: string, args?: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, ...(args === undefined ? {} : { arguments: args }) } });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("mcp: the protocol", () => {
  it("answers initialize with the client's version when it knows it, else its newest, and its tools capability", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const a = await h.answer(1);
    assert.equal(a.result.protocolVersion, "2025-06-18");
    assert.deepEqual(a.result.capabilities, { tools: { listChanged: false } });
    assert.equal(a.result.serverInfo.name, "contextmachines");
    assert.equal(a.result.serverInfo.version, "9.9.9");
    h.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal((await h.answer(2)).result.protocolVersion, MCP_PROTOCOLS[0]);
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", id: "p", method: "ping" });
    assert.deepEqual((await h.answer("p")).result, {});
    await h.close();
    assert.equal(h.lines.length, 3, "the notification got no answer");
  });

  it("lists five tools, each with an object schema that takes no other keys", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = (await h.answer(1)).result;
    assert.deepEqual(tools.map((t: { name: string }) => t.name), ["suggest_tasks", "run_test", "run_saved", "get_result", "list_tests"]);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.ok(t.description.length > 20);
    }
    const runTest = tools.find((t: { name: string }) => t.name === "run_test");
    assert.deepEqual(runTest.inputSchema.required, ["goal", "url"]);
    assert.equal(runTest.inputSchema.properties.goal.maxLength, 500);
    await h.close();
  });

  it("gives each error its code: bad JSON -32700, a bad request -32600, no such method -32601, bad arguments -32602", async () => {
    const h = harness();
    h.raw("{not json\n");
    h.raw("[1,2]\n");
    h.raw('"a string"\n');
    h.send({ jsonrpc: "1.0", id: 5, method: "ping" });
    h.send({ jsonrpc: "2.0", id: { no: 1 }, method: "ping" });
    h.send({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    h.send(call(7, "no_such_tool", {}));
    h.send(call(8, "run_test", { goal: "Open the About page" }));
    h.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: [1] });
    h.send({ jsonrpc: "2.0", id: 10, method: "ping" });
    await h.answer(10);
    const codes = h.lines.map((l) => JSON.parse(l)).filter((m) => m.error).map((m) => [m.id, m.error.code]);
    assert.deepEqual(codes, [[null, -32700], [null, -32600], [null, -32600], [5, -32600], [null, -32600], [6, -32601], [7, -32602], [8, -32602], [9, -32602]]);
    assert.equal(h.children.length, 0, "nothing ran");
    await h.close();
  });

  it("never answers a notification, a stray reply, or a blank line", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    h.send({ jsonrpc: "2.0", method: "tools/list" });
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
    h.send({ jsonrpc: "2.0", id: 3, result: {} });
    h.raw("\n\r\n");
    h.send({ jsonrpc: "2.0", id: "last", method: "ping" });
    await h.answer("last");
    assert.equal(h.lines.length, 1);
    await h.close();
  });
});

describe("mcp: runs", () => {
  it("run_test runs the CLI signed out, with --json, the server's settings and the goal after --, and gives the result back", async () => {
    const h = harness({ settings: { ai: "claude-code", model: "m1", allowHosts: ["docs.example.com"], measuredOnly: true } });
    h.send(call(1, "run_test", { goal: "--setup log in", url: "https://example.com" }));
    await tick();
    assert.equal(h.children.length, 1);
    const args = h.children[0]!.args;
    assert.deepEqual(args.slice(0, 5), ["test", "--url", "https://example.com", "--signed-out", "--json"]);
    assert.deepEqual(args.slice(-2), ["--", "--setup log in"]);
    for (const want of ["--ai", "claude-code", "--model", "m1", "--allow-host", "docs.example.com", "--measured-only", "--out", h.settings.outDir]) assert.ok(args.includes(want), want);
    for (const never of ["--var", "--headed", "--no-cache", "--setup", "--steps"]) assert.ok(!args.slice(0, -1).includes(never), never);
    h.children[0]!.stderr.write("\x1b[2m  Opening the site…\x1b[0m\n");
    h.children[0]!.finish(PASS_RESULT);
    const a = await h.answer(1);
    const r = a.result;
    assert.equal(r.isError, undefined);
    assert.ok(r.content[0].text.startsWith(UNTRUSTED));
    assert.equal(Object.keys(r.structuredContent)[0], "note", "the line comes first in structuredContent too: a client may show only that");
    assert.equal(r.structuredContent.note, UNTRUSTED);
    assert.equal(r.structuredContent.status, "done");
    assert.equal(r.structuredContent.run, "r1");
    assert.equal(r.structuredContent.verdict, "pass");
    assert.equal(r.structuredContent.exit, 0);
    assert.match(r.structuredContent.meaning, /^PASS/);
    assert.equal(r.structuredContent.endUrl, "http://localhost:9/about");
    assert.deepEqual(r.structuredContent.steps, [{ n: 1, title: "Open About", verdict: "passed" }]);
    assert.equal(r.structuredContent.files.report, join(h.settings.cwd, PASS_RESULT.files.report), "paths are absolute");
    assert.equal(r.structuredContent.files.video, join(h.settings.cwd, PASS_RESULT.files.video));
    assert.ok(!JSON.stringify(r).includes("step-1.jpg"), "no screenshot names, no file contents");
    await h.close();
  });

  it("a run longer than the wait gives a run id; get_result then says where it is, and its result once done", async () => {
    const h = harness({ waitMs: 50 });
    h.send(call(1, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    const first = (await h.answer(1)).result.structuredContent;
    assert.equal(first.status, "running");
    assert.equal(first.run, "r1");
    h.children[0]!.stderr.write("  ✓ 1 Open the site\n  Step 2 of 3: Search…\n");
    await tick();
    h.send(call(2, "get_result", { run: "r1" }));
    const mid = (await h.answer(2)).result.structuredContent;
    assert.equal(mid.status, "running");
    assert.equal(mid.step, "Step 2 of 3: Search");
    h.children[0]!.finish(PASS_RESULT);
    await tick();
    h.send(call(3, "get_result", { run: "r1" }));
    const done = (await h.answer(3)).result.structuredContent;
    assert.equal(done.status, "done");
    assert.equal(done.verdict, "pass");
    h.send(call(4, "get_result", { run: "r9" }));
    const none = (await h.answer(4)).result;
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /There's no run r9/);
    await h.close();
  });

  it("refuses a second run while one runs, suggest_tasks included, and takes one again after", async () => {
    const h = harness({ waitMs: 30 });
    h.send(call(1, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    await h.answer(1);
    for (const [id, tool, args] of [[2, "run_test", { goal: "Open the Pricing page", url: "http://localhost:9/" }], [3, "suggest_tasks", { url: "http://localhost:9/" }], [4, "run_saved", { url: "http://localhost:9/" }]] as const) {
      h.send(call(id, tool, args));
      const a = (await h.answer(id)).result;
      assert.equal(a.isError, true, tool);
      assert.equal(a.content[0].text, "A test is running (run r1): wait for it with get_result.");
    }
    assert.equal(h.children.length, 1);
    h.send(call(5, "list_tests"));
    assert.equal((await h.answer(5)).result.isError, undefined, "list_tests isn't a run");
    h.children[0]!.finish(PASS_RESULT);
    await tick();
    h.send(call(6, "suggest_tasks", { url: "http://localhost:9/" }));
    await tick();
    assert.deepEqual(h.children[1]!.args.slice(0, 5), ["test", "--url", "http://localhost:9/", "--suggest", "--json"]);
    h.children[1]!.finish({ ok: true, exit: 0, url: "http://localhost:9/", tasks: [{ n: 1, goal: "Open the About page", area: "About", why: "x" }], suggested: "contextmachines/runs/suggested-localhost-9.json" });
    const s = (await h.answer(6)).result.structuredContent;
    assert.deepEqual(s.tasks, [{ n: 1, goal: "Open the About page", area: "About" }]);
    assert.equal(s.suggested, join(h.settings.cwd, "contextmachines/runs/suggested-localhost-9.json"));
    await h.close();
  });

  it("a cancel stops that call's child and the call gets no answer", async () => {
    const h = harness({ waitMs: 5000 });
    h.send(call(1, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    await tick();
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "user" } });
    await tick();
    assert.equal(h.children[0]!.stopped, true);
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    await h.answer(2);
    await tick();
    assert.ok(!h.lines.some((l) => JSON.parse(l).id === 1), "a cancelled call is never answered");
    h.send(call(3, "get_result", { run: "r1" }));
    const r = (await h.answer(3)).result;
    assert.equal(r.structuredContent.status, "failed");
    assert.match(r.structuredContent.error, /cancelled/);
    await h.close();
  });

  it("run_saved with nothing saved for the host never starts a run; with one saved it replays them", async () => {
    const out = mkdtempSync(join(tmpdir(), "cm-mcp-"));
    const h = harness({ outDir: out });
    h.send(call(1, "run_saved", { url: "http://localhost:9/" }));
    const a = (await h.answer(1)).result;
    assert.equal(a.isError, true);
    assert.match(a.content[0].text, /no saved tests for localhost-9/);
    assert.equal(h.children.length, 0);
    mkdirSync(join(out, "tests", "localhost-9"), { recursive: true });
    writeFileSync(join(out, "tests", "localhost-9", "open-the-about-page.json"), JSON.stringify({ version: 1, goal: "Open the About page", url: "http://localhost:9/", savedAt: "2026-11-17T00:00:00.000Z", visitor: true, steps: [{ title: "Open About", intent: "Open it", check: { kind: "url_contains", text: "/about" }, actions: [{ type: "click", target: { role: "link", name: "About", nth: 0 } }] }] }));
    writeFileSync(join(out, "tests", "localhost-9", "broken.json"), "{");
    h.send(call(2, "run_saved", { url: "http://localhost:9/" }));
    await tick();
    assert.deepEqual(h.children[0]!.args.slice(0, 5), ["test", "--url", "http://localhost:9/", "--signed-out", "--json"]);
    assert.ok(!h.children[0]!.args.includes("--"));
    h.children[0]!.finish({ ok: true, exit: 0, summary: { tests: 1, passed: 1 }, tests: [{ name: "open-the-about-page", file: "tests/localhost-9/open-the-about-page.json", host: "localhost-9", verdict: "pass", passed: 1, steps: 1, healed: 0, friction: [], report: "runs/x/report.html" }] });
    const s = (await h.answer(2)).result.structuredContent;
    assert.equal(s.verdict, "pass");
    assert.equal(s.tests[0].files.saved, join(out, "tests/localhost-9/open-the-about-page.json"));
    h.send(call(3, "list_tests"));
    const list = (await h.answer(3)).result.structuredContent;
    assert.equal(list.count, 1);
    assert.equal(list.unreadable, 1, "the broken file is left out, and counted");
    assert.deepEqual({ ...list.tests[0], file: undefined }, { name: "open-the-about-page", goal: "Open the About page", host: "localhost-9", url: "http://localhost:9/", visitor: true, savedAt: "2026-11-17T00:00:00.000Z", steps: 1, file: undefined });
    await h.close();
    rmSync(out, { recursive: true, force: true });
  });

  it("a child that couldn't run (no AI) is a failed run with its own words, not a crash", async () => {
    const h = harness();
    h.send(call(1, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    await tick();
    h.children[0]!.finish({ ok: false, exit: 2, error: "A test needs an AI to plan and act: sign in to Claude Code or Codex, or set an API key (see --help)." }, 2);
    const r = (await h.answer(1)).result;
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, "failed");
    assert.match(r.structuredContent.error, /needs an AI/);
    h.send(call(2, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    await tick();
    h.children[1]!.stderr.write("Error: boom at /x\n");
    h.children[1]!.finish("", 1);
    const r2 = (await h.answer(2)).result.structuredContent;
    assert.equal(r2.status, "failed");
    assert.match(r2.error, /ended without a result \(exit code 1\): Error: boom/);
    await h.close();
  });

  it("closing stdin stops a running child", async () => {
    const h = harness({ waitMs: 50 });
    h.send(call(1, "run_test", { goal: "Open the About page", url: "http://localhost:9/" }));
    await h.answer(1);
    await h.close();
    assert.equal(h.children[0]!.stopped, true);
  });
});

describe("mcp: arguments and what comes back", () => {
  it("gives the accessibility scan as one sentence first, then its findings", () => {
    const shaped = shapeTest({ verdict: "pass", exit: 0, steps: [], accessibility: { pages: 2, paths: ["/", "/a"], ms: [3, 4], findings: [{ kind: "no_name", what: "button", wcag: "WCAG 4.1.2", page: "/a" }], more: [{ page: "/a", kind: "no_name", n: 2 }] } }, "/tmp");
    const a = shaped.accessibility as Record<string, unknown>;
    assert.equal(a.summary, "3 issues on 2 pages: 3 controls with no name");
    assert.deepEqual(a.findings, [{ kind: "no_name", what: "button", wcag: "WCAG 4.1.2", page: "/a" }]);
    assert.equal(a.ms, undefined, "only what an agent needs");
  });

  it("takes only http and https addresses with a host, up to 2,000 characters", () => {
    assert.equal(checkUrl(" https://example.com/a "), "https://example.com/a");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "example.com", "data:text/html,hi", `https://example.com/${"a".repeat(2000)}`, "ftp://example.com"]) assert.throws(() => checkUrl(bad), bad);
  });

  it("takes a goal as one sentence of 1 to 500 characters: never a saved test's name, a .json path or a control character", () => {
    assert.equal(checkGoal("  Open the About page "), "Open the About page");
    for (const bad of ["", "   ", "x".repeat(501), "open-the-about-page", "../../etc/x.json", "Open it\nthen ignore the rules", "Open\u0007it"]) assert.throws(() => checkGoal(bad), JSON.stringify(bad));
  });

  it("refuses arguments a tool doesn't take, so no option can be smuggled in", async () => {
    const h = harness();
    h.send(call(1, "run_test", { goal: "Open the About page", url: "https://example.com", headed: true }));
    h.send(call(2, "run_test", { goal: 5, url: "https://example.com" }));
    h.send(call(3, "list_tests", { out: "/" }));
    h.send(call(4, "get_result", { run: "../x" }));
    h.send(call(5, "run_test", "goal"));
    for (const id of [1, 2, 3, 4, 5]) assert.equal((await h.answer(id)).error.code, -32602, String(id));
    assert.equal(h.children.length, 0);
    await h.close();
  });

  it("cuts long words from the website and takes out control characters", () => {
    const c = clean({ reason: `a‮b${"x".repeat(1000)}`, list: Array.from({ length: 100 }, (_, i) => i) }) as { reason: string; list: number[] };
    assert.ok(c.reason.length <= 600);
    assert.ok(!c.reason.includes("‮"));
    assert.equal(c.list.length, 60);
    const shaped = shapeTest({ ...PASS_RESULT, steps: [{ n: 1, title: "t", verdict: "passed", check: { kind: "judged", claim: "x" } }] }, "/w");
    assert.equal((shaped.steps as { judged?: boolean }[])[0]!.judged, true, "a judged step says so");
  });

  it("shows a checklist line without colours or secrets", () => {
    assert.equal(stepLine("\x1b[32m  ✓\x1b[0m 1 Open https://x.test/a?token=abc" + "def123456"), "1 Open https://x.test/a?token=R" + "EDACTED");
    assert.equal(stepLine("   "), undefined);
  });

  it("writes only JSON-RPC lines on stdout across 200 scripted messages, garbage included", async () => {
    const h = harness({ waitMs: 5 });
    const junk = ["{", "null", "[]", "42", '{"jsonrpc":"2.0"}', '{"jsonrpc":"2.0","id":1}', "\u0000\u0001", '{"jsonrpc":"2.0","id":true,"method":"ping"}'];
    let expectAnswers = 0;
    for (let i = 0; i < 200; i++) {
      const k = i % 10;
      if (k < 3) h.raw(`${junk[i % junk.length]}\n`);
      else if (k === 3) h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      else if (k === 4) h.send({ jsonrpc: "2.0", id: 1000 + i, method: "ping" });
      else if (k === 5) h.send({ jsonrpc: "2.0", id: 1000 + i, method: "tools/list" });
      else if (k === 6) h.send(call(1000 + i, "get_result", { run: "r1" }));
      else if (k === 7) h.send(call(1000 + i, "list_tests"));
      else if (k === 8) h.send(call(1000 + i, "run_test", { goal: "Open the About page", url: "nope" }));
      else h.send({ jsonrpc: "2.0", id: 1000 + i, method: "nope/nothing" });
      if (k >= 4) expectAnswers++;
    }
    h.send({ jsonrpc: "2.0", id: "end", method: "ping" });
    await h.answer("end");
    await h.close();
    for (const line of h.lines) {
      const m = JSON.parse(line);
      assert.equal(m.jsonrpc, "2.0");
      assert.ok("result" in m || "error" in m);
    }
    assert.ok(h.lines.filter((l) => JSON.parse(l).id !== null).length >= expectAnswers);
  });
});

// ---------------------------------------------------------------------------------------------
// A scripted client over real stdio: the server in its own process, this CLI as its child.

const CLI = fileURLToPath(new URL("./bin.mjs", import.meta.url));

function startServer(outDir: string, extra: string[] = []) {
  // The command line as a person types it: the CLI's own `mcp` command, which starts this same CLI for each test.
  const child = spawn(process.execPath, [CLI, "mcp", "--ai", "none", "--out", outDir, ...extra], { stdio: ["pipe", "pipe", "pipe"], cwd: outDir, env: { ...process.env, NO_COLOR: "1" } });
  const lines: string[] = [];
  let err = "";
  const waiters: { id: number; done: (m: Record<string, any>) => void }[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      lines.push(line);
      const m = JSON.parse(line);
      const w = waiters.findIndex((x) => x.id === m.id);
      if (w >= 0) waiters.splice(w, 1)[0]!.done(m);
    }
  });
  child.stderr.on("data", (c) => (err += c));
  const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
  return {
    child, lines, exited, stderr: () => err,
    ask: (id: number, method: string, params: unknown = {}) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise<Record<string, any>>((done) => waiters.push({ id, done }));
    },
  };
}

const POSIX = process.platform !== "win32";
/** Every process under `pid`, by parent, found with pgrep (macOS and Linux). */
function descendants(pid: number): number[] {
  const found: number[] = [];
  const walk = (p: number, depth: number) => {
    if (depth > 6) return;
    let kids: number[] = [];
    try {
      kids = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      // none
    }
    for (const k of kids) {
      found.push(k);
      walk(k, depth + 1);
    }
  };
  walk(pid, 0);
  return found;
}
/** Whether a process is a browser (Playwright's Chromium). */
const isBrowser = (pid: number) => {
  try {
    return /chrom/i.test(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
};
/** Whether a process is still there. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("mcp: over real stdio, against the local fixture site", () => {
  let site: FixtureSite;
  let out: string;
  before(async () => {
    site = await startFixtureSite();
    out = mkdtempSync(join(tmpdir(), "cm-mcp-real-"));
    const host = new URL(site.url).host.replace(/[^\w.-]+/g, "-");
    mkdirSync(join(out, "tests", host), { recursive: true });
    writeFileSync(join(out, "tests", host, "open-the-about-page.json"), JSON.stringify({
      version: 1, rules: 2, goal: "Open the About page", url: site.url, savedAt: "2026-11-17T00:00:00.000Z", visitor: true,
      steps: [{ title: "Open the About page", intent: "Open the About page from the header", check: { kind: "url_contains", text: "/about" }, actions: [{ type: "click", target: { role: "link", name: "About", nth: 0 } }] }],
    }));
  });
  after(async () => {
    await site.close();
    rmSync(out, { recursive: true, force: true });
  });

  it("initialize, tools/list, list_tests; run_saved replays to PASS with a report; run_test with no AI is a tool error; closing stdin ends it with no child left", async (ctx) => {
    const s = startServer(out);
    // A failed assertion must not leave the server waiting on its stdin (and the suite with it).
    ctx.after(() => s.child.kill("SIGKILL"));
    const init = await s.ask(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "script", version: "1" } });
    assert.equal(init.result.serverInfo.name, "contextmachines");
    s.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.equal((await s.ask(2, "tools/list")).result.tools.length, 5);
    const list = (await s.ask(3, "tools/call", { name: "list_tests", arguments: {} })).result.structuredContent;
    assert.equal(list.count, 1);
    assert.equal(list.tests[0].goal, "Open the About page");

    const saved = (await s.ask(4, "tools/call", { name: "run_saved", arguments: { url: site.url } })).result;
    let r = saved.structuredContent;
    for (let k = 0; r.status === "running" && k < 60; k++) {
      await new Promise((ok) => setTimeout(ok, 1000));
      r = (await s.ask(100 + k, "tools/call", { name: "get_result", arguments: { run: r.run } })).result.structuredContent;
    }
    assert.equal(r.status, "done", JSON.stringify(r));
    assert.equal(r.verdict, "pass", JSON.stringify(r));
    assert.equal(r.tests[0].verdict, "pass");
    assert.equal(r.tests[0].steps[0].verdict, "passed");
    assert.ok(existsSync(r.tests[0].files.report), "report.html exists");
    assert.ok(site.hits().includes("/about"), "the browser really went there");

    const t = (await s.ask(5, "tools/call", { name: "run_test", arguments: { goal: "Open the Pricing page", url: site.url } })).result;
    assert.equal(t.isError, true);
    assert.match(t.structuredContent.error, /needs an AI/);

    for (const line of s.lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
    const begun = Date.now();
    s.child.stdin.end();
    const code = await s.exited;
    assert.equal(code, 0);
    assert.ok(Date.now() - begun < 2500, `ended in ${Date.now() - begun} ms`);
    assert.ok(!alive(s.child.pid!));
  });

  it("closing stdin mid-run stops the run's process and its browser", async () => {
    const s = startServer(out);
    try {
      await s.ask(1, "initialize", { protocolVersion: "2025-11-25" });
      void s.ask(2, "tools/call", { name: "run_saved", arguments: { url: site.url } });
      // Wait until the run's process has started its browser (it and the browser's own processes under the server), then close.
      let seen: number[] = [];
      for (let k = 0; POSIX && k < 300 && !seen.some(isBrowser); k++) {
        seen = [...new Set([...seen, ...descendants(s.child.pid!)])];
        await new Promise((ok) => setTimeout(ok, 50));
      }
      if (POSIX) assert.ok(seen.some(isBrowser), "the run's browser was found while it ran");
      const begun = Date.now();
      s.child.stdin.end();
      assert.equal(await s.exited, 0);
      assert.ok(Date.now() - begun < 2500, `ended in ${Date.now() - begun} ms`);
      // The browser closes itself once its pipe to the run closes: given a moment.
      let left = seen.filter(alive);
      for (let k = 0; k < 60 && left.length; k++) {
        await new Promise((ok) => setTimeout(ok, 50));
        left = seen.filter(alive);
      }
      assert.deepEqual(left, [], "no process the server started is left");
    } finally {
      s.child.kill("SIGKILL");
    }
  });
});
