/**
 * Small helpers the practice sites share: HTML pages in one calm style, a request log, form bodies
 * and a listener on 127.0.0.1. Node's own modules only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** One plain style for every practice page: readable, light and dark, phone width. */
export const STYLE = `<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fafafa;--primary:#111;--on-primary:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#eee;--muted:#999;--line:#2a2a2a;--card:#151515;--primary:#eee;--on-primary:#111}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header,main,footer{max-width:760px;margin:0 auto;padding:12px 16px}header nav{display:flex;flex-wrap:wrap;gap:12px}
a{color:inherit}h1{font-size:22px;margin:12px 0}label{display:block;margin:10px 0 4px}
input,textarea,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%;max-width:360px}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--primary);background:var(--primary);color:var(--on-primary);cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}.card{border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0;background:var(--card)}
.muted{color:var(--muted)}.err{color:#c62828}.ok{color:#2e7d32}
</style>`;

export const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="data:,">${STYLE}${head}</head><body>${body}</body></html>`;

export type Send = {
  html(s: string, status?: number, headers?: Record<string, string>): void;
  json(v: unknown, status?: number): void;
  js(s: string): void;
  redirect(to: string, headers?: Record<string, string>): void;
  text(s: string, status?: number): void;
};

export function send(res: ServerResponse): Send {
  return {
    html: (s, status = 200, headers = {}) => void res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }).end(s),
    json: (v, status = 200) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(v)),
    js: (s) => void res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(s),
    redirect: (to, headers = {}) => void res.writeHead(303, { location: to, "cache-control": "no-store", ...headers }).end(),
    text: (s, status = 200) => void res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(s),
  };
}

/** A form or JSON body as flat strings. */
export async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
};

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** A server on 127.0.0.1 at `port` (0: a free one), with its port. Handler errors answer 500, never crash. */
export async function listen(handler: Handler, port = 0): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("practice site error");
    });
  });
  const p = await new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done((server.address() as AddressInfo).port));
  });
  return {
    server,
    port: p,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
