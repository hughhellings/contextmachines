import { clean, inConsentDialog } from "./page.ts";
import { isOwnUi } from "./own.ts";

/**
 * Where someone is inside a page whose address doesn't change: an open pop-up, the current step
 * of a wizard, or the tab the person chose. Returned as a view segment ("~connect-your-bank")
 * added to the page's path, so a step or pop-up is a place of its own: what people do and where
 * they get stuck is filed under it. A pop-up beats a step, a step beats a tab. Names are the site's own
 * words, cleaned like any label (and held back on our side until enough people have seen them).
 */
const DIALOG = "dialog[open], [role='dialog'], [role='alertdialog']";
const MAX_SLUG = 40;
const CONSENT_DIALOG = /\bcookies?\b|\bconsent\b|\bgdpr\b|\bprivacy (choices|preferences|settings)\b/i;

export function currentView(doc: Document): string | undefined {
  // A cookie banner is the site asking about cookies, not a place in the product: nor is a pop-up
  // opened from it ("What third-party vendors can access my data?"), inside the same consent box.
  const dialogs = [...doc.querySelectorAll(DIALOG)].filter((d) => shown(d) && !isOwnUi(d) && !inConsentDialog(d) && !CONSENT_DIALOG.test(nameOf(d, doc) ?? ""));
  const dialog = dialogs[dialogs.length - 1];
  if (dialog) return segment(nameOf(dialog, doc), "dialog");
  const step = [...doc.querySelectorAll("[aria-current='step']")].find((s) => shown(s) && !isOwnUi(s));
  if (step) return segment(step.textContent, "step");
  watchTabChoices(doc);
  const tab = [...doc.querySelectorAll("[role='tablist'] [role='tab'][aria-selected='true']")].find((s) => shown(s) && !isOwnUi(s) && switched.has(s.closest("[role='tablist']") as Element));
  if (tab) return segment(tab.getAttribute("aria-label") ?? tab.textContent, "tab");
  return undefined;
}

/**
 * A tab is a view only once the person has switched to it. The tab selected as the page loads is
 * the page itself (its default), and so is a tab a carousel moves on to by itself: otherwise every
 * visit to a page with tabs on it would be filed under whichever tab happened to be showing.
 * Tab lists the person has used: pressed a tab that wasn't selected, or a key inside the list
 * (arrow keys move between tabs).
 */
const switched = new WeakSet<Element>();
const watched = new WeakSet<Document>();

function watchTabChoices(doc: Document): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  const onInput = (event: Event) => {
    const target = event.target as Element | null;
    const list = target?.closest?.("[role='tablist']");
    if (!list || isOwnUi(list)) return;
    if (event.type === "keydown") {
      if (/^(Arrow|Home$|End$|Enter$| $)/.test((event as KeyboardEvent).key)) switched.add(list);
      return;
    }
    // Pressing the tab already showing switches nothing. Read as the press starts (capture
    // phase), before the site's own handler marks the pressed tab selected.
    const tab = target?.closest("[role='tab']");
    if (tab && tab.getAttribute("aria-selected") !== "true") switched.add(list);
  };
  // mousedown too: some tab components switch as the button goes down, before any click.
  for (const type of ["mousedown", "click", "keydown"]) doc.addEventListener(type, onInput, true);
}

/** The page's path with the view added: "/setup" + "~connect-your-bank" → "/setup/~connect-your-bank". */
export function withView(path: string, view: string | undefined): string {
  if (!view) return path;
  return `${path.replace(/\/$/, "")}/${view}`;
}

/** A path without its view: where to send someone to reach it. */
export function withoutView(path: string): string {
  return path.replace(/\/~[^/]*$/, "") || "/";
}

function nameOf(dialog: Element, doc: Document): string | null | undefined {
  const label = dialog.getAttribute("aria-label");
  if (label) return label;
  const by = dialog.getAttribute("aria-labelledby");
  if (by) return by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ");
  const heading = dialog.querySelector("h1, h2, h3, [role='heading']")?.textContent;
  if (heading) return heading;
  // No heading: the short bold title above its fields ("About you", then "Income" as a wizard in it moves on).
  const firstField = dialog.querySelector("input, select, textarea");
  const title = [...dialog.querySelectorAll("strong, b, legend, [class*='title' i]")].find((el) => {
    const text = el.textContent?.trim() ?? "";
    if (text.length < 2 || text.length > 60 || el.closest("label, button, a")) return false;
    return !firstField || (el.compareDocumentPosition(firstField) & 4) !== 0; // it comes before the fields
  });
  return title?.textContent;
}

function segment(text: string | null | undefined, kind: string): string {
  const words = (clean(text) ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return `~${words || kind}`;
}

function shown(el: Element): boolean {
  if (el.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  if (el.matches("dialog") && !(el as HTMLDialogElement).open) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}
