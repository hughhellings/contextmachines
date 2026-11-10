// The Action's comment, its escaping and its one-comment rule, checked against a stand-in GitHub
// API and a stand-in learner (no browser, no network):
//   node --test action/run.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { redact as cliRedact } from "../cli/report.ts";
import { cell, code, diffBlocks, fit, hasChanged, issueLine, learnedBlocks, learnerEnv, learnFailure, marker, redact, upsertComment, type Comparison, type Finding } from "./run.ts";

const none: Comparison = { screensAdded: [], screensGone: [], actionsAdded: [], actionsGone: [], actionsRenamed: [], actionsMoved: [], mainAction: null, journeysChanged: [], issuesNew: [], issuesFixed: [] };
const foot = { version: "0.1.0", seconds: 134, url: "https://pr-12.preview.example/", photos: "https://github.com/o/r/actions/runs/1#artifacts" };
const broken: Finding = { kind: "request_fails", screen: "/reports", target: "GET /api/stats", evidence: "500", count: 2 };

describe("site text in markdown", () => {
  it("never pings, links an issue or links a site", () => {
    for (const live of ["@everyone", "@octocat/team", "#1", "fixes#12", "GH-7", "https://evil.example", "www.evil.example", "me@mail.example"]) {
      const out = cell(`see ${live} now`);
      assert.match(out, new RegExp(`\`${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``), `${live} should be code: ${out}`);
    }
    // An entity is no way round it.
    assert.equal(cell("&#64;everyone"), "`&#64;everyone`");
    assert.equal(cell("&#x40;everyone"), "&amp;\\#x40;everyone");
  });
  it("can't open HTML, formatting, links or a table", () => {
    assert.equal(cell("<details><summary>x"), "&lt;details&gt;&lt;summary&gt;x");
    assert.equal(cell("**bold** _it_ [a](b) ~~s~~ |c| !x"), "\\*\\*bold\\*\\* \\_it\\_ \\[a\\]\\(b\\) \\~\\~s\\~\\~ \\|c\\| \\!x");
    assert.equal(cell("# Heading"), "\\# Heading");
    assert.equal(cell("1. first"), "1\\. first");
  });
  it("stays on one line, without hidden characters, and short", () => {
    assert.equal(cell("Save\nnow\r\n- item"), "Save now \\- item");
    assert.equal(cell("pay\u202Eexe.png\u001b[31m"), "pay exe.png \\[31m");
    const long = cell("x".repeat(500), 300);
    assert.equal([...long].length, 300);
    assert.ok(long.endsWith("…"));
  });
  it("keeps backticks inside code", () => {
    assert.equal(code("/a`b"), "``/a`b``");
    assert.equal(code("`x`"), "`` `x` ``");
    assert.equal(code("/@admin"), "`/@admin`");
  });
  it("words an issue the way the CLI does, every part escaped", () => {
    assert.equal(issueLine(broken), "`GET /api/stats` failed on `/reports` (500, seen 2 times)");
    assert.equal(issueLine({ kind: "does_nothing", screen: "/", target: "Ping @everyone", evidence: "", count: 1 }), '"Ping `@everyone`" does nothing when pressed on `/`');
    assert.equal(issueLine({ kind: "crashes", screen: "/", target: "x is undefined", evidence: "https://cdn.example/app.js", after: "Save", count: 1 }), 'Script error: x is undefined on `/` (in `https://cdn.example/app.js`, after pressing "Save")');
  });
});

describe("the comment", () => {
  it("says there is no change, in green, when nothing differs", () => {
    const body = fit(diffBlocks(none, foot));
    assert.match(body, /^### 🟢 Context Machines: no change to the product\n/);
    assert.equal(hasChanged(none), false);
  });
  it("leads with a verdict and counts, shows new issues and folds the rest", () => {
    const c: Comparison = { ...none, screensAdded: ["/a", "/b"], actionsGone: [{ name: "Delete", request: "DELETE /api/x" }], issuesNew: [broken], issuesFixed: [{ ...broken, screen: "/old" }] };
    const body = fit(diffBlocks(c, foot));
    assert.equal(body.split("\n")[0], "### 🔴 Context Machines: 1 new issue · 2 screens added · 1 action gone · 1 issue fixed");
    assert.match(body, /\*\*New issues\*\*, each seen happening:\n\n- 🐞 `GET \/api\/stats` failed on `\/reports`/);
    assert.ok(body.indexOf("🐞") < body.indexOf("<details>"), "new issues are never folded");
    assert.match(body, /<details><summary>What this change does to the product \(3\)<\/summary>\n\n- ➕ New screen `\/a`/);
    assert.match(body, /<details><summary>Issues fixed \(1\)<\/summary>/);
    assert.match(body, /<sub>\[Context Machines\]\(https:\/\/github.com\/hughhellings\/contextmachines\) 0\.1\.0 · 2m 14s · `https:\/\/pr-12\.preview\.example\/` · \[screen photos\]\(https:\/\/github.com\/o\/r\/actions\/runs\/1#artifacts\)<\/sub>$/);
  });
  it("folds predictions apart from issues, never in the headline or the verdict", () => {
    const guess = { kind: "unclear_button", screen: "/reports", target: "@team Submit", why: "It may be unclear which save it is." };
    const c: Comparison = { ...none, predictionsNew: [guess], predictionsGone: [{ ...guess, screen: "/old" }] };
    const body = fit(diffBlocks(c, foot));
    assert.match(body, /^### 🟢 Context Machines: no change to the product\n/);
    assert.match(body, /<details><summary>Might trip people up: predictions, not proven \(2\)<\/summary>\n\n- ❔ `\/reports`: `@team` Submit: It may be unclear/);
    assert.match(body, /- ➖ no longer predicted: `\/old`/);
    assert.equal(hasChanged(c), false);
  });
  it("is green when the product changed but nothing broke", () => {
    assert.match(fit(diffBlocks({ ...none, screensGone: ["/x"] }, foot)), /^### 🟢 Context Machines: 1 screen gone/);
  });
  it("ignores fields it doesn't know when deciding whether anything changed", () => {
    assert.equal(hasChanged({ ...none, schemaVersion: "diff-1" } as Comparison), false);
  });
  it("shows 30 of a long list and says where the rest are", () => {
    const body = fit(diffBlocks({ ...none, screensAdded: Array.from({ length: 45 }, (_, i) => `/s${i}`) }, foot));
    assert.equal((body.match(/New screen/g) ?? []).length, 30);
    assert.match(body, /- …and 15 more in the job summary/);
  });
  it("stays under GitHub's limit by dropping folded parts, never the new issues", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...broken, screen: `/${"p".repeat(250)}${i}` }));
    const c: Comparison = { ...none, issuesNew: many, issuesFixed: many, actionsAdded: many.map((f) => ({ name: "n".repeat(300), request: f.screen })) };
    const body = fit(diffBlocks(c, foot), 20_000);
    assert.ok(body.length <= 20_000, `${body.length}`);
    assert.equal((body.match(/🐞/g) ?? []).length, 30);
    assert.doesNotMatch(body, /Issues fixed/);
    assert.match(body, /Cut short to fit a comment; the full comparison is in the job summary/);
    assert.match(body, /<\/sub>$/);
  });
  it("doesn't count what a made-up user saw as the product", () => {
    const body = fit(learnedBlocks({ url: "http://localhost:3000", product: null, mainAction: null, screens: [{}, { seenWith: "stand-in" }, { seenWith: "stand-in" }], actions: [{ kind: "create" }, { kind: "create", seenWith: "stand-in" }], findings: [] }, foot));
    assert.match(body, /1 screen · 1 action/);
  });

  it("without a base, describes the product and points to base-url", () => {
    const map = { url: "https://x.example/", product: "Invoices for @everyone. <b>Free</b>", mainAction: { label: "Save invoice" }, screens: [1, 2], actions: [{ kind: "create" }, { kind: "read" }], findings: [broken] };
    const body = fit(learnedBlocks(map, foot));
    assert.match(body, /^### 🔴 Context Machines: 1 issue · 2 screens · 1 action\n/);
    assert.match(body, /Invoices for `@everyone\.` &lt;b&gt;Free&lt;\/b&gt;/);
    assert.match(body, /Set `base-url`/);
  });
});

describe("the learner's surroundings", () => {
  it("never hands the learner a GitHub credential", () => {
    const env = learnerEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t", GH_TOKEN: "t", INPUT_GITHUB_TOKEN: "t", CONTEXTMACHINES_GITHUB_TOKEN: "t", ACTIONS_RUNTIME_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: "u" });
    assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "PATH"]);
  });
  it("tells a refused input from a site that's down", () => {
    assert.match(learnFailure(2, "https://x"), /refused its inputs/);
    assert.match(learnFailure(3, "https://x"), /couldn't reach or read https:\/\/x/);
    assert.match(learnFailure(1, "https://x"), /\(exit 1\)/);
  });
  it("shows an address without the secrets that get into a protected preview", () => {
    assert.equal(redact("https://admin:hunter2@pr-12-app.vercel.app/?x-vercel-protection-bypass=SECRET123"), "https://pr-12-app.vercel.app/?x-vercel-protection-bypass=REDACTED");
    assert.equal(redact("https://app.example/?token=abc&tab=2&x-vercel-set-bypass-cookie=true"), "https://app.example/?token=REDACTED&tab=2&x-vercel-set-bypass-cookie=true");
    assert.equal(redact("https://app.example/invoices?page=2"), "https://app.example/invoices?page=2");
    // The copy and the CLI's own rule (which writes map.json and PRODUCT.md) must say the same.
    for (const url of ["https://u:p@h.example/a?sig=x1&q=hello", "https://h.example/?keyword=shoes&api_key=k", "https://h.example/#access_token=eyJhbGciOiJIUzI1NiJ9abc&state=s", "https://h.example/?id=8f14e45fceea167a5a36dedd4bea2543", "http://localhost:3000/"]) {
      assert.equal(redact(url), cliRedact(url), url);
    }
  });
  it("says the same as the CLI on every form a secret takes in free text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const forms = [
      `Error: config failed: Authorization: Bearer ${jwt}`, "got Bearer abc123def456ghi", "Authorization: Basic dXNlcjpwYXNz", "sent Basic dXNlcjpwYXNz", `cookie ${jwt}`,
      "db connect failed password=hunter2 api_key: sk_live_EXAMPLE-NOT-A-KEY", '{"password":"two words","client_secret": "x"}', "X-Auth-Token: 12345", "x-api-key: abc",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "xoxb-1234567890-abcdefghij", "AKIAIOSFODNN7EXAMPLE", "sk-proj-abcdefghijklmnopqrstuv",
      "https://app.example/invite/INVITETOKENabc123def456", "postgres://user:pass@db.example/x",
      "Unauthorized for token 8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b", "Rejected dGhpc2lzYXNlY3JldHRva2VuMTIzNDU2Nzg5",
      "TypeError: Cannot read properties of undefined (reading 'token')", "Error code: 500", "token: undefined", "Password: required", "Basic Settings", "Bearer of bad news",
      "failed in main.8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d.js", "Uint8ClampedArray2Float64Converter is not a function", "MuiGrid-grid-xs-12-sm-6-md-4-lg-3",
    ];
    for (const text of forms) assert.equal(redact(text), cliRedact(text), text);
    assert.doesNotMatch(forms.slice(0, 13).map(redact).join("\n"), /eyJhbGci|hunter2|sk_live|two words|12345|ghp_|xoxb|AKIA|sk-proj|dXNlcjpwYXNz/);
    assert.equal(redact(forms[15]!), "Unauthorized for token REDACTED");
    assert.equal(redact(forms[16]!), "Rejected REDACTED");
    assert.equal(redact("failed in main.8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d.js"), "failed in main.8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d.js");
  });
  it("uses the same rules as the CLI, word for word", () => {
    const rules = (file: string) => (readFileSync(new URL(file, import.meta.url), "utf8").match(/^const (SECRET_NAME|SWITCH|TOKEN_LIKE|OPAQUE_SEGMENT|SECRET_LABEL|NOT_A_SECRET|KNOWN_KEY|LONG_HEX|OPAQUE_RUN) = .*$/gm) ?? []).sort();
    assert.equal(rules("./run.ts").length, 9);
    assert.deepEqual(rules("./run.ts"), rules("../cli/report.ts"));
  });
  it("takes a secret out of a script error, through to the comment and the summary", () => {
    const crash: Finding = { kind: "crashes", screen: "/", target: "Error: db connect failed password=hunter2 api_key: sk_live_EXAMPLE-NOT-A-KEY", evidence: "https://app.example/app.js?token=abc123", count: 1 };
    const body = fit(diffBlocks({ ...none, issuesNew: [crash] }, { version: "1", seconds: 1, url: "https://app.example" }));
    assert.doesNotMatch(body, /hunter2|sk\\?_live|abc123/);
    assert.match(body, /Script error/);
  });
  it("keeps what one run saw and the other didn't out of the verdict and `changed`", () => {
    const seen = { screens: ["/links"], actions: [{ name: "Save", request: "POST /s" }], issues: [] };
    const c: Comparison = { ...none, seenOnlyNow: seen, seenOnlyBefore: { screens: ["/old"], actions: [], issues: [] } };
    assert.equal(hasChanged(c), false);
    const body = fit(diffBlocks(c, { version: "1", seconds: 1, url: "https://app.example" }));
    assert.match(body, /🟢 Context Machines: no change to the product/);
    assert.match(body, /the same in what both runs saw/);
    assert.match(body, /Seen in only one run: a run stopped at a limit, so not a change \(3\)/);
    assert.match(body, /`\/links`: seen only in this run/);
    assert.match(body, /`\/old`: seen only in the earlier run/);
    assert.doesNotMatch(body, /New screen|Screen gone/);
  });
  it("marks its comment with the workflow, job and key, safely", () => {
    assert.equal(marker("PR checks", "product", "shop"), "<!-- contextmachines kind=diff workflow=PR%20checks job=product key=shop -->");
    assert.doesNotMatch(marker("a-->b", "j", ""), /-->b/);
  });
});

// A stand-in for GitHub's REST API: comments in memory, and a switch for each way GitHub says no.
interface Comment { id: number; body: string; user: { login: string; type: string } }
const gh = {
  comments: [] as Comment[],
  /** /user: a login, or 403 as the workflow's own token gets. */
  user: 403 as 403 | 401 | string,
  /** A status to answer the comment list, or the post or update, with instead. */
  failList: 0,
  failWrite: 0,
  rateLimited: false,
  requests: [] as string[],
};
let api = "";
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = new URL(req.url!, api);
  gh.requests.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  assert.equal(req.headers.authorization, "Bearer secret-token");
  if (url.pathname === "/user") {
    if (typeof gh.user === "string") return send(200, { login: gh.user });
    return send(gh.user, { message: gh.user === 403 ? "Resource not accessible by integration" : "Bad credentials" });
  }
  const list = url.pathname.match(/^\/repos\/o\/r\/issues\/7\/comments$/);
  if (list && req.method === "GET") {
    if (gh.failList) return send(gh.failList, { message: "no" }, gh.rateLimited ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } : {});
    // Two to a page, so paging is exercised.
    const page = Number(url.searchParams.get("page") ?? "1");
    const next: Record<string, string> = page * 2 < gh.comments.length ? { link: `<${api}/repos/o/r/issues/7/comments?per_page=100&page=${page + 1}>; rel="next"` } : {};
    return send(200, gh.comments.slice((page - 1) * 2, page * 2), next);
  }
  if (gh.failWrite) return send(gh.failWrite, { message: "no" }, gh.rateLimited ? { "x-ratelimit-remaining": "0" } : {});
  const body = (JSON.parse(Buffer.concat(chunks).toString()) as { body: string }).body;
  if (list && req.method === "POST") {
    const user = typeof gh.user === "string" ? { login: gh.user, type: "User" } : { login: "github-actions[bot]", type: "Bot" };
    const c = { id: 100 + gh.comments.length, body, user };
    gh.comments.push(c);
    return send(201, c);
  }
  const one = url.pathname.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/);
  if (one && req.method === "PATCH") {
    const c = gh.comments.find((x) => x.id === Number(one[1]))!;
    c.body = body;
    return send(200, c);
  }
  send(404, { message: "Not Found" });
});
before(async () => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  api = `http://127.0.0.1:${address.port}`;
});
after(() => server.close());

