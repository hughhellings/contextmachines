/**
 * A picture of the screen for the AI, with every field that could hold a secret blacked out, and the
 * blackout checked in the very bytes that would be sent. Used only when the outline can't show what a
 * step needs (a chart, a canvas, a page with nothing listed): see `pictureReason` and run.ts.
 *
 * How: the site's page is photographed as it is (in memory, never written); the photo is drawn, the
 * boxes blacked out and the JPEG made in a blank page of our own (a new browser context, about:blank,
 * every request refused), never the site's; then that JPEG is decoded again there and each blacked
 * box must be at least 98% black. Any doubt (a box that can't be read, a page that changed while it
 * was photographed, a frame whose fields can't be listed while the run holds a secret, a secret shown
 * as text) gives no picture, with the reason.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { maskOptions, type SecretFields } from "./maskshot.ts";

/** A box on the screen, in CSS pixels of the viewport. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a field is, as the page says it: enough to tell whether it could hold a secret. */
export interface FieldInfo {
  type: string;
  autocomplete: string;
  /** Its name, id, label, aria-label and placeholder, together. */
  said: string;
  /** Its value (a select's chosen option, an editable area's text), cut short. */
  value: string;
  /** Where it shows in the viewport, or nothing when it doesn't. */
  box?: Box;
}

/** How dark a blacked-out pixel is at most, on every channel (JPEG blurs the edges: they are inset). */
export const BLACK_MAX = 40;
/** The share of a blacked box's pixels that must be that dark. */
export const BLACK_SHARE = 0.98;
/** How far in from each edge a box is checked. */
export const INSET = 3;
/** JPEG quality, 0 to 1. */
export const QUALITY = 0.7;

/** A field's words that say it holds a secret. */
const SECRET_WORDS = /pass|secret|token|otp|code|cvv|cvc|card|iban|ssn|pin\b/i;
const SECRET_AUTOCOMPLETE = /^(one-time-code|current-password|new-password|cc-.*)$/i;

/** Whether a field could hold a secret: a password, a code, a card, or a value the masker would hide. */
export function mustMask(f: FieldInfo, mask: (s: string) => string): boolean {
  if (f.type === "password") return true;
  if (f.autocomplete.split(/\s+/).some((a) => SECRET_AUTOCOMPLETE.test(a))) return true;
  if (SECRET_WORDS.test(f.said)) return true;
  return Boolean(f.value) && mask(f.value) !== f.value;
}

/** Runs in the page: every field, in document order, open shadow roots too, with where it shows. Self-contained. */
function fieldsOnPage(): { fields: FieldInfo[]; frames: number; text: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out: FieldInfo[] = [];
  const seen = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (el.shadowRoot) seen(el.shadowRoot);
      const tag = el.tagName;
      const editable = el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable);
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !editable) continue;
      const input = el as HTMLInputElement;
      const type = tag === "INPUT" ? (input.type || "text").toLowerCase() : tag.toLowerCase();
      if (type === "hidden") continue;
      const labels = "labels" in input && input.labels ? [...input.labels].map((l) => l.textContent ?? "") : [];
      const said = [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), ...labels].filter(Boolean).join(" ");
      const value = tag === "SELECT" ? ((el as HTMLSelectElement).selectedOptions[0]?.text ?? "") : tag === "INPUT" || tag === "TEXTAREA" ? input.value : el.innerText;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const shows = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
      // The box is padded a little: a focus ring or a caret just outside it shows nothing, but is covered too.
      const x = Math.max(0, Math.floor(r.left) - 2);
      const y = Math.max(0, Math.floor(r.top) - 2);
      out.push({ type, autocomplete: (el.getAttribute("autocomplete") ?? "").toLowerCase(), said: said.slice(0, 500), value: (value ?? "").slice(0, 2000), ...(shows ? { box: { x, y, width: Math.min(vw, Math.ceil(r.right) + 2) - x, height: Math.min(vh, Math.ceil(r.bottom) + 2) - y } } : {}) });
    }
  };
  seen(document);
  let frames = 0;
  for (const f of document.querySelectorAll("iframe, frame, object, embed")) {
    const r = f.getBoundingClientRect();
    if (r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh && getComputedStyle(f).visibility !== "hidden") frames++;
  }
  return { fields: out, frames, text: (document.body?.innerText ?? "").slice(0, 200_000) };
}

