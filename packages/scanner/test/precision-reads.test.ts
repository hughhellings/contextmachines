import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, pad, page, quick, serve } from "./precision-site.ts";

/**
 * A read answered 404 is often how an app says "none yet". What's provable is a framework's own error
 * page, or the page then saying so; and an image of the site's own on show, broken.
 */
const failed = (r: ScanResult) => r.findings.filter((f) => f.kind === "request_fails").map((f) => f.target);
let reads: ScanResult;
let images: ScanResult;

beforeAll(async () => {
  const app = await serve((_req, res, url) => {
    const fail = (type: string | undefined, body: string) => void res.writeHead(404, type ? { "content-type": type } : {}).end(body);
    if (url.pathname === "/api/plain") return fail("text/plain", "Not Found"); // Express's sendStatus(404)
    if (url.pathname === "/api/empty") return fail(undefined, "");
    if (url.pathname === "/api/words") return fail("text/html; charset=utf-8", "Not found"); // res.status(404).send("Not found")
    if (url.pathname === "/api/shown") return fail("text/plain", "Not Found");
    if (url.pathname === "/api/typo") return fail("text/html", "<!doctype html><html><body><pre>Cannot GET /api/typo</pre></body></html>");
    if (url.pathname === "/shown") {
      return html(res, page("Draft", `<h1>Draft</h1>${pad}<div id=e></div><script>fetch('/api/shown').then(()=>{e.setAttribute('role','alert');e.textContent="Couldn't load your work"})</script>`));
    }
    html(res, page("Editor", `<h1>Editor</h1>${pad}<a href="/shown">Draft</a><script>fetch('/api/plain');fetch('/api/empty');fetch('/api/words');fetch('/api/typo')</script>`));
  });
  reads = await scanSite({ ...quick, startUrl: `http://localhost:${app}/`, maxPages: 2, exploreButtons: false });

  const gallery = await serve((_req, res, url) => {
    if (url.pathname === "/img/ok.svg") return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>`);
    if (url.pathname.endsWith(".jpg")) return html(res, "<h1>Not Found</h1>", 404);
    html(res, page("Gallery", `<h1>Gallery</h1>${pad}<img src="/img/ok.svg" alt="fine"><img src="/img/shown.jpg" alt="a photo">
      <img src="/img/fallback.jpg" alt="avatar" onerror="this.src='/img/ok.svg'"><img src="/img/hidden.jpg" alt="" style="display:none">
      <script>new Image().src='/img/preload.jpg'</script>`));
  });
  images = await scanSite({ ...quick, startUrl: `http://localhost:${gallery}/`, maxPages: 1, exploreButtons: false });
}, 60_000);

afterAll(closeAll);

describe("a 404 from a read", () => {
  it("plain text, empty, or a few words: none yet", () => {
    expect(failed(reads)).not.toContain("GET /api/plain");
    expect(failed(reads)).not.toContain("GET /api/empty");
    expect(failed(reads)).not.toContain("GET /api/words");
  });

  it("a framework's error page: reported", () => {
    expect(failed(reads)).toContain("GET /api/typo");
  });

  it("the page then saying it failed: reported", () => {
    expect(failed(reads)).toContain("GET /api/shown");
  });
});

describe("a 404 from an image of the site's own", () => {
  it("on show, broken: reported, and with a fallback, hidden or only preloaded: not", () => {
    // Masked as every address is, so the one finding is what proves the others stayed quiet.
    expect(failed(images)).toHaveLength(1);
    expect(images.findings).toHaveLength(1);
  });
});
