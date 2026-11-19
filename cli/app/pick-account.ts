/**
 * Which test account a run signs in as (as TesterArmy does: the project's accounts are there for every
 * test, and the one that fits is picked when the test signs in). Labels and "when to use" notes only:
 * never a username or password. Pure, so the server and the editor pick the same way.
 *
 * The order: the step's own account; the account the goal names ("as admin"); the project's default;
 * the only account; the one account whose label or "when to use" note the goal matches; else ask.
 */

import { NOT_SIGNING_IN } from "../../packages/scanner/src/tester/types.ts";

export { NOT_SIGNING_IN };

/** A goal or step that signs in ("Sign in and…", "log in as admin"). */
export const SIGNS_IN = /\b(sign(ing|s)?[ -]?in(to)?|log(ging|s)?[ -]?in(to)?|login)\b/i;

/** The sign-in page itself named as a thing ("the Log in page", "the sign-in form"): a visit, not a sign-in. */
const SIGN_IN_THING = /\b(?:sign|log)[ -]?in (?:page|form|screen|button|link|modal|dialog|box|fields?)\b|\blogin (?:page|form|screen|button|link|modal|dialog|box|fields?)\b/gi;

/**
 * Whether a goal signs in, so its run signs in as an account first: it says to sign in ("Sign in and
 * check…", "log in as admin"), and it isn't about being signed out or a sign-in meant to fail ("goes to
 * the login page when signed out", "a wrong password stays on /login"), nor only a visit to the sign-in
 * page ("Open the Log in page and check the form shows").
 */
export function goalSignsIn(goal: string): boolean {
  if (NOT_SIGNING_IN.test(goal)) return false;
  return SIGNS_IN.test(goal.replace(SIGN_IN_THING, " "));
}

/**
 * A goal that says nothing about signing in or out ("add a trade", "open the reports page"). It runs as
 * the project's account when it is clear which one (named, the default, or the only one), as TesterArmy
 * runs every test as the project's account: a site behind a sign-in is tested signed in, never sent to
 * its sign-in page with no account to use. A goal that names the sign-in page, a sign-out or a sign-in
 * meant to fail isn't quiet, so it keeps starting signed out.
 */
export function quietAboutSignIn(goal: string): boolean {
  return !SIGNS_IN.test(goal) && !NOT_SIGNING_IN.test(goal);
}

/** The account a goal quiet about signing in runs as: only one that's clear, never a guess between several. */
export function quietAccount(o: { goal: string; defaultAccount?: string; accounts: readonly PickableAccount[] }): string | undefined {
  if (!o.accounts.length || !quietAboutSignIn(o.goal)) return undefined;
  const pick = pickAccount(o);
  return "label" in pick && pick.why !== "matched" ? pick.label : undefined;
}

/** What the editor asks when it can't tell, and what a run with no one to ask ends BLOCKED with. */
export const PICK_ACCOUNT = "Pick the account to sign in as.";

export interface PickableAccount {
  label: string;
  whenToUse?: string;
}

export type AccountPick =
  | { label: string; why: "step" | "named" | "default" | "only" | "matched" }
  | { ask: string; missing?: string }
  | { none: true };

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "as", "is", "it", "use", "user", "account", "test", "tests", "when", "this", "that", "sign", "signs", "log", "page", "check", "loads", "load", "app", "be", "can", "my", "your"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** The account the goal names: "as admin", "as the viewer", "as viewer user". */
export function namedIn(goal: string, accounts: readonly PickableAccount[]): string | undefined {
  const hits = accounts.filter((a) => new RegExp(`\\bas\\s+(?:the\\s+|an?\\s+|my\\s+)?${esc(a.label)}\\b`, "i").test(goal));
  return hits.length === 1 ? hits[0]!.label : undefined;
}

/** The one account whose label, or a word of its "when to use" note, the goal says; none when two tie. */
export function matchedIn(goal: string, accounts: readonly PickableAccount[]): string | undefined {
  const g = words(goal);
  const scored = accounts.map((a) => {
    let score = new RegExp(`\\b${esc(a.label)}\\b`, "i").test(goal) ? 2 : 0;
    for (const w of words(a.whenToUse ?? "")) if (g.has(w)) score += 1;
    return { label: a.label, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return best > 0 && top.length === 1 ? top[0]!.label : undefined;
}

export function pickAccount(o: { goal: string; step?: string; defaultAccount?: string; accounts: readonly PickableAccount[] }): AccountPick {
  const has = (l: string | undefined) => Boolean(l && o.accounts.some((a) => a.label === l));
  if (!o.accounts.length) return { none: true };
  if (has(o.step)) return { label: o.step!, why: "step" };
  // The step's own account isn't here (another environment, or since deleted): said, never swapped for another.
  if (o.step) return { ask: `The Login step signs in as ${o.step}, and there's no ${o.step} account on this address (it has ${o.accounts.map((a) => a.label).join(", ")}). Pick one on the Login step, or add ${o.step} under Accounts.`, missing: o.step };
  const named = namedIn(o.goal, o.accounts);
  if (named) return { label: named, why: "named" };
  if (has(o.defaultAccount)) return { label: o.defaultAccount!, why: "default" };
  if (o.accounts.length === 1) return { label: o.accounts[0]!.label, why: "only" };
  const matched = matchedIn(o.goal, o.accounts);
  if (matched) return { label: matched, why: "matched" };
  return { ask: `${PICK_ACCOUNT} This project has ${o.accounts.map((a) => a.label).join(", ")} and no default: say "as ${o.accounts[0]!.label}" in the goal, pick one on the Login step, or set a default test account in Settings.` };
}

