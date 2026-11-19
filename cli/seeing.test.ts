// W5, seeing the real page (any-site plan section 11): closed shadow roots, shadow-aware text checks,
// numbers for onclick/tabindex rows, a field found again after a redraw, point presses on a picture,
// the picture rule (decision J), and a run's language and time zone. A real browser on the local zoo
// server and small local pages; no AI, no network.
//   node --test cli/seeing.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { act, refind, type ActContext } from "../packages/scanner/src/tester/act.ts";
import { verify } from "../packages/scanner/src/tester/check.ts";
import { compact, markClickable, observe, type Snapshot, type SnapTarget } from "../packages/scanner/src/tester/observe.ts";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch, placeOptions, record } from "../packages/scanner/src/tester/record.ts";
import { actionProblem, HUMAN_CHECK_WORDS, NO_PICTURE_POINT, NO_POINT_HUMAN_CHECK, outlineContradicts, queuedNext, sameIn } from "../packages/scanner/src/tester/run.ts";
import { seeShadowRoots } from "../packages/scanner/src/tester/shadow.ts";
import { PICTURES_FALLBACK_MAX, PICTURES_PER_TEST } from "../packages/scanner/src/tester/shot.ts";
import type { Action } from "../packages/scanner/src/tester/types.ts";
import { actionFrom, actQuestion, ACTION_SCHEMA, ACT_SYSTEM, placeFrom, placeLine } from "./test-command.ts";
import { startZoo, type ZooServer } from "./bench/zoo/server.ts";
import type { Twin } from "./bench/zoo/kit.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let browser: Browser;
let zoo: ZooServer;
const dirs: string[] = [];
before(async () => {
  browser = await launch();
  zoo = await startZoo({ filesDir: mkdtempSync(join(tmpdir(), "cm-w5-files-")) });
});
after(async () => {
  await zoo?.close();
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh zoo instance open in a tab, the tester's way (shadow roots opened) or not. */
async function open(pageId: string, twin: Twin = "task", o: { tester?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext; inst: ReturnType<ZooServer["open"]> }> {
  const inst = zoo.open(pageId, twin, 1000 + 7);
  const ctx = await browser.newContext();
  if (o.tester !== false) await seeShadowRoots(ctx);
  const page = await ctx.newPage();
  await page.goto(zoo.startUrl(inst));
  await page.locator("#host").waitFor({ state: "visible" }).catch(() => {});
  return { page, ctx, inst };
}

const actCtx = (page: Page, start: string): ActContext => ({ page, start, allowHosts: ["127.0.0.1"], values: { vars: {}, given: "" }, mask: makeMasker(), offSite: () => undefined });
const refOf = (snap: Snapshot, role: string, name: RegExp) => [...snap.refs.values()].find((t) => t.role === role && name.test(t.name));

describe("closed shadow roots", () => {
  it("the tester's browser numbers a form inside a closed shadow root; a plain browser sees none of it", async () => {
    const plain = await open("closed-shadow", "task", { tester: false });
    const seen = await open("closed-shadow");
    try {
      const before = await observe(plain.page);
      const after = await observe(seen.page);
      const v = seen.inst.v;
      assert.ok(!refOf(before, "button", new RegExp(`^${v.labels.save}$`)), "closed: the save button isn't in a plain outline");
      assert.ok(refOf(after, "button", new RegExp(`^${v.labels.save}$`)), `opened: the save button is numbered\n${after.text}`);
      assert.ok(refOf(after, "textbox", new RegExp(v.labels.name, "i")) || refOf(after, "spinbutton", /./), "its fields are numbered");
    } finally {
      await plain.ctx.close();
      await seen.ctx.close();
    }
  });

  it("a text check reads the words inside shadow roots (the list), not only body.innerText", async () => {
    const { page, ctx, inst } = await open("closed-shadow");
    try {
      const seeded = inst.records[0]!.name;
      await page.getByText(seeded).first().waitFor({ timeout: 5000 });
      assert.equal((await page.evaluate(() => document.body.innerText)).includes(seeded), false, "body.innerText misses it");
      assert.equal((await verify(page, { kind: "text_visible", text: seeded }, 2000)).ok, true);
      assert.equal((await verify(page, { kind: "text_visible", text: "Nothing like this anywhere" }, 0)).ok, false);
    } finally {
      await ctx.close();
    }
  });

  it("words typed into a box inside a shadow root don't make a text check hold, and hidden shadow words don't count", async () => {
    const ctx = await browser.newContext();
    await seeShadowRoots(ctx);
    const page = await ctx.newPage();
    try {
      await page.setContent(`<x-note></x-note><x-gone></x-gone><script>
customElements.define("x-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<p>Drawn here</p><textarea></textarea>"; } });
customElements.define("x-gone", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = "<p style='display:none'>Secretly hidden</p>"; } });
</script>`);
      await page.locator("x-note textarea").fill("Typed by the test");
      assert.equal((await verify(page, { kind: "text_visible", text: "Drawn here" }, 0)).ok, true);
      assert.equal((await verify(page, { kind: "text_visible", text: "Typed by the test" }, 0)).ok, false);
      assert.equal((await verify(page, { kind: "text_visible", text: "Secretly hidden" }, 0)).ok, false);
    } finally {
      await ctx.close();
    }
  });
});

describe("div soup: onclick and tabindex rows", () => {
  it("marks a plain row whose words are a clickable element's, and no other", () => {
    const yaml = ['- generic [ref=e2]:', '  - generic [ref=e3]: Save entry', '  - generic [ref=e4]: Plain words', '  - generic [ref=e5]:', '    - text: Next', '    - text: step'].join("\n");
    const out = markClickable(yaml, ["Save entry", "Next step"]);
    assert.match(out, /e3\] \[cursor=pointer\]: Save entry/);
    assert.match(out, /e5\] \[cursor=pointer\]:/);
    assert.doesNotMatch(out, /e4\] \[cursor=pointer\]/);
    const snap = compact(out);
    assert.ok([...snap.refs.values()].some((t) => t.role === "item" && t.name === "Save entry"));
  });

  it("the div-soup page's options and its save <div> get numbers, and a press on them works", async () => {
    const { page, ctx, inst } = await open("div-soup");
    try {
      const v = inst.v;
      const snap = await observe(page);
      const opt = refOf(snap, "item", new RegExp(`^${v.choice}$`));
      const save = refOf(snap, "item", new RegExp(`^${v.labels.save}$`));
      assert.ok(opt && save, `numbered:\n${snap.text}`);
      const c = actCtx(page, zoo.startUrl(inst));
      const name = refOf(snap, "textbox", /./)!;
      assert.ok(!("error" in (await act(c, { type: "fill", ref: name.ref, value: v.name }, name))));
      assert.ok(!("error" in (await act(c, { type: "click", ref: opt.ref }, opt))));
      const r = await act(c, { type: "click", ref: save.ref }, save);
      assert.ok(!("error" in r) && !("blocked" in r), JSON.stringify(r));
      await page.waitForFunction(() => Number(document.body.dataset.zdone || 0) > 0);
      assert.ok(inst.records.some((x) => x.name === v.name && x.choice === v.choice), "the server kept it");
    } finally {
      await ctx.close();
    }
  });
});

