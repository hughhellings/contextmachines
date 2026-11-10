import { rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanSite, type ScanResult, type ScanStage } from "../src/scan.ts";
import { Seal } from "../src/stand-in.ts";
import { standInApp, type StandInApp } from "./stand-in-app.ts";

const quick = { maxPages: 6, maxDurationMs: 15_000, delayMs: 0 };
const pass = { maxPages: 8, maxDurationMs: 20_000 };
const addresses = ["/trades", "/notes", "/settings", "/admin"];

describe("the stand-in pass on a client-rendered app", () => {
  let app: StandInApp;
  let result: ScanResult;
  let plain: ScanResult;

  beforeAll(async () => {
    app = await standInApp();
    result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses } });
    plain = await scanSite({ startUrl: app.url, ...quick });
  }, 120_000);
  afterAll(() => app.close());

  it("reaches the signed-in screens with nobody signing in, and says how", () => {
    expect(result.standIn).toMatchObject({ status: "reached", provider: "supabase" });
    expect(result.standIn?.reached).toEqual(expect.arrayContaining(["/trades", "/notes", "/settings"]));
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/", "/pricing", "/login", "/trades", "/notes", "/settings"]));
    expect(result.loggedIn).toBe(false);
    expect(result.standIn?.message).toMatch(/made-up/);
    expect(result.standIn?.message).not.toMatch(/signed in/i);
  });

  it("marks what it reached, and only that", () => {
    expect(result.seenWith).toMatchObject({ "/trades": "stand-in", "/notes": "stand-in", "/settings": "stand-in" });
    expect(result.seenWith?.["/"]).toBeUndefined();
    expect(result.seenWith?.["/pricing"]).toBeUndefined();
    const trades = result.screens.find((shot) => shot.path === "/trades");
    expect(trades).toMatchObject({ seenWith: "stand-in", madeUpData: true });
    expect(trades?.jpeg.length).toBeGreaterThan(0);
    const front = result.screens.find((shot) => shot.path === "/");
    expect(front?.seenWith).toBeUndefined();
    expect(front?.madeUpData).toBeUndefined();
  });

  it("draws the real empty state when nothing was supplied", () => {
    const page = result.events.find((e) => e.kind === "page" && e.path === "/trades");
    expect(JSON.stringify(page)).toMatch(/Trades/);
    expect(result.standIn?.asked).toContain("GET /rest/v1/trades");
  });

  it("gives no findings, though a button there crashes and every answer is made up", () => {
    expect(result.findings).toEqual(plain.findings);
    expect(result.findings).toEqual([]);
  });

  it("presses nothing, so it sends no save and learns none", () => {
    expect(result.blockedWrites.filter((w) => w.seenWith === "stand-in")).toEqual([]);
    expect(app.backend).toEqual([]);
  });

  it("says a staff page turned it away, rather than counting it", () => {
    expect(result.standIn?.notReached).toContainEqual({ path: "/admin", why: "no_access" });
    expect(result.pagesVisited).not.toContain("/admin");
    expect(result.seenWith?.["/admin"]).toBeUndefined();
    expect(result.screens.some((shot) => shot.path.startsWith("/admin"))).toBe(false);
  });

  it("keeps the public crawl as it was", () => {
    for (const path of plain.pagesVisited) expect(result.pagesVisited).toContain(path);
    expect(plain.standIn).toBeUndefined();
    expect(plain.seenWith).toBeUndefined();
    expect(plain.pagesVisited).not.toContain("/trades");
  });
});

