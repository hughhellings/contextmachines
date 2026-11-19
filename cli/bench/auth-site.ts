/**
 * The local fixture for sign-in (AUTH 5.1): small pages that each sign in one way, or fail to, so the
 * tester's sign-in can be measured with no real service. Node's http on 127.0.0.1, a free port each;
 * a second instance plays "another host" (for leak and token-hop checks). Every request is logged by
 * path, with what it carried hashed, never a value; sign-ins, refusals and token reuse are logged as
 * events ("/_event/signin/login"), so a bench or a test can count them.
 *
 * It also answers a Mailpit-shaped API (/api/v1/messages, /api/v1/search, /api/v1/message/{ID},
 * DELETE /api/v1/messages), with a switch to make it fail, for codes and links by email.
 *
 * No AI, no network, no real account anywhere. Used by bench.ts (set auth) and cli/auth.test.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseTotpSecret, totpAt } from "../../packages/scanner/src/tester/totp.ts";

export interface AuthUser {
  username: string;
  password: string;
  /** An authenticator secret (base32): /mfa asks for its code after the password. */
  totp?: string;
}

export interface Mail {
  ID: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  created: string;
}

export interface AuthSite {
  /** http://127.0.0.1:<port>/ */
  url: string;
  /** http://localhost:<port2>/: another host, which must never see a secret or an owner token. */
  otherUrl: string;
  /** Every request and event so far, both instances, in order: "/login", "POST /login", "/_event/signin/login". */
  hits(): string[];
  /** Requests the other host saw, with what each carried (header names, hashed values; query names). */
  otherLog(): { path: string; headers: Record<string, string>; query: string[]; method: string }[];
  /** Testing Tokens the Clerk-shaped backend made. */
  clerkTokens(): string[];
  /** The publishable key naming the other instance as the Clerk Frontend API host. */
  clerkPublishableKey: string;
  /** Ends every session now, server-side (also GET /expire). */
  expireAll(): void;
  /** Sets a user's password (a stale one in the account makes /lockout's case). */
  setPassword(username: string, password: string): void;
  /** Puts a message in the Mailpit-shaped inbox. */
  sendMail(m: Omit<Mail, "ID" | "created" | "from"> & { from?: string }): Mail;
  /** Makes the inbox API answer 503 ("source down"). */
  setMailDown(down: boolean): void;
  /** Sign-ins that worked, per route ("/login", "/rotate"…). */
  signIns(route?: string): number;
  /** Sign-in submits the site refused, per route. */
  refusals(route?: string): number;
  /** Every code, link token and access token the site made: secrets the leak check looks for. */
  minted(): string[];
  /** Accounts made by /signup, by address. */
  signUps(): string[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
const hash = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);

/** A sign-in form: email and password, labelled as a person reads them. */
const form = (action: string, error = "", button = "Sign in", heading = "Sign in") => `<main><h1>${esc(heading)}</h1>
${error ? `<p role="alert" class="error">${esc(error)}</p>` : ""}
<form method="post" action="${action}">
<p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username" required></p>
<p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password" required></p>
<p><button type="submit">${esc(button)}</button></p>
</form></main>`;

const signedInPage = (title: string, who: string, base = "") => page(title, `<header><a href="${base}/app">Home</a> · <span>Signed in as ${esc(who)}</span> · <a href="${base}/logout">Sign out</a></header>
<main><h1>Dashboard</h1><p>Welcome back.</p>
<nav aria-label="App"><a href="${base}/app/settings">Account settings</a> <a href="${base}/app/reports">Reports</a></nav></main>`);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
      if (body.length > 100_000) req.destroy();
    });
    req.on("end", () => done(body));
    req.on("error", () => done(""));
  });
}

const cookiesOf = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), decodeURIComponent(c.slice(c.indexOf("=") + 1))]));

/** What the fixture's owner "issued" for it (C15): the header and secrets /walled, /vercel and /basic let through. */
export interface FixtureOwner {
  header?: { name: string; value: string };
  vercel?: string;
  basic?: { username: string; password: string };
  /** The Clerk-shaped backend's secret key (sk_test_…): POST /v1/testing_tokens with it makes a Testing Token. */
  clerkSecretKey?: string;
}

