#!/usr/bin/env node
/**
 * Context Machines: learns a web product from the outside and writes down what it understood.
 *
 *   npx contextmachines learn https://yourapp.com
 *
 * Everything runs on this machine: a browser visits the site (saves are answered by us, and what can't be
 * shown to be a read is held back), and the understanding reads what it saw. Writes:
 *   FIX.md       the short list of what to fix, with evidence and where to change it, for a coding agent to act on
 *   PRODUCT.md   what the product is for, its screens, actions, main journeys and issues (for people and coding agents);
 *                once a person has edited it, it is left alone and each run writes PRODUCT.new.md beside it
 *   map.json     the same, as data
 *   screens/     a photo of each screen
 */
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scanSite, standInRefusal, type Finding, type JourneysUnderWay, type ScanResult, type ScanStage, type ScreenCheck, type StandInConfig } from "@contextmachines/scanner";
import { buildFixes, codeRules, firstRunAddresses, liveItems, reviewedScreens, reviewScreens, sourcesOf, type ReviewRun } from "./brief.ts";
import { tabBase } from "../packages/understanding/src/learn/screen-views.ts";
import { readsBlankSessionFields, addressStrings, journeyHints, readCode, standInRows, usableCodeRead, type CodeRead } from "./code-map.ts";
import { predict } from "./predictions.ts";
import { chosenStorageKey, detectProject, detectUrl, hasAppCode, listeners, notFoundWords, proxiedPaths, repoRootOf, servedFromElsewhere, startDev, wallPlan, within } from "./project.ts";
import { readRepo } from "./repo.ts";
import { understand, type Understood } from "./understand.ts";
import { AI_CHOICES, aiTotals, launcherUnreadable, pickAi, timedAi, type Ai, type AskTiming } from "./ai.ts";
import { browserCommand, browserInstalled, INIT_ABOUT, INIT_EXIT_MEANINGS, INIT_OPTIONS, installBrowser, readProjectConfig, runInit, saveAddress } from "./init.ts";
import {
  badgeWords, behindSignIn, compare, deadStart, diff, filesToClear, FIX_FILE, fixDoc, fixLines, fixPhoto, goneSince, newSince, groupFindings, groupTargets, groupText, HOME, issueText, journeyHeadline, journeyLive, journeyMap, journeyTree, journeysNotWalked, keptNoMainAction, leftForAnotherSite, liveAddress, liveIssues, MANIFEST, MAP_SCHEMA, mayKeepDataHere, moreFixLines, fixRest, forPasting, nextLines, outInUse, jpegSize, type PhotoBoxes, photoName, plural,
  productDoc, productFile, PRODUCT_NEW, provenCount, publicUrl, redact, referredPhotos, reportPage, resultLines, rowLines, screenName, signUpIn, startUrl, stoppedFrom, summaryRows, usageWords, wallNext, whyNoJourneys, whyNothing, withLiveAddresses, writePrivate, type Fix, type Prediction, type ProductMap,
} from "./report.ts";
import { LIVE_MIN_COLUMNS, liveWanted, MOST_WIDTH, PARTS, RunScreen, type Group, type StepEnd } from "./run-screen.ts";
import { AGENT_NAMES, agentHere, agentLaunch, clipboardFor, copyText, endMenu, fixPrompt, menuKeys, menuLine, onPath, openerFor, openFile, startAgent } from "./hand-off.ts";
import { ask, colors, colorWanted, columnsOf, confirm, ignoreBrokenPipes, inForeground, keyWanted, linked, linksWanted, padTo, rule, safe, seconds, suggest, visibleWidth, waitForKey, wrapItems, wrapTo, type Colors } from "./term.ts";

ignoreBrokenPipes();

declare const __CONTEXTMACHINES_VERSION__: string | undefined;
/** This release's version: stamped in by the build, read from package.json when run from the repository. */
const VERSION = typeof __CONTEXTMACHINES_VERSION__ === "string" ? __CONTEXTMACHINES_VERSION__ : (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * How a run ended, for scripts and builds: one table, the same one help prints. Finding issues is
 * what learning is for, so it is a success unless --fail-on-issues asks otherwise.
 */
const EXIT = { learned: 0, issues: 1, usage: 2, couldNot: 3, interrupted: 130 } as const;
const EXIT_MEANINGS: [number, string][] = [
  [EXIT.learned, "learned it, with or without issues (an AI reading that failed is a warning: everything else is written)"],
  [EXIT.issues, "it proved something to fix, only with --fail-on-issues (for diff: new proven items, only with --fail-on-new-issues). A prediction never counts."],
  [EXIT.usage, "something typed wrong: an unknown option, a bad value, no address, an unreadable map.json"],
  [EXIT.couldNot, "couldn't learn the site: it didn't answer or answered an error, the browser is missing, or something unexpected"],
  [EXIT.interrupted, "stopped with Ctrl-C (what it learned until then is still written)"],
];
/** diff learns nothing and takes no address: its own words for the codes it can end with. */
const DIFF_EXIT_MEANINGS: [number, string][] = [
  [EXIT.learned, "compared the two runs, whatever changed"],
  [EXIT.issues, "the after run has proven items the before run didn't, only with --fail-on-new-issues"],
  [EXIT.usage, "something typed wrong: an unknown option, a bad value, a missing or unreadable map.json"],
];

/** Progress and messages: to stderr when --json, so stdout is only the result. */
let json = process.argv.includes("--json");
const stream = () => (json ? process.stderr : process.stdout);
// Colour is decided once for each stream: a pipe gets none, whatever the other stream is.
// Only the 16 every terminal has, so the run follows the person's own theme.
const outColors = colors(colorWanted(process.stdout));
const errColors = colors(colorWanted(process.stderr));
const paint = () => (json ? errColors : outColors);
/** The run's screen, once it has begun (see RunScreen): lines printed meanwhile go above its live area. */
let screen: RunScreen | undefined;
const say = (line = "") => (screen ? screen.log(line) : stream().write(`${line}\n`));
process.on("exit", () => screen?.stop("failed"));

/**
 * Every way it stops early: a red × and one plain sentence, then, when there is a fix, the command to
 * try. The sentence may carry a site's or a browser's words, so it is made safe to print first.
 */
function fail(message: string, code: number, more: { fix?: string; note?: string } = {}): never {
  screen?.stop("failed");
  screen = undefined;
  const c = errColors;
  const usage = code === EXIT.usage ? ` ${c.dim("(add --help for usage)")}` : "";
  // On a terminal, wrapped at words under its ×: never cut mid-word by the terminal. In a log, one line.
  const said = safe(redact(message), 2000);
  const lines = process.stderr.isTTY ? wrapTo(said, Math.max(20, columnsOf(process.stderr) - 3)) : [said];
  process.stderr.write(`${lines.map((line, n) => `${n ? " " : c.red("×")} ${line}`).join("\n")}${usage}\n`);
  if (more.fix) process.stderr.write(`  ${c.dim("Try:")} ${c.cyan(safe(more.fix))}\n`);
  if (more.note) process.stderr.write(`  ${c.dim(more.note)}\n`);
  // Under --json, stdout says it too: a build reads stdout, and empty says nothing.
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, exit: code, error: said })}\n`);
  process.exit(code);
}
/** Ends once everything written to stdout has been taken: a pipe on macOS takes it later than write() returns. */
function exitWhenWritten(code: number): Promise<never> {
  return new Promise(() => process.stdout.write("", () => process.exit(code)));
}
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
// Anything not foreseen still ends in one line, never a stack trace (set CONTEXTMACHINES_DEBUG=1 for it).
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => {
    if (process.env.CONTEXTMACHINES_DEBUG) {
      screen?.stop("failed");
      console.error(error);
    }
    fail(`Context Machines stopped: ${redact(firstLine(error))}`, EXIT.couldNot, process.env.CONTEXTMACHINES_DEBUG ? {} : { note: "Run with CONTEXTMACHINES_DEBUG=1 for the full error" });
  });
}

// ---------------------------------------------------------------------------------------------
// The command line: its words, checked before anything is asked or opened.

interface Flag {
  type: "string" | "boolean";
  short?: string;
  /** What the value is, as help shows it: "<n>". */
  value?: string;
  group: string;
  help: string;
}
const LEARN_FLAGS: Record<string, Flag> = {
  minutes: { type: "string", value: "<n>", group: "Exploring", help: "how long to explore, 1 to 30 (default 3)" },
  pages: { type: "string", value: "<n>", group: "Exploring", help: "most screens to visit, 1 to 500 (default 60)" },
  create: { type: "boolean", group: "Exploring", help: "let its saves go through for real, to reach screens that only exist after creating something; test accounts only; a write that says it destroys is stopped, one that doesn't say so goes through" },
  yes: { type: "boolean", group: "Exploring", help: "don't ask before --create (needed where it can't ask, as in a build)" },
  login: { type: "boolean", group: "Signing in", help: "sign in by hand in a browser window first, and act as that account (use a test account or staging: a GET that writes behind an innocent name can't be told from a read); the session is saved, never a password" },
  session: { type: "string", value: "<file>", group: "Signing in", help: "reuse a saved sign-in from --login, and act as that account" },
  code: { type: "boolean", group: "Behind a sign-in", help: "at a sign-in, have your AI read the code for this run: source files go to the AI you chose, never .env files or anything shaped like a secret (init saves this as a yes for your local address)" },
  "no-code": { type: "boolean", group: "Behind a sign-in", help: "don't read the code, whatever was saved" },
  "no-stand-in": { type: "boolean", group: "Behind a sign-in", help: "don't use a stand-in user on a local address" },
  "no-journeys": { type: "boolean", group: "Behind a sign-in", help: "don't walk the journeys (sign-up, onboarding, the main action) in the sealed browser" },
  ai: { type: "string", value: "<which>", group: "AI", help: `the AI that reads what the product is for: ${AI_CHOICES.join(", ")} (default: the first you have)` },
  model: { type: "string", value: "<id>", group: "AI", help: "the model to ask (default: each AI's own)" },
  "reading-cache": { type: "string", value: "<file>", group: "AI", help: "where the AI reading is kept, so an unchanged product isn't read again (default <out>/.reading.json)" },
  out: { type: "string", value: "<dir>", group: "Output", help: "where to write (default ./contextmachines)" },
  json: { type: "boolean", group: "Output", help: "print the result as JSON on stdout, for coding agents and builds; progress goes to stderr" },
  html: { type: "boolean", group: "Output", help: "does nothing now: report.html is always written (kept so older commands still run)" },
  verbose: { type: "boolean", group: "Output", help: "list every screen under its part, and end with the full summary: journeys, setup steps, every action and what happened to the saves (all of it is in PRODUCT.md too)" },
  all: { type: "boolean", group: "Output", help: "list every item to fix at the end, not the first five (in a pipe too)" },
  "no-prompt": { type: "boolean", group: "Output", help: "no menu at the end (it's never shown to an agent, CI or a pipe; CONTEXTMACHINES_NO_PROMPT=1 does the same)" },
  "fail-on-issues": { type: "boolean", group: "Output", help: "exit 1 when it proved something to fix, to fail a build on it; a prediction never counts" },
};
const DIFF_FLAGS: Record<string, Flag> = {
  json: { type: "boolean", group: "Output", help: "print the comparison as JSON instead of markdown" },
  "fail-on-new-issues": { type: "boolean", group: "Output", help: "exit 1 when the after run has proven items the before run didn't; a prediction never counts" },
};
const COMMON_FLAGS: Record<string, Flag> = {
  help: { type: "boolean", short: "h", group: "Other", help: "show this help" },
  version: { type: "boolean", short: "v", group: "Other", help: "show the version" },
};
const COMMANDS = {
  init: { usage: "init [--yes] [--url <address>]", summary: "set this folder up: finds your app and where it runs, which AI reads it, and the map for your coding agent", flags: {}, examples: ["npx contextmachines init", "npx contextmachines init --yes --url http://localhost:3000"] },
  learn: {
    usage: "learn <url> [options]",
    summary: "explore a site and write FIX.md, the short list of what to fix, with PRODUCT.md, map.json and a photo of each screen",
    flags: LEARN_FLAGS,
    examples: ["npx contextmachines learn https://yourapp.com", "npx contextmachines learn localhost:3000 --minutes 1 --ai none", "npx contextmachines learn https://staging.yourapp.com --login", "npx contextmachines learn https://yourapp.com --json > map.json"],
  },
  diff: {
    usage: "diff <before/map.json> <after/map.json> [options]",
    summary: "what changed in the product between two runs, as markdown for a pull request comment",
    flags: DIFF_FLAGS,
    examples: ["npx contextmachines diff main/map.json pr/map.json > comment.md", "npx contextmachines diff main/map.json pr/map.json --json --fail-on-new-issues"],
  },
} as const;
type Command = keyof typeof COMMANDS;
const ALL_FLAGS = { ...LEARN_FLAGS, ...DIFF_FLAGS, ...COMMON_FLAGS };
const TRY_LEARN = "npx contextmachines learn https://yourapp.com";

/** Help: for one command, or for the whole tool. Laid out to the terminal's width. */
function help(command?: Command): string {
  const c = outColors;
  const cols = Math.min(columnsOf(process.stdout), 100);
  const lines: string[] = [`${c.bold("contextmachines")} ${VERSION}`];
  const section = (title: string) => lines.push("", c.bold(`${title}:`));
  /** Rows of a left column (in a colour) and its description, wrapped with a hanging indent. */
  const table = (rows: [string, string][], color: (s: string) => string = (s) => s, leftWidth?: number) => {
    const left = leftWidth ?? Math.min(28, Math.max(...rows.map(([l]) => l.length)));
    for (const [l, r] of rows) {
      const room = Math.max(20, cols - left - 6);
      const wrapped = wrapTo(r, room);
      if (l.length > left) lines.push(`  ${color(l)}`, ...wrapped.map((w) => `  ${" ".repeat(left)}  ${w}`));
      else wrapped.forEach((w, k) => lines.push(`  ${k === 0 ? color(padTo(l, left)) : " ".repeat(left)}  ${w}`));
    }
  };
  const flagRow = (name: string, f: Flag): [string, string] => [`${f.short ? `-${f.short}, ` : ""}--${name}${f.value ? ` ${f.value}` : ""}`, f.help];
  const paragraph = (text: string) => lines.push(...wrapTo(text, cols - 4).map((l) => `  ${l}`));
  if (command === "init") {
    // init asks its own questions, but its help is laid out as every command's.
    lines.push(...wrapTo(INIT_ABOUT, cols - 2));
    section("Usage");
    lines.push(`  npx contextmachines ${COMMANDS.init.usage}`);
    section("Options");
    table(INIT_OPTIONS, c.cyan);
    section("Examples");
    for (const e of COMMANDS.init.examples) lines.push(`  ${c.dim("$")} ${e}`);
  } else if (command) {
    const spec = COMMANDS[command];
    lines.push(...wrapTo(spec.summary.replace(/^./, (x) => x.toUpperCase()), cols - 2));
    section("Usage");
    lines.push(`  npx contextmachines ${spec.usage}`);
    if (command === "learn") {
      lines.push("", "  With no address, it uses the one `init` saved in contextmachines.config.json.");
      section("What it writes (to --out)");
      table([
        ["FIX.md", "what to fix, proven first: each item with its evidence, where to change it, and a suggested change. Hand it to your coding agent. Proven means the browser saw or measured it; predicted means an AI's reading, kept only if its quote is really on the screen or in the code."],
        ["PRODUCT.md", "what the product is for, its main action, journeys, screens and actions, and the issues it found: a button that did nothing, the site's own script failing, a server error or failed data request, a broken link. Only what the browser saw happen, never opinions. Once you edit it, it's yours: later runs leave it alone and write PRODUCT.new.md beside it."],
        ["report.html", "the page to read: one card per item with its screenshot (the problem boxed where it was measured), where to change it, its evidence and a button that copies it for your coding agent; then every screen. Nothing on it loads from the web."],
        ["map.json", "the same, as data"],
        ["screens/", "a photo of each screen"],
      ]);
      section("At the end, in a terminal");
      table([
        ["f", "fix them: starts the coding agent the run used (--ai claude-code or codex) here, on FIX.md; the run then ends with the agent's exit code (so --fail-on-issues counts no more)"],
        ["o", "opens report.html"],
        ["a", "lists the rest of the items here"],
        ["c", "copies FIX.md, to paste into any coding agent"],
        ["Enter", "done (also q or Esc). Never shown to an agent, CI, a pipe, --json or --no-prompt."],
      ]);
    }
    // One column for every group's flags, so they line up down the page.
    const flags = [...Object.entries(spec.flags), ...Object.entries(COMMON_FLAGS)].map(([n, f]) => ({ group: f.group, row: flagRow(n, f) }));
    const flagWidth = Math.min(28, Math.max(...flags.map((f) => f.row[0].length)));
    for (const group of new Set(flags.map((f) => f.group))) {
      section(group);
      table(flags.filter((f) => f.group === group).map((f) => f.row), c.cyan, flagWidth);
    }
    if (command === "learn") {
      section("Bring your own AI");
      paragraph("It uses the first one you already have: the Claude Code or Codex you're signed in to (your subscription, no key), else an API key, billed per token. With an AI it reads what the product is for, names every action and reviews the screens for where a person gets stuck, waits, pays before seeing value or loses work; without one you still get every screen, action, and everything measured.");
      section("How the sign-in is handled");
      paragraph("Nobody signs in by hand. On a local address, when it meets a sign-in, it reads your code (if you said yes at init, or pass --code), then walks the screens as a stand-in user with made-up data, starting as soon as it knows there's a sign-in, beside the public pressing: an app that decides who's signed in in the browser, with every data call answered in the browser and only your dev server's files loaded, so that user reaches no real server. Those screens are marked and say nothing about real data: only their layout, fixed wording and flow are ever reported. This adds up to two thirds of --minutes again, and the code is read alongside on a smaller model where your AI offers one, about 2 minutes the first time. What it can't read in time is left for the next run, and what hasn't changed isn't read again. On any other address there's no stand-in user: --login with a test account is the way past.");
      section("Journeys");
      paragraph("Beside all that, sealed browsers walk what a new account is offered, a few side by side: onboarding past step one, the main action, imports and the rest, pressing and filling, with saves answered in the browser. FIX.md lists every journey found, which finished, where each stopped and what couldn't be reached. Finished means the screens moved on with saves answered in the browser, and says nothing about your real server. Payments, emails, outside accounts and real files are stopped here, never touched. It adds nothing to the list's proven items, and the list never waits for it: 2m 30s at most, and what time left undone is named. It needs the stand-in, so --login, --session and --create press nothing and say so.");
    }
    section("Examples");
    for (const e of spec.examples) lines.push(`  ${c.dim("$")} ${e}`);
  } else {
    lines.push("Learns your web product from the outside and writes down what it understood.");
    section("Usage");
    for (const spec of Object.values(COMMANDS)) lines.push(`  npx contextmachines ${spec.usage}`);
    lines.push("  npx contextmachines help <command>");
    section("Commands");
    table(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.summary]), c.cyan);
    section("Examples");
    for (const e of [COMMANDS.learn.examples[0], COMMANDS.learn.examples[1], COMMANDS.diff.examples[0]]) lines.push(`  ${c.dim("$")} ${e}`);
    lines.push("", `  Add ${c.cyan("--help")} to a command for its options: ${c.cyan("npx contextmachines learn --help")}`);
  }
  section("Exit codes");
  table((command === "diff" ? DIFF_EXIT_MEANINGS : command === "init" ? INIT_EXIT_MEANINGS : EXIT_MEANINGS).map(([code, meaning]) => [String(code), meaning]));
  section("Environment");
  // diff compares two files and asks no AI: its help shouldn't suggest it wants a key.
  const aiSettings: [string, string][] = command === "diff" ? [] : [
    ["ANTHROPIC_API_KEY", "bring your own AI; also OPENAI_API_KEY, GEMINI_API_KEY, AI_GATEWAY_API_KEY, OPENROUTER_API_KEY: the first one set is used"],
    ["OPENAI_BASE_URL", "any OpenAI-compatible server (Ollama, LM Studio, a company proxy), with --model"],
  ];
  table([
    ...aiSettings,
    ["CONTEXTMACHINES_DEBUG=1", "print the full error when something unexpected stops it"],
    ["NO_COLOR=1", "no colour (FORCE_COLOR=1 for colour where it would be off)"],
  ]);
  lines.push("", `${c.bold("Docs:")} ${c.underline(HOME)}`, "");
  return lines.join("\n");
}

// init parses its own words and asks its own questions, so it goes before the flags of learn and diff.
if (process.argv[2] === "init" || (process.argv[2] === "help" && process.argv[3] === "init")) {
  // Not spawnSync: a dev server init started has to keep being looked after while this runs. Ctrl-C
  // reaches the run on its own, which writes what it learned, and init then stops that server.
  const learn = (url: string) =>
    new Promise<number>((done) => {
      const wait = () => {};
      process.on("SIGINT", wait);
      const child = spawn(process.execPath, [process.argv[1]!, "learn", url], { stdio: "inherit" });
      child.on("error", () => done(EXIT.couldNot));
      child.on("close", (code) => {
        process.off("SIGINT", wait);
        done(code ?? EXIT.couldNot);
      });
    });
  await exitWhenWritten(await runInit(process.argv[2] === "help" ? ["--help"] : process.argv.slice(3), { learn, help: () => help("init") }));
}

const { values, positionals } = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: Object.fromEntries(Object.entries(ALL_FLAGS).map(([n, f]) => [n, { type: f.type, ...(f.short ? { short: f.short } : {}) }])) });
  } catch (error) {
    // Node's own wording, without its advice about positionals: which option, and what was meant.
    const said = firstLine(error);
    const option = said.match(/option '([^' ]+)/i)?.[1] ?? "";
    const code = (error as { code?: string }).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const near = suggest(option.replace(/^-+/, ""), Object.keys(ALL_FLAGS));
      return fail(`There's no option ${option}.${near ? ` Did you mean --${near}?` : ""}`, EXIT.usage);
    }
    if (/argument missing|ambiguous/.test(said)) {
      const name = option.replace(/^-+/, "");
      return fail(`${option} needs a value${ALL_FLAGS[name]?.value ? `, like ${option} ${name === "minutes" ? "3" : name === "pages" ? "60" : ALL_FLAGS[name]!.value}` : ""}.`, EXIT.usage);
    }
    if (/does not take an argument/.test(said)) return fail(`${option} is on or off: it takes no value.`, EXIT.usage);
    return fail(said, EXIT.usage);
  }
})() as { values: Record<string, string | boolean | undefined>; positionals: string[] };
json = values.json === true;
const str = (name: string) => (typeof values[name] === "string" ? (values[name] as string) : undefined);
const flag = (name: string) => values[name] === true;

