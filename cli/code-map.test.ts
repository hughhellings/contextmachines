// The code read, checked without a real AI: what it answers is planted, invented quotes and dead
// routes among it, and only what can be checked may come out.
//   node --test cli/code-map.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { addressStrings, clip, journeyHints, linkedRows, timeLeft, codeReadLine, readCode, readsBlankSessionFields, repoMatches, standInRows, usableCodeRead, type CodeRead, type Sample, type Walk } from "./code-map.ts";

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cm-code-")));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "-A", "-f"], { cwd: root });
  return root;
}

const APP = `import { Ledger } from "./Ledger";
export const PATH_TO_PAGE = { "/login": "login", "/ledger": "ledger", "/partners": "partners", "/old-ledger": "old", "/admin": "admin" };
// /ghost was removed long ago and renders <Ghost />
export function renderPage(page, user) {
  if (!user) return <Login />;
  switch (page) {
    case "ledger": return <Ledger />;
    case "admin": return isStaff(user) ? <AdminPanel /> : <Login />;
    default: return <Brief />;
  }
}
`;
const LEDGER = `// This page lets you wire money to anyone.
export function Ledger() {
  return <main>
    <h1>Your ledger</h1>
    <input placeholder="Search entries" />
    <button onClick={remove}>Delete entry</button>
  </main>;
}
async function remove(entry) {
  if (entry.locked) throw new Error("Locked entries can't be deleted");
  await db.from("entries").delete().eq("id", entry.id);
}
const load = () => db.from("entries").select("id, memo, amount");
`;
const FILES = {
  "index.html": "<title>Ledgerly: Books for bakeries</title>",
  "src/App.tsx": APP,
  "src/Ledger.tsx": LEDGER,
  "src/Landing.tsx": "export const Landing = () => <h1>Keep your bakery's books</h1>;\n",
  "src/Admin.tsx": 'export const AdminPanel = () => <h1>Staff tools</h1>;\nconst x = <button onClick={ban}>Ban the baker</button>;\n',
  "src/Partners.tsx": "export const Partners = () => <h1>Old partners page</h1>;\n",
  // The trap: looks like a screen's code, with real-looking rows in it.
  "src/lib/sampleData.ts": 'export const rows = [{ memo: "Payment to Jane Realperson" }];\n',
  "ui/MIGRATION.md": "Nothing here has shipped.\n",
  ".env.example": "NAME=value\n",
  "db/001.sql": "create table entries (id uuid, memo text, amount numeric, owner_id uuid);\n",
};

const walk = (pages: { path: string; title: string; headings?: string[] }[] = [{ path: "/", title: "Ledgerly: Books for bakeries", headings: ["Keep your bakery's books"] }, { path: "/login", title: "Log in | Ledgerly", headings: ["Welcome back"] }]): Walk =>
  ({ pagesVisited: pages.map((p) => p.path), errorPages: [], events: pages.map((p) => ({ kind: "page", path: p.path, snapshot: { title: p.title, headings: p.headings ?? [] } })) }) as unknown as Walk;

const route = (over: object) => ({ name: "A screen", redirectsTo: null, files: [], ...over });
const GOOD_ROUTES = [
  route({ path: "/", name: "Landing", access: "public", file: "src/App.tsx", quote: "default: return <Brief />;", files: ["src/Landing.tsx"] }),
  route({ path: "/login", name: "Log in", access: "public", file: "src/App.tsx", quote: "if (!user) return <Login />;" }),
  route({ path: "/ledger", name: "Ledger", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }),
  route({ path: "/admin", name: "Admin", access: "staff", file: "src/App.tsx", quote: 'case "admin": return isStaff(user)', files: ["src/Admin.tsx"] }),
  route({ path: "/partners", name: "Partners", access: "redirect", redirectsTo: "/ledger", file: "src/App.tsx", quote: 'default: return <Brief />;' }),
];
const empty = { live: true, title: null, purpose: null, buttons: [], fields: [], writes: [], data: [] };
const GOOD_LEDGER = {
  live: true,
  title: { text: "Your ledger", file: "src/Ledger.tsx", quote: "<h1>Your ledger</h1>" },
  purpose: { text: "Lists a bakery's entries.", file: "src/Ledger.tsx", quote: 'db.from("entries").select("id, memo, amount")' },
  buttons: [{ label: "Delete entry", file: "src/Ledger.tsx", quote: "<button onClick={remove}>Delete entry</button>" }],
  fields: [{ label: "Search entries", file: "src/Ledger.tsx", quote: '<input placeholder="Search entries" />' }],
  writes: [{ label: "Delete entry", does: "Removes an entry from the ledger.", rule: { text: "Locked entries can't be deleted.", file: "src/Ledger.tsx", quote: "if (entry.locked) throw new Error" }, file: "src/Ledger.tsx", quote: 'await db.from("entries").delete()' }],
  data: [{ kind: "table", name: "entries", shape: "list", columns: ["id", "memo", "amount", "made_up_column"], file: "src/Ledger.tsx", quote: 'db.from("entries").select("id, memo, amount")' }],
};
const GOOD_ADMIN = { ...empty, title: { text: "Staff tools", file: "src/Admin.tsx", quote: "<h1>Staff tools</h1>;" } };
const GOOD_READING = { product: "Keeps a bakery's books.", mainAction: { label: "Delete entry", why: "It is the only write." }, journeys: [{ name: "Tidy the books", screens: ["/ledger", "/admin"] }, { name: "Nowhere", screens: ["/ledger", "/invented"] }] };
const GOOD_ROWS = { samples: [{ name: "entries", rows: [["11111111-1111-4111-8111-111111111111", "Flour order", 12.5, null], ["22222222-2222-4222-8222-222222222222", "Sugar order", 8, null]] }] };

interface Script {
  files?: unknown;
  routes?: unknown;
  screens?: Record<string, unknown>;
  reading?: unknown;
  rows?: unknown;
}

/** An AI that answers by the question it's asked, and remembers everything it was sent. */
function fakeAi(script: Script = {}) {
  const ai = {
    model: "fake",
    asked: 0,
    sent: [] as string[],
    ask: async (system: string, question: string, _schema: object) => {
      ai.asked++;
      ai.sent.push(`${system}\n${question}`);
      const text = (answer: unknown) => ({ text: typeof answer === "string" ? answer : JSON.stringify(answer), costUsd: 0.01 });
      if (system.includes("where its screens are decided")) return text(script.files ?? { files: ["src/App.tsx"] });
      if (system.includes("to list its screens")) return text(script.routes ?? { routes: GOOD_ROUTES });
      if (system.includes("one screen")) {
        const path = /^Screen: (\S+)/.exec(question)![1]!;
        const answers = { "/ledger": GOOD_LEDGER, "/admin": GOOD_ADMIN, ...script.screens };
        const answer = answers[path as keyof typeof answers] ?? empty;
        if (answer instanceof Error) throw answer;
        return text(answer);
      }
      if (system.includes("what a web product is for")) return text(script.reading ?? GOOD_READING);
      if (system.includes("inventing sample records")) return text(script.rows ?? GOOD_ROWS);
      throw new Error("unexpected question");
    },
  };
  return ai;
}

