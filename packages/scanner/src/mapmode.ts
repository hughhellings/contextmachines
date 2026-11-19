/**
 * Map mode's holding unit (any-site plan 5.2, wave M1): while a site is mapped, nothing the browser
 * sends may change anything, on any host, for the whole session, with or without a press. This is
 * stricter than Discovery's per-press hold (explore.ts) and than learn's (scan.ts), and it is its own
 * small unit so it can be tested on its own (cli/mapmode.test.ts, against the trap app).
 *
 * The rule, at the route layer of one browser context:
 *   - Every request whose method isn't GET, HEAD or OPTIONS is held (aborted before it is sent), on
 *     every host, owned or not: POSTs on page load, timers, delayed autosave, autosave on blur, form
 *     posts, sendBeacon, keepalive fetches, an IndexedDB outbox replaying on load, token refreshes.
 *     One exception: a POST whose body is GraphQL and every operation in it parses as a query
 *     (scan.ts onlyGraphqlReads). A mutation anywhere in a batch, a persisted-query hash with no text,
 *     and anything that can't be parsed are held.
 *   - A GET is held when its address commands something (scan.ts commandIn, signed-in strictness):
 *     delete, sign out, accept, approve, unsubscribe, mark read and the rest, plus map mode's wider
 *     floor (invite, resend, confirm, export by email, ?state= toggles) and a path part that looks
 *     like a one-time token. A GraphQL GET that isn't a readable query is held (scan.ts graphqlGetActs).
 *   - WebSockets: the page may receive; every frame it sends is held. A socket whose address
 *     commands is never opened. Workers get a WebSocket that never connects, and no SharedWorker,
 *     WebTransport or WebRTC (scan.ts noLooseSockets): what can't be filtered doesn't exist.
 *   - Redirects: Playwright doesn't route a redirect's next hop, so a GET that passes is fetched here
 *     with no redirect followed, and each hop's address is checked (getActs) before the browser may
 *     follow it; a redirect after a let-through POST is never followed. The hold must be the route
 *     that runs first (added last): another route that answers a request itself would skip it.
 *   - Speculation rules (prefetch, prerender) load addresses outside the route: a page loses its
 *     <script type=speculationrules> and its Speculation-Rules header, and scripts can't add one.
 *   - sendBeacon is a POST, held at the route (resource type "ping"); and because a beacon sent as a
 *     page unloads can go past the route, the page's sendBeacon also sends nothing in map mode. Service workers are blocked by the context
 *     (serviceWorkers: "block"), so there is no background sync.
 * It lives beside scan.ts (the learner's hold), not in tester/: like scan.ts it adds init scripts
 * (scan.ts's own noLooseSockets, and holdBeacons), and the tester's code adds none (botwall.test.ts).
 * Every held request is kept as a clue for "which form posts where": its method, host, path pattern
 * (ids as :id, value-shaped parts as :value), body field NAMES (never a value, nor a key that is one), GraphQL operation names and kinds, the page it came
 * from and the press under way. A clue is evidence for a verb only; it never says anything was stored.
 *
 * The context is the caller's to throw away (with its IndexedDB and local storage) when mapping ends,
 * and its storage is never saved back into the account's session: that stops an outbox replaying a
 * held save later.
 */
import type { BrowserContext, Request, Route, WebSocketRoute } from "playwright";
import { commandIn, graphqlGetActs, noLooseSockets, onlyGraphqlReads, startWithoutSockets, WORKER_MARK } from "./scan.ts";

