import type { Expr } from "@contextmachines/rules-core";
import type { LearnedAction, SiteModelSnapshot } from "../learn/learner.ts";
import type { Goal } from "./goals.ts";
import { isRead, isUpkeep } from "../learn/naming.ts";
import { progressKey } from "./progress.ts";

/**
 * Layer 1: lifecycle goals from site structure alone. Almost every product's
 * success has the same shape: set up, do the core thing once (activation), keep
 * doing it (habit), discover more (depth). Only *which* action and pages play
 * those roles differs per site, and the site model already knows that.
 *
 * These are hypotheses: they carry the structural reason they exist, start at
 * the lowest confidence, and are confirmed or retired by usage data later.
 */

export type Stage = "setup" | "activation" | "habit" | "depth";

export interface CoreAction {
  action: LearnedAction;
  /** Why it was picked, in words. */
  reason: string;
  /** True when it was caused by a user's click/submit (strong); false when inferred from volume only. */
  userTriggered: boolean;
}

export interface LifecycleResult {
  core?: CoreAction;
  goals: Goal[];
  notes: string[];
}

const WRITE = new Set(["POST", "PUT", "PATCH"]);
/** A save: a writing method, and not a read that happens to use POST. */
const saves = (a: LearnedAction) => WRITE.has(a.method) && !isRead(a);
/** Plumbing, not product: auth, tracking, sessions, heartbeats. Never the "core action". */
export const NOT_PRODUCT = /(^|[\s._/-])(auth|oauth|login|logout|signin|sign_in|signout|session|sessions|token|tokens|signup|sign_up|register|password|otp|mfa|2fa|verify|track|tracking|telemetry|analytics|metrics|beacon|events?|logs?|ping|heartbeat|presence|healthz?|csrf|consent|cookies?)($|[\s._/-])/i;
const SETUP = /(setting|set-?up|onboard|getting.?started|welcome|connect|integration|import|profile|preference|configur|account)/i;
export const AUTH_PAGE = /(login|log-in|signin|sign-in|signup|sign-up|register|forgot|reset|password|verify|logout|callback|oauth|sso)/i;
const MAX_DEPTH_GOALS = 5;
/** Fewer presses of the busiest save than this say more about the order it was explored in than about the product. */
const FEW_PRESSES = 10;