const ran = (read: CodeRead) => {
  if (!read.ran) assert.fail(`didn't run: ${read.reason}`);
  return read;
};

describe("the code read", () => {
  it("reads the screens behind the sign-in, each claim tied to a file and line", async () => {
    const read = ran(await readCode(walk(), fakeAi(), repo(FILES)));
    const { fromCode } = read;
    assert.equal(fromCode.label, "read from code, not seen");
    assert.equal(fromCode.product, "Keeps a bakery's books.");
    assert.deepEqual(fromCode.mainAction, { label: "Delete entry", why: "It is the only write." });
    const ledger = fromCode.screens.find((s) => s.path === "/ledger")!;
    assert.equal(ledger.name, "Your ledger");
    assert.equal(ledger.evidence, "src/App.tsx:7");
    assert.deepEqual(ledger.buttons, [{ label: "Delete entry", evidence: "src/Ledger.tsx:6" }]);
    assert.deepEqual(fromCode.actions, [{ from: "code", screen: "/ledger", label: "Delete entry", does: "Removes an entry from the ledger.", rule: { text: "Locked entries can't be deleted.", evidence: "src/Ledger.tsx:10" }, evidence: "src/Ledger.tsx:11" }]);
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.deepEqual(read.staffPaths, ["/admin"]);
    assert.equal(codeReadLine(fromCode), "2 screens and 1 action read from code, none seen");
  });

  it("states what left the machine, and nothing but the files that did", async () => {
    const ai = fakeAi();
    const { fromCode } = ran(await readCode(walk(), ai, repo(FILES)));
    assert.deepEqual(fromCode.coverage.filesSent, ["src/Admin.tsx", "src/App.tsx", "src/Ledger.tsx"]);
    const all = ai.sent.join("\n");
    assert.ok(!all.includes("Jane Realperson") && !all.includes("sampleData"), "a fixture is neither sent nor listed");
    assert.ok(!all.includes("MIGRATION") && !all.includes(".env.example"));
    assert.ok(fromCode.coverage.filesLeftOut.type! >= 3);
  });

  it("keeps out of the seen map what the browser really saw", async () => {
    const { fromCode } = ran(await readCode(walk(), fakeAi(), repo(FILES)));
    assert.ok(!fromCode.screens.some((s) => s.path === "/" || s.path === "/login"));
    assert.deepEqual(fromCode.calibration, { named: 2, of: 2, missed: [] });
  });

  it("drops a journey through a screen nobody checked", async () => {
    const { fromCode } = ran(await readCode(walk(), fakeAi(), repo(FILES)));
    assert.deepEqual(fromCode.journeys, [{ name: "Tidy the books", screens: ["/ledger", "/admin"] }]);
  });
});

describe("invented quotes", () => {
  const screen = (over: object) => ({ ...GOOD_LEDGER, ...over });
  const read = async (over: object) => ran(await readCode(walk(), fakeAi({ screens: { "/ledger": screen(over) } }), repo(FILES)));

  it("drops a button whose quote isn't in the file", async () => {
    const { fromCode } = await read({ buttons: [{ label: "Wire money", file: "src/Ledger.tsx", quote: "<button>Wire money</button>" }] });
    assert.deepEqual(fromCode.screens.find((s) => s.path === "/ledger")!.buttons, []);
    assert.equal(fromCode.coverage.dropped["quote not in the file"], 1);
  });

  it("drops a quote that is too short to mean anything", async () => {
    const { fromCode } = await read({ buttons: [{ label: "remove", file: "src/Ledger.tsx", quote: "remove" }] });
    assert.equal(fromCode.coverage.dropped["quote too short"], 1);
  });

  it("drops a true quote from a file not tied to the screen", async () => {
    const { fromCode } = await read({ buttons: [{ label: "Ban the baker", file: "src/Admin.tsx", quote: "<button onClick={ban}>Ban the baker</button>" }] });
    assert.equal(fromCode.coverage.dropped["file not tied to the screen"], 1);
  });

  it("drops a claim resting on a comment", async () => {
    const { fromCode } = await read({ purpose: { text: "Wires money to anyone.", file: "src/Ledger.tsx", quote: "This page lets you wire money to anyone." } });
    assert.equal(fromCode.screens.find((s) => s.path === "/ledger")!.purpose, undefined);
    assert.equal(fromCode.coverage.dropped["quote is a comment"], 1);
  });

  it("drops a label its own true quote doesn't hold", async () => {
    const { fromCode } = await read({ buttons: [{ label: "Wire money", file: "src/Ledger.tsx", quote: "<button onClick={remove}>Delete entry</button>" }] });
    assert.equal(fromCode.coverage.dropped["label not in its quote"], 1);
  });

  it("drops a write pressed from a label the code doesn't hold", async () => {
    const { fromCode } = await read({ writes: [{ label: "Close the books", does: "Closes the year.", rule: null, file: "src/Ledger.tsx", quote: 'await db.from("entries").delete()' }] });
    assert.deepEqual(fromCode.actions, []);
    assert.equal(fromCode.coverage.dropped["label not in the code"], 1);
  });

  it("keeps a write but not a rule with an invented quote", async () => {
    const { fromCode } = await read({ writes: [{ ...GOOD_LEDGER.writes[0]!, rule: { text: "Only on Tuesdays.", file: "src/Ledger.tsx", quote: "if (today === 'Tuesday') return" } }] });
    assert.equal(fromCode.actions.length, 1);
    assert.equal(fromCode.actions[0]!.rule, undefined);
  });

  it("drops a quote stitched across a cut", async () => {
    const big = `${"const filler = compute(1);\n".repeat(6000)}<button onClick={go}>Go now please</button>\n${"const filler = compute(2);\n".repeat(6000)}<button onClick={stop}>Stop right there</button>\n`;
    const root = repo({ ...FILES, "src/Ledger.tsx": `${LEDGER}\n${big}` });
    const stitched = "<button onClick={go}>Go now please</button>\n…\n<button onClick={stop}>Stop right there</button>";
    const { fromCode } = ran(await readCode(walk(), fakeAi({ screens: { "/ledger": screen({ buttons: [{ label: "Go now please", file: "src/Ledger.tsx", quote: stitched }] }) } }), root));
    assert.equal(fromCode.screens.find((s) => s.path === "/ledger")!.buttons.length, 0);
    assert.equal(fromCode.coverage.cut[0]!.file, "src/Ledger.tsx");
    assert.ok(fromCode.coverage.cut[0]!.sentBytes < fromCode.coverage.cut[0]!.ofBytes);
  });

  it("drops an answer that isn't the shape asked for, and says the screen was skipped", async () => {
    const { fromCode } = ran(await readCode(walk(), fakeAi({ screens: { "/admin": "not json" } }), repo(FILES)));
    assert.deepEqual(fromCode.coverage.screensSkipped, [{ path: "/admin", why: "the answer wasn't JSON" }]);
  });

  it("keeps nothing shaped like a secret in what the AI wrote", async () => {
    const { fromCode } = await read({ writes: [{ ...GOOD_LEDGER.writes[0]!, does: "Uses password: hunter2 to delete." }] });
    assert.deepEqual(fromCode.actions, []);
  });
});

