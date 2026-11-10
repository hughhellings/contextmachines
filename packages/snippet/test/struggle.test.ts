import { afterEach, describe, expect, it, vi } from "vitest";
import { controlLabel } from "../src/page.ts";
import { installStruggleCapture, type Struggle, type StruggleCapture } from "../src/struggle.ts";

let capture: StruggleCapture | undefined;
afterEach(() => {
  capture?.();
  capture = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function setup(html: string, opts: { activity?: () => boolean } = {}) {
  document.body.innerHTML = html;
  let now = 1_000_000;
  let path = "/settings/bank";
  const seen: Struggle[] = [];
  capture = installStruggleCapture(document, {
    report: (s) => seen.push(s),
    currentPath: () => path,
    somethingHappenedSince: () => opts.activity?.() ?? false,
    isOwnUi: (el) => el.closest("[data-ctx-guide]") !== null,
    labelOf: (el) => controlLabel(el),
    clock: () => now,
    deadClickWaitMs: 10,
  });
  const cap = capture;
  // In-app navigation, as the snippet does it: the route is updated, then the detector is told.
  const go = (to: string) => {
    path = to;
    cap.pageChanged();
  };
  return { seen, tick: (ms: number) => (now += ms), cap, go };
}
const fire = (el: Element, type: string, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
const type = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("struggle signals", () => {
  it("hesitation: hovering a button 3 times without pressing", () => {
    const { seen, tick } = setup(`<button id="b">Connect</button>`);
    const b = document.getElementById("b") as HTMLElement;
    for (let i = 0; i < 3; i++) {
      fire(b, "mouseover");
      tick(400);
      fire(b, "mouseout", { relatedTarget: document.body });
    }
    expect(seen).toEqual([{ type: "hesitation", page: "/settings/bank", target: "Connect", count: 3, durationMs: 1200 }]);
  });

  it("no hesitation over a clickable card someone is reading (a dashboard tile)", () => {
    const { seen, tick } = setup(`<a href="/reports" id="tile" aria-label="Net result, open Reports"><h2>Net result</h2><p>+$#</p></a>`);
    const tile = document.getElementById("tile") as HTMLElement;
    tile.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 360, bottom: 180, width: 360, height: 180, toJSON: () => ({}) });
    for (let i = 0; i < 4; i++) {
      fire(tile, "mouseover");
      tick(2000);
      fire(tile, "mouseout", { relatedTarget: document.body });
    }
    expect(seen.filter((s) => s.type === "hesitation")).toEqual([]);
  });

  it("no hesitation once the button was pressed", () => {
    const { seen } = setup(`<button id="b">Connect</button>`);
    const b = document.getElementById("b") as HTMLElement;
    fire(b, "mouseover");
    b.click();
    for (let i = 0; i < 3; i++) {
      fire(b, "mouseout", { relatedTarget: document.body });
      fire(b, "mouseover");
    }
    expect(seen.filter((s) => s.type === "hesitation")).toEqual([]);
  });

  it("rage click: 3 clicks within a second, reported once", () => {
    const { seen, tick } = setup(`<button id="b">Save invoice</button>`, { activity: () => true });
    const b = document.getElementById("b") as HTMLElement;
    for (let i = 0; i < 5; i++) {
      b.click();
      tick(100);
    }
    expect(seen).toEqual([{ type: "rage_click", page: "/settings/bank", target: "Save invoice", count: 3 }]);
  });

  it("dead click: looks clickable, nothing happens; not dead when something did", async () => {
    vi.useFakeTimers();
    const quiet = setup(`<span role="button" id="x">Export</span>`);
    (document.getElementById("x") as HTMLElement).click();
    vi.advanceTimersByTime(20);
    expect(quiet.seen).toEqual([{ type: "dead_click", page: "/settings/bank", target: "Export" }]);
    capture?.();

    const busy = setup(`<span role="button" id="x">Export</span>`, { activity: () => true });
    (document.getElementById("x") as HTMLElement).click();
    vi.advanceTimersByTime(20);
    expect(busy.seen).toEqual([]);
  });

  it("field churn: the same field edited in 4 separate bursts (name only, never the value)", () => {
    const { seen, tick } = setup(`<form><input name="server"></form>`);
    const input = document.querySelector("input") as HTMLInputElement;
    for (let i = 0; i < 4; i++) {
      type(input, `MetaQuotes-Demo-${i}`);
      tick(3000);
    }
    expect(seen).toEqual([{ type: "field_churn", page: "/settings/bank", target: "server", count: 4 }]);
    expect(JSON.stringify(seen)).not.toContain("MetaQuotes");
  });

  it("form abandonment: 2+ fields filled, then left without submitting", () => {
    const { seen, cap } = setup(`<form name="bank"><input name="server"><input name="login_id"><input name="password" type="password"></form>`);
    const [server, login] = [...document.querySelectorAll("input")] as HTMLInputElement[];
    type(server as HTMLInputElement, "x");
    type(login as HTMLInputElement, "y");
    cap.pageChanged();
    expect(seen).toContainEqual({ type: "form_abandon", page: "/settings/bank", target: "bank", count: 2 });
  });

  it("fields with no name or id are known by their label (apps that keep form state in code)", () => {
    const { seen, cap } = setup(`<form><input type="email" aria-label="Email address"><input type="password" aria-label="Password"></form>`);
    for (const input of document.querySelectorAll("input")) type(input as HTMLInputElement, "x");
    cap.pageChanged();
    expect(seen).toEqual([{ type: "form_abandon", page: "/settings/bank", target: "", count: 2 }]);
  });

  it("not abandonment when a save request was sent (SPAs rarely submit forms)", () => {
    const { seen, cap, tick } = setup(`<div><input name="server"><input name="login_id"></div>`);
    const [a, b] = [...document.querySelectorAll("input")] as HTMLInputElement[];
    type(a as HTMLInputElement, "x");
    type(b as HTMLInputElement, "y");
    cap.markSubmitted();
    tick(10_000);
    cap.pageChanged();
    expect(seen).toEqual([]);
  });

  it("validation loop: the server rejects a field twice and the page only says \"Invalid\"", () => {
    const { seen, cap, tick } = setup(`<form><input name="name"><input name="key"><button>Create</button></form>`);
    const key = document.querySelector("[name=key]") as HTMLInputElement;
    type(key, "Apollo");
    expect(cap.markSubmitted(false, "key")).toBe(true);
    tick(4000);
    type(key, "apollo");
    cap.markSubmitted(false, "key");
    expect(seen).toEqual([expect.objectContaining({ type: "validation_loop", target: "key", count: 2, detail: "rejected" })]);
  });

  it("not when the field the reply blames isn't on the page (a GraphQL path, another form)", () => {
    const { seen, cap, tick } = setup(`<form><input name="name"></form>`);
    expect(cap.markSubmitted(false, "createProject")).toBe(false);
    tick(4000);
    cap.markSubmitted(false, "createProject");
    expect(seen.filter((e) => e.type === "validation_loop")).toEqual([]);
  });

  it("validation loop: two browser-blocked submits (one 'invalid' burst each)", () => {
    const { seen, tick } = setup(`<form name="bank"><input name="server" required><input name="login_id" required></form>`);
    const fields = [...document.querySelectorAll("input")];
    const attempt = () => fields.forEach((f) => f.dispatchEvent(new Event("invalid", { cancelable: true })));
    attempt(); // two fields, one attempt
    expect(seen).toEqual([]);
    tick(2000);
    attempt();
    // Named after the first field the browser rejected, so help can point at it.
    expect(seen).toEqual([{ type: "validation_loop", page: "/settings/bank", target: "server", count: 2, detail: "empty" }]);
  });

  it("validation loop: apps that flag aria-invalid themselves", () => {
    const { seen } = setup(`<form name="invoice"><input name="client" aria-invalid="true"></form>`);
    const form = document.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(seen).toEqual([{ type: "validation_loop", page: "/settings/bank", target: "client", count: 2, detail: "empty" }]);
  });

  it("u-turn: went straight back to the page they came from", () => {
    const { seen, go, tick } = setup(`<p>hi</p>`);
    go("/reports");
    tick(1200);
    go("/settings/bank");
    expect(seen).toEqual([{ type: "u_turn", page: "/reports", durationMs: 1200 }]);
  });

  it("moving on quickly is not a u-turn (logging in, then straight to work)", () => {
    const { seen, go, tick } = setup(`<p>hi</p>`);
    go("/login");
    tick(800);
    go("/dashboard");
    tick(900);
    go("/invoices/new");
    expect(seen).toEqual([]);
  });

  it("going back after typing, or after a while, is not a u-turn", () => {
    const { seen, go, tick } = setup(`<input name="q">`);
    go("/search");
    type(document.querySelector("input")!, "abc");
    tick(1000);
    go("/settings/bank");
    go("/reports");
    tick(4000);
    go("/settings/bank");
    expect(seen.filter((s) => s.type === "u_turn")).toEqual([]);
  });

  it("counts a server re-rendering a form as rejected across page loads (multi-page sites)", () => {
    sessionStorage.clear();
    const page = `<form><input name="dob" aria-invalid="true"><button>Confirm</button></form>`;
    setup(page).cap(); // first rejection: the page came back once
    const second = setup(page); // the same page came back again
    expect(second.seen).toEqual([{ type: "validation_loop", page: "/settings/bank", target: "dob", count: 2, detail: "empty", control: "Confirm" }]);
    second.cap();
    setup(`<form><input name="dob"><button>Confirm</button></form>`).cap(); // accepted: the count resets
    expect(sessionStorage.getItem("ctx:rejected:/settings/bank")).toBeNull();
  });

  it("a pointer resting on a button is not hesitation; going back to it is", () => {
    const { seen, tick } = setup(`<button id="b">Pay</button>`);
    const b = document.getElementById("b")!;
    fire(b, "mouseover");
    tick(6000);
    fire(b, "mouseout");
    expect(seen).toEqual([]);
  });

  it("says whether the rejected field was empty or filled, never what is in it", () => {
    const { seen, tick } = setup(`<form><input name="phone" required><button>Save</button></form>`);
    const input = document.querySelector("input")!;
    input.value = "020 7946";
    input.dispatchEvent(new Event("invalid"));
    tick(1000); // a second attempt
    input.dispatchEvent(new Event("invalid"));
    expect(seen).toEqual([{ type: "validation_loop", page: "/settings/bank", target: "phone", count: 2, detail: "rejected", control: "Save" }]);
    expect(JSON.stringify(seen)).not.toContain("020");
  });

  it("a click that starts loading another page is not a dead click, however slow the page", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<a href="/results" id="go">Search</a>`);
    const link = document.getElementById("go")!;
    link.addEventListener("click", (e) => e.preventDefault(), { once: true }); // the app handles the click itself
    fire(link, "click", { cancelable: true });
    vi.advanceTimersByTime(20);
    expect(seen.filter((s) => s.type === "dead_click")).toHaveLength(1); // app handled it and nothing happened: dead
    const { seen: seen2 } = setup(`<form action="/results"><button id="s">Search</button></form>`);
    const form = document.querySelector("form")!;
    form.addEventListener("submit", () => {}, { once: true });
    fire(document.getElementById("s")!, "click");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); // not prevented: the browser posts the form
    vi.advanceTimersByTime(20);
    expect(seen2.filter((s) => s.type === "dead_click")).toEqual([]);
  });

  it("going back because our help said so is not a u-turn", () => {
    const { seen, go, tick } = setup(`<div data-ctx-guide><button id="take">Take me there</button></div>`);
    go("/dashboard");
    tick(800);
    fire(document.getElementById("take")!, "click");
    go("/settings/bank");
    expect(seen).toEqual([]);
  });

  it("files a struggle under the page it happened on, not the next one", () => {
    const { seen, go } = setup(`<form id="f"><input name="a"><input name="b"></form>`);
    type(document.querySelector("input[name=a]")!, "x");
    type(document.querySelector("input[name=b]")!, "y");
    go("/dashboard");
    expect(seen).toEqual([{ type: "form_abandon", page: "/settings/bank", target: "f", count: 2 }]);
  });

  it("a button whose code sends the person to another site (Google sign-in) is not a dead click", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<button id="google">Continue with Google</button>`);
    fire(document.getElementById("google")!, "click");
    window.dispatchEvent(new Event("beforeunload")); // the app called location.assign("https://accounts.google.com/…")
    vi.advanceTimersByTime(20);
    expect(seen.filter((s) => s.type === "dead_click")).toEqual([]);
  });

  it("a button that opens a file picker (by clicking a hidden file input) is not a dead click", () => {
    vi.useFakeTimers();
    const { seen, tick } = setup(`<button id="browse">browse for a file</button><input id="file" type="file" hidden><button id="dead">Export</button>`);
    const input = document.getElementById("file") as HTMLInputElement;
    document.getElementById("browse")!.addEventListener("click", () => input.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    fire(document.getElementById("browse")!, "click");
    vi.advanceTimersByTime(1100);
    expect(seen.filter((s) => s.type === "dead_click")).toEqual([]);
    tick(5000);
    fire(document.getElementById("dead")!, "click"); // a button that really does nothing is still caught
    vi.advanceTimersByTime(1100);
    expect(seen.filter((s) => s.type === "dead_click").map((s) => s.target)).toEqual(["Export"]);
  });

  it("a button that opens a pop-up or dialog (the page loses focus) is not a dead click", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<button id="google">Continue with Google</button>`);
    fire(document.getElementById("google")!, "click");
    window.dispatchEvent(new Event("blur")); // window.open(...) for Google sign-in took focus
    vi.advanceTimersByTime(1100);
    expect(seen.filter((s) => s.type === "dead_click")).toEqual([]);
  });

  it("dropdowns, checkboxes, labels and other built-in controls are never dead clicks", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<select id="s" tabindex="0" style="cursor:pointer"><option>Day</option></select><label id="l" style="cursor:pointer">Remember me <input id="c" type="checkbox"></label><div role="combobox" id="cb" tabindex="0">Account</div>`);
    for (const id of ["s", "l", "c", "cb"]) fire(document.getElementById(id)!, "click");
    vi.advanceTimersByTime(20);
    expect(seen.filter((s) => s.type === "dead_click")).toEqual([]);
  });

  it("a click the browser blocked for invalid fields is not a dead click", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<form><input name="reg" required><button>Save</button></form>`);
    const button = document.querySelector("button")!;
    fire(button, "click");
    document.querySelector("input")!.dispatchEvent(new Event("invalid"));
    vi.advanceTimersByTime(20);
    expect(seen.filter((s) => s.type === "dead_click")).toEqual([]);
  });

  it("ignores our own UI", () => {
    const { seen, tick } = setup(`<div data-ctx-guide><button id="g">Not now</button></div>`, { activity: () => true });
    const g = document.getElementById("g") as HTMLElement;
    for (let i = 0; i < 4; i++) {
      g.click();
      tick(50);
    }
    expect(seen).toEqual([]);
  });
});

describe("the app breaking", () => {
  const appError = (filename = `${location.origin}/assets/app.js`, message = "TypeError: x is undefined") =>
    window.dispatchEvent(new ErrorEvent("error", { message, filename, lineno: 1 }));

  it("an error from the app's own code right after a press is a crash, named by the press, never by the message", () => {
    const { seen } = setup(`<button id="g">Group by client</button>`);
    fire(document.getElementById("g")!, "click");
    appError();
    expect(seen.filter((s) => s.type === "crash")).toEqual([{ type: "crash", page: "/settings/bank", target: "Group by client" }]);
    expect(JSON.stringify(seen)).not.toContain("undefined");
  });

  it("background errors nobody caused, other sites' scripts and harmless warnings are not crashes", () => {
    const { seen, tick } = setup(`<button id="g">Group by client</button>`);
    appError(); // no press yet
    fire(document.getElementById("g")!, "click");
    appError("https://widgets.other.test/chat.js");
    appError("", "Script error.");
    appError(undefined, "ResizeObserver loop completed with undelivered notifications.");
    tick(5000);
    appError(); // long after the press
    expect(seen.filter((s) => s.type === "crash")).toEqual([]);
  });

  it("a page whose title or heading says it is an error page is one; ordinary headings with numbers are not", () => {
    vi.useFakeTimers();
    document.title = "Page not found | Acme";
    const first = setup(`<h1>Oops</h1>`);
    vi.advanceTimersByTime(900);
    expect(first.seen.filter((s) => s.type === "error_page")).toEqual([{ type: "error_page", page: "/settings/bank" }]);
    capture?.();
    document.title = "Customers | Acme";
    const second = setup(`<h1>Top 500 customers</h1><p>No results found</p>`);
    vi.advanceTimersByTime(900);
    expect(second.seen.filter((s) => s.type === "error_page")).toEqual([]);
  });
});

describe("phones", () => {
  const box = (el: Element, left: number, top: number, w: number, h: number) =>
    Object.assign(el, { getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top }) });
  const tap = (el: Element, x: number, y: number) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  };

  it("tapping just beside a small button twice is a missed tap on it; once is not", () => {
    const { seen } = setup(`<div id="row"><span>Call the bank</span><button id="done" aria-label="Mark done">✓</button></div>`);
    box(document.getElementById("done")!, 300, 100, 18, 18);
    tap(document.getElementById("row")!, 290, 109);
    expect(seen.filter((s) => s.type === "missed_tap")).toEqual([]);
    tap(document.getElementById("row")!, 291, 110);
    expect(seen.filter((s) => s.type === "missed_tap")).toEqual([{ type: "missed_tap", page: "/settings/bank", target: "Mark done", count: 2 }]);
  });

  it("taps far from any button, and mouse clicks beside one, are not missed taps", () => {
    const { seen } = setup(`<div id="row"><button id="done" aria-label="Mark done">✓</button></div>`);
    box(document.getElementById("done")!, 300, 100, 18, 18);
    for (let i = 0; i < 3; i++) tap(document.getElementById("row")!, 100, 109);
    for (let i = 0; i < 3; i++) {
      document.getElementById("row")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      document.getElementById("row")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 290, clientY: 109 }));
    }
    expect(seen.filter((s) => s.type === "missed_tap")).toEqual([]);
  });

  it("on a touch screen, tapping a button is never hesitating over it", () => {
    const { seen } = setup(`<button id="b">Save</button>`);
    const b = document.getElementById("b")!;
    for (let i = 0; i < 4; i++) {
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      fire(b, "mouseover");
      fire(b, "mouseout", { relatedTarget: document.body });
    }
    expect(seen.filter((s) => s.type === "hesitation")).toEqual([]);
  });
});

describe("searches that find nothing", () => {
  it("two empty searches in a row are someone stuck; one, then a hit, is normal", () => {
    const { seen, tick } = setup(`<input type="search">`);
    capture!.searched(true);
    capture!.searched(false);
    capture!.searched(true);
    expect(seen.filter((s) => s.type === "no_results")).toEqual([]);
    tick(1000);
    capture!.searched(true);
    expect(seen.filter((s) => s.type === "no_results")).toEqual([{ type: "no_results", page: "/settings/bank", count: 2 }]);
  });

  it("empty searches far apart don't add up", () => {
    const { seen, tick } = setup(`<input type="search">`);
    capture!.searched(true);
    tick(120_000);
    capture!.searched(true);
    expect(seen.filter((s) => s.type === "no_results")).toEqual([]);
  });

  it("an empty state written in the page's own script isn't on screen", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<main><input type="search" name="suche"><div id="out"><p>3 Rechnungen</p></div><script>const empty = "Keine Treffer für Ihre Suche.";</script></main>`);
    const box = document.querySelector("input") as HTMLInputElement;
    for (const q of ["RE-1", "RE-2"]) { box.value = q; box.dispatchEvent(new Event("input", { bubbles: true })); vi.advanceTimersByTime(1500); }
    expect(seen.filter((e) => e.type === "no_results")).toEqual([]);
    vi.useRealTimers();
  });

  it("reads the screen for searches done in the browser", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<main><h1>Customers</h1><input type="search" id="s" placeholder="Search customers"><ul id="list"></ul></main>`);
    const box = document.getElementById("s") as HTMLInputElement;
    for (const term of ["acme corp", "acme ltd"]) {
      type(box, term);
      document.getElementById("list")!.innerHTML = `<li>No customers match</li>`;
      vi.advanceTimersByTime(1300);
    }
    expect(seen.filter((s) => s.type === "no_results")).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain("acme");
  });
});

describe("searching for something", () => {
  const buttons = (n: number) => Array.from({ length: n }, (_, i) => `<button id="b${i}">Option ${i}</button>`).join("");
  const hoverAll = (n: number, tick: (ms: number) => void) => {
    for (let i = 0; i < n; i++) {
      const b = document.getElementById(`b${i}`)!;
      fire(b, "mouseover");
      tick(300);
      fire(b, "mouseout", { relatedTarget: document.body });
    }
  };
  const scrollTo = (y: number) => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  };
  const findKey = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));

  it("catches looking around: many different buttons hovered and menus opened, for a while, getting nowhere", () => {
    const { seen, tick } = setup(`${buttons(7)}<button id="m1" aria-haspopup="menu">More</button><button id="m2" aria-expanded="false">Filters</button>`);
    hoverAll(7, tick);
    tick(10_000);
    fire(document.getElementById("m1")!, "click");
    tick(3000);
    fire(document.getElementById("m2")!, "click");
    expect(seen.filter((s) => s.type === "searching")).toEqual([{ type: "searching", page: "/settings/bank", count: 7, durationMs: 15_100, signs: ["hovered", "menus"] }]);
  });

  it("someone who looks around and then goes still is still caught, at the 15-second mark", () => {
    vi.useFakeTimers();
    const { seen, tick } = setup(`${buttons(7)}<button id="m1" aria-haspopup="menu">More</button>`);
    hoverAll(7, tick);
    fire(document.getElementById("m1")!, "click");
    fire(document.getElementById("m1")!, "click");
    expect(seen.filter((s) => s.type === "searching")).toEqual([]);
    // Nothing more happens on the page: they sit and stare.
    tick(13_000);
    vi.advanceTimersByTime(13_000);
    expect(seen.filter((s) => s.type === "searching").map((s) => s.signs)).toEqual([["hovered", "menus"]]);
  });

  it("one sign alone is just using the page: hovering over many buttons is not searching", () => {
    const { seen, tick } = setup(buttons(12));
    hoverAll(12, tick);
    tick(30_000);
    hoverAll(12, tick);
    expect(seen.filter((s) => s.type === "searching")).toEqual([]);
  });

  it("needs 15 seconds: a quick look around is not searching", () => {
    const { seen, tick } = setup(`${buttons(6)}<button id="m1" aria-haspopup="true">More</button>`);
    hoverAll(6, tick);
    fire(document.getElementById("m1")!, "click");
    fire(document.getElementById("m1")!, "click");
    expect(seen.filter((s) => s.type === "searching")).toEqual([]);
    tick(14_000);
    findKey(); // still looking, now past 15s
    expect(seen.filter((s) => s.type === "searching").map((s) => s.signs)).toEqual([["hovered", "menus", "find"]]);
  });

  it("getting somewhere (a save) ends the search", () => {
    const { seen, tick, cap } = setup(`${buttons(6)}<button id="m1" aria-haspopup="true">More</button>`);
    hoverAll(6, tick);
    tick(12_000);
    cap.markSubmitted();
    fire(document.getElementById("m1")!, "click");
    fire(document.getElementById("m1")!, "click");
    tick(5000);
    findKey();
    expect(seen.filter((s) => s.type === "searching")).toEqual([]);
  });

  it("find-in-page and scrolling back and forth together", () => {
    const { seen, tick } = setup(`<p>long page</p>`);
    for (const y of [0, 600, 100, 700, 50, 800, 0]) {
      scrollTo(y);
      tick(2500);
    }
    findKey();
    expect(seen.filter((s) => s.type === "searching").map((s) => s.signs)).toEqual([["scrolled", "find"]]);
    scrollTo(0);
  });

  it("hunting through the tabs of one screen is one search, reported on the screen", () => {
    const { seen, tick, go } = setup(`${buttons(6)}<button id="t1" role="tab">Display</button><button id="t2" role="tab">Billing</button>`);
    go("/settings/~profile");
    hoverAll(6, tick);
    tick(5000);
    fire(document.getElementById("t1")!, "click");
    go("/settings/~display"); // the selected tab is a view of its own
    tick(8000);
    fire(document.getElementById("t2")!, "click");
    go("/settings/~billing");
    expect(seen.filter((s) => s.type === "searching")).toEqual([]); // 14.8s: not yet
    tick(1000);
    hoverAll(1, tick);
    expect(seen.filter((s) => s.type === "searching")).toEqual([{ type: "searching", page: "/settings", count: 6, durationMs: 15_800, signs: ["hovered", "menus"] }]);
  });

  it("going back and forth between two pages is one search across both", () => {
    const { seen, tick, go } = setup(`<button id="m1" aria-haspopup="true">More</button>`);
    go("/import/platform");
    tick(4000);
    go("/import/method");
    tick(4000);
    go("/import/platform"); // back
    tick(4000);
    go("/import/method"); // and forth again
    tick(7000);
    fire(document.getElementById("m1")!, "click");
    fire(document.getElementById("m1")!, "click");
    // Timed from the first arrival on the pair, not from each bounce.
    expect(seen.filter((s) => s.type === "searching")).toEqual([{ type: "searching", page: "/import/method", count: 0, durationMs: 15_000, signs: ["menus", "back_and_forth"] }]);
  });
});

describe("failed drags", () => {
  const drag = (el: Element, dx: number) => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10 + dx, clientY: 10 }));
  };
  it("a card dragged and dropped twice that goes back where it started", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<ul><li id="c" style="cursor: grab">Send invitations</li><li>Other</li></ul>`);
    const card = document.getElementById("c")!;
    drag(card, 200);
    vi.advanceTimersByTime(600);
    expect(seen.filter((s) => s.type === "failed_drag")).toEqual([]);
    drag(card, 200);
    vi.advanceTimersByTime(600);
    expect(seen.filter((s) => s.type === "failed_drag")).toEqual([{ type: "failed_drag", page: "/settings/bank", target: "Send invitations", count: 2 }]);
  });

  it("not when the drop was taken: the card moved", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<ul id="a"><li id="c" style="cursor: grab">Card</li></ul><ul id="b"></ul>`);
    const card = document.getElementById("c")!;
    for (let i = 0; i < 2; i++) {
      drag(card, 200);
      (i === 0 ? document.getElementById("b") : document.getElementById("a"))!.append(card); // the app moved it
      vi.advanceTimersByTime(600);
    }
    expect(seen.filter((s) => s.type === "failed_drag")).toEqual([]);
  });

  it("not when it was saved, and not for things that aren't made to be dragged (selecting text)", () => {
    vi.useFakeTimers();
    const { seen, cap } = setup(`<li id="c" style="cursor: grab">Card</li><p id="t">Some text to select</p>`);
    for (let i = 0; i < 2; i++) {
      drag(document.getElementById("c")!, 200);
      cap.markSubmitted(); // the move was saved; the app redraws it in place
      vi.advanceTimersByTime(600);
      drag(document.getElementById("t")!, 200);
      vi.advanceTimersByTime(600);
    }
    expect(seen.filter((s) => s.type === "failed_drag")).toEqual([]);
  });

  it("a small nudge isn't a drag", () => {
    vi.useFakeTimers();
    const { seen } = setup(`<li id="c" style="cursor: grab">Card</li>`);
    for (let i = 0; i < 3; i++) {
      drag(document.getElementById("c")!, 15);
      vi.advanceTimersByTime(600);
    }
    expect(seen.filter((s) => s.type === "failed_drag")).toEqual([]);
  });
});

describe("u-turns and pop-ups", () => {
  it("closing a pop-up quickly is not a u-turn; leaving a page straight back is", () => {
    const { seen, go, tick } = setup(`<p>x</p>`);
    go("/invoices/7");
    tick(4000);
    go("/invoices/7/~add-a-line");
    tick(1000);
    go("/invoices/7"); // closed the pop-up after a look
    expect(seen.filter((s) => s.type === "u_turn")).toEqual([]);
    tick(4000);
    go("/reports");
    tick(1000);
    go("/invoices/7"); // straight back from another page
    expect(seen.filter((s) => s.type === "u_turn")).toEqual([{ type: "u_turn", page: "/reports", durationMs: 1000 }]);
  });
});

describe("command menus and search boxes", () => {
  const menu = `<div role="dialog" aria-label="Commands"><input role="combobox" aria-controls="cmds" placeholder="Type a command…"><ul role="listbox" id="cmds"></ul></div>`;
  const typeIn = (value: string, results: string) => {
    const input = document.querySelector("input") as HTMLInputElement;
    document.getElementById("cmds")!.innerHTML = results;
    type(input, value);
  };
  it("two searches of a ⌘K menu that find nothing, read from the menu itself", () => {
    vi.useFakeTimers();
    const { seen } = setup(menu);
    typeIn("export", "<li>No matching commands</li>");
    vi.advanceTimersByTime(1300);
    typeIn("export data", "<li>No matching commands</li>");
    vi.advanceTimersByTime(1300);
    expect(seen.filter((s) => s.type === "no_results")).toEqual([expect.objectContaining({ type: "no_results", count: 2 })]);
  });

  it("typing in a command menu and closing it is not abandoning a form", () => {
    const { seen, go } = setup(menu);
    typeIn("new", "<li>New issue</li>");
    typeIn("new iss", "<li>New issue</li>");
    go("/elsewhere");
    expect(seen.filter((s) => s.type === "form_abandon")).toEqual([]);
  });
});

describe("forms that save as you type", () => {
  it("re-editing a field whose saves go through is writing; whose saves fail is struggling", () => {
    const { seen, tick, cap } = setup(`<textarea name="bio"></textarea><input name="website">`);
    const bio = document.querySelector("[name=bio]") as HTMLInputElement;
    const site = document.querySelector("[name=website]") as HTMLInputElement;
    for (let i = 0; i < 5; i++) {
      type(bio, `draft ${i}`);
      cap.markSubmitted(true); // saved
      tick(3000);
    }
    for (let i = 0; i < 4; i++) {
      type(site, `site${i}.com`);
      cap.markSubmitted(false); // refused
      tick(3000);
    }
    expect(seen.filter((s) => s.type === "field_churn").map((s) => s.target)).toEqual(["website"]);
  });
});
