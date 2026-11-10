// The understanding run on this machine, checked without a browser or a real AI:
//   node --test cli/understand.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ScanResult } from "@contextmachines/scanner";
import type { AskJson } from "../packages/understanding/src/features/describe.ts";
import { understand } from "./understand.ts";

const ORIGIN = "https://app.example";
const page = (t: number, path: string, title: string, buttons: string[] = []) => ({ t, kind: "page", path, snapshot: { title, headings: [title], forms: [], buttons: buttons.map((label) => ({ label })), frames: [] } });
/** A button pressed on a screen, and the save it sent. */
const press = (t: number, path: string, label: string, api: string) => [
  { t, kind: "interaction", type: "click", tag: "button", label, path },
  { t: t + 1, kind: "network", method: "POST", path: api, queryKeys: [], fields: {}, durationMs: 3, trigger: { type: "click", tag: "button", label, page: path } },
];
/** Saving a client twice and an invoice once: by the learner's presses alone, "Save client" is the busiest save. */
function run(clientSaves = 2, more: Partial<ScanResult> = {}): ScanResult {
  const events = [
    { t: 0, kind: "route", path: "/" },
    page(1, "/", "Home"),
    page(2, "/invoices/new", "New invoice", ["Save invoice"]),
    ...press(3, "/invoices/new", "Save invoice", "/api/invoices"),
    page(10, "/clients/new", "New client", ["Save client"]),
    ...Array.from({ length: clientSaves }, (_, i) => press(11 + i * 2, "/clients/new", "Save client", "/api/clients")).flat(),
    // Plumbing the product makes on its own: never an action people take.
    { t: 500, kind: "network", method: "POST", path: "/api/track", queryKeys: [], fields: {}, durationMs: 1 },
  ];
  return { pagesVisited: ["/", "/invoices/new", "/clients/new"], events, blockedWrites: [], errors: [], stoppedBy: "complete", loggedIn: false, foundByButtons: [], startOrigin: ORIGIN, screens: [], findings: [], timings: {}, errorPages: [], invalidEvents: 0, ...more } as unknown as ScanResult;
}

/** An AI that reads the invoice as the main thing, and counts how often it was asked. */
function fakeAi(answer: object | string = reading()): AskJson & { asked: number } {
  const ai = { model: "fake", asked: 0, ask: async () => {
    ai.asked++;
    return { text: typeof answer === "string" ? answer : JSON.stringify(answer), costUsd: 0.01 };
  } };
  return ai;
}
function reading() {
  return {
    product: "An invoicing tool for small businesses.",
    features: [{ id: "/invoices", purpose: "Bill clients.", howTo: "Fill in New invoice and press Save invoice.", value: "core", why: "Invoices are what it is for." }],
    actions: [{ id: "invoice.create", name: "Save invoice", does: "Saves a new invoice." }],
    main_action: { id: "invoice.create", why: "Invoices are what it is for." },
    prerequisites: [{ action: "invoice.create", requires: "client.create", why: "An invoice is for a client." }],
    flows: [{ name: "Bill a new client", screens: ["/clients/new", "/invoices/new"] }],
  };
}

const jpeg = (n = 10) => Buffer.from([0xff, 0xd8, 0xff, ...Array<number>(n).fill(0)]);
const shot = (path: string, photo: Buffer, boxes: unknown[] = [{ label: "Save", kind: "button", x: 1, y: 2, w: 3, h: 4 }]) => ({ path, width: 1280, height: 800, jpeg: photo, boxes });

