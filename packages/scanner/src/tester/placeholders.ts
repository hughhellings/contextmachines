/**
 * One way to write a value the test types without anyone seeing it: `{name}` (a --var) or
 * `{label.field}` (a test account's field: `{admin.password}`). Used everywhere a placeholder is read
 * (the actor's typing, the pre-run check for missing values, the saved test's list of what it types,
 * the prompts' list of what may be typed), so they can never disagree.
 *
 * And the masker: every value the run knows (a --var, an account's username or password, later a code
 * made mid-run) turned back into its `{name}` wherever it shows, in every form a site or a tool may
 * write it. It can be told a new value at any time (`add`), and the next line it masks hides it.
 */

/** A placeholder: a name, or a label and a field joined by one dot. */
const NAME = "[A-Za-z_][\\w-]*(?:\\.[A-Za-z_][\\w-]*)?";
/** Every placeholder in some words (global: use with matchAll or replace). */
export const PLACEHOLDER = new RegExp(`\\{(${NAME})\\}`, "g");
/** Words that are exactly one placeholder. */
export const ONE_PLACEHOLDER = new RegExp(`^\\{(${NAME})\\}$`);

/** The placeholder names some words use, each once, in order. */
export function placeholderNames(words: string): string[] {
  return [...new Set([...words.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Whether some words use a placeholder. */
export const usesPlaceholder = (words: string) => new RegExp(PLACEHOLDER.source).test(words);

/** An account placeholder's label and field (`admin.password` → admin, password); a plain name has no label. */
export function splitName(name: string): { label?: string; field: string } {
  const at = name.indexOf(".");
  return at < 0 ? { field: name } : { label: name.slice(0, at), field: name.slice(at + 1) };
}

/** Field names that hold a password: only ever typed into a password field. */
export const isPasswordName = (name: string) => /^password$/i.test(splitName(name).field);

/**
 * Where the values behind placeholders come from: asked by name, at type time. `has` is the pre-run
 * check (a value is set, so the run won't stop half-way for want of it); `get` gives the value itself.
 */
export interface Resolver {
  names(): string[];
  has(name: string): boolean;
  get(name: string): string | undefined;
  /** The value as `get` gives it, without it counting as typed (told to the masker before the run). */
  peek?(name: string): string | undefined;
  /**
   * A value made when it is typed, never before and never kept (an authenticator code, a code or a
   * link from the inbox): undefined when `name` isn't one. It tells the masker the value (and what it
   * was made from) before handing it over. `since`: the send it must come after (ms since 1970).
   */
  fresh?(name: string, o: FreshOptions): Promise<Fresh> | undefined;
  /** A new resolver with new made-up values (a sign-up's address and password), for another try. */
  renew?(): Resolver;
}

export interface FreshOptions {
  since: number;
  mask: Masker;
  /** Hosts a link from the inbox may be on: the test's own, and --allow-host. */
  allowedHosts: readonly string[];
  signal?: AbortSignal;
  /** The host the account signs in on (the test's start host). */
  host?: string;
  /** The exact host the value is about to be typed on, when known. */
  typedOn?: string;
}

/**
 * A value made at type time, or why there is none, as a code a pipeline can act on (C19):
 * CODE_NOT_RECEIVED (the inbox answered, no message came: a FAIL), CODE_SOURCE_UNAVAILABLE (no source,
 * or it didn't answer: BLOCKED), CODE_NOT_SURE (a message came, but its code or link isn't certain),
 * CODE_NEEDS_PERSON (the code or link went to the person's own inbox: a run never waits for a person, so BLOCKED;
 * "Set up sign-in" under Accounts is the fix), SMS_CODE_NEEDED (the same for a code by text), and
 * TEST_CODE_NOT_ALLOWED (a provider test code on a host not marked as yours: never typed).
 */
export type Fresh = { value: string } | { problem: string; code: "CODE_NOT_RECEIVED" | "CODE_SOURCE_UNAVAILABLE" | "CODE_NOT_SURE" | "CODE_NEEDS_PERSON" | "SMS_CODE_NEEDED" | "TEST_CODE_NOT_ALLOWED" };

/** A resolver over plain values (the --var record). */
export function recordResolver(values: Record<string, string>): Resolver {
  return { names: () => Object.keys(values), has: (n) => n in values, get: (n) => values[n] };
}

/** Fills in each placeholder from `get`; one it can't fill is left as it is. */
export function fillPlaceholders(words: string, get: (name: string) => string | undefined): string {
  return words.replace(PLACEHOLDER, (all, n: string) => get(n) ?? all);
}

/** A value is a secret (masked in every form, pieces too) when its name says so or it is an account's. */
export const secretName = (name: string) => name.includes(".") || /pass|secret|token|key|code|otp|totp|pin\b|cookie|session/i.test(name);

/** A masker: a function that hides every value it knows, and can be told more. */
export interface Masker {
  (s: string): string;
  /** A value to hide from now on, as {name}. `secret`: its pieces are hidden too (a cut-off start of it). */
  add(name: string, value: string, secret?: boolean): void;
  /** The values it hides, by name, the latest of each (for the screenshot rule and the leak check). Never printed. */
  values(): ReadonlyMap<string, string>;
  /** Every value it hides, old ones too. Never printed. */
  every(): readonly (readonly [string, string])[];
}

const htmlEscape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Each form a value may show in: as typed; in an address (encoded, + for space); JSON- and
 * HTML-escaped; with its spaces run together. For a secret, also base64 and with its spaces taken out.
 * (A cut-off start of a secret is matched apart: see `pieceLength`.)
 */
export function maskForms(value: string, secret: boolean): string[] {
  const forms = new Set<string>([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, "+"), encodeURI(value), value.replace(/ /g, "+"), JSON.stringify(value).slice(1, -1), htmlEscape(value), value.replace(/\s+/g, " ")]);
  if (secret) {
    forms.add(Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""));
    forms.add(value.replace(/\s+/g, ""));
  }
  return [...forms].filter((f) => f.length >= 3);
}

/**
 * How much of a secret's start is enough to hide a cut-off copy of it (a page or a log that clips a
 * value): its first 8 characters, or the first half of one shorter than 16. Under 4 is too little to
 * hide without breaking ordinary words.
 */
export const pieceLength = (value: string) => {
  const n = value.length >= 16 ? 8 : Math.ceil(value.length / 2);
  return n >= 4 ? n : 0;
};

/** A pattern for any start of `value` at least `from` characters long: the piece, then each next character optional, in turn. */
function startsOf(value: string, from: number): string {
  const chars = Array.from(value);
  let tail = "";
  for (let i = chars.length - 1; i >= from; i--) tail = `(?:${escapeRe(chars[i]!)}${tail})?`;
  return `${chars.slice(0, from).map(escapeRe).join("")}${tail}`;
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Hides values wherever they show: each becomes its {name}. Longest form first, so one inside another
 * doesn't leave a piece. A value of one or two characters is no secret, and hiding it would break
 * every word it is part of. More values can be added at any time (`add`): a code made mid-run.
 */
export function makeMasker(vars: Record<string, string> = {}): Masker {
  const known = new Map<string, string>();
  /** Every value ever told, a name's old ones too (an authenticator code from a minute ago is still a secret). */
  const all: [string, string][] = [];
  const secrets = new Set<string>();
  let pattern: RegExp | undefined;
  let nameOf = new Map<string, string>();
  const rebuild = () => {
    const alts: { name: string; source: string; length: number }[] = [];
    nameOf = new Map();
    for (const [name, value] of all) {
      if (value.length < 3) continue;
      for (const form of maskForms(value, secrets.has(name))) {
        alts.push({ name, source: escapeRe(form), length: form.length });
        // Two names with the same value (a city and a state both "New York"): the field may hold either,
        // so both are said, never only the first (the actor would "fix" the other field to match).
        const had = nameOf.get(form.toLowerCase());
        if (!had) nameOf.set(form.toLowerCase(), name);
        else if (had !== name && !had.split(" or ").includes(name)) nameOf.set(form.toLowerCase(), `${had} or ${name}`);
      }
      const piece = secrets.has(name) ? pieceLength(value) : 0;
      if (piece) alts.push({ name, source: startsOf(value, piece), length: piece });
    }
    alts.sort((a, b) => b.length - a.length);
    pattern = alts.length ? new RegExp(alts.map((a) => a.source).join("|"), "gi") : undefined;
  };
  /** The name for what matched: one of its forms, or a cut-off start of a secret. */
  const nameFor = (found: string) => {
    const exact = nameOf.get(found.toLowerCase());
    if (exact) return exact;
    for (const [name, value] of all) {
      if (secrets.has(name) && found.length >= pieceLength(value) && value.toLowerCase().startsWith(found.toLowerCase())) return name;
    }
    return "value";
  };
  const mask = ((s: string) => (pattern && typeof s === "string" ? s.replace(pattern, (found) => `{${nameFor(found)}}`) : s)) as Masker;
  mask.add = (name, value, secret = secretName(name)) => {
    if (typeof value !== "string" || !value) return;
    if (all.some(([n, v]) => n === name && v === value) && (!secret || secrets.has(name))) return;
    known.set(name, value);
    if (!all.some(([n, v]) => n === name && v === value)) all.push([name, value]);
    if (secret) secrets.add(name);
    rebuild();
  };
  mask.values = () => known;
  mask.every = () => all;
  for (const [name, value] of Object.entries(vars)) {
    known.set(name, value);
    all.push([name, value]);
    if (secretName(name)) secrets.add(name);
  }
  rebuild();
  return mask;
}
