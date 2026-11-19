/**
 * Local extensions to the shared contract (../../contracts.ts) that the ui-run lane needs. Types only.
 * Each one is asked for as a contract change in INTEGRATE.md; until then the screens build against these.
 */
import type { LiveEvent, ScreenModule } from "../../contracts.ts";

/**
 * The live screen is hidden while a run types a secret (Wave 1 C20b). The server already sends no frame
 * in that window; this event says so, so the page can show "Screen hidden while a secret is typed"
 * instead of a frozen last frame. `hidden: false` ends the window (so does the step's stepEnd).
 */
export type ScreenEvent = { type: "screen"; id: string; hidden: boolean; words?: string };

/** The result event as ui-server sends it today: the result plus where its files are (ui-server.ts:426). */
export type ResultEventFull = Extract<LiveEvent, { type: "result" }> & {
  video?: string;
  /** The sign-in's own video (sign-in.webm), its boxes as dots, when the test signed in just before. */
  signInVideo?: string;
  report?: string;
  shots?: Record<string, string>;
  folder?: string;
  saved?: string;
  tokens?: string;
};

/**
 * What ui-server sends today around a test account's sign-in (Wave 1, ui-server.ts signedInRun), not
 * yet in the contract: the chip words ("Signed in as demo (session from 2m ago)") and the sign-in
 * window. Its frames are the sign-in page itself, live, with every box a stored value goes into as dots.
 */
export type SessionEvent = { type: "session"; id: string; words: string };
/** A sign-in begins or ends; `words` ("Signing in as admin…") is said over the live screen while it runs. */
export type SignInEvent = { type: "signin"; id: string; state: "start" | "end"; words?: string };

/** Every event the run screens read: the contract's plus the ones above. */
export type RunLiveEvent = LiveEvent | ScreenEvent | SessionEvent | SignInEvent;

/**
 * An always-mounted part of the page (not tied to a route): the Set up sign-in pop-up. Same shape as a
 * ScreenModule with `routes: []`; the shell renders it once, at boot, into its own root, and never
 * cleans it up while the page is open.
 */
export type OverlayModule = ScreenModule & { overlay: true };
