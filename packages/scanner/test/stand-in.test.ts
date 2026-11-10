import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backgroundHost } from "../src/scan.ts";
import { documentText, isLocalHost, NO_ACCESS, NOWHERE_PATH, oneRowOf, plainPath, proxyPrefix, sameDrawing, sameShell, sameWords, Seal, STAND_IN_EMAIL, STAND_IN_USER_ID, standInRefusal, WALL_WORDS, type Asked, type Reply } from "../src/stand-in.ts";

const START = new URL("http://localhost:5173/");
const SHELL = `<!doctype html><head><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/logo.svg"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>`;
const seal = (config = {}) => {
  const made = new Seal({ start: START, config, publicScreens: [], background: backgroundHost, graphqlRead: (body) => (body ?? "").startsWith("query") });
  made.shell = SHELL;
  return made;
};
const asked = (href: string, more: Partial<Asked> = {}): Asked => ({ method: "GET", type: "fetch", url: new URL(href, START), headers: {}, ...more });
const replyOf = (verdict: { reply?: Reply }) => verdict.reply!;
const bodyOf = (reply: Reply) => JSON.parse(reply.body ?? "null");

describe("local addresses", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "app.localhost", "a.b.localhost"])("%s is", (host) => expect(isLocalHost(host)).toBe(true));
  it.each(["example.com", "localhost.example.com", "127.0.0.1.nip.io", "notlocalhost", "10.0.0.5", "192.168.1.2", "0.0.0.0", "evil.example,x.localhost", "evil.example;x.localhost", "a b.localhost"])("%s isn't", (host) => expect(isLocalHost(host)).toBe(false));

  it("a user name in the address is a real sign-in, and refused", () => {
    expect(standInRefusal({ startUrl: "http://me:secret@localhost:3000/" })).toBeDefined();
    expect(standInRefusal({ startUrl: "http://localhost:3000/" })).toBeUndefined();
    expect(standInRefusal({ startUrl: "https://app.example.com/" })).toMatch(/local address/);
  });
});

