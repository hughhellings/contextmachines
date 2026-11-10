# Contributing

Thanks for looking. This is how to run it from source, where things live, and the two rules that matter most here: every finding must be provable, and a fix fixes the technology, not one site.

## Set up

You need Node 24 or newer for development: it runs the TypeScript sources directly, so there is no build step until you package it.

```bash
git clone https://github.com/hughhellings/contextmachines.git
cd contextmachines
npm install
npm run build:snippet            # the browser snippet the learner reads pages with
npx playwright install chromium
```

Rebuild the snippet whenever you change `packages/snippet`.

## Run it

```bash
node examples/invoice/server.mjs &                                    # a small app to learn, at localhost:3000
node cli/contextmachines.ts learn http://localhost:3000 --out /tmp/cm --minutes 1
node cli/contextmachines.ts diff before/map.json after/map.json
```

Set an AI key (or be signed in to Claude Code or Codex) to get the AI reading; `--ai none` runs without one. `node examples/invoice/server.mjs --changed` serves the same app after a change, for trying `diff`.

To build the package that goes to npm (one bundled file, the snippet and a `package.json`, in `cli/dist`):

```bash
npm run build -- --version 0.1.0
```

## Test

```bash
npm run typecheck                       # tsc --noEmit -p .
npm test                                # every test
npx vitest run --project scanner        # one project
node --test cli/report.test.ts          # one of the CLI's own tests
npm run check                           # typecheck, snippet build, tests and the package build
```

The vitest projects are named after their folders in `packages/`. The `scanner` tests drive a real browser against a small local site (`packages/scanner/test/fixture-site.ts`) that records every request it receives, so a test can prove what never reached it. The CLI's and the Action's tests use `node:test` and need no browser.

## Where things are

| Path | What it is |
| --- | --- |
| `cli/contextmachines.ts` | The command: arguments, help, exit codes, running the learner and the understanding, the terminal output, and `diff` |
| `cli/understand.ts` | The understanding, run on this machine: what the learner saw, turned into screens, actions, journeys and the AI reading |
| `cli/report.ts` | What it writes: `PRODUCT.md`, `map.json`, `report.html`, and the `diff` markdown |
| `cli/predictions.ts` | "Might trip people up": predictions from plain rules over the map |
| `cli/ai.ts` | Bring your own AI: picks one and asks it the question |
| `cli/init.ts` | The guided setup, and `cli/wordmark.ts`, the mark it opens with |
| `cli/project.ts` | What a folder is: which app, how it starts, how people sign in, whether it's running |
| `cli/repo.ts` | The only code that reads a repository: what may go to the AI |
| `cli/code-map.ts` | The code read: claims from the source, each checked against a line of it, kept apart as read, not seen |
| `cli/build.mjs` | Bundles the CLI with esbuild for npm |
| `action/` | The GitHub Action: learns before and after, keeps one comment on the pull request |
| `packages/scanner/src/scan.ts` | The learner: drives the browser, stops every save, presses buttons, fills forms, photographs screens, records issues |
| `packages/understanding/` | The understanding the CLI uses: the site learner (`src/learn/`), features and the AI reading (`src/features/`) |
| `packages/snippet/` | The browser snippet: reads page structure, normalises addresses and redacts values. The learner runs the real one. |
| `packages/schemas/`, `packages/rules-core/` | Shared contracts for what the snippet records |
| `examples/` | The invoice app with a run's output, and the Action's workflow |
| `skills/contextmachines/` | The skill coding agents install with `npx skills add hughhellings/contextmachines` |

## Adding an AI provider

Everything is in `cli/ai.ts`. A provider is an `Ai`: a model name, how it's named to the person (`via`), and `ask(system, question, schema)`, which returns the answer as JSON text. The answer is checked against what was seen by the same code whatever AI gave it (`checked` in `packages/understanding/src/features/describe.ts`), so a provider only has to ask.

