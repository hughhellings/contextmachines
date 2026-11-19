/**
 * The trap zoo app (any-site plan 2.2, wave M1): one signed-in app whose pages try every way a page
 * can write without a Save, so map mode's 0-writes promise is tested against pages that try to break
 * it, not only friendly ones. Node's http on 127.0.0.1, a free port, under /z/<id>/ like the zoo.
 *
 * The traps, by page:
 *   ""          Notes: a POST on load (presence, mark as read), a delayed autosave after typing, an
 *               autosave on blur (PATCH), a token refresh POST on a timer, and a real "New note" form.
 *   live        A WebSocket board: the page says hello and saves cards over the socket.
 *   activity    sendBeacon on load and on leaving, a service worker with background sync, and an
 *               IndexedDB outbox that replays a save on load.
 *   actions     Server actions: one POST that only reads (totals), one that writes (profile name).
 *   projects    GraphQL: a read query on load (may pass), a mutation hidden in a batch, a persisted
 *               query by hash (POST and GET).
 *   team        A GET that accepts an invite, a GET delete link, a notification whose link marks it
 *               read on GET, and a sign-out link (a GET).
 * With `moves` (the M1 review's ways past the hold), four more pages, linked from the navigation:
 *   moves       Moves itself to a commanding GET by script (location.replace), carries speculation
 *               rules that prefetch a delete address (in the page and in a header), and pings plain
 *               GET jobs (/jobs/5/retry, /api/sync, /items/5/duplicate) from images.
 *   refresh     A meta refresh to /notifications/mark-all-read.
 *   tools       A button whose handler navigates to /items?action=delete&id=7, and an iframe whose
 *               address a script changes to /members/8/delete.
 *   reports     A plain link that redirects (302) to /members/9/delete.
 *
 * Its server logs every write it receives, of any kind, in `writes`: every request that isn't a GET,
 * HEAD or OPTIONS (the sign-in POST alone goes to `auth`), every socket frame from a page, every GET
 * that changes something (invite, delete, notification, sign-out), and every GraphQL mutation or
 * persisted operation. The M1 gate: 0 entries in `writes` during mapping.
 *
 * The account is a fixture of this file (TRAP_ACCOUNT): no real service, nobody's real details.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** The fixture account: test values for this local app only. */
export const TRAP_ACCOUNT = { email: "tester@example.test", password: "trap-fixture-only" } as const;
/** What a signed-in page always shows (the account's signed-in words). */
export const TRAP_SIGNED_IN_TEXT = "Signed in as tester@example.test";

export interface TrapWrite {
  at: number;
  /** "POST /api/presence", "WS hello", "GET /team/invite/accept", "GQL mutation MarkSeen"... */
  what: string;
}

