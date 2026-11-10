/**
 * The understanding, run on this machine: what the learner saw goes straight into the site model,
 * the main-action rule, the AI's reading and the action contracts, as plain function calls.
 *
 * A learner run has no real people in it, so everything that needs their traffic (goals found
 * from use, setup steps proven by use, how many people use each feature) is empty here. Only the
 * AI's reading of the screens and the learner's own presses decide.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CapturedEventSchema, placeEvent, type CapturedEvent } from "@contextmachines/schemas";
import type { ScanResult } from "@contextmachines/scanner";
import { z } from "zod";
import { actionContracts, type ActionContract } from "../packages/understanding/src/features/actions.ts";
import { describeWith, plainFlowScreens, type AskJson, type DescribeRun } from "../packages/understanding/src/features/describe.ts";
import { buildFeatureReport, groupFeatures, type Feature, type FeatureReport } from "../packages/understanding/src/features/features.ts";
import { lifecycleGoals } from "../packages/understanding/src/guidance/lifecycle.ts";
import { SiteLearner, type SiteModelSnapshot } from "../packages/understanding/src/learn/learner.ts";
import { screensOf, tabBase, type Screen } from "../packages/understanding/src/learn/screen-views.ts";
import { redact } from "./report.ts";

export interface UnderstandOptions {
  /** The site's own address (https://app.example.com): the learner's pages on it have plain paths. */
  origin: string;
  /** Any AI that answers in JSON. Without one, nothing is read: no product sentence, purposes or journeys. */
  ai?: AskJson;
  /** A file keeping the last AI reading: an unchanged product's reading is reused, not asked again. */
  readingCache?: string;
  /** The time it counts as (tests fix it). Default: now. */
  now?: number;
}

export interface Understood {
  /** Every screen, request and press the learner saw, as one site model. */
  site: SiteModelSnapshot;
  /** The screens a person would name: tabs and look-alike routes are views of them, never screens (screen-views.ts). */
  shown: Screen[];
  /** The screen an address the learner saw belongs to: a view's screen, or the address itself. */
  screenOf: (path: string) => string;
  /** What the product is for, its main action, its setup steps and main journeys. */
  understanding: {
    product: string | null;
    mainAction: { id: string; label: string; reason: string; source: "ai" | "traffic" } | null;
    /** The AI's reason it could name no main action. */
    noMainAction?: string;
    prerequisites: { action: string; requires: string; why: string; source: "ai" }[];
    flows: { name: string; screens: string[] }[];
  };
  /** Each action people take, as a contract (sign-in, tracking and session plumbing left out). */
  actions: ActionContract[];
  /** The plumbing left out of `actions` (sign-in, tracking, session upkeep): only to say what the stopped saves were. */
  plumbing: ActionContract[];
  /** The product as features, with what each is for once the AI has read it. */
  features: FeatureReport[];
  /** A photo of each screen and where its buttons and fields sit. */
  screens: { meta: ScreenMeta; jpeg: Buffer }[];
  /**
   * The words on each screen's controls, by path, for judging predictions (predictions.ts): its
   * visible buttons, one entry per button, and the words on its links and any other control (a
   * button tucked in a closed menu included). Never written anywhere.
   */
  controls: Record<string, { buttons: string[]; links: string[] }>;
  /** Why the AI reading didn't work, when it was asked and didn't. */
  readingError?: string;
  /** The last reading was reused: nothing about the product had changed. */
  readingReused: boolean;
}

