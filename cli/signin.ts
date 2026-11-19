/**
 * Signing in as a test account, and keeping it signed in (AUTH C2 to C4): one helper,
 * `ensureSession`, used by a single test, a suite, the web view and the bench alike.
 *
 *   - A saved session younger than 10 minutes is used as it is; an older one is checked with one page
 *     load (its signed-in check, measured), and one older than 24 hours is replaced.
 *   - Replacing it replays the account's saved sign-in steps with no AI. Only when there are none, or
 *     the page has changed, is the AI asked to plan the sign-in (counted as asks), if there is one.
 *   - A sign-in counts only when the browser measures it signed in (C3): no password or code field,
 *     no "check your email" or "wrong password", and the account's own signed-in check. Only then is
 *     the session saved.
 *   - A password the site refuses stops that account for the rest of the run and the suite (hard
 *     rule 8): no second try, no AI re-plan; at most 3 sign-in submits per account in any case.
 *
 * A test that finds itself signed out mid-run (`sessionExpired`) is run once more, from step 1, after
 * one sign-in with no AI (`runSignedIn`).
 *
 * A sign-in is recorded like any run: a video (run.webm) and step photos in its own folder, and the live
 * screen when the caller gives `onPage`. Every box a stored value goes into is masked as dots before the
 * first key (cover.ts); the test after it keeps that video beside its own, as sign-in.webm.
 */
