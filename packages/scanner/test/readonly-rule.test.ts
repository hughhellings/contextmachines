import { describe, expect, it } from "vitest";
import { backgroundHost, carriesTyped, commandIn, firstLine, judge, linkActs, pressAdds, RISKY_BUTTON, RISKY_WHEN_LEARNING, saysActs, saysDestroys, socketUpkeep, withoutTokens, type Guard, type Outgoing } from "../src/scan.ts";

/** The allow rule on its own, without a browser: what it lets through and what it holds back. */
const url = (path: string) => new URL(path, "https://app.test");
const saying = (text: string, marks = "") => ({ text, around: "", marks });

describe("what an address says", () => {
  it.each([
    "/wp-admin/post.php?post=1&_wpnonce=abc", "/news?id=1&auth=tok1", "/settings?csrf=1", "/link?token=x", "/link?nonce=x", "/link?sig=x", "/link?authenticity_token=x",
  ])("%s carries a token", (path) => expect(commandIn(url(path))).toBe("token"));

  it.each([
    "/vote?id=1&how=up&auth=tok1&goto=news", "/fave?id=1&auth=tok1", "/hide?id=1&auth=tok1", "/flag?id=9&auth=tok1",
    "/items/7/delete", "/delete?id=7", "/delete-invoice/7", "/invoice-delete", "/deleteInvoice", "/invoices/7/remove", "/users/sign_out", "/log_out", "/logout", "/log-off", "/signOut",
    "/users/alice/follow", "/posts/5/like", "/posts/5/archive", "/orders/3/approve", "/orders/3/cancel", "/notifications/mark-all-read", "/markAllAsRead", "/subscribe?list=weekly",
    "/invites/7/accept", "/posts/1/trash", "/wp-admin/post.php?post=1&action=trash", "/publish?id=1", "/items/1/unpublish", "/vote/123", "/items/7/report", "/users/bob/block", "/users/bob/ban",
    "/x?delete=7", "/x?remove_item=1", "/x?like=1", "/api/v1/tasks/9/star", "/reset-data", "/cart/clear", "/app#/items/7/delete", "/x/purge", "/x/wipe", "/x/erase", "/x/discard",
  ])("%s commands", (path) => expect(commandIn(url(path))).toBe("command"));

  it.each([
    "/catalog-outlet", "/design-outline", "/help/cancellation-policy", "/help/how-to-delete-your-account", "/archive", "/archive?page=2", "/archive/2019", "/reports", "/report", "/api/reports?status=removed",
    "/deleted-items", "/preset/themes", "/assets/presets", "/settings/follow-ups", "/approvals", "/subscribe", "/subscribers", "/likes", "/trash", "/password/reset", "/reset-password", "/reset", "/users/password/reset",
    "/block-explorer", "/search?q=delete", "/list?sort=remove", "/resources/star-wars", "/invoices/7", "/follow-us",
  ])("%s is a read", (path) => expect(commandIn(url(path))).toBeUndefined());

  it("is stricter signed in: what could go either way is left alone", () => {
    for (const path of ["/archive", "/report", "/trash", "/follow", "/edit?goto=/news"]) expect(commandIn(url(path), true), path).toBe("uncertain");
    for (const path of ["/reports", "/invoices/7", "/archives"]) expect(commandIn(url(path), true), path).toBeUndefined();
  });
});

describe("a cart changed by an address", () => {
  it.each([
    "/add_to_cart/1?quantity=10", "/add-to-basket/5", "/addToCart?id=5", "/addtocart?id=5", "/add-to-bag/5", "/add-item-to-cart/5", "/update-cart", "/updateCart", "/cart-add/5", "/remove_from_cart/5",
    "/cart/add/5", "/cart/add.js?id=5", "/cart/update", "/cart/change?line=1&quantity=2", "/cart/remove/5", "/cart/items/5/update", "/shopping-cart/add", "/basket/add", "/wishlist/add", "/wish-list/add/5", "/api/v1/cart/add",
    "/?add-to-cart=123", "/cart.php?action=add&id=5", "/shop?action=add_to_cart&id=5", "/app#/cart/add/5",
  ])("%s commands", (path) => expect(commandIn(url(path))).toBe("command"));

  it.each([
    "/clients/add", "/add-client", "/posts/new", "/products/add", "/add-bag", "/bags/add", "/update-profile", "/users/5/update", "/cart", "/cart/5", "/view_cart", "/basket", "/wishlist", "/wishlist/5", "/cart/add-ons",
    "/help/how-to-add-to-cart", "/blog/add-to-cart-button-tips", "/address/add", "/shop?action=add", "/shop?action=add_client",
  ])("%s isn't", (path) => expect(commandIn(url(path))).toBeUndefined());
});

