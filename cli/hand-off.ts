/**
 * The end of a run, from "found" to "fixing": a one-line menu that hands the list on. f starts the
 * person's own coding agent on FIX.md, in this terminal; o opens report.html; a lists the rest here;
 * c copies FIX.md for any other agent. Every command it starts is looked up on PATH first and passed
 * in, so a test can stand a pretend one in its place, and the real `claude` is never started by one.
 *
 * Only a person at a terminal gets the menu (keyWanted): never an agent, CI, a pipe or --json.
 * Starting their agent on their repository is that person's own keypress, so nothing more is asked.
 */
import { spawn as spawnChild, spawnSync as spawnChildSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { visibleWidth, type Colors, type KeyEnd, type MenuKey } from "./term.ts";

/** A coding agent's command, as the run's AI used it (--ai claude-code or --ai codex). */
export type Agent = "claude" | "codex";

/** What each agent is called to a person. */
export const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };

/** A command and the arguments before what it's given. */
export interface Command {
  command: string;
  args: string[];
  /** Exit codes besides 0 that still mean it worked (Windows' explorer says 1 when it has opened the file). */
  ok?: number[];
}

/**
 * Whether a command is on PATH, as the shell would find it: a file it may run, in one of PATH's
 * folders (with PATHEXT's endings on Windows). Read from the disk only: nothing is started to ask.
 */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const endings = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ending of endings) {
      const file = join(dir, `${command}${ending}`);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return true;
      } catch {
        // not here, or not one it may run: on to the next
      }
    }
  }
  return false;
}

/**
 * The agent to hand the list to: only the one the run itself used, and only when its command is on
 * PATH. With an API key there's no agent, and none is guessed: a person with two would be surprised.
 */
