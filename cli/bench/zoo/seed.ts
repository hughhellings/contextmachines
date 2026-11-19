/**
 * The zoo's seeds (any-site plan section 9a): one number picks everything a page shows that is not
 * its widget or its flow: the skin (trade ledger, gym log, recipes, CRM, library), the labels, the
 * order of the fields, the wrappers around them, how they are labelled for a screen reader (ARIA),
 * small delays, and the values a goal asks for. Seeds change text, not code: the same page logic
 * runs under every skin, so a tester that only learned one skin's words is caught by the next.
 *
 * Pure and deterministic: the same seed always gives the same variant. No browser, no network.
 */

/** A small fast seeded random source (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length) % xs.length]!;
export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A skin: what the app is about. Every page runs under every skin. */
export interface Skin {
  key: "trade" | "gym" | "recipes" | "crm" | "library";
  app: string;
  /** One record, and many: "trade", "trades". */
  entity: string;
  plural: string;
  /** How the goal says each field (fixed per skin), and the labels the page may use for it (seeded). */
  nameNoun: string;
  nameLabels: readonly string[];
  nameStems: readonly string[];
  numNoun: string;
  numLabels: readonly string[];
  numRange: readonly [number, number];
  choiceNoun: string;
  choiceLabels: readonly string[];
  choices: readonly string[];
  notesLabels: readonly string[];
  /** Settings switches for the autosave page. */
  features: readonly string[];
  /** Things on sale for the one-click page. */
  items: readonly string[];
}

export const SKINS: readonly Skin[] = [
  {
    key: "trade", app: "Ledgerline Ledger", entity: "trade", plural: "trades",
    nameNoun: "symbol", nameLabels: ["Symbol", "Ticker", "Instrument"], nameStems: ["ORBX", "KLMN", "TRAX", "VELO", "NOVA", "QUIL"],
    numNoun: "entry price", numLabels: ["Entry price", "Entry", "Price in"], numRange: [12, 480],
    choiceNoun: "strategy", choiceLabels: ["Strategy", "Setup", "Playbook"], choices: ["Breakout", "Mean reversion", "Scalp", "Swing", "Gap fill", "Trend follow"],
    notesLabels: ["Notes", "Trade notes", "Comments to self"],
    features: ["Weekly summary", "Compact rows", "Auto-tag setups", "Show fees"],
    items: ["Pro data feed", "Chart pack", "Ledger template", "Indicator bundle"],
  },
  {
    key: "gym", app: "Liftbook", entity: "workout", plural: "workouts",
    nameNoun: "exercise", nameLabels: ["Exercise", "Movement", "Lift name"], nameStems: ["Squat", "Row", "Press", "Lunge", "Pullup", "Carry"],
    numNoun: "weight", numLabels: ["Weight (kg)", "Load", "Kilos"], numRange: [5, 220],
    choiceNoun: "muscle group", choiceLabels: ["Muscle group", "Body part", "Focus"], choices: ["Legs", "Back", "Chest", "Core", "Shoulders", "Arms"],
    notesLabels: ["Notes", "How it felt", "Coach notes"],
    features: ["Rest timer", "Metric units", "Weekly summary", "Show warm-ups"],
    items: ["Protein pack", "Lifting belt", "Coaching month", "Chalk bag"],
  },
  {
    key: "recipes", app: "Pantry Notes", entity: "recipe", plural: "recipes",
    nameNoun: "name", nameLabels: ["Recipe name", "Dish", "Title"], nameStems: ["Stew", "Tart", "Curry", "Salad", "Ragu", "Broth"],
    numNoun: "servings", numLabels: ["Servings", "Serves", "Portions"], numRange: [1, 24],
    choiceNoun: "cuisine", choiceLabels: ["Cuisine", "Kitchen", "Style"], choices: ["Italian", "Thai", "Mexican", "French", "Indian", "Greek"],
    notesLabels: ["Notes", "Method notes", "Tips"],
    features: ["Metric units", "Shopping list sync", "Weekly summary", "Show photos"],
    items: ["Cookbook", "Spice set", "Knife roll", "Meal plan month"],
  },
  {
    key: "crm", app: "Pipeline CRM", entity: "contact", plural: "contacts",
    nameNoun: "name", nameLabels: ["Contact name", "Full name", "Name"], nameStems: ["Avery", "Kenji", "Marta", "Tobias", "Ines", "Priya"],
    numNoun: "deal size", numLabels: ["Deal size", "Deal value", "Amount"], numRange: [100, 90000],
    choiceNoun: "stage", choiceLabels: ["Stage", "Pipeline stage", "Status"], choices: ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Nurture"],
    notesLabels: ["Notes", "Call notes", "Context"],
    features: ["Weekly summary", "Compact rows", "Show company logos", "Auto-assign leads"],
    items: ["Lead list", "Seat upgrade", "Data enrichment pack", "Template bundle"],
  },
  {
    key: "library", app: "Shelfwise", entity: "book", plural: "books",
    nameNoun: "title", nameLabels: ["Title", "Book title", "Name"], nameStems: ["Harbor", "Lantern", "Meridian", "Orchard", "Quarry", "Willow"],
    numNoun: "pages", numLabels: ["Pages", "Page count", "Length (pages)"], numRange: [40, 900],
    choiceNoun: "genre", choiceLabels: ["Genre", "Shelf", "Category"], choices: ["Mystery", "History", "Poetry", "Science", "Travel", "Fantasy"],
    notesLabels: ["Notes", "Review notes", "Thoughts"],
    features: ["Reading goal", "Compact rows", "Weekly summary", "Show covers"],
    items: ["Ebook bundle", "Reading light", "Audiobook month", "Bookmark set"],
  },
];

