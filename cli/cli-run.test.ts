// The command line around a run: what it checks before one, what it says first, how Ctrl-C ends
// one, and how the new user's part ends on an app with no sign-up. Through the real command.
//   node --test cli/cli-run.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const cli = fileURLToPath(new URL("./contextmachines.ts", import.meta.url));
const browser = existsSync(chromium.executablePath());
const folder = () => mkdtempSync(join(tmpdir(), "cm-cli-"));
/** The environment a person's plain terminal has, whatever the test runner set. */
const plainEnv = () => {
  const { NO_COLOR: _n, FORCE_COLOR: _f, CI: _c, ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, OPENAI_BASE_URL: _b, ...env } = process.env;
  return { ...env, NO_COLOR: "1" };
};
const run = (cwd: string, args: string[], env: NodeJS.ProcessEnv = plainEnv()) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", input: "", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const serve = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ server: Server; url: string }>((done) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }));
  });

describe("an AI named that isn't here", () => {
  const dir = folder();
  after(() => rmSync(dir, { recursive: true, force: true }));
  // PATH holds only an empty folder: node itself is run by its full path.
  const bare = { ...plainEnv(), PATH: join(dir, "bin") };
  mkdirSync(join(dir, "bin"));
  it("stops before the run with exit 2 and what to do", { skip: process.platform === "win32" ? "agents are macOS and Linux only" : false }, () => {
    const claude = run(dir, ["learn", "x.test", "--ai", "claude-code"], bare);
    assert.equal(claude.code, 2, claude.err);
    assert.match(claude.err, /--ai claude-code needs the claude command on your PATH: install Claude Code and sign in, or use --ai none/);
    const codex = run(dir, ["learn", "x.test", "--ai", "codex"], bare);
    assert.equal(codex.code, 2, codex.err);
    assert.match(codex.err, /--ai codex needs the codex command on your PATH/);
  });
  it("goes on when the command is there", { skip: process.platform === "win32" ? "agents are macOS and Linux only" : false }, () => {
    writeFileSync(join(dir, "bin", "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", "claude"), 0o755);
    // An --out it can't write to stops it at the next check, before any browser.
    const r = run(dir, ["learn", "x.test", "--ai", "claude-code", "--out", "/dev/null/x"], bare);
    assert.doesNotMatch(r.err, /needs the claude command/);
    assert.match(r.err, /Can't write to/);
  });
});

describe("--json, when it can't go on", () => {
  it("says so on stdout too, as JSON", () => {
    const dir = folder();
    const r = run(dir, ["learn", "--json"]);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 2);
    assert.match(r.err, /Which site\?/);
    assert.deepEqual(JSON.parse(r.out), { ok: false, exit: 2, error: "Which site? Give its address." });
  });
  it("leaves stdout alone without it", () => {
    const dir = folder();
    const r = run(dir, ["learn"]);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.out, "");
  });
});

