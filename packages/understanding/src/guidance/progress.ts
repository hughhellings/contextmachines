import type { CapturedEvent } from "@contextmachines/schemas";
import { wallOf, type Wall } from "../walls.ts";

/**
 * Per-user progress: what this user has done in the product, how often, and
 * where it went wrong. It is the memory the guidance engine reasons over.
 *
 * Updated only by `applyEvents` (pure). Bounded in size. Keys are encoded so
 * they can be addressed from rule expressions (see `progressKey`).
 */

export interface UsageStat {
  count: number;
  failures: number;
  firstAt: number;
  lastAt: number;
  /** The app's own reason the last time it failed for them ("missing_title"), when it gave one. */
  lastError?: string;
}

export type Who = "user" | "browser" | "visit";
/** What kind of person an id names (see personOf). */
export const whoOf = (id: string): Who => (id.startsWith("visit:") ? "visit" : id.startsWith("browser:") ? "browser" : "user");

export interface Progress {
  v: 1;
  /** Who this record is: a signed-in user, a returning browser, or one visit. Filled in when read. */
  who?: Who;
  /** The id it's kept under (a user id, "browser:…" or "visit:…"). Filled in when read. */
  id?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  sessions: number;
  /** Distinct UTC days with activity (bounded list of yyyy-mm-dd). */
  activeDays: string[];
  actions: Record<string, UsageStat>;
  pages: Record<string, UsageStat>;
  /** Their plan or tier and their role, as the site last told us. */
  plan?: string;
  role?: string;
  /** Actions that replied "not for you" (plan, role or limit): kept apart from failures. */
  walls?: Record<string, UsageStat & { wall: Wall }>;
  lastSessionId?: string;
  /** Where the user is now (canonical page path) and since when. Context, not counting. */
  current?: { page: string; since: number };
  /** Their last few actions, newest last (action ids only). */
  recentActions?: { id: string; at: number; failed: boolean }[];
  /** Signs of struggle in the last day, newest last (control labels / field names only, never values). */
  recentStruggles?: { type: string; page: string; target?: string; count?: number; at: number }[];
}

const MAX_RECENT = 10;
/** Stuck moments are kept two weeks (at most 20), so the weekly report can say where people stopped and why. Help and the Context API only use the last day. */
const MAX_STRUGGLES = 20;
const RECENT_STRUGGLE_MS = 14 * 24 * 3_600_000;

const MAX_ACTIONS = 200;
const MAX_PAGES = 200;
const MAX_DAYS = 120;
const DAY_MS = 86_400_000;

/**
 * Action ids and page paths become expression-safe keys:
 *   "invoice.create" → "invoice_create", "/reports" → "_reports", "/invoices/:id" → "_invoices__id".
 */
export function progressKey(idOrPath: string): string {
  const key = idOrPath.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "_";
  // Never let a site's path or action name become an object-prototype key.
  return key === "__proto__" || key === "constructor" || key === "prototype" ? `k${key}` : key;
}

export function emptyProgress(at: number): Progress {
  return { v: 1, firstSeenAt: at, lastSeenAt: at, sessions: 0, activeDays: [], actions: {}, pages: {} };
}

export interface ProgressUpdate {
  progress: Progress;
  /** The last page and action in this batch: "the moment" the user is in. */
  moment: { page?: string; action?: string };
}

