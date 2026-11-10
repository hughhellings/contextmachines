/** An example expense app's rules, checked against shapes the snippet produces from real insert bodies. */
import { RuleSet, testRule, type Rule } from "@contextmachines/rules-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeFields } from "@contextmachines/snippet/capture";

const [tenant] = JSON.parse(readFileSync(new URL("./fixtures/expense-rules.json", import.meta.url), "utf8")) as [{ rules: Rule[]; allowValues: string[] }];
const set = new RuleSet(tenant.rules);
const allow = new Set(tenant.allowValues);
const flagged = (body: unknown) => set.evaluate({ action: { id: "expense.create" }, fields: describeFields(body, allow) }, "live").filter((o) => o.status === "violated").map((o) => o.ruleId);

// A refund (a negative amount) with everything filled in.
const good = { merchant: "Corner Cafe", amount: "-42.10", receipt_id: 1071, category_id: "c1", tags: ["travel"], notes: "<p>Returned the train ticket</p>" };

describe("expense app rules", () => {
  it("all rules are valid", () => {
    expect(set.rejected).toEqual([]);
    expect(set.size).toBe(3);
  });

  it("a complete expense passes", () => {
    expect(flagged([good])).toEqual([]);
  });

  it("flags a missing receipt, a missing category and an unexplained refund", () => {
    expect(flagged([{ ...good, receipt_id: null }])).toEqual(["EX1_receipt_missing"]);
    expect(flagged([{ ...good, category_id: null, tags: [] }])).toEqual(["EX2_category_missing"]);
    expect(flagged([{ ...good, notes: "" }])).toEqual(["EX3_refund_without_note"]);
    expect(flagged([{ ...good, amount: "18.40", notes: "" }])).toEqual([]); // ordinary spending doesn't need a note
    expect(flagged([{ ...good, amount: -5, notes: "" }])).toEqual(["EX3_refund_without_note"]);
  });

  it("never nudges on bulk imports", () => {
    expect(flagged([{ ...good, receipt_id: null }, { ...good, receipt_id: null }])).toEqual([]);
  });

  it("only the amount's value is ever sent, never the merchant or notes", () => {
    const fields = describeFields([good], allow);
    expect(fields.amount?.value).toBe("-42.10");
    expect(fields.merchant?.value).toBeUndefined();
    expect(fields.notes?.value).toBeUndefined();
  });

  it("each rule passes its own approval tests", () => {
    for (const rule of tenant.rules) {
      const withTests = { ...rule, tests: { shouldFlag: [{ action: { id: "expense.create" }, fields: {} }], shouldNotFlag: [{ action: { id: "expense.create" }, fields: describeFields([good], allow) }] } };
      expect(testRule(withTests).failures).toEqual(rule.id === "EX3_refund_without_note" ? [{ case: "shouldFlag", index: 0 }] : []);
    }
  });
});