export type Aria = "for" | "wrap" | "aria-label" | "labelledby" | "placeholder";
export const ARIA: readonly Aria[] = ["for", "wrap", "aria-label", "labelledby", "placeholder"];
export const SAVE_WORDS = ["Save", "Add", "Create", "Save entry", "Done", "Keep it"] as const;
const NOTES = ["checked twice", "felt steady", "keep for later", "first try", "slow and clean", "quiet morning"];
const SECOND = ["Prime", "Delta", "North", "Ember", "Cobalt", "Fable"];

/** Everything a seed decides for one page. */
export interface Variant {
  seed: number;
  skin: Skin;
  /** The unique record name a goal asks for ("ORBX-417"), and a second one (a rename's target). */
  name: string;
  name2: string;
  /** A name that looks like `name` (a look-alike row). */
  lookalike: string;
  num: number;
  /** The choice the goal asks for: never the first option (so "always the first" is a visible bug). */
  choice: string;
  notes: string;
  /** The labels this page uses. */
  labels: { name: string; num: string; choice: string; notes: string; save: string };
  /** The order of the form's fields. */
  order: ("name" | "num" | "choice" | "notes")[];
  /** Wrappers around the form: how many, and of what. */
  wrap: { depth: number; tags: string[] };
  aria: Aria;
  /** A small delay before the form shows and before a save answers (ms). */
  delay: number;
  /** The owner-only fact (a team code, a PIN): never shown on any page. */
  code: string;
  /** A class-name prefix, so no two seeds share CSS hooks. */
  css: string;
}

const letters = (r: () => number, n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(r() * 26))).join("");

/** The variant for a seed; `skinKey` pins the skin (the D set spreads skins over pages on purpose). */
export function variantOf(seed: number, skinKey?: Skin["key"]): Variant {
  const r = rng(seed);
  const skin = skinKey ? SKINS.find((s) => s.key === skinKey)! : pick(r, SKINS);
  const n = 100 + Math.floor(r() * 900);
  const stem = pick(r, skin.nameStems);
  const name = `${stem}-${n}`;
  const digits = String(n).split("");
  const swapped = digits.length === 3 && digits[1] !== digits[2] ? `${digits[0]}${digits[2]}${digits[1]}` : String(n + 1);
  const [lo, hi] = skin.numRange;
  return {
    seed,
    skin,
    name,
    name2: `${stem}-${pick(r, SECOND)}-${n}`,
    lookalike: `${stem}-${swapped}`,
    num: lo + Math.floor(r() * (hi - lo)),
    choice: skin.choices[1 + Math.floor(r() * (skin.choices.length - 1))]!,
    notes: pick(r, NOTES),
    labels: { name: pick(r, skin.nameLabels), num: pick(r, skin.numLabels), choice: pick(r, skin.choiceLabels), notes: pick(r, skin.notesLabels), save: pick(r, SAVE_WORDS) },
    order: shuffle(r, ["name", "num", "choice", "notes"] as const),
    wrap: { depth: Math.floor(r() * 4), tags: Array.from({ length: 3 }, () => pick(r, ["div", "section", "div class=\"card\"", "article"])) },
    aria: pick(r, ARIA),
    delay: Math.floor(r() * 7) * 100,
    code: `${letters(r, 3)}-${1000 + Math.floor(r() * 9000)}`,
    css: `z${letters(r, 2).toLowerCase()}`,
  };
}
