import { INTENT } from "./body.ts";
import { isOwnUi } from "./own.ts";
import { controlLabel, fieldLabel } from "./page.ts";
import { run } from "./safe.ts";

const CLICKABLE = 'button, a[href], [role="button"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"]';

export interface RouteChange {
  url: string;
}

export interface Interaction {
  /** "change": a choice made in a list, a checkbox or a switch, which many apps save at once. */
  type: "click" | "submit" | "change";
  tag: string;
  role?: string;
  label?: string;
}

/** Tracks SPA navigation (pushState/replaceState/popstate) as well as the initial load. */
export function installRouteCapture(win: Window & typeof globalThis, onRoute: (r: RouteChange) => void): () => void {
  const history = win.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  let last = "";

  const emit = () =>
    run(() => {
      const url = win.location.href;
      if (url === last) return;
      last = url;
      onRoute({ url });
    });

  const push: History["pushState"] = function (this: History, ...args) {
    const result = originalPush.apply(this, args);
    emit();
    return result;
  };
  const replace: History["replaceState"] = function (this: History, ...args) {
    const result = originalReplace.apply(this, args);
    emit();
    return result;
  };
  history.pushState = push;
  history.replaceState = replace;
  win.addEventListener("popstate", emit);
  emit();

  return () => {
    if (history.pushState === push) history.pushState = originalPush;
    if (history.replaceState === replace) history.replaceState = originalReplace;
    win.removeEventListener("popstate", emit);
  };
}

/** Records what users click and submit, by accessible label only (scrubbed, truncated). */
export function installInteractionCapture(doc: Document, onInteraction: (i: Interaction, button?: Element) => void, ignoreRoot?: () => Element | null): () => void {
  const onClick = (event: Event) =>
    run(() => {
      // The real button, even inside a web component's open shadow root.
      const first = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
      const target = first instanceof Element ? first.closest(CLICKABLE) : null;
      if (!target || isOwnUi(target) || ignoreRoot?.()?.contains(target)) return;
      onInteraction(describe("click", target));
    });
  const onSubmit = (event: Event) =>
    run(() => {
      if (!(event.target instanceof HTMLFormElement)) return;
      // Name a submit after the button pressed ("Connect payments"), not the form's code id.
      const submitter = (event as SubmitEvent).submitter;
      const submit = describe("submit", event.target);
      const label = submitter instanceof Element ? controlLabel(submitter) : undefined;
      onInteraction(label ? { ...submit, label } : submit, submitter instanceof Element ? submitter : undefined);
    });

  // A choice that saves by itself (a ticket's category, a setting's switch): named after its field.
  const onChange = (event: Event) =>
    run(() => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches("select, input[type=checkbox], input[type=radio], [role=switch]") || isOwnUi(target) || ignoreRoot?.()?.contains(target)) return;
      onInteraction(describe("change", target));
    });

  doc.addEventListener("click", onClick, { capture: true, passive: true });
  doc.addEventListener("submit", onSubmit, { capture: true, passive: true });
  doc.addEventListener("change", onChange, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("change", onChange, { capture: true });
    doc.removeEventListener("click", onClick, { capture: true });
    doc.removeEventListener("submit", onSubmit, { capture: true });
  };
}

/**
 * Which of a form's buttons sent it, as the form says: two buttons of one form can send one request
 * and differ only by the name and value they add ("action=INIT", "action=CLEAN"), and those are two
 * things to do. A lone button says nothing the form didn't, and its value is often just its label.
 */
export function buttonIntent(button: Element): string | undefined {
  const form = (button as HTMLButtonElement).form;
  const name = button.getAttribute("name");
  if (!form || !name || form.querySelectorAll("button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]").length < 2) return undefined;
  const word = [(button as HTMLButtonElement).value, name].find((v) => INTENT.test(v));
  return word && `intent:${word.toLowerCase()}`;
}

function describe(type: Interaction["type"], el: Element): Interaction {
  const interaction: Interaction = { type, tag: el.tagName.toLowerCase() };
  const role = el.getAttribute("role");
  if (role) interaction.role = role.slice(0, 32);
  // A choice is named after its field ("Category"), never after what was chosen.
  const label = type === "change" ? fieldLabel(el, el.getRootNode() as ParentNode) : controlLabel(el);
  if (label) interaction.label = label;
  return interaction;
}

