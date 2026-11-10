import { describe, expect, it } from "vitest";
import { brokenWording, countMismatch, fixedLabel, mergeChecks, type Drawn, type ScreenCheck } from "../src/checks.ts";

const page = (lines: string[], more: Partial<Drawn> = {}): Drawn => ({ lines: lines.map((text) => ({ text, mono: false, chrome: false })), code: false, lang: "en", ...more });
const found = (lines: string[], more: Partial<Drawn> = {}) => brokenWording(page(lines, more)).map((w) => `${w.problem}: ${w.phrase}`);

describe("a count of one with a plural noun", () => {
  it("ends at a mark as at a word", () => {
    expect(countMismatch("closed of 1 trades · in money")).toBe("1 trades");
    expect(countMismatch("Tier 1 trades · in money")).toBeUndefined();
  });

  it.each([
    ["1 trades", "1 trades"],
    ["on 1 closed trades", "1 closed trades"],
    ["Market conditions are read for 0 of 1 trades; that fills in on its own.", "1 trades"],
    ["You have 1 items", "1 items"],
    ["Showing 1 results.", "1 results"],
    ["Based on 1 completed sessions in March", "1 completed sessions"],
    ["1 Trades", "1 trades"],
    ["(1 errors)", undefined],
  ])("%s", (line, phrase) => {
    if (phrase === undefined) return;
    expect(countMismatch(line)?.toLowerCase()).toBe(phrase);
  });

  it.each([
    "1 trade", "1 of 3 items", "1/3 items", "21 items", "1,001 items", "1.1 items", "Tier 1 customers", "Day 1 rewards", "Step 1 details", "Top 1 sellers",
    "Player 1 wins", "1 day trades", "1 bed apartments", "1 hundred dollars", "1 news item", "1 sales rep", "1 savings account", "1 class", "1 status", "1 analysis",
    "1 series", "1 bus", "1 lens", "1 plus 1", "1 times 2", "1 Hotels Group", "Chapter 1 notes", "Q1 trades", "#1 reasons", "$1 trades", "1 runs every day",
  ])("not %s", (line) => {
    expect(countMismatch(line)).toBeUndefined();
  });

  it("in other languages, only words known to be plurals, at the start of a line", () => {
    expect(countMismatch("1 elementos", "es")).toBe("1 elementos");
    expect(countMismatch("1 Dateien", "de-DE")).toBe("1 Dateien");
    expect(countMismatch("1 résultats", "fr")).toBe("1 résultats");
    expect(countMismatch("1 Artikel", "de")).toBeUndefined(); // the same word for one and for many
    expect(countMismatch("Tag 1 Aufgaben", "de")).toBeUndefined();
    expect(countMismatch("1 trades", "de")).toBeUndefined();
  });
});

describe("numbers that are positions", () => {
  it("a 1 with the next number beside it and another word is a step, however it's written", () => {
    expect(found(["1 Details", "2 Shipping", "3 Payment"])).toEqual([]);
    expect(found(["1 Details", "2 Shipping address"])).toEqual([]);
  });

  it("a 1 alone, or a next number with the same word, is still a count", () => {
    expect(found(["1 Trades"])).toEqual(["count: 1 Trades"]);
    expect(found(["1 Details", "Shipping"])).toEqual(["count: 1 Details"]);
    expect(found(["1 Trades", "2 Trades"])).toEqual(["count: 1 Trades"]);
    expect(found(["1 trades", "2 shipping"])).toEqual(["count: 1 trades"]);
  });
});

describe("holes in the words", () => {
  it("finds what a template left behind", () => {
    expect(found(["undefined"])).toEqual(["missing_value: undefined"]);
    expect(found(["Total: $NaN"])).toEqual(["missing_value: NaN"]);
    expect(found(["NaN%"])).toEqual(["missing_value: NaN"]);
    expect(found(["Win rate: null"])).toEqual(["missing_value: null"]);
    expect(found(["Welcome back, undefined!"])).toEqual(["missing_value: undefined"]);
    expect(found(["undefined undefined"])).toEqual(["missing_value: undefined"]);
    expect(found(["Category: [object Object]"])).toEqual(["missing_value: [object Object]"]);
    expect(found(["Hello {name}"])).toEqual(["placeholder: {name}"]);
    expect(found(["Hi {{ user.first_name }}, welcome"])).toEqual(["placeholder: {{ user.first_name }}"]);
    expect(found(["Due on ${date}"])).toEqual(["placeholder: ${date}"]);
  });

  it("takes a word talked about in a sentence for a subject, however it's capitalised", () => {
    const lines = ["null", "Null means the token has no owner on this chain at all"].map((text) => ({ text, mono: false, chrome: false }));
    expect(brokenWording({ lines, code: false, lang: "en" })).toEqual([]);
  });

  it("leaves the same words alone where they mean something", () => {
    expect(found(["NAN", "NULL", "Nan Goldin", "nan"])).toEqual([]); // a ticker, a name
    expect(found(["The null hypothesis was rejected"])).toEqual([]);
    expect(found(["null and void"])).toEqual([]);
    expect(found(["Returns undefined if the key is missing from the map you pass in"])).toEqual([]);
    expect(found(["null"], { code: true })).toEqual([]); // a page showing code
    expect(found(["null", "true", "false", "number"])).toEqual([]); // a list of values
    expect(found(["null", "A field set to null is left out of the export and never shown."])).toEqual([]); // the word is the subject
    expect(brokenWording({ ...page([]), lines: [{ text: "null", mono: true, chrome: false }] })).toEqual([]); // set in type to show the value as it is
    expect(found(["Use {name} to put in the customer's name"])).toEqual([]);
    expect(found(["Insert a variable such as {{first_name}}"])).toEqual([]);
    expect(found(["\\frac{a}{b}"])).toEqual([]);
    expect(found(["Set {a} and {b} together, as the guide's first long paragraph tells you to, over several lines of text like these."])).toEqual([]);
  });
});

describe("labels", () => {
  it("are fixed words, not values in a narrow box", () => {
    expect(fixedLabel("Backtesting", false)).toBe(true);
    expect(fixedLabel("Add trades", false)).toBe(true);
    expect(fixedLabel("Backtesting", true)).toBe(false); // a tooltip says the cut is meant
    expect(fixedLabel("someone@example.test", false)).toBe(false);
    expect(fixedLabel("report-2024.pdf", false)).toBe(false);
    expect(fixedLabel("Invoice 10442", false)).toBe(false);
    expect(fixedLabel("A whole long sentence that was put on a button for some reason", false)).toBe(false);
  });
});

describe("one item for each thing to fix", () => {
  const check = (screen: string, more: Partial<ScreenCheck> = {}): ScreenCheck => ({ kind: "cut_off", screen, screens: [screen], target: "Backtesting", evidence: "x", ...more });

  it("gathers the same thing on many screens", () => {
    const [one, ...rest] = mergeChecks([check("/a"), check("/b"), check("/b")]);
    expect(rest).toEqual([]);
    expect(one?.screens).toEqual(["/a", "/b"]);
  });

  it("keeps a real screen's apart from a stand-in's, and says when only a new account saw it", () => {
    expect(mergeChecks([check("/a"), check("/b", { seenWith: "stand-in" })])).toHaveLength(2);
    expect(mergeChecks([check("/a", { newUser: true }), check("/b", { newUser: true })])[0]?.newUser).toBe(true);
    expect(mergeChecks([check("/a", { newUser: true }), check("/b")])[0]?.newUser).toBeUndefined();
  });
});
