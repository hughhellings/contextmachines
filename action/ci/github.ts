/**
 * GitHub's REST API over fetch, for the three things a CI run of the saved tests tells GitHub: one
 * comment on the pull request (created once, then edited on every later run), a commit status on the
 * tested commit (what a Vercel Deployment Check or a branch rule waits for), and, for a deployment
 * event that names no pull request, the open pull request of a commit.
 *
 * Only Node's own modules. The token goes to `api` and nowhere else: a "next page" link on another
 * origin is never followed. Nothing here throws: GitHub refusing is a warning, as the result is in the
 * job summary whatever GitHub says. The tests run all of it against a fake server on port 0.
 */

export interface GitHub {
  /** https://api.github.com, or GITHUB_API_URL on GitHub Enterprise (or a fake server in tests). */
  api: string;
  /** owner/name */
  repo: string;
  token: string;
  /** Where warnings go: GitHub's log in the Action. */
  warn: (message: string) => void;
}

const headers = (g: GitHub) => ({
  authorization: `Bearer ${g.token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "contextmachines-ci",
  "x-github-api-version": "2022-11-28",
});

const TIMEOUT = 30_000;
const call = (g: GitHub, url: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(url, { method: init.method ?? "GET", headers: headers(g), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(TIMEOUT) });

/** Why GitHub said no, in words someone can act on. */
export function refusal(status: number, doing: string, rateLeft?: string | null): string {
  if (status === 429 || (status === 403 && rateLeft === "0")) return `GitHub's rate limit stopped Context Machines ${doing} (${status}); the next run will try again.`;
  if (status === 401) return `GitHub didn't accept the token while ${doing} (401). Check the github-token input (the default, github.token, works).`;
  if (status === 403 || status === 404) {
    return `GitHub didn't allow ${doing} (${status}). The job needs "permissions: pull-requests: write" to comment and "statuses: write" for the status. On a pull request from a fork the token is read-only.`;
  }
  if (status === 422) return `GitHub refused ${doing} (422): it may be too long or malformed.`;
  return `GitHub answered ${status} while ${doing}.`;
}

class Refused extends Error {}
const refused = (res: Response, doing: string) => new Refused(refusal(res.status, doing, res.headers.get("x-ratelimit-remaining")));

// ---------------------------------------------------------------------------------------------
// The one comment.
// ---------------------------------------------------------------------------------------------

/**
 * The first line of our comment. It names the workflow, the job, the environment and the `key`
 * input, so a preview run and a production run, or two apps, each keep their own comment.
 */
export function marker(workflow: string, job: string, key: string): string {
  const part = (s: string) => encodeURIComponent(s);
  return `<!-- contextmachines kind=test workflow=${part(workflow)} job=${part(job)} key=${part(key)} -->`;
}

/** Who may have written our comment: the token's own login, or, when GitHub won't say, any bot. */
type Author = { login: string } | { anyBot: true };

/**
 * A personal token can ask who it is. The workflow's own github.token (an installation token) can't:
 * GitHub answers 403, and its comments are written by a bot (github-actions[bot]).
 */
async function author(g: GitHub): Promise<Author> {
  const res = await call(g, `${g.api}/user`);
  if (res.ok) {
    const user = (await res.json()) as { login?: string };
    if (user.login) return { login: user.login };
  }
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") !== "0") return { anyBot: true };
  if (!res.ok) throw refused(res, "checking who the token comments as");
  return { anyBot: true };
}

/** The next page from GitHub's Link header, only on the API's own origin (the token goes with it). */
export function nextPage(link: string | null, api: string): string | undefined {
  const next = link?.split(",").find((part) => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1];
  try {
    return next && new URL(next).origin === new URL(api).origin ? next : undefined;
  } catch {
    return undefined;
  }
}

/** Ours: the marker is the first line and the author is the token's identity (or a bot). A copy pasted by someone else is not. */
async function findOurs(g: GitHub, pr: number, mark: string, by: Author): Promise<number | undefined> {
  let page: string | undefined = `${g.api}/repos/${g.repo}/issues/${pr}/comments?per_page=100`;
  for (let n = 0; page && n < 50; n++) {
    const res = await call(g, page);
    // Not knowing whether ours exists must not mean posting a second one.
    if (!res.ok) throw refused(res, "reading the pull request's comments");
    const comments = (await res.json()) as { id: number; body?: string | null; user?: { login?: string; type?: string } | null }[];
    const ours = comments.find((c) => (c.body ?? "").split("\n", 1)[0]!.trim() === mark && ("login" in by ? c.user?.login === by.login : c.user?.type === "Bot"));
    if (ours) return ours.id;
    page = nextPage(res.headers.get("link"), g.api);
  }
  return undefined;
}

/** Posts our comment on the pull request, or edits it when it is there. Never throws. */
export async function upsertComment(g: GitHub, pr: number, mark: string, body: string): Promise<{ done: "posted" | "updated" | "skipped"; id?: number }> {
  try {
    const existing = await findOurs(g, pr, mark, await author(g));
    const text = { body: `${mark}\n${body}` };
    const res = existing
      ? await call(g, `${g.api}/repos/${g.repo}/issues/comments/${existing}`, { method: "PATCH", body: text })
      : await call(g, `${g.api}/repos/${g.repo}/issues/${pr}/comments`, { method: "POST", body: text });
    if (!res.ok) throw refused(res, existing ? "updating its comment" : "commenting on the pull request");
    const id = ((await res.json().catch(() => ({}))) as { id?: number }).id ?? existing;
    return { done: existing ? "updated" : "posted", ...(id !== undefined ? { id } : {}) };
  } catch (error) {
    g.warn(`${error instanceof Refused ? error.message : `Context Machines couldn't reach GitHub to comment (${(error as Error).message}).`} The result is in the job summary.`);
    return { done: "skipped" };
  }
}

// ---------------------------------------------------------------------------------------------
// The commit status.
// ---------------------------------------------------------------------------------------------

export interface Status {
  sha: string;
  state: "pending" | "success" | "failure" | "error";
  /** The status's name: what a Vercel Deployment Check or a required check is set to wait for. */
  context: string;
  description: string;
  targetUrl?: string;
}

/** Sets a commit status. Never throws; false when GitHub refused. */
export async function setStatus(g: GitHub, s: Status): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(s.sha)) {
    g.warn(`Context Machines didn't set a commit status: "${s.sha.slice(0, 80)}" isn't a commit.`);
    return false;
  }
  try {
    const target = s.targetUrl && /^https?:\/\//.test(s.targetUrl) ? { target_url: s.targetUrl } : {};
    const res = await call(g, `${g.api}/repos/${g.repo}/statuses/${s.sha}`, { method: "POST", body: { state: s.state, context: s.context.slice(0, 255), description: s.description.slice(0, 140), ...target } });
    if (!res.ok) throw refused(res, "setting the commit status");
    return true;
  } catch (error) {
    g.warn(error instanceof Refused ? error.message : `Context Machines couldn't reach GitHub to set the commit status (${(error as Error).message}).`);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The pull request of a commit: a deployment event (Vercel's repository_dispatch) names none.
// ---------------------------------------------------------------------------------------------

/**
 * The open pull request whose head is this commit, or nothing (a production deployment of main
 * usually has none). Several open: the one whose head is exactly this commit, then the newest.
 */
export async function pullRequestFor(g: GitHub, sha: string): Promise<number | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  try {
    const res = await call(g, `${g.api}/repos/${g.repo}/commits/${sha}/pulls?per_page=100`);
    if (!res.ok) throw refused(res, "looking up the commit's pull request");
    const pulls = (await res.json()) as { number: number; state?: string; head?: { sha?: string } }[];
    const open = pulls.filter((p) => p.state === "open").sort((a, b) => b.number - a.number);
    return (open.find((p) => p.head?.sha === sha) ?? open[0])?.number;
  } catch (error) {
    g.warn(error instanceof Refused ? error.message : `Context Machines couldn't reach GitHub to find the pull request (${(error as Error).message}).`);
    return undefined;
  }
}