const [word, ...rest] = positionals;
if (flag("version")) {
  process.stdout.write(`contextmachines ${VERSION}\n`);
  await exitWhenWritten(EXIT.learned);
}
if (!word) {
  process.stdout.write(help());
  await exitWhenWritten(EXIT.learned);
}
const isCommand = (w: string | undefined): w is Command => w !== undefined && Object.hasOwn(COMMANDS, w);
if (word === "help") {
  if (rest[0] && !isCommand(rest[0])) fail(`There's no command "${rest[0]}".${didYouMeanCommand(rest[0])}`, EXIT.usage);
  process.stdout.write(help(rest[0] as Command | undefined));
  await exitWhenWritten(EXIT.learned);
}
if (!isCommand(word)) {
  // An address where the command goes: they meant learn.
  if (startUrl(word!)) fail(`Say what to do with ${publicUrl(word!)}.`, EXIT.usage, { fix: `npx contextmachines learn ${publicUrl(word!)}` });
  fail(`There's no command "${word}".${didYouMeanCommand(word!)}`, EXIT.usage, { fix: TRY_LEARN });
}
const command = word as Command;
if (flag("help")) {
  process.stdout.write(help(command));
  await exitWhenWritten(EXIT.learned);
}
// Its own flags are only read as its first word, or they would be refused as learn's.
if (command === "init") fail("Put init first, with its options after it.", EXIT.usage, { fix: "npx contextmachines init" });
// An option of the other command: say whose it is rather than ignore it.
const foreign = Object.keys(values).find((name) => !Object.hasOwn(COMMANDS[command].flags, name) && !Object.hasOwn(COMMON_FLAGS, name));
if (foreign) fail(`--${foreign} is an option of ${command === "learn" ? "diff" : "learn"}, not ${command}.`, EXIT.usage);

function didYouMeanCommand(typed: string): string {
  const near = suggest(typed, Object.keys(COMMANDS));
  return near ? ` Did you mean "${near}"?` : "";
}

if (command === "diff") {
  const [before, after, extra] = rest;
  if (!before || !after) fail("Compare two runs: give the map.json from before and the one from after.", EXIT.usage, { fix: "npx contextmachines diff before/map.json after/map.json" });
  if (extra) fail(`diff compares two runs; "${extra}" is one too many.`, EXIT.usage);
  const was = readMap(before!);
  const now = readMap(after!);
  process.stdout.write(diff(was, now, json));
  const changes = compare(was, now);
  await exitWhenWritten(flag("fail-on-new-issues") && changes.issuesNew.length + changes.fixesNew.length ? EXIT.issues : EXIT.learned);
}

