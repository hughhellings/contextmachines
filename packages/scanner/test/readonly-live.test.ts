import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { page, startRecordingSite, type RecordingSite } from "./readonly-app.ts";

/**
 * No connection may exist that can't be filtered. context.routeWebSocket never reaches a dedicated
 * worker, so every worker starts with a WebSocket that never connects, whatever kind of worker it is.
 * A worker's other requests still pass the route, its relative imports still work, and what's
 * taken away (WebTransport, WebRTC, SharedWorker, service workers) leaves a page working, with no issue reported.
 */
const socketLine = (via: string) => `try{const s=new WebSocket("ws://"+location.host+"/ws");s.onopen=()=>s.send("${via}");s.onclose=()=>postMessage("closed:${via}")}catch(e){postMessage("threw:${via}")}`;
let site: RecordingSite;
let result: ScanResult;
const reports: string[] = [];

beforeAll(async () => {
  site = await startRecordingSite((_req, res, url) => {
    const js = (body: string) => void res.writeHead(200, { "content-type": "text/javascript" }).end(body);
    if (url.pathname === "/told") {
      reports.push(url.searchParams.get("what") ?? "");
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (url.pathname === "/workers/classic.js") return js(`importScripts("helper.js");${socketLine("classic")};fetch("/api/save",{method:"POST",body:"from worker"});postMessage("helper:"+helper);`);
    if (url.pathname === "/workers/helper.js") return js(`self.helper=1;`);
    if (url.pathname === "/workers/module.js") return js(`import "./dep.js";postMessage("module ran");`);
    if (url.pathname === "/workers/dep.js") return js(socketLine("module-dep"));
    res.writeHead(200, { "content-type": "text/html" }).end(page("Live", `<button id="del">Delete</button><script>
      const tell = (r) => fetch("/told?what=" + encodeURIComponent(r));
      const blob = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
      const start = (url, options) => { const w = new Worker(url, options); w.onmessage = (e) => tell(String(e.data)); w.onerror = (e) => tell("error:" + e.message); return w; };
      start("/workers/classic.js");
      start("/workers/module.js", { type: "module" });
      start(blob(${JSON.stringify(socketLine("blob"))}));
      start("data:text/javascript," + encodeURIComponent(${JSON.stringify(socketLine("data"))}));
      start(blob(${JSON.stringify(socketLine("blob-module"))}), { type: "module" });
      start(blob('new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(${JSON.stringify(socketLine("nested"))}) + '],{type:"text/javascript"})))'));
      const f = document.createElement("iframe"); document.body.append(f);
      start.call(null, blob(${JSON.stringify(socketLine("frame"))}));
      new f.contentWindow.Worker(blob(${JSON.stringify(socketLine("frame-worker"))}));
      tell("gone:" + [typeof WebTransport, typeof RTCPeerConnection, typeof SharedWorker, typeof WebSocketStream].join());
      navigator.serviceWorker.register("/sw.js").catch(() => {});
      if (typeof WebTransport !== "undefined") new WebTransport("https://" + location.host + "/wt");
      new WebSocket("ws://" + location.host + "/items/7/delete");
      new WebSocket("ws://" + location.host + "/live?token=abc");
      del.onclick = () => { const w = new Worker(blob("onmessage=(e)=>{" + ${JSON.stringify(socketLine("after-press"))} + "}")); w.postMessage("go"); };
    </script>`));
  }, (request) => /^GET /.test(request));
  result = await scanSite({ startUrl: site.url, maxPages: 2, maxDurationMs: 25_000, delayMs: 0, screenshots: false });
}, 60_000);

afterAll(() => site.close());

describe("workers and live connections", () => {
  it("no message reaches the server from a worker of any kind", () => {
    expect(site.messages).toEqual([]);
  });

  it("opening a socket is a request like any other: one that commands is never opened, and a signed one is", () => {
    expect(site.sockets).toContain("/live?token=abc");
    expect(site.sockets.filter((s) => s.includes("delete"))).toEqual([]);
  });

  it("a worker's socket fails like one on a network that blocks them, and the worker runs on", () => {
    expect(reports).toEqual(expect.arrayContaining(["closed:classic", "closed:module-dep", "closed:blob", "closed:data", "closed:blob-module"]));
    expect(reports.filter((r) => r.startsWith("threw:") || r.startsWith("error:"))).toEqual([]);
  });

  it("a file worker keeps its own address, so its relative imports work, and the mark never reaches the server", () => {
    expect(reports).toEqual(expect.arrayContaining(["helper:1", "module ran"]));
    expect(site.requests).toEqual(expect.arrayContaining(["GET /workers/classic.js", "GET /workers/helper.js", "GET /workers/module.js", "GET /workers/dep.js"]));
    expect(site.requests.filter((r) => r.includes("ctx-stub"))).toEqual([]);
  });

  it("a worker's requests still pass the route", () => {
    expect(site.changes().filter((c) => c.includes("/api/save"))).toEqual([]);
    // Stopped, and filed with what the page sends by itself: nothing pressed explains it.
    expect([...result.blockedWrites, ...result.ambientWrites].some((w) => w.path === "/api/save")).toBe(true);
  });

  it("takes away what can't be filtered, service workers included, and blames the page for none of it", () => {
    expect(reports).toContain("gone:undefined,undefined,undefined,undefined");
    expect(site.requests.filter((r) => r.includes("/sw.js"))).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});
