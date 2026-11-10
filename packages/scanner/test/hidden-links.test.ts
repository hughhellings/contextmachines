import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * One page with all its sections in the document, as a tabbed settings page has, one shown per
 * address. A link in a hidden section can be followed, but it's no way from the section on screen.
 */
const page = (shown: string) => `<!doctype html><title>Settings</title><body>
<nav><a href="/settings/accounts">Accounts</a> <a href="/settings/profile">Profile</a></nav>
<main>
  <section ${shown === "accounts" ? "" : "hidden"}><h1>Accounts</h1><p>The accounts linked to this one, which you can change here at any time.</p><a href="/import">Import a file</a></section>
  <section ${shown === "profile" ? "" : 'style="display:none"'}><h1>Profile</h1><p>Who you are, and the key this product uses to talk to your software.</p><a href="/guide">Setup guide</a></section>
  <section style="visibility:hidden;height:0"><a href="/ghost">Ghost</a></section>
  <section aria-hidden="true"><a href="/shadow">Shadow</a></section>
</main></body>`;
const plain = (name: string) => `<!doctype html><title>${name}</title><h1>${name}</h1><p>A page of its own, with enough words on it to be read as one by the learner.</p>`;

describe("a link in a hidden section", () => {
  let server: http.Server;
  let result: ScanResult;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      res.writeHead(200, { "content-type": "text/html" }).end(path.startsWith("/settings/") ? page(path.split("/")[2]!) : plain(path.slice(1)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    result = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/accounts`, maxPages: 8, maxDurationMs: 15_000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false });
  }, 40_000);
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("is lent to no section that isn't showing it", () => {
    const fromAccounts = result.links["/settings/accounts"] ?? [];
    expect(fromAccounts).toContain("/import");
    expect(fromAccounts).not.toContain("/guide");
    for (const hidden of ["/ghost", "/shadow"]) expect(fromAccounts).not.toContain(hidden);
  });

  it("is a way from the section that shows it", () => {
    const fromProfile = result.links["/settings/profile"] ?? [];
    expect(fromProfile).toContain("/guide");
    expect(fromProfile).not.toContain("/import");
  });

  it("is still followed, so the screen behind it is learned", () => {
    expect(result.pagesVisited).toContain("/guide");
  });
});
