/**
 * Tests (TestDef) for the app: the step cards a person edits, over the engine's saved tests.
 *
 * - A saved test already on disk (contextmachines/tests/<host>/<slug>.json) lists as "learned", with
 *   old steps read as "act", or "assert" when their check measures something (C4).
 * - Saving writes a SavedTest (rules 2) the engine replays. Only enabled steps are written. A step with
 *   no saved actions makes the file a draft, so its first run asks the AI for that step only.
 * - Editing a step's intent or check drops that step's saved actions and marks it edited (C5): the
 *   next run never replays old clicks under new words. Other steps keep theirs.
 * - Deleting hides the test from the app; the file on disk is left alone.
 */
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkFrom, KNOWN_RULES, listSaved, readSaved, savedPathFor, writeSaved, type SavedStep } from "../../../packages/scanner/src/tester/cache.ts";
import type { CachedAction } from "../../../packages/scanner/src/tester/types.ts";
import { MAX_CLAIM } from "../../../packages/scanner/src/tester/judge.ts";
import { cardsFromSaved, kindOf, savedKind } from "../../../packages/scanner/src/tester/plan.ts";
import type { PlanStep, Project, ProjectId, RunSummary, StepKind, TestDef } from "../contracts.ts";
import type { History } from "./history.ts";
import { LABEL, outDirOf, STEPS_MAX, type AppStore, type StoredTest } from "./projects.ts";
import { bad, clip, isObj, newId, notFound, nowIso, stableId } from "./util.ts";

const ORIGINS = ["describe", "discovery", "learned"] as const;
const KINDS: StepKind[] = ["act", "assert", "login"];

/** The pass rate over the last 10 runs, BLOCKED and unfinished runs left out (C11). */
export function passRate(runs: RunSummary[]): number | undefined {
  const counted = runs.slice(0, 10).filter((r) => r.status === "completed" && r.verdict && r.verdict !== "blocked");
  if (!counted.length) return undefined;
  return Math.round((counted.filter((r) => r.verdict === "pass").length / counted.length) * 100) / 100;
}

/** Step cards sent by the editor, checked (no field trusted as typed). */
export function checkSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw) || !raw.length) throw bad("A test needs at least one step.");
  if (raw.length > STEPS_MAX) throw bad(`A test has at most ${STEPS_MAX} steps.`);
  const ids = new Set<string>();
  const steps = raw.map((s, i): PlanStep => {
    if (!isObj(s)) throw bad(`Step ${i + 1} isn't a step.`);
    const title = typeof s.title === "string" ? s.title.trim() : "";
    const intent = typeof s.intent === "string" ? s.intent.trim() : "";
    if (!title && !intent) throw bad(`Step ${i + 1} needs words.`);
    const check = checkFrom(s.check);
    if (!check) throw bad(`Step ${i + 1}'s check isn't one.`);
    let id = typeof s.id === "string" && /^[\w-]{1,24}$/.test(s.id) ? s.id : `s${i + 1}`;
    while (ids.has(id)) id = `${id}x`;
    ids.add(id);
    const kind = KINDS.includes(s.kind as StepKind) ? (s.kind as StepKind) : check.kind === "none" ? "act" : "assert";
    const accountLabel = typeof s.accountLabel === "string" && LABEL.test(s.accountLabel) ? s.accountLabel : undefined;
    if (kind === "login" && s.accountLabel !== undefined && !accountLabel) throw bad(`Step ${i + 1}: an account is its label, never a password.`);
    return { id, title: clip(title || intent, 120), intent: (intent || title).slice(0, 1000), check, kind, checkMode: s.checkMode === "judged" ? "judged" : "measured", enabled: s.enabled !== false, ...(accountLabel ? { accountLabel } : {}), ...(s.edited === true ? { edited: true as const } : {}) };
  });
  const on = steps.filter((s) => s.enabled);
  if (!on.length) throw bad("Switch on at least one step.");
  // The engine's own rules for a saved test: the last step measures something, and a step that
  // measures nothing is followed by one that does.
  if (on.at(-1)!.check.kind === "none") throw bad("The last step must check something, or the test would always pass.");
  for (const [i, s] of on.entries()) if (s.check.kind === "none" && on[i + 1]!.check.kind === "none") throw bad(`"${s.title}" checks nothing, so the step after it must check something.`);
  return steps;
}

/** A test's own account (TestDef.account): a label, never a password; null or "" clears it. */
function checkAccount(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !LABEL.test(raw)) throw bad("A test's account is its label, never a password.");
  return raw;
}

