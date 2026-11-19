/**
 * The browser for one test, recording: a video of the whole run, where each step began in it, and a
 * photo at each step's end. Chromium is started the way the learner starts it (scan.ts): sandboxed
 * where it can be, and the command handles its own signals.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** A browser session as Playwright keeps it (cookies, origins). */
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
import { Cover } from "./cover.ts";
import { maskOptions, type SecretFields } from "./maskshot.ts";
import { seeShadowRoots } from "./shadow.ts";
import { CouldNotRun } from "./types.ts";

export const VIDEO_FILE = "run.webm";
export const SIZE = { width: 1280, height: 800 };
/** E9: a phone's width (an iPhone 14's 390 × 844 points): the page lays itself out as on a phone, and the video is that size. */
export const PHONE = { width: 390, height: 844 };

/** W5: the browser's language and time zone, as a person's own browser would have them (Playwright's `locale`, `timezoneId`). */
export interface Place {
  /** A BCP 47 language tag: "de-DE", "ar-EG". The page's Intl, navigator.language and Accept-Language follow it. */
  locale?: string;
  /** An IANA time zone: "Europe/Berlin". The page's Date and Intl follow it. */
  timezone?: string;
}

/** A browser context's options for a place (none when unset: the machine's own). */
export function placeOptions(p: Place = {}): { locale?: string; timezoneId?: string } {
  return { ...(p.locale ? { locale: p.locale } : {}), ...(p.timezone ? { timezoneId: p.timezone } : {}) };
}

/** A browser context's size options: a narrow one (under 600 px) is a phone, with touch and the mobile layout. */
export function sizeOptions(size: { width: number; height: number } = SIZE): { viewport: { width: number; height: number }; isMobile?: true; hasTouch?: true } {
  return { viewport: size, ...(size.width < 600 ? { isMobile: true as const, hasTouch: true as const } : {}) };
}

export interface Recording {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /**
   * The cover (cover.ts) of a run that keeps a video and has stored values: secure fields' text is masked
   * in every frame, and a card stands over the page while a stored value is typed or shows. None in a run
   * that keeps no media, or has no stored value.
   */
  cover?: Cover;
  /** Seconds since the video began. */
  at(): number;
  /** A photo of the page now, saved as `file` in the run's folder; its name, or nothing when it couldn't be taken. */
  shot(file: string): Promise<string | undefined>;
  /** W4: photos are of the tab `shown()` gives (a window the page opened, while it is shown); the video stays the first tab's. */
  follow(shown: () => Page): void;
  /** Saves the browser's session (cookies, local storage) to `path`, readable by its owner only. Never printed. */
  saveState(path: string): Promise<void>;
  /** Ends the recording: the video saved beside the photos, its file name returned when there is one. */
  finish(): Promise<string | undefined>;
}

export async function launch(headed = false): Promise<Browser> {
  const signals = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, headless: !headed };
  try {
    return await chromium.launch({ ...signals, chromiumSandbox: true }).catch(() => chromium.launch({ ...signals, chromiumSandbox: false }));
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new CouldNotRun(/Executable doesn't exist|install/i.test(said) ? "the browser isn't installed (npx playwright install chromium)" : `the browser didn't start: ${said.split("\n")[0]}`);
  }
}

/** A saved session with its IndexedDB larger than this keeps cookies and local storage only (C4). */
export const STATE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Saves a context's session (cookies, local storage, and IndexedDB, where some sign-ins keep their
 * tokens) to `path`: owner-only from the start, as it is as good as a password while it lasts, and
 * written whole or not at all (a temporary file renamed over it), so a reader never sees half of one.
 * A session whose IndexedDB makes it larger than 5 MB is saved without it. Never printed.
 */
export async function saveContextState(context: BrowserContext, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let state = JSON.stringify(await context.storageState({ indexedDB: true }).catch(() => context.storageState()));
  if (Buffer.byteLength(state) > STATE_MAX_BYTES) state = JSON.stringify(await context.storageState());
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, state, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export interface RecordOptions {
  /** A saved browser session (test --setup's) to start signed in with: a file of Playwright's storageState, or the state itself. */
  storageState?: string | StorageState;
  /** No video and no photos: a sign-in run, whose screens are never shown (a card says who it signs in as instead). */
  noMedia?: boolean;
  /** E2: fields a secret was typed into, painted over in every photo with the secure fields (maskshot.ts). */
  fields?: SecretFields;
  /** E9: the page's size (PHONE for a phone); the video is recorded at it. Default SIZE. */
  viewport?: { width: number; height: number };
  /** W5: the browser's language and time zone. */
  place?: Place;
  /**
   * The cover (cover.ts): a run with stored values to keep out of its frames (signed in, an account's
   * values, a --var). Its script goes into every page of the context; a run with none gets nothing added.
   */
  cover?: boolean;
  /** The hosts the cover's guard looks for stored values on (the run's site, hosts it was allowed). */
  coverHosts?: readonly string[];
}

/** A fresh context of `b`, recording into `dir`. Whoever started the browser closes it. */
export async function record(dir: string, b: Browser, o: RecordOptions = {}): Promise<Recording> {
  mkdirSync(dir, { recursive: true });
  const videoDir = join(dir, ".video");
  rmSync(videoDir, { recursive: true, force: true });
  const context = await b.newContext({
    ...sizeOptions(o.viewport),
    ...placeOptions(o.place),
    ...(o.noMedia ? {} : { recordVideo: { dir: videoDir, size: o.viewport ?? SIZE } }),
    ...(o.storageState ? { storageState: o.storageState } : {}),
    // W4: a file the site gives is downloaded (to the browser's own temp folder, gone when the run ends)
    // and read for its words (widgets.ts Downloads); only the site's own addresses get past the guard.
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  // Nothing asks for the camera, a location or notifications here: refused without a prompt.
  await context.clearPermissions();
  // W5: a closed shadow root is read like an open one (shadow.ts).
  await seeShadowRoots(context);
  const page = await context.newPage();
  const cover = o.noMedia || !o.cover ? undefined : await Cover.attach(page, { ...(o.fields ? { fields: o.fields } : {}), hosts: o.coverHosts ?? [] });
  const begun = Date.now();
  let shown = () => page;
  return {
    browser: b,
    context,
    page,
    ...(cover ? { cover } : {}),
    at: () => Math.max(0, (Date.now() - begun) / 1000),
    async shot(file) {
      if (o.noMedia) return undefined;
      try {
        const now = shown();
        await now.screenshot({ path: join(dir, file), type: "jpeg", quality: 70, timeout: 10_000, ...maskOptions(now, o.fields) });
        return file;
      } catch {
        return undefined;
      }
    },
    follow(get) {
      shown = () => {
        const p = get();
        return p.isClosed() ? page : p;
      };
    },
    async saveState(path) {
      await saveContextState(context, path);
    },
    async finish() {
      const video = page.video();
      await context.close().catch(() => {});
      let saved: string | undefined;
      if (video) {
        try {
          const path = await video.path();
          renameSync(path, join(dir, VIDEO_FILE));
          saved = VIDEO_FILE;
        } catch {
          saved = undefined;
        }
      }
      rmSync(videoDir, { recursive: true, force: true });
      return saved;
    },
  };
}
