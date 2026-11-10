import type { FieldShape } from "@contextmachines/rules-core";
import type { ActionPattern, CapturedEvent, NetworkEvent, PageSnapshot } from "@contextmachines/schemas";
import { speaks, wallOf } from "../walls.ts";
import { isHeld, LabelGate, UNNAMED_VIEW, type LabelGateState } from "./label-gate.ts";
import { nameOperation, nameRestAction, SAFE_METHODS } from "./naming.ts";

/** One batch of a session's events, as the ingest stores it and the site learner reads it. */
export interface StoredBatch {
  tenantId: string;
  env: "test" | "live";
  sessionId: string;
  userId?: string;
  /** A returning browser (no user id): see personOf. */
  browserId?: string;
  /** The user id was signed with the account's identity secret. */
  verified?: boolean;
  /** Phone, tablet or computer. */
  device?: "phone" | "tablet" | "computer";
  /** The user's plan or tier and role, when the site passes them, and the page's language. */
  plan?: string;
  role?: string;
  lang?: string;
  receivedAt: number;
  origin: string;
  dropped: number;
  errors: number;
  events: CapturedEvent[];
  /** Sent as the page closed: the reply was never read. */
  final?: boolean;
}

/**
 * Learns a site model from captured traffic, incrementally, with plain rules
 * (no model calls). Every batch updates it immediately, so actions are known
 * the first time anyone uses them. Admins then confirm, rename or ignore.
 */

const SENSITIVE_FIELD = /pass(word)?|secret|token|api_?key|ssn|tax_?id|card|cvv|iban|account_?number|dob|birth|email|phone|address|medical|health/i;
/**
 * A segment position right after a resource name, with this many distinct values
 * while the rest of the path stays the same, is an id. Word-only values (e.g.
 * /settings/profile, /settings/billing) need more evidence than values with digits.
 */
const ID_CARDINALITY_WITH_DIGITS = 5;
const ID_CARDINALITY_WORDS = 10;
const MAX_TEMPLATES = 5000;
const NOISE = /^(api|rest|graphql|internal|public|v\d+(\.\d+)?)$/i;
/**
 * A segment that says what to do is one of the app's own routes, never an id or someone's name:
 * /users/login, /users/forgot-password, /users/sign_in. Words only, one of them a verb or a word for
 * the signed-in person. The same rule the browser applies before sending (snippet url.ts).
 */
const ROUTE_WORD = /^(login|logout|logon|logoff|signin|signout|signup|sign|log|register|registration|forgot|reset|change|update|verify|verification|confirm|confirmation|activate|deactivate|refresh|resend|recover|recovery|unlock|password|passwords|me|self|current|whoami|exists|check|validate|lookup|search|batch|bulk|count)$/i;
function isRouteWord(segment: string): boolean {
  if (!/^[A-Za-z]+(?:[-_][A-Za-z]+)*$/.test(segment) && !/^[a-z]+(?:[A-Z][a-z]+)+$/.test(segment)) return false;
  return segment.split(/[-_]+|(?<=[a-z])(?=[A-Z])/).some((word) => ROUTE_WORD.test(word));
}
const MAX_ACTIONS = 2000;
const MAX_VALUES_PER_POSITION = 50;

export interface LearnedField {
  types: FieldShape["type"][];
  seen: number;
  empty: number;
  /** Likely personal or secret: never suggest allow-listing its value. */
  sensitive: boolean;
}

export interface LearnedAction {
  id: string;
  label: string;
  method: string;
  path: string;
  graphqlOperation?: string;
  /** A save whatever its method: a GET that changes a cart, stopped by the learner. */
  save?: true;
  seen: number;
  firstSeen: number;
  lastSeen: number;
  statuses: Record<string, number>;
  fields: Record<string, LearnedField>;
  /** What successful replies gave back, by field (shapes only; at most 24 fields). */
  result?: Record<string, LearnedField>;
  /** What it does, in the company's own words, when they have written it. */
  does?: string;
  /** Buttons/forms that were clicked or submitted just before this request, by label. */
  triggers: { type: "click" | "submit" | "change"; label: string; count: number; /** Of those, on pages in a language help is worded in. */ spoken?: number; /** A link, which leads somewhere, not a button that does something. */ link?: true }[];
  /** Pages where users caused this action, with counts (e.g. "/add-invoice"). */
  triggerPages: Record<string, number>;
  /** The on-screen name users see (most common trigger label in a language help is worded in), e.g. "Save invoice". */
  uiLabel?: string;
  /** Error codes the app gave when this action failed ("CARD_DECLINED": count), at most 10. */
  errorCodes?: Record<string, number>;
  /**
   * What people went on to do after pressing something that did nothing ("Open ▾", a badge that
   * looks like a menu): page and target of that dead click → how many then did this, at most 20.
   */
  afterDeadClicks?: Record<string, number>;
  /** Earlier requests this action was healed from (the site changed its API). */
  renamedFrom?: string[];
  review: "suggested" | "confirmed" | "ignored";
}

export interface LearnedPage {
  /** Stable identity (the path it was first learned under). Goals and progress use this. */
  path: string;
  /** Where the page lives now, if the site moved it (navigate here). */
  currentPath?: string;
  seen: number;
  firstSeen: number;
  lastSeen: number;
  snapshot: PageSnapshot;
  /** How long people usually spend on it (median, ms), once NORMAL_MIN_VISITS have left it. */
  usualMs?: number;
}

export type StruggleType = "hesitation" | "rage_click" | "dead_click" | "field_churn" | "form_abandon" | "validation_loop" | "u_turn" | "crash" | "error_page" | "missed_tap" | "no_results" | "searching" | "failed_drag" | "failed_action";

/** How much each kind of struggle usually costs the user (abandoning a form is worse than one u-turn). */
const STRUGGLE_WEIGHT: Record<StruggleType, number> = { form_abandon: 1, validation_loop: 0.9, rage_click: 0.8, dead_click: 0.6, hesitation: 0.5, field_churn: 0.5, u_turn: 0.3, crash: 1, error_page: 0.9, missed_tap: 0.6, no_results: 0.6, searching: 0.6, failed_drag: 0.7, failed_action: 0.9 };

/**
 * What's normal on each page: how long people stay before moving on, from the last
 * NORMAL_SAMPLES visits. Searching counts as a problem only when it runs past
 * NORMAL_FACTOR × that page's usual time; until NORMAL_MIN_VISITS have left a page, the
 * browser's own bar (several signs together for 15s+) is all there is.
 */
