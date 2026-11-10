/**
 * The terminal, done carefully: colour only where it will show, a site's own text made harmless
 * before it is printed, widths measured as the terminal draws them, one live status row, did-you-mean
 * for typos, and the two questions the command line ever asks. No browser and no AI here, so all of
 * it can be checked by tests (report.test.ts).
 */
import { execFileSync } from "node:child_process";
import { release } from "node:os";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

export interface Colors {
  enabled: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  underline: (s: string) => string;
  /** Text and background swapped: a label that reads as a badge. */
  inverse: (s: string) => string;
  /** A detail beside a name (a time, a count of steps): dimmed, as a test runner greys its times. */
  grey: (s: string) => string;
  /** A tick that something went well: the theme's own green. */
  ok: (s: string) => string;
  /** Words in black on a block of the terminal's own colour, or in inverse: a badge, the way a test runner marks its parts. */
  badge: (tone: Tone, s: string) => string;
}

/** A badge's colour. Never red: on a terminal, red is for what went wrong. */
export type Tone = "green" | "yellow" | "cyan" | "grey" | "magenta" | "inverse";

/**
 * Each tone as one of the 16 background colours every terminal has, so a badge follows the person's
 * own theme, as a test runner's do (green, yellow and cyan, as e2e marks web, ios and android). The
 * same codes at every colour level: nothing is drawn from a palette of our own. Black text on each
 * stays readable in the common themes (Terminal.app, iTerm2, VS Code dark and light, xterm): measured,
 * the worst is bright black at 3.7 to 1. So no blue, normal or bright (black on Terminal.app's is
 * 1.6 to 1 and 2.4 to 1), and no white, normal or bright: VS Code's light theme draws white as a dark
 * grey (2.8 to 1), and bright white is no block at all on a white background. The one more a run
 * needs is the terminal's own text and background swapped (inverse, below): a block on every theme,
 * never the colour of another badge.
 */
export const TONES: Record<Exclude<Tone, "inverse">, number> = {
  green: 42,
  yellow: 43,
  cyan: 46,
  grey: 100,
  magenta: 105,
};

/**
 * Whether a stream should get colour, decided once per stream the way picocolors decides it:
 * NO_COLOR turns it off, FORCE_COLOR on, a dumb terminal off, and otherwise a terminal or a CI log
 * (CI logs show colour) gets it. A pipe or a file never does. Only the 16 colours every terminal has
 * are used, so how many more a terminal has doesn't matter.
 */
export function colorWanted(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY) || Boolean(env.CI);
}

