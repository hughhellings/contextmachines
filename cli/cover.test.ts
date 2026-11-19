// The cover (packages/scanner/src/tester/cover.ts): a signed-in run, or one that types a stored value,
// keeps its live screen, video and step photos, and no frame of them shows a stored value. Proved on the
// local auth fixture (127.0.0.1) with a known test username, password and an email code, by measuring
// in the page itself: every animation frame drawn while a stored value sat in a field had that field
// drawn as dots (or the card up), and every password field's text was dots. Then the live screen's
// frames, the video and the photos are read by their pixels, and the leak check runs over the run folder
// and its export. No AI, no network. (dots.test.ts proves the sign-in itself, frame by frame.)
//   node --test cli/cover.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import type { SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { Cover, COVER_COLOR, hashHeld, SIGN_IN_SAVED, TYPING_CARD, VIDEO_CARD, VIDEO_DOTS, VIDEO_STILL_SHOWS } from "../packages/scanner/src/tester/cover.ts";
import { SecretFields } from "../packages/scanner/src/tester/maskshot.ts";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch, record } from "../packages/scanner/src/tester/record.ts";
import { runTest, typesStored, videoNote } from "../packages/scanner/src/tester/run.ts";
import { screencast, type Frame } from "../packages/scanner/src/tester/screencast.ts";
import { accountResolver, fileStore, parseAccounts, secretsPathFor } from "./accounts.ts";
import { exportRun } from "./app/data/export.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { leakHits, placesIn } from "./leak.ts";
import { writeRun } from "./test-command.ts";

const USER = "qa.cover.k3v9@example.test";
const PASSWORD = "pw-LEAK-cover-9Qz4mT2x";

let browser: Browser;
let site: AuthSite;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

