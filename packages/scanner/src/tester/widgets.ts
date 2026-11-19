/**
 * W4: the widget actions a person does that a click and a fill can't: a file picked (upload), a thing
 * dragged, a slider set to a number, a window the page opened, a list that draws more as it scrolls,
 * a browser "OK / Cancel" box, and a file downloaded and read. act.ts does each action through the
 * same site guard and deny list as a click; this module holds what they need that isn't a click:
 * the built-in sample files, the in-page helpers, the downloads a run saw, the tabs it keeps, and the
 * rule for answering a browser confirm box. Nothing here passes a step.
 */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { BrowserContext, Dialog, Download, Page } from "playwright";

// ---------------------------------------------------------------------------------------------
// Sample files: made here, plainly test data, never anything of the person's.

export const SAMPLE_KINDS = ["csv", "json", "png", "pdf", "txt"] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

/** The words every sample file carries: a check can find them, and no one mistakes the file for real data. */
export const SAMPLE_WORDS = "Context Machines test file";

function png(): Buffer {
  // An 8 x 8 grey square: a real PNG any image field takes.
  const w = 8;
  const h = 8;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x99);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function pdf(): Buffer {
  // A one-page PDF with its words in a plain (uncompressed) stream, offsets computed.
  const text = `BT /F1 18 Tf 40 760 Td (${SAMPLE_WORDS}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const SAMPLE_BODY: Record<SampleKind, () => Buffer> = {
  csv: () => Buffer.from(`name,quantity,note\nTest item one,1,${SAMPLE_WORDS}\nTest item two,2,${SAMPLE_WORDS}\n`),
  json: () => Buffer.from(`${JSON.stringify({ note: SAMPLE_WORDS, items: [{ name: "Test item one", quantity: 1 }, { name: "Test item two", quantity: 2 }] }, null, 2)}\n`),
  txt: () => Buffer.from(`${SAMPLE_WORDS}.\nTest item one\n`),
  png,
  pdf,
};

/** The sample file of a kind, made once in the machine's temp folder: its path. */
export function sampleFile(kind: SampleKind, dir = join(tmpdir(), "cm-samples")): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `cm-sample.${kind}`);
  const body = SAMPLE_BODY[kind]();
  if (!existsSync(path) || !readFileSync(path).equals(body)) writeFileSync(path, body);
  return path;
}

/** The sample kind a file field's `accept` asks for ("image/*", ".csv,text/csv"), or txt when it says nothing we have. */
export function kindFor(accept: string): SampleKind {
  const a = accept.toLowerCase();
  if (!a.trim()) return "txt";
  const order: [SampleKind, RegExp][] = [
    ["csv", /\.csv\b|text\/csv|spreadsheet|excel/],
    ["json", /\.json\b|application\/json/],
    ["png", /\.png\b|image\/png|image\/\*|\.jpe?g|image\//],
    ["pdf", /\.pdf\b|application\/pdf/],
    ["txt", /\.txt\b|text\/plain|text\/\*/],
  ];
  return order.find(([, re]) => re.test(a))?.[0] ?? "txt";
}

/** Whether a file of this name fits a field's `accept` (an empty accept takes anything). */
export function accepts(accept: string, name: string): boolean {
  const parts = accept.toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return true;
  const ext = extname(name).toLowerCase();
  const mime: Record<string, string> = { ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".txt": "text/plain" };
  const m = mime[ext] ?? "";
  return parts.some((p) => p === ext || p === m || (p.endsWith("/*") && m.startsWith(p.slice(0, -1))));
}

/** Places a file is never taken from, whatever the words say: keys, secrets, the system's own. */
const SECRET_PATH = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.config|\.netrc|\.npmrc|\.pypirc|\.git-credentials|keychains?|\.password-store|\.auth|secrets?|credentials?)([\\/]|$)|(^|[\\/])\.env(\.|$)|\.(pem|p12|pfx|kdbx|keychain(-db)?|ovpn)$|id_(rsa|dsa|ecdsa|ed25519)|^\/(private\/)?(etc|proc|sys|dev)\/|^[a-z]:[\\/]windows[\\/]/i;
/** A file that reads as a key, whatever its name (a ".key" file may be a Keynote deck, or a PEM key). */
const PEM_KEY = /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|KEY BLOCK)-----/;

/** The most a file of the person's may weigh to be uploaded. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The file an upload sends: a built-in sample by its kind (csv, json, png, pdf, txt; "auto" picks by
 * the field's `accept`), or a file the person's own words name, written out whole as an absolute path
 * (never one the AI made up or read on the page), which exists, is a plain file of at most 20 MB, and
 * isn't somewhere keys and secrets live. Its path, or why not.
 */
export function uploadFile(value: string, o: { fromPerson?: string; accept?: string; samples?: string }): { path: string; sample?: SampleKind } | { refused: string } {
  const v = value.trim().replace(/^["'“‘]|["'”’]$/g, "");
  const kind = v.toLowerCase().replace(/^\./, "");
  if (kind === "auto" || !v) {
    const k = kindFor(o.accept ?? "");
    return { path: sampleFile(k, o.samples), sample: k };
  }
  if ((SAMPLE_KINDS as readonly string[]).includes(kind)) return { path: sampleFile(kind as SampleKind, o.samples), sample: kind as SampleKind };
  if (kind === "jpg" || kind === "jpeg" || kind === "image") return { path: sampleFile("png", o.samples), sample: "png" };
  if (!isAbsolute(v)) return { refused: `"${v.slice(0, 60)}" isn't a sample kind (csv, json, png, pdf, txt) or a whole file path the goal gives` };
  if (o.fromPerson === undefined || !o.fromPerson.includes(v)) return { refused: "a file of yours is uploaded only when the goal or steps name its whole path: use a sample kind (csv, json, png, pdf, txt) instead" };
  if (SECRET_PATH.test(v)) return { refused: "that file is somewhere keys and secrets are kept: it is never uploaded" };
  let real = v;
  try {
    real = realpathSync(v);
  } catch {
    return { refused: `there's no file at ${basename(v)}` };
  }
  if (SECRET_PATH.test(real)) return { refused: "that file is somewhere keys and secrets are kept: it is never uploaded" };
  const st = lstatSync(real);
  if (!st.isFile()) return { refused: `${basename(v)} isn't a file` };
  if (st.size > UPLOAD_MAX_BYTES) return { refused: `${basename(v)} is over 20 MB` };
  try {
    const head = Buffer.alloc(8192);
    const fd = openSync(real, "r");
    const n = readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (PEM_KEY.test(head.subarray(0, n).toString("latin1"))) return { refused: "that file reads as a key: it is never uploaded" };
  } catch {
    return { refused: `${basename(v)} can't be read` };
  }
  return { path: real };
}

