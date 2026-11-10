// A whole run past a sign-in, through the real command: a real browser, a local app that records
// every request it gets, a real git folder, and a scripted AI on this machine.
//   node --test cli/learn-wall.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { standInApp, type StandInApp } from "../packages/scanner/test/stand-in-app.ts";

const cli = fileURLToPath(new URL("./contextmachines.ts", import.meta.url));
const browser = existsSync(chromium.executablePath());

const APP = `export function Routes() {
  const title = "Ledger";
  switch (page) {
    case "/pricing": return <Pricing title={title} />;
    case "/trades": return <Trades title={title} />;
    case "/notes": return <Notes />;
    case "/admin": return <Admin />;
  }
}
`;
const TRADES = `export function Trades() {
  const save = () => supabase.from("trades").insert({ symbol, size });
  return <main><h1>All your trades</h1><button onClick={save}>Add trade</button></main>;
}
`;

/** Answers by which question it is, and writes down everything it was asked. */
function scriptedAi(asked: string[]) {
  const answer = (system: string, question: string): object => {
    if (system.includes("find where its screens are decided")) return { files: ["src/App.tsx"] };
    if (system.includes("to list its screens")) {
      const route = (path: string, name: string, access: string, quote: string, files: string[]) => ({ path, name, access, redirectsTo: null, file: "src/App.tsx", quote, files });
      return { routes: [route("/pricing", "Pricing", "public", `case "/pricing": return <Pricing title={title} />;`, []), route("/trades", "Trades", "signed-in", `case "/trades": return <Trades title={title} />;`, ["src/Trades.tsx"]), route("/notes", "Notes", "signed-in", `case "/notes": return <Notes />;`, ["src/Notes.tsx"]), route("/admin", "Admin", "staff", `case "/admin": return <Admin />;`, ["src/Admin.tsx"])] };
    }
    if (system.includes("reading one screen")) {
      if (!question.includes("Screen: /trades")) return { live: true, title: null, purpose: null, buttons: [], fields: [], writes: [], data: [] };
      return {
        live: true,
        title: { text: "All your trades", file: "src/Trades.tsx", quote: "<h1>All your trades</h1>" },
        purpose: null,
        buttons: [{ label: "Add trade", file: "src/Trades.tsx", quote: "<button onClick={save}>Add trade</button>" }],
        fields: [],
        writes: [{ label: "Add trade", does: "Adds a trade to the list.", rule: null, file: "src/Trades.tsx", quote: `supabase.from("trades").insert({ symbol, size })` }],
        data: [{ kind: "table", name: "trades", shape: "list", columns: ["id", "symbol"], file: "src/Trades.tsx", quote: `supabase.from("trades").insert({ symbol, size })` }],
      };
    }
    if (system.includes("You review a web product")) {
      // One quote of a made-up row, one of a number on a made-up screen: neither may survive.
      const screen = question.match(/^\[(s\d+)\] \/trades.*made-up data/m)?.[1] ?? "s1";
      const item = (words: string) => ({ problem: "wait_for_value", screen, title: "The value waits behind this", fix: "Show something sooner", quotes: [{ screen, words }], code: [] });
      return { items: [item("SAMPLE-ROW-ONE is on show"), item("(made-up row)"), item("Only 12 more to go")] };
    }
    if (system.includes("what a web product is for")) return { product: "A place to keep your trades.", mainAction: { label: "Add trade", why: "It is the point." }, journeys: [] };
    if (system.includes("inventing sample records")) return { samples: [{ name: "trades", rows: [["00000000-0000-4000-8000-00000000000a", "SAMPLE-ROW-ONE"], ["00000000-0000-4000-8000-00000000000b", "SAMPLE-ROW-TWO"]] }] };
    return {};
  };
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { messages } = JSON.parse(body) as { messages: { content: string }[] };
      asked.push(`${messages[0]!.content}\n${messages[1]!.content}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(messages[0]!.content, messages[1]!.content)) } }] }));
    });
  });
}

describe("a run that meets a sign-in", { skip: browser ? false : "no browser installed" }, () => {
  let app: StandInApp;
  let ai: Server;
  let dir: string;
  const asked: string[] = [];

  const learn = (out: string, ...args: string[]) =>
    new Promise<{ code: number | null; text: string; map: Record<string, any> }>((done) => {
      const { CI: _ci, ANTHROPIC_API_KEY: _key, ...env } = process.env;
      const base = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;
      const child = spawn(process.execPath, [cli, "learn", app.url, "--out", join(dir, out), "--minutes", "1", "--pages", "8", "--ai", "openai-compatible", "--model", "scripted", ...args], { cwd: dir, env: { ...env, OPENAI_BASE_URL: base, OPENAI_API_KEY: "local", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", (code) => done({ code, text, map: JSON.parse(readFileSync(join(dir, out, "map.json"), "utf8")) as Record<string, any> }));
    });

  before(async () => {
    app = await standInApp();
    ai = scriptedAi(asked);
    await new Promise<void>((done) => ai.listen(0, "127.0.0.1", done));
    dir = mkdtempSync(join(tmpdir(), "cm-wall-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/App.tsx"), APP);
    writeFileSync(join(dir, "src/Trades.tsx"), TRADES);
    writeFileSync(join(dir, "src/Notes.tsx"), `export const limit = plan === "free" ? 3 : 100;\nexport const Notes = () => <h1>Notes</h1>;\n`);
    writeFileSync(join(dir, "src/Admin.tsx"), `export const Admin = () => <h1>Admin</h1>;\n`);
    writeFileSync(join(dir, ".env"), "SECRET_THING=do-not-send-this\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "src"], { cwd: dir });
  });
  after(async () => {
    await app.close();
    ai.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no yes, sends no code, and still gets past on a stand-in user with no flags", { timeout: 120_000 }, async () => {
    asked.length = 0;
    const { code, map, text } = await learn("first");
    assert.equal(code, 0, text);
    assert.match(text, /^❯ \[new user\] started$/m);
    assert.match(text, /^[✓!] \[new user\] /m);
    assert.equal(map.fromCode, undefined);
    assert.equal(map.learner.codeRead, undefined);
    assert.ok(!asked.some((q) => q.includes("source code")), "no question about code");
    // An address only the source spells is the source's: it goes nowhere without the yes.
    assert.deepEqual((map.newUser?.screens ?? []).filter((s: { path: string }) => /trades|notes/.test(s.path)), []);
    assert.ok(!asked.some((q) => /^\[s\d+\] \/(?:trades|notes)/m.test(q)), "no screen reached by a route in the source");
    // Nothing named the addresses, and this app's front page has no way in.
    assert.equal(map.learner.standIn.status, "not_rendered");
    assert.equal(map.learner.wallOffer, "add-code");
    assert.match(text, /→ To have your AI read what's behind the sign-in:[^]*--code/);
  });

  it("with --code, reads the code, walks what it found, and keeps each apart", { timeout: 180_000 }, async () => {
    asked.length = 0;
    app.local.length = 0;
    app.backend.length = 0;
    const { code, map, text } = await learn("second", "--code");
    const product = readFileSync(join(dir, "second/PRODUCT.md"), "utf8");
    assert.equal(code, 0, text);

    assert.match(text, /^✓ \[code\] \d+ screens? · \d+ actions?, none seen {2}\d+s/m);
    assert.match(text, /^[✓!] \[new user\] /m);
    // The made-up user's own walk, each screen it went to under it.
    assert.match(text, /^[✓!] \[made-up user\] \d+ screens?/m);
    assert.match(text, /^ {2}✓ \/notes {2}\d+\.\ds$/m);
    // No sample row of this fixture's passes the checks, so its screens drew empty, and the row says so.
    assert.match(text, /Screens {2}\d+ seen · \d+ as a made-up user, no data · \d+ read from code/);
    assert.doesNotMatch(text, /Sign-in {2}/, "it got past the sign-in: that's for PRODUCT.md and --verbose");
    assert.match(text, /up to 1 min exploring/);
    assert.match(text.replace(/\s+/g, " "), /up to 1 min exploring, up to 42s more at a sign-in, your AI reading the code alongside/);
    assert.doesNotMatch(text, /not needed for this run/);
    assert.ok(map.learner.standIn.notReached.some((n: { path: string; why: string }) => n.path === "/admin" && n.why === "no_access"));
    assert.doesNotMatch(text, /--login/);

    const trades = map.screens.find((s: { path: string }) => s.path === "/trades");
    assert.equal(trades.seenWith, "stand-in");
    assert.equal(trades.madeUpData, undefined);
    assert.equal(map.screens.find((s: { path: string }) => s.path === "/pricing").seenWith, undefined);
    assert.deepEqual(map.screens.filter((s: { path: string; seenWith?: string }) => !s.seenWith).map((s: { path: string }) => s.path).sort(), ["/", "/login", "/pricing"]);
    assert.equal(map.learner.standIn.status, "reached");
    assert.equal(map.findings.length, 0, "a press that crashes there proves nothing");
    assert.deepEqual(map.fromCode.coverage.filesSent, ["src/App.tsx", "src/Admin.tsx", "src/Notes.tsx", "src/Trades.tsx"].sort());
    assert.equal(map.learner.codeRead.ran, true);

    // Made-up rows go no further than the browser and the private cache.
    assert.ok(asked.some((q) => q.includes("inventing sample records")));
    assert.doesNotMatch(JSON.stringify(map), /SAMPLE-ROW/);
    assert.doesNotMatch(product, /SAMPLE-ROW/);
    assert.match(readFileSync(join(dir, "second/.gitignore"), "utf8"), /\.code-read\.json/);

    assert.match(product, /marked stand-in/);
    assert.match(product, /## Read from the code, not seen/);

    // The review: no made-up row was asked about, and an answer resting on one went nowhere.
    const review = asked.find((q) => q.includes("You review a web product"))!;
    assert.doesNotMatch(review, /SAMPLE-ROW/);
    assert.doesNotMatch(review, /\(made-up row\)\n/);
    assert.equal(map.learner.review.raised, 3);
    // A plan's line left the machine in that question, so it's on record, by where it is and no more.
    assert.ok(review.includes(`plan === "free" ? 3 : 100`));
    assert.deepEqual(map.learner.review.codeLinesSent, ["src/Notes.tsx:1"]);
    assert.equal(map.learner.review.kept, 0);
    assert.ok(map.fixes.every((f: { from: string }) => f.from !== "review"));
    assert.ok(map.fixes.filter((f: { screens: string[] }) => f.screens.includes("/trades")).every((f: { seenWith?: string }) => f.seenWith === "stand-in"), "marked wherever it's shown");
    assert.ok(existsSync(join(dir, "second/FIX.md")));
    for (const shot of (map.newUser?.screens ?? []) as { photo?: string }[]) if (shot.photo) assert.ok(existsSync(join(dir, "second", shot.photo)), shot.photo);

    // What left: tracked code, and never what isn't.
    assert.doesNotMatch(asked.join("\n"), /do-not-send-this/);
    // No request with that user reached anyone: the back end heard nothing, the dev server only reads of files.
    assert.deepEqual(app.backend, []);
    assert.deepEqual(app.local.filter((r) => r.method !== "GET" && r.method !== "HEAD"), []);
  });

  it("takes the same code's answer again at no cost", { timeout: 120_000 }, async () => {
    await learn("third", "--code");
    asked.length = 0;
    const { map, text } = await learn("third", "--code");
    assert.match(text, /code unchanged, last read reused/);
    assert.ok(!asked.some((q) => q.includes("source code")));
    assert.equal(map.learner.codeRead.reused, true);
  });

  it("goes by the sign-in, whatever a public form does", { timeout: 120_000 }, async () => {
    const usual = app;
    app = await standInApp({ frontLinks: ["/contact", "/login"], openPages: { "/contact": '<h1>Write to us</h1><p>We read every message that comes in, and answer the same week.</p><form method="post" action="/contact"><label>Your message <textarea name="message"></textarea></label><button>Send it</button></form>' } });
    const { map } = await learn("public-form");
    await app.close();
    app = usual;
    assert.ok(map.actions.some((a: { kind: string }) => a.kind !== "read"), "a public save was seen");
    assert.ok(map.learner.standIn, "and the stand-in went past the sign-in all the same");
    assert.equal(map.learner.signInFirst, undefined, "the public part isn't only a way in");
  });

  it("does neither with --no-code and --no-stand-in, whatever was saved", { timeout: 60_000 }, async () => {
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ readCode: true }));
    asked.length = 0;
    const { map, text } = await learn("fourth", "--no-code", "--no-stand-in");
    rmSync(join(dir, "contextmachines.config.json"));
    assert.doesNotMatch(text, /\[new user\]|\[made-up user\]/);
    assert.equal(map.fromCode, undefined);
    assert.equal(map.learner.standIn, undefined);
    assert.equal(map.screens.some((s: { seenWith?: string }) => s.seenWith), false);
  });

  it("with --ai none, asks no AI anything, on a local app too", { timeout: 60_000 }, async () => {
    asked.length = 0;
    const out = join(dir, "no-ai");
    await new Promise<void>((done) => {
      const { CI: _ci, ANTHROPIC_API_KEY: _key, ...env } = process.env;
      const base = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;
      spawn(process.execPath, [cli, "learn", app.url, "--out", out, "--minutes", "1", "--pages", "8", "--ai", "none"], { cwd: dir, env: { ...env, OPENAI_BASE_URL: base, OPENAI_API_KEY: "local" }, stdio: "ignore" }).on("close", () => done());
    });
    assert.ok(existsSync(join(out, "map.json")));
    assert.deepEqual(asked, []);
  });

  it("says journeys need the stand-in on a real session, and presses nothing", { timeout: 60_000 }, async () => {
    const session = join(dir, "session.json");
    writeFileSync(session, JSON.stringify({ cookies: [], origins: [] }));
    app.local.length = 0;
    const { code, map } = await learn("real", "--session", session, "--ai", "none");
    assert.equal(code, 0);
    assert.equal(map.journeyWalk.status, "not_walked");
    assert.equal(map.journeyWalk.message, "Journeys need the stand-in: nothing is pressed on a real session.");
    assert.ok(app.local.every((heard) => heard.method === "GET" || heard.method === "HEAD"));
  });

  it("leaves them out with --no-journeys, and says so", { timeout: 60_000 }, async () => {
    const { code, map } = await learn("none", "--no-journeys", "--ai", "none");
    assert.equal(code, 0);
    assert.match(map.journeyWalk.message, /--no-journeys/);
  });

  it("does neither in a build, where nobody said yes", { timeout: 60_000 }, async () => {
    writeFileSync(join(dir, "contextmachines.config.json"), JSON.stringify({ readCode: true }));
    const { map } = await new Promise<{ map: Record<string, any> }>((done) => {
      const base = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;
      const child = spawn(process.execPath, [cli, "learn", app.url, "--out", join(dir, "fifth"), "--minutes", "1", "--pages", "8", "--ai", "openai-compatible", "--model", "scripted"], { cwd: dir, env: { ...process.env, CI: "true", OPENAI_BASE_URL: base, OPENAI_API_KEY: "local" }, stdio: "ignore" });
      child.on("close", () => done({ map: JSON.parse(readFileSync(join(dir, "fifth/map.json"), "utf8")) as Record<string, any> }));
    });
    rmSync(join(dir, "contextmachines.config.json"));
    assert.equal(map.fromCode, undefined);
    assert.equal(map.learner.standIn, undefined);
  });
});
