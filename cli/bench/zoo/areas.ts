/**
 * A zoo app behind a fixture sign-in, with several areas (wave M1): "Fieldbook", a small project
 * tracker. It is there to show what M1 claims and the 2-page zoo apps can't: a signed-in map, and
 * breadth before depth over sections, a detail page, a form opened by a button, an empty list, a
 * filter, a search, counts and totals, switches, a prefilled edit form, row controls, and controls on
 * the floor (export, delete account). Node's http on 127.0.0.1, a free port, under /z/<id>/.
 *
 *   ""                Dashboard: counts, links to each area.
 *   projects          Projects table (row Archive and Delete), a search box (GET), "New project" link.
 *   projects/new      The new-project form (POST api/projects).
 *   projects/<id>     A project's details and its prefilled edit form (POST api/projects/<id>).
 *   tasks             No tasks yet (empty state), a status filter (GET), "New task" opens a dialog form.
 *   reports           Totals, and an "Export CSV" button (a download).
 *   settings          A prefilled profile form, notification switches that save when pressed, and
 *                     "Delete account".
 *
 * Every write it receives (anything but GET, HEAD, OPTIONS, the sign-in aside) is logged in `writes`;
 * every stored change is in `changes`. Signed out, every page but /login sends you to /login.
 * The account is this file's fixture (AREAS_ACCOUNT): no real service, nobody's real details.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const AREAS_ACCOUNT = { email: "lead@example.test", password: "areas-fixture-only" } as const;
export const AREAS_SIGNED_IN_TEXT = "Signed in as lead@example.test";

export interface AreasServer {
  url: string;
  origin: string;
  writes: string[];
  changes: string[];
  requests: string[];
  storageState(): Promise<{ cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" }[]; origins: never[] }>;
  close(): Promise<void>;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function startAreas(): Promise<AreasServer> {
  const id = randomBytes(5).toString("hex");
  const base = `/z/${id}/`;
  const sessions = new Set<string>();
  const writes: string[] = [];
  const changes: string[] = [];
  const requests: string[] = [];
  const clients = ["Harbour Trust", "North Council", "Riverside Ltd"];
  const projects = [
    { id: 11, name: "Harbour wall survey", client: "Harbour Trust", budget: 5000, status: "Active" },
    { id: 12, name: "North path repairs", client: "North Council", budget: 4500, status: "Active" },
    { id: 13, name: "Riverside lighting", client: "Riverside Ltd", budget: 3000, status: "Archived" },
  ];
  const tasks: { title: string; status: string }[] = [];
  const settings = { mentions: true, digest: false };

  const shell = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><base href="${base}"><title>${esc(title)} · Fieldbook</title>
<style>body{font:15px system-ui,sans-serif;margin:0}header{display:flex;gap:14px;padding:10px 16px;background:#243;color:#fff}header a{color:#fff}main{padding:16px;max-width:820px}td,th{border:1px solid #ccc;padding:4px 8px}table{border-collapse:collapse}label{display:block;margin-top:8px;font-weight:600}dialog{padding:16px}</style></head>
<body><header><strong>Fieldbook</strong><nav><a href="./">Dashboard</a> <a href="projects">Projects</a> <a href="tasks">Tasks</a> <a href="reports">Reports</a> <a href="settings">Settings</a></nav><span>${esc(AREAS_SIGNED_IN_TEXT)}</span> <a href="logout">Sign out</a></header>
<main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
  const api = `const api = (op, body) => fetch(op, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());`;

  const page = (rest: string, q: URLSearchParams): string | undefined => {
    if (rest === "") {
      const open = tasks.filter((t) => t.status === "Open").length;
      return shell("Dashboard", `<h1>Dashboard</h1><p>${projects.filter((p) => p.status === "Active").length} active projects</p><p>Open tasks: ${open}</p><p><a href="projects">See all projects</a> · <a href="tasks">See tasks</a></p>`);
    }
    if (rest === "projects") {
      const term = (q.get("q") ?? "").toLowerCase();
      const shown = projects.filter((p) => !term || p.name.toLowerCase().includes(term));
      const rows = shown.map((p) => `<tr data-id="${p.id}"><td><a href="projects/${p.id}">${esc(p.name)}</a></td><td>${esc(p.client)}</td><td>£${p.budget.toLocaleString("en-GB")}</td><td>${esc(p.status)}</td><td><button type="button" class="arch" data-id="${p.id}">Archive</button> <button type="button" class="del" data-id="${p.id}" aria-label="Delete ${esc(p.name)}">Delete</button></td></tr>`).join("");
      return shell("Projects", `<h1>Projects</h1><p><a href="projects/new">New project</a></p>
<form role="search" method="get" action="projects"><label for="q">Search projects</label><input id="q" name="q" type="search" value="${esc(q.get("q") ?? "")}"><button type="submit">Search</button></form>
<table><thead><tr><th>Name</th><th>Client</th><th>Budget</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table><p>Showing ${shown.length} of ${projects.length}</p>`, `${api}
document.querySelectorAll(".arch").forEach((b) => b.onclick = () => api("api/projects/" + b.dataset.id + "/archive", {}).then(() => location.reload()).catch(() => {}));
document.querySelectorAll(".del").forEach((b) => b.onclick = () => fetch("api/projects/" + b.dataset.id, { method: "DELETE" }).then(() => location.reload()).catch(() => {}));`);
    }
    if (rest === "projects/new") {
      return shell("New project", `<h1>New project</h1><form method="post" action="api/projects">
<label for="pname">Project name</label><input id="pname" name="name" required>
<label for="client">Client</label><select id="client" name="client" required><option value="">Choose…</option>${clients.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
<label for="budget">Budget (£)</label><input id="budget" name="budget" type="number" min="0" step="100">
<label for="start">Start date</label><input id="start" name="start" type="date">
<p><button type="submit">Create project</button></p></form>`);
    }
    const detail = /^projects\/(\d+)$/.exec(rest);
    if (detail) {
      const p = projects.find((x) => x.id === Number(detail[1]));
      if (!p) return undefined;
      return shell(p.name, `<h1>${esc(p.name)}</h1><dl><dt>Client</dt><dd>${esc(p.client)}</dd><dt>Status</dt><dd>${esc(p.status)}</dd></dl>
<h2>Edit project</h2><form method="post" action="api/projects/${p.id}"><label for="ename">Project name</label><input id="ename" name="name" value="${esc(p.name)}" required><label for="ebudget">Budget (£)</label><input id="ebudget" name="budget" type="number" value="${p.budget}"><p><button type="submit">Save changes</button></p></form>
<p><a href="projects">Back to projects</a></p>`);
    }
    if (rest === "tasks") {
      const status = q.get("status") ?? "";
      const shown = tasks.filter((t) => !status || t.status === status);
      const list = shown.length ? `<ul id="tasks">${shown.map((t) => `<li>${esc(t.title)}</li>`).join("")}</ul>` : `<p class="empty">No tasks yet. Add your first task.</p>`;
      return shell("Tasks", `<h1>Tasks</h1><form method="get" action="tasks"><label for="status">Status</label><select id="status" name="status"><option value="">All</option><option>Open</option><option>Done</option></select><button type="submit">Apply filter</button></form>
<button type="button" id="newtask">New task</button>${list}
<dialog id="dlg" aria-label="New task"><h2>New task</h2><label for="ttitle">Task title</label><input id="ttitle" required><label for="tproj">Project</label><select id="tproj"><option value="">Choose…</option>${projects.map((p) => `<option>${esc(p.name)}</option>`).join("")}</select>
<fieldset><legend>Priority</legend><label><input type="radio" name="prio" value="Low"> Low</label><label><input type="radio" name="prio" value="High"> High</label></fieldset><p id="terr" role="alert"></p><button type="button" id="addtask">Add task</button> <button type="button" id="cancel">Cancel</button></dialog>`, `${api}
const dlg = document.getElementById("dlg");
document.getElementById("newtask").onclick = () => dlg.showModal();
document.getElementById("cancel").onclick = () => dlg.close();
document.getElementById("addtask").onclick = () => { const t = document.getElementById("ttitle").value.trim(); if (!t) { document.getElementById("terr").textContent = "Give the task a title"; return; } api("api/tasks", { title: t, project: document.getElementById("tproj").value }).then(() => location.reload()).catch(() => { document.getElementById("terr").textContent = "Couldn't add the task"; }); };`);
    }
    if (rest === "reports") {
      return shell("Reports", `<h1>Reports</h1><p>Total budget: £${projects.reduce((a, p) => a + p.budget, 0).toLocaleString("en-GB")}</p><p>Projects: ${projects.length}</p><table><thead><tr><th>Client</th><th>Budget</th></tr></thead><tbody>${clients.map((c) => `<tr><td>${esc(c)}</td><td>£${projects.filter((p) => p.client === c).reduce((a, p) => a + p.budget, 0).toLocaleString("en-GB")}</td></tr>`).join("")}</tbody></table>
<button type="button" id="export">Export CSV</button>`, `document.getElementById("export").onclick = () => { location.href = "reports/export.csv"; };`);
    }
    if (rest === "reports/export.csv") return undefined;
    if (rest === "settings") {
      const sw = (key: keyof typeof settings, label: string) => `<div><span id="l-${key}">${esc(label)}</span> <button type="button" role="switch" aria-labelledby="l-${key}" aria-checked="${settings[key]}" data-k="${key}">${settings[key] ? "On" : "Off"}</button></div>`;
      return shell("Settings", `<h1>Settings</h1><h2>Profile</h2><form method="post" action="api/profile"><label for="dn">Display name</label><input id="dn" name="displayName" value="Team Lead"><label for="em">Email</label><input id="em" name="email" type="email" value="${esc(AREAS_ACCOUNT.email)}"><p><button type="submit">Save profile</button></p></form>
<h2>Notifications</h2>${sw("mentions", "Email me about mentions")}${sw("digest", "Weekly digest")}
<h2>Danger zone</h2><button type="button" id="delacct">Delete account</button>`, `${api}
document.querySelectorAll("[role=switch]").forEach((b) => b.onclick = () => { const on = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", String(on)); b.textContent = on ? "On" : "Off"; api("api/settings", { key: b.dataset.k, on }).catch(() => {}); });
document.getElementById("delacct").onclick = () => fetch("api/account", { method: "DELETE" }).then(() => { location.href = "login"; });`);
    }
    return undefined;
  };

  const server = createServer((req, res) => void handle(req, res).catch(() => send(res, 500, "text/plain", "error")));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", "http://areas");
    const method = req.method ?? "GET";
    requests.push(`${method} ${u.pathname}`);
    if (!u.pathname.startsWith(base)) return send(res, 404, "text/plain", "not found");
    const rest = u.pathname.slice(base.length);
    const body = method === "GET" || method === "HEAD" ? "" : await readBody(req);
    const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = Boolean(sid && sessions.has(sid));
    if (rest === "login") {
      if (method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("email") === AREAS_ACCOUNT.email && f.get("password") === AREAS_ACCOUNT.password) {
          const s = randomBytes(8).toString("hex");
          sessions.add(s);
          res.writeHead(303, { location: base, "set-cookie": `sid=${s}; Path=/; HttpOnly; SameSite=Lax` });
          return void res.end();
        }
      }
      return send(res, 200, "text/html; charset=utf-8", `<!doctype html><title>Sign in · Fieldbook</title><h1>Sign in</h1><form method="post" action="login"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(`${method} /${rest}`);
      if (!signedIn) return send(res, 401, "application/json", "{}");
      const json = (() => {
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return Object.fromEntries(new URLSearchParams(body));
        }
      })();
      const m = /^api\/projects\/(\d+)(\/archive)?$/.exec(rest);
      if (rest === "api/projects" && method === "POST") {
        projects.push({ id: 10 + projects.length + 1, name: String(json.name ?? ""), client: String(json.client ?? ""), budget: Number(json.budget ?? 0), status: "Active" });
        changes.push("project created");
      } else if (m && method === "DELETE") {
        changes.push(`project ${m[1]} deleted`);
      } else if (m && m[2]) changes.push(`project ${m[1]} archived`);
      else if (m) changes.push(`project ${m[1]} changed`);
      else if (rest === "api/tasks") {
        tasks.push({ title: String(json.title ?? ""), status: "Open" });
        changes.push("task created");
      } else if (rest === "api/settings") {
        changes.push(`setting ${String(json.key)} changed`);
      } else if (rest === "api/profile") changes.push("profile changed");
      else if (rest === "api/account") changes.push("account deleted");
      if (req.headers["content-type"]?.includes("json")) return send(res, 200, "application/json", "{}");
      res.writeHead(303, { location: base });
      return void res.end();
    }
    if (rest === "logout") {
      if (sid) sessions.delete(sid);
      writes.push("GET /logout");
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    if (!signedIn) {
      res.writeHead(303, { location: `${base}login` });
      return void res.end();
    }
    if (rest === "reports/export.csv") return void res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' }).end("client,budget\n");
    const html = page(rest, u.searchParams);
    if (html === undefined) return send(res, 404, "text/html", "<!doctype html><title>Not found</title><h1>Not found</h1>");
    return send(res, 200, "text/html; charset=utf-8", html);
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}${base}`,
    origin,
    writes,
    changes,
    requests,
    async storageState() {
      const r = await fetch(`${origin}${base}login`, { method: "POST", body: new URLSearchParams({ email: AREAS_ACCOUNT.email, password: AREAS_ACCOUNT.password }), redirect: "manual" });
      const sid = /sid=([0-9a-f]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
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
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").slice(0, 1024 * 1024);
}
