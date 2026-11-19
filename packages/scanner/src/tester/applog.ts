/**
 * E1 (#53): the app log. It records what the page did while the test ran:
 * - console lines
 * - uncaught page errors
 * - requests that failed
 * - 4xx and 5xx answers
 * - the main frame's navigations
 *
 * Each line is tied to its step and its time in the video. Every line is masked (the run's known values
 * become {name}) and redacted (token-shaped text, secret-named fields and URL secrets go), and clipped
 * to 300 characters. Repeats within a step collapse into a count, and the log is capped so a noisy
 * page can't fill the disk. The text is the site's own, so it is untrusted data: it is shown as text
 * only and is never sent to the AI as an instruction.
 */
import type { ConsoleMessage, Frame, Page, Request, Response } from "playwright";
import { withoutSecrets } from "./cache.ts";
import type { AppLogEntry, AppLogKind } from "../../../../cli/app/contracts.ts";

export const LOG_TEXT_MAX = 300;
export const LOG_MAX_ENTRIES = 500;

export interface AppLogOptions {
  /** The step running now (0 before the first). */
  step: () => number;
  /** Seconds into the video now. */
  at: () => number;
  /** The run's masker: known values become {name}. */
  mask?: (s: string) => string;
  max?: number;
  /** Each new line, live (ui-server sends it as a "log" event). Repeats only bump the count, so they are not sent again. */
  onEntry?: (e: AppLogEntry) => void;
}

export interface AppLog {
  entries(): AppLogEntry[];
  forStep(n: number): AppLogEntry[];
  /** Lines dropped because the log was full. */
  dropped(): number;
  /** Stops listening. Safe to call twice. */
  stop(): void;
}

/** Token-shaped text, whatever its name: JWTs, bearer tokens, provider keys, long random runs. */
const REDACT: [RegExp, string][] = [
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, "[redacted jwt]"],
  [/\b(bearer|basic|token)\s+[\w~+/.=-]{12,}/gi, "$1 [redacted]"],
  [/\b(sk|pk|rk)_(live|test)_[\w]{8,}/g, "[redacted key]"],
  [/\b(ghp|gho|ghs|xox[abpr])[_-][\w-]{10,}/g, "[redacted key]"],
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session(?:id)?|auth|otp|cvc|cvv|card(?:number)?))(["']?\s*[:=]\s*["']?)([^\s"'&,;}]{1,200})/gi, "$1$2[redacted]"],
  [/\b(?=[\w+/=-]*\d)(?=[\w+/=-]*[a-z])(?=[\w+/=-]*[A-Z])[\w+/=-]{32,}\b/g, "[redacted]"],
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g, "[redacted number]"],
];

/** A path piece that reads like a token (a reset link's /reset/<token>, a magic link's code): long, with letters and digits, or a JWT. */
const TOKEN_SEGMENT = /^(?=[^/]*\d)(?=[^/]*[a-z])[\w~+=%.-]{20,}$|^eyJ[\w-]{6,}/i;

const ASSET = /\.(m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|json|html?|txt|wasm)$/i;

/** An address with token-shaped path pieces replaced by ":token". Query and fragment are left to withoutSecrets. */
export function withoutPathSecrets(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  // A built file's hashed name (main-3f9a1c2b7d8e4f60.js) is a file, not a token: kept, so a 404 on it reads plainly.
  const path = u.pathname.split("/").map((seg) => (TOKEN_SEGMENT.test(seg) && !ASSET.test(seg) ? ":token" : seg)).join("/");
  if (path === u.pathname) return url;
  u.pathname = path;
  return u.href;
}