describe("what a claim may say", () => {
  it("drops a write that states a guessed request as fact", async () => {
    for (const does of ["Sends POST /rest/v1/entries to remove it.", "Calls https://db.acme.dev/rest/v1/entries.", "Removes it through /rest/v1/entries."]) {
      const read = ran(await readCode(walk(), fakeAi({ screens: { "/ledger": { ...GOOD_LEDGER, writes: [{ ...GOOD_LEDGER.writes[0], does }] } } }), repo(FILES)));
      assert.equal(read.fromCode.actions.length, 0, does);
      assert.equal(read.fromCode.coverage.dropped["guessed a request"], 1);
    }
  });

  it("drops a quote only found in a block comment, and keeps one that is live elsewhere", async () => {
    const files = { ...FILES, "src/Ledger.tsx": `/*\n<button onClick={pay}>Pay everyone now</button>\n<button onClick={remove}>Delete entry</button>\n*/\n${LEDGER}` };
    const screens = { "/ledger": { ...GOOD_LEDGER, buttons: [{ label: "Pay everyone now", file: "src/Ledger.tsx", quote: "<button onClick={pay}>Pay everyone now</button>" }, ...GOOD_LEDGER.buttons] } };
    const read = ran(await readCode(walk(), fakeAi({ screens }), repo(files)));
    assert.deepEqual(read.fromCode.screens[0]!.buttons.map((b) => b.label), ["Delete entry"]);
    assert.equal(read.fromCode.screens[0]!.buttons[0]!.evidence, "src/Ledger.tsx:10");
    assert.equal(read.fromCode.coverage.dropped["quote is a comment"], 1);
  });
});

describe("dead routes", () => {
  it("lists a routed address with no page as a redirect, never a screen to open", async () => {
    const read = ran(await readCode(walk(), fakeAi(), repo(FILES)));
    const partners = read.fromCode.screens.find((s) => s.path === "/partners")!;
    assert.equal(partners.access, "redirect");
    assert.equal(partners.redirectsTo, "/ledger");
    assert.ok(!read.signedInPaths.includes("/partners"));
    assert.equal(codeReadLine(read.fromCode).startsWith("2 screens"), true, "a redirect isn't a screen");
  });

  it("skips a true map entry claimed as a screen when it has no file of its own", async () => {
    const routes = [...GOOD_ROUTES.slice(0, 4), route({ path: "/partners", access: "signed-in", file: "src/App.tsx", quote: '"/partners": "partners"' })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes } }), repo(FILES)));
    assert.ok(!read.signedInPaths.includes("/partners"));
    assert.ok(!read.fromCode.screens.some((s) => s.path === "/partners"));
    assert.deepEqual(read.fromCode.coverage.screensSkipped, [{ path: "/partners", why: "no file of its own" }]);
  });

  it("skips a screen whose own files turn out not to render it", async () => {
    const routes = [...GOOD_ROUTES.slice(0, 4), route({ path: "/partners", access: "signed-in", file: "src/App.tsx", quote: '"/partners": "partners"', files: ["src/Partners.tsx"] })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes }, screens: { "/partners": { ...empty, live: false } } }), repo(FILES)));
    assert.ok(!read.signedInPaths.includes("/partners"));
    assert.deepEqual(read.fromCode.coverage.screensSkipped, [{ path: "/partners", why: "the code doesn't render it" }]);
  });

  it("skips a screen nothing about could be checked", async () => {
    const routes = [...GOOD_ROUTES.slice(0, 4), route({ path: "/partners", access: "signed-in", file: "src/App.tsx", quote: '"/partners": "partners"', files: ["src/Partners.tsx"] })];
    const screens = { "/partners": { ...empty, title: { text: "Partners", file: "src/Partners.tsx", quote: "<h1>Invented heading</h1>" } } };
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes }, screens }), repo(FILES)));
    assert.ok(!read.fromCode.screens.some((s) => s.path === "/partners"));
  });

  it("drops an address the code never names, and one on a comment line", async () => {
    const routes = [...GOOD_ROUTES.slice(0, 4), route({ path: "/invented", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }), route({ path: "/ghost", access: "signed-in", file: "src/App.tsx", quote: "/ghost was removed long ago and renders", files: ["src/Ledger.tsx"] })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes } }), repo(FILES)));
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.equal(read.fromCode.coverage.dropped["address not in the code"], 1);
    assert.equal(read.fromCode.coverage.dropped["quote is a comment"], 1);
  });

  it("drops a route that was switched off in a block comment", async () => {
    const files = { ...FILES, "src/App.tsx": `/*\n<Route path="/retired" element={<Retired />} />\n*/\n${APP}` };
    const routes = [...GOOD_ROUTES.slice(0, 4), route({ path: "/retired", access: "signed-in", file: "src/App.tsx", quote: '<Route path="/retired" element={<Retired />} />', files: ["src/Ledger.tsx"] })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes } }), repo(files)));
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.ok(!read.fromCode.screens.some((s) => s.path === "/retired"));
  });

  it("gives the stand-in no address it can't open, or that signs it out", async () => {
    const routes = [...GOOD_ROUTES, route({ path: "/ledger/:id", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }), route({ path: "/ledger/logout", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes }, screens: { "/ledger/:id": GOOD_LEDGER, "/ledger/logout": GOOD_LEDGER } }), repo(FILES)));
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.ok(read.fromCode.screens.some((s) => s.path === "/ledger/:id"), "still a screen in the map");
  });
});

