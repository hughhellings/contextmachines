/**
 * A zoo app of common single-page-app shapes (wave M1, from the M1 review's coverage findings):
 * "Tallybook", a small client book. It is there so the walk is tested on shapes the other zoo apps
 * don't have, not on any one site: each shape below is one many apps use.
 *
 *   - Hash routes: one page, its views at #/, #/clients, #/clients/<id>, #/settings.
 *   - A side menu that is a plain <ul> of links outside <main>, not in a <nav>.
 *   - A form with no method attribute, sent by its script (PATCH api/clients/<id>).
 *   - A row menu: each client row's "More" button opens a role=menu with Duplicate and Archive.
 *   - Tabs (role=tab) on #/settings: Profile (shown) and Billing (hidden until pressed, PUT api/billing).
 *   - A button inside <nav> that shows another part of the page with no address of its own (Reports).
 *   - A link with plain words ("Start fresh") whose GET ends the session.
 *
 * Every write it receives (anything but GET, HEAD, OPTIONS, the sign-in aside, and the session-ending
 * GET) is logged in `writes`. Signed out, every page sends you to /login.
 * The account is this file's fixture (SHAPES_ACCOUNT): no real service, nobody's real details.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const SHAPES_ACCOUNT = { email: "keeper@example.test", password: "shapes-fixture-only" } as const;
export const SHAPES_SIGNED_IN_TEXT = "Signed in as keeper@example.test";

export interface ShapesServer {
  url: string;
  origin: string;
  writes: string[];
  /** Each time the session-ending GET was opened. */
  sessionEnds: number;
  storageState(): Promise<{ cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" }[]; origins: never[] }>;
  close(): Promise<void>;
}

