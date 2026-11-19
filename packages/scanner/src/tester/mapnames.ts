/**
 * What a map-mode walk saw (the parts), and the features named from it by fixed rules (any-site plan
 * 5.2, wave M1). Pure: no browser, no AI. The walk is mapcrawl.ts; the hold is mapmode.ts.
 *
 * M1's naming is an interim, deterministic one, so the map can be scored (cli/bench/mapscore.ts):
 * M2 replaces it with purpose, verb and entity from understanding. The rules, the same on every site:
 *   - A form is one feature. Its verb comes first from what its Save sent (a held request with a
 *     REST-shaped address: POST /contacts makes one, PATCH /contacts/:id changes it, /create, /delete),
 *     then from its heading or button ("New contact", "Edit profile", "Save changes"), then from its
 *     fields (any filled in already: an update; none: a create). Its entity is its heading's noun, or
 *     the page's.
 *   - A list is one read of its heading's noun, however many rows it has, on however many pages.
 *   - A row's control is one feature for the whole list ("Delete Tobias-357" on each row is one
 *     delete of a contact): its verb from its first word, its entity the list's, unless its words
 *     name another ("Add to wishlist": a wishlist item; "Buy now": an order).
 *   - A group of switches is one change of settings.
 *   - A filter, sort or search control is one filter (or search) of the list it sits by.
 *   - Two features with the same verb and entity are one feature, with every page and control.
 */
import { clueVerb, type HeldClue } from "../mapmode.ts";

export interface MapField {
  label: string;
  type: string;
  required: boolean;
  /** A list's, a radio group's or a combobox's choices, as shown (at most 12). */
  choices?: string[];
  /** It had a value before the walk filled anything in. */
  prefilled?: boolean;
  /** Why the walk left it empty (a password, a code, a file). */
  leftEmpty?: string;
}

export interface MapForm {
  /** The heading over the form ("New contact"), or "". */
  heading: string;
  fields: MapField[];
  /** The button that sends it ("Save"), or "Enter" for a box with no button. */
  submit?: string;
  /** The control that opened it (a "New project" button, a row's "Edit"), when it wasn't on the page. */
  entry?: string;
  /** Buttons pressed on the way (a wizard's Next, Next, then Save). */
  presses: string[];
  /** Steps seen (a wizard has more than one). */
  steps: number;
  /** What happened when it was sent, in plain words. */
  outcome: string;
  /** Clues (HeldClue.n) its last press sent, held. */
  held: number[];
  /** Clues sent while it was only being typed into: it saves as you type. */
  savesAsYouType?: number[];
  search?: boolean;
  /** "get" for a <form method=get>, "post", or undefined when there is no <form>. */
  method?: "get" | "post";
  /** Why it was never sent: a password field, another site's address, a floor word. */
  notPressed?: string;
  /** Where it was: on the page, opened by a control, or in a row. */
  via: "page" | "entry" | "row";
}

export interface MapRowAction {
  /** Its name with the row's own words taken out ("Delete Tobias-357" -> "Delete"). */
  name: string;
  /** What pressing it did, when it was pressed. */
  outcome?: string;
  /** The label of a box it opened in the row ("New name"). */
  field?: string;
  held: number[];
  notPressed?: string;
}

export interface MapList {
  heading: string;
  kind: "table" | "list" | "rows";
  columns: string[];
  rows: number;
  /** One row's text, clipped and masked: what a row looks like, never the list. */
  sample?: string;
  rowActions: MapRowAction[];
}

export interface MapSwitchGroup {
  heading: string;
  names: string[];
  /** Clues the first press sent, held: they save the moment they're pressed. */
  held: number[];
}

export interface MapControl {
  name: string;
  kind: "filter" | "entry" | "search" | "other";
  outcome?: string;
  held: number[];
  notPressed?: string;
}

export interface MapView {
  n: number;
  /** The path as seen (masked, no query secrets). */
  path: string;
  /** The path with ids as :id and the query keys only: views with the same pattern and layout are one. */
  pattern: string;
  /** The first part of the path under the start: "" for the start's own. */
  area: string;
  depth: number;
  title: string;
  heading: string;
  from?: { path: string; words: string };
  /** The presses that show this state of the page (a tab, a menu's section), when its address alone doesn't. */
  via?: string[];
  forms: MapForm[];
  lists: MapList[];
  switches: MapSwitchGroup[];
  controls: MapControl[];
  /** Counts and totals shown ("12 contacts", "Total: £40.00"), at most 10. */
  counts: string[];
  /** Empty-state words ("No tasks yet"). */
  empty: string[];
  /** Links and controls left alone, and why. */
  leftAlone: string[];
  /** Why only part of it was seen ("a request it makes on load was held: POST /api/records"). */
  partlySeen: string[];
}