/** A line of the site's text, masked, redacted and clipped. */
export function cleanText(text: string, mask: (s: string) => string = (s) => s): string {
  let s = mask(String(text ?? "")).replace(/\s+/g, " ").trim();
  // URLs inside the text lose their secrets as a URL would.
  s = s.replace(/\bhttps?:\/\/[^\s"'<>)]+/g, (u) => withoutPathSecrets(withoutSecrets(u)));
  for (const [re, to] of REDACT) s = s.replace(re, to);
  s = mask(s);
  return s.length > LOG_TEXT_MAX ? `${s.slice(0, LOG_TEXT_MAX - 1)}…` : s;
}

/** An address as the log keeps it: no user, password, secret-named query or token fragment; masked; clipped. */
export function cleanUrl(url: string, mask: (s: string) => string = (s) => s): string {
  const s = mask(withoutPathSecrets(withoutSecrets(url)));
  return s.length > LOG_TEXT_MAX ? `${s.slice(0, LOG_TEXT_MAX - 1)}…` : s;
}

const LEVEL: Record<string, AppLogEntry["level"]> = { error: "error", warning: "warn", warn: "warn", info: "info", log: "info", debug: "debug", trace: "debug" };

/** Starts the app log on a page. Listening only: it never changes the page or its requests. */
export function attachAppLog(page: Page, o: AppLogOptions): AppLog {
  const mask = o.mask ?? ((s: string) => s);
  const max = o.max ?? LOG_MAX_ENTRIES;
  const list: AppLogEntry[] = [];
  /** Same line, same step: its entry, to count repeats. */
  const seen = new Map<string, AppLogEntry>();
  let dropped = 0;

  const push = (kind: AppLogKind, level: AppLogEntry["level"], text: string, extra: { url?: string; method?: string; status?: number } = {}) => {
    const step = o.step();
    const entry: AppLogEntry = {
      kind,
      level,
      text: cleanText(text, mask),
      step,
      at: Math.round(o.at() * 10) / 10,
      ...(extra.url ? { url: cleanUrl(extra.url, mask) } : {}),
      ...(extra.method ? { method: extra.method.slice(0, 10) } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
    };
    const key = `${step}\u0000${kind}\u0000${entry.text}\u0000${entry.url ?? ""}\u0000${entry.status ?? ""}`;
    const before = seen.get(key);
    if (before) {
      before.count = (before.count ?? 1) + 1;
      return;
    }
    if (list.length >= max) {
      dropped++;
      return;
    }
    seen.set(key, entry);
    list.push(entry);
    o.onEntry?.(entry);
  };

  const onConsole = (m: ConsoleMessage) => {
    const level = LEVEL[m.type()] ?? "info";
    const loc = m.location();
    push("console", level, m.text(), loc?.url ? { url: loc.url } : {});
  };
  const onPageError = (e: Error) => push("pageerror", "error", `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}`);
  const onFailed = (r: Request) => push("request_failed", "error", `${r.method()} failed: ${r.failure()?.errorText ?? "no answer"}`, { url: r.url(), method: r.method() });
  const onResponse = (r: Response) => {
    const status = r.status();
    if (status < 400) return;
    const req = r.request();
    push("http_error", status >= 500 ? "error" : "warn", `${req.method()} ${status} ${r.statusText()}`.trim(), { url: r.url(), method: req.method(), status });
  };
  const onNav = (f: Frame) => {
    if (f !== page.mainFrame()) return;
    push("navigation", "info", "went to the page", { url: f.url() });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onFailed);
  page.on("response", onResponse);
  page.on("framenavigated", onNav);
  let stopped = false;
  return {
    entries: () => list.map((e) => ({ ...e })),
    forStep: (n) => list.filter((e) => e.step === n).map((e) => ({ ...e })),
    dropped: () => dropped,
    stop() {
      if (stopped) return;
      stopped = true;
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
      page.off("framenavigated", onNav);
    },
  };
}

/** Counts by kind, for the result tab's label ("Console & network (2)"): errors and warnings only. */
export function logCounts(entries: readonly AppLogEntry[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const e of entries) {
    if (e.level === "error") errors += e.count ?? 1;
    else if (e.level === "warn") warnings += e.count ?? 1;
  }
  return { errors, warnings };
}
