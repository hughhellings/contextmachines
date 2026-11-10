import { afterEach, describe, expect, it } from "vitest";
import { controlLabel } from "../src/page.ts";

afterEach(() => {
  document.body.innerHTML = "";
});
const label = (selector: string) => controlLabel(document.querySelector(selector)!);

describe("labels never carry users' own names", () => {
  it("keeps only the shared words when a control is repeated for each item (Delete the tag …)", () => {
    document.body.innerHTML = `<div class="chips">${["Urgent", "Phase 2", "VIP"].map((t) => `<span class="tagchip">${t}<button class="x" aria-label="Delete the tag ${t}">x</button></span>`).join("")}</div>`;
    expect(label("button[aria-label$='Phase 2']")).toBe("Delete the tag");
  });

  it("sends no label for a row of user-made tags with nothing in common", () => {
    document.body.innerHTML = `<div>${["B", "VIP", "Phase 1:1", "Urgent"].map((t) => `<button class="chip" aria-pressed="false">${t}</button>`).join("")}</div>`;
    expect(label("button")).toBeUndefined();
  });

  it("keeps the product's own words: menus, tabs, toolbars and links to different screens", () => {
    document.body.innerHTML = `
      <div id="side"><a class="item" href="/invoices">Invoices</a><a class="item" href="/reports">Reports</a><a class="item" href="/calendar">Calendar</a></div>
      <div role="toolbar"><button class="t">Bold</button><button class="t">Italic</button><button class="t">Underline</button></div>
      <div role="tablist"><button class="tab">Day</button><button class="tab">Week</button><button class="tab">Month</button></div>`;
    expect(label("a[href='/reports']")).toBe("Reports");
    expect(label("[role=toolbar] button")).toBe("Bold");
    expect(label("[role=tablist] button")).toBe("Day");
  });

  it("keeps a row of the product's own buttons, each with its developer's identifier", () => {
    document.body.innerHTML = `<div><button id="remind">Send reminder</button><button id="archive">Archive</button><button id="duplicate">Duplicate</button></div>`;
    expect(label("#archive")).toBe("Archive");
    document.body.innerHTML = `<div>${["B", "VIP", "Urgent"].map((t, i) => `<button id="tag-${i}0021">${t}</button>`).join("")}</div>`;
    expect(label("button")).toBeUndefined(); // ids carrying record numbers: someone's items
  });

  it("sends no label for a list of records (links to the same kind of screen)", () => {
    document.body.innerHTML = `<ul>${["Jane's kitchen", "Roof repair", "Garden shed"].map((t, i) => `<li><a href="/job/${i}">${t}</a></li>`).join("")}</ul>`;
    expect(label("a")).toBeUndefined();
  });

  it("keeps what a switcher is for, not what is selected in it", () => {
    document.body.innerHTML = `<button aria-label="Account: Acme#2 live">x</button><button id="t">Time: 10:30</button>`;
    expect(label("button")).toBe("Account");
  });

  it("does not label a card by its contents, but keeps an ordinary button's words", () => {
    document.body.innerHTML = `
      <div id="card" role="button"><b>Northwind</b><span>Xero</span><span>live · Connected 0 min ago</span><span>2 jobs</span></div>
      <button id="imp">Import <strong>8</strong> jobs</button>`;
    expect(label("#card")).toBeUndefined();
    expect(label("#imp")).toBe("Import 8 jobs");
  });
});
