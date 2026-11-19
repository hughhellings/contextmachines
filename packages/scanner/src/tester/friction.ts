/**
 * Where a new user might get stuck: what a test run met on its way, as facts the browser measured.
 * A pop-up it had to close (a cookie banner, a dialog, a browser alert), a step that took more than
 * a few actions or a second try, a control with no accessible name it had to use, a validation error
 * the page showed, a step that waited long on the page. No AI is asked and nothing is judged: each
 * note says what happened, in plain words, and the reader decides.
 */
import type { Page } from "playwright";
import type { CachedAction, Friction, FrictionKind } from "./types.ts";

/** More actions than this in one step is noted. */
export const MANY_ACTIONS = 3;
/** More time than this waiting on the page in one step (not on the AI) is noted. */
export const SLOW_MS = 5000;

/** A control's name that closes a pop-up when it is inside one. */
const CLOSES = /^(reject( all)?|decline( all)?|accept( all)?( cookies)?|allow all|deny|close|close dialog|dismiss|no,? thanks|not now|maybe later|later|got it|ok,? got it|skip|×|✕|x|necessary only|only necessary|essential only|continue without accepting)$/i;
/** A control's name that answers a cookie banner wherever it sits (most aren't marked as dialogs). */
const COOKIE_ANSWER = /\b(reject|accept|allow|necessary|essential|decline)\b.*\bcookies?\b|\bcookies?\b.*\b(settings|preferences)\b|^(reject|accept|allow) all$|^(only|use) (necessary|essential)( cookies)?( only)?$|^(necessary|essential) only$/i;

/** Whether pressing a control with this name, with this dialog open (or none), closed a pop-up. */
export function closesPopup(name: string, dialog: string | undefined): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) return false;
  return (Boolean(dialog) && CLOSES.test(n)) || COOKIE_ANSWER.test(n);
}

/**
 * Runs in the page: the name of the dialog showing, if one is. Self-contained. A dialog's name is its
 * label, or the words of its first heading, or its first words.
 */
function dialogName(): string {
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  for (const el of document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]")) {
    if (!shown(el)) continue;
    const by = el.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\s+/).map((id) => words(document.getElementById(id))).join(" ").trim() : "";
    return (el.getAttribute("aria-label") || labelled || words(el.querySelector("h1, h2, h3, h4")) || words(el).slice(0, 40) || "a dialog").slice(0, 60);
  }
  return "";
}

/** The dialog showing on the page, by its name, or nothing. */
export async function openDialog(page: Page): Promise<string | undefined> {
  return (await page.evaluate(dialogName).catch(() => "")) || undefined;
}

/**
 * Runs in the page: the validation errors it shows. A field marked aria-invalid, with the message it
 * points to (aria-errormessage, aria-describedby); an alert inside a form. Not a page-wide alert: a
 * banner about the site isn't a form's error. Self-contained.
 */
function shownErrors(): string[] {
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const words = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const out: string[] = [];
  for (const f of document.querySelectorAll('[aria-invalid="true"]')) {
    if (!shown(f)) continue;
    const ids = `${f.getAttribute("aria-errormessage") ?? ""} ${f.getAttribute("aria-describedby") ?? ""}`.split(/\s+/).filter(Boolean);
    const said = [...new Set(ids.map((id) => words(document.getElementById(id))).filter(Boolean))].join(" ");
    const label = words((f as HTMLInputElement).labels?.[0]) || f.getAttribute("aria-label") || f.getAttribute("placeholder") || f.getAttribute("name") || "a field";
    out.push(said ? `${label.slice(0, 40)}: ${said}` : `${label.slice(0, 40)} is marked not valid`);
  }
  for (const a of document.querySelectorAll("form [role=alert], form [aria-live=assertive]")) {
    const said = words(a);
    if (said && shown(a) && !out.some((o) => o.includes(said))) out.push(said);
  }
  return out.slice(0, 6);
}

/** The validation errors the page shows now. */
export async function pageErrors(page: Page): Promise<string[]> {
  return page.evaluate(shownErrors).catch(() => [] as string[]);
}

const ROLE_WORDS: Record<string, string> = { button: "a button", link: "a link", textbox: "a text field", combobox: "a drop-down", checkbox: "a checkbox", radio: "a radio button", menuitem: "a menu item", tab: "a tab", searchbox: "a search field", switch: "a switch" };

/** What a done action used that has no accessible name ("a button"), or nothing. */
export function unnamedControl(done: CachedAction): string | undefined {
  if (done.type !== "click" && done.type !== "fill" && done.type !== "select") return undefined;
  if (done.target.name.trim()) return undefined;
  return ROLE_WORDS[done.target.role] ?? `a ${done.target.role}`;
}

/** What a person did, counted as they'd count it: the fields of one form and the press that sends it are one. */
export function interactionsOf(done: readonly CachedAction[]): number {
  let count = 0;
  let inForm = false;
  for (const a of done) {
    if (a.type === "fill" || a.type === "select" || a.type === "type") {
      if (!inForm) count++;
      inForm = true;
    } else if (inForm && (a.type === "click" || (a.type === "press" && a.key === "Enter"))) inForm = false;
    else {
      count++;
      inForm = false;
    }
  }
  return count;
}

/** The notes of one run, each said once. */
export class FrictionLog {
  readonly all: Friction[] = [];
  private readonly seen = new Set<string>();

  add(kind: FrictionKind, step: number, says: string): void {
    const key = `${kind}\n${step}\n${says}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.all.push({ kind, step, says });
  }

  /**
   * What one step's own counts say: many actions, a second try, a long wait. "Many" counts what a
   * person does, not each field: filling in one form and sending it is one thing to do.
   */
  stepEnd(step: number, facts: { actions: number; interactions?: number; retried?: string; waitedMs: number }): void {
    if ((facts.interactions ?? facts.actions) > MANY_ACTIONS) this.add("many_actions", step, `Took ${facts.actions} actions`);
    if (facts.retried) this.add("retry", step, `Needed a second try: ${facts.retried}`);
    if (facts.waitedMs > SLOW_MS) this.add("slow", step, `Waited ${(facts.waitedMs / 1000).toFixed(1)}s on the page`);
  }
}

/** "2 places a user might get stuck": how the terminal counts them. */
export const frictionCount = (n: number) => `${n} place${n === 1 ? "" : "s"} a user might get stuck`;
