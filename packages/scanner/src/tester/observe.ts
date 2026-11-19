/**
 * One look at the page, with no AI: its address, title, and a compact text picture of it from
 * Playwright's accessibility snapshot, every element a person can use numbered ("[e12] button
 * \"Search\""). The numbers are the snapshot's own refs; each is kept with its role, name and which of
 * the same it is, so an action can find it again by role and name (act.ts) and a saved test can on
 * another run (cache.ts).
 *
 * Capped in size, and chosen by where a person's attention is, not by page order: a big site draws its
 * search box, menus and dialogs into a layer at the very end of the page, which a cap in page order
 * always cut. So the lines are chosen in tiers, each with a share of the room:
 *   T0  a form the browser won't send as it is;
 *   T1  the layer holding the focus (a search box that just opened, and what is around it);
 *   T2  open widgets: dialogs, menus, listboxes, trees, an expanded combobox, a modal (the last opened first);
 *   T3  what is new since the last look;
 *   T4  what is on screen now;
 *   T5  the rest of the page: its start, and its end (a dialog's Done is usually its last line).
 * A tier's unused room passes on. What doesn't fit is said in a last line, "(N more elements … not shown)".
 * Plain rows a person clicks (a search result drawn as a <div>, a language in a menu of <div>s) are
 * numbered too, as `item`.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { withoutSecrets } from "./cache.ts";
import type { Target } from "./types.ts";

/** Roles a person acts on: only these get a number the actor may name (and plain rows, as "item"). */
export const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
]);

/** How much of the page the actor reads, in characters (about 4k tokens). */
export const SNAPSHOT_CHARS = 10000;
/** How much of the start page the planner reads, in characters. */
export const PLAN_SNAPSHOT_CHARS = 8000;

/** An element the actor may name: how to find it again. An item also says what it is inside. */
export type SnapTarget = Target & { ref: string; /** W5: how many in this look share its role and name (never saved): an element redrawn since is found again by them only when it was the one. */ same?: number; /** W5: what is around it in this look (its row or box's other words and controls, never a field's value), as a hash, never saved: an element redrawn since is found again only where the same is around it (not another record's "Approve"). */ around?: string };

export interface Snapshot {
  url: string;
  title: string;
  /** Numbered lines, as the actor reads them. */
  text: string;
  /** Each number the actor may name, and how to find its element. */
  refs: Map<string, SnapTarget>;
  /** An open dialog's name, when one is showing (or a late layer holding the focus): it usually has to be dealt with first. */
  dialog?: string;
  /** The focused element's line, masked. */
  focused?: string;
  /** The focused element's number, when it is one the actor may name: what `type` types into. */
  focusRef?: string;
  /** What the "open now" layer is, in words. */
  layer?: string;
  /** What the page is, as a fingerprint: its address, every element a person can use (role and name), and the focus. The same when nothing changed. */
  keys: string;
  /** Every ref in the whole snapshot: the next look's "new since" is what isn't here. */
  allRefs: Set<string>;
  /** Elements a person can use that weren't shown, for want of room. */
  hidden: number;
  /** What is open in front of the page, each as a person names it ('menu', 'dialog "Before you continue"'), masked: what an action opened or closed. */
  open: string[];
  /** The refs of every element a person can use, shown or not: what an action added or took away. */
  usable: Set<string>;
  /** What is on screen, as a fingerprint (the "on screen now" elements): a scroll that moves the page changes it. */
  screen: string;
  /** The refs numbered as items: kept as items on the next look, while they are there (a row is clickable whether or not it is new). */
  itemRefs?: Set<string>;
  /** The usable elements with a state ([selected], [checked], [expanded], [pressed]), as lines (masked): what an arrow key or a toggle changed. */
  states?: string[];
  /** The page's own words (not its controls), as a fingerprint: a page of results that turned changes it. */
  words?: string;
  /** What each role=alert on the page says (masked, clipped): an action's history line names one that came ("Nothing was saved. …"), so the actor still knows why after it goes back a page. */
  alerts?: string[];
}

/** An embedded page the snapshot holds, by the prefix of its refs ("f1"): where it is, and whether it is on the test's site. */
export interface FrameInfo {
  /** Its path, no query (masked). */
  path: string;
  /** Which of the page's frames with this path it is. */
  nth: number;
  /** On the test's site: only then are its elements offered. */
  onSite: boolean;
}

/** One line of Playwright's ai-mode snapshot: `- button "Search" [ref=e12]`, maybe with a `: text` after. */
const LINE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s?(.*))?$/;

