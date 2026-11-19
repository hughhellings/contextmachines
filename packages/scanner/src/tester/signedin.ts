/**
 * A run that starts signed in as an account (as TesterArmy does: the test account signs in, then the
 * agent does the rest). The app has signed in before step 1, so a planned step that opens, fills or
 * submits the sign-in form looks for a form that is no longer there ("already signed in, no sign-in
 * form": the AI waits, wanders into the account menu, and says it is stuck).
 *
 * - The planner is told (signedInLine), and plans only what comes after signing in.
 * - As a guard, after planning (afterSignIn): a step only about signing in is dropped; a step that
 *   signs in and does more ("Sign in and open Patterns") keeps the rest ("Open Patterns") with its
 *   own real check, never "signed in". A later step's real check is never touched.
 * - A goal that is only "sign in" is one step, passed by the measured signed-in check alone.
 * - Never for a goal or step about being signed out, or a sign-in meant to fail (NOT_SIGNING_IN).
 *
 * Pure: no page, no AI.
 */
import { NOT_SIGNING_IN, type Check, type PlannedStep } from "./types.ts";

/** Says it signs in: "sign in", "log in", "login". Not "signed in" (a state the step may go on to look at). */
const SIGNS_IN = /\b(?:sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|login)\b/i;
/** What a sign-in types: an account's value by name, or words for one. */
const SIGN_IN_VALUE = /\{[\w-]+\.(?:username|user|email|e-mail|password|pass|otp|code|totp)\}|\b(?:password|passcode|credentials|user ?name|e-?mail(?: address)?|one-time code|verification code)\b/i;
/** A clause that carries on a sign-in already said: "submit it", "press Enter", "click Continue", "wait for it to finish". */
const CARRIES_ON = /^(?:and\s+)?(?:then\s+)?(?:submit(?:s|ting)?(?:\s+(?:it|the form|them))?|press(?:es)?\s+(?:enter|return)|(?:click|press|tap)(?:s)?\s+(?:the\s+)?["']?(?:continue|next|submit|go|ok)["']?(?:\s+button)?|wait(?:s)?\s+(?:for\s+)?(?:it|the (?:page|app|form))?\s*(?:to\s+(?:finish|load|complete|go through))?|let it (?:finish|load))\.?$/i;
/** "after signing in", "once signed in", "while logged in": a condition the run already meets. */
const ALREADY = /[\s,]*\b(?:after|once|when|while|as soon as)\s+(?:you(?:'re|\s+are|\s+have)?\s+)?(?:(?:signing|signed|logging|logged)[ -]?in|(?:sign|log)[ -]?in(?:\s+(?:is\s+)?(?:done|complete[d]?|finishes))?)\b(?:\s+as\s+[\w.@-]+)?/gi;
/** A verb that starts a new thing to do: " and open…" splits there, " email and password" doesn't. */
const VERB = "(?:then\\s+)?(?:open|opens|go|goes|click|clicks|navigate|navigates|visit|visits|check|checks|confirm|confirms|verify|verifies|see|sees|select|choose|tap|view|views|look|looks|find|finds|land|lands|browse|head|use|create|add|edit|search|scroll|make sure|ensure|switch|start|load)\\b";
/** Words that start with something to do. */
const DOES = new RegExp(`^${VERB}`, "i");
const SPLIT = new RegExp(`(\\s*[,;]\\s*|(?<!\\b(?:e\\.g|i\\.e|etc|vs|approx|incl))\\.\\s+|\\s+(?:and\\s+)?then\\s+|\\s+and\\s+(?=${VERB})|\\s+(?:in order\\s+)?to\\s+(?=${VERB}))`, "i");

/** One part of a step's words, and the words between it and the part before. */
interface Clause {
  text: string;
  /** The separator before it ("" for the first). */
  sep: string;
}

function clauses(words: string): Clause[] {
  const parts = words.split(SPLIT);
  const out: Clause[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i]!.trim();
    if (text) out.push({ text, sep: i ? parts[i - 1]! : "" });
  }
  return out;
}

const signsInClause = (c: string) => !NOT_SIGNING_IN.test(c) && (SIGNS_IN.test(c) || SIGN_IN_VALUE.test(c));

/**
 * The words with the sign-in part taken out: "Sign in and open Patterns" → "Open Patterns"; "" when
 * they are only about signing in. Words with nothing about signing in come back as they were.
 */
export function withoutSignIn(words: string): string {
  const w = words.replace(ALREADY, "").trim();
  const cs = clauses(w);
  const kept: Clause[] = [];
  let lastWasSignIn = false;
  for (const c of cs) {
    if (signsInClause(c.text)) {
      lastWasSignIn = true;
      continue;
    }
    if (lastWasSignIn && CARRIES_ON.test(c.text)) continue;
    lastWasSignIn = false;
    kept.push(c);
  }
  if (!kept.length) return "";
  const joined = kept.map((c, i) => (i === 0 ? c.text : `${c.sep}${c.text}`)).join("");
  const clean = joined.replace(/^(?:and\s+|then\s+|,\s*)+/i, "").replace(/\s{2,}/g, " ").trim();
  return clean ? clean[0]!.toUpperCase() + clean.slice(1) : "";
}

/** Whether a step is about signing in: its words, an account's values by name, or a sign-in check. */
export function signsInStep(s: Pick<PlannedStep, "title" | "intent" | "check">): boolean {
  const words = `${s.title} ${s.intent}`;
  if (NOT_SIGNING_IN.test(words)) return false;
  return SIGNS_IN.test(s.title) || /^\s*(?:sign|log)[ -]?in\b/i.test(s.intent) || (SIGNS_IN.test(s.intent) && SIGN_IN_VALUE.test(s.intent)) || /\{[\w-]+\.(?:username|password|email)\}/i.test(words) || s.check.kind === "signed_in" || s.check.kind === "password_gone";
}

/** Whether a goal asks for nothing but signing in ("Sign in", "Log in as admin", "Sign in and check you're signed in"). */
export function onlySignsIn(goal: string): boolean {
  if (NOT_SIGNING_IN.test(goal) || !SIGNS_IN.test(goal)) return false;
  const rest = withoutSignIn(goal);
  // Nothing but the sign-in itself: "Sign in", "Log in as admin", "Sign in with the test account", "Sign in to
  // the app". Never one that names somewhere to get to in the same words ("Sign in to see Patterns", "Log in
  // to the billing page"): that is more than signing in, and planned as such.
  const said = goal.replace(ALREADY, "").replace(/(?:\s*[,;]\s*|\s+)(?:and\s+)?(?:then\s+)?(?:check|confirm|verify|see|make sure|ensure)\s+(?:that\s+)?(?:you(?:'re|\s+are)\s+|it(?:'s|\s+is)\s+|i(?:'m|\s+am)\s+)?(?:signed|logged)[ -]?in\b/i, "").replace(/[\s.!]+$/, "").trim();
  const bare = /^(?:please\s+)?(?:sign|log)[ -]?in(?:\s+as\s+["']?[\w.@-]+["']?(?:\s+account)?|\s+with\s+(?:the\s+|my\s+|a\s+|your\s+|our\s+)?(?:saved\s+|test\s+)*(?:account|credentials|user|login|log-in details|details)|\s+with\s+\{[\w-]+\.\w+\}(?:\s+and\s+\{[\w-]+\.\w+\})?)*(?:\s+(?:to|on|into)\s+(?:the\s+|my\s+|your\s+)?(?:app|site|account|website|web app))?$/i;
  if (!bare.test(said)) return false;
  return !rest || /^(?:and\s+)?(?:check|confirm|verify|see|make sure|ensure)\s+(?:that\s+)?(?:you(?:'re|\s+are)\s+|it(?:'s|\s+is)\s+|i(?:'m|\s+am)\s+)?(?:signed|logged)[ -]?in\b[.!]?$/i.test(rest);
}

/** A check that only holds on the sign-in page itself ("address contains /login", "page shows Sign in"). */
export function signInPageCheck(c: Check): boolean {
  const SIGN_IN = /\b(?:log|sign)[ _-]?(?:in|on)\b|^\/?(?:login|signin|auth)\b/i;
  if (c.kind === "url_contains" || c.kind === "title_contains" || c.kind === "text_visible") return SIGN_IN.test(c.text);
  if (c.kind === "element_visible") return SIGN_IN.test(c.name);
  return false;
}

/** A check that says nothing about what a step did after signing in. */
const signInOnlyCheck = (c: Check) => c.kind === "none" || c.kind === "signed_in" || c.kind === "password_gone" || signInPageCheck(c);

/** What the planner is told when the run starts signed in as `label`. */
export function signedInLine(label: string): string {
  return `The browser is ALREADY SIGNED IN as the test account "${label}" on this site: the app signed in before the test. Plan no step to open, fill or submit the sign-in form (it isn't there any more), and no step that signs in: plan only what the goal asks for after signing in, each step with a check of what it shows. If the goal asks for nothing after signing in, plan one step titled "Signed in" whose check is that the page shows the signed-in app.`;
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * What a step that signs in does besides: undefined when its words say nothing about signing in (only its
 * check or a value's name made it look like one, so it stays as planned), "only" when it does nothing else,
 * or the rest's words. A title that only signs in ("Sign in") with words that go on to more ("…, then open
 * Settings") is the rest when its check is one of that rest (not "signed in", the sign-in page, or, with no
 * other words, an address guess for where signing in lands): a real check is never dropped with its step.
 */
function signInPart(s: PlannedStep): "only" | { title: string; intent: string; titleCut?: true } | undefined {
  const title = withoutSignIn(s.title);
  const intent = withoutSignIn(s.intent);
  const titleCut = !same(title, s.title);
  const intentCut = !same(intent, s.intent);
  if (!titleCut && !intentCut) {
    // Its words never say "sign in", but it types an account's values by name: it fills the sign-in form.
    return /\{[\w-]+\.(?:username|password|email)\}/i.test(`${s.title} ${s.intent}`) ? "only" : undefined;
  }
  if (title && titleCut) return { title, intent: intent || title, titleCut: true };
  if (titleCut) {
    // The title is only the sign-in ("Sign in"): what its other words go on to do, if anything, with a check of that.
    // Only when they go on to do something ("open Settings"), not when they say what signing in shows.
    if (!intent || signInOnlyCheck(s.check) || !DOES.test(intent)) return "only";
    return { title: intent.slice(0, 80), intent, titleCut: true };
  }
  // The title never said it ("Open Patterns", "Fill the form") and its other words sign in: the title is what
  // is left. Only signing in when its check is too; a real check stays with the title it was planned for.
  if (signInOnlyCheck(s.check)) return intent ? { title, intent } : "only";
  return { title, intent: intent || title };
}

export interface AfterSignIn {
  steps: PlannedStep[];
  /** Why planning again would help: a step whose sign-in part was taken out has no check of its own, or nothing was left. */
  problem?: string;
  /** Steps dropped or changed, said for the run's notes. */
  changed: string[];
}

/** The step a goal that only signs in becomes: measured signed in, nothing typed, no AI asked. */
export function signedInStep(label: string): PlannedStep & { assert: true } {
  return { title: "Signed in", intent: `The app signed in as ${label} before the test: check the session is signed in. Type nothing.`, check: { kind: "signed_in" }, assert: true };
}

/**
 * The plan for a run that starts signed in as `label`. A step only about signing in is dropped; a mixed
 * one keeps its other part. A kept part whose check only said "signed in" (or nothing) gets `fallback`
 * (a judged claim of what it did, or none with --measured-only) and `problem` says so, so the planner can
 * be asked once for a real check. Steps about being signed out, and every other step, are as planned.
 */
export function afterSignIn(steps: readonly PlannedStep[], goal: string, label: string, o: { measuredOnly?: boolean } = {}): AfterSignIn {
  if (NOT_SIGNING_IN.test(goal)) return { steps: [...steps], changed: [] };
  // A goal that is only "sign in": the app has signed in, and the session is measured. Nothing else to do.
  if (onlySignsIn(goal)) return { steps: [signedInStep(label)], changed: steps.length === 1 && steps[0]!.check.kind === "signed_in" && steps[0]!.title === "Signed in" ? [] : ["the goal only signs in, and the run is already signed in: one step checks the session"] };
  const out: PlannedStep[] = [];
  const changed: string[] = [];
  /** Kept parts whose check only said "signed in" (or nothing), by their place in `out`. */
  const unchecked: number[] = [];
  for (const [i, s] of steps.entries()) {
    if (!signsInStep(s)) {
      out.push(s);
      continue;
    }
    const part = signInPart(s);
    // Its words say nothing about signing in (a check after a reload that the session is still signed in):
    // it is a later step, and its check, "signed in" or not, is its own. Never weakened.
    if (!part) {
      out.push(s);
      continue;
    }
    if (part === "only") {
      // Only signing in: the app has done it. A real check it carried (words the signed-in page shows) is kept, measured, nothing typed.
      if (signInOnlyCheck(s.check) || s.check.kind === "url_contains") changed.push(`step ${i + 1} ("${s.title}") was dropped: the run is already signed in as ${label}`);
      else {
        out.push({ title: s.title, intent: `The app signed in as ${label} before the test: check what the signed-in page shows. Type nothing.`, check: s.check, assert: true } as PlannedStep);
        changed.push(`step ${i + 1} ("${s.title}") only checks the signed-in page: the run is already signed in as ${label}`);
      }
      continue;
    }
    const rest: PlannedStep = { ...s, title: part.title, intent: part.intent };
    if (signInOnlyCheck(s.check)) {
      unchecked.push(out.length);
      rest.check = { kind: "none" };
    }
    out.push(rest);
    changed.push(`step ${i + 1} ("${s.title}") became "${rest.title}": the run is already signed in as ${label}`);
  }
  if (!out.length) {
    if (onlySignsIn(goal)) return { steps: [signedInStep(label)], changed };
    // The goal asks for more than signing in, and every step only signed in.
    const rest = withoutSignIn(goal) || goal;
    return {
      steps: [{ title: rest.slice(0, 80), intent: rest, check: o.measuredOnly ? { kind: "none" } : { kind: "judged", claim: `The page shows this was done: ${rest}`.slice(0, 200) } }],
      changed,
      problem: `the browser is already signed in as "${label}", so steps that sign in can't run, and every step you planned only signs in. Plan only what the goal asks for after signing in (${rest}), each step with a check of what it shows`,
    };
  }
  // A kept part with no check of its own is fine on the way when the next step has a real one (as the
  // planner's rules allow); otherwise it gets a judged claim of what it did (none with --measured-only),
  // and the planner is asked once for a real check. Never "signed in": that proves only what the app did.
  // (The plan as planned kept to that rule, so a step left without one here is the guard's doing: a kept part, or one whose checked successor was dropped.)
  const lacking = out.flatMap((s, k) => (s.check.kind === "none" && (!out[k + 1] || out[k + 1]!.check.kind === "none") && (unchecked.includes(k) || changed.length) ? [k] : []));
  for (const k of lacking) if (!o.measuredOnly) out[k] = { ...out[k]!, check: { kind: "judged", claim: `The page shows this was done: ${out[k]!.title}`.slice(0, 200) } };
  const named = lacking.map((k) => `"${out[k]!.title}"`).join(" and ");
  return { steps: out, changed, ...(lacking.length ? { problem: `the browser is already signed in as "${label}", so no step signs in. Once the sign-in part was taken out, ${named} had only a "signed in" check (or none). Plan only what comes after signing in, and give each step a check of what it shows (the address it leads to, or words only that page shows)` } : {}) };
}

/**
 * A step that signs in and does more ("Sign in and open Settings"), as two: the sign-in, checked signed
 * in (a password_gone check stays), and the rest with the step's own check when it is a real one of that
 * (none when it only said "signed in": `unchecked` says so). Undefined for any other step.
 */
export function splitSignIn(s: PlannedStep): { signIn: PlannedStep; rest: PlannedStep; unchecked: boolean } | undefined {
  if (!signsInStep(s)) return undefined;
  const part = signInPart(s);
  // Only a step whose title says it signs in, and goes on to more ("Sign in and open Settings"; "Sign in"
  // that goes on in its words to open Settings, checked there). A title that never said it is left as planned.
  if (!part || part === "only" || !part.titleCut) return undefined;
  const { title, intent } = part;
  const signInWords = s.intent.slice(0, Math.max(0, s.intent.length - intent.length)).replace(/[\s,;]*(?:and\s+)?(?:(?:then|in order to|to)\s+)?$/i, "").trim();
  const unchecked = signInOnlyCheck(s.check);
  return {
    signIn: { title: "Sign in", intent: signInWords && s.intent.endsWith(intent.slice(1)) ? signInWords : "Sign in", check: s.check.kind === "password_gone" ? s.check : { kind: "signed_in" } },
    rest: { title, intent, check: unchecked ? { kind: "none" } : s.check },
    unchecked,
  };
}
