/**
 * Codes and links by email (AUTH C6, C8): one way to ask an inbox "wait for a message to <address>
 * that arrived after <time>", and our own code, never the AI, to find the code or the link in it.
 *
 *   - A code is 4 to 8 digits, or 6 to 8 capital letters and digits, near the words code,
 *     verification, one-time, OTP or passcode. A link is one on a host this test may open whose path
 *     or query reads like a sign-in, verify, magic, reset, invite or callback link.
 *   - Two candidates, or none, is "not sure": a code is never guessed.
 *   - Only messages that arrived after the send count, and each is used once, then deleted.
 *   - No message while the inbox answered every time is "not received" (the app didn't send: a FAIL);
 *     an inbox that didn't answer is "down" (BLOCKED: nothing can be said about the app).
 *
 * Tier A only: a mail catcher on this machine with Mailpit's API (Mailpit itself, or the one the
 * Supabase CLI bundles). A catcher anywhere else is refused: a hosted inbox is a cost decision (D3).
 * The body of a message never reaches the AI, a log or a report.
 */

export interface InboxMessage {
  id: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** When the inbox got it, ms since 1970. */
  created: number;
}

export type Found = { code: string } | { link: string } | { notSure: string };

/** Words a code stands near in a message. */
const CODE_WORDS = /\b(codes?|verification|verify|one[- ]?time|otp|passcode|pass code|security code|sign[- ]?in code|login code)\b/gi;
/** How far from those words a code may be, in characters. */
const NEAR = 80;
/** A link's path or query that reads like signing in, confirming or being invited. */
const LINK_WORDS = /(token|verify|verification|magic|reset|invite|invitation|callback|confirm|sign[-_]?in|signin|login|log[-_]?in|auth|otp|ticket|oobcode|code=)/i;

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

