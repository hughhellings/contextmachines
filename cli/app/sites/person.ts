/**
 * The scripted "person" for the practice sites' tests: clicks, keys, text and scrolls at page
 * coordinates, as a person makes them in the visible "Set up sign-in" window (never a selector, never
 * a value our code picked). No run waits for a person any more (A1): there is no mid-run pop-up and no
 * input route; these shapes are kept only so tests can play a person in that window.
 */
import type { Locator, Page } from "playwright";
/** One input as a person makes it (the old hand-over pop-up's shapes, kept for the practice sites' walks). */
export type HandOverInput =
  | { type: "click"; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "scroll"; dy: number }
  | { type: "code"; value: string };

/** One forwarded input, as a person's hand on the live frame. Coordinates are CSS pixels of the page. */
export async function applyInput(page: Page, input: HandOverInput): Promise<void> {
  if (input.type === "click") return page.mouse.click(input.x, input.y);
  if (input.type === "move") return page.mouse.move(input.x, input.y);
  if (input.type === "key") return page.keyboard.press(input.key);
  if (input.type === "text") return page.keyboard.type(input.text);
  if (input.type === "scroll") return page.mouse.wheel(0, input.dy);
  // A code is never passed to a page as input: it goes only to a sign-in code hand-over.
}

/** Limits for a forwarded input: the pop-up's frame is never larger than this, and a person types little. */
export const INPUT_LIMITS = { maxCoord: 10_000, maxText: 500, maxScroll: 5_000 } as const;
/** A key name Playwright presses: one character, or a name with optional modifiers ("Enter", "Shift+Tab"). */
const KEY = /^(?:(?:Shift|Control|Alt|Meta)\+){0,3}(?:[A-Za-z0-9]{1,20}|[^\s])$/;

/**
 * A strict check of one scripted input: the body as one of the five
 * HandOverInput shapes, with only its own fields, or undefined. Coordinates are finite and on a
 * page-sized frame, text is short, keys are key names. It never runs anything.
 */
export function checkInput(body: unknown): HandOverInput | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const num = (v: unknown, max: number, min = 0) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  if ((b.type === "click" || b.type === "move") && num(b.x, INPUT_LIMITS.maxCoord) && num(b.y, INPUT_LIMITS.maxCoord)) return { type: b.type, x: b.x as number, y: b.y as number };
  if (b.type === "key" && typeof b.key === "string" && KEY.test(b.key)) return { type: "key", key: b.key };
  if (b.type === "text" && typeof b.text === "string" && b.text.length > 0 && b.text.length <= INPUT_LIMITS.maxText) return { type: "text", text: b.text };
  if (b.type === "scroll" && num(b.dy, INPUT_LIMITS.maxScroll, -INPUT_LIMITS.maxScroll)) return { type: "scroll", dy: b.dy as number };
  return undefined;
}

/** Where a person would put the pointer on something they see: its middle, in page coordinates. */
export async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const box = await l.boundingBox();
  if (!box) throw new Error("not on screen");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** A click where the person sees `l`. */
export async function clickOn(l: Locator): Promise<HandOverInput> {
  const c = await centre(l);
  return { type: "click", ...c };
}

/** Plays a person's inputs in order, with a short human pause between them. */
export async function play(page: Page, inputs: HandOverInput[], pauseMs = 120): Promise<void> {
  for (const i of inputs) {
    await applyInput(page, i);
    await page.waitForTimeout(pauseMs);
  }
}
