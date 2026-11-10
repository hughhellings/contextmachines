/**
 * Time goes to what's unique to a page. A run has minutes, a site has hundreds of buttons, and most
 * of those are the same few on every page: this decides what's pressed first and what's not worth
 * pressing again. Nothing here looks at what a site is for, only at where a control sits and how
 * often it has been seen.
 */

/** A button on the page, as read in the browser (see the `controls` reader in scan.ts). */
export interface Control {
  label: string;
  /** In the site's header, menu or footer. */
  shell: boolean;
  /** Fixed to the window (a chat widget, a side panel's tab): the same whatever page is under it. */
  floating: boolean;
  /** In the page's main content, where the page has one marked. */
  inMain: boolean;
  /** Paging through a list or a carousel: one press shows how all of them work. */
  turner: boolean;
  /** Its kind (element, classes, and those of what holds it): a repeated collection is many of one kind. */
  kind: string;
  /** Where it sits on the page. */
  spot: string;
}

/** What's been pressed on this site so far. */
export type PressMemory = Map<string, number>;

/** How a press is remembered: every page turner counts as one, everything else by its words. */
const memoryKey = (c: Control) => (c.turner ? "\u0000turner" : c.label);
/** The same words in the same place, pressed this often: the site's own, wherever it isn't marked as such. */
const spotKey = (c: Control) => `${c.label}\u0000${c.spot}`;
const SAME_PLACE_PRESSES = 2;
/** Of a repeated collection, how many are pressed before the rest of the page. */
const SAMPLED = 2;
/** Enough of one kind side by side to be a collection, not a few buttons that happen to look alike. */
const COLLECTION = 4;

/** Words and marks that turn a page of a list or a carousel: "2", "Next", "›", "Page-3". */
export const PAGE_TURNER = /^(?:\d{1,4}|(?:go to )?page[- ]?\d+|(?:go to )?(?:next|prev(?:ious)?|first|last)(?: page| slide)?|[‹›«»<>←→]+|(?:[←‹«<] ?)?(?:next|prev(?:ious)?)(?: ?[→›»>])?)$/i;

/** Pressed once on the site: its header and menus, what floats over every page, and paging. */
const onceOnly = (c: Control) => c.shell || c.floating || c.turner;

/**
 * What's worth pressing on this page, best first, at most `max`. Controls that are the same
 * everywhere are left out once pressed; among the rest the page's own main content comes first,
 * then what's unique to it, and last what was already pressed on other pages. Of a long repeated
 * collection only the first few count as unique, since each row leads to the same screen.
 */
export function pressOrder(controls: Control[], memory: PressMemory, max: number): string[] {
  const byLabel = new Map<string, Control>();
  const ofKind = new Map<string, number>();
  for (const c of controls) if (!onceOnly(c)) ofKind.set(c.kind, (ofKind.get(c.kind) ?? 0) + 1);
  const sampled = new Map<string, number>();
  const ranked: { control: Control; rank: number; at: number }[] = [];
  controls.forEach((c, at) => {
    const had = byLabel.get(c.label);
    if (had) return;
    byLabel.set(c.label, c);
    // The same words in the main content are that page's own, however the site's furniture reads.
    if (onceOnly(c) && memory.has(memoryKey(c))) return;
    if (!c.inMain && (memory.get(spotKey(c)) ?? 0) >= SAME_PLACE_PRESSES) return;
    const n = sampled.get(c.kind) ?? 0;
    if (!onceOnly(c)) sampled.set(c.kind, n + 1);
    const pastSample = (ofKind.get(c.kind) ?? 0) >= COLLECTION && n >= SAMPLED;
    const rank = memory.has(memoryKey(c)) ? 4 : onceOnly(c) ? 3 : pastSample ? 2 : c.inMain ? 0 : 1;
    ranked.push({ control: c, rank, at });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.at - b.at);
  return ranked.slice(0, max).map((r) => r.control.label);
}

/** Remembers a control as pressed. */
export function remember(control: Control | undefined, memory: PressMemory): void {
  if (!control) return;
  memory.set(memoryKey(control), (memory.get(memoryKey(control)) ?? 0) + 1);
  memory.set(spotKey(control), (memory.get(spotKey(control)) ?? 0) + 1);
}

/** How much on a page hasn't been pressed anywhere yet, and isn't the site's furniture. */
export function uniqueCount(controls: Control[], memory: PressMemory): number {
  const labels = new Set<string>();
  for (const c of controls) if (!memory.has(memoryKey(c)) && !c.shell && !c.floating && !c.turner) labels.add(c.label);
  return labels.size;
}

/** Words a toggle swaps for their opposite when pressed: "Show password" and "Hide password" are one control. */
const OPPOSITES: [string, string][] = [["show", "hide"], ["expand", "collapse"], ["open", "close"], ["more", "less"], ["on", "off"], ["mute", "unmute"], ["play", "pause"], ["enable", "disable"]];

/**
 * Whether a control's new words are only the same toggle in its other state: one word swapped for
 * its opposite and the rest the same. "Edit project" become "Save project" is a next step, not this.
 */
export function otherState(before: string, after: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const [a, b] = [words(before), words(after)];
  if (a.length !== b.length) return false;
  const differ = a.flatMap((w, i) => (w === b[i] ? [] : [[w, b[i]!] as const]));
  return differ.length === 1 && OPPOSITES.some(([x, y]) => (differ[0]![0] === x && differ[0]![1] === y) || (differ[0]![0] === y && differ[0]![1] === x));
}

/**
 * Whether a page has nothing of its own left to press: only what `pressOrder` leaves out, the site's
 * furniture once pressed and the same words in the same place outside the main content. Words in
 * the main content are the page's own even when another page's buttons read the same.
 */
export function nothingOwn(controls: Control[], memory: PressMemory): boolean {
  return pressOrder(controls, memory, Number.POSITIVE_INFINITY).length === 0;
}
