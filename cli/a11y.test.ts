// The accessibility scan (packages/scanner/src/tester/a11y.ts): eight measured rules, no AI, no extra
// library. A real browser on pages set in place or served by a route to a made-up host: no network.
//   node --test cli/a11y.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { A11Y_MAX_PAGES, A11Y_PER_KIND, a11yLine, a11ySummary, A11yLog, pagePath, scanPage, unnamedInTree, type A11yKind, type A11yPageScan } from "../packages/scanner/src/tester/a11y.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { masker } from "../packages/scanner/src/tester/run.ts";

// The planted and clean pages live beside the bench's fixture site, which serves them too.
export { CLEAN_PAGE, PLANTED, PLANTED_PAGE } from "./bench/a11y-pages.ts";
import { CLEAN_PAGE, ICON, PLANTED, PLANTED_PAGE } from "./bench/a11y-pages.ts";

const countBy = (s: A11yPageScan) => {
  const c: Partial<Record<A11yKind, number>> = {};
  for (const f of s.findings) c[f.kind] = (c[f.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(s.more) as [A11yKind, number][]) c[k] = (c[k] ?? 0) + n;
  return c;
};

let browser: Browser;
const pageWith = async (html: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
};

before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

describe("the accessibility scan", () => {
  it("finds exactly the planted counts for each of the 8 kinds, and none of the traps", async () => {
    const page = await pageWith(PLANTED_PAGE);
    const s = await scanPage(page, (x) => x);
    assert.equal(s.error, undefined);
    assert.deepEqual(countBy(s), PLANTED, JSON.stringify(s.findings, null, 1));
    const what = s.findings.map((f) => `${f.kind}: ${f.what}`).join("\n");
    assert.doesNotMatch(what, /terms/, "the link inside a sentence isn't a small target");
    assert.doesNotMatch(what, /g1/, "ids inside an svg's defs don't count");
    assert.match(what, /heading_order: h2 then h4 "Images"/);
    assert.match(what, /no_name: button #close/);
    assert.match(what, /img_no_alt: image\n/, "an inline image source isn't printed");
    assert.match(what, /placeholder_only: textbox with placeholder "Your email"/);
    assert.match(what, /duplicate_id: id "dup" \(2 times\)/);
    assert.match(what, /small_target: button "Bold" \(16x16\)/);
    for (const f of s.findings) {
      assert.ok(f.what.length <= 60);
      assert.match(f.wcag, /^WCAG \d|^best practice \(WCAG 4\.1\.1 was removed/);
    }
    assert.ok(s.ms < 1500, `took ${s.ms} ms`);
    await page.close();
  });

  it("finds nothing on a clean page", async () => {
    const page = await pageWith(CLEAN_PAGE);
    const s = await scanPage(page, (x) => x);
    assert.deepEqual(s.findings, [], JSON.stringify(s.findings, null, 1));
    assert.deepEqual(s.more, {});
    await page.close();
  });

  it("is read-only: focus, scroll and the page's own state are unchanged", async () => {
    const page = await pageWith(`${PLANTED_PAGE}<script>window.clicks=0;document.addEventListener('click',()=>window.clicks++,true);document.addEventListener('focusin',()=>window.clicks+=100,true);</script>`);
    const before = await page.evaluate(() => ({ y: scrollY, active: document.activeElement?.tagName, html: document.documentElement.outerHTML.length }));
    await scanPage(page, (x) => x);
    const after = await page.evaluate(() => ({ y: scrollY, active: document.activeElement?.tagName, html: document.documentElement.outerHTML.length, clicks: (window as unknown as { clicks: number }).clicks }));
    assert.deepEqual(after, { ...before, clicks: 0 });
    await page.close();
  });

  it("masks every word it reports: a planted value in a control's name shows as {name}", async () => {
    const secret = "hunter2-very-secret";
    const page = await pageWith(`<html lang="en"><body><h1>x</h1><button class="t" style="width:16px;height:16px;padding:0" aria-label="Pay ${secret}"></button><button style="width:16px;height:16px;padding:0" aria-label="b"></button><input placeholder="${secret}"></body></html>`);
    const s = await scanPage(page, masker({ name: secret }));
    assert.doesNotMatch(JSON.stringify(s), /hunter2/);
    const what = s.findings.map((f) => f.what).join("\n");
    assert.match(what, /button "Pay \{name\}"/);
    assert.match(what, /placeholder "\{name\}"/);
    await page.close();
  });

  it("keeps at most 10 of one kind on a page, and counts the rest", async () => {
    const page = await pageWith(`<html lang="en"><body><h1>x</h1>${Array.from({ length: 13 }, () => '<img width="30" height="30" src="' + ICON + '">').join("")}</body></html>`);
    const s = await scanPage(page, (x) => x);
    assert.equal(s.findings.filter((f) => f.kind === "img_no_alt").length, A11Y_PER_KIND);
    assert.deepEqual(s.more, { img_no_alt: 3 });
    const log = new A11yLog();
    log.scans.push(s);
    assert.equal(log.summary(), "13 issues on 1 page: 13 images with no text alternative");
    await page.close();
  });

  it("only trusts a missing name that Chromium's own accessibility tree agrees with", async () => {
    assert.deepEqual([...unnamedInTree('- generic [ref=e1]:\n  - button [ref=e3]\n  - button "Save" [ref=e4]\n  - link:\n    - /url: "#"\n  - tab\n  - textbox "Email" [ref=e8] [box=1,2,3,4]').entries()], [["generic", 1], ["button", 1], ["link", 1], ["tab", 1]]);
    const page = await pageWith(`<html lang="en"><body><h1>x</h1><button style="width:40px;height:40px"></button><button style="width:40px;height:40px;margin:30px"></button></body></html>`);
    // The tree passed in names one of the two: only one stays.
    const s = await scanPage(page, (x) => x, { tree: '- button [ref=e1]\n- button "Named by the browser" [ref=e2]' });
    assert.equal(s.findings.filter((f) => f.kind === "no_name").length, 1);
    await page.close();
  });

  it("stops at its element limit and says so", async () => {
    const page = await pageWith(`<html lang="en"><body><h1>x</h1>${"<div>a</div>".repeat(50)}<img width="30" height="30" src="${ICON}"></body></html>`);
    const s = await scanPage(page, (x) => x, { maxElements: 20 });
    assert.equal(s.cut, true);
    assert.equal(countBy(s).img_no_alt, undefined, "the image past the limit wasn't walked");
    const log = new A11yLog();
    log.scans.push(s);
    assert.match(log.summary(), /only scanned for the first 5,000 elements/);
    await page.close();
  });

  it("gives up on a page that takes too long, and says why", async () => {
    const page = await pageWith(PLANTED_PAGE);
    // The page's own script holds the main thread for 2.5 seconds.
    await page.evaluate(() => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 2500); }, 0); });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const s = await scanPage(page, (x) => x, { timeoutMs: 400 });
    assert.ok(Date.now() - t0 < 1500, `gave up in ${Date.now() - t0} ms`);
    assert.match(s.error ?? "", /took too long \(over 0\.4 seconds\)/);
    assert.deepEqual(s.findings, []);
    const log = new A11yLog();
    log.scans.push(s);
    assert.deepEqual(log.result().failed, [{ page: s.page, why: s.error }]);
    await new Promise((r) => setTimeout(r, 2600));
    await page.close();
  });

  it("never throws: a closed page is a failed scan", async () => {
    const page = await pageWith(CLEAN_PAGE);
    await page.close();
    const s = await scanPage(page, (x) => x);
    assert.match(s.error ?? "", /couldn't be scanned/);
  });
});

