// Setting up a project, checked without a browser, a real AI or a real terminal:
//   node --test cli/init.test.ts
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { AI_CHOICES } from "./ai.ts";
import { CONFIG_FILE, detectAi, detectUrl, readProjectConfig, runInit, type InitOptions, type Probes } from "./init.ts";
import { visibleWidth } from "./term.ts";
import { WORDMARK_MIN_COLUMNS, wordmark } from "./wordmark.ts";

const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"];
const ENTER = "\r";
const DOWN = "\x1b[B";
const SPACE = " ";
const CTRL_C = "\x03";

/** A stand-in for this machine: nothing signed in, no Ollama, a browser, and an app that answers. */
const NOTHING: Probes = {
  agentSignedIn: async () => false,
  ollamaRunning: async () => false,
  browserInstalled: async () => true,
  installBrowser: async () => true,
  reachable: async () => true,
  servesPage: async () => true,
  listeners: async () => [],
  startDev: async () => undefined,
};
const CLAUDE: Partial<Probes> = { agentSignedIn: async (command) => command === "claude" };

class Screen extends Writable {
  isTTY: boolean;
  columns: number;
  text = "";
  onText: () => void = () => {};
  constructor(isTTY: boolean, columns = 100) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
  }
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.text += chunk.toString();
    done();
    this.onText();
  }
  get plain(): string {
    return stripVTControlCharacters(this.text);
  }
}

/**
 * One run, answered the way a person would: each [question, keys] waits for its question on screen,
 * then presses the keys one at a time. A question that never comes fails the test by timing out.
 */
async function run(cwd: string, args: string[], script: [RegExp, string[]][] = [], options: { tty?: boolean; probes?: Partial<Probes>; learn?: InitOptions["learn"]; columns?: number } = {}) {
  const tty = options.tty ?? script.length > 0;
  const input = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  input.isTTY = tty;
  (input as unknown as { setRawMode: (on: boolean) => void }).setRawMode = () => {};
  const out = new Screen(tty, options.columns);
  const errors = new Screen(false);
  const steps = [...script];
  let looked = 0;
  out.onText = () => {
    const [question, keys] = steps[0] ?? [];
    if (!question || !keys) return;
    const fresh = out.plain.slice(looked);
    if (!question.test(fresh)) return;
    looked = out.plain.length;
    steps.shift();
    keys.forEach((key, i) => setTimeout(() => input.write(key), i + 1));
  };
  const code = await runInit(args, { cwd, input, output: out as unknown as NodeJS.WriteStream, errors: errors as unknown as NodeJS.WriteStream, probes: { ...NOTHING, ...options.probes }, ...(options.learn ? { learn: options.learn } : {}) });
  assert.deepEqual(steps.map(([q]) => q), [], "every question was asked");
  return { code, out: out.plain, errors: errors.plain };
}

/** Every file under a folder with what's in it, to prove nothing changed. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const name = relative(dir, path);
      if (entry.isDirectory()) walk(path);
      else files[name] = entry.isSymbolicLink() ? `-> ${readlinkSync(path)}` : readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

let dir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cm-init-"));
  for (const name of [...KEY_NAMES, "CI", "NO_COLOR", "FORCE_COLOR", "TERM"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const text = (name: string) => readFileSync(join(dir, name), "utf8");
const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

/** The prompts of a full run in a git repository, each answered with Enter (with a choice to make for the AI). */
const FULL: [RegExp, string[]][] = [
  [/◆  Where does your app run\?/, [ENTER]],
  [/◆  Which AI should read your product\?/, [ENTER]],
  [/◆  Let your AI read your code\?/, [ENTER]],
  [/◆  Give your coding agent the map\?/, [ENTER]],
  [/◆  Check every pull request\?/, [ENTER]],
  [/◆  Apply these changes\?/, [ENTER]],
];

