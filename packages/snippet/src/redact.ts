import type { FieldShape } from "@contextmachines/rules-core";

/**
 * Privacy by default: we send the *shape* of data (type, empty, length), never
 * values. Values are only kept for fields the site's owner explicitly allow-lists,
 * and even those are scrubbed for common personal-data patterns.
 */

const MAX_FIELDS = 64;
/** Fields whose length alone says too much (a password's length) and whose value is never sent, even if allow-listed. */
export const SECRET_FIELD = /pass(word|wd|code|phrase)?|secret|token|api[_-]?key|otp|mfa|2fa|pin\b|cvv|cvc|card[_-]?(number|no)|iban|ssn|national[_-]?id/i;
const MAX_DEPTH = 3;
const MAX_VALUE_LENGTH = 256;

const SCRUBBERS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/\+?\d[\d ()-]{7,}\d/g, "[number]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

export function shapeOf(value: unknown): FieldShape {
  if (value === null || value === undefined) return { type: "null", empty: true };
  if (typeof value === "string") return { type: "string", empty: value.trim().length === 0, length: value.length };
  if (typeof value === "number") return { type: "number", empty: false };
  if (typeof value === "boolean") return { type: "boolean", empty: false };
  if (Array.isArray(value)) return { type: "array", empty: value.length === 0, length: value.length };
  if (typeof File !== "undefined" && value instanceof File) return { type: "file", empty: value.size === 0, length: value.size };
  if (typeof Blob !== "undefined" && value instanceof Blob) return { type: "file", empty: value.size === 0, length: value.size };
  if (typeof value === "object") return { type: "object", empty: Object.keys(value).length === 0, length: Object.keys(value).length };
  return { type: "unknown", empty: false };
}

/**
 * Flattens a request body into dotted field paths with shapes.
 * `allowValues` lists exact paths whose (scrubbed) values may be included.
 * A top-level array (e.g. a batch insert) is described by its first item,
 * plus `_items` giving the batch size.
 */
export function describeFields(body: unknown, allowValues: ReadonlySet<string>): Record<string, FieldShape> {
  const out: Record<string, FieldShape> = {};
  let count = 0;

  const visit = (value: unknown, path: string, depth: number): void => {
    if (count >= MAX_FIELDS) return;
    const shape = shapeOf(value);
    const secret = SECRET_FIELD.test(path);
    if (secret && shape.type === "string") delete shape.length;
    if (path) {
      if (allowValues.has(path) && !secret) {
        if (typeof value === "string") shape.value = scrub(value).slice(0, MAX_VALUE_LENGTH);
        else if (typeof value === "number" || typeof value === "boolean") shape.value = value;
      }
      out[path] = shape;
      count++;
    }
    if (shape.type === "object" && depth < MAX_DEPTH && value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (!isSafeKey(key)) continue;
        visit((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  if (Array.isArray(body)) {
    out._items = { type: "array", empty: body.length === 0, length: body.length };
    count++;
    if (body.length > 0) visit(body[0], "", 0);
    return out;
  }
  visit(body, "", 0);
  return out;
}

const NO_VALUES: ReadonlySet<string> = new Set();
const MAX_RESULT_FIELDS = 24;
/** A key that is data rather than a name: an id, a number, a date ("2026-11-02"), a hex string. */
const DATA_KEY = /\d{3,}|^[0-9a-f]{8,}$/i;

/**
 * What a reply gives back, as shapes only: never a value, and no string lengths. Two levels
 * deep, at most 24 fields, and keys that are themselves data (ids, dates) are dropped, so a
 * reply keyed by record id says nothing about the records.
 */
export function describeResult(body: unknown): Record<string, FieldShape> {
  const out: Record<string, FieldShape> = {};
  for (const [path, shape] of Object.entries(describeFields(body, NO_VALUES))) {
    if (Object.keys(out).length >= MAX_RESULT_FIELDS) break;
    const parts = path.split(".");
    if (parts.length > 2 || parts.some((p) => DATA_KEY.test(p))) continue;
    out[path] = shape.type === "array" ? shape : { type: shape.type, empty: shape.empty };
  }
  return out;
}

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
function isSafeKey(key: string): boolean {
  return SAFE_KEY.test(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