describe("a field drawn again since the look", () => {
  it("a number gone stale is found again by role and name when it was and is the only one", async () => {
    const { page, ctx, inst } = await open("redraw-noid");
    try {
      const v = inst.v;
      const snap = await observe(page);
      const name = [...snap.refs.values()].find((t) => t.role === "textbox" && t.same === 1 && new RegExp(v.labels.name, "i").test(t.name));
      assert.ok(name, `the name field:\n${snap.text}`);
      // The page draws everything again every 1.5 s: the number from that look is gone.
      await page.waitForTimeout(1700);
      assert.equal(await page.locator(`aria-ref=${name.ref}`).count(), 0, "the old number is gone");
      assert.ok(await refind(page, name), "found again by role and name");
      const r = await act(actCtx(page, zoo.startUrl(inst)), { type: "fill", ref: name.ref, value: v.name }, name);
      assert.ok(!("error" in r) && !("blocked" in r), JSON.stringify(r));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => (document.querySelector("[data-k=name]") as HTMLInputElement).value), v.name);
      // Never one of several, never one with no name.
      assert.equal(await refind(page, { ...name, same: 2 }), undefined);
      assert.equal(await refind(page, { ...name, nth: 1 }), undefined);
      assert.equal(await refind(page, { ...name, name: "" }), undefined);
    } finally {
      await ctx.close();
    }
  });

  it("a queued action whose element was redrawn goes to the one with the same role and name", () => {
    const t = (ref: string, name: string, same = 1, around = "form"): SnapTarget => ({ ref, role: "textbox", name, nth: 0, same, around });
    const asked = new Map([["e5", t("e5", "Title")], ["e6", t("e6", "Pages")]]);
    const now = new Map([["e15", t("e15", "Title")], ["e16", t("e16", "Pages")]]);
    const snap = { url: "http://x/", refs: now } as Pick<Snapshot, "refs" | "url">;
    const next = queuedNext([{ type: "fill", ref: "e6", value: "300" }], "http://x/", snap, false, { refs: asked });
    assert.deepEqual(next, { type: "fill", ref: "e16", value: "300" });
    // Two with that name now (or then): dropped, the AI asked again.
    const twice = new Map([...now, ["e17", t("e17", "Pages", 2)]]);
    twice.set("e16", t("e16", "Pages", 2));
    assert.equal(queuedNext([{ type: "fill", ref: "e6", value: "300" }], "http://x/", { url: "http://x/", refs: twice }, false, { refs: asked }), undefined);
    assert.equal(sameIn(t("e6", "Pages", 2), now), undefined);
    // The same name with something else around it (another record's row): dropped too.
    assert.equal(sameIn(t("e6", "Pages", 1, "another row"), now), undefined);
    assert.equal(sameIn({ ...t("e6", "Pages"), around: undefined }, now), undefined);
  });

  it("a fill whose page redraws the field on each key reaches the field with no id (its label)", async () => {
    const { page, ctx, inst } = await open("redraw-noid");
    try {
      const v = inst.v;
      // A field that suggests (a list attribute) is typed key by key; the page redraws it on every key.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("[data-k]")) el.setAttribute("aria-autocomplete", "list");
      });
      const snap = await observe(page);
      const notes = [...snap.refs.values()].find((t) => t.role === "textbox" && new RegExp(v.labels.notes, "i").test(t.name))!;
      const r = await act(actCtx(page, zoo.startUrl(inst)), { type: "fill", ref: notes.ref, value: "ab" }, notes);
      assert.ok(!("error" in r), JSON.stringify(r));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => (document.querySelector("[data-k=notes]") as HTMLTextAreaElement).value), "ab", "both keys reached the field");
    } finally {
      await ctx.close();
    }
  });
});

