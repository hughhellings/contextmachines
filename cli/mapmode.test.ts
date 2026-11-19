// Map mode (any-site plan 5.2, M1): the holding unit's rule (pure), the feature naming (pure), and in a
// real browser on local fixtures only: the trap app (plan 2.2) under the hold sends its server nothing,
// while the same clicks with no hold do write (so the traps are live); the look-only walk, signed in
// with a fixture account, maps the trap app and the areas app with 0 writes reaching either server; a
// lost session is noticed and signed in again. No AI, no network beyond 127.0.0.1.
//   node --test cli/mapmode.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { defaultMask, dropAmbient, floorOf, mapSite, shownPath, viewKey } from "../packages/scanner/src/tester/mapcrawl.ts";
import { bodyFieldNames, clueVerb, getActs, holdForMapping, mapContextOptions, mapVerdict, pathPattern, type HeldClue } from "../packages/scanner/src/mapmode.ts";
import { controlMeaning, detailEntity, entityOf, featuresOf, formVerb, singular, type MapView } from "../packages/scanner/src/tester/mapnames.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "./accounts.ts";
import { AREAS_SIGNED_IN_TEXT, startAreas } from "./bench/zoo/areas.ts";
import { mapSignedIn } from "./map-session.ts";
import type { SessionNeed } from "./signin.ts";
import { startTrap, TRAP_SIGNED_IN_TEXT } from "./bench/zoo/trap.ts";
import { SHAPES_SIGNED_IN_TEXT, startShapes } from "./bench/zoo/shapes.ts";

const json = (x: unknown) => JSON.stringify(x);

describe("map mode's rule (mapVerdict)", () => {
  it("holds every write method, on every host", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "QUERY"]) {
      for (const url of ["http://127.0.0.1:3000/api/x", "https://other.example/collect"]) assert.equal(mapVerdict({ method, url, body: "{}" }).act, "hold", `${method} ${url}`);
    }
    assert.equal(mapVerdict({ method: "GET", url: "http://127.0.0.1/projects?q=wall" }).act, "pass");
    assert.equal(mapVerdict({ method: "HEAD", url: "http://127.0.0.1/" }).act, "pass");
  });
  it("lets a GraphQL POST through only when every operation is a query", () => {
    const ct = "application/json";
    assert.deepEqual(mapVerdict({ method: "POST", url: "http://h/graphql", contentType: ct, body: json({ query: "query P { projects { id } }" }) }), { act: "pass", graphqlRead: true });
    assert.equal(mapVerdict({ method: "POST", url: "http://h/graphql", contentType: ct, body: json([{ query: "query Me { me { id } }" }, { query: "mutation M { markSeen }" }]) }).act, "hold", "a mutation hidden in a batch");
    assert.equal(mapVerdict({ method: "POST", url: "http://h/graphql", contentType: ct, body: json({ operationName: "T", extensions: { persistedQuery: { sha256Hash: "ab" } } }) }).act, "hold", "a persisted hash");
    assert.equal(mapVerdict({ method: "POST", url: "http://h/graphql", contentType: ct, body: json({ query: "# a comment\nmutation { x }" }) }).act, "hold");
    assert.equal(mapVerdict({ method: "POST", url: "http://h/search", contentType: ct, body: json({ query: "shoes" }) }).act, "hold", "a search API's 'query' is not GraphQL");
    assert.equal(mapVerdict({ method: "GET", url: `http://h/graphql?operationName=T&extensions=${encodeURIComponent(json({ persistedQuery: { sha256Hash: "ab" } }))}` }).act, "hold", "a persisted GET");
  });
  it("holds GETs that change something: delete, sign out, accept an invite, toggles, one-time tokens", () => {
    for (const u of ["http://h/members/7/delete", "http://h/logout", "http://h/invite/accept?token=x", "http://h/settings?toggle=1", "http://h/notifications/mark-all-read", "http://h/unsubscribe", "http://h/confirm/9f8a7b6c5d4e3f2a1b0c9d8e7f6a"]) assert.ok(getActs(u), u);
    for (const u of ["http://h/projects", "http://h/projects/11", "http://h/tasks?status=Open", "http://h/z/ab12cd34ef/list", "http://h/reports"]) assert.equal(getActs(u), undefined, u);
  });
  it("GETs that do a job through common words are held: right after an id, or ending the address (M1 review)", () => {
    for (const u of ["http://h/notifications/12/open", "http://h/jobs/5/retry", "http://h/api/run?job=nightly", "http://h/api/sync", "http://h/api/send?to=all", "http://h/api/items/5/complete", "http://h/api/items/5/submit", "http://h/api/items/5/close", "http://h/api/items/5/reopen", "http://h/api/items/5/assign?user=3", "http://h/items/5/duplicate", "http://h/items/5/restore", "http://h/items/5/pin", "http://h/track?event=signup", "http://h/api/subscribe"]) assert.ok(getActs(u), u);
    // A view named by the same words, not after an id, is still a view.
    for (const u of ["http://h/tickets/open", "http://h/tasks/completed", "http://h/runs", "http://h/projects/5/edit"]) assert.equal(getActs(u), undefined, u);
  });
});

