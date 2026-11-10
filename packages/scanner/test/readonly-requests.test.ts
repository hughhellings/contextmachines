import { afterAll, describe, expect, it } from "vitest";
import { scanSite } from "../src/scan.ts";
import { page, startRecordingSite, type RecordingSite } from "./readonly-app.ts";

/** Traps for the shapes of a request the guard has to read, each on a server that records what arrives. */
const html = (res: import("node:http").ServerResponse, body: string) => void res.writeHead(200, { "content-type": "text/html" }).end(body);
const json = (res: import("node:http").ServerResponse, body: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const open: RecordingSite[] = [];
const started = (site: RecordingSite) => (open.push(site), site);
afterAll(() => Promise.all(open.map((s) => s.close())));
const quick = { maxPages: 8, maxDurationMs: 25_000, delayMs: 0, screenshots: false };

describe("redirects", () => {
  it("checks every hop of a page load or a fetch, and follows the harmless ones", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/go/abc") return void res.writeHead(302, { location: "/hop" }).end();
      if (url.pathname === "/hop") return void res.writeHead(302, { location: "/items/7/delete" }).end();
      if (url.pathname === "/go/ok") return void res.writeHead(301, { location: "/welcome" }).end();
      if (url.pathname === "/api/go") return void res.writeHead(302, { location: "/api/items/9/remove" }).end();
      if (url.pathname === "/api/fine") return void res.writeHead(302, { location: "/api/data" }).end();
      if (url.pathname === "/api/data") return json(res, { ok: 1 });
      html(res, page("Home", `<a href="/go/abc">Short</a> <a href="/go/ok">Other</a><script>fetch("/api/go");fetch("/api/fine")</script>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.filter((q) => /delete|remove/.test(q))).toEqual([]);
    expect(site.requests).toContain("GET /hop");
    expect(site.requests).toContain("GET /api/data");
    expect(r.pagesVisited).toContain("/welcome");
    expect(r.pagesVisited.some((p) => /delete/.test(p))).toBe(false);
    expect(r.linksHeldBack).toEqual(expect.arrayContaining([expect.objectContaining({ why: "redirect" })]));
    expect(r.errors).toEqual([]);
  }, 40_000);

  it("--create: a 307 can't carry a write on to a delete, and the page after a save still loads", async () => {
    const site = started(await startRecordingSite((req, res, url) => {
      if (url.pathname === "/api/moved") return void res.writeHead(307, { location: "/api/invoices/8/delete" }).end();
      if (url.pathname === "/invoices" && req.method === "POST") return void res.writeHead(303, { location: "/invoices/5" }).end();
      if (url.pathname === "/invoices/5") return html(res, page("Invoice 5", "<p>Saved</p>"));
      if (req.method !== "GET") return json(res, { ok: 1 });
      html(res, page("Home", `<button onclick="fetch('/api/moved',{method:'POST',body:'x'})">Send it</button><form method="post" action="/invoices"><input name="title" required><button>Save</button></form>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick, realWrites: true });
    expect(site.requests.filter((q) => /delete/.test(q))).toEqual([]);
    expect(site.requests.some((q) => q.startsWith("POST /api/moved"))).toBe(true);
    expect(r.blockedWrites).toEqual(expect.arrayContaining([expect.objectContaining({ method: "POST" })]));
    expect(r.pagesVisited).toContain("/invoices/:id");
  }, 40_000);

  it("a pop-up can't take a redirect the learner doesn't see", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/go/x") return void res.writeHead(302, { location: "/items/7/delete" }).end();
      html(res, page("Home", `<button onclick="window.open('/go/x')">Open</button><a href="/go/x" target="_blank">Elsewhere</a>`));
    }));
    await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.filter((q) => /delete/.test(q))).toEqual([]);
  }, 40_000);
});

