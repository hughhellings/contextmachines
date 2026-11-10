import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite, type ScanResult } from "../src/scan.ts";

/**
 * An app that saves over its live connection, in the protocols whose verb sits where a plain
 * "type" reader doesn't look: Meteor's DDP, JSON-RPC, a Socket.IO event carrying a file (binary),
 * a graphql-ws "subscribe" that carries a mutation, and a bare binary frame. Its Delete button
 * sends every one. The learner presses Delete (its writes are meant to be answered by us), so the
 * server must receive none of them, while the page's own subscription still works.
 */
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
let server: http.Server;
let result: ScanResult;
/** Every message the server received, as text ("binary" for a binary one). */
const received: string[] = [];

/** Just enough of a WebSocket server: the handshake, then each frame the browser sends (always masked). */
function accept(req: http.IncomingMessage, socket: Duplex, onOpen: (send: (text: string) => void) => void) {
  const key = String(req.headers["sec-websocket-key"]);
  const answer = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${answer}\r\n\r\n`);
  const send = (text: string) => {
    const data = Buffer.from(text);
    socket.write(Buffer.concat([Buffer.from(data.length < 126 ? [0x81, data.length] : [0x81, 126, data.length >> 8, data.length & 255]), data]));
  };
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const opcode = buffer[0]! & 0x0f;
      let length = buffer[1]! & 0x7f;
      let at = 2;
      if (length === 126) { length = buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); at = 10; }
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const data = Buffer.from(buffer.subarray(at + 4, at + 4 + length).map((b, i) => b ^ mask[i % 4]!));
      buffer = buffer.subarray(at + 4 + length);
      if (opcode === 1) received.push(data.toString());
      else if (opcode === 2) received.push("binary");
      else if (opcode === 8) return void socket.end();
    }
  });
  socket.on("error", () => {});
  onOpen(send);
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(page("Invoices", `<p id="live">Waiting</p><button id="del">Delete invoice</button><script>
      const ws = new WebSocket("ws://" + location.host + "/live");
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "connection_init" }));
        ws.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: "subscription { invoiceAdded { id } }" } }));
      };
      ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "next") live.textContent = "Live: invoice " + m.payload.data.invoiceAdded.id; };
      del.onclick = () => {
        ws.send(JSON.stringify({ msg: "method", method: "invoices.remove", params: [{ _id: "7" }], id: "3" }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "invoice.delete", params: [7], id: 4 }));
        ws.send('451-["deleteInvoice",{"_placeholder":true,"num":0}]');
        ws.send(new Uint8Array([7, 0, 0, 0]));
        ws.send(JSON.stringify({ id: "2", type: "subscribe", payload: { query: "mutation { deleteInvoice(id: 7) { id } }" } }));
        ws.send(JSON.stringify({ id: "5", type: "subscribe", payload: { query: "fragment F on Invoice { id } mutation Tidy { deleteInvoice(id: 7) { ...F } }" } }));
      };</script>`));
  });
  server.on("upgrade", (req, socket) => accept(req, socket, (send) => {
    setTimeout(() => send(JSON.stringify({ id: "1", type: "next", payload: { data: { invoiceAdded: { id: 42 } } } })), 300);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  result = await scanSite({ startUrl: url, maxPages: 2, maxDurationMs: 25_000, delayMs: 0, screenshots: false });
}, 60_000);

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("a Delete press that saves over a live connection", () => {
  it("was pressed, and every one of its messages was held back", () => {
    const held = result.blockedWrites.filter((w) => w.method === "WS").map((w) => w.graphqlOperation);
    expect(held).toEqual(expect.arrayContaining(["ws:invoices.remove", "ws:invoice.delete", "ws:deleteInvoice", "ws:binary"]));
  });

  it("reached the server with nothing but the connection's upkeep and its subscription", () => {
    expect(received.length).toBeGreaterThan(0);
    for (const message of received) expect(message).not.toMatch(/invoices\.remove|invoice\.delete|deleteInvoice|^binary$/);
    expect(received).toContain(JSON.stringify({ type: "connection_init" }));
    expect(received.some((m) => m.includes("subscription { invoiceAdded"))).toBe(true);
  });
});
