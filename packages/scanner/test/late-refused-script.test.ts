import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A widget's loader often asks for its script some time after the page has loaded: on a timer, when
 * the browser is idle, or on the first press. A local run refuses that script, so the button it would
 * have wired does nothing, and that is the run's doing, not the app's. Whenever the refusal comes, on
 * the first look or only on the careful second one, the button is never called dead. The real thing
 * stays found: a dead button on a page that asks for nothing of anyone else's, beside these pages
 * and on a run that has none of them, and beside a tag manager, a long timer, a carousel or a slow poll, which
 * put work off for ever and ask for nothing. Those are found about as fast as a page with nothing put off.
 * A loader that waits twice, with a script, a fetch, an image, an import or a message between, is
 * a loader too, as is one that counts its seconds with new Date(); a 1ms interval is a carousel.
 */
const pad = `<p>${"A page of the product with enough words of its own to be a screen worth learning, read and pressed. ".repeat(3)}</p>`;
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${pad}<a href="/reports">Reports</a> ${body}</body></html>`;
const WIDGET = "https://widget.example.invalid/chat.js";
/** The loader adds the widget's script, which would wire the button: refused, the button has no code at all. */
const addScript = `const s = document.createElement("script"); s.src = "${WIDGET}"; s.onload = () => { chat.onclick = () => document.body.append("Chat open"); }; document.head.appendChild(s);`;
const PAGES: Record<string, string> = {
  // On a timer after load, as a loader that waits for the page to be drawn first does.
  "/after-1s": page("Help one", `<button id="chat">Open chat</button><script>setTimeout(() => { ${addScript} }, 1000);</script>`),
  "/after-3s": page("Help three", `<button id="chat">Open chat</button><script>setTimeout(() => { ${addScript} }, 3000);</script>`),
  "/after-5s": page("Help five", `<button id="chat">Open chat</button><script>setTimeout(() => { ${addScript} }, 5000);</script>`),
  "/after-8s": page("Help eight", `<button id="chat">Open chat</button><script>setTimeout(() => { ${addScript} }, 8000);</script>`),
  // When the browser has nothing else to do (with a cap, as loaders give it).
  // On an interval that counts to its time, on a chain of short timers, and on animation frames
  // that watch the clock: a loader that polls for the page being ready.
  "/interval": page("Help interval", `<button id="chat">Open chat</button><script>let n = 0; const iv = setInterval(() => { if (++n * 500 >= 6000) { clearInterval(iv); ${addScript} } }, 500);</script>`),
  "/short-ticks": page("Help ticks", `<button id="chat">Open chat</button><script>let n = 0; (function tick() { if (++n * 50 >= 6000) { ${addScript} } else setTimeout(tick, 50); })();</script>`),
  "/frames": page("Help frames", `<button id="chat">Open chat</button><script>const t0 = performance.now(); (function f() { if (performance.now() - t0 > 6000) { ${addScript} } else requestAnimationFrame(f); })();</script>`),
  // A timer that asks the app for its settings first, and only then for the widget.
  "/after-fetch": page("Help settings", `<button id="chat">Open chat</button><script>setTimeout(() => fetch("/settings").then((r) => r.json()).then(() => { ${addScript} }), 4000);</script>`),
  // A worker of the page's own loads the widget's code, and tells the page when it's wired.
  "/worker": page("Help worker", `<button id="chat">Open chat</button><script>const w = new Worker("/worker.js"); w.onmessage = () => { chat.onclick = () => document.body.append("Chat open"); };</script>`),
  // Two waits with a step between, 5s each: the second is put off only once the first's step is done
  // (a "delay scripts" loader, a lazy module that waits again in its effect).
  "/two-stage": page("Help stage", `<button id="chat">Open chat</button><script>setTimeout(() => { const s = document.createElement("script"); s.src = "/stage.js"; document.head.appendChild(s); }, 5000);</script>`),
  "/fetch-then-wait": page("Help fetch wait", `<button id="chat">Open chat</button><script>setTimeout(() => fetch("/settings").then((r) => r.text()).then(() => setTimeout(() => { ${addScript} }, 5000)), 5000);</script>`),
  "/import-then-wait": page("Help lazy", `<button id="chat">Open chat</button><script>setTimeout(() => import("/lazy.mjs"), 5000);</script>`),
  "/message-then-wait": page("Help message", `<button id="chat">Open chat</button><script>setTimeout(() => { const c = new MessageChannel(); c.port1.onmessage = () => setTimeout(() => { ${addScript} }, 5000); c.port2.postMessage(0); }, 5000);</script>`),
  "/image-then-wait": page("Help image", `<button id="chat">Open chat</button><script>setTimeout(() => { const i = new Image(); i.onload = i.onerror = () => setTimeout(() => { ${addScript} }, 5000); i.src = "/pixel.gif"; }, 5000);</script>`),
  // An interval that counts its seconds with new Date(), not Date.now().
  "/new-date": page("Help date", `<button id="chat">Open chat</button><script>const t0 = new Date(); const iv = setInterval(() => { if (new Date() - t0 > 6000) { clearInterval(iv); ${addScript} } }, 500);</script>`),
  "/idle": page("Help idle", `<button id="chat">Open chat</button><script>requestIdleCallback(() => { ${addScript} }, { timeout: 2000 });</script>`),
  // On the first press: the button's own handler fetches the code it needs.
  "/on-press": page("Help press", `<button id="chat">Open chat</button><script>chat.addEventListener("click", () => { ${addScript} }, { once: true });</script>`),
  "/on-press-import": page("Help import", `<button id="chat">Open chat</button><script>chat.addEventListener("click", () => import("${WIDGET}").then((m) => m.open()).catch(() => {}));</script>`),
  // Once a visit: asked for on the first load only, so the second look's fresh load never asks.
  "/once-a-visit": page("Help once", `<button id="chat">Open chat</button><script>if (!sessionStorage.getItem("chat-asked")) { sessionStorage.setItem("chat-asked", "1"); ${addScript} }</script>`),
  // A frame the widget draws itself in asks for it, late: the page's button talks to that frame.
  "/in-frame": page("Help frame", `<button id="chat">Open chat</button><iframe id="box"></iframe><script>setTimeout(() => { const d = box.contentDocument; const s = d.createElement("script"); s.src = "${WIDGET}"; d.head.appendChild(s); }, 2000);</script>`),
  // A frame of the app's own whose own timer asks for the widget late: the page's button talks to it.
  "/frame-timer": page("Help frame timer", `<button id="chat">Open chat</button><iframe id="box" src="/widget-frame"></iframe>`),
  // A tag manager's container, kept away: the tags it would add (a chat widget among them) are never
  // asked for at all, and the button only tells it that it was pressed.
  "/tag-manager": page("Help tags", `<button id="chat" onclick="dataLayer.push({ event: 'open_chat' })">Open chat</button><script>window.dataLayer = window.dataLayer || [];</script><script async src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST1"></script>`),
  // Nothing of anyone else's, and a button with no code behind it at all.
  "/reports": page("Reports", `<button id="export">Export</button>`),
  // The same, beside a tag manager the run kept away: the button tells it nothing, so it's dead.
  "/tagged": page("Tagged", `<button id="send">Send report</button><script>window.dataLayer = window.dataLayer || [];</script><script async src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST2"></script>`),
  // The same, with the page putting off work of its own that asks for nothing: still dead.
  "/timed": page("Timed", `<button id="send">Send report</button><script>setTimeout(() => { document.title = "Timed"; }, 4000); requestIdleCallback(() => {});</script>`),
  // An analytics tag alone (from the same host as the tag manager), kept away: it adds no code to a
  // button, so a dead one beside it is still dead.
  "/measured": page("Measured", `<button id="send">Send report</button><script>window.dataLayer = window.dataLayer || []; function gtag() { dataLayer.push(arguments); }</script><script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST1"></script>`),
};
/** Not a screen: the frame /frame-timer draws, which asks for the widget on a timer of its own. */
const FRAME = `<!doctype html><html><body><script>setTimeout(() => { ${addScript} }, 9000);</script></body></html>`;
/** The worker /worker starts: it loads the widget's code before it says it's ready. */
const WORKER = `importScripts("https://widget.example.invalid/lib.js"); postMessage("ready");`;
/** What /two-stage and /import-then-wait load first: it waits again before it adds the widget. */
const STAGE = `setTimeout(() => { ${addScript} }, 5000);`;
/**
 * Dead buttons beside work a page puts off and never stops putting off, asking for nothing: a long
 * timer (a toast, a session's warning), a carousel, a slow poll of the app's own. Each is found in
 * about the time a page with nothing put off takes, beside it: waiting the work out would take most
 * of 12 seconds more, and cut a short run off before the button was told.
 */
