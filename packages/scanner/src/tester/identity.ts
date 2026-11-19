/**
 * Cache identity (moved from cli/ci/identity.ts): a saved test keeps working when the app's
 * address changes (every Vercel preview has a new one). The project names its app once ("identity"
 * in contextmachines.config.json; cache.ts IDENTITY, folderFor, atHome). These are the address rules:
 * a navigation on the test's own origin is saved as a path, an old absolute one moves to the run's
 * origin at replay, and an absolute saved link href is compared on the new origin too. Only the saved
 * origin moves; every other address still goes through onSite.
 */

/**
 * A navigation on the test's own origin, saved as its path ("/pricing?x=1"), so the saved test replays
 * on another address of the same app. Another origin's address is kept whole (and onSite still rules
 * on it at replay). Replay already resolves an address against the page it is on.
 */
export function navigateToSave(url: string, start: string): string {
  try {
    const to = new URL(url, start);
    return to.origin === new URL(start).origin ? `${to.pathname}${to.search}${to.hash}` : url;
  } catch {
    return url;
  }
}

/**
 * For tests saved before navigateToSave: an absolute address on the saved test's own origin goes to
 * the same path on the origin the run started on. Only that origin moves; every other stays as it is.
 */
export function navigateOnReplay(to: string, savedOrigin: string | undefined, start: string): string {
  if (!savedOrigin) return to;
  const u = new URL(to);
  const here = new URL(start).origin;
  return u.origin === savedOrigin && savedOrigin !== here ? new URL(`${u.pathname}${u.search}${u.hash}`, here).href : to;
}

/**
 * A saved link's href, as a locator compares it, on the address the run is on: an absolute href on the
 * saved origin is compared by its path there too (frameworks that write absolute links would otherwise
 * never match on a preview). Relative hrefs, the common case, need nothing.
 */
export function hrefsToTry(href: string, savedOrigin: string | undefined, start: string): string[] {
  if (!savedOrigin || !/^https?:\/\//i.test(href)) return [href];
  try {
    const u = new URL(href);
    if (u.origin !== savedOrigin) return [href];
    const path = `${u.pathname}${u.search}${u.hash}`;
    return [href, new URL(path, start).href, path];
  } catch {
    return [href];
  }
}
