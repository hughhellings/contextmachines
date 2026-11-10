import type { DiscoveryResult } from "../guidance/discovery.ts";
import { AUTH_PAGE, NOT_PRODUCT } from "../guidance/lifecycle.ts";
import { progressKey, type Progress } from "../guidance/progress.ts";
import type { LearnedAction, SiteModelSnapshot } from "../learn/learner.ts";
import { isRead, singular } from "../learn/naming.ts";
import { learnedScreenName } from "../learn/screen-names.ts";

/**
 * The product as features: the learned screens and actions grouped into the parts of the
 * product a person would name ("Invoices", "Reports", "Billing"), with how many people
 * use each, how valuable the evidence says it is, and how many are missing out.
 *
 * Grouping is by where things live: a feature is a top-level area of the site
 * (/invoices, /invoices/:id …), or a second-level one under settings-like areas
 * (/settings/billing). An action belongs to the feature whose pages trigger it most,
 * or else whose name it carries ("daily_invoice_total.list" → Invoices).
 */
export interface Feature {
  /** Stable id: the area path ("/invoices", "/settings/billing"). */
  id: string;
  name: string;
  pages: string[];
  actions: string[];
  /** It holds the product's core action. */
  core: boolean;
}

export type ValueLevel = "core" | "high" | "medium" | "low";
export type Confidence = "causal" | "proven" | "supported" | "hypothesis" | "not_supported" | "unknown";

/** What a feature is for, written from the site itself (see describe.ts). */
export interface FeaturePurpose {
  id: string;
  purpose: string;
  howTo: string;
  value: ValueLevel;
  why: string;
}

export interface FeatureUsage {
  people: number;
  users: number;
  adoption: number;
  /** The same among people who came back (2+ active days): the ones whose habits tell. */
  returningPeople: number;
  returningAdoption: number;
  /** Median uses among people who used it. */
  typicalUses: number;
}

export interface FeatureValue {
  confidence: Confidence;
  /** Plain words: "people who use it early are 1.8× as likely to stay", or the purpose's reasoning. */
  evidence: string;
}

export interface FeatureReport extends Feature {
  purpose?: FeaturePurpose;
  usage: FeatureUsage;
  value: FeatureValue;
  /** People who have not used it: the reach of fixing that. */
  missing: number;
  /** Value × share missing, for ranking. 0 when there is no reason to think it matters. */
  opportunity: number;
}

const GROUPED_BY_TWO = /^(settings|account|admin|preferences|profile|workspace|org|organisation|organization|team)$/i;

