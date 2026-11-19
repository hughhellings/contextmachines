/**
 * The bug garden: a small shop ("Fernleaf Supply") with known bugs planted, for Discovery (E8) and the
 * Issues inbox (A3). Every plant is something a browser measures: a status code, a console line, a
 * thrown error, a dropped request, a control with no name, a press after which nothing happens, a
 * form that never sends, a page that takes six seconds. Beside each plant sits a trap that looks
 * like it and is fine, so a finder that flags the trap is caught.
 *
 * GARDEN_ISSUES is the exact expected issue list. judgeIssues (tasks.ts) scores a run's findings
 * against it: every plant found, nothing else filed.
 *
 * Two servers: the shop on http://127.0.0.1:<p1>/ and a partner site on http://partner.localhost:<p2>/
 * (another site): the footer links there, and its hit count must stay 0 after a Discovery run.
 */
import type { A11yKind } from "../../../packages/scanner/src/tester/a11y.ts";
import type { FrictionKind } from "../../../packages/scanner/src/tester/types.ts";
import type { Evidence, IssueKind, PracticeSite } from "../contracts.ts";
import { esc, listen, page, readBody, send, sleep } from "./common.ts";

/** How long /reports takes to answer. */
export const SLOW_MS = 6000;

const NAV = [
  ["/", "Home"], ["/shop", "Shop"], ["/search", "Search"], ["/profile", "Profile"], ["/reports", "Reports"],
  ["/settings", "Settings"], ["/contact", "Contact"], ["/help", "Help"], ["/about", "About"], ["/newsletter", "Newsletter"],
  ["/pricing-old", "Pricing"],
] as const;

function shell(title: string, h1: string, main: string, partner: string, head = ""): string {
  const nav = NAV.map(([href, name]) => `<a href="${href}">${name}</a>`).join("");
  return page(`${title} — Fernleaf Supply`, `<header><nav aria-label="Main">${nav}</nav></header><main><h1>${esc(h1)}</h1>${main}</main><footer class="muted">Fernleaf Supply, a practice shop. <a href="${esc(partner)}">Our partner</a></footer>`, head);
}

/** A magnifier, drawn: the icon in the unnamed button and in its named twin. */
const ICON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 11l4 4" stroke="currentColor" stroke-width="2"/></svg>`;
const BAG = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="5" width="12" height="10" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

const PRODUCTS = [
  { id: "mug-blue", name: "Blue mug", price: "$14.00" },
  { id: "pot-fern", name: "Fern pot", price: "$22.00" },
  { id: "can-water", name: "Watering can", price: "$31.00" },
];

const HOME = (partner: string) => shell("Home", "Plants and pots, delivered", `
<p>Everything for a small indoor garden.</p>
<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='8'%3E%3Crect width='120' height='8' fill='%2388aa77'/%3E%3C/svg%3E" alt="" width="120" height="8">
<p><a href="/shop">Browse the shop</a></p>
<script>console.log("debug: home ready"); console.info("Fernleaf build 2026.11");</script>`, partner);

const SHOP = (partner: string) => shell("Shop", "Shop", `
<p>
  <button type="button" id="filter-toggle" class="ghost">${ICON}</button>
  <button type="button" id="cart-toggle" class="ghost" aria-label="Open cart">${BAG}</button>
</p>
<div id="filter" hidden><label for="f">Filter</label><input id="f" name="f"></div>
<div id="cart" hidden class="card">Your cart is empty.</div>
${PRODUCTS.map((p) => `<div class="card"><strong>${p.name}</strong> <span class="muted">${p.price}</span>
  <button type="button" data-add="${p.id}">Add ${p.name} to cart</button></div>`).join("")}
<p id="cart-status" role="status"></p>
<div id="recs" class="muted">Loading recommendations…</div>
<script>
document.getElementById("filter-toggle").addEventListener("click", () => { const f = document.getElementById("filter"); f.hidden = !f.hidden; });
document.getElementById("cart-toggle").addEventListener("click", () => { const c = document.getElementById("cart"); c.hidden = !c.hidden; });
for (const b of document.querySelectorAll("[data-add]")) b.addEventListener("click", async () => {
  const r = await fetch("/api/cart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b.dataset.add, qty: 1 }) });
  document.getElementById("cart-status").textContent = r.ok ? "Added." : "Adding…";
});
fetch("/api/recommendations").then((r) => r.json()).then((xs) => { document.getElementById("recs").textContent = "You may like: " + xs.join(", "); })
  .catch(() => { document.getElementById("recs").textContent = "No recommendations right now."; });
</script>`, partner);

function SEARCH(q: string, partner: string): string {
  const hits = q ? PRODUCTS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : [];
  const list = q ? (hits.length ? `<ul>${hits.map((p) => `<li>${p.name} ${p.price}</li>`).join("")}</ul>` : `<p>No results for “${esc(q)}”.</p>`) : "";
  return shell("Search", "Search", `
<form action="/search" method="get"><label for="q">Search the shop</label><input id="q" name="q" value="${esc(q)}"> <button>Search</button></form>
${list}
<script>console.error("Search index failed to load: index.json is missing");</script>`, partner);
}

