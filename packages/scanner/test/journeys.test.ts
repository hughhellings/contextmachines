import { describe, expect, it } from "vitest";
import { chooseStep, CRASH_WORDS, endOf, findJourneys, JOURNEY_LEGEND, JourneyWalk, movedOn, saidDone, signUpJourney, STEP_STILL_MORE_MS, STEP_STILL_MS, stepSettled, stepsToValue, stopOf, stopOfField, trailStop, walkOne, type Drive, type Journey, type Resume, type ScreenNow, type StepControl, type StepLook, type StepState, type WalkedJourney } from "../src/journeys.ts";
import type { ScreenReview } from "../src/checks.ts";

const says = (text: string, around = "", marks = "") => ({ text, around, marks });
const control = (label: string, more: Partial<StepControl> = {}): StepControl => ({ mark: label, label, where: "main", disabled: false, primary: false, group: "", says: says(label), ...more });
const look = (more: Partial<StepLook> = {}): StepLook => ({ path: "/trades", placed: true, fieldsKey: "", rows: 0, text: "", busy: false, ...more });
const screenNow = (more: Partial<ScreenNow> = {}): ScreenNow => ({ ...look(), controls: [], files: 0, looseBox: false, looseFields: 0, ...more });
const state = (more: Partial<StepState> = {}): StepState => ({ pressed: new Set(), sent: new Set(), moved: 0, firstRun: false, ...more });
const review = (more: Partial<ScreenReview> = {}): ScreenReview => ({ path: "/trades", text: [], controls: [], locked: [], empty: [], ...more });

describe("what's a stop", () => {
  it("knows money, mail and outside accounts by their words", () => {
    expect(stopOf(says("Pay now"))).toBe("payment");
    expect(stopOf(says("Checkout"))).toBe("payment");
    expect(stopOf(says("Upgrade to Pro"))).toBe("paywall");
    expect(stopOf(says("Start free trial"))).toBe("paywall");
    expect(stopOf(says("Start 5-day free trial"))).toBe("paywall");
    expect(stopOf(says("Try Pro for a 14 day trial"))).toBe("paywall");
    expect(stopOf(says("Disconnect"))).toBe("disconnects");
    expect(stopOf(says("Unlink account"))).toBe("disconnects");
    expect(stopOf(says("Connect a bank"))).toBe("third_party");
    expect(stopOf(says("Continue with Google"))).toBe("third_party");
    expect(stopOf(says("Send invite"))).toBe("email");
    expect(stopOf(says("Invite teammates"))).toBe("email");
    expect(stopOf(says("Create account"))).toBe("account");
    expect(stopOf(says("Change password"))).toBe("account");
    expect(stopOf(says("Export to PDF"))).toBe("download");
    expect(stopOf(says("Clear filters"))).toBe("destroys");
  });

  it("never presses what destroys or signs out, whatever else it says", () => {
    expect(stopOf(says("Log out"))).toBe("sign_out");
    expect(stopOf(says("Delete trade"))).toBe("destroys");
    expect(stopOf(says("Yes", "Delete this for good?"))).toBe("destroys");
    expect(stopOf(says("", "", "btn btn-danger"))).toBe("destroys");
  });

  it("goes by where a control leads, however it reads", () => {
    expect(stopOf(says("Docs"), { href: "https://elsewhere.example/docs", origin: "http://localhost:3000" })).toBe("leaves_site");
    expect(stopOf(says("Go"), { href: "https://accounts.example/oauth/authorize", origin: "http://localhost:3000" })).toBe("third_party");
    expect(stopOf(says("Contact us"), { href: "mailto:hello@example.test" })).toBe("email");
    expect(stopOf(says("Report"), { away: true })).toBe("leaves_site");
    expect(stopOf(says("Trades"), { href: "http://localhost:3000/trades", origin: "http://localhost:3000" })).toBeUndefined();
  });

  it("leaves alone what only looks like one", () => {
    expect(stopOf(says("See them with Pro"))).toBe("paywall");
    for (const label of ["Connections", "Market share", "Sending times", "Pro tips", "Add trade", "Continue", "Linked accounts", "Payments overview", "Save trade", "Import trades"]) {
      expect(stopOf(says(label)), label).toBeUndefined();
    }
  });

  it("won't type into a card box", () => {
    expect(stopOfField("cc-number card")).toBe("payment");
    expect(stopOfField("cvv")).toBe("payment");
    expect(stopOfField("iban")).toBe("payment");
    expect(stopOfField("password new-password next")).toBe("account");
    expect(stopOfField("name company")).toBeUndefined();
  });

  it("reads the trail for what no label said", () => {
    expect(trailStop([{ kind: "save", where: "/rest/v1/trades" }, { kind: "payment", where: "/api/checkout" }])).toEqual({ kind: "payment", label: "/api/checkout" });
    expect(trailStop([{ kind: "kept", where: "/rest/v1/trades" }, { kind: "save", where: "/api/x" }])).toBeUndefined();
  });
});

describe("what counts as moving on", () => {
  it("counts a new screen, a step, a pop-up and more rows", () => {
    expect(movedOn(look(), look({ path: "/trades/new" }))).toBe("address");
    expect(movedOn(look({ marker: "1 of 3" }), look({ marker: "2 of 3" }))).toBe("step");
    expect(movedOn(look(), look({ dialog: "Add trade" }))).toBe("dialog");
    expect(movedOn(look({ dialog: "Add trade" }), look())).toBe("dialog");
    expect(movedOn(look({ rows: 1 }), look({ rows: 2 }))).toBe("list");
    expect(movedOn(look({ fieldsKey: "a,b", heading: "One" }), look({ fieldsKey: "c", heading: "Two" }))).toBe("step");
  });

  it("doesn't count a button's words, a spinner, a toast or an alert", () => {
    expect(movedOn(look({ text: "Save" }), look({ text: "Saving…" }))).toBeUndefined();
    expect(movedOn(look({ rows: 1 }), look({ rows: 2, busy: true }))).toBeUndefined();
    expect(movedOn(look(), look({ text: "Saved!" }))).toBeUndefined();
    expect(movedOn(look({ fieldsKey: "a" }), look({ fieldsKey: "a", alert: "Name is required" }))).toBeUndefined();
    expect(movedOn(look(), look({ path: "/trades/new", alert: "Couldn't save" }))).toBeUndefined();
  });

  it("doesn't count an address that isn't a screen", () => {
    expect(movedOn(look(), look({ path: "/", placed: false }))).toBeUndefined();
  });
});

