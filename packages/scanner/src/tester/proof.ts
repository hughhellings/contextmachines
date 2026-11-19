/**
 * W3 proof (plan section 7): a run that creates, edits or deletes passes only when the browser can
 * show the change kept, measured after a fresh navigation, never on the page as the run left it.
 *
 * - The expected value is fixed BEFORE the press: the values the run typed or picked (or the goal's
 *   own quoted words when nothing was typed), and how often each showed on every page the run read
 *   before the save. Only where to look may be found after it. A value read off the page after the
 *   press is never what is expected (it would always agree).
 * - `persists`: after a short wait (an optimistic row that rolls back is gone by then), the page is
 *   opened again in a fresh browser context (same cookies, empty cache, service workers off, the page
 *   asked with no-cache), and the value must show MORE often than it did before the save, in plain
 *   text: never inside a field, a toast or live region, a list of options or the address. Tried again
 *   within a budget for a slow save.
 * - `gone`: a delete must make its row's count drop by exactly one; any other change is NOT SURE.
 * - `toggle`: a switch the goal turns on (or off) must still be on (or off) after the fresh load.
 * - The save request (2xx or a 3xx redirect, with no error shape in its body) is support only, and
 *   only the request the press caused: it can never pass anything alone; an error answer (4xx, 5xx,
 *   an error in the body) means the change is never "held", even when the page shows it (a row kept
 *   only in this browser's storage). A retry of the same request that worked counts as the save.
 * - Reopening never repeats an action: an address a press at or after the save reached by a plain
 *   page load (a GET link that adds to a cart, joins, signs up) is never opened again; only pages the
 *   run read before the save, or pages a save sent by POST (or fetch) led to, are.
 * - Live pages: only the counts of the run's own values are compared, so ticking prices, other
 *   users' rows and paging never decide anything.
 *
 * No AI here. The run (run.ts) turns a proof that failed into NOT SURE, never PASS, and a write whose
 * only support is the AI judge into NOT SURE too.
 */
import type { Browser, BrowserContext, Page, Request, Response } from "playwright";
import { hasMarker, type Marker } from "./marker.ts";
import { seeShadowRoots } from "./shadow.ts";

/** One action the run did, as the proof needs it: in order (`seq`), what was given, what was pressed. */
export interface ProofAct {
  seq: number;
  type: string;
  value?: string;
  /** The element's role and name ("textbox" "Name", "button" "Save"). */
  role?: string;
  name?: string;
  key?: string;
}

/** An action as the run did it (types.ts CachedAction), as the proof keeps it: no element refs, no secrets beyond what the run's own record keeps. */
export function actOf(seq: number, d: { type: string; value?: string; key?: string; target?: { role?: string; name?: string }; into?: { role?: string; name?: string } }): ProofAct {
  const t = d.target ?? d.into;
  return { seq, type: d.type, ...(d.value !== undefined ? { value: d.value } : {}), ...(d.key !== undefined ? { key: d.key } : {}), ...(t?.role ? { role: t.role } : {}), ...(t?.name ? { name: t.name } : {}) };
}

/** The page's plain text as the run saw it right before action `seq` (folded: see fold). */
export interface Reading {
  seq: number;
  url: string;
  text: string;
}

export type ProofPlan =
  | {
      kind: "persists";
      values: string[];
      since: number;
      press?: number;
      from: "typed" | "goal";
      /** Every value must show kept, on the same page: the goal quoted several and all were typed (a name and its notes). */
      all?: boolean;
    }
  | { kind: "gone"; values: string[]; since: number; press?: number }
  | { kind: "toggle"; name: string; on: boolean; since: number; press?: number }
  | { kind: "none"; why: string };

/** A write request a press caused: support only. */
export interface WriteRequest {
  seq: number;
  method: string;
  path: string;
  status?: number;
  /** Why its answer reads as a failure ("status 500", "errors in the body", "ok: false"). */
  failed?: string;
  /** Sent after the press's action was over, before the next one (a retry, a save that waited): only ever read as a retry. */
  late?: boolean;
}

/** A page load of the main frame that a press caused (a link, a form, a script). */
export interface PressNav {
  seq: number;
  /** The address loaded (urlKey). */
  url: string;
  /** Reached by a redirect from a write (POST, then a 303 to the new row): a view after a save. */
  viaWrite?: boolean;
}

export interface WriteProof {
  status: "held" | "failed" | "unmeasured";
  kind: ProofPlan["kind"];
  /**
   * How a "held" was shown: "strong" when the count rose on a page read before the save (or the value
   * carries this run's marker); "weak" when it shows on a page first seen after the save, which a row
   * an earlier run left could also explain. Only a strong proof lets an AI judge's pass of a write stand.
   */
  strength?: "strong" | "weak";
  /** In plain words, for the report: what was looked for, where, and what was found. */
  why: string;
  /** What was measured: the value, the page, its count before the save and after the fresh load. */
  seen?: { value: string; url: string; before?: number; after: number }[];
  /** The write requests the press caused, as support. */
  requests?: WriteRequest[];
}

// ---------------------------------------------------------------------------------------------
// Words and values (pure)

/** Text folded for matching: Unicode-normalised, quotes straightened, spaces collapsed, lower case. */
export const fold = (s: string): string => s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

const WORDY = /[\p{L}\p{N}]/u;

/**
 * How often `value` shows in a folded text, as words of their own: "Test" in "Testville" doesn't count,
 * "Test" in "Test 7Q2K" does. Non-overlapping.
 */
export function countIn(folded: string, value: string): number {
  const v = fold(value);
  if (!v) return 0;
  const edgeStart = WORDY.test(v[0]!);
  const edgeEnd = WORDY.test(v[v.length - 1]!);
  let n = 0;
  let i = 0;
  while ((i = folded.indexOf(v, i)) >= 0) {
    const before = i > 0 ? folded[i - 1]! : "";
    const after = folded[i + v.length] ?? "";
    if ((!edgeStart || !before || !WORDY.test(before)) && (!edgeEnd || !after || !WORDY.test(after))) {
      n++;
      i += v.length;
    } else i += 1;
  }
  return n;
}

