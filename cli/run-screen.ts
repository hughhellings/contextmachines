/**
 * The screen a run draws while it learns, the way a test runner draws its run. Each part of the run
 * is a group with a coloured badge ("public", "code", "new user"…), and under it what it walked: a
 * line for each screen, with what was found there under that. At the bottom of the terminal, one
 * live area redraws in place: only the groups running now, each with the screen it's on and what
 * it's doing, then a few lines that count up as the run goes, with a clock. A group that ends prints
 * its whole block above the area, where it stays, so the scrollback reads as a tree, top to bottom.
 *
 * Only on a terminal that shows colour and is wide enough to draw it. Anywhere else (a pipe, a CI
 * log, NO_COLOR, a narrow window) nothing is redrawn and no cursor code is written: a group says it
 * started in a line, and prints the same block when it ends, so a log reads from top to bottom.
 */
import { clock, colorWanted, columnsOf, cut, duration, KEEP, seconds, timeOfDay, visibleWidth, wrapPainted, type Colors, type KeyInput, type Tone } from "./term.ts";

/** What the screen writes to: a terminal, a pipe, or a pretend one in a test. */
export interface ScreenStream {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  /** A terminal says when it's resized ("resize"): the area is drawn again from scratch. */
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

/** A stream something else may write to while the area is drawn: what it writes is kept above the area. */
export interface StrayStream {
  write: (...args: never[]) => boolean;
  isTTY?: boolean;
}

/** The narrowest terminal that gets the live area: narrower, its rows would wrap, and a wrapped row can't be redrawn. */
export const LIVE_MIN_COLUMNS = 60;

/** Whether a stream gets the live area: a terminal, with colour, not a CI log, wide enough. */
export function liveWanted(stream: Pick<ScreenStream, "isTTY" | "columns">, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stream.isTTY) && colorWanted(stream, env) && !env.CI && env.TERM !== "dumb" && columnsOf(stream) >= LIVE_MIN_COLUMNS;
}

/** How a part ended: done, done with something to say about it, or failed. */
export type StepEnd = "done" | "warned" | "failed";

/**
 * The parts of a run, each as its badge names it, on its own colour of the terminal's theme (see
 * TONES): each part told apart at a glance, and none red, which is kept for what went wrong. The
 * three ways of seeing the app take e2e's three: green, yellow, cyan. The code, read and not seen, is grey.
 * The AI's review is the theme's own colours swapped: a block on a light background and a dark one alike.
 */
export const PARTS = {
  public: { name: "public", colour: "green" },
  code: { name: "code", colour: "grey" },
  newUser: { name: "new user", colour: "yellow" },
  madeUpUser: { name: "made-up user", colour: "cyan" },
  journeys: { name: "journeys", colour: "magenta" },
  review: { name: "ai review", colour: "inverse" },
} as const satisfies Record<string, { name: string; colour: Tone }>;

export type Part = (typeof PARTS)[keyof typeof PARTS];

/** A part's name as a badge: dark words on its block of colour, a space each side; in square brackets without colour. */
export function badge(part: Part, c: Colors): string {
  return c.enabled ? c.badge(part.colour, ` ${part.name} `) : `[${part.name}]`;
}

/** One part of a run, from the moment it starts. */
export interface Group {
  readonly running: boolean;
  /** How many things were found in it. */
  readonly found: number;
  /** Words beside its badge while it runs ("6 screens"). */
  detail(words: string): void;
  /** What it's doing right now: under the screen it's on, or as its one step when it walks none. */
  doing(words: string): void;
  /** A screen it went to, by its address, and the words it's shown by: the one before is over, and this one's clock starts. */
  screen(path: string, shown?: string): void;
  /** What it's doing now on no one screen ("one more look at its screens"): the screen it was on is over, so the time from here is the group's own. */
  step(words: string): void;
  /** A screen it saw, only known once the part is over: with the time its own walk took on it, when that's known (`ms`), else with none. */
  saw(path: string, shown?: string, ms?: number): void;
  /** Something found, as it's shown ("⚑ …"), under the screen it was seen on: the one it's on now when that isn't said. */
  finding(line: string, path?: string): void;
  /** A line of its own under it when it ends, after its screens: a journey, a count. */
  item(line: string): void;
  /** A line under it when it ends, after everything else: what went wrong. */
  note(line: string): void;
  /**
   * Its own work is over at `at`, and it waits on another part before it can say what came of it: its
   * clock stops there, and its line says only what it waits for ("waiting for the public pages").
   */
  hold(at: number, words: string): void;
  /** Over: its line says what came of it and how long its own work took (to `at`, when that's known better than now; else to where it was held). */
  end(how: StepEnd, words: string, detail?: string, at?: number): void;
}