describe("after a press that says it destroys", () => {
  it("nothing is sent but files, on any host, its confirm() is answered, and the next page loads as normal", async () => {
    const other = started(await startRecordingSite((_req, res) => void res.writeHead(200, { "access-control-allow-origin": "*" }).end("{}"), undefined, "localhost"));
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/next") return html(res, page("Next", "<p>Still here</p>"));
      if (url.pathname === "/pic.png") return void res.writeHead(200, { "content-type": "image/png" }).end();
      if (url.pathname === "/item/9/x" || url.pathname === "/item/10/x") return json(res, {});
      html(res, page("Home", `<a href="/next">Next</a>
        <button onclick="if(confirm('Sure?')){fetch('/item/9/x');fetch('${other.url}log');new Image().src='/pic.png'}">Delete</button>
        <button onclick="confirm('Delete this row for good?') && fetch('/item/10/x')">Tidy</button>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.filter((q) => q.includes("/item/"))).toEqual([]);
    expect(other.requests.filter((q) => !q.includes("favicon"))).toEqual([]);
    expect(site.requests).toContain("GET /pic.png"); // the dialog was answered yes, so the rest of its handler ran
    expect(r.pagesVisited).toContain("/next");
    expect(r.linksHeldBack).toEqual(expect.arrayContaining([expect.objectContaining({ why: "press", read: true })]));
  }, 40_000);
});

describe("a value the learner typed", () => {
  it("makes a GET form or a JSONP call a save, and shows it as an action; a search box stays a read", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/search" || url.pathname === "/find") return html(res, page("Results", `<p>Results</p>`));
      if (url.pathname === "/list/post-json") return void res.writeHead(200, { "content-type": "text/javascript" }).end("");
      if (url.pathname === "/lookup") return html(res, page("Look up", `<form action="/search"><input type="text" name="term"><button>Look up</button></form>`));
      if (url.pathname === "/lookup2") return html(res, page("Look up again", `<form role="search" action="/find"><input name="term"><button>Find</button></form>`));
      html(res, page("Home", `<a href="/lookup">One</a> <a href="/lookup2">Two</a>
        <form action="/newsletter/subscribe"><label>Email <input type="email" name="email" required></label><button>Sign me up</button></form>
        <form id="j"><label>Your email <input type="email" name="EMAIL"></label><button type="submit">Join</button></form>
        <script>j.onsubmit=(e)=>{e.preventDefault();const s=document.createElement("script");s.src="/list/post-json?c=cb&EMAIL="+encodeURIComponent(new FormData(j).get("EMAIL"));document.head.append(s)}</script>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.filter((q) => q.includes("learner"))).toEqual([]);
    expect(site.requests.some((q) => q.startsWith("GET /search?term=Test"))).toBe(true);
    expect(site.requests.some((q) => q.startsWith("GET /find?term=Test"))).toBe(true);
    expect(r.blockedWrites).toEqual(expect.arrayContaining([expect.objectContaining({ method: "GET", path: "/newsletter/subscribe" }), expect.objectContaining({ method: "GET", path: "/list/post-json" })]));
    expect(r.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "network", method: "GET", save: true, path: "/newsletter/subscribe" })]));
    expect(r.pagesVisited).not.toContain("/newsletter/subscribe");
  }, 40_000);
});

