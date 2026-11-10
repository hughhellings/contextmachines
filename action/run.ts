/**
 * The GitHub Action's work: learn the product before and after the pull request, compare, and
 * say what the change does to it, on the pull request (one comment, updated on every push) and in
 * the job summary.
 *
 * It learns the apps at the addresses it is given (a preview deploy and production, say); it never
 * builds or runs the pull request's code itself. The learner is the published package, at the
 * version in version.txt (stamped at release), so the Action needs nothing else from this
 * repository; the `cli` input points it at a local copy instead (this repository's own CI does).
 *
 * Inputs come as environment variables: INPUT_<NAME> from the Action, or CONTEXTMACHINES_<NAME> to
 * run it the same way locally:
 *   CONTEXTMACHINES_URL=https://pr-12.preview.app CONTEXTMACHINES_BASE_URL=https://app.example.com node action/run.ts
 *
 * Only Node's own modules are imported, so the Action runs from a bare checkout of itself.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the open-source project lives (the same address the CLI links to). */
const HOME = "https://github.com/hughhellings/contextmachines";
/** GitHub refuses a comment over 65,536 characters (422); this leaves room for the marker and footer. */
export const MAX_BODY = 60_000;
/** Items shown per list in the comment; the job summary shows many more. */
const COMMENT_LIST = 30;
const SUMMARY_LIST = 1000;

// ---------------------------------------------------------------------------------------------
// Site text in markdown. Everything below the headline comes from the site (button labels, error
// messages, paths) or from an AI that read the site, and lands in a comment in the reviewer's own
// repository. Written as it is, a page's "@everyone" pings people, "#1" links an issue, a link
// leads anywhere and "<details>" or "**" reshapes the comment. So all of it goes through one of
// these two helpers.
// ---------------------------------------------------------------------------------------------

/** Words GitHub turns into a ping, an issue or commit link, or a link: shown as code instead, where it doesn't. */
const LIVE_WORD = /@[A-Za-z0-9]|#\d|\bGH-\d|:\/\/|\bwww\./i;
// C0 and C1 controls, and the invisible marks that reorder or hide text (a right-to-left override
// can make "gnp.exe" read "exe.png").
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]+/g;

/** One line of at most `max` characters: no line breaks or hidden characters, cut with "…". */
function oneLine(text: string, max: number): string {
  const flat = String(text).replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : flat;
}

/** Site text as plain words in markdown: nothing in it pings, links, or formats. */
export function cell(text: string, max = 300): string {
  return oneLine(text, max)
    .split(/( )/)
    .map((word) => (word === " " || word === "" ? word : LIVE_WORD.test(word) ? codeSpan(word) : plainWord(word)))
    .join("");
}

/** Site text as code (paths, requests, addresses): shown exactly, and never a ping or a link. */
export function code(text: string, max = 300): string {
  return codeSpan(oneLine(text, max));
}

function plainWord(word: string): string {
  // Entities first, so the "&" they add isn't escaped again; "&" itself too, or "&#64;everyone" would ping.
  // A number and a dot or bracket would start a numbered list where a block starts with site text.
  return word.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]()#!|~=+-]/g, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2");
}

