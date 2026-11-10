/**
 * A form tells you what it wants. After a save was turned down, the learner reads what the browser
 * and the page say about each field and works out a value that meets it: nothing here knows about
 * any one kind of form, only about how forms state their rules (a field's own limits, a number or a
 * length in the message beside it, "must be in the past").
 */

/** What a page says about one field after a save was turned down (see readRejection in scan.ts). */
export interface FieldState {
  /** The learner's mark on the field, to find it again. */
  mark: string;
  tag: string;
  type: string;
  inputMode: string;
  /** Its name, id, placeholder and label, in lower case. */
  hint: string;
  placeholder: string;
  value: string;
  min: string;
  max: string;
  step: string;
  /** -1 when not set, as the browser reports it. */
  minLength: number;
  maxLength: number;
  pattern: string;
  /** The browser says it's invalid. */
  invalid: boolean;
  /** The page marks it invalid (aria-invalid, or an error message of its own beside it). */
  flagged: boolean;
  /** Everything said about it: the browser's message, what's linked to it, what's written beside it. */
  says: string;
  /** Real choices of a list, when it's one. */
  options?: string[];
}

export interface Rejection {
  fields: FieldState[];
  /** What newly appeared on the page that reads as an error. */
  message: string;
}

export interface Fix {
  mark: string;
  kind: "fill" | "select" | "check" | "clear";
  value: string;
}

/** How long the longest text we'll write gets: a limit beyond this is a document, not a form. */
const MAX_TEXT = 2000;
/** Written into boxes for longer text: a sentence, as a person would write. */
export const SENTENCE = "This is a test message, written to learn what this form does.";
const STRONG_PASSWORD = "Learner-pass-123";

const NUM = String.raw`[$£€]?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?`;
const LOWER = new RegExp(String.raw`(?:at least|no less than|not less than|minimum(?:\s+[a-z]+){0,2}?:?|minimal|min\.?|greater than or equal to|must be >=?)\s*${NUM}`, "i");
const ABOVE = new RegExp(String.raw`(?<!\b(?:no|not) )(?:more than|greater than|longer than|over|above|exceed(?:s|ing)?|must be >)\s*${NUM}`, "i");
const UPPER = new RegExp(String.raw`(?:at most|no more than|not more than|maximum(?:\s+[a-z]+){0,2}?:?|max\.?|less than or equal to|up to|must be <=?)\s*${NUM}`, "i");
const BELOW = new RegExp(String.raw`(?<!\b(?:no|not) )(?:less than|fewer than|shorter than|under|below)\s*${NUM}`, "i");
const BETWEEN = new RegExp(String.raw`between\s*${NUM}\s*(?:and|to|-|–)\s*${NUM}`, "i");
const OR_MORE = new RegExp(String.raw`${NUM}(?:\s*(?:characters?|chars?|letters?|digits?|words?|symbols?))?\s*(?:or (?:more|longer)|\+|minimum|at least)`, "i");
const LENGTH_WORDS = /\b(characters?|chars?|letters?|symbols?|words?|long|short|length)\b/i;
const EXACT_DIGITS = /(?:exactly |be |of |must have )?\b(\d{1,2})[- ]digits?\b/i;
const IS_NUMBER = /\b(?:a|valid|whole)\s+(?:valid\s+)?(?:number|amount|integer)\b|\bnumeric\b|\b(?:digits|numbers)\s+only\b/i;
const IN_PAST = /\b(?:in the past|past date|before today|earlier than today|future date|can.?t be in the future|cannot be in the future|must be \d+|\d+ or older|years? old|too young|of age)\b/i;
const IN_FUTURE = /\b(?:in the future|future|after today|later than today|past date|can.?t be in the past|cannot be in the past|must be upcoming)\b/i;
const NEEDS_MIX = /\b(?:upper-?\s?case|lower-?\s?case|capital|special|symbol|digit|number|strong|weak)\b/i;
const NUMBERS_LOW = /\b(?:meet|enough|insufficient|too low|too small|higher|larger|greater|minimum|at least)\b/i;
const NUMBERS_HIGH = /\b(?:too high|too large|too much|too big|lower|smaller|maximum|at most|exceed)/i;