describe("the next step", () => {
  it("ends at a wall, and a paywall is a stop", () => {
    expect(chooseStep(screenNow({ wall: "failed" }), state())).toEqual({ do: "wall" });
    expect(chooseStep(screenNow({ wall: "paywall", heading: "Choose a plan" }), state())).toMatchObject({ do: "stop", kind: "paywall" });
  });

  it("deals with what's open first", () => {
    const now = screenNow({ dialog: "Welcome", controls: [control("Get started"), control("Next", { where: "dialog" })] });
    expect(chooseStep(now, state())).toMatchObject({ do: "press", control: { label: "Next" } });
  });

  it("fills a form before anything else on the screen, and only once", () => {
    const now = screenNow({ form: { key: "f", inDialog: false }, controls: [control("Continue")] });
    expect(chooseStep(now, state())).toEqual({ do: "fill", inDialog: false });
    expect(chooseStep(now, state({ sent: new Set(["f"]) }))).toMatchObject({ do: "press", control: { label: "Continue" } });
  });

  it("stops at a form that asks for a card, and a file choice", () => {
    expect(chooseStep(screenNow({ form: { key: "f", inDialog: false, stop: "payment", label: "Pay" } }), state())).toMatchObject({ do: "stop", kind: "payment" });
    expect(chooseStep(screenNow({ files: 1 }), state())).toMatchObject({ do: "stop", kind: "file" });
  });

  it("presses what it's here for, and stops if that's a stop", () => {
    expect(chooseStep(screenNow({ controls: [control("Add trade")] }), state({ goal: "add trade" }))).toMatchObject({ do: "press", control: { label: "Add trade" } });
    expect(chooseStep(screenNow({ controls: [control("Connect a bank")] }), state({ goal: "Connect a bank" }))).toMatchObject({ do: "stop", kind: "third_party", byLabel: true });
  });

  it("takes the way on before putting it off", () => {
    const now = screenNow({ controls: [control("Skip for now"), control("Continue")] });
    expect(chooseStep(now, state())).toMatchObject({ control: { label: "Continue" } });
    expect(chooseStep(screenNow({ controls: [control("Skip for now")] }), state())).toMatchObject({ control: { label: "Skip for now" } });
  });

  it("takes the first of a group and hands back the rest, stops aside", () => {
    const peers = [control("Upload", { group: "g" }), control("Enter by hand", { group: "g" }), control("Connect a bank", { group: "g" })];
    const choice = chooseStep(screenNow({ controls: peers }), state());
    expect(choice).toMatchObject({ do: "press", control: { label: "Upload" } });
    expect(choice.do === "press" && choice.branches?.map((c) => c.label)).toEqual(["Enter by hand"]);
  });

  it("takes the choice whose words are rarest among them and said by what it's after", () => {
    const peers = [control("Notebook one, for your trade history", { group: "g" }), control("Notebook two, for your trade history", { group: "g" }), control("Something else, Manual only", { group: "g" })];
    expect(chooseStep(screenNow({ controls: peers }), state({ seek: "Adds a manually entered trade" }))).toMatchObject({ control: { label: "Something else, Manual only" } });
    expect(chooseStep(screenNow({ controls: peers }), state({ seek: "nothing like them" }))).toMatchObject({ control: { label: "Notebook one, for your trade history" } });
  });

  it("past the first move, a plain screen is the end: a leftover button isn't part of the journey", () => {
    const now = screenNow({ controls: [control("Refresh totals", { primary: true }), control("Export", { group: "g" }), control("Share view", { group: "g" })] });
    expect(chooseStep(now, state({ moved: 1 }))).toEqual({ do: "end" });
  });

  it("doesn't press one thing twice on a screen", () => {
    const now = screenNow({ controls: [control("Continue")] });
    const first = chooseStep(now, state());
    expect(first.do).toBe("press");
    const pressed = new Set([`${now.path}|||continue`]);
    expect(chooseStep(now, state({ pressed }))).toEqual({ do: "end" });
  });

  it("calls the only way on a stop rather than the end of the road", () => {
    expect(chooseStep(screenNow({ controls: [control("Upgrade to Pro")] }), state())).toMatchObject({ do: "stop", kind: "paywall" });
  });

  it("never offers to press what destroys or signs out, even if nothing else is there", () => {
    expect(chooseStep(screenNow({ controls: [control("Log out"), control("Delete account")] }), state())).toEqual({ do: "end" });
  });

  it("types into loose boxes only on a way that's under way", () => {
    expect(chooseStep(screenNow({ looseFields: 2 }), state({ moved: 1 }))).toEqual({ do: "loose" });
    expect(chooseStep(screenNow({ looseFields: 2 }), state())).toEqual({ do: "end" });
  });
});

describe("how a journey ends", () => {
  it("finishes only with the screens moved on and nothing left in the way", () => {
    expect(endOf(screenNow(), { moved: 1, sent: new Set() })).toEqual({ outcome: "finished" });
    expect(endOf(screenNow({ marker: "4 of 4" }), { moved: 1, sent: new Set() })).toEqual({ outcome: "finished" });
    expect(endOf(screenNow(), { moved: 0, sent: new Set() })).toEqual({ outcome: "couldnt_follow", why: "no_next" });
    expect(endOf(screenNow({ dialog: "Still here" }), { moved: 1, sent: new Set() })).toEqual({ outcome: "couldnt_follow", why: "no_next" });
    expect(endOf(screenNow({ marker: "2 of 4" }), { moved: 1, sent: new Set() })).toEqual({ outcome: "couldnt_follow", why: "no_next" });
  });

  it("counts steps to first value only from a main journey that finished", () => {
    const main: WalkedJourney = { name: "Add trade", from: "/trades", main: true, outcome: "finished", steps: [{ screen: "/trades", did: "open" }, { screen: "/trades", did: "press", label: "Add trade" }, { screen: "/trades/new", did: "fill", label: "Save" }], seenWith: "stand-in" };
    expect(stepsToValue([main])).toEqual({ presses: 1, fields: 1, screens: 2, atLeast: true, from: "/trades", fromFirstRun: false, to: "Save" });
    expect(stepsToValue([{ ...main, outcome: "stopped_here" }])).toBeUndefined();
    expect(stepsToValue([{ ...main, main: false }])).toBeUndefined();
    expect(stepsToValue([{ ...main, main: false, saved: "seen" }])).toMatchObject({ firstSave: true });
  });
});

describe("finding journeys", () => {
  const screens = [
    review({
      path: "/trades",
      empty: [{ text: "No trades yet", next: "Add your first trade" }],
      controls: [
        { label: "Import trades", kind: "button", where: "main" },
        { label: "Refresh", kind: "button", where: "main" },
        { label: "Upgrade to Pro", kind: "button", where: "main" },
        { label: "Connect a bank", kind: "button", where: "main" },
        { label: "Log out", kind: "button", where: "nav" },
        { label: "Delete all", kind: "button", where: "main" },
        { label: "New note", kind: "link", where: "nav" },
        { label: "Add", kind: "button", where: "main", states: ["disabled"] },
      ],
      locked: [{ label: "Patterns", why: "badge" }, { label: "Upgrade to see patterns", why: "says" }],
    }),
    review({ path: "/welcome", controls: [{ label: "Continue", kind: "button", where: "main" }] }),
  ];
  const found = findJourneys({ screens, first: "/welcome", firstRun: ["/onboarding"] });

  it("has the first run first, what's offered, and what starts something", () => {
    expect(found.journeys.map((j) => j.name)).toEqual(["First run", "First run", "Add your first trade", "Import trades"]);
    expect(found.journeys[0]).toMatchObject({ start: "/onboarding", firstRun: true });
  });

  it("lists what would touch the outside world with no browser time, and never queues it", () => {
    expect(found.stops.map((s) => [s.name, s.stop?.kind])).toEqual([["Upgrade to Pro", "paywall"], ["Connect a bank", "third_party"], ["Patterns", "paywall"]]);
    expect(found.stops.every((s) => s.outcome === "stopped_here")).toBe(true);
  });

  it("only counts what destroys or signs out", () => {
    expect(found.leftAlone).toBe(2);
    expect(found.journeys.map((j) => j.name).join()).not.toMatch(/Delete|Log out/);
  });

  it("takes nothing from a made-up row, or a screen that doesn't offer it", () => {
    const none = findJourneys({ screens: [review({ empty: [{ text: "x", next: "(made-up row)" }], controls: [{ label: "(made-up row)", kind: "button", where: "main" }] })], firstRun: [] });
    expect(none.journeys).toEqual([]);
  });

  it("says where a sign-up stops, with nothing pressed, and names its outside sign-ins", () => {
    const [plain, google] = signUpJourney([review({ path: "/signup", controls: [{ label: "Email", kind: "field", where: "main" }, { label: "Password", kind: "field", where: "main" }, { label: "Create account", kind: "button", where: "main" }, { label: "Continue with Google", kind: "button", where: "main" }] })]);
    expect(plain).toMatchObject({ name: "Sign up", outcome: "stopped_here", fields: 2, stop: { kind: "account", label: "Create account" } });
    expect(google).toMatchObject({ name: "Continue with Google", outcome: "stopped_here", stop: { kind: "third_party" } });
    expect(signUpJourney([review({ path: "/login" })])).toEqual([]);
  });
});

/** A drive over a script of screens: a press goes where the script says, and nothing else happens. */
function scripted(pages: Record<string, ScreenNow>, moves: Record<string, string>, trails: Record<string, { kind: "kept" | "save" | "payment" | "email"; where: string }[]> = {}, options: { echoed?: boolean; kept?: string[]; stop?: () => boolean } = {}) {
  let at = Object.keys(pages)[0]!;
  const trail: { kind: "kept" | "save" | "payment" | "email"; where: string }[] = [];
  const pressed: string[] = [];
  const drive: Drive = {
    reset: async () => {},
    open: async (path) => {
      if (!pages[path]) return false;
      at = path;
      return true;
    },
    look: async () => pages[at]!,
    press: async (mark) => {
      pressed.push(mark);
      trail.push(...(trails[mark] ?? []));
      if (moves[mark]) at = moves[mark]!;
      return true;
    },
    fill: async () => {
      pressed.push("the form");
      trail.push(...(trails["the form"] ?? []));
      if (moves["the form"]) at = moves["the form"]!;
      return "sent";
    },
    loose: async () => true,
    review: async () => undefined,
    trail: () => trail,
    keptIn: (text) => (options.kept ?? []).filter((word) => text.includes(word)),
    reopen: async (path) => drive.open(path),
    forgetServed: () => {},
    // An echo is what an app says from its own memory: words on the screen no read handed it.
    keptServedIn: (text) => (options.echoed ? [] : (options.kept ?? []).filter((word) => text.includes(word))),
    plain: (text) => text,
    stopped: options.stop ?? (() => false),
    origin: "http://localhost:3000",
  };
  return { drive, pressed };
}

