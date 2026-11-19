// W3 proof on the zoo, with no AI: each page's scripted solve, then the proof the run would make
// (proof.ts proveWrite: the values fixed before the press, a fresh navigation after it). Every task
// and trap twin is proved kept; every broken twin whose bug is "not kept" (a silent failure, a row
// on screen only, an optimistic row, a 200 with an error body, a rollback, a restored draft sent,
// a rename never sent, a switch the server refused, a wishlist heart that sends nothing) never is.
//   node --test cli/proof-zoo.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser } from "playwright";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { proveWrite, quotedIn, readPlain, urlKey, WriteWatch, type ProofAct } from "../packages/scanner/src/tester/proof.ts";
import type { Twin, ZooPage } from "./bench/zoo/kit.ts";
import { startZoo, ZOO_PAGES, zooOracle, type ZooServer } from "./bench/zoo/server.ts";
import { dSeed } from "./bench/zoo/bench.ts";

let browser: Browser;
let zoo: ZooServer;
before(async () => {
  browser = await launch();
  zoo = await startZoo({ filesDir: mkdtempSync(join(tmpdir(), "cm-proof-zoo-files-")) });
});
after(async () => {
  await zoo?.close();
  await browser?.close();
});

/** What the run's own record of actions would say for a page's solve (the proof never sees the solve). */
function actsFor(page: ZooPage, twin: Twin, goal: string): ProofAct[] | undefined {
  const q = quotedIn(goal);
  const fill = (seq: number, value: string): ProofAct => ({ seq, type: "fill", role: "textbox", name: "Name", value });
  const press = (seq: number, name: string): ProofAct => ({ seq, type: "click", role: "button", name });
  switch (page.id) {
    case "autosave":
      return [{ seq: 1, type: "click", role: "switch", name: q[0]! }];
    case "one-click":
      if (twin === "trap") return [{ seq: 1, type: "select", role: "combobox", name: "Item", value: q[0]! }, { seq: 2, type: "click", role: "radio", name: "Buy" }, press(3, "Save")];
      return [press(1, "Add to wishlist")];
    case "undo-delete":
      if (twin === "trap") return undefined;
      return [fill(1, q[0]!), press(2, "Add"), { seq: 3, type: "fill", role: "textbox", name: "Rename", value: q[1]! }, { seq: 4, type: "press", key: "Enter" }];
    case "enter-submit":
      return [fill(1, q[0]!), { seq: 2, type: "press", key: "Enter" }];
    case "wizard":
      return [fill(1, q[0]!), press(2, "Next"), press(3, "Finish")];
    // Integration: a move and a setting, as the run records them (W4 drag, slide).
    case "drag-board":
      return [{ seq: 1, type: "drag", role: "listitem", name: q[0]! }];
    case "slider":
      return [{ seq: 1, type: "slide", role: "slider", name: q[0]!, value: "25" }, press(2, "Save settings")];
    case "react-input":
      // The name and the notes, both quoted by the goal: both must show kept.
      return [fill(1, q[0]!), { seq: 2, type: "fill", role: "textbox", name: "Notes", value: q[1]! }, press(3, "Save")];
    default:
      return [fill(1, q[0]!), press(2, "Save")];
  }
}

/** Pages whose change is a move or a setting (W4): the proof can't count it. */
const MOVED = new Set(["drag-board", "slider"]);

/** Broken twins whose bug is that the change isn't kept: the proof must never hold there. */
const NOT_KEPT = new Set(["react-input", "silent-fail", "enter-submit", "wizard", "autosave", "one-click", "undo-delete", "optimistic", "rollback", "draft", "refusal"]);

async function proved(page: ZooPage, twin: Twin, seed: number, o: { endOnList?: boolean } = {}) {
  const inst = zoo.open(page.id, twin, seed, page.skin);
  const goal = page.goal({ v: inst.v, twin, filesDir: inst.filesDir });
  const acts = actsFor(page, twin, goal);
  if (!acts) return undefined;
  const ctx = await browser.newContext();
  try {
    const tab = await ctx.newPage();
    await tab.goto(zoo.startUrl(inst));
    await tab.locator("#host").waitFor({ state: "visible" }).catch(() => undefined);
    await tab.waitForTimeout(600);
    const onSite = (u: string) => u.startsWith(zoo.url);
    const readings = [{ seq: 0, url: urlKey(tab.url()), text: await readPlain(tab) }];
    const writes = new WriteWatch(tab, onSite);
    // Every request of the solve is the last press's (the save).
    writes.begin(acts.at(-1)!.seq);
    await page.solve(tab, inst, {});
    await tab.waitForTimeout(300);
    writes.end();
    // As an AI run often does: it ends on the app's list page, a page first seen after the save.
    if (o.endOnList) await tab.goto(new URL("list", zoo.startUrl(inst)).href);
    const proof = await proveWrite({ goal, acts, readings, requests: writes.list, endUrl: tab.url(), endText: await readPlain(tab), lastActionAt: Date.now(), browser, from: ctx, onSite, viewport: tab.viewportSize(), watchMs: 1500 });
    return { proof, kept: zooOracle(inst).done };
  } finally {
    await ctx.close();
  }
}

describe("W3 proof on the zoo's scripted solves (no AI)", { concurrency: 3 }, () => {
  ZOO_PAGES.forEach((p, i) => {
    it(p.id, async () => {
      const seed = dSeed(i);
      for (const twin of ["task", "trap"] as const) {
        const r = await proved(p, twin, seed);
        if (!r) continue;
        assert.equal(r.kept, true, `${p.id}/${twin}: the solve did it`);
        // A move or a setting can't be counted: never failed, left to the step's own check.
        if (MOVED.has(p.id)) {
          assert.equal(r.proof.status, "unmeasured", `${p.id}/${twin}: ${r.proof.why}`);
          continue;
        }
        assert.equal(r.proof.status, "held", `${p.id}/${twin}: ${r.proof.why}`);
      }
      if (!["autosave", "one-click", "undo-delete", ...MOVED].includes(p.id)) {
        const l = await proved(p, "task", seed, { endOnList: true });
        assert.equal(l?.proof.status, "held", `${p.id}/task ending on its list page: ${l?.proof.why}`);
        assert.equal(l?.proof.strength, "strong", `${p.id}/task ending on its list page: ${l?.proof.why}`);
      }
      const b = await proved(p, "broken", seed);
      if (process.env.PROOF_ZOO_SAY) console.log(`${p.id}/broken: ${b?.proof.status ?? "-"}: ${b?.proof.why ?? ""}`);
      if (b && NOT_KEPT.has(p.id)) {
        assert.equal(b.kept, false);
        assert.notEqual(b.proof.status, "held", `${p.id}/broken must stay red: ${b.proof.why}`);
      }
    });
  });
});