- A server that speaks the OpenAI chat format needs one line in `COMPATIBLE`: its address, the environment variables that hold its key, and a default model.
- Anything else gets its own function, like `anthropic`, `claudeCode` or `codex`.
- Then add it to `AI_CHOICES`, decide where it falls in the order `pickAi` tries (keys the person set, then signed-in coding agents), and add it to the table in `README.md`.

A provider must send only the question: never the person's own settings, tools or connected servers, and never a value from the site.

## Adding a kind of finding

Issues found while exploring are recorded by the learner, in `packages/scanner/src/scan.ts`, as it presses and loads things. The CLI shows them in the terminal, in `PRODUCT.md`, in `map.json` and as new or fixed in `diff`.

A finding must be **provable**: something the browser saw happen, such as a status code, a thrown error, or a press after which nothing on the page or the network changed. Never an opinion about design or wording. If two careful people could disagree about it, it isn't a finding. (A guess about where people may get stuck belongs in `cli/predictions.ts`, labelled as a prediction.)

Every new kind comes with a test in `packages/scanner/test/` against the fixture site that has both:

- **the real thing**, which it must report, and
- **traps**: things that look like it but aren't, which it must not report. For "does nothing", a button that opens a menu, one whose only effect is a request, one that changes the page a moment later. For "request fails", a 404 the page expects, or an error on another address.

A kind that fires on a trap doesn't ship. A false alarm costs more trust than a missed issue.

## Fixing the technology, not one site

When it gets a site wrong, the fix is a general rule, not a special case:

1. **Write down the principle** the fix implements, in a plain-English comment beside it.
2. **Show it holds beyond one site:** at least two real sites that behave that way, or a well-known web pattern. Say which in the pull request.
3. **No site-specific hosts, words or selectors** in the code. A test fixture may imitate a site; the product code may not name one.
4. **Add the trap test** that would have caught the mistake, and keep the old traps passing.

If a test fails, the question is what the product does wrong, not how to make the test pass.

## Style

Match the code around you: its names, how much it comments, and comments in plain English that say why. No new dependencies unless there's no other way. Anything it prints or writes goes through the same helpers (`safe()` for terminal text, `redact()` for addresses, `cell()` in the Action's markdown), because the site's text is untrusted.

## Issues

Search first: someone may have reported it. A good report has:

- the command you ran, and the output of `npx contextmachines --version`
- your Node version (`node --version`) and operating system
- whether the site is public, so we can run it ourselves (the fastest way to a fix)
- what it printed, with **anything private redacted**: output holds the site's own text, addresses and screen names

A wrong or missed finding has its own form. Security problems go to [SECURITY.md](SECURITY.md), never to a public issue.

## Pull requests

Keep them small and say what changed for the person running it. `npm run check` should pass. If you changed what the CLI prints or writes, paste a before and after. Add a line under `## Unreleased` in `CHANGELOG.md` for anything a user would notice.

## Releases

A maintainer releases by moving the `## Unreleased` notes under a new `## x.y.z - <date>` heading in `CHANGELOG.md`, setting `action/version.txt` to the same version, and pushing a `vx.y.z` tag. The release workflow checks the tag against both, builds and packs that version, tries the packed package on the example app, publishes it to npm with Trusted Publishing (the npm package's trusted publisher must be set to this repository's `release.yml`), makes the GitHub release from the CHANGELOG section, and moves the Action's tag. While it is 0.x that tag follows the minor (`v0.1` moves to 0.1.1, 0.1.2…; 0.2.0 starts `v0.2` and leaves `v0.1` alone), from 1.0.0 the major (`v1`); it only ever moves forward, and a pre-release moves none.

## License

Context Machines is licensed under Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Contributions are accepted under the same license (inbound = outbound, as section 5 of the license says): by opening a pull request you agree your contribution is licensed under Apache-2.0. There is no CLA to sign.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
