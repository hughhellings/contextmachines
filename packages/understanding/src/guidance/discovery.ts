import type { Progress } from "./progress.ts";

/**
 * Finds, from usage alone, which features are worth guiding users towards,
 * with no input from the site's owner. Pure statistics over per-user progress.
 *
 * Methods, in order of strength:
 *  1. retention_lift: users who used the feature in their first `earlyDays`
 *     are retained more than *similarly engaged* users who didn't. Users are
 *     stratified by how active they were in that first window (engaged users
 *     use more features and stay longer regardless), lifts are combined across
 *     strata, and the significance bar is raised for the number of features
 *     tested (Bonferroni). Needs users old enough to judge retention.
 *  2. power_users: the most engaged users use the feature far more often than
 *     the rest. Weaker (engagement drives usage as much as the reverse), so it
 *     is only used for features the first method could not assess.
 *  3. friction: actions that often fail. Not a goal: a signal that users get
 *     stuck there, for help content and for the site's owner.
 *
 * Correlation is not causation: discovered goals start in log-only mode, and
 * the holdout cohort is what later shows whether suggesting them helps.
 */

export interface DiscoveryOptions {
  earlyDays: number;
  /** A user counts as retained if active on at least this many distinct days after `earlyDays`. */
  retainedMinDays: number;
  /** Only users first seen at least this long ago are judged on retention. */
  minAgeDays: number;
  /** Minimum users in each group for a comparison to count. */
  minGroup: number;
  /** Required z-score (1.96 ≈ 95% two-sided). */
  minZ: number;
  /** Required absolute lift in retention rate. */
  minLift: number;
  powerUserMinRatio: number;
  frictionMinAttempts: number;
  frictionMinRate: number;
}

export const DEFAULT_DISCOVERY: DiscoveryOptions = {
  earlyDays: 7,
  retainedMinDays: 2,
  minAgeDays: 14,
  minGroup: 20,
  minZ: 1.96,
  minLift: 0.1,
  powerUserMinRatio: 2,
  frictionMinAttempts: 10,
  frictionMinRate: 0.2,
};

export type FeatureKind = "action" | "page";

export interface RetentionEvidence {
  method: "retention_lift";
  usersJudged: number;
  usedEarly: number;
  notUsedEarly: number;
  /** Raw rates, for reading; the decision uses the stratified lift. */
  retainedIfUsed: number;
  retainedIfNot: number;
  /** Lift after comparing like with like (by first-window activity). */
  lift: number;
  z: number;
  /** z required after correcting for the number of features tested. */
  zRequired: number;
}

export interface PowerUserEvidence {
  method: "power_users";
  powerUsers: number;
  others: number;
  adoptionPower: number;
  adoptionOthers: number;
  ratio: number;
}

export interface Finding {
  kind: FeatureKind;
  key: string;
  /** Overall share of users who have used it. */
  adoption: number;
  /** Typical uses among users who keep using the product (median), used as the "done" threshold. */
  typicalCount: number;
  evidence: RetentionEvidence | PowerUserEvidence;
  /** Higher is stronger; used to rank and to set goal priority. */
  score: number;
}

export interface Friction {
  key: string;
  attempts: number;
  failures: number;
  failureRate: number;
  usersAffected: number;
}

/** Every feature the retention test had enough data for, significant or not (so hypotheses can be retired). */
export interface Assessment {
  kind: FeatureKind;
  key: string;
  lift: number;
  z: number;
  zRequired: number;
  usedEarly: number;
  notUsedEarly: number;
}

/** A feature people try once and never touch again, although they keep using the product. */
export interface AbandonedFeature {
  kind: FeatureKind;
  key: string;
  triedUsers: number;
  abandonedUsers: number;
  rate: number;
}

export interface DiscoveryResult {
  users: number;
  usersJudgedOnRetention: number;
  findings: Finding[];
  assessed: Assessment[];
  friction: Friction[];
  abandoned: AbandonedFeature[];
  /** Why the strongest method could not run, when it could not. */
  notes: string[];
}

const DAY_MS = 86_400_000;

