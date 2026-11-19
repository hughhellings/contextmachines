/**
 * The bench's local fixture site: small pages that each reproduce one way the tester has failed on
 * big public sites (robust-spec.md F1 to F6, tonight-plan.md F7 to F10). Node's http on 127.0.0.1, a
 * free port, every request logged, so a bench (or a test) can see which address a click really
 * reached. The pages are served as http://localhost:<port>/; a second server on 127.0.0.1:<port2> is
 * "another site" (siteOf: localhost and 127.0.0.1 are different sites), for the cross-site frame.
 *
 * Used by bench.ts and by the offline tests (bench.test.ts, robust.test.ts): fixtures are written once.
 * No AI, no network.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CLEAN_PAGE, PLANTED_PAGE } from "./a11y-pages.ts";
import { isJudgeBeacon, judgePage } from "./judge-site.ts";
import { ledger } from "./trade-site.ts";
import { ONLY_LOCKED, siApp, TWO_LOCKED, THIRD_OK } from "./si-site.ts";
import { unseenApps } from "./unseen-site.ts";
import { formApps } from "./form-site.ts";

export type Variant = "base" | "changed";

export interface FixtureSite {
  /** http://localhost:<port>/ */
  url: string;
  /** http://127.0.0.1:<port2>/: another site, for F9's cross-site frame. */
  otherUrl: string;
  /** Every request so far, both servers, as path + query ("/chart/?symbol=AAPL"), in order. */
  hits(): string[];
  /** "changed": F4's lists reordered and one label renamed, for replay precision. */
  setVariant(v: Variant): void;
  variant(): Variant;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
const plain = (title: string, h1: string, more = "") => page(title, `<header><a href="/">Home</a></header><main><h1>${esc(h1)}</h1>${more}</main>`);
const times = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");
/** A small coloured square, a picture with no words. */
const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="${fill}"/></svg>`;
const PICS: Record<string, string> = { "1": "#c0392b", "2": "#27ae60", "3": "#2980b9", h1: "#999", h2: "#aaa", frame: "#e67e22" };

// ---------------------------------------------------------------------------------------------
// F1 /palette: a command palette in a portal at the end of a long body, with plain-div results.

const PALETTE = page("Fixture Markets — charts and ideas", `
<header><a href="/">Fixture Markets</a> <button id="search">Search (⌘K)</button> <a href="/pricing">Pricing</a></header>
<main><h1>Markets today</h1>
<section aria-label="Ideas feed"><h2>Ideas</h2><a href="/ideas/apple">Apple Inc.</a> <a href="/ideas/msft">Microsoft Corp.</a></section>
<section><h2>Stories</h2>
${times(900, (i) => `<a href="/news/${i}">Market story ${i}</a>`)}
</section>
<section><h2>Watchlist</h2>
${times(300, (i) => `<button type="button">Watch ${i}</button>`)}
</section></main>
<script>
function openPalette() {
  if (document.getElementById("portal")) return;
  const p = document.createElement("div");
  p.id = "portal";
  p.innerHTML = '<div class="backdrop" style="position:fixed;inset:0;background:transparent;z-index:10"></div>' +
    '<div class="box" style="position:fixed;top:10%;left:25%;width:50%;background:#fff;border:1px solid #888;z-index:11;padding:8px">' +
    '<input type="search" placeholder="Symbol, ISIN, or CUSIP"> <button type="button" class="clear">Clear</button> <button type="button" class="close">Close</button>' +
    '<div class="results"></div></div>';
  document.body.appendChild(p);
  const input = p.querySelector("input");
  const results = p.querySelector(".results");
  const rows = [["<em>AAPL</em> Apple Inc", "/chart/?symbol=AAPL"], ["Buy AAPL now", "/buy?symbol=AAPL"]];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = q && ("aapl".startsWith(q) || "apple".startsWith(q)) ? rows.map(([words, to], i) => '<div data-role="list-item" id="row-' + i + '" style="cursor:default;padding:4px" data-to="' + to + '">' + words + '</div>').join("") : "";
    input.removeAttribute("aria-activedescendant");
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    // ArrowDown picks out the next row (aria-activedescendant); Enter opens the row picked out, or the first.
    const all = [...results.querySelectorAll("[data-role=list-item]")];
    const now = all.findIndex((r) => r.id === input.getAttribute("aria-activedescendant"));
    if (e.key === "ArrowDown" && all.length) { const next = all[Math.min(all.length - 1, now + 1)]; all.forEach((r) => r.removeAttribute("aria-selected")); next.setAttribute("aria-selected", "true"); input.setAttribute("aria-activedescendant", next.id); e.preventDefault(); }
    if (e.key === "Enter") { const row = all[now] ?? all[0]; if (row) location.href = row.dataset.to; }
    if (e.key === "Escape") p.remove();
  });
  results.addEventListener("click", (e) => { const row = e.target.closest("[data-role=list-item]"); if (row) location.href = row.dataset.to; });
  p.querySelector(".clear").onclick = () => { input.value = ""; render(); input.focus(); };
  p.querySelector(".close").onclick = () => p.remove();
  p.querySelector(".backdrop").onclick = () => p.remove();
  input.focus();
}
document.getElementById("search").onclick = openPalette;
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); } });
</script>`);

// ---------------------------------------------------------------------------------------------
// F2 /covered: a button under a fixed overlay that intercepts pointer events.

const COVERED = page("Reports — Fixture Markets", `
<header><a href="/">Fixture Markets</a></header>
<main><h1>Reports</h1><p>The quarterly report is ready.</p>
<button type="button" onclick="location.href='/report'">Download report</button>
${times(20, (i) => `<p>Section ${i} of the report summary.</p>`)}</main>
<div aria-label="Newsletter sign-up" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:5">
  <div style="background:#fff;margin:15% auto;width:320px;padding:16px"><p>Get the weekly newsletter in your inbox.</p>
  <button type="button" onclick="this.closest('[aria-label]').remove()">Close</button></div>
