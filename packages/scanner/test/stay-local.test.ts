import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A local run stays local from its first request. The page below does what a real local app does:
 * it points at the real sign-in, the real fonts and the real tracker. None of those hosts exist,
 * and that's not what's being tested: what is, is that nothing tries, and that another local port
 * (a local database, say) is still reachable.
 */
const PAGE = (localApi: string) => `<!doctype html><html><head><title>Local app</title>
<link rel="stylesheet" href="https://fonts.example.invalid/font.css">
<script src="https://tracker.example.invalid/t.js"></script></head>
<body><h1>Local app</h1><p>Sign in below, or read what this product does for people who use it.</p>
<a href="https://project.example.invalid/auth/v1/authorize?provider=google">Continue with Google</a>
<a href="/about">About</a>
<img src="https://cdn.example.invalid/pixel.png">
<script>
  fetch(${JSON.stringify(localApi)} + "/local-read");
  fetch("https://data.example.invalid/rest/v1/plans").catch(() => {});
  try { new WebSocket("wss://live.example.invalid/socket"); } catch {}
</script></body></html>`;

/** A page that stands on a library from a host a local run stays away from, and one that crashes by itself. */
describe("a script this run refused", () => {
  const SDK = `<!doctype html><title>Pay</title><script src="https://cdn.example.invalid/sdk.js"></script><h1>Pay</h1><p>What the product charges and how it goes about taking the money.</p><a href="/plain">Plain</a><button id="go">Pay now</button>
    <script src="/own.js"></script>`;
  const OWN = `document.getElementById("go").onclick = () => window.Sdk.open(); window.Sdk.init();`;
  const PLAIN = `<!doctype html><title>Plain</title><h1>Plain</h1><p>A page that loads nothing of anyone else's, and has a real fault of its own.</p><script src="/bad.js"></script>`;
  const FONT = `<!doctype html><title>Font</title><link rel="stylesheet" href="https://fonts.example.invalid/font.css"><h1>Font</h1><p>A page with a font from elsewhere and a press that really fails, whatever the font.</p><button id="b">Refresh</button><script src="/press.js"></script>`;
  let app: http.Server;
  let url: string;
  beforeAll(async () => {
    app = http.createServer((req, res) => {
      const js = (body: string) => res.writeHead(200, { "content-type": "text/javascript" }).end(body);
      if (req.url === "/own.js") return js(OWN);
      if (req.url === "/bad.js") return js("null.boom();");
      if (req.url === "/press.js") return js('document.getElementById("b").onclick = () => { throw new TypeError("totals are undefined"); };');
      if (req.url === "/data") return res.writeHead(500).end("{}");
      res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/plain" ? PLAIN : req.url === "/font" ? FONT : SDK);
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
  });
  afterAll(() => {
    app.closeAllConnections();
    app.close();
  });
  const scan = (start: string, proxied?: string[]) => scanSite({ startUrl: start, stayLocal: true, ...(proxied ? { proxied } : {}), maxPages: 4, maxDurationMs: 15_000, delayMs: 0, screenshots: false });

  it("isn't the app's bug: nothing that follows on that load is a finding, a press included", async () => {
    const result = await scan(url);
    expect(result.stayedAway).toContain("cdn.example.invalid");
    expect(result.findings.filter((f) => f.screen === "/")).toEqual([]);
  }, 40_000);

  it("the same for one held under a declared proxy", async () => {
    const held = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(SDK.replace("https://cdn.example.invalid/sdk.js", "/api/sdk.js").replace('<script src="/own.js"></script>', `<script>${OWN}</script>`)));
    await new Promise<void>((resolve) => held.listen(0, "127.0.0.1", resolve));
    try {
      const result = await scan(`http://127.0.0.1:${(held.address() as AddressInfo).port}/`, ["/api"]);
      expect(result.findings).toEqual([]);
    } finally {
      held.closeAllConnections();
      held.close();
    }
  }, 40_000);

  it("says nothing of the next page load: a real crash with no refused script stays a finding", async () => {
    const result = await scan(url);
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: "crashes", screen: "/plain" }));
  }, 40_000);

  it("a font from elsewhere holds nothing up: a press that fails later is still found", async () => {
    const result = await scan(`${url}font`);
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: "crashes", target: expect.stringContaining("totals are undefined") }));
  }, 40_000);
});

