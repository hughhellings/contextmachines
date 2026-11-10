/** Hosts of the snippet's own UI: the prompt, the guidance card and the inspector. Never captured. */
export const OWN_UI = "[data-ctx-prompt], [data-ctx-guide], [data-ctx-inspect]";

/** Whether an element is part of our own UI, including inside one of our shadow roots. */
export function isOwnUi(el: Element | null): boolean {
  for (let n = el; n; ) {
    if (n.closest(OWN_UI)) return true;
    n = (n.getRootNode() as ShadowRoot).host ?? null;
  }
  return false;
}
