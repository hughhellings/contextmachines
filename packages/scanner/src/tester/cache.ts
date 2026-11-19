/**
 * A test that passed, saved so the next run replays it with no AI: the goal, the address, the steps
 * and, for each step, the actions that were done, each element by role and name. Never a snapshot, a
 * prompt, a cookie or a typed secret: a --var value stays its {name}.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { placeholderNames } from "./placeholders.ts";
import { ACTION_TYPES, BARE_CHECKS, CHECK_KINDS, type CachedAction, type Check, type PlannedStep, type Target } from "./types.ts";

/** The newest matching rules this code replays by (act.ts says what they are). */
export const KNOWN_RULES = 2;

/**
 * The planning rules a saved test passed under: 1 is intent coverage, the check measured before the
 * save, and the goal judge (a fresh or healed run that passed them all). A saved test with this number
 * was not recorded under older rules, so it is never planned again for being stale (run.ts staleSteps).
 */
export const PLAN_RULES = 1;

/** An app's name (contextmachines.config.json "identity"): its tests are one app's on any address (a preview). */
export const IDENTITY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface SavedStep extends PlannedStep {
  /** What was done, for replay. Only a draft's step may have none yet: its first run asks the AI to do it. */
  actions?: CachedAction[];
  /** A check only (an Assert card): nothing is done, its check is measured where the step before left the page. */
  assert?: true;
}

export interface SavedTest {
  version: 1;
  /**
   * The matching rules its targets were saved under (act.ts RULES): 2 adds the counts, test ids,
   * addresses and words. None: saved before they had a number, and replayed exactly as then. One
   * higher than this code knows is refused, never half-used.
   */
  rules?: number;
  /** The planning rules it passed under (PLAN_RULES). None: saved before they had a number. */
  planRules?: number;
  goal: string;
  url: string;
  steps: SavedStep[];
  savedAt: string;
  /**
   * A starter test that hasn't passed yet (learn writes these, from the journeys it walked to their
   * end): run like any test, and its first full pass saves it without this.
   */
  draft?: true;
  /** A visitor's test (a task suggested for the site): replayed signed out, a consent wall answered "no" first. */
  visitor?: true;
  /** The test account it was saved with (--as admin): replayed signed in as that account, never another. */
  as?: string;
  /** The app it was saved for (the project's "identity"): replayed, healed and saved on any address of that app. */
  identity?: string;
  /**
   * A SHA-256 of the person's notes about the site it passed with (notes.ts), never the notes: notes that
   * changed since plan it again from its goal (run.ts replanOf). None: saved with no notes.
   */
  notes?: string;
}

/** A short file name from the goal, cut at a word: "open the docs and search for locator" → "open-the-docs-and-search-for-locator". */
export function slugOf(goal: string): string {
  const words = goal.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").split(/[\s_-]+/).filter(Boolean);
  let slug = "";
  for (const word of words) {
    const longer = slug ? `${slug}-${word}` : word;
    if (longer.length > 40 && slug) break;
    slug = longer.slice(0, 60);
  }
  return slug || "test";
}

/** A host as a file name: "localhost:3000" → "localhost-3000". The tests' folders and the saved sessions use it. */
export const hostSlug = (url: string) => new URL(url).host.replace(/[^\w.-]+/g, "-");

/** The folder a test is filed under: the app's name when the project has one, else its host. */
export const folderFor = (url: string, identity?: string) => (identity && IDENTITY.test(identity) ? identity : hostSlug(url));

/** Where a goal's saved test lives: one folder per app (or per host), so staging and production without a name are two tests. */
export function savedPathFor(testsDir: string, goal: string, url: string, identity?: string): string {
  return join(testsDir, folderFor(url, identity), `${slugOf(goal)}.json`);
}

/** Every saved test's file under `testsDir` (its own files and each host's folder), in a steady order. */
export function listSaved(testsDir: string): string[] {
  return findSaved(testsDir, "");
}

/** Whether there are saved tests for this address: its app's folder (or its host's) under `testsDir`. */
export function savedForHost(testsDir: string, url: string, identity?: string): boolean {
  const folder = folderFor(url, identity);
  return listSaved(testsDir).some((f) => basename(dirname(f)) === folder);
}

/** Whether a saved test run at `url` is at home: its own origin, or any address of the same named app. */
export function atHome(saved: Pick<SavedTest, "url" | "identity">, url: string, identity?: string): boolean {
  if (new URL(url).origin === new URL(saved.url).origin) return true;
  return Boolean(identity) && saved.identity === identity;
}