/** The most screens a group lists when it ends: those with something found first, the rest counted (see ScreenOptions.mostScreens). */
export const MOST_SCREENS = 12;
/** The most things found told under one screen: FIX.md has the rest. */
const MOST_UNDER_SCREEN = 4;
/** The things found told under a group still running: its latest. */
const LIVE_FOUND = 2;
/** The widest the area is drawn, so a clock stays near the words it belongs to. */
export const MOST_WIDTH = 80;
/** Where the summary's labels end, as the result's rows line up: "  Findings". */
const LABEL_WIDTH = 10;

interface Screen {
  path: string;
  shown: string;
  /** Time spent on it before now; undefined for a screen seen with no clock. */
  ms?: number;
  /** Since when it's been on it, while it is. */
  since?: number;
  found: string[];
}

interface GroupState {
  part: Part;
  begun: number;
  ended?: number;
  /** When its own work was over, while it waits on another part (see Group.hold). */
  held?: number;
  state: "running" | StepEnd;
  words: string;
  detail: string;
  doing: string;
  screens: Screen[];
  current?: Screen;
  /** Found with no screen to put it under. */
  loose: string[];
  /** The latest found, for the live area. */
  latest: string[];
  items: string[];
  notes: string[];
  found: number;
}

export interface ScreenOptions {
  /** Redraw in place (see liveWanted); false prints plain lines. */
  live: boolean;
  c: Colors;
  /** When the run began: the summary's clock counts from here. */
  begun?: number;
  now?: () => number;
  /** Streams whose other writes are kept above the area while it's drawn: stdout and stderr, unless a test says otherwise. Only those that write to a terminal are caught: one sent to a file keeps its own. */
  strays?: StrayStream[];
  /** The most screens a group lists when it ends: MOST_SCREENS, unless every one is asked for (--verbose). */
  mostScreens?: number;
  /**
   * The keyboard, taken while the area is drawn (process.stdin, given by the command; none unless
   * given). A terminal left as it is echoes what's typed into the area, and an echoed Enter moves the
   * cursor a row the area doesn't count, so the next draw goes back one row too few and leaves a copy
   * of its top line behind. Taken, a key is dropped, but for Ctrl-C (see interrupt).
   */
  input?: KeyInput;
  /** Whether this process is the terminal's foreground job (see inForeground): one in the background is stopped by the kernel the moment it sets raw mode. */
  foreground?: () => boolean;
  /** A Ctrl-C typed while the keyboard is taken: raw mode turns the terminal's own signal off, so it's passed on as the SIGINT it would have been. */
  interrupt?: () => void;
}

/** How the run ended: done, stopped early with what it learned still written (Ctrl-C), or failed: a part still running then ends as stopped, or as failed. */
export type RunEnd = "done" | "stopped" | "failed";

/** How wide the area is drawn on a stream: what the result below it lines up with too. */
export const areaWidth = (stream: Pick<ScreenStream, "columns">) => Math.min(columnsOf(stream), MOST_WIDTH) - 2;

/** A line in the area, with how soon it goes when the terminal is too short for all of them: 3 first, 0 never. */
type Ranked = [rank: number, line: string];