describe("closing an account", () => {
  it.each(["/account/close", "/my-account/close", "/settings/account/close", "/close-account", "/closeAccount", "/close_my_account", "/app#/account/close"])("%s commands", (path) => expect(commandIn(url(path))).toBe("command"));
  it.each(["/close", "/tickets/5/close", "/help/how-to-close-my-account", "/account/closed", "/account/closing-dates"])("%s isn't", (path) => expect(commandIn(url(path))).toBeUndefined());

  it("holds a link that says it, and leaves every other Close alone", () => {
    for (const text of ["Close account", "Close my account"]) {
      expect(linkActs(url("/settings/x"), saying(text)), text).toBe("label");
      expect(linkActs(url("/settings/close"), saying(text)), text).toBe("label");
    }
    for (const text of ["Close", "Close menu", "Close dialog", "Close window", "×"]) {
      expect(linkActs(url("/settings/x"), saying(text)), text).toBeUndefined();
      expect(saysActs(saying(text)), text).toBe(false);
    }
    expect(saysActs(saying("Close my account"))).toBe(true);
  });
});

describe("presses that leave for a plan or send something out", () => {
  it("never presses an upgrade, a paid plan or a trial, learning or not; a newsletter's Subscribe is pressed", () => {
    for (const text of ["Upgrade now", "Upgrade to Pro", "Subscribe to Team", "Subscribe to the Pro plan", "Start free trial", "Start your free trial", "Start a trial"]) {
      expect(RISKY_WHEN_LEARNING.test(text), text).toBe(true);
      expect(RISKY_BUTTON.test(text), text).toBe(true);
    }
    for (const text of ["Send", "Send feedback", "Invite member", "Downgraded items", "Subscribe", "Subscribe to our newsletter", "Subscribers", "Trial results", "Start"]) expect(RISKY_WHEN_LEARNING.test(text), text).toBe(false);
  });

  it("holds what follows a press that says it sends, and not one that only names mail", () => {
    for (const text of ["Email everyone", "Send reminder", "Resend invite", "Notify the team", "Invite all", "Yes, send to everyone", "e-mail all members", "Remind them", "Send newsletter"]) expect(saysActs(saying(text)), text).toBe(true);
    for (const text of ["Emails", "Sent items", "Inbox", "Invites", "Notifications", "Reminders"]) expect(saysActs(saying(text)), text).toBe(false);
  });

  it("doesn't hold for a tab, a single invite or a form's own Send", () => {
    for (const text of ["Email", "Invite member", "Invite", "Message", "Email settings", "Invite a teammate", "Send", "Send report", "Send message"]) expect(saysActs(saying(text)), text).toBe(false);
    for (const text of ["Invite your team", "Message all users", "Email customers"]) expect(saysActs(saying(text)), text).toBe(true);
  });
});

