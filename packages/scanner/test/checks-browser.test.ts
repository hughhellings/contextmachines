import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult, type ScreenCheck } from "../src/scan.ts";

/**
 * Each check against the real browser: a page with the real thing on it, and beside it pages with
 * what could be taken for it. Nothing here is told what's on these pages: every item comes from
 * a measurement, and every trap page must come back with nothing at all.
 */
const page = (title: string, body: string, head = "", meta = '<meta name="viewport" content="width=device-width, initial-scale=1">') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${meta}${head}<style>body{margin:0;font-family:Arial,sans-serif}</style></head><body><h1>${title}</h1>${body}</body></html>`;

const clip = "display:block;width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const railItem = "display:flex;align-items:center;gap:8px;box-sizing:border-box;width:32px;height:32px;padding:8px;overflow:hidden";
const railWords = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const strip = "display:flex;overflow:hidden;min-width:0;flex:1";
const tab = 'style="flex:0 0 120px"';
const tabs = ["Overview", "Members", "Billing", "Security", "Exports"].map((label) => `<a href="/clean" ${tab}>${label}</a>`).join("");
const buttonTabs = ["Overview", "Members", "Billing", "Security", "Exports"].map((label) => `<button ${tab}>${label}</button>`).join("");
const filler = "<p>Words on the page so it is one, with enough of them to read as a page of the product.</p>".repeat(3);
const bottomBar = (words: string) => `<div style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#222;color:#fff">${words}</div>`;

