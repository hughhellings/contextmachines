/**
 * A date the AI writes the way people do ("2026-11-02 09:30") goes into a browser's own date box the
 * way the box takes it (2026-11-02T09:30), instead of the fill being refused and tried again.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { dateForBox } from "../packages/scanner/src/tester/act.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";

describe("dateForBox", () => {
  it("a date-and-time box takes the T form", () => {
    assert.equal(dateForBox("datetime-local", "2026-11-02 09:30"), "2026-11-02T09:30");
    assert.equal(dateForBox("datetime-local", "2026-11-02T09:30"), "2026-11-02T09:30");
    assert.equal(dateForBox("datetime-local", "2026/11/2 9:30 pm"), "2026-11-02T21:30");
    assert.equal(dateForBox("datetime-local", "2026-11-02 10:00:15"), "2026-11-02T10:00:15");
  });
  it("a date box takes the date part, a time box the time part, a month box the month", () => {
    assert.equal(dateForBox("date", "2026-11-02 09:30"), "2026-11-02");
    assert.equal(dateForBox("date", "2026/11/2"), "2026-11-02");
    assert.equal(dateForBox("time", "2026-11-02 09:30"), "09:30");
    assert.equal(dateForBox("time", "9:30 am"), "09:30");
    assert.equal(dateForBox("time", "12:15 am"), "00:15");
    assert.equal(dateForBox("time", "12:15 pm"), "12:15");
    assert.equal(dateForBox("month", "2026-11-02"), "2026-11");
  });
  it("never guesses: day-or-month-first dates, a date with no time for a date-and-time box, and other boxes are left as they were", () => {
    assert.equal(dateForBox("date", "11/02/2026"), "11/02/2026");
    assert.equal(dateForBox("datetime-local", "2026-11-02"), "2026-11-02");
    assert.equal(dateForBox("time", "25:00"), "25:00");
    assert.equal(dateForBox("text", "2026-11-02 09:30"), "2026-11-02 09:30");
  });
});

describe("in a real browser", () => {
  let browser: Browser;
  before(async () => {
    browser = await launch(false);
  });
  after(async () => {
    await browser?.close();
  });
  it("the rewritten values are taken by date, date-and-time and time boxes", async () => {
    const page = await browser.newPage();
    await page.setContent(`<input id=dt type=datetime-local><input id=d type=date><input id=t type=time>`);
    for (const [id, type, said] of [["dt", "datetime-local", "2026-11-02 09:30"], ["d", "date", "2026-11-02 09:30"], ["t", "time", "9:30 pm"]] as const) {
      await assert.rejects(page.locator(`#${id}`).fill(said, { timeout: 2000 }), /malformed value/i, `${type} refuses "${said}" as written`);
      await page.locator(`#${id}`).fill(dateForBox(type, said), { timeout: 2000 });
      assert.notEqual(await page.locator(`#${id}`).inputValue(), "", type);
    }
    assert.equal(await page.locator("#dt").inputValue(), "2026-11-02T09:30");
    assert.equal(await page.locator("#t").inputValue(), "21:30");
    await page.close();
  });
});