export function lifecycleGoals(site: SiteModelSnapshot): LifecycleResult {
  const notes: string[] = [];
  const goals: Goal[] = [];
  const core = findCoreAction(site.actions);
  if (!core) notes.push("No core action yet: waiting for a user-initiated save/create in real traffic (the scanner never writes).");

  const coreKey = core ? progressKey(core.action.id) : undefined;
  const coreName = core ? (core.action.uiLabel ?? core.action.label) : undefined;
  const corePages = new Set(core ? Object.keys(core.action.triggerPages) : []);

  if (core && coreKey && coreName) {
    goals.push(goal({
      id: "lifecycle.activation",
      stage: "activation",
      title: `First "${coreName}"`,
      message: `Ready to ${lower(coreName)}? It only takes a moment.`,
      why: `Activation: the core action of this product appears to be "${coreName}" (${core.reason}).`,
      done: gte(`actions.${coreKey}.count`, 1),
      priority: 48,
      basis: core.reason,
      ...(firstKey(core.action.triggerPages) ? { target: { page: firstKey(core.action.triggerPages) as string, action: core.action.id } } : { target: { action: core.action.id } }),
    }));
    goals.push(goal({
      id: "lifecycle.habit",
      stage: "habit",
      title: `"${coreName}" on 3 different days`,
      message: `Coming back to ${lower(coreName)} regularly is where the value builds up.`,
      why: "Habit: products are most useful to people who use the core action repeatedly, on separate days.",
      done: { op: "and", args: [gte(`actions.${coreKey}.count`, 3), gte("user.activeDays", 3)] },
      eligible: gte(`actions.${coreKey}.count`, 1),
      priority: 44,
      basis: core.reason,
    }));
  }

  // Setup: pages whose name says setup/connect/import and that have something to fill in or a write triggered there.
  const pages = site.pages.filter((p) => !AUTH_PAGE.test(p.path) && !AUTH_PAGE.test(p.snapshot.title ?? ""));
  for (const page of pages) {
    const text = `${page.path} ${page.snapshot.title ?? ""} ${page.snapshot.headings.join(" ")}`;
    if (!SETUP.test(text)) continue;
    const hasForm = page.snapshot.forms.some((f) => f.fields.length > 0);
    const writeHere = site.actions.find((a) => saves(a) && a.review !== "ignored" && a.triggerPages[page.path] !== undefined && !NOT_PRODUCT.test(`${a.id} ${a.path}`));
    if (!hasForm && !writeHere) continue;
    const name = pageName(page.path, page.snapshot.title, page.snapshot.headings);
    goals.push(goal({
      id: `lifecycle.setup.${progressKey(page.path)}`,
      stage: "setup",
      title: `Complete ${name}`,
      message: `Finish setting up ${name} to get the most out of it.`,
      why: `Setup: "${name}" looks like a setup step (${writeHere ? `users save "${writeHere.uiLabel ?? writeHere.label}" there` : "it has a form to fill in"}).`,
      done: writeHere ? gte(`actions.${progressKey(writeHere.id)}.count`, 1) : gte(`pages.${progressKey(page.path)}.count`, 1),
      priority: 47,
      basis: writeHere ? `write action ${writeHere.method} ${writeHere.path} triggered on ${page.path}` : `form on ${page.path}`,
      target: { page: page.path },
    }));
  }

  // Depth: substantial pages beyond the core and setup, once the user has activated.
  const setupPaths = new Set(goals.filter((g) => g.id.startsWith("lifecycle.setup.")).map((g) => g.target?.page));
  const depth = pages
    .filter((p) => p.path !== "/" && !corePages.has(p.path) && !setupPaths.has(p.path))
    .filter((p) => p.snapshot.headings.length > 0 && (p.snapshot.forms.length > 0 || p.snapshot.buttons.length >= 3))
    .sort((a, b) => b.seen - a.seen)
    .slice(0, MAX_DEPTH_GOALS);
  for (const page of depth) {
    const name = pageName(page.path, page.snapshot.title, page.snapshot.headings);
    goals.push(goal({
      id: `lifecycle.depth.${progressKey(page.path)}`,
      stage: "depth",
      title: `Explore ${name}`,
      message: `Have you looked at ${name} yet?`,
      why: `Depth: "${name}" is a substantial part of the product beyond the core action.`,
      done: gte(`pages.${progressKey(page.path)}.count`, 1),
      eligible: coreKey ? gte(`actions.${coreKey}.count`, 1) : gte("user.sessions", 2),
      priority: 40,
      basis: `page ${page.path}: ${page.snapshot.headings.length} headings, ${page.snapshot.forms.length} forms, ${page.snapshot.buttons.length} buttons, visited ${page.seen} times`,
      target: { page: page.path },
    }));
  }
  if (site.pages.length === 0) notes.push("No page structure yet: install the snippet or run a scan.");
  const result: LifecycleResult = { goals, notes };
  if (core) result.core = core;
  return result;
}

/**
 * The core action is the thing people come to the product to make: the save they cause most
 * by pressing something, weighted so that
 *   - creating something (an invoice, a post, a report) beats editing one, and deleting never counts;
 *   - a save set off by many unrelated presses (a background sync after any click, or a row of
 *     tag chips) counts for less than one with a clear button of its own ("Save invoice");
 *   - one- or two-letter presses (B, I, U in an editor) don't count at all.
 * Plumbing (auth, tracking, sessions) is excluded. Volume without a user trigger is a weaker
 * fallback and is marked as such.
 */