describe("the pages a run reaches", () => {
  it("scans each path once, at most 20 pages, with no query and no token in the path", async () => {
    const context = await browser.newContext();
    await context.route("http://a11y.test/**", (route) => route.fulfill({ contentType: "text/html", body: CLEAN_PAGE }));
    const page = await context.newPage();
    const log = new A11yLog(masker({ who: "alice@corp.example" }));
    await page.goto("http://a11y.test/p/0?session=abc");
    assert.ok(await log.scan(page));
    await page.goto("http://a11y.test/p/0?other=1");
    assert.equal(await log.scan(page), undefined, "the same path again isn't scanned");
    for (let k = 1; k < 25; k++) {
      await page.goto(`http://a11y.test/p/${k}`);
      await log.scan(page);
    }
    assert.equal(log.scans.length, A11Y_MAX_PAGES);
    assert.equal(log.result().pages, 20);
    assert.equal(log.summary(), "No accessibility issues found on 20 pages");
    assert.equal(a11yLine(log.result()), "Accessibility: no accessibility issues found on 20 pages");
    assert.equal(log.scans[0]!.page, "/p/0");
    await context.close();

    assert.equal(pagePath("https://x.test/verify/abc123def456ghi789jkl012?t=1", (s) => s), "/verify/{token}");
    assert.equal(pagePath("https://x.test/u/alice@corp.example/settings", masker({ who: "alice@corp.example" })), "/u/{who}/settings");
  });

  it("sums pages into one line for the terminal and one sentence for reports", async () => {
    const page = await pageWith(PLANTED_PAGE);
    const log = new A11yLog();
    await log.scan(page);
    assert.equal(await log.scan(page), undefined, "about:blank again is the same path");
    // A second, clean page, added by hand.
    log.scans.push({ page: "/clean", findings: [], more: {}, ms: 1 });
    const r = log.result();
    assert.equal(r.pages, 2);
    assert.equal(a11ySummary(r), "15 issues on 2 pages: 3 controls with no name, 2 images with no text alternative, 1 page with no language set, 2 form fields with no label, 1 field labelled only by its placeholder, 1 heading problem, 2 ids used more than once, 3 targets smaller than 24 by 24 pixels");
    assert.equal(a11yLine(r), "Accessibility: 15 issues on 2 pages (see the report)");
    assert.equal(a11ySummary({ pages: 0, findings: [] }), "No pages were scanned for accessibility");
    await page.close();
  });
});