/** The {name}s a saved test types or checks: each needs a --var (or CM_VAR_<NAME>) to replay. */
export function varsUsed(test: SavedTest): string[] {
  return placeholderNames(JSON.stringify(test.steps));
}

/** Saved tests whose file name starts with `name` ("open-the-docs"), in any host's folder. */
export function findSaved(testsDir: string, name: string): string[] {
  const found: string[] = [];
  const look = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const path = join(dir, entry);
      if (entry.endsWith(".json") && entry.startsWith(name)) found.push(path);
      else if (depth === 0 && statSync(path, { throwIfNoEntry: false })?.isDirectory()) look(path, 1);
    }
  };
  look(testsDir, 0);
  return found;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A check as said by anyone (the AI, a saved file), or nothing when it isn't one of the five. */
export function checkFrom(v: unknown): Check | undefined {
  if (!isObj(v)) return undefined;
  const kind = str(v.kind);
  if (!kind || !(CHECK_KINDS as readonly string[]).includes(kind)) return undefined;
  if ((BARE_CHECKS as readonly string[]).includes(kind)) return { kind } as Check;
  if (kind === "signed_in") {
    const text = str(v.text)?.trim();
    const url = str(v.url)?.trim();
    const left = str(v.left)?.trim();
    return { kind, ...(text ? { text } : {}), ...(url ? { url } : {}), ...(left ? { left } : {}) };
  }
  // Judged by an AI, never turned into a measured one: a claim of 1 to 200 characters.
  if (kind === "judged") {
    const claim = str(v.claim)?.replace(/\s+/g, " ").trim();
    return claim && claim.length <= 200 ? { kind, claim } : undefined;
  }
  if (kind === "element_visible") {
    const role = str(v.role)?.trim();
    return role ? { kind, role, name: str(v.name)?.trim() ?? "" } : undefined;
  }
  const text = str(v.text)?.trim();
  return text ? { kind: kind as "text_visible" | "url_contains" | "title_contains" | "download_contains", text } : undefined;
}

/** A short string, or nothing: a field longer than `max` (or not a string) makes the target not one. */
const short = (v: unknown, max: number): string | undefined | false => (v === undefined ? undefined : typeof v === "string" && v.length <= max ? v : false);

/** A saved element, checked field by field: the optional fields must be what they say, and short. */
function targetFrom(t: unknown): Target | undefined {
  if (!isObj(t) || typeof t.role !== "string" || typeof t.name !== "string" || !Number.isInteger(t.nth) || (t.nth as number) < 0 || t.role.length > 40) return undefined;
  const out: Target = { role: t.role, name: t.name, nth: t.nth as number };
  if (t.within !== undefined) {
    if (!isObj(t.within) || typeof t.within.role !== "string" || typeof t.within.name !== "string" || t.within.role.length > 40 || t.within.name.length > 200) return undefined;
    out.within = { role: t.within.role, name: t.within.name };
  }
  for (const [key, max] of [["href", 500], ["text", 80], ["testid", 100], ["near", 80]] as const) {
    const value = short(t[key], max);
    if (value === false) return undefined;
    if (value !== undefined) out[key] = value;
  }
  if (t.of !== undefined) {
    if (!Number.isInteger(t.of) || (t.of as number) < 0) return undefined;
    out.of = t.of as number;
  }
  if (t.frame !== undefined) {
    if (!isObj(t.frame) || typeof t.frame.path !== "string" || !t.frame.path.startsWith("/") || t.frame.path.length > 300 || !Number.isInteger(t.frame.nth) || (t.frame.nth as number) < 0 || (t.frame.nth as number) > 50) return undefined;
    out.frame = { path: t.frame.path, nth: t.frame.nth as number };
  }
  return out;
}

