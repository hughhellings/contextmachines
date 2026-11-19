# Saved tests in CI, and on every Vercel preview

`contextmachines test` saves each test that passes to `contextmachines/tests/`. Commit that folder,
and CI replays it on every pull request or every Vercel deployment. A replay needs no AI.

The `action/ci` GitHub Action does five things on each run:

1. Sets a pending commit status, `contextmachines - preview` (or `- production`, or `- ci`).
2. Replays every saved test in a real browser, with no AI. The AI key is not even in the CLI's
   environment for this pass.
3. Runs again with the AI only the tests that were "not sure" because no AI was there (a draft, or a
   saved element that has gone), and only if you set `anthropic-api-key` and `ai-max-tokens`. A failed test is never
   re-run: a check that didn't hold is the answer.
4. Writes JUnit XML and the job summary, posts one comment on the pull request (edited on later runs,
   never repeated), and uploads each run's video, report and any healed test as an artifact.
5. Sets the final status: `success` only when every test passed. A fail is `failure`. A not-sure,
   blocked or couldn't-run test is `error`. A Vercel Deployment Check or a required check can wait on it.

## Every Vercel deployment

Copy [`workflows/contextmachines-vercel.yml`](workflows/contextmachines-vercel.yml) to
`.github/workflows/` on your default branch. Then:

1. In Vercel, **Settings → Git**: turn on **repository_dispatch events**. Vercel then sends
   `vercel.deployment.ready` when a deployment has built, before its Deployment Checks run.
2. In **Settings → Deployment Protection**, add a **Protection Bypass for Automation** secret. Save it
   in GitHub as the repository secret `VERCEL_AUTOMATION_BYPASS_SECRET`. The Action adds it to the
   address the way Vercel reads it. It is masked in the log and redacted from the comment, the summary
   and every file written.
3. Optional: add `ANTHROPIC_API_KEY` as a secret. Without it, a test that needs an AI is "not sure"
   and the status is `error`.
4. After the first run, in **Settings → Build and Deployment → Deployment Checks → Add Checks →
   GitHub**, pick `contextmachines - production`. A production deployment whose tests don't all pass
   then stays off your domains.

The event names no pull request. The Action finds the open pull request whose head is the deployed
commit and comments there. A production deployment of `main` usually has none, so its result goes to
the job summary and the status only.

## Every pull request, without Vercel

Copy [`workflows/contextmachines-pr.yml`](workflows/contextmachines-pr.yml). Point `url` at wherever
the commit is running. Leave `url` empty to run each test on the address it was saved on.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `url` | from Vercel's event | Run every saved test on this address's origin, each keeping its path |
| `environment` | from Vercel's event, else `ci` | Names the status and keeps one comment per environment |
| `vercel-bypass-secret` | | Vercel Protection Bypass for Automation |
| `ai` | `auto` | `never`: no AI, even with a key |
| `anthropic-api-key` | | Only the second pass sees it |
| `ai-max-tokens` | | The most tokens each AI pass may take. Needed with `anthropic-api-key`: without it, no AI is asked |
| `tests-dir` | `contextmachines` | The folder whose `tests/` holds the saved tests |
| `grep` | | Only the tests whose file or goal has these words |
| `minutes` | `3` | The most time for each test |
| `sha`, `pr` | from the event | The commit for the status, and the pull request for the comment |
| `comment`, `status` | `true` | Set to `false` to skip either one |
| `status-name` | `contextmachines - <environment>` | The status a check waits for |
| `fail-job` | `true` | `false`: only report; the status still says how it went |
| `key` | | Keeps two uses in one job apart |
| `github-token` | `github.token` | Used for the comment, the status and the PR lookup, and nothing else |

Outputs: `junit`, `tests`, `passed`, `failed`, `not-sure`, `state`, `pr`.

Permissions the job needs: `contents: read`, `statuses: write`, `pull-requests: write`. On a pull
request from a fork the token is read-only: the result goes to the job summary only, and secrets
such as the AI key are not given to the run.

Values a saved test types as `{name}` come from `CM_VAR_<NAME>` in the step's `env`. Set them from secrets.

## What it never does

- It never sends the GitHub token to the CLI, the browser or the AI. The token goes only to GitHub's
  API, and the Action never follows a "next page" link to another origin.
- It never puts site text in the comment as live markdown. "@team" doesn't ping, "#12" doesn't link,
  and a page's `<details>` stays text.
- It never writes into your checkout. Healed tests land in the artifact (`out/tests/`). Commit them,
  or they heal again on every run.
- The product's own rules still hold: it never pays, posts, sends or deletes, and it never tries to
  get past a bot check.

## Saved tests on a new address (cache identity)

Every preview has a new address. Today a test run on another origin replays but is never healed. A
saved jump to the test's own origin is stopped as "another site". The next engine change lets you
name the app once:

```json
{ "url": "http://localhost:3000", "identity": "shop" }
```

Tests are then filed under `tests/shop/`, and on any address of the same app they are healed and
saved as at home. See `INTEGRATE.md` section 5. Until that lands, keep the elements your saved tests
use stable, or run with `ai: never` and treat a not-sure test as a prompt to re-record locally.

## Try it locally

```bash
node action/ci/simulate.ts
```

This starts the practice site (`cli/bench/site.ts`) and a fake GitHub on 127.0.0.1, then plays
three Vercel preview events through the Action with the CLI from this checkout and no AI. It prints
each check, then the PR comment as the last run left it.
