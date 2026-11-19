/**
 * Small helpers the data lane shares: ids, owner-only JSON files written whole, and text clipping.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** "<prefix>_<12 hex>", as contracts.ts says. */
export const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
/** A steady id from a text (a run folder's path): the same folder always has the same id. */
export const stableId = (prefix: string, text: string) => `${prefix}_${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

export const nowIso = (now: Date = new Date()) => now.toISOString();

/** A folder only its owner can read, git-ignored, as the cloud's data folder is. */
export function ownerDir(dir: string, gitignore = false): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: the folder's own permissions hold.
  }
  if (gitignore && !existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
}

/** Written whole through a temporary file and renamed over, readable by its owner only (0600). */
export function writeOwnerOnly(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  renameSync(tmp, path);
}

export const writeJson = (path: string, value: unknown) => writeOwnerOnly(path, `${JSON.stringify(value, null, 2)}\n`);

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** One line, at most n characters (300 for site text, C23). */
export function clip(text: string, n = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A data-lane error with an HTTP status: 400 bad input, 404 unknown id, 409 busy or stale. */
export class DataError extends Error {
  override name = "DataError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const bad = (m: string) => new DataError(400, m);
export const notFound = (what: string) => new DataError(404, `There's no ${what} with that id.`);
