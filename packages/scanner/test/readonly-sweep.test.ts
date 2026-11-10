import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { page, startRecordingSite, type RecordingSite } from "./readonly-app.ts";

/**
 * The sweep: one app with every way of writing the reviewers' probes found, across links, buttons,
 * forms, redirects, GraphQL, sockets and workers. The server records all that arrives, so the only
 * proof that counts is its record: in the default mode and signed in, nothing but plain page loads.
 * Each line is a way a real site saves, and the signed-in run is the one where it would land.
 */
const SIGN_IN = { login: { url: "", fields: [{ selector: "#email", env: "SWEEP_EMAIL" }, { selector: "#password", env: "SWEEP_PASSWORD" }], submit: "#go" } };
const env = { SWEEP_EMAIL: "tester@sweep.test", SWEEP_PASSWORD: "not-a-real-one" };
const post = (url: string, body: string) => `fetch('${url}',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(body).replace(/"/g, "&quot;")}})`;
const delAll = JSON.stringify({ action: "delete_all" });

const PATTERNS = (third: string) => [
  // GET links whose address commands: the old pattern of signed-in sites, usually with a token.
  `<a href="/vote?id=1&how=up&auth=tok1&goto=news">upvote</a>`, `<a href="/fave?id=1&auth=tok1">favorite</a>`, `<a href="/hide?id=1&auth=tok1&goto=news">hide</a>`, `<a href="/flag?id=9&auth=tok1">flag</a>`,
  `<a href="/users/alice/follow">Follow alice</a>`, `<a href="/posts/5/like">Like</a>`, `<a href="/posts/5/archive">Archive post</a>`, `<a href="/orders/3/approve">Approve order</a>`, `<a href="/orders/3/cancel">Cancel order</a>`,
  `<a href="/notifications/mark-all-read">Mark all read</a>`, `<a href="/subscribe?list=weekly">Subscribe to weekly</a>`, `<a href="/invites/7/accept">Accept invite</a>`, `<a href="/users/sign_out">Sign out</a>`, `<a href="/log_out">Log out</a>`,
  `<a href="/posts/1/trash">Move to trash</a>`, `<a href="/wp-admin/post.php?post=1&action=trash">Trash</a>`, `<a href="/publish?id=1">Publish</a>`, `<a href="/items/1/reject">Reject</a>`, `<a href="/comments/2/report">Report comment</a>`, `<a href="/users/bob/block">Block bob</a>`,
  `<a href="/link?x=1&_wpnonce=abc">Do it</a>`, `<a href="/link2?csrf=abc">Do it now</a>`,
  // Words on the control, nothing in the address.
  `<a href="/item/7/x">Delete</a>`, `<a href="?a=x&id=1">Remove</a>`, `<a href="/auth/end">Sign out now</a>`, `<a href="/item/12/x" title="Delete"><i class="fa fa-trash"></i></a>`, `<a href="/item/16/x" data-method="delete">x</a>`,
  `<button onclick="location.href='/item/8/x'">Delete</button>`, `<button onclick="fetch('/item/9/x')">Remove</button>`, `<button onclick="if(confirm('Sure?'))fetch('/item/10/x')">Delete row</button>`,
  `<form method="get" action="/item/11/x"><button>Delete</button></form>`, `<button aria-label="Row 13" class="icon-trash" onclick="fetch('/item/13/x')"></button>`, `<button title="Delete" onclick="fetch('/item/17/x')"><svg><use href="#bin"></use></svg></button>`,
  `<button onclick="setTimeout(()=>fetch('/item/14/x'),1800)">Remove row</button>`, `<button onclick="fetch('/item/15/x')">Approve</button>`, `<button onclick="new Image().src='/item/18/x'">Delete image</button>`,
  `<button onclick="fetch('${third}beacon/19')">Remove link</button>`,
  `<button onclick="document.getElementById('sure').showModal()">Options</button><dialog id="sure">Delete this row?<button onclick="fetch('/item/20/x')">Yes</button></dialog>`,
  // A harmless address answering with a redirect.
  `<a href="/go/abc">Short link</a>`, `<button onclick="fetch('/go/def')">Refresh</button>`,
  // What the learner typed, sent as a read.
  `<form action="/newsletter/subscribe"><label>Email <input type="email" name="email" required></label><button>Sign me up</button></form>`,
  `<form id="jsonp"><label>Your email <input type="email" name="EMAIL"></label><button type="submit">Join list</button></form><script>jsonp.onsubmit=(e)=>{e.preventDefault();const s=document.createElement("script");s.src="/list/post-json?c=cb&EMAIL="+encodeURIComponent(new FormData(jsonp).get("EMAIL"));document.head.append(s);}</script>`,
  `<form id="far"><label>Work email <input type="email" name="work"></label><button type="submit">Tell me more</button></form><script>far.onsubmit=(e)=>{e.preventDefault();const s=document.createElement("script");s.src="${third}lead?EMAIL="+encodeURIComponent(new FormData(far).get("work"));document.head.append(s);}</script>`,
  // GraphQL that can't be shown to read.
  `<button onclick="fetch('/graphql?query='+encodeURIComponent('mutation { createInvoice(title: 1) { id } }'))">Make</button>`,
  `<button onclick="${post("/graphql", JSON.stringify({ query: "abc123", operationName: "DeleteInvoice" }))}">Tidy</button>`,
  `<button onclick="${post("/graphql", JSON.stringify({ query: "", operationName: "CreateInvoice", extensions: { persistedQuery: { sha256Hash: "abc" } } }))}">Add</button>`,
  `<button onclick="${post("/graphql", JSON.stringify([{ query: "{ a { id } }" }, { query: "mutation { b { id } }" }]))}">Batch</button>`,
  // Other ways out of a page.
  `<button onclick="navigator.sendBeacon('/api/beacon','x')">Beacon</button>`, `<button onclick="window.open('/go/ghi')">Open</button>`,
  `<form method="post" action="/api/formpost" target="_blank"><input type="hidden" name="a" value="1"><button>Send out</button></form>`,
  `<button onclick="fetch('/api/odd',{method:'QUERY',body:'{&quot;delete&quot;:true}'})">Odd</button>`, `<button onclick="fetch('/api/ov',{headers:{'x-http-method-override':'DELETE'}})">Override</button>`,
].join("\n");