export type FeatureVerb = "create" | "read" | "update" | "delete" | "filter" | "search" | "export" | "other";

/** One feature, in the shape learn's map.json actions have (id, name, pages, onScreen), plus its verb, entity and parts. */
export interface MapFeature {
  id: string;
  name: string;
  verb: FeatureVerb;
  entity: string;
  /** Pages it was seen on, as paths. */
  pages: string[];
  /** Its main control. */
  onScreen?: string;
  controls: string[];
  from: ("form" | "list" | "row" | "switches" | "filter" | "search" | "entry" | "page" | "clue")[];
  /** Set when one verb and thing has more than one feature: "detail" (one record's page), or a status word ("archive"). */
  kind?: string;
  /** Clues (HeldClue.n) behind it. */
  held: number[];
  notes: string[];
}

const T = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const LEADING = new Set(["a", "an", "the", "new", "add", "create", "edit", "update", "manage", "view", "your", "my", "all", "our", "see", "open", "show"]);
const LINKING = new Set(["to", "for", "from", "by", "in", "on", "with", "into", "at", "as", "and", "of"]);
/** Headings that name a step or a part, never a thing. */
const GENERIC = /^(review|details?|step( \d+)?( of \d+)?|form|summary|confirm(ation)?|general|basics?|info(rmation)?|overview|options|more|other)$/i;
/** Words after a verb that name no thing ("Buy now", "Delete it", "Remove selected"), and file formats ("Export CSV"). */
const FILLER = new Set(["now", "it", "this", "that", "all", "selected", "one", "item", "again", "here", "them", "me", "csv", "pdf", "excel", "xlsx", "xls", "json", "xml", "data", "file"]);