describe("Ctrl-C", { skip: !browser ? "no browser installed" : process.platform === "win32" && "a child can't be sent Ctrl-C on Windows" }, () => {
  // A page that never comes: the run is still at its first screen whenever Ctrl-C is pressed.
  let app: { server: Server; url: string };
  let dir: string;
  before(async () => {
    app = await serve(() => undefined);
    dir = folder();
  });
  after(() => {
    app.server.closeAllConnections();
    app.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** A run, Ctrl-C pressed once it has begun, then again after `gap` ms: what it said and how it ended. */
  const pressed = (gap: number) =>
    new Promise<{ code: number | null; text: string }>((done) => {
      const child = spawn(process.execPath, [cli, "learn", app.url, "--out", join(dir, `out-${gap}`), "--minutes", "1", "--ai", "none"], { cwd: dir, env: plainEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      let sent = false;
      // Pressed a while after its first line, once the browser is on its way and Ctrl-C is the run's.
      const read = (chunk: Buffer) => {
        text += chunk;
        if (sent) return;
        sent = true;
        setTimeout(() => {
          child.kill("SIGINT");
          setTimeout(() => child.kill("SIGINT"), gap);
        }, 2000);
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.on("close", (code) => done({ code, text }));
    });
  it("takes a second one at once, as npx sends it, as the same press: it still ends its own way", { timeout: 60_000 }, async () => {
    const { code, text } = await pressed(5);
    assert.equal(code, 130, text);
    assert.match(text, /Stopping: writing what it learned so far/);
    // Quitting now says it with a "!"; the run's own end with a "×".
    assert.match(text, /^× Stopped; nothing was written\.$/m, text);
    assert.doesNotMatch(text, /^! Stopped; nothing was written\.$/m);
  });
  it("quits now on a real second press", { timeout: 60_000 }, async () => {
    const { code, text } = await pressed(700);
    assert.equal(code, 130, text);
    assert.match(text, /Stopping: writing what it learned so far/);
    assert.match(text, /^! Stopped; nothing was written\.$/m, text);
  });
});

describe("what's said before the run", { skip: browser ? false : "no browser installed" }, () => {
  it("an address that doesn't answer comes first, before anything about the folder", { timeout: 60_000 }, async () => {
    const dir = folder();
    // A port nothing listens on: one just let go of.
    const { server, url } = await serve(() => undefined);
    await new Promise((done) => server.close(done));
    const r = await new Promise<{ code: number | null; text: string }>((done) => {
      const child = spawn(process.execPath, [cli, "learn", url, "--minutes", "1", "--ai", "none"], { cwd: dir, env: plainEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", (code) => done({ code, text }));
    });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 3, r.text);
    assert.match(r.text, /Nothing is answering at/);
    assert.doesNotMatch(r.text, /no app code here/);
  });
});

/** A login page and one more, with a sign-up link or without one. Plain JavaScript, as it also runs in a folder of its own. */
function loginPages(signUp: boolean) {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "text/html");
    const link = signUp ? '<p><a href="/signup">Sign up</a></p>' : "";
    if (req.url === "/signup") return res.end('<!doctype html><title>Sign up</title><h1>Sign up</h1><form><input type="email" name="email"><input type="password" name="password"><button type="submit">Create account</button></form>');
    if (req.url === "/about") return res.end("<!doctype html><title>About</title><h1>About</h1><p>A place to keep notes.</p>");
    return res.end(`<!doctype html><title>Notes</title><h1>Welcome back</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Log in</button></form>${link}<a href="/about">About</a>`);
  };
}
/** The pages served from this test's own folder: to a run elsewhere, another folder's app. */
const loginApp = (signUp: boolean) => serve(loginPages(signUp));
/** The pages served from `dir`, as an app run from its own folder is. */
const loginAppIn = (dir: string, signUp: boolean) =>
  new Promise<{ url: string; close: () => void }>((done) => {
    const child = spawn(process.execPath, ["-e", `const s = require("node:http").createServer((${loginPages})(${signUp})); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`], { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.once("data", (port) => done({ url: `http://127.0.0.1:${String(port).trim()}/`, close: () => child.kill() }));
  });

describe("a run that meets a sign-in", { skip: !browser ? "no browser installed" : process.platform === "win32" && "which folder serves a port is read on macOS and Linux only" }, () => {
  const learn = (url: string, dir: string) =>
    new Promise<{ code: number | null; text: string }>((done) => {
      const child = spawn(process.execPath, [cli, "learn", url, "--minutes", "1", "--pages", "4", "--ai", "none", "--no-journeys"], { cwd: dir, env: plainEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", (code) => done({ code, text }));
    });
  /** A folder with an app's code in it, a repository or not. */
  const appFolder = (git: boolean) => {
    const dir = folder();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "notes", scripts: { dev: "vite" }, dependencies: { react: "18.3.1" } }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "App.tsx"), "export const App = () => <h1>Welcome back</h1>;\n");
    if (git) {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "-A"], { cwd: dir });
    }
    return dir;
  };

  it("with no sign-up on the app, ends the new user's part as nothing to walk, not a warning; another folder's server is named from ~", { timeout: 180_000 }, async () => {
    const app = await loginApp(false);
    const dir = appFolder(true);
    const { code, text } = await learn(app.url, dir);
    app.server.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 0, text);
    assert.match(text, /^✓ \[new user\] no sign-up seen/m, text);
    assert.doesNotMatch(text, /didn't take the new account's session/);
    assert.match(text, /is served from another folder/);
    if (process.cwd().startsWith(homedir())) assert.ok(!text.includes(homedir()), text);
  });
  it("with a sign-up, still warns that the new account wasn't walked; and outside a repository says file:line is missing", { timeout: 180_000 }, async () => {
    const dir = appFolder(false);
    const app = await loginAppIn(dir, true);
    const { code, text } = await learn(app.url, dir);
    app.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 0, text);
    assert.match(text, /^! \[new user\] not walked/m, text);
    assert.match(text, /! not a git repository, so fixes won't have file:line: run git init && git add\s+-A first/);
  });
});
