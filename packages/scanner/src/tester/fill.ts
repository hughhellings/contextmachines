/**
 * Fill the form like a real user: a step that creates or saves a record fills every field the form
 * shows, not only the ones that let Save through (a real run, 2026-11-19: the form showed an entry
 * row and an exit row and "1 still open", and the test saved an open record with row 1 alone).
 *
 * Measured with no AI, from the form the save (or a wizard's Continue) is in, right before it is
 * pressed: the visible, enabled, empty fields of that form, never a search or filter box, a file
 * upload, a password, a card, a code, a promo code, or anything disabled, read-only or hidden. When
 * some are empty, the press is held once for that form and the actor is told which (by their labels,
 * fenced as the page's words), and what the form says about being incomplete ("1 still open"). It then
 * fills them or presses again, saying why they stay empty. It is a nudge: never a verdict by itself,
 * never a press of its own, never an upload or a value the browser wouldn't type anyway.
 *
 * What was filled at each save is kept on the step (counts and the labels left empty, never a value).
 */
import { neverMadeUp } from "./values.ts";

/** One field of the form, as the page has it (read in the page by `formFields`). */
export interface RawField {
  /** How a person reads it: its label, or a column header and row, or its placeholder or name. */
  label: string;
  /** Its name, id, label, placeholder and autocomplete, lower case: what it is for. */
  hint: string;
  /** The group it sits in (its fieldset's legend, a group's label), lower case: what the group is for. */
  group?: string;
  tag: string;
  type: string;
  role: string;
  autocomplete: string;
  /** "text" for anything typed, "select", "choice" for a checkbox or a radio group. */
  kind: "text" | "select" | "choice";
  required: boolean;
  empty: boolean;
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  /** Inside a search landmark or a search form. */
  inSearch: boolean;
  /** Taken out of the keyboard's way (tabindex -1 on a native field): a trap for bots, never a person's to fill. */
  untabbable?: boolean;
  /** The words beside it in its own box, or its description (aria-describedby), lower case: "(not part of the request)". */
  note?: string;
  /** A picker that finds a value for the record as you type (a combobox, aria-autocomplete, a list). */
  picker?: boolean;
  /** It is the element the scan was taken from (a field about to be typed into). */
  self?: boolean;
}

/** The form a press is in, as the page has it. */
export interface FormScan {
  /** Where the form is: its page's path. */
  path: string;
  fields: RawField[];
  /** Lines near the form that say it isn't complete ("1 still open", "0 of 2 done"), as the page has them. */
  status: string[];
  /** The form has a password field: a sign-in or sign-up, never nudged. */
  signIn: boolean;
  /** The press is in a search form. */
  search: boolean;
  /** The pressed element is its form's submit button (a <button> in a <form>, type submit by default). */
  submits?: boolean;
  /** It says type="submit" itself, outright. */
  submitType?: boolean;
  /** Enter, pressed where the focus is, would send the form: false in a text area, an editable box or a combobox (a newline, a suggestion picked). */
  enterSends?: boolean;
  /** The words of the dialog the form is in, when it is in one (what its "Confirm" confirms). */
  dialog?: string;
}

/**
 * Runs in the page, so it is self-contained: the form `el` (a save button, or the field Enter is
 * pressed in) belongs to, and every field it shows. The form is the element's own <form> (with the
 * fields that join it from outside, form="id"), or else the nearest box around it that holds a field
 * (a wizard's panel, a dialog, a section); there, a field of another <form>, or one in a landmark or a
 * fixed widget the press isn't in (a newsletter box, a chat), isn't the form's.
 */