describe("the allow rule", () => {
  it.each([
    ["GET", "/trades"],
    ["GET", "/"],
    ["HEAD", "/x"],
  ])("answers %s %s with the app's one document: no page address reaches the server", (method, path) => {
    expect(seal().judge(asked(path, { method, type: "document" })).act).toBe("shell");
  });

  it("has no document to give until it has read one", () => {
    const unread = new Seal({ start: START, config: {}, publicScreens: [], background: backgroundHost, graphqlRead: () => false });
    expect(unread.judge(asked("/trades", { type: "document" })).act).toBe("refuse");
  });

  it("takes a form sent by loading a page for a save, and a frame's page load for nothing", () => {
    expect(seal().judge(asked("/trades", { method: "POST", type: "document", body: "a=1" })).act).toBe("save");
    expect(seal().judge(asked("https://elsewhere.example/form", { method: "POST", type: "document" })).act).toBe("save");
    expect(seal().judge(asked("/trades", { type: "document", inFrame: true })).act).toBe("refuse");
    expect(seal().judge(asked("/trades", { method: "POST", type: "document", inFrame: true })).act).toBe("refuse");
  });

  it.each([
    ["GET", "script", "/src/main.tsx"],
    ["GET", "script", "/@vite/client"],
    ["GET", "script", "/@react-refresh"],
    ["GET", "script", "/node_modules/.vite/deps/react.js?v=1234"],
    ["GET", "stylesheet", "/src/index.css?t=1"],
    ["GET", "image", "/logo.svg"],
    ["GET", "image", "/assets/logo.svg"],
    ["GET", "script", "/_next/static/chunks/main.js"],
  ])("lets %s %s %s go on", (method, type, path) => {
    expect(seal().judge(asked(path, { method, type })).act).toBe("file");
  });

  it.each([
    ["GET", "script", "https://cdn.example.com/x.js"],
    ["GET", "image", "http://localhost:8000/x.png"],
    ["GET", "document", "http://127.0.0.1:5173/"],
    ["GET", "document", "/api/export"],
    ["GET", "script", "/api/config.js"],
    ["GET", "image", "/api/pixel.png"],
    ["GET", "image", "/avatar/1"],
    ["GET", "script", "/config"],
    ["GET", "stylesheet", "/graphql/theme.css"],
    // Beside the page is no proof of anything: an unseen proxy takes these as readily.
    ["GET", "script", "/widgets.js"],
    ["GET", "image", "/chart.png"],
    ["GET", "image", "/svc/chart.png"],
    ["GET", "document", "/report.php"],
    ["GET", "media", "/movie.mp4"],
    ["GET", "eventsource", "/live"],
    ["POST", "ping", "/beacon"],
    ["GET", "manifest", "/app.webmanifest"],
    ["GET", "other", "/thing"],
    ["GET", "websocket", "/hmr"],
    // Named like files, and any of them could be a dev proxy's (see isFile).
    ["GET", "image", "/backend/pixel.png"],
    ["GET", "script", "/backend/report.js"],
    ["GET", "stylesheet", "/proxy/theme.css"],
    ["GET", "font", "/upstream/f.woff2"],
    ["GET", "image", "/.env"],
    ["GET", "script", "/.git/config.js"],
    ["GET", "image", "/config/.env.local"],
  ])("refuses %s %s %s", (method, type, path) => {
    expect(seal().judge(asked(path, { method, type })).act).toBe("refuse");
  });

  it("answers every fetch and XHR here, same-origin too, files included", () => {
    for (const href of ["/api/me", "/config.json", "http://localhost:5173/x.js", "https://api.example.com/v1/x"]) {
      for (const type of ["fetch", "xhr"]) expect(seal().judge(asked(href, { type })).act).toBe("answer");
    }
  });

  it("treats a call that writes as a save to learn, unless nobody's action", () => {
    expect(seal().judge(asked("/api/items", { method: "POST", body: "{}" })).act).toBe("save");
    expect(seal().judge(asked("https://api.example.com/items", { method: "DELETE" })).act).toBe("save");
    expect(seal().judge(asked("/graphql", { method: "POST", body: "query { me }" })).act).toBe("answer");
    expect(seal().judge(asked("https://www.google-analytics.com/collect", { method: "POST" })).act).toBe("answer");
  });

  it("falls back to an empty list, and to no body for what isn't JSON", () => {
    const list = seal().judge(asked("/api/items")) as { reply: Reply };
    expect(bodyOf(list.reply)).toEqual([]);
    const text = seal().judge(asked("/fragment", { headers: { accept: "text/html" } })) as { reply: Reply };
    expect(text.reply).toEqual({ status: 204 });
  });

  it("uses rows supplied by address", () => {
    const s = seal({ rows: { "/api/plan": { plan: "free" }, "POST /api/quote": { price: 1 } } });
    expect(bodyOf(replyOf(s.judge(asked("/api/plan")) as { reply: Reply }))).toEqual({ plan: "free" });
    expect(s.judge(asked("/api/quote", { method: "POST" }))).toMatchObject({ act: "save", reply: { status: 200 } });
  });

  it("tells a redirect's hop by the same rule", () => {
    const s = seal();
    expect(s.isFile({ method: "GET", type: "script", url: new URL("/src/next.js", START) })).toBe(true);
    expect(s.isFile({ method: "GET", type: "script", url: new URL("https://evil.example/next.js") })).toBe(false);
    expect(s.isFile({ method: "GET", type: "document", url: new URL("/api/go", START) })).toBe(false);
  });

  it("refuses what the project says is handed on, the same as a page or a file", () => {
    const s = seal({ proxied: ["/backend", "/internal/"] });
    expect(s.judge(asked("/backend", { type: "document" })).act).toBe("refuse");
    expect(s.judge(asked("/backend/report", { type: "document" })).act).toBe("refuse");
    expect(s.judge(asked("/internal/x.png", { type: "image" })).act).toBe("refuse");
    // Dev proxies go by how an address starts, so this one's taken too. One short of that isn't.
    expect(s.judge(asked("/backendish", { type: "document" })).act).toBe("refuse");
    expect(s.judge(asked("/backen", { type: "document" })).act).toBe("shell");
    expect(s.judge(asked("/%62ackend/x", { type: "document" })).act).toBe("refuse");
  });

  it("with everything else handed on, believes only what's really a file", () => {
    const s = seal({ proxied: ["*"] });
    expect(s.judge(asked("/logo.svg", { type: "image" })).act).toBe("refuse");
    expect(s.judge(asked("/@vite/client", { type: "script" })).act).toBe("file");
  });

  it("believes the app's folder over the look of an address, and never for a hidden file", () => {
    const folder = mkdtempSync(join(tmpdir(), "seal-"));
    mkdirSync(join(folder, "public/auth"), { recursive: true });
    writeFileSync(join(folder, "public/auth/stone.jpg"), "x");
    writeFileSync(join(folder, "public/.env"), "x");
    const s = seal({ folder });
    expect(s.judge(asked("/auth/stone.jpg", { type: "image" })).act).toBe("file");
    expect(s.judge(asked("/auth/other.jpg", { type: "image" })).act).toBe("refuse");
    expect(s.judge(asked("/.env", { type: "image" })).act).toBe("refuse");
    expect(s.judge(asked("/%2e%2e/%2e%2e/etc/hosts", { type: "image" })).act).toBe("refuse");
  });

  it("tests the address as the server reads it, before anything on disk can speak for it", () => {
    const folder = mkdtempSync(join(tmpdir(), "seal-"));
    for (const dir of ["api", "src/api", "public/auth"]) mkdirSync(join(folder, dir), { recursive: true });
    for (const file of ["api/export.js", ".env", "pixel.php", "src/api/client.ts", "public/auth/stone.jpg", "public/auth/run.js"]) writeFileSync(join(folder, file), "x");
    const s = seal({ folder });
    for (const [path, type] of [["/api/export.js", "script"], ["/%61pi/export.js", "script"], ["/pixel.php", "image"], ["/pixel%2ephp", "image"], ["/%2eenv", "image"], ["/%252eenv", "image"], ["/public/%2eenv", "image"], ["/auth/run.js", "script"]] as const) {
      expect(s.judge(asked(path, { type })).act).toBe("refuse");
    }
    // What only looks like those, and isn't: a client for an API is a module, and a picture is a picture.
    expect(s.judge(asked("/src/api/client.ts", { type: "script" })).act).toBe("file");
    expect(s.judge(asked("/auth/stone.jpg", { type: "image" })).act).toBe("file");
    expect(s.judge(asked("/node_modules/.vite/deps/react.js", { type: "script" })).act).toBe("file");
  });

  it("reads no address that spells out the stand-in, however it got there", () => {
    const s = seal();
    expect(s.judge(asked(`/assets/${STAND_IN_USER_ID}.png`, { type: "image" })).act).toBe("refuse");
    expect(s.judge(asked(`/assets/${encodeURIComponent(STAND_IN_EMAIL)}.png`, { type: "image" })).act).toBe("refuse");
    expect(s.judge(asked(`/assets/a.png?u=${STAND_IN_USER_ID}`, { type: "image" })).act).toBe("refuse");
    expect(s.isPage(new URL(`/u/${STAND_IN_USER_ID}`, START))).toBe(false);
    expect(s.judge(asked("/assets/a.png?u=7", { type: "image" })).act).toBe("file");
  });

  it("can't decode what isn't an address", () => {
    expect(plainPath(new URL("/%E0%A4%A", START))).toBeUndefined();
    expect(seal().judge(asked("/assets/%E0%A4%A.js", { type: "script" })).act).toBe("refuse");
    expect(seal().isPage(new URL("/%E0%A4%A", START))).toBe(false);
  });

  it("leaves the browser no way out at all, and names no address in its flags", () => {
    expect(seal().browserArgs).toEqual(["--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://seal.invalid:1", "--proxy-bypass-list=<-loopback>"]);
    const named = new Seal({ start: new URL("http://evil.example,x.localhost:1/"), config: {}, publicScreens: [], background: backgroundHost, graphqlRead: () => false });
    expect(named.browserArgs).toEqual(seal().browserArgs);
  });
});

