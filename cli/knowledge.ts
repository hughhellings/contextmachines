/**
 * "What the tester should know about this site", on disk: one plain Markdown file per project,
 * contextmachines/context.md (e2e calls the same thing an agent's `context`), next to tests/ and runs/,
 * never under .auth/. The app's box and the terminal read and write the same file; `--context "<text>"`
 * adds to it for one run. Refused, never cut: over 4,000 characters, or anything that looks like a
 * password, key or token, or holds one of the project's stored values (notes.ts notesProblem).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_MAX, NOTES_NAME, notesProblem, tidyNotes } from "../packages/scanner/src/tester/notes.ts";

export { NOTES_MAX, NOTES_NAME, notesProblem };

/** The file's name in the project's contextmachines folder. */
export const CONTEXT_FILE = "context.md";

/** Where a project's notes live: <out dir>/context.md (the out dir is ./contextmachines by default). */
export const contextPathFor = (outDir: string) => join(outDir, CONTEXT_FILE);

/** The hint shown under the box, and in the help. */
export const NOTES_HINT = "Facts about how your site works, in plain words: the tester's planner, its actor and its judges read them with every run. For example: An order needs a delivery date before it can be saved. Use the Demo workspace, not Production. They can't switch off any rule (it still never pays, posts or deletes, and a step still passes only when the page shows it), and never put a password, key or token here.";

/** Said after a NOT SURE or BLOCKED run: the run's reason, then where to tell the tester (e2e's remedy too). */
export const NOTES_NUDGE = "Tell the tester about this site";

/** The notes in the file (tidied), or "" when there is none. */
export function readContextFile(outDir: string): string {
  const file = contextPathFor(outDir);
  if (!existsSync(file)) return "";
  try {
    return tidyNotes(readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

/**
 * The notes for a run: the file's, then `extra` (--context) after them. Refused with why when too long
 * or holding a secret (`values`: the project's own stored values, never shown).
 */
export function siteNotesFor(outDir: string, extra?: string, values: readonly string[] = []): { notes?: string; problem?: string } {
  const notes = [readContextFile(outDir), tidyNotes(extra)].filter(Boolean).join("\n\n");
  if (!notes) return {};
  const problem = notesProblem(notes, values);
  if (problem) return { problem: extra ? `${problem} (${contextPathFor(outDir)} and --context together)` : `${problem} (${contextPathFor(outDir)})` };
  return { notes };
}

/**
 * The stored secrets the notes are checked against besides --var values: the signing-in account's own
 * password and authenticator secret (from wherever they are kept: the Keychain, an env var), and every
 * configured account's password held in an env var. Never shown, never a code made when typed.
 */
export function accountSecrets(o: { use?: { resolver: { names(): string[]; get(name: string): string | undefined } }; accounts?: Iterable<{ password?: unknown; totp?: unknown }>; env?: NodeJS.ProcessEnv } = {}): string[] {
  const env = o.env ?? process.env;
  const out: string[] = [];
  if (o.use) for (const n of o.use.resolver.names()) if (/\.(password|totp)$/.test(n)) {
    try {
      const v = o.use.resolver.get(n);
      if (v) out.push(v);
    } catch {
      /* a value that can't be read now isn't one the notes can hold */
    }
  }
  for (const a of o.accounts ?? []) for (const ref of [a.password, a.totp]) {
    const name = ref && typeof ref === "object" && "env" in ref ? (ref as { env?: unknown }).env : undefined;
    const v = typeof name === "string" ? env[name] : undefined;
    if (v) out.push(v);
  }
  return out;
}

/** Saves the notes (an empty text removes the file). Throws with a person's words when they can't be saved. */
export function writeContextFile(outDir: string, text: string, values: readonly string[] = []): string {
  const t = tidyNotes(text);
  const file = contextPathFor(outDir);
  if (!t) {
    rmSync(file, { force: true });
    return "";
  }
  const problem = notesProblem(t, values);
  if (problem) throw new Error(problem);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, `${t}\n`);
  return t;
}

/** A reason as the nudge quotes it: no code in front, quotes made single, cut at a sentence's end (never mid-word). */
function quoted(reason: string, max = 180): string {
  const t = reason.replace(/\s+/g, " ").trim().replace(/^[A-Z][A-Z_]+:\s*/, "").replace(/"/g, "'");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > 40) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 40 ? space : max)}…`;
}

/**
 * The nudge after a run that didn't pass: where the notes go, and its reason quoted. A SEED_DATA_MISSING
 * says first that the site needs the thing added (notes can't make one), then that the notes can name one
 * that exists. Nothing for a pass or a FAIL, a bot check, a sign-in code or a stop.
 */
export function notesNudge(result: { verdict: string; steps: { verdict: string; reason?: string }[] }, where: string): string | undefined {
  if (result.verdict !== "not_sure" && result.verdict !== "blocked") return undefined;
  const reason = result.steps.find((s) => s.verdict !== "passed" && s.verdict !== "skipped")?.reason ?? "";
  // A bot check, a sign-in code, a stop by the person: notes can't help those.
  if (/\b(bot check|captcha|CODE_|SMS_|AUTH_|SESSION|stopped by you|DEVICE_CHECK|BOT_CHECK)/i.test(reason)) return undefined;
  if (/^SEED_DATA_MISSING\b/.test(reason)) return `${NOTES_NUDGE}: the site had nothing the form could use, so add it on the site first (the line above says what); if it has one already, name it in ${where}, in plain words, and run it again.`;
  const why = quoted(reason);
  return `${NOTES_NUDGE}: if it got stuck on a rule of your site${why ? ` (${why})` : ""}, write the rule in ${where}, in plain words, and run it again.`;
}