/** Events given to the site model at a time. */
const CHUNK = 500;
/** Uses of the busiest saving action before real use outweighs the AI's reading of the main action. */
const ESTABLISHED_USES = 20;
// The limits on a screen's photo and boxes: one odd page can't fill the output folder.
const MAX_SCREENS = 200;
const MAX_SCREEN_BYTES = 1_000_000;
const MAX_BOXES = 300;
const SCREEN_PATH = /^\/[^\s<>"]{0,400}$/;
const BoxSchema = z.strictObject({ label: z.string().max(120), kind: z.enum(["button", "field", "link"]), x: z.number().min(0).max(20_000), y: z.number().min(0).max(100_000), w: z.number().min(0).max(20_000), h: z.number().min(0).max(100_000), hiddenIn: z.string().max(120).optional(), href: z.string().max(2000).optional() });
/** Where a button, field or link sits on a screen's photo, as the learner measured it. */
type ScreenBox = ScanResult["screens"][number]["boxes"][number];
export interface ScreenMeta {
  path: string;
  takenAt: number;
  width: number;
  height: number;
  boxes: ScreenBox[];
}
/**
 * Said to the AI when some of what it reads came from the made-up user. It reads what's on screen,
 * and a sample record reads just like a real one: without this it would describe them as the product's.
 */
const DRAWN_NOTE = "\n\nA page's title can be left over from a table of titles an app sets whatever it draws. When a title disagrees with a page's headings, fields and buttons, what is drawn is what the page is: a sign-in form under a title about something else is a sign-in page. Describe a page by what it draws, never by its title alone.";
const MADE_UP_NOTE = "\n\nSome screens were seen with a made-up user and made-up data. Names, numbers and records on any screen are invented examples: describe what the product is for and what people do in it, never those contents.";
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** What the learner saw, understood. */
export async function understand(scan: ScanResult, opts: UnderstandOptions): Promise<Understood> {
  const now = opts.now ?? Date.now();
  const all = learn(scan, opts.origin, now);
  const twins = twinsOf(all, scan);
  const site = { ...all, pages: all.pages.filter((p) => !twins.has(p.path)), routes: all.routes.filter((r) => !twins.has(r.path)) };

  // The main action, first from the learner's presses alone (the busiest save), which also groups the features the AI reads.
  const core = lifecycleGoals(site).core;
  let read: DescribeRun | undefined;
  let readingReused = false;
  if (opts.ai) {
    const ai = opts.ai;
    const note = `${DRAWN_NOTE}${scan.seenWith && Object.keys(scan.seenWith).length ? MADE_UP_NOTE : ""}`;
    const asked: AskJson = { ...ai, ask: (system, question, schema) => ai.ask(`${system}${note}`, question, schema) };
    const features = groupFeatures(site, core?.action.id);
    const cached = opts.readingCache ? reuse(opts.readingCache, features, site) : undefined;
    readingReused = cached !== undefined;
    read = cached ?? (await describeWith(features, site, asked, { ...(scan.links ? { links: scan.links } : {}), failed: scan.errorPages.map((p) => p.path) }));
    if (opts.readingCache && !cached && !read.error) keep(opts.readingCache, features, site, read);
  }

  const u = read?.understanding;
  const shown = screensOf(site);
  const holder = (path: string) => shown.find((s) => s.path === path || s.views?.some((v) => v.path === path));
  // Opened and drew the same as a screen: said under that screen, as any look-alike route is. One never opened isn't said at all.
  for (const [path, twin] of [...twins].sort(([a], [b]) => a.localeCompare(b))) {
    const screen = holder(twin.of);
    if (screen && twin.opened) screen.views = [...(screen.views ?? []), { path, name: path }];
  }
  const owner = new Map([...shown.flatMap((s) => (s.views ?? []).map((v) => [v.path, s.path] as const)), ...[...twins].flatMap(([path, twin]) => {
    const screen = holder(twin.of);
    return screen ? [[path, screen.path] as const] : [];
  })]);
  const screenOf = (path: string) => owner.get(path) ?? path;
  // An action done on a tab is done on its screen, so it lines up with the journeys, which only name screens.
  const contracts = actionContracts(site, read?.actions).map((a) => ({ ...a, pages: [...new Set(a.pages.map(screenOf))] }));
  // One name for an action wherever it shows: the actions list's, so the main action can't read differently from its own row.
  const nameOf = (action: { id: string; label: string }) => contracts.find((a) => a.id === action.id)?.name ?? action.label;

  // Then the AI's reading wins, unless the learner pressed one save so often that use has decided.
  const established = core !== undefined && core.userTriggered && core.action.seen >= ESTABLISHED_USES;
  const readAction = read?.understanding?.mainAction ? site.actions.find((a) => a.id === read.understanding!.mainAction!.id) : undefined;
  const mainAction = readAction && !established
    ? { id: readAction.id, label: nameOf(readAction), reason: `the AI's reading of the product: ${read!.understanding!.mainAction!.why}`, source: "ai" as const }
    : core ? { id: core.action.id, label: nameOf(core.action), reason: core.reason, source: "traffic" as const } : null;
  return {
    site,
    shown,
    screenOf,
    understanding: {
      product: read?.product ?? null,
      mainAction,
      ...(u?.noMainAction ? { noMainAction: u.noMainAction } : {}),
      // Suspected by the AI: with no real people, none is confirmed by use.
      prerequisites: (u?.prerequisites ?? []).map((p) => ({ ...p, source: "ai" as const })),
      flows: (u?.flows ?? []).map((f) => ({ ...f, screens: plainFlowScreens(f.screens) })),
    },
    actions: contracts.filter((a) => !a.plumbing),
    plumbing: contracts.filter((a) => a.plumbing),
    features: buildFeatureReport(site, [], { ...(mainAction ? { coreActionId: mainAction.id } : {}), purposes: read?.purposes ?? [] }),
    screens: photos(scan, now),
    controls: controlsOf(site, scan, screenOf),
    ...(read?.error ? { readingError: read.error } : {}),
    readingReused,
  };
}

/** The site model of one learner run. Throws when the run started on a site other than `origin`. */
function learn(scan: ScanResult, origin: string, now: number): SiteModelSnapshot {
  // A run against another copy (a local one, a preview) would mix its screens into this site's.
  if (scan.startOrigin && scan.startOrigin !== origin) throw new Error(`the learner started at ${scan.startOrigin}, not ${origin}`);
  const mainHost = new URL(origin).host;
  const startHost = scan.startOrigin ? new URL(scan.startOrigin).host : mainHost;
  // Exactly as they'd arrive over the wire: written as JSON and checked, an event the site model refuses left out.
  const events = scan.events.flatMap((e) => {
    const parsed = CapturedEventSchema.safeParse(JSON.parse(JSON.stringify(e)));
    return parsed.success ? [placeEvent(withoutSecrets(parsed.data as CapturedEvent), startHost, mainHost)] : [];
  });
  const learner = new SiteLearner();
  const sessionId = `scan_${now.toString(36)}`;
  for (let i = 0; i < events.length; i += CHUNK) {
    learner.observe({ env: "test", sessionId, receivedAt: now, origin: "scan", dropped: 0, errors: 0, events: events.slice(i, i + CHUNK) });
  }
  learner.heal(now);
  return learner.snapshot();
}

/** What a page shows a person, leaving out its title: an app's table of titles can say anything. */
function drawnLook(page: SiteModelSnapshot["pages"][number]): string | undefined {
  const { headings, forms, buttons } = page.snapshot;
  const fields = forms.flatMap((f) => f.fields.map((x) => x.name));
  const pressable = buttons.filter((b) => !b.hidden).map((b) => b.label);
  return headings.length || fields.length || pressable.length ? JSON.stringify([headings, fields, pressable]) : undefined;
}

/**
 * Addresses that are no screen of their own, each with the screen they repeat. Holds for any app:
 *   - Opened, and drew exactly what an earlier address drew, whatever title it set: a retired route
 *     that falls through to the sign-in page, a marketing address that shows the app's home. Same
 *     headings and controls alone aren't enough, since two records share a layout: what's drawn must
 *     match, words and pictures.
 *   - Never opened at all, only passed through: an app that sends a person on and is sent straight
 *     back (a guard returning to the sign-in) is read at the address it left, still drawing the
 *     screen it came from. Nothing of its own was ever seen there, so it isn't a screen.
 * The first address drawing a thing is the screen. The made-up user's screens are never matched with
 * a visitor's. A tab or step belongs to its screen already, so it isn't looked at here.
 */
function twinsOf(site: SiteModelSnapshot, scan: Pick<ScanResult, "pagesVisited" | "drawn" | "seenWith">): Map<string, { of: string; opened: boolean }> {
  const twins = new Map<string, { of: string; opened: boolean }>();
  const pages = new Map(site.pages.map((p) => [p.path, p]));
  const looks = new Map<string, string>();
  const screenFor = new Map<string, string>();
  const opened = new Set(scan.pagesVisited);
  for (const path of opened) {
    const page = pages.get(path);
    const look = page && drawnLook(page);
    if (!look || tabBase(path) !== undefined) continue;
    if (!looks.has(look) && !scan.seenWith?.[path]) looks.set(look, path);
    const drawn = scan.drawn?.[path];
    if (!drawn) continue;
    const key = JSON.stringify([look, drawn, scan.seenWith?.[path] ?? ""]);
    const first = screenFor.get(key);
    if (first) twins.set(path, { of: first, opened: true });
    else screenFor.set(key, path);
  }
  for (const page of site.pages) {
    if (opened.has(page.path) || scan.seenWith?.[page.path] || tabBase(page.path) !== undefined) continue;
    const first = looks.get(drawnLook(page) ?? "");
    if (first) twins.set(page.path, { of: twins.get(first)?.of ?? first, opened: false });
  }
  return twins;
}

/** What the site wrote on a page: titles, headings and labels. */
const SITE_TEXT = new Set(["title", "headings", "label", "submitLabels"]);

/**
 * An event with the site's own words through redact. A share page or a debug header shows the page's
 * own address, token and all, in its title or a heading, and from here it would go to the AI and
 * into map.json. Done once, before the site model, so nothing downstream can hold the secret.
 */
function withoutSecrets<T>(value: T, inText = false): T {
  if (typeof value === "string") return (inText ? redact(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => withoutSecrets(v, inText)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutSecrets(v, inText || SITE_TEXT.has(k))])) as T;
}

