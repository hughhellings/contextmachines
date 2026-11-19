/**
 * A fake GitHub REST API on 127.0.0.1, port 0, for the tests and the local simulation: never the real
 * one. It keeps issue comments, commit statuses and commit -> pull request links in memory, answers
 * the endpoints github.ts uses, pages comments 2 at a time (so paging is exercised), and records
 * every request with the token it carried.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: "User" | "Bot" };
}

export interface FakeStatus {
  sha: string;
  state: string;
  context: string;
  description: string;
  target_url?: string;
}

export interface FakeGitHub {
  api: string;
  /** Comments by pull request number. */
  comments: Map<number, FakeComment[]>;
  statuses: FakeStatus[];
  /** Pull requests by commit, as GitHub's /commits/{sha}/pulls answers. */
  pulls: Map<string, { number: number; state: string; head: { sha: string } }[]>;
  requests: { method: string; path: string; auth: string }[];
  /** Who the token is: a login (a personal token) or none (github.token: /user answers 403). */
  as: string | undefined;
  /** Answer this status to every write (to test refusals). */
  refuseWrites: number | undefined;
  close(): Promise<void>;
}

export async function startFakeGitHub(o: { token: string; repo: string }): Promise<FakeGitHub> {
  let nextId = 1000;
  const state: Omit<FakeGitHub, "api" | "close"> = { comments: new Map(), statuses: [], pulls: new Map(), requests: [], as: undefined, refuseWrites: undefined };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const auth = String(req.headers.authorization ?? "");
    state.requests.push({ method, path: url.pathname + url.search, auth });
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(data));
    if (auth !== `Bearer ${o.token}`) return json(401, { message: "Bad credentials" });
    if (method !== "GET" && state.refuseWrites) return json(state.refuseWrites, { message: "refused" });
    const me = state.as ? { login: state.as, type: "User" as const } : { login: "github-actions[bot]", type: "Bot" as const };
    const base = `/repos/${o.repo}`;
    if (url.pathname === "/user") return state.as ? json(200, { login: state.as }) : json(403, { message: "Resource not accessible by integration" }, { "x-ratelimit-remaining": "4999" });
    let m = new RegExp(`^${base}/issues/(\\d+)/comments$`).exec(url.pathname);
    if (m) {
      const pr = Number(m[1]);
      const list = state.comments.get(pr) ?? [];
      if (method === "POST") {
        const c: FakeComment = { id: nextId++, body: String(body.body ?? ""), user: me };
        state.comments.set(pr, [...list, c]);
        return json(201, c);
      }
      const per = 2;
      const page = Number(url.searchParams.get("page") ?? "1");
      const slice = list.slice((page - 1) * per, page * per);
      const more: Record<string, string> = page * per < list.length ? { link: `<http://${req.headers.host}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` } : {};
      return json(200, slice, more);
    }
    m = new RegExp(`^${base}/issues/comments/(\\d+)$`).exec(url.pathname);
    if (m && method === "PATCH") {
      const id = Number(m[1]);
      for (const list of state.comments.values()) {
        const c = list.find((x) => x.id === id);
        if (c) {
          c.body = String(body.body ?? "");
          return json(200, c);
        }
      }
      return json(404, { message: "Not Found" });
    }
    m = new RegExp(`^${base}/statuses/([0-9a-f]+)$`).exec(url.pathname);
    if (m && method === "POST") {
      const s: FakeStatus = { sha: m[1]!, state: String(body.state), context: String(body.context), description: String(body.description), ...(body.target_url ? { target_url: String(body.target_url) } : {}) };
      state.statuses.push(s);
      return json(201, s);
    }
    m = new RegExp(`^${base}/commits/([0-9a-f]+)/pulls$`).exec(url.pathname);
    if (m) return json(200, state.pulls.get(m[1]!) ?? []);
    return json(404, { message: "Not Found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as AddressInfo).port;
  const fake = state as FakeGitHub;
  fake.api = `http://127.0.0.1:${port}`;
  fake.close = () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
  return fake;
}