/** Runs in the page: the file input this element is, labels, holds or sits beside (alone in its box), or null. Self-contained. */
export function fileInputOf(e: Element): HTMLInputElement | null {
  const isFile = (x: Element | null | undefined): x is HTMLInputElement => Boolean(x) && x!.tagName === "INPUT" && (x as HTMLInputElement).type === "file";
  if (isFile(e)) return e;
  if (e.tagName === "LABEL" && isFile((e as HTMLLabelElement).control)) return (e as HTMLLabelElement).control as HTMLInputElement;
  const own = e.querySelectorAll("input[type=file]");
  if (own.length === 1) return own[0] as HTMLInputElement;
  // A styled "Browse" button or drop zone with its hidden input next to it: the nearest box, up to 3
  // levels up, that holds exactly one file input.
  let box: Element | null = e.parentElement;
  for (let i = 0; i < 3 && box && box !== e.ownerDocument.body; i++, box = box.parentElement) {
    const found = box.querySelectorAll("input[type=file]");
    if (found.length === 1) return found[0] as HTMLInputElement;
    if (found.length > 1) return null;
  }
  return null;
}

/** Runs in the page: drops a file onto the element as a person dragging it from their desktop would. Self-contained. */
export function dropFile(e: Element, f: { name: string; type: string; b64: string }): boolean {
  const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
  const file = new File([bytes], f.name, { type: f.type });
  const dt = new DataTransfer();
  dt.items.add(file);
  const r = e.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt };
  e.dispatchEvent(new DragEvent("dragenter", at));
  e.dispatchEvent(new DragEvent("dragover", at));
  e.dispatchEvent(new DragEvent("drop", at));
  return true;
}