const SOCKETS = `<script>
  // Sockets: from the page, in every message the old list let through, and from each kind of worker.
  const wsUrl = "ws://" + location.host + "/ws";
  const send = "const s=new WebSocket(" + JSON.stringify(wsUrl) + ");s.onopen=()=>s.send(" + JSON.stringify(${JSON.stringify(delAll)}) + ");";
  const open = () => {
    const s = new WebSocket(wsUrl);
    s.onopen = () => { for (const m of ${JSON.stringify([
      { type: "complete", taskId: 7 }, { type: "stop", server: "prod-1" }, { jsonrpc: "2.0", method: "getAndClear", id: 1 }, { jsonrpc: "2.0", method: "status.approve", id: 3 }, { jsonrpc: "2.0", method: "findAndModify", params: { update: { paid: true } }, id: 4 },
      { jsonrpc: "2.0", method: "query", params: ["DELETE FROM invoices"], id: 5 }, { event: "presence_kick_user", user: 7 }, { type: "deleteAll:ping" }, { type: "ping", action: "delete_all" }, { msg: "ping", method: "tasks.remove" }, { t: "c", d: { a: "delete" } }, { command: "subscribe", action: "delete" },
    ].map((m) => JSON.stringify(m)))}) s.send(m); s.send('42["identify",{"userId":7}]'); s.send("ACK\\nid:1\\n\\n"); };
  };
  document.addEventListener("DOMContentLoaded", () => {
    if (location.pathname !== "/") return;
    open();
    new Worker(URL.createObjectURL(new Blob([send], { type: "text/javascript" })));
    new Worker("data:text/javascript," + encodeURIComponent(send));
    new Worker("/worker.js");
    new Worker("/worker.mjs", { type: "module" });
    new Worker(URL.createObjectURL(new Blob([send], { type: "text/javascript" })), { type: "module" });
    new Worker(URL.createObjectURL(new Blob(['new Worker(URL.createObjectURL(new Blob([' + JSON.stringify(send) + '],{type:"text/javascript"})))'], { type: "text/javascript" })));
    const f = document.createElement("iframe");
    document.body.append(f);
    new f.contentWindow.Worker(URL.createObjectURL(new Blob([send], { type: "text/javascript" })));
    navigator.serviceWorker?.register("/sw.js").catch(() => {});
  });
</script>`;

