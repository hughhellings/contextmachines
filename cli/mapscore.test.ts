// The fixed map scoring script (any-site plan 2.1, M0): normalising each crawler's shape, and the
// counting rules (one-to-one in map order, duplicates, neutral entries, undecidable = miss + false
// positive). A small truth file written here; no browser, no AI, no network.
//   node --test cli/mapscore.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityAfterVerb, entityMatches, entityOf, fromExploreRun, fromLearnMap, fromTasks, normalise, normaliseUrl, score, verbClass, verbOf, type MapEntry, type Truth } from "./bench/mapscore.ts";

const TRUTH: Truth = {
  app: "mini",
  skin_d_set: "crm",
  features: [
    { id: "create", entity: "$entity", verb: "create", entry: [{ url: "^$", controls: ["^(Save|Add)$", "^new contact$"] }] },
    { id: "delete", entity: "$entity", verb: "delete", entry: [{ url: "^$", controls: ["^delete( .+)?$"] }] },
    { id: "show-all", entity: "$entity", verb: "filter", entry: [{ url: "^(\\?show=all)?$", controls: ["^remove filter$"] }, { url: "^(list)?\\?show=all$", controls: [] }] },
    { id: "unlock", entity: "lock", entityAliases: ["lock", "owner pin"], verb: "other", twins: ["needs_owner"], entry: [{ url: "^$", controls: ["^unlock$"] }] },
    { id: "read-list", entity: "$entity", verb: "read", entry: [{ url: "^list$", controls: ["^(Contacts)$"] }, { url: "^$", controls: ["^(Contacts)$", "^list$"] }] },
  ],
  neutral: [
    { what: "Home link", verb: "navigate", url: "^$", controls: ["^home$"] },
    { what: "app name", verb: "read", url: ".*", controls: ["^(Pipeline CRM)$"] },
  ],
  matching: {
    verb: {
      synonyms: { view: "read", open: "read", add: "create", remove: "delete", sort: "filter", undo: "other", edit: "update" },
      classes: [["create"], ["read", "navigate"], ["update"], ["delete"], ["search", "filter"], ["export"], ["other"]],
    },
    entity_by_skin: { crm: ["contact", "contacts", "person"], recipes: ["recipe", "recipes", "dish"] },
  },
};

const entry = (over: Partial<MapEntry>): MapEntry => ({ label: over.label ?? "x", urls: [""], controls: [], from: "test", ...over });