export const MIME: Record<string, string> = { ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".txt": "text/plain" };

// ---------------------------------------------------------------------------------------------
// Sliders.

/** Runs in the page: a slider's numbers (a range input, or role=slider with aria-value*), or null. Self-contained. */
export function sliderOf(e: Element): { native: boolean; now: number; min: number; max: number; step: number; vertical: boolean } | null {
  const num = (x: string | null | undefined, d: number) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? d : Number(x));
  if (e.tagName === "INPUT" && (e as HTMLInputElement).type === "range") {
    const i = e as HTMLInputElement;
    return { native: true, now: num(i.value, 50), min: num(i.min, 0), max: num(i.max, 100), step: i.step === "any" ? 0 : num(i.step, 1), vertical: false };
  }
  const s = e.getAttribute("role") === "slider" ? e : e.querySelector("[role=slider], input[type=range]");
  if (!s) return null;
  if (s !== e) return sliderOf(s);
  return { native: false, now: num(s.getAttribute("aria-valuenow"), NaN), min: num(s.getAttribute("aria-valuemin"), 0), max: num(s.getAttribute("aria-valuemax"), 100), step: 0, vertical: s.getAttribute("aria-orientation") === "vertical" };
}

/** Runs in the page: sets a range input's value as a person's drag would leave it (input and change, React's tracker too). Self-contained. */
export function setRange(e: Element, v: number): void {
  const i = e as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (set) set.call(i, String(v));
  else i.value = String(v);
  i.dispatchEvent(new Event("input", { bubbles: true }));
  i.dispatchEvent(new Event("change", { bubbles: true }));
}

/** The number a slide asks for: "40", "40%", "1,200". */
export function slideValue(value: string): number | undefined {
  const m = /^\s*(-?\d[\d,]*(?:\.\d+)?)\s*%?\s*$/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** "120,-40" → { x: 120, y: -40 }: a drag by pixels, each at most 2000. */
export function dragBy(value: string): { x: number; y: number } | undefined {
  const m = /^\s*(-?\d{1,4})\s*[, ]\s*(-?\d{1,4})\s*$/.exec(value);
  if (!m) return undefined;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Math.abs(x) <= 2000 && Math.abs(y) <= 2000 && (x || y) ? { x, y } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Scrolling until words show.

/** Runs in the page: the box that scrolls most of the page's middle (an app whose body doesn't scroll), or null. Self-contained. */
export function mainScroller(): { x: number; y: number } | null {
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollHeight > innerHeight + 4) return null;
  let best: Element | null = null;
  let area = 0;
  for (const el of document.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 4) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > area) {
      area = r.width * r.height;
      best = el;
    }
  }
  if (!best) return null;
  const r = best.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 200) };
}

/** Runs in the page: where scrolling stands (the page's, and every box's), to tell when nothing more comes. Self-contained. */
export function scrollMark(): string {
  const doc = document.scrollingElement ?? document.documentElement;
  let boxes = 0;
  for (const el of document.querySelectorAll("*")) if (el.scrollTop) boxes += el.scrollTop + el.scrollHeight;
  return `${doc.scrollTop}:${doc.scrollHeight}:${boxes}:${document.body?.innerText.length ?? 0}`;
}

/** How far scroll_to goes looking: rounds, and time. */
export const SCROLL_UNTIL = { rounds: 30, ms: 25_000, stillRounds: 3 } as const;

// ---------------------------------------------------------------------------------------------
// Downloads: every file the run's pages downloaded, read for its words. Kept in memory only.

export interface Downloaded {
  name: string;
  bytes: number;
  /** Its words, read as text (a PDF's from its streams), at most 200 KB; empty when it has none we can read. */
  text: string;
  /** What it is, as said to the actor: "a CSV file", "a PDF". */
  what: string;
  sha: string;
  at: number;
  /** Made by the page itself (a blob: or data: address), not sent by the server: the page's own words. */
  fromPage?: boolean;
}

