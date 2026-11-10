#!/usr/bin/env node
// A small invoicing app to try Context Machines on, with no dependencies:
//   node server.mjs              the app, at http://localhost:3000 (PORT to change it)
//   node server.mjs --changed    the same app after a change, to try `contextmachines diff`
// Nothing is stored: saves answer as a real server would and are then forgotten.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const changed = process.argv.includes("--changed");
const port = Number(process.env.PORT ?? 3000);
const page = readFileSync(new URL("./index.html", import.meta.url), "utf8")
  .replace("<html lang=\"en\">", `<html lang="en" data-changed="${changed ? "yes" : "no"}">`)
  .replace("<!--changed:nav-->", changed ? `<a href="/settings/exports" data-nav>Exports</a>` : "");

let nextInvoice = 1000;
let paymentsConnected = false;

/** The app's API: each save answers as a real one would. */
const routes = [
  ["POST", /^\/api\/auth\/login$/, () => [200, { ok: true }]],
  ["POST", /^\/api\/clients$/, () => [201, { id: 7 }]],
  ["POST", /^\/api\/invoices$/, () => [201, { id: nextInvoice++ }]],
  ["POST", /^\/api\/payments\/connect$/, () => ((paymentsConnected = true), [200, { ok: true }])],
  ["POST", /^\/api\/reports\/export$/, () => [200, { ok: true }]],
  // Sending needs payments connected first, and the page says so only faintly.
  ["POST", /^\/api\/invoices\/\d+\/send$/, () => (paymentsConnected ? [200, { ok: true }] : [422, { error: "payments_not_connected" }])],
  ...(changed ? [["POST", /^\/api\/invoices\/\d+\/duplicate$/, () => [201, { id: nextInvoice++ }]]] : []),
];

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const route = routes.find(([method, pattern]) => method === req.method && pattern.test(path));
  if (route) {
    const [status, body] = route[2]();
    res.writeHead(status, { "content-type": "application/json" });
    return res.end(JSON.stringify(body));
  }
  if (path.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not_found" }));
  }
  // Every other address is the app: it routes in the browser.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
server.listen(port, () => console.log(`Invoice Demo${changed ? " (changed)" : ""} at http://localhost:${port}`));