// learn: every argument is checked before anything is asked or opened.
// What init saved stands in for what wasn't typed: a typed address or --ai wins, and with both, a broken saved file doesn't matter.
const projectConfig = (() => {
  try {
    return readProjectConfig();
  } catch (error) {
    if (rest[0] && str("ai")) return {};
    return fail(`Couldn't read the saved setup: ${firstLine(error)}.`, EXIT.usage, { fix: TRY_LEARN });
  }
})();
const [target = projectConfig.url, extra] = rest;
if (!target) fail("Which site? Give its address.", EXIT.usage, { fix: TRY_LEARN });
if (extra) fail(`learn takes one address; "${extra}" is one too many.`, EXIT.usage);
let start = startUrl(target!) ?? fail(`"${target}" isn't a web address.`, EXIT.usage, { fix: TRY_LEARN });
/** The start address as it is shown and written: without any sign-in or token it carries (the browser gets it whole). */
let shownUrl = publicUrl(start);
/** A number option, refused rather than quietly changed when it is out of range. */
const count = (name: "minutes" | "pages", fallback: number, max: number, whole: boolean) => {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 1 || n > max || (whole && !Number.isInteger(n))) {
    fail(`--${name} must be ${whole ? "a whole number" : "a number"} from 1 to ${max} (you gave ${raw}).`, EXIT.usage);
  }
  return n;
};
const minutes = count("minutes", 3, 30, false);
const pages = count("pages", 60, 500, true);
/** The stand-in only measures, and gives no finding: less of it than of the real walk, however long that is. */
const standInMinutes = Math.round((minutes * 2) / 3 * 10) / 10;
/** A length of time as the setup line says it: minutes, or seconds when it's under one ("40s", not "0.7 min"). */
const minutesWords = (m: number) => (m < 1 ? `${Math.round(m * 60)}s` : `${m} min`);
if (str("session") && !existsSync(str("session")!)) fail(`There's no saved sign-in at ${str("session")}.`, EXIT.usage, { fix: `npx contextmachines learn ${shownUrl} --login` });
if (flag("login") && str("session")) fail("Use --login to sign in now, or --session to reuse a saved sign-in: not both.", EXIT.usage);
if (flag("code") && flag("no-code")) fail("Use --code to read the code for this run, or --no-code not to: not both.", EXIT.usage);
const aiChoice = str("ai") ?? projectConfig.ai;
// The model the same way: --model wins, then the one saved beside the AI. A model saved for one AI
// isn't carried to another named on the command line.
const modelChoice = str("model") ?? (str("ai") && str("ai") !== projectConfig.ai ? undefined : projectConfig.model);
if (aiChoice !== undefined && !(AI_CHOICES as readonly string[]).includes(aiChoice)) {
  const near = suggest(aiChoice, AI_CHOICES);
  fail(`There's no AI called "${aiChoice}".${near ? ` Did you mean "${near}"?` : ""} --ai takes ${AI_CHOICES.join(", ")}.`, EXIT.usage);
}
if (flag("create") && !flag("yes") && !process.stdin.isTTY) fail("--create changes the site for real, so it asks first, and it can't ask here (not a terminal). Add --yes, on a test account only.", EXIT.usage, { fix: `npx contextmachines learn ${shownUrl} --create --yes` });
if (flag("login") && !process.stdin.isTTY) fail("--login needs a terminal, to sign in by hand; here, reuse the sign-in an earlier --login saved.", EXIT.usage, { fix: `npx contextmachines learn ${shownUrl} --session contextmachines/.session.json` });
// Which AI reads it: the one asked for, or the first the person already has.
let ai: Ai | undefined;
try {
  ai = pickAi(aiChoice, modelChoice);
} catch (error) {
  fail(firstLine(error), EXIT.usage);
}
// An agent asked for by name is run by its command: missing, it's said now, not as the first question failing.
const agentCommand = ai?.agent && (aiChoice === "claude-code" || aiChoice === "codex") ? ai.agent : undefined;
if (agentCommand && onPath(agentCommand) && !agentLaunch(agentCommand)) fail(`--ai ${aiChoice}: ${launcherUnreadable(agentCommand)}`, EXIT.usage);
if (agentCommand && !onPath(agentCommand)) fail(`--ai ${aiChoice} needs the ${agentCommand} command on your PATH: install ${aiChoice === "codex" ? "Codex" : "Claude Code"} and sign in, or use --ai none`, EXIT.usage);
const out = resolve(str("out") ?? "contextmachines");
/** The output folder as the person would type it: relative to here, with forward slashes. */
const shown = (() => {
  const rel = relative(process.cwd(), out).split(sep).join("/") || ".";
  return rel.startsWith("../..") ? out : rel;
})();
// Checked before the browser opens: a run explores for minutes and may ask a paid AI, and must not
// find out only at the end that it can't write what it learned.
const outProblem = unwritable(out);
if (outProblem) fail(`Can't write to ${shown}: ${outProblem}. Choose another --out.`, EXIT.usage);
// A folder of that name a run didn't make (a home folder's own "contextmachines") is someone's: never written into.
const outTaken = outInUse(out);
// Its way out goes by how it got here: the default folder means the wrong place to run from, so "cd" first.
if (outTaken) fail(`Won't write into ${shown}: ${safe(outTaken)}. Run it from your app's folder, or choose another folder with --out.`, EXIT.usage, { fix: str("out") ? `npx contextmachines learn ${shownUrl} --out <an empty or new folder>` : `cd <your app's folder> && npx contextmachines learn ${shownUrl}` });

// Nothing there: asked now, in a terminal, rather than after a browser has opened and given up. Only
// a refusal counts: a slow or odd answer is the browser's to find out about.
// A name that doesn't exist is a typo, not an app that isn't running: said at once, as in a pipe.
if (process.stdin.isTTY && process.stdout.isTTY && !json) {
  const answer = await reach(start);
  if (answer === "no-host") fail(whyNothing("ENOTFOUND", start), EXIT.couldNot);
  if (answer === "refused") await askForTheAddress();
  // No browser yet, as on a first run: a download, so asked for, never taken by itself. Where it can't
  // be asked (a pipe, CI) the run ends saying how, as before.
  if (!(await browserInstalled())) await askForTheBrowser();
}

/**
 * A question cancelled, or answered no: nothing has been done yet, so it ends there. A plain no is a
 * success; a Ctrl-C is a run stopped, and no address to learn is a run that couldn't, so a script
 * doesn't read either as having learned something.
 */
function stoppedUnchanged(more = "", code: number = EXIT.learned): never {
  process.stderr.write(`${errColors.yellow("!")} Stopped; nothing was changed.${more ? ` ${more}` : ""}\n`);
  process.exit(code);
}

const local = standInRefusal({ startUrl: start.href }) === undefined;
/** What this run may do at a sign-in, by what was asked and where. A sign-in held by a session is no wall. */
const wallPlanned = (real: boolean) => wallPlan({ local, ci: Boolean(process.env.CI), codeAsked: flag("code"), noCode: flag("no-code"), noStandIn: flag("no-stand-in"), saved: projectConfig.readCode, ai: Boolean(ai), real });

/** Where the code is: the app's folder when init found it below this one. */
const codeRoot = projectConfig.app && within(process.cwd(), resolve(projectConfig.app)) ? resolve(projectConfig.app) : process.cwd();
/** The live area, redrawn in place: only on a terminal that can show it (see liveWanted). */
const liveHere = !json && liveWanted(process.stdout);
{
  const c = paint();
  // What it will take is said now, or a run past its minutes looks stuck. "About" is what was measured
  // on one real app (README), and only holds at the default length; --help says the rest.
  const ahead = wallPlanned(flag("login") || Boolean(str("session")) || flag("create"));
  const firstRead = !flag("login") && ahead.code && !usableCodeRead(join(out, ".code-read.json"));
  const time = ahead.code && ahead.standIn && minutes === 3 ? (firstRead ? "3 to 4 min" : "about 3 min") : `up to ${minutesWords(minutes)} exploring${ahead.standIn ? `, up to ${minutesWords(standInMinutes)} more at a sign-in` : ""}${firstRead ? ", your AI reading the code alongside" : ""}`;
  const detail = [
    `AI: ${ai ? ai.via : "none"}`,
    flag("create") ? c.yellow("saves go through (--create)") : "saves stopped",
    ...(pages !== 60 ? [`up to ${plural(pages, "screen")}`] : []),
    ...(process.env.CI ? ["CI"] : []),
    ...(str("session") ? [`signed in from ${basename(str("session")!)}`] : []),
    time,
  ];
  // A setup line, as a test runner begins: what it's learning and how, then everything else as it happens.
  const target = safe(shownUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  const learning = `learning ${target}`;
  // The first line begins with what's being learned, the address in colour; the rest of it, and any line after, dimmed.
  wrapItems([learning, ...detail, `v${VERSION}`], columnsOf(stream()) - 4).forEach((line, n) => {
    say(n ? `  ${c.dim(line)}` : `${c.dim("ℹ")} learning ${c.cyan(target)}${c.dim(line.slice(learning.length))}`);
  });
}

if (flag("create") && !flag("yes")) {
  const reply = await confirm(`Let its saves really happen on ${safe(start.host)}? Only on a test account: a write that says it destroys is stopped, but one that doesn't say so goes through.`, errColors);
  if ("cancelled" in reply) stoppedUnchanged("", EXIT.interrupted);
  if (!reply.answer) stoppedUnchanged("Run without --create and its saves are answered in the browser.");
}

// Signing in by hand: the person signs in themselves, and only the session is kept.
let session = str("session");
if (flag("login")) {
  prepareOut();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false }).catch((error: unknown) => (missing(error) ? missingBrowser() : fail(`Couldn't open a browser window to sign in: ${firstLine(error)}`, EXIT.couldNot)));
  let cancelled = false;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(start.href);
    const reply = await confirmEnter();
    if (reply) {
      session = join(out, ".session.json");
      writePrivate(session, JSON.stringify(await context.storageState()));
    } else cancelled = true;
  } catch (error) {
    fail(`Signing in didn't work: ${redact(firstLine(error))}`, EXIT.couldNot);
  } finally {
    await browser.close().catch(() => {});
  }
  if (cancelled) stoppedUnchanged("", EXIT.interrupted);
  say(paint().dim(`  sign-in saved to ${shown}/.session.json: it is a live sign-in, so keep it private and out of git`));
  say(paint().dim(`  (${shown}/.gitignore leaves it out). Reuse it with --session ${shown}/.session.json`));
  say();
}

/**
 * Whether an address answers, is refused outright (nothing listening there), or names a host that
 * doesn't exist. Anything else (a slow or odd answer) is the browser's to find out about.
 */
async function reach(url: URL): Promise<"answers" | "refused" | "no-host"> {
  try {
    await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(2500) });
    return "answers";
  } catch (error) {
    const code = `${(error as { cause?: { code?: string } }).cause?.code ?? ""}`;
    return /ECONNREFUSED/.test(code) ? "refused" : /ENOTFOUND|EAI_AGAIN/.test(code) ? "no-host" : "answers";
  }
}
/** Whether nothing can be reached at an address, whichever way. */
async function nothingAnswers(url: URL) { return (await reach(url)) !== "answers"; }

/**
 * The right address, asked for there and then. A server running from this very folder is offered
 * first. An answer that works replaces what was saved, so the next run doesn't ask again.
 */
/** The one-time browser download, asked for with one yes, timed as it goes; no, or a failure, ends the run saying how. */
async function askForTheBrowser(): Promise<void> {
  const c = errColors;
  const reply = await ask(`${c.cyan("?")} No browser yet. Download one now? It's once, about 270 MB. ${c.dim("(Y/n)")} `);
  if ("cancelled" in reply) stoppedUnchanged("", EXIT.interrupted);
  if (/^n/i.test(reply.answer.trim())) missingBrowser();
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once("SIGINT", onStop);
  const begun = Date.now();
  const line = () => `  ${c.dim(`downloading the browser ${seconds(Date.now() - begun)} · ${browserCommand()}`)}`;
  process.stderr.write(line());
  const tick = setInterval(() => process.stderr.write(`\r${line()}`), 1000);
  const ok = await installBrowser(stop.signal);
  clearInterval(tick);
  process.off("SIGINT", onStop);
  process.stderr.write("\r\x1b[2K");
  if (stop.signal.aborted) stoppedUnchanged("", EXIT.interrupted);
  if (!ok) missingBrowser();
  process.stderr.write(`${c.green("✓")} browser downloaded ${c.dim(seconds(Date.now() - begun))}\n`);
}

async function askForTheAddress(): Promise<void> {
  const c = errColors;
  const dead = publicUrl(start);
  const project = detectProject(process.cwd(), await listeners());
  const here = project.running[0];
  let found: URL | undefined;
  /**
   * A yes-or-no too long for one line, broken between words under 80 columns (the window's width when
   * it's narrower), as the question for an address is: the answer is typed after its last line. An
   * address stays whole, on a line of its own if it must.
   */
  const askYes = (words: string) => {
    const lines = wrapTo(`${words} (Y/n)`, Math.min(columnsOf(process.stderr), 80) - 3, { whole: true });
    const last = lines.pop()!.replace(/\(Y\/n\)$/, c.dim("(Y/n)"));
    for (const [n, line] of lines.entries()) process.stderr.write(`${n ? "  " : `${c.cyan("?")} `}${line}\n`);
    return ask(`${lines.length ? "  " : `${c.cyan("?")} `}${last} `);
  };
  if (here) {
    const offered = new URL(`http://localhost:${here}`);
    const reply = await askYes(`Nothing answers at ${safe(dead)}, but this folder's app is running at ${offered.origin}. Use that?`);
    if ("cancelled" in reply) stoppedUnchanged("", EXIT.interrupted);
    if (!/^n/i.test(reply.answer.trim()) && !(await nothingAnswers(offered))) found = offered;
  } else if (project.dev) {
    // Runs the project's code, so it takes this one yes, and it never happens by itself. The server
    // goes when this run does (see startDev).
    const first = project.dev.runsFirst ? ` Your ${project.dev.runsFirst} script runs first.` : "";
    const reply = await askYes(`Nothing answers at ${safe(dead)}. Start your app with ${safe(project.dev.shown)}? It's stopped again when this run ends.${first}`);
    if ("cancelled" in reply) stoppedUnchanged("", EXIT.interrupted);
    if (!/^n/i.test(reply.answer.trim())) {
      process.stderr.write(`  ${c.dim(`starting ${safe(project.dev.shown)}…`)}\n`);
      const stop = new AbortController();
      process.once("SIGINT", () => stop.abort());
      const server = await startDev(project, async (url) => !(await nothingAnswers(new URL(url))), stop.signal);
      if (stop.signal.aborted) stoppedUnchanged("", EXIT.interrupted);
      if (server) found = new URL(server.url);
      else process.stderr.write(`  ${c.yellow("!")} ${safe(notFoundWords(project.dev.shown))}\n`);
    }
  }
  while (!found) {
    // Two lines: the address alone may fill one.
    process.stderr.write(`${c.cyan("?")} Nothing answers at ${safe(publicUrl(start))}.\n`);
    const reply = await ask(`  Your app's address ${c.dim("(Enter to stop)")}: `);
    if ("cancelled" in reply) stoppedUnchanged("", EXIT.interrupted);
    if (!reply.answer.trim()) stoppedUnchanged(`Start your app, then run learn again.`, EXIT.couldNot);
    const typed = startUrl(reply.answer.trim());
    if (!typed) process.stderr.write(`  ${c.yellow("!")} "${safe(reply.answer)}" isn't a web address.\n`);
    else {
      const answer = await reach(typed);
      if (answer === "answers") found = typed;
      else if (answer === "no-host") process.stderr.write(`  ${c.yellow("!")} ${safe(whyNothing("ENOTFOUND", typed))}\n`);
      else start = typed;
    }
  }
  start = found;
  shownUrl = publicUrl(start);
  if (!rest[0]) saveAddress(process.cwd(), start.pathname === "/" && !start.search ? start.origin : start.href);
}

