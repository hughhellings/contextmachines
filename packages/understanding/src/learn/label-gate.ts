import { createHmac, randomBytes } from "node:crypto";
import type { CapturedEvent, PageSnapshot } from "@contextmachines/schemas";

/**
 * Words on screen are kept only once several different people have seen them.
 *
 * The product's own words ("Save invoice", "Import") are on everyone's screen; a tag, account or
 * strategy someone named is on theirs alone. The browser already drops what it can recognise as
 * someone's own (see controlLabel); this is the guarantee behind that: a label reaches storage,
 * the site map, the model and the report only after SHARED_BY different people have sent it.
 * Until then it is removed from the event, and the gate remembers it only as a keyed hash, so
 * a label waiting its turn is never stored as text.
 *
 * It counts people as the site identifies them: user ids are exact; without them each visit
 * (or each remembered browser) counts as one, so pass user ids for the guarantee to hold.
 */
export const SHARED_BY = 3;

/**
 * A word not yet confirmed travels as a private code: the same word gives the same code for
 * everyone, so stuck moments on it still group together, but nobody can read it. When enough
 * people have seen it, the learner swaps the code for the word everywhere (see takeRevealed).
 * A code is never shown to a person or sent to a model.
 */
export const HELD = "held:";
export const isHeld = (label: string | undefined): boolean => label !== undefined && label.startsWith(HELD);
const MAX_PENDING = 20_000;

export interface LabelGateState {
  v: 1;
  salt: string;
  /** Hashes of labels seen by enough people. */
  shared: string[];
  /** Hashes of labels still waiting, with hashes of the people who sent them (fewer than SHARED_BY). */
  pending: [string, string[]][];
}

export class LabelGate {
  private readonly salt: string;
  private readonly shared: Set<string>;
  private readonly pending: Map<string, string[]>;
  /** Bumped on every change, so the store knows to save. */
  changes = 0;
  /** Codes whose word was confirmed since the last takeRevealed(), with the word. */
  private readonly revealed = new Map<string, string>();

  constructor(state?: LabelGateState) {
    this.salt = state?.salt ?? randomBytes(32).toString("base64");
    this.shared = new Set(state?.shared ?? []);
    this.pending = new Map(state?.pending ?? []);
  }

  toState(): LabelGateState {
    return { v: 1, salt: this.salt, shared: [...this.shared], pending: [...this.pending.entries()] };
  }

  /**
   * The events with every label not yet shared by enough people removed. With no person (the
   * account requires verified identity and this traffic isn't verified), words already shared
   * pass but nothing new is learned: unverified traffic can't vouch for a word.
   */
  filter(events: readonly CapturedEvent[], person: string | undefined, sharedBy = SHARED_BY): CapturedEvent[] {
    const who = person === undefined ? undefined : this.hash(`person:${person}`);
    const keep = (label: string | undefined): boolean =>
      label === undefined || label === "" || isHeld(label) || (who === undefined ? this.shared.has(this.hash(`label:${label}`)) : this.seen(label, who, sharedBy));
    return events.map((e) => gateEvent(e, keep, (label) => this.code(label)));
  }

  /** Codes confirmed since the last call, with their words: the learner swaps them in. */
  takeRevealed(): Map<string, string> {
    const out = new Map(this.revealed);
    this.revealed.clear();
    return out;
  }

  private code(label: string): string {
    return `${HELD}${this.hash(`label:${label}`).slice(0, 12)}`;
  }

  private seen(label: string, who: string, sharedBy: number): boolean {
    const key = this.hash(`label:${label}`);
    if (this.shared.has(key)) return true;
    const people = this.pending.get(key) ?? [];
    if (!people.includes(who)) {
      people.push(who);
      this.changes++;
      if (people.length >= sharedBy) {
        this.pending.delete(key);
        this.shared.add(key);
        this.revealed.set(this.code(label), label);
        return true;
      }
      this.pending.delete(key); // re-insert: the most recently seen are kept when full
      this.pending.set(key, people);
      if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    }
    return false;
  }

  private hash(text: string): string {
    return createHmac("sha256", this.salt).update(text).digest("base64url").slice(0, 22);
  }
}

/**
 * A view inside a page ("/setup/~connect-your-bank": a pop-up or wizard step, named by its
 * title) is on-screen text too: until enough people have seen it, it is the generic "~view".
 */
export const UNNAMED_VIEW = "~view";
function gatePath(path: string, keep: (label: string | undefined) => boolean): string {
  return path.includes("/~") ? path.replace(/\/(~[^/]+)$/, (whole, view: string) => (view === UNNAMED_VIEW || keep(view) ? whole : `/${UNNAMED_VIEW}`)) : path;
}

/** Clicks, the button behind a request and stuck moments keep a code; page text is dropped. */
function gateEvent(e: CapturedEvent, keep: (label: string | undefined) => boolean, code: (label: string) => string): CapturedEvent {
  switch (e.kind) {
    case "route":
      return { ...e, path: gatePath(e.path, keep) };
    case "interaction": {
      const out = { ...e, path: gatePath(e.path, keep) };
      return keep(out.label) ? out : { ...out, label: code(out.label!) };
    }
    case "network": {
      if (!e.trigger) return e;
      const trigger = { ...e.trigger, ...(e.trigger.page ? { page: gatePath(e.trigger.page, keep) } : {}) };
      return { ...e, trigger: keep(trigger.label) ? trigger : { ...trigger, label: code(trigger.label!) } };
    }
    case "struggle": {
      let out: typeof e = { ...e, page: gatePath(e.page, keep) };
      // A field's own name ("dob") is the developer's, never text on screen: kept, as in page snapshots.
      const fieldName = e.type === "validation_loop" || e.type === "field_churn";
      if (!fieldName && !keep(out.target)) out = { ...out, target: code(out.target!) };
      if (!keep(out.control)) out = { ...out, control: code(out.control!) };
      return out;
    }
    case "page":
      return { ...e, path: gatePath(e.path, keep), snapshot: gateSnapshot(e.snapshot, keep) };
    default:
      return e;
  }
}

function gateSnapshot(s: PageSnapshot, keep: (label: string | undefined) => boolean): PageSnapshot {
  const out: PageSnapshot = {
    ...without(s, "title"),
    headings: s.headings.filter((h) => keep(h)),
    forms: s.forms.map((f) => ({
      ...(keep(f.name) ? f : without(f, "name")),
      fields: f.fields.map((x) => (keep(x.label) ? x : without(x, "label"))),
      submitLabels: f.submitLabels.filter((l) => keep(l)),
    })),
    buttons: s.buttons.filter((b) => keep(b.label)),
    frames: s.frames.map((x) => (keep(x.title) ? x : without(x, "title"))),
  };
  if (s.title !== undefined && keep(s.title)) out.title = s.title;
  return out;
}

function without<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> & Partial<Pick<T, K>> {
  const { [key]: _drop, ...rest } = o;
  return rest as Omit<T, K> & Partial<Pick<T, K>>;
}
