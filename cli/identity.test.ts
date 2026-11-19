// Cache identity (moved from cli/ci/identity.test.ts, with the engine wiring): a project that
// names its app ("identity" in contextmachines.config.json) has saved tests that replay, heal and save
// on any address of that app (a preview); without a name, today's rules stand. No AI, no network.
//   node --test cli/identity.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { atHome, folderFor, readSaved, savedForHost, savedPathFor, writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { hrefsToTry, navigateOnReplay, navigateToSave } from "../packages/scanner/src/tester/identity.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import type { Action, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { readProjectConfig } from "./init.ts";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cm-identity-"));
  dirs.push(d);
  return d;
};

describe("cache identity: the rules", () => {
  it("reads the app's name from the config, and only a name", () => {
    const read = (config: unknown) => {
      const d = dir();
      writeFileSync(join(d, "contextmachines.config.json"), JSON.stringify(config));
      return readProjectConfig(d).identity;
    };
    assert.equal(read({ identity: "shop" }), "shop");
    assert.equal(read({ identity: " shop-web " }), "shop-web");
    assert.equal(read({ identity: "../etc" }), undefined);
    assert.equal(read({ identity: "a/b" }), undefined);
    assert.equal(read({ identity: 3 }), undefined);
    assert.equal(read({}), undefined);
  });

  it("files tests under the app's name, else the host as today", () => {
    assert.equal(folderFor("https://shop-git-fix-acme.vercel.app/", "shop"), "shop");
    assert.equal(folderFor("http://localhost:3000/", undefined), "localhost-3000");
    assert.equal(folderFor("http://localhost:3000/", "../x"), "localhost-3000");
    assert.equal(savedPathFor("/t", "Open the docs", "https://p.vercel.app/", "shop"), join("/t", "shop", "open-the-docs.json"));
  });

  it("a test is at home on any address of its own app, and never on another app's", () => {
    const saved = { url: "http://localhost:3000/cart", identity: "shop" };
    assert.equal(atHome(saved, "https://shop-abc123.vercel.app/cart", "shop"), true);
    assert.equal(atHome(saved, "https://blog-abc123.vercel.app/", "blog"), false);
    assert.equal(atHome({ url: "http://localhost:3000/" }, "https://shop-abc123.vercel.app/", "shop"), false, "an unnamed test keeps today's rule");
    assert.equal(atHome({ url: "http://localhost:3000/" }, "http://localhost:3000/x", undefined), true);
    assert.equal(atHome(saved, "https://p.vercel.app/", undefined), false, "a project with no name moves nothing home");
  });

  it("saves a navigation on the test's own origin as its path, any other whole", () => {
    assert.equal(navigateToSave("http://localhost:3000/pricing?x=1#a", "http://localhost:3000/"), "/pricing?x=1#a");
    assert.equal(navigateToSave("/docs", "http://localhost:3000/"), "/docs");
    assert.equal(navigateToSave("https://other.example/x", "http://localhost:3000/"), "https://other.example/x");
    assert.equal(new URL(navigateToSave("http://localhost:3000/a", "http://localhost:3000/"), "https://p.vercel.app/b").href, "https://p.vercel.app/a");
  });

  it("on replay, moves only the saved origin's addresses to the run's origin", () => {
    const start = "https://p.vercel.app/";
    assert.equal(navigateOnReplay("http://localhost:3000/pricing?x=1", "http://localhost:3000", start), "https://p.vercel.app/pricing?x=1");
    assert.equal(navigateOnReplay("https://other.example/x", "http://localhost:3000", start), "https://other.example/x");
    assert.equal(navigateOnReplay("http://localhost:3000/x", undefined, start), "http://localhost:3000/x");
    assert.equal(navigateOnReplay("http://localhost:3000/x", "http://localhost:3000", "http://localhost:3000/"), "http://localhost:3000/x");
  });

  it("compares an absolute saved href on the new origin too", () => {
    assert.deepEqual(hrefsToTry("/docs", "http://localhost:3000", "https://p.vercel.app/"), ["/docs"]);
    assert.deepEqual(hrefsToTry("http://localhost:3000/docs", "http://localhost:3000", "https://p.vercel.app/"), ["http://localhost:3000/docs", "https://p.vercel.app/docs", "/docs"]);
    assert.deepEqual(hrefsToTry("https://x.example/docs", "http://localhost:3000", "https://p.vercel.app/"), ["https://x.example/docs"]);
  });

  it("readSaved keeps a name and drops anything else; writeSaved writes it", () => {
    const d = dir();
    const file = join(d, "t.json");
    const steps = [{ title: "Open", intent: "Open", check: { kind: "text_visible", text: "x" }, actions: [{ type: "wait", ms: 1 }] }] as SavedTest["steps"];
    writeFileSync(file, JSON.stringify({ version: 1, goal: "g", url: "http://localhost:3000/", steps, savedAt: "", identity: "../x" }));
    assert.equal(readSaved(file).identity, undefined);
    writeSaved(file, { goal: "g", url: "http://localhost:3000/", steps, identity: "shop" });
    assert.equal(readSaved(file).identity, "shop");
    assert.ok(savedForHost(d, "https://p.vercel.app/", "shop") === false, "t.json sits at the top, not in shop/");
  });
});

