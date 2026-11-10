import { statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Browser, Page } from "playwright";
import type { JourneyHints } from "./journeys.ts";

/**
 * The stand-in user: a second pass over a local app with the browser told it has a signed-in user,
 * and with no path from that browser to anything real. No server ever sees the made-up session.
 *
 * It works because a client-rendered app decides who is signed in by reading the browser's own
 * storage, and fetches its data from the browser. So two things make the signed-in product draw:
 * the auth library's storage read is answered with a made-up session, and every data call is
 * answered here. Everything is built around the seal that makes this safe (see Seal.judge), and
 * the seal is an allow rule with no exception in the browser: that browser can reach nothing at
 * all, the dev server included. Node reads the files it can show to be files and hands them over,
 * and every address gets the one document the app sends for all of them, so no page address, proxy
 * or cookie is ever involved. A way out the rules can't see has nowhere to go.
 *
 * What this proves: how the screens are built, what they ask for and what a press would send. What
 * it can't: anything that follows from an answer, since all of them are ours. So a run like this
 * gives no findings, and what it shows is marked (see seenWith in scan.ts).
 */

export interface StandInConfig {
  /** Addresses to try behind the sign-in, as paths ("/trades") on the start's address, ahead of any links found. */
  addresses?: string[];
  /**
   * Those of `addresses` that are only a try: opened in the sealed browser, but nothing outside this
   * pass stands behind them, so the server is never asked about one (see Seal.documentFor). Being
   * spelled in the code, or met on a made-up screen, shows nothing of what a GET there would do.
   */
  tryOnly?: string[];
  /** Which sign-in library the app uses ("supabase"), when known. Otherwise it's told from what the app does as it runs. */
  provider?: string;
  /** The key the library keeps its session under, when the app chose its own. */
  storageKey?: string;
  /**
   * Made-up rows, so screens show more than their empty state: by table ("trades": [...]), by
   * function ("rpc/summary": [...]), or by address ("/api/plan" or "GET /api/plan": any JSON value).
   * Anything not named gets an empty result.
   */
  rows?: Record<string, unknown>;
  /**
   * What's still being worked out, so the browser needn't wait for an AI before it can do what needs
   * none of it: the new-account walk goes on at once, and the pass with rows waits for this. What it
   * gives replaces `addresses` and `rows`, under a new seal; undefined leaves them as they are.
   */
  later?: Promise<(Pick<StandInConfig, "addresses" | "rows"> & { journeyHints?: JourneyHints }) | undefined>;
  /**
   * Only addresses to try, for the new-account walk, and not known to be anything: an empty account
   * finds few links of its own. Unlike `addresses` they say nothing about who draws what, and they're
   * never read (see tryOnly). They come from the source, so a run with no yes to reading it has none.
   */
  walkAddresses?: string[];
  /**
   * Addresses of the first run (onboarding, a welcome), as the code names them, for the new-account
   * walk, and only tried, as walkAddresses are. Addresses above whose names say so are tried as well.
   */
  firstRun?: string[];
  /**
   * The code reads fields of the signed-in user that a real account filled in at sign-up, and this
   * made-up one has blank, or the code couldn't be looked at. Then "Hello, undefined" may be this
   * run's doing, so a hole on a stand-in screen proves nothing.
   */
  sessionFieldsBlank?: boolean;
  /** Screens this pass may add (default: the run's maxPages). */
  maxPages?: number;
  /** Time this pass may take, on top of the public crawl (default: the run's maxDurationMs). */
  maxDurationMs?: number;
  /** The app's folder, when known: what's really in it (or its public folder) is a file, whatever its address looks like. */
  folder?: string;
  /** Address prefixes the dev server hands on to another server ("/backend"), or "*" when it hands on all it doesn't have itself. */
  proxied?: string[];
}

export type StandInStatus =
  /** Signed-in screens drew, and are in the result. */
  | "reached"
  /** Not run: the run is on a real session or lets saves through, or the address isn't local. */
  | "refused"
  /** Not run: the public crawl was stopped or never reached the site. */
  | "skipped"
  /** Not run on the app: the seal couldn't be put in place. Nothing of the stand-in pass reached the site. */
  | "seal_failed"
  /** Nothing the app did matched a sign-in library the stand-in knows. Nothing from the pass is in the result. */
  | "no_adapter"
  /** The server decides what these addresses show, so the browser can't stand in. Nothing from the pass is in the result. */
  | "server_auth"
  /** The library was found, but the app never took the session, or no screen past the public ones drew. Nothing from the pass is in the result. */
  | "not_rendered"
  /** Not run: the app's own document couldn't be read, so nothing shows who decides what its addresses show. */
  | "not_checked"
  /** Something drew, but nothing shows it's a screen of the product (see Seal.sort). Nothing from the pass is in the result. */
  | "not_shown";

export interface NotReached {
  path: string;
  /**
   * sign_in: still the sign-in screen. no_access: the app itself said no (an email-checked staff page).
   * blank: nothing drew. sent_away: moved on to a public screen. error_page: the page came back an
   * error. not_a_page: an address the seal won't load (an API's, another host's, or one with a
   * placeholder such as :id). server_page: the server drew this one itself, so what it shows isn't
   * the app's answer to the stand-in. paywall: the app asks for payment first. failed: the app's own
   * error screen. loading: it never finished. unclear: it drew what another address drew, or what
   * the app draws for an address that can't exist, so nothing shows it's a screen of its own.
   * not_shown: it drew something, with nothing to tell that from a wall of a kind not known here.
   * not_checked: the server's answer for it couldn't be read.
   */
  why: "sign_in" | "no_access" | "blank" | "sent_away" | "error_page" | "not_a_page" | "server_page" | "paywall" | "failed" | "loading" | "unclear" | "not_shown" | "not_checked";
}

export interface StandInReport {
  status: StandInStatus;
  /** One plain sentence on what happened, for the CLI to print. Never says anyone signed in. */
  message: string;
  /** The sign-in library it stood in for. */
  provider?: string;
  /** Screens seen only as the stand-in, all with made-up data. */
  reached: string[];
  notReached: NotReached[];
  /** Data addresses the screens asked for, with no values ("GET /rest/v1/trades"): what sample rows would help. */
  asked: string[];
  /** What went wrong during the pass. */
  errors: string[];
  /** How the pass itself ended: one cut short at a limit may have missed screens it would have reached. */
  stoppedBy?: "complete" | "max_pages" | "max_duration" | "interrupted";
  /** Made-up values were really drawn, on a screen shown to be one. Empty screens show a page drew, not that it was the product's real working screen. */
  rowsShown?: boolean;
}

/** What the seal is asked about: one request, as the browser is about to send it. */
export interface Asked {
  method: string;
  type: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | undefined;
  /** A frame inside a page, not the page itself. */
  inFrame?: boolean;
  /** A window of its own that the page opened. */
  popUp?: boolean;
}

