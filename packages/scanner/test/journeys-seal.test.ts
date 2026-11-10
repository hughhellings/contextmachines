import { availableParallelism } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backgroundHost, scanSite, type JourneyHints, type JourneyReport, type JourneysUnderWay, type ScanResult, type WalkedJourney } from "../src/scan.ts";
import { Seal, STAND_IN_USER_ID, type Asked } from "../src/stand-in.ts";
import { journeysApp } from "./journeys-app.ts";
import { standInApp, type StandInApp } from "./stand-in-app.ts";

const START = new URL("http://localhost:5173/");
const SUPABASE = "https://xyz.supabase.example";
const seal = (keepSaves = true) => {
  const made = new Seal({ start: START, config: { rows: {} }, publicScreens: [], background: backgroundHost, graphqlRead: () => false, keepSaves });
  made.shell = "<!doctype html>";
  return made;
};
const asked = (href: string, more: Partial<Asked> = {}): Asked => ({ method: "GET", type: "fetch", url: new URL(href, START), headers: {}, ...more });
const write = (href: string, body: unknown, more: Partial<Asked> = {}) => asked(href, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", prefer: "return=representation" }, ...more });
const bodyOf = (verdict: { reply?: { body?: string } }) => JSON.parse(verdict.reply?.body ?? "null");

describe("what the seal keeps of a save", () => {
  it("shows a save in the next read, with ids no two rows share", () => {
    const s = seal();
    const one = bodyOf(s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Test" })) as { reply?: { body?: string } });
    const two = bodyOf(s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Other" })) as { reply?: { body?: string } });
    expect(one[0].id).not.toBe(two[0].id);
    const rows = bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/trades?select=*`)) as { reply?: { body?: string } });
    expect(rows.map((row: { symbol: string }) => row.symbol)).toEqual(["Test", "Other"]);
    expect(rows[0].id).toBe(one[0].id);
  });

  it("finds a row by its id and gives one object for .single()", () => {
    const s = seal();
    const [made] = bodyOf(s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Test" })) as { reply?: { body?: string } });
    const one = s.judge(asked(`${SUPABASE}/rest/v1/trades?id=eq.${made.id}`, { headers: { accept: "application/vnd.pgrst.object+json" } })) as { reply?: { body?: string } };
    expect(bodyOf(one)).toMatchObject({ symbol: "Test" });
  });

  it("updates by filter, and makes the row an update found nothing for, as sign-up would have", () => {
    const s = seal();
    const patch = (href: string, body: unknown) => s.judge(write(href, body, { method: "PATCH" }));
    patch(`${SUPABASE}/rest/v1/profiles?id=eq.${STAND_IN_USER_ID}`, { onboarded: true });
    const rows = bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/profiles?id=eq.${STAND_IN_USER_ID}`)) as { reply?: { body?: string } });
    expect(rows).toEqual([{ id: STAND_IN_USER_ID, onboarded: true }]);
    patch(`${SUPABASE}/rest/v1/profiles?id=eq.${STAND_IN_USER_ID}`, { goal: "notebook" });
    expect(bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/profiles`)) as { reply?: { body?: string } })).toEqual([{ id: STAND_IN_USER_ID, onboarded: true, goal: "notebook" }]);
  });

  it("upserts onto a row, and deletes", () => {
    const s = seal();
    const upsert = { headers: { "content-type": "application/json", prefer: "return=representation,resolution=merge-duplicates" } };
    s.judge(write(`${SUPABASE}/rest/v1/settings?on_conflict=user_id`, { user_id: "u", theme: "dark" }, upsert));
    s.judge(write(`${SUPABASE}/rest/v1/settings?on_conflict=user_id`, { user_id: "u", theme: "light" }, upsert));
    expect(bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/settings`)) as { reply?: { body?: string } })).toHaveLength(1);
    s.judge(asked(`${SUPABASE}/rest/v1/settings?user_id=eq.u`, { method: "DELETE" }));
    expect(bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/settings`)) as { reply?: { body?: string } })).toEqual([]);
  });

  it("keeps what a save put on the signed-in user", () => {
    const s = seal();
    s.judge(write(`${SUPABASE}/auth/v1/user`, { data: { onboarded: true } }, { method: "PUT" }));
    expect(bodyOf(s.judge(asked(`${SUPABASE}/auth/v1/user`)) as { reply?: { body?: string } }).user_metadata).toEqual({ onboarded: true });
  });

  it("gives an app's own API its save back, as a list and nothing else", () => {
    const s = seal();
    s.judge(write("/api/notes", { title: "Test name" }));
    expect(bodyOf(s.judge(asked("/api/notes", { headers: { accept: "application/json" } })) as { reply?: { body?: string } })).toMatchObject([{ title: "Test name" }]);
    expect((s.judge(asked("/api/other", { headers: { accept: "application/json" } })) as { reply?: { body?: string } }).reply?.body).toBe("[]");
  });

  it("marks what it kept, what it couldn't and what it only answered, and forgets on being told", () => {
    const s = seal();
    s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Test name" }));
    s.judge(write(`${SUPABASE}/rest/v1/rpc/add_trade`, {}));
    expect(s.trail.map((t) => t.kind)).toEqual(["kept", "save"]);
    expect(s.keptIn("my test name here")).toEqual(["test name"]);
    s.forget();
    expect(s.keptIn("my test name here")).toEqual([]);
    expect(bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/trades`)) as { reply?: { body?: string } })).toEqual([]);
  });

  it("leaves every other seal as it was: nothing kept, nothing on a trail", () => {
    const s = seal(false);
    s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Test" }));
    expect(bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/trades`)) as { reply?: { body?: string } })).toEqual([]);
    expect(s.trail).toEqual([]);
  });

  it("changes no verdict by keeping a trail", () => {
    const tries: Asked[] = [
      asked("https://elsewhere.example/x", { type: "document" }), asked("/api/checkout", { method: "POST", body: "{}" }), asked("https://pay.example/a.js", { type: "script" }),
      asked("/.env", { type: "script" }), asked("/backend/x", { type: "fetch" }), asked("https://accounts.example/oauth/authorize", { type: "document" }), write("https://elsewhere.example/hook", {}),
    ];
    for (const r of tries) expect(seal(true).judge(r).act).toBe(seal(false).judge(r).act);
  });
});

describe("what a page can't reach through the seal's memory", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const objectBefore = Object.getOwnPropertyNames(Object).sort();

  it("keeps nothing under a language's own names, however it's asked", () => {
    const s = seal();
    for (const table of ["__proto__", "constructor", "prototype"]) {
      for (const method of ["POST", "PATCH", "DELETE"]) s.judge(write(`${SUPABASE}/rest/v1/${table}`, { polluted: "by the page", path: "/etc/hosts", method: "DELETE" }, { method }));
      s.judge(asked(`${SUPABASE}/rest/v1/${table}?select=*`));
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(Object.getOwnPropertyNames(Object).sort()).toEqual(objectBefore);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("lets a field called that be no more than a dropped field", () => {
    const s = seal();
    const [row] = bodyOf(s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "Test" })) as { reply?: { body?: string } });
    s.judge(asked(`${SUPABASE}/rest/v1/trades?id=eq.${row.id}`, { method: "PATCH", body: `{"__proto__":{"polluted":1},"note":"fine"}`, headers: {} }));
    const [after] = bodyOf(s.judge(asked(`${SUPABASE}/rest/v1/trades`)) as { reply?: { body?: string } });
    expect(after).toMatchObject({ note: "fine" });
    expect(Object.getPrototypeOf(after)).toBe(Object.prototype);
    expect(after.polluted).toBeUndefined();
  });
});

describe("the trail: what no label said", () => {
  it("never loses a way out, however much else a page says, and starts afresh for each journey", () => {
    const s = seal();
    for (let n = 0; n < 3000; n++) s.judge(write("/api/events", { n }));
    s.judge(write("/api/create-checkout", {}));
    expect(s.trail.at(-1)).toMatchObject({ kind: "payment" });
    s.forget();
    expect(s.trail).toHaveLength(0);
    s.judge(write("/api/save-thing", {}));
    expect(s.trail).toHaveLength(1);
  });

  it("takes a DELETE as destroying, however it's addressed, and a sign-out as signing out", () => {
    const s = seal();
    const kindOf = (href: string, more: Partial<Asked>) => {
      s.judge(asked(href, more));
      return s.trail.at(-1)?.kind;
    };
    expect(kindOf("/api/account", { method: "DELETE" })).toBe("destroys");
    expect(kindOf(`${SUPABASE}/rest/v1/trades?select=*`, { method: "DELETE" })).toBe("destroys");
    expect(kindOf("/api/logout", { method: "DELETE" })).toBe("sign_out");
    expect(kindOf("/api/delete-account", { method: "POST", body: "{}" })).toBe("destroys");
  });

  it("catches payment and mail by more of their addresses, and leaves near misses alone", () => {
    const s = seal();
    const kindOf = (href: string) => {
      s.judge(write(href, {}));
      return s.trail.at(-1)?.kind;
    };
    for (const href of ["/api/charge", "/api/pay", "/v1/charges", "/api/orders/place", "/api/place-order", "/api/stripe/session", "/api/purchase"]) expect([href, kindOf(href)]).toEqual([href, "payment"]);
    for (const href of ["/api/mail", "/api/notify-team", "/api/sms"]) expect([href, kindOf(href)]).toEqual([href, "email"]);
    for (const href of ["/api/payroll-notes", "/api/display", "/api/mailbox-names", "/api/orders", "/api/deleted-items-view"]) expect([href, kindOf(href)]).not.toEqual([href, "payment"]);
    expect(kindOf("/api/mailbox-names")).toBe("kept");
  });

  it("counts a word as served only from a read that handed it over", () => {
    const s = seal();
    s.judge(write(`${SUPABASE}/rest/v1/trades`, { symbol: "AUDCAD" }));
    s.judge(write(`${SUPABASE}/rest/v1/setups`, { name: "Breakout" }));
    s.forgetServed();
    expect(s.keptIn("audcad on the page")).toHaveLength(1);
    expect(s.keptServedIn("audcad on the page")).toEqual([]);
    s.judge(asked(`${SUPABASE}/rest/v1/setups?select=*`));
    expect(s.keptServedIn("audcad on the page")).toEqual([]);
    s.judge(asked(`${SUPABASE}/rest/v1/trades?select=*`));
    expect(s.keptServedIn("audcad on the page")).toHaveLength(1);
  });

  const kinds = (...tries: Asked[]) => {
    const s = seal();
    s.judge(asked(`${SUPABASE}/rest/v1/seen`));
    for (const r of tries) s.judge(r);
    return s.trail.map((t) => t.kind);
  };

  it("catches a page leaving for elsewhere, as a window or a form too", () => {
    expect(kinds(asked("https://accounts.example/oauth/authorize", { type: "document" }))).toEqual(["third_party"]);
    expect(kinds(asked("https://pay.example/checkout/1", { type: "document" }))).toEqual(["payment"]);
    expect(kinds(asked("https://elsewhere.example/page", { type: "document", popUp: true }))).toEqual(["leaves_site"]);
    expect(kinds(asked("https://elsewhere.example/form", { method: "POST", type: "document" }))).toEqual(["leaves_site"]);
    expect(kinds(asked("/trades", { type: "document", popUp: true }))).toEqual(["leaves_site"]);
  });

  it("doesn't take a frame in the page, or the app's own page load, for leaving", () => {
    expect(kinds(asked("https://elsewhere.example/embed", { type: "document", inFrame: true }), asked("/trades", { type: "document" }))).toEqual([]);
  });

  it("catches a call that pays, mails or goes to someone else", () => {
    expect(kinds(write("/api/create-checkout", {}))).toEqual(["payment"]);
    expect(kinds(write(`${SUPABASE}/functions/v1/send-invite`, {}))).toEqual(["email"]);
    expect(kinds(write(`${SUPABASE}/auth/v1/recover`, {}))).toEqual(["email"]);
    expect(kinds(write(`${SUPABASE}/auth/v1/otp`, {}))).toEqual(["email"]);
    expect(kinds(write(`${SUPABASE}/rest/v1/rpc/send_invites`, {}))).toEqual(["email"]);
    expect(kinds(write("https://hooks.elsewhere.example/in", {}))).toEqual(["third_party"]);
    expect(kinds(write(`${SUPABASE}/auth/v1/logout`, {}))).toEqual(["sign_out"]);
  });

  it("doesn't take the app's own tables or an innocent function for any of that", () => {
    expect(kinds(write(`${SUPABASE}/rest/v1/email_preferences`, {}), write(`${SUPABASE}/rest/v1/payments`, {}))).toEqual(["kept", "kept"]);
    expect(kinds(write(`${SUPABASE}/functions/v1/summarise`, {}))).toEqual(["save"]);
    expect(kinds(write("http://localhost:3001/items", {}))).toEqual(["save"]);
  });
});

/** One app, walked once: scanning takes a browser, and every test below reads what came of it. */
describe("a real browser walking the journeys", () => {
  let app: StandInApp;
  let result: ScanResult;
  let plain: ScanResult;
  let report: JourneyReport;
  /** What the run told, in order: the journeys beginning, and where the pass behind the sign-in had got to. */
  const told: string[] = [];
  let browsers = 0;
  let walkedIn = 0;
  /** Journeys begun by the time the new account's walk was over. */
  let begunBy = 0;
  const hints: JourneyHints = {
    main: "Add trade",
    actions: [
      { screen: "/home", label: "Add trade", does: "adds a trade" },
      { screen: "/oauth-start", label: "Next up", does: "moves on" },
      { screen: "/pay-start", label: "Next up", does: "moves on" },
      { screen: "/popup-start", label: "Next up", does: "moves on" },
      { screen: "/mail-start", label: "Next up", does: "moves on" },
      { screen: "/ways-out", label: "Next up", does: "moves on" },
      { screen: "/proto-start", label: "Next up", does: "moves on" },
      { screen: "/summary", label: "Make my summary", does: "builds a summary" },
      { screen: "/picker", label: "Open folder", does: "opens a folder" },
      { screen: "/card", label: "Carry on", does: "moves on" },
      { screen: "/trades/:id", label: "Edit trade", does: "changes a trade" },
    ],
    screens: [{ path: "/patterns" }, { path: "/trades" }, { path: "/trades/:id" }],
  };
  const named = (name: string, from?: string) => report.journeys.find((j) => j.name === name && (!from || j.from === from)) as WalkedJourney;
  const quick = { maxPages: 4, maxDurationMs: 20_000, delayMs: 0 };

  beforeAll(async () => {
    app = await journeysApp();
    const standIn = { addresses: ["/home", "/trades"], maxPages: 3, maxDurationMs: 20_000, firstRun: ["/onboarding"], walkAddresses: ["/home"] };
    let under: JourneysUnderWay | undefined;
    result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...standIn, later: Promise.resolve({ journeyHints: hints }) }, onStage: (stage) => {
      told.push(stage.kind);
      if (stage.kind === "waiting") begunBy = under?.begun() ?? 0;
    }, onJourneys: (walk) => {
      under = walk;
      told.push("journeys");
      browsers = walk.browsers;
    } });
    await under?.done;
    report = under!.soFar();
    walkedIn = under!.walkedIn();
    plain = await scanSite({ startUrl: app.url, ...quick, standIn });
  }, 240_000);
  afterAll(() => app.close());

  it("walks the first run past its first step, on a saved flag, to the end", () => {
    const first = named("First run");
    expect(first.outcome).toBe("finished");
    expect(first.steps.filter((s) => s.moved === "step").length).toBeGreaterThanOrEqual(2);
    expect(first.saved).toBe("unknown");
  });

  it("walks the main action to its save, and sees what was saved on the list", () => {
    const add = named("Add trade");
    expect(add).toMatchObject({ outcome: "finished", main: true, saved: "seen" });
    expect(report.toValue).toMatchObject({ to: "Save trade", atLeast: true });
    expect(report.toValue?.fields).toBe(1);
  });

  it("goes as far as the file choice, gives it no file, and walks the other choices apart", () => {
    expect(named("Import trades")).toMatchObject({ outcome: "stopped_here", stop: { kind: "file" } });
    expect(report.journeys.some((j) => j.name === "Import trades › Paste them in")).toBe(true);
  });

  it("stops at what a label says, with no browser time, and at what only the page's own code gave away", () => {
    expect(named("Upgrade to Pro")).toMatchObject({ outcome: "stopped_here", stop: { kind: "paywall" } });
    expect(named("Connect a bank")).toMatchObject({ outcome: "stopped_here", stop: { kind: "third_party" } });
    expect(named("Invite teammates")).toMatchObject({ outcome: "stopped_here", stop: { kind: "email" } });
    expect(named("Next up", "/oauth-start")).toMatchObject({ outcome: "stopped_here", stop: { kind: "third_party", byLabel: false } });
    expect(named("Next up", "/pay-start")).toMatchObject({ outcome: "stopped_here", stop: { kind: "payment", byLabel: false } });
    expect(named("Next up", "/popup-start")).toMatchObject({ outcome: "stopped_here", stop: { kind: "leaves_site", byLabel: false } });
    expect(named("Next up", "/mail-start")).toMatchObject({ outcome: "stopped_here", stop: { kind: "email", byLabel: false } });
    expect(named("Open folder")).toMatchObject({ outcome: "stopped_here", stop: { kind: "file", byLabel: false } });
    expect(named("Carry on")).toMatchObject({ outcome: "stopped_here", stop: { kind: "payment" } });
  });

  it("never reads a journey past a stop as finished", () => {
    for (const journey of report.journeys) if (journey.stop) expect(journey.outcome).toBe("stopped_here");
  });

  it("calls a screen that falls over on a pretend answer the walk's limit, and adds nothing to the list", () => {
    expect(named("Make my summary")).toMatchObject({ outcome: "couldnt_follow", why: "after_pretend" });
    expect(result.findings).toEqual(plain.findings);
    expect(result.checks.map((c) => `${c.kind} ${c.target}`).sort()).toEqual(plain.checks.map((c) => `${c.kind} ${c.target}`).sort());
    expect(result.blockedWrites).toEqual(plain.blockedWrites);
  });

  it("says unknown for a list drawn from what it can't keep", () => {
    expect(named("Import trades › Paste them in").saved).not.toBe("seen");
  });

  it("names what needs a record", () => {
    expect(report.notReached.map((n) => n.because)).toContain("it needs a record to exist");
  });

  it("looks at screens it never pressed on, for what they ask of a new account", () => {
    const patterns = report.views.find((v) => v.path === "/patterns");
    expect(patterns?.locked.map((l) => l.label)).toContain("Upgrade to Pro");
  });

  it("counts what it left alone: it never pressed delete or log out", () => {
    expect(report.leftAlone).toBeGreaterThan(0);
  });

  it("starts the journeys while the new account is still being walked, the first run first", () => {
    // "waiting" is told the moment the new account's walk is over. Started only then, no browser would yet be open to begin one.
    expect(told.indexOf("journeys")).toBeGreaterThanOrEqual(0);
    expect(told.indexOf("journeys")).toBeLessThan(told.indexOf("waiting"));
    expect(begunBy).toBeGreaterThan(0);
    // In the order they began, the main journey listed ahead of them all aside.
    expect(report.journeys.filter((j) => !j.main && j.steps.some((s) => s.did === "press" || s.did === "fill"))[0]?.name).toBe("First run");
  });

  it("walks in more than one browser where the machine has room, each sealed: what follows holds for all of them", () => {
    expect(browsers).toBeGreaterThanOrEqual(1);
    if (availableParallelism() >= 8) expect(browsers).toBeGreaterThan(1);
    // And more than one of them walked a journey to its end.
    expect(walkedIn).toBeGreaterThanOrEqual(1);
    if (browsers > 1) expect(walkedIn).toBeGreaterThan(1);
  });

  it("let nothing out: the back end heard nothing, and the app's server only files", () => {
    expect(app.backend).toEqual([]);
    expect(app.local.filter((h) => h.method !== "GET" && h.method !== "HEAD")).toEqual([]);
    expect(app.local.filter((h) => h.path.startsWith("/api/") || h.path.startsWith("/backend/"))).toEqual([]);
  });

  it("let a page write nothing into this process through what the seal keeps", () => {
    expect(named("Next up", "/proto-start")).toBeDefined();
    expect(({} as { polluted?: unknown; path?: unknown }).polluted).toBeUndefined();
    expect(({} as { path?: unknown }).path).toBeUndefined();
    expect((Object as unknown as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("says finished the one way, and nothing else about working", () => {
    expect(report.legend).toMatch(/says nothing about your real server/);
    expect(JSON.stringify(report)).not.toMatch(/\bpassed\b|\bworks\b/i);
  });
});

/** Two ways to start, on one screen: each opens what it needs below them, and the address never changes. */
const NOTEBOOK = `
const json = (path, init = {}) => rest(path, { ...init, headers: { "content-type": "application/json", prefer: "return=representation", ...(init.headers || {}) } }).then((r) => r.json());
if (page === "/home") {
  draw('<nav><a href="/home">Home</a></nav><main><h1>Your desk</h1><p>Everything you have written, kept for you in one place.</p><button id="start">Start your notebook</button><div id="ways"></div><div id="below"></div></main>');
  document.getElementById("start").onclick = () => {
    document.getElementById("ways").innerHTML = '<p>Step 1 of 2</p><div><button class="way" id="upload">Upload a page</button><button class="way" id="write">Write one now</button></div>';
    const below = document.getElementById("below");
    document.getElementById("upload").onclick = () => { below.innerHTML = '<input type="file" accept=".txt">'; };
    document.getElementById("write").onclick = () => {
      below.innerHTML = '<form id="f"><label>Page <textarea name="body" required></textarea></label><button type="submit">Save page</button></form>';
      document.getElementById("f").onsubmit = async (e) => {
        e.preventDefault();
        await json("pages", { method: "POST", body: JSON.stringify({ body: e.target.body.value }) });
        // A flourish first, unless less motion was asked for: longer than any step waits.
        const less = matchMedia("(prefers-reduced-motion: reduce)").matches;
        setTimeout(() => draw('<nav><a href="/home">Home</a></nav><main><h1>Your notebook has its first page</h1><p>Step 2 of 2</p></main>'), less ? 0 : 12000);
      };
    };
  };
  return;
}
`;

describe("going on from where a choice stopped", () => {
  let app: StandInApp;
  let report: JourneyReport;
  beforeAll(async () => {
    app = await standInApp({ own: NOTEBOOK });
    let under: JourneysUnderWay | undefined;
    const hints: JourneyHints = { actions: [{ screen: "/home", label: "Start your notebook", does: "starts a notebook" }], screens: [] };
    await scanSite({ startUrl: app.url, maxPages: 2, maxDurationMs: 15_000, delayMs: 0, standIn: { addresses: ["/home"], maxPages: 2, maxDurationMs: 15_000, later: Promise.resolve({ journeyHints: hints }) }, onJourneys: (walk) => { under = walk; } });
    await under?.done;
    report = under!.soFar();
  }, 240_000);
  afterAll(() => app.close());

  it("takes the other choice on the screen a file choice stopped on, in that session, and says what it took and left", () => {
    const named = (name: string) => report.journeys.find((j) => j.name === name);
    expect(named("Start your notebook")).toMatchObject({ outcome: "stopped_here", stop: { kind: "file" }, pick: { label: "Upload a page" } });
    const other = named("Start your notebook › Write one now")!;
    expect(other).toMatchObject({ outcome: "finished" });
    // Walked from the start again, it would never have pressed the choice that stopped: it went on from that screen, opened once.
    expect(other.steps.filter((s) => s.did === "open")).toHaveLength(1);
    expect(other.steps.filter((s) => s.left).map((s) => s.label)).toEqual(["Upload a page"]);
    expect(other.steps.filter((s) => s.did === "stop")).toEqual([]);
    expect(other.steps.some((s) => s.did === "fill" && s.saved)).toBe(true);
    // The last screen only comes at once to a browser that asked for less motion.
    expect(other.steps.at(-1)).toMatchObject({ did: "fill", moved: "step" });
  });

  it("let nothing out going on, either", () => {
    expect(app.backend).toEqual([]);
    expect(app.local.filter((h) => h.method !== "GET" && h.method !== "HEAD")).toEqual([]);
  });
});

/** A screen whose two ways on are drawn only to a tab that hasn't taken either: taking one is kept in the tab's own storage. */
const DRAFTS = `
const nav = '<nav><a href="/home">Home</a></nav>';
if (page === "/home") {
  const open = sessionStorage.getItem("note-open");
  draw(nav + '<main><h1>Your desk</h1><p>Everything you have written, kept for you in one place.</p>' + (open ? '<p>You have a note open.</p>' : '<button id="note">Start a note</button> <button id="list">Add a list</button>') + '</main>');
  if (!open) {
    document.getElementById("note").onclick = () => { sessionStorage.setItem("note-open", "1"); location.href = "/notes"; };
    document.getElementById("list").onclick = () => { sessionStorage.setItem("note-open", "1"); location.href = "/lists"; };
  }
  return;
}
if (page === "/notes") return draw(nav + '<main><h1>Your note</h1><p>A blank page, ready for whatever you want to write.</p></main>');
if (page === "/lists") return draw(nav + '<main><h1>Your lists</h1><p>Each list you make is kept here, in the order you made it.</p></main>');
`;

describe("one journey after another in one browser", () => {
  it("starts each from nothing: what one left in the tab's own storage isn't the next one's", async () => {
    const app = await standInApp({ own: DRAFTS });
    try {
      let under: JourneysUnderWay | undefined;
      // One browser, so both are walked in it, one after the other.
      await scanSite({ startUrl: app.url, maxPages: 2, maxDurationMs: 15_000, delayMs: 0, standIn: { addresses: ["/home"], maxPages: 2, maxDurationMs: 15_000 }, onJourneys: (walk) => { under = walk; } }, { ...process.env, CONTEXTMACHINES_JOURNEY_BROWSERS: "1" });
      await under?.done;
      expect(under!.browsers).toBe(1);
      const report = under!.soFar();
      for (const name of ["Start a note", "Add a list"]) {
        const journey = report.journeys.find((j) => j.name === name);
        expect(journey?.steps.some((s) => s.did === "press" && s.label === name), name).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 120_000);
});

describe("ending a walk", () => {
  const started = async (app: StandInApp, signal?: AbortSignal) => {
    let under: JourneysUnderWay | undefined;
    await scanSite({ startUrl: app.url, maxPages: 3, maxDurationMs: 15_000, delayMs: 0, ...(signal ? { signal } : {}), standIn: { addresses: ["/home", "/trades"], maxPages: 2, maxDurationMs: 15_000, firstRun: ["/onboarding"] }, onJourneys: (walk) => { under = walk; } });
    return under!;
  };

  it("stops where it is when told, with what it didn't get to named, whatever else is going on", async () => {
    const app = await journeysApp();
    try {
      const under = await started(app);
      under.stop();
      const before = Date.now();
      await under.done;
      expect(Date.now() - before).toBeLessThan(15_000);
      const report = under.soFar();
      expect(report.status).toBe("walked");
      expect(report.notFinished.length + report.journeys.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  }, 120_000);

  it("ends with the run on Ctrl-C", async () => {
    const app = await journeysApp();
    const stopping = new AbortController();
    try {
      let under: JourneysUnderWay | undefined;
      await scanSite({ startUrl: app.url, maxPages: 3, maxDurationMs: 15_000, delayMs: 0, signal: stopping.signal, standIn: { addresses: ["/home"], maxPages: 2, maxDurationMs: 15_000, firstRun: ["/onboarding"] }, onJourneys: (walk) => { under = walk; stopping.abort(); } });
      await under?.done;
      expect(under?.soFar().journeys.filter((j) => j.outcome === "finished")).toEqual([]);
    } finally {
      await app.close();
    }
  }, 120_000);

  it("ends at once on a Ctrl-C that comes as the new account is walked, however near the journeys' start", async () => {
    const app = await journeysApp();
    try {
      // Around when the journeys would start: either side of it, and with the new account part walked.
      for (const after of [2500, 3500]) {
        const stopping = new AbortController();
        let under: JourneysUnderWay | undefined;
        await scanSite({ startUrl: app.url, maxPages: 3, maxDurationMs: 15_000, delayMs: 0, signal: stopping.signal, standIn: { addresses: ["/home", "/trades"], maxPages: 2, maxDurationMs: 15_000, firstRun: ["/onboarding"] }, onStage: (stage) => { if (stage.kind === "public-over") setTimeout(() => stopping.abort(), after).unref(); }, onJourneys: (walk) => { under = walk; } });
        stopping.abort();
        if (!under) continue;
        const settled = (promise: Promise<void>) => Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000).unref())]);
        expect(await settled(under.done)).toBe(true);
        expect(await settled(under.walked)).toBe(true);
      }
    } finally {
      await app.close();
    }
  }, 120_000);

  it("gives a run with nothing left to do its least and no more", async () => {
    const app = await journeysApp();
    try {
      const under = await started(app);
      const before = Date.now();
      await under.atLeast;
      expect(Date.now() - before).toBeLessThan(35_000);
      under.stop();
      await under.done;
    } finally {
      await app.close();
    }
  }, 120_000);
});

describe("pressing outside the seal", () => {
  it("refuses a walk with no seal, whatever asked for it", async () => {
    const app = await journeysApp();
    try {
      await expect(scanSite({ startUrl: app.url, maxPages: 1, maxDurationMs: 5000, walk: async () => {} })).rejects.toThrow(/seal/);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("doesn't walk on a real session, even when asked", async () => {
    const app = await journeysApp();
    let told = false;
    try {
      const result = await scanSite({ startUrl: app.url, maxPages: 2, maxDurationMs: 8000, delayMs: 0, realWrites: true, standIn: { addresses: ["/home"], maxDurationMs: 8000 }, onJourneys: () => { told = true; } });
      expect(result.standIn?.status).toBe("refused");
      expect(told).toBe(false);
    } finally {
      await app.close();
    }
  }, 60_000);
});