const PROFILE = (partner: string) => shell("Profile", "Your profile", `
<p>Signed out. <a href="/about">About accounts</a></p>
<script>const account = window.__account; document.querySelector("h1").dataset.who = account.name;</script>`, partner);

const REPORTS = (partner: string) => shell("Reports", "Reports", `<p>Sales this month: 41 orders.</p>`, partner);

const SETTINGS = (partner: string) => shell("Settings", "Settings", `
<label for="name">Shop name</label><input id="name" name="name" value="Fernleaf Supply">
<label><input type="checkbox" name="mail" style="width:auto"> Email me about new plants</label>
<p><button type="button" id="save">Save changes</button> <button type="button" class="ghost" id="adv">Show advanced</button></p>
<div id="advanced" hidden class="card">Advanced: nothing to change yet.</div>
<script>document.getElementById("adv").addEventListener("click", () => { const a = document.getElementById("advanced"); a.hidden = !a.hidden; });</script>`, partner);

const CONTACT = (partner: string) => shell("Contact", "Contact us", `
<form id="contact" action="/contact" method="post">
  <label for="c-name">Your name</label><input id="c-name" name="name">
  <label for="c-msg">Message</label><textarea id="c-msg" name="message"></textarea>
  <p><button type="submit">Send message</button></p>
</form>
<script>document.getElementById("contact").addEventListener("submit", (e) => { e.preventDefault(); });</script>`, partner);

const HELP = (partner: string) => shell("Help", "Help", `
<div class="card"><button type="button" class="ghost" aria-expanded="false" data-q="1">How long does delivery take?</button><p data-a="1" hidden>Two to four days.</p></div>
<div class="card"><button type="button" class="ghost" aria-expanded="false" data-q="2">Can I return a plant?</button><p data-a="2" hidden>Within 14 days, if it is alive.</p></div>
<script>for (const b of document.querySelectorAll("[data-q]")) b.addEventListener("click", () => {
  const a = document.querySelector('[data-a="' + b.dataset.q + '"]'); a.hidden = !a.hidden; b.setAttribute("aria-expanded", String(!a.hidden)); });</script>`, partner);

const ABOUT = (partner: string) => shell("About", "About us", `<p>We grow plants in Leeds. <a href="/team">Meet the team</a></p>`, partner);
const TEAM = (partner: string) => shell("Team", "The team", `<p>Ada, Grace and Alan.</p>`, partner);

const NEWSLETTER = (done: boolean, partner: string) => shell("Newsletter", "Newsletter", done
  ? `<p class="ok" role="status">Thanks, you're on the list.</p>`
  : `<form action="/newsletter" method="post"><label for="n-email">Email</label><input id="n-email" name="email" type="email"> <p><button>Subscribe</button></p></form>`, partner);

/** What is planted, in plain words (PracticeSite.plants). */
export const GARDEN_PLANTS = [
  "404: the nav's Pricing link goes to /pricing-old",
  "console error on /search: \"Search index failed to load\"",
  "page error on /profile: reading 'name' of undefined",
  "500 on POST /api/cart (Add to cart on /shop)",
  "failed request on /shop: GET /api/recommendations drops the connection",
  "button with no name on /shop (the magnifier icon)",
  "dead button on /settings: Save changes does nothing",
  "form that never sends on /contact: Send message does nothing",
  "slow page: /reports takes 6 s",
] as const;

/** A finding as the judge reads it: an Issue's or an ExploreFinding's kind, title and evidence. */
export interface FoundIssue {
  kind: IssueKind;
  title: string;
  evidence: Evidence;
  /** The page path it was seen on, when known. */
  page?: string;
}

export interface ExpectedIssue {
  id: string;
  /** In plain words. */
  plant: string;
  /** The page it shows on. */
  page: string;
  /** Kinds a correct finder may file it as; the first is the one the data lane is expected to use. */
  kinds: readonly IssueKind[];
  /** Whether a finding is this plant (kind already checked). */
  is(f: FoundIssue): boolean;
}

const words = (f: FoundIssue) => `${f.title} ${f.evidence.text} ${f.evidence.url ?? ""}`;
const statusOk = (f: FoundIssue, s: number) => f.evidence.status === undefined || f.evidence.status === s;
const a11yIs = (f: FoundIssue, k: A11yKind, pageRe: RegExp) => f.evidence.a11y ? f.evidence.a11y.kind === k && pageRe.test(f.evidence.a11y.page) : false;
const frictionIs = (f: FoundIssue, k: FrictionKind) => f.evidence.friction === k;

