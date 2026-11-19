/**
 * A run's marker (plan section 6, shared by W2 test data and W3 proof): a short code that every value
 * the run makes up can carry ("Test 7Q2K"), so the run can find its own rows again (to prove a save,
 * to clean up) and never mistakes a row an earlier run or another person left for its own.
 *
 * Stable API: makeMarker(seed) and markValue(field, marker). Nothing here touches a page or an AI.
 * A record with no free-text field (numbers, dates and choices only) is marked by a tuple of odd
 * numbers instead (markNumber), with the record's id from the save as the fallback (W2).
 */

/** Letters and digits that can't be misread for each other (no 0/O, 1/I/L). */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface Marker {
  /** The code itself, 4 characters: "7Q2K". */
  code: string;
  /** What a made-up text value is: "Test 7Q2K". */
  word: string;
}

/** A small seeded generator (mulberry32): the same seed gives the same marker. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedOf = (seed: number | string): number => {
  if (typeof seed === "number") return Math.floor(seed) >>> 0;
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};

/**
 * A run's marker. `seed`: a number or a string (a run id) for a marker that can be made again; none
 * for a fresh random one. Always 4 characters, always with at least one letter and one digit, so it
 * can't be read as a word or a plain number.
 *
 * Every run needs a marker of its own: no seed (random), or a seed unique to the run (a run id).
 * Never seed it by the test's name or goal, and a replay must make a new one, never retype a cached
 * marker: the proof (proof.ts) treats only this run's own code as "mine", and a marker an earlier
 * run left on the site must never read as this run's row.
 */
export function makeMarker(seed?: number | string): Marker {
  const next = rng(seed === undefined ? Math.floor(Math.random() * 2 ** 32) : seedOf(seed));
  const pick = (from: string) => from[Math.floor(next() * from.length)]!;
  const digits = "23456789";
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const chars = [pick(digits), pick(letters), pick(ALPHABET), pick(ALPHABET)];
  // Shuffled, so the digit isn't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  const code = chars.join("");
  return { code, word: `Test ${code}` };
}

/** What markValue needs to know about a field (a subset of values.ts FieldFacts). */
export interface MarkField {
  /** The input's type ("text", "number", "email"…); "" or none for text. */
  type?: string;
  /** Its words in lower case (label, name, placeholder): "first name". */
  hint?: string;
  /** Its length limit, 0 or none for no limit. */
  maxLength?: number;
  /** The value that would be typed without a marker ("Test", "Test Client"). */
  value?: string;
}

/** Fields whose value can't carry a marker: numbers, dates, choices, secrets. */
const UNMARKABLE = new Set(["number", "range", "date", "datetime-local", "month", "week", "time", "color", "checkbox", "radio", "file", "password", "hidden", "submit", "button", "image", "reset", "tel"]);

/**
 * The value to type into a field, marked: "Test 7Q2K" for a plain text field, "Test Client 7Q2K" when
 * a value was already chosen, "test+cm-7q2k@example.com" for an email. A field that can't carry text
 * (a number, a date, a choice) gets its value back unmarked: such a record is marked by markNumber.
 * The marker never makes a value longer than the field allows: then the start of the value gives way.
 */
export function markValue(field: MarkField, marker: Marker): string {
  const type = (field.type ?? "").toLowerCase();
  const value = field.value ?? "";
  if (UNMARKABLE.has(type)) return value;
  if (type === "email" || /e-?mail/.test(field.hint ?? "")) {
    const at = value.indexOf("@");
    const local = at > 0 ? value.slice(0, at) : "test+cm";
    const domain = at > 0 ? value.slice(at + 1) : "example.com";
    return fitTo(`${local}-${marker.code.toLowerCase()}@${domain}`, field.maxLength, marker.code.toLowerCase());
  }
  if (type === "url" || /\burl\b|web ?site|homepage/.test(field.hint ?? "")) return value || "https://example.com";
  if (hasMarker(value, marker)) return value;
  const base = value.trim() || "Test";
  return fitTo(`${base} ${marker.code}`, field.maxLength, marker.code);
}

/** Cut to a length limit, keeping the marker: the start of the value gives way first. */
function fitTo(value: string, maxLength: number | undefined, code: string): string {
  if (!maxLength || maxLength <= 0 || value.length <= maxLength) return value;
  if (maxLength < code.length) return code.slice(0, maxLength);
  const at = value.lastIndexOf(code);
  const head = value.slice(0, Math.max(0, maxLength - (value.length - at)));
  return `${head}${value.slice(at)}`.trimStart().slice(-maxLength);
}

/**
 * The n-th odd number of a marker's tuple, for records with no text field: 2 to 4 digits with a
 * fraction that no person would type ("37.4183"). The same marker and n always give the same number.
 */
export function markNumber(marker: Marker, n = 0, o: { decimals?: number; max?: number } = {}): string {
  const next = rng(seedOf(`${marker.code}#${n}`));
  const max = o.max && o.max > 10 ? o.max : 999;
  const whole = 11 + Math.floor(next() * Math.max(1, max - 11));
  const decimals = o.decimals ?? 4;
  if (decimals <= 0) return String(whole);
  const frac = String(Math.floor(next() * 10 ** decimals)).padStart(decimals, "0");
  // A trailing 0 would be dropped by many lists ("37.4180" shows as "37.418"): never one.
  return `${whole}.${frac.replace(/0$/, "7")}`;
}

/** Whether a text carries this marker (any case, as a word of its own or inside an email). */
export function hasMarker(text: string, marker: Marker): boolean {
  return new RegExp(`(^|[^0-9A-Za-z])${marker.code}([^0-9A-Za-z]|$)`, "i").test(text);
}

/**
 * A marker's code found in a value made up by ANY run ("Test 7Q2K", "test+cm-7q2k@…"), or nothing.
 * For cleanup and reports only: never as proof that a row is this run's (use hasMarker with the run's own).
 */
export function markerIn(text: string): string | undefined {
  const m = /\bTest(?:[\w ]{0,30})? ([2-9A-HJKMNP-Z]{4})\b|test\+cm-([2-9a-hjkmnp-z]{4})@/.exec(text);
  const code = (m?.[1] ?? m?.[2])?.toUpperCase();
  return code && /\d/.test(code) && /[A-Z]/.test(code) ? code : undefined;
}