export function discover(all: readonly Progress[], now: number, options: Partial<DiscoveryOptions> = {}): DiscoveryResult {
  const o = { ...DEFAULT_DISCOVERY, ...options };
  const notes: string[] = [];
  const users = all.length;
  const features = featureKeys(all);

  // ---------- 1. Retention lift ----------
  const judged = all.filter((p) => now - p.firstSeenAt >= o.minAgeDays * DAY_MS);
  const retained = new Map<Progress, boolean>(judged.map((p) => [p, daysActiveAfter(p, o.earlyDays) >= o.retainedMinDays]));
  const findings: Finding[] = [];
  const assessed = new Set<string>();
  const assessments: Assessment[] = [];

  if (judged.length < o.minGroup * 2) {
    notes.push(`retention_lift needs at least ${o.minGroup * 2} users first seen ${o.minAgeDays}+ days ago; have ${judged.length}`);
  } else {
    const zRequired = Math.max(o.minZ, bonferroniZ(0.05, features.length));
    // Strata: 1, 2, and 3+ active days in the first window.
    const stratumOf = (p: Progress) => Math.min(Math.max(earlyActiveDays(p, o.earlyDays), 1), 3) - 1;
    for (const { kind, key } of features) {
      const groups = [0, 1, 2].map(() => ({ usedN: 0, usedR: 0, notN: 0, notR: 0 }));
      for (const p of judged) {
        const g = groups[stratumOf(p)] as (typeof groups)[number];
        const r = retained.get(p) === true;
        if (usedWithin(p, kind, key, o.earlyDays)) {
          g.usedN++;
          if (r) g.usedR++;
        } else {
          g.notN++;
          if (r) g.notR++;
        }
      }
      const usedN = groups.reduce((n, g) => n + g.usedN, 0);
      const notN = groups.reduce((n, g) => n + g.notN, 0);
      if (usedN < o.minGroup || notN < o.minGroup) continue;
      assessed.add(`${kind}:${key}`);

      // Combine per-stratum differences, weighted by stratum size; skip strata too small to compare.
      const usable = groups.filter((g) => g.usedN >= 5 && g.notN >= 5);
      const total = usable.reduce((n, g) => n + g.usedN + g.notN, 0);
      if (total === 0) continue;
      let lift = 0;
      let variance = 0;
      for (const g of usable) {
        const w = (g.usedN + g.notN) / total;
        const p1 = g.usedR / g.usedN;
        const p2 = g.notR / g.notN;
        lift += w * (p1 - p2);
        variance += w * w * (Math.max(p1 * (1 - p1), 1e-6) / g.usedN + Math.max(p2 * (1 - p2), 1e-6) / g.notN);
      }
      const z = lift / Math.sqrt(variance);
      assessments.push({ kind, key, lift: round(lift), z: round(z), zRequired: round(zRequired), usedEarly: usedN, notUsedEarly: notN });
      if (lift >= o.minLift && z >= zRequired) {
        const usedR = groups.reduce((n, g) => n + g.usedR, 0);
        const notR = groups.reduce((n, g) => n + g.notR, 0);
        findings.push({
          kind,
          key,
          adoption: adoption(all, kind, key),
          typicalCount: typicalCount(all.filter((p) => retained.get(p) === true), kind, key),
          evidence: { method: "retention_lift", usersJudged: judged.length, usedEarly: usedN, notUsedEarly: notN, retainedIfUsed: round(usedR / usedN), retainedIfNot: round(notR / notN), lift: round(lift), z: round(z), zRequired: round(zRequired) },
          score: round(lift * Math.min(z / zRequired, 3)),
        });
      }
    }
  }

  // ---------- 2. Power-user features (fallback for features not assessed above) ----------
  if (users >= o.minGroup) {
    const byEngagement = [...all].sort((a, b) => b.activeDays.length - a.activeDays.length);
    const power = byEngagement.slice(0, Math.max(1, Math.floor(users / 4)));
    const others = byEngagement.slice(Math.floor(users / 2));
    if (power.length >= Math.ceil(o.minGroup / 4) && others.length >= Math.ceil(o.minGroup / 2)) {
      for (const { kind, key } of features) {
        if (assessed.has(`${kind}:${key}`)) continue;
        const aPower = adoption(power, kind, key);
        const aOthers = adoption(others, kind, key);
        const ratio = aOthers === 0 ? (aPower > 0 ? Number.POSITIVE_INFINITY : 0) : aPower / aOthers;
        if (aPower >= 0.5 && ratio >= o.powerUserMinRatio) {
          findings.push({
            kind,
            key,
            adoption: adoption(all, kind, key),
            typicalCount: typicalCount(power, kind, key),
            evidence: { method: "power_users", powerUsers: power.length, others: others.length, adoptionPower: round(aPower), adoptionOthers: round(aOthers), ratio: Number.isFinite(ratio) ? round(ratio) : 999 },
            // Deliberately weaker than any retention finding.
            score: round(Math.min(aPower - aOthers, 1) * 0.5),
          });
        }
      }
    }
  } else {
    notes.push(`power_users needs at least ${o.minGroup} users; have ${users}`);
  }

  // ---------- 3. Friction ----------
  const friction: Friction[] = [];
  for (const { kind, key } of features) {
    if (kind !== "action") continue;
    let attempts = 0, failures = 0, usersAffected = 0;
    for (const p of all) {
      const s = p.actions[key];
      if (!s) continue;
      attempts += s.count + s.failures;
      failures += s.failures;
      if (s.failures > 0) usersAffected++;
    }
    if (attempts >= o.frictionMinAttempts && failures / attempts >= o.frictionMinRate) {
      friction.push({ key, attempts, failures, failureRate: round(failures / attempts), usersAffected });
    }
  }

  // ---------- 4. Tried once, then avoided ----------
  // Used exactly once, never again, while the user stayed active on 3+ later days.
  const abandoned: AbandonedFeature[] = [];
  for (const { kind, key } of features) {
    let tried = 0;
    let gaveUp = 0;
    for (const p of all) {
      const st = stat(p, kind, key);
      if (!st || st.count === 0) continue;
      tried++;
      const day = new Date(st.firstAt).toISOString().slice(0, 10);
      if (st.count === 1 && st.lastAt === st.firstAt && p.activeDays.filter((d) => d > day).length >= 3) gaveUp++;
    }
    if (tried >= 10 && gaveUp / tried >= 0.5) abandoned.push({ kind, key, triedUsers: tried, abandonedUsers: gaveUp, rate: round(gaveUp / tried) });
  }
  abandoned.sort((a, b) => b.rate - a.rate || b.triedUsers - a.triedUsers);

  findings.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  friction.sort((a, b) => b.failureRate - a.failureRate);
  return { users, usersJudgedOnRetention: judged.length, findings, assessed: assessments, friction, abandoned, notes };
}

