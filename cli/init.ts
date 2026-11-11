/**
 * `npx contextmachines init`: a short guided setup for one project. It works the project out from
 * the folder (project.ts): which app, how it starts, where it's running, how people sign in. It asks
 * which AI to use and whether that AI may read the code, offers to give the coding agent the map,
 * says exactly which files it will touch, and touches nothing until the person says yes. Everything
 * it asks is answered by what is already on this machine, so most people press Enter a few times. It
 * never asks for a key and never stores one.
 *
 * The prompts are drawn here rather than with a prompt library: the CLI has no such dependency, and
 * these few take little code on top of Node's own key parsing.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, appendFileSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentEnv, AI_CHOICES, pickAi } from "./ai.ts";
import { DEFAULT_URL, detectProject, listeners, notFoundWords, repoRootOf, servesPage, standInExpected, startDev, type Listener, type Project, type Started } from "./project.ts";
import { publicUrl, startUrl } from "./report.ts";
import { colors, colorWanted, columnsOf, fit, LiveRow, padTo, safe, suggest, wrapTo, type Colors } from "./term.ts";
import { wordmark } from "./wordmark.ts";

/** The project's saved answers: the address and the AI, so plain `learn` needs neither. Never a secret. */
export const CONFIG_FILE = "contextmachines.config.json";

const IMPORT_LINE = "@contextmachines/PRODUCT.md";
const SESSION_LINE = "contextmachines/.session.json";
const WORKFLOW = ".github/workflows/contextmachines.yml";
const SKILL_HOME = ".agents/skills/contextmachines";
const SKILL_LINK = ".claude/skills/contextmachines";
const LEARN = "npx contextmachines learn";
/** How init ends, in the CLI's own table: Ctrl-C at a prompt, wrong words, and a file it couldn't write. */
const EXIT = { done: 0, usage: 2, couldNot: 3, interrupted: 130 } as const;

/** What init does, its options and its exit codes: the command's help lays them out as it does every command's (see InitOptions.help). */
export const INIT_ABOUT = "Sets up this folder: it finds your app and where it runs, then asks which AI reads it, whether that AI may read your code, about the map for your coding agent, and about a check on every pull request. It shows every file it will touch and asks before writing any. If your app isn't running it offers to start your dev command, with one yes, and stops it again when it's done.";
export const INIT_OPTIONS: [string, string][] = [
  ["--url <address>", "where your app runs (default: worked out from this folder)"],
  ["-y, --yes", "take the defaults without asking: no pull request check, no download, no run, no starting your app, and no reading your code (each of those needs a real yes)"],
  ["-h, --help", "show this help"],
];
export const INIT_EXIT_MEANINGS: [number, string][] = [
  [EXIT.done, "set up, already set up, or you answered no"],
  [EXIT.usage, "you typed something wrong, or there's no terminal to ask in and no --yes"],
  [EXIT.couldNot, "a file couldn't be written"],
  [EXIT.interrupted, "stopped with Ctrl-C"],
];
/** The same, as plain text, for a caller that has no help of its own to lay it out with. */
const USAGE = [
  "Usage: npx contextmachines init [--yes] [--url <address>]", "", INIT_ABOUT, "",
  "Options:", ...INIT_OPTIONS.map(([flag, help]) => `  ${flag.padEnd(16)} ${help}`), "",
  "Exit codes:", ...INIT_EXIT_MEANINGS.map(([code, meaning]) => `  ${String(code).padEnd(4)} ${meaning}`), "",
].join("\n");

export interface ProjectConfig {
  url?: string;
  ai?: string;
  /** The model that AI uses, as --model takes it: for a plan that can't use the AI's own default. */
  model?: string;
  /** The person said yes to their chosen AI reading their code, at a sign-in, on their local address. */
  readCode?: boolean;
  /** The app's folder, when it isn't the one init ran in. */
  app?: string;
}

/**
 * What an earlier `init` saved here, for `learn` to fall back on. Nothing saved is an empty answer; a
 * file that can't be read is an error, since quietly ignoring it would learn the wrong thing.
 */
export function readProjectConfig(dir: string = process.cwd()): ProjectConfig {
  const text = readText(join(dir, CONFIG_FILE));
  if (text === undefined) return {};
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error(`${CONFIG_FILE} isn't valid JSON`);
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(`${CONFIG_FILE} should be a JSON object`);
  const { url, ai, model, readCode, app } = saved as Record<string, unknown>;
  return { ...(typeof url === "string" ? { url } : {}), ...(typeof ai === "string" ? { ai } : {}), ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}), ...(typeof readCode === "boolean" ? { readCode } : {}), ...(typeof app === "string" ? { app } : {}) };
}