</div>`);

// ---------------------------------------------------------------------------------------------
// F3a /huge: a late modal dialog after 1,500 links. F3b /lang: a toggle menu of plain divs.

const HUGE = page("Documents — Fixture Markets", `
<header><a href="/">Fixture Markets</a> <a href="/pricing">Pricing</a></header>
<main><h1>Documents</h1>
${times(1500, (i) => `<a href="/doc/${i}">Document ${i}</a>`)}
</main>
<script>
setTimeout(() => {
  const shade = document.createElement("div");
  shade.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:5";
  const d = document.createElement("div");
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-modal", "true");
  d.setAttribute("aria-labelledby", "dt");
  d.style.cssText = "position:fixed;top:20%;left:30%;width:40%;background:#fff;padding:16px;z-index:6";
  d.innerHTML = '<h2 id="dt">Before you continue</h2><p>We have updated our terms of service.</p><button type="button" class="go">Continue</button> <button type="button" class="more">More options</button><p class="extra" hidden>You can read the full terms at any time.</p>';
  d.querySelector(".go").onclick = () => { d.remove(); shade.remove(); };
  d.querySelector(".more").onclick = () => { d.querySelector(".extra").hidden = false; };
  document.body.append(shade, d);
}, 500);
</script>`);

const LANG = page("Fixture Markets — home", `
<header><a href="/">Fixture Markets</a> <button type="button" id="lang" aria-haspopup="menu" aria-expanded="false">Language</button></header>
<main><h1>Markets</h1>
${times(1500, (i) => `<a href="/doc/${i}">Document ${i}</a>`)}
</main>
<script>
const opener = document.getElementById("lang");
opener.onclick = () => {
  const open = document.getElementById("langmenu");
  if (open) { open.remove(); opener.setAttribute("aria-expanded", "false"); return; }
  const m = document.createElement("div");
  m.id = "langmenu";
  m.setAttribute("role", "menu");
  m.style.cssText = "position:fixed;top:40px;right:10px;background:#fff;border:1px solid #888;padding:6px;z-index:5";
  m.innerHTML = '<div data-lang="en">English</div><div data-lang="de">Deutsch</div>';
  m.onclick = (e) => { const o = e.target.closest("[data-lang]"); if (o) location.href = "/?lang=" + o.dataset.lang; };
  document.body.appendChild(m);
  opener.setAttribute("aria-expanded", "true");
};
</script>`);

// ---------------------------------------------------------------------------------------------
// F4 /dupes and /pictures: duplicate names behind an aria-hidden layer; nameless picture links.

function dupes(v: Variant): string {
  const bg = `<div aria-hidden="true" class="bg"><h2>Your files</h2><p>Recent uploads appear here.</p><button type="button" onclick="location.href='/bg-open'">${v === "changed" ? "Open now" : "Open"}</button></div>`;
  const modal = `<div role="dialog" aria-label="Shared file" style="position:fixed;top:30%;left:45%;width:300px;background:#fff;border:1px solid #444;padding:12px;z-index:5"><p>report.pdf was shared with you.</p><button type="button" onclick="location.href='/modal-open'">Open</button> <button type="button" onclick="this.closest('[role=dialog]').remove()">Dismiss</button></div>`;
  return page("Files — Fixture Drive", `<header><a href="/">Fixture Drive</a></header><main><h1>Files</h1>${v === "changed" ? modal + bg : bg + modal}</main>`);
}

function pictures(v: Variant): string {
  const order = v === "changed" ? ["3", "1", "2"] : ["1", "2", "3"];
  return page("Pictures — Fixture Drive", `<header><a href="/">Fixture Drive</a></header><main><h1>Pictures</h1>