/** The area a page belongs to. Pages on the site's other addresses keep their address. */
export function areaOf(path: string): string {
  const host = path.startsWith("//") ? `//${path.slice(2).split("/")[0]}` : "";
  // A record picked by the query ("/user?id=:id") is one of that page, as "/user/:id" would be.
  const rest = (host ? path.slice(host.length) : path).replace(/\?[^=/]+=:id$/, "");
  // A screen's pop-up or step ("/team/~invite-teammates") belongs to the screen's area.
  const segs = rest.replace(/([^/])#(!?)\//, "$1/#$2/").split("/").filter((s) => s && s !== ":id" && s !== "#" && s !== "#!" && !s.startsWith("~"));
  if (segs.length === 0) return `${host}/`;
  const depth = GROUPED_BY_TWO.test(segs[0]!) && segs.length > 1 ? 2 : 1;
  return `${host}/${segs.slice(0, depth).join("/").toLowerCase()}`;
}

export function groupFeatures(site: SiteModelSnapshot, coreActionId?: string): Feature[] {
  const byArea = new Map<string, { pages: string[]; actions: string[] }>();
  const area = (id: string) => byArea.get(id) ?? byArea.set(id, { pages: [], actions: [] }).get(id)!;
  for (const p of site.pages) {
    if (AUTH_PAGE.test(p.path)) continue;
    area(areaOf(p.path)).pages.push(p.path);
  }
  for (const r of site.routes) if (!AUTH_PAGE.test(r.path) && !site.pages.some((p) => p.path === r.path)) area(areaOf(r.path)).pages.push(r.path);
  // One item and the list of them are one feature (/invoice/:id and /invoices), kept under the list.
  const listOf = new Map<string, string>();
  for (const id of [...byArea.keys()]) {
    const list = [...byArea.keys()].find((other) => other !== id && singular(other) === id);
    if (!list) continue;
    area(list).pages.push(...byArea.get(id)!.pages);
    byArea.delete(id);
    listOf.set(id, list);
  }
  const areaFor = (path: string) => listOf.get(areaOf(path)) ?? areaOf(path);

  for (const action of site.actions) {
    if (action.review === "ignored" || NOT_PRODUCT.test(`${action.id} ${action.path}`)) continue;
    const home = homeOf(action, byArea, areaFor);
    if (home) area(home).actions.push(action.id);
  }

  const features = [...byArea.entries()]
    .filter(([, a]) => a.pages.length > 0)
    .map(([id, a]) => ({ id, name: readableName(id, a.pages, site), pages: a.pages, actions: a.actions, core: coreActionId !== undefined && a.actions.includes(coreActionId) }))
    .sort((x, y) => x.id.localeCompare(y.id));
  // Two features named alike (/accounts and /settings/accounts) are told apart by where they live: "Settings: Accounts".
  const counts = new Map<string, number>();
  for (const f of features) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  for (const f of features) {
    const parent = f.id.split("/").filter(Boolean).slice(-2, -1)[0];
    if ((counts.get(f.name) ?? 0) > 1 && parent) f.name = `${nameOf(`/${parent}`)}: ${f.name}`;
  }
  return features;
}

function homeOf(action: LearnedAction, areas: Map<string, unknown>, areaFor: (path: string) => string): string | undefined {
  const counts = new Map<string, number>();
  for (const [page, n] of Object.entries(action.triggerPages)) counts.set(areaFor(page), (counts.get(areaFor(page)) ?? 0) + n);
  const byTrigger = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (byTrigger) return byTrigger;
  // No button behind it: match its resource names against the areas' names.
  const words = action.id.toLowerCase().split(/[._]/);
  for (const id of areas.keys()) {
    const last = id.split("/").filter(Boolean).at(-1)?.toLowerCase();
    if (last && last.length >= 4 && words.some((w) => w === last || w === last.replace(/s$/, "") || (w.length >= 5 && last.startsWith(w)))) return id;
  }
  return undefined;
}

/**
 * A part is called what its own screen is called ("/classattr" → "Class Attribute", as the screens
 * list says), when that is a short name rather than a headline; otherwise its address in words. The
 * start screen's name is the site's, so the part at "/" stays "Home".
 */
const PART_NAME_MAX = 40;
function readableName(id: string, pages: readonly string[], site: SiteModelSnapshot): string {
  const own = id === "/" ? undefined : pages.find((p) => !p.includes("/~") && `/${p.replace(/([^/])#(!?)\//, "$1/#$2/").split("/").filter((s) => s && s !== "#" && s !== "#!").join("/")}`.toLowerCase() === id);
  const name = own && site.pages.some((p) => p.path === own) ? learnedScreenName(site.pages, own) : undefined;
  return name && name.length <= PART_NAME_MAX && name.split(" ").length <= 5 && !/[.!?…]$/.test(name) ? name : nameOf(id);
}

/** From the address, which is stable: an app's page title can lag a screen behind as it changes. */
function nameOf(id: string): string {
  // "/index.php?page=invoices": the part is what the query picks.
  const last = id.split("/").filter(Boolean).at(-1)?.replace(/^.*=/, "") ?? "Home";
  return last.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Who used each feature, from every person's progress (users, or visits on sites that send no user ids). */
export function usageOf(feature: Feature, people: readonly Progress[]): FeatureUsage {
  const pageKeys = feature.pages.map(progressKey);
  const actionKeys = feature.actions.map(progressKey);
  const uses = (p: Progress) => pageKeys.reduce((n, k) => n + (p.pages[k]?.count ?? 0), 0) + actionKeys.reduce((n, k) => n + (p.actions[k]?.count ?? 0), 0);
  const returning = people.filter((p) => p.activeDays.length >= 2);
  const counts = people.map(uses).filter((n) => n > 0).sort((a, b) => a - b);
  const users = counts.length;
  const returningUsers = returning.filter((p) => uses(p) > 0).length;
  return {
    people: people.length,
    users,
    adoption: ratio(users, people.length),
    returningPeople: returning.length,
    returningAdoption: ratio(returningUsers, returning.length),
    typicalUses: counts[Math.floor(counts.length / 2)] ?? 0,
  };
}

/**
 * How much reason there is to think a feature matters, strongest first: usage proving it
 * (early use predicts staying), usage supporting it (the heaviest users use it far more),
 * usage arguing against it, then the purpose's own reasoning (a hypothesis).
 */
export function valueOf(feature: Feature, discovery: DiscoveryResult | undefined, purpose: FeaturePurpose | undefined): FeatureValue {
  const keys = new Set([...feature.pages.map(progressKey), ...feature.actions.map(progressKey)]);
  const findings = (discovery?.findings ?? []).filter((f) => keys.has(f.key)).sort((a, b) => b.score - a.score);
  const retention = findings.find((f) => f.evidence.method === "retention_lift");
  if (retention?.evidence.method === "retention_lift") {
    return { confidence: "proven", evidence: `people who use it in their first days are ${round(retention.evidence.lift)}× as likely to still be using the product, compared with people just as active who don't (${retention.evidence.usersJudged} people)` };
  }
  const power = findings.find((f) => f.evidence.method === "power_users");
  if (power?.evidence.method === "power_users") {
    return { confidence: "supported", evidence: `${pct(power.evidence.adoptionPower)} of the most active people use it, against ${pct(power.evidence.adoptionOthers)} of everyone else` };
  }
  const against = (discovery?.assessed ?? []).filter((a) => keys.has(a.key)).find((a) => a.lift <= 1 && a.usedEarly + a.notUsedEarly >= 40);
  if (against) return { confidence: "not_supported", evidence: `people who use it early stay no better than people who don't (${against.usedEarly + against.notUsedEarly} people)` };
  if (feature.core) return { confidence: "hypothesis", evidence: "it holds what people do most here, the product's main action" };
  if (purpose) return { confidence: "hypothesis", evidence: purpose.why };
  return { confidence: "unknown", evidence: "no usage evidence yet, and no purpose written" };
}

const WEIGHT: Record<Confidence, number> = { causal: 1, proven: 1, supported: 0.7, hypothesis: 0.35, not_supported: 0, unknown: 0 };
const GUESS: Record<ValueLevel, number> = { core: 1, high: 1, medium: 0.6, low: 0.2 };

export function buildFeatureReport(site: SiteModelSnapshot, people: readonly Progress[], options: { discovery?: DiscoveryResult; coreActionId?: string; purposes?: readonly FeaturePurpose[] } = {}): FeatureReport[] {
  const purposes = new Map((options.purposes ?? []).map((p) => [p.id, p]));
  return groupFeatures(site, options.coreActionId).map((f) => {
    const purpose = purposes.get(f.id);
    const usage = usageOf(f, people);
    const value = valueOf(f, options.discovery, purpose);
    // A guess is only as strong as the purpose says the feature is; evidence speaks for itself.
    const weight = WEIGHT[value.confidence] * (value.confidence === "hypothesis" ? GUESS[f.core ? "core" : (purpose?.value ?? "low")] : 1);
    const missing = usage.people - usage.users;
    return { ...f, ...(purpose ? { purpose } : {}), usage, value, missing, opportunity: round(weight * ratio(missing, usage.people)) };
  });
}

/** Valuable but unused: the features most worth getting more people to, best first. */
export function unusedValue(features: readonly FeatureReport[], limit = 5): FeatureReport[] {
  return features.filter((f) => f.opportunity > 0 && f.missing > 0).sort((a, b) => b.opportunity - a.opportunity || b.missing - a.missing).slice(0, limit);
}

/** Saves the feature lets people make (writes, not reads), for describing what it does. */
export function savesOf(feature: Feature, site: SiteModelSnapshot): LearnedAction[] {
  return site.actions.filter((a) => feature.actions.includes(a.id) && !isRead(a));
}

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
const round = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;