describe("the wrong repo", () => {
  const OTHER = { "index.html": "<title>Gardenly: Plant diaries</title>", "src/App.tsx": 'const a = <h1>Sign in</h1>;\nconst b = "Privacy Policy";\nconst c = "Welcome back";\nconst d = "Home";\n' };

  it("stops before any code is sent when the words on the pages aren't in the repo", async () => {
    const ai = fakeAi();
    const read = await readCode(walk(), ai, repo(OTHER));
    assert.equal(read.ran, false);
    assert.equal(!read.ran && read.why, "wrong-repo");
    assert.equal(ai.asked, 0);
  });

  it("isn't fooled by what every site says", async () => {
    const ai = fakeAi();
    const pages = [{ path: "/", title: "Log in", headings: ["Welcome back"] }, { path: "/signup", title: "Create your account | Sign up", headings: ["Privacy Policy"] }];
    const read = await readCode(walk(pages), ai, repo({ "src/App.tsx": 'a = "Log in"; b = "Welcome back"; c = "Create your account"; d = "Privacy Policy";\n' }));
    assert.equal(read.ran, false);
    assert.ok(!read.ran && /says which product/.test(read.reason));
    assert.equal(ai.asked, 0);
  });

  it("isn't fooled by one word that any repo could hold", () => {
    const pages = [{ title: "Invoices | Northwind Billing", headings: ["Paid on time, every time"] }];
    assert.equal(repoMatches(pages, [{ text: 'const invoices = "Invoices";' }]).matches, false);
    assert.equal(repoMatches(pages, [{ text: "<title>Invoices | Northwind Billing</title>" }]).matches, true);
  });

  it("matches a word whole, across quotes and entities", () => {
    assert.equal(repoMatches([{ title: "Insight", headings: [] }], [{ text: "insightful" }]).matches, false);
    assert.equal(repoMatches([{ title: "Acme & Sons", headings: ["Baker's dozen rolls"] }], [{ text: "<h1>Acme &amp; Sons</h1><h2>Baker&apos;s dozen rolls</h2>" }]).matches, true);
  });

  it("finds a translated site's words in its translation files, and never sends them", async () => {
    const files = { "src/App.tsx": APP, "src/Ledger.tsx": LEDGER, "messages/en.json": '{"title":"Ledgerly: Books for bakeries","hero":"Keep your bakery\'s books"}\n' };
    const ai = fakeAi();
    const read = ran(await readCode(walk(), ai, repo(files)));
    assert.ok(!read.fromCode.coverage.filesSent.includes("messages/en.json"));
    assert.ok(!ai.sent.some((text) => text.includes("Books for bakeries")));
    const elsewhere = await readCode(walk(), fakeAi(), repo({ ...files, "messages/en.json": "{}\n", "data/en-notes.json": '{"title":"Ledgerly: Books for bakeries"}\n' }));
    assert.equal(!elsewhere.ran && elsewhere.why, "wrong-repo");
  });

  it("knows a site by a page it won't send, and never sends it", async () => {
    const key = ["pk", "live", "51NnotarealkeyatallXX"].join("_");
    const files = { "index.html": `<title>Ledgerly: Books for bakeries</title><script>start("${key}")</script>`, "src/App.tsx": APP, "src/Ledger.tsx": LEDGER };
    const ai = fakeAi();
    const read = ran(await readCode(walk(), ai, repo(files)));
    assert.ok(!read.fromCode.coverage.filesSent.includes("index.html"));
    assert.ok(!ai.sent.some((text) => text.includes(key) || text.includes("Books for bakeries")));
  });

  it("trusts a server already tied to this folder, but still checks the routes", async () => {
    const pages = [{ path: "/", title: "Log in", headings: ["Welcome back"] }];
    const root = repo(FILES);
    assert.equal((await readCode(walk(pages), fakeAi(), root)).ran, false);
    assert.equal((await readCode(walk(pages), fakeAi(), root, { tiedToFolder: true })).ran, true);
  });

  it("doesn't ask again when the routes leave out the screens seen, on a server tied to this folder", async () => {
    const pages = [{ path: "/shop", title: "Ledgerly: Books for bakeries", headings: ["Keep your bakery's books"] }];
    const read = ran(await readCode(walk(pages), fakeAi(), repo(FILES), { tiedToFolder: true }));
    assert.equal(read.routesAgain, undefined);
    assert.equal(read.fromCode.calibration.named, 0);
  });

  it("stops after the routes when the code names none of the screens seen", async () => {
    const pages = [{ path: "/shop", title: "Ledgerly: Books for bakeries", headings: ["Keep your bakery's books"] }];
    const read = await readCode(walk(pages), fakeAi(), repo(FILES));
    assert.equal(!read.ran && read.why, "wrong-repo");
  });

  it("refuses a folder that isn't a repo, and Ollama, in plain words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cm-plain-"));
    made.push(dir);
    assert.equal((await readCode(walk(), fakeAi(), dir)).ran, false);
    const read = await readCode(walk(), { ...fakeAi(), via: "Ollama on this machine" }, repo(FILES));
    assert.equal(!read.ran && read.why, "unsupported-ai");
  });

  it("says so when the AI fails, rather than throwing", async () => {
    const ai = { model: "fake", ask: async () => { throw new Error("no credit"); } };
    const read = await readCode(walk(), ai, repo(FILES));
    assert.equal(!read.ran && read.why, "ai-failed");
    assert.ok(!read.ran && read.reason.includes("no credit"));
  });

  it("says which files left the machine even when the read stops late", async () => {
    const stopped = await readCode(walk(), fakeAi({ routes: { routes: [route({ path: "/invented", access: "signed-in", file: "src/App.tsx", quote: "not in the file at all" })] } }), repo(FILES));
    assert.equal(!stopped.ran && stopped.why, "no-routes");
    assert.deepEqual(!stopped.ran && stopped.filesSent, ["src/App.tsx"]);

    const pages = [{ path: "/shop", title: "Ledgerly: Books for bakeries", headings: ["Keep your bakery's books"] }];
    const wrong = await readCode(walk(pages), fakeAi(), repo(FILES));
    assert.deepEqual(!wrong.ran && wrong.filesSent, ["src/App.tsx"]);

    const unchecked = await readCode(walk(), fakeAi({ screens: { "/ledger": { ...empty, live: false }, "/admin": { ...empty, live: false } } }), repo(FILES));
    assert.equal(!unchecked.ran && unchecked.why, "nothing-checked");
    assert.deepEqual(!unchecked.ran && unchecked.filesSent, ["src/Admin.tsx", "src/App.tsx", "src/Ledger.tsx"]);

    const early = await readCode(walk(), fakeAi(), repo({ "src/App.tsx": "const a = 1;\n" }));
    assert.deepEqual(!early.ran && early.filesSent, [], "stopped before anything was sent");
  });
});

describe("what the journeys get from the read", () => {
  it("is labels and addresses, with a public screen's marked and a staff screen's left out", () => {
    const screen = (path: string, access: "public" | "signed-in" | "staff") => ({ from: "code" as const, path, name: path, access, buttons: [], fields: [], evidence: [] });
    const action = (screen: string, label: string) => ({ from: "code" as const, screen, label, does: "does it", evidence: [] });
    const hints = journeyHints({ screens: [screen("/forgot", "public"), screen("/trades", "signed-in"), screen("/admin", "staff")], actions: [action("/forgot", "Send reset link"), action("/trades", "Add trade"), action("/admin", "Ban user")] } as unknown as Parameters<typeof journeyHints>[0]);
    assert.deepEqual(hints.actions, [{ screen: "/forgot", label: "Send reset link", does: "does it", public: true }, { screen: "/trades", label: "Add trade", does: "does it" }]);
    assert.deepEqual(hints.screens, [{ path: "/trades" }]);
  });
});