export interface Reply {
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * What a press set off, as a sealed walk needs to know it: the way out it tried, whatever its label
 * said. payment, email, third_party, leaves_site, account, sign_out, destroys: see StopKind in journeys.ts. file: a
 * file chooser opened. save: a write answered here. kept: one that stayed, so reads show it (see Seal.keepSaves).
 */
export type TrailKind = "payment" | "email" | "third_party" | "leaves_site" | "account" | "sign_out" | "destroys" | "file" | "save" | "kept";

/** One thing on the trail: what kind, and where it was going, with no body or query. */
export interface Trail {
  kind: TrailKind;
  where: string;
}

export type SealVerdict =
  /** A file of the local dev server: Node reads it and hands it over (and the read-only rule still has its say). */
  | { act: "file" }
  /** A page of the app: answered with the one document every address gets. */
  | { act: "shell" }
  /** Goes nowhere, and isn't answered. */
  | { act: "refuse" }
  /** Answered here. Reads and a library's own upkeep: nobody's action. */
  | { act: "answer"; reply: Reply }
  /** A write: answered here and learned as a stopped save, with this reply if it has its own. */
  | { act: "save"; reply?: Reply };

/** One sign-in library the stand-in knows: where it keeps its session, and how its server answers. */
export interface Adapter {
  name: string;
  /** Storage keys it reads its session from, as a regular expression's source. */
  sessionKey: string;
  /** The made-up session, as the library keeps it. With newAccount, an account made a moment ago. */
  session(now: number, newAccount?: boolean): string;
  /** Whether a request shows this library at work, whichever host it goes to. */
  seenIn(url: URL): boolean;
  /**
   * Its server's answer, or undefined for one it has no special answer to. Filled says the answer
   * held made-up rows. Plain says the answer is in the very shape the real server would give for
   * an account with nothing in it, so what an app draws from it is the app's own doing.
   */
  answer(r: Asked, rows: Rows, newAccount?: boolean, kept?: Rows[]): { reply: Reply; quiet?: boolean; filled?: boolean; plain?: boolean } | undefined;
  /**
   * Takes a write into `rows`, so what's read next shows it, and says which rows that left. Undefined
   * when this write can't be kept: what follows it is then unknown, never a thing that didn't happen.
   */
  keep?(r: Asked, rows: Rows, nextId: () => string): Rows[] | undefined;
}

type Rows = Record<string, unknown>;

/** How old a new account is: long enough to have got through the sign-up, and no more. */
const NEW_ACCOUNT_AGE_MS = 60_000;

export const STAND_IN_USER_ID = "00000000-0000-4000-8000-000000000001";
/** An address that can't belong to anyone, and that no staff check by email will pass. */
export const STAND_IN_EMAIL = "stand-in@example.test";
const DAY_S = 86_400;

const json = (value: unknown, status = 200, headers?: Record<string, string>): Reply => ({ status, contentType: "application/json", body: JSON.stringify(value), ...(headers ? { headers } : {}) });
const noBody = (status: number): Reply => ({ status });

/** A token that looks like one and proves nothing: unsigned, and seen only by the browser it was made for. */
function madeUpToken(now: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const seconds = Math.floor(now / 1000);
  return `${part({ alg: "none", typ: "JWT" })}.${part({ sub: STAND_IN_USER_ID, role: "authenticated", aud: "authenticated", email: STAND_IN_EMAIL, iat: seconds, exp: seconds + DAY_S })}.stand-in`;
}

/** Filled in the way a real account is: apps turn away a user with no confirmed email. */
const supabaseUser = (newAccount?: boolean) => {
  // An app telling a new account from an old one goes by when it was made.
  const madeAt = newAccount ? new Date(Date.now() - NEW_ACCOUNT_AGE_MS).toISOString() : "2025-01-01T00:00:00Z";
  return {
    id: STAND_IN_USER_ID, aud: "authenticated", role: "authenticated", email: STAND_IN_EMAIL, phone: "",
    email_confirmed_at: madeAt, confirmed_at: madeAt, last_sign_in_at: madeAt,
    created_at: madeAt, updated_at: madeAt, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [],
  };
};

const supabaseSession = (now: number, newAccount?: boolean) => ({
  access_token: madeUpToken(now), refresh_token: "stand-in", token_type: "bearer", expires_in: DAY_S, expires_at: Math.floor(now / 1000) + DAY_S, user: supabaseUser(newAccount),
});

/** Query keys of a PostgREST read that aren't filters. */
const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

/**
 * The rows a PostgREST read would get. Equal-to filters are honoured, so asking for one record by id
 * finds it; one on the stand-in's own id isn't, as sample rows can't know it.
 */
function chosenRows(rows: unknown[], url: URL): unknown[] {
  let chosen = rows;
  for (const [key, value] of url.searchParams) {
    const equal = /^eq\.(.*)$/.exec(value)?.[1];
    if (NOT_FILTERS.has(key) || equal === undefined || equal === STAND_IN_USER_ID) continue;
    chosen = chosen.filter((row) => typeof row !== "object" || row === null || !(key in row) || String((row as Rows)[key]) === equal);
  }
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  const limit = Number(url.searchParams.get("limit") ?? chosen.length);
  return chosen.slice(offset, offset + (Number.isFinite(limit) ? limit : chosen.length));
}

/** A PostgREST read, in the shape the client checks for: one object for .single(), a count in content-range. */
function restRead(r: Asked, table: string, rows: Rows): Reply {
  const given = rows[table];
  const all = Array.isArray(given) ? given : given === undefined ? [] : [given];
  const chosen = chosenRows(all, r.url);
  if (/vnd\.pgrst\.object/.test(r.headers.accept ?? "")) {
    return chosen.length === 1 ? json(chosen[0]) : json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${chosen.length} rows`, hint: null }, 406);
  }
  const offset = Number(r.url.searchParams.get("offset") ?? 0) || 0;
  const range = chosen.length > 0 ? `${offset}-${offset + chosen.length - 1}/${all.length}` : `*/${all.length}`;
  const headers = { "content-range": range, "access-control-expose-headers": "content-range" };
  return r.method === "HEAD" ? { status: 200, headers } : json(chosen, 200, headers);
}

/** The equal-to filters of a PostgREST write: what says which rows it's about. */
/** Names a list of rows can't go by: from the page's own address, they'd reach the language's own objects. */
const NOT_A_TABLE = /^(?:__proto__|constructor|prototype)$/;

/** A row's fields set from what a page sent: a key a page chose never sets anything but a field. */
function setFields(row: Rows, sent: Rows | undefined): Rows {
  for (const [key, value] of Object.entries(sent ?? {})) if (key !== "__proto__") row[key] = value;
  return row;
}

const equalFilters = (url: URL) => [...url.searchParams].flatMap(([key, value]) => {
  const equal = /^eq\.(.*)$/.exec(value)?.[1];
  return !NOT_FILTERS.has(key) && equal !== undefined ? [[key, equal] as const] : [];
});

/**
 * A PostgREST write taken into the rows, as far as a list of plain rows can follow one: an insert
 * gets an id no other row has (the "1" of restWrite would make two rows one), an upsert finds the row
 * by its conflict keys, an update by its filters and a delete takes rows out. An update that matches
 * nothing makes the row, as a real account's row was there from sign-up and this one's wasn't.
 */
function restKeep(r: Asked, table: string, rows: Rows, nextId: () => string): Rows[] | undefined {
  if (NOT_A_TABLE.test(table)) return undefined;
  const given = rows[table];
  const list = (Array.isArray(given) ? given : given === undefined ? [] : [given]) as Rows[];
  const filters = equalFilters(r.url);
  const matches = (row: Rows) => filters.every(([key, value]) => String(row[key]) === value || (value === STAND_IN_USER_ID && !(key in row)));
  if (r.method === "DELETE") {
    for (const row of list.filter(matches)) list.splice(list.indexOf(row), 1);
    rows[table] = list;
    return [];
  }
  let sent: unknown;
  try { sent = JSON.parse(r.body ?? "{}"); } catch { return undefined; }
  if (sent === null || typeof sent !== "object") return undefined;
  const records = (Array.isArray(sent) ? sent : [sent]) as Rows[];
  const touched: Rows[] = [];
  if (r.method === "POST") {
    const merges = /resolution=merge-duplicates/.test(r.headers.prefer ?? "");
    const keys = r.url.searchParams.get("on_conflict")?.split(",") ?? ["id"];
    for (const record of records) {
      const had = merges ? list.find((row) => keys.every((key) => record[key] !== undefined && String(row[key]) === String(record[key]))) : undefined;
      const row = had ? setFields(had, record) : { id: nextId(), ...record };
      if (!had) list.push(row);
      touched.push(row);
    }
  } else if (r.method === "PATCH") {
    const found = filters.length ? list.filter(matches) : list;
    for (const row of found) touched.push(setFields(row, records[0]));
    if (!found.length) {
      const made = { id: nextId(), ...Object.fromEntries(filters), ...records[0] };
      list.push(made);
      touched.push(made);
    }
  } else return undefined;
  rows[table] = list;
  return touched;
}

/** A PostgREST write, stopped: what the client asked to get back, as if it had saved. */
function restWrite(r: Asked, kept?: Rows[]): Reply {
  const created = r.method === "POST";
  if (!/return=representation/.test(r.headers.prefer ?? "")) return noBody(created ? 201 : 204);
  let sent: unknown = {};
  try { sent = JSON.parse(r.body ?? "{}"); } catch { /* kept as an empty record */ }
  const rows = kept ?? (Array.isArray(sent) ? sent : [sent]).map((row) => ({ id: "1", ...(row as Rows) }));
  return json(/vnd\.pgrst\.object/.test(r.headers.accept ?? "") ? rows[0] : rows, created ? 201 : 200);
}

/** Where what a save to the signed-in user changed is kept: no table has a slash in its name, and no address starts without one. */
const SAVED_USER = "auth/v1/user";

const supabase: Adapter = {
  name: "supabase",
  // supabase-js's default key. The library's other keys (-code-verifier, -user) are left alone.
  sessionKey: "^sb-.+-auth-token$",
  session: (now, newAccount) => JSON.stringify(supabaseSession(now, newAccount)),
  seenIn: (url) => /^\/(auth|rest)\/v1\//.test(url.pathname),
  keep(r, rows, nextId) {
    const path = r.url.pathname;
    if (path === "/auth/v1/user" && r.method === "PUT") {
      try {
        const saved = { ...(rows[SAVED_USER] as Rows | undefined), ...(JSON.parse(r.body ?? "{}") as { data?: Rows }).data };
        rows[SAVED_USER] = saved;
        return [saved];
      } catch {
        return undefined;
      }
    }
    if (!path.startsWith("/rest/v1/") || path.startsWith("/rest/v1/rpc/")) return undefined;
    return restKeep(r, path.slice("/rest/v1/".length), rows, nextId);
  },
  answer(r, rows, newAccount, kept) {
    const path = r.url.pathname;
    const read = r.method === "GET" || r.method === "HEAD";
    if (path === "/auth/v1/user") return { reply: json({ ...supabaseUser(newAccount), user_metadata: rows[SAVED_USER] ?? {} }), plain: true };
    if (path === "/auth/v1/token") return { reply: json(supabaseSession(Date.now(), newAccount)), quiet: true, plain: true };
    if (path === "/auth/v1/logout") return { reply: noBody(204), quiet: true, plain: true };
    if (path.startsWith("/auth/v1/")) return { reply: json({}) };
    if (!path.startsWith("/rest/v1/")) return undefined;
    const name = path.slice("/rest/v1/".length);
    if (name.startsWith("rpc/")) return { reply: json(rows[name] ?? []), filled: rows[name] !== undefined };
    const filled = read && rows[name] !== undefined;
    // An empty list is what a real server sends a new account. One record asked for and not there is a refusal an app may never see in life.
    return { reply: read ? restRead(r, name, rows) : restWrite(r, kept), filled, plain: read && !filled && !/vnd\.pgrst\.object/.test(r.headers.accept ?? "") };
  },
};

/** Adapters are added here: a new sign-in library needs its session's shape and its server's answers, and nothing else changes. */
const ADAPTERS: Adapter[] = [supabase];

/** A library named in any case is the same library. */
const adapterNamed = (name: string) => ADAPTERS.filter((a) => a.name === name.trim().toLowerCase());

/** Whether a run on this host can only reach this machine. Plain labels only: a comma or a space in a name is no local name. */
export function isLocalHost(hostname: string): boolean {
  return /^(?:(?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(hostname);
}

/** Why the stand-in may not run with this config, if it may not. A real session and a made-up one never mix. */
export function standInRefusal(config: { startUrl: string; login?: unknown; storageState?: unknown; realWrites?: boolean | undefined }): string | undefined {
  if (config.login) return "the stand-in user can't be used with --login: a real session and a made-up one never mix.";
  if (config.storageState) return "the stand-in user can't be used with --session: a real session and a made-up one never mix.";
  if (config.realWrites) return "the stand-in user can't be used with --create: saves must stay answered in the browser.";
  let url: URL;
  try {
    url = new URL(config.startUrl);
  } catch {
    return "the stand-in user needs a local address, and this isn't one.";
  }
  if (url.username || url.password) return "the stand-in user can't be used with a user name and password in the address.";
  if (!isLocalHost(url.hostname)) return "the stand-in user only runs on a local address (localhost, 127.0.0.1, ::1 or *.localhost).";
  return undefined;
}

/** Resources a page loads that can be plain files. A fetch or an XHR never is, whatever its address. */
const FILE_TYPES = new Set(["script", "stylesheet", "image", "font"]);
const CALL_TYPES = new Set(["fetch", "xhr"]);
/**
 * Addresses a dev server runs code for rather than sending a file, whatever they end in: an API
 * mounted in the dev server can hold the server's own keys, so a same-origin GET isn't harmless.
 * A file really there changes nothing: a function folder at a project's root holds .js files.
 */
const HANDLER_PATH = /^\/(?:api|graphql|gql|trpc|rest|rpc|functions|webhooks?|hooks|cron|auth|oauth)(?:\/|$)/i;
/** Files a server runs, wherever they are. */
const RUNS_CODE = /\.(?:php|aspx?|jsp|cgi)$/i;
/** What's only ever sent as it is: from a folder of static files, a picture under /auth is a picture. */
const STATIC_KIND = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf)$/i;
/** A file has a name with an extension. */
const FILE_NAME = /\.[a-z0-9]{1,8}$/i;
/** The dev server's own modules and what it built: Vite's /@vite/client, node_modules/.vite, Next's static files. */
const DEV_SERVER_FILE = /^\/(?:@|node_modules\/|_next\/static\/)/;
/** Hidden files are never the app's to load: .env is the one that matters, and no address makes it a file. */
const HIDDEN = /\/\.(?!vite\/)/;
/** Where the self-check's page and call go. Answered by the seal, so it reaches nothing. */
const CHECK_PATH = "/__ctx_seal_check__";
const CHECK_SAYS = "sealed";
/** An address no app has, in one word, so a page that repeats its address can be matched (see Seal.nowhere). */
export const NOWHERE_PATH = "/xqzstandinnowhere";
/** The stand-in's own values, in any address: what a page built from them is never sent on with. */
const MADE_UP_VALUES = new RegExp([STAND_IN_USER_ID, STAND_IN_EMAIL.replace(/\./g, "\\."), "\\.stand-in\\b", Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")].join("|"), "i");
/**
 * What a page's own code loads, by its literal name: an import, a worker, a CSS url(). A string that
 * only looks like a path isn't one, as a call to /svc/x.png reads the same. Literal is the point:
 * a name that's in what the server sent can't hold anything the page made up since.
 */
const LOADED_BY_CODE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?|\bnew\s+URL\s*\(\s*|\bimportScripts\s*\(\s*|@import\s+(?:url\(\s*)?|\burl\(\s*)["'`]?(\.{0,2}\/[^"'`)\s]+)/g;
/** What a document loads by name. Never its links: those are to pages, and any of them may be a proxy's. */
const LOADED_BY_DOCUMENT = /<(?:script|link|img|source)\b[^>]*?\b(?:src|href)=["']?([^"'\s>]+)/gi;
/** More of a file than this isn't looked through for names: it's a library, not the app's own. */
const MOST_NAMES_IN = 4_000_000;

/** Addresses of sign-in pages, for a redirect from the server that says who's signed in was decided there. */
export const SIGN_IN_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign_in|sso|session|auth)(?:\/|$)/i;

/** How long a read of a document or file may take: a dev server compiles on first ask, and that can be slow. */
const READ_MS = 30_000;

/** Saves on one journey's trail: more than any journey needs. What would stop a journey is never left off. */
const MOST_SAVES_ON_TRAIL = 1000;

/** Screens looked at with no sign of the library, before the pass gives up on it. */
const NO_ADAPTER_AFTER = 3;

/**
 * An address as a server reads it: decoded until it stops changing, so a spelling (/%2eenv, /%61pi)
 * can't get past a test on the name. Undefined for one that can't be, which nothing here loads.
 */
export function plainPath(url: URL): string | undefined {
  let path = url.pathname;
  try {
    for (let times = 0; times < 4; times++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) return path.replace(/\\/g, "/");
      path = decoded;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The declared prefix a dev proxy takes this address by, if any. Dev proxies go by the start of the
 * address and nothing more (Vite's /backend takes /backendish), so that's the test here too: a page
 * wrongly left out costs less than a request that gets out.
 */
export function proxyPrefix(proxied: readonly string[], url: URL): string | undefined {
  const path = plainPath(url) ?? url.pathname;
  return proxied.find((prefix) => prefix !== "*" && (path === prefix.replace(/\/$/, "") || path.startsWith(prefix)));
}

/** An address that holds the stand-in's own id, email or token. */
function carriesMadeUp(url: URL): boolean {
  let search = url.search;
  try { search = decodeURIComponent(search); } catch { /* tested as it is */ }
  return MADE_UP_VALUES.test(`${plainPath(url) ?? url.pathname}${search}`);
}

/** Words of an address: what a page that repeats where it is (a custom 404, say) has in common with no other. */
const addressWords = (path: string) => path.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Fewer words than this and a match says nothing: "Team" and "Trades" are not one template. */
const FEWEST_WORDS_TO_MATCH = 5;
/** Of the shorter drawing's words, how many the other must say: all but about one in twelve. */
const SAME_SHARE = 0.92;
/** One drawing this much longer than the other is a page around it, not it: a menu drawn alone is in every screen of the app. */
const MOST_LONGER = 1.5;

/** What one drawing is, for comparing with another. */
export interface Drawing {
  path: string;
  text: string;
  /** Its main heading: what an app that puts one wall under each screen's own title changes. */
  heading?: string | undefined;
}

/**
 * Whether two addresses drew one thing. What a wall changes from one address to the next is left
 * out first: the addresses' own words ("Trades isn't open to you yet"), the main heading, and
 * anything with a digit in it, as a reference or a clock is new on every drawing. What's left is
 * compared as a share of the shorter, so one more line on one of them changes nothing. Too few
 * words left is no match on those words alone: what's left of two short pages isn't evidence.
 */
export function sameDrawing(a: Drawing, b: Drawing): boolean {
  const names = new Set([...addressWords(a.path), ...addressWords(b.path)]);
  const words = (drawing: Drawing) => new Set((drawing.heading ? drawing.text.replace(drawing.heading, " ") : drawing.text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !names.has(word) && !/\p{N}/u.test(word)));
  const [one, other] = [words(a), words(b)];
  const [fewer, more] = one.size <= other.size ? [one, other] : [other, one];
  if (fewer.size < FEWEST_WORDS_TO_MATCH) return (fewer.size >= 2 && more.size === fewer.size && [...fewer].every((word) => more.has(word))) || (sameWords(a.text, b.text) && a.text.length > 0);
  return [...fewer].filter((word) => more.has(word)).length / fewer.size >= SAME_SHARE && more.size <= fewer.size * MOST_LONGER;
}

/** Whether a text says this value, as a whole word or more. */
function saysValue(text: string, value: string): boolean {
  const said = text.toLowerCase();
  const at = said.indexOf(value);
  const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
  return at >= 0 && edge(said[at - 1]) && edge(said[at + value.length]);
}

/** A page that says only where it is: an app that does that for an address it can't have does it for any. */
export function onlyItsAddress(path: string, text: string): boolean {
  const names = new Set(addressWords(path));
  return text.length > 0 && addressWords(text).every((word) => names.has(word));
}

/** What a screen drew, as the pass keeps it. */
export interface Drawn {
  href: string;
  text: string;
  /** Made-up values that went out for this screen and are in what it drew. */
  values: string[];
  /** See Wall: its main heading, its rows, its fields, and what the rows say. */
  heading?: string | undefined;
  rows?: number;
  fields?: number;
  listed?: string;
}

/** A value a page can't say by chance in a sentence of its own: more than one word, letters and digits together, an address or an amount. */
const ROW_SHAPED = /\s|\p{L}.*\p{N}|\p{N}.*\p{L}|@|\d[.,]\d/u;
/** How many values, none of them in a list, it takes: a wall can print one (a workspace's name), and a list of rows can't be one. */
const FEWEST_VALUES = 2;
/** What a working screen has and a wall doesn't: rows of something, or a form to fill in. A heading and a button are both. */
const FEWEST_ROWS = 2;
const FEWEST_FIELDS = 2;

/** What's in a reply's rows that a page could hardly say by chance: names and numbers, not flags, dates as stored, or short words. */
function madeUpWords(value: unknown, into: Set<string>, longest = 80): void {
  if (Array.isArray(value)) for (const item of value) madeUpWords(item, into, longest);
  else if (value && typeof value === "object") for (const item of Object.values(value)) madeUpWords(item, into, longest);
  else if (typeof value === "string" || typeof value === "number") {
    const said = String(value).trim().toLowerCase();
    if (said.length >= 4 && said.length <= longest && !/^(?:true|false|null)$/.test(said) && !/^https?:|^\d{4}-\d\d-\d\d/.test(said)) into.add(said);
  }
}

/** A client app's own API: what's called from the browser with a cookie of its own for a session. */
const OWN_API = /^\/(?:api|v\d+)(?:\/|$)/;
/** The call an app makes to ask who's signed in, as such apps spell it. */
const WHO_AM_I = /^\/(?:api|v\d+)(?:\/auth|\/users?|\/accounts?)?\/(?:me|whoami|session|current[-_]?user|user|profile|account)\/?$/i;
/** Words of an address that sends something out of the app, on a call no label warned of. */
const PAYS_PATH = /checkout|payment|billing-?portal|stripe|place-?order|orders?\/(?:place|confirm|submit)|(?:^|[/_.-])(?:subscribe|pay|charges?|purchase)(?:[/_.-]|$)/i;
const SENDS_PATH = /invite|(?:^|[/_-])send|e-?mail|recover|(?:^|\/)otp(?:\/|$)|magic-?link|(?:^|[/_-])(?:mail|sms|notify)(?:[/_.-]|$)/i;
const DESTROYS_PATH = /(?:^|[/_-])(?:delete|destroy|wipe|purge|erase)(?:[/_.-]|$)/i;
const SIGNS_UP_PATH = /(?:^|\/)(?:sign-?up|register)(?:\/|$)/i;
const SIGNS_OUT_PATH = /(?:^|\/)(?:log-?out|sign-?out)(?:\/|$)/i;
const OAUTH_PATH = /o?auth(?:orize)?(?:\/|$)|\/connect\//i;
/** Rows of the app's own: a table's name says what the rows are, and saving one sends nothing anywhere. */
const OWN_TABLE = /^\/rest\/v1\/(?!rpc\/)/;

/** What the seal is known by when the app's own API stands in for a sign-in library. */
const OWN_API_NAME = "the app's own API";
/** The made-up user as an API of its own may send it, on its own and as `{ user }`: nothing here reaches or is read by a server. */
const ownUser = () => {
  const user = { id: STAND_IN_USER_ID, email: STAND_IN_EMAIL, name: "Stand-in", role: "user" };
  return { ...user, user };
};

export class Seal {
  /** Set only once the self-check passed: until then, nothing of this pass goes near the site. */
  held = false;
  /** The library that was seen at work. */
  adapter: string | undefined;
  /** The library's session was read by the app, so the stand-in's session is the one in use. */
  sessionRead = false;
  readonly notReached: NotReached[] = [];
  /** The address whose document showed the server decides, during the pass. */
  serverDecided: string | undefined;
  /** The start's own document: what any address of a client-rendered app is sent (see serverDecides). */
  shell: string | undefined;
  /** Rows of made-up data that went out. */
  filled = 0;
  /** Calls this seal answered with nothing in them: what's drawn from one is the seal's doing (see ScreenReview.heldData). */
  emptied = 0;
  /** Set for the last look at each screen, when nobody is signed in. */
  signedOut = false;
  /** See StandInConfig.sessionFieldsBlank. */
  readonly sessionFieldsBlank: boolean;
  /** Answers of a shape that was a guess (see Adapter.answer): a hole drawn after one may be the guess's doing. */
  guessed = 0;
  /** Where each address opened ended up. */
  readonly landed = new Map<string, string>();
  /** What each screen drew, for telling screens apart and for looking again signed out (see Seal.sameAsSeen). */
  readonly drawn = new Map<string, Drawn>();
  /** What the app draws for an address it can't have, and where that left it (see Seal.sort). */
  nowhere: Drawing | undefined;
  /** Screens that drew the same with no session and no data: public pages, not the stand-in's. */
  readonly openToAll = new Set<string>();
  /** What the page tried, for a walk that presses (see keepSaves). No verdict depends on it. */
  readonly trail: Trail[] = [];
  readonly addresses: string[] = [];
  readonly publicScreens: Set<string>;
  private readonly seenAsked = new Set<string>();
  /** For the pass that presses: what's saved stays, so a list shows what was added, and a trail is kept. */
  private readonly keepSaves: boolean;
  /** Words of what was saved, for telling that a list drew it. */
  private readonly keptWords = new Set<string>();
  /** Words of the rows reads were answered with, since forgetServed. */
  private readonly servedWords = new Set<string>();
  private savesOnTrail = 0;
  private keptIds = 0;
  /** Whether the write being answered stayed. */
  private keptThis = false;
  /** Hosts a sign-in library was seen on: its other calls there are the app's own. */
  private readonly libraryHosts = new Set<string>();
  /** Screens another address drew the same as. */
  private readonly shared = new Set<string>();
  /** Words of the rows that went out, for telling a screen that drew them from one that drew something else. */
  private readonly sentValues = new Set<string>();
  /** The same with nothing left out for being long: what's drawn from a row, or part of it, must be told from what the app says. */
  private readonly sentWhole = new Set<string>();
  /** Addresses the server may be asked about: the public crawl's and the ones asked for by name, a mere try never. */
  private readonly vouched = new Set<string>();
  /** Files named by what the server sent, by path and by path and query (see forwarded). */
  private readonly named = new Set<string>();
  private namesRead: string | undefined;
  private readonly adapters: Adapter[];
  private readonly rows: Rows;
  private readonly newAccount: boolean;
  /** No library is named, so a client app's own API may be all the sign-in there is. */
  private readonly ownApiMayStandIn: boolean;
  private readonly origin: string;
  private readonly start: URL;
  private readonly storageKey: string | undefined;
  private readonly folder: string | undefined;
  private readonly proxied: string[];
  private readonly files = new Map<string, Promise<Served | undefined>>();
  private readonly documents = new Map<string, Promise<DocumentAnswer>>();
  private readonly readable: (url: URL) => boolean;
  private readonly background: (hostname: string) => boolean;
  private readonly graphqlRead: (body: string | undefined, contentType: string | undefined) => boolean;

  constructor(options: { start: URL; config: StandInConfig; publicScreens: Iterable<string>; opened?: Iterable<string>; background: (hostname: string) => boolean; graphqlRead: (body: string | undefined, contentType: string | undefined) => boolean; readable?: (url: URL) => boolean; newAccount?: boolean; keepSaves?: boolean }) {
    const { start, config } = options;
    this.newAccount = options.newAccount === true;
    this.keepSaves = options.keepSaves === true;
    this.sessionFieldsBlank = config.sessionFieldsBlank === true;
    this.ownApiMayStandIn = !config.provider;
    this.origin = start.origin;
    this.start = start;
    // Keyed by names from the page's addresses, so with nothing behind it: rows["__proto__"] is only ever a row.
    this.rows = Object.assign(Object.create(null) as Rows, config.rows);
    this.storageKey = config.storageKey;
    this.folder = config.folder;
    this.proxied = config.proxied ?? [];
    this.readable = options.readable ?? (() => true);
    this.adapters = config.provider ? adapterNamed(config.provider) : ADAPTERS;
    // Named by the project, it's at work whether or not the first screens happen to show it.
    if (config.provider) this.adapter = this.adapters[0]?.name;
    this.publicScreens = new Set(options.publicScreens);
    for (const path of [...this.publicScreens, ...(options.opened ?? [])]) this.vouched.add(path);
    this.background = options.background;
    this.graphqlRead = options.graphqlRead;
    const tried = new Set(config.tryOnly ?? []);
    for (const address of config.addresses ?? []) {
      let url: URL | undefined;
      try { url = new URL(address, start); } catch { /* reported below */ }
      if (url && url.origin === this.origin && !/\/:[^/]/.test(url.pathname) && this.isPage(url)) {
        this.addresses.push(url.href);
        if (!tried.has(address)) this.vouched.add(url.pathname);
      } else this.notReached.push({ path: address, why: "not_a_page" });
    }
  }

  /** The app named a library the stand-in doesn't know. */
  get unknownProvider(): boolean {
    return this.adapters.length === 0;
  }

  /** Data addresses the screens asked for, without values. */
  get asked(): string[] {
    return [...this.seenAsked];
  }

  /**
   * Below the seal, a floor, and the browser's own: every connection goes to a proxy that can't exist,
   * a name that doesn't resolve, with the exception browsers keep for this machine taken away. There
   * is no exception for the dev server either. What the page's rules are never shown (a prefetch, a
   * worklet, a request timed to go out later) so has nowhere to go, and everything the app needs
   * comes back through the route from Node (see readFile). No address goes into these, so nothing
   * typed can change their meaning.
   */
  get browserArgs(): string[] {
    return ["--host-resolver-rules=MAP * ~NOTFOUND", "--proxy-server=http://seal.invalid:1", "--proxy-bypass-list=<-loopback>"];
  }

  /** What the page's storage read is told, for the libraries in play (see answerSessionReads). */
  recipes(now = Date.now()): SessionRecipe[] {
    const named = this.storageKey?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const [first, ...rest] = this.adapters;
    if (!first) return [];
    return [
      ...(named ? [{ pattern: `^${named}$`, value: first.session(now, this.newAccount), adapter: first.name }] : []),
      ...[first, ...rest].map((a) => ({ pattern: a.sessionKey, value: a.session(now, this.newAccount), adapter: a.name })),
    ];
  }

  /** The app read the session: that's the library at work, and the stand-in in use. */
  noteSessionRead(adapter: string): void {
    if (this.adapter === undefined || this.adapter === OWN_API_NAME) this.adapter = adapter;
    this.sessionRead = true;
  }

  /** An address the server's proxy takes, as far as the project says. */
  private handedOn(url: URL): boolean {
    return proxyPrefix(this.proxied, url) !== undefined;
  }

  /** Something outside this pass stands behind this address, and the project's server may hear it. */
  vouches(path: string): boolean {
    return this.vouched.has(path);
  }

  /** Whether Node may ask the server about this address. Where the server hands on all it doesn't have, a read may go on to the real service, so none does. */
  mayAsk(url: URL): boolean {
    return this.vouches(url.pathname) && !this.proxied.includes("*");
  }

  /** The dev server's address for a page of the app: never one that runs code or goes to another server. */
  isPage(url: URL): boolean {
    const path = plainPath(url);
    return path !== undefined && !HANDLER_PATH.test(path) && !RUNS_CODE.test(path) && !this.handedOn(url) && !HIDDEN.test(path) && !carriesMadeUp(url);
  }

  /** What's in the app's folder or one of its folders of static files, as the address names it. */
  private onDisk(path: string, under: readonly string[]): boolean {
    if (!this.folder) return false;
    const inside = normalize(path);
    if (inside.split(sep).includes("..")) return false;
    return under.some((folder) => {
      try {
        return statSync(join(this.folder!, folder, inside)).isFile();
      } catch {
        return false;
      }
    });
  }

  /** Files the app's own document loads, and the folders it loads them from: where a dev server keeps files only it knows of. */
  private shellFolders(): Set<string> {
    const shell = this.shell ?? "";
    const folders = new Set<string>();
    if (this.namesRead !== shell) {
      this.namesRead = shell;
      this.noteNames(shell, new URL(this.origin));
    }
    for (const [, address] of shell.matchAll(LOADED_BY_DOCUMENT)) {
      try {
        const url = new URL(address ?? "", this.origin);
        const first = url.pathname.split("/")[1];
        if (url.origin === this.origin && first && !FILE_NAME.test(first)) folders.add(first);
      } catch { /* not an address */ }
    }
    return folders;
  }

  private noteNames(text: string, base: URL): void {
    if (text.length > MOST_NAMES_IN) return;
    for (const found of [...text.matchAll(LOADED_BY_CODE), ...text.matchAll(LOADED_BY_DOCUMENT)]) {
      try {
        const url = new URL(found[1] ?? "", base);
        if (url.origin !== this.origin) continue;
        this.named.add(url.pathname);
        if (url.search) this.named.add(url.pathname + url.search);
      } catch { /* not an address */ }
    }
  }

  /**
   * Only GET or HEAD, only the dev server's own origin, and only what can be shown to be a file. An
   * address that merely looks like one isn't enough: a dev proxy on /backend takes /backend/a.png
   * like anything else, and every project calls that folder something different. So first of all,
   * on the address as the server would read it, nothing hidden, nothing that runs code and nothing
   * of a proxy's, however real the file: then it must be the dev server's own, really in the app's
   * folder, named by what the app's own document or modules load, or in a folder the document loads
   * from. Where the project says everything else goes on to another server, only the first two count.
   */
  isFile(r: Pick<Asked, "method" | "type" | "url">): boolean {
    if ((r.method !== "GET" && r.method !== "HEAD") || !FILE_TYPES.has(r.type) || r.url.origin !== this.origin) return false;
    const path = plainPath(r.url);
    if (path === undefined || HIDDEN.test(path) || RUNS_CODE.test(path) || this.handedOn(r.url) || carriesMadeUp(r.url)) return false;
    if (STATIC_KIND.test(path) && this.onDisk(path, ["public", "static"])) return true;
    if (HANDLER_PATH.test(path)) return false;
    if (DEV_SERVER_FILE.test(path) || this.onDisk(path, ["", "public", "static"])) return true;
    if (!FILE_NAME.test(path) || this.proxied.includes("*")) return false;
    const folders = this.shellFolders();
    return this.named.has(r.url.pathname) || folders.has(path.split("/")[1] ?? "");
  }

  /**
   * The seal: this comes before every other rule, and it's an allow rule. A page of the app gets
   * the one document, a file of the dev server goes on, every fetch and XHR, same-origin too, is
   * answered here, and anything else (other hosts, beacons, media, event streams) goes nowhere. A
   * form sent by loading a page is a save, stopped like any other.
   */
  judge(r: Asked): SealVerdict {
    const verdict = this.verdictOn(r);
    if (this.keepSaves) this.noteWay(r, verdict);
    return verdict;
  }

  /** Puts one thing on the trail, with no more of the address than says where it was going. */
  note(kind: TrailKind, where: string): void {
    const onlySaves = kind === "save" || kind === "kept";
    if (onlySaves && this.savesOnTrail >= MOST_SAVES_ON_TRAIL) return;
    if (onlySaves) this.savesOnTrail++;
    this.trail.push({ kind, where });
  }

  /** What a request says it was off to do, from its address alone. */
  private wayOf(url: URL, ownCall: boolean): TrailKind | undefined {
    const path = plainPath(url) ?? url.pathname;
    if (SIGNS_OUT_PATH.test(path)) return "sign_out";
    if (ownCall && OWN_TABLE.test(path)) return undefined;
    if (PAYS_PATH.test(`${url.hostname}${path}`)) return "payment";
    if (DESTROYS_PATH.test(path)) return "destroys";
    if (SIGNS_UP_PATH.test(path)) return "account";
    return SENDS_PATH.test(path) ? "email" : undefined;
  }

  /** The trail: told each verdict, and never asked for one. */
  private noteWay(r: Asked, verdict: SealVerdict): void {
    const where = `${r.url.origin === this.origin ? "" : r.url.host}${r.url.pathname}`;
    const own = r.url.origin === this.origin || isLocalHost(r.url.hostname) || this.libraryHosts.has(r.url.hostname);
    if (r.type === "document") {
      if (r.inFrame) return;
      const away = r.url.origin === this.origin ? undefined : OAUTH_PATH.test(r.url.pathname) ? "third_party" as const : "leaves_site" as const;
      if (verdict.act === "save") this.note(this.wayOf(r.url, false) ?? away ?? "save", where);
      else if (verdict.act === "refuse" || r.popUp) this.note(this.wayOf(r.url, false) ?? away ?? "leaves_site", where);
      return;
    }
    if (!CALL_TYPES.has(r.type) || r.method === "GET" || r.method === "HEAD" || r.method === "OPTIONS" || r.method === "QUERY") return;
    if (this.background(r.url.hostname) || this.graphqlRead(r.body, r.headers["content-type"]) || r.url.pathname === "/auth/v1/token") return;
    // A DELETE destroys whatever a label said of it, and whatever the address does.
    const way = this.wayOf(r.url, own);
    this.note(way === "sign_out" ? way : r.method === "DELETE" ? "destroys" : way ?? (own ? (this.keptThis ? "kept" : "save") : "third_party"), where);
  }

  /** Something's kept, right now, for this session's reads to show. */
  get holdsSaves(): boolean {
    return Object.keys(this.rows).length > 0;
  }

  /** Words of what was saved that are in this text, as whole words. */
  keptIn(text: string): string[] {
    return [...this.keptWords].filter((value) => saysValue(text, value));
  }

  /** From here on, only what's read counts (see keptServedIn). */
  forgetServed(): void {
    this.servedWords.clear();
  }

  /**
   * Words of what was saved that this text says and a read since forgetServed really handed the page.
   * A page can echo what it was saved with from memory of its own, and only this rules that out.
   */
  keptServedIn(text: string): string[] {
    return this.keptIn(text).filter((value) => this.servedWords.has(value));
  }

  /** Whatever was saved is gone: the next journey starts as a new account again, with a trail of its own. */
  forget(): void {
    for (const key of Object.keys(this.rows)) delete this.rows[key];
    this.keptWords.clear();
    this.servedWords.clear();
    this.trail.length = 0;
    this.savesOnTrail = 0;
  }

  private verdictOn(r: Asked): SealVerdict {
    if (r.url.origin === this.origin && r.url.pathname === CHECK_PATH) return { act: "answer", reply: r.type === "document" ? { status: 200, contentType: "text/html", body: "<!doctype html><title>check</title>" } : { status: 200, contentType: "text/plain", body: CHECK_SAYS } };
    if (r.type === "document") {
      if (r.inFrame) return { act: "refuse" };
      if (r.method !== "GET" && r.method !== "HEAD") return { act: "save" };
      return r.url.origin === this.origin && this.isPage(r.url) && this.shell !== undefined ? { act: "shell" } : { act: "refuse" };
    }
    if (this.isFile(r)) return { act: "file" };
    if (!CALL_TYPES.has(r.type)) return { act: "refuse" };
    return this.answerCall(r);
  }

  /**
   * A file, read by Node with nothing of the page's on it: no cookie, no token, no header it chose.
   * Each is read once, as a page load here otherwise asks for every module again. A redirect is
   * followed only to another file.
   */
  readFile(r: Pick<Asked, "method" | "type" | "url" | "headers">): Promise<Served | undefined> {
    const url = this.forwarded(r.url);
    const key = `${r.method} ${url.href}`;
    const read = this.files.get(key) ?? this.fetchFile({ ...r, url });
    this.files.set(key, read);
    return read;
  }

  /**
   * The address as Node reads it. A query is what a page puts a session into, so it stays behind,
   * unless that very query is in what the server sent: a dev server's own (?import, ?v=1a2b) is
   * part of the file's name there, and no value the page made up can be in it.
   */
  private forwarded(url: URL): URL {
    this.shellFolders();
    if (!url.search || this.named.has(url.pathname + url.search)) return url;
    const bare = new URL(url);
    bare.search = "";
    return bare;
  }

  private async fetchFile(r: Pick<Asked, "method" | "type" | "url" | "headers">): Promise<Served | undefined> {
    const headers = Object.fromEntries(Object.entries(r.headers).filter(([name]) => name === "accept" || name === "sec-fetch-dest"));
    let at = r.url;
    for (let hops = 0; hops < 4; hops++) {
      const response = await fetch(at, { method: r.method, redirect: "manual", headers, signal: AbortSignal.timeout(READ_MS) }).catch(() => undefined);
      if (!response) return undefined;
      const to = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && to) {
        at = new URL(to, at);
        if (!this.isFile({ method: r.method, type: r.type, url: at })) return undefined;
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const contentType = response.headers.get("content-type");
      // Before it's handed over: what this file loads can only be asked for once the page has it.
      if (response.ok && /javascript|css|html/i.test(contentType ?? "")) this.noteNames(body.toString(), at);
      return { status: response.status, ...(contentType ? { contentType } : {}), body };
    }
    return undefined;
  }

  /**
   * What the server does with a page's address, for an address the pass is about to open. Only an
   * address something outside this pass stands behind is read: the public crawl opened it, or it
   * was asked for by name. Then it's a read with nothing of the browser's on it, with no query, and
   * only if reading it can't act and no proxy takes it, and failing to get an answer is an answer.
   * A link met on a made-up screen may be anyone's, as no config shows every proxy, and an address
   * only spelled in the code may run anything on a GET, so neither is ever read: each gets the one
   * document, reaching nothing, and what it draws has to show it's a screen of the app's own (see
   * Seal.sort).
   */
  documentFor(href: string): Promise<DocumentAnswer> {
    const url = new URL(href);
    if (url.pathname === this.start.pathname && url.search === this.start.search) return Promise.resolve("shell");
    if (!this.isPage(url) || !this.readable(url)) return Promise.resolve("not_a_page");
    if (!this.mayAsk(url)) return Promise.resolve("shell");
    url.search = "";
    const answer = this.documents.get(url.href) ?? this.askServer(url.href);
    this.documents.set(url.href, answer);
    return answer;
  }

  private async askServer(href: string): Promise<DocumentAnswer> {
    const at = await documentAt(href, this.origin, (url) => this.readable(url) && this.isPage(url));
    if (!at) return "not_checked";
    if (at.decided) return "decided";
    if (!at.ok) return "error_page";
    return sameShell(at.html, this.shell ?? "") ? "shell" : "server_page";
  }

  /**
   * What a screen drew, against what's been drawn: at a second address, the same thing shows no
   * screen of its own, and nor does it at the first any more.
   */
  sameAsSeen(path: string, now: Omit<Drawn, "href">): boolean {
    const hasRows = (drew: Omit<Drawn, "href">) => drew.values.some((value) => saysValue(drew.listed ?? "", value));
    // Rows of ours are the one thing a wall doesn't change from one address to the next, so with
    // those on both, a heading or an address that differs is a difference: two screens of one table.
    const same = [...this.drawn].filter(([seen, drew]) => seen !== path && (hasRows(now) && hasRows(drew) ? sameWords(now.text, drew.text) : sameDrawing({ path, ...now }, { ...drew, path: seen })));
    for (const [seen] of same) this.shared.add(seen);
    return same.length > 0;
  }

  /** This text is a made-up value, or part of one: a row's words on the screen, whatever else is drawn around them. */
  fromRow(text: string): boolean {
    const said = text.trim().toLowerCase();
    return said.length >= 4 && [...this.sentWhole].some((value) => value.includes(said));
  }

  /** The text says a made-up value with the look of a row's: a name or an id, not a word any sentence has, such as a status of "closed". */
  carriesRow(text: string): boolean {
    return this.fromRow(text) || this.valuesIn(text).some((value) => ROW_SHAPED.test(value));
  }

  /** The made-up values that went out and are in this text, as whole words: a list that isn't of them shows nothing. */
  valuesIn(text: string): string[] {
    return [...this.sentValues].filter((value) => saysValue(text, value));
  }

  /** This drawing is what the app draws for an address it can't have. */
  drawsNowhere(path: string, text: string, heading: string | undefined): boolean {
    return this.nowhere !== undefined && this.nowhere.path !== path && sameDrawing({ path, text, heading }, this.nowhere);
  }

  /** The screen drew what the app draws for an address it can't have. */
  likeNowhere(path: string): boolean {
    const nowhere = this.nowhere;
    const drew = this.drawn.get(path);
    const text = drew?.text ?? "";
    if (!nowhere || nowhere.path === path) return false;
    return sameDrawing({ path, text, heading: drew?.heading }, nowhere) || (onlyItsAddress(path, text) && onlyItsAddress(nowhere.path, nowhere.text));
  }

  /**
   * Which of these screens are shown to be screens. Anything can be drawn at an address, and what
   * an app draws instead of a screen has more wordings than any list, so words alone never prove
   * one, and nor does differing from what an address that can't exist draws: a router's catch-all
   * sits outside the guard, so a wall behind the guard differs from it on any app built that way.
   *
   * What another address drew too shows no screen of its own, data or no data. Of the rest, two
   * things show the app is past whatever stood in front of it. Its own data: values that went out,
   * that aren't there for an address that can't exist, in a list or a table, or two or more of a
   * shape no sentence says by chance (a wall can print a workspace's name). Or two different
   * drawings, one of them plainly at work: rows of something, or a form. A heading, some words and
   * a button are what a paywall is and an empty screen is too, so those prove nothing alone, though
   * they count once something else has. When neither test can be made, nothing is called a screen.
   */
  sort(screens: readonly string[]): { shown: string[]; unclear: string[]; notShown: string[]; withData: string[] } {
    const atWork = (path: string) => {
      const drew = this.drawn.get(path);
      return (drew?.rows ?? 0) >= FEWEST_ROWS || (drew?.fields ?? 0) >= FEWEST_FIELDS;
    };
    const unclear = screens.filter((path) => this.shared.has(path) || this.likeNowhere(path));
    const open = screens.filter((path) => !unclear.includes(path));
    const withData = open.filter((path) => this.ownData(path));
    const rest = open.filter((path) => !withData.includes(path));
    const left = rest.filter((path) => this.drawn.has(path));
    // Everything in left differs from everything else drawn, so two of them are two different drawings.
    const past = withData.length > 0 || (left.length >= 2 && left.some(atWork));
    const shown = past ? left : [];
    return { shown: [...withData, ...shown], unclear, notShown: rest.filter((path) => !shown.includes(path)), withData };
  }

  /** The screen drew values of ours as the app's own data: see sort. */
  private ownData(path: string): boolean {
    const drew = this.drawn.get(path);
    const values = (drew?.values ?? []).filter((value) => !this.nowhere || !saysValue(this.nowhere.text, value));
    return values.some((value) => saysValue(drew?.listed ?? "", value)) || values.filter((value) => ROW_SHAPED.test(value)).length >= FEWEST_VALUES;
  }

  private answerCall(r: Asked): SealVerdict {
    const read = r.method === "GET" || r.method === "HEAD" || r.method === "OPTIONS" || r.method === "QUERY";
    const onlyReads = !read && this.graphqlRead(r.body, r.headers["content-type"]);
    const quietly = read || onlyReads || this.background(r.url.hostname);
    const path = r.url.pathname;
    if (this.seenAsked.size < 200 && !this.background(r.url.hostname)) this.seenAsked.add(`${r.method} ${path}`);
    const adapter = this.adapters.find((a) => a.seenIn(r.url));
    if (adapter && (this.adapter === undefined || this.adapter === OWN_API_NAME)) this.adapter = adapter.name;
    if (adapter) this.libraryHosts.add(r.url.hostname);
    this.keptThis = false;
    // Its own API, on its own address, is all a client app asks: here it's answered like any other call.
    const ownApi = this.ownApiMayStandIn && !adapter && r.url.origin === this.origin && OWN_API.test(path);
    // The last look at a screen is signed out (see lookSignedOut), and here this is all that says so.
    if (ownApi && this.signedOut) return { act: "answer", reply: json({ error: "not signed in" }, 401) };
    if (ownApi && read) {
      this.adapter ??= OWN_API_NAME;
      if (this.adapter === OWN_API_NAME) this.sessionRead = true;
    }
    const named = this.rows[`${r.method} ${path}`] ?? this.rows[path];
    if (named !== undefined) {
      this.guessed++;
      if (read) {
        this.filled++;
        madeUpWords(named, this.sentValues);
        madeUpWords(named, this.sentWhole, Infinity);
        if (this.keepSaves) madeUpWords(named, this.servedWords);
      }
      return quietly ? { act: "answer", reply: json(named) } : { act: "save", reply: json(named) };
    }
    if (ownApi && read && WHO_AM_I.test(path)) {
      this.guessed++;
      return { act: "answer", reply: json(ownUser()) };
    }
    const kept = this.keepSaves && !read && !onlyReads ? adapter?.keep?.(r, this.rows, () => this.nextId()) : undefined;
    if (kept) this.keptWrite(kept);
    if (this.keepSaves && ownApi && r.method === "POST") this.keepOwnSave(r);
    const known = adapter?.answer(r, this.rows, this.newAccount, kept);
    if (read && (known ? !known.filled && !/^\/auth\//.test(path) && (known.reply.body === "[]" || known.reply.status >= 400) : !this.background(r.url.hostname))) this.emptied++;
    if (!known?.plain && r.method !== "OPTIONS" && !this.background(r.url.hostname)) this.guessed++;
    if (known?.filled) {
      this.filled++;
      try {
        const rows = JSON.parse(known.reply.body ?? "null");
        madeUpWords(rows, this.sentValues);
        madeUpWords(rows, this.sentWhole, Infinity);
        if (this.keepSaves) madeUpWords(rows, this.servedWords);
      } catch { /* no rows in it */ }
    }
    if (known) return quietly || known.quiet ? { act: "answer", reply: known.reply } : { act: "save", reply: known.reply };
    if (onlyReads) return { act: "answer", reply: json({ data: {} }) };
    if (quietly) return { act: "answer", reply: emptyReply(r) };
    return { act: "save" };
  }

  private nextId(): string {
    return `00000000-0000-4000-8000-${String(++this.keptIds + 100).padStart(12, "0")}`;
  }

  private keptWrite(kept: Rows[]): void {
    this.keptThis = true;
    madeUpWords(kept, this.sentValues);
    madeUpWords(kept, this.sentWhole, Infinity);
    madeUpWords(kept, this.keptWords);
  }

  /** An API of its own: a JSON record sent to an address comes back in a list from that address, the one shape emptyReply says it may have. */
  private keepOwnSave(r: Asked): void {
    let sent: unknown;
    try { sent = JSON.parse(r.body ?? ""); } catch { return; }
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) return;
    const key = `GET ${r.url.pathname}`;
    const given = this.rows[key];
    const row = { id: this.nextId(), ...(sent as Rows) };
    this.rows[key] = [...(Array.isArray(given) ? given : []), row];
    this.keptWrite([row]);
  }

  /** The pass has seen enough to know no library it knows is here. */
  giveUp(screens: number): boolean {
    return this.adapter === undefined && screens >= NO_ADAPTER_AFTER;
  }

  /**
   * Fails closed: on a page of the seal's own, shows that a call is answered here, that a socket
   * connects to nothing and that what no filter reaches is gone; and, from a page with no rules of
   * ours at all, that the browser can't reach the dev server by itself. Anything else throws, and
   * the pass ends before the app is ever loaded.
   */
  async check(page: Page, browser: Browser): Promise<void> {
    const bare = await browser.newContext();
    const through = await (await bare.newPage()).goto(`${this.origin}${CHECK_PATH}`, { timeout: 5000 }).then(() => true, () => false).finally(() => bare.close().catch(() => {}));
    if (through) throw new Error("the seal left the browser a way out");
    await page.goto(`${this.origin}${CHECK_PATH}`, { waitUntil: "domcontentloaded" });
    const seen = await page.evaluate(async ({ path, wanted }) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      const socket = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket("ws://seal-check.invalid/");
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 2000);
      });
      return {
        call: (await fetch(path).then((r) => r.text()).catch(() => "")) === wanted,
        socket,
        loose: ["SharedWorker", "WebTransport", "WebSocketStream", "RTCPeerConnection"].filter((name) => typeof scope[name] !== "undefined"),
      };
    }, { path: CHECK_PATH, wanted: CHECK_SAYS });
    if (!seen.call) throw new Error("the seal didn't answer a call");
    if (!seen.socket) throw new Error("the seal didn't hold a live connection");
    if (seen.loose.length > 0) throw new Error(`the seal left ${seen.loose.join(", ")} open`);
    this.held = true;
  }
}

/** A file as it's handed to the browser. */
export interface Served {
  status: number;
  contentType?: string;
  body: Buffer;
}

/**
 * What a read of a page's address said. shell: it's the app's one document. decided: the server
 * turned it away or moved it to a sign-in page, by itself. server_page, error_page, not_checked, not_a_page: see NotReached.
 */
export type DocumentAnswer = "shell" | "decided" | "server_page" | "error_page" | "not_checked" | "not_a_page";

/**
 * The rows with every list cut to one, in a list of its own or under a key: a count of exactly one is
 * where a word that never changes with its number shows, and how many rows an AI happens to invent
 * must not decide whether that's tested, nor whether it happened to link them. What a kept row
 * points at is pointed at the row kept there: a trade whose account was cut away draws as no trade
 * at all, and a list spared for being pointed at would never be a count of one.
 */
export function oneRowOf(rows: Rows): Rows {
  const listsIn = (value: unknown): unknown[][] => (Array.isArray(value) ? [value] : value && typeof value === "object" ? Object.values(value).filter(Array.isArray) : []);
  const idOf = (row: unknown) => (row && typeof row === "object" ? (row as Rows).id : undefined);
  const kept = new Map<string, unknown>();
  for (const list of Object.values(rows).flatMap(listsIn)) {
    for (const row of list) if (idOf(row) != null) kept.set(String(idOf(row)), idOf(list[0]));
  }
  const repoint = (row: unknown) => (row && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key !== "id" && /(?:_id|Id)$/.test(key) && kept.get(String(value)) != null ? kept.get(String(value)) : value]))
    : row);
  const one = (value: unknown) => (Array.isArray(value) ? value.slice(0, 1).map(repoint) : value);
  return Object.fromEntries(Object.entries(rows).map(([name, value]) => [name, value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, one(inner)])) : one(value)]));
}

