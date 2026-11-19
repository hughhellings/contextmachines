/**
 * The leak check (AUTH 5.3): every secret a run knew, looked for in every form it could take, in every
 * place the run wrote or said something. Written apart from the masker on purpose (placeholders.ts),
 * so a gap in one isn't hidden by the same gap in the other. Used by the offline tests and the bench.
 *
 *   leakHits({ password: "pw-LEAK-…" }, [{ where: "stdout", text }, ...placesIn(runDir)])
 *     → [{ value: "password", form: "url-encoded", where: "runs/…/result.json" }]
 *
 * A hit names the value by its name and the form, never the value itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Place {
  where: string;
  text: string;
}

export interface LeakHit {
  /** The value's name ("admin.password"), never the value. */
  value: string;
  form: string;
  where: string;
}

const html = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const html2 = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#x27;");

/** Base64 of the value wherever it starts in a longer string (three alignments), its sure middle only. */
function base64Forms(v: string): string[] {
  const out: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const enc = Buffer.from(`${"\0".repeat(pad)}${v}`, "utf8").toString("base64");
    // Drop the characters that mix in the bytes before and after: what is left can only come from the value.
    const from = pad === 0 ? 0 : Math.ceil((pad * 4) / 3) + 1;
    const end = enc.replace(/=+$/, "").length - 2;
    const core = enc.slice(from, end);
    if (core.length >= 6) out.push(core);
  }
  return out;
}

/**
 * Every form a value may take, by name: raw, URL-encoded (and with + for a space), JSON- and
 * HTML-escaped, base64, whitespace run together or taken out, its first 8 characters (a value of 16
 * or more), or the first half of a shorter one. Other case is caught by looking case-blind.
 */
export function leakForms(value: string): { form: string; text: string; exactCase?: true }[] {
  const forms: { form: string; text: string; exactCase?: true }[] = [];
  const add = (form: string, text: string, exactCase?: true) => {
    if (text.length >= 3 && !forms.some((f) => f.text === text)) forms.push({ form, text, ...(exactCase ? { exactCase } : {}) });
  };
  add("raw", value);
  add("url-encoded", encodeURIComponent(value));
  add("url-encoded, + for space", encodeURIComponent(value).replace(/%20/g, "+"));
  add("form-encoded", new URLSearchParams({ v: value }).toString().slice(2));
  add("JSON-escaped", JSON.stringify(value).slice(1, -1));
  add("HTML-escaped", html(value));
  add("HTML-escaped", html2(value));
  for (const b of base64Forms(value)) add("base64", b, true);
  add("whitespace collapsed", value.replace(/\s+/g, " "));
  add("whitespace removed", value.replace(/\s+/g, ""));
  const prefix = value.length >= 16 ? value.slice(0, 8) : value.slice(0, Math.ceil(value.length / 2));
  if (prefix.length >= 4) add(value.length >= 16 ? "first 8 characters" : "first half", prefix);
  return forms;
}

/** Each value, in each form, found in each place: none is the bar. */
export function leakHits(values: Record<string, string>, places: readonly Place[]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value || value.length < 3) continue;
    const forms = leakForms(value);
    for (const place of places) {
      const lower = place.text.toLowerCase();
      for (const f of forms) {
        if (f.exactCase ? place.text.includes(f.text) : lower.includes(f.text.toLowerCase())) {
          hits.push({ value: name, form: f.form, where: place.where });
          break;
        }
      }
    }
  }
  return hits;
}

/**
 * Every file under a folder, as places to look in (binary files too, read as latin1, so a value in a
 * picture's metadata or a trace still shows). `skip`: paths (relative) left out, such as .auth/,
 * whose session and secret files hold values by design and are checked by their modes instead.
 */
export function placesIn(dir: string, skip: (rel: string) => boolean = () => false, maxBytes = 50 * 1024 * 1024): Place[] {
  const out: Place[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(d, e);
      const rel = relative(dir, path);
      if (skip(rel)) continue;
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && st.size <= maxBytes) out.push({ where: rel, text: readFileSync(path).toString(/\.(webm|jpe?g|png|zip)$/i.test(e) ? "latin1" : "utf8") });
    }
  };
  walk(dir);
  return out;
}

/** The .auth/ folder's own files: left out of the leak check, as they hold sessions and secrets by design. */
export const authFiles = (rel: string) => rel === ".auth" || rel.startsWith(".auth/") || /(^|\/)\.auth(\/|$)/.test(rel);
