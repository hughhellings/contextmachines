import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backgroundHost, scanSite, type ScanResult } from "../src/scan.ts";
import { Seal } from "../src/stand-in.ts";
import { standInApp, type StandInApp } from "./stand-in-app.ts";

/**
 * The promise the whole stand-in rests on: past the session check, a page that tries every way out
 * it has gets nowhere. Only asset GETs reach the app's own server, and the back end on another port
 * hears nothing at all. The same page opened with a session of its own, with no seal, shows that the
 * recording servers would have caught each of these.
 */
const FILES = /^\/(?:|app\.js|app\.css|pricing|login|trades|notes|settings|admin|leaks|worker\.js|nested\.js|hop\.js|hop-worker\.js)$/;

describe("the seal, on a page that tries every way out", () => {
  let app: StandInApp;
  let result: ScanResult;

  beforeAll(async () => {
    app = await standInApp({ leaks: true });
    result = await scanSite({
      startUrl: app.url, maxPages: 5, maxDurationMs: 20_000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false,
      standIn: { addresses: ["/leaks", "/notes"], maxPages: 3, maxDurationMs: 25_000 },
    });
  }, 90_000);
  afterAll(() => app.close());

  it("really ran the page, as the stand-in", () => {
    expect(result.standIn?.status).toBe("reached");
    expect(result.seenWith?.["/leaks"]).toBe("stand-in");
    expect(result.standIn?.asked).toEqual(expect.arrayContaining(["GET /api/secret", "POST /api/save", "GET /fetch-read", "POST /fetch-write"]));
  });

  it("lets nothing reach another port: no request, no socket, no worker's, no preflight", () => {
    expect(app.backend).toEqual([]);
  });

  it("lets only GETs of files reach the app's own server", () => {
    expect(app.local.filter((h) => h.method !== "GET" && h.method !== "HEAD")).toEqual([]);
    expect(app.local.filter((h) => !FILES.test(h.path))).toEqual([]);
    expect(app.local.filter((h) => h.path.startsWith("/api/"))).toEqual([]);
  });

  it("sends nothing through a dev proxy, however like a file it looks", () => {
    expect(app.local.filter((h) => h.path.startsWith("/backend/"))).toEqual([]);
  });

  it("carries no cookie the page set to the dev server: a server's own code can't pass it on", () => {
    expect(app.local.filter((h) => h.cookie?.includes("sb-access-token"))).toEqual([]);
  });
});

describe("the same page with no seal", () => {
  let app: StandInApp;

  beforeAll(async () => {
    app = await standInApp({ leaks: true, open: true });
    await scanSite({ startUrl: `${app.url}leaks`, maxPages: 1, maxDurationMs: 10_000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false });
  }, 60_000);
  afterAll(() => app.close());

  it("is heard by the recording servers: they'd have caught a leak", () => {
    expect(app.backend.map((h) => h.path)).toEqual(expect.arrayContaining(["/fetch-read", "/pixel.png", "/blob-worker", "/socket", "/data-worker", "/frame-fetch", "/frame-socket", "/srcdoc-fetch", "/srcdoc-socket"]));
    expect(app.local.map((h) => h.path)).toEqual(expect.arrayContaining(["/api/secret", "/hmr", "/frame-hmr", "/api/paintworklet.js", "/api/audioworklet.js"]));
    expect(app.backend.map((h) => h.path)).toEqual(expect.arrayContaining(["/backend/pixel.png", "/backend/report.js", "/backend/theme.css", "/backend/report"]));
  });

  it("sends a cookie the page set, which is how a session reaches a server's code", () => {
    expect(app.local.some((h) => h.path === "/backend/pixel.png" && h.cookie?.includes("sb-access-token"))).toBe(true);
  });
});

