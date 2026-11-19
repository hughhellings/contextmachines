// Masked pictures of the screen for the AI (wave1-plan.md section 5), offline: real Chromium on
// setContent pages, no network. Every field that could hold a secret is black in the very bytes that
// would be sent (checked here by the test's own decode, in a blank page of its own); any doubt gives
// no picture; and a run that keeps no pictures sends none to the AI.
//   node --test cli/shot.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { runTest } from "../packages/scanner/src/tester/run.ts";
import { BLACK_MAX, drawnShare, maskedShot, mustMask, ShotDesk, type Box } from "../packages/scanner/src/tester/shot.ts";
import type { Action, DecideInput, JudgeInput, TesterBrain } from "../packages/scanner/src/tester/types.ts";
import { startFixtureSite, type FixtureSite } from "./bench/site.ts";

const PLANTED = "Planted-Secret-9431";

/** The test's own decode: each box's share of near-black pixels, inset 3 px, in a page of the test's own. */
async function darkness(browser: Browser, jpeg: Buffer, boxes: readonly Box[]): Promise<number[]> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(async ({ b64, boxes, max }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const g = cv.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      return boxes.map((b) => {
        const d = g.getImageData(b.x + 3, b.y + 3, b.width - 6, b.height - 6).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! <= max && d[i + 1]! <= max && d[i + 2]! <= max) n++;
        return n / (d.length / 4);
      });
    }, { b64: jpeg.toString("base64"), boxes: [...boxes], max: BLACK_MAX });
  } finally {
    await context.close();
  }
}

