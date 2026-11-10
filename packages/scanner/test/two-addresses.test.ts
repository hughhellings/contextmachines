import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite } from "../src/scan.ts";

// A marketing site and its app on another address, as many software companies run them.
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let marketing: http.Server;
let app: http.Server;
let m = "";
let a = "";
const listen = (server: http.Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeAll(async () => {
  app = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/settings" ? page("Settings", "") : page("Dashboard", `<a href="/settings">Settings</a><button type="button">New project</button>`));
  });
  a = await listen(app);
  marketing = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/pricing" ? page("Pricing", "") : page("Home", `<a href="/pricing">Pricing</a><a href="${a}/">Open the app</a>`));
  });
  m = await listen(marketing);
});

afterAll(() => {
  marketing?.close();
  app?.close();
});

describe("a site on more than one address", () => {
  it("is scanned from the marketing site into the app, with each page kept apart by address", async () => {
    const r = await scanSite({ startUrl: `${m}/`, siteOrigins: [a], delayMs: 0, exploreButtons: false });
    const appHost = new URL(a).host;
    expect(r.pagesVisited.sort()).toEqual(["/", "/pricing", `//${appHost}/`, `//${appHost}/settings`].sort());
    const structures = r.events.flatMap((e) => (e.kind === "page" ? [[e.path, e.snapshot.headings[0]]] : []));
    expect(structures).toContainEqual(["/", "Home"]);
    expect(structures).toContainEqual([`//${appHost}/`, "Dashboard"]);
    expect(r.startOrigin).toBe(m);
  }, 30_000);

  it("stays on the start address unless told the other address is part of the site", async () => {
    const r = await scanSite({ startUrl: `${m}/`, delayMs: 0, exploreButtons: false });
    expect(r.pagesVisited.sort()).toEqual(["/", "/pricing"]);
  }, 30_000);
});
