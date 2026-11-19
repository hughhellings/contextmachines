/**
 * Saved tests on the bench's practice site (cli/bench/site.ts), written the way a passing run
 * saves them, for the local simulation and the fixtures. Three tests, one of each kind a CI run must
 * report: one that passes, one that fails (its check doesn't hold), and one whose saved element has
 * gone (not sure with no AI: the case a second pass with an AI is for).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SimTest {
  name: string;
  goal: string;
  path: string;
  check: Record<string, string>;
  click: string;
}

export const SIM_TESTS: readonly SimTest[] = [
  { name: "open-the-about-page", goal: "open the about page", path: "", check: { kind: "url_contains", text: "/about" }, click: "About" },
  { name: "pricing-shows-plans", goal: "pricing shows the plans", path: "", check: { kind: "text_visible", text: "Pricing plans" }, click: "Pricing" },
  { name: "open-the-documentation", goal: "open the documentation", path: "", check: { kind: "url_contains", text: "/docs" }, click: "Documentation" },
];

/** The folder name the CLI files a site's tests under ("localhost:4242" -> "localhost-4242"), as cache.ts hostSlug. */
export const hostFolder = (url: string) => new URL(url).host.replace(/[^\w.-]+/g, "-");

/** Writes the saved tests for `siteUrl` under `<root>/tests/<host>/`, and returns that folder. */
export function writeSimTests(root: string, siteUrl: string, only?: readonly string[]): string {
  const dir = join(root, "tests", hostFolder(siteUrl));
  mkdirSync(dir, { recursive: true });
  for (const t of SIM_TESTS) {
    if (only && !only.includes(t.name)) continue;
    const saved = {
      version: 1,
      goal: t.goal,
      url: new URL(t.path, siteUrl).href,
      steps: [{ title: t.goal, intent: t.goal, check: t.check, actions: [{ type: "click", target: { role: "link", name: t.click, nth: 0 } }] }],
      savedAt: "2026-11-17T00:00:00.000Z",
    };
    writeFileSync(join(dir, `${t.name}.json`), `${JSON.stringify(saved, null, 2)}\n`);
  }
  return dir;
}