/**
 * A value strong enough to prove a save by: at least 3 characters with a letter in it, not a stored
 * value's placeholder ({password}), not an address. Numbers and dates alone are too easily shown in
 * another form (37 as 37.00, a date in words), or by something else on the page.
 */
export function strongValue(v: string | undefined): v is string {
  if (!v) return false;
  const t = v.trim();
  if (t.length < 3 || t.length > 200) return false;
  if ((t.match(/\p{L}/gu) ?? []).length < 2) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(t)) return false;
  if (/\{[^}]+\}/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return true;
}

/** The goal's own quoted words: "named "Lunges"" gives Lunges. Straight, curly and single quotes. */
export function quotedIn(goal: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{2,160})"|“([^”\n]{2,160})”|‘([^’\n]{2,160})’|(?:^|[\s(])'([^'\n]{2,160})'(?=[\s.,;:!?)]|$)/g;
  for (const m of goal.matchAll(re)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** A goal that deletes ("Delete the note "Lunch"", "remove the contact"). */
const DELETES = /\b(?:delete|remove|erase|trash|destroy|discard)(?:s|d|ing)?\b/i;
/** "Remove the filter", "remove from the cart": not a record going away. */
const NOT_A_DELETE = /\bremov(?:e|es|ed|ing)\s+(?:the\s+|all\s+|any\s+)?(?:filters?|sort(?:ing)?|search|selection|highlight)\b/i;
/** A goal that turns a setting on or off ("turn on "Dark mode"", "enable "Beta""). */
const TOGGLES = /\b(?:turn(?:s|ed|ing)?|switch(?:es|ed|ing)?|toggle(?:s|d)?|set(?:s|ting)?)\s+(on|off)\b|\b(enabl|disabl|activat|deactivat)(?:e|es|ed|ing)\b/i;
/** Adding to a list kept for the person (a cart, a wishlist): a write with nothing to type. */
export const LIST_ADD = /\badd(?:s|ing|ed)?\b[^.,;]{0,60}?\b(?:to|into|in)\s+(?:the\s+|my\s+|your\s+|a\s+)?(?:cart|basket|bag|trolley|wish\s?list|favou?rites|saved(?:\s+items)?|reading\s+list|watch\s?list|playlist|collection)\b/i;

/** A press: a click, a double click or Enter (what can send a form or commit a change). */
const isPress = (a: ProofAct) => a.type === "click" || a.type === "dblclick" || (a.type === "press" && /^(?:(?:Control|Ctrl|Meta|Cmd|Command)\+)?(?:Enter|NumpadEnter)$/i.test(a.key ?? ""));
/** Choosing from a list or a group: what was chosen is the element's own name. */
const CHOOSING = /^(option|radio|menuitemradio|menuitemcheckbox|gridcell|treeitem)$/i;
/** A box whose typing is a search or a filter for a pick, not a value of the record. */
const SEARCHING = /^(combobox|searchbox)$/i;
/** A press that reads like a save or a send. */
/** Integration: W4 actions that move or set something already on the page. */
const MOVES_OR_SETS = /^(drag|drag_at|slide)$/;
const SAVE_LIKE = /\b(save|submit|add|create|publish|post|send|confirm|place|register|done|finish|ok|apply|update|book|record|log|wish)\b/i;
const DELETE_LIKE = /\b(delete|remove|trash|bin|discard|erase|destroy)\b/i;

/** The value an action gives, when it gives one strong enough to look for (a combobox's typing: see proofPlan). */
export function givenValue(a: ProofAct): string | undefined {
  if (a.type === "fill" || a.type === "type") return a.value;
  if (a.type === "select") return a.value;
  if ((a.type === "click" || a.type === "dblclick") && CHOOSING.test(a.role ?? "")) return a.name;
  return undefined;
}

/** Whether an action gives a value at all (strong or not): the start of a write. */
const gives = (a: ProofAct) => a.type === "fill" || a.type === "type" || a.type === "select" || a.type === "check" || a.type === "uncheck" || ((a.type === "click" || a.type === "dblclick") && CHOOSING.test(a.role ?? ""));

/**
 * What the proof will look for, decided from the goal and the actions alone, before anything is
 * measured. `since`: readings taken before action `since` (inclusive) are the "before".
 */
export function proofPlan(goal: string, acts: readonly ProofAct[]): ProofPlan {
  const quoted = quotedIn(goal).filter(strongValue);
  const presses = acts.filter(isPress);
  const firstPressLike = (re: RegExp) => presses.find((a) => !CHOOSING.test(a.role ?? "") && re.test(a.name ?? ""));
  // A setting turned on or off: its state after a fresh load.
  const t = TOGGLES.exec(goal);
  if (t && quoted.length) {
    const on = /^(on|enabl|activat)/i.test(t[1] ?? t[2] ?? "");
    const named = quoted.find((q) => acts.some((a) => (a.type === "click" || a.type === "check" || a.type === "uncheck") && a.name && fold(a.name).includes(fold(q)))) ?? quoted[0]!;
    const press = acts.find((a) => (a.type === "click" || a.type === "check" || a.type === "uncheck") && a.name && fold(a.name).includes(fold(named)));
    if (press) return { kind: "toggle", name: named, on, since: press.seq, press: press.seq };
  }
  // A delete: the goal's named row must go, exactly once.
  if (DELETES.test(goal) && !NOT_A_DELETE.test(goal)) {
    if (!quoted.length) return { kind: "none", why: "the goal names nothing to look for (no quoted name), so the delete can't be counted" };
    const press = firstPressLike(DELETE_LIKE) ?? presses.at(-1);
    if (!press) return { kind: "none", why: "nothing was pressed" };
    // A goal that makes and then deletes the same row is proved by the delete.
    return { kind: "gone", values: quoted, since: press.seq, press: press.seq };
  }
  // Typed values, grouped by the press that sent them: the last group with a strong value is the
  // final write (a rename's new name, a wizard's first page when later pages hold only numbers).
  type Group = { first: number; values: string[]; typed: string[]; press?: number };
  const groups: Group[] = [];
  let cur: Group | undefined;
  // Words typed into a combobox or search box: a search for a pick, unless no pick follows (then the
  // typing was the value, as a combobox that takes free text).
  let searched: string | undefined;
  const keep = (g: Group, v: string | undefined, typed: boolean) => {
    if (!strongValue(v) || g.values.includes(v.trim())) return;
    g.values.push(v.trim());
    if (typed) g.typed.push(v.trim());
  };
  const close = (g: Group) => {
    if (searched !== undefined) keep(g, searched, true);
    searched = undefined;
  };
  for (const a of acts) {
    if (gives(a)) {
      cur ??= { first: a.seq, values: [], typed: [] };
      if ((a.type === "fill" || a.type === "type") && SEARCHING.test(a.role ?? "")) {
        if (searched !== undefined) keep(cur, searched, true);
        searched = a.value;
        continue;
      }
      if (CHOOSING.test(a.role ?? "") && a.type !== "check" && a.type !== "uncheck") searched = undefined;
      else if (searched !== undefined) close(cur);
      keep(cur, givenValue(a), a.type === "fill" || a.type === "type");
      continue;
    }
    if (isPress(a) && cur) {
      close(cur);
      groups.push({ ...cur, press: a.seq });
      cur = undefined;
    }
  }
  if (cur) {
    close(cur);
    groups.push(cur);
  }
  const quotedIs = (v: string) => quoted.some((q) => fold(q) === fold(v));
  // The goal's own quoted value, where one was given ("named "X"" in a wizard's first page beats a
  // later page's pick); else the last group with a strong value. Within it, what was typed beats
  // what was picked: a pick's words are on the form itself (a radio's label, an option).
  const last = [...groups].reverse().find((g) => g.values.some(quotedIs)) ?? [...groups].reverse().find((g) => g.values.length);
  if (last) {
    const fromGoal = last.values.filter(quotedIs);
    const values = fromGoal.length ? fromGoal : last.typed.length ? last.typed : last.values;
    return { kind: "persists", values, since: last.first, ...(last.press !== undefined ? { press: last.press } : {}), from: "typed", ...(fromGoal.length > 1 ? { all: true } : {}) };
  }
  // Integration (W3 with W4): a move or a setting (a card dragged to another column, a slider set to a
  // number) changes something already on the page: its name shows as often before as after, so a count
  // can't show it was kept. The step's own check decides; the proof neither holds nor fails it.
  if (acts.some((a) => MOVES_OR_SETS.test(a.type))) return { kind: "none", why: "the change moves or sets something already on the page (a drag, a slider), which counting its name can't show" };
  // Nothing typed (a wishlist's "Add"): the goal's quoted names, if none is a control that was pressed.
  const pressedNames = presses.map((a) => fold(a.name ?? ""));
  const names = quoted.filter((q) => !pressedNames.some((p) => p && (p === fold(q) || p.includes(fold(q)))));
  if (names.length) {
    const press = firstPressLike(SAVE_LIKE) ?? presses[0];
    if (!press) return { kind: "none", why: "nothing was pressed" };
    return { kind: "persists", values: names, since: press.seq, press: press.seq, from: "goal" };
  }
  return { kind: "none", why: "nothing was typed or picked that could be found again (no name or text with letters in it)" };
}

/** An address as a page key: no fragment. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/** Each page's count of each value before the save: the highest count on any reading up to `since`. */
export function baselines(readings: readonly Reading[], values: readonly string[], since: number): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of readings) {
    if (r.seq > since) continue;
    const m = out.get(r.url) ?? new Map<string, number>();
    for (const v of values) m.set(v, Math.max(m.get(v) ?? 0, countIn(r.text, v)));
    out.set(r.url, m);
  }
  return out;
}