describe("the floor under the seal, with no route of ours at all", () => {
  const listen = async (heard: string[]) => {
    const server = http.createServer((req, res) => {
      heard.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }).end("<!doctype html><title>x</title>");
    });
    server.on("upgrade", (req, socket) => {
      heard.push(req.url ?? "");
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  };

  it.each(["127.0.0.1", "localhost"])("on %s, nothing can be reached, the dev server included", async (host) => {
    const own: string[] = [];
    const other: string[] = [];
    const dev = await listen(own);
    const elsewhere = await listen(other);
    const start = new URL(`http://${host}:${(dev.address() as AddressInfo).port}/`);
    const seal = new Seal({ start, config: {}, publicScreens: [], background: backgroundHost, graphqlRead: () => false });
    const browser = await chromium.launch({ args: seal.browserArgs });
    try {
      const page = await browser.newPage();
      await page.route(`${start.origin}/`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>" }), { times: 1 });
      await page.goto(start.href);
      await page.unrouteAll();
      const port = (elsewhere.address() as AddressInfo).port;
      const said = await page.evaluate(async (port) => {
        const tried = (href: string) => fetch(href, { mode: "no-cors" }).then(() => "reached", () => "failed");
        const socket = await new Promise((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
          ws.onopen = () => resolve("reached");
          ws.onerror = () => resolve("failed");
        });
        return { self: await tried("/self"), byAddress: await tried(`http://127.0.0.1:${port}/a`), byName: await tried(`http://localhost:${port}/b`), outside: await tried("https://example.com/"), socket };
      }, port);
      expect(said).toEqual({ self: "failed", byAddress: "failed", byName: "failed", outside: "failed", socket: "failed" });
      expect(other).toEqual([]);
      expect(own).toEqual([]);
    } finally {
      await browser.close();
      dev.closeAllConnections();
      elsewhere.closeAllConnections();
      await Promise.all([new Promise((resolve) => dev.close(resolve)), new Promise((resolve) => elsewhere.close(resolve))]);
    }
  }, 30_000);
});

/**
 * A dev server with a proxy nothing in the project shows, and one that's declared, each in front of
 * a recorder: what a real service would hear is what's tested.
 */
describe("a dev server's proxies, with a real service behind them", () => {
  const SHELL = `<!doctype html><title>Acme</title><body><div id="root"></div><script src="/widgets.js"></script><script src="/app.js"></script></body>`;
  const APP = `const raw = localStorage.getItem("sb-acme-auth-token");
    const s = raw && JSON.parse(raw);
    const root = document.getElementById("root");
    const add = (tag, attrs) => document.body.append(Object.assign(document.createElement(tag), attrs));
    if (location.pathname === "/") root.innerHTML = '<h1>Acme ledger</h1><p>Plain public words on what this product is for and who it serves each day.</p><a href="/login">Log in</a> <a href="/home">My ledger</a>';
    else if (!s) root.innerHTML = '<h1>Welcome back</h1><form><input type="email"><input type="password"><button>Log in</button></form>';
    else if (location.pathname !== "/home") root.innerHTML = "<h1>Page not found</h1>";
    else {
      root.innerHTML = '<h1>Home ledger</h1><p>Your ledger, with everything you have done lately in one long list.</p><a href="/svc/monthly">Monthly</a> <a href="/svc/feed?sid=' + encodeURIComponent(s.access_token) + '">Feed</a> <a href="/backend/report">Report</a>';
      add("script", { src: "/widgets.js?sid=" + encodeURIComponent(s.access_token) });
      add("script", { src: "/svc/w.js" });
      add("script", { src: "/backend/w.js" });
      add("img", { src: "/svc/chart.png" });
      add("img", { src: "/avatar.png?token=" + encodeURIComponent(s.access_token) });
      add("img", { src: "/pixel.php?uid=" + s.user.id });
    }`;
  const real: string[] = [];
  const dev: string[] = [];
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      dev.push(req.url ?? "");
      if (path.startsWith("/svc") || path.startsWith("/backend")) {
        real.push(req.url ?? "");
        return res.writeHead(200, { "content-type": "text/plain" }).end("from the real service");
      }
      if (path === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(APP);
      if (path === "/widgets.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("");
      if (/\.\w+$/.test(path)) return res.writeHead(200, { "content-type": "image/png" }).end("x");
      res.writeHead(200, { "content-type": "text/html" }).end(SHELL);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("the stand-in's reads reach neither, declared or not, and carry nothing of the session", async () => {
    real.length = 0;
    dev.length = 0;
    const result = await scanSite({ startUrl: url, maxPages: 6, maxDurationMs: 15_000, delayMs: 0, screenshots: false, learnActions: false, proxied: ["/backend"], standIn: { addresses: ["/home"], provider: "supabase", maxPages: 6, maxDurationMs: 20_000 } });
    expect(result.standIn?.status).toBe("not_shown"); // one drawing with no rows of its own: the page ran, and it proves no screen
    expect(result.standIn?.notReached).toContainEqual({ path: "/home", why: "not_shown" });
    expect(real).toEqual([]);
    expect(dev.filter((path) => /sid=|token=|uid=|pixel/.test(path))).toEqual([]);
    expect(dev).toContain("/widgets.js"); // named by the app's own document, and read with no query
  }, 60_000);

  it("left unsealed, the same links are heard: the recorder would have caught it", async () => {
    real.length = 0;
    const open = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Links</title><h1>Links</h1><p>A plain page with words on it.</p><a href="${url}backend/report">Report</a><img src="${url}svc/chart.png">`));
    await new Promise<void>((resolve) => open.listen(0, "127.0.0.1", resolve));
    await scanSite({ startUrl: `http://127.0.0.1:${(open.address() as AddressInfo).port}/`, maxPages: 3, maxDurationMs: 10_000, delayMs: 0, screenshots: false, learnActions: false });
    expect(real).toContain("/svc/chart.png");
    open.closeAllConnections();
    open.close();
  }, 60_000);
});
