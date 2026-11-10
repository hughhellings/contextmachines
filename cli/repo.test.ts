// What may leave the machine, with planted secrets and the traps that look like them:
//   node --test cli/repo.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { copiedFromData, fit, holdsSecret, inBlockComment, matchFiles, personalShaped, readRepo, reduce, schemaTables, secretPath, shippedFiles, shippedIn, type Repo } from "./repo.ts";

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A real git repo holding these files, all tracked. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cm-repo-")));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "-A", "-f"], { cwd: root });
  return root;
}
const kept = (r: Repo | undefined) => r!.files.map((f) => f.path);
// Built from pieces, so nothing in this file is shaped like a key to a scanner.
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoiYW5vbiJ9", "c2lnbmF0dXJlLXNpZ25hdHVyZQ"].join(".");
const STRIPE = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";

describe("what is kept", () => {
  it("keeps the code and nothing else that is tracked, without opening it", () => {
    const root = repo({
      "src/App.tsx": "export const App = () => <h1>Trades</h1>;\n",
      "index.html": "<title>Acme</title>\n",
      "server/views.py": "def home(): pass\n",
      "README.md": "# Secret plans\n",
      "db/schema.sql": "create table t (a int);\n",
      "deploy.sh": "echo hi\n",
      ".env": "NAME=value\n",
      ".env.example": "NAME=value\n",
      "apps/web/.env.production.example": "NAME=value\n",
      "src/brief/page.bundle.js.orig": "old copy\n",
      "src/old.tsx.bak": "old copy\n",
      "data/people.csv": "a,b\n",
      "config/settings.json": "{}\n",
      "SECRETS.md": "names\n",
    });
    const r = readRepo(root);
    assert.deepEqual(kept(r).sort(), ["index.html", "server/views.py", "src/App.tsx"]);
    assert.equal(r!.dropped.type, 11);
  });

  it("leaves out secret paths by name, code type or not", () => {
    for (const path of [".env", ".env.local", "env.ts", "src/config.env.js", "src/env/index.ts", "secrets.ts", "src/lib/credentials.js", "src/apiKeys.ts", "api_key.py", "src/service-role.ts", "src/lib/serviceRoleKey.ts", "keys.ts", "config/privateKey.js", "service-account.js", "certs/server.pem.js", "src/environments/environment.prod.ts", "src/environment.ts", "wp-config.php"]) {
      assert.equal(secretPath(path), true, path);
    }
    for (const path of ["src/KeyboardShortcuts.tsx", "src/monkey.ts", "src/environment-banner.tsx", "src/tokens.ts", "src/Passkey.tsx", "src/hotkeys.ts"]) {
      assert.equal(secretPath(path), false, path);
    }
  });

  it("leaves out tests, fixtures, seeds, build output and old copies, however good the code", () => {
    const root = repo({
      "src/real.ts": "export const a = 1;\n",
      "src/real.test.ts": "x\n",
      "src/real.spec.tsx": "x\n",
      "src/__tests__/a.ts": "x\n",
      "tests/a.py": "x\n",
      "src/lib/sampleData.ts": "export const rows = [];\n",
      "src/mock-users.js": "x\n",
      "prisma/seed.ts": "x\n",
      "db/seeds/users.rb": "x\n",
      "fixtures/orders.ts": "x\n",
      "dist/app.js": "x\n",
      "vendor/lib.js": "x\n",
      "public/app.min.js": "x\n",
      "archive/App.tsx": "x\n",
      "scripts/make_test_account.py": "x\n",
      "types.d.ts": "x\n",
    });
    assert.deepEqual(kept(readRepo(root)), ["src/real.ts"]);
  });

  it("leaves out made-up records however the file spells it, and keeps a page that shares a word", () => {
    const r = readRepo(repo({ "src/demoData.ts": "x\n", "src/test-data.js": "x\n", "src/lib/exampleData.ts": "x\n", "src/DemoRequest.tsx": "x\n", "src/TestimonialData.tsx": "x\n" }));
    assert.deepEqual(kept(r), ["src/DemoRequest.tsx", "src/TestimonialData.tsx"]);
  });

  it("drops the whole file on anything shaped like a key", () => {
    const planted: Record<string, string> = {
      "src/jwt.ts": `const anon = "${JWT}";\n`,
      "src/stripe.ts": `const key = "${STRIPE}";\n`,
      "src/aws.py": `id = "${AWS}"\n`,
      "src/block.ts": "const k = `-----BEGIN RSA PRIVATE KEY-----`;\n",
      "src/db.py": 'url = "postgres://admin:s3cretpw@db.internal:5432/app"\n',
      "src/login.ts": 'const opts = { password: "hunter2" };\n',
      "src/server.py": 'JWT_SECRET = "correcthorsebatterystaple"\n',
      "src/fallback.js": 'const t = process.env.API_TOKEN || "abc123def";\n',
      "src/bearer.ts": `fetch(u, { headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123" } });\n`,
      "src/hex.ts": `const signing = "${"ab12".repeat(10)}";\n`,
      "src/basic.ts": 'fetch(u, { headers: { auth: "Basic dXNlcjpsb25nLXBhc3N3b3JkLWhlcmU=" } });\n',
      "src/rails.rb": 'config.secret_key_base = "notrealbutlongenough1"\n',
      "src/userinfo.ts": 'const client = { token: "https://me:hunter2@auth.acme.dev/x" };\n',
      "src/getenv.py": 'password = os.environ.get("DB_PASSWORD", "hunter22")\n',
      // Fake values of the real shapes, joined so no scanner takes this test for a leak.
      "src/resend.ts": `const k = "${"re_"}abcdefghijklmnop1234";\n`,
      "src/shopify.ts": `const k = "${"shpat_"}0123456789abcdef0123456789abcdef";\n`,
      "src/ocean.ts": `const k = "${"dop_v1_"}${"a1".repeat(32)}";\n`,
      "src/hug.ts": `const k = "${"hf_"}abcdefghijklmnopqrstuvwxyz";\n`,
      "src/twilio.ts": `const k = "${"SK"}${"0a".repeat(16)}";\n`,
      "src/mailgun.ts": `const k = "${"key-"}${"a1".repeat(16)}";\n`,
      "src/slackhook.ts": `const u = "${"https://hooks.slack.com/"}services/T000/B000/abcdefg";\n`,
      "src/discordhook.ts": `const u = "${"https://discord.com/"}api/webhooks/123456/abcdefg";\n`,
      "src/query.ts": 'const u = "https://api.example.com/v1/x?api_key=abcd1234";\n',
      "src/querytoken.ts": 'const u = "/feed?token=abcd1234";\n',
      "src/pw.ts": 'const pw = "tr0ub4dor";\n',
      "src/dbpass.ts": 'const dbPass = "letmein1";\n',
      "src/smtp.py": 'SMTP_PASS = "letmein1"\n',
      "src/pin.ts": 'const adminPin = "4821";\n',
      "src/signing.ts": 'const signingKey = "abcdefgh";\n',
      "src/encryption.ts": 'const encryptionKey = "abcdefgh";\n',
      "src/stripekey.ts": 'const stripeKey = "abcdefgh";\n',
      "src/sessionkey.ts": 'const sessionKey = "abcdefgh";\n',
      "src/postmark.ts": 'const POSTMARK_KEY = "12345678-1234-1234-1234-123456789012";\n',
      "src/authpair.ts": 'const opts = { auth: "admin:hunter" };\n',
      "src/supersecret.ts": "const JWT_SECRET = 'supersecret';\n",
      "src/sunshine.ts": "const opts = { password: 'sunshine' };\n",
      "src/comment.ts": "// the admin password is hunter22\nconst a = 1;\n",
      "src/hash.py": "# password: hunter22\na = 1\n",
      "src/shortredis.ts": 'const u = "redis://u:pw1@cache.internal";\n',
      "src/shortbearer.ts": 'const h = "Bearer abc12345";\n',
      "src/shortbasic.ts": 'const h = "Basic dXNlcjE6cA==";\n',
      "src/signinlist.ts": 'const users = [["admin@acme.co", "hunter"]];\n',
      "src/settings.php": "define('DB_PASSWORD', 'correcthorse');\n",
      "src/fetch.rb": 'key = ENV.fetch("STRIPE_API_KEY", "letmeinplease")\n',
    };
    const r = readRepo(repo({ "src/App.tsx": "ok\n", ...planted }));
    assert.deepEqual(kept(r), ["src/App.tsx"]);
    assert.equal(r!.dropped.secret, Object.keys(planted).length);
  });

  it("doesn't take everyday code for a secret", () => {
    for (const line of [
      '<input type="password" placeholder="Password" />',
      'password: "",',
      "password: z.string().min(8),",
      "const password = form.password;",
      'if (password === confirm) return "Passwords match";',
      'const token = "";',
      'errors.password = "required";',
      'const tokenKey = "auth-token";',
      'apiKey: process.env.OPENAI_API_KEY,',
      'password: "your-password-here",',
      'const url = `postgres://${user}:${pass}@${host}/db`;',
      'const example = "postgres://user:password@localhost/db";',
      '<script integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6d4Rbl7Z9g8Pd9o3nP8mQ8lQ9kL7xP9qR1sT2uV3w" src="x.js"></script>',
      'const id = "00000000-0000-4000-8000-000000000001";',
      'const label = "Delete this trade forever";',
      'navigate("/api/keys");',
      'const tokenUrl = "https://example.com/oauth/token";',
      'const passwordResetPath = "/reset-password";',
      'const pick = ["password", "password_confirmation"];',
      'const secret = process.env.JWT_SECRET ?? "";',
      'os.getenv("API_KEY", "your-key-here")',
      'params.get("token", "")',
      'const ROUTES = { resetPassword: "/auth/reset-password" };',
      'const q = useQuery({ queryKey: "trades-2024" });',
      'createClient(url, key, { auth: { storageKey: "ledger-auth-v2" } });',
      'const COLUMN = { primaryKey: "user_id2" };',
      'const monkey = "curious1";',
      '<li key="trade-row1">x</li>',
      'errors.password = "required";',
      'autoComplete: "current-password",',
      'if (bypass === "feature1") run();',
      'const spin = "spinner1";',
      'const pinned = "pinned-item";',
      '// the password field: required, at least eight long',
      '// a secret is never logged',
      'headers.authorization = `Bearer ${token}`;',
      'const label = "Bearer token";',
      'const url = `/feed?token=${token}`;',
      'const search = "/trades?key=x";',
      'const mail = ["help@acme.co", "sales"];',
      'const auth = "email:password";',
      'const client = { token: "https://auth.example.com/oauth/token" };',
    ]) {
      assert.equal(holdsSecret(line), false, line);
    }
  });

  // Every value here is joined at run time, so nothing in this file is shaped like a secret to a scanner.
  const PW = ["Hun", "ter22x"].join("");
  const HEX = ["9f86d081", "884c7d65", "a0"].join("");
  const RANDOM = ["a8Kd92Lm", "Qz7Xw3Vb", "5Nt1"].join("");
  const KEY = ["ab12cd34", "ef56gh78", "ij90=="].join("");
  const LONG_KEY = ["51NqvZxK", "j3l2m4n5", "o6p7q8r9s0t"].join("");
  const key = (prefix: string, rest = "abcDEF123456789012") => [prefix, rest].join("");
  const WORDS = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident"].join(" ");
  const SSN = ["078", "05", "1120"].join("-");

  /** Unquoted values, calls, command lines, headers, comments and key shapes, as the seal attack planted them. */
  const PLANTS: Record<string, string> = {
    connStr: `const c = "Server=tcp:acme.db;Database=app;User Id=sa;${"Password"}=${PW}!;";`,
    pwd: `const c = "Driver=x;Uid=sa;${"Pwd"}=${PW};";`,
    libpq: `const c = "host=db.acme.co user=app ${"password"}=${PW} dbname=app";`,
    template: `const c = \`host=db.acme.co\n${"password"}=${PW}\n\`;`,
    azureAccount: `const c = "AccountName=acme;${"AccountKey"}=${KEY};EndpointSuffix=core.windows.net";`,
    azureBus: `const c = "Endpoint=sb://acme/;${"SharedAccessKey"}=${KEY};";`,
    envBracket: `const s = process.env["JWT_SECRET"] || "dev-secret-123";`,
    envBracketSingle: `const s = process.env['SESSION_SECRET'] ?? 'abc123longvalue';`,
    rubyFetch: `conf = ENV.fetch("DB_PASSWORD") { "${PW}" }`,
    pythonOr: `pw = os.environ.get("DB_PASSWORD") or "${PW}"`,
    goAssign: `password := "${PW}"`,
    goSetenv: `os.Setenv("API_KEY", "${HEX}")`,
    jwtSign: `const t = jwt.sign(payload, "${PW}");`,
    jwtSignObject: `const t = jwt.sign({ id: user.id, role: roles[0] }, "${PW}", { expiresIn: "1h" });`,
    jwtWord: `const t = jwt.sign(payload, "letmein");`,
    jwtVerify: `jwt.verify(token, "${PW}");`,
    bareSign: `const t = sign(payload, "${PW}");`,
    hmac: `const h = crypto.createHmac("sha256", "${PW}").update(x);`,
    cipher: `const c = crypto.createCipheriv("aes-256-cbc", "${PW}", iv);`,
    pythonHmac: `h = hmac.new(b"${PW}", msg, hashlib.sha256)`,
    goHmac: `h := hmac.New(sha256.New, []byte("${PW}"))`,
    strategyOptions: `const o = { secretOrKey: "sessionsigner" };`,
    textEncoder: `const secret = new TextEncoder().encode("${PW}");`,
    hexKey: `const key = Buffer.from("00112233445566778899aabb", "hex");`,
    wrappedPrivate: `const privateKey = hex("00112233445566778899aabbccddeeff");`,
    arrayValue: `app.use(session({ secret: ["${PW}"] }));`,
    shoutedArray: `const PASS = ["${PW}"];`,
    passcode: `const passcode = "8675309";`,
    tuple: `auth = ("admin", "${PW}")`,
    basicPair: `const h = btoa("admin:${PW}");`,
    curl: `run("curl -u admin:${PW} https://api.acme.co")`,
    curlArgs: `spawn("curl", ["-u", "admin:${PW}", url]);`,
    sshpass: `run("sshpass -p ${PW} ssh root@prod.acme.co")`,
    mysql: `run("mysql -uroot -p${PW} app")`,
    longFlag: `run("backup --password=${PW}")`,
    tokenHeader: `const h = { Authorization: "Token ${HEX}" };`,
    schemeHeader: `const h = { Authorization: "ApiKey ${HEX}" };`,
    setHeader: `r.setRequestHeader("Authorization", "Token ${HEX}");`,
    keyHeader: `const h = { "x-api-key": "${HEX}" };`,
    cookieHeader: `const h = { Cookie: "session=${HEX}" };`,
    setCookie: `res.setHeader("Set-Cookie", "sid=${HEX}; HttpOnly");`,
    commentToken: `// staging token ${HEX} works for now\nexport const a = 1;`,
    commentPw: `// pw ${PW}\nexport const a = 1;`,
    commentLogin: `// test login: admin@acme.co / ${PW}\nexport const a = 1;`,
    trailing: `x = 1  # token: ${HEX}`,
    mnemonic: `const phrase = "${WORDS}";`,
    ssnRow: `export const USERS = [{ name: "Jane Doe", ssn: "${SSN}" }];`,
    splitKey: `const k = "sk_live_" + "${LONG_KEY}";`,
    splitLines: `const k = "sk_live_" +\n  "${LONG_KEY}";`,
    splitPhp: `$k = 'sk_live_' . '${LONG_KEY}';`,
    linear: `const k = "${key("lin_api_")}";`,
    notion: `const k = "${key("ntn_")}";`,
    figma: `const k = "${key("figd_")}";`,
    posthog: `const k = "${key("phx_")}";`,
    google: `const k = "${key("GOCSPX-")}";`,
    square: `const k = "${key("sq0atp-")}";`,
    sentry: `const k = "${key("sntrys_")}";`,
    supabase: `const k = createClient(u, "${key("sb_secret_")}");`,
    facebook: `const k = "${key("EAAGm0PX4Z")}";`,
    teams: `const u = "${"https://acme.webhook.office.com/"}webhookb2/abc123/IncomingWebhook/def456";`,
  };

  it("holds back every planted shape, and nothing of it goes", () => {
    const files = Object.fromEntries(Object.entries(PLANTS).map(([name, text]) => [`src/${name}.ts`, `${text}\n`]));
    const r = readRepo(repo({ "src/App.tsx": "ok\n", ...files }));
    assert.deepEqual(kept(r), ["src/App.tsx"]);
    assert.equal(r!.dropped.secret, Object.keys(PLANTS).length);
    for (const value of [PW, HEX, KEY, LONG_KEY, WORDS, SSN]) assert.ok(!r!.files.some((f) => f.text.includes(value)));
  });

  it("holds back a value with no known shape beside a credential's name", () => {
    for (const line of [`const s = connect(apiKey, "${RANDOM}");`, `const session_token_holder = wrap("${RANDOM}");`, `const key = "${RANDOM}";`, `init(secret, "${HEX}");`]) {
      assert.equal(holdsSecret(line), true, line);
    }
    for (const line of [`const publicKey = "${RANDOM}";`, `const tokenColor = "${["primary", "foreground", "900"].join("-")}";`, 'const key = "orders-dashboard-2024-q1";', 'const tokenName = "shop_order_tickets";', 'const secretName = "STRIPE_SECRET_KEY_2024";', 'const authId = "00000000-0000-4000-8000-000000000001";']) {
      assert.equal(holdsSecret(line), false, line);
    }
  });

  it("holds back the shapes people really write: types, endings, calls, flags and odd values", () => {
    const random = ["q8Vn3Kd92L", "m1Xy7Zt4Bc"].join(""); // made up
    const real = (line: string) => line.replaceAll("@PW@", ["Hunter", "22x"].join("")).replaceAll("@KEY@", ["abc123", "def456"].join("")).replaceAll("@CODE@", ["abcd", "1234", "efgh", "5678"].join("-"));
    for (const line of [
      // A type between the name and its value, in any language's place for one.
      'const dbPassword: string = "@PW@";', 'export const apiKey: string = "@KEY@";', 'val password: String = "@PW@"', 'const DB_PASSWORD: &str = "@PW@";', 'var dbPassword string = "@PW@"', 'let token: String = "@KEY@"',
      // A string's prefix, or a wrapper.
      'password = b"@PW@"', 'password = f"@PW@"', 'SECRET_KEY = r"@PW@"', 'let password = String::from("@PW@");',
      // Any ending after the word.
      'const DB_PASSWORD_DEV = "@PW@";', 'const dbPasswordStaging = "@PW@";', 'const TOKEN_2 = "@KEY@";', 'const API_KEY_DEV = "@KEY@";', 'const APP_SECRET_V2 = "@KEY@";',
      // Values that only start like a placeholder, or hold a space or an apostrophe.
      'const password = "correct horse battery 9";', `const password = "it's-Hunter22";`, 'const password = "$uperS3cret!";', 'const dbPassword = "%@PW@";', 'const dbPassword = "{@PW@}";', 'const password = "myPassword123";', 'const password = "Youri1985!";', 'const password = "Example2024!";', 'const password = "Todoroki99";',
      // By a call.
      'client.setPassword("@PW@");', 'mail.setApiKey("@KEY@");', 'const [password, setPassword] = useState("@PW@");', 'await login("admin", "@PW@");', 'new BasicAuth("admin", "@PW@");', 'request.get(u).auth("admin", "@PW@");', '<input type="password" defaultValue="@PW@" />',
      // Inside a string, and on a command line written as a list.
      'const cfg = "DB_PASSWORD=@PW@";', 'run("PGPASSWORD=@PW@ psql -h db app");', 'run("MYSQL_PWD=@PW@ mysql app");', 'spawn("x", ["--password", "@PW@"]);', 'spawn("x", ["--token", "@KEY@"]);',
      // A generated value with nothing near it to say so.
      `const c = new Mailer(\n  "${random}"\n);`, `const keys = {\n  mailer: "${random}",\n};`, `const bearer = "${random}";`, `const license = "${random}";`, `init("${random}");`, `client.login("${random}");`,
      // "public" as a keyword says nothing; only a name can.
      `public static final String API_TOKEN_2 = "${random}";`, `public const string ApiTok = "${random}";`, `const anonSecret = "${random}";`,
      // Other spellings and shapes.
      'const passwort = "@PW@";', 'const contrasena = "@PW@";', 'const adminHash = "$2b$12$q8Vn3Kd92Lm1Xy7Zt4BcO";', 'const salt = "@KEY@";', 'const authCode = "@CODE@";',
      // Said in words on a page.
      "export const L = () => <p>Demo login: demo@acme.co / Demo1234x</p>;", "<p>password: @PW@</p>", 'alert("The admin password is @PW@");',
    ].map(real)) assert.equal(holdsSecret(line), true, line);
  });

  it("leaves what only looks like those", () => {
    for (const line of [
      'const password: string = "";', 'const [password, setPassword] = useState("");', 'setPassword("");', 'setPasswordError("Too short");', 'const password = process.env.DB_PASSWORD;', 'const password = "${DB_PASSWORD}";', 'const dbPassword = "$DB_PASSWORD";', 'const q = "%s";', 'const password = "{password}";', 'const password = "your-password";', 'const password = "your_password_here";', 'const password = "my-secret";', 'const token = "example-token";', 'const secret = "todo";', 'const secret = "changeme";', 'const password = "xxxxxxxx";', 'const password = "<password>";',
      // Words about a credential, not one.
      'const tokenUrl = "/auth/token";', 'const passwordLabel = "Password:";', 'const passwordPlaceholder = "••••••••";', 'const tokenType = "bearer";', 'const tokenColor = "#1a2b3c";', 'const tokenSize = "16px";', 'const tokenizer = "cl100k_base";', 'const tokens = "primary-foreground";', 'const password = "Password must be at least 8 characters";', 'const password = "Enter your password";',
      // Calls and flags that carry none.
      'login(email, password);', 'login("email", "password");', 'await signIn("google", { redirect: true });', 'spawn("vite", ["--port", "3000"]);', 'spawn("x", ["-p", "3000"]);', 'connect("db", password=db_pass2, host="h")', 'const row = { password: hashedPassword1 };',
      // Text that's generated-looking but isn't random.
      'const event = "getUserProfileV2ByAccount";', 'const alg = "sha256WithRSAEncryption";', 'const file = "logo-a1b2c3d4e5f6a7b8";', 'const id = "123e4567-e89b-42d3-a456-426614174000";', 'const c = "flex-col items-center gap-2";',
      // A name that says it's public still says so.
      'const publicKey = "q8Vn3Kd92Lm1Xy7Zt4Bc";', 'const anonKey: string = "q8Vn3Kd92Lm1Xy7Zt4Bc";',
    ]) assert.equal(holdsSecret(line), false, line);
  });

  it("masks docstrings and template comments like comments, and leaves a string that is a value", () => {
    const shown = (path: string, text: string) => readRepo(repo({ [path]: text }))!.files.find((f) => f.path === path)!.text;
    assert.doesNotMatch(shown("src/a.py", '"""\nAdmin login: admin / Hunter22x\nstaging token q8Vn3Kd92Lm1\n"""\ndef f():\n    pass\n'), /Hunter22x|q8Vn3Kd92Lm1/);
    assert.doesNotMatch(shown("src/b.py", 'def f():\n    \'\'\'the box is 482913\'\'\'\n    pass\n'), /482913/);
    assert.match(shown("src/c.py", 'QUERY = """select plan2 from t"""\n'), /plan2/);
    assert.doesNotMatch(shown("src/d.hbs", "{{!-- admin Hunter22x --}}\n<p>hi</p>"), /Hunter22x/);
    assert.doesNotMatch(shown("src/e.erb", "<%# admin Hunter22x %>\n<p>hi</p>"), /Hunter22x/);
    assert.doesNotMatch(shown("src/f.j2", "{# admin Hunter22x #}\n<p>hi</p>"), /Hunter22x/);
    assert.doesNotMatch(shown("src/g.php", "<?php\n# admin sunshine22 works\n"), /sunshine22/);
    assert.doesNotMatch(shown("src/h.ts", "const r = /'/; // the password is sunshine\n"), /sunshine/);
    assert.doesNotMatch(shown("src/i.ts", "// the box code is 482913\nconst a = 1;\n"), /482913/);
  });

  it("doesn't take the code around credentials for one", () => {
    for (const line of [
      'const c = `host=${h} password=${p} dbname=app`;',
      'const q = "UPDATE users SET password = $1 WHERE id = $2";',
      'const q = "select * from t where token = ?";',
      'const q = "update t set token = excluded.token";',
      'const q = "password = :password";',
      'connect("db", password=db_pass2, host="h")',
      'const line = "password=" + encode(pw);',
      'const t = jwt.sign(payload, process.env.JWT_SECRET);',
      'const t = jwt.sign(payload, secret, { expiresIn: "1h" });',
      'signer.sign(privateKey, "base64");',
      'jwt.sign(payload, key, "HS256");',
      'crypto.createHmac("sha256", secret).update(x).digest("hex");',
      'crypto.createCipheriv("aes-256-gcm", key, iv);',
      'sign(value, "positive");',
      'Math.sign(x);',
      'secretOrKey: process.env.JWT_SECRET,',
      'const tokenBytes = Buffer.from(token, "base64");',
      'const key = Buffer.from(rawKey, "hex");',
      'run("curl -u $USER:$PASS https://api.acme.co")',
      'run("curl -u user:password https://api.acme.co")',
      'run("psql -p 5432 app")',
      'run("mysql -p app")',
      'run("docker login -u me --password-stdin")',
      'const help = "--password <pw>";',
      'run(`backup --password=${pw}`)',
      'const h = { Authorization: `Bearer ${token}` };',
      'const h = { Authorization: "Bearer " + token };',
      'const h = { Authorization: "Not allowed" };',
      'headers["authorization"] = "none";',
      'document.cookie = "theme=dark-mode-on2; path=/";',
      'res.setHeader("Set-Cookie", `sid=${id}; HttpOnly`);',
      'const notice = { cookie: "Cookies keep you signed in" };',
      '// token refresh runs every hour',
      '// login: redirect to the home page',
      '// const token = getToken();',
      '// token: localStorage.getItem("session2")',
      '// the token is sha256',
      '# login page step2',
      '// pw reset flow',
      '// password: z.string().min(8),',
      'const ssn = "123-45-6789";',
      'const id = "000-12-3456";',
      'const months = "jan feb mar apr may jun jul aug sep oct nov dec";',
      'const line = "review every order and write down what went wrong before the next release";',
      'key.startsWith("sk_live_");',
      'const msg = "Your token is " + "invalid";',
      'const consentKey = "app-consent-choice-v1";',
      'const pair = ["ann@acme.co", "bob@acme.co"];',
      'const status = { PASS: "passed", PIN: "pinned" };',
    ]) {
      assert.equal(holdsSecret(line), false, line);
    }
  });

  it("gives a token's name no pass for words joined up, as it does a storage key's", () => {
    assert.equal(holdsSecret('const apiToken = "correct-horse-battery-staple";'), true);
  });

  it("masks what reads like a value in a comment, whatever its shape, and leaves the code and the lines", () => {
    const code = [
      "// rotated from zq7Xv2Lp9Wm4 last spring",
      "/* the old one",
      "   was r8Tn3Qw6 */",
      "<!-- token sunshine -->",
      'const u = "https://acme.co/a1b2c3d4"; // see b7Gh2Kq9Pw',
      '<input accept="image/*" data-id="c4d5e6f7a8" />',
      "const ratio = a / b2c3d4e5;",
      "",
    ].join("\n");
    const python = "# rotated from zq7Xv2Lp9Wm4\nx = a // b2c3d4e5\n";
    const r = readRepo(repo({ "src/a.tsx": code, "server/a.py": python }));
    const [py, tsx] = r!.files;
    assert.deepEqual(tsx!.text.split("\n"), [
      "// rotated from *** last spring",
      "/* the old one",
      "   was *** */",
      "<!-- token *** -->",
      'const u = "https://acme.co/a1b2c3d4"; // see ***',
      '<input accept="image/*" data-id="c4d5e6f7a8" />',
      "const ratio = a / b2c3d4e5;",
      "",
    ]);
    assert.equal(py!.text, "# rotated from ***\nx = a // b2c3d4e5\n");
  });

  it("never follows a tracked link out of the folder", () => {
    const outside = mkdtempSync(join(tmpdir(), "cm-outside-"));
    made.push(outside);
    writeFileSync(join(outside, "notes.ts"), "export const stolen = 1;\n");
    const root = repo({ "src/a.ts": "x\n" });
    symlinkSync(join(outside, "notes.ts"), join(root, "src/link.ts"));
    spawnSync("git", ["add", "-A", "-f"], { cwd: root });
    const r = readRepo(root);
    assert.deepEqual(kept(r), ["src/a.ts"]);
    assert.equal(r!.dropped.link, 1);
  });

  it("drops a file that is a list of people, and masks a stray address in one that isn't", () => {
    const list = ["ann@fastmail.com", "bob@acme.co", "cy@proton.me"].map((e) => `{ email: "${e}" },`).join("\n");
    const r = readRepo(repo({
      "src/customers.ts": `export const rows = [\n${list}\n];\n`,
      "src/Admin.tsx": 'const owner = "founder@acme.co";\nconst demo = "demo@example.com";\nconst x = 1;\n',
      "src/Icon.tsx": 'const src = "icon@2x.png";\n',
    }));
    assert.deepEqual(kept(r), ["src/Admin.tsx", "src/Icon.tsx"]);
    assert.equal(r!.dropped.personal, 1);
    const text = r!.files[0]!.text;
    assert.ok(!text.includes("founder@acme.co"));
    assert.ok(text.includes("someone@example.com") && text.includes("demo@example.com"));
    assert.equal(text.split("\n").length, 4, "same lines as the file, so a quote's line number holds");
  });

  it("drops binary, machine-written and oversized files", () => {
    const r = readRepo(repo({
      "src/ok.ts": "x\n",
      "src/bin.js": "a\0b\n",
      "src/packed.js": `${"x".repeat(5000)}\n`,
      "src/huge.js": `${"const a = 1;\n".repeat(200_000)}`,
    }));
    assert.deepEqual(kept(r), ["src/ok.ts"]);
    assert.deepEqual(r!.dropped, { binary: 1, minified: 1, size: 1 });
  });

  it("isn't a repo: says so rather than walking the disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-norepo-"));
    made.push(dir);
    writeFileSync(join(dir, "a.ts"), "x\n");
    assert.equal(readRepo(dir), undefined);
  });

  it("reads only below the folder it was given", () => {
    const root = repo({ "web/src/a.ts": "x\n", "backend/b.py": "x\n" });
    assert.deepEqual(kept(readRepo(join(root, "web"))), ["src/a.ts"]);
  });

  it("gives the same fingerprint for the same code, and another when it changes", () => {
    const root = repo({ "src/a.ts": "x\n" });
    const first = readRepo(root)!.fingerprint;
    assert.equal(readRepo(root)!.fingerprint, first);
    writeFileSync(join(root, "src/a.ts"), "y\n");
    assert.notEqual(readRepo(root)!.fingerprint, first);
  });

  it("reads a folder once while nothing in it changes, and afresh as soon as a file does", () => {
    const root = repo({ "src/a.ts": "x\n", "src/b.ts": "one\n" });
    const first = readRepo(root)!;
    assert.equal(readRepo(root), first, "the same read, not a new one");
    writeFileSync(join(root, "src/b.ts"), "two\n");
    const edited = readRepo(root)!;
    assert.notEqual(edited, first);
    assert.equal(edited.files.find((f) => f.path === "src/b.ts")!.text, "two\n");
    rmSync(join(root, "src/a.ts"));
    assert.deepEqual(readRepo(root)!.files.map((f) => f.path), ["src/b.ts"]);
  });

  it("names dependencies, not their versions", () => {
    const r = readRepo(repo({ "package.json": '{"dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"7.0.0"}}', "src/a.ts": "x\n" }));
    assert.deepEqual(r!.dependencies, ["react", "vite"]);
  });
});