describe("sample rows", () => {
  const rowsOf = async (rows: unknown[][], files = FILES) => {
    const read = ran(await readCode(walk(), fakeAi({ rows: { samples: [{ name: "entries", rows }] } }), repo(files)));
    return read.samples.find((s) => s.name === "entries")!;
  };
  const ok = "11111111-1111-4111-8111-111111111111";

  it("names columns only the code or its schema holds, and marks every row invented", async () => {
    const sample = await rowsOf([[ok, "Flour order", 12.5, null]]);
    assert.deepEqual(sample.columns, ["id", "memo", "amount", "owner_id"], "made_up_column is out, the schema's owner_id is in");
    assert.deepEqual(sample.rows, [{ id: ok, memo: "Flour order", amount: 12.5, owner_id: null }]);
    assert.equal(sample.invented, true);
    assert.equal(sample.kind, "table");
  });

  it("sends column names to invent from, never a fixture's values", async () => {
    const ai = fakeAi();
    await readCode(walk(), ai, repo(FILES));
    const asked = ai.sent.find((q) => q.includes("inventing sample records"))!;
    assert.ok(asked.includes("owner_id") && !asked.includes("Realperson") && !asked.includes("select("));
  });

  it("drops a row copied from a sample file", async () => {
    const sample = await rowsOf([[ok, "Payment to Jane Realperson", 1, null], [ok, "Flour order", 2, null]]);
    assert.deepEqual(sample.rows.map((r) => r.memo), ["Flour order"]);
  });

  it("drops a row holding anything like a real person, a card or a key", async () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoiYW5vbiJ9", "c2lnbmF0dXJl"].join(".");
    const sample = await rowsOf([[ok, "ann@fastmail.com", 1, null], [ok, "+44 20 7946 0958", 2, null], [ok, "4242 4242 4242 4242", 3, null], [ok, jwt, 4, null], [ok, "sample@example.com", 5, null]]);
    assert.deepEqual(sample.rows.map((r) => r.amount), [5]);
  });

  it("drops a row with a card as a bare number, and keeps a timestamp", async () => {
    const sample = await rowsOf([[ok, "Flour order", 4111111111111111, null], [ok, "Sugar order", 1767225600000, null]]);
    assert.deepEqual(sample.rows.map((row) => row.amount), [1767225600000]);
  });

  it("drops a row the wrong length, and rows for a table nobody asked about", async () => {
    const read = ran(await readCode(walk(), fakeAi({ rows: { samples: [{ name: "entries", rows: [[ok, "short"]] }, { name: "invented", rows: [["x"]] }] } }), repo(FILES)));
    assert.deepEqual(read.samples.map((s) => [s.name, s.rows.length]), [["entries", 0]]);
  });

  it("drops a table the code doesn't name, and an endpoint on another host", async () => {
    const data = [
      { kind: "table", name: "payroll", shape: "list", columns: ["id"], file: "src/Ledger.tsx", quote: 'db.from("entries").select("id, memo, amount")' },
      { kind: "endpoint", name: "https://api.stripe.com/v1/charges", shape: "list", columns: ["id"], file: "src/Ledger.tsx", quote: 'db.from("entries").select("id, memo, amount")' },
    ];
    const read = ran(await readCode(walk(), fakeAi({ screens: { "/ledger": { ...GOOD_LEDGER, data } } }), repo(FILES)));
    assert.deepEqual(read.samples.map((s) => s.name), ["entries"], "what the schema and the code say is kept: nothing the answer alone said");
  });

  it("keeps the read when the rows fail, and says so", async () => {
    const read = ran(await readCode(walk(), fakeAi({ rows: "not json" }), repo(FILES)));
    assert.equal(read.samplesError, "the answer wasn't JSON");
    assert.deepEqual(read.samples.map((s) => s.rows), [[]]);
    assert.ok(read.fromCode.screens.length > 0);
  });

  it("hands the stand-in rows the way it takes them", () => {
    const base = { columns: ["id"], invented: true as const, evidence: "a.ts:1", rows: [{ id: "1" }] };
    const samples: Sample[] = [
      { ...base, kind: "table", name: "trades", shape: "list" },
      { ...base, kind: "function", name: "summary", shape: "list" },
      { ...base, kind: "endpoint", name: "/api/plan", shape: "object" },
      { ...base, kind: "endpoint", name: "/api/items", shape: "list" },
      { ...base, kind: "endpoint", name: "/api/items/:id", shape: "object" },
      { ...base, kind: "table", name: "empty", shape: "list", rows: [] },
    ];
    assert.deepEqual(standInRows(samples), { trades: [{ id: "1" }], "rpc/summary": [{ id: "1" }], "/api/plan": { id: "1" }, "/api/items": [{ id: "1" }] });
  });
  it("puts rows under the key the reply holds them by, as a list whatever the reply was called", () => {
    const base = { columns: ["id"], rows: [{ id: "1" }], invented: true as const, evidence: "a.ts:1", kind: "endpoint" as const };
    assert.deepEqual(standInRows([{ ...base, name: "/api/a", shape: "list", under: "members" }, { ...base, name: "/api/b", shape: "object", under: "events" }]), { "/api/a": { members: [{ id: "1" }] }, "/api/b": { events: [{ id: "1" }] } });
  });
  it("knows when the code reads sign-up fields the made-up user doesn't have, or can't be looked at", () => {
    assert.equal(readsBlankSessionFields([{ text: "const n = session.user.user_metadata.first_name;" }]), true);
    assert.equal(readsBlankSessionFields([{ text: "const n = profile.first_name;" }]), false);
    assert.equal(readsBlankSessionFields([]), true);
  });
});

describe("the whole-run cache", () => {
  it("gives an unchanged repo the same answer at no cost, and reads a changed one afresh", async () => {
    const root = repo(FILES);
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "deep/read.json");
    made.push(dirname(dirname(cacheFile)));
    const first = ran(await readCode(walk(), fakeAi(), root, { cacheFile }));
    assert.equal(first.reused, false);
    assert.ok(existsSync(cacheFile));
    assert.equal(usableCodeRead(cacheFile), true);

    const again = fakeAi();
    const second = ran(await readCode(walk(), again, root, { cacheFile }));
    assert.equal(again.asked, 0);
    assert.equal(second.reused, true);
    assert.equal(second.costUsd, 0);
    assert.deepEqual(second.fromCode, first.fromCode);

    writeFileSync(join(root, "src/Ledger.tsx"), `${LEDGER}\n`);
    const changed = fakeAi();
    assert.equal(ran(await readCode(walk(), changed, root, { cacheFile })).reused, false);
    assert.ok(changed.asked > 0);
  });

  it("still checks the repo before reusing, and keeps no read that half failed", async () => {
    const root = repo(FILES);
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "read.json");
    made.push(dirname(cacheFile));
    await readCode(walk(), fakeAi({ rows: "not json" }), root, { cacheFile });
    assert.equal(ran(await readCode(walk(), fakeAi(), root, { cacheFile })).reused, false, "a read with no rows isn't one to reuse");
    assert.equal((await readCode(walk([{ path: "/", title: "Gardenly | Plant diaries", headings: ["Water less"] }]), fakeAi(), root, { cacheFile })).ran, false);
  });

  it("holds no source: only what was checked", async () => {
    const root = repo(FILES);
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "read.json");
    made.push(dirname(cacheFile));
    const ai = fakeAi();
    const read = ran(await readCode(walk(), ai, root, { cacheFile }));
    const stored = JSON.stringify(read.fromCode);
    assert.ok(!stored.includes("db.from(") && !stored.includes("<button"));
    const onDisk = readFileSync(cacheFile, "utf8");
    assert.ok(!onDisk.includes("db.from(") && !onDisk.includes("<button"), "the kept answers hold no quote either");
  });

  it("asks again about the one screen whose file changed, and nothing else", async () => {
    const root = repo(FILES);
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "read.json");
    made.push(dirname(cacheFile));
    await readCode(walk(), fakeAi(), root, { cacheFile });
    writeFileSync(join(root, "src/Admin.tsx"), `${FILES["src/Admin.tsx"]}// a note\n`);
    const changed = fakeAi();
    const read = ran(await readCode(walk(), changed, root, { cacheFile }));
    assert.equal(read.reused, false);
    assert.equal(changed.asked, 1, changed.sent.map((q) => q.slice(0, 60)).join("\n"));
    assert.ok(changed.sent[0]!.includes("Screen: /admin"));
    assert.ok(read.fromCode.coverage.filesSent.includes("src/Ledger.tsx"), "what an earlier run sent is still said to have gone");
  });
});

