/**
 * Turns a concrete URL into a stable, value-free pattern:
 *   https://app.x.com/api/assessments/8812/publish?draft=1&token=abc
 *   => { path: "/api/assessments/:id/publish", queryKeys: ["draft", "token"] }
 */
const ID_SEGMENT = [
  /^\d+$/, // numeric ids
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // hex ids / hashes
  /@/, // emails in paths
  /^(?=.*\d)[A-Za-z0-9_-]{12,}$/, // opaque ids with digits (cuid, nanoid, base64url); readable slugs stay intact
  /^(?=.*\d)(?=.*[a-f])[0-9a-f]{8,}$/i, // short hex ids (a1b2c3d4)
  /^[A-Za-z]{1,6}[-_]?(?=[0-9a-f]*\d)[0-9a-f]{6,}$/i, // prefixed record ids (T-458aeccf, inv_00a91c)
  /^[A-Za-z]{1,6}[-_]?\d{4,}$/, // prefixed numbers (INV-00231, ORD12345)
  /^([A-Za-z]{1,6}[-_]?)?\d{2,}([-_.]\d+)+$/, // numbers in groups (RE-2026-001, INV-2024-0042, 2026-001, dates)
  /\s/, // free text (names, labels a person chose): never a route of the app itself
  /^[^/]+\.(jpe?g|png|gif|webp|heic|heif|svg|bmp|tiff?|pdf|docx?|xlsx?|pptx?|csv|txt|rtf|odt|zip|gz|tar|mp4|mov|webm|mp3|wav|m4a)$/i, // file names (uploads can be personal: "jane-passport.pdf")
];

/**
 * Letters-only tokens in reset and invite links ("kQzRmTnXpLwYvBsDhJgF") mix case at random.
 * Readable names mix case too ("angularJs-protractor", "BankingProject", "getting-started-API"),
 * but as words. Split at hyphens, underscores and camelCase humps, every piece is a word: an
 * acronym standing alone between hyphens, or letters with a vowel (when longer than two) and no
 * long run of consonants; and the words average four or more letters. Random case flips make
 * short, vowel-less pieces ("Rm", "kQz") and runs no language spells ("dxwzz").
 */
const LETTER_TOKEN = /^(?=.*[a-z])(?=.*[A-Z])[A-Za-z_-]{16,}$/;
const ACRONYM = /^[A-Z]{2,5}$/;

function letterToken(segment: string): boolean {
  if (!LETTER_TOKEN.test(segment)) return false;
  const pieces = segment.split(/[-_]+/).filter(Boolean);
  const words = pieces.flatMap((p) => (ACRONYM.test(p) ? [p] : p.split(/(?=[A-Z])/)));
  const isWord = (w: string) => ACRONYM.test(w) || (/^[A-Z]?[a-z]+$/.test(w) && (w.length <= 2 || /[aeiouy]/i.test(w)) && !/[^aeiouy]{5}/i.test(w));
  const readable = words.every(isWord) && segment.replace(/[-_]/g, "").length / words.length >= 4;
  return !readable;
}

/**
 * After these, the next segment names a person or organisation (/users/jane-smith,
 * /org/acme-holdings), unless it is one of the app's own pages (/users/new, /org/billing).
 */
const OWNER = /^(users?|u|people|persons?|members?|profiles?|orgs?|organi[sz]ations?|teams?|workspaces?|compan(y|ies)|customers?|clients?|accounts?|tenants?)$/i;
const OWN_PAGE = /^(new|edit|create|settings|billing|members|invite|invites|invitations|profile|security|preferences|notifications|list|all|me|import|export|integrations|plans?|usage|api|keys|roles|permissions|overview|admin|search|archived?)$/i;

/**
 * A segment that says what to do is one of the app's own routes, never someone's name: an account
 * API's sign-in and recovery endpoints sit right next to its records (/users/login,
 * /users/forgot-password, Devise's /users/sign_in and /users/password, /accounts/verify-email).
 * Words only (no digits), with one of them a verb or a word for the signed-in person.
 */
const ROUTE_WORD = /^(login|logout|logon|logoff|signin|signout|signup|sign|log|register|registration|forgot|reset|change|update|verify|verification|confirm|confirmation|activate|deactivate|refresh|resend|recover|recovery|unlock|password|passwords|me|self|current|whoami|exists|check|validate|lookup|search|batch|bulk|count)$/i;

export function isRouteWord(segment: string): boolean {
  if (!/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(segment) && !/^[a-z]+(?:[A-Z][a-z]+)+$/.test(segment)) return false;
  return segment.split(/[-_]+|(?<=[a-z])(?=[A-Z])/).some((word) => ROUTE_WORD.test(word));
}

/**
 * A long, readable slug under a collection is one item of content (a post, an article, a product):
 * /article/how-we-cut-our-build-times-in-half, /blog/what-to-do-after-a-late-payment-1. Its words
 * are the item's title, often someone's own, so it is a record like any id. An app's own pages
 * have short names (/about-us, /terms-of-service, /settings/two-factor-auth), and a page at the top
 * level is never collapsed.
 */
const CONTENT_SLUG_WORDS = 5;