/** Each screen's photo (a later one of the same screen replaces it) and where things sit on it. */
function photos(scan: ScanResult, now: number): { meta: ScreenMeta; jpeg: Buffer }[] {
  const kept = new Map<string, { meta: ScreenMeta; jpeg: Buffer }>();
  for (const shot of scan.screens ?? []) {
    const jpeg = Buffer.from(shot.jpeg);
    // A photo too large, not a JPEG or of an odd size is skipped, never fatal.
    if (!SCREEN_PATH.test(shot.path) || !(shot.width > 0 && shot.width <= 4000) || !(shot.height > 0 && shot.height <= 20_000)) continue;
    if (jpeg.length > MAX_SCREEN_BYTES || !isJpeg(jpeg)) continue;
    if (!kept.has(shot.path) && kept.size >= MAX_SCREENS) continue;
    const boxes = shot.boxes.slice(0, MAX_BOXES);
    // Boxes that don't fit the shape are dropped together: a screen with no marked spots still has its photo.
    const valid = z.array(BoxSchema).safeParse(boxes).success;
    const meta: ScreenMeta = { path: shot.path, takenAt: now, width: Math.round(shot.width), height: Math.round(shot.height), boxes: valid ? boxes : [] };
    kept.set(shot.path, { meta, jpeg });
  }
  return [...kept.values()];
}