/** The --login step: press Enter once signed in. False when the person cancels instead. */
async function confirmEnter(): Promise<boolean> {
  const reply = await ask(`${errColors.cyan("?")} Sign in in the browser window that opened, then press Enter here. `);
  return !("cancelled" in reply);
}

// Ctrl-C, in two steps: the first stops exploring and still writes what was learned; the second quits now.
const stopping = new AbortController();
/** The output folder has been made: from here, a second Ctrl-C may leave something of this run in it. */
let outPrepared = false;
let interrupted = false;
let interruptedAt = 0;
/** A second Ctrl-C this soon after the first is the same press: under npx, npm passes on one the terminal already sent. */
const SAME_PRESS_MS = 500;
const stopRun = () => {
  if (interrupted) {
    if (Date.now() - interruptedAt < SAME_PRESS_MS) return;
    screen?.stop("stopped");
    process.stderr.write(outPrepared ? "\n" : `${errColors.yellow("!")} Stopped; nothing was written.\n`);
    process.exit(EXIT.interrupted);
  }
  interrupted = true;
  interruptedAt = Date.now();
  stopping.abort();
  say(`${paint().yellow("!")} ${paint().yellow("Stopping: writing what it learned so far (press Ctrl-C again to quit now)")}`);
};
// The learner leaves these to this command (see launchBrowser): a CI job's stop is an interrupted run too.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stopRun);

// The run's screen: a live area on a terminal, plain lines elsewhere (a pipe, a file, a CI log, under --json).
const screensSaid = new Set<string>();
const begun = Date.now();
/** Where the run's time went, kept in map.json (learner.timing): how long each part took, and every question to the AI. */
const asks: AskTiming[] = [];
/** The AI as one part of the run asks it: what each part asked is told under its group (see usageWords). */
const untimedAi = ai;
const aiFor = (part: AskTiming["part"]) => untimedAi && timedAi(untimedAi, asks, begun, part);
const stages: Record<string, number> = {};
const reached = (stage: string) => void (stages[stage] = Date.now() - begun);
// --verbose lists every screen under its group, as the end lists no screens of its own.
// While it draws, the keyboard is the screen's: a key typed meanwhile isn't echoed into the area (see ScreenOptions.input).
const run = new RunScreen(stream(), { live: liveHere, c: paint(), begun, input: process.stdin, foreground: inForeground, ...(flag("verbose") ? { mostScreens: Infinity } : {}) });
screen = run;
run.start();

// The parts of the run, each a group of the screen from when it starts: only the ones that run.
/** The public pages, from the first one to the end of the public crawl: it begins once the browser is ready, so the setup lines come first. */
let publicGroup: Group | undefined;
/** The made-up new account, walked first behind the sign-in: until its walk is over. */
let newUserGroup: Group | undefined;
/** The stand-in's walk of the rest of the app, with made-up rows: from its first screen. */
let madeUpGroup: Group | undefined;
let codeGroup: Group | undefined;
let journeysGroup: Group | undefined;
/** Public screens seen so far, and which. */
let publicSeen = 0;
const publicPaths = new Set<string>();
const standInSeen = new Set<string>();
/** The sign-in a run met, where the stand-in is to try it. */
let wallAt: string | undefined;
/** When the public crawl was over: the end of the public pages' own time, whatever comes after it. */
let publicOverAt: number | undefined;
/** The new account has been walked, at walkedAt: its report waits for the code read and the public crawl, and the stand-in's pass with rows only for the code read. */
let standInWaits = false;
let walkedAt: number | undefined;
/** A screen as the run shows it, and as what's found on it is put under it: its address, made safe to print. */
const shownAt = (path: string) => safe(liveAddress(path, start.pathname));
/** The part walking screens now: what's measured is told under it. */
const walking = () => [madeUpGroup, newUserGroup, publicGroup].find((group) => group?.running);
/**
 * Whose group a thing found goes under: the public pages', the new account's, or the made-up user's.
 * The pass with rows goes on beside the pressing, so the new account's walk may still be told after it began.
 */
const countedBy = (madeUpUser: boolean, newUser = false) => (newUser && newUserGroup?.running ? newUserGroup : madeUpUser ? [madeUpGroup, newUserGroup].find((group) => group?.running) : publicGroup?.running ? publicGroup : undefined) ?? walking();
const foundWords = (group: Group | undefined) => (group?.found ? `${group.found} found` : undefined);
const words = (...said: (string | undefined)[]) => said.filter(Boolean).join(" · ");
/** What the public pages came to: how many, the sign-in they led to, and what was found on them. */
const publicWords = () => words(plural(publicSeen, "screen"), wallAt ? `sign-in at ${safe(liveAddress(wallAt, start.pathname))}` : undefined, foundWords(publicGroup));
/** The public pages' group, once a sign-in was met and their crawl is over: what's past the sign-in is the stand-in's. */
const publicFound = () => {
  if (!publicGroup?.running || !wallAt || publicOverAt === undefined) return;
  publicGroup.end("done", publicWords(), undefined, publicOverAt);
};
/**
 * What the new account's group is waiting on, once it has walked: the code read, then the public
 * crawl. Its clock stops where its walk did; how the walk came out is only known after the wait.
 */
const waitSaid = () => {
  if (!standInWaits || !newUserGroup?.running || walkedAt === undefined) return;
  const waitingFor = codeReadOver && !codeRead ? "the code read" : publicOverAt === undefined ? "the public pages" : "";
  newUserGroup.hold(walkedAt, waitingFor ? `waiting for ${waitingFor}` : "");
};
/** Where the run behind the sign-in has got to (see ScanStage): only ever said, nothing waits on it. */
const onStage = (stage: ScanStage) => {
  if (stage.kind === "public-over") {
    publicOverAt = Date.now();
    publicFound();
    waitSaid();
  } else if (stage.kind === "waiting") {
    standInWaits = true;
    walkedAt = Date.now();
    waitSaid();
  } else if (newUserGroup?.running) {
    // What the new account saw, as it will be reported: a public page it reached is no screen of its own.
    newUserWalk = stage.walk;
    // With the time its walk spent on each, as its own clock had it: the walk tells nothing while it goes.
    for (const shot of newUserWalk.screens) newUserGroup.saw(shownAt(shot.path), undefined, newUserWalk.took?.[shot.path]);
    // What it measured is told right after this, and goes under its screens: then it's over.
    setImmediate(newUserEnds);
  }
};
/** The made-up user's own words for how far it got were said under its group: the end doesn't say them again. */
let standInSaid = false;
/** The new account's walk, as it will be reported, once it's known. */
let newUserWalk: Extract<ScanStage, { kind: "new-user" }>["walk"] | undefined;
/** Whether the public pages showed a way to make an account (see signUpIn): asked again once they're all known. */
let signUpSeen = false;
/** The public crawl's reviews, as the sign-in was met: the crawl's own list, which goes on growing until it's over. */
let wallReviews: ScanResult["reviews"] = [];
/** The new account's group, ended without a walk: a warning only where there was a sign-up to walk past. */
const newUserNotWalked = (group: Group, stopped?: string, at?: number) => {
  if (signUpSeen || stopped) group.end("warned", words("not walked", foundWords(group)), stopped, at);
  else group.end("done", words("no sign-up seen", foundWords(group)), undefined, at);
};
/** The new account's group ends with what its walk came to. Its time is the walk's, not the wait's after it. */
const newUserEnds = () => {
  const group = newUserGroup;
  if (!group?.running || !newUserWalk) return;
  // The walk is told once every public page is known: a sign-up found after the sign-in counts too.
  signUpSeen ||= signUpIn(publicPaths, wallReviews);
  if (newUserWalk.status === "walked") group.end("done", words(plural(newUserWalk.screens.length, "screen"), foundWords(group)), undefined, walkedAt);
  else if (!signUpSeen && !interrupted) newUserNotWalked(group, undefined, walkedAt);
  else {
    group.note(paint().dim(badgeWords(safe(redact(newUserWalk.message)))));
    standInSaid = true;
    group.end("warned", words("not walked", foundWords(group)), undefined, walkedAt);
  }
};

// Each issue the moment it is proven, under the screen it was seen on. What it prints must hold to the end of the run: see liveIssues.
const issuesLive = liveIssues((f) => {
  firstFound();
  found(paint().red, issueText({ ...f, target: liveAddress(f.target, start.pathname) }), f.screen, false);
});

/** Everything told as it goes is proven, flagged by its weight: a fault the browser saw in red, a measurement in yellow. The AI's predictions only come in the list at the end. */
const found = (weight: (s: string) => string, title: string, where: string, madeUpUser: boolean, newUser = false) => {
  const group = countedBy(madeUpUser, newUser);
  if (group) group.finding(`${weight("⚑")} ${safe(title)}`, shownAt(where));
  else run.finding(`${weight("⚑")} ${safe(title)} ${paint().dim(`(${shownAt(where)})`)}`);
};
const firstFound = () => {
  stages["first item"] ??= Date.now() - begun;
};
const itemSaid = liveItems((item) => {
  firstFound();
  found(paint().yellow, item.title, item.screen, Boolean(item.seenWith), item.newUser);
});
const itemsMeasured = (checks: ScreenCheck[]) => itemSaid(checks.map((check) => ({ ...check, target: redact(check.target), ...(check.by ? { by: redact(check.by) } : {}) })));

// Another project's server on this port answers like any other: what's learned would be about it, not this one.
// Run from a folder with no app in it (a home folder), there's no code to point a fix at: said once,
// at the start, while it can still be stopped and run again from the right place. Only where code
// would be read: a local app, not --no-code, not CI (the Action runs from a folder of its own).
/** No app's code here: no file:line for a fix, and no coding agent started here on the list. */
const noCodeHere = !hasAppCode(codeRoot);
/** The folder the app is served from, when that's another one than this: the agent isn't started here either. */
let servedElsewhere: string | undefined;
if (local) servedElsewhere = servedFromElsewhere(Number(start.port || 80), process.cwd(), await listeners().catch(() => []));
/** A folder as the person knows it: their home folder as ~. */
const homeShort = (path: string) => {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;
};
/** Said at the first screen, once the address has answered: an address that doesn't answer is the thing to say first. */
let codeWarned = false;
const warnAboutCode = () => {
  if (codeWarned || !local) return;
  codeWarned = true;
  const sayNoCode = !flag("no-code") && !process.env.CI;
  const where = servedElsewhere && safe(homeShort(servedElsewhere));
  // Both at once is one line: where the app's code is already says where to run it from.
  if (where && noCodeHere && sayNoCode) run.note("warn", `no app code here: ${safe(start.host)} is served from ${where}, so run it from there`);
  else if (where) run.note("warn", `${safe(start.host)} is served from another folder (${where}), not this one: what's learned is about that app.`);
  else if (noCodeHere && sayNoCode) run.note("warn", "no app code here, so no file:line for fixes: run it from your app's folder");
  // File:line comes from the repository's files: without one, the code is there and no fix points into it.
  else if (sayNoCode && !repoRootOf(codeRoot)) run.note("warn", "not a git repository, so fixes won't have file:line: run git init && git add -A first");
};
const wall = wallPlanned(Boolean(session) || flag("create"));
let codeRead: CodeRead | undefined;
/** Set while the code is being read beside the browser: the run waits for it before it writes. */
let codeReadOver: Promise<void> | undefined;

/**
 * Whether a sign-in stands in this run's way, the same test for the glance at the wall and for what
 * it writes. It goes by the door and nothing else: a contact form that saves on a public page says
 * nothing about what's behind the sign-in beside it.
 */
function stoppedAtSignIn(crawl: ScanResult, seen: Pick<Understood, "shown">, finished: boolean): boolean {
  return !session && !crawl.loggedIn && behindSignIn({
    screens: seen.shown.map((s) => ({ path: s.path, title: s.snapshot.title ?? null, passwordBox: s.snapshot.forms.some((f) => f.fields.some((x) => x.type === "password")), otherButtons: s.snapshot.buttons.filter((b) => b.form === undefined).length, headings: s.snapshot.headings.length })),
    startPath: `${start.pathname}${start.hash}`,
    landed: crawl.startPath,
    complete: finished && crawl.stoppedBy === "complete",
  });
}

