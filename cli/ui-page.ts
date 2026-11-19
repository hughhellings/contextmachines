/**
 * The web view's one page: HTML, CSS and JS in one string, loading nothing from the web. Light and
 * dark follow the system. Laid out as TesterArmy's side by side: the steps on the left (each opening
 * to its sub-actions, a spinner turning into a tick or a cross, a timer and Stop test at the bottom),
 * the live browser in a window frame on the right, which becomes the video when the test ends.
 *
 * Every word from a site or an AI is put in the page as text (textContent), never as HTML: the only
 * markup set from a string is this file's own icons. The script runs under a nonce, and the server's
 * Content-Security-Policy allows nothing else.
 */

export function uiPage(o: { token: string; nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Context Machines tester</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <span class="brand"><span class="logo" aria-hidden="true"></span>Context Machines</span>
  <span class="sep" aria-hidden="true"></span>
  <span id="title" class="title">Test a website</span>
  <span id="chip" class="chip" hidden><span class="ico" data-icon="monitor"></span>Web</span>
  <span class="grow"></span>
  <span id="conn" class="conn" hidden>Reconnecting…</span>
  <button id="close" class="iconbtn" type="button" title="Back to the start" aria-label="Back to the start" hidden><span class="ico" data-icon="x"></span></button>
</header>

<main id="start" class="start">
  <section class="hero">
    <h1>Test a website</h1>
    <p class="lede">Put in an address. It takes a quick look at the site, suggests what a visitor would do there, and runs the tasks you pick in a real browser you can watch.</p>
    <form id="form" class="form" autocomplete="off">
      <label class="field"><span>Website</span><input id="url" type="text" inputmode="url" placeholder="https://en.wikipedia.org" spellcheck="false" required></label>
      <label class="field"><span>Goal <em>(optional)</em></span><input id="goal" type="text" placeholder="search for Alan Turing and open his article" spellcheck="false"></label>
      <div class="asrow">
        <label class="field asfield"><span>Account</span><select id="as"><option value="">Signed out</option></select></label>
        <button id="acctbtn" class="btn small" type="button"><span class="ico" data-icon="lock"></span>Test accounts</button>
        <label id="signupline" class="tick" hidden><input id="signup" type="checkbox"> This run may create accounts</label>
      </div>
      <div class="buttons">
        <button id="suggest" class="btn primary" type="submit"><span id="suggestico" class="ico" data-icon="sparkle"></span>Suggest tasks</button>
        <button id="rungoal" class="btn" type="button" disabled><span class="ico" data-icon="play"></span>Run this goal</button>
      </div>
    </form>
    <div id="phase" class="phase" hidden><span class="spin"></span><span id="phasewords"></span><button id="stopsuggest" class="link" type="button">Stop</button></div>
    <p id="lastrun" class="lastrun" hidden><button id="showlast" class="link" type="button">See the last run</button> <span id="lastwords" class="muted small"></span></p>
    <div id="error" class="error" role="alert" hidden></div>
  </section>

  <section id="acctbox" class="box acctbox" hidden>
    <div class="boxhead"><h2>Test accounts</h2><span id="accthost" class="muted"></span><span class="grow"></span><button id="acctclose" class="link" type="button">Close</button></div>
    <div class="acctbody">
      <div id="notok" hidden>
        <p class="said">Before an account signs in on <span class="okhost"></span>, confirm:</p>
        <p class="said"><b>I'm signing in with my own account on <span class="okhost"></span>. The tester still won't post, pay, send or delete there.</b></p>
        <button id="signinok" class="btn small" type="button">Yes, it's my own account</button>
        <p class="muted small">Use an account you're allowed to automate: some sites' terms forbid it.</p>
        <p class="muted small" id="minequestion">Is this site yours? Mark it as yours to also allow sign-ups and site access.</p>
        <button id="markmine" class="btn small" type="button">Yes, this site is mine</button>
      </div>
      <div id="mine" hidden>
        <ul id="acctlist" class="acctlist"></ul>
        <form id="acctform" class="acctform" autocomplete="off">
          <h3 id="acctformtitle">Add an account</h3>
          <label class="field"><span>Label</span><input id="a-label" type="text" placeholder="admin" spellcheck="false" maxlength="32"></label>
          <label class="field"><span>First sign-in step</span><select id="a-first"><option value="password">Password</option><option value="email-code">Email code</option><option value="magic-link">Magic link</option><option value="sms-code">Code by text (set up once by you)</option><option value="by-hand">Signed in by you (Google, GitHub, SSO)</option><option value="sign-up">Sign-up</option></select></label>
          <label class="field"><span>Username or email <em>(a test address is kept in the config; any other is kept as a secret)</em></span><input id="a-username" type="text" spellcheck="false" autocomplete="off"></label>
          <label class="field"><span>Sign-in page <em>(optional)</em></span><input id="a-page" type="text" placeholder="/login" spellcheck="false"></label>
          <label class="field"><span>What shows when signed in</span><input id="a-signedin" type="text" placeholder="Sign out" spellcheck="false"></label>
          <label class="field"><span>When to use <em>(optional; the AI reads this)</em></span><input id="a-when" type="text" maxlength="500" spellcheck="false"></label>
          <label class="field"><span>Mail catcher for codes and links <em>(optional, on this machine)</em></span><input id="a-catcher" type="text" placeholder="http://127.0.0.1:8025" spellcheck="false"></label>
          <div class="buttons"><button id="a-save" class="btn small primary" type="submit">Save account</button></div>
          <div class="secrets">
            <label class="field"><span>Password <em id="a-pwset"></em></span><span class="pair"><input id="a-password" type="password" autocomplete="off" spellcheck="false"><button id="a-pwbtn" class="btn small" type="button">Set</button></span></label>
            <label class="field"><span>Authenticator secret <em id="a-totpset"></em></span><span class="pair"><input id="a-totp" type="password" autocomplete="off" spellcheck="false" placeholder="base32 key or otpauth:// link"><button id="a-totpbtn" class="btn small" type="button">Set</button></span></label>
            <p class="muted small">Secrets go to the Keychain (or an owner-only file) and are never shown again, sent to the AI, or written to the config.</p>
          </div>
        </form>
        <p id="siteaccess" class="muted small"></p>
        <p class="muted small">A marker header only labels test traffic. Never use it to let traffic past a firewall: anyone can send it.</p>
        <details id="createdbox" class="created"><summary>Created accounts (<span id="createdn">0</span>)</summary><ul id="createdlist" class="acctlist"></ul></details>
      </div>
    </div>
  </section>

  <section id="wallbox" class="box wallbox" role="status" hidden>
    <div class="boxhead"><span class="ico warnico" data-icon="warn"></span><h2 id="walltitle">Blocked by the site's bot check</h2><span class="badge blocked">BLOCKED</span><span id="wallmeta" class="muted"></span></div>
    <div class="wallbody">
      <p id="wallwords" class="said"></p>
      <img id="wallshot" class="wallshot" alt="The site's bot check, as the test browser saw it" hidden>
      <p class="muted small">Nothing was suggested or run. The tester never tries to get past a bot check or CAPTCHA.</p>
    </div>
  </section>

  <section id="tasksbox" class="box" hidden>
    <div class="boxhead"><h2>Suggested tasks</h2><span id="newlist" class="pill new" hidden>New list</span><span id="taskmeta" class="muted"></span><span class="grow"></span><button id="tickall" class="link" type="button">Tick all</button></div>
    <ul id="tasks" class="tasklist"></ul>
    <div class="boxfoot">
      <button id="runpicked" class="btn primary" type="button"><span class="ico" data-icon="play"></span><span id="runpickedwords">Run selected</span></button>
      <button id="explore" class="btn" type="button"><span class="ico" data-icon="globe"></span>Explore whole site</button>
      <span class="muted small">Each task runs signed out, as a visitor, unless you pick an account. A task that passes is saved as a test.</span>
    </div>
  </section>

  <section id="savedbox" class="box" hidden>
    <div class="boxhead"><h2>Saved tests</h2><span id="savedmeta" class="muted"></span><span class="grow"></span><button id="runall" class="btn small" type="button"><span class="ico" data-icon="play"></span><span id="runallwords">Run all</span></button></div>
    <ul id="saved" class="savedlist"></ul>
  </section>

  <p id="foot" class="footnote"></p>
</main>

<main id="run" class="run" hidden>
  <aside class="left">
    <div id="jobtasks" class="jobtasks" hidden></div>
    <div id="scroll" class="scroll">
      <div id="testhead" class="testhead"></div>
      <ol id="steps" class="steps"></ol>
      <div id="card"></div>
    </div>
    <div id="jobcard" class="jobcard" hidden></div>
    <div class="bar">
      <span class="ico" data-icon="flask"></span>
      <span id="barwords" class="barwords"></span>
      <span class="grow"></span>
      <button id="stop" class="btn small" type="button"><span class="sq" aria-hidden="true"></span>Stop test</button>
      <button id="again" class="btn small" type="button" hidden>New test</button>
    </div>
  </aside>
  <section class="right">
    <div class="window">
      <div class="chrome">
        <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span id="addr" class="addr"><span class="ico" data-icon="lock"></span><span id="addrwords"></span></span>
      </div>
      <div class="screen">
        <img id="live" alt="The browser, live" hidden>
        <video id="video" controls playsinline preload="auto" hidden></video>
        <div id="waiting" class="waiting"><span class="orb"></span><b id="waitwords">Suiting up…</b><span id="waitsub" class="muted">Your run is taking off in a moment.</span></div>
      </div>
    </div>
  </section>
</main>

<script nonce="${o.nonce}">
const TOKEN = ${JSON.stringify(o.token)};
${JS}
</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #ffffff; --fg: #18181b; --muted: #71717a; --faint: #a1a1aa; --line: #e4e4e7; --soft: #f4f4f5; --stage: #f4f4f5;
  --card: #ffffff; --hover: #f4f4f5; --sel: #f4f4f5; --pass: #16a34a; --passbg: #dcfce7; --fail: #dc2626; --failbg: #fee2e2;
  --warn: #b45309; --warnbg: #fef3c7; --primary: #18181b; --primaryfg: #ffffff; --shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.06);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0c0e; --fg: #f4f4f5; --muted: #a1a1aa; --faint: #71717a; --line: #27272a; --soft: #18181b; --stage: #141417;
    --card: #111113; --hover: #1c1c1f; --sel: #1f1f23; --pass: #4ade80; --passbg: #14532d; --fail: #f87171; --failbg: #450a0a;
    --warn: #fbbf24; --warnbg: #422006; --primary: #f4f4f5; --primaryfg: #18181b; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
.grow { flex: 1; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.ico { display: inline-flex; width: 16px; height: 16px; flex: none; }
.ico svg { width: 100%; height: 100%; }

.top { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--bg); position: sticky; top: 0; z-index: 5; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; white-space: nowrap; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #18181b 0 50%, #71717a 50%); }
@media (prefers-color-scheme: dark) { .logo { background: linear-gradient(135deg, #f4f4f5 0 50%, #71717a 50%); } }
.sep { width: 1px; height: 18px; background: var(--line); }
.title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; white-space: nowrap; }
.chip .ico { width: 12px; height: 12px; }
.conn { font-size: 12px; color: var(--warn); }
.iconbtn { border: 0; background: none; padding: 6px; border-radius: 6px; cursor: pointer; color: var(--muted); display: inline-flex; }
.iconbtn:hover { background: var(--hover); color: var(--fg); }

.btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-weight: 500; white-space: nowrap; box-shadow: 0 1px 1px rgba(0,0,0,.03); }
.btn:hover { background: var(--hover); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.btn.primary:hover { opacity: .9; }
.btn.primary:disabled { background: var(--soft); color: var(--faint); border-color: var(--line); opacity: 1; box-shadow: none; }
.btn .spin { width: 12px; height: 12px; border-width: 1.5px; }
.btn.small { padding: 4px 10px; font-size: 13px; }
.btn .ico { width: 14px; height: 14px; }
.link { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; font-size: 13px; }
.link:hover { color: var(--fg); }
.sq { width: 9px; height: 9px; background: currentColor; border-radius: 1px; display: inline-block; }

/* Start */
.start { max-width: 760px; margin: 0 auto; padding: 48px 16px 64px; }
.hero h1 { font-size: 28px; letter-spacing: -0.02em; margin: 0 0 6px; }
.lede { color: var(--muted); margin: 0 0 22px; max-width: 60ch; }
.form { display: grid; gap: 12px; }
.asrow { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
.asfield { min-width: 180px; }
.field select { font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
.tick { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; padding-bottom: 8px; }
.acctbody { padding: 12px 16px; display: grid; gap: 10px; }
.acctlist { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.acctlist li { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.acctform { display: grid; gap: 8px; }
.acctform h3 { font-size: 14px; margin: 6px 0 0; }
.pair { display: flex; gap: 6px; }
.secrets { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
.sessionchip { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
.field { display: grid; gap: 4px; font-size: 13px; font-weight: 500; }
.field em { font-style: normal; color: var(--faint); font-weight: 400; }
.field input { font: inherit; font-size: 15px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); width: 100%; }
.field input:focus { outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.phase { display: flex; align-items: center; gap: 10px; margin-top: 18px; color: var(--muted); }
.error { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: var(--failbg); color: var(--fail); overflow-wrap: anywhere; }
.box { margin-top: 28px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); overflow: clip; }
.boxhead { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.boxhead h2 { font-size: 15px; margin: 0; }
.wallbox { border-left: 3px solid var(--warn); }
.wallbox .warnico { color: var(--warn); }
.wallbody { padding: 12px 16px; }
.wallshot { display: block; width: 100%; max-width: 640px; border: 1px solid var(--line); border-radius: 8px; margin: 4px 0 8px; }
.boxfoot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); flex-wrap: wrap; position: sticky; bottom: 0; background: var(--card); z-index: 2; isolation: isolate; border-radius: 0 0 12px 12px; }
.pill.new { color: var(--pass); border-color: color-mix(in srgb, var(--pass) 40%, transparent); }
.lastrun { margin: 14px 0 0; }
.tasklist, .savedlist { list-style: none; margin: 0; padding: 4px 0; }
.tasklist li label { display: flex; gap: 12px; align-items: flex-start; padding: 9px 16px; cursor: pointer; }
.tasklist li label:hover, .savedlist li:hover { background: var(--hover); }
.tasklist input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--primary); flex: none; }
.tasklist .n { color: var(--faint); font-variant-numeric: tabular-nums; width: 1.4em; text-align: right; flex: none; }
.tasklist .goal { flex: 1; overflow-wrap: anywhere; }
.area { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; flex: none; }
.savedlist li { display: flex; gap: 10px; align-items: center; padding: 8px 16px; }
.savedlist .run1 { opacity: 0; transition: opacity .1s; }
.savedlist li:hover .run1, .savedlist .run1:focus-visible { opacity: 1; }
@media (hover: none) { .savedlist .run1 { opacity: 1; } }
.savedlist .goal { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.savedlist .host { color: var(--muted); font-size: 12px; white-space: nowrap; }
.footnote { color: var(--faint); font-size: 12px; margin-top: 28px; }

/* Run: side by side */
.run { display: grid; grid-template-columns: minmax(320px, 400px) 1fr; height: calc(100vh - 48px); }
.left { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; background: var(--bg); }
.right { background: var(--stage); display: flex; align-items: center; justify-content: center; padding: 28px; min-width: 0; min-height: 0; }
.jobtasks { border-bottom: 1px solid var(--line); padding: 8px; max-height: 30vh; overflow: auto; flex: none; }
.jobtasks.more { -webkit-mask-image: linear-gradient(#000 calc(100% - 28px), transparent); mask-image: linear-gradient(#000 calc(100% - 28px), transparent); }
.jobtasks .badge { min-width: 76px; display: inline-flex; justify-content: center; align-items: center; gap: 4px; flex: none; }
.badge .spin { width: 9px; height: 9px; border-width: 1.5px; }
.jobcard { flex: none; max-height: 38vh; overflow: auto; padding: 8px 12px 0; border-top: 1px solid var(--line); }
.jobcard .result { margin: 0 0 8px; }
.jobtasks .jhead { display: flex; align-items: center; gap: 8px; padding: 4px 8px 6px; font-size: 12px; color: var(--muted); }
.jobtasks button.jt { display: flex; width: 100%; gap: 8px; align-items: center; text-align: left; border: 0; background: none; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.jobtasks button.jt:hover { background: var(--hover); }
.jobtasks button.jt.sel { background: var(--sel); }
.jobtasks .jg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.testhead { padding: 12px 16px 2px; display: flex; gap: 8px; align-items: center; flex: none; flex-wrap: wrap; }
.testhead b { font-size: 14px; overflow-wrap: anywhere; }
.scroll { flex: 1; min-height: 0; overflow: auto; }
.steps { list-style: none; margin: 0; padding: 4px 8px 12px; }
.step { border-radius: 8px; }
.srow { display: flex; align-items: flex-start; gap: 8px; padding: 8px 8px; cursor: pointer; border-radius: 8px; }
.srow:hover { background: var(--hover); }
.snum { color: var(--faint); font-size: 12px; width: 1.3em; text-align: right; padding-top: 1px; font-variant-numeric: tabular-nums; flex: none; }
.sico { color: var(--muted); padding-top: 1px; }
.stitle { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.step.running .stitle, .step.open .stitle { font-weight: 600; }
.step.pending .stitle, .step.skipped .stitle { color: var(--muted); }
.chev { color: var(--faint); transition: transform .15s; padding-top: 1px; }
.step.open .chev { transform: rotate(180deg); }
.status { width: 16px; height: 16px; flex: none; margin-top: 1px; display: inline-flex; }
.subs { list-style: none; margin: 0 0 6px; padding: 0 8px 0 34px; }
.sub { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; color: var(--muted); font-size: 13px; }
.sub .sl { flex: 1; min-width: 0; overflow: hidden; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.sub .status, .sub .goto, .sub .sico, .sub .pill { margin-top: 1px; }
.sub.playing { color: var(--fg); }
.step.playing > .srow { background: var(--sel); box-shadow: inset 2px 0 0 var(--fg); }
.sub.s-err .sl { color: var(--fail); }
.sub.s-blocked .sl { color: var(--warn); }
.sub .why { display: block; font-size: 12px; color: var(--fail); white-space: normal; }
.pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
.pill .spin { width: 10px; height: 10px; border-width: 1.5px; }
.goto { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 1px 7px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; }
.goto:hover { background: var(--hover); }
.goto .ico { width: 10px; height: 10px; }
.goto.tiny { font-weight: 500; color: var(--muted); padding: 0 6px; opacity: 0; transition: opacity .1s; }
.goto.tiny .ico { width: 8px; height: 8px; }
.sub:hover .goto.tiny, .goto.tiny:focus-visible, .sub.playing .goto.tiny { opacity: 1; }
@media (hover: none) { .goto.tiny { opacity: 1; } }
.reason { margin: 0 8px 8px 34px; font-size: 12px; color: var(--fail); overflow-wrap: anywhere; }
.reason.warn { color: var(--warn); }
.reason.note { color: var(--muted); }
.ok { color: var(--pass); } .bad { color: var(--fail); } .meh { color: var(--warn); } .off { color: var(--faint); }
.spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--fg) 18%, transparent); border-top-color: var(--fg); animation: spin .8s linear infinite; display: inline-block; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }

#card { padding: 0 12px 4px; }
.result { border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 4px 0 12px; background: var(--card); box-shadow: var(--shadow); }
.rhead { display: flex; gap: 8px; align-items: center; }
.rhead b { flex: 1; overflow-wrap: anywhere; font-size: 14px; }
.rhead .chip { color: var(--muted); }
.badge { font-size: 11px; font-weight: 700; letter-spacing: .02em; border-radius: 6px; padding: 1px 7px; white-space: nowrap; }
.badge.pass { background: var(--passbg); color: var(--pass); }
.badge.fail { background: var(--failbg); color: var(--fail); }
.badge.blocked, .badge.not_sure, .badge.not_run, .badge.couldnt { background: var(--warnbg); color: var(--warn); }
.badge.running, .badge.queued { background: var(--soft); color: var(--muted); }
.badge.judged { background: var(--warnbg); color: var(--warn); margin-left: 6px; }
.rsub { color: var(--muted); font-size: 12px; margin: 2px 0 10px 24px; }
.said { background: var(--soft); border-radius: 8px; padding: 8px 10px; margin: 0 0 8px; overflow-wrap: anywhere; }
details.more { border-top: 1px solid var(--line); padding: 6px 0 0; margin-top: 6px; }
details.more summary { cursor: pointer; color: var(--fg); font-weight: 500; list-style: none; display: flex; align-items: center; gap: 6px; padding: 4px 0; }
details.more summary::-webkit-details-marker { display: none; }
details.more summary .chev { margin-left: auto; }
details.more[open] summary .chev { transform: rotate(180deg); }
.shots { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; padding: 6px 0; }
.shots button { border: 1px solid var(--line); border-radius: 6px; padding: 0; overflow: hidden; background: none; cursor: pointer; position: relative; }
.shots img { width: 100%; display: block; aspect-ratio: 16 / 10; object-fit: cover; }
.shots span { position: absolute; left: 4px; bottom: 4px; font-size: 10px; background: rgba(0,0,0,.6); color: #fff; border-radius: 4px; padding: 0 4px; }
.stuck { margin: 4px 0; padding-left: 18px; }
.stuck li { margin: 3px 0; overflow-wrap: anywhere; }
.stuck .where { color: var(--muted); font-size: 12px; margin-left: 6px; white-space: nowrap; }
.a11y-kind { margin: 8px 0 0; font-weight: 600; font-size: 13px; }
.a11y-body > p.where { color: var(--muted); font-size: 12px; margin: 4px 0; }
.links { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
.links a { color: var(--fg); }
.links code { font-size: 11px; overflow-wrap: anywhere; }
.bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); color: var(--muted); flex: none; background: var(--bg); }
.bar .grow { min-width: 0; }
.sub.s-stopped .sl { color: var(--faint); }
.barwords { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

.window { width: 100%; max-width: 1100px; border-radius: 10px; overflow: hidden; background: var(--card); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 18px 48px rgba(0,0,0,.14); border: 1px solid var(--line); }
.chrome { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: var(--soft); border-bottom: 1px solid var(--line); }
.dots { display: inline-flex; gap: 6px; }
.dots i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
.dots i:nth-child(1) { background: #ff5f57; } .dots i:nth-child(2) { background: #febc2e; } .dots i:nth-child(3) { background: #28c840; }
.addr { flex: 1; min-width: 0; max-width: 560px; margin: 0 auto; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 6px; background: var(--bg); color: var(--muted); font-size: 12px; border: 1px solid var(--line); }
.addr .ico { width: 11px; height: 11px; }
#addrwords { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.screen { position: relative; aspect-ratio: 1280 / 800; background: var(--bg); }
.screen img, .screen video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
.screen img { background: var(--bg); }
/* E9: a run at a phone's width is shown in a phone-shaped frame, as tall as it is. */
.window.phone { max-width: 400px; margin: 0 auto; border-radius: 24px; }
.window.phone .screen { aspect-ratio: 390 / 844; }
.waiting { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; padding: 16px; }
.orb { width: 72px; height: 72px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #a1a1aa, #3f3f46 70%); margin-bottom: 8px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { transform: scale(.94); opacity: .8; } }

@media (max-width: 860px) {
  .run { grid-template-columns: minmax(0, 1fr); height: auto; }
  .left { border-right: 0; border-bottom: 1px solid var(--line); min-width: 0; }
  .steps { max-height: none; }
  .right { padding: 12px; }
  .brand { display: none; } .sep { display: none; }
}
`;

const JS = String.raw`
"use strict";
const ICONS = {
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>',
  flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  wand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20L15 9M14 4v3M19 9h-3M17.5 5.5l-2 2M10 4.5l.5 1.5M19.5 13l-1.5-.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  pointer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6z"/></svg>',
  type: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  arrows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M9 12h6"/></svg>',
  heal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  okc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.5L16 9.5"/></svg>',
  badc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  mehc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>',
  offc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5" stroke-dasharray="2.5 2.5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/></svg>',
};
const $ = (id) => document.getElementById(id);
/** An element, its text only ever set as text. */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
function icon(name, cls) {
  const s = el("span", "ico" + (cls ? " " + cls : ""));
  s.innerHTML = ICONS[name] || ""; // our own markup only, never a site's words
  return s;
}
for (const n of document.querySelectorAll("[data-icon]")) n.innerHTML = ICONS[n.getAttribute("data-icon")] || "";

const clock = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };
const VERDICT = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", not_sure: "NOT SURE", not_run: "NOT RUN", couldnt: "COULDN'T RUN", running: "RUNNING", queued: "QUEUED" };

const S = { accts: null, acctOpen: false, wall: null, ai: null, busy: null, phase: "", url: "", tasks: [], list: null, newList: false, ticked: new Set(), looked: null, saved: [], error: "", view: "start", job: null, tests: new Map(), order: [], sel: null, follow: true, frames: new Map(), jobEnd: null, safety: "", loaded: false };

async function post(path, body) {
  S.error = "";
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-cm-token": TOKEN }, body: JSON.stringify(body || {}) });
    const said = await r.json().catch(() => ({}));
    if (!r.ok) S.error = said.error || "That didn't work (" + r.status + ").";
  } catch (e) {
    S.error = "The tester isn't answering: is it still running in the terminal?";
  }
  render();
}

// ----- events from the server -----------------------------------------------------------------

function test(id) { return S.tests.get(id); }
function finishWorking(st, ok) {
  for (const s of st.subs) if (s.state === "running") s.state = ok ? "ok" : "err";
}
/** A test that ended before its steps did (stopped, or couldn't run): nothing in it is left spinning. */
function stopAll(t) {
  for (const s of t.steps) {
    for (const x of s.subs) if (x.state === "running") x.state = "stopped";
    if (s.state === "running" || s.state === "pending") s.state = s.state === "running" ? "not_sure" : "skipped";
  }
}
function apply(m) {
  switch (m.type) {
    case "hello": S.ai = m.ai; S.saved = m.saved || []; S.safety = m.safety || ""; if (m.url && !$("url").value) $("url").value = m.url; break;
    case "busy":
      S.busy = m.busy; if (!m.busy) S.phase = "";
      // The job is over: whatever was still running in it was stopped.
      if (!m.busy) for (const t of S.tests.values()) if (t.status === "running" || t.status === "queued") { t.status = "not_run"; t.why = t.why || "stopped"; t.ended = Date.now(); stopAll(t); }
      break;
    case "phase": S.phase = m.words; break;
    case "error": S.error = m.words; break;
    case "saved": S.saved = m.saved || []; break;
    case "botwall": S.wall = m; S.error = ""; break;
    case "tasks":
      // A new Suggest (or a list) replaces a bot check's card.
      S.wall = null;
      // A new Suggest clears the list at once (no list, no ticks); the new list comes ticked afresh, said as new.
      if (m.url) S.url = m.url;
      S.newList = Boolean(S.loaded && m.list && S.list && m.list !== S.list) || Boolean(S.loaded && m.list && S.hadList);
      S.hadList = S.hadList || Boolean(m.list);
      S.tasks = m.tasks || []; S.list = m.list || null; S.looked = m.looked || null; if (m.list) S.error = "";
      S.ticked = new Set(S.tasks.slice(0, 2).map((_, i) => i));
      break;
    case "replayed":
      // Opened (or reloaded) with nothing running: the start, with the last run a click away.
      if (!S.loaded && !m.busy && S.view === "run") S.view = "start";
      S.loaded = true;
      break;
    case "noscreen": { const t = test(m.id); if (t) t.noScreen = m.words; S.frames.delete(m.id); break; }
    case "session": { const t = test(m.id); if (t) t.session = m.words; break; }
    case "signin": { const t = test(m.id); if (t) { t.signingIn = m.state === "start"; t.signingWords = m.words || ""; if (t.signingIn) S.frames.delete(m.id); } break; }
    case "job":
      S.job = { id: m.id, explore: m.explore, began: Date.now() };
      S.jobEnd = null; S.tests = new Map(); S.order = []; S.frames = new Map(); S.follow = true;
      for (const t of m.tests) { S.tests.set(t.id, { id: t.id, goal: t.goal, url: t.url, area: t.area, status: "queued", steps: [], phase: "", replay: t.replay }); S.order.push(t.id); }
      S.sel = S.order[0] || null; S.view = "run";
      break;
    case "test": {
      const t = test(m.id); if (!t) break;
      t.status = "running"; t.began = Date.now(); t.phase = "Opening the site"; t.noScreen = m.noScreen || "";
      if (m.safety) S.safety = m.safety;
      if (S.follow) S.sel = t.id;
      break;
    }
    case "ev": {
      const t = test(m.id); if (!t) break;
      const e = m.e;
      if (e.type === "phase") t.phase = e.words;
      else if (e.type === "planned") { t.steps = e.steps.map((s, i) => ({ n: i + 1, title: s.title, intent: s.intent, check: s.check, state: "pending", subs: [], open: false })); t.phase = ""; }
      else {
        const st = t.steps[(e.n || (e.step && e.step.n) || 0) - 1];
        if (!st) break;
        if (e.type === "step") { for (const o of t.steps) o.open = false; st.state = "running"; st.open = true; st.began = Date.now(); }
        else if (e.type === "working") { finishWorking(st, true); st.subs.push({ label: e.words, state: "running", at: e.at }); }
        else if (e.type === "action") { finishWorking(st, true); const a = e.action; st.subs.push({ label: a.label, error: a.error, state: a.blocked ? "blocked" : a.error ? "err" : "ok", at: a.at, act: true }); }
        else if (e.type === "healing") { finishWorking(st, true); st.subs.push({ label: e.unfinished ? "The saved actions stopped short: " + e.missing + (e.ai ? ": asking the AI to finish it" : "") : "Can't find " + e.missing + (e.ai ? ": asking the AI for this step" : ""), state: "ok", heal: true }); }
        else if (e.type === "stepEnd") {
          const r = e.step; finishWorking(st, r.verdict === "passed");
          st.state = r.verdict; st.reason = r.reason; st.evidence = r.evidence; st.weak = r.weak; st.at = r.at; st.ms = r.ms; st.healed = r.healed; st.judged = r.judged; st.fill = r.fill;
          st.open = r.verdict !== "passed" && r.verdict !== "skipped";
          const f = S.frames.get(t.id); if (f) st.url = f.url;
        }
      }
      break;
    }
    case "frame": { if (test(m.id)) S.frames.set(m.id, { jpeg: m.jpeg, url: m.url }); break; }
    case "result": {
      const t = test(m.id); if (!t) break;
      t.status = "done"; t.result = m.result; t.video = m.video; t.signInVideo = m.signInVideo; t.report = m.report; t.shots = m.shots || {}; t.folder = m.folder; t.savedTo = m.saved; t.tokens = m.tokens; t.a11y = m.a11y; t.urls = m.urls || []; t.ended = Date.now();
      // The steps as the result has them, each sub-action with its time in the video so every Go to is
      // exact; what it did between actions (snapshots, asking the AI, checks) stays as it was shown.
      t.steps = m.result.steps.map((r) => {
        const was = t.steps[r.n - 1];
        const acts = r.actions.map((a) => ({ label: a.label, error: a.error, state: a.blocked ? "blocked" : a.error ? "err" : "ok", at: a.at, act: true }));
        let subs = acts;
        if (was && was.subs.filter((x) => x.act).length === acts.length) { let k = 0; subs = was.subs.map((x) => (x.act ? acts[k++] : { ...x, state: x.state === "running" ? "ok" : x.state })); }
        return { n: r.n, title: r.title, intent: r.intent, check: r.check, state: r.verdict, reason: r.reason, evidence: r.evidence, weak: r.weak, at: r.at, ms: r.ms, healed: r.healed, judged: r.judged, fill: r.fill, url: (m.stepUrls && m.stepUrls[r.n]) || (was && was.url), open: was ? was.open : r.verdict !== "passed" && r.verdict !== "skipped", subs };
      });
      break;
    }
    case "couldnt": { const t = test(m.id); if (t) { t.status = "couldnt"; t.why = m.words; t.ended = Date.now(); stopAll(t); } break; }
    case "notrun": { const t = test(m.id); if (t) { t.status = "not_run"; t.why = m.words; t.ended = Date.now(); stopAll(t); } break; }
    case "jobEnd": S.jobEnd = m; if (S.job) S.job.ended = Date.now(); break;
  }
}

let es;
function connect() {
  es = new EventSource("/events?t=" + encodeURIComponent(TOKEN));
  let first = true;
  es.onopen = () => { $("conn").hidden = true; if (!first) { /* a reconnect replays everything */ } first = false; };
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "hello" && S.view !== "start" && S.tests.size) { /* a replay after a reconnect: start over */ resetForReplay(); }
    apply(m);
    if (m.type === "frame") paintFrame(); else render();
  };
  es.onerror = () => { $("conn").hidden = false; };
}
function resetForReplay() { S.wall = null; S.tests = new Map(); S.order = []; S.job = null; S.jobEnd = null; S.frames = new Map(); S.list = null; S.tasks = []; }

// ----- the start page -------------------------------------------------------------------------

$("goal").addEventListener("input", () => render());
$("form").addEventListener("submit", (e) => { e.preventDefault(); if ($("goal").value.trim()) return runGoal(); post("/api/suggest", { url: $("url").value }); });
function picked() { const as = $("as").value; return as ? { as, ...(signUpPicked() && $("signup").checked ? { signUp: true } : {}) } : {}; }
function signUpPicked() { const a = S.accts && S.accts.accounts && S.accts.accounts.find((x) => x.label === $("as").value); return Boolean(a && a.first === "sign-up"); }
function runGoal() { post("/api/run", { url: $("url").value, goal: $("goal").value, ...picked() }); }
$("rungoal").addEventListener("click", runGoal);
$("stopsuggest").addEventListener("click", () => post("/api/stop"));
$("tickall").addEventListener("click", () => { S.ticked = S.ticked.size === S.tasks.length ? new Set() : new Set(S.tasks.map((_, i) => i)); render(); });
// The ticks are sent with the list they were made on: a list replaced since is refused by the server.
$("runpicked").addEventListener("click", () => post("/api/run", { url: S.url || $("url").value, list: S.list, picked: [...S.ticked].sort((a, b) => a - b), ...picked() }));

// ----- the Test accounts panel (C20a): values go in, and only "set" ever comes back ------------

async function loadAccounts() {
  const site = $("url").value.trim();
  if (!site) { S.accts = null; return render(); }
  try {
    const r = await fetch("/api/accounts?site=" + encodeURIComponent(site), { headers: { "x-cm-token": TOKEN } });
    S.accts = await r.json();
  } catch { S.accts = { ok: false, error: "The tester isn't answering." }; }
  render();
}
async function change(what, body) {
  await post("/api/accounts/" + what, { url: $("url").value, ...body });
  await loadAccounts();
}
$("acctbtn").addEventListener("click", () => { S.acctOpen = !S.acctOpen; if (S.acctOpen) loadAccounts(); else render(); });
$("acctclose").addEventListener("click", () => { S.acctOpen = false; render(); });
$("url").addEventListener("change", () => { if (S.acctOpen || S.accts) loadAccounts(); });
$("as").addEventListener("change", () => render());
$("markmine").addEventListener("click", () => change("mine", { yes: true }));
$("signinok").addEventListener("click", () => change("signin-ok", { yes: true }));
$("acctform").addEventListener("submit", (e) => {
  e.preventDefault();
  change("save", { label: $("a-label").value.trim(), first: $("a-first").value, username: $("a-username").value.trim(), signInPage: $("a-page").value.trim(), signedIn: $("a-signedin").value.trim(), whenToUse: $("a-when").value.trim(), catcher: $("a-catcher").value.trim() });
});
function setSecret(field, input) {
  const value = input.value;
  // The field is emptied at once: the value is in no part of the page after it is sent.
  input.value = "";
  if (!value) return;
  change("secret", { label: $("a-label").value.trim(), field, value });
}
$("a-pwbtn").addEventListener("click", () => setSecret("password", $("a-password")));
$("a-totpbtn").addEventListener("click", () => setSecret("totp", $("a-totp")));
function renderAccounts() {
  const a = S.accts;
  // The picker: Signed out, and each account of this site.
  const sel = $("as"); const want = sel.value;
  const labels = a && a.ok && (a.mine || a.signInOk) ? a.accounts.map((x) => x.label) : [];
  if (sel.options.length !== labels.length + 1 || labels.some((l, i) => sel.options[i + 1].value !== l)) {
    sel.replaceChildren(el("option", null, "Signed out"));
    sel.options[0].value = "";
    for (const l of labels) { const o = el("option", null, l); o.value = l; sel.append(o); }
    sel.value = labels.includes(want) ? want : "";
  }
  $("signupline").hidden = !signUpPicked();
  $("acctbox").hidden = !S.acctOpen;
  if (!S.acctOpen) return;
  $("accthost").textContent = a && a.host ? a.host : "put in the site's address first";
  const ok = Boolean(a && a.ok && (a.mine || a.signInOk));
  for (const s of document.querySelectorAll(".okhost")) s.textContent = a && a.host ? a.host : "this site";
  $("notok").hidden = !(a && a.ok && !ok);
  $("mine").hidden = !ok;
  if (!ok) return;
  const ul = $("acctlist"); ul.replaceChildren();
  for (const x of a.accounts) {
    const li = el("li");
    const said = (k, v) => v === undefined ? "" : k + " " + (v ? "set" : "not set");
    li.append(el("b", null, x.label), el("span", "muted small", [x.first, said("username", x.set.username), said("password", x.set.password), said("authenticator", x.set.totp), x.session || "no session"].filter(Boolean).join(" · ")));
    const edit = el("button", "link", "Edit"); edit.type = "button";
    edit.addEventListener("click", () => { $("a-label").value = x.label; $("a-first").value = x.first; $("a-username").value = x.username; $("a-page").value = x.signInPage; $("a-signedin").value = x.signedIn; $("a-when").value = x.whenToUse; $("acctformtitle").textContent = "Edit " + x.label; render(); });
    const forget = el("button", "link", "Forget session"); forget.type = "button";
    forget.addEventListener("click", () => change("forget", { label: x.label }));
    li.append(el("span", "grow"), edit, forget);
    ul.append(li);
  }
  const cur = a.accounts.find((x) => x.label === $("a-label").value.trim());
  $("a-pwset").textContent = cur && cur.set.password ? "(set · type a new one to change it)" : "";
  $("a-totpset").textContent = cur && cur.set.totp ? "(set)" : "";
  $("siteaccess").textContent = "Site access for " + a.host + ": " + (a.site.length ? a.site.join(", ") : "none set (add it under \"sites\" in contextmachines.config.json)") + ".";
  $("createdn").textContent = String(a.created.length);
  const cl = $("createdlist"); cl.replaceChildren();
  for (const c of a.created) cl.append(el("li", null, c.at.slice(0, 16).replace("T", " ") + " · " + c.environment + " · " + c.address + " · " + (c.passed ? "passed" : "didn't pass") + " · " + c.status));
}
$("explore").addEventListener("click", () => post("/api/run", { url: S.url || $("url").value, list: S.list, explore: true }));
$("runall").addEventListener("click", () => post("/api/run-saved", {}));
$("showlast").addEventListener("click", () => { S.view = "run"; render(); });
$("stop").addEventListener("click", () => { $("stop").disabled = true; post("/api/stop"); });
$("again").addEventListener("click", () => { S.view = "start"; render(); });
$("close").addEventListener("click", () => { if (!S.busy) { S.view = "start"; render(); } });

let suggestIcon = "sparkle";
function renderStart() {
  const busy = Boolean(S.busy);
  // The address the list is for, in its box, unless the person is typing there.
  if (S.url && !$("url").value && document.activeElement !== $("url")) $("url").value = S.url;
  $("suggest").disabled = busy || Boolean($("goal").value.trim());
  $("rungoal").disabled = busy || !$("goal").value.trim();
  const want = S.busy === "suggest" ? "spin" : "sparkle";
  if (want !== suggestIcon) { suggestIcon = want; const i = $("suggestico"); i.replaceChildren(); if (want === "spin") i.append(el("span", "spin")); else i.innerHTML = ICONS.sparkle; }
  $("phase").hidden = !(S.busy === "suggest");
  $("phasewords").textContent = (S.phase || "Working") + "…";
  $("error").hidden = !S.error; $("error").textContent = S.error;
  const last = S.order.length ? test(S.order[0]) : null;
  $("lastrun").hidden = !last || S.busy === "suggest";
  if (last) $("lastwords").textContent = S.jobEnd ? S.jobEnd.summary : S.busy === "run" ? "running now" : "";
  if (last) $("showlast").textContent = S.busy === "run" ? "Back to the run" : "See the last run";
  // A bot check that stayed in front of the site: one clear card with its photo, never a red FAIL.
  $("wallbox").hidden = !S.wall || S.busy === "suggest";
  if (S.wall) {
    $("walltitle").textContent = S.wall.title || "Blocked by the site's bot check";
    $("wallmeta").textContent = (S.wall.host || "") + (S.wall.check ? " · " + S.wall.check : "");
    $("wallwords").textContent = S.wall.words || "";
    const img = $("wallshot"); const src = S.wall.shot ? "data:image/jpeg;base64," + S.wall.shot : "";
    img.hidden = !src; if (src && img.getAttribute("src") !== src) img.src = src;
  }
  // While a new list is asked for, the old one is gone: nothing ticked on it can run.
  $("tasksbox").hidden = !S.tasks.length || S.busy === "suggest";
  $("newlist").hidden = !S.newList;
  if (S.tasks.length) {
    const host = (() => { try { return new URL(S.url).host; } catch { return S.url; } })();
    $("taskmeta").textContent = host + (S.looked ? " · looked at " + S.looked.pages + " page" + (S.looked.pages === 1 ? "" : "s") + " in " + took(S.looked.ms) + (S.looked.consent ? ", answered its consent wall with '" + S.looked.consent + "'" : "") : "") + (S.newList ? " · the first " + Math.min(2, S.tasks.length) + " ticked" : "");
    const ul = $("tasks"); ul.replaceChildren();
    S.tasks.forEach((t, i) => {
      const li = el("li"); const lab = el("label");
      const box = el("input"); box.type = "checkbox"; box.checked = S.ticked.has(i);
      box.disabled = busy;
      box.addEventListener("change", () => { box.checked ? S.ticked.add(i) : S.ticked.delete(i); S.newList = false; render(); });
      lab.append(box, el("span", "n", i + 1), el("span", "goal", t.goal), el("span", "area", t.area));
      li.append(lab); ul.append(li);
    });
    $("tickall").textContent = S.ticked.size === S.tasks.length ? "Untick all" : "Tick all";
    $("runpickedwords").textContent = "Run selected (" + S.ticked.size + ")";
    $("runpicked").disabled = busy || !S.ticked.size;
    $("explore").disabled = busy;
  }
  $("savedbox").hidden = !S.saved.length;
  if (S.saved.length) {
    const sites = new Set(S.saved.map((t) => t.host)).size;
    $("savedmeta").textContent = S.saved.length + " in contextmachines/tests";
    // Every saved test, of every site: said, as the Website box doesn't choose them.
    $("runallwords").textContent = "Run all " + S.saved.length + (sites > 1 ? " (" + sites + " sites)" : "");
    const ul = $("saved"); ul.replaceChildren();
    for (const t of S.saved) {
      const li = el("li");
      const one = el("button", "btn small run1"); one.type = "button"; one.title = "Run this test"; one.disabled = busy;
      one.append(icon("play"), document.createTextNode("Run"));
      one.addEventListener("click", () => post("/api/run-saved", { files: [t.file] }));
      li.append(icon("okc", "off"), el("span", "goal", t.goal), el("span", "host", t.host + (t.draft ? " · draft" : "")), one);
      ul.append(li);
    }
    $("runall").disabled = busy;
  }
  // The safety line is true to what will run: signed in as the account picked, or signed out.
  const asNow = $("as").value;
  const safety = asNow && S.accts && S.accts.host ? "Signed in as " + asNow + " on " + S.accts.host + ". It won't press buy, post, comment, like, subscribe, send or delete buttons, except a sign-in code or link. It can still change this account's data. Use a test account or staging." : S.safety;
  $("foot").textContent = (S.ai ? "AI: " + S.ai + ". " : "No AI found: saved tests can still run. ") + safety + " Runs are written to contextmachines/runs, as the terminal writes them.";
  renderAccounts();
}

// ----- the run: side by side ------------------------------------------------------------------

const STATUS = { passed: ["okc", "ok"], failed: ["badc", "bad"], blocked: ["mehc", "meh"], not_sure: ["mehc", "meh"], skipped: ["offc", "off"], pending: ["offc", "off"], stopped: ["offc", "off"] };
function statusIcon(state) {
  if (state === "running") return el("span", "spin");
  const [n, c] = STATUS[state] || STATUS.pending;
  return icon(n, "status " + c);
}
function subIcon(s) {
  const l = s.label;
  const name = s.state === "blocked" || /^Stopped before/.test(l) ? "stop" : s.heal ? "heal" : /^Capturing/.test(l) ? "search" : /^Asking the AI/.test(l) ? "sparkle" : /^Checking/.test(l) ? "eye" : /^Clicking/.test(l) ? "pointer" : /^(Filling|Typing|Pressing|Choosing|Selecting)/.test(l) ? "type" : /^Scrolling/.test(l) ? "arrows" : /^Going to/.test(l) ? "globe" : /^Waiting/.test(l) ? "clock" : "wand";
  return icon(name, "sico");
}
const stepIcon = (st) => icon(/^(check|verify|confirm|make sure|see|assert)\b/i.test(st.title) || st.check && st.check.kind !== "none" && /^(check|verify)/i.test(st.intent || "") ? "eye" : "wand", "sico");
function goto(at, tiny) {
  const b = el("button", "goto" + (tiny ? " tiny" : ""));
  b.type = "button";
  b.title = "Go to " + clock(at) + " in the video";
  b.append(icon("play"));
  b.append(document.createTextNode((tiny ? "" : "Go to ") + clock(at)));
  b.addEventListener("click", (e) => { e.stopPropagation(); const v = $("video"); try { v.currentTime = at; v.play().catch(() => {}); } catch {} });
  return b;
}

function verdictOf(t) { return t.status === "done" ? t.result.verdict : t.status; }

function renderRun() {
  const t = test(S.sel);
  const running = S.busy === "run";
  $("title").textContent = t ? t.goal : "Test";
  $("title").title = t ? t.goal : "";
  // Several tests: the list, each with its verdict; one picked shows its side by side.
  const jt = $("jobtasks");
  jt.hidden = S.order.length < 2;
  if (S.order.length > 1) {
    jt.replaceChildren();
    const head = el("div", "jhead");
    const allSaved = S.order.every((id) => test(id).replay);
    head.append(el("span", null, (S.job && S.job.explore ? "Exploring the site" : allSaved ? "Saved tests" : "Tasks") + " · " + S.order.length), el("span", "grow"), el("span", null, S.order.filter((id) => test(id).status !== "queued" && test(id).status !== "running").length + " of " + S.order.length + " done"));
    jt.append(head);
    S.order.forEach((id, i) => {
      const x = test(id); const v = verdictOf(x);
      const b = el("button", "jt" + (id === S.sel ? " sel" : "")); b.type = "button";
      // The running one is a badge too, the same width as the others, so the goals line up.
      const badge = el("span", "badge " + v);
      if (v === "running") badge.append(el("span", "spin"), document.createTextNode("RUNNING")); else badge.textContent = VERDICT[v] || v;
      b.append(el("span", "snum", i + 1), badge, el("span", "jg", x.goal));
      b.title = x.goal;
      b.addEventListener("click", () => { S.sel = id; S.follow = x.status === "running"; render(); paintFrame(); });
      jt.append(b);
    });
    // More below than shows: the list fades at its foot.
    requestAnimationFrame(() => jt.classList.toggle("more", jt.scrollHeight - jt.scrollTop - jt.clientHeight > 4));
    if (!jt.dataset.watch) { jt.dataset.watch = "1"; jt.addEventListener("scroll", () => jt.classList.toggle("more", jt.scrollHeight - jt.scrollTop - jt.clientHeight > 4)); }
  }
  const head = $("testhead"); head.replaceChildren();
  if (t) {
    if (t.area) head.append(el("span", "area", t.area));
    if (t.replay) head.append(el("span", "area", "replayed from the saved test"));
    if (t.url) head.append(el("span", "muted small", (() => { try { return new URL(t.url).host; } catch { return t.url; } })()));
    if (t.session) { const chip = el("span", "sessionchip"); chip.append(icon("lock"), document.createTextNode(t.session)); head.append(chip); }
  }
  // The steps, each opening to what was done in it.
  const ol = $("steps"); const scroller = $("scroll"); const keep = scroller.scrollTop; ol.replaceChildren();
  const done = t && t.status === "done";
  const hasVideo = Boolean(done && t.video);
  if (t && !t.steps.length) {
    const li = el("li", "step running"); const row = el("div", "srow");
    row.append(el("span", "snum", ""), t.status === "running" ? el("span", "spin") : icon("mehc", "status meh"), el("span", "stitle", t.status === "running" ? (t.phase || "Opening the site") + "…" : t.why || VERDICT[t.status] || ""));
    li.append(row); ol.append(li);
  }
  if (t) for (const st of t.steps) {
    const li = el("li", "step " + st.state + (st.open ? " open" : ""));
    li.dataset.n = String(st.n);
    const row = el("div", "srow");
    row.append(el("span", "snum", st.n), stepIcon(st), el("span", "stitle", st.title));
    // A step an AI judged, not the browser: labelled on its card, never shown as a measured pass.
    if (st.judged && st.state === "passed") { const b = el("span", "badge judged", "Judged by AI"); b.title = "An AI that saw only the final screen judged this step; the browser didn't measure it"; row.append(b); }
    if (hasVideo && st.state !== "skipped" && st.at !== undefined) row.append(goto(st.at));
    row.append(statusIcon(st.state), icon("chev", "chev"));
    row.addEventListener("click", () => { st.open = !st.open; render(); });
    li.append(row);
    if (st.open) {
      const subs = el("ol", "subs");
      for (const s of st.subs) {
        const sl = el("li", "sub s-" + s.state);
        if (s.at !== undefined) sl.dataset.at = String(s.at);
        const words = el("span", "sl", s.label);
        words.title = s.label + (s.error ? " (didn't work: " + s.error + ")" : "");
        sl.append(subIcon(s), words);
        if (s.state === "running") { const p = el("span", "pill"); p.append(el("span", "spin"), document.createTextNode("Running")); sl.append(p); }
        else {
          // Every sub-action has its moment in the video, a refused one included.
          if (hasVideo && s.at !== undefined) sl.append(goto(s.at, true));
          if (s.state === "stopped") { const p = el("span", "pill", "Stopped"); sl.append(p); }
          else sl.append(statusIcon(s.state === "ok" ? "passed" : s.state === "err" ? "failed" : "blocked"));
        }
        subs.append(sl);
        if (s.error) { const w = el("li", "sub"); w.append(el("span", "why", "didn't work: " + s.error)); subs.append(w); }
      }
      if (!st.subs.length && st.state === "running") { const sl = el("li", "sub s-running"); sl.append(el("span", "sl", "Starting the step")); const p = el("span", "pill"); p.append(el("span", "spin"), document.createTextNode("Running")); sl.append(p); subs.append(sl); }
      li.append(subs);
      if (st.reason && st.state !== "passed") li.append(el("p", "reason" + (st.state === "failed" ? "" : " warn"), st.reason));
      if (st.evidence) li.append(el("p", "reason", "Expected " + st.evidence.expected + "; found " + st.evidence.found));
      if (st.weak && st.state === "passed") li.append(el("p", "reason note", "Note: " + st.weak + "."));
      if (st.fill && st.state !== "skipped") { const F = st.fill; li.append(el("p", "reason note", "Filled " + F.filled + " of " + F.shown + " field" + (F.shown === 1 ? "" : "s") + " shown" + (F.empty.length ? "; left empty: " + F.empty.slice(0, 6).join(", ") + (F.empty.length > 6 ? " and " + (F.empty.length - 6) + " more" : "") + (F.kept ? " (" + F.kept + ")" : "") : "") + ".")); }
      if (st.judged && st.state === "passed") li.append(el("p", "reason warn", "Judged by AI" + (st.judged.by === "second opinion" ? " (a second opinion)" : "") + ", not measured: " + st.judged.reason + (st.judged.overruled ? " Overruled: " + st.judged.overruled + "." : "")));
      if (st.healed) li.append(el("p", "reason note", "Healed: " + st.healed.from.join(" → ") + " no longer worked; now " + (st.healed.to.join(" → ") || "nothing more") + "."));
    }
    ol.append(li);
  }
  scroller.scrollTop = keep;
  if (t && t.status === "running") { const cur = ol.querySelector(".step.running"); if (cur && S.follow) cur.scrollIntoView({ block: "nearest" }); }

  // The card: PASS or FAIL, screenshots, where people get stuck.
  const card = $("card"); card.replaceChildren();
  if (t && done) card.append(resultCard(t));
  else if (t && (t.status === "couldnt" || t.status === "not_run")) {
    const c = el("div", "result"); const h = el("div", "rhead");
    h.append(icon("mehc", "status meh"), el("b", null, t.status === "not_run" ? "Not run" : "Couldn't run"), el("span", "badge " + t.status, VERDICT[t.status]));
    c.append(h, el("p", "said", t.why || "")); card.append(c);
  }
  // For several tests, the line for them all: above the bar, always in view.
  const jc = $("jobcard"); jc.replaceChildren();
  jc.hidden = !(S.jobEnd && S.order.length > 1);
  if (!jc.hidden) jc.append(jobCard(S.jobEnd));

  // The bar: the timer and Stop test while it runs.
  $("stop").hidden = !running; $("stop").disabled = false;
  $("again").hidden = running;
  $("barwords").textContent = barWords(t, running);
  paintScreen(t);
}

/** The bar's words: one timer for the run; with several tasks, the whole job's time, and this one's. */
function barWords(t, running) {
  const n = S.order.length;
  const began = (t && t.began) || (S.job && S.job.began);
  if (running) {
    if (n > 1 && S.job) { const idx = S.order.findIndex((id) => test(id).status === "running"); return "Testing task " + (idx < 0 ? 1 : idx + 1) + " of " + n + "… " + took(Date.now() - S.job.began); }
    return began ? "Testing your website… " + took(Date.now() - began) : "Starting…";
  }
  if (n > 1 && S.jobEnd) return "Finished " + n + " tasks in " + took(S.jobEnd.ms) + (t && t.result ? " · this one " + took(t.result.ms) : "");
  if (t && t.result) return "Finished in " + took(t.result.ms);
  return "Stopped";
}

const VERDICT_WORDS = { pass: "Passed", fail: "Failed", blocked: "Blocked", not_sure: "Not sure" };
function resultCard(t) {
  const r = t.result;
  const c = el("div", "result");
  const h = el("div", "rhead");
  // The goal is in the top bar: the card says how it went, and how long it took.
  const time = el("span", "chip"); time.append(icon("clock"), document.createTextNode(took(r.ms)));
  h.append(icon(r.verdict === "pass" ? "okc" : r.verdict === "fail" ? "badc" : "mehc", "status " + (r.verdict === "pass" ? "ok" : r.verdict === "fail" ? "bad" : "meh")), el("b", null, r.botWall ? "Blocked by the site's bot check" : VERDICT_WORDS[r.verdict] || VERDICT[r.verdict]), time, el("span", "badge " + r.verdict, VERDICT[r.verdict]));
  const weak = r.steps.filter((s) => s.verdict === "passed" && s.weak).length;
  const judgedSteps = r.steps.filter((s) => s.verdict === "passed" && s.judged).length;
  c.append(h, el("div", "rsub", [r.replay ? "Replayed from the saved test" : "Planned by AI", r.passed + " of " + r.steps.length + " step" + (r.steps.length === 1 ? "" : "s") + " passed", weak ? weak + " check" + (weak === 1 ? " proves" : "s prove") + " little" : "", judgedSteps ? judgedSteps + " step" + (judgedSteps === 1 ? "" : "s") + " judged by AI" : "", t.tokens && t.tokens !== "no AI" ? t.tokens : ""].filter(Boolean).join(" · ")));
  const first = r.steps.find((s) => s.verdict !== "passed");
  if (r.verdict !== "pass") c.append(el("p", "said", first ? "Step " + first.n + ", " + first.title + ": " + (first.reason || first.verdict) : ""));
  if (r.stopped) c.append(el("p", "reason warn", "Stopped early: " + r.stopped));
  if (r.botWall) c.append(el("p", "reason warn", "The site checks for bots (" + r.botWall + ") and didn't let the test browser in. Context Machines doesn't get past bot checks: try a site you own, its staging address, or ask the owner to let the tester through."));
  const shots = Object.entries(t.shots || {});
  if (shots.length) {
    const d = el("details", "more"); const s = el("summary");
    d.open = Boolean(t.shotsOpen); d.addEventListener("toggle", () => { t.shotsOpen = d.open; });
    s.append(icon("image"), el("span", null, "Screenshots (" + shots.length + ")"), icon("chev", "chev"));
    const g = el("div", "shots");
    for (const [n, src] of shots) {
      const st = r.steps.find((x) => String(x.n) === n);
      const b = el("button"); b.type = "button"; b.title = st ? "Step " + n + ": " + st.title : "Step " + n;
      const img = el("img"); img.src = src; img.alt = b.title; img.loading = "lazy";
      b.append(img, el("span", null, "Step " + n));
      b.addEventListener("click", () => { if (st && t.video) { const v = $("video"); v.currentTime = st.at + st.ms / 1000; } });
      g.append(b);
    }
    d.append(s, g); c.append(d);
  }
  if (r.friction && r.friction.length) {
    const d = el("details", "more"); d.open = t.stuckOpen !== false; d.addEventListener("toggle", () => { t.stuckOpen = d.open; }); const s = el("summary");
    s.append(icon("warn"), el("span", null, "Where people get stuck (" + r.friction.length + ")"), icon("chev", "chev"));
    const ul = el("ul", "stuck");
    for (const f of r.friction) { const li = el("li"); li.append(el("span", null, f.says), el("span", "where", "· step " + f.step)); ul.append(li); }
    d.append(s, ul); c.append(d);
  }
  if (t.a11y) c.append(a11yBlock(t.a11y, t));
  const links = el("div", "links");
  if (t.report) { const a = el("a", null, "Open the report"); a.href = t.report; a.target = "_blank"; a.rel = "noopener noreferrer"; links.append(a); }
  if (t.signInVideo) { const a = el("a", null, "Watch the sign-in (its boxes show dots)"); a.href = t.signInVideo; a.target = "_blank"; a.rel = "noopener noreferrer"; links.append(a); }
  if (t.savedTo) { const s = el("span", null, "Saved as a test: "); s.append(el("code", null, t.savedTo)); links.append(s); }
  else if (t.folder) { const s = el("span", null, "Run folder: "); s.append(el("code", null, t.folder)); links.append(s); }
  c.append(links);
  return c;
}

/** The accessibility scan: one sentence, opened to each kind with its WCAG reference and findings. Measured, no AI. */
function a11yBlock(a, o) {
  const d = el("details", "more a11y"); d.open = Boolean(o.a11yOpen); d.addEventListener("toggle", () => { o.a11yOpen = d.open; }); const s = el("summary");
  s.append(icon("eye"), el("span", null, "Accessibility: " + a.summary), icon("chev", "chev"));
  const body = el("div", "a11y-body");
  body.append(el("p", "where", "Each page on the site reached, checked against 8 rules by the browser: no AI opinion, and not a full audit."));
  for (const g of a.groups || []) {
    body.append(el("p", "a11y-kind", g.title + " · " + g.wcag));
    const ul = el("ul", "stuck");
    for (const f of g.items) { const li = el("li"); li.append(el("span", null, f.what), el("span", "where", "· " + f.page)); ul.append(li); }
    for (const m of g.more) ul.append(el("li", "where", "and " + m.n + " more on " + m.page));
    body.append(ul);
  }
  for (const n of a.notes || []) body.append(el("p", "where", n));
  d.append(s, body);
  return d;
}

function jobCard(j) {
  const c = el("div", "result"); const h = el("div", "rhead");
  // Green only when every task ran and passed: one not run (stopped, or out of time) wasn't tested.
  const k = j.counts || {};
  const ok = k.passed && !k.failed && !k.notSure && !k.blocked && !k.couldNot && !k.notRun;
  h.append(icon(ok ? "okc" : "mehc", "status " + (ok ? "ok" : "meh")), el("b", null, j.summary));
  c.append(h, el("div", "rsub", [took(j.ms), j.sites > 1 ? j.sites + " sites" : "", j.explore ? "site page written" : ""].filter(Boolean).join(" · ")));
  if (j.stuck && j.stuck.length) {
    const d = el("details", "more"); d.open = j.stuckOpen !== false; d.addEventListener("toggle", () => { j.stuckOpen = d.open; }); const s = el("summary");
    s.append(icon("warn"), el("span", null, "Where people get stuck, across all tasks"), icon("chev", "chev"));
    const ul = el("ul", "stuck");
    for (const f of j.stuck.slice(0, 12)) { const li = el("li"); li.append(el("span", null, f.says), el("span", "where", "· task " + f.n + (f.times > 1 ? ", and " + (f.times - 1) + " more" : ""))); ul.append(li); }
    d.append(s, ul); c.append(d);
  }
  if (j.a11y) c.append(a11yBlock(j.a11y, j));
  if (j.explore) { const l = el("div", "links"); const s = el("span", null, "Site page: "); s.append(el("code", null, j.explore)); l.append(s); c.append(l); }
  return c;
}

let shownVideo = "";
/** The address on screen at this moment of the video: from the live screen's frames as it was recorded. */
function addrAt(t, now) {
  let u = t.url;
  // The live timeline, or after a reload the run's own (result.urls); before the first address of either, the start address, said so.
  const line = t.urls && t.urls.length ? t.urls : (t.result && t.result.urls) || [];
  let started = Boolean(line.length);
  for (const p of line) { if (p.t > now + 0.05) break; if (/^https?:/.test(p.url)) { u = p.url; started = false; } }
  if (!line.length) for (const st of t.steps) if (st.url && st.at !== undefined && st.at + (st.ms || 0) / 1000 <= now + 0.05) u = st.url;
  $("addrwords").textContent = u ? (started ? "started at " + u : u) : "";
}
/** Which step and sub-action the video shows now: marked in the list, so the video and the list follow each other. */
function markPlaying(t, now) {
  let cur = 0;
  for (const st of t.steps) if (st.at !== undefined && st.state !== "skipped" && st.at <= now + 0.05) cur = st.n;
  for (const li of document.querySelectorAll("#steps .step")) li.classList.toggle("playing", Number(li.dataset.n) === cur && now > 0);
  let sub = null;
  for (const x of document.querySelectorAll("#steps .step.playing .sub[data-at]")) if (Number(x.dataset.at) <= now + 0.05) sub = x;
  for (const x of document.querySelectorAll("#steps .sub.playing")) if (x !== sub) x.classList.remove("playing");
  if (sub) sub.classList.add("playing");
}
// E9: a portrait screen (a run at a phone's width) gets the phone frame.
const phoneFrame = (w, h) => { if (w && h) $("live").closest(".window").classList.toggle("phone", h > w); };
$("live").addEventListener("load", () => phoneFrame($("live").naturalWidth, $("live").naturalHeight));
$("video").addEventListener("loadedmetadata", () => phoneFrame($("video").videoWidth, $("video").videoHeight));
for (const ev of ["timeupdate", "seeked", "play", "pause"]) $("video").addEventListener(ev, () => {
  const t = test(S.sel); if (!t || !t.result) return;
  const now = $("video").currentTime;
  addrAt(t, now); markPlaying(t, now);
});
function paintScreen(t) {
  const v = $("video"), img = $("live"), wait = $("waiting");
  if (t && t.status === "done" && t.video) {
    img.hidden = true; wait.hidden = true; v.hidden = false;
    if (shownVideo !== t.video) { shownVideo = t.video; v.src = t.video; const shot = Object.values(t.shots || {})[0]; if (shot) v.poster = shot; else v.removeAttribute("poster"); }
    addrAt(t, v.currentTime || 0); markPlaying(t, v.currentTime || 0);
    return;
  }
  if (!v.hidden) { v.pause(); v.hidden = true; }
  paintFrame();
}
function paintFrame() {
  const t = test(S.sel), img = $("live"), wait = $("waiting");
  if (S.view !== "run" || !t || (t.status === "done" && t.video)) return;
  // The sign-in is shown live like the rest of the run: its boxes show dots.
  const f = S.frames.get(t.id);
  if (f) {
    img.src = "data:image/jpeg;base64," + f.jpeg; img.hidden = false; wait.hidden = true;
    $("addrwords").textContent = (/^https?:/.test(f.url || "") ? f.url : t.url) || "";
  } else {
    img.hidden = true; wait.hidden = false;
    $("addrwords").textContent = t.url || "";
    $("waitwords").textContent = t.signingIn ? (t.signingWords || "Signing in…") : t.noScreen ? "No live screen" : t.status === "queued" ? "Waiting its turn" : t.status === "running" ? "Suiting up…" : t.status === "done" ? "No video for this run" : VERDICT[t.status] || "";
    $("waitsub").textContent = t.signingIn ? "The sign-in page shows here as it opens; its boxes show dots." : t.noScreen || (t.status === "queued" ? "It runs after the tasks before it." : t.status === "running" ? "Your run is taking off in a moment." : t.why || "");
  }
}

function render() {
  const run = S.view === "run";
  $("start").hidden = run; $("run").hidden = !run;
  $("chip").hidden = !run; $("close").hidden = !run || Boolean(S.busy);
  if (!run) { $("title").textContent = "Test a website"; renderStart(); }
  else renderRun();
}
setInterval(() => { if (S.view === "run" && S.busy === "run") $("barwords").textContent = barWords(test(S.sel), true); }, 1000);
render();
connect();
`;