/** What a fresh load measured on one page. */
export interface Measured {
  url: string;
  counts: Record<string, number>;
  /** The toggle's state, when one was looked for and found. */
  state?: boolean;
}

/** The write requests the press caused, read as support: "" when one succeeded, the failure when all failed. */
export function requestsSay(requests: readonly WriteRequest[], press: number | undefined): { ok: boolean; failed?: string; caused: WriteRequest[] } {
  const caused = press === undefined ? [] : requests.filter((r) => r.seq === press);
  // The save is the first write the press itself sent; what follows it (a list read again) isn't.
  const save = caused.find((r) => !r.late && (r.status !== undefined || r.failed));
  if (!save) return { ok: false, caused };
  // A redirect (POST, then 302/303 to the new row: Rails, Django, Laravel, PHP) is a save that worked.
  const good = (r: WriteRequest) => !r.failed && r.status !== undefined && r.status >= 200 && r.status < 400;
  if (good(save)) return { ok: true, caused };
  // A retry of the same request that worked (a page that retries a 503 by itself) is the save.
  const at = caused.indexOf(save);
  if (caused.slice(at + 1).some((r) => r.method === save.method && r.path === save.path && good(r))) return { ok: true, caused };
  return { ok: false, failed: `the save's request (${save.method} ${save.path}) answered ${save.failed ?? `status ${save.status}`}`, caused };
}

/**
 * A "held" stands only when the save's own request didn't fail: a page that shows the change while the
 * server answered 4xx, 5xx or an error body (kept only in this browser's storage, an optimistic row
 * a fresh load rebuilds from local data) is "failed", never held.
 */