/** The quoted name as written, unescaped. */
function unquote(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** A YAML scalar as written ('"Price: 10 USD"', "'it''s'"), as the words it holds. */
function scalar(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Structure alone: says nothing but its words. */
const STRUCTURE = new Set(["generic", "group", "list", "listitem", "none", "presentation"]);
/** A plain row's own kind: one of these with only words in it may be a clickable row ("item"). */
const ROWS = new Set(["generic", "listitem", "group", "none", "presentation"]);
/** What a plain row may hold: words, emphasis, pictures, more plain boxes. Anything else (a link, a button) makes it more than a row. */
const PLAIN = new Set(["text", "generic", "emphasis", "strong", "img", "none", "presentation", "superscript", "subscript", "mark", "time", "code"]);
/** Widgets that are open in front of the page while they show. */
const WIDGETS = new Set(["dialog", "alertdialog", "menu", "listbox", "tree"]);
/** Containers a person picks a row of: their plain rows may be items even though the container itself is offered. */
const PICK_FROM = new Set(["listbox", "tree", "treegrid", "grid"]);
/** A layer drawn late in the page (a portal) is one of these at its top: never a landmark, never the control itself. */
const PORTAL = new Set(["generic", "none", "presentation", ""]);
/** States an element shows that an action changes without changing what is there. */
const STATES = / \[(?:selected|checked|pressed|expanded)(?:=[^\]]*)?\]/g;
/** What an item's name is cut to. */
const ITEM_CHARS = 80;
/** Of the room: the focus layer, the open widgets, what is new. The rest is for the screen and the page. */
const SHARE = { focus: 0.4, widgets: 0.3, fresh: 0.3 } as const;

interface Node {
  i: number;
  indent: number;
  /** "" for a line of words that is no element. */
  role: string;
  name: string;
  ref?: string;
  attrs: string;
  after?: string;
  /** For a line of words: them. */
  words?: string;
  parent: number;
  children: number[];
  /** Has an e-ref and an interactive role: offered by number. */
  offered: boolean;
  /** Its own box, or its element's for a line of words: [x, y, w, h]. */
  box?: [number, number, number, number];
  /** The line as the actor reads it; undefined for structure with no words. */
  line?: string;
  /** Elements and headings come first when room is short. */
  keep: boolean;
  /** The ref prefix of the embedded page it is in ("f1"). */
  framed?: string;
}

/** What `compact()` hands back: a Snapshot without the address and title. */
export type Compacted = Omit<Snapshot, "url" | "title">;

export interface CompactOptions {
  /** The previous look's refs: what isn't among them is new (T3). */
  prev?: Set<string>;
  /** The previous look's items: still items now, while they are there. */
  prevItems?: Set<string>;
  /** The viewport, for "on screen now" (T4): only when the snapshot has boxes. */
  viewport?: { width: number; height: number };
  /** The embedded pages, by ref prefix: elements of one on the test's site are offered (with `frame`), of any other, words only. */
  frames?: Record<string, FrameInfo>;
  /**
   * Room for the rest of the page (T5) when the actor has just seen it, on the same page: the open,
   * new and on-screen lines are chosen as ever, and the cut is said as the page "as in your last look".
   */
  restCap?: number;
}

/** A role as a person says it: "search box". */
const spoken = (role: string) => ({ searchbox: "search box", textbox: "text box", combobox: "combo box", alertdialog: "dialog", menuitem: "menu item" })[role] ?? role;

/**
 * The snapshot's YAML turned into the actor's lines, with the refs kept. Exported for tests: it needs
 * no browser. `mask` hides --var values wherever they show (a filled field shows what was typed).
 * Every target's nth is counted over the whole YAML in page order, whatever is shown.
 */
/**
 * A field's value as the actor reads it: a value that is exactly a stored one shows as its {name}, even one
 * too short for the masker to hide everywhere (Shopify's test card "1"), when the field is named for it.
 */
function fieldValue(value: string, field: string, mask: (s: string) => string): string {
  const every = (mask as { every?: () => [string, string][] }).every?.() ?? [];
  const v = value.trim();
  const words = field.toLowerCase();
  const names = [...new Set(every.filter(([n, val]) => val === v && (v.length >= 3 || words.includes(n.toLowerCase().split(/[._-]/).at(-1)!))).map(([n]) => n))];
  return names.length ? `{${names.join(" or ")}}` : mask(value);
}

export function compact(yaml: string, mask: (s: string) => string = (s) => s, cap = SNAPSHOT_CHARS, fields: readonly Field[] = [], o: CompactOptions | Set<string> = {}): Compacted {
  const opts: CompactOptions = o instanceof Set ? { prev: o } : o;
  const marks = new Map(fields.map((f) => [f.name, f.empty ? " [required, empty]" : " [invalid]"]));
  const nodes: Node[] = [];
  const allRefs = new Set<string>();
  const seen = new Map<string, number>();
  const nths = new Map<number, number>();
  /** Open elements by indent, for each line's parent. */
  const stack: { indent: number; i: number }[] = [];
  let dialog: string | undefined;
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    // YAML quotes a whole line whose name holds ": " ('- 'link "Sponsored: Big safari" [ref=e5]'' or
    // with a ':' after it, when it has children): unquoted, it reads as any other.
    const wrapped = /^(\s*)- '(.*)'(:?)$/.exec(line);
    const raw = wrapped ? `${wrapped[1]}- ${wrapped[2]!.replace(/''/g, "'")}${wrapped[3]}` : line;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)?.i ?? -1;
    const m = LINE.exec(raw);
    if (!m) {
      // Text that is no element of its own ("- text: Search"), or "/url:" lines: words, kept only if room.
      const said = raw.replace(/^\s*- (?:text: )?/, "").trim();
      if (!said || /^\/(url|placeholder):/.test(said)) continue;
      const words = scalar(said);
      const i = nodes.length;
      nodes.push({ i, indent, role: "", name: "", attrs: "", words, parent, children: [], offered: false, keep: false, line: `${" ".repeat(indent)}${mask(words)}` });
      if (parent >= 0) nodes[parent]!.children.push(i);
      continue;
    }
    const [, ind = "", role = "", quoted, attrs = "", afterRaw] = m;
    const after = afterRaw === undefined ? undefined : scalar(afterRaw);
    const name = quoted === undefined ? "" : unquote(quoted);
    const anyRef = /\[ref=([a-z]*\d+[a-z\d]*)\]/.exec(attrs)?.[1];
    if (anyRef) allRefs.add(anyRef);
    // Refs inside an iframe are written f1e2: offered only when that frame is on the test's site (and
    // found again there by role, counted within it); a frame of another site (an advert, a payment
    // widget) stays words only.
    const framed = /\[ref=(f\d+)e\d+\]/.exec(attrs)?.[1];
    const frame = framed ? opts.frames?.[framed] : undefined;
    const ref = framed ? (frame?.onSite ? /\[ref=(f\d+e\d+)\]/.exec(attrs)?.[1] : undefined) : /\[ref=(e\d+)\]/.exec(attrs)?.[1];
    const key = `${framed ?? ""}\u0000${role}\u0000${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if ((role === "dialog" || role === "alertdialog") && !dialog) dialog = name || role;
    // A frame's own boxes are within the frame: its elements are where the frame is.
    const box = framed ? null : /\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/.exec(attrs);
    const i = nodes.length;
    const extra = attrs.replace(/ \[(?:ref|cursor|box)[^\]]*\]/g, "").replace(/ \[active\]/g, " [focused]");
    const shown = `${name ? ` "${mask(name)}"` : ""}${extra}${after ? `: ${FIELD_ROLES.has(role) ? fieldValue(after, name, mask) : mask(after)}` : ""}`;
    const offered = Boolean(ref && INTERACTIVE.has(role));
    const node: Node = { i, indent, role, name, attrs, parent, children: [], offered, keep: false, ...(ref ? { ref } : {}), ...(framed ? { framed } : {}), ...(after ? { after } : {}), ...(box ? { box: [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])] as [number, number, number, number] } : {}) };
    if (offered) {
      node.line = `${ind}[${ref}] ${role}${shown}${FIELD_ROLES.has(role) ? (marks.get(name) ?? "") : ""}`;
      node.keep = true;
    } else if (STRUCTURE.has(role)) {
      // Structure alone says nothing: only its words, if any.
      if (after) node.line = `${ind}${mask(after)}`;
    } else {
      node.line = `${ind}${role}${shown}`;
      node.keep = role === "heading" || role === "dialog" || role === "alertdialog" || role === "alert";
    }
    nths.set(i, nth);
    nodes.push(node);
    if (parent >= 0) nodes[parent]!.children.push(i);
    stack.push({ indent, i });
  }
  const n = nodes.length;
  const subtree = (i: number): number[] => {
    const out: number[] = [];
    const walk = (k: number) => {
      out.push(k);
      for (const c of nodes[k]!.children) walk(c);
    };
    walk(i);
    return out;
  };
  const tier = new Array<number>(n).fill(5);
  /** In T1 only for being near a focus that is no layer: plain words there aren't rows to click. */
  const nearFocus = new Array<boolean>(n).fill(false);

  // T1: the layer holding the focus. The root (the page's body) holding it is no layer.
  const focus = nodes.find((x) => x.role && /\[active\]/.test(x.attrs) && x.parent >= 0);
  const roots = nodes.filter((x) => x.parent < 0);
  let layer: string | undefined;
  /** The late layer holding the focus, when there is one: it is open. */
  let lateTop: Node | undefined;
  let focusWhat = "";
  const subtreeHas = (top: number, k: number) => {
    for (let p = k; p >= 0; p = nodes[p]!.parent) if (p === top) return true;
    return false;
  };
  if (focus) {
    let top = focus;
    const topLevel = (x: Node) => (roots.length === 1 ? nodes[x.parent]?.parent === -1 : x.parent === -1);
    while (!topLevel(top) && top.parent >= 0) top = nodes[top.parent]!;
    const holdsPage = subtree(top.i).some((k) => nodes[k]!.role === "main" || nodes[k]!.role === "banner");
    // A layer is what a site draws in front of the page: a widget, a modal, or a plain box at the end
    // (a portal). Never a landmark (the footer), and never the focused control itself (a last "Next").
    const layerLike = WIDGETS.has(top.role) || /\[modal\]/.test(top.attrs) || (PORTAL.has(top.role) && top !== focus && !top.offered);
    const lateLayer = top.i >= 0.75 * n && !holdsPage && layerLike;
    const what = `${spoken(focus.role)}${focus.name ? ` "${mask(clip(focus.name, 60))}"` : ""}`;
    focusWhat = what;
    if (lateLayer) {
      lateTop = top;
      for (const k of subtree(top.i)) tier[k] = 1;
      layer = WIDGETS.has(top.role) && top.name ? `${spoken(top.role)} "${mask(clip(top.name, 60))}", holding the focused ${what}` : `the layer holding the focused ${what}`;
      dialog ??= top.name && top.role !== "generic" ? top.name : `${what.replace(/"/g, "'")}`;
    } else {
      for (let k = Math.max(0, focus.i - 40); k <= Math.min(n - 1, focus.i + 40); k++) {
        tier[k] = 1;
        nearFocus[k] = true;
      }
      layer = `the focused ${what}, and what is around it`;
    }
  }

  // T2: open widgets, outermost only; the last in page order (opened last) first.
  const widgets: Node[] = [];
  for (const x of nodes) {
    if (tier[x.i] !== 5) continue;
    const isWidget = WIDGETS.has(x.role) || (x.role === "combobox" && /\[expanded\]/.test(x.attrs)) || /\[modal\]/.test(x.attrs);
    if (!isWidget) continue;
    let p = x.parent;
    let inside = false;
    while (p >= 0) {
      if (widgets.some((w) => w.i === p)) inside = true;
      p = nodes[p]!.parent;
    }
    if (inside) continue;
    widgets.push(x);
    for (const k of subtree(x.i)) if (tier[k] === 5) tier[k] = 2;
  }
  widgets.reverse();

  // T3: what is new since the last look (refs stay while an element's role and name do), unless
  // nearly everything is (a new page: then it's all simply the page).
  let fresh = 0;
  let freshOn = false;
  let isNew = new Array<boolean>(n).fill(false);
  if (opts.prev && opts.prev.size) {
    isNew = nodes.map((x) => (x.ref ? !opts.prev!.has(x.ref) : false));
    const newCount = isNew.filter(Boolean).length;
    if (newCount && newCount <= 0.5 * nodes.filter((x) => x.ref).length) {
      for (const x of nodes) {
        const own = x.ref ? isNew[x.i] : x.parent >= 0 && tier[x.parent] === 3;
        if (own && tier[x.i] === 5) tier[x.i] = 3;
      }
      freshOn = true;
    }
  }

  // Items: a plain row of words a person clicks. Numbered when it reads as clickable ([cursor=pointer]),
  // or when it is a row of what is open, focused or new. Never inside something already numbered.
  const plainOnly = new Array<boolean>(n).fill(false);
  const wordsOf = new Array<string>(n).fill("");
  for (let k = n - 1; k >= 0; k--) {
    const x = nodes[k]!;
    const own = x.role === "" ? x.words! : x.role === "img" ? "" : (x.after ?? "");
    wordsOf[k] = [own, ...x.children.map((c) => wordsOf[c]!)].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    plainOnly[k] = (x.role === "" || PLAIN.has(x.role) || ROWS.has(x.role)) && !x.offered && x.children.every((c) => plainOnly[c]);
  }
  const items = new Set<number>();
  const itemNth = new Map<number, number>();
  const itemSeen = new Map<string, number>();
  const itemWithin = new Map<number, { role: string; name: string }>();
  // Inside an open widget (or a late layer): a row there is one to pick, wherever the focus is.
  const inWidget = new Array<boolean>(n).fill(false);
  for (const x of nodes) {
    const up = x.parent >= 0 ? nodes[x.parent]! : undefined;
    inWidget[x.i] = (up ? inWidget[up.i]! : false) || WIDGETS.has(x.role) || /\[modal\]/.test(x.attrs) || (x.role === "combobox" && /\[expanded\]/.test(x.attrs)) || (lateTop !== undefined && x.i === lateTop.i);
  }
  const visit = (k: number) => {
    const x = nodes[k]!;
    // A listbox or a grid of plain rows (an autocomplete's results as <div>s) is gone into: its rows are what is picked.
    if (x.offered && !PICK_FROM.has(x.role)) return;
    const rows = x.children.filter((c) => ROWS.has(nodes[c]!.role) && plainOnly[c] && wordsOf[c]).length;
    // Clickable: it reads so, it was an item in the last look (a row stays clickable when it is no longer new),
    // or it is a row of what is open or new. Being near the focus alone doesn't make prose a row to click.
    const clickable = /\[cursor=pointer\]/.test(x.attrs) || Boolean(x.ref && opts.prevItems?.has(x.ref)) || (tier[k]! <= 3 && (!nearFocus[k] || inWidget[k]! || (freshOn && isNew[k]!)));
    if (ROWS.has(x.role) && x.ref && !x.framed && plainOnly[k] && wordsOf[k] && rows < 2 && clickable && x.parent >= 0) {
      items.add(k);
      return;
    }
    for (const c of x.children) visit(c);
  };
  for (const r of roots) visit(r.i);
  for (const k of items) {
    const x = nodes[k]!;
    const name = clip(wordsOf[k]!, 200);
    x.name = name;
    const nth = itemSeen.get(name) ?? 0;
    itemSeen.set(name, nth + 1);
    itemNth.set(k, nth);
    x.offered = true;
    x.keep = true;
    x.line = `${" ".repeat(x.indent)}[${x.ref}] item "${mask(clip(name, ITEM_CHARS))}"`;
    // What it is inside: the nearest named element, or an open widget.
    for (let p = x.parent; p >= 0; p = nodes[p]!.parent) {
      const up = nodes[p]!;
      if ((up.name && !STRUCTURE.has(up.role)) || WIDGETS.has(up.role)) {
        itemWithin.set(k, { role: up.role, name: up.name });
        break;
      }
    }
    // An item's words are its own line: its parts aren't shown again.
    for (const c of subtree(k).slice(1)) nodes[c]!.line = undefined;
  }

  // T4: what is on screen now, when the snapshot has boxes.
  const vp = opts.viewport;
  if (vp && nodes.some((x) => x.box)) {
    const boxOf = (x: Node): Node["box"] => (x.box ? x.box : x.parent >= 0 ? boxOf(nodes[x.parent]!) : undefined);
    for (const x of nodes) {
      if (tier[x.i] !== 5 || x.parent < 0) continue;
      const b = boxOf(x);
      if (b && b[2] > 0 && b[3] > 0 && b[0] < vp.width && b[1] < vp.height && b[0] + b[2] > 0 && b[1] + b[3] > 0) tier[x.i] = 4;
    }
  }

  // Choosing within the room: elements and headings first, then words, each in page order.
  const take = new Set<number>();
  const cost = (k: number) => nodes[k]!.line!.length + 1;
  const pick = (order: number[], budget: number): number => {
    let used = 0;
    const lines = order.filter((k) => nodes[k]!.line !== undefined && !take.has(k));
    for (const pass of [true, false]) {
      for (const k of lines) {
        if (take.has(k) || nodes[k]!.keep !== pass) continue;
        if (used + cost(k) > budget) continue;
        take.add(k);
        used += cost(k);
      }
    }
    return used;
  };
  const formLine = fields.length ? `(A form here can't be sent until these are right: ${fields.map((f) => `${mask(f.name)}: ${f.message}`).join("; ")})` : "";
  const MARKER_ROOM = 70;
  let used = formLine ? formLine.length + 1 : 0;
  const ofTier = (t: number) => nodes.filter((x) => tier[x.i] === t).map((x) => x.i);
  let carry = 0;
  const share = (part: number, header: string, order: number[]) => {
    if (!order.length) {
      carry += part * cap;
      return { header: "", got: 0 };
    }
    const room = Math.max(0, part * cap + carry - header.length - 1);
    const got = pick(order, Math.min(room, cap - MARKER_ROOM - used - header.length - 1));
    carry = room - got;
    used += got + (got ? header.length + 1 : 0);
    return { header, got };
  };
  const t1 = share(SHARE.focus, `(open now: ${layer ?? ""})`, ofTier(1));
  // The widgets' share, the last opened first.
  const widgetHeaders = new Map<number, string>();
  {
    const room = SHARE.widgets * cap + carry;
    carry = 0;
    let left = room;
    for (const w of widgets) {
      const header = `(open now: ${spoken(w.role)}${w.name ? ` "${mask(clip(w.name, 60))}"` : ""})`;
      const got = pick(subtree(w.i).filter((k) => tier[k] === 2), Math.min(left - header.length - 1, cap - MARKER_ROOM - used - header.length - 1));
      if (got) {
        widgetHeaders.set(w.i, header);
        left -= got + header.length + 1;
        used += got + header.length + 1;
      }
    }
    carry = Math.max(0, left);
  }
  // Counted now: the rows numbered as items above are new elements too.
  if (freshOn) fresh = nodes.filter((x) => tier[x.i] === 3 && x.offered).length;
  const t3 = share(SHARE.fresh, `(new since your last action: ${fresh} element${fresh === 1 ? "" : "s"})`, ofTier(3));
  // The screen, then the rest of the page: its start and its end.
  const earlier = t1.got > 0 || widgetHeaders.size > 0 || t3.got > 0;
  const restHeader = "(the rest of the page)";
  let room = cap - MARKER_ROOM - used - (earlier ? restHeader.length + 1 : 0);
  room -= pick(ofTier(4), room);
  const fullRoom = room;
  if (opts.restCap !== undefined) room = Math.min(room, opts.restCap);
  const restCut = room < fullRoom;
  const rest = ofTier(5);
  const front = pick(rest, Math.floor(room * 0.8));
  room -= front;
  // The end of the page, from its last line back.
  {
    const back = rest.filter((k) => !take.has(k) && nodes[k]!.line !== undefined).reverse();
    let got = 0;
    for (const pass of [true, false]) {
      for (const k of back) {
        if (take.has(k) || nodes[k]!.keep !== pass) continue;
        if (got + cost(k) > room) continue;
        take.add(k);
        got += cost(k);
      }
    }
  }

  // Rendered in sections, each in page order.
  const text: string[] = [];
  if (formLine) text.push(formLine);
  const section = (header: string, ks: number[]) => {
    const lines = ks.filter((k) => take.has(k)).map((k) => nodes[k]!.line!);
    if (!lines.length) return;
    if (header) text.push(header);
    text.push(...lines);
  };
  section(t1.header, ofTier(1));
  for (const w of widgets) if (widgetHeaders.has(w.i)) section(widgetHeaders.get(w.i)!, subtree(w.i).filter((k) => tier[k] === 2));
  section(t3.header, ofTier(3));
  const restLines = nodes.filter((x) => (tier[x.i] === 4 || tier[x.i] === 5) && take.has(x.i)).map((x) => x.i);
  section(text.length > (formLine ? 1 : 0) ? restHeader : "", restLines);
  const hidden = nodes.filter((x) => x.offered && x.line !== undefined && !take.has(x.i)).length;
  if (hidden && restCut) text.push(`(the rest of this page is cut short after your first look in this step: ${hidden} more element${hidden === 1 ? "" : "s"} not shown; scroll if what you need isn't here)`);
  else if (hidden) text.push(`(${hidden} more element${hidden === 1 ? "" : "s"} on this page ${hidden === 1 ? "is" : "are"} not shown)`);

  // W5: what is around each element: what comes before it in its box (its label, its record's name, the
  // fields above it), and in a row, a list item or a card also the cells, heading and controls after it;
  // never plain words after it (a "Synced 3" line a form redraws below its Save). The nearest box that has any, up
  // to 4 boxes up. A field's value is never part of it (a form redrawn as it is typed in is still the
  // same form), nor a control's state.
  const ROWISH = new Set(["row", "listitem", "article", "option", "treeitem", "gridcell", "cell"]);
  /** After it in a row, only what names the record (its cells, its heading) and the row's controls count. */
  const NAMING = new Set(["cell", "gridcell", "rowheader", "heading"]);
  const aroundOf = (x: Node): string => {
    const mine = new Set(subtree(x.i));
    // The boxes it is in are where it is, not what is around it.
    for (let p = x.parent; p >= 0; p = nodes[p]!.parent) mine.add(p);
    for (let p = x.parent, up = 0; p >= 0 && up < 4; p = nodes[p]!.parent, up++) {
      const box = subtree(p);
      // A box that holds much of the page is no row: what is around is too much to be the same again.
      if (box.length > 400) return "";
      const whole = ROWISH.has(nodes[p]!.role);
      const said = box
        .filter((k) => k !== p && !mine.has(k) && (k < x.i || (whole && (INTERACTIVE.has(nodes[k]!.role) || NAMING.has(nodes[k]!.role)))))
        .map((k) => {
          const y = nodes[k]!;
          if (!y.role) return y.words ?? "";
          return INTERACTIVE.has(y.role) ? `${y.role} ${y.name}` : `${y.role} ${y.name} ${y.after ?? ""}`;
        })
        .map((w) => w.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      if (said) return createHash("sha1").update(`${up}\n${said}`).digest("hex").slice(0, 16);
    }
    return "";
  };
  // Only an element shown is offered, in page order.
  const refs: Snapshot["refs"] = new Map();
  for (const x of nodes) {
    if (!x.offered || !take.has(x.i) || !x.ref) continue;
    if (items.has(x.i)) {
      const within = itemWithin.get(x.i);
      refs.set(x.ref, { ref: x.ref, role: "item", name: x.name, nth: itemNth.get(x.i) ?? 0, ...(within ? { within } : {}), same: itemSeen.get(x.name) ?? 1, around: aroundOf(x) });
    } else {
      const f = x.framed ? opts.frames?.[x.framed] : undefined;
      refs.set(x.ref, { ref: x.ref, role: x.role, name: x.name, nth: nths.get(x.i) ?? 0, ...(f ? { frame: { path: f.path, nth: f.nth } } : {}), same: seen.get(`${x.framed ?? ""}\u0000${x.role}\u0000${x.name}`) ?? 1, around: aroundOf(x) });
    }
  }
  // Every usable element, each copy counted (two "Open" buttons aren't one), with its state: an arrow key
  // that moves [selected] changes the page as a person sees it.
  const stateOf = (x: Node) => (x.attrs.match(STATES) ?? []).join("");
  const usable = nodes.filter((x) => x.offered || (x.role && INTERACTIVE.has(x.role))).map((x) => `${items.has(x.i) ? "item" : x.role}\u0000${x.name}\u0000${stateOf(x)}`);
  const states = nodes.filter((x) => x.offered && x.line !== undefined && stateOf(x)).map((x) => `${items.has(x.i) ? "item" : spoken(x.role)}${x.name ? ` "${mask(clip(x.name, 60))}"` : ""}${stateOf(x).replace(/\]\[|\] \[/g, "] [")}`);
  // The page's own words, not its controls': a table that turned to its next page changes them.
  const pageWords = createHash("sha1").update(nodes.filter((x) => !x.offered && !(x.role && INTERACTIVE.has(x.role))).map((x) => `${x.role}\u0000${x.name}\u0000${x.role === "" ? x.words : (x.after ?? "")}`).join("\n")).digest("hex");
  const usableRefs = new Set(nodes.filter((x) => x.ref && (x.offered || INTERACTIVE.has(x.role))).map((x) => x.ref!));
  // What is open: the late layer holding the focus, and every outermost open widget, named.
  const open: string[] = [];
  if (lateTop) open.push(WIDGETS.has(lateTop.role) && lateTop.name ? `${spoken(lateTop.role)} "${mask(clip(lateTop.name, 60))}"` : `a layer with the focused ${focusWhat}`);
  for (const x of nodes) {
    const isWidget = WIDGETS.has(x.role) || (x.role === "combobox" && /\[expanded\]/.test(x.attrs)) || /\[modal\]/.test(x.attrs);
    if (!isWidget || (lateTop && subtreeHas(lateTop.i, x.i))) continue;
    let up = x.parent;
    let inner = false;
    for (; up >= 0; up = nodes[up]!.parent) if (WIDGETS.has(nodes[up]!.role) || /\[modal\]/.test(nodes[up]!.attrs)) inner = true;
    if (!inner) open.push(`${spoken(x.role)}${x.name ? ` "${mask(clip(x.name, 60))}"` : ""}`);
  }
  const screen = createHash("sha1").update(nodes.filter((x) => tier[x.i] === 4 && x.ref).map((x) => x.ref).join(" ")).digest("hex");
  const focusedLine = focus?.line?.trim() ?? (focus ? `${focus.role}${focus.name ? ` "${mask(focus.name)}"` : ""}` : undefined);
  const keys = createHash("sha1").update([...usable].sort().join("\n")).update(`\nfocus\u0000${focusedLine ?? ""}`).update(`\nwords\u0000${pageWords}`).digest("hex");
  const itemRefs = new Set([...items].map((k) => nodes[k]!.ref!).filter(Boolean));
  const alerts = nodes
    .filter((x) => x.role === "alert")
    // Masked before it is clipped, so a secret cut short is never left unmasked.
    .map((x) => clip(mask(subtree(x.i).map((k) => { const y = nodes[k]!; return [y.name, y.role === "" ? y.words : y.after].filter(Boolean).join(" "); }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim()), 200))
    .filter(Boolean);
  return {
    text: text.join("\n"),
    refs,
    ...(dialog ? { dialog: mask(dialog) } : {}),
    ...(focusedLine ? { focused: focusedLine } : {}),
    ...(focus?.ref && refs.has(focus.ref) ? { focusRef: focus.ref } : {}),
    ...(layer && t1.got ? { layer } : {}),
    keys,
    allRefs,
    hidden,
    open: [...new Set(open)],
    usable: usableRefs,
    screen,
    itemRefs,
    states,
    words: pageWords,
    ...(alerts.length ? { alerts } : {}),
  };
}

/** Text cut to about `n` characters at a word. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return `${(at > n / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Roles of a field a form may need filled: marked when the browser wouldn't send it as it is. */
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "spinbutton", "slider", "switch"]);