/** Unknown call: an empty list, the one answer that survives being read as a list or as a record, so screens show their empty state. */
function emptyReply(r: Asked): Reply {
  if (r.method === "HEAD" || r.method === "OPTIONS") return noBody(204);
  return /json|\*\/\*/.test(r.headers.accept ?? "*/*") ? json([]) : noBody(204);
}

export interface SessionRecipe {
  pattern: string;
  value: string;
  adapter: string;
}

/**
 * Runs in the page before anything else: the auth library's own read of its session is answered
 * with the made-up one. Answering the read rather than writing to storage needs no project name,
 * address or key from the app, and survives anything the app or the learner does to storage.
 */
export function answerSessionReads(recipes: SessionRecipe[]) {
  const chosen = recipes.map((r) => ({ ...r, key: new RegExp(r.pattern) }));
  const real = Storage.prototype.getItem;
  Storage.prototype.getItem = function (key: string) {
    const recipe = chosen.find((r) => r.key.test(String(key)));
    if (!recipe) return real.call(this, key);
    // The last look at a screen is signed out (see lookSignedOut). The library will have saved the
    // session it was given, so what's in storage won't do: there is no session, whatever's there.
    if ((window as unknown as { __ctxSignedOut?: boolean }).__ctxSignedOut) return null;
    (window as unknown as { __ctxStandInRead?: (adapter: string) => void }).__ctxStandInRead?.(recipe.adapter);
    return recipe.value;
  };
}

