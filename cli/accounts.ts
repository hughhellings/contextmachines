/**
 * Test accounts (AUTH C1a): what an account is (contextmachines.config.json, no secret ever), where its
 * secrets live (the macOS Keychain, an owner-only file, or the environment), which hosts the person
 * has said are theirs (.auth/owned.json, per machine, never the committed config), and the values a
 * run may type, by name ({admin.password}), never shown.
 *
 * The rules, each a one-line refusal when broken:
 *   - a secret field (password, authenticator secret) is never a plain string in the config;
 *   - an env name for a secret starts with CM_ (or is on a short allowlist), so a cloned config can't
 *     type AWS_SECRET_ACCESS_KEY into a page;
 *   - accounts sign in only on a host you marked as yours or where you said you sign in with your own
 *     account (.auth/signin-ok.json); sign-ups, payments and site access stay on hosts marked as yours;
 *   - the words the AI reads ("when to use", "how to sign in") never hold a stored secret.
 * Keychain values are written through /usr/bin/security at its absolute path, the command on stdin
 * and the value base64-encoded, so no value is ever in a process's arguments.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { siteOf } from "../packages/scanner/src/tester/act.ts";
import { catcherProblem, mailpitInbox, waitForMessage, type Inbox } from "../packages/scanner/src/tester/inbox.ts";
import type { Fresh, FreshOptions, Resolver } from "../packages/scanner/src/tester/placeholders.ts";
import { parseTotpSecret, totpNow } from "../packages/scanner/src/tester/totp.ts";
import type { OwnerAccess } from "../packages/scanner/src/tester/access.ts";
import { hideFromAgent } from "./ai.ts";
import { CONFIG_FILE } from "./init.ts";

/** Where a secret field's value comes from: the store (the Keychain on a Mac), or one env var. */
export type SecretRef = { keychain: true } | { env: string };

/** How an account signs in first. A password, an email code, a magic link and a sign-up are built; the others are read, and said to be coming. */
export const FIRST_STEPS = ["password", "email-code", "magic-link", "sms-code", "by-hand", "provider-token", "sign-up"] as const;
export type FirstStep = (typeof FIRST_STEPS)[number];

export interface Account {
  label: string;
  /** Sent to the AI only when no account is pinned. Never a secret. */
  whenToUse?: string;
  first: FirstStep;
  /** A test address may be a plain string; anything else is a secret. */
  username?: string | SecretRef;
  password?: SecretRef;
  totp?: SecretRef;
  /** The sign-in page's path, like /login. */
  signInPage?: string;
  /** What shows when signed in: words on the page, or a part of the address. */
  signedIn?: { text?: string; url?: string };
  /** The sign-in in words, as --setup takes it; the AI reads it, so it never holds a secret. */
  howToSignIn?: string;
  /** Where codes and links by email are read (C8): a mail catcher on this machine, by its address. */
  catcher?: string;
  /**
   * A sign-in provider's fixed test code (Clerk's 424242 for +clerk_test addresses, change 3): typed
   * where the page asks for a code, on a host marked as yours only, and refused before the browser
   * opens anywhere else. Not a secret (it is published), but masked like a code all the same.
   */
  testCode?: string;
  /** A sign-up's address domain (C9): example.com/.net/.org, or one under .test, .localhost or .invalid. Default example.test. */
  signUpDomain?: string;
}

export interface AccountsConfig {
  accounts: Map<string, Account>;
  /** Site access per exact host (C15): what its owner issued, as references to secrets, never a value. */
  sites?: Map<string, SiteAccessConfig>;
  /** Environments that say sign-ups may run there ("signUps": true): only these are allowed on live (D5). */
  signUpsOn?: string[];
  /** Said, never refused: a "mine" in the committed config (ignored), a value that looks like a secret in words the AI reads. */
  warnings: string[];
  /** Every env name the config points a secret at: kept out of every AI process. */
  envNames: string[];
}

/** A config problem, said in one line. */
export class AccountConfigError extends Error {
  override name = "AccountConfigError";
}

/** Env names a secret may come from besides CM_*: a deployment's own bypass secret. */
export const ENV_ALLOWLIST = ["VERCEL_AUTOMATION_BYPASS_SECRET"] as const;
const LABEL = /^[a-z0-9_-]{1,32}$/;
const SECRET_FIELDS = ["password", "totp"] as const;
/** Fields that may be stored: the two secrets, and a username that is a real address. */
export const STORED_FIELDS = ["username", "password", "totp"] as const;
export type StoredField = (typeof STORED_FIELDS)[number];
/** The shortest secret taken (a fixed test code is no secret, and has its own field). */
export const MIN_SECRET_LENGTH = 6;

/** A username that is plainly a test address: may sit in the committed config as it is. */
export const TEST_ADDRESS = /(\+clerk_test@|@([\w-]+\.)*example\.(com|net|org)$|\.(test|localhost|invalid|example)$)/i;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** CM_ACCOUNT_<LABEL>[_<ENV>]_<FIELD>: the label upper-cased, anything outside A-Z0-9 as _. */
export function accountEnvName(label: string, field: StoredField, env?: string): string {
  const up = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `CM_ACCOUNT_${up(label)}${env ? `_${up(env)}` : ""}_${up(field)}`;
}

function secretRef(where: string, v: unknown): SecretRef {
  if (typeof v === "string") throw new AccountConfigError(`${where} is a secret, so it can't sit in ${CONFIG_FILE}: put this in the Keychain or an env var ({ "keychain": true } or { "env": "CM_…" })`);
  if (isObj(v) && v.keychain === true && Object.keys(v).length === 1) return { keychain: true };
  if (isObj(v) && typeof v.env === "string" && Object.keys(v).length === 1) {
    if (!/^CM_[A-Z0-9_]+$/.test(v.env) && !(ENV_ALLOWLIST as readonly string[]).includes(v.env)) throw new AccountConfigError(`${where} reads the env var ${v.env}: a secret's env name must start with CM_ (or be ${ENV_ALLOWLIST.join(", ")}), so a copied config can't type another of your secrets into a page`);
    return { env: v.env };
  }
  throw new AccountConfigError(`${where} should be { "keychain": true } or { "env": "CM_…" }`);
}