describe("a save sent as a GET", () => {
  it("is stopped when pressed and learned as a save from its button, as a POST one is", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname !== "/") return json(res, { ok: true });
      html(res, page("Shop", `<h1>Shop</h1><button id="g">Add to cart</button><button id="p">Add to basket</button><a href="/clients/add">New client</a>
        <script>g.onclick = () => fetch("/add_to_cart/1?quantity=10"); p.onclick = () => fetch("/api/basket", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });</script>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.filter((x) => x.includes("add_to_cart") || x.includes("basket"))).toEqual([]);
    const saves = r.events.flatMap((e) => (e.kind === "network" ? [[e.method, e.path, e.trigger?.label, e.save]] : []));
    // Shown as it's sent, and a save all the same.
    expect(saves).toContainEqual(["GET", "/add_to_cart/:id", "Add to cart", true]);
    expect(saves).toContainEqual(expect.arrayContaining(["POST", "/api/basket"]));
    expect(saves.filter(([m, p]) => m === "POST" && String(p).includes("add_to_cart"))).toEqual([]);
    expect(site.requests).toContain("GET /clients/add");
  }, 40_000);
});

describe("a typed number under a how-many key", () => {
  it("is a read on a press that asks, and a save on one that adds or buys", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/result") return html(res, page("Your quote", `<h1>Your quote</h1><p>Ten of them</p>`));
      if (url.pathname === "/shop/line") return json(res, { ok: true });
      if (url.pathname === "/quote") return html(res, page("Quote", `<h1>Quote</h1><form action="/result"><label>How many <input type="number" name="quantity" required></label><button>Get a quote</button></form>`));
      html(res, page("Shop", `<h1>Shop</h1><a href="/quote">Ask for a quote</a>
        <form id="buy"><label>Quantity <input type="number" name="qty" required></label><button>Add to basket</button></form>
        <script>buy.onsubmit = (e) => { e.preventDefault(); fetch("/shop/line?qty=" + buy.qty.value); };</script>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(r.pagesVisited).toContain("/result");
    expect(site.requests.some((q) => q.startsWith("GET /result?quantity="))).toBe(true);
    expect(r.blockedWrites.map((w) => w.path)).not.toContain("/result");
    expect(site.requests.filter((q) => q.includes("/shop/line"))).toEqual([]);
    expect(r.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "network", method: "GET", save: true, path: "/shop/line" })]));
  }, 40_000);
});

describe("someone else's host after a press", () => {
  it("a consent manager's call and a read aren't saves; a hosted back end's write is", async () => {
    const site = started(await startRecordingSite((_req, res) => html(res, page("Home", `<h1>Tasks</h1><form id="f"><label>Task <input name="task" required></label><button>Add task</button></form>
      <script>f.onsubmit = (e) => { e.preventDefault();
        fetch("https://fundingchoicesmessages.google.com/a/consent", { method: "POST", body: "x" }).catch(() => {});
        fetch("https://validator.swagger.io/validator?url=" + encodeURIComponent(f.task.value)).catch(() => {});
        fetch("https://abcdefghijklmnopqrst.supabase.co/rest/v1/items", { method: "POST", body: JSON.stringify({ task: f.task.value }) }).catch(() => {}); };</script>`))));
    const r = await scanSite({ startUrl: site.url, ...quick });
    const sent = r.events.flatMap((e) => (e.kind === "network" ? [`${e.method} ${e.path}`] : []));
    expect(sent.filter((s) => /fundingchoices|swagger/.test(s))).toEqual([]);
    expect(r.blockedWrites.filter((w) => /fundingchoices|swagger/.test(w.path))).toEqual([]);
    expect(sent.some((s) => s.startsWith("POST") && s.includes("supabase.co/rest/v1/items"))).toBe(true);
  }, 40_000);
});

