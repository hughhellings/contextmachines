/**
 * A stand-in for `contextmachines test`, for testing the Action's two passes without a browser or an
 * AI: it logs how it was called (and whether an AI key was in its environment) to FAKE_CLI_LOG, writes
 * a result.json per test, and prints a suite JSON like the real one. The replay pass leaves one test
 * not sure for want of an AI; the AI pass heals it.
 *
 * Review additions: FAKE_CLI_EXTRA=1 adds a failed test "renamed-old" (its name starts like the not-sure
 * one's, so a loose --grep would give it an AI too; the AI pass would make it pass). FAKE_CLI_PRINT
 * prints that instead of a suite. FAKE_CLI_ECHO=1 makes the failed test's evidence and result.json show
 * the bypass secret from --url as bare page text (a page that prints its own address's code).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = flag("--out")!;
const ai = flag("--ai");
const grep = flag("--grep");
if (process.env.FAKE_CLI_PRINT !== undefined) {
  appendFileSync(process.env.FAKE_CLI_LOG!, `${JSON.stringify({ args, key: process.env.ANTHROPIC_API_KEY ?? null, github: null, ran: [] })}\n`);
  process.stdout.write(process.env.FAKE_CLI_PRINT);
  process.exit(Number(process.env.FAKE_CLI_EXIT ?? "0"));
}
const url = flag("--url");
const shown = process.env.FAKE_CLI_ECHO && url ? new URL(url).searchParams.get("x-vercel-protection-bypass") ?? "" : "";
const host = "shop.example";
const step = (verdict: string, reason?: string) => ({ n: 1, title: "t", intent: "t", check: { kind: "text_visible", text: "Done" }, verdict, ...(reason ? { reason } : {}), replayed: true });
const make = (name: string, verdict: string, s: ReturnType<typeof step> & { evidence?: { expected: string; found: string } }, healed = 0) => {
  const dir = join(out, "runs", name, ai === "none" ? "replay" : "ai");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ goal: name, url: `https://${host}/`, verdict, steps: [{ ...s, ...(healed ? { healed: { from: ["a"], to: ["b"] } } : {}) }], passed: verdict === "pass" ? 1 : 0, ms: 10 }));
  return { name, host, ms: 10, verdict, url: `https://${host}/`, passed: verdict === "pass" ? 1 : 0, steps: 1, healed, friction: [], report: relative(process.cwd(), join(dir, "report.html")) };
};
let tests = [
  make("ok", "pass", step("passed")),
  make("broken", "fail", { ...step("failed", "the check didn't hold"), ...(shown ? { evidence: { expected: "the page shows \"Done\"", found: `the page shows "Your code is ${shown}"` } } : {}) }),
  ...(process.env.FAKE_CLI_EXTRA ? [make("renamed-old", "fail", step("failed", "the check didn't hold"))] : []),
  make("renamed", "not_sure", step("not_sure", "can't find Clicking on 'Go' link; no AI to find another way (--ai)")),
];
if (ai !== "none") tests = [make("renamed", "pass", step("passed"), 1), ...(process.env.FAKE_CLI_EXTRA ? [make("renamed-old", "pass", step("passed"), 1)] : [])];
if (grep) tests = tests.filter((t) => `${t.host}/${t.name}.json`.includes(grep));
appendFileSync(process.env.FAKE_CLI_LOG!, `${JSON.stringify({ args, key: process.env.ANTHROPIC_API_KEY ?? null, github: process.env.GITHUB_TOKEN ?? process.env.INPUT_GITHUB_TOKEN ?? null, ran: tests.map((t) => t.name) })}\n`);
const count = (v: string) => tests.filter((t) => t.verdict === v).length;
const exit = count("fail") ? 1 : count("not_sure") ? 4 : 0;
process.stdout.write(JSON.stringify({ ok: exit === 0, exit, summary: { tests: tests.length, passed: count("pass"), failed: count("fail"), notSure: count("not_sure"), blocked: 0, couldNot: 0, healed: tests.filter((t) => t.healed).length, weak: 0 }, ms: 30, ai: ai === "none" ? null : { asks: 2 }, tests }));
process.exit(exit);