const pages: Record<string, string> = {
  "/clean": page("Clean", `<nav><a href="/clean2">Reports</a></nav><main>${filler}<form><label>Name <input name="n"></label><button>Save</button></form><img src="/ok.svg" alt="" width="20" height="20"></main>`),
  "/clean2": page("Clean two", `<main>${filler}<button>Next</button><p>1 trade so far</p></main>`),

  "/cut": page("Cut", `<nav><a href="/clean" style="${clip}">Backtesting sessions</a></nav><main>${filler}<button style="${clip}">Export everything</button></main>`),
  "/cut-traps": page("Cut traps", `
    <style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}</style>
    <button><span class="sr">Open the main menu for this page</span><svg width="20" height="20"></svg></button>
    <button style="position:relative;overflow:hidden;width:90px">Ripple<span style="position:absolute;left:0;top:0;width:300px;height:40px"></span></button>
    <aside style="width:60px;overflow:hidden"><a href="/clean" style="display:block;white-space:nowrap">Reports and everything else</a></aside>
    <aside><a href="/clean" style="${clip}">someone@example.test</a></aside>
    <nav><a href="/clean" style="${clip}" title="Backtesting sessions">Backtesting sessions</a></nav>
    <table><tr><td><a href="/clean" style="${clip}">A very long customer name</a></td></tr></table>
    <nav style="width:48px"><a href="/clean" style="${railItem}"><svg width="16" height="16" style="flex-shrink:0"></svg><span style="${railWords}">Dashboard</span></a></nav>
    <aside style="width:48px"><a href="/clean" style="${railItem}"><svg width="16" height="16" style="flex-shrink:0"></svg><span style="${railWords}">Customers</span></a></aside>
    <div style="width:48px"><button style="${railItem};border:0"><svg width="16" height="16" style="flex-shrink:0"></svg><span style="${railWords}">Playground</span><svg width="16" height="16" style="flex-shrink:0"></svg></button></div>
    <main>${filler}<a href="/clean" style="${clip}">A long article title in the page</a></main>`),

  "/covered": page("Covered", `<main>${filler}<textarea aria-label="Message box" style="position:fixed;left:40px;bottom:20px;width:400px;height:40px"></textarea></main>${bottomBar("Our help bar")}`),
  "/half": page("Half covered", `<main>${filler}</main><input aria-label="Ask anything" style="position:fixed;left:100px;right:100px;width:800px;bottom:60px;height:60px;box-sizing:border-box"><div style="position:fixed;left:60px;width:900px;bottom:0;height:80px;background:#222;color:#fff">Our help bar</div>`),
  "/covered-traps": page("Covered traps", `
    <main>${filler.repeat(10)}<label>Near the end <input name="scrolled"></label>${filler.repeat(10)}</main>
    <div style="position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none"><div style="position:fixed;left:0;right:0;top:300px;height:200px;pointer-events:none">A ghost layer</div></div>
    ${bottomBar("A bar a person can scroll a field out from under")}`),
  "/dialog": page("A dialog", `<main>${filler}<input aria-label="Behind the dialog" style="position:fixed;left:40px;top:300px;width:300px"></main><div role="dialog" aria-modal="true" style="position:fixed;left:0;top:200px;width:500px;height:200px;background:#fff">Are you sure about all of this?</div>`),
  "/toast": page("A toast", `<main>${filler}<input aria-label="Under the toast" style="position:fixed;left:40px;bottom:30px;width:300px"></main><div id="t" style="position:fixed;left:0;bottom:0;width:500px;height:90px;background:#222">Saved</div><script>setTimeout(()=>document.getElementById("t").remove(),1500)</script>`),
  "/closable": page("A closable panel", `<main>${filler}<input aria-label="Under the panel" style="position:fixed;left:40px;bottom:30px;width:300px"></main><div style="position:fixed;left:0;bottom:0;width:500px;height:90px;background:#222">Dev tools<button>×</button></div>`),
  "/inside": page("Inside the bar", `<main>${filler}</main><div style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#222"><input aria-label="Its own field" style="margin:20px;width:300px"></div>`),

  "/wording": page("Wording", `<main>${filler}<p>Based on <b>1</b> closed trades</p><p>1 items</p><table><tr><td>undefined</td></tr></table><p>Total: $NaN</p><p>Group: [object Object]</p><p>Hello {name}</p></main>`),
  "/wording-traps": page("Wording traps", `<main>${filler}<p>1 of 3 items</p><p>Tier 1 customers</p><p>1 day trades</p><p>NAN</p><p>Nan Goldin</p><div style="display:flex;flex-direction:column"><span>1</span><span>trades</span></div><input value="undefined" aria-label="a"><textarea aria-label="b">1 items and {name}</textarea><p style="display:none">undefined</p></main>`),
  "/docs": page("Docs", `<main>${filler}<p>Pass <code>null</code> to clear it.</p><p>null</p><table><tr><td>undefined</td></tr></table><p>Use {{name}} to insert it.</p></main>`),
  "/flicker": page("Flicker", `<main>${filler}<p id="v">$NaN</p></main><script>setTimeout(()=>{document.getElementById("v").textContent="$12"},1500)</script>`),

  "/wide": page("Wide", `<main>${filler}<div style="width:900px;background:#eee">A row that never learned to wrap</div></main>`),
  "/wide-traps": page("Wide traps", `<main>${filler}<div style="overflow-x:auto"><table style="width:900px"><tr><td>A wide table in a box of its own</td></tr></table></div></main>
    <div style="position:fixed;top:0;right:0;width:300px;height:100%;transform:translateX(100%)"><a href="/clean">In a closed drawer</a></div>`),
  "/not-for-phones": page("No viewport", `<main>${filler}<div style="width:900px">A page that never said it fits a phone</div></main>`, "", ""),
  "/slides": page("Slides", `<style>html{overflow-x:hidden}</style><main>${filler}<div class="carousel" style="display:flex;overflow:hidden;width:100%"><div style="flex:0 0 100%"><a href="/clean">One</a></div><div style="flex:0 0 100%"><a href="/clean2">Two</a></div></div></main>
    <div style="position:absolute;top:0;left:100%;width:300px"><a href="/cut">In a drawer moved off</a></div>`),
  "/no-reach": page("No reach", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div style="display:flex;width:1100px;justify-content:space-between"><span>Left</span><a href="/clean">Pay this invoice</a></div></main>`),

  "/arrows": page("Arrows", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div style="display:flex;align-items:center"><button onclick="s.scrollLeft-=120">Back</button><div id="s" style="${strip}">${tabs}</div><button onclick="s.scrollLeft+=120">Next</button></div></main>`),
  "/no-arrows": page("No arrows", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div style="display:flex"><div style="${strip}">${tabs}</div></div></main>`),

  "/arrows-wrapped": page("Arrows wrapped", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div style="display:flex;align-items:center"><div><button onclick="w.scrollLeft-=120">Back</button></div><div id="w" style="${strip}">${tabs}</div><div><button onclick="w.scrollLeft+=120">Next</button></div></div></main>`),
  "/arrows-below": page("Arrows below", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div><div id="b" style="display:flex;overflow:hidden">${tabs}</div><div style="text-align:right"><button onclick="b.scrollLeft-=120">Back</button><button onclick="b.scrollLeft+=120">Next</button></div></div></main>`),
  "/arrows-over": page("Arrows over", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div id="o" style="position:relative;display:flex;overflow:hidden">${tabs}<button onclick="o.scrollLeft+=120" style="position:absolute;right:0;top:0">Next</button></div></main>`),
  "/button-tabs": page("Button tabs", `<style>html,body{overflow-x:hidden}</style><main>${filler}<div style="display:flex"><div style="${strip}">${buttonTabs}</div></div></main>`),
  "/clipped-root": page("Clipped root", `<style>html,body{overflow-x:hidden}</style><div id="app" style="overflow-x:hidden"><main>${filler}<button>Save</button><div style="display:flex;width:1100px;justify-content:space-between"><span>Left</span><a href="/clean">Pay this invoice</a></div></main></div>`),
  "/clipped-card": page("Clipped card", `<style>html,body{overflow-x:hidden}</style><main>${filler}<section style="overflow:hidden;border:1px solid #ccc"><button>Refresh</button><div style="display:flex;width:1100px;justify-content:space-between"><span>Left</span><a href="/clean">Pay this invoice</a></div></section><button>Keep going</button></main>`),

  "/steps": page("Steps", `<main>${filler}<h2><span>1</span> Details</h2><h2><span>2</span> Shipping</h2><h2><span>3</span> Payment</h2></main>`),

  "/rows": page("Rows", `<main>${filler}<p>A sentence the app says about its customers, for anyone reading it.</p>
    <table><thead><tr><th>Customer</th></tr></thead><tbody><tr><th scope="row">Ada Whitfield</th><td>Jane Whitfield</td><td><a href="/clean">Acme Ltd</a></td><td>Pro plan</td></tr></tbody></table>
    <div role="grid"><div role="row"><div role="gridcell">Grid Person</div></div></div><div role="table"><div role="row"><div role="cell">Cell Person</div></div></div></main>`),

  "/status-rows": page("Status rows", `<main>${filler}<p>Upgrade to Team to see the rest</p><p>No exports yet</p>
    <div role="table"><div role="row"><div role="cell">Jane Doe</div><div role="cell">Pro plan</div></div><div role="row"><div role="cell">Bob Stone</div><div role="cell"><span>Locked</span></div></div></div>
    <section><h2>Members</h2><table><tr><td>Mary Stone</td><td>Business plan</td></tr></table></section>
    <div role="grid"><div role="row"><div role="gridcell">No invoices yet</div><div role="gridcell">Ann Lee</div></div></div></main>`),
  "/row-wording": page("Row wording", `<main>${filler}<table><tr><td>Mary Stone: 1 open bills</td></tr></table></main>`),

  "/image-page": page("Image page", `<main>${filler}<img src="/gone.png" alt="Our team" width="100" height="100"></main>`),
  "/image-traps": page("Image traps", `<main>${filler}<img src="/gone-hidden.png" alt="" style="display:none"><img src="/gone-swapped.png" onerror="this.src='/ok.svg'" width="50" height="50"></main>`),
  "/logs": page("Logs", `<main>${filler}</main><script src="/app.js"></script>`),
  "/log-traps": page("Log traps", `<main>${filler}</main><script>console.error("Failed to load resource: something");console.warn("just a warning");console.log("nothing wrong");</script>`),
  "/no-style": page("No style", `<main>${filler}</main>`, '<link rel="stylesheet" href="/missing.css">'),
  "/platform": page("Platform", `<main>${filler}</main>`, '<script defer src="/_vercel/insights/script.js"></script><script defer src="/_vercel/speed-insights/script.js"></script><script defer src="/cdn-cgi/scripts/x/email.js"></script>'),
  "/signed-out": page("Signed out", `<main>${filler}</main><script src="/me.js"></script>`),
  "/signed-out-too": page("Signed out too", `<main>${filler}</main><script src="/me-forbidden.js"></script>`),
  "/signed-out-crash": page("Signed out crash", `<main>${filler}</main><script src="/me-crash.js"></script>`),
  "/says-forbidden": page("Says forbidden", `<main>${filler}</main><script src="/forbidden-words.js"></script>`),
  "/no-session": page("No session", `<main>${filler}</main><script src="/no-session.js"></script>`),
};

