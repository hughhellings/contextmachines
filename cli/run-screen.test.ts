// node --test cli/run-screen.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { badge, liveWanted, PARTS, RunScreen } from "./run-screen.ts";
import { colors, cut, timeOfDay, visibleWidth } from "./term.ts";

/** A pretend terminal, or a pretend pipe: everything written to it, kept. It says when it's resized, as a terminal does. */
function stream(more: { isTTY?: boolean; columns?: number; rows?: number } = {}) {
  const events = new EventEmitter();
  const s = {
    text: "",
    isTTY: more.isTTY ?? false,
    columns: more.columns,
    rows: more.rows,
    write: (t: string) => void (s.text += t),
    on: (event: "resize", listener: () => void) => events.on(event, listener),
    off: (event: "resize", listener: () => void) => events.off(event, listener),
    resize: (columns: number) => {
      s.columns = columns;
      events.emit("resize");
    },
  };
  return s;
}

/** A pretend stdout or stderr that something else writes to while the area is drawn: to the terminal, unless it's been sent to a file. */
function other(isTTY = true) {
  const s = { text: "", isTTY, write: (chunk: string, done?: () => void) => ((s.text += chunk), done?.(), true) };
  return s;
}

/**
 * What a terminal shows once all of it has been written: carriage returns, going up lines and clearing
 * to the end are done as a terminal would, and the colours are dropped. Given its width, a line that
 * reaches the edge wraps as a terminal's does: the cursor waits on the last column until the next
 * character, and clearing from there takes that last character.
 */