describe("what it finds", () => {
  it("offers what's here in a fixed order: agents, keys, Ollama, then None", async () => {
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]) process.env[name] = "k";
    const found = await detectAi({ agentSignedIn: async () => true, ollamaRunning: async () => true });
    // Claude Code and Codex aren't offered on Windows yet (ai.ts).
    const agents = process.platform === "win32" ? [] : ["claude-code", "codex"];
    assert.deepEqual(found.map((o) => o.choice), [...agents, "anthropic", "openai", "google", "gateway", "openrouter", "ollama", "none"]);
    assert.ok(found.slice(0, -1).every((o) => o.hint === "found"));
    assert.equal(found.at(-1)!.hint, "screens, actions and issues only");
    assert.ok(found.every((o) => (AI_CHOICES as readonly string[]).includes(o.choice)), "every choice is one learn takes");
    if (agents.length) assert.equal(found[0]!.label, "Your Claude Code sign-in");
  });

  it("offers only what's really there", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    const found = await detectAi({ agentSignedIn: async (command) => command === "codex", ollamaRunning: async () => false });
    assert.deepEqual(found.map((o) => o.choice), [...(process.platform === "win32" ? [] : ["codex"]), "openrouter", "none"]);
  });

  it("doesn't call a key OpenAI's when OPENAI_BASE_URL sends it elsewhere", async () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENAI_BASE_URL = "http://localhost:1234/v1";
    assert.deepEqual((await detectAi(NOTHING)).map((o) => o.choice), ["none"]);
  });

  it("reads the address from package.json", () => {
    const pkg = (value: object) => write("package.json", JSON.stringify(value));
    assert.equal(detectUrl(dir).url, "http://localhost:3000");
    pkg({ scripts: { dev: "next dev -p 4100" } });
    assert.equal(detectUrl(dir).url, "http://localhost:4100");
    pkg({ scripts: { dev: "vite --port=8081" } });
    assert.equal(detectUrl(dir).url, "http://localhost:8081");
    pkg({ scripts: { dev: "PORT=7000 node server.js" } });
    assert.equal(detectUrl(dir).url, "http://localhost:7000");
    pkg({ scripts: { dev: "vite" } });
    assert.equal(detectUrl(dir).url, "http://localhost:5173");
    pkg({ scripts: { dev: "next dev" }, devDependencies: { vite: "1" } });
    assert.equal(detectUrl(dir).url, "http://localhost:3000");
    pkg({ scripts: { dev: "turbo dev" }, devDependencies: { vite: "1" } });
    assert.equal(detectUrl(dir).url, "http://localhost:5173");
    pkg({ scripts: { dev: "node server.js" } });
    assert.equal(detectUrl(dir).url, "http://localhost:3000");
    write("package.json", "{ not json");
    assert.equal(detectUrl(dir).url, "http://localhost:3000");
  });
});

describe("answering no", () => {
  it("writes nothing when Apply is answered no", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    mkdirSync(join(dir, ".git"));
    write("CLAUDE.md", "# Mine\n");
    const before = tree(dir);
    const { code, out } = await run(dir, [], [...FULL.slice(0, 5), [/◆  Apply these changes\?/, ["n"]]]);
    assert.equal(code, 0);
    assert.match(out, /Nothing was changed/);
    assert.deepEqual(tree(dir), before);
  });

  it("writes nothing on Ctrl-C at any prompt, and exits 130", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    mkdirSync(join(dir, ".git"));
    write("CLAUDE.md", "# Mine\n");
    const before = tree(dir);
    for (const [i, step] of FULL.entries()) {
      const script = [...FULL.slice(0, i), [step[0], [CTRL_C]] as [RegExp, string[]]];
      const { code, out } = await run(dir, [], script);
      assert.equal(code, 130, String(step[0]));
      assert.match(out, /Stopped; nothing was changed/);
      assert.deepEqual(tree(dir), before);
    }
  });

  it("lists every change before asking", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    mkdirSync(join(dir, ".git"));
    write("CLAUDE.md", "# Mine\n");
    const { out } = await run(dir, [], [...FULL.slice(0, 5), [/◆  Apply these changes\?/, ["n"]]]);
    const list = out.slice(out.indexOf("Changes:"));
    for (const line of [/create\s+contextmachines\.config\.json/, /edit\s+CLAUDE\.md/, /create\s+\.agents\/skills\/contextmachines\//, /link\s+\.claude\/skills\/contextmachines/, /create\s+\.gitignore/]) assert.match(list, line);
  });
});

