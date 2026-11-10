import { compileExpr, exprVarPaths, validateExpr, type Expr, type TraceEntry } from "@contextmachines/rules-core";
import { ExprSchema } from "@contextmachines/schemas";
import { z } from "zod";
import type { Finding } from "./discovery.ts";

/**
 * A goal is one thing that gets a user more value from the product, e.g.
 * "tag 10 invoices with a client" or "open Reports". The account defines them;
 * the engine decides when one is worth suggesting to a particular user.
 *
 * Conditions use the rule expression language over the progress context
 * (see progress.ts): user.*, actions.<key>.*, pages.<key>.*, moment.*.
 */
export interface Goal {
  id: string;
  version: number;
  status: "draft" | "approved" | "disabled";
  title: string;
  /** What we would say. Display is decided later; this is the content. */
  message: string;
  /** Why it matters to the user (shown on "Why?", and in reports). */
  why?: string;
  /** Achieved when true. Required. */
  done: Expr;
  /** Worth suggesting only when true (e.g. "has sent at least 5 invoices"). Default: always. */
  eligible?: Expr;
  /** Suggest only in this moment (e.g. "is on the invoices page"). Default: any moment. */
  when?: Expr;
  /** Where the user would go to do it: a page path and/or an action id from the site model. */
  target?: { page?: string; action?: string };
  /** 1–100. Higher wins when several goals qualify. */
  priority: number;
  /** Minimum hours before suggesting the same goal to the same user again. */
  cooldownHours: number;
  /** Stop suggesting this goal to a user after this many times (per period, for recurring goals). */
  maxSuggestions: number;
  /**
   * Recurring goals (habits) re-open `everyDays` after each achievement. Their
   * conditions can read `period.actions.<key>.count` / `period.pages.<key>.count`:
   * activity since the last achievement (or ever, before the first).
   */
  recurrence?: { everyDays: number };
  /** Examples that must hold before approval. */
  tests?: { done: unknown[]; notDone: unknown[] };
  /**
   * Where the goal came from. Only "customer" goals (written, or promoted and
   * approved by the site's owner) can ever be shown to users; the rest run in log mode.
   *  - lifecycle: inferred from site structure (setup / activation / habit / depth)
   *  - model: proposed by the goal agent from the site map
   *  - discovered: found in usage data
   */
  origin?: "customer" | "lifecycle" | "model" | "discovered";
  stage?: "setup" | "activation" | "habit" | "depth" | "feature";
  /** How sure we are that achieving this goal matters (see confidence ladder in docs). */
  confidence?: Confidence;
  /** The structural reason a non-data goal exists. */
  basis?: string;
  /** Usage evidence, when any. */
  evidence?: Finding["evidence"] & { adoption: number };
}

/** hypothesis → plausible → supported → proven → causal; not_supported when data argues against it. */
export type Confidence = "hypothesis" | "plausible" | "supported" | "proven" | "causal" | "not_supported";

const GOAL_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export const GoalInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
  why: z.string().trim().max(500).optional(),
  done: ExprSchema,
  eligible: ExprSchema.optional(),
  when: ExprSchema.optional(),
  target: z.strictObject({ page: z.string().startsWith("/").max(512).optional(), action: z.string().max(128).optional() }).optional(),
  priority: z.number().int().min(1).max(100).default(50),
  cooldownHours: z.number().min(1).max(24 * 90).default(72),
  maxSuggestions: z.number().int().min(1).max(20).default(3),
  tests: z.strictObject({ done: z.array(z.record(z.string(), z.unknown())).max(20), notDone: z.array(z.record(z.string(), z.unknown())).max(20) }).optional(),
  recurrence: z.strictObject({ everyDays: z.number().int().min(1).max(90) }).optional(),
});
export type GoalInput = z.infer<typeof GoalInputSchema>;

export function isGoalId(id: string): boolean {
  return GOAL_ID.test(id);
}

export interface GoalTestReport {
  ok: boolean;
  issues: string[];
  failures: { case: "done" | "notDone"; index: number }[];
}

/** A goal may be approved only with at least one example of each kind, all behaving as expected. */
export function testGoal(goal: Goal): GoalTestReport {
  const issues: string[] = [];
  for (const [name, expr] of [["done", goal.done], ["eligible", goal.eligible], ["when", goal.when]] as const) {
    if (expr !== undefined) issues.push(...validateExpr(expr).map((i) => `${name} ${i}`));
  }
  const usesPeriod = [goal.done, goal.eligible, goal.when].some((e) => e !== undefined && exprVarPaths(e).some((p) => p.startsWith("period.")));
  if (usesPeriod && !goal.recurrence) issues.push("period.* can only be used by recurring goals (set recurrence.everyDays)");
  const tests = goal.tests;
  if (!tests || tests.done.length === 0 || tests.notDone.length === 0) issues.push("needs at least one 'done' and one 'notDone' example");
  const failures: GoalTestReport["failures"] = [];
  if (issues.length > 0 || !tests) return { ok: false, issues, failures };
  const isDone = compileExpr(goal.done);
  tests.done.forEach((ctx, index) => {
    if (!isDone(ctx)) failures.push({ case: "done", index });
  });
  tests.notDone.forEach((ctx, index) => {
    if (isDone(ctx)) failures.push({ case: "notDone", index });
  });
  return { ok: failures.length === 0, issues, failures };
}

export interface CompiledGoal {
  goal: Goal;
  /** period.actions/pages keys this goal reads, so their counts can be snapshotted at each achievement. */
  periodKeys: { actions: string[]; pages: string[] };
  done: (ctx: unknown, trace?: TraceEntry[]) => boolean;
  eligible: (ctx: unknown, trace?: TraceEntry[]) => boolean;
  when: (ctx: unknown, trace?: TraceEntry[]) => boolean;
}

const ALWAYS = () => true;

export function compileGoal(goal: Goal): CompiledGoal {
  const paths = [goal.done, goal.eligible, goal.when].flatMap((e) => (e ? exprVarPaths(e) : []));
  const keysOf = (root: string) => [...new Set(paths.filter((p) => p.startsWith(`period.${root}.`)).map((p) => p.split(".")[2] as string))];
  return {
    goal,
    periodKeys: { actions: keysOf("actions"), pages: keysOf("pages") },
    done: compileExpr(goal.done),
    eligible: goal.eligible ? compileExpr(goal.eligible) : ALWAYS,
    when: goal.when ? compileExpr(goal.when) : ALWAYS,
  };
}
