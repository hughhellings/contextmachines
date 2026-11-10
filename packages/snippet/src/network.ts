import type { FieldShape } from "@contextmachines/rules-core";
import { describeResult } from "./redact.ts";
import { run } from "./safe.ts";

/**
 * Observes the page's own fetch/XHR traffic without changing it.
 *
 * Invariants (covered by tests):
 * - The original function is always called with the original `this` and arguments.
 * - The caller always receives the original return value / promise, unchanged.
 * - Any failure in our observation code is swallowed (fail-open).
 */
export interface RawRequest {
  method: string;
  url: string;
  body: unknown;
  status: number; // 0 = network error / aborted
  durationMs: number;
  /** The app reported failure despite a 2xx status (GraphQL "errors"). */
  appFailed?: boolean;
  /** The app's own error code ("CARD_DECLINED"), when it gave a code-like one. Never messages. */
  errorCode?: string;
  /** The form field the app's reply blames ("key"), when it names one: a field name, never a value. */
  errorField?: string;
  /** What a successful reply gave back, as shapes only (see describeResult). */
  result?: Record<string, FieldShape>;
  /** Next.js server action id (the Next-Action header): a build-time constant naming which action this is. */
  nextAction?: string;
  /** A Firestore write, re-addressed to the app's own origin ("update tasks"). */
  firestoreOperation?: string;
}

/**
 * Only machine codes: letters with _ . or -, 3–48 characters, no spaces or digits. Free-text
 * messages (which can contain user data) never match, so they are never kept.
 */
const CODE = /^[A-Za-z][A-Za-z_.-]{2,47}$/;
const MAX_READ = 64 * 1024;

/** A field name as apps write them ("key", "billing.postcode"): never free text. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,47}$/;
/**
 * The field a failed reply blames, in the shapes apps use: { error: { field | param | path } },
 * { errors: [{ field | param | path | loc }] } (Zod, FastAPI), or { errors: { key: [...] } } (Rails).
 */
export function fieldOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const pick = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const r = o as Record<string, unknown>;
    for (const v of [r.field, r.param, r.path, r.loc]) {
      const last = Array.isArray(v) ? [...v].reverse().find((x) => typeof x === "string") : v;
      if (typeof last === "string" && FIELD.test(last)) return last;
    }
    return undefined;
  };
  if (Array.isArray(b.errors)) return pick(b.errors[0]);
  if (b.errors && typeof b.errors === "object") {
    const first = Object.keys(b.errors)[0];
    return first && FIELD.test(first) ? first : undefined;
  }
  return pick(b.error) ?? pick(b);
}

/** Why the app says a request failed, from its JSON reply: a code and/or a GraphQL failure flag. */
export function failureOf(body: unknown): { appFailed?: boolean; errorCode?: string } {
  if (Array.isArray(body)) return failureOf(body.find((x) => x && typeof x === "object" && "error" in x));
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const code = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : undefined);
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    const first = (b.errors[0] ?? {}) as { message?: unknown; extensions?: { code?: unknown } };
    const c = code(first.extensions?.code) ?? code(first.message);
    return { appFailed: true, ...(c ? { errorCode: c } : {}) };
  }
  const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>).code : undefined;
  // tRPC: { error: { json: { data: { code: "BAD_REQUEST" } } } }, or a batch of those.
  const trpc = (b.error as { json?: { data?: { code?: unknown } } } | undefined)?.json?.data?.code;
  const c = code(b.error) ?? code(nested) ?? code(trpc) ?? code(b.code);
  return c ? { errorCode: c } : {};
}

/**
 * A reply's text, or undefined once it passes `max` bytes: reading stops there and the copy is
 * cancelled, so a long stream (an AI chat's reply) is never buffered.
 */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Only small JSON replies are read: for a failure, why; for a success, the shape of what came back. */
function worthReading(status: number, contentType: string | null, length: string | null): boolean {
  if (!contentType?.includes("json")) return false;
  if (length && Number(length) > MAX_READ) return false;
  return status >= 200;
}

/** What a reply tells us: why it failed, or (when it worked) the shape of what it gave back. */
export function readReply(status: number, body: unknown): { appFailed?: boolean; errorCode?: string; errorField?: string; result?: Record<string, FieldShape> } {
  const failure = failureOf(body);
  if (status >= 300 || failure.appFailed) {
    const field = fieldOf(body);
    return field ? { ...failure, errorField: field } : failure;
  }
  const result = describeResult(body);
  return Object.keys(result).length ? { ...failure, result } : failure;
}

/**
 * A framework fetching the next page's data (Next.js and the like, when a link is hovered or
 * followed): page plumbing, not something a person did.
 */