/** Words the AI reads, checked for what looks like a secret: warned, never sent as a secret would be. */
function secretShaped(words: string): string | undefined {
  if (/otpauth:\/\//i.test(words)) return "an otpauth:// link";
  if (/\b[A-Z2-7]{16,}=*\b/.test(words)) return "an authenticator secret";
  if (/(?=[\w~+/=-]*\d)(?=[\w~+/=-]*[a-z])[\w~+/=-]{20,}/i.test(words)) return "a long random string";
  return undefined;
}

/**
 * The `accounts` part of the config, checked: every rule above is a one-line refusal. `mine` there is
 * ignored (it is recorded per machine, outside the repo).
 */
export function parseAccounts(raw: unknown): AccountsConfig {
  const warnings: string[] = [];
  const accounts = new Map<string, Account>();
  const envNames = new Set<string>();
  if (!isObj(raw)) return { accounts, warnings, envNames: [] };
  if ("mine" in raw) warnings.push(`"mine" in ${CONFIG_FILE} is ignored: a host is marked yours on this machine only (npx contextmachines accounts mine <host>)`);
  if ("signInOk" in raw || "signin-ok" in raw) warnings.push(`signInOk in ${CONFIG_FILE} is ignored: it is said on this machine only (npx contextmachines accounts sign-in <host>)`);
  const list = raw.accounts;
  if (list === undefined) {
    const sites = parseSites(raw.sites, envNames);
    return { accounts, warnings, envNames: [...envNames], ...(sites.size ? { sites } : {}) };
  }
  if (!isObj(list)) throw new AccountConfigError(`"accounts" in ${CONFIG_FILE} should be an object of label → account`);
  const byEnv = new Map<string, string>();
  for (const [label, a] of Object.entries(list)) {
    if (!LABEL.test(label)) throw new AccountConfigError(`the account label "${label.slice(0, 40)}" should be 1 to 32 of a-z, 0-9, _ and -`);
    const clash = byEnv.get(accountEnvName(label, "password"));
    if (clash) throw new AccountConfigError(`the accounts "${clash}" and "${label}" share the env names ${accountEnvName(label, "password").replace(/_PASSWORD$/, "_*")}: rename one`);
    byEnv.set(accountEnvName(label, "password"), label);
    if (!isObj(a)) throw new AccountConfigError(`the account "${label}" should be an object`);
    if ("mine" in a) warnings.push(`"mine" on the account "${label}" is ignored: a host is marked yours on this machine only`);
    if ("signInOk" in a || "signin-ok" in a) warnings.push(`signInOk on the account "${label}" is ignored: it is said on this machine only (npx contextmachines accounts sign-in <host>)`);
    // The old single method ("password+totp") is read as first + extra.
    const firstRaw = typeof a.first === "string" ? a.first : typeof a.method === "string" ? a.method.split("+")[0] : "password";
    if (!(FIRST_STEPS as readonly string[]).includes(firstRaw!)) throw new AccountConfigError(`${label}.first is "${String(firstRaw).slice(0, 30)}": it should be one of ${FIRST_STEPS.join(", ")}`);
    const account: Account = { label, first: firstRaw as FirstStep };
    for (const field of SECRET_FIELDS) if (a[field] !== undefined) account[field] = secretRef(`${label}.${field}`, a[field]);
    if (a.username !== undefined) {
      if (typeof a.username === "string") {
        if (!TEST_ADDRESS.test(a.username.trim())) throw new AccountConfigError(`${label}.username isn't a test address (like test@example.com or a .test host), so it's treated as a secret: put this in the Keychain or an env var ({ "keychain": true } or { "env": "CM_…" })`);
        account.username = a.username.trim();
      } else account.username = secretRef(`${label}.username`, a.username);
    }
    for (const field of STORED_FIELDS) {
      const ref = account[field];
      if (ref && typeof ref === "object" && "env" in ref) envNames.add(ref.env);
    }
    if (a.whenToUse !== undefined) {
      if (typeof a.whenToUse !== "string" || a.whenToUse.length > 500) throw new AccountConfigError(`${label}.whenToUse should be words, at most 500 characters`);
      account.whenToUse = a.whenToUse.trim();
    }
    if (a.howToSignIn !== undefined) {
      if (typeof a.howToSignIn !== "string" || a.howToSignIn.length > 4000) throw new AccountConfigError(`${label}.howToSignIn should be words, at most 4000 characters`);
      account.howToSignIn = a.howToSignIn.trim();
    }
    for (const [field, words] of [["whenToUse", account.whenToUse], ["howToSignIn", account.howToSignIn]] as const) {
      const shape = words ? secretShaped(words) : undefined;
      if (shape) warnings.push(`${label}.${field} holds what looks like ${shape}: the AI reads these words, so a secret never belongs there`);
    }
    if (a.signInPage !== undefined) {
      if (typeof a.signInPage !== "string" || !signInPathOk(a.signInPage) || a.signInPage.length > 200) throw new AccountConfigError(`${label}.signInPage should be a path on the site, like /login`);
      account.signInPage = a.signInPage;
    }
    if (a.codes !== undefined) {
      // "codes": ["totp", { "catcher": "http://127.0.0.1:8025" }]: a catcher on this machine only (tier A).
      if (!Array.isArray(a.codes)) throw new AccountConfigError(`${label}.codes should be a list, like ["totp", { "catcher": "http://127.0.0.1:8025" }]`);
      for (const c of a.codes) {
        if (c === "totp") continue;
        if (isObj(c) && typeof c.catcher === "string" && Object.keys(c).length === 1) {
          const why = catcherProblem(c.catcher);
          if (why) throw new AccountConfigError(`${label}.codes: ${why}`);
          account.catcher ??= c.catcher.replace(/\/+$/, "");
          continue;
        }
        // A sign-in provider's test mode (Clerk's 424242): a fixed code, used on hosts marked as yours only.
        if (isObj(c) && typeof c.testCode === "string" && Object.keys(c).length === 1) {
          if (!/^[A-Za-z0-9]{4,12}$/.test(c.testCode.trim())) throw new AccountConfigError(`${label}.codes: a testCode is the provider's fixed test code, 4 to 12 letters or digits, like { "testCode": "424242" }`);
          account.testCode = c.testCode.trim();
          continue;
        }
        throw new AccountConfigError(`${label}.codes takes "totp", { "catcher": "http://127.0.0.1:8025" } (a mail catcher on this machine) and { "testCode": "424242" } (a sign-in provider's test mode, on a host marked as yours); hosted inboxes aren't built`);
      }
    }
    if (a.signUpDomain !== undefined) {
      if (typeof a.signUpDomain !== "string" || !signUpDomainAllowed(`x@${a.signUpDomain}`)) throw new AccountConfigError(`${label}.signUpDomain must be a test domain (example.com, .net or .org, or one under .test, .localhost or .invalid), never a real mailbox's domain`);
      account.signUpDomain = a.signUpDomain.toLowerCase();
    }
    if (account.first === "sign-up" && (account.username !== undefined || account.password !== undefined)) throw new AccountConfigError(`${label} signs up (first: "sign-up"), so it has no stored username or password: each run makes a new address and password`);
    if (a.signedIn !== undefined) {
      const s = a.signedIn;
      const text = isObj(s) && typeof s.text === "string" && s.text.trim() ? s.text.trim().slice(0, 200) : undefined;
      const url = isObj(s) && typeof s.url === "string" && s.url.trim() ? s.url.trim().slice(0, 200) : undefined;
      if (!text && !url) throw new AccountConfigError(`${label}.signedIn should say what shows when signed in: { "text": "Sign out" } or { "url": "/app" }`);
      account.signedIn = { ...(text ? { text } : {}), ...(url ? { url } : {}) };
    } else warnings.push(`the account "${label}" has no signed-in check: add "signedIn": { "text": "…" } (words that show only when signed in), or a sign-in that only half works may count, and its saved session can't be checked, so it is signed in again once it is 10 minutes old`);
    accounts.set(label, account);
  }
  const envs = isObj(raw.environments) ? raw.environments : {};
  const signUpsOn = Object.entries(envs).filter(([, e]) => isObj(e) && e.signUps === true).map(([name]) => name);
  const sites = parseSites(raw.sites, envNames);
  return { accounts, warnings, envNames: [...envNames], ...(signUpsOn.length ? { signUpsOn } : {}), ...(sites.size ? { sites } : {}) };
}

/** The project's accounts, from contextmachines.config.json in `dir`: no file, no accounts. Their env names are kept from the AI from now on. */
export function loadAccounts(dir: string = process.cwd()): AccountsConfig {
  let text: string;
  try {
    text = readFileSync(join(dir, CONFIG_FILE), "utf8");
  } catch {
    return { accounts: new Map(), warnings: [], envNames: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AccountConfigError(`${CONFIG_FILE} isn't valid JSON`);
  }
  const config = parseAccounts(raw);
  hideFromAgent(config.envNames);
  return config;
}

// ---------------------------------------------------------------------------------------------
// Hosts marked "mine": per machine, in the output folder's .auth/ (git-ignored), never the config.

export const ownedPathFor = (outDir: string) => join(outDir, ".auth", "owned.json");

/** The hosts marked mine on this machine, with the date each was. */
export function ownedHosts(outDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(ownedPathFor(outDir), "utf8")) as { hosts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(raw.hosts ?? {}).filter(([, at]) => typeof at === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Whether a host is marked mine here: in .auth/owned.json, or the one CI named with --owner-host. */
export function isMine(outDir: string, host: string, ownerHost?: string): boolean {
  return host === ownerHost || Object.hasOwn(ownedHosts(outDir), host);
}

/** Records a host as mine (after the person said yes): owner-only, in a folder git never sees. */
export function markMine(outDir: string, host: string, at = new Date()): void {
  const hosts = { ...ownedHosts(outDir), [host]: at.toISOString() };
  writeOwnerOnly(ownedPathFor(outDir), `${JSON.stringify({ hosts }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Hosts where the person said they sign in with their own account: per machine, in .auth/signin-ok.json.
// Separate from owned.json on purpose: saying it never makes a host "mine" (no sign-up, pay or site access).

export const signInOkPathFor = (outDir: string) => join(outDir, ".auth", "signin-ok.json");

const normHost = (host: string) => host.trim().toLowerCase();

/** The hosts where the person said they sign in with their own account, with when. Never the committed config. */
export function signInOkHosts(outDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(signInOkPathFor(outDir), "utf8")) as { hosts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(raw.hosts ?? {}).filter(([, at]) => typeof at === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Whether an account may be kept and signed in on this host: marked mine (or CI's --owner-host), or acknowledged. */
export function signInAllowed(outDir: string, host: string, ownerHost?: string): boolean {
  return isMine(outDir, host, ownerHost) || Object.hasOwn(signInOkHosts(outDir), normHost(host));
}

/** Records the acknowledgement (after the person said yes): owner-only, 600, in .auth/ (git-ignored). Never makes the host "mine". */
export function markSignInOk(outDir: string, host: string, at = new Date()): void {
  const hosts = { ...signInOkHosts(outDir), [normHost(host)]: at.toISOString() };
  writeOwnerOnly(signInOkPathFor(outDir), `${JSON.stringify({ hosts }, null, 2)}\n`);
}

/** Takes the acknowledgement back for a host. */
export function forgetSignInOk(outDir: string, host: string): void {
  const hosts = signInOkHosts(outDir);
  if (!Object.hasOwn(hosts, normHost(host))) return;
  delete hosts[normHost(host)];
  writeOwnerOnly(signInOkPathFor(outDir), `${JSON.stringify({ hosts }, null, 2)}\n`);
}

/** The words the person says yes to, everywhere (CLI, classic page, app). */
export const signInOkWords = (host: string) => `I'm signing in with my own account on ${host}. The tester still won't post, pay, send or delete there.`;

/** A host as typed by a person (accounts sign-in localhost:3000): lowercased, no scheme or path; undefined if it isn't one. */
export function hostArg(raw: string): string | undefined {
  // A default port is no port: "example.com:443" is the host an https address has, "example.com".
  const h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/:(443|80)$/, "");
  return /^([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/.test(h) ? h : undefined;
}

/**
 * A sign-in page's path: one on the site itself (/login). Never "//other.example/login" or one with a
 * backslash ("/\\other.example"), which a browser reads as another site.
 */
export function signInPathOk(path: string): boolean {
  return /^\/[^\s\\]*$/.test(path) && !path.startsWith("//");
}

/** A host's site (its registrable domain), without its port: "app.example.com:8443" → "example.com". */
const siteOfHost = (host: string) => siteOf(host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1"));

/**
 * The hosts an account's values may be typed on (exact host, port included): the account's own (the
 * test's start host), and others the person stands behind, for this account:
 *   - an account on a host marked mine (a test account on your own app): every host marked mine or
 *     said OK, and CI's --owner-host, as before (your app may sign in on your own auth server);
 *   - an account on a site that isn't yours (your real account there): only hosts marked mine or said
 *     OK on that same site (auth.example.com for app.example.com). Never one on another site: saying
 *     "my own account on B" is about B's account, so a password for A is never typed on B.
 */
export function accountHostsFor(outDir: string, url: string, ownerHost?: string): string[] {
  const own = normHost(new URL(url).host);
  const owned = Object.keys(ownedHosts(outDir)).map(normHost);
  const said = Object.keys(signInOkHosts(outDir)).map(normHost);
  const mine = isMine(outDir, own, ownerHost) || (ownerHost !== undefined && normHost(ownerHost) === own);
  const sameSite = (h: string) => siteOfHost(h) === siteOfHost(own);
  return [...new Set([own, ...(mine ? [...owned, ...said, ...(ownerHost ? [normHost(ownerHost)] : [])] : [...owned, ...said].filter(sameSite))])];
}

/** Written whole (a temporary file renamed over it), in a 700 folder, readable by its owner only. */
export function writeOwnerOnly(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // not ours to change: the file itself is still 600
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// ---------------------------------------------------------------------------------------------
// Secret stores.

/** Where secret values live. Keys are "<host>/<label>/<field>". */
export interface SecretStore {
  /** Said to the person: "the Keychain", "contextmachines/.auth/secrets.json". */
  where: string;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Runs a program with these arguments and this on stdin: injected, so tests never touch the real Keychain. */
export type SecretRunner = (program: string, args: string[], stdin: string) => { code: number; out: string };

const realRunner: SecretRunner = (program, args, stdin) => {
  const r = spawnSync(program, args, { input: stdin, encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

/** The Keychain's own tool, at its absolute path: never found through PATH. */
export const SECURITY = "/usr/bin/security";
/** What a Keychain value starts with: it is base64 after this, so quotes, newlines and accents can't break the command. */
const ENCODED = "cm1:";
const SAFE_KEY = /^[\w.:@[\]/-]{1,300}$/;

/**
 * The login Keychain, as generic passwords of one service (default "contextmachines"). Writes run
 * `security -i` with the command on stdin, never in the arguments; reads print the value with -w.
 * Any failure (a locked keychain, no one to ask, an SSH session) is "unavailable": the caller says so.
 */
export function keychainStore(service = "contextmachines", run: SecretRunner = realRunner): SecretStore {
  if (!SAFE_KEY.test(service)) throw new Error("a Keychain service name takes letters, digits and . _ - only");
  const key = (k: string) => {
    if (!SAFE_KEY.test(k)) throw new Error(`"${k.slice(0, 60)}" can't name a Keychain item`);
    return k;
  };
  return {
    where: "the Keychain",
    get(k) {
      const r = run(SECURITY, ["find-generic-password", "-s", service, "-a", key(k), "-w"], "");
      if (r.code !== 0) return undefined;
      const said = r.out.replace(/\r?\n$/, "");
      return said.startsWith(ENCODED) ? Buffer.from(said.slice(ENCODED.length), "base64").toString("utf8") : said;
    },
    set(k, value) {
      const encoded = `${ENCODED}${Buffer.from(value, "utf8").toString("base64")}`;
      const r = run(SECURITY, ["-i"], `add-generic-password -U -s "${service}" -a "${key(k)}" -w "${encoded}"\n`);
      if (r.code !== 0) throw new Error("the Keychain isn't available here (it may be locked, or there's no one to ask): set CM_SECRET_STORE=file to keep secrets in an owner-only file instead");
    },
    delete(k) {
      run(SECURITY, ["delete-generic-password", "-s", service, "-a", key(k)], "");
    },
  };
}

/** An owner-only file under the output folder's .auth/ (folder 700, file 600, written whole). */
export function fileStore(path: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    where: path,
    get: (k) => read()[k],
    set(k, value) {
      writeOwnerOnly(path, `${JSON.stringify({ ...read(), [k]: value }, null, 2)}\n`);
    },
    delete(k) {
      const all = read();
      if (!(k in all)) return;
      delete all[k];
      writeOwnerOnly(path, `${JSON.stringify(all, null, 2)}\n`);
    },
  };
}

/**
 * Windows (D13): each value in the owner-only file, encrypted for this Windows user by PowerShell's
 * own DPAPI (ConvertFrom-SecureString), the value on stdin. Not tried on a Windows machine yet.
 */
export function dpapiStore(path: string, run: SecretRunner = realRunner): SecretStore {
  const file = fileStore(path);
  const ps = (script: string, stdin: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], stdin);
  return {
    where: `${path} (encrypted for your Windows user)`,
    get(k) {
      const sealed = file.get(k);
      if (!sealed) return undefined;
      const r = ps("$e = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString $e; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))", sealed);
      return r.code === 0 ? r.out.replace(/\r?\n$/, "") : undefined;
    },
    set(k, value) {
      const r = ps("$v = [Console]::In.ReadToEnd(); ConvertTo-SecureString $v -AsPlainText -Force | ConvertFrom-SecureString", value);
      if (r.code !== 0 || !r.out.trim()) throw new Error("Windows couldn't protect the value (PowerShell's ConvertFrom-SecureString failed)");
      file.set(k, r.out.trim());
    },
    delete: (k) => file.delete(k),
  };
}

export const secretsPathFor = (outDir: string) => join(outDir, ".auth", "secrets.json");

/**
 * The store for this machine: the Keychain on a Mac, the owner-only file elsewhere (encrypted on
 * Windows). CM_SECRET_STORE=file picks the file anywhere (tests, CI); CM_KEYCHAIN_SERVICE names
 * another Keychain service (tests use a throwaway one).
 */
export function defaultStore(outDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretStore {
  if (env.CM_SECRET_STORE === "file") return fileStore(secretsPathFor(outDir));
  if (platform === "darwin") return keychainStore(env.CM_KEYCHAIN_SERVICE || "contextmachines");
  if (platform === "win32") return dpapiStore(secretsPathFor(outDir));
  return fileStore(secretsPathFor(outDir));
}

/** A store's key for one account field on one host. */
export const secretKey = (host: string, label: string, field: StoredField) => `${host}/${label}/${field}`;

/** Folders a sync service copies to other machines: secrets kept under one travel with it. */
export function cloudSynced(path: string): string | undefined {
  const p = resolve(path);
  if (/\/Library\/Mobile Documents\/|\/iCloud Drive\//i.test(p)) return "iCloud Drive";
  if (/[\\/]OneDrive[\\/ -]/i.test(p)) return "OneDrive";
  if (/[\\/]Dropbox[\\/]/i.test(p)) return "Dropbox";
  if (/[\\/](Google Drive|GoogleDrive|My Drive)[\\/]/i.test(p)) return "Google Drive";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The values a run types, by name.

export interface ResolveOptions {
  host: string;
  store: SecretStore;
  env?: NodeJS.ProcessEnv;
  /** local, staging or live: its CM_ACCOUNT_<LABEL>_<ENV>_* values win. */
  environment?: string;
  /** How long to wait for an email (default 60 s; tests make it short). */
  inboxWaitMs?: number;
  /** The inbox to read, instead of the account's catcher (tests). */
  inbox?: Inbox;
  /** The host is marked as yours: only then is a provider's test code ("testCode") typed. */
  owned?: boolean;
  /** Whether another host the run types on (a sign-in host of the same site) is marked as yours: the test code is typed only there too. Without it, only the start host. */
  ownedHost?: (host: string) => boolean;
}

/** One field's value: its per-environment env var, its plain env var, then what the config says. */
export function fieldValue(account: Account, field: StoredField, o: ResolveOptions): string | undefined {
  const env = o.env ?? process.env;
  const fromEnv = (o.environment ? env[accountEnvName(account.label, field, o.environment)] : undefined) ?? env[accountEnvName(account.label, field)];
  if (fromEnv) return fromEnv;
  const ref = account[field];
  if (typeof ref === "string") return ref;
  if (!ref) return undefined;
  if ("env" in ref) return env[ref.env] || undefined;
  try {
    return o.store.get(secretKey(o.host, account.label, field));
  } catch {
    return undefined;
  }
}

/** Fields made when typed: an authenticator code, and a code or a link from the inbox. */
export const FRESH_FIELDS = ["totp", "email_code", "sms_code", "magic_link"] as const;

/** What a fresh field is, for the AI's list of values: never a value. `person`: the code comes from a person, not an inbox we read. */
export function freshWords(name: string, person = false): string | undefined {
  const field = name.slice(name.indexOf(".") + 1);
  if (field === "totp") return "an authenticator code, made when it is typed";
  if (field === "email_code") return person ? "the code the site sent to your inbox: type this name where the page asks for the code (never guess one); the tester then says it can't be read" : "the code the site emails, read from the inbox when it is typed";
  if (field === "sms_code") return "the code the site texted: type this name where the page asks for a texted code (never guess one); the tester then says it can't be read";
  if (field === "magic_link") return "the sign-in link the site emails: open it with navigate {url: \"{" + name + "}\"}";
  return undefined;
}

/**
 * The parts of a sign-in link that may be its token, each masked as a secret wherever it shows again
 * (the page it lands on may carry it on: /welcome?from=<token>): a query value under a token-like name
 * (6+ characters), the fragment, and any path part or query value of 8+ characters that reads like a
 * token (a digit in it, or mixed case, or 16+ characters). The site's own words ("dashboard") are not.
 */
export function linkSecrets(link: string): string[] {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const tokenish = (v: string) => v.length >= 8 && /^[\w~+=%.-]+$/.test(v) && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || v.length >= 16);
  for (const [k, v] of u.searchParams) if ((v.length >= 6 && /token|code|ticket|key|otp|auth|magic|verify|jwt|sig/i.test(k)) || tokenish(v)) out.add(v);
  if (u.hash.length > 7) out.add(u.hash.slice(1));
  for (const part of u.pathname.split("/")) {
    let p = part;
    try {
      p = decodeURIComponent(part);
    } catch {
      // as it is
    }
    if (tokenish(p)) out.add(p);
  }
  return [...out];
}

/** A code or link from the inbox, by our code: what waitForMessage says, as a Fresh. */
async function fromInbox(inbox: Inbox | undefined, to: string | undefined, want: "code" | "link", label: string, o: FreshOptions, used: Set<string>, waitMs?: number): Promise<Fresh> {
  if (!inbox) return { code: "CODE_SOURCE_UNAVAILABLE", problem: `${label} has no inbox to read codes from: add "codes": [{ "catcher": "http://127.0.0.1:8025" }] to it (a mail catcher on this machine)` };
  if (!to) return { code: "CODE_SOURCE_UNAVAILABLE", problem: `${label} has no address to read mail for` };
  const got = await waitForMessage(inbox, { to, since: o.since, want, allowedHosts: o.allowedHosts, used, ...(waitMs !== undefined ? { timeoutMs: waitMs } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  if ("code" in got) {
    o.mask.add(`${label}.email_code`, got.code, true);
    return { value: got.code };
  }
  if ("link" in got) {
    // The link whole (its host and path are no secret, so a cut-off start of it isn't hidden: that
    // would hide the site's own address), and its token apart, in every form and piece.
    o.mask.add(`${label}.magic_link`, got.link, false);
    for (const piece of linkSecrets(got.link)) o.mask.add(`${label}.magic_link_token`, piece, true);
    return { value: got.link };
  }
  if ("notSure" in got) return { code: "CODE_NOT_SURE", problem: `a message came, but ${got.notSure} (a code is never guessed)` };
  if ("notReceived" in got) return { code: "CODE_NOT_RECEIVED", problem: got.notReceived };
  return { code: "CODE_SOURCE_UNAVAILABLE", problem: got.down };
}

/**
 * The account's values as a run asks for them: {label.username}, {label.password}, and those made
 * when typed: {label.totp} (C5), {label.email_code} and {label.magic_link} (C8). Stored values are read
 * when asked, once each, then held for the run; made ones are made anew each time. Missing ones are
 * simply not there (`has` is false), so the run can stop before the browser starts.
 */
export function accountResolver(account: Account, o: ResolveOptions): Resolver & { byPerson?: boolean } {
  if (account.first === "sign-up") return signUpResolver(account, o);
  const cache = new Map<string, string | undefined>();
  const fields: StoredField[] = ["username", ...(account.password || account.first === "password" ? (["password"] as const) : [])];
  const inbox = o.inbox ?? (account.catcher ? mailpitInbox(account.catcher) : undefined);
  // With no inbox we can read (and no provider test code), a code or link the site sends goes to the
  // person's own inbox or phone. A run never waits for a person (A1): it ends BLOCKED CODE_NEEDS_PERSON
  // (SMS_CODE_NEEDED for a text), and "Set up sign-in" under Accounts, done once with the person there, is the fix.
  const byPerson = !inbox && !account.testCode;
  const made: string[] = [...(account.totp ? ["totp"] : []), ...(inbox ? ["email_code", "magic_link"] : ["email_code", "sms_code", "magic_link"])];
  const used = new Set<string>();
  const get = (name: string) => {
    if (cache.has(name)) return cache.get(name);
    const [label, field] = name.split(".");
    const value = label === account.label && (fields as string[]).includes(field ?? "") ? fieldValue(account, field as StoredField, o) : undefined;
    cache.set(name, value);
    return value;
  };
  return {
    byPerson,
    names: () => [...fields, ...made].map((f) => `${account.label}.${f}`),
    has: (name) => {
      const [label, field] = name.split(".");
      if (label === account.label && field === "totp" && account.totp) return fieldValue(account, "totp", o) !== undefined;
      if (label === account.label && made.includes(field ?? "")) return true;
      return get(name) !== undefined;
    },
    get,
    fresh(name, f) {
      const [label, field] = name.split(".");
      if (label !== account.label || !made.includes(field ?? "")) return undefined;
      if (field === "totp") {
        return (async (): Promise<Fresh> => {
          const stored = fieldValue(account, "totp", o);
          if (!stored) return { code: "CODE_SOURCE_UNAVAILABLE", problem: `there's no authenticator secret for ${account.label}: store it with npx contextmachines accounts secret ${account.label} totp` };
          f.mask.add(`${account.label}.totp_secret`, stored, true);
          let secret;
          try {
            secret = parseTotpSecret(stored);
          } catch (error) {
            return { code: "CODE_SOURCE_UNAVAILABLE", problem: `${account.label}'s authenticator secret can't be used: ${error instanceof Error ? error.message : "it can't be read"}` };
          }
          f.mask.add(`${account.label}.totp_secret`, secret.key.toString("hex"), true);
          const code = await totpNow(secret);
          f.mask.add(`${account.label}.totp`, code, true);
          return { value: code };
        })();
      }
      // A provider's fixed test code (Clerk's 424242): only on a host marked as yours, checked again here.
      if (account.testCode && (field === "email_code" || field === "sms_code")) {
        // The host it would be typed on, not only where the run started: a sign-in host that is only "said OK" isn't yours.
        const on = f.typedOn ?? f.host ?? o.host;
        if (!o.owned || (on !== o.host && !o.ownedHost?.(on))) return Promise.resolve({ code: "TEST_CODE_NOT_ALLOWED", problem: testCodeRefused(account.label, on) } as Fresh);
        f.mask.add(`${account.label}.${field}`, account.testCode, false);
        return Promise.resolve({ value: account.testCode });
      }
      if (byPerson || (account.testCode && !inbox)) return fromPerson(account.label, field === "magic_link" ? "link" : "code", field!, f, o.host);
      return fromInbox(inbox, get(`${account.label}.username`), field === "magic_link" ? "link" : "code", account.label, f, used, o.inboxWaitMs);
    },
  };
}

/**
 * A code or link that went to the person's own inbox or phone, which we never read. A run never waits
 * for a person (A1, as e2e and TesterArmy): BLOCKED, with the fix. A code by text has its own code and fix.
 */
async function fromPerson(label: string, kind: "code" | "link", field: string, f: FreshOptions, host: string): Promise<Fresh> {
  const on = f.host ?? host;
  if (field === "sms_code") return { code: "SMS_CODE_NEEDED", problem: smsFix(label, on) };
  return { code: "CODE_NEEDS_PERSON", problem: `${on} sent ${label} a ${kind} we can't read (it went to your own inbox), and a run never waits for a person: ${setUpWords(label, originOf(on))}` };
}

/** The fix for a code or link no run can read: "Set up sign-in" once, with the person there (or a mail catcher). */
export function setUpWords(label: string, origin: string): string {
  return `press Set up sign-in for ${label} under Accounts in the app (or run npx contextmachines accounts setup ${label} --url ${origin}), type it there once, and later runs reuse the saved session with no one there`;
}

/** The fix line for a code by text (change 5): a QA account without one, or the provider's test mode. */
export function smsFix(label: string, host: string): string {
  return `${host} texted ${label} a code, which Context Machines can't read and a run never waits for: use a QA account that doesn't sign in by text, or the sign-in provider's test mode (a fixed test code, "codes": [{ "testCode": "…" }], on a host you've marked as yours); or ${setUpWords(label, originOf(host))}`;
}

/** Why a provider test code isn't typed on this host (change 3). */
export function testCodeRefused(label: string, host: string): string {
  return `${label} has a sign-in provider's test code ("testCode"), and ${host} isn't marked as yours, so it isn't used there: a test code works only in the provider's test mode, on your own app (npx contextmachines accounts mine ${host})`;
}

const originOf = (host: string) => `${/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https"}://${host}`;

// ---------------------------------------------------------------------------------------------
// Sign-ups (C9): only on a host marked mine, with --sign-up, a new address and password each time.

/** Domains a sign-up's address may be on: never a real mailbox. */
export function signUpDomainAllowed(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return false;
  if (/^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|fastmail|hey|tutanota|qq|163)\.[a-z]{2,}(\.[a-z]{2})?$/.test(domain)) return false;
  return /(^|\.)example\.(com|net|org)$/.test(domain) || /\.(test|localhost|invalid)$/.test(domain);
}

/** A sign-up's made-up values, by name, never shown: the address, the password and the name. */
export interface SignUpValues {
  /** Six characters that tell this sign-up's values apart: cm-test-<run6>@example.test. */
  run: string;
  email: string;
  password: string;
  name: string;
}

export function newSignUpValues(domain = "example.test"): SignUpValues {
  const run = randomBytes(4).toString("hex").slice(0, 6);
  // 24 characters, letters, digits and a mark, so a site's password rules are met.
  const password = `${randomBytes(18).toString("base64url").slice(0, 20)}aA1!`;
  return { run, email: `cm-test-${run}@${domain}`, password, name: `Cm${run} Tester` };
}

/** A sign-up's resolver: {new.name}, {new.email}, {new.password}, {new.email_code}; `values` says what it made and whether it was used. */
export type SignUpResolver = Resolver & { signUp: SignUpValues; used(): boolean };

export function signUpResolver(account: Account, o: ResolveOptions): SignUpResolver {
  const values = newSignUpValues(account.signUpDomain);
  if (!signUpDomainAllowed(values.email)) throw new AccountConfigError("a sign-up's address must be on a test domain");
  const inbox = o.inbox ?? (account.catcher ? mailpitInbox(account.catcher) : undefined);
  const usedMail = new Set<string>();
  let handedOut = false;
  const plain: Record<string, string> = { "new.name": values.name, "new.email": values.email, "new.password": values.password };
  return {
    signUp: values,
    used: () => handedOut,
    names: () => [...Object.keys(plain), "new.email_code", "new.magic_link"],
    has: (name) => name in plain || name === "new.email_code" || name === "new.magic_link",
    get: (name) => {
      if (name === "new.email") handedOut = true;
      return plain[name];
    },
    peek: (name) => plain[name],
    fresh(name, f) {
      if (name !== "new.email_code" && name !== "new.magic_link") return undefined;
      return fromInbox(inbox, values.email, name === "new.magic_link" ? "link" : "code", "new", f, usedMail, o.inboxWaitMs);
    },
    renew: () => signUpResolver(account, o),
  };
}

export const createdPathFor = (outDir: string) => join(outDir, ".auth", "created.jsonl");

/** One line of the audit log of accounts made by sign-up tests (S8): nothing is ever taken out of it. */
export interface CreatedLine {
  at: string;
  host: string;
  environment: string;
  address: string;
  label: string;
  run: string;
  /** "left": nobody has deleted it (cleanup is a list for the owner in P0). */
  status: "left";
  /** Whether the sign-up's run passed. */
  passed: boolean;
}

/** Adds a line to .auth/created.jsonl (owner-only, git-ignored). */
export function recordCreated(outDir: string, line: CreatedLine): void {
  const path = createdPathFor(outDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The audit log's lines, oldest first. */
export function createdAccounts(outDir: string): CreatedLine[] {
  try {
    return readFileSync(createdPathFor(outDir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CreatedLine);
  } catch {
    return [];
  }
}

/**
 * What's wrong with an account's values before a run, or nothing: a missing value, a secret under 6
 * characters, or a stored secret inside words the AI reads.
 */
export function accountProblem(account: Account, resolver: Resolver): string | undefined {
  // A sign-up makes its values; an account signed in by hand has none (the person typed them).
  if (account.first === "sign-up" || account.first === "by-hand") return undefined;
  if (account.totp && !resolver.has(`${account.label}.totp`)) return `there's no authenticator secret for ${account.label}: set ${accountEnvName(account.label, "totp")}, or store it with npx contextmachines accounts secret ${account.label} totp`;
  for (const field of account.first === "password" || account.password ? (["username", "password"] as const) : (["username"] as const)) {
    const value = resolver.get(`${account.label}.${field}`);
    if (value === undefined) return `there's no ${field} for ${account.label}: set ${accountEnvName(account.label, field)}, or store it with npx contextmachines accounts secret ${account.label} ${field}`;
    if (field === "password" && value.length < MIN_SECRET_LENGTH) return `${account.label}'s password is shorter than ${MIN_SECRET_LENGTH} characters: is it the right value?`;
    for (const [what, words] of [["whenToUse", account.whenToUse], ["howToSignIn", account.howToSignIn]] as const) {
      if (field === "password" && words && value.length >= 3 && words.toLowerCase().includes(value.toLowerCase())) return `${account.label}.${what} holds ${account.label}'s password: the AI reads those words, so take it out`;
    }
  }
  return undefined;
}

/**
 * Why a sign-in can't start with no one there to type a code, or nothing: the account signs in with a
 * code or link (email, text) that goes to the person's own inbox or phone, which we can't read, and
 * no person can be asked (`person` false: the terminal, a scheduled run). Said before the browser
 * opens, so no real code is ever sent that no one can type.
 */
export function codeNeedsPerson(account: Account, resolver: Resolver & { byPerson?: boolean }, origin?: string): string | undefined {
  if (!resolver.byPerson) return undefined;
  if (account.first !== "email-code" && account.first !== "magic-link" && account.first !== "sms-code") return undefined;
  const what = account.first === "magic-link" ? "a link by email" : account.first === "sms-code" ? "a code by text" : "a code by email";
  return `${account.label} signs in with ${what}, which goes to your own inbox or phone. Context Machines can't read it and a run never waits for a person, so nothing was sent. Fix: ${setUpWords(account.label, origin ?? "<site>")}.${account.first === "sms-code" ? " Or use a QA account that doesn't sign in by text, or the sign-in provider's test mode (\"codes\": [{ \"testCode\": \"…\" }], on a host you've marked as yours)." : ` On your own app, a mail catcher works too ("codes": [{ "catcher": "http://127.0.0.1:8025" }]), or the sign-in provider's test mode ("codes": [{ "testCode": "424242" }]).`}`;
}

/** The sign-in, in words, as the AI plans it: the account's own, or a plain one. */
export function signInWords(account: Account): string {
  if (account.howToSignIn) return account.howToSignIn;
  const l = account.label;
  const totp = account.totp ? `; if it then asks for an authenticator code, type {${l}.totp}` : "";
  switch (account.first) {
    case "email-code":
      return `Sign in with {${l}.username}: ask for a sign-in code by email, then type {${l}.email_code} where the page asks for the code${totp}`;
    case "magic-link":
      return `Sign in with {${l}.username}: ask for a sign-in link by email, then open {${l}.magic_link} (navigate to it)`;
    case "sms-code":
      return `Sign in with {${l}.username}: ask for a code by text, then type {${l}.sms_code} where the page asks for it${totp}`;
    case "sign-up":
      return "Sign up for a new account with the name {new.name}, the email {new.email} and the password {new.password}; if the page asks for a verification code sent by email, type {new.email_code}";
    default:
      return `Sign in with {${l}.username} and {${l}.password}${totp}; if it then asks for a code sent to you, type {${l}.email_code} (or {${l}.sms_code} for a text)`;
  }
}

// ---------------------------------------------------------------------------------------------
// Sessions, one per account (C4).

/** contextmachines/.auth/<host>@<label>.json; with no label, the host's old single session (<host>.json). */
export function sessionPathFor(outDir: string, url: string, label?: string): string {
  return join(outDir, ".auth", `${hostFile(url)}${label ? `@${label}` : ""}.json`);
}

/** Where an account's sign-in steps are kept, to sign in again with no AI. */
export function signInStepsPathFor(outDir: string, url: string, label?: string): string {
  return join(outDir, ".auth", `${hostFile(url)}${label ? `@${label}` : ""}.setup.json`);
}

const hostFile = (url: string) => new URL(url).host.replace(/[^\w.-]+/g, "-");

/** How old a saved session is, in ms, or nothing when there is none. */
export function sessionAge(path: string, now = Date.now()): number | undefined {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Sessions older than this are signed in again (D9: 24 hours). */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A session younger than this is used as it is; an older one is checked with one page load first. */
export const SESSION_CHECK_AFTER_MS = 10 * 60 * 1000;

/** Forgets an account's session (and its steps, with `steps`). */
export function forgetSession(outDir: string, url: string, label?: string, steps = false): void {
  rmSync(sessionPathFor(outDir, url, label), { force: true });
  if (steps) rmSync(signInStepsPathFor(outDir, url, label), { force: true });
}

/** Whether a session file is there to load. */
export const hasSession = (outDir: string, url: string, label?: string) => existsSync(sessionPathFor(outDir, url, label));

// ---------------------------------------------------------------------------------------------
// Site access (C15, D2, D11): what the owner of a site issued for it, sent only to its exact host.

/** A site's stored secrets, by field: "<host>/site/<field>" in the store, CM_SITE_[<ENV>_]<FIELD> in the environment. */
export const SITE_FIELDS = ["vercel_bypass", "cf_id", "cf_secret", "basic_username", "basic_password", "header", "clerk_secret_key"] as const;
export type SiteField = (typeof SITE_FIELDS)[number];

/** What `accounts site <what>` takes, and the field each stores. */
export const SITE_SECRET_NAMES: Record<string, SiteField> = { vercel: "vercel_bypass", "cf-id": "cf_id", "cf-secret": "cf_secret", "basic-username": "basic_username", basic: "basic_password", "basic-password": "basic_password", header: "header", clerk: "clerk_secret_key" };

export interface SiteAccessConfig {
  host: string;
  vercelBypass?: SecretRef;
  cfAccess?: { id: SecretRef; secret: SecretRef };
  basic?: { username: string | SecretRef; password: SecretRef };
  /** The owner's own header: its name (x-…, not an identity or address header) and a stored value of 16+ characters. */
  header?: { name: string; value: SecretRef };
  /** Clerk: the publishable key (public; it names the Frontend API host) and the secret key a Testing Token is made with. */
  clerk?: { publishableKey: string; fapiHost: string; secretKey: SecretRef };
  /** Labels test traffic with X-Contextmachines-Test: <this project's random value>. Labelling only: never a way past a firewall. */
  marker?: boolean;
}

/** CM_SITE_[<ENV>_]<FIELD>. */
export function siteEnvName(field: SiteField, env?: string): string {
  const up = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `CM_SITE_${env ? `${up(env)}_` : ""}${up(field === "vercel_bypass" ? "vercel_bypass" : field)}`;
}

/**
 * Header names an owner's own header may never take: ones that say who or where the browser is (an
 * address, a forwarding chain, an agent, a fingerprint, a crawler), and the names our other settings
 * send. Anything not starting with x- is out already.
 */
const REFUSED_HEADER = /^x-(forwarded|real-ip|client-ip|cluster-client-ip|originating-ip|remote-(ip|addr)|original-|host$|proxy|true-client|vercel-|contextmachines)|(^|-)ip(-|$)|agent|fingerprint|crawler|robot|(^|-)bot(-|$)|clerk/;

/** Why a header name can't be an owner's own header, or nothing. */
export function headerNameProblem(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (!/^x-[a-z0-9-]{1,60}$/.test(n)) return `the header name "${name.slice(0, 40)}" should start with x- (letters, digits and -), like x-qa-bypass`;
  if (REFUSED_HEADER.test(n)) return `the header "${n}" says who or where the browser is (or is one Context Machines sets itself), so it's never sent: pick a name of your own, like x-qa-bypass`;
  return undefined;
}

/** The Frontend API host a Clerk publishable key names (pk_test_<base64 of "host$">), or nothing. */
export function clerkFapiHost(publishableKey: string): string | undefined {
  const m = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey.trim());
  if (!m) return undefined;
  const host = Buffer.from(m[2]!, "base64").toString("utf8").replace(/\$$/, "");
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? host.toLowerCase() : undefined;
}

function parseSites(raw: unknown, envNames: Set<string>): Map<string, SiteAccessConfig> {
  const sites = new Map<string, SiteAccessConfig>();
  if (raw === undefined) return sites;
  if (!isObj(raw)) throw new AccountConfigError(`"sites" in ${CONFIG_FILE} should be an object of host → site access`);
  const ref = (where: string, v: unknown) => {
    const r = secretRef(where, v);
    if ("env" in r) envNames.add(r.env);
    return r;
  };
  for (const [hostRaw, site] of Object.entries(raw)) {
    const host = hostRaw.trim().toLowerCase();
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new AccountConfigError(`the site "${hostRaw.slice(0, 60)}" should be a host, like staging.example.com or localhost:3000 (no https://, no path)`);
    if (!isObj(site)) throw new AccountConfigError(`the site "${host}" should be an object`);
    const known = ["vercelBypass", "cfAccess", "basic", "header", "clerk", "marker"];
    const other = Object.keys(site).find((k) => !known.includes(k));
    if (other) throw new AccountConfigError(`${host}.${other.slice(0, 30)} isn't a site setting: use ${known.join(", ")}`);
    const out: SiteAccessConfig = { host };
    if (site.vercelBypass !== undefined) out.vercelBypass = ref(`${host}.vercelBypass`, site.vercelBypass);
    if (site.cfAccess !== undefined) {
      const c = site.cfAccess;
      if (!isObj(c)) throw new AccountConfigError(`${host}.cfAccess should be { "id": …, "secret": … }`);
      out.cfAccess = { id: ref(`${host}.cfAccess.id`, c.id), secret: ref(`${host}.cfAccess.secret`, c.secret) };
    }
    if (site.basic !== undefined) {
      const b = site.basic;
      if (!isObj(b)) throw new AccountConfigError(`${host}.basic should be { "username": …, "password": … }`);
      out.basic = { username: typeof b.username === "string" ? b.username : ref(`${host}.basic.username`, b.username), password: ref(`${host}.basic.password`, b.password) };
    }
    if (site.header !== undefined) {
      const h = site.header;
      if (!isObj(h) || typeof h.name !== "string") throw new AccountConfigError(`${host}.header should be { "name": "x-…", "value": { "keychain": true } }`);
      const why = headerNameProblem(h.name);
      if (why) throw new AccountConfigError(`${host}.header: ${why}`);
      out.header = { name: h.name.trim().toLowerCase(), value: ref(`${host}.header.value`, h.value) };
    }
    if (site.clerk !== undefined) {
      const k = site.clerk;
      if (!isObj(k) || typeof k.publishableKey !== "string") throw new AccountConfigError(`${host}.clerk should be { "publishableKey": "pk_test_…", "secretKey": { "env": "CM_SITE_CLERK_SECRET_KEY" } }`);
      const fapiHost = clerkFapiHost(k.publishableKey);
      if (!fapiHost) throw new AccountConfigError(`${host}.clerk.publishableKey isn't a Clerk publishable key (pk_test_…)`);
      out.clerk = { publishableKey: k.publishableKey.trim(), fapiHost, secretKey: ref(`${host}.clerk.secretKey`, k.secretKey) };
    }
    if (site.marker !== undefined) out.marker = site.marker === true;
    sites.set(host, out);
  }
  return sites;
}

/** A site field's value: its per-environment env var, its plain env var, then what the config says. */
function siteValue(site: SiteAccessConfig, field: SiteField, r: string | SecretRef | undefined, o: { store: SecretStore; env: NodeJS.ProcessEnv; environment?: string }): string | undefined {
  const fromEnv = (o.environment ? o.env[siteEnvName(field, o.environment)] : undefined) ?? o.env[siteEnvName(field)];
  if (fromEnv) return fromEnv;
  if (typeof r === "string") return r;
  if (!r) return undefined;
  if ("env" in r) return o.env[r.env] || undefined;
  try {
    return o.store.get(`${site.host}/site/${field}`);
  } catch {
    return undefined;
  }
}

/** This project's marker value (X-Contextmachines-Test), made once, kept in .auth/. Not a secret: labelling only. */
export function markerValue(outDir: string): string {
  const path = join(outDir, ".auth", "marker");
  try {
    const had = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{16,64}$/.test(had)) return had;
  } catch {
    // made below
  }
  const made = randomBytes(12).toString("hex");
  writeOwnerOnly(path, `${made}\n`);
  return made;
}

/** Asks Clerk's Backend API for a Testing Token with the owner's test secret key. `api` and `fetch` are for tests. */
export async function mintClerkTestingToken(secretKey: string, o: { api?: string; fetch?: typeof fetch } = {}): Promise<string> {
  if (!/^sk_test_/.test(secretKey)) throw new Error("a Clerk Testing Token is made only with a test secret key (sk_test_…), never a live one");
  const res = await (o.fetch ?? fetch)(`${(o.api ?? "https://api.clerk.com").replace(/\/+$/, "")}/v1/testing_tokens`, { method: "POST", headers: { authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Clerk didn't make a Testing Token (it answered ${res.status}): is the secret key this instance's?`);
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length < 8) throw new Error("Clerk's answer had no Testing Token in it");
  return body.token;
}

/**
 * What may go to this test's host (C15): only on a host marked mine (or the one CI named), only what
 * its "sites" entry names, each value from the store or a CM_SITE_ env var. Nothing for any other host.
 * An error when a value it names isn't set (said before the browser starts).
 */
export async function ownerAccessFor(o: { config: AccountsConfig; outDir: string; url: string; store: SecretStore; env?: NodeJS.ProcessEnv; environment?: string; ownerHost?: string; clerkApi?: string; fetch?: typeof fetch }): Promise<{ access?: OwnerAccess; error?: string; warning?: string }> {
  const host = new URL(o.url).host.toLowerCase();
  const site = o.config.sites?.get(host);
  if (!site) return {};
  if (!isMine(o.outDir, host, o.ownerHost)) return { warning: `the site access set for ${host} isn't sent: ${host} isn't marked as yours on this machine (npx contextmachines accounts mine ${host})` };
  const v = { store: o.store, env: o.env ?? process.env, ...(o.environment ? { environment: o.environment } : {}) };
  const need = (field: SiteField, r: string | SecretRef | undefined, what: string): string => {
    const value = siteValue(site, field, r, v);
    if (!value) throw new AccountConfigError(`there's no ${what} for ${host}: set ${siteEnvName(field)}, or store it with npx contextmachines accounts site ${Object.entries(SITE_SECRET_NAMES).find(([, f]) => f === field)![0]} --url ${host}`);
    return value;
  };
  const headers: Record<string, string> = {};
  const values: string[] = [];
  try {
    if (site.vercelBypass) {
      const b = need("vercel_bypass", site.vercelBypass, "Vercel bypass secret");
      headers["x-vercel-protection-bypass"] = b;
      headers["x-vercel-set-bypass-cookie"] = "true";
      values.push(b);
    }
    if (site.cfAccess) {
      headers["cf-access-client-id"] = need("cf_id", site.cfAccess.id, "Cloudflare Access client ID");
      headers["cf-access-client-secret"] = need("cf_secret", site.cfAccess.secret, "Cloudflare Access client secret");
      values.push(headers["cf-access-client-id"], headers["cf-access-client-secret"]);
    }
    if (site.basic) {
      const user = need("basic_username", site.basic.username, "basic-auth username");
      const pass = need("basic_password", site.basic.password, "basic-auth password");
      const both = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
      headers.authorization = `Basic ${both}`;
      values.push(pass, both, ...(typeof site.basic.username === "string" ? [] : [user]));
    }
    if (site.header) {
      const h = need("header", site.header.value, `value for the header ${site.header.name}`);
      if (h.length < 16) throw new AccountConfigError(`the value of ${host}'s header ${site.header.name} is shorter than 16 characters: a header that lets traffic through should be a long random value`);
      headers[site.header.name] = h;
      values.push(h);
    }
    if (site.marker) headers["x-contextmachines-test"] = markerValue(o.outDir);
    let clerk: OwnerAccess["clerk"];
    if (site.clerk) {
      const sk = need("clerk_secret_key", site.clerk.secretKey, "Clerk secret key");
      values.push(sk);
      const token = await mintClerkTestingToken(sk, { ...(o.clerkApi ? { api: o.clerkApi } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
      values.push(token);
      clerk = { fapiHost: site.clerk.fapiHost, token };
    }
    const access: OwnerAccess = { host, headers, ...(clerk ? { clerk } : {}), kinds: { basic: Boolean(site.basic), vercel: Boolean(site.vercelBypass), tokens: Boolean(site.vercelBypass || site.cfAccess || site.header || site.clerk) }, values };
    return { access };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Which of a site's settings are set, for showing: never a value. */
export function siteAccessShown(site: SiteAccessConfig): string[] {
  return [site.vercelBypass ? "Vercel bypass" : "", site.cfAccess ? "Cloudflare Access" : "", site.basic ? "basic auth" : "", site.header ? `header ${site.header.name}` : "", site.clerk ? "Clerk Testing Token" : "", site.marker ? "marker" : ""].filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// The web view's panel (C20a): an account written to the config as the person fills it in, with no
// secret in it ever (a secret field is written as { "keychain": true }; its value goes to the store).

/** What the panel may set on an account: words and paths, never a value of a secret. */
export interface AccountForm {
  label: string;
  first: FirstStep;
  whenToUse?: string;
  /** Only a test address (example.com, .test …): a real one is a secret, set with the password. */
  username?: string;
  signInPage?: string;
  signedInText?: string;
  howToSignIn?: string;
  /** Codes and links by email from a mail catcher on this machine. */
  catcher?: string;
  /** It has an authenticator secret (set apart). */
  totp?: boolean;
}

/**
 * Writes one account into contextmachines.config.json in `dir` (made if missing), keeping the rest of
 * the file as it is. Checked as the loader checks it before anything is written: a refusal is said and
 * the file is left alone.
 */
export function saveAccountForm(dir: string, form: AccountForm): void {
  const path = join(dir, CONFIG_FILE);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (isObj(parsed)) raw = parsed;
      else throw new Error("not an object");
    } catch {
      throw new AccountConfigError(`${CONFIG_FILE} isn't valid JSON: fix it first, so nothing in it is lost`);
    }
  }
  const accounts = isObj(raw.accounts) ? { ...raw.accounts } : {};
  const had = isObj(accounts[form.label]) ? (accounts[form.label] as Record<string, unknown>) : {};
  const next: Record<string, unknown> = { ...had, first: form.first };
  const set = (k: string, v: unknown) => {
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
  };
  set("whenToUse", form.whenToUse?.trim());
  set("signInPage", form.signInPage?.trim());
  set("howToSignIn", form.howToSignIn?.trim());
  set("signedIn", form.signedInText?.trim() ? { text: form.signedInText.trim() } : had.signedIn);
  if (form.first === "sign-up" || form.first === "by-hand") {
    delete next.username;
    delete next.password;
  } else {
    // A test address may sit in the file as it is; any other username is a secret, kept in the store.
    set("username", form.username?.trim() ? (TEST_ADDRESS.test(form.username.trim()) ? form.username.trim() : { keychain: true }) : had.username);
    if (form.first === "password") next.password ??= { keychain: true };
  }
  if (form.totp) next.totp = { keychain: true };
  if (form.catcher?.trim()) next.codes = [{ catcher: form.catcher.trim() }];
  accounts[form.label] = next;
  const updated = { ...raw, accounts };
  parseAccounts(updated);
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
}
