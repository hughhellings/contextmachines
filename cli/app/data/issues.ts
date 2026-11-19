/**
 * A3: issues, from measured signals only: a failed step and its reason, friction the browser met, the
 * app log's console errors, page errors and 4xx/5xx responses (E1), a11y findings, and Discovery's
 * measured findings. Never from an AI's opinion, and this module imports nothing that can ask one.
 *
 * - Deduped across runs by a key: kind + route (ids normalised) + message words.
 * - Each occurrence keeps the run, the step and the video time ("Go to M:SS").
 * - Severity comes from the fixed rule table below, never from the AI: the same input, the same number.
 * - A resolved issue reopens when it comes back in a run after it was resolved. A false positive stays
 *   muted: its count goes up, its status doesn't change.
 * - A bot wall is a BLOCKED run, not an issue.
 * - The same run filed twice counts once.
 *
 * Stored in issues.json in the app folder, owner-only.
 */
import { join } from "node:path";
import { A11Y_KINDS } from "../../../packages/scanner/src/tester/a11y.ts";
import type { A11yFinding, A11yResult, AppLogEntry, Evidence, ExploreFinding, Friction, Issue, IssueId, IssueKind, IssueOccurrence, IssueStatus, ProjectId, RunSummary, Severity, TestResult } from "../contracts.ts";

type FrictionKind = Friction["kind"];
import { blockedGroupOf } from "./history.ts";
import { bad, clip, isObj, newId, notFound, nowIso, ownerDir, readJson, writeJson } from "./util.ts";

// ---------------------------------------------------------------------------------------------
// The rule table. Changing a number here is a product decision; no code path computes one otherwise.

export const SEVERITY = {
  failed_step: 4,
  page_error: 4,
  console_error: 3,
  http_5xx: 4,
  http_4xx: 2,
  /** A 4xx on a picture, font, style or script: noise more than a broken flow. */
  http_4xx_asset: 1,
  request_failed: 3,
  friction: { validation: 2, popup: 1, many_actions: 2, retry: 2, unnamed_control: 2, slow: 2 } as Record<Exclude<FrictionKind, "bot_check">, Severity>,
  a11y: { no_name: 3, img_no_alt: 2, no_lang: 2, field_no_label: 3, placeholder_only: 2, heading_order: 1, duplicate_id: 1, small_target: 1 } as Record<A11yFinding["kind"], Severity>,
  /** A Discovery finding whose evidence matches none of the above. */
  explore: 2,
} as const;

/** Newest occurrences kept per issue; `count` stays the true total. */
export const OCCURRENCES_MAX = 20;

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|css|js|map)$/i;

/** A route with its ids taken out: "/orders/8231/items/ab12cd34ef" → "/orders/:id/items/:id". No query, no hash. */
export function normRoute(url: string | undefined): string {
  if (!url) return "";
  let path = url;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  return path
    .toLowerCase()
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/.test(seg) || (/\d/.test(seg) && /^[\w-]{8,}$/.test(seg)) || seg.includes("@") ? ":id" : seg))
    .join("/")
    .replace(/\/+$/, "") || "/";
}