function actionFrom(v: unknown): CachedAction | undefined {
  if (!isObj(v) || !(ACTION_TYPES as readonly string[]).includes(String(v.type))) return undefined;
  const target = targetFrom(v.target);
  switch (v.type) {
    case "click":
    case "hover":
      return target ? { type: v.type, target } : undefined;
    case "fill":
    case "select":
      return target && typeof v.value === "string" ? { type: v.type, target, value: v.value, ...(v.madeUp === true ? { madeUp: true as const } : {}) } : undefined;
    case "type": {
      if (typeof v.value !== "string") return undefined;
      const into = v.into === undefined ? undefined : targetFrom(v.into);
      if (v.into !== undefined && !into) return undefined;
      return { type: "type", value: v.value, ...(into ? { into } : {}), ...(v.madeUp === true ? { madeUp: true as const } : {}) };
    }
    case "press":
      return typeof v.key === "string" ? { type: "press", key: v.key } : undefined;
    case "scroll":
      if (v.target !== undefined && !target) return undefined;
      return { type: "scroll", direction: v.direction === "up" ? "up" : "down", ...(target ? { target } : {}) };
    case "back":
      return { type: "back" };
    case "dblclick":
    case "rightclick":
    case "check":
    case "uncheck":
      return target ? { type: v.type, target } : undefined;
    case "scroll_to":
      if (v.target !== undefined && !target) return undefined;
      return typeof v.text === "string" && v.text.length <= 200 ? { type: "scroll_to", text: v.text, ...(target ? { target } : {}) } : undefined;
    // W4: the widget verbs, each with its element and its value (a sample kind or a path, a number, "x,y").
    case "upload":
    case "drag_at":
    case "slide":
      return target && typeof v.value === "string" && v.value.length <= 500 ? { type: v.type, target, value: v.value } : undefined;
    case "drag": {
      const to = v.to === undefined ? undefined : targetFrom(v.to);
      if ((v.target !== undefined && !target) || (v.to !== undefined && !to)) return undefined;
      const from = typeof v.from === "string" && v.from.length <= 200 ? v.from : undefined;
      const onto = typeof v.onto === "string" && v.onto.length <= 200 ? v.onto : undefined;
      return (target || from) && (to || onto) ? { type: "drag", ...(target ? { target } : { from: from! }), ...(to ? { to } : { onto: onto! }) } : undefined;
    }
    case "download":
      return target ? { type: "download", target } : undefined;
    case "switch_tab":
      return typeof v.value === "string" && /^\d{1,2}$/.test(v.value) ? { type: "switch_tab", value: v.value } : undefined;
    case "click_at":
      if (!(typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y) && typeof v.name === "string" && v.name.length <= 200)) return undefined;
      return { type: "click_at", x: v.x, y: v.y, name: v.name, ...(typeof v.what === "string" && v.what.length <= 200 ? { what: v.what } : {}), ...(typeof v.vw === "number" && typeof v.vh === "number" && Number.isFinite(v.vw) && Number.isFinite(v.vh) ? { vw: v.vw, vh: v.vh } : {}) };
    case "navigate":
      return typeof v.url === "string" ? { type: "navigate", url: v.url } : undefined;
    case "wait":
      return typeof v.ms === "number" ? { type: "wait", ms: Math.min(5000, Math.max(0, v.ms)) } : undefined;
    default:
      return undefined;
  }
}

/** A saved test read back, checked field by field: anything that isn't one is an error, never half-used. */
export function readSaved(path: string): SavedTest {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} couldn't be read as a saved test: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
  if (!isObj(data) || data.version !== 1 || typeof data.goal !== "string" || typeof data.url !== "string" || !Array.isArray(data.steps)) throw new Error(`${path} isn't a saved test`);
  if (data.rules !== undefined && (!Number.isInteger(data.rules) || (data.rules as number) < 1)) throw new Error(`${path} isn't a saved test: its rules aren't a number`);
  if (typeof data.rules === "number" && data.rules > KNOWN_RULES) throw new Error(`${path} was made by a newer contextmachines (matching rules ${data.rules}): update it to run this test`);
  const draft = data.draft === true;
  const steps: SavedStep[] = [];
  for (const s of data.steps) {
    const check = isObj(s) ? checkFrom(s.check) : undefined;
    // A step with nothing to replay is only a draft's: anywhere else it would pass on its check alone.
    const recorded = isObj(s) && Array.isArray(s.actions);
    if (!isObj(s) || typeof s.title !== "string" || typeof s.intent !== "string" || !check || (!recorded && !draft)) throw new Error(`${path} has a step that isn't one`);
    if (!recorded) {
      steps.push({ title: s.title, intent: s.intent, check });
      continue;
    }
    const actions = (s.actions as unknown[]).map(actionFrom);
    if (actions.some((a) => !a)) throw new Error(`${path} has an action that isn't one`);
    steps.push({ title: s.title, intent: s.intent, check, actions: actions as CachedAction[], ...(s.assert === true && !actions.length ? { assert: true as const } : {}) });
  }
  if (!steps.length) throw new Error(`${path} has no steps`);
  // A test's last step must measure something, a draft's or not: a test that checks nothing would
  // always pass. A step that measures nothing must be followed by one that does, and must do something.
  if (steps.at(-1)!.check.kind === "none") throw new Error(`${path} is a ${draft ? "draft" : "test"} whose last step checks nothing`);
  for (const [i, s] of steps.entries()) {
    if (s.check.kind !== "none") continue;
    if (steps[i + 1]!.check.kind === "none") throw new Error(`${path}: step ${i + 1} checks nothing, so step ${i + 2} must check something`);
    if (s.actions && !s.actions.length) throw new Error(`${path}: step ${i + 1} does nothing and checks nothing`);
  }
  return { version: 1, ...(typeof data.rules === "number" ? { rules: data.rules } : {}), ...(Number.isInteger(data.planRules) && (data.planRules as number) >= 1 ? { planRules: data.planRules as number } : {}), goal: data.goal, url: data.url, steps, savedAt: typeof data.savedAt === "string" ? data.savedAt : "", ...(draft ? { draft: true as const } : {}), ...(data.visitor === true ? { visitor: true as const } : {}), ...(typeof data.as === "string" && /^[a-z0-9_-]{1,32}$/.test(data.as) ? { as: data.as } : {}), ...(typeof data.identity === "string" && IDENTITY.test(data.identity) ? { identity: data.identity } : {}), ...(typeof data.notes === "string" && /^[0-9a-f]{64}$/.test(data.notes) ? { notes: data.notes } : {}) };
}

