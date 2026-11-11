import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, pad, page, quick, serve } from "./precision-site.ts";

/**
 * "Does nothing" is the bluntest thing the learner can say about a button, so every way a working
 * button can look idle is a false alarm to rule out. One button here really does nothing, and must
 * still be reported.
 */
const css = `<style>.drop{position:relative;display:inline-block}.drop .menu{display:none;position:absolute;background:#eee;padding:8px}.drop:focus-within .menu{display:block}</style>`;
const nothing = (r: ScanResult) => r.findings.filter((f) => f.kind === "does_nothing").map((f) => f.target);
let tools: ScanResult;
let twins: ScanResult;
let choosing: ScanResult;
let naming: ScanResult;
let slow: ScanResult;

beforeAll(async () => {
  const site = await serve((_req, res) => html(res, page("Tools", `<h1>Tools</h1>${pad}
    <div class=drop><button>Account menu</button><div class=menu><a href="/profile">Profile</a></div></div>
    <button onclick="var c=new AudioContext();var o=c.createOscillator();o.connect(c.destination);o.start();o.stop(c.currentTime+.05)">Test sound</button>
    <input type=file id=pick hidden><button onclick="document.getElementById('pick').click()">Import file</button>
    <button>Really dead</button>`, css)));
  tools = await scanSite({ ...quick, startUrl: `http://localhost:${site}/`, maxPages: 2, maxDurationMs: 60_000 });

  // Buttons that quietly return until something is chosen, as bulk actions and add-to-baskets do.
  const chooser = await serve((_req, res) => html(res, page("Rows", `<h1>Rows</h1>${pad}
    <form onsubmit="return false"><table><tr><td><input type=checkbox name=ids value=1></td><td>Row one</td></tr><tr><td><input type=checkbox name=ids value=2></td><td>Row two</td></tr></table>
    <button type=button onclick="var s=[...this.form.querySelectorAll('input:checked')];if(!s.length)return;fetch('/archive',{method:'POST',body:JSON.stringify(s.map(x=>x.value))}).then(()=>this.form.remove())">Archive these</button></form>
    <form onsubmit="return false"><label><input type=radio name=size value=s> Small</label><label><input type=radio name=size value=l> Large</label>
    <button type=button onclick="var s=this.form.querySelector('[name=size]:checked');if(!s)return;fetch('/cart',{method:'POST',body:s.value})">Add to basket</button></form>
    <form onsubmit="return false"><select id=plan><option value="">Choose a plan</option><option value=pro>Pro</option></select>
    <button type=button onclick="if(!document.getElementById('plan').value)return;fetch('/plan',{method:'POST',body:'{}'})">Change plan</button></form>`)));
  choosing = await scanSite({ ...quick, startUrl: `http://localhost:${chooser}/`, maxPages: 1, maxDurationMs: 60_000 });

  // Its box and its button far apart on the page, with nothing to tie them together.
  const bulk = await serve((_req, res) => html(res, page("Bulk", `<h1>Bulk</h1>${pad}<div><input type=checkbox aria-label="Pick row"></div><div id=bar><button>Delete selected</button></div>`)));
  naming = await scanSite({ ...quick, startUrl: `http://localhost:${bulk}/`, maxPages: 1, maxDurationMs: 60_000 });

  // Three buttons with one label, in an order that changes per load; only the blue one works.
  const order = [["blue", "alert('Pressed')"], ["green", ""], ["yellow", ""]] as const;
  let loads = 0;
  const shuffled = await serve((_req, res) => {
    const turn = loads++ % 3;
    const buttons = [...order.slice(turn), ...order.slice(0, turn)].map(([c, on]) => `<button class="${c}" onclick="${on}">Button</button>`).join(" ");
    html(res, page("Class", `<h1>Class</h1>${pad}${buttons}`));
  });
  twins = await scanSite({ ...quick, startUrl: `http://localhost:${shuffled}/` });

  // A page that takes seconds to load, with buttons that do nothing: the budget, not the buttons, sets the time.
  const delayed = await serve((_req, res, url) => void setTimeout(() => html(res, page(`Slow ${url.pathname}`, `<h1>Slow</h1>${pad}${[1, 2, 3, 4].map((n) => `<button>Dead ${n}</button>`).join(" ")}`)), 2500));
  slow = await scanSite({ ...quick, startUrl: `http://localhost:${delayed}/`, maxPages: 1, maxDurationMs: 120_000 });
}, 240_000);

afterAll(closeAll);

describe("does_nothing", () => {
  it("still reports a button that really does nothing", () => {
    expect(nothing(tools)).toContain("Really dead");
  });

  it("not a menu shown on focus", () => {
    expect(nothing(tools)).not.toContain("Account menu");
  });

  it("not a sound", () => {
    expect(nothing(tools)).not.toContain("Test sound");
  });

  it("not one that opens a file picker", () => {
    expect(nothing(tools)).not.toContain("Import file");
  });

  it("not a button waiting for a tick, a choice or a pick from a list", () => {
    expect(nothing(choosing)).toEqual([]);
  });

  it("never one that names a selection while boxes are unticked", () => {
    expect(nothing(naming)).toEqual([]);
  });

  it("not a label several controls share", () => {
    expect(twins.findings).toEqual([]);
  });

  it("spends a bounded time confirming on one page", () => {
    // All four dead, confirmed at 2.5s a load plus a few seconds' looking, would be over 20s of it.
    expect(nothing(slow).length).toBeGreaterThan(0);
    expect(nothing(slow).length).toBeLessThan(4);
  });
});