/** A visible form field the browser won't send as it is (a required one left empty, an email that isn't one). */
export interface Field {
  name: string;
  empty: boolean;
  message: string;
}

/** Runs in the page: the visible fields that are invalid, by the name a person reads on them. */
function invalidFields(): Field[] {
  const out: Field[] = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const f = el as HTMLInputElement;
    if (!f.willValidate || f.validity.valid || !f.form) continue;
    const box = f.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const name = (f.getAttribute("aria-label") || f.labels?.[0]?.textContent || f.placeholder || f.title || f.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    out.push({ name, empty: !f.value, message: (f.validationMessage || "not valid").slice(0, 80) });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * The embedded pages a snapshot holds, by the prefix of their refs: each iframe line's own ref is
 * resolved to its frame, whose address says whether it is on the test's site (`onSite`). Without
 * `onSite`, no frame is (its elements stay words only).
 */
async function framesOf(page: Page, yaml: string, mask: (s: string) => string, onSiteOf?: (url: string) => boolean): Promise<Record<string, FrameInfo>> {
  const out: Record<string, FrameInfo> = {};
  if (!onSiteOf || !/\[ref=f\d+e\d+\]/.test(yaml)) return out;
  const lines = yaml.split("\n");
  const pathOf = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  };
  const others = page.frames().filter((f) => f !== page.mainFrame());
  for (const [k, line] of lines.entries()) {
    const m = /^(\s*)- iframe\b.*\[ref=([a-z]*\d+[a-z\d]*)\]/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    let prefix: string | undefined;
    for (let j = k + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if ((next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      prefix = /\[ref=(f\d+)e\d+\]/.exec(next)?.[1];
      if (prefix) break;
    }
    if (!prefix || out[prefix]) continue;
    const frame = await page.locator(`aria-ref=${m[2]}`).elementHandle({ timeout: 1000 }).then((h) => h?.contentFrame() ?? null, () => null);
    if (!frame) continue;
    const url = frame.url();
    const path = pathOf(url);
    out[prefix] = { path: mask(path), nth: Math.max(0, others.filter((f) => pathOf(f.url()) === path).indexOf(frame)), onSite: /^https?:/.test(url) && onSiteOf(url) };
  }
  return out;
}

/**
 * W5: runs in the page, self-contained. The words of every drawn element a person can click or tab to
 * that says so only in its code (an onclick, a tabindex), not by its role or its pointer: "div soup"
 * (`<div onclick=…>Save</div>`, `<div tabindex=0>Next</div>`). Shadow roots too. Their words, each
 * one's as innerText reads it, spaces made one, with its box on the screen (so only its own row is
 * numbered, not another row with the same words); at most 300. A click listener added in script
 * (addEventListener, as React and Vue attach theirs) can't be seen from the page: such a box is found
 * only when it also has a tabindex, an onclick or its own pointer cursor (Playwright marks that one).
 */
export function clickableWords(): Clickable[] {
  const NATIVE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY", "OPTION", "BODY", "HTML"]);
  const ROLE_OK = /^(|generic|none|presentation|group|listitem|row|cell|gridcell)$/;
  const out: { words: string; box: [number, number, number, number] }[] = [];
  let seen = 0;
  const visit = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (++seen > 20000 || out.length >= 300) return;
      if (el.shadowRoot) visit(el.shadowRoot);
      if (NATIVE.has(el.tagName) || !ROLE_OK.test(el.getAttribute("role") ?? "")) continue;
      const tab = el.getAttribute("tabindex");
      const says = el.hasAttribute("onclick") || typeof el.onclick === "function" || (tab !== null && Number(tab) >= 0);
      if (!says || el.closest("a, button, label, summary, [role=button], [role=link]")) continue;
      const box = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!box.width || !box.height || st.visibility === "hidden" || st.display === "none" || st.cursor === "pointer") continue;
      const words = (el.innerText ?? "").replace(/\s+/g, " ").trim();
      if (words && words.length <= 200) out.push({ words, box: [box.x, box.y, box.width, box.height] });
    }
  };
  visit(document);
  return out;
}