import { chmodSync, existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { readSaved, writeSaved, type SavedTest } from "../packages/scanner/src/tester/cache.ts";
import { verify } from "../packages/scanner/src/tester/check.ts";
import { guardSite } from "../packages/scanner/src/tester/act.ts";
import { onProvider, PROVIDER_HOSTS, type OwnerAccess } from "../packages/scanner/src/tester/access.ts";
import type { Masker, Resolver } from "../packages/scanner/src/tester/placeholders.ts";
import { launch, saveContextState, SIZE, type StorageState } from "../packages/scanner/src/tester/record.ts";
import { runTest, type RunOptions, type RunOutcome, type SignInGuard } from "../packages/scanner/src/tester/run.ts";
import { CouldNotRun, type Check, type SignInCode, type TesterBrain, type TestEvent, type TestResult } from "../packages/scanner/src/tester/types.ts";
import { accountEnvName, accountHostsFor, accountProblem, accountResolver, codeNeedsPerson, isMine, loadAccounts, signInAllowed, ownerAccessFor, recordCreated, secretKey, sessionAge, sessionPathFor, SESSION_CHECK_AFTER_MS, SESSION_MAX_AGE_MS, signInStepsPathFor, signInWords, setUpWords, smsFix, testCodeRefused, writeOwnerOnly, type Account, type SecretStore, type SignUpResolver } from "./accounts.ts";

/** The signed-in check an account's sign-in ends with (C3): its own words or address, and leaving its sign-in page. */
export function signedInCheckFor(account: Pick<Account, "signedIn" | "signInPage">): Extract<Check, { kind: "signed_in" }> {
  return { kind: "signed_in", ...(account.signedIn?.text ? { text: account.signedIn.text } : {}), ...(account.signedIn?.url ? { url: account.signedIn.url } : {}), ...(account.signInPage ? { left: account.signInPage } : {}) };
}

/**
 * Saved sign-in steps from before C3 end with `password_gone`, which a "check your email" page also
 * passes: on load, that last check becomes a real signed-in check (the account's, or the bare one).
 */
export function upgradeSignInSteps(saved: SavedTest, check: Check = { kind: "signed_in" }): SavedTest {
  const last = saved.steps.at(-1);
  if (!last || last.check.kind !== "password_gone") return saved;
  return { ...saved, steps: [...saved.steps.slice(0, -1), { ...last, check }] };
}

/** Where the sign-in page is: the account's sign-in page on the test's site, or the test's own address. */
export function signInStart(account: Pick<Account, "signInPage">, url: string): string {
  if (!account.signInPage) return url;
  // A sign-in page is a path on the test's own site: one that would leave it (//other.example) is never used.
  const start = new URL(account.signInPage, new URL(url).origin);
  return start.origin === new URL(url).origin ? start.href : url;
}

export interface SessionNeed {
  outDir: string;
  /** The test's address: the session is for its host. */
  url: string;
  account: Account;
  resolver: Resolver;
  mask: Masker;
  guard: SignInGuard;
  /** A sign-in planner and actor, for when there are no saved steps (or they no longer work). Asks are the caller's to count. */
  brain?: TesterBrain;
  /** "never": an expired session is not signed in again (BLOCKED AUTH_SESSION_EXPIRED). */
  relogin?: "auto" | "never";
  browser?: Browser;
  /** Where the sign-in's own run folder goes (its video and photos, its boxes as dots). */
  runsDir: string;
  allowHosts?: string[];
  headed?: boolean;
  minutes?: number;
  on?: (e: TestEvent) => void;
  /** Said as it happens: "Signed in again from saved steps (no AI, 3 s)". */
  say?: (words: string) => void;
  now?: () => number;
  /** C9: this run may make an account (--sign-up), for an account that signs up. Never on live unless it says "signUps": true. */
  allowSignUp?: boolean;
  /** local, staging or live: a sign-up on live needs `liveSignUps`. */
  environment?: string;
  /** The live environment says "signUps": true. */
  liveSignUps?: boolean;
  /** Where a sign-up's password is kept, so a later test can sign in as that account (new-<run>). */
  store?: SecretStore;
  /** C15: what the site's owner issued for its host, sent only there (ownerAccessFor). */
  owner?: OwnerAccess;
  /** --owner-host: in CI, the host that counts as yours for this run. */
  ownerHost?: string;
  /** The sign-in's page as soon as it exists (the web view's live screen), and the card's moments: as a test's. */
  onPage?: RunOptions["onPage"];
  onCover?: RunOptions["onCover"];
}

export type SessionResult =
  /** `video`: the sign-in's own video (its boxes as dots), when it signed in just now. */
  | { path: string; how: "saved" | "checked" | "replayed" | "planned"; result?: TestResult; video?: string }
  | { blocked: string; code: SignInCode; result?: TestResult };

const signInDir = (runsDir: string) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let dir = join(runsDir, `sign-in-${stamp}`);
  for (let k = 2; existsSync(dir); k++) dir = join(runsDir, `sign-in-${stamp}-${k}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** The one-line fix for each code (C19). */
export function codeFix(code: SignInCode, account: Pick<Account, "label">, url: string): string {
  const host = new URL(url).host;
  switch (code) {
    case "AUTH_CREDENTIAL_INVALID":
      return `the site refused ${account.label}'s password, so store the right one with npx contextmachines accounts secret ${account.label} password (or set ${accountEnvName(account.label, "password")})`;
    case "AUTH_ACCOUNT_LOCKED_OUT":
      return `${account.label} is locked out, or has had its 3 sign-in tries: unlock it on ${host}, or use another test account`;
    case "AUTH_CREDENTIAL_UNAVAILABLE":
      return `there's no value for ${account.label}'s username or password, so set it with npx contextmachines accounts secret ${account.label} password`;
    case "AUTH_SESSION_EXPIRED":
      return `${account.label}'s session on ${host} has expired and couldn't be renewed here: press Set up sign-in for ${account.label} under Accounts in the app (or run npx contextmachines accounts setup ${account.label} --url ${new URL(url).origin}), then run it again`;
    case "CODE_NOT_RECEIVED":
      return `the app sent ${account.label} no code or link (the mail catcher answered the whole time): check the app's email settings point at the catcher, then run it again`;
    case "CODE_SOURCE_UNAVAILABLE":
      return `no code could be read for ${account.label}: start the mail catcher (mailpit) at the address in "codes", or add "codes": [{ "catcher": "http://127.0.0.1:8025" }] to the account`;
    case "CODE_NOT_SURE":
      return `a message came for ${account.label}, but which code or link to use wasn't certain, so none was typed: look at the message in the mail catcher`;
    case "SIGNUP_NOT_ALLOWED":
      return `a sign-up makes a real account on ${host}: it runs only with --sign-up, on a host you've marked as yours, and never on live unless that environment says "signUps": true`;
    case "AUTH_BASIC_REQUIRED":
      return `${host} asks for a basic-auth login: add "basic" for it under "sites" in contextmachines.config.json, and store its password with npx contextmachines accounts site basic --url ${host}`;
    case "VERCEL_BYPASS_REQUIRED":
      return `${host} is behind Vercel's deployment protection: add "vercelBypass" for it under "sites", with the project's "Protection Bypass for Automation" secret (npx contextmachines accounts site vercel --url ${host}, or CM_SITE_VERCEL_BYPASS)`;
    case "ACCESS_TOKEN_REQUIRED":
      return `a bot check stands in front of ${host}, which you own: ask your firewall to let a header of yours through, and add it under "sites" (Context Machines never gets past a bot check itself)`;
    case "CODE_NEEDS_PERSON":
      return `${host} sent ${account.label} a code or link to your own inbox, which Context Machines can't read and a run never waits for: ${setUpWords(account.label, new URL(url).origin)} (on your own app, a mail catcher or the sign-in provider's test code works with no one there)`;
    case "SMS_CODE_NEEDED":
      return smsFix(account.label, host);
    case "DEVICE_CHECK":
      return `${host} asked to confirm a new device for ${account.label} ("check your email to confirm it's you"), which a run never waits for: use a QA account with this check turned off, a mail catcher ("codes": [{ "catcher": "http://127.0.0.1:8025" }]) or the sign-in provider's test mode; or ${setUpWords(account.label, new URL(url).origin)}`;
    case "TEST_CODE_NOT_ALLOWED":
      return testCodeRefused(account.label, host);
    case "BOT_CHECK_NEEDS_PERSON":
      return `a captcha or bot check stood in front of signing in as ${account.label} on ${host}, which Context Machines never gets past and a run never waits for: ${setUpWords(account.label, new URL(url).origin).replace("type it there once", "pass the check there yourself once")}`;
    case "SEED_DATA_MISSING":
      return `the site refused a save for a reason it explained, and the form had no other choice the tester may use: add what the site needs on ${host} (for example, an account it accepts), or say which to use in What the tester should know about this site, then run it again`;
    case "SIGN_IN_NOT_CONFIRMED":
      return `you haven't said ${account.label} is your own account on ${host}: run npx contextmachines accounts sign-in ${host} (or confirm it in the app's Accounts)`;
    case "AUTH_ACCOUNT_NEEDED":
      return `the test signs in and had no account to sign in as: add one under Accounts and confirm it's your own account on ${host} (or run with --as <label>)`;
    case "ACCOUNT_NOT_CHOSEN":
      return `the project has several test accounts and nothing said which to sign in as: say "as <label>" in the goal, pick one on the Login step, or set a default test account in Settings`;
    case "VALUE_NEEDED":
      return `a step needs a value it won't make up: pass it with --var name=… and say {name} in the goal or steps`;
  }
}

