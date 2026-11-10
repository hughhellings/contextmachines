import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, pad, page, quick, serve } from "./precision-site.ts";

/**
 * Where the start finally landed is the site: a stranger's first try is often the apex address or
 * http://, and before this the run lost every page and still said it had covered everything.
 */
const nav = `<nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/about">About</a></nav>`;
const screens = (r: ScanResult) => r.events.flatMap((e) => (e.kind === "route" ? [e.path] : []));
let apex: ScanResult;
let port: ScanResult;
let away: ScanResult;
let otherPort = 0;

beforeAll(async () => {
  const site = await serve((req, res, url) => {
    if (url.hostname.startsWith("acme.")) return void res.writeHead(301, { location: `http://www.acme.localhost:${url.port}${req.url}` }).end();
    html(res, page(`Acme ${url.pathname}`, `${nav}<h1>Acme ${url.pathname}</h1>${pad}`));
  });
  apex = await scanSite({ ...quick, startUrl: `http://acme.localhost:${site}/` });

  // The same host at another address, as http:// moves to https://.
  const moved = await serve((_req, res, url) => html(res, page(`Moved ${url.pathname}`, `${nav}<h1>Moved ${url.pathname}</h1>${pad}`)));
  otherPort = moved;
  const old = await serve((req, res) => void res.writeHead(302, { location: `http://localhost:${moved}${req.url}` }).end());
  port = await scanSite({ ...quick, startUrl: `http://localhost:${old}/` });

  // Another site altogether: 127.0.0.1 isn't localhost's, as a parked domain isn't yours.
  const elsewhere = await serve((_req, res) => html(res, page("Parked", `<h1>Parked</h1>${pad}`)));
  const leaving = await serve((_req, res) => void res.writeHead(302, { location: `http://127.0.0.1:${elsewhere}/` }).end());
  away = await scanSite({ ...quick, startUrl: `http://localhost:${leaving}/` });
}, 90_000);

afterAll(closeAll);

describe("a start that moves", () => {
  it("apex to www: the www address is the site, with plain screen paths", () => {
    expect(apex.startOrigin).toMatch(/^http:\/\/www\.acme\.localhost:/);
    expect(new Set(apex.pagesVisited)).toEqual(new Set(["/", "/pricing", "/about"]));
    expect(screens(apex)).toEqual(expect.arrayContaining(["/", "/pricing", "/about"]));
    expect(apex.startLeftFor).toBeUndefined();
  });

  it("the same host at another address (http to https): the new one is the site", () => {
    expect(port.startOrigin).toBe(`http://localhost:${otherPort}`);
    expect(new Set(port.pagesVisited)).toEqual(new Set(["/", "/pricing", "/about"]));
  });

  it("somewhere unrelated: says so, and learns nothing", () => {
    expect(away.pagesVisited).toEqual([]);
    expect(away.startLeftFor).toMatch(/^127\.0\.0\.1:/);
    expect(screens(away)).toEqual([]);
  });
});