<div aria-hidden="true" style="position:absolute;left:-9999px"><a href="/hidden-1"><img src="/pic/h1.svg" alt=""></a> <a href="/hidden-2"><img src="/pic/h2.svg" alt=""></a></div>
<iframe src="/frame-pic" title="Featured" width="160" height="110"></iframe>
<ul class="gallery" style="list-style:none;display:flex;gap:12px;padding:0">${order.map((k) => `<li><a href="/img-${k}"><img src="/pic/${k}.svg" alt="" width="120" height="90"></a></li>`).join("")}</ul>
</main>`);
}

// ---------------------------------------------------------------------------------------------
// F5 /gone-layout, F6 /banner.

const GONE = page("Chart Not Found — Site", `<header><a href="/">Fixture Markets</a></header><main><h1>Can't open this chart layout</h1><p>This layout is private or was removed.</p><a href="/">Go to homepage</a></main>`);

function banner(apostrophe: string, consented: boolean): string {
  const wall = consented ? "" : `<div role="dialog" aria-modal="true" aria-label="Cookies" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:5">
<div style="background:#fff;position:absolute;bottom:0;left:0;right:0;padding:16px"><p>This website uses cookies.</p>
<button type="button" data-choice="reject">Don${apostrophe}t allow</button> <button type="button" data-choice="accept">Accept all</button></div></div>
<script>
document.querySelectorAll("[data-choice]").forEach((b) => b.onclick = async () => {
  await fetch("/consent?choice=" + b.dataset.choice);
  document.cookie = "consent=" + b.dataset.choice + "; path=/";
  b.closest("[role=dialog]").remove();
});
</script>`;
  return page("Fixture Café", `<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/menu-card">Menu</a></nav></header><main><h1>Welcome to Fixture Café</h1><p>Coffee, cake and quiet tables.</p></main>${wall}`);
}

// ---------------------------------------------------------------------------------------------
// F7 /issues, F8 /menu, F9 /embed, F10 /trap.

function issues(open: boolean): string {
  const list = [["Login button misaligned", true], ["Typo on pricing page", false], ["Search is slow", true], ["Old logo in footer", false]] as const;
  return page(open ? "Open issues — Fixture Tracker" : "Issues — Fixture Tracker", `<header><a href="/">Fixture Tracker</a></header><main><h1>Issues</h1>
<style>.toggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer}.toggle .box{position:relative;display:inline-block;width:14px;height:14px;border:1px solid #333;border-radius:3px}</style>
<label for="open" class="toggle"><input type="checkbox" id="open" ${open ? "checked" : ""} style="opacity:0;position:absolute;width:1px;height:1px"><span class="box"></span> Show only open issues</label>
${open ? "<h2>Showing open issues only</h2>" : ""}
<ul>${list.filter(([, o]) => !open || o).map(([t, o]) => `<li>${t} (${o ? "open" : "closed"})</li>`).join("")}</ul>
<script>document.getElementById("open").addEventListener("change", (e) => { location.href = e.target.checked ? "/issues?open=1" : "/issues"; });</script>
</main>`);
}