/** W5: a box clickable only by its code: its words and where it is ([x, y, w, h], as the snapshot's boxes). */
export type Clickable = { words: string; box: [number, number, number, number] };

/**
 * W5: the snapshot with every plain row whose words are those of a clickable element (clickableWords)
 * marked "[cursor=pointer]", as Playwright marks a row with a pointer: compact() then numbers it as an
 * item. A row's words are its own and its children's, as a person reads them.
 */
export function markClickable(yaml: string, words: readonly (string | Clickable)[]): string {
  if (!words.length) return yaml;
  const said1 = (w: string) => w.replace(/\s+/g, " ").trim();
  // Words alone (no box known): any row with them. With a box: only the row drawn there.
  const want = new Set(words.filter((w): w is string => typeof w === "string").map(said1));
  const boxes = new Map<string, Clickable["box"][]>();
  for (const w of words) if (typeof w !== "string") boxes.set(said1(w.words), [...(boxes.get(said1(w.words)) ?? []), w.box]);
  const near = (a: readonly number[], b: readonly number[]) => a.every((v, k) => Math.abs(v - b[k]!) <= 1.5);
  const lines = yaml.split("\n");
  const indentOf = (l: string) => l.match(/^\s*/)?.[0].length ?? 0;
  const ownWords = (l: string): string => {
    const t = l.replace(/^\s*- /, "");
    const m = /^(?:text: )?(.*)$/.exec(t);
    if (/^[a-z]+(?: "|\b)/.test(t) && !/^text: /.test(t)) {
      const after = /^(?:[a-z]+)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*(?::\s?(.*))?$/.exec(t)?.[1] ?? "";
      return scalar(after);
    }
    return /^\/(url|placeholder):/.test(m?.[1] ?? "") ? "" : scalar(m?.[1] ?? "");
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)- (generic|listitem|group|none|presentation)( \[[^\]]*\])*( \[ref=e\d+\])/.exec(line);
    if (!m || /\[cursor=pointer\]/.test(line)) continue;
    const ind = indentOf(line);
    const parts = [ownWords(line)];
    for (let j = i + 1; j < lines.length && indentOf(lines[j]!) > ind; j++) parts.push(ownWords(lines[j]!));
    const said = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!said) continue;
    const rowBox = /\[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/.exec(line)?.slice(1).map(Number);
    const placed = boxes.get(said);
    // A row with no box (a snapshot without boxes) is matched by words only when it is the only one with them.
    const byBox = placed && (rowBox ? placed.some((b) => near(b, rowBox)) : placed.length === 1 && lines.filter((l) => l.includes(said)).length === 1);
    if (!want.has(said) && !byBox) continue;
    const at = line.indexOf(m[4]!) + m[4]!.length;
    lines[i] = `${line.slice(0, at)} [cursor=pointer]${line.slice(at)}`;
  }
  return lines.join("\n");
}

