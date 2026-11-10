import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A broken link's address is recorded as a pattern, as screens are, and what a missing page says
 * isn't kept: a link to someone's record (/clients/jane-smith, a file named by an email) or a
 * "not found" page that names them must leave no trace of them in what the learner returns.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let server: http.Server;
let result: ScanResult;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    res.setHeader("content-type", "text/html");
    if (path === "/") {
      return res.end(page("Clients", `<a href="/clients/jane-smith">Jane</a> <a href="/people/jane@uni.edu">Jane's profile</a>
        <a href="/files/jane@uni.edu.pdf">Jane's file</a> <a href="/archive/jane-smith-2024">Old page</a>`));
    }
    if (path.startsWith("/archive/")) return res.end(page("Jane Smith page not found", "<p>Try the search.</p>"));
    res.writeHead(404).end(page("Not found", ""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 6, maxDurationMs: 25_000, delayMs: 0, screenshots: false });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("broken links to someone's record", () => {
  it("are reported by their pattern", () => {
    const broken = result.findings.filter((f) => f.kind === "broken_link");
    expect(broken.map((f) => f.target)).toEqual(expect.arrayContaining(["/clients/:id", "/people/:id", "/archive/:id"]));
    expect(broken.find((f) => f.target === "/archive/:id")?.evidence).toBe("200, but the page says it's missing");
  });

  it("leave no name, email or file name anywhere in the result", () => {
    const all = JSON.stringify(result);
    for (const text of ["jane-smith", "jane@uni.edu", "Jane Smith", "jane%40uni.edu"]) expect(all).not.toContain(text);
  });
});
