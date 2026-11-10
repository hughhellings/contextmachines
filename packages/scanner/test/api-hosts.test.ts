import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * A single-page app whose data comes from an API on a host of its own (www.shop… reads and saves at
 * api.shop…), as many do, beside a tracker on another site altogether. The API's reads and saves are
 * the site's own: recorded, and its saves answered by us. The tracker's never are. The API's own
 * pages are never crawled as screens of the product. Names under .localhost reach this machine.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let shop: http.Server;
let api: http.Server;
let tracker: http.Server;
let result: ScanResult;
const apiReceived: string[] = [];
const trackerReceived: string[] = [];
const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
  api = http.createServer((req, res) => {
    apiReceived.push(`${req.method} ${req.url}`);
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.url === "/docs") return res.writeHead(200, { "content-type": "text/html" }).end(page("API reference", "<p>Endpoints</p>"));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: 1, name: "Pliers" }]));
  });
  tracker = http.createServer((req, res) => {
    trackerReceived.push(`${req.method} ${req.url}`);
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
    res.writeHead(204).end();
  });
  const apiBase = `http://api.shop.localhost:${await listen(api)}`;
  const trackerBase = `http://tracker.localhost:${await listen(tracker)}`;
  shop = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(page("Shop", `<ul id="products"></ul><a href="${apiBase}/docs">API docs</a>
      <form id="order"><input placeholder="Quantity" type="number"><button>Order</button></form>
      <script>
        fetch("${apiBase}/products").then((r) => r.json()).then((items) => { products.innerHTML = items.map((i) => "<li>" + i.name + "</li>").join(""); });
        order.onsubmit = async (e) => {
          e.preventDefault();
          fetch("${trackerBase}/collect", { method: "POST", mode: "no-cors", body: "ordered" }).catch(() => {});
          const r = await fetch("${apiBase}/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quantity: 1 }) });
          if (r.ok) order.insertAdjacentHTML("afterend", "<p>Thanks for your order</p>");
        };
      </script>`));
  });
  const start = `http://www.shop.localhost:${await listen(shop)}/`;
  result = await scanSite({ startUrl: start, maxPages: 5, maxDurationMs: 60_000, delayMs: 0, screenshots: false });
}, 90_000);

afterAll(() => {
  for (const server of [shop, api, tracker]) server?.close();
});

describe("an app whose API is on a host of its own", () => {
  it("records the API's reads as the site's own", () => {
    const reads = result.events.flatMap((e) => (e.kind === "network" ? [`${e.method} ${e.path}`] : []));
    expect(reads).toContain("GET /products");
  });

  it("learns a save to the API without it reaching the API", () => {
    expect(result.blockedWrites).toContainEqual(expect.objectContaining({ method: "POST", path: "/orders" }));
    expect(result.events.some((e) => e.kind === "network" && e.method === "POST" && e.path === "/orders")).toBe(true);
    expect(apiReceived).not.toContain("POST /orders");
  });

  it("never treats another site's host as the product's", () => {
    expect(trackerReceived.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(result.events.some((e) => e.kind === "network" && e.path === "/collect")).toBe(false);
  });

  it("never crawls the API host's pages as screens", () => {
    expect(result.pagesVisited).toEqual(["/"]);
    expect(apiReceived).not.toContain("GET /docs");
  });
});