export async function startAuthSite(o: { users?: AuthUser[]; owner?: FixtureOwner } = {}): Promise<AuthSite> {
  const users = new Map((o.users ?? [{ username: "admin@example.test", password: "pw-fixture-admin-1" }]).map((u) => [u.username.toLowerCase(), u.password]));
  const totps = new Map((o.users ?? []).filter((u) => u.totp).map((u) => [u.username.toLowerCase(), u.totp!]));
  /** Codes and link tokens by email, waiting to be used: one each, the latest. */
  const codes = new Map<string, { code: string; email: string; signUp?: { name: string; password: string } }>();
  const links = new Map<string, string>();
  const minted: string[] = [];
  const signedUp: string[] = [];
  const mint = (v: string) => (minted.push(v), v);
  const sixDigits = () => String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  const log: string[] = [];
  const other: { path: string; headers: Record<string, string>; query: string[]; method: string }[] = [];
  const owner = o.owner ?? {};
  const clerkTokens: string[] = [];
  const sessions = new Map<string, string>();
  /** /rotate: the live refresh token of each family, and every token ever used (reuse ends the family). */
  const rotateLive = new Map<string, { user: string; family: string }>();
  const rotateUsed = new Map<string, string>();
  const revoked = new Set<string>();
  const failures = new Map<string, number>();
  const pending = new Map<string, string>();
  const mails: Mail[] = [];
  let mailDown = false;
  let mailId = 0;
  const event = (what: string) => log.push(`/_event/${what}`);
  const ok = (username: string, password: string) => users.get(username.trim().toLowerCase()) === password;
  const newId = () => randomBytes(16).toString("hex");

  let port = 0;
  let port2Ref = 0;
  const otherBase = () => `http://localhost:${port2Ref}`;
  const main = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = req.method ?? "GET";
    log.push(method === "GET" ? p : `${method} ${p}`);
    const html = (body: string, status = 200, headers: Record<string, string | string[]> = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }).end(body);
    const go = (to: string, headers: Record<string, string | string[]> = {}) => res.writeHead(303, { location: to, "cache-control": "no-store", ...headers }).end();
    const cookies = cookiesOf(req);
    const who = cookies.sid ? sessions.get(cookies.sid) : undefined;
    const startSession = (user: string) => {
      const sid = newId();
      sessions.set(sid, user);
      return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
    };
    const fields = async () => new URLSearchParams(await readBody(req));

    // ---- the Mailpit-shaped inbox
    if (p.startsWith("/api/v1/")) {
      if (mailDown) return res.writeHead(503, { "content-type": "text/plain" }).end("down");
      const summary = (m: Mail) => ({ ID: m.ID, MessageID: `${m.ID}@fixture`, Read: false, From: { Name: "", Address: m.from }, To: [{ Name: "", Address: m.to }], Cc: [], Bcc: [], ReplyTo: [], Subject: m.subject, Created: m.created, Tags: [], Size: m.text.length, Attachments: 0, Snippet: m.text.slice(0, 80) });
      const list = (ms: Mail[]) => ({ total: ms.length, unread: ms.length, count: ms.length, messages_count: ms.length, start: 0, tags: [], messages: [...ms].reverse().map(summary) });
      const json = (v: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (p === "/api/v1/messages" && method === "DELETE") {
        let ids: string[] = [];
        try {
          const body = JSON.parse((await readBody(req)) || "{}") as { IDs?: unknown };
          ids = Array.isArray(body.IDs) ? body.IDs.map(String) : [];
        } catch {
          ids = [];
        }
        if (!ids.length) mails.length = 0;
        else
          for (const id of ids) {
            const k = mails.findIndex((m) => m.ID === id);
            if (k >= 0) mails.splice(k, 1);
          }
        event(`mail/deleted/${ids.length || "all"}`);
        return json({});
      }
      if (p === "/api/v1/messages") return json(list(mails));
      if (p === "/api/v1/search") {
        const q = (url.searchParams.get("query") ?? "").toLowerCase();
        const to = /^to:"?([^"\s]+)"?/.exec(q)?.[1];
        return json(list(mails.filter((m) => (to ? m.to.toLowerCase() === to : `${m.subject} ${m.text}`.toLowerCase().includes(q)))));
      }
      const one = /^\/api\/v1\/message\/([\w-]+)$/.exec(p);
      if (one) {
        const m = mails.find((x) => x.ID === one[1]);
        if (!m) return json({ error: "not found" }, 404);
        return json({ ID: m.ID, MessageID: `${m.ID}@fixture`, From: { Name: "", Address: m.from }, To: [{ Name: "", Address: m.to }], Cc: [], Bcc: [], ReplyTo: [], ReturnPath: m.from, Subject: m.subject, Date: m.created, Tags: [], Text: m.text, HTML: m.html ?? "", Size: m.text.length, Inline: [], Attachments: [] });
      }
      return json({ error: "not found" }, 404);
    }

    if (p === "/") return html(page("Fixture App", `<header><a href="/">Fixture App</a> · <a href="/login">Sign in</a></header><main><h1>Fixture App</h1><p>A small app to sign in to.</p></main>`));
    if (p === "/expire") {
      sessions.clear();
      event("expire");
      return html(page("Expired", "<main><h1>Every session has ended</h1></main>"));
    }
    if (p === "/logout") return go("/", { "set-cookie": "sid=; Path=/; Max-Age=0" });

    // ---- /login: email + password on one page, then /app
    if (p === "/login" && method === "POST") {
      const f = await fields();
      if (ok(f.get("email") ?? "", f.get("password") ?? "")) {
        event("signin/login");
        return go(url.searchParams.get("next") || "/app", { "set-cookie": startSession(f.get("email")!) });
      }
      event("refused/login");
      return html(page("Sign in — Fixture App", form("/login", "Wrong email or password.")), 401);
    }
    if (p === "/login") return who ? go("/app") : html(page("Sign in — Fixture App", form("/login")));
    if (p === "/app" || p.startsWith("/app/")) {
      if (!who) return go(`/login?next=${encodeURIComponent(p)}`);
      if (p === "/app/settings" || p === "/app/account") return html(page("Account settings — Fixture App", `<header><a href="/app">Home</a> · <span>Signed in as ${esc(who)}</span> · <a href="/logout">Sign out</a></header><main><h1>Account settings</h1><p>Plan: Free</p></main>`));
      // A signed-in page that asks for the email and password again (a "confirm it's you" step mid-run).
      if (p === "/app/confirm" && method === "POST") {
        const f = await fields();
        const right = (f.get("email") ?? "").trim().toLowerCase() === who.toLowerCase() && ok(who, f.get("password") ?? "");
        event(right ? "confirm/ok" : "confirm/refused");
        return html(page("Confirm it's you — Fixture App", `<header><a href="/app">Home</a> · <a href="/logout">Sign out</a></header><main><h1>${right ? "Password confirmed" : "Confirm it's you"}</h1>${right ? "<p>You can change your plan now.</p>" : '<p role="alert">That isn\'t right.</p>'}</main>`), right ? 200 : 401);
      }
      if (p === "/app/confirm") return html(page("Confirm it's you — Fixture App", `<header><a href="/app">Home</a> · <a href="/logout">Sign out</a></header><main><h1>Confirm it's you</h1><form method="post" action="/app/confirm"><p><label for="c-email">Email</label> <input id="c-email" name="email" type="email"></p><p><label for="c-password">Password</label> <input id="c-password" name="password" type="password"></p><p><button type="submit">Confirm</button></p></form></main>`));
      if (p === "/app/reports") return html(page("Reports — Fixture App", `<header><a href="/app">Home</a> · <a href="/logout">Sign out</a></header><main><h1>Reports</h1><p>No reports yet.</p></main>`));
      return html(signedInPage("Dashboard — Fixture App", who));
    }

    // ---- /echo: a signed-in page that shows who is signed in, and a masked hint of the address
    if (p === "/echo") {
      if (!who) return go("/login?next=/echo");
      const at = who.indexOf("@");
      return html(page("Profile — Fixture App", `<header><a href="/app">Home</a> · <a href="/logout">Sign out</a></header><main><h1>Profile</h1><p>Signed in as ${esc(who)}</p><p>Your email: <input aria-label="Your email" value="${esc(who)}" readonly></p><p>We sent a confirmation to ${esc(who.slice(0, 1))}***${esc(at > 0 ? who.slice(at) : "")}</p></main>`));
    }

    // ---- /login2: the email on one page, the password on the next
    if (p === "/login2" && method === "POST") {
      const f = await fields();
      const id = newId();
      pending.set(id, (f.get("email") ?? "").trim());
      return go("/login2/password", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === "/login2") return html(page("Sign in — Fixture App", `<main><h1>Sign in</h1><form method="post" action="/login2"><p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username" required></p><p><button type="submit">Continue</button></p></form></main>`));
    if (p === "/login2/password" && method === "POST") {
      const f = await fields();
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (email && ok(email, f.get("password") ?? "")) {
        event("signin/login2");
        return go("/app", { "set-cookie": startSession(email) });
      }
      event("refused/login2");
      return html(page("Enter your password — Fixture App", `<main><h1>Enter your password</h1><p role="alert">Wrong password.</p><form method="post" action="/login2/password"><p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password" required></p><p><button type="submit">Sign in</button></p></form></main>`), 401);
    }
    if (p === "/login2/password") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/login2");
      return html(page("Enter your password — Fixture App", `<main><h1>Enter your password</h1><p>for ${esc(email)}</p><form method="post" action="/login2/password"><p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="current-password" required></p><p><button type="submit">Sign in</button></p></form></main>`));
    }

    // ---- /modal: a sign-in dialog on the page; the address never changes
    if (p === "/api/login" && method === "POST") {
      const f = await fields();
      if (ok(f.get("email") ?? "", f.get("password") ?? "")) {
        event("signin/modal");
        return res.writeHead(200, { "content-type": "application/json", "set-cookie": startSession(f.get("email")!) }).end(JSON.stringify({ ok: true, who: (f.get("email") ?? "").trim() }));
      }
      event("refused/modal");
      return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    }
    if (p === "/modal") {
      const body = who
        ? `<header><a href="/modal">Fixture Notes</a> · <span>Signed in as ${esc(who)}</span> · <a href="/logout">Sign out</a></header><main><h1>Your notes</h1><p>No notes yet.</p></main>`
        : `<header><a href="/modal">Fixture Notes</a> · <button id="open" type="button">Sign in</button></header><main><h1>Fixture Notes</h1><p>Notes for everyone.</p></main>
<dialog id="dlg" aria-labelledby="dh"><h2 id="dh">Sign in to Fixture Notes</h2><p id="err" role="alert" hidden>Wrong email or password.</p>
<form id="f"><p><label for="m-email">Email</label> <input id="m-email" name="email" type="email" autocomplete="username" required></p>
<p><label for="m-password">Password</label> <input id="m-password" name="password" type="password" autocomplete="current-password" required></p>
<p><button type="submit">Continue</button> <button type="button" id="cancel">Cancel</button></p></form></dialog>`;
      const script = who ? "" : `
const d = document.getElementById("dlg");
document.getElementById("open").addEventListener("click", () => d.showModal());
document.getElementById("cancel").addEventListener("click", () => d.close());
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", { method: "POST", body: new URLSearchParams(new FormData(e.target)) });
  if (!r.ok) { document.getElementById("err").hidden = false; return; }
  const j = await r.json();
  d.close();
  document.querySelector("header").innerHTML = '<a href="/modal">Fixture Notes</a> · <span>Signed in as ' + j.who.replace(/[<&]/g, "") + '</span> · <a href="/logout">Sign out</a>';
  document.querySelector("main").innerHTML = "<h1>Your notes</h1><p>No notes yet.</p>";
});`;
      return html(page("Fixture Notes", body, script));
    }

    // ---- /rotate: a refresh token that changes on every use; a reused one ends its whole family
    const rotateCookie = (rt: string) => `rt=${rt}; Path=/rotate; HttpOnly; SameSite=Lax`;
    if (p === "/rotate" && method === "POST") {
      const f = await fields();
      if (ok(f.get("email") ?? "", f.get("password") ?? "")) {
        event("signin/rotate");
        const rt = newId();
        rotateLive.set(rt, { user: f.get("email")!.trim(), family: newId() });
        return go("/rotate/app", { "set-cookie": rotateCookie(rt) });
      }
      event("refused/rotate");
      return html(page("Sign in — Fixture Rotate", form("/rotate", "Wrong email or password.")), 401);
    }
    if (p === "/rotate") return html(page("Sign in — Fixture Rotate", form("/rotate")));
    if (p.startsWith("/rotate/app")) {
      const rt = cookies.rt;
      const live = rt ? rotateLive.get(rt) : undefined;
      if (!live) {
        const family = rt ? rotateUsed.get(rt) : undefined;
        if (family) {
          // Reuse: every token of that family is dead, as a real refresh-token rotation would do.
          event("reuse/rotate");
          revoked.add(family);
          for (const [k, v] of rotateLive) if (v.family === family) rotateLive.delete(k);
        }
        return go("/rotate", { "set-cookie": "rt=; Path=/rotate; Max-Age=0" });
      }
      rotateLive.delete(rt!);
      rotateUsed.set(rt!, live.family);
      const next = newId();
      rotateLive.set(next, live);
      const n = /^\/rotate\/app\/page\/(\d+)$/.exec(p)?.[1];
      const body = `<header><a href="/rotate/app">Home</a> · <span>Signed in as ${esc(live.user)}</span> · <a href="/rotate">Sign out</a></header><main><h1>${n ? `Page ${n}` : "Dashboard"}</h1><nav aria-label="Pages">${Array.from({ length: 10 }, (_, i) => `<a href="/rotate/app/page/${i + 1}">Page ${i + 1}</a>`).join(" ")}</nav></main>`;
      return html(page(`${n ? `Page ${n}` : "Dashboard"} — Fixture Rotate`, body), 200, { "set-cookie": rotateCookie(next) });
    }

    // ---- /lockout: three wrong passwords lock the account
    if (p === "/lockout" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      const fails = failures.get(email) ?? 0;
      if (fails >= 3) {
        event("refused/lockout");
        return html(page("Locked — Fixture App", form("/lockout", "This account is locked after too many attempts.")), 423);
      }
      if (ok(email, f.get("password") ?? "")) {
        event("signin/lockout");
        return go("/app", { "set-cookie": startSession(email) });
      }
      failures.set(email, fails + 1);
      event("refused/lockout");
      return html(page("Sign in — Fixture App", form("/lockout", `Wrong email or password. ${2 - fails > 0 ? `${2 - fails} tries left.` : "The account is now locked."}`)), 401);
    }
    if (p === "/lockout") return html(page("Sign in — Fixture App", form("/lockout")));

    // ---- /mfa: a password, then an authenticator code (C5)
    const codeForm = (action: string, heading: string, label: string, error = "", button = "Verify", note = "") => `<main><h1>${esc(heading)}</h1>${note ? `<p>${esc(note)}</p>` : ""}${error ? `<p role="alert">${esc(error)}</p>` : ""}<form method="post" action="${action}"><p><label for="code">${esc(label)}</label> <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required></p><p><button type="submit">${esc(button)}</button></p></form></main>`;
    if (p === "/mfa" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (ok(email, f.get("password") ?? "")) {
        const id = newId();
        pending.set(id, email);
        return go("/mfa/code", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      event("refused/mfa");
      return html(page("Sign in — Fixture App", form("/mfa", "Wrong email or password.")), 401);
    }
    if (p === "/mfa") return html(page("Sign in — Fixture App", form("/mfa")));
    if (p === "/mfa/code") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/mfa");
      if (method === "POST") {
        const code = ((await fields()).get("code") ?? "").replace(/\s/g, "");
        const secret = totps.get(email);
        const now = Date.now();
        const good = secret && [-1, 0, 1].some((k) => totpAt(parseTotpSecret(secret), now + k * 30_000) === code);
        if (good) {
          event("signin/mfa");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/mfa-code");
        return html(page("Two-step sign-in — Fixture App", codeForm("/mfa/code", "Two-step sign-in", "Authenticator code", "That code isn't right.")), 401);
      }
      return html(page("Two-step sign-in — Fixture App", codeForm("/mfa/code", "Two-step sign-in", "Authenticator code", "", "Verify", "Enter the 6-digit code from your authenticator app.")));
    }

    // ---- /dots: a sign-in made to try the mask (cover.ts): an autofocus email box the page draws again,
    // React-style, on every key and once more just after; a password box (no "password" in its name or id)
    // whose Show toggle makes it type=text; then an authenticator code in a plain text box, also drawn again.
    const redraw = `
function redraw(id) {
  const e = document.getElementById(id); if (!e) return;
  const n = document.createElement("input");
  for (const a of ["id", "name", "type", "autocomplete", "inputmode"]) if (e.getAttribute(a) !== null) n.setAttribute(a, e.getAttribute(a));
  n.value = e.value;
  const had = document.activeElement === e;
  e.replaceWith(n);
  n.addEventListener("input", () => { redraw(id); setTimeout(() => redraw(id), 120); });
  if (had) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
}
for (const id of ["email", "token"]) { const e = document.getElementById(id); if (e) e.addEventListener("input", () => { redraw(id); setTimeout(() => redraw(id), 120); }); }
const t = document.getElementById("toggle");
if (t) t.addEventListener("click", () => { const p = document.getElementById("pass"); const show = p.type === "password"; p.type = show ? "text" : "password"; t.textContent = show ? "Hide password" : "Show password"; });`;
    if (p === "/dots" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (ok(email, f.get("pass") ?? "")) {
        const id = newId();
        pending.set(id, email);
        return go("/dots/code", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      event("refused/dots");
      return html(page("Sign in — Fixture Dots", `<main><h1>Sign in</h1><p role="alert">Wrong email or password.</p><p><a href="/dots">Try again</a></p></main>`), 401);
    }
    if (p === "/dots") return html(page("Sign in — Fixture Dots", `<main><h1>Sign in</h1><form method="post" action="/dots">
<p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username" autofocus></p>
<p><label for="pass">Password</label> <input id="pass" name="pass" type="password"> <button type="button" id="toggle">Show password</button></p>
<p><button type="submit">Sign in</button></p></form></main>`, redraw));
    if (p === "/dots/code") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/dots");
      if (method === "POST") {
        const code = ((await fields()).get("token") ?? "").replace(/\s/g, "");
        const secret = totps.get(email);
        const now = Date.now();
        if (secret && [-1, 0, 1].some((k) => totpAt(parseTotpSecret(secret), now + k * 30_000) === code)) {
          event("signin/dots");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/dots-code");
      }
      return html(page("Two-step sign-in — Fixture Dots", `<main><h1>Two-step sign-in</h1><p>Enter the 6-digit code from your authenticator app.</p>${method === "POST" ? '<p role="alert">That code isn\'t right.</p>' : ""}<form method="post" action="/dots/code"><p><label for="token">Authenticator code</label> <input id="token" name="token" type="text" autofocus></p><p><button type="submit">Verify</button></p></form></main>`, redraw), method === "POST" ? 401 : 200);
    }

    // ---- /dots/slots (review): a code page built like input-otp: one native box whose text is drawn
    // transparent, and six slots under it that show each digit as plain text as it is typed; the box
    // suggests (aria-autocomplete), so a tester types all but the last digit, then the last as a key.
    // Any stored-value user's authenticator code is taken; no sign-in is started.
    if (p === "/dots/slots" && method === "POST") {
      const code = ((await fields()).get("token") ?? "").replace(/\s/g, "");
      const now = Date.now();
      const good = [...totps.values()].some((secret) => [-1, 0, 1].some((k) => totpAt(parseTotpSecret(secret), now + k * 30_000) === code));
      event(good ? "code/slots" : "refused/slots");
      return html(page("Code — Fixture Dots", `<main><h1>${good ? "Code accepted" : "That code isn't right"}</h1></main>`), good ? 200 : 401);
    }
    if (p === "/dots/slots") return html(page("Code — Fixture Dots", `<main><h1>Enter your code</h1><form method="post" action="/dots/slots">
<div style="position:relative;width:300px;height:48px"><label for="token" style="position:absolute;left:-9999px">Authenticator code</label>
<input id="token" name="token" type="text" inputmode="numeric" aria-autocomplete="list" autocomplete="one-time-code" maxlength="6" autofocus style="position:absolute;inset:0;width:100%;height:100%;color:transparent;caret-color:transparent;background:transparent;border:0;outline:none;font-size:1px">
<div aria-hidden="true" style="display:flex;gap:6px;pointer-events:none">${Array.from({ length: 6 }, () => `<div data-slot style="width:42px;height:46px;border:1px solid #888;display:flex;align-items:center;justify-content:center;font:600 28px system-ui"></div>`).join("")}</div></div>
<p><button type="submit">Verify</button></p></form></main>`, `const box = document.getElementById("token"); const slots = Array.from(document.querySelectorAll("[data-slot]"));
box.addEventListener("input", () => slots.forEach((s, k) => (s.textContent = box.value[k] ?? "")));`));

    // ---- /mfa-plain (review): an authenticator code page that never says "authenticator", and refuses every
    // code (the site is broken): a FAIL of the site, never "a code sent to the person".
    if (p === "/mfa-plain" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (ok(email, f.get("password") ?? "")) {
        const id = newId();
        pending.set(id, email);
        return go("/mfa-plain/code", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      return html(page("Sign in — Fixture App", form("/mfa-plain", "Wrong email or password.")), 401);
    }
    if (p === "/mfa-plain") return html(page("Sign in — Fixture App", form("/mfa-plain")));
    if (p === "/mfa-plain/code") {
      if (method === "POST") event("refused/mfa-plain-code");
      return html(page("Two-step sign-in — Fixture App", codeForm("/mfa-plain/code", "Two-step sign-in", "Verification code", method === "POST" ? "That code isn't right." : "", "Verify", "Enter the 6-digit code from your app.")), method === "POST" ? 401 : 200);
    }
    // ---- /settings/phone (review): a signed-in feature with a code field ("verify your phone number"), broken:
    // every code is refused. A test of it is a FAIL of the site, never BLOCKED for want of a person.
    if (p === "/settings/phone") {
      if (method === "POST") event("phone/refused");
      return html(page("Phone — Fixture App", codeForm("/settings/phone", "Verify your phone number", "Verification code", method === "POST" ? "Something went wrong. Try again." : "", "Verify", "Enter the code we texted to your phone.")));
    }
    // ---- /devices (review): a signed-in page that talks about devices, never a new-device check.
    if (p === "/devices") return html(page("Devices — Fixture App", `<header><span>Signed in</span> · <a href="/logout">Sign out</a></header><main><h1>Your devices</h1><p>Approve this device to sync. <a href="/devices">+ Add new device</a></p><p>Sign-in from a new browser on Nov 17. <a href="/devices">Open in new browser tab</a></p></main>`));

    // ---- /code and /no-send: a code by email (C8); /no-send's never reaches the inbox
    const emailOnly = (action: string, button: string, heading = "Sign in", extra = "") => `<main><h1>${esc(heading)}</h1><form method="post" action="${action}"><p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="username" required></p>${extra}<p><button type="submit">${esc(button)}</button></p></form></main>`;
    if ((p === "/code" || p === "/no-send") && method === "POST") {
      const email = ((await fields()).get("email") ?? "").trim().toLowerCase();
      const id = newId();
      pending.set(id, email);
      event(`sent${p}`);
      if (p === "/code" && users.has(email)) {
        const code = mint(sixDigits());
        codes.set(email, { code, email });
        mails.push({ ID: `m${++mailId}`, from: "no-reply@fixture.test", to: email, subject: "Your sign-in code", text: `Your verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for it, ignore this email.\n\n© 2026 Fixture App`, created: new Date().toISOString() });
      }
      return go(`${p}/verify`, { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === "/code" || p === "/no-send") return html(page("Sign in — Fixture App", emailOnly(p, "Send code")));
    if (p === "/code/verify" || p === "/no-send/verify") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go(p.replace("/verify", ""));
      if (method === "POST") {
        const code = ((await fields()).get("code") ?? "").trim();
        const want = codes.get(email);
        if (want && want.code === code) {
          codes.delete(email);
          event("signin/code");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/code");
        return html(page("Check your email — Fixture App", codeForm(p, "Enter your code", "Verification code", "That code isn't right.", "Sign in")), 401);
      }
      return html(page("Check your email — Fixture App", codeForm(p, "Enter your code", "Verification code", "", "Sign in", "We emailed you a 6-digit code.")));
    }

    // ---- /magic: a link by email (C8), which lands on /app#access_token=LEAK…; /magic-port's link is on
    // the other instance's port (allowed by --allow-host localhost), /magic-elsewhere's on a host nobody allowed.
    if ((p === "/magic" || p === "/magic-port" || p === "/magic-elsewhere") && method === "POST") {
      const email = ((await fields()).get("email") ?? "").trim().toLowerCase();
      event(`sent${p}`);
      if (users.has(email)) {
        const token = mint(`LEAK-${randomBytes(12).toString("hex")}`);
        links.set(token, email);
        const base = p === "/magic-port" ? otherBase() : p === "/magic-elsewhere" ? "https://elsewhere.invalid" : `http://127.0.0.1:${port}`;
        const link = `${base}/magic/verify?token=${token}`;
        mails.push({ ID: `m${++mailId}`, from: "no-reply@fixture.test", to: email, subject: "Your sign-in link", text: `Sign in to Fixture App:\n${link}\n\nThe link works once, for 10 minutes.`, html: `<p>Sign in to Fixture App:</p><p><a href="${esc(link)}">Sign in</a></p><p><a href="http://127.0.0.1:${port}/help">Help</a></p>`, created: new Date().toISOString() });
      }
      return html(page("Check your email — Fixture App", `<main><h1>Check your email</h1><p>If the address has an account, we sent it a sign-in link.</p></main>`));
    }
    if (p === "/magic" || p === "/magic-port" || p === "/magic-elsewhere") return html(page("Sign in — Fixture App", emailOnly(p, "Send me a link")));
    if (p === "/magic/verify") {
      const token = url.searchParams.get("token") ?? "";
      const email = links.get(token);
      if (!email) {
        event("refused/magic");
        return html(page("Link expired — Fixture App", `<main><h1>This link has expired</h1><p><a href="/magic">Get a new one</a></p></main>`), 400);
      }
      links.delete(token);
      event("signin/magic");
      const access = mint(`LEAK${randomBytes(16).toString("hex")}`);
      return go(`/app#access_token=${access}&token_type=bearer`, { "set-cookie": startSession(email) });
    }

    // ---- /signup: name, email, password, "Send verification code", then the code by email (C9)
    if (p === "/signup" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      const name = (f.get("name") ?? "").trim();
      const password = f.get("password") ?? "";
      if (!email || !name || password.length < 8) return html(page("Sign up — Fixture App", `<main><h1>Create your account</h1><p role="alert">Fill in every field (a password of 8 or more).</p></main>`), 400);
      const id = newId();
      pending.set(id, email);
      const code = mint(sixDigits());
      codes.set(email, { code, email, signUp: { name, password } });
      mails.push({ ID: `m${++mailId}`, from: "no-reply@fixture.test", to: email, subject: "Confirm your email", text: `Welcome, ${name}! Your verification code is ${code}.`, created: new Date().toISOString() });
      event("sent/signup");
      return go("/signup/verify", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === "/signup") return html(page("Sign up — Fixture App", `<main><h1>Create your account</h1><form method="post" action="/signup">
<p><label for="name">Full name</label> <input id="name" name="name" autocomplete="name" required></p>
<p><label for="email">Email</label> <input id="email" name="email" type="email" autocomplete="email" required></p>
<p><label for="password">Password</label> <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required></p>
<p><button type="submit">Send verification code</button></p></form></main>`));
    if (p === "/signup/verify") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/signup");
      if (method === "POST") {
        const code = ((await fields()).get("code") ?? "").trim();
        const want = codes.get(email);
        if (want?.signUp && want.code === code) {
          codes.delete(email);
          users.set(email, want.signUp.password);
          signedUp.push(email);
          event("signup/signup");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/signup");
        return html(page("Confirm your email — Fixture App", codeForm("/signup/verify", "Confirm your email", "Verification code", "That code isn't right.")), 401);
      }
      return html(page("Confirm your email — Fixture App", codeForm("/signup/verify", "Confirm your email", "Verification code", "", "Verify", "We emailed you a 6-digit code.")));
    }

    // ---- /contact: "Send code" beside a message box (the C7 trap): never pressed
    if (p === "/contact" && method === "POST") {
      await fields();
      event("sent/contact");
      return html(page("Thanks — Fixture App", "<main><h1>Message sent</h1></main>"));
    }
    if (p === "/contact") return html(page("Contact us — Fixture App", `<main><h1>Contact us</h1><form method="post" action="/contact">
<p><label for="email">Email</label> <input id="email" name="email" type="email" required></p>
<p><label for="message">Message</label> <textarea id="message" name="message"></textarea></p>
<p><button type="submit">Send code</button></p></form></main>`));
    if (p === "/help") return html(page("Help — Fixture App", "<main><h1>Help</h1></main>"));

    // ---- owner access (C15): what only the owner's own token lets through
    const header = (n: string) => String(req.headers[n] ?? "");
    const hasOwnerHeader = Boolean(owner.header && header(owner.header.name) === owner.header.value);
    const hasVercel = Boolean(owner.vercel && header("x-vercel-protection-bypass") === owner.vercel);
    if (hasOwnerHeader) event("owner/header");
    if (hasVercel) event("owner/vercel");
    if (p === "/walled" || p.startsWith("/walled/")) {
      if (!hasOwnerHeader && !hasVercel && cookies.wall_ok !== "1") {
        event("walled/challenge");
        return html(page("Just a moment...", `<main><h1>Checking your browser before accessing the app</h1><p>This takes a few seconds.</p><noscript>Turn on JavaScript to go on.</noscript></main>`), 403);
      }
      event("walled/app");
      const sub = p === "/walled/reports" ? "Reports" : "Walled App";
      return html(page(`${sub} — Walled App`, `<header><a href="/walled">Walled App</a> · <a href="/walled/reports">Reports</a></header><main><h1>${sub}</h1><p>${sub === "Reports" ? "Quarterly numbers: 3 reports." : "Welcome to the walled app."}</p></main>`));
    }
    if (p === "/vercel" || p.startsWith("/vercel/")) {
      const bypassCookie = cookies._vercel_jwt === "fixture-bypass";
      if (!hasVercel && !bypassCookie) {
        event("vercel/login");
        return html(page("Authentication Required", `<main><h1>Authentication Required</h1><p>Vercel Authentication: log in to Vercel to see this deployment.</p><p><a href="https://vercel.com/sso-api?url=fixture">Continue with Vercel</a></p></main>`), 401, { server: "Vercel", "x-vercel-id": "fixture::1" });
      }
      event("vercel/app");
      return html(page("Preview — Fixture App", `<main><h1>Preview deployment</h1><p>This is the preview.</p></main>`), 200, { server: "Vercel", ...(header("x-vercel-set-bypass-cookie") === "true" ? { "set-cookie": "_vercel_jwt=fixture-bypass; Path=/; HttpOnly; SameSite=Lax" } : {}) });
    }
    if (p === "/basic" || p.startsWith("/basic/")) {
      const want = owner.basic ? `Basic ${Buffer.from(`${owner.basic.username}:${owner.basic.password}`).toString("base64")}` : "";
      if (!want || header("authorization") !== want) {
        event("basic/refused");
        return res.writeHead(401, { "content-type": "text/html; charset=utf-8", "www-authenticate": 'Basic realm="fixture"' }).end(page("Unauthorized", "<main><h1>401 Unauthorized</h1></main>"));
      }
      event("basic/app");
      return html(page("Basic area — Fixture App", "<main><h1>Basic area</h1><p>Only for the team.</p></main>"));
    }
    // /hop: on the owner's host, three ways to another host: a GET link, a POST form, a background fetch.
    if (p === "/hop/get") return go(`${otherBase()}/landing?via=get`);
    if (p === "/hop/post" && method === "POST") {
      await fields();
      return go(`${otherBase()}/landing?via=post`);
    }
    if (p === "/hop/xhr") return res.writeHead(302, { location: `${otherBase()}/api/ping?via=xhr`, "cache-control": "no-store" }).end();
    if (p === "/hop") {
      if (!hasOwnerHeader && !hasVercel) {
        event("walled/challenge");
        return html(page("Just a moment...", `<main><h1>Checking your browser before accessing the app</h1></main>`), 403);
      }
      return html(page("Links — Walled App", `<main><h1>Links</h1><p id="bg">Checking the status…</p><p><a href="/hop/get">Our docs</a></p><form method="post" action="/hop/post"><input type="hidden" name="from" value="hop"><button type="submit">Continue to the docs</button></form></main>`, `fetch("/hop/xhr").then(r => r.text()).then(() => { document.getElementById("bg").textContent = "Status: all good"; }, () => { document.getElementById("bg").textContent = "Status: unknown"; });`));
    }
    // A Clerk-shaped backend (POST /v1/testing_tokens with the secret key) and a page that loads its Frontend API from the other host.
    if (p === "/v1/testing_tokens" && method === "POST") {
      if (!owner.clerkSecretKey || header("authorization") !== `Bearer ${owner.clerkSecretKey}`) return res.writeHead(401, { "content-type": "application/json" }).end("{}");
      const token = mint(`cltt_${randomBytes(12).toString("hex")}`);
      clerkTokens.push(token);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "testing_token", token, expires_at: Date.now() + 3_600_000 }));
    }
    if (p === "/clerk") {
      return html(page("Clerk app — Fixture App", `<main><h1>Clerk app</h1><p id="state">Loading…</p></main>`, `Promise.all([fetch("${otherBase()}/v1/client?_clerk_js_version=5").then(r => r.json()), fetch("${otherBase()}/npm/clerk.js").then(r => r.text())]).then(([c]) => { document.getElementById("state").textContent = c.testing ? "Clerk test mode: on" : "Clerk test mode: off"; }, () => { document.getElementById("state").textContent = "Clerk didn't load"; });`));
    }
    // OAuth (C13): a redirect handoff to the other host's provider, and one in a popup that answers its opener.
    const providerAt = (popup: boolean) => `${otherBase()}/authorize?client_id=fixture-app&response_type=code&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/oauth/callback`)}&state=${randomBytes(6).toString("hex")}${popup ? "&popup=1" : ""}`;
    if (p === "/oauth/go") return go(providerAt(false));
    if (p === "/oauth/start") return html(page("Sign in — Fixture App", `<main><h1>Sign in</h1><p><a href="/oauth/go">Continue with Fixture ID</a></p></main>`));
    if (p === "/oauth/popup") {
      return html(page("Sign in — Fixture App", `<main><h1>Sign in</h1><p id="who">Not signed in.</p><p><button type="button" id="go">Continue with Fixture ID</button></p></main>`, `
document.getElementById("go").addEventListener("click", () => { window.open(${JSON.stringify(providerAt(true))}, "fixtureid", "width=480,height=600"); });
window.addEventListener("message", (e) => { if (e.data && e.data.who) { document.querySelector("main").replaceChildren(Object.assign(document.createElement("h1"), { textContent: "Dashboard" }), Object.assign(document.createElement("p"), { textContent: "You are signed in as " + String(e.data.who) + ", with Fixture ID" }), Object.assign(document.createElement("a"), { href: "/logout", textContent: "Sign out" })); } });`));
    }
    if (p === "/oauth/callback") {
      const code = url.searchParams.get("code") ?? "";
      const email = links.get(code);
      if (!email) return html(page("Sign-in failed — Fixture App", "<main><h1>That sign-in didn't work</h1></main>"), 400);
      links.delete(code);
      event("signin/oauth");
      return go("/app", { "set-cookie": startSession(email) });
    }

    // ---- /device-check (change 2): the right password, then "We sent you an email to confirm it's you",
    // with nothing to type. Every POST is logged, so a test can count that the password was sent once.
    if (p === "/device-check" && method === "POST") {
      const f = await fields();
      if (ok(f.get("email") ?? "", f.get("password") ?? "")) {
        event("device/asked");
        return html(page("Confirm it's you — Fixture App", `<main><h1>Confirm it's you</h1><p>We sent you an email to confirm it's you. Open the link in it on this device to finish signing in.</p><p>This is a new device for your account.</p></main>`));
      }
      event("refused/device-check");
      return html(page("Sign in — Fixture App", form("/device-check", "Wrong email or password.")), 401);
    }
    if (p === "/device-check") return html(page("Sign in — Fixture App", form("/device-check")));

    // ---- /sms (change 5): the right password, then a code texted to a phone (never readable here).
    if (p === "/sms" && method === "POST") {
      const f = await fields();
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (ok(email, f.get("password") ?? "")) {
        const id = newId();
        pending.set(id, email);
        const code = mint(sixDigits());
        codes.set(`sms:${email}`, { code, email });
        event("sent/sms");
        return go("/sms/verify", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      event("refused/sms");
      return html(page("Sign in — Fixture App", form("/sms", "Wrong email or password.")), 401);
    }
    if (p === "/sms") return html(page("Sign in — Fixture App", form("/sms")));
    if (p === "/sms/verify") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/sms");
      if (method === "POST") {
        const code = ((await fields()).get("code") ?? "").trim();
        const want = codes.get(`sms:${email}`);
        if (want && want.code === code) {
          codes.delete(`sms:${email}`);
          event("signin/sms");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/sms-code");
        return html(page("Check your phone — Fixture App", codeForm("/sms/verify", "Enter the code we texted you", "Verification code", "That code isn't right.", "Verify")), 401);
      }
      return html(page("Check your phone — Fixture App", codeForm("/sms/verify", "Enter the code we texted you", "Verification code", "", "Verify", "We texted a 6-digit code to your phone ending in 42.")));
    }

    // ---- /clerk/sign-in (changes 3 and 4): a Clerk-shaped sign-in. An email, then a code; a +clerk_test
    // address takes the fixed test code 424242 (Clerk's test mode), and nothing is sent. /clerk/bot-sign-in
    // has Clerk's bot protection in front: the page asks its Frontend API (the other host) before it shows
    // anything, and only a Testing Token this fixture's backend made lets the form show.
    if (p === "/clerk/sign-in" && method === "POST") {
      const email = ((await fields()).get("email") ?? "").trim().toLowerCase();
      const id = newId();
      pending.set(id, email);
      event("sent/clerk");
      return go("/clerk/sign-in/verify", { "set-cookie": `pending=${id}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p === "/clerk/sign-in/verify") {
      const email = cookies.pending ? pending.get(cookies.pending) : undefined;
      if (!email) return go("/clerk/sign-in");
      if (method === "POST") {
        const code = ((await fields()).get("code") ?? "").trim();
        if (/\+clerk_test@/.test(email) && code === "424242") {
          event("signin/clerk");
          return go("/app", { "set-cookie": startSession(email) });
        }
        event("refused/clerk");
        return html(page("Check your email — Clerk app", codeForm("/clerk/sign-in/verify", "Check your email", "Verification code", "Incorrect code.", "Continue")), 401);
      }
      return html(page("Check your email — Clerk app", codeForm("/clerk/sign-in/verify", "Check your email", "Verification code", "", "Continue", "Enter the verification code sent to your email.")));
    }
    if (p === "/clerk/sign-in" || p === "/clerk/bot-sign-in") {
      const signIn = emailOnly("/clerk/sign-in", "Continue", "Sign in to Clerk app");
      if (p === "/clerk/sign-in") return html(page("Sign in — Clerk app", signIn, `/* clerk */`).replace("</head>", `<script src="${otherBase()}/npm/clerk.js"></script></head>`));
      // The bot check is decided before the page shows (a blocking ask of the Frontend API, as Clerk's script does).
      const wall = `<main><h1>Verify you are human</h1><div id="clerk-captcha"></div><p><label for="cap">Type the characters you see in the picture</label> <input id="cap" name="cap"></p></main>`;
      const script = `(function(){var x=new XMLHttpRequest();var t=false;try{x.open("GET",${JSON.stringify(`${otherBase()}/v1/client?_clerk_js_version=5`)},false);x.send();t=JSON.parse(x.responseText).testing===true;}catch(e){}document.title=t?"Sign in — Clerk app":"Verify you are human";document.body.innerHTML=t?${JSON.stringify(signIn)}:${JSON.stringify(wall)};})();`;
      return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clerk app</title><script src="${otherBase()}/npm/clerk.js"></script></head><body><script>${script}</script></body></html>`);
    }

    // ---- three traps (C3): a sign-in that looks done but isn't
    if ((p === "/trap-email" || p === "/trap-code" || p === "/trap-wrong") && method === "POST") {
      await fields();
      event(`half${p}`);
      if (p === "/trap-email") return html(page("Almost there — Fixture App", `<main><h1>Check your email</h1><p>We sent you a link to finish signing in. <a href="/">Back home</a></p></main>`));
      if (p === "/trap-code") return html(page("Verify — Fixture App", `<main><h1>Enter your code</h1><form method="post" action="/trap-code/verify"><p><label for="code">Verification code</label> <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></p><p><button type="submit">Verify</button></p></form></main>`));
      return html(page("Sign in — Fixture App", `<main><h1>Something went wrong</h1><p role="alert">Wrong password. <a href="/trap-wrong">Try again</a></p></main>`));
    }
    if (p === "/trap-email" || p === "/trap-code" || p === "/trap-wrong") return html(page("Sign in — Fixture App", form(p)));

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  const otherServer = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const u = new URL(path, "http://localhost");
    log.push(`other:${u.pathname}`);
    if (u.pathname === "/magic/verify") {
      log.push("/_event/opened/magic-port");
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Signed in — Another host", "<main><h1>Link opened</h1><p>Signed in on another port.</p></main>"));
    }
    other.push({ path: u.pathname, method: req.method ?? "GET", query: [...u.searchParams.keys()], headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, hash(String(v))])) });
    const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    // The Clerk-shaped Frontend API: test mode on when the request carries a Testing Token this fixture made.
    if (u.pathname.startsWith("/v1/")) {
      const t = u.searchParams.get("__clerk_testing_token");
      if (t) log.push(clerkTokens.includes(t) ? "/_event/clerk/token" : "/_event/clerk/bad-token");
      return res.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify({ testing: Boolean(t && clerkTokens.includes(t)) }));
    }
    if (u.pathname.startsWith("/npm/")) return res.writeHead(200, { "content-type": "text/javascript", ...cors }).end("/* clerk */");
    if (u.pathname === "/api/ping") return res.writeHead(200, { "content-type": "text/plain", ...cors }).end("ok");
    if (u.pathname === "/landing") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors }).end(page("Docs — Another host", "<main><h1>Our docs</h1><p>On another host.</p></main>"));
    // The fake sign-in provider: a page to sign in on (a person types there, never the tester), and a popup that answers its opener.
    if (u.pathname === "/authorize") {
      if (u.searchParams.get("popup") === "1") {
        log.push("/_event/provider/popup");
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Fixture ID", "<main><h1>Fixture ID</h1><p>Signing you in…</p></main>", `setTimeout(() => { if (window.opener) window.opener.postMessage({ who: "oauth.user@example.test" }, "*"); window.close(); }, 400);`));
      }
      log.push("/_event/provider/authorize");
      const back = u.searchParams.get("redirect_uri") ?? "";
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Sign in to Fixture ID", `<main><h1>Sign in to Fixture ID</h1><p>to continue to Fixture App</p><form method="post" action="/idp/login"><input type="hidden" name="back" value="${esc(back)}"><p><label for="idp-email">Email</label> <input id="idp-email" name="email" type="email"></p><p><label for="idp-password">Password</label> <input id="idp-password" name="password" type="password"></p><p><button type="submit">Sign in</button></p></form></main>`));
    }
    if (u.pathname === "/idp/login" && req.method === "POST") {
      const f = new URLSearchParams(await readBody(req));
      log.push("/_event/provider/typed");
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (!ok(email, f.get("password") ?? "")) return res.writeHead(401, { "content-type": "text/html; charset=utf-8" }).end(page("Fixture ID", "<main><h1>Wrong password</h1></main>"));
      const code = mint(randomBytes(10).toString("hex"));
      links.set(code, email);
      const back = f.get("back") || `http://127.0.0.1:${port}/oauth/callback`;
      return res.writeHead(303, { location: `${back}?code=${code}`, "set-cookie": `idp_sid=${mint(randomBytes(12).toString("hex"))}; Path=/; HttpOnly; SameSite=Lax`, "cache-control": "no-store" }).end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors }).end(page("Another host", "<main><h1>Another host</h1></main>"));
  });

  const listen = (server: Server, host: string) => new Promise<number>((done) => server.listen(0, host, () => done((server.address() as AddressInfo).port)));
  port = await listen(main, "127.0.0.1");
  const port2 = await listen(otherServer, "127.0.0.1");
  port2Ref = port2;
  const close = (s: Server) => new Promise<void>((done) => {
    s.closeAllConnections();
    s.close(() => done());
  });
  const count = (kind: string, route?: string) => log.filter((h) => (route ? h === `/_event/${kind}${route}` : h.startsWith(`/_event/${kind}/`))).length;
  return {
    url: `http://127.0.0.1:${port}/`,
    otherUrl: `http://localhost:${port2}/`,
    hits: () => [...log],
    otherLog: () => [...other],
    clerkTokens: () => [...clerkTokens],
    clerkPublishableKey: `pk_test_${Buffer.from(`localhost:${port2}$`).toString("base64")}`,
    expireAll: () => {
      sessions.clear();
      rotateLive.clear();
      event("expire");
    },
    setPassword: (u, pw) => void users.set(u.toLowerCase(), pw),
    sendMail(m) {
      const mail: Mail = { ID: `m${++mailId}`, from: m.from ?? "no-reply@fixture.test", to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), created: new Date().toISOString() };
      mails.push(mail);
      return mail;
    },
    setMailDown: (down) => {
      mailDown = down;
    },
    signIns: (route) => count("signin", route),
    refusals: (route) => count("refused", route),
    minted: () => [...minted],
    signUps: () => [...signedUp],
    close: async () => {
      await Promise.all([close(main), close(otherServer)]);
    },
  };
}