describe("saying yes", () => {
  it("appends to CLAUDE.md and AGENTS.md instead of replacing them", async () => {
    write("CLAUDE.md", "# Mine\n\nKeep this.");
    write("AGENTS.md", "# Theirs\n");
    const { code } = await run(dir, ["--yes"]);
    assert.equal(code, 0);
    assert.equal(text("CLAUDE.md"), "# Mine\n\nKeep this.\n\n@contextmachines/PRODUCT.md\n");
    assert.equal(text("AGENTS.md"), "# Theirs\n\n@contextmachines/PRODUCT.md\n");
  });

  it("offers to create AGENTS.md only when neither file exists", async () => {
    const seen = await run(dir, ["--yes"]);
    assert.equal(seen.code, 0);
    assert.equal(text("AGENTS.md"), "@contextmachines/PRODUCT.md\n");
    assert.throws(() => text("CLAUDE.md"));
  });

  it("treats a link and an import as the one file they are", async () => {
    write("AGENTS.md", "# Rules\n");
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    await run(dir, ["--yes"]);
    assert.equal(text("AGENTS.md").match(/PRODUCT\.md/g)?.length, 1);
    rmSync(join(dir, "CLAUDE.md"));
    rmSync(join(dir, "AGENTS.md"));
    rmSync(join(dir, CONFIG_FILE));
    write("AGENTS.md", "# Rules\n");
    write("CLAUDE.md", "@AGENTS.md\n");
    await run(dir, ["--yes"]);
    assert.equal(text("CLAUDE.md"), "@AGENTS.md\n");
    assert.match(text("AGENTS.md"), /@contextmachines\/PRODUCT\.md/);
  });

  it("changes nothing on a second run, and says so", async () => {
    mkdirSync(join(dir, ".git"));
    write("CLAUDE.md", "# Mine\n");
    const first = await run(dir, ["--yes", "--url", "http://localhost:4000"]);
    assert.equal(first.code, 0);
    const before = tree(dir);
    const second = await run(dir, ["--yes"]);
    assert.equal(second.code, 0);
    assert.deepEqual(tree(dir), before);
    assert.match(second.out, /Nothing to change: this folder is already set up/);
    const third = await run(dir, [], [[/◆  Where does your app run\?/, [ENTER]], [/◆  Check every pull request\?/, [ENTER]]]);
    assert.equal(third.code, 0);
    assert.deepEqual(tree(dir), before);
    assert.match(third.out, /Nothing to change/);
  });

  it("keeps a saved AI as the answer even when its key isn't set in this shell", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    await run(dir, ["--yes"]);
    assert.equal(readProjectConfig(dir).ai, "anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    const before = tree(dir);
    assert.match((await run(dir, ["--yes"])).out, /Nothing to change/);
    assert.deepEqual(tree(dir), before);
  });

  it("installs the skill and links it for Claude Code, and leaves one that's there alone", async () => {
    await run(dir, ["--yes"]);
    assert.match(text(".agents/skills/contextmachines/SKILL.md"), /^---\r?\nname: contextmachines/);
    assert.ok(lstatSync(join(dir, ".claude/skills/contextmachines")).isSymbolicLink());
    // On Windows it's a junction, which always holds the full path.
    if (process.platform !== "win32") assert.equal(readlinkSync(join(dir, ".claude/skills/contextmachines")), "../../.agents/skills/contextmachines");
    assert.match(text(".claude/skills/contextmachines/SKILL.md"), /name: contextmachines/);
    write(".agents/skills/contextmachines/SKILL.md", "my own edits\n");
    await run(dir, ["--yes", "--url", "http://localhost:9000"]);
    assert.equal(text(".agents/skills/contextmachines/SKILL.md"), "my own edits\n");
  });

  it("adds the session file to .gitignore once, and only where git is in use", async () => {
    await run(dir, ["--yes"]);
    assert.throws(() => text(".gitignore"));
    mkdirSync(join(dir, ".git"));
    write(".gitignore", "node_modules");
    await run(dir, ["--yes"]);
    assert.equal(text(".gitignore"), "node_modules\ncontextmachines/.session.json\n");
    await run(dir, ["--yes", "--url", "http://localhost:9000"]);
    assert.equal(text(".gitignore"), "node_modules\ncontextmachines/.session.json\n");
    write(".gitignore", "contextmachines/\n");
    rmSync(join(dir, CONFIG_FILE));
    await run(dir, ["--yes"]);
    assert.equal(text(".gitignore"), "contextmachines/\n");
  });

  it("leaves the pull request check to a question, and only asks at a repository's top", async () => {
    assert.doesNotMatch((await run(dir, ["--yes"])).out, /Check every pull request/);
    mkdirSync(join(dir, ".git"));
    assert.match((await run(dir, ["--yes"])).out, /Check every pull request\?\n.*No/);
    assert.throws(() => text(".github/workflows/contextmachines.yml"), "--yes never adds a workflow with blanks in it");
    rmSync(join(dir, CONFIG_FILE));
    const { out } = await run(dir, [], [
      [/◆  Where does your app run\?/, [ENTER]],
      [/◆  Check every pull request\?/, ["y"]],
      [/◆  Apply these changes\?/, ["y"]],
    ]);
    const workflow = text(".github/workflows/contextmachines.yml");
    assert.match(workflow, /hughhellings\/contextmachines\/action@/);
    assert.doesNotMatch(workflow, /Copy to/);
    assert.match(out, /Then put your preview addresses in \.github\/workflows\/contextmachines\.yml/);
    assert.match((await run(dir, ["--yes"])).out, /Check every pull request\?\n.*Already set up/);
  });
});