describe("clues: names only, never values", () => {
  it("keeps body field names (JSON, form, multipart, GraphQL variables) and no value", () => {
    assert.deepEqual(bodyFieldNames(json({ name: "Secret Person", deal: { size: 900 }, tags: [{ id: 1 }] }), "application/json"), ["deal.size", "name", "tags[].id"]);
    assert.deepEqual(bodyFieldNames("email=a%40b.c&password=hunter2", "application/x-www-form-urlencoded"), ["email", "password"]);
    assert.deepEqual(bodyFieldNames('--x\r\ncontent-disposition: form-data; name="file"; filename="a.txt"\r\n\r\nbody\r\n--x--', "multipart/form-data; boundary=x"), ["file"]);
    assert.deepEqual(bodyFieldNames(json({ query: "mutation A($n: String) { a(n: $n) }", variables: { n: "Robin" } })), ["variables.n"]);
    for (const v of ["Secret Person", "hunter2", "Robin", "900"]) assert.ok(!json([bodyFieldNames(json({ name: "Secret Person", deal: 900 })), bodyFieldNames("password=hunter2")]).includes(v));
  });
  it("paths as patterns: ids as :id, query keys without values", () => {
    assert.equal(pathPattern("http://h/z/ab12cd34ef/api/contacts/42?token=abc&view=1"), "/z/:id/api/contacts/:id?token&view");
  });
  it("a value in an address or used as a key never reaches a clue (M1 review)", () => {
    const secret = "robin.test@example.test";
    const said = json([
      pathPattern(`http://h/api/search/${encodeURIComponent(secret)}`),
      pathPattern("http://h/users/robin-test/settings"),
      pathPattern("http://h/api/tags/MySecretProjectName"),
      pathPattern(`http://h/api/x;email=${secret}`),
      pathPattern(`http://h/api/x?${encodeURIComponent(secret)}=1`),
      bodyFieldNames(json({ answers: { [secret]: "yes" } }), "application/json"),
      bodyFieldNames(json({ [secret]: true }), "application/json"),
      bodyFieldNames(`${encodeURIComponent(secret)}=on`, "application/x-www-form-urlencoded"),
      bodyFieldNames(json({ query: "mutation M($x: J) { m(x: $x) }", variables: { x: { [secret]: 1 } } })),
      bodyFieldNames(`--b\r\nContent-Disposition: form-data; name="${secret}"\r\n\r\nv\r\n--b--`, "multipart/form-data; boundary=b"),
    ]);
    for (const v of ["robin", "Robin", "example", "MySecret"]) assert.ok(!said.includes(v), `${v} in ${said}`);
    assert.equal(pathPattern("http://h/users/robin-test/settings"), "/users/:value/settings");
    assert.deepEqual(bodyFieldNames(json({ answers: { [secret]: "yes" }, title: "x" })), ["answers.*", "title"]);
    // Ordinary places and names are kept.
    assert.equal(pathPattern("http://h/settings/billing-details?tab=1"), "/settings/billing-details?tab");
    assert.deepEqual(bodyFieldNames("user[name]=a&user[email]=b"), ["user[email]", "user[name]"]);
  });
  it("a clue's verb, from REST-shaped addresses only", () => {
    const c = (method: string, path: string, graphql?: HeldClue["graphql"]) => clueVerb({ method, path, ...(graphql ? { graphql } : {}) });
    assert.equal(c("POST", "/api/contacts"), "create");
    assert.equal(c("POST", "/z/:id/api/create"), "create");
    assert.equal(c("POST", "/api/contacts/:id"), "update");
    assert.equal(c("PATCH", "/api/x/:id"), "update");
    assert.equal(c("DELETE", "/api/x/:id"), "delete");
    assert.equal(c("POST", "/api/projects/:id/archive"), undefined);
    assert.equal(c("POST", "/actions"), undefined, "RPC-style: no verb from the address");
    assert.equal(c("POST", "/graphql", { operations: ["CreateInvoice"], kinds: ["mutation"] }), "create");
  });
});