describe("reading beside the browser", () => {
  it("finds addresses to try with no AI, and only ones that are whole addresses in code", () => {
    const files = [
      { text: 'navigate("/onboarding"); go("/onboarding"); const w = \'/welcome\';\n// go("/getting-started")\nfetch("/api/onboarding"); link("/docs/onboarding.md"); x("/trades"); x("/trades"); x("/logout"); y("the onboarding");\n' },
    ];
    assert.deepEqual(addressStrings(files), { firstRun: ["/onboarding", "/welcome"], others: ["/trades"] });
  });

  it("makes up rows for a table the schema declares and the code names, whatever the model picked out", async () => {
    const files = { ...FILES, "db/001.sql": `${FILES["db/001.sql"]}create table audits (id uuid, note text);\ncreate table unused (id uuid);\n`, "src/Ledger.tsx": `${LEDGER}const logs = db.from("audits").select("*");\n` };
    const ai = fakeAi();
    const read = ran(await readCode(walk(), ai, repo(files)));
    assert.deepEqual(read.samples.map((s) => s.name), ["entries", "audits"]);
  });

  it("keeps a route whose line is real when the file named for it isn't the one that holds it, and no other", async () => {
    const routes = [...GOOD_ROUTES.filter((r) => (r as { path?: string }).path !== "/ledger"), route({ path: "/ledger", name: "Ledger", access: "signed-in", file: "src/Ledger.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }), route({ path: "/ghost", name: "Ghost", access: "signed-in", file: "src/Ghost.tsx", quote: "return <GhostPage />;", files: [] })];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes } }), repo(FILES)));
    assert.ok(read.signedInPaths.includes("/ledger"));
    assert.ok(!JSON.stringify(read.fromCode.screens).includes("/ghost"));
    assert.ok(read.fromCode.screens.find((s) => s.path === "/ledger")!.evidence.startsWith("src/App.tsx:"));
  });

  it("keeps a table the code really names when a small model quotes another line, and not one it doesn't", async () => {
    const data = (name: string) => ({ kind: "table", name, shape: "list", columns: ["memo"], file: "src/Ledger.tsx", quote: "const load = () => db" });
    const read = ran(await readCode(walk(), fakeAi({ screens: { "/ledger": { ...GOOD_LEDGER, data: [data("entries"), data("invented_table")] } } }), repo(FILES)));
    assert.deepEqual(read.samples.map((s) => s.name), ["entries"]);
  });

  it("doesn't let the small model call the right repository the wrong one", async () => {
    const main = fakeAi();
    const small = fakeAi({ routes: { routes: [route({ path: "/admin", name: "Admin", access: "staff", file: "src/App.tsx", quote: 'case "admin": return isStaff(user)', files: ["src/Admin.tsx"] })] } });
    const read = ran(await readCode(walk(), { ...main, light: small }, repo(FILES)));
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.ok(main.sent.some((q) => q.includes("to list its screens")));
    assert.ok(small.sent.some((q) => q.includes("one screen")), "the rest stays with the small model");
  });

  it("gives the small model one more go first, as the same question often passes the next time", async () => {
    const main = fakeAi();
    const bad = { routes: { routes: [route({ path: "/admin", name: "Admin", access: "staff", file: "src/App.tsx", quote: 'case "admin": return isStaff(user)', files: ["src/Admin.tsx"] })] } };
    const good = fakeAi();
    const small = { ...good, ask: (system: string, question: string, schema: object) => (firstRoutes(system) ? fakeAi(bad).ask(system, question, schema) : good.ask(system, question, schema)) };
    let routesAsked = 0;
    const firstRoutes = (system: string) => /list its screens/.test(system) && ++routesAsked === 1;
    const said: string[] = [];
    const read = ran(await readCode(walk(), { ...main, light: small }, repo(FILES), { onProgress: (line) => said.push(line) }));
    assert.deepEqual(read.signedInPaths, ["/ledger"]);
    assert.equal(routesAsked, 2);
    assert.equal(main.asked, 0, "the main model is only for when that fails too");
    assert.deepEqual(read.routesAgain, ["wrong-repo"]);
    assert.equal(said.filter((line) => /checking the routes again/.test(line)).length, 1);
  });

  it("goes straight to the main model when the small one couldn't answer at all", async () => {
    const main = fakeAi();
    const good = fakeAi();
    let routesAsked = 0;
    const small = { ...good, ask: async (system: string, question: string, schema: object) => {
      if (/list its screens/.test(system)) {
        routesAsked++;
        throw new Error("the small model is gone");
      }
      return good.ask(system, question, schema);
    } };
    const read = ran(await readCode(walk(), { ...main, light: small }, repo(FILES)));
    assert.equal(routesAsked, 1);
    assert.ok(main.sent.some((q) => q.includes("to list its screens")));
    assert.deepEqual(read.routesAgain, ["ai-failed"]);
  });

  it("still refuses a repository the main model can't tie to the site either", async () => {
    const stranger = { routes: { routes: [route({ path: "/admin", name: "Admin", access: "staff", file: "src/App.tsx", quote: 'case "admin": return isStaff(user)', files: ["src/Admin.tsx"] })] } };
    const read = await readCode(walk(), { ...fakeAi(stranger), light: fakeAi(stranger) }, repo(FILES));
    assert.equal(read.ran, false);
    assert.equal((read as Extract<CodeRead, { ran: false }>).why, "wrong-repo");
  });

  it("asks the small model everything, when there is one", async () => {
    const main = fakeAi();
    const small = fakeAi();
    ran(await readCode(walk(), { ...main, light: small }, repo(FILES)));
    assert.equal(main.asked, 0);
    assert.ok(small.asked > 0);
  });

  it("reads the first run first, then what's behind the wall, and staff screens last", async () => {
    const pages = { "src/Welcome.tsx": "export const W = () => <h1>Welcome to it</h1>;\n" };
    const app = `${APP}const more = ["/welcome", W, "live"];\n`;
    const routes = [...GOOD_ROUTES.slice(0, 4).reverse(), route({ path: "/welcome", name: "Welcome", access: "signed-in", file: "src/App.tsx", quote: '["/welcome", W, "live"]', files: ["src/Welcome.tsx"] })];
    const ai = fakeAi({ routes: { routes } });
    await readCode(walk(), ai, repo({ ...FILES, ...pages, "src/App.tsx": app }), { atOnce: 1 });
    assert.deepEqual(ai.sent.flatMap((q) => /Screen: (\S+)/.exec(q)?.[1] ?? []), ["/welcome", "/ledger", "/admin"]);
  });
});

describe("how much is read", () => {
  it("reads a tab of a page once, keeps its address, and asks about it no more", async () => {
    const routes = [...GOOD_ROUTES, route({ path: "/ledger/:tab", name: "Ledger tab", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }), route({ path: "/ledger/old", name: "Old tab", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] })];
    const ai = fakeAi({ routes: { routes } });
    const read = ran(await readCode(walk(), ai, repo(FILES)));
    assert.equal(ai.sent.filter((q) => q.includes("Screen: /ledger")).length, 1);
    assert.deepEqual(read.signedInPaths, ["/ledger", "/ledger/old"]);
    assert.equal(read.fromCode.screens.find((s) => s.path === "/ledger/:tab")!.buttons.length, 0);
    assert.equal(read.fromCode.actions.length, 1);
  });

  it("doesn't keep a tab of a page that couldn't be read", async () => {
    const routes = [...GOOD_ROUTES.slice(0, 3), route({ path: "/ledger/old", access: "signed-in", file: "src/App.tsx", quote: 'case "ledger": return <Ledger />;', files: ["src/Ledger.tsx"] }), GOOD_ROUTES[3]!];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes }, screens: { "/ledger": { ...empty, live: false } } }), repo(FILES)));
    assert.deepEqual(read.signedInPaths, []);
    assert.ok(!read.fromCode.screens.some((s) => s.path === "/ledger/old"));
    assert.ok(read.fromCode.coverage.screensSkipped.some((s) => s.path === "/ledger/old"));
  });

  it("reads 15 screens at most, says which it skipped, and still gives the stand-in the rest", async () => {
    const pages = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`src/P${i}.tsx`, `export const P${i} = () => <h1>Page number ${i} here</h1>;\n`]));
    const app = `const routes = [${Array.from({ length: 18 }, (_, i) => `["/p${i}", P${i}, "live"]`).join(", ")}];\n`;
    const routes = Array.from({ length: 18 }, (_, i) => route({ path: `/p${i}`, access: "signed-in", file: "src/App.tsx", quote: `["/p${i}", P${i}, "live"]`, files: [`src/P${i}.tsx`] }));
    const all = [...GOOD_ROUTES.slice(0, 2), ...routes];
    const screens = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`/p${i}`, { ...empty, title: { text: `Page number ${i} here`, file: `src/P${i}.tsx`, quote: `<h1>Page number ${i} here</h1>` } }]));
    const lines: string[] = [];
    const read = ran(await readCode(walk(), fakeAi({ routes: { routes: all }, screens }), repo({ ...FILES, ...pages, "src/App.tsx": `${APP}${app}` }), { onProgress: (line) => lines.push(line) }));
    assert.equal(read.fromCode.screens.length, 15);
    assert.equal(read.fromCode.coverage.screensSkipped.length, 3);
    assert.equal(read.signedInPaths.length, 18);
    assert.ok(lines.some((line) => /^Reading the code: screen 15 of 15, under a minute left$/.test(line)), lines.join("\n"));
  });

  /** Twelve screens to read, each answer `wait` ms after it was asked, with what's out at one time counted. */
  function twelve(wait: (path: string) => number = () => 30, fails?: (path: string, tries: number) => string | undefined) {
    const pages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/P${i}.tsx`, `export const P${i} = () => <h1>Page number ${i} here</h1>;\n`]));
    const app = `const routes = [${Array.from({ length: 12 }, (_, i) => `["/p${i}", P${i}, "live"]`).join(", ")}];\n`;
    const routes = [...GOOD_ROUTES.slice(0, 2), ...Array.from({ length: 12 }, (_, i) => route({ path: `/p${i}`, access: "signed-in", file: "src/App.tsx", quote: `["/p${i}", P${i}, "live"]`, files: [`src/P${i}.tsx`] }))];
    const screens = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/p${i}`, { ...empty, title: { text: `Page number ${i} here`, file: `src/P${i}.tsx`, quote: `<h1>Page number ${i} here</h1>` } }]));
    const inner = fakeAi({ routes: { routes }, screens });
    const tries = new Map<string, number>();
    const seen = { most: 0, out: 0 };
    const ai = { ...inner, allAtOnce: true, ask: async (system: string, question: string, schema: object) => {
      const path = /^Screen: (\S+)/.exec(question)?.[1];
      if (!path) return inner.ask(system, question, schema);
      seen.most = Math.max(seen.most, ++seen.out);
      tries.set(path, (tries.get(path) ?? 0) + 1);
      await new Promise((go) => setTimeout(go, wait(path)));
      seen.out--;
      const refused = fails?.(path, tries.get(path)!);
      if (refused) throw new Error(refused);
      return inner.ask(system, question, schema);
    } };
    return { ai, seen, tries, folder: repo({ ...FILES, ...pages, "src/App.tsx": `${APP}${app}` }) };
  }

  it("stops at its time limit with what's back, and the next run reads only what's left", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "read.json");
    made.push(dirname(cacheFile));
    const slow = twelve((path) => (Number(path.slice(2)) < 3 ? 1 : 2000));
    const began = Date.now();
    const first = ran(await readCode(walk(), slow.ai, slow.folder, { cacheFile, screensMostMs: 150, atOnce: 3 }));
    assert.ok(Date.now() - began < 1500, "the run doesn't wait for a late answer");
    const late = first.fromCode.coverage.screensSkipped.filter((s) => s.why.startsWith("out of time"));
    assert.equal(late.length, 9);
    assert.equal(first.fromCode.screens.filter((s) => s.buttons.length || /Page number/.test(s.name)).length, 3);
    assert.ok(first.signedInPaths.length >= 3);

    const quick = twelve(() => 1);
    const second = ran(await readCode(walk(), quick.ai, slow.folder, { cacheFile, atOnce: 3 }));
    assert.equal(second.fromCode.coverage.screensSkipped.length, 0);
    assert.equal([...quick.tries.keys()].length, 9, "the three that came back aren't asked again");
  });

  it("keeps an answer that came after the limit for the next run, through the same checks", async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), "cm-cache-")), "read.json");
    made.push(dirname(cacheFile));
    const slow = twelve((path) => (Number(path.slice(2)) < 3 ? 1 : 300));
    const first = ran(await readCode(walk(), slow.ai, slow.folder, { cacheFile, screensMostMs: 100 }));
    assert.equal(first.fromCode.coverage.screensSkipped.filter((s) => s.why.startsWith("out of time")).length, 9, "this run's read is as it was");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const quick = twelve(() => 1);
    const second = ran(await readCode(walk(), quick.ai, slow.folder, { cacheFile }));
    assert.equal(second.fromCode.coverage.screensSkipped.length, 0);
    assert.equal([...quick.tries.keys()].filter((key) => key.startsWith("/")).length, 0, "no screen is asked again");
  });

  it("reads every screen at once, and tells how far it is and roughly how long is left from the first line on", async () => {
    const { ai, seen, folder } = twelve();
    const lines: string[] = [];
    ran(await readCode(walk(), ai, folder, { onProgress: (line) => lines.push(line) }));
    assert.equal(seen.most, 12);
    assert.ok(lines.includes("Reading the code: 12 screens to read, 12 at a time"), lines.join("\n"));
    assert.equal(lines.filter((line) => /^Reading the code: screen \d+ of 12, (under a minute|about \d+ min) left$/.test(line)).length, 12);
  });

  it("asks six screens at a time of an AI that hasn't said it takes them all at once", async () => {
    const { ai, seen, folder } = twelve();
    const lines: string[] = [];
    ran(await readCode(walk(), { ...ai, allAtOnce: false }, folder, { onProgress: (line) => lines.push(line) }));
    assert.equal(seen.most, 6);
    assert.ok(lines.includes("Reading the code: 12 screens to read, 6 at a time"), lines.join("\n"));
  });

  it("says the same thing and keeps the same read however the answers come back", async () => {
    // The trap: a screen left out, in an order that depends on who answered first.
    const fails = (path: string) => (path === "/p1" || path === "/p7" ? "the model went away" : undefined);
    const one = twelve(() => 1, fails);
    const a = ran(await readCode(walk(), one.ai, one.folder, { atOnce: 1 }));
    const four = twelve((path) => 40 - Number(path.slice(2)) * 3, fails);
    const b = ran(await readCode(walk(), four.ai, four.folder, { atOnce: 4 }));
    assert.deepEqual(b.fromCode, a.fromCode);
    assert.deepEqual(b.signedInPaths, a.signedInPaths);
    assert.deepEqual(b.fromCode.coverage.screensSkipped.map((s) => s.path), ["/p1", "/p7"]);
    assert.deepEqual(b.fromCode.screens.slice(0, 3).map((s) => s.path), ["/p0", "/p2", "/p3"]);
  });

  it("waits and asks again when the AI says to slow down, but not for any other failure", async () => {
    const slowed = twelve(() => 1, (path, tries) => (path === "/p3" && tries === 1 ? "Anthropic said 429: slow down" : undefined));
    const began = Date.now();
    const read = ran(await readCode(walk(), slowed.ai, slowed.folder, { rateWaitMs: 60 }));
    assert.ok(Date.now() - began >= 60);
    assert.equal(slowed.tries.get("/p3"), 2);
    assert.deepEqual(read.fromCode.coverage.screensSkipped, []);
    const broken = twelve(() => 1, (path) => (path === "/p3" ? "the answer wasn't JSON" : undefined));
    const lost = ran(await readCode(walk(), broken.ai, broken.folder, { rateWaitMs: 60 }));
    assert.equal(broken.tries.get("/p3"), 1);
    assert.deepEqual(lost.fromCode.coverage.screensSkipped.map((s) => s.path), ["/p3"]);
  });

  it("says rough time left in rough words", () => {
    assert.equal(timeLeft(20_000), "under a minute left");
    assert.equal(timeLeft(61_000), "about 2 min left");
  });
});

