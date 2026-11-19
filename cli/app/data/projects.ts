/**
 * A1: the app's own store, one owner-only JSON file (projects.json) in the app folder: projects with
 * their environments, agent instructions and default account label, plus tests, groups, schedules and
 * settings. Never a secret: an account is its label, an address has no user:pass@ and no token.
 *
 * It mirrors apps/cloud's Store (one file, written whole, 0600, git-ignored folder) without editing
 * it; `toCloudProject` gives the cloud's Project shape so its queue's argsFor still applies.
 */
import { join, resolve } from "node:path";
/** The cloud queue's Project shape (apps/cloud's store.ts), kept here so the published CLI doesn't reach the hosted code. */
export interface CloudProject {
  id: string;
  name: string;
  url: string;
  dir: string;
  ai: string;
  goal?: string;
  account?: string;
  minutes?: number;
  maxTokens?: number;
  createdAt: string;
}
import { withoutSecrets } from "../../../packages/scanner/src/tester/cache.ts";
import type { AppSchedule, AppSettings, EnvKind, Environment, Group, Project, ProjectId, TestDef } from "../contracts.ts";
import { bad, DataError, isObj, newId, notFound, nowIso, ownerDir, readJson, writeJson } from "./util.ts";
import { readContextFile, writeContextFile } from "../../knowledge.ts";

export const INSTRUCTIONS_MAX = 4000;
export const STEPS_MAX = 30;
export const AIS = ["claude-code", "codex", "none"] as const;
export const LABEL = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_SETTINGS: AppSettings = { notifyOnFail: true, confirmProduction: true };

/** A test as stored: the contract's TestDef plus each step's saved actions, which never go to the page. */
export type StoredTest = Omit<TestDef, "last" | "passRate"> & { actions?: Record<string, unknown[]> };

export interface AppData {
  version: 1;
  projects: Project[];
  tests: StoredTest[];
  groups: Group[];
  schedules: AppSchedule[];
  settings: AppSettings;
  /** Saved test files the person deleted in the app ("<projectId>:<file>"); the files stay on disk. */
  hiddenFiles?: string[];
}

/** Whether a host is marked the person's own (D12). The integrator passes accounts.ts isMine. */
export type IsOwned = (outDir: string, host: string) => boolean;
/** Whether accounts may sign in on a host: owned, or the person said it's their own account (accounts.ts signInAllowed). */
export type IsSignInOk = (outDir: string, host: string) => boolean;

/** The project's output folder, as the CLI and the cloud use it: <dir>/contextmachines. */
export const outDirOf = (p: Pick<Project, "dir">) => OUT_DIRS.get(resolve(p.dir)) ?? join(p.dir, "contextmachines");

/**
 * A folder whose runs go somewhere else (`contextmachines ui --out <dir>`): the server tells the app,
 * so history, issues and the ownership check read the folder the runs are written to.
 */
export const OUT_DIRS = new Map<string, string>();

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$|\.(localhost|test)$/i;
const STAGING_HOST = /(^|[.-])(staging|stage|preview|dev|test|qa|sandbox|uat)([.-]|$)/i;

/** A guess at an address's kind; the person can change it. */
export function kindOf(url: string): EnvKind {
  const host = new URL(url).hostname;
  if (LOCAL_HOST.test(host)) return "local";
  return STAGING_HOST.test(host) ? "staging" : "production";
}

/** An environment address checked: http(s), and no secret in it (C3: localhost and 127.0.0.1 are fine). */
export function checkUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw bad("Give the site's address, like https://your-site.com or http://localhost:3000.");
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${/^(localhost|127\.|\[::1\])/i.test(text) ? "http" : "https"}://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw bad(`"${raw.slice(0, 80)}" isn't a web address.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("Only http and https addresses can be tested.");
  if (u.username || u.password) throw bad("Take the user name and password out of the address: store them as a test account (npx contextmachines accounts) instead.");
  if (withoutSecrets(u.href) !== u.href) throw bad("The address carries what looks like a token or key: set it as site access (npx contextmachines accounts site) instead, so it is never saved or shown.");
  return u.href;
}

const KINDS: EnvKind[] = ["local", "staging", "production"];
const NAMES: Record<EnvKind, string> = { local: "Local", staging: "Staging", production: "Production" };

export class AppStore {
  readonly dir: string;
  readonly file: string;
  data: AppData;
  private readonly isOwned: IsOwned;
  private readonly isSignInOk: IsSignInOk;

