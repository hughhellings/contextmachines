import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A SharedWorker's requests never pass the learner's interception, so a page that saves from one
 * (cross-tab sync, a shared connection) would save for real. The learner's pages get no
 * SharedWorker: the page falls back to what it does without one, and nothing reaches the server.
 * A page that uses it without checking fails, which is the learner's doing and never an issue.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let server: http.Server;
let result: ScanResult;
const writes: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "GET") writes.push(`${req.method} ${path}`);
    if (path === "/sync.js") {
      res.setHeader("content-type", "text/javascript");
      return res.end(`onconnect = () => fetch("/api/shared-save", { method: "POST", body: "{}" });`);
    }
    if (path.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    res.setHeader("content-type", "text/html");
    if (path === "/unchecked") return res.end(page("Unchecked", `<script>const worker = new SharedWorker("/sync.js"); worker.port.start();</script>`));
    res.end(page("Notes", `<p id="mode">starting</p><a href="/unchecked">Unchecked</a><script>
      if (typeof SharedWorker === "function") { new SharedWorker("/sync.js").port.start(); mode.textContent = "shared"; }
      else mode.textContent = "on its own";</script>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 3, maxDurationMs: 20_000, delayMs: 0, screenshots: false });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a page that saves from a SharedWorker", () => {
  it("sends nothing to the server", () => {
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/", "/unchecked"]));
    expect(writes).toEqual([]);
  });

  it("never reports the missing SharedWorker as the site crashing", () => {
    expect(result.findings.filter((f) => f.kind === "crashes")).toEqual([]);
  });
});