describe("usableCodeRead", () => {
  const file = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cm-read-"));
    made.push(dir);
    writeFileSync(join(dir, "read.json"), text);
    return join(dir, "read.json");
  };

  it("calls a read of an older version, half a read, or none at all a first read", () => {
    assert.equal(usableCodeRead(file(JSON.stringify({ key: "k", read: {}, parts: {} }))), false);
    assert.equal(usableCodeRead(file(JSON.stringify({ v: 1, key: "k", read: {}, parts: {} }))), false);
    assert.equal(usableCodeRead(file(JSON.stringify({ parts: {} }))), false);
    assert.equal(usableCodeRead(file("not json")), false);
    assert.equal(usableCodeRead(join(tmpdir(), "cm-no-such-file.json")), false);
  });
});

describe("linkedRows", () => {
  const table = (name: string, rows: Sample["rows"]): Pick<Sample, "kind" | "name" | "rows"> => ({ kind: "table", name, rows });

  it("points rows asked about apart at rows that exist", () => {
    const [accounts, trades] = linkedRows([table("accounts", [{ id: "a1" }, { id: "a2" }]), table("trades", [{ id: "t1", account_id: "x" }, { id: "t2", account_id: "y" }, { id: "t3", account_id: "z" }])]);
    assert.deepEqual(accounts!.rows, [{ id: "a1" }, { id: "a2" }]);
    assert.deepEqual(trades!.rows.map((row) => row.account_id), ["a1", "a2", "a1"]);
  });

  it("handles a plural in -ies, and leaves anything else as invented", () => {
    const [, entries, other] = linkedRows([table("daily_entries", [{ id: "e1" }]), table("notes", [{ daily_entry_id: "x", owner_id: "kept" }]), { kind: "endpoint", name: "/api/x", rows: [{ daily_entry_id: "kept" }] }]);
    assert.equal(entries!.rows[0]!.daily_entry_id, "e1");
    assert.equal(entries!.rows[0]!.owner_id, "kept");
    assert.equal(other!.rows[0]!.daily_entry_id, "kept");
  });

  it("leaves a table's own column alone", () => {
    const [nodes] = linkedRows([table("nodes", [{ id: "n1", node_id: "n2" }, { id: "n2", node_id: "n1" }])]);
    assert.deepEqual(nodes!.rows.map((row) => row.node_id), ["n2", "n1"]);
  });
});

describe("text read from the code, cut to its room", () => {
  it("cuts after the last whole sentence, else after a whole word with …, never mid-word", () => {
    assert.equal(clip("Short.", 20), "Short.");
    assert.equal(clip("It reads the trades a person adds. Then it compares them with the patterns it knows.", 60), "It reads the trades a person adds.");
    assert.equal(clip("It reads trades. Then it compares them with the patterns it knows, so this covers only that path.", 60), "It reads trades. Then it compares them with the patterns…", "a sentence that ends early would lose most of it");
    assert.equal(clip("It reads trades and compares them with the patterns it knows, so this covers only that path", 60), "It reads trades and compares them with the patterns it…");
  });
});