describe("Supabase's answers", () => {
  const rest = "https://abcdefgh.supabase.co/rest/v1";
  const auth = "https://abcdefgh.supabase.co/auth/v1";
  const rows = [{ id: "1", symbol: "A" }, { id: "2", symbol: "B" }, { id: "3", symbol: "C" }];

  it("needs no project name: any host of that shape shows the library", () => {
    const s = seal();
    expect(s.adapter).toBeUndefined();
    s.judge(asked(`${auth}/user`));
    expect(s.adapter).toBe("supabase");
  });

  it("gives a session whose token is plainly no one's, expiring a day ahead", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    const [recipe] = seal().recipes(now);
    expect(new RegExp(recipe!.pattern).test("sb-abcdefgh-auth-token")).toBe(true);
    expect(new RegExp(recipe!.pattern).test("sb-abcdefgh-auth-token-code-verifier")).toBe(false);
    const session = JSON.parse(recipe!.value);
    expect(session.expires_at).toBe(now / 1000 + 86_400);
    expect(session.user.email_confirmed_at).toBeTruthy();
    expect(session.user.id).toBe(STAND_IN_USER_ID);
    const header = JSON.parse(Buffer.from(session.access_token.split(".")[0], "base64url").toString());
    expect(header.alg).toBe("none");
    expect(session.access_token.split(".")[2]).toBe("stand-in");
  });

  it("uses a key the app chose, escaped, ahead of the usual one", () => {
    const [recipe] = seal({ provider: "supabase", storageKey: "acme.auth.v1" }).recipes();
    expect(recipe!.pattern).toBe("^acme\\.auth\\.v1$");
  });

  it("answers its own upkeep quietly, and a change to the user as a save", () => {
    expect(seal().judge(asked(`${auth}/user`))).toMatchObject({ act: "answer" });
    expect(seal().judge(asked(`${auth}/user`, { method: "PUT", body: "{}" }))).toMatchObject({ act: "save" });
    expect(seal().judge(asked(`${auth}/token?grant_type=refresh_token`, { method: "POST" }))).toMatchObject({ act: "answer" });
    expect(seal().judge(asked(`${auth}/logout`, { method: "POST" }))).toMatchObject({ act: "answer", reply: { status: 204 } });
  });

  it("reads a table as PostgREST does: rows, a count, and one object or 406 for .single()", () => {
    const s = seal({ rows: { trades: rows } });
    const all = replyOf(s.judge(asked(`${rest}/trades?select=*&limit=2`)) as { reply: Reply });
    expect(bodyOf(all)).toHaveLength(2);
    expect(all.headers?.["content-range"]).toBe("0-1/3");
    const one = replyOf(s.judge(asked(`${rest}/trades?id=eq.2`, { headers: { accept: "application/vnd.pgrst.object+json" } })) as { reply: Reply });
    expect(bodyOf(one)).toEqual(rows[1]);
    const none = replyOf(s.judge(asked(`${rest}/trades?id=eq.9`, { headers: { accept: "application/vnd.pgrst.object+json" } })) as { reply: Reply });
    expect(none.status).toBe(406);
    const empty = replyOf(s.judge(asked(`${rest}/notes?select=*`)) as { reply: Reply });
    expect(bodyOf(empty)).toEqual([]);
    expect(empty.headers?.["content-range"]).toBe("*/0");
  });

  it("doesn't filter sample rows by the stand-in's own id", () => {
    const reply = replyOf(seal({ rows: { trades: rows } }).judge(asked(`${rest}/trades?user_id=eq.${STAND_IN_USER_ID}`)) as { reply: Reply });
    expect(bodyOf(reply)).toHaveLength(3);
  });

  it("answers a count with HEAD and no body", () => {
    const reply = replyOf(seal({ rows: { trades: rows } }).judge(asked(`${rest}/trades?select=*`, { method: "HEAD" })) as { reply: Reply });
    expect(reply.body).toBeUndefined();
    expect(reply.headers?.["content-range"]).toBe("0-2/3");
  });

  it("stops a write, answering what the client asked to get back", () => {
    const sent = { method: "POST", body: JSON.stringify({ symbol: "T" }), headers: { prefer: "return=representation" } };
    const back = seal().judge(asked(`${rest}/trades`, sent));
    expect(back).toMatchObject({ act: "save", reply: { status: 201 } });
    expect(bodyOf(replyOf(back as { reply: Reply }))).toEqual([{ id: "1", symbol: "T" }]);
    expect(seal().judge(asked(`${rest}/trades`, { method: "POST", body: "{}" }))).toMatchObject({ act: "save", reply: { status: 201 } });
    expect(seal().judge(asked(`${rest}/trades?id=eq.1`, { method: "DELETE" }))).toMatchObject({ act: "save", reply: { status: 204 } });
  });

  it("counts a function call as a save, with an empty result", () => {
    const call = seal({ rows: { "rpc/summary": [{ n: 1 }] } }).judge(asked(`${rest}/rpc/summary`, { method: "POST", body: "{}" }));
    expect(call.act).toBe("save");
    expect(bodyOf(replyOf(call as { reply: Reply }))).toEqual([{ n: 1 }]);
    expect(bodyOf(replyOf(seal().judge(asked(`${rest}/rpc/other`, { method: "POST" })) as { reply: Reply }))).toEqual([]);
  });

  it("keeps a library out when another was named", () => {
    expect(seal({ provider: "acme" }).unknownProvider).toBe(true);
    expect(seal({ provider: "supabase" }).unknownProvider).toBe(false);
    expect(seal({ provider: " Supabase " }).unknownProvider).toBe(false);
  });
});

