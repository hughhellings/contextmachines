/**
 * Made-up test values for the fields a goal didn't give: a client's email, a billing address, a
 * reference number. Plainly fake ("test+cm@example.com", "1 Test Street", "Test Client"), never
 * anything that could be a real person's. What a field states about itself (its type, a pattern, a
 * length, a min and max) is met with form-values.ts, as the learner meets it.
 *
 * Some values are never made up: a password or a code, a card or bank detail, a government number.
 * Those come only from --var, and the field says which one to pass.
 */
import { fromPattern, valueMeeting, type FieldState } from "../form-values.ts";

/** What a field says about itself, read in the page. */
export interface FieldFacts {
  tag: string;
  type: string;
  /** Its name, id, label, placeholder and autocomplete, in lower case: what it is for. */
  hint: string;
  /** How a person reads it: its label, or failing that its placeholder or name. */
  label: string;
  placeholder: string;
  autocomplete: string;
  inputMode: string;
  required: boolean;
  value: string;
  pattern: string;
  min: string;
  max: string;
  step: string;
  minLength: number;
  maxLength: number;
  /** For a list: its choices, as [value, label], the empty "Choose…" left out. */
  options?: [string, string][];
  /** Its form (or, with none, its page) has a password field: a sign-in or sign-up, whose names are real. */
  signIn?: boolean;
}

/** The word the actor uses for "make one up": fill {ref, value: "auto"}. */
export const AUTO = /^\s*auto\s*$/i;

