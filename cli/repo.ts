/**
 * The only code here that reads a person's repository. Everything the AI is shown of it passes
 * through this file; the AI itself gets no tools (ai.ts), so it can't open what is left out.
 *
 * Nothing is sent because it is tracked. A file is kept only when all of these hold, and each is
 * checked before the next, so a file that fails on its name is never opened at all:
 *   1. it is tracked by git in this folder,
 *   2. it is a code file by type (an allowlist: docs, SQL, shell, data, .env.example, .orig all fail),
 *   3. its path names nothing secret, and it isn't tests, fixtures, seeds, build output or a dump,
 *   4. it is a real file inside the folder, of a sensible size,
 *   5. nothing in it is shaped like a key, a password or a list of real people.
 * The first failure wins, and only counts and paths of what was dropped are ever kept.
 *
 * Shapes can't be a full list, so what is sent has a second line that knows none of them: a random
 * looking value holds a file back wherever it is, and in a comment or a docstring anything that
 * reads like a value is masked, since a claim can never rest on a comment anyway (see code-map.ts).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, posix, sep } from "node:path";

/** Code, by type. A list of what may go, never of what may not: an unknown type stays home. */
const CODE_TYPES = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ".html", ".htm",
  ".py", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".swift", ".cs", ".cshtml", ".razor", ".ex", ".exs", ".heex",
  ".erb", ".ejs", ".hbs", ".njk", ".jinja", ".j2", ".prisma", ".graphql", ".gql",
]);

/** Text that holds data rather than code: never sent, only looked through to tell a copied value (see copiedFromData). */
const DATA_TYPES = new Set([".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xml", ".yml", ".yaml", ".txt", ".po", ".xlf", ".xliff", ".arb", ".properties"]);

/** A folder of this name is not the product as shipped, whatever the files in it say. */
const NOT_PRODUCT = new Set([
  "node_modules", "vendor", "vendors", "third_party", "thirdparty", "bower_components", "site-packages", "venv", ".venv",
  "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".svelte-kit", ".output", ".turbo", ".cache", "__pycache__",
  "test", "tests", "__tests__", "__mocks__", "__fixtures__", "__snapshots__", "spec", "specs", "e2e", "cypress", "playwright",
  "fixture", "fixtures", "mock", "mocks", "seed", "seeds", "seeders", "testdata", "test-data", "test_data", "sample-data", "sample_data", "sampledata", "demo-data", "demo_data",
  "stories", ".storybook", "storybook", "docs", "doc", "examples", "example", "qa",
  // Old copies read just like live code, and scripts and migrations are where one-off credentials and real rows end up.
  "archive", "archived", "deprecated", "backup", "backups", "dump", "dumps", "migrations", "migrate", "scripts", "deploy",
]);

/** A file that is a test or generated, by its name. */
const NOT_PRODUCT_FILE = /\.(?:test|spec|stories|story|cy|e2e|min|d|generated|gen)\.\w+$|(?:^|\/)(?:test_[^/]*\.py|[^/]*_(?:test|spec)\.(?:py|rb|go))$/i;

/** Words in a file's own name that say it holds made-up or copied records, not product code ("sampleData.ts", "seed-users.js"). */
const DATA_WORDS = new Set(["sample", "samples", "seed", "seeds", "fixture", "fixtures", "mock", "mocks", "dummy", "fake", "faker", "dump"]);
/** Two words that mean the same only together: a page can be called Demo, "demoData.ts" holds records. */
const DATA_PAIRS = [["demo", "data"], ["test", "data"], ["example", "data"]];

/** Words anywhere in a path that say what it holds is a secret. */
const SECRET_WORDS = new Set(["secret", "secrets", "credential", "credentials", "password", "passwords", "passwd", "apikey", "apikeys", "pem", "rsa", "keystore", "htpasswd", "netrc", "npmrc", "pgpass"]);
const SECRET_PAIRS = [["api", "key"], ["api", "keys"], ["private", "key"], ["private", "keys"], ["service", "account"], ["access", "key"], ["secret", "key"], ["wp", "config"], ["service", "role"]];

/** An env file or folder in any spelling (.env, .env.example, env.js, config.env.ts, deploy-env/, environment.prod.ts). */
const ENV_PATH = /(?:^|[/._-])env(?:[/._-]|$)|(?:^|\/)environments?(?:\/|\.(?:\w+\.)?\w+$)/i;

/** The words of a path: "src/lib/apiKeys.ts" is src, lib, api, keys, ts. */
const wordsOf = (path: string) => path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A path that may name a secret. Such a file is never opened, not even to look at. */
export function secretPath(path: string): boolean {
  if (ENV_PATH.test(path)) return true;
  const words = wordsOf(path);
  const stem = wordsOf(path.split("/").pop()!.replace(/\.\w+$/, ""));
  if (stem.length === 1 && (stem[0] === "key" || stem[0] === "keys")) return true;
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  return SECRET_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

/** Tests, fixtures, seeds, build output, old copies: not the product, and where real rows tend to live. */
function notProductPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.slice(0, -1).some((p) => NOT_PRODUCT.has(p.toLowerCase()))) return true;
  if (NOT_PRODUCT_FILE.test(path)) return true;
  const stem = wordsOf(parts.at(-1)!.replace(/\.\w+$/, ""));
  return stem.some((w) => DATA_WORDS.has(w)) || DATA_PAIRS.some(([a, b]) => stem.includes(a!) && stem.includes(b!));
}