const STEADY: Record<string, string> = {
  "/long-timer": page("Long timer", `<button id="send">Send report</button><script>setTimeout(() => {}, 11500);</script>`),
  "/carousel": page("Carousel", `<button id="send">Send report</button><div id="slide">Slide 0</div><script>let i = 0; (function next() { setTimeout(() => { slide.textContent = "Slide " + (++i % 3); next(); }, 4000); })();</script>`),
  "/poll": page("Poll", `<button id="send">Send report</button><script>(function poll() { setTimeout(() => fetch("/settings").then(() => poll()), 10000); })();</script>`),
  // An interval every millisecond, for ever: thousands of runs in 15s, and still only itself.
  "/busy": page("Busy", `<button id="send">Send report</button><script>let x = 0; setInterval(() => { x++; }, 1);</script>`),
};
/**
 * A page run ahead (a dead button beside a timer of 12s, which only a run ahead fires), then a page
 * of the app's own whose script throws as it loads, once that timer has told the app it ran: the
 * next page is loaded within moments of the run ahead, and what's left out after one is that
 * page's, so the next page's crash is found.
 */
const THEN_CRASH = `<!doctype html><html><head><title>Run ahead</title></head><body><h1>Run ahead</h1>${pad}<a href="/broken">Broken</a> <button id="send">Send report</button><script>setTimeout(() => fetch("/ran-ahead"), 12000);</script></body></html>`;
const BROKEN = `<!doctype html><html><head><title>Broken</title></head><body><h1>Broken</h1>${pad}<script src="/broken.js"></script></body></html>`;
const DEAD = ["/reports", "/timed", "/measured", "/tagged"];
const TRAPS = Object.keys(PAGES).filter((p) => !DEAD.includes(p));