describe("column names from SQL", () => {
  it("gives names and never a value, a default or a row", () => {
    const root = repo({
      "db/001_trades.sql": `-- trades, see jane@acme.co
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  "symbol" text not null default 'SKU-RED, the best one',
  pnl numeric(12,2),
  note text check (note <> 'secret, value'),
  constraint one unique (id, symbol)
);
insert into trades (symbol) values ('Real Customer');
alter table trades add column if not exists closed_at timestamptz;
`,
      "db/seed.sql": "create table leaked (customer_name text);\n",
      "src/a.ts": "x\n",
    });
    assert.deepEqual(schemaTables(readRepo(root)!), { trades: ["id", "symbol", "pnl", "note", "closed_at"] });
  });
});

describe("telling a copied value", () => {
  const root = repo({
    "src/a.ts": 'const status = "Active";\n',
    "src/lib/sampleData.ts": 'export const who = "Jane Realperson"; const s = "Active";\n',
    "testdata/fills.csv": "name,when\nBob Actualname,2026-01-02\n",
    "secrets.json": '{"who":"Never Opened"}\n',
  });
  const copied = copiedFromData(readRepo(root)!);

  it("catches what only the data files hold", () => {
    assert.equal(copied("Jane Realperson"), true);
    assert.equal(copied("bob actualname"), true);
  });
  it("lets through product words, dates and anything new", () => {
    assert.equal(copied("Active"), false);
    assert.equal(copied("2026-01-02"), false);
    assert.equal(copied("Sample Person 1"), false);
  });
  it("never opens a file named like a secret", () => {
    assert.equal(copied("Never Opened"), false);
  });
});

