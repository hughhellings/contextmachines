import type { CapturedEvent } from "@contextmachines/schemas";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DECLINE_COOKIES, inScope, saysMissing, scanSite, scopeOf, type ScanResult } from "../src/scan.ts";

/**
 * Patterns seen across real sites, each beside a look-alike that must be left alone: a classic
 * form that posts by loading a page, blank and advertising frames, error pages and "soft 404s"
 * beside pages that only mention "404" or "found", a cookie banner offering "Accept optional"
 * next to "Reject optional", a heading drawn late, a to-do box sent with Enter next to a box with
 * its own button, an advert that never stops loading, and pages made just like one another.
 */
let site: Server;
let ads: Server;
let result: ScanResult;
const received: { method: string; path: string; search: string; ua: string }[] = [];

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const long = (words: string) => `<p>${`${words} `.repeat(40)}</p>`;
/** A sign-in box in the sidebar of every page, as many classic sites have. */
const sidebar = `<aside><form method="post" action="/signin"><input name="username"><input name="password" type="password"><input type="submit" value="Log In"></form></aside>`;

beforeAll(async () => {
  // Another host altogether: an advert that keeps loading forever, and a frame of its own.
  ads = createServer((req, res) => {
    if (req.url?.startsWith("/frame")) return res.writeHead(200, { "content-type": "text/html" }).end("<p>Buy now</p>");
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((resolve) => ads.listen(0, resolve));
  const adHost = `http://localhost:${(ads.address() as AddressInfo).port}`;
  const advert = `<script>setInterval(() => fetch("${adHost}/poll", { mode: "no-cors" }).catch(() => {}), 150);</script><iframe src="${adHost}/frame"></iframe><iframe src="about:blank"></iframe>`;

  site = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      received.push({ method: req.method ?? "GET", path: url.pathname, search: url.search, ua: String(req.headers["user-agent"]) });
      const html = (status: number, content: string) => res.writeHead(status, { "content-type": "text/html" }).end(content);
      const consented = (req.headers.cookie ?? "").includes("consent=");
      switch (url.pathname) {
        case "/":
          return html(200, page("Shop", `${sidebar}<h1>Shop</h1>${long("Tools for every job.")}
            <a href="/contact">Contact</a> <a href="/gone">Old offer</a> <a href="/old-page">Archive</a> <a href="/lost-and-found">Lost and found</a>
            <a href="/reports/404-errors">Missing pages report</a> <a href="/late">News</a> <a href="/todo">To-do</a>
            <a href="/items/hammer">Hammer</a> <a href="/items/saw">Saw</a> <a href="/items/drill">Drill</a> <a href="/app/inbox">Inbox</a> <a href="/account">Account</a>
            <a href="/join">Join</a> <a href="/password">Password</a>
            ${consented ? "" : `<div class="cookie-notice" style="position:fixed;bottom:0;left:0;right:0;background:#eee">We use cookies.
              <button onclick="document.cookie='consent=all;path=/'; fetch('/consent?choice=accept')">Accept optional</button>
              <button onclick="document.cookie='consent=necessary;path=/'; fetch('/consent?choice=reject'); this.parentElement.remove()">Reject optional</button></div>`}
            ${advert}`));
        case "/contact":
          // A classic form: it sends by loading the page the server answers with.
          return html(200, page("Contact us", `${sidebar}<h1>Contact us</h1><form method="post" action="/contact/send">
            <label>Email <input name="email" type="email" required></label><label>Message <textarea name="message"></textarea></label>
            <button>Send message</button></form>`));
        case "/contact/send":
          return html(200, page("Thanks", "<h1>Thanks, we'll be in touch</h1>"));
        case "/gone":
          return html(404, page("Not found", "<h1>Not found</h1>"));
        case "/old-page":
          // A "soft 404": it loads fine, and says it's missing.
          return html(200, page("Page not found | Shop", "<h1>Page not found</h1><p>Try the home page.</p>"));
        case "/lost-and-found":
          return html(200, page("Lost and found | Shop", "<h1>Lost and found</h1><p>Items left in store.</p>"));
        case "/reports/404-errors":
          return html(200, page("404 errors this week | Shop", `<h1>404 errors this week</h1>${long("Pages people could not find, with how often.")}`));
        case "/app/inbox":
          // A single-page app served with a 404 that shows the whole app: a screen.
          return html(404, page("Inbox", `<h1>Inbox</h1>${long("Your conversations with customers, newest first.")}`));
        case "/account":
          // A strict content security policy: it may only talk to itself.
          res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self' 'unsafe-inline'" });
          return res.end(page("Account", "<h1>Your account</h1><form><label>Name <input name=\"full_name\"></label></form>"));
        case "/late":
          // Draws its heading well after it loads, as single-page apps do.
          return html(200, page("Shop", `<div id="root"></div><script>setTimeout(() => { root.innerHTML = "<h1>Latest news</h1><p>New tools in store.</p>"; }, 2500);</script>`));
        case "/todo":
          return html(200, page("Todos", `<section><header><h1>todos</h1><input class="new-todo" placeholder="What needs to be done?"></header><ul id="list"></ul><nav id="filters"></nav></section>
            <div class="coupon"><input name="coupon" placeholder="Coupon code"><button type="button">Apply</button></div>
            <script>
              const show = () => { const items = JSON.parse(localStorage.getItem("todos") || "[]"); list.innerHTML = items.map((t) => "<li>" + t + "</li>").join(""); filters.innerHTML = items.length ? '<a href="#/">All</a> <a href="#/active">Active</a>' : ""; };
              document.querySelector(".new-todo").addEventListener("keydown", (e) => { if (e.key !== "Enter" || !e.target.value) return; localStorage.setItem("todos", JSON.stringify([...JSON.parse(localStorage.getItem("todos") || "[]"), e.target.value])); e.target.value = ""; show(); });
              document.querySelector("[name=coupon]").addEventListener("keydown", (e) => { if (e.key === "Enter") fetch("/entered-coupon"); });
              show();
            </script>`));
        case "/join":
        case "/password": {
          // A single-page app's forms: no address to send to, and fields with no names, only placeholders.
          const [heading, first, second, button, api] = url.pathname === "/join"
            ? ["Join", "Email", "Password", "Create account", "/api/join"]
            : ["Change password", "Current password", "New password", "Change password", "/api/password"];
          return html(200, page(heading, `<h1>${heading}</h1><form id="f"><input placeholder="${first}"><input type="password" placeholder="${second}"><button>${button}</button></form>
            <script>f.onsubmit = (e) => { e.preventDefault(); fetch("${api}", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); };</script>`));
        }
        case "/items/hammer":
        case "/items/saw":
          // Made just like each other: the second isn't pressed through again.
          return html(200, page(url.pathname.slice(7), `<h1>${url.pathname.slice(7)}</h1><button type="button" onclick="fetch('/api/stock?item=${url.pathname.slice(7)}')">Check stock</button>${advert}`));
        case "/items/drill":
          return html(200, page("drill", `<h1>drill</h1><button type="button" onclick="fetch('/api/stock?item=drill')">Check stock</button><button type="button" onclick="fetch('/api/reviews'); fetch('/cdn-cgi/rum', { method: 'POST', body: '{}' })">Reviews</button>`));
        case "/consent":
        case "/api/stock":
        case "/api/reviews":
        case "/entered-coupon":
          return res.writeHead(200, { "content-type": "application/json" }).end("{}");
        default:
          return html(404, page("Not found", "<h1>Not found</h1>"));
      }
    });
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  result = await scanSite({ startUrl: url, maxPages: 30, maxDurationMs: 150_000, delayMs: 0, maxButtonsPerPage: 6 });
}, 200_000);