/** A new address for the project: only that key changes, and a file that can't be read is left alone. */
export function saveAddress(dir: string, url: string): void {
  try {
    const saved = JSON.parse(readText(join(dir, CONFIG_FILE)) ?? "null") as Record<string, unknown> | null;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) writeFileSync(join(dir, CONFIG_FILE), `${JSON.stringify({ ...saved, url }, null, 2)}\n`);
  } catch {
    // nothing readable to change: the next run just asks again
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** True for anything at that path, a broken link included: existsSync follows links, and this must not. */
function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// What is already here: the AI, the things to install from (and the project: see project.ts).

export { detectUrl } from "./project.ts";

/** What is checked on this machine: the outside world, kept apart so tests can stand in for it. */
export interface Probes {
  /** Whether that coding agent is installed and signed in. */
  agentSignedIn: (command: "claude" | "codex") => Promise<boolean>;
  ollamaRunning: () => Promise<boolean>;
  browserInstalled: () => Promise<boolean>;
  /** Downloads the browser; false if it failed. Stopped by the signal. */
  installBrowser: (stop: AbortSignal) => Promise<boolean>;
  /** Whether anything answers at that address yet. */
  reachable: (url: string) => Promise<boolean>;
  /** Whether what answers there is a web page, not an API or a database. */
  servesPage: (url: string) => Promise<boolean>;
  /** What's listening on this machine, and from which folder. */
  listeners: () => Promise<Listener[]>;
  /** Runs the project's dev command, after a yes. Undefined when it didn't come up. */
  startDev: (project: Project, stop: AbortSignal) => Promise<Started | undefined>;
}

/** Each agent's own way of saying whether it is signed in: by its exit code, so nothing it prints is read. */
const SIGNED_IN: Record<"claude" | "codex", string[]> = { claude: ["auth", "status"], codex: ["login", "status"] };

const LIVE_PROBES: Probes = {
  agentSignedIn: (command) =>
    new Promise((done) => {
      // Run the way ai.ts runs them: away from this project, with no credential they don't need, and
      // Claude Code's telemetry, update check and error reports off, as on every ask.
      const env = command === "claude" ? { ...agentEnv(command), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : agentEnv(command);
      const child = spawn(command, SIGNED_IN[command], { cwd: tmpdir(), env, stdio: "ignore", timeout: 8000 });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    }),
  ollamaRunning: () =>
    fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(800) }).then(
      (res) => res.ok,
      () => false,
    ),
  browserInstalled: async () => {
    try {
      const { chromium } = await import("playwright");
      return existsSync(chromium.executablePath());
    } catch {
      return false;
    }
  },
  installBrowser: (stop) =>
    new Promise((done) => {
      // Playwright's own installer, from the copy this runs with, by Node: not through npx, which under
      // `npx contextmachines` inherits that npx's npm_config_call and runs contextmachines again.
      const cli = playwrightCli();
      if (!cli) return done(false);
      const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "ignore", signal: stop });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
    }),
  reachable: (url) =>
    fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(1500) }).then(
      () => true,
      () => false,
    ),
  servesPage,
  listeners,
  startDev: (project, stop) => startDev(project, LIVE_PROBES.reachable, stop),
};

/** The command line of the Playwright this runs with, which downloads the browser that copy can use. */
function playwrightCli(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("playwright/package.json");
    const bin = (require(manifest) as { bin?: Record<string, string> }).bin?.playwright ?? "cli.js";
    return join(dirname(manifest), bin);
  } catch {
    return undefined;
  }
}

/** The download for the Playwright this runs with: a bare `npx playwright` may fetch another version, whose browser this one can't use. */
export function browserCommand(): string {
  let version = "";
  try {
    version = `@${(createRequire(import.meta.url)("playwright/package.json") as { version: string }).version}`;
  } catch {
    // not found: the plain command is still the right advice
  }
  return `npx playwright${version} install chromium`;
}

/** Whether the browser is there, and its download: for learn, which asks for it as init does. */
export const browserInstalled = (): Promise<boolean> => LIVE_PROBES.browserInstalled();
export const installBrowser = (stop: AbortSignal): Promise<boolean> => LIVE_PROBES.installBrowser(stop);

export interface AiOption {
  /** What `--ai` takes, so that the choice saved here is one `learn` understands. */
  choice: string;
  label: string;
  hint: string;
}

/** The order they are offered in: what costs nothing more (a subscription) ahead of what bills per use. */
const AI_ORDER = ["claude-code", "codex", "anthropic", "openai", "google", "gateway", "openrouter", "ollama"] as const;
const NO_AI: AiOption = { choice: "none", label: "None", hint: "screens, actions and issues only" };

/**
 * What can read the product on this machine, best first, always ending in None. ai.ts decides whether
 * a key is there and what each one is called, by being asked for it, so this list can't drift from
 * what `learn` will do. ai.ts takes a coding agent or Ollama on trust until they are used, and those
 * have to be seen working here. An OPENAI_BASE_URL sends that key to another server, which needs a
 * --model this setup doesn't ask for, so the key isn't offered as OpenAI's own.
 */
export async function detectAi(probes: Pick<Probes, "agentSignedIn" | "ollamaRunning"> = LIVE_PROBES): Promise<AiOption[]> {
  const usable = (choice: (typeof AI_ORDER)[number]): Promise<boolean> | boolean => {
    if (choice === "claude-code") return probes.agentSignedIn("claude");
    if (choice === "codex") return probes.agentSignedIn("codex");
    if (choice === "ollama") return probes.ollamaRunning();
    return choice !== "openai" || !process.env.OPENAI_BASE_URL;
  };
  const found = await Promise.all(
    AI_ORDER.map(async (choice) => {
      try {
        const ai = pickAi(choice, undefined);
        if (!ai || !(await usable(choice))) return undefined;
        return { choice, label: `${ai.via[0]!.toUpperCase()}${ai.via.slice(1)}`, hint: "found" };
      } catch {
        return undefined; // ai.ts's way of saying it isn't available here
      }
    }),
  );
  return [...found.filter((option) => option !== undefined), NO_AI];
}

/**
 * Something to install, wherever this file is running from: beside the bundle in the npm package, or
 * in the repository. Nothing found means the offer isn't made, rather than a setup failing halfway.
 */
function shippedFile(...places: string[]): string | undefined {
  return places.map((place) => fileURLToPath(new URL(place, import.meta.url))).find((path) => existsSync(path));
}
const skillSource = () => shippedFile("./skills/contextmachines/SKILL.md", "../skills/contextmachines/SKILL.md");
const workflowSource = () => shippedFile("./examples/github-action/contextmachines.yml", "../examples/github-action/contextmachines.yml");

// ---------------------------------------------------------------------------------------------
// The rail: every step hangs off one vertical line, the current one drawn live.

