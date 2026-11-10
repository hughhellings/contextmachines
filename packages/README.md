# The packages

Five packages hold everything `cli/` and `action/` run. None is published on npm: the CLI's build bundles them into one file.

| Package | What it is |
| --- | --- |
| `scanner/` | The learner. It drives the browser over a site, answers every save itself, presses buttons, fills forms, photographs screens and records findings. |
| `snippet/` | The script the learner puts in each page. It reads a page's structure, normalises addresses and redacts values. |
| `understanding/` | Turns what the learner saw into screens, actions and journeys (`src/learn/`, `src/features/`), and holds the AI's reading of them. |
| `schemas/` | The shape of everything the snippet records, checked wherever it's read. |
| `rules-core/` | The expressions behind a site's rules, and the shape of a field, shared by the snippet and the understanding. |

## Why it looks the way it does

This code wasn't written for this repository. Context Machines also has a hosted product that watches real visits to a site, and these packages are the parts of it the CLI needs, copied here by a script. Nothing here calls the hosted service. So a few things are there for a reason you won't find in this repository:

- **The snippet has code for sending events, deciding and guiding people** (`transport.ts`, `decide.ts`, `guide.ts`). On a real site it would talk to a server. The learner runs the same script so that what it reads is what's really collected, points it at an address that doesn't exist (`.invalid`) and catches what it sends inside the browser, so nothing leaves your machine.
- **The site learner carries a site's id** (`tenantId`, in `understanding/src/learn/learner.ts`), and that file has a store for many of them. The hosted product keeps one learner per customer. Here there's only ever one.
- **`understanding/src/guidance/` holds more than the CLI uses.** The CLI reaches a few of its rules, such as which pages aren't part of the product, and the rest of each file comes with them.
- **`scanner` and `understanding` are separate packages.** The first needs a browser. The second works from recorded events alone, so the hosted product can run it on real visits.

To find where something is in the CLI's own code, start at the table in [CONTRIBUTING.md](../CONTRIBUTING.md).
