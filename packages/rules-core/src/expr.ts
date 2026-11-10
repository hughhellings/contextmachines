/**
 * A small, safe expression language for rule conditions.
 *
 * Design constraints (see docs/adr/0002-rule-expression-language.md):
 * - Pure and deterministic: same expression + same context => same result.
 * - Not Turing-complete: no loops, no functions, no I/O, bounded size.
 * - Identical behaviour in the browser and on the server (zero dependencies).
 * - No type coercion: comparisons between mismatched types are false.
 */

export type Literal = string | number | boolean | null;

export type CompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "startsWith";
export type UnaryOp = "not" | "exists" | "empty";
export type LogicalOp = "and" | "or";

export type Expr =
  | { lit: Literal | Literal[] }
  | { var: string }
  | { op: LogicalOp; args: Expr[] }
  | { op: UnaryOp; arg: Expr }
  | { op: CompareOp; left: Expr; right: Expr };

export const COMPARE_OPS: readonly CompareOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "startsWith"];
export const UNARY_OPS: readonly UnaryOp[] = ["not", "exists", "empty"];
export const LOGICAL_OPS: readonly LogicalOp[] = ["and", "or"];

export const LIMITS = { maxDepth: 24, maxNodes: 256, maxListLength: 256, maxStringLength: 1024 } as const;

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** One evaluated leaf, recorded so every decision can be explained. */
export interface TraceEntry {
  op: CompareOp | UnaryOp;
  path?: string;
  actual: unknown;
  expected?: unknown;
  result: boolean;
}

export class ExprValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid expression: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "ExprValidationError";
  }
}

/** Structural validation. Returns a list of issues; empty means valid. */
export function validateExpr(expr: unknown): string[] {
  const issues: string[] = [];
  let nodes = 0;

  const visit = (node: unknown, depth: number, at: string): void => {
    if (++nodes > LIMITS.maxNodes) {
      if (nodes === LIMITS.maxNodes + 1) issues.push(`expression exceeds ${LIMITS.maxNodes} nodes`);
      return;
    }
    if (depth > LIMITS.maxDepth) {
      issues.push(`${at}: exceeds max depth ${LIMITS.maxDepth}`);
      return;
    }
    if (!isPlainObject(node)) {
      issues.push(`${at}: node must be an object`);
      return;
    }
    const keys = Object.keys(node);

    if ("lit" in node) {
      if (keys.length !== 1) issues.push(`${at}: literal node has extra keys`);
      const v = node.lit;
      if (Array.isArray(v)) {
        if (v.length > LIMITS.maxListLength) issues.push(`${at}: list longer than ${LIMITS.maxListLength}`);
        v.forEach((item, i) => {
          if (!isLiteral(item)) issues.push(`${at}.lit[${i}]: must be a string, number, boolean or null`);
        });
      } else if (!isLiteral(v)) {
        issues.push(`${at}: literal must be a string, number, boolean, null or a list of those`);
      }
      return;
    }

    if ("var" in node) {
      if (keys.length !== 1) issues.push(`${at}: var node has extra keys`);
      const issue = validatePath(node.var);
      if (issue) issues.push(`${at}: ${issue}`);
      return;
    }

    const op = node.op;
    if (typeof op !== "string") {
      issues.push(`${at}: node must have "lit", "var" or "op"`);
      return;
    }
    if ((LOGICAL_OPS as readonly string[]).includes(op)) {
      if (!Array.isArray(node.args) || node.args.length === 0) {
        issues.push(`${at}: "${op}" needs a non-empty args list`);
        return;
      }
      if (keys.length !== 2) issues.push(`${at}: "${op}" node has extra keys`);
      node.args.forEach((a, i) => visit(a, depth + 1, `${at}.args[${i}]`));
      return;
    }
    if ((UNARY_OPS as readonly string[]).includes(op)) {
      if (keys.length !== 2 || !("arg" in node)) issues.push(`${at}: "${op}" needs exactly one "arg"`);
      visit(node.arg, depth + 1, `${at}.arg`);
      return;
    }
    if ((COMPARE_OPS as readonly string[]).includes(op)) {
      if (keys.length !== 3 || !("left" in node) || !("right" in node)) {
        issues.push(`${at}: "${op}" needs "left" and "right"`);
      }
      visit(node.left, depth + 1, `${at}.left`);
      visit(node.right, depth + 1, `${at}.right`);
      return;
    }
    issues.push(`${at}: unknown op "${op}"`);
  };

  visit(expr, 0, "$");
  return issues;
}

