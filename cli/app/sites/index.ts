/**
 * The sites lane's entry points.
 *   - startPracticeSite: the contract's StartPracticeSite, for S1's "Try the practice site" and
 *     SetupState.practiceUrl. It is the bug garden: a small shop where Discovery finds real bugs.
 *   - startAppSites: all three practice sites, for the bench (tasks.ts APP_TASKS) and tests.
 */
import type { StartPracticeSite } from "../contracts.ts";
import { startBugGarden, type GardenSite } from "./garden.ts";
import { startNotesApp, type NotesSite } from "./notes.ts";
import { startProtectSites, type ProtectSites } from "./protect.ts";
import type { AppSite } from "./tasks.ts";

export const startPracticeSite: StartPracticeSite = (o) => startBugGarden(o);

export interface AppSites {
  garden: GardenSite;
  protect: ProtectSites;
  notes: NotesSite;
  /** A task's start address: its site's origin plus its path. */
  urlFor(site: AppSite, path: string): string;
  /** The site's hits (path + query), for the Oracle. */
  hitsOf(site: AppSite): string[];
  close(): Promise<void>;
}

export async function startAppSites(): Promise<AppSites> {
  const [garden, protect, notes] = await Promise.all([startBugGarden(), startProtectSites(), startNotesApp()]);
  const base = (s: AppSite) => (s === "garden" ? garden.url : s === "protect" ? protect.url : notes.url);
  return {
    garden,
    protect,
    notes,
    urlFor: (s, path) => new URL(path, base(s)).href,
    hitsOf: (s) => (s === "garden" ? garden.hits() : s === "protect" ? protect.hits() : notes.hits()),
    close: async () => { await Promise.all([garden.close(), protect.close(), notes.close()]); },
  };
}

export * from "./garden.ts";
export * from "./notes.ts";
export * from "./protect.ts";
export * from "./tasks.ts";
export { applyInput, checkInput, clickOn, centre, INPUT_LIMITS, play } from "./person.ts";
