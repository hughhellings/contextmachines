import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { scanSite } from "../src/scan.ts";
import { page, startRecordingSite, type RecordingSite } from "./readonly-app.ts";

/** How the browser is started and stopped: its sandbox, its credentials, a page that hangs, a real Ctrl-C. */
const open: RecordingSite[] = [];
const started = (site: RecordingSite) => (open.push(site), site);
afterAll(() => Promise.all(open.map((s) => s.close())));
afterEach(() => vi.restoreAllMocks());
const html = (res: import("node:http").ServerResponse, body: string) => void res.writeHead(200, { "content-type": "text/html" }).end(body);
const plain = () => startRecordingSite((_req, res) => html(res, page("Home", "<p>Hello there</p>")));

describe("the browser's launch", () => {
  it("asks for the sandbox, and leaves signals to the command", async () => {
    const launch = vi.spyOn(chromium, "launch");
    const site = started(await plain());
    await scanSite({ startUrl: site.url, maxPages: 1, maxDurationMs: 5000, delayMs: 0, screenshots: false });
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  }, 20_000);

  it("where the sandbox can't start, goes on without it and says so once", async () => {
    const real = chromium.launch.bind(chromium);
    const launch = vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
      if (options?.chromiumSandbox) throw new Error("No usable sandbox!");
      return real(options);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const site = started(await plain());
    const r = await scanSite({ startUrl: site.url, maxPages: 1, maxDurationMs: 5000, delayMs: 0, screenshots: false });
    expect(r.pagesVisited).toEqual(["/"]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/sandbox/);
  }, 20_000);

  it("a browser that can't start at all isn't blamed on the sandbox", async () => {
    vi.spyOn(chromium, "launch").mockRejectedValue(new Error("Executable doesn't exist"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(scanSite({ startUrl: "http://127.0.0.1:9/" })).rejects.toThrow(/Executable/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("credentials in the start address", () => {
  it("go to the browser apart, so the app can fetch, and only to that origin", async () => {
    const authed: string[] = [];
    const site = started(await startRecordingSite((req, res, url) => {
      if (req.headers.authorization !== `Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`) return void res.writeHead(401, { "www-authenticate": 'Basic realm="x"' }).end();
      authed.push(url.pathname);
      if (url.pathname === "/api/nav") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(["/dashboard", "/reports"]));
      if (url.pathname !== "/") return html(res, page(url.pathname.slice(1), "<p>A screen</p>"));
      html(res, page("Home", `<nav id="nav"></nav><p id="where"></p><script>
        where.textContent = location.href;
        fetch("/api/nav").then((r) => r.json()).then((links) => { for (const l of links) nav.insertAdjacentHTML("beforeend", '<a href="' + l + '">' + l.slice(1) + "</a>"); });
      </script>`));
    }));
    const r = await scanSite({ startUrl: site.url.replace("//", "//alice:s3cr3t@"), maxPages: 4, maxDurationMs: 15_000, delayMs: 0, screenshots: false });
    expect(r.findings).toEqual([]);
    expect(r.pagesVisited).toEqual(expect.arrayContaining(["/", "/dashboard", "/reports"]));
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
    expect(authed).toContain("/api/nav");
  }, 30_000);
});

describe("a page that hangs", () => {
  it("a press that never returns is ended, and the run goes on to the next screen", async () => {
    const site = started(await startRecordingSite((_req, res, url) => {
      if (url.pathname === "/next") return html(res, page("Next", "<p>Reached</p>"));
      html(res, page("Home", `<a href="/next">Next</a><button onclick="for(;;){}">Recalculate</button>`));
    }));
    const r = await scanSite({ startUrl: site.url, maxPages: 3, maxDurationMs: 40_000, delayMs: 0, screenshots: false });
    expect(r.pagesVisited).toContain("/next");
    expect(r.errors.some((e) => /stopped responding/.test(e))).toBe(true);
    expect(r.stoppedBy).toBe("complete");
  }, 70_000);

  it("a page that hangs again and again ends the run at its limit, with what it has", async () => {
    const site = started(await startRecordingSite((_req, res) => html(res, page("Spin", `<p>Spinning soon</p><script>setInterval(() => { for (;;) {} }, 50)</script>`))));
    const from = Date.now();
    const r = await scanSite({ startUrl: site.url, maxPages: 3, maxDurationMs: 4000, delayMs: 0, screenshots: false });
    expect(Date.now() - from).toBeLessThan(4000 + 20_000 + 8000);
    expect(r.stoppedBy).toBe("max_duration");
  }, 60_000);
});

describe("stopping the command", () => {
  const cli = fileURLToPath(new URL("../../../cli/contextmachines.ts", import.meta.url));

  it.each(["SIGINT", "SIGTERM"] as const)("%s writes what it learned so far and exits as interrupted", async (signal) => {
    const site = started(await startRecordingSite((_req, res, url) => {
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/s${i}">Screen ${i}</a>`).join(" ");
      html(res, page(`Page ${url.pathname}`, `<p>Some words about this page.</p>${links}`));
    }));
    const out = mkdtempSync(join(tmpdir(), "learn-stop-"));
    const child = spawn(process.execPath, [cli, "learn", site.url, "--out", out, "--minutes", "1", "--ai", "none", "--verbose"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let said = "";
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        said += chunk.toString();
        // The public pages begin at the first screen seen: something has been learned to write.
        if (/\[?public\]?\s+started/.test(said.replace(/\x1b\[[0-9;]*m/g, ""))) resolve();
      });
      child.stderr.on("data", (chunk: Buffer) => void (said += chunk.toString()));
      void exited.then(() => resolve());
    });
    child.kill(signal);
    const code = await exited;
    expect(code, said).toBe(130);
    expect(existsSync(join(out, "PRODUCT.md")), said).toBe(true);
    const map = JSON.parse(readFileSync(join(out, "map.json"), "utf8")) as { learner: { stoppedBy: string } };
    expect(map.learner.stoppedBy).toBe("interrupted");
    rmSync(out, { recursive: true, force: true });
  }, 60_000);
});