/**
 * A look at the page now. `prev`, the last look (or its refs): what is new since is shown near the
 * top. `cap`: the room, the actor's by default. `onSite`: whether an embedded page's address is on
 * the test's site, so its elements may be offered.
 */
export async function observe(page: Page, mask: (s: string) => string = (s) => s, prev?: Pick<Snapshot, "allRefs" | "itemRefs"> | Set<string>, cap = SNAPSHOT_CHARS, o: { onSite?: (url: string) => boolean; restCap?: number } = {}): Promise<Snapshot> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  let yaml = await page.ariaSnapshot({ mode: "ai", boxes: true, timeout: 5000 }).catch(() => page.ariaSnapshot({ mode: "ai", timeout: 5000 }).catch(() => ""));
  const fields = await page.evaluate(invalidFields).catch(() => [] as Field[]);
  // W5: a row clickable only by its code (an onclick, a tabindex) is numbered as one with a pointer is.
  const clickable = await page.evaluate(clickableWords).catch(() => [] as Clickable[]);
  if (clickable.length) yaml = markClickable(yaml, clickable);
  const viewport = page.viewportSize() ?? undefined;
  const prevRefs = prev instanceof Set ? prev : prev?.allRefs;
  const frames = await framesOf(page, yaml, mask, o.onSite).catch(() => ({}));
  const prevItems = prev instanceof Set ? undefined : prev?.itemRefs;
  const c = compact(yaml, mask, cap, fields, { ...(prevRefs ? { prev: prevRefs } : {}), ...(prevItems ? { prevItems } : {}), ...(viewport ? { viewport } : {}), frames, ...(o.restCap !== undefined ? { restCap: o.restCap } : {}) });
  const url = page.url();
  return { url: mask(withoutSecrets(url)), title: mask(await page.title().catch(() => "")), ...c, keys: createHash("sha1").update(`${url}\n${c.keys}`).digest("hex") };
}

