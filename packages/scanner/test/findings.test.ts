import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type Finding, type ScanProgress, type ScanResult } from "../src/scan.ts";

/**
 * A small product with one of each problem planted in it, and beside each the things that look
 * like it but aren't: a tab, an accordion, a "Copy" that only copies, a toggle that only changes
 * aria-pressed, a disabled button, a link that redirects, a single-page app's 404 fallback, an
 * API's own JSON "not found", and a third party's script throwing. And buttons that do nothing to
 * the page yet do something for a person: asking where they are, for the camera or the clipboard
 * (the browser's own prompt); answering only a real click, not one made by script; the chosen one
 * of a button bar; renaming itself from the box beside it. Only the planted ones may be found.
 */
let site: Server;
let thirdParty: Server;
let result: ScanResult;
const told: Finding[] = [];
const progress: ScanProgress[] = [];

const page = (title: string, body: string, scripts = "") =>
  `<!doctype html><html><head><title>${title}</title>${scripts}</head><body><h1>${title}</h1>${body}<footer id="foot">Footer</footer></body></html>`;

beforeAll(async () => {
  // Another host altogether (localhost, where the product is 127.0.0.1): a chat widget that throws.
  thirdParty = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(`window.chatWidget = { open() { throw new Error("chat widget failed to open"); } };\nthrow new Error("widget exploded on load");`);
  });
  await new Promise<void>((resolve) => thirdParty.listen(0, resolve));
  const widget = `http://localhost:${(thirdParty.address() as AddressInfo).port}/widget.js`;

  site = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const html = (status: number, body: string) => send(status, "text/html", body);
    switch (path) {
      case "/":
        return html(200, page("Dashboard", `
          <nav><a href="/reports">Reports</a> <a href="/settings">Settings</a> <a href="/old-pricing">Pricing</a> <a href="/moved">Account</a> <a href="/app/inbox">Inbox</a> <a href="/tools">Tools</a></nav>
          <button id="chart-btn">Show chart</button>
          <button id="stats">Load stats</button>
          <button id="activity">Refresh activity</button>
          <button id="drafts">Check drafts</button>
          <button id="generate">Generate summary</button><p id="summary"></p>
          <div role="tablist"><button role="tab" aria-selected="true" id="t1">Overview</button><button role="tab" aria-selected="false" id="t2">Details</button></div>
          <div id="p1">Overview panel</div><div id="p2" hidden>Details panel</div>
          <button id="acc" aria-expanded="false">Shipping details</button><div id="accp" hidden>Ships in 2 days</div>
          <button id="copy">Copy link</button>
          <button disabled>Archive</button>`, `<script src="${widget}"></script><script src="/app.js" defer></script>`));
      case "/app.js":
        return send(200, "text/javascript", `
          document.getElementById("chart-btn").onclick = () => document.getElementById("chart").render();
          document.getElementById("stats").onclick = () => fetch("/api/stats");
          document.getElementById("activity").onclick = () => fetch("/api/activity");
          document.getElementById("drafts").onclick = () => fetch("/api/drafts/current");
          document.getElementById("generate").onclick = () => setTimeout(() => { document.getElementById("summary").textContent = "All good"; }, 900);
          for (const [tab, other, panel, otherPanel] of [["t1", "t2", "p1", "p2"], ["t2", "t1", "p2", "p1"]]) {
            document.getElementById(tab).onclick = () => {
              document.getElementById(tab).setAttribute("aria-selected", "true");
              document.getElementById(other).setAttribute("aria-selected", "false");
              document.getElementById(panel).hidden = false;
              document.getElementById(otherPanel).hidden = true;
            };
          }
          acc.onclick = () => { const open = acc.getAttribute("aria-expanded") === "true"; acc.setAttribute("aria-expanded", String(!open)); accp.hidden = open; };
          copy.onclick = () => {
            if (navigator.clipboard) navigator.clipboard.writeText(location.href).catch(() => {});
            const toast = document.createElement("div");
            toast.textContent = "Link copied";
            document.body.append(toast);
            setTimeout(() => toast.remove(), 1000);
          };`);
      case "/reports":
        return html(200, page("Reports", `<button id="export">Export</button><button id="jump">Jump to footer</button>`, `<script src="/reports.js" defer></script>`));
      case "/reports.js":
        return send(200, "text/javascript", `jump.onclick = () => foot.scrollIntoView();\nundefinedFunction();`);
      case "/settings":
        return html(200, page("Settings", `
          <button id="star" aria-pressed="false">Star</button>
          <button id="layout">Save layout</button>
          <button id="code">Copy install command</button>
          <button id="chat">Open chat</button>
          <form id="invite"><input name="email" type="email" required><button>Send invite</button></form>
          <script>
            star.onclick = () => star.setAttribute("aria-pressed", String(star.getAttribute("aria-pressed") !== "true"));
            layout.onclick = () => localStorage.setItem("layout", "compact");
            code.onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText("npm i thing").catch(() => {}); else document.execCommand("copy"); };
            chat.onclick = () => window.chatWidget && window.chatWidget.open();
            invite.onsubmit = (e) => { e.preventDefault(); fetch("/api/invites", { method: "POST", body: JSON.stringify({ email: invite.email.value }) }); };
          </script>`, `<script src="${widget}"></script>`));
      case "/tools":
        return html(200, page("Tools", `
          <button id="locate">Where am I?</button><p id="where"></p>
          <button id="paste">Paste from clipboard</button>
          <button id="camera">Start camera</button>
          <button id="real">Press with a real click</button>
          <div class="bar"><button class="tab chosen">Add customer</button><button class="tab">Open account</button><button class="tab">Customers</button></div><div id="view">Add customer form</div>
          <form><label>New name <input id="newName"></label><button type="button" id="rename">Rename me</button></form>
          <style>.tab { background: #eee; color: #333; } .tab.chosen { background: #337ab7; color: #fff; }</style>
          <script>
            locate.onclick = () => navigator.geolocation.getCurrentPosition((p) => { where.textContent = String(p.coords.latitude); }, () => {});
            paste.onclick = () => navigator.clipboard.readText().then((t) => { where.textContent = t; }).catch(() => {});
            camera.onclick = () => navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {});
            real.addEventListener("click", (e) => { if (e.screenX > 0) real.className = "pressed"; });
            let chosen = "Add customer";
            for (const b of document.querySelectorAll(".tab")) b.onclick = () => {
              if (b.textContent === chosen) return;
              chosen = b.textContent;
              view.textContent = chosen + " form";
              for (const x of document.querySelectorAll(".tab")) x.classList.toggle("chosen", x === b);
            };
            rename.onclick = () => { if (newName.value) rename.textContent = newName.value; };
          </script>`));
      case "/old-pricing":
        return html(404, page("Page not found", "<p>Sorry, we couldn't find that page.</p>"));
      case "/moved":
        return send(302, "text/html", "", { location: "/settings" });
      case "/app/inbox":
        // A single-page app served with a 404 status that still shows the whole app: not a broken link.
        return html(404, page("Inbox", `<p>${"Your conversations with customers appear here, newest first, with their replies. ".repeat(6)}</p>`));
      case "/api/stats":
        return send(500, "application/json", JSON.stringify({ error: "database unavailable" }));
      case "/api/activity":
        return send(404, "text/html", "<pre>Cannot GET /api/activity</pre>");
      case "/api/drafts/current":
        // The app's own answer: there is no draft yet. Not a failure.
        return send(404, "application/json", JSON.stringify({ error: "no draft" }));
      default:
        return html(404, page("Not found", ""));
    }
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  result = await scanSite({ startUrl: url, maxPages: 10, maxDurationMs: 120_000, delayMs: 0, screenshots: false, maxButtonsPerPage: 20, onFinding: (f) => told.push(f), onProgress: (p) => progress.push(p) });
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => site?.close(() => resolve()));
  await new Promise<void>((resolve) => thirdParty?.close(() => resolve()));
});