/** The boxes to black out, from the fields the page has now. */
export function boxesOf(fields: readonly FieldInfo[], mask: (s: string) => string): Box[] {
  return fields.filter((f) => f.box && mustMask(f, mask)).map((f) => f.box!);
}

const sameBoxes = (a: readonly Box[], b: readonly Box[]) => a.length === b.length && a.every((x, i) => Math.abs(x.x - b[i]!.x) <= 2 && Math.abs(x.y - b[i]!.y) <= 2 && Math.abs(x.width - b[i]!.width) <= 2 && Math.abs(x.height - b[i]!.height) <= 2);

/** Runs in the blank page: the photo drawn, the boxes blacked out, a JPEG made, as base64. Self-contained. */
async function blackOut(args: { png: string; boxes: Box[]; quality: number }): Promise<string> {
  const bytes = Uint8Array.from(atob(args.png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  g.fillStyle = "#000000";
  for (const b of args.boxes) g.fillRect(b.x, b.y, b.width, b.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: args.quality });
  const out = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Runs in the blank page: each box's share of dark pixels, inset, in the decoded JPEG; -1 for a box too small to check. Self-contained. */
async function darkShares(args: { jpeg: string; boxes: Box[]; inset: number; max: number }): Promise<{ width: number; height: number; shares: number[] }> {
  const bytes = Uint8Array.from(atob(args.jpeg), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext("2d")!;
  g.drawImage(bitmap, 0, 0);
  const shares = args.boxes.map((b) => {
    const x = Math.max(0, Math.round(b.x + args.inset));
    const y = Math.max(0, Math.round(b.y + args.inset));
    const w = Math.min(bitmap.width, Math.round(b.x + b.width - args.inset)) - x;
    const h = Math.min(bitmap.height, Math.round(b.y + b.height - args.inset)) - y;
    if (w <= 0 || h <= 0) return -1;
    const d = g.getImageData(x, y, w, h).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! <= args.max && d[i + 1]! <= args.max && d[i + 2]! <= args.max) dark++;
    return dark / (w * h);
  });
  return { width: bitmap.width, height: bitmap.height, shares };
}

/**
 * The blank page the pictures are made and checked in: a browser context of our own, no options, on
 * about:blank, every request refused. Made once per run (on first use) and closed with it.
 */
export class ShotDesk {
  private context?: BrowserContext;
  private page?: Promise<Page>;
  private readonly browser: Browser;
  constructor(browser: Browser) {
    this.browser = browser;
  }

  private blank(): Promise<Page> {
    this.page ??= (async () => {
      this.context = await this.browser.newContext();
      await this.context.route("**/*", (route) => route.abort());
      return this.context.newPage();
    })();
    return this.page;
  }

  /** The photo with the boxes blacked out, as a JPEG. */
  async make(png: Buffer, boxes: readonly Box[]): Promise<Buffer> {
    const page = await this.blank();
    return Buffer.from(await page.evaluate(blackOut, { png: png.toString("base64"), boxes: [...boxes], quality: QUALITY }), "base64");
  }

  /** Why these bytes must not be sent, or nothing: every box at least 98% black once decoded. */
  async refuses(jpeg: Buffer, boxes: readonly Box[], size?: { width: number; height: number }): Promise<string | undefined> {
    if (!boxes.length) return undefined;
    const page = await this.blank();
    const r = await page.evaluate(darkShares, { jpeg: jpeg.toString("base64"), boxes: [...boxes], inset: INSET, max: BLACK_MAX }).catch(() => undefined);
    if (!r) return "the picture couldn't be read back to check it";
    if (size && (r.width !== size.width || r.height !== size.height)) return "the picture isn't the size of the screen";
    const bad = r.shares.findIndex((s) => s >= 0 && s < BLACK_SHARE);
    return bad >= 0 ? `a field that could hold a secret isn't blacked out in the picture (${Math.round(r.shares[bad]! * 100)}% black)` : undefined;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = undefined;
    this.page = undefined;
  }
}

export interface ShotOptions {
  /** The run's masker: a field whose value it would change is blacked out, and a page whose text it would change gets no picture. */
  mask: (s: string) => string;
  /** The run holds a secret value (a --var, an account's): a frame whose fields can't be listed then means no picture. */
  anySecret: boolean;
  desk: ShotDesk;
  /** The fields this run typed a secret into (maskshot.ts): painted over in the photo too, with every secure field and card frame. */
  fields?: SecretFields;
  /** Tests only: run between reading the fields and photographing the page (a page that changes then). */
  between?: () => Promise<void>;
}

export type Shot = { jpeg: Buffer; boxes: Box[] } | { none: string };

/** The reason no picture is sent when a secret might show: said in the step's working line. */
export const NO_PICTURE_SECRET = "No picture sent: a secret might show in it";

/**
 * The screen as a JPEG for the AI, secret fields blacked out and checked in the bytes, or why not.
 * Nothing is written to disk.
 */
export async function maskedShot(page: Page, o: ShotOptions): Promise<Shot> {
  const before = await page.evaluate(fieldsOnPage).catch(() => undefined);
  if (!before) return { none: "the page's fields couldn't be read" };
  if (o.mask(before.text) !== before.text) return { none: NO_PICTURE_SECRET };
  if (o.anySecret && before.frames > 0) return { none: `${NO_PICTURE_SECRET} (a frame on the page can't be checked)` };
  const boxes = boxesOf(before.fields, o.mask);
  const vp = page.viewportSize();
  await o.between?.();
  let png: Buffer;
  try {
    // The engine's mask (maskshot.ts) is painted in the browser as it captures, so no photo of a secure
    // field or a card frame is ever made here; the boxes below are then blacked out and checked as well.
    png = await page.screenshot({ type: "png", scale: "css", timeout: 5000, ...maskOptions(page, o.fields) });
  } catch {
    return { none: "the screen couldn't be photographed" };
  }
  // The page as it was when photographed: a field that moved, came or went in between means no picture.
  const after = await page.evaluate(fieldsOnPage).catch(() => undefined);
  if (!after || !sameBoxes(boxes, boxesOf(after.fields, o.mask)) || o.mask(after.text) !== after.text || (o.anySecret && after.frames > 0)) return { none: `${NO_PICTURE_SECRET} (the page changed while it was photographed)` };
  let jpeg: Buffer;
  try {
    jpeg = await o.desk.make(png, boxes);
  } catch {
    return { none: "the picture couldn't be made" };
  } finally {
    png.fill(0);
  }
  const refused = await o.desk.refuses(jpeg, boxes, vp ?? undefined);
  if (refused) return { none: `${NO_PICTURE_SECRET} (${refused})` };
  return { jpeg, boxes };
}

/** At most this many pictures in one test, and one per step. */
export const PICTURES_PER_TEST = 6;
/** W5 (decision J): the most pictures a test may have when, past the 6, the outline is empty or contradicts the step. */
export const PICTURES_FALLBACK_MAX = 12;
/** A drawn thing must cover at least this share of the viewport to be worth a picture. */
export const DRAWN_SHARE = 0.15;

/** Runs in the page: the share of the viewport the largest visible canvas, svg or img covers. Self-contained. */
export function drawnShare(): number {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let best = 0;
  for (const el of document.querySelectorAll("canvas, svg, img")) {
    if (el instanceof SVGElement && el.ownerSVGElement) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
    const h = Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    best = Math.max(best, (w * h) / (vw * vh));
  }
  return best;
}