/** The exact expected issue list for a Discovery run on the bug garden. */
export const GARDEN_ISSUES: readonly ExpectedIssue[] = [
  { id: "g-404", plant: GARDEN_PLANTS[0], page: "/", kinds: ["http_error", "console_error", "explore", "failed_step"], is: (f) => /\/pricing-old\b/.test(words(f)) && statusOk(f, 404) },
  { id: "g-console", plant: GARDEN_PLANTS[1], page: "/search", kinds: ["console_error"], is: (f) => /Search index failed to load/.test(words(f)) },
  { id: "g-pageerror", plant: GARDEN_PLANTS[2], page: "/profile", kinds: ["page_error", "console_error"], is: (f) => /reading 'name'/.test(words(f)) },
  { id: "g-500", plant: GARDEN_PLANTS[3], page: "/shop", kinds: ["http_error", "console_error", "explore", "failed_step"], is: (f) => /\/api\/cart\b/.test(words(f)) && statusOk(f, 500) },
  { id: "g-dropped", plant: GARDEN_PLANTS[4], page: "/shop", kinds: ["http_error", "console_error"], is: (f) => /\/api\/recommendations\b|ERR_EMPTY_RESPONSE/.test(words(f)) },
  { id: "g-noname", plant: GARDEN_PLANTS[5], page: "/shop", kinds: ["a11y", "friction"], is: (f) => a11yIs(f, "no_name", /^\/shop\b/) || (frictionIs(f, "unnamed_control") && /\/shop\b/.test(`${f.page ?? ""} ${words(f)}`)) },
  { id: "g-dead", plant: GARDEN_PLANTS[6], page: "/settings", kinds: ["explore", "friction", "failed_step"], is: (f) => /Save changes/.test(words(f)) },
  { id: "g-nosend", plant: GARDEN_PLANTS[7], page: "/contact", kinds: ["explore", "friction", "failed_step"], is: (f) => /Send message/.test(words(f)) },
  { id: "g-slow", plant: GARDEN_PLANTS[8], page: "/reports", kinds: ["friction", "explore"], is: (f) => (frictionIs(f, "slow") || /\bslow\b|took \d+(\.\d+)? ?s/i.test(words(f))) && /\/reports\b/.test(`${f.page ?? ""} ${words(f)}`) },
];

/** Things that look like a plant and are fine. A finding about any of them is a false alarm. */
export const GARDEN_TRAPS = [
  { page: "/", what: "console.log and console.info lines (not errors); a decorative image with alt=\"\"" },
  { page: "/shop", what: "an icon button named \"Open cart\"; the unnamed magnifier toggles a filter (not dead)" },
  { page: "/search", what: "search works and finds Blue mug, despite the console error" },
  { page: "/settings", what: "Show advanced opens a section (not dead)" },
  { page: "/help", what: "accordion buttons that show answers (not dead)" },
  { page: "/about", what: "Meet the team goes to /team (200)" },
  { page: "/newsletter", what: "Subscribe sends and says thanks (a form that does send)" },
] as const;

export interface GardenSite extends PracticeSite {
  /** http://partner.localhost:<p2>/ (another site). */
  partnerUrl: string;
  /** Every request to the shop, as path + query ("/search?q=mug"), in order (bench Oracle's hits). */
  hits(): string[];
  /** The same with the method: "POST /api/cart". */
  requests(): string[];
  /** Requests that reached the partner site: a Discovery run must leave this at 0. */
  partnerHits(): string[];
}

export async function startBugGarden(o: { port?: number } = {}): Promise<GardenSite> {
  const log: string[] = [];
  const requests: string[] = [];
  const partnerLog: string[] = [];
  let partner = "";

  const shop = await listen(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    log.push(`${url.pathname}${url.search}`);
    requests.push(`${method} ${url.pathname}${url.search}`);
    const s = send(res);
    const p = url.pathname;
    if (p === "/") return s.html(HOME(partner));
    if (p === "/shop") return s.html(SHOP(partner));
    if (p === "/search") return s.html(SEARCH(url.searchParams.get("q") ?? "", partner));
    if (p === "/profile") return s.html(PROFILE(partner));
    if (p === "/reports") { await sleep(SLOW_MS); return s.html(REPORTS(partner)); }
    if (p === "/settings") return s.html(SETTINGS(partner));
    if (p === "/contact") return s.html(CONTACT(partner));
    if (p === "/help") return s.html(HELP(partner));
    if (p === "/about") return s.html(ABOUT(partner));
    if (p === "/team") return s.html(TEAM(partner));
    if (p === "/newsletter" && method === "POST") { await readBody(req); return s.redirect("/newsletter?done=1"); }
    if (p === "/newsletter") return s.html(NEWSLETTER(url.searchParams.get("done") === "1", partner));
    if (p === "/api/cart" && method === "POST") { await readBody(req); return s.json({ error: "cart service unavailable" }, 500); }
    if (p === "/api/recommendations") { req.socket.destroy(); return; }
    return s.html(shell("Not found", "Page not found", `<p><a href="/">Back home</a></p>`, partner), 404);
  }, o.port);

  const other = await listen((req, res) => {
    partnerLog.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    send(res).html(page("Partner", "<main><h1>A partner site</h1></main>"));
  });
  partner = `http://partner.localhost:${other.port}/`;

  return {
    name: "Bug garden (Fernleaf Supply)",
    url: `http://127.0.0.1:${shop.port}/`,
    partnerUrl: partner,
    plants: [...GARDEN_PLANTS],
    hits: () => [...log],
    requests: () => [...requests],
    partnerHits: () => [...partnerLog],
    close: async () => { await Promise.all([shop.close(), other.close()]); },
  };
}