export interface TrapServer {
  /** http://127.0.0.1:<port>/z/<id>/ : the app's start address. */
  url: string;
  origin: string;
  writes: TrapWrite[];
  auth: TrapWrite[];
  /** Every request, method and path (no query values). */
  requests: string[];
  /** Signs in over HTTP (outside any browser): the cookie header for a session, for a fixture storageState. */
  signIn(): Promise<string>;
  /** A Playwright storageState signed in as the fixture account. */
  storageState(): Promise<{ cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" }[]; origins: never[] }>;
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function startTrap(o: { sessionMs?: number; moves?: boolean } = {}): Promise<TrapServer> {
  const id = randomBytes(5).toString("hex");
  const base = `/z/${id}/`;
  const sessionMs = o.sessionMs ?? 30 * 60_000;
  const sessions = new Map<string, number>();
  const writes: TrapWrite[] = [];
  const auth: TrapWrite[] = [];
  const requests: string[] = [];
  const begun = Date.now();
  const write = (what: string) => writes.push({ at: Date.now() - begun, what });
  const notes = [
    { id: 1, title: "Kick-off agenda", body: "Goals and owners" },
    { id: 2, title: "Retro actions", body: "Three things to change" },
  ];
  const members = [
    { id: 7, name: "Robin Test" },
    { id: 8, name: "Sam Example" },
  ];
  const projects = [
    { id: 1, name: "Harbour wall" },
    { id: 2, name: "North path" },
  ];

  const sessionOf = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
    const until = sid ? sessions.get(sid) : undefined;
    return sid && until && until > Date.now() ? sid : undefined;
  };

  const shell = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Trapline</title>
<style>body{font:15px system-ui,sans-serif;margin:0}header{display:flex;gap:14px;padding:10px 16px;background:#233;color:#fff}header a{color:#fff}main{padding:16px}td,th{border:1px solid #ccc;padding:4px 8px}table{border-collapse:collapse}label{display:block;margin-top:8px;font-weight:600}</style></head>
<body><header><strong>Trapline</strong><nav><a href="./">Notes</a> <a href="live">Live</a> <a href="activity">Activity</a> <a href="actions">Actions</a> <a href="projects">Projects</a> <a href="team">Team</a>${o.moves ? ` <a href="moves">Moves</a> <a href="refresh">Inbox</a> <a href="tools">Tools</a> <a href="go">Reports</a>` : ""}</nav><span>${esc(TRAP_SIGNED_IN_TEXT)}</span> <a href="logout">Sign out</a></header>
<main>${body}</main>
<script>
// Every signed-in page refreshes its token with a POST on a timer.
setInterval(() => fetch("api/session/refresh", { method: "POST" }).catch(() => {}), 1500);
${script}
</script></body></html>`;

  const pages: Record<string, () => string> = {
    "": () =>
      shell(
        "Notes",
        `<h1>Notes</h1><table><thead><tr><th>Title</th><th>Body</th></tr></thead><tbody>${notes.map((n) => `<tr><td>${esc(n.title)}</td><td>${esc(n.body)}</td></tr>`).join("")}</tbody></table>
<h2>New note</h2><form method="post" action="api/notes"><label for="t">Title</label><input id="t" name="title" required><label for="b">Body</label><textarea id="b" name="body"></textarea><button type="submit">Save note</button></form>
<h2>Scratchpad</h2><label for="draft">Draft</label><textarea id="draft" name="draft"></textarea><p class="muted">Saves as you type.</p>`,
        `
fetch("api/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ here: true }) }).catch(() => {});
fetch("api/notes/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1, 2] }) }).catch(() => {});
let timer;
document.getElementById("draft").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => fetch("api/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: e.target.value }) }).catch(() => {}), 1200); });
document.getElementById("t").addEventListener("blur", (e) => { if (e.target.value) fetch("api/drafts/title", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: e.target.value }) }).catch(() => {}); });`,
      ),
    live: () =>
      shell(
        "Live board",
        `<h1>Live board</h1><ul id="cards"></ul><h2>New card</h2><label for="c">Card title</label><input id="c" name="card"><button type="button" id="add">Save card</button><p id="state" role="status"></p>`,
        `
const ws = new WebSocket(location.href.replace(/^http/, "ws").replace(/live$/, "") + "ws");
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", user: "me" }));
ws.onmessage = (m) => { const li = document.createElement("li"); li.textContent = String(m.data); document.getElementById("cards").appendChild(li); };
document.getElementById("add").onclick = () => { ws.send(JSON.stringify({ action: "card.create", title: document.getElementById("c").value })); document.getElementById("state").textContent = "Sent"; };`,
      ),
    activity: () =>
      shell(
        "Activity",
        `<h1>Activity</h1><ul id="feed"><li>Robin added a note</li><li>Sam joined the team</li></ul><p id="outbox"></p>`,
        `
navigator.sendBeacon("api/track", JSON.stringify({ event: "view", page: "activity" }));
addEventListener("pagehide", () => navigator.sendBeacon("api/track", JSON.stringify({ event: "leave" })));
if (navigator.serviceWorker) navigator.serviceWorker.register("sw.js").then((r) => r.sync && r.sync.register("outbox")).catch(() => {});
// An offline outbox: a save kept in IndexedDB, replayed when the page loads.
const open = indexedDB.open("outbox", 1);
open.onupgradeneeded = () => open.result.createObjectStore("ops", { autoIncrement: true });
open.onsuccess = () => {
  const db = open.result;
  const tx = db.transaction("ops", "readwrite");
  tx.objectStore("ops").add({ op: "note.create", title: "Saved offline" });
  tx.oncomplete = () => {
    const all = db.transaction("ops").objectStore("ops").getAll();
    all.onsuccess = () => Promise.all(all.result.map((op) => fetch("api/outbox/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) }))).then(() => { document.getElementById("outbox").textContent = "Outbox sent"; }).catch(() => { document.getElementById("outbox").textContent = "Outbox waiting"; });
  };
};`,
      ),
    actions: () =>
      shell(
        "Actions",
        `<h1>Account</h1><p>Open notes: <strong id="total">?</strong></p><button type="button" id="refresh">Refresh totals</button>
<h2>Profile</h2><label for="pn">Display name</label><input id="pn" name="displayName" value="Tester"><button type="button" id="saveprofile">Save profile</button><p id="said" role="status"></p>`,
        `
const act = (id, args) => fetch("actions", { method: "POST", headers: { "next-action": id, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify(args) }).then((r) => r.json());
const totals = () => act("a1f0c0de", []).then((j) => { document.getElementById("total").textContent = j.open; }).catch(() => {});
totals();
document.getElementById("refresh").onclick = totals;
document.getElementById("saveprofile").onclick = () => act("b2e0beef", [{ displayName: document.getElementById("pn").value }]).then(() => { document.getElementById("said").textContent = "Saved"; }).catch(() => {});`,
      ),
    projects: () =>
      shell(
        "Projects",
        `<h1>Projects</h1><ul id="plist"><li class="muted">Loading…</li></ul>`,
        `
const gql = (body) => fetch("graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
gql({ operationName: "Projects", query: "query Projects { projects { id name } }" }).then((j) => {
  document.getElementById("plist").innerHTML = (j.data && j.data.projects || []).map((p) => "<li>" + p.name + "</li>").join("");
}).catch(() => {});
gql([{ operationName: "Me", query: "query Me { me { email } }" }, { operationName: "MarkSeen", query: "mutation MarkSeen { markSeen(page: \\"projects\\") }" }]).catch(() => {});
gql({ operationName: "TrackView", extensions: { persistedQuery: { version: 1, sha256Hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" } } }).catch(() => {});
fetch("graphql?operationName=TrackView&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" } }))).catch(() => {});`,
      ),
    team: () =>
      shell(
        "Team",
        `<h1>Team</h1><table><thead><tr><th>Name</th><th></th></tr></thead><tbody>${members.map((m) => `<tr><td>${esc(m.name)}</td><td><a href="members/${m.id}/delete">Remove</a></td></tr>`).join("")}</tbody></table>
<p>You have an invite to Harbour crew: <a href="invite/accept?token=demo-invite-1">Join Harbour crew</a></p>
<aside id="notifications" aria-label="Notifications"><h2>Notifications</h2><ul><li><a href="notifications/12/open">Robin mentioned you</a></li></ul></aside>`,
      ),
  };

  if (o.moves) {
    pages.moves = () =>
      shell(
        "Moves",
        `<h1>Moves</h1><p>Moving on…</p><script type="speculationrules">{"prefetch":[{"source":"list","urls":["items/10/delete"]}]}</script>${["jobs/5/retry", "api/sync", "items/5/duplicate"].map((u) => `<img alt="" src="${u}">`).join("")}`,
        `const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: ["items/11/delete"] }] }); document.head.append(s);
setTimeout(() => location.replace("items/5/delete"), 400);`,
      );
    pages.refresh = () => `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=notifications/mark-all-read"><title>Inbox · Trapline</title><p>${esc(TRAP_SIGNED_IN_TEXT)}</p>`;
    pages.tools = () =>
      shell(
        "Tools",
        `<h1>Tools</h1><button type="button" id="showall">Show all</button><iframe id="side" title="side" src="about:blank"></iframe>`,
        `document.getElementById("showall").onclick = () => { location.href = "items?action=delete&id=7"; };
setTimeout(() => { document.getElementById("side").src = "members/8/delete"; }, 300);`,
      );
  }

  const server = createServer((req, res) => void handle(req, res).catch(() => send(res, 500, "text/plain", "error")));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://trap");
    const method = req.method ?? "GET";
    requests.push(`${method} ${u.pathname}`);
    if (!u.pathname.startsWith(base)) return send(res, 404, "text/plain", "not found");
    const rest = u.pathname.slice(base.length);
    const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
    if (rest === "login") {
      if (method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("email") === TRAP_ACCOUNT.email && f.get("password") === TRAP_ACCOUNT.password) {
          const sid = randomBytes(8).toString("hex");
          sessions.set(sid, Date.now() + sessionMs);
          auth.push({ at: Date.now() - begun, what: "POST /login ok" });
          res.writeHead(303, { location: base, "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
          return void res.end();
        }
        auth.push({ at: Date.now() - begun, what: "POST /login refused" });
      }
      return send(res, 200, "text/html; charset=utf-8", `<!doctype html><title>Sign in · Trapline</title><h1>Sign in</h1><form method="post" action="login"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`);
    }
    if (o.moves && rest === "rules.json") return send(res, 200, "application/speculationrules+json", JSON.stringify({ prefetch: [{ source: "list", urls: [`${base}items/12/delete`] }] }));
    if (rest === "sw.js") return send(res, 200, "text/javascript", `self.addEventListener("sync", (e) => e.waitUntil(fetch("api/outbox/sync", { method: "POST", body: "{}" })));`);
    const sid = sessionOf(req);
    // Everything that isn't a read is a write the server logs, signed in or not.
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (rest === "graphql") {
        const ops = gqlOps(body);
        const kinds = ops.map((x) => x.kind);
        if (kinds.length && kinds.every((k) => k === "query")) {
          return send(res, 200, "application/json", JSON.stringify(Array.isArray(safeJson(body)) ? ops.map(() => ({ data: {} })) : { data: { projects } }));
        }
        for (const x of ops) if (x.kind !== "query") write(`GQL ${x.kind} ${x.name}`);
        return send(res, 200, "application/json", JSON.stringify({ data: {} }));
      }
      if (rest === "actions" && req.headers["next-action"] === "a1f0c0de") {
        // A server action that only reads: logged as a write anyway when it arrives, since the gate is "no POST leaves".
        write(`POST /actions (read action)`);
        return send(res, 200, "application/json", JSON.stringify({ open: notes.length }));
      }
      write(`${method} /${rest}`);
      if (rest === "api/session/refresh" && sid) sessions.set(sid, Date.now() + sessionMs);
      if (rest === "api/notes" && sid) {
        const f = new URLSearchParams(body);
        notes.push({ id: notes.length + 1, title: f.get("title") ?? "", body: f.get("body") ?? "" });
        res.writeHead(303, { location: base });
        return void res.end();
      }
      return send(res, 200, "application/json", "{}");
    }
    if (rest === "graphql") {
      // A persisted query by GET: the server runs whatever the hash names (here, a write).
      if (u.searchParams.has("extensions")) write(`GQL persisted GET ${u.searchParams.get("operationName") ?? ""}`);
      return send(res, 200, "application/json", JSON.stringify({ data: {} }));
    }
    if (rest === "logout") {
      if (sid) sessions.delete(sid);
      write("GET /logout");
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    if (o.moves) {
      // Every GET these pages try that writes, prefetches and pings included.
      if (/^items\/\d+\/delete$/.test(rest) || rest === "notifications/mark-all-read" || (rest === "items" && u.searchParams.get("action") === "delete") || ["jobs/5/retry", "api/sync", "items/5/duplicate"].includes(rest)) {
        write(`GET /${rest}${u.search ? "?" + [...u.searchParams.keys()].join("&") : ""}${req.headers["sec-purpose"] ? ` [${String(req.headers["sec-purpose"])}]` : ""}`);
        return send(res, 200, "text/html; charset=utf-8", "<!doctype html><title>Done</title><p>done</p>");
      }
      if (rest === "go") {
        res.writeHead(302, { location: `${base}members/9/delete` });
        return void res.end();
      }
    }
    if (/^members\/\d+\/delete$/.test(rest) || rest === "invite/accept" || /^notifications\/\d+\/open$/.test(rest)) {
      write(`GET /${rest}`);
      res.writeHead(303, { location: `${base}team` });
      return void res.end();
    }
    if (!sid) {
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    const page = pages[rest];
    if (!page) return send(res, 404, "text/html", "<!doctype html><title>Not found</title><h1>Not found</h1>");
    if (o.moves && rest === "moves") {
      // Speculation rules by header too: the rules file prefetches another delete address.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "speculation-rules": `"${base}rules.json"` });
      return void res.end(page());
    }
    return send(res, 200, "text/html; charset=utf-8", page());
  }

  // WebSocket: a hand-made server (RFC 6455, text frames), so the app needs nothing installed.
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    const u = new URL(req.url ?? "/", "http://trap");
    if (u.pathname !== `${base}ws` || !sessionOf(req)) return void socket.destroy();
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(frame("Board: 2 cards"));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.size);
        if (f.op === 8) return void socket.end();
        if (f.op === 1 || f.op === 2) {
          let what = "message";
          try {
            const j = JSON.parse(f.data.toString("utf8")) as Record<string, unknown>;
            what = String(j.type ?? j.action ?? "message");
          } catch {
            // not JSON
          }
          write(`WS ${what}`);
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const signIn = async () => {
    const r = await fetch(`${origin}${base}login`, { method: "POST", body: new URLSearchParams({ email: TRAP_ACCOUNT.email, password: TRAP_ACCOUNT.password }), redirect: "manual" });
    const cookie = r.headers.get("set-cookie") ?? "";
    return /sid=[0-9a-f]+/.exec(cookie)?.[0] ?? "";
  };
  return {
    url: `${origin}${base}`,
    origin,
    writes,
    auth,
    requests,
    signIn,
    async storageState() {
      const sid = (await signIn()).replace(/^sid=/, "");
      return { cookies: [{ name: "sid", value: sid, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const }], origins: [] };
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) break;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** The server's own reading of a GraphQL body: each operation's kind and name; a hash-only one is "persisted". */
function gqlOps(body: string): { kind: string; name: string }[] {
  const j = safeJson(body);
  const ops = (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  return ops.map((x) => {
    const name = typeof x.operationName === "string" ? x.operationName : "";
    if (typeof x.query !== "string") return { kind: "persisted", name };
    const m = /^\s*(query|mutation|subscription)\b/.exec(x.query);
    return { kind: m ? m[1]! : "query", name };
  });
}

/** A server's text frame (unmasked). */
function frame(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

/** One whole frame from a client (masked), or undefined until it has all arrived. */
function readFrame(buf: Buffer): { op: number; data: Buffer; size: number } | undefined {
  if (buf.length < 2) return undefined;
  const op = buf[0]! & 0x0f;
  let len = buf[1]! & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const masked = (buf[1]! & 0x80) !== 0;
  const mask = masked ? buf.subarray(at, at + 4) : undefined;
  if (masked) at += 4;
  if (buf.length < at + len) return undefined;
  const data = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i]! ^= mask[i % 4]!;
  return { op, data, size: at + len };
}