let app: http.Server;
let ranAhead = false;
let base: string;
const scan = (start: string) => scanSite({ startUrl: start, stayLocal: true, maxPages: 2, maxDurationMs: 120_000, delayMs: 0, screenshots: false });
const deadButtons = (result: ScanResult) => result.findings.filter((f) => f.kind === "does_nothing").map((f) => `${f.screen} ${f.target}`);

const results = new Map<string, ScanResult>();
let alone: ScanResult;
const dead = new Map<string, ScanResult>();
const steady = new Map<string, { result: ScanResult; ms: number }>();
let controlMs = 0;
let thenCrash: ScanResult;

beforeAll(async () => {
  app = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/settings") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (path === "/worker.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(WORKER);
    if (path === "/stage.js" || path === "/lazy.mjs") return void res.writeHead(200, { "content-type": "text/javascript" }).end(STAGE);
    if (path === "/ran-ahead") ranAhead = true;
    if (path === "/ran-ahead") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (path === "/broken.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(ranAhead ? `null.boom();` : "");
    if (path === "/pixel.gif") return void res.writeHead(200, { "content-type": "image/gif" }).end("GIF89a");
    if (path === "/then-crash") return void res.writeHead(200, { "content-type": "text/html" }).end(THEN_CRASH);
    if (path === "/broken") return void res.writeHead(200, { "content-type": "text/html" }).end(BROKEN);
    const body = path === "/widget-frame" ? FRAME : PAGES[path] ?? STEADY[path];
    if (!body) return void res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title>");
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const timedRun = async (path: string) => {
    const began = Date.now();
    const result = await scanSite({ startUrl: `${base}${path}`, stayLocal: true, maxPages: 1, maxDurationMs: 120_000, delayMs: 0, screenshots: false });
    return { result, ms: Date.now() - began };
  };
  const [runs, deads, steadies, crashed] = await Promise.all([
    Promise.all([...TRAPS.map((p) => scan(`${base}${p}`)), scan(`${base}/reports`)]),
    Promise.all(DEAD.slice(1).map((p) => scan(`${base}${p}`))),
    Promise.all([...Object.keys(STEADY), "/reports"].map(timedRun)),
    scan(`${base}/then-crash`),
  ]);
  thenCrash = crashed;
  TRAPS.forEach((p, i) => results.set(p, runs[i]!));
  alone = runs[TRAPS.length]!;
  DEAD.slice(1).forEach((p, i) => dead.set(p, deads[i]!));
  Object.keys(STEADY).forEach((p, i) => steady.set(p, steadies[i]!));
  controlMs = steadies[Object.keys(STEADY).length]!.ms;
}, 400_000);

afterAll(() => {
  app.closeAllConnections();
  app.close();
});

describe("a widget's script a local run refused, asked for after the page loaded", () => {
  for (const trap of TRAPS) {
    it(`doesn't call its button dead (${trap})`, () => {
      const result = results.get(trap)!;
      expect(result.stoppedBy).toBe("complete");
      expect(result.stayedAway).toContain(trap === "/tag-manager" ? "www.googletagmanager.com" : "widget.example.invalid");
      expect(deadButtons(result).filter((d) => d.startsWith(`${trap} `))).toEqual([]);
      expect(result.findings.filter((f) => f.screen === trap)).toEqual([]);
    });

    it(`still finds the dead button on the page that asked for nothing (${trap})`, () => {
      const result = results.get(trap)!;
      expect(result.pagesVisited).toContain("/reports");
      expect(deadButtons(result)).toContain("/reports Export");
    });
  }

  it("finds a dead button on a run with no refused script at all", () => {
    expect(alone.stoppedBy).toBe("complete");
    expect(alone.stayedAway ?? []).toEqual([]);
    expect(deadButtons(alone)).toEqual(["/reports Export"]);
  });

  it("finds a dead button on a page that puts off work of its own and asks for nothing of anyone else's", () => {
    const timed = dead.get("/timed")!;
    expect(timed.stoppedBy).toBe("complete");
    expect(timed.stayedAway ?? []).toEqual([]);
    expect(deadButtons(timed)).toContain("/timed Send report");
  });

  it("finds a dead button beside an analytics tag the run kept away", () => {
    const measured = dead.get("/measured")!;
    expect(measured.stoppedBy).toBe("complete");
    expect(measured.stayedAway).toContain("www.googletagmanager.com");
    expect(deadButtons(measured)).toContain("/measured Send report");
  });

  it("finds a dead button beside a tag manager the run kept away, when the press tells it nothing", () => {
    const tagged = dead.get("/tagged")!;
    expect(tagged.stoppedBy).toBe("complete");
    expect(tagged.stayedAway).toContain("www.googletagmanager.com");
    expect(deadButtons(tagged)).toContain("/tagged Send report");
  });

  it("finds a crash on the page after one that was run ahead", () => {
    expect(deadButtons(thenCrash)).toContain("/then-crash Send report");
    expect(thenCrash.findings.filter((f) => f.kind === "crashes").map((f) => f.screen)).toEqual(["/broken"]);
  });

  for (const path of Object.keys(STEADY)) {
    it(`finds a dead button beside work put off for ever, without waiting it out (${path})`, () => {
      const { result, ms } = steady.get(path)!;
      expect(result.stoppedBy).toBe("max_pages");
      expect(deadButtons(result)).toEqual([`${path} Send report`]);
      expect(ms).toBeLessThan(controlMs + 5000);
    });
  }
});