const RAIL = "│";
type Paint = (text: string) => string;
const plain: Paint = (text) => text;
/** Ctrl-C at a prompt, wherever it was: one way out, so nothing can run on past it. */
class Stopped extends Error {}

interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** The terminal for one run, plain lines and live questions alike. */
class Rail {
  readonly c: Colors;
  private readonly input: NodeJS.ReadStream;
  private readonly out: NodeJS.WriteStream;

  constructor(input: NodeJS.ReadStream, out: NodeJS.WriteStream) {
    this.input = input;
    this.out = out;
    this.c = colors(colorWanted(out));
  }

  get columns(): number {
    return columnsOf(this.out);
  }

  /** One row, cut to the width: a row that wrapped couldn't be counted and erased. */
  private row(text: string): string {
    return fit(text, this.columns - 1);
  }

  print(text = ""): void {
    this.out.write(`${this.row(text)}\n`);
  }

  /** A live row on the rail, for something that takes a while. */
  spinner(status: (frame: string) => string): LiveRow {
    return new LiveRow(this.out, (frame) => `${this.c.dim(RAIL)}  ${status(frame)}`);
  }

  /** Words broken to fit beside the rail, since a warning or a way out is no use with its end cut off. */
  private fold(text: string): string[] {
    return wrapTo(text, this.columns - 4);
  }

  /** A line on the rail, set exactly as given: the Changes list's columns depend on that. */
  note(text = ""): void {
    this.print(text ? `${this.c.dim(RAIL)}  ${text}` : this.c.dim(RAIL));
  }

  /** Words on the rail, over as many rows as they need. */
  say(text: string, paint: Paint = plain): void {
    for (const line of this.fold(text)) this.note(paint(line));
  }

  /** A step that's over: its question with a hollow marker, its answer (and any word on it) dim under it. */
  answered(question: string, ...answer: string[]): void {
    this.print(`${this.c.green("◇")}  ${question}`);
    for (const line of answer) this.say(line, this.c.dim);
    this.note();
  }

  /** The end of the rail. A long ending carries on under itself. */
  end(text: string, paint: Paint = plain): void {
    this.fold(text).forEach((line, i) => this.print(`${i ? " " : this.c.dim("└")}  ${paint(line)}`));
  }

