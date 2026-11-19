/**
 * `npx contextmachines accounts`: the test accounts of this project, and their secrets, set and shown
 * without a value ever being printed (AUTH 2.2).
 *
 *   accounts                          each account: how it signs in, which values are set, its session
 *   accounts mine <host>              mark a host as yours on this machine (asked first)
 *   accounts sign-in <host>           say you sign in with your own account there (asked first; never makes it yours)
 *   accounts secret <label> <field>   store a password (or username) from a hidden prompt, or stdin
 *   accounts setup <label> --url <a>  "Set up sign-in": sign in once yourself in a window (a code, a link, a captcha); runs reuse the session
 *   accounts forget <label> [--all]   delete its session (with --all, its steps and secrets too)
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { parseTotpSecret } from "../packages/scanner/src/tester/totp.ts";
import { accountEnvName, createdAccounts, defaultStore, forgetSession, forgetSignInOk, hostArg, isMine, loadAccounts, markMine, markSignInOk, ownedHosts, signInAllowed, signInOkHosts, signInOkWords, secretKey, sessionAge, sessionPathFor, SITE_SECRET_NAMES, siteAccessShown, STORED_FIELDS, cloudSynced, type StoredField } from "./accounts.ts";
import { readProjectConfig } from "./init.ts";
import { startUrl } from "./report.ts";
import { colors, colorWanted, safe } from "./term.ts";

export const ACCOUNTS_USAGE = "accounts [mine <host> | sign-in <host> [--yes] [--remove] | setup <label> | secret <label> <field> | site <vercel|cf-id|cf-secret|basic|basic-username|header|clerk> | forget <label> | created] [--url <address>] [--out <dir>]";

const EXIT = { ok: 0, usage: 2, couldNot: 3 } as const;

/** One line read with nothing echoed (a password), or the whole of stdin when it isn't a terminal. */
async function readSecret(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk.toString();
    return text.replace(/\r?\n$/, "");
  }
  output.write(prompt);
  const rl = createInterface({ input, output, terminal: true });
  // Nothing typed is shown: the line is read, and its keys never echoed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  return new Promise((done) => {
    rl.question("", (answer) => {
      rl.close();
      output.write("\n");
      done(answer);
    });
  });
}