/** Exact words of an app turning someone away, not a mention of it: a settings page about "Access denied errors" is a screen. */
export const NO_ACCESS = /^(?:error\s*)?(?:403\s*[-:|–—]?\s*)?(?:sorry[,.!]?\s*)?(?:access (?:is )?(?:denied|restricted)|permission denied|insufficient permissions?|not authori[sz]ed|unauthori[sz]ed(?: access)?|403 forbidden|forbidden(?: \(403\))?|you (?:do not|don.t) have (?:access|permission)(?: to (?:view |see |access |open )?(?:this|that) (?:page|area|section|screen))?|you(?: are|.re) not (?:authori[sz]ed|allowed|permitted)(?: to (?:view |see |access |open )?(?:this|that) (?:page|area|section|screen))?|admins? only|staff only|(?:admin|administrator|staff) (?:access|privileges|permissions?) (?:is |are )?required)[.!]?$/i;
/** Words on a sign-in form's button or heading. */
export const SIGN_IN_WORDS = /\b(?:log ?in|sign ?in)\b/i;

/** Exact words of each kind of screen that isn't the product. Always the whole of what an element says, never a mention of it. */
export const WALL_WORDS = {
  noAccess: NO_ACCESS.source,
  signIn: SIGN_IN_WORDS.source,
  /** The rest of what a sign-in by email, code or another provider puts on a button or heading. */
  wayIn: "magic link|one[- ]time|send (?:me )?(?:a |an |my )?(?:\\w+ )?(?:link|code)|continue with email|email me",
  asksSignIn: "^(?:please )?(?:log ?in|sign ?in)(?: (?:to|first|required|needed)\\b.{0,60})?[.!]?$|^(?:your )?session (?:has )?(?:expired|ended|timed out)\\b.{0,60}$",
  provider: "^(?:continue|log ?in|sign ?in|sign ?up)\\s+(?:with|using|via)\\s+\\S+",
  verify: "^(?:please )?(?:(?:verify|confirm) your (?:email|e-mail|account|address)|check your (?:email|e-mail|inbox)|enter (?:the |your )?(?:\\d[- ]digit |verification |security |one[- ]time |\\w+ )?(?:code|otp)|(?:we(?:'ve| have)? )?sent (?:you )?(?:a|an|the) (?:\\w+ )?(?:link|code|email)\\b).{0,80}$",
  paywall: "^(?:your )?(?:(?:free )?trial|subscription|plan) (?:has |is )?(?:ended|expired|over|lapsed)\\b.{0,80}$|^(?:upgrade|subscribe)(?: your plan| now)? to (?:continue|keep going|access|unlock)\\b.{0,60}$|^(?:choose|pick|select) a plan to (?:continue|get started)\\b.{0,40}$|^payment required[.!]?$",
  failed: "^(?:oops[,!. ]*)?(?:(?:\\w+[- ]){1,2}failed\\b.{0,60}|something (?:went wrong|broke)|an? (?:unexpected )?error (?:has )?occurred|(?:unexpected|application|fatal) error|(?:404\\W*)?(?:page )?not found|this page could not be found|(?:failed to|could ?n.t|could not|unable to|cannot) (?:load|fetch)\\b.{0,40}|error (?:loading|fetching)\\b.{0,40})[.!]*(?:\\s*(?:please )?(?:try again|reload|refresh)\\b.{0,30})?$",
  loading: "^(?:loading|please wait|one moment|just a moment|fetching)\\b.{0,30}$",
  /** A thrown error printed as it is, as the first thing on a page. */
  crash: "^(?:uncaught\\s+)?(?:\\w*Error|Exception)(?: \\[\\w+\\])?:\\s",
};

