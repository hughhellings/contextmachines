import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, pad, page, quick, serve } from "./precision-site.ts";

/**
 * What the crawl tells the understanding beyond what it saw on each page: a site that routes by its
 * query is many screens, ?view=grid is one, a link's path and which screens lead where are facts,
 * and two buttons of one form are two actions.
 */
const shot = { ...quick, screenshots: true };
const events = (r: ScanResult) => r.events.flatMap((e) => (e.kind === "network" ? [e] : []));
let routed: ScanResult;
let drawn: ScanResult;
let form: ScanResult;
let asked: string[] = [];

beforeAll(async () => {
  const nav = `<nav><a href="/index.php?page=invoices">Invoices</a> <a href="/index.php?page=clients">Clients</a> <a href="/index.php?page=reports">Reports</a></nav>`;
  const php = await serve((_req, res, url) => {
    asked.push(url.pathname + url.search);
    const name = url.searchParams.get("page") ?? "home";
    html(res, page(`Acme ${name}`, `${nav}<h1>All ${name}</h1><a href="/index.php?page=${name}&amp;invoice_id=7">One</a>${pad}`));
  });
  routed = await scanSite({ ...quick, startUrl: `http://localhost:${php}/index.php` });

  // The same document whatever the key says: a view of it, not a screen of its own.
  const views = await serve((_req, res) => html(res, page("Catalogue", `<nav><a href="/shop?view=grid">Grid</a> <a href="/shop?view=list">List</a> <a href="/shop?view=map">Map</a></nav><h1>Catalogue</h1>${pad}`)));
  drawn = await scanSite({ ...quick, startUrl: `http://localhost:${views}/shop` });

  const admin = await serve((_req, res) => html(res, page("Database", `<h1>Database</h1><form method="post" action="/db"><button name="action" value="INIT">Initialize</button><button name="action" value="CLEAN">Clean</button></form>${pad}`)));
  form = await scanSite({ ...quick, startUrl: `http://localhost:${admin}/db` });
}, 90_000);

afterAll(closeAll);

describe("a site that routes by its query", () => {
  it("keeps the crawl and the snippet on the same screens, one for each route", () => {
    expect(routed.pagesVisited).toEqual(expect.arrayContaining(["/index.php", "/index.php?page=invoices", "/index.php?page=clients", "/index.php?page=reports"]));
    const shown = routed.events.flatMap((e) => (e.kind === "route" ? [e.path] : []));
    expect(shown).toContain("/index.php?page=clients");
  });

  it("leaves one document drawn several ways as one screen", () => {
    expect(drawn.pagesVisited).toEqual(["/shop"]);
  });
});

describe("what the understanding is told", () => {
  it("a link's box says where it leads, with no query", async () => {
    const site = await serve((_req, res) => html(res, page("Home", `<h1>Home</h1><a href="/sign-up?ref=abc#top">Join</a>${pad}`)));
    const run = await scanSite({ ...shot, maxPages: 1, startUrl: `http://localhost:${site}/` });
    const box = run.screens.flatMap((s) => s.boxes).find((b) => b.label === "Join");
    expect(box?.href).toBe(`http://localhost:${site}/sign-up`);
  });

  it("says which screens lead to which, and only those", () => {
    expect(routed.links["/index.php"]).toContain("/index.php?page=clients");
    expect(routed.links["/index.php?page=clients"]).toContain("/index.php?page=invoices");
    expect(Object.keys(routed.links)).not.toContain("/nowhere");
  });

  it("the button a form was sent with goes with the save, so two buttons of a form can be two actions", () => {
    expect(events(form).filter((e) => e.method === "POST").map((e) => e.graphqlOperation)).toContain("intent:init");
  });
});