  /**
   * A live question: painted, repainted after each key, and erased when answered, so that only the
   * dim answer stays. Keys come through Node's own parser, which tells an arrow from a lone Esc.
   * `press` returns the answer once there is one. Ctrl-C, Ctrl-D and Esc all stop the run, and a
   * signal from outside does the same, so the terminal is never left with its cursor hidden.
   */
  private live<T>(question: string, body: () => string[], press: (key: Key) => T | undefined): Promise<T> {
    const { input, out, c } = this;
    return new Promise((resolve, reject) => {
      let rows = 0;
      const paint = () => {
        const lines = [`${c.cyan("◆")}  ${question}`, ...body().map((line) => `${c.cyan(RAIL)}  ${line}`), c.cyan("└")].map((line) => this.row(line));
        out.write(`\x1b[?2026h${this.erase(rows)}${lines.join("\n")}\x1b[?2026l`);
        rows = lines.length;
      };
      const finish = () => {
        input.off("keypress", onKey);
        input.off("end", onStop);
        process.off("SIGINT", onStop);
        process.off("SIGTERM", onStop);
        input.setRawMode?.(false);
        input.pause();
        out.write(`${this.erase(rows)}\x1b[?25h`);
      };
      const onStop = () => {
        finish();
        this.print(`${c.red("■")}  ${question}`);
        this.note();
        reject(new Stopped());
      };
      const onKey = (_text: string | undefined, key: Key) => {
        if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) return onStop();
        const answer = press(key);
        if (answer === undefined) return paint();
        finish();
        resolve(answer);
      };
      emitKeypressEvents(input);
      input.on("keypress", onKey);
      input.on("end", onStop);
      process.on("SIGINT", onStop);
      process.on("SIGTERM", onStop);
      input.setRawMode?.(true);
      input.resume();
      out.write("\x1b[?25l");
      paint();
    });
  }

  /** Back to the start of a block of rows, and clear it. */
  private erase(rows: number): string {
    if (rows === 0) return "";
    return `\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[J`;
  }

  /** A typed answer. Enter alone takes the suggestion, which is why it is shown in place of the answer. */
  async text(question: string, suggestion: string, hint: string | undefined, check: (typed: string) => string | undefined, answers?: (value: string) => Promise<boolean>): Promise<string> {
    const { c } = this;
    let typed = "";
    let at = 0;
    let problem = "";
    let refused: string | undefined;
    const caret = (char: string) => `\x1b[7m${char}\x1b[27m`;
    // An address too long for its row slides left, so the end being typed stays in view.
    const field = () => {
      const room = this.columns - 5;
      const from = Math.max(0, at + 1 - room);
      const shown = typed.slice(from, from + room);
      const here = at - from;
      return `${shown.slice(0, here)}${caret(shown[here] ?? " ")}${shown.slice(here + 1)}`;
    };
    // A live question can only wait on keys, so whether the address answers is told as it goes round again.
    for (;;) {
      const answer = await this.live(
        question,
        () => [typed ? field() : `${caret(suggestion[0]!)}${c.dim(suggestion.slice(1))}`, ...(problem ? this.fold(problem).map(c.yellow) : hint ? this.fold(hint).map(c.dim) : [])],
        (key) => {
          if (key.name === "return" || key.name === "enter") {
            const value = typed.trim() || suggestion;
            problem = check(value) ?? "";
            return problem ? undefined : value;
          }
          problem = "";
          if (key.name === "left") at = Math.max(0, at - 1);
          else if (key.name === "right") at = Math.min(typed.length, at + 1);
          else if (key.name === "backspace" && at > 0) {
            typed = `${typed.slice(0, at - 1)}${typed.slice(at)}`;
            at--;
          } else if (key.ctrl && key.name === "u") {
            typed = "";
            at = 0;
          } else if (!key.ctrl && !key.meta && key.sequence && /^[^\u0000-\u001f\u007f]+$/u.test(key.sequence)) {
            typed = `${typed.slice(0, at)}${key.sequence}${typed.slice(at)}`;
            at += key.sequence.length;
          }
          return undefined;
        },
      );
      // An address typed twice is meant, whether it answers yet or not. One that was only offered never gets through dead.
      if (!answers || answer === refused || (await answers(answer))) {
        this.answered(question, answer);
        return answer;
      }
      if (typed.trim()) refused = answer;
      problem = typed.trim() ? `Nothing answers at ${safe(answer)}. Press Enter to keep it anyway, or type where your app runs.` : `Nothing answers at ${safe(answer)}. Type where your app runs.`;
    }
  }

  /** One of a list. */
  async select<T>(question: string, options: readonly { value: T; label: string; hint?: string }[], initial = 0): Promise<T> {
    const { c } = this;
    let at = initial;
    const choice = await this.live(
      question,
      () => [
        ...options.map((option, i) => `${i === at ? `${c.cyan("●")} ${option.label}` : `${c.dim("○")} ${c.dim(option.label)}`}${option.hint ? c.dim(` (${option.hint})`) : ""}`),
        c.dim("↑/↓ to move · Enter to confirm"),
      ],
      (key) => {
        if (key.name === "up") at = (at + options.length - 1) % options.length;
        if (key.name === "down") at = (at + 1) % options.length;
        return key.name === "return" || key.name === "enter" ? options[at]! : undefined;
      },
    );
    this.answered(question, choice.label);
    return choice.value;
  }

  /** Any of a list, all ticked to begin with: setting up is what the person came for. */
  async multiselect(question: string, options: readonly MapOption[]): Promise<string[]> {
    const { c } = this;
    const ticked = new Set(options.map((_, i) => i));
    let at = 0;
    const chosen = await this.live(
      question,
      () => [
        ...options.map((option, i) => {
          // The arrow, not the brightness, says which row Space will tick: with no colour, nothing else would.
          const box = ticked.has(i) ? c.cyan("■") : c.dim("□");
          return `${i === at ? `${c.cyan("›")} ${box} ${option.label}` : `  ${box} ${c.dim(option.label)}`}${option.hint ? c.dim(` (${option.hint})`) : ""}`;
        }),
        c.dim("↑/↓ to move · Space to tick · Enter to confirm"),
      ],
      (key) => {
        if (key.name === "up") at = (at + options.length - 1) % options.length;
        if (key.name === "down") at = (at + 1) % options.length;
        if (key.name === "space") {
          if (ticked.has(at)) ticked.delete(at);
          else ticked.add(at);
        }
        return key.name === "return" || key.name === "enter" ? options.filter((_, i) => ticked.has(i)) : undefined;
      },
    );
    this.answered(question, chosen.map((option) => option.short).join(", ") || "No");
    return chosen.map((option) => option.value);
  }

  async yesNo(question: string, initial: boolean, hint?: string): Promise<boolean> {
    const { c } = this;
    let yes = initial;
    const answer = await this.live(
      question,
      () => [`${yes ? `${c.cyan("●")} Yes` : c.dim("○ Yes")} ${c.dim("/")} ${yes ? c.dim("○ No") : `${c.cyan("●")} No`}`, ...(hint ? this.fold(hint).map(c.dim) : [])],
      (key) => {
        if (key.name === "y") return "yes";
        if (key.name === "n") return "no";
        if (key.name === "left" || key.name === "right" || key.name === "up" || key.name === "down" || key.name === "tab") yes = !yes;
        return key.name === "return" || key.name === "enter" ? (yes ? "yes" : "no") : undefined;
      },
    );
    this.answered(question, answer === "yes" ? "Yes" : "No");
    return answer === "yes";
  }
}

// ---------------------------------------------------------------------------------------------
// The changes: worked out in full first, so what is shown is exactly what happens.

interface Change {
  verb: "create" | "edit" | "link";
  path: string;
  why: string;
  apply: () => void;
}

interface MapOption {
  value: string;
  label: string;
  hint?: string;
  /** How it reads once chosen: a few of these share one dim line. */
  short: string;
}

/** A line added at the end of a file, unless it's there by now. Never a rewrite. Prose gets a blank line before it. */
function appendLine(file: string, line: string, present: (text: string) => boolean, { prose = false } = {}): void {
  const text = readText(file) ?? "";
  if (present(text)) return;
  const open = text.endsWith("\n") || !text ? "" : "\n";
  appendFileSync(file, `${open}${prose && text ? "\n" : ""}${line}\n`);
}

const hasImport = (text: string) => text.includes("contextmachines/PRODUCT.md");

/** A .gitignore line that already keeps the saved sign-in out of git. */
const coversSession = (text: string) => text.split(/\r?\n/).some((line) => /^\/?(contextmachines\/?|contextmachines\/\.session\.json|contextmachines\/\*|\*?\.session\.json)$/.test(line.trim()));

/**
 * The agent files that could still take the line: those here, once each. A link from one to the
 * other is one file, and a CLAUDE.md that imports AGENTS.md reads whatever that holds. A folder with
 * neither gets the offer of an AGENTS.md, which every coding agent reads.
 */
