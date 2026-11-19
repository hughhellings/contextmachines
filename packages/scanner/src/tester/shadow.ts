/**
 * W5: seeing what a person sees inside web components.
 *
 * A closed shadow root (attachShadow({ mode: "closed" })) is drawn on screen like any other part of the
 * page, but no script can reach it, so Playwright's page outline, its role finders and the page's own
 * innerText all skip it: a form inside one has no numbered elements and its words never show. As e2e
 * does (closed-shadow.ts), every shadow root is made open when it is made, before any page script runs.
 * The component still gets its root back, so it works as before; only reading it from outside changes.
 *
 * And `document.body.innerText` never holds the words inside shadow roots, open or not: a text check
 * reads them too (deepText), as a person reads them, and with the same rules (only what is drawn, never
 * what the test typed into an editable box).
 */
import type { BrowserContext } from "playwright";

/** Runs in every page before its own scripts: every shadow root is made open. Self-contained. */
export function openShadowRoots(): void {
  // An init script runs once in each document, before the page's own scripts: wrapped once.
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    return attach.call(this, { ...init, mode: "open" });
  };
}

/**
 * Puts openShadowRoots into every page of `context` (call before its first page is made). The second
 * file allowed an init script (botwall.test.ts checks it word by word): it changes how shadow roots are
 * made, nothing a site reads about the browser (no navigator, no user agent, no fingerprint).
 */
export async function seeShadowRoots(context: BrowserContext): Promise<void> {
  await context.addInitScript(openShadowRoots).catch(() => {});
}

/**
 * Runs in the page, self-contained: the page's own words as a person sees them, shadow roots included,
 * with what was typed into a text area or an editable box taken out (a test could make its check hold
 * by typing the words itself). The light page is `body.innerText`, as before; each shadow root adds the
 * words of its drawn children (an element not drawn, or hidden, adds nothing).
 */
export function deepText(): string {
  const parts: string[] = [document.body?.innerText ?? ""];
  const typed: string[] = [];
  const drawn = (el: Element) => {
    if (!(el as HTMLElement).getClientRects || !(el as HTMLElement).getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const editable = "textarea, [contenteditable]:not([contenteditable=false])";
  for (const el of document.querySelectorAll<HTMLElement>(editable)) typed.push(el.innerText);
  let roots = 0;
  const visit = (root: Document | ShadowRoot | Element) => {
    for (const host of root.querySelectorAll("*")) {
      const sr = (host as Element).shadowRoot;
      if (!sr || roots++ > 500) continue;
      if (!drawn(host)) continue;
      for (const child of sr.children) {
        if (child.tagName === "STYLE" || child.tagName === "SCRIPT" || child.tagName === "SLOT") continue;
        if (drawn(child)) parts.push((child as HTMLElement).innerText ?? "");
      }
      // Loose words right in the root (no element around them).
      for (const node of sr.childNodes) if (node.nodeType === 3 && node.textContent?.trim()) parts.push(node.textContent);
      for (const el of sr.querySelectorAll<HTMLElement>(editable)) typed.push(el.innerText);
      visit(sr);
    }
  };
  visit(document);
  let words = parts.join("\n");
  for (const t of typed) if (t.trim()) words = words.split(t).join(" ");
  return words;
}