/** An address on this machine: localhost, *.localhost, 127.x, ::1. */
const onThisMachine = (x: URL) => {
  const h = x.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1";
};
/** Resource types that can't be fetched whole before the page gets them. */
const STREAMS = new Set(["eventsource", "media", "websocket"]);
const MAX_HOPS = 6;
const isRedirect = (status: number) => status >= 300 && status < 400 && status !== 304;
const SPECULATION = /<script\b[^>]*\btype\s*=\s*["']?speculationrules\b/i;
const SPECULATION_ALL = /<script\b[^>]*\btype\s*=\s*["']?speculationrules\b[^>]*>[\s\S]*?<\/script\s*>/gi;

/** Methods that only read (HTTP's safe methods). QUERY is held: few servers know it, and it carries a body. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Map mode's floor for GETs, beyond commandIn: words whose GET changes something or reaches someone. */
const MAP_GET_WORDS = /(^|[\/_.-])(invit(e|es|ation|ations)|accept|resend|re-?send|approve|confirm|verify|unsubscribe|opt-?out|mark[-_]?(all[-_]?)?(as[-_]?)?read|dismiss|export[-_]?(by[-_]?)?e-?mail|email[-_]?export|toggle|enable|disable|activate|deactivate|join|leave|claim|redeem|logout|log[-_]?out|sign[-_]?out|switch[-_]?(user|account|org|organi[sz]ation|team|workspace|company|tenant|profile)s?|impersonat(e|ion)|(log|sign)[-_]?in[-_]?as)([\/_.-]|$)/i;
/**
 * Words that do a job when they end an address or follow an id (/jobs/5/retry, /api/sync,
 * /api/send?to=all, /items/5/duplicate, /track?event=): common enough on GETs that write that map mode
 * holds them. A page link that ends this way (/docs/sync) isn't followed either: map mode would rather
 * miss a page than send a write.
 */
const JOB_WORDS = new Set("retry rerun run execute exec trigger sync resync send resend submit assign unassign reassign duplicate clone copy restore undelete recover pin unpin subscribe resubscribe track collect beacon log-event notify remind ping".split(" "));
/** Words that do a job only right after an id (/items/5/complete, /notifications/12/open), not as a view's name (/tickets/open). */
const AFTER_ID_WORDS = new Set("complete close reopen open start stop pause resume finish done lock unlock read seen ack acknowledge snooze mute unmute merge convert promote demote transfer void refund charge move cancel".split(" "));
const LOOKS_ID = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{36}|:id|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{5,})$/i;
function jobIn(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  for (const [i, p] of parts.entries()) {
    const word = p.toLowerCase();
    const first = word.split(/[-_.]/)[0]!;
    const afterId = i > 0 && LOOKS_ID.test(parts[i - 1]!);
    const last = i === parts.length - 1;
    if ((last || afterId) && (JOB_WORDS.has(word) || (afterId && JOB_WORDS.has(first)))) return word;
    if (afterId && (AFTER_ID_WORDS.has(word) || AFTER_ID_WORDS.has(first))) return word;
  }
  return undefined;
}
/** Query keys that switch a state ("?state=on", "?toggle=1", "?enabled=false"). Not "status": that is usually a filter. */
const STATE_KEY = /^(state|toggle|enabled?|disabled?|turn|switch)$/i;
/** A path part that looks like a one-time token: long, mixed letters and digits, or long hex/base64. */
const TOKEN_PART = /^(?=[A-Za-z0-9_-]{20,}$)(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]+$/;
/** What an id looks like in a path part: a number, a uuid or long hex, or a slug with a number in it. */
const ID_PART = /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{5,})$/i;

/** One held request, kept as a clue. Never a value: names only. */
export interface HeldClue {
  n: number;
  /** ms since the hold began. */
  at: number;
  /** "WS" for a socket frame, "BEACON" for a sendBeacon the page tried. */
  method: string;
  kind: "http" | "ws" | "beacon" | "get";
  host: string;
  /** The path with ids as :id, and the query keys (no values), e.g. "/api/contacts/:id?view". */
  path: string;
  /** Body field names (JSON keys as a.b, form keys, multipart names, GraphQL variable names), sorted, at most 40. */
  fields: string[];
  graphql?: { operations: string[]; kinds: string[]; persisted?: boolean };
  /** Why it was held, in a few words. */
  why: string;
  /** The page it left from, as a path pattern. */
  page: string;
  /** The press under way when it was sent (MapHold.pressing), if any. */
  press?: string;
  /** Playwright's resource type: fetch, xhr, document, ping, script... */
  resource: string;
}

