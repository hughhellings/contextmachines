// From "found" to "fixing": the menu at the end of a run (with a pretend terminal), handing the list
// to a pretend coding agent on PATH (never the real one), the opener and the clipboard, links in the
// terminal, the tidy list, the folder guards, and report.html's cards.
//   node --test cli/hand-off.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ScreenCheck } from "@contextmachines/scanner";
import { buildFixes } from "./brief.ts";
import { AGENT_NAMES, agentFor, agentHere, agentLaunch, clipboardFor, copyText, endMenu, fixPrompt, menuKeys, menuLine, onPath, openerFor, openFile, startAgent, type MenuOffer } from "./hand-off.ts";
import { hasAppCode } from "./project.ts";
import { AGENT_WORDS, fixDoc, fixLines, forPasting, jpegSize, moreFixLines, onPhoto, outInUse, problemWords, reportPage, type Fix, type ProductMap } from "./report.ts";
import { colors, cut, fit, linked, linksWanted, visibleWidth, waitForKey, wrapTo, type KeyEnd, type MenuKey } from "./term.ts";

const scratch = mkdtempSync(join(tmpdir(), "cm-hand-off-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;
const folder = (files: Record<string, string> = {}) => {
  const dir = join(scratch, `d${++made}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
/** Where these tests can't run on Windows: their pretend commands are shell scripts, and their paths POSIX ones. */
const POSIX_ONLY = { skip: process.platform === "win32" && "shell-script commands and POSIX paths" };
/** A pretend command on a PATH of its own: it writes its arguments and what it was given on stdin to a file, and exits with `code`. */
const fakeCommand = (name: string, code = 0, readsStdin = name !== "claude") => {
  const bin = folder();
  const said = join(bin, `${name}.said`);
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${said}"\n${readsStdin ? `/bin/cat >> "${said}"` : ""}\nexit ${code}\n`);
  chmodSync(join(bin, name), 0o755);
  return { bin, said: () => readFileSync(said, "utf8") };
};

const map = (fixes: Fix[], more: Partial<ProductMap> = {}): ProductMap => ({ url: "http://localhost:3000/", product: null, mainAction: null, journeys: [], screens: [{ path: "/notes", title: "Notes", headings: [] }], actions: [], findings: [], predictions: [], fixes, learner: { visited: 1, stoppedBy: "complete", savesStopped: 0, seconds: 10, measured: 1 }, ...more });
const item = (n: number, more: Partial<Fix> = {}): Fix => ({ id: `cut_off-${n}`, status: "proven", from: "check", kind: "cut_off", title: `Label ${n} cut off at laptop size`, screen: "/notes", screens: ["/notes"], evidence: ["needs 71px and has 62px"], fix: "Give it room", where: { file: "src/nav.ts", line: n }, ...more });
const ten = Array.from({ length: 10 }, (_, k) => item(k + 1));
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));
const start = new URL("http://localhost:3000/");

describe("the menu's line", () => {
  const offer: MenuOffer = { count: 10, agent: "claude", more: true, open: true, copy: true };
  it("names what's there and each key, f first, the keys in bold", () => {
    const keys = menuKeys(offer);
    assert.deepEqual(keys, ["f", "o", "a", "c"]);
    const line = menuLine(offer, keys, colors(true), 160);
    assert.equal(stripVTControlCharacters(line), "  10 problems · f fix them with Claude Code · o see them all · a list here · c copy FIX.md · Enter done");
    for (const key of ["f", "o", "a", "c", "Enter"]) assert.ok(line.includes(`\x1b[1m${key}\x1b[22m`), key);
  });
  it("is always one line: shorter words where the full ones don't fit, then the keys alone", () => {
    for (const cols of [120, 80, 60, 40]) {
      const line = menuLine(offer, menuKeys(offer), colors(true), cols);
      assert.ok(visibleWidth(line) < cols || cols < 50, `${cols}: ${stripVTControlCharacters(line)}`);
    }
    assert.equal(stripVTControlCharacters(menuLine(offer, menuKeys(offer), colors(false), 100)), "  10 problems · f fix with Claude Code · o see the page · a list here · c copy FIX.md · Enter done");
    assert.equal(stripVTControlCharacters(menuLine(offer, menuKeys(offer), colors(false), 80)), "  f fix with Claude Code · o page · a rest · c copy list · Enter done");
    // Narrower still, the agent's name stays: which one starts is what a person needs before pressing f.
    assert.equal(stripVTControlCharacters(menuLine(offer, menuKeys(offer), colors(false), 60)), "  f Claude Code · o page · a rest · c copy · Enter done");
    assert.equal(stripVTControlCharacters(menuLine(offer, menuKeys(offer), colors(false), 40)), "  f · o · a · c · Enter");
    const single = { ...offer, count: 1, more: false };
    assert.equal(stripVTControlCharacters(menuLine(single, menuKeys(single), colors(false), 120)), "  1 problem · f fix it with Claude Code · o see it · c copy FIX.md · Enter done");
    assert.equal(stripVTControlCharacters(menuLine(single, menuKeys(single), colors(false), 80)), "  1 problem · f fix it with Claude Code · o see it · c copy FIX.md · Enter done");
  });
  it("offers f only with the agent the run used, a only with more to list, c only with a clipboard", () => {
    assert.deepEqual(menuKeys({ ...offer, agent: undefined }), ["o", "a", "c"]);
    assert.deepEqual(menuKeys({ ...offer, more: false }), ["f", "o", "c"]);
    assert.deepEqual(menuKeys({ ...offer, copy: false, open: false }), ["f", "a"]);
    assert.match(stripVTControlCharacters(menuLine({ ...offer, agent: "codex" }, ["f"], colors(false), 160)), /f fix them with Codex/);
  });
  it("starts no agent where this folder has no app's code: it would have nothing to fix", () => {
    const claude = fakeCommand("claude");
    assert.equal(agentHere("claude", true, { PATH: claude.bin }, "darwin"), "claude");
    assert.equal(agentHere("claude", false, { PATH: claude.bin }, "darwin"), undefined);
    assert.deepEqual(menuKeys({ ...offer, agent: agentHere("claude", false, { PATH: claude.bin }, "darwin") }), ["o", "a", "c"]);
  });
  it("with nothing to fix, only the page with the screens", () => {
    const none = { ...offer, count: 0 };
    assert.deepEqual(menuKeys(none), ["o"]);
    assert.equal(stripVTControlCharacters(menuLine(none, ["o"], colors(false), 80)), "  o see the screens · Enter done");
  });
});

/** A pretend terminal: keys pressed are given to the menu's wait as they are to a real one. */
function keyboard() {
  const events = new EventEmitter();
  return {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
    },
    on: (event: string, listener: (chunk?: unknown) => void) => events.on(event, listener),
    off: (event: string, listener: (chunk?: unknown) => void) => events.off(event, listener),
    resume: () => {},
    pause: () => {},
    press: (key: string) => events.emit("data", Buffer.from(key)),
  };
}
const signals = () => {
  const events = new EventEmitter();
  return { on: (e: string, l: () => void) => events.on(e, l), off: (e: string, l: () => void) => events.off(e, l) };
};

