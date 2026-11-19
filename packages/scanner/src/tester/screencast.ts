/**
 * The live screen for the web view: Chromium's own screencast (CDP Page.startScreencast) of the page
 * a test drives, as JPEG frames, a few a second. Where the screencast can't start (another browser, a
 * CDP error), a photo of the page is taken after each action instead. No AI here, and nothing is kept:
 * each frame is handed on and dropped.
 */
import type { CDPSession, Page } from "playwright";
import { maskOptions, SECURE_FIELDS, type SecretFields } from "./maskshot.ts";

export interface Frame {
  /** The JPEG, base64. */
  jpeg: string;
  /** The page's address when the frame was drawn. */
  url: string;
  /** When Chromium drew it (ms since the epoch), where it says; else when it arrived. */
  at?: number;
}

export interface Screencast {
  mode: "screencast" | "shots";
  /** Called after each action: in "shots" mode, a photo is taken and handed on; a screencast needs nothing. */
  after(): Promise<void>;
  stop(): Promise<void>;
}

export interface ScreencastOptions {
  /** Most frames a second handed on (default 8): the rest are acknowledged and dropped. */
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Start in "shots" mode (tests; a browser with no CDP). */
  noCdp?: boolean;
  /** E2: the run's secret-filled fields. Photos paint them (and every secure field) over; raw screencast frames stop while one holds a value. */
  fields?: SecretFields;
  /**
   * The page has the cover (cover.ts): secure fields' text is masked in every frame and a card stands
   * over the page while a stored value is typed or shows, so raw frames go on (no switch to photos).
   */
  covered?: boolean;
}

/** A secure field (password, card, code) or a secret-filled one holds a value now: raw frames would show it. */
async function secretShown(page: Page, fields?: SecretFields): Promise<boolean> {
  if (fields?.size) return true;
  return page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).some((e) => "value" in e && Boolean((e as HTMLInputElement).value)), SECURE_FIELDS.filter((s) => s.startsWith("input")).join(", ")).catch(() => true);
}

/** How often a masked photo is sent once raw frames have stopped. */
export const MASKED_EVERY_MS = 1000;

/** How long the screen may go without a frame before a photo is taken instead. */
const QUIET_MS = 1000;

export async function screencast(page: Page, onFrame: (frame: Frame) => void, o: ScreencastOptions = {}): Promise<Screencast> {
  const gap = 1000 / Math.max(1, Math.min(30, o.fps ?? 8));
  const quality = o.quality ?? 60;
  let stopped = false;
  /** Once a secret shows, the rest of the run is sent as masked photos only. */
  let masked = false;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const url = () => {
    try {
      return page.url();
    } catch {
      return "";
    }
  };
  const shots: Screencast = {
    mode: "shots",
    async after() {
      if (stopped || page.isClosed() || !/^https?:/.test(url())) return;
      try {
        const jpeg = (await page.screenshot({ type: "jpeg", quality, timeout: 5000, ...maskOptions(page, o.fields) })).toString("base64");
        if (!stopped) onFrame({ jpeg, url: url(), at: Date.now() });
      } catch {
        // the page went away: nothing to show
      }
    },
    async stop() {
      stopped = true;
    },
  };
  if (o.noCdp) {
    await shots.after();
    return shots;
  }
  let session: CDPSession;
  /** A frame drawn in another process (a captcha's challenge in its own frame) may send no screencast frame: a photo then, after a quiet spell. */
  let quiet: ReturnType<typeof setInterval> | undefined;
  let last = 0;
  try {
    session = await page.context().newCDPSession(page);
    session.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
      // Every frame is acknowledged, or Chromium sends no more; only a few a second are handed on.
      void session.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      const now = Date.now();
      // A raw frame can't be masked: while a secret shows, masked photos are sent after each action instead.
      // The blank page before the site opens is nothing to show (and has no address to say).
      if (stopped || masked || now - last < gap || !/^https?:/.test(url())) return;
      last = now;
      onFrame({ jpeg: f.data, url: url(), at: f.metadata?.timestamp ? f.metadata.timestamp * 1000 : now });
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: o.maxWidth ?? 1280, maxHeight: o.maxHeight ?? 800, everyNthFrame: 1 });
    quiet = setInterval(() => {
      if (stopped || page.isClosed()) return clearInterval(quiet);
      if (masked || busy || Date.now() - last < QUIET_MS) return;
      busy = true;
      last = Date.now();
      void shots.after().finally(() => (busy = false));
    }, QUIET_MS);
    quiet.unref?.();
  } catch {
    await shots.after();
    return shots;
  }
  return {
    mode: "screencast",
    async after() {
      if (stopped || page.isClosed()) return;
      // With the cover, frames never show a stored value: they stay live.
      masked = masked || (!o.covered && (await secretShown(page, o.fields)));
      if (masked) await shots.after();
      // Masked photos keep coming, one a second, so the screen stays live between actions (a hand-over).
      if (masked && !ticker) ticker = setInterval(() => {
        if (stopped || page.isClosed()) return clearInterval(ticker);
        if (busy) return;
        busy = true;
        void shots.after().finally(() => (busy = false));
      }, MASKED_EVERY_MS);
      ticker?.unref?.();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (ticker) clearInterval(ticker);
      if (quiet) clearInterval(quiet);
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    },
  };
}