/**
 * The code, read by the AI chosen, alongside the browser: nothing the browser can do waits for this
 * but the pass that needs its rows. Ctrl-C ends the wait: what had gone by then is said, as far as
 * it's known.
 */
async function readTheCode(crawl: ScanResult): Promise<void> {
  reached("code read begins");
  const repo = repoRootOf(codeRoot);
  const tiedToFolder = local && repo !== undefined && (await listeners()).some((l) => String(l.port) === (start.port || "80") && l.cwd !== undefined && within(repo, l.cwd));
  const stopped = new Promise<undefined>((done) => stopping.signal.addEventListener("abort", () => done(undefined), { once: true }));
  codeGroup = run.group(PARTS.code);
  codeGroup.detail("your AI reading the code");
  // One line that ticks: "screen 4 of 15" under its group. A log gets a line for each new kind of step, not each tick.
  let lastKind = "";
  const onProgress = (line: string) => {
    const doing = line.replace(/^Reading the code:\s*/, "");
    codeGroup?.doing(doing);
    const kind = doing.replace(/\d+/g, "#").replace(/,.*$/, "");
    // Broken between words for a narrow window, each piece under the first, as every other line here.
    if (kind !== lastKind) for (const piece of wrapTo(line, columnsOf(stream()) - 3)) run.progress(paint().dim(`  ${piece}`));
    lastKind = kind;
  };
  codeRead = await Promise.race([readCode(crawl, aiFor("code")!, codeRoot, { onProgress, cacheFile: join(out, ".code-read.json"), tiedToFolder }), stopped]);
  reached("code read ends");
  codeReadSaid();
}

/** What became of the read, once it's over: its group says it, and what went wrong is said under it. */
function codeReadSaid(): void {
  const c = paint();
  waitSaid();
  const width = columnsOf(stream()) - 8;
  if (!codeRead) {
    codeGroup?.note(c.dim("some files may have gone to your AI"));
    codeGroup?.end("warned", "stopped while reading the code");
  } else if (codeRead.ran) {
    // Read, and none of it seen, as the code read's own line says.
    const read = codeRead.fromCode;
    if (codeRead.readingError) codeGroup?.note(c.dim(`its summary of the product didn't work: ${safe(redact(codeRead.readingError))}`));
    if (codeRead.samplesError) codeGroup?.note(c.dim(`its sample rows didn't work, so screens will show their empty state: ${safe(redact(codeRead.samplesError))}`));
    // What it asked of the AI, beside its time; a read that was reused asked nothing, so says no tokens.
    const usage = usageWords(aiTotals(asks.filter((a) => a.part === "code")), { plan: ai?.plan });
    codeGroup?.end("done", words(plural(read.screens.filter((s) => s.access !== "redirect").length, "screen"), `${plural(read.actions.length, "action")}, none seen`), words(codeRead.reused ? "code unchanged, last read reused" : undefined, usage) || undefined);
  } else {
    wrapTo(safe(redact(codeRead.reason)), width).forEach((line, n) => codeGroup?.note(`${n ? " " : c.yellow("!")} ${line}`));
    if (codeRead.filesSent.length) codeGroup?.note(c.dim(`  ${plural(codeRead.filesSent.length, "file")} went to your AI before it stopped: listed in map.json`));
    codeGroup?.end("warned", "didn't read the code", usageWords(aiTotals(asks.filter((a) => a.part === "code")), { plan: ai?.plan }));
  }
}

/**
 * Between the public crawl and anything further: was there a sign-in in the way, and if so what's
 * allowed here. A plain look at what the crawl saw decides that, with no AI. The AI that reads the
 * product comes after, once all of it has been seen.
 */
async function pastTheWall(crawl: ScanResult, walls: readonly string[]): Promise<StandInConfig | undefined> {
  reached("sign-in known");
  if (interrupted || crawl.pagesVisited.length === 0) return undefined;
  const glance = await understand(crawl, { origin: crawl.startOrigin }).catch(() => undefined);
  if (!glance || (walls.length === 0 && !stoppedAtSignIn(crawl, glance, true))) return undefined;
  if (!interrupted && wall.standIn) {
    wallAt = walls[0] ?? crawl.startPath ?? "/";
    publicFound();
  }
  if (wall.code) {
    prepareOut();
    codeReadOver = readTheCode(crawl);
  }
  if (interrupted || !wall.standIn) return undefined;
  const repoFiles = repoRootOf(codeRoot) ? readRepo(codeRoot)?.files ?? [] : [];
  const storageKey = repoFiles.length ? chosenStorageKey(repoFiles.map((f) => f.text)) : undefined;
  // A route in the source is the source: what it opens goes to the AI, so without the yes it isn't tried.
  const spelled = addressStrings(wall.code ? repoFiles : []);
  const project = detectProject(codeRoot, await listeners().catch(() => []));
  const elsewhere = servedFromElsewhere(Number(start.port || 80), codeRoot, await listeners().catch(() => []));
  // Only a try: whether it gets anywhere is for the pass to find out, and the result to say.
  signUpSeen = signUpIn(crawl.pagesVisited, crawl.reviews);
  wallReviews = crawl.reviews;
  newUserGroup = run.group(PARTS.newUser);
  newUserGroup.detail(project.auth?.held !== "server" ? "trying a made-up new account" : "checking the sign-in");
  /** Files the seal may believe in by name, only when this folder is what's being served. */
  const served = project.running.includes(Number(start.port || 80));
  return {
    maxDurationMs: standInMinutes * 60_000,
    addresses: [...walls],
    rows: {},
    // The new account has no rows and finds its own way, so it goes now, and the pass with rows waits for the read.
    ...(codeReadOver ? { later: codeReadOver.then(() => (codeRead?.ran ? { addresses: [...new Set([...walls, ...codeRead.signedInPaths, ...codeRead.staffPaths])], rows: standInRows(codeRead.samples), journeyHints: journeyHints(codeRead.fromCode) } : undefined)) } : {}),
    firstRun: spelled.firstRun,
    walkAddresses: spelled.others,
    sessionFieldsBlank: readsBlankSessionFields(repoFiles),
    ...(storageKey ? { storageKey } : {}),
    ...(served ? { folder: project.dir } : {}),
    // The project says which library: the first screens may not show it at work.
    ...(project.auth?.held === "browser" && !elsewhere ? { provider: project.auth.name } : {}),
  };
}

/**
 * What this project's dev server hands on to another server, known before the first request: to a
 * browser that's its own host, and behind it may be the real service. Nothing here if the address
 * is another folder's server, whose config this isn't.
 */
async function handedOn(): Promise<string[]> {
  if (!local || session || flag("create")) return [];
  const found = await listeners().catch(() => []);
  if (servedFromElsewhere(Number(start.port || 80), codeRoot, found)) return [];
  return proxiedPaths(detectProject(codeRoot, found).dir);
}

/** How many journeys have been tried so far, and how many of them were walked to their end. */
let journeysSaid = 0;
let journeysEnded = 0;
/** How long the journeys' browser gets to close: what's walked is kept as it's walked, so a slow close loses nothing. */
const JOURNEYS_CLOSE_MS = 2500;
/** How long the journey a stop caught midway gets to be counted as walked: it ends at its next step, and the list waits no longer. */
const JOURNEY_LAST_MS = 500;
// Packaged, the snippet sits beside this file; in the repository the learner finds its own.
const packagedSnippet = fileURLToPath(new URL("./snippet.min.js", import.meta.url));
/** The last look at the screens, going on beside the AI's reading: the list waits for it, and the reading doesn't. */
let lastLook: Promise<void> | undefined;
/** The journeys, going on beside everything else: the list stops them, and never waits for them. */
let journeys: JourneysUnderWay | undefined;
/** The journeys' browser closing, which the end waits for (at most JOURNEYS_CLOSE_MS) after the files are written. */
let journeysClosed: Promise<void> | undefined;
/** When the walking ended, by itself or stopped: what the journeys' row times, not the wait for the rest after it. */
let journeysWalkedAt: number | undefined;
const scan = await scanSite({
  startUrl: start.href,
  maxPages: pages,
  maxDurationMs: minutes * 60_000,
  delayMs: 150,
  ...(session ? { storageState: session } : {}),
  ...(flag("create") ? { realWrites: true } : {}),
  // A run on this machine stays on it. A real session is the one thing that asks to leave.
  stayLocal: local && !session && !flag("create"),
  proxied: await handedOn(),
  onScreen: (path, n, named, asStandIn) => {
    if (screensSaid.size === 0) {
      run.note("done", "browser ready", seconds(Date.now() - begun));
      warnAboutCode();
      // A blank line between the setup lines and the parts of the run, as a test runner leaves.
      run.log();
    }
    publicGroup ??= run.group(PARTS.public);
    if (asStandIn) {
      // The stand-in's own walk begins at its first screen: the new account's walk is over by then.
      madeUpGroup ??= run.group(PARTS.madeUpUser);
      // A public page it looks at again is the public pages', listed and counted there: only the time on it is the stand-in's.
      if (publicPaths.has(path)) madeUpGroup.step(`looking at ${shownAt(path)} again`);
      else {
        standInSeen.add(path);
        madeUpGroup.detail(plural(standInSeen.size, "screen"));
        madeUpGroup.screen(shownAt(path), safe(liveAddress(named ?? path, start.pathname)));
      }
    } else {
      publicSeen = n;
      publicPaths.add(path);
      publicGroup.detail(plural(publicSeen, "screen"));
      (publicGroup.running ? publicGroup : walking())?.screen(shownAt(path), safe(liveAddress(named ?? path, start.pathname)));
    }
    // The stand-in looks at the start again: only what's new to this run is news. A pipe gets a count, or it looks stuck.
    screensSaid.add(path);
    if (screensSaid.size % 10 === 0) run.progress(paint().dim(`  ${plural(screensSaid.size, "screen")} so far`));
    issuesLive.screen(path);
  },
  // Going back to a screen to press its buttons is time on that screen, not on the last one looked at.
  onPressing: (path) => {
    const group = publicGroup?.running ? publicGroup : undefined;
    group?.screen(shownAt(path), safe(liveAddress(path, start.pathname)));
    group?.doing("pressing its buttons and filling its forms");
  },
  onFinding: issuesLive.finding,
  onChecks: itemsMeasured,
  onLastLook: (look) => void (lastLook = look),
  ...(flag("no-journeys") ? {} : {
    onJourneys: (walk: JourneysUnderWay) => {
      reached("journeys begin");
      journeys = walk;
      void walk.walked.then(() => {
        if (journeysWalkedAt !== undefined) return;
        journeysWalkedAt = Date.now();
        // Apart from "journeys end", which comes once the rest of the run is: what the journeys' row times.
        reached("journeys walked");
        journeysGroup?.hold(journeysWalkedAt, "waiting for the rest of the run");
      });
      journeysGroup = run.group(PARTS.journeys);
      walk.listen((journey) => {
        journeysSaid++;
        if (journey.outcome === "finished" && !journey.fromCode) journeysEnded++;
        journeysGroup?.detail(`${journeysSaid} found · ${journeysEnded} finished`);
        // A few plain words for the last one walked: the group lists them once they're all over.
        journeysGroup?.doing(safe(journeyLive(journey), 200));
      });
    },
  }),
  signal: stopping.signal,
  onStage,
  ...(wall.code || wall.standIn ? { standIn: pastTheWall } : {}),
  ...(existsSync(packagedSnippet) ? { snippetFile: packagedSnippet } : {}),
}).catch((error: unknown) => {
  if (interrupted) fail("Stopped; nothing was written.", EXIT.interrupted);
  return missing(error) ? missingBrowser() : fail(`Couldn't learn ${start.host}: ${redact(firstLine(error))}`, EXIT.couldNot);
});

reached("browser ends");
// The walk's groups, ended by what the browser came back with.
{
  const stopped = interrupted ? "stopped" : undefined;
  // Nothing seen is a run that failed, whatever comes after says why.
  const how: StepEnd = scan.pagesVisited.length === 0 ? "failed" : interrupted ? "warned" : "done";
  publicSeen ||= scan.pagesVisited.length;
  if (publicGroup?.running) publicGroup.end(how, publicWords(), stopped, publicOverAt);
  // Still running: the stand-in's pass ended before the new account was walked, and its own words say why.
  const why = scan.standIn && scan.standIn.status !== "reached" ? badgeWords(safe(redact(scan.standIn.message))) : undefined;
  signUpSeen ||= signUpIn(scan.pagesVisited, scan.reviews);
  newUserEnds();
  if (newUserGroup?.running) {
    if (why && !interrupted && signUpSeen) {
      newUserGroup.note(paint().dim(why));
      standInSaid = true;
    }
    newUserNotWalked(newUserGroup, stopped);
  }
  const reachedThere = scan.standIn?.status === "reached";
  const group = madeUpGroup;
  if (group?.running) {
    if (why && !reachedThere) {
      group.note(paint().dim(why));
      standInSaid = true;
    }
    // The screens it walked, as listed under it, the public pages it looked at again left to theirs.
    const ends = () => group.end(reachedThere && !interrupted ? "done" : "warned", words(plural(standInSeen.size, "screen"), foundWords(group)), interrupted ? "stopped" : undefined);
    // Its last look, with one row on each screen, is its own work still: what that finds goes under its screens, and then it's over.
    if (lastLook && reachedThere) {
      group.step("one more look at its screens, with one row each");
      void lastLook.then(ends, ends);
    } else ends();
  }
}
await codeReadOver;
// Under --json there's no result screen to say this.
if (json && scan.standIn && scan.standIn.status !== "reached") say(`  ${paint().yellow("!")} ${safe(redact(scan.standIn.message))}`);
const savesSeen = scan.blockedWrites.length;
/** What the start page showed beyond its status: a bot check's title tells it from a sign-in, and WWW-Authenticate is one. */
const startShowed = {
  ...(scan.startTitle ? { title: scan.startTitle } : {}),
  ...(scan.startAsksSignIn ? { asksSignIn: true } : {}),
};
// How the start page answered says why there is nothing to learn: an error status first, else the browser's own words.
if (scan.pagesVisited.length === 0) {
  if (interrupted) fail("Stopped; nothing was written.", EXIT.interrupted);
  if (scan.startLeftFor) fail(leftForAnotherSite(start, scan.startLeftFor), EXIT.couldNot);
  fail(deadStart(start, { status: scan.startStatus, visited: 0, screens: [], saves: savesSeen, landed: scan.startPath, ...startShowed }) ?? whyNothing(scan.startError ?? scan.errors[0] ?? "", start, { ...(scan.startStatus ? { status: scan.startStatus } : {}), ...startShowed }), EXIT.couldNot);
}
const deadByStatus = deadStart(start, { status: scan.startStatus, visited: scan.pagesVisited.length, screens: [], saves: savesSeen, landed: scan.startPath, ...startShowed });
if (deadByStatus) fail(deadByStatus, EXIT.couldNot);

