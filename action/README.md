# Context Machines GitHub Action

Learns your app before and after a pull request and keeps one comment on the pull request up to date: the new issues the change brings, each one seen happening, and what it does to the product (screens and actions added, gone, renamed or moved, a different main action, a journey broken).

It learns the apps at the addresses you give it, such as the pull request's preview deploy and production. It never builds or runs the pull request's code. Saves are answered on the runner and anything it can't show is a read is held back. A GET that writes behind an innocent name can't be told from a read, so with a saved sign-in use a test account ([what it can't prove](https://github.com/hughhellings/contextmachines#what-it-cant-prove)).

```yaml
# .github/workflows/contextmachines.yml
name: Product diff
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  contextmachines:
    runs-on: ubuntu-latest
    steps:
      - uses: hughhellings/contextmachines/action@v0.1
        with:
          url: https://pr-${{ github.event.number }}.preview.yourapp.com   # the app after this change
          base-url: https://yourapp.com                                     # the app before it
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}               # optional
```

The preview has to be up when the job runs. If another workflow deploys it, run this one after that workflow, with its preview address as `url`.

## The comment

```markdown
### 🔴 Context Machines: 1 new issue · 1 screen added · 1 action renamed

**New issues**, each seen happening:

- 🐞 "Download PDF" does nothing when pressed on `/invoices/:id`

▸ What this change does to the product (2)
▸ Issues fixed (1)

Context Machines 0.1.0 · 2m 14s · https://pr-12.preview.yourapp.com · screen photos
```

- The headline is red only when the change brings new issues. A changed product with nothing broken is green, and the counts say what changed.
- New issues are always shown. Product changes and fixed issues are folded, and long lists stop at 30 with "and N more".
- The comment stays under GitHub's size limit. When it would not fit, the folded parts go first and a note says so. The job summary always has everything.
- "screen photos" links to the run's artifact: each run's `PRODUCT.md`, `map.json` and a photo of every screen.
- Without `base-url`, the comment describes the product as it stands, with every issue found.

Everything in the comment that came from the site, or from an AI that read it, is escaped. A button labelled `@everyone`, `#1` or `<details>` shows as that text. It doesn't ping anyone, link an issue or change the comment.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `url` | (required) | The app after this change, usually the pull request's preview deploy. |
| `base-url` | | The app before this change (production, or the main branch's preview). Without it, the comment describes the product as it stands. |
| `anthropic-api-key` | | With it, actions are named in plain English and the product is described. An unchanged product reuses its last reading, so repeat runs cost nothing. |
| `minutes` | `3` | How long to explore each version, 1 to 30. |
| `fail-on-new-issues` | `false` | `true` fails the job when the change brings new issues (without `base-url`, any issue). The comment is written first. |
| `comment` | `true` | `false` writes the result to the job summary only. |
| `key` | | Gives each use of the Action in one job its own comment, work dir and artifact, for two apps or the legs of a matrix. Letters, digits, `.`, `-` and `_`. |
| `github-token` | `github.token` | Used to comment, and only for that. |
| `artifact` | `true` | `false` keeps the screen photos off GitHub. |
| `work-dir` | runner temp | Where each run's `PRODUCT.md`, `map.json` and screen photos are written. |
| `cli` | | For testing Context Machines itself: a path to a local CLI, used in place of the published package. |

## Outputs

| Output | What it holds |
| --- | --- |
| `changed` | `true` when the change alters the product's screens, actions, journeys or issues and `false` when it doesn't. Empty without `base-url`, because there is nothing to compare with. |
| `issues` | The number of new issues the change brings. Without `base-url`, every issue found. |
| `map` | Path to the `map.json` of the app after the change. |

```yaml
      - id: product
        uses: hughhellings/contextmachines/action@v0.1
        with:
          url: ${{ needs.preview.outputs.url }}
          base-url: https://yourapp.com
      - if: steps.product.outputs.changed == 'true'
        run: gh pr edit ${{ github.event.number }} --add-label product-change
        env:
          GH_TOKEN: ${{ github.token }}
```

## When the job fails

| Exit | Meaning |
| --- | --- |
| 0 | It learned both versions, whatever it found. |
| 1 | `fail-on-new-issues` is on and the change brings new issues. |
| 2 | An input was refused: no `url`, a bad `minutes` or `key`. |
| 3 | A site couldn't be reached or read. Is the preview up, and public to the runner? |

Commenting never fails the job. When GitHub refuses the comment, a warning says why, and the result is in the job summary:

- **403 or 404:** the job lacks `permissions: pull-requests: write`, or the pull request comes from a fork, where the token is read-only.
- **401:** the token wasn't accepted. The default `github.token` works.
- **Rate limit:** the next push tries again.

## What it can see and change

- **The token is only for the comment.** The learner, its browser and the AI never see `github-token`, `GITHUB_TOKEN` or any `ACTIONS_*` variable.
- **It edits only its own comment.** It finds that comment by a marker on the first line and by its author: the token's own user, or, for the workflow's token or a GitHub App's, a bot. A person who pastes the marker into a comment of their own doesn't get it overwritten.
- **Site text can't run workflow commands.** While the learner prints, GitHub is told to ignore `::` commands, so a page's text can't set outputs or masks.
- **The artifact can be downloaded by anyone who can read the repository's Actions runs.** On a public repository that is everyone. Set `artifact: false` if your previews show data that should stay private.
- **Secrets in the address stay out of the comment.** A user name and password (`https://user:pass@…`) and the value of any query parameter named like a secret or shaped like a token (`?x-vercel-protection-bypass=…`) are removed from the address before it goes in the comment, the job summary or the Action's own log lines. The learner still gets the address as you wrote it. Put the secret part in a repository secret (`url: https://pr-12.preview.yourapp.com/?x-vercel-protection-bypass=${{ secrets.VERCEL_BYPASS }}`) so GitHub masks it in the rest of the log too.
- **It runs a pinned version.** Each release of the Action runs the `contextmachines` package at the same version, and the browser that version's Playwright expects.

## Which version you get

While Context Machines is 0.x, a minor release may change the comment, the inputs and `map.json`, so the Action's tag follows the minor: `@v0.1` moves to each 0.1.x patch release (0.1.1, 0.1.2…) and never to 0.2.0, which starts its own `@v0.2`. Moving up a minor is your choice, after reading [CHANGELOG.md](../CHANGELOG.md). From 1.0.0 on, `@v1` will follow 1.x. To never move at all, pin a release (`@v0.1.0`) or its commit SHA.

## Runners

It needs a Linux runner such as `ubuntu-latest`, because it installs the browser's system libraries with apt. It sets up Node 24 with `actions/setup-node`, and later steps in the job use that Node.

## Running it locally

The Action is one script, `run.ts`. It reads its inputs from `CONTEXTMACHINES_<NAME>` as well as from GitHub's `INPUT_<NAME>`:

```bash
CONTEXTMACHINES_URL=https://pr-12.preview.yourapp.com CONTEXTMACHINES_BASE_URL=https://yourapp.com node action/run.ts
```

Without GitHub's variables it prints the comment and doesn't post it. `node --test action/run.test.ts` checks the comment, its escaping and the one-comment rule against a stand-in GitHub API.