/** A query parameter's name that reads like a secret (a bypass token, a key, a signature), as the CLI's redact() reads it. */
const SECRET_PARAM = /(^|[-_.])(access|api|apikey|auth|bypass|code|credential|credentials|jwt|key|nonce|otp|pass|passwd|password|pwd|secret|session|sessionid|sid|sig|signature|state|ticket|token)s?($|[-_.])|token|secret|password|apikey|signature|credential|oobcode|^__clerk/i;
/** A value that reads like one whatever its name: a long run of mixed letters and digits. */
const SECRET_VALUE = /^(?=.*\d)(?=.*[a-z])[\w~+/=%.-]{20,}$/i;

/**
 * An address as it is saved, without what reads like a secret in it (a deployment's bypass token, a
 * signed link's signature) or a user name and password: saved tests are meant to be committed. A
 * test that needs one gets it again from --url.
 */
export function withoutSecrets(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.username = "";
  u.password = "";
  for (const [name, value] of [...u.searchParams]) if (SECRET_PARAM.test(name) || SECRET_VALUE.test(value)) u.searchParams.delete(name);
  // A fragment that carries a token (a magic link's #access_token=…, an OAuth implicit grant) is
  // dropped whole; a page's own anchor or hash route (#pricing, #/settings) is kept.
  if (u.hash && secretFragment(u.hash.slice(1))) u.hash = "";
  return u.href;
}

/** A fragment that reads like it carries a secret: token-named fields, or a long random value. */
function secretFragment(fragment: string): boolean {
  let text = fragment;
  try {
    text = decodeURIComponent(fragment);
  } catch {
    // not encoded as it says: read as it is
  }
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  if (query.includes("=")) for (const [name, value] of new URLSearchParams(query)) if (SECRET_PARAM.test(name) || SECRET_VALUE.test(value)) return true;
  return SECRET_VALUE.test(text) || /^eyJ/.test(text);
}

/** Whether a saved test is there to read. */
export const hasSaved = (path: string) => existsSync(path);

/**
 * Saves a test. `mask` takes out any --var value that found its way in (a value typed as itself).
 * Only a draft passed as one is written as one: a run that passed saves a plain test.
 */
export function writeSaved(path: string, test: Omit<SavedTest, "version" | "savedAt">, mask: (s: string) => string = (s) => s): void {
  mkdirSync(dirname(path), { recursive: true });
  const saved: SavedTest = { version: 1, ...(test.rules ? { rules: test.rules } : {}), ...(test.planRules ? { planRules: test.planRules } : {}), goal: test.goal, url: withoutSecrets(test.url), ...(test.draft ? { draft: true as const } : {}), ...(test.visitor ? { visitor: true as const } : {}), ...(test.as ? { as: test.as } : {}), ...(test.identity && IDENTITY.test(test.identity) ? { identity: test.identity } : {}), ...(test.notes && /^[0-9a-f]{64}$/.test(test.notes) ? { notes: test.notes } : {}), steps: test.steps, savedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(saved, (_key, value: unknown) => (typeof value === "string" ? mask(value) : value), 2)}\n`);
}