const FILES: Record<string, [string, string]> = {
  "/ok.svg": ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'],
  "/app.js": ["text/javascript", 'console.error("Totals did not add up for this month");'],
  "/me.js": ["text/javascript", 'fetch("/api/me").then((r) => { if (!r.ok) console.error("AxiosError: Request failed with status code " + r.status); });'],
  "/me-forbidden.js": ["text/javascript", 'fetch("/api/team").then((r) => { if (!r.ok) console.error("TRPCClientError: FORBIDDEN"); });'],
  "/me-crash.js": ["text/javascript", 'fetch("/api/me").then((r) => { if (!r.ok) console.error("Totals did not add up for this week"); });'],
  "/forbidden-words.js": ["text/javascript", 'console.error("Forbidden word list did not load");'],
  "/no-session.js": ["text/javascript", 'console.error("AuthSessionMissingError: Auth session missing!");'],
};

let site: Server;
let result: ScanResult;
const on = (path: string, kind?: ScreenCheck["kind"]) => result.checks.filter((c) => c.screens.includes(path) && (!kind || c.kind === kind));
const seen = (path: string) => expect(result.pagesVisited).toContain(path);

beforeAll(async () => {
  site = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = FILES[path];
    if (file) return void res.writeHead(200, { "content-type": file[0] }).end(file[1]);
    // What a dev server does with a file it doesn't have: the app's page, with a 200.
    if (path === "/api/me") return void res.writeHead(401, { "content-type": "application/json" }).end("{}");
    if (path === "/api/team") return void res.writeHead(403, { "content-type": "application/json" }).end("{}");
    if (path === "/gone.png") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>app</title>");
    if (path === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page("Home", `<main>${filler}${Object.keys(pages).map((p) => `<a href="${p}">go ${p}</a>`).join(" ")}</main>`));
    const html = pages[path];
    if (html) return void res.writeHead(200, { "content-type": "text/html" }).end(html);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, maxPages: 60, maxDurationMs: 90_000, delayMs: 0, exploreButtons: false, learnActions: false });
}, 120_000);
afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

