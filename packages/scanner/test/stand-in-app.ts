import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A client-rendered app the way the stand-in pass meets one: one document for every address, drawn
 * by a script that decides who's signed in from the browser's storage and asks a back end on
 * another address for its data. Two servers, both of which write down everything they receive.
 */
export interface Heard {
  method: string;
  path: string;
  /** The Cookie header it came with, if any. */
  cookie?: string;
}

export interface StandInApp {
  url: string;
  /** Everything the app's own (dev) server received. */
  local: Heard[];
  /** Everything the back end, on another port, received, sockets included. */
  backend: Heard[];
  close(): Promise<void>;
}

const SHELL = `<!doctype html><html lang="en"><head><title>Ledger</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><noscript>Turn on JavaScript</noscript><script src="/app.js"></script></body></html>`;

/** The page's script. Everything past the session check runs only for someone signed in. */
const script = (backend: string, key: string, leaks: boolean, open: boolean, frontLinks: string[], navLinks: string[], pages: Record<string, string>, signedOut: Record<string, string>, wall: string | undefined, unknownGoesTo: string | undefined, reads: string[], own: string) => `
const BACKEND = ${JSON.stringify(backend)};
const root = document.getElementById("root");
const session = ${open} ? { access_token: "x", user: { id: "1", email: "x" } } : (() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(key)})); } catch { return null; } })();
// What a sign-in library does with a session it reads: it saves it back.
if (session && !${open}) localStorage.setItem(${JSON.stringify(key)}, JSON.stringify(session));
const page = location.pathname;
const OPEN = ["/", "/pricing", "/login"];
const draw = (html) => { root.innerHTML = html; };
const nav = '<nav><a href="/trades">Trades</a> <a href="/notes">Notes</a> <a href="/settings">Settings</a> <a href="/admin">Admin</a>' + (${leaks} ? ' <a href="/leaks">Leaks</a>' : "") + ${JSON.stringify(navLinks.map((href) => ` <a href="${href}">${href}</a>`).join(""))} + '</nav>';
const rest = (path, init = {}) => fetch(BACKEND + "/rest/v1/" + path, { ...init, headers: { apikey: "public", authorization: "Bearer " + session.access_token, ...(init.headers || {}) } });
const login = () => draw('<h1>Welcome back</h1><form><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Log in</button></form>');
async function main() {
  if (page === "/") return draw('<h1>Ledger</h1><p>Keep your books in one place, with nothing to install and nothing to learn.</p><a href="/pricing">Pricing</a> <a href="/login">Log in</a>' + ${JSON.stringify(frontLinks.map((href) => ` <a href="${href}">${href}</a>`).join(""))});
  if (page === "/pricing") return draw("<h1>Pricing</h1><p>One plan for everybody who keeps books, with no surprises on the way.</p>");
  const openPages = ${JSON.stringify(signedOut)};
  if (openPages[page]) return draw(openPages[page] + (session ? "<p>Viewing as staff</p>" : ""));
  if (page === "/login" || !session) return login();
  for (const table of ${JSON.stringify(reads)}) await rest(table + "?select=*").then((r) => r.json()).catch(() => []);
  ${own}
  const wall = ${JSON.stringify(wall ?? null)};
  if (wall !== null) return draw(wall.replaceAll("{name}", page.slice(1)));
  const ownPages = ${JSON.stringify(pages)};
  if (ownPages[page] !== undefined) return draw(ownPages[page]);
  if (page === "/trades") {
    const response = await rest("trades?select=*&user_id=eq." + session.user.id);
    const rows = await response.json();
    const list = rows.length ? rows.map((t) => '<li><a href="/trade/' + t.id + '">' + t.symbol + "</a></li>").join("") : "";
    draw(nav + "<main><h1>Trades</h1>" + (rows.length ? "<ul>" + list + "</ul>" : "<p>No trades yet. Once your trades are in, they show here.</p>") + '<button id="add">Add trade</button><button id="broken">Refresh totals</button></main>');
    document.getElementById("add").onclick = () => rest("trades", { method: "POST", headers: { "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify({ symbol: "TEST", side: "buy" }) });
    document.getElementById("broken").onclick = () => { throw new Error("totals are undefined"); };
    return;
  }
  if (page.startsWith("/trade/")) {
    const response = await rest("trades?select=*&id=eq." + page.split("/")[2], { headers: { accept: "application/vnd.pgrst.object+json" } });
    const row = response.ok ? await response.json() : null;
    return draw(nav + "<main><h1>" + (row ? row.symbol : "Trade not found") + "</h1></main>");
  }
  if (page === "/moved") {
    draw(nav + "<main><h1>One moment</h1><p>Taking you to where this lives now, which only takes a moment or so.</p></main>");
    setTimeout(() => {
      history.replaceState(null, "", "/notes");
      draw(nav + "<main><h1>Notes</h1><p>Your notes on how the week went, kept next to the trades they are about.</p></main>");
    }, 150);
    return;
  }
  if (page === "/notes") return draw(nav + "<main><h1>Notes</h1><p>Your notes on how the week went, kept next to the trades they are about.</p></main>");
  if (page === "/settings") return draw(nav + '<main><h1>Settings</h1><form><label>New password <input type="password" name="next"></label><label>Repeat it <input type="password" name="again"></label><button type="submit">Log in again after saving</button></form></main>');
  if (page === "/admin") return draw(nav + (session.user.email === "owner@ledger.example" ? "<main><h1>Admin</h1></main>" : '<main><h1 class="red">Access Denied</h1><p>This page is for the owner.</p></main>'));
  if (page === "/leaks") {
    // Two links that differ by one query value: what the learner checks for itself with a read of its own (see confirmRoutes).
    draw(nav + '<main><h1>Leaks</h1><p>Every way out a page has, tried one after another below.</p><ul><li>Reads</li><li>Saves</li></ul><a href="/api/items?view=one">One</a> <a href="/api/items?view=two">Two</a></main>');
    // What an auth helper does: the session mirrored into a cookie, for the server's own code to read.
    document.cookie = "sb-access-token=" + session.access_token + "; path=/";
    setTimeout(tryEveryWayOut, 200);
    return;
  }
  const home = ${JSON.stringify(unknownGoesTo ?? null)};
  if (home !== null) {
    history.replaceState(null, "", home);
    return draw(ownPages[home] ?? "");
  }
  draw(nav + "<main><h1>Not here</h1><p>Nothing at this address, as far as the app is concerned, sorry.</p></main>");
}
const add = (tag, attrs, inside = document.body) => { const el = document.createElement(tag); Object.assign(el, attrs); inside.appendChild(el); return el; };
function quietly(run) { try { const made = run(); if (made && made.catch) made.catch(() => {}); } catch {} }
function tryEveryWayOut() {
  const tries = [
    () => fetch("/api/secret"),
    () => fetch("/api/save", { method: "POST", body: "{}" }),
    () => fetch(BACKEND + "/fetch-read"),
    () => fetch(BACKEND + "/fetch-write", { method: "POST", body: "{}", headers: { "x-custom": "1", "content-type": "application/json" } }),
    () => fetch(BACKEND + "/keepalive", { method: "POST", body: "{}", keepalive: true }),
    () => fetch(BACKEND + "/no-cors", { mode: "no-cors" }),
    () => { const x = new XMLHttpRequest(); x.open("GET", BACKEND + "/xhr"); x.send(); },
    () => { const x = new XMLHttpRequest(); x.open("POST", "/api/xhr-save"); x.send("{}"); },
    () => navigator.sendBeacon(BACKEND + "/beacon", "{}"),
    () => navigator.sendBeacon("/api/beacon", "{}"),
    () => { new Image().src = BACKEND + "/pixel.png"; },
    () => { new Image().src = "/api/pixel.png"; },
    () => { new Image().src = "/api/track"; },
    // Shaped like files, on a path a dev proxy hands to the real service.
    () => { new Image().src = "/backend/pixel.png"; },
    () => add("script", { src: "/backend/report.js" }),
    () => add("link", { rel: "stylesheet", href: "/backend/theme.css" }, document.head),
    () => add("link", { rel: "preload", as: "image", href: "/backend/preloaded.png" }, document.head),
    () => add("iframe", { src: "/backend/report" }),
    () => add("object", { data: "/backend/object.png" }),
    // What a page's rules are never shown.
    () => fetchLater("/api/fetchlater", { method: "POST", activateAfter: 0 }),
    () => fetchLater("/backend/orders", { method: "POST", activateAfter: 0, headers: { authorization: "Bearer " + session.access_token } }),
    () => add("script", { type: "speculationrules", textContent: JSON.stringify({ prefetch: [{ source: "list", urls: ["/api/specprefetch"], eagerness: "immediate" }] }) }),
    () => CSS.paintWorklet.addModule("/api/paintworklet.js"),
    () => new AudioContext().audioWorklet.addModule("/api/audioworklet.js"),
    () => new AudioContext().audioWorklet.addModule("/backend/audioworklet.js"),
    () => add("link", { rel: "modulepreload", href: "/backend/modulepreload.js" }, document.head),
    () => add("script", { src: BACKEND + "/other.js" }),
    () => add("script", { src: "/hop.js" }),
    () => add("script", { src: "/api/config.js" }),
    () => add("link", { rel: "stylesheet", href: BACKEND + "/other.css" }, document.head),
    () => add("link", { rel: "preconnect", href: BACKEND }, document.head),
    () => add("link", { rel: "prefetch", href: BACKEND + "/prefetched" }, document.head),
    () => add("link", { rel: "preload", as: "font", href: BACKEND + "/f.woff2", crossOrigin: "anonymous" }, document.head),
    () => add("style", { textContent: "@import url(" + BACKEND + "/imported.css); body { background: url(" + BACKEND + "/bg.png); }" }, document.head),
    () => add("iframe", { src: BACKEND + "/frame" }),
    () => add("iframe", { src: "/api/frame" }),
    () => add("audio", { src: BACKEND + "/sound.mp3", autoplay: true }),
    () => add("video", { src: "/api/movie.mp4", autoplay: true, muted: true }),
    () => { const a = add("a", { href: "#here", textContent: "ping" }); a.ping = BACKEND + "/ping"; a.click(); },
    () => new EventSource(BACKEND + "/stream"),
    () => new EventSource("/api/stream"),
    () => new WebSocket(BACKEND.replace("http", "ws") + "/socket"),
    () => new WebSocket("ws://" + location.host + "/hmr"),
    () => new Worker("/worker.js"),
    () => new Worker("/hop-worker.js"),
    () => new Worker(URL.createObjectURL(new Blob(["fetch(" + JSON.stringify(BACKEND + "/blob-worker") + ")"], { type: "text/javascript" }))),
    () => new Worker(URL.createObjectURL(new Blob(["new WebSocket(" + JSON.stringify(BACKEND.replace("http", "ws") + "/blob-worker-socket") + ")"], { type: "text/javascript" }))),
    () => new Worker("data:text/javascript," + encodeURIComponent("fetch(" + JSON.stringify(BACKEND + "/data-worker") + "); new WebSocket(" + JSON.stringify(BACKEND.replace("http", "ws") + "/data-worker-socket") + ")")),
    () => { const frame = add("iframe", {}); new frame.contentWindow.WebSocket(BACKEND.replace("http", "ws") + "/frame-socket"); },
    () => { const frame = add("iframe", {}); new frame.contentWindow.WebSocket("ws://" + location.host + "/frame-hmr"); },
    () => { const frame = add("iframe", {}); new frame.contentWindow.Worker("/worker.js"); },
    () => { const frame = add("iframe", {}); frame.contentWindow.fetch(BACKEND + "/frame-fetch"); },
    () => { const frame = add("iframe", { srcdoc: "<script>new WebSocket(" + JSON.stringify(BACKEND.replace("http", "ws") + "/srcdoc-socket") + "); fetch(" + JSON.stringify(BACKEND + "/srcdoc-fetch") + ")<\\/script>" }); frame.sandbox = "allow-scripts"; },
    () => new SharedWorker("/worker.js"),
    () => navigator.serviceWorker.register("/worker.js"),
    () => import(BACKEND + "/module.js"),
    () => new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.example.com" }] }),
    () => new WebTransport(BACKEND.replace("http", "https") + "/wt"),
    () => { const form = add("form", { action: BACKEND + "/form", method: "post" }); form.submit(); },
    () => setTimeout(() => { location.href = BACKEND + "/left"; }, 2000),
  ];
  for (const go of tries) quietly(go);
}
main();
`;