export class RunScreen {
  private readonly out: ScreenStream;
  /** The stream's own write, kept before any stray writes are caught, so the screen's own never are. */
  private readonly write: (text: string) => unknown;
  private readonly c: Colors;
  private readonly begun: number;
  private readonly now: () => number;
  readonly live: boolean;
  private readonly groups: GroupState[] = [];
  private readonly strays: StrayStream[];
  private readonly mostScreens: number;
  private readonly restores: (() => void)[] = [];
  /** A stray write's last line, until its end comes. */
  private strayLine = "";
  private timer: NodeJS.Timeout | undefined;
  /** The area's lines as last drawn: what the next draw goes back up over. */
  private drawnLines: string[] = [];
  /** How many terminal rows the area took when last drawn. */
  private height = 0;
  private stopped = false;
  private found = 0;
  private readonly seen = new Set<string>();
  private readonly resized = () => this.redraw(true);
  private readonly input: KeyInput | undefined;
  private readonly foreground: () => boolean;
  private readonly interrupt: () => void;
  /** Whether the keyboard is taken now (see ScreenOptions.input). */
  private keysTaken = false;
  /** A key typed while the area is drawn: dropped, but for Ctrl-C, passed on. */
  private readonly typed = (chunk?: unknown) => {
    const keys = typeof chunk === "string" ? chunk : Buffer.from((chunk ?? []) as Uint8Array).toString();
    if (keys.includes("\x03")) this.interrupt();
  };
  /** The keyboard given back as it was: on stop, and on the way out whatever ends the process. Safe to call more than once. */
  private readonly giveKeys = () => {
    if (!this.keysTaken || !this.input) return;
    this.keysTaken = false;
    process.off("exit", this.giveKeys);
    this.input.off("data", this.typed);
    try {
      this.input.setRawMode?.(false);
    } catch {
      // a terminal that has gone: nothing to give back
    }
    this.input.pause();
  };

  constructor(out: ScreenStream, options: ScreenOptions) {
    this.out = out;
    this.write = out.write.bind(out);
    this.c = options.c;
    this.now = options.now ?? Date.now;
    this.begun = options.begun ?? this.now();
    this.live = options.live;
    this.strays = (options.strays ?? [process.stdout, process.stderr]).filter((stream) => stream === (out as unknown) || stream.isTTY);
    this.mostScreens = options.mostScreens ?? MOST_SCREENS;
    this.input = options.input;
    this.foreground = options.foreground ?? (() => true);
    this.interrupt = options.interrupt ?? (() => void process.kill(process.pid, "SIGINT"));
  }

