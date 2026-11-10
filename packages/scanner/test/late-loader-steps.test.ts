import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

const pad = `<p>${"A page of the product with enough words of its own to be a screen worth learning, read and pressed. ".repeat(3)}</p>`;
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${pad}<a href="/reports">Reports</a> ${body}</body></html>`;
const W = "https://widget.example.invalid/chat.js";
/**
 * A loader in steps through one helper ("load this script in a few seconds"): every step's timer is
 * the same code, so only the script each asks for says there's more to run. The widget is asked for
 * 12s after the page loaded, and its button is not called dead.
 */
const later = `<script>window.later = (src, ms) => setTimeout(() => { const s = document.createElement("script"); s.src = src; document.head.appendChild(s); }, ms);</script>`;
const PAGES: Record<string, string> = {
  "/hops": page("Hops", `<button id="chat">Open chat</button>${later}<script>later("/a.js", 4000);</script>`),
  "/reports": page("Reports", `<button id="export">Export</button>`),
};
const JS: Record<string, string> = { "/a.js": `later("/b.js", 4000);`, "/b.js": `later("${W}", 4000);` };
let app: http.Server;
let base: string;
const dead = (r: ScanResult) => r.findings.filter((f) => f.kind === "does_nothing").map((f) => `${f.screen} ${f.target}`);
const scan = (p: string) => scanSite({ startUrl: base + p, stayLocal: true, maxPages: 2, maxDurationMs: 120_000, delayMs: 0, screenshots: false });
const r: Record<string, ScanResult> = {};
beforeAll(async () => {
  app = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (JS[path]) return void res.writeHead(200, { "content-type": "text/javascript" }).end(JS[path]);
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "<!doctype html><title>Not found</title>");
  });
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  r.hops = await scan("/hops");
}, 300_000);
afterAll(() => { app.closeAllConnections(); app.close(); });

describe("a refused widget loaded in steps through one helper", () => {
  it("isn't called dead, and a real dead button beside it still is", () => {
    expect(dead(r.hops!)).not.toContain("/hops Open chat");
    expect(dead(r.hops!)).toContain("/reports Export");
  });
});