// Where the start landed on the same site (apex to www, http to https) is the site from here on.
if (scan.startOrigin !== start.origin) start = new URL(`${start.pathname}${start.search}`, scan.startOrigin);

/** The AI's reading and its review of the screens, side by side: one row, as neither waits for the other. */

// After a Ctrl-C, nothing more is asked of the AI: the person wants it over, and the reading would add seconds and cost.
const asking = ai && !interrupted ? aiFor("review") : undefined;
const reviewGroup = asking ? run.group(PARTS.review) : undefined;
reviewGroup?.doing(`reading the product and screens with ${ai!.via}`);
// The code as it stands, read here and for nothing that leaves: only to find where drawn words live.
const fromCode = codeRead?.ran ? codeRead.fromCode : undefined;
const { repo, sources } = repoRootOf(codeRoot) ? sourcesOf(codeRoot, scan, fromCode) : { repo: undefined, sources: { files: [], tied: () => new Set<string>(), home: () => undefined } };
const reviewed = reviewedScreens(scan);
/** A first-run address found by its spelling is only something to try: what's said of one is said of a screen the code read names. */
const namedFirstRun = new Set(firstRunAddresses(fromCode));
const newUserWalked = scan.newUser && { ...scan.newUser, firstRun: scan.newUser.firstRun.filter((f) => namedFirstRun.has(f.path)) };
/** What was given to the app as made-up rows: words, so a quote resting on one can be told. */
const invented = codeRead?.ran ? codeRead.samples.flatMap((sample) => sample.rows.flatMap((row) => Object.values(row).filter((v): v is string => typeof v === "string" && v.trim().length >= 4))) : [];
// The review goes alongside the reading, each its own question, so neither waits for the other.
const reviewing: Promise<ReviewRun> = asking
  ? reviewScreens(asking, reviewed, codeRules(fromCode, repo), { repo, invented, firstRun: firstRunAddresses(fromCode) }, { product: fromCode?.product, newUser: newUserWalked }, { cacheFile: join(out, ".review.json") })
  : Promise.resolve({ ran: false, why: ai ? "stopped" : "no-ai", items: [], dropped: {}, raised: 0, screens: 0, ms: 0 });
// The understanding: a library called here on this machine, with nothing sent anywhere but the AI you chose.
const understood = await understand(scan, {
  origin: start.origin,
  // Naming what was seen, checked against what was seen. The review is the ask that judges, and keeps the main model.
  // With no AI after a Ctrl-C, nothing is read, and the kept reading is left as it is (only a reading that ran is kept).
  ...(asking ? { ai: asking.light ?? asking } : {}),
  readingCache: str("reading-cache") ? resolve(str("reading-cache")!) : join(out, ".reading.json"),
}).catch((error: unknown) => fail(`Couldn't make sense of what the browser saw on ${start.host}: ${redact(firstLine(error))}`, EXIT.couldNot));
const { site, actions, features, readingReused, shown: screens } = understood;
// Every screen an error page ("Not Found", "Error 526"): nothing to learn there.
const deadByPage = deadStart(start, { status: scan.startStatus, visited: scan.pagesVisited.length, screens: site.pages.map((p) => p.snapshot), saves: savesSeen, landed: scan.startPath });
if (deadByPage) fail(deadByPage, EXIT.couldNot);
const readingFailed = understood.readingError;
reached("reading ends");
const review = await reviewing;
reached("review ends");
const reviewEnded = Date.now();
// Its row ends once the list is made, which waits on the browser: said, so the clock isn't read as the AI's.
// Its clock stops here; what it came to is said once the list is made.
if (reviewGroup?.running) {
  const waitingFor = [journeys && journeysWalkedAt === undefined ? "the journeys" : undefined, lastLook ? "one more look at the screens" : undefined].filter(Boolean).join(" and ");
  reviewGroup.hold(reviewEnded, `waiting for ${waitingFor || "the list to be written"}`);
}
await lastLook;
reached("last look ends");
// Whatever's been walked by now is what's reported. A run with nothing left to do gives them their least, and that's the only time they add to it.
if (journeys) {
  await journeys.atLeast;
  journeys.stop();
  // What's walked is kept as it's walked: the browser closes while the files are written, under the seal until it has.
  journeysClosed = Promise.race([journeys.done.then(() => {}, () => {}), new Promise<void>((resolve) => setTimeout(resolve, JOURNEYS_CLOSE_MS))]);
  // The journey it was on ends at its next step: given a moment to, so it's reported as walked, not as time running out before it.
  await Promise.race([journeys.walked, new Promise<void>((resolve) => setTimeout(resolve, JOURNEY_LAST_MS))]);
  reached("journeys end");
}
const journeyReport = journeys?.soFar();
if (journeyReport && journeysGroup) {
  // The ones walked to the end by name, the rest in one line: each in full in FIX.md, and most stopped where a walk never goes.
  const c = paint();
  const walked = journeyMap(journeyReport, redact);
  for (const { mark, text } of journeyTree(walked, Math.min(MOST_WIDTH, columnsOf(stream())) - 4)) journeysGroup.item(mark === "✓" ? `${c.ok(mark)} ${nameThenGrey(safe(text, 200), c)}` : mark === "■" ? `${c.yellow(mark)} ${c.grey(safe(text, 300))}` : c.grey(`${mark} ${safe(text, 300)}`));
  const said = journeyHeadline(walked);
  journeysGroup.end("done", `${said.count} · ${said.rest}`, undefined, journeysWalkedAt);
}

// Photos of the screens it lists and of their tabs, under names that are unique and the same every
// run. A route that only looks like its screen has no photo of its own: it would be a copy. A screen
// seen only through its views shows the first of them that has a photo.
const shot = new Set(understood.screens.map((s) => s.meta.path));
const standIn = (s: (typeof screens)[number]) => (shot.has(s.path) ? undefined : s.views?.find((v) => shot.has(v.path))?.path);
const listed = new Set(screens.flatMap((s) => [s.path, ...[standIn(s)].filter((p) => p !== undefined), ...(s.views ?? []).filter((v) => tabBase(v.path) !== undefined).map((v) => v.path)]));
prepareOut();
const earlier = { manifest: readIfThere(join(out, MANIFEST)), map: readIfThere(join(out, "map.json")), product: readIfThere(join(out, "PRODUCT.md")) };
const photos: Record<string, string> = {};
for (const shot of understood.screens) if (listed.has(shot.meta.path)) photos[shot.meta.path] = `screens/${photoName(shot.meta.path)}`;

// Only what the AI read from the screens: "traffic" here is the learner's own presses, not people's.
const readMain = understood.understanding.mainAction?.source === "traffic" ? null : understood.understanding.mainAction;
/**
 * Two things. A sign-in stood in the way, and nothing got past it: the list can't speak for what's
 * behind it, whatever else the site does, and says so. And what PRODUCT.md then says about the site:
 * that people sign in first is only so if nothing public saved anything.
 */
const standInGotThere = scan.standIn?.status === "reached";
const stoppedAtDoor = !standInGotThere && stoppedAtSignIn(scan, understood, !interrupted);
const signInFirst = stoppedAtDoor && actions.every((a) => a.kind === "read");
/** What's left to offer, for a run a sign-in held up: only what this run didn't already do, or can't. */
const wallOffer = ((): NonNullable<NonNullable<ProductMap["learner"]>["wallOffer"]> | undefined => {
  const isProject = repoRootOf(process.cwd()) !== undefined || existsSync("package.json");
  if (standInGotThere) return !codeRead && !flag("no-code") && ai && repoRootOf(codeRoot) ? "add-code" : undefined;
  if (!stoppedAtDoor) return undefined;
  if (!local) return isProject ? "go-local" : "login";
  if (codeRead) return "login";
  if (ai && repoRootOf(codeRoot)) return flag("no-code") ? "drop-no-code" : "add-code";
  return "read-code";
})();
/** Seen only by the made-up user: marked wherever it goes, and never compared between runs. */
const madeUp = (path: string) => scan.seenWith?.[path] === "stand-in";
/**
 * The main action, by one order, whatever a run's length: what was really seen, then what the code
 * says, then what only the stand-in saw, marked. One made-up save seen in a short run doesn't outrank
 * a read of the whole product, and a longer run doesn't change the answer for that reason alone.
 */
