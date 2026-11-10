/**
 * What someone is using, coarsely: a touch screen narrower than a tablet is a phone, a wider one a
 * tablet, anything with a mouse or trackpad a computer. Nothing finer (no model, browser or size)
 * is ever sent.
 */
export type Device = "phone" | "tablet" | "computer";
const PHONE_MAX_WIDTH = 768;

export function deviceOf(win: Window & typeof globalThis): Device {
  const coarse = typeof win.matchMedia === "function" && win.matchMedia("(pointer: coarse)").matches;
  if (!coarse) return "computer";
  const width = Math.min(win.screen?.width || Infinity, win.innerWidth || Infinity);
  return width < PHONE_MAX_WIDTH ? "phone" : "tablet";
}
