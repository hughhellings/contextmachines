import { afterEach, describe, expect, it } from "vitest";
import { rememberBrowser, startVisit, VISIT_IDLE_MS } from "../src/visit.ts";

afterEach(() => {
  document.cookie = "__ctx_visit=; path=/; max-age=0";
  document.cookie = "__ctx_browser=; path=/; max-age=0";
});

describe("remembered browsers", () => {
  it("keep the same random id across visits, and hold nothing else", () => {
    const first = rememberBrowser(window);
    expect(first).toMatch(/^[a-f0-9-]{16,40}$/);
    expect(rememberBrowser(window)).toBe(first);
    expect(document.cookie).toContain(`__ctx_browser=${first}`);
  });
});

describe("visits", () => {
  it("continue across page loads, holding only a random id and a time", () => {
    let now = 1_000_000;
    const first = startVisit(window, () => now, true);
    now += 10 * 60_000;
    const next = startVisit(window, () => now, true); // a full page load later
    expect(next.id).toBe(first.id);
    expect(document.cookie).toMatch(new RegExp(`__ctx_visit=${first.id}\\.\\d+`));
  });

  it("stay alive while the person is active, and end after 30 idle minutes", () => {
    let now = 1_000_000;
    const visit = startVisit(window, () => now, true);
    now += VISIT_IDLE_MS - 60_000;
    visit.touch();
    now += VISIT_IDLE_MS - 60_000;
    expect(startVisit(window, () => now, true).id).toBe(visit.id);
    now += VISIT_IDLE_MS + 1;
    expect(startVisit(window, () => now, true).id).not.toBe(visit.id);
  });

  it("are one per page load, with no cookie, when the site turns the cookie off", () => {
    const a = startVisit(window, () => 1, false);
    const b = startVisit(window, () => 2, false);
    expect(a.id).not.toBe(b.id);
    expect(document.cookie).not.toMatch(/__ctx_visit=\w/);
  });

  it("ignore a cookie that isn't ours", () => {
    document.cookie = "__ctx_visit=<script>.123; path=/";
    expect(startVisit(window, () => 200, true).id).toMatch(/^[a-f0-9-]{16,40}$/);
  });
});