describe("block comments", () => {
  const at = (text: string, part: string) => inBlockComment(text, text.indexOf(part));

  it("sees a route switched off across lines, in code and in markup", () => {
    assert.equal(at('const a = 1;\n/*\n<Route path="/old" />\n*/\nconst b = 2;\n', "/old"), true);
    assert.equal(at("<div>\n<!--\n<a href='/old'>Old</a>\n-->\n</div>\n", "/old"), true);
    assert.equal(at("<div>\n{/*\n<Old />\n*/}\n</div>\n", "<Old"), true);
    assert.equal(at("/* never closed\n<Old />\n", "<Old"), true);
  });

  it("reads on after a comment closes", () => {
    assert.equal(at("/* gone */\n<Live />\n", "<Live"), false);
    assert.equal(at("<!-- gone -->\n<Live />\n", "<Live"), false);
  });

  it("isn't opened by the same characters in a quote or a line comment", () => {
    assert.equal(at('<input accept="image/*" />\n<Live />\n', "<Live"), false);
    assert.equal(at("const glob = 'src/**/*.ts';\n<Live />\n", "<Live"), false);
    assert.equal(at("const glob = `src/*`;\n<Live />\n", "<Live"), false);
    assert.equal(at("// see /* here\n<Live />\n", "<Live"), false);
    assert.equal(at('const u = "http://a.example/*";\n<Live />\n', "<Live"), false);
    assert.equal(at("<p>Don't /* panic</p>\n<Live />\n", "<Live"), false);
  });
});

