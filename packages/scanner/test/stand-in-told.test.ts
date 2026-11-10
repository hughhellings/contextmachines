import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ScreenCheck } from "../src/checks.ts";
import { scanSite, type ScanConfig } from "../src/scan.ts";

/**
 * What a stand-in pass says stays true of how the pass ended. A ledger open to anybody, with an app
 * beside it, where the data call answers whoever asks: what makes each case is how the pass comes out.
 */
const SHELL = `<!doctype html><html lang="en"><head><title>Ledger</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
const client = (o: { readsSession: boolean; links: string[] }) => `
const root = document.getElementById("root");
const session = ${o.readsSession} ? (() => { try { return JSON.parse(localStorage.getItem("sb-ledger-auth-token")); } catch { return null; } })() : null;
const page = location.pathname;
const rest = (table) => fetch("/rest/v1/" + table, { headers: { apikey: "public" } }).then((r) => r.json());
async function main() {
  if (page === "/") {
    const rows = await rest("trades?select=*");
    root.innerHTML = '<h1>Open ledger</h1><p>Everything traded this week, for anyone at all to read through.</p><p>' + rows.length + ' trades</p><ul>' + rows.map((t) => '<li>' + t.symbol + '</li>').join("") + '</ul><a href="/app">Open app</a> ' + ${JSON.stringify(o.links.map((path) => `<a href="${path}">${path}</a>`).join(" "))} + ' <a href="/pricing">Pricing</a> <a href="/login">Log in</a>';
    return;
  }
  if (/^\\/s\\d$/.test(page)) { root.innerHTML = '<h1>Story ' + page + '</h1><p>A long public story about the product, for anyone who wanders in, on page ' + page + '.</p>'; return; }
  if (page === "/pricing") { root.innerHTML = '<h1>Pricing</h1><p>One plan for everybody who keeps books, with no surprises on the way.</p>'; return; }
  if (${o.readsSession} && (page === "/login" || !session)) { root.innerHTML = '<h1>Welcome back</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Log in</button></form>'; return; }
  if (page !== "/app" && page !== "/other") { root.innerHTML = '<h1>Not here</h1><p>Nothing at this address, as far as the app is concerned, sorry.</p>'; return; }
  const rows = await rest("trades?select=*");
  root.innerHTML = '<h1>App ' + page + '</h1><ul>' + rows.map((t) => '<li>' + t.symbol + '</li>').join("") + '</ul><p>' + rows.length + ' trades</p>';
}
main();
`;

async function ledger(o: { readsSession?: boolean; links?: string[]; slowPages?: boolean; serverDecides?: string }) {
  const script = client({ readsSession: o.readsSession ?? true, links: [...(o.links ?? []), ...(o.serverDecides ? [o.serverDecides] : [])] });
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const send = () => {
      if (path === o.serverDecides) return res.writeHead(302, { location: "/login" }).end();
      if (path === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(script);
      if (path.startsWith("/rest/v1/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: "p1", symbol: "PUBLIC-AAA" }, { id: "p2", symbol: "PUBLIC-BBB" }]));
      if (/\.\w+$/.test(path)) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html" }).end(SHELL);
    };
    if (o.slowPages && /^\/s\d$/.test(path)) setTimeout(send, 1500);
    else send();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

const run = async (app: { url: string }, standIn: NonNullable<ScanConfig["standIn"]>) => {
  const told: ScreenCheck[] = [];
  const result = await scanSite({ startUrl: app.url, maxPages: 20, maxDurationMs: 15_000, delayMs: 0, screenshots: false, onChecks: (checks) => told.push(...checks), standIn });
  return { told, result };
};
const rows = { trades: [{ id: "7", symbol: "SKU-RED-ZEPHYR" }] };

describe("what a stand-in pass that kept nothing says", () => {
  it("is nothing, when the page drew with the session never read", async () => {
    const app = await ledger({ readsSession: false });
    const { told, result } = await run(app, { maxPages: 8, maxDurationMs: 20_000, addresses: ["/other"], rows });
    app.close();
    expect(result.standIn?.status).toBe("not_rendered");
    expect(result.checks.filter((check) => check.seenWith)).toEqual([]);
    expect(told.filter((check) => check.seenWith)).toEqual([]);
  }, 60_000);

  it("is nothing, when the server turns out to decide", async () => {
    const app = await ledger({ serverDecides: "/members" });
    const { told, result } = await run(app, { maxPages: 8, maxDurationMs: 20_000, addresses: ["/app"], rows });
    app.close();
    expect(result.standIn?.status).toBe("server_auth");
    expect(result.checks.filter((check) => check.seenWith && !check.newUser)).toEqual([]);
    expect(told.filter((check) => check.seenWith && !check.newUser)).toEqual([]);
  }, 60_000);
});

describe("a public page behind a pass that reached something", () => {
  it("gets nothing measured on made-up rows", async () => {
    const app = await ledger({});
    const { told, result } = await run(app, { maxPages: 8, maxDurationMs: 20_000, addresses: ["/app"], rows });
    app.close();
    expect(result.standIn?.status).toBe("reached");
    expect(result.standIn?.reached).toEqual(["/app"]);
    const plural = result.checks.find((check) => check.target === "1 trades");
    expect(plural?.screens).toEqual(["/app"]);
    expect(told.flatMap((check) => check.screens)).not.toContain("/");
  }, 60_000);
});

describe("a new account walked before the public crawl has finished its look", () => {
  it("doesn't count a page that crawl went on to open as its own, or say anything of one", async () => {
    const app = await ledger({ links: ["/s1", "/s2", "/s3", "/s4", "/s5", "/s6"], slowPages: true });
    const said: string[][] = [];
    const told: ScreenCheck[] = [];
    const result = await scanSite({ startUrl: app.url, maxPages: 20, maxDurationMs: 15_000, delayMs: 0, screenshots: false, onChecks: (checks) => { told.push(...checks); said.push(checks.map((check) => check.screen)); }, standIn: { maxPages: 8, maxDurationMs: 20_000, addresses: ["/app", "/s3"], rows: {} } });
    app.close();
    const opened = result.pagesVisited.filter((path) => /^\/s\d$/.test(path));
    expect(opened.length).toBeGreaterThan(0);
    const screens = (result.newUser?.screens ?? []).map((screen) => screen.path);
    expect(screens.filter((path) => opened.includes(path))).toEqual([]);
    expect(result.newUser?.first).not.toBeOneOf(opened);
    expect(result.newUser?.message ?? "").toContain(screens.length ? `${screens.length} screen` : "public pages");
    expect(result.checks.filter((check) => check.newUser && check.screens.some((path) => opened.includes(path)))).toEqual([]);
    expect(told.filter((check) => check.newUser && opened.includes(check.screen))).toEqual([]);
  }, 60_000);
});