before(async () => {
  browser = await launch();
  site = await startAuthSite({ users: [{ username: USER, password: PASSWORD }] });
});
after(async () => {
  await site?.close();
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const RGB = [0x1e, 0x2a, 0x44] as const;
assert.equal(COVER_COLOR.toLowerCase(), "#1e2a44");

/** Runs in a page: whether each JPEG or video frame is the card, by a few pixels near its edges. */
async function cardsIn(page: Page, jpegs: string[]): Promise<boolean[]> {
  return page.evaluate(async ([list, rgb]) => {
    const out: boolean[] = [];
    const c = document.createElement("canvas");
    const g = c.getContext("2d", { willReadFrequently: true })!;
    for (const b64 of list) {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      g.drawImage(img, 0, 0);
      const at = [[4, 4], [c.width - 5, 4], [4, c.height - 5], [c.width - 5, c.height - 5], [Math.floor(c.width / 2), 8]];
      out.push(at.every(([x, y]) => {
        const d = g.getImageData(x!, y!, 1, 1).data;
        return Math.abs(d[0]! - rgb[0]) < 14 && Math.abs(d[1]! - rgb[1]) < 14 && Math.abs(d[2]! - rgb[2]) < 14;
      }));
    }
    return out;
  }, [jpegs, RGB] as const);
}

/** The video read frame by frame (every `step` s) in a page: whether each is the card, and how long it is. */
async function videoCards(file: string, step = 0.04): Promise<{ cards: boolean[]; seconds: number }> {
  const page = await browser.newPage();
  try {
    const webm = readFileSync(file).toString("base64");
    return await page.evaluate(async ([b64, every, rgb]) => {
      const v = document.createElement("video");
      v.muted = true;
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      v.src = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
      await new Promise((ok, no) => {
        v.onloadeddata = ok;
        v.onerror = no;
      });
      // A webm from a recorder may not say how long it is until it has been read to its end.
      if (!Number.isFinite(v.duration)) {
        v.currentTime = 1e9;
        await new Promise((ok) => (v.ontimeupdate = ok));
      }
      const seconds = v.duration;
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      const cards: boolean[] = [];
      for (let t = 0; t < seconds; t += every) {
        v.currentTime = t;
        await new Promise((ok) => (v.onseeked = ok));
        g.drawImage(v, 0, 0);
        const at = [[4, 4], [c.width - 5, 4], [4, c.height - 5], [c.width - 5, c.height - 5]];
        cards.push(at.every(([x, y]) => {
          const d = g.getImageData(x!, y!, 1, 1).data;
          return Math.abs(d[0]! - rgb[0]) < 14 && Math.abs(d[1]! - rgb[1]) < 14 && Math.abs(d[2]! - rgb[2]) < 14;
        }));
      }
      return { cards, seconds };
    }, [webm, step, RGB] as const);
  } finally {
    await page.close();
  }
}

/** Runs of true in a list: how many separate card stretches. */
const stretches = (xs: boolean[]) => xs.filter((x, i) => x && !xs[i - 1]).length;

/** What the probe saw in each animation frame (only when it changed): every field's value and whether it was drawn as dots, the card up, the password fields masked. */
interface Sample {
  t: number;
  vals: string[];
  dots: boolean[];
  covered: boolean;
  pwMasked: boolean;
  pw: number;
  url: string;
}

/** A stored value shows in this frame: a field holds one and is neither dots nor under the card. */
const shows = (s: Sample, secrets: readonly string[]) => !s.covered && s.vals.some((v, k) => v && secrets.some((x) => v.includes(x)) && !s.dots[k]);

/**
 * The probe, for tests only: before each frame is drawn (requestAnimationFrame), what the page holds.
 * It reads values to compare them in Node, so it is never part of the product.
 */
function probe(): void {
  if (window.top !== window) return;
  let last = "";
  const tick = () => {
    const fields = Array.from(document.querySelectorAll("input, textarea"));
    const vals = fields.map((e) => (e as HTMLInputElement).value);
    const dots = fields.map((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security") === "disc");
    const host = document.querySelector("cm-cover") as HTMLElement | null;
    const covered = Boolean(host?.isConnected && getComputedStyle(host).display !== "none" && getComputedStyle(host).visibility !== "hidden");
    const pws = Array.from(document.querySelectorAll("input[type=password]"));
    const pwMasked = pws.every((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security") === "disc");
    const key = JSON.stringify([vals, dots, covered, pwMasked]);
    if (key !== last) {
      last = key;
      void (window as unknown as { __cmProbe: (s: unknown) => Promise<void> }).__cmProbe({ t: performance.timeOrigin + performance.now(), vals, dots, covered, pwMasked, pw: pws.length, url: location.href });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** A session signed in on the fixture's /login, made apart (dots.test.ts proves a recorded sign-in). */
async function signedInState(): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(new URL("/login", site.url).href);
  await page.getByLabel("Email").fill(USER);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/app/);
  const path = join(tmp("cm-cover-state-"), "state.json");
  writeFileSync(path, JSON.stringify(await ctx.storageState()));
  await ctx.close();
  return path;
}

describe("the cover on a page", () => {
  it("masks password text in every frame, covers before typing, stays while the value shows, and keeps out of the outline and the checks", async () => {
    const page = await browser.newPage();
    try {
      // A page whose CSP allows no inline style: the mask is a constructed sheet, which a CSP doesn't stop.
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", headers: { "content-security-policy": "default-src 'self'; style-src 'self'" }, body: `<!doctype html><title>Form</title><main><h1>Form</h1><label for=e>Email</label><input id=e><label for=p>Password</label><input id=p type=password><button id=b>Go</button></main>` }));
      const fields = new SecretFields();
      const cover = await Cover.attach(page, fields);
      await page.goto("http://127.0.0.1:9/form");
      await page.evaluate(() => document.getElementById("b")!.addEventListener("click", () => (document.title = "clicked")));
      await page.locator("#p").fill("abc");
      assert.equal(await page.locator("#p").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc", "password text drawn as dots");
      assert.equal(await cover.show(), true);
      assert.equal(cover.log.map((e) => e.kind).join(","), "show,painted");
      fields.add(page.locator("#e"));
      await page.locator("#e").fill("someone@example.test");
      // Clicks go through the card; its words are in no outline and match no check.
      await page.locator("#b").click({ timeout: 2000 });
      assert.equal(await page.title(), "clicked");
      assert.equal(await page.getByText(TYPING_CARD).count(), 0);
      assert.doesNotMatch(await page.locator("body").ariaSnapshot(), /Typing a stored value/);
      assert.doesNotMatch(await page.locator("html").ariaSnapshot(), /Typing a stored value/);
      // Kept while the typed value shows; taken away once it doesn't.
      assert.equal(await cover.release(), false);
      await page.locator("#e").fill("");
      assert.equal(await cover.release(), true);
      assert.equal(await page.locator("cm-cover").count(), 0);
      // While up, a page opened next has it before it is drawn (an init script).
      await cover.show();
      await page.goto("http://127.0.0.1:9/next");
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("cm-cover")!).display), "flex");
      await cover.hide();
      await page.goto("http://127.0.0.1:9/after");
      assert.equal(await page.locator("cm-cover").count(), 0, "a page opened after it came down never has it");
      assert.equal(await page.locator("#p").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc", "the mask stays on every page");
    } finally {
      await page.close();
    }
  });

  it("stays up while the page's own words echo a secret it was given (a key), and comes down once they don't", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<main><p id=m>Saved</p></main>` }));
      const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
      cover.holdFor(() => ["sk-live-ECHO-77aa"]);
      await cover.sync();
      await page.goto("http://127.0.0.1:9/echo");
      await cover.show();
      await page.evaluate(() => (document.getElementById("m")!.textContent = "Your key sk-live-ECHO-77aa was saved"));
      assert.equal(await cover.release(), false, "kept: the page shows the key");
      await page.evaluate(() => (document.getElementById("m")!.textContent = "Saved"));
      assert.equal(await cover.release(), true);
    } finally {
      await page.close();
    }
  });

  it("stays on top of a modal dialog the page opens", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<button id=o onclick="document.getElementById('d').showModal()">Open</button><dialog id=d><input id=p type=password></dialog>`);
      const cover = await Cover.attach(page);
      await cover.show();
      await page.locator("#o").click();
      await page.waitForTimeout(250);
      // The card is drawn last: the top layer's last element is on top.
      const top = await page.evaluate(() => document.elementsFromPoint(5, 5).length ? (getComputedStyle(document.querySelector("cm-cover")!).display) : "");
      assert.equal(top, "flex");
      const shot = (await page.screenshot({ type: "jpeg" })).toString("base64");
      assert.deepEqual(await cardsIn(page, [shot]), [true], "the card is over the dialog");
      await cover.hide();
    } finally {
      await page.close();
    }
  });

  it("knows a stored value when it's typed, and says plainly what the video shows", () => {
    assert.equal(typesStored({ type: "fill", value: "{admin.password}" }), true);
    assert.equal(typesStored({ type: "type", value: "x {code} y" }), true);
    assert.equal(typesStored({ type: "navigate", url: "{admin.magic_link}" }), true);
    assert.equal(typesStored({ type: "fill", value: "hello" }), false);
    assert.equal(typesStored({ type: "fill", value: "my pw-LEAK-x9" }, [["admin.password", "pw-LEAK-x9"]]), true);
    assert.equal(typesStored({ type: "click" }), false);
    assert.match(videoNote({ signedIn: true, signInVideo: true, masked: 2 }), /sign-in is in its own video, with its boxes as dots \(sign-in\.webm\)/);
    assert.ok(videoNote({ signedIn: true, signInVideo: true, masked: 2 }).includes(VIDEO_DOTS));
    assert.ok(videoNote({ signedIn: true }).startsWith(SIGN_IN_SAVED));
    assert.match(videoNote({ masked: 1, carded: 1 }), /A card stands in for the stored value typed where the box couldn't be masked first/);
    assert.doesNotMatch(videoNote({ masked: 1 }), /skips/);
    // Honest: the page's own words (the account's name in a header) are not covered.
    for (const note of [videoNote({ signedIn: true, masked: 2 }), videoNote({ signedIn: true }), videoNote({ masked: 1 }), videoNote({ carded: 3 })]) {
      assert.ok(note.endsWith(VIDEO_STILL_SHOWS), note);
      assert.ok(note.includes(VIDEO_CARD), note);
    }
  });
});

describe("the probe can see a leak (control)", () => {
  it("a page with no cover: the probe sees the typed value drawn uncovered", async () => {
    const page = await browser.newPage();
    try {
      const samples: Sample[] = [];
      await page.exposeBinding("__cmProbe", (_src, s: Sample) => void samples.push(s));
      await page.addInitScript(probe);
      await page.goto(new URL("/login", site.url).href);
      await page.getByLabel("Email").fill(USER);
      await page.waitForTimeout(200);
      assert.ok(samples.some((s) => !s.covered && s.vals.includes(USER)), "with no cover, the probe flags the frame");
    } finally {
      await page.close();
    }
  });
});

describe("an AI's run, by a look's references", () => {
  it("no card: the email and the password go into boxes drawn as dots before the first key, and they stay dots (the field is kept by the element, not by a reference that goes stale)", async () => {
    const state = await signedInState();
    const vals: Record<string, string> = { "admin.username": USER, "admin.password": PASSWORD };
    const secrets = { names: () => Object.keys(vals), has: (n: string) => n in vals, get: (n: string) => vals[n], peek: (n: string) => vals[n] };
    let k = 0;
    const brain = {
      async plan() {
        return [{ title: "Confirm it's you", intent: "Type {admin.username} and {admin.password} and press Confirm", check: { kind: "text_visible", text: "Password confirmed" } }];
      },
      async decide(i: { snapshot: string }) {
        const ref = (role: string, name: string) => new RegExp(`\\[(e\\d+)\\] ${role} "${name}"`).exec(i.snapshot)?.[1] ?? "e9999";
        const moves = [{ type: "fill", ref: ref("textbox", "Email"), value: "{admin.username}" }, { type: "fill", ref: ref("textbox", "Password"), value: "{admin.password}" }, { type: "click", ref: ref("button", "Confirm") }];
        return moves[k++] ?? { type: "done" };
      },
    };
    const samples: Sample[] = [];
    const covers: string[] = [];
    const dir = tmp("cm-cover-ai-");
    const out = await runTest({
      url: new URL("/app/confirm", site.url).href, goal: "Confirm it's me", dir, browser, brain: brain as never, secrets: secrets as never, storageState: state, signedInAs: "admin", checkWaitMs: 2000, minutes: 1, accountHosts: [new URL(site.url).host],
      onPage: async (page) => {
        await page.exposeBinding("__cmProbe", (_src, x: Sample) => void samples.push(x));
        await page.addInitScript(probe);
      },
      onCover: (c) => covers.push(c.up ? "up" : "down"),
    });
    assert.equal(out.result.verdict, "pass", JSON.stringify(out.result.steps.map((x) => x.reason)));
    assert.deepEqual(covers, [], "no card: the page stays in view");
    const withSecret = samples.filter((x) => x.vals.some((v) => v.includes(USER) || v.includes(PASSWORD)));
    assert.ok(withSecret.length >= 2);
    assert.deepEqual(withSecret.filter((x) => shows(x, [USER, PASSWORD])).map((x) => x.url), []);
  });
});

describe("the leak gate: a signed-in run that types the username, the password and an email code", () => {
  it("keeps live frames, a video and photos; no frame drawn with a stored value in a field was uncovered; 0 leak hits in the folder and its export", async () => {
    const state = await signedInState();
    const store = fileStore(secretsPathFor(tmp("cm-cover-store-")));
    const host = new URL(site.url).host;
    store.set(`${host}/admin/password`, PASSWORD);
    const account = parseAccounts({ accounts: { admin: { first: "password", username: USER, password: { keychain: true }, codes: [{ catcher: site.url }], signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
    const resolver = accountResolver(account, { host, store, env: {}, inboxWaitMs: 4000 });
    const mask = makeMasker();
    const t = (role: string, name: string) => ({ role, name, nth: 0 });
    const saved = {
      version: 1, rules: 2, goal: "Confirm it's me, then sign in with a code", url: new URL("/app/confirm", site.url).href, savedAt: new Date().toISOString(),
      steps: [
        { title: "Confirm it's you", intent: "Type the email and password and press Confirm", check: { kind: "text_visible", text: "Password confirmed" }, actions: [
          { type: "fill", target: t("textbox", "Email"), value: "{admin.username}" },
          { type: "fill", target: t("textbox", "Password"), value: "{admin.password}" },
          { type: "click", target: t("button", "Confirm") },
        ] },
        { title: "Sign in with a code", intent: "Ask for a code by email and type it", check: { kind: "text_visible", text: "Welcome back" }, actions: [
          { type: "navigate", url: new URL("/code", site.url).href },
          { type: "fill", target: t("textbox", "Email"), value: "{admin.username}" },
          { type: "click", target: t("button", "Send code") },
          { type: "fill", target: t("textbox", "Verification code"), value: "{admin.email_code}" },
          { type: "click", target: t("button", "Sign in") },
        ] },
      ],
    } as unknown as SavedTest;
    const dir = tmp("cm-cover-run-");
    const samples: Sample[] = [];
    const frames: Frame[] = [];
    const covers: string[] = [];
    const coverTimes: number[] = [];
    let info: { noMedia: boolean; covered?: boolean } | undefined;
    let cast: Awaited<ReturnType<typeof screencast>> | undefined;
    const out = await runTest({
      url: saved.url, goal: saved.goal, dir, browser, saved, secrets: resolver, masker: mask, storageState: state, signedInAs: "admin", checkWaitMs: 3000, minutes: 2,
      codeSends: { host }, accountHosts: [host],
      onPage: async (page, i) => {
        info = i;
        await page.exposeBinding("__cmProbe", (_src, s: Sample) => void samples.push(s));
        await page.addInitScript(probe);
        cast = await screencast(page, (f) => frames.push(f), { fps: 30, covered: Boolean(i.covered), ...(i.fields ? { fields: i.fields } : {}) });
      },
      onCover: (c) => {
        covers.push(c.up ? `up:${c.words}` : "down");
        coverTimes.push(Date.now());
      },
    });
    await cast?.stop();
    const r = out.result;
    assert.equal(r.verdict, "pass", JSON.stringify(r.steps.map((s) => [s.verdict, s.reason])));
    assert.equal(info?.noMedia, false, "a signed-in run keeps its media");
    assert.equal(info?.covered, true);
    // 1. Live frames, a video, photos.
    assert.ok(frames.length > 10, `live frames: ${frames.length}`);
    assert.equal(r.video, "run.webm");
    const photos = readdirSync(dir).filter((f) => /^step-\d+\.jpg$/.test(f));
    assert.ok(photos.length >= 1, "step photos");
    assert.ok(r.videoNote?.startsWith(SIGN_IN_SAVED) && r.videoNote.includes(VIDEO_DOTS), String(r.videoNote));
    // 2. No card: every stored value (username, password, then the username and the code) went into a box drawn as dots.
    assert.deepEqual(covers, []);
    // 3. The probe: in every frame drawn with a stored value in a field, that field was dots; password text always dots.
    const codes = site.minted();
    assert.ok(codes.length >= 1, "an email code was sent and typed");
    const secrets = [USER, PASSWORD, ...codes];
    const withSecret = samples.filter((s) => s.vals.some((v) => v && secrets.some((x) => v.includes(x))));
    assert.ok(withSecret.length >= 3, `frames with a stored value in a field were seen: ${withSecret.length}`);
    const uncovered = withSecret.filter((s) => shows(s, secrets));
    assert.deepEqual(uncovered.map((s) => s.url), [], "a frame was drawn with a stored value in a field not drawn as dots");
    assert.ok(samples.filter((s) => s.pw > 0).every((s) => s.pwMasked), "every password field's text was masked in every frame");
    // 4. The live screen's frames: the page stays in view (no card) while the values are typed as dots.
    const pageForPixels = await browser.newPage();
    try {
      const isCard = await cardsIn(pageForPixels, frames.map((f) => f.jpeg));
      assert.ok(isCard.every((x) => !x), "the page is in the live screen the whole time");
      const stateAt = (at: number) => [...samples].reverse().find((s) => s.t <= at);
      const bad = frames.filter((f) => {
        const s = f.at ? stateAt(f.at - 5) : undefined;
        return s && shows(s, secrets);
      });
      assert.equal(bad.length, 0, `${bad.length} live frames drawn with a stored value showing unmasked`);
      assert.ok(frames.some((f) => {
        const s = f.at ? stateAt(f.at - 5) : undefined;
        return s && s.vals.some((v) => v && secrets.some((x) => v.includes(x)));
      }), "live frames were sent while a stored value sat (as dots) in a box");
      // 5. The photos: none was taken with a stored value showing (each is the page after it moved on, or the card).
      const photoCards = await cardsIn(pageForPixels, photos.map((p) => readFileSync(join(dir, p)).toString("base64")));
      assert.equal(photoCards.length, photos.length);
    } finally {
      await pageForPixels.close();
    }
    // 6. The video: it opens on the "Signed in as" card, and no card after it: the typing is shown, as dots.
    const v = await videoCards(join(dir, "run.webm"));
    assert.equal(v.cards[0], true, "the video opens on the signed-in card");
    assert.equal(stretches(v.cards), 1, `card stretches in the video: ${stretches(v.cards)} over ${v.seconds.toFixed(1)} s`);
    // 7. The leak check over the run folder (written as the app writes it) and its export.
    writeRun(join(dir, ".."), dir, r, { tokens: "no AI", totals: undefined });
    const values = { "admin.password": PASSWORD, ...Object.fromEntries(codes.map((c, k) => [`admin.email_code.${k}`, c])) };
    assert.deepEqual(leakHits(values, placesIn(dir)), []);
    const zip = exportRun(dir, tmp("cm-cover-export-"), { name: "cover", secrets: values });
    assert.deepEqual(leakHits(values, [{ where: "export", text: readFileSync(zip).toString("latin1") }]), []);
    // Evidence for the record, when asked (CM_COVER_PROOF=<file>): counts only, never a value.
    if (process.env.CM_COVER_PROOF) {
      writeFileSync(process.env.CM_COVER_PROOF, JSON.stringify({
        runDir: dir, verdict: r.verdict, coverTimesMs: coverTimes.map((x) => x - Date.parse(r.startedAt)), startedAt: r.startedAt, ms: r.ms, video: r.video, videoNote: r.videoNote, photos, liveFrames: frames.length, coverEvents: covers,
        probeSamples: samples.length, samplesWithStoredValue: withSecret.length, uncoveredWithStoredValue: uncovered.length,
        passwordSamples: samples.filter((s) => s.pw > 0).length, passwordSamplesMasked: samples.filter((s) => s.pw > 0 && s.pwMasked).length,
        videoSeconds: v.seconds, videoSamples: v.cards.length, videoCardSamples: v.cards.filter(Boolean).length, videoCardStretches: stretches(v.cards), videoOpensOnCard: v.cards[0],
        leakHitsRunDir: leakHits(values, placesIn(dir)).length, exportZip: zip, codesTyped: codes.length,
        steps: r.steps.map((s) => ({ n: s.n, verdict: s.verdict, screenshot: s.screenshot, at: s.at })),
      }, null, 2));
    }
  });
});

/** What the needle probe saw (only when it changed): the needle shows somewhere (a field, the words, an open shadow root), and the card is up. */
interface Seen {
  t: number;
  shows: boolean;
  inBox: boolean;
  covered: boolean;
  url: string;
}

/**
 * A probe for tests only, given the value it looks for: before each frame is drawn, whether the value
 * shows anywhere in the top frame (spaced or cased differently too; a field drawn as dots shows nothing),
 * and whether the card is up. `inBox`: the value sat in a field (dots or not).
 */
function probeFor(needle: string): void {
  if (window.top !== window) return;
  const n = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "");
  const want = n(needle);
  let last = "";
  const tick = () => {
    const parts: string[] = [];
    let inBox = false;
    const visit = (r: Document | ShadowRoot) => {
      r.querySelectorAll("input, textarea").forEach((e) => {
        if (n((e as HTMLInputElement).value).includes(want)) inBox = true;
        if (getComputedStyle(e).getPropertyValue("-webkit-text-security") !== "disc") parts.push((e as HTMLInputElement).value);
      });
      parts.push(r === document ? (document.body?.innerText ?? "") : ((r as ShadowRoot).textContent ?? ""));
      r.querySelectorAll("*").forEach((e) => {
        if (e.shadowRoot) visit(e.shadowRoot);
      });
    };
    visit(document);
    const shows = parts.some((p) => n(p).includes(want));
    const host = document.querySelector("cm-cover") as HTMLElement | null;
    let open = false;
    try {
      open = Boolean(host?.matches(":popover-open"));
    } catch {
      open = false;
    }
    const covered = Boolean(host?.isConnected && open && getComputedStyle(host!).display !== "none");
    const key = JSON.stringify([shows, inBox, covered, location.href]);
    if (key !== last) {
      last = key;
      void (window as unknown as { __cmSeen: (s: unknown) => Promise<void> }).__cmSeen({ t: Date.now(), shows, inBox, covered, url: location.href });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

describe("the guard: a stored value the page draws again is covered in that frame (review H1, H2, M3, M4, L5, L6)", () => {
  const KEY = "sk-live-GUARD-4f9Q2mZ8";
  /** A page with the cover (guard on 127.0.0.1) and the needle probe, its routes given by path. */
  async function guarded(routes: Record<string, string>): Promise<{ page: Page; cover: Cover; seen: Seen[]; bad: () => Seen[] }> {
    const page = await browser.newPage();
    await page.route("**/*", (r) => {
      const u = new URL(r.request().url());
      const body = routes[u.pathname] ?? routes[`${u.host}${u.pathname}`] ?? "<p>none</p>";
      return r.fulfill({ contentType: "text/html", body });
    });
    const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
    cover.holdFor(() => [KEY]);
    await cover.sync();
    const seen: Seen[] = [];
    await page.exposeBinding("__cmSeen", (_s, x: Seen) => void seen.push(x));
    await page.addInitScript(probeFor, KEY);
    return { page, cover, seen, bad: () => seen.filter((x) => x.shows && !x.covered) };
  }

  it("H1-A: a form sent and drawn again by the server with the value in a plain field: that field is dots from its first frame, so the card can come down", async () => {
    const { page, cover, seen, bad } = await guarded({
      "/form": `<form method=post action=/save><label for=k>API key</label><input id=k name=key><button>Save</button></form>`,
      "/save": `<p>That key was refused</p><form method=post action=/save><label for=k>API key</label><input id=k name=key value="${KEY}"><button>Save</button></form>`,
    });
    try {
      await page.goto("http://127.0.0.1:9/form");
      assert.equal(await cover.show(), true);
      await page.locator("#k").fill(KEY);
      await cover.markTyped();
      await Promise.all([page.waitForURL(/\/save/), page.locator("button").click()]);
      await page.waitForTimeout(300);
      assert.equal(await cover.release(), true, "down: the next page's field holds the value as dots");
      await page.waitForTimeout(300);
      assert.ok(seen.some((x) => x.inBox && x.url.endsWith("/save")), "the probe saw the value in the field on /save");
      assert.deepEqual(bad(), [], "a frame was drawn with the value unmasked and no card");
      assert.equal(await page.locator("#k").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc");
      await page.locator("#k").fill("");
      await page.waitForTimeout(200);
      assert.equal(seen.at(-1)?.covered, false, "no card once the page no longer shows it");
    } finally {
      await page.close();
    }
  });

  it("H1-B: an app that unmounts the field, then draws it again with the value after the card came down, is covered from its first frame", async () => {
    const { page, cover, seen, bad } = await guarded({
      "/spa": `<div id=app><input id=k aria-label=Key><button id=go>Save</button></div><script>
        document.getElementById('go').onclick = () => { const v = document.getElementById('k').value; const app = document.getElementById('app'); app.innerHTML = '<p>Saving…</p>';
          setTimeout(() => { app.innerHTML = '<input id=k2 aria-label=Key>'; document.getElementById('k2').value = v; }, 400); };</script>`,
    });
    try {
      await page.goto("http://127.0.0.1:9/spa");
      await cover.show();
      await page.locator("#k").fill(KEY);
      await cover.markTyped();
      await page.locator("#go").click();
      assert.equal(await cover.release(), true, "the typed field is gone: the run's card comes down");
      await page.waitForTimeout(900);
      assert.ok(seen.some((x) => x.inBox), "the value came back in a new field");
      assert.deepEqual(bad(), []);
    } finally {
      await page.close();
    }
  });

  it("H1-C/D, H2: a page later in the run that shows the value (read-only field, upper-cased and spaced words, an open shadow root, a page back from the cache) is covered", async () => {
    const spaced = KEY.toUpperCase().replace(/(.{4})/g, "$1 ");
    const { page, cover, bad, seen } = await guarded({
      "/start": `<a href=/fill>Fill</a>`,
      "/fill": `<input id=k aria-label=Key><a href=/next>Next</a>`,
      "/next": `<p>Next</p>`,
      "/readonly": `<p>Your key</p><input readonly value="${KEY}">`,
      "/words": `<p>Your key is <b>${spaced}</b></p>`,
      "/shadow": `<x-key></x-key><script>setTimeout(() => { const h = document.querySelector('x-key'); h.attachShadow({mode:'open'}).innerHTML = '<span>${KEY}</span>'; }, 300);</script>`,
    });
    try {
      for (const path of ["/readonly", "/words", "/shadow"]) {
        await page.goto(`http://127.0.0.1:9${path}`);
        await page.waitForTimeout(500);
        assert.ok(seen.some((x) => (x.shows || x.inBox) && x.url.endsWith(path)), `the probe saw the value on ${path}`);
      }
      // Back from the cache with the field still filled: no action types, no check runs; the guard covers.
      await page.goto("http://127.0.0.1:9/fill");
      await page.locator("#k").fill(KEY);
      await page.locator("a").click();
      await page.waitForURL(/\/next/);
      await page.goBack();
      await page.waitForTimeout(400);
      assert.ok(cover.log.every((e) => e.kind !== "show"), "the run's card was never asked for: only the guard covered");
      assert.deepEqual(bad(), [], JSON.stringify(bad()));
    } finally {
      await page.close();
    }
  });

  it("M3: the card removed by the page, or its <html> replaced, is back before the next frame; it is raised over a popover opened later", async () => {
    const { page, cover } = await guarded({ "/p": `<p>Page</p><div id=pop popover=manual style="inset:0;width:100vw;height:100vh;background:#fff">Pop</div>` });
    try {
      await page.goto("http://127.0.0.1:9/p");
      await cover.show();
      assert.equal(await page.evaluate(async () => {
        document.querySelector("cm-cover")!.remove();
        await new Promise<void>((r) => queueMicrotask(r));
        return Boolean(document.querySelector("cm-cover")?.isConnected);
      }), true, "re-attached within the same task's microtasks");
      assert.equal(await page.evaluate(async () => {
        const h = document.createElement("html");
        h.innerHTML = "<body><p>new</p></body>";
        document.replaceChild(h, document.documentElement);
        await new Promise<void>((r) => queueMicrotask(r));
        return document.documentElement.contains(document.querySelector("cm-cover"));
      }), true);
      await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div id=pop2 popover=manual style="inset:0;width:100vw;height:100vh;background:#fff">Pop</div>`));
      await page.evaluate(() => (document.getElementById("pop2") as HTMLElement).showPopover());
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      const shot = (await page.screenshot({ type: "jpeg" })).toString("base64");
      assert.deepEqual(await cardsIn(page, [shot]), [true], "the card is over the popover");
      await cover.hide();
    } finally {
      await page.close();
    }
  });

  it("M4: a value typed into another site's frame keeps the card until that frame is gone (it can't be read)", async () => {
    const { page, cover } = await guarded({
      "127.0.0.1:9/top": `<p>Checkout</p><iframe src="http://localhost:9/inner" width=300 height=100></iframe>`,
      "localhost:9/inner": `<input id=z aria-label=Postcode>`,
    });
    try {
      await page.goto("http://127.0.0.1:9/top");
      await cover.show();
      const inner = page.frameLocator("iframe").locator("#z");
      await inner.fill("PC-998877");
      await cover.markTyped();
      assert.equal(await cover.release(), false, "kept: the field is in another site's frame");
      await inner.fill("");
      assert.equal(await cover.release(), false, "still kept: it can't be read, so it counts as showing");
      await page.evaluate(() => document.querySelector("iframe")!.remove());
      assert.equal(await cover.release(), true);
    } finally {
      await page.close();
    }
  });

  it("L5: the mask beats a page's own !important rule, and reaches a password field in an open shadow root", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<style>#app .t{color:red!important;-webkit-text-fill-color:red!important}</style><div id=app><input class=t id=p type=password value=abcdef></div><x-pw></x-pw><script>document.querySelector('x-pw').attachShadow({mode:'open'}).innerHTML='<input id=q type=password value=abcdef>';</script>` }));
      await Cover.attach(page, { hosts: ["127.0.0.1"] });
      await page.goto("http://127.0.0.1:9/pw");
      await page.waitForTimeout(400);
      assert.equal(await page.locator("#p").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc");
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("x-pw")!.shadowRoot!.getElementById("q")!).getPropertyValue("-webkit-text-security")), "disc");
    } finally {
      await page.close();
    }
  });

  it("L6: a run with no stored value gets no cover script; a covered run's controls are under a random name, and the values never go into the page", async () => {
    const plain = await record(tmp("cm-cover-plain-"), browser, {});
    const covered = await record(tmp("cm-cover-on-"), browser, { cover: true, coverHosts: ["127.0.0.1"] });
    try {
      assert.equal(plain.cover, undefined);
      await plain.page.setContent("<p>x</p>");
      assert.deepEqual(await plain.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__cm"))), []);
      assert.ok(covered.cover);
      await covered.page.setContent("<p>x</p>");
      const keys = await covered.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__cm")));
      assert.equal(keys.length, 1);
      assert.match(keys[0]!, /^__cm[0-9a-f]{12}$/);
    } finally {
      await plain.finish();
      await covered.finish();
    }
    const held = hashHeld([KEY, "123 456"], 0x9e3779b1, 0x85ebca77);
    assert.doesNotMatch(JSON.stringify(held), /GUARD|guard|123456|4f9q/i, "only hashes");
    assert.deepEqual(held.field, [6, 19], "lengths after spaces and dashes are taken out");
    assert.deepEqual(held.text, [6, 19]);
  });
});