/** JSON with its keys in order: the same value however its object was built. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** A file's steps exactly as the cards would write them (words, check and saved clicks). */
const sameSteps = (a: readonly SavedStep[], b: readonly SavedStep[]) => a.length === b.length && a.every((x, k) => canon({ title: x.title, intent: x.intent, check: x.check, actions: x.actions }) === canon({ title: b[k]!.title, intent: b[k]!.intent, check: b[k]!.check, actions: b[k]!.actions }));
const same = (a: PlanStep, b: PlanStep) => a.intent === b.intent && JSON.stringify(a.check) === JSON.stringify(b.check);

export class Tests {
  private readonly store: AppStore;
  private readonly history: History;

  constructor(store: AppStore, history: History) {
    this.store = store;
    this.history = history;
    history.testIdFor = (projectId, goal, url) => this.idForRun(projectId, goal, url);
  }

  private testsDir(p: Project) {
    return join(outDirOf(p), "tests");
  }

  private hidden(): Set<string> {
    return new Set(this.store.data.hiddenFiles ?? []);
  }

  /** Saved tests on disk for the project's hosts that the app doesn't hold yet. */
  private learned(p: Project): StoredTest[] {
    const hosts = new Set(p.envs.map((e) => new URL(e.url).host.replace(/[^\w.-]+/g, "-")));
    const held = new Set(this.store.data.tests.filter((t) => t.projectId === p.id && t.file).map((t) => t.file));
    const hidden = this.hidden();
    const out: StoredTest[] = [];
    for (const path of listSaved(this.testsDir(p))) {
      const rel = relative(p.dir, path).split(sep).join("/");
      const host = rel.split("/").at(-2) ?? "";
      if (!hosts.has(host) || held.has(rel) || hidden.has(`${p.id}:${rel}`)) continue;
      let saved;
      try {
        saved = readSaved(path);
      } catch {
        continue;
      }
      const actions: Record<string, unknown[]> = {};
      const steps = saved.steps.map((s, i): PlanStep => {
        const id = `s${i + 1}`;
        if (s.actions) actions[id] = s.actions;
        // The first step is the Login card only when it signs in (kindOf: a sign-in check, or words that sign
        // in): never a step that only mentions a "Sign in" link on its way somewhere, whose own check would be lost.
        const login = saved.as && i === 0 && kindOf(s) === "login";
        return { id, title: s.title, intent: s.intent, check: s.check, kind: login ? "login" : savedKind(s), checkMode: s.check.kind === "judged" ? "judged" : "measured", enabled: true, ...(login ? { accountLabel: saved.as! } : {}) };
      });
      // A run that signed in first (the app signs in, so its sign-in steps were never saved) keeps its
      // account as the test's own: the replay signs in as it before step 1, never signed out.
      const account = saved.as && !saved.visitor && !steps.some((s) => s.kind === "login" && s.accountLabel === saved.as) ? saved.as : undefined;
      const env = p.envs.find((e) => new URL(e.url).host.replace(/[^\w.-]+/g, "-") === host);
      out.push({ id: stableId("tst", `${p.id}:${rel}`), projectId: p.id, name: clip(saved.goal, 80), goal: saved.goal, steps, ...(account ? { account } : {}), ...(env ? { envId: env.id } : {}), origin: "learned", file: rel, createdAt: saved.savedAt || nowIso(), updatedAt: saved.savedAt || nowIso(), actions });
    }
    return out;
  }

  private all(projectId: ProjectId): StoredTest[] {
    const p = this.store.project(projectId);
    return [...this.store.data.tests.filter((t) => t.projectId === projectId), ...this.learned(p)];
  }

  private find(id: string): StoredTest {
    if (!/^tst_[0-9a-f]{12}$/.test(id)) throw notFound("test");
    const own = this.store.data.tests.find((t) => t.id === id);
    if (own) return own;
    for (const p of this.store.projects()) {
      const hit = this.learned(p).find((t) => t.id === id);
      if (hit) return hit;
    }
    throw notFound("test");
  }

  /** A test as the page sees it: no saved actions (they stay here), with its last run and pass rate. */
  private view(t: StoredTest, runs?: RunSummary[]): TestDef {
    const { actions: _actions, ...def } = t;
    const mine = (runs ?? this.history.index(t.projectId).runs).filter((r) => r.testId === t.id);
    const rate = passRate(mine);
    return { ...def, ...(mine[0] ? { last: mine[0] } : {}), ...(rate !== undefined ? { passRate: rate } : {}) };
  }

  /** The test a run belongs to, from its goal and address (runs written before the app knew). */
  idForRun(projectId: ProjectId, goal: string, url: string): string | undefined {
    const p = this.store.data.projects.find((x) => x.id === projectId);
    if (!p) return undefined;
    // Under the project's output folder (contextmachines/ by default, the --out folder when given),
    // where write() puts it.
    let want: string;
    try {
      want = relative(p.dir, savedPathFor(this.testsDir(p), goal, url)).split(sep).join("/");
    } catch {
      return undefined;
    }
    const own = this.store.data.tests.find((t) => t.projectId === projectId && (t.file === want || (t.goal === goal && !t.file)));
    if (own) return own.id;
    return existsSync(join(p.dir, want)) && !this.hidden().has(`${projectId}:${want}`) ? stableId("tst", `${projectId}:${want}`) : undefined;
  }