describe("what no label says", () => {
  it("stops at a card or password box with no form around it", () => {
    expect(chooseStep(screenNow({ asks: "payment", controls: [control("Continue", { primary: true })] }), state())).toMatchObject({ do: "stop", kind: "payment", byLabel: true });
    expect(stopOfField("text cc-number card")).toBe("payment");
    expect(stopOfField("cc-csc")).toBe("payment");
    expect(stopOfField("password new-password")).toBe("account");
    expect(stopOfField("text cc-names-here notes")).toBeUndefined();
  });

  it("hears a screen say it's taken money or sent mail, only once it's said", () => {
    expect(saidDone(look(), look({ text: "We took 49 from your card" }))).toMatchObject({ kind: "payment" });
    expect(saidDone(look(), look({ text: "Order placed" }))).toMatchObject({ kind: "payment" });
    expect(saidDone(look(), look({ text: "Your whole team has an email from us now" }))).toMatchObject({ kind: "email" });
    expect(saidDone(look(), look({ text: "Check your inbox" }))).toMatchObject({ kind: "email" });
    expect(saidDone(look({ text: "Order placed yesterday" }), look({ text: "Order placed yesterday" }))).toBeUndefined();
    expect(saidDone(look(), look({ text: "Your orders and your card on file" }))).toBeUndefined();
    expect(saidDone(look(), look({ text: "Emails you send appear here" }))).toBeUndefined();
  });

  it("knows a crash on a screen, and that's no move on", () => {
    for (const words of ["Oops", "Something went wrong", "TypeError: cannot read properties of undefined", "This page crashed"]) expect(CRASH_WORDS.test(words)).toBe(true);
    for (const words of ["No errors today", "Your trades", "Whoops, nothing here yet"]) expect(CRASH_WORDS.test(words)).toBe(false);
    expect(movedOn(look(), look({ path: "/next", crashed: true }))).toBeUndefined();
    expect(movedOn(look({ crashed: true }), look({ path: "/next", crashed: true }))).toBe("address");
  });
});

