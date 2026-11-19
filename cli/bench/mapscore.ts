/**
 * The fixed map scoring script (any-site plan 2.1, wave M0): a crawler's map against a hand-written
 * feature list ("truth" file), scored by fixed rules written before any run. Deterministic: no AI, no
 * network, no fuzzy or semantic matching. The same input always gives the same score.
 *
 * Input: a map, in any of the shapes today's crawlers write, normalised here to flat entries
 *   - learn's map.json (schemaVersion "map-1"): every action, and every screen as a read; map mode's
 *     map (mapcrawl.ts, kind "mapmode-1") is the same shape, its actions carrying verb, entity and
 *     controls, which are used as given, and no screens;
 *   - the tester's Discovery crawl (explore.ts ExploreRun, bare or as { report }): every page as a
 *     read, and every control it left alone;
 *   - the tester's suggested task list (`test --suggest --json`, what `--explore` runs): every task;
 *   - already-flat entries: { entries: MapEntry[] }.
 * plus a truth file (its own `matching` block holds the synonym table, verb classes and entity
 * aliases, so the rules travel with the list).
 *
 * Output: recall, precision, duplicates, neutral and false-positive counts, a per-feature match table
 * and a per-entry table saying why each entry counted as it did.
 *
 * Normalising, the fixed rules (the same for every crawler and every app):
 *   - text: lower-case, trim, collapse spaces.
 *   - verb: a phrase's first word ("Create a contact" -> "create"), then the truth's synonym table.
 *   - entity: the words after the verb, with leading a/an/the/new/your dropped and cut at the first
 *     linking word (to, for, from, by, in, on, with, into, at, as, and, of); a title's part before " · ".
 *   - address: scheme and host dropped, the instance prefix dropped (default the zoo's /z/<hex>/ or
 *     /z/:id/), no trailing slash, query kept, fragment dropped. The start page is "".
 * Plural forms: an entity matches an alias when the two share a form among {x, x less a trailing "s",
 * x less a trailing "es"}.
 *
 *   node cli/bench/mapscore.ts <map.json> <truth.json> [--twin task] [--skin crm] [--lenient] [--json]
 *
 * --lenient is a diagnostic only, never the score: it drops the entity and verb checks and matches on
 * the address and control alone, to show how much of an app a crawler reached without naming it. An
 * entry that names no control then meets only a pattern that names none.
 */
import { readFileSync } from "node:fs";

/** One map entry, whatever crawler wrote it. A missing field is undecidable for that check. */
export interface MapEntry {
  /** What the crawler called it, for the tables. */
  label: string;
  verb?: string;
  entity?: string;
  /** Normalised addresses (see normaliseUrl). Empty: undecidable, so a miss. */
  urls: string[];
  /** Control names; empty means the entry names no control (it matches on address alone). */
  controls: string[];
  /** Which part of the crawler's output it came from: "action", "screen", "page", "left-alone", "task". */
  from: string;
}

export interface TruthEntry {
  url: string;
  controls: string[];
}
export interface TruthFeature {
  id: string;
  entity: string;
  entityAliases?: string[];
  verb: string;
  purpose?: string;
  entry: TruthEntry[];
  twins?: string[];
}
export interface TruthNeutral {
  what: string;
  verb?: string;
  url: string;
  controls: string[];
}
export interface Truth {
  app: string;
  skin_d_set: string;
  features: TruthFeature[];
  neutral?: TruthNeutral[];
  matching: {
    verb: { synonyms: Record<string, string>; classes: string[][] };
    entity_by_skin: Record<string, string[]>;
  };
}

export type EntryOutcome =
  | { kind: "tp"; feature: string }
  | { kind: "duplicate"; feature: string }
  | { kind: "neutral"; what: string }
  | { kind: "fp"; why: string };

export interface Score {
  app: string;
  twin: string;
  skin: string;
  lenient: boolean;
  features: number;
  entries: number;
  tp: number;
  duplicates: number;
  neutral: number;
  fp: number;
  /** tp / features. */
  recall: number;
  /** tp / (entries - neutral); 0 when nothing is left to count. */
  precision: number;
  perFeature: { id: string; verb: string; matched: boolean; by?: string; duplicates: number }[];
  perEntry: { label: string; from: string; verb?: string; entity?: string; urls: string[]; controls: string[]; outcome: EntryOutcome }[];
}