describe("the walk's addresses (M1 review)", () => {
  it("a view is its address with ids as :id, plus a hash route and a tab picked by the query", () => {
    assert.equal(viewKey("http://h/app#/clients/42"), "http://h/app#/clients/:id");
    assert.notEqual(viewKey("http://h/app#/clients"), viewKey("http://h/app#/settings"));
    assert.equal(viewKey("http://h/app#/"), viewKey("http://h/app"), "the router's start is the page itself");
    assert.equal(viewKey("http://h/app#section-2"), viewKey("http://h/app"), "a plain anchor is the same page");
    assert.notEqual(viewKey("http://h/settings?tab=billing"), viewKey("http://h/settings?tab=profile"));
    assert.equal(viewKey("http://h/clients?q=acme"), viewKey("http://h/clients?q=bolt"), "a search's words aren't a view");
  });
  it("a page address and a sample row as a map shows them: values masked", () => {
    assert.equal(shownPath(new URL("http://h/users/robin-test/settings?tab=billing&q=robin.test%40example.test")), "/users/:value/settings?tab=billing&q=:value");
    assert.equal(defaultMask("Robin <robin.test@example.test>, +44 7700 900123, ref 12345678"), "Robin <{email}>, {number}, ref {number}");
  });
});

describe("the floor", () => {
  it("never presses sign out, paying, ordering, sending, deleting; a filter's remove is pressed", () => {
    for (const w of ["Sign out", "Buy now", "Pay £10", "Send invite", "Delete account", "Delete Tobias-357", "Go live", "Connect your bank"]) assert.ok(floorOf(w), w);
    for (const w of ["Remove filter", "Clear search", "Save", "Next", "Rename", "Add to wishlist", "Archive"]) assert.equal(floorOf(w), undefined, w);
  });
});

