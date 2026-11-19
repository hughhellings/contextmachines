/**
 * What paymode.ts reads, taken from a live Playwright page: the page's address and every frame's
 * (all depths, any origin), every script source, the key-like tokens in each frame's source, and each
 * frame's visible words. Read-only: it presses nothing and types nothing.
 *
 * What it gathers holds keys (publishable ones, and anything a careless page prints). It goes to
 * payMode only, which keeps no more than a key's prefix; it is never logged or sent to an AI.
 */
import type { Page } from "playwright";
import { keysIn, payMode, type PayModeResult, type PaySurface } from "./paymode.ts";

export async function surfaceOf(page: Page): Promise<PaySurface> {
  const urls: string[] = [];
  const keys = new Set<string>();
  const text: string[] = [];
  let unread = 0;
  for (const frame of page.frames()) {
    urls.push(frame.url());
    try {
      const seen = await frame.evaluate(() => ({
        scripts: [...document.querySelectorAll("script[src]")].map((s) => (s as HTMLScriptElement).src),
        frames: [...document.querySelectorAll("iframe[src]")].map((f) => (f as HTMLIFrameElement).src),
        // Open shadow roots too: outerHTML leaves them out, and a key can sit in one.
        source: [document.documentElement.outerHTML, ...[...document.querySelectorAll("*")].map((e) => e.shadowRoot?.innerHTML ?? "").filter(Boolean)].join("\n"),
        words: document.body ? document.body.innerText : "",
      }));
      urls.push(...seen.scripts, ...seen.frames);
      for (const k of keysIn(seen.source)) keys.add(k);
      // Paddle.js's set-up call is the one marker that is code, not a key: kept whole for paymode.ts's text rule.
      const env = /Paddle\.Environment\.set\(\s*["'][a-z]+["']\s*\)/.exec(seen.source);
      if (env) keys.add(env[0]);
      text.push(seen.words);
    } catch {
      // A frame that went away mid-read: its address is still counted, and it's gone. One still on the
      // page that couldn't be read may hold a live key: counted, so the checkout can't read "test".
      if (!frame.isDetached()) unread++;
    }
  }
  return { urls: [...new Set(urls)], keys: [...keys], text, ...(unread ? { unread } : {}) };
}

/** The checkout's mode, as the browser sees it now. */
export async function payModeOf(page: Page): Promise<PayModeResult> {
  return payMode(await surfaceOf(page));
}