export interface ScoreOptions {
  /** The twin the run used (default "task"): base features plus those whose `twins` list it. */
  twin?: string;
  /** The instance's skin (default the truth's D-set skin): resolves "$entity". */
  skin?: string;
  /** Diagnostic: address and control only, no entity or verb check. Never the score. */
  lenient?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Normalising.

const LEADING = new Set(["a", "an", "the", "new", "your"]);
const LINKING = new Set(["to", "for", "from", "by", "in", "on", "with", "into", "at", "as", "and", "of"]);

export const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A phrase's first word, as the verb. */
export function verbOf(phrase: string): string | undefined {
  const w = normText(phrase).split(" ")[0];
  return w ? w.replace(/[^a-z_]/g, "") || undefined : undefined;
}

/** A noun phrase, as an entity: leading articles dropped, cut at the first linking word. */
export function entityOf(words: string): string | undefined {
  const out: string[] = [];
  for (const w of normText(words).replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(" ").filter(Boolean)) {
    if (!out.length && LEADING.has(w)) continue;
    if (LINKING.has(w)) break;
    out.push(w);
  }
  return out.length ? out.join(" ") : undefined;
}

/** The entity of "<verb> <noun phrase>": the words after the first. */
export const entityAfterVerb = (phrase: string): string | undefined => entityOf(normText(phrase).split(" ").slice(1).join(" "));

/** The zoo's instance prefix, as a crawler writes it (an id, or learn's ":id" template). */
export const ZOO_PREFIX = /^\/z\/(?:[0-9a-f]+|:id)(?:\/|$)/;

/** An address with scheme, host, instance prefix, trailing slash and fragment dropped; query kept. */
export function normaliseUrl(u: string, prefix: RegExp = ZOO_PREFIX): string {
  let path = u.trim();
  let query = "";
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(path);
  if (abs) path = path.slice(abs[0].length);
  path = path.split("#")[0]!;
  const q = path.indexOf("?");
  if (q >= 0) {
    query = path.slice(q);
    path = path.slice(0, q);
  }
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(prefix, "/");
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${path}${query === "?" ? "" : query}`;
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x : undefined);
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});

/** learn's map.json: each action (verb and entity from its name), each screen as a read of its title. */
export function fromLearnMap(map: unknown, prefix: RegExp = ZOO_PREFIX): MapEntry[] {
  const m = rec(map);
  const out: MapEntry[] = [];
  for (const a of Array.isArray(m.actions) ? m.actions.map(rec) : []) {
    const name = str(a.name) ?? "";
    const pages = strings(a.pages);
    // Map mode's extension (mapcrawl.ts, kind "mapmode-1"): an action may say its verb, entity and
    // every control itself; a learn action, which has none of them, is read from its name as before.
    const verb = str(a.verb) ?? verbOf(name);
    const entity = str(a.entity) ?? entityAfterVerb(name);
    const controls = strings(a.controls);
    out.push({
      label: name || String(a.id ?? "?"),
      ...(verb ? { verb } : {}),
      ...(entity ? { entity } : {}),
      urls: [...new Set(pages.map((p) => normaliseUrl(p, prefix)))],
      controls: controls.length ? controls : str(a.onScreen) ? [a.onScreen as string] : [],
      from: "action",
    });
  }
  for (const s of Array.isArray(m.screens) ? m.screens.map(rec) : []) {
    const title = str(s.title)?.split(" · ")[0] ?? strings(s.headings)[0];
    const at = str(s.address) ?? str(s.path);
    out.push({ label: `screen ${at ?? "?"}`, verb: "read", ...(title && entityOf(title) ? { entity: entityOf(title)! } : {}), urls: at ? [normaliseUrl(at, prefix)] : [], controls: [], from: "screen" });
  }
  return out;
}

/** The tester's Discovery crawl: each page as a read of its title (by the words of the link that led there), each control left alone. */
export function fromExploreRun(run: unknown, prefix: RegExp = ZOO_PREFIX): MapEntry[] {
  const r = rec(rec(run).report ?? run);
  const out: MapEntry[] = [];
  for (const p of Array.isArray(r.pages) ? r.pages.map(rec) : []) {
    const at = str(p.path);
    const url = at ? normaliseUrl(at, prefix) : undefined;
    const title = str(p.title)?.split(" · ")[0];
    const words = str(rec(p.from).words);
    out.push({ label: `page ${at ?? "?"}`, verb: "read", ...(title && entityOf(title) ? { entity: entityOf(title)! } : {}), urls: url !== undefined ? [url] : [], controls: words ? [words] : [], from: "page" });
    for (const why of strings(p.leftAlone)) {
      const name = /^"(.+?)" wasn't pressed/.exec(why)?.[1];
      if (!name) continue;
      const names = name.split(" / ").map((x) => x.trim()).filter(Boolean);
      const first = names[0] ?? name;
      out.push({ label: `left alone: ${name}`, ...(verbOf(first) ? { verb: verbOf(first)! } : {}), ...(entityAfterVerb(first) ? { entity: entityAfterVerb(first)! } : {}), urls: url !== undefined ? [url] : [], controls: names, from: "left-alone" });
    }
  }
  return out;
}

/** The tester's suggested tasks: verb from the goal, entity from its area; a task starts on the start page. */
export function fromTasks(list: unknown): MapEntry[] {
  return (Array.isArray(rec(list).tasks) ? (rec(list).tasks as unknown[]).map(rec) : []).map((t) => {
    const goal = str(t.goal) ?? "";
    const area = str(t.area);
    return { label: goal, ...(verbOf(goal) ? { verb: verbOf(goal)! } : {}), ...(area && entityOf(area) ? { entity: entityOf(area)! } : {}), urls: [""], controls: [], from: "task" };
  });
}

/** Any of the shapes above, told apart by their own fields. */
export function normalise(input: unknown, prefix: RegExp = ZOO_PREFIX): MapEntry[] {
  const x = rec(input);
  if (Array.isArray(x.entries)) return (x.entries as MapEntry[]).map((e) => ({ ...e, urls: e.urls ?? [], controls: e.controls ?? [] }));
  if (x.schemaVersion === "map-1" || Array.isArray(x.actions)) return fromLearnMap(x, prefix);
  if (Array.isArray(rec(x.report ?? x).pages)) return fromExploreRun(x, prefix);
  if (Array.isArray(x.tasks)) return fromTasks(x);
  throw new Error("not a map this script knows: expected learn's map.json, an explore run, a task list or { entries }");
}

// ---------------------------------------------------------------------------------------------
// Matching.

const forms = (x: string): string[] => {
  const t = normText(x);
  const out = [t];
  if (t.endsWith("es")) out.push(t.slice(0, -2));
  if (t.endsWith("s")) out.push(t.slice(0, -1));
  return out;
};

export function entityMatches(entity: string | undefined, aliases: readonly string[]): boolean {
  if (!entity) return false;
  const mine = new Set(forms(entity));
  return aliases.some((a) => forms(a).some((f) => mine.has(f)));
}

export function verbClass(verb: string | undefined, truth: Truth): number {
  if (!verb) return -1;
  const v = normText(verb);
  const syn = truth.matching.verb.synonyms[v] ?? v;
  return truth.matching.verb.classes.findIndex((c) => c.includes(syn));
}

const anchored = (re: string, flags = "") => new RegExp(`^(?:${re})$`, flags);

/** An entry pattern holds: an address matches, and when the entry names a control, one matches. An empty control list takes any. */
export function entryMatches(e: Pick<MapEntry, "urls" | "controls">, pattern: TruthEntry): boolean {
  if (!e.urls.length) return false;
  const url = anchored(pattern.url);
  if (!e.urls.some((u) => url.test(u))) return false;
  if (!e.controls.length || !pattern.controls.length) return true;
  return pattern.controls.some((c) => e.controls.some((n) => anchored(c, "i").test(normText(n))));
}

export function featuresFor(truth: Truth, twin = "task"): TruthFeature[] {
  return truth.features.filter((f) => !f.twins || f.twins.includes(twin));
}

export function aliasesOf(f: TruthFeature, truth: Truth, skin: string): string[] {
  if (f.entityAliases?.length) return f.entityAliases;
  if (f.entity === "$entity") return truth.matching.entity_by_skin[skin] ?? [];
  return [f.entity];
}

/** Why an entry is not this feature, or undefined when it is. */
function mismatch(e: MapEntry, f: TruthFeature, truth: Truth, skin: string, lenient: boolean): string | undefined {
  if (!e.urls.length) return "no address (undecidable)";
  if (!lenient) {
    if (!e.entity) return "no entity (undecidable)";
    if (!e.verb) return "no verb (undecidable)";
    if (!entityMatches(e.entity, aliasesOf(f, truth, skin))) return "entity";
    const vc = verbClass(e.verb, truth);
    if (vc < 0) return "verb not in the table";
    if (vc !== verbClass(f.verb, truth)) return "verb";
  }
  // Lenient has no entity or verb to tell features on one page apart, so an entry naming no control
  // only meets a pattern that names none either (else one bare page would "find" every feature on it).
  if (!f.entry.some((p) => entryMatches(e, p) && (!lenient || e.controls.length > 0 || p.controls.length === 0))) return "entry";
  return undefined;
}

/** How far an entry got before a check said no: a later reason is a nearer miss. */
const DEPTH = ["no address (undecidable)", "no entity (undecidable)", "no verb (undecidable)", "entity", "verb not in the table", "verb", "entry"];

/** A neutral pattern needs the entry to name a matching control: an address alone never makes an entry neutral. */
function neutralOf(e: MapEntry, truth: Truth): TruthNeutral | undefined {
  if (!e.controls.length || !e.urls.length) return undefined;
  return (truth.neutral ?? []).find((n) => e.urls.some((u) => anchored(n.url).test(u)) && n.controls.some((c) => e.controls.some((x) => anchored(c, "i").test(normText(x)))));
}

export function score(entries: readonly MapEntry[], truth: Truth, o: ScoreOptions = {}): Score {
  const twin = o.twin ?? "task";
  const skin = o.skin ?? truth.skin_d_set;
  const lenient = o.lenient === true;
  const feats = featuresFor(truth, twin);
  const matched = new Map<string, string>();
  const dups = new Map<string, number>();
  const perEntry: Score["perEntry"] = [];
  for (const e of entries) {
    const fits = feats.filter((f) => !mismatch(e, f, truth, skin, lenient));
    const fresh = fits.find((f) => !matched.has(f.id));
    let outcome: EntryOutcome;
    if (fresh) {
      matched.set(fresh.id, e.label);
      outcome = { kind: "tp", feature: fresh.id };
    } else if (fits.length) {
      dups.set(fits[0]!.id, (dups.get(fits[0]!.id) ?? 0) + 1);
      outcome = { kind: "duplicate", feature: fits[0]!.id };
    } else {
      const n = neutralOf(e, truth);
      if (n) outcome = { kind: "neutral", what: n.what };
      else {
        // The nearest miss: the reason from the feature the entry got furthest with (checks run address, entity, verb, entry).
        const whys = feats.map((f) => mismatch(e, f, truth, skin, lenient)!).filter(Boolean);
        const why = whys.sort((a, b) => DEPTH.indexOf(b) - DEPTH.indexOf(a))[0] ?? "no feature";
        outcome = { kind: "fp", why };
      }
    }
    perEntry.push({ label: e.label, from: e.from, ...(e.verb ? { verb: e.verb } : {}), ...(e.entity ? { entity: e.entity } : {}), urls: e.urls, controls: e.controls, outcome });
  }
  const count = (k: EntryOutcome["kind"]) => perEntry.filter((p) => p.outcome.kind === k).length;
  const tp = count("tp");
  const neutral = count("neutral");
  const counted = entries.length - neutral;
  return {
    app: truth.app,
    twin,
    skin,
    lenient,
    features: feats.length,
    entries: entries.length,
    tp,
    duplicates: count("duplicate"),
    neutral,
    fp: count("fp"),
    recall: feats.length ? tp / feats.length : 0,
    precision: counted ? tp / counted : 0,
    perFeature: feats.map((f) => ({ id: f.id, verb: f.verb, matched: matched.has(f.id), ...(matched.has(f.id) ? { by: matched.get(f.id)! } : {}), duplicates: dups.get(f.id) ?? 0 })),
    perEntry,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The score as a short plain table. */
export function formatScore(s: Score): string {
  const lines = [`${s.app} (${s.twin}, ${s.skin})${s.lenient ? " LENIENT, diagnostic only" : ""}: recall ${s.tp}/${s.features} ${pct(s.recall)}, precision ${s.tp}/${s.entries - s.neutral} ${pct(s.precision)}, ${s.duplicates} duplicate(s), ${s.fp} false positive(s), ${s.neutral} neutral`];
  for (const f of s.perFeature) lines.push(`  ${f.matched ? "found " : "missed"}  ${f.id} (${f.verb})${f.by ? `  by "${f.by}"` : ""}${f.duplicates ? `  +${f.duplicates} dup` : ""}`);
  for (const e of s.perEntry) {
    const o = e.outcome;
    const what = o.kind === "tp" ? `tp ${o.feature}` : o.kind === "duplicate" ? `dup ${o.feature}` : o.kind === "neutral" ? "neutral" : `fp (${o.why})`;
    lines.push(`    ${what.padEnd(28)} ${e.from}: ${e.label}  [${e.verb ?? "-"} | ${e.entity ?? "-"} | ${e.urls.map((u) => JSON.stringify(u)).join(",") || "-"}${e.controls.length ? ` | ${e.controls.join(", ")}` : ""}]`);
  }
  return lines.join("\n");
}

// node cli/bench/mapscore.ts <map.json> <truth.json> [--twin t] [--skin s] [--lenient] [--json]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [mapFile, truthFile] = args.filter((a, i) => !a.startsWith("--") && !["--twin", "--skin"].includes(args[i - 1] ?? ""));
  if (!mapFile || !truthFile) {
    process.stderr.write("usage: mapscore.ts <map.json> <truth.json> [--twin task] [--skin crm] [--lenient] [--json]\n");
    process.exit(2);
  }
  const s = score(normalise(JSON.parse(readFileSync(mapFile, "utf8"))), JSON.parse(readFileSync(truthFile, "utf8")) as Truth, { ...(opt("twin") ? { twin: opt("twin")! } : {}), ...(opt("skin") ? { skin: opt("skin")! } : {}), lenient: args.includes("--lenient") });
  process.stdout.write(`${args.includes("--json") ? JSON.stringify(s, null, 2) : formatScore(s)}\n`);
}