describe("the menu, key by key", () => {
  const run = async (presses: string[], offer: MenuOffer = { count: 10, agent: "claude", more: true, open: true, copy: true }) => {
    const input = keyboard();
    const done: string[] = [];
    const hints: string[] = [];
    let screen = "";
    const wait = (hint: string, keys: readonly MenuKey[]): Promise<KeyEnd> => {
      hints.push(stripVTControlCharacters(hint));
      const waiting = waitForKey(hint, { keys, input, output: { write: (t: string) => void (screen += t) }, signals: signals(), settle: 0 });
      // Each key a moment after the line is up, as a person presses it, until one answers.
      let answered = false;
      void waiting.then(() => void (answered = true));
      const next = () => {
        if (answered) return;
        input.press(presses.shift() ?? "\r");
        setImmediate(next);
      };
      setImmediate(next);
      return waiting;
    };
    const act = { f: () => (done.push("f"), 7), o: () => void done.push("o"), a: () => void done.push("a"), c: () => void done.push("c") };
    const code = await endMenu({ offer, wait, line: (keys) => menuLine(offer, keys, colors(false), 120), act });
    return { code, done, hints, input, screen };
  };
  it("o, a and c each do their part and the menu comes back; Enter ends it as the run decided", async () => {
    const t = await run(["o", "a", "c", "\r"]);
    assert.deepEqual(t.done, ["o", "a", "c"]);
    assert.equal(t.code, undefined);
    assert.equal(t.input.isRaw, false, "the terminal given back");
    assert.ok(t.screen.endsWith("\r\x1b[2K\x1b[?25h"), "the line cleared and the cursor shown");
  });
  it("says a key that goes wrong and comes back to the menu, without ending the run on it", async () => {
    const offer: MenuOffer = { count: 10, agent: "claude", more: true, open: true, copy: true };
    const keys = ["c", "o", "done"] as KeyEnd[];
    const said: string[] = [];
    const code = await endMenu({
      offer,
      wait: async () => keys.shift()!,
      line: () => "",
      act: { f: () => 0, a: () => {}, o: () => void said.push("o"), c: () => { throw new Error("ENOENT: FIX.md"); } },
      failed: (key, error) => said.push(`${key}: ${(error as Error).message}`),
    });
    assert.equal(code, undefined);
    assert.deepEqual(said, ["c: ENOENT: FIX.md", "o"]);
  });
  it("lists once: a second a is nothing, and is gone from the line, so it never reaches the shell", async () => {
    const t = await run(["a", "a", "q"]);
    assert.deepEqual(t.done, ["a"]);
    assert.match(t.hints[0]!, /a list here/);
    assert.doesNotMatch(t.hints[1]!, /a list/);
  });
  it("stray keys stay in the menu until Enter, q, Esc or Ctrl-C", async () => {
    for (const end of ["\r", "q", "\x1b", "\x03"]) {
      const t = await run(["x", "z", end]);
      assert.deepEqual(t.done, [], JSON.stringify(end));
      assert.equal(t.code, undefined);
    }
  });
  it("f hands over and ends the run with the agent's code", async () => {
    const t = await run(["o", "f"]);
    assert.deepEqual(t.done, ["o", "f"]);
    assert.equal(t.code, 7);
  });
  it("without an agent, f is nothing", async () => {
    const t = await run(["f", "\r"], { count: 3, more: false, open: true, copy: true });
    assert.deepEqual(t.done, []);
  });
});