function agentFiles(cwd: string): { files: string[]; create: boolean } {
  const here = ["CLAUDE.md", "AGENTS.md"].filter((name) => existsSync(join(cwd, name)));
  if (here.length === 0) return { files: [], create: true };
  const seen = new Set<string>();
  const files = here.filter((name) => {
    const real = realpathSync(join(cwd, name));
    if (seen.has(real)) return false;
    seen.add(real);
    const text = readText(join(cwd, name)) ?? "";
    return !hasImport(text) && !(name === "CLAUDE.md" && here.includes("AGENTS.md") && /^@AGENTS\.md\s*$/m.test(text));
  });
  return { files, create: false };
}

function mapOptions(cwd: string): MapOption[] {
  const { files, create } = agentFiles(cwd);
  const lines = files.map((name) => ({ value: name, label: `Add ${IMPORT_LINE} to ${name}`, short: name }));
  const skill = skillSource() && !(taken(join(cwd, SKILL_HOME)) && taken(join(cwd, SKILL_LINK)));
  return [
    ...lines,
    ...(create ? [{ value: "AGENTS.md", label: `Create AGENTS.md with ${IMPORT_LINE}`, short: "AGENTS.md" }] : []),
    ...(skill ? [{ value: "skill", label: "Install the skill", hint: ".agents/skills, linked into .claude/skills", short: "the skill" }] : []),
  ];
}

interface Answers {
  url: string;
  ai: string;
  readCode: boolean | undefined;
  app: string | undefined;
  map: string[];
  pullRequests: boolean;
}

function planChanges(cwd: string, answers: Answers): { changes: Change[]; warnings: string[] } {
  const changes: Change[] = [];
  const warnings: string[] = [];
  const at = (path: string) => join(cwd, path);

  // A person's own keys in the file stay: only these answers are ever set.
  let saved: Record<string, unknown> | undefined = {};
  try {
    readProjectConfig(cwd);
    saved = JSON.parse(readText(at(CONFIG_FILE)) ?? "{}") as Record<string, unknown>;
  } catch (error) {
    saved = undefined;
    warnings.push(`${error instanceof Error ? error.message : CONFIG_FILE}: left as it is, so learn still needs an address`);
  }
  const asked = { url: answers.url, ai: answers.ai, ...(answers.readCode !== undefined ? { readCode: answers.readCode } : {}), ...(answers.app ? { app: answers.app } : {}) };
  if (saved && Object.entries(asked).some(([key, value]) => saved![key] !== value)) {
    const text = `${JSON.stringify({ ...saved, ...asked }, null, 2)}\n`;
    const exists = taken(at(CONFIG_FILE));
    changes.push({ verb: exists ? "edit" : "create", path: CONFIG_FILE, why: "your setup for learn", apply: () => writeFileSync(at(CONFIG_FILE), text, exists ? {} : { flag: "wx" }) });
  }

  for (const name of answers.map.filter((value) => value !== "skill")) {
    const exists = taken(at(name));
    changes.push({ verb: exists ? "edit" : "create", path: name, why: `+ ${IMPORT_LINE}`, apply: () => appendLine(at(name), IMPORT_LINE, hasImport, { prose: true }) });
  }

  const skill = skillSource();
  if (skill && answers.map.includes("skill")) {
    if (!taken(at(SKILL_HOME))) {
      changes.push({
        verb: "create",
        path: `${SKILL_HOME}/`,
        why: "the skill, for coding agents",
        apply: () => {
          mkdirSync(dirname(at(SKILL_HOME)), { recursive: true });
          cpSync(dirname(skill), at(SKILL_HOME), { recursive: true, force: false });
        },
      });
    }
    if (!taken(at(SKILL_LINK))) {
      changes.push({
        verb: "link",
        path: SKILL_LINK,
        why: "so Claude Code finds it",
        apply: () => {
          mkdirSync(dirname(at(SKILL_LINK)), { recursive: true });
          // A relative link survives the project being moved or cloned. Windows' junctions need the
          // full path, and need no special permission.
          if (process.platform === "win32") symlinkSync(at(SKILL_HOME), at(SKILL_LINK), "junction");
          else symlinkSync(`../../${SKILL_HOME}`, at(SKILL_LINK));
        },
      });
    }
  }

  const workflow = workflowSource();
  if (workflow && answers.pullRequests && !taken(at(WORKFLOW))) {
    const text = readFileSync(workflow, "utf8").replace(/^# Copy to \S+ /, "# ");
    changes.push({
      verb: "create",
      path: WORKFLOW,
      why: "fill in your preview addresses",
      apply: () => {
        mkdirSync(dirname(at(WORKFLOW)), { recursive: true });
        writeFileSync(at(WORKFLOW), text, { flag: "wx" });
      },
    });
  }

  // learn keeps its own folder's .gitignore, but only once it has run; a saved sign-in is a live
  // session, so the project's own file holds the line too, wherever git is in use.
  const ignore = readText(at(".gitignore"));
  if ((ignore !== undefined || taken(at(".git"))) && !coversSession(ignore ?? "")) {
    changes.push({ verb: ignore === undefined ? "create" : "edit", path: ".gitignore", why: "keep your sign-in out of git", apply: () => appendLine(at(".gitignore"), SESSION_LINE, coversSession) });
  }
  return { changes, warnings };
}

// ---------------------------------------------------------------------------------------------
// The flow.

export interface InitOptions {
  /** Runs `learn` on the address, for the last question. Without it that question isn't asked. Its number is init's exit code. */
  learn?: (url: string) => number | void | Promise<number | void>;
  cwd?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  errors?: NodeJS.WriteStream;
  probes?: Partial<Probes>;
  /** Its --help, laid out the way the command lays out every command's: plain USAGE without it. */
  help?: () => string;
}

/**
 * An address as it is saved: refused if it isn't one, or if it carries a sign-in or a token, since
 * this file is meant to be committed. Only the query and the login are looked at: what redact does to
 * a path is about what may be shown, not about secrets.
 */
function addressProblem(typed: string): string | undefined {
  const url = startUrl(typed);
  if (!url) return `"${safe(typed)}" isn't a web address: try ${DEFAULT_URL}`;
  const bare = new URL(url);
  bare.pathname = "/";
  if (publicUrl(bare) !== String(bare)) return "That address holds a sign-in or a token, and this file gets committed: leave it out here, and give it to learn on the command line";
  return undefined;
}

const addressOf = (typed: string) => {
  const url = startUrl(typed)!;
  return url.pathname === "/" && !url.search && !url.hash ? url.origin : String(url);
};

/**
 * Runs the whole setup for this folder and gives back the exit code; it never exits by itself, so
 * the caller stays in charge of the process. Nothing is written before the person says yes.
 */
export async function runInit(args: readonly string[], options: InitOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin;
  const out = options.output ?? process.stdout;
  const errors = options.errors ?? process.stderr;
  const cwd = resolve(options.cwd ?? process.cwd());
  const probes = { ...LIVE_PROBES, ...options.probes };
  const err = colors(colorWanted(errors));
  const refuse = (sentence: string) => {
    errors.write(`${err.red("×")} ${sentence} ${err.dim("(add --help for usage)")}\n`);
    return EXIT.usage;
  };

  let flags: { yes?: boolean; url?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values: flags, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { yes: { type: "boolean", short: "y" }, url: { type: "string" }, help: { type: "boolean", short: "h" } } }));
  } catch (error) {
    const unknown = /Unknown option '--?([^']+)'/.exec(String(error))?.[1];
    if (!unknown) return refuse(`--url needs an address, as in --url ${DEFAULT_URL}.`);
    const near = suggest(unknown, ["yes", "url", "help"]);
    return refuse(`There's no option --${unknown} for init.${near ? ` Did you mean --${near}?` : ""}`);
  }
  if (flags.help) {
    out.write(options.help?.() ?? USAGE);
    return EXIT.done;
  }
  if (positionals.length > 1 || (positionals.length && flags.url)) return refuse("init takes one address.");
  const givenUrl = flags.url ?? positionals[0];
  if (givenUrl !== undefined) {
    const problem = addressProblem(givenUrl);
    if (problem) return refuse(`${problem}.`);
  }

  const canAsk = Boolean(input.isTTY && out.isTTY) && process.env.TERM !== "dumb";
  if (!flags.yes && !canAsk) {
    errors.write(`contextmachines init asks questions, and there's no terminal to ask in: run it in one, or take the defaults with: npx contextmachines init --yes --url ${givenUrl ? publicUrl(addressOf(givenUrl)) : DEFAULT_URL}\n`);
    return EXIT.usage;
  }

  const rail = new Rail(input, out);
  const { c } = rail;
  let started: Started | undefined;
  out.write(`${wordmark(out)}\n\n`);
  rail.print(`${c.dim("┌")}  Set up ${c.bold(safe(basename(cwd)))}`);
  rail.note();

  let applied = false;
  try {
    return await flow(cwd, givenUrl, Boolean(flags.yes), rail, probes, options.learn, () => (applied = true), (server) => (started = server));
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    rail.end(c.yellow(applied ? "Stopped. The changes above stay; nothing else was done." : "Stopped; nothing was changed."));
    return EXIT.interrupted;
  } finally {
    // However it ended: what setup started, setup stops.
    await started?.stop();
    if (started) rail.print(c.dim(`Stopped the app it started at ${publicUrl(started.url)}`));
  }
}

