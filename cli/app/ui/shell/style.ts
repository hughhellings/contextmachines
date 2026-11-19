/**
 * The app's shared stylesheet. The colour tokens and the font are the current web view's
 * (cli/ui-page.ts), so the app and the live run screen look like one product. Light and dark
 * follow the system. Screens style themselves with these tokens only (--bg, --fg, --muted, --faint,
 * --line, --soft, --card, --hover, --sel, --pass, --passbg, --fail, --failbg, --warn, --warnbg,
 * --primary, --primaryfg, --shadow), plus the shared parts below (.btn, .card, .field, .pill, .tbl …).
 */

export const TOKENS_CSS = `
:root {
  --bg: #ffffff; --fg: #18181b; --muted: #71717a; --faint: #a1a1aa; --line: #e4e4e7; --soft: #f4f4f5; --stage: #f4f4f5;
  --card: #ffffff; --hover: #f4f4f5; --sel: #f4f4f5; --pass: #16a34a; --passbg: #dcfce7; --fail: #dc2626; --failbg: #fee2e2;
  --warn: #b45309; --warnbg: #fef3c7; --primary: #18181b; --primaryfg: #ffffff; --shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(0,0,0,.06);
  --info: #2563eb; --infobg: #dbeafe; --rail: #fafafa;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0c0e; --fg: #f4f4f5; --muted: #a1a1aa; --faint: #71717a; --line: #27272a; --soft: #18181b; --stage: #141417;
    --card: #111113; --hover: #1c1c1f; --sel: #1f1f23; --pass: #4ade80; --passbg: #14532d; --fail: #f87171; --failbg: #450a0a;
    --warn: #fbbf24; --warnbg: #422006; --primary: #f4f4f5; --primaryfg: #18181b; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.4);
    --info: #60a5fa; --infobg: #172554; --rail: #0f0f12;
    color-scheme: dark;
  }
}
`;

export const SHELL_CSS = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; overflow-x: hidden; }
button, input, select, textarea { font: inherit; color: inherit; }
a { color: inherit; }
.grow { flex: 1; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.small { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.ico { display: inline-flex; width: 16px; height: 16px; flex: none; }
.ico svg { width: 100%; height: 100%; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--fg) 35%, transparent); outline-offset: 2px; }

/* App frame: rail + main */
.app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.app.bare { grid-template-columns: minmax(0, 1fr); }
.app.bare .rail { display: none; }
.rail { border-right: 1px solid var(--line); background: var(--rail); display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; padding: 4px 6px 10px; white-space: nowrap; text-decoration: none; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, var(--fg) 0 50%, var(--faint) 50%); flex: none; }
.picker { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 0 8px; margin-bottom: 8px; }
.picker select { flex: 1; min-width: 0; border: 0; background: none; padding: 7px 0; font-weight: 600; cursor: pointer; appearance: none; -webkit-appearance: none; }
.picker select:focus { outline: none; }
.picker:focus-within { outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
.nav { display: flex; flex-direction: column; gap: 1px; }
.nav a { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 7px; text-decoration: none; color: var(--muted); font-weight: 500; white-space: nowrap; }
.nav a:hover { background: var(--hover); color: var(--fg); }
.nav a[aria-current="page"] { background: var(--sel); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line); }
.nav .count { margin-left: auto; font-size: 11px; font-weight: 600; min-width: 18px; text-align: center; border-radius: 999px; padding: 0 6px; background: var(--failbg); color: var(--fail); }
.rail .foot { margin-top: auto; padding: 8px 6px 0; font-size: 12px; color: var(--faint); }
.main { min-width: 0; display: flex; flex-direction: column; }
.top { height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 20px; border-bottom: 1px solid var(--line); background: var(--bg); position: sticky; top: 0; z-index: 5; min-width: 0; }
.top .where { display: flex; align-items: center; gap: 8px; min-width: 0; }
.top .url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; white-space: nowrap; text-decoration: none; }
.chip .ico { width: 12px; height: 12px; }
.chip.local { color: var(--info); border-color: color-mix(in srgb, var(--info) 35%, transparent); }
.chip.staging { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.chip.production { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 35%, transparent); }
.chip.running { color: var(--fg); border-color: var(--line); background: var(--soft); font-weight: 600; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pass); flex: none; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.conn { font-size: 12px; color: var(--warn); white-space: nowrap; }
.iconbtn.menu { display: none; }
.content:focus { outline: none; }
.content { padding: 28px 24px 64px; width: 100%; max-width: 1080px; margin: 0 auto; min-width: 0; }