describe("a phone layout", () => {
  it("a Save under a bar fixed on the screen says so, and names the bar, not the page", async () => {
    const inst = zoo.open("mobile-sheet", "task", 1000 + 7);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    try {
      await page.goto(zoo.startUrl(inst));
      await page.click("#menu");
      await page.click("#new");
      await page.locator("textarea").first().focus();
      const snap = await observe(page);
      const save = refOf(snap, "button", new RegExp(`^${inst.v.labels.save}$`))!;
      const r = await act(actCtx(page, zoo.startUrl(inst)), { type: "click", ref: save.ref }, save);
      assert.ok("error" in r && /covered by a bar fixed on the screen \("Cook faster in the app/.test(r.error) && /Not now/.test(r.error), JSON.stringify(r));
    } finally {
      await ctx.close();
    }
  });
});

describe("point presses on a picture", () => {
  it("click_at is an action the AI may give, read from its answer, and only with a picture in the step", () => {
    assert.ok((ACTION_SCHEMA.properties.action.enum as readonly string[]).includes("click_at"));
    assert.match(ACT_SYSTEM, /click_at \{x, y, what\}: only when a picture/);
    assert.deepEqual(actionFrom({ action: "click_at", x: 120, y: 340, what: "Back" }), { type: "click_at", x: 120, y: 340, what: "Back" });
    assert.equal(actionProblem({ type: "click_at", x: 1, y: 2, what: "Back" }, { refs: new Map() }), undefined);
    assert.match(actionProblem({ type: "click_at", x: 1, y: 2, what: "" }, { refs: new Map() })!, /needs what/);
    assert.match(actionProblem({ type: "click_at", x: "a", y: 2 }, { refs: new Map() })!, /needs x and y/);
    assert.match(NO_PICTURE_POINT, /none came in this step/);
  });

  it("a press at a point picks what is drawn there; a named control there is pressed by its number instead", async () => {
    const { page, ctx, inst } = await open("canvas-point");
    try {
      const v = inst.v;
      const box = (await page.locator("canvas").boundingBox())!;
      const i = v.skin.choices.indexOf(v.choice);
      const x = box.x + (i % 3) * 180 + 90;
      const y = box.y + Math.floor(i / 3) * 160 + 80;
      const c = actCtx(page, zoo.startUrl(inst));
      const r = await act(c, { type: "click_at", x, y, what: v.choice });
      assert.ok("done" in r, JSON.stringify(r));
      assert.equal((r as { done: { type: string; name: string } }).done.type, "click_at");
      assert.match(r.label, /^Clicking at \(\d+, \d+\) on '.*map'/i);
      // The page's own save, pressed by a point: refused, it has a number.
      const save = (await page.locator("#save").boundingBox())!;
      const s = await act(c, { type: "click_at", x: save.x + 5, y: save.y + 5, what: "Save" });
      assert.ok("error" in s && /press it by its number/.test(s.error), JSON.stringify(s));
      // Off the screen: refused.
      const off = await act(c, { type: "click_at", x: 5000, y: 5, what: v.choice });
      assert.ok("error" in off && /isn't on the screen/.test(off.error));
      // The pick is real: saved through the page's own button.
      await page.locator(`#${v.css}-name, [id$="-name"]`).first().fill(v.name);
      await page.click("#save");
      await page.waitForFunction(() => Number(document.body.dataset.zdone || 0) > 0);
      assert.ok(inst.records.some((x2) => x2.name === v.name && x2.choice === v.choice));
    } finally {
      await ctx.close();
    }
  });

  it("a point on something drawn that reads like paying is refused, as its button would be", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.setContent(`<canvas aria-label="Buy now" width="300" height="200" style="display:block"></canvas>`);
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", x: 50, y: 50, what: "a map" });
      assert.ok("blocked" in r, JSON.stringify(r));
    } finally {
      await ctx.close();
    }
  });
});

describe("the picture rule (decision J)", () => {
  const snap = (text: string, o: { hidden?: number; usable?: number } = {}) => ({ text, hidden: o.hidden ?? 0, usable: new Set(Array.from({ length: o.usable ?? 3 }, (_, i) => `e${i}`)) });
  it("contradicts only when the step names things, the whole outline was shown, and none of them is in it", () => {
    assert.equal(outlineContradicts(snap('[e1] button "Save"'), 'Pick "Back" on the map'), true);
    assert.equal(outlineContradicts(snap('[e1] button "Save"\n[e2] item "Back"'), 'Pick "Back" on the map'), false);
    assert.equal(outlineContradicts(snap('[e1] button "Save"', { hidden: 4 }), 'Pick "Back"'), false, "a cut outline proves nothing");
    assert.equal(outlineContradicts(snap('[e1] button "Save"'), "Pick back on the map"), false, "nothing named");
    assert.equal(outlineContradicts(snap("", { usable: 0 }), 'Pick "Back"'), false, "an empty outline is its own case");
  });
  it("past the usual 6, at most 12 pictures", () => {
    assert.equal(PICTURES_PER_TEST, 6);
    assert.equal(PICTURES_FALLBACK_MAX, 12);
  });
});

describe("a run's language and time zone", () => {
  it("--locale and --timezone are checked, and only the person's own are passed to the browser", () => {
    assert.deepEqual(placeFrom("de-de", "Europe/Berlin"), { place: { locale: "de-DE", timezone: "Europe/Berlin" } });
    assert.deepEqual(placeFrom(), {});
    assert.match((placeFrom("not a tag") as { error: string }).error, /isn't a language tag/);
    assert.match((placeFrom(undefined, "Mars/Olympus") as { error: string }).error, /isn't a time zone/);
    assert.deepEqual(placeOptions({ locale: "ar-EG" }), { locale: "ar-EG" });
    assert.deepEqual(placeOptions(), {});
  });
  it("the actor is told the place, with how a number is written there; nothing when none is set", () => {
    const line = placeLine({ locale: "de-DE", timezone: "Europe/Berlin" });
    assert.match(line, /language de-DE, time zone Europe\/Berlin/);
    assert.match(line, /1\.234,5/);
    const input = { goal: "g", step: { title: "t", intent: "i", check: { kind: "none" as const } }, n: 1, of: 1, url: "http://x/", title: "x", snapshot: "", history: [], vars: [] };
    assert.match(actQuestion({ ...input, place: { locale: "de-DE" } }), /The browser is set as a person with language de-DE/);
    assert.doesNotMatch(actQuestion(input), /The browser is set as a person/);
  });
  it("a recording browser has the place's language and clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-w5-rec-"));
    dirs.push(dir);
    const rec = await record(dir, browser, { noMedia: true, place: { locale: "de-DE", timezone: "Asia/Tokyo" } });
    try {
      const got = await rec.page.evaluate(() => ({ lang: navigator.language, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      assert.deepEqual(got, { lang: "de-DE", zone: "Asia/Tokyo" });
    } finally {
      await rec.finish();
    }
  });
});

void (null as unknown as Action);

// W5 review fixes: each finding of the review, shown on a small local page (no AI, nothing real).
describe("W5 review: a point press meets every deny rule around it", () => {
  /** A page whose presses are counted, not sent anywhere: window.sent lists them. */
  async function local(html: string): Promise<{ page: Page; ctx: BrowserContext }> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await seeShadowRoots(ctx);
    const page = await ctx.newPage();
    await page.setContent(`<script>window.sent=[];window.send=(w)=>window.sent.push(w);</script>${html}`);
    return { page, ctx };
  }
  const sent = (page: Page) => page.evaluate(() => (window as unknown as { sent: string[] }).sent);
  const at = async (page: Page, sel: string) => {
    const b = (await page.locator(sel).first().boundingBox())!;
    return { x: Math.round(b.x + Math.min(20, b.width / 2)), y: Math.round(b.y + Math.min(20, b.height / 2)) };
  };

  it("a canvas with 'Delete all my data' drawn on it: refused by the words the AI says it sees; refused with no words given", async () => {
    const { page, ctx } = await local(`<canvas id=c width=400 height=200></canvas><script>const g=c.getContext('2d');g.fillText('Delete all my data',60,110);c.onclick=()=>send('delete')</script>`);
    try {
      const p = await at(page, "#c");
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, what: "Delete all my data" });
      assert.ok("blocked" in r, JSON.stringify(r));
      const none = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, what: "" });
      assert.ok("error" in none && /needs what/.test(none.error), JSON.stringify(none));
      assert.deepEqual(await sent(page), []);
    } finally {
      await ctx.close();
    }
  });

  it("an icon inside <div onclick> 'Delete account': refused by the words of the box the click reaches", async () => {
    const { page, ctx } = await local(`<div id=d onclick="send('delete')" style="display:inline-flex;gap:8px;padding:10px;margin:80px"><svg width=40 height=40><rect width=40 height=40 fill=red /></svg><span>Delete account</span></div>`);
    try {
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", ...(await at(page, "svg")), what: "a red square" });
      assert.ok("blocked" in r, JSON.stringify(r));
      assert.deepEqual(await sent(page), []);
    } finally {
      await ctx.close();
    }
  });

  it("an icon in the closed shadow root of <x-trash role=button aria-label='Delete account'>: the host is read", async () => {
    const { page, ctx } = await local(`<x-trash role=button aria-label="Delete account" style="display:inline-block;margin:80px"></x-trash><script>
customElements.define('x-trash', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'closed'}).innerHTML='<svg width=40 height=40><rect width=40 height=40 fill=red /></svg>'; this.addEventListener('click',()=>send('delete')); } });</script>`);
    try {
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", ...(await at(page, "x-trash")), what: "a red square" });
      assert.ok("blocked" in r, JSON.stringify(r));
      assert.deepEqual(await sent(page), []);
    } finally {
      await ctx.close();
    }
  });

  it("an innocent icon inside a named clickable box: pressed by its number, never by a point", async () => {
    const { page, ctx } = await local(`<div onclick="send('open')" style="display:inline-flex;padding:10px;margin:80px"><svg width=40 height=40><rect width=40 height=40 /></svg><span>Open report</span></div>`);
    try {
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", ...(await at(page, "svg")), what: "a square" });
      assert.ok("error" in r && /press it by its number/.test(r.error), JSON.stringify(r));
      assert.deepEqual(await sent(page), []);
    } finally {
      await ctx.close();
    }
  });

  it("'Buy now £49' drawn on a canvas labelled 'Store': refused; in a run that may pay, no point press at all", async () => {
    const { page, ctx } = await local(`<canvas id=c width=300 height=120 aria-label="Store"></canvas><script>c.getContext('2d').fillText('Buy now £49',40,60);c.onclick=()=>send('buy')</script>`);
    try {
      const p = await at(page, "#c");
      const r = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, what: "Buy now £49" });
      assert.ok("blocked" in r, JSON.stringify(r));
      const pay = { ...actCtx(page, "about:blank"), pay: { owned: [], finalPresses: { n: 0 } } } as unknown as ActContext;
      const q = await act(pay, { type: "click_at", ...p, what: "a shop" });
      assert.ok("error" in q && /may pay/.test(q.error), JSON.stringify(q));
      assert.deepEqual(await sent(page), []);
    } finally {
      await ctx.close();
    }
  });

  it("a saved point is replayed only with words to check and on the same screen size", async () => {
    const { page, ctx } = await local(`<canvas id=c width=300 height=120 aria-label="Muscle map"></canvas><canvas id=n width=100 height=100></canvas><script>c.onclick=()=>send('map');n.onclick=()=>send('n')</script>`);
    try {
      const p = await at(page, "#c");
      const ok = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, name: "Muscle map", vw: 1280, vh: 800 });
      assert.ok("done" in ok, JSON.stringify(ok));
      const size = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, name: "Muscle map", vw: 390, vh: 844 });
      assert.ok("error" in size && /screen/.test(size.error), JSON.stringify(size));
      const blank = await act(actCtx(page, "about:blank"), { type: "click_at", ...(await at(page, "#n")), name: "", vw: 1280, vh: 800 });
      assert.ok("error" in blank && /no words/.test(blank.error), JSON.stringify(blank));
      assert.deepEqual(await sent(page), ["map"]);
      // A fresh press saves the screen's size and the words it read.
      const fresh = await act(actCtx(page, "about:blank"), { type: "click_at", ...p, what: "Back" });
      assert.ok("done" in fresh);
      assert.deepEqual((fresh as { done: unknown }).done, { type: "click_at", ...p, name: "Muscle map", what: "Back", vw: 1280, vh: 800 });
    } finally {
      await ctx.close();
    }
  });

  it("the canvas-point trap twin's drawn 'Delete all' is refused by its words; the page wipes nothing", async () => {
    const { page, ctx, inst } = await open("canvas-point", "trap");
    try {
      const b = (await page.locator("canvas[id$=-tools]").boundingBox())!;
      const r = await act(actCtx(page, zoo.startUrl(inst)), { type: "click_at", x: Math.round(b.x + 100), y: Math.round(b.y + 28), what: "🗑 Delete all" });
      assert.ok("blocked" in r, JSON.stringify(r));
      assert.ok(!inst.ledger.some((j) => j.op === "delete"));
    } finally {
      await ctx.close();
    }
  });
});