function codeSpan(text: string): string {
  // A run of backticks inside is fenced by a longer run; a space keeps one at either end apart from the fence.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

// ---------------------------------------------------------------------------------------------
// The addresses it was given, as they may be shown. A protected preview is usually reached with a
// secret in its address (`https://user:pass@…`, `?x-vercel-protection-bypass=…`), and the comment,
// the job summary and the log all show the address: GitHub masks secrets in the log only, never in
// a comment posted through its API. A script error's message can hold a token too, and it is quoted
// on the pull request. So every address and error is shown through redact(), the CLI's own rule
// (cli/report.ts), copied here so this script imports only Node's modules; run.test.ts checks
// that the two agree.
// ---------------------------------------------------------------------------------------------

/** Words in a query parameter's name that mean its value is a secret (the CLI's SECRET_NAME). */
const SECRET_NAME = /(^|[-_.])(access|api|apikey|auth|bypass|code|credential|credentials|jwt|key|nonce|otp|pass|passwd|password|pwd|secret|session|sessionid|sid|sig|signature|state|ticket|token)s?($|[-_.])|token|secret|password|apikey|signature|credential/i;
/** A value that is a switch, not a secret, whatever its name ("set-bypass-cookie=true"). */
const SWITCH = /^(true|false|yes|no|on|off|[01])$/i;
/** A value that looks generated (long, letters and digits mixed): a token, whatever its name. */
const TOKEN_LIKE = /^(?=.*\d)(?=.*[a-z])[\w~+/=%.-]{20,}$/i;

/** A part of an address that is an opaque id or a token (the CLI's OPAQUE_SEGMENT). */
const OPAQUE_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{12,}$/;
/** Words that name a secret in free text (the CLI's SECRET_LABEL). */
const SECRET_LABEL = /(?<![\w-])([\w.-]*(?:password|passwd|pwd|passphrase|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|credential)[\w.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>()]+)/gi;
/** What follows such a label when it holds no secret (the CLI's NOT_A_SECRET). */
const NOT_A_SECRET = /^["']?(true|false|yes|no|on|off|[01]|undefined|null|none|nil|empty|missing|required|invalid|expired|incorrect|wrong|unknown|reset|must|is|was|not|cannot|should|your|the|an?|for|REDACTED)["']?$/i;
/** Keys with a well-known shape (the CLI's KNOWN_KEY). */
const KNOWN_KEY = /\b(?:(?:sk|rk)[-_](?:live|test|proj|ant)[-_][\w-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|A(?:KI|SI)A[0-9A-Z]{16}|AIza[\w-]{30,}|npm_[A-Za-z0-9]{30,})\b/g;
/** 32 or more hex digits, on their own (the CLI's LONG_HEX). */
const LONG_HEX = /(?<![\w.-])[0-9a-f]{32,}(?![\w-]|\.\w)/gi;
/** A long base64-url run that doesn't read as a name (the CLI's OPAQUE_RUN). */
const OPAQUE_RUN = /(?<![\w.-])(?!(?=[\w-]{24,39}(?![\w-]))[\w-]*(?:[A-Z][a-z]{3,}[\w-]*){3})(?:(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d]{24,}|(?=[\w-]*?[A-Za-z\d]{10})(?=[\w-]*?[A-Za-z]\d+(?=[A-Za-z])[\w-]*?[A-Za-z]\d+[A-Za-z])[\w-]{24,})(?![\w-]|\.\w)/g;

/** Text without what would let someone else in: credentials and tokens in addresses, and secrets in free text, labelled or not (see the CLI's redact). */
export function redact(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]+@/gi, "$1")
    .replace(/([?&#;][^=&#\s"'<>()]{1,80}=)([^&#\s"'<>()]+)/g, (all, name: string, value: string) => ((SECRET_NAME.test(name.slice(1, -1)) && !SWITCH.test(value)) || TOKEN_LIKE.test(value) ? `${name}REDACTED` : all))
    .replace(/(\bhttps?:\/\/[^/\s?#"'<>()]+)(\/[^\s?#"'<>()]*)/gi, (_all, host: string, path: string) => `${host}${path.split("/").map((part) => (OPAQUE_SEGMENT.test(part) ? ":id" : part)).join("/")}`)
    .replace(/\b((?:proxy-)?authorization|x-api-key)(["']?\s*[=:]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"'<>()]+/gi, "$1$2REDACTED")
    .replace(/\b([Bb]earer|BEARER|[Bb]asic|BASIC)\s+(?=\S*(?:\d|[a-z][A-Z]|=))[A-Za-z0-9._~+/=-]{8,}/g, "$1 REDACTED")
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, "REDACTED")
    .replace(SECRET_LABEL, (all, name: string, joint: string, value: string) => (NOT_A_SECRET.test(value) ? all : `${name}${joint}REDACTED`))
    .replace(KNOWN_KEY, "REDACTED")
    .replace(LONG_HEX, "REDACTED")
    .replace(OPAQUE_RUN, "REDACTED");
}

// ---------------------------------------------------------------------------------------------
// The comment, from the learner's data (map.json and `diff --json`), not its markdown: the
// Action decides the layout, the size and the escaping, and the data is the CLI's stable contract.
// ---------------------------------------------------------------------------------------------

/** A provable issue, as the learner records it in map.json. */
export interface Finding {
  kind: "does_nothing" | "crashes" | "request_fails" | "broken_link" | string;
  screen: string;
  target: string;
  evidence: string;
  after?: string;
  count: number;
}

/** `contextmachines diff --json`. Fields this Action doesn't know (a schema version, say) are ignored. */
export interface Comparison {
  screensAdded: string[];
  screensGone: string[];
  actionsAdded: { name: string; request: string }[];
  actionsGone: { name: string; request: string }[];
  actionsRenamed: { request: string; from: string; to: string }[];
  actionsMoved: { name: string; from: string[]; to: string[] }[];
  mainAction: { from: string | null; to: string | null } | null;
  journeysChanged: string[];
  issuesNew: Finding[];
  issuesFixed: Finding[];
  /** Guesses about where people may get stuck, never proven. Missing from older CLIs, and never a change on their own. */
  predictionsNew?: Prediction[];
  predictionsGone?: Prediction[];
  /** What only one run saw when one stopped at a limit: how far each got, never a change. Missing from older CLIs. */
  seenOnlyNow?: SeenInOneRun;
  seenOnlyBefore?: SeenInOneRun;
}

/** The CLI's SeenInOneRun. */
export interface SeenInOneRun {
  screens: string[];
  actions: { name: string; request: string }[];
  issues: Finding[];
}

/** A guess from the map (the CLI's predictions.ts), shown only folded and labelled as one. */
export interface Prediction {
  kind: string;
  screen: string;
  target: string;
  why: string;
}

/** What map.json holds that the comment uses, when there is nothing to compare with. */
export interface LearnedMap {
  url: string;
  product: string | null;
  mainAction: { label: string } | null;
  screens: unknown[];
  actions: { kind: string; seenWith?: string }[];
  findings?: Finding[];
}

/** The part of a comparison that is a change to the product (issues are counted on their own). */
const PRODUCT_CHANGES = ["mainAction", "screensAdded", "screensGone", "actionsAdded", "actionsGone", "actionsRenamed", "actionsMoved", "journeysChanged"] as const;

/** True when the product's screens, actions, journeys or issues differ. Only known fields count. */
export function hasChanged(c: Comparison): boolean {
  return [...PRODUCT_CHANGES, "issuesNew", "issuesFixed"].some((k) => {
    const v = c[k as keyof Comparison];
    return Array.isArray(v) ? v.length > 0 : v != null;
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A finding in words, the same words the CLI uses, with every part of it escaped. */
export function issueLine(f: Finding): string {
  // Redacted here too: this is the comment, the last stop, and an error's text says what failed.
  const target = redact(f.target);
  const evidence = redact(f.evidence);
  const what =
    f.kind === "does_nothing" ? `"${cell(target)}" does nothing when pressed`
    : f.kind === "crashes" ? `Script error: ${cell(target)}`
    : f.kind === "request_fails" ? `${code(target)} failed`
    : `Broken link to ${code(target)}`;
  const proof = f.kind === "does_nothing" ? "" : f.kind === "crashes" ? `in ${code(evidence)}` : cell(evidence);
  const parts = [proof, f.after ? `after pressing "${cell(f.after)}"` : "", f.count > 1 ? `seen ${f.count} times` : ""].filter(Boolean);
  return `${what} on ${code(f.screen)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

const paths = (list: string[]) => list.map((p) => code(p)).join(", ") || "nowhere";

/** One line per product change, in the order a reviewer cares about. */
function changeLines(c: Comparison): string[] {
  return [
    ...(c.mainAction ? [`**Main action** changed: ${cell(c.mainAction.from ?? "none")} → **${cell(c.mainAction.to ?? "none")}**`] : []),
    ...c.screensAdded.map((p) => `➕ New screen ${code(p)}`),
    ...c.screensGone.map((p) => `➖ Screen gone ${code(p)}`),
    ...c.actionsAdded.map((a) => `➕ New action **${cell(a.name)}** (${code(a.request)})`),
    ...c.actionsGone.map((a) => `➖ Action gone **${cell(a.name)}** (${code(a.request)})`),
    ...c.actionsRenamed.map((a) => `✏️ **${cell(a.from)}** is now **${cell(a.to)}** (${code(a.request)})`),
    ...c.actionsMoved.map((a) => `↪️ **${cell(a.name)}** moved: ${paths(a.from)} → ${paths(a.to)}`),
    ...c.journeysChanged.map((j) => `🧭 Journey affected: **${cell(j)}** (one of its screens is gone)`),
  ];
}

/** A bulleted list of at most `cap` items, then where the rest are. */
function list(items: string[], cap: number, rest: string): string {
  const shown = items.slice(0, cap).map((line) => `- ${line}`);
  if (items.length > cap) shown.push(`- …and ${items.length - cap} more ${rest}`);
  return shown.join("\n");
}

/** A part of the comment GitHub folds away until it is opened. */
function folded(summary: string, body: string): string {
  // The blank lines let GitHub read the markdown inside the HTML.
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

/** What goes under the comment: what made it, how long it took, where, and where the photos are. */
export interface Footer {
  /** The Action's own (version.txt), not site text. */
  version: string;
  seconds: number;
  url: string;
  /** The run's artifacts, when the work dir was uploaded. */
  photos?: string;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function footer(f: Footer): string {
  // Redacted here too, so no caller can put a secret in the comment by forgetting to.
  const parts = [`[Context Machines](${HOME}) ${f.version}`, duration(f.seconds), code(redact(f.url), 200), ...(f.photos ? [`[screen photos](${f.photos})`] : [])];
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** A block of the comment, and whether it may be dropped to fit GitHub's size limit. */
interface Block {
  text: string;
  optional?: boolean;
}

/** Long lists say where the rest are: the comment points to the job summary, the summary to map.json. */
interface Room {
  cap: number;
  rest: string;
}
const IN_COMMENT: Room = { cap: COMMENT_LIST, rest: "in the job summary" };
const IN_SUMMARY: Room = { cap: SUMMARY_LIST, rest: "in map.json" };

/** The comment for a change: a verdict headline, new issues in full, the rest folded. */
export function diffBlocks(c: Comparison, foot: Footer, room: Room = IN_COMMENT): Block[] {
  const changes = changeLines(c);
  const counts = [
    c.issuesNew.length ? plural(c.issuesNew.length, "new issue") : "",
    c.screensAdded.length ? `${plural(c.screensAdded.length, "screen")} added` : "",
    c.screensGone.length ? `${plural(c.screensGone.length, "screen")} gone` : "",
    c.actionsAdded.length ? `${plural(c.actionsAdded.length, "action")} added` : "",
    c.actionsGone.length ? `${plural(c.actionsGone.length, "action")} gone` : "",
    c.actionsRenamed.length ? `${plural(c.actionsRenamed.length, "action")} renamed` : "",
    c.actionsMoved.length ? `${plural(c.actionsMoved.length, "action")} moved` : "",
    c.mainAction ? "main action changed" : "",
    c.journeysChanged.length ? `${plural(c.journeysChanged.length, "journey")} affected` : "",
    c.issuesFixed.length ? `${plural(c.issuesFixed.length, "issue")} fixed` : "",
  ].filter(Boolean);
  // Red only for what it can prove is broken; a changed product isn't a problem in itself.
  const verdict = c.issuesNew.length ? "🔴" : "🟢";
  const blocks: Block[] = [{ text: `### ${verdict} Context Machines: ${counts.join(" · ") || "no change to the product"}` }];
  // How far each of two runs got when one stopped at a limit: never in the headline, the verdict or `changed`.
  const once = (seen: SeenInOneRun | undefined, where: string) => [
    ...(seen?.screens ?? []).map((p) => `Screen ${code(p)}: ${where}`),
    ...(seen?.actions ?? []).map((a) => `Action **${cell(a.name)}** (${code(a.request)}): ${where}`),
    ...(seen?.issues ?? []).map((f) => `Issue: ${issueLine(f)}: ${where}`),
  ];
  const seenOnce = [...once(c.seenOnlyNow, "seen only in this run"), ...once(c.seenOnlyBefore, "seen only in the earlier run")];
  if (!counts.length) blocks.push({ text: seenOnce.length ? "Its screens, actions, journeys and issues are the same in what both runs saw." : "Its screens, actions, journeys and issues are the same as before this change." });
  if (c.issuesNew.length) blocks.push({ text: `**New issues**, each seen happening:\n\n${list(c.issuesNew.map((f) => `🐞 ${issueLine(f)}`), room.cap, room.rest)}` });
  if (changes.length) blocks.push({ text: folded(`What this change does to the product (${changes.length})`, list(changes, room.cap, room.rest)), optional: true });
  if (c.issuesFixed.length) blocks.push({ text: folded(`Issues fixed (${c.issuesFixed.length})`, list(c.issuesFixed.map((f) => `✅ ${issueLine(f)}`), room.cap, room.rest)), optional: true });
  if (seenOnce.length) blocks.push({ text: folded(`Seen in only one run: a run stopped at a limit, so not a change (${seenOnce.length})`, list(seenOnce, room.cap, room.rest)), optional: true });
  // Guesses stay folded, out of the headline and the verdict: only what was seen happening is red.
  const guesses = [
    ...(c.predictionsNew ?? []).map((p) => `❔ ${code(p.screen)}: ${cell(p.target)}: ${cell(p.why)}`),
    ...(c.predictionsGone ?? []).map((p) => `➖ no longer predicted: ${code(p.screen)}: ${cell(p.target)}`),
  ];
  if (guesses.length) blocks.push({ text: folded(`Might trip people up: predictions, not proven (${guesses.length})`, list(guesses, room.cap, room.rest)), optional: true });
  blocks.push({ text: footer(foot) });
  return blocks;
}

/** The comment with nothing to compare with: the product as it stands after the change. */
export function learnedBlocks(map: LearnedMap, foot: Footer, room: Room = IN_COMMENT): Block[] {
  const issues = map.findings ?? [];
  // What a made-up user saw is no part of the product as it stands, and a pull request is never told it is.
  const saves = map.actions.filter((a) => a.kind !== "read" && !a.seenWith).length;
  const screens = map.screens.filter((s) => !(s as { seenWith?: string }).seenWith).length;
  const counts = [issues.length ? plural(issues.length, "issue") : "", plural(screens, "screen"), plural(saves, "action")].filter(Boolean);
  const blocks: Block[] = [{ text: `### ${issues.length ? "🔴" : "🟢"} Context Machines: ${counts.join(" · ")}` }];
  if (issues.length) blocks.push({ text: `**Issues**, each seen happening:\n\n${list(issues.map((f) => `🐞 ${issueLine(f)}`), room.cap, room.rest)}` });
  const about = [map.product ? cell(map.product, 1500) : "", map.mainAction ? `Main action: **${cell(map.mainAction.label)}**` : ""].filter(Boolean).join("\n\n");
  if (about) blocks.push({ text: folded("What the product is", about), optional: true });
  blocks.push({ text: "Set `base-url` to the app before this change to see what the change does to it." });
  blocks.push({ text: footer(foot) });
  return blocks;
}

/**
 * The blocks as one body under `max` characters: when they don't fit, the folded parts go, last
 * first, and a note says so. The new issues, the headline and the footer always stay.
 */
export function fit(blocks: Block[], max = MAX_BODY): string {
  const kept = [...blocks];
  const join = (bs: Block[]) => bs.map((b) => b.text).join("\n\n");
  let cut = false;
  while (join(kept).length > max) {
    const last = kept.map((b) => b.optional).lastIndexOf(true);
    if (last < 0) break;
    kept.splice(last, 1);
    cut = true;
  }
  if (cut) kept.splice(kept.length - 1, 0, { text: "_Cut short to fit a comment; the full comparison is in the job summary._" });
  const body = join(kept);
  // Only text a site made enormous could still be over: cut at a line, never inside one.
  return body.length > max ? `${body.slice(0, body.lastIndexOf("\n", max - 80))}\n\n_Cut short to fit a comment; the rest is in the job summary._` : body;
}

// ---------------------------------------------------------------------------------------------
// The one comment on the pull request.
// ---------------------------------------------------------------------------------------------

/**
 * The first line of our comment. It names the workflow, the job and the `key` input, so two uses of
 * the Action (two apps, or a matrix) each keep their own comment.
 */
export function marker(workflow: string, job: string, key: string): string {
  const part = (s: string) => encodeURIComponent(s);
  return `<!-- contextmachines kind=diff workflow=${part(workflow)} job=${part(job)} key=${part(key)} -->`;
}

export interface CommentTarget {
  api: string;
  repo: string;
  pr: number;
  token: string;
  marker: string;
  body: string;
  /** Where warnings go: GitHub's log in the Action. */
  warn: (message: string) => void;
}

/** Why a GitHub request failed, in words a reviewer can act on. */
class GitHubRefused extends Error {}

function refusal(res: Response, doing: string): GitHubRefused {
  const status = res.status;
  if (status === 429 || (status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = reset ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : "";
    return new GitHubRefused(`GitHub's rate limit stopped Context Machines ${doing} (${status})${when}; the next push will try again.`);
  }
  if (status === 401) return new GitHubRefused(`GitHub didn't accept the token while ${doing} (401). Check the github-token input (the default, github.token, works).`);
  if (status === 403 || status === 404) {
    return new GitHubRefused(`GitHub didn't allow ${doing} (${status}). Give the job "permissions: pull-requests: write". On a pull request from a fork the token is read-only.`);
  }
  if (status === 422) return new GitHubRefused(`GitHub refused the comment while ${doing} (422): it may be too long or malformed.`);
  return new GitHubRefused(`GitHub answered ${status} while ${doing}.`);
}

/** Who may have written our comment: the token's own login, or, when GitHub won't say, any bot. */
type Author = { login: string } | { anyBot: true };

/**
 * A personal or app user token can ask who it is. An installation token (the workflow's own
 * github.token, or a GitHub App's) can't: GitHub answers 403 "Resource not accessible by
 * integration", and its comments are written by a bot, github-actions[bot] or the app's own.
 */
async function author(t: CommentTarget, headers: Record<string, string>): Promise<Author> {
  const res = await fetch(`${t.api}/user`, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.ok) {
    const user = (await res.json()) as { login?: string };
    if (user.login) return { login: user.login };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0") return { anyBot: true };
  if (!res.ok) throw refusal(res, "checking who the token comments as");
  return { anyBot: true };
}

/** The next page from GitHub's Link header, only on GitHub's own address (the token goes with it). */
function nextPage(link: string | null, api: string): string | undefined {
  const next = link?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
  return next && new URL(next).origin === new URL(api).origin ? next : undefined;
}

/** Ours: the marker is the first line, and the author is the token's identity (or a bot). */
async function find(t: CommentTarget, headers: Record<string, string>, by: Author): Promise<number | undefined> {
  let page: string | undefined = `${t.api}/repos/${t.repo}/issues/${t.pr}/comments?per_page=100`;
  // 50 pages of 100 is more comments than any pull request has; the bound only stops a loop.
  for (let n = 0; page && n < 50; n++) {
    const res = await fetch(page, { headers, signal: AbortSignal.timeout(30_000) });
    // Not knowing whether ours exists must not mean posting a second one.
    if (!res.ok) throw refusal(res, "reading the pull request's comments");
    const comments = (await res.json()) as { id: number; body?: string | null; user?: { login?: string; type?: string } | null }[];
    const ours = comments.find((c) => (c.body ?? "").split("\n", 1)[0]!.trim() === t.marker && ("login" in by ? c.user?.login === by.login : c.user?.type === "Bot"));
    if (ours) return ours.id;
    page = nextPage(res.headers.get("link"), t.api);
  }
  return undefined;
}

/**
 * Posts our comment, or updates it when it exists. Never throws and never fails the job: the
 * result is in the job summary whatever GitHub says, so a refusal is a warning.
 */
export async function upsertComment(t: CommentTarget): Promise<"posted" | "updated" | "skipped"> {
  const headers = { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "contextmachines-action", "x-github-api-version": "2022-11-28" };
  const body = JSON.stringify({ body: `${t.marker}\n${t.body}` });
  try {
    const existing = await find(t, headers, await author(t, headers));
    const res = existing
      ? await fetch(`${t.api}/repos/${t.repo}/issues/comments/${existing}`, { method: "PATCH", headers, body, signal: AbortSignal.timeout(30_000) })
      : await fetch(`${t.api}/repos/${t.repo}/issues/${t.pr}/comments`, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw refusal(res, existing ? "updating its comment" : "commenting on the pull request");
    return existing ? "updated" : "posted";
  } catch (error) {
    const why = error instanceof GitHubRefused ? error.message : `Context Machines couldn't reach GitHub to comment (${(error as Error).message}).`;
    t.warn(`${why} The result is in the job summary.`);
    return "skipped";
  }
}

// ---------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------

// Namespaced on purpose: bare names like URL or MINUTES are set by other tools (some hosts set URL to
// the site's address), and would be picked up by accident.
const input = (name: string) => {
  const key = name.toUpperCase().replace(/-/g, "_");
  return (process.env[`INPUT_${key}`] || process.env[`CONTEXTMACHINES_${key}`] || "").trim();
};

/** The learner, its browser and the AI it may start need none of the GitHub credentials: only the comment, made here, does. */
export function learnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secret = (k: string) => ["INPUT_GITHUB_TOKEN", "CONTEXTMACHINES_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"].includes(k) || k.startsWith("ACTIONS_");
  return Object.fromEntries(Object.entries(env).filter(([k]) => !secret(k)));
}

/** The CLI's exit codes, in the words the Action's log shows. */
export function learnFailure(status: number | null, target: string): string {
  if (status === 2) return `Context Machines refused its inputs while learning ${target} (exit 2): check url, base-url and minutes. What it refused is printed above.`;
  if (status === 3) return `Context Machines couldn't reach or read ${target} (exit 3): is the site up and public from the runner? What went wrong is printed above.`;
  if (status === 130) return `Context Machines was stopped while learning ${target}.`;
  return `Context Machines couldn't learn ${target}${status == null ? "" : ` (exit ${status})`}. What went wrong is printed above.`;
}

/**
 * Text the site wrote reaches the log (the CLI prints what it saw). A line of it starting "::" would
 * be a workflow command, so GitHub is told to ignore commands until a token only this run knows.
 */
function quietly<T>(work: () => T): T {
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  try {
    return work();
  } finally {
    console.log(`::${token}::`);
  }
}

/** Stop with one clean line GitHub shows as an error, and the CLI's own exit code. */
function stop(message: string, code = 1): never {
  console.log(`::error::${message}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const started = Date.now();
  const url = input("url");
  const baseUrl = input("base-url");
  const minutes = input("minutes") || "3";
  const key = input("key");
  if (!url) stop("Context Machines: set `url` to the address of this pull request's preview (or the app as it is after the change).", 2);
  // The key names the artifact and the comment: keep it to characters both accept.
  if (!/^[A-Za-z0-9_.-]*$/.test(key)) stop(`Context Machines: \`key\` may hold letters, digits, ".", "-" and "_" (it was "${key}").`, 2);

  const local = input("cli");
  const version = local ? "from source" : readFileSync(new URL("./version.txt", import.meta.url), "utf8").trim();
  // The published package at the Action's own version, or the copy the `cli` input points at.
  const learner = local ? [process.execPath, resolve(local)] : ["npx", "--yes", `contextmachines@${version}`];
  const work = resolve(input("work-dir") || join(process.env.RUNNER_TEMP || tmpdir(), key ? `contextmachines-${key}` : "contextmachines"));
  mkdirSync(work, { recursive: true });
  // Said first, so the photos are uploaded even when learning fails part way.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `work-dir=${work}\n`);
  // One reading per side, kept between workflow runs: each side reuses its own last reading while it
  // is unchanged. (A single file shared by both sides would be overwritten by each in turn whenever
  // the change alters the product, so neither would ever be reused.)
  const readings = input("reading-cache") || join(work, "readings");
  const env = learnerEnv(process.env);
  // npx runs from the work dir, so the repository's own package.json can't change what it fetches.
  const run = (args: string[], capture: boolean) =>
    spawnSync(learner[0]!, [...learner.slice(1), ...args], { cwd: work, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 64 * 1024 * 1024 });

  const learn = (target: string, side: "before" | "after") => {
    const out = join(work, side);
    // The learner gets the address as given (it needs the secret to get in); the log only ever shows it redacted.
    const shown = redact(target);
    console.log(`::group::Learning ${shown}`);
    const result = quietly(() => run(["learn", target, "--out", out, "--minutes", minutes, "--reading-cache", join(readings, `${side}.json`)], false));
    console.log("::endgroup::");
    if (result.error) stop(`Context Machines couldn't start the learner (${redact(result.error.message)}).`);
    if (result.status !== 0) stop(learnFailure(result.status, shown), result.status ?? 1);
    return join(out, "map.json");
  };

  const after = learn(url, "after");
  const before = baseUrl ? learn(baseUrl, "before") : undefined;
  const runId = process.env.GITHUB_RUN_ID;
  const foot: Footer = {
    version,
    seconds: (Date.now() - started) / 1000,
    url: redact(url),
    photos: input("artifact") !== "false" && runId && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}#artifacts` : undefined,
  };

  let blocks: (room: Room) => Block[];
  // Empty when there is nothing to compare with: not knowing isn't the same as "no change".
  let changed = "";
  let issues: number;
  if (before) {
    const compared = quietly(() => run(["diff", before, after, "--json"], true));
    if (compared.status !== 0) stop(`Context Machines couldn't compare the two runs${compared.status == null ? "" : ` (exit ${compared.status})`}. What went wrong is printed above.`, compared.status ?? 1);
    const comparison = JSON.parse(compared.stdout) as Comparison;
    changed = String(hasChanged(comparison));
    issues = comparison.issuesNew.length;
    blocks = (room) => diffBlocks(comparison, foot, room);
  } else {
    const map = JSON.parse(readFileSync(after, "utf8")) as LearnedMap;
    // With nothing to compare with, every issue it found is new to the reviewer.
    issues = map.findings?.length ?? 0;
    blocks = (room) => learnedBlocks(map, foot, room);
  }

  const comment = fit(blocks(IN_COMMENT));
  quietly(() => console.log(`\n${comment}\n`));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${blocks(IN_SUMMARY).map((b) => b.text).join("\n\n")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nmap=${after}\nissues=${issues}\n`);

  // One comment per pull request, kept up to date: ours is found by its marker and its author, edited,
  // never repeated. Anyone can paste the marker into a comment of their own; that one is left alone.
  const pr = pullRequestNumber();
  const token = input("github-token");
  const repo = process.env.GITHUB_REPOSITORY;
  if (input("comment") === "false") console.log("Not commenting (comment: false): the result is in the job summary.");
  else if (!pr) console.log("Not a pull request: the result is in the job summary only.");
  else if (!token || !repo) console.log("::warning::Context Machines has no github-token to comment with. The result is in the job summary.");
  else {
    const done = await upsertComment({
      api: process.env.GITHUB_API_URL || "https://api.github.com",
      repo,
      pr,
      token,
      marker: marker(process.env.GITHUB_WORKFLOW ?? "", process.env.GITHUB_JOB ?? "", key),
      body: comment,
      warn: (message) => console.log(`::warning::${message}`),
    });
    if (done !== "skipped") console.log(`${done === "posted" ? "Posted" : "Updated"} the comment on #${pr}.`);
  }

  if (issues && input("fail-on-new-issues") === "true") stop(`Context Machines found ${plural(issues, before ? "new issue" : "issue")} (fail-on-new-issues is on).`);
}

function pullRequestNumber(): number | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !existsSync(file)) return undefined;
  const event = JSON.parse(readFileSync(file, "utf8")) as { pull_request?: { number?: number }; number?: number };
  return event.pull_request?.number ?? event.number;
}

// Run when started as the Action; imported by run.test.ts, it only lends its helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
