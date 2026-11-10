import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanSite } from "../src/scan.ts";

// An editor that only exists once something is created: "New quiz" saves, then opens /quizzes/<id>/edit.
let server: Server;
let url = "";
const received: string[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
beforeAll(async () => {
  let next = 40;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    received.push(`${req.method} ${path}`);
    const json = (status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method === "POST" && path === "/api/quizzes") return json(201, { id: next++ });
    if (req.method === "POST" && /^\/api\/quizzes\/\d+\/questions$/.test(path)) return json(201, { id: 1 });
    if (req.method === "DELETE") return json(200, { ok: true });
    res.writeHead(200, { "content-type": "text/html" });
    if (/^\/quizzes\/\d+\/edit$/.test(path)) {
      const id = path.split("/")[2];
      return res.end(page("Edit quiz", `<button id="q">Add question</button><button id="d">Delete quiz</button><script>
        q.onclick = () => fetch('/api/quizzes/${id}/questions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"?"}' });
        d.onclick = () => fetch('/api/quizzes/${id}', { method: 'DELETE' });</script>`));
    }
    return res.end(page("Your quizzes", `<button id="n">New quiz</button><script>
      n.onclick = async () => { const r = await fetch('/api/quizzes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const { id } = await r.json(); location.href = '/quizzes/' + id + '/edit'; };</script>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("screens that only exist after creating something", () => {
  it("by default, nothing is saved: every save is answered by us (an app that trusts the reply still opens)", async () => {
    received.length = 0;
    const r = await scanSite({ startUrl: url, maxPages: 10, maxDurationMs: 40_000, delayMs: 0, screenshots: false });
    expect(r.blockedWrites.map((w) => `${w.method} ${w.path}`)).toContain("POST /api/quizzes");
    expect(received.filter((x) => !x.startsWith("GET"))).toEqual([]);
  }, 60_000);

  it("are reached when the person lets its saves through, and deletes still never are", async () => {
    received.length = 0;
    const r = await scanSite({ startUrl: url, maxPages: 10, maxDurationMs: 40_000, delayMs: 0, screenshots: false, realWrites: true });
    expect(r.pagesVisited).toContain("/quizzes/:id/edit");
    expect(received).toContain("POST /api/quizzes");
    expect(received.some((x) => x.startsWith("POST /api/quizzes/") && x.endsWith("/questions"))).toBe(true);
    expect(received.filter((x) => x.startsWith("DELETE"))).toEqual([]);
  }, 60_000);
});