function featureKeys(all: readonly Progress[]): { kind: FeatureKind; key: string }[] {
  const actions = new Set<string>();
  const pages = new Set<string>();
  for (const p of all) {
    for (const k of Object.keys(p.actions)) actions.add(k);
    for (const k of Object.keys(p.pages)) pages.add(k);
  }
  return [...[...actions].sort().map((key) => ({ kind: "action" as const, key })), ...[...pages].sort().map((key) => ({ kind: "page" as const, key }))];
}

function stat(p: Progress, kind: FeatureKind, key: string) {
  return (kind === "action" ? p.actions : p.pages)[key];
}

function usedWithin(p: Progress, kind: FeatureKind, key: string, days: number): boolean {
  const s = stat(p, kind, key);
  return s !== undefined && s.count > 0 && s.firstAt - p.firstSeenAt < days * DAY_MS;
}

function daysActiveAfter(p: Progress, days: number): number {
  const cutoff = new Date(p.firstSeenAt + days * DAY_MS).toISOString().slice(0, 10);
  return p.activeDays.filter((d) => d > cutoff).length;
}

function earlyActiveDays(p: Progress, days: number): number {
  const cutoff = new Date(p.firstSeenAt + days * DAY_MS).toISOString().slice(0, 10);
  return p.activeDays.filter((d) => d <= cutoff).length;
}

function adoption(group: readonly Progress[], kind: FeatureKind, key: string): number {
  if (group.length === 0) return 0;
  return group.filter((p) => (stat(p, kind, key)?.count ?? 0) > 0).length / group.length;
}

function typicalCount(group: readonly Progress[], kind: FeatureKind, key: string): number {
  const counts = group.map((p) => stat(p, kind, key)?.count ?? 0).filter((c) => c > 0).sort((a, b) => a - b);
  return counts.length ? Math.max(1, counts[Math.floor(counts.length / 2)] as number) : 1;
}

/** One-sided critical z for family-wise error `alpha` across `tests` comparisons. */
export function bonferroniZ(alpha: number, tests: number): number {
  return inverseNormal(1 - alpha / Math.max(1, tests));
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function inverseNormal(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError("p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const poly = (k: number[], x: number) => k.reduce((acc, ki) => acc * x + ki, 0);
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(c, q) / (poly(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

/** Pooled two-proportion z statistic for p1 > p2. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (x1 / n1 - x2 / n2) / se;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