afterAll(async () => {
  await new Promise<void>((resolve) => site?.close(() => resolve()));
  await new Promise<void>((resolve) => ads?.close(() => resolve()));
});

const events = <K extends CapturedEvent["kind"]>(kind: K) => result.events.filter((e): e is Extract<CapturedEvent, { kind: K }> => e.kind === kind);

describe("the learner on common web patterns", () => {
  it("says who it is, and reports the start page's status", () => {
    for (const { ua } of received) expect(ua).toMatch(/^Mozilla\/5\.0 .* ContextMachines\/0\.1 \(\+https:\/\/github\.com\/hughhellings\/contextmachines\)$/);
    expect(result.startStatus).toBe(200);
    expect(result.startError).toBeUndefined();
  });

  it("records only events the site model takes: nothing from a blank frame or an advert's frame", () => {
    expect(result.invalidEvents).toBe(0);
    const pages = [...events("route"), ...events("page")].map((e) => e.path);
    expect(pages.every((p) => p.startsWith("/") && !p.startsWith("//"))).toBe(true);
    expect(pages.some((p) => /blank|frame/.test(p))).toBe(false);
  });

  it("sends a classic form's save nowhere, records it as an action, and stays on the real page", () => {
    expect(received.filter((r) => r.method !== "GET")).toEqual([]);
    const save = events("network").find((e) => e.method === "POST" && e.path === "/contact/send");
    expect(save).toMatchObject({ trigger: { type: "submit", label: "Send message", page: "/contact" } });
    expect(Object.keys(save!.fields).sort()).toEqual(["email", "message"]);
    // The sidebar's sign-in, on every page, is learned once; each page's own form gets its turn.
    expect(events("network").filter((e) => e.path === "/signin")).toHaveLength(1);
    // Our answer is never a screen, nor photographed as one; the real form page is.
    expect(result.pagesVisited).not.toContain("/contact/send");
    expect(events("page").map((e) => e.path)).not.toContain("/contact/send");
    expect(result.screens.map((s) => s.path)).not.toContain("/contact/send");
    expect(result.screens.map((s) => s.path)).toContain("/contact");
  });

  it("leaves error pages and soft 404s out of the screens, and reports the links to them", () => {
    expect(result.errorPages).toEqual(expect.arrayContaining([{ path: "/gone", status: 404 }, { path: "/old-page", status: 200 }]));
    for (const missing of ["/gone", "/old-page"]) {
      expect(result.pagesVisited).not.toContain(missing);
      expect(events("page").map((e) => e.path)).not.toContain(missing);
      expect(result.screens.map((s) => s.path)).not.toContain(missing);
      expect(result.findings.find((f) => f.kind === "broken_link" && f.target === missing)).toMatchObject({ screen: "/" });
    }
    // Look-alikes that are real screens.
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/lost-and-found", "/reports/404-errors", "/app/inbox"]));
  });

  it("declines a cookie banner's optional cookies, never accepting them", () => {
    const choices = received.filter((r) => r.path === "/consent").map((r) => r.search);
    expect(choices).toContain("?choice=reject");
    expect(choices).not.toContain("?choice=accept");
  });

  it("reads a page whose security policy lets it talk only to itself", () => {
    expect(events("page").find((e) => e.path === "/account")?.snapshot.headings).toContain("Your account");
  });

  it("reads a page once it has drawn its content", () => {
    const late = events("page").filter((e) => e.path === "/late");
    expect(late.flatMap((e) => e.snapshot.headings)).toContain("Latest news");
  });

  it("sends a lone to-do box with Enter, and follows the link that appears; a box with its own button gets no Enter", () => {
    const todo = result.pagesVisited.filter((p) => p.startsWith("/todo"));
    expect(todo.some((p) => p.includes("active"))).toBe(true);
    expect(todo).toHaveLength(2); // "#/" is the list itself, not another screen
    expect(received.map((r) => r.path)).not.toContain("/entered-coupon");
  });

  it("sends two different forms that have no address and no field names, each once", () => {
    const saves = result.blockedWrites.map((w) => `${w.method} ${w.path}`);
    expect(saves).toContain("POST /api/join");
    expect(saves).toContain("POST /api/password");
  });

  it("presses through one of each kind of page, and doesn't wait on an advert that never stops loading", () => {
    const stock = received.filter((r) => r.path === "/api/stock").map((r) => r.search);
    // The hammer and the saw are made alike: only the first of them is pressed through.
    expect(stock.filter((s) => s === "?item=hammer" || s === "?item=saw").length > 0).toBe(true);
    expect(stock.includes("?item=hammer") && stock.includes("?item=saw")).toBe(false);
    // The drill page is made differently, so it is.
    expect(received.map((r) => r.path)).toContain("/api/reviews");
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/items/hammer", "/items/saw", "/items/drill"]));
    // What a CDN sends for itself as a press happens (its /cdn-cgi/ beacon) is no action of the product's.
    expect(events("network").filter((e) => e.path.startsWith("/cdn-cgi/"))).toEqual([]);
    // The ad-filled home page and item pages loaded without waiting out the 5s cap on each.
    expect(result.timings.load).toBeLessThan(result.pagesVisited.length * 2500);
  });
});