describe("handing the list to the coding agent", () => {
  it("asks for the file by its path, proven first, evidence checked first", () => {
    assert.equal(fixPrompt("contextmachines/FIX.md"), "Fix the problems in contextmachines/FIX.md, proven ones first. Each has evidence: check it before changing code, and say which you fixed.");
    assert.deepEqual(AGENT_NAMES, { claude: "Claude Code", codex: "Codex" });
  });
  it("starts the agent the run used, in this terminal, with the ask, and ends with its code: a pretend one on PATH", POSIX_ONLY, async () => {
    const fake = fakeCommand("claude", 3);
    const env = { ...process.env, PATH: `${fake.bin}:/usr/bin:/bin` };
    assert.equal(agentFor("claude", env, "darwin"), "claude");
    const code = await startAgent("claude", fixPrompt("contextmachines/FIX.md"), { env, signals: signals() });
    assert.equal(code, 3);
    assert.equal(fake.said().trim(), fixPrompt("contextmachines/FIX.md"), "one argument, the ask, whole");
  });
  it("passes the run's --model on, as each agent takes it, and none when the run had none", POSIX_ONLY, async () => {
    for (const [agent, flag] of [["codex", "-m"], ["claude", "--model"]] as const) {
      const fake = fakeCommand(agent, 0, false);
      const env = { ...process.env, PATH: `${fake.bin}:/usr/bin:/bin` };
      await startAgent(agent, "fix it", { model: "gpt-6-luna", env, signals: signals() });
      assert.deepEqual(fake.said().trim().split("\n"), [flag, "gpt-6-luna", "fix it"]);
      await startAgent(agent, "fix it", { env, signals: signals() });
      assert.equal(fake.said().trim(), "fix it");
    }
  });
  it("never guesses: no agent with an API key, none that isn't on PATH, none on Windows it can't start without a shell", () => {
    const fake = fakeCommand("codex");
    assert.equal(agentFor(undefined, { PATH: fake.bin }, "darwin"), undefined, "an API key's run");
    assert.equal(agentFor("claude", { PATH: fake.bin }, "darwin"), undefined, "the run's agent isn't there");
    assert.equal(agentFor("codex", { PATH: fake.bin }, "darwin"), "codex");
    assert.equal(agentFor("codex", { PATH: fake.bin }, "win32"), undefined, "no .exe, nor a .cmd launcher to read");
    // As npm installs it on Windows: a .cmd naming the script it runs, which is run by Node instead.
    const bin = folder();
    mkdirSync(join(bin, "node_modules", "codex", "bin"), { recursive: true });
    writeFileSync(join(bin, "node_modules", "codex", "bin", "codex.js"), "");
    writeFileSync(join(bin, "codex.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\codex\\bin\\codex.js" %*\r\n`);
    assert.equal(agentFor("codex", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32"), "codex");
    assert.deepEqual(agentLaunch("codex", { PATH: bin }, "win32"), { command: process.execPath, args: [join(bin, "node_modules", "codex", "bin", "codex.js")] });
    writeFileSync(join(bin, "claude.exe"), "");
    assert.deepEqual(agentLaunch("claude", { PATH: bin }, "win32"), { command: join(bin, "claude.exe"), args: [] }, "Claude Code's own installer: the program itself");
  });
  it("on Windows, starts only what the shell itself would run", () => {
    const first = folder();
    const later = folder();
    writeFileSync(join(later, "claude.exe"), "");
    // A wrapper of the person's own, first on PATH, that this can't read: never the other install instead.
    writeFileSync(join(first, "claude.cmd"), `@set HTTPS_PROXY=http://proxy:8080\r\n@"C:\\Tools\\claude.exe" %*\r\n`);
    assert.equal(agentLaunch("claude", { PATH: `${first};${later}` }, "win32"), undefined);
    assert.deepEqual(agentLaunch("claude", { PATH: `"${later}"` }, "win32"), { command: join(later, "claude.exe"), args: [] }, "a quoted folder is still that folder");
    assert.equal(agentLaunch("claude", { PATH: "relative-bin" }, "win32"), undefined, "a folder relative to wherever the shell is");
    // A .bat counts, in PATHEXT's order.
    const bat = folder();
    mkdirSync(join(bat, "node_modules", "c"), { recursive: true });
    writeFileSync(join(bat, "node_modules", "c", "cli.js"), "");
    writeFileSync(join(bat, "claude.bat"), `@"%~dp0\\node_modules\\c\\cli.js" %*\r\n`);
    assert.deepEqual(agentLaunch("claude", { PATH: bat }, "win32")?.args, [join(bat, "node_modules", "c", "cli.js")]);
    assert.equal(agentLaunch("claude", { PATH: bat, PATHEXT: ".EXE;.CMD" }, "win32"), undefined, "nor one PATHEXT leaves out");
    // yarn's launcher hands on to another, which names the script.
    const yarn = folder();
    mkdirSync(join(yarn, "Data", "global", "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(yarn, "Data", "global", "node_modules", "@anthropic-ai", "claude-code"), { recursive: true });
    writeFileSync(join(yarn, "Data", "global", "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "");
    writeFileSync(join(yarn, "Data", "global", "node_modules", ".bin", "claude.cmd"), `@"%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
    mkdirSync(join(yarn, "bin"));
    writeFileSync(join(yarn, "bin", "claude.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\claude.cmd" %*\r\n`);
    assert.deepEqual(agentLaunch("claude", { PATH: join(yarn, "bin") }, "win32"), { command: process.execPath, args: [join(yarn, "Data", "global", "node_modules", "@anthropic-ai", "claude-code", "cli.js")] });
  });
  it("lets a Ctrl-C pass to the agent while it runs, and listens no longer after", POSIX_ONLY, async () => {
    const fake = fakeCommand("claude");
    const events = new EventEmitter();
    const s = { on: (e: string, l: () => void) => events.on(e, l), off: (e: string, l: () => void) => events.off(e, l) };
    const running = startAgent("claude", "x", { env: { PATH: fake.bin }, signals: s });
    assert.equal(events.listenerCount("SIGINT"), 1);
    assert.equal(await running, 0);
    assert.equal(events.listenerCount("SIGINT"), 0);
  });
  it("says 127 when the agent can't start", async () => {
    assert.equal(await startAgent("claude", "x", { env: { PATH: folder() }, signals: signals() }), 127);
  });
  it("finds a command on PATH only as a file it may run", POSIX_ONLY, () => {
    const fake = fakeCommand("pbcopy");
    const notRunnable = folder({ pbcopy: "" });
    assert.equal(onPath("pbcopy", { PATH: fake.bin }, "darwin"), true);
    assert.equal(onPath("pbcopy", { PATH: notRunnable }, "darwin"), false);
    assert.equal(onPath("pbcopy", { PATH: "" }, "darwin"), false);
  });
  it("finds a command on Windows by PATHEXT's endings, in PATH's ;-separated folders", () => {
    const bin = folder({ "codex.CMD": "@echo off\r\n" });
    assert.equal(onPath("codex", { PATH: `${folder()};${bin}`, PATHEXT: ".EXE;.CMD" }, "win32"), true);
    assert.equal(onPath("codex", { PATH: bin, PATHEXT: ".EXE" }, "win32"), false, "an ending PATHEXT doesn't list");
    assert.equal(onPath("claude", { PATH: bin }, "win32"), false);
  });
});

describe("opening the page and copying the list", () => {
  it("opens with the OS's own opener, left to run on its own", async () => {
    assert.deepEqual(openerFor("darwin"), { command: "open", args: [] });
    // Never cmd: it reads & and %NAME% in a path, so a folder name could run a command.
    assert.deepEqual(openerFor("win32"), { command: "explorer.exe", args: [], ok: [1] });
    const xdg = fakeCommand("xdg-open");
    assert.deepEqual(openerFor("linux", { PATH: xdg.bin }), { command: "xdg-open", args: [] });
    assert.equal(openerFor("linux", { PATH: folder() }), undefined);
    const calls: { command: string; args: readonly string[]; detached?: boolean }[] = [];
    const spawn = (command: string, args: readonly string[], options: { detached?: boolean }) => {
      calls.push({ command, args, ...(options.detached ? { detached: true } : {}) });
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      setImmediate(() => child.emit("exit", 0));
      return child as never;
    };
    assert.equal(await openFile({ command: "open", args: [] }, "/x/report.html", spawn), true);
    assert.deepEqual(calls, [{ command: "open", args: ["/x/report.html"], detached: true }]);
  });
  it("hands Windows' explorer a path with & or % in it whole, and takes its 1 as opened", async () => {
    const calls: (readonly string[])[] = [];
    const exiting = (code: number) => (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      setImmediate(() => child.emit("exit", code));
      return child as never;
    };
    const path = "C:\\src\\R&D %PATH%\\contextmachines\\report.html";
    assert.equal(await openFile(openerFor("win32")!, path, exiting(1)), true);
    assert.deepEqual(calls, [["explorer.exe", path]], "one argument, no cmd to read it");
    assert.equal(await openFile(openerFor("win32")!, path, exiting(2)), false);
    assert.equal(await openFile(openerFor("darwin")!, "/x", exiting(1)), false, "open's 1 is a failure");
  });
  it("says so when the opener fails", async () => {
    const failing = fakeCommand("open", 1);
    assert.equal(await openFile({ command: join(failing.bin, "open"), args: [] }, "/x/report.html"), false);
    assert.equal(await openFile({ command: join(folder(), "nothing-here"), args: [] }, "/x/report.html"), false);
  });
  it("copies FIX.md's text through a clipboard tool's stdin: a pretend pbcopy", POSIX_ONLY, () => {
    const fake = fakeCommand("pbcopy");
    assert.deepEqual(clipboardFor("darwin", { PATH: fake.bin }), { command: "pbcopy", args: [] });
    assert.equal(copyText({ command: join(fake.bin, "pbcopy"), args: [] }, "# What to fix\n1. this"), true);
    assert.match(fake.said(), /# What to fix\n1\. this/);
    assert.equal(copyText({ command: join(fakeCommand("pbcopy", 1).bin, "pbcopy"), args: [] }, "x"), false);
  });
  it("offers no copy where there's no clipboard tool", () => {
    assert.equal(clipboardFor("darwin", { PATH: folder() }), undefined);
    assert.equal(clipboardFor("linux", { PATH: fakeCommand("xclip").bin }), undefined, "no display");
    assert.deepEqual(clipboardFor("linux", { PATH: fakeCommand("xclip").bin, DISPLAY: ":0" }), { command: "xclip", args: ["-selection", "clipboard"] });
    assert.deepEqual(clipboardFor("linux", { PATH: fakeCommand("wl-copy").bin, WAYLAND_DISPLAY: "wayland-0" }), { command: "wl-copy", args: [] });
    assert.deepEqual(clipboardFor("win32", {}), { command: "clip", args: [] });
  });
});

describe("links in the terminal", () => {
  const tty = { isTTY: true };
  it("only in terminals known to open them, by what they set, never asked", () => {
    for (const env of [{ TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "WezTerm" }, { TERM_PROGRAM: "vscode" }, { TERM_PROGRAM: "ghostty" }, { TERM: "xterm-kitty" }, { WT_SESSION: "x" }]) assert.ok(linksWanted(tty, env, 0), JSON.stringify(env));
    assert.ok(linksWanted(tty, { TERM_PROGRAM: "Apple_Terminal" }, 24), "Terminal on macOS 15");
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "Apple_Terminal" }, 23), undefined, "Terminal before macOS 15");
    assert.equal(linksWanted(tty, { TERM: "xterm-256color" }, 0), undefined, "unknown");
    assert.equal(linksWanted({ isTTY: false }, { TERM_PROGRAM: "iTerm.app" }, 0), undefined, "a pipe");
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "iTerm.app", CI: "1" }, 0), undefined, "CI");
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }, 0), undefined, "inside tmux");
  });
  it("opens a file at its line in the editor the terminal is inside, else as a file", () => {
    // This machine's own paths: on Windows they have a drive letter, which the link carries as /C:/….
    const path = (p: string) => resolve(p);
    const url = (p: string) => (process.platform === "win32" ? `/${resolve(p).replaceAll("\\", "/")}` : p).replaceAll(" ", "%20");
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "vscode" }, 0)!.file(path("/app/src/a b.ts"), 12), `vscode://file${url("/app/src/a b.ts")}:12`);
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "x" }, 0)!.file(path("/app/src/a.ts"), 12), `cursor://file${url("/app/src/a.ts")}:12`);
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "iTerm.app" }, 0)!.file(path("/app/src/a.ts"), 12), `file://${url("/app/src/a.ts")}`);
    assert.equal(linksWanted(tty, { TERM_PROGRAM: "vscode" }, 0)!.file(path("/out/screens/x.jpg")), `file://${url("/out/screens/x.jpg")}`);
  });
  it("takes no width: a link's address is never counted, cut or wrapped as words", () => {
    const words = linked("file:///a/very long (1)/path.jpg", colors(true).cyan("screenshot"));
    assert.equal(visibleWidth(words), 10);
    assert.equal(visibleWidth(linked("file:///x", "ab") + linked("vscode://file/y:3", "cd")), 4);
    assert.equal(fit(words, 40), words, "it fits, so it's left as it is");
    assert.deepEqual(wrapTo(`see ${linked("file:///p", "this")} here`, 8).map((l) => visibleWidth(l)), [8, 4]);
    const clipped = cut(`${linked("file:///p", "abcdefghij")}`, 5);
    assert.equal(visibleWidth(clipped), 5);
    assert.ok(clipped.includes("\x1b]8;;\x1b\\"), "a link cut inside is closed");
  });
});

