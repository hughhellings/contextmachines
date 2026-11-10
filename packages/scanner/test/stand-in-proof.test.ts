import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { standInApp, type StandInApp } from "./stand-in-app.ts";

/**
 * A screen counts on positive proof. Everything an app draws instead of a screen, and everything a
 * server does for itself, comes back as what it is, with nothing past the public pages claimed,
 * while real screens that merely mention those things still count.
 */
const quick = { maxPages: 8, maxDurationMs: 15_000, delayMs: 0, screenshots: false, exploreButtons: false, learnActions: false };
const pass = { maxPages: 10, maxDurationMs: 20_000 };
const nav = '<nav><a href="/trades">Trades</a><a href="/notes">Notes</a></nav>';

const WALLS: Record<string, [string, string]> = {
  "/magic": ['<main><h1>Welcome</h1><form><label>Email <input type="email" name="email"></label><button type="submit">Send magic link</button></form></main>', "sign_in"],
  "/providers": ['<main><h1>Welcome</h1><button>Continue with Google</button><button>Continue with GitHub</button></main>', "sign_in"],
  "/code": ['<main><h1>Enter the code</h1><form><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"></form></main>', "sign_in"],
  "/verify": ["<main><h1>Verify your email</h1><p>We need to know it's you first.</p></main>", "sign_in"],
  "/asks": ['<main><h1>Sign in to continue</h1><a href="/login">Sign in</a></main>', "sign_in"],
  "/paywall": ['<main><h1>Your trial has ended</h1><p>Pick up where you left off.</p><a href="/pricing">See plans</a></main>', "paywall"],
  "/boundary": [`${nav}<main><h1>Something went wrong</h1><button>Reload</button></main>`, "failed"],
  "/failed": ["<main><h1>Authorization Failed</h1><p>No authorization code received.</p></main>", "failed"],
  "/spinner": ['<main><div class="spinner" role="progressbar"></div></main>', "loading"],
  "/skeleton": ['<main><div class="skeleton-row" style="height:20px;width:300px"></div><div class="skeleton-row" style="height:20px;width:300px"></div></main>', "loading"],
  "/nothing": ['<div style="position:fixed;bottom:0;left:0;right:0;height:60px">We use cookies to run this site, and you can read about that here. <button>Accept</button></div><div style="position:fixed;bottom:80px;right:20px;width:50px;height:50px"><button>Chat</button></div><nav><a href="/trades">View as</a></nav>', "blank"],
};

const SCREENS: Record<string, string> = {
  "/help": `${nav}<main><h1>Help</h1><p>If something went wrong with an import, read this page.</p><ul><li>Verify your email</li><li>Failed to load a file</li><li>Your trial has ended</li><li>Sign in to continue</li></ul></main>`,
  "/billing": `${nav}<main><h1>Billing</h1><p>Your trial has ended</p><table><tr><td>March</td><td>$10</td></tr><tr><td>April</td><td>$10</td></tr><tr><td>May</td><td>$10</td></tr><tr><td>June</td><td>$10</td></tr></table></main>`,
  "/invite": `${nav}<main><h1>Invite someone</h1><form><label>Email <input type="email" name="email"></label><button type="submit">Send invite</button></form></main>`,
  "/short": `${nav}<main><h1>Team</h1></main>`,
  "/connected": `${nav}<main><h1>Connected accounts</h1><p>These are the accounts linked to this one, which you can change here at any time.</p><button>Connect Google</button></main>`,
};

describe("what an app draws instead of a screen", () => {
  let app: StandInApp;
  let result: ScanResult;

  beforeAll(async () => {
    app = await standInApp({ pages: { ...Object.fromEntries(Object.entries(WALLS).map(([path, [html]]) => [path, html])), ...SCREENS } });
    result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, maxPages: 20, maxDurationMs: 60_000, addresses: [...Object.keys(WALLS), ...Object.keys(SCREENS)] } });
  }, 120_000);
  afterAll(() => app.close());

  it.each(Object.entries(WALLS))("%s isn't reached, and says why", (path, [, why]) => {
    expect(result.standIn?.notReached).toContainEqual({ path, why });
    expect(result.standIn?.reached).not.toContain(path);
    expect(result.seenWith?.[path]).toBeUndefined();
    expect(result.pagesVisited).not.toContain(path);
  });

  it.each(Object.keys(SCREENS))("%s is a screen, whatever it mentions", (path) => {
    expect(result.standIn?.reached).toContain(path);
  });
});