/** The submenu opens only while the pointer is over it; a click on "Products" toggles it shut (so a click, which hovers first, still can't reach it). */
const MENU = page("Fixture Cloud", `<style>.sub{display:none;position:absolute;background:#fff;border:1px solid #888;padding:6px}.sub a{display:block}</style>
<header><nav style="display:flex;gap:16px"><a href="/">Fixture Cloud</a>
<div class="nav" id="products" style="position:relative"><button type="button" aria-haspopup="true">Products</button>
<div class="sub"><a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/buy-now">Buy now</a></div></div>
<a href="/blog">Blog</a></nav></header><main><h1>Cloud for testing</h1><p>Everything you need to ship.</p></main>
<script>
const nav = document.getElementById("products"), sub = nav.querySelector(".sub");
let shut = false;
nav.addEventListener("mouseenter", () => { if (!shut) sub.style.display = "block"; });
nav.addEventListener("mouseleave", () => { sub.style.display = "none"; shut = false; });
nav.querySelector("button").addEventListener("click", () => { shut = sub.style.display === "block"; sub.style.display = shut ? "none" : "block"; });
</script>`);

const embed = (other: string) => page("Docs — Fixture Docs", `<header><a href="/">Fixture Docs</a> <a href="/guides">Guides</a></header><main><h1>Getting started</h1><p>Install the tool, then run it on your site.</p>
<aside><h2>Need a hand?</h2><iframe src="/frame-help" title="Help panel" width="300" height="120"></iframe></aside>
<aside><iframe src="${other}ad" title="Advertisement" width="300" height="120"></iframe></aside></main>`);
const FRAME_HELP = page("Help panel", `<p>Questions? <a href="/help-from-frame" target="_top">Help</a></p>`);
const FRAME_PIC = page("Featured", `<a href="/img-frame"><img src="/pic/frame.svg" alt="" width="120" height="90"></a>`);
const AD = (other: string) => page("Ad", `<p>Sponsored. <a href="${other}ad-click" target="_top">Help</a></p>`);

const TRAP = page("Results — Fixture Search", `<header><a href="/">Fixture Search</a></header><main><h1>Results</h1>
<div role="tablist" aria-label="View"><button type="button" role="tab" aria-selected="true" id="grid">Grid</button><button type="button" role="tab" aria-selected="false" id="list">List</button></div>
<ol class="results">${times(10, (i) => `<li>Result ${i}</li>`)}</ol>
<button type="button" id="more">Load more</button>
<script>
for (const id of ["grid", "list"]) document.getElementById(id).onclick = () => { for (const t of ["grid", "list"]) document.getElementById(t).setAttribute("aria-selected", String(t === id)); };
document.getElementById("more").onclick = () => {};
</script></main>`);

/**
 * /suggest (robust.test.ts, C10): a search box that suggests as keys are pressed (it listens for
 * keyup, not input), its suggestions fetched from /api/suggest, which answers after 1.2 s. A look
 * taken before that answer shows no suggestions.
 */
const SUGGEST = page("Find a place — Fixture Maps", `<header><a href="/">Fixture Maps</a></header><main><h1>Find a place</h1>
<input type="search" aria-label="Find a place" autocomplete="off"> <ul id="found" aria-label="Suggestions"></ul>
<script>
const box = document.querySelector("input");
box.addEventListener("keyup", async () => {
  const q = box.value.trim();
  if (!q) return;
  const words = await (await fetch("/api/suggest?q=" + encodeURIComponent(q))).json();
  document.getElementById("found").innerHTML = words.map((w) => '<li><a href="/place?name=' + encodeURIComponent(w) + '">' + w + '</a></li>').join("");
});
</script></main>`);

