import { describe, expect, it } from "vitest";
import { EventBatchSchema, LIMITS, RuleSchema } from "../src/index.ts";

const batch = {
  v: 1 as const,
  key: "pk_test_fixturekey",
  sessionId: "sess_12345678",
  sentAt: 1_700_000_000_000,
  events: [
    { t: 1, kind: "route" as const, path: "/assessments/:id" },
    { t: 2, kind: "network" as const, method: "POST", path: "/api/assessments/:id/publish", queryKeys: [], fields: { rubric: { type: "string" as const, empty: true } }, status: 200 },
  ],
};

describe("EventBatchSchema", () => {
  it("accepts a well-formed batch", () => {
    expect(EventBatchSchema.safeParse(batch).success).toBe(true);
  });

  it("rejects unknown keys (strict contracts)", () => {
    expect(EventBatchSchema.safeParse({ ...batch, extra: 1 }).success).toBe(false);
    expect(EventBatchSchema.safeParse({ ...batch, events: [{ ...batch.events[0], rawHtml: "<p>" }] }).success).toBe(false);
  });

  it("rejects oversized batches and bad keys", () => {
    const events = Array.from({ length: LIMITS.maxEventsPerBatch + 1 }, (_, t) => ({ t, kind: "route" as const, path: "/" }));
    expect(EventBatchSchema.safeParse({ ...batch, events }).success).toBe(false);
    expect(EventBatchSchema.safeParse({ ...batch, key: "sk_live_fakekey" }).success).toBe(false);
  });
});

describe("RuleSchema", () => {
  const rule = {
    id: "R4_rubric_required",
    version: 1,
    kind: "deterministic",
    bindsTo: { actions: ["assessment.publish"] },
    when: { op: "empty", arg: { var: "fields.rubric" } },
    action: "nudge",
    message: "Add a rubric before publishing.",
    status: "approved",
  };

  it("accepts a valid rule", () => {
    expect(RuleSchema.safeParse(rule).success).toBe(true);
  });

  it("rejects rules whose expression is unsafe", () => {
    expect(RuleSchema.safeParse({ ...rule, when: { var: "__proto__" } }).success).toBe(false);
    expect(RuleSchema.safeParse({ ...rule, when: { op: "exec" } }).success).toBe(false);
  });

  it("requires an instruction for model rules", () => {
    expect(RuleSchema.safeParse({ ...rule, kind: "model", when: undefined }).success).toBe(false);
  });
});