/** Folds one batch of a user's events into their progress. Pure: returns a new object. */
export function applyEvents(previous: Progress | undefined, sessionId: string, events: readonly CapturedEvent[], at: number, who: { plan?: string; role?: string } = {}): ProgressUpdate {
  const p: Progress = previous ? structuredClone(previous) : emptyProgress(at);
  const moment: ProgressUpdate["moment"] = {};
  if (who.plan) p.plan = who.plan;
  if (who.role) p.role = who.role;

  if (p.lastSessionId !== sessionId) {
    p.sessions++;
    p.lastSessionId = sessionId;
  }
  p.lastSeenAt = Math.max(p.lastSeenAt, at);
  const day = new Date(at).toISOString().slice(0, 10);
  if (!p.activeDays.includes(day)) {
    p.activeDays.push(day);
    if (p.activeDays.length > MAX_DAYS) p.activeDays.splice(0, p.activeDays.length - MAX_DAYS);
  }

  for (const event of events) {
    if (event.kind === "route") {
      bump(p.pages, progressKey(event.path), at, false, MAX_PAGES);
      moment.page = progressKey(event.path);
    } else if (event.kind === "network" && event.actionId && wallOf(event)) {
      const key = progressKey(event.actionId);
      const walls = (p.walls ??= {});
      const wall = wallOf(event)!;
      const seen = walls[key];
      if (seen) Object.assign(seen, { count: seen.count + 1, lastAt: Math.max(seen.lastAt, at), wall });
      else if (Object.keys(walls).length < MAX_ACTIONS) walls[key] = { count: 1, failures: 0, firstAt: at, lastAt: at, wall };
      moment.action = key;
    } else if (event.kind === "network" && event.actionId) {
      const failed = event.failed === true || (event.status !== undefined && (event.status === 0 || event.status >= 400));
      bump(p.actions, progressKey(event.actionId), at, failed, MAX_ACTIONS, failed ? event.errorCode : undefined);
      moment.action = progressKey(event.actionId);
      p.recentActions = [...(p.recentActions ?? []), { id: event.actionId, at, failed }].slice(-MAX_RECENT);
    } else if (event.kind === "struggle") {
      const { type, page, target, count } = event;
      p.recentStruggles = [...(p.recentStruggles ?? []), { type, page, at, ...(target ? { target } : {}), ...(count !== undefined ? { count } : {}) }].slice(-MAX_STRUGGLES);
    }
    if ((event.kind === "route" || event.kind === "page") && p.current?.page !== event.path) p.current = { page: event.path, since: at };
  }
  if (p.recentStruggles) p.recentStruggles = p.recentStruggles.filter((s) => at - s.at < RECENT_STRUGGLE_MS);
  return { progress: p, moment };
}

function bump(map: Record<string, UsageStat>, key: string, at: number, failed: boolean, max: number, errorCode?: string) {
  const stat = map[key];
  if (!stat) {
    if (Object.keys(map).length >= max) return;
    map[key] = { count: failed ? 0 : 1, failures: failed ? 1 : 0, firstAt: at, lastAt: at, ...(errorCode ? { lastError: errorCode } : {}) };
    return;
  }
  if (failed) stat.failures++;
  else stat.count++;
  if (errorCode) stat.lastError = errorCode;
  stat.lastAt = Math.max(stat.lastAt, at);
}

/**
 * The view goal conditions are written against:
 *   user.sessions, user.activeDays, user.daysSinceFirstSeen
 *   actions.<key>.count / .failures / .daysSinceLast
 *   pages.<key>.count / .daysSinceLast
 *   moment.page / moment.action   (keys, e.g. "_reports", "trade_create")
 * A feature never used has no entry, so `exists` tests for "ever used".
 */
export function progressContext(p: Progress, moment: ProgressUpdate["moment"], now: number) {
  const view = (map: Record<string, UsageStat>) =>
    Object.fromEntries(Object.entries(map).map(([k, s]) => [k, { count: s.count, failures: s.failures, daysSinceLast: Math.floor((now - s.lastAt) / DAY_MS), ...(s.lastError ? { lastError: s.lastError } : {}) }]));
  return {
    user: { sessions: p.sessions, activeDays: p.activeDays.length, daysSinceFirstSeen: Math.floor((now - p.firstSeenAt) / DAY_MS) },
    actions: view(p.actions),
    pages: view(p.pages),
    /** Actions that replied "not for you" when they tried them. */
    walls: view(p.walls ?? {}),
    moment: { ...(moment.page ? { page: moment.page } : {}), ...(moment.action ? { action: moment.action } : {}) },
  };
}
export type ProgressContext = ReturnType<typeof progressContext>;

/** Counts at the moment a recurring goal was last achieved. */
export interface PeriodBaseline {
  actions: Record<string, number>;
  pages: Record<string, number>;
}

/** Snapshot of the given keys' current counts. */
export function baselineOf(ctx: ProgressContext, keys: { actions: string[]; pages: string[] }): PeriodBaseline {
  const pick = (map: Record<string, { count: number }>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, map[k]?.count ?? 0]));
  return { actions: pick(ctx.actions, keys.actions), pages: pick(ctx.pages, keys.pages) };
}

/**
 * Adds `period`: activity since the baseline (or all activity when there is none).
 * A key with no activity in the period has no entry, so `exists` means "done this period".
 */
export function withPeriod(ctx: ProgressContext, baseline: PeriodBaseline | undefined, keys: { actions: string[]; pages: string[] }) {
  const since = (map: Record<string, { count: number }>, base: Record<string, number> | undefined, ks: string[]) => {
    const out: Record<string, { count: number }> = {};
    for (const k of ks) {
      const n = (map[k]?.count ?? 0) - (base?.[k] ?? 0);
      if (n > 0) out[k] = { count: n };
    }
    return out;
  };
  return { ...ctx, period: { actions: since(ctx.actions, baseline?.actions, keys.actions), pages: since(ctx.pages, baseline?.pages, keys.pages) } };
}
