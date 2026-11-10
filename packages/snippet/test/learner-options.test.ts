import type { CapturedEvent, EventBatch } from "@contextmachines/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonIntent } from "../src/dom.ts";
import { intentOf } from "../src/body.ts";
import { init } from "../src/index.ts";
import { snapshotPage } from "../src/page.ts";
import { normalizeUrl, routeKeysOf } from "../src/url.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const BASE = "https://x.test/";
const ENDPOINT = "https://ingest.example.com/v1/events";
const path = (url: string, keys?: string[]) => normalizeUrl(url, BASE, keys)?.path;

describe("a site that routes by its query", () => {
  it("keeps the route key's value in the pattern, for the learner only", () => {
    expect(path("/index.php?page=invoices", ["page"])).toBe("/index.php?page=invoices");
    expect(path("/index.php?page=clients&sort=name&utm_source=x", ["page"])).toBe("/index.php?page=clients");
    expect(path("/index.php?route=account/login", ["route"])).toBe("/index.php?route=account/login");
    expect(path("/index.php?page=invoices#top", ["page"])).toBe("/index.php?page=invoices");
    expect(path("/admin.php?page=plugins/#/x", ["page"])).toContain("/admin.php?page=plugins");
  });

  it("sends what it always sent by default: names of keys, no values (trap)", () => {
    const n = normalizeUrl("/index.php?page=invoices&id=jane", BASE);
    expect(n).toEqual({ origin: "https://x.test", path: "/index.php", queryKeys: ["page", "id"] });
  });

  it("cleans a value like any path segment", () => {
    expect(path("/index.php?page=4411", ["page"])).toBe("/index.php?page=:id");
    expect(path("/w/index.php?title=how-we-cut-our-build-times-in-half", ["title"])).toBe("/w/index.php?title=:id");
    expect(path("/index.php?page=jane%20smith", ["page"])).toBe("/index.php?page=:id");
    expect(path("/index.php?page=jane@example.com", ["page"])).toBe("/index.php?page=:id");
    expect(path("/index.php?page=", ["page"])).toBe("/index.php");
  });

  it("a record picked by the query is an id, once a learner is asking", () => {
    expect(path("/user?id=pseudolus", [])).toBe("/user?id=:id");
    expect(path("/item?id=4411&p=2", [])).toBe("/item?id=:id");
    expect(path("/index.php?page=invoice&invoice_id=9", ["page"])).toBe("/index.php?page=invoice&invoice_id=:id");
    expect(path("/orders?customerId=abc", [])).toBe("/orders?customerId=:id");
    expect(path("/orders?valid=yes", [])).toBe("/orders");
  });

  it("finds route keys from links, and leaves sorting, paging and tracking alone", () => {
    const links = ["?page=home", "?page=invoices", "?page=clients"].map((q) => `/index.php${q}`);
    expect(routeKeysOf(links, BASE)).toEqual(["page"]);
    expect(routeKeysOf(["/list?page=2", "/list?page=3", "/list?page=4"], BASE)).toEqual([]);
    expect(routeKeysOf(["/list?sort=name", "/list?sort=price", "/list?sort=date"], BASE)).toEqual([]);
    expect(routeKeysOf(["/?utm_source=a", "/?utm_source=b", "/?utm_source=c"], BASE)).toEqual([]);
    expect(routeKeysOf(["/?lang=en", "/?lang=fr", "/?lang=de"], BASE)).toEqual([]);
    // Any other key needs more evidence than a route-like one; ids never count.
    expect(routeKeysOf(["/?shop=a1", "/?shop=b2"], BASE)).toEqual([]);
    expect(routeKeysOf(["/?area=north", "/?area=south", "/?area=west"], BASE)).toEqual(["area"]);
    expect(routeKeysOf(["/?page=INV-00231", "/?page=INV-00232"], BASE)).toEqual([]);
  });
});