describe("naming features (mapnames.ts)", () => {
  it("entities from headings and labels", () => {
    assert.equal(entityOf("New contact"), "contact");
    assert.equal(entityOf("Contacts"), "contact");
    assert.equal(entityOf("Price notes"), "price note");
    assert.equal(entityOf("Review"), undefined);
    assert.equal(singular("entries"), "entry");
    assert.equal(singular("status"), "status");
    assert.equal(detailEntity("/z/:id/projects/:id"), "project");
    assert.equal(detailEntity("/z/:id/"), undefined);
  });
  it("controls: their verb, and the thing their words name", () => {
    assert.deepEqual(controlMeaning("Add to wishlist"), { verb: "create", object: "wishlist" });
    assert.deepEqual(controlMeaning("Buy now"), { verb: "create", object: "order" });
    assert.deepEqual(controlMeaning("Remove filter"), { verb: "filter" });
    assert.deepEqual(controlMeaning("Export CSV"), { verb: "export" });
    assert.deepEqual(controlMeaning("Delete"), { verb: "delete" });
    assert.deepEqual(controlMeaning("Refresh totals"), { verb: "read", object: "total" });
  });
  it("a form's verb: its held request, then its heading and button, then its fields; GET forms are filters", () => {
    const clues = [{ n: 1, method: "POST", path: "/api/contacts" } as HeldClue];
    const base = { heading: "", submit: "Save", fields: [], held: [], presses: [] };
    assert.equal(formVerb({ ...base, held: [1] }, clues), "create");
    assert.equal(formVerb({ ...base, heading: "Edit project" }, []), "update");
    assert.equal(formVerb({ ...base, submit: "Save changes" }, []), "update");
    assert.equal(formVerb({ ...base, fields: [{ label: "Name", type: "text", required: true, prefilled: true }] }, []), "update");
    assert.equal(formVerb({ ...base, fields: [{ label: "Name", type: "text", required: true }] }, []), "create");
    assert.equal(formVerb({ ...base, method: "get", submit: "Apply filter" }, []), "filter");
    // A script's form says no method: what it sent, held, names it (M1 review), not "filter".
    const sent = [{ n: 9, at: 0, method: "PATCH", kind: "http", host: "h", path: "/api/clients/:id", fields: ["name"], why: "", page: "/", resource: "fetch" }] as HeldClue[];
    assert.equal(formVerb({ ...base, held: [9] }, sent), "update");
    assert.equal(formVerb({ ...base, submit: "Apply", outcome: "went to /clients?status=open and sent nothing else" }, []), "filter", "a form with no method that only went somewhere is sent by GET");
    assert.equal(formVerb({ ...base, submit: "Enter", savesAsYouType: [3] }, []), "update");
  });
  it("one feature per row control for the whole list; same verb and thing merge; status changes and detail pages stay apart", () => {
    const view = (over: Partial<MapView>): MapView => ({ n: 1, path: "/a", pattern: "/a", area: "", depth: 0, title: "", heading: "", forms: [], lists: [], switches: [], controls: [], counts: [], empty: [], leftAlone: [], partlySeen: [], ...over });
    const f = featuresOf([
      view({ path: "/p", heading: "Projects", lists: [{ heading: "Projects", kind: "table", columns: [], rows: 3, rowActions: [{ name: "Delete", held: [] }, { name: "Archive", held: [] }, { name: "Rename", held: [] }] }] }),
      view({ path: "/list", heading: "Projects", lists: [{ heading: "Projects", kind: "table", columns: [], rows: 3, rowActions: [] }] }),
      view({ path: "/projects/1", pattern: "/projects/:id", heading: "Harbour wall", forms: [{ heading: "Edit project", fields: [], submit: "Save changes", presses: [], steps: 1, outcome: "", held: [], via: "page" }] }),
      view({ path: "/t", heading: "Tasks", empty: ["No tasks yet."] }),
    ]);
    const names = f.map((x) => `${x.verb}:${x.entity}${x.kind ? `:${x.kind}` : ""}`).sort();
    assert.deepEqual(names, ["delete:project", "read:project:detail", "read:project", "read:task", "update:project", "update:project:archive"].sort());
    assert.deepEqual(f.find((x) => x.verb === "read" && x.entity === "project")!.pages, ["/p", "/list"]);
  });
  it("background requests (a token refresh on a timer) never name a press", () => {
    const clue = (n: number, path: string, press?: string): HeldClue => ({ n, at: n, method: "POST", kind: "http", host: "h", path, fields: [], why: "", page: "/", resource: "fetch", ...(press ? { press } : {}) });
    const clues = [clue(1, "/refresh"), clue(2, "/refresh", "Enter"), clue(3, "/drafts", "(typing)")];
    const v: MapView = { n: 1, path: "/", pattern: "/", area: "", depth: 0, title: "", heading: "", forms: [{ heading: "Scratchpad", fields: [], submit: "Enter", presses: [], steps: 1, outcome: "sent", held: [2], savesAsYouType: [3], via: "page" }], lists: [], switches: [], controls: [], counts: [], empty: [], leftAlone: [], partlySeen: [] };
    dropAmbient([v], clues);
    assert.deepEqual(v.forms[0]!.held, []);
    assert.deepEqual(v.forms[0]!.savesAsYouType, [3]);
  });
});