  /**
   * Starts drawing: the area appears and its clocks move about ten times a second. Meanwhile anything
   * else written to stdout or stderr (a library's warning, a console.log) is kept, a line at a time,
   * above the area, so it can't break what the area goes back up over.
   */
  start(): void {
    if (!this.live || this.timer || this.stopped) return;
    this.write("\x1b[?25l");
    for (const stream of this.strays) {
      const own = stream.write;
      stream.write = ((chunk: unknown, encoding?: unknown, done?: unknown) => {
        this.stray(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
        const callback = typeof encoding === "function" ? encoding : done;
        if (typeof callback === "function") process.nextTick(callback as () => void);
        return true;
      }) as StrayStream["write"];
      this.restores.push(() => void (stream.write = own));
    }
    this.out.on?.("resize", this.resized);
    this.takeKeys();
    this.timer = setInterval(() => this.redraw(), 100);
    this.timer.unref();
    this.redraw();
  }

  /**
   * The keyboard, while the area is drawn: raw mode, so nothing typed is echoed into it (see
   * ScreenOptions.input). Only a terminal, in the foreground, not already raw. It costs nothing: a
   * key that comes is looked at for a Ctrl-C and dropped.
   */
  private takeKeys(): void {
    const input = this.input;
    if (!input?.isTTY || !input.setRawMode || input.isRaw || !this.foreground()) return;
    try {
      input.setRawMode(true);
    } catch {
      return;
    }
    this.keysTaken = true;
    input.on("data", this.typed);
    input.resume();
    process.on("exit", this.giveKeys);
  }

  /**
   * A line that stays: above the area on a terminal, in its place in a log. Its row is cleared before
   * it's written, not after: a line exactly as wide as the window leaves the cursor waiting past its
   * last column, and clearing from there would take that last character with it. Only a line that
   * ends short of the edge has the rest of its last row cleared after it.
   */
  log(line = ""): void {
    if (!this.timer) {
      this.write(`${line}\n`);
      return;
    }
    const rest = visibleWidth(line) % columnsOf(this.out) ? "\x1b[K" : "";
    this.write(`\x1b[?2026h${this.back()}\x1b[2K${line}${rest}\n${this.drawn()}\x1b[?2026l`);
  }

  /** A setup line at the top, said once: ℹ what it's about to do, ✓ something ready (and how long it took), ! something to know. */
  note(mark: "info" | "done" | "warn", words: string, time?: string): void {
    const c = this.c;
    const sign = mark === "info" ? c.dim("ℹ") : mark === "done" ? c.ok("✓") : c.yellow("!");
    // Too long for the window, it goes on under its words, as a block's lines do (see stays).
    for (const piece of wrapPainted(`${sign} ${words}${time ? ` ${c.grey(time)}` : ""}`, columnsOf(this.out) - 1, 2)) this.log(piece);
  }

  /** A line only a log needs, to show it's still going: the live area already says it. */
  progress(line: string): void {
    if (!this.live) this.write(`${line}\n`);
  }

  /** Something found that belongs to no part running: said once, where it stays, and counted. */
  finding(line: string): void {
    this.found++;
    this.log(`  ${line}`);
  }

  /** A new part of the run, under its badge. */
  group(part: Part): Group {
    const g: GroupState = { part, begun: this.now(), state: "running", words: "", detail: "", doing: "", screens: [], loose: [], latest: [], items: [], notes: [], found: 0 };
    this.groups.push(g);
    if (!this.live) this.write(`${this.c.cyan("❯")} ${badge(part, this.c)} started\n`);
    const at = (path: string, shown: string, timed: boolean) => {
      let screen = g.screens.find((s) => s.path === path);
      if (!screen) {
        screen = { path, shown, found: [], ...(timed ? { ms: 0 } : {}) };
        g.screens.push(screen);
        this.seen.add(path);
      }
      return screen;
    };
    /** The screen it's on is left: its time so far is added up. */
    const leave = (when: number) => {
      const on = g.current;
      if (on?.since === undefined) return;
      on.ms = (on.ms ?? 0) + Math.max(0, when - on.since);
      delete on.since;
      g.current = undefined;
    };
    return {
      get running() {
        return g.state === "running";
      },
      get found() {
        return g.found;
      },
      detail: (words) => void (g.detail = words),
      doing: (words) => void (g.doing = words),
      screen: (path, shown = path) => {
        if (g.state !== "running" || g.current?.path === path) return;
        const now = this.now();
        leave(now);
        delete g.held;
        const screen = at(path, shown, true);
        screen.ms ??= 0;
        screen.since = now;
        g.current = screen;
        g.doing = "";
      },
      step: (words) => {
        if (g.state !== "running") return;
        leave(this.now());
        delete g.held;
        g.doing = words;
      },
      hold: (at, words) => {
        if (g.state !== "running") return;
        const held = Math.max(g.begun, Math.min(at, this.now()));
        leave(Math.max(held, g.current?.since ?? held));
        Object.assign(g, { held, doing: words });
      },
      saw: (path, shown = path, ms) => {
        const screen = at(path, shown, false);
        if (ms !== undefined && ms >= 0) screen.ms = (screen.ms ?? 0) + ms;
      },
      finding: (line, path) => {
        g.found++;
        this.found++;
        const under = path === undefined ? g.current : at(path, path, false);
        (under ? under.found : g.loose).push(line);
        g.latest = [...g.latest, line].slice(-LIVE_FOUND);
        // Something found after its part is over still stays: on a line of its own.
        if (g.state !== "running") this.log(`  ${line}`);
      },
      item: (line) => void g.items.push(line),
      note: (line) => void g.notes.push(line),
      end: (how, words, detail, at) => {
        if (g.state !== "running") return;
        const ended = Math.max(g.begun, at ?? g.held ?? this.now());
        leave(Math.max(ended, g.current?.since ?? ended));
        Object.assign(g, { state: how, words, detail: detail ?? "", ended, doing: "" });
        this.stays(g);
      },
    };
  }

  /**
   * The run is over. Groups still running end as stopped, their blocks printed; the live area goes,
   * and the cursor is given back on the line after the last block. Safe to call more than once: the
   * first one counts.
   */
  stop(how: RunEnd = "done"): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const g of this.groups) {
      if (g.state !== "running") continue;
      const ended = g.held ?? this.now();
      if (g.current?.since !== undefined) g.current.ms = (g.current.ms ?? 0) + Math.max(0, ended - g.current.since);
      const failed = how === "failed";
      // What it had come to, then that it was stopped; with nothing to say, only that.
      const words = g.words || g.detail;
      Object.assign(g, { state: failed ? "failed" : "warned", ended, doing: "", detail: failed || !words ? "" : "stopped", words: words || (failed ? "" : "stopped") });
      this.stays(g);
    }
    if (this.strayLine) this.log(this.strayLine);
    this.strayLine = "";
    for (const restore of this.restores.splice(0)) restore();
    this.giveKeys();
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.out.off?.("resize", this.resized);
    this.write(`\x1b[?2026h${this.back()}\x1b[J\x1b[?2026l\x1b[?25h`);
    this.height = 0;
    this.drawnLines = [];
  }

  /**
   * A group's block as it stays once it has ended: its line, its screens and what was found on them,
   * its items and notes. Each with where its words begin, so a line too long for the window goes on
   * under its own words (see stays).
   */
  private block(g: GroupState): [line: string, hang: number][] {
    const c = this.c;
    const mark = g.state === "done" ? c.ok("✓") : g.state === "failed" ? c.red("×") : c.yellow("!");
    const took = duration((g.ended ?? this.now()) - g.begun);
    const head = `${mark} ${badge(g.part, c)} `;
    // Its words plain, its time and what qualifies it in grey, as a test runner ends a file's line
    // ("19.36s ai 22.5k tokens · 53% cached"). Too long for the window, it breaks between whole
    // parts, at a "·" or the gap before the details: a figure stays with its unit, and the time with
    // the words before it, so neither is left alone on a line (see wrapPainted).
    const keep = (part: string) => part.replaceAll(" ", KEEP);
    const parts = g.words ? g.words.split(" · ") : [];
    const said = [...parts.slice(0, -1), ...parts.slice(-1).map(keep)].join(" · ");
    const detail = g.detail.split(" · ").map(keep).join(" · ");
    const lines: string[] = [`${head.trimEnd()}${said ? ` ${said}${KEEP}${KEEP}` : "  "}${c.grey(took)}${detail ? `  ${c.grey(detail)}` : ""}`];
    // Where something was found comes first: that's what a person scrolls back for.
    const withFound = g.screens.filter((s) => s.found.length);
    const sorted = [...withFound, ...g.screens.filter((s) => !s.found.length)];
    const shown = sorted.slice(0, this.mostScreens);
    for (const s of shown) {
      const time = s.ms === undefined ? "" : `  ${c.grey(seconds(s.ms))}`;
      const found = s.found.length ? `  ${c.red(`${s.found.length} found`)}` : "";
      lines.push(`  ${s.found.length ? c.red("×") : c.ok("✓")} ${s.shown}${time}${found}`);
      for (const line of s.found.slice(0, MOST_UNDER_SCREEN)) lines.push(`    ${line}`);
      if (s.found.length > MOST_UNDER_SCREEN) lines.push(`    ${c.grey(`· ${s.found.length - MOST_UNDER_SCREEN} more found here, in FIX.md`)}`);
    }
    const left = sorted.length - shown.length;
    if (left > 0) lines.push(`  ${c.grey(`· ${left} more ${left === 1 ? "screen" : "screens"}${sorted.slice(this.mostScreens).some((s) => s.found.length) ? ", what was found there is in FIX.md" : ", nothing found"}`)}`);
    for (const line of [...g.loose, ...g.items, ...g.notes]) lines.push(`  ${line}`);
    return lines.map((line, k) => [line, k ? hangOf(line) : visibleWidth(head)]);
  }

  /** The area's lines as they would be drawn now, uncut: for tests, and for the draw itself. */
  frame(): string[] {
    const c = this.c;
    const width = areaWidth(this.out);
    const now = this.now();
    const ranked: Ranked[] = [];
    for (const g of this.groups) {
      if (g.state !== "running") continue;
      // A group whose own work is over waits, its clock stopped: a dim mark and a plain time, as nothing's moving.
      const held = g.held !== undefined;
      const head = `${held ? c.dim("…") : c.cyan("❯")} ${badge(g.part, c)}${g.detail ? ` ${g.detail}` : ""}`;
      const time = clock((g.held ?? now) - g.begun);
      const gap = width - visibleWidth(head) - time.length;
      ranked.push([0, `${head}${" ".repeat(Math.max(2, gap))}${held ? c.grey(time) : c.bold(c.yellow(time))}`]);
      // What it found last, under the group and not under the screen it's on now, where it may not have been found.
      for (const line of g.latest) ranked.push([3, `  ${line}`]);
      const on = g.current;
      if (on) {
        ranked.push([2, `  └── ${on.shown}  ${c.bold(c.yellow(seconds((on.ms ?? 0) + now - (on.since ?? now))))}`]);
        if (g.doing) ranked.push([3, `      ${c.grey(`↳ ${g.doing}`)}`]);
      } else if (g.doing) ranked.push([2, `  └── ${c.grey(g.doing)}`]);
    }
    if (ranked.length) ranked.push([1, ""]);
    const label = (words: string) => c.grey(words.padStart(LABEL_WIDTH));
    const found = `${this.found}`;
    ranked.push(
      // Red only for what's wrong, and none found so far isn't good news yet: plain. What it has seen counts up in green, as a test runner's passes do.
      [1, `${label("Findings")}  ${this.found ? c.red(c.bold(found)) : found} so far`],
      // Every address a part went to, some later merged into one screen or dropped as no screen at all: what the result's "seen" counts is fewer.
      [1, `${label("Screens")}  ${c.green(c.bold(`${this.seen.size} visited`))}`],
      [1, `${label("Start at")}  ${timeOfDay(this.begun)}`],
      [0, `${label("Duration")}  ${clock(now - this.begun)}`],
    );
    return this.fitted(ranked);
  }

  /**
   * No taller than the terminal: an area that scrolls off its top can't be gone back over. What a
   * group is doing and has found goes first, then the screens it's on, then the counts; the groups'
   * own lines and the clock stay as long as they can.
   */
  private fitted(ranked: Ranked[]): string[] {
    const most = Math.max(2, (this.out.rows ?? 0) > 0 ? this.out.rows! - 1 : Infinity);
    let kept = ranked;
    for (const rank of [3, 2, 1]) {
      if (kept.length <= most) break;
      kept = kept.filter(([r]) => r < rank);
    }
    return kept.slice(-most).map(([, line]) => line);
  }

  /**
   * A group's block, once it has ended: above the area on a terminal, in its place in a log. Never
   * cut: a line too long for the window goes on under its own words, broken between words with its
   * colours kept, rather than be broken mid-word by the terminal. One column is left spare, for a
   * character a terminal draws wider than it's measured.
   */
  private stays(g: GroupState): void {
    const width = columnsOf(this.out) - 1;
    for (const [line, hang] of this.block(g)) for (const piece of wrapPainted(line, width, hang)) this.log(piece);
  }

  /** What something else wrote while the area was drawn, kept above it a whole line at a time. */
  private stray(text: string): void {
    const lines = `${this.strayLine}${text}`.split("\n");
    this.strayLine = lines.pop()!;
    for (const line of lines) this.log(line.replace(/\r/g, ""));
  }

  /**
   * Back to the top of the area: where the next draw, or a line that stays, begins. Nothing is cleared
   * here: each line is written over and cleared to its end (see drawn), so a terminal that doesn't keep
   * a frame back until it's whole never shows the area blank.
   */
  private back(): string {
    return `\r${this.height > 1 ? `\x1b[${this.height - 1}A` : ""}`;
  }

  /**
   * The area as it is now, every line cut to the area's width (two columns less than the window, at
   * most), colours kept, so none wraps even where a terminal draws a character wider than it's
   * measured, and none runs past the clocks; what's left below is cleared. Remembered as what the
   * next draw goes back over.
   */
  private drawn(): string {
    const lines = this.frame().map((line) => cut(line, areaWidth(this.out)));
    this.drawnLines = lines;
    this.height = lines.length;
    return `${lines.map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`;
  }

  /** Draws the area now, as its clock does about ten times a second. */
  draw(): void {
    this.redraw();
  }

  /**
   * Draws the area again. After a resize the terminal may have wrapped the last drawing's lines onto
   * more rows: those are gone back over, all of it is cleared, and it's drawn from scratch. That's
   * how most terminals take a narrower window. One that cuts its lines instead of wrapping them
   * (xterm, the Linux console) is gone back over too far, and loses a few lines above the area.
   */
  private redraw(resized = false): void {
    if (!this.timer) return;
    if (resized) {
      const columns = columnsOf(this.out);
      this.height = this.drawnLines.reduce((rows, line) => rows + Math.max(1, Math.ceil(visibleWidth(line) / columns)), 0);
      this.write(`\x1b[?2026h${this.back()}\x1b[J${this.drawn()}\x1b[?2026l`);
      return;
    }
    this.write(`\x1b[?2026h${this.back()}${this.drawn()}\x1b[?2026l`);
  }
}

/** Where a stayed line's words begin, for the lines it goes on to: past its indent and its mark ("  ✓ ", "    ⚑ "). */
function hangOf(line: string): number {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const [, indent = "", mark] = /^( *)(\S )?/.exec(plain) ?? [];
  return indent.length + (mark && visibleWidth(mark) === 2 ? 2 : 0);
}