  list(projectId: ProjectId): TestDef[] {
    const runs = this.history.index(projectId).runs;
    return this.all(projectId).map((t) => this.view(t, runs));
  }

  get(id: string): { test: TestDef; runs: RunSummary[] } {
    const t = this.find(id);
    const runs = this.history.index(t.projectId).runs.filter((r) => r.testId === t.id).slice(0, 10);
    return { test: this.view(t, runs), runs };
  }

  /** Saved actions for a test's steps, by step id: for the runner only, never sent to the page. */
  actionsOf(id: string): Record<string, unknown[]> {
    return { ...(this.find(id).actions ?? {}) };
  }

  /**
   * The SavedTest file for a test (relative to the project dir), written now from its enabled steps.
   * `planRules`: the planning rules its steps just passed under (takePlan); else the file's own number is
   * kept only while its steps are exactly as they were (a card edited, added or removed since clears it).
   */
  private write(p: Project, t: StoredTest, planRules?: number, notes?: string): string {
    // An environment removed from the project since: the test falls back to the default one, never an error on every save.
    const env = t.envId && p.envs.some((e) => e.id === t.envId) ? this.store.envFor(p.id, t.envId) : this.store.envFor(p.id);
    // A card marked judged keeps that in the file (as runPlan runs it): a judged check on its own words.
    const steps: SavedStep[] = t.steps.filter((s) => s.enabled).map((s) => ({ title: s.title, intent: s.intent, check: s.checkMode === "judged" && s.check.kind !== "judged" ? { kind: "judged" as const, claim: s.intent.trim().slice(0, MAX_CLAIM) } : s.check, ...(t.actions?.[s.id] ? { actions: t.actions[s.id] as CachedAction[] } : {}) }));
    const login = t.steps.find((s) => s.enabled && s.kind === "login" && s.accountLabel);
    let path = t.file ? join(p.dir, t.file) : savedPathFor(this.testsDir(p), t.goal, env.url);
    if (!t.file) {
      // Never over another test's file: the same goal twice gets "-2". (Numbered on the file name itself:
      // a long goal's slug is cut at 40 characters, so "goal 2" would give the same name, for ever.)
      const taken = new Set(this.store.data.tests.map((x) => x.file));
      const first = path;
      for (let k = 2; existsSync(path) || taken.has(relative(p.dir, path).split(sep).join("/")); k++) path = first.replace(/\.json$/, `-${k}.json`);
    }
    // The app the file was saved for (its identity) is kept when the file is written again.
    let was: ReturnType<typeof readSaved> | undefined;
    try { was = existsSync(path) ? readSaved(path) : undefined; } catch { was = undefined; }
    const identity = was?.identity;
    const kept = planRules ?? (was?.planRules && sameSteps(was.steps, steps) ? was.planRules : undefined);
    // The digest of the notes about the site its steps passed with (run.ts replanOf): kept while the steps are as they were.
    const keptNotes = notes ?? (was?.notes && sameSteps(was.steps, steps) ? was.notes : undefined);
    writeSaved(path, { rules: KNOWN_RULES, ...(kept ? { planRules: kept } : {}), ...(keptNotes ? { notes: keptNotes } : {}), goal: t.goal, url: env.url, steps, ...(steps.some((s) => !s.actions) ? { draft: true as const } : {}), ...(login?.accountLabel ?? t.account ? { as: (login?.accountLabel ?? t.account)! } : {}), ...(identity ? { identity } : {}) });
    return relative(p.dir, path).split(sep).join("/");
  }

  create(projectId: ProjectId, body: unknown, now = new Date()): TestDef {
    const p = this.store.project(projectId);
    if (!isObj(body)) throw bad("Send the test.");
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (!goal) throw bad("A test needs a goal: what it checks, in a sentence.");
    const steps = checkSteps(body.steps);
    const envId = body.envId === undefined ? undefined : this.store.envFor(projectId, body.envId).id;
    const groupIds = this.checkGroups(projectId, body.groupIds);
    const account = checkAccount(body.account);
    const t: StoredTest = {
      id: newId("tst"),
      projectId,
      name: typeof body.name === "string" && body.name.trim() ? clip(body.name, 80) : clip(goal, 80),
      goal: goal.slice(0, 1000),
      steps,
      ...(account ? { account } : {}),
      ...(envId ? { envId } : {}),
      ...(groupIds ? { groupIds } : {}),
      origin: ORIGINS.includes(body.origin as (typeof ORIGINS)[number]) ? (body.origin as TestDef["origin"]) : "describe",
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      actions: {},
    };
    t.file = this.write(p, t);
    this.store.data.tests.push(t);
    this.store.save();
    return this.view(t);
  }