export interface MapHoldCounts {
  /** Requests held at the route (all kinds but sockets and beacons). */
  held: number;
  /** Socket frames held. */
  wsFramesHeld: number;
  /** Sockets never opened (their address commands). */
  wsRefused: number;
  /** sendBeacon requests held at the route (resource type "ping"). */
  beaconsHeld: number;
  /** GraphQL POSTs let through as provably read-only. */
  graphqlReadsPassed: number;
  /**
   * Non-GET requests that got an answer from a server although nothing here let them through (the
   * route-layer measurement the gate reads): always 0, or the unit is broken.
   */
  leaked: number;
  /** Passed requests whose answer was a redirect, each hop's address checked before the browser followed. */
  redirectsChecked: number;
  /** Pages whose speculation rules (prefetch, prerender) were taken out before the browser saw them. */
  speculationRemoved: number;
}

/**
 * What `leaked` (and a map's writesLeft) can and can't see, said with the number wherever it's shown:
 * it counts requests with a body that got an answer at the route layer. It can't see a GET whose server
 * writes behind an address that reads like a read, or traffic the browser sends outside the route.
 */
export const LEAKED_COVERS = "counts non-GET requests answered at the route layer; a GET whose server writes behind a harmless-looking address, and anything the browser sends outside the route, can't be counted here: the gate reads the server's own log";

export interface MapHold {
  readonly clues: HeldClue[];
  readonly counts: MapHoldCounts;
  /** Says which press is under way (a control's name), so clues can be tied to it; undefined when none. */
  pressing(label: string | undefined): void;
  /** Clues held since a clue count (`since` = clues.length taken before a press). */
  since(n: number): HeldClue[];
}

/** The context options map mode needs: no service workers (so no background sync), no downloads. */
export const mapContextOptions = { serviceWorkers: "block" as const, acceptDownloads: false };

/** An address's path as a pattern: ids as :id, query keys kept without values. */
export function pathPattern(u: string | URL): string {
  let x: URL;
  try {
    x = typeof u === "string" ? new URL(u, "http://x") : u;
  } catch {
    return String(u).slice(0, 200);
  }
  const parts = x.pathname.split("/");
  const path = parts.map((p, i) => (!p ? p : ID_PART.test(decode(p)) ? ":id" : valuePart(p, parts[i - 1]) ? ":value" : p)).join("/");
  const keys = [...new Set([...x.searchParams.keys()].map((k) => (NAME_SHAPED.test(k) ? k : "*")))].sort();
  return `${path}${keys.length ? `?${keys.join("&")}` : ""}`.slice(0, 200);
}

/** A name (a field, a key) as code writes one: kept in a clue. Anything else (an email, words, a value used as a key) is "*". */
export const NAME_SHAPED = /^[A-Za-z_$][\w$-]{0,40}(\[\]|\[[A-Za-z_$][\w$-]{0,40}\])*$/;
/** Collections whose items are named by a person's name in the address (/users/sam-lee). */
const PEOPLE = /^(users?|members?|people|persons?|profiles?|authors?|contacts?|customers?|clients?|employees?|staff|accounts?|u|@[^/]*)$/i;
/**
 * A path part that is a value, not a place: an email or anything with @, words with spaces, an
 * encoded value, a matrix parameter (;k=v), a Name Written Like This (PascalCase over 8 characters),
 * or a slug right after a people collection. Kept out of every clue and view pattern as :value.
 */
