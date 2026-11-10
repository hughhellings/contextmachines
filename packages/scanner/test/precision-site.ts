import http from "node:http";
import type { AddressInfo } from "node:net";

/** Small sites for the precision traps: each answers with what a real pattern on the web answers with. */
export const pad = `<p>${"Some words about this page that make it a real page. ".repeat(10)}</p>`;
export const page = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
export const html = (res: http.ServerResponse, body: string, status = 200) => void res.writeHead(status, { "content-type": "text/html" }).end(body);
export const json = (res: http.ServerResponse, body: unknown, status = 200) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) => void;

const servers: http.Server[] = [];
/** A server on a free port, for a test file's afterAll to close with closeAll. */
export function serve(handler: Handler): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, new URL(req.url ?? "/", `http://${req.headers.host}`), body));
    });
    servers.push(server);
    server.listen(0, () => resolve((server.address() as AddressInfo).port));
  });
}
export const closeAll = () => Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
  s.closeAllConnections();
  s.close(() => resolve());
})));
/** The options every trap here shares: quick, and no photos of screens. */
export const quick = { maxPages: 8, maxDurationMs: 25_000, delayMs: 0, screenshots: false } as const;