describe("files only the repo check reads", () => {
  it("finds translation files, and nothing else that is data", () => {
    const r = readRepo(repo({ "src/App.tsx": "x\n", "messages/en.json": '{"title":"Ledgerly"}\n', "config/locales/fr.yml": "title: Ledgerly\n", "public/locales/de/common.json": "{}\n", "src/en.json": "{}\n", "data/people.json": "{}\n", "package-lock.json": "{}\n", ".env.json": "{}\n" }));
    assert.equal(matchFiles(r!).length, 4);
    assert.ok(!r!.files.some((f) => /\.(?:json|yml)$/.test(f.path)), "wording is never sent");
  });

  it("looks through a page held back for a key, and it stays out of what can be sent", () => {
    const r = readRepo(repo({ "src/App.tsx": "x\n", "index.html": `<title>Ledgerly</title><script>init("${STRIPE}")</script>\n` }));
    assert.deepEqual(kept(r), ["src/App.tsx"]);
    assert.deepEqual(r!.heldBack, ["index.html"]);
    assert.ok(matchFiles(r!).some((f) => f.text.includes("Ledgerly")));
  });

  it("never opens a file named like a secret", () => {
    const r = readRepo(repo({ "src/App.tsx": "x\n", "locales/secrets.json": '{"title":"Ledgerly"}\n', ".env.ts": 'const x = 1;\n' }));
    assert.deepEqual(matchFiles(r!), []);
  });
});