describe("the config file", () => {
  it("holds the address and the AI, and no key from the environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-sentinel-do-not-store";
    process.env.OPENROUTER_API_KEY = "sk-or-sentinel-do-not-store";
    const { out, errors } = await run(dir, ["--yes", "--url", "localhost:4000"]);
    assert.deepEqual(JSON.parse(text(CONFIG_FILE)), { url: "http://localhost:4000", ai: "anthropic" });
    assert.doesNotMatch(JSON.stringify(tree(dir)), /sentinel/);
    assert.doesNotMatch(out + errors, /sentinel/);
  });

  it("refuses an address that holds a password or a token", async () => {
    for (const url of ["https://me:hunter2@app.test.example.com", "https://app.example.com/?x-vercel-protection-bypass=abc123def456", "https://app.example.com/?token=placeholder-value"]) {
      const { code, errors } = await run(dir, ["--yes", "--url", url]);
      assert.equal(code, 2, url);
      assert.match(errors, /sign-in or a token/);
      assert.deepEqual(tree(dir), {});
      assert.doesNotMatch(errors, /hunter2|abc123def456|placeholder-value/);
    }
    const typed = await run(dir, [], [[/◆  Where does your app run\?/, [..."https://me:hunter2@app.example.com", ENTER]], [/sign-in or a token/, [CTRL_C]]]);
    assert.equal(typed.code, 130);
    assert.deepEqual(tree(dir), {});
  });

  it("refuses something that isn't an address", async () => {
    const { code, errors } = await run(dir, ["--yes", "--url", "notaurl"]);
    assert.equal(code, 2);
    assert.match(errors, /isn't a web address/);
  });

  it("keeps a person's own keys, and leaves a broken file alone", async () => {
    write(CONFIG_FILE, `${JSON.stringify({ url: "http://localhost:1111", ai: "none", note: "mine" })}\n`);
    await run(dir, ["--yes", "--url", "http://localhost:2222"]);
    assert.deepEqual(JSON.parse(text(CONFIG_FILE)), { url: "http://localhost:2222", ai: "none", note: "mine" });
    write(CONFIG_FILE, "{ broken");
    const { code, out } = await run(dir, ["--yes"]);
    assert.equal(code, 0);
    assert.equal(text(CONFIG_FILE), "{ broken");
    assert.match(out, /isn't valid JSON: left as it is/);
    assert.match(out, /Next: npx contextmachines learn http:\/\/localhost:3000/);
    assert.throws(() => readProjectConfig(dir), /isn't valid JSON/);
  });

  it("reads as nothing saved when there's no file", () => {
    assert.deepEqual(readProjectConfig(dir), {});
  });

  it("reads a model saved beside the AI, and ignores an empty one", () => {
    write(CONFIG_FILE, JSON.stringify({ ai: "codex", model: " gpt-5 " }));
    assert.deepEqual(readProjectConfig(dir), { ai: "codex", model: "gpt-5" });
    write(CONFIG_FILE, JSON.stringify({ ai: "codex", model: "" }));
    assert.deepEqual(readProjectConfig(dir), { ai: "codex" });
  });
});

describe("without a person", () => {
  it("--yes works off a terminal, and asks nothing", async () => {
    write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    const { code, out } = await run(dir, ["--yes"], [], { tty: false, learn: () => assert.fail("--yes never starts a run"), probes: { browserInstalled: async () => false, installBrowser: async () => assert.fail("--yes never downloads") } });
    assert.equal(code, 0);
    assert.equal(readProjectConfig(dir).url, "http://localhost:5173");
    assert.equal(readProjectConfig(dir).ai, "none");
    assert.doesNotMatch(out, /\x1b/);
    assert.match(out, /Next: npx playwright\S* install chromium && npx contextmachines learn\n/);
  });

  it("off a terminal without --yes it says what to run in one line, and exits 2", async () => {
    const { code, out, errors } = await run(dir, [], [], { tty: false });
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.equal(errors.trim().split("\n").length, 1);
    assert.match(errors, /npx contextmachines init --yes --url http:\/\/localhost:3000/);
    assert.deepEqual(tree(dir), {});
  });

  it("refuses a flag it doesn't know, with the near one", async () => {
    const { code, errors } = await run(dir, ["--ur", "http://localhost:3000"]);
    assert.equal(code, 2);
    assert.match(errors, /Did you mean --url\?/);
  });

  it("prints its help", async () => {
    const { code, out } = await run(dir, ["--help"]);
    assert.equal(code, 0);
    assert.match(out, /--yes/);
    assert.deepEqual(tree(dir), {});
  });
});

describe("after the changes", () => {
  const ANSWERED: [RegExp, string[]][] = [
    [/◆  Where does your app run\?/, [ENTER]],
    [/◆  Give your coding agent the map\?/, [ENTER]],
    [/◆  Apply these changes\?/, [ENTER]],
  ];

  it("offers the browser, and installs it", async () => {
    let installs = 0;
    const { code, out } = await run(dir, [], [...ANSWERED, [/◆  No browser yet/, [ENTER]]], { probes: { browserInstalled: async () => false, installBrowser: async () => (installs++, true) } });
    assert.equal(code, 0);
    assert.equal(installs, 1);
    assert.match(out, /Browser installed/);
    assert.match(out, /Next: npx contextmachines learn\n/);
  });

  it("says the command when the download fails or is declined", async () => {
    const failed = await run(dir, [], [...ANSWERED, [/◆  No browser yet/, [ENTER]]], { probes: { browserInstalled: async () => false, installBrowser: async () => false } });
    assert.equal(failed.code, 0);
    assert.match(failed.out, /Try it yourself: npx playwright\S* install chromium/);
  });

  it("learns the app when asked, and hands back its exit code", async () => {
    const asked: string[] = [];
    const { code } = await run(dir, [], [...ANSWERED, [/◆  Learn your app now\?/, [ENTER]]], { learn: (url) => (asked.push(url), 3) });
    assert.equal(code, 3);
    assert.deepEqual(asked, ["http://localhost:3000"]);
  });

  it("doesn't start with yes when nothing answers at the address, and ends with the next command", async () => {
    const { code, out } = await run(dir, [], [[/Nothing's answering yet/, [DOWN, ENTER]], ...ANSWERED.slice(1), [/start your app first/, [ENTER]]], { learn: () => assert.fail("not asked for"), probes: { reachable: async () => false } });
    assert.equal(code, 0);
    assert.match(out, /Next: npx contextmachines learn\n/);
  });

  it("says the changes stay when stopped after they were made", async () => {
    const { code, out } = await run(dir, [], [...ANSWERED, [/◆  Learn your app now\?/, [CTRL_C]]], { learn: () => assert.fail("not asked for") });
    assert.equal(code, 130);
    assert.match(out, /The changes above stay/);
    assert.ok(readProjectConfig(dir).url);
  });

  // With only Claude Code signed in there is no AI to pick on Windows, where it isn't offered yet.
  it("picks the highlighted AI and the ticked items", { skip: process.platform === "win32" }, async () => {
    await run(dir, [], [
      [/◆  Where does your app run\?/, ["h", "t", "t", "p", ":", "/", "/", "l", "o", "c", "a", "l", "h", "o", "s", "t", ":", "4", "5", "6", "6", ENTER]],
      [/◆  Which AI should read your product\?/, [DOWN, ENTER]],
      [/◆  Give your coding agent the map\?/, [SPACE, ENTER]],
      [/◆  Apply these changes\?/, [ENTER]],
    ], { probes: CLAUDE });
    assert.deepEqual(readProjectConfig(dir), { url: "http://localhost:4566", ai: "none" });
    assert.throws(() => text("AGENTS.md"), "unticked");
    assert.match(text(".agents/skills/contextmachines/SKILL.md"), /contextmachines/);
  });
});

describe("fitting the terminal", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
  });
  const rows = (out: string) => out.split("\n").map((row) => row.replace(/^\x1b\[.*$/, ""));

  it("breaks a long warning over rows instead of cutting off what to do", async () => {
    write(CONFIG_FILE, "{ broken");
    const { out } = await run(dir, ["--yes"], [], { columns: 60 });
    assert.match(out.replace(/\n│\s+/g, " "), /isn't valid JSON: left as it is, so learn still needs an address/);
  });

  it("shows the whole reason an address was refused", async () => {
    const { out } = await run(dir, [], [[/◆  Where does your app run\?/, [..."https://me:hunter2@app.example.com", ENTER]], [/command line/, [CTRL_C]]], { columns: 80 });
    assert.match(out.replace(/\n│\s+/g, " "), /leave it out here, and give it to learn on the command line/);
  });

  it("marks the row Space will tick without relying on colour", async () => {
    const { out } = await run(dir, [], [[/◆  Where does your app run\?/, [ENTER]], [/◆  Which AI should read your product\?/, [ENTER]], [/Install the skill/, [DOWN]], [/Install the skill/, [CTRL_C]]]);
    assert.match(out, /› ■ Create AGENTS\.md/);
    assert.match(out, /› ■ Install the skill/);
  });

  it("keeps the end of a long address in view while it is typed", async () => {
    const tail = "/the-end-of-it";
    const { out } = await run(dir, [], [[/◆  Where does your app run\?/, [...`http://localhost:3000/${"a".repeat(90)}${tail}`]], [/the-end-of-it/, [CTRL_C]]], { columns: 80 });
    for (const row of rows(out)) assert.ok(visibleWidth(row) < 80, row);
  });

  it("keeps the Changes columns straight at 80, longest path included", async () => {
    mkdirSync(join(dir, ".git"));
    write("CLAUDE.md", "# Mine\n");
    const { out } = await run(dir, [], [...FULL.slice(0, 4), [/◆  Check every pull request\?/, ["y"]], [/◆  Apply these changes\?/, ["n"]]], { columns: 80 });
    const list = out.split("\n").filter((row) => /^│  (create|edit|link) /.test(row));
    assert.ok(list.length >= 5, out);
    assert.doesNotMatch(list.join("\n"), /…/);
    const whys = list.map((row) => /\S+\s+\S+\s+\S+\s+/.exec(row)![0].length);
    assert.equal(new Set(whys).size, 1, list.join("\n"));
    for (const row of list) assert.ok(visibleWidth(row) < 80, row);
    const narrow = await run(dir, [], [...FULL.slice(0, 4), [/◆  Check every pull request\?/, ["y"]], [/◆  Apply these changes\?/, ["n"]]], { columns: 50 });
    assert.match(narrow.out, /^│  create \.github\/workflows\/contextmachines\.yml$/m);
    assert.doesNotMatch(narrow.out, /^│  (create|edit|link) .*…$/m);
  });
});

describe("the wordmark", () => {
  const tty = (columns: number) => ({ isTTY: true, columns });
  const colour = {} as NodeJS.ProcessEnv;

  it("fits, down to the narrowest width that gets it", () => {
    const mark = wordmark(tty(WORDMARK_MIN_COLUMNS), colour);
    assert.ok(mark.split("\n").length > 5, "the drawn mark");
    assert.ok(/[█▀▄]/.test(mark));
    for (const line of mark.split("\n")) assert.ok(visibleWidth(line) <= WORDMARK_MIN_COLUMNS, line);
    assert.ok(WORDMARK_MIN_COLUMNS <= 80);
  });

  it("is plain bold text in a narrow terminal", () => {
    const narrow = wordmark(tty(WORDMARK_MIN_COLUMNS - 1), colour);
    assert.equal(stripVTControlCharacters(narrow), "Context Machines");
    assert.match(narrow, /\x1b\[1m/);
  });

  it("is plain text with NO_COLOR or off a terminal", () => {
    assert.equal(wordmark(tty(100), { NO_COLOR: "1" }), "Context Machines");
    assert.equal(wordmark({ isTTY: false, columns: 100 }, colour), "Context Machines");
    assert.equal(wordmark({ isTTY: false, columns: 100 }, { FORCE_COLOR: "1" }).replace(/\x1b\[\d+m/g, ""), "Context Machines");
  });
});

describe("finding the app by itself", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
    write("package.json", JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "1" }, dependencies: { "@supabase/supabase-js": "2" } }));
  });
  const server = (url: string) => ({ url, stop: async () => void stopped.push(url) });
  const REST: [RegExp, string[]][] = [[/◆  Which AI should read your product\?/, [ENTER]], [/◆  Give your coding agent the map\?/, [ENTER]]];
  let stopped: string[] = [];
  beforeEach(() => {
    stopped = [];
  });

  it("says what it found, and how far a stand-in user can go", async () => {
    const { out } = await run(dir, ["--yes", "--url", "localhost:4000"], [], { columns: 120 });
    assert.match(out, /Found your project/);
    assert.match(out, /Vite, starts with npm run dev/);
    assert.match(out, /Sign-in: Supabase, in the browser\. A stand-in user with made-up data should be able to walk it/);
  });

  it("offers the server running from this folder, not the framework's default", async () => {
    const { out } = await run(dir, [], [[/running from this folder/, [ENTER]], ...REST, [/◆  Apply these changes\?/, ["y"]]], { probes: { listeners: async () => [{ port: 5175, cwd: dir }] } });
    assert.equal(JSON.parse(text(CONFIG_FILE)).url, "http://localhost:5175", out);
  });

  it("takes no address from a server that runs from another folder, however alike it looks", async () => {
    const { code, out } = await run(dir, [], [[/Start your app with npm run dev/, [CTRL_C]]], { probes: { listeners: async () => [{ port: 5173, cwd: tmpdir() }], reachable: async () => true } });
    assert.equal(code, 130);
    assert.doesNotMatch(out, /Where does your app run/);
  });

  it("never lets Enter land on a dead address", async () => {
    write(CONFIG_FILE, JSON.stringify({ url: "http://localhost:4999" }));
    const { out } = await run(dir, [], [[/Start your app with/, ["n"]], [/Nothing's answering yet/, [ENTER]], [/Type the address/, [ENTER]], [/Nothing answers at http:\/\/localhost:4999/, [..."http://localhost:4111"]], [/localhost:4111/, [ENTER]], [/Press Enter to keep it/, [ENTER]], ...REST, [/◆  Apply these changes\?/, ["n"]]], {
      probes: { reachable: async () => false },
    });
    assert.match(out, /Nothing answers at http:\/\/localhost:4999\. Type where your app runs/);
  });

  it("starts the app on one yes, uses the address it really came up on, and stops it at the end", async () => {
    let starts = 0;
    let up = false;
    const { code } = await run(dir, [], [[/Start your app with npm run dev/, [ENTER]], ...REST, [/◆  Apply these changes\?/, ["y"]], [/◆  Learn your app now\?/, [ENTER]]], {
      probes: { reachable: async () => up, startDev: async () => ((starts++, (up = true)), server("http://localhost:5199")) },
      learn: (url) => {
        assert.equal(url, "http://localhost:5199");
        assert.deepEqual(stopped, [], "still running while it learns");
      },
    });
    assert.equal(code, 0);
    assert.equal(starts, 1);
    assert.deepEqual(stopped, ["http://localhost:5199"]);
  });

  it("stops what it started if setup is stopped", async () => {
    const { code } = await run(dir, [], [[/Start your app/, [ENTER]], ...REST, [/◆  Apply these changes\?/, [CTRL_C]]], { probes: { reachable: async () => false, startDev: async () => server("http://localhost:5199") } });
    assert.equal(code, 130);
    assert.deepEqual(stopped, ["http://localhost:5199"]);
  });

  it("says a dev command that didn't come up, and still asks where the app is", async () => {
    const { out } = await run(dir, [], [[/Start your app/, [ENTER]], [/Nothing's answering yet/, [CTRL_C]]], { probes: { reachable: async () => false, startDev: async () => undefined } });
    assert.match(out, /npm run dev was stopped/);
    assert.match(out, /may have started on a[\s│]+port/);
    assert.doesNotMatch(out, /didn't answer/); // an app that picked its own port did start
  });

  it("never starts anything under --yes, since that runs project code", async () => {
    const { code, out } = await run(dir, ["--yes"], [], { probes: { reachable: async () => false, startDev: async () => assert.fail("--yes started the app") } });
    assert.equal(code, 0);
    assert.match(out, /Nothing answers there yet/);
  });
});

describe("a folder with no git", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
  });
  const pkg = (dep: string) => write("package.json", JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "1", [dep]: "1" } }));

  it("promises nothing about reading code, and says once what that needs", async () => {
    for (const dep of ["@clerk/clerk-react", "next-auth"]) {
      pkg(dep);
      const { out } = await run(dir, ["--yes"]);
      assert.doesNotMatch(out, /reading your code[\s│]+still/, dep);
      assert.equal(out.match(/needs a git repository/g)?.length, 1, dep);
    }
  });

  it("keeps the promise where the code can be read", async () => {
    mkdirSync(join(dir, ".git"));
    pkg("next-auth");
    const { out } = await run(dir, ["--yes"]);
    assert.match(out, /reading your code[\s│]+still can/);
    assert.doesNotMatch(out, /needs a git repository/);
  });

  it("says nothing of code with no AI to read it", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    pkg("@clerk/clerk-react");
    const { out } = await run(dir, ["--yes"], [], { probes: { agentSignedIn: async () => false, ollamaRunning: async () => false } });
    assert.doesNotMatch(out, /git repository/);
  });
});

