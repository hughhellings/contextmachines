// The end of a run on a terminal: how many colours it gets, its badges and greys, and the list of
// items opened in place on a key, with a pretend terminal for stdin and stdout.
//   node --test cli/end-of-run.test.ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fixDoc, fixLines, moreFixLines, nextLines, productDoc, resultLines, type Fix, type ProductMap } from "./report.ts";
import { agentCalling, AGENT_ENV, colors, colorWanted, foregroundFrom, ignoreBrokenPipes, KEY_SETTLE_MS, KEY_WAIT_MS, keyMeaning, keyWanted, TONES, waitForKey, type KeySignals } from "./term.ts";

describe("whether a terminal gets colour", () => {
  const tty = { isTTY: true };
  it("none where colour isn't wanted: NO_COLOR, a pipe, a dumb terminal", () => {
    assert.equal(colorWanted(tty, { NO_COLOR: "1", TERM: "xterm-256color" }), false);
    assert.equal(colorWanted({ isTTY: false }, { TERM: "xterm-256color" }), false);
    assert.equal(colorWanted(tty, { TERM: "dumb" }), false);
  });
  it("a terminal, whatever it says of its colours, a CI log, and where it's forced", () => {
    assert.equal(colorWanted(tty, { TERM: "xterm-256color" }), true);
    assert.equal(colorWanted(tty, { TERM: "xterm" }), true);
    assert.equal(colorWanted({ isTTY: false }, { CI: "true" }), true);
    assert.equal(colorWanted({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  });
});

describe("the colours: the terminal's own 16, as e2e's are", () => {
  it("dimmed details, green ticks, badges in black on the theme's own backgrounds", () => {
    const c = colors(true);
    assert.equal(c.grey("4s"), "\x1b[2m4s\x1b[22m");
    assert.equal(c.ok("✓"), "\x1b[32m✓\x1b[39m", "a fixed light green all but vanishes on a light background");
    assert.equal(c.badge("green", " web "), "\x1b[42;30m web \x1b[39;49m");
    assert.equal(c.badge("yellow", " ios "), "\x1b[43;30m ios \x1b[39;49m");
    assert.equal(c.badge("cyan", " android "), "\x1b[46;30m android \x1b[39;49m");
  });
  it("none: the words as they are", () => {
    const c = colors(false);
    assert.equal(c.enabled, false);
    assert.equal(`${c.grey("4s")}${c.ok("✓")}${c.badge("inverse", " x ")}`, "4s✓ x ");
  });
  it("never a custom colour: no 256-colour or true-colour code anywhere", () => {
    const c = colors(true);
    const all = [c.grey("x"), c.ok("x"), c.bold("x"), c.dim("x"), ...Object.keys(TONES).map((tone) => c.badge(tone as keyof typeof TONES, "x"))].join("");
    assert.doesNotMatch(all, /\x1b\[[\d;]*[34]8;[25];/);
  });
  it("a block for every part, none shared, none red, none black, none blue, none white, normal or bright", () => {
    const tones = Object.values(TONES);
    // Black words can't be read on black or blue; white is a dark grey in VS Code's light theme, and bright white no block on a white background.
    for (const tone of tones) assert.ok(![41, 101, 40, 44, 104, 47, 107].includes(tone), `${tone}`);
    assert.equal(new Set(tones).size, tones.length, `${tones}`);
    assert.equal(colors(true).badge("inverse", " x "), "\x1b[7m x \x1b[27m", "the theme's own colours swapped: a block on any background");
  });
});

const map = (fixes: Fix[], more: Partial<ProductMap> = {}): ProductMap => ({ url: "http://localhost:3000/", product: null, mainAction: null, journeys: [], screens: [{ path: "/notes", title: "Notes", headings: [] }], actions: [], findings: [], predictions: [], fixes, learner: { visited: 1, stoppedBy: "complete", savesStopped: 0, seconds: 10, measured: 1 }, ...more });
const item = (n: number, more: Partial<Fix> = {}): Fix => ({ id: `cut_off-${n}`, status: "proven", from: "check", kind: "cut_off", title: `Label ${n} cut off at laptop size`, screen: "/notes", screens: ["/notes"], evidence: ["needs 71px and has 62px"], fix: "Give it room", where: { file: "src/nav.ts", line: n }, ...more });
const ten = Array.from({ length: 10 }, (_, k) => item(k + 1));
const facts = { out: "contextmachines", html: false, signedIn: false, readingReused: false, issues: 0, product: "PRODUCT.md", noAi: false, next: "Next: hand contextmachines/FIX.md to your coding agent" };
const plainText = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

describe("the rest of the list, at the end of a run", () => {
  it("is each item left, numbered on from the first five, in the same block, then that all of them are shown", () => {
    const text = plainText(moreFixLines(map(ten), facts, colors(true), 80));
    assert.equal(text.match(/^ {2} ?\d+\. /gm)?.join("|"), "   6. |   7. |   8. |   9. |  10. ");
    assert.match(text, /^ {3}6\. proven +Label 6 cut off at laptop size\n {6}where +src\/nav\.ts:6/m);
    // Every item's status, title and rows in the same columns, 9 and 10 alike.
    const columns = new Set(text.split("\n").filter((line) => /^ +(\d+\. )?(proven|where|seen)/.test(line)).map((line) => line.search(/proven|where|seen/)));
    assert.equal(columns.size, 1, [...columns].join(","));
    assert.ok(text.trimEnd().endsWith("  all 10 shown · also in contextmachines/FIX.md"));
    assert.equal(moreFixLines(map(ten.slice(0, 4)), facts, colors(true), 80).length, 0);
  });
  it("leaves out none and repeats none: the first five and the rest are the whole list", () => {
    const fixes = [...ten.slice(0, 7), item(8, { status: "predicted", title: "A guess" }), item(9), item(10)];
    const first = plainText(fixLines(map(fixes), facts, colors(false), 80));
    const rest = plainText(moreFixLines(map(fixes), facts, colors(false), 80));
    const titles = (text: string) => [...text.matchAll(/(Label \d+|A guess)/g)].map((m) => m[1]);
    assert.deepEqual([...titles(first), ...titles(rest)].sort(), fixes.map((f) => f.title.replace(" cut off at laptop size", "")).sort());
  });
  it("numbers each item by its place in the list, so item 6 is the same item on the terminal, in FIX.md and in PRODUCT.md", () => {
    const fixes = [...ten.slice(0, 5), item(6, { status: "predicted", title: "A guess." })];
    const first = plainText(fixLines(map(fixes), facts, colors(false), 80));
    assert.equal(first.match(/^ {2}\d+\. /gm)?.join("|"), "  1. |  2. |  3. |  4. |  5. |  6. ", "the prediction keeps its number, 6, where it's shown fifth");
    assert.match(first, /^ {2}5\. proven +Label 5 cut off at laptop size · in FIX\.md$/m, "and 5, left out, says where it is");
    assert.match(first, /^ {2}6\. predicted +A guess$/m, "and no full stop at a title's end");
    assert.equal(plainText(moreFixLines(map(fixes), facts, colors(false), 80)).match(/^ {2}\d+\. /gm)?.join("|"), "  5. ");
    assert.match(fixDoc(map(fixes), new URL("http://localhost:3000/")), /^### 6\. A guess$/m);
    assert.match(productDoc(map(fixes), [], new URL("http://localhost:3000/")), /^6\. \*\*A guess\*\*/m);
  });
  it("says which walk saw an item with made-up data: the new account's own screens, or the made-up user's", () => {
    const newUser = { status: "walked", message: "", screens: [{ path: "/welcome", photo: null, seenWith: "stand-in" as const }], firstRun: [], notReached: [] };
    const fixes = [item(1, { seenWith: "stand-in", screen: "/welcome", screens: ["/welcome"] }), item(2, { seenWith: "stand-in" })];
    const text = plainText(fixLines(map(fixes, { newUser }), facts, colors(false), 80));
    assert.match(text, /seen {7}\/welcome · new user$/m);
    assert.match(text, /seen {7}\/notes · made-up user$/m);
  });
  it("gives an item's photo from the output folder, however long, on a line of its own when it doesn't fit", () => {
    const out = `some/${"very-long-folder/".repeat(6)}contextmachines`;
    const text = plainText(fixLines(map([item(1, { photo: "screens/notes.jpg" })]), { out }, colors(false), 80));
    assert.ok(text.split("\n").some((line) => line.trim() === `${out}/screens/notes.jpg`), text);
  });
  it("ends with the hand-off: with a path too long for the sentence, the sentence names the file and the path follows whole", () => {
    const path = `/private/tmp/${"folder/".repeat(20)}contextmachines/FIX.md`;
    assert.deepEqual(nextLines(`Next: hand ${path} to your coding agent`, colors(false), 80), [" → Hand FIX.md to your coding agent", `   ${path}`]);
    assert.deepEqual(nextLines("Next: hand contextmachines/FIX.md to your coding agent", colors(false), 80), [" → Hand contextmachines/FIX.md to your coding agent"]);
  });
  it("wraps the note about items from the last run to the width, at a word", () => {
    const text = plainText(fixLines(map([item(1)], { gone: [{ title: "x", status: "proven" }] }), facts, colors(false), 60));
    for (const line of text.split("\n")) assert.ok(line.length <= 60, line);
    assert.match(text, /^ {2}1 item from the last run not listed now: gone isn't the\n {2}same as fixed, see FIX\.md$/m);
  });
  it("is all there with --all, with nothing to open and no '…and more'", () => {
    const lines = resultLines(map(ten), { ...facts, all: true }, colors(false), 80);
    const text = lines.join("\n");
    assert.equal(text.match(/^ {2} ?\d+\. /gm)?.length, 10);
    assert.match(text, /Fix first 10/);
    assert.doesNotMatch(text, /…and \d+ more/);
  });
});

describe("the summary's colours", () => {
  const end = () => resultLines(map([...ten.slice(0, 3), item(4, { status: "predicted", title: "A guess", new: true })], { sinceLast: { new: 1, gone: 0, kept: 3 } } as Partial<ProductMap>), facts, colors(true), 80);
  it("labels and separators in grey, counts in bold: proven red, predicted yellow, new cyan", () => {
    const findings = end().find((line) => line.includes("Findings"))!;
    assert.match(findings, /^ {2}\x1b\[2mFindings\x1b\[22m/);
    assert.match(findings, /\x1b\[31m\x1b\[1m3 proven\x1b\[22m\x1b\[39m\x1b\[2m · \x1b\[22m\x1b\[33m\x1b\[1m1 predicted\x1b\[22m\x1b\[39m\x1b\[2m · \x1b\[22m\x1b\[36m\x1b\[1m1 new\x1b\[22m\x1b\[39m/);
  });
  it("what was seen in bold green, as e2e's passes; the duration plain", () => {
    const lines = end();
    assert.match(lines.find((line) => line.includes("Screens"))!, /\x1b\[32m\x1b\[1m1 seen\x1b\[22m\x1b\[39m/);
    assert.match(lines.find((line) => line.includes("Duration"))!, /\x1b\[22m {2}10s$/);
  });
  it("keeps the Fix first banner as it was", () => {
    assert.ok(end().some((line) => line.includes("\x1b[7m\x1b[1m Fix first 4 \x1b[22m\x1b[27m")));
  });
  it("reads the same without colour", () => {
    const plain = resultLines(map(ten.slice(0, 2)), facts, colors(false), 80).join("\n");
    assert.doesNotMatch(plain, /\x1b/);
    assert.match(plain, /Findings {2}2 proven/);
  });
});

describe("whether the end waits for a key", () => {
  const person = { stdin: { isTTY: true }, stdout: { isTTY: true }, live: true, json: false, noPrompt: false };
  it("does for a person at a terminal", () => {
    assert.equal(keyWanted(person, { TERM: "xterm-256color" }), true);
  });
  it("doesn't for anything that isn't a person at a terminal", () => {
    assert.equal(keyWanted({ ...person, stdin: { isTTY: false } }, {}), false, "stdin a pipe");
    assert.equal(keyWanted({ ...person, stdout: { isTTY: false } }, {}), false, "stdout a pipe");
    assert.equal(keyWanted({ ...person, live: false }, {}), false, "no live area (narrow, NO_COLOR)");
    assert.equal(keyWanted({ ...person, json: true }, {}), false, "--json");
    assert.equal(keyWanted({ ...person, noPrompt: true }, {}), false, "--no-prompt");
    assert.equal(keyWanted(person, { CI: "true" }), false, "CI");
    assert.equal(keyWanted(person, { TERM: "dumb" }), false, "a dumb terminal");
  });
  it("doesn't for a run in the background, and asks that last", () => {
    let asked = 0;
    const background = () => (asked++, false);
    assert.equal(keyWanted({ ...person, foreground: background }, {}), false);
    assert.equal(asked, 1);
    assert.equal(keyWanted({ ...person, json: true, foreground: background }, {}), false);
    assert.equal(asked, 1, "not asked when something else already says no");
    assert.equal(keyWanted({ ...person, foreground: () => true }, {}), true);
  });
  it("reads ps for whether the run is the terminal's foreground job", () => {
    assert.equal(foregroundFrom(" 4242  4242\n"), true);
    assert.equal(foregroundFrom(" 4242  4250\n"), false, "a job sent to the background");
    assert.equal(foregroundFrom("    0  4250"), false, "no terminal");
    assert.equal(foregroundFrom(""), false);
    assert.equal(foregroundFrom("-1 -1"), false);
  });
  it("doesn't for an agent, by what each sets", () => {
    for (const name of AGENT_ENV) assert.equal(keyWanted(person, { [name]: "1" }), false, name);
    assert.equal(keyWanted(person, { AIDER_MODEL: "x" }), false, "aider");
    assert.equal(agentCalling({ CODEX_HOME: "/somewhere" }), false, "CODEX_HOME alone is a person's setting");
    assert.equal(agentCalling({ CODEX_HOME: "/somewhere", CODEX_THREAD_ID: "t1" }), true);
    assert.equal(agentCalling({ CLAUDECODE: "" }), false, "set but empty");
  });
});

describe("keys", () => {
  it("a, space and the down arrow list the rest; q, Enter, Esc, Ctrl-C and Ctrl-D finish; anything else is nothing", () => {
    assert.deepEqual(["a", "A", " ", "\x1b[B", "\x1bOB"].map((k) => keyMeaning(k)), ["a", "a", "a", "a", "a"]);
    assert.deepEqual(["q", "Q", "\r", "\n", "\x1b", "\x03", "\x04"].map((k) => keyMeaning(k)), Array(7).fill("done"));
    assert.deepEqual(["x", "\x1b[A", "1"].map((k) => keyMeaning(k)), [undefined, undefined, undefined]);
  });
  it("only the menu's own letters count: one not offered is nothing", () => {
    const all = ["f", "o", "a", "c"] as const;
    assert.deepEqual(["f", "O", "a", "c"].map((k) => keyMeaning(k, all)), ["f", "o", "a", "c"]);
    assert.equal(keyMeaning("f", ["o", "a"]), undefined, "no agent: f does nothing");
    assert.equal(keyMeaning("c", ["o"]), undefined, "no clipboard: c does nothing");
    assert.equal(keyMeaning(" ", ["o"]), undefined, "a already listed: space does nothing");
  });
});

/** A pretend terminal to read keys from: it keeps its raw mode, and whether it's reading. */
function keyboard() {
  const events = new EventEmitter();
  const k = {
    isTTY: true,
    isRaw: false,
    reading: false,
    modes: [] as boolean[],
    setRawMode: (raw: boolean) => {
      k.isRaw = raw;
      k.modes.push(raw);
    },
    on: (event: string, listener: (chunk?: unknown) => void) => events.on(event, listener),
    off: (event: string, listener: (chunk?: unknown) => void) => events.off(event, listener),
    resume: () => void (k.reading = true),
    pause: () => void (k.reading = false),
    press: (key: string) => events.emit("data", Buffer.from(key)),
    end: () => events.emit("end"),
    listening: () => events.listenerCount("data"),
  };
  return k;
}
/** A pretend process for the wait's signals and exit. */
function proc() {
  const events = new EventEmitter();
  return { on: (e: string, l: () => void) => events.on(e, l), off: (e: string, l: () => void) => events.off(e, l), emit: (e: string) => events.emit(e), count: () => ["exit", "SIGTERM", "SIGHUP", "SIGINT"].reduce((n, e) => n + events.listenerCount(e), 0) } as KeySignals & { emit(e: string): void; count(): number };
}
const screen = () => {
  const s = { text: "", write: (t: string) => void (s.text += t) };
  return s;
};

describe("waiting for a key", () => {
  const start = (ms?: number) => {
    const input = keyboard();
    const output = screen();
    const signals = proc();
    const waiting = waitForKey("  press a to show all 10 · q to finish", { input, output, signals, settle: 0, ...(ms ? { ms } : {}) });
    return { input, output, signals, waiting };
  };
  const givenBack = (t: ReturnType<typeof start>) => {
    assert.equal(t.input.isRaw, false, "raw mode off again");
    assert.equal(t.input.reading, false, "no longer reading");
    assert.equal(t.input.listening(), 0, "nothing listening to the keys");
    assert.equal(t.signals.count(), 0, "nothing listening to the process");
    assert.ok(t.output.text.endsWith("\r\x1b[2K\x1b[?25h"), "the hint cleared and the cursor shown");
  };
  it("shows the hint, reads in raw mode, and opens the rest on a", async () => {
    const t = start();
    assert.ok(t.output.text.startsWith("  press a to show all 10 · q to finish"));
    assert.equal(t.input.isRaw, true);
    assert.equal(t.input.reading, true);
    t.input.press("x");
    t.input.press("a");
    assert.equal(await t.waiting, "a");
    givenBack(t);
    assert.deepEqual(t.input.modes, [true, false]);
  });
  for (const [name, key] of [["q", "q"], ["Enter", "\r"], ["Esc", "\x1b"], ["Ctrl-C", "\x03"], ["Ctrl-D", "\x04"]] as const) {
    it(`finishes on ${name}, the hint cleared`, async () => {
      const t = start();
      t.input.press(key);
      assert.equal(await t.waiting, "done");
      givenBack(t);
    });
  }
  it("counts a paste by its first key that means something", async () => {
    const t = start();
    t.input.press("xq");
    assert.equal(await t.waiting, "done");
  });
  it("finishes on its own when the wait runs out, on a timer that keeps nothing alive", async () => {
    assert.equal(KEY_WAIT_MS, 600_000);
    // The wait's own timer is unref'd, so the test holds the loop open: Node 22's runner would
    // otherwise end the file with this test's promise still pending, and cancel the rest.
    const hold = setInterval(() => {}, 1000);
    try {
      const t = start(20);
      assert.equal(await t.waiting, "timeout");
      givenBack(t);
    } finally {
      clearInterval(hold);
    }
  });
  it("gives the terminal back on a signal, and finishes", async () => {
    const t = start();
    t.signals.emit("SIGTERM");
    assert.equal(await t.waiting, "done");
    givenBack(t);
  });
  it("gives the terminal back when the process exits while it waits", () => {
    const t = start();
    t.signals.emit("exit");
    givenBack(t);
  });
  it("gives the terminal back when reading the keys ends", async () => {
    const t = start();
    t.input.end();
    assert.equal(await t.waiting, "done");
    givenBack(t);
  });
  it("leaves a terminal that was raw already as it was", async () => {
    const input = keyboard();
    input.isRaw = true;
    const waiting = waitForKey("hint", { input, output: screen(), signals: proc(), settle: 0 });
    input.press("q");
    assert.equal(await waiting, "done");
    assert.equal(input.isRaw, true);
  });
  it("throws away keys typed during the run, which arrive as soon as it reads", async () => {
    assert.ok(KEY_SETTLE_MS > 0 && KEY_SETTLE_MS <= 100);
    const input = keyboard();
    const waiting = waitForKey("hint", { input, output: screen(), signals: proc(), settle: 30 });
    input.press("\r");
    input.press("a");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(input.isRaw, true, "still waiting: the early Enter and a didn't answer it");
    input.press("q");
    assert.equal(await waiting, "done");
  });
  it("still finishes when the terminal has gone and the last write fails", async () => {
    const input = keyboard();
    const output = { write: (t: string) => { if (t.includes("\x1b[?25h")) throw Object.assign(new Error("write EIO"), { code: "EIO" }); } };
    const signals = proc();
    const waiting = waitForKey("hint", { input, output, signals, settle: 0 });
    signals.emit("SIGHUP");
    assert.equal(await waiting, "done");
    assert.equal(input.isRaw, false);
  });
  it("drops output to a terminal that has gone, as to a closed pipe, and still throws anything else", () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    ignoreBrokenPipes([stream]);
    stream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }));
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    assert.throws(() => stream.emit("error", Object.assign(new Error("no room"), { code: "ENOSPC" })), /no room/);
  });
  it("gives the terminal back when raw mode itself fails", async () => {
    const input = keyboard();
    input.setRawMode = (raw: boolean) => {
      if (raw) throw new Error("not a terminal");
      input.isRaw = false;
    };
    const output = screen();
    assert.equal(await waitForKey("hint", { input, output, signals: proc() }), "done");
    assert.equal(input.reading, false);
    assert.ok(output.text.endsWith("\x1b[?25h"));
  });
});