/** The project in a line or two. Only what was found is said, and nothing is promised that this folder can't do. */
function foundLines(project: Project): string[] {
  const code = repoRootOf(project.dir) !== undefined;
  const how = [project.framework, project.folder === "." ? "" : `in ${project.folder}`, project.dev ? `starts with ${project.dev.shown}` : ""].filter(Boolean).join(", ");
  const auth = project.auth;
  const signIn = !auth
    ? ""
    : auth.held === "server"
      ? `Sign-in: ${auth.name}, decided on the server. A stand-in user can't pass that${code ? "; reading your code still can." : "."}`
      : standInExpected(auth)
        ? `Sign-in: ${auth.name}, in the browser. A stand-in user with made-up data should be able to walk it, with nobody signing in. The run will say if it can't.`
        : `Sign-in: ${auth.name}, in the browser. There's no stand-in user for it yet${code ? "; reading your code still works." : "."}`;
  return [how, signIn].filter(Boolean).map((line) => safe(line));
}

/** Something else's server on that port isn't this app, however like it it looks: only a working folder tells. */
const servedElsewhere = (url: string, project: Project, found: readonly Listener[]) => found.some((l) => String(l.port) === (new URL(url).port || "80") && l.cwd !== undefined && !project.running.includes(l.port));

/** The address a person can trust without typing it: what's answering here, and how that's known. */
async function answeringNow(project: Project, saved: ProjectConfig, found: readonly Listener[], probes: Probes): Promise<{ url: string; hint: string } | undefined> {
  const notOurs = (url: string) => servedElsewhere(url, project, found);
  if (saved.url && !addressProblem(saved.url) && (await probes.reachable(saved.url))) return { url: saved.url, hint: CONFIG_FILE };
  for (const port of project.running) {
    const url = `http://localhost:${port}`;
    if (await probes.servesPage(url)) return { url, hint: `running from ${project.folder === "." ? "this folder" : project.folder}` };
  }
  if (!notOurs(project.url) && (await probes.reachable(project.url))) return { url: project.url, hint: project.urlFrom ? `answering now, from ${project.urlFrom}` : "answering now" };
  return undefined;
}

