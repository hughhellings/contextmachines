import { normalizeUrl } from "@contextmachines/snippet/capture";
import { describe, expect, it } from "vitest";
import { fixesFor, fromPattern, limitsSaid, valueMeeting, type FieldState } from "../src/form-values.ts";
import { PAGE_TURNER, pressOrder, remember, uniqueCount, type Control, type PressMemory } from "../src/priorities.ts";
import { scopeOf } from "../src/scan.ts";

const field = (over: Partial<FieldState>): FieldState => ({
  mark: "0", tag: "input", type: "text", inputMode: "", hint: "", placeholder: "", value: "", min: "", max: "", step: "",
  minLength: -1, maxLength: -1, pattern: "", invalid: true, flagged: false, says: "", ...over,
});
const control = (label: string, over: Partial<Control> = {}): Control => ({ label, shell: false, floating: false, inMain: false, turner: false, kind: "BUTTON.", spot: "0,0", ...over });
const today = new Date(Date.UTC(2026, 10, 4));

describe("how much of a site a start is about", () => {
  it("takes one screen for a screen, not a folder", () => {
    expect(scopeOf("/posts/new")).toBe("/");
    expect(scopeOf("/app/dashboard")).toBe("/");
    expect(scopeOf("/a/b/page")).toBe("/");
    expect(scopeOf("/blog/first.html")).toBe("/");
  });
  it("keeps to what plainly is a folder or an app's front door", () => {
    expect(scopeOf("/examples/react/")).toBe("/examples/react/");
    expect(scopeOf("/parabank/index.htm")).toBe("/parabank/");
    expect(scopeOf("/shop/default.aspx")).toBe("/shop/");
    expect(scopeOf("/web/index.php/auth/login")).toBe("/web/");
  });
});

describe("a form tells you what it wants", () => {
  it("reads limits the way messages word them", () => {
    expect(limitsSaid("Message must be minimal 50 characters")).toEqual({ lower: 50 });
    expect(limitsSaid("at least 8 characters")).toEqual({ lower: 8 });
    expect(limitsSaid("8 characters minimum")).toEqual({ lower: 8 });
    expect(limitsSaid("must be more than 5")).toEqual({ lower: 6 });
    expect(limitsSaid("Must be between 10 and 20")).toEqual({ lower: 10, upper: 20 });
    expect(limitsSaid("no more than £1,500")).toEqual({ upper: 1500 });
    expect(limitsSaid("Minimum income is £30k")).toEqual({ lower: 30000 });
    expect(limitsSaid("Please fill in this field")).toEqual({});
  });

  it("meets a number's limits and step, not a magic number", () => {
    expect(valueMeeting(field({ type: "number", min: "18000", value: "10" }), 0)).toBe("18000");
    expect(valueMeeting(field({ type: "number", min: "3", step: "5", value: "1" }), 0)).toBe("3");
    expect(valueMeeting(field({ type: "number", min: "2", step: "5", value: "1", says: "at least 4" }), 0)).toBe("7");
    expect(valueMeeting(field({ type: "number", max: "5", value: "10" }), 0)).toBe("1");
    expect(valueMeeting(field({ inputMode: "numeric", value: "10", says: "Must be at least 2,500" }), 0)).toBe("2500");
  });

  it("with no limit stated tries a far larger number, then a far smaller one", () => {
    const refused = field({ inputMode: "numeric", value: "10", says: "Your income doesn't meet the requirement" });
    expect(valueMeeting(refused, 0)).toBe("100000");
    expect(valueMeeting({ ...refused, value: "100000" }, 1)).toBe("1");
    const tooMuch = field({ inputMode: "numeric", value: "10", says: "That's too high" });
    expect(valueMeeting(tooMuch, 0)).toBe("1");
  });

  it("writes text as long as it's asked to be, and no longer", () => {
    const long = valueMeeting(field({ tag: "textarea", type: "textarea", value: "Test", says: "Message must be minimal 50 characters" }), 0)!;
    expect(long.length).toBeGreaterThanOrEqual(50);
    expect(valueMeeting(field({ value: "Test", minLength: 12 }), 0)!.length).toBe(12);
    expect(valueMeeting(field({ value: "Too long for it", maxLength: 3 }), 0)).toBe("Too");
  });

  it("gives a date on the right side of today", () => {
    expect(valueMeeting(field({ type: "date", value: "2027-01-15", hint: "date of birth", says: "Must be 18 or older" }), 0, today)).toBe("1990-01-15");
    expect(valueMeeting(field({ type: "date", value: "2020-01-15", hint: "arrival", says: "Date must be in the future" }), 0, today)).toBe("2026-12-04");
    expect(valueMeeting(field({ type: "date", value: "2020-01-15", min: "2031-03-01" }), 0, today)).toBe("2031-03-01");
    expect(valueMeeting(field({ value: "1990-01-15", hint: "birth", placeholder: "dd/mm/yyyy", says: "Use the format shown" }), 0, today)).toBe("15/01/1990");
  });

  it("answers a pattern with a sample that matches it", () => {
    for (const pattern of ["[0-9]{5}", "[A-Z]{2}\\d{4}", "\\d{3}-\\d{3}-\\d{4}", "(GB|FR)[0-9]{2}", "[a-z]+@[a-z]+\\.com", "[A-Za-z ]{3,}"]) {
      const sample = fromPattern(pattern);
      expect(sample, pattern).toBeDefined();
      expect(new RegExp(`^(?:${pattern})$`).test(sample!), pattern).toBe(true);
    }
    expect(new RegExp("^(?=.*\\d)(?=.*[A-Z]).{8,}$").test(fromPattern("(?=.*\\d)(?=.*[A-Z]).{8,}")!)).toBe(true);
  });

  it("gives digits to a box that says how many", () => {
    expect(valueMeeting(field({ hint: "postcode", value: "Test", says: "Must be 5 digits" }), 0)).toBe("12345");
  });

  it("tries a plain postal code on one that won't say what's wrong with it", () => {
    expect(valueMeeting(field({ hint: "postal_code", value: "Test", flagged: true, invalid: false }), 0)).toBe("12345");
  });

  it("changes the field a message names, and only that", () => {
    const seen = { message: "Your income doesn't meet the requirement for this home.", fields: [
      field({ mark: "a", inputMode: "numeric", hint: "monthly income income", value: "10", invalid: false }),
      field({ mark: "b", hint: "employer", value: "Test", invalid: false }),
    ] };
    expect(fixesFor(seen, 0)).toEqual([{ mark: "a", kind: "fill", value: "100000" }]);
  });

  it("leaves a form alone when nothing says what's wrong", () => {
    expect(fixesFor({ message: "", fields: [field({ value: "Test", invalid: false }), field({ type: "number", value: "10", invalid: false })] }, 0)).toEqual([]);
  });

  it("doesn't press again when it has nothing better to offer", () => {
    expect(fixesFor({ message: "", fields: [field({ type: "email", value: "learner@example.test" })] }, 0)).toEqual([]);
  });

  it("chooses from a list and ticks a box that's asked for, but never a marketing one", () => {
    const list = field({ mark: "l", tag: "select", type: "select", value: "", options: ["a", "b"] });
    const terms = field({ mark: "t", type: "checkbox", hint: "i accept the terms" });
    const offers = field({ mark: "o", type: "checkbox", hint: "send me offers" });
    expect(fixesFor({ message: "", fields: [list, terms, offers] }, 0)).toEqual([{ mark: "l", kind: "select", value: "a" }, { mark: "t", kind: "check", value: "" }]);
  });
});