describe("what says a page turned someone away", () => {
  it.each(["Access Denied", "Access denied.", "ACCESS DENIED", "403 Forbidden", "403 - Access denied", "Not authorized", "Unauthorised", "Permission denied", "You don't have access to this page", "You do not have permission", "Admins only", "Staff only", "Sorry, access denied", "Forbidden", "You are not authorized to view this page", "You're not allowed to see this page", "Admin access required", "Insufficient permissions", "Access restricted"])("%s does", (text) => expect(NO_ACCESS.test(text)).toBe(true));
  it.each(["Access denied errors in your logs", "Permissions", "Manage access", "Who has access", "Forbidden words", "Restricted", "Admin", "How to fix a 403", "Ask an admin for access to more features", "Admin access", "Sorry, we couldn't load this", "You are not alone", "Staff access levels", "Admin required fields"])("%s doesn't", (text) => expect(NO_ACCESS.test(text)).toBe(false));
});

describe("a document that decides for itself", () => {
  const doc = (head = "", body = "") => `<!doctype html><html><head><title>Acme</title>${head}</head><body><div id="root">${body}</div><script src="/app.js"></script></body></html>`;
  it.each([
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=/login">'],
    ["an inline guard", '<script>if(!document.cookie.includes("sid"))location.replace("/login")</script>'],
    ["inline state", '<script>window.__DATA__={user:null,redirect:"/login"}</script>'],
  ])("%s makes it the server's, though nothing shows", (_name, head) => expect(sameShell(doc(), doc(head))).toBe(false));

  it("isn't told by what changes with every answer", () => {
    const a = doc('<script nonce="abc123">window.__nonce="abc123";window.__A=1</script><script>window.__REQUEST="0f8fad5b-d9cb-469f-a165-70867728950e"</script>');
    const b = doc('<script nonce="zzz999">window.__nonce="zzz999";window.__A=1</script><script>window.__REQUEST="7c9e6679-7425-40de-944b-e07fc1f90ae7"</script>');
    expect(sameShell(a, b)).toBe(true);
  });

  it("is the same for one document sent twice, inline scripts and all", () => {
    const one = doc('<script type="module">import { x } from "/@react-refresh"; x(window);</script>');
    expect(sameShell(one, one)).toBe(true);
  });
});

describe("the one document every address gets", () => {
  const page = `<body><div id="root"></div><script src="/app.js"></script></body>`;

  it("is told from any other, however short", () => {
    expect(sameShell(page, page)).toBe(true);
    expect(sameShell(page, `<body><h1>Old news</h1><p>A page with its own words on it, sent by the server.</p></body>`)).toBe(false);
    expect(sameShell(page, `<body><p>Please sign in</p><script src="/app.js"></script></body>`)).toBe(false);
    expect(sameShell(page, `<body><h1>Invoices</h1><p>You have 0 invoices</p></body>`)).toBe(false);
  });

  it("is also told by what it loads", () => {
    expect(sameShell(page, `<body><div id="root"></div><script src="/page-chunk.js"></script></body>`)).toBe(false);
  });
});

describe("one page drawn twice", () => {
  const page = "Connect your account with the ledger and it sends each invoice as it happens with the name you set and the total you set too";
  it("is the same give or take a bar", () => expect(sameWords(page, `${page} view as staff`)).toBe(true));
  it("isn't the same as a sign-in form", () => expect(sameWords(page, "Welcome back Continue with Google Sign in")).toBe(false));
  it("isn't the same as a short page with one word changed", () => expect(sameWords("Trades one", "Trades two")).toBe(false));
});

