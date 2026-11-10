import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScreenCheck } from "../src/checks.ts";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A client-rendered app behind a sign-in library, with a back end nobody may reach. It treats an
 * account made in the last day with nothing in it as a new person, as apps do, and has screens that
 * go wrong in each of the ways a made-up answer can make a screen go wrong, beside ones that go
 * wrong by themselves. What's in the rows can't be judged; what the app's own template does can.
 */
const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tally</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const app = (backend: string) => `
const BACKEND = ${JSON.stringify(backend)};
const root = document.getElementById("root");
const session = (() => { try { return JSON.parse(localStorage.getItem("sb-tally-auth-token")); } catch { return null; } })();
const page = location.pathname;
const rest = (table) => fetch(BACKEND + "/rest/v1/" + table, { headers: { apikey: "k", authorization: "Bearer " + session.access_token } }).then((r) => r.json());
const clip = "display:block;width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const nav = '<nav><a href="/trades" style="' + clip + '">Backtesting sessions</a><a href="/reports">Reports</a><a href="/stats">Stats</a><a href="/notes">Notes</a></nav>';
const draw = (html) => { root.innerHTML = nav + "<main>" + html + "</main>"; };
${COOKIES}
async function main() {
  if (page === "/") { root.innerHTML = '<h1>Tally</h1><p>Keep your numbers in one place, with nothing to install and nothing to learn at all.</p><a href="/login">Log in</a> <a href="/signup">Sign up</a>'; return; }
  if (!session) { root.innerHTML = page === "/signup" ? '<h1>Create your account</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="p"></label><button>Create account</button></form>' : '<h1>Welcome back</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="p"></label><button type="submit">Log in</button></form>'; return; }
  const trades = await rest("trades?select=*");
  const fresh = Date.now() - new Date(session.user.created_at).getTime() < 86400000;
  const goesToWelcome = fresh && trades.length === 0 && ["/login", "/signup", "/home"].includes(page);
  if (goesToWelcome) history.replaceState(null, "", "/welcome");
  const here = location.pathname;
  if (here === "/welcome") return draw('<h1>Let us get you set up</h1><p>First, tell us how you trade so the numbers mean something.</p><button>Continue</button>');
  if (here === "/login" || here === "/signup") return location.replace("/home");
  if (here === "/home") return draw("<h1>Home</h1><p>Your numbers at a glance, kept up to date as they come in from your platform.</p>");
  if (here === "/trades") return draw("<h1>Trades</h1>" + (trades.length ? "<ul>" + trades.map((t) => "<li>" + t.symbol + "</li>").join("") + "</ul><p>on " + trades.length + " closed trades</p>" : '<p>No trades yet.</p><a href="/import">Import trades</a>'));
  if (here === "/reports") return draw("<h1>Reports</h1><p>Nothing to show yet.</p>");
  if (here === "/stats") { const sum = trades.reduce((a, t) => a + (t.pnl ?? 0), 0); return draw("<h1>Stats</h1><p>Average: $" + (sum / trades.length) + "</p>"); }
  if (here === "/notes") return draw("<h1>Notes</h1><table><tr><td>" + String(trades[0]?.note) + "</td></tr><tr><td>" + (trades[0]?.tag ?? "") + "</td></tr></table>");
  if (here === "/summary") { const s = await fetch(BACKEND + "/api/summary", { headers: { accept: "application/json" } }).then((r) => r.json()); return draw("<h1>Summary</h1><p>Total: $" + s.total + "</p>"); }
  if (here === "/plans") { root.innerHTML = "<h1>Upgrade to continue</h1><p>Choose a plan.</p><button>See plans</button>"; return; }
  if (here === "/desk") {
    // A record's values, put together by the app: no one of them is on the control as it was sent.
    draw('<h1>Desk</h1><p>Everything you are working on, kept in one place for the day ahead of you.</p><textarea aria-label="Message box" style="position:fixed;left:40px;bottom:40px;width:300px;height:60px"></textarea>' + (trades[0] ? '<button style="position:fixed;left:400px;bottom:60px;width:200px;height:40px">Long, closed +$' + trades[0].pnl + '</button>' : ""));
    return cookies();
  }
  if (here === "/widebody") return draw('<h1>Wide</h1><div style="white-space:nowrap">' + (trades[0]?.memo ?? "") + "</div>");
  root.innerHTML = "<h1>Not here</h1><p>Nothing at this address, as far as the app is concerned, sorry.</p>";
}
main();
`;