describe("W5 review: a redrawn element is found again only where the same is around it", () => {
  it("'Approve' redrawn in another record's row is not pressed", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.setContent(`<script>window.sent=[]</script><div id=list><div class=row><b>Request #1 (made by this test)</b> <button onclick="sent.push(1)">Approve</button></div></div>
<script>window.swap=(n,who)=>{list.innerHTML='<div class=row><b>Request #'+n+' ('+who+')</b> <button onclick="sent.push('+n+')">Approve</button></div>';}</script>`);
      const snap = await observe(page);
      const t = [...snap.refs.values()].find((x) => x.role === "button" && x.name === "Approve")!;
      assert.ok(t.around, "what is around it is kept");
      await page.evaluate(() => (window as unknown as { swap: (n: number, w: string) => void }).swap(2, "a real customer"));
      const r = await act(actCtx(page, "about:blank"), { type: "click", ref: t.ref }, t);
      assert.ok("error" in r && /gone from the page/.test(r.error), JSON.stringify(r));
      // The same row drawn again (same words around it): found again.
      await page.evaluate(() => (window as unknown as { swap: (n: number, w: string) => void }).swap(1, "made by this test"));
      const again = await act(actCtx(page, "about:blank"), { type: "click", ref: t.ref }, t);
      assert.ok("done" in again, JSON.stringify(again));
      assert.deepEqual(await page.evaluate(() => (window as unknown as { sent: number[] }).sent), [1]);
    } finally {
      await ctx.close();
    }
  });
});