describe("walking one journey", () => {
  it("goes end to end, and says finished", async () => {
    const pages = {
      "/trades": screenNow({ controls: [control("Add trade")] }),
      "/trades/new": screenNow({ path: "/trades/new", form: { key: "f", label: "Save", inDialog: false }, fieldsKey: "a", controls: [control("Save")] }),
      "/trades/done": screenNow({ path: "/trades/done", rows: 1, text: "Your trade Test name" }),
    };
    const { drive } = scripted(pages, { "Add trade": "/trades/new", "the form": "/trades/done" }, { "the form": [{ kind: "kept", where: "/rest/v1/trades" }] }, { kept: ["test name"] });
    pages["/trades/done"].text = "your trade test name";
    const walked = await walkOne({ name: "Add trade", start: "/trades", via: [], goal: "Add trade" }, drive, () => {});
    expect(walked).toMatchObject({ outcome: "finished", saved: "seen", seenWith: "stand-in" });
    expect(walked.steps.map((s) => s.did)).toEqual(["open", "press", "fill"]);
  });

  it("hears what a press set off after its look ended, before it says how the walk ended", async () => {
    // A press that waits a beat before it sends: its own look is over, and what's next is a look for more.
    const pages = {
      "/a": screenNow({ path: "/a", controls: [control("Continue")] }),
      "/b": screenNow({ path: "/b", dialog: "Step 2 of 2", marker: "2 of 2", text: "All set" }),
    };
    const { drive } = scripted(pages, { Continue: "/b" });
    const look = drive.look;
    let looks = 0;
    drive.look = async (...args) => {
      const now = await look(...args);
      // The look after the press is done; the next one sees the late send land.
      if (++looks === 3) (drive.trail() as { kind: string; where: string }[]).push({ kind: "payment", where: "/api/checkout" });
      return now;
    };
    const walked = await walkOne({ name: "Continue", start: "/a", via: [] }, drive, () => {});
    expect(walked).toMatchObject({ outcome: "stopped_here", stop: { kind: "payment", label: "/api/checkout", byLabel: false } });
  });

  it("says unknown, never lost, when what was saved doesn't draw", async () => {
    const pages = {
      "/trades": screenNow({ controls: [control("Add trade")] }),
      "/done": screenNow({ path: "/done" }),
    };
    const { drive } = scripted(pages, { "Add trade": "/done" }, { "Add trade": [{ kind: "kept", where: "/rest/v1/trades" }] });
    expect(await walkOne({ name: "Add trade", start: "/trades", via: [], goal: "Add trade" }, drive, () => {})).toMatchObject({ outcome: "finished", saved: "unknown" });
  });

  it("says only what was seen of what the code names, and doesn't go looking", async () => {
    const pages = { "/trades": screenNow({ controls: [control("Something else", { primary: true })] }) };
    expect(await walkOne({ name: "Add note", start: "/trades", via: [], goal: "Add note" }, scripted(pages, {}).drive, () => {})).toMatchObject({ outcome: "not_reached", because: "it wasn't on the first screen there, and what opens it wasn't found" });
  });

  it("doesn't take a new account's first run for a journey sent there, even the main one", async () => {
    const pages = {
      "/brief": screenNow({ path: "/welcome", controls: [control("Continue", { primary: true })], marker: "1 of 4" }),
      "/welcome": screenNow({ path: "/welcome", controls: [control("Continue", { primary: true })], marker: "1 of 4" }),
    };
    const walked = await walkOne({ name: "Watch this", start: "/brief", via: [], goal: "Watch this", main: true }, scripted(pages, {}).drive, () => {});
    expect(walked).toMatchObject({ outcome: "not_reached", because: "a new account is sent to /welcome first" });
    expect(walked.steps).toHaveLength(1);
  });

  it("won't say a save showed on an echo of the app's own memory", async () => {
    const pages = {
      "/trades": screenNow({ controls: [control("Add trade")] }),
      "/done": screenNow({ path: "/done", text: "saved audcad" }),
    };
    const { drive } = scripted(pages, { "Add trade": "/done" }, { "Add trade": [{ kind: "kept", where: "/rest/v1/trades" }] }, { kept: ["audcad"], echoed: true });
    expect(await walkOne({ name: "Add trade", start: "/trades", via: [], goal: "Add trade" }, drive, () => {})).toMatchObject({ outcome: "finished", saved: "unknown" });
  });

  it("presses what it came for once, and counts to the first save and no further", async () => {
    const form = { key: "f", label: "Create setup", inDialog: false };
    const pages = {
      "/setups": screenNow({ path: "/setups", heading: "No setups", controls: [control("+ New setup", { primary: true })] }),
      "/setups/form": screenNow({ path: "/setups/form", heading: "No setups", form, fieldsKey: "a", marker: undefined, controls: [control("+ New setup")] }),
      "/setups/one": screenNow({ path: "/setups/one", heading: "1 setup", controls: [control("+ New setup", { primary: true })] }),
    };
    const { drive, pressed } = scripted(pages, { "+ New setup": "/setups/form", "the form": "/setups/one" }, { "the form": [{ kind: "kept", where: "/rest/v1/setups" }] });
    const walked = await walkOne({ name: "+ New setup", start: "/setups", via: [], goal: "+ New setup" }, drive, () => {});
    expect(pressed).toEqual(["+ New setup", "the form"]);
    expect(stepsToValue([{ ...walked, steps: [...walked.steps, { screen: "/setups/one", did: "press", label: "After" }], main: true }])).toMatchObject({ presses: 1, fields: 1, to: "Create setup", from: "/setups", fromFirstRun: false });
  });

  it("says a journey that moved on without its goal didn't finish", async () => {
    const pages = {
      "/a": screenNow({ path: "/a", controls: [control("Continue")] }),
      "/b": screenNow({ path: "/b" }),
    };
    const walked = await walkOne({ name: "Save trade", start: "/a", via: [], goal: "Save trade", main: true }, scripted(pages, { Continue: "/b" }).drive, () => {});
    expect(walked).toMatchObject({ outcome: "couldnt_follow", why: "no_next" });
  });

  it("takes a form sent by what it came for as pressing it", async () => {
    const pages = {
      "/a": screenNow({ path: "/a", form: { key: "f", label: "Save trade", inDialog: false }, fieldsKey: "a" }),
      "/b": screenNow({ path: "/b" }),
    };
    expect(await walkOne({ name: "Save trade", start: "/a", via: [], goal: "Save trade", long: true }, scripted(pages, { "the form": "/b" }).drive, () => {})).toMatchObject({ outcome: "finished" });
  });

  it("calls a crash after a pretend answer the walk's limit, on a new address too, and counts nothing to it", async () => {
    const pages = {
      "/new": screenNow({ path: "/new", form: { key: "f", label: "Save", inDialog: false }, fieldsKey: "a" }),
      "/oops": screenNow({ path: "/oops", heading: "Oops", crashed: true, text: "This page crashed" }),
    };
    const { drive } = scripted(pages, { "the form": "/oops" }, { "the form": [{ kind: "kept", where: "/api/others" }] });
    const walked = await walkOne({ name: "New", start: "/new", via: [] }, drive, () => {});
    expect(walked).toMatchObject({ outcome: "couldnt_follow", why: "after_pretend" });
    expect(stepsToValue([walked])).toBeUndefined();
  });

  it("stops at a screen saying something real was done, and never reads that as finished", async () => {
    for (const [words, kind] of [["We took 49 from your card", "payment"], ["Your whole team has an email from us now", "email"]] as const) {
      const pages = {
        "/order": screenNow({ path: "/order", controls: [control("Finish up", { primary: true })] }),
        "/thanks": screenNow({ path: "/thanks", text: words }),
      };
      expect(await walkOne({ name: "Order", start: "/order", via: [] }, scripted(pages, { "Finish up": "/thanks" }).drive, () => {})).toMatchObject({ outcome: "stopped_here", stop: { kind, byLabel: false } });
    }
  });

  it("tells a choice that came to a stop from the journey, and tries the others", async () => {
    const cards = [control("Upload a file", { group: "g", says: says("Upload a file Any statement") }), control("Auto-sync", { group: "g" }), control("Add one trade", { group: "g" })];
    const pages = {
      "/welcome": screenNow({ path: "/welcome", marker: "5 of 6", controls: cards }),
      "/welcome/drop": screenNow({ path: "/welcome/drop", marker: "5 of 6", files: 1 }),
    };
    const others: string[] = [];
    const { drive } = scripted(pages, { "Upload a file": "/welcome/drop" });
    const walked = await walkOne({ name: "First run", start: "/welcome", via: [], firstRun: true }, drive, () => {}, undefined, undefined, (_from, other) => others.push(other.label));
    expect(walked).toMatchObject({ outcome: "stopped_here", stop: { kind: "file" }, pick: { label: "Upload a file", of: 3 }, firstRun: true });
    expect(others).toEqual(["Add one trade", "Auto-sync"]);
    expect(walked.steps.at(-1)).toMatchObject({ did: "stop" });
  });

  it("of a catalogue tries the one that reads least like what ended in a stop, and no tree of them", async () => {
    const card = (label: string, words: string) => control(label, { group: "g", says: says(`${label} ${words}`) });
    const cards = [card("Alpha", "file upload history"), card("Beta", "file upload history"), card("Gamma", "file upload notes"), card("Delta", "manual entry bank"), card("Omega", "file upload history")];
    const pages = {
      "/pick": screenNow({ path: "/pick", marker: "1 of 3", controls: cards }),
      "/drop": screenNow({ path: "/drop", marker: "2 of 3", files: 1 }),
    };
    const others: string[] = [];
    const { drive } = scripted(pages, { Alpha: "/drop" });
    await walkOne({ name: "Add trade", start: "/pick", via: [], firstRun: true }, drive, () => {}, undefined, undefined, (_from, other) => others.push(other.label));
    expect(others).toEqual(["Delta"]);
    await walkOne({ name: "Add trade", start: "/pick", via: [], firstRun: true, chose: true, goal: "Alpha" }, drive, () => {}, undefined, undefined, (_from, other) => others.push(other.label));
    expect(others).toEqual(["Delta"]);
  });

  it("tries the next group of choices first: it may read the same and go elsewhere", async () => {
    const cards = [control("Alpha", { group: "a" }), control("Beta", { group: "a" }), control("Gamma", { group: "b" }), control("Delta", { group: "b" })];
    const pages = {
      "/pick": screenNow({ path: "/pick", marker: "1 of 3", controls: cards }),
      "/drop": screenNow({ path: "/drop", marker: "2 of 3", files: 1 }),
    };
    const others: string[] = [];
    const walked = await walkOne({ name: "Add trade", start: "/pick", via: [], firstRun: true }, scripted(pages, { Alpha: "/drop" }).drive, () => {}, undefined, undefined, (_from, other) => others.push(other.label));
    expect(others).toEqual(["Gamma", "Beta"]);
    expect(walked.pick).toEqual({ label: "Alpha", of: 3 });
  });

  it("ends the first run where it leaves the first run, and counts to the save it came for", async () => {
    const pages = {
      "/welcome": screenNow({ path: "/welcome", marker: "1 of 2", form: { key: "about", label: "Next", inDialog: false }, fieldsKey: "a" }),
      "/welcome/2": screenNow({ path: "/welcome/2", marker: "2 of 2", controls: [control("Add one trade", { group: "g" }), control("Upload", { group: "g" })] }),
      "/welcome/3": screenNow({ path: "/welcome/3", form: { key: "trade", label: "Save trade", inDialog: false }, fieldsKey: "b" }),
      "/welcome/4": screenNow({ path: "/welcome/4", controls: [control("Bring in your history", { primary: true })] }),
      "/import": screenNow({ path: "/import", marker: "1 of 5", controls: [control("Pick one", { primary: true })] }),
    };
    let fills = 0;
    const { drive } = scripted(pages, { "Add one trade": "/welcome/3", "Bring in your history": "/import" });
    drive.fill = async () => {
      (drive.trail() as { kind: string; where: string }[]).push({ kind: "kept", where: "/rest/v1/x" });
      await drive.open(fills++ ? "/welcome/4" : "/welcome/2");
      return "sent";
    };
    const walked = await walkOne({ name: "First run › Add one trade", start: "/welcome", via: [], goal: "Add one trade", firstRun: true, chose: true }, drive, () => {});
    expect(walked).toMatchObject({ outcome: "finished", firstRun: true });
    expect(stepsToValue([walked])).toMatchObject({ presses: 1, fields: 2, to: "Save trade", from: "/welcome", fromFirstRun: true, firstSave: true });
  });

  it("won't call another choice finished for moving a screen on with nothing saved", async () => {
    const pages = {
      "/pick": screenNow({ path: "/pick", controls: [control("Beta", { primary: true })] }),
      "/next": screenNow({ path: "/next" }),
    };
    expect(await walkOne({ name: "Add trade › Beta", start: "/pick", via: [], goal: "Beta", chose: true }, scripted(pages, { Beta: "/next" }).drive, () => {})).toMatchObject({ outcome: "couldnt_follow", why: "no_next" });
  });

  it("doesn't branch off a choice it's already trying", async () => {
    const pages = {
      "/import": screenNow({ path: "/import", controls: [control("Paste", { group: "g" }), control("Type it", { group: "g" })] }),
      "/paste": screenNow({ path: "/paste" }),
    };
    const others: string[] = [];
    await walkOne({ name: "Import › Other", start: "/import", via: [], goal: "Elsewhere", chose: true }, scripted(pages, { Paste: "/paste" }).drive, (_from, via) => others.push(via.at(-1)!));
    expect(others).toEqual([]);
  });

  it("doesn't put a far-off stop down to a choice made long before", async () => {
    const cards = [control("Forex", { group: "g" }), control("Stocks", { group: "g" })];
    const pages: Record<string, ScreenNow> = {
      "/a": screenNow({ path: "/a", marker: "1 of 6", controls: cards }),
      "/b": screenNow({ path: "/b", marker: "2 of 6", controls: [control("Continue")] }),
      "/c": screenNow({ path: "/c", marker: "3 of 6", controls: [control("Continue ")] }),
      "/d": screenNow({ path: "/d", marker: "4 of 6", controls: [control("Next")] }),
      "/e": screenNow({ path: "/e", marker: "5 of 6", controls: [control("Pay now")] }),
    };
    const walked = await walkOne({ name: "First run", start: "/a", via: [], firstRun: true }, scripted(pages, { Forex: "/b", Continue: "/c", "Continue ": "/d", Next: "/e" }).drive, () => {});
    expect(walked.outcome).toBe("stopped_here");
    expect(walked.pick).toBeUndefined();
  });

  it("stops where a press went for the outside world, whatever its label said", async () => {
    const pages = { "/plan": screenNow({ path: "/plan", controls: [control("Go ahead", { primary: true })] }), "/next": screenNow({ path: "/next" }) };
    const { drive } = scripted(pages, { "Go ahead": "/next" }, { "Go ahead": [{ kind: "payment", where: "/api/checkout" }] });
    expect(await walkOne({ name: "Plan", start: "/plan", via: [] }, drive, () => {})).toMatchObject({ outcome: "stopped_here", stop: { kind: "payment", byLabel: false } });
  });

  it("never reads an error after a pretend answer as anything but the walk's limit", async () => {
    const pages = {
      "/new": screenNow({ path: "/new", form: { key: "f", label: "Save", inDialog: false }, fieldsKey: "a" }),
      "/broken": screenNow({ path: "/broken", wall: "failed" }),
    };
    const { drive } = scripted(pages, { "the form": "/broken" }, { "the form": [{ kind: "save", where: "/rest/v1/rpc/add" }] });
    expect(await walkOne({ name: "New", start: "/new", via: [] }, drive, () => {})).toMatchObject({ outcome: "couldnt_follow", why: "after_pretend" });
  });

  it("gives up on a screen that keeps coming back, and calls it the walk's", async () => {
    const pages = { "/a": screenNow({ path: "/a", controls: [control("Continue"), control("Next"), control("Start"), control("Begin"), control("Done")] }) };
    const { drive } = scripted(pages, {});
    expect(await walkOne({ name: "Loop", start: "/a", via: [] }, drive, () => {})).toMatchObject({ outcome: "couldnt_follow", why: "loop" });
  });

  it("says not finished when time's up, and not reached when it never began", async () => {
    const pages = { "/a": screenNow({ path: "/a", controls: [control("Continue")] }) };
    expect(await walkOne({ name: "T", start: "/a", via: [] }, scripted(pages, {}).drive, () => {}, undefined, Date.now() - 1)).toMatchObject({ outcome: "not_finished", why: "time" });
    expect(await walkOne({ name: "T", start: "/nowhere", via: [] }, scripted(pages, {}).drive, () => {})).toMatchObject({ outcome: "not_reached" });
  });

  it("says not finished when its steps run out, never finished", async () => {
    const pages: Record<string, ScreenNow> = {};
    const moves: Record<string, string> = {};
    for (let n = 0; n < 15; n++) {
      pages[`/s${n}`] = screenNow({ path: `/s${n}`, controls: [control(`Continue ${n}`)] });
      moves[`Continue ${n}`] = `/s${n + 1}`;
    }
    expect(await walkOne({ name: "Long", start: "/s0", via: [] }, scripted(pages, moves).drive, () => {})).toMatchObject({ outcome: "not_finished", why: "steps" });
  });

  it("hands back the other choices of a group, to be walked apart", async () => {
    const pages = {
      "/import": screenNow({ path: "/import", controls: [control("Paste", { group: "g" }), control("Type it", { group: "g" })] }),
      "/paste": screenNow({ path: "/paste" }),
    };
    const others: string[] = [];
    const { drive } = scripted(pages, { Paste: "/paste" });
    await walkOne({ name: "Import", start: "/import", via: [] }, drive, (_from, via) => others.push(via.at(-1)!));
    expect(others).toEqual(["Type it"]);
  });
});