describe("personal shapes", () => {
  it("catches contacts and cards, and leaves dates and example addresses", () => {
    for (const v of ["ann@fastmail.com", "write to bob@acme.co today", "+44 20 7946 0958", "4242 4242 4242 4242", "4242424242424242"]) assert.equal(personalShaped(v), true, v);
    for (const v of ["person1@example.com", "Sample Person 1", "2026-01-02", "2026-01-02 10:00", "SKU-RED", "1200.50"]) assert.equal(personalShaped(v), false, v);
    for (const v of ["Call Jane on 415-555-2671 about the overdue balance", "Ring (415) 555-2671 today", "Reach her on 415.555.2671.", "Her desk is 020 7946 0958", "Mobile 07700 900123, evenings", "DOB 04/12/1981, SSN 234-56-7890"]) assert.equal(personalShaped(v), true, v);
    for (const v of ["Call Jane on 415 555 2671", "Mobile: 4155552671", "Tel 01 23 45 67 89", "Tel 01.23.45.67.89", "Jane +91 98765 43210", "Tel +33 1 23 45 67 89", "Jane 612 345 678", "2026-11-06 415 555 2671"]) assert.equal(personalShaped(v), true, v);
    for (const v of ["Seen 15.01.2026 12:30 today", "Paid 1/15/2026 14:05", "2026-11-06 12:30 by Sam", "Ref 12345678 is open", "Trace 1234567890123456789 ended"]) assert.equal(personalShaped(v), false, v);
    for (const v of ["Ordered 2026-11-06 at 10:30", "Build 10.0.22631 is out", "Server 192.168.100.200 is up", "You owe $12,400.00 this month", "1,234,567 rows so far", "Open 10:30-11:45 on weekdays", "Order 100-200 shipped", "Version 1.2.3-rc.4", "Invoice INV-2024-0001 is due", "Pages 120-145 of 300", "0 of 12 steps done"]) assert.equal(personalShaped(v), false, v);
  });
});