/** A message's words as a person reads them: its text part, or its HTML with the tags taken out. */
function wordsOf(m: Pick<InboxMessage, "text" | "html" | "subject">): string {
  const body = m.text.trim() ? m.text : decodeEntities(m.html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "));
  return `${m.subject}\n${body}`;
}

/** Every address a message links to: its HTML's hrefs and the addresses written in its words. */
function linksOf(m: Pick<InboxMessage, "text" | "html">): string[] {
  const out = new Set<string>();
  for (const h of m.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) out.add(decodeEntities(h[1]!).trim());
  for (const t of `${m.text}\n${decodeEntities(m.html)}`.matchAll(/\bhttps?:\/\/[^\s"'<>)\]]+/gi)) out.add(t[0].replace(/[.,;:!?]+$/, ""));
  return [...out];
}

/** A host (with its port) that counts as on this machine: http is taken for these only. */
export const isLocalHost = (hostname: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i.test(hostname) || /\.(localhost|test)$/i.test(hostname);

/** Whether a link's host is one this test may open: the same host and port, or a host named without a port. */
export function linkHostAllowed(link: string, allowedHosts: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) return false;
  return allowedHosts.some((a) => {
    const allowed = a.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return allowed.includes(":") ? u.host.toLowerCase() === allowed : u.hostname.toLowerCase() === allowed;
  });
}

/** The one code in a message, or "not sure" (none, or more than one): never a guess. */
export function findCode(m: Pick<InboxMessage, "text" | "html" | "subject">): Found {
  // Addresses hold digits that are no code: taken out first.
  const words = wordsOf(m).replace(/\bhttps?:\/\/\S+/gi, " ");
  const found = new Set<string>();
  for (const k of words.matchAll(CODE_WORDS)) {
    const from = Math.max(0, k.index! - NEAR);
    let near = words.slice(from, k.index! + k[0].length + NEAR);
    // A phone number near the code ("+1 201-555-0100", "555-0100") is a candidate all the same: it
    // makes the message not sure, never a code. Then "123 456" or "123-456" is one code; then 4 to 8 digits.
    near = near.replace(/(?<![\w])\+?\d[\d ().-]{6,}\d(?![\w])|(?<![\w-])\d{3}[-.]\d{4}(?![\w-])/g, (p) => {
      const digits = p.replace(/\D/g, "");
      if (digits.length >= 7 && /[ ().-]/.test(p) && !/^\d{3}[ -]\d{3}$/.test(p.trim()) && !/^\d{4}[ -]\d{4}$/.test(p.trim())) {
        found.add(`phone:${digits}`);
        return " ";
      }
      return p;
    });
    for (const d of near.matchAll(/(?<![\w-])(\d{3}[ -]\d{3}|\d{4}[ -]\d{4})(?![\w-])/g)) found.add(d[1]!.replace(/\D/g, ""));
    near = near.replace(/(?<![\w-])(\d{3}[ -]\d{3}|\d{4}[ -]\d{4})(?![\w-])/g, " ");
    for (const d of near.matchAll(/(?<![\w.,-])(\d{4,8})(?![\w-]|[.,]\d)/g)) found.add(d[1]!);
    for (const a of near.matchAll(/(?<![\w-])([A-Z0-9]{6,8})(?![\w-])/g)) if (/\d/.test(a[1]!) && /[A-Z]/.test(a[1]!)) found.add(a[1]!);
  }
  const codes = [...found];
  if (codes.length === 1 && !codes[0]!.startsWith("phone:")) return { code: codes[0]! };
  if (!codes.length) return { notSure: "no code was found in the message" };
  return { notSure: `the message holds ${codes.length} things that could be the code` };
}

/** The one sign-in link in a message on a host this test may open, or "not sure": never a guess. */
export function findLink(m: Pick<InboxMessage, "text" | "html">, allowedHosts: readonly string[]): Found {
  const likely = linksOf(m).filter((l) => {
    try {
      const u = new URL(l);
      return (u.protocol === "https:" || u.protocol === "http:") && LINK_WORDS.test(`${u.pathname}${u.search}`);
    } catch {
      return false;
    }
  });
  const ours = [...new Set(likely.filter((l) => linkHostAllowed(l, allowedHosts)))];
  if (ours.length === 1) return { link: ours[0]! };
  if (ours.length > 1) return { notSure: `the message holds ${ours.length} links that could be the sign-in link` };
  if (likely.length) {
    let host = "";
    try {
      host = new URL(likely[0]!).host;
    } catch {
      // not an address
    }
    return { notSure: `the message's link goes to ${host || "another host"}, which this test may not open (add --allow-host if it is the site's own)` };
  }
  return { notSure: "no sign-in link was found in the message" };
}

/** An inbox to read: tier A, a mail catcher on this machine. */
export interface Inbox {
  /** Said to the person: "the mail catcher at 127.0.0.1:8025". */
  where: string;
  /** The messages to this address, or why the inbox didn't answer. */
  list(to: string): Promise<{ ok: true; messages: InboxMessage[] } | { ok: false; why: string }>;
  /** Deletes used messages (best effort). */
  remove(ids: string[]): Promise<void>;
}

/** Why a catcher's address can't be used, or nothing: it must be on this machine (tier A). */
export function catcherProblem(address: string): string | undefined {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return `"${address.slice(0, 60)}" isn't an address`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "a mail catcher's address starts with http:// or https://";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) return `a mail catcher must be on this machine (127.0.0.1, localhost or [::1]), not ${u.hostname}: a hosted inbox isn't built (it would cost money, D3)`;
  if (u.username || u.password) return "a mail catcher's address holds no user name or password";
  return undefined;
}

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const addresses = (v: unknown): string[] => (Array.isArray(v) ? v.map((a) => (isObj(a) && typeof a.Address === "string" ? a.Address : "")).filter(Boolean) : []);

/**
 * A Mailpit-API catcher (Mailpit's own, or the Supabase CLI's since v2.108.0):
 * GET /api/v1/search?query=to:"…", GET /api/v1/message/{ID}, DELETE /api/v1/messages {IDs}.
 */
export function mailpitInbox(base: string, o: { fetch?: Fetch; timeoutMs?: number } = {}): Inbox {
  const problem = catcherProblem(base);
  if (problem) throw new Error(problem);
  const root = base.replace(/\/+$/, "");
  const f: Fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const timeoutMs = o.timeoutMs ?? 5000;
  const get = async (path: string): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(`${root}${path}`, { signal: ctl.signal, headers: { accept: "application/json" } });
      if (!r.ok) return { ok: false, why: `the mail catcher answered ${r.status}` };
      return { ok: true, body: await r.json() };
    } catch (error) {
      return { ok: false, why: ctl.signal.aborted ? "the mail catcher didn't answer in time" : `the mail catcher can't be reached (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 80) : "no answer"})` };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    where: `the mail catcher at ${new URL(root).host}`,
    async list(to) {
      const found = await get(`/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      if (!found.ok) return found;
      const summaries = isObj(found.body) && Array.isArray(found.body.messages) ? found.body.messages : [];
      const messages: InboxMessage[] = [];
      for (const s of summaries.slice(0, 20)) {
        if (!isObj(s) || typeof s.ID !== "string" || !/^[\w-]{1,80}$/.test(s.ID)) continue;
        const one = await get(`/api/v1/message/${s.ID}`);
        if (!one.ok) return one;
        const m = one.body;
        if (!isObj(m)) continue;
        const created = Date.parse(String(m.Date ?? s.Created ?? ""));
        messages.push({ id: s.ID, to: addresses(m.To ?? s.To), subject: String(m.Subject ?? s.Subject ?? ""), text: String(m.Text ?? ""), html: String(m.HTML ?? ""), created: Number.isFinite(created) ? created : 0 });
      }
      return { ok: true, messages };
    },
    async remove(ids) {
      if (!ids.length) return;
      try {
        await f(`${root}/api/v1/messages`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
      } catch {
        // left in the catcher: never read again in this run (used IDs are kept)
      }
    },
  };
}

export type Waited =
  | { code: string; id: string }
  | { link: string; id: string }
  | { notSure: string; subject: string }
  | { notReceived: string }
  | { down: string };

export interface WaitOptions {
  to: string;
  /** Only messages that arrived at or after this (ms since 1970): the send. */
  since: number;
  want: "code" | "link";
  /** Hosts a link may be on: the site's own, and --allow-host. */
  allowedHosts?: readonly string[];
  /** Messages already used in this run: never read again. */
  used?: Set<string>;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How long to wait for a message, at most, and how often to look. */
export const INBOX_WAIT_MS = 60_000;
export const INBOX_POLL_MS = 1000;
/** Looks in a row the inbox may fail before it is said to be down. */
const DOWN_AFTER = 3;

/**
 * Waits for the first message to `to` that arrived after `since`, and finds the code or the link in
 * it. Used once: it is deleted from the catcher and remembered as used.
 */
export async function waitForMessage(inbox: Inbox, o: WaitOptions): Promise<Waited> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const until = now() + (o.timeoutMs ?? INBOX_WAIT_MS);
  const used = o.used ?? new Set<string>();
  const to = o.to.trim().toLowerCase();
  let failedInARow = 0;
  let everFailed: string | undefined;
  for (;;) {
    if (o.signal?.aborted) return { down: "stopped by you" };
    const r = await inbox.list(to);
    if (!r.ok) {
      everFailed = r.why;
      if (++failedInARow >= DOWN_AFTER) return { down: `${r.why}, so no code or link could be read (${inbox.where})` };
    } else {
      failedInARow = 0;
      const fresh = r.messages
        .filter((m) => !used.has(m.id) && m.created >= o.since && (m.to.length === 0 || m.to.some((a) => a.trim().toLowerCase() === to)))
        .sort((a, b) => a.created - b.created);
      const m = fresh[0];
      if (m) {
        used.add(m.id);
        await inbox.remove([m.id]);
        const found = o.want === "code" ? findCode(m) : findLink(m, o.allowedHosts ?? []);
        if ("code" in found) return { code: found.code, id: m.id };
        if ("link" in found) return { link: found.link, id: m.id };
        return { notSure: found.notSure, subject: m.subject.slice(0, 120) };
      }
    }
    if (now() >= until) {
      return everFailed
        ? { down: `${everFailed} at times while waiting, so a missing message can't be blamed on the app (${inbox.where})` }
        : { notReceived: `no message to that address reached ${inbox.where} within ${Math.round((o.timeoutMs ?? INBOX_WAIT_MS) / 1000)} s of the send, and it answered every time` };
    }
    await sleep(Math.min(o.pollMs ?? INBOX_POLL_MS, Math.max(0, until - now())));
  }
}