describe("two buttons of one form, one address", () => {
  const form = `<form method="post" action="/db.htm"><input name="note"><button id="a" name="action" value="INIT">Initialize</button><button id="b" name="action" value="CLEAN">Clean</button><button id="c" type="button" name="action" value="HELP">Help</button></form>`;
  const el = (id: string) => document.getElementById(id)!;

  it("the button's value tells them apart", () => {
    document.body.innerHTML = form;
    expect(buttonIntent(el("a"))).toBe("intent:init");
    expect(buttonIntent(el("b"))).toBe("intent:clean");
  });

  it("falls back to the button's name when its value is words", () => {
    document.body.innerHTML = `<form><input type="submit" id="a" name="clean" value="Clean database"><input type="submit" id="b" name="save" value="Save it"></form>`;
    expect(buttonIntent(el("a"))).toBe("intent:clean");
  });

  it("a lone button or a nameless one says nothing the form didn't (trap)", () => {
    document.body.innerHTML = `<form><button id="a" name="commit" value="Save">Save</button></form><form><button id="b">A</button><button>B</button></form>`;
    expect(buttonIntent(el("a"))).toBeUndefined();
    expect(buttonIntent(el("b"))).toBeUndefined();
  });

  it("a record's id or an address in a button's value is never kept (trap)", () => {
    document.body.innerHTML = `<form><button id="a" name="row" value="4411">x</button><button id="b" name="row" value="jane@example.com">y</button></form>`;
    expect(buttonIntent(el("a"))).toBe("intent:row");
    expect(buttonIntent(el("b"))).toBe("intent:row");
  });

  it("the sent body says the same, for a form the page itself sends", () => {
    expect(intentOf({ action: "INIT", note: "x" }, true)).toBe("intent:init");
    expect(intentOf({ op: "archive-all" }, true)).toBe("intent:archive-all");
    expect(intentOf({ action: "jane smith" }, true)).toBeUndefined();
  });

  it("the hosted default reads what it always read (trap)", () => {
    expect(intentOf({ action: "INIT" })).toBeUndefined();
    expect(intentOf({ intent: "delete" })).toBe("intent:delete");
  });

  /** What a whole snippet sends when the page sends a pressed form by itself. */
  const pressAndSend = async (options: { buttonIntents?: boolean; routeKeys?: string[] }) => {
    document.body.innerHTML = form;
    const real = window.fetch;
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    window.fetch = sent as unknown as typeof fetch;
    vi.spyOn(window.navigator, "sendBeacon").mockReturnValue(true);
    const handle = init({ key: "pk_test_fixturekey", endpoint: ENDPOINT, ui: false, ...options }, window);
    history.replaceState(null, "", "/index.php?page=invoices&id=jane");
    document.querySelector("form")!.addEventListener("submit", (e) => e.preventDefault());
    el("b").click();
    await window.fetch("/db.htm?page=x", { method: "POST", body: "" });
    await new Promise((r) => setTimeout(r, 0));
    await handle.flush();
    handle.shutdown();
    window.fetch = real;
    history.replaceState(null, "", "/");
    vi.restoreAllMocks();
    const batches = (sent.mock.calls as unknown[][]).filter(([url]) => String(url) === ENDPOINT).map(([, o]) => JSON.parse(String((o as RequestInit).body)) as EventBatch);
    return batches.flatMap((b) => b.events) as CapturedEvent[];
  };
  const network = (events: CapturedEvent[]) => events.find((e) => e.kind === "network" && e.path.startsWith("/db.htm")) as Extract<CapturedEvent, { kind: "network" }> | undefined;

  it("off by default: the hosted snippet sends neither a button's value nor a query's (trap)", async () => {
    const events = await pressAndSend({});
    expect(network(events)?.path).toBe("/db.htm");
    expect(network(events)?.graphqlOperation).toBeUndefined();
    expect(events.filter((e) => e.kind === "route").map((e) => (e as { path: string }).path)).toContain("/index.php");
    expect(JSON.stringify(events)).not.toMatch(/invoices|jane|intent:/);
  });

  it("asked for by a learner, both are part of what is sent", async () => {
    const events = await pressAndSend({ buttonIntents: true, routeKeys: ["page"] });
    expect(network(events)?.graphqlOperation).toBe("intent:clean");
    expect(events.filter((e) => e.kind === "route").map((e) => (e as { path: string }).path)).toContain("/index.php?page=invoices&id=:id");
    expect(JSON.stringify(events)).not.toContain("jane");
  });
});

describe("reading a page", () => {
  const read = () => snapshotPage(document, () => undefined);

  it("a heading with a hidden copy for another screen size is read once", () => {
    document.body.innerHTML = `<main><h1><span>Build it together</span><span style="display:none">Build it together</span></h1></main>`;
    expect(read().headings).toEqual(["Build it together"]);
  });

  it("reads through what is drawn (trap)", () => {
    document.body.innerHTML = `<main><h1><span>Build</span> <em>together</em></h1></main>`;
    expect(read().headings).toEqual(["Build together"]);
  });

  it("characters with no look of their own aren't part of a label", () => {
    document.body.innerHTML = `<main><h1>Figma MCP server⁠</h1><button>Sa­ve</button></main>`;
    const s = read();
    expect(s.headings).toEqual(["Figma MCP server"]);
    expect(s.buttons.map((b) => b.label)).toEqual(["Save"]);
  });

  it("the close button of an error is the message's, not the page's", () => {
    document.body.innerHTML = `<form><button>Login</button><h3 data-test="error">Username is required<button aria-label="Dismiss error">x</button></h3></form><div role="alert">Saved <button>Undo</button></div>`;
    expect(read().buttons.map((b) => b.label)).toEqual(["Login"]);
  });

  it("a red button is still a button: only what it sits in counts (trap)", () => {
    document.body.innerHTML = `<main><button class="btn-error">Delete</button></main>`;
    expect(read().buttons.map((b) => b.label)).toEqual(["Delete"]);
  });
});