// ---------------------------------------------------------------------------------------------
// The engine and the command, on a tiny site served at both localhost:P and 127.0.0.1:P.

let browser: Browser;
let server: Server;
let port = 0;
const hits: string[] = [];
/** The link's words: "Pricing", or after a redesign "Plans". */
let linkWords = "Pricing";

before(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    const page = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`);
    if (req.url === "/pricing") return page("<h1>Pricing plans</h1>");
    return page(`<h1>Shop</h1><a href="/pricing">${linkWords}</a>`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await browser?.close();
  await new Promise((done) => server?.close(done));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const one = (moves: Action[]): TesterBrain => {
  const left = [...moves];
  return {
    async plan() {
      return [{ title: "Open pricing", intent: "Open pricing", check: { kind: "text_visible", text: "Pricing plans" } }];
    },
    async decide() {
      return left.shift() ?? { type: "done" };
    },
  };
};

describe("cache identity: the engine", () => {
  it("a saved navigate to the test's own absolute address goes to the run's address (not BLOCKED as another site)", async () => {
    const saved: SavedTest = { version: 1, goal: "open pricing", url: `http://localhost:${port}/`, savedAt: "", identity: "shop", steps: [{ title: "Open pricing", intent: "Open pricing", check: { kind: "text_visible", text: "Pricing plans" }, actions: [{ type: "navigate", url: `http://localhost:${port}/pricing` }] }] };
    const from = hits.length;
    const { result } = await runTest({ goal: saved.goal, url: `http://127.0.0.1:${port}/`, saved, dir: dir(), browser, identity: "shop", checkWaitMs: 600 });
    assert.equal(result.verdict, "pass", result.steps.map((s) => s.reason).join(" | "));
    assert.ok(hits.slice(from).includes(`127.0.0.1:${port} /pricing`), hits.slice(from).join(", "));
  });

  it("a new save in a named project writes the navigation as a path, and carries the name", async () => {
    const { result, save } = await runTest({ goal: "open pricing", url: `http://localhost:${port}/`, dir: dir(), browser, brain: one([{ type: "navigate", url: `http://localhost:${port}/pricing` }, { type: "done" }]), identity: "shop", checkWaitMs: 600 });
    assert.equal(result.verdict, "pass", result.steps.map((s) => s.reason).join(" | "));
    assert.equal(save?.identity, "shop");
    assert.deepEqual(save?.steps[0]?.actions?.[0], { type: "navigate", url: "/pricing" });
  });
});

const CLI = join(import.meta.dirname, "contextmachines.ts");
function cli(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const { CI: _ci, ANTHROPIC_API_KEY: _key, ...rest } = process.env;
    const child = spawn(process.execPath, [CLI, "test", ...args], { cwd, env: { ...rest, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("cache identity: the command (--url, no AI)", () => {
  /** A project whose saved test (at localhost:P, link renamed since) is run on 127.0.0.1:P. */
  const project = (identity: string | undefined, testIdentity: string | undefined) => {
    const d = dir();
    writeFileSync(join(d, "contextmachines.config.json"), JSON.stringify(identity ? { identity } : {}));
    const folder = testIdentity ?? `localhost-${port}`;
    const file = join(d, "cm", "tests", folder, "open-pricing.json");
    writeSaved(file, { goal: "open pricing", url: `http://localhost:${port}/`, rules: 2, ...(testIdentity ? { identity: testIdentity } : {}), steps: [{ title: "Open pricing", intent: "Open pricing", check: { kind: "text_visible", text: "Pricing plans" }, actions: [{ type: "click", target: { role: "link", name: "Pricing (old)", nth: 0, of: 1 } }] }] });
    return { d, file };
  };

  it("named app: the test is at home on the new address (it would be healed: with no AI, says so), and the file keeps its own url", async () => {
    linkWords = "Plans";
    const { d, file } = project("shop", "shop");
    const before = readFileSync(file, "utf8");
    const r = await cli(d, ["--out", "cm", "--ai", "none", "--url", `http://127.0.0.1:${port}/`]);
    const said = r.stdout + r.stderr;
    assert.match(said, /no AI to find another way/, said);
    assert.doesNotMatch(said, /isn't healed|nothing is healed or saved/);
    assert.equal(readFileSync(file, "utf8"), before, "nothing passed, so nothing is written");
  });

  it("no name in the project: today's rule (another address isn't healed)", async () => {
    const { d } = project(undefined, undefined);
    const r = await cli(d, ["--out", "cm", "--ai", "none", "--url", `http://127.0.0.1:${port}/`, "--grep", "pricing"]);
    assert.match(r.stdout + r.stderr, /isn't healed/);
  });

  it("a test of another app (blog) in a shop project: not at home", async () => {
    const { d } = project("shop", "blog");
    const r = await cli(d, ["--out", "cm", "--ai", "none", "--url", `http://127.0.0.1:${port}/`, "--grep", "pricing"]);
    assert.match(r.stdout + r.stderr, /isn't healed/);
  });
});