/** A word's singular, by the plain English rules (contacts, entries, boxes, addresses), leaving "news", "status", "class". */
export function singular(w: string): string {
  if (w.length <= 3 || /(ss|us|is|news)$/.test(w)) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(sses|xes|ches|shes|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** A thing's name from a heading or a label: articles and verbs dropped at the start, cut at a linking word, the last word singular. */
export function entityOf(text: string | undefined): string | undefined {
  const words = T(text).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(" ").filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (!out.length && LEADING.has(w)) continue;
    if (LINKING.has(w)) break;
    out.push(w);
    if (out.length >= 3) break;
  }
  if (!out.length || (out.length === 1 && FILLER.has(out[0]!))) return undefined;
  if (GENERIC.test(out.join(" "))) return undefined;
  out[out.length - 1] = singular(out.at(-1)!);
  return out.join(" ");
}

/** Words of a control or a heading that say the kind of job. */
const WORDS: [RegExp, FeatureVerb][] = [
  [/^(new|add|create|make|insert|\+)$/, "create"],
  [/^(edit|rename|update|change|modify|set|save|archive|unarchive|publish|unpublish|mark|complete|approve|reject|assign|move|toggle|enable|disable|turn)$/, "update"],
  [/^(delete|remove|trash|destroy|discard|erase|🗑|🗑️|✕|×)$/, "delete"],
  [/^(view|open|show|see|details|read|list|browse|refresh|reload)$/, "read"],
  [/^(filter|sort|clear|only)$/, "filter"],
  [/^(search|find|look)$/, "search"],
  [/^(export|download)$/, "export"],
  [/^(buy|purchase|order|checkout|pay)$/, "create"],
  [/^(undo|restore|duplicate|copy|clone|share|invite|send|import|sync|retry|join|accept|decline|leave)$/, "other"],
];

const wordsOf = (s: string) => T(s).toLowerCase().replace(/[^\p{L}\p{N}\s+🗑×✕-]/gu, " ").split(" ").filter(Boolean);

/** A control's verb and the thing its own words name (if any), from its words alone. */
export function controlMeaning(name: string): { verb?: FeatureVerb; object?: string } {
  const words = wordsOf(name);
  if (!words.length) return {};
  // Acting on the view, not on data: "Remove filter", "Clear search", "Show all", "Sort by date".
  if (words.some((w) => /^(filters?|sort(ed|ing)?)$/.test(w)) || /^show (all|archived|active|more)\b/.test(words.join(" "))) return { verb: "filter" };
  if (words[0] === "clear" && words[1] === "search") return { verb: "search" };
  const first = words[0]!;
  const verb = WORDS.find(([re]) => re.test(first))?.[1];
  if (!verb) return {};
  // Buying makes an order, whatever the button calls the rest.
  if (/^(buy|purchase|order|checkout)$/.test(first)) return { verb: "create", object: "order" };
  // "Add to wishlist", "Save to favourites", "Move to archive": the thing is the place it goes to.
  if (LINKING.has(words[1] ?? "") && words[1] !== "and") {
    const place = entityOf(words.slice(2).join(" "));
    return { verb, ...(place && (words[1] === "to" || words[1] === "into") ? { object: place } : {}) };
  }
  const object = entityOf(words.slice(1).join(" "));
  return { verb, ...(object ? { object } : {}) };
}

/** Status changes keep their own name: "Archive project" is not "Update project", though both are updates. */
const STATUS = /^(archive|unarchive|publish|unpublish|approve|reject|complete|reopen|close|cancel|mark|assign|unassign|lock|unlock|pin|unpin|star|unstar)$/;
export const statusWord = (name: string): string | undefined => {
  const w = wordsOf(name)[0];
  return w && STATUS.test(w) ? w : undefined;
};

/** A form's verb: its held request first (REST-shaped addresses only), then its heading and button, then its fields. */
export function formVerb(f: Pick<MapForm, "heading" | "submit" | "fields" | "held" | "search" | "presses" | "method" | "savesAsYouType"> & { outcome?: string }, clues: readonly HeldClue[]): FeatureVerb {
  if (f.search) return "search";
  // What the form sent, held, says first: a script's form (onSubmit) often says no method at all.
  // Every held request is a write by map mode's rule (a GET is held only when its address commands).
  const writes = f.held.map((n) => clues.find((x) => x.n === n)).filter((c): c is HeldClue => Boolean(c));
  // A form whose own method is GET asks for a view; it never writes (HTML's own rule): only when it
  // says so, or when it went somewhere and sent nothing but reads (a form with no method is sent by GET).
  const asksForView = f.method === "get" || (f.method !== "post" && !writes.length && /^went to /.test(f.outcome ?? ""));
  if (asksForView && !writes.length) return controlMeaning(f.submit ?? "").verb === "search" ? "search" : "filter";
  // A box with no button that sends as it's typed into edits what's there.
  if (f.submit === "Enter" && f.savesAsYouType?.length && !f.held.some((n) => !f.savesAsYouType!.includes(n))) return "update";
  for (const c of writes) {
    const v = clueVerb(c);
    if (v) return v;
  }
  const heading = controlMeaning(f.heading).verb;
  if (heading === "create" || heading === "update") return heading;
  const submit = f.submit ? wordsOf(f.submit) : [];
  if (/^(add|create|new|post|make)$/.test(submit[0] ?? "")) return "create";
  if (/^(update|change|edit|rename)$/.test(submit[0] ?? "") || (submit[0] === "save" && submit[1] === "changes")) return "update";
  return f.fields.some((x) => x.prefilled && !/^(checkbox|radio|select|switch|hidden)$/.test(x.type)) ? "update" : "create";
}

/** What a form makes or changes: its heading's thing, else the one its single box names ("New trade" box), else the page's. */
export function formEntity(f: Pick<MapForm, "heading" | "fields">, view: Pick<MapView, "heading" | "title">): string | undefined {
  const own = entityOf(f.heading);
  if (own) return own;
  const label = f.fields.length === 1 ? f.fields[0]!.label : "";
  if (/^(new|add|create)\b/i.test(T(label))) {
    const e = entityOf(label);
    if (e) return e;
  }
  return entityOf(view.heading) ?? entityOf(view.title.split(" · ")[0]);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The thing a one-record view shows, from its address: "/projects/:id" -> "project", "/z/:id/" -> none. */
export function detailEntity(pattern: string): string | undefined {
  const parts = pattern.split("?")[0]!.split("/").filter(Boolean);
  const at = parts.lastIndexOf(":id");
  if (at < 1 || at !== parts.length - 1 || (at === 1 && parts[0]!.length <= 2)) return undefined;
  const e = entityOf(parts[at - 1]!.replace(/[-_]/g, " "));
  return e;
}
const NAME: Record<FeatureVerb, string> = { create: "Create", read: "View", update: "Update", delete: "Delete", filter: "Filter", search: "Search", export: "Export", other: "Use" };

/** The features of a whole walk, by the rules at the top of this file. */
export function featuresOf(views: readonly MapView[], clues: readonly HeldClue[] = []): MapFeature[] {
  const out: MapFeature[] = [];
  const add = (verb: FeatureVerb, entity: string | undefined, page: string, controls: (string | undefined)[], from: MapFeature["from"][number], held: number[] = [], note?: string, name?: string, kind = "") => {
    if (!entity) return;
    const cs = [...new Set(controls.map((c) => T(c)).filter(Boolean))];
    const same = out.find((f) => f.verb === verb && f.entity === entity && (f.kind ?? "") === kind);
    if (same) {
      if (!same.pages.includes(page)) same.pages.push(page);
      for (const c of cs) if (!same.controls.includes(c)) same.controls.push(c);
      if (!same.from.includes(from)) same.from.push(from);
      for (const h of held) if (!same.held.includes(h)) same.held.push(h);
      if (note && !same.notes.includes(note)) same.notes.push(note);
      same.onScreen ??= cs[0];
      return;
    }
    out.push({ id: `${entity.replace(/\s+/g, "_")}.${kind || verb}`, name: name ?? `${kind ? cap(kind) : NAME[verb]} ${entity}${kind === "detail" ? " details" : ""}`, verb, entity, ...(kind ? { kind } : {}), pages: [page], ...(cs[0] ? { onScreen: cs[0] } : {}), controls: cs, from: [from], held: [...held], notes: note ? [note] : [] });
  };
  for (const v of views) {
    // A view of one record (/projects/:id): its thing is named by the address part before the id, not by its heading (the record's name).
    const detail = detailEntity(v.pattern);
    const listEntity = v.lists.map((l) => entityOf(l.heading)).find(Boolean) ?? detail ?? entityOf(v.heading);
    if (detail) add("read", detail, v.path, [], "page", [], undefined, undefined, "detail");
    for (const f of v.forms) {
      const verb = formVerb(f, clues);
      const entity = verb === "search" || verb === "filter" ? listEntity : (entityOf(f.heading) ?? detail ?? formEntity(f, v));
      const note = f.notPressed ? `not sent: ${f.notPressed}` : f.steps > 1 ? `${f.steps} steps` : f.savesAsYouType?.length ? "saves as you type" : undefined;
      // A box with no button is known by its own label ("Draft", "New trade").
      add(verb, entity, v.path, [f.submit, f.entry, ...f.presses, ...(f.submit === "Enter" ? f.fields.map((x) => x.label) : [])], verb === "search" ? "search" : f.via === "entry" ? "entry" : "form", [...f.held, ...(f.savesAsYouType ?? [])], note);
    }
    for (const l of v.lists) {
      const entity = entityOf(l.heading) ?? entityOf(v.heading);
      add("read", entity, v.path, [l.heading || v.heading], "list", [], l.rows === 0 ? "empty when seen" : undefined);
      for (const a of l.rowActions) {
        const m = controlMeaning(a.name);
        if (!m.verb) continue;
        // A row's control acts on the list's thing, unless it makes another ("Add to wishlist", "Buy now").
        add(m.verb, m.verb === "create" && m.object ? m.object : entity, v.path, [a.name, a.field], "row", a.held, a.notPressed ? `not pressed: ${a.notPressed}` : undefined, undefined, statusWord(a.name) ?? "");
      }
    }
    for (const g of v.switches) add("update", entityOf(g.heading) ?? entityOf(v.heading) ?? "setting", v.path, g.names, "switches", g.held, g.held.length ? "saves the moment it's pressed" : undefined);
    for (const c of v.controls) {
      const m = controlMeaning(c.name);
      if (c.kind === "filter" || m.verb === "filter") add("filter", listEntity, v.path, [c.name], "filter", c.held);
      else if (c.kind === "search" || m.verb === "search") add("search", listEntity, v.path, [c.name], "search", c.held);
      else if (c.kind === "entry" && m.verb) add(m.verb, m.object ?? listEntity, v.path, [c.name], "entry", c.held);
      else if (m.verb && (c.held.length || m.object || m.verb === "export") && !(m.verb === "read" && !m.object)) add(m.verb, m.object ?? listEntity, v.path, [c.name], "clue", c.held, c.notPressed ? `not pressed: ${c.notPressed}` : undefined, undefined, statusWord(c.name) ?? "");
    }
    // An empty list says so in words ("No tasks yet"): it is still a read of what the page shows.
    if (!v.lists.length && v.empty.length && !detail) add("read", entityOf(v.heading), v.path, [v.heading], "list", [], "empty when seen");
    // A page with no part of its own is a read of what it's called.
    if (!v.forms.length && !v.lists.length && !v.switches.length && !v.controls.some((c) => controlMeaning(c.name).verb)) add("read", entityOf(v.heading) ?? entityOf(v.title.split(" · ")[0]), v.path, [v.heading], "page");
  }
  return out.map((f) => ({ ...f, name: f.name.replace(/^(\w+) /, (m) => cap(m)) }));
}
