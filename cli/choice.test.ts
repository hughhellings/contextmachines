import { test } from "node:test";
import assert from "node:assert/strict";
import { intentNeeds, withoutChoices } from "../packages/scanner/src/tester/intent.ts";
import { joinUnchecked, planProblem } from "../packages/scanner/src/tester/run.ts";

const none = { kind: "none" } as const;
const judged = (claim: string) => ({ kind: "judged", claim }) as const;
const step = (title: string, intent: string, check: any = none) => ({ title, intent, check });

// Steps that only open a form and pick which way to add: never read as typing or saving.
const OPENING = [
  ["Open the add trades form", "Click the \"Add trades\" button in the main navigation and, if it offers a choice of how to add, pick the manual entry option so the trade form shows."],
  ["Open the add trade form", "Click the \"Add trades\" button in the main navigation and, if it offers choices, pick the option to enter a single trade by hand so the trade form shows."],
  ["Open the new contact form", "Click \"New contact\" and pick the option to enter a contact by hand, so the contact form shows."],
  ["Open the invoice form", "Click \"New invoice\"; if it asks how you want to add it, choose to enter it manually."],
  ["Start a new booking", "Click \"Book a table\" and, if asked which way to add the booking, pick the manual option."],
  ["Open the ticket form", "Click \"New ticket\" and choose the option for entering a ticket yourself rather than importing."],
  ["Open the recipe editor", "Click \"Add recipe\" and, if it offers a choice of how to create it, pick writing it from scratch."],
  ["Go to the new employee page", "Open \"People\", click \"Add person\" and pick the way to add one person at a time."],
  ["Open the loan form", "Click \"Lend items\" and pick the option to record a loan by hand so the form shows."],
  ["Open the patient form", "Click \"Register patient\" and, if it offers whether to import or enter details, choose to enter the details manually."],
] as const;

// Steps that really fill or save: still read as doing.
const DOING = [
  ["Add a contact", "Open the form, enter the name Test Person and save it."],
  ["Book a table", "Pick a date and enter the guest count, then save the booking."],
  ["Create an invoice", "Fill in every field the invoice form shows, then save."],
  ["Add a trade", "Pick the manual entry option, fill in every field and save the trade."],
  ["New ticket", "Choose the option to enter it by hand, then type the subject and submit it."],
  ["Log a workout", "Choose a workout type and type 30 into the minutes box, then save."],
  ["Add a recipe", "Click Add recipe, type the title, then press Save."],
  ["Register", "Choose a plan and enter your details, then submit."],
] as const;

test("opening steps that say which way to add are not read as typing or saving", () => {
  for (const [title, intent] of OPENING) {
    const n = intentNeeds(title, intent);
    assert.equal(n.fill, false, `fill: ${intent}`);
    assert.equal(n.submit, false, `submit: ${intent}`);
    // As a step with no check before a step with one, the plan is fine.
    assert.equal(planProblem([step(title, intent), step("Fill in and save", "Fill in every field the form shows, then save it.", judged("The new record shows in its list."))]), undefined, intent);
  }
});

test("steps that really fill or save still are, and still need their own check", () => {
  for (const [title, intent] of DOING) {
    const n = intentNeeds(title, intent);
    assert.ok(n.fill || n.submit, `${intent}`);
    assert.match(planProblem([step(title, intent), step("See it", "Open the list.", judged("The new record is listed."))]) ?? "", /needs a real check/, intent);
  }
});

test("withoutChoices only takes out the choosing words", () => {
  assert.equal(withoutChoices("pick the option to enter a trade by hand").includes("trade by hand"), true);
  assert.match(withoutChoices("choose the option to enter it by hand, then type the subject"), /type the subject/);
});

test("a step with no check that reads as doing is joined onto the next, keeping that step's check", () => {
  const plan = [
    step("Open the form", "Click New and fill in the name."),
    step("Save it", "Press Save.", judged("The record is saved.")),
  ];
  assert.match(planProblem(plan) ?? "", /needs a real check/);
  const joined = joinUnchecked(plan)!;
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0]!.check, plan[1]!.check);
  assert.match(joined[0]!.intent, /fill in the name\. Then: Press Save\./);
  assert.equal(planProblem(joined), undefined);
});

test("never joined when the step after has no check, or there is nothing to join", () => {
  assert.equal(joinUnchecked([step("Fill", "Fill in the name."), step("Next", "Click Next."), step("Done", "See it.", judged("Done shows."))]), undefined);
  assert.equal(joinUnchecked([step("Open", "Click Contacts."), step("Done", "See it.", judged("Contacts shows."))]), undefined);
});