function heldUnless(support: { failed?: string }, held: WriteProof): WriteProof {
  if (!support.failed) return held;
  const { strength: _s, ...rest } = held;
  return { ...rest, status: "failed", why: `${held.why}, but ${support.failed}: it may be kept only in this browser, not by the site` };
}

const plural = (n: number) => `${n} time${n === 1 ? "" : "s"}`;
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/**
 * The proof's verdict from what was fixed before the press and what fresh loads measured (pure).
 * Held only on evidence; failed only when a page was measured and the change wasn't there; otherwise
 * unmeasured.
 */
export function judgeProof(
  plan: ProofPlan,
  before: Map<string, Map<string, number>>,
  measured: readonly Measured[],
  o: {
    requests?: readonly WriteRequest[];
    unmeasured?: string[];
    /** Each page's counts as the run saw it live after the press. */
    after?: Map<string, Map<string, number>>;
    /** Where the run ended (urlKey): a value taken from the goal (nothing typed) can fail only there or where the run saw it rise. */
    endUrl?: string;
    /** This run's own marker: only a value carrying it is strong on a page first seen after the save. Never another run's. */
    marker?: Marker;
  } = {},
): WriteProof {
  const support = requestsSay(o.requests ?? [], plan.kind === "none" ? undefined : plan.press);
  const requests = support.caused.length ? { requests: support.caused } : {};
  const notes = o.unmeasured?.length ? ` (${o.unmeasured.join("; ")})` : "";
  if (plan.kind === "none") return { status: "unmeasured", kind: "none", why: plan.why, ...requests };
  if (!measured.length) return { status: "unmeasured", kind: plan.kind, why: `no page could be opened again to look${notes}`, ...requests };
  if (plan.kind === "toggle") {
    const m = measured.find((x) => x.state !== undefined);
    if (!m) return { status: "unmeasured", kind: "toggle", why: `"${plan.name}" couldn't be found as a switch or checkbox after a fresh load`, ...requests };
    const seen = [{ value: plan.name, url: m.url, after: m.state ? 1 : 0 }];
    if (m.state === plan.on) return heldUnless(support, { status: "held", kind: "toggle", strength: "strong", why: `after a fresh load of ${pathOf(m.url)}, "${plan.name}" is still ${plan.on ? "on" : "off"}`, seen, ...requests });
    return { status: "failed", kind: "toggle", why: `after a fresh load of ${pathOf(m.url)}, "${plan.name}" is ${m.state ? "on" : "off"} again${support.failed ? `, and ${support.failed}` : ""}`, seen, ...requests };
  }
  const seen: NonNullable<WriteProof["seen"]> = [];
  const everBefore = (v: string) => Math.max(0, ...[...before.values()].map((m) => m.get(v) ?? 0));
  if (plan.kind === "gone") {
    let worst: string | undefined;
    for (const m of measured) {
      const b = pageIn(before, m.url);
      for (const v of plan.values) {
        const after = m.counts[v] ?? 0;
        const was = b?.get(v);
        seen.push({ value: v, url: m.url, ...(was !== undefined ? { before: was } : {}), after });
        if (was === undefined || was < 1) continue;
        if (after === was - 1) return heldUnless(support, { status: "held", kind: "gone", strength: "strong", why: `after a fresh load of ${pathOf(m.url)}, "${v}" shows ${plural(after)}, one fewer than before the delete (${was})`, seen, ...requests });
        worst ??= after === was ? `after a fresh load of ${pathOf(m.url)}, "${v}" still shows ${plural(after)}, as before the delete` : after < was ? `after a fresh load of ${pathOf(m.url)}, "${v}" shows ${plural(after)}, ${was - after} fewer than before the delete (${was}): more than one went, so it can't be told the right one did` : `after a fresh load of ${pathOf(m.url)}, "${v}" shows more often than before the delete (${was} to ${after})`;
      }
    }
    if (worst) return { status: "failed", kind: "gone", why: `${worst}${support.failed ? `, and ${support.failed}` : ""}`, seen, ...requests };
    return { status: "unmeasured", kind: "gone", why: `"${plan.values.join('", "')}" wasn't seen on any page before the delete, so its count can't be compared${notes}`, seen, ...requests };
  }
  // persists. When the goal quoted several values and all were typed, each must show kept on the
  // same page: a save that keeps the name but drops the notes (a stale form state) is not held.
  let partial: string | undefined;
  const allOn = (m: Measured, ok: (w: string) => boolean, v: string): boolean => {
    if (!plan.all) return true;
    const missing = plan.values.filter((w) => w !== v && !ok(w));
    if (missing.length) partial ??= `after a fresh load of ${pathOf(m.url)}, "${v}" shows kept but "${missing.join('", "')}" doesn't show there with it, so the whole change can't be told kept`;
    return !missing.length;
  };
  for (const m of measured) {
    const b = pageIn(before, m.url);
    const rose = (w: string) => b?.get(w) !== undefined && (m.counts[w] ?? 0) > (b.get(w) ?? 0);
    for (const v of plan.values) {
      const after = m.counts[v] ?? 0;
      const was = b?.get(v);
      seen.push({ value: v, url: m.url, ...(was !== undefined ? { before: was } : {}), after });
      if (was !== undefined && after > was && allOn(m, rose, v)) return heldUnless(support, { status: "held", kind: "persists", strength: "strong", why: `after a fresh load of ${pathOf(m.url)}, "${v}" shows ${plural(after)}, ${after - was} more than before the save (${was})`, seen, ...requests });
    }
  }
  // A page first seen after the save (the new record's own page): the value shows there, and it
  // showed on no page before the save. Weaker: not when the save's own request answered a failure.
  for (const m of measured) {
    if (pageIn(before, m.url)) continue;
    for (const v of plan.values) {
      const after = m.counts[v] ?? 0;
      const marked = Boolean(o.marker && hasMarker(v, o.marker));
      if (after >= 1 && everBefore(v) === 0 && allOn(m, (w) => (m.counts[w] ?? 0) >= 1 && everBefore(w) === 0, v)) return heldUnless(support, { status: "held", kind: "persists", strength: marked ? "strong" : "weak", why: `after a fresh load of ${pathOf(m.url)} (a page first seen after the save), "${v}" shows ${plural(after)}, and it showed on no page before the save${marked ? " (it carries this run's own marker)" : ""}`, seen, ...requests });
    }
  }
  // Failed only where the page can tell: it listed the value before the save (a look-alike row, an
  // older one), or the run itself saw the value on that page after the press (an optimistic row, a
  // row added on screen only), and a fresh load shows it no more often than before the save.
  for (const m of measured) {
    const b = pageIn(before, m.url);
    const live = pageIn(o.after ?? new Map(), m.url);
    for (const v of plan.values) {
      const after = m.counts[v] ?? 0;
      const was = b?.get(v) ?? 0;
      const sawAfter = live?.get(v) ?? 0;
      if (after > was) continue;
      // A name taken from the goal (nothing typed: a cart, a wishlist, a class to join) is on its
      // catalog page before and after: that page can only tell where the run ended on it, or where
      // the run saw the count rise after the press. Elsewhere (a cart kept on another page) it can't.
      const canTell = plan.from !== "goal" || sawAfter > was || (o.endUrl !== undefined && m.url === o.endUrl);
      if (was >= 1 && !canTell) continue;
      if (was >= 1) return { status: "failed", kind: "persists", why: `after a fresh load of ${pathOf(m.url)}, "${v}" shows ${plural(after)}, no more than before the save (${was}): the new one isn't kept${support.failed ? `, and ${support.failed}` : ""}`, seen, ...requests };
      if (sawAfter > was) return { status: "failed", kind: "persists", why: `"${v}" showed on ${pathOf(m.url)} after the save was pressed, but a fresh load of it shows it ${after ? plural(after) : "nowhere"}: it was shown, not kept${support.failed ? `, and ${support.failed}` : ""}`, seen, ...requests };
    }
  }
  if (support.failed) return { status: "failed", kind: "persists", why: `"${plan.values.join('", "')}" doesn't show on any page opened again, and ${support.failed}`, seen, ...requests };
  if (partial) return { status: "unmeasured", kind: "persists", why: `${partial}${notes}`, seen, ...requests };
  return { status: "unmeasured", kind: "persists", why: `"${plan.values.join('", "')}" doesn't show on any page opened again (${[...new Set(measured.map((m) => pathOf(m.url)))].join(", ")}), so it can't be told whether it was kept${notes}`, seen, ...requests };
}