describe("the question about code", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "k";
    mkdirSync(join(dir, ".git"));
  });

  it("is a yes by default, saved as readCode", async () => {
    const { out } = await run(dir, [], FULL);
    assert.equal(JSON.parse(text(CONFIG_FILE)).readCode, true);
    assert.match(out, /Source files/);
  });

  it("can be answered no", async () => {
    await run(dir, [], [...FULL.slice(0, 2), [/◆  Let your AI read your code\?/, ["n"]], ...FULL.slice(3)]);
    assert.equal(JSON.parse(text(CONFIG_FILE)).readCode, false);
  });

  it("isn't answered yes by --yes: source code leaving takes a real yes", async () => {
    const { out } = await run(dir, ["--yes"]);
    assert.match(out, /No: it takes a yes/);
    assert.equal(JSON.parse(text(CONFIG_FILE)).readCode, undefined);
  });

  it("keeps a yes given earlier under --yes", async () => {
    write(CONFIG_FILE, JSON.stringify({ url: "http://localhost:3000", ai: "anthropic", readCode: true }));
    assert.match((await run(dir, ["--yes"])).out, /Yes, as you said before/);
    assert.equal(JSON.parse(text(CONFIG_FILE)).readCode, true);
  });

  it("isn't asked with no AI, or outside a repository", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.doesNotMatch((await run(dir, ["--yes"])).out, /read your code/);
    process.env.ANTHROPIC_API_KEY = "k";
    rmSync(join(dir, ".git"), { recursive: true });
    assert.doesNotMatch((await run(dir, ["--yes"])).out, /read your code/);
  });

  it("says not yet for Ollama", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { out } = await run(dir, ["--yes"], [], { probes: { ollamaRunning: async () => true } });
    assert.match(out, /Not yet with Ollama/);
  });
});

describe("an app from another folder on the same port", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cm-clash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --port 5301" }, devDependencies: { vite: "^5" } }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const probes = { listeners: async () => [{ port: 5301, cwd: "/somewhere/else" }] };

  it("isn't called this app, and learning it isn't the default", async () => {
    const asked: string[] = [];
    const { out } = await run(dir, ["--url", "http://localhost:5301"], [[/◆  Give your coding agent the map\?/, [ENTER]], [/◆  Apply these changes\?/, [ENTER]], [/◆  Learn your app now\?/, [ENTER]]], { probes, learn: (url) => (asked.push(url), 3) });
    assert.match(out, /That's another folder's app at .*localhost:5301/);
    assert.deepEqual(asked, []);
  });

  it("under --yes isn't said to be nothing", async () => {
    const { out } = await run(dir, ["--yes"], [], { probes });
    assert.doesNotMatch(out, /Nothing answers there yet/);
    assert.match(out, /Another folder's app is on that port/);
  });
});