/* Shared parts */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-weight: 500; white-space: nowrap; box-shadow: 0 1px 1px rgba(0,0,0,.03); text-decoration: none; }
.btn:hover { background: var(--hover); }
.btn:disabled { opacity: .45; cursor: default; }
.btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.btn.primary:hover { opacity: .9; }
.btn.primary:disabled { background: var(--soft); color: var(--faint); border-color: var(--line); opacity: 1; box-shadow: none; }
.btn.danger { color: var(--fail); }
.btn.small { padding: 4px 10px; font-size: 13px; }
.btn .ico { width: 14px; height: 14px; }
.link { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; font-size: 13px; }
.link:hover { color: var(--fg); }
.iconbtn { border: 0; background: none; padding: 6px; border-radius: 6px; cursor: pointer; color: var(--muted); display: inline-flex; }
.iconbtn:hover { background: var(--hover); color: var(--fg); }
.pagehead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 18px; }
.pagehead h1 { font-size: 22px; letter-spacing: -0.015em; margin: 0; }
.pagehead p { margin: 2px 0 0; color: var(--muted); }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); overflow: clip; }
.card + .card { margin-top: 16px; }
.cardhead { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.cardhead h2 { font-size: 15px; margin: 0; }
.cardbody { padding: 14px 16px; }
.cardfoot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.field { display: grid; gap: 4px; font-size: 13px; font-weight: 500; min-width: 0; }
.field em { font-style: normal; color: var(--faint); font-weight: 400; }
.field .hint { font-weight: 400; color: var(--muted); font-size: 12px; }
.input, .field input, .field select, .field textarea { font-size: 14px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); width: 100%; min-width: 0; }
.field textarea { resize: vertical; min-height: 96px; line-height: 1.45; }
.input:focus, .field input:focus, .field select:focus, .field textarea:focus { outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.check { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; cursor: pointer; }
.check input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--primary); flex: none; }
.pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; letter-spacing: .03em; border-radius: 6px; padding: 1px 7px; white-space: nowrap; border: 1px solid transparent; }
.pill.pass { background: var(--passbg); color: var(--pass); }
.pill.fail { background: var(--failbg); color: var(--fail); }
.pill.blocked, .pill.not_sure, .pill.flaky { background: var(--warnbg); color: var(--warn); }
.pill.status { background: var(--soft); color: var(--muted); border-color: var(--line); font-weight: 600; }
.pill .judged { font-weight: 500; opacity: .85; text-transform: lowercase; letter-spacing: 0; }
.tag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.note { padding: 10px 12px; border-radius: 8px; background: var(--soft); color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.note.warn { background: var(--warnbg); color: var(--warn); }
.note.bad { background: var(--failbg); color: var(--fail); }
.error { padding: 10px 12px; border-radius: 8px; background: var(--failbg); color: var(--fail); overflow-wrap: anywhere; }
.empty { padding: 36px 16px; text-align: center; color: var(--muted); }
.empty b { display: block; color: var(--fg); margin-bottom: 4px; }
.list { list-style: none; margin: 0; padding: 0; }
.list > li { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--line); min-width: 0; }
.list > li:first-child { border-top: 0; }
.list > li.click { cursor: pointer; }
.list > li.click:hover { background: var(--hover); }
.list .name { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list .sub { color: var(--muted); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list .stack { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.list .meta { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--fg); animation: spin .8s linear infinite; flex: none; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: grid; gap: 8px; z-index: 50; width: max-content; max-width: calc(100vw - 32px); }
.toast { background: var(--primary); color: var(--primaryfg); padding: 9px 14px; border-radius: 8px; box-shadow: var(--shadow); font-size: 13px; overflow-wrap: anywhere; }
.loading { display: flex; align-items: center; gap: 10px; color: var(--muted); padding: 24px 0; }

/* Phone and narrow */
@media (max-width: 767px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .rail { position: fixed; inset: 0 auto 0 0; width: 260px; z-index: 30; transform: translateX(-100%); transition: transform .18s ease; box-shadow: var(--shadow); height: 100%; }
  .app.open .rail { transform: none; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 20; }
  .iconbtn.menu { display: inline-flex; }
  .top { padding: 0 12px; }
  .content { padding: 20px 16px 48px; }
  .grid2 { grid-template-columns: minmax(0, 1fr); }
  .list > li { padding: 10px 12px; }
}
`;