describe("asked once the public crawl is over", () => {
  let app: StandInApp;
  beforeAll(async () => {
    app = await standInApp();
  }, 60_000);
  afterAll(() => app.close());

  it("goes on behind the sign-in as soon as a wall is known, with the pressing still to come", async () => {
    const app = await standInApp({ frontLinks: ["/trades"] });
    const begun = Date.now();
    let asked = 0;
    let wallAt = 0;
    let newAccountAt = 0;
    let saw: string[] = [];
    const stages: ScanStage[] = [];
    const result = await scanSite({
      startUrl: app.url,
      ...quick,
      onStage: (stage) => void stages.push(stage),
      onChecks: (checks) => {
        if (checks.some((check) => check.newUser)) newAccountAt ||= Date.now();
      },
      standIn: (crawl, walls) => {
        asked++;
        wallAt = Date.now();
        saw = [...walls];
        expect(crawl.pagesVisited.length).toBeGreaterThan(0);
        return { ...pass, addresses };
      },
    });
    expect(asked).toBe(1);
    // Told for a screen to say where it's at: each stage once.
    // The public crawl may end before the new account's walk or after it; the new account, as it's reported, comes last.
    expect(stages.map((stage) => stage.kind).sort()).toEqual(["new-user", "public-over", "waiting"]);
    expect(stages.at(-1)).toEqual({ kind: "new-user", walk: result.newUser });
    expect(saw.length).toBeGreaterThan(0);
    expect(result.timings["public pass"]).toBeGreaterThan(wallAt - begun);
    expect(result.standIn?.status).toBe("reached");
    expect(result.newUser?.status).toBe("walked");
    // Each screen it kept, timed by the walk's own clock, and nothing it didn't keep.
    expect(Object.keys(result.newUser!.took ?? {}).sort()).toEqual(result.newUser!.screens.map((screen) => screen.path).sort());
    for (const ms of Object.values(result.newUser!.took ?? {})) expect(ms).toBeGreaterThan(0);
    if (newAccountAt) expect(newAccountAt).toBeGreaterThanOrEqual(wallAt);
    await app.close();
  }, 90_000);

  it("goes on with its rows beside the pressing, not after it", async () => {
    // A public page whose buttons each go on drawing for a while: pressing them through takes longer than the new account's walk.
    const buttons = Array.from({ length: 12 }, (_, i) => `<button onclick="let n = 0; const t = setInterval(() => { this.insertAdjacentHTML('afterend', '<p>Step ${i} line ' + n + '</p>'); if (++n > 8) clearInterval(t); }, 300)">Show step ${i}</button>`).join("");
    const slow = await standInApp({ frontLinks: ["/notes", "/tour"], openPages: { "/tour": `<h1>Tour</h1><main>${buttons}</main>` } });
    let publicOver = 0;
    let rowsBegan = 0;
    const result = await scanSite({
      startUrl: slow.url,
      ...quick,
      maxDurationMs: 90_000,
      onStage: (stage) => void (stage.kind === "public-over" && (publicOver ||= Date.now())),
      onScreen: (_path, _n, _named, asStandIn) => void (asStandIn && (rowsBegan ||= Date.now())),
      standIn: () => ({ ...pass, addresses }),
    });
    expect(result.standIn?.status).toBe("reached");
    expect(rowsBegan).toBeGreaterThan(0);
    expect(rowsBegan).toBeLessThan(publicOver);
    // What the pressing saw is still the public crawl's, and only the pass with rows reached what's behind the sign-in.
    expect(result.seenWith?.["/tour"]).toBeUndefined();
    expect(result.standIn?.reached).toEqual(expect.arrayContaining(["/notes", "/settings"]));
    expect(result.standIn?.reached).not.toContain("/tour");
    await slow.close();
  }, 180_000);

  it("presses nothing as the stand-in, and ends once every screen is looked at", async () => {
    const began = Date.now();
    const result = await scanSite({ startUrl: app.url, ...quick, maxDurationMs: 8000, standIn: () => ({ maxPages: 8, maxDurationMs: 60_000, addresses }) });
    expect(result.standIn?.status).toBe("reached");
    expect(result.standIn?.stoppedBy).toBe("complete");
    expect(Date.now() - began).toBeLessThan(55_000);
    expect(result.blockedWrites.filter((write) => write.seenWith === "stand-in")).toEqual([]);
  }, 90_000);

  it("gets what that crawl saw, and can name the addresses then", async () => {
    let seen: string[] = [];
    const result = await scanSite({
      startUrl: app.url,
      ...quick,
      standIn: (crawl) => {
        seen = [...crawl.pagesVisited];
        return { ...pass, addresses };
      },
    });
    expect(seen).toEqual(expect.arrayContaining(["/", "/pricing", "/login"]));
    expect(seen).not.toContain("/trades");
    expect(result.standIn?.status).toBe("reached");
  }, 90_000);

  it("marks an address the app moved on from, as nobody but the made-up user saw it", async () => {
    const result = await scanSite({ startUrl: app.url, ...quick, exploreButtons: false, standIn: { ...pass, addresses: ["/moved", "/trades"] } });
    const paged = result.events.flatMap((e) => (e.kind === "route" || e.kind === "page" ? [e.path] : []));
    const unmarked = paged.filter((path) => !["/", "/pricing", "/login"].includes(path) && !result.seenWith?.[path]);
    expect(unmarked).toEqual([]);
  }, 60_000);

  it("runs no pass when it answers with nothing", async () => {
    const result = await scanSite({ startUrl: app.url, ...quick, standIn: () => undefined });
    expect(result.standIn).toBeUndefined();
    expect(result.seenWith).toBeUndefined();
    expect(result.pagesVisited).not.toContain("/trades");
  }, 60_000);
});