describe("where the learner stops", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const html = (status: number, body: string) => res.writeHead(status, { "content-type": "text/html" }).end(page(path, body));
      if (path === "/dead/") return html(404, "<h1>Not Found</h1><p>NoSuchBucket</p>");
      if (path === "/apps/one/") return html(200, `<h1>One</h1><a href="/apps/one/settings">Settings</a><a href="/apps/two/">Another app</a><a href="/">All apps</a><a href="/apps/one-more/">Look-alike folder</a>`);
      if (path === "/apps/one/settings") return html(200, "<h1>Settings</h1>");
      if (path === "/signin") return html(200, `<h1>Sign in</h1><a href="/pricing">Pricing</a><a href="/about/team">Team</a>`);
      if (path === "/feed.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><definitions name="Bank"><service name="Bank"/></definitions>`);
      if (path === "/data.json") return res.writeHead(200, { "content-type": "application/json" }).end(`{"accounts":[]}`);
      if (path === "/docs") return html(200, `<h1>Docs</h1><a href="/feed.xml">Service description</a><a href="/data.json">Data</a><a href="/guide">Guide</a>`);
      return html(200, `<h1>${path}</h1>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("keeps to the folder a start below \"/\" names, and says so", async () => {
    const r = await scanSite({ startUrl: `${base}/apps/one/`, delayMs: 0, maxDurationMs: 30_000, screenshots: false });
    expect(r.pagesVisited.sort()).toEqual(["/apps/one", "/apps/one/settings"]); // addresses are written without a last "/"
    expect(r.scope).toEqual({ path: "/apps/one/", skipped: 3 });
  }, 40_000);

  it("stops exploring when told to, and still returns what it learned", async () => {
    const stop = new AbortController();
    const r = await scanSite({ startUrl: `${base}/signin`, delayMs: 0, maxDurationMs: 30_000, screenshots: false, signal: stop.signal, onScreen: () => stop.abort() });
    expect(r.stoppedBy).toBe("interrupted");
    expect(r.pagesVisited).toEqual(["/signin"]);
    expect(r.events.some((e) => e.kind === "route" && e.path === "/signin")).toBe(true);
  }, 40_000);

  it("treats a start at a page, not a folder, as the whole site", async () => {
    const r = await scanSite({ startUrl: `${base}/signin`, delayMs: 0, maxDurationMs: 30_000, screenshots: false });
    expect(r.pagesVisited.sort()).toEqual(["/about/team", "/pricing", "/signin"]);
    expect(r.scope).toBeUndefined();
  }, 40_000);

  it("never makes a screen or a photo of a document that isn't a web page (a service's XML, a JSON file)", async () => {
    const r = await scanSite({ startUrl: `${base}/docs`, delayMs: 0, maxDurationMs: 30_000 });
    expect(r.pagesVisited.sort()).toEqual(["/docs", "/guide"]);
    expect(r.screens.map((s) => s.path).filter((p) => /feed|data/.test(p))).toEqual([]);
    expect(r.events.filter((e) => (e.kind === "page" || e.kind === "route") && /feed|data/.test(e.path))).toEqual([]);
    // A start that is such a document says so.
    const start = await scanSite({ startUrl: `${base}/feed.xml`, delayMs: 0, maxDurationMs: 20_000, screenshots: false });
    expect(start.pagesVisited).toEqual([]);
    expect(start.startStatus).toBe(200);
    expect(start.startPath).toBe("/feed.xml");
    expect(start.errors.join(" ")).toMatch(/isn't a web page \(application\/xml\)/);
  }, 60_000);

  it("reports a start page that answers with an error, and learns no screen from it", async () => {
    const r = await scanSite({ startUrl: `${base}/dead/`, delayMs: 0, maxDurationMs: 20_000, screenshots: false });
    expect(r.startStatus).toBe(404);
    // How the start went is told by its status and path, not by the screens learned (none).
    expect(r.startPath).toBe("/dead");
    expect(r.pagesVisited).toEqual([]);
    expect(r.events.filter((e) => e.kind === "route" || e.kind === "page")).toEqual([]);
  }, 30_000);

  it("reports a start page that can't be reached at all", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const r = await scanSite({ startUrl: `http://127.0.0.1:${port}/`, delayMs: 0, maxDurationMs: 20_000, screenshots: false });
    expect(r.startStatus).toBeUndefined();
    expect(r.startError).toMatch(/ERR_CONNECTION_REFUSED/);
  }, 30_000);
});