describe("GraphQL", () => {
  it("files a named read as a read, and a mutation at the same address as a save", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/graphql") return json(res, { data: { me: { id: 1 } } });
      html(res, page("Home", `<h1>Home</h1><button id="m">Save profile</button><script>
        const ask = (b) => fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        ask({ operationName: "Me", query: "query Me { me { id } }" });
        m.onclick = () => ask({ operationName: "SaveProfile", query: "mutation SaveProfile { saveProfile { id } }" });
        </script>`));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    const sent = r.events.flatMap((e) => (e.kind === "network" ? [`${e.method} ${e.path} #${e.graphqlOperation}`] : []));
    expect(sent).toContain("QUERY /graphql #Me");
    expect(sent).not.toContain("POST /graphql #Me");
    expect(sent).toContain("POST /graphql #SaveProfile");
    expect(r.blockedWrites).toContainEqual({ method: "POST", path: "/graphql", graphqlOperation: "SaveProfile" });
  }, 40_000);

  it("a read that a redirect replays elsewhere never gets there, and one on its own path does", async () => {
    const site = started(await startRecordingSite((req, res, url) => {
      if (req.method === "POST" && url.pathname === "/graphql") return void res.writeHead(307, { location: "/internal/run" }).end();
      if (req.method === "POST" && url.pathname === "/gql") return void (url.search ? json(res, { data: {} }) : res.writeHead(308, { location: "/gql?v=2" }).end());
      if (url.pathname === "/internal/run") return json(res, { data: {} });
      html(res, page("Home", `<h1>Home</h1><script>
        const ask = (to) => fetch(to, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ me { id } }" }) });
        ask("/graphql").catch(() => {}); ask("/gql").catch(() => {});
        </script>`));
    }));
    await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests.some((x) => x.startsWith("POST /graphql"))).toBe(true);
    expect(site.requests.filter((x) => x.includes("/internal/run"))).toEqual([]);
    expect(site.requests.some((x) => x.startsWith("POST /gql?v=2"))).toBe(true);
  }, 40_000);

  it("lets anonymous and batched reads through, and files them as reads, not saves", async () => {
    const site = started(await startRecordingSite((_req, res, url, body) => {
      if (url.pathname !== "/graphql") return html(res, page("Home", `<ul id="list"></ul><script>
        const ask = (b) => fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
        ask({ query: "{ invoices { id } }" }).then((r) => { for (const i of r.data.invoices) list.insertAdjacentHTML("beforeend", '<li><a href="/invoices/' + i.id + '">One</a></li>'); });
        ask([{ query: "query A { a { id } }" }, { query: "{ b { id } }" }]);
        </script>`));
      if (url.pathname === "/graphql" && body.startsWith("[")) return json(res, [{ data: {} }, { data: {} }]);
      json(res, { data: { invoices: [{ id: 7 }] } });
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(r.blockedWrites).toEqual([]);
    expect(r.pagesVisited).toContain("/invoices/:id");
    expect(r.events.filter((e) => e.kind === "network" && e.method === "POST" && !e.graphqlOperation)).toEqual([]);
  }, 40_000);
});

describe("files and names", () => {
  it("never refuses a script for its name, so an app split into chunks still draws", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/main.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`import { draw } from "./DeleteDialog-9f8e7d.js"; draw();`);
      if (url.pathname === "/DeleteDialog-9f8e7d.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`export const draw = () => document.body.insertAdjacentHTML("beforeend", '<a href="/catalog-outlet">Outlet</a> <a href="/design-outline">Outline</a> <a href="/help/cancellation-policy">Policy</a> <a href="/archive">Archive</a>');`);
      if (url.pathname === "/") return html(res, `${page("Home", "")}<script type="module" src="/main.js"></script>`);
      html(res, page(url.pathname.slice(1), "<p>Plain page</p>"));
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(r.pagesVisited).toEqual(expect.arrayContaining(["/catalog-outlet", "/design-outline", "/help/cancellation-policy", "/archive"]));
    expect(r.linksHeldBack).toEqual([]);
  }, 40_000);

  it("counts a read it held, and its link, instead of looking complete", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/") return html(res, page("Home", `<a href="/orders/3/approve">Approve</a><a href="/x/9/z">Delete</a><script>fetch("/api/orders/3/approve")</script>`));
      json(res, {});
    }));
    const r = await scanSite({ startUrl: site.url, ...quick });
    expect(site.requests).toEqual(expect.not.arrayContaining(["GET /orders/3/approve", "GET /x/9/z", "GET /api/orders/3/approve"]));
    expect(r.linksHeldBack).toEqual(expect.arrayContaining([
      { path: "/orders/:id/approve", why: "command" }, { path: "/x/:id/z", why: "label" }, { path: "/api/orders/:id/approve", why: "command", read: true },
    ]));
    expect(r.findings).toEqual([]);
  }, 40_000);
});
