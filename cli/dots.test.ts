// Boxes as dots (packages/scanner/src/tester/cover.ts): the sign-in is shown, live and in its video, with
// every box a stored value goes into drawn as dots before the first key, so no frame shows a character of
// a stored value. Proved on the local auth fixture (127.0.0.1, bench/auth-site.ts /dots): an autofocus
// email box the page draws again React-style on every key and once more just after, a password box whose
// Show toggle makes it type=text (with no "password" in its name or id), then an authenticator code in a
// plain text box, also drawn again.
// The sign-in replays saved steps (no AI) through ensureSession with the live screen on; then the test
// finds its session gone, signs in again (no AI) and types the email and password once more mid-run.
//
// Measured four ways: in the page before every animation frame (every box that holds any part of a stored
// value is drawn as dots, read back from its computed style); every live screencast frame, the videos at
// 40 ms steps and the step photos by their pixels (each box's crop is nearer dots or an empty box than the
// value's own text, rendered apart as references); and leak.ts over every run folder and an export.
// No AI, no network.
//   node --test cli/dots.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { Cover, hashHeld, VIDEO_DOTS } from "../packages/scanner/src/tester/cover.ts";
import { makeMasker } from "../packages/scanner/src/tester/placeholders.ts";
import { launch } from "../packages/scanner/src/tester/record.ts";
import { newSignInGuard, runTest, SIGN_IN_VIDEO_FILE, typesSecret } from "../packages/scanner/src/tester/run.ts";
import { screencast, type Frame, type Screencast } from "../packages/scanner/src/tester/screencast.ts";
import { parseTotpSecret, totpAt } from "../packages/scanner/src/tester/totp.ts";
import { accountResolver, fileStore, markMine, parseAccounts, secretsPathFor, signInStepsPathFor } from "./accounts.ts";
import { exportRun } from "./app/data/export.ts";
import { startAuthSite, type AuthSite } from "./bench/auth-site.ts";
import { leakHits, placesIn } from "./leak.ts";
import { ensureSession, runSignedIn, type SessionNeed } from "./signin.ts";
import { writeRun } from "./test-command.ts";