describe("the proven checks, on a clean page", () => {
  it("stay quiet", () => {
    seen("/clean");
    expect(on("/clean")).toEqual([]);
    seen("/clean2");
    expect(on("/clean2")).toEqual([]);
  });
});

describe("cut-off labels", () => {
  it("are found on a nav link and a button, with what was measured", () => {
    const [nav] = on("/cut", "cut_off").filter((c) => c.target === "Backtesting sessions");
    expect(nav).toMatchObject({ at: "desktop" });
    expect(nav?.evidence).toMatch(/needs \d+px and has \d+px/);
    expect(on("/cut", "cut_off").map((c) => c.target)).toContain("Export everything");
    expect(nav?.room).toBeGreaterThan(0);
  });

  it("take no screen-reader text, ripple, closed rail, value, tooltip, table cell or article link for one", () => {
    seen("/cut-traps");
    expect(on("/cut-traps", "cut_off")).toEqual([]);
  });
});

describe("what covers a control", () => {
  it("is found at the control's centre, and stays after scrolling", () => {
    expect(on("/covered", "covered").map((c) => [c.target, c.by, c.at])).toContainEqual(["Message box", "Our help bar", "desktop"]);
    expect(on("/covered", "covered")[0]?.byWords).toEqual(["Our help bar"]);
  });

  it("is found when it hides part of a control and misses its centre", () => {
    expect(on("/half", "covered").map((c) => c.target)).toContain("Ask anything");
  });

  it("isn't a bar a person can scroll a field out from under, a layer that lets clicks through, a dialog, a toast, a panel with a close button, or the bar a field lives in", () => {
    for (const path of ["/covered-traps", "/dialog", "/toast", "/closable", "/inside"]) {
      seen(path);
      expect(on(path, "covered")).toEqual([]);
    }
  });
});

