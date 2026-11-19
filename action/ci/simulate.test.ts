/**
 * The done bar for the Action, end to end: simulate.ts plays three Vercel preview events against the
 * practice site and a fake GitHub, with the CLI from this checkout and no AI. A real browser runs.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { simulate, verify } from "./simulate.ts";

it("the Action runs saved tests on each preview, keeps one PR comment, and sets the status a Deployment Check reads", { timeout: 300_000 }, async () => {
  const results = verify(await simulate());
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], failed.map((r) => `${r.name}: ${r.detail}`).join("\n"));
  assert.ok(results.length >= 19);
});