export function valuePart(raw: string, before = ""): boolean {
  const p = decode(raw);
  if (/[@\s;=,+'"<>{}|\\^`]/.test(p) || /%[0-9a-f]{2}/i.test(raw)) return true;
  if (p.length >= 8 && /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(p)) return true;
  return PEOPLE.test(decode(before)) && /^[\p{L}][\p{L}\d._-]*$/u.test(p) && /[-_.]/.test(p) && !/^(new|edit|me|all|invite|settings?)([-_]|$)/i.test(p);
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The field names a body carries, never a value: JSON keys (nested as a.b, arrays as a[]), form keys, multipart names. */
export function bodyFieldNames(body: string | undefined, contentType = ""): string[] {
  if (!body) return [];
  const out = new Set<string>();
  const walk = (x: unknown, at: string, depth: number) => {
    if (depth > 4 || out.size >= 40) return;
    if (Array.isArray(x)) {
      for (const v of x.slice(0, 5)) walk(v, at ? `${at}[]` : "[]", depth + 1);
      return;
    }
    if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        // A key that is data (an email, a map keyed by values) is "*": never a value in a clue.
        const name = at ? `${at}.${NAME_SHAPED.test(k) ? k : "*"}` : NAME_SHAPED.test(k) ? k : "*";
        if (v && typeof v === "object") walk(v, name, depth + 1);
        else out.add(name);
      }
    }
  };
  const text = body.slice(0, 256 * 1024);
  if (/multipart\/form-data/i.test(contentType)) {
    for (const m of text.matchAll(/content-disposition:[^\r\n]*\bname="([^"]{1,80})"/gi)) out.add(NAME_SHAPED.test(m[1]!) ? m[1]! : "*");
  } else {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (json !== undefined && typeof json === "object") {
      // GraphQL: the operation's variables are its fields; the query text is not a field.
      const ops = (Array.isArray(json) ? json : [json]).filter((o) => o && typeof o === "object") as Record<string, unknown>[];
      if (ops.length && ops.every((o) => "query" in o || "operationName" in o || "extensions" in o)) {
        for (const o of ops) walk(o.variables ?? {}, "variables", 0);
      } else walk(json, "", 0);
    } else if (/^[\w.%[\]-]+=/.test(text)) {
      for (const pair of text.split("&")) {
        const k = decode(pair.split("=")[0]!.replace(/\+/g, " "));
        if (k) out.add(NAME_SHAPED.test(k) ? k : "*");
      }
    }
  }
  return [...out].sort().slice(0, 40);
}

/** The GraphQL operations a body (object or batch) names, with each one's kind, and whether it is a hash with no text. */
export function graphqlOf(body: string | undefined): HeldClue["graphql"] | undefined {
  if (!body) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(body.slice(0, 256 * 1024));
  } catch {
    return undefined;
  }
  const ops = (Array.isArray(json) ? json : [json]).filter((o) => o && typeof o === "object") as Record<string, unknown>[];
  if (!ops.length || !ops.every((o) => "query" in o || "operationName" in o || "extensions" in o)) return undefined;
  const kinds = ops.map((o) => {
    if (typeof o.query !== "string") return "persisted";
    const text = o.query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, " ").trim();
    const m = /^(query|mutation|subscription)\b/.exec(text);
    return m ? m[1]! : text.startsWith("{") ? "query" : "unknown";
  });
  return { operations: ops.map((o) => (typeof o.operationName === "string" ? o.operationName : "")).filter(Boolean).slice(0, 10), kinds, ...(kinds.includes("persisted") ? { persisted: true } : {}) };
}

/** Why a GET would change something, so it's held (and its link never followed), or undefined for a plain read. */
export function getActs(u: string | URL): string | undefined {
  let x: URL;
  try {
    x = typeof u === "string" ? new URL(u) : u;
  } catch {
    return undefined;
  }
  if (graphqlGetActs(x)) return "a GraphQL request that isn't a readable query";
  if (/(^|\/)(graphql|gql)(\/|$)/i.test(x.pathname) && x.searchParams.has("extensions") && !x.searchParams.has("query")) return "a persisted GraphQL query (a hash only)";
  const said = commandIn(x, true);
  if (said === "command") return "its address commands something";
  if (said === "token") return "its address carries a signed token";
  const path = decode(x.pathname);
  if (MAP_GET_WORDS.test(path)) return "its address reads like accepting, inviting, confirming or switching something";
  if (path.split("/").some((p) => TOKEN_PART.test(p))) return "a part of its address looks like a one-time token";
  const job = jobIn(path);
  if (job) return `its address reads like a job being done (${job})`;
  for (const [k, v] of x.searchParams) {
    if (STATE_KEY.test(k)) return `its query sets a state (${k}=)`;
    if (MAP_GET_WORDS.test(`/${v}/`)) return "its query reads like accepting, inviting, confirming or switching something";
  }
  return undefined;
}