describe("what's said of a run", () => {
  const hints = (actions: { screen: string; label: string; does?: string; public?: boolean }[], main?: string) => ({ ...(main ? { main } : {}), actions: actions.map((a) => ({ does: "", ...a })), screens: [] });
  const walk = (found: Partial<ReturnType<typeof findJourneys>> = {}) => new JourneyWalk({ journeys: [], stops: [], leftAlone: 0, ...found }, { nav: [], signUp: () => [], saved: () => false });

  it("takes from a public screen only what reads as real", () => {
    const run = walk();
    run.addHints(hints([{ screen: "/forgot", label: "Send reset link", public: true }, { screen: "/pricing", label: "See plans", public: true }, { screen: "/login", label: "Save", public: true }]));
    const report = run.report(150_000);
    expect(report.journeys.map((j) => j.name)).toEqual(["Send reset link"]);
    expect(report.journeys[0]).toMatchObject({ outcome: "stopped_here", stop: { kind: "email" }, fromCode: true });
    expect(report.notFinished).toEqual([]);
  });

  it("leaves out what's a name in the code or a line of a screen, and names the rest with their screens", () => {
    const run = walk();
    run.addHints(hints([{ screen: "/a", label: "stop" }, { screen: "/a", label: "+ new" }, { screen: "/a", label: "+" }, { screen: "/a", label: "What is your plan for today?" }, { screen: "/a", label: "Paste a chart to add it." }, { screen: "/a/:id", label: "No setup" }, { screen: "/a", label: "Add note" }]));
    const report = run.report(150_000);
    expect(report.notFinished).toEqual(["Add note on /a, read from the code"]);
    expect(report.notReached).toEqual([{ name: "No setup", because: "it needs a record to exist", from: "/a/:id", fromCode: true }]);
  });

  it("has one total, and never a name it's said twice", () => {
    const run = walk({ stops: [{ name: "Add note", from: "/b", main: false, outcome: "stopped_here", stop: { kind: "paywall", label: "Add note", byLabel: true }, steps: [], seenWith: "stand-in" }] });
    run.addHints(hints([{ screen: "/a/:id", label: "Add note" }, { screen: "/a/:id", label: "Rename it" }, { screen: "/b", label: "Add tag" }]));
    const report = run.report(150_000);
    expect(report.notReached.map((n) => n.name)).toEqual(["Rename it"]);
    expect(report.message).toMatch(/^3 journeys found/);
  });

  it("never says it went past its limit", () => {
    const run = walk();
    const old = Date.now;
    Date.now = () => old() + 200_000;
    expect(run.report(150_000).seconds).toBe(150);
    Date.now = old;
  });
});

