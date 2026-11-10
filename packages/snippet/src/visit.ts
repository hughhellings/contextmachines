/**
 * One visit per person, across full page loads and across the site's own subdomains
 * (www.acme.com → app.acme.com), so a journey from the marketing site into the app is
 * one journey. Kept in a first-party cookie holding only a random id and when it was
 * last used; it ends after 30 minutes without activity. Never shared with other sites.
 */
const COOKIE = "__ctx_visit";
export const VISIT_IDLE_MS = 30 * 60_000;

export interface Visit {
  id: string;
  /** Call on activity: keeps the visit alive. Cheap; writes at most once a minute. */
  touch(): void;
}

export function startVisit(win: Window & typeof globalThis, now: () => number, useCookie: boolean): Visit {
  const doc = win.document;
  const read = (): { id: string; at: number } | undefined => {
    if (!useCookie) return undefined;
    try {
      const raw = doc.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const [id, at] = (raw ?? "").split(".");
      return id && /^[a-f0-9-]{16,40}$/.test(id) && Number(at) > 0 ? { id, at: Number(at) } : undefined;
    } catch {
      return undefined; // cookies blocked: one visit per page load
    }
  };
  const previous = read();
  const id = previous && now() - previous.at < VISIT_IDLE_MS ? previous.id : randomId(win);
  const domain = useCookie ? sharedDomain(win) : undefined;
  let writtenAt = 0;
  const write = () => {
    if (!useCookie) return;
    writtenAt = now();
    try {
      const secure = win.location.protocol === "https:" ? "; Secure" : "";
      doc.cookie = `${COOKIE}=${id}.${writtenAt}; path=/; max-age=${VISIT_IDLE_MS / 1000}; SameSite=Lax${domain ? `; domain=${domain}` : ""}${secure}`;
    } catch {
      // cookies blocked
    }
  };
  write();
  return {
    id,
    touch: () => {
      if (now() - writtenAt > 60_000) write();
    },
  };
}

/**
 * The broadest domain this page may set a cookie on ("acme.com" on app.acme.com), found the
 * way browsers allow it: a cookie on a public suffix ("co.uk") is refused, so the shortest
 * domain that accepts a test cookie is the site's own. Undefined for localhost and IP addresses.
 */
export function sharedDomain(win: Window & typeof globalThis): string | undefined {
  const host = win.location.hostname;
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return undefined;
  const parts = host.split(".");
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts.slice(i).join(".");
    try {
      win.document.cookie = `${COOKIE}_probe=1; path=/; max-age=5; domain=${candidate}`;
      const accepted = win.document.cookie.includes(`${COOKIE}_probe=1`);
      win.document.cookie = `${COOKIE}_probe=; path=/; max-age=0; domain=${candidate}`;
      if (accepted) return candidate;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const BROWSER_COOKIE = "__ctx_browser";
const BROWSER_MAX_AGE_S = 395 * 86_400;

/**
 * A random id that says "this browser has been here before", so returning visitors can be
 * counted when the site passes no user id. Off unless the site turns it on (rememberBrowser):
 * it is a long-lived cookie, so the site's cookie notice should mention it. It holds nothing
 * but the random id, is first-party, and is never shared with other sites.
 */
export function rememberBrowser(win: Window & typeof globalThis): string | undefined {
  try {
    const doc = win.document;
    const raw = doc.cookie.split("; ").find((c) => c.startsWith(`${BROWSER_COOKIE}=`))?.slice(BROWSER_COOKIE.length + 1);
    const id = raw && /^[a-f0-9-]{16,40}$/.test(raw) ? raw : randomId(win);
    const domain = sharedDomain(win);
    const secure = win.location.protocol === "https:" ? "; Secure" : "";
    doc.cookie = `${BROWSER_COOKIE}=${id}; path=/; max-age=${BROWSER_MAX_AGE_S}; SameSite=Lax${domain ? `; domain=${domain}` : ""}${secure}`;
    return doc.cookie.includes(`${BROWSER_COOKIE}=${id}`) ? id : undefined;
  } catch {
    return undefined; // cookies blocked: visits only
  }
}

function randomId(win: Window & typeof globalThis): string {
  const c = win.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