describe("cutting a file to fit", () => {
  const big = [
    "// nine sections, says this comment, which is stale",
    ...Array.from({ length: 4000 }, (_, i) => `const filler${i} = compute(${i});`),
    "<button onClick={save}>Save trade</button>",
    ...Array.from({ length: 4000 }, (_, i) => `const more${i} = compute(${i});`),
    "await supabase.from('trades').delete().eq('id', id);",
  ].join("\n");

  it("keeps what a person reads and what a press does, and drops comments and filler", () => {
    const out = reduce(big, 2000);
    assert.ok(out.includes("Save trade") && out.includes(".delete()"));
    assert.ok(!out.includes("nine sections") && !out.includes("filler1 "));
    assert.ok(Buffer.byteLength(out) <= 2100);
  });

  it("gives a small file all it needs, and says what it cut", () => {
    const { sent, cut } = fit([{ path: "big.tsx", text: big, bytes: big.length }, { path: "small.ts", text: "tiny\n", bytes: 5 }], 3000);
    assert.equal(sent[0]!.path, "big.tsx", "in the order asked for");
    assert.equal(sent[1]!.sent, "tiny\n");
    assert.equal(cut.length, 1);
    assert.equal(cut[0]!.file, "big.tsx");
    assert.equal(cut[0]!.ofBytes, Buffer.byteLength(big));
    assert.ok(cut[0]!.sentBytes <= 3000);
  });
});