export async function askYes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((done) => {
    rl.question(question, (answer) => {
      rl.close();
      done(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

const ago = (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`);

/** `dir`, `env`, `input` and `output`: the project folder, environment and streams, for tests (the real ones otherwise). */
export async function runAccountsCommand(argv: string[], o: { dir?: string; env?: NodeJS.ProcessEnv; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {}): Promise<number> {
  const out = o.output ?? process.stdout;
  const c = colors(colorWanted(out));
  const err = (s: string) => process.stderr.write(`${c.red("×")} ${s}\n`);
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { url: { type: "string" }, out: { type: "string" }, all: { type: "boolean" }, yes: { type: "boolean" }, remove: { type: "boolean" }, help: { type: "boolean", short: "h" } } }));
  } catch (error) {
    return (err((error instanceof Error ? error.message : String(error)).split("\n")[0]!), EXIT.usage);
  }
  if (values.help) {
    out.write(`\n  npx contextmachines ${ACCOUNTS_USAGE}\n\n  Test accounts live in contextmachines.config.json under "accounts" (no secret ever there).\n  Passwords go in the Keychain (on a Mac) or an owner-only file, or in CM_ACCOUNT_<LABEL>_PASSWORD.\n  Accounts sign in on a site you run (accounts mine <host>), or on any site where you say it's your own account (accounts sign-in <host>).\n  Sign-ups, test payments and site access stay on sites marked as yours. Use an account you're allowed to automate: some sites' terms forbid it.\n  A site's owner values ("sites" in the config) are stored with accounts site <what> --url <site>, sent to that host only.\n  accounts setup <label> --url <site> opens a browser window where you sign in once yourself (type the code from your\n  email or phone, open the magic link, solve a captcha): the session is saved, and runs reuse it. Runs never wait for a person.\n  accounts created lists the accounts sign-up tests made.\n\n`);
    return EXIT.ok;
  }
  const outDir = resolve(o.dir ?? process.cwd(), typeof values.out === "string" ? values.out : "contextmachines");
  let config: ReturnType<typeof loadAccounts>;
  try {
    config = loadAccounts(o.dir);
  } catch (error) {
    return (err(error instanceof Error ? error.message : String(error)), EXIT.usage);
  }
  const typed = typeof values.url === "string" ? values.url : (() => {
    try {
      return readProjectConfig(o.dir).url;
    } catch {
      return undefined;
    }
  })();
  const site = typed ? startUrl(typed) : undefined;
  const [what, a, b] = positionals;
  const env = o.env ?? process.env;
  const store = defaultStore(outDir, env);

  // `accounts setup <label>` is handled before this (contextmachines.ts runs it as test --setup --by-hand); without a label:
  if (what === "setup") return (err("accounts setup takes the account's label: npx contextmachines accounts setup admin --url localhost:3000. It opens a browser window where you sign in once yourself."), EXIT.usage);
  if (what === "mine") {
    if (!a) return (err("accounts mine takes the host, like accounts mine localhost:3000"), EXIT.usage);
    const host = a.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const yes = values.yes === true || (await askYes(`Is ${host} yours, or do you run it for the owner? Tests may then create real accounts and pay in test mode there, and your site access values are sent to it. [y/N] `));
    if (!yes) return (err(`${host} wasn't marked as yours${process.stdin.isTTY ? "" : " (there's no one to ask here: run it at a terminal, or add --yes if it really is yours)"}`), EXIT.usage);
    markMine(outDir, host);
    out.write(`  ${c.green("✓")} ${safe(host)} is marked as yours on this machine (in ${outDir}/.auth/owned.json, git-ignored)\n`);
    return EXIT.ok;
  }

  if (what === "sign-in") {
    const host = a ? hostArg(a) : undefined;
    if (!host) return (err("accounts sign-in takes the host, like accounts sign-in staging.example.com or accounts sign-in localhost:3000 (no path)"), EXIT.usage);
    if (values.remove === true) {
      forgetSignInOk(outDir, host);
      out.write(`  ${c.green("✓")} Accounts no longer sign in on ${safe(host)}${isMine(outDir, host) ? " unless it's marked as yours (it is)" : ""}\n`);
      return EXIT.ok;
    }
    const yes = values.yes === true || (await askYes(`${signInOkWords(host)} [y/N] `));
    if (!yes) return (err(`nothing was recorded for ${host}${process.stdin.isTTY ? "" : " (there's no one to ask here: run it at a terminal, or add --yes)"}`), EXIT.usage);
    markSignInOk(outDir, host);
    out.write(`  ${c.green("✓")} You sign in with your own account on ${safe(host)} (in ${outDir}/.auth/signin-ok.json, git-ignored). It isn't marked as yours: sign-ups, payments and site access stay off there.\n`);
    out.write(`  ${c.dim("Use an account you're allowed to automate: some sites' terms forbid it.")}\n`);
    const synced = cloudSynced(o.dir ?? process.cwd());
    if (synced) out.write(`  ${c.yellow("!")} This folder is in ${synced}: its .auth/ folder, with your sessions, syncs to your other machines.\n`);
    return EXIT.ok;
  }

  if (what === "secret") {
    if (!a || !b) return (err("accounts secret takes the account and the field, like accounts secret admin password"), EXIT.usage);
    const account = config.accounts.get(a);
    if (!account) return (err(`there's no account "${a}" in contextmachines.config.json`), EXIT.usage);
    if (!(STORED_FIELDS as readonly string[]).includes(b)) return (err(`the field is one of ${STORED_FIELDS.join(", ")}`), EXIT.usage);
    if (!site) return (err("say which site it's for: --url <address>"), EXIT.usage);
    if (!signInAllowed(outDir, site.host)) {
      // Asked once (or --yes), recorded apart from owned.json: it never makes the host yours.
      const yes = values.yes === true || (await askYes(`${signInOkWords(site.host)} [y/N] `));
      if (!yes) return (err(`no account is kept for ${site.host} until you say it's your own account there: run it at a terminal, or add --yes.`), EXIT.usage);
      markSignInOk(outDir, site.host);
    }
    const value = await readSecret(`${a}'s ${b === "totp" ? "authenticator secret (the base32 key or the otpauth:// link)" : b} (not shown as you type): `, o.input);
    if (!value) return (err("nothing was given, so nothing was stored"), EXIT.usage);
    if (b === "totp") {
      // Checked before it is kept: a value that makes no code is said now, not mid-run.
      try {
        parseTotpSecret(value);
      } catch (error) {
        return (err(`that isn't an authenticator secret: ${error instanceof Error ? error.message : "it can't be read"}`), EXIT.usage);
      }
      if (!account.totp) out.write(`  ${c.yellow("!")} ${safe(a)} has no "totp" in contextmachines.config.json yet: add "totp": { "keychain": true } so its sign-in uses it.\n`);
    }
    if (b === "password" && value.length < 6) return (err("a password under 6 characters isn't stored: is it the right value?"), EXIT.usage);
    try {
      store.set(secretKey(site.host, a, b as StoredField), value);
    } catch (error) {
      return (err(error instanceof Error ? error.message : String(error)), EXIT.couldNot);
    }
    out.write(`  ${c.green("✓")} ${safe(a)}'s ${b} is set for ${safe(site.host)} (in ${safe(store.where)})\n`);
    const synced = cloudSynced(o.dir ?? process.cwd());
    if (synced) out.write(`  ${c.yellow("!")} This folder is in ${synced}: its .auth/ folder syncs to your other machines.\n`);
    return EXIT.ok;
  }

  if (what === "site") {
    // C15: a value the site's owner issued (a bypass secret, a service token, a basic-auth password, a header's value, a Clerk secret key).
    const field = a ? SITE_SECRET_NAMES[a] : undefined;
    if (!field) return (err(`accounts site takes one of ${Object.keys(SITE_SECRET_NAMES).join(", ")}, like accounts site vercel --url <site>`), EXIT.usage);
    if (!site) return (err("say which site it's for: --url <address>"), EXIT.usage);
    if (!isMine(outDir, site.host)) return (err(`${site.host} isn't marked as yours, so no site access is kept for it: only a site's owner has these. npx contextmachines accounts mine ${site.host}`), EXIT.usage);
    const value = await readSecret(`${site.host}'s ${a} (not shown as you type): `, o.input);
    if (!value) return (err("nothing was given, so nothing was stored"), EXIT.usage);
    if (field === "header" && value.length < 16) return (err("a header that lets traffic through should be a long random value (16 characters or more)"), EXIT.usage);
    if (field === "clerk_secret_key" && !/^sk_test_/.test(value)) return (err("only a Clerk test secret key (sk_test_…) is kept: a Testing Token is never made with a live key"), EXIT.usage);
    try {
      store.set(`${site.host}/site/${field}`, value);
    } catch (error) {
      return (err(error instanceof Error ? error.message : String(error)), EXIT.couldNot);
    }
    out.write(`  ${c.green("✓")} ${safe(site.host)}'s ${safe(a!)} is set (in ${safe(store.where)}); it is sent to ${safe(site.host)} only${config.sites?.has(site.host) ? "" : `. Add "sites": { "${safe(site.host)}": { … } } to contextmachines.config.json so it is used`}\n`);
    return EXIT.ok;
  }

  if (what === "created") {
    const lines = createdAccounts(outDir);
    if (!lines.length) {
      out.write("\n  No accounts made by sign-up tests yet.\n\n");
      return EXIT.ok;
    }
    out.write("\n");
    for (const l of lines) out.write(`  ${safe(l.at.slice(0, 16).replace("T", " "))} ${c.dim("·")} ${safe(l.host)} ${c.dim(`· ${l.environment} ·`)} ${safe(maskAddress(l.address))} ${c.dim(`· ${l.passed ? "passed" : "didn't pass"} · ${l.status}`)}\n`);
    out.write("\n");
    return EXIT.ok;
  }

  if (what === "forget") {
    if (!a) return (err("accounts forget takes the account, like accounts forget admin"), EXIT.usage);
    if (!site) return (err("say which site: --url <address>"), EXIT.usage);
    forgetSession(outDir, site.href, a, values.all === true);
    if (values.all === true) for (const f of STORED_FIELDS) store.delete(secretKey(site.host, a, f));
    out.write(`  ${c.green("✓")} ${safe(a)}'s session on ${safe(site.host)} is gone${values.all ? ", with its steps and stored values" : ""}\n`);
    return EXIT.ok;
  }

  if (what !== undefined && what !== "list") return (err(`accounts ${what} isn't one: use accounts, accounts mine, accounts sign-in, accounts secret, accounts site, accounts created or accounts forget`), EXIT.usage);
  for (const w of config.warnings) process.stderr.write(`  ${c.yellow("!")} ${safe(w, 300)}\n`);
  if (!config.accounts.size) {
    out.write(`\n  No test accounts yet: add them to contextmachines.config.json under "accounts".\n\n`);
    return EXIT.ok;
  }
  const hosts = site ? [site.host] : [...new Set([...Object.keys(ownedHosts(outDir)), ...Object.keys(signInOkHosts(outDir))])];
  out.write("\n");
  for (const account of config.accounts.values()) {
    out.write(`  ${c.bold(safe(account.label))} ${c.dim(`· ${account.first}${account.whenToUse ? ` · ${safe(account.whenToUse, 80)}` : ""}`)}\n`);
    for (const host of hosts.length ? hosts : ["(no host marked yours or OK for sign-in yet)"]) {
      if (!hosts.length) {
        out.write(`    ${c.dim(host)}\n`);
        break;
      }
      // A password is listed only when the account has one: a code, a link or a sign-in by hand needs none.
      const fields = account.first === "password" || account.password ? (["username", "password"] as const) : account.first === "by-hand" || account.first === "sign-up" ? ([] as const) : (["username"] as const);
      const set = fields.map((f) => {
        const fromEnv = env[accountEnvName(account.label, f)];
        const ref = account[f];
        const has = Boolean(fromEnv) || typeof ref === "string" || Boolean(ref && "env" in ref && env[ref.env]) || Boolean(ref && "keychain" in ref && store.get(secretKey(host, account.label, f)) !== undefined);
        return `${f} ${has ? "set" : c.yellow("not set")}`;
      });
      const age = sessionAge(sessionPathFor(outDir, `http://${host}/`, account.label));
      out.write(`    ${safe(host)} ${c.dim(`· ${set.length ? `${set.join(" · ")} · ` : ""}${age === undefined ? "no session" : `signed in ${ago(age)}`}`)}\n`);
    }
  }
  for (const s of config.sites?.values() ?? []) out.write(`  ${c.bold(safe(s.host))} ${c.dim(`· site access: ${siteAccessShown(s).join(", ") || "none"}${isMine(outDir, s.host) ? "" : " · not marked as yours, so not sent"}`)}\n`);
  out.write("\n");
  return EXIT.ok;
}

/** An address shown without its mailbox: cm-test-ab12cd@example.test → c…d@example.test. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "…";
  const box = address.slice(0, at);
  return `${box[0]}…${box.length > 2 ? box.at(-1) : ""}${address.slice(at)}`;
}