/**
 * Where the app runs, as a fact: an address offered here is answering now, so Enter can't lead to a
 * dead one. If nothing is, the project's dev command is offered, one explicit yes for that one
 * command, since it runs the project's own code. So never under --yes.
 */
async function whereItRuns(givenUrl: string | undefined, yes: boolean, rail: Rail, project: Project, saved: ProjectConfig, found: readonly Listener[], probes: Probes, onStarted: (server: Started) => void): Promise<string> {
  const QUESTION = "Where does your app run?";
  const { c } = rail;
  if (givenUrl !== undefined) {
    rail.answered(QUESTION, addressOf(givenUrl));
    return addressOf(givenUrl);
  }
  const answering = await answeringNow(project, saved, found, probes);
  const fallback = saved.url && !addressProblem(saved.url) ? saved.url : project.url;
  if (yes) {
    const url = addressOf(answering?.url ?? fallback);
    rail.answered(QUESTION, url, ...(answering ? [] : [servedElsewhere(url, project, found) ? "Another folder's app is on that port, so this one isn't running yet: learn will say so." : "Nothing answers there yet: learn will say so."]));
    return url;
  }
  const answers = (url: string) => probes.reachable(addressOf(url));
  if (answering) return addressOf(await rail.text(QUESTION, answering.url, answering.hint, addressProblem, answers));
  if (project.dev) {
    const first = project.dev.runsFirst ? ` Your ${project.dev.runsFirst} script runs first.` : "";
    if (await rail.yesNo(`Nothing's running yet. Start your app with ${project.dev.shown}?`, true, `This runs your project's code.${first} It's stopped again when setup ends.`)) {
      const stop = new AbortController();
      const onStop = () => stop.abort();
      process.once("SIGINT", onStop);
      process.once("SIGTERM", onStop);
      const started = Date.now();
      const spinner = rail.spinner((frame) => `${frame} Starting your app ${c.dim(`${Math.round((Date.now() - started) / 1000)}s · ${project.dev!.shown}`)}`);
      spinner.start();
      const server = await probes.startDev(project, stop.signal).catch(() => undefined);
      spinner.stop();
      process.off("SIGINT", onStop);
      process.off("SIGTERM", onStop);
      if (stop.signal.aborted) throw new Stopped();
      if (server) {
        onStarted(server);
        rail.answered(QUESTION, server.url, "Started for now: it's stopped again when setup ends.");
        return addressOf(server.url);
      }
      rail.say(`! ${notFoundWords(project.dev.shown)}`, c.yellow);
    }
  }
  const later = await rail.select("Nothing's answering yet. What now?", [{ value: false, label: "Type its address" }, { value: true, label: "Set up now, learn later", hint: "learn will offer to start it" }]);
  if (later) {
    const url = addressOf(fallback);
    rail.answered(QUESTION, url, "Not running yet.");
    return url;
  }
  return addressOf(await rail.text(QUESTION, fallback, "Type the address, then Enter", addressProblem, answers));
}