const mainRestsOn = readMain?.id ? actions.find((a) => a.id === readMain.id) : undefined;
const madeUpMain = readMain && scan.standIn?.status === "reached" && (mainRestsOn ? mainRestsOn.pages.length > 0 && mainRestsOn.pages.every(madeUp) : !actions.some((a) => a.kind !== "read" && !a.pages.every(madeUp)));
const mainAction = !readMain || !madeUpMain ? readMain : codeRead?.ran && codeRead.fromCode.mainAction ? null : { ...readMain, seenWith: "stand-in" as const };
/** The learner may report these as a list or a count: either way, how many. */
const heldBack = (held: unknown) => (Array.isArray(held) ? held.length : typeof held === "number" ? held : 0);
const linksHeldBack = heldBack((scan as { linksHeldBack?: unknown }).linksHeldBack);
const learned = {
  schemaVersion: MAP_SCHEMA,
  url: shownUrl,
  learnedAt: new Date().toISOString(),
  product: understood.understanding.product,
  mainAction,
  ...(understood.understanding.noMainAction ? { noMainAction: understood.understanding.noMainAction } : {}),
  setupSteps: understood.understanding.prerequisites,
  journeys: understood.understanding.flows,
  screens: screens.map((s) => ({
    path: s.path,
    ...(scan.addresses?.[s.path] ? { address: redact(scan.addresses[s.path]!) } : {}),
    title: s.snapshot.title ?? null,
    headings: s.snapshot.headings.slice(0, 3),
    photo: photos[standIn(s) ?? s.path] ?? null,
    ...(s.views?.length ? { views: s.views.map((v) => ({ ...v, photo: v.path === standIn(s) ? null : photos[v.path] ?? null })) } : {}),
    ...(madeUp(s.path) ? { seenWith: "stand-in" as const, ...(scan.standIn?.rowsShown ? { madeUpData: true as const } : {}) } : {}),
  })),
  // Saves and reads both: the reads (loading data, templates, text) are here only, not in PRODUCT.md or the summary.
  actions: actions.map((a) => ({ id: a.id, name: a.name, does: a.does ?? null, onScreen: a.onScreen ?? null, kind: a.kind, request: `${a.request.method} ${a.request.path}`, pages: a.pages, ...(a.pages.length && a.pages.every(madeUp) ? { seenWith: "stand-in" as const } : {}) })),
  // A failed request or a broken link can carry a token in its address: taken out, as from the start address.
  findings: scan.findings.map((f): Finding => ({ ...f, screen: understood.screenOf(f.screen), target: redact(f.target), evidence: redact(f.evidence) })),
  // Guesses made from all of the above (predictions.ts), kept apart from the proven findings wherever they're shown.
  predictions: [] as Prediction[],
  // Read, not seen: apart from all of the above, and from diff.
  ...(codeRead?.ran ? { fromCode: codeRead.fromCode } : {}),
  learner: {
    visited: scan.pagesVisited.length,
    stoppedBy: interrupted ? "interrupted" : scan.stoppedBy,
    savesStopped: scan.blockedWrites.length,
    ...(flag("create") ? {} : { sentByPage: scan.ambientWrites.filter((w) => !w.seenWith).reduce((n, w) => n + w.count, 0) }),
    ...(scan.ambientWrites.some((w) => w.seenWith) ? { sentAsStandIn: scan.ambientWrites.filter((w) => w.seenWith).reduce((n, w) => n + w.count, 0) } : {}),
    ...(scan.stayedAway?.length ? { stayedAway: scan.stayedAway.slice(0, 40) } : {}),
    ...(scan.proxiedHeld?.length ? { proxiedHeld: scan.proxiedHeld.slice(0, 40) } : {}),
    ...(scan.proxyUnread ? { proxyUnread: true as const } : {}),
    savesWentThrough: flag("create"),
    seconds: Math.round((Date.now() - begun) / 1000),
    errors: [...scan.errors.slice(0, 20), ...(readingFailed ? [`AI reading: ${readingFailed}`] : [])].map(redact),
    ...(readingFailed ? { readingError: redact(readingFailed) } : {}),
    // What the stopped saves were, so a count of them that the actions don't explain is explained.
    ...(flag("create") ? {} : { stoppedFrom: stoppedFrom(scan.blockedWrites.length, actions, understood.plumbing) }),
    ...(signInFirst ? { signInFirst } : {}),
    ...(stoppedAtDoor ? { stoppedAtDoor } : {}),
    ...(linksHeldBack ? { linksHeldBack } : {}),
    ...(scan.standIn ? { standIn: { status: scan.standIn.status, message: redact(scan.standIn.message), ...(scan.standIn.provider ? { provider: scan.standIn.provider } : {}), reached: scan.standIn.reached.length, notReached: scan.standIn.notReached.map((n) => ({ ...n, path: redact(n.path) })), ...(scan.standIn.errors.length ? { errors: scan.standIn.errors.slice(0, 10).map(redact) } : {}), ...(scan.standIn.stoppedBy ? { stoppedBy: scan.standIn.stoppedBy } : {}), ...(scan.standIn.rowsShown ? { rowsShown: true } : {}) } } : {}),
    // What left the machine stays on record, whether or not anything came of it.
    ...(codeRead ? { codeRead: codeRead.ran ? { ran: true, filesSent: codeRead.fromCode.coverage.filesSent, reused: codeRead.reused, costUsd: codeRead.costUsd, ...(codeRead.routesAgain && !codeRead.reused ? { routesAgain: codeRead.routesAgain } : {}) } : { ran: false, why: codeRead.why, reason: redact(codeRead.reason), filesSent: codeRead.filesSent, costUsd: codeRead.costUsd } } : {}),
    ...(wallOffer ? { wallOffer } : {}),
    ...(aiChoice ? { aiFlag: aiChoice } : {}),
    measured: new Set([...scan.reviews, ...(scan.newUser?.screens ?? [])].map((r) => r.path)).size,
    timing: { stages, scan: scan.timings, asks },
    // Every question to the AI added up, as the last rows say it: tokens as the AI said, dollars only where it gave a price.
    ...(ai && asks.length ? { ai: { via: ai.via, ...aiTotals(asks)! } } : {}),
    review: { ran: review.ran, ...(review.why ? { why: review.why } : {}), screens: review.screens, raised: review.raised, kept: review.items.length, dropped: review.dropped, seconds: Math.round(review.ms / 1000), ...(review.reused ? { reused: true } : {}), ...(review.error ? { error: redact(review.error) } : {}), ...(review.codeLinesSent ? { codeLinesSent: review.codeLinesSent } : {}) },
  },
} satisfies ProductMap;
// Guessed from the learner's own addresses, which is what the controls go by; then every address in
// the map is written as it opens in a browser, so what it prints can be followed.
const walk = { signedIn: Boolean(session) || scan.loggedIn, mayKeepData: mayKeepDataHere(understood.screens.map((s) => s.meta)) };
// The list of what to fix: from what was seen, what was measured and what the review could back up.
const proofs = new Map<string, Buffer>();
/** Where each item's problem is on its own photo, for report.html's red box: kept beside the map, which stays as it was. */
const photoBoxes = new Map<string, PhotoBoxes>();
const screenPhoto = (path: string) => learned.screens.find((s) => s.path === path)?.photo;
/** A new account's screens, apart from the rest: the same address may show another photo with made-up rows. */
const newUserPhotos = new Map((scan.newUser?.photos ?? []).map((shot) => [shot.path, shot]));
const newUserPhoto = (path: string) => (newUserPhotos.has(path) ? `screens/new-user-${photoName(path)}` : null);
/** So are the look with one row's: a count of one is on these. */
const oneRowShots = scan.oneRowPhotos ?? [];
const oneRowPhoto = (path: string) => oneRowShots.find((shot) => shot.path === path || understood.screenOf(shot.path) === path);
const navLabels = [...new Set([...scan.reviews, ...(scan.newUser?.screens ?? [])].flatMap((r) => r.controls.filter((c) => c.where === "nav").map((c) => c.label)))];
const fixes = buildFixes({ journeys: journeyReport, findings: learned.findings, checks: scan.checks.map((check) => ({ ...check, target: redact(check.target), evidence: redact(check.evidence), ...(check.by ? { by: redact(check.by) } : {}), ...(check.byWords ? { byWords: check.byWords.map(redact) } : {}) })), review, newUser: newUserWalked, fromCode, sources, screenOf: understood.screenOf, map: learned, navLabels }).map(({ proof, oneRow, boxes, ...fix }): Fix => {
  if (proof) proofs.set(`screens/fix-${fix.id}.jpg`, proof);
  // The boxes are in the photo's own pixels: its size, read from it, places them.
  const size = proof && boxes?.length ? jpegSize(proof) : undefined;
  if (size && boxes) photoBoxes.set(fix.id, { boxes, ...size });
  const photo = fixPhoto({ ...fix, ...(oneRow ? { oneRow } : {}) }, {
    ...(proof ? { proof: `screens/fix-${fix.id}.jpg` } : {}),
    screen: screenPhoto,
    newUser: newUserPhoto,
    oneRow: (path) => {
      const shot = oneRowPhoto(path);
      return shot ? `screens/one-row-${photoName(shot.path)}` : null;
    },
  });
  return { ...fix, ...(photo ? { photo } : {}) };
});
const newUser = newUserWalked && {
  status: newUserWalked.status,
  message: redact(newUserWalked.message),
  ...(newUserWalked.first ? { first: newUserWalked.first } : {}),
  screens: newUserWalked.screens.map((s) => ({ path: s.path, ...(s.heading ? { heading: redact(s.heading) } : {}), ...(s.gate ? { gate: s.gate } : {}), photo: newUserPhoto(s.path), seenWith: "stand-in" as const })),
  firstRun: newUserWalked.firstRun.map((f) => ({ ...f, path: redact(f.path), ...(f.landed ? { landed: redact(f.landed) } : {}) })),
  notReached: newUserWalked.notReached.map((n) => ({ ...n, path: redact(n.path) })),
};
const journeyWalk = journeyReport ? journeyMap(journeyReport, redact) : journeysNotWalked(whyNoJourneys({ realSession: Boolean(session) || flag("create"), asked: !flag("no-journeys"), local, standInAllowed: wall.standIn, standIn: scan.standIn, newUser: scan.newUser }));
const map = withLiveAddresses({ ...learned, ...(learned.noMainAction ? { noMainAction: keptNoMainAction({ ...learned, journeyWalk }, walk) } : {}), predictions: predict(learned, { controls: understood.controls }), fixes, ...(newUser ? { newUser } : {}), journeyWalk });
/** What the last run here listed and this one doesn't: gone from a list isn't the same as fixed. */
const gone = goneSince(earlier.map, map.fixes, map);
if (gone.length) Object.assign(map, { gone });
/** And what it lists that the last run didn't: new is what to fix first. Matched the same way, so a reworded item isn't new. */
const since = newSince(earlier.map, map.fixes, map);
Object.assign(map, { fixes: since.fixes, ...(since.sinceLast ? { sinceLast: since.sinceLast } : {}) });
const { predictions } = map;
if (reviewGroup) {
  // Only what the review itself raised: a plain rule's prediction isn't the AI's.
  const predicted = (map.fixes ?? []).filter((f) => f.status === "predicted" && f.from === "review").length;
  /** Predictions of the plain rules, counted beside the AI's in the Findings row: "none predicted" here would read against it. */
  const others = (map.fixes ?? []).filter((f) => f.status === "predicted" && f.from !== "review").length + predictions.length;
  const failed = readingFailed || review.why === "failed" || review.why === "too-slow";
  const didnt: Record<string, string> = { stopped: "stopped before it began", "no-screens": "no screens to review", "no-ai": "no AI" };
  // What the AI was asked for the reading and the review, beside the time: tokens and how many were cached.
  const usage = usageWords(aiTotals(asks.filter((a) => a.part === "review")), { plan: ai?.plan });
  const detail = (...said: (string | undefined)[]) => said.filter(Boolean).join(" · ") || undefined;
  if (failed) reviewGroup.end("warned", "didn't work, see below", usage, reviewEnded);
  else if (!review.ran) reviewGroup.end("warned", "didn't run", detail(didnt[review.why ?? ""], usage), reviewEnded);
  // None of its own is said as what it reviewed, so it can't be read against the plain rules' predictions listed below it.
  // Short, so it stays one line with its time and tokens at 80 columns ("7 reviewed · AI found none  13s  ai 11.7k tokens · 81% cached").
  else reviewGroup.end("done", predicted ? `${predicted} predicted` : `${review.screens} reviewed · ${others ? "AI found none" : "none predicted"}`, detail(review.reused ? "screens unchanged, last review reused" : undefined, usage), reviewEnded);
}

// Only photos the map refers to are written, so what is on disk and what it says always agree.
const referred = new Set(referredPhotos(map));
for (const shot of understood.screens) {
  const photo = photos[shot.meta.path];
  if (!photo || !referred.has(photo)) continue;
  mkdirSync(join(out, "screens"), { recursive: true });
  writeFileSync(join(out, photo), shot.jpeg);
}
for (const [photo, jpeg] of [...proofs, ...[...newUserPhotos.values()].map((shot) => [newUserPhoto(shot.path)!, shot.jpeg] as const), ...oneRowShots.map((shot) => [`screens/one-row-${photoName(shot.path)}`, shot.jpeg] as const)]) {
  if (!referred.has(photo)) continue;
  mkdirSync(join(out, "screens"), { recursive: true });
  writeFileSync(join(out, photo), jpeg);
}
const productText = productDoc(map, features, start, predictions, walk);
// What a person wrote in PRODUCT.md stays: this run's goes beside it (see productFile).
const product = productFile({ manifest: earlier.manifest, onDisk: earlier.product }, productText);
const written = ["map.json", FIX_FILE, product.file, "report.html", ...referred];
writeFileSync(join(out, "map.json"), `${JSON.stringify(map, null, 2)}\n`);
writeFileSync(join(out, product.file), productText);
writeFileSync(join(out, FIX_FILE), fixDoc(map, start));
// Always: a string, so it costs nothing, and it's the page a person reads (--html is kept, and does nothing).
writeFileSync(join(out, "report.html"), reportPage(map, start, photoBoxes, shown));
// What an earlier run wrote and this one didn't (a screen that's gone): only ever files of ours.
for (const file of filesToClear(earlier, written)) rmSync(join(out, file), { force: true });
writeFileSync(join(out, MANIFEST), `${JSON.stringify({ schemaVersion: "files-1", about: "The files contextmachines wrote in this folder: the only ones it will ever remove.", files: written, ...(product.hash ? { productHash: product.hash } : {}) }, null, 2)}\n`);
run.stop(interrupted ? "stopped" : "done");
screen = undefined;

const readingWarning = readingFailed ? `The AI reading didn't work (${safe(redact(readingFailed))}), so the product, main action and journeys are missing; screens, actions and issues were written.` : "";
const reviewWarning = review.why === "failed" || review.why === "too-slow" ? `The AI's review of the screens didn't work (${safe(redact(review.error ?? "no reason given"))}), so only what was measured is listed.` : "";
const warning = [readingWarning, reviewWarning].filter(Boolean).join(" ");
const exitCode = interrupted ? EXIT.interrupted : flag("fail-on-issues") && provenCount(map) ? EXIT.issues : EXIT.learned;
if (json) {
  if (warning) process.stderr.write(`${errColors.yellow("!")} ${warning}\n`);
  if (product.file === PRODUCT_NEW) process.stderr.write(`${errColors.yellow("!")} ${shown}/PRODUCT.md isn't the one it last wrote, so it was left as it is; this run's is ${shown}/${PRODUCT_NEW}\n`);
  process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
  await journeysClosed;
  await exitWhenWritten(exitCode);
}