  update(id: string, body: unknown, now = new Date()): TestDef {
    const was = this.find(id);
    if (!isObj(body)) throw bad("Send the fields to change.");
    const p = this.store.project(was.projectId);
    const t: StoredTest = { ...was, actions: { ...(was.actions ?? {}) } };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw bad("A test needs a name.");
      t.name = clip(body.name, 80);
    }
    if (body.goal !== undefined) {
      if (typeof body.goal !== "string" || !body.goal.trim()) throw bad("A test needs a goal.");
      t.goal = body.goal.trim().slice(0, 1000);
    }
    if (body.steps !== undefined) {
      const next = checkSteps(body.steps);
      const before = new Map(was.steps.map((s) => [s.id, s]));
      const actions: Record<string, unknown[]> = {};
      t.steps = next.map((s) => {
        const old = before.get(s.id);
        // C5: the words or the check changed (or the step is new): its saved clicks no longer apply.
        if (!old || !same(old, s)) {
          return old ? { ...s, edited: true as const } : s;
        }
        if (was.actions?.[s.id] && !s.edited) actions[s.id] = was.actions[s.id]!;
        return s;
      });
      t.actions = actions;
    }
    if (body.account !== undefined) {
      const account = checkAccount(body.account);
      if (account) t.account = account;
      else delete t.account;
    }
    if (body.envId !== undefined) {
      if (body.envId === null || body.envId === "") delete t.envId;
      else t.envId = this.store.envFor(p.id, body.envId).id;
    } else if (t.envId && !p.envs.some((e) => e.id === t.envId)) delete t.envId;
    if (body.groupIds !== undefined) {
      const g = this.checkGroups(p.id, body.groupIds);
      if (g) t.groupIds = g;
      else delete t.groupIds;
    }
    t.updatedAt = nowIso(now);
    t.file = this.write(p, t);
    const at = this.store.data.tests.findIndex((x) => x.id === id);
    if (at >= 0) this.store.data.tests[at] = t;
    else this.store.data.tests.push(t);
    this.store.save();
    return this.view(t);
  }

  /** After a run passes and the engine saves new actions, the app takes them back in (by step order). */
  takeActions(id: string, actionsByStep: Record<string, unknown[]>): void {
    const t = this.store.data.tests.find((x) => x.id === id);
    if (!t) return;
    t.actions = { ...(t.actions ?? {}), ...actionsByStep };
    t.steps = t.steps.map((s) => (actionsByStep[s.id] ? (({ edited: _e, ...rest }) => rest)(s) : s));
    this.store.save();
  }

  /**
   * After a test was planned again from its goal (its saved clicks were recorded under older rules and
   * couldn't do what its cards said) and passed: its cards become the new plan's steps, each with the
   * clicks that passed, so the next run replays them with no AI. Its name, groups and environment stay,
   * and so does the account it signs in as: its own, else its old Login card's (the app signs in before
   * step 1, so the new plan has no sign-in step). An account picked for this one run only is never kept:
   * the next run picks its account as this one did. `planRules`: the rules the new steps passed under.
   */
  takePlan(id: string, steps: readonly SavedStep[], planRules?: number, now = new Date(), notes?: string): void {
    const t = this.store.data.tests.find((x) => x.id === id);
    if (!t || !steps.length || steps.some((s) => !s.actions)) return;
    const p = this.store.project(t.projectId);
    const login = t.steps.find((s) => s.enabled && s.kind === "login" && s.accountLabel)?.accountLabel;
    const account = t.account ?? login;
    const cards = cardsFromSaved({ steps: [...steps] });
    const actions: Record<string, unknown[]> = {};
    for (const [k, c] of cards.entries()) actions[c.id] = steps[k]!.actions!;
    t.steps = cards;
    t.actions = actions;
    if (account && LABEL.test(account)) t.account = account;
    t.updatedAt = nowIso(now);
    t.file = this.write(p, t, planRules, notes);
    this.store.save();
  }

  delete(id: string): void {
    const t = this.find(id);
    this.store.data.tests = this.store.data.tests.filter((x) => x.id !== id);
    if (t.file) {
      this.store.data.hiddenFiles = [...new Set([...(this.store.data.hiddenFiles ?? []), `${t.projectId}:${t.file}`])];
    }
    for (const g of this.store.data.groups) g.testIds = g.testIds.filter((x) => x !== id);
    this.store.save();
  }

  private checkGroups(projectId: ProjectId, raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw bad("groupIds is a list.");
    const known = new Set(this.store.data.groups.filter((g) => g.projectId === projectId).map((g) => g.id));
    const ids = raw.filter((g): g is string => typeof g === "string" && known.has(g));
    return ids.length ? ids : undefined;
  }
}