/** What a page really shows. kind: why it isn't a screen of the product, if it isn't. text: its own content. rows: rows of anything in it, and listed what they say. fields: boxes to fill in. heading: its main heading. */
export interface Wall {
  kind?: "sign_in" | "no_access" | "paywall" | "failed" | "loading" | "blank";
  text: string;
  rows: number;
  fields: number;
  listed: string;
  heading?: string;
}

/**
 * Runs in the page: what the screen really shows, judged on the page's own content. Navigation and
 * anything floating over it (a cookie banner, a chat bubble, a bar pinned to an edge) are there on
 * every screen, a blank one too, so they don't count. A screen is reached on positive proof: it has
 * content, and that content isn't one of the things an app draws instead of a screen. Each of those
 * needs the page to have little else on it, so a real screen that mentions them is still a screen.
 * A sign-in is one password box in a short form with sign-in words on it, or an email-only form, a
 * list of providers, or a box for a code. Turned away is an element saying only that, away from
 * any list or table of other things.
 */
export function readWall(words: typeof WALL_WORDS): Wall {
  const area = window.innerWidth * window.innerHeight;
  const known = new Map<Element, boolean>();
  /** Around the page, not of it: its navigation, and what floats over it. A fixed box filling the screen is the page. */
  const around = (el: Element | null): boolean => {
    if (!el) return false;
    const had = known.get(el);
    if (had !== undefined) return had;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const floats = (style.position === "fixed" || style.position === "sticky") && box.width * box.height < area * 0.5;
    const chrome = el.matches("nav, aside, footer, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]") || (el.matches("header") && !el.closest("main, article"));
    const out = floats || chrome || around(el.parentElement);
    known.set(el, out);
    return out;
  };
  const shown = (el: Element) => el.getBoundingClientRect().width > 0 && el.checkVisibility();
  const said = (el: Element) => ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
  const test = (name: keyof typeof WALL_WORDS) => new RegExp(words[name], "i");
  const content = (selector: string) => [...document.querySelectorAll(selector)].filter((el) => shown(el) && !around(el));

  const pieces: string[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), n = 0; node && n < 20_000; node = walker.nextNode(), n++) {
    const parent = node.parentElement;
    const piece = node.textContent?.trim();
    if (piece && parent && parent.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !around(parent)) pieces.push(piece);
  }
  const text = pieces.join(" ").replace(/\s+/g, " ").trim();

  const fields = content("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select");
  const passwords = fields.filter((f) => (f as HTMLInputElement).type === "password");
  const box = passwords[0]?.closest("form") ?? fields[0]?.closest("form") ?? document.body;
  const labels = [...box.querySelectorAll("button, a[href], input[type=submit], [role=button], h1, h2, h3, [role=heading]")].filter(shown).map((el) => said(el) || (el as HTMLInputElement).value || "");
  const rowsDrawn = content("tr, li, [role=row], [role=listitem]");
  const rows = rowsDrawn.length;
  const controls = content("a[href], button, [role=button], input:not([type=hidden]), select, textarea, canvas").length + content("svg, img").filter((el) => el.getBoundingClientRect().width >= 100).length;
  /** The page holds little else, so what it says is what it's for. */
  const little = text.length <= 400 && rows <= 3 && fields.length <= 8;
  /** Some element says this and nothing more, away from any list or table of other things. */
  const alone = (name: keyof typeof WALL_WORDS) => {
    const wanted = test(name);
    return content("h1, h2, h3, h4, [role=heading], [role=alert], [role=status], p, div, span, strong").slice(0, 4000).some((el) => {
      if (el.closest("table, ul, ol, pre, code, select")) return false;
      const words = said(el);
      return words.length > 0 && words.length <= 140 && wanted.test(words);
    });
  };
  const noAccess = (() => {
    const wanted = test("noAccess");
    return [...document.querySelectorAll("h1, h2, h3, h4, [role=heading], [role=alert], p, div, span, strong")].slice(0, 4000).some((el) => {
      if (el.closest("table, ul, ol, pre, code, select, nav, [role=row], [role=listitem]")) return false;
      const words = said(el);
      return words.length > 0 && words.length <= 80 && wanted.test(words) && shown(el);
    });
  })();

  const signIn = test("signIn");
  const wayIn = test("wayIn");
  const provider = test("provider");
  const email = fields.length === 1 && /email|e-mail/i.test(`${(fields[0] as HTMLInputElement).type} ${(fields[0] as HTMLInputElement).name} ${(fields[0] as HTMLInputElement).autocomplete} ${(fields[0] as HTMLInputElement).placeholder}`);
  const codeBox = fields.some((f) => (f as HTMLInputElement).autocomplete === "one-time-code") || fields.filter((f) => (f as HTMLInputElement).maxLength === 1).length >= 4;
  const asksIn =
    (passwords.length === 1 && fields.length <= 4 && labels.some((label) => signIn.test(label))) ||
    (little && email && labels.some((label) => signIn.test(label) || wayIn.test(label))) ||
    (little && fields.length === 0 && labels.some((label) => provider.test(label))) ||
    (little && codeBox) ||
    (little && (alone("verify") || alone("asksSignIn")));

  const kind = asksIn ? "sign_in" as const
    : noAccess ? "no_access" as const
    : little && alone("paywall") ? "paywall" as const
    : little && (alone("failed") || test("crash").test(text)) ? "failed" as const
    : little && (alone("loading") || (text.length < 20 && content("[aria-busy=true], [role=progressbar], [class*=spinner], [class*=skeleton], [class*=shimmer], [class*=loader]").length > 0)) ? "loading" as const
    : text.length < 20 && controls === 0 && content("h1, h2, h3, [role=heading]").every((el) => !said(el)) ? "blank" as const
    : undefined;
  const heading = content("h1").map(said).find(Boolean) ?? content("h2, h3, [role=heading]").map(said).find(Boolean);
  return { ...(kind ? { kind } : {}), text, rows, fields: fields.length, listed: rowsDrawn.slice(0, 500).map(said).join(" \n "), ...(heading ? { heading } : {}) };
}