const MARK = marker("PR", "product", "");
function reset(comments: Comment[] = []) {
  Object.assign(gh, { comments, user: 403, failList: 0, failWrite: 0, rateLimited: false, requests: [] });
}
async function upsert(body: string) {
  const warnings: string[] = [];
  const done = await upsertComment({ api, repo: "o/r", pr: 7, token: "secret-token", marker: MARK, body, warn: (m) => warnings.push(m) });
  return { done, warnings };
}

describe("one comment per pull request", () => {
  it("posts, then updates the same comment on the next push", async () => {
    reset([{ id: 1, body: "Looks good", user: { login: "alice", type: "User" } }]);
    assert.deepEqual(await upsert("first"), { done: "posted", warnings: [] });
    assert.deepEqual(await upsert("second"), { done: "updated", warnings: [] });
    assert.equal(gh.comments.length, 2);
    assert.equal(gh.comments[1]!.body, `${MARK}\nsecond`);
  });
  it("leaves a person's comment with our marker alone, and one with it lower down", async () => {
    const foreign = { id: 5, body: `${MARK}\nfake`, user: { login: "mallory", type: "User" } };
    const quoted = { id: 6, body: `> earlier\n${MARK}\nquoted`, user: { login: "github-actions[bot]", type: "Bot" } };
    reset([foreign, quoted]);
    assert.equal((await upsert("ours")).done, "posted");
    assert.equal(foreign.body, `${MARK}\nfake`);
    assert.equal(quoted.body, `> earlier\n${MARK}\nquoted`);
  });
  it("matches by login when the token can say who it is", async () => {
    const bots = { id: 5, body: `${MARK}\nbot's`, user: { login: "github-actions[bot]", type: "Bot" } };
    reset([bots]);
    gh.user = "release-bot-user";
    assert.equal((await upsert("mine")).done, "posted");
    assert.equal(bots.body, `${MARK}\nbot's`);
    assert.equal((await upsert("mine again")).done, "updated");
  });
  it("finds its comment on a later page", async () => {
    const people = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, body: `hi ${i}`, user: { login: "alice", type: "User" } }));
    reset([...people, { id: 50, body: `${MARK}\nold`, user: { login: "github-actions[bot]", type: "Bot" } }]);
    assert.equal((await upsert("new")).done, "updated");
    assert.ok(gh.requests.some((r) => r.includes("page=3")));
  });
  it("posts nothing when it can't read the comments (no duplicate), and only warns", async () => {
    reset([{ id: 9, body: `${MARK}\nold`, user: { login: "github-actions[bot]", type: "Bot" } }]);
    gh.failList = 500;
    const { done, warnings } = await upsert("new");
    assert.equal(done, "skipped");
    assert.ok(!gh.requests.some((r) => r.startsWith("POST")));
    assert.match(warnings[0]!, /GitHub answered 500 while reading the pull request's comments\. The result is in the job summary\./);
  });
  it("explains a missing permission or a fork (403)", async () => {
    reset();
    gh.failWrite = 403;
    const { done, warnings } = await upsert("x");
    assert.equal(done, "skipped");
    assert.match(warnings[0]!, /pull-requests: write.*fork/);
  });
  it("explains a rate limit apart from a permission", async () => {
    reset();
    gh.failList = 403;
    gh.rateLimited = true;
    assert.match((await upsert("x")).warnings[0]!, /rate limit .*\(403\) until \d\d:\d\d UTC/);
    reset();
    gh.failWrite = 429;
    assert.match((await upsert("x")).warnings[0]!, /rate limit .*\(429\)/);
  });
  it("explains a token GitHub doesn't accept (401)", async () => {
    reset();
    gh.user = 401;
    const { done, warnings } = await upsert("x");
    assert.equal(done, "skipped");
    assert.match(warnings[0]!, /didn't accept the token .*\(401\)\. Check the github-token input/);
  });
  it("warns, without throwing, when GitHub can't be reached", async () => {
    const warnings: string[] = [];
    const done = await upsertComment({ api: "http://127.0.0.1:1", repo: "o/r", pr: 7, token: "t", marker: MARK, body: "x", warn: (m) => warnings.push(m) });
    assert.equal(done, "skipped");
    assert.match(warnings[0]!, /couldn't reach GitHub/);
  });
});

// The whole Action, with a stand-in learner in place of the published package.
describe("a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-action-"));
  const learner = join(dir, "learner.mjs");
  // Learns by writing a map; records whether it could see a GitHub credential; "down" sites exit 3 as the CLI does.
  writeFileSync(learner, `
import { mkdirSync, writeFileSync } from "node:fs";
const [cmd, target, , out] = process.argv.slice(2);
if (cmd === "learn") {
  if (target.includes("down")) { console.error("site down"); process.exit(3); }
  mkdirSync(out, { recursive: true });
  writeFileSync(out + "/saw-token", String(Boolean(process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || process.env.GH_TOKEN)));
  console.log("::warning::from the site");
  writeFileSync(out + "/map.json", JSON.stringify({ url: target, product: null, mainAction: null, screens: [], actions: [], findings: target.includes("after") ? [{ kind: "does_nothing", screen: "/", target: "@everyone", evidence: "", count: 1 }] : [] }));
} else {
  console.log(JSON.stringify({ schemaVersion: "diff-1", screensAdded: [], screensGone: [], actionsAdded: [], actionsGone: [], actionsRenamed: [], actionsMoved: [], mainAction: null, journeysChanged: [], issuesNew: [{ kind: "does_nothing", screen: "/", target: "@everyone", evidence: "", count: 1 }], issuesFixed: [] }));
}
`);
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
  // Not spawnSync: the stand-in GitHub API answers from this process, so it must keep running.
  const action = async (extra: Record<string, string>) => {
    const output = join(dir, `out-${Math.random()}`);
    const summary = join(dir, `summary-${Math.random()}`);
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, INPUT_CLI: learner, INPUT_WORK_DIR: join(dir, `work-${Math.random()}`), INPUT_GITHUB_TOKEN: "secret-token", GITHUB_TOKEN: "secret-token", GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: api, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_WORKFLOW: "PR", GITHUB_JOB: "product", GITHUB_RUN_ID: "42", ...extra },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const status = await new Promise<number | null>((done) => child.on("close", done));
    return { status, stdout, stderr, outputs: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
  };

  it("compares, comments, and says how many new issues, with the token kept from the learner", async () => {
    reset();
    const r = await action({ INPUT_URL: "https://after.example", INPUT_BASE_URL: "https://before.example" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const work = r.outputs.match(/^work-dir=(.*)$/m)![1]!;
    assert.equal(readFileSync(join(work, "after", "saw-token"), "utf8"), "false");
    assert.match(r.outputs, /^changed=true$/m);
    assert.match(r.outputs, /^issues=1$/m);
    assert.match(r.summary, /^### 🔴 Context Machines: 1 new issue/);
    assert.equal(gh.comments.length, 1);
    assert.match(gh.comments[0]!.body, /^<!-- contextmachines kind=diff workflow=PR job=product key= -->\n### 🔴/);
    assert.match(gh.comments[0]!.body, /"`@everyone`" does nothing/);
    assert.match(gh.comments[0]!.body, /\[screen photos\]\(https:\/\/github.com\/o\/r\/actions\/runs\/42#artifacts\)/);
    // What the site printed can't act as a workflow command.
    assert.match(r.stdout, /::stop-commands::([0-9a-f-]{36})\n[^]*::warning::from the site\n[^]*::\1::/);
  });
  it("fails the job on new issues only when asked, after commenting", async () => {
    reset();
    const r = await action({ INPUT_URL: "https://after.example", INPUT_BASE_URL: "https://before.example", INPUT_FAIL_ON_NEW_ISSUES: "true" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::Context Machines found 1 new issue \(fail-on-new-issues is on\)/);
    assert.equal(gh.comments.length, 1);
  });
  it("never fails the job because it couldn't comment", async () => {
    reset();
    gh.failWrite = 403;
    const r = await action({ INPUT_URL: "https://after.example" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::warning::GitHub didn't allow commenting on the pull request \(403\)/);
  });
  it("passes on the CLI's exit code with words for it", async () => {
    const r = await action({ INPUT_URL: "https://down.example" });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /::error::Context Machines couldn't reach or read https:\/\/down\.example \(exit 3\)/);
    assert.match(r.outputs, /^work-dir=/m);
  });
  it("never publishes the credentials or bypass token in the address it was given", async () => {
    reset();
    const secret = "https://admin:hunter2@pr-12-after.example/?x-vercel-protection-bypass=SECRET123";
    const r = await action({ INPUT_URL: secret, INPUT_BASE_URL: "https://before.example/?token=base-secret" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const everything = [gh.comments[0]!.body, r.summary, r.stdout, r.stderr].join("\n");
    for (const leak of ["admin", "hunter2", "SECRET123", "base-secret"]) assert.ok(!everything.includes(leak), `${leak} was published`);
    assert.match(gh.comments[0]!.body, /`https:\/\/pr-12-after\.example\/\?x-vercel-protection-bypass=REDACTED`/);
    assert.match(r.summary, /`https:\/\/pr-12-after\.example\/\?x-vercel-protection-bypass=REDACTED`/);
    assert.match(r.stdout, /::group::Learning https:\/\/pr-12-after\.example\/\?x-vercel-protection-bypass=REDACTED\n/);
    // The learner itself still gets the address as given: it needs the secret to get in.
    const work = r.outputs.match(/^work-dir=(.*)$/m)![1]!;
    assert.equal(JSON.parse(readFileSync(join(work, "after", "map.json"), "utf8")).url, secret);
  });
  it("names a site that's down without its secrets", async () => {
    const r = await action({ INPUT_URL: "https://admin:hunter2@down.example/?token=SECRET123" });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /::error::Context Machines couldn't reach or read https:\/\/down\.example\/\?token=REDACTED \(exit 3\)/);
    assert.ok(!/hunter2|SECRET123/.test(r.stdout), r.stdout);
  });
  it("refuses a missing url or a key it can't use, as a wrong input", async () => {
    assert.equal((await action({})).status, 2);
    const r = await action({ INPUT_URL: "https://after.example", INPUT_KEY: "a b" });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /`key` may hold letters/);
  });
});