const NORMAL_SAMPLES = 101;
export const NORMAL_MIN_VISITS = 20;
export const NORMAL_FACTOR = 2;
/** A stay outside this range is a tab left open or a bounce, not a visit. */
const STAY_MIN_MS = 500;
const STAY_MAX_MS = 30 * 60_000;
const MAX_PROBLEMS = 300;
const MAX_SESSIONS_PER_PROBLEM = 2000;

interface StruggleTally {
  type: StruggleType;
  page: string;
  target: string;
  occurrences: number;
  sessions: string[];
  firstSeen: number;
  lastSeen: number;
  /** People affected, by what they were using. */
  devices?: Partial<Record<Device, number>>;
}

export type Device = "phone" | "tablet" | "computer";

/** A place in the product where people get stuck, ranked by how many and how badly. */
export interface SiteProblem {
  id: string;
  type: StruggleType;
  page: string;
  /** Control label or field name involved, when known. */
  target: string;
  occurrences: number;
  sessionsAffected: number;
  /** Sessions affected / visits to the page (approximate). */
  rate: number;
  severity: number;
  /** The action a user would be trying to complete there (button on this page with this label, or the page's main action). */
  blocksAction?: string;
  firstSeen: number;
  lastSeen: number;
  /** People affected, by what they were using. */
  devices?: Partial<Record<Device, number>>;
}

export interface HealRecord {
  kind: "action" | "page";
  /** Stable identity that was kept (action id or page path). */
  identity: string;
  from: string;
  to: string;
  at: number;
  score: number;
  reasons: string[];
}

export interface HealOptions {
  /** An action/page must have gone quiet this long before it is considered moved. */
  quietMs: number;
  minScore: number;
  /** The best match must beat the runner-up by this much. */
  margin: number;
}

/** Everything a learner knows, as plain JSON (for durable storage). Per-session flow state is not kept. */
export interface SiteLearnerState {
  v: 1;
  tenantId: string;
  version: number;
  actions: [string, LearnedAction][];
  routes: [string, number][];
  pages: LearnedPage[];
  pageAliases: [string, string][];
  heals: HealRecord[];
  struggles?: StruggleTally[];
  /** Recent times on each page (ms), for what's normal there. */
  stays?: [string, number[]][];
  transitions: [string, number][];
  pathValues: [string, [number, string[]][]][];
  reviews: [string, ActionReview][];
  /** Which on-screen words enough people have seen (hashes only): see LabelGate. */
  labelGate?: LabelGateState;
}

/** The company's verdict on a learned action: confirm, rename, describe or ignore it. */
export interface ActionReview {
  review: LearnedAction["review"];
  label?: string;
  id?: string;
  does?: string;
}

const MAX_RESULT_FIELDS = 24;

export const DEFAULT_HEAL: HealOptions = { quietMs: 6 * 3_600_000, minScore: 0.6, margin: 0.15 };

export interface LearnedTransition {
  from: string;
  to: string;
  count: number;
}

export interface SiteModelSnapshot {
  tenantId: string;
  version: number;
  actions: LearnedAction[];
  routes: { path: string; seen: number }[];
  pages: LearnedPage[];
  transitions: LearnedTransition[];
  heals: HealRecord[];
}

const MAX_PAGES = 2000;
/** Visits whose last action is remembered (for action-to-action transitions); the oldest are forgotten first. */
const MAX_LIVE_SESSIONS = 50_000;
const MAX_TRIGGERS = 10;

export class SiteLearner {
  readonly tenantId: string;
  private version = 0;
  private readonly actions = new Map<string, LearnedAction>(); // key: signature
  private readonly routes = new Map<string, number>();
  private readonly pages = new Map<string, LearnedPage>();
  /** Actual path → stable page identity, for pages the site has moved. */
  private readonly pageAliases = new Map<string, string>();
  private readonly heals: HealRecord[] = [];
  private readonly struggles = new Map<string, StruggleTally>();
  private readonly stays = new Map<string, number[]>();
  /** Where each live visit last arrived, and when (to time how long it stayed). */
  private readonly arrivedBySession = new Map<string, { page: string; at: number }>();
  /** Failed saves per visit and action, for "failed_action". */
  private readonly failuresBySession = new Map<string, number>();
  /** Each visit's last press that did nothing, until something they do next works. */
  private readonly deadClickBySession = new Map<string, { key: string; t: number }>();
  /** Each visit's latest save that worked, by the page's clock: a dead click reported late still finds what came next. */
  private readonly workedBySession = new Map<string, { signature: string; t: number }>();
  private readonly transitions = new Map<string, number>();
  private readonly lastActionBySession = new Map<string, string>();
  private readonly pathValues = new Map<string, Map<number, Set<string>>>(); // method+template → position → values
  private readonly reviews = new Map<string, ActionReview>();

  /** Holds back on-screen words until enough people have seen them; applied at ingest, before storage. */
  gate = new LabelGate();

  /** One site's model. Hosted, one is kept per customer; on someone's own machine there is only the one. */
  constructor(tenantId = "local") {
    this.tenantId = tenantId;
  }

