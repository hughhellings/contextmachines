import { afterEach, describe, expect, it } from "vitest";
import { currentView, withView, withoutView } from "../src/view.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

const tabNamed = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent === name)!;
/** The person presses a tab (the site has not switched it yet). */
const press = (name: string) => {
  const tab = tabNamed(name);
  tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return tab;
};
/** The site marks the tab selected, as a person's press or its own timer would. */
const select = (tab: Element) => {
  for (const t of tab.parentElement!.children) t.setAttribute("aria-selected", String(t === tab));
};

describe("views inside a page", () => {
  it("names the current wizard step", () => {
    document.body.innerHTML = `<ol><li>Your company</li><li aria-current="step">Connect your bank</li><li>Invite</li></ol>`;
    expect(currentView(document)).toBe("~connect-your-bank");
  });

  it("an open pop-up beats the step behind it, and closing it goes back to the step", () => {
    document.body.innerHTML = `<ol><li aria-current="step">Connect your bank</li></ol><div role="dialog" aria-modal="true" aria-labelledby="t"><h2 id="t">Invite teammates</h2></div>`;
    expect(currentView(document)).toBe("~invite-teammates");
    document.querySelector("[role=dialog]")!.setAttribute("hidden", "");
    expect(currentView(document)).toBe("~connect-your-bank");
  });

  it("names the tab the person switched to, and nothing when there is no view", () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" aria-selected="true">General</button><button role="tab" aria-selected="false">Notifications</button></div>`;
    currentView(document);
    select(press("Notifications"));
    expect(currentView(document)).toBe("~notifications");
    document.body.innerHTML = `<main><h1>Invoices</h1></main>`;
    expect(currentView(document)).toBeUndefined();
  });

  it("the tab selected as the page loads is the page itself, wherever it sits in the list", () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" aria-selected="false">General</button><button role="tab" aria-selected="true">Notifications</button></div><main><h1>Settings</h1></main>`;
    expect(currentView(document)).toBeUndefined();
    // Pressing the tab already showing switches nothing.
    press("Notifications");
    expect(currentView(document)).toBeUndefined();
  });

  it("a carousel moving through its tabs by itself stays the page; the person picking one makes a view", () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" aria-selected="true">Agents</button><button role="tab" aria-selected="false">Brief</button><button role="tab" aria-selected="false">Sync</button></div>`;
    expect(currentView(document)).toBeUndefined();
    select(tabNamed("Brief")); // the carousel rotates on a timer
    expect(currentView(document)).toBeUndefined();
    select(tabNamed("Sync"));
    expect(currentView(document)).toBeUndefined();
    select(press("Agents"));
    expect(currentView(document)).toBe("~agents");
  });

  it("tab components that switch as the button goes down, or by arrow keys, are the person switching too", () => {
    document.body.innerHTML = `<div role="tablist"><button role="tab" aria-selected="true">Day</button><button role="tab" aria-selected="false">Week</button></div>`;
    currentView(document);
    const week = tabNamed("Week");
    week.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    select(week);
    week.dispatchEvent(new MouseEvent("click", { bubbles: true })); // already selected by now
    expect(currentView(document)).toBe("~week");

    document.body.innerHTML = `<div role="tablist"><button role="tab" aria-selected="true">Day</button><button role="tab" aria-selected="false">Week</button></div>`;
    currentView(document);
    tabNamed("Day").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    select(tabNamed("Week"));
    expect(currentView(document)).toBe("~week");
    // Typing elsewhere is not choosing a tab.
    document.body.innerHTML = `<input><div role="tablist"><button role="tab" aria-selected="false">Day</button><button role="tab" aria-selected="true">Week</button></div>`;
    document.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(currentView(document)).toBeUndefined();
  });

  it("never names our own help card, and cleans names like any label", () => {
    document.body.innerHTML = `<div data-ctx-guide><div role="dialog" aria-label="Need a hand?"></div></div><dialog open aria-label="Welcome back, Jane"></dialog>`;
    expect(currentView(document)).toBe("~welcome-back-name");
  });

  it("adds and removes the view on a path", () => {
    expect(withView("/setup", "~connect-your-bank")).toBe("/setup/~connect-your-bank");
    expect(withView("/", "~invite")).toBe("/~invite");
    expect(withoutView("/setup/~connect-your-bank")).toBe("/setup");
    expect(withoutView("/~invite")).toBe("/");
  });

  it("a pop-up with no heading is named after the bold title above its fields, step by step", () => {
    document.body.innerHTML = `<dialog open><div><strong id="t">About you</strong><div>Step 1 of 4</div></div><label>Full name <input name="name"></label><button><b>Continue</b></button></dialog>`;
    expect(currentView(document)).toBe("~about-you");
    document.getElementById("t")!.textContent = "Income";
    expect(currentView(document)).toBe("~income");
    document.body.innerHTML = `<dialog open><label><strong>Name</strong> <input></label></dialog>`;
    expect(currentView(document)).toBe("~dialog");
  });

  it("a consent pop-up, and any pop-up opened inside the consent box, is not a view of the page", () => {
    document.body.innerHTML = `<div class="fc-consent-root"><div role="dialog" aria-label="This site asks for consent to use your data"><h2>Manage your data</h2></div><div role="dialog"><h2>What third-party vendors can access my data?</h2></div></div>`;
    expect(currentView(document)).toBeUndefined();
    document.body.innerHTML = `<div id="CybotCookiebotDialog" role="dialog"><h2>This website uses cookies</h2></div>`;
    expect(currentView(document)).toBeUndefined();
    // Trap: the site's own pop-ups are still views.
    document.body.innerHTML = `<div class="fc-consent-root"></div><div role="dialog" aria-label="Invite teammates"><h2>Invite teammates</h2></div>`;
    expect(currentView(document)).toBe("~invite-teammates");
  });
});
