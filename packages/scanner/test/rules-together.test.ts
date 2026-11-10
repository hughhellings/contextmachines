import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, json, pad, page, quick, serve } from "./precision-site.ts";

/**
 * Where the read-only rule, the rules about made-up answers and the exploring meet: each holds for
 * what the other two add, so a retried form, a held press and a moved start get no way round.
 */
const asked: string[] = [];
let retried: ScanResult;
let held: ScanResult;
let moved: ScanResult;
let created: ScanResult;
let kept: ScanResult;

beforeAll(async () => {
  // A form that turns a short code down, then sends a good one by GET: the corrected value is typed too.
  const claim = await serve((req, res, url) => {
    asked.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/claim") return json(res, { ok: true });
    html(res, page("Claim", `<h1>Claim a voucher</h1>${pad}<form id=f novalidate><label>Voucher <input name=voucher minlength=12 required></label><button>Claim voucher</button><p id=m></p></form>
      <script>f.onsubmit=(e)=>{e.preventDefault();if(!f.voucher.checkValidity()){m.textContent='That is too short';return}fetch('/api/claim?voucher='+encodeURIComponent(f.voucher.value))}</script>`));
  });
  retried = await scanSite({ ...quick, startUrl: `http://localhost:${claim}/` });

  // A held read's made-up reply, kept by the page: like any other, it's gone by the next page.
  const profile = await serve((_req, res, url) => {
    asked.push(`GET ${url.pathname}${url.search}`);
    if (url.pathname === "/api/me") return json(res, { name: "Jane" });
    if (url.pathname === "/api/greeting") return json(res, {});
    const button = url.pathname === "/" ? `<button onclick="fetch('/api/me').then(r=>r.json()).then(j=>localStorage.setItem('me',JSON.stringify(j)))">Delete account</button>` : `<button onclick="this.textContent='Shown'">Show help</button>`;
    html(res, page("Account", `<h1>Account ${url.pathname}</h1>${pad}<a href="/help">Help</a>${button}
      <script>fetch('/api/greeting?name='+JSON.parse(localStorage.getItem('me')||'{"name":"Guest"}').name)</script>`));
  });
  held = await scanSite({ ...quick, startUrl: `http://localhost:${profile}/` });

  // A pop-up's last step, whose dialog says what it does and whose button doesn't.
  const wizard = await serve((_req, res, url) => {
    asked.push(`GET ${url.pathname}`);
    if (url.pathname === "/x/7/go") return json(res, {});
    html(res, page("Workspace", `<h1>Workspace</h1>${pad}<button onclick="d.showModal()">Open settings</button>
      <dialog id=d><p>This will delete this workspace.</p><button onclick="setTimeout(()=>{fetch('/x/7/go');d.close()},60)">Continue</button></dialog>`));
  });
  await scanSite({ ...quick, startUrl: `http://localhost:${wizard}/` });

  // A step with nothing to fill, moved on from by its button: read before it fires too.
  const step = await serve((_req, res, url) => {
    asked.push(`GET ${url.pathname}`);
    if (url.pathname === "/y/7/go") return json(res, {});
    html(res, page("Setup", `<h1>Setup</h1>${pad}<button onclick="setTimeout(()=>fetch('/y/7/go'),60)">Continue and delete the old data</button>`));
  });
  await scanSite({ ...quick, startUrl: `http://localhost:${step}/` });

  // A start whose own address reads like a command: asked for by name, wherever it lands.
  const site = await serve((req, res, url) => {
    if (url.hostname.startsWith("acme.")) return void res.writeHead(301, { location: `http://www.acme.localhost:${url.port}${req.url}` }).end();
    html(res, page("Remove backgrounds", `<h1>Remove backgrounds</h1>${pad}<a href="/pricing">Pricing</a>`));
  });
  moved = await scanSite({ ...quick, startUrl: `http://acme.localhost:${site}/delete-background` });

  // --create lets a save through, and what the page sends by itself is still told apart from it.
  const tracked = await serve((req, res, url) => {
    if (req.method === "POST") return json(res, {});
    html(res, page("Notes", `<h1>Notes ${url.pathname}</h1>${pad}<script>fetch('/pageview',{method:'POST',body:'{}'})</script>`));
  });
  created = await scanSite({ ...quick, realWrites: true, startUrl: `http://localhost:${tracked}/` });

  // A sign-up sent by a keepalive GET: it looks like a beacon, and carries what was typed.
  const newsletter = await serve((_req, res, url) => {
    if (url.pathname === "/api/subscribe") return json(res, {});
    html(res, page("News", `<h1>News</h1>${pad}<form id=f><label>Email <input name=email type=email required></label><button>Subscribe</button></form>
      <script>f.onsubmit=(e)=>{e.preventDefault();fetch('/api/subscribe?email='+encodeURIComponent(f.email.value),{keepalive:true})}</script>`));
  });
  kept = await scanSite({ ...quick, startUrl: `http://localhost:${newsletter}/` });
}, 120_000);

afterAll(closeAll);

describe("the rules together", () => {
  it("a value a form was corrected to is typed too: the request carrying it never goes out", () => {
    expect(asked.filter((a) => a.startsWith("GET /api/claim"))).toEqual([]);
    expect(retried.blockedWrites.map((w) => w.path)).toContain("/api/claim");
  });

  it("a made-up answer to a held read is put away like any other", () => {
    expect(held.linksHeldBack.map((h) => h.why)).toContain("press");
    expect(asked).toContain("GET /api/greeting?name=Guest");
    expect(asked.filter((a) => a.startsWith("GET /api/greeting") && !a.endsWith("Guest"))).toEqual([]);
  });

  it("a pop-up's step is read before it fires, like any press", () => {
    expect(asked.filter((a) => a === "GET /x/7/go")).toEqual([]);
    expect(asked.filter((a) => a === "GET /y/7/go")).toEqual([]);
  });

  it("the start stays allowed after it lands on another address of the site", () => {
    expect(moved.pagesVisited).toContain("/delete-background");
    expect(moved.linksHeldBack.map((h) => h.path)).not.toContain("/delete-background");
  });

  it("with --create, what the page sends by itself isn't an action", () => {
    expect(created.ambientWrites.map((w) => [w.path, w.why])).toEqual([["/pageview", "unprompted"]]);
    expect(created.events.filter((e) => e.kind === "network" && e.method === "POST")).toEqual([]);
  });

  it("a keepalive read carrying what was typed is a save, not a beacon", () => {
    expect(kept.ambientWrites).toEqual([]);
    expect(kept.blockedWrites.map((w) => w.path)).toContain("/api/subscribe");
  });
});