describe("the list on a terminal that opens links", () => {
  const links = linksWanted({ isTTY: true }, { TERM_PROGRAM: "vscode" }, 0)!;
  const to = { links, outDir: "/work/app/contextmachines", codeDir: "/work/app" };
  const fixes = [item(1, { photo: "screens/fix-cut_off-1.jpg" }), item(2, { photo: "screens/notes.jpg", where: { file: "src/a.ts", also: ["src/b.ts"] } })];
  it("links where to the file at its line, and the evidence to its photo as one short word", POSIX_ONLY, () => {
    const lines = fixLines(map(fixes), { out: "contextmachines", to }, colors(true), 80);
    const text = lines.join("\n");
    assert.ok(text.includes("\x1b]8;;vscode://file/work/app/src/nav.ts:1\x1b\\"), "where opens at its line");
    assert.ok(text.includes("\x1b]8;;file:///work/app/contextmachines/screens/fix-cut_off-1.jpg\x1b\\"), "the evidence opens its photo");
    // Its short name in the output folder: a path still to go by where a terminal takes links but won't open one.
    assert.match(plain(lines), /^ {5}evidence {3}screens\/fix-cut_off-1\.jpg$/m);
    assert.doesNotMatch(plain(lines), /contextmachines\/screens/, "no long path left to wrap alone");
    const narrow = plain(fixLines(map(fixes), { out: "contextmachines", to }, colors(true), 30));
    assert.match(narrow, /evidence {3}screenshot$/m, "only where even that won't fit, the one word");
    for (const line of lines) assert.ok(visibleWidth(line) <= 80, plain([line]));
  });
  it("is as before without links: the path in full", () => {
    const text = plain(fixLines(map(fixes), { out: "contextmachines" }, colors(true), 80));
    assert.match(text, /evidence {3}contextmachines\/screens\/fix-cut_off-1\.jpg/);
    assert.doesNotMatch(fixLines(map(fixes), { out: "contextmachines" }, colors(true), 80).join(""), /\x1b\]8;/);
  });
  it("never links a place outside the code, or a photo that isn't one this run wrote", () => {
    const odd = [item(1, { where: { file: "../../etc/passwd", line: 1 }, photo: "../x.jpg" }), item(2, { where: { file: "/etc/hosts", line: 2 } })];
    const text = fixLines(map(odd), { out: "contextmachines", to }, colors(true), 80).join("\n");
    assert.doesNotMatch(text, /\x1b\]8;;[^\x1b]*(passwd|hosts|x\.jpg)/);
  });
  it("keeps site text harmless inside a linked list", () => {
    const text = fixLines(map([item(1, { title: "Bad \x1b]8;;http://evil.example\x1b\\click\x1b]8;;\x1b\\ label" })]), { out: "contextmachines", to }, colors(true), 80).join("\n");
    assert.doesNotMatch(text, /evil\.example/);
  });
});

