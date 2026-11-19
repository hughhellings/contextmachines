/**
 * The PR comment reporter, the commit status and the pull request lookup, against a fake GitHub on
 * port 0 (fake-github.ts). Never the real one.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";
import { marker, nextPage, pullRequestFor, setStatus, upsertComment, type GitHub } from "./github.ts";

const TOKEN = "ghs_faketokenfaketokenfaketoken0001";
const REPO = "acme/shop";
let fake: FakeGitHub;
const warnings: string[] = [];
const gh = (): GitHub => ({ api: fake.api, repo: REPO, token: TOKEN, warn: (m) => warnings.push(m) });

before(async () => {
  fake = await startFakeGitHub({ token: TOKEN, repo: REPO });
});
after(async () => {
  await fake.close();
});

describe("the one comment", () => {
  it("is posted on the first run and updated in place on later runs: one comment, same id", async () => {
    const mark = marker("CI", "e2e", "preview");
    const first = await upsertComment(gh(), 7, mark, "run 1: 1 passed");
    assert.equal(first.done, "posted");
    const second = await upsertComment(gh(), 7, mark, "run 2: 2 passed");
    assert.equal(second.done, "updated");
    const third = await upsertComment(gh(), 7, mark, "run 3: 3 passed");
    assert.equal(third.done, "updated");
    const list = fake.comments.get(7)!;
    assert.equal(list.length, 1);
    assert.equal(first.id, list[0]!.id);
    assert.equal(second.id, list[0]!.id);
    assert.equal(list[0]!.body, `${mark}\nrun 3: 3 passed`);
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, 1);
    assert.equal(fake.requests.filter((r) => r.method === "PATCH").length, 2);
  });

  it("finds its comment on a later page, and leaves alone a copy of the marker someone else pasted", async () => {
    const mark = marker("CI", "e2e", "paged");
    // Someone pastes our marker first; then other comments push ours past the first page.
    fake.comments.set(8, [{ id: 1, body: `${mark}\nmine now`, user: { login: "mallory", type: "User" } }]);
    const posted = await upsertComment(gh(), 8, mark, "ours");
    assert.equal(posted.done, "posted");
    fake.comments.get(8)!.unshift({ id: 2, body: "hello", user: { login: "a", type: "User" } }, { id: 3, body: "hi", user: { login: "b", type: "User" } });
    const updated = await upsertComment(gh(), 8, mark, "ours, again");
    assert.equal(updated.done, "updated");
    assert.equal(updated.id, posted.id);
    const list = fake.comments.get(8)!;
    assert.equal(list.find((c) => c.id === 1)!.body, `${mark}\nmine now`);
    assert.equal(list.filter((c) => c.body.startsWith(mark)).length, 2);
    assert.ok(fake.requests.some((r) => r.path.includes("page=2")), "read the second page");
  });

  it("with a personal token, only that login's comment is ours", async () => {
    fake.as = "ci-user";
    try {
      const mark = marker("CI", "e2e", "user");
      fake.comments.set(9, [{ id: 50, body: `${mark}\nby a bot`, user: { login: "github-actions[bot]", type: "Bot" } }]);
      const r = await upsertComment(gh(), 9, mark, "by ci-user");
      assert.equal(r.done, "posted");
      assert.equal(fake.comments.get(9)!.length, 2);
    } finally {
      fake.as = undefined;
    }
  });

  it("a refusal is a warning that says what to do, never a throw", async () => {
    fake.refuseWrites = 403;
    warnings.length = 0;
    try {
      const r = await upsertComment(gh(), 10, marker("CI", "e2e", "x"), "body");
      assert.equal(r.done, "skipped");
      assert.match(warnings.join("\n"), /pull-requests: write/);
    } finally {
      fake.refuseWrites = undefined;
    }
    const bad = await upsertComment({ ...gh(), token: "wrong" }, 10, marker("CI", "e2e", "x"), "body");
    assert.equal(bad.done, "skipped");
    assert.match(warnings.join("\n"), /401/);
  });

  it("never follows a next page to another origin (the token would go with it)", () => {
    assert.equal(nextPage('<https://evil.example/x?page=2>; rel="next"', "https://api.github.com"), undefined);
    assert.equal(nextPage('<https://api.github.com/x?page=2>; rel="next"', "https://api.github.com"), "https://api.github.com/x?page=2");
    assert.equal(nextPage(null, "https://api.github.com"), undefined);
  });
});

describe("the commit status", () => {
  it("sets pending then the result on the commit, under the name a Deployment Check waits for", async () => {
    const sha = "a".repeat(40);
    assert.equal(await setStatus(gh(), { sha, state: "pending", context: "contextmachines - preview", description: "Running the saved tests" }), true);
    assert.equal(await setStatus(gh(), { sha, state: "failure", context: "contextmachines - preview", description: "x".repeat(300), targetUrl: "https://github.com/acme/shop/actions/runs/1" }), true);
    const mine = fake.statuses.filter((s) => s.sha === sha);
    assert.deepEqual(mine.map((s) => s.state), ["pending", "failure"]);
    assert.ok(mine.every((s) => s.context === "contextmachines - preview"));
    assert.equal(mine[1]!.description.length, 140);
    assert.equal(mine[1]!.target_url, "https://github.com/acme/shop/actions/runs/1");
  });

  it("refuses what isn't a commit, and a refusal is a warning", async () => {
    warnings.length = 0;
    assert.equal(await setStatus(gh(), { sha: "../../x", state: "success", context: "c", description: "d" }), false);
    fake.refuseWrites = 404;
    try {
      assert.equal(await setStatus(gh(), { sha: "b".repeat(40), state: "success", context: "c", description: "d" }), false);
    } finally {
      fake.refuseWrites = undefined;
    }
    assert.match(warnings.join("\n"), /isn't a commit/);
    assert.match(warnings.join("\n"), /statuses: write/);
  });
});

describe("the pull request of a deployed commit", () => {
  it("is the open one (its head first), none when only closed ones or none exist", async () => {
    const sha = "c".repeat(40);
    fake.pulls.set(sha, [
      { number: 3, state: "closed", head: { sha } },
      { number: 4, state: "open", head: { sha: "d".repeat(40) } },
      { number: 5, state: "open", head: { sha } },
    ]);
    assert.equal(await pullRequestFor(gh(), sha), 5);
    const only = "e".repeat(40);
    fake.pulls.set(only, [{ number: 6, state: "closed", head: { sha: only } }]);
    assert.equal(await pullRequestFor(gh(), only), undefined);
    assert.equal(await pullRequestFor(gh(), "f".repeat(40)), undefined);
    assert.equal(await pullRequestFor(gh(), "not a sha"), undefined);
  });

  it("every request carried the token to the fake API and nowhere else", () => {
    assert.ok(fake.requests.length > 10);
    assert.ok(fake.requests.filter((r) => r.auth !== "Bearer wrong").every((r) => r.auth === `Bearer ${TOKEN}`));
  });
});
