import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A single-page app whose start is a sign-in screen, and whose other ways on aren't links: "Forgot
 * your password?" is a line of text that routes on click (as Vue and React sign-in pages often
 * draw it), and "Continue with Google" is a clickable box. The first is explored like a link, so
 * the reset screen is learned (its address says "reset": the site's own navigation took it there);
 * the second, which signs in elsewhere, is never pressed.
 */
let server: http.Server;
let result: ScanResult;
const visits: string[] = [];

const app = `<!doctype html><html lang="en"><head><title>Acme HR</title><style>.link { cursor: pointer; color: blue }</style></head><body><div id="app"></div><script>
  const draw = () => {
    if (location.pathname === "/reset") {
      app.innerHTML = '<h1>Reset password</h1><form><label>Username <input name="username"></label><button>Reset password</button></form>';
      return;
    }
    app.innerHTML = '<h1>Login</h1><form method="post" action="/auth/validate"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button>Login</button></form>'
      + '<p class="link" id="forgot">Forgot your password?</p><div class="link" id="google">Continue with Google</div>';
    document.getElementById("forgot").addEventListener("click", () => { history.pushState({}, "", "/reset"); draw(); });
    document.getElementById("google").addEventListener("click", () => { location.href = "/oauth/google"; });
  };
  draw();
</script></body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    visits.push(`${req.method} ${path}`);
    res.setHeader("content-type", "text/html");
    res.end(app);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await scanSite({ startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, maxPages: 5, maxDurationMs: 25_000, delayMs: 0, screenshots: false });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a sign-in screen whose ways on aren't links", () => {
  it("learns the screen a clickable line of text leads to", () => {
    expect(result.pagesVisited).toEqual(expect.arrayContaining(["/", "/reset"]));
    expect(result.foundByButtons).toContain("/reset");
  });

  it("never presses what signs in elsewhere, nor sends the sign-in", () => {
    expect(visits.some((v) => v.includes("/oauth"))).toBe(false);
    expect(visits.filter((v) => !v.startsWith("GET"))).toEqual([]);
  });
});