function contentSlug(segment: string): boolean {
  return segment.split(/[-_+.:,;!?'’]+/).filter((w) => /\p{L}/u.test(w)).length >= CONTENT_SLUG_WORDS;
}

const MAX_SEGMENTS = 24;

export interface NormalizedUrl {
  origin: string;
  path: string;
  queryKeys: string[];
}

/**
 * `routeKeys` is for a learner reading a site that routes by its query (index.php?page=invoices,
 * admin.php?page=, ?route=, ?title=): those keys' values pick the document, so they are part of the
 * pattern, cleaned like any path segment. A record picked by the query (/user?id=jane) is then
 * ":id" too, as it would be in a path. Never passed by the hosted snippet's default, which keeps
 * only the keys' names: paths on the wire don't change.
 */
export function normalizeUrl(input: string, base: string, routeKeys?: readonly string[]): NormalizedUrl | undefined {
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    return undefined;
  }
  const path = `/${segmentsOf(url.pathname).join("/")}${routeKeys ? routeQuery(url.searchParams, routeKeys) : ""}`;
  // Hash routing (/#/contacts/new, /#!/contacts): the part after "#" is the page. Only a hash
  // that looks like a route counts, so anchors and tokens (#access_token=…) are never read.
  const hashRoute = /^#!?(\/[^?]*)/.exec(url.hash)?.[1];
  const queryKeys = [...new Set([...url.searchParams.keys()])].slice(0, 32).map((k) => k.slice(0, 64));
  // A file takes no slash: /docs/index.html#/Accounts opens the app, /docs/index.html/#/Accounts is a 404.
  if (hashRoute) return { origin: url.origin, path: `${path === "/" ? "" : path}${/\.[A-Za-z0-9]+$/.test(path) ? "" : "/"}#/${segmentsOf(hashRoute).join("/")}`, queryKeys };
  return { origin: url.origin, path, queryKeys };
}

/** Keys that name a record, not a page: ?id=, ?user=, ?invoice_id=, ?customerId=. */
const RECORD_KEY = /^(id|uid|uuid|slug|user|username|[a-z]+[_-]id|[a-z]+Id)$/;

function routeQuery(query: URLSearchParams, routeKeys: readonly string[]): string {
  const routes: string[] = [];
  const records: string[] = [];
  for (const key of new Set(query.keys())) {
    const value = query.get(key) ?? "";
    if (!value) continue;
    // Behind a dummy segment, so a long slug counts as content: only the first segment of a path escapes that rule.
    if (routeKeys.includes(key)) routes.push(`${key}=${segmentsOf(`/x/${encodeURI(value)}`).slice(1).join("/")}`);
    else if (RECORD_KEY.test(key)) records.push(`${key}=:id`);
  }
  const all = [...routes.sort(), ...records.sort()];
  return all.length ? `?${all.join("&")}` : "";
}

/**
 * Which query keys route a site, from the links seen on it: one that takes several values that are
 * words, not ids, on the same address. A key's name can rule it out (paging, sorting, tracking and
 * language leave the document the same) and a route-like name asks for less evidence. It is only a
 * candidate: the pages fetched under two of its values must then read differently (that's the crawl's
 * test), since ?view=grid and ?view=list are one document. For the learner, never the hosted snippet.
 */
const NOT_A_ROUTE = /^(utm_.*|gclid|fbclid|ref|source|src|sort|sortby|sort_by|order|orderby|order_by|dir|direction|lang|locale|hl|currency|theme|q|query|search|s|limit|offset|size|per_page|perpage|filter|from|to|next|back|return|redirect|token|session|sid)$/i;
const ROUTE_KEY = /^(page|p|route|r|title|view|module|section|controller|screen|action|do)$/i;
const WORD_VALUE = /^[A-Za-z][\w./:-]*$/;
const ROUTE_VALUES = 2;
const ANY_KEY_VALUES = 3;

export function routeKeysOf(hrefs: readonly string[], base: string): string[] {
  const values = new Map<string, Set<string>>();
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    for (const [key, value] of url.searchParams) {
      const seen = values.get(key) ?? values.set(key, new Set()).get(key)!;
      seen.add(value);
    }
  }
  return [...values].filter(([key, seen]) => !NOT_A_ROUTE.test(key) && [...seen].every((v) => WORD_VALUE.test(v) && segmentsOf(`/${v}`).every((s) => s !== ":id")) && seen.size >= (ROUTE_KEY.test(key) ? ROUTE_VALUES : ANY_KEY_VALUES)).map(([key]) => key).sort();
}

export function segmentsOf(pathname: string): string[] {
  const out: string[] = [];
  // Path parameters after ";" (about.htm;jsessionid=204D87B…, /products;sort=price) are state the
  // server or router carries in the address, not a different page: Java servlets put the session
  // there when cookies are off, and routers keep options there. An encoded ";" (%3B) is kept.
  const segments = pathname.split("/").map((s) => s.split(";")[0] ?? "");
  for (const segment of segments.filter(Boolean).slice(0, MAX_SEGMENTS)) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep the raw segment
    }
    const owner = OWNER.test(out[out.length - 1] ?? "") && !OWN_PAGE.test(decoded) && !isRouteWord(decoded);
    const content = out.length > 0 && contentSlug(decoded);
    out.push(owner || content || ID_SEGMENT.some((p) => p.test(decoded)) || letterToken(decoded) ? ":id" : decoded.slice(0, 64));
  }
  return out;
}

/** Matches a normalised path against a site-model pattern ("*" matches one segment, ":id" matches ":id"). */
export function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return false;
  return p.every((seg, i) => seg === "*" || seg === s[i] || (seg.startsWith(":") && s[i] === ":id"));
}