describe("W5 review: a table row whose button comes first", () => {
  it("'Approve' first in a row redrawn for another record (its cells after it differ) is not pressed", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.setContent(`<script>window.sent=[]</script><table><tbody id=b><tr><td><button onclick="sent.push(1)">Approve</button></td><td>Request #1</td></tr></tbody></table>
<script>window.swap=()=>{b.innerHTML='<tr><td><button onclick="sent.push(2)">Approve</button></td><td>Request #2</td></tr>';}</script>`);
      const snap = await observe(page);
      const t = [...snap.refs.values()].find((x) => x.role === "button" && x.name === "Approve")!;
      await page.evaluate(() => (window as unknown as { swap: () => void }).swap());
      const r = await act(actCtx(page, "about:blank"), { type: "click", ref: t.ref }, t);
      assert.ok("error" in r, JSON.stringify(r));
      assert.deepEqual(await page.evaluate(() => (window as unknown as { sent: number[] }).sent), []);
    } finally {
      await ctx.close();
    }
  });
});

describe("W5 review: the picture rule, the queue and human checks", () => {
  const snap = (text: string) => ({ text, hidden: 0, usable: new Set(["e1", "e2"]) });
  it("a quoted value to type is no contradiction; a quoted thing to press is", () => {
    const form = snap('[e1] textbox "Name"\n[e2] button "Save"');
    assert.equal(outlineContradicts(form, 'Fill in the name Type "Leg day 7" into the Name box'), false);
    assert.equal(outlineContradicts(form, 'Add a workout named "Leg day"'), false);
    assert.equal(outlineContradicts(form, 'Search for "shoes"'), false);
    assert.equal(outlineContradicts(form, 'Click "Export"'), true);
    assert.equal(outlineContradicts(form, 'the "Export" button'), true);
    assert.equal(outlineContradicts(form, 'Click "Save"'), false);
  });
  it("a point press is never queued, nor anything after one", () => {
    const s = { url: "http://x/", refs: new Map() } as Pick<Snapshot, "refs" | "url">;
    assert.equal(queuedNext([{ type: "click_at", x: 1, y: 2, what: "Back" }], "http://x/", s, false), undefined);
  });
  it("a page or a stuck reason that names a human check: no picture to get past it, no point press", () => {
    assert.match("Please verify you are human", HUMAN_CHECK_WORDS);
    assert.match("Slide to verify", HUMAN_CHECK_WORDS);
    assert.match("stuck: there's a reCAPTCHA", HUMAN_CHECK_WORDS);
    assert.doesNotMatch("Pick a muscle on the map", HUMAN_CHECK_WORDS);
    assert.match(NO_POINT_HUMAN_CHECK, /human check/);
  });
});

describe("W5 review: only the row drawn where the clickable box is gets a number", () => {
  it("a plain 'Next step' elsewhere stays plain words", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.setContent(`<p>Read this first</p><div><div>Next step</div></div><div tabindex=0 onclick="1">Next step</div>`);
      const s = await observe(page);
      const items = [...s.refs.values()].filter((t) => t.name === "Next step");
      assert.equal(items.length, 1, s.text);
    } finally {
      await ctx.close();
    }
  });
});