const USER = "qa.dots.r7w2@example.test";
const PASSWORD = "pw-LEAK-do" + "ts-4Kq9vZ1m";
const TOTP = "JBSWY3DPEHPK3PXPJBSWY3DP";

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
  site = await startAuthSite({ users: [{ username: USER, password: PASSWORD, totp: TOTP }] });
});
after(async () => {
  await site?.close();
  await browser?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const disc = (page: Page, sel: string) => page.locator(sel).evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security"));

describe("the mask on a page", () => {
  it("arms every text box as dots, seen painted, before the first key; disarmed, the box typed into stays dots and the rest are plain again", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<label for=q>Search</label><input id=q><label for=e>Email</label><input id=e type=email autofocus><div id=n contenteditable>note</div><input id=c type=checkbox>` }));
      const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
      await page.goto("http://127.0.0.1:9/form");
      await page.locator("#q").fill("hello");
      assert.equal(await disc(page, "#q"), "none", "an ordinary box is plain");
      assert.equal(await cover.arm(), true);
      assert.deepEqual(cover.log.map((e) => e.kind), ["arm", "masked"]);
      for (const sel of ["#q", "#e", "#n"]) assert.equal(await disc(page, sel), "disc", `${sel} is dots while armed`);
      await page.locator("#e").fill(USER);
      await cover.markTyped();
      await cover.disarm();
      assert.equal(await disc(page, "#e"), "disc", "the box typed into stays dots");
      assert.equal(await disc(page, "#q"), "none", "a box nothing went into is plain again");
      assert.equal(await disc(page, "#n"), "none");
      // The page takes the marker off: it is back before the next frame.
      await page.evaluate(() => {
        const e = document.getElementById("e")!;
        for (const a of e.getAttributeNames()) if (a.startsWith("data-cm")) e.removeAttribute(a);
      });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      assert.equal(await disc(page, "#e"), "disc");
    } finally {
      await page.close();
    }
  });

  it("fails closed: a box the mask can't reach (an inline !important rule) means no arm, so the run puts the card up instead", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: `<input id=p style="-webkit-text-security:none!important">` }));
      const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
      await page.goto("http://127.0.0.1:9/inline");
      assert.equal(await cover.arm(), false);
      assert.equal(cover.log.at(-1)?.kind, "unmasked");
      assert.equal(await cover.show(), true, "the card is the fallback");
      await cover.disarm();
      await cover.hide();
    } finally {
      await page.close();
    }
  });

  it("a box in another site's frame is armed and read back there too, and stays dots once typed into", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => {
        const u = new URL(r.request().url());
        return r.fulfill({ contentType: "text/html", body: u.host.startsWith("127.0.0.1") ? `<p>Checkout</p><iframe src="http://localhost:9/inner" width=300 height=100></iframe>` : `<input id=z aria-label=Code>` });
      });
      const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
      await page.goto("http://127.0.0.1:9/top");
      await page.frameLocator("iframe").locator("#z").waitFor();
      assert.equal(await cover.arm(), true);
      const inner = page.frameLocator("iframe").locator("#z");
      assert.equal(await inner.evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc");
      await inner.fill("PC-998877");
      await cover.markTyped();
      await cover.disarm();
      assert.equal(await inner.evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc");
    } finally {
      await page.close();
    }
  });
});

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
const coverUp = (page: Page) => page.evaluate(() => Boolean(document.querySelector("cm-cover")?.isConnected));

describe("the mask holds where the review found gaps", () => {
  const serve = async (body: string) => {
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body }));
    const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
    await page.goto("http://127.0.0.1:9/x");
    return { page, cover };
  };

  it("a marker the page takes off in its own frame callback is back before that frame is painted (read in a ResizeObserver, after every frame callback)", async () => {
    const { page, cover } = await serve(`<input id=e aria-label=Email>`);
    try {
      assert.equal(await cover.arm(false), true);
      await page.locator("#e").fill(USER);
      await cover.markTyped();
      await cover.disarm();
      const seen = await page.evaluate(() => new Promise<string>((done) => {
        const e = document.getElementById("e")!;
        requestAnimationFrame(() => {
          for (const a of e.getAttributeNames()) if (a.startsWith("data-cm")) e.removeAttribute(a);
          new ResizeObserver(() => done(getComputedStyle(e).getPropertyValue("-webkit-text-security"))).observe(document.body);
          document.body.style.width = "777px";
        });
      }));
      assert.equal(seen, "disc");
    } finally {
      await page.close();
    }
  });

  it("a box the page draws again (no name to match it) in its own frame callback after the disarm, holding a password, is dots before paint", async () => {
    const { page, cover } = await serve(`<div id=w><input id=p type=text></div>`);
    try {
      cover.holdFor(() => [PASSWORD]);
      assert.equal(await cover.arm(), true);
      await page.locator("#p").fill(PASSWORD);
      await cover.markTyped();
      await cover.disarm();
      const seen = await page.evaluate((pw) => new Promise<string>((done) => {
        requestAnimationFrame(() => {
          const n = document.createElement("input");
          n.value = pw;
          document.getElementById("w")!.replaceChildren(n);
          new ResizeObserver(() => done(getComputedStyle(n).getPropertyValue("-webkit-text-security"))).observe(n);
        });
      }), PASSWORD);
      assert.equal(seen, "disc");
    } finally {
      await page.close();
    }
  });

  it("a component the page puts in while armed (an open shadow root with a box) has the mask before it is painted", async () => {
    const { page, cover } = await serve(`<div id=h></div>`);
    try {
      assert.equal(await cover.arm(), true);
      const seen = await page.evaluate(() => new Promise<string>((done) => {
        requestAnimationFrame(() => {
          const el = document.createElement("div");
          el.attachShadow({ mode: "open" }).innerHTML = "<input aria-label=Code>";
          document.getElementById("h")!.append(el);
          const box = el.shadowRoot!.querySelector("input")!;
          new ResizeObserver(() => done(getComputedStyle(box).getPropertyValue("-webkit-text-security"))).observe(box);
        });
      }));
      assert.equal(seen, "disc");
      await cover.disarm();
    } finally {
      await page.close();
    }
  });

  it("just before the first key, a box drawn since the arm that the mask can't reach is read back plain (the run puts the card up)", async () => {
    const { page, cover } = await serve(`<input id=a aria-label=Email>`);
    try {
      assert.equal(await cover.arm(), true);
      assert.equal(await cover.maskedAt(page.locator("#a")), true);
      await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<input id=b style="-webkit-text-security:none!important">`));
      assert.equal(await cover.maskedAt(page.locator("#b")), false);
      await cover.disarm();
      assert.equal(await cover.maskedAt(page.locator("#a")), false, "never once disarmed");
    } finally {
      await page.close();
    }
  });

  it("a username box the page forces plain after the disarm puts the card up", async () => {
    const { page, cover } = await serve(`<input id=u aria-label=Username>`);
    try {
      assert.equal(await cover.arm(false), true);
      await page.locator("#u").fill("jdoe-user");
      await cover.markTyped();
      await cover.disarm();
      assert.equal(await coverUp(page), false);
      await page.evaluate(() => document.getElementById("u")!.setAttribute("style", "-webkit-text-security:none!important"));
      await frame(page);
      assert.equal(await coverUp(page), true);
    } finally {
      await page.close();
    }
  });

  it("while a password is typed, a change in the page's own words (a suggestion that echoes part of it) puts the card up; a username's doesn't", async () => {
    const { page, cover } = await serve(`<input id=q aria-label=Search><ul id=s></ul><script>
      document.getElementById("q").addEventListener("input", (e) => (document.getElementById("s").textContent = "Search for " + e.target.value));
    </script>`);
    try {
      assert.equal(await cover.arm(false), true);
      await page.locator("#q").fill("jdoe");
      await frame(page);
      assert.equal(await coverUp(page), false, "a username echoed is shown");
      await cover.disarm();
      assert.equal(await cover.arm(true), true);
      await page.locator("#q").fill(PASSWORD.slice(0, 5));
      assert.equal(await coverUp(page), true, "up before the next frame");
      await cover.disarm();
      await frame(page);
      assert.equal(await coverUp(page), false, "down once the typing is over and nothing held shows");
    } finally {
      await page.close();
    }
  });

  it("the browser's own validation bubble never quotes a box holding a stored value", async () => {
    const { page, cover } = await serve(`<form><input id=e type=email required aria-label=Email></form>`);
    try {
      assert.equal(await cover.arm(false), true);
      await page.locator("#e").fill("jdoe");
      await cover.markTyped();
      await cover.disarm();
      const prevented = await page.evaluate(() => {
        const e = document.getElementById("e") as HTMLInputElement;
        let p = false;
        e.addEventListener("invalid", (ev) => (p = ev.defaultPrevented));
        e.reportValidity();
        return p;
      });
      assert.equal(prevented, true);
    } finally {
      await page.close();
    }
  });

  it("a same-origin frame that leaves its first blank page has the mask, the guard and the loop in its new document (Chromium gives it a fresh window; a kept one is handled too)", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: new URL(r.request().url()).pathname === "/inner" ? `<input id=p type=password><input id=u aria-label=Name>` : `<iframe id=f></iframe>` }));
      const cover = await Cover.attach(page, { hosts: ["127.0.0.1"] });
      await page.goto("http://127.0.0.1:9/top");
      await page.evaluate(async () => {
        const f = document.getElementById("f") as HTMLIFrameElement;
        f.src = "/inner";
        await new Promise((r) => (f.onload = r));
      });
      const inner = page.frameLocator("#f");
      assert.equal(await inner.locator("#p").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc", "secure fields are dots there");
      cover.holdFor(() => [PASSWORD]);
      await cover.sync();
      await inner.locator("#u").evaluate((e, pw) => ((e as HTMLInputElement).value = pw), PASSWORD);
      await frame(page);
      await inner.locator("#u").evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await inner.locator("#u").evaluate((e) => getComputedStyle(e).getPropertyValue("-webkit-text-security")), "disc", "a box the page fills with a password is dots (the loop runs there)");
    } finally {
      await page.close();
    }
  });

  it("3-character values are held too; typesSecret tells a password, a code or a --var from a username or email", () => {
    assert.deepEqual(hashHeld(["abc"], 3, 5).field, [3]);
    assert.equal(typesSecret({ type: "fill", value: "{admin.username}" }), false);
    assert.equal(typesSecret({ type: "fill", value: "{admin.email}" }), false);
    assert.equal(typesSecret({ type: "fill", value: "{admin.password}" }), true);
    assert.equal(typesSecret({ type: "fill", value: "{admin.totp}" }), true);
    assert.equal(typesSecret({ type: "fill", value: "{coupon}" }), true);
    assert.equal(typesSecret({ type: "fill", value: "hunter22" }, [["admin.password", "hunter22"]]), true);
    assert.equal(typesSecret({ type: "fill", value: "me@x.test" }, [["admin.email", "me@x.test"]]), false);
  });
});

