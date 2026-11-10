/**
 * Struggle benchmark: scripted users with KNOWN struggles act on a real page
 * running the real built snippet in headless Chromium. Detected struggles are
 * scored against the labels, including a calm user who must trigger nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Struggle = { type: string; target?: string; page: string };
const SNIPPET = fileURLToPath(new URL("../../snippet/dist/snippet.min.js", import.meta.url));
const collected = new Map<string, Struggle[]>();
let server: Server;
let base = "";
let browser: Browser;

const page = (body: string) => `<!doctype html><html><head><title>Bank</title></head><body>${body}
<script>window.__ctx = { q: [["init", { key: "pk_test_benchmark001", endpoint: "/collect", ui: false, userId: new URLSearchParams(location.search).get("u") || "anon" }]] };</script>
<script src="/snippet.js"></script></body></html>`;

const BANK = page(`
  <h1>Connect your bank</h1>
  <form name="bank" id="f">
    <label>Server <input name="server" required></label>
    <label>Login ID <input name="login_id" required></label>
    <button type="submit">Connect</button>
  </form>
  <span role="button" id="export" tabindex="0">Export</span>
  <a href="/home" id="away">Home</a>
  <script>
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      fetch("/api/connect", { method: "POST", body: JSON.stringify({ server: "x" }) }).then(() => { document.body.dataset.connected = "1"; });
    });
  </script>`);

beforeAll(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../snippet/build.mjs", import.meta.url))], { stdio: "ignore" });
  const snippet = readFileSync(SNIPPET, "utf8");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/snippet.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(snippet);
      if (url.pathname === "/collect") {
        try {
          const batch = JSON.parse(body) as { userId?: string; events: (Struggle & { kind: string })[] };
          const list = collected.get(batch.userId ?? "anon") ?? [];
          list.push(...batch.events.filter((e) => e.kind === "struggle").map(({ type, target, page: p }) => ({ type, page: p, ...(target ? { target } : {}) })));
          collected.set(batch.userId ?? "anon", list);
        } catch {
          /* ignore */
        }
        return res.writeHead(202).end();
      }
      if (url.pathname === "/api/connect") return res.writeHead(201, { "content-type": "application/json" }).end("{}");
      if (url.pathname === "/home") return res.writeHead(200, { "content-type": "text/html" }).end(page("<h1>Home</h1>"));
      return res.writeHead(200, { "content-type": "text/html" }).end(BANK);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function asUser(user: string, act: (p: Page) => Promise<void>): Promise<Struggle[]> {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(`${base}/settings/bank?u=${user}`);
  await p.waitForFunction(() => (window as unknown as { __ctx?: { handle?: unknown } }).__ctx?.handle !== undefined);
  await act(p);
  // Flush: navigate away (pagehide → sendBeacon), then give the collector a moment.
  if (!p.url().includes("/home")) await p.click("#away");
  await p.waitForLoadState("load");
  await p.waitForTimeout(300);
  await context.close();
  return collected.get(user) ?? [];
}

const types = (s: Struggle[]) => [...new Set(s.map((x) => x.type))].sort();