/** A request as the rule sees it. */
export interface Outgoing {
  method: string;
  url: string;
  body?: string;
  contentType?: string;
}

/** The map-mode rule for one request: pass, or hold and why. Pure: the route only applies it. */
export function mapVerdict(r: Outgoing): { act: "pass"; graphqlRead?: true } | { act: "hold"; why: string } {
  const method = r.method.toUpperCase();
  if (!READ_METHODS.has(method)) {
    if (method === "POST" && onlyGraphqlReads(r.body, r.contentType)) return { act: "pass", graphqlRead: true };
    const gql = graphqlOf(r.body);
    if (gql) return { act: "hold", why: gql.persisted ? "a persisted GraphQL query (a hash only)" : gql.kinds.includes("mutation") ? "a GraphQL mutation" : "GraphQL that couldn't be read as a query" };
    return { act: "hold", why: `a ${method}: map mode sends nothing but reads` };
  }
  const acts = getActs(r.url);
  return acts ? { act: "hold", why: acts } : { act: "pass" };
}

/**
 * Puts map mode's hold on a context, before any page opens. Call it once, on a fresh context made
 * with mapContextOptions. `pageOf` names the page a request came from (default: its frame's page address).
 */
export async function holdForMapping(context: BrowserContext, o: { pageOf?: (req: Request) => string; /** Main-frame page loads (and their redirects) only to addresses this allows. */ keepOn?: (url: string) => boolean } = {}): Promise<MapHold> {
  const begun = Date.now();
  const clues: HeldClue[] = [];
  const counts: MapHoldCounts = { held: 0, wsFramesHeld: 0, wsRefused: 0, beaconsHeld: 0, graphqlReadsPassed: 0, leaked: 0, redirectsChecked: 0, speculationRemoved: 0 };
  let press: string | undefined;
  /** Requests this unit let through: any other non-GET that gets an answer is a leak. */
  const passed = new WeakSet<Request>();
  /** Held frame loads answered here with an empty 204: never sent, so never a leak. */
  const answeredEmpty = new WeakSet<Request>();
  const granted = new Set<string>();
  const pageOf = (req: Request) => {
    try {
      return pathPattern(o.pageOf?.(req) ?? req.frame().page().url());
    } catch {
      return "";
    }
  };
  const keep = (c: Omit<HeldClue, "n" | "at" | "press">) => {
    clues.push({ n: clues.length + 1, at: Date.now() - begun, ...c, ...(press ? { press } : {}) });
  };

  // Workers: no socket that can't be filtered; what can't be routed is taken away (scan.ts).
  await context.addInitScript(noLooseSockets);
  // sendBeacon: held in the page itself as well. A beacon sent while a page unloads (pagehide) is sent
  // by the browser after the page is gone, and the route doesn't always see it: in map mode the page's
  // beacon says "queued" and nothing is sent. The page is told nothing else; nothing about the browser changes.
  await context.exposeBinding("__cmMapBeacon", (source, href: string, fields: string[]) => {
    counts.beaconsHeld++;
    let to: URL | undefined;
    try {
      to = new URL(href, source.page?.url() ?? undefined);
    } catch {
      to = undefined;
    }
    keep({ method: "BEACON", kind: "beacon", host: to?.host ?? "", path: pathPattern(to ?? href), fields: Array.isArray(fields) ? fields.filter((f) => typeof f === "string").slice(0, 40) : [], why: "sendBeacon: map mode sends nothing but reads", page: pathPattern(source.page?.url() ?? ""), resource: "ping" });
  });
  await context.addInitScript(holdBeacons);
  await context.addInitScript(noSpeculation);
  await context.route("**/*", async (route: Route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      return route.abort("blockedbyclient").catch(() => {});
    }
    // A worker's script: started with what takes its loose sockets away (scan.ts).
    if (url.searchParams.has(WORKER_MARK)) {
      if (req.method() !== "GET" || getActs(new URL(url.href.replace(new RegExp(`[?&]${WORKER_MARK}=[^&]*`), "")))) return route.abort("blockedbyclient").catch(() => {});
      return startWithoutSockets(route, url);
    }
    const body = req.postData() ?? undefined;
    const contentType = req.headers()["content-type"];
    const verdict = mapVerdict({ method: req.method(), url: req.url(), ...(body !== undefined ? { body } : {}), ...(contentType ? { contentType } : {}) });
    const mainLoad = req.isNavigationRequest() && (() => {
      try {
        return req.frame().parentFrame() === null;
      } catch {
        return true; // a new tab's first request: its frame isn't there yet
      }
    })();
    const holdIt = (why: string, at: URL = url) => {
      counts.held++;
      if (req.resourceType() === "ping") counts.beaconsHeld++;
      const gql = graphqlOf(body);
      keep({ method: req.resourceType() === "ping" ? "BEACON" : req.method().toUpperCase(), kind: req.resourceType() === "ping" ? "beacon" : READ_METHODS.has(req.method().toUpperCase()) ? "get" : "http", host: at.host, path: pathPattern(at), fields: bodyFieldNames(body, contentType), ...(gql ? { graphql: gql } : {}), why, page: pageOf(req), resource: req.resourceType() });
      // A frame's page load is answered empty (so the page's own load doesn't wait on it); the rest aborted.
      if (req.isNavigationRequest() && !mainLoad) {
        answeredEmpty.add(req);
        return route.fulfill({ status: 204 }).catch(() => {});
      }
      return route.abort("blockedbyclient").catch(() => {});
    };
    if (verdict.act === "hold") return holdIt(verdict.why);
    // A page load of the main frame off the walk's sites (o.keepOn) isn't sent at all.
    if (mainLoad && o.keepOn && !o.keepOn(url.href)) return route.abort("blockedbyclient").catch(() => {});
    if (verdict.graphqlRead) counts.graphqlReadsPassed++;
    passed.add(req);
    // What can't be fetched whole (a stream, media by ranges) goes on as it is: its redirects aren't checked.
    if (STREAMS.has(req.resourceType()) || /text\/event-stream/i.test(req.headers()["accept"] ?? "")) return route.fallback();
    // A page answered through the route has no address of its own, so Chromium takes it for a public page
    // and blocks what it asks of this machine (Local Network Access): a page on this machine may reach this
    // machine, as it may when it isn't routed (act.ts guardSite does the same for its start page).
    if (req.resourceType() === "document" && onThisMachine(url) && !granted.has(url.origin)) {
      granted.add(url.origin);
      await context.grantPermissions(["local-network-access"], { origin: url.origin }).catch(() => {});
    }
    // Everything else is fetched here, its redirects not followed: Playwright doesn't route a redirect's
    // next hop, so each hop's address is checked here before the browser may follow it.
    let res: Awaited<ReturnType<typeof route.fetch>>;
    try {
      res = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
    } catch {
      return route.abort("failed").catch(() => {});
    }
    if (isRedirect(res.status())) {
      // A write that isn't a GET (a let-through GraphQL read) is never sent again to where it's redirected.
      if (req.method().toUpperCase() !== "GET") return holdIt("its answer redirects a request with a body: map mode doesn't send it again");
      let at = url;
      let hop = res;
      for (let i = 0; ; i++) {
        const loc = hop.headers()["location"];
        if (!isRedirect(hop.status()) || !loc) break;
        let next: URL;
        try {
          next = new URL(loc, at);
        } catch {
          return holdIt("it redirects to an address that can't be read");
        }
        const acts = /^https?:$/.test(next.protocol) ? getActs(next) : "it redirects out of the web";
        if (acts) return holdIt(`it redirects to an address that would change something (${acts})`, next);
        if (mainLoad && o.keepOn && !o.keepOn(next.href)) return route.abort("blockedbyclient").catch(() => {});
        if (i >= MAX_HOPS) return holdIt(`it redirects more than ${MAX_HOPS} times`, next);
        at = next;
        try {
          // The next hop, a GET, read here to see where it goes on (the browser reads it again as it follows).
          hop = await route.fetch({ url: next.href, maxRedirects: 0, timeout: 20_000 });
        } catch {
          break;
        }
      }
      counts.redirectsChecked++;
      return route.fulfill({ response: res }).catch(() => {});
    }
    // A page's speculation rules ask the browser to load addresses on its own, outside this route:
    // in map mode a page has none (the header, and every <script type=speculationrules> it is sent with).
    const headers = res.headers();
    const html = /text\/html|application\/xhtml/i.test(headers["content-type"] ?? "");
    if (html || "speculation-rules" in headers) {
      const kept = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== "speculation-rules" && k !== "content-length" && k !== "content-encoding"));
      if (html) {
        const text = await res.text().catch(() => undefined);
        if (text !== undefined && SPECULATION.test(text)) {
          counts.speculationRemoved++;
          return route.fulfill({ status: res.status(), headers: kept, body: text.replace(SPECULATION_ALL, "<script type=\"text/x-held-speculationrules\"></script>") }).catch(() => {});
        }
      }
      if ("speculation-rules" in headers) {
        counts.speculationRemoved++;
        return route.fulfill({ status: res.status(), headers: kept, body: await res.body().catch(() => Buffer.alloc(0)) }).catch(() => {});
      }
    }
    return route.fulfill({ response: res }).catch(() => {});
  });

  // The measurement the gate reads: a non-GET that got an answer and wasn't let through here.
  context.on("requestfinished", (req) => {
    if (!READ_METHODS.has(req.method().toUpperCase()) && !passed.has(req) && !answeredEmpty.has(req)) counts.leaked++;
  });

  await context.routeWebSocket(/.*/, (ws: WebSocketRoute) => {
    let opens: URL | undefined;
    try {
      opens = new URL(ws.url().replace(/^ws/, "http"));
    } catch {
      opens = undefined;
    }
    if (!opens || getActs(opens)) {
      counts.wsRefused++;
      return void ws.close({ code: 1008, reason: "map mode" });
    }
    const server = ws.connectToServer();
    // The page may receive everything; it sends nothing.
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => {
      counts.wsFramesHeld++;
      let fields: string[] = [];
      if (typeof m === "string") fields = bodyFieldNames(m, "application/json");
      const gql = typeof m === "string" ? socketGraphql(m) : undefined;
      keep({ method: "WS", kind: "ws", host: opens!.host, path: pathPattern(opens!), fields, ...(gql ? { graphql: gql } : {}), why: "a frame sent on a socket: map mode sends nothing", page: "", resource: "websocket" });
    });
  });

  return {
    clues,
    counts,
    pressing(label) {
      press = label?.slice(0, 80) || undefined;
    },
    since: (n) => clues.slice(n),
  };
}