const LONG = "A note written so long that it would push any page wider than a phone and then some more besides this";
// Two rows: the count of one is what the pass with one row is for, however many an AI invents.
const rows = { trades: [{ id: "t1", symbol: "ACME", pnl: 40, note: null, tag: "1 trades", memo: LONG }, { id: "t2", symbol: "BRAVO", pnl: 15, note: "held", tag: "none", memo: "short" }] };
const addresses = ["/trades", "/reports", "/stats", "/notes", "/summary", "/plans", "/widebody", "/desk", "/onboarding"];
const CALLS_MADE: string[] = [];
const COOKIES = `const cookies = () => { if (localStorage.getItem("choice")) return; const box = document.createElement("div"); box.style = "position:fixed;left:0;width:700px;bottom:16px;height:150px;background:#222;color:#fff"; box.innerHTML = '<p>We use cookies to understand visits.</p><button id="no">Reject non-essential cookies</button> <button id="yes">Accept all cookies</button>'; document.body.appendChild(box); box.querySelector("#no").onclick = () => { localStorage.setItem("choice", "no"); box.remove(); }; box.querySelector("#yes").onclick = () => { localStorage.setItem("choice", "yes"); box.remove(); }; };`;

/** What the app's server was asked for, by address: a try is opened, and never read. */
const SERVER_HEARD: string[] = [];
let site: http.Server;
let backend: http.Server;
let result: ScanResult;
const told: ScreenCheck[] = [];
const checks = (path: string) => result.checks.filter((c) => c.screens.includes(path));
const walked = (path: string) => result.newUser?.screens.find((s) => s.path === path);