export function validatePath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0) return "var must be a non-empty string";
  if (path.length > 256) return "var path too long";
  for (const segment of path.split(".")) {
    if (!PATH_SEGMENT.test(segment)) return `invalid path segment "${segment}"`;
    if (FORBIDDEN_KEYS.has(segment)) return `forbidden path segment "${segment}"`;
  }
  return undefined;
}

/** Every variable path an expression reads, in order (duplicates kept). */
export function exprVarPaths(expr: Expr): string[] {
  if ("var" in expr) return [expr.var];
  if ("lit" in expr) return [];
  if ("args" in expr) return expr.args.flatMap(exprVarPaths);
  if ("arg" in expr) return exprVarPaths(expr.arg);
  return [...exprVarPaths(expr.left), ...exprVarPaths(expr.right)];
}

/** Reads a dotted path using own properties only. Missing => undefined. */
export function readPath(ctx: unknown, path: string): unknown {
  let current: unknown = ctx;
  for (const segment of path.split(".")) {
    if (FORBIDDEN_KEYS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Evaluates a validated expression. Callers must validate first (see `compileExpr`).
 * Pass a `trace` array to record evaluated leaves for explanations.
 */
export function evaluate(expr: Expr, ctx: unknown, trace?: TraceEntry[]): unknown {
  if ("lit" in expr) return expr.lit;
  if ("var" in expr) return readPath(ctx, expr.var);

  switch (expr.op) {
    case "and": {
      for (const a of expr.args) if (evaluate(a, ctx, trace) !== true) return false;
      return true;
    }
    case "or": {
      for (const a of expr.args) if (evaluate(a, ctx, trace) === true) return true;
      return false;
    }
    case "not":
      return evaluate(expr.arg, ctx, trace) !== true;
    case "exists":
    case "empty": {
      const actual = evaluate(expr.arg, ctx);
      const result = expr.op === "exists" ? actual !== undefined && actual !== null : isEmpty(actual);
      trace?.push(entry(expr.op, expr.arg, actual, undefined, result));
      return result;
    }
    default: {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      const result = compare(expr.op, left, right);
      trace?.push(entry(expr.op, expr.left, left, right, result));
      return result;
    }
  }
}

/** Validates once and returns a fast predicate. Throws ExprValidationError if invalid. */
export function compileExpr(expr: unknown): (ctx: unknown, trace?: TraceEntry[]) => boolean {
  const issues = validateExpr(expr);
  if (issues.length > 0) throw new ExprValidationError(issues);
  const valid = expr as Expr;
  return (ctx, trace) => evaluate(valid, ctx, trace) === true;
}

function compare(op: CompareOp, left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      return equals(left, right);
    case "neq":
      return !equals(left, right);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const bothNumbers = typeof left === "number" && typeof right === "number" && !Number.isNaN(left) && !Number.isNaN(right);
      const bothStrings = typeof left === "string" && typeof right === "string";
      if (!bothNumbers && !bothStrings) return false;
      const l = left as number | string;
      const r = right as number | string;
      return op === "gt" ? l > r : op === "gte" ? l >= r : op === "lt" ? l < r : l <= r;
    }
    case "in":
      return Array.isArray(right) && right.some((item) => equals(left, item));
    case "contains":
      if (typeof left === "string" && typeof right === "string") return left.includes(right);
      if (Array.isArray(left)) return left.some((item) => equals(item, right));
      return false;
    case "startsWith":
      return typeof left === "string" && typeof right === "string" && left.startsWith(right);
  }
}

function equals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equals(item, b[i]));
  }
  if (typeof a === "number" && typeof b === "number") return a === b; // NaN !== NaN by design
  return a === b && (a === null || typeof a !== "object");
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function entry(op: CompareOp | UnaryOp, subject: Expr, actual: unknown, expected: unknown, result: boolean): TraceEntry {
  const e: TraceEntry = { op, actual, result };
  if ("var" in subject) e.path = subject.var;
  if (expected !== undefined) e.expected = expected;
  return e;
}

function isLiteral(v: unknown): v is Literal {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length <= LIMITS.maxStringLength;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
