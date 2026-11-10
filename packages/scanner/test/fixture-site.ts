/**
 * A small local web app for scanner tests: login, protected pages, JSON API,
 * GraphQL, a write fired on page load, a logout link and an external link.
 * It records every request it receives so tests can prove what never reached it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const TEST_USER = { email: "scanner@fixture.test", password: "fixture-password-123" };

export interface FixtureSite {
  url: string;
  received: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

const page = (title: string, body: string, script = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}<script>${script}</script></body></html>`;

export async function startFixtureSite(): Promise<FixtureSite> {
  const received: FixtureSite["received"] = [];

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      received.push({ method: req.method ?? "GET", path: url.pathname, body });
      const authed = (req.headers.cookie ?? "").includes("session=ok");
      const html = (status: number, content: string) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end(content);
      };
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // A public page whose heading carries numbers (a price, a plan), for what's kept signed out.
      if (url.pathname === "/numbered") return html(200, page("Pricing", "<h2>Plan 42 costs $90</h2>"));
      if (url.pathname === "/login" && req.method === "GET") {
        return html(200, page("Login", `<form id="f"><input id="email"><input id="password" type="password"><button id="submit" type="button">Sign in</button></form>`,
          `document.getElementById('submit').onclick = async () => {
             const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }) });
             if (r.ok) location.href = '/';
           };`));
      }
      if (url.pathname === "/api/session" && req.method === "POST") {
        const { email, password } = JSON.parse(body || "{}") as { email?: string; password?: string };
        if (email === TEST_USER.email && password === TEST_USER.password) {
          res.writeHead(204, { "set-cookie": "session=ok; Path=/; HttpOnly" });
          return res.end();
        }
        return json(401, { error: "bad credentials" });
      }

      if (!authed) {
        if (url.pathname.startsWith("/api/") || url.pathname === "/graphql") return json(401, { error: "login required" });
        res.writeHead(302, { location: "/login" });
        return res.end();
      }

      switch (url.pathname) {
        case "/":
          return html(200, page("Home", `
            <a href="/assessments">Assessments</a>
            <a href="/assessments/101">First</a><a href="/assessments/102">Second</a>
            <a href="/settings">Settings</a>
            <a href="/board">Board</a>
            <a href="/logout">Log out</a>
            <a href="/assessments/101/delete">Delete</a>
            <a href="/files/report.pdf">Report</a>
            <a href="https://external.example/">External</a>`,
            `fetch('/api/me');`));
        case "/assessments":
          return html(200, page("Assessments", `<a href="/">Home</a>`,
            `fetch('/api/assessments?page=1');
             fetch('/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'viewed' }) });`));
        case "/settings":
          // Like most single-page apps: some screens are reached only by buttons, never links.
          return html(200, page("Settings", `
            <button type="button" onclick="location.href='/reports'">Reports</button>
            <button type="button" onclick="location.href='/logout'">Log out</button>
            <form action="/saved"><label>Display name <input name="display_name" required></label><button>Save settings</button></form>
            <div class="menu"><button type="button" id="more" aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('menu').hidden = !document.getElementById('menu').hidden">More</button>
              <div role="menu" id="menu" hidden><button type="button" role="menuitem" onclick="fetch('/api/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'csv' }) })">Export data</button></div></div>
            <button type="button" onclick="if (confirm('Delete this assessment?')) fetch('/api/assessments/101', { method: 'DELETE' })">Delete assessment</button>
            <button type="button" onclick="fetch('/api/assessments/remove-all')">Clear all</button>`,
            `fetch('/api/settings');`));
        case "/board":
          // Cards moved by dragging (mouse events, as board apps do), each move saved.
          return html(200, page("Board", `
            <style>.list{min-height:120px;width:200px;display:inline-block;vertical-align:top;background:#eee;margin:4px}.card{cursor:grab;background:#fff;margin:6px;padding:6px}</style>
            <div class="list" data-col="todo"><div class="card" data-id="5">Card five</div></div><div class="list" data-col="done"></div>`,
            `let d; document.addEventListener('mousedown', (e) => { d = e.target.closest('.card'); });
             document.addEventListener('mouseup', (e) => { if (!d) return; const l = document.elementFromPoint(e.clientX, e.clientY)?.closest('.list'); if (l && l !== d.parentElement) { l.append(d); fetch('/api/cards/' + d.dataset.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ col: l.dataset.col }) }); } d = undefined; });`));
        case "/reports":
          return html(200, page("Reports", `<form><label>From <input name="from" type="date" required></label></form>`, `fetch('/api/reports');`));
        case "/saved":
          return html(200, page("Saved", ""));
        case "/api/reports":
          return json(200, []);
        case "/logout":
          res.writeHead(302, { "set-cookie": "session=; Max-Age=0; Path=/", location: "/login" });
          return res.end();
        case "/api/me":
          return json(200, { id: 7, email: TEST_USER.email });
        case "/api/assessments":
          return json(200, [{ id: 101 }, { id: 102 }]);
        case "/api/settings":
          return json(200, { theme: "light" });
        case "/api/telemetry":
          return json(200, { ok: true });
        case "/graphql":
          return json(200, { data: {} });
      }

      const detail = /^\/assessments\/(\d+)$/.exec(url.pathname);
      if (detail) {
        return html(200, page(`Assessment ${detail[1]}`, `<a href="/assessments">Back</a>`,
          `fetch('/api/assessments/${detail[1]}');
           fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'AssessmentDetails', query: 'query AssessmentDetails($id: ID!) { assessment(id: $id) { title } }', variables: { id: '${detail[1]}' } }) });
           fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'MarkViewed', query: 'mutation MarkViewed($id: ID!) { markViewed(id: $id) }', variables: { id: '${detail[1]}' } }) });`));
      }
      if (/^\/api\/assessments\/\d+$/.test(url.pathname)) return json(200, { id: 1, title: "Essay" });
      return json(404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