const amount = (digits: string | undefined, k: string | undefined) => {
  const n = Number((digits ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : undefined;
};

/** The limits a sentence states, if any. "More than 5" is at least 6. */
export function limitsSaid(text: string): { lower?: number; upper?: number } {
  const between = BETWEEN.exec(text);
  if (between) return { lower: amount(between[1], between[2])!, upper: amount(between[3], between[4])! };
  const out: { lower?: number; upper?: number } = {};
  for (const [re, set] of [[LOWER, 0], [OR_MORE, 0], [ABOVE, 1]] as const) {
    const m = re.exec(text);
    if (m && out.lower === undefined) out.lower = amount(m[1], m[2])! + set;
  }
  for (const [re, set] of [[UPPER, 0], [BELOW, 1]] as const) {
    const m = re.exec(text);
    if (m && out.upper === undefined) out.upper = amount(m[1], m[2])! - set;
  }
  return out;
}

/** A sample that matches a form's pattern attribute, for the patterns forms really use. */
export function fromPattern(pattern: string): string | undefined {
  let source: RegExp;
  try {
    source = new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
  const ok = (s: string | undefined) => (s !== undefined && source.test(s) ? s : undefined);
  let at = 0;
  const classSample = (): string => {
    // Inside [...]: the first thing it allows, or a letter or digit its negation doesn't rule out.
    const start = at;
    let depth = 1;
    while (at < pattern.length && depth > 0) {
      if (pattern[at] === "\\") at++;
      else if (pattern[at] === "]") depth--;
      at++;
    }
    const body = pattern.slice(start, at - 1);
    if (body.startsWith("^")) return ["a", "A", "1", "-"].find((c) => new RegExp(`[${body}]`).test(c)) ?? "a";
    if (body.startsWith("\\d")) return "1";
    if (body.startsWith("\\w")) return "a";
    if (body.startsWith("\\s")) return " ";
    return body.startsWith("\\") ? body.charAt(1) : body.charAt(0);
  };
  const quantified = (piece: string): string => {
    const c = pattern[at];
    if (c === "?") { at++; if (pattern[at] === "?") at++; return ""; }
    if (c === "*") { at++; return ""; }
    if (c === "+") { at++; return piece; }
    const n = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(at));
    if (!n) return piece;
    at += n[0].length;
    return piece.repeat(Math.min(Number(n[1]), MAX_TEXT));
  };
  const sequence = (): string => {
    let out = "";
    for (;;) {
      const c = pattern[at];
      if (c === undefined || c === ")") return out;
      if (c === "|") {
        // Only the first way of writing it is needed: the others are read past.
        let depth = 0;
        for (; at < pattern.length; at++) {
          if (pattern[at] === "\\") at++;
          else if (pattern[at] === "(") depth++;
          else if (pattern[at] === ")") { if (depth === 0) return out; depth--; }
        }
        return out;
      }
      at++;
      if (c === "^" || c === "$") continue;
      if (c === "(") {
        const look = /^\?(?:<?[=!])/.exec(pattern.slice(at));
        if (look) {
          // A look-ahead states a rule, it writes nothing: the check at the end has the last word.
          let depth = 1;
          for (; at < pattern.length && depth > 0; at++) {
            if (pattern[at] === "\\") at++;
            else if (pattern[at] === "(") depth++;
            else if (pattern[at] === ")") depth--;
          }
          continue;
        }
        const named = /^\?(?::|<[^>]+>)/.exec(pattern.slice(at));
        if (named) at += named[0].length;
        const inner = sequence();
        at++;
        out += quantified(inner);
        continue;
      }
      if (c === "[") { out += quantified(classSample()); continue; }
      if (c === ".") { out += quantified("a"); continue; }
      if (c === "\\") {
        const e = pattern[at++];
        out += quantified(e === "d" ? "1" : e === "w" ? "a" : e === "s" ? " " : e === "D" || e === "W" || e === "S" ? "-" : e ?? "");
        continue;
      }
      out += quantified(c);
    }
  };
  try {
    const sample = sequence();
    return ok(sample) ?? ok(STRONG_PASSWORD) ?? ok(sample.repeat(2));
  } catch {
    return undefined;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** A date written the way the field's placeholder shows ("dd/mm/yyyy"), or as the standard form. */
function asPlaceholder(date: string, placeholder: string): string {
  const [y, m, d] = date.split("-") as [string, string, string];
  const shape = /\b(dd|mm|yyyy|yy)([/.\- ])(dd|mm)\2(dd|mm|yyyy|yy)\b/i.exec(placeholder);
  if (!shape) return date;
  const part = (p: string | undefined) => (/dd/i.test(p ?? "") ? d : /mm/i.test(p ?? "") ? m : /yyyy/i.test(p ?? "") ? y : y.slice(2));
  return [part(shape[1]), part(shape[3]), part(shape[4])].join(shape[2]!);
}

function dateMeeting(f: FieldState, says: string, today: Date): string {
  const wantsPast = IN_PAST.test(says) || /birth|\bdob\b/.test(f.hint);
  const wantsFuture = !wantsPast && IN_FUTURE.test(says);
  let date = iso(wantsPast ? new Date(Date.UTC(1990, 0, 15)) : wantsFuture ? shift(today, 30) : today);
  if (f.min && date < f.min.slice(0, 10)) date = f.min.slice(0, 10);
  if (f.max && date > f.max.slice(0, 10)) date = f.max.slice(0, 10);
  if (f.type === "datetime-local") return `${date}T09:00`;
  if (f.type === "month") return date.slice(0, 7);
  return f.type === "date" ? date : asPlaceholder(date, f.placeholder);
}

function numberMeeting(f: FieldState, says: string, attempt: number): string | undefined {
  const said = limitsSaid(says);
  const low = f.min !== "" && Number.isFinite(Number(f.min)) ? Number(f.min) : undefined;
  const high = f.max !== "" && Number.isFinite(Number(f.max)) ? Number(f.max) : undefined;
  const lower = Math.max(low ?? -Infinity, said.lower ?? -Infinity);
  const upper = Math.min(high ?? Infinity, said.upper ?? Infinity);
  let value: number;
  if (lower > -Infinity) value = lower;
  else if (upper < Infinity) value = Math.min(upper, 1);
  // Turned down with no limit given: it wants a far larger number, or a far smaller one. Which comes
  // first is what the message leans to, and each is tried once.
  else if (NUMBERS_HIGH.test(says) && !NUMBERS_LOW.test(says)) value = attempt === 0 ? 1 : 100000;
  else value = attempt === 0 ? 100000 : 1;
  const step = f.step && f.step !== "any" ? Number(f.step) : 0;
  if (step > 0) {
    const base = low ?? 0;
    value = base + Math.ceil((value - base) / step - 1e-9) * step;
  }
  if (value > upper) value = upper;
  const text = String(Number(value.toFixed(6)));
  return text === f.value ? undefined : text;
}

function textMeeting(f: FieldState, says: string): string | undefined {
  const sample = f.pattern ? fromPattern(f.pattern) : undefined;
  if (sample !== undefined) return sample === f.value ? undefined : sample;
  const said = LENGTH_WORDS.test(says) || f.tag === "textarea" ? limitsSaid(says) : {};
  const shortest = Math.min(MAX_TEXT, Math.max(f.minLength, said.lower ?? 0));
  const longest = Math.min(f.maxLength >= 0 ? f.maxLength : Infinity, said.upper ?? Infinity);
  const password = f.type === "password" || /pass(word|code)?/.test(f.hint);
  let value = f.value;
  if (password && NEEDS_MIX.test(says)) value = STRONG_PASSWORD;
  const unit = /\bwords?\b/i.test(says) ? 8 : 1;
  if (value.length < shortest * unit) value = (value || SENTENCE).concat(" ", SENTENCE.repeat(Math.ceil((shortest * unit) / SENTENCE.length))).slice(0, shortest * unit);
  if (value.length > longest) value = value.slice(0, longest);
  if (value.length < 3 && f.value === "" && /required|empty|blank|enter|provide|missing|fill/i.test(says)) value = "Test";
  return value === f.value ? undefined : value;
}

/**
 * A value that meets what's said about a field, or undefined when nothing better is known (so the
 * form isn't sent again for nothing). `attempt` is 0 for the first try again, 1 for the second.
 */
export function valueMeeting(f: FieldState, attempt: number, today = new Date()): string | undefined {
  const says = f.says;
  const digits = EXACT_DIGITS.exec(says);
  if (f.type === "email" || /e-?mail/.test(f.hint)) return f.value === "learner@example.test" ? undefined : "learner@example.test";
  if (f.type === "url" || /\burl\b|web ?site/.test(f.hint)) return f.value === "https://example.test" ? undefined : "https://example.test";
  if (["date", "datetime-local", "month"].includes(f.type) || /\b(date|birth|dob)\b/.test(f.hint)) {
    const value = dateMeeting(f, says, today);
    return value === f.value ? undefined : value;
  }
  if (f.type === "time") return f.value === "09:00" ? undefined : "09:00";
  if (digits && !["number", "range"].includes(f.type)) return "123456789012345678".repeat(4).slice(0, Number(digits[1]));
  if (f.type === "tel" || /phone|mobile/.test(f.hint)) {
    const low = limitsSaid(says).lower;
    const value = "1234567890".repeat(4).slice(0, Math.max(10, low ?? 0));
    return value === f.value ? undefined : value;
  }
  if (/post(?:al)?[ _-]?code|\bzip\b/.test(f.hint) && !f.pattern) return f.value === "12345" ? undefined : "12345";
  const numeric = ["number", "range"].includes(f.type) || /^(numeric|decimal)$/.test(f.inputMode) || IS_NUMBER.test(says);
  return numeric ? numberMeeting(f, says, attempt) : textMeeting(f, says);
}

/** Words that say nothing about which field a message means. */
const COMMON = new Set(["your", "this", "that", "with", "from", "must", "have", "field", "value", "please", "enter", "required", "invalid", "should"]);

/**
 * What to change before pressing again. Fields the browser or the page point at come first. A
 * message that points at none (one line at the top of a form) is matched to the field it names, or
 * failing that goes to every field. Nothing to change means the rejection isn't one we can answer.
 */
export function fixesFor(seen: Rejection, attempt: number, today = new Date()): Fix[] {
  let pointed = seen.fields.filter((f) => f.invalid || f.flagged);
  if (pointed.length === 0 && seen.message) {
    const words = seen.message.toLowerCase();
    const named = seen.fields.filter((f) => f.hint.split(/[^\p{L}]+/u).some((w) => w.length >= 4 && !COMMON.has(w) && words.includes(w)));
    pointed = named.length > 0 ? named : seen.fields;
  }
  const fixes: Fix[] = [];
  for (const f of pointed) {
    // A test file it won't take: most forms do without one.
    if (f.type === "file") {
      if (f.value) fixes.push({ mark: f.mark, kind: "clear", value: "" });
      continue;
    }
    if (f.tag === "select") {
      const next = (f.options ?? []).find((o) => o !== f.value);
      if (next !== undefined && (f.value === "" || attempt > 0)) fixes.push({ mark: f.mark, kind: "select", value: next });
      continue;
    }
    if (f.type === "checkbox" || f.type === "radio") {
      if (f.value !== "checked" && !/newsletter|marketing|offers|subscribe/.test(f.hint)) fixes.push({ mark: f.mark, kind: "check", value: "" });
      continue;
    }
    const value = valueMeeting({ ...f, says: `${f.says} ${seen.message}`.trim() }, attempt, today);
    if (value !== undefined) fixes.push({ mark: f.mark, kind: "fill", value });
  }
  return fixes;
}