describe("the rules behind it", () => {
  it("scopes a start to the folder it names, or to the folder of its front door", () => {
    expect(scopeOf("/")).toBe("/");
    expect(scopeOf("/examples/react/dist/")).toBe("/examples/react/dist/");
    expect(scopeOf("/parabank/index.htm")).toBe("/parabank/");
    // A page is not a folder: a sign-in or dashboard address says nothing about where the app stops.
    expect(scopeOf("/app")).toBe("/");
    expect(scopeOf("/login")).toBe("/");
    expect(scopeOf("/dashboard")).toBe("/");
    expect(scopeOf("/a/b/page")).toBe("/");
    expect(scopeOf("/app/")).toBe("/app/");
    // A script that serves the whole app keeps to the script's folder, whatever page follows it.
    expect(scopeOf("/web/index.php/auth/login")).toBe("/web/");
    expect(scopeOf("/web/index.php")).toBe("/web/");
    expect(inScope("/app", "/app")).toBe(true);
    expect(inScope("/app/settings", "/app")).toBe(true);
    expect(inScope("/apple", "/app")).toBe(false);
    expect(inScope("/examples/react/dist", "/examples/react/dist/")).toBe(true);
    expect(inScope("/examples/vue/", "/examples/react/dist/")).toBe(false);
    expect(inScope("/anything", "/")).toBe(true);
  });

  it("knows a missing-page notice from a page that mentions one", () => {
    const short = { textLength: 120 };
    expect(saysMissing({ ...short, title: "Page Not Found | Acme", heading: "" })).toBe(true);
    expect(saysMissing({ ...short, title: "Acme", heading: "404" })).toBe(true);
    expect(saysMissing({ ...short, title: "Acme", heading: "Sorry, this page doesn't exist" })).toBe(true);
    expect(saysMissing({ ...short, title: "Acme", heading: "The page you're looking for can't be found" })).toBe(true);
    // Traps.
    expect(saysMissing({ ...short, title: "Lost and found | Acme", heading: "Lost and found" })).toBe(false);
    expect(saysMissing({ ...short, title: "Acme", heading: "404 errors this week" })).toBe(false);
    expect(saysMissing({ ...short, title: "Acme", heading: "Found 3 results" })).toBe(false);
    expect(saysMissing({ title: "Not found errors, explained", heading: "Not found errors, explained", textLength: 9000 })).toBe(false);
  });

  it("declines cookies in their common wordings, and never accepts optional ones", () => {
    for (const no of ["Reject all", "Reject optional", "Reject non-essential cookies", "Decline", "Decline all cookies", "Refuse", "Deny", "Only necessary", "Necessary cookies only", "Use necessary cookies only", "Only essential cookies", "Accept only essential cookies", "Strictly necessary only", "Continue without accepting", "No thanks", "Do not accept", "Do not consent", "Don't agree"]) {
      expect(DECLINE_COOKIES.test(no), no).toBe(true);
    }
    for (const yes of ["Accept optional", "Accept all", "Accept", "Allow all cookies", "Accept cookies", "Accept non-essential cookies", "OK", "Got it", "Manage preferences", "Cookie settings", "Agree and continue", "Consent", "Manage options"]) {
      expect(DECLINE_COOKIES.test(yes), yes).toBe(false);
    }
  });
});
