import { describe, expect, it } from "vitest";
import { RuleSet, testRule, type DeterministicRule, type EvalContext, type ModelRule } from "../src/index.ts";

const publish = (fields: EvalContext["fields"]): EvalContext => ({ action: { id: "assessment.publish" }, fields });

const rubricRequired: DeterministicRule = {
  id: "R4_rubric_required",
  version: 1,
  kind: "deterministic",
  bindsTo: { actions: ["assessment.publish"] },
  when: { op: "or", args: [{ op: "not", arg: { op: "exists", arg: { var: "fields.rubric" } } }, { op: "eq", left: { var: "fields.rubric.empty" }, right: { lit: true } }] },
  action: "nudge",
  message: "This assessment has no rubric. Add one before publishing?",
  status: "approved",
  tests: {
    shouldFlag: [publish({}), publish({ rubric: { type: "string", empty: true } })],
    shouldNotFlag: [publish({ rubric: { type: "string", empty: false, length: 400 } })],
  },
};

describe("RuleSet", () => {
  it("flags a violation with evidence and only for bound actions", () => {
    const set = new RuleSet([rubricRequired]);
    const [outcome] = set.evaluate(publish({ rubric: { type: "string", empty: true } }), "live");
    expect(outcome).toMatchObject({ ruleId: "R4_rubric_required", status: "violated", effectiveAction: "nudge" });
    expect(outcome?.evidence).toContainEqual({ op: "eq", path: "fields.rubric.empty", actual: true, expected: true, result: true });
    expect(set.evaluate({ action: { id: "assessment.create" } }, "live")).toEqual([]);
  });

  it("downgrades every action to observe in shadow mode", () => {
    const set = new RuleSet([{ ...rubricRequired, action: "block" }]);
    const [outcome] = set.evaluate(publish({}), "shadow");
    expect(outcome).toMatchObject({ status: "violated", configuredAction: "block", effectiveAction: "observe" });
  });

  it("ignores drafts and disabled rules", () => {
    const set = new RuleSet([{ ...rubricRequired, status: "draft" }, { ...rubricRequired, id: "other", status: "disabled" }]);
    expect(set.size).toBe(0);
  });

  it("rejects invalid rules individually without affecting valid ones", () => {
    const broken = { ...rubricRequired, id: "broken", when: { op: "exec", args: [] } } as unknown as DeterministicRule;
    const set = new RuleSet([broken, rubricRequired, { ...rubricRequired }]);
    expect(set.rejected.map((r) => r.ruleId)).toEqual(["broken", "R4_rubric_required"]); // second is a duplicate id
    expect(set.size).toBe(1);
  });

  it("routes model rules to the server via needs_model, with a cheap pre-filter", () => {
    const clarity: ModelRule = {
      id: "R9_ai_policy_clear",
      version: 2,
      kind: "model",
      instruction: "Do the instructions clearly state whether generative AI may be used?",
      when: { op: "eq", left: { var: "fields.instructions.empty" }, right: { lit: false } },
      bindsTo: { actions: ["assessment.publish"] },
      action: "nudge",
      message: "Make the AI-use policy explicit.",
      status: "approved",
    };
    const set = new RuleSet([clarity]);
    expect(set.evaluate(publish({ instructions: { type: "string", empty: false, length: 900 } }), "live")[0]?.status).toBe("needs_model");
    expect(set.evaluate(publish({ instructions: { type: "string", empty: true } }), "live")[0]?.status).toBe("passed");
  });
});

describe("testRule (approval gate)", () => {
  it("passes when every example behaves", () => {
    expect(testRule(rubricRequired)).toEqual({ ok: true, failures: [], issues: [] });
  });

  it("reports failing examples", () => {
    const wrong = { ...rubricRequired, tests: { shouldFlag: [publish({ rubric: { type: "string" as const, empty: false } })], shouldNotFlag: [publish({})] } };
    const report = testRule(wrong);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([
      { case: "shouldFlag", index: 0 },
      { case: "shouldNotFlag", index: 0 },
    ]);
  });

  it("refuses rules without both kinds of example", () => {
    const { tests: _omit, ...noTests } = rubricRequired;
    expect(testRule(noTests).ok).toBe(false);
    expect(testRule(noTests).issues.join()).toMatch(/shouldFlag/);
  });
});