  constructor(dir: string, o: { isOwned?: IsOwned; isSignInOk?: IsSignInOk } = {}) {
    this.dir = dir;
    this.file = join(dir, "projects.json");
    this.isOwned = o.isOwned ?? (() => false);
    this.isSignInOk = o.isSignInOk ?? ((out, h) => this.isOwned(out, h));
    ownerDir(dir, true);
    const read = readJson<Partial<AppData>>(this.file);
    this.data = {
      version: 1,
      projects: Array.isArray(read?.projects) ? read.projects : [],
      tests: Array.isArray(read?.tests) ? read.tests : [],
      groups: Array.isArray(read?.groups) ? read.groups : [],
      schedules: Array.isArray(read?.schedules) ? read.schedules : [],
      settings: { ...DEFAULT_SETTINGS, ...(isObj(read?.settings) ? read.settings : {}) },
      ...(Array.isArray(read?.hiddenFiles) ? { hiddenFiles: read.hiddenFiles.filter((f): f is string => typeof f === "string") } : {}),
    };
    if (!read) this.save();
  }

  save(): void {
    writeJson(this.file, this.data);
  }

  /** A project as the page sees it: each environment's ownership read now, never trusted from the file. */
  private view(p: Project): Project {
    const out = outDirOf(p);
    // What the tester should know about this site lives in the project's own folder (context.md), never in projects.json.
    const context = readContextFile(out);
    return { ...p, ...(context ? { context } : {}), envs: p.envs.map((e) => ({ ...e, owned: safeOwned(this.isOwned, out, e.url), signInOk: safeOwned(this.isSignInOk, out, e.url) })) };
  }

  projects(): Project[] {
    return this.data.projects.map((p) => this.view(p));
  }

  project(id: ProjectId): Project {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw notFound("project");
    return this.view(p);
  }

  createProject(input: { url: unknown; name?: unknown; kind?: unknown; dir: string; ai?: string }, now = new Date()): Project {
    const url = checkUrl(input.url);
    const kind = KINDS.includes(input.kind as EnvKind) ? (input.kind as EnvKind) : kindOf(url);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : new URL(url).host;
    const env: Environment = { id: newId("env"), name: NAMES[kind], url, kind, owned: false, signInOk: false, default: true };
    const p: Project = { id: newId("prj"), name, url, envs: [env], ai: AIS.includes(input.ai as (typeof AIS)[number]) ? input.ai! : "none", dir: input.dir, createdAt: nowIso(now), updatedAt: nowIso(now) };
    this.data.projects.push(p);
    this.save();
    return this.view(p);
  }