describe("struggle benchmark (real snippet, real browser)", () => {
  const results: { user: string; expected: string[]; detected: string[] }[] = [];
  const check = (user: string, expected: string[], detected: Struggle[]) => {
    results.push({ user, expected, detected: types(detected) });
    expect(types(detected)).toEqual(expected);
  };

  it("hesitant: hovers Connect three times without pressing", async () => {
    const s = await asUser("hesitant", async (p) => {
      for (let i = 0; i < 3; i++) {
        await p.hover("button[type=submit]");
        await p.waitForTimeout(150);
        await p.mouse.move(5, 5);
        await p.waitForTimeout(100);
      }
    });
    check("hesitant", ["hesitation"], s);
    expect(s.find((x) => x.type === "hesitation")?.target).toBe("Connect");
  }, 30_000);

  it("frustrated: rapid clicks on an Export control that does nothing", async () => {
    const s = await asUser("frustrated", async (p) => {
      for (let i = 0; i < 4; i++) await p.click("#export", { delay: 20 });
      await p.waitForTimeout(1300);
    });
    check("frustrated", ["dead_click", "rage_click"], s);
  }, 30_000);

  it("abandoner: fills two fields then leaves", async () => {
    const s = await asUser("abandoner", async (p) => {
      await p.fill("input[name=server]", "MetaQuotes-Demo");
      await p.fill("input[name=login_id]", "12345");
    });
    check("abandoner", ["form_abandon"], s);
    expect(JSON.stringify(s)).not.toMatch(/MetaQuotes|12345/);
  }, 30_000);

  it("confused: tries to submit twice with required fields empty", async () => {
    const s = await asUser("confused", async (p) => {
      await p.click("button[type=submit]");
      await p.waitForTimeout(500);
      await p.click("button[type=submit]");
      await p.waitForTimeout(300);
    });
    check("confused", ["validation_loop"], s);
  }, 30_000);

  it("calm: fills the form and connects; triggers nothing", async () => {
    const s = await asUser("calm", async (p) => {
      await p.fill("input[name=server]", "MetaQuotes-Demo");
      await p.fill("input[name=login_id]", "12345");
      await p.click("button[type=submit]");
      await p.waitForSelector("body[data-connected='1']");
    });
    check("calm", [], s);
  }, 30_000);

  // Normal behaviour that must NOT be mistaken for struggle: false alarms are what would make help a nuisance.
  const fillAndConnect = async (p: Page) => {
    await p.fill("input[name=server]", "MetaQuotes-Demo");
    await p.fill("input[name=login_id]", "12345");
  };

  it("skimmer: sweeps the mouse over each control once, then leaves", async () => {
    const s = await asUser("skimmer", async (p) => {
      await p.hover("button[type=submit]");
      await p.hover("#export");
      await p.hover("#away");
      await p.mouse.move(5, 5);
    });
    check("skimmer", [], s);
  }, 30_000);

  it("typo fixer: corrects a field once while typing, then connects", async () => {
    const s = await asUser("typo-fixer", async (p) => {
      await p.click("input[name=server]");
      await p.keyboard.type("MetaQoutes", { delay: 30 });
      await p.waitForTimeout(400);
      for (let i = 0; i < 5; i++) await p.keyboard.press("Backspace");
      await p.keyboard.type("uotes-Demo", { delay: 30 });
      await p.fill("input[name=login_id]", "12345");
      await p.click("button[type=submit]");
      await p.waitForSelector("body[data-connected='1']");
    });
    check("typo-fixer", [], s);
  }, 30_000);

  it("double-clicker: double-clicks Connect on a complete form", async () => {
    const s = await asUser("double-clicker", async (p) => {
      await fillAndConnect(p);
      await p.dblclick("button[type=submit]");
      await p.waitForSelector("body[data-connected='1']");
      await p.waitForTimeout(1300);
    });
    check("double-clicker", [], s);
  }, 30_000);

  it("reader: rests on Connect for two seconds, then presses it", async () => {
    const s = await asUser("reader", async (p) => {
      await fillAndConnect(p);
      await p.hover("button[type=submit]");
      await p.waitForTimeout(2000);
      await p.click("button[type=submit]");
      await p.waitForSelector("body[data-connected='1']");
    });
    check("reader", [], s);
  }, 30_000);

  it("decider: hovers Connect twice, then goes ahead", async () => {
    const s = await asUser("decider", async (p) => {
      await fillAndConnect(p);
      for (let i = 0; i < 2; i++) {
        await p.hover("button[type=submit]");
        await p.waitForTimeout(150);
        await p.mouse.move(5, 5);
      }
      await p.click("button[type=submit]");
      await p.waitForSelector("body[data-connected='1']");
    });
    check("decider", [], s);
  }, 30_000);

  it("browser: reads the page for a few seconds, then moves on without touching the form", async () => {
    const s = await asUser("browser", async (p) => {
      await p.waitForTimeout(3500);
    });
    check("browser", [], s);
  }, 30_000);

  it("reports precision and recall across all scripted users", () => {
    let tp = 0, fp = 0, fn = 0;
    for (const r of results) {
      for (const d of r.detected) (r.expected.includes(d) ? tp++ : fp++);
      for (const e of r.expected) if (!r.detected.includes(e)) fn++;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const normal = results.filter((r) => r.expected.length === 0);
    const falseAlarmRate = normal.filter((r) => r.detected.length > 0).length / Math.max(1, normal.length);
    console.log(JSON.stringify({ benchmark: "struggle", users: results.length, normalUsers: normal.length, precision, recall, falseAlarmRate, results }));
    expect(normal.length).toBeGreaterThanOrEqual(7);
    expect(falseAlarmRate).toBe(0);
    expect(precision).toBe(1);
    expect(recall).toBe(1);
  });
});