describe("the a list, tidy", () => {
  it("one block per item, FIX.md's numbers, the rest only, nothing said twice", () => {
    const rest = plain(moreFixLines(map(ten), { out: "contextmachines" }, colors(true), 80));
    assert.equal(rest.match(/^ {2} ?\d+\. /gm)?.join("|"), "   6. |   7. |   8. |   9. |  10. ");
    assert.doesNotMatch(rest, /Hand|→/, "no second hand line");
    assert.equal(rest.match(/all 10 shown/g)?.length, 1);
  });
  it("keeps new with its title, before it, never dangling after a wrapped line", () => {
    const long = item(6, { new: true, title: "A label in the settings panel is cut off at laptop size and phone size and every size between" });
    const lines = moreFixLines(map([...ten.slice(0, 5), long]), { out: "contextmachines" }, colors(true), 80);
    const text = plain(lines);
    assert.match(text, /^ {2}6\. proven {5}new A label in the settings/m);
    for (const line of text.split("\n")) assert.doesNotMatch(line, /\S\s+new$/, line);
    assert.ok(lines.some((line) => line.includes("\x1b[36mnew\x1b[39m")), "new in cyan");
    // With no colour, a dot sets it apart from the title's own first word.
    assert.match(plain(moreFixLines(map([...ten.slice(0, 5), long]), { out: "contextmachines" }, colors(false), 80)), /^ {2}6\. proven {5}new · A label in the settings/m);
    for (const line of lines) assert.ok(visibleWidth(line) <= 80);
    assert.match(fixDoc(map([...ten.slice(0, 5), long]), start), /^### 6\. A label in the settings.*\(new since the last run\)$/m, "FIX.md as it was");
  });
});

describe("running in the wrong place", () => {
  it("knows an app's folder by its own files, and a home folder by their absence", () => {
    assert.equal(hasAppCode(folder({ "package.json": "{}" })), true);
    assert.equal(hasAppCode(folder({ "index.html": "<p>hi</p>", "server.mjs": "" })), true);
    assert.equal(hasAppCode(folder({ "src/main.ts": "" })), true);
    assert.equal(hasAppCode(folder({ "manage.py": "" })), true);
    assert.equal(hasAppCode(folder({ "go.mod": "module x" })), true);
    assert.equal(hasAppCode(folder({ "Documents/notes.txt": "", "Downloads/a.zip": "", ".zshrc": "" })), false);
    assert.equal(hasAppCode(folder()), false);
  });
  it("never writes into a folder a run didn't make: its files and no marker", () => {
    const theirs = folder({ "notes.txt": "mine", "plan.md": "mine too" });
    assert.match(outInUse(theirs)!, /2 files that no contextmachines run wrote \(notes\.txt, plan\.md\)/);
    assert.match(outInUse(folder({ "a.txt": "" }))!, /a file that no/);
  });
  it("writes into a run's own folder, an older run's without the marker, an empty one, or none yet", () => {
    assert.equal(outInUse(folder({ ".contextmachines.json": "{}", "map.json": "{}", "anything-else.txt": "" })), undefined, "the marker");
    assert.equal(outInUse(folder({ "map.json": "{}", "FIX.md": "", "PRODUCT.md": "", "screens/home.jpg": "", ".gitignore": "" })), undefined, "only a run's own files");
    assert.equal(outInUse(folder({ ".session.json": "{}", ".gitignore": "" })), undefined, "a --login's session before its first run");
    assert.equal(outInUse(folder()), undefined, "empty");
    assert.equal(outInUse(folder({ "Thumbs.db": "", "desktop.ini": "", ".DS_Store": "" })), undefined, "only what a file browser leaves");
    assert.equal(outInUse(join(scratch, "not-there-yet")), undefined);
  });
});

/** A JPEG's first bytes with the frame header, enough for jpegSize: 390 wide, 844 high. */
const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("report.html: the fix list first", () => {
  const fixes: Fix[] = [
    item(1, { photo: "screens/fix-cut_off-1.jpg", at: "phone" }),
    item(2, { photo: "screens/notes.jpg", new: true, seenWith: "stand-in" }),
    { ...item(3), status: "predicted", from: "review", kind: "dead_end", title: "<img src=x onerror=alert(1)> stops here", fix: "Say what \"next\" does</textarea><script>alert(2)</script>", evidence: ['On /notes: "</li><script>alert(3)</script>"'], where: { file: "src/a\".ts", line: 4 } },
  ];
  const boxes = new Map([["cut_off-1", { boxes: [{ x: 39, y: 84.4, w: 195, h: 42.2 }], width: 390, height: 844 }], ["cut_off-2", { boxes: [{ x: 1, y: 1, w: 1, h: 1 }], width: 1280, height: 800 }]]);
  const page = reportPage(map(fixes), start, boxes);
  it("one card per item, in FIX.md's order and numbers, proven and predicted apart in the same words", () => {
    assert.deepEqual([...page.matchAll(/<article class="fix" id="fix-(\d+)">/g)].map((m) => m[1]), ["1", "2", "3"]);
    const doc = fixDoc(map(fixes), start);
    assert.match(doc, /### 3\. .*stops here/);
    const said = (words: string) => page.indexOf(`<p class="muted">${words}`);
    assert.ok(said("Proven: the browser saw or measured each of these.") < page.indexOf('id="fix-1"'));
    assert.ok(said("Predicted, not proven:") > page.indexOf('id="fix-2"') && said("Predicted, not proven:") < page.indexOf('id="fix-3"'));
    assert.ok(page.indexOf('id="fix-1"') < page.indexOf('<details id="screens">'), "the cards before the screens");
  });
  it("boxes the problem in red only where it was measured on that photo, at its place in the photo", () => {
    assert.equal(page.match(/class="box"/g)?.length, 1, "the screen's own photo of item 2 gets none, though a box was given");
    assert.match(page, /<span class="box" style="left:10\.00%;top:10\.00%;width:50\.00%;height:5\.00%"><\/span>/);
    assert.doesNotMatch(reportPage(map(fixes), start), /class="box"/, "none recorded, none drawn");
  });
  it("says where, with a copy button, what was seen and with whom, and the evidence", () => {
    assert.match(page, /<code class="path">src\/nav\.ts:1<\/code><button class="copy small" type="button" data-copy-text="src\/nav\.ts:1">Copy<\/button>/);
    assert.match(page, /<span class="muted">\(seen with a made-up user/);
    assert.match(page, /<span class="tag new">new<\/span>/);
    assert.match(page, /<dt>evidence<\/dt><dd><div>needs 71px and has 62px<\/div>/);
  });
  it("copies each item's own FIX.md section, and the whole of FIX.md from the top", () => {
    assert.match(page, /<textarea hidden id="fix-1-md">For a coding agent:[^\n]*\n\n### 1\. Label 1 cut off at laptop size\n\n- \*\*Where to change it:\*\* `src\/nav\.ts:1`/);
    assert.match(page, /data-copy="fix-all-md">Copy all for your coding agent/);
    assert.ok(page.includes(`<textarea hidden id="fix-all-md"># What to fix in`));
    assert.match(page, /navigator\.clipboard/);
    assert.match(page, /execCommand\("copy"\)/, "the fallback for a page opened from a file");
  });
  it("escapes everything from the site or an AI, in text, attributes and the copy boxes", () => {
    assert.doesNotMatch(page, /<img src=x/);
    assert.doesNotMatch(page, /<script>alert/);
    assert.doesNotMatch(page, /<\/textarea><script>/);
    assert.match(page, /data-copy-text="src\/a&quot;\.ts:4"/);
    assert.equal(page.match(/<script>/g)?.length, 1, "only the page's own copy script");
  });
  it("loads nothing from the web: no font, script, style or image from another host", () => {
    assert.doesNotMatch(page, /<link\b|@import|url\(|src="(?:https?:)?\/\//i);
    assert.doesNotMatch(page, /<script[^>]+src=/);
    assert.match(page, /prefers-color-scheme:dark/);
    assert.match(page, /max-width:700px/, "one column at phone width");
  });
  it("hands an item on with FIX.md's note to the agent, and its photo named from where the run was", () => {
    const card = page.slice(page.indexOf('id="fix-1-md">'), page.indexOf("</textarea>", page.indexOf('id="fix-1-md">')));
    const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    assert.ok(card.startsWith(`id="fix-1-md">${escaped(AGENT_WORDS)}\n\n### 1. `), card.slice(0, 200));
    assert.match(card, /- \*\*Photo:\*\* \[contextmachines\/screens\/fix-cut_off-1\.jpg\]\(contextmachines\/screens\/fix-cut_off-1\.jpg\)/);
    assert.match(reportPage(map(fixes), start, boxes, "out/run"), /\[out\/run\/screens\/fix-cut_off-1\.jpg\]/);
    const all = page.slice(page.indexOf('id="fix-all-md">'));
    assert.match(all, /\[contextmachines\/screens\/fix-cut_off-1\.jpg\]\(contextmachines\/screens\/fix-cut_off-1\.jpg\)/);
    assert.match(fixDoc(map(fixes), start), /^- \*\*Photo:\*\* \[screens\/fix-cut_off-1\.jpg\]\(screens\/fix-cut_off-1\.jpg\)$/m, "FIX.md itself as it was");
  });
  it("renames only the Photo lines it wrote when pasted, never words from the site", () => {
    const text = '- **Evidence:** On /a: "[screens/x.jpg](screens/x.jpg)"\n- **Photo:** [screens/fix-a.jpg](screens/fix-a.jpg)\n';
    assert.equal(forPasting(text, "cm"), '- **Evidence:** On /a: "[screens/x.jpg](screens/x.jpg)"\n- **Photo:** [cm/screens/fix-a.jpg](cm/screens/fix-a.jpg)\n');
  });
  it("draws a box only on the photo: cut to its edges, none for what's mostly off it", () => {
    const at = (b: { x: number; y: number; w: number; h: number }) => onPhoto({ boxes: [b], width: 390, height: 844 });
    assert.deepEqual(at({ x: 420, y: 300, w: 120, h: 40 }), [], "off to the right (what can't be reached is out there)");
    assert.deepEqual(at({ x: 20, y: 1500, w: 100, h: 40 }), [], "below the window");
    assert.deepEqual(at({ x: 350, y: 10, w: 60, h: 20 }), [{ x: 350, y: 10, w: 40, h: 20 }], "two thirds on: cut to the edge");
    assert.deepEqual(at({ x: 380, y: 10, w: 60, h: 20 }), [], "a sixth on: none");
    assert.deepEqual(at({ x: -10, y: -5, w: 100, h: 50 }), [{ x: 0, y: 0, w: 90, h: 45 }]);
    assert.deepEqual(onPhoto({ boxes: [{ x: 1, y: 1, w: 5, h: 5 }], width: 0, height: 844 }), []);
    const off = reportPage(map(fixes), start, new Map([["cut_off-1", { boxes: [{ x: 420, y: 300, w: 120, h: 40 }], width: 390, height: 844 }]]));
    assert.doesNotMatch(off, /class="box"/);
    assert.match(page, /\.shot\{position:relative;overflow:hidden;/, "and nothing drawn past the photo's edge");
  });
  it("with nothing to fix, says why and has no copy script", () => {
    const none = reportPage(map([]), start);
    assert.match(none, /Nothing to fix was found/);
    assert.doesNotMatch(none, /<script>/);
  });
  it("reads a JPEG's size from its frame header, for placing the box", () => {
    assert.deepEqual(jpegSize(jpeg(390, 844)), { width: 390, height: 844 });
    assert.equal(jpegSize(Buffer.from("not a jpeg")), undefined);
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8])), undefined);
  });
});

describe("report.html: raw but helpful", () => {
  const walked: ProductMap["journeyWalk"] = {
    status: "walked", message: "", legend: "Finished means the screens moved on.", limitSeconds: 120, seconds: 120, leftAlone: 0, looked: [],
    journeys: [
      { name: "Add a note", from: "/notes", seenWith: "stand-in", outcome: "finished", steps: [{ screen: "/notes", did: "open" }, { screen: "/notes", did: "press", label: "Add note" }] },
      { name: "Pay for more", from: "/plans", seenWith: "stand-in", outcome: "stopped_here", stop: { kind: "payment", label: "Pay now", byLabel: true }, steps: [{ screen: "/plans", did: "open" }, { screen: "/plans", did: "stop", label: "Pay now" }] },
    ] as NonNullable<ProductMap["journeyWalk"]>["journeys"],
    notFinished: ["Share a note"],
    notReached: [{ name: "Open a note", because: "it needs a record to exist", from: "/notes/:id" }],
  };
  const fixes: Fix[] = [item(1, { photo: "screens/fix-cut_off-1.jpg", at: "phone", new: true }), item(2, { seenWith: "stand-in" }), { ...item(3), status: "predicted", from: "review" }];
  const full = map(fixes, {
    learnedAt: "2026-03-04T12:00:00.000Z", product: "A notes app for a made-up team.", setupSteps: [{ action: "a", requires: "b" }], journeys: [{ name: "Write", screens: ["/notes"] }],
    findings: [{ kind: "request_fails", screen: "/notes", target: "GET /api/notes", evidence: "500", count: 1 }],
    journeyWalk: walked, sinceLast: { new: 1 },
    learner: { visited: 3, stoppedBy: "max_duration", savesStopped: 0, seconds: 95, measured: 2, review: { ran: false, why: "no-ai", screens: 0, raised: 0, kept: 0, dropped: {}, seconds: 0 }, standIn: { status: "reached", message: "", reached: 1, notReached: [{ path: "/admin", why: "no_access" }] } },
  });
  const page = reportPage(full, start);
  it("opens with one line of what ran, and one of the files it wrote, with no product blurb above the problems", () => {
    const head = page.slice(page.indexOf("<header>"), page.indexOf("</header>"));
    assert.match(head, /<h1><a href="http:\/\/localhost:3000\/">localhost:3000<\/a><\/h1><span class="run">2026-03-0\d \d\d:\d\d · 1m 35s · <b>3 problems: 2 proven, 1 predicted<\/b> · no AI<\/span>/);
    assert.match(head, /<div class="files"><a href="FIX\.md">FIX\.md<\/a> <a href="map\.json">map\.json<\/a> <a href="PRODUCT\.md">PRODUCT\.md<\/a> <a href="screens\/">screens\/<\/a> <span class="muted">1 screen · 4 journeys \(1 finished\)<\/span><\/div>/);
    assert.match(head, /no AI<\/span> <span class="gap">· stopped at the time limit \(--minutes\)<\/span>/, "a stop short is on the line itself");
    assert.ok(page.indexOf("A notes app") > page.indexOf('id="reference"'), "the product line is in the reference");
    assert.equal(problemWords(map([])), "no problems found");
  });
  it("goes header, problems, what it didn't check, the folded reference, the footer", () => {
    const at = ["<header>", 'id="problems"', 'id="fix-1"', 'id="not-checked"', 'id="reference"', 'id="screens"', 'id="journeys"', 'id="issues"', 'id="understood"', "<footer>"].map((s) => page.indexOf(s));
    assert.ok(at.every((n) => n >= 0), String(at));
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    assert.match(page, /<footer>Written by Context Machines v\d+\.\d+\.\d+[^<]* on 2026-03-04 · each run writes this page again\./);
  });
  it("filters by what the list holds, with FIX.md's counts, and new only when something is", () => {
    assert.match(page, /<button type="button" data-show="all" aria-pressed="true">All 3<\/button><button type="button" data-show="proven" aria-pressed="false">Proven 2<\/button><button type="button" data-show="predicted" aria-pressed="false">Predicted 1<\/button><button type="button" data-show="new" aria-pressed="false">New 1<\/button>/);
    assert.doesNotMatch(reportPage(map([item(1)]), start), /data-show="new"|data-show="predicted"/);
    assert.match(page, /<a class="num" href="#fix-1">#1<\/a><span class="tag proven">proven<\/span><span class="tag new">new<\/span><h3>/);
    assert.doesNotMatch(reportPage(map([item(1), item(2)]), start), /class="filters"/, "one kind: nothing to filter");
  });
  it("reads with scripts off: nothing starts hidden but the overlay and the copy boxes", () => {
    const tags = [...page.matchAll(/<([a-z]+)\b[^>]*\shidden[\s>]/g)].map((m) => m[0]);
    assert.ok(tags.every((t) => t.startsWith("<textarea hidden") || t.startsWith('<div id="zoom" hidden ')), tags.join(" "));
    assert.match(page, /html:not\(\.js\) \.filters,html:not\(\.js\) button\.copy\{display:none\}/, "controls that need the script aren't shown without it");
    assert.match(page, /<script>document\.documentElement\.classList\.add\("js"\)/);
    assert.match(page, /<a href="screens\/fix-cut_off-1\.jpg" target="_blank" data-zoom><img/, "a photo opens in a tab of its own without the script");
  });
  it("keeps who saw it beside an item seen with made-up data", () => {
    const card = page.slice(page.indexOf('id="fix-2"'), page.indexOf('id="fix-3"'));
    assert.match(card, /<span class="muted">\(seen with a made-up user: layout and wording are real, data isn't\)<\/span>/);
    assert.doesNotMatch(card, /made-up user \(seen with a made-up user/, "said once");
    const theirs = reportPage(map([item(1, { seenWith: "stand-in", newUser: true })]), start);
    assert.match(theirs, /<span class="muted">new user \(seen with a made-up user/);
  });
  it("folds the reference away, each part with its count", () => {
    assert.doesNotMatch(page, /<details[^>]* open/);
    assert.match(page, /<details id="screens"><summary>Screens <span class="count">\(1\)<\/span><\/summary>/);
    assert.match(page, /<details id="journeys"><summary>Journeys <span class="count">\(4\)<\/span><\/summary>/);
    assert.match(page, /<details id="issues"><summary>Issues found while exploring, not in the list <span class="count">\(1\)<\/span><\/summary>/);
    assert.match(page, /<details id="understood"><summary>What it understood <span class="count">/);
    assert.match(page, /Setup steps it depends on/);
    assert.match(page, /open <code>\/notes<\/code> → press "Add note"/, "a journey's steps");
  });
  it("says what it didn't check: screens it couldn't open, journeys that stopped, a limit, a review that didn't run", () => {
    const section = page.slice(page.indexOf('id="not-checked"'), page.indexOf('id="reference"'));
    assert.match(section, /<h2>What it didn't check<\/h2>/);
    assert.match(section, /Screens the made-up user couldn't open: <code>\/admin<\/code> <span class="muted">\(the app said no\)/);
    assert.match(section, /Journeys not walked to their end, of 4 found: 1 stopped at a step it won't take for you: a payment \(1\); 1 ran out of time; 1 couldn't be reached/);
    assert.match(section, /stopped at its time limit \(--minutes\)/);
    assert.match(section, /The AI didn't review the screens/);
    assert.match(section, /An image or file that fails may not show up here/);
  });
  it("escapes every trap from the site, and links nothing but the run's own files and the start", () => {
    const trap = "<script>alert(1)</script>\"'</textarea>";
    const nasty = map([{ ...item(1), title: trap, fix: trap, evidence: [trap], photo: "javascript:alert(1)", where: { file: `a${trap}.ts`, line: 2 } }], {
      product: trap, screens: [{ path: `/x${trap}`, title: trap, headings: [], photo: "https://elsewhere.example/a.jpg", views: [{ path: "/x#y", name: trap, photo: "javascript:alert(2)" }] }],
      journeyWalk: { ...walked, journeys: [{ ...walked.journeys[0]!, name: trap }] }, learner: { visited: 1, stoppedBy: "complete", savesStopped: 0, seconds: 1, standIn: { status: "reached", message: trap, reached: 0, notReached: [{ path: trap, why: trap as never }] } },
    });
    const html = reportPage(nasty, start);
    // The copy boxes hold FIX.md as it is, inert text: everywhere else nothing of the trap is live, or there at all as an address.
    const live = html.replace(/<textarea hidden id="[^"]+">[^<]*<\/textarea>/g, "");
    assert.doesNotMatch(html, /<script>alert|<\/textarea>"/);
    assert.doesNotMatch(live, /javascript:|elsewhere\.example/);
    assert.equal(html.match(/<script>/g)?.length, 1, "only the page's own");
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.match(href ?? "", /^(http:\/\/localhost:3000\/|FIX\.md|map\.json|PRODUCT\.md|screens\/[a-z0-9~_.-]*|#fix-\d+)$/, href ?? "");
  });
  it("loads nothing from the web, and has light and dark", () => {
    assert.doesNotMatch(page, /<link\b|@import|url\(|src="(?:https?:)?\/\//i);
    const live = page.replace(/<textarea hidden id="[^"]+">[^<]*<\/textarea>/g, "");
    assert.doesNotMatch(live.replace(/href="http:\/\/localhost:3000\/"/g, ""), /https?:\/\//, "no address but the start, outside FIX.md's own text in the copy boxes");
    assert.match(page, /color-scheme:light dark/);
    assert.match(page, /@media \(prefers-color-scheme:dark\)\{:root\{--bg:/);
    assert.match(page, /@media \(max-width:700px\)\{\.fix\{grid-template-columns:minmax\(0,1fr\)\}/, "one column at phone width");
  });
  it("counts the plain rules' predictions in the header and the filter, as the terminal does", () => {
    const prediction = { kind: "dead_end", screen: "/notes", why: "no way on" } as unknown as NonNullable<ProductMap["predictions"]>[number];
    const two = map([item(1)], { predictions: [prediction, prediction] });
    assert.equal(problemWords(two), "3 problems: 1 proven, 2 predicted (2 by a plain rule)");
    assert.equal(problemWords(map([], { predictions: [prediction] })), "1 problem: 1 predicted (1 by a plain rule)");
    const html = reportPage(two, start);
    assert.match(html, /data-show="all" aria-pressed="true">All 3<\/button><button type="button" data-show="proven" aria-pressed="false">Proven 1<\/button><button type="button" data-show="predicted" aria-pressed="false">Predicted 2<\/button>/);
    assert.match(html, /<div class="extra" data-only="predicted"><h3 class="sub">Might trip people up/, "the filter shows them under Predicted only");
  });
  it("gives each place its own copy, the line as it stands, and code evidence as code", () => {
    const html = reportPage(map([item(1, { where: { file: "src/a.ts", line: 3, code: "const label = `${n} notes`;", also: ["src/b.ts:9", "src/c.ts"] }, evidence: ["src/a.ts:3: if (!user.isPaid) return null;", "drawn on the page: \"1 notes\""], screens: ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"] })]), start);
    for (const place of ["src/a.ts:3", "src/b.ts:9", "src/c.ts"]) assert.match(html, new RegExp(`<code class="path">${place.replace(/[.]/g, "\\.")}</code><button class="copy small" type="button" data-copy-text="${place.replace(/[.]/g, "\\.")}">Copy</button>`));
    assert.match(html, /<div class="line" title="the line as it stands">const label = `\$\{n\} notes`;<\/div>/);
    assert.match(html, /<div class="line">src\/a\.ts:3: if \(!user\.isPaid\) return null;<\/div><div>drawn on the page/);
    assert.match(html, /<details class="more"><summary>and 2 more<\/summary><span class="item"><code class="path">\/g<\/code>,<\/span> <span class="item"><code class="path">\/h<\/code><\/span><\/details>/, "every screen it was seen on, a click away");
    assert.match(page, /<img src="screens\/fix-cut_off-1\.jpg" alt="[^"]*" width="390" height="844">/, "its size written in, so the page doesn't jump as it loads");
  });
  it("leaves out the issues the list already says, and groups the journeys by how they came out", () => {
    const finding = { kind: "request_fails", screen: "/notes", target: "GET /api/notes", evidence: "500", count: 1 } as NonNullable<ProductMap["findings"]>[number];
    const said = map([], { findings: [finding] });
    const title = (said.fixes = [{ ...item(1), from: "finding", kind: "request_fails", title: "" }], reportPage(said, start));
    assert.match(title, /<details id="issues">/, "words that differ aren't the same item");
    const fromIt = map([], { findings: [finding] });
    const words = /<td class="bad">([^<]*)<\/td>/.exec(reportPage({ ...fromIt, fixes: [item(2)] }, start))![1]!;
    fromIt.fixes = [{ ...item(1), from: "finding", kind: "request_fails", screen: "/notes", title: words.replace(/&quot;/g, '"').replace(/&amp;/g, "&") }];
    assert.doesNotMatch(reportPage(fromIt, start), /<details id="issues">/, "each issue is already in the list");
    const j = page.slice(page.indexOf('<details id="journeys">'), page.indexOf("</details>", page.indexOf('<details id="journeys">')));
    const groups = [...j.matchAll(/<h4><span class="tag \w+">([^<]+)<\/span> <span class="count">\((\d+)\)<\/span><\/h4>/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(groups, ["finished 1", "stopped 1", "not finished 1", "not reached 1"]);
    assert.match(j, /<li>at &quot;Pay now&quot;: &quot;Pay for more&quot; from \/plans/, "the stop named once, under its group");
    assert.match(j, /seen with a made-up user\. [^<]* This is what this run found, not every way through the app\./);
  });
  it("escapes the header's parts and the last run's items, whatever map.json says", () => {
    const trap = "<b><script>alert(4)</script>";
    const html = reportPage(map([item(1)], {
      learner: { visited: 1, stoppedBy: "complete", savesStopped: 0, seconds: 1, ai: { via: trap } as never },
      gone: [{ title: trap, status: '"><img src=x onerror=alert(1)>' as never }],
    }), start);
    assert.doesNotMatch(html, /<script>alert|<img src=x|<b><script>/);
    assert.match(html, /<span class="tag predicted">predicted<\/span> &lt;b&gt;&lt;script&gt;/, "a status it doesn't know is one of the two it does");
    assert.match(html, / · &lt;b&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt;<\/span>/);
  });
  it("with nothing to fix, says what was and wasn't looked at", () => {
    const none = reportPage(map([]), start);
    assert.match(none, /<h2>Problems<\/h2><p class="none">Nothing to fix was found in the 1 screen it measured, which doesn't mean there's nothing\./);
    assert.match(none, /no problems found/);
  });
});

describe("where a box comes from", () => {
  const proof = Buffer.from("photo at phone width");
  const listInput = (checks: ScreenCheck[]): Parameters<typeof buildFixes>[0] => ({ findings: [], checks, review: undefined, newUser: undefined, fromCode: undefined, sources: { files: [], tied: () => new Set<string>(), home: () => undefined }, screenOf: (p) => p, map: { journeys: [], mainAction: null, actions: [], screens: [] } });
  const cutAt = (target: string, more: Partial<ScreenCheck>): ScreenCheck => ({ kind: "cut_off", screen: "/a", screens: ["/a"], target, room: 62, at: "phone", evidence: "its text needs 70px and has 62px", ...more });
  it("is the measured place, kept only with the photo it was measured on", () => {
    const [one] = buildFixes(listInput([cutAt("Save", { box: { x: 1, y: 2, w: 3, h: 4 }, proof })]));
    assert.deepEqual(one!.boxes, [{ x: 1, y: 2, w: 3, h: 4 }]);
    const [none] = buildFixes(listInput([cutAt("Save", { box: { x: 1, y: 2, w: 3, h: 4 } })]));
    assert.equal(none!.boxes, undefined, "a desktop measurement has no photo of its own: no box on the screen's");
  });
  it("gathers the boxes of one cause measured on the same photo, and none from another photo", () => {
    const [merged] = buildFixes(listInput([cutAt("Save", { box: { x: 1, y: 1, w: 1, h: 1 }, proof }), cutAt("Send", { box: { x: 2, y: 2, w: 2, h: 2 }, proof }), cutAt("Share", { box: { x: 3, y: 3, w: 3, h: 3 }, proof: Buffer.from("another photo") })]));
    assert.deepEqual(merged!.boxes, [{ x: 1, y: 1, w: 1, h: 1 }, { x: 2, y: 2, w: 2, h: 2 }]);
  });
  it("is never kept for what can't be reached: it's off the photo by what it is", () => {
    const [off] = buildFixes(listInput([{ kind: "unreachable", screen: "/a", screens: ["/a"], target: "Export", at: "phone", evidence: "its centre is 40px past the right edge", box: { x: 420, y: 300, w: 120, h: 40 }, proof }]));
    assert.equal(off?.boxes, undefined);
  });
});