  updateProject(id: ProjectId, patch: unknown, now = new Date()): Project {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw notFound("project");
    if (!isObj(patch)) throw bad("Send the fields to change.");
    const next: Project = { ...p };
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) throw bad("A project needs a name.");
      next.name = patch.name.trim().slice(0, 80);
    }
    if (patch.instructions !== undefined) {
      if (typeof patch.instructions !== "string") throw bad("Instructions are text.");
      if (patch.instructions.length > INSTRUCTIONS_MAX) throw bad(`Instructions can be at most ${INSTRUCTIONS_MAX} characters (these are ${patch.instructions.length}).`);
      if (patch.instructions.trim()) next.instructions = patch.instructions;
      else delete next.instructions;
    }
    if (patch.context !== undefined && typeof patch.context !== "string") throw bad("What the tester should know about this site is text.");
    if (patch.ai !== undefined) {
      if (!AIS.includes(patch.ai as (typeof AIS)[number])) throw bad(`The AI is one of ${AIS.join(", ")}.`);
      next.ai = patch.ai as string;
    }
    if (patch.defaultAccount !== undefined) {
      if (patch.defaultAccount === null || patch.defaultAccount === "") delete next.defaultAccount;
      else if (typeof patch.defaultAccount !== "string" || !LABEL.test(patch.defaultAccount)) throw bad("An account is its label (a-z, 0-9, - and _), never a password or email.");
      else next.defaultAccount = patch.defaultAccount;
    }
    if (patch.envs !== undefined) {
      next.envs = checkEnvs(patch.envs);
      next.url = next.envs.find((e) => e.default)!.url;
    }
    if (typeof patch.context === "string") {
      // Written to <project>/contextmachines/context.md, once everything else checked out (refused, never cut:
      // too long, or a password, key or token). An empty text removes the file.
      try {
        writeContextFile(outDirOf(p), patch.context);
      } catch (error) {
        throw bad(error instanceof Error ? error.message : String(error));
      }
    }
    next.updatedAt = nowIso(now);
    Object.assign(p, next);
    if (patch.instructions !== undefined && next.instructions === undefined) delete p.instructions;
    if (patch.defaultAccount !== undefined && next.defaultAccount === undefined) delete p.defaultAccount;
    this.save();
    return this.view(p);
  }

  /** Removes the project and what the app kept for it; its folder (saved tests, runs) stays on disk. */
  deleteProject(id: ProjectId): void {
    if (!this.data.projects.some((p) => p.id === id)) throw notFound("project");
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.data.tests = this.data.tests.filter((t) => t.projectId !== id);
    this.data.groups = this.data.groups.filter((g) => g.projectId !== id);
    this.data.schedules = this.data.schedules.filter((s) => s.projectId !== id);
    this.save();
  }

  /** The environment a run uses: the one asked for, or the default. Never one outside the project. */
  envFor(projectId: ProjectId, envId?: unknown): Environment {
    const p = this.project(projectId);
    if (envId === undefined || envId === null || envId === "") return p.envs.find((e) => e.default) ?? p.envs[0]!;
    const e = p.envs.find((x) => x.id === envId);
    if (!e) throw bad("That environment isn't one of this project's.");
    return e;
  }

  /** The project an address belongs to: an environment with the same origin. */
  projectsForOrigin(url: string): { project: Project; env: Environment }[] {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return [];
    }
    const out: { project: Project; env: Environment }[] = [];
    for (const p of this.projects()) {
      const env = p.envs.find((e) => new URL(e.url).origin === origin);
      if (env) out.push({ project: p, env });
    }
    return out;
  }

  settings(): AppSettings {
    return { ...this.data.settings };
  }

  updateSettings(patch: unknown): AppSettings {
    if (!isObj(patch)) throw bad("Send the settings to change.");
    for (const k of ["notifyOnFail", "confirmProduction"] as const) {
      if (patch[k] === undefined) continue;
      if (typeof patch[k] !== "boolean") throw bad(`${k} is true or false.`);
      this.data.settings[k] = patch[k];
    }
    this.save();
    return this.settings();
  }

  // Groups

  groups(projectId: ProjectId): Group[] {
    this.project(projectId);
    return this.data.groups.filter((g) => g.projectId === projectId);
  }

  saveGroup(projectId: ProjectId, input: unknown): Group {
    this.project(projectId);
    if (!isObj(input) || typeof input.name !== "string" || !input.name.trim()) throw bad("A group needs a name.");
    const ids = Array.isArray(input.testIds) ? input.testIds.filter((t): t is string => typeof t === "string") : [];
    const known = new Set(this.data.tests.filter((t) => t.projectId === projectId).map((t) => t.id));
    const testIds = ids.filter((t) => known.has(t) || t.startsWith("tst_"));
    if (typeof input.id === "string") {
      const g = this.data.groups.find((x) => x.id === input.id && x.projectId === projectId);
      if (!g) throw notFound("group");
      g.name = input.name.trim().slice(0, 80);
      g.testIds = testIds;
      this.save();
      return g;
    }
    const g: Group = { id: newId("grp"), projectId, name: input.name.trim().slice(0, 80), testIds };
    this.data.groups.push(g);
    this.save();
    return g;
  }

  deleteGroup(id: string): void {
    if (!this.data.groups.some((g) => g.id === id)) throw notFound("group");
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    for (const s of this.data.schedules) if ("group" in s.target && s.target.group === id) s.enabled = false;
    this.save();
  }
}

function safeOwned(isOwned: IsOwned | IsSignInOk, outDir: string, url: string): boolean {
  try {
    return isOwned(outDir, new URL(url).host);
  } catch {
    return false;
  }
}

/** Environments sent by the settings form, checked: at least one, each address safe, exactly one default. */
export function checkEnvs(raw: unknown): Environment[] {
  if (!Array.isArray(raw) || !raw.length) throw bad("A project needs at least one environment.");
  if (raw.length > 10) throw bad("A project has at most 10 environments.");
  const envs = raw.map((e): Environment => {
    if (!isObj(e)) throw bad("An environment has a name and an address.");
    const url = checkUrl(e.url);
    const kind = KINDS.includes(e.kind as EnvKind) ? (e.kind as EnvKind) : kindOf(url);
    const name = typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 40) : NAMES[kind];
    const id = typeof e.id === "string" && /^env_[0-9a-f]{12}$/.test(e.id) ? e.id : newId("env");
    return { id, name, url, kind, owned: false, signInOk: false, ...(e.default === true ? { default: true as const } : {}) };
  });
  const defaults = envs.filter((e) => e.default).length;
  if (defaults > 1) throw bad("Only one environment can be the default.");
  if (!defaults) envs[0]!.default = true;
  if (new Set(envs.map((e) => e.id)).size !== envs.length) throw new DataError(400, "Two environments have the same id.");
  return envs;
}

/** The apps/cloud Project for this project's default environment, so the cloud queue's argsFor applies. */
export function toCloudProject(p: Project, env?: Environment): CloudProject {
  return { id: p.id, name: p.name, url: (env ?? p.envs.find((e) => e.default) ?? p.envs[0]!).url, dir: p.dir, ai: p.ai, ...(p.defaultAccount ? { account: p.defaultAccount } : {}), createdAt: p.createdAt };
}