const TEXT_MAX = 200 * 1024;
const READ_MAX = 10 * 1024 * 1024;

/** A PDF's words: the strings its text operators draw, in plain or Flate streams. */
export function pdfText(buf: Buffer): string {
  const out: string[] = [];
  const s = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && out.join(" ").length < TEXT_MAX) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    let body = raw.toString("latin1");
    try {
      body = inflateSync(raw).toString("latin1");
    } catch {
      // not compressed, or not Flate: read as it is
    }
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
      const piece = t[1] ?? (t[2] ?? "").replace(/\((?:(?:\\.|[^\\)])*)\)|-?\d+(?:\.\d+)?/g, (x) => (x.startsWith("(") ? x.slice(1, -1) : Number(x) < -200 ? " " : ""));
      out.push(piece.replace(/\\([()\\])/g, "$1").replace(/\\n/g, "\n"));
    }
    re.lastIndex = end;
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** A downloaded file's words and kind, from its bytes. */
export function readDownload(name: string, buf: Buffer): Pick<Downloaded, "text" | "what"> {
  const ext = extname(name).toLowerCase();
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return { text: pdfText(buf).slice(0, TEXT_MAX), what: "a PDF" };
  if (buf.subarray(0, 4).toString("latin1") === "PK\u0003\u0004") return { text: "", what: `a ${ext.slice(1).toUpperCase() || "zip"} file (packed: its words can't be read here)` };
  const head = buf.subarray(0, 4096);
  if (head.includes(0)) return { text: "", what: `a ${ext.slice(1).toUpperCase() || "binary"} file (not text)` };
  const text = buf.subarray(0, TEXT_MAX).toString("utf8").replace(/^﻿/, "");
  const what = ext === ".csv" ? "a CSV file" : ext === ".json" ? "a JSON file" : ext === ".txt" ? "a text file" : ext ? `a ${ext.slice(1).toUpperCase()} file` : "a text file";
  return { text, what };
}

const RUNS = new WeakMap<BrowserContext, Downloads>();

/** The downloads of a browser context's pages: watched from creation, read as they finish. */
export class Downloads {
  readonly list: Downloaded[] = [];
  private pending = new Set<Promise<void>>();
  private waiters: ((d: Downloaded) => void)[] = [];

  constructor(context: BrowserContext) {
    RUNS.set(context, this);
    const watch = (p: Page) => p.on("download", (d) => this.take(d));
    for (const p of context.pages()) watch(p);
    context.on("page", watch);
  }

  /** Whether a file is wanted now (a download_contains step to come): set by the run. Without it, only a `download` action's. */
  want?: () => boolean;
  /** Files the page offered that nothing asked for: cancelled, never kept. */
  refused = 0;

  private take(d: Download): void {
    // A file is taken only while something waits for one (a download action, or a step that checks a
    // file): any other the page offers (a link clicked on the way) is cancelled, never pulled down whole.
    if (!this.waiters.length && !this.want?.()) {
      this.refused++;
      void d.cancel().catch(() => {});
      return;
    }
    const job = (async () => {
      let url = "";
      try {
        url = d.url();
      } catch {
        url = "";
      }
      const path = await d.path().catch(() => null);
      if (!path) return;
      let buf: Buffer;
      try {
        // At most READ_MAX bytes are read: a big file isn't held in memory whole.
        buf = await new Promise<Buffer>((resolve, reject) => {
          const parts: Buffer[] = [];
          let n = 0;
          const s = createReadStream(path, { end: READ_MAX - 1 });
          s.on("data", (c) => {
            const b = typeof c === "string" ? Buffer.from(c) : c;
            parts.push(b);
            n += b.length;
          });
          s.on("end", () => resolve(Buffer.concat(parts, n)));
          s.on("error", reject);
        });
      } catch {
        return;
      }
      const name = basename(d.suggestedFilename() || "download");
      const got: Downloaded = { name, bytes: buf.length, ...readDownload(name, buf), sha: createHash("sha256").update(buf).digest("hex"), at: Date.now(), ...(/^(blob|data):/i.test(url) ? { fromPage: true } : {}) };
      this.list.push(got);
      for (const w of this.waiters.splice(0)) w(got);
    })();
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** The latest file holding the words, or undefined. */
  holding(words: string): Downloaded | undefined {
    const want = plainText(words);
    return want ? [...this.list].reverse().find((d) => plainText(d.text).includes(want)) : undefined;
  }

  /** The next download to finish, or undefined after `ms`. */
  next(ms: number): Promise<Downloaded | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(undefined);
      }, ms);
      const done = (d: Downloaded) => {
        clearTimeout(t);
        resolve(d);
      };
      this.waiters.push(done);
    });
  }

  /** Every download in progress, finished. */
  async settled(ms = 15_000): Promise<void> {
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.pending]), new Promise((r) => (t = setTimeout(r, ms)))]);
    clearTimeout(t);
  }
}

