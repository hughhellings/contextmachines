import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, pad, page, quick, serve } from "./precision-site.ts";

/**
 * A write is someone's action only if the press explains it: every real site sends trackers after
 * every press, and they aren't what people came to do. And a save to a back end on another domain
 * is a save like any other, stopped in the browser.
 */
const saves = (r: ScanResult) => r.blockedWrites.map((w) => `${w.method} ${w.path}`);
const actions = (r: ScanResult) => r.events.flatMap((e) => (e.kind === "network" && e.method !== "GET" ? [`${e.method} ${e.path}`] : []));
let noisy: ScanResult;
let hosted: ScanResult;
const reachedBackend: string[] = [];
let backendHost = "";

beforeAll(async () => {
  // Every press, every page: a tracker. One real form save, which the tracker follows too.
  const track = `<script>addEventListener('click',()=>{fetch('/collect',{method:'POST',body:'{"e":"click"}'});navigator.sendBeacon('/beacon','x');fetch('/rum',{method:'POST',keepalive:true,body:'{}'})},true);
    fetch('/pageview',{method:'POST',body:'{}'});fetch('/cdn-cgi/challenge-platform/h/g/jsd/oneshot',{method:'POST',body:'x'})</script>`;
  const nav = `<a href="/one">One</a> <a href="/two">Two</a> <a href="/three">Three</a>`;
  const site = await serve((_req, res, url) => {
    const home = url.pathname === "/";
    const buttons = ["Show tips", "Show help", "Show news"].map((b) => `<button onclick="tips.textContent='${b}'">${b}</button>`).join(" ");
    const form = `<form id=f onsubmit="event.preventDefault();fetch('/api/invoices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client:this.client.value})})"><label>Client <input name=client required></label><button>Add invoice</button></form>`;
    html(res, page(`Page ${url.pathname}`, `<h1>Page ${url.pathname}</h1>${pad}${nav}<div id=tips></div>${home ? buttons + form : ""}${track}`));
  });
  // Long enough that every button on the home page gets its turn: pages share the run's time.
  noisy = await scanSite({ ...quick, maxDurationMs: 60_000, startUrl: `http://localhost:${site}/` });

  // The page's store on another domain, as xyz.supabase.co is from app.acme.com.
  const backend = await serve((req, res) => {
    if (req.method !== "OPTIONS" && req.method !== "GET") reachedBackend.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }).end("[]");
  });
  backendHost = `127.0.0.1:${backend}`;
  const app = await serve((_req, res) => html(res, page("Tasks", `<h1>Tasks</h1>${pad}<form id=f><label>Task <input name=task required></label><button>Add task</button></form><ul id=l></ul>
    <script>f.onsubmit=async(e)=>{e.preventDefault();const r=await fetch('http://${backendHost}/rest/v1/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:f.task.value})});if(r.ok)l.innerHTML+='<li>added</li>';else throw new Error('Could not add')}</script>`)));
  hosted = await scanSite({ ...quick, startUrl: `http://localhost:${app}/` });
}, 90_000);

afterAll(closeAll);

describe("what the page sends by itself", () => {
  it("the real form save stays a save and an action", () => {
    expect(saves(noisy)).toContain("POST /api/invoices");
    expect(actions(noisy)).toContain("POST /api/invoices");
  });

  it("trackers, beacons and page-view writes are kept out of the actions and the saves", () => {
    for (const path of ["/collect", "/beacon", "/rum", "/pageview"]) {
      expect(saves(noisy)).not.toContain(`POST ${path}`);
      expect(actions(noisy)).not.toContain(`POST ${path}`);
    }
  });

  it("and counted apart, each with why", () => {
    const why = new Map(noisy.ambientWrites.map((w) => [w.path, w.why]));
    expect(why.get("/collect")).toBe("repeats");
    expect(why.get("/beacon")).toBe("beacon");
    expect(why.get("/rum")).toBe("beacon");
    expect(why.get("/pageview")).toBe("unprompted");
    expect(noisy.ambientWrites.find((w) => w.path === "/collect")!.count).toBeGreaterThanOrEqual(3);
  });

  it("a CDN's own beacons count apart too, never as saves", () => {
    expect(saves(noisy).filter((s) => s.includes("cdn-cgi"))).toEqual([]);
    expect(noisy.ambientWrites.filter((w) => w.why === "cdn").length).toBeGreaterThan(0);
  });
});

describe("a back end on another domain", () => {
  it("is a stopped save, recorded with its host and its button", () => {
    expect(saves(hosted)).toEqual([`POST //${backendHost}/rest/v1/items`]);
    expect(actions(hosted)).toEqual([`POST //${backendHost}/rest/v1/items`]);
    expect(hosted.events.flatMap((e) => (e.kind === "network" && e.method === "POST" ? [e.trigger?.label] : []))).toEqual(["Add task"]);
  });

  it("never leaves the browser, and the page carries on", () => {
    expect(reachedBackend).toEqual([]);
    expect(hosted.findings).toEqual([]);
  });
});