describe("words of what isn't a screen", () => {
  const says = (name: keyof typeof WALL_WORDS, text: string) => new RegExp(WALL_WORDS[name], "i").test(text);
  it.each([
    ["verify", "Verify your email"], ["verify", "Check your inbox for a link"], ["verify", "Enter your 6-digit code"], ["verify", "We sent you a magic link"], ["verify", "Confirm your account"],
    ["paywall", "Your trial has ended"], ["paywall", "Your free trial expired on Monday"], ["paywall", "Upgrade to continue"], ["paywall", "Choose a plan to continue"], ["paywall", "Your subscription has lapsed"],
    ["failed", "Something went wrong"], ["failed", "Oops! Something went wrong. Please try again."], ["failed", "404 - Page not found"], ["failed", "Application error"], ["failed", "Failed to load trades"], ["failed", "Couldn't load your data"], ["failed", "Authorization Failed"], ["failed", "Sign-in failed"], ["failed", "Connection failed, try again"],
    ["loading", "Loading…"], ["loading", "Please wait"], ["loading", "Loading your dashboard"],
    ["asksSignIn", "Sign in to continue"], ["asksSignIn", "Please log in"], ["asksSignIn", "Login required"],
    ["provider", "Continue with Google"], ["provider", "Sign in with GitHub"],
  ] as const)("%s: %s", (name, text) => expect(says(name, text)).toBe(true));

  it.each([
    ["verify", "How to verify your email domain with DNS"], ["verify", "Email verified"], ["verify", "Codes"],
    ["paywall", "Trial balance"], ["paywall", "Upgrade"], ["paywall", "Plans"], ["paywall", "Trial ends in 12 days"],
    ["failed", "Why did something go wrong?"], ["failed", "Failed payments"], ["failed", "Error rate"], ["failed", "Errors"], ["failed", "Not found in your list? Add it"],
    ["loading", "Loading dock schedule for the whole warehouse this quarter"], ["loading", "Loads"],
    ["asksSignIn", "Sign-in history"], ["asksSignIn", "Sign in activity"], ["provider", "Connect Google"], ["provider", "Continue"],
  ] as const)("not %s: %s", (name, text) => expect(says(name, text)).toBe(false));
});

describe("a document's own text", () => {
  it("leaves out what only runs in the browser", () => {
    expect(documentText(`<html><head><title>X</title></head><body><div id="root"></div><noscript>Turn on JavaScript</noscript><script>let a = "<p>hi</p>";</script><style>p{}</style></body></html>`)).toBe("");
    expect(documentText(`<body><h1>Your trades</h1><!-- note --><p>Three of them</p></body>`)).toBe("Your trades Three of them");
  });
});