describe("in a browser, on local fixtures", () => {
  let browser: Browser;
  before(async () => {
    browser = await launch();
  });
  after(async () => {
    await browser?.close();
  });

  /** Every trap, pressed by a script: typing, blur, Save, a socket save, a server action, the GraphQL page, the activity page's beacon and outbox. */
  async function poke(held: boolean) {
    const trap = await startTrap();
    const ctx = await browser.newContext({ ...(held ? mapContextOptions : {}), storageState: await trap.storageState() });
    const hold = held ? await holdForMapping(ctx) : undefined;
    const page = await ctx.newPage();
    try {
      await page.goto(trap.url);
      await page.fill("#draft", "typed words");
      await page.fill("#t", "A title");
      await page.click("#b");
      await page.waitForTimeout(1600);
      await page.click("button[type=submit]").catch(() => {});
      await page.waitForTimeout(300);
      await page.goto(`${trap.url}live`);
      await page.waitForTimeout(300);
      await page.fill("#c", "card");
      await page.click("#add");
      await page.goto(`${trap.url}actions`);
      await page.click("#saveprofile");
      await page.goto(`${trap.url}projects`);
      await page.waitForTimeout(500);
      const projects = await page.locator("#plist").innerText();
      await page.goto(`${trap.url}activity`);
      await page.waitForTimeout(500);
      // The GET traps, opened directly (the walk never follows them; the hold stops the commanding ones anyway).
      for (const p of ["members/7/delete", "invite/accept?token=demo-invite-1", "logout"]) await page.goto(`${trap.url}${p}`).catch(() => {});
      await page.goto("about:blank").catch(() => {});
      await page.waitForTimeout(300);
      return { writes: trap.writes.map((w) => w.what), hold, projects };
    } finally {
      await ctx.close();
      await trap.close();
    }
  }

  it("with no hold, every kind of trap writes (the traps are live)", async () => {
    const { writes } = await poke(false);
    for (const w of ["POST /api/presence", "POST /api/notes/read", "PATCH /api/drafts/title", "POST /api/drafts", "POST /api/notes", "POST /api/session/refresh", "WS hello", "WS card.create", "POST /actions", "GQL mutation MarkSeen", "GQL persisted TrackView", "GQL persisted GET TrackView", "POST /api/track", "POST /api/outbox/replay", "GET /members/7/delete", "GET /invite/accept", "GET /logout"]) assert.ok(writes.includes(w), `${w} in ${json(writes)}`);
  });

  it("under map mode's hold, the same clicks send the trap server nothing; a GraphQL read still draws its page", async () => {
    const { writes, hold, projects } = await poke(true);
    assert.deepEqual(writes, []);
    assert.equal(hold!.counts.leaked, 0);
    assert.ok(hold!.counts.wsFramesHeld >= 2 && hold!.counts.beaconsHeld >= 1 && hold!.counts.graphqlReadsPassed >= 1, json(hold!.counts));
    assert.match(projects, /Harbour wall/);
    const said = json(hold!.clues);
    for (const v of ["typed words", "A title", "card"]) assert.ok(!said.includes(`"${v}"`), `no value in the clues: ${v}`);
    assert.ok(hold!.clues.some((c) => c.path.endsWith("/api/notes") && c.fields.includes("title")), "the note form's clue: where it posts, and its field names");
  });

  it("the walk, signed in, maps the trap app with 0 writes reaching it, and never follows a notification or sign-out link", async () => {
    const trap = await startTrap();
    try {
      const run = await mapSite({ url: trap.url, browser, storageState: await trap.storageState(), signedIn: { kind: "signed_in", text: TRAP_SIGNED_IN_TEXT }, limits: { minutes: 2 } });
      assert.deepEqual(trap.writes, []);
      assert.equal(run.mapMode.writesLeft, 0);
      assert.ok(run.mapMode.views.length >= 6, `${run.mapMode.views.length} views`);
      assert.ok(!trap.requests.some((r) => /notifications\/12|logout|invite\/accept|members\/7\/delete/.test(r)), json(trap.requests.filter((r) => /notif|logout|invite|delete/.test(r))));
      const names = run.actions.map((a) => `${a.verb}:${a.entity}`);
      for (const n of ["create:note", "create:card", "update:scratchpad", "update:profile"]) assert.ok(names.includes(n), `${n} in ${json(names)}`);
    } finally {
      await trap.close();
    }
  });

  it("the walk, signed in, on the trap app's ways past a hold (a page moving itself, a meta refresh, a pressed button, an iframe, a redirect, speculation rules, GET jobs): live with no hold, 0 writes under the walk", async () => {
    const live = await startTrap({ moves: true });
    const ctx = await browser.newContext({ storageState: await live.storageState() });
    try {
      const page = await ctx.newPage();
      for (const p of ["moves", "refresh", "tools", "go"]) {
        await page.goto(`${live.url}${p}`).catch(() => {});
        await page.waitForTimeout(1200);
      }
      await page.goto(`${live.url}tools`).catch(() => {});
      await page.click("#showall").catch(() => {});
      await page.waitForTimeout(600);
      const wrote = json(live.writes.map((w) => w.what));
      for (const w of ["GET /items/5/delete", "GET /notifications/mark-all-read", "GET /items?action&id", "GET /members/8/delete", "GET /members/9/delete", "[prefetch]", "GET /jobs/5/retry", "GET /api/sync", "GET /items/5/duplicate"]) assert.ok(wrote.includes(w), `${w} in ${wrote}`);
    } finally {
      await ctx.close();
      await live.close();
    }
    const trap = await startTrap({ moves: true });
    try {
      const run = await mapSite({ url: trap.url, browser, storageState: await trap.storageState(), signedIn: { kind: "signed_in", text: TRAP_SIGNED_IN_TEXT }, limits: { minutes: 3 } });
      assert.deepEqual(trap.writes, []);
      assert.equal(run.mapMode.writesLeft, 0);
      assert.match(run.mapMode.writesLeftCovers, /can't be counted here/);
      assert.ok(run.mapMode.hold.speculationRemoved >= 1, json(run.mapMode.hold));
      const heldGets = run.mapMode.held.filter((c) => c.kind === "get").map((c) => c.path);
      for (const p of ["/items/:id/delete", "/notifications/mark-all-read", "/items?action&id", "/members/:id/delete", "/jobs/:id/retry"]) assert.ok(heldGets.some((x) => x.endsWith(p)), `${p} held: ${json(heldGets)}`);
      assert.ok(run.mapMode.held.some((c) => /redirects to an address/.test(c.why)), "the redirect to a delete address is held at its hop");
    } finally {
      await trap.close();
    }
  });

  it("the walk on common single-page-app shapes: hash routes, a side menu outside <nav>, a form with no method, a row menu, tabs, a button in <nav>, and a plain link that ends the session", async () => {
    const app = await startShapes();
    let again = 0;
    try {
      const run = await mapSite({ url: app.url, browser, storageState: await app.storageState(), signedIn: { kind: "signed_in", text: SHAPES_SIGNED_IN_TEXT }, signInAgain: async () => (again++, app.storageState()), limits: { minutes: 3 } });
      assert.deepEqual(app.writes, []);
      // The session-ending link is opened once, never again, and the walk carries on.
      assert.equal(app.sessionEnds, 1);
      assert.ok(again <= 1, `${again} sign-ins`);
      const views = run.mapMode.views;
      const at = (re: RegExp, via?: string) => views.find((v) => re.test(v.path) && (via === undefined ? !v.via : v.via?.includes(via)));
      assert.ok(at(/#\/clients$/) && at(/#\/clients\/\d+$/) && at(/#\/settings$/), json(views.map((v) => v.path)));
      // The form with no method sent PATCH: an update, not a filter.
      const names = run.actions.map((a) => `${a.verb}:${a.entity}`);
      assert.ok(names.includes("update:client") && !names.some((n) => n.startsWith("filter:")), json(names));
      // The row menu's items were seen and pressed (held).
      const rows = at(/#\/clients$/)!.lists[0]!.rowActions;
      assert.ok(rows.some((a) => a.name === "Duplicate" && a.held.length) && rows.some((a) => a.name === "Archive" && a.held.length), json(rows));
      // The hidden Billing tab is its own state, with its form sent (held).
      assert.ok(at(/#\/settings$/, "Billing")?.forms.some((f) => /billing/i.test(f.heading) && f.held.length), json(views.map((v) => [v.path, v.via])));
      // The button in <nav> showed Reports.
      assert.ok(views.some((v) => v.via?.includes("Reports") && v.heading === "Reports"), json(views.map((v) => [v.path, v.via, v.heading])));
    } finally {
      await app.close();
    }
  });

  it("the walk, signed in, maps the areas app's parts: forms, fields, choices, lists, row controls, switches, empty states; signed out it sees the sign-in page only", async () => {
    const areas = await startAreas();
    try {
      const run = await mapSite({ url: areas.url, browser, storageState: await areas.storageState(), signedIn: { kind: "signed_in", text: AREAS_SIGNED_IN_TEXT }, limits: { minutes: 2 } });
      assert.deepEqual(areas.writes, []);
      assert.deepEqual(areas.changes, []);
      const views = run.mapMode.views;
      // Breadth first: every section of the navigation before anything deeper.
      const order = views.map((v) => v.area);
      for (const a of ["projects", "tasks", "reports", "settings"]) assert.ok(order.indexOf(a) >= 0 && order.indexOf(a) < views.findIndex((v) => /projects\/(new|\d+)$/.test(v.path)), `${a} before depth: ${json(views.map((v) => v.path))}`);
      const newProject = views.flatMap((v) => v.forms).find((f) => f.heading === "New project")!;
      assert.deepEqual(newProject.fields.map((f) => [f.label, f.type, f.required]), [["Project name", "text", true], ["Client", "select", true], ["Budget (£)", "number", false], ["Start date", "date", false]]);
      assert.deepEqual(newProject.fields[1]!.choices, ["Harbour Trust", "North Council", "Riverside Ltd"]);
      assert.match(newProject.outcome, /held/);
      const projects = views.find((v) => v.area === "projects" && v.lists.length)!.lists[0]!;
      assert.equal(projects.rows, 3);
      assert.ok(projects.sample?.includes("Harbour wall survey"));
      assert.deepEqual(projects.rowActions.map((a) => [a.name, Boolean(a.notPressed)]), [["Archive", false], ["Delete", true]]);
      assert.ok(views.find((v) => v.area === "tasks")!.empty.some((e) => /No tasks yet/.test(e)));
      const settings = views.find((v) => v.area === "settings")!;
      assert.deepEqual(settings.switches[0]!.names, ["Email me about mentions", "Weekly digest"]);
      assert.ok(settings.switches[0]!.held.length > 0, "a switch saves the moment it's pressed (held)");
      assert.ok(settings.controls.some((c) => c.name === "Delete account" && c.notPressed));
      assert.ok(views.find((v) => v.area === "reports")!.counts.some((c) => /Total budget/.test(c)));
      const out = await mapSite({ url: areas.url, browser, limits: { minutes: 1 } });
      assert.equal(out.mapMode.views.length, 1);
      assert.match(out.mapMode.views[0]!.forms[0]!.notPressed ?? "", /password/);
      assert.deepEqual(areas.writes, []);
    } finally {
      await areas.close();
    }
  });

  it("a session lost while writes are held (the token refresh is held) is noticed, signed in again, and the walk goes on", async () => {
    const trap = await startTrap({ sessionMs: 2500 });
    let again = 0;
    try {
      const run = await mapSite({ url: trap.url, browser, storageState: await trap.storageState(), signedIn: { kind: "signed_in", text: TRAP_SIGNED_IN_TEXT }, signInAgain: async () => (again++, trap.storageState()), limits: { minutes: 1, signIns: 1, views: 4 } });
      assert.ok(run.mapMode.session.lost.length >= 1, json(run.mapMode.session));
      assert.equal(again, run.mapMode.session.signedInAgain);
      assert.ok(again >= 1);
      assert.deepEqual(trap.writes, []);
    } finally {
      await trap.close();
    }
  });

  it("mapSignedIn: the run's account session from the sign-in helper, its own signed-in check, and a forced new session when it's lost", async () => {
    const trap = await startTrap({ sessionMs: 2500 });
    const dir = mkdtempSync(join(tmpdir(), "cm-mapmode-"));
    const calls: boolean[] = [];
    try {
      const account = { label: "fixture", signedIn: { text: TRAP_SIGNED_IN_TEXT } } as unknown as Account;
      const need = { outDir: dir, url: trap.url, account, browser } as unknown as SessionNeed & { browser: Browser };
      const ensure = async (_n: SessionNeed, o: { force?: boolean } = {}) => {
        calls.push(o.force === true);
        const path = join(dir, `session-${calls.length}.json`);
        writeFileSync(path, JSON.stringify(await trap.storageState()), { mode: 0o600 });
        return { path, how: "saved" as const };
      };
      const r = await mapSignedIn(need, { limits: { minutes: 1, views: 3, signIns: 1 } }, ensure);
      assert.ok("map" in r);
      assert.equal(r.map.signedInAs, "fixture");
      assert.equal(calls[0], false);
      if (r.map.mapMode.session.signedInAgain) assert.equal(calls[1], true, "a lost session is replaced with force");
      assert.deepEqual(trap.writes, []);
      const blocked = await mapSignedIn(need, {}, async () => ({ blocked: "AUTH_CREDENTIAL_UNAVAILABLE: no password", code: "AUTH_CREDENTIAL_UNAVAILABLE" as const }));
      assert.deepEqual(blocked, { blocked: "AUTH_CREDENTIAL_UNAVAILABLE: no password" });
    } finally {
      await trap.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