describe("what a link says", () => {
  it("holds a link by its words or icon, whatever its address", () => {
    for (const [path, say] of [
      ["/item/7/z", saying("Delete")], ["/item/7/z", saying("Remove")], ["/auth/end", saying("Sign out")], ["/x/7", saying("Konto löschen")], ["/x/7", saying("Yes, delete it")],
      ["/x/7", saying("Archive post")], ["/x/7", saying("Follow alice")], ["/x/7", saying("", "fa fa-trash")], ["/x/7", saying("Row 7", "lucide-trash-2")], ["/x/7", saying("Mark all as read")], ["/x/7", saying("Move to trash")],
    ] as const) expect(linkActs(url(path), say), `${path} ${say.text}`).toBe("label");
  });

  it("follows a link whose word names the page it leads to, or isn't a command at all", () => {
    for (const [path, text] of [["/archive", "Archive"], ["/old-page", "Archive"], ["/subscribe", "Subscribe"], ["/reports", "Report"], ["/settings", "Settings"], ["/invoices", "Cancel"], ["/help/x", "How to delete your account"], ["/forgot", "Reset password"]] as const) {
      expect(linkActs(url(path), saying(text)), `${path} ${text}`).toBeUndefined();
    }
  });

  it("signed in, a command word anywhere in a label is reason enough", () => {
    expect(linkActs(url("/help/7"), saying("How to delete an invoice"), true)).toBe("uncertain");
    expect(linkActs(url("/help/7"), saying("How to delete an invoice"), false)).toBeUndefined();
  });
});

describe("a value the learner typed", () => {
  const typed = new Set(["learner@example.test", "+441234567890", "Test", "10"]);
  it("is found in a query, whatever else is there", () => {
    expect(carriesTyped(url("/subscribe/post-json?c=cb&EMAIL=learner%40example.test"), undefined, typed)).toBe(true);
    expect(carriesTyped(url("/c?phone=%2B441234567890"), undefined, typed)).toBe(true);
    expect(carriesTyped(url("/c?phone=+441234567890"), undefined, typed)).toBe(true);
    expect(carriesTyped(url("/c?name=Test"), undefined, typed)).toBe(true);
  });
  it("isn't found in what merely looks like one", () => {
    expect(carriesTyped(url("/items?limit=10"), undefined, typed)).toBe(false);
    expect(carriesTyped(url("/search?q=Test"), undefined, typed)).toBe(false);
    expect(carriesTyped(url("/test?name=Testing"), undefined, typed)).toBe(false);
  });
  it("counts a short number only as how many, once a press has followed the typing", () => {
    for (const path of ["/buy/1?quantity=10", "/x?item_qty=10", "/x?qty=10&ref=home"]) expect(carriesTyped(url(path), undefined, typed, true), path).toBe(true);
    // A quote fetched as the box is filled in, and every other key a short number means something else under.
    expect(carriesTyped(url("/price?quantity=10"), undefined, typed)).toBe(false);
    for (const path of ["/items?page=10", "/items?limit=10", "/items?per_page=10", "/items?offset=10", "/items?q=10", "/items?search=10", "/products?min_price=10", "/products?min_qty=10", "/items?id=10", "/x?quantity=11"]) {
      expect(carriesTyped(url(path), undefined, typed, true), path).toBe(false);
    }
  });
});

describe("error text", () => {
  const hex = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  const base64 = "dGhpc2lzYXNlY3JldDEyMzQ1Njc4OQ==";
  it("loses a token whole, never a piece of it", () => {
    expect(firstLine(`Failed: token=${hex}`)).toBe("Failed: token=…");
    expect(firstLine(`Failed for abcdef1234567890abcdef1234567890xyz`)).toBe("Failed for …");
    expect(firstLine("Failed for order1234567x today")).toBe("Failed for … today");
    expect(firstLine(`Bad key ${"a".repeat(170)}9tail`)).toBe("Bad key …");
    expect(withoutTokens(`key ${base64} and ${hex} and QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0E`)).toBe("key … and … and …");
  });
  it("keeps long words and names, and the email mask", () => {
    const words = "getUserPreferencesFromLocalStorageWhenAvailable is_not_a_function_of_this_long_module MAXIMUM_CALL_STACK_SIZE_WAS_EXCEEDED internationalization-configuration-provider";
    expect(withoutTokens(words)).toBe(words);
    expect(firstLine("No user learner@example.test here")).toBe("No user …@… here");
  });
});