/** The words a message is matched on: lower case, numbers and ids out, at most 12 words. */
export function normWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s"')]+/g, (u) => normRoute(u))
    .replace(/\b[0-9a-f]{8,}\b|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, ":id")
    .replace(/\d+/g, "#")
    .replace(/[^\w:#/\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
}

export interface Signal {
  kind: IssueKind;
  key: string;
  title: string;
  severity: Severity;
  step: number;
  videoAt: number;
  evidence: Evidence;
}

const keyOf = (kind: IssueKind, route: string, words: string) => `${kind}|${route}|${words}`;

/** The page a run was on at a time in its video, from its timeline of addresses. */
function pageAt(r: Pick<TestResult, "urls" | "url" | "endUrl">, at: number): string {
  let page = r.url;
  for (const u of r.urls ?? []) if (u.t <= at) page = u.url;
  return page;
}

export function logSignal(e: AppLogEntry): Signal | undefined {
  const text = clip(e.text, 300);
  const base = { step: e.step, videoAt: e.at };
  const route = normRoute(e.url);
  if (e.kind === "http_error" && typeof e.status === "number" && e.status >= 400) {
    const method = (e.method ?? "GET").toUpperCase();
    const severity: Severity = e.status >= 500 ? SEVERITY.http_5xx : ASSET.test(route) ? SEVERITY.http_4xx_asset : SEVERITY.http_4xx;
    return { ...base, kind: "http_error", key: keyOf("http_error", `${method} ${route}`, String(e.status)), title: `${e.status} on ${method} ${route}`, severity, evidence: { source: "measured", kind: "http_error", text, ...(e.url ? { url: e.url } : {}), method, status: e.status } };
  }
  if (e.kind === "request_failed") {
    const method = (e.method ?? "GET").toUpperCase();
    return { ...base, kind: "http_error", key: keyOf("http_error", `${method} ${route}`, `failed ${normWords(text)}`), title: `Request failed: ${method} ${route}`, severity: SEVERITY.request_failed, evidence: { source: "measured", kind: "http_error", text, ...(e.url ? { url: e.url } : {}), method } };
  }
  if (e.kind === "pageerror") return { ...base, kind: "page_error", key: keyOf("page_error", route, normWords(text)), title: `Page error: ${clip(text, 90)}`, severity: SEVERITY.page_error, evidence: { source: "measured", kind: "page_error", text, ...(e.url ? { url: e.url } : {}) } };
  if (e.kind === "console" && e.level === "error") return { ...base, kind: "console_error", key: keyOf("console_error", route, normWords(text)), title: `Console error: ${clip(text, 90)}`, severity: SEVERITY.console_error, evidence: { source: "measured", kind: "console_error", text, ...(e.url ? { url: e.url } : {}) } };
  return undefined;
}

export function a11ySignal(f: A11yFinding, at: number): Signal {
  const route = normRoute(f.page);
  const about = A11Y_KINDS[f.kind];
  return { kind: "a11y", key: keyOf("a11y", route, `${f.kind} ${normWords(f.what)}`), title: `${about ? about.one[0]!.toUpperCase() + about.one.slice(1) : f.kind}: ${clip(f.what, 80)}`, severity: SEVERITY.a11y[f.kind] ?? 1, step: 0, videoAt: at, evidence: { source: "measured", kind: "a11y", text: clip(`${f.what} (${f.wcag}) on ${f.page}`, 300), a11y: f } };
}

/** Every measured signal in one run. */
export function signalsOf(input: { result: TestResult; log?: AppLogEntry[]; a11y?: A11yResult; findings?: ExploreFinding[]; cancelled?: boolean }): Signal[] {
  const r = input.result;
  const out: Signal[] = [];
  const stepAt = (n: number) => r.steps.find((s) => s.n === n)?.at ?? 0;
  // A bot wall is a BLOCKED run, never an issue: nothing it measured is filed, since the wall's own 403s,
  // challenge scripts and console lines aren't the site's bugs. A run the person stopped didn't fail its steps.
  if (r.botWall || (r.verdict === "blocked" && blockedGroupOf(r) === "bot_wall")) return [];
  if (!input.cancelled) {
    for (const s of r.steps) {
      if (s.verdict !== "failed") continue;
      const page = pageAt(r, s.at + s.ms / 1000);
      const check = s.check as { kind: string; text?: string; name?: string };
      const words = normWords(`${s.title} ${check.kind} ${check.text ?? check.name ?? ""}`);
      const text = clip(s.reason ?? `"${s.title}" failed`, 300);
      out.push({ kind: "failed_step", key: keyOf("failed_step", normRoute(page), words), title: `"${clip(s.title, 80)}" failed`, severity: SEVERITY.failed_step, step: s.n, videoAt: s.at, evidence: { source: "measured", kind: "failed_step", text, url: page, ...(s.evidence ? { expected: { expected: clip(s.evidence.expected, 300), found: clip(s.evidence.found, 300) } } : {}) } });
    }
  }
  for (const f of r.friction ?? []) {
    if (f.kind === "bot_check") continue;
    const at = stepAt(f.step);
    const page = pageAt(r, at);
    out.push({ kind: "friction", key: keyOf("friction", normRoute(page), `${f.kind} ${normWords(f.says)}`), title: clip(f.says, 100), severity: SEVERITY.friction[f.kind] ?? 1, step: f.step, videoAt: at, evidence: { source: "measured", kind: "friction", text: clip(f.says, 300), url: page, friction: f.kind } });
  }
  for (const e of input.log ?? []) {
    const s = logSignal(e);
    if (s) out.push(s);
  }
  for (const f of input.a11y?.findings ?? []) {
    const seen = (r.urls ?? []).find((u) => normRoute(u.url) === normRoute(f.page));
    out.push(a11ySignal(f, seen?.t ?? 0));
  }
  for (const f of input.findings ?? []) {
    const ev = f.evidence;
    let s: Signal | undefined;
    if (ev.kind === "http_error" || ev.kind === "console_error" || ev.kind === "page_error") {
      s = logSignal({ kind: ev.kind === "http_error" ? "http_error" : ev.kind === "page_error" ? "pageerror" : "console", level: "error", text: ev.text, step: f.step, at: f.at, ...(ev.url ? { url: ev.url } : {}), ...(ev.method ? { method: ev.method } : {}), ...(typeof ev.status === "number" ? { status: ev.status } : {}) });
    } else if (ev.kind === "a11y" && ev.a11y) {
      s = { ...a11ySignal(ev.a11y, f.at), step: f.step };
    } else if (ev.kind === "friction" && ev.friction && ev.friction !== "bot_check") {
      s = { kind: "friction", key: keyOf("friction", normRoute(ev.url), `${ev.friction} ${normWords(ev.text)}`), title: clip(ev.text, 100), severity: SEVERITY.friction[ev.friction] ?? 1, step: f.step, videoAt: f.at, evidence: { ...ev, source: "measured", text: clip(ev.text, 300) } };
    } else if (ev.kind !== "friction") {
      s = { kind: "explore", key: keyOf("explore", normRoute(ev.url), normWords(`${f.title} ${ev.text}`)), title: clip(f.title, 100), severity: SEVERITY.explore, step: f.step, videoAt: f.at, evidence: { ...ev, source: "measured", text: clip(ev.text, 300) } };
    }
    if (s) out.push(s);
  }
  // One occurrence per issue per run: the first time it was seen.
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}

// ---------------------------------------------------------------------------------------------
// The store.

type StoredIssue = Issue & { resolvedAt?: string };

interface IssuesFile {
  version: 1;
  issues: StoredIssue[];
  /** Runs already filed, per project: filing one twice counts once. */
  filed: Record<ProjectId, string[]>;
}

const STATUSES: IssueStatus[] = ["open", "resolved", "false_positive"];

export class IssueStore {
  readonly file: string;
  data: IssuesFile;
  private filedSets: Record<ProjectId, Set<string>> = {};

  constructor(dir: string) {
    ownerDir(dir, true);
    this.file = join(dir, "issues.json");
    const read = readJson<Partial<IssuesFile>>(this.file);
    this.data = { version: 1, issues: Array.isArray(read?.issues) ? read.issues : [], filed: isObj(read?.filed) ? (read.filed as Record<string, string[]>) : {} };
    if (!read) this.save();
  }

  save(): void {
    writeJson(this.file, this.data);
  }

  private view(i: StoredIssue): Issue {
    const { resolvedAt: _r, ...issue } = i;
    return issue;
  }

  list(projectId: ProjectId): { issues: Issue[]; counts: Record<IssueStatus, number> } {
    const mine = this.data.issues.filter((i) => i.projectId === projectId);
    const counts = { open: 0, resolved: 0, false_positive: 0 };
    for (const i of mine) counts[i.status]++;
    const order = { open: 0, resolved: 1, false_positive: 2 };
    const issues = [...mine].sort((a, b) => order[a.status] - order[b.status] || b.severity - a.severity || (a.lastSeen < b.lastSeen ? 1 : -1)).map((i) => this.view(i));
    return { issues, counts };
  }

  get(id: IssueId): Issue {
    const i = this.data.issues.find((x) => x.id === id);
    if (!i) throw notFound("issue");
    return this.view(i);
  }

  setStatus(id: IssueId, status: unknown, now = new Date()): Issue {
    const i = this.data.issues.find((x) => x.id === id);
    if (!i) throw notFound("issue");
    if (!STATUSES.includes(status as IssueStatus)) throw bad("The status is open, resolved or false_positive.");
    i.status = status as IssueStatus;
    if (i.status === "resolved") i.resolvedAt = nowIso(now);
    else delete i.resolvedAt;
    this.save();
    return this.view(i);
  }

  /** Files one run's signals. Returns the issues that are new, came back, or were seen again. */
  fileRun(projectId: ProjectId, run: Pick<RunSummary, "id" | "testId" | "name" | "startedAt">, signals: Signal[]): IssueId[] {
    // Every filed run is kept (about 17 bytes each): a cap would let syncIssues file the oldest runs again and count them twice.
    const filed = (this.data.filed[projectId] ??= []);
    const set = (this.filedSets[projectId] ??= new Set(filed));
    if (set.has(run.id)) return [];
    set.add(run.id);
    filed.push(run.id);
    const changed: IssueId[] = [];
    for (const s of signals) {
      const occ: IssueOccurrence = { runId: run.id, ...(run.testId ? { testId: run.testId } : {}), testName: run.name, step: s.step, videoAt: s.videoAt, at: run.startedAt, evidence: s.evidence };
      let i = this.data.issues.find((x) => x.projectId === projectId && x.key === s.key);
      if (!i) {
        i = { id: newId("iss"), projectId, key: s.key, kind: s.kind, title: s.title, severity: s.severity, status: "open", firstSeen: run.startedAt, lastSeen: run.startedAt, count: 1, occurrences: [occ] };
        this.data.issues.push(i);
        changed.push(i.id);
        continue;
      }
      i.count++;
      i.severity = Math.max(i.severity, s.severity) as Severity;
      if (run.startedAt > i.lastSeen) i.lastSeen = run.startedAt;
      if (run.startedAt < i.firstSeen) i.firstSeen = run.startedAt;
      i.occurrences = [occ, ...i.occurrences].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, OCCURRENCES_MAX);
      // It came back after it was resolved: open again. A false positive stays muted.
      if (i.status === "resolved" && (!i.resolvedAt || run.startedAt > i.resolvedAt)) {
        i.status = "open";
        i.reopenedAt = run.startedAt;
        delete i.resolvedAt;
      }
      changed.push(i.id);
    }
    this.save();
    return changed;
  }

  deleteProject(projectId: ProjectId): void {
    this.data.issues = this.data.issues.filter((i) => i.projectId !== projectId);
    delete this.data.filed[projectId];
    delete this.filedSets[projectId];
    this.save();
  }

  /** How many issues each run of a project touched (for the history list). */
  perRun(projectId: ProjectId): Map<string, number> {
    const m = new Map<string, number>();
    for (const i of this.data.issues) if (i.projectId === projectId) for (const o of i.occurrences) m.set(o.runId, (m.get(o.runId) ?? 0) + 1);
    return m;
  }
}