describe("a masked picture of the screen", () => {
  let browser: Browser;
  let page: Page;
  let desk: ShotDesk;
  before(async () => {
    browser = await launch(false);
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await context.route("**/*", (route) => route.abort());
    page = await context.newPage();
    desk = new ShotDesk(browser);
  });
  after(async () => {
    await desk?.close();
    await browser?.close().catch(() => {});
  });
  const mask = makeMasker({ token: PLANTED });

  it("blacks out a filled password, a field holding a run's value, a one-time code and a card number: each box at least 98% black in the bytes sent", async () => {
    await page.setContent(`<body style="background:#fff;font:20px sans-serif">
      <label>Password <input id="a" type="password" value="hunter2-long-password" style="width:300px;height:40px"></label><br>
      <label>Note <input id="b" type="text" style="width:300px;height:40px;color:#000;background:#fff"></label><br>
      <label>Code <input id="c" autocomplete="one-time-code" value="123456" style="width:300px;height:40px"></label><br>
      <label>Card <input id="d" autocomplete="cc-number" value="4242424242424242" style="width:300px;height:40px"></label><br>
      <label>Search <input id="e" type="search" value="cats" style="width:300px;height:40px"></label>
      <canvas width="400" height="200" style="background:#fc0"></canvas></body>`);
    await page.fill("#b", PLANTED);
    const shot = await maskedShot(page, { mask, anySecret: true, desk });
    assert.ok("jpeg" in shot, "none" in shot ? shot.none : "");
    assert.ok(shot.jpeg.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG");
    assert.equal(shot.boxes.length, 4, "the search box holding no secret is left as it is");
    const shares = await darkness(browser, shot.jpeg, shot.boxes);
    for (const s of shares) assert.ok(s >= 0.98, `a box is ${Math.round(s * 100)}% black`);
    assert.equal(mustMask({ type: "search", autocomplete: "", said: "Search", value: "cats" }, mask), false);
    assert.equal(mustMask({ type: "text", autocomplete: "", said: "Your PIN", value: "" }, mask), true);
  });

  it("a page that shows a run's secret as text gives no picture", async () => {
    await page.setContent(`<p>Signed in as ${PLANTED}</p><canvas width="400" height="300"></canvas>`);
    const shot = await maskedShot(page, { mask, anySecret: true, desk });
    assert.ok("none" in shot);
    assert.match(shot.none, /a secret might show/);
  });

  it("a visible frame, while the run holds a secret, gives no picture (its fields can't be listed)", async () => {
    await page.setContent(`<p>Pay here</p><iframe src="https://pay.example.test/" width="400" height="200"></iframe>`);
    const shot = await maskedShot(page, { mask, anySecret: true, desk });
    assert.ok("none" in shot);
    assert.match(shot.none, /frame/);
    assert.ok("jpeg" in (await maskedShot(page, { mask: (s) => s, anySecret: false, desk })), "with no secret in the run, a frame is fine");
  });

  it("a field removed between reading the boxes and the photo gives no picture", async () => {
    await page.setContent(`<input id="p" type="password" value="hunter2-long-password" style="width:300px;height:40px">`);
    const shot = await maskedShot(page, { mask, anySecret: true, desk, between: () => page.evaluate(() => document.getElementById("p")!.remove()) });
    assert.ok("none" in shot);
    assert.match(shot.none, /changed while it was photographed/);
  });

  it("a JPEG whose box isn't black is refused by the check", async () => {
    await page.setContent(`<body style="background:#fff"><input id="p" type="password" value="hunter2-long-password" style="width:300px;height:40px"></body>`);
    const box = await page.locator("#p").boundingBox();
    const plain = await page.screenshot({ type: "jpeg", quality: 70, scale: "css" });
    const boxes = [{ x: Math.floor(box!.x), y: Math.floor(box!.y), width: Math.ceil(box!.width), height: Math.ceil(box!.height) }];
    assert.match((await desk.refuses(plain, boxes))!, /isn't blacked out/);
    assert.equal(await desk.refuses(await desk.make(await page.screenshot({ type: "png", scale: "css" }), boxes), boxes), undefined);
  });

  it("a canvas page with no secrets gives a picture with no boxes, and the canvas covers enough of the screen to be worth one", async () => {
    await page.setContent(`<canvas id="c" width="600" height="400"></canvas><script>const g=c.getContext("2d");g.fillStyle="#36c";g.fillRect(50,100,80,250);</script>`);
    const shot = await maskedShot(page, { mask: (s) => s, anySecret: false, desk });
    assert.ok("jpeg" in shot);
    assert.deepEqual(shot.boxes, []);
    assert.ok((await page.evaluate(drawnShare)) >= 0.15);
  });
});

describe("a run that keeps no pictures sends none to the AI", () => {
  let site: FixtureSite;
  let browser: Browser;
  let dir: string;
  before(async () => {
    site = await startFixtureSite();
    browser = await launch(false);
    dir = mkdtempSync(join(tmpdir(), "cm-shot-test-"));
  });
  after(async () => {
    await browser?.close().catch(() => {});
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Clicks "Show sales", says done, and counts every picture it is handed (actor and judge). */
  const counting = (seen: { images: number; asks: number }): TesterBrain => ({
    sees: true,
    async plan() {
      return [{ title: "Show the sales chart", intent: "Click Show sales", check: { kind: "judged", claim: "The chart shows 3 bars" } }];
    },
    async decide(input: DecideInput): Promise<Action> {
      seen.asks++;
      if (input.image) seen.images++;
      const show = /\[(e\d+)\] button "Show sales"/.exec(input.snapshot)?.[1];
      return show && !input.history.length ? { type: "click", ref: show } : { type: "done" };
    },
    async judge(input: JudgeInput) {
      seen.asks++;
      if (input.image) seen.images++;
      return { reasoning: "", evidence: [], verdict: "not_sure" };
    },
  });

  it("with images on, the chart's run sends some; with noMedia, or a run that types a --var, none", async () => {
    const url = new URL("/jd/chart", site.url).href;
    const on = { images: 0, asks: 0 };
    await runTest({ goal: "Show the sales chart and check it has 3 bars", url, dir: join(dir, "on"), browser, visitor: true, brain: counting(on) });
    assert.ok(on.images >= 1, "a picture is sent where one helps");
    const off = { images: 0, asks: 0 };
    await runTest({ goal: "Show the sales chart and check it has 3 bars", url, dir: join(dir, "off"), browser, visitor: true, brain: counting(off), noMedia: true });
    const typed = { images: 0, asks: 0 };
    await runTest({ goal: "Show the sales chart for {who} and check it has 3 bars", url, dir: join(dir, "var"), browser, vars: { who: "Ada Test" }, brain: counting(typed) });
    assert.ok(off.asks >= 2 && typed.asks >= 2, "the AI was asked");
    assert.equal(off.images + typed.images, 0);
  });
});