export function formFields(el: Element): FormScan {
  const SEL = "input, textarea, select, [contenteditable='true'], [contenteditable=''], [role=textbox], [role=combobox], [role=spinbutton], [role=radiogroup], button[aria-haspopup=listbox]";
  /** What a line near the form says when the form isn't complete; never a counter of characters, stock or time. */
  const INCOMPLETE = /\b\d+(?:[.,]\d+)?\s+(?:still\s+)?(?:open|missing|outstanding|unfilled|to go)\b|\b\d+\s+(?:[a-z]+\s+)?(?:still\s+)?(?:remaining|left)\b|\bstill open\b|\bincomplete\b|\bnot (?:yet )?(?:complete|balanced|closed|finished)\b|\bunbalanced\b/i;
  const OF = /\b(\d+)\s+of\s+(\d+)\s+(?:[a-z]+\s+){0,2}(?:filled|done|complete|completed|answered|set|entered)\b/i;
  const NOT_STATUS = /\b(characters?|chars|words|letters|in stock|stock|seats?|tickets?|places|spots|days?|hours?|minutes?|mins|seconds?|secs|attempts?|tries|(step|page)\s+\d+\s+of)\b/i;
  const incomplete = (l: string) => {
    if (NOT_STATUS.test(l)) return false;
    const of = OF.exec(l);
    if (of) return Number(of[1]) < Number(of[2]);
    return INCOMPLETE.test(l);
  };
  const press = (el.closest("button, input[type=submit], input[type=image], [role=button]") ?? el) as HTMLButtonElement;
  const isField = el.matches("input, textarea, select, [contenteditable], [role=textbox], [role=combobox], [role=spinbutton]");
  const own: HTMLFormElement | null = (el as HTMLInputElement).form ?? (press as HTMLButtonElement).form ?? el.closest("form");
  let scope: Element | null = own;
  if (!scope && isField) scope = el.closest("[role=dialog], dialog, fieldset, section, [role=form], [role=region], main");
  if (!scope) {
    let a: Element | null = el.parentElement;
    while (a && a !== document.body && !a.querySelector(SEL)) a = a.parentElement;
    scope = a ?? document.body;
  }
  const words = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const ownText = (l: Element) => words([...l.childNodes].filter((n) => n.nodeType === 3 || (n as Element).tagName === "SPAN" || (n as Element).tagName === "B" || (n as Element).tagName === "STRONG").map((n) => n.textContent ?? "").join(" "));
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const zeroClip = /rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/;
  /** Seen by a person: not hidden, see-through, off the page, or clipped into a box too small to see (a bot trap). */
  const shown = (e: Element) => {
    if (e.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
    const cv = (e as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    if (typeof cv === "function" && !cv.call(e, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(e);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) <= 0.05) return false;
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;
    if (x + r.width <= 0 || y + r.height <= 0 || x >= docW || y >= docH) return false;
    for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (Number(s.opacity) <= 0.05) return false;
      if (zeroClip.test(s.clip || "") || /inset\(\s*50%|circle\(\s*0(?:px)?\s*(?:at|\))/.test(s.clipPath || "")) return false;
      if (s.overflow !== "visible" || s.overflowX !== "visible" || s.overflowY !== "visible") {
        const b = a.getBoundingClientRect();
        if (b.width <= 1 || b.height <= 1) return false;
        // Clipped wholly away by a box that hides what overflows (never one that scrolls: a person scrolls it).
        const hides = /hidden|clip/.test(`${s.overflowX} ${s.overflowY}`);
        if (hides && (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom)) return false;
      }
    }
    return true;
  };
  /** A field in a box that isn't the press's: another landmark or a fixed widget (a newsletter, a chat), when the form has no <form>. */
  const LANDMARK = "aside, footer, header, nav, [role=complementary], [role=contentinfo], [role=banner], [role=navigation], [role=search], search";
  const apart = (e: Element) => {
    if (own) return false;
    if ((e as HTMLInputElement).form) return true;
    for (let a = e.parentElement; a && a !== scope && a !== document.body; a = a.parentElement) {
      if (a.contains(el)) break;
      if (a.matches(LANDMARK)) return true;
      const pos = getComputedStyle(a).position;
      if (pos === "fixed" || pos === "sticky") return true;
    }
    return false;
  };
  /** A field in a table with no label of its own: its column's header and its row ("Qty, row 2"). */
  const fromTable = (e: Element) => {
    const cell = e.closest("td, [role=cell], [role=gridcell]") as HTMLTableCellElement | null;
    const row = cell?.closest("tr, [role=row]") as HTMLTableRowElement | null;
    const table = row?.closest("table, [role=table], [role=grid]");
    if (!cell || !row || !table) return "";
    const head = table.querySelector("thead tr, [role=row]:has([role=columnheader])");
    const idx = [...row.children].indexOf(cell);
    const th = head && head !== row ? head.children[idx] : undefined;
    const rows = [...table.querySelectorAll("tbody tr, [role=rowgroup] [role=row]")].filter((r) => r !== head);
    const n = rows.indexOf(row) + 1;
    return th && words(th.textContent) ? `${words(th.textContent)}${n > 0 ? `, row ${n}` : ""}` : "";
  };
  const tidy = (s: string) => s.replace(/[\s:*]+$/, "").trim();
  const labelOf = (e: Element) => {
    const f = e as HTMLInputElement;
    const by = e.getAttribute("aria-labelledby");
    const labelled = by ? words(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")) : "";
    const lab = f.labels?.[0] ?? e.closest("label");
    return tidy((words(e.getAttribute("aria-label")) || labelled || (lab ? ownText(lab) || words(lab.textContent) : "") || fromTable(e) || words(e.getAttribute("placeholder")) || words(e.getAttribute("title")) || words(e.getAttribute("name")) || e.id || "").slice(0, 60));
  };
  const groupOf = (e: Element) => {
    const fs = e.closest("fieldset");
    const g = e.closest("[role=group], [role=region]");
    const gl = g ? words(g.getAttribute("aria-label")) || words(g.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")) : "";
    return `${words(fs?.querySelector("legend")?.textContent)} ${gl}`.trim().toLowerCase().slice(0, 120);
  };
  /** The words beside a field in its own small box (the box holds no other field), and its description: what it says it is for. */
  const noteOf = (e: Element) => {
    const by = e.getAttribute("aria-describedby");
    const described = by ? words(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")) : "";
    const lab = (e as HTMLInputElement).labels?.[0] ?? e.closest("label");
    const wrap = (lab && lab.contains(e) ? lab : (lab ?? e)).parentElement;
    const own = wrap && wrap !== scope && wrap !== document.body && wrap.querySelectorAll(SEL).length === 1 ? words((wrap as HTMLElement).innerText ?? wrap.textContent) : "";
    return `${described} ${own.length <= 240 ? own : ""}`.trim().toLowerCase().slice(0, 240);
  };
  /** A custom picker's chosen value: its text, unless that is only a prompt to choose. */
  const pickerEmpty = (e: Element) => {
    const t = words(e.getAttribute("aria-valuetext")) || words((e as HTMLElement).innerText ?? e.textContent);
    const ph = words(e.getAttribute("aria-placeholder") ?? e.getAttribute("data-placeholder"));
    return !t || (ph !== "" && t === ph) || /^(select|choose|pick|please (select|choose))\b|^[-–—…]+$/i.test(t);
  };
  // Every field of the form, the ones joining it from outside (form="id") too; or every field in the box.
  const found = new Set<Element>(scope.querySelectorAll(SEL));
  if (own) for (const e of own.elements) if (e.matches(SEL)) found.add(e);
  const out: FormScan["fields"] = [];
  const groups = new Set<string>();
  for (const e of [...found].slice(0, 160)) {
    const f = e as HTMLInputElement;
    const tag = e.tagName.toLowerCase();
    const role = (e.getAttribute("role") ?? "").toLowerCase();
    // A button that opens a list to pick from is a picker, whatever its type says.
    const type = tag === "button" ? "" : (e.getAttribute("type") ?? (tag === "input" ? "text" : "")).toLowerCase();
    if (role === "radiogroup") continue;
    // A field of another <form> (form="other", a newsletter box) isn't this form's.
    if (own && f.form && f.form !== own) continue;
    if (apart(e)) continue;
    // A combobox's own text box is the field; a role on a wrapper around a real field isn't another one.
    if (tag !== "input" && tag !== "textarea" && tag !== "select" && e.querySelector("input, textarea, select")) continue;
    const label = labelOf(e);
    const hint = [e.getAttribute("name"), e.id, label, e.getAttribute("placeholder"), e.getAttribute("autocomplete")].filter(Boolean).join(" ").toLowerCase();
    const disabled = Boolean(f.disabled) || e.matches(":disabled") || e.getAttribute("aria-disabled") === "true" || Boolean(e.closest("[aria-disabled='true']"));
    const readonly = Boolean(f.readOnly) || e.getAttribute("aria-readonly") === "true";
    const inSearch = Boolean(e.closest("[role=search], search, form[role=search]"));
    const required = Boolean(f.required) || e.getAttribute("aria-required") === "true";
    const untabbable = (tag === "input" || tag === "textarea" || tag === "select") && e.getAttribute("tabindex") === "-1";
    const note = noteOf(e);
    const picker = role === "combobox" || e.hasAttribute("aria-autocomplete") || e.hasAttribute("list");
    const base = { hint, group: groupOf(e), tag, type, role, autocomplete: (e.getAttribute("autocomplete") ?? "").toLowerCase(), required, visible: shown(e), disabled, readonly, inSearch, untabbable, ...(note ? { note } : {}), ...(picker ? { picker } : {}), ...(e === el ? { self: true } : {}) };
    if (type === "radio") {
      // A radio group is one field: empty while none of it is chosen.
      const name = f.name || label;
      if (groups.has(name)) continue;
      groups.add(name);
      const all = f.name ? [...found].filter((r) => r.matches(`input[type=radio]`) && (r as HTMLInputElement).name === f.name) as HTMLInputElement[] : [f];
      const legend = words(e.closest("fieldset")?.querySelector("legend")?.textContent) || words(e.closest("[role=radiogroup]")?.getAttribute("aria-label")) || f.name || label;
      out.push({ ...base, label: tidy(legend).slice(0, 60), kind: "choice", required: all.some((r) => r.required), empty: !all.some((r) => r.checked), visible: all.some(shown) });
      continue;
    }
    if (type === "checkbox") {
      out.push({ ...base, label, kind: "choice", empty: !f.checked });
      continue;
    }
    const native = tag === "input" || tag === "textarea" || tag === "select";
    const editable = (e as HTMLElement).isContentEditable;
    const empty = tag === "select" ? !String((e as HTMLSelectElement).value).trim() : native ? !String(f.value ?? "").trim() : editable ? !words(e.textContent) : role === "combobox" || tag === "button" || role === "spinbutton" ? pickerEmpty(e) : !words(e.textContent);
    out.push({ ...base, label, kind: tag === "select" || (!native && !editable && (role === "combobox" || tag === "button")) ? "select" : "text", empty });
  }
  // What the form says about being complete: its own lines, and the box around it when it is small.
  const text = (scope as HTMLElement).innerText ?? scope.textContent ?? "";
  const status = [...new Set(text.split(/\n+/).map(words).filter((l) => l.length <= 100 && incomplete(l)))].slice(0, 2);
  const form = own ?? scope;
  // Enter sends a form from a one-line box; in a text area or an editable box it is a newline, in a combobox it picks a suggestion.
  const fe = el as HTMLInputElement;
  const enterSends = isField && el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image", "range", "color"].includes((fe.type || "").toLowerCase()) && (el.getAttribute("role") ?? "").toLowerCase() !== "combobox" && !el.hasAttribute("aria-autocomplete") && !el.hasAttribute("list") && el.getAttribute("aria-expanded") !== "true";
  const dialog = el.closest("[role=dialog], [role=alertdialog], dialog");
  const isButton = press.matches("button, input[type=submit], input[type=image]");
  return {
    path: location.pathname,
    fields: out,
    status,
    signIn: Boolean(form.querySelector("input[type=password]")),
    search: Boolean(el.closest("[role=search], search, form[role=search]")) || (own !== null && own.getAttribute("role") === "search"),
    submits: Boolean(own) && isButton && (press.type === "submit" || (press as unknown as HTMLInputElement).type === "image"),
    submitType: isButton && (press.getAttribute("type") ?? "").toLowerCase() === "submit",
    enterSends,
    ...(dialog ? { dialog: words((dialog as HTMLElement).innerText ?? dialog.textContent).slice(0, 300) } : {}),
  };
}

/** Types never filled by a nudge: buttons, hidden fields, files, passwords, searches, sliders, colours. */
const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "file", "password", "search", "range", "color"]);
/** A box for finding, not for the record: a search, a filter, a "jump to", a store locator. */
const SEARCH = /\b(search|filters?|query|look ?up|jump to|nearest|near (me|you)|locator)\b|^find\b|\bfind (a|an|the|by|my|your)\b/;
/**
 * A field for another purpose, or one only a person has a value for: a promo, coupon, voucher, offer,
 * referral, gift or membership code, a gift's own words, a captcha, one the form says to leave blank or
 * not to fill (a bot trap), fill "only if", "if different", one for the office or staff, one typed to
 * confirm a change.
 */
const OTHER_PURPOSE = /\b(promo(tion(al)?)?|coupon|voucher|discount (code|voucher)|offer code|referr(al|er)|gift|redeem|captcha|loyalty|membership (no|number|id|code)|member (no|number|id)|reward (no|number|code))\b|\bleave (this |it |the )?(field |box )?(blank|empty)\b|\b(do not|don't|dont|never) (fill|complete|enter|type|change|touch)\b|\bif you are (a )?human\b|\bfor (robots|bots)\b|\bhoney ?pot\b|\bonly (fill( in| out)? )?if\b|\bif (different|not the same|applicable)\b|\b(office|internal|admin(istrative)?|staff|official) (use|only)\b|\bstaff (ref(erence)?|notes?)\b|\bto confirm\b|\btype\b.{0,40}\bto (continue|delete|proceed|confirm)\b/;
/** A field whose own note says it isn't part of what is saved: "(not part of the request)", "isn't saved with your order". */
const NOT_RECORD = /\b(not|isn't|is not|never) (a )?part of (this|the|your) (request|order|form|record|booking|application|submission|entry|appointment|invoice)\b|\b(not|isn't|is not|never) (saved|sent|stored|kept) (with|in|as part of) (this|the|your) (request|order|form|record|booking|application|submission|entry|appointment|invoice)\b|\bseparate from (this|the|your) (form|request|order|record|booking)\b/;
/** A field for a message (what values.ts never makes up), or one that sends what it holds: an invite, a copy, a notice. */
const SPEAKS = /\b(message|comments?|feedback|enquiry|inquiry|question|your note|chat|your review)\b|\b(invit(e|ee|ation)|cc|bcc|notify|forward( to)?|share with|copy to|send (a copy |it |this )?to|email (a copy|it|this) to|recipients? email)\b/;
/** A box ticked to agree, to say who one is or be sent things: never ticked to fill a form. */
const CONSENT = /\b(terms|agree|accept|consent|privacy|policy|confirm|certify|acknowledge|understand|authori[sz]e|over \d+|aged? \d+|\d+ or over|newsletter|marketing|subscribe|remember me|keep me|updates|offers)\b/;

/** A field a real user filling in this form would fill (whatever its value now). */
export function fillable(f: RawField): boolean {
  if (!f.visible || f.disabled || f.readonly || f.inSearch || f.untabbable) return false;
  if (SKIP_TYPES.has(f.type) || f.role === "searchbox") return false;
  if (SEARCH.test(f.hint) || OTHER_PURPOSE.test(f.hint) || SPEAKS.test(f.hint)) return false;
  if (f.group && (OTHER_PURPOSE.test(f.group) || SEARCH.test(f.group))) return false;
  if (f.note && NOT_RECORD.test(f.note)) return false;
  if (neverMadeUp({ type: f.type, hint: f.hint, autocomplete: f.autocomplete })) return false;
  // A box or a radio group is only the form's when it must be chosen, and never one to agree or be sent things.
  if (f.kind === "choice") return f.required && !CONSENT.test(f.hint);
  return true;
}

/**
 * A box that is for something else than the record the step makes, by its own words: a search, a
 * filter, a finder or a locator ("Nearest clinic"), a code or a gift's words, one to leave blank, one
 * whose note says it isn't part of the record. Never a picker that finds a value for the record (a
 * combobox "Search customers" fills the record). Typing there in a step that makes a record is held
 * once (run.ts): the actor is asked to leave it, unless the goal or step names it.
 */
export function forAnotherPurpose(f: RawField): boolean {
  if (f.picker || f.kind !== "text") return false;
  if (f.inSearch || f.type === "search" || f.role === "searchbox") return true;
  if (SEARCH.test(f.hint) || OTHER_PURPOSE.test(f.hint)) return true;
  if (f.group && (OTHER_PURPOSE.test(f.group) || SEARCH.test(f.group))) return true;
  return Boolean(f.note && NOT_RECORD.test(f.note));
}

/** Words of a field's label the goal or step would use to name it (4 letters or more, never a filler). */
const FILLER = new Set(["your", "this", "that", "with", "from", "only", "here", "field", "box", "name", "number", "enter", "type", "optional", "required"]);
/** The goal or step names this field (so typing there is what it asks for). */
export function namedIn(label: string, words: string): boolean {
  const said = ` ${words.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !FILLER.has(w)).some((w) => said.includes(` ${w} `) || said.includes(` ${w}s `));
}

/** What the actor is told when it is about to type into a box for another purpose (fill.ts forAnotherPurpose). */
export function asideProblem(label: string): string {
  return `That box wasn't typed into: ${fence(clean(label) || "a field with no label")} reads as a box for something other than the record this step makes (a search, a finder, a code, or one its note says isn't part of it). A real user leaves it empty: skip it and fill only the record's own fields. Only if the goal plainly asks for it, fill it again. You are told this once.`;
}

/** The fields the form shows that a real user would fill, and those of them still empty. */
export function shownFields(scan: Pick<FormScan, "fields">): { shown: RawField[]; empty: RawField[] } {
  const shown = scan.fields.filter(fillable);
  return { shown, empty: shown.filter((f) => f.empty) };
}

/**
 * A form, as the nudge knows it: its page and what its fields are (labels without their row number).
 * A form redrawn with the same fields is the same form, and so is a table that grew a row by itself.
 */
export function formKey(scan: Pick<FormScan, "path" | "fields">): string {
  const kinds = new Set(scan.fields.filter(fillable).map((f) => f.label.replace(/,\s*row\s+\d+$/i, "").replace(/\s*#?\d+$/, "").trim().toLowerCase()));
  return `${scan.path}\n${[...kinds].sort().join("\n")}`;
}

/** A press that sends a form on, named like a save or a wizard's next page: what the nudge looks before. */
const SAVE_OR_ON = /\b(save|submit|add|create|confirm|record|place|publish|post|send|update|book|register|done|finish|apply|ok|continue|next|review|proceed)\b/i;
/** "Add another fill", "+ Add line", "Add more": a press that adds a row to the form, not one that sends it. */
const ADDS_A_ROW = /^\s*\+|\badd\s+(another|more|(a\s+)?(new\s+)?(row|line|item|leg|field|fill|entry\s+row))\b|\bnew\s+(row|line)\b/i;
/** A press that is never a record's save: a cart, a filter or a search, going back, closing, clearing, a review to write. */
const NOT_A_SAVE = /\b(cart|basket|bag|wish ?list|filters?|search|sort|write a review|cancel|back|previous|prev|close|dismiss|discard|reset|clear|undo|sign (in|out)|log (in|out)|edit|delete|remove)\b/i;
const CHOOSING = /^(radio|checkbox|switch|option|menuitemradio|menuitemcheckbox|tab|combobox|textbox|searchbox|link)$/i;
const ENTER = /^(?:(?:Control|Ctrl|Meta|Cmd|Command)\+)?(?:Enter|NumpadEnter)$/i;
type Press = { type: string; key?: string; target?: { role?: string; name?: string } };

/** A press worth reading the form for: Enter, or a click on a control that isn't a choice, a link or plainly not a save. */
export function pressCandidate(a: Press): boolean {
  if (a.type === "press") return ENTER.test(a.key ?? "");
  if (a.type !== "click" && a.type !== "dblclick") return false;
  const name = a.target?.name ?? "";
  return !CHOOSING.test(a.target?.role ?? "") && !(NOT_A_SAVE.test(name) && !/^\s*(save|submit)\b/i.test(name));
}

/** Whether this press could send the form on, by its name alone (a save, a wizard's Continue, Enter in a field). */
export function nudgePress(a: Press): boolean {
  if (!pressCandidate(a)) return false;
  if (a.type === "press") return true;
  const name = a.target?.name ?? "";
  return !ADDS_A_ROW.test(name) && SAVE_OR_ON.test(name);
}

/**
 * Whether this press sends the form it is in on, read with the form: a control named like a save, or
 * the form's own submit button whatever its word ("Lend items", "Schedule"); a row added only when it
 * says type="submit" outright; Enter only in a one-line box (never a newline or a suggestion picked).
 */
export function sendsOn(scan: Pick<FormScan, "submits" | "submitType" | "enterSends">, a: Press): boolean {
  if (!pressCandidate(a)) return false;
  if (a.type === "press") return scan.enterSends !== false;
  const name = a.target?.name ?? "";
  if (ADDS_A_ROW.test(name) && !scan.submitType) return false;
  return SAVE_OR_ON.test(name) || Boolean(scan.submits);
}

/** A step that makes a new record (add, create, record, log, register…), not one that edits one: the nudge holds only there. */
const CREATES = /\b(add|adds|adding|create|creates|creating|new|record|records|recording|log(?!\s*(?:in|on|out|off)\b)|logs|register|registers|enter|enters|make|makes|fill(?:s)? (?:in|out)|set up|book|place|compose|draft|write|submit|submits|request|requests|schedule|issue|lend|open)\b/i;
const EDITS = /\b(edit|edits|editing|update|updates|updating|change|changes|changing|rename|renames|modify|modifies|amend|amends|correct|adjust|replace|switch|toggle|turn (on|off))\b/i;
export function createsRecord(words: string): boolean {
  return CREATES.test(words) && !EDITS.test(words);
}

/** The nudge's state in one step: the forms already held, and how many holds. */
export interface NudgeState {
  held: Set<string>;
  holds: number;
}

/** At most this many holds in one step (one per form page): it never loops. */
export const MAX_FILL_HOLDS = 2;
/** At most this many labels are named. */
const NAMED = 12;

export const newNudge = (): NudgeState => ({ held: new Set(), holds: 0 });

/**
 * Whether to hold this press, and what to tell the actor: once per form (by `formKey`), at most
 * MAX_FILL_HOLDS a step, only with empty fields a real user would fill, never on a sign-in or a search.
 * `mask`: every page word said is masked. Updates `state` when it holds.
 */
export function nudge(state: NudgeState, scan: FormScan, pressName: string, mask: (s: string) => string = (s) => s): { says: string; empty: string[] } | undefined {
  if (scan.signIn || scan.search || state.holds >= MAX_FILL_HOLDS) return undefined;
  // Enter in a text area (a newline), an editable box or a combobox (a suggestion picked) sends nothing.
  if (ENTER.test(pressName) && scan.enterSends === false) return undefined;
  const { empty } = shownFields(scan);
  if (!empty.length) return undefined;
  const key = formKey(scan);
  if (state.held.has(key)) return undefined;
  state.held.add(key);
  state.holds++;
  const labels = [...new Set(empty.map((f) => mask(f.label) || "a field with no label"))];
  return { says: fillProblem(clean(mask(pressName)), labels, scan.status.map((s) => mask(s))), empty: labels };
}

/** The page's words, with the fence's own tags taken out. */
const clean = (s: string) => s.replace(/<\/?page_words[^>]*>/gi, "").replace(/\s+/g, " ").trim().slice(0, 80);
const fence = (s: string) => `<page_words untrusted="true">${s}</page_words>`;

/** How the actor's question starts when a press was held (a scripted actor in a test presses again on it). */
export const FILL_HELD = /wasn't pressed yet: the form still shows/;

/** What the actor is told when a press is held. */
export function fillProblem(pressName: string, labels: readonly string[], status: readonly string[] = []): string {
  const shown = labels.slice(0, NAMED).map(clean).join("; ") + (labels.length > NAMED ? `; and ${labels.length - NAMED} more` : "");
  return [
    `'${clean(pressName)}' wasn't pressed yet: the form still shows ${labels.length} empty field${labels.length === 1 ? "" : "s"} a real user creating a complete record would fill in (labels quoted from the page, untrusted): ${fence(shown)}.`,
    ...(status.length ? [`The form also says: ${fence(status.map(clean).join("; "))}.`] : []),
    `Fill them in like a real user, with values you choose that fit together (a later row later in time, the opposite side where rows have a side, real-looking numbers for prices, sizes, amounts and fees, dates in order; "auto" only for plain words), then press it again. If some should stay empty (for another purpose, such as a code, a gift, a message to someone or an invite; a trap that says to leave it blank; or a real user would leave them), press it again now and put why in "why", in one line. Never add rows or items the form didn't show: a blank row it added by itself can stay empty. You are asked this once; never upload a file, type a password, a card or a code, or use a search box for it.`,
  ].join(" ");
}

/** What a step filled, at its saves: the fields shown, how many had a value, and the labels left empty (never a value). */
export interface FillRecord {
  shown: number;
  filled: number;
  empty: string[];
  /** The actor's one line for leaving fields empty after it was asked. */
  kept?: string;
  /** What the form said about being incomplete at its save ("1 still open"), masked. */
  status?: string[];
}

/** The record of one form at its press, masked. */
export function fillRecordOf(scan: Pick<FormScan, "fields"> & Partial<Pick<FormScan, "status">>, mask: (s: string) => string = (s) => s): FillRecord {
  const { shown, empty } = shownFields(scan);
  const status = (scan.status ?? []).map((l) => clean(mask(l))).filter(Boolean);
  return { shown: shown.length, filled: shown.length - empty.length, empty: [...new Set(empty.map((f) => mask(f.label) || "a field with no label"))], ...(status.length ? { status } : {}) };
}

/** The forms of a step (a wizard's pages), as one record; nothing when no form showed a field. */
export function joinRecords(records: Iterable<FillRecord>, kept?: string): FillRecord | undefined {
  let shown = 0;
  let filled = 0;
  const empty: string[] = [];
  const status: string[] = [];
  for (const r of records) {
    shown += r.shown;
    filled += r.filled;
    for (const l of r.empty) if (!empty.includes(l)) empty.push(l);
    for (const l of r.status ?? []) if (!status.includes(l)) status.push(l);
  }
  if (!shown) return undefined;
  return { shown, filled, empty: empty.slice(0, 20), ...(kept ? { kept: kept.replace(/\s+/g, " ").trim().slice(0, 200) } : {}), ...(status.length ? { status: status.slice(0, 3) } : {}) };
}

/** The line a report shows: "filled 9 of 9 fields shown", or "filled 7 of 9 fields shown; left empty: Comm., Fee". */
export function fillLine(r: FillRecord): string {
  const head = `filled ${r.filled} of ${r.shown} field${r.shown === 1 ? "" : "s"} shown`;
  const said = r.status?.length ? `; the form said: ${r.status.join("; ")}` : "";
  if (!r.empty.length) return head + said;
  const list = r.empty.slice(0, 6).join(", ") + (r.empty.length > 6 ? ` and ${r.empty.length - 6} more` : "");
  return `${head}; left empty: ${list}${r.kept ? ` (${r.kept})` : ""}${said}`;
}