const APP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tallybook</title>
<style>body{font:15px system-ui,sans-serif;margin:0;display:grid;grid-template-columns:180px 1fr}.top{grid-column:1/3;padding:8px 16px;background:#234;color:#fff}.top a,.top button{color:#fff}.side{padding:12px}main{padding:16px}td,th{border:1px solid #ccc;padding:4px 8px}[role=menu]{border:1px solid #999;padding:4px;background:#fff}label{display:block;margin-top:8px}</style></head>
<body><div class="top"><strong>Tallybook</strong> <span>${SHAPES_SIGNED_IN_TEXT}</span> <nav aria-label="Areas"><button type="button" id="reports">Reports</button></nav> <a href="fresh">Start fresh</a></div>
<div class="side"><ul><li><a href="#/">Overview</a></li><li><a href="#/clients">Clients</a></li><li><a href="#/settings">Settings</a></li></ul></div>
<main id="view"></main>
<script>
const clients = [{ id: 1, name: "Acme Ltd", city: "Leeds" }, { id: 2, name: "Bolt & Co", city: "York" }];
const v = document.getElementById("view");
const send = (method, url, body) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
function draw() {
  const h = location.hash.replace(/^#/, "") || "/";
  const m = /^\\/clients\\/(\\d+)$/.exec(h);
  if (h === "/clients") {
    v.innerHTML = "<h1>Clients</h1><table><thead><tr><th>Name</th><th>City</th><th></th></tr></thead><tbody>" + clients.map((c) => '<tr><td><a href="#/clients/' + c.id + '">' + c.name + "</a></td><td>" + c.city + '</td><td><button type="button" class="more" aria-haspopup="menu">More</button><div role="menu" hidden><button role="menuitem" class="dup">Duplicate</button><button role="menuitem" class="arc">Archive</button></div></td></tr>').join("") + "</tbody></table>";
    v.querySelectorAll(".more").forEach((b, i) => { b.onclick = () => { b.nextElementSibling.hidden = !b.nextElementSibling.hidden; }; });
    v.querySelectorAll(".dup").forEach((b, i) => { b.onclick = () => send("POST", "api/clients/" + clients[i].id + "/duplicate", {}); });
    v.querySelectorAll(".arc").forEach((b, i) => { b.onclick = () => send("PATCH", "api/clients/" + clients[i].id, { archived: true }); });
  } else if (m) {
    const c = clients.find((x) => String(x.id) === m[1]) || clients[0];
    v.innerHTML = '<h1>' + c.name + '</h1><h2>Edit client</h2><form id="edit"><label for="cn">Client name</label><input id="cn" name="name" value="' + c.name + '"><label for="cc">City</label><input id="cc" name="city" value="' + c.city + '"><button type="submit">Save changes</button></form>';
    document.getElementById("edit").onsubmit = (e) => { e.preventDefault(); send("PATCH", "api/clients/" + c.id, { name: document.getElementById("cn").value, city: document.getElementById("cc").value }); };
  } else if (h === "/settings") {
    v.innerHTML = '<h1>Settings</h1><div role="tablist"><button role="tab" id="t1" aria-selected="true" aria-controls="p1">Profile</button><button role="tab" id="t2" aria-selected="false" aria-controls="p2">Billing</button></div>'
      + '<section id="p1" role="tabpanel"><h2>Profile</h2><form id="pf"><label for="dn">Display name</label><input id="dn" name="displayName" value="Keeper"><button type="submit">Save profile</button></form></section>'
      + '<section id="p2" role="tabpanel" hidden><h2>Billing address</h2><form id="bf"><label for="ad">Street address</label><input id="ad" name="street"><label for="pc">Postcode</label><input id="pc" name="postcode"><button type="submit">Save billing</button></form></section>';
    const tabs = [["t1", "p1"], ["t2", "p2"]];
    for (const [t, p] of tabs) document.getElementById(t).onclick = () => { for (const [t2, p2] of tabs) { document.getElementById(t2).setAttribute("aria-selected", String(t2 === t)); document.getElementById(p2).hidden = p2 !== p; } };
    document.getElementById("pf").onsubmit = (e) => { e.preventDefault(); send("PUT", "api/profile", { displayName: document.getElementById("dn").value }); };
    document.getElementById("bf").onsubmit = (e) => { e.preventDefault(); send("PUT", "api/billing", { street: document.getElementById("ad").value, postcode: document.getElementById("pc").value }); };
  } else {
    v.innerHTML = "<h1>Overview</h1><p>2 clients</p>";
  }
}
document.getElementById("reports").onclick = () => { v.innerHTML = "<h1>Reports</h1><h2>Monthly totals</h2><ul><li>October: 4 invoices</li><li>November: 2 invoices</li></ul>"; };
addEventListener("hashchange", draw);
draw();
</script></body></html>`;

export async function startShapes(): Promise<ShapesServer> {
  const id = randomBytes(5).toString("hex");
  const base = `/z/${id}/`;
  const sessions = new Set<string>();
  const writes: string[] = [];
  let sessionEnds = 0;
  const sidOf = (req: IncomingMessage) => {
    const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
    return sid && sessions.has(sid) ? sid : undefined;
  };
  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://shapes");
    const method = req.method ?? "GET";
    if (!u.pathname.startsWith(base)) return send(res, 404, "text/plain", "not found");
    const rest = u.pathname.slice(base.length);
    if (rest === "login") return send(res, 200, "text/html; charset=utf-8", `<!doctype html><title>Sign in · Tallybook</title><h1>Sign in</h1><form method="post" action="login"><input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>`);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(`${method} /${rest}`);
      req.resume();
      return send(res, 200, "application/json", "{}");
    }
    const sid = sidOf(req);
    if (rest === "fresh") {
      // Plain words, an ordinary address: opening it ends the session.
      sessionEnds++;
      if (sid) sessions.delete(sid);
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    if (!sid) {
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    if (rest === "") return send(res, 200, "text/html; charset=utf-8", APP);
    return send(res, 404, "text/html", "<!doctype html><title>Not found</title><h1>Not found</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}${base}`,
    origin,
    writes,
    get sessionEnds() {
      return sessionEnds;
    },
    async storageState() {
      const sid = randomBytes(8).toString("hex");
      sessions.add(sid);
      return { cookies: [{ name: "sid", value: sid, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const }], origins: [] };
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