/**
 * Whether a saved session can be checked at all: only by the account's own signed-in words or address.
 * Without them the check would open the test's page, which may be public, and a signed-out page there
 * passes the bare check (no form, not the sign-in page): such a session is signed in again instead.
 */
export function checkable(account: Pick<Account, "signedIn">): boolean {
  return Boolean(account.signedIn?.text || account.signedIn?.url);
}

/**
 * Opens the saved session once and measures the signed-in check, writing back what the site changed
 * (a rotated token). Never for an account with no signed-in words (see checkable), and the file is
 * rewritten (so its age starts again) only when the check held.
 */
async function stillSignedIn(need: SessionNeed, path: string, browser: Browser): Promise<boolean> {
  if (!checkable(need.account)) return false;
  const context = await browser.newContext({ viewport: SIZE, storageState: path, acceptDownloads: false, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    // Kept on the site as a test is, with the owner's tokens for its host (a walled staging site).
    await guardSite(page, need.url, need.allowHosts ?? [], need.owner ? { owner: need.owner } : {});
    const where = need.account.signedIn?.url && need.account.signedIn.url.startsWith("/") ? new URL(need.account.signedIn.url, new URL(need.url).origin).href : need.url;
    await page.goto(where, { timeout: 30_000, waitUntil: "domcontentloaded" });
    const v = await verify(page, signedInCheckFor(need.account), 3000);
    if (v.ok) await saveContextState(context, path);
    return v.ok;
  } catch {
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * A session for this account on this host, signed in if need be: its path, or why there can't be
 * one (BLOCKED with a code). `force`: the session is known to have expired (a test was sent back to
 * sign in), so it is replaced whatever its age.
 */
export async function ensureSession(need: SessionNeed, o: { force?: boolean } = {}): Promise<SessionResult> {
  const { account, outDir, url } = need;
  const now = need.now?.() ?? Date.now();
  const path = sessionPathFor(outDir, url, account.label);
  const stepsPath = signInStepsPathFor(outDir, url, account.label);
  const blocked = (code: SignInCode, result?: TestResult): SessionResult => ({ blocked: `${code}: ${codeFix(code, account, url)}`, code, ...(result ? { result } : {}) });
  if (need.guard.rejected.has(account.label)) return blocked("AUTH_CREDENTIAL_INVALID");
  // A new-device check met earlier in this job: the sign-in isn't sent again (each send could mail the person again).
  if (need.guard.deviceCheck?.has(account.label)) return blocked("DEVICE_CHECK");
  // C9: a sign-up makes a real account: only when asked for, and never on live unless it says so (D5).
  const signUp = account.first === "sign-up";
  const host = new URL(url).host;
  // Worked out here, never taken from the caller: a sign-up (a real account made) only on a host marked
  // as yours; a sign-in on one marked as yours, or where the person said it's their own account.
  const owned = isMine(outDir, host, need.ownerHost);
  if (!owned && !signInAllowed(outDir, host, need.ownerHost)) return blocked("SIGN_IN_NOT_CONFIRMED");
  if (signUp && (!owned || !need.allowSignUp || (need.environment === "live" && !need.liveSignUps))) return blocked("SIGNUP_NOT_ALLOWED");
  /** Each try of a sign-up gets a new address and password; a sign-in, the account's own values. */
  const valuesFor = (): Resolver => (signUp ? (need.resolver.renew?.() ?? need.resolver) : need.resolver);
  /** After a sign-up's try: one line in the audit log, and its password kept for a later sign-in. */
  const logSignUp = (r: Resolver, passed: boolean) => {
    const made = (r as Partial<SignUpResolver>).signUp;
    if (!signUp || !made || !(r as SignUpResolver).used()) return;
    recordCreated(outDir, { at: new Date().toISOString(), host, environment: need.environment ?? "local", address: made.email, label: account.label, run: made.run, status: "left", passed });
    if (passed && need.store) {
      try {
        need.store.set(secretKey(host, `new-${made.run}`, "username"), made.email);
        need.store.set(secretKey(host, `new-${made.run}`, "password"), made.password);
      } catch {
        // no store here: the account is in the audit log, its password isn't kept
      }
    }
  };
  const own = !need.browser;
  let browser = need.browser;
  try {
    const age = sessionAge(path, now);
    // A code or link to the person's own inbox or phone (or a sign-in by hand): no run can sign in
    // again alone (A1), so the session "Set up sign-in" saved is used while it still works.
    const nobody = account.first === "by-hand" ? undefined : codeNeedsPerson(account, need.resolver, new URL(url).origin);
    const alone = account.first !== "by-hand" && !nobody;
    if (!o.force && age !== undefined && (age < SESSION_MAX_AGE_MS || (!alone && checkable(account)))) {
      // Unchecked while fresh; one that can't be checked (no signed-in words) is used as it is for a day
      // when no run could renew it, and the run itself says so if it finds itself signed out.
      if (age < SESSION_CHECK_AFTER_MS || (!alone && !checkable(account))) return { path, how: "saved" };
      browser ??= await launch(need.headed ?? false);
      if (await stillSignedIn(need, path, browser)) return { path, how: "checked" };
    }
    if (o.force && need.relogin === "never") return blocked("AUTH_SESSION_EXPIRED");
    // An account signed in by hand (C13) can't be signed in again by itself.
    if (account.first === "by-hand") return { blocked: `AUTH_SESSION_EXPIRED: ${account.label} signs in by hand, so its session can't be renewed by a run: ${setUpWords(account.label, new URL(url).origin)}`, code: "AUTH_SESSION_EXPIRED" };
    // A code or link to the person's own inbox or phone, and a run never waits for a person: said now,
    // before the browser opens, so no real code is sent that no one can type.
    if (nobody) {
      const code: SignInCode = account.first === "sms-code" ? "SMS_CODE_NEEDED" : age !== undefined ? "AUTH_SESSION_EXPIRED" : "CODE_NEEDS_PERSON";
      return { blocked: `${code}: ${age !== undefined ? `${account.label}'s saved session on ${host} no longer works. ` : ""}${nobody}`, code };
    }
    const problem = accountProblem(account, need.resolver);
    if (problem) return { blocked: `AUTH_CREDENTIAL_UNAVAILABLE: ${problem}`, code: "AUTH_CREDENTIAL_UNAVAILABLE" };
    browser ??= await launch(need.headed ?? false);
    const check = signedInCheckFor(account);
    const base = {
      url: signInStart(account, url), browser, masker: need.mask, signInGuard: need.guard,
      // Recorded like any run (a video, photos, the live screen), with every box a stored value goes into as dots.
      saveStateTo: path, noMadeUp: true, minutes: need.minutes ?? 3, allowHosts: need.allowHosts ?? [],
      ...(need.onPage ? { onPage: need.onPage } : {}), ...(need.onCover ? { onCover: need.onCover } : {}),
      // A sign-in is one measured step (W1-L2), however many pages it crosses: a sign-up with a code by
      // email is 6 actions done right, so it gets room for a few that need a second try.
      maxPerStep: SIGN_IN_ACTIONS,
      // C7: "send code" may be pressed on the account's own host, where the person may sign in (checked above).
      codeSends: { host, ...(signUp && owned ? { signUp: true } : {}) },
      // The account's values are typed only on these exact hosts (its own, and ones marked or said OK).
      accountHosts: accountHostsFor(outDir, url, need.ownerHost),
      ...(owned ? {} : { notOwned: true }),
      // C15, C13: the owner's tokens for this host, and a provider's sign-in window left to answer.
      // ownedHost is the real answer: a host the person only signs in on gets no owner setup lines.
      ownedHost: owned, keepPopups: true, ...(need.owner ? { owner: need.owner } : {}),
      ...(account.signInPage ? { signInPath: account.signInPage } : {}),
      ...(need.on ? { on: need.on } : {}),
    };
    const t0 = Date.now();
    // Saved steps first: no AI.
    if (existsSync(stepsPath)) {
      let saved: SavedTest | undefined;
      try {
        saved = upgradeSignInSteps(readSaved(stepsPath), check);
      } catch {
        saved = undefined;
      }
      if (saved) {
        const dir = signInDir(need.runsDir);
        const secrets = valuesFor();
        const outcome = await runTest({ ...base, secrets, goal: saved.goal, saved, dir }).catch((e: unknown) => (e instanceof CouldNotRun ? undefined : Promise.reject(e)));
        if (outcome) logSignUp(secrets, outcome.result.verdict === "pass");
        if (outcome?.result.code) return blocked(outcome.result.code, outcome.result);
        if (outcome?.result.verdict === "pass" && existsSync(path)) {
          need.say?.(`Signed in as ${account.label} again from saved steps (no AI, ${Math.round((Date.now() - t0) / 1000)} s)`);
          return { path, how: "replayed", result: outcome.result, ...(outcome.result.video ? { video: join(dir, outcome.result.video) } : {}) };
        }
      }
    }
    if (!need.brain) return blocked(existsSync(stepsPath) ? "AUTH_SESSION_EXPIRED" : "AUTH_CREDENTIAL_UNAVAILABLE");
    const dir = signInDir(need.runsDir);
    let outcome: RunOutcome;
    const secrets = valuesFor();
    try {
      outcome = await runTest({ ...base, secrets, goal: signInWords(account), brain: need.brain, dir });
      logSignUp(secrets, outcome.result.verdict === "pass");
    } catch (error) {
      if (!(error instanceof CouldNotRun)) throw error;
      try {
        rmdirSync(dir);
      } catch {
        // something was written: kept
      }
      throw error;
    }
    if (outcome.result.code) return blocked(outcome.result.code, outcome.result);
    if (outcome.result.verdict !== "pass" || !existsSync(path)) {
      const stopped = outcome.result.steps.find((s) => s.verdict !== "passed");
      const why = need.mask(stopped?.reason ?? "it didn't pass");
      // A "confirm it's a new device" page has its own code and fix (change 2), never "expired".
      if (/asks to confirm a new device|DEVICE_CHECK/.test(why)) return blocked("DEVICE_CHECK", outcome.result);
      // A bot check in front of the sign-in: on your own host, the owner token to set (with the provider's
      // own setup line); elsewhere, a person passes it once in Set up sign-in. Never "expired".
      if (outcome.result.botWall || stopped?.blockedGroup === "bot_wall") {
        const code: SignInCode = owned ? "ACCESS_TOKEN_REQUIRED" : "BOT_CHECK_NEEDS_PERSON";
        return { blocked: `${code}: ${why}${owned ? ` Or ${setUpWords(account.label, new URL(url).origin).replace("type it there once", "pass the check there yourself once")}.` : ` ${codeFix(code, account, url)}`}`, code, result: outcome.result };
      }
      return { blocked: `the sign-in as ${account.label} didn't finish: ${why}`, code: "AUTH_SESSION_EXPIRED", result: outcome.result };
    }
    if (outcome.save) {
      mkdirSync(join(outDir, ".auth"), { recursive: true, mode: 0o700 });
      writeSaved(stepsPath, { ...outcome.save, as: account.label }, need.mask);
      chmodSync(stepsPath, 0o600);
    }
    need.say?.(`Signed in as ${account.label} (planned by the AI; its steps are saved, so next time needs no AI)`);
    return { path, how: "planned", result: outcome.result, ...(outcome.result.video ? { video: join(dir, outcome.result.video) } : {}) };
  } finally {
    if (own && browser) await browser.close().catch(() => {});
  }
}

/**
 * Runs a signed-in test, and once more from step 1 if it found itself signed out: after signing in
 * again (with no AI when the steps are saved). `run` is told the sign-in's own video, when it signed in
 * just now, to keep beside its own (its boxes as dots).
 */
export async function runSignedIn(need: SessionNeed, run: (sessionPath: string, again: boolean, signInVideo?: string) => Promise<RunOutcome>, first: SessionResult): Promise<{ outcome?: RunOutcome; session: SessionResult; relogins: number }> {
  if ("blocked" in first) return { session: first, relogins: 0 };
  const outcome = await run(first.path, false, first.video);
  if (!outcome.sessionExpired) return { outcome, session: first, relogins: 0 };
  need.say?.(`${need.account.label}'s session had expired: signing in again`);
  const again = await ensureSession(need, { force: true });
  if ("blocked" in again) return { outcome, session: again, relogins: 1 };
  return { outcome: await run(again.path, true, again.video), session: again, relogins: 1 };
}

/** Actions a sign-in's one step may take (a test's step gets 8). */
export const SIGN_IN_ACTIONS = 16;

/** How an account may sign in first, today. */
export const BUILT_FIRST: readonly string[] = ["password", "email-code", "magic-link", "sms-code", "sign-up", "by-hand"];

/** An account ready to use on a host, or why it can't be. */
export type AccountUse = { account: Account; resolver: Resolver; warnings: string[] } | { error: string; code?: SignInCode };

/**
 * The account `label` for a test on `url`: from the project's config, on a host marked mine (or the
 * one CI named) or where the person said it's their own account (a sign-up: marked mine only), with its values set. The words to say when it can't be used.
 */
export function accountFor(o: { dir?: string; outDir: string; url: string; label: string; store: SecretStore; env?: NodeJS.ProcessEnv; ownerHost?: string; environment?: string }): AccountUse {
  let config: ReturnType<typeof loadAccounts>;
  try {
    config = loadAccounts(o.dir);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const account = config.accounts.get(o.label);
  if (!account) return { error: `there's no account "${o.label}" in contextmachines.config.json${config.accounts.size ? ` (there is ${[...config.accounts.keys()].join(", ")})` : ""}: add it under "accounts"`, code: "AUTH_ACCOUNT_NEEDED" };
  const host = new URL(o.url).host;
  const owned = isMine(o.outDir, host, o.ownerHost);
  // A sign-up makes a real account: only on a site marked as yours, whatever else was said.
  if (account.first === "sign-up" && !owned) return { error: `SIGNUP_NOT_ALLOWED: ${o.label} makes a real account on ${host}, and a sign-up runs only on a site you've marked as yours: npx contextmachines accounts mine ${host}`, code: "SIGNUP_NOT_ALLOWED" };
  if (!signInAllowed(o.outDir, host, o.ownerHost)) return { error: `SIGN_IN_NOT_CONFIRMED: ${host} isn't one you've said you sign in on, so no account signs in there. If it's your own account, say so once: npx contextmachines accounts sign-in ${host}. The tester still won't post, pay, send or delete there.`, code: "SIGN_IN_NOT_CONFIRMED" };
  if (!BUILT_FIRST.includes(account.first)) return { error: `${o.label} signs in with ${account.first}, which isn't built yet: a password, an email code, a code by text, a magic link, a sign-up and a sign-in by hand are, so far` };
  // Change 3: a provider's test code is for your own app's test mode only: refused here, before the browser opens.
  if (account.testCode && !owned) return { error: `TEST_CODE_NOT_ALLOWED: ${testCodeRefused(o.label, host)}`, code: "TEST_CODE_NOT_ALLOWED" };
  const resolver = accountResolver(account, { host, store: o.store, owned, ownedHost: (h) => isMine(o.outDir, h, o.ownerHost), ...(o.env ? { env: o.env } : {}), ...(o.environment ? { environment: o.environment } : {}) });
  return { account, resolver, warnings: config.warnings };
}

/**
 * The site's owner access for a test on `url` (C15), and whether its host is marked mine: what to
 * send there (only there), or the one line to say when a value it names isn't set.
 */
export async function siteAccessFor(o: { dir?: string; outDir: string; url: string; store: SecretStore; env?: NodeJS.ProcessEnv; ownerHost?: string; environment?: string; clerkApi?: string }): Promise<{ owner?: OwnerAccess; ownedHost: boolean; error?: string; warning?: string }> {
  const ownedHost = isMine(o.outDir, new URL(o.url).host, o.ownerHost);
  let config: ReturnType<typeof loadAccounts>;
  try {
    config = loadAccounts(o.dir);
  } catch (error) {
    return { ownedHost, error: error instanceof Error ? error.message : String(error) };
  }
  const got = await ownerAccessFor({ config, outDir: o.outDir, url: o.url, store: o.store, ...(o.env ? { env: o.env } : {}), ...(o.environment ? { environment: o.environment } : {}), ...(o.ownerHost ? { ownerHost: o.ownerHost } : {}), ...(o.clerkApi ? { clerkApi: o.clerkApi } : {}) });
  return { ownedHost, ...(got.access ? { owner: got.access } : {}), ...(got.error ? { error: got.error } : {}), ...(got.warning ? { warning: got.warning } : {}) };
}

/**
 * The Clerk Frontend API host to keep cookies for after a sign-in by hand, read from the config only: no
 * testing token is made (the window gets none, so the secret key isn't used). Only on a host marked as yours.
 */
export function clerkKeepHostFor(o: { dir?: string; outDir: string; url: string; ownerHost?: string }): string | undefined {
  const host = new URL(o.url).host.toLowerCase();
  if (!isMine(o.outDir, host, o.ownerHost)) return undefined;
  try {
    return loadAccounts(o.dir).sites?.get(host)?.clerk?.fapiHost;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Signing in by hand (C13): Google, Microsoft and Apple sign-ins are never automated. The person
// signs in in a window the tester opened (its automation shows, as it always does: nothing is
// hidden), and only the app's own cookies and storage are kept.

type State = StorageState;

/** Whether a cookie's domain belongs to one of these hosts (the host itself, or a parent domain of it). */
const cookieFor = (domain: string, hosts: readonly string[]) => {
  const d = domain.replace(/^\./, "").toLowerCase();
  return hosts.some((h) => {
    const name = h.replace(/:\d+$/, "").toLowerCase();
    return name === d || name.endsWith(`.${d}`);
  });
};

/**
 * A session with only what belongs to `keepHosts` (the app's own hosts, and the owner's sign-in host
 * such as a Clerk Frontend API): every other site's cookies and storage dropped, a sign-in provider's
 * (Google, Microsoft, Apple, GitHub) always. How many of each were dropped.
 */
export function keepOnly(state: State, keepAll: readonly string[]): { state: State; dropped: { cookies: number; origins: number } } {
  const keepHosts = keepAll.filter((h) => !onProvider(`https://${h}/`));
  const cookies = state.cookies.filter((c) => cookieFor(c.domain, keepHosts) && !providerCookie(c.domain));
  const origins = state.origins.filter((o) => {
    try {
      const u = new URL(o.origin);
      return keepHosts.some((h) => h.toLowerCase() === u.host.toLowerCase() || h.toLowerCase() === u.hostname.toLowerCase()) && !onProvider(o.origin);
    } catch {
      return false;
    }
  });
  return { state: { ...state, cookies, origins }, dropped: { cookies: state.cookies.length - cookies.length, origins: state.origins.length - origins.length } };
}

/** A cookie a sign-in provider set: on its sign-in host, or on a domain above it (Google's .google.com). */
function providerCookie(domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  return onProvider(`https://${d}/`) || PROVIDER_HOSTS.some((p) => p.endsWith(`.${d}`));
}

/** A session with every sign-in provider's cookies and storage dropped, the rest kept (learn --login's). */
export function withoutProviders(state: State): State {
  return { ...state, cookies: state.cookies.filter((c) => !providerCookie(c.domain)), origins: state.origins.filter((o) => !onProvider(o.origin)) };
}

/**
 * `test --setup --by-hand --as <label>`: a browser window on the sign-in page; the person signs in
 * (`done` resolves when they press Enter; false when they cancel). Then the account's signed-in check
 * is measured (C3), and only then is the session saved, with only the app's own cookies and storage.
 */
export async function signInByHand(o: {
  outDir: string; url: string; account: Account; done: (page: Page) => Promise<boolean>;
  /** Hosts whose cookies are kept beside the app's own (an owner's sign-in host, --allow-host ones). */
  alsoKeep?: string[];
  /** The browser: a headed one by default (tests pass a headless one and a scripted person). */
  browser?: Browser;
}): Promise<{ path: string; dropped: { cookies: number; origins: number } } | { error: string }> {
  const own = !o.browser;
  const browser = o.browser ?? (await launch(true));
  try {
    const context = await browser.newContext({ viewport: SIZE });
    const page = await context.newPage();
    await page.goto(signInStart(o.account, o.url), { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => {});
    if (!(await o.done(page))) return { error: "the sign-in by hand was cancelled: nothing was saved" };
    const host = new URL(o.url).host;
    // Measured on the app's own page (the person may have left the window on another).
    const on = context.pages().find((p) => {
      try {
        return new URL(p.url()).host === host;
      } catch {
        return false;
      }
    }) ?? page;
    if (new URL(on.url().startsWith("http") ? on.url() : o.url).host !== host) await on.goto(o.url, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => {});
    const v = await verify(on, signedInCheckFor(o.account), 5000);
    if (!v.ok) return { error: `it doesn't look signed in as ${o.account.label} on ${host} (it wanted ${v.expected}; it found ${v.found}): nothing was saved` };
    const kept = keepOnly(await context.storageState({ indexedDB: true }).catch(() => context.storageState()), [host, ...(o.alsoKeep ?? []).filter((h) => !onProvider(`https://${h}/`))]);
    const path = sessionPathFor(o.outDir, o.url, o.account.label);
    writeOwnerOnly(path, JSON.stringify(kept.state));
    await context.close().catch(() => {});
    return { path, dropped: kept.dropped };
  } finally {
    if (own) await browser.close().catch(() => {});
  }
}