/** A page's counts: its own, or else those of the same page with another query (a "?saved=1" after the save). */
function pageIn(map: Map<string, Map<string, number>>, url: string): Map<string, number> | undefined {
  const exact = map.get(url);
  if (exact) return exact;
  const path = url.split(/[?#]/)[0];
  for (const [k, v] of map) if (k.split(/[?#]/)[0] === path) return v;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The page (browser)

/**
 * Runs in the page: its plain text as a person reads it, without what is typed or offered (fields,
 * editors, option lists), what is said for a moment (toasts, alerts, status and live regions), and
 * what is hidden. Open shadow roots are read too. Self-contained.
 */
export function plainText(): string {
  const SKIP = 'input,textarea,select,option,datalist,script,style,noscript,template,svg,[contenteditable]:not([contenteditable="false"]),[role=textbox],[role=searchbox],[role=combobox],[role=listbox],[role=option],[role=alert],[role=alertdialog],[role=status],[role=log],[role=tooltip],[aria-live=polite],[aria-live=assertive],[class*="toast" i],[class*="snackbar" i]';
  const blocks = new Map<Element, Element>();
  const blockOf = (el: Element | null): Element | null => {
    if (!el) return null;
    const hit = blocks.get(el);
    if (hit) return hit;
    let b: Element = el;
    for (let x: Element | null = el; x; x = x.parentElement) {
      b = x;
      const d = getComputedStyle(x).display;
      if (!d.startsWith("inline") && d !== "contents") break;
    }
    blocks.set(el, b);
    return b;
  };
  // Text hidden for the eye but kept for screen readers (the "sr-only" clip / 1px trick: "Edit, Lunch"
  // inside a row's button) is not what a person reads: counted, it would show each row's name twice.
  const srOnly = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    if (cs.position !== "absolute" && cs.position !== "fixed") return false;
    if (/rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/.test(cs.clip)) return true;
    if (/inset\(\s*50%/.test(cs.clipPath)) return true;
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1 && cs.overflow !== "visible";
  };
  const shown = (el: Element): boolean => {
    if (srOnly(el)) return false;
    const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (check) {
      if (check.call(el, { visibilityProperty: true })) return true;
      return getComputedStyle(el).display === "contents";
    }
    return el.getClientRects().length > 0;
  };
  const out: string[] = [];
  let lastBlock: Element | null = null;
  let size = 0;
  const walk = (root: Node) => {
    for (let c = root.firstChild; c && size < 300_000; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c.nodeValue ?? "";
        if (!t.trim()) {
          if (t) out.push(" ");
          continue;
        }
        const b = blockOf(c.parentElement);
        if (b !== lastBlock) {
          out.push("\n");
          lastBlock = b;
        }
        out.push(t);
        size += t.length;
      } else if (c.nodeType === 1) {
        const el = c as Element;
        if (el.matches(SKIP) || !shown(el)) continue;
        if (el.shadowRoot) walk(el.shadowRoot);
        walk(el);
      }
    }
  };
  if (document.body) walk(document.body);
  return out.join("");
}

/** The page's plain text now, folded; "" when it can't be read. */
export async function readPlain(page: Page): Promise<string> {
  return fold(await page.evaluate(plainText).catch(() => ""));
}

/** Words in an address that mean opening it does something (sends, deletes, pays, signs out). */
const DOES_SOMETHING = /(^|[/_.?=&-])(delete|remove|destroy|logout|log-out|signout|sign-out|unsubscribe|checkout|pay|payment|purchase|buy|order|confirm|callback|oauth|token|verify|activate|reset|save|submit|create|update|approve|accept|cancel|add|add-to-cart|addtocart|join|register|subscribe|follow|unfollow|like|unlike|vote|upvote|rsvp|book|enrol|enroll|archive|toggle|complete|send|invite|claim|redeem|apply)([/_.?=&-]|$)/i;

/** Whether an address may be opened again to look: same site, nothing in it that acts, no value the run typed in its query (a sent GET form). */
export function safeToReopen(url: string, onSite: (u: string) => boolean, typed: readonly string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || !onSite(url)) return false;
  if (DOES_SOMETHING.test(`${u.pathname}${u.search}`)) return false;
  let q = u.search;
  try {
    q = decodeURIComponent(u.search.replace(/\+/g, " "));
  } catch {
    // read as it is
  }
  const fq = fold(q);
  return !typed.some((v) => v.trim().length >= 2 && fq.includes(fold(v)));
}

/** A switch, checkbox or toggle button named `name`, read: on, off, or not found. */
async function stateOf(page: Page, name: string): Promise<boolean | undefined> {
  for (const role of ["switch", "checkbox", "menuitemcheckbox"] as const) {
    const l = page.getByRole(role, { name });
    if (await l.count().catch(() => 0)) return await l.first().isChecked().catch(() => undefined);
  }
  if (await page.getByRole("button", { name, pressed: true }).count().catch(() => 0)) return true;
  if (await page.getByRole("button", { name, pressed: false }).count().catch(() => 0)) return false;
  // Named some other way (a label around it, the words beside it in its row): the closest by its words.
  return page.evaluate((want) => {
    const f = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const w = f(want);
    let best: { len: number; on: boolean } | undefined;
    for (const el of document.querySelectorAll<HTMLElement>('[role=switch],[role=checkbox],[role=menuitemcheckbox],input[type=checkbox],[aria-pressed]')) {
      if (!el.getClientRects().length) continue;
      const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const own = [el.getAttribute("aria-label"), ...ids.map((id) => document.getElementById(id)?.textContent), el.textContent, ...[...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent), el.closest("label")?.textContent].map(f).join(" ");
      const row = f(el.parentElement?.textContent);
      const words = own.includes(w) ? own : row.length <= 120 && row.includes(w) ? row : "";
      if (!words) continue;
      const on = el instanceof HTMLInputElement ? el.checked : (el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed")) === "true";
      if (!best || words.length < best.len) best = { len: words.length, on };
    }
    return best?.on;
  }, name).catch(() => undefined);
}

export interface FreshOptions {
  browser: Browser;
  /** The run's context: its cookies and local storage are carried over, nothing else. */
  from: BrowserContext;
  onSite: (url: string) => boolean;
  viewport?: { width: number; height: number } | null;
  /** How long one fresh load is watched for the change (the list loading), ms. */
  watchMs?: number;
  /** Fresh loads of the first page in all, and the pause between them (a slow save), ms. */
  tries?: number;
  retryMs?: number;
}

/**
 * One page opened again in a fresh context and read until `enough` says so or the watch ends: the
 * counts of `values`, and a toggle's state. Nothing is clicked or typed there. Never off the site.
 */
export async function freshLook(url: string, values: readonly string[], toggle: string | undefined, enough: (m: Measured) => boolean, o: FreshOptions & { tries: number }): Promise<Measured | { unmeasured: string }> {
  const state = await o.from.storageState().catch(() => undefined);
  const ctx = await o.browser.newContext({ ...(state ? { storageState: state } : {}), ...(o.viewport ? { viewport: o.viewport } : {}), serviceWorkers: "block", acceptDownloads: false });
  try {
    // Integration (W3 with W5): the fresh look sees inside closed shadow roots as the run did.
    await seeShadowRoots(ctx);
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    await page.route("**/*", (route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        if (!o.onSite(r.url())) return route.abort("blockedbyclient");
        return route.continue({ headers: { ...r.headers(), "cache-control": "no-cache", pragma: "no-cache" } });
      }
      return route.continue();
    });
    let last: Measured | { unmeasured: string } = { unmeasured: "it couldn't be opened" };
    for (let attempt = 0; attempt < o.tries; attempt++) {
      if (attempt) await page.waitForTimeout(o.retryMs ?? 1500);
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch((e: unknown) => e as Error);
      if (res instanceof Error) {
        last = { unmeasured: `it couldn't be opened again (${res.message.split("\n")[0]})` };
        continue;
      }
      if (res && res.status() >= 400) {
        last = { unmeasured: `opening it again answered ${res.status()}` };
        continue;
      }
      if (!o.onSite(page.url())) {
        last = { unmeasured: "it went off the site when opened again" };
        continue;
      }
      const until = Date.now() + (o.watchMs ?? 2500);
      for (;;) {
        const signIn = await page.locator("input[type=password]").evaluateAll((els) => els.some((e) => (e as HTMLElement).getClientRects().length > 0)).catch(() => false);
        if (signIn) {
          last = { unmeasured: "opened again, it asked to sign in" };
          break;
        }
        const text = await readPlain(page);
        const counts = Object.fromEntries(values.map((v) => [v, countIn(text, v)]));
        const st = toggle ? await stateOf(page, toggle) : undefined;
        const m: Measured = { url: urlKey(page.url()), counts, ...(st !== undefined ? { state: st } : {}) };
        last = m;
        // Only the run's own values are compared: a live page's ticking never decides anything.
        if (enough(m)) return m;
        if (Date.now() >= until) break;
        await page.waitForTimeout(300);
      }
    }
    return last;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export interface ProveOptions extends FreshOptions {
  goal: string;
  acts: readonly ProofAct[];
  readings: readonly Reading[];
  requests: readonly WriteRequest[];
  /** Where the run ended. */
  endUrl: string;
  /** When the last action ended (ms): the fresh look waits until a moment after it. */
  lastActionAt: number;
  /** The wait after the last action before looking, so an optimistic row that rolls back is gone. */
  settleMs?: number;
  /** At most this many pages are opened again. */
  maxPages?: number;
  /** The run's page as it ended, plain text folded (readPlain): what it showed after the last press. */
  endText?: string;
  /** The page loads each press caused (WriteWatch.navs): an address reached by a plain GET at or after the save is never opened again. */
  navigations?: readonly PressNav[];
  /** This run's own marker (marker.ts), when its made-up values carry one. */
  marker?: Marker;
  /**
   * Where the record should show besides the pages the run read: the address the test started on, and
   * the site's own links whose words name what the goal makes ("add a trade" → "Trades", "a contact" →
   * "Contacts"). Looked at after the run's end page and the pages that can tell, before the rest.
   */
  listPages?: readonly string[];
}

/** Words of a goal that can name a list: not the asking and doing words around them. */
const NOT_A_THING = new Set(["please", "could", "would", "should", "can", "will", "for", "with", "the", "and", "then", "that", "this", "them", "some", "any", "one", "new", "add", "adds", "adding", "create", "make", "save", "enter", "record", "log", "put", "manual", "manually", "test", "tests", "testing", "check", "sure", "works", "work", "working", "page", "form", "button", "open", "into", "onto", "from", "have", "has", "just", "let", "lets", "see", "want", "need", "able", "try"]);
const stem = (w: string) => w.toLowerCase().replace(/(ies)$/, "y").replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
/** The goal's nouns, stemmed: what a list link would be named after. */
export function goalThings(goal: string): string[] {
  return [...new Set(goal.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !NOT_A_THING.has(w)).map(stem))];
}
/** Links (words and address) whose words name one of the goal's things: the site's own list of them. */
export function listLinks(goal: string, links: readonly { text: string; href: string }[]): string[] {
  const things = new Set(goalThings(goal));
  if (!things.size) return [];
  return [...new Set(links.filter((l) => l.text.length <= 40 && l.text.split(/[^A-Za-z]+/).some((w) => w && things.has(stem(w)))).map((l) => l.href))];
}

/**
 * Addresses that opening again could do something again: reached by a plain page load (a GET link,
 * a GET form) from a press at or after `since`, when that press sent no write of its own (POST, PUT,
 * fetch) and the load wasn't a redirect from one. A cart's "?add-to-cart=7", a "/classes/join?id=3".
 */
export function actedByLoad(navs: readonly PressNav[], requests: readonly WriteRequest[], since: number): Set<string> {
  const out = new Set<string>();
  for (const n of navs) {
    if (n.seq < since || n.viaWrite) continue;
    if (requests.some((w) => w.seq === n.seq && !w.late)) continue;
    out.add(n.url);
  }
  return out;
}

/**
 * The proof of a write: the plan fixed from the goal and the actions, the "before" from the run's own
 * readings, then fresh loads of where the run ended and of the pages it read before the save (newest
 * first, safe ones only), until one shows the change or the budget is spent.
 */
export async function proveWrite(o: ProveOptions): Promise<WriteProof> {
  const plan = proofPlan(o.goal, o.acts);
  if (plan.kind === "none") return judgeProof(plan, new Map(), [], { requests: o.requests });
  const values = plan.kind === "toggle" ? [] : plan.values;
  const before = baselines(o.readings, values, plan.since);
  if (plan.kind === "toggle") for (const r of o.readings) if (r.seq <= plan.since && !before.has(r.url)) before.set(r.url, new Map());
  const typed = o.acts.flatMap((a) => (a.type === "fill" || a.type === "type" || a.type === "select" ? [a.value ?? ""] : []));
  // What the run saw live after the press (later readings, and the page as the run ended).
    const lateReadings = [...o.readings.filter((r) => r.seq > plan.since), ...(o.endText !== undefined ? [{ seq: Number.MAX_SAFE_INTEGER, url: urlKey(o.endUrl), text: o.endText }] : [])];
  const after = new Map<string, Map<string, number>>();
  for (const r of lateReadings) {
    const m = after.get(r.url) ?? new Map<string, number>();
    for (const v of values) m.set(v, Math.max(m.get(v) ?? 0, countIn(r.text, v)));
    after.set(r.url, m);
  }
  // Where to look: where the run ended first, then the pages that can tell (the value showed there
  // before the save, or the run saw it there after), then the other pages read before the save, newest first.
  const shows = (m: Map<string, number> | undefined) => Boolean(m && [...m.values()].some((n) => n >= 1));
  const recent = [...new Set([...o.readings].sort((a, b) => b.seq - a.seq).map((r) => r.url))];
  const telling = recent.filter((u) => shows(before.get(u)) || shows(after.get(u)));
  const acted = actedByLoad(o.navigations ?? [], o.requests, plan.since);
  const endUrl = urlKey(o.endUrl);
  const candidates = [...new Set([endUrl, ...telling, ...(o.listPages ?? []).map(urlKey), ...recent])].filter((u) => !acted.has(u) && safeToReopen(u, o.onSite, typed)).slice(0, o.maxPages ?? 4);
  const judgeO = { requests: o.requests, after, endUrl, ...(o.marker ? { marker: o.marker } : {}) };
  const wait = o.lastActionAt + (o.settleMs ?? 1200) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const enough = (m: Measured): boolean => {
    if (plan.kind === "toggle") return m.state !== undefined && m.state === plan.on;
    const b = pageIn(before, m.url);
    if (plan.kind === "gone") return Boolean(b && plan.values.some((v) => (b.get(v) ?? 0) >= 1 && (m.counts[v] ?? 0) === (b.get(v) ?? 0) - 1));
    const shown = (v: string) => (b ? (m.counts[v] ?? 0) > (b.get(v) ?? 0) : (m.counts[v] ?? 0) >= 1 && Math.max(0, ...[...before.values()].map((x) => x.get(v) ?? 0)) === 0);
    return plan.kind === "persists" && plan.all ? plan.values.every(shown) : plan.values.some(shown);
  };
  const measured: Measured[] = [];
  const unmeasured: string[] = [];
  for (const [i, url] of candidates.entries()) {
    // A slow save is waited for (a second fresh load) only where the page can tell, and only on a page
    // the run read before the save: a page first reached after a press is loaded once, never twice.
    const tells = (i === 0 || telling.includes(url)) && before.has(url);
    const m = await freshLook(url, values, plan.kind === "toggle" ? plan.name : undefined, enough, { ...o, tries: tells ? (o.tries ?? 2) : 1, watchMs: tells ? (o.watchMs ?? 2000) : Math.min(o.watchMs ?? 2000, 1200) }).catch((e: unknown) => ({ unmeasured: e instanceof Error ? e.message.split("\n")[0]! : String(e) }));
    if ("unmeasured" in m) {
      unmeasured.push(`${pathOf(url)}: ${m.unmeasured}`);
      continue;
    }
    measured.push(m);
    const verdict = judgeProof(plan, before, [m], judgeO);
    // A strong proof ends the search; a weak one (a page first seen after the save) looks on, for a
    // page read before the save that shows the rise.
    if (verdict.status === "held" && verdict.strength === "strong") return judgeProof(plan, before, measured, judgeO);
  }
  if (!candidates.length) unmeasured.push("no page the run saw can be opened again safely");
  return judgeProof(plan, before, measured, { ...judgeO, unmeasured });
}

// ---------------------------------------------------------------------------------------------
// The save request (support only)

/** Why a JSON answer reads as a failure though its status may be 200: GraphQL errors, ok:false… */
export function errorShape(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.errors) && b.errors.length) return "errors in its body";
  if (b.ok === false || b.success === false) return `${b.ok === false ? "ok" : "success"}: false in its body`;
  if (typeof b.status === "string" && /^(error|fail(ed|ure)?)$/i.test(b.status)) return `status "${b.status}" in its body`;
  if ((typeof b.error === "string" && b.error.trim()) || (b.error && typeof b.error === "object")) return "an error in its body";
  return undefined;
}

/**
 * The write requests each press causes (anything but GET, HEAD and OPTIONS, on the site), with their
 * answers: a status, and an error shape read from a small JSON body. Support only.
 */
export class WriteWatch {
  readonly list: WriteRequest[] = [];
  /** The main frame's page loads each press caused. */
  readonly navs: PressNav[] = [];
  private seq = -1;
  /** The last press: requests after its action ends, before the next, are its late ones (a retry). */
  private lastSeq = -1;
  private readonly byRequest = new Map<Request, WriteRequest>();
  private readonly offs: (() => void)[] = [];
  constructor(page: Page, onSite: (url: string) => boolean) {
    const start = (r: Request) => {
      const seq = this.seq >= 0 ? this.seq : this.lastSeq;
      if (seq < 0) return;
      const late = this.seq < 0;
      let main = false;
      try {
        main = r.isNavigationRequest() && r.frame() === page.mainFrame();
      } catch {
        main = false;
      }
      if (main && !late && /^GET$/i.test(r.method()) && this.navs.length < 200) {
        let viaWrite = false;
        for (let x = r.redirectedFrom(); x; x = x.redirectedFrom()) if (!/^(GET|HEAD)$/i.test(x.method())) viaWrite = true;
        this.navs.push({ seq, url: urlKey(r.url()), ...(viaWrite ? { viaWrite } : {}) });
      }
      if (/^(GET|HEAD|OPTIONS)$/i.test(r.method()) || this.list.length >= 200) return;
      let ok = false;
      try {
        ok = onSite(r.url());
      } catch {
        ok = false;
      }
      if (!ok) return;
      const w: WriteRequest = { seq, method: r.method(), path: pathOf(r.url()).split("?")[0]!, ...(late ? { late } : {}) };
      this.list.push(w);
      this.byRequest.set(r, w);
    };
    const answered = async (res: Response) => {
      const w = this.byRequest.get(res.request());
      if (!w) return;
      w.status = res.status();
      if (w.status >= 400) w.failed = `status ${w.status}`;
      const type = res.headers()["content-type"] ?? "";
      if (!w.failed && /json/i.test(type)) {
        const text = await res.text().catch(() => "");
        if (text.length < 100_000) {
          try {
            const shape = errorShape(JSON.parse(text));
            if (shape) w.failed = `${w.status} with ${shape}`;
          } catch {
            // not JSON after all
          }
        }
      }
    };
    const lost = (r: Request) => {
      const w = this.byRequest.get(r);
      if (w && w.status === undefined) w.failed = "nothing (the request failed)";
    };
    const onRes = (res: Response) => void answered(res);
    page.on("request", start);
    page.on("response", onRes);
    page.on("requestfailed", lost);
    this.offs.push(() => page.off("request", start), () => page.off("response", onRes), () => page.off("requestfailed", lost));
  }
  /** Requests from now on are action `seq`'s. */
  begin(seq: number): void {
    this.seq = seq;
    this.lastSeq = seq;
  }
  end(): void {
    this.seq = -1;
  }
  stop(): void {
    for (const off of this.offs) off();
  }
}