describe("understand, without an AI", () => {
  it("takes the main action from the learner's presses, and reads nothing", async () => {
    const u = await understand(run(), { origin: ORIGIN, now: 1 });
    assert.equal(u.understanding.mainAction?.id, "client.create");
    assert.equal(u.understanding.mainAction?.source, "traffic");
    assert.equal(u.understanding.product, null);
    assert.deepEqual(u.understanding.prerequisites, []);
    assert.deepEqual(u.understanding.flows, []);
    assert.equal(u.readingReused, false);
    assert.equal(u.readingError, undefined);
  });

  it("lists the actions people take, leaving the product's own plumbing out", async () => {
    const u = await understand(run(), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.actions.map((a) => a.id).sort(), ["client.create", "invoice.create"]);
    assert.ok(u.site.actions.some((a) => a.path === "/api/track"), "the site model still keeps it");
  });

  it("keeps the plumbing apart, to say what the stopped saves were", async () => {
    const u = await understand(run(), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.plumbing.map((a) => a.request.path), ["/api/track"]);
  });

  it("folds a tab into its screen: the action, the controls and the listing all say the screen", async () => {
    const scan = run(1);
    scan.events.push(page(20, "/settings", "Settings", ["General"]) as never, page(21, "/settings/~team", "Team", ["Invite"]) as never, ...(press(22, "/settings/~team", "Invite", "/api/invites") as never[]));
    const u = await understand(scan, { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.shown.find((s) => s.path === "/settings")?.views, [{ path: "/settings/~team", name: "team" }]);
    assert.ok(!u.shown.some((s) => s.path === "/settings/~team"));
    assert.equal(u.screenOf("/settings/~team"), "/settings");
    assert.equal(u.screenOf("/settings"), "/settings");
    assert.deepEqual(u.actions.find((a) => a.request.path === "/api/invites")?.pages, ["/settings"]);
    assert.deepEqual(u.controls["/settings"]?.buttons, ["General", "Invite"]);
    assert.equal(u.controls["/settings/~team"], undefined);
  });

  it("knows each screen's buttons (one entry each, hidden ones apart) and the words of its links", async () => {
    const scan = run(2, { screens: [shot("/", jpeg(), [{ label: "Sign up free", kind: "link", x: 1, y: 2, w: 3, h: 4 }, { label: "Email", kind: "field", x: 1, y: 9, w: 3, h: 4 }])] as ScanResult["screens"] });
    scan.events.push(page(20, "/settings", "Settings", ["Add", "Add"]) as never);
    (scan.events.at(-1) as unknown as { snapshot: { buttons: { label: string; hidden?: true }[] } }).snapshot.buttons.push({ label: "Menu item", hidden: true });
    const u = await understand(scan, { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.controls["/"], { buttons: [], links: ["Sign up free"] }, "a field's label is no control");
    assert.deepEqual(u.controls["/settings"], { buttons: ["Add", "Add"], links: ["Menu item"] });
  });

  it("groups the features around the main action, with no purposes and no people", async () => {
    const u = await understand(run(), { origin: ORIGIN, now: 1 });
    const clients = u.features.find((f) => f.id === "/clients");
    assert.equal(clients?.core, true);
    assert.equal(clients?.purpose, undefined);
    // A learner run has no real people: nobody's use is counted.
    assert.ok(u.features.every((f) => f.usage.people === 0));
  });

  it("leaves out an event the site model would refuse, and keeps the rest", async () => {
    const scan = run();
    (scan.events as unknown[]).push({ t: 600, kind: "page", path: "", snapshot: {} });
    const u = await understand(scan, { origin: ORIGIN, now: 1 });
    assert.equal(u.site.pages.length, 3);
  });

  it("refuses a run that started on another site, rather than mixing its screens in", async () => {
    await assert.rejects(understand(run(), { origin: "https://other.example", now: 1 }), /started at https:\/\/app\.example, not https:\/\/other\.example/);
  });

  it("keeps pages on another address apart from the site's own", async () => {
    const scan = run();
    (scan.events as unknown[]).push(page(700, "//help.example/faq", "FAQ"));
    const u = await understand(scan, { origin: ORIGIN, now: 1 });
    assert.ok(u.site.pages.some((p) => p.path === "//help.example/faq"));
    assert.ok(u.site.pages.some((p) => p.path === "/clients/new"), "the site's own pages keep plain paths");
  });
});

describe("understand, with an AI", () => {
  it("lets the AI's reading choose the main action, while the learner's presses are few", async () => {
    const ai = fakeAi();
    const u = await understand(run(), { origin: ORIGIN, ai, now: 1 });
    assert.equal(ai.asked, 1);
    assert.equal(u.understanding.product, "An invoicing tool for small businesses.");
    assert.equal(u.understanding.mainAction?.id, "invoice.create");
    assert.equal(u.understanding.mainAction?.source, "ai");
    assert.match(u.understanding.mainAction?.reason ?? "", /^the AI's reading of the product: /);
    assert.deepEqual(u.understanding.prerequisites, [{ action: "invoice.create", requires: "client.create", why: "An invoice is for a client.", source: "ai" }]);
    assert.deepEqual(u.understanding.flows, [{ name: "Bill a new client", screens: ["/clients/new", "/invoices/new"] }]);
    // The AI's main action is the core feature, and its purpose and action names are kept.
    assert.equal(u.features.find((f) => f.core)?.id, "/invoices");
    assert.equal(u.features.find((f) => f.id === "/invoices")?.purpose?.purpose, "Bill clients.");
    assert.equal(u.actions.find((a) => a.id === "invoice.create")?.does, "Saves a new invoice.");
  });

  it("walks the journey only where the learner saw a way between its screens", async () => {
    const seen = await understand(run(2, { links: { "/clients/new": ["/invoices/new"] } }), { origin: ORIGIN, ai: fakeAi(), now: 1 });
    assert.equal(seen.understanding.flows.length, 1);
    const unseen = await understand(run(2, { links: { "/invoices/new": ["/clients/new"] } }), { origin: ORIGIN, ai: fakeAi(), now: 1 });
    assert.deepEqual(unseen.understanding.flows, []);
  });

  it("keeps the learner's choice once one save was pressed often enough for use to decide", async () => {
    const u = await understand(run(20), { origin: ORIGIN, ai: fakeAi(), now: 1 });
    assert.equal(u.understanding.mainAction?.id, "client.create");
    assert.equal(u.understanding.mainAction?.source, "traffic");
    assert.equal(u.understanding.product, "An invoicing tool for small businesses.", "the rest of the reading still counts");
  });

  it("ignores a main action the AI made up", async () => {
    const u = await understand(run(), { origin: ORIGIN, ai: fakeAi({ ...reading(), main_action: { id: "invoice.delete", why: "?" } }), now: 1 });
    assert.equal(u.understanding.mainAction?.id, "client.create");
  });

  it("says why a reading failed, and still answers with what the learner saw", async () => {
    const u = await understand(run(), { origin: ORIGIN, ai: fakeAi("not json"), now: 1 });
    assert.equal(u.readingError, "the answer wasn't JSON");
    assert.equal(u.understanding.product, null);
    assert.equal(u.understanding.mainAction?.source, "traffic");
    assert.equal(u.actions.length, 2);
  });

  it("reuses the last reading of an unchanged product, and asks again once it changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understand-"));
    try {
      const readingCache = join(dir, "nested", ".reading.json");
      const first = fakeAi();
      const a = await understand(run(), { origin: ORIGIN, ai: first, readingCache, now: 1 });
      const second = fakeAi({});
      const b = await understand(run(), { origin: ORIGIN, ai: second, readingCache, now: 2 });
      assert.equal(second.asked, 0);
      assert.equal(b.readingReused, true);
      assert.deepEqual(b.understanding, a.understanding);
      // A new screen is a changed product: read afresh.
      const changed = run();
      (changed.events as unknown[]).push(page(800, "/reports", "Reports"));
      const third = fakeAi();
      const c = await understand(changed, { origin: ORIGIN, ai: third, readingCache, now: 3 });
      assert.equal(third.asked, 1);
      assert.equal(c.readingReused, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never keeps a failed reading to reuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understand-"));
    try {
      const readingCache = join(dir, ".reading.json");
      await understand(run(), { origin: ORIGIN, ai: fakeAi("not json"), readingCache, now: 1 });
      const next = fakeAi();
      const u = await understand(run(), { origin: ORIGIN, ai: next, readingCache, now: 2 });
      assert.equal(next.asked, 1);
      assert.equal(u.readingReused, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("understand, screens", () => {
  it("keeps each screen's photo and where things sit on it", async () => {
    const u = await understand(run(1, { screens: [shot("/", jpeg())] as ScanResult["screens"] }), { origin: ORIGIN, now: 5 });
    assert.equal(u.screens.length, 1);
    assert.deepEqual(u.screens[0]?.meta, { path: "/", takenAt: 5, width: 1280, height: 800, boxes: [{ label: "Save", kind: "button", x: 1, y: 2, w: 3, h: 4 }] });
    assert.ok(u.screens[0]?.jpeg.equals(jpeg()));
  });

  it("skips a photo that isn't a JPEG, is too large or has an odd address, without failing", async () => {
    const screens = [shot("/a", Buffer.from("PNG...")), shot("/b", jpeg(1_000_001)), shot("no-slash", jpeg()), shot("/ok", jpeg())];
    const u = await understand(run(1, { screens } as Partial<ScanResult>), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.screens.map((s) => s.meta.path), ["/ok"]);
  });

  it("keeps the photo but drops boxes that don't fit their shape", async () => {
    const u = await understand(run(1, { screens: [shot("/", jpeg(), [{ label: "Save", kind: "button", x: -5, y: 0, w: 1, h: 1 }])] } as Partial<ScanResult>), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.screens[0]?.meta.boxes, []);
  });

  it("keeps the later photo of a screen photographed twice, in its first place", async () => {
    const later = Buffer.concat([jpeg(), Buffer.from([1])]);
    const u = await understand(run(1, { screens: [shot("/", jpeg()), shot("/x", jpeg()), shot("/", later)] } as Partial<ScanResult>), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.screens.map((s) => s.meta.path), ["/", "/x"]);
    assert.ok(u.screens[0]?.jpeg.equals(later));
  });
});

describe("what the site wrote, on its way to the AI and map.json", () => {
  const start = "https://app.example/s?token=tok_sEcReT123&sig=bypass1";
  const echoing = () => run(2, { events: [
    { t: 0, kind: "route", path: "/" },
    { t: 1, kind: "page", path: "/", snapshot: { title: `Home of ${start}`, headings: ["Shared with you", `Invite https://app.example/invite/INVITETOKENabc123def456`], forms: [], buttons: [{ label: `Copy ${start}` }], frames: [] } },
  ] as unknown as ScanResult["events"] });
  it("has no secret left when a title or heading echoes the address", async () => {
    let asked = "";
    const ai: AskJson = { model: "fake", ask: async (_s, q) => ((asked += q), { text: JSON.stringify(reading()) }) };
    const u = await understand(echoing(), { origin: ORIGIN, ai, now: 1 });
    const page = u.site.pages[0]!.snapshot;
    assert.equal(page.title, "Home of https://app.example/s?token=REDACTED&sig=REDACTED");
    assert.equal(page.headings[1], "Invite https://app.example/invite/:id");
    assert.equal(page.buttons[0]?.label, "Copy https://app.example/s?token=REDACTED&sig=REDACTED");
    assert.doesNotMatch(JSON.stringify(u.shown), /tok_sEcReT123|bypass1|INVITETOKEN/);
    assert.doesNotMatch(asked, /tok_sEcReT123|bypass1|INVITETOKEN/, "the AI's question");
  });
  it("leaves the site's plain words as they were", async () => {
    const u = await understand(run(), { origin: ORIGIN, now: 1 });
    assert.equal(u.site.pages.find((p) => p.path === "/invoices/new")?.snapshot.title, "New invoice");
  });
});

describe("one name for an action", () => {
  it("gives the main action the name the actions list gives it, even with no label on screen", async () => {
    const scan = run(0, { events: [
      { t: 0, kind: "route", path: "/" },
      page(1, "/", "Home"),
      { t: 2, kind: "network", method: "POST", path: "/submit", queryKeys: [], fields: {}, durationMs: 3 },
    ] as unknown as ScanResult["events"] });
    const bare = await understand(scan, { origin: ORIGIN, now: 1 });
    const id = bare.site.actions.find((a) => a.path === "/submit")!.id;
    assert.equal(bare.site.actions.find((a) => a.id === id)?.uiLabel, undefined);
    const answer = { ...reading(), actions: [{ id, name: "Submit a story", does: "Posts a story." }], main_action: { id, why: "It is what the site is for." }, prerequisites: [], flows: [] };
    const u = await understand(scan, { origin: ORIGIN, ai: fakeAi(answer), now: 1 });
    assert.equal(u.understanding.mainAction?.label, "Submit a story");
    assert.equal(u.actions.concat(u.plumbing).find((a) => a.id === id)?.name, "Submit a story");
  });
  it("keeps the label on screen when the AI gave no name", async () => {
    const u = await understand(run(), { origin: ORIGIN, ai: fakeAi({ ...reading(), actions: [] }), now: 1 });
    assert.equal(u.understanding.mainAction?.label, "Save invoice");
  });
});

describe("where a link goes", () => {
  const shot = (boxes: object[]) => ({ path: "/", width: 800, height: 600, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0x00]), boxes });
  it("counts as words for judging, by its path, on another host too", async () => {
    const box = { label: "Create one", kind: "link", x: 0, y: 0, w: 9, h: 9, href: "https://www.app.example/signup?ref=login" };
    const u = await understand(run(2, { screens: [shot([box])] } as Partial<ScanResult>), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.controls["/"]?.links, ["Create one", "/signup"]);
  });
  it("doesn't read a query that only points back at sign-up, and a photo keeps its boxes with an address on them", async () => {
    const box = { label: "Sign in", kind: "link", x: 0, y: 0, w: 9, h: 9, href: "/login?next=/register" };
    const u = await understand(run(2, { screens: [shot([box])] } as Partial<ScanResult>), { origin: ORIGIN, now: 1 });
    assert.deepEqual(u.controls["/"]?.links, ["Sign in", "/login"]);
    assert.equal(u.screens[0]?.meta.boxes.length, 1);
  });
});

describe("addresses that are no screen of their own", () => {
  /** A page as the snippet reads it: what's drawn, and a title that can say anything. */
  const screen = (t: number, path: string, title: string, headings: string[], fields: string[] = [], buttons: string[] = []) => ({ t, kind: "page", path, snapshot: { title, headings, forms: fields.length ? [{ fields: fields.map((name) => ({ name, type: "text", required: false })), submitLabels: [] }] : [], buttons: buttons.map((label) => ({ label })), frames: [] } });
  const scanOf = (events: object[], pagesVisited: string[], drawn: Record<string, string>, more: Partial<ScanResult> = {}) => run(0, { events: [{ t: 0, kind: "route", path: "/" }, ...events], pagesVisited, drawn, ...more } as Partial<ScanResult>);
  const wall = ["Email", "Password"];

  it("gives a retired route that falls through to the sign-in page no part of its own, whatever its title says", async () => {
    const scan = scanOf([screen(1, "/", "Sign in | Acme", ["Welcome back"], wall, ["Sign in"]), screen(2, "/privacy", "Privacy Policy | Acme", ["Welcome back"], wall, ["Sign in"]), screen(3, "/terms", "Terms | Acme", ["Terms of use"])], ["/", "/privacy", "/terms"], { "/": "aaa", "/privacy": "aaa", "/terms": "bbb" });
    const seen = await understand(scan, { origin: ORIGIN });
    assert.deepEqual(seen.shown.map((s) => s.path).sort(), ["/", "/terms"]);
    assert.ok(!seen.site.pages.some((p) => p.path === "/privacy"));
    assert.ok(!seen.site.routes.some((r) => r.path === "/privacy"));
    assert.ok(!seen.features.some((f) => JSON.stringify(f).includes("/privacy")), "no part of its own");
    assert.deepEqual(seen.shown.find((s) => s.path === "/")!.views, [{ path: "/privacy", name: "/privacy" }]);
    assert.equal(seen.screenOf("/privacy"), "/");
  });

  it("keeps two records that share a layout: alike in headings and controls, but drawing different things", async () => {
    const scan = scanOf([screen(1, "/", "Reports", ["Reports"]), screen(2, "/reports/a", "Report", ["Report"], [], ["Export"]), screen(3, "/reports/b", "Report", ["Report"], [], ["Export"])], ["/", "/reports/a", "/reports/b"], { "/": "x", "/reports/a": "aaa", "/reports/b": "bbb" });
    assert.equal((await understand(scan, { origin: ORIGIN })).shown.length, 3);
  });

  it("keeps two pages that drew the same words with different controls, and pages with nothing to compare", async () => {
    const different = scanOf([screen(1, "/", "Home", ["Home"], [], ["Open"]), screen(2, "/b", "Home", ["Home"], [], ["Close"])], ["/", "/b"], { "/": "aaa", "/b": "aaa" });
    assert.equal((await understand(different, { origin: ORIGIN })).shown.length, 2);
    const unread = scanOf([screen(1, "/", "A", ["Same"]), screen(2, "/b", "B", ["Same"])], ["/", "/b"], {});
    assert.equal((await understand(unread, { origin: ORIGIN })).shown.length, 2);
  });

  it("never matches a screen the made-up user saw with what a visitor saw", async () => {
    const both = scanOf([screen(1, "/", "App", ["Welcome"]), screen(2, "/other", "App", ["Welcome"])], ["/", "/other"], { "/": "aaa", "/other": "aaa" }, { seenWith: { "/other": "stand-in" } });
    assert.ok((await understand(both, { origin: ORIGIN })).shown.some((s) => s.path === "/other"));
  });

  it("doesn't list an address the app only passed through on its way back to the sign-in", async () => {
    // Read at /deals, still drawing the form: the app went there and its guard sent it straight back.
    const scan = scanOf([screen(1, "/", "Pipeline", ["Pipeline"]), screen(2, "/login", "Pipeline", ["Sign in to Pipeline"], wall, ["Sign in"]), screen(3, "/deals", "Pipeline", ["Sign in to Pipeline"], wall, ["Sign in"])], ["/", "/login"], { "/": "aaa", "/login": "bbb" });
    const seen = await understand(scan, { origin: ORIGIN });
    assert.deepEqual(seen.shown.map((s) => s.path).sort(), ["/", "/login"]);
    assert.equal(seen.shown.find((s) => s.path === "/login")!.views, undefined);
    assert.equal(seen.screenOf("/deals"), "/login");
  });

  it("keeps a screen reached by a press and never opened, when it drew something of its own", async () => {
    const scan = scanOf([screen(1, "/", "Pipeline", ["Pipeline"]), screen(2, "/deals", "Pipeline", ["Deals"], [], ["Add deal"])], ["/"], { "/": "aaa" });
    assert.ok((await understand(scan, { origin: ORIGIN })).shown.some((s) => s.path === "/deals"));
  });

  it("tells the reading that what's drawn beats the title", async () => {
    let system = "";
    const ai = { model: "fake", ask: async (asked: string) => ((system = asked), { text: JSON.stringify(reading()), costUsd: 0 }) };
    await understand(run(), { origin: ORIGIN, ai });
    assert.match(system, /what is drawn is what the page is/);
  });
});