/** Requests that change nothing: the pages and files of the app, and the sign-in. Everything else is a change. */
const HARMLESS = /^(GET \/($|\?|go\/|favicon|items$|settings$|login|socket-module\.js|worker\.m?js)|POST \/session)/;
const SESSION = "session=ok";

async function startSweepApp(third: string) {
  return startRecordingSite((_req, res, url) => {
    const asked = url.pathname;
    if (asked === "/login") return void res.writeHead(200, { "content-type": "text/html" }).end(page("Sign in", `<form method="post" action="/session"><input id="email" name="email"><input id="password" name="password" type="password"><button id="go">Sign in</button></form>`));
    if (asked === "/session") return void res.writeHead(303, { location: "/", "set-cookie": `${SESSION}; Path=/` }).end();
    if (/^\/go\//.test(asked)) return void res.writeHead(302, { location: `/items/${asked.at(-1)!.charCodeAt(0)}/delete` }).end();
    if (asked === "/worker.js" || asked === "/worker.mjs" || asked === "/socket-module.js") {
      const code = `const s=new WebSocket("ws://"+location.host+"/ws");s.onopen=()=>s.send('${delAll}');fetch("/from-worker",{method:"POST",body:"x"});`;
      return void res.writeHead(200, { "content-type": "text/javascript" }).end(asked === "/worker.mjs" ? `import "/socket-module.js";` : code);
    }
    if (asked === "/" ) return void res.writeHead(200, { "content-type": "text/html" }).end(page("Sweep", `<a href="/items">Items</a><a href="/settings">Settings</a>${PATTERNS(third)}${SOCKETS}`));
    if (asked === "/items" || asked === "/settings") return void res.writeHead(200, { "content-type": "text/html" }).end(page(asked === "/items" ? "Items" : "Settings", `<a href="/">Home</a><p>A plain page.</p>`));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }, (request) => HARMLESS.test(request));
}

describe.each([["by default", false], ["signed in", true]])("%s", (_name, signedIn) => {
  let site: RecordingSite;
  let elsewhere: RecordingSite;
  let result: ScanResult;

  beforeAll(async () => {
    elsewhere = await startRecordingSite((_req, res) => void res.writeHead(200, { "content-type": "text/javascript" }).end(""), undefined, "localhost");
    site = await startSweepApp(elsewhere.url);
    result = await scanSite({
      startUrl: site.url, maxPages: 10, maxDurationMs: 60_000, delayMs: 0, screenshots: false, maxButtonsPerPage: 40,
      ...(signedIn ? { login: { ...SIGN_IN.login, url: `${site.url}login` } } : {}),
    }, env);
  }, 120_000);

  afterAll(async () => {
    await site.close();
    await elsewhere.close();
  });

  it("changes nothing on the site", () => {
    expect(site.changes()).toEqual([]);
  });

  it("sends nothing the learner typed, or a press set off, to anyone else", () => {
    expect(elsewhere.requests.filter((r) => !r.includes("favicon"))).toEqual([]);
  });

  it("still learns the plain screens, and says what it held back", () => {
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/", "/items", "/settings"]));
    const links = result.linksHeldBack.filter((h) => !h.read);
    expect(links.length).toBeGreaterThan(20);
    expect(links.map((h) => h.why)).toEqual(expect.arrayContaining(["command", "label"]));
  });
});