describe("what Node sends when it reads for the page", () => {
  const heard: string[] = [];
  let server: http.Server;
  let start: URL;
  const replies: Record<string, { type: string; body: string }> = {
    "/src/main.tsx": { type: "text/javascript", body: `import logo from "/src/logo.svg?import"; import "./own.js?v=1a2b"; new Worker(new URL("/src/work.js?worker_file", import.meta.url)); fetch("/svc/data.png"); const u = "/svc/string.js";` },
  };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      heard.push(req.url ?? "");
      const reply = replies[new URL(req.url ?? "/", "http://x").pathname];
      res.writeHead(200, { "content-type": reply?.type ?? "text/plain" }).end(reply?.body ?? "x");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    start = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const made = (config = {}, publicScreens: string[] = []) => {
    const s = new Seal({ start, config, publicScreens, background: () => false, graphqlRead: () => false });
    s.shell = `<!doctype html><script src="/widgets.js"></script><script type="module" src="/src/main.tsx"></script>`;
    return s;
  };
  const read = (s: Seal, path: string, type = "script") => s.readFile({ method: "GET", type, url: new URL(path, start), headers: {} });

  it("never carries a query the page made up", async () => {
    heard.length = 0;
    const token = ["eyJzdWIiOiJzb21lIn0", "sig"].join(".");
    const s = made();
    expect(s.isFile({ method: "GET", type: "script", url: new URL(`/widgets.js?sid=${token}`, start) })).toBe(true);
    await read(s, `/widgets.js?sid=${token}`);
    expect(heard).toEqual(["/widgets.js"]);
  });

  it("keeps a dev server's own query, which is part of the file's name in what it sent", async () => {
    heard.length = 0;
    const s = made();
    await read(s, "/src/main.tsx");
    await read(s, "/src/logo.svg?import");
    await read(s, "/own.js?v=1a2b".replace("/own", "/src/own"));
    await read(s, "/src/work.js?worker_file");
    expect(heard).toEqual(["/src/main.tsx", "/src/logo.svg?import", "/src/own.js?v=1a2b", "/src/work.js?worker_file"]);
    // The same name with anything else on the end is the page's own doing.
    await read(s, "/src/logo.svg?import&sid=abc");
    expect(heard.at(-1)).toBe("/src/logo.svg");
  });

  it("takes what the app's modules load as named, and no string or call that looks like a path", async () => {
    const s = made();
    await read(s, "/src/main.tsx");
    const file = (path: string) => s.isFile({ method: "GET", type: "script", url: new URL(path, start) });
    expect(file("/src/own.js")).toBe(true);
    const bare = made();
    bare.shell = `<!doctype html><script src="/a.js"></script>`;
    replies["/a.js"] = { type: "text/javascript", body: `import "/lib/b.js"; fetch("/svc/data.png"); const u = "/svc/string.js"; const r = "<a href='/svc/page'>";` };
    await read(bare, "/a.js");
    const named = (path: string) => bare.isFile({ method: "GET", type: "script", url: new URL(path, start) });
    expect(named("/lib/b.js")).toBe(true);
    expect(named("/svc/data.png")).toBe(false);
    expect(named("/svc/string.js")).toBe(false);
  });

  it("asks the server only about addresses something stands behind, and with no query", async () => {
    heard.length = 0;
    const s = made({ addresses: ["/trades"] }, ["/pricing"]);
    expect(await s.documentFor(new URL("/svc/feed", start).href)).toBe("shell");
    expect(await s.documentFor(new URL("/svc/feed?sid=abc", start).href)).toBe("shell");
    expect(heard).toEqual([]);
    await s.documentFor(new URL("/trades?sid=abc", start).href);
    await s.documentFor(new URL("/pricing", start).href);
    expect(heard).toEqual(["/trades", "/pricing"]);
  });

  it("reads no address that's only a try: queued, and no fetch from Node, whatever spelled it", async () => {
    heard.length = 0;
    const s = made({ addresses: ["/jobs/nightly-digest", "/trades"], tryOnly: ["/jobs/nightly-digest"] }, []);
    expect(s.addresses.map((href) => new URL(href).pathname)).toEqual(["/jobs/nightly-digest", "/trades"]);
    expect(await s.documentFor(new URL("/jobs/nightly-digest", start).href)).toBe("shell");
    expect(heard).toEqual([]);
    // Something else standing behind it is still something: one list can't take that back.
    await s.documentFor(new URL("/trades", start).href);
    expect(heard).toEqual(["/trades"]);
    const opened = made({ addresses: ["/pricing"], tryOnly: ["/pricing"] }, ["/pricing"]);
    heard.length = 0;
    await opened.documentFor(new URL("/pricing", start).href);
    expect(heard).toEqual(["/pricing"]);
  });

  it("reads no page at all where the dev server hands on everything else", async () => {
    heard.length = 0;
    const s = made({ addresses: ["/trades"], proxied: ["*"] }, ["/pricing"]);
    expect(await s.documentFor(new URL("/trades", start).href)).toBe("shell");
    expect(await s.documentFor(new URL("/pricing", start).href)).toBe("shell");
    expect(heard).toEqual([]);
  });

  it("doesn't follow a read onto a proxy's address", async () => {
    const moved = http.createServer((req, res) => {
      heard.push(`moved ${req.url}`);
      if (req.url === "/trades") return res.writeHead(302, { location: "/backend/x" }).end();
      res.writeHead(200, { "content-type": "text/html" }).end("x");
    });
    await new Promise<void>((resolve) => moved.listen(0, "127.0.0.1", resolve));
    const at = new URL(`http://127.0.0.1:${(moved.address() as AddressInfo).port}/`);
    const s = new Seal({ start: at, config: { addresses: ["/trades"], proxied: ["/backend"] }, publicScreens: [], background: () => false, graphqlRead: () => false });
    heard.length = 0;
    expect(await s.documentFor(new URL("/trades", at).href)).toBe("decided");
    expect(heard).toEqual(["moved /trades"]);
    moved.closeAllConnections();
    moved.close();
  });
});