async function flow(cwd: string, givenUrl: string | undefined, yes: boolean, rail: Rail, probes: Probes, learn: InitOptions["learn"], markApplied: () => void, onStarted: (server: Started) => void): Promise<number> {
  const { c } = rail;
  // Detection takes a moment, and the first question doesn't need it.
  const detecting = detectAi(probes);
  let saved: ProjectConfig = {};
  try {
    saved = readProjectConfig(cwd);
  } catch {
    // Said when the changes are worked out: it doesn't stop the setup.
  }

  // What this folder is, said once, so nothing below has to be asked.
  const found = await probes.listeners().catch(() => [] as Listener[]);
  const project = detectProject(cwd, found);
  const lines = foundLines(project);
  if (lines.length) rail.answered("Found your project", ...lines);
  let startedHere = false;
  const url = await whereItRuns(givenUrl, yes, rail, project, saved, found, probes, (server) => {
    startedHere = true;
    onStarted(server);
  });

  // Which AI: an answer saved earlier stays the default and stays listed, even if its key isn't
  // set in this shell, or running init again would change it without being asked.
  const ais = await detecting;
  const keep = saved.ai && !ais.some((option) => option.choice === saved.ai) && (AI_CHOICES as readonly string[]).includes(saved.ai) ? [{ choice: saved.ai, label: saved.ai, hint: "in your config" }] : [];
  const offered = [...keep, ...ais];
  const initial = Math.max(0, offered.findIndex((option) => option.choice === saved.ai));
  const AI_QUESTION = "Which AI should read your product?";
  let ai: string;
  if (yes || offered.length === 1) {
    ai = offered[initial]!.choice;
    const tip = offered.length === 1 ? ["Sign in to Claude Code or Codex, or set an API key, then run init."] : [];
    rail.answered(AI_QUESTION, offered[initial]!.label, ...tip);
  } else {
    ai = await rail.select(AI_QUESTION, offered.map((option) => ({ ...option, value: option.choice })), initial);
  }

  // One thing about code, and only where it can come to anything. Source code leaving this machine
  // takes a real yes, so --yes keeps whatever was said before and adds nothing.
  const CODE_QUESTION = "Let your AI read your code?";
  let readCode = saved.readCode;
  if (ai !== "none" && !repoRootOf(project.dir)) {
    rail.answered(CODE_QUESTION, "Not here: reading your code needs a git repository, and this folder isn't in one.");
  } else if (ai !== "none") {
    if (ai === "ollama") {
      readCode = undefined;
      rail.answered(CODE_QUESTION, "Not yet with Ollama: use Claude Code, Codex or an API key to have your code read.");
    } else if (yes) {
      rail.answered(CODE_QUESTION, readCode ? "Yes, as you said before" : "No: it takes a yes, so run init without --yes, or pass --code to learn");
    } else {
      readCode = await rail.yesNo(CODE_QUESTION, saved.readCode ?? true, "At a sign-in, your AI reads your code to describe the screens behind it. Source files go to that AI, and only there; .env files and anything shaped like a secret stay here.");
    }
  }

  // Give your coding agent the map: what's already done isn't offered again.
  const MAP_QUESTION = "Give your coding agent the map?";
  const choices = mapOptions(cwd);
  let map: string[] = [];
  if (choices.length === 0) rail.answered(MAP_QUESTION, "Already set up");
  else if (yes) {
    map = choices.map((option) => option.value);
    rail.answered(MAP_QUESTION, choices.map((option) => option.short).join(", "));
  } else {
    map = await rail.multiselect(MAP_QUESTION, choices);
  }

  // Off by default: the workflow needs preview addresses only the person knows, and until they're
  // filled in it would fail on every pull request. A workflow only works at the top of a repository.
  const PR_QUESTION = "Check every pull request?";
  const canWorkflow = (taken(join(cwd, ".git")) || taken(join(cwd, ".github"))) && Boolean(workflowSource());
  let pullRequests = false;
  if (taken(join(cwd, WORKFLOW))) rail.answered(PR_QUESTION, "Already set up");
  else if (canWorkflow) {
    if (yes) rail.answered(PR_QUESTION, "No");
    else pullRequests = await rail.yesNo(PR_QUESTION, false, "Needs a preview address for each pull request: you fill those in after.");
  }

  const { changes, warnings } = planChanges(cwd, { url, ai, readCode, app: project.folder === "." ? undefined : project.folder, map, pullRequests });
  for (const warning of warnings) rail.say(`! ${warning}`, c.yellow);
  if (changes.length === 0) {
    rail.answered("Nothing to change: this folder is already set up");
  } else {
    // The reasons are kept short enough that the longest path and the longest reason share a row at
    // 80 columns. Narrower than the list needs, they go altogether: the paths are what must be read.
    const wide = Math.max(...changes.map((change) => change.path.length));
    const reasons = wide + Math.max(...changes.map((change) => change.why.length)) + 12 < rail.columns;
    rail.print(`${c.green("◇")}  Changes:`);
    for (const change of changes) rail.note(`${padTo(change.verb, 6)} ${reasons ? `${padTo(change.path, wide)}  ${c.dim(change.why)}` : change.path}`);
    rail.note();
    if (!yes && !(await rail.yesNo("Apply these changes?", true))) {
      rail.end("Nothing was changed.");
      return EXIT.done;
    }
    for (const change of changes) {
      try {
        change.apply();
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code ?? "it failed";
        rail.end(`✗ Couldn't write ${change.path} (${reason}). The changes before it were made; run init again once that's fixed.`, (line) => line.replace("✗", c.red("✗")));
        return EXIT.couldNot;
      }
      markApplied();
    }
    rail.answered(`Applied ${changes.length} ${changes.length === 1 ? "change" : "changes"}`);
  }

  // The browser: a download, so never without being asked, and --yes doesn't count as asking.
  const command = browserCommand();
  let browser = await probes.browserInstalled();
  if (!browser) {
    if (!yes && (await rail.yesNo("No browser yet. Install one?", true, command))) {
      browser = await installing(rail, probes, command);
      if (!browser) rail.say(`! That didn't work. Try it yourself: ${command}`, c.yellow);
      rail.note();
    }
  }

  // Plain `learn` only works once the address is saved: a broken config file was left alone.
  const needsAddress = !readableAddress(cwd) ? ` ${publicUrl(url)}` : "";
  if (learn && browser && !yes) {
    const answers = await probes.reachable(url);
    // A server from another folder answers too, and learning it would write its product into this project.
    const someoneElses = servedElsewhere(url, project, found) && !startedHere;
    const up = answers && !someoneElses;
    const go = await rail.yesNo("Learn your app now?", up, up ? undefined : someoneElses ? `That's another folder's app at ${publicUrl(url)}, not this one: start yours first.` : `Nothing answers at ${publicUrl(url)} yet: start your app first.`);
    if (go) {
      rail.end(`Learning ${c.cyan(publicUrl(url))}`);
      rail.print();
      return (await learn(url)) ?? EXIT.done;
    }
  }

  if (pullRequests) rail.say(`Then put your preview addresses in ${WORKFLOW}`, (line) => line.replace(WORKFLOW, c.cyan(WORKFLOW)));
  rail.end(`Next: ${browser ? "" : `${command} && `}${LEARN}${needsAddress}`, (line) => (line.startsWith("Next: ") ? `Next: ${c.cyan(line.slice(6))}` : c.cyan(line)));
  return EXIT.done;
}

function readableAddress(cwd: string): string | undefined {
  try {
    return readProjectConfig(cwd).url;
  } catch {
    return undefined;
  }
}

/** The download, with a spinner, so a minute of silence doesn't look like a hang. Ctrl-C ends it and the run. */
async function installing(rail: Rail, probes: Probes, command: string): Promise<boolean> {
  const stop = new AbortController();
  let stopped = false;
  const onStop = () => {
    stopped = true;
    stop.abort();
  };
  const started = Date.now();
  const spinner = rail.spinner((frame) => `${frame} Installing the browser ${rail.c.dim(`${Math.round((Date.now() - started) / 1000)}s · ${command}`)}`);
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  try {
    spinner.start();
    const ok = await probes.installBrowser(stop.signal);
    spinner.stop();
    if (stopped) throw new Stopped();
    if (ok) rail.note(`${rail.c.green("✓")} Browser installed`);
    return ok;
  } finally {
    spinner.stop();
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }
}
