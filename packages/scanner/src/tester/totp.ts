/**
 * Authenticator codes (AUTH C5, RFC 6238), made by our own code with node:crypto only: the AI never
 * sees the secret or a code. A code is made when it is typed, and told to the masker the moment it
 * exists; a replay makes a new one.
 *
 *   totpAt(parseTotpSecret("JBSWY3DPEHPK3PXP"), Date.now()) → "492039"
 *
 * The secret may be base32 (spaces, dashes and case ignored) or an otpauth://totp/ link, whose
 * digits, period and algorithm are read from it. SHA-1 is the default; SHA-256 and SHA-512 when the
 * link says so; 6 or 8 digits.
 */
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpSecret {
  key: Buffer;
  digits: 6 | 7 | 8;
  /** Seconds a code lasts. */
  period: number;
  algorithm: TotpAlgorithm;
}

/** A code is never typed with fewer than this many seconds left in its window: the next one is waited for. */
export const TOTP_MIN_LEFT_MS = 5000;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648) to bytes; spaces, dashes, padding and case ignored. Throws on anything else. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("an authenticator secret is base32 (letters A to Z and digits 2 to 7), or an otpauth:// link");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A stored authenticator secret, as base32 or an otpauth://totp/ link. Throws in plain words when it is neither. */
export function parseTotpSecret(stored: string): TotpSecret {
  const s = stored.trim();
  if (/^otpauth:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error("the otpauth:// link can't be read");
    }
    if (u.host.toLowerCase() !== "totp") throw new Error("only otpauth://totp/ links are taken (a counter-based hotp code isn't)");
    const secret = u.searchParams.get("secret");
    if (!secret) throw new Error("the otpauth:// link has no secret");
    const digits = Number(u.searchParams.get("digits") ?? 6);
    if (digits !== 6 && digits !== 7 && digits !== 8) throw new Error("an authenticator code has 6, 7 or 8 digits");
    const period = Number(u.searchParams.get("period") ?? 30);
    if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error("an authenticator code's period is 10 to 300 seconds");
    const algorithm = (u.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replace(/-/g, "");
    if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") throw new Error("an authenticator code's algorithm is SHA1, SHA256 or SHA512");
    return { key: base32Decode(secret), digits, period, algorithm };
  }
  return { key: base32Decode(s), digits: 6, period: 30, algorithm: "SHA1" };
}

/** The HOTP value for one counter (RFC 4226 section 5.3), as a string of `digits` digits. */
export function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm = "SHA1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code for a moment (ms since 1970). */
export function totpAt(secret: TotpSecret, atMs: number): string {
  return hotp(secret.key, Math.floor(atMs / 1000 / secret.period), secret.digits, secret.algorithm);
}

/** How long the code of this moment has left, in ms. */
export function msLeft(secret: Pick<TotpSecret, "period">, atMs: number): number {
  const p = secret.period * 1000;
  return p - (atMs % p);
}

/**
 * The code to type now: if fewer than 5 seconds are left in this window, it waits for the next one, so
 * the site gets a code that is still good when it arrives.
 */
export async function totpNow(secret: TotpSecret, o: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<string> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const left = msLeft(secret, now());
  if (left < TOTP_MIN_LEFT_MS) await sleep(left + 50);
  return totpAt(secret, now());
}
