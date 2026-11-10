import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite } from "../src/scan.ts";

/**
 * --create lets the learner's saves through, and promises deletes never are. A delete isn't always
 * the DELETE method or an address that says so: a GraphQL mutation named for it (behind a button
 * whose words don't say so, or after a fragment), a Rails or Laravel form's _method=delete, an
 * X-HTTP-Method-Override header. None of them may reach the server, while a plain save does. A
 * Delete button isn't even pressed. Without --create, a mutation after a fragment is still stopped.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let server: http.Server;
let url = "";
const received: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let body = "";
    req.on("data", (c: Buffer) => void (body += c.toString()));
    req.on("end", () => {
      if (req.method !== "GET") received.push(`${req.method} ${path} ${req.headers["x-http-method-override"] ?? ""} ${body}`);
      if (req.method !== "GET" && path !== "/invoices/7") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "1" }, id: 1 }));
      res.setHeader("content-type", "text/html");
      res.end(page("Invoice 7", `
        <button id="tidy">Tidy up</button>
        <button id="refresh">Refresh list</button>
        <button id="apply">Apply</button>
        <button id="create">New invoice</button>
        <button id="del">Delete invoice</button>
        <form method="post" action="/invoices/7"><input type="hidden" name="_method" value="delete"><button>Save</button></form>
        <script>
          const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
          tidy.onclick = () => post("/graphql", { operationName: "TidyUp", query: "mutation TidyUp { deleteInvoice(id: 7) { id } }" });
          refresh.onclick = () => post("/graphql", { query: "fragment F on Invoice { id } mutation { removeInvoice(id: 7) { ...F } }" });
          apply.onclick = () => post("/invoices/7", {}, { "x-http-method-override": "DELETE" });
          create.onclick = () => post("/api/invoices", { total: 1 });
          del.onclick = () => post("/api/invoices/7/archive", {});
        </script>`));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 30_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("--create never deletes", () => {
  it("lets a save through, and none of the ways a delete is sent", async () => {
    received.length = 0;
    const r = await scanSite({ startUrl: url, maxPages: 2, maxDurationMs: 25_000, delayMs: 0, screenshots: false, realWrites: true });
    expect(received.some((x) => x.startsWith("POST /api/invoices "))).toBe(true);
    expect(received.filter((x) => /deleteInvoice|removeInvoice|_method=delete|DELETE|\/invoices\/7|archive/i.test(x))).toEqual([]);
    expect(r.blockedWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/graphql", graphqlOperation: "TidyUp" }),
      expect.objectContaining({ method: "POST", path: "/invoices/:id" }),
    ]));
  }, 60_000);

  it("without --create, stops a mutation that follows a fragment, as any other", async () => {
    received.length = 0;
    await scanSite({ startUrl: url, maxPages: 2, maxDurationMs: 25_000, delayMs: 0, screenshots: false });
    expect(received).toEqual([]);
  }, 60_000);
});