/** Runs in every page before its own scripts: sendBeacon queues nothing and sends nothing. Self-contained. */
function holdBeacons() {
  const proto = (globalThis as unknown as { Navigator?: { prototype: Record<string, unknown> } }).Navigator?.prototype;
  if (!proto || typeof proto.sendBeacon !== "function") return;
  /** A key as code writes one, else "*" (an email or a value used as a key): mapmode.ts NAME_SHAPED. */
  const named = (k: string) => (/^[A-Za-z_$][\w$-]{0,40}(\[\]|\[[A-Za-z_$][\w$-]{0,40}\])*$/.test(k) ? k : "*");
  /** The field names a beacon's body carries (JSON keys, form keys), never a value. */
  const names = (data: unknown): string[] => {
    try {
      if (typeof data === "string") {
        const j = JSON.parse(data) as unknown;
        return j && typeof j === "object" ? [...new Set(Object.keys(j).map(named))].slice(0, 40) : [];
      }
      if (data instanceof URLSearchParams || data instanceof FormData) return [...new Set([...(data as URLSearchParams).keys()].map(named))].slice(0, 40);
    } catch {
      // a body that isn't JSON: no names
    }
    return [];
  };
  proto.sendBeacon = (url: unknown, data?: unknown) => {
    try {
      (globalThis as unknown as { __cmMapBeacon?: (h: string, f: string[]) => void }).__cmMapBeacon?.(String(url), names(data));
    } catch {
      // told or not, nothing is sent
    }
    return true;
  };
}