export function agentFor(used: Agent | undefined, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Agent | undefined {
  return used && platform !== "win32" && onPath(used, env, platform) ? used : undefined;
}

/**
 * The agent f starts, here: none where this folder holds no app's code (a home folder, or a server
 * run from another folder), as it would start where there's nothing to fix. Else as agentFor says.
 */
export function agentHere(used: Agent | undefined, appCodeHere: boolean, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Agent | undefined {
  return appCodeHere ? agentFor(used, env, platform) : undefined;
}

/** The one short ask the agent starts with: the file, in order, and that each item's evidence is checked first. */
export function fixPrompt(fixFile: string): string {
  return `Fix the problems in ${fixFile}, proven ones first. Each has evidence: check it before changing code, and say which you fixed.`;
}

/** The OS's own way to open a file with what the person uses for it: open, xdg-open, or explorer. */
export function openerFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Command | undefined {
  if (platform === "darwin") return { command: "open", args: [] };
  // Never through cmd (start is cmd's own): cmd reads & and %NAME% in a path, even quoted, so a
  // folder named "R&D" would run what follows it. explorer takes the path as it is.
  if (platform === "win32") return { command: "explorer.exe", args: [], ok: [1] };
  return onPath("xdg-open", env, platform) ? { command: "xdg-open", args: [] } : undefined;
}

/** A clipboard to copy into, where one is there: pbcopy, clip, wl-copy on Wayland, xclip on X. None: c isn't offered. */
export function clipboardFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Command | undefined {
  if (platform === "darwin") return onPath("pbcopy", env, platform) ? { command: "pbcopy", args: [] } : undefined;
  if (platform === "win32") return { command: "clip", args: [] };
  if (env.WAYLAND_DISPLAY && onPath("wl-copy", env, platform)) return { command: "wl-copy", args: [] };
  if (env.DISPLAY && onPath("xclip", env, platform)) return { command: "xclip", args: ["-selection", "clipboard"] };
  return undefined;
}

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => { on(event: "error" | "exit", listener: (...args: never[]) => void): unknown; unref(): unknown };
type SpawnSync = (command: string, args: readonly string[], options: SpawnSyncOptions) => { status: number | null; error?: Error };

/**
 * A file opened as a double-click would, left to run on its own: the run doesn't wait for the
 * browser, and a browser that's slow to start never holds the menu. False when it couldn't start.
 */
export function openFile(opener: Command, path: string, spawn: Spawn = spawnChild as unknown as Spawn): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.command, [...opener.args, path], { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      // open and xdg-open hand the file on and exit at once, saying whether it went: waited for up to
      // a second, after which an opener still running is taken to have done it.
      const timer = setTimeout(() => resolve(true), 1000);
      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        resolve(code === 0 || (code !== null && Boolean(opener.ok?.includes(code))));
      });
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Text into the clipboard, given on the tool's stdin. True when it took it. */
export function copyText(clipboard: Command, text: string, spawnSync: SpawnSync = spawnChildSync as unknown as SpawnSync): boolean {
  try {
    const done = spawnSync(clipboard.command, clipboard.args, { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 3000 });
    return !done.error && done.status === 0;
  } catch {
    return false;
  }
}

/** What the agent's start listens to besides it: SIGINT, so Ctrl-C is the agent's, not this run's. */
export interface AgentSignals {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

/**
 * The person's own agent started on the list, in this terminal: its stdin, stdout and stderr are
 * this one's, and this process waits and ends with its code. Ctrl-C while it runs goes to the agent
 * (the terminal sends it to both); this process lets it pass, and ends when the agent does. The run's
 * --model goes with it: the agent's own default may be one the person's plan can't use.
 */
export function startAgent(agent: Agent, prompt: string, { model, spawn = spawnChild as unknown as Spawn, env = process.env, signals = process as AgentSignals }: { model?: string; spawn?: Spawn; env?: NodeJS.ProcessEnv; signals?: AgentSignals } = {}): Promise<number> {
  return new Promise((resolve) => {
    const pass = () => {};
    signals.on("SIGINT", pass);
    const end = (code: number) => {
      signals.off("SIGINT", pass);
      resolve(code);
    };
    try {
      const child = spawn(agent, [...(model ? [agent === "codex" ? "-m" : "--model", model] : []), prompt], { stdio: "inherit", env });
      child.on("error", () => end(127));
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => end(code ?? (signal === "SIGINT" ? 130 : 1)));
    } catch {
      end(127);
    }
  });
}

/** What the menu can offer this run: a key is there only when it can do something. */
export interface MenuOffer {
  /** Items on the list. */
  count: number;
  agent?: Agent;
  /** Items the summary left out, for a. */
  more: boolean;
  open: boolean;
  copy: boolean;
}

/** The keys to offer, in the order they're shown: f first, as the reason for the menu. Nothing to fix: no f, a or c. */
export function menuKeys(offer: MenuOffer): MenuKey[] {
  const some = offer.count > 0;
  return [...(some && offer.agent ? (["f"] as const) : []), ...(offer.open ? (["o"] as const) : []), ...(some && offer.more ? (["a"] as const) : []), ...(some && offer.copy ? (["c"] as const) : [])];
}

/**
 * The menu in one line: "10 problems · f fix them with Claude Code · o see them all · a list here ·
 * c copy FIX.md · Enter done". One line always, as it's cleared again in place (a wrapped line can't
 * be): shorter words where the full ones don't fit, then the keys alone.
 */
export function menuLine(offer: Pick<MenuOffer, "count" | "agent">, keys: readonly MenuKey[], c: Colors, cols: number): string {
  const name = offer.agent ? AGENT_NAMES[offer.agent] : "";
  const one = offer.count === 1;
  // Each tier names what its keys do in fewer columns, and f keeps the agent's name to the last
  // but one: which agent starts is what a person needs to know before pressing it.
  const tiers: { count: boolean; words: Record<MenuKey, string> }[] = [
    { count: true, words: { f: `fix ${one ? "it" : "them"} with ${name}`, o: one ? "see it" : offer.count ? "see them all" : "see the screens", a: "list here", c: "copy FIX.md" } },
    { count: true, words: { f: `fix with ${name}`, o: one ? "see it" : offer.count ? "see the page" : "see the screens", a: "list here", c: "copy FIX.md" } },
    // The count goes before the agent's name does: the summary above has said how many.
    { count: false, words: { f: `fix with ${name}`, o: "page", a: "rest", c: "copy list" } },
    { count: false, words: { f: name, o: "page", a: "rest", c: "copy" } },
    { count: false, words: { f: "", o: "", a: "", c: "" } },
  ];
  const count = offer.count ? `${offer.count} ${offer.count === 1 ? "problem" : "problems"}` : "";
  let line = "";
  for (const tier of tiers) {
    const parts = [...(tier.count && count ? [c.grey(count)] : []), ...keys.map((k) => (tier.words[k] ? `${c.bold(k)} ${c.grey(tier.words[k])}` : c.bold(k))), tier.words.f || tier.words.o ? `${c.bold("Enter")} ${c.grey("done")}` : c.bold("Enter")];
    line = `  ${parts.join(c.grey(" · "))}`;
    // One column spare: a line that fills the last one leaves the cursor waiting to wrap.
    if (visibleWidth(line) < cols) return line;
  }
  return line;
}

/**
 * The menu, until the person is done: each key does its part and the menu comes back, but f, which
 * ends the run with the agent's code. a lists once and is gone from the menu after. What comes back
 * is the code to end with, or undefined to end as the run decided.
 */
export async function endMenu({ offer, wait, line, act, failed = () => {} }: { offer: MenuOffer; wait: (hint: string, keys: readonly MenuKey[]) => Promise<KeyEnd>; line: (keys: readonly MenuKey[]) => string; act: Record<MenuKey, () => Promise<number | void> | number | void>; failed?: (key: MenuKey, error: unknown) => void }): Promise<number | undefined> {
  let keys = menuKeys(offer);
  for (;;) {
    const key = await wait(line(keys), keys);
    if (key === "done" || key === "timeout") return undefined;
    // A key that goes wrong (FIX.md gone from under it, say) is said and the menu comes back: the run's
    // work is on disk, and a stack trace here would be the last thing on screen.
    let code: number | void = undefined;
    try {
      code = await act[key]();
    } catch (error) {
      failed(key, error);
      if (key !== "f") continue;
    }
    if (key === "f") return typeof code === "number" ? code : undefined;
    if (key === "a") keys = keys.filter((k) => k !== "a");
  }
}