export function findCoreAction(actions: readonly LearnedAction[]): CoreAction | undefined {
  const candidates = actions.filter((a) => saves(a) && a.review !== "ignored" && a.method !== "DELETE" && !isUpkeep(a) && !NOT_PRODUCT.test(`${a.id} ${a.path} ${a.uiLabel ?? ""}`));
  // Presses that went through: a button people keep pressing because it fails is a problem, not the product's core.
  const triggered = candidates
    .map((a) => {
      const presses = a.triggers.filter((t) => t.label.trim().length > 2);
      const total = presses.reduce((n, t) => n + t.count, 0);
      const top = presses.reduce((m, t) => Math.max(m, t.count), 0);
      const scattered = presses.length >= 4 && top / Math.max(1, total) < 0.4;
      const score = total * successShare(a) * (creates(a) ? 1 : 0.5) * (scattered ? 0.3 : 1);
      const button = [...presses].sort((x, y) => y.count - x.count)[0]?.label;
      return { a, presses: Math.round(total * successShare(a)), score, button, scattered };
    })
    .filter((c) => c.presses > 0)
    .sort((x, y) => y.score - x.score || y.a.seen - x.a.seen || x.a.id.localeCompare(y.a.id));
  // Too few presses to say that editing is what the product is for: making something beats changing it.
  const best = (triggered[0] && triggered[0].presses < FEW_PRESSES ? triggered.find((c) => creates(c.a)) : undefined) ?? triggered[0];
  if (best) {
    const how = `${creates(best.a) ? "creates something" : "changes something"}${best.scattered ? ", though many different presses set it off" : ""}`;
    // A button name still held back (fewer than 3 people have seen it) is never quoted.
    const named = best.button && !best.button.startsWith("held:") ? `"${best.button}"` : "its button";
    return { action: best.a, userTriggered: true, reason: `the save people cause most with a button of its own: ${named} pressed ${best.presses} times, sending ${best.a.method} ${best.a.path} (${how})` };
  }
  const byVolume = [...candidates].sort((x, y) => Number(creates(y)) - Number(creates(x)) || y.seen - x.seen || x.id.localeCompare(y.id))[0];
  return byVolume ? { action: byVolume, userTriggered: false, reason: `the most frequent write (${byVolume.method} ${byVolume.path}, ${byVolume.seen} times); no button press linked yet, so lower confidence` } : undefined;
}

/** Makes something new: POST to a collection, or a verb that produces something (run, generate, import, send). */
function creates(a: LearnedAction): boolean {
  const verb = a.id.split(".").at(-1) ?? "";
  if (a.method === "POST" && !/update|delete|remove|archive/.test(verb)) return true;
  return /^(create|add|import|run|generate|send|publish|submit|upload)$/.test(verb);
}

/** Share of an action's requests that succeeded; 1 when no statuses were seen. Statuses are kept by class ("2xx", "5xx", "failed" = network error, "app_failed" = errors with a 2xx). */
function successShare(a: LearnedAction): number {
  let ok = 0;
  let failed = 0;
  for (const [status, n] of Object.entries(a.statuses)) {
    if (status.startsWith("wall_")) continue; // says nothing about whether the button works
    if (/^[45]|failed/.test(status)) failed += n;
    else ok += n;
  }
  return ok + failed === 0 ? 1 : ok / (ok + failed);
}

function goal(input: { id: string; stage: Stage; title: string; message: string; why: string; done: Expr; eligible?: Expr; priority: number; basis: string; target?: Goal["target"] }): Goal {
  const g: Goal = {
    id: input.id.slice(0, 128),
    version: 1,
    status: "approved",
    origin: "lifecycle",
    stage: input.stage,
    confidence: "hypothesis",
    title: input.title.slice(0, 120),
    message: input.message.slice(0, 500),
    why: input.why.slice(0, 500),
    done: input.done,
    priority: input.priority,
    cooldownHours: 72,
    maxSuggestions: 2,
    basis: input.basis,
  };
  if (input.eligible) g.eligible = input.eligible;
  if (input.target) g.target = input.target;
  return g;
}

const gte = (path: string, n: number): Expr => ({ op: "gte", left: { var: path }, right: { lit: n } });

function pageName(path: string, title: string | undefined, headings: string[]): string {
  const fromTitle = title?.split(/\s[|·–-]\s/)[0]?.trim();
  return fromTitle || headings[0] || path;
}

function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function firstKey(record: Record<string, number>): string | undefined {
  return Object.entries(record).sort((a, b) => b[1] - a[1])[0]?.[0];
}