  observe(batch: Omit<StoredBatch, "tenantId"> & { tenantId?: string }): void {
    if (batch.tenantId !== undefined && batch.tenantId !== this.tenantId) throw new Error("tenant mismatch");
    let changed = false;
    // In the order they happened: a stuck moment is reported a moment after it, often after what came next.
    const inOrder = batch.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
    for (const event of inOrder) {
      if (event.kind === "route") {
        const path = this.canonicalPage(event.path);
        this.routes.set(path, (this.routes.get(path) ?? 0) + 1);
        this.observeStay(batch.sessionId, path, event.t);
        changed = true;
      } else if (event.kind === "page") {
        const path = this.canonicalPage(event.path);
        const existing = this.pages.get(path);
        if (existing || this.pages.size < MAX_PAGES) {
          // Help quotes this page's labels, so keep them in a language it is worded in once we have that.
          const snapshot = existing && !speaks(batch.lang) ? existing.snapshot : event.snapshot;
          const page: LearnedPage = { path, seen: (existing?.seen ?? 0) + 1, firstSeen: existing?.firstSeen ?? batch.receivedAt, lastSeen: batch.receivedAt, snapshot };
          if (path !== event.path) page.currentPath = event.path;
          this.pages.set(path, page);
          changed = true;
        }
      } else if (event.kind === "struggle") {
        const page = this.canonicalPage(event.page);
        // Looking around for longer than people normally spend on the whole page: otherwise it's just reading.
        if (event.type === "searching" && !this.pastNormal(page, event.durationMs ?? 0)) continue;
        this.observeStruggle(batch.sessionId, event.type, page, event.target ?? "", batch.receivedAt, batch.device);
        if (event.type === "dead_click" && event.target) this.deadClicked(batch.sessionId, `${page}\u0000${event.target}`, event.t);
        changed = true;
      } else if (event.kind === "network") {
        const trigger = event.trigger?.page ? { ...event.trigger, page: this.canonicalPage(event.trigger.page) } : event.trigger;
        this.observeRequest(batch.sessionId, trigger ? { ...event, trigger } : event, batch.receivedAt, speaks(batch.lang));
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  toState(): SiteLearnerState {
    return structuredClone({
      v: 1 as const,
      tenantId: this.tenantId,
      version: this.version,
      actions: [...this.actions.entries()],
      routes: [...this.routes.entries()],
      pages: [...this.pages.values()],
      pageAliases: [...this.pageAliases.entries()],
      heals: this.heals,
      struggles: [...this.struggles.values()],
      stays: [...this.stays.entries()],
      transitions: [...this.transitions.entries()],
      pathValues: [...this.pathValues.entries()].map(([k, byPos]) => [k, [...byPos.entries()].map(([pos, set]) => [pos, [...set]])] as [string, [number, string[]][]]),
      reviews: [...this.reviews.entries()],
      labelGate: this.gate.toState(),
    });
  }

  static fromState(state: SiteLearnerState): SiteLearner {
    if (state.v !== 1) throw new Error(`unsupported learner state version ${String(state.v)}`);
    const learner = new SiteLearner(state.tenantId);
    const s = structuredClone(state);
    if (s.labelGate) learner.gate = new LabelGate(s.labelGate);
    learner.version = s.version;
    for (const [k, a] of s.actions) learner.actions.set(k, a);
    for (const [k, n] of s.routes) learner.routes.set(k, n);
    for (const p of s.pages) learner.pages.set(p.path, p);
    for (const [k, v] of s.pageAliases) learner.pageAliases.set(k, v);
    learner.heals.push(...s.heals);
    for (const t of s.struggles ?? []) learner.struggles.set(`${t.type}|${t.page}|${t.target}`, t);
    for (const [k, v] of s.stays ?? []) learner.stays.set(k, v);
    for (const [k, n] of s.transitions) learner.transitions.set(k, n);
    for (const [k, byPos] of s.pathValues) learner.pathValues.set(k, new Map(byPos.map(([pos, values]) => [pos, new Set(values)])));
    for (const [k, r] of s.reviews) learner.reviews.set(k, r);
    learner.foldFileNames();
    return learner;
  }

  /**
   * Swaps held codes for their words now that enough people have seen them: in stuck moments
   * (merging with any already counted under the word) and in the buttons behind actions.
   */
  reveal(words: ReadonlyMap<string, string>): void {
    for (const [key, t] of [...this.struggles]) {
      const word = words.get(t.target);
      if (word === undefined) continue;
      this.struggles.delete(key);
      const nextKey = `${t.type}|${t.page}|${word}`;
      const into = this.struggles.get(nextKey);
      if (into) {
        into.occurrences += t.occurrences;
        for (const s of t.sessions) if (!into.sessions.includes(s) && into.sessions.length < MAX_SESSIONS_PER_PROBLEM) into.sessions.push(s);
        into.firstSeen = Math.min(into.firstSeen, t.firstSeen);
        into.lastSeen = Math.max(into.lastSeen, t.lastSeen);
      } else this.struggles.set(nextKey, { ...t, target: word });
    }
    for (const action of this.actions.values()) {
      for (const [k, n] of Object.entries(action.afterDeadClicks ?? {})) {
        const [page, target] = k.split("\u0000");
        const word = target === undefined ? undefined : words.get(target);
        if (word === undefined || !action.afterDeadClicks) continue;
        delete action.afterDeadClicks[k];
        const next = `${page}\u0000${word}`;
        action.afterDeadClicks[next] = (action.afterDeadClicks[next] ?? 0) + n;
      }
      for (const [, d] of this.deadClickBySession) {
        const [page, target] = d.key.split("\u0000");
        const word = target === undefined ? undefined : words.get(target);
        if (word !== undefined) d.key = `${page}\u0000${word}`;
      }
      if (!action.triggers.some((tr) => words.has(tr.label))) continue;
      const merged: typeof action.triggers = [];
      for (const tr of action.triggers) {
        const label = words.get(tr.label) ?? tr.label;
        const same = merged.find((m) => m.type === tr.type && m.label === label);
        if (same) {
          same.count += tr.count;
          same.spoken = (same.spoken ?? 0) + (tr.spoken ?? 0) || undefined;
        } else merged.push({ ...tr, label });
      }
      action.triggers = merged.sort((a, b) => b.count - a.count);
      const shown = shownLabel(action.triggers);
      if (shown) action.uiLabel = shown;
      else delete action.uiLabel;
    }
    this.version++;
  }

  /** Admin review: confirm, rename, describe or ignore a suggested action. Survives re-learning. */
  /**
   * Forgets a screen the company says isn't theirs (a test copy, an old address), with its steps
   * and pop-ups and everything counted on it. Returns how many things were forgotten.
   */
  forgetScreen(path: string): number {
    const on = (p: string) => p === path || p.startsWith(`${path}/~`);
    let n = 0;
    for (const map of [this.routes, this.pages, this.stays] as Map<string, unknown>[]) for (const k of [...map.keys()]) if (on(k)) { map.delete(k); n++; }
    for (const [k, t] of [...this.struggles]) if (on(t.page)) { this.struggles.delete(k); n++; }
    for (const a of this.actions.values()) for (const p of Object.keys(a.triggerPages)) if (on(p)) { delete a.triggerPages[p]; n++; }
    if (n) this.version++;
    return n;
  }

  review(actionId: string, update: ActionReview): boolean {
    const entry = [...this.actions.entries()].find(([, a]) => a.id === actionId);
    if (!entry) return false;
    const [signature, action] = entry;
    this.reviews.set(signature, update);
    action.review = update.review;
    if (update.label) action.label = update.label;
    if (update.id) action.id = update.id;
    if (update.does) action.does = update.does;
    this.version++;
    return true;
  }

  private cached: { at: number; snapshot: SiteModelSnapshot } | undefined;

  /**
   * A snapshot reused for up to `maxAgeMs`: for work done on every incoming batch, where a site
   * map a few seconds old is as good as a fresh one and copying a large one each time is not.
   * Callers must not change it.
   */
  recentSnapshot(now: number, maxAgeMs = 5000): SiteModelSnapshot {
    if (!this.cached || now - this.cached.at > maxAgeMs || now < this.cached.at) this.cached = { at: now, snapshot: deepFreeze(this.snapshot()) };
    return this.cached.snapshot;
  }

  snapshot(): SiteModelSnapshot {
    const actions = [...this.actions.values()].sort((a, b) => b.seen - a.seen).map((a) => {
      // Names follow the current rule, also for actions learned before it changed.
      const copy = structuredClone(a);
      const shown = shownLabel(copy.triggers);
      if (shown) copy.uiLabel = shown;
      else delete copy.uiLabel;
      return copy;
    });
    return {
      tenantId: this.tenantId,
      version: this.version,
      actions,
      routes: [...this.routes.entries()].map(([path, seen]) => ({ path, seen })).sort((a, b) => b.seen - a.seen),
      pages: [...this.pages.values()].sort((a, b) => b.seen - a.seen).map((p) => {
        const usual = this.usualStay(p.path);
        return { ...structuredClone(p), ...(usual !== undefined ? { usualMs: usual } : {}) };
      }),
      heals: this.heals.map((h) => ({ ...h, reasons: [...h.reasons] })),
      transitions: [...this.transitions.entries()]
        .map(([key, count]) => {
          const [from = "", to = ""] = key.split("\u0000");
          return { from, to, count };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 100),
    };
  }

  /**
   * Names a request the browser could not name (no confirmed pattern yet), from
   * what has been learned. Read-only: never changes the model. Ignored actions
   * resolve to nothing.
   */
  resolve(method: string, path: string, graphqlOperation?: string): string | undefined {
    const exact = this.actions.get(`${method} ${path}${graphqlOperation ? ` #${graphqlOperation}` : ""}`);
    if (exact) return exact.review === "ignored" ? undefined : exact.id;
    const segments = path.split("/");
    for (const action of this.actions.values()) {
      if (action.method !== method || action.review === "ignored" || action.graphqlOperation !== graphqlOperation) continue;
      const pattern = action.path.split("/");
      if (pattern.length === segments.length && pattern.every((seg, i) => seg === segments[i] || seg === ":id")) return action.id;
    }
    return undefined;
  }

  /** Times how long a visit stayed on the page it is leaving. */
  private observeStay(sessionId: string, page: string, at: number) {
    const before = this.arrivedBySession.get(sessionId);
    this.arrivedBySession.delete(sessionId);
    this.arrivedBySession.set(sessionId, { page, at });
    if (this.arrivedBySession.size > MAX_LIVE_SESSIONS) this.arrivedBySession.delete(this.arrivedBySession.keys().next().value!);
    if (!before || before.page === page) return;
    const stayed = at - before.at;
    if (stayed < STAY_MIN_MS || stayed > STAY_MAX_MS) return;
    if (!this.stays.has(before.page) && this.stays.size >= MAX_PAGES) return;
    const list = this.stays.get(before.page) ?? [];
    list.push(stayed);
    if (list.length > NORMAL_SAMPLES) list.shift();
    this.stays.set(before.page, list);
  }

  /** How long people usually spend on a page (median), once enough have left it. */
  usualStay(page: string): number | undefined {
    const list = this.stays.get(page);
    if (!list || list.length < NORMAL_MIN_VISITS) return undefined;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** Longer than NORMAL_FACTOR × the page's usual time (or, before that's known, any time the browser reported). */
  private pastNormal(page: string, ms: number): boolean {
    const usual = this.usualStay(page);
    return usual === undefined || ms >= usual * NORMAL_FACTOR;
  }

  /** A press that did nothing: credited to the next save that works for them, here or when it arrives. */
  private deadClicked(sessionId: string, key: string, t: number) {
    const worked = this.workedBySession.get(sessionId);
    const action = worked ? this.actions.get(worked.signature) : undefined;
    if (worked && action && worked.t > t && worked.t - t < 5 * 60_000) {
      this.creditAfterDeadClick(action, key);
      return;
    }
    this.deadClickBySession.delete(sessionId);
    this.deadClickBySession.set(sessionId, { key, t });
    if (this.deadClickBySession.size > MAX_LIVE_SESSIONS) this.deadClickBySession.delete(this.deadClickBySession.keys().next().value!);
  }

  private creditAfterDeadClick(action: LearnedAction, key: string) {
    const after = (action.afterDeadClicks ??= {});
    if (after[key] !== undefined || Object.keys(after).length < 20) after[key] = (after[key] ?? 0) + 1;
  }

  private observeStruggle(sessionId: string, type: StruggleType, page: string, target: string, at: number, device?: Device) {
    const key = `${type}|${page}|${target}`;
    let t = this.struggles.get(key);
    if (!t) {
      if (this.struggles.size >= MAX_PROBLEMS) return;
      t = { type, page, target, occurrences: 0, sessions: [], firstSeen: at, lastSeen: at };
      this.struggles.set(key, t);
    }
    t.occurrences++;
    t.lastSeen = Math.max(t.lastSeen, at);
    if (!t.sessions.includes(sessionId) && t.sessions.length < MAX_SESSIONS_PER_PROBLEM) {
      t.sessions.push(sessionId);
      if (device) (t.devices ??= {})[device] = (t.devices?.[device] ?? 0) + 1;
    }
  }

  /**
   * A save that kept failing for people who also showed it some other way (pressing it again and
   * again, or the form being rejected): one stuck moment, already counted as that.
   */
  private toldOtherwise(t: { page: string; target: string; sessions: string[] }): boolean {
    const others = new Set<string>();
    for (const o of this.struggles.values()) {
      if (o.page !== t.page) continue;
      const same = ((o.type === "rage_click" || o.type === "dead_click") && o.target === t.target) || o.type === "validation_loop" || o.type === "field_churn";
      if (same) for (const s of o.sessions) others.add(s);
    }
    return t.sessions.filter((s) => others.has(s)).length * 2 >= t.sessions.length;
  }

  /**
   * Where people get stuck, ranked: severity = kind weight × share of page
   * visits affected × log(sessions affected), so one person rage-clicking
   * once never outranks a form most people abandon.
   */
  problems(): SiteProblem[] {
    const out: SiteProblem[] = [];
    for (const t of this.struggles.values()) {
      // A pop-up or step whose name isn't confirmed yet ("~view") is no place anyone could act on.
      if (t.page.endsWith(`/${UNNAMED_VIEW}`)) continue;
      if (t.type === "failed_action" && this.toldOtherwise(t)) continue;
      const visits = Math.max(this.routes.get(t.page) ?? 0, this.pages.get(t.page)?.seen ?? 0, t.sessions.length);
      const rate = t.sessions.length / visits;
      const blocks = [...this.actions.values()].find((a) => a.triggerPages[t.page] !== undefined && (t.target === "" || a.triggers.some((tr) => tr.label === t.target)))
        ?? [...this.actions.values()].filter((a) => a.triggerPages[t.page] !== undefined).sort((a, b) => b.seen - a.seen)[0];
      const p: SiteProblem = {
        id: `${t.type}:${t.page}:${t.target}`.slice(0, 200),
        type: t.type,
        page: t.page,
        target: t.target,
        occurrences: t.occurrences,
        sessionsAffected: t.sessions.length,
        rate: Math.round(rate * 1000) / 1000,
        severity: Math.round(STRUGGLE_WEIGHT[t.type] * rate * Math.log2(1 + t.sessions.length) * 1000) / 1000,
        ...(t.devices ? { devices: { ...t.devices } } : {}),
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
      };
      if (blocks) p.blocksAction = blocks.id;
      out.push(p);
    }
    return out.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  }

  /** The stable identity for a page path (follows pages the site has moved). */
  canonicalPage(path: string): string {
    return this.pageAliases.get(path) ?? path;
  }

  /**
   * Self-healing. When an action or page has gone quiet and a new one appeared
   * after it that matches strongly (same button and page, same fields, similar
   * path / same title, headings and buttons), the new one is folded into the
   * old: the stable identity is kept, so every rule, goal and pattern that
   * refers to it keeps working, and the move is recorded. Ambiguous matches
   * are left alone.
   */
  heal(now: number, options: Partial<HealOptions> = {}): HealRecord[] {
    const o = { ...DEFAULT_HEAL, ...options };
    const done: HealRecord[] = [...this.healActions(now, o), ...this.healPages(now, o)];
    if (done.length > 0) {
      this.heals.push(...done);
      if (this.heals.length > 100) this.heals.splice(0, this.heals.length - 100);
      this.version++;
    }
    return done;
  }

  private healActions(now: number, o: HealOptions): HealRecord[] {
    const out: HealRecord[] = [];
    const claimed = new Set<string>();
    const entries = [...this.actions.entries()];
    for (const [staleSig, stale] of entries) {
      if (stale.review === "ignored" || now - stale.lastSeen < o.quietMs || !this.actions.has(staleSig)) continue;
      const scored = entries
        .filter(([sig, a]) => sig !== staleSig && !claimed.has(sig) && this.actions.has(sig) && a.method === stale.method && Boolean(a.graphqlOperation) === Boolean(stale.graphqlOperation) && a.firstSeen > stale.lastSeen)
        .map(([sig, a]) => ({ sig, a, ...actionSimilarity(stale, a) }))
        .sort((x, y) => y.score - x.score);
      const [best, second] = scored;
      if (!best || best.score < o.minScore || (second && best.score - second.score < o.margin)) continue;
      claimed.add(best.sig);
      out.push({ kind: "action", identity: stale.id, from: `${stale.method} ${stale.path}`, to: `${best.a.method} ${best.a.path}`, at: now, score: round2(best.score), reasons: best.reasons });
      this.mergeActionInto(staleSig, best.sig);
    }
    return out;
  }

  /** The stale action keeps its id and takes over the new request signature and data. */
  private mergeActionInto(staleSig: string, freshSig: string) {
    const stale = this.actions.get(staleSig) as LearnedAction;
    const fresh = this.actions.get(freshSig) as LearnedAction;
    stale.renamedFrom = [...(stale.renamedFrom ?? []), `${stale.method} ${stale.path}`].slice(-10);
    stale.path = fresh.path;
    stale.seen += fresh.seen;
    stale.lastSeen = Math.max(stale.lastSeen, fresh.lastSeen);
    for (const [k, n] of Object.entries(fresh.statuses)) stale.statuses[k] = (stale.statuses[k] ?? 0) + n;
    for (const [k, f] of Object.entries(fresh.fields)) {
      const e = stale.fields[k];
      if (!e) stale.fields[k] = f;
      else {
        e.seen += f.seen;
        e.empty += f.empty;
        for (const t of f.types) if (!e.types.includes(t)) e.types.push(t);
      }
    }
    for (const tr of fresh.triggers) {
      const match = stale.triggers.find((x) => x.type === tr.type && x.label === tr.label);
      if (match) match.count += tr.count;
      else if (stale.triggers.length < MAX_TRIGGERS) stale.triggers.push({ ...tr });
    }
    stale.triggers.sort((a, b) => b.count - a.count);
    for (const [page, n] of Object.entries(fresh.triggerPages)) stale.triggerPages[page] = (stale.triggerPages[page] ?? 0) + n;
    this.actions.delete(freshSig);
    this.actions.delete(staleSig);
    this.actions.set(freshSig, stale);
    this.renameInFlows(fresh.id, stale.id);
  }

  private renameInFlows(from: string, to: string) {
    for (const [key, count] of [...this.transitions.entries()]) {
      const [a = "", b = ""] = key.split("\u0000");
      if (a !== from && b !== from) continue;
      this.transitions.delete(key);
      const next = `${a === from ? to : a}\u0000${b === from ? to : b}`;
      if (!next.startsWith(`${to}\u0000${to}`)) this.transitions.set(next, (this.transitions.get(next) ?? 0) + count);
    }
    for (const [session, id] of this.lastActionBySession) if (id === from) this.lastActionBySession.set(session, to);
  }

  private healPages(now: number, o: HealOptions): HealRecord[] {
    const out: HealRecord[] = [];
    const claimed = new Set<string>();
    for (const stale of [...this.pages.values()]) {
      if (now - stale.lastSeen < o.quietMs || !this.pages.has(stale.path)) continue;
      const scored = [...this.pages.values()]
        .filter((p) => p.path !== stale.path && !claimed.has(p.path) && p.firstSeen > stale.lastSeen)
        .map((p) => ({ p, ...pageSimilarity(stale.snapshot, p.snapshot) }))
        .sort((x, y) => y.score - x.score);
      const [best, second] = scored;
      if (!best || best.score < o.minScore || (second && best.score - second.score < o.margin)) continue;
      claimed.add(best.p.path);
      const moved = best.p.currentPath ?? best.p.path;
      out.push({ kind: "page", identity: stale.path, from: stale.currentPath ?? stale.path, to: moved, at: now, score: round2(best.score), reasons: best.reasons });
      this.pageAliases.set(moved, stale.path);
      stale.currentPath = moved;
      stale.snapshot = best.p.snapshot;
      stale.seen += best.p.seen;
      stale.lastSeen = Math.max(stale.lastSeen, best.p.lastSeen);
      this.pages.delete(best.p.path);
      const routeHits = this.routes.get(best.p.path);
      if (routeHits !== undefined) {
        this.routes.delete(best.p.path);
        this.routes.set(stale.path, (this.routes.get(stale.path) ?? 0) + routeHits);
      }
      for (const a of this.actions.values()) {
        const n = a.triggerPages[best.p.path];
        if (n === undefined) continue;
        delete a.triggerPages[best.p.path];
        a.triggerPages[stale.path] = (a.triggerPages[stale.path] ?? 0) + n;
      }
    }
    return out;
  }

  /** Confirmed actions as the patterns the snippet uses to map requests to action ids. */
  confirmedPatterns(): ActionPattern[] {
    return [...this.actions.values()]
      .filter((a) => a.review === "confirmed")
      .map((a) => {
        const pattern: ActionPattern = { id: a.id, label: a.label.slice(0, 80), method: a.method as ActionPattern["method"], path: a.path };
        if (a.graphqlOperation) pattern.graphqlOperation = a.graphqlOperation;
        return pattern;
      });
  }

  private observeRequest(sessionId: string, event: NetworkEvent, at: number, spoken = true) {
    const path = this.generalise(event.method, withoutFileNames(event.path));
    const signature = `${event.method} ${path}${event.graphqlOperation ? ` #${event.graphqlOperation}` : ""}`;

    let action = this.actions.get(signature);
    if (!action) {
      if (this.actions.size >= MAX_ACTIONS) return;
      const name = event.graphqlOperation ? nameOperation(event.method, path, event.graphqlOperation) : nameRestAction(event.save ? "POST" : event.method, path, event.trigger?.label ? [{ type: event.trigger.type, label: event.trigger.label, link: event.trigger.tag === "a" }] : undefined);
      action = { id: this.uniqueId(name.id), label: name.label, method: event.method, path, seen: 0, firstSeen: at, lastSeen: at, statuses: {}, fields: {}, triggers: [], triggerPages: {}, review: "suggested" };
      if (event.graphqlOperation) action.graphqlOperation = event.graphqlOperation;
      const prior = this.reviews.get(signature);
      if (prior) {
        action.review = prior.review;
        if (prior.label) action.label = prior.label;
        if (prior.id) action.id = prior.id;
        if (prior.does) action.does = prior.does;
      }
      this.actions.set(signature, action);
    }

    action.seen++;
    action.lastSeen = Math.max(action.lastSeen, at);
    if (event.save) action.save = true;
    if (event.status !== undefined) {
      // "app_failed": the app said it failed despite a 2xx (GraphQL errors). "wall_*": not for this user (plan, role, limit).
      const wall = wallOf(event);
      const bucket = wall ? `wall_${wall}` : event.status === 0 ? "failed" : event.failed ? "app_failed" : `${Math.floor(event.status / 100)}xx`;
      action.statuses[bucket] = (action.statuses[bucket] ?? 0) + 1;
    }
    // The app's own reasons for failing (machine codes only), most useful for help. A wall isn't one.
    if (event.errorCode && !wallOf(event)) {
      const codes = (action.errorCodes ??= {});
      if (codes[event.errorCode] !== undefined || Object.keys(codes).length < 10) codes[event.errorCode] = (codes[event.errorCode] ?? 0) + 1;
    }
    for (const [name, shape] of Object.entries(event.fields)) {
      const field = action.fields[name] ?? { types: [], seen: 0, empty: 0, sensitive: SENSITIVE_FIELD.test(name) };
      if (!field.types.includes(shape.type)) field.types.push(shape.type);
      field.seen++;
      if (shape.empty) field.empty++;
      action.fields[name] = field;
    }
    for (const [name, shape] of Object.entries(event.result ?? {})) {
      const result = (action.result ??= {});
      if (result[name] === undefined && Object.keys(result).length >= MAX_RESULT_FIELDS) continue;
      const field = result[name] ?? { types: [], seen: 0, empty: 0, sensitive: SENSITIVE_FIELD.test(name) };
      if (!field.types.includes(shape.type)) field.types.push(shape.type);
      field.seen++;
      if (shape.empty) field.empty++;
      result[name] = field;
    }

    const triggerPage = event.trigger?.page;
    if (triggerPage && (action.triggerPages[triggerPage] !== undefined || Object.keys(action.triggerPages).length < MAX_TRIGGERS)) {
      action.triggerPages[triggerPage] = (action.triggerPages[triggerPage] ?? 0) + 1;
    }

    if (event.trigger?.label) {
      const { type, label } = event.trigger;
      const existing = action.triggers.find((tr) => tr.type === type && tr.label === label);
      if (existing) {
        existing.count++;
        if (spoken) existing.spoken = (existing.spoken ?? 0) + 1;
      } else if (action.triggers.length < MAX_TRIGGERS) action.triggers.push({ type, label, count: 1, ...(spoken ? { spoken: 1 } : {}), ...(event.trigger.tag === "a" ? { link: true as const } : {}) });
      action.triggers.sort((a, b) => b.count - a.count);
      const shown = shownLabel(action.triggers);
      if (shown) action.uiLabel = shown;
      else delete action.uiLabel;
    }

    const previous = this.lastActionBySession.get(sessionId);
    if (previous && previous !== action.id) {
      const key = `${previous}\u0000${action.id}`;
      this.transitions.set(key, (this.transitions.get(key) ?? 0) + 1);
    }
    this.lastActionBySession.delete(sessionId); // re-insert: the most recent visits are kept
    this.lastActionBySession.set(sessionId, action.id);
    if (this.lastActionBySession.size > MAX_LIVE_SESSIONS) this.lastActionBySession.delete(this.lastActionBySession.keys().next().value!);

    // The same save failing twice for one person is being stuck, however calmly they try again.
    // Not "not for you" (plan, role, limit) and not "sign in again" (401): those aren't failures.
    // A reply that blames a field is the form being rejected: the page reports that as a validation loop.
    const write = !SAFE_METHODS.has(event.method);
    const worked = write && event.failed !== true && event.status !== undefined && event.status > 0 && event.status < 400;
    // What they did instead, once something that did nothing didn't work: the next save that works.
    if (worked) {
      const dead = this.deadClickBySession.get(sessionId);
      if (dead && event.t > dead.t && event.t - dead.t < 5 * 60_000) {
        this.deadClickBySession.delete(sessionId);
        this.creditAfterDeadClick(action, dead.key);
      }
      this.workedBySession.delete(sessionId);
      this.workedBySession.set(sessionId, { signature, t: event.t });
      if (this.workedBySession.size > MAX_LIVE_SESSIONS) this.workedBySession.delete(this.workedBySession.keys().next().value!);
    }
    const failed = !SAFE_METHODS.has(event.method) && !wallOf(event) && !event.errorField && (event.failed === true || (event.status !== undefined && (event.status === 0 || (event.status >= 400 && event.status !== 401))));
    if (failed) {
      const key = `${sessionId}\u0000${action.id}`;
      const n = (this.failuresBySession.get(key) ?? 0) + 1;
      this.failuresBySession.delete(key);
      this.failuresBySession.set(key, n);
      if (this.failuresBySession.size > MAX_LIVE_SESSIONS) this.failuresBySession.delete(this.failuresBySession.keys().next().value!);
      const page = event.trigger?.page ?? Object.entries(action.triggerPages).sort((x, y) => y[1] - x[1])[0]?.[0];
      if (n === 2 && page) this.observeStruggle(sessionId, "failed_action", page, event.trigger?.label ?? action.uiLabel ?? action.label, at);
    }
  }

  /**
   * Catches ids the browser-side normaliser missed (short slugs, usernames):
   * if one segment position takes many distinct values while the rest of the
   * path stays the same, that position is an id.
   */
  private generalise(method: string, path: string): string {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const previous = segments[i - 1] ?? "";
      // Only a value directly after a resource name can be an id: /users/alice, not /api/users or /:id/publish.
      if (segments[i] === ":id" || !previous || previous === ":id" || NOISE.test(previous)) continue;
      // A word that says what to do (/users/login next to /users/forgot-password) is a route, however many there are.
      if (isRouteWord(segments[i] ?? "")) continue;
      const template = `${method} ${segments.map((s, j) => (j === i ? "*" : s)).join("/")}`;
      if (!this.pathValues.has(template) && this.pathValues.size >= MAX_TEMPLATES) continue;
      const byPosition = this.pathValues.get(template) ?? new Map<number, Set<string>>();
      const values = byPosition.get(i) ?? new Set<string>();
      if (values.size < MAX_VALUES_PER_POSITION) values.add(segments[i] ?? "");
      byPosition.set(i, values);
      this.pathValues.set(template, byPosition);
      const threshold = [...values].some((v) => /\d/.test(v)) ? ID_CARDINALITY_WITH_DIGITS : ID_CARDINALITY_WORDS;
      if (values.size >= threshold) {
        const generalised = segments.map((s, j) => (j === i ? ":id" : s)).join("/");
        this.mergeInto(method, generalised, values, i);
        return generalised;
      }
    }
    return path;
  }

  /** Folds actions learned before an id position was detected into the generalised action. */
  private mergeInto(method: string, generalised: string, values: Set<string>, position: number) {
    const targetSignature = `${method} ${generalised}`;
    for (const [signature, action] of [...this.actions.entries()]) {
      if (signature === targetSignature || action.method !== method || action.graphqlOperation) continue;
      const segs = action.path.split("/");
      const target = generalised.split("/");
      const sameShape = segs.length === target.length && segs.every((s, j) => (j === position ? values.has(s) : s === target[j]));
      if (!sameShape) continue;
      this.actions.delete(signature);
      const existing = this.actions.get(targetSignature);
      if (!existing) {
        const name = nameRestAction(method, generalised);
        this.actions.set(targetSignature, { ...action, id: this.uniqueId(name.id), label: name.label, path: generalised });
        continue;
      }
      this.absorb(existing, action);
    }
  }

  /** Folds one learned action's counts into another that turned out to be the same action. */
  private absorb(existing: LearnedAction, action: LearnedAction) {
    if (action.save) existing.save = true;
    existing.seen += action.seen;
    existing.firstSeen = Math.min(existing.firstSeen, action.firstSeen);
    existing.lastSeen = Math.max(existing.lastSeen, action.lastSeen);
    for (const [k, n] of Object.entries(action.statuses)) existing.statuses[k] = (existing.statuses[k] ?? 0) + n;
    for (const [page, n] of Object.entries(action.triggerPages)) existing.triggerPages[page] = (existing.triggerPages[page] ?? 0) + n;
    for (const tr of action.triggers) {
      const match = existing.triggers.find((x) => x.type === tr.type && x.label === tr.label);
      if (match) match.count += tr.count;
      else if (existing.triggers.length < MAX_TRIGGERS) existing.triggers.push({ ...tr });
    }
    for (const [k, f] of Object.entries(action.fields)) {
      const e = existing.fields[k];
      if (!e) existing.fields[k] = f;
      else {
        e.seen += f.seen;
        e.empty += f.empty;
        for (const t of f.types) if (!e.types.includes(t)) e.types.push(t);
      }
    }
  }

  /**
   * A file name in an address ("/storage/…/1793639977857.jpg", "/files/jane-passport.pdf") is the
   * thing being uploaded, not part of the action, and can be personal: it becomes ":id". Actions
   * learned before this rule are folded together when a site's map is loaded.
   */
  private foldFileNames() {
    for (const [signature, action] of [...this.actions.entries()]) {
      const path = withoutFileNames(action.path);
      if (path === action.path) continue;
      this.actions.delete(signature);
      const target = `${action.method} ${path}${action.graphqlOperation ? ` #${action.graphqlOperation}` : ""}`;
      const existing = this.actions.get(target);
      if (existing) this.absorb(existing, action);
      else {
        const name = nameRestAction(action.method, path);
        this.actions.set(target, { ...action, id: this.uniqueId(name.id), label: name.label, path });
      }
    }
  }

  private uniqueId(base: string): string {
    const taken = new Set([...this.actions.values()].map((a) => a.id));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }
}

/**
 * One learner per site, kept in memory for speed. Subclasses load a learner's
 * saved state on first use (`load`) and persist changed learners (`flush`).
 */
export class MemorySiteModelStore {
  private readonly learners = new Map<string, SiteLearner>();
  private readonly savedVersion = new Map<string, string>();

  learner(tenantId: string): SiteLearner {
    let learner = this.learners.get(tenantId);
    if (!learner) {
      const state = this.load(tenantId);
      learner = state ? SiteLearner.fromState(state) : new SiteLearner(tenantId);
      if (state) this.savedVersion.set(tenantId, `${state.version}:0`);
      this.learners.set(tenantId, learner);
    }
    return learner;
  }

  /** Writes every learner whose model changed since it was last saved. Returns how many were written. */
  flush(): number {
    let written = 0;
    for (const [tenantId, learner] of this.learners) {
      const state = learner.toState();
      const saved = `${state.version}:${learner.gate.changes}`;
      if (this.savedVersion.get(tenantId) === saved) continue;
      this.save(tenantId, state);
      this.savedVersion.set(tenantId, saved);
      written++;
    }
    return written;
  }

  protected load(_tenantId: string): SiteLearnerState | undefined {
    return undefined;
  }

  protected save(_tenantId: string, _state: SiteLearnerState): void {}

  observe(batch: StoredBatch): void {
    this.learner(batch.tenantId).observe(batch);
  }

  /** A batch's events with on-screen words not yet seen by enough people held back as codes (see LabelGate). */
  gate(tenantId: string, person: string | undefined, events: StoredBatch["events"], sharedBy?: number): StoredBatch["events"] {
    const learner = this.learner(tenantId);
    const out = learner.gate.filter(events, person, sharedBy);
    const revealed = learner.gate.takeRevealed();
    if (revealed.size > 0) learner.reveal(revealed);
    return out;
  }
}

const NOISE_SEGMENT = /^(api|rest|graphql|internal|public|v\d+(\.\d+)?|:id)$/i;

function jaccard(a: Iterable<string>, b: Iterable<string>): number | undefined {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 && y.size === 0) return undefined;
  let both = 0;
  for (const v of x) if (y.has(v)) both++;
  return both / (x.size + y.size - both);
}

function actionSimilarity(a: LearnedAction, b: LearnedAction): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const labels = jaccard(a.triggers.map((t) => t.label), b.triggers.map((t) => t.label)) ?? 0;
  const pages = jaccard(Object.keys(a.triggerPages), Object.keys(b.triggerPages)) ?? 0;
  const fields = jaccard(Object.keys(a.fields), Object.keys(b.fields)) ?? 0;
  const segs = (p: string) => p.split("/").filter((s) => s && !NOISE_SEGMENT.test(s));
  const path = jaccard(segs(a.path), segs(b.path)) ?? 0;
  if (labels > 0) reasons.push(`same button (${Math.round(labels * 100)}% label overlap)`);
  if (pages > 0) reasons.push(`pressed on the same page (${Math.round(pages * 100)}%)`);
  if (fields > 0) reasons.push(`${Math.round(fields * 100)}% of fields shared`);
  if (path > 0) reasons.push(`${Math.round(path * 100)}% of path shared`);
  return { score: 0.35 * labels + 0.15 * pages + 0.3 * fields + 0.2 * path, reasons };
}

function pageSimilarity(a: PageSnapshot, b: PageSnapshot): { score: number; reasons: string[] } {
  const norm = (t?: string) => (t ?? "").toLowerCase().split(/\s[|·–-]\s/)[0]?.trim() ?? "";
  const reasons: string[] = [];
  const title = norm(a.title) !== "" && norm(a.title) === norm(b.title) ? 1 : 0;
  const headings = jaccard(a.headings, b.headings) ?? 0;
  const buttons = jaccard(a.buttons.map((x) => x.label), b.buttons.map((x) => x.label)) ?? 0;
  if (title) reasons.push("same title");
  if (headings > 0) reasons.push(`${Math.round(headings * 100)}% of headings shared`);
  if (buttons > 0) reasons.push(`${Math.round(buttons * 100)}% of buttons shared`);
  return { score: 0.4 * title + 0.3 * headings + 0.3 * buttons, reasons };
}

/**
 * The on-screen name: the label of the button that causes most of the presses (at least half,
 * and two or more), in a language help is worded in. A save set off by many different presses (a
 * background sync after any click, or a row of tag chips) is named from its request instead, and
 * a cookie banner or a held code never names anything.
 */
export function shownLabel(triggers: LearnedAction["triggers"]): string | undefined {
  // Presses on pages in a language help is worded in: the same button translated is one button, not several.
  const spoken = triggers.filter((t) => (t.spoken ?? 0) > 0);
  const total = spoken.reduce((n, t) => n + (t.spoken ?? 0), 0);
  const top = spoken.filter((t) => !isHeld(t.label) && !CONSENT.test(t.label)).sort((a, b) => (b.spoken ?? 0) - (a.spoken ?? 0) || b.count - a.count)[0];
  if (!top) return undefined;
  // One button only (even pressed once) names it; among several, it needs most of the presses, twice or more.
  return spoken.length === 1 || ((top.spoken ?? 0) >= 2 && (top.spoken ?? 0) / total >= 0.5) ? top.label : undefined;
}
const CONSENT = /\bcookies?\b|\bconsent\b|^(accept|reject|allow|decline)( all| non-essential| optional)?$/i;

/** Files people upload or download, by their extension: never pages (".html", ".php" are pages). */
const FILE_NAME = /^[^/]+\.(jpe?g|png|gif|webp|heic|heif|svg|bmp|tiff?|pdf|docx?|xlsx?|pptx?|csv|txt|rtf|odt|zip|gz|tar|mp4|mov|webm|mp3|wav|m4a)$/i;
function withoutFileNames(path: string): string {
  return path.split("/").map((s) => (FILE_NAME.test(s) ? ":id" : s)).join("/");
}

/** Shared snapshots are frozen: code that tried to change one would fail loudly, not corrupt others. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