/** Links to files in the list, where the terminal opens them (see linksWanted). */
const links = !json ? linksWanted(process.stdout) : undefined;
const facts = { ...walk, out: shown, html: true, ...(links ? { to: { links, outDir: out, codeDir: codeRoot } } : {}), readingReused, issues: groupFindings(map.findings).length, product: product.file, all: flag("all") };
// The menu at the end, worked out before the summary is printed: where it shows, it is the hand-off,
// and the summary's own "→ Hand …" line would only say it twice.
const fixFile = `${shown}/${FIX_FILE}`;
const page = `${shown}/report.html`;
const opener = openerFor();
const clipboard = clipboardFor();
// The agent starts in this folder: never offered where the app's code isn't, as it would have nothing to fix.
const offer = { count: map.fixes.length, agent: agentHere(ai?.agent, !noCodeHere && !servedElsewhere), more: !flag("all") && fixRest(map.fixes).length > 0, open: Boolean(opener), copy: Boolean(clipboard) };
// A terminal wide enough for the menu's one line, colour or not (NO_COLOR keeps the menu: it's only bold and a cleared line).
const menuFits = !json && Boolean(process.stdout.isTTY) && columnsOf(process.stdout) >= LIVE_MIN_COLUMNS;
const person = !interrupted && keyWanted({ stdin: process.stdin, stdout: process.stdout, live: menuFits, json, noPrompt: flag("no-prompt"), foreground: inForeground });
const menuShown = person && menuKeys(offer).length > 0;
const handOff = fixNext();
const next = menuShown && handOff ? "" : handOff ?? wallNext(map, detectUrl(process.cwd()).url) ?? agentHint() ?? `Next: read ${shown}/${product.file}`;
if (flag("verbose")) summary(outColors);
else for (const line of resultLines(map, { ...facts, noAi: !ai, ...(ai ? { ai: ai.via, plan: Boolean(ai.plan) } : {}), begun, warning, next, standInSaid }, outColors, columnsOf(process.stdout))) say(line);
// A person at the terminal: the menu, from "found" to "fixing" (see hand-off.ts). Everything is
// written and the exit code decided by now, and each wait ends on its own after KEY_WAIT_MS (see
// waitForKey). A script run at a terminal can't be told from a person, so it waits too, up to that
// cap, unless it passes --no-prompt or sets CONTEXTMACHINES_NO_PROMPT. A run in the background (&,
// or Ctrl-Z then bg) isn't offered it, since reading a key there would stop it (see inForeground).
// A Ctrl-C now is only "finished", since what was learned is already on disk. Not after a run
// stopped with Ctrl-C: that person wanted it over. Anywhere else, one plain line says where it all is.
let endCode: number | undefined;
if (menuShown) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stopRun);
  const cols = columnsOf(process.stdout);
  const c = outColors;
  const pathShown = (path: string, full: string) => (links ? linked(links.file(full), c.cyan(path)) : c.cyan(path));
  // The summary already ends on a blank line where its hand-off line is left out.
  if (next) say();
  /** Keys typed during the run are thrown away at the first wait only: one pressed straight after o or c is the next answer. */
  let waits = 0;
  endCode = await endMenu({
    offer,
    line: (keys) => menuLine(offer, keys, c, cols),
    wait: (hint, keys) => waitForKey(hint, { keys, ...(waits++ ? { settle: 0 } : {}) }),
    act: {
      a: () => {
        for (const line of moreFixLines(map, facts, c, cols)) say(line);
        say();
      },
      o: async () => {
        const opened = await openFile(opener!, join(out, "report.html"));
        say(`  ${opened ? c.ok("✓") : c.yellow("!")} ${opened ? "opened" : "couldn't open"} ${pathShown(page, join(out, "report.html"))}`);
      },
      c: () => {
        // Its photos named from here, as it's pasted into an agent here, not in the output folder.
        const copied = copyText(clipboard!, forPasting(readFileSync(join(out, FIX_FILE), "utf8"), shown));
        say(copied ? `  ${c.ok("✓")} copied ${FIX_FILE}, paste it into any coding agent` : `  ${c.yellow("!")} couldn't copy it: ${fixFile} is the file`);
      },
      f: async () => {
        // The terminal is the agent's now: waitForKey gave back its mode and cursor before this.
        const prompt = fixPrompt(fixFile);
        // Wrapped at words under its first line, as the hand-off line is: never cut mid-word by the terminal.
        say(`  ${c.grey(`starting ${AGENT_NAMES[offer.agent!]} with:`)}`);
        for (const line of wrapTo(prompt, Math.max(20, Math.min(cols, 100) - 4))) say(`    ${line}`);
        say();
        return startAgent(offer.agent!, prompt, { model: modelChoice });
      },
    },
    failed: (key, error) => say(`  ${c.yellow("!")} ${key === "c" ? "couldn't copy it" : key === "o" ? "couldn't open it" : "couldn't do that"}: ${safe(firstLine(error))}`),
  });
  // Done (or the wait ran out): where it all is stays on screen in the menu's place, as the last line.
  if (endCode === undefined) say(`  ${outColors.grey(handOff ? `The list: ${fixFile} · the page: ${page}` : `The page: ${page}`)}`);
} else say(`  ${outColors.grey(`The page: ${page}`)}`);
await journeysClosed;
await exitWhenWritten(endCode ?? exitCode);

/** "First run › Add one  8 steps": the name as it is, what came of it (after its two spaces) in grey. */
function nameThenGrey(text: string, c: Colors): string {
  const at = text.lastIndexOf("  ");
  return at < 0 ? text : `${text.slice(0, at)}${c.grey(text.slice(at))}`;
}

/** With something to fix, that's the next step, whatever else there is to say. */
function fixNext(): string | undefined {
  return map.fixes.length ? `Next: hand ${shown}/${FIX_FILE} to your coding agent` : undefined;
}

/** The result in full, for --verbose: the issues, what the product is, then the counts and where it all went. */
function summary(c: Colors): void {
  const cols = columnsOf(process.stdout);
  const nameOf = (path: string) => safe(screenName(map.screens, path));

  const wide = Math.min(cols, 100);
  for (const line of fixLines(map, facts, c, cols, { all: flag("all") })) say(line);
  /**
   * A labelled row under an issue: words wrapped beside the label, never cut. A file path is never
   * wrapped or cut either, so it can be copied and opened: beside its label when it fits, else on a
   * line of its own.
   */
  const row = (label: string, value: string, opts: { path?: boolean; color?: (s: string) => string } = {}) => {
    const color = opts.color ?? ((x: string) => x);
    if (opts.path) {
      if (13 + visibleWidth(value) <= cols) say(`     ${c.dim(label.padEnd(8))}${color(value)}`);
      else say(`     ${c.dim(label)}\n     ${color(value)}`);
      return;
    }
    wrapTo(value, Math.max(20, wide - 14), { whole: true }).forEach((line, n) => say(`     ${n === 0 ? c.dim(label.padEnd(8)) : " ".repeat(8)}${color(line)}`));
  };

  // What it saw go wrong: only what the browser proved, the worst first, each once, and issues that
  // share one cause (links from one page all answering 500) as one, with what each points at.
  const groups = groupFindings(map.findings);
  if (groups.length) {
    say();
    say(c.red(rule(`${plural(groups.length, "issue")} found`, wide - 2)));
    const shownIssues = groups.slice(0, 5);
    shownIssues.forEach((g, k) => {
      const f = g.findings[0]!;
      const single = g.findings.length === 1;
      say();
      // The title in full, wrapped under its number: cut short, an error message or an address says nothing.
      const head = `${k + 1}. `;
      wrapTo(safe(groupText(g)), Math.max(20, cols - 2 - head.length), { whole: true }).forEach((line, n) => say(`  ${c.bold(`${n === 0 ? head : " ".repeat(head.length)}${line}`)}`));
      const screen = map.screens.find((s) => s.path === f.screen);
      row("screen", `${safe(f.screen)}${screen && nameOf(f.screen) !== f.screen ? ` (${nameOf(f.screen)})` : ""}`);
      if (single && f.after) row("after", `pressing "${safe(f.after)}"`);
      if (single && f.evidence) row("proof", safe(f.kind === "crashes" ? `in ${f.evidence}` : f.evidence));
      if (single && f.count > 1) row("seen", `${f.count} times`);
      if (!single) {
        const targets = groupTargets(g);
        targets.slice(0, 8).forEach((t, n) => row(n === 0 ? "to" : "", safe(t), { path: true }));
        if (targets.length > 8) say(c.dim(`             …and ${targets.length - 8} more in PRODUCT.md`));
      }
      if (screen?.photo) row("photo", `${shown}/${screen.photo}`, { path: true, color: c.cyan });
    });
    if (groups.length > shownIssues.length) say(c.dim(`\n  …and ${groups.length - shownIssues.length} more in PRODUCT.md`));
  }

  // Guesses, kept apart from the proven issues above and never called issues.
  if (predictions.length) {
    say();
    say(`  ${c.bold("Might trip people up")} ${c.dim("(predictions, not proven)")}`);
    // What it's about and where, then the reason in full beneath: a guess is only worth its reason.
    for (const p of predictions.slice(0, 8)) {
      const about = wrapTo(safe(p.target), Math.max(20, wide - 6), { whole: true });
      const where = safe(p.screen);
      const last = about.length - 1;
      const fits = 4 + visibleWidth(about[last] ?? "") + 2 + visibleWidth(where) <= cols;
      about.forEach((line, n) => say(`  ${n === 0 ? c.yellow("?") : " "} ${line}${n === last && fits ? `  ${c.dim(where)}` : ""}`));
      if (!fits) say(`    ${c.dim(where)}`);
      for (const line of wrapTo(safe(p.why, 600), Math.max(20, wide - 6))) say(c.dim(`    ${line}`));
    }
    if (predictions.length > 8) say(c.dim(`  …and ${predictions.length - 8} more in PRODUCT.md`));
  }

  if (warning) {
    say();
    say(`${c.yellow("!")} ${warning}`);
  }
  if (!ai) {
    say();
    for (const line of wrapTo("Add an AI to have it read what the product is for and name every action: an API key, or sign in to Claude Code or Codex (see --help).", Math.min(cols, 100) - 4)) say(c.dim(`  ${line}`));
  }

  say();
  for (const line of rowLines(summaryRows(map, facts, c, cols), cols, c)) say(line);
  const hint = fixNext() ?? wallNext(map, detectUrl(process.cwd()).url) ?? agentHint();
  if (hint) {
    say();
    for (const line of nextLines(hint, c, Math.min(cols, 100))) say(line);
  }
}

/**
 * Where to point a coding agent, correctly: an @-path in CLAUDE.md or AGENTS.md is read from that
 * file's own folder. The default output folder sits in this folder, so its short form is right
 * here; any other is given from the root of the git repository it is in (where those files usually
 * are), or, outside one, in full. Nothing to say once one of those files already has it, as after init.
 */
function agentHint(): string | undefined {
  const at = (p: string) => `"@${/\s/.test(p) ? `"${p}"` : p}"`;
  const hasIt = (dir: string, p: string) => ["CLAUDE.md", "AGENTS.md"].some((file) => readIfThere(join(dir, file))?.includes(p));
  if (out === resolve("contextmachines")) return hasIt(".", "contextmachines/PRODUCT.md") ? undefined : `Next: add ${at("contextmachines/PRODUCT.md")} to CLAUDE.md or AGENTS.md here`;
  const root = repoRoot(out);
  if (root) {
    const path = relative(root, join(out, "PRODUCT.md")).split(sep).join("/");
    return hasIt(root, path) ? undefined : `Next: add ${at(path)} to CLAUDE.md or AGENTS.md at your repository's root`;
  }
  return hasIt(".", join(out, "PRODUCT.md")) ? undefined : `Next: add ${at(join(out, "PRODUCT.md"))} to CLAUDE.md or AGENTS.md (the full path, since it's outside any repository)`;
}

/** The git repository a folder is in: the nearest folder above it with a .git. */
function repoRoot(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

/**
 * Why the output folder can't be written, or undefined when it can. The folder is only made once
 * there is something to write, so where it doesn't exist yet, the nearest folder above it that does
 * is what has to be writable.
 */
function unwritable(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    let isFolder: boolean;
    try {
      isFolder = statSync(at).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Not there yet (or a file above it): look further up.
      if ((code === "ENOENT" || code === "ENOTDIR") && dirname(at) !== at) continue;
      return code === "EACCES" || code === "EPERM" ? "permission denied" : firstLine(error);
    }
    if (!isFolder) return at === dir ? "that is a file, not a folder" : `${at} is a file, not a folder`;
    try {
      accessSync(at, constants.W_OK);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EROFS" ? "the disk is read-only" : "permission denied";
    }
    return undefined;
  }
}

/**
 * The output folder, with a .gitignore that keeps the private files out of git: a saved sign-in
 * (--login) is a live session, and the reading caches are only for reuse. PRODUCT.md and the rest are
 * meant to be committed.
 */
function prepareOut(): void {
  outPrepared = true;
  mkdirSync(out, { recursive: true });
  const ignore = join(out, ".gitignore");
  const has = existsSync(ignore) ? readFileSync(ignore, "utf8").split(/\r?\n/) : [];
  const missingLines = [".session.json", ".reading.json", ".code-read.json", ".review.json"].filter((line) => !has.includes(line));
  if (missingLines.length) appendFileSync(ignore, `${has.length && has.at(-1) !== "" ? "\n" : ""}${missingLines.join("\n")}\n`);
}

function readIfThere(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** A map.json written by learn, or a usage error that says what was given instead. */
function readMap(file: string): ProductMap {
  const text = readIfThere(file);
  if (text === undefined) return fail(`There's no file at ${file}.`, EXIT.usage, { fix: "npx contextmachines diff before/map.json after/map.json" });
  try {
    const map = JSON.parse(text) as ProductMap;
    if (map && typeof map === "object" && Array.isArray(map.screens) && Array.isArray(map.actions) && Array.isArray(map.journeys)) return map;
  } catch {
    // not JSON: said below
  }
  return fail(`Couldn't read ${file}: it should be a map.json written by "contextmachines learn".`, EXIT.usage);
}

/** Playwright's own words for a browser that was never downloaded. */
function missing(error: unknown): boolean {
  return String(error).includes("Executable doesn't exist");
}

/** The browser to download, for the Playwright this runs with: a bare `npx playwright` may fetch another version, whose browser this one can't use. */
function missingBrowser(): never {
  let version = "";
  try {
    version = `@${(createRequire(import.meta.url)("playwright/package.json") as { version: string }).version}`;
  } catch {
    // not found: the plain command is still the right advice
  }
  return fail("contextmachines needs a browser to visit the site, and none is installed.", EXIT.couldNot, { fix: `npx playwright${version} install chromium` });
}