// Keys with a well-known shape, wherever they turn up (the same shapes report.ts redacts, plus the ones only source code holds).
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/;
const KNOWN_KEY = /\b(?:(?:sk|rk|pk)[-_](?:live|test|proj|ant)[-_][\w-]{8,}|sk-[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9]{16,}|sbp_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|A(?:KI|SI)A[0-9A-Z]{16}|AIza[\w-]{30,}|npm_[A-Za-z0-9]{30,}|SG\.[\w-]{16,}\.[\w-]{16,}|re_[A-Za-z0-9_]{16,}|shp(?:at|ca|pa|ss)_[a-fA-F0-9]{16,}|do[opr]_v1_[a-f0-9]{32,}|hf_[A-Za-z0-9]{20,}|(?:SK|AC)[0-9a-fA-F]{32}|key-[0-9a-zA-Z]{32}|lin_(?:api|oauth)_[A-Za-z0-9]{8,}|ntn_[A-Za-z0-9]{12,}|figd_[\w-]{10,}|phx_[A-Za-z0-9]{12,}|GOCSPX-[\w-]{10,}|sq0(?:atp|csp)-[\w-]{10,}|sntry[su]_[\w=]{10,}|sb_secret_[\w-]{10,}|EAA[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|hvs\.[\w-]{16,}|ya29\.[\w-]{16,}|pscale_(?:pw|tkn|oauth)_[\w-]{10,}|lsv2_(?:pt|sk)_[\w-]{16,}|r8_[A-Za-z0-9]{16,}|dckr_pat_[\w-]{10,}|ATATT[\w-]{16,}|pypi-[\w-]{16,}|vercel_[A-Za-z0-9]{16,}|rzp_(?:live|test)_[A-Za-z0-9]{10,})\b|\$2[aby]\$\d\d\$[./A-Za-z0-9]{20,}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY/;
/** A short one counts too, given a digit: `Bearer token` and `Basic realm` are words. */
const BEARER = /\b(?:Bearer|Basic)\s+(?:[A-Za-z0-9._~+/=-]{20,}|(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,})/;
/** An address that is itself the key: anyone holding it can post. */
const WEBHOOK = /https:\/\/(?:hooks\.slack\.com\/(?:services|workflows)\/|discord(?:app)?\.com\/api\/webhooks\/\d|[\w-]+\.webhook\.office\.com\/webhookb2\/|webhook\.office\.com\/webhookb2\/)/;
/** A key in an address's query, not a filled-in template (`?token=${token}`). */
const QUERY_SECRET = /[?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|sig|signature|password)=(?![$<{%[])[^&\s"'`]{6,}/i;
/** A password inside an address (postgres://me:hunter2@db). A filled-in template (`${pass}`, <password>) isn't one. */
const ADDRESS_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]*:(?![$<{%[])([^\s@/'"`]{2,})@/i;
const WORD_PASSWORDS = /^(?:pw|pass|password|passwd|pwd|secret|xxx+|\*+)$/i;
/** A long hex or base64 value on its own in quotes: a key with no label. A subresource hash ("sha384-…") names a file, not a secret. */
const BARE_KEY = /["'`](?:[0-9a-fA-F]{32,}|(?!sha\d+-)(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{40,}={0,2})["'`]/;
/** Words for a password in other languages' code. */
const PASSWORD_ABROAD = "passwort|contrase[nñ]a|mot[-_]?de[-_]?passe|senha|wachtwoord";
/** What follows a credential's word when the thing named is about it and isn't it: what a form says of it, where it's sent, how long it lasts. */
const ABOUT_IT = "(?![-_]?(?:s|label|placeholder|hint|help|error|errors|message|title|text|field|input|type|kind|url|uri|path|endpoint|route|name|id|format|regex|pattern|length|len|min|max|color|colou?r|size|width|height|expiry|expires|ttl|count|izer|ize|ized|ization|ise|iser|ised|less|ary)(?:[-_0-9]|\\b))";
/** A name that says secret: any spelling around these words, and any ending but one that says it's about one (`DB_PASSWORD_DEV`, `TOKEN_2`, but not `tokenUrl`). */
const SECRET_NAME = `[\\w.-]*(?:password|passwd|pwd|passphrase|passcode|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?(?:key|code)|credential|creds|bearer|hmac|salt|${PASSWORD_ABROAD})${ABOUT_IT}[\\w-]*`;
/** A declared type, in any language's place for it: `x: string = …`, `x: &str = …`, `var x string = …`. */
const DECLARED = "(?::\\s*[&\\w<>[\\].?|' ]{1,30}?(?=\\s*=)|[ \\t]+[\\w[\\].*]{1,30}(?=\\s*=))?";
/**
 * What may stand between such a name and its value: an assignment in any language, typed or not, or
 * a fallback, after a bracket or a call as well (`process.env["X"] || "…"`, `ENV.fetch("X") { "…" }`),
 * and a string's prefix after it (`b"…"`, `r"…"`).
 */
const GIVEN = `(?:["'\`]?\\]?${DECLARED}\\s*(?:=>|:=|[:=]|\\|\\||\\?\\?|\\?:|\\bor\\b)|["'\`]\\)\\s*(?:\\{|\\|\\||\\?\\?|\\?:|\\bor\\b))\\s*(?:[bBrRfFuU]{1,2}(?=["'\`]))?`;
/** Any name ending in key, but for the keys apps are full of that open nothing: `queryKey`, `storageKey`, `primaryKey`. */
const ANY_KEY = "[\\w.-]*[a-z0-9](?<!(?:query|storage|cache|sort|primary|foreign|route|row|map|list|item|group|data|field|public|anon|publishable|unique|react|local|session[-_]storage|event|tab|hot|short|cut|translation|label|title|name|id|form|table|column|order|index|state|value|type|color|theme|menu|nav|path|url|link|mon|tur|don|whis|jo)[-_]?)[-_]?key";
/** Short names only a word's edge can tell: `dbPass`, `SMTP_PASS`, `adminPin`, `pw`, and not `bypass`, `spin` or `pinned`. */
const SHORT_NAME = new RegExp(`(?:\\b(?:pw|pass|pin)|(?<=[a-z0-9_-])(?:Pw|PW|Pass|PASS|Pin|PIN))(?:word)?${GIVEN}\\[?\\s*["'\`]([^"'\`\\s]{4,})["'\`]`, "g");
/** The same names in capitals alone, which are also how a status is spelled (`PASS: "passed"`): only with a value that can't be one. */
const SHOUTED_NAME = new RegExp(`\\b(?:PW|PASS|PIN)${GIVEN}\\[?\\s*["'\`]([^"'\`\\s]{4,})["'\`]`, "g");
/** Names that can only ever mean a secret: under one of these even a plain word is held, as `password: "sunshine"` is someone's password. */
const PLAIN_NAME = new RegExp(`[\\w.-]*(?:password|passwd|pwd|passphrase|secret|secret\\w*key|${PASSWORD_ABROAD}|(?:signing|encryption|session|stripe|admin|master|shared|webhook|service)[-_]?key)${ABOUT_IT}[\\w-]*${GIVEN}\\[?\\s*["'\`]([^"'\`\\s]{6,})["'\`]`, "gi");
/** Such a name with a value in double quotes that has spaces or an apostrophe in it. A sentence is a form's rule, not a password, and has small words that say so. */
const SPOKEN_VALUE = new RegExp(`[\\w.-]*(?:password|passwd|pwd|passphrase|${PASSWORD_ABROAD})${ABOUT_IT}[\\w-]*${GIVEN}\\[?\\s*"([^"\\n]{6,60})"`, "gi");
const SENTENCE = /\b(?:the|a|an|your|you|must|should|can|be|is|are|at|to|of|for|and|or|not|please|enter|with|least|too|do|does|did|was|invalid|required)\b|[.!?…]$/i;
/** What a form says under such a name: a rule, a state or a field's type, never a password. */
const FORM_WORD = /^(?:required|optional|invalid|incorrect|wrong|weak|strong|missing|empty|hidden|mismatch|text|email|username|string|boolean|number|confirm|confirmed|current|changed|updated|expired|secret|(?:\w+[-_])?passw(?:or)?ds?(?:[-_]\w+)?)$/i;
/** `auth: "admin:hunter2"`: a user and a password in one value. */
const USER_AND_PASSWORD = /\bauth\w*["'`]?\s*[:=]\s*["'`][^"'`\s:]+:(?![$<{%]|pass(?:word)?["'`])[^"'`\s]{3,}["'`]/i;
/** The same pair as a tuple, or on its way into a Basic header: `auth = ("admin", "…")`, `btoa("admin:…")`. */
const AUTH_PAIR = /\bauth\w*\s*=\s*\(\s*["'][^"'\s]+["']\s*,\s*["']([^"'\s]{6,})["']\s*\)/gi;
const ENCODED_PAIR = /\b(?:btoa|b64encode|base64_encode|encodebytes|Buffer\.from)\(\s*b?["'`][^"'`\s:$]+:([^"'`\s]{4,})["'`]/g;
/** A sign-in written out in a list: `["admin@acme.co", "hunter22"]`. */
const EMAIL_AND_PASSWORD = /["'`][\w.+-]+@[\w-]+\.[\w.-]+["'`]\s*,\s*["'`](?![\w.+-]+@)([^"'`\s]{6,})["'`]/g;
/** Words that say a comment is about to give one, and where a comment starts. */
const COMMENT_WORD = "password|passwd|pwd|pw|passphrase|passcode|secret|token|login|credentials?|api[ _-]?key";
const COMMENT_START = "(?:\\/\\/|^\\s*#|\\s#\\s|\\/\\*|^\\s*\\*|<!--)";
/** A comment that says one: `// the admin password is hunter22`, `# login: …`. */
const IN_A_COMMENT = new RegExp(`${COMMENT_START}[^\\n]*\\b(?:${COMMENT_WORD})\\b[^\\n]*?(?:\\bis\\b|[:=])\\s*["'\`]?([^\\s"'\`]{6,})`, "gim");
/** With nothing between: `// pw …`, `// staging token … works`. Then only something that can't be a word counts (see randomWord). */
const NAMED_IN_A_COMMENT = new RegExp(`${COMMENT_START}[^\\n]*\\b(?:${COMMENT_WORD})\\s+["'\`]?([^\\s"'\`]{8,})`, "gim");
/** A sign-in written out: `// test login: someone@acme.co / …`. */
const SIGN_IN_IN_A_COMMENT = new RegExp(`${COMMENT_START}[^\\n]*[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\s*[/:,|]\\s*["'\`]?([^\\s"'\`]{6,})`, "gim");
/** Such a name given a value in quotes: `password: "hunter2"`, `JWT_SECRET = "…"`, `env.TOKEN || "…"`. */
const LABELLED = new RegExp(`(?:${SECRET_NAME}|${ANY_KEY})${GIVEN}["'\`]([^"'\`\\s]{6,})["'\`]`, "gi");
/** The same thing as a call's fallback or a constant: `getenv("DB_PASSWORD", "…")`, `define('AUTH_KEY', '…')`. */
const DEFAULTED = new RegExp(`\\b(?:define|getenv|setenv|putenv|env|get|fetch|setdefault|config)\\(\\s*["'\`]${SECRET_NAME}["'\`]\\s*,\\s*["'\`]([^"'\`\\s]{6,})["'\`]`, "gi");
/** A value that only stands in for one, or reads as an ordinary word: an error key, a field name, a placeholder. */
const STAND_IN = /^(?:your[-_ ][\w -]*|my[-_]?(?:secret|key|password|pass|token)[-_a-z]*|example(?:[-_]?[a-z_-]*)|change[-_]?me|placeholder[-_a-z]*|replace[-_ ]?(?:me|this|with[\w -]*)?|todo(?:[-_:][a-z_-]*)?|[xX*._-]{3,}|<[^<>]*>?|\$\{?[A-Za-z_][A-Za-z_.]*\}?|\$\{.*\}|\{\{?\s*[A-Za-z_.]*\s*\}?\}|%[sd]|%\(\w+\)[sd]|%[A-Z_]+%|%\{\w+\}|process\.env\b.*|import\.meta\b.*)$/i;
/** An address, not a password, under a name like one: `resetPassword: "/auth/reset"`, `token: "https://…/token"`. Route maps are full of these. */
const ADDRESS_VALUE = /^(?:\/[\w/:.-]*|https?:\/\/[^\s@]*)$/;
/** A colour or a size, under a name like `tokenPrimary`: a design's tokens aren't anyone's. */
const STYLE_VALUE = /^(?:#[0-9a-f]{3,8}|\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw)|var\(--[\w-]+\))$/i;
const looksCredential = (value: string) => !STAND_IN.test(value) && !ADDRESS_VALUE.test(value) && !STYLE_VALUE.test(value) && (value.length >= 16 || /\d/.test(value) || /[^\w-]/.test(value));
/** Words joined up under a bare `…Key` name is where an app keeps something in storage (`theme-picker-open`), not a key. A token's or a password's name gets no such pass. */
const PLAIN_WORDS = /^[a-z]+(?:[-_.:][a-z]+)*(?:[-_.:]v?\d{1,2})?$/;
const CREDENTIAL_WORD = /password|passwd|pwd|pass(?:phrase|code)|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key|credential/i;
/** Code that a value's place can hold in a comment or a string: a call, an assignment, `row.token`, a query's `$1`. */
const NOT_A_VALUE = /[(){}[\]<>=]|^[$?:@%#*]|^[A-Za-z_]+(?:\.[A-Za-z_]+)+$/;
const looseCredential = (value: string) => !NOT_A_VALUE.test(value) && !WORD_PASSWORDS.test(value) && looksCredential(value);
/** In a comment a value has to carry a digit and a letter: comments are prose, and most of what follows `token:` there is words. */
const commentCredential = (value: string) => /\d/.test(value) && /[a-z]/i.test(value) && !ALGORITHM.test(value) && looseCredential(value);
/** What can't be a word: long and with digits, or mixed case around a digit. A name such as `sha256` or `step2` isn't one. */
const randomWord = (value: string) => commentCredential(value) && !/^[a-z]+\d+$/.test(value) && (value.length >= 12 || (/[a-z]/.test(value) && /[A-Z]/.test(value)));

/** A connection string's `Password=…;` or `AccountKey=…`: a value with no quotes of its own, so it shows only inside a string. */
const KEY_VALUE = /(?:^|[;\s,&])(?:[\w-]*(?:password|passwd|pwd|passphrase|secret|token|api[-_]?key|account[-_]?key|access[-_]?key|shared[-_]?access[-_]?(?:key|signature))[\w-]*|(?:[\w-]*_)?pass)\s*=\s*([^;\s,&"'`]{6,})/gi;
/** A credential on a command line, wherever the command is written down: curl, sshpass, a database client, a login. */
const COMMAND_LINE = [
  /\b(?:curl|wget|http)\b[^\n]*?\s(?:-u|--user)[ =]["']?[^\s:'"`]+:([^\s'"`]{4,})/g,
  /["'`](?:-u|--user)["'`]\s*,\s*["'`][^"'`\s:]+:([^"'`\s]{4,})["'`]/g,
  /\bsshpass\s+-p\s*["']?([^\s'"`]{4,})/g,
  /\b(?:mysql|mysqldump|mariadb)\b[^\n]*?\s-p["']?([^\s'"`]{4,})/g,
  /\blogin\b[^\n]*?\s-p\s+["']?([^\s'"`]{4,})/g,
  /[\s"'`]--(?:pass(?:word|wd)?|token|secret|api[-_]?key)[ =]["']?([^\s'"`]{4,})/g,
  /["'`]--(?:pass(?:word|wd)?|token|secret|api[-_]?key|auth)["'`]\s*,\s*["'`]([^"'`\s]{4,})["'`]/g,
];
/** A credential going in by a call: `setPassword("…")`, a state starting as one, a sign-in with its pair written out. */
const SETTER = /\b(?:set|with|use|update)[-_]?\w*(?:password|passwd|pwd|pw|secret|token|api[-_]?key|access[-_]?key|auth[-_]?key|credentials?)\s*\(\s*[bBrRfFuU]{0,2}["'`]([^"'`\s]{6,})["'`]/gi;
const IN_STATE = /\[\s*\w*(?:password|passwd|pwd|pw|pass|secret|token|api[-_]?key)\w*\s*,\s*\w+\s*\]\s*=\s*(?:React\.)?use(?:State|Ref)(?:<[^>\n]*>)?\(\s*["'`]([^"'`\s]{4,})["'`]/gi;
const SIGN_IN_CALL = /(?:\b(?:login|logIn|signIn|signin|sign_in|authenticate|BasicAuth|basicAuth|basic_auth|HTTPBasicAuth)|\.auth)\s*\(\s*["'`][^"'`\s]+["'`]\s*,\s*["'`]([^"'`\s]{4,})["'`]/g;
/** A password box with its value filled in, in either order. */
const FILLED_BOX = /<input\b[^>]*>/gi;
/** Said in words on a page or in a message rather than given in code: `<p>password: …</p>`, "the password is …". */
const SAID_ANYWHERE = /\b(?:password|passwd|passcode)\b(?:\s+is\b|\s*:)?\s*([^\s"'`<>]{6,})/gi;
const SIGN_IN_SAID = /[\w.+-]+@[\w-]+\.[\w.-]+\s*\/\s*([^\s"'`<>]{6,})/g;
/** A header carrying its own value, with or without a scheme word in front: `Authorization: "Token …"`. */
const AUTH_HEADER = /\b(?:proxy-)?authorization["'`]?\s*[:,=]\s*["'`](?:[A-Za-z-]+\s+)?([^"'`\s]{6,})["'`]/gi;
const KEY_HEADER = /\bx-(?:api|auth)-(?:key|token)["'`]?\s*[:,=]\s*["'`]([^"'`\s]{6,})["'`]/gi;
/** `document.cookie = "theme=dark"` is a page setting one of its own, so a cookie counts only as a header. */
const COOKIE_HEADER = /(?<![.\w])(?:set-)?cookie["'`]?\s*[:,=]\s*["'`][^"'`\n=]*=([^"'`\s;]{6,})/gi;
/** A national number in the shape of a US one, on its own in quotes. The ranges never issued, and the form's usual example, aren't one. */
const NATIONAL_NUMBER = /["'`](?!000|666|9\d\d|123-45-6789)\d{3}-(?!00)\d{2}-(?!0000)\d{4}["'`]/;
/** A key handed over through a wrapper: `const secret = new TextEncoder().encode("…")`, `key = bytes.fromhex("…")`. */
const WRAPPED = new RegExp(`(?:${SECRET_NAME}|${ANY_KEY}|\\bkey)["'\`]?\\s*(?:=>|:=|[:=])\\s*(?:new\\s+)?(?:Buffer\\.from|TextEncoder\\(\\)\\.encode|bytes\\.fromhex|bytes|hex|unhexlify|b64decode|atob|base64\\.\\w+|\\[\\]byte|String::from|str|String|strdup)\\(\\s*[bB]?["'\`]([^"'\`\\s]{8,})["'\`]`, "gi");

/** Calls whose arguments are a key, from the second on (`jwt.sign(payload, key)`) or wherever one is (`hmac.new(key, …)`). */
const KEYED_CALL = /\b(?:(jwt|JWT|Jwt)\.(?:sign|verify|encode|decode)|(sign)|createHmac|createCipheriv|createDecipheriv|hash_hmac|hmac\.(?:new|New)|HMAC\.(?:new|digest|hexdigest)|SignedString|AES\.new|Fernet)\s*\(/g;
const LITERAL_ARGUMENT = /^(?:\[\]byte\(|new TextEncoder\(\)\.encode\(|Buffer\.from\(|[bB](?=["']))?["'`]([^"'`\s]{4,})["'`]/;
/** What these calls also take as text: an algorithm or an encoding, never a key. */
const ALGORITHM = /^(?:hex|base64(?:url)?|binary|latin1|utf-?8|utf-?16le|ucs-?2|ascii|none|md5|sha-?\d+|aes-[\w-]+|chacha20[\w-]*|des[\w-]*|[HRE]S\d+|PS\d+)$/i;

/** A call's arguments at its top level, walked past quotes and brackets. It stops early, as one call is never this long. */
function argumentsOf(text: string, from: number): string[] {
  const found: string[] = [];
  let depth = 0;
  let quote = "";
  let start = from;
  const end = Math.min(text.length, from + 2000);
  for (let i = from; i < end; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth-- === 0) {
        found.push(text.slice(start, i));
        return found;
      }
    } else if (c === "," && depth === 0) {
      found.push(text.slice(start, i));
      start = i + 1;
    }
  }
  found.push(text.slice(start, end));
  return found;
}

/** A literal where a signing, hashing or encrypting call takes its key. Any receiver can have a `sign`, so that alone needs a value that can't be a word. */
function literalKeyArgument(text: string): boolean {
  for (const call of text.matchAll(KEYED_CALL)) {
    const [, jwt, sign] = call;
    const all = argumentsOf(text, call.index + call[0].length);
    for (const argument of jwt || sign ? all.slice(1) : all) {
      const value = LITERAL_ARGUMENT.exec(argument.trim())?.[1];
      if (!value || ALGORITHM.test(value) || STAND_IN.test(value) || value.includes("${")) continue;
      if (!sign || looksCredential(value)) return true;
    }
  }
  return false;
}

const LITERAL = /"[^"\\\n]*(?:\\.[^"\\\n]*)*"|'[^'\\\n]*(?:\\.[^'\\\n]*)*'|`[^`\\]*(?:\\[\s\S][^`\\]*)*`/g;

/**
 * A wallet's recovery words: twelve to twenty-four plain words with no repeat, in lower case. A
 * sentence that long has a short word or a "the" in it, and a list of words of three letters is a
 * calendar. Its name doesn't matter, only the shape.
 */
function mnemonicShaped(body: string): boolean {
  const words = body.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length) || !words.every((w) => /^[a-z]{3,8}$/.test(w))) return false;
  if (words.includes("the") || words.includes("and") || new Set(words).size < words.length) return false;
  return words.join("").length / words.length >= 4.5;
}

/** How many bits each character of a value carries: a word repeats letters, a generated key doesn't. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
  return bits;
}

/** A generated value: unbroken, letters and digits together, with the spread of random text. Words joined by dashes (a class, a route, a uuid) aren't. */
function randomShaped(value: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(value) || !/\d/.test(value) || !/[a-z]/i.test(value)) return false;
  if (/^[a-z][a-z0-9]*(?:[-_/][a-z0-9]+)+$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) || /^[0-9a-f]{8}-/i.test(value) || /^(?:sha\d+-|\/)/.test(value)) return false;
  return entropy(value) >= (/^[0-9a-f]+$/i.test(value) ? 3 : 3.6);
}

/** Random text changes between letters and digits all the way along: `sha256WithRSA` and `stepTwo2Final` barely do. */
const scattered = (value: string) => (value.match(/\d[A-Za-z]|[A-Za-z]\d/g) ?? []).length >= 3;

/** A name on the line before a value that says what the value is. */
const CREDENTIAL_NEAR = new RegExp(`${SECRET_NAME}|${ANY_KEY}\\b|\\b(?:const|let|var|final|static)\\s+key\\b|\\bauth\\b`, "i");
/** The name a value is given to, at the end of what's before it. Publishable keys say so there, and open nothing; `public static final` says nothing of the value. */
const NAME_BEFORE = /([\w.-]+)["'`]?\]?\s*(?::[^=\n]{0,30})?(?:=>|:=|[:=])\s*$/;
const saysPublic = (before: string) => {
  const name = NAME_BEFORE.exec(before)?.[1] ?? "";
  return /public|publishable|anon/i.test(name) && !/secret|passw|pwd|token|private/i.test(name);
};

/** Going through the strings in a file: what shows only inside one, and the check that knows no shape. */
function literalHoldsSecret(text: string): boolean {
  for (const match of text.matchAll(LITERAL)) {
    const body = match[0].slice(1, -1);
    for (const [, value] of body.matchAll(KEY_VALUE)) if (looseCredential(value!.replace(/=+$/, ""))) return true;
    if (mnemonicShaped(body)) return true;
    if (randomShaped(body)) {
      const before = text.slice(Math.max(text.lastIndexOf("\n", match.index) + 1, match.index - 120), match.index);
      if ((scattered(body) || CREDENTIAL_NEAR.test(before)) && !saysPublic(before)) return true;
    }
  }
  return false;
}

/** Strings joined in the source, so a split key reads as one: `"sk_live_" + "…"`. */
const JOINED_STRINGS = /(["'`])\s*[+.]\s*\1/g;

/** Text holding something that would let someone in. Precision runs the other way here: when in doubt, it stays home. */
export function holdsSecret(text: string): boolean {
  if (shapedLikeSecret(text)) return true;
  const joined = text.replace(JOINED_STRINGS, "").replace(/\$\{\s*["']([^"'`]*)["']\s*\}/g, "$1");
  return joined !== text && shapedLikeSecret(joined);
}

function shapedLikeSecret(text: string): boolean {
  if (JWT.test(text) || KNOWN_KEY.test(text) || PRIVATE_KEY.test(text) || BEARER.test(text) || BARE_KEY.test(text) || WEBHOOK.test(text) || QUERY_SECRET.test(text) || USER_AND_PASSWORD.test(text) || NATIONAL_NUMBER.test(text)) return true;
  const address = ADDRESS_PASSWORD.exec(text);
  if (address && !WORD_PASSWORDS.test(address[1]!)) return true;
  for (const [named, value] of text.matchAll(LABELLED)) if (looksCredential(value!) && !(PLAIN_WORDS.test(value!) && !CREDENTIAL_WORD.test(named!))) return true;
  for (const [, value] of text.matchAll(DEFAULTED)) if (!STAND_IN.test(value!)) return true;
  for (const pattern of [PLAIN_NAME, SHORT_NAME, EMAIL_AND_PASSWORD, SETTER]) for (const [, value] of text.matchAll(pattern)) if (!STAND_IN.test(value!) && !ADDRESS_VALUE.test(value!) && !FORM_WORD.test(value!)) return true;
  for (const [, value] of text.matchAll(SPOKEN_VALUE)) if (/[\s']/.test(value!) && !SENTENCE.test(value!) && !STAND_IN.test(value!)) return true;
  for (const [box] of text.matchAll(FILLED_BOX)) if (/\btype=["']password["']/i.test(box!)) { const value = /\b(?:defaultValue|value)=["']([^"']{4,})["']/i.exec(box!)?.[1]; if (value && !STAND_IN.test(value)) return true; }
  for (const pattern of [SHOUTED_NAME, AUTH_PAIR, ENCODED_PAIR, IN_STATE, SIGN_IN_CALL, ...COMMAND_LINE]) for (const [, value] of text.matchAll(pattern)) if (looseCredential(value!)) return true;
  for (const pattern of [AUTH_HEADER, KEY_HEADER, COOKIE_HEADER]) for (const [, value] of text.matchAll(pattern)) if (!/\$\{|\{\{|^%/.test(value!) && looseCredential(value!)) return true;
  for (const [, value] of text.matchAll(WRAPPED)) if (!STAND_IN.test(value!) && !ALGORITHM.test(value!)) return true;
  for (const pattern of [IN_A_COMMENT, SIGN_IN_IN_A_COMMENT]) for (const [, value] of text.matchAll(pattern)) if (commentCredential(value!.replace(/[,.;:)]+$/, ""))) return true;
  // Out in the code the same words can come before a variable: `password: db_pass2`, `password: hashed2Pw`.
  for (const pattern of [SAID_ANYWHERE, SIGN_IN_SAID]) for (const [, value] of text.matchAll(pattern)) if (commentCredential(value!.replace(/[,.;:)]+$/, "")) && !/_|^[a-z]+[A-Z]/.test(value!)) return true;
  for (const [, value] of text.matchAll(NAMED_IN_A_COMMENT)) if (randomWord(value!.replace(/[,.;:)]+$/, ""))) return true;
  return literalKeyArgument(text) || literalHoldsSecret(text);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Addresses made for examples, and things shaped like one that aren't (an image at twice the size: icon@2x.png). */
const NOT_A_PERSON = /@(?:(?:[\w-]+\.)*example\.(?:com|org|net)|[\w.-]+\.(?:test|example|invalid|localhost)|(?:[\w-]+\.)?(?:2x|3x)\.\w+)$|\.(?:png|jpe?g|svg|webp|gif|js|ts|css)$/i;
const PHONE = /(?<![\w.+-])\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?![\w-])/g;
/**
 * A phone written the way its country does, inside a sentence: (415) 555-2671, 415-555-2671,
 * 020 7946 0958. Too loose to judge a whole file by, so it only keeps a single line from going
 * anywhere (see personalShaped). A national number with its dashes is taken with them.
 */
const NATIONAL_PHONE = /(?<![\w.+/:#-])(?:\(\d{2,5}\)[ .-]?\d{3,4}[ .-]?\d{3,4}|\d{3}([.-])\d{3}\1\d{4}|0\d{1,4} \d{3,4} ?\d{3,4}|(?!000|666|9\d\d|123-45-6789)\d{3}-(?!00)\d{2}-(?!0000)\d{4})(?![\w-]|\.\d)/;
/**
 * Any other way of writing one: 9 to 15 digits held together by spaces, dots, dashes or brackets
 * (415 555 2671, +33 1 23 45 67 89, 612 345 678). Looser still, and for a single line only: a wrong
 * hit costs that line.
 */
const DIGIT_RUN = /(?<![\w.,+/:#-])\+?\(?\d(?:[ .()-]{0,2}\d){8,14}(?![\w-]|[.,]\d)/;
/** Dates and internet addresses, which can read as a run of digits. Taken out first, so a phone beside one still counts. */
const DATE_OR_IP = /(?<![\d.-])(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,3}(?:\.\d{1,3}){3})(?![-/.]?\d)/g;
/** How many different people's details make a file a list of people, not a contact address in a footer. */
const PEOPLE = 3;
const peopleIn = (text: string) => [...new Set([...(text.match(EMAIL) ?? []).filter((e) => !NOT_A_PERSON.test(e)), ...(text.match(PHONE) ?? [])])];

/** A file with one or two addresses in it stays, with those taken out of what the AI is shown. */
const maskPeople = (text: string) => text.replace(EMAIL, (e) => (NOT_A_PERSON.test(e) ? e : "someone@example.com")).replace(PHONE, "+00 0000 0000");

/** A value shaped like a real person's contact or card, for checking anything invented (see code-map.ts). */
export function personalShaped(value: string): boolean {
  if ((value.match(EMAIL) ?? []).some((e) => !NOT_A_PERSON.test(e))) return true;
  if ((value.match(PHONE) ?? []).length > 0 || NATIONAL_PHONE.test(value) || DIGIT_RUN.test(value.replace(DATE_OR_IP, " "))) return true;
  // A card or a national number on its own: not a date, and not an id, which is far longer.
  const digits = value.replace(/\D/g, "").length;
  return /^\+?\d[\d ()-]{7,}\d$/.test(value.trim()) && digits >= 9 && digits <= 19 && !/^\d{4}-\d{2}-\d{2}/.test(value.trim());
}

/** The limits: a file is rarely this big by hand, and the whole read has to stay in memory. */
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 80_000_000;
const MAX_DATA_BYTES = 16_000_000;
/** Lines this long on average mean a machine wrote it: nothing a person could read, and no labels in it. */
const MINIFIED_LINE = 500;

export type DroppedWhy = "type" | "path" | "secret" | "personal" | "size" | "link" | "binary" | "minified" | "limit";

export interface RepoFile {
  /** Relative to the folder read. */
  path: string;
  /** What the AI may be shown: the file, with any stray contact details taken out and values in comments masked. Same lines as the file on disk. */
  text: string;
  bytes: number;
}

export interface Repo {
  root: string;
  files: RepoFile[];
  /** How many tracked files were left out, and why. Counts only. */
  dropped: Partial<Record<DroppedWhy, number>>;
  /** Tracked data files (never sent), only for telling whether a made-up value was copied from one. */
  dataFiles: string[];
  /** Tracked code held back for what is in it (a page with a publishable key). Never sent, only looked through (see matchFiles). */
  heldBack: string[];
  /** Tracked SQL files whose names aren't secret or seeds, only for their table and column names (see schemaTables). */
  sqlFiles: string[];
  /** Package names the project depends on: from package.json files near the top. */
  dependencies: string[];
  /** A fingerprint of everything that could be sent: the same repo gives the same one. */
  fingerprint: string;
}

/**
 * The tracked files below this folder, or undefined when it isn't in a git repo. Run with git's
 * filesystem monitor off, because that setting runs a command from the repo's own configuration and
 * reading a repo never runs anything of the repo's.
 */
function tracked(root: string): string[] | undefined {
  const out = spawnSync("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256_000_000, timeout: 30_000 });
  if (out.error || out.status !== 0) return undefined;
  return out.stdout.split("\0").filter(Boolean);
}

/** A file's bytes, only if it is a plain file really inside the folder: a tracked link can point at anything on this machine. */
function plainFile(root: string, real: string, path: string): { size: number } | "link" | undefined {
  try {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) return "link";
    if (!realpathSync(join(root, path)).startsWith(real + sep)) return "link";
    return { size: stat.size };
  } catch {
    return undefined; // deleted but not yet committed
  }
}

/** Each folder's last read, and what its tracked files were as it was made: a run reads its repo more than once. */
const lastRead = new Map<string, { stamp: string; repo: Repo }>();

/** What says a tracked file is as it was: its path, size and when it last changed. Any edit, addition or removal changes it. */
function stampOf(root: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    let at = "gone";
    try {
      const stat = lstatSync(join(root, path));
      at = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch {
      // deleted but not yet committed: "gone" is what it is
    }
    hash.update(path).update("\0").update(at).update("\0");
  }
  return hash.digest("hex");
}

/**
 * The repo at this folder as it may be read, or undefined when the folder isn't in a git repo.
 * Read again only when a tracked file changed since the last read in this process (a few
 * milliseconds to tell), so what's sent and quoted is always the folder as it is now.
 */
export function readRepo(root: string): Repo | undefined {
  const paths = tracked(root);
  if (!paths) return undefined;
  const stamp = stampOf(root, paths);
  const had = lastRead.get(root);
  if (had && had.stamp === stamp) return had.repo;
  const repo = readRepoNow(root, paths);
  lastRead.set(root, { stamp, repo });
  return repo;
}

function readRepoNow(root: string, paths: readonly string[]): Repo {
  const real = realpathSync(root);
  const files: RepoFile[] = [];
  const dropped: Repo["dropped"] = {};
  const drop = (why: DroppedWhy) => (dropped[why] = (dropped[why] ?? 0) + 1);
  const dataFiles: string[] = [];
  const sqlFiles: string[] = [];
  const heldBack: string[] = [];
  const hash = createHash("sha256");
  let total = 0;

  for (const path of [...paths].sort()) {
    const type = extname(path).toLowerCase();
    if (!CODE_TYPES.has(type)) {
      if (!secretPath(path) && DATA_TYPES.has(type)) dataFiles.push(path);
      if (!secretPath(path) && type === ".sql" && !wordsOf(path).some((w) => DATA_WORDS.has(w))) sqlFiles.push(path);
      drop("type");
      continue;
    }
    if (secretPath(path)) {
      drop("path");
      continue;
    }
    if (notProductPath(path)) {
      dataFiles.push(path);
      drop("path");
      continue;
    }
    const file = plainFile(root, real, path);
    if (file === undefined) continue;
    if (file === "link") {
      drop("link");
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      drop("size");
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      drop("limit");
      continue;
    }
    const raw = readFileSync(join(root, path));
    if (raw.includes(0)) {
      drop("binary");
      continue;
    }
    const text = raw.toString("utf8");
    if (holdsSecret(text)) {
      heldBack.push(path);
      drop("secret");
      continue;
    }
    if (peopleIn(text).length >= PEOPLE) {
      dataFiles.push(path);
      drop("personal");
      continue;
    }
    const lines = text.split("\n").length;
    if (type !== ".html" && raw.length / lines > MINIFIED_LINE) {
      drop("minified");
      continue;
    }
    total += file.size;
    // PHP takes both kinds of comment.
    const shown = maskPeople(type === ".php" ? maskComments(maskComments(text, ".py"), type) : maskComments(text, type));
    files.push({ path, text: shown, bytes: raw.length });
    hash.update(path).update("\0").update(shown).update("\0");
  }
  return { root, files, dropped, dataFiles, heldBack, sqlFiles, dependencies: dependenciesOf(root, paths), fingerprint: hash.digest("hex") };
}

/** Dependency names from the package.json files at the top and one or two folders down. Names only. */
function dependenciesOf(root: string, paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    if (!/^(?:[^/]+\/){0,2}package\.json$/.test(path) || notProductPath(path)) continue;
    try {
      if (!lstatSync(join(root, path)).isFile()) continue;
      const pkg = JSON.parse(readFileSync(join(root, path), "utf8")) as { dependencies?: object; devDependencies?: object };
      for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) names.add(name);
    } catch {
      // unreadable or not JSON: its names just aren't known
    }
  }
  return [...names].sort();
}

const withoutComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_A_COLUMN = new Set(["primary", "foreign", "unique", "constraint", "check", "exclude", "key", "index", "like", "fulltext", "partition"]);

/** The top-level entries of a `create table (…)` body, walking past quotes and brackets; only what ends in the first closing bracket. */
function columnEntries(sql: string, from: number): string[] {
  const entries: string[] = [];
  let depth = 1;
  let quote = "";
  let start = from;
  for (let i = from; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      if (--depth === 0) {
        entries.push(sql.slice(start, i));
        return entries;
      }
    } else if (c === "," && depth === 1) {
      entries.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  return entries;
}

/**
 * Table and column names declared in tracked SQL, as names and nothing else. The SQL itself is never
 * sent: a migration can hold rows, so only the identifier at the start of each column line leaves
 * this function, and no default, comment or value can come out with it.
 */
export function schemaTables(repo: Pick<Repo, "root" | "sqlFiles">): Record<string, string[]> {
  const tables = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    if (!IDENT.test(table) || !IDENT.test(column) || NOT_A_COLUMN.has(column.toLowerCase())) return;
    const key = table.toLowerCase();
    tables.set(key, (tables.get(key) ?? new Set()).add(column));
  };
  const name = (raw: string) => raw.split(".").pop()!.replace(/["`[\]]/g, "");
  for (const path of repo.sqlFiles) {
    let sql: string;
    try {
      const stat = lstatSync(join(repo.root, path));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      sql = withoutComments(readFileSync(join(repo.root, path), "utf8"));
    } catch {
      continue;
    }
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."`[\]]+)\s*\(/gi)) {
      for (const entry of columnEntries(sql, m.index + m[0].length)) add(name(m[1]!), entry.trim().split(/\s+/)[0]?.replace(/["`[\]]/g, "") ?? "");
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."`[\]]+)\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\w"`]+)/gi)) add(name(m[1]!), m[2]!.replace(/["`]/g, ""));
  }
  return Object.fromEntries([...tables].map(([table, columns]) => [table, [...columns]]));
}

/**
 * A way to ask whether a value is in the repo's data files but not its code: a value the code also
 * holds is a product word ("Active", "Pending"); one only the data holds was copied from somebody's
 * records. Those files are read here for this and go nowhere. Files named like a secret never get here.
 */
export function copiedFromData(repo: Repo): (value: string) => boolean {
  let data: string | undefined;
  let code: string | undefined;
  const dataText = () => {
    if (data !== undefined) return data;
    const parts: string[] = [];
    let total = 0;
    for (const path of repo.dataFiles) {
      try {
        const stat = lstatSync(join(repo.root, path));
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_DATA_BYTES) continue;
        total += stat.size;
        parts.push(readFileSync(join(repo.root, path), "utf8").toLowerCase());
      } catch {
        // gone or unreadable: nothing to compare
      }
    }
    return (data = parts.join("\n"));
  };
  return (value) => {
    const v = value.trim().toLowerCase();
    // Dates, amounts and ids look alike everywhere, and are nobody's: only words can be copied from someone.
    if (v.length < 4 || !/\p{L}{3}/u.test(v) || !dataText().includes(v)) return false;
    code ??= repo.files.map((f) => f.text).join("\n").toLowerCase();
    return !code.includes(v);
  };
}

/** Where a translated product keeps its words: a site's headings may be in no code file at all. */
const WORDING_PATH = /(?:^|\/)(?:locales?|langs?|languages|i18n|l10n|intl|translations?|messages)\/|(?:^|[/._-])en(?:[-_][a-z]{2})?\.\w+$/i;

/**
 * Files that can say whether a site's words are in this repo but must never be sent: its translation
 * files, and code held back for what is in it. The second matter as much, since the page holding a
 * site's title is the page most likely to hold its publishable or analytics key. Only the check
 * reads these, and it gives back counts.
 */
export function matchFiles(repo: Pick<Repo, "root" | "dataFiles" | "heldBack">): { text: string }[] {
  return [...repo.dataFiles.filter((path) => WORDING_PATH.test(path)), ...repo.heldBack].flatMap((path) => {
    try {
      const stat = lstatSync(join(repo.root, path));
      return stat.isFile() && stat.size <= MAX_FILE_BYTES ? [{ text: readFileSync(join(repo.root, path), "utf8") }] : [];
    } catch {
      return []; // gone or unreadable: nothing to compare
    }
  });
}

/**
 * Tracked wording files (a locale's strings), with their paths, for finding where a drawn word lives.
 * Never sent and never shown to an AI: only a path and line number come out, on this machine.
 */
export function wordingFiles(repo: Pick<Repo, "root" | "dataFiles">): { path: string; text: string }[] {
  return repo.dataFiles.filter((path) => WORDING_PATH.test(path) && !secretPath(path) && !notProductPath(path)).flatMap((path) => {
    try {
      const stat = lstatSync(join(repo.root, path));
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
      const text = readFileSync(join(repo.root, path), "utf8");
      return holdsSecret(text) ? [] : [{ path, text }];
    } catch {
      return []; // gone or unreadable: nothing to search
    }
  });
}

/** What the person can read on a screen, or what a press does: the lines worth keeping when a file has to be cut. */
const CARRIES_ACTION = /\.(?:insert|update|upsert|delete|destroy|remove|save|create|post|put|patch|rpc|invoke|mutate|mutateAsync|from|select)\s*\(|\bfetch\s*\(|\baxios\b|\bmethod\s*[:=]|\b(?:POST|PUT|PATCH|DELETE)\b|\bonClick\b|\bonSubmit\b|\baction=|\bthrow\b|\buseMutation\b|\b(?:delete|remove|save|update|create|add|insert|upsert|submit|send)[A-Z]\w*\s*\(/;
const CARRIES_WORDS = />\s*[A-Za-z][^<>{}]{2,}<|<(?:button|form|input|select|textarea|label|a|h[1-6]|Button|Link|Input|Form)\b|\b(?:label|title|placeholder|aria-label|alt|heading|subtitle|description|tooltip|message|confirm|alert|toast\w*)\b["']?\s*[=:(]\s*\{?\s*["'`]|["'`][A-Z][a-z]+(?: [A-Za-z&'-]+)+[.!?…]?["'`]/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!\w*[({])|<!--|\{\/\*)/;
/** A line kept when a file is cut: one line can be a page of text in a generated file. */
const MAX_LINE = 1200;

/** Whether this line is a comment: a claim can't rest on one, since comments go stale and code doesn't (see code-map.ts). */
export const isCommentLine = (line: string) => COMMENT_LINE.test(line);

/** Code types whose comments start with `#`, where `//` is arithmetic and `/*` means nothing. */
const HASH_COMMENTS = new Set([".py", ".rb", ".ex", ".exs", ".graphql", ".gql"]);
/** What a template language calls a comment: Handlebars, ERB, Jinja. */
const TEMPLATE_COMMENTS: [string, string][] = [["{{!--", "--}}"], ["{{!", "}}"], ["<%#", "%>"], ["{#", "#}"]];

/**
 * The comments in a file, in order. Quotes are stepped over, or accept="image/*" would turn the rest
 * of a file into a comment; a ' or " ends with its line, since text in markup holds apostrophes,
 * and right after a `/` or a `[` it's in a regex, so it was no quote. A docstring counts as a
 * comment: it's prose nothing runs. Anything else reads as code, and what comes after `:`, `=` or
 * `(` is an address, not a comment.
 */
function* commentsIn(text: string, hash = false): Generator<{ start: number; end: number; block: boolean }> {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const triple = hash && (text.startsWith('"""', i) || text.startsWith("'''", i)) ? text.slice(i, i + 3) : undefined;
    const template = hash ? undefined : TEMPLATE_COMMENTS.find(([open]) => text.startsWith(open, i));
    if (triple || template) {
      const close = triple ?? template![1];
      const end = text.indexOf(close, i + (triple ? 3 : template![0].length));
      const after = end < 0 ? text.length : end + close.length;
      // A string given to a name is a value, and goes on being read as one; a docstring stands alone.
      if (template || !/(?:[=(,:]|\breturn)[ \t]*$/.test(text.slice(Math.max(0, i - 40), i))) yield { start: i, end: after, block: true };
      i = after;
    } else if (c === '"' || c === "'" || c === "`") {
      const from = i;
      for (i++; i < text.length && text[i] !== c && (c === "`" || text[i] !== "\n"); i++) if (text[i] === "\\") i++;
      if (text[i] === "\n" && c !== "`" && "/[".includes(text[from - 1] ?? " ")) i = from;
      i++;
    } else if (hash ? c === "#" && text[i + 1] !== "{" : text.startsWith("//", i) && !":=(\\".includes(text[i - 1] ?? " ")) {
      const end = text.indexOf("\n", i);
      yield { start: i, end: end < 0 ? text.length : end, block: false };
      i = end < 0 ? text.length : end;
    } else if (!hash && text[i - 1] !== "\\" && (text.startsWith("/*", i) || text.startsWith("<!--", i))) {
      const close = text[i] === "/" ? "*/" : "-->";
      const end = text.indexOf(close, i + 2);
      yield { start: i, end: end < 0 ? text.length : end + close.length, block: true };
      if (end < 0) return;
      i = end + close.length;
    } else i++;
  }
}

/** Whether this place in a file is inside a block comment (`/* … *\/`, `<!-- … -->`), which is how whole routes get switched off and which no single line shows. */
export function inBlockComment(text: string, at: number): boolean {
  for (const comment of commentsIn(text)) {
    if (comment.start >= at) return false;
    if (comment.block && at < comment.end) return true;
  }
  return false;
}

const MASK = "***";
const AFTER_CREDENTIAL_WORD = new RegExp(`\\b((?:${COMMENT_WORD})\\b(?:[ \\t]+is\\b|[ \\t]*[:=])?[ \\t]*["'\`]?)[^\\s"'\`]+`, "gi");
const WORD_IN_A_COMMENT = /[^\s"'`<>(){}=,;]{6,}/g;

/**
 * Comments with anything that reads like a value masked: the word after a credential's name, and
 * any word with both digits and letters in it. It knows no shape of key, so it holds for one no
 * pattern here has heard of. The words around stay, and so do the lines: taking comments out whole
 * would change why a claim citing one is refused, and a mistaken comment here costs one word.
 */
function maskComments(text: string, type: string): string {
  let out = "";
  let from = 0;
  for (const { start, end } of commentsIn(text, HASH_COMMENTS.has(type))) {
    const masked = text.slice(start, end).replace(AFTER_CREDENTIAL_WORD, `$1${MASK}`).replace(WORD_IN_A_COMMENT, (word) => (/\d/.test(word) ? MASK : word));
    out += text.slice(from, start) + masked;
    from = end;
  }
  return out + text.slice(from);
}

/**
 * A file cut down to `budget` bytes, one whole line at a time and in its own order: what a press does
 * first, then what a person reads, then anything else that fits, each taken evenly through the file
 * so one end isn't lost. Comments never make the cut. Says nothing about how much that was; `fit` keeps the count.
 */
export function reduce(text: string, budget: number): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  let room = budget;
  // A line's bytes, its line break, and the "…" that may have to follow it.
  const costOf = (line: string) => Buffer.byteLength(line) + 5;
  const take = (wanted: (line: string) => boolean) => {
    const found = lines.flatMap((line, i) => (!keep.has(i) && line.length <= MAX_LINE && !isCommentLine(line) && wanted(line) ? [i] : []));
    const size = found.reduce((sum, i) => sum + costOf(lines[i]!), 0);
    const every = size <= room ? 1 : Math.ceil(size / Math.max(1, room));
    found.forEach((i, n) => {
      const cost = costOf(lines[i]!);
      if (n % every === 0 && cost <= room) {
        keep.add(i);
        room -= cost;
      }
    });
  };
  take((line) => CARRIES_ACTION.test(line));
  take((line) => CARRIES_WORDS.test(line));
  // Room left over is worth more as context around those lines than as nothing.
  take((line) => line.trim() !== "");
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out.push("…");
    out.push(lines[i]!);
    last = i;
  }
  return out.join("\n");
}

export interface SentFile {
  path: string;
  /** Exactly what the AI was shown of it. */
  sent: string;
  /** The file as it may be shown, whole: where a cited quote's line is counted. */
  whole: string;
}

export interface Cut {
  file: string;
  sentBytes: number;
  ofBytes: number;
}

/**
 * Files fitted into one question: each gets a fair share, the smallest first so what they don't use
 * goes to the big ones, and a file over its share is reduced. What was cut is returned, so it can be
 * stated rather than lost.
 */
export function fit(files: readonly RepoFile[], budget: number): { sent: SentFile[]; cut: Cut[] } {
  const order = [...files].sort((a, b) => a.text.length - b.text.length);
  const sent: SentFile[] = [];
  const cut: Cut[] = [];
  let room = budget;
  order.forEach((file, i) => {
    const share = Math.floor(room / (order.length - i));
    const whole = Buffer.byteLength(file.text);
    if (whole <= share) {
      sent.push({ path: file.path, sent: file.text, whole: file.text });
      room -= whole;
      return;
    }
    const reduced = reduce(file.text, share);
    const size = Buffer.byteLength(reduced);
    sent.push({ path: file.path, sent: reduced, whole: file.text });
    cut.push({ file: file.path, sentBytes: size, ofBytes: whole });
    room -= size;
  });
  // Back in the order asked for: the first file named is the one that matters most.
  const at = new Map(files.map((f, i) => [f.path, i]));
  return { sent: sent.sort((a, b) => at.get(a.path)! - at.get(b.path)!), cut };
}

/** What a file loads: an import, a re-export, a require, a CSS import, a page's script or style. */
const LOADS = /\b(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'`]([^"'`\n]+)["'`]|@import\s+(?:url\(\s*)?["']([^"')\n]+)|<script\b[^>]*?\bsrc=["']([^"']+)["']|<link\b[^>]*?\bhref=["']([^"']+)["']/g;
/** Where an app starts: its page, its main module, the folders a framework or a host turns into routes. */
const ENTRY = /^(?:(?:web|client|frontend|public|static)\/)?index\.html$|^(?:src|app|client|web|frontend)\/(?:main|index|app|App)\.\w+$|^(?:src\/)?(?:app|pages|routes)\/.+\.\w+$|^(?:api|server|functions|netlify\/functions|supabase\/functions)\/.+\.\w+$|^server\.\w+$/;
const TRIED = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".css", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * The files an app really runs: what its entries load, and what those load, read from the code with
 * nothing run. A repository often holds a mock, a design lab or an old copy of a screen that draws the
 * same words, and a change made there changes nothing a person sees. Undefined when no entry can be
 * told, or nothing follows from one: that says nothing about any file.
 */
export function shippedFiles(files: readonly Pick<RepoFile, "path" | "text">[]): Set<string> | undefined {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const resolved = (from: string, wanted: string): string | undefined => {
    const bare = wanted.split(/[?#]/)[0]!;
    const base = bare.startsWith(".") ? posix.join(posix.dirname(from), bare)
      : bare.startsWith("/") ? bare.slice(1)
      : /^[@~]\//.test(bare) ? `src/${bare.slice(2)}`
      : bare.startsWith("src/") ? bare : undefined;
    if (base === undefined) return undefined;
    const inFolder = [base, ...(from.includes("/") ? [posix.join(from.split("/")[0]!, base)] : [])];
    for (const start of inFolder) for (const tail of TRIED) if (byPath.has(`${start}${tail}`)) return `${start}${tail}`;
    return undefined;
  };
  const shipped = new Set(files.filter((f) => ENTRY.test(f.path)).map((f) => f.path));
  const entries = shipped.size;
  const waiting = [...shipped];
  while (waiting.length) {
    const file = byPath.get(waiting.pop()!)!;
    for (const found of file.text.matchAll(LOADS)) {
      const next = resolved(file.path, found[1] ?? found[2] ?? found[3] ?? found[4] ?? "");
      if (next && !shipped.has(next)) {
        shipped.add(next);
        waiting.push(next);
      }
    }
  }
  return entries > 0 && shipped.size > entries ? shipped : undefined;
}

/**
 * The same for a repository, with what's held back from sending read here too: only what a file loads
 * is taken from one, nothing leaves, and an entry held back for a public key would otherwise cut off
 * the whole app below it.
 */
export function shippedIn(repo: Pick<Repo, "files"> & Partial<Pick<Repo, "root" | "heldBack">>): Set<string> | undefined {
  const held = (repo.heldBack ?? []).flatMap((path) => {
    try {
      return [{ path, text: readFileSync(join(repo.root!, path), "utf8") }];
    } catch {
      return []; // gone or unreadable: what it loads just isn't followed
    }
  });
  return shippedFiles([...repo.files, ...held]);
}