describe("what an app really runs", () => {
  const file = (path: string, text = "") => ({ path, text });
  it("follows what its entries load, and leaves a mock beside them out", () => {
    const shipped = shippedFiles([
      file("index.html", `<script type="module" src="/src/main.tsx"></script>`),
      file("src/main.tsx", `import App from "./App";\nimport "./styles.css";`),
      file("src/App.tsx", `const Lazy = lazy(() => import("./pages/Lazy"));\nexport * from '@/lib/thing';`),
      file("src/pages/Lazy.tsx"),
      file("src/styles.css", `@import "./tokens.css";`),
      file("src/tokens.css"),
      file("src/lib/thing/index.ts"),
      file("lab/mock.html", `<script src="./mock.js"></script>`),
      file("lab/mock.js"),
    ]);
    assert.deepEqual([...shipped!].sort(), ["index.html", "src/App.tsx", "src/lib/thing/index.ts", "src/main.tsx", "src/pages/Lazy.tsx", "src/styles.css", "src/tokens.css"]);
  });
  it("starts from a server's and a host's folders too", () => {
    const shipped = shippedFiles([file("api/orders.ts", `import { x } from "../lib/x";`), file("lib/x.ts"), file("stale/old.ts")]);
    assert.deepEqual([...shipped!].sort(), ["api/orders.ts", "lib/x.ts"]);
  });
  it("follows a file held back from sending, whose imports are all that's read of it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-ship-"));
    writeFileSync(join(dir, "App.tsx"), `import { Shell } from "./src/Shell";\nconst key = "held";`);
    const files = [{ path: "index.html", text: `<script src="/App.tsx"></script>`, bytes: 0 }, { path: "src/Shell.tsx", text: "", bytes: 0 }];
    assert.equal(shippedIn({ files, root: dir, heldBack: [] }), undefined);
    assert.deepEqual([...shippedIn({ files, root: dir, heldBack: ["App.tsx"] })!].sort(), ["App.tsx", "index.html", "src/Shell.tsx"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("says nothing when no entry can be told, or nothing follows from one", () => {
    assert.equal(shippedFiles([file("a.ts", `import "./b";`), file("b.ts")]), undefined);
    assert.equal(shippedFiles([file("index.html", "<h1>Hi</h1>"), file("a.js")]), undefined);
  });
});
