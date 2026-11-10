import { compileExpr, validateExpr, type Expr, type TraceEntry } from "./expr.ts";

export type RuleAction = "observe" | "nudge" | "fix" | "block" | "escalate";
export type RuleStatus = "draft" | "approved" | "disabled";
export type Mode = "shadow" | "live";

/** Shape of one captured field. Values are only present for allow-listed, scrubbed fields. */
export interface FieldShape {
  type: "string" | "number" | "boolean" | "null" | "array" | "object" | "file" | "unknown";
  empty: boolean;
  length?: number;
  value?: string | number | boolean;
}

/** Everything a rule may look at. Built from redacted capture, never raw page data. */
export interface EvalContext {
  action: { id: string };
  fields?: Record<string, FieldShape>;
  page?: { route?: string };
  user?: { role?: string };
  pad?: Record<string, unknown>;
}

interface RuleBase {
  id: string;
  version: number;
  bindsTo: { actions: string[] };
  action: RuleAction;
  message: string;
  status: RuleStatus;
  /** A rule is violated when `when` is true. */
  tests?: { shouldFlag: EvalContext[]; shouldNotFlag: EvalContext[] };
}

export interface DeterministicRule extends RuleBase {
  kind: "deterministic";
  when: Expr;
}

/** Needs model judgment; evaluated server-side. Optional `when` pre-filters cheaply. */
export interface ModelRule extends RuleBase {
  kind: "model";
  instruction: string;
  when?: Expr;
}

export type Rule = DeterministicRule | ModelRule;

export type OutcomeStatus = "violated" | "passed" | "needs_model";

export interface Outcome {
  ruleId: string;
  ruleVersion: number;
  status: OutcomeStatus;
  /** What the site's owner configured. */
  configuredAction: RuleAction;
  /** What actually happens now: always "observe" in shadow mode. */
  effectiveAction: RuleAction;
  message: string;
  evidence: TraceEntry[];
}

export interface RejectedRule {
  ruleId: string;
  issues: string[];
}

interface CompiledRule {
  rule: Rule;
  predicate?: (ctx: unknown, trace?: TraceEntry[]) => boolean;
}

/**
 * Precompiled, indexed rule set. Invalid rules are rejected individually so one
 * bad rule can never take down the others.
 */
export class RuleSet {
  readonly rejected: RejectedRule[] = [];
  private readonly byAction = new Map<string, CompiledRule[]>();

  constructor(rules: readonly Rule[]) {
    const seen = new Set<string>();
    for (const rule of rules) {
      const issues = validateRule(rule);
      if (seen.has(rule.id)) issues.push(`duplicate rule id "${rule.id}"`);
      if (issues.length > 0) {
        this.rejected.push({ ruleId: String(rule.id), issues });
        continue;
      }
      seen.add(rule.id);
      if (rule.status !== "approved") continue;
      const compiled: CompiledRule = { rule };
      if (rule.when) compiled.predicate = compileExpr(rule.when);
      for (const actionId of rule.bindsTo.actions) {
        const list = this.byAction.get(actionId) ?? [];
        list.push(compiled);
        this.byAction.set(actionId, list);
      }
    }
  }

  /** Evaluates every approved rule bound to `ctx.action.id`. Never throws. */
  evaluate(ctx: EvalContext, mode: Mode): Outcome[] {
    const candidates = this.byAction.get(ctx.action.id);
    if (!candidates) return [];
    const outcomes: Outcome[] = [];
    for (const { rule, predicate } of candidates) {
      const evidence: TraceEntry[] = [];
      const matched = predicate ? predicate(ctx, evidence) : true;
      let status: OutcomeStatus;
      if (rule.kind === "deterministic") status = matched ? "violated" : "passed";
      else status = matched ? "needs_model" : "passed";
      outcomes.push({
        ruleId: rule.id,
        ruleVersion: rule.version,
        status,
        configuredAction: rule.action,
        effectiveAction: mode === "shadow" ? "observe" : rule.action,
        message: rule.message,
        evidence: evidence.filter((e) => e.result),
      });
    }
    return outcomes;
  }

  get size(): number {
    let n = 0;
    for (const list of this.byAction.values()) n += list.length;
    return n;
  }
}

const RULE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const ACTIONS: readonly RuleAction[] = ["observe", "nudge", "fix", "block", "escalate"];
const STATUSES: readonly RuleStatus[] = ["draft", "approved", "disabled"];

export function validateRule(rule: Rule): string[] {
  const issues: string[] = [];
  if (typeof rule.id !== "string" || !RULE_ID.test(rule.id)) issues.push("id must be 1-128 chars of [A-Za-z0-9_.-]");
  if (!Number.isInteger(rule.version) || rule.version < 1) issues.push("version must be a positive integer");
  if (!Array.isArray(rule.bindsTo?.actions) || rule.bindsTo.actions.length === 0) {
    issues.push("bindsTo.actions must list at least one action");
  }
  if (!ACTIONS.includes(rule.action)) issues.push(`unknown action "${String(rule.action)}"`);
  if (!STATUSES.includes(rule.status)) issues.push(`unknown status "${String(rule.status)}"`);
  if (typeof rule.message !== "string" || rule.message.length === 0) issues.push("message is required");

  if (rule.kind === "deterministic") {
    issues.push(...validateExpr(rule.when).map((i) => `when ${i}`));
  } else if (rule.kind === "model") {
    if (typeof rule.instruction !== "string" || rule.instruction.length === 0) issues.push("instruction is required");
    if (rule.when !== undefined) issues.push(...validateExpr(rule.when).map((i) => `when ${i}`));
  } else {
    issues.push(`unknown kind "${String((rule as { kind: unknown }).kind)}"`);
  }
  return issues;
}

export interface RuleTestReport {
  ok: boolean;
  failures: { case: "shouldFlag" | "shouldNotFlag"; index: number }[];
  issues: string[];
}

/**
 * Runs a rule's own examples. A rule may only be approved when it has at least
 * one example of each kind and every example behaves as expected.
 */
export function testRule(rule: Rule): RuleTestReport {
  const issues = validateRule(rule);
  const failures: RuleTestReport["failures"] = [];
  const tests = rule.tests;
  if (!tests || tests.shouldFlag.length === 0 || tests.shouldNotFlag.length === 0) {
    issues.push("needs at least one shouldFlag and one shouldNotFlag example");
  }
  if (issues.length > 0 || !tests) return { ok: false, failures, issues };

  // Evaluate as if approved, in live mode, bound to each example's own action.
  const probe = new RuleSet([{ ...rule, status: "approved" }]);
  const flags = (ctx: EvalContext) =>
    probe.evaluate(ctx, "live").some((o) => o.ruleId === rule.id && o.status !== "passed");

  tests.shouldFlag.forEach((ctx, index) => {
    if (!flags(ctx)) failures.push({ case: "shouldFlag", index });
  });
  tests.shouldNotFlag.forEach((ctx, index) => {
    if (flags(ctx)) failures.push({ case: "shouldNotFlag", index });
  });
  return { ok: failures.length === 0, failures, issues };
}