describe("normalising", () => {
  it("drops scheme, host, the instance prefix (an id or learn's :id), the trailing slash and the fragment; keeps the query", () => {
    assert.equal(normaliseUrl("http://127.0.0.1:5000/z/0a1b2c/"), "");
    assert.equal(normaliseUrl("http://127.0.0.1:5000/z/0a1b2c"), "");
    assert.equal(normaliseUrl("/z/0a1b2c/list?show=all#top"), "list?show=all");
    assert.equal(normaliseUrl("/z/:id"), "");
    assert.equal(normaliseUrl("/z/:id/list/"), "list");
    assert.equal(normaliseUrl("https://app.test/settings/", /^\/$/), "settings");
  });
  it("reads a phrase's verb and entity by fixed rules", () => {
    assert.equal(verbOf("Create a contact"), "create");
    assert.equal(entityAfterVerb("Create a new contact"), "contact");
    assert.equal(entityAfterVerb("Add a trade to your ledger"), "trade");
    assert.equal(entityOf("Contacts"), "contacts");
    assert.equal(entityAfterVerb("Undo"), undefined);
  });
  it("matches plural forms both ways, and nothing fuzzy", () => {
    assert.ok(entityMatches("contacts", ["contact"]));
    assert.ok(entityMatches("recipe", ["recipes"]));
    assert.ok(entityMatches("dishes", ["dish"]));
    assert.ok(!entityMatches("contact list", ["contact"]));
    assert.ok(!entityMatches("person", ["people"]));
    assert.ok(!entityMatches(undefined, ["contact"]));
  });
  it("puts verbs through the synonym table into classes", () => {
    assert.equal(verbClass("Open", TRUTH), verbClass("read", TRUTH));
    assert.equal(verbClass("navigate", TRUTH), verbClass("read", TRUTH));
    assert.equal(verbClass("sort", TRUTH), verbClass("filter", TRUTH));
    assert.equal(verbClass("click", TRUTH), -1);
  });
  it("takes learn's map.json: actions by name, screens as reads", () => {
    const e = fromLearnMap({
      schemaVersion: "map-1",
      actions: [
        { id: "z.create", name: "Create a contact", onScreen: "Save", pages: ["/z/:id"] },
        { id: "z.x", name: "Export everything", onScreen: null, pages: [] },
      ],
      screens: [{ path: "/z/:id/list", address: "/z/ab12/list", title: "Contacts · Pipeline CRM", headings: ["Contacts"] }],
    });
    assert.deepEqual(e.map((x) => [x.from, x.verb, x.entity, x.urls, x.controls]), [
      ["action", "create", "contact", [""], ["Save"]],
      ["action", "export", "everything", [], []],
      ["screen", "read", "contacts", ["list"], []],
    ]);
  });
  it("takes the Discovery crawl: pages as reads by the link words, left-alone controls by name", () => {
    const e = fromExploreRun({
      report: {
        pages: [
          { path: "/z/ab12/", title: "Contacts · Pipeline CRM", leftAlone: ['"Delete Ana / 🗑" wasn\'t pressed: it reads like deleting', "something without a name"] },
          { path: "/z/ab12/list", title: "Contacts · Pipeline CRM", from: { path: "/z/ab12/", words: "Contacts" }, leftAlone: [] },
        ],
      },
    });
    assert.deepEqual(e.map((x) => [x.from, x.verb, x.entity, x.urls, x.controls]), [
      ["page", "read", "contacts", [""], []],
      ["left-alone", "delete", "ana", [""], ["Delete Ana", "🗑"]],
      ["page", "read", "contacts", ["list"], ["Contacts"]],
    ]);
  });
  it("takes the suggested task list: verb from the goal, entity from the area, on the start page", () => {
    const e = fromTasks({ tasks: [{ goal: "Add a contact and see it listed", area: "contacts" }] });
    assert.deepEqual(e.map((x) => [x.verb, x.entity, x.urls]), [["add", "contacts", [""]]]);
  });
  it("tells the shapes apart, and refuses one it doesn't know", () => {
    assert.equal(normalise({ schemaVersion: "map-1", actions: [], screens: [] }).length, 0);
    assert.equal(normalise({ pages: [{ path: "/z/ab/", title: "A" }] })[0]!.from, "page");
    assert.equal(normalise({ tasks: [{ goal: "Open it", area: "x" }] })[0]!.from, "task");
    assert.equal(normalise({ entries: [{ label: "a", urls: [""], controls: [], from: "x" }] }).length, 1);
    assert.throws(() => normalise({ nothing: true }));
  });
});