/** Runs in the page, so it is self-contained: what a form field says about itself. */
export function fieldFacts(e: Element): FieldFacts {
  const f = e as HTMLInputElement;
  const tag = e.tagName.toLowerCase();
  const by = e.getAttribute("aria-labelledby");
  const labelled = by ? by.split(/\s+/).map((id) => e.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "";
  // A label wrapping the field holds the field's own words too (a list's options): only its own text.
  const labelText = (l: HTMLLabelElement) => [...l.childNodes].filter((n) => n.nodeType === 3 || (n as Element).tagName === "SPAN").map((n) => n.textContent ?? "").join(" ");
  const label = (e.getAttribute("aria-label") || labelled || (f.labels?.[0] ? labelText(f.labels[0]) : "") || "").replace(/\s+/g, " ").trim();
  const placeholder = e.getAttribute("placeholder") ?? "";
  const autocomplete = (e.getAttribute("autocomplete") ?? "").toLowerCase();
  const options = tag === "select" ? [...(e as HTMLSelectElement).options].filter((o) => o.value !== "" && !o.disabled).map((o) => [o.value, o.label.trim()] as [string, string]) : undefined;
  return {
    tag,
    type: (e.getAttribute("type") ?? (tag === "input" ? "text" : "")).toLowerCase(),
    hint: [e.getAttribute("name"), e.id, label, placeholder, autocomplete].filter(Boolean).join(" ").toLowerCase(),
    label: (label || placeholder || e.getAttribute("name") || "").slice(0, 60),
    placeholder,
    autocomplete,
    inputMode: e.getAttribute("inputmode") ?? "",
    required: f.required || e.getAttribute("aria-required") === "true",
    value: tag === "select" ? (e as HTMLSelectElement).value : ((e as HTMLElement).isContentEditable ? (e.textContent ?? "") : f.value ?? ""),
    pattern: e.getAttribute("pattern") ?? "",
    min: e.getAttribute("min") ?? "",
    max: e.getAttribute("max") ?? "",
    step: e.getAttribute("step") ?? "",
    minLength: typeof f.minLength === "number" ? f.minLength : -1,
    maxLength: typeof f.maxLength === "number" ? f.maxLength : -1,
    ...(options ? { options } : {}),
    signIn: Boolean((f.form ?? e.ownerDocument).querySelector("input[type=password]")),
  };
}

/** Fields whose value must be real, and so is never made up: the --var to pass instead. */
const NEVER: [RegExp, string, string][] = [
  [/pass(word|phrase|code)?\b|\bpwd\b/, "password", "a password"],
  [/\b(otp|one[- ]?time|verification code|security code|2fa|mfa|auth(entication)? code|pin)\b/, "code", "a one-time or security code"],
  [/\b(card|cc-(number|csc|exp)|cvc|cvv|csc|expiry|expiration|iban|sort ?code|routing|swift|bic)\b|\b(bank|account) ?(number|no\.?|#)|\bbank\b/, "card", "card or bank details"],
  [/\b(ssn|social security|passport|national (insurance|id)|driv(er'?s?|ing) ?licen[cs]e|tax ?id|tin)\b/, "id", "a government ID number"],
  [/\b(api[- ]?key|secret|token)\b/, "key", "a key or token"],
];

export type MadeUp = { value: string } | { cannot: string; varName: string };

/** A field for a message (a contact form's "Your message", a comment): what it says is the person's, so it's never made up. */
const MESSAGE = /\b(message|comments?|feedback|enquiry|inquiry|question|your note)\b/;
/** A field that names who signs in: next to a password it must be the real one, never a made-up one. */
const IDENTITY = /e-?mail|\b(user ?name|login|account|handle|user ?id|phone|mobile)\b/;

/** What a test may make up: nothing at all (a sign-in, a goal with --var values), and the {name}s it was given. */
export interface MadeUpRules {
  /** Make up nothing: every value is the goal's or a --var. */
  none?: boolean;
  /** The --var names: a field one of them could fill takes that, never a made-up value. */
  varNames?: readonly string[];
}

/**
 * Why a value for this field isn't made up, before what it could be: a test told to make up nothing,
 * a field a --var could fill ("Email" when {email} was given), who signs in next to a password (a
 * made-up email beside a real password would be a failed sign-in, on every replay), a message.
 */
export function refusedMadeUp(f: Pick<FieldFacts, "tag" | "hint" | "type" | "signIn">, rules: MadeUpRules = {}): { cannot: string; varName: string; given?: true } | undefined {
  const varName = rules.varNames?.find((n) => n.length >= 2 && f.hint.includes(n.toLowerCase().replace(/[_-]/g, "")))
    ?? rules.varNames?.find((n) => n.length >= 2 && f.hint.replace(/[\s_-]/g, "").includes(n.toLowerCase().replace(/[_-]/g, "")));
  if (varName) return { cannot: `{${varName}}, which was given for it`, varName, given: true };
  if (f.signIn && (f.type === "email" || IDENTITY.test(f.hint))) {
    const name = f.type === "email" || /e-?mail/.test(f.hint) ? "email" : "username";
    return { cannot: "the real name it signs in with (it's next to a password)", varName: name };
  }
  if (f.tag === "textarea" || MESSAGE.test(f.hint)) return { cannot: "a message, which is the person's to write", varName: "message" };
  if (rules.none) return { cannot: "a value it was given (this test makes nothing up: a sign-in, or a goal with --var values)", varName: f.type === "email" || /e-?mail/.test(f.hint) ? "email" : "value" };
  return undefined;
}

/** A value it would never make up for this field: why, and the --var to pass. */
export function neverMadeUp(f: Pick<FieldFacts, "type" | "hint" | "autocomplete">): { cannot: string; varName: string } | undefined {
  if (f.type === "password" || /^(current|new)-password$|^one-time-code$/.test(f.autocomplete)) return { cannot: "a password", varName: "password" };
  for (const [pattern, varName, what] of NEVER) if (pattern.test(f.hint)) return { cannot: what, varName };
  return undefined;
}

/** Fit a made-up value to a field's own length limit. */
const fit = (value: string, f: FieldFacts) => (f.maxLength > 0 && value.length > f.maxLength ? value.slice(0, f.maxLength) : value);

/**
 * A plainly made-up value for a field, or why it won't make one up. Nothing here could be anyone's
 * real details: example.com addresses, "Test" names, "1 Test Street".
 */
export function madeUpValue(f: FieldFacts, today = new Date()): MadeUp {
  const never = neverMadeUp(f);
  if (never) return never;
  if (f.tag === "select") {
    const first = f.options?.[0];
    return first ? { value: first[1] || first[0] } : { cannot: "a choice from an empty list", varName: "choice" };
  }
  if (["checkbox", "radio", "file", "submit", "button", "image", "reset", "hidden"].includes(f.type)) return { cannot: `a ${f.type} field`, varName: "value" };
  const h = f.hint;
  const sample = f.pattern ? fromPattern(f.pattern) : undefined;
  if (f.type === "email" || /e-?mail/.test(h)) return { value: "test+cm@example.com" };
  if (f.type === "url" || /\burl\b|web ?site|homepage/.test(h)) return { value: "https://example.com" };
  if (sample !== undefined) return { value: sample };
  if (!["number", "range", "date", "datetime-local", "month", "time", "tel"].includes(f.type)) {
    // An amount typed as text (a fill table's "size", "price", "qty"): a number, not a word.
    if (/\b(size|qty|quantity|amount|price|lots?|contracts?|shares|units|volume)\b/.test(h) && !/\b(name|description|title|label)\b/.test(h)) return { value: fit("1", f) };
    if (/\b(street|address|addr|address-line\d?)\b/.test(h)) return { value: fit("1 Test Street", f) };
    if (/\b(city|town|address-level2|locality)\b/.test(h)) return { value: fit("Testville", f) };
    if (/\b(country|country-name)\b/.test(h)) return { value: fit("United Kingdom", f) };
    if (/\b(first|given)[ _-]?name\b|given-name/.test(h)) return { value: fit("Test", f) };
    if (/\b(last|family|sur)[ _-]?name\b|family-name/.test(h)) return { value: fit("User", f) };
    if (/\b(company|organi[sz]ation|business|org)\b/.test(h)) return { value: fit("Test Company Ltd", f) };
    if (/\b(client|customer)\b/.test(h) && /\bname\b|^name$/.test(h)) return { value: fit("Test Client", f) };
    if (/\b(user ?name|login|handle)\b/.test(h)) return { value: fit("test-user", f) };
    if (/\bname\b/.test(h)) return { value: fit("Test Client", f) };
    if (/\b(vat|tax|reg(istration)?|ref(erence)?|no\.?|number|code|id)\b/.test(h) && !/phone|mobile|tel/.test(h)) return { value: fit("TEST-001", f) };
  }
  // The rest as the learner does it: dates, times, numbers within their limits, phones, lengths.
  const state: FieldState = {
    mark: "", tag: f.tag, type: f.type, inputMode: f.inputMode, hint: h, placeholder: f.placeholder, value: "", min: f.min, max: f.max, step: f.step,
    minLength: f.minLength, maxLength: f.maxLength, pattern: f.pattern, invalid: true, flagged: false, says: "required", ...(f.options ? { options: f.options.map((o) => o[1]) } : {}),
  };
  const met = valueMeeting(state, 0, today);
  if (met && met !== "learner@example.test") return { value: met };
  return { value: fit(f.tag === "textarea" ? "This is a test, written by Context Machines." : "Test", f) };
}

/** A field that is required and still empty: the runner fills these when the actor is stuck on missing values. */
export const requiredEmpty = (f: FieldFacts) => f.required && !f.value.trim() && !["checkbox", "radio", "file", "hidden", "submit", "button", "image", "reset"].includes(f.type);

/** What to tell the person when a value can't be made up: "pass --var password=… and say {password} in the goal". */
export function varHint(varNames: readonly string[]): string {
  const names = [...new Set(varNames)];
  return `pass ${names.map((n) => `--var ${n}=…`).join(" ")} and say ${names.map((n) => `{${n}}`).join(", ")} in the goal or steps`;
}
