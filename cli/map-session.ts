/**
 * The look-only map, signed in as the run's account (any-site plan 5.2, wave M1): the account's
 * session comes from the sign-in helper every run uses (signin.ts ensureSession: a saved session,
 * checked or replayed), the walk's "still signed in?" check after every page is the account's own
 * signed-in check (signedInCheckFor), and a session lost on the way (often because map mode holds the
 * keep-alive or token-refresh POST) is replaced once more by ensureSession with force.
 *
 * The map never writes the session back: mapcrawl.ts opens its own context from the file and throws
 * it away, IndexedDB and local storage with it, so an outbox can't replay a held save in a later run.
 */
import type { Browser } from "playwright";
import { mapSite, type MapOptions, type MapRun } from "../packages/scanner/src/tester/mapcrawl.ts";
import { ensureSession, signedInCheckFor, type SessionNeed, type SessionResult } from "./signin.ts";

export type MapSignedIn = { map: MapRun } | { blocked: string };

/** The session helper, as mapSignedIn uses it (a stand-in in tests). */
export type EnsureSession = (need: SessionNeed, o?: { force?: boolean }) => Promise<SessionResult>;

/** Maps `need.url` signed in as `need.account`, or says why it can't sign in. */
export async function mapSignedIn(need: SessionNeed & { browser: Browser }, o: Omit<MapOptions, "url" | "browser" | "storageState" | "signedIn" | "signInAgain" | "signedInAs"> = {}, ensure: EnsureSession = ensureSession): Promise<MapSignedIn> {
  const first = await ensure(need);
  if ("blocked" in first) return { blocked: first.blocked };
  const map = await mapSite({
    ...o,
    url: need.url,
    browser: need.browser,
    storageState: first.path,
    signedIn: signedInCheckFor(need.account),
    signedInAs: need.account.label,
    signInAgain: async () => {
      const again = await ensure(need, { force: true });
      return "path" in again ? again.path : undefined;
    },
  });
  return { map };
}
