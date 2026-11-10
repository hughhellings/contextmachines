import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";
import { page, startRecordingSite, type RecordingSite } from "./readonly-app.ts";

/**
 * --create: a write passes only if nothing anywhere in it says it destroys. Every line here was sent
 * for real by the last round's probe under a Save button, or under a button that wasn't recognised.
 * The plain save beside them must still go through, or the mode is no use.
 */
const json = (url: string, body: unknown, method = "POST") => `fetch('${url}',{method:'${method}',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})})`;
const calls = [
  json("/api/invoices/1", { invoice: { lines_attributes: [{ id: 9, _destroy: "1" }] } }, "PATCH"), json("/api/bulk", { action: "delete", ids: [1, 2, 3] }), json("/rpc", { jsonrpc: "2.0", method: "invoices.delete", params: [7], id: 1 }),
  json("/api/doc", [{ op: "remove", path: "/items/0" }], "PATCH"), json("/api/invoices/1", { deleted: true }, "PUT"), `fetch('/api/invoices/1/trash',{method:'POST'})`, `fetch('/api/purge',{method:'POST'})`,
  `fetch('/api/invoices?action=delete&id=1',{method:'POST'})`, `fetch('/admin-ajax.php',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=delete-post&id=1'})`,
  `fetch('/api/invoices/5',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'%5Fmethod=delete'})`, `(()=>{const f=new FormData();f.append('_method','delete');return fetch('/api/invoices/2',{method:'POST',body:f})})()`,
  `fetch('/api/invoices/3',{method:'POST',headers:{'x-http-method-override':' DELETE'}})`, json("/api/invoices/4", { method: "DELETE" }),
  `(()=>{const f=new FormData();f.append('operations',JSON.stringify({query:'mutation { deleteInvoice(id: 7) { id } }'}));return fetch('/graphql',{method:'POST',body:f})})()`,
  `fetch('/graphql',{method:'POST',headers:{'content-type':'application/graphql'},body:'mutation { deleteInvoice(id: 7) { id } }'})`, json("/graphql", { query: "mutation { clearInvoices { ok } }" }),
];
let site: RecordingSite;
let result: ScanResult;
const pressed: string[] = [];

beforeAll(async () => {
  site = await startRecordingSite((req, res, url) => {
    if (url.pathname === "/pressed") {
      pressed.push(url.searchParams.get("b") ?? "");
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (req.method !== "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 1 }));
    res.writeHead(200, { "content-type": "text/html" }).end(page("Invoices", `
      <form onsubmit="event.preventDefault();${calls.join(";").replace(/"/g, "&quot;")};fetch('/api/invoices',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})"><label>Name <input name="name" required></label><button type="submit">Save</button></form>
      <button onclick="fetch('/pressed?b=clear')">Clear all</button>
      <button onclick="fetch('/pressed?b=empty')">Empty bin</button>
      <button onclick="fetch('/pressed?b=move')">Move to trash</button>
      <button aria-label="Row 1" class="icon-trash" onclick="fetch('/pressed?b=icon')"></button>
      <button title="Delete" aria-label="x" onclick="fetch('/pressed?b=title')">x</button>
      <form onsubmit="event.preventDefault();fetch('/pressed?b=wordless')"><input name="a" required><button type="submit" class="plain"></button></form>
      <button onclick="if(confirm('Delete this for good?'))fetch('/pressed?b=confirm')">Tidy</button>
      <button onclick="fetch('/pressed?b=refresh')">Refresh</button>`));
  });
  result = await scanSite({ startUrl: site.url, maxPages: 2, maxDurationMs: 25_000, delayMs: 0, screenshots: false, realWrites: true });
}, 60_000);

afterAll(() => site.close());

describe("--create", () => {
  it("lets a plain save through, and none of what sits beside it", () => {
    const writes = site.requests.filter((r) => !r.startsWith("GET "));
    expect(writes.filter((r) => r.startsWith("POST /api/invoices {}"))).not.toEqual([]);
    expect(writes.filter((r) => !r.startsWith("POST /api/invoices {}"))).toEqual([]);
    expect(result.blockedWrites.length).toBeGreaterThanOrEqual(calls.length);
  });

  it("never presses a control that says it destroys, however it says so, nor one with no words", () => {
    expect(pressed.filter((b) => b !== "refresh")).toEqual([]);
    expect(pressed).toContain("refresh");
  });
});