describe("broken wording", () => {
  it("is found in what's drawn", () => {
    const wording = on("/wording", "wording");
    expect(wording.map((c) => c.wording).sort()).toEqual(["count", "count", "missing_value", "missing_value", "missing_value", "placeholder"]);
    expect(wording.map((c) => c.target)).toEqual(expect.arrayContaining(["Based on 1 closed trades", "1 items", "undefined", "Total: $NaN", "Group: [object Object]", "Hello {name}"]));
  });

  it("takes nothing in a box, hidden, stacked, or meant for one", () => {
    seen("/wording-traps");
    expect(on("/wording-traps", "wording")).toEqual([]);
  });

  it("takes nothing from a page about code", () => {
    seen("/docs");
    expect(on("/docs", "wording")).toEqual([]);
  });

  it("takes numbered steps for positions, not counts", () => {
    seen("/steps");
    expect(on("/steps", "wording")).toEqual([]);
  });

  it("takes nothing that was only there until the data came", () => {
    seen("/flicker");
    expect(on("/flicker", "wording")).toEqual([]);
  });
});

describe("phone width", () => {
  it("finds a page that runs off sideways, and says where it starts", () => {
    const [wide] = on("/wide", "overflow");
    expect(wide).toMatchObject({ at: "phone" });
    expect(wide?.target).toMatch(/A row that never learned to wrap/);
    expect(wide?.proof?.length).toBeGreaterThan(0);
    expect(on("/wide", "overflow")).toHaveLength(1);
  });

  it("takes no wide table in its own box, closed drawer, or page that never said it fits a phone for one", () => {
    for (const path of ["/wide-traps", "/not-for-phones"]) {
      seen(path);
      expect(on(path, "overflow")).toEqual([]);
    }
  });

  it("finds a control off the side of a page that won't scroll there", () => {
    expect(on("/no-reach", "unreachable").map((c) => c.target)).toEqual(["Pay this invoice"]);
  });

  it("takes no strip with arrows that scroll it for one, but one with no way to move it is", () => {
    seen("/arrows");
    expect(on("/arrows", "unreachable")).toEqual([]);
    expect(on("/no-arrows", "unreachable").map((c) => c.target)).toEqual(expect.arrayContaining(["Security", "Exports"]));
  });

  it("finds arrows in a box of their own, in a row below the strip, and laid over it", () => {
    for (const path of ["/arrows-wrapped", "/arrows-below", "/arrows-over"]) {
      seen(path);
      expect(on(path, "unreachable")).toEqual([]);
    }
  });

  it("takes no tab of a strip for its arrow, and no button in a root or a card for a way to what it clips", () => {
    expect(on("/button-tabs", "unreachable").map((c) => c.target)).toEqual(expect.arrayContaining(["Security", "Exports"]));
    for (const path of ["/clipped-root", "/clipped-card"]) expect(on(path, "unreachable").map((c) => c.target)).toEqual(["Pay this invoice"]);
  });

  it("takes no slider or drawer for one", () => {
    seen("/slides");
    expect(on("/slides", "unreachable")).toEqual([]);
    expect(on("/wide-traps", "unreachable")).toEqual([]);
  });

  it("leaves the window as it found it", () => {
    expect(result.screens.every((shot) => shot.width === 1280)).toBe(true);
  });
});

describe("what failed to load", () => {
  it("finds an image that came back as a page, and shows broken", () => {
    expect(on("/image-page", "broken_image").map((c) => c.target)).toEqual(["/gone.png"]);
  });

  it("takes no hidden image, nor one with a fallback in its place", () => {
    seen("/image-traps");
    expect(on("/image-traps", "broken_image")).toEqual([]);
  });

  it("finds a stylesheet of the app's own that isn't there", () => {
    expect(on("/no-style", "failed_request").map((c) => c.target)).toEqual(["GET /missing.css"]);
  });

  it("takes no file only the host serves at its edge for a broken one", () => {
    seen("/platform");
    expect(on("/platform", "failed_request")).toEqual([]);
  });

  it("takes the normal answer to a signed-out visitor, logged by the app, for no error", () => {
    for (const path of ["/signed-out", "/signed-out-too"]) {
      seen(path);
      expect(on(path, "console_error")).toEqual([]);
    }
  });

  it("still finds an error of the app's beside such an answer, and auth's words with no such answer", () => {
    expect(on("/signed-out-crash", "console_error").map((c) => c.target)).toEqual(["Totals did not add up for this week"]);
    expect(on("/says-forbidden", "console_error").map((c) => c.target)).toEqual(["Forbidden word list did not load"]);
  });

  it("finds an error the page logged from its own script", () => {
    expect(on("/logs", "console_error").map((c) => c.target)).toEqual(["Totals did not add up for this month"]);
  });

  it("takes no network line, warning or plain log for one", () => {
    seen("/log-traps");
    expect(on("/log-traps", "console_error")).toEqual([]);
  });

  it("takes a sign-in library's word that nobody is signed in for no error, with no request behind it", () => {
    seen("/no-session");
    expect(on("/no-session", "console_error")).toEqual([]);
  });
});

