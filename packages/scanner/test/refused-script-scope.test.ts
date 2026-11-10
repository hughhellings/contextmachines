import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A script a local run refused (a chat widget, a payments library from another host) says nothing
 * of a page that never loaded it. One page here stands on such a script, another has a button that
 * really does nothing and loads nothing of anyone else's. Whichever is reached first, the dead
 * button is found, and the page whose own script was refused still gives no finding of its buttons.
 */
const pad = `<p>${"A page of the product with enough words of its own to be a screen worth learning, read and pressed. ".repeat(3)}</p>`;
const page = (title: string, body: string, head = "") => `<!doctype html><html><head><title>${title}</title>${head}</head><body><h1>${title}</h1>${pad}${body}</body></html>`;
// Its button's code is the library's: refused, the button can't be said to do nothing.
const WIDGET = page("Support", `<a href="/reports">Reports</a> <button id="chat">Open chat</button><script>chat.onclick = () => window.Chat && window.Chat.open();</script>`, `<script src="https://widget.example.invalid/chat.js"></script>`);
// Nothing of anyone else's, and a button with no code behind it at all.
const REPORTS = page("Reports", `<a href="/support">Support</a> <button id="export">Export</button>`);
// The refused page opens the dead one by a press, as single-page apps do with no link at all.
const PRESSED = page("Support", `<button type="button" onclick="location.href='/reports'">Reports</button> <button id="chat">Open chat</button><script>chat.onclick = () => window.Chat && window.Chat.open();</script>`, `<script src="https://widget.example.invalid/chat.js"></script>`);

let app: http.Server;
let base: string;
const scan = (start: string) => scanSite({ startUrl: start, stayLocal: true, maxPages: 3, maxDurationMs: 120_000, delayMs: 0, screenshots: false });
const deadButtons = (result: ScanResult) => result.findings.filter((f) => f.kind === "does_nothing").map((f) => `${f.screen} ${f.target}`);

let widgetFirst: ScanResult;
let reportsFirst: ScanResult;
let byPress: ScanResult;

beforeAll(async () => {
  app = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = path === "/reports" ? REPORTS : path === "/pressed" ? PRESSED : WIDGET;
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  [widgetFirst, reportsFirst, byPress] = await Promise.all([scan(`${base}/support`), scan(`${base}/reports`), scan(`${base}/pressed`)]);
}, 400_000);

afterAll(() => {
  app.closeAllConnections();
  app.close();
});

describe("a script a local run refused, on one page only", () => {
  it("doesn't hide a dead button on another page, whichever is reached first", () => {
    for (const result of [widgetFirst, reportsFirst, byPress]) {
      // A run cut short by its time limit can lose its last finding, which would read as this bug: it must have finished.
      expect(result.stoppedBy).toBe("complete");
      expect(result.stayedAway).toContain("widget.example.invalid");
      expect(result.pagesVisited).toContain("/reports");
      expect(deadButtons(result)).toContain("/reports Export");
    }
  });

  it("still says nothing of a button on the page whose own script was refused", () => {
    for (const result of [widgetFirst, reportsFirst, byPress]) {
      expect(deadButtons(result).filter((d) => !d.startsWith("/reports "))).toEqual([]);
      expect(result.findings.filter((f) => f.screen === "/support" || f.screen === "/pressed")).toEqual([]);
    }
  });
});