/** An address as a change line says it: its path and query, without secrets, clipped. */
function pathAndQuery(url: string): string {
  try {
    const u = new URL(withoutSecrets(url));
    return clip(`${u.pathname}${u.search}`, 100);
  } catch {
    return clip(url, 100);
  }
}

/**
 * What an action changed, as one line for the actor's history: where the page went, what opened or
 * closed, where the focus moved, how many elements came or went, or that nothing changed (the
 * fingerprint is the same). Built from the two looks only (masked already): it steers the actor,
 * never a verdict.
 */
export function changeOf(before: Snapshot, after: Snapshot): string {
  if (before.keys === after.keys && before.url === after.url) return "→ no change on the page";
  if (before.url !== after.url) {
    // Masked addresses: a value masked inside a port ("5{cvc}0") is no longer an address, and differs.
    const parse = (u: string) => {
      try {
        return new URL(u, "http://x/");
      } catch {
        return undefined;
      }
    };
    const a = parse(before.url);
    const b = parse(after.url);
    if (!a || !b || a.origin !== b.origin || a.pathname !== b.pathname || a.search !== b.search) return `→ went to ${pathAndQuery(after.url)}`;
  }
  const added = [...after.usable].filter((r) => !before.usable.has(r)).length;
  const gone = [...before.usable].filter((r) => !after.usable.has(r)).length;
  const parts: string[] = [];
  // What the page now says out loud (role=alert), word for word: "6 new elements appeared" alone loses it once the actor goes back a page.
  for (const a of (after.alerts ?? []).filter((x) => !(before.alerts ?? []).includes(x)).slice(0, 2)) parts.push(`the page says "${a}"`);
  const opened = after.open.filter((w) => !before.open.includes(w));
  const closed = before.open.filter((w) => !after.open.includes(w));
  for (const w of opened) parts.push(`opened: ${w}${added ? `, with ${added} new element${added === 1 ? "" : "s"} (shown first)` : ""}`);
  for (const w of closed) parts.push(`closed: ${w}`);
  // The focused element itself, not what it now holds: typing into a box doesn't move the focus.
  const which = (f?: string) => (f ?? "").replace(/\]: .*$/, "]");
  if (after.focused && which(after.focused) !== which(before.focused)) parts.push(`focus moved to ${clip(after.focused, 80)}`);
  else if (after.focused && after.focused !== before.focused && !opened.length && !added && !gone) parts.push("the focused field changed; nothing else did");
  if (!opened.length && added) parts.push(`${added} new element${added === 1 ? "" : "s"} appeared`);
  if (!closed.length && gone) parts.push(`${gone} element${gone === 1 ? "" : "s"} went away`);
  // What an arrow key or a toggle moved: an element's state, said by the elements that now have it.
  const nowState = (after.states ?? []).filter((x) => !(before.states ?? []).includes(x));
  if (!parts.length && nowState.length) parts.push(`now ${nowState.slice(0, 2).map((x) => clip(x, 80)).join(", ")}${nowState.length > 2 ? ` and ${nowState.length - 2} more` : ""}`);
  else if (!parts.length && (before.states ?? []).some((x) => !(after.states ?? []).includes(x))) parts.push("an element's state changed");
  if (!parts.length && before.words !== undefined && before.words !== after.words) parts.push("the page's words changed (nothing you can use came or went)");
  if (!parts.length) parts.push(before.screen !== after.screen ? "the page moved; nothing else changed" : "something changed on the page, but nothing you can use");
  return `→ ${parts.join("; ")}`;
}