const brief = () => result.findings.map((f) => `${f.kind} ${f.screen} ${f.target} [${f.evidence}]`);

describe("findings: what the learner can prove is wrong", () => {
  it("finds each planted problem, with its evidence", () => {
    expect(result.stoppedBy).toBe("complete");
    const find = (kind: string, target: string | RegExp) => result.findings.find((f) => f.kind === kind && (typeof target === "string" ? f.target === target : target.test(f.target)));
    expect(find("does_nothing", "Export")).toMatchObject({ screen: "/reports" });
    expect(find("crashes", /Cannot read properties of null/)).toMatchObject({ screen: "/", evidence: "app.js", after: "Show chart" });
    expect(find("crashes", /undefinedFunction is not defined/)).toMatchObject({ screen: "/reports", evidence: "reports.js" });
    expect(find("request_fails", "GET /api/stats")).toMatchObject({ screen: "/", evidence: "500", after: "Load stats" });
    expect(find("request_fails", "GET /api/activity")).toMatchObject({ screen: "/", evidence: "404" });
    expect(find("broken_link", "/old-pricing")).toMatchObject({ screen: "/", evidence: "404" });
  });

  it("finds nothing else: none of the look-alikes is flagged", () => {
    // Exactly the six planted problems; any seventh is a false alarm.
    expect(brief()).toHaveLength(6);
    const targets = result.findings.map((f) => f.target).join(" | ");
    for (const trap of ["Overview", "Details", "Shipping details", "Copy link", "Archive", "Star", "Save layout", "Copy install command", "Open chat", "Generate summary", "Jump to footer", "Send invite", "/moved", "/settings", "/app/inbox", "/api/drafts/current", "widget", "chat widget",
      "Where am I?", "Paste from clipboard", "Start camera", "Press with a real click", "Add customer", "Open account", "Customers", "Rename me"]) {
      expect(targets).not.toContain(trap);
    }
  });

  it("tells each problem as it's first seen, and how far it has got as it goes", () => {
    expect(told.map((f) => `${f.kind}|${f.screen}|${f.target}`).sort()).toEqual(result.findings.map((f) => `${f.kind}|${f.screen}|${f.target}`).sort());
    expect(told.every((f) => f.count === 1)).toBe(true);
    // Phases in order, never back; screens only ever go up, to what was learned.
    const phases = progress.map((p) => p.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(["opening", "exploring", "finishing"]);
    expect(progress.every((p, i) => i === 0 || p.screens >= progress[i - 1]!.screens)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ screens: result.pagesVisited.length, maxPages: 10, phase: "finishing" });
  });

  it("reports each problem once, however often it was seen", () => {
    const keys = result.findings.map((f) => `${f.kind}|${f.screen}|${f.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.findings.every((f) => f.count >= 1)).toBe(true);
  });
});