describe("time goes to what's unique to a page", () => {
  it("presses the main content first, the site's furniture last", () => {
    const memory: PressMemory = new Map();
    const page = [control("Menu", { shell: true }), control("Help chat", { floating: true }), control("Filter"), control("Add to cart", { inMain: true })];
    expect(pressOrder(page, memory, 12)).toEqual(["Add to cart", "Filter", "Menu", "Help chat"]);
  });

  it("presses what's the same on every page once on the site", () => {
    const memory: PressMemory = new Map();
    const panel = control("Help chat", { floating: true });
    const menu = control("Menu", { shell: true });
    remember(panel, memory);
    remember(menu, memory);
    expect(pressOrder([panel, menu, control("Add to cart")], memory, 12)).toEqual(["Add to cart"]);
  });

  it("counts every page of a list as one", () => {
    const memory: PressMemory = new Map();
    const pages = ["2", "3", "4", "Next"].map((label) => control(label, { turner: true }));
    remember(pages[0], memory);
    expect(pressOrder(pages, memory, 12)).toEqual([]);
  });

  it("takes a control unmarked as furniture for furniture once it's been in the same place twice", () => {
    const memory: PressMemory = new Map();
    const guide = control("Guide", { spot: "4,2" });
    expect(pressOrder([guide], memory, 12)).toEqual(["Guide"]);
    remember(guide, memory);
    remember(guide, memory);
    expect(pressOrder([guide], memory, 12)).toEqual([]);
  });

  it("keeps the same words in the main content, which can mean something else on each page", () => {
    const memory: PressMemory = new Map();
    const edit = control("Edit", { inMain: true, spot: "4,2" });
    remember(edit, memory);
    remember(edit, memory);
    remember(edit, memory);
    expect(pressOrder([control("Archive", { inMain: true }), edit], memory, 12)).toEqual(["Archive", "Edit"]);
  });

  it("samples a long collection, without dropping the rest", () => {
    const memory: PressMemory = new Map();
    const cards = Array.from({ length: 6 }, (_, i) => control(`Item ${i}`, { kind: "DIV.card", inMain: true }));
    const order = pressOrder([...cards, control("Sort", { inMain: true })], memory, 12);
    expect(order.slice(0, 3)).toEqual(["Item 0", "Item 1", "Sort"]);
    expect(order).toHaveLength(7);
    expect(pressOrder([...cards, control("Sort", { inMain: true })], memory, 3)).toEqual(["Item 0", "Item 1", "Sort"]);
  });

  it("knows a page turner from an ordinary word", () => {
    for (const label of ["2", "Next", "Previous", "Next →", "← Previous", "›", "Page-3", "Go to page 4", "Next page"]) expect(label).toMatch(PAGE_TURNER);
    for (const label of ["Next steps", "Add to cart", "Page settings", "Last orders"]) expect(label).not.toMatch(PAGE_TURNER);
  });

  it("counts what a page has that nothing else has shown", () => {
    const memory: PressMemory = new Map();
    remember(control("Seen"), memory);
    expect(uniqueCount([control("Seen"), control("New"), control("Menu", { shell: true }), control("3", { turner: true })], memory)).toBe(1);
  });
});

describe("a hash route's address stays one you can open", () => {
  it("takes no slash after a file", () => {
    expect(normalizeUrl("https://x.test/docs/index.html#/Accounts", "https://x.test/")?.path).toBe("/docs/index.html#/Accounts");
  });
  it("keeps a folder's or the root's as they were", () => {
    expect(normalizeUrl("https://x.test/#/contacts", "https://x.test/")?.path).toBe("/#/contacts");
    expect(normalizeUrl("https://x.test/app/#/contacts", "https://x.test/")?.path).toBe("/app/#/contacts");
  });
});