export async function standInApp(options: { key?: string; leaks?: boolean; open?: boolean; frontLinks?: string[]; navLinks?: string[]; document?: (path: string) => { status: number; headers?: Record<string, string>; body?: string } | undefined; /** Screens behind the session check, by address. */ pages?: Record<string, string>; /** Screens drawn with or without a session. */ openPages?: Record<string, string>; /** How long the server takes over the start's document. */ slowFrontMs?: number; /** Drawn at every address past the session check, with {name} for the address. */ wall?: string; /** Where the app's router moves an address it doesn't know. */ unknownGoesTo?: string; /** Tables read before anything's drawn, whatever's drawn. */ reads?: string[]; /** Script of the app's own, run past the session check, for screens that do something. */ own?: string } = {}): Promise<StandInApp> {
  const backend: Heard[] = [];
  const local: Heard[] = [];
  const hear = (list: Heard[], req: http.IncomingMessage) => list.push({ method: req.method ?? "?", path: new URL(req.url ?? "/", "http://x").pathname, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) });
  const back = http.createServer((req, res) => {
    hear(backend, req);
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }).end("[]");
  });
  back.on("upgrade", (req, socket) => {
    hear(backend, req);
    socket.destroy();
  });
  await new Promise<void>((resolve) => back.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${(back.address() as AddressInfo).port}`;
  const app = http.createServer(async (req, res) => {
    hear(local, req);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    // A dev server's proxy: what it's given goes to the real service, and the recording there is the test.
    if (path.startsWith("/backend/")) {
      hear(backend, req);
      return res.writeHead(200, { "content-type": "text/plain" }).end("from the real service");
    }
    if (path === "/" && options.slowFrontMs) await new Promise((resolve) => setTimeout(resolve, options.slowFrontMs));
    const own = options.document?.(path);
    if (own) return res.writeHead(own.status, { "content-type": "text/html", ...own.headers }).end(own.body ?? "");
    if (path === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(script(backendUrl, options.key ?? "sb-ledger-auth-token", options.leaks === true, options.open === true, options.frontLinks ?? [], options.navLinks ?? [], options.pages ?? {}, options.openPages ?? {}, options.wall, options.unknownGoesTo, options.reads ?? [], options.own ?? ""));
    if (path === "/app.css") return res.writeHead(200, { "content-type": "text/css" }).end("h1 { color: #222; }");
    if (path === "/worker.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(`fetch(${JSON.stringify(`${backendUrl}/worker-fetch`)}); fetch("/api/worker", { method: "POST", body: "{}" }); new WebSocket(${JSON.stringify(`${backendUrl.replace("http", "ws")}/worker-socket`)}); importScripts(${JSON.stringify(`${backendUrl}/imported-script.js`)}); new Worker("/nested.js");`);
    if (path === "/nested.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(`fetch(${JSON.stringify(`${backendUrl}/nested-fetch`)});`);
    if (path === "/hop.js" || path === "/hop-worker.js") return res.writeHead(302, { location: `${backendUrl}/hopped.js` }).end();
    if (path.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (/\.\w+$/.test(path)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).end(SHELL);
  });
  app.on("upgrade", (req, socket) => {
    hear(local, req);
    socket.destroy();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(app.address() as AddressInfo).port}/`,
    local, backend,
    close: async () => {
      app.closeAllConnections();
      back.closeAllConnections();
      await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => back.close(resolve))]);
    },
  };
}
