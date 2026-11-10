import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, json, pad, page, quick, serve } from "./precision-site.ts";

/**
 * Nothing that follows one of our made-up answers is proof about the site. Our reply has no slug, no
 * nested record: a person would get real ones. Each page here is fine for a person.
 */
const reads = (r: ScanResult) => r.events.flatMap((e) => (e.kind === "network" ? [`${e.method} ${e.path}`] : []));
let fake: ScanResult;
let kept: ScanResult;
let cookie: ScanResult;
let refused: ScanResult;
let sniffed: ScanResult;
const agents = new Set<string>();

beforeAll(async () => {
  const app = await serve((req, res, url) => {
    const p = url.pathname;
    if (p === "/api/items" && req.method === "GET") return json(res, []);
    if (p.startsWith("/api/items/")) return html(res, "<!doctype html><h1>Cannot GET</h1>", 404);
    if (p.startsWith("/api/detail")) return html(res, "<h1>boom</h1>", 500);
    if (p.startsWith("/items/")) return html(res, page("Not found", "<h1>Not found</h1>"), 404);
    html(res, page("Items", `<h1>Items</h1>${pad}<div id=out></div>
      <form id=f><label>Name <input name=name required></label><button>Add item</button></form>
      <script>f.onsubmit=async(e)=>{e.preventDefault();const r=await (await fetch('/api/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name.value})})).json();
      const a=document.createElement('a');a.href='/items/'+r.slug;a.textContent='View your new item';out.append(a);
      await fetch('/api/items/'+r.slug);await fetch('/api/detail?id='+r.id);}</script>`));
  });
  fake = await scanSite({ ...quick, startUrl: `http://localhost:${app}/` });

  // Signed-in state kept from a sign-in's reply, read by every page after.
  const guard = `<script>const u=localStorage.user&&JSON.parse(localStorage.user);if(u){document.title='Hi '+u.profile.name}</script>`;
  const shop = await serve((_req, res, url) => {
    if (url.pathname !== "/") return html(res, page(`Shop ${url.pathname}`, `<h1>${url.pathname}</h1>${pad}${guard}`));
    html(res, page("Shop", `<h1>Shop</h1>${pad}${guard}<a href="/about">About</a> <a href="/help">Help</a>
      <form id=f><label>Email <input type=email name=email required></label><button>Sign in</button></form>
      <script>f.onsubmit=async(e)=>{e.preventDefault();const r=await (await fetch('/api/session',{method:'POST',body:'{}'})).json();localStorage.user=JSON.stringify(r)}</script>`));
  });
  kept = await scanSite({ ...quick, startUrl: `http://localhost:${shop}/` });

  // The same, in a cookie a script set.
  const readCookie = `<script>const c=document.cookie.match(/profile=([^;]+)/);if(c){document.title='Hi '+JSON.parse(decodeURIComponent(c[1])).profile.name}</script>`;
  const jar = await serve((_req, res, url) => {
    if (url.pathname !== "/") return html(res, page(`Shop ${url.pathname}`, `<h1>${url.pathname}</h1>${pad}${readCookie}`));
    html(res, page("Shop", `<h1>Shop</h1>${pad}${readCookie}<a href="/about">About</a>
      <form id=f><label>Email <input type=email name=email required></label><button>Sign in</button></form>
      <script>f.onsubmit=async(e)=>{e.preventDefault();const r=await (await fetch('/api/session',{method:'POST',body:'{}'})).json();document.cookie='profile='+encodeURIComponent(JSON.stringify(r))+';path=/'}</script>`));
  });
  cookie = await scanSite({ ...quick, startUrl: `http://localhost:${jar}/` });

  // A session started with a hosted back end as the page loads, with no press: our refusal is what fails.
  const backend = await serve((_req, res) => void res.writeHead(200, { "access-control-allow-origin": "*" }).end("{}"));
  const hosted = await serve((_req, res, url) => {
    if (url.pathname === "/app.js") {
      return void res.writeHead(200, { "content-type": "text/javascript" }).end(`var x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:${backend}/rpc/start');x.onerror=function(){throw new Error('Could not start session')};x.send('{}');`);
    }
    html(res, page("Tasks", `<h1>Tasks</h1>${pad}<script src="/app.js"></script>`));
  });
  refused = await scanSite({ ...quick, startUrl: `http://localhost:${hosted}/` });

  // Reading the browser's version out of the User-Agent, as older bundles do.
  const old = await serve((req, res, url) => {
    agents.add(req.headers["user-agent"] ?? "");
    if (url.pathname === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`var v=navigator.userAgent.match(/Chrome\\/(\\d+)/)[1];document.title='Chrome '+v;`);
    html(res, page("Home", `<h1>Home</h1>${pad}<script src="/app.js"></script>`));
  });
  sniffed = await scanSite({ ...quick, startUrl: `http://localhost:${old}/` });
}, 120_000);

afterAll(closeAll);

describe("what follows a made-up answer", () => {
  it("is no failed request and no broken link, and its junk address is no read", () => {
    expect(fake.findings).toEqual([]);
    expect(reads(fake).filter((r) => /undefined|detail/.test(r) && r.startsWith("GET"))).toEqual([]);
    expect(fake.pagesVisited.filter((p) => p.includes("undefined"))).toEqual([]);
  });

  it("stored in localStorage, it crashes no later page: the storage is put back", () => {
    expect(kept.pagesVisited).toEqual(expect.arrayContaining(["/about", "/help"]));
    expect(kept.findings).toEqual([]);
  });

  it("stored in a cookie by a script, the same", () => {
    expect(cookie.pagesVisited).toContain("/about");
    expect(cookie.findings).toEqual([]);
  });

  it("a write to another host refused as the page loads is our doing, not the site crashing", () => {
    expect(refused.findings).toEqual([]);
  });
});

describe("the browser the site sees", () => {
  it("keeps the browser's own User-Agent, with ours after it", () => {
    expect(sniffed.findings).toEqual([]);
    expect([...agents].length).toBe(1);
    expect([...agents][0]).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+.* ContextMachines\/0\.1 \(\+https:\/\/github\.com\/hughhellings\/contextmachines\)$/);
  });
});