beforeAll(async () => {
  backend = http.createServer((req, res) => {
    CALLS_MADE.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" }).end("[]");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const script = app(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
  site = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    SERVER_HEARD.push(path);
    if (path === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(script);
    res.writeHead(200, { "content-type": "text/html" }).end(SHELL);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  // The rows are only given once the new account's checks are in: the walk must not wait for them.
  let giveRows: () => void = () => {};
  const later = new Promise<{ addresses: string[]; rows: typeof rows }>((done) => (giveRows = () => done({ addresses, rows })));
  result = await scanSite({
    startUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, maxPages: 6, maxDurationMs: 15_000, delayMs: 0, exploreButtons: false, learnActions: false,
    onChecks: (checks) => {
      told.push(...checks);
      if (checks.some((check) => check.newUser)) giveRows();
    },
    standIn: { addresses: ["/trades", "/onboarding"], walkAddresses: [...addresses, "/jobs/nightly-digest"], rows: {}, later, provider: "supabase", firstRun: ["/onboarding"], maxPages: 12, maxDurationMs: 90_000 },
  });
}, 180_000);
afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

describe("an address that's only a try", () => {
  it("never reaches the server: the sealed browser gets the one document, and Node reads nothing", () => {
    expect(SERVER_HEARD).toContain("/app.js");
    expect(SERVER_HEARD).not.toContain("/jobs/nightly-digest");
  });
});

describe("told as the run goes", () => {
  const key = (check: ScreenCheck) => `${check.kind}|${check.target}|${check.at ?? ""}`;

  it("tells the new account's checks before the rows it doesn't need exist", () => {
    const first = told.findIndex((check) => check.newUser);
    const rowsNeeded = told.findIndex((check) => check.target === "on 1 closed trades");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(rowsNeeded).toBeGreaterThan(first);
  });

  it("tells nothing that isn't in the result at the end", () => {
    const kept = new Set(result.checks.map(key));
    expect(told.length).toBeGreaterThan(0);
    expect(told.filter((check) => !kept.has(key(check)))).toEqual([]);
    expect(told.filter((check) => !result.checks.find((had) => key(had) === key(check))?.screens.includes(check.screen))).toEqual([]);
  });

  it("has looked at what can't exist before the first screen is said", () => {
    expect(result.timings["new-user nowhere"]).toBeGreaterThan(0);
    expect(result.timings["new-user signed-out"] ?? 0).toBeLessThan(result.timings["new-user nowhere"]!);
  });

  it("tells nothing from a screen the pass didn't prove", () => {
    expect(told.filter((check) => check.screen === "/nowhere" || result.standIn?.notReached.some((n) => n.path === check.screen) && !check.newUser)).toEqual([]);
  });
});

describe("proven checks on stand-in screens", () => {
  it("report the app's own layout and templates, marked", () => {
    expect(result.standIn?.status).toBe("reached");
    const cut = result.checks.find((c) => c.kind === "cut_off" && c.target === "Backtesting sessions" && !c.newUser);
    expect(cut).toMatchObject({ seenWith: "stand-in" });
    expect(checks("/trades").map((c) => c.target)).toContain("on 1 closed trades");
    expect(result.checks.every((c) => c.seenWith === "stand-in")).toBe(true);
  });

  it("test a count of exactly one, however many rows were invented", () => {
    const count = result.checks.find((c) => c.target === "on 1 closed trades" && !c.newUser);
    expect(count).toMatchObject({ seenWith: "stand-in", wording: "count", oneRow: true });
    // The count of one is on this look's photo, and on no other.
    expect(result.oneRowPhotos?.map((shot) => shot.path)).toContain("/trades");
    // Nothing else comes out of that look: what it's for is that one word.
    expect(result.timings["one-row checks"]).toBeGreaterThan(0);
  });

  it("say which screens this run answered with nothing, and which it filled", () => {
    expect(walked("/reports")?.heldData).toBe("empty");
    expect(result.reviews.find((r) => r.path === "/trades")?.madeUpData).toBe(true);
  });

  it("never rest on a made-up row", () => {
    // "null" came from a sample row with that field empty, and "1 trades" is a row's own value.
    expect(checks("/notes").filter((c) => c.kind === "wording" && !c.newUser)).toEqual([]);
    // A long made-up value pushes the page wide: not the app's doing.
    expect(checks("/widebody").filter((c) => c.kind === "overflow")).toEqual([]);
  });

  it("never name a control for a made-up record, whatever the app did to its values", () => {
    const covered = checks("/desk").filter((c) => c.kind === "covered");
    expect(covered.map((c) => c.target)).toContain("Message box");
    expect(covered.filter((c) => c.target.includes("$"))).toEqual([]);
  });

  it("say nothing of a hole after an answer whose shape was a guess", () => {
    expect(result.pagesVisited).toContain("/summary");
    expect(checks("/summary").filter((c) => c.kind === "wording")).toEqual([]);
  });

  it("say what an empty list really does to a template", () => {
    // A new account's real answer is an empty list, and dividing by it is the app's own doing.
    const hole = result.checks.find((c) => c.kind === "wording" && c.target === "Average: $NaN");
    expect(hole).toMatchObject({ seenWith: "stand-in", newUser: true, wording: "missing_value" });
  });

  it("add no finding", () => {
    expect(result.findings).toEqual([]);
  });

  it("mark a line with a made-up value in what a reader gets, and a screen that drew rows", () => {
    const trades = result.reviews.find((r) => r.path === "/trades");
    expect(trades).toMatchObject({ seenWith: "stand-in", madeUpData: true });
    expect(trades?.text).toContain("(made-up row)");
    expect(trades?.text).not.toContain("ACME");
  });
});

describe("the new-account walk", () => {
  it("sees what a new person sees first, past the sign-in", () => {
    expect(result.newUser).toMatchObject({ status: "walked", first: "/welcome" });
    expect(walked("/welcome")).toMatchObject({ heading: "Let us get you set up", account: "new", seenWith: "stand-in" });
    expect(walked("/welcome")?.madeUpData).toBeUndefined();
  });

  it("records empty states, and whether each offers a next step", () => {
    expect(walked("/trades")?.empty).toEqual([{ text: "No trades yet.", next: "Import trades" }]);
    expect(walked("/reports")?.empty).toEqual([{ text: "Nothing to show yet." }]);
  });

  it("keeps a wall the app puts up for its own reasons, as the gate it is", () => {
    expect(walked("/plans")).toMatchObject({ gate: "paywall" });
    expect(walked("/plans")?.locked).toContainEqual({ label: "See plans", why: "asks" });
  });

  it("keeps public pages out of it", () => {
    expect(result.newUser?.screens.map((s) => s.path)).not.toContain("/");
    expect(result.newUser?.screens.map((s) => s.path)).not.toContain("/signup");
  });

  it("says when a first-run address the code named didn't open", () => {
    expect(result.newUser?.firstRun).toEqual([{ path: "/onboarding", opened: false, why: expect.any(String) }]);
  });

  it("carries photos, marked, apart from the screens", () => {
    expect(result.newUser?.photos.map((p) => p.path)).toContain("/welcome");
    expect(result.newUser?.photos.every((p) => p.seenWith === "stand-in" && p.jpeg.length > 0)).toBe(true);
    expect(result.screens.map((s) => s.path)).not.toContain("/welcome");
  });

  it("reaches nothing: the back end heard from neither pass", () => {
    expect(CALLS_MADE).toEqual([]);
  });

  it("stays within the stand-in's time", () => {
    expect(Object.entries(result.timings).filter(([step]) => step.startsWith("new-user")).reduce((sum, [, ms]) => sum + ms, 0)).toBeLessThan(90_000 * 0.3 + 5000);
  });
});

describe("a hole the made-up user's own blanks may have made", () => {
  const SIGNED_IN = `<!doctype html><html lang="en"><head><title>Greet</title></head><body><div id="root"></div><script>
    const session = JSON.parse(localStorage.getItem("sb-g-auth-token") ?? "null");
    const root = document.getElementById("root");
    if (location.pathname === "/" || !session) root.innerHTML = '<h1>Greet</h1><form><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Log in</button></form>';
    else root.innerHTML = '<nav><a href="/home">Home</a><a href="/list">List</a></nav><main><h1>' + location.pathname + '</h1><p>Hello, ' + session.user.user_metadata.first_name + '</p>' + (location.pathname === "/home" ? '<table><tr><td>Your first thing to look at today</td></tr><tr><td>Your second thing to look at today</td></tr></table>' : '<p>Everything on this other screen is about something else entirely, in words of its own, so it is a page by itself.</p>') + '</main>';
  </script></body></html>`;
  const run = async (sessionFieldsBlank: boolean) => {
    const server = http.createServer((_, res) => void res.writeHead(200, { "content-type": "text/html" }).end(SIGNED_IN));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const scanned = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 4, maxDurationMs: 8000, delayMs: 0, exploreButtons: false, learnActions: false, standIn: { addresses: ["/home", "/list"], rows: {}, provider: "supabase", sessionFieldsBlank, maxPages: 4, maxDurationMs: 20_000 } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return scanned.checks.filter((c) => c.kind === "wording");
  };

  it("is held back when the code reads those fields", async () => {
    expect(await run(true)).toEqual([]);
  }, 60_000);
  it("is the app's own when it doesn't", async () => {
    expect((await run(false)).map((c) => c.target)).toContain("Hello, undefined");
  }, 60_000);
});
