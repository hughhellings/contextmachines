import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { startFixtureSite, TEST_USER, type FixtureSite } from "./fixture-site.ts";

let site: FixtureSite;
let result: ScanResult;
/** What the crawl told as it went: each screen as it was first looked at, and each one it went back to, to press. */
const told: string[] = [];
const env = { SCAN_EMAIL: TEST_USER.email, SCAN_PASSWORD: TEST_USER.password };

beforeAll(async () => {
  site = await startFixtureSite();
  result = await scanSite(
    {
      startUrl: `${site.url}/`,
      delayMs: 0,
      onScreen: (path) => told.push(`look ${path}`),
      onPressing: (path) => told.push(`press ${path}`),
      login: { url: `${site.url}/login`, fields: [{ selector: "#email", env: "SCAN_EMAIL" }, { selector: "#password", env: "SCAN_PASSWORD" }], submit: "#submit" },
    },
    env,
  );
}, 60_000);

afterAll(async () => {
  await site?.close();
});

const networkPaths = () => result.events.flatMap((e) => (e.kind === "network" ? [`${e.method} ${e.path}${e.graphqlOperation ? ` #${e.graphqlOperation}` : ""}`] : []));

describe("scanSite against a live local site", () => {
  it("logs in and crawls protected pages, one per URL pattern", () => {
    expect(result.errors).toEqual([]);
    expect(result.loggedIn).toBe(true);
    expect(result.stoppedBy).toBe("complete");
    // "/saved" is where the settings form leads: a GET form, but one carrying what the learner typed, so it's a save.
    expect(result.pagesVisited.sort()).toEqual(["/", "/assessments", "/assessments/:id", "/board", "/reports", "/settings"]);
  });

  it("says which screen it's pressing on, only one it has already looked at", () => {
    const pressed = told.filter((t) => t.startsWith("press ")).map((t) => t.slice(6));
    expect(pressed.length).toBeGreaterThan(0);
    for (const path of pressed) expect(told.indexOf(`look ${path}`)).toBeGreaterThanOrEqual(0);
    for (const path of pressed) expect(told.indexOf(`look ${path}`)).toBeLessThan(told.indexOf(`press ${path}`));
  });

  it("finds screens reached only by a button, and never presses one that acts", () => {
    expect(result.foundByButtons).toEqual(["/reports"]);
    const paths = site.received.map((r) => r.path);
    expect(paths).not.toContain("/logout"); // "Log out" is never pressed
    // Writes never reach the site (checked below), a GET form that carries what was typed included.
    expect(paths).not.toContain("/saved");
  });

  it("reads each page's structure with the real snippet: labels and required fields, never values", () => {
    const pages = result.events.flatMap((e) => (e.kind === "page" ? [e] : []));
    const reports = pages.find((p) => p.path === "/reports");
    expect(reports?.snapshot.title).toBe("Reports");
    expect(reports?.snapshot.forms[0]?.fields).toEqual([expect.objectContaining({ name: "from", label: "From", type: "date", required: true })]);
    const settings = pages.find((p) => p.path === "/settings");
    expect(settings?.snapshot.forms[0]?.fields.map((f) => f.name)).toEqual(["display_name"]);
  });

  it("photographs each screen it visits, named as the snippet names it, with where its buttons sit", () => {
    expect(result.screens.length).toBeGreaterThan(1);
    for (const shot of result.screens) {
      expect(shot.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(shot).toMatchObject({ width: 1280, height: 800 });
    }
    expect(new Set(result.screens.map((s) => s.path)).size).toBe(result.screens.length); // one per screen
    expect(result.screens.flatMap((s) => s.boxes).some((b) => b.kind === "button" && b.w > 0 && b.h > 0)).toBe(true);
    // Fields are named by label or name, never by what's typed in them.
    const fields = result.screens.flatMap((s) => s.boxes.filter((b) => b.kind === "field"));
    expect(fields.every((f) => !/secret|hunter2|@example/.test(f.label))).toBe(true);
  });

  it("presses what a menu reveals, and buttons that delete or export, without anything reaching the site", () => {
    // Learned, from the requests the app tried to send (answered by the learner itself).
    expect(networkPaths()).toEqual(expect.arrayContaining(["POST /api/exports", "DELETE /api/assessments/:id"]));
    // Never sent: not the export, not the delete, and not a read whose address destroys something.
    const sent = site.received.map((r) => `${r.method} ${r.path}`);
    expect(sent).not.toContain("POST /api/exports");
    expect(sent.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(sent).not.toContain("GET /api/assessments/remove-all");
  });

  it("drags a card into another list on a board, learning the move without it reaching the site", () => {
    expect(networkPaths()).toContain("PATCH /api/cards/:id");
    expect(site.received.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("captures the site's API reads and GraphQL queries, normalised", () => {
    expect(networkPaths()).toEqual(expect.arrayContaining(["GET /api/me", "GET /api/assessments", "GET /api/assessments/:id", "GET /api/settings", "QUERY /graphql #AssessmentDetails"]));
  });

  it("never lets a write reach the site, and reports what it blocked", () => {
    // Sent by the page with no press behind them: stopped all the same, and kept apart from the saves.
    expect(result.ambientWrites).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST", path: "/api/telemetry", why: "unprompted" }), expect.objectContaining({ method: "POST", path: "/graphql", graphqlOperation: "MarkViewed", why: "unprompted" })]));
    expect(result.blockedWrites).toContainEqual({ method: "DELETE", path: "/api/assessments/:id" });
    const writes = site.received.filter((r) => r.method !== "GET" && r.path !== "/api/session" && !(r.path === "/graphql" && r.body.includes("query AssessmentDetails")));
    expect(writes).toEqual([]);
  });

  it("never follows logout, delete, file or external links", () => {
    const paths = site.received.map((r) => r.path);
    expect(paths).not.toContain("/logout");
    expect(paths).not.toContain("/assessments/101/delete");
    expect(paths).not.toContain("/files/report.pdf");
  });

  it("keeps credentials and ids out of captured events", () => {
    const json = JSON.stringify(result.events);
    expect(json).not.toContain(TEST_USER.password);
    expect(json).not.toContain(TEST_USER.email);
    // Ids never reach an address: every path and field is masked.
    const addresses = JSON.stringify(result.events.map((e) => ("path" in e ? e.path : "") + ("fields" in e ? JSON.stringify(e.fields) : "")));
    expect(addresses).not.toMatch(/10[12]/);
    expect(networkPaths()).not.toContain("POST /api/session");
    // Signed in, someone's records are on screen: a heading's numbers are masked, as the live snippet masks them.
    const headings = result.events.flatMap((e) => (e.kind === "page" ? e.snapshot.headings : []));
    expect(headings.some((h) => h.startsWith("Assessment"))).toBe(true);
    expect(headings.join(" ")).not.toMatch(/10[12]/);
  });

  it("keeps a heading's numbers as written only when signed out, and never when asked not to", async () => {
    const opts = { startUrl: `${site.url}/numbered`, delayMs: 0, maxPages: 1, screenshots: false, exploreButtons: false, learnActions: false };
    const headingsOf = (r: ScanResult) => r.events.flatMap((e) => (e.kind === "page" ? e.snapshot.headings : []));
    expect(headingsOf(await scanSite(opts))).toContain("Plan 42 costs $90");
    expect(headingsOf(await scanSite({ ...opts, keepNumbers: false })).join(" ")).not.toMatch(/42|90/);
    // A saved session is a sign-in: masked, even when numbers were asked for.
    const session = join(mkdtempSync(join(tmpdir(), "scan-")), "session.json");
    writeFileSync(session, JSON.stringify({ cookies: [], origins: [] }));
    expect(headingsOf(await scanSite({ ...opts, storageState: session, keepNumbers: true })).join(" ")).not.toMatch(/42|90/);
  }, 60_000);

  it("reports a missing login secret instead of guessing", async () => {
    const r = await scanSite({ startUrl: `${site.url}/`, delayMs: 0, maxPages: 1, login: { url: `${site.url}/login`, fields: [{ selector: "#email", env: "MISSING_VAR" }], submit: "#submit" } }, {});
    expect(r.errors[0]).toMatch(/set MISSING_VAR/);
  }, 30_000);

  it("respects the page limit", async () => {
    const r = await scanSite({ startUrl: `${site.url}/`, delayMs: 0, maxPages: 2, login: { url: `${site.url}/login`, fields: [{ selector: "#email", env: "SCAN_EMAIL" }, { selector: "#password", env: "SCAN_PASSWORD" }], submit: "#submit" } }, env);
    expect(r.stoppedBy).toBe("max_pages");
    expect(r.pagesVisited).toHaveLength(2);
  }, 30_000);
});
