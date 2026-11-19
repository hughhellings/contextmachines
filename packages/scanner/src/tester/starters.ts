/**
 * Starter tests from what `learn` walked: each journey it walked to its end becomes a draft saved
 * test (the same JSON as a test that passed, with `draft: true`), so a first `npx contextmachines
 * test` has something to run. No AI and no browser here.
 *
 * A draft knows what was pressed and filled, by the words on the screen, but not the elements' roles,
 * so its steps have no actions yet: its first run asks the AI to do each step (a form is filled with
 * plainly made-up values), and a full pass saves it as a plain test that replays with no AI. Each step
 * checks the address it should reach where the walk moved to another screen; a journey whose last
 * step can't be checked that way gets no starter, since a test that measures nothing proves nothing.
 */
import { existsSync } from "node:fs";
import type { WalkedJourney } from "../journeys.ts";
import { savedPathFor, slugOf, writeSaved, type SavedStep, type SavedTest } from "./cache.ts";
import { DEFAULTS } from "./run.ts";
import type { Check } from "./types.ts";

export type StarterTest = Omit<SavedTest, "version" | "savedAt"> & { draft: true };

/** A screen as an address part to look for: "/invoices/:id" → "/invoices/". Nothing when that's only "/". */
export function addressPart(screen: string): string | undefined {
  if (!screen.startsWith("/")) return undefined;
  const at = screen.search(/\/[:*[{]/);
  const part = at < 0 ? screen : screen.slice(0, at + 1);
  return part.length > 1 ? part : undefined;
}

const quoted = (label: string) => `'${label.replace(/\s+/g, " ").trim().slice(0, 60)}'`;

/** A walked step as a draft's step, before its check: what to do, in words the actor follows. */
function stepOf(step: WalkedJourney["steps"][number]): Pick<SavedStep, "title" | "intent"> | undefined {
  const label = step.label?.trim();
  if (step.did === "press" && label) return { title: `Click ${quoted(label)}`, intent: `Click ${quoted(label)}` };
  if (step.did === "fill" && label === "the box") return { title: "Type into the box and send it", intent: 'Type a made-up test value into the box (fill with value "auto") and send it' };
  if (step.did === "fill") {
    const form = label && label !== "the form" ? ` (${quoted(label)})` : "";
    return { title: `Fill in and send the form${form}`, intent: `Fill in the form${form} with made-up test values (fill or select with value "auto" for anything the form asks for) and send it` };
  }
  return undefined;
}

/**
 * The draft tests for the journeys that finished: only those, each from the screen it started on,
 * on the site `start` is on. Addresses that stand for a record ("/invoices/:id") can't be opened as
 * they are, so a journey that starts on one is left out.
 */
export function startersFrom(journeys: readonly WalkedJourney[], start: string): StarterTest[] {
  const origin = new URL(start).origin;
  const tests: StarterTest[] = [];
  const slugs = new Set<string>();
  for (const journey of journeys) {
    if (journey.outcome !== "finished" || journey.fromCode || journey.joins) continue;
    if (!/^\/[^:*[{]*$/.test(journey.from)) continue;
    // The walk as it was taken: a choice left for another on the same screen was no part of the way.
    const walked = journey.steps.filter((s) => !s.left);
    if (walked[0]?.did !== "open" || walked.some((s) => s.did === "stop")) continue;
    const doing = walked.slice(1);
    if (!doing.length || doing.length > DEFAULTS.maxSteps) continue;
    const steps: SavedStep[] = [];
    for (const [k, s] of doing.entries()) {
      const words = stepOf(s);
      if (!words) break;
      const next = doing[k + 1]?.screen ?? journey.ends;
      // A part the screen it starts on already has ("/trades" from "/trades/new") holds before
      // anything is done, so it measures nothing: that step gets no check of its own.
      const part = next && next !== s.screen ? addressPart(next) : undefined;
      const holdsAlready = part !== undefined && s.screen.startsWith("/") && s.screen.includes(part);
      const check: Check = part && !holdsAlready ? { kind: "url_contains", text: part } : { kind: "none" };
      steps.push({ ...words, check });
    }
    if (steps.length !== doing.length || steps.at(-1)!.check.kind === "none") continue;
    const goal = journey.name.replace(/\s+/g, " ").trim();
    const slug = slugOf(goal);
    if (!goal || slugs.has(slug)) continue;
    slugs.add(slug);
    tests.push({ goal, url: new URL(journey.from, origin).href, steps, draft: true });
  }
  return tests;
}

/** Writes each starter under testsDir/<host>/, never over a file that's there. The files written. */
export function writeStarters(testsDir: string, tests: readonly StarterTest[]): string[] {
  const written: string[] = [];
  for (const test of tests) {
    const path = savedPathFor(testsDir, test.goal, test.url);
    if (existsSync(path)) continue;
    writeSaved(path, test);
    written.push(path);
  }
  return written;
}

/**
 * Why `learn` wrote no starter test, in one line, so a run that wrote none says so: the journeys
 * weren't walked (and why), none was walked to its end, the ones that were can't be checked by an
 * address they reach, or each starter is already there.
 */
export function noStartersWhy(walk: { status: string; message?: string; journeys: readonly WalkedJourney[] }, start: string): string {
  const lead = "No starter tests written";
  // Where tests come from instead: `test` with only the address looks at the site and suggests tasks to
  // pick (a journey behind a sign-in is the usual reason). Only the site's origin is said: a start
  // address can carry a token in its query.
  let site = "<your site>";
  try {
    site = new URL(start).origin;
  } catch {
    // not an address: the placeholder stays
  }
  const pick = `try npx contextmachines test --url ${site} to pick tasks`;
  if (walk.status !== "walked") return `${lead}: ${(walk.message ?? "the journeys weren't walked").replace(/\.$/, "")}. ${pick[0]!.toUpperCase()}${pick.slice(1)}`;
  const finished = walk.journeys.filter((j) => j.outcome === "finished" && !j.fromCode && !j.joins);
  if (!finished.length) return `${lead}: no journey was walked to its end. ${pick[0]!.toUpperCase()}${pick.slice(1)}`;
  if (!startersFrom(walk.journeys, start).length) return `${lead}: the journeys walked to their end start on a record's screen or end where no address shows they worked, so a test of them would prove nothing. ${pick[0]!.toUpperCase()}${pick.slice(1)}`;
  return `${lead}: each one is already in tests/ (a file there is never replaced)`;
}