describe("the one rule", () => {
  const guard = (over: Partial<Guard> = {}): Guard => ({ crawling: () => true, own: (o) => o === "https://app.test", holding: () => false, typed: new Set(), signedIn: false, realWrites: false, startHref: "https://app.test/", ...over });
  const request = (path: string, over: Partial<Outgoing> = {}): Outgoing => ({ method: "GET", type: "fetch", url: url(path), headers: {}, navigation: false, ...over });

  it("never refuses an asset by its name", () => {
    for (const [path, type] of [["/assets/DeleteDialog-9f8e7d.js", "script"], ["/icons/remove.svg", "image"], ["/css/delete.css", "stylesheet"], ["/fonts/logout.woff2", "font"], ["/v/delete.mp4", "media"]] as const) {
      expect(judge(request(path, { type }), guard()), path).toEqual({ act: "pass" });
    }
  });

  it("holds the site's own read that says it acts, and passes a third party's", () => {
    expect(judge(request("/items/7/delete"), guard())).toEqual({ act: "hold", why: "command" });
    expect(judge(request("https://other.test/items/7/delete"), guard())).toEqual({ act: "pass" });
    expect(judge(request("/items/7/delete", { navigation: true, type: "document" }), guard({ startHref: "https://app.test/items/7/delete" }))).toEqual({ act: "pass" });
  });

  it("reads a read's method override and a QUERY's body", () => {
    expect(judge(request("/api/x", { headers: { "x-http-method-override": "DELETE" } }), guard()).act).toBe("hold");
    expect(judge(request("/api/x", { method: "QUERY", body: '{"delete":true}' }), guard()).act).toBe("hold");
    expect(judge(request("/api/x", { method: "QUERY", body: '{"name":"a"}' }), guard()).act).toBe("pass");
  });

  it("during a hold passes only assets with a file name, on any host", () => {
    const held = guard({ holding: () => true });
    expect(judge(request("/api/list"), held)).toEqual({ act: "hold", why: "press" });
    expect(judge(request("https://other.test/x"), held)).toEqual({ act: "hold", why: "press" });
    expect(judge(request("/x", { method: "POST" }), held)).toEqual({ act: "stop" });
    expect(judge(request("/a.png", { type: "image" }), held)).toEqual({ act: "pass" });
    expect(judge(request("/rm/7", { type: "image" }), held)).toEqual({ act: "hold", why: "press" });
  });

  it("makes a typed value a save on the site, refused for any other host, but lets --create send it to the site", () => {
    const typed = new Set(["learner@example.test"]);
    const r = request("/join?email=learner%40example.test", { type: "script" });
    expect(judge(r, guard({ typed }))).toEqual({ act: "stop" });
    expect(judge(request("https://list.test/post?EMAIL=learner%40example.test", { type: "script" }), guard({ typed }))).toEqual({ act: "refuse" });
    expect(judge(r, guard({ typed, realWrites: true }))).toEqual({ act: "pass" });
    expect(judge(request("https://list.test/post?EMAIL=learner%40example.test"), guard({ typed, realWrites: true }))).toEqual({ act: "refuse" });
  });

  it("stops a GET that changes a cart, and leaves its files and its plain pages alone", () => {
    for (const path of ["/add_to_cart/1?quantity=10", "/cart/add/5", "/cart/remove/5", "/wishlist/add", "/add-to-basket/5"]) expect(judge(request(path), guard()), path).toEqual({ act: "stop" });
    expect(judge(request("/cart/add/5", { navigation: true, type: "document" }), guard())).toEqual({ act: "stop" });
    expect(judge(request("/cart/remove/5"), guard({ holding: () => true }))).toEqual({ act: "stop" });
    expect(judge(request("/js/add-to-cart.js", { type: "script" }), guard())).toEqual({ act: "pass" });
    expect(judge(request("https://other.test/cart/add/5"), guard())).toEqual({ act: "pass" });
    for (const path of ["/clients/add", "/add-client", "/posts/new", "/cart"]) expect(judge(request(path), guard()), path).toEqual({ act: "pass" });
  });

  it("makes a typed quantity a save after a press that adds or buys, not as the box is filled in", () => {
    const typed = new Set(["10"]);
    expect(judge(request("/buy?quantity=10"), guard({ typed, pressedToAdd: () => true }))).toEqual({ act: "stop" });
    expect(judge(request("/buy?quantity=10"), guard({ typed, pressedToAdd: () => false }))).toEqual({ act: "pass" });
    expect(judge(request("/items?page=10"), guard({ typed, pressedToAdd: () => true }))).toEqual({ act: "pass" });
    for (const label of ["Add to cart", "Buy now", "Order", "Add to basket", "Add to bag", "Cart"]) expect(pressAdds(label), label).toBe(true);
    for (const label of ["Get a quote", "Calculate", "Check price", "Added", undefined]) expect(pressAdds(label), String(label)).toBe(false);
  });

  it("knows consent, ad and analytics hosts from real back ends", () => {
    for (const host of ["fundingchoicesmessages.google.com", "cdn.cookielaw.org", "consent.cookiebot.com", "stats.g.doubleclick.net", "region1.google-analytics.com", "analytics.google.com", "px.ads.linkedin.com", "api.segment.io", "o1.ingest.sentry.io", "consent.example.net"]) expect(backgroundHost(host), host).toBe(true);
    for (const host of ["abcdefghijklmnopqrst.supabase.co", "firestore.googleapis.com", "acme-default-rtdb.firebaseio.com", "identitytoolkit.googleapis.com", "api.stripe.com", "api.acme.com", "validator.swagger.io"]) expect(backgroundHost(host), host).toBe(false);
  });

  it("lets --create send no account closing", () => {
    const close = request("/account/close", { method: "POST", body: "{}" });
    expect(judge(close, guard({ realWrites: true }))).toEqual({ act: "stop" });
    expect(judge(request("/accounts", { method: "POST", body: "{}" }), guard({ realWrites: true }))).toEqual({ act: "pass" });
  });

  const post = (body: unknown, contentType = "application/json") => request("/graphql", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": contentType } });

  it("forwards GraphQL only when every operation is a readable query", () => {
    for (const body of [{ query: "{ invoices { id } }" }, { query: "query { invoices { id } }" }, { query: "query L { invoices { id } }", operationName: "L" }, [{ query: "{ a { id } }" }, { query: "query B { b { id } }" }], { query: "# c\n{ a { id } }" }]) {
      expect(judge(post(body), guard()), JSON.stringify(body)).toEqual({ act: "pass" });
    }
    expect(judge(post("{ invoices { id } }", "application/graphql"), guard())).toEqual({ act: "pass" });
    for (const body of [
      { query: "mutation { a }" }, { query: "abc123", operationName: "DeleteInvoice" }, { query: "", operationName: "CreateInvoice", extensions: { persistedQuery: { sha256Hash: "a" } } },
      { operationName: "GetInvoice", extensions: { persistedQuery: { sha256Hash: "a" } } }, [{ query: "{ a { id } }" }, { query: "mutation { b }" }], { query: "subscription { a { id } }" },
      { query: "fragment F on A { id }" }, { query: "shoes" }, { query: "query" },
    ]) expect(judge(post(body), guard()), JSON.stringify(body)).toEqual({ act: "stop" });
    expect(judge(post("mutation { a }", "application/graphql"), guard())).toEqual({ act: "stop" });
  });

  it("reads a GET's query the same way", () => {
    const q = (text: string) => `/graphql?query=${encodeURIComponent(text)}`;
    expect(judge(request(q("mutation { createInvoice { id } }")), guard())).toEqual({ act: "hold", why: "graphql" });
    expect(judge(request(q("abc123")), guard())).toEqual({ act: "hold", why: "graphql" });
    expect(judge(request("/graphql?operationName=GetInvoice&extensions=%7B%7D"), guard())).toEqual({ act: "hold", why: "graphql" });
    expect(judge(request(q("{ invoices { id } }")), guard())).toEqual({ act: "pass" });
    expect(judge(request("/search?query=mutation+of+genes"), guard())).toEqual({ act: "pass" });
    expect(judge(request("/graphql"), guard())).toEqual({ act: "pass" });
  });

  const create = guard({ realWrites: true });
  const write = (path: string, body?: string, over: Partial<Outgoing> = {}) => request(path, { method: "POST", ...(body === undefined ? {} : { body }), ...over });

  it("--create stops a write that says anywhere it destroys", () => {
    for (const r of [
      write("/api/invoices/1", JSON.stringify({ invoice: { lines_attributes: [{ id: 9, _destroy: "1" }] } }), { method: "PATCH" }),
      write("/api/bulk", JSON.stringify({ action: "delete", ids: [1, 2] })),
      write("/rpc", JSON.stringify({ jsonrpc: "2.0", method: "invoices.delete", params: [7], id: 1 })),
      write("/api/doc", JSON.stringify([{ op: "remove", path: "/items/0" }]), { method: "PATCH" }),
      write("/api/invoices/1", JSON.stringify({ deleted: true }), { method: "PUT" }),
      write("/api/invoices/1/trash"), write("/api/purge"), write("/api/cart/clear"), write("/api/invoices?action=delete&id=1"),
      write("/admin-ajax.php", "action=delete-post&id=1"), write("/api/invoices/1", "%5Fmethod=delete"),
      write("/api/invoices/2", '------x\r\nContent-Disposition: form-data; name="_method"\r\n\r\ndelete\r\n------x--'),
      write("/api/invoices/3", undefined, { headers: { "x-http-method-override": " DELETE" } }), write("/api/invoices/4", JSON.stringify({ method: "DELETE" })),
      write("/graphql", '------x\r\nContent-Disposition: form-data; name="operations"\r\n\r\n{"query":"mutation { deleteInvoice(id: 7) { id } }"}\r\n------x--'),
      write("/graphql", "mutation { deleteInvoice(id: 7) { id } }", { headers: { "content-type": "application/graphql" } }),
      write("/graphql", JSON.stringify({ query: "mutation { clearInvoices { ok } }" })), write("/graphql", JSON.stringify([{ query: "mutation { emptyTrash { ok } }" }])),
      write("/api/tables", "statement=truncate"), write("/api/x", undefined, { method: "DELETE" }),
    ]) expect(judge(r, create), `${r.url.pathname} ${r.body ?? ""}`).toEqual({ act: "stop" });
  });

  it("--create lets a plain save through, a false flag included", () => {
    for (const r of [
      write("/api/invoices", JSON.stringify({ total: 1 })), write("/api/invoices/1", JSON.stringify({ _destroy: false, title: "Test" }), { method: "PATCH" }), write("/api/invoices/1", "invoice[lines][0][_destroy]=0&title=Test"),
      write("/api/invoices", JSON.stringify({ deleted: false })), write("/graphql", JSON.stringify({ query: "mutation { createInvoice { id } }" })), write("/api/publish"),
    ]) expect(judge(r, create), `${r.url.pathname} ${r.body ?? ""}`).toEqual({ act: "pass" });
  });

  it("while signing in, the form goes, and third parties stay read-only", () => {
    const signingIn = guard({ crawling: () => false });
    expect(judge(request("/session", { method: "POST" }), signingIn)).toEqual({ act: "pass" });
    expect(judge(request("/sso/logout"), signingIn)).toEqual({ act: "pass" });
    expect(judge(request("https://other.test/x", { method: "POST" }), signingIn)).toEqual({ act: "refuse" });
  });
});

describe("words in text", () => {
  it("are whole words, so nothing is matched inside another", () => {
    for (const text of ["Delete", "deleteInvoice", "empty_bin", "Close account", "action=delete-post", "löschen"]) expect(saysDestroys(text), text).toBe(true);
    for (const text of ["Deleted items", "Preset", "dropdown", "Clearly", "Remover tool", "archived"]) expect(saysDestroys(text), text).toBe(false);
  });
});

describe("a live connection's upkeep", () => {
  it.each([
    "2", "3", "2probe", "3probe", "5", "6", "40", "41", '40{"token":"t"}', "40/admin,", "0", "\n", "ping", "PONG", "keepalive",
    "CONNECT\naccept-version:1.2\nhost:x\n\n\0", "SUBSCRIBE\nid:1\ndestination:/topic/x\n\n\0", "DISCONNECT\n\n\0",
    '{"type":"connection_init"}', '{"type":"connection_init","payload":{"token":"x"}}', '{"type":"ka"}', '{"type":"connection_terminate"}', '{"id":"1","type":"complete"}', '{"id":"1","type":"stop"}',
    '{"id":"1","type":"subscribe","payload":{"query":"subscription { a { id } }"}}', '{"id":"1","type":"start","payload":{"query":"query { a { id } }"}}',
    '{"msg":"connect","version":"1","support":["1"]}', '{"msg":"ping"}', '{"msg":"pong","id":"1"}', '{"msg":"sub","id":"1","name":"tasks","params":[]}', '{"msg":"unsub","id":"1"}',
    '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0x1"],"id":1}', '{"jsonrpc":"2.0","method":"invoices.list","id":1}', '{"method":"user/find","params":[],"id":1}',
    '{"command":"subscribe","identifier":"{\\"channel\\":\\"X\\"}"}', '{"command":"unsubscribe","identifier":"x"}',
    '{"t":"c","d":{"t":"p","d":{}}}', '{"t":"d","d":{"r":1,"a":"q","b":{"p":"/tasks","h":""}}}', '{"t":"d","d":{"r":2,"a":"auth","b":{"cred":"x"}}}',
    '["1","2","room:lobby","phx_join",{}]', '[null,"3","phoenix","heartbeat",{}]', '["1","4","lv:x","event",{"type":"form","event":"validate","value":"a=1"}]', '{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"1"}',
    '{"event":"pusher:ping","data":{}}', '{"event":"pusher:subscribe","data":{"channel":"x"}}',
    '{"type":"ping"}', '{"type":"pong","ts":123}', '{"type":"heartbeat","id":7}', '{"type":"subscribe","channel":"prices"}', '{"action":"subscribe","topics":["a"]}', '{"op":"ping"}', '42["subscribe",{"room":"x"}]', '42["ping"]',
  ])("%j passes", (text) => expect(socketUpkeep(text)).toBe(true));

  it.each([
    '{"type":"complete","taskId":7}', '{"type":"stop","server":"prod-1"}', '{"type":"complete","id":"1","orderId":7,"delete":true}', '{"jsonrpc":"2.0","method":"getAndClear","id":1}', '{"jsonrpc":"2.0","method":"list.clear","id":2}',
    '{"jsonrpc":"2.0","method":"status.approve","id":3}', '{"jsonrpc":"2.0","method":"findAndModify","params":{"update":{"paid":true}},"id":4}', '{"jsonrpc":"2.0","method":"query","params":["DELETE FROM invoices"],"id":5}',
    '{"jsonrpc":"2.0","method":"run","params":[],"id":6}', '{"method":"Page.reload","params":{},"id":6}', '{"jsonrpc":"2.0","method":"list","params":{"action":"delete"},"id":7}', '42["validate",{"ticket":7}]', '42["identify",{"userId":7,"plan":"free"}]',
    '{"type":"validate","orderId":7}', '{"event":"presence_kick_user","user":7}', '{"type":"deleteAll:ping"}', '{"type":"auth","action":"delete"}', '{"type":"ping","action":"delete_all"}', '{"msg":"ping","method":"tasks.remove"}',
    '{"t":"d","d":{"a":"p","b":{"p":"/tasks","d":null}}}', '{"t":"d","d":{"a":"auth","b":{"p":"/tasks","d":null}}}', '{"t":"c","d":{"a":"delete"}}', '{"command":"subscribe","action":"delete"}', '{"id":"1","type":"subscribe","payload":{"query":"query { a } "},"action":"delete_all"}',
    '{"id":"1","type":"subscribe","payload":{"query":"mutation { a { id } }"}}', '{"id":"1","type":"subscribe","payload":{"query":"abc"}}', "UNSUBSCRIBE\nid:1\n\ndelete everything", "ACK\nid:1\n\n", "SEND\ndestination:/x\n\nhello\0",
    '{"action":"delete_all"}', '{"type":"subscribe","channel":"prices","delete":true}', '42["subscribe",{"action":"delete"}]', '["1","2","t","delete_item",{}]', "4{}", "hello",
  ])("%j is held", (text) => expect(socketUpkeep(text)).toBe(false));
});
