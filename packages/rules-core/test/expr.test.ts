import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileExpr, evaluate, ExprValidationError, LIMITS, readPath, validateExpr, type Expr, type TraceEntry } from "../src/index.ts";

const v = (path: string): Expr => ({ var: path });
const lit = (value: string | number | boolean | null | (string | number | boolean | null)[]): Expr => ({ lit: value });

describe("comparisons", () => {
  const ctx = { n: 5, s: "hello", b: true, list: ["a", "b"], nul: null };

  it.each<[Expr, boolean]>([
    [{ op: "eq", left: v("n"), right: lit(5) }, true],
    [{ op: "eq", left: v("n"), right: lit("5") }, false], // no coercion
    [{ op: "neq", left: v("s"), right: lit("bye") }, true],
    [{ op: "gt", left: v("n"), right: lit(4) }, true],
    [{ op: "gt", left: v("n"), right: lit("4") }, false], // mismatched types are false
    [{ op: "lte", left: v("s"), right: lit("hello") }, true],
    [{ op: "in", left: v("s"), right: lit(["x", "hello"]) }, true],
    [{ op: "in", left: v("s"), right: lit("hello") }, false],
    [{ op: "contains", left: v("s"), right: lit("ell") }, true],
    [{ op: "contains", left: v("list"), right: lit("b") }, true],
    [{ op: "startsWith", left: v("s"), right: lit("he") }, true],
    [{ op: "eq", left: v("nul"), right: lit(null) }, true],
    [{ op: "eq", left: v("missing"), right: lit(null) }, false], // undefined is not null
    [{ op: "eq", left: v("list"), right: lit(["a", "b"]) }, true],
  ])("%j => %s", (expr, expected) => {
    expect(compileExpr(expr)(ctx)).toBe(expected);
  });

  it("treats NaN as never equal or ordered", () => {
    const expr: Expr = { op: "gte", left: v("x"), right: lit(0) };
    expect(evaluate(expr, { x: Number.NaN })).toBe(false);
  });
});

describe("logic and unary", () => {
  it("and / or short-circuit and require strict booleans", () => {
    expect(compileExpr({ op: "and", args: [lit(true), lit(1)] })({})).toBe(false);
    expect(compileExpr({ op: "or", args: [lit("yes"), lit(true)] })({})).toBe(true);
  });

  it("exists / empty / not", () => {
    const ctx = { a: "", b: [], c: {}, d: 0, e: "x" };
    expect(compileExpr({ op: "empty", arg: v("a") })(ctx)).toBe(true);
    expect(compileExpr({ op: "empty", arg: v("b") })(ctx)).toBe(true);
    expect(compileExpr({ op: "empty", arg: v("c") })(ctx)).toBe(true);
    expect(compileExpr({ op: "empty", arg: v("d") })(ctx)).toBe(false);
    expect(compileExpr({ op: "empty", arg: v("nope") })(ctx)).toBe(true);
    expect(compileExpr({ op: "exists", arg: v("d") })(ctx)).toBe(true);
    expect(compileExpr({ op: "not", arg: { op: "exists", arg: v("nope") } })(ctx)).toBe(true);
  });
});

describe("path safety", () => {
  it("reads own properties and array indexes only", () => {
    expect(readPath({ a: { b: [10, 20] } }, "a.b.1")).toBe(20);
    expect(readPath({ a: [1] }, "a.length")).toBeUndefined();
    expect(readPath({}, "toString")).toBeUndefined();
    expect(readPath(Object.create({ inherited: 1 }), "inherited")).toBeUndefined();
  });

  it("rejects prototype-pollution paths at validation", () => {
    expect(validateExpr({ var: "__proto__.x" })).not.toHaveLength(0);
    expect(validateExpr({ var: "a.constructor" })).not.toHaveLength(0);
    expect(validateExpr({ var: "a..b" })).not.toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects unknown ops, extra keys and bad literals", () => {
    expect(validateExpr({ op: "eval", args: [] })).not.toHaveLength(0);
    expect(validateExpr({ lit: 1, extra: true })).not.toHaveLength(0);
    expect(validateExpr({ lit: { nested: 1 } })).not.toHaveLength(0);
    expect(validateExpr({ lit: Number.POSITIVE_INFINITY })).not.toHaveLength(0);
    expect(validateExpr({ op: "and", args: [] })).not.toHaveLength(0);
    expect(validateExpr({ op: "eq", left: lit(1) })).not.toHaveLength(0);
  });

  it("enforces depth and node limits", () => {
    let deep: Expr = lit(true);
    for (let i = 0; i <= LIMITS.maxDepth; i++) deep = { op: "not", arg: deep };
    expect(validateExpr(deep).join()).toMatch(/max depth/);

    const wide: Expr = { op: "and", args: Array.from({ length: LIMITS.maxNodes }, () => lit(true)) };
    expect(validateExpr(wide).join()).toMatch(/nodes/);
  });

  it("compileExpr throws a typed error for invalid input", () => {
    expect(() => compileExpr({ op: "nope" })).toThrow(ExprValidationError);
  });
});

describe("trace", () => {
  it("records evaluated leaves with paths for explanations", () => {
    const trace: TraceEntry[] = [];
    compileExpr({
      op: "and",
      args: [
        { op: "eq", left: v("action"), right: lit("publish") },
        { op: "empty", arg: v("rubric") },
      ],
    })({ action: "publish" }, trace);
    expect(trace).toEqual([
      { op: "eq", path: "action", actual: "publish", expected: "publish", result: true },
      { op: "empty", path: "rubric", actual: undefined, result: true },
    ]);
  });
});

// Property tests: any valid expression over any JSON context evaluates without
// throwing, returns a boolean from compileExpr, and is deterministic.
const literalArb = fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null));
const pathArb = fc.constantFrom("a", "b", "a.b", "list", "list.0", "n");
const { expr: exprArb } = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: "small" },
    literalArb.map((l) => ({ lit: l })),
    pathArb.map((p) => ({ var: p })),
    fc.record({ op: fc.constantFrom("and" as const, "or" as const), args: fc.array(tie("expr"), { minLength: 1, maxLength: 3 }) }),
    fc.record({ op: fc.constantFrom("not" as const, "exists" as const, "empty" as const), arg: tie("expr") }),
    fc.record({
      op: fc.constantFrom("eq" as const, "neq" as const, "gt" as const, "lt" as const, "in" as const, "contains" as const, "startsWith" as const),
      left: tie("expr"),
      right: tie("expr"),
    }),
  ),
}));

describe("properties", () => {
  it("never throws, always boolean, deterministic", () => {
    fc.assert(
      fc.property(exprArb, fc.jsonValue(), (expr, ctx) => {
        fc.pre(validateExpr(expr).length === 0);
        const predicate = compileExpr(expr);
        const first = predicate(ctx);
        expect(typeof first).toBe("boolean");
        expect(predicate(structuredClone(ctx))).toBe(first);
      }),
      { numRuns: 500 },
    );
  });
});