describe("telling a screen from what isn't one", () => {
  const drew = (s: Seal, path: string, text: string, values: string[] = [], more: { rows?: number; fields?: number; listed?: string; heading?: string } = {}) => s.drawn.set(path, { href: `http://localhost:5173${path}`, text, values, ...more });
  const words = "Your request is waiting for approval by an administrator of your team, which can take a while";

  it("a wall that only repeats its address is one wall, at both", () => {
    expect(sameDrawing({ path: "/trades", text: `Trades is closed. ${words}` }, { path: "/settings", text: `Settings is closed. ${words}` })).toBe(true);
  });
  it("what's left of two short pages proves nothing", () => {
    expect(sameDrawing({ path: "/trades", text: "Trades" }, { path: "/settings", text: "Settings" })).toBe(false);
    expect(sameDrawing({ path: "/a", text: "" }, { path: "/b", text: "" })).toBe(false);
  });
  it("two screens built alike aren't one, when more than the address differs", () => {
    expect(sameDrawing({ path: "/trades", text: "Trades No trades yet. Once your trades are in, they show here. Add trade" }, { path: "/notes", text: "Notes No notes yet. Once your notes are in, they show here. Add note" })).toBe(false);
  });

  it("leaves out what a wall changes between addresses: its heading, and anything with a digit", () => {
    const wall = "Your account is on hold, so contact support";
    expect(sameDrawing({ path: "/a", text: `Dashboard ${wall}`, heading: "Dashboard" }, { path: "/b", text: `Preferences ${wall}`, heading: "Preferences" })).toBe(true);
    expect(sameDrawing({ path: "/a", text: "Dashboard No company found", heading: "Dashboard" }, { path: "/b", text: "Preferences No company found", heading: "Preferences" })).toBe(true);
    expect(sameDrawing({ path: "/a", text: `${wall} ref a1b2c3 at 10:04:22` }, { path: "/b", text: `${wall} ref z9y8x7 at 11:15:01` })).toBe(true);
  });
  it("compares as a share of the shorter, but a menu alone isn't every page that has it", () => {
    expect(sameDrawing({ path: "/a", text: words }, { path: "/b", text: `${words} Back to start` })).toBe(true);
    expect(sameDrawing({ path: "/a", text: "Overview Trades Reports Settings Help Log out" }, { path: "/b", text: "Overview Trades Reports Settings Help Log out Your open positions and what each one has made since the start of the month" })).toBe(false);
  });

  it("marks every address that shared a drawing, the first too", () => {
    const s = seal();
    drew(s, "/trades", words);
    expect(s.sameAsSeen("/settings", { text: words, values: [] })).toBe(true);
    s.nowhere = { path: NOWHERE_PATH, text: "Not here" };
    expect(s.sort(["/trades"])).toMatchObject({ shown: [], unclear: ["/trades"] });
  });

  it("takes what the app draws for no address as what a wall looks like", () => {
    const s = seal();
    drew(s, "/trades", words);
    s.nowhere = { path: NOWHERE_PATH, text: words };
    expect(s.sort(["/trades"])).toMatchObject({ shown: [], unclear: ["/trades"] });
  });

  it("takes a page that only says its address as nothing, if an address that can't exist does too", () => {
    const s = seal();
    drew(s, "/trades", "Trades");
    s.nowhere = { path: NOWHERE_PATH, text: "Xqzstandinnowhere" };
    expect(s.sort(["/trades"])).toMatchObject({ shown: [], unclear: ["/trades"] });
    const real = seal();
    drew(real, "/reports", "Reports", [], { rows: 4 });
    drew(real, "/notes", "Something else altogether, about notes");
    real.nowhere = { path: NOWHERE_PATH, text: "Page not found" };
    expect(real.sort(["/reports", "/notes"]).shown).toEqual(["/reports", "/notes"]);
  });

  it("doesn't call one drawing a screen for differing from the page for no address", () => {
    const s = seal();
    drew(s, "/trades", words, [], { rows: 9, fields: 3 });
    s.nowhere = { path: NOWHERE_PATH, text: "Page not found" };
    expect(s.sort(["/trades"])).toMatchObject({ shown: [], notShown: ["/trades"] });
  });

  it("two different drawings need one plainly at work: rows, or a form", () => {
    const bare = seal();
    drew(bare, "/trades", words, [], { rows: 1, fields: 1 });
    drew(bare, "/notes", "Something else altogether, about notes", [], { rows: 1, fields: 1 });
    expect(bare.sort(["/trades", "/notes"]).shown).toEqual([]);
    for (const more of [{ rows: 2 }, { fields: 2 }]) {
      const s = seal();
      drew(s, "/trades", words, [], more);
      drew(s, "/notes", "Something else altogether, about notes");
      expect(s.sort(["/trades", "/notes"]).shown.sort()).toEqual(["/notes", "/trades"]);
    }
  });

  it("with nothing to tell it from, doesn't call it one", () => {
    const s = seal();
    drew(s, "/trades", words);
    expect(s.sort(["/trades"])).toMatchObject({ shown: [], notShown: ["/trades"] });
    const moved = seal();
    drew(moved, "/trades", words);
    moved.nowhere = { path: "/trades", text: words };
    expect(moved.sort(["/trades"])).toMatchObject({ shown: [], notShown: ["/trades"] });
  });

  it("where the app moves an unknown address to a screen, another screen tells them apart", () => {
    const s = seal();
    drew(s, "/trades", words);
    drew(s, "/notes", "Something else altogether, about notes and how they are kept next to the trades", [], { fields: 2 });
    s.nowhere = { path: "/trades", text: words };
    expect(s.sort(["/trades", "/notes"]).shown.sort()).toEqual(["/notes", "/trades"]);
  });

  it("takes its own data as proof, unless the same is drawn for no address", () => {
    const s = seal();
    drew(s, "/trades", "Acme Corp", ["acme corp"], { listed: "Acme Corp" });
    expect(s.sort(["/trades"])).toMatchObject({ shown: ["/trades"], withData: ["/trades"] });
    s.nowhere = { path: NOWHERE_PATH, text: "Hello from Acme Corp" };
    expect(s.sort(["/trades"]).withData).toEqual([]);
  });

  it("takes a value in a list, or two that no sentence says by chance, and nothing less", () => {
    const sorted = (values: string[], listed = "") => {
      const s = seal();
      drew(s, "/trades", "The page", values, { listed });
      return s.sort(["/trades"]).withData;
    };
    expect(sorted(["active"], "active")).toEqual(["/trades"]);
    expect(sorted(["acme holdings", "inv-2041"])).toEqual(["/trades"]);
    expect(sorted(["acme holdings"])).toEqual([]);
    expect(sorted(["active"])).toEqual([]);
    expect(sorted(["active", "basic"])).toEqual([]);
  });

  it("a shared drawing stays unclear with values on it", () => {
    const s = seal();
    drew(s, "/home", "Select a workspace Northwind team Contoso team", ["northwind team", "contoso team"], { listed: "Northwind team Contoso team", rows: 2 });
    expect(s.sameAsSeen("/settings", { text: "Select a workspace Northwind team Contoso team", values: ["northwind team", "contoso team"], listed: "Northwind team Contoso team" })).toBe(true);
    expect(s.sort(["/home"])).toMatchObject({ shown: [], unclear: ["/home"], withData: [] });
  });

  it("counts a made-up value only as a whole word, in what was drawn", () => {
    const s = seal({ rows: { "/api/plans": [{ id: 1, name: "Basic", price: 1250, active: true, at: "2024-01-01", url: "https://x.example" }] } });
    s.judge(asked("/api/plans"));
    expect(s.valuesIn("Plans: Basic at 1250")).toEqual(["basic", "1250"]);
    expect(s.valuesIn("Basically nothing here, true")).toEqual([]);
  });
});

