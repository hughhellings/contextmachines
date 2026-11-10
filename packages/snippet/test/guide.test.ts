import type { Delivery } from "@contextmachines/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Guide, type GuideValue } from "../src/guide.ts";

let guide: Guide | undefined;
afterEach(() => {
  guide?.destroy();
  guide = undefined;
  document.body.innerHTML = "";
});

function setup(path = "/add-invoice") {
  const events: GuideValue[] = [];
  const navigate = vi.fn();
  guide = new Guide(document, { report: (_d, v) => events.push(v), currentPath: () => path, navigate, highlightMs: 50 });
  const root = guide.element.shadowRoot as ShadowRoot;
  const buttons = () => Object.fromEntries([...root.querySelectorAll(".card button")].map((b) => [b.textContent, b as HTMLButtonElement]));
  return { events, navigate, root, buttons, g: guide };
}

const base: Delivery = { suggestionId: "s1", goalId: "g1", message: "Log your next invoice.", why: "Patterns appear after 10 invoices.", level: "tell", steps: [] };

describe("Guide", () => {
  it("tell: a card with the message, reports shown and dismissal once", () => {
    const { events, root, buttons } = setup();
    guide?.present({ ...base, message: "<b>not html</b>" });
    expect(root.querySelector(".title")?.textContent).toBe("<b>not html</b>");
    expect(root.querySelector(".title b")).toBeNull();
    expect(Object.keys(buttons())).toEqual(["Why?", "Not now", "Not relevant"]);
    buttons()["Not now"]?.click();
    expect(events).toEqual(["shown", "dismissed"]);
    expect(root.querySelector(".card")).toBeNull();
  });

  it("show: one field to fill points at that field, not the button; typing in it counts as done", () => {
    document.body.innerHTML = `<label>Reg. no. <input id="reg" name="reg_no" required></label><button id="save">Save invoice</button>`;
    const { events, root, buttons } = setup("/invoices/new");
    guide?.present({ ...base, level: "show", steps: [{ type: "fill", page: "/invoices/new", fields: ["Reg. no."] }, { type: "press", label: "Save invoice", page: "/invoices/new", actionId: "invoice.create", times: 1 }] });
    buttons()["Show me"]?.click();
    expect(root.querySelector(".tip")?.textContent).toBe('Fill in "Reg. no"');
    document.getElementById("reg")!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(events).toEqual(["shown", "did_it"]);
    expect(root.querySelector(".ring")).toBeNull();
  });

  it("show: lists the steps and highlights the real button; pressing it counts as done", () => {
    document.body.innerHTML = `<button id="save">Save invoice</button>`;
    const { events, root, buttons } = setup("/add-invoice");
    guide?.present({ ...base, level: "show", steps: [{ type: "press", label: "Save invoice", page: "/add-invoice", actionId: "invoice.create", times: 3 }] });
    expect([...root.querySelectorAll("li")].map((l) => l.textContent)).toEqual(['Press "Save invoice" (3 more times)']);
    buttons()["Show me"]?.click();
    expect(root.querySelector(".ring")).not.toBeNull();
    expect(root.querySelector(".tip")?.textContent).toBe('Press "Save invoice"');
    (document.getElementById("save") as HTMLButtonElement).click();
    expect(events).toEqual(["shown", "did_it"]);
    expect(root.querySelector(".ring")).toBeNull();
  });

  it("closes quietly when the user moves to an unrelated page, but stays when its steps lead there", () => {
    const { root, events } = setup("/deals/new");
    guide?.present({ ...base, level: "tell", steps: [] });
    guide?.pageChanged("/contacts");
    expect(root.querySelector(".card")).toBeNull();
    expect(events).toEqual(["shown"]); // not recorded as a dismissal
    guide?.present({ ...base, level: "show", steps: [{ type: "go", page: "/settings", label: "Settings" }] });
    guide?.pageChanged("/settings");
    expect(root.querySelector(".card")).not.toBeNull();
  });

  it("show: offers navigation when the steps start on another page", () => {
    const { navigate, buttons, events } = setup("/calendar");
    guide?.present({ ...base, level: "show", steps: [{ type: "go", page: "/reports", label: "Reports" }] });
    buttons()["Take me there"]?.click();
    expect(navigate).toHaveBeenCalledWith("/reports");
    expect(events).toEqual(["shown", "did_it"]);
  });

  it("do: presses the button only after the user confirms; reports a missing button", () => {
    document.body.innerHTML = `<button id="tag">Tag invoices</button>`;
    const clicked = vi.fn();
    document.getElementById("tag")?.addEventListener("click", clicked);
    const { buttons, events } = setup();
    const press = { type: "press" as const, label: "Tag invoices", page: "/add-invoice", actionId: "invoice.tag", times: 1 };
    guide?.present({ ...base, level: "do", steps: [press], doStep: press });
    const doIt = buttons()["Do it for me"] as HTMLButtonElement;
    doIt.click();
    expect(clicked).not.toHaveBeenCalled();
    expect(doIt.textContent).toBe('Confirm: press "Tag invoices"');
    doIt.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["shown", "did_it"]);

    guide?.present({ ...base, suggestionId: "s2", level: "do", steps: [{ ...press, label: "Gone" }], doStep: { ...press, label: "Gone" } });
    buttons()["Do it for me"]?.click();
    buttons()['Confirm: press "Gone"']?.click();
    expect(events.slice(-1)).toEqual(["element_missing"]);
  });

  it("shows one suggestion at a time", () => {
    const { events } = setup();
    guide?.present(base);
    guide?.present({ ...base, suggestionId: "s2" });
    expect(guide?.showing).toBe("s1");
    expect(events).toEqual(["shown"]);
  });
});