/**
 * Each screen's controls in words (see Understood.controls). Buttons come from the page's own reading
 * (one entry per button); links only from the photo's boxes, since the page reading has none, which
 * also catches a link to another host, such as a "Sign up" that leaves the app for the main site.
 * A link's address counts as words too (only its path, not a query that may just point back at
 * sign-up), since "Create one" says less than where it goes: /signup, /join, /register.
 */
function controlsOf(site: SiteModelSnapshot, scan: ScanResult, screenOf: (path: string) => string): Record<string, { buttons: string[]; links: string[] }> {
  const out: Record<string, { buttons: string[]; links: string[] }> = {};
  const at = (path: string) => (out[screenOf(path)] ??= { buttons: [], links: [] });
  for (const page of site.pages) {
    for (const b of page.snapshot.buttons) (b.hidden ? at(page.path).links : at(page.path).buttons).push(b.label);
  }
  for (const shot of scan.screens ?? []) {
    for (const box of shot.boxes as (ScreenBox & { href?: string })[]) {
      if (box.kind === "field") continue;
      at(shot.path).links.push(box.label);
      if (box.href) at(shot.path).links.push(pathOf(box.href));
    }
  }
  return out;
}

const pathOf = (href: string) => {
  try {
    return new URL(href, "http://x").pathname;
  } catch {
    return "";
  }
};

/**
 * What the AI is shown, in a form that doesn't depend on order: the same product gives the same
 * fingerprint, so its reading can be reused.
 */
function fingerprint(features: readonly Feature[], site: SiteModelSnapshot): string {
  const sorted = (xs: string[]) => [...new Set(xs)].sort();
  return createHash("sha256").update(JSON.stringify({
    // Raised when the question asked of the AI changes, so an older reading isn't reused.
    v: 4,
    features: features.map((f) => [f.id, sorted(f.pages), sorted(f.actions)]).sort(),
    actions: site.actions.map((a) => [a.id, a.method, a.path, sorted(Object.keys(a.fields)), sorted(a.triggers.map((t) => t.label))]).sort(),
    pages: site.pages.map((p) => [p.path, p.snapshot.title ?? "", p.snapshot.headings.slice(0, 3), sorted(p.snapshot.buttons.map((b) => b.label)), sorted(p.snapshot.forms.flatMap((f) => f.fields.map((x) => x.name)))]).sort(),
  })).digest("hex");
}

/** The kept reading, when it was of this same product (and readable). Reused readings cost nothing. */
function reuse(file: string, features: readonly Feature[], site: SiteModelSnapshot): DescribeRun | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { fingerprint: string; run: DescribeRun };
    return saved.fingerprint === fingerprint(features, site) ? { ...saved.run, costUsd: 0 } : undefined;
  } catch {
    return undefined; // unreadable: read afresh
  }
}

function keep(file: string, features: readonly Feature[], site: SiteModelSnapshot, run: DescribeRun): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fingerprint: fingerprint(features, site), run }));
}
