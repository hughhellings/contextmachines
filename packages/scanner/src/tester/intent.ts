/**
 * Intent coverage: a step whose intent says to type values and to save, submit or create can't pass
 * unless the browser really typed, and pressed something after the typing. A check that held after
 * one click on the way ("Add trade" opening a wizard that already says "Manually…") proves the step
 * got somewhere, not that it was done (the add-a-trade false pass, 2026-11-18).
 *
 * Measured with no AI, from the step's own words and the actions the browser did. The words only ever
 * add a need; nothing here passes a step. Also the goal judge's claim and what it is shown.
 */
import type { CachedAction } from "./types.ts";

export interface IntentNeeds {
  /** The intent says to type values (fill in, enter, type, input). */
  fill: boolean;
  /** The intent says to send what it made (save, submit, create, publish; add, record, log… with values to fill in). */
  submit: boolean;
}

/** Where a clause starts: the step's title, after punctuation, "and", "then", "to"… (only a verb said as something to do counts). */
const CLAUSE = String.raw`(?:^|[.,;:]\s*|\b(?:and|then|to|also|first|finally|now)\s+)`;
/**
 * Typing values, said as something to do: "fill in", "fill out", "type", "input", "write", "enter" at the start
 * of a clause, and "enter" only when it isn't going in somewhere ("enter the shop", "enter the
 * checkout"). "search for" isn't here: a search can be done by choosing a suggestion. "the file type"
 * isn't either: only the verb counts.
 */
const FILLS = new RegExp(`${CLAUSE}(?:fill(?:s|ing)?\\b(?!\\s+(?:up\\b|the\\s+(?:cart|basket)\\b))|typ(?:e|es|ing)\\b(?!\\s+of\\b)|input(?:s|ting)?\\b|writ(?:e|es|ing)\\b(?!\\s+(?:to|down)\\b)|enter(?:s|ing)?\\b(?!\\s+(?:the\\s+|a\\s+|an\\s+|your\\s+|my\\s+)?(?:site|store|shop|app|page|area|section|room|website|portal|dashboard|lobby|game|competition|draw|contest|full\\s?screen|checkout|cart|basket|bag|chat|meeting|call)\\b))`, "i");
/**
 * Sending what was made, said as something to do at the start of a clause ("save it", "and submit",
 * "to create"): never a word in a name ("the Save 20% banner", "Click Create to open…") or a
 * description ("it saves automatically").
 */
const SUBMITS = new RegExp(`${CLAUSE}(?:save|submit|create|publish|post|send|register)(?:s|ing)?\\b`, "i");
/**
 * A save the words name as a button to press: "press Save", "click the save or add button", "hit Submit".
 */
