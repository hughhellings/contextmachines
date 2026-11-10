import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanConfig, type ScanResult } from "../src/scan.ts";

/**
 * What a real session's screens hand on. FIX.md is committed and handed to another AI, and the
 * review goes to this one, so a customer's line drawn on a real account stays behind: a run with
 * --login, --session or --create is all the same here, as each shows what's really there.
 */
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;font-family:Arial,sans-serif}</style></head><body><h1>${title}</h1><main>${body}</main></body></html>`;
const filler = "<p>Words on the page so it is one, with enough of them to read as a page of the product.</p>".repeat(3);

const pages: Record<string, string> = {
  "/": page("Account 7741", `${filler}<a href="/wording">Wording</a> <a href="/covered">Covered</a> <a href="/wide">Wide</a> <a href="/off">Off</a> <a href="/summary">Summary</a>`),
  "/wording": page("Wording", `${filler}<p>Acme Ltd — 1 open invoices — $4,120 overdue</p><p>Balance for Jane Doe: undefined</p><p>Hi {{name}}, jane@acme.com</p>`),
  "/covered": page("Covered", `${filler}<textarea aria-label="Note for 4410" style="position:fixed;left:40px;bottom:20px;width:400px;height:40px"></textarea><div style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#222;color:#fff">Balance due 8812</div>`),
  "/wide": page("Wide", `${filler}<div style="width:900px;background:#eee">Statement 5521 runs wide</div>`),
  "/off": `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{overflow-x:hidden;margin:0}</style></head><body><h1>Off</h1><main>${filler}<div style="display:flex;width:1100px;justify-content:space-between"><span>Left</span><a href="/">Pay 6630 now</a></div></main></body></html>`,
  "/summary": page("Summary", `${filler}<div><p>No invoices yet for 3307</p><button>Email 9914</button></div>`),
};

let site: Server;
let session: string;
const run = (more: Partial<ScanConfig>) => scanSite({ startUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, maxPages: 10, maxDurationMs: 45_000, delayMs: 0, exploreButtons: false, learnActions: false, ...more });
const drawnDigits = /7741|4,120|4410|8812|5521|6630|3307|9914/;

beforeAll(async () => {
  site = createServer((req, res) => void res.writeHead(pages[req.url ?? "/"] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url ?? "/"] ?? "gone"));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  session = join(mkdtempSync(join(tmpdir(), "cm-real-session-")), "session.json");
  writeFileSync(session, JSON.stringify({ cookies: [], origins: [] }));
});
afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

describe.each([["a signed-in session", () => ({ storageState: session })], ["--create", () => ({ realWrites: true })]])("on %s", (_name, more) => {
  let result: ScanResult;
  beforeAll(async () => {
    result = await run(more());
  }, 60_000);

  it("keeps only the broken phrase of a drawn line, never the line", () => {
    const wording = result.checks.filter((c) => c.kind === "wording");
    expect(wording.map((c) => c.target).sort()).toEqual(["1 open invoices", "undefined", "{{name}}"].sort());
    expect(JSON.stringify(result.checks.map(({ proof: _proof, ...check }) => check))).not.toMatch(/Acme|Jane|jane@|4,120/);
  });

  it("masks digits in what's measured: the labels and what's on top", () => {
    const of = (kind: string) => result.checks.filter((c) => c.kind === kind);
    expect(of("covered").map((c) => [c.target, c.by, c.byWords])).toContainEqual(["Note for ####", "Balance due ####", ["Balance due ####"]]);
    expect(of("overflow").map((c) => c.target)).toContainEqual(expect.stringContaining("Statement #### runs wide"));
    expect(of("unreachable").map((c) => c.target)).toContain("Pay #### now");
  });

  it("sends no drawn text to the AI, and masks what does go, an empty state's action too", () => {
    const empty = result.reviews.find((r) => r.path === "/summary");
    expect(empty?.text).toEqual([]);
    expect(empty?.empty).toContainEqual({ text: "No invoices yet for ####", next: "Email ####" });
    const front = result.reviews.find((r) => r.path === "/");
    expect(front?.heading).toBe("Account ####");
    expect(JSON.stringify(result.reviews)).not.toMatch(drawnDigits);
  });

  it("masks the digits in the headings that go to the first question too", () => {
    const front = result.events.flatMap((e) => (e.kind === "page" ? [JSON.stringify(e)] : [])).join(" ");
    expect(front).not.toMatch(/7741/);
    expect(front).toContain("Account");
  });
});

describe("what a press or a page's log says, on a real session", () => {
  const acts = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acts</title></head><body><h1>Acts</h1><main>${filler}<button>Refund 4120 to Jane</button><button onclick="throw new Error('No invoice 7741 here')">Open 5512 now</button><script src="/logs.js"></script></main></body></html>`;
  let server: Server;
  const scan = (more: Partial<ScanConfig>) => scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 3, maxDurationMs: 45_000, delayMs: 0, exploreButtons: true, learnActions: false, ...more });
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/logs.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end('console.error("Could not load statement 8812 for this account");');
      res.writeHead(200, { "content-type": "text/html" }).end(acts);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("masks digits in a dead button's label, an error, what was pressed before it, and a logged line", async () => {
    const result = await scan({ storageState: session });
    const of = (kind: string) => result.findings.filter((f) => f.kind === kind);
    expect(of("does_nothing").map((f) => f.target)).toContain("Refund #### to Jane");
    expect(of("crashes").map((f) => [f.target, f.after])).toContainEqual(["Error: No invoice #### here", "Open #### now"]);
    expect(result.checks.filter((c) => c.kind === "console_error").map((c) => c.target)).toEqual(["Could not load statement #### for this account"]);
    expect(JSON.stringify([result.findings, result.checks.map(({ proof: _proof, ...check }) => check)])).not.toMatch(/4120|7741|5512|8812/);
  }, 60_000);

  it("keeps them with no real session", async () => {
    const result = await scan({});
    expect(result.findings.map((f) => f.target)).toContain("Refund 4120 to Jane");
    expect(result.checks.filter((c) => c.kind === "console_error").map((c) => c.target)).toEqual(["Could not load statement 8812 for this account"]);
  }, 60_000);
});

describe("with no real session", () => {
  it("keeps the whole line and every digit, as it's the page's own", async () => {
    const result = await run({});
    expect(result.checks.filter((c) => c.kind === "wording").map((c) => c.target)).toContain("Acme Ltd — 1 open invoices — $4,120 overdue");
    expect(result.reviews.find((r) => r.path === "/")?.heading).toBe("Account 7741");
  }, 60_000);
});