/** Colours, or none: plain text with no escape codes. */
export function colors(enabled: boolean): Colors {
  // Each closes with its own reset code, so a colour inside another (dim inside bold) doesn't end both.
  const code = (open: number | string, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const dim = code(2, 22);
  const green = code(32, 39);
  return {
    enabled,
    bold: code(1, 22),
    dim,
    red: code(31, 39),
    green,
    yellow: code(33, 39),
    cyan: code(36, 39),
    blue: code(34, 39),
    magenta: code(35, 39),
    underline: code(4, 24),
    inverse: code(7, 27),
    grey: dim,
    ok: green,
    // Black text on the block, closed with both resets, so it never runs on into what follows.
    // Inverse swaps the theme's own text and background, so its words are the background's colour.
    badge: (tone, s) => (!enabled ? s : tone === "inverse" ? `\x1b[7m${s}\x1b[27m` : `\x1b[${TONES[tone]};30m${s}\x1b[39;49m`),
  };
}

/** How long one piece of a site's text may be in the terminal, in UTF-8 bytes. */
const MAX_FIELD_BYTES = 400;

/**
 * A site's own text, made safe to print: a page can put escape sequences in a button label or an
 * error message, which would otherwise move the cursor, recolour the terminal or retitle the window.
 * Escape sequences are dropped, any other control character shows as U+FFFD, line breaks and tabs
 * become spaces (each field is one line), and it is cut to a length on a character boundary.
 */
export function safe(text: unknown, maxBytes = MAX_FIELD_BYTES): string {
  const plain = stripVTControlCharacters(String(text ?? ""))
    .replace(/[\t\r\n]+/g, " ")
    // C0 controls (but tab and line breaks, handled above), DEL and the C1 controls.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
  return truncateBytes(plain, maxBytes);
}

/** Text cut to at most `maxBytes` of UTF-8, ending with "…" when cut, never in the middle of a character. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  const budget = maxBytes - 3; // "…" is three bytes
  for (const { segment } of SEGMENTER.segment(text)) {
    const size = Buffer.byteLength(segment);
    if (bytes + size > budget) break;
    out += segment;
    bytes += size;
  }
  return `${out}…`;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How many columns a character takes: two for wide East Asian characters and emoji, none for joiners. */
function clusterWidth(cluster: string): number {
  const cp = cluster.codePointAt(0) ?? 0;
  if (cp === 0 || /^\p{Mark}+$/u.test(cluster) || cp === 0x200b || cp === 0x200d || cp === 0xfeff) return 0;
  if (/\p{Extended_Pictographic}/u.test(cluster) && (cluster.includes("️") || cp >= 0x1f000)) return 2;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/**
 * A link's own codes (OSC 8, ended by BEL or ST): Node's stripVTControlCharacters leaves an address
 * with a space or a bracket in it half there, so links are taken out first, whole.
 */
const LINK_CODES = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** A line as it reads on screen: no colours, no links' addresses. */
const onScreen = (text: string) => stripVTControlCharacters(text.replace(LINK_CODES, ""));

/** How wide a line is on screen, in columns: colour codes and links' addresses take none, wide characters two. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const { segment } of SEGMENTER.segment(onScreen(text))) width += clusterWidth(segment);
  return width;
}

/** Plain text clipped to `columns` on screen, with "…" inside the budget when it doesn't fit. */
export function fit(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text;
  let out = "";
  let width = 0;
  for (const { segment } of SEGMENTER.segment(onScreen(text))) {
    const w = clusterWidth(segment);
    if (width + w > columns - 1) break;
    out += segment;
    width += w;
  }
  return `${out}…`;
}

/**
 * A line clipped to `columns` on screen with its colours kept: the codes before the cut stay, "…"
 * takes the last column, and every colour is closed after it, so nothing runs on into the next line.
 */
export function cut(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text;
  let out = "";
  let width = 0;
  let coloured = false;
  let linked = false;
  // A link cut inside is closed too, or the rest of the terminal would be part of it.
  const end = () => `${out}…${linked ? LINK_END : ""}${coloured ? "\x1b[0m" : ""}`;
  for (const piece of text.split(/(\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/)) {
    if (piece.startsWith("\x1b]")) {
      out += piece;
      linked = piece !== LINK_END;
      continue;
    }
    if (piece.startsWith("\x1b[")) {
      out += piece;
      coloured = true;
      continue;
    }
    for (const { segment } of SEGMENTER.segment(stripVTControlCharacters(piece))) {
      const w = clusterWidth(segment);
      if (width + w > columns - 1) return end();
      out += segment;
      width += w;
    }
  }
  return end();
}

/** Where a link ends: the same code with no address. */
const LINK_END = "\x1b]8;;\x1b\\";

/** Words that open `url` when clicked, in a terminal that takes links (see linksWanted). */
export const linked = (url: string, words: string) => `\x1b]8;;${url}\x1b\\${words}${LINK_END}`;

/** How an editor's own address opens a file at a line, for the terminal inside it. */
export type Editor = "vscode" | "cursor";

/** Links the terminal can open: a file of this machine's, or a file at a line in the editor the terminal is inside. */
export interface Links {
  /** A file, at a line when there is one: in the editor when the terminal is one's, else as a file. */
  file(path: string, line?: number): string;
}

/**
 * The terminals known to open OSC 8 links, by what they set, so nothing has to be asked of the
 * terminal (an answer would land among the person's keys): iTerm2, WezTerm, VS Code and Cursor,
 * Ghostty, kitty, Windows Terminal, and Apple's Terminal from macOS 15 (Darwin 24) on. Inside tmux or
 * screen, none: they pass a link on only when set up to. Only on a terminal, never in CI or a log:
 * the codes would be noise there.
 */
export function linksWanted(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env, darwin = process.platform === "darwin" ? Number(release().split(".")[0]) : 0): Links | undefined {
  if (!stream.isTTY || env.CI || env.TERM === "dumb" || env.TMUX || env.STY || /^(screen|tmux)/.test(env.TERM ?? "")) return undefined;
  const program = env.TERM_PROGRAM ?? "";
  const takes = ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(program) || (program === "Apple_Terminal" && darwin >= 24) || env.TERM === "xterm-kitty" || Boolean(env.KITTY_WINDOW_ID) || Boolean(env.WT_SESSION);
  if (!takes) return undefined;
  // Cursor's terminal says it's VS Code's: what tells them apart is Cursor's own variable, or its app id.
  const editor: Editor | undefined = program !== "vscode" ? undefined : env.CURSOR_TRACE_ID || /cursor|todesktop/i.test(env.__CFBundleIdentifier ?? "") ? "cursor" : "vscode";
  return {
    file: (path, line) => (editor && line ? `${editor}://file${pathToFileURL(path).pathname}:${line}` : pathToFileURL(path).href),
  };
}

/** Plain text padded with spaces to `columns` on screen (the way padEnd would, if it counted columns). */
export function padTo(text: string, columns: number, align: "left" | "right" = "left"): string {
  const pad = " ".repeat(Math.max(0, columns - visibleWidth(text)));
  return align === "left" ? `${text}${pad}` : `${pad}${text}`;
}

/**
 * Text broken into lines at most `width` columns wide, at spaces. A word longer than a line is
 * clipped, unless `whole` is set: then it gets a line of its own, uncut, since a path or an address
 * cut short can't be copied or opened (the terminal wraps it, and copying it still gives it whole).
 */
export function wrapTo(text: string, width: number, { whole = false }: { whole?: boolean } = {}): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = visibleWidth(word) > width && !whole ? fit(word, width) : word;
    if (line && visibleWidth(line) + 1 + visibleWidth(piece) > width) {
      lines.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Items joined by a separator ("a · b · c"), broken into lines between whole items, never inside
 * one: a line never ends or starts with a dangling separator. An item wider than a line begins one
 * of its own, and is broken between its words (see wrapTo), never inside one.
 */
export function wrapItems(items: readonly string[], width: number, separator = " · "): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items.filter(Boolean)) {
    if (line && visibleWidth(line) + visibleWidth(separator) + visibleWidth(item) > width) {
      lines.push(line);
      line = item;
    } else line = line ? `${line}${separator}${item}` : item;
    if (visibleWidth(line) > width) {
      const pieces = wrapTo(line, width);
      line = pieces.pop() ?? "";
      lines.push(...pieces);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A space that holds the words either side of it together on one line (see wrapPainted); written as a plain space. */
export const KEEP = "\u00a0";

/**
 * A line already in colour broken into lines at most `width` columns wide, between words, the lines
 * after the first indented by `hang` (under the words, past a mark or a badge). Each line closes its
 * colours, and the next opens them again after its indent, so a colour never runs into the margin. A
 * word wider than a line (a path) stays whole, on a line of its own. A line that fits is left as it is.
 * A "·" between two words is a separator, as wrapItems's: a break there drops it, so no line ends or
 * begins with one. Words joined by KEEP stay together (a figure and its unit: "11.7k tokens"), but
 * for words too many for a line of their own.
 */
export function wrapPainted(whole: string, width: number, hang = 0): string[] {
  const plain = (line: string) => line.replaceAll(KEEP, " ");
  if (visibleWidth(whole) <= width) return [plain(whole)];
  // Words held together that wouldn't fit on a line of their own are let go, to break between them as any others.
  const text = whole.replace(/[^ ]*\u00a0[^ ]*/g, (held) => (visibleWidth(held) > width - hang ? plain(held) : held));
  const lines: string[] = [];
  /** Every colour code so far: played again after a break, they leave the words in the colour they were in. */
  const codes: string[] = [];
  let line = "";
  let used = 0;
  let gap = "";
  let started = false;
  /** A "·" waiting for the word after it: kept before it on one line, dropped at a break. */
  let sep: { token: string; gap: string } | undefined;
  const remember = (token: string) => {
    for (const code of token.matchAll(/\x1b\[[0-9;]*m/g)) codes.push(code[0]);
  };
  for (const token of text.split(/( +)/)) {
    if (!token) continue;
    if (/^ +$/.test(token)) {
      if (started) gap += token;
      else {
        line += token;
        used += token.length;
      }
      continue;
    }
    const w = visibleWidth(token);
    if (started && stripVTControlCharacters(token) === "·" && !sep) {
      sep = { token, gap };
      gap = "";
      continue;
    }
    const lead = sep ? `${sep.gap}${sep.token}${gap}` : gap;
    if (started && w > 0 && used + visibleWidth(lead) + w > width && used > hang) {
      lines.push(`${line}${codes.length ? "\x1b[0m" : ""}`);
      if (sep) remember(sep.token);
      line = `${" ".repeat(hang)}${codes.join("")}${token}`;
      used = hang + w;
    } else {
      line += `${lead}${token}`;
      used += visibleWidth(lead) + w;
      if (sep) remember(sep.token);
    }
    sep = undefined;
    gap = "";
    started = true;
    remember(token);
  }
  if (sep) line += `${sep.gap}${sep.token}`;
  lines.push(line);
  return lines.map(plain);
}

/** How wide the terminal is, or 80 when it isn't one (a pipe, a file, a CI log). */
export function columnsOf(stream: { columns?: number }): number {
  return stream.columns && stream.columns > 0 ? stream.columns : 80;
}

/** "42s", "2m 14s", "1h 3m": how long something took. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "1.2s", "42.0s", then "1m 3s": how long one screen or step took, finer than duration(). */
export function seconds(ms: number): string {
  return ms < 59_950 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : duration(ms);
}

/** "812", "22.5k", "1.2M": a count of tokens, the way e2e writes one. */
export function tokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "14:02:11": the time of day something began, on this machine's clock. */
export function timeOfDay(ms: number): string {
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "0:42", "3:00": a clock for the live status row. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A centred rule with words in it, `columns` wide: "──── 3 issues found ────". */
export function rule(words: string, columns: number): string {
  const width = visibleWidth(words) + 2;
  const left = Math.max(2, Math.floor((columns - width) / 2));
  const right = Math.max(2, columns - width - left);
  return `${"─".repeat(left)} ${words} ${"─".repeat(right)}`;
}

/**
 * A centred banner, `columns` wide, its words in a badge where colour shows: "──── Fix first 3 ────".
 * The same width as rule() with the same words, so a log without colour reads the same.
 */
export function banner(words: string, columns: number, c: Colors): string {
  if (!c.enabled) return rule(words, columns);
  const width = visibleWidth(words) + 2;
  const left = Math.max(2, Math.floor((columns - width) / 2));
  const right = Math.max(2, columns - width - left);
  return `${"─".repeat(left)}${c.inverse(c.bold(` ${words} `))}${"─".repeat(right)}`;
}

/**
 * The closest of `candidates` to a mistyped word, when it is close enough to be a typo of it: one
 * edit for a short word, a third of its length otherwise. Case is ignored; nothing for an exact match.
 */
export function suggest(word: string, candidates: readonly string[]): string | undefined {
  if (candidates.includes(word)) return undefined;
  const budget = Math.max(1, Math.floor(word.length / 3));
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase());
    if (distance <= budget && (!best || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

/** Edits from one word to another, counting a swap of two neighbouring letters as one, as typos are. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = rows[i]!;
      row[j] = Math.min(rows[i - 1]![j]! + 1, row[j - 1]! + 1, rows[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, rows[i - 2]![j - 2]! + 1);
    }
  }
  return rows[a.length]![b.length]!;
}

const PIPES_IGNORED = Symbol.for("contextmachines.pipesIgnored");
/**
 * A reader that stops early (`contextmachines --help | head -3`) closes the pipe, and the next write
 * fails with EPIPE, which kills the process with a stack trace when nothing listens. Output nobody
 * reads is dropped instead. So is output to a terminal that has gone (EIO, after its window closed),
 * so the run still ends with the exit code it decided. Any other write error still throws.
 */
export function ignoreBrokenPipes(streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    const marked = stream as NodeJS.WriteStream & { [PIPES_IGNORED]?: boolean };
    if (marked[PIPES_IGNORED]) continue;
    marked[PIPES_IGNORED] = true;
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "EIO") return;
      throw error;
    });
  }
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * One status row at the bottom of a terminal, repainted about ten times a second, with the lines
 * that are printed meanwhile scrolling above it. Each repaint is wrapped in the terminal's
 * synchronised-output brackets so it never flickers, and clipped to the width so it never wraps
 * (a wrapped row can't be cleared). Only for a real terminal: elsewhere, lines are printed as they are.
 */
export class LiveRow {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private shown = false;
  private readonly out: NodeJS.WriteStream;
  private readonly status: (spinner: string) => string;

  constructor(out: NodeJS.WriteStream, status: (spinner: string) => string) {
    this.out = out;
    this.status = status;
  }

  start(): void {
    if (this.timer) return;
    this.out.write("\x1b[?25l");
    this.timer = setInterval(() => this.paint(), 100);
    this.timer.unref();
    this.paint();
  }

  /** A line that stays, printed above the status row. */
  log(line: string): void {
    if (!this.timer) {
      this.out.write(`${line}\n`);
      return;
    }
    this.out.write(`\x1b[?2026h\r\x1b[2K${line}\n${this.row()}\x1b[?2026l`);
  }

  /** Clears the row and gives the cursor back; safe to call more than once. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.out.write(`${this.shown ? "\r\x1b[2K" : ""}\x1b[?25h`);
    this.shown = false;
  }

  private row(): string {
    this.shown = true;
    return fit(this.status(SPINNER[this.frame % SPINNER.length]!), columnsOf(this.out) - 2);
  }

  private paint(): void {
    this.frame++;
    this.out.write(`\x1b[?2026h\r\x1b[2K${this.row()}\x1b[?2026l`);
  }
}

/** What a question in the terminal came back with: an answer, or the person stopping it (Ctrl-C, Ctrl-D). */
export type Answer<T> = { answer: T } | { cancelled: true };

/**
 * A question asked on stderr (stdout stays the result under --json), read from a terminal only.
 * Ctrl-C or Ctrl-D cancels it rather than killing the process, so the caller can say nothing changed.
 */
export function ask(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<Answer<string>> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
    let done = false;
    const finish = (result: Answer<string>) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(result);
    };
    rl.on("SIGINT", () => {
      output.write("\n");
      finish({ cancelled: true });
    });
    rl.on("close", () => finish({ cancelled: true }));
    rl.question(question, (answer) => finish({ answer }));
  });
}

/** A yes-or-no question whose answer is no unless the person types yes. */
export async function confirm(question: string, c: Colors, input?: NodeJS.ReadStream, output?: NodeJS.WriteStream): Promise<Answer<boolean>> {
  const reply = await ask(`${c.cyan("?")} ${question} ${c.dim("(y/N)")} `, input, output);
  return "cancelled" in reply ? reply : { answer: /^y(es)?$/i.test(reply.answer.trim()) };
}

/**
 * Agents that run commands in a terminal of their own, by what they set there: a key they'd never
 * press must not hold their run. Claude Code sets CLAUDECODE (and CLAUDE_CODE_ENTRYPOINT) in the
 * shells it runs; Codex sets CODEX_SANDBOX and CODEX_SANDBOX_NETWORK_DISABLED, and a session id
 * (CODEX_THREAD_ID, CODEX_SESSION_ID, CODEX_CI) beside its CODEX_HOME; cursor-agent sets CURSOR_AGENT;
 * Gemini CLI sets GEMINI_CLI; aider is configured by AIDER_* variables. CODEX_HOME on its own is a
 * person's setting, and doesn't count. CONTEXTMACHINES_NO_PROMPT turns it off for anything else.
 */
export const AGENT_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI", "CURSOR_AGENT", "GEMINI_CLI", "CONTEXTMACHINES_NO_PROMPT"] as const;

/** Whether an agent (or a person, with CONTEXTMACHINES_NO_PROMPT) is the one running this: see AGENT_ENV. */
export function agentCalling(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_ENV.some((name) => Boolean(env[name])) || Object.keys(env).some((name) => name.startsWith("AIDER_") && Boolean(env[name]));
}

/**
 * Whether the end of a run may wait for a key: only for a person at a terminal. Both stdin and stdout
 * a terminal, the live area drawn (see liveWanted), no --json or --no-prompt, not a CI job or a dumb
 * terminal, no agent running it (see AGENT_ENV), and the run in the terminal's foreground (see
 * inForeground), asked last since it starts a process.
 */
export function keyWanted(run: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean }; live: boolean; json: boolean; noPrompt: boolean; foreground?: () => boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(run.stdin.isTTY) && Boolean(run.stdout.isTTY) && run.live && !run.json && !run.noPrompt && !env.CI && env.TERM !== "dumb" && !agentCalling(env) && (run.foreground?.() ?? true);
}

/**
 * Whether ps's "tpgid pgid" for this process says it's the terminal's foreground job: the two the
 * same. A run started with & (or sent there with Ctrl-Z and bg) is in a group of its own that isn't,
 * and the kernel stops it the moment it reads a key or sets raw mode. Anything unreadable is "no".
 */
export function foregroundFrom(ps: string): boolean {
  const [tpgid, pgid] = ps.trim().split(/\s+/).map(Number);
  return Number.isInteger(tpgid) && Number.isInteger(pgid) && tpgid! > 0 && tpgid === pgid;
}

/**
 * Whether this process is the terminal's foreground job, asked of ps (Node can't ask the terminal
 * itself). On Windows, which has no background jobs of this kind, always yes; where ps fails, no,
 * so a wait never stops a run that can't be sure.
 */
export function inForeground(): boolean {
  if (process.platform === "win32") return true;
  try {
    return foregroundFrom(execFileSync("ps", ["-o", "tpgid=,pgid=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }));
  } catch {
    return false;
  }
}

/**
 * The longest the end of a run waits for a key: then it finishes on its own, so nothing is held for
 * good. A script run at a terminal (`learn URL && git add …`) waits this long too, unless it passes
 * --no-prompt or sets CONTEXTMACHINES_NO_PROMPT.
 */
export const KEY_WAIT_MS = 10 * 60_000;

/** How long, once raw mode is on, keys are thrown away as ones typed during the run: far quicker than anyone answers a hint. */
export const KEY_SETTLE_MS = 50;

/**
 * The keys of the menu at the end of a run: f hands the list to the person's coding agent, o opens
 * the page, a lists the rest here, c copies FIX.md.
 */
export type MenuKey = "f" | "o" | "a" | "c";

/** What came of waiting for a key: one of the menu's, finished, or the wait ran out. */
export type KeyEnd = MenuKey | "done" | "timeout";

/** A terminal to read single keys from: process.stdin, or a pretend one in a test. */
export interface KeyInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data" | "end" | "error", listener: (chunk?: unknown) => void): unknown;
  off(event: "data" | "end" | "error", listener: (chunk?: unknown) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** What the wait listens to besides the keys: the process's signals and its exit, so the terminal is given back whatever ends it. */
export interface KeySignals {
  on(event: "exit" | "SIGTERM" | "SIGHUP" | "SIGINT", listener: () => void): unknown;
  off(event: "exit" | "SIGTERM" | "SIGHUP" | "SIGINT", listener: () => void): unknown;
}

/**
 * A key as the menu reads it: a menu letter (either case; space and the down arrow are a, the way a
 * pager goes on), "done" for q, Enter, Esc, Ctrl-C and Ctrl-D, else nothing. Only the keys offered
 * count: any other is nothing, so it never falls through to the shell.
 */
export function keyMeaning(key: string, offered: readonly MenuKey[] = ["a"]): MenuKey | "done" | undefined {
  if (key === "q" || key === "Q" || key === "\r" || key === "\n" || key === "\r\n" || key === "\x1b" || key === "\x03" || key === "\x04") return "done";
  const letter = key === " " || key === "\x1b[B" || key === "\x1bOB" ? "a" : key.toLowerCase();
  return (offered as readonly string[]).includes(letter) ? (letter as MenuKey) : undefined;
}

/**
 * One line of hint at the end of a run, and a wait for a single key, read in raw mode. The hint is
 * written with no line break and cleared again whatever the answer, so the next line (or the shell's
 * prompt) takes its place. The terminal's mode and its cursor are given back on every way out: a
 * key, the wait running out (`ms`, on a timer that never keeps the process alive by itself), a
 * signal, the process exiting, or an error. Keys typed during the run (an Enter to make some room)
 * wait in the terminal and arrive the moment it reads; whatever arrives in the first `settle`
 * milliseconds is thrown away, so only a key pressed after the hint is shown answers it.
 */
export function waitForKey(hint: string, { keys = ["a"], input = process.stdin as KeyInput, output = process.stdout as { write(text: string): unknown }, ms = KEY_WAIT_MS, settle = KEY_SETTLE_MS, signals = process as KeySignals }: { keys?: readonly MenuKey[]; input?: KeyInput; output?: { write(text: string): unknown }; ms?: number; settle?: number; signals?: KeySignals } = {}): Promise<KeyEnd> {
  return new Promise((resolve) => {
    const wasRaw = Boolean(input.isRaw);
    let over = false;
    let timer: NodeJS.Timeout | undefined;
    let settled = settle <= 0;
    let settling: NodeJS.Timeout | undefined;
    /** The terminal as it was: raw mode off, the cursor shown, nothing listening any more. Safe to call more than once. */
    const giveBack = () => {
      if (over) return;
      over = true;
      if (timer) clearTimeout(timer);
      if (settling) clearTimeout(settling);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) signals.off(signal, onEnd);
      signals.off("exit", onExit);
      try {
        if (!wasRaw) input.setRawMode?.(false);
      } finally {
        input.pause();
        try {
          output.write("\r\x1b[2K\x1b[?25h");
        } catch {
          // a terminal that has gone: nothing to give back
        }
      }
    };
    const finish = (how: KeyEnd) => {
      if (over) return;
      giveBack();
      resolve(how);
    };
    function onData(chunk?: unknown) {
      if (!settled) return;
      try {
        const typed = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
        // An escape sequence is one key; anything else typed at once (a paste) counts by its first that means something.
        const meaning = typed.startsWith("\x1b") ? keyMeaning(typed, keys) : [...typed].map((key) => keyMeaning(key, keys)).find(Boolean) ?? keyMeaning(typed, keys);
        if (meaning) finish(meaning);
      } catch {
        finish("done");
      }
    }
    function onEnd() {
      finish("done");
    }
    function onExit() {
      giveBack();
    }
    try {
      output.write(`${hint}\x1b[?25l`);
      signals.on("exit", onExit);
      for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) signals.on(signal, onEnd);
      input.setRawMode?.(true);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onEnd);
      input.resume();
      if (!settled) {
        settling = setTimeout(() => void (settled = true), settle);
        settling.unref();
      }
      timer = setTimeout(() => finish("timeout"), ms);
      timer.unref();
    } catch {
      finish("done");
    }
  });
}