const PRESS_SAVE = /\b(?:press|click|tap|hit|use)(?:es|s|ing)?\s+(?:on\s+)?(?:the\s+|its\s+)?['"“‘]?(?:save|submit)\b/i;
/**
 * The same with values to fill in: adding, recording, logging, placing, booking or confirming an entry
 * the step types is sending it ("Add a manual trade: fill in any entry and click Add"). Without typing,
 * "Add both items to the basket" is a click like any other.
 */
const SUBMITS_WITH_VALUES = new RegExp(`${CLAUSE}(?:add|record|log(?!\\s*(?:in|on|out|off)\\b)|place|book|confirm)(?:s|ing|ed)?\\b|\\b(?:press|click|tap|hit)(?:es|s|ing)?\\s+(?:on\\s+)?(?:the\\s+)?['"“‘]?(?:add|create|record|log|confirm|done|ok|apply|update)\\b`, "i");
/** "the save or add button", "press Create": a control named with a sending verb. */
const SEND_NAME = /\b(save|submit|add|create|publish|post|send|confirm|place|register|done|finish|ok|apply|update|continue|next|sign\s?up|log\s?in|sign\s?in|book|enter|go|record|log)\b/i;
/** A control that can only be a save or submit: a failed press of one is "it tried to save and couldn't". */
const SAVE_NAME = /\b(save|submit|add|create|publish|post|send|confirm|place|register|book|record|log(?!\s?(?:in|out)))\b/i;
/** Signing in, said in a step: its clauses are the sign-in's own, with their own rules. */
const SIGN_IN_WORDS = /\b(?:sign|log)[ -]?(?:in|on)\b|\blogin\b|\bpassword\b|\bpasscode\b|\bcredentials?\b|\busername\b|\b(?:e-?mail|email address)\b(?!\s+(?:list|newsletter))/i;

/** A step's words without the clauses about signing in ("Sign in and add a trade" → "add a trade"). */
export function withoutSignIn(words: string): string {
  return words
    .split(/[.,;:]+|\b(?:and then|and|then)\b/i)
    .map((c) => c.trim())
    .filter((c) => c && !SIGN_IN_WORDS.test(c))
    .join(". ");
}

/**
 * Words that only say which way or option to pick, not something to do now: "a choice of how to add",
 * "the option to enter a contact by hand", "choose to enter it manually", "pick how you want to add it".
 * The verb after them names an option ("Enter by hand", "Add manually"), so it is left out. Anything
 * the step really does is said apart from them ("…, then fill in the name and save") and still counts.
 */
const CHOICE = /\b(?:(?:a\s+|the\s+)?choice\s+(?:of\s+)?|(?:the\s+|an?\s+)?(?:option|way|method)s?\s+|asks?\s+|offers?\s+)?(?:how|which\s+way|whether)\s+(?:you\s+(?:want|would\s+like)\s+)?to\s+(?:add|enter|create|record|log|type|input|fill(?:\s+in)?)\b|\b(?:the\s+|an?\s+)?(?:option|choice|way|method|path)s?\s+(?:to|for)\s+(?:add|enter|create|record|log|type|input)(?:ing)?\b|\b(?:choos(?:e|es|ing)|pick(?:s|ing)?|select(?:s|ing)?|opt(?:s|ing)?)\s+(?:to\s+)?(?:add|enter|create|type|input)(?:ing)?\b(?=[^.,;]{0,60}\b(?:by\s+hand|manually|yourself|one\s+at\s+a\s+time)\b)/gi;
export const withoutChoices = (words: string) => words.replace(CHOICE, " ");

/** What the step's words say it must do. A sign-in or a person's Assert step is the caller's to leave out. */
export function intentNeeds(title: string, intent: string): IntentNeeds {
  const words = withoutChoices(`${title.trim()}. ${intent.trim()}`);
  const fill = FILLS.test(words);
  return { fill, submit: SUBMITS.test(words) || PRESS_SAVE.test(words) || (fill && SUBMITS_WITH_VALUES.test(words)) };
}

/**
 * A goal that asks for something to be made or changed on the site ("can we add a trade", "save a
 * note", "change my name"): the goal judge looks at where such a run ended. Adding to a basket, a bag or
 * a wishlist isn't one (it is measured like any click). `saves`: one that asks for a new entry to be
 * added, saved, created or sent, which a plan must have a step for.
 */
const NOT_A_RECORD = /\badd(?:s|ing|ed)?\b[^.,;]{0,40}?\b(?:to|into|in)\s+(?:the\s+|my\s+|your\s+|a\s+)?(?:cart|basket|bag|trolley|wish\s?list|favou?rites|compare|comparison)\b/gi;
const GOAL_SAVES = /\b(?:add|save|submit|create|post|publish|send|record|register|log(?!\s*(?:in|on|out|off)\b))(?:s|es|ing|ed)?\b/i;
// W4: the widget verbs' goals change something too: a card moved or dragged, a row marked, starred or
// made a favourite, a thing pinned, assigned or attached, a switch turned on, a slider set to a number.
const GOAL_CHANGES = /\b(?:change|update|edit|rename|delete|remove|archive|upload|subscribe|invite|book|set\s+up|cancel|move|drag|mark|star|favou?rite|pin|assign|attach|toggle|enable|disable)(?:s|es|ing|ed|d|red|ped)?\b|\bturn(?:s|ed|ing)?\s+(?:it\s+|them\s+)?(?:on|off)\b|\bset(?:s|ting)?\b[^.;]{0,40}\bto\s+\d/i;
export function goalAsks(goal: string): { saves: boolean; changes: boolean } {
  const g = withoutSignIn(goal.replace(NOT_A_RECORD, " "));
  const saves = GOAL_SAVES.test(g);
  return { saves, changes: saves || GOAL_CHANGES.test(g) };
}

/**
 * What counts as giving a value: typing one, choosing one from a list, ticking a box or choosing a
 * radio (a form of pickers and checkboxes is filled in without a key pressed).
 */
// W4: a file given (upload) and a slider set (slide) are values given too.
const TYPED = new Set(["fill", "type", "select", "check", "uncheck", "upload", "slide"]);
const CHOOSING = /^(radio|checkbox|switch|option|menuitemradio|menuitemcheckbox)$/i;
const PRESSED = new Set(["click", "dblclick"]);
type AnyAction = { type: string; key?: string; target?: { role?: string; name?: string } };

/** A value given (typed, chosen or ticked). */
export function gives(a: AnyAction): boolean {
  return TYPED.has(a.type) || (PRESSED.has(a.type) && CHOOSING.test(a.target?.role ?? ""));
}

/** Enter (or Ctrl/Cmd+Enter) pressed: what sends a form from a field. */
export const entersKey = (key: string | undefined) => /^(?:(?:Control|Ctrl|Meta|Cmd|Command)\+)?(?:Enter|NumpadEnter)$/i.test(key ?? "");

/** An action that could send a form: a click or double click, or Enter pressed (in a field). */
export function sends(a: AnyAction): boolean {
  return PRESSED.has(a.type) || (a.type === "press" && entersKey(a.key));
}

/** A control's name that reads like a save or submit ("Save trade", "Create account", "Add", "OK"). */
export const sendName = (name: string) => SEND_NAME.test(name);

/**
 * A press that saves: Enter in a field, or a click on a control named like a save ("Save trade",
 * "Add", "OK"). A click on a suggestion, a tab, a toggle or "Upload file" after the typing isn't one.
 */
export function savePress(a: AnyAction): boolean {
  if (a.type === "press") return entersKey(a.key);
  return PRESSED.has(a.type) && !CHOOSING.test(a.target?.role ?? "") && sendName(a.target?.name ?? "");
}

export interface Shortfall {
  /** In a person's words, for the step's reason. */
  why: string;
  /** A save-like control was tried and couldn't be pressed: the step is a FAIL that says so. */
  tried: boolean;
}

const nameOf = (a: { target?: { name?: string } }) => a.target?.name ?? "";

/**
 * What the intent needs that the actions don't show, or nothing. `done`: the step's actions that
 * worked, in order. `failed`: the ones the browser tried and that didn't work. With typing needed, the
 * save must come after the last value typed: a click before it ("Add trade") opened the form, it
 * didn't send it.
 */
export function intentShortfall(needs: IntentNeeds, done: readonly CachedAction[], failed: readonly CachedAction[] = []): Shortfall | undefined {
  if (!needs.fill && !needs.submit) return undefined;
  const lastTyped = done.reduce((k, a, i) => (gives(a as AnyAction) ? i : k), -1);
  // Tried and couldn't: only a control that can be nothing but a save ("Save trade", not "Continue").
  const triedSave = failed.find((a) => sends(a as AnyAction) && SAVE_NAME.test(nameOf(a as { target?: { name?: string } })));
  const tried = triedSave ? nameOf(triedSave as { target?: { name?: string } }) : "";
  if (needs.fill && lastTyped < 0) {
    if (needs.submit && triedSave) return { why: `its intent says to fill in values and save, and nothing was typed: '${tried}' couldn't be pressed`, tried: true };
    return { why: `its intent says to fill in values${needs.submit ? " and save or submit them" : ""}, and nothing was typed`, tried: false };
  }
  if (needs.submit) {
    const after = done.slice(lastTyped + 1);
    if (!after.some((a) => savePress(a as AnyAction))) {
      if (triedSave) return { why: `never pressed '${tried}': it was tried and couldn't be pressed`, tried: true };
      return { why: needs.fill ? "its intent says to save or submit what it filled in, and no save or submit button was pressed after the typing" : "its intent says to save or submit, and no save or submit button was pressed", tried: false };
    }
  }
  return undefined;
}

/** What the actor is told once when it says done (or the check holds) before the intent is done. */
export const shortfallProblem = (why: string) => `Not finished: ${why.replace(/^its intent/, "this step's intent")}; that hasn't been done yet. Do it now (made-up test values are fine where none are given), or say stuck.`;

/** The goal judge's claim: the goal, achieved, as the final page and what the browser did show it. */
export const goalJudgeClaim = (goal: string) => `This test's goal was achieved: "${goal.replace(/\s+/g, " ").trim()}"`;
