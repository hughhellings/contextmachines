// What a real browser draws against what gets called a screen: a small app on this machine, the real
// learner, and the understanding with no AI.
//   node --test cli/learn-screens.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { scanSite } from "@contextmachines/scanner";
import { understand, type Understood } from "./understand.ts";

const browser = existsSync(chromium.executablePath());

/** One document for every address: a router in the browser, with a table of titles, and a fallback to the sign-in. */
const APP = `<!doctype html><html><head><title>Acme</title></head><body><div id="root"></div><script>
const TITLES = { "/privacy": "Privacy Policy | Acme", "/old-pricing": "Pricing | Acme", "/reports/one": "Report | Acme", "/reports/two": "Report | Acme" };
const root = document.getElementById("root");
const nav = '<nav><a href="/terms">Terms</a> <a href="/privacy">Privacy</a> <a href="/old-pricing">Pricing</a> <a href="/settings/profile">Settings</a> <a href="/reports/one">One</a> <a href="/reports/two">Two</a> <a href="/login">Sign in</a></nav>';
const signIn = '<h1>Welcome back</h1><form><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><button>Sign in</button></form>' + nav;
const settings = (shown) => '<h1>Settings</h1><a href="/settings/profile">Profile</a> <a href="/settings/accounts">Accounts</a>' +
  '<section ' + (shown === "profile" ? "" : "hidden") + '><h2>Profile</h2><p>How you appear to others.</p><label>Display name <input name="displayName"></label></section>' +
  '<section ' + (shown === "accounts" ? "" : "hidden") + '><h2>Accounts</h2><p>The services connected to this one.</p><label>Account label <input name="accountLabel"></label></section>';
const report = (words) => '<h1>Report</h1><p>' + words + '</p><button type="button">Export</button>' + nav;
function draw() {
  const path = location.pathname;
  document.title = TITLES[path] ?? "Acme";
  if (path === "/terms") root.innerHTML = '<h1>Terms of use</h1><p>Plain terms for using this product, in full, on a page of their own.</p>' + nav;
  else if (path === "/settings/profile") root.innerHTML = settings("profile");
  else if (path === "/settings/accounts") root.innerHTML = settings("accounts");
  else if (path === "/reports/one") root.innerHTML = report("Sales went up in the spring, and everyone was glad of it.");
  else if (path === "/reports/two") root.innerHTML = report("Costs went down in the autumn, and nobody could say why.");
  else if (path === "/deals") { history.pushState({}, "", "/login"); draw(); }
  else {
    root.innerHTML = signIn;
    root.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      await fetch("/api/session", { method: "POST", body: "{}" });
      history.pushState({}, "", "/deals");
      draw();
    };
  }
}
addEventListener("popstate", draw);
addEventListener("click", (e) => { const a = e.target.closest("a"); if (a) { e.preventDefault(); history.pushState({}, "", a.getAttribute("href")); draw(); } });
draw();
</script></body></html>`;

describe("what counts as a screen", { skip: browser ? false : "no browser here" }, () => {
  let server: Server;
  let seen: Understood;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url!.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      res.writeHead(200, { "content-type": "text/html" }).end(APP);
    }).listen(0, "127.0.0.1");
    await new Promise((done) => server.once("listening", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const scan = await scanSite({ startUrl: `${origin}/`, maxPages: 20, maxDurationMs: 40_000, delayMs: 0, stayLocal: true });
    seen = await understand(scan, { origin: scan.startOrigin });
  });
  after(() => server.close());

  const screens = () => seen.shown.map((s) => s.path).sort();

  it("gives addresses that fall through to the sign-in no screen, and says they drew the same", () => {
    assert.ok(!screens().includes("/privacy"), screens().join(" "));
    assert.ok(!screens().includes("/old-pricing"), screens().join(" "));
    const views = seen.shown.flatMap((s) => (s.views ?? []).map((v) => v.path));
    assert.ok(views.includes("/privacy") && views.includes("/old-pricing"), views.join(" "));
    assert.ok(!seen.features.some((f) => /privacy|pricing/i.test(JSON.stringify(f))));
  });

  it("keeps two reports that share a layout and draw different things", () => {
    assert.ok(screens().includes("/reports/one") && screens().includes("/reports/two"), screens().join(" "));
  });

  it("gives each section of a tabbed page only the fields it showed", () => {
    const fields = (path: string) => seen.site.pages.find((p) => p.path === path)?.snapshot.forms.flatMap((f) => f.fields.map((x) => x.name)) ?? [];
    assert.deepEqual(fields("/settings/profile"), ["displayName"]);
    assert.deepEqual(fields("/settings/accounts"), ["accountLabel"]);
  });

  it("never lists the address a guard sent it straight back from", () => {
    assert.ok(!screens().includes("/deals"), screens().join(" "));
  });
});