describe("a protected address the public crawl was led to", () => {
  it("is learned as the screen it is, not as the sign-in form drawn there", async () => {
    const app = await standInApp({ frontLinks: ["/trades"] });
    try {
      const plain = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false });
      expect(plain.pagesVisited).toContain("/trades"); // the form, at that address
      const result = await scanSite({ startUrl: app.url, ...quick, learnActions: false, standIn: pass });
      expect(result.standIn?.status).toBe("reached");
      expect(result.standIn?.reached).toContain("/trades");
      expect(result.seenWith?.["/trades"]).toBe("stand-in");
      expect(result.pagesVisited.filter((path) => path === "/trades")).toHaveLength(1);
      expect(result.screens.filter((shot) => shot.path === "/trades")).toEqual([expect.objectContaining({ madeUpData: true })]);
      const said = JSON.stringify(result.events.filter((e) => (e.kind === "page" || e.kind === "route") && e.path === "/trades"));
      expect(said).not.toContain("Welcome back");
      expect(said).toContain("Trades");
      // A sign-in page at its own address is a public screen, and stays one.
      expect(result.pagesVisited).toContain("/login");
      expect(result.seenWith?.["/login"]).toBeUndefined();
      expect(result.standIn?.notReached.some((n) => n.path === "/login")).toBe(false);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("sample rows", () => {
  it("draw on the screens that asked for them, by table and by record", async () => {
    const app = await standInApp();
    try {
      const result = await scanSite({
        startUrl: app.url, ...quick, screenshots: false,
        standIn: { ...pass, addresses: ["/trades", "/trade/7"], rows: { trades: [{ id: "7", symbol: "SKU-RED", user_id: "someone-else" }, { id: "8", symbol: "GBPJPY" }] } },
      });
      expect(result.standIn?.status).toBe("reached");
      const said = JSON.stringify(result.events.filter((e) => e.kind === "page"));
      expect(said).toContain("SKU-RED");
      expect(said).not.toContain("Trade not found");
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("told which library it is", () => {
  it("tries the addresses even where the first screens show no sign of it", async () => {
    const app = await standInApp();
    try {
      const told = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades"], provider: "Supabase" } });
      expect(told.standIn).toMatchObject({ status: "reached", provider: "supabase" });
    } finally {
      await app.close();
    }
  }, 60_000);

  it("doesn't say it reached anything because it was told", async () => {
    const app = await standInApp({ key: "acme.auth.v1" });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades"], provider: "supabase" } });
      expect(result.standIn?.status).toBe("not_rendered");
      expect(result.standIn?.message).toMatch(/storageKey/);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("an address that only sends the crawl to the sign-in", () => {
  const moves = `<!doctype html><title>Pipeline</title><body><div id="root"></div><script>
    const session = localStorage.getItem("sb-x-auth-token");
    const root = document.getElementById("root");
    if (location.pathname === "/") root.innerHTML = '<h1>Pipeline</h1><p>What this product is for, in words a visitor can read before signing in.</p><a href="/deals">Deals</a> <a href="/login">Log in</a>';
    else if (location.pathname === "/login") root.innerHTML = '<h1>Welcome back</h1><form><input type="email"><input type="password"><button>Log in</button></form>';
    else if (!session) { history.replaceState(null, "", "/login"); root.innerHTML = '<h1>Welcome back</h1><form><input type="email"><input type="password"><button>Log in</button></form>'; }
    else if (location.pathname === "/deals") root.innerHTML = '<h1>Your deals</h1><p>Every deal you have open right now, with who is working on each of them.</p><ul><li>Open</li><li>Won</li></ul><a href="/reports">Reports</a>';
    else if (location.pathname === "/reports") root.innerHTML = '<h1>Reports</h1><p>How the quarter went so far, added up from what was closed and when.</p>';
    else root.innerHTML = '<h1>Page not found</h1>';
  </script></body>`;
  it("is the first place the stand-in looks, with no list from anyone", async () => {
    const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(moves));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      let told: readonly string[] = [];
      const result = await scanSite({ startUrl: url, ...quick, screenshots: false, learnActions: false, standIn: (_crawl, walls) => {
        told = walls;
        return { ...pass, provider: "supabase", addresses: [...walls] };
      } });
      expect(told).toContain("/deals");
      expect(result.standIn?.status).toBe("reached");
      expect(result.standIn?.reached).toContain("/deals");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);
});

describe("when no one can stand in", () => {
  it("finds a session under a key the app chose only when told it", async () => {
    const app = await standInApp({ key: "acme.auth.v1" });
    try {
      const missed = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades"] } });
      expect(missed.standIn?.status).toBe("no_adapter");
      expect(missed.pagesVisited).not.toContain("/trades");
      const told = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades"], provider: "supabase", storageKey: "acme.auth.v1" } });
      expect(told.standIn?.status).toBe("reached");
      expect(told.pagesVisited).toContain("/trades");
    } finally {
      await app.close();
    }
  }, 90_000);

  it("says so when a library was seen but its screens stayed shut", async () => {
    // The back end's address shows the library at work, but the session is under a key nobody named.
    const shell = `<!doctype html><title>Acme</title><body><div id="root"></div><script>
      fetch("/rest/v1/plans").catch(() => {});
      const s = localStorage.getItem("acme.auth.v1");
      document.getElementById("root").innerHTML = '<h1>Sign in</h1><form><input type="email"><input type="password"><button>Sign in</button></form>';
    </script></body>`;
    const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(shell));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const result = await scanSite({ startUrl: url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades"] } });
      expect(result.standIn).toMatchObject({ status: "not_rendered", provider: "supabase" });
      expect(result.standIn?.message).toMatch(/storageKey/);
      expect(result.standIn?.notReached).toContainEqual({ path: "/trades", why: "sign_in" });
      expect(result.seenWith).toBeUndefined();
      expect(result.pagesVisited).not.toContain("/trades");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);

  it("claims nothing for a page that drew with the session never read", async () => {
    // Looks like the library at work, and draws an address, but it never asked who's signed in.
    const shell = `<!doctype html><title>Acme</title><body><div id="root"></div><script>
      fetch("/rest/v1/plans").catch(() => {});
      document.getElementById("root").innerHTML = "<h1>" + location.pathname + "</h1><p>A page for anyone at all, with enough words on it to count.</p>";
    </script></body>`;
    const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(shell));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const result = await scanSite({ startUrl: url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/other"] } });
      expect(result.standIn).toMatchObject({ status: "not_rendered", provider: "supabase", reached: [] });
      expect(result.pagesVisited).not.toContain("/other");
      expect(result.seenWith).toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);

  it("takes a library it doesn't know for what it is", async () => {
    const app = await standInApp();
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { provider: "acme-auth" } });
      expect(result.standIn?.status).toBe("no_adapter");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("reports addresses the seal won't load, and never tries them", async () => {
    const app = await standInApp();
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/trades", "/api/export", "/trade/:id", "https://example.com/x"] } });
      expect(result.standIn?.notReached).toEqual(expect.arrayContaining([{ path: "/api/export", why: "not_a_page" }, { path: "/trade/:id", why: "not_a_page" }, { path: "https://example.com/x", why: "not_a_page" }]));
      expect(app.local.some((h) => h.path === "/api/export")).toBe(false);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("server-rendered sign-in", () => {
  const run = async (document: (path: string) => { status: number; headers?: Record<string, string>; body?: string } | undefined, list = ["/trades"], navLinks: string[] = []) => {
    const app = await standInApp({ document, navLinks });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: list } });
      return { result, app };
    } finally {
      await app.close();
    }
  };

  it("stops at a server that redirects to its sign-in page", async () => {
    const { result } = await run((path) => (path === "/trades" ? { status: 302, headers: { location: "/login" } } : undefined));
    expect(result.standIn?.status).toBe("server_auth");
    expect(result.standIn?.message).toContain("/trades");
    expect(result.seenWith).toBeUndefined();
  }, 60_000);

  it("stops at a server that refuses the address", async () => {
    const { result } = await run((path) => (path === "/trades" ? { status: 401, body: "Who are you?" } : undefined));
    expect(result.standIn?.status).toBe("server_auth");
  }, 60_000);

  it("stops at a document the server drew for itself", async () => {
    const { result } = await run((path) => (path === "/trades" ? { status: 200, body: `<!doctype html><title>Trades</title><body><h1>Sign in to see your trades</h1><p>This page came from the server, not from a script in the browser.</p></body>` } : undefined));
    expect(result.standIn?.status).toBe("server_auth");
  }, 60_000);

  it("stops when it only finds out on the way, from a page it wasn't told about", async () => {
    const shell = `<!doctype html><title>App</title><body><div id="root"></div><script>
      localStorage.getItem("sb-x-auth-token");
      document.getElementById("root").innerHTML = '<h1>Home</h1><p>A front page long enough to count as one, and with a link on it.</p><a href="/members">Members</a>';
    </script></body>`;
    const { result } = await run((path) => (path === "/" ? { status: 200, body: shell } : path === "/members" ? { status: 302, headers: { location: "/login" } } : undefined), []);
    expect(result.standIn?.status).toBe("server_auth");
    expect(result.standIn?.message).toContain("/members");
  }, 60_000);

  it("doesn't follow a page moved to an address that runs code", async () => {
    const { result, app } = await run((path) => (path === "/trades" ? { status: 302, headers: { location: "/api/session/refresh" } } : undefined));
    expect(result.standIn?.status).toBe("server_auth");
    expect(app.local.some((h) => h.path.startsWith("/api/"))).toBe(false);
  }, 60_000);

  it("never asks about a link met on a made-up screen, and the app's own draw says it's no screen", async () => {
    const news = `<!doctype html><title>News</title><body><h1>Old news</h1><p>This page came from the server, not from a script in the browser.</p></body>`;
    const { result, app } = await run((path) => (path === "/old-news" ? { status: 200, body: news } : undefined), ["/trades"], ["/old-news"]);
    expect(result.standIn?.status).toBe("reached");
    expect(result.standIn?.notReached).toContainEqual({ path: "/old-news", why: "unclear" });
    expect(app.local.some((h) => h.path === "/old-news")).toBe(false);
    expect(result.pagesVisited).not.toContain("/old-news");
    expect(result.pagesVisited).toContain("/trades");
  }, 60_000);

  it("leaves out one page the server drew, past the first it reads, and keeps the rest", async () => {
    const news = `<!doctype html><title>News</title><body><h1>Old news</h1><p>This page came from the server, not from a script in the browser.</p></body>`;
    const list = [...Array.from({ length: 12 }, (_, n) => `/page${n}`), "/old-news"];
    const app = await standInApp({ document: (path) => (path === "/old-news" ? { status: 200, body: news } : undefined) });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { maxPages: 20, maxDurationMs: 60_000, addresses: list } });
      expect(result.standIn?.notReached).toContainEqual({ path: "/old-news", why: "server_page" });
      expect(result.pagesVisited).not.toContain("/old-news");
    } finally {
      await app.close();
    }
  }, 90_000);

  it("names a page it turned away, not a public one it drew", async () => {
    const forgot = `<!doctype html><title>Forgot</title><body><h1>Forgot your password</h1><p>Drawn by the server, for anyone at all to use.</p></body>`;
    const app = await standInApp({ frontLinks: ["/forgot"], document: (path) => (path === "/forgot" ? { status: 200, body: forgot } : path === "/tickets" ? { status: 302, headers: { location: "/login" } } : undefined) });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/forgot", "/tickets"] } });
      expect(result.pagesVisited).toContain("/forgot");
      expect(result.standIn?.status).toBe("server_auth");
      expect(result.standIn?.message).toContain("/tickets");
      expect(result.standIn?.message).not.toContain("/forgot");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("names no page when the only ones it drew are public", async () => {
    const forgot = `<!doctype html><title>Forgot</title><body><h1>Forgot your password</h1><p>Drawn by the server, for anyone at all to use.</p></body>`;
    const app = await standInApp({ frontLinks: ["/forgot"], document: (path) => (path === "/forgot" ? { status: 200, body: forgot } : undefined) });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, screenshots: false, learnActions: false, standIn: { ...pass, addresses: ["/forgot"] } });
      expect(result.standIn?.status).toBe("server_auth");
      expect(result.standIn?.message).not.toMatch(/\/\w/);
      expect(result.standIn?.message).toMatch(/draws this app's pages itself/);
    } finally {
      await app.close();
    }
  }, 60_000);

  it.each([
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=/login">'],
    ["an inline guard", '<script>if (!document.cookie.includes("sid")) location.replace("/login");</script>'],
  ])("stops at %s in a document that otherwise looks the same", async (_name, head) => {
    const shell = `<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="/app.css">${head}</head><body><div id="root"></div><noscript>Turn on JavaScript</noscript><script src="/app.js"></script></body></html>`;
    const { result } = await run((path) => (path === "/trades" ? { status: 200, body: shell } : undefined));
    expect(result.standIn?.status).toBe("server_auth");
    expect(result.seenWith).toBeUndefined();
  }, 60_000);

  it("isn't stopped by a nonce that's new with every answer", async () => {
    let n = 0;
    const shell = () => `<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="/app.css"><script nonce="n${++n}x">window.__A = 1;</script></head><body><div id="root"></div><noscript>Turn on JavaScript</noscript><script src="/app.js"></script></body></html>`;
    const { result } = await run((path) => (path.endsWith(".js") || path.endsWith(".css") ? undefined : { status: 200, body: shell() }));
    expect(result.standIn?.status).toBe("reached");
  }, 60_000);

  it("isn't fooled by a splash, a slash or a move to another page of the app", async () => {
    const { result } = await run((path) => (path === "/trades" ? { status: 301, headers: { location: "/trades/" } } : undefined));
    expect(result.standIn?.status).not.toBe("server_auth");
  }, 60_000);
});

describe("refused outright", () => {
  const session = join(tmpdir(), `stand-in-test-session-${process.pid}.json`);
  beforeAll(() => writeFileSync(session, JSON.stringify({ cookies: [], origins: [] })));
  afterAll(() => rmSync(session, { force: true }));

  it.each([
    ["--login", () => ({ login: { url: "/login", fields: [], submit: "button" } }), /--login/],
    ["--session", () => ({ storageState: session }), /--session/],
    ["--create", () => ({ realWrites: true }), /--create/],
  ])("with %s, no stand-in run happens", async (_flag, extra, says) => {
    const checked = vi.spyOn(Seal.prototype, "check");
    const app = await standInApp();
    try {
      const login = "login" in extra() ? { login: { url: app.url, fields: [], submit: "body" } } : {};
      const result = await scanSite({ startUrl: app.url, maxPages: 1, maxDurationMs: 5000, navigationTimeoutMs: 3000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false, standIn: {}, ...extra(), ...login });
      expect(result.standIn?.status).toBe("refused");
      expect(result.standIn?.message).toMatch(says);
      expect(checked).not.toHaveBeenCalled();
      expect(result.seenWith).toBeUndefined();
    } finally {
      checked.mockRestore();
      await app.close();
    }
  }, 30_000);

  it("anywhere but a local address", async () => {
    const checked = vi.spyOn(Seal.prototype, "check");
    const result = await scanSite({ startUrl: "http://site.invalid/", maxPages: 1, maxDurationMs: 5000, navigationTimeoutMs: 3000, delayMs: 0, screenshots: false, standIn: {} });
    expect(result.standIn?.status).toBe("refused");
    expect(result.standIn?.message).toMatch(/local address/);
    expect(checked).not.toHaveBeenCalled();
    checked.mockRestore();
  }, 30_000);
});

describe("a seal that doesn't hold", () => {
  afterEach(() => vi.restoreAllMocks());

  it("means the stand-in never opens the app", async () => {
    const app = await standInApp();
    try {
      vi.spyOn(Seal.prototype, "check").mockRejectedValue(new Error("the seal didn't answer a call"));
      const result = await scanSite({ startUrl: app.url, maxPages: 1, maxDurationMs: 5000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false, standIn: { addresses: ["/trades"] } });
      expect(result.standIn?.status).toBe("seal_failed");
      expect(result.standIn?.message).toContain("the seal didn't answer a call");
      expect(app.local.some((h) => h.path === "/trades" && h.method === "GET")).toBe(true); // the check on what the server decides, and no more
      expect(app.local.filter((h) => h.path === "/app.js").length).toBe(1); // the public crawl's page only
      expect(result.seenWith).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 30_000);
});