function replay(raw: string, columns = Infinity): string[] {
  const lines: string[] = [""];
  let row = 0;
  let col = 0;
  for (const m of raw.matchAll(/\x1b\[([0-9;?]*)([A-Za-z])|\r|\n|[^\x1b\r\n]+/g)) {
    const [all, args, op] = m;
    if (all === "\r") col = 0;
    else if (all === "\n") {
      row++;
      lines[row] ??= "";
      col = 0;
    } else if (op === "A") row = Math.max(0, row - Number(args || 1));
    else if (op === "J") {
      lines.length = row + 1;
      lines[row] = lines[row]!.slice(0, col);
    } else if (op === "K") lines[row] = args === "2" ? "" : lines[row]!.slice(0, Math.min(col, columns - 1));
    else if (op) continue;
    else {
      for (const ch of stripVTControlCharacters(all)) {
        if (col >= columns) {
          row++;
          lines[row] ??= "";
          col = 0;
        }
        lines[row] = lines[row]!.slice(0, col).padEnd(col) + ch + lines[row]!.slice(col + 1);
        col++;
      }
    }
  }
  return lines.map((line) => line.trimEnd());
}

const clock = () => {
  const t = { now: 0 };
  return Object.assign(() => t.now, { at: (ms: number) => void (t.now = ms) });
};

const START = timeOfDay(0);

describe("when the live area is drawn", () => {
  it("only on a terminal that shows colour, isn't a CI log and is at least 60 columns", () => {
    const tty = (columns: number) => ({ isTTY: true, columns });
    assert.equal(liveWanted(tty(80), {}), true);
    assert.equal(liveWanted(tty(120), {}), true);
    assert.equal(liveWanted(tty(59), {}), false);
    assert.equal(liveWanted(tty(40), {}), false);
    assert.equal(liveWanted(tty(80), { NO_COLOR: "1" }), false);
    assert.equal(liveWanted(tty(80), { CI: "true" }), false);
    assert.equal(liveWanted(tty(80), { TERM: "dumb" }), false);
    assert.equal(liveWanted({ isTTY: false, columns: 80 }, { FORCE_COLOR: "1" }), false, "a pipe never, even with colour forced");
  });
});

describe("a part's badge", () => {
  it("is its name in black on one of the terminal's own backgrounds, a space each side: e2e's green, yellow and cyan for the three ways of seeing", () => {
    const c = colors(true);
    assert.equal(badge(PARTS.public, c), "\x1b[42;30m public \x1b[39;49m");
    assert.equal(badge(PARTS.newUser, c), "\x1b[43;30m new user \x1b[39;49m");
    assert.equal(badge(PARTS.madeUpUser, c), "\x1b[46;30m made-up user \x1b[39;49m");
    assert.deepEqual(Object.values(PARTS).map((part) => /^\x1b\[(\d+)(?:;30)?m/.exec(badge(part, c))?.[1]), ["42", "100", "43", "46", "105", "7"]);
  });
  it("gives every part its own colour, and none of them red; only the AI's review is the inverse of the text", () => {
    const c = colors(true);
    const shown = Object.values(PARTS).map((part) => badge(part, c));
    assert.equal(new Set(shown.map((b) => /^\x1b\[([\d;]+)m/.exec(b)?.[1])).size, shown.length, "each its own");
    for (const b of shown) {
      assert.doesNotMatch(b, /\x1b\[(41|101|48;)/, "no red block, no colour of our own");
    }
    assert.deepEqual(shown.filter((b) => b.startsWith("\x1b[7m")), [badge(PARTS.review, c)], "inverse for the review alone");
  });
  it("is its name in square brackets without colour (NO_COLOR, a pipe)", () => {
    assert.deepEqual(Object.values(PARTS).map((part) => badge(part, colors(false))), ["[public]", "[code]", "[new user]", "[made-up user]", "[journeys]", "[ai review]"]);
  });
});

describe("a group's block in colour", () => {
  const ended = () => {
    const out = stream();
    const now = clock();
    const screen = new RunScreen(out, { live: false, c: colors(true), now, strays: [] });
    const g = screen.group(PARTS.public);
    g.screen("/", "/");
    now.at(1800);
    g.finding("⚑ something", "/");
    g.screen("/notes", "/notes");
    now.at(4000);
    g.end("done", "2 screens", "reused");
    return out.text.split("\n").filter((line) => line.includes("public") || line.includes("/notes"));
  };
  it("ticks in the theme's green, its words plain, its time and details after a · grey, a screen's time grey, as e2e's", () => {
    const [, head, notes] = ended();
    assert.match(head!, /^\x1b\[32m✓\x1b\[39m /);
    assert.match(head!, /\x1b\[39;49m 2 screens  \x1b\[2m4s\x1b\[22m  \x1b\[2mreused\x1b\[22m$/);
    assert.doesNotMatch(head!, /\x1b\[33m|\x1b\[1m/, "no yellow and nothing bold once it's over");
    assert.match(notes!, /\x1b\[32m✓\x1b\[39m \/notes  \x1b\[2m2\.2s\x1b\[22m$/);
  });
});

/** A short run, as a real one goes: the public pages with something found, the code read beside them, then a made-up user. */
function aRun(screen: RunScreen, now: ReturnType<typeof clock>) {
  screen.note("info", "learning localhost:3000 · AI: none · saves stopped");
  now.at(1_200);
  screen.note("done", "browser ready", "1.2s");
  // The public pages begin once the browser is ready, so the setup lines come first; the code is read beside them.
  const pub = screen.group(PARTS.public);
  const code = screen.group(PARTS.code);
  pub.screen("/", "/");
  pub.detail("1 screen");
  now.at(3_000);
  pub.screen("/reports", "/reports");
  pub.finding("⚑ Label cut off at laptop size: \"Settings\"");
  now.at(7_000);
  pub.screen("/settings", "/settings");
  pub.finding("⚑ \"Import notes\" does nothing when pressed", "/");
  now.at(9_000);
  pub.end("done", "3 screens · sign-in at /login · 2 found");
  code.doing("screen 4 of 15, about 1 min left");
  const madeUp = screen.group(PARTS.madeUpUser);
  madeUp.screen("/notes", "/notes");
  madeUp.doing("measuring at phone width");
  madeUp.finding("⚑ Plural bug: \"1 notes\"");
  now.at(12_000);
  return { pub, code, madeUp };
}

describe("the run's screen on a pipe, a log or NO_COLOR", () => {
  for (const columns of [40, 80, 120]) {
    it(`is plain lines, top to bottom, with no cursor codes, at ${columns} columns`, () => {
      const out = stream({ columns });
      const now = clock();
      const screen = new RunScreen(out, { live: liveWanted(out, {}), c: colors(false), now, strays: [] });
      screen.start();
      const { code, madeUp } = aRun(screen, now);
      screen.progress("  10 screens so far");
      now.at(40_000);
      code.note("! no AI to read it with");
      code.end("warned", "didn't read the code");
      now.at(52_000);
      madeUp.end("done", "1 screen · 1 found");
      screen.stop("done");
      assert.doesNotMatch(out.text, /\x1b/);
      const lines = out.text.trimEnd().split("\n");
      for (const line of lines) assert.ok(visibleWidth(line) <= columns - 1, `${columns}: ${line}`);
      // Narrower than a block's lines, each goes on under its own words, broken between them.
      if (columns === 40) {
        assert.deepEqual(lines.slice(0, 2), ["ℹ learning localhost:3000 · AI: none", "  saves stopped"], "a setup line too, its dot dropped at the break");
        assert.deepEqual(lines.slice(5, 7), ["✓ [public] 3 screens · sign-in at", "           /login · 2 found  8s"]);
        assert.deepEqual(lines.slice(8, 10), ["    ⚑ \"Import notes\" does nothing when", "      pressed"]);
        return;
      }
      assert.deepEqual(lines, [
        "ℹ learning localhost:3000 · AI: none · saves stopped",
        "✓ browser ready 1.2s",
        "❯ [public] started",
        "❯ [code] started",
        "✓ [public] 3 screens · sign-in at /login · 2 found  8s",
        "  × /  1.8s  1 found",
        "    ⚑ \"Import notes\" does nothing when pressed",
        "  × /reports  4.0s  1 found",
        "    ⚑ Label cut off at laptop size: \"Settings\"",
        "  ✓ /settings  2.0s",
        "❯ [made-up user] started",
        "  10 screens so far",
        "! [code] didn't read the code  39s",
        "  ! no AI to read it with",
        "✓ [made-up user] 1 screen · 1 found  43s",
        "  × /notes  43.0s  1 found",
        "    ⚑ Plural bug: \"1 notes\"",
      ]);
    });
  }
  it("says which parts were still going when it stopped, once", () => {
    const out = stream();
    const screen = new RunScreen(out, { live: false, c: colors(false), now: () => 0, strays: [] });
    const journeys = screen.group(PARTS.journeys);
    journeys.detail("4 walked");
    screen.stop("stopped");
    screen.stop("stopped");
    assert.match(out.text, /^! \[journeys\] 4 walked {2}0s {2}stopped$/m);
    assert.equal(out.text.match(/stopped/g)?.length, 1, "once");
  });
  it("marks a part still running when the run failed as failed, not as stopped", () => {
    const out = stream();
    const screen = new RunScreen(out, { live: false, c: colors(false), now: () => 0, strays: [] });
    screen.group(PARTS.public).detail("2 screens");
    screen.stop("failed");
    assert.match(out.text, /^× \[public\] 2 screens {2}0s$/m);
    assert.doesNotMatch(out.text, /stopped/);
  });
});

describe("a group's block, once it has ended", () => {
  const ended = (fill: (g: ReturnType<RunScreen["group"]>, now: ReturnType<typeof clock>) => void) => {
    const out = stream();
    const now = clock();
    const screen = new RunScreen(out, { live: false, c: colors(false), now, strays: [] });
    const g = screen.group(PARTS.newUser);
    fill(g, now);
    g.end("done", "done");
    return out.text.trimEnd().split("\n").slice(2);
  };
  it("lists twelve screens at most: where something was found first, the rest counted", () => {
    const lines = ended((g, now) => {
      for (let k = 0; k < 20; k++) {
        g.screen(`/s${k}`);
        now.at((k + 1) * 1000);
      }
      g.finding("⚑ Plural bug", "/s15");
    });
    assert.equal(lines[0], "  × /s15  1.0s  1 found");
    assert.equal(lines[1], "    ⚑ Plural bug");
    assert.equal(lines.filter((line) => /^ {2}[✓×] /.test(line)).length, 12);
    assert.equal(lines.at(-1), "  · 8 more screens, nothing found");
  });
  it("lists every screen when asked to (--verbose)", () => {
    const out = stream();
    const now = clock();
    const screen = new RunScreen(out, { live: false, c: colors(false), now, strays: [], mostScreens: Infinity });
    const g = screen.group(PARTS.public);
    for (let k = 0; k < 20; k++) g.screen(`/s${k}`);
    g.end("done", "20 screens");
    assert.equal(out.text.split("\n").filter((line) => /^ {2}✓ \/s/.test(line)).length, 20);
    assert.doesNotMatch(out.text, /more screens/);
  });
  it("puts the time after a screen's own on the group, once it steps off it", () => {
    const lines = ended((g, now) => {
      g.screen("/a");
      now.at(2000);
      g.step("one more look at its screens");
      now.at(30_000);
      g.screen("/b");
      now.at(31_000);
    });
    assert.deepEqual(lines, ["  ✓ /a  2.0s", "  ✓ /b  1.0s"]);
  });
  it("tells four things found under a screen, and counts the rest", () => {
    const lines = ended((g) => {
      g.screen("/a");
      for (let k = 0; k < 6; k++) g.finding(`⚑ Item ${k}`);
    });
    assert.deepEqual(lines, ["  × /a  0.0s  6 found", "    ⚑ Item 0", "    ⚑ Item 1", "    ⚑ Item 2", "    ⚑ Item 3", "    · 2 more found here, in FIX.md"]);
  });
  it("lists screens seen without a clock, its items and its notes, in that order", () => {
    const lines = ended((g) => {
      g.saw("/welcome");
      g.item("✓ Add a note  3 steps");
      g.note("the app didn't take the session");
    });
    assert.deepEqual(lines, ["  ✓ /welcome", "  ✓ Add a note  3 steps", "  the app didn't take the session"]);
  });
  it("gives a screen seen once its part is over the time its own walk spent on it, when that's known (a new account's)", () => {
    const lines = ended((g) => {
      g.saw("/welcome", "/welcome", 2_340);
      g.saw("/setup");
    });
    assert.deepEqual(lines, ["  ✓ /welcome  2.3s", "  ✓ /setup"]);
  });
  it("ends the journeys with those walked to the end, and the rest in a line that goes on under itself", () => {
    const out = stream();
    const now = clock();
    const screen = new RunScreen(out, { live: false, c: colors(false), now, strays: [] });
    const g = screen.group(PARTS.journeys);
    g.detail("12 tried · 2 to the end");
    now.at(115_000);
    for (const line of ["✓ Sign up  3 steps", "· 43 more not walked to the end, in FIX.md: 19 stop before a payment, upload", "  or outside account, which it leaves to you"]) g.item(line);
    g.end("done", "3 walked to the end");
    const lines = out.text.trimEnd().split("\n");
    assert.ok(lines.includes("✓ [journeys] 3 walked to the end  1m 55s"), lines.join("\n"));
    assert.deepEqual(lines.slice(-3), ["  ✓ Sign up  3 steps", "  · 43 more not walked to the end, in FIX.md: 19 stop before a payment, upload", "    or outside account, which it leaves to you"]);
    assert.doesNotMatch(out.text, /found|finished/);
  });
  it("adds up the time spent on a screen it comes back to", () => {
    const lines = ended((g, now) => {
      g.screen("/a");
      now.at(1000);
      g.screen("/b");
      now.at(1500);
      g.screen("/a");
      now.at(3500);
    });
    assert.deepEqual(lines, ["  ✓ /a  3.0s", "  ✓ /b  0.5s"]);
  });
  it("says something found after it ended on a line of its own, and counts it", () => {
    const out = stream();
    const screen = new RunScreen(out, { live: false, c: colors(false), now: () => 0, strays: [] });
    const g = screen.group(PARTS.newUser);
    g.end("done", "2 screens");
    g.finding("⚑ Late", "/x");
    assert.equal(g.found, 1);
    assert.match(out.text, /^ {2}⚑ Late$/m);
  });
});

describe("the run's screen live on a terminal", () => {
  const live = (columns: number, rows?: number) => {
    const out = stream({ isTTY: true, columns, ...(rows ? { rows } : {}) });
    const now = clock();
    const screen = new RunScreen(out, { live: true, c: colors(true), now, strays: [] });
    screen.start();
    const parts = aRun(screen, now);
    screen.draw();
    return { out, now, screen, ...parts };
  };
  for (const columns of [80, 120]) {
    it(`draws what's running now and the counts, in place, never wider than ${columns} columns, with ended groups above`, () => {
      const { out, screen } = live(columns);
      for (const line of screen.frame()) assert.ok(visibleWidth(line) <= Math.min(columns, 80) - 2, line);
      const shown = replay(out.text);
      assert.deepEqual(shown, [
        "ℹ learning localhost:3000 · AI: none · saves stopped",
        "✓ browser ready 1.2s",
        "✓  public  3 screens · sign-in at /login · 2 found  8s",
        "  × /  1.8s  1 found",
        "    ⚑ \"Import notes\" does nothing when pressed",
        "  × /reports  4.0s  1 found",
        "    ⚑ Label cut off at laptop size: \"Settings\"",
        "  ✓ /settings  2.0s",
        `${"❯  code".padEnd(74)}0:10`,
        "  └── screen 4 of 15, about 1 min left",
        `${"❯  made-up user".padEnd(74)}0:03`,
        "  ⚑ Plural bug: \"1 notes\"",
        "  └── /notes  3.0s",
        "      ↳ measuring at phone width",
        "",
        "  Findings  3 so far",
        "   Screens  4 visited",
        `  Start at  ${START}`,
        "  Duration  0:12",
      ]);
      assert.match(out.text, /\x1b\[\?25l/, "the cursor is hidden while it draws");
      assert.match(screen.frame()[0]!, /\x1b\[1m\x1b\[33m0:10\x1b\[39m\x1b\[22m$/, "a group's clock bold yellow while it runs, as a test runner's");
      assert.ok(screen.frame().some((line) => /└── \/notes {2}\x1b\[1m\x1b\[33m3\.0s/.test(line)), "and the screen it's on");
    });
  }
  it("ticks: the clocks move on with nothing else happening", () => {
    const { now, screen } = live(80);
    now.at(75_000);
    const frame = screen.frame().map(stripVTControlCharacters);
    assert.match(frame[0]!, /code +1:13$/);
    assert.match(frame.at(-1)!, /Duration {2}1:15$/);
  });
  it("leaves only the ended groups' blocks once it stops, and gives the cursor back", () => {
    const { out, now, screen, code, madeUp } = live(80);
    now.at(40_000);
    code.end("done", "15 screens · 29 actions, none seen", "code unchanged, last read reused");
    now.at(50_000);
    madeUp.end("done", "1 screen · 1 found");
    screen.stop("done");
    const shown = replay(out.text);
    assert.deepEqual(shown.slice(8), [
      "✓  code  15 screens · 29 actions, none seen  39s",
      "         code unchanged, last read reused",
      "✓  made-up user  1 screen · 1 found  41s",
      "  × /notes  41.0s  1 found",
      "    ⚑ Plural bug: \"1 notes\"",
      "",
    ]);
    assert.ok(out.text.endsWith("\x1b[?25h"));
  });
  it("ends a group still running as stopped when the run stops", () => {
    const { out, screen } = live(80);
    screen.stop("stopped");
    const shown = replay(out.text).join("\n");
    assert.match(shown, /^! {2}code {2}stopped {2}11s$/m, "with nothing else to say, only that it stopped");
    assert.match(shown, /^! {2}made-up user {2}stopped {2}3s\n {2}× \/notes {2}3\.0s {2}1 found$/m);
  });
  it("writes each line over the last frame's, so the area is never shown blank between frames", () => {
    const { out } = live(80);
    const frames = out.text.split("\x1b[?2026h").slice(1);
    for (const frame of frames) assert.doesNotMatch(frame.replace(/\x1b\[J\x1b\[\?2026l$/, ""), /\x1b\[J/, "cleared only below the last line");
  });
  it("is never taller than the terminal: what's being done and found goes first, then the screens", () => {
    const { screen } = live(80, 8);
    const frame = screen.frame().map(stripVTControlCharacters);
    assert.ok(frame.length <= 7, String(frame.length));
    assert.ok(!frame.some((line) => /[↳⚑]/.test(line)));
    assert.match(frame[0]!, /code/);
    assert.match(frame.at(-1)!, /Duration/);
    const tiny = live(80, 4).screen.frame().map(stripVTControlCharacters);
    assert.ok(tiny.length <= 3);
    assert.match(tiny.at(-1)!, /Duration/);
  });
  for (const columns of [60, 61, 72]) {
    it(`cuts a line to two columns less than the width at ${columns} columns, so none wraps, keeping its colours`, () => {
      const out = stream({ isTTY: true, columns });
      const screen = new RunScreen(out, { live: true, c: colors(true), now: () => 0, strays: [] });
      screen.start();
      const g = screen.group(PARTS.madeUpUser);
      g.detail(`${"many words that keep on going ".repeat(4)}`);
      g.screen(`/${"very-long-address/".repeat(8)}`);
      g.doing("界".repeat(60));
      g.finding(`\x1b[31m⚑\x1b[39m ${"a long finding ".repeat(10)}`);
      screen.log("x");
      const area = out.text.slice(out.text.lastIndexOf("\x1b[?2026h"));
      for (const line of replay(area).slice(1)) assert.ok(visibleWidth(line) <= columns - 2, `${visibleWidth(line)}: ${line}`);
      assert.match(area, /\x1b\[31m⚑\x1b\[39m a long finding/, "the flag keeps its colour when its line is cut");
      screen.stop();
    });
  }
  it("never cuts an ended block's line: it goes on under its words, broken between them, its colours closed at each break", () => {
    const out = stream({ isTTY: true, columns: 60 });
    const screen = new RunScreen(out, { live: true, c: colors(true), now: () => 0, strays: [] });
    screen.start();
    screen.group(PARTS.code).end("done", "15 screens · 29 actions, none seen", "code unchanged, last read reused, and more words");
    screen.stop();
    assert.deepEqual(replay(out.text, 60).filter(Boolean), ["✓  code  15 screens · 29 actions, none seen  0s", "         code unchanged, last read reused, and more words"]);
    assert.match(out.text, /0s\x1b\[22m\x1b\[0m\x1b\[K\n/, "the first line's colour is closed where it breaks");
    assert.match(out.text, /\x1b\[2K {9}[^\n]*\x1b\[2mcode unchanged/, "and opened again after the indent");
    assert.doesNotMatch(out.text, /\u00a0/, "the spaces that hold words together are written as spaces");
  });
  it("breaks an ended group's line between whole parts: never after a dot, a figure with its unit, the time with the words before it", () => {
    const end = (columns: number, words: string, detail: string) => {
      const out = stream({ isTTY: false, columns });
      let at = 0;
      const screen = new RunScreen(out, { live: false, c: colors(false), now: () => at, strays: [] });
      screen.start();
      const g = screen.group(PARTS.review);
      at = 13_000;
      g.end("done", words, detail);
      screen.stop();
      return out.text.split("\n").filter((line) => line && !line.startsWith("❯"));
    };
    // The real run's line: it fits at 80 columns.
    assert.deepEqual(end(80, "7 reviewed · AI found none", "ai 11.7k tokens · 81% cached"), ["✓ [ai review] 7 reviewed · AI found none  13s  ai 11.7k tokens · 81% cached"]);
    const narrow = end(50, "7 reviewed · AI found none", "screens unchanged, last review reused · ai 11.7k tokens · 81% cached");
    for (const line of narrow) {
      assert.ok(visibleWidth(line) <= 49, line);
      assert.doesNotMatch(line, /·\s*$|^\s*·/, `no dangling dot: ${line}`);
    }
    assert.ok(narrow.some((line) => /\bai 11\.7k tokens\b/.test(line)), narrow.join("\n"));
    assert.ok(narrow.some((line) => /AI found none {2}13s/.test(line)), narrow.join("\n"));
    const pub = end(50, "7 screens · sign-in at / · 1 found", "");
    assert.deepEqual(pub.map((l) => l.trim()), ["✓ [ai review] 7 screens · sign-in at /", "1 found  13s"], "the time never alone on its line");
  });
  it("draws a group whose own work is over as waiting: a dim mark, its clock stopped where it was held and plain, and what it waits for", () => {
    const out = stream({ isTTY: true, columns: 80 });
    const now = clock();
    const screen = new RunScreen(out, { live: true, c: colors(true), now, strays: [] });
    screen.start();
    const g = screen.group(PARTS.newUser);
    g.screen("/welcome");
    now.at(31_000);
    g.hold(2_000, "waiting for the public pages");
    now.at(60_000);
    const [head, under] = screen.frame();
    assert.match(head!, /^\x1b\[2m…\x1b\[22m /);
    assert.match(head!, /\x1b\[2m0:02\x1b\[22m$/, "the time it was held at, not bold, not yellow");
    assert.equal(stripVTControlCharacters(under!), "  └── waiting for the public pages");
    g.end("warned", "not walked");
    screen.stop();
    assert.match(stripVTControlCharacters(out.text), /^! {2}new user {2}not walked {2}2s$/m, "it ends at the time it was held at");
    assert.match(stripVTControlCharacters(out.text), /✓ \/welcome {2}2\.0s/);
  });
  it("cuts the lines under a group to the area's width at a wide terminal, so none runs past the clock", () => {
    const out = stream({ isTTY: true, columns: 120 });
    const screen = new RunScreen(out, { live: true, c: colors(true), now: () => 0, strays: [] });
    screen.start();
    screen.group(PARTS.review).doing("reading the product and reviewing the screens, with your Claude Code sign-in");
    screen.draw();
    const area = out.text.slice(out.text.lastIndexOf("\x1b[?2026h"));
    for (const line of replay(area)) assert.ok(visibleWidth(line) <= 78, `${visibleWidth(line)}: ${line}`);
    screen.stop();
  });
  it("takes the keyboard while it draws: what's typed isn't echoed, so every frame goes back exactly as far as it drew, and a Ctrl-C is passed on", () => {
    const out = stream({ isTTY: true, columns: 80 });
    const input = Object.assign(new EventEmitter(), {
      isTTY: true, isRaw: false, resumed: false, modes: [] as boolean[],
      setRawMode(raw: boolean) {
        input.isRaw = raw;
        input.modes.push(raw);
      },
      resume() {
        input.resumed = true;
      },
      pause() {
        input.resumed = false;
      },
    });
    let interrupts = 0;
    const screen = new RunScreen(out, { live: true, c: colors(true), now: () => 0, strays: [], input, foreground: () => true, interrupt: () => void interrupts++ });
    screen.start();
    assert.deepEqual(input.modes, [true]);
    assert.ok(input.resumed);
    screen.group(PARTS.public).screen("/");
    input.emit("data", Buffer.from("a q\r\x1b[B"));
    screen.draw();
    assert.equal(interrupts, 0);
    input.emit("data", Buffer.from("\x03"));
    assert.equal(interrupts, 1, "Ctrl-C, which raw mode keeps from being a signal, passed on as one");
    screen.log("a line that stays");
    screen.draw();
    // Each frame goes back up over as many rows as the one before it drew, so nothing is left behind.
    const frames = out.text.split("\x1b[?2026h").slice(1);
    let drawn = 0;
    for (const frame of frames) {
      const up = Number(/^\r(?:\x1b\[(\d+)A)?/.exec(frame)?.[1] ?? 0);
      if (drawn) assert.equal(up, drawn - 1, frame);
      drawn = frame.replace(/\x1b\[\?2026l.*$/s, "").split("\n").length - (frame.includes("\x1b[2K") ? 1 : 0);
    }
    assert.equal(replay(out.text).filter((line) => /public/.test(line)).length, 1, "no copy of the area's top line is left behind");
    screen.stop();
    assert.deepEqual(input.modes, [true, false], "given back as it was");
    assert.equal(input.resumed, false);
    assert.equal(input.listenerCount("data"), 0);
  });
  it("leaves the keyboard alone in the background, where taking it would stop the run, and where it's not a terminal", () => {
    for (const [isTTY, foreground] of [[true, false], [false, true]] as const) {
      const modes: boolean[] = [];
      const input = Object.assign(new EventEmitter(), { isTTY, isRaw: false, setRawMode: (raw: boolean) => void modes.push(raw), resume() {}, pause() {} });
      const screen = new RunScreen(stream({ isTTY: true, columns: 80 }), { live: true, c: colors(true), now: () => 0, strays: [], input, foreground: () => foreground });
      screen.start();
      screen.stop();
      assert.deepEqual(modes, [], `${isTTY} ${foreground}`);
    }
  });
  it("keeps anything else written to stdout or stderr above the area, a whole line at a time, and stops catching when it stops", () => {
    const out = stream({ isTTY: true, columns: 80 });
    const stdout = other();
    const stderr = other();
    const now = clock();
    const file = other(false);
    const screen = new RunScreen(out, { live: true, c: colors(true), now, strays: [stdout, stderr, file] });
    screen.start();
    screen.group(PARTS.public).screen("/");
    file.write("to a file\n");
    assert.equal(file.text, "to a file\n", "a stream sent to a file keeps its own writes");
    let called = false;
    stdout.write("(node) a warning from a library\n");
    stderr.write("half a ", () => (called = true));
    stderr.write("line\nand another\n");
    assert.equal(stdout.text + stderr.text, "", "nothing reached the streams themselves");
    const shown = replay(out.text);
    assert.deepEqual(shown.slice(0, 3), ["(node) a warning from a library", "half a line", "and another"]);
    assert.match(shown[3]!, /^❯ {2}public/);
    assert.equal(shown.filter((line) => /public/.test(line)).length, 1, "the area is drawn once, below them");
    screen.stop();
    stdout.write("after\n");
    assert.equal(stdout.text, "after\n");
    return new Promise<void>((done) => setImmediate(() => (assert.ok(called, "a write's callback still runs"), done())));
  });
  it("keeps every character of a line that stays, however its width falls on the window's", () => {
    for (const width of [79, 80, 81, 160]) {
      const out = stream({ isTTY: true, columns: 80 });
      const screen = new RunScreen(out, { live: true, c: colors(true), now: () => 0, strays: [] });
      screen.start();
      screen.group(PARTS.code).doing("reading");
      screen.draw();
      const line = `${"a".repeat(width - 1)}Z`;
      screen.log(line);
      screen.log("next");
      screen.stop();
      const shown = replay(out.text, 80);
      assert.equal(shown.slice(0, Math.ceil(width / 80)).join(""), line, `${width} columns`);
      assert.equal(shown[Math.ceil(width / 80)], "next", `${width} columns`);
    }
  });
  it("draws itself again from scratch when the terminal is resized, going back over the rows its lines wrapped onto", () => {
    const { out, screen, madeUp } = live(80);
    out.resize(40);
    const after = out.text.slice(out.text.lastIndexOf("\x1b[?2026h"));
    // The last drawing's 11 lines, two of them (the groups', 78 columns) wider than 40 now: 13 rows, gone back over from the last.
    assert.match(after, /^\x1b\[\?2026h\r\x1b\[12A\x1b\[J/);
    for (const line of replay(after).slice(1)) assert.ok(visibleWidth(line) <= 38, line);
    madeUp.screen("/more");
    screen.stop();
  });
});

describe("a line cut to the width with its colours kept", () => {
  it("keeps the codes before the cut, ends in … and closes every colour", () => {
    const c = colors(true);
    const line = `${c.green("✓")} ${c.bold("code")} ${c.dim("a".repeat(40))}`;
    const short = cut(line, 20);
    assert.equal(visibleWidth(short), 20);
    assert.ok(short.startsWith("\x1b[32m✓\x1b[39m \x1b[1mcode\x1b[22m \x1b[2m"));
    assert.ok(short.endsWith("…\x1b[0m"));
    assert.equal(cut(line, 80), line, "a line that fits is left as it is");
    assert.equal(cut("plain words that go on", 10), "plain wor…", "and no codes are added to plain text");
    assert.equal(visibleWidth(cut("界".repeat(20), 9)), 9, "a wide character is never cut in half");
  });
});
