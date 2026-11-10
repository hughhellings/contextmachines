/**
 * A server for the read-only traps: it records everything that truly arrives, so a test can prove
 * what never did. `harmless` says which requests change nothing; every other request and every
 * WebSocket message that arrives is a change, and a test of the guard wants none.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface RecordingSite {
  url: string;
  /** Every request, as "METHOD /path?query body". */
  requests: string[];
  /** Every WebSocket message received ("binary" for a binary one). */
  messages: string[];
  /** Every WebSocket opened, by address. */
  sockets: string[];
  /** The requests and messages that weren't harmless. */
  changes(): string[];
  close(): Promise<void>;
}

export const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

/** Just enough of a WebSocket server: the handshake, then each frame the browser sends (always masked). */
function acceptSocket(req: http.IncomingMessage, socket: Duplex, messages: string[]) {
  const answer = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const opcode = buffer[0]! & 0x0f;
      let length = buffer[1]! & 0x7f;
      let at = 2;
      if (length === 126) { length = buffer.readUInt16BE(2); at = 4; }
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const data = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]!));
      buffer = buffer.subarray(at + 4 + length);
      if (opcode === 1) messages.push(data.toString());
      else if (opcode === 2) messages.push("binary");
      else if (opcode === 8) return void socket.end();
    }
  });
  socket.on("error", () => {});
}

type Reply = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) => void;

export async function startRecordingSite(reply: Reply, harmless: (request: string) => boolean = () => false, host = "127.0.0.1"): Promise<RecordingSite> {
  const requests: string[] = [];
  const messages: string[] = [];
  const sockets: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => void (body += c.toString("latin1")));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url} ${body}`.trim());
      reply(req, res, new URL(req.url ?? "/", "http://x"), body);
    });
  });
  server.on("upgrade", (req, socket) => {
    sockets.push(req.url ?? "");
    acceptSocket(req, socket, messages);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    url: `http://${host}:${(server.address() as AddressInfo).port}/`,
    requests,
    messages,
    sockets,
    changes: () => [...requests.filter((r) => !harmless(r)), ...messages.map((m) => `WS ${m}`)],
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