describe("the proxy prefixes", () => {
  it("say which one took an address, and never for the unread kind", () => {
    expect(proxyPrefix(["*", "/backend"], new URL("/backend/x", START))).toBe("/backend");
    expect(proxyPrefix(["*"], new URL("/backend/x", START))).toBeUndefined();
  });
});

describe("a client app whose own API is all the sign-in there is", () => {
  it("answers who's asking with the made-up user, and reaches nothing", () => {
    const s = seal();
    const verdict = s.judge(asked("/api/me"));
    expect(verdict.act).toBe("answer");
    expect(bodyOf(replyOf(verdict as { reply: Reply }))).toMatchObject({ email: STAND_IN_EMAIL, user: { id: STAND_IN_USER_ID } });
    expect(s.sessionRead).toBe(true);
    expect(s.guessed).toBe(1);
  });

  it("turns a look with nobody signed in away, as such an API does", () => {
    const s = seal();
    s.signedOut = true;
    expect(replyOf(s.judge(asked("/api/me")) as { reply: Reply }).status).toBe(401);
    expect(replyOf(s.judge(asked("/api/members")) as { reply: Reply }).status).toBe(401);
  });

  it("takes an address only such an API has for who's asking", () => {
    for (const path of ["/api/members", "/api/users", "/api/me/orders", "/v1/plans"]) {
      const verdict = seal().judge(asked(path));
      expect(bodyOf(replyOf(verdict as { reply: Reply }))).toEqual([]);
    }
  });

  it("leaves another host's /api/me alone, and a save stays a save", () => {
    const s = seal();
    expect(bodyOf(replyOf(s.judge(asked("https://api.example.com/api/me")) as { reply: Reply }))).toEqual([]);
    expect(s.sessionRead).toBe(false);
    expect(seal().judge(asked("/api/me", { method: "POST" })).act).toBe("save");
  });

  it("isn't used when the project names a library, and a library seen later takes over", () => {
    const named = seal({ provider: "supabase" });
    named.judge(asked("/api/me"));
    expect(named.sessionRead).toBe(false);
    const s = seal();
    s.judge(asked("/api/orders"));
    expect(s.adapter).not.toBe("supabase");
    s.judge(asked("https://x.supabase.co/rest/v1/orders"));
    expect(s.adapter).toBe("supabase");
  });

  it("gives a named endpoint's rows ahead of its made-up user", () => {
    const verdict = seal({ rows: { "/api/me": { plan: "gold" } } }).judge(asked("/api/me"));
    expect(bodyOf(replyOf(verdict as { reply: Reply }))).toEqual({ plan: "gold" });
  });
});

describe("what the seal answered with nothing", () => {
  it("counts data calls left empty, and not a library's own upkeep or rows it sent", () => {
    const s = seal({ rows: { trades: [{ id: "1" }] } });
    s.judge(asked("https://x.supabase.co/auth/v1/user"));
    s.judge(asked("https://x.supabase.co/rest/v1/trades"));
    expect(s.emptied).toBe(0);
    s.judge(asked("https://x.supabase.co/rest/v1/notes"));
    s.judge(asked("/data/unknown.json"));
    expect(s.emptied).toBe(2);
  });
});

describe("the rows for a count of one", () => {
  it("cuts every list to one, in a list of its own or under a key, and leaves a record whole", () => {
    expect(oneRowOf({ trades: [1, 2, 3], "/api/m": { members: [1, 2], limit: 5 }, "/api/plan": { name: "x" } })).toEqual({ trades: [1], "/api/m": { members: [1], limit: 5 }, "/api/plan": { name: "x" } });
  });
  it("points what's kept at what's kept, or it would draw as nothing", () => {
    const accounts = [{ id: "a1" }, { id: "a2" }];
    const trades = [{ id: "t1", account_id: "a2" }, { id: "t2", account_id: "a1" }];
    expect(oneRowOf({ accounts, trades })).toEqual({ accounts: [{ id: "a1" }], trades: [{ id: "t1", account_id: "a1" }] });
  });
  it("still cuts a list others point at, or its count would never be one", () => {
    const trades = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
    const notes = [{ id: "n1", trade_id: "t3", size: "t2" }];
    expect(oneRowOf({ trades, notes })).toEqual({ trades: [{ id: "t1" }], notes: [{ id: "n1", trade_id: "t1", size: "t2" }] });
  });
});
