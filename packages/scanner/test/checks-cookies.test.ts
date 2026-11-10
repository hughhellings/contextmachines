import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A cookie banner of an app's own: a plain box with no name, coming late and sliding in, answered
 * once and then gone for the whole run. So what it sits on elsewhere can only be seen by bringing
 * it back, and it's measured where it really is. A screen that never draws it, with a field in the
 * same place, must stay quiet, and a banner with nothing under it isn't an item.
 */
const banner = `<script>
  if (!localStorage.getItem("choice")) setTimeout(() => {
    const box = document.createElement("div");
    box.style = "position:fixed;left:100px;width:700px;bottom:16px;height:90px;background:#222;color:#fff;transform:translateY(120px);transition:transform .2s";
    box.innerHTML = '<p>We use cookies to understand visits.</p><button id="no">Reject non-essential cookies</button> <button id="yes">Accept all cookies</button>';
    document.body.appendChild(box);
    requestAnimationFrame(() => requestAnimationFrame(() => { box.style.transform = "none"; }));
    box.querySelector("#no").onclick = () => { localStorage.setItem("choice", "no"); box.remove(); };
    box.querySelector("#yes").onclick = () => { localStorage.setItem("choice", "yes"); box.remove(); };
  }, 300);
</script>`;
const page = (title: string, body: string, head = banner) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>${title}</h1>${body}${head}</body></html>`;
const words = "<p>Words on the page so it is one, with enough of them to read as a page of the product.</p>";
const box = (name: string) => `<textarea aria-label="${name}" style="position:fixed;left:150px;bottom:40px;width:500px;height:60px;box-sizing:border-box"></textarea>`;

const pages: Record<string, string> = {
  "/": page("Home", `${words}<a href="/message">Message</a> <a href="/app">App</a> <a href="/other">Other</a>`),
  "/message": page("Message", `${words}${box("Message box")}`),
  // The app's own layout, which never draws the banner, with a box in the very same place.
  "/app": page("App", `${words}${box("App box")}`, ""),
  "/other": page("Other", `${words}<button>Save</button>`),
};

let site: Server;
let result: ScanResult;
const said: string[] = [];

beforeAll(async () => {
  site = createServer((req, res) => {
    const html = pages[new URL(req.url ?? "/", "http://x").pathname];
    res.writeHead(html ? 200 : 404, { "content-type": html ? "text/html" : "text/plain" }).end(html ?? "no");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(site.address() as AddressInfo).port}/`, maxPages: 8, maxDurationMs: 40_000, delayMs: 0, exploreButtons: false, learnActions: false, onScreen: (path) => said.push(path) });
}, 60_000);
afterAll(() => new Promise<void>((resolve) => site.close(() => resolve())));

describe("a cookie banner", () => {
  it("is reported over the message box, measured there with the banner brought back", () => {
    const [item] = result.checks.filter((c) => c.kind === "covered" && c.target === "Message box");
    expect(item).toMatchObject({ cookieBanner: true, at: "desktop", screen: "/message" });
    expect(item?.by).toMatch(/cookies/);
    expect(item?.byWords?.length).toBeGreaterThan(1);
    expect(item?.proof?.length).toBeGreaterThan(0);
  });

  it("isn't reported on a screen that never draws it, though a box sits in the same place", () => {
    expect(result.pagesVisited).toContain("/app");
    expect(result.checks.filter((c) => c.screens.includes("/app"))).toEqual([]);
  });

  it("isn't an item where it covers nothing", () => {
    expect(result.checks.filter((c) => c.screens.includes("/") || c.screens.includes("/other"))).toEqual([]);
  });

  it("is answered the private way, so it isn't on the screens read", () => {
    for (const path of ["/", "/message", "/other"]) expect(result.reviews.find((r) => r.path === path)?.text.join(" ")).not.toMatch(/cookies/);
  });
});