describe("a run on a local address", () => {
  let app: http.Server;
  let api: http.Server;
  const heardApi: string[] = [];
  let run: (stayLocal: boolean) => Promise<ScanResult>;

  beforeAll(async () => {
    api = http.createServer((req, res) => {
      heardApi.push(req.url ?? "");
      res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const local = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    app = http.createServer((req, res) => {
      if (req.url === "/about") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>About</title><h1>About</h1><p>What this product is, for anyone who asks about it.</p>");
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE(local));
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    run = (stayLocal) => scanSite({ startUrl: `http://127.0.0.1:${(app.address() as AddressInfo).port}/`, maxPages: 5, maxDurationMs: 15_000, delayMs: 0, screenshots: false, stayLocal });
  });
  afterAll(() => {
    app.closeAllConnections();
    api.closeAllConnections();
    app.close();
    api.close();
  });

  it("tries no other host, and says which it stayed away from", async () => {
    const result = await run(true);
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/", "/about"]));
    expect(result.stayedAway).toEqual(expect.arrayContaining(["fonts.example.invalid", "tracker.example.invalid", "cdn.example.invalid", "data.example.invalid", "live.example.invalid"]));
  }, 40_000);

  it("doesn't follow a sign-in button to another host, and calls nothing of that a fault of the app's", async () => {
    const result = await run(true);
    expect(result.pagesVisited.some((p) => /authorize/.test(p))).toBe(false);
    expect(result.findings.filter((f) => /example\.invalid/.test(`${f.target} ${f.evidence}`))).toEqual([]);
  }, 40_000);

  it("still reaches another port on this machine", async () => {
    heardApi.length = 0;
    await run(true);
    expect(heardApi).toContain("/local-read");
  }, 40_000);

  it("left alone, a run keeps the rule it always had", async () => {
    const result = await run(false);
    expect(result.stayedAway).toBeUndefined();
  }, 40_000);
});

/** Same-origin to the browser, a real service behind it: the dev proxy is a host in all but name. */
describe("a declared dev proxy, on a local run", () => {
  const real: string[] = [];
  let app: http.Server;
  let url: string;
  const PAGE = `<!doctype html><title>Local app</title><h1>Local app</h1><p>What this product does, for anyone who asks about it here.</p>
    <a href="/backend/report">Report</a> <a href="/backendish">Close</a> <a href="/about">About</a> <a href="/moved">Moved</a>
    <img src="/backend/pixel.png">
    <script>fetch("/backend/public-status").catch(() => {}); fetch("/own-data").catch(() => {});</script>`;

  beforeAll(async () => {
    app = http.createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/backend/") || path === "/own-data") {
        real.push(path);
        return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      if (path === "/moved") return res.writeHead(302, { location: "/backend/moved" }).end();
      if (path === "/about") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>About</title><h1>About</h1><p>What this product is, for anyone who asks about it.</p>");
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
  });
  afterAll(() => {
    app.closeAllConnections();
    app.close();
  });
  const walk = (more: { proxied?: string[]; stayLocal: boolean }) => scanSite({ startUrl: url, maxPages: 5, maxDurationMs: 15_000, delayMs: 0, screenshots: false, learnActions: false, ...more });

  it("sends nothing there, by a call, a picture, a link or a redirect, and says what it held", async () => {
    real.length = 0;
    const result = await walk({ stayLocal: true, proxied: ["/backend"] });
    expect(real.filter((path) => path.startsWith("/backend/"))).toEqual([]);
    expect(result.proxiedHeld).toEqual(["/backend"]);
    expect(result.proxyUnread).toBeUndefined();
    expect(result.pagesVisited).toContain("/about");
    expect(result.pagesVisited.some((path) => path.startsWith("/backend/"))).toBe(false);
    expect(real).toContain("/own-data");
  }, 40_000);

  it("unsealed by nothing: with no proxy said, the recorder hears it", async () => {
    real.length = 0;
    const result = await walk({ stayLocal: true });
    expect(real).toEqual(expect.arrayContaining(["/backend/public-status", "/backend/pixel.png", "/backend/report"]));
    expect(result.proxiedHeld).toBeUndefined();
  }, 40_000);

  it("isn't a local run's rule on a run that isn't one", async () => {
    real.length = 0;
    await walk({ stayLocal: false, proxied: ["/backend"] });
    expect(real).toContain("/backend/public-status");
  }, 40_000);

  it("with what's handed on unread, holds the page's calls, and doesn't claim its pages and files", async () => {
    real.length = 0;
    const result = await walk({ stayLocal: true, proxied: ["*"] });
    expect(real).not.toContain("/backend/public-status");
    expect(real).not.toContain("/own-data");
    expect(result.proxyUnread).toBe(true);
    expect(result.proxiedHeld).toEqual(expect.arrayContaining(["/backend", "/own-data"]));
    expect(result.pagesVisited).toContain("/about");
  }, 40_000);
});
