import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * Not every link leads to a screen. One answered as an attachment is a file to download, and one
 * whose whole body is a JSON value (an API's answer served as text/html, bare or in a lone <pre>)
 * is data. Neither is learned, photographed or named as a screen, and neither is an error.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let server: http.Server;
let result: ScanResult;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/download/")) {
      res.writeHead(200, { "content-type": "text/html", "content-disposition": `attachment; filename="report.txt"` });
      return res.end("report");
    }
    res.setHeader("content-type", "text/html");
    if (path === "/api/productsList") return res.end(JSON.stringify({ responseCode: 200, products: [{ id: 1, name: "Blue Top" }] }));
    if (path === "/api/searchProduct") return res.end(`<html><body><pre>{"responseCode": 405, "message": "This request method is not supported."}</pre></body></html>`);
    if (path === "/about") return res.end(page("About us", "<p>We sell tops.</p>"));
    res.end(page("Shop", `<a href="/about">About</a> <a href="/download/1">Report</a> <a href="/export" download>Export</a>
      <a href="/api/productsList">Products API</a> <a href="/api/searchProduct">Search API</a>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 8, maxDurationMs: 25_000, delayMs: 0 });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("links to files and to data", () => {
  it("learns the pages and nothing else", () => {
    expect(result.pagesVisited.sort()).toEqual(["/", "/about"]);
    expect(result.screens.map((s) => s.path).filter((p) => p.startsWith("/api") || p.startsWith("/download"))).toEqual([]);
    expect(result.events.some((e) => e.kind === "route" && /^\/(api|download)/.test(e.path))).toBe(false);
  });

  it("reports no error and no issue for them", () => {
    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

describe("a link to a server that's busy", () => {
  it("is no broken link, while one that fails is", async () => {
    const s = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/busy") return res.writeHead(503, { "retry-after": "1" }).end(page("Service unavailable", ""));
      if (req.url === "/fails") return res.writeHead(500).end(page("Server error", ""));
      res.end(page("Shop", `<a href="/busy">Busy</a> <a href="/fails">Fails</a>`));
    });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const r = await scanSite({ startUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, maxPages: 4, maxDurationMs: 15_000, delayMs: 0, screenshots: false, exploreButtons: false });
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect(r.findings.filter((f) => f.kind === "broken_link").map((f) => f.target)).toEqual(["/fails"]);
  }, 30_000);
});

describe("how the start page answered", () => {
  const serve = async (handler: http.RequestListener) => {
    const s = http.createServer(handler);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const r = await scanSite({ startUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, maxPages: 2, maxDurationMs: 15_000, delayMs: 0 });
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return r;
  };

  it("keeps a bot check's title, which isn't a request to sign in", async () => {
    const r = await serve((_, res) => { res.writeHead(403, { "content-type": "text/html" }); res.end("<title>Just a moment...</title><p>Checking your browser</p>"); });
    expect(r.startStatus).toBe(403);
    expect(r.startTitle).toBe("Just a moment...");
    expect(r.startAsksSignIn).toBeUndefined();
  }, 30_000);

  it("knows a server that asks for credentials", async () => {
    const r = await serve((_, res) => { res.writeHead(401, { "content-type": "text/html", "www-authenticate": `Basic realm="staff"` }); res.end("<title>Unauthorized</title>"); });
    expect(r.startStatus).toBe(401);
    expect(r.startAsksSignIn).toBe(true);
  }, 30_000);
});