describe("trying the other choices", () => {
  it("goes the same way there, one at once and the rest when all else is walked", async () => {
    const groups = [control("Alpha", { group: "g", title: "Alpha" }), control("Beta", { group: "g", title: "Beta" }), control("Gamma", { group: "g", title: "Gamma" })];
    const pages: Record<string, ScreenNow> = {
      "/list": screenNow({ path: "/list", controls: [control("Add note")] }),
      "/other": screenNow({ path: "/other", text: "other", controls: [control("Plain thing")] }),
      "/pick": screenNow({ path: "/pick", marker: "1 of 2", controls: groups }),
      "/drop": screenNow({ path: "/drop", marker: "2 of 2", files: 1 }),
      "/done": screenNow({ path: "/done" }),
    };
    const walk = new JourneyWalk({ journeys: [{ name: "Add note", start: "/list", via: [], goal: "Add note" }, { name: "Add other", start: "/other", via: [], goal: "Plain thing" }], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    let opened = 0;
    const { drive, pressed } = scripted(pages, { "Add note": "/pick", Alpha: "/drop", Beta: "/done", Gamma: "/done", "Plain thing": "/done" }, {}, { stop: () => ++opened > 60 });
    await walk.run(drive);
    expect(pressed).toEqual(["Add note", "Alpha", "Plain thing", "Add note", "Beta", "Add note", "Gamma"]);
    expect(walk.report(150_000).journeys.map((j) => j.name)).toEqual(["Add note", "Add other", "Add note › Beta", "Add note › Gamma"]);
  });
});

describe("the first run's other choices", () => {
  it("walks the first other choice straight after the first run, and the rest once everything else is", async () => {
    const ways = [control("Upload a page", { group: "g", title: "Upload a page" }), control("Write one now", { group: "g", title: "Write one now" }), control("Bring one over", { group: "g", title: "Bring one over" })];
    const pages: Record<string, ScreenNow> = {
      "/welcome": screenNow({ path: "/welcome", marker: "1 of 2", controls: ways }),
      "/welcome/drop": screenNow({ path: "/welcome/drop", marker: "2 of 2", files: 1 }),
      "/done": screenNow({ path: "/done" }),
      "/list": screenNow({ path: "/list", controls: [control("Add note")] }),
    };
    const walk = new JourneyWalk({ journeys: [{ name: "First run", start: "/welcome", via: [], firstRun: true }, { name: "Add note", start: "/list", via: [], goal: "Add note" }], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const { drive } = scripted(pages, { "Upload a page": "/welcome/drop", "Write one now": "/done", "Bring one over": "/done", "Add note": "/done" }, { "Write one now": [{ kind: "kept", where: "/rest/v1/pages" }], "Bring one over": [{ kind: "kept", where: "/rest/v1/pages" }], "Add note": [{ kind: "kept", where: "/rest/v1/notes" }] });
    await walk.run(drive);
    expect(walk.report(150_000).journeys.map((j) => j.name)).toEqual(["First run", "First run › Write one now", "Add note", "First run › Bring one over"]);
  });

  it("walks the main journey ahead of the first run's first other choice", async () => {
    const ways = [control("Upload a page", { group: "g", title: "Upload a page" }), control("Write one now", { group: "g", title: "Write one now" }), control("Bring one over", { group: "g", title: "Bring one over" })];
    const pages: Record<string, ScreenNow> = {
      "/welcome": screenNow({ path: "/welcome", marker: "1 of 2", controls: ways }),
      "/welcome/drop": screenNow({ path: "/welcome/drop", marker: "2 of 2", files: 1 }),
      "/done": screenNow({ path: "/done" }),
      "/list": screenNow({ path: "/list", controls: [control("Add note")] }),
    };
    const walk = new JourneyWalk({ journeys: [{ name: "First run", start: "/welcome", via: [], firstRun: true }, { name: "Add note", start: "/list", via: [], goal: "Add note", main: true }], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const { drive, pressed } = scripted(pages, { "Upload a page": "/welcome/drop", "Write one now": "/done", "Bring one over": "/done", "Add note": "/done" }, { "Write one now": [{ kind: "kept", where: "/rest/v1/pages" }], "Bring one over": [{ kind: "kept", where: "/rest/v1/pages" }], "Add note": [{ kind: "kept", where: "/rest/v1/notes" }] });
    await walk.run(drive);
    expect(pressed).toEqual(["Upload a page", "Add note", "Write one now", "Bring one over"]);
  });
});

describe("how many are walked", () => {
  it("walks as many as forty, while there's time, and names the rest", async () => {
    const pages: Record<string, ScreenNow> = {};
    const journeys = Array.from({ length: 42 }, (_, n) => {
      pages[`/s${n}`] = screenNow({ path: `/s${n}`, controls: [control(`Add note ${n}`)] });
      pages[`/done${n}`] = screenNow({ path: `/done${n}` });
      return { name: `Add note ${n}`, start: `/s${n}`, via: [], goal: `Add note ${n}` };
    });
    const walk = new JourneyWalk({ journeys, stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    await walk.run(scripted(pages, Object.fromEntries(journeys.map((j, n) => [j.goal, `/done${n}`]))).drive);
    const report = walk.report(150_000);
    expect(report.journeys).toHaveLength(40);
    expect(report.notFinished).toEqual(["Add note 40 on /s40", "Add note 41 on /s41"]);
  });
});

describe("the main journey", () => {
  const journey = (name: string, firstRun?: true): WalkedJourney => ({ name, from: "/a", main: false, outcome: "finished", saved: "seen", steps: [{ screen: "/a", did: "open" }, { screen: "/a", did: "fill", label: "Save trade", saved: true, goal: true }], ...(firstRun ? { firstRun } : {}), seenWith: "stand-in" });

  it("is the way from the first run, where one got there, whichever came first", async () => {
    const pages = { "/one": screenNow({ path: "/one", controls: [control("Save trade", { primary: true })] }), "/other": screenNow({ path: "/other", controls: [control("Save trade", { primary: true })] }), "/two": screenNow({ path: "/two" }) };
    for (const order of [["By address", "First run"], ["First run", "By address"]]) {
      const walk = new JourneyWalk({ journeys: order.map((name) => (name === "First run" ? { name, start: "/one", via: [], firstRun: true } : { name, start: "/other", via: [] })), stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
      const hints = { main: "Save trade", actions: [], screens: [] };
      const { drive } = scripted(pages, { "Save trade": "/two" }, { "Save trade": [{ kind: "kept", where: "/rest/v1/t" }] });
      const run = walk.run(drive);
      walk.addHints(hints);
      await run;
      const report = walk.report(150_000);
      expect(report.journeys.filter((j) => j.main).map((j) => j.name)).toEqual(["First run"]);
    }
    expect(stepsToValue([{ ...journey("First run", true), main: true }])).toMatchObject({ fromFirstRun: true });
  });
});

describe("the walk of a run", () => {
  const pages = {
    "/first": screenNow({ path: "/first", controls: [control("Continue")] }),
    "/home": screenNow({ path: "/home", text: "all set", controls: [control("Add note")] }),
  };
  const found = { journeys: [{ name: "Add note", start: "/home", via: [], goal: "Add note" }, { name: "First run", start: "/first", via: [], firstRun: true }], stops: [], leftAlone: 2 };
  const walk = () => new JourneyWalk(found, { nav: ["/home"], signUp: () => [], saved: () => false });

  it("walks the first run ahead of the rest, keeps every one, and says finished the one way", async () => {
    const run = walk();
    run.close();
    await run.run(scripted(pages, { Continue: "/home", "Add note": "/first" }).drive);
    const report = run.report(150_000);
    expect(report.journeys.map((j) => j.name)).toEqual(["First run", "Add note"]);
    expect(report.legend).toBe(JOURNEY_LEGEND);
    expect(report.limitSeconds).toBe(150);
    expect(report.leftAlone).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(/\bpassed\b|\bworks\b/i);
  });

  it("names what it didn't get to when it's stopped, and loses nothing walked", async () => {
    const run = walk();
    run.close();
    let n = 0;
    await run.run(scripted(pages, { Continue: "/home" }, {}, { stop: () => ++n > 3 }).drive);
    expect(run.report(150_000).notFinished).toEqual(["Add note on /home"]);
  });

  it("takes the code's hints: the main action first, a record's screen as not reached, what destroys as left alone", async () => {
    const run = walk();
    run.addHints({
      main: "Add a note",
      actions: [{ screen: "/home", label: "Add note", does: "adds a note" }, { screen: "/home", label: "Clear notes", does: "deletes every note" }, { screen: "/notes/:id", label: "Edit note", does: "changes it" }],
      screens: [{ path: "/plans" }, { path: "/notes/:id" }],
    });
    await run.run(scripted(pages, { Continue: "/home", "Add note": "/first" }).drive);
    const report = run.report(150_000);
    expect(report.journeys[0]).toMatchObject({ name: "Add note", main: true });
    expect(report.notReached.map((n) => n.because)).toContain("it needs a record to exist");
    expect(report.leftAlone).toBe(3);
    expect(report.noCodeHints).toBeUndefined();
  });

  it("says so when no code hints came", async () => {
    const run = walk();
    run.addHints(undefined);
    await run.run(scripted(pages, { Continue: "/home" }).drive);
    expect(run.report(150_000).noCodeHints).toBe(true);
  });
});

describe("how long a step waits", () => {
  const before = screenNow({ path: "/w", controls: [control("Alpha", { group: "g" }), control("Beta", { group: "g" })] });
  const settled = (now: ScreenNow, more: { was?: ScreenNow; anyChange?: boolean; stillFor?: number; quiet?: boolean } = {}) => stepSettled({ was: more.was ?? now, now, before, anyChange: more.anyChange, stillFor: more.stillFor ?? 0, quiet: more.quiet ?? true });

  it("is done at once with a press that moved on", () => {
    expect(settled(screenNow({ path: "/next" }))).toBe(true);
  });

  it("is done with a press that moved nothing once the page has been still a while, with nothing loading", () => {
    expect(settled(before, { stillFor: STEP_STILL_MS - 1 })).toBe(false);
    expect(settled(before, { stillFor: STEP_STILL_MS })).toBe(true);
    expect(settled(before, { stillFor: STEP_STILL_MS * 2, quiet: false })).toBe(false);
  });

  it("never while it's still drawing, busy or loading, however long it's been still", () => {
    expect(settled(before, { was: screenNow({ ...before, text: "half" }), stillFor: 10_000 })).toBe(false);
    expect(settled(screenNow({ ...before, busy: true }), { stillFor: 10_000 })).toBe(false);
    expect(settled(screenNow({ ...before, wall: "loading" }), { stillFor: 10_000 })).toBe(false);
  });

  it("gives a flow that may still be drawing what's next longer", () => {
    expect(settled(before, { anyChange: true, stillFor: STEP_STILL_MS })).toBe(false);
    expect(settled(before, { anyChange: true, stillFor: STEP_STILL_MORE_MS })).toBe(true);
    expect(settled(screenNow({ ...before, text: "and the next question" }), { anyChange: true })).toBe(true);
  });

  it("gives one of several choices the whole wait: an app may wait a beat for another pick", () => {
    expect(stepSettled({ was: before, now: before, before, patient: true, stillFor: 10_000, quiet: true })).toBe(false);
    expect(stepSettled({ was: before, now: screenNow({ path: "/next" }), before, patient: true, stillFor: 0, quiet: true })).toBe(false);
    expect(stepSettled({ was: screenNow({ path: "/next" }), now: screenNow({ path: "/next" }), before, patient: true, stillFor: 0, quiet: true })).toBe(true);
  });

  it("looks again at the end of a flow only while each look sees something new", async () => {
    const pages = { "/w": screenNow({ path: "/w", marker: "1 of 2", controls: [control("Continue")] }), "/w2": screenNow({ path: "/w2", marker: "2 of 2" }) };
    const { drive } = scripted(pages, { Continue: "/w2" }, { Continue: [{ kind: "kept", where: "/rest/v1/steps" }] });
    let again = 0;
    const look = drive.look;
    drive.look = async (was, anyChange, patient) => { if (anyChange) again++; return look(was, anyChange, patient); };
    expect(await walkOne({ name: "Wizard", start: "/w", via: [] }, drive, () => {})).toMatchObject({ outcome: "finished" });
    expect(again).toBe(1);
    // A chat still typing: each look shows more, so it keeps looking, as many times as it may.
    let typed = 0;
    const typing = scripted(pages, { Continue: "/w2" }, { Continue: [{ kind: "kept", where: "/rest/v1/steps" }] }).drive;
    const plain = typing.look;
    typing.look = async (was, anyChange, patient) => { const now = await plain(was, anyChange, patient); if (!anyChange) return now; typed++; return { ...now, text: "x".repeat(typed) }; };
    await walkOne({ name: "Wizard", start: "/w", via: [] }, typing, () => {});
    expect(typed).toBe(3);
  });

  it("says nothing of moving on: that's movedOn's alone", () => {
    expect(movedOn(before, before)).toBeUndefined();
  });
});

describe("the looks", () => {
  it("never opens an address that stands for a record", async () => {
    const walk = new JourneyWalk({ journeys: [], stops: [], leftAlone: 0 }, { nav: ["/notes/:id", "/home"], signUp: () => [], saved: () => false });
    walk.close();
    const pages = { "/home": screenNow({ path: "/home" }), "/notes/:id": screenNow({ path: "/notes/:id" }) };
    const { drive } = scripted(pages, {});
    const opened: string[] = [];
    const open = drive.open;
    drive.open = async (path) => { opened.push(path); return open(path); };
    drive.review = async () => ({ path: "/home", text: [], controls: [], locked: [], empty: [] });
    await walk.run(drive);
    expect(opened).toEqual(["/home"]);
  });
});

describe("going on from where a choice stopped", () => {
  const ways = [control("Upload a page", { group: "g" }), control("Write one now", { group: "g" })];
  // One address throughout: a choice opens what it needs below the choices.
  const pages = (): Record<string, ScreenNow> => ({
    "/w": screenNow({ path: "/w", marker: "1 of 2", controls: ways }),
    "/w#file": screenNow({ path: "/w", marker: "1 of 2", controls: ways, files: 1 }),
    "/w#form": screenNow({ path: "/w", marker: "1 of 2", controls: ways, fieldsKey: "body", form: { key: "f", label: "Save page", inDialog: false } }),
    "/w#done": screenNow({ path: "/w", marker: "2 of 2", heading: "Your notebook has its first page" }),
  });
  const moves = { "Upload a page": "/w#file", "Write one now": "/w#form", "the form": "/w#done" };
  const counted = (drive: Drive) => {
    const count = { resets: 0, opens: 0 };
    const reset = drive.reset;
    const open = drive.open;
    drive.reset = async () => { count.resets++; return reset(); };
    drive.open = async (path) => { count.opens++; return open(path); };
    return count;
  };

  it("hands back the other choice still on the screen, with the session as it was, the stop aside", async () => {
    const { drive } = scripted(pages(), moves, { "the form": [{ kind: "kept", where: "/rest/v1/pages" }] });
    const again: { label: string; resume?: Resume }[] = [];
    const walked = await walkOne({ name: "Notebook", start: "/w", via: [] }, drive, () => {}, undefined, undefined, (_from, other, _nth, _goal, resume) => again.push({ label: other.label, ...(resume ? { resume } : {}) }));
    expect(walked).toMatchObject({ outcome: "stopped_here", stop: { kind: "file" }, pick: { label: "Upload a page" } });
    expect(again.map((a) => a.label)).toEqual(["Write one now"]);
    const resume = again[0]!.resume!;
    expect(resume.now.files).toBe(1);
    expect(resume.steps.map((s) => `${s.did}${s.left ? " (left)" : ""}`)).toEqual(["open", "press (left)"]);
  });

  it("walks it on from there with nothing reset or opened, and counts the choice it left as no step of the way", async () => {
    const { drive, pressed } = scripted(pages(), moves, { "the form": [{ kind: "kept", where: "/rest/v1/pages" }] });
    const count = counted(drive);
    let resume: Resume | undefined;
    const first = await walkOne({ name: "Notebook", start: "/w", via: [] }, drive, () => {}, undefined, undefined, (_from, _other, _nth, _goal, r) => { resume = r; });
    expect(count).toEqual({ resets: 1, opens: 1 });
    const other = await walkOne({ name: "Notebook › Write one now", start: "/w", via: [], goal: "Write one now", chose: true, resume: resume! }, drive, () => {});
    expect(count.resets).toBe(1);
    expect(other).toMatchObject({ outcome: "finished" });
    expect(pressed).toEqual(["Upload a page", "Write one now", "the form"]);
    expect(other.steps.map((s) => `${s.did} ${s.label ?? ""}${s.left ? " (left)" : ""}`.trim())).toEqual(["open", "press Upload a page (left)", "press Write one now", "fill Save page"]);
    expect(stepsToValue([{ ...other, main: true }])).toMatchObject({ presses: 1, fields: 1 });
    expect(first.steps.at(-1)).toMatchObject({ did: "stop" });
    // What the first journey came for is no goal of the one that goes on: only its own choice is.
    expect(other.steps.filter((s) => s.goal).map((s) => s.label)).toEqual(["Write one now"]);
  });

  it("keeps no goal of the journey it went on from", async () => {
    // It came for "New notebook", and the choice past that stopped at a file.
    const { drive } = scripted({ "/s": screenNow({ path: "/s", controls: [control("New notebook")] }), ...pages() }, { ...moves, "New notebook": "/w" }, { "the form": [{ kind: "kept", where: "/rest/v1/pages" }] });
    let resume: Resume | undefined;
    await walkOne({ name: "New notebook", start: "/s", via: [], goal: "New notebook" }, drive, () => {}, undefined, undefined, (_from, _other, _nth, _goal, r) => { resume = r; });
    expect(resume!.steps.map((s) => s.label)).toContain("New notebook");
    expect(resume!.steps.some((s) => s.goal)).toBe(false);
    const other = await walkOne({ name: "New notebook › Write one now", start: "/s", via: ["New notebook"], goal: "Write one now", chose: true, resume: resume! }, drive, () => {});
    expect(other.steps.filter((s) => s.goal).map((s) => s.label)).toEqual(["Write one now"]);
  });

  it("walks it from the start when the choice moved the screen on, or the stop was something tried for real", async () => {
    const moved = { ...pages(), "/upload": screenNow({ path: "/upload", files: 1 }) };
    const handed: (Resume | undefined)[] = [];
    await walkOne({ name: "Notebook", start: "/w", via: [] }, scripted(moved, { ...moves, "Upload a page": "/upload" }).drive, () => {}, undefined, undefined, (_f, _o, _n, _g, r) => handed.push(r));
    await walkOne({ name: "Notebook", start: "/w", via: [] }, scripted(pages(), { "Write one now": "/w#form" }, { "Upload a page": [{ kind: "payment", where: "/api/checkout" }] }).drive, () => {}, undefined, undefined, (_f, _o, _n, _g, r) => handed.push(r));
    expect(handed).toHaveLength(2);
    expect(handed).toEqual([undefined, undefined]);
  });

  it("in a run, goes on straight after, ahead of everything else, and only then", async () => {
    const all = { ...pages(), "/list": screenNow({ path: "/list", controls: [control("Add note")] }), "/added": screenNow({ path: "/added", rows: 1 }) };
    const walk = new JourneyWalk({ journeys: [{ name: "Notebook", start: "/w", via: [], firstRun: true }, { name: "Add note", start: "/list", via: [], goal: "Add note" }], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const { drive, pressed } = scripted(all, { ...moves, "Add note": "/added" }, { "the form": [{ kind: "kept", where: "/rest/v1/pages" }], "Add note": [{ kind: "kept", where: "/rest/v1/notes" }] });
    const count = counted(drive);
    await walk.run(drive);
    expect(pressed).toEqual(["Upload a page", "Write one now", "the form", "Add note"]);
    expect(count.resets).toBe(2);
    const report = walk.report(150_000);
    expect(report.journeys.map((j) => [j.name, j.outcome])).toEqual([["Notebook", "stopped_here"], ["Notebook › Write one now", "finished"], ["Add note", "finished"]]);
    expect(report.notFinished).toEqual([]);
  });

  it("never goes on from a session another journey has been in since", async () => {
    const walk = new JourneyWalk({ journeys: [], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    const stale: Journey = { name: "Stale › Write one now", start: "/w", via: [], goal: "Write one now", chose: true, resume: { now: pages()["/w#file"]!, steps: [{ screen: "/w", did: "open" }], pressed: [], sent: [], moved: 0, saved: false, unknownSave: false, words: "", trodden: [] } };
    const fresh: Journey = { name: "Fresh", start: "/w", via: [], firstRun: true };
    // What a run's queue holds when a journey that went on was never taken straight after: from the start, as any other.
    (walk as unknown as { queue: Journey[] }).queue.push(fresh, stale);
    walk.close();
    const { drive } = scripted(pages(), moves);
    const count = counted(drive);
    let n = 0;
    drive.stopped = () => ++n > 40;
    await walk.run(drive);
    expect(count.resets).toBe(2);
    const went = walk.report(150_000).journeys.find((j) => j.name === "Stale › Write one now");
    expect(went?.steps.filter((s) => s.did === "open")).toHaveLength(1);
    expect(went?.steps.some((s) => s.left)).toBe(false);
  });
});

describe("walking on several drives at once", () => {
  const slowly = (drive: Drive, ms: Record<string, number>) => {
    let at = "";
    const open = drive.open;
    const look = drive.look;
    drive.open = async (path) => {
      at = path;
      return open(path);
    };
    drive.look = async (...args) => {
      await new Promise((done) => setTimeout(done, ms[at] ?? 0));
      return look(...args);
    };
    return drive;
  };
  const pages = (): Record<string, ScreenNow> => ({
    "/slow": screenNow({ path: "/slow", controls: [control("Add note")] }),
    "/fast": screenNow({ path: "/fast", controls: [control("Add tag")] }),
    "/other": screenNow({ path: "/other", controls: [control("Add label")] }),
    "/done": screenNow({ path: "/done", rows: 1 }),
  });
  const moves = { "Add note": "/done", "Add tag": "/done", "Add label": "/done" };
  const found = { journeys: [{ name: "Add note", start: "/slow", via: [], goal: "Add note" }, { name: "Add tag", start: "/fast", via: [], goal: "Add tag" }, { name: "Add label", start: "/other", via: [], goal: "Add label" }], stops: [], leftAlone: 0 };

  it("takes each journey once, keeps each one's presses to its own drive, and lists them in the order they began", async () => {
    const walk = new JourneyWalk(found, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const one = scripted(pages(), moves);
    const two = scripted(pages(), moves);
    const ended: string[] = [];
    walk.listen((journey) => ended.push(journey.name));
    await Promise.all([walk.run(slowly(one.drive, { "/slow": 60 })), walk.run(two.drive)]);
    // The slow one began first and ended last: the list is in the order they began, never the order they ended.
    expect(ended[0]).not.toBe("Add note");
    expect(walk.report(150_000).journeys.map((j) => j.name)).toEqual(["Add note", "Add tag", "Add label"]);
    expect([...one.pressed, ...two.pressed].sort()).toEqual(["Add label", "Add note", "Add tag"]);
    expect(one.pressed).toEqual(["Add note"]);
    expect(two.pressed).toEqual(["Add tag", "Add label"]);
  });

  it("goes on from a stop only on the drive whose session it's in", async () => {
    const choices = [control("Upload a page", { group: "g", title: "Upload a page" }), control("Write one now", { group: "g", title: "Write one now" })];
    const notebook = {
      "/w": screenNow({ path: "/w", marker: "1 of 2", controls: choices }),
      "/w#file": screenNow({ path: "/w", marker: "1 of 2", files: 1, controls: choices }),
      "/w#form": screenNow({ path: "/w", marker: "2 of 2", form: { key: "page", label: "Save page", inDialog: false } }),
      "/w#done": screenNow({ path: "/w", text: "Your notebook", rows: 1 }),
      ...pages(),
    };
    const steps = { "Upload a page": "/w#file", "Write one now": "/w#form", "the form": "/w#done", ...moves };
    const walk = new JourneyWalk({ journeys: [{ name: "Notebook", start: "/w", via: [], firstRun: true }, ...found.journeys], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const one = scripted(notebook, steps, { "the form": [{ kind: "kept", where: "/rest/v1/pages" }] });
    const two = scripted(notebook, steps);
    await Promise.all([walk.run(slowly(one.drive, { "/w": 20 })), walk.run(two.drive)]);
    const report = walk.report(150_000);
    const other = report.journeys.find((j) => j.name === "Notebook › Write one now");
    expect(other).toMatchObject({ outcome: "finished" });
    // Opened once: it went on from the stop, on the drive that had stopped there.
    expect(other!.steps.filter((s) => s.did === "open")).toHaveLength(1);
    expect(one.pressed).toEqual(["Upload a page", "Write one now", "the form"]);
    expect(two.pressed).not.toContain("Write one now");
    // The other drive walked the rest while the first run was still on its first screen: what goes on from its stop came after them all.
    expect(report.journeys.map((j) => j.name)).toEqual(["Notebook", "Add note", "Add tag", "Add label", "Notebook › Write one now"]);
    expect(report.journeys[0]!.name).toBe("Notebook");
    expect(report.notFinished).toEqual([]);
  });

  it("waits for screens still to come before it ends, and counts what each wave offers once", async () => {
    const walk = new JourneyWalk({ journeys: [found.journeys[0]!], stops: [], leftAlone: 1 }, { nav: ["/slow"], signUp: () => [], saved: () => false });
    const screensOver = walk.more();
    walk.close();
    const one = scripted(pages(), moves);
    let over = false;
    const running = walk.run(one.drive).then(() => { over = true; });
    await new Promise((done) => setTimeout(done, 50));
    // The first wave is walked, and the walk waits: more screens may still come.
    expect(one.pressed).toEqual(["Add note"]);
    expect(over).toBe(false);
    const upgrade: WalkedJourney = { name: "Upgrade", from: "/fast", main: false, outcome: "stopped_here", stop: { kind: "paywall", label: "Upgrade", byLabel: true }, steps: [], seenWith: "stand-in" };
    walk.add({ journeys: [found.journeys[1]!, found.journeys[0]!], stops: [upgrade], leftAlone: 2 }, ["/fast"]);
    walk.add({ journeys: [found.journeys[2]!], stops: [{ ...upgrade, from: "/other" }], leftAlone: 0 }, ["/other"]);
    screensOver();
    await running;
    const report = walk.report(150_000);
    expect(report.journeys.map((j) => j.name)).toEqual(["Add note", "Add tag", "Add label", "Upgrade"]);
    expect(report.leftAlone).toBe(3);
    expect(one.pressed).toEqual(["Add note", "Add tag", "Add label"]);
  });

  it("names a journey of one name on each screen it wasn't reached on", async () => {
    const walk = new JourneyWalk({ journeys: [{ name: "Save", start: "/a", via: [], goal: "Save" }, { name: "Save", start: "/b", via: [], goal: "Save" }, { name: "Save", start: "/c", via: [], goal: "Save" }], stops: [], leftAlone: 0 }, { nav: [], signUp: () => [], saved: () => false });
    walk.close();
    const { drive } = scripted({ "/a": screenNow({ path: "/a", controls: [control("Save")] }), "/b": screenNow({ path: "/b" }), "/c": screenNow({ path: "/c" }), "/done": screenNow({ path: "/done", rows: 1 }) }, { Save: "/done" });
    await walk.run(drive);
    const report = walk.report(150_000);
    expect(report.journeys.map((j) => `${j.name} ${j.from}`)).toEqual(["Save /a"]);
    expect(report.notReached.map((n) => `${n.name} ${n.from}`)).toEqual(["Save /b", "Save /c"]);
    expect(report.message).toMatch(/^3 journeys found/);
  });
});
