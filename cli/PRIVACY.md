# Privacy and safety

What `contextmachines` does with the site it learns, and with what it sees there. Each point below is what the code does today; the file that does it is named so you can check.

## It runs on your machine

- The browser, the learning and the understanding all run in the `contextmachines` process. The understanding (`packages/understanding`) is called directly (`cli/understand.ts`). There is no Context Machines server, and nothing is uploaded to one.
- The one call out of your machine that `contextmachines` makes itself is to the AI you choose, if any (see below). With `--ai ollama` or `--ai none`, nothing leaves your machine except the visits to the site: the browser's, and a `HEAD` request from Node to check the address answers before the browser starts.
- `init` can download the browser for you (Playwright's own download, from Playwright's servers). It asks first, and `--yes` doesn't count as a yes.
- `init` asks Claude Code and Codex, if you have them, whether you're signed in (`claude auth status`, `codex login status`). Claude Code runs with its telemetry and update checks off, as it does for every ask.
- Your source code stays here unless you say yes. With that yes it goes to the AI you chose, and to nobody else (see [Reading your code](#reading-your-code)). Finding where to change something searches your repository on this machine and sends nothing.
- There is no telemetry and no account.

## What it does to the site

The browser visits the site as a new visitor would. Its pages load as they normally do, including anything they load from other addresses (scripts, fonts, images). What the learner stops (`packages/scanner/src/scan.ts`):

- **Saves are answered in the browser.** Every request that isn't GET, HEAD, OPTIONS or QUERY, and any GraphQL it can't read as a query, is stopped there. So is any request carrying a value it typed, search boxes aside. Requests to the site are answered with a harmless "OK" of the learner's own, so the page carries on as if it had saved. Requests to other addresses that the page's code sends right after a press are answered the same way and recorded as stopped saves, with the host they were for. Other requests to other addresses are dropped. Neither kind leaves the browser.
- **After a stopped save, what the page kept goes back.** The browser's `localStorage`, `sessionStorage` and any cookies scripts can set are put back to how they were, so a made-up reply isn't kept.
- **Trackers and other requests the page sends by itself** are stopped too, but counted apart and never listed as actions.
- **Live connections only carry reads.** A WebSocket stays open so the page keeps working, but a message on it reaches the server only when it has the exact shape of a known read or the connection's own upkeep (a heartbeat, a join). Any other message, a binary one included, is held back. WebSockets in workers never connect, and WebTransport, WebRTC and shared workers are taken away.
- **Whatever it can't be sure is only a read is held back.** A link or read on the site whose address or words say it acts (signing out, deleting, removing, unsubscribing, in several languages) isn't sent, and for five seconds after a press that says it acts, nothing but named files is. Every redirect hop is checked the same way.
- **Some buttons are never pressed:** signing out, paying, buying or checking out, signing in with another provider (Google, Apple, Microsoft, GitHub), printing, closing an account.
- **Cookie banners are declined.** It presses "Reject all", "Necessary only" or the like, and never accepts.
- Pop-up windows are refused, downloads are refused, and service workers are blocked.
- It goes at a gentle pace, one page at a time, within `--minutes` and `--pages`.
- Forms are filled with test values (`learner@example.test`, `https://example.test`, `Test`, `10`, and so on), never with anything of yours.
- It tells the site what it is: its browser identifies itself with its normal User-Agent followed by `ContextMachines/0.1 (+https://github.com/hughhellings/contextmachines)`.

What it can't promise: a GET with an innocent name that writes can't be told from a read, so it reaches the server (`/api/save-get?name=x` behind a button that says "Refresh stats"). Files always load, so an image address that acts isn't stopped. Reads to other addresses go out, unless they carry what it typed. Use a test account or staging when signed in. [The README](https://github.com/hughhellings/contextmachines/blob/main/README.md#what-it-cant-prove) has the full list.

With `--create`, saves to the site do go through, so it can reach screens that only exist after creating something. It asks first (unless `--yes`). A write that says it destroys something is still stopped, whether it says so in its method, its address, its headers or anywhere in its body. That's best effort: one with a neutral name and body goes through. Writes to other addresses are never sent. Use it on test accounts only.

With `--login` or `--session` it acts as that account: everything it reads, it reads as them, and a site may count that (last seen, read receipts).

The browser window that `--login` opens is yours until you press Enter: nothing is stopped there, because you are the one using it.

## The stand-in user

On a local address (`localhost`, `127.0.0.1`, `::1`, `*.localhost`), when a look through the public pages shows a sign-in in the way, it walks the screens behind it as a made-up user, with the public pressing going on beside it. Nobody signs in, and no server ever sees that user. It's turned off with `--no-stand-in`, and it never runs on any other address, in a build (`CI` set), or with `--login`, `--session` or `--create` (`packages/scanner/src/stand-in.ts`).

It runs in a new browser with nothing of the public crawl in it and nothing between the two, under a rule of its own that comes ahead of everything above. That rule is a seal:

- **That browser reaches nothing, your dev server included.** Node reads your dev server's files and hands them over, with no cookie and no header the page chose. So a cookie an app sets for itself goes nowhere.
- **Every address gets one document.** The app's own page is read once and used for all of them, so no page address reaches your dev server from that browser. Addresses a dev server runs code for (`/api`, `/auth`, `/graphql`, `/rest` and the like) and anything your dev config hands to another server don't load at all.
- **Only what can be shown to be a file is read:** GET or HEAD of a script, stylesheet, image or font, on that one host and port, and only if it's the dev server's own, really in your app's folder, named by what your app's page or modules load, or in a folder your app's page loads from. An address that merely looks like a file isn't enough, since a dev proxy takes those too. Hidden files such as `.env` and files a server runs are never read, however the address is spelled. A query stays behind unless your server sent that very query itself, so a session a page puts in an address goes nowhere.
- **Every data call is answered in the browser,** same-origin ones too, with made-up rows or an empty result. Where no sign-in library is named, an app's own `/api/me`-style call is answered there too, with the made-up user. A save the app sends by itself is stopped there. This pass presses nothing.
- **Everything else goes nowhere.** Other hosts, other local ports, beacons and event streams are refused. Sockets connect to nothing. Beneath all that the browser itself is sent to a proxy that doesn't exist, with no exception at all, so what the rules above can't see (a prefetch, a worklet, a request timed to go later) has nowhere to go.
- **It checks itself first.** Before your app is opened, a page of its own proves the seal holds, and a page with none of those rules proves the browser can't reach your dev server by itself. If either fails, the app isn't opened that way.
- **It stops at what a browser can't decide.** If your server turns an address away, moves it to a sign-in page or draws it itself, the browser isn't what decides who gets in, so that pass ends, or leaves that page out.

Before that walk, the same seal shows your app to a made-up account made a minute ago, with no rows and no finished setup, so first-run and empty screens are seen. It only looks and presses nothing, and no server of yours hears from it. What those screens draw goes to your AI with the review, if you have one (see [What goes to the AI](#what-goes-to-the-ai)).

Those two passes press nothing. The journeys are the one pass that does, in a third browser under the same seal, and only there: it never runs with `--login`, `--session` or `--create`, and it can't start without a seal that has passed its check.

- **Every write stays in the browser.** It's answered there and kept there, so later screens can show it, and all of it is gone when that browser closes. No save, session or typed value reaches your server or anyone else's.
- **It has no way out of its own.** Each press and page load goes through the seal above and the read-only rule behind it, with the same verdicts. What it adds is a record of what the page tried, by kind and address, with no body and no query.
- **What's real is left alone.** Anything that reads as a payment, an email, an invite, an outside account or another site isn't pressed, and a press that goes for one ends the journey. So does a form or box asking for a card, a `DELETE`, or a screen saying it's taken money or sent mail. Destructive and sign-out controls are never pressed. Every question a page asks gets a no.
- **What it types is plainly made up,** and no file chooser is ever given a file, not even a made-up one.
- **Nothing new goes to the AI.** There's no question about the journeys. What the walk sees isn't added to the review, and what the code read found goes the other way: labels and addresses, checked, with no source. With no yes to reading the code, the walk goes by what the screens offer.

The session is made up, unsigned and seen only by that browser. It carries an address that can't belong to anyone (`stand-in@example.test`). Numbers on those screens are masked as on any signed-in run, and the rows are invented (see below).

Those screens are marked in `PRODUCT.md`, `map.json` and `report.html`. They're your app's real screens showing data that isn't real, so no finding comes from them and `diff` ignores those screens and their actions. What's measured on them (a label cut off, a template left unfilled) does become an item in the fix list, marked as seen on a stand-in screen, and `diff` reports a new one.

To tell who decides, each page address the public crawl opened or your code read named is read from Node, signed out, with no query and nothing of the browser's on it, unless that read might act or your dev config sends it to another server. If your dev server hands on everything it doesn't have and that can't be read, no page address is read at all. A link met on a stand-in screen is never read, and nor is an address that's only tried, such as a route string found in your code: each gets the one document, reaches no server, and what it draws has to show it's a screen. Route strings are looked for only after a yes to reading your code; without one, none is tried.

The public crawl before it isn't under the seal, but on a local address it stays on this machine: nothing goes to another host, and the browser can't resolve one, so a hosted database, sign-in and trackers don't hear from the browser. Your own server is really running, though, and reads whatever database it's set up to use, so what its pages draw is real, and text drawn on a page with no sign-in goes to your AI (see [What goes to the AI](#what-goes-to-the-ai)). An address your project's config hands on to another server counts as another host, and the result lists what was held. A proxy no config shows can't be seen, so your own server's code can still reach out; if a proxy is there and can't be read, your pages' calls are held and the result says their pages and files may have gone through it. `--login` and `--create` lift that, as they ask for the real thing. The pass runs your front end's own code in the browser, as any run does.

## Reading your code

This takes a yes: at `init` (saved as `readCode`, and it applies to your local address), or `--code` for one run. `--no-code` turns it off whatever was saved. `init --yes` doesn't count as a yes. It never happens in a build unless `--code` is there, and not with Ollama yet, or with `--ai none`. It only runs when the browser met a sign-in.

Only one file reads your repository (`cli/repo.ts`), and the AI gets no tools, so it can't open anything that file left out. A file can be sent only if it passes all of these, in order, and a file that fails on its name is never opened:

1. It's tracked by git in this folder.
2. It's a code file by type. That's a list of what may go: docs, SQL, shell scripts, data files, `.env.example` and `.orig` files don't.
3. Its path names nothing secret, and it isn't tests, fixtures, seeds, build output, scripts, migrations or an old copy.
4. It's a real file inside the folder, of a sensible size: not a link out, not minified.
5. Nothing in it is shaped like a key, a password, a token, an address with a password in it, a sign-in on a command line, or a list of people. A random-looking value counts wherever it is, unless the name it's given says it's public. A file with one or two stray contact details goes with those taken out.

Comments and docstrings are sent, since code is hard to read without them, with anything in them that reads like a value masked: the word after a credential's name, and any word with a digit in it.

That filter is a best effort, not a proof: a secret that looks like ordinary text can get through it. Don't keep secrets in tracked code.

Before anything is sent it checks, with no AI, that this folder is the site the browser saw: the words on its pages have to be in these files. If they aren't, nothing is sent. Translation files, and code held back for what's in it, are read here for that check and go nowhere.

Then what goes to your AI is:

- the list of file paths that passed, with their sizes, and the names of your dependencies
- the files it picks as deciding the routes (up to 12, about 120 KB in all), and the addresses the browser opened on the public pages
- each screen's own files, up to about 30 KB a screen and 15 screens, cut down to their lines with words and actions when they're long
- table and column names from tracked SQL files, as names only: the SQL itself is never sent
- to make up sample rows: those table and column names, and nothing else

Where your AI lets it choose a model, these go to a smaller one from the same provider, under the same sign-in or key: `claude-haiku-5-5` with an Anthropic key, `haiku` with Claude Code, `gpt-5-mini` with OpenAI, `gemini-2.5-flash` with Google, `anthropic/claude-haiku-5-5` through a gateway. If that one can't answer, the same question goes to your main model. With `--model` or Codex, it's your one model.

Every file sent is listed in `map.json` (`fromCode.coverage.filesSent`, or `learner.codeRead.filesSent` when a read stopped early), and every single line sent with the review (see [What goes to the AI](#what-goes-to-the-ai)) in `learner.review.codeLinesSent`, as `file:line`, so you can check exactly what left your machine.

The sample rows are written by your AI from column names alone, a few tables at a time. Once they're back, a column named after another table (`account_id`) is pointed at that table's made-up ids, on your machine. Each value is checked: anything shaped like a real address, phone number, card, key or token is dropped, and so is anything found in your data files but not your code. They go only to the stand-in's browser and to `.code-read.json`, never to `map.json` or `PRODUCT.md`.

What comes back is checked before it's kept: a claim has to cite a line that's really in the file, in code, not a comment. That shows the line exists, not that what's said about it is right, so all of it stays apart, under "Read from the code, not seen".

Reading your code runs none of it, and opens no session.

## Starting your app

If nothing is running, `init` offers to run your dev command. That runs your project's code, so it takes a yes for that one command, and `--yes` never does it. What the server prints is read only for its local address, and isn't shown or kept. It's stopped when `init` ends.

`init` and `learn` also list what's listening on this machine, with each process's working folder, to tell your app from another copy of it. That stays on your machine. Of your project's files they read `package.json`, framework configs and marker files by name, never an `.env` file.

## What goes to the AI

Unless you said yes to [reading your code](#reading-your-code), two questions per run, and none when the product hasn't changed since the last run. The first reads what the product is for (`packages/understanding/src/features/describe.ts`). It contains:

- each screen's address, title and first headings, with tokens in that text redacted
- the labels of its buttons, and the labels or names of its form fields and submit buttons
- each action as its request (`POST /api/invoices/:id/send`), the label of the button that sent it, the names of the fields it sends (not those that look secret, such as passwords, tokens or card numbers) and the names of the fields it gets back

Addresses are reduced to patterns before anything is recorded: ids, emails, file names and names after `/users/` or `/clients/` become `:id`, and query strings keep their keys only (`packages/snippet/src/url.ts`).

It never contains a field's value, anything typed, a request's or response's values, cookies, the saved sign-in, or screen photos. On a stand-in run it covers those screens too, and the AI is told their contents are made up.

Headings and titles are the page's own text. On a screen that shows one record they can include that record's name ("Invoice for Acme Ltd"). Signed out, numbers in that text are kept, since they are the site's public text; on a real session (`--login`, `--session`, `--create`), they are masked. Learn with a test account if names matter.

The second is the review behind the fix list (`cli/brief.ts`): where does a person get stuck, wait, pay before they see value, or lose work? It's at most about 24 KB of text, and contains, for up to 30 screens, new-account screens first:

- each screen's address, its heading, and the text drawn on it, navigation and lines repeated across most screens left out
- the labels and kinds of the controls in its main area, what's shown as locked, and its empty states with the action beside each
- with a yes to reading your code: the rules that read found, each with the one line of code that holds it, and up to 16 single lines about a plan's limits or the app refusing something, found with no AI by searching every file that passed the checks above. Those lines can come from a file the read itself didn't send, and each still has to pass the secret and personal-details checks on its own. Where each one was is recorded in `map.json` (`learner.review.codeLinesSent`)

Text drawn on a page reached without a sign-in goes to your AI, on a local app too, where the page may be drawing what's really in your database. Table cells (`td`, `role=cell`, `role=gridcell`, row headers) are left out of that, along with any link, button or message inside one; names and amounts drawn outside a table do go. On stand-in screens, where every row is made up, table cells go too, and a line holding a made-up row's value is taken out before anything is asked. So is any line shaped like a secret, an email address or a phone number, national formats included, which takes in any run of 9 to 15 digits. These checks go by shape, so they're a best effort.

That's the review. The first question has every button's label, whatever it sits in, so a name in a label in a table row ("Remind Jane Doe") can go there, and `FIX.md` can name that button if it does nothing.

On a run with a real session (`--login`, `--session`, `--create`), the lines of text a screen draws aren't sent. Its heading, labels, what's marked as locked and its empty-state sentences still go, with digits masked. Those are the page's own words, so they can still hold a name ("Jane Doe's workspace"). Use a test account if that matters.

No photo is ever sent: a signed-in Claude Code can take one, but a quote can only be checked against text.

To send none of this, use `--ai none`, or `--ai ollama` to keep it on your machine.

Which AI, and how: `cli/ai.ts`. With a signed-in Claude Code or Codex, only the question is sent: none of your settings, tools, skills or connected servers are loaded, Claude Code runs with its telemetry and update checks off, and Codex runs in an empty folder in a read-only sandbox with its shell and web search off.

### What it notes about the asks

`map.json` records what the AI took, so you can see the cost of a run. Nothing here is sent anywhere; it's in a file that is meant to be committed, so anyone who can read your repository can read it.

- `learner.ai`: which AI, as `via` ("your Claude Code sign-in", for example), how many asks and how many failed, the token counts the answers gave (in, out, read from and written to the AI's cache, and the share cached), the models that answered, and a cost in dollars only where the provider gave one (OpenRouter, for example).
- `learner.timing.asks`: one entry per ask, with the part of the run that asked (code read or review), the model, the size of the ask in characters, when it started and how long it took, whether it failed, its tokens (split by model when more than one answered), its cost where the provider gave one, and the first 48 characters of the fixed instructions, which are the same for every app ("You review a web product the way…").

It never records the question itself: no page text, no code, no file names. Codex gives no token counts, so with Codex there are none.

## What it writes, and where

Everything goes in the output folder (`--out`, default `./contextmachines`), except the AI's last answer when `--reading-cache` names a file elsewhere:

| File | What's in it |
| --- | --- |
| `FIX.md` | What to fix: each item's evidence, where to change it and what to do. It can quote the app's drawn words and a line of your code. A broken line in a table cell is quoted as the broken phrase alone, and so is any broken line on a real session, where digits in labels and in logged lines and errors are masked too, though a label or a logged line can still hold a name. Written fresh by every run. |
| `PRODUCT.md`, `map.json`, `report.html` | What it understood. A screen showing one record is named for its kind, not the record. The site's address is written without any user name, password or secret-looking query value. |
| `screens/` | A photo of each screen. What was on screen is in the photo: use a test account if that matters. |
| `.reading.json` | The AI's last answer, kept so an unchanged product isn't read again |
| `.review.json` | The AI's last review, kept for the same reason. It holds that answer only, and is checked again each run |
| `.code-read.json` | With a code read: what passed the checks and the made-up sample rows, kept by screen so code that hasn't changed isn't read again. No source code: it holds labels, file names, line numbers and a hash of each question. |
| `.session.json` | With `--login`: the browser's sign-in session (cookies and storage), readable only by you from the moment it's created on macOS and Linux. Windows has no such file mode, so there it has the folder's own permissions: keep the output folder in your own user folder. Never a password. |
| `.gitignore` | Keeps `.session.json`, `.reading.json`, `.code-read.json` and `.review.json` out of git; the rest is meant to be committed |
| `PRODUCT.new.md` | This run's `PRODUCT.md`, when the one there has been edited by hand: yours is never overwritten |
| `.contextmachines.json` | The list of files it wrote: the only ones a later run will ever remove from the folder, and a fingerprint of `PRODUCT.md` to notice a hand edit |

Nothing else is kept, and nothing is sent anywhere after the run.

## At the end of a run

At a terminal, the end of a run can wait for a key. Everything is written by then. None of the keys makes Context Machines send anything:

- `a` lists the rest of the items here, in the terminal.
- Where offered, `o` opens `report.html` in your browser, from your disk, and `c` copies `FIX.md` to your clipboard with your system's own tool (`pbcopy`, `clip`, `wl-copy` or `xclip`).
- Where offered, `f` starts your own coding agent (`claude` or `codex`) in this terminal, with one short prompt that names `FIX.md`. It's offered only when the run itself used that agent as its AI and its command is on your `PATH`, never on Windows. It is your agent, running in your project with your own settings and sign-in, and it reads your code and sends what it reads to its own provider, as it always does. That's up to the agent and its settings, not Context Machines.

The keys are never offered under `--json`, in a pipe, in CI, in the background, or to a coding agent running Context Machines. `--no-prompt` turns them off.

## Signing in

`--login` opens a browser window and you sign in yourself. Only the resulting session is saved. `contextmachines` never sees or asks for a password. Apart from that it signs in to nothing and creates no account: the stand-in user is made up and goes no further than the browser.