/** The downloads of the context this page is in (none watched: undefined). */
export const downloadsOf = (page: Page): Downloads | undefined => {
  try {
    return RUNS.get(page.context());
  } catch {
    return undefined;
  }
};

const plainText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Whether a downloaded file holds the words: the latest first. What was found instead, said plainly. */
export function downloadHolds(list: readonly Downloaded[], words: string): { ok: boolean; found: string } {
  const want = plainText(words);
  if (!list.length) return { ok: false, found: "no file was downloaded in this run" };
  for (const d of [...list].reverse()) if (want && plainText(d.text).includes(want)) return { ok: true, found: "" };
  const last = list.at(-1)!;
  const start = last.text.replace(/\s+/g, " ").trim().slice(0, 140);
  return { ok: false, found: `${list.length === 1 ? "the file downloaded" : `${list.length} files were downloaded; the last`}, ${last.name} (${last.what}), ${start ? `holds "${start}${last.text.length > 140 ? "…" : ""}"` : "has no words that can be read"}` };
}

/** A download as said to the actor: its name, kind, size and first words. */
export function saidOf(d: Downloaded, mask: (s: string) => string = (s) => s): string {
  const kb = d.bytes < 1024 ? `${d.bytes} bytes` : `${(d.bytes / 1024).toFixed(1)} KB`;
  const start = d.text.replace(/\s+/g, " ").trim().slice(0, 160);
  return mask(`a file downloaded: ${d.name} (${d.what}, ${kb}${d.fromPage ? "; the page made this file itself, the server didn't send it" : ""})${start ? `, starting "${start}${d.text.length > 160 ? "…" : ""}"` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Browser confirm boxes: read, then yes only when it asks for the step's own thing and reads safe.

/** Words of a box that asks to lose, leave or undo something: never said yes to. */
const LOSES = /\b(leav(e|ing)|lose|losing|lost|unsaved|discard|without saving|overwrit(e|ing)|replac(e|ing)|reset|clear|undo|revert|cancel(l?ing)?|sign(ing)? ?out|log(ging)? ?out|permanent(ly)?|cannot be undone|can'?t be undone|irreversibl[ey]|forever|archiv(e|ing)|disabl(e|ing)|merg(e|ing)|close (your|the|this) account)\b/i;
/** A box that only asks whether to go on, with no words of its own ("Are you sure?", "Continue?"). */
const BARE = /^\s*(are you sure( you want to (continue|proceed|do this|go on))?|(do you want to |shall we |ready to )?(continue|proceed|go on)|confirm|ok\??)\s*[?.!]?\s*$/i;
/**
 * What a box may say it does, besides the step's own thing: never said yes to. Its consequence in
 * sentences, which a button's short verbs never meet: a second thing done ("also", "and then"),
 * money, many people told, made public, or something moved to a bin.
 */
const CONSEQUENCE: [RegExp, string][] = [
  [/\balso\b|\bthen\b|\band (also |then )?(notify|e-?mail|send|share|publish|post|charge|bill|move|delete|remove|archive|renew|invite|text|message|tell|alert|announce|make|upgrade|subscribe|close|pay)\b/i, "it asks to do a second thing as well"],
  [/[$€£¥₹]\s?\d|\d\s?(usd|eur|gbp|dollars?|euros?|pounds?|cents?)\b|\b(charg(e|ed|es|ing)|bill(ed|s|ing)?|invoic(e|ed|ing)|renew(s|ed|al|ing)?|upgrad(e|ed|ing)|refund(ed|ing)?|purchas(e|ed|ing)|per month|a month|every month|per year|a year|monthly|yearly|annually)\b/i, "it speaks of money"],
  [/\ball (\d[\d,]*|of (your|the))\b|\b(every ?one|every ?body|any ?one|subscribers|team members|followers|recipients|the whole (team|company|list))\b/i, "it speaks of telling many people"],
  [/\b(notif(y|ies|ied|ying|ications?)|e-?mail(ed|ing)? (it|this|them|him|her|to)|e-?mailed|(send|sends|sending|sent) (an? )?(e-?mail|text|message|notice)|text(ed|ing)? (it|this|them|him|her|to)|public(ly)?|visible|published|on the internet|go(es|ing)? live)\b/i, "it speaks of telling people or making something public"],
  [/\b(bin|trash|recycle|archiv(e|ed|ing))\b|\bmov(e|es|ed|ing)\b[^.?!]*\bto\b/i, "it speaks of moving something away"],
];
/** The step's own kinds of thing a box may ask for: a save, an add, a create, a log, an update, a keep or a go on. */
const OWN_VERBS: [string, RegExp][] = [
  ["save", /\bsav(e|es|ed|ing)\b/i],
  ["add", /\badd(s|ed|ing)?\b/i],
  ["create", /\bcreat(e|es|ed|ing)\b/i],
  ["log", /\blog(s|ged|ging)?\b(?! ?(in|on|out)\b)/i],
  ["update", /\bupdat(e|es|ed|ing)\b/i],
  ["keep", /\bkeep(s|ing)?\b/i],
  ["continue", /\b(continu(e|es|ing)|proceed(s|ing)?|go on)\b/i],
];

export interface DialogAnswer {
  accept: boolean;
  /** Why, in a few words, for the note and the friction line. */
  why: string;
}

/**
 * The answer to a browser box. Only a confirm is ever said yes to, and only a narrow kind: its words
 * pass the same deny list a button does (no paying, sending, deleting, cancelling), it doesn't ask to
 * lose, leave or undo anything, it says no consequence beyond the step's own thing (a second thing,
 * money, many people, public, a bin), and it asks to do the step's own verb (save, add, create, log,
 * update, keep, continue: one the step's own words say, never the goal's), or it is a bare "Are you
 * sure?" right after a press of a control the step names. Everything else is dismissed, as before.
 */
export function answerDialog(type: string, message: string, o: { step: string; goal: string; pressed?: string; denied: (words: string) => string | undefined }): DialogAnswer {
  if (type !== "confirm") return { accept: false, why: type === "beforeunload" ? "it would leave the page" : type === "prompt" ? "nothing is typed into a browser prompt" : "an alert has nothing to choose" };
  const words = message.replace(/\s+/g, " ").trim();
  if (!words) return { accept: false, why: "it says nothing" };
  const denied = o.denied(words);
  if (denied) return { accept: false, why: denied.replace(/^[\s\S]*wasn't pressed: /, "") };
  if (LOSES.test(words)) return { accept: false, why: "it asks to lose, leave or undo something" };
  const consequence = CONSEQUENCE.find(([re]) => re.test(words));
  if (consequence) return { accept: false, why: consequence[1] };
  const stepVerbs = OWN_VERBS.filter(([, re]) => re.test(o.step)).map(([v]) => v);
  const asked = OWN_VERBS.find(([v, re]) => stepVerbs.includes(v) && re.test(words));
  if (asked) return { accept: true, why: `it asks to ${asked[0]}, which the step does` };
  const stem = (w: string) => w.toLowerCase().replace(/(?:ing|ed|es|s|e)$/, "");
  const own = new Set((o.step.toLowerCase().match(/[a-z]{3,}/g) ?? []).map(stem));
  if (BARE.test(words) && o.pressed && (o.pressed.toLowerCase().match(/[a-z]{3,}/g) ?? []).map(stem).some((w) => own.has(w)) && !o.denied(o.pressed)) return { accept: true, why: `it only asks to go on with '${o.pressed.slice(0, 40)}', which the step presses` };
  return { accept: false, why: "it doesn't ask for the step's own thing (a save, an add, a log, an update)" };
}

/** Said for a dialog answered: "The page asked 'Save it?' (a browser confirm box), and it was accepted: …". */
export function dialogNote(d: Pick<Dialog, "type" | "message">, a: DialogAnswer, clip: (s: string, n: number) => string): string {
  const kind = d.type() === "beforeunload" ? "\"leave this page?\"" : d.type();
  // Only a confirm says why (it is the one ever said yes to): the rest read as they always have.
  return `the page showed a browser ${kind} box${d.message() ? ` ('${clip(d.message().replace(/\s+/g, " "), 80)}')` : ""}, which was ${a.accept ? "accepted" : "dismissed"}${d.type() === "confirm" ? `: ${a.why}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Tabs: a window the page opens (window.open) is kept and shown, and switch_tab moves between them.

const MAX_TABS = 5;

/**
 * The run's tabs: its own (the first, the one recorded) and the windows its page opened on the site
 * with a link back to it (window.open: a picker, a preview), which following in the first tab would
 * break. `page` stands for whichever is shown: everything the run reads and does goes to it.
 */
export class Tabs {
  readonly first: Page;
  private list: Page[];
  active: Page;
  readonly page: Page;
  private notes: string[] = [];
  /** Called for each window kept (the run answers its browser boxes as it does the first tab's). */
  onNew?: (p: Page) => void;

  constructor(first: Page) {
    this.first = first;
    this.list = [first];
    this.active = first;
    const self = this;
    // Stands for the shown tab: every property is read from it, and every method called on it.
    this.page = new Proxy(first, {
      get(_t, key) {
        const target = self.active.isClosed() && self.active !== self.first ? self.first : self.active;
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  /** Room for one more window. */
  get roomy(): boolean {
    return this.list.length < MAX_TABS;
  }

  /** A window the page opened, kept and shown now. */
  add(p: Page, title: string): void {
    this.list.push(p);
    this.active = p;
    this.onNew?.(p);
    this.notes.push(`it opened a new window${title ? ` ('${title.slice(0, 60)}')` : ""}, shown now as tab ${this.list.length}: switch_tab ${this.list.indexOf(this.first) + 1} goes back`);
    p.once("close", () => {
      const was = this.active === p;
      this.list = this.list.filter((x) => x !== p);
      if (was) {
        this.active = this.first;
        this.notes.push("the window it opened closed: back on tab 1");
      }
    });
  }

  /** One of the run's tabs (the first, or a window kept). */
  has(p: Page | undefined): boolean {
    return Boolean(p) && this.list.includes(p!);
  }

  /** Tab n (from 1) shown, or why not. */
  switchTo(value: string): string | undefined {
    const n = Number(String(value).trim().replace(/^tab\s*/i, ""));
    const open = this.list.filter((p) => !p.isClosed());
    if (open.length < 2) return "there's only one tab: the page hasn't opened another window";
    if (!Number.isInteger(n) || n < 1 || n > open.length) return `there's no tab ${String(value).slice(0, 10)}: the tabs are 1 to ${open.length}`;
    this.active = open[n - 1]!;
    return undefined;
  }

  /** The tabs, in words: "1 'Orders' /orders; 2 'Pick a customer' /pick (shown)". */
  describe(): string {
    return this.list
      .filter((p) => !p.isClosed())
      .map((p, i) => {
        let path = "";
        try {
          path = new URL(p.url()).pathname;
        } catch {
          path = "";
        }
        return `${i + 1} ${path}${p === this.active ? " (shown)" : ""}`;
      })
      .join("; ");
  }

  /** What changed in the tabs since last asked: said once, after the action that did it. */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }
}