/**
 * Runs in every page before its own scripts: a <script type=speculationrules> a script makes is made
 * inert before it joins the page (the type is changed as it is set), feature checks say there are no
 * speculation rules (so libraries fall back to <link rel=prefetch>, which the route sees), and one that
 * gets in anyway is taken out. Self-contained.
 */
function noSpeculation() {
  const S = (globalThis as unknown as { HTMLScriptElement?: { prototype: HTMLScriptElement; supports?: (t: string) => boolean } }).HTMLScriptElement;
  if (!S) return;
  const inert = (t: unknown) => (typeof t === "string" && /^\s*speculationrules\s*$/i.test(t) ? "text/x-held-speculationrules" : t);
  const typeDesc = Object.getOwnPropertyDescriptor(S.prototype, "type");
  if (typeDesc?.set) {
    Object.defineProperty(S.prototype, "type", { ...typeDesc, set(this: HTMLScriptElement, v: unknown) { typeDesc.set!.call(this, inert(v)); } });
  }
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    return setAttr.call(this, name, this instanceof (S as unknown as typeof HTMLScriptElement) && String(name).toLowerCase() === "type" ? String(inert(value)) : value);
  };
  if (typeof S.supports === "function") {
    const was = S.supports.bind(S);
    S.supports = (t: string) => (/^\s*speculationrules\s*$/i.test(String(t)) ? false : was(t));
  }
  const sweep = (root: ParentNode) => {
    for (const el of root.querySelectorAll?.('script[type="speculationrules" i]') ?? []) el.remove();
  };
  try {
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) (n as Element).matches?.('script[type="speculationrules" i]') ? (n as Element).remove() : sweep(n as Element);
    }).observe(document, { childList: true, subtree: true });
  } catch {
    // no observer: the route's removal and the type setter still hold
  }
}