describe("counting", () => {
  it("scores a perfect map 100/100 for the twin it ran", () => {
    const s = score([
      entry({ verb: "create", entity: "contact", controls: ["Save"] }),
      entry({ verb: "delete", entity: "contact", controls: ["Delete"] }),
      entry({ verb: "filter", entity: "contacts", urls: ["list?show=all"] }),
      entry({ verb: "view", entity: "contacts", urls: ["list"] }),
    ], TRUTH);
    assert.equal(s.features, 4, "the needs_owner-only feature is not in the task twin");
    assert.equal(s.tp, 4);
    assert.equal(s.recall, 1);
    assert.equal(s.precision, 1);
  });
  it("adds a twin's own features when that twin ran", () => {
    const s = score([entry({ verb: "undo", entity: "owner pin", controls: ["Unlock"] })], TRUTH, { twin: "needs_owner" });
    assert.equal(s.features, 5);
    assert.equal(s.perFeature.find((f) => f.id === "unlock")!.matched, true);
  });
  it("counts an over-split (one entry per row) as duplicates against precision", () => {
    const s = score(["Ana", "Ben", "Cy"].map((n) => entry({ label: n, verb: "delete", entity: "contact", controls: [`Delete ${n}`] })), TRUTH);
    assert.equal(s.tp, 1);
    assert.equal(s.duplicates, 2);
    assert.equal(s.precision, 1 / 3);
    assert.equal(s.perFeature.find((f) => f.id === "delete")!.duplicates, 2);
  });
  it("leaves neutral entries out of both sides, but never on an address alone", () => {
    const s = score([entry({ verb: "navigate", entity: "home", controls: ["Home"] }), entry({ verb: "read", entity: "pipeline crm", urls: ["list"], controls: ["Pipeline CRM"] }), entry({ verb: "read", entity: "home" })], TRUTH);
    assert.equal(s.neutral, 2);
    assert.equal(s.fp, 1, "a bare start-page entry with no control is not neutral");
    assert.equal(s.precision, 0);
  });
  it("makes undecidable entries misses and false positives: no address, no entity, no verb, a verb off the table", () => {
    const s = score([
      entry({ verb: "create", entity: "contact", urls: [] }),
      entry({ verb: "create", controls: ["Save"] }),
      entry({ entity: "contact", controls: ["Save"] }),
      entry({ verb: "click", entity: "contact", controls: ["Save"] }),
    ], TRUTH);
    assert.equal(s.tp, 0);
    assert.equal(s.fp, 4);
    assert.deepEqual(s.perEntry.map((p) => (p.outcome.kind === "fp" ? p.outcome.why : p.outcome.kind)), ["no address (undecidable)", "no entity (undecidable)", "no verb (undecidable)", "verb not in the table"]);
  });
  it("needs the same entity, the same verb class and an entry pattern", () => {
    const s = score([
      entry({ verb: "create", entity: "deal", controls: ["Save"] }),
      entry({ verb: "update", entity: "contact", controls: ["Save"] }),
      entry({ verb: "create", entity: "contact", controls: ["Cancel"] }),
      entry({ verb: "create", entity: "contact", urls: ["list"], controls: ["Save"] }),
    ], TRUTH);
    assert.equal(s.tp, 0);
    assert.deepEqual(s.perEntry.map((p) => (p.outcome.kind === "fp" ? p.outcome.why : "")), ["entity", "verb", "entry", "entry"]);
  });
  it("matches one-to-one in map order, the first unmatched feature in file order taking an entry that fits several", () => {
    // A bare start-page read fits read-list only; a filter with no control fits show-all by its first pattern.
    const s = score([entry({ verb: "filter", entity: "contact" }), entry({ verb: "filter", entity: "contact", urls: ["?show=all"] })], TRUTH);
    assert.equal(s.tp, 1);
    assert.equal(s.duplicates, 1);
    assert.equal(s.perFeature.find((f) => f.id === "show-all")!.by, "x");
  });
  it("matches control names case-insensitively, whole", () => {
    assert.equal(score([entry({ verb: "add", entity: "contact", controls: ["  NEW   contact "] })], TRUTH).tp, 1);
    assert.equal(score([entry({ verb: "add", entity: "contact", controls: ["Save and close"] })], TRUTH).tp, 0);
  });
  it("is deterministic: the same input gives the same score", () => {
    const es = [entry({ verb: "create", entity: "contact", controls: ["Save"] }), entry({ verb: "read", entity: "contact", urls: ["list"] })];
    assert.deepEqual(score(es, TRUTH), score(es, TRUTH));
  });
  it("lenient (diagnostic) drops entity and verb, and a bare page no longer finds every feature on it", () => {
    const es = [entry({ label: "page" }), entry({ label: "left alone", verb: "delete", entity: "ana", controls: ["Delete Ana"] })];
    assert.equal(score(es, TRUTH).tp, 0);
    const l = score(es, TRUTH, { lenient: true });
    assert.equal(l.lenient, true);
    assert.equal(l.tp, 1);
    assert.equal(l.perFeature.find((f) => f.id === "delete")!.matched, true);
    assert.equal(l.perFeature.find((f) => f.id === "create")!.matched, false);
  });
});