/** Cloudflare's "Verifying you are human" page, as botwall.ts knows it. */
const WALL = page("localhost", `<h1>localhost</h1><p>Verifying you are human. This may take a few seconds.</p><p>localhost needs to review the security of your connection before proceeding.</p><p>Ray ID: 8f1a2b3c4d5e6f70</p><p>Performance &amp; security by Cloudflare</p>`);

const HOME = (lang: string | null) => page("Fixture Markets — home", `<header><a href="/">Fixture Markets</a> <a href="/about">About</a> <a href="/pricing">Pricing</a></header><main><h1>${lang === "de" ? "Willkommen bei Fixture Markets" : "Welcome to Fixture Markets"}</h1>
<p>Charts, ideas and news.</p><ul><li><a href="/palette">Charts</a></li><li><a href="/issues">Issues</a></li><li><a href="/docs">Docs</a></li></ul></main>`);

// ---------------------------------------------------------------------------------------------

export async function startFixtureSite(): Promise<FixtureSite> {
  const log: string[] = [];
  let variant: Variant = "base";
  let other = "";
  // The trade ledger (trade-site.ts): /tj/ saves, /tjb/ has a "Save trade" that does nothing.
  const ledgers = [ledger("/tj/", false), ledger("/tjb/", true)];
  // The signed-in trade ledger's add-a-trade wizard (si-site.ts): /si/ saves, /sib/ "Save trade" does
  // nothing, /sil/ saves but picks a verified (locked) account first.
  const siApps = [siApp("/si/", false), siApp("/sib/", true), siApp("/sil/", false, { lockedFirst: true }), siApp("/sio/", false, { accounts: ONLY_LOCKED }), siApp("/sit/", false, { accounts: TWO_LOCKED }), siApp("/sic/", false, { accounts: TWO_LOCKED }), siApp("/si2/", false, { needsExit: true }), siApp("/si3/", false, { accounts: THIRD_OK })];
  // Forms a real user fills in completely, in four styles (form-site.ts): /fo/ /fp/ /fs/ /fg/.
  const forms = formApps();
  const unseen = unseenApps();
  const listen = (server: Server) => new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

  const main = createServer((req: IncomingMessage, res: ServerResponse) => {
    log.push(req.url ?? "/");
    const url = new URL(req.url ?? "/", "http://localhost");
    const html = (content: string, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(content);
    const cookie = req.headers.cookie ?? "";
    const p = url.pathname;
    if (p === "/") return html(HOME(url.searchParams.get("lang")));
    // The judge set's pages (judge-site.ts), and the beacons they send.
    if (p.startsWith("/jd/")) {
      if (isJudgeBeacon(p)) return res.writeHead(204).end();
      const jd = judgePage(p, url.searchParams);
      if (jd) return html(jd);
    }
    // A slow report (honest.test.ts): the page asks the site for it and it comes 14 s later. A wait on
    // it must last until it comes, not be cut short as a settled page.
    if (p === "/slow-report") return html(plain("Report — Fixture Ledger", "Your report", `<p id="state">Preparing your report…</p><script>fetch("/api/slow-report").then((r) => r.text()).then((t) => { document.getElementById("state").textContent = t; });</script>`));
    if (p === "/api/slow-report") {
      setTimeout(() => res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("Report ready: 3 trades"), 14_000);
      return;
    }
    for (const app of siApps) if (app.handle(req, res, url, (line) => log.push(line))) return;
    if (unseen.handle(req, res, url, (line) => log.push(line))) return;
    if (forms.handle(req, res, url, (line) => log.push(line))) return;
    for (const j of ledgers) {
      const a = j.answer(p, url.searchParams);
      if (a && "redirect" in a) return res.writeHead(302, { location: a.redirect, "cache-control": "no-store" }).end();
      if (a) return html(a.html);
    }
    if (p === "/palette") return html(PALETTE);
    if (p === "/chart/" || p === "/chart") return html(plain(`${url.searchParams.get("symbol") ?? "?"} chart — Fixture Markets`, `${url.searchParams.get("symbol") ?? "?"} chart`));
    if (p.startsWith("/buy")) return html(plain("Order — Fixture Markets", "Order placed"));
    if (p === "/covered") return html(COVERED);
    if (p === "/report") return html(plain("Report downloaded — Fixture Markets", "Your report is downloading"));
    if (p === "/huge") return html(HUGE);
    if (p === "/lang") return html(LANG);
    if (p === "/dupes") return html(dupes(variant));
    if (p === "/pictures") return html(pictures(variant));
    if (p === "/frame-pic") return html(FRAME_PIC);
    const pic = /^\/pic\/(\w+)\.svg$/.exec(p)?.[1];
    if (pic && PICS[pic]) return res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg(PICS[pic]));
    if (p === "/modal-open") return html(plain("report.pdf — Fixture Drive", "report.pdf"));
    if (p === "/bg-open") return html(plain("Your files — Fixture Drive", "All your files"));
    const img = /^\/(img|hidden)-(\w+)$/.exec(p);
    if (img) return html(plain(`Picture ${img[2]} — Fixture Drive`, `Picture ${img[2]}`));
    if (p === "/gone-layout") return html(GONE);
    if (p === "/banner") return html(banner("'", /(^|;\s*)consent=/.test(cookie)));
    if (p === "/banner-curly") return html(banner("’", /(^|;\s*)consent=/.test(cookie)));
    if (p === "/consent") return res.writeHead(204).end();
    // The accessibility scan's pages (a11y-pages.ts): the clean one links to the planted one, so a task can walk from one to the other.
    if (p === "/a11y") return html(PLANTED_PAGE);
    if (p === "/a11y-clean") return html(CLEAN_PAGE.replace('<a class="nav" href="/about">About</a>', '<a class="nav" href="/about">About</a><a class="nav" href="/a11y">Planted page</a>'));
    if (p === "/about") return html(plain("About — Fixture Café", "About us"));
    if (p === "/pricing") return html(plain("Pricing — Fixture", "Pricing"));
    if (p === "/docs") return html(plain("Docs — Fixture Cloud", "Documentation"));
    if (p === "/issues") return html(issues(url.searchParams.get("open") === "1"));
    if (p === "/menu") return html(MENU);
    if (p === "/embed") return html(embed(other));
    if (p === "/frame-help") return html(FRAME_HELP);
    if (p === "/help-from-frame") return html(plain("Help — Fixture Docs", "How can we help?"));
    if (p === "/trap") return html(TRAP);
    if (p === "/suggest") return html(SUGGEST);
    if (p === "/api/suggest") {
      const q = url.searchParams.get("q") ?? "";
      setTimeout(() => res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify([`${q} Harbour`, `${q} Station`])), 1200);
      return;
    }
    if (p === "/place") return html(plain(`${url.searchParams.get("name") ?? "?"} — Fixture Maps`, url.searchParams.get("name") ?? "?"));
    // A link to a page that is a bot check (robust.test.ts T18): never in the bench's tasks.
    if (p === "/to-wall") return html(plain("Shop — Fixture", "Shop", '<p><a href="/wall">Continue to the shop</a></p>'));
    if (p === "/wall") return html(WALL);
    if (/^\/(news|doc|ideas)\//.test(p) || ["/guides", "/blog", "/menu-card"].includes(p)) return html(plain(`${p.slice(1)} — Fixture`, p.slice(1)));
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  const ads = createServer((req, res) => {
    log.push(req.url ?? "/");
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (p === "/ad") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(AD(other));
    if (p === "/ad-click") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(plain("Sponsor", "Sponsor"));
    res.writeHead(404).end();
  });
  const port = await listen(main);
  const port2 = await listen(ads);
  other = `http://127.0.0.1:${port2}/`;
  const close = (s: Server) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); });
  return {
    url: `http://localhost:${port}/`,
    otherUrl: other,
    hits: () => [...log],
    setVariant: (v) => { variant = v; },
    variant: () => variant,
    close: async () => { await Promise.all([close(main), close(ads)]); },
  };
}