/**
 * Two drawings of one page: the same words, give or take a bar or a badge only a signed-in user gets.
 * Compared as sets of words, so a line that moved or a time that ticked over changes nothing.
 */
export function sameWords(a: string, b: string): boolean {
  const words = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
  const [one, other] = [words(a), words(b)];
  const shared = [...one].filter((word) => other.has(word)).length;
  return shared / Math.max(1, new Set([...one, ...other]).size) >= 0.9;
}

/** A document's own text, with what only runs in the browser taken out. */
export function documentText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html.replace(/<head[\s\S]*?<\/head>/i, "");
  return body.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** The scripts and styles a document loads, in order: what makes it that app's document. */
const loads = (html: string) => [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']?([^"'\s>]+)/gi)].map((m) => m[1]).join(" ");

/** What a document moves or decides by itself: its inline scripts and any meta refresh. Something that changes per answer (a nonce, a request's id) isn't what it decides. */
function ownScript(html: string): string {
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const refresh = [...html.matchAll(/<meta\b[^>]*http-equiv=["']?refresh[^>]*>/gi)].map((m) => m[0]);
  return [...inline, ...refresh].join("\n").replace(/nonce\b(["']?\s*[:=]\s*["'])[^"']*/gi, "nonce$1").replace(/\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{16,}={0,2}/g, "#");
}

/**
 * Whether two documents are one app's one document. They're compared whole, with no allowance for
 * length: a server's page that says only "Please sign in" is as much the server's as a long one,
 * and one that differs only in its head or an inline script (a redirect, a guard, its state) is
 * a server deciding too. Calling a client-rendered app's page a server's costs a run of public pages.
 */
export function sameShell(a: string, b: string): boolean {
  return documentText(a) === documentText(b) && loads(a) === loads(b) && ownScript(a) === ownScript(b);
}

/**
 * What the server sends for an address, with no session of any kind, following its redirects on the
 * same origin. Nothing that might act is read, a hop included. No answer is undefined: a slow first
 * compile is no answer, and never reads as one.
 */
async function documentAt(href: string, origin: string, readable: (url: URL) => boolean): Promise<{ decided: boolean; ok: boolean; html: string; path: string } | undefined> {
  let at = href;
  for (let hops = 0; hops < 4; hops++) {
    const response = await fetch(at, { redirect: "manual", headers: { accept: "text/html" }, signal: AbortSignal.timeout(READ_MS) }).catch(() => undefined);
    if (!response) return undefined;
    const path = new URL(at).pathname;
    if (response.status === 401 || response.status === 403) return { decided: true, ok: false, html: "", path };
    const to = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && to) {
      const next = new URL(to, at);
      // A page moved to an address that runs code isn't followed: the seal wouldn't load that either.
      const named = plainPath(next);
      if (next.origin !== origin || named === undefined || SIGN_IN_PATH.test(named) || HANDLER_PATH.test(named) || !readable(next)) return { decided: true, ok: false, html: "", path };
      at = next.href;
      continue;
    }
    return { decided: false, ok: response.ok, html: response.ok ? await response.text().catch(() => "") : "", path };
  }
  return undefined;
}

/** What the first look at the server found. bounced: an address it really sent away. own: addresses it drew a document of its own for. */
export interface ServerRead {
  bounced?: string;
  own?: string[];
  shell?: string;
  /** The app's own document couldn't be read, so nothing is known. */
  unread?: boolean;
}

/**
 * Whether the server, not the browser, decides who sees these addresses. A client-rendered app sends
 * one document for all of them, with nothing of the product in it, so a browser-side session is all
 * the sign-in there is. A server that turns the address away, moves it to a sign-in page, or sends
 * a document of its own for it is deciding for itself, and no answer in the browser can change that.
 * Says which address showed it, and what the start's document was. Only addresses a read can't act
 * on are read: the same test a link must pass. A false yes costs only a run of public pages; the
 * same mistake the other way would run a server's own pages under made-up data. And no answer at
 * all stays no answer: a dev server still compiling isn't a client-rendered app.
 */
export async function serverDecides(start: URL, addresses: string[], readable: (url: URL) => boolean): Promise<ServerRead> {
  const front = await documentAt(start.href, start.origin, readable);
  if (!front || (!front.decided && !front.ok)) return { unread: true };
  if (front.decided) return { bounced: start.pathname };
  const own: string[] = [];
  // Read on past the first page of its own: a public page the server drew says nothing of which
  // pages it turns away, and the one that gets named should be one it did.
  for (const href of addresses.slice(0, 12)) {
    const url = new URL(href);
    if (!readable(url)) continue;
    url.search = "";
    const at = await documentAt(url.href, start.origin, readable);
    if (at?.decided) return { bounced: url.pathname, own, shell: front.html };
    if (at?.ok && !sameShell(at.html, front.html)) own.push(url.pathname);
  }
  return { own, shell: front.html };
}
