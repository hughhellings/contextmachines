import { PageSnapshotSchema, type CapturedEvent, type EventBatch } from "@contextmachines/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, type Handle } from "../src/index.ts";
import { controlLabel, setKeepNumbers, snapshotPage, snapshotSignature } from "../src/page.ts";
import { normalizeUrl } from "../src/url.ts";

const norm = (url: string) => normalizeUrl(url, window.location.href)?.path;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("snapshotPage", () => {
  it("counts a field only if it's on screen: a tabbed page keeps its other sections in the document", () => {
    document.body.innerHTML = `
      <section><h2>Accounts</h2><input aria-label="Search settings"></section>
      <section hidden><h2>Profile</h2><input aria-label="Name"><select aria-label="Time zone"></select></section>
      <section style="display:none"><input aria-label="Commission"></section>
      <div style="visibility:hidden"><input aria-label="Fees"></div>
      <div aria-hidden="true"><input aria-label="Breakeven"></div>
      <details><summary>More</summary><input aria-label="Tucked away"></details>
      <details open><summary>Open</summary><input aria-label="In the open"></details>
      <form hidden><input name="other"><button type="submit">Save other</button></form>
      <form><input name="shown"><input name="kept" type="text" hidden><button type="submit">Save</button></form>
      <label class="sr-only-style" style="opacity:0;position:absolute"><input aria-label="Styled box" type="checkbox"></label>`;
    const s = snapshotPage(document, norm);
    const fields = s.forms.flatMap((f) => f.fields.map((x) => x.label ?? x.name));
    expect(fields.sort()).toEqual(["In the open", "Search settings", "Styled box", "shown"].sort());
    expect(s.forms.flatMap((f) => f.submitLabels)).toEqual(["Save"]);
    // The button of a hidden form is still known, as a control that isn't showing, tied to no form.
    expect(s.buttons.find((b) => b.label === "Save other")).toEqual({ label: "Save other", hidden: true });
  });

  it("never sends the user's own details from signed-in pages: names, record numbers, amounts, masked text", () => {
    document.title = "Invoice #4421 | Billing";
    document.body.innerHTML = `
      <h1>Welcome back, Jane Doe</h1>
      <h2>Balance £12,480.50 on 31/10/2026</h2>
      <h2 class="ph-no-capture">Jane's private notes</h2>
      <button type="button">Signed in as jane</button>
      <button type="button" data-hj-suppress>Jane Doe ▾</button>
      <button type="button">Step 2 of 3</button>`;
    const s = snapshotPage(document, norm);
    expect(s.title).toBe("Invoice ## | Billing");
    expect(s.headings).toEqual(["Welcome back, [name]", "Balance £# on #/#/#"]);
    expect(s.buttons.map((b) => b.label)).toEqual(["Signed in as [name]", "Step 2 of 3"]);
    expect(JSON.stringify(s)).not.toMatch(/Jane|jane|4421|12,480/);
    document.title = "";
  });

  it("labels of clicked controls follow the same rules, and never include what was typed", () => {
    document.body.innerHTML = `<button aria-label="Acme invoice, paid −$10.32, no tax">row</button><input value="my secret note"><textarea>draft</textarea><input type="submit" value="Save"><div class="ph-no-capture"><button>Jane Doe</button></div>`;
    const [row, input, area, save, masked] = [...document.querySelectorAll("button, input, textarea")].map((el) => controlLabel(el));
    expect([row, input, area, save, masked]).toEqual(["Acme invoice, paid −$#, no tax", undefined, undefined, "Save", undefined]);
  });

  it("leaves greetings with no name alone", () => {
    document.body.innerHTML = `<h1>Welcome back</h1><h2>Welcome to Acme Notes</h2><h2>Hello everyone</h2>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Welcome back", "Welcome to Acme Notes", "Hello everyone"]);
  });

  it("puts the page's own heading first, not the site name or a sidebar repeated on every page", () => {
    // A sidebar's h2 before the page's h1, with no landmarks at all.
    document.body.innerHTML = `<div class="left"><h2>Customer Login</h2></div><div class="right"><h1 class="title">Customer Care</h1></div>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Customer Care", "Customer Login"]);
    // Only h3s: they are read too.
    document.body.innerHTML = `<div class="example"><h3>Checkboxes</h3><form><input type="checkbox"></form></div>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Checkboxes"]);
    // Landmarks: the main content's heading beats the site header's h1; the menu, sidebar and footer are never read.
    document.body.innerHTML = `
      <header><h1>Acme Bank</h1><nav><h2>Menu</h2></nav></header>
      <aside><h2>Customer Login</h2></aside>
      <div role="main"><h2>Open an account</h2><h3>Your details</h3></div>
      <footer><h2>Contact us</h2></footer>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Open an account", "Your details", "Acme Bank"]);
    // A page whose only heading is the footer's newsletter box has no heading of its own.
    document.body.innerHTML = `<header id="header"><a href="/">Home</a></header><section id="cart_items"><table></table></section><footer id="footer"><h2>Subscription</h2></footer>`;
    expect(snapshotPage(document, norm).headings).toEqual([]);
  });

  it("an h1 in a title band at the top of the page names it, ahead of the sections below (no <main>)", () => {
    document.body.innerHTML = `
      <header class="site"><a href="/">Acme Notes</a><a href="/pricing">Pricing</a><a href="/guides">Guides</a><a href="/faq">FAQ</a></header>
      <header class="hero"><h1>Every way to get your entries in.</h1><a href="/signup">Start free</a></header>
      <section><h2>The browser extension</h2></section><section><h2>Connect your bank</h2></section>
      <footer><nav aria-label="Footer"><h3>Product</h3></nav></footer>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Every way to get your entries in.", "The browser extension", "Connect your bank"]);
    // Trap: a site header with its menu keeps its h1 last, even with no <main>.
    document.body.innerHTML = `<header><h1>Acme</h1><nav><a href="/a">A</a></nav></header><section><h2>Invoices</h2></section>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Invoices", "Acme"]);
    // An h1 outside the main content still beats the main content's h2.
    document.body.innerHTML = `<div class="title"><h1>Questions people actually ask.</h1></div><main><h2>Still wondering?</h2></main>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Questions people actually ask.", "Still wondering?"]);
  });

  it("never reads a message as a heading: a sign-in error, an alert, a status line", () => {
    document.body.innerHTML = `
      <div class="login_wrapper" role="main">
        <form><input name="user-name"><input type="submit" value="Login">
          <div class="error-message-container error"><h3 data-test="error">Epic sadface: Username and password do not match any user in this service</h3></div>
        </form>
        <div role="alert"><h2>Signed in as jane</h2></div>
        <div aria-live="polite"><h2>Saved 3 invoices</h2></div>
        <div class="Toastify__toast"><h3>Copied</h3></div>
      </div>`;
    expect(snapshotPage(document, norm).headings).toEqual([]);
    // Traps: a whole page or app wrapped in something named "error" is not a message.
    document.body.innerHTML = `<div class="error-page"><h1>Not Found</h1><p>${"The page you asked for is not here. ".repeat(2)}</p></div>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Not Found"]);
    document.body.innerHTML = `<div class="error"><h1>Invoices</h1><p>${"Your invoices, newest first. ".repeat(12)}</p></div>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Invoices"]);
  });

  it("skips headings in a cookie or consent pop-up and headings not on screen, and keeps a heading's parts apart", () => {
    document.body.innerHTML = `
      <div class="fc-consent-root"><div role="dialog" aria-label="This site asks for consent to use your data"><h1>Manage your data</h1></div><div role="dialog"><h2>What third-party vendors can access my data?</h2></div></div>
      <div role="dialog" aria-label="Invite teammates"><h2>Invite teammates</h2></div>
      <div style="display:none"><h2>9 Locked Account</h2></div>
      <h1>All Products</h1>
      <h3><a href="#/Accounts"><span>Accounts</span></a><small><p>account centric operations</p></small></h3>`;
    expect(snapshotPage(document, norm).headings).toEqual(["All Products", "Invite teammates", "Accounts account centric operations"]);
    // Trap: a page about consent, not in a pop-up, is read as usual.
    document.body.innerHTML = `<main id="consent-form"><h1>Consent to treatment</h1></main>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Consent to treatment"]);
  });

  it("a <header> inside the main content or an article is that content's own, and repeats are read once", () => {
    document.body.innerHTML = `
      <header role="banner"><h2>Acme</h2></header>
      <main><article><header><h1>Invoices</h1></header><h2>Unpaid</h2></article></main>
      <section><header><h2>Recent activity</h2></header></section>
      <div role="heading" aria-level="1">Invoices</div>`;
    expect(snapshotPage(document, norm).headings).toEqual(["Invoices", "Unpaid", "Recent activity", "Acme"]);
  });

  it("masks numbers in headings, titles and buttons unless told to keep them, and still scrubs personal data", () => {
    document.title = "404 Not Found";
    document.body.innerHTML = `<h1>404 Not Found</h1><h2>Welcome back, Jane Doe</h2><button>Pay 12 invoices</button><button>Email jane@uni.edu</button><label>Code 2026 <input name="code"></label>`;
    const masked = snapshotPage(document, norm);
    expect(masked.title).toBe("# Not Found");
    expect(masked.headings).toEqual(["# Not Found", "Welcome back, [name]"]);
    expect(masked.buttons.map((b) => b.label)).toEqual(["Pay # invoices", "Email [email]"]);
    setKeepNumbers(true);
    try {
      const kept = snapshotPage(document, norm);
      expect(kept.title).toBe("404 Not Found");
      expect(kept.headings).toEqual(["404 Not Found", "Welcome back, [name]"]);
      expect(kept.buttons.map((b) => b.label)).toEqual(["Pay 12 invoices", "Email [email]"]);
      expect(controlLabel(document.querySelector("button")!)).toBe("Pay 12 invoices");
      // Only the site's headings, title and buttons: field labels stay masked.
      expect(kept.forms[0]?.fields[0]?.label).toBe("Code #");
      expect(JSON.stringify(kept)).not.toMatch(/Jane|jane/);
    } finally {
      setKeepNumbers(false);
      document.title = "";
    }
  });

  it("reads forms, labels, required fields and submit buttons, never values", () => {
    document.body.innerHTML = `
      <h1>Log an invoice</h1>
      <form name="invoice" action="/api/invoices/8812?draft=1" method="post">
        <label for="client">Client</label><input id="client" name="client" value="Globex" required>
        <label>Amount due <input name="amount_due" type="number" value="1250.75"></label>
        <label>Notes <textarea name="notes">Late payment after jane@example.com called</textarea></label>
        <input type="hidden" name="csrf" value="secret-token">
        <input type="password" name="pin" aria-label="Account PIN" value="1234">
        <button type="submit">Save invoice</button>
        <button type="button" aria-label="Cancel">×</button>
      </form>`;
    const snap = snapshotPage(document, norm);
    expect(PageSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.headings).toEqual(["Log an invoice"]);
    expect(snap.forms).toEqual([
      {
        name: "invoice",
        action: "/api/invoices/:id",
        method: "POST",
        fields: [
          { name: "client", label: "Client", type: "text", required: true },
          { name: "amount_due", label: "Amount due", type: "number", required: false },
          { name: "notes", label: "Notes", type: "textarea", required: false },
          { name: "pin", label: "Account PIN", type: "password", required: false },
        ],
        submitLabels: ["Save invoice"],
      },
    ]);
    expect(snap.buttons).toEqual([{ label: "Save invoice", form: 0 }, { label: "Cancel", form: 0 }]);
    const json = JSON.stringify(snap);
    for (const value of ["Globex", "1250.75", "Late payment", "jane", "secret-token", "1234", "csrf"]) expect(json).not.toContain(value);
  });

  it("groups fields outside a <form> (single-page apps)", () => {
    document.body.innerHTML = `<div><input aria-label="Title" name="title"><div role="textbox" aria-label="Body" contenteditable="true">draft text</div><button>Publish</button></div>`;
    const snap = snapshotPage(document, norm);
    expect(snap.forms).toEqual([{ name: "(no form element)", fields: [{ name: "title", label: "Title", type: "text", required: false }, { name: "body", label: "Body", type: "textbox", required: false }], submitLabels: [] }]);
    expect(snap.buttons).toEqual([{ label: "Publish" }]);
    expect(JSON.stringify(snap)).not.toContain("draft text");
  });

  it("looks inside open shadow roots", () => {
    const host = document.createElement("invoice-form");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<form><input name="quantity" aria-label="Quantity"><button type="submit">Add line</button></form>`;
    const snap = snapshotPage(document, norm);
    expect(snap.forms[0]?.fields).toEqual([{ name: "quantity", label: "Quantity", type: "text", required: false }]);
    expect(snap.forms[0]?.submitLabels).toEqual(["Add line"]);
  });

  it("records iframes: cross-origin as opaque, same-origin as readable", () => {
    document.body.innerHTML = `<iframe src="https://js.stripe.com/v3/elements" title="Secure card payment"></iframe><iframe src="/embedded/editor" title="Editor"></iframe>`;
    const snap = snapshotPage(document, norm);
    expect(snap.frames).toEqual([
      { origin: "https://js.stripe.com", title: "Secure card payment", sameOrigin: false },
      { origin: window.location.origin, title: "Editor", sameOrigin: true },
    ]);
  });

  it("ignores its own prompt UI and changes signature only when structure changes", () => {
    document.body.innerHTML = `<form><input name="a"><button>Go</button></form><div data-ctx-prompt><button>Got it</button></div>`;
    const first = snapshotPage(document, norm);
    expect(first.buttons.map((b) => b.label)).toEqual(["Go"]);
    (document.querySelector("input") as HTMLInputElement).value = "typed";
    expect(snapshotSignature(snapshotPage(document, norm))).toBe(snapshotSignature(first));
    document.querySelector("form")?.insertAdjacentHTML("beforeend", `<input name="b">`);
    expect(snapshotSignature(snapshotPage(document, norm))).not.toBe(snapshotSignature(first));
  });
});

describe("page capture and triggers in init", () => {
  const ENDPOINT = "https://ingest.example.com/v1/events";
  const KEY = "pk_test_fixturekey";
  let fakeFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;
  let handle: Handle | undefined;

  beforeEach(() => {
    originalFetch = window.fetch;
    fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    window.fetch = fakeFetch as unknown as typeof fetch;
    vi.spyOn(window.navigator, "sendBeacon").mockReturnValue(true);
  });
  afterEach(() => {
    handle?.shutdown();
    handle = undefined;
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  const events = (): CapturedEvent[] =>
    fakeFetch.mock.calls.filter(([url]) => String(url) === ENDPOINT).flatMap(([, i]) => (JSON.parse(String((i as RequestInit).body)) as EventBatch).events);

  it("sends a page snapshot and links the Save click to the request it caused", async () => {
    document.body.innerHTML = `<h1>Log an invoice</h1><form><input name="due_date" aria-label="Due date"><button type="button" id="save">Save invoice</button></form>`;
    document.getElementById("save")?.addEventListener("click", () => {
      void window.fetch("/rest/v1/invoices", { method: "POST", body: JSON.stringify([{ due_date: null }]) });
    });
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    await vi.waitFor(() => expect(events().length).toBeGreaterThanOrEqual(0), { timeout: 10 });
    await new Promise((r) => setTimeout(r, 600));
    (document.getElementById("save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    await handle.flush();

    const page = events().find((e) => e.kind === "page");
    expect(page).toMatchObject({ kind: "page", snapshot: { headings: ["Log an invoice"], buttons: [{ label: "Save invoice", form: 0 }] } });
    const write = events().find((e) => e.kind === "network");
    expect(write).toMatchObject({ method: "POST", path: "/rest/v1/invoices", trigger: { type: "click", tag: "button", label: "Save invoice" } });
  });

  it("sends a page's snapshot on flush, before the page has settled, and only once", async () => {
    document.body.innerHTML = `<h1>Checkboxes</h1><input type="checkbox" aria-label="first">`;
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    // Flushed at once, as when the page is about to be left: its reading is still waiting for it to settle.
    await handle.flush();
    expect(events().filter((e) => e.kind === "page")).toMatchObject([{ kind: "page", snapshot: { headings: ["Checkboxes"] } }]);
    // Then the wait ends with nothing new: no second copy of the same page.
    await new Promise((r) => setTimeout(r, 700));
    await handle.flush();
    expect(events().filter((e) => e.kind === "page")).toHaveLength(1);
  });

  it("keepNumbers is off unless asked for, and ends with the snippet", async () => {
    document.body.innerHTML = `<h1>Step 12 of 20</h1>`;
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false, keepNumbers: true });
    expect(snapshotPage(document, norm).headings).toEqual(["Step 12 of 20"]);
    handle.shutdown();
    expect(snapshotPage(document, norm).headings).toEqual(["Step # of #"]);
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    expect(snapshotPage(document, norm).headings).toEqual(["Step # of #"]);
  });

  it("never credits a cookie banner's button with the app's next request", async () => {
    document.body.innerHTML = `<div id="banner"><button type="button" id="ok">Accept all cookies</button></div>`;
    document.getElementById("ok")?.addEventListener("click", () => {
      void window.fetch("/auth/v1/user", { method: "PUT", body: "{}" }); // the app saves the choice, or does its own thing
    });
    handle = init({ key: KEY, endpoint: ENDPOINT, ui: false });
    await new Promise((r) => setTimeout(r, 50));
    (document.getElementById("ok") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    await handle.flush();
    const write = events().find((e) => e.kind === "network");
    expect(write).toMatchObject({ method: "PUT", path: "/auth/v1/user" });
    expect(write).not.toHaveProperty("trigger");
  });
});

describe("interaction labels", () => {
  it("names a form submit after the button pressed, not the form's code id", async () => {
    const { installInteractionCapture } = await import("../src/dom.ts");
    document.body.innerHTML = `<form id="f"><input name="account" required><button>Connect payments</button></form><form id="g"><input name="q"></form>`;
    const seen: { type: string; label?: string }[] = [];
    const stop = installInteractionCapture(document, (i) => seen.push(i));
    const [f, g] = [document.getElementById("f")!, document.getElementById("g")!];
    f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, submitter: f.querySelector("button") }));
    g.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    stop();
    expect(seen).toEqual([
      { type: "submit", tag: "form", label: "Connect payments" },
      { type: "submit", tag: "form", label: "g" },
    ]);
  });
});