/** One box as the probe saw it: its value, drawn as dots, shown, and where (CSS px). */
interface Box {
  v: string;
  d: boolean;
  s: boolean;
  r: [number, number, number, number];
}
/** What the probe saw before an animation frame (only when it changed). */
interface Sample {
  t: number;
  url: string;
  boxes: Box[];
  covered: boolean;
  /** A code page's slots (input-otp style): the digits they show as page text, and where each is. */
  echo?: string;
  slots?: [number, number, number, number][];
}

/** The probe, for tests only: before each frame is drawn, every box's value, whether it is dots, and where it is. */
function probe(): void {
  if (window.top !== window) return;
  let last = "";
  const tick = () => {
    const boxes = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea")).map((e) => {
      const st = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return { v: (e as HTMLInputElement).value, d: st.getPropertyValue("-webkit-text-security") === "disc", s: r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none", r: [r.x, r.y, r.width, r.height] };
    });
    const host = document.querySelector("cm-cover") as HTMLElement | null;
    const covered = Boolean(host?.isConnected);
    const slotEls = Array.from(document.querySelectorAll("[data-slot]"));
    const echo = slotEls.map((e) => e.textContent ?? "").join("");
    const slots = slotEls.map((e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    });
    const key = JSON.stringify([boxes, covered, location.href, echo]);
    if (key !== last) {
      last = key;
      void (window as unknown as { __cmDots: (s: unknown) => Promise<void> }).__cmDots({ t: performance.timeOrigin + performance.now(), url: location.href, boxes, covered, ...(slotEls.length ? { echo, slots } : {}) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** A box holds some part of a stored value (any character of one, as typed so far, or one whole). */
const holds = (v: string, secrets: readonly string[]) => Boolean(v) && secrets.some((x) => x.includes(v) || v.includes(x));

/** One page the run opened, as the test watched it: the probe's samples, the live frames, when it began (its video's 0). */
interface Watched {
  samples: Sample[];
  frames: Frame[];
  began: number;
  cast?: Screencast;
}

type Crop = { img: string; rect: [number, number, number, number]; value: string };

/**
 * Runs in a page: each crop of a frame (inset 4 px, away from the border and focus ring) compared with the
 * same box rendered apart: the value as text, as dots, and empty; and with a flat box (the photo mask, the
 * card). "text" when the crop is nearest the value's own text.
 */
async function classify(page: Page, crops: Crop[]): Promise<{ cls: string; dText: number; dDots: number; dEmpty: number }[]> {
  return page.evaluate(async ([list, card]) => {
    const out: { cls: string; dText: number; dDots: number; dEmpty: number }[] = [];
    const imgs = new Map<string, HTMLImageElement | HTMLCanvasElement>();
    const load = async (src: string) => {
      let im = imgs.get(src);
      if (!im) {
        const i = new Image();
        i.src = src;
        await i.decode();
        im = i;
        imgs.set(src, im);
      }
      return im;
    };
    const host = document.body;
    host.style.margin = "0";
    const refs = new Map<string, ImageData>();
    const ref = async (w: number, h: number, value: string, mode: "text" | "dots" | "empty") => {
      const k = `${w}x${h}|${mode}|${value}`;
      const got = refs.get(k);
      if (got) return got;
      const input = document.createElement("input");
      input.value = mode === "empty" ? "" : value;
      input.setAttribute("style", `position:absolute;left:0;top:0;width:${w}px;height:${h}px;box-sizing:border-box;-webkit-text-security:${mode === "dots" ? "disc" : "none"}`);
      host.replaceChildren(input);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const shot = await (window as unknown as { __shot: (w: number, h: number) => Promise<string> }).__shot(w, h);
      const i = new Image();
      i.src = `data:image/png;base64,${shot}`;
      await i.decode();
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(i, 0, 0);
      const d = g.getImageData(4, 4, Math.max(1, w - 8), Math.max(1, h - 8));
      refs.set(k, d);
      return d;
    };
    const gray = (d: Uint8ClampedArray, k: number) => 0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]!;
    const dist = (a: ImageData, b: ImageData) => {
      let s = 0;
      const n = Math.min(a.data.length, b.data.length);
      for (let k = 0; k < n; k += 4) s += Math.abs(gray(a.data, k) - gray(b.data, k));
      return s / (n / 4);
    };
    const flat = (a: ImageData) => {
      let s = 0;
      let m = 0;
      for (let k = 0; k < a.data.length; k += 4) m += gray(a.data, k);
      m /= a.data.length / 4;
      for (let k = 0; k < a.data.length; k += 4) s += Math.abs(gray(a.data, k) - m);
      return { spread: s / (a.data.length / 4), mean: m };
    };
    for (const c of list) {
      const [x, y, w0, h0] = c.rect.map((v) => Math.round(v)) as [number, number, number, number];
      const w = Math.max(10, w0);
      const h = Math.max(10, h0);
      const im = await load(c.img);
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const g = cv.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(im, x, y, w, h, 0, 0, w, h);
      const crop = g.getImageData(4, 4, Math.max(1, w - 8), Math.max(1, h - 8));
      const dText = dist(crop, await ref(w, h, c.value, "text"));
      const dDots = dist(crop, await ref(w, h, c.value, "dots"));
      const dEmpty = dist(crop, await ref(w, h, c.value, "empty"));
      const f = flat(crop);
      const solid = f.spread < 6 && Math.abs(f.mean - (0.299 * card[0] + 0.587 * card[1] + 0.114 * card[2])) < 30;
      const best = Math.min(dText, dDots, dEmpty);
      out.push({ cls: solid ? "flat" : best === dText && dText < dDots ? "text" : best === dDots ? "dots" : "empty", dText, dDots, dEmpty });
    }
    return out;
  }, [crops, [0x3a, 0x3a, 0x3a]] as const);
}

/** The video read every `step` s in a page, each frame as a data URL. */
async function videoFrames(file: string, step = 0.04): Promise<{ t: number; img: string }[]> {
  const page = await browser.newPage();
  try {
    const webm = readFileSync(file).toString("base64");
    return await page.evaluate(async ([b64, every]) => {
      const v = document.createElement("video");
      v.muted = true;
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      v.src = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
      await new Promise((ok, no) => {
        v.onloadeddata = ok;
        v.onerror = no;
      });
      if (!Number.isFinite(v.duration)) {
        v.currentTime = 1e9;
        await new Promise((ok) => (v.ontimeupdate = ok));
      }
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext("2d")!;
      const out: { t: number; img: string }[] = [];
      for (let t = 0; t < v.duration; t += every) {
        v.currentTime = t;
        await new Promise((ok) => (v.onseeked = ok));
        g.drawImage(v, 0, 0);
        out.push({ t, img: c.toDataURL("image/jpeg", 0.95) });
      }
      return out;
    }, [webm, step] as const);
  } finally {
    await page.close();
  }
}

describe("the leak gate: a sign-in shown live and recorded, its boxes as dots (email, a password shown as type=text by its toggle, an authenticator code; boxes drawn again mid-typing)", () => {
  it("no frame (the page's own, the live screen's, the videos' at 40 ms, the photos) shows a character of a stored value; 0 leak hits in the folders and an export", async () => {
    const outDir = tmp("cm-dots-out-");
    const host = new URL(site.url).host;
    markMine(outDir, host);
    const store = fileStore(secretsPathFor(outDir));
    store.set(`${host}/admin/password`, PASSWORD);
    store.set(`${host}/admin/totp`, TOTP);
    const account = parseAccounts({ accounts: { admin: { first: "password", username: USER, password: { keychain: true }, totp: { keychain: true }, signInPage: "/dots", signedIn: { text: "Sign out" } } } }).accounts.get("admin")!;
    const resolver = accountResolver(account, { host, store, env: {}, owned: true });
    const mask = makeMasker();
    const t = (role: string, name: string) => ({ role, name, nth: 0 });
    const signInUrl = new URL("/dots", site.url).href;
    // The account's saved sign-in steps: replayed with no AI.
    writeSaved(signInStepsPathFor(outDir, site.url, "admin"), {
      version: 1, rules: 2, goal: "Sign in as admin", url: signInUrl, savedAt: new Date().toISOString(), as: "admin",
      steps: [{ title: "Sign in", intent: "Sign in with the email, the password and the authenticator code", check: { kind: "signed_in", text: "Sign out" }, actions: [
        { type: "fill", target: t("textbox", "Email"), value: "{admin.username}" },
        { type: "fill", target: t("textbox", "Password"), value: "{admin.password}" },
        { type: "click", target: t("button", "Show password") },
        { type: "click", target: t("button", "Sign in") },
        { type: "fill", target: t("textbox", "Authenticator code"), value: "{admin.totp}" },
        { type: "click", target: t("button", "Verify") },
      ] }],
    } as unknown as SavedTest, mask);
    const watched: Watched[] = [];
    const onPage = async (page: Page, info: { noMedia: boolean; covered?: boolean; fields?: import("../packages/scanner/src/tester/maskshot.ts").SecretFields }) => {
      const w: Watched = { samples: [], frames: [], began: Date.now() };
      watched.push(w);
      assert.equal(info.noMedia, false, "a sign-in keeps its media now");
      assert.equal(info.covered, true);
      await page.exposeBinding("__cmDots", (_s, x: Sample) => void w.samples.push(x));
      await page.addInitScript(probe);
      w.cast = await screencast(page, (f) => w.frames.push(f), { fps: 30, covered: true, ...(info.fields ? { fields: info.fields } : {}) });
    };
    const covers: string[] = [];
    const guard = newSignInGuard();
    const need: SessionNeed = {
      outDir, url: new URL("/app/confirm", site.url).href, account, resolver, mask, guard, runsDir: join(outDir, "runs"), browser,
      onPage, onCover: (c) => covers.push(c.up ? "up" : "down"),
      ...(process.env.CM_DOTS_DEBUG ? { on: (e: unknown) => console.error(JSON.stringify(e).slice(0, 400)) } : {}),
    };
    const t0 = Date.now();
    const first = await ensureSession(need);
    assert.ok(!("blocked" in first), JSON.stringify(first));
    assert.equal(first.how, "replayed", "signed in from saved steps, no AI");
    assert.ok(first.video && existsSync(first.video), "the sign-in has its own video");
    // The session ends server-side: the test finds itself signed out, and signs in again with no AI.
    site.expireAll();
    const testDirs: string[] = [];
    const saved = {
      version: 1, rules: 2, goal: "Confirm it's me", url: new URL("/app/confirm", site.url).href, savedAt: new Date().toISOString(),
      steps: [{ title: "Confirm it's you", intent: "Type the email and password and press Confirm", check: { kind: "text_visible", text: "Password confirmed" }, actions: [
        { type: "fill", target: t("textbox", "Email"), value: "{admin.username}" },
        { type: "fill", target: t("textbox", "Password"), value: "{admin.password}" },
        { type: "click", target: t("button", "Confirm") },
      ] }],
    } as unknown as SavedTest;
    const ran = await runSignedIn(need, (session, _again, signInVideo) => {
      const dir = tmp("cm-dots-test-");
      testDirs.push(dir);
      return runTest({ url: saved.url, goal: saved.goal, dir, browser, saved, secrets: resolver, masker: mask, storageState: session, signedInAs: "admin", signInGuard: guard, checkWaitMs: 3000, minutes: 2, accountHosts: [host], signInPath: "/dots", ...(signInVideo ? { signInVideo } : {}), onPage, onCover: (c) => covers.push(c.up ? "up" : "down") });
    }, first);
    for (const w of watched) await w.cast?.stop();
    assert.equal(ran.relogins, 1, "the session had gone: signed in again (no AI)");
    const r = ran.outcome!.result;
    assert.equal(r.verdict, "pass", JSON.stringify(r.steps.map((s) => [s.verdict, s.reason])));
    const testDir = testDirs.at(-1)!;
    assert.equal(r.signInVideo, SIGN_IN_VIDEO_FILE);
    assert.ok(existsSync(join(testDir, SIGN_IN_VIDEO_FILE)), "the sign-in's video is kept beside the test's");
    assert.ok(r.videoNote?.includes(VIDEO_DOTS), String(r.videoNote));
    assert.deepEqual(covers, [], "no card: the pages stay in view, their boxes as dots");
    assert.equal(site.signIns("/dots"), 2, "two real sign-ins on the fixture (the first, and the one after the session ended)");

    // Every stored value: the username, the password, every authenticator code of the run's time (±1 step).
    const secret = parseTotpSecret(TOTP);
    const codes = [...new Set(Array.from({ length: Math.ceil((Date.now() - t0) / 30_000) + 3 }, (_, k) => totpAt(secret, t0 - 30_000 + k * 30_000)))];
    const secrets = [USER, PASSWORD, ...codes];

    // 1. In the page, before every frame: every box holding any character of a stored value is drawn as dots.
    const all = watched.flatMap((w) => w.samples);
    const inBox = all.filter((s) => s.boxes.some((b) => b.s && holds(b.v, secrets)));
    const bad = inBox.filter((s) => !s.covered && s.boxes.some((b) => b.s && holds(b.v, secrets) && !b.d));
    assert.ok(inBox.length >= 6, `frames with a stored value in a box: ${inBox.length}`);
    assert.deepEqual(bad.map((s) => s.url), [], "a frame was drawn with a stored value in a box not drawn as dots");
    const partial = inBox.filter((s) => s.boxes.some((b) => b.v && !secrets.includes(b.v) && holds(b.v, secrets)));

    // 2. The pixels. Live frames: the probe's state just before each (Chromium's own time).
    const px = await browser.newPage();
    await px.exposeBinding("__shot", async (src, w: number, h: number) => (await src.page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } })).toString("base64"));
    await px.setViewportSize({ width: 1280, height: 800 });
    const count = { live: 0, liveCrops: 0, video: 0, videoCrops: 0, photos: 0, photoCrops: 0 };
    const classes: Record<string, number> = {};
    const leaks: string[] = [];
    const judge = async (where: string, crops: Crop[]) => {
      if (!crops.length) return;
      const got = await classify(px, crops);
      got.forEach((g, k) => {
        classes[g.cls] = (classes[g.cls] ?? 0) + 1;
        if (g.cls === "text") leaks.push(`${where}: a box looked like the value's own text (dText ${g.dText.toFixed(1)}, dDots ${g.dDots.toFixed(1)}) at ${crops[k]!.rect.join(",")}`);
      });
    };
    try {
      // Control: the classifier sees a box's own text as "text", and dots as "dots".
      const ctl = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await ctl.setContent(`<input id=a style="position:absolute;left:20px;top:20px;width:240px;height:24px;box-sizing:border-box"><input id=b style="position:absolute;left:20px;top:80px;width:240px;height:24px;box-sizing:border-box;-webkit-text-security:disc">`);
        await ctl.locator("#a").fill(USER);
        await ctl.locator("#b").fill(USER);
        const img = `data:image/jpeg;base64,${(await ctl.screenshot({ type: "jpeg", quality: 60 })).toString("base64")}`;
        const got = await classify(px, [{ img, rect: [20, 20, 240, 24], value: USER }, { img, rect: [20, 80, 240, 24], value: USER }]);
        assert.deepEqual(got.map((g) => g.cls), ["text", "dots"], "the pixel check can tell text from dots");
      } finally {
        await ctl.close();
      }
      for (const [i, w] of watched.entries()) {
        const at = (ms: number) => [...w.samples].reverse().find((s) => s.t <= ms);
        for (const f of w.frames) {
          const s = f.at ? at(f.at - 5) : undefined;
          const boxes = s ? s.boxes.filter((b) => b.s && holds(b.v, secrets)) : [];
          if (!boxes.length) continue;
          count.live++;
          count.liveCrops += boxes.length;
          if (process.env.CM_DOTS_PROOF && count.live <= 6) writeFileSync(`${process.env.CM_DOTS_PROOF}.live-${count.live}.jpg`, Buffer.from(f.jpeg, "base64"));
          await judge(`live frame of page ${i}`, boxes.map((b) => ({ img: `data:image/jpeg;base64,${f.jpeg}`, rect: b.r, value: b.v })));
        }
      }
      // The videos at 40 ms steps: each sign-in's (in its own folder, and the copy beside the test) and the
      // test's. A frame is set against every state the page was in within 0.4 s of its time.
      const signInDirs = readdirSync(join(outDir, "runs")).filter((d) => d.startsWith("sign-in-")).map((d) => join(outDir, "runs", d)).sort();
      const videos: { file: string; w: Watched }[] = [];
      const signInWatched = watched.filter((w) => w.samples.some((s) => s.url.includes("/dots")));
      for (const [k, d] of signInDirs.entries()) if (existsSync(join(d, "run.webm")) && signInWatched[k]) videos.push({ file: join(d, "run.webm"), w: signInWatched[k]! });
      for (const [k, d] of testDirs.entries()) {
        const w = watched.filter((x) => !signInWatched.includes(x))[k];
        if (w && existsSync(join(d, "run.webm"))) videos.push({ file: join(d, "run.webm"), w });
      }
      assert.ok(videos.length >= 4, `videos read: ${videos.length}`);
      for (const v of videos) {
        for (const f of await videoFrames(v.file)) {
          const wall = v.w.began + f.t * 1000;
          const near = v.w.samples.filter((s) => Math.abs(s.t - wall) <= 400);
          const before = [...v.w.samples].reverse().find((s) => s.t <= wall - 400);
          const boxes = [...near, ...(before ? [before] : [])].flatMap((s) => s.boxes.filter((b) => b.s && holds(b.v, secrets)));
          const seen = new Set<string>();
          const crops = boxes.filter((b) => {
            const k = `${b.r.join(",")}|${b.v}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }).map((b) => ({ img: f.img, rect: b.r, value: b.v }));
          if (!crops.length) continue;
          count.video++;
          count.videoCrops += crops.length;
          await judge(`${v.file.split("/").slice(-2).join("/")} at ${f.t.toFixed(2)} s`, crops);
        }
      }
      // The step photos: every box that ever held a stored value on that run's pages.
      for (const [k, d] of [...signInDirs, ...testDirs].entries()) {
        const boxes = watched.flatMap((w) => w.samples).flatMap((s) => s.boxes.filter((b) => b.s && holds(b.v, secrets)));
        const uniq = [...new Map(boxes.map((b) => [`${b.r.join(",")}|${b.v}`, b])).values()];
        for (const p of readdirSync(d).filter((f) => /^step-\d+\.jpg$/.test(f))) {
          count.photos++;
          count.photoCrops += uniq.length;
          await judge(`photo ${k}/${p}`, uniq.map((b) => ({ img: `data:image/jpeg;base64,${readFileSync(join(d, p)).toString("base64")}`, rect: b.r, value: b.v })));
        }
      }
    } finally {
      await px.close();
    }
    assert.ok(count.live >= 3, `live frames with a stored value in a box: ${count.live}`);
    assert.ok(count.video >= 10, `video frames with a stored value in a box: ${count.video}`);
    assert.ok((classes.dots ?? 0) > 0, "dots were seen in the pixels");
    assert.deepEqual(leaks, [], "a frame showed a box's value as text");

    // 3. leak.ts over every run folder (each written as the app writes it) and an export.
    for (const d of testDirs) writeRun(join(d, ".."), d, r, { tokens: "no AI", totals: undefined });
    const values = { "admin.username": USER, "admin.password": PASSWORD, "admin.totp_secret": TOTP, ...Object.fromEntries(codes.map((c, k) => [`admin.totp.${k}`, c])) };
    const hitsRuns = leakHits(values, [...placesIn(join(outDir, "runs")), ...testDirs.flatMap((d) => placesIn(d))]);
    assert.deepEqual(hitsRuns, []);
    const zip = exportRun(testDir, tmp("cm-dots-export-"), { name: "dots", secrets: values });
    assert.deepEqual(leakHits(values, [{ where: "export", text: readFileSync(zip).toString("latin1") }]), []);

    if (process.env.CM_DOTS_PROOF) {
      writeFileSync(process.env.CM_DOTS_PROOF, JSON.stringify({
        verdict: r.verdict, relogins: ran.relogins, signIns: site.signIns("/dots"), covers, videoNote: r.videoNote, signInVideo: r.signInVideo,
        pagesWatched: watched.length, probeSamples: all.length, samplesWithStoredValueInBox: inBox.length, samplesWithPartialValue: partial.length, samplesUnmasked: bad.length,
        liveFrames: watched.reduce((n, w) => n + w.frames.length, 0), pixelCounts: count, pixelClasses: classes, pixelLeaks: leaks.length,
        leakHitsRunFolders: hitsRuns.length, exportZip: zip, codesChecked: codes.length, runFolders: [...readdirSync(join(outDir, "runs")).map((d) => join(outDir, "runs", d)), ...testDirs],
      }, null, 2));
    }
  });
});

/** Runs in a page: each slot's crop of an image, as grey levels (inset 3 px), with its spread and mean. */
async function slotCrops(page: Page, img: string, rects: [number, number, number, number][]): Promise<{ g: number[]; mean: number; spread: number }[]> {
  return page.evaluate(async ([src, list]) => {
    const i = new Image();
    i.src = src;
    await i.decode();
    return list.map(([x0, y0, w0, h0]) => {
      const [x, y, w, h] = [Math.round(x0) + 3, Math.round(y0) + 3, Math.max(1, Math.round(w0) - 6), Math.max(1, Math.round(h0) - 6)];
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(i, x, y, w, h, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      const out: number[] = [];
      for (let k = 0; k < d.length; k += 4) out.push(0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]!);
      const mean = out.reduce((a, b) => a + b, 0) / out.length;
      const spread = out.reduce((a, b) => a + Math.abs(b - mean), 0) / out.length;
      return { g: out, mean, spread };
    });
  }, [img, rects] as const);
}

describe("a code page whose slots show each digit as page text (input-otp style), the code made at type time", () => {
  it("no frame shows a digit: the code joins the guard before the first key, and any change in the page's words while it is typed puts the card up", async () => {
    const outDir = tmp("cm-dots-slots-");
    const host = new URL(site.url).host;
    markMine(outDir, host);
    const store = fileStore(secretsPathFor(outDir));
    store.set(`${host}/admin/password`, PASSWORD);
    store.set(`${host}/admin/totp`, TOTP);
    const account = parseAccounts({ accounts: { admin: { first: "password", username: USER, password: { keychain: true }, totp: { keychain: true }, signInPage: "/dots" } } }).accounts.get("admin")!;
    const resolver = accountResolver(account, { host, store, env: {}, owned: true });
    const mask = makeMasker();
    const url = new URL("/dots/slots", site.url).href;
    const saved = {
      version: 1, rules: 2, goal: "Enter the code", url, savedAt: new Date().toISOString(),
      steps: [{ title: "Enter the code", intent: "Type the authenticator code and press Verify", check: { kind: "text_visible", text: "Code accepted" }, actions: [
        { type: "fill", target: { role: "textbox", name: "Authenticator code", nth: 0 }, value: "{admin.totp}" },
        { type: "click", target: { role: "button", name: "Verify", nth: 0 } },
      ] }],
    } as unknown as SavedTest;
    const watched: Watched[] = [];
    const onPage = async (page: Page, info: { noMedia: boolean; covered?: boolean; fields?: import("../packages/scanner/src/tester/maskshot.ts").SecretFields }) => {
      const w: Watched = { samples: [], frames: [], began: Date.now() };
      watched.push(w);
      assert.equal(info.covered, true, "a run that types a stored value has the cover");
      await page.exposeBinding("__cmDots", (_s, x: Sample) => void w.samples.push(x));
      await page.addInitScript(probe);
      w.cast = await screencast(page, (f) => w.frames.push(f), { fps: 30, covered: true, ...(info.fields ? { fields: info.fields } : {}) });
    };
    const dir = tmp("cm-dots-slots-run-");
    const t0 = Date.now();
    const out = await runTest({ url, goal: saved.goal, dir, browser, saved, secrets: resolver, masker: mask, checkWaitMs: 3000, minutes: 2, accountHosts: [host], onPage });
    for (const w of watched) await w.cast?.stop();
    const r = out.result;
    assert.equal(r.verdict, "pass", JSON.stringify(r.steps.map((s) => [s.verdict, s.reason])));
    const secret = parseTotpSecret(TOTP);
    const codes = [...new Set(Array.from({ length: Math.ceil((Date.now() - t0) / 30_000) + 3 }, (_, k) => totpAt(secret, t0 - 30_000 + k * 30_000)))];

    // 1. In the page, before every frame: slots that show any digit only with the card up.
    const all = watched.flatMap((w) => w.samples);
    const echoed = all.filter((s) => s.echo);
    assert.ok(echoed.length >= 1, "the slots showed the code (as the page draws it)");
    const partial = echoed.filter((s) => !codes.includes(s.echo!));
    assert.deepEqual(echoed.filter((s) => !s.covered).map((s) => s.echo!.length), [], "a frame was drawn with a digit in a slot and no card");

    // 2. The pixels: each slot of every live frame, video frame (40 ms) and photo on the code page is the
    // card's flat colour, or the same as the empty slot (none shows a digit).
    const px = await browser.newPage();
    const counts = { live: 0, video: 0, photos: 0, card: 0, empty: 0 };
    const leaks: string[] = [];
    try {
      const w = watched[0]!;
      const onSlots = w.samples.filter((s) => s.url.includes("/dots/slots") && s.slots?.length);
      const rects = onSlots[0]!.slots!;
      const near = (ms: number, span: number) => w.samples.filter((s) => Math.abs(s.t - ms) <= span);
      const at = (ms: number) => [...w.samples].reverse().find((s) => s.t <= ms);
      // A slot with no digit is a flat light square (inside its border); the card is a flat dark one.
      const judge = (where: string, got: { g: number[]; mean: number; spread: number }[]) => {
        got.forEach((c, k) => {
          if (c.spread < 6 && Math.abs(c.mean - 41) < 25) counts.card++;
          else if (c.spread < 6 && c.mean > 200) counts.empty++;
          else leaks.push(`${where}: slot ${k} is neither the card nor empty (mean ${c.mean.toFixed(1)}, spread ${c.spread.toFixed(1)})`);
        });
      };
      // Control: the rule tells a slot with a digit from an empty one.
      const ctl = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await ctl.goto(url);
        await ctl.evaluate(() => (document.querySelectorAll("[data-slot]")[0]!.textContent = "7"));
        const shot = `data:image/jpeg;base64,${(await ctl.screenshot({ type: "jpeg", quality: 60 })).toString("base64")}`;
        const got = await slotCrops(px, shot, rects.slice(0, 2));
        const before = leaks.length;
        judge("control", got);
        assert.deepEqual([leaks.length - before, counts.empty], [1, 1], "the slot with a digit is caught, the empty one isn't");
        leaks.length = before;
        counts.empty = 0;
      } finally {
        await ctl.close();
      }
      // Live frames, each against the page's state just before it.
      for (const f of w.frames) {
        const s = f.at ? at(f.at - 5) : undefined;
        if (!s?.url.includes("/dots/slots") || !s.slots?.length) continue;
        counts.live++;
        judge(`live frame at ${f.at}`, await slotCrops(px, `data:image/jpeg;base64,${f.jpeg}`, rects));
      }
      // The video, every 40 ms, where the page was the code page all through ±0.4 s.
      for (const f of await videoFrames(join(dir, "run.webm"))) {
        const wall = w.began + f.t * 1000;
        const before = at(wall - 400);
        const around = [...near(wall, 400), ...(before ? [before] : [])];
        if (!around.length || !around.every((s) => s.url.includes("/dots/slots") && s.slots?.length)) continue;
        counts.video++;
        judge(`video at ${f.t.toFixed(2)} s`, await slotCrops(px, f.img, rects));
      }
      for (const p of readdirSync(dir).filter((f) => /^step-\d+\.jpg$/.test(f))) {
        counts.photos++;
        judge(`photo ${p}`, await slotCrops(px, `data:image/jpeg;base64,${readFileSync(join(dir, p)).toString("base64")}`, rects));
      }
    } finally {
      await px.close();
    }
    assert.ok(counts.live >= 2 && counts.video >= 5, JSON.stringify(counts));
    assert.ok(counts.card > 0, "the card stood in while the slots showed the code");
    assert.deepEqual(leaks, [], "a frame showed a digit in a slot");

    // 3. leak.ts over the run folder, as the app writes it, and an export.
    writeRun(join(dir, ".."), dir, r, { tokens: "no AI", totals: undefined });
    const values = { "admin.password": PASSWORD, "admin.totp_secret": TOTP, ...Object.fromEntries(codes.map((c, k) => [`admin.totp.${k}`, c])) };
    assert.deepEqual(leakHits(values, placesIn(dir)), []);
    const zip = exportRun(dir, tmp("cm-dots-slots-export-"), { name: "slots", secrets: values });
    assert.deepEqual(leakHits(values, [{ where: "export", text: readFileSync(zip).toString("latin1") }]), []);
    if (process.env.CM_DOTS_PROOF) writeFileSync(`${process.env.CM_DOTS_PROOF}.slots.json`, JSON.stringify({ verdict: r.verdict, samples: all.length, echoed: echoed.length, partialEcho: partial.length, uncovered: 0, counts, leaks: leaks.length }, null, 2));
  });
});