describe("console errors, with the API on a host of its own", () => {
  const onHost = (script: string) => page("App", `<main>${filler}</main><script>${script}</script>`);
  const fetchMe = 'fetch("http://api.acme.localhost:" + location.port + "/me").then((r) => { if (!r.ok) console.error';
  const paths: Record<string, string> = {
    "/": `${onHost(`${fetchMe}("AxiosError: Request failed with status code " + r.status); });`)}<a href="/words">go</a><a href="/other">go</a>`,
    "/words": onHost(`${fetchMe}("Unauthorized"); });`),
    "/other": onHost(`${fetchMe}("Totals did not add up"); });`),
  };
  it("takes a 401 from a sibling host for the normal signed-out answer, and nothing else that's logged", async () => {
    const api = createServer((req, res) => {
      if (req.headers.host?.startsWith("api.")) return void res.writeHead(401, { "content-type": "application/json", "access-control-allow-origin": "*" }).end("{}");
      res.writeHead(200, { "content-type": "text/html" }).end(paths[req.url ?? "/"] ?? "gone");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const scan = await scanSite({ startUrl: `http://app.acme.localhost:${(api.address() as AddressInfo).port}/`, maxPages: 5, maxDurationMs: 45_000, delayMs: 0, exploreButtons: false, learnActions: false });
    await new Promise<void>((resolve) => api.close(() => resolve()));
    expect(scan.pagesVisited).toEqual(expect.arrayContaining(["/words", "/other"]));
    expect(scan.checks.filter((c) => c.kind === "console_error").map((c) => c.target)).toEqual(["Totals did not add up"]);
  }, 60_000);
});

describe("a screen for a reader", () => {
  it("leaves out every table cell off the stand-in: a local app's rows are someone's", () => {
    const review = result.reviews.find((r) => r.path === "/rows");
    expect(review?.text).toContain("A sentence the app says about its customers, for anyone reading it.");
    expect(review?.text).toContain("Customer");
    const said = JSON.stringify(review);
    for (const value of ["Jane Whitfield", "Ada Whitfield", "Acme Ltd", "Pro plan", "Grid Person", "Cell Person"]) expect(said).not.toContain(value);
  });

  it("takes no row, and no card around a table, for a line of its own: a status or an empty cell holds no row's names up", () => {
    const review = result.reviews.find((r) => r.path === "/status-rows");
    expect(review?.locked).toEqual([{ label: "Upgrade to Team to see the rest", why: "says" }]);
    expect(review?.empty.map((e) => e.text)).toEqual(["No exports yet"]);
    const said = JSON.stringify(review);
    for (const value of ["Jane Doe", "Bob Stone", "Mary Stone", "Ann Lee", "Pro plan", "Business plan"]) expect(said).not.toContain(value);
  });

  it("quotes only the broken phrase of a table's cell, with no sign-in too", () => {
    expect(on("/row-wording", "wording").map((c) => c.target)).toEqual(["1 open bills"]);
  });

  it("holds what was on screen, in order, navigation aside", () => {
    const review = result.reviews.find((r) => r.path === "/clean");
    expect(review?.heading).toBe("Clean");
    expect(review?.text[0]).toBe("Clean");
    expect(review?.text.join(" ")).not.toContain("Reports");
    expect(review?.controls).toEqual(expect.arrayContaining([{ label: "Reports", kind: "link", where: "nav" }, { label: "Save", kind: "button", where: "main" }]));
  });
});
