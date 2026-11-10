import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * Which failed requests are the product's. Only the site's own addresses, and an API host the page
 * called itself and that answered, can fail as the product. Another port on the same machine (a dev
 * tool's live-reload server that isn't running) or another host under the same domain (a cdn.
 * serving a broken image) is no part of it, so their failures are never proven issues.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const servers: http.Server[] = [];
const listen = (server: http.Server) => new Promise<number>((resolve) => {
  servers.push(server);
  server.listen(0, () => resolve((server.address() as AddressInfo).port));
});
/** A port nothing listens on. */
const closedPort = async () => {
  const s = http.createServer();
  const port = await new Promise<number>((resolve) => s.listen(0, () => resolve((s.address() as AddressInfo).port)));
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
};
let onLocalhost: ScanResult;
let underDomain: ScanResult;

beforeAll(async () => {
  // On localhost: a live-reload script on a port nothing listens on, an image from another local
  // server that fails, the app's own image while it's busy (503: a moment's state), and the app's
  // own API read that fails (the one real issue).
  const dead = await closedPort();
  const other = await listen(http.createServer((_req, res) => res.writeHead(500, { "content-type": "text/plain" }).end("Error")));
  const app = await listen(http.createServer((req, res) => {
    if (req.url === "/api/stats") return res.writeHead(500, { "content-type": "application/json" }).end("{}");
    if (req.url === "/busy.png") return res.writeHead(503, { "content-type": "text/plain", "retry-after": "1" }).end("Busy");
    res.setHeader("content-type", "text/html");
    res.end(page("Dashboard", `<img src="http://localhost:${other}/badge.png" alt=""><img src="/busy.png" alt=""><script src="http://localhost:${dead}/livereload.js?snipver=1"></script>
      <script>fetch("/api/stats").catch(() => {});</script>`));
  }));
  onLocalhost = await scanSite({ startUrl: `http://localhost:${app}/`, maxPages: 1, maxDurationMs: 15_000, delayMs: 0, screenshots: false, exploreButtons: false });

  // Under a domain: a cdn. host's image that fails, and an API host the page reads from that
  // answers one read and fails another (an issue, named with its host).
  const cdn = await listen(http.createServer((_req, res) => res.writeHead(500, { "content-type": "text/plain" }).end("Error")));
  const api = await listen(http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (req.url === "/broken") return res.writeHead(502, { "content-type": "text/plain" }).end("Bad gateway");
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  }));
  const apiBase = `http://api.shop.localhost:${api}`;
  const shop = await listen(http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(page("Shop", `<img src="http://cdn.shop.localhost:${cdn}/logo.png" alt="">
      <script>fetch("${apiBase}/products").then(() => fetch("${apiBase}/broken")).catch(() => {});</script>`));
  }));
  underDomain = await scanSite({ startUrl: `http://www.shop.localhost:${shop}/`, maxPages: 1, maxDurationMs: 15_000, delayMs: 0, screenshots: false, exploreButtons: false });
}, 60_000);

afterAll(() => {
  for (const server of servers) server.close();
});

describe("failed requests that are the product's", () => {
  it("never counts another port on the same machine as the site's own", () => {
    const targets = onLocalhost.findings.map((f) => f.target);
    expect(targets.some((t) => /livereload|badge/.test(t))).toBe(false);
  });

  it("still reports the site's own request that failed, by its path alone", () => {
    expect(onLocalhost.findings).toContainEqual(expect.objectContaining({ kind: "request_fails", target: "GET /api/stats", evidence: "500" }));
  });

  it("never reports the site saying it's busy for now (503)", () => {
    expect(onLocalhost.findings.some((f) => f.target.includes("busy"))).toBe(false);
  });

  it("never counts a cdn. host under the same domain as the site's own", () => {
    expect(underDomain.findings.some((f) => f.target.includes("logo"))).toBe(false);
  });

  it("reports an API host's failure once the host has answered, with the host in the target", () => {
    expect(underDomain.findings).toContainEqual(expect.objectContaining({ kind: "request_fails", target: expect.stringMatching(/^GET api\.shop\.localhost:\d+\/broken$/), evidence: "502" }));
  });
});