/** A graphql-ws "subscribe" frame's operation, if it is one. */
function socketGraphql(text: string): HeldClue["graphql"] | undefined {
  try {
    const o = JSON.parse(text) as { payload?: { query?: unknown; operationName?: unknown } };
    return o?.payload && (typeof o.payload.query === "string" || typeof o.payload.operationName === "string") ? graphqlOf(JSON.stringify(o.payload)) : undefined;
  } catch {
    return undefined;
  }
}

/** A clue's verb, from its method and path only (REST-shaped addresses), or undefined when it can't say. */
export function clueVerb(c: Pick<HeldClue, "method" | "path" | "graphql">): "create" | "update" | "delete" | undefined {
  if (c.graphql) {
    const name = c.graphql.operations[0] ?? "";
    const first = /^[a-z]+/.exec(name.replace(/^[A-Z]/, (x) => x.toLowerCase()))?.[0] ?? "";
    return VERB_WORDS[first];
  }
  if (c.method === "DELETE") return "delete";
  if (c.method === "PUT" || c.method === "PATCH") return "update";
  const parts = c.path.split("?")[0]!.split("/").filter(Boolean);
  for (const p of [...parts].reverse()) {
    const w = p.toLowerCase().replace(/[-_]/g, "");
    const v = VERB_WORDS[w];
    if (v) return v;
    if (p === ":id") continue;
    break;
  }
  if (c.method !== "POST") return undefined;
  // REST: a POST to a collection makes one, a POST to an item changes it.
  const last = parts.at(-1);
  if (!last) return undefined;
  if (last === ":id") return "update";
  return /s$/i.test(last) && !/^(api|graphql|rpc|actions?)$/i.test(last) ? "create" : undefined;
}

/** Words of an address or a control that name a write's kind. */
export const VERB_WORDS: Record<string, "create" | "update" | "delete"> = {
  create: "create", new: "create", add: "create", insert: "create", post: "create", make: "create",
  update: "update", edit: "update", save: "update", patch: "update", put: "update", rename: "update", setting: "update", settings: "update", toggle: "update", set: "update", change: "update", modify: "update",
  delete: "delete", remove: "delete", destroy: "delete", trash: "delete", del: "delete", rm: "delete",
};