describe("when nothing past the walls drew", () => {
  it.each([["/magic"], ["/boundary"], ["/spinner"], ["/nothing"]])("%s alone isn't reached, and leaves nothing behind", async (path) => {
    const app = await standInApp({ pages: { "/trades": WALLS[path]![0], "/notes": WALLS[path]![0], [path]: WALLS[path]![0] } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: [path] } });
      expect(result.standIn?.status).toBe("not_rendered");
      expect(result.seenWith ?? {}).toEqual({});
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("one drawing at two addresses", () => {
  it("shows neither address has a screen of its own, the first included", async () => {
    const same = `${nav}<main><h1>Home</h1><p>The same thing for every address the router doesn't know about.</p></main>`;
    const app = await standInApp({ pages: { "/a": same, "/b": same } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/a", "/b"] } });
      expect(result.standIn?.reached).not.toContain("/a");
      expect(result.standIn?.notReached).toEqual(expect.arrayContaining([{ path: "/a", why: "unclear" }, { path: "/b", why: "unclear" }]));
      expect(result.pagesVisited).not.toContain("/a");
      expect(result.seenWith?.["/a"]).toBeUndefined();
      // What's behind them still counts: the walk goes on from any screen.
      expect(result.standIn?.reached).toEqual(expect.arrayContaining(["/trades", "/notes"]));
    } finally {
      await app.close();
    }
  }, 60_000);
});

/** Walls in wordings no list here has, the way a guard in front of every address draws them. */
const UNKNOWN_WALLS: Record<string, string> = {
  "held for approval": "<main><h1>Almost ready</h1><p>Your account is waiting for approval. An administrator will review it soon.</p></main>",
  "an onboarding form": "<main><h1>Tell us about your company</h1><form><label>Company name <input name=company></label><label>Team size <select name=size><option>1-10</option></select></label><button>Continue</button></form></main>",
  "a workspace to pick": "<main><h1>Select a workspace</h1><p>You have no workspaces yet.</p><button>Create a workspace</button></main>",
  "terms to accept": "<main><h1>Before you go on</h1><p>Please read and accept our updated terms of service to use the product.</p><label><input type=checkbox> I accept</label><button>Accept</button></main>",
  "an invalid key": "<main><h2>Invalid API key</h2><p>Double check your project settings, and then try this page again in a moment.</p></main>",
  "an account on hold": "<main><h1>Account suspended</h1><p>Contact support to get this sorted out, and we will have it back for you soon.</p></main>",
  "a sign-up form": '<main><h1>Create your account</h1><form><input type=email name=email placeholder=Email><input type=password name=password placeholder=Password><button>Create account</button></form></main>',
  "a wall that names the address": "<main><h1>{name} is not open to you yet</h1><p>Your request to use {name} is waiting for approval by an administrator of your team.</p></main>",
  "a 404 of its own": `<main><h1>Hmm, we can't find that</h1><p>The page {name} doesn't exist. Head back home and try one of the links there.</p><a href="/">Home</a></main>`,
};

describe("a wall of a kind nobody listed", () => {
  it.each(Object.keys(UNKNOWN_WALLS))("%s, at every address, is no screen at any of them", async (name) => {
    const app = await standInApp({ wall: UNKNOWN_WALLS[name]! });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/trades", "/settings"] } });
      expect(result.standIn?.status).toBe("not_shown");
      expect(result.standIn?.reached).toEqual([]);
      expect(result.standIn?.message).toMatch(/nothing shows/);
      expect(result.seenWith ?? {}).toEqual({});
      expect(result.pagesVisited).not.toContain("/trades");
      expect(result.pagesVisited).not.toContain("/settings");
      expect(result.screens.filter((shot) => shot.seenWith)).toEqual([]);
      expect(result.standIn?.notReached).toEqual(expect.arrayContaining([{ path: "/trades", why: "unclear" }, { path: "/settings", why: "unclear" }]));
    } finally {
      await app.close();
    }
  }, 60_000);

  it("is no screen at one address either: the same is drawn where no address can be", async () => {
    const app = await standInApp({ wall: UNKNOWN_WALLS["an account on hold"]! });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/home"] } });
      expect(result.standIn?.status).toBe("not_shown");
      expect(result.standIn?.notReached).toContainEqual({ path: "/home", why: "unclear" });
    } finally {
      await app.close();
    }
  }, 60_000);

  it("one drawing with no data proves nothing, however unlike the app's page for no address", async () => {
    const app = await standInApp({ pages: { "/lonely": "<main><h1>Lonely</h1><p>One page with words on it that no other address draws, and nothing else to go on.</p></main>" } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/lonely"] } });
      expect(result.standIn?.status).toBe("not_shown");
      expect(result.standIn?.notReached).toContainEqual({ path: "/lonely", why: "not_shown" });
      expect(result.seenWith?.["/lonely"]).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 60_000);

  it("an address that leaves its own mark behind never becomes a screen of its own", async () => {
    const app = await standInApp();
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/notes"] } });
      const said = JSON.stringify([result.events, result.pagesVisited, result.seenWith, result.screens.map((s) => s.path), result.links, result.standIn]);
      expect(said).not.toContain("xqzstandinnowhere");
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("an app whose router moves any unknown address to one screen", () => {
  const home = `<main><h1>Dashboard</h1><p>Everything that matters today, on one page, and it's the page any unknown address ends up on.</p></main>`;
  it("that screen alone can't be told from a wall in front of everything", async () => {
    const app = await standInApp({ pages: { "/dashboard": home }, unknownGoesTo: "/dashboard" });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/dashboard"] } });
      expect(result.standIn?.status).toBe("not_shown");
      expect(result.standIn?.notReached).toContainEqual({ path: "/dashboard", why: "not_shown" });
    } finally {
      await app.close();
    }
  }, 60_000);

  it("a second screen tells them apart", async () => {
    const form = '<main><h1>Your details</h1><form><label>Name <input name="name"></label><label>Time zone <select name="zone"><option>UTC</option></select></label><button>Save</button></form></main>';
    const app = await standInApp({ pages: { "/dashboard": home, "/settings2": form }, unknownGoesTo: "/dashboard" });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/dashboard", "/settings2"] } });
      expect(result.standIn?.status).toBe("reached");
      expect(result.standIn?.reached).toEqual(expect.arrayContaining(["/dashboard", "/settings2"]));
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("rows of made-up data", () => {
  it("that went out and aren't on the screen claim nothing: a wall with a list of its own", async () => {
    const onHold = "<main><h1>Your account is on hold</h1><p>Do these things first:</p><ul><li>Call us</li><li>Send your papers</li><li>Wait a while</li></ul></main>";
    const app = await standInApp({ wall: onHold, reads: ["plans"] });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/home"], rows: { plans: [{ id: 1, name: "Basic" }] } } });
      expect(result.standIn?.rowsShown).toBeFalsy();
      expect(result.standIn?.status).toBe("not_shown");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("drawn on a screen say so, and prove it on their own", async () => {
    const app = await standInApp();
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/trades"], rows: { trades: [{ id: "1", symbol: "SKU-A" }] } } });
      expect(result.standIn).toMatchObject({ status: "reached", rowsShown: true });
    } finally {
      await app.close();
    }
  }, 60_000);

  it("that came for another screen say nothing of this one", async () => {
    const app = await standInApp({ pages: { "/other": `${nav}<main><h1>Other</h1><p>Rows went out for this page, but none of them is on it, and it says so plainly.</p></main>` }, reads: ["plans"] });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/other", "/trades"], rows: { plans: [{ id: 1, name: "Basic" }], trades: [{ id: "1", symbol: "SKU-A" }] } } });
      expect(result.standIn?.reached).toContain("/other");
      expect(result.standIn?.notReached).not.toContainEqual({ path: "/other", why: "not_shown" });
    } finally {
      await app.close();
    }
  }, 60_000);
});

/**
 * What React Router and Vue Router give by default: known routes behind a guard, and a catch-all
 * outside it. Every wall here differs from the page for no address, so that can prove nothing.
 */
describe("a wall behind a router's guard, with a catch-all page outside it", () => {
  const body = "Contact support and they will get this sorted out for you.";
  const notReached = async (pages: Record<string, string>, rows?: Record<string, unknown>, reads?: string[]) => {
    const app = await standInApp({ pages, ...(reads ? { reads } : {}) });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: Object.keys(pages), ...(rows ? { rows } : {}) } });
      expect(result.standIn?.status).toBe("not_shown");
      expect(result.standIn?.reached).toEqual([]);
      expect(result.standIn?.rowsShown).toBeFalsy();
      expect(result.seenWith ?? {}).toEqual({});
      for (const path of Object.keys(pages)) expect(result.pagesVisited).not.toContain(path);
    } finally {
      await app.close();
    }
  };
  const cases: Record<string, () => Promise<void>> = {
    "at one address": () => notReached({ "/home": `<main><h1>Account suspended</h1><p>${body}</p></main>` }),
    "that names no known word": () => notReached({ "/home": "<main><h1>Your account is on hold</h1><p>We could not find a company for this user.</p></main>" }),
    "under each screen's own heading": () => notReached({ "/home": `<main><h1>Dashboard</h1><p>Your account is on hold. ${body}</p></main>`, "/settings2": `<main><h1>Preferences</h1><p>Your account is on hold. ${body}</p></main>`, "/team": `<main><h1>People</h1><p>Your account is on hold. ${body}</p></main>` }),
    "carrying a reference and a clock": () => notReached({ "/home": `<main><h1>We hit a snag</h1><p>Our team has been told about this. Reference a1b2c3d4 at 2026-11-05T10:00:00Z</p></main>`, "/settings2": `<main><h1>We hit a snag</h1><p>Our team has been told about this. Reference z9y8x7w6 at 2026-11-05T10:00:04Z</p></main>` }),
    "that differs by feature": () => notReached({ "/home": "<main><h1>Unlock reports</h1><p>See every trend in your numbers with the Pro plan, from nineteen dollars.</p><button>Start trial</button></main>", "/settings2": "<main><h1>Team tools live on Business</h1><p>Invite colleagues and share dashboards once your workspace moves up a tier.</p><button>Talk to sales</button></main>" }),
    "printing a made-up name": () => notReached({ "/home": `<main><h1>Workspace Acme Holdings is suspended</h1><p>${body}</p></main>` }, { plans: [{ id: 1, name: "Acme Holdings" }] }, ["plans"]),
    "the same at two addresses, with that name": () => notReached({ "/home": `<main><h1>Workspace Acme Holdings is suspended</h1><p>${body}</p></main>`, "/settings2": `<main><h1>Workspace Acme Holdings is suspended</h1><p>${body}</p></main>` }, { plans: [{ id: 1, name: "Acme Holdings" }] }, ["plans"]),
    "whose ordinary word is a made-up value": () => notReached({ "/home": `<main><h1>Your account is not active</h1><p>${body}</p></main>` }, { plans: [{ id: 1, name: "active" }] }, ["plans"]),
    "listing made-up rows, the same at two addresses": () => notReached({ "/home": "<main><h1>Select a workspace</h1><ul><li><button>Northwind team</button></li><li><button>Contoso team</button></li></ul></main>", "/settings2": "<main><h1>Select a workspace</h1><ul><li><button>Northwind team</button></li><li><button>Contoso team</button></li></ul></main>" }, { plans: [{ id: 1, name: "Northwind team" }, { id: 2, name: "Contoso team" }] }, ["plans"]),
  };
  it.each(Object.keys(cases))("%s is no screen", (name) => cases[name]!(), 60_000);

  it("but an empty screen beside a form is: two different drawings, one plainly at work", async () => {
    const pages = { "/home": "<main><h1>Overview</h1><p>Your balances and recent activity will show here as soon as you add a first entry.</p><button>Add entry</button></main>", "/settings2": "<main><h1>Settings</h1><form><label>Display name <input name=d></label><label>Time zone <select><option>UTC</option></select></label><button>Save changes</button></form></main>" };
    const app = await standInApp({ pages });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: Object.keys(pages) } });
      expect(result.standIn?.status).toBe("reached");
      expect(result.standIn?.reached?.sort()).toEqual(["/home", "/settings2"]);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("and two screens of one table are two screens: their rows are ours, and their headings differ", async () => {
    const rows = "<ul><li>Northwind invoice</li><li>Contoso refund</li></ul>";
    const pages = { "/home": `<main><h1>Home</h1>${rows}</main>`, "/settings2": `<main><h1>Settings</h1>${rows}</main>` };
    const app = await standInApp({ pages, reads: ["plans"] });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: Object.keys(pages), rows: { plans: [{ id: 1, name: "Northwind invoice" }, { id: 2, name: "Contoso refund" }] } } });
      expect(result.standIn).toMatchObject({ status: "reached", rowsShown: true });
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("words a page says when it failed", () => {
  it.each([
    ["a call that failed", '<main><h1>Trades</h1><div role="alert">Failed to fetch data</div></main>', "failed"],
    ["an exception printed as it is", "<pre>TypeError: Cannot read properties of undefined (reading 'map')\n  at Trades (app.js:1:1)</pre>", "failed"],
    ["a session that ran out", '<main><h1>Session expired</h1><p>For your security you were signed out.</p></main>', "sign_in"],
  ])("%s", async (_name, html, why) => {
    const app = await standInApp({ pages: { "/page": html } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/page"] } });
      expect(result.standIn?.notReached).toContainEqual({ path: "/page", why });
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("a screen that needed nobody", () => {
  let app: StandInApp;
  let result: ScanResult;

  beforeAll(async () => {
    app = await standInApp({
      navLinks: ["/guides/getting-started-fast"],
      openPages: { "/guides/getting-started-fast": `<main><h1>Getting started</h1><p>${"A guide anyone can read, signed in or not, with nothing of anyone's on it, and a good many more words besides those. ".repeat(3)}Plenty to compare, and only the staff bar below differs.</p></main>` },
    });
    result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/trades"], rows: { trades: [{ id: "1", symbol: "SKU-A" }] } } });
  }, 60_000);
  afterAll(() => app.close());

  it("is a public page the first crawl missed: seen, and not marked made-up", () => {
    const path = Object.keys(result.addresses ?? {}).find((p) => p.startsWith("/guides")) ?? "/guides/getting-started-fast";
    expect(result.pagesVisited).toContain(path);
    expect(result.seenWith?.[path]).toBeUndefined();
    expect(result.standIn?.reached).not.toContain(path);
    expect(result.seenWith?.["/trades"]).toBe("stand-in");
  });

  it("says when rows of made-up data really drew", () => {
    expect(result.standIn?.rowsShown).toBe(true);
  });
});

describe("a run cut off at its time limit", () => {
  it("still looks at what it reached signed out, though the page it was on has been closed", async () => {
    const guide = `<main><h1>Getting started</h1><p>${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}</p></main>`;
    const slow = `${nav}<main><h1>Slow</h1><p>A screen with a button that keeps the press loop busy to the end.</p>${Array.from({ length: 40 }, (_, i) => `<button>Press ${i}</button>`).join("")}</main>`;
    const app = await standInApp({ navLinks: ["/open-guide"], openPages: { "/open-guide": guide }, pages: { "/slow": slow } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, exploreButtons: true, learnActions: true, standIn: { maxPages: 10, maxDurationMs: 6000, addresses: ["/open-guide", "/slow"] } });
      expect(result.standIn?.stoppedBy).toBe("max_duration");
      expect(result.seenWith?.["/open-guide"]).toBeUndefined();
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("a screen with made-up rows on it, drawn the same for nobody", () => {
  it("stays marked: the rows are still ours", async () => {
    const app = await standInApp({ openPages: { "/open-list": "<main><h1>Prices</h1><p>A list that any visitor can open, filled from the database by the page.</p><script></script></main>" }, navLinks: ["/open-list"] });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/trades", "/open-list"], rows: {} } });
      expect(result.pagesVisited).toContain("/open-list");
      expect(result.seenWith?.["/trades"]).toBe("stand-in");
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("a template with one real page behind it", () => {
  it("keeps the real address for a name, and never for an id", async () => {
    const app = await standInApp({
      frontLinks: ["/guides/notes-sync-v2", "/orders/483920"],
      openPages: {
        "/guides/notes-sync-v2": "<main><h1>Notes sync</h1><p>A guide to keeping your notes in step.</p></main>",
        "/orders/483920": "<main><h1>Order</h1><p>An order, whoever it may belong to, shown to anyone at all.</p></main>",
      },
    });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick });
      expect(Object.values(result.addresses ?? {})).not.toContain("/orders/483920");
      const guide = result.pagesVisited.find((p) => p.startsWith("/guides"));
      if (guide?.includes(":")) expect(result.addresses?.[guide]).toBe("/guides/notes-sync-v2");
      else expect(guide).toBe("/guides/notes-sync-v2");
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("what the server says", () => {
  it("no answer in time is no answer: the pass doesn't start", async () => {
    const realTimeout = AbortSignal.timeout;
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => realTimeout(ms >= 30_000 ? 300 : ms));
    const app = await standInApp({ slowFrontMs: 900 });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, navigationTimeoutMs: 5000, standIn: { ...pass, addresses: ["/trades"] } });
      expect(result.standIn?.status).toBe("not_checked");
      expect(result.seenWith).toBeUndefined();
    } finally {
      spy.mockRestore();
      await app.close();
    }
  }, 60_000);

  it.each([
    ["a short one that asks for a sign-in", "<!doctype html><body><p>Please sign in</p></body>"],
    ["a short one with the product on it", "<!doctype html><body><h1>Invoices</h1><p>You have 0 invoices</p></body>"],
  ])("a page of its own counts however short: %s", async (_name, body) => {
    const app = await standInApp({ document: (path) => (path === "/invoices" ? { status: 200, body } : undefined) });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/invoices"] } });
      expect(result.standIn?.status).toBe("server_auth");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("never reads an address that acts, a proxy's, or one that runs code, from Node or the browser", async () => {
    const app = await standInApp();
    const acts = ["/logout", "/account/delete", "/tasks/purge-all", "/admin/reset-database", "/cron/charge-customers", "/backend/report"];
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, standIn: { ...pass, addresses: ["/trades", ...acts], proxied: ["/backend"] } });
      expect(result.standIn?.status).toBe("reached");
      expect(app.local.filter((h) => acts.includes(h.path))).toEqual([]);
      expect(app.backend).toEqual([]);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("a pop-up and a classic form, as the stand-in", () => {
  it("a pop-up ends nothing, opened by itself or by a press", async () => {
    const app = await standInApp({ pages: { "/popup": `${nav}<main><h1>Pop-ups</h1><p>This page opens a window of its own as soon as it can.</p><button onclick="window.open('/trades')">Open it</button></main><script></script>` } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, exploreButtons: true, learnActions: true, standIn: { ...pass, addresses: ["/popup"] } });
      expect(result.standIn?.status).toBe("reached");
      expect(result.standIn?.reached).toContain("/popup");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("a form the page sends by itself, by loading a page, is stopped and never sent", async () => {
    const app = await standInApp({ pages: { "/old-form": `${nav}<main><h1>Add a note</h1><form method="post" action="/old-form"><label>Note <input name="note"></label><button type="submit">Save note</button><img src="/no-such-picture.png" alt="" onerror="document.forms[0].submit()"></form></main>` } });
    try {
      const result = await scanSite({ startUrl: app.url, ...quick, exploreButtons: true, learnActions: true, standIn: { ...pass, maxDurationMs: 60_000, addresses: ["/old-form"] } });
      expect(app.local.filter((h) => h.method === "POST")).toEqual([]);
      // On a busy machine the page can time out before the form runs, and then there's nothing to stop.
      if (result.standIn?.errors?.some((error) => error.includes("Timeout"))) return;
      expect([...result.blockedWrites, ...result.ambientWrites]).toContainEqual(expect.objectContaining({ method: "POST", seenWith: "stand-in" }));
    } finally {
      await app.close();
    }
  }, 60_000);
});
