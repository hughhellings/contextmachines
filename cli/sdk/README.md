# Context Machines SDK: tests in code

Write tests in your own repo that mix exact Playwright steps with agent steps. Use a locator where
you know the element; hand a step to the agent where the page moves about. The agent runs on the same
engine as `contextmachines test`, with the same rules:

- **The browser decides pass or fail.** The AI picks actions and, for `assert("words")`, names a
  check once. It never says whether anything passed.
- **Four honest verdicts per step:** passed, failed (with what was expected and what the page had),
  blocked (a safety stop, another site, a bot check) and not sure. Steps after one that didn't pass
  are skipped.
- **Replay with no AI.** A test that passed saves its agent steps to a cache file. The next run replays
  them without asking the AI. If a saved element has gone, the AI finds another way for that step only,
  and the step says `healed`. With no AI the step is NOT SURE, never a guess.
- **Safety stops.** It never pays, buys, deletes or sends a message. It never leaves your site, and
  that includes your own locator steps. It waits on a bot check but never answers one.
- **Secrets by handle.** The AI writes `{password}` and the browser types the value. Values are
  masked in everything the AI sees, in the cache and in the report.

## A mixed test

```ts
import { test } from "node:test";
import { chromium } from "playwright";
import { createAgent } from "contextmachines/sdk";       // see INTEGRATE.md: not published yet
import { pickAgentBrain } from "contextmachines/sdk/brain";

test("search opens the chart", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const agent = await createAgent(page, {
    start: "http://localhost:3000",
    brain: pickAgentBrain("claude-code"),                 // your own AI, or none to replay only
    cache: "tests/.contextmachines/search.json",          // commit it; replays need no AI
  });

  // Exact: your own locators.
  await page.goto("http://localhost:3000/markets");
  await page.getByRole("button", { name: "Search" }).click();

  // The agent: one action at a time from the page, until the check holds.
  await agent.act("Type AAPL and open the Apple row", {
    check: { kind: "url_contains", text: "symbol=AAPL" },
  });

  // Measured by the browser: a check, or words the AI turns into a check once (shown and cached).
  await agent.assert({ kind: "text_visible", text: "AAPL chart" });
  await agent.assert("the page heading says AAPL chart");

  // Your own code as a named step: an error in it is a FAIL, leaving the site is BLOCKED.
  await agent.step("the price shows", async (p) => {
    await p.getByTestId("price").waitFor();
  });

  const report = await agent.finish();   // { verdict: "pass", aiCalls, replay, steps }
  await browser.close();
});
```

## Verdicts

If a step doesn't pass, it throws an `AgentStepError`. `error.verdict` is `"failed"`, `"blocked"` or
`"not_sure"`, and the message starts with `FAIL:`, `BLOCKED:` or `NOT SURE:`, so your test runner shows
what happened. Pass `{ soft: true }` to get the step back instead:

```ts
const step = await agent.act("Buy AAPL", { check: { kind: "url_contains", text: "/order" }, soft: true });
if (step.verdict === "blocked") console.log(step.reason);  // "'Buy AAPL now' wasn't pressed: ..."
```

`agent.finish()` gives the test's verdict: the first step that didn't pass decides it (`fail`,
`blocked` or `not_sure`), and a test with no such step is a `pass`.

## Checks

`text_visible`, `url_contains`, `element_visible` (role and name), `title_contains`,
`video_playing`, `video_paused`, `signed_in`, `password_gone`. Use `{name}` in a check to check a
value nobody sees: `{ kind: "text_visible", text: "Welcome {first_name}" }`.

An `act` with no check ends when the AI says done. It passes, marked `weak`, because nothing was
measured. Follow it with an `assert`. If the AI did nothing at all before saying done, the step is
NOT SURE and isn't cached. A test with no steps is NOT SURE, never a pass. An unexpected error inside a
step (the page closed, say) is a NOT SURE step, so `finish()` can't report a pass over it.

## Options

| Option | What it does |
| --- | --- |
| `start` | The site's address. The agent never leaves it. Defaults to the page's address now. |
| `brain` | The AI. Leave it out to replay only. |
| `cache` | The replay file. It is written only when every step passed and something new was learned. |
| `updateCache: false` | Read the cache but never write it (CI). |
| `vars`, `secrets` | Values typed by handle: `{ vars: { email: process.env.TEST_EMAIL } }`. |
| `allowHosts` | Other hosts the test may go to. |
| `maxPerStep` | The most actions one agent step may take (8). |
| `checkWaitMs` | How long a check is retried before it fails (5000). |
| `heal: false` | Never ask the AI when a saved element has gone (NOT SURE instead). |

## Bring your own brain

A brain is `{ decide(input): Promise<Action>, check?(words, page): Promise<Check> }`, the same
`decide` as the CLI's tester. `pickAgentBrain(choice)` uses the AI you already have (Claude Code,
Codex, an API key). Tests can script one, as `sdk.test.ts` does.

## Notes

- `createAgent` adds a route on the page's browser context to keep the test on its site. Use one agent
  per context.
- Assert verdicts are never cached. Only the check that words became is cached, and the browser
  measures it on every run.
- Sign-ins follow the CLI's rule. A password the site refused is BLOCKED and never typed again, and
  no account gets more than 3 sign-in submits. Pass one `signInGuard` (from `newSignInGuard()`) to
  every agent in a suite so the count is shared.
- Not here yet: the CLI's made-up values when the AI is stuck, the "friction" log, video and
  screenshots, and the HTML report. See INTEGRATE.md.