export function isPagePrefetch(input: unknown, init?: RequestInit): boolean {
  const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
  if (headers.has("rsc") || headers.has("next-router-prefetch") || headers.has("next-router-state-tree") || headers.get("purpose") === "prefetch") return true;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string } | undefined)?.url ?? "";
  return /[?&]_rsc=/.test(url);
}

export type RequestListener = (request: RawRequest) => void;

type Fetch = typeof fetch;

const XHR_META = new WeakMap<XMLHttpRequest, { method: string; url: string; start: number }>();

export function installNetworkCapture(win: Window & typeof globalThis, onRequest: RequestListener, ignore: (url: string) => boolean): () => void {
  const uninstalls: (() => void)[] = [];
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  // ---- fetch ----
  const originalFetch: Fetch | undefined = win.fetch;
  if (typeof originalFetch === "function") {
    const wrapped = function (this: unknown, ...args: Parameters<Fetch>): ReturnType<Fetch> {
      const meta = run(() => describeFetch(args[0], args[1]));
      const start = now();
      const result = originalFetch.apply(this, args);
      if (meta && !ignore(meta.url) && !run(() => isPagePrefetch(args[0], args[1]))) {
        run(() => {
          result.then(
            (res) => {
              const durationMs = now() - start;
              const report = (extra: ReturnType<typeof readReply> = {}) => run(() => onRequest({ ...meta, status: res.status, durationMs, ...extra }));
              if (!run(() => worthReading(res.status, res.headers.get("content-type"), res.headers.get("content-length")))) return report();
              // A copy of the reply, so the app's own read is untouched. Large replies are not parsed.
              readCapped(res.clone(), MAX_READ).then((text) => report((text !== undefined ? run(() => readReply(res.status, JSON.parse(text))) : undefined) ?? {}), () => report());
            },
            () => run(() => onRequest({ ...meta, status: 0, durationMs: now() - start })),
          );
        });
      }
      return result;
    };
    win.fetch = wrapped as Fetch;
    uninstalls.push(() => {
      if (win.fetch === wrapped) win.fetch = originalFetch;
    });
  }

  // ---- XMLHttpRequest ----
  const proto = win.XMLHttpRequest?.prototype;
  if (proto) {
    const originalOpen = proto.open;
    const originalSend = proto.send;

    const open = function (this: XMLHttpRequest, ...args: unknown[]) {
      run(() => {
        const [method, url] = args;
        XHR_META.set(this, { method: String(method).toUpperCase(), url: String(url), start: 0 });
      });
      return (originalOpen as (...a: unknown[]) => void).apply(this, args);
    };

    const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      run(() => {
        const meta = XHR_META.get(this);
        if (!meta || ignore(meta.url)) return;
        meta.start = now();
        this.addEventListener("loadend", () =>
          run(() => {
            // The failure reason is optional: if reading it fails, the request is still reported.
            const extra =
              run((): ReturnType<typeof readReply> => {
                if (!worthReading(this.status, this.getResponseHeader("content-type"), this.getResponseHeader("content-length"))) return {};
                const text = this.responseType === "" || this.responseType === "text" ? this.responseText : undefined;
                const json = this.responseType === "json" ? (this.response as unknown) : text && text.length <= MAX_READ ? JSON.parse(text) : undefined;
                return readReply(this.status, json);
              }) ?? {};
            onRequest({ method: meta.method, url: meta.url, body, status: this.status, durationMs: now() - meta.start, ...extra });
          }),
        );
      });
      return originalSend.call(this, body);
    };

    proto.open = open as XMLHttpRequest["open"];
    proto.send = send;
    uninstalls.push(() => {
      if (proto.open === open) proto.open = originalOpen;
      if (proto.send === send) proto.send = originalSend;
    });
  }

  return () => uninstalls.forEach((u) => run(u));
}

function describeFetch(input: unknown, init: RequestInit | undefined): { method: string; url: string; body: unknown; nextAction?: string } {
  let url: string;
  let method = "GET";
  let headers: HeadersInit | undefined;
  if (typeof Request !== "undefined" && input instanceof Request) {
    url = input.url;
    method = input.method;
    headers = input.headers;
  } else {
    url = String(input);
  }
  if (init?.method) method = init.method;
  if (init?.headers) headers = init.headers;
  const nextAction = headerOf(headers, "next-action");
  // Request bodies are streams; we never read them. Only init.body is inspected.
  return { method: method.toUpperCase(), url, body: init?.body, ...(nextAction && /^[0-9a-f]{8,}$/i.test(nextAction) ? { nextAction: nextAction.slice(0, 16).toLowerCase() } : {}) };
}

function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return entries.find(([k]) => k.toLowerCase() === name)?.[1];
}
