import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { closeAll, html, page, quick, serve } from "./precision-site.ts";

/**
 * A link is broken only if pressing it fails. A single-page app on a static host with no fallback
 * (GitHub Pages and the like) answers 404 to a direct load of a page its router draws perfectly well.
 */
let spa: ScanResult;

beforeAll(async () => {
  const app = await serve((_req, res, url) => {
    if (url.pathname !== "/spa/") return html(res, page("404", "<h1>404</h1><p>File not found</p>"), 404);
    html(res, page("App", `<div id=app></div><script>
      const routes={'/spa/':'Dashboard','/spa/reports':'Reports','/spa/settings':'Settings'};
      function draw(){const t=routes[location.pathname]||'Dashboard';app.innerHTML='<nav>'+Object.entries(routes).map(([h,n])=>'<a href="'+h+'">'+n+'</a>').join(' ')+' <a class=plain href="/spa/gone">Old page</a></nav><h1>'+t+'</h1><p>'+'Stuff here. '.repeat(30)+'</p>'+(t==='Reports'?'<button id=b onclick="this.textContent=1">Run report</button>':'')}
      addEventListener('click',e=>{const a=e.target.closest('a');if(a&&!a.classList.contains('plain')){e.preventDefault();history.pushState({},'',a.pathname);draw()}});addEventListener('popstate',draw);draw()</script>`));
  });
  spa = await scanSite({ ...quick, startUrl: `http://localhost:${app}/spa/` });
}, 60_000);

afterAll(closeAll);

describe("broken links", () => {
  it("a client-routed link is learned as a screen, not reported", () => {
    expect(spa.pagesVisited).toEqual(expect.arrayContaining(["/spa", "/spa/reports", "/spa/settings"]));
    expect(spa.findings.filter((f) => /reports|settings/.test(f.target))).toEqual([]);
  });

  it("a screen reached by pressing keeps being reached that way", () => {
    // "Run report" exists only on the screen the router draws: pressing it took reaching it again.
    expect(spa.events.some((e) => e.kind === "interaction" && e.label === "Run report")).toBe(true);
  });

  it("a real dead link on the same site is still reported", () => {
    expect(spa.findings).toContainEqual(expect.objectContaining({ kind: "broken_link", target: "/spa/gone", evidence: "404" }));
  });
});
