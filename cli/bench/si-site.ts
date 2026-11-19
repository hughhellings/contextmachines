/**
 * A signed-in dealing ledger's "add one manual trade" flow on the fixture site (bench/site.ts), copied
 * from the real app Sam tested on 2026-11-18 (scratchpad wizard/MAP.md): the same visible words,
 * roles, structure and awkward widgets, with no brand and no sign-in (the run starts signed in, on the
 * brief page).
 *
 *   rail "Trades" → "Add trade" (or the rail's "Add trades") → the import wizard at <prefix>import/platform:
 *   1 Platform  "Where are your trades?"         a platform tile moves on by itself (no Continue)
 *   2 Method    "How would you like to add them?" the "Manual entry" card moves on by itself
 *   3 Details   "Enter the trade"                 a custom symbol combobox, native selects, Long/Short
 *               buttons, a fill table of datetime-local and text inputs whose labels are raw keys
 *               ("price for fill 1"), errors under fields, a Continue that only looks disabled
 *   4 Review    "Check your trade"                "Save trade" (disabled while it saves)
 *   5 Finish    "<SYMBOL> saved"                  no toast; the new row shows on the trades list
 *
 * The whole step is redrawn with innerHTML on every input (refs taken before typing go stale), the
 * step scrolls inside #iwBody, a cookie banner, a chat bubble and a "VIEW AS" pill sit over the page,
 * the page subtitle says "Manually, from a file, or by connecting the platform" on every step (the
 * vacuous "Manual" check), and leaving after typing raises a "Leave site?" prompt.
 *
 * Copies under several prefixes:
 *   /si/   saving works: the server's ledger records the trade, and logs <prefix>ledger/saved?… in
 *          the site's request log (the bench's oracle: only a real, accepted save writes it), and
 *          <prefix>ledger/closed?… too when the trade has an exit fill. Like the real app, one fill (an
 *          open position) is accepted (IB:4520-4535, importBridge.ts:168, manualTrade.ts:238-258);
 *   /sib/  saving is broken: "Save trade" does nothing at all;
 *   /sil/  saving works, but the first account (the one the form picks) is a verified provider account,
 *          as the real app's accountId() may pin: "Save trade" there is refused with the real app's own
 *          words (accountLock.ts:69-70, no "pick another") until the ledger account is chosen in "Account";
 *   /sio/  the user's only account is a verified provider account: the real form then shows the account as
 *          static text, no select (IB:5302-5305), so nothing in the form can change it;
 *   /sit/  two verified provider accounts and the select's "Create a new account…" (IB:5313-5324): choosing
 *          it adds "New account currency", and saving creates a manual account (importBridge.ts:173-195),
 *          logged as <prefix>ledger/account-created;
 *   /sic/  the same as /sit/, for the task that creates an account: an account made there never shows up
 *          in /sit/'s list (each prefix keeps its own accounts), whatever order the tasks run in;
 *   /si2/  FIXTURE-ONLY RULE, not the real app's: a save with no exit fill is refused ("A trade needs an
 *          entry and an exit fill."), for Sam's own rule that a trade has two executions.
 *
 * The Account field follows the real counts (destinationField, IB:5289-5325): no account, static "A new
 * <Platform> account" and a currency select; one, static text; two or more, a select of the same ordered
 * list the default is taken from, then "Create a new account…".
 *
 * No AI, no network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface SiTrade {
  id: string;
  date: string;
  symbol: string;
  assetClass: string;
  direction: "Long" | "Short";
  size: string;
  entry: string;
  exit: string;
  pnl: string;
  account: string;
}

interface Account {
  id: string;
  label: string;
  /** A verified provider account: its trades come only from the provider (the save is refused). */
  locked: boolean;
}

const ACCOUNTS: readonly Account[] = [
  { id: "acc-1", label: "Manual ledger · Main", locked: false },
  { id: "acc-2", label: "IC Markets · Live 5512", locked: true },
];

/** The real app's words, verbatim (src/utils/accountLock.ts:69-70): it names no other account and says no "pick another". */
const LOCKED = "This account is verified: its trades come only from the provider and cannot be added, edited or deleted here. Notes, tags and screenshots can still change.";

/** /sio/: the user's only account is a verified one (the shape of Sam's real account). */
export const ONLY_LOCKED: readonly Account[] = [{ id: "acc-9", label: "MetaTrader 5 · Blueberry Markets · 5152327", locked: true }];
/** /sit/: two verified provider accounts, no manual one. */
export const TWO_LOCKED: readonly Account[] = [{ id: "acc-9", label: "MetaTrader 5 · Blueberry Markets · 5152327", locked: true }, { id: "acc-2", label: "IC Markets · Live 5512", locked: true }];

/** /si3/: two verified provider accounts first, and only the third takes manual trades (Sam's real form's shape, other names). */
export const THIRD_OK: readonly Account[] = [{ id: "acc-31", label: "cAlgo · Live 7001", locked: true }, { id: "acc-32", label: "NinjaBroker · 8002", locked: true }, { id: "acc-33", label: "Paper dealing · Practice", locked: false }];

/** /si2/'s refusal: a FIXTURE-ONLY rule (the real app saves an open position). */
const NEEDS_EXIT = "A trade needs an entry and an exit fill.";

const CURRENCIES = ["GBP", "USD", "EUR", "AUD", "CAD", "CHF", "JPY"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:#f6f7f9;color:#14181f;display:flex;min-height:100vh}
.rail{width:200px;flex:none;background:#fff;border-right:1px solid #e3e6ea;padding:14px 10px;display:flex;flex-direction:column;gap:4px}
.rail .brand{font-weight:700;padding:6px 10px 14px}.rail a{color:#14181f;text-decoration:none;padding:8px 10px;border-radius:8px}.rail a[aria-current]{background:#eef2ff;font-weight:600}
.rail-add{background:#2952e3;color:#fff;border:0;border-radius:8px;padding:9px 10px;font-weight:600;text-align:left;margin-bottom:10px;cursor:pointer}
.main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh}.ph{padding:18px 28px 6px}.ph-title{font-size:22px;font-weight:700}.ph-sub{color:#5b6472;margin:2px 0 0}
.content{padding:12px 28px;overflow:auto}.ctl{border:1px solid #cfd5dd;background:#fff;border-radius:8px;padding:7px 12px;cursor:pointer}.ctl.pri{background:#2952e3;color:#fff;border-color:#2952e3}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #eceef1;padding:8px;text-align:left}tr.day td{background:#f0f2f5;font-weight:600}
.cookie{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;width:560px;background:#14181f;color:#fff;border-radius:12px;padding:14px 16px;z-index:50}.cookie button{margin:8px 8px 0 0}
.chat{position:fixed;right:18px;bottom:18px;width:56px;height:56px;border-radius:50%;background:#2952e3;color:#fff;border:0;z-index:40;font-size:22px}
.viewas{position:fixed;left:12px;bottom:12px;background:#fff3c4;border:1px solid #e0c060;border-radius:999px;padding:4px 10px;font-size:11px;z-index:40}
.iw{display:flex;flex-direction:column;flex:1;min-height:0;margin:0 28px 12px;background:#fff;border:1px solid #e3e6ea;border-radius:12px}
.iw-steps{display:flex;gap:18px;list-style:none;margin:0;padding:12px 20px;border-bottom:1px solid #eceef1;color:#8a93a0}.iw-steps li[aria-current]{color:#14181f;font-weight:600}
#iwBody{flex:1;min-height:0;overflow:auto;padding:18px 22px}.iw-head h1{font-size:20px;margin:0 0 4px}.iw-head p{color:#5b6472;margin:0 0 14px}
.iw-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:10px 0 18px}.iw-tile{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-height:118px;text-align:left;border:1px solid #d9dee5;border-radius:10px;background:#fff;padding:12px;cursor:pointer}
.iw-tile b{font-size:15px}.badge{font-size:11px;background:#eef2ff;color:#2952e3;border-radius:999px;padding:1px 8px}.iw-tile .note{color:#5b6472;font-size:12px}
.iw-methods-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.iw-method{text-align:left;border:1px solid #d9dee5;border-radius:10px;background:#fff;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:6px}
.iw-method dl{margin:6px 0 0;font-size:12px}.iw-method dt{color:#8a93a0}.iw-method dd{margin:0 0 4px}
.iw-block{border:1px solid #eceef1;border-radius:10px;padding:12px 14px;margin-bottom:14px}.iw-block h2{font-size:15px;margin:0 0 10px}
.iw-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.iw-field label,.iw-lab{display:block;font-weight:600;font-size:12px;margin-bottom:4px}
.input,.sel{width:100%;border:1px solid #cfd5dd;border-radius:8px;padding:7px 9px;font:inherit;background:#fff}.has-error .input{border-color:#d33}.iw-err{display:block;color:#c22;font-size:12px;margin-top:3px}
.iw-combo{position:relative}.iw-combo-list{position:absolute;left:0;right:0;top:100%;z-index:5;background:#fff;border:1px solid #cfd5dd;border-radius:8px;margin:2px 0 0;padding:4px 0;list-style:none;max-height:260px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.12)}
.iw-combo-list li{padding:6px 10px;cursor:pointer}.iw-combo-list li[aria-selected=true]{background:#eef2ff}.iw-combo-list li span{margin-left:8px;color:#8a93a0;font-size:11px}
.seg{display:inline-flex;border:1px solid #cfd5dd;border-radius:8px;overflow:hidden}.seg button{border:0;background:#fff;padding:6px 12px;cursor:pointer}.seg button[aria-pressed=true]{background:#2952e3;color:#fff}
.iw-fills td{vertical-align:top;border:0;padding:4px}.iw-fills th{font-size:12px;color:#5b6472;border:0;padding:4px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.iw-tz{display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:12px}.iw-tablewrap{overflow-x:auto}
.iw-note{border-radius:8px;padding:10px 12px;margin:10px 0;background:#f0f2f5}.iw-note.bad{background:#fdecec;color:#8a1c1c}.iw-note.warn{background:#fff6dd}
#iwActions{display:flex;align-items:center;gap:10px;padding:12px 88px 12px 20px;border-top:1px solid #eceef1}#iwActions .grow{flex:1}.iw-gate{color:#5b6472;font-size:12px}
.btn{border:1px solid #cfd5dd;background:#fff;border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer}.btn.pri{background:#2952e3;color:#fff;border-color:#2952e3}.btn.pri[aria-describedby]{opacity:.62}.btn[disabled]{opacity:.5;cursor:default}
.iw-final{text-align:center;padding:40px 10px}.iw-final h1{font-size:24px}.iw-final .row{display:flex;gap:10px;justify-content:center;margin-top:16px}
.pill{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;background:#eef2ff;margin-left:6px}.iw-backlink{border:0;background:none;color:#2952e3;cursor:pointer;padding:0;margin-bottom:8px}`;

/** The rail, the cookie banner, the chat bubble and the "VIEW AS" pill, as on every signed-in page. */
function shell(prefix: string, here: "brief" | "trades" | "import" | "other", title: string, sub: string, inner: string, script = ""): string {
  const link = (to: string, words: string) => `<a href="${prefix}${to}"${here === to ? ' aria-current="page"' : ""}>${words}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Fixture Insight</title><style>${CSS}</style></head>
<body data-base="${prefix}"><nav class="rail" aria-label="Main"><div class="brand">Fixture Insight</div>
<button type="button" class="rail-item rail-add" data-tour="nav-addTrade" onclick="location.href='${prefix}import/'">Add trades</button>
${link("brief", "Brief")}<a href="${prefix}calendar">Calendar</a>${link("trades", "Trades")}<a href="${prefix}insights">Insights</a><a href="${prefix}settings">Settings</a></nav>
<div class="main"><header class="ph"><div class="ph-title">${esc(title)}</div>${sub ? `<p class="ph-sub">${esc(sub)}</p>` : ""}</header>${inner}</div>
<div class="cookie" id="cookie" role="region" aria-label="Cookies"><b>Cookies</b><div>We use essential cookies to keep you signed in, and others to see how the app is used.</div>
<button type="button" class="ctl" onclick="document.cookie='si-consent=reject;path=/';this.closest('.cookie').remove()">Reject non-essential cookies</button><button type="button" class="ctl pri" onclick="document.cookie='si-consent=all;path=/';this.closest('.cookie').remove()">Accept all cookies</button></div>
<button type="button" class="chat" aria-label="Support chat">?</button><div class="viewas" aria-label="View as">VIEW AS <b>AUTO</b> FREE PRO</div>
<script>if(/(^|;\\s*)si-consent=/.test(document.cookie)){var c=document.getElementById('cookie');if(c)c.remove();}</script>${script}</body></html>`;
}

const TODAY = () => new Date().toISOString().slice(0, 10);
const dayLabel = (d: string) => (d === TODAY() ? "Today" : d);

function brief(prefix: string, trades: readonly SiTrade[]): string {
  const today = trades.filter((t) => t.date === TODAY());
  return shell(prefix, "brief", "Brief", "", `<main class="content"><h1>Good morning</h1><p>Markets open in 2 hours.</p>
<section aria-label="Today"><h2>Today</h2><p>${today.length ? `${today.length} trade${today.length > 1 ? "s" : ""} today.` : "No trades yet today."}</p></section>
<section aria-label="This week"><h2>This week</h2><p>${trades.length} trades in your record.</p></section></main>`);
}

function tradesPage(prefix: string, trades: readonly SiTrade[]): string {
  const sorted = [...trades].sort((a, b) => b.date.localeCompare(a.date));
  let last = "";
  const rows = sorted.map((t) => {
    const head = t.date !== last ? `<tr class="day"><td colspan="8">${esc(dayLabel(t.date))}</td></tr>` : "";
    last = t.date;
    return `${head}<tr><td>${esc(t.date)}</td><td><a href="${prefix}trade/${esc(t.id)}">${esc(t.symbol)}</a></td><td>${esc(t.direction)}</td><td>${esc(t.size)}</td><td>${esc(t.entry)}</td><td>${esc(t.exit || "Open")}</td><td>${esc(t.pnl)}</td><td>${esc(t.account)}</td></tr>`;
  }).join("\n");
  return shell(prefix, "trades", "Trades", "Every trade in your record", `<main class="content">
<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:10px"><button type="button" class="ctl" data-act="importCsv" onclick="location.href='${prefix}import/'">Import trades</button><button type="button" class="ctl pri" data-act="addTrade" onclick="location.href='${prefix}import/'">+ Add trade</button></div>
<table aria-label="Trades"><thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Account</th></tr></thead><tbody>
${rows}
</tbody></table></main>`);
}

function tradePage(prefix: string, t: SiTrade): string {
  return shell(prefix, "other", t.symbol, `${t.direction} · ${t.date}`, `<main class="content"><h1>${esc(t.symbol)}</h1><dl><dt>Account</dt><dd>${esc(t.account)}</dd><dt>Size</dt><dd>${esc(t.size)}</dd><dt>Entry</dt><dd>${esc(t.entry)}</dd><dt>Exit</dt><dd>${esc(t.exit || "Open")}</dd><dt>Result</dt><dd>${esc(t.pnl)}</dd></dl><p><a href="${prefix}trades">All trades</a></p></main>`);
}

/**
 * The wizard, in the browser: one state object, and the step redrawn with innerHTML on every input,
 * focus and caret put back by id, as the real one does. Plain ES5 in a string (no backticks, no ${}).
 */
const WIZARD_JS = String.raw`
(function () {
  var BASE = document.body.getAttribute('data-base');
  var BROKEN = document.body.getAttribute('data-broken') === '1';
  var DATA = JSON.parse(document.getElementById('si-data').textContent);
  var ACCOUNTS = DATA.accounts;
  var PLATFORMS = [
    { id: 'px5', name: 'MetaTrader 5', methods: ['sync', 'file', 'manual'], cls: 'Forex', badge: 'Auto sync support', note: 'Connector install is the supported route. Every fill comes in, with the stop.' },
    { id: 'mt4', name: 'MetaTrader 4', methods: ['sync', 'file', 'manual'], cls: 'Forex', badge: 'Auto sync support', note: 'The same connector as MetaTrader 5.' },
    { id: 'ctrader', name: 'cTrader', methods: ['sync', 'file', 'manual'], cls: 'Forex', badge: 'Sign in to connect', note: 'Sign in with cTrader once.' },
    { id: 'tradeo', name: 'Tradeo', methods: ['sync', 'file', 'manual'], cls: 'Future', badge: 'Sign in to connect', note: 'Futures, by account.' },
    { id: 'ninja', name: 'NinjaTrader', methods: ['file', 'manual'], cls: 'Future', badge: 'File upload', note: 'Export the Trades grid as CSV.' },
    { id: 'tradelocker', name: 'TradeLocker', methods: ['file', 'manual'], cls: 'Forex', badge: 'File upload', note: 'Export from the account history.' },
    { id: 'ibkr', name: 'Interactive Providers', methods: ['file', 'manual'], cls: 'Stock', badge: 'File upload', note: 'A Flex Query export.' },
    { id: 'rithmic', name: 'Rithmic', methods: ['file', 'manual'], cls: 'Future', badge: 'File upload', note: 'R | Trader Pro order history.' },
    { id: 'other', name: 'Something else', methods: ['file', 'manual'], cls: '', badge: 'File upload', note: 'Any other platform or provider: upload its export, or type the trade in.' }
  ];
  var LEDGERS = ['TradeZella', 'TraderSync', 'TradesViz', 'Tradervue', 'Edgewonk'];
  var PROVIDERS_LIST = [['FundCo', 'px5'], ['IC Markets', 'px5'], ['Pepperstone', 'ctrader'], ['FXCM', 'mt4'], ['OANDA', 'px5'], ['XM', 'px5'], ['Exness', 'px5'], ['FundedNext', 'px5'], ['The5ers', 'px5'], ['Topstep', 'tradeo'], ['Apex Trader Funding', 'rithmic'], ['AMP Futures', 'ninja'], ['Tradeify', 'tradeo'], ['FXIFY', 'tradelocker'], ['Blueberry Markets', 'mt4'], ['Fusion Markets', 'ctrader'], ['Vantage', 'px5'], ['Admirals', 'px5'], ['Eightcap', 'px5'], ['Axi', 'mt4']];
  var METHOD = {
    sync: { name: 'Connect the platform', what: 'Your history comes in now and new trades after that, on their own.', who: 'Anyone who does not want to upload files again.', effort: 'Five minutes, once', cadence: 'Ongoing' },
    file: { name: 'File upload', what: 'Export your history from the platform and upload the file.', who: 'A past history, or a platform with no connection.', effort: 'A few minutes', cadence: 'Whenever you export' },
    manual: { name: 'Manual entry', what: 'Type the trade in yourself, including each fill.', who: 'A trade or two, or a platform with no export.', effort: 'A minute a trade', cadence: 'One-off' }
  };
  var STEPS = [['platform', 'Platform'], ['method', 'Method'], ['configure', 'Details'], ['review', 'Review'], ['done', 'Finish']];
  var SYMBOLS = ['ABCXYZ', 'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'DEFXYZ', 'GBPJPY', 'GHIXYZ', 'USDCAD', 'USDCHF', 'AUDUSD', 'NZDUSD', 'XAUUSD', 'US30', 'NAS100', 'SPX500', 'NQ', 'ES', 'CL', 'GC', 'AAPL', 'MSFT', 'TSLA', 'NVDA', 'BTCUSD', 'ETHUSD'];
  var TRADED = { ABCXYZ: 1, DEFXYZ: 1, XAUUSD: 1 };
  var CLASSES = ['Stock', 'Option', 'Future', 'Future Option', 'Forex', 'Crypto', 'CFD'];
  var FUT = { NQ: 1, ES: 1, CL: 1, GC: 1 };
  var CFD = { US30: 1, NAS100: 1, SPX500: 1, XAUUSD: 1 };
  // Index CFDs resolve as a family with an assumed point value, so the real form asks "$ per point" (ledger bundle 493-505, 666-692).
  var INDEX_FAMILY = { US30: 1, NAS100: 1, SPX500: 1 };
  var CRYPTO = { BTCUSD: 1, ETHUSD: 1 };

  function blankRows() {
    return [{ side: 'BUY', dateTime: '', size: '', price: '', comm: '', fee: '', mult: '' }, { side: 'SELL', dateTime: '', size: '', price: '', comm: '', fee: '', mult: '' }];
  }
  var CURRENCIES = DATA.currencies;
  var state = { step: 'platform', q: '', platform: null, method: null, account: ACCOUNTS.length ? ACCOUNTS[0].id : '__new', newCurrency: '', trade: { symbol: '', assetClass: '' }, rows: blankRows(), tz: 'local', stop: '', target: '', symOpen: false, symActive: 0, touched: false, seen: {}, showErrors: false, saving: false, error: '', outcome: null, bfilter: 'all' };

  var root = document.getElementById('wizard');
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function plat() { for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].id === state.platform) return PLATFORMS[i]; return null; }
  function acct(id) { for (var i = 0; i < ACCOUNTS.length; i++) if (ACCOUNTS[i].id === id) return ACCOUNTS[i]; return null; }
  function inferred() {
    var s = String(state.trade.symbol || '').trim().toUpperCase();
    if (!s) return '';
    if (FUT[s]) return 'Future';
    if (CFD[s]) return 'CFD';
    if (CRYPTO[s]) return 'Crypto';
    if (/^(EUR|GBP|USD|JPY|CHF|AUD|NZD|CAD){2}$/.test(s)) return 'Forex';
    if (SYMBOLS.indexOf(s) > -1) return 'Stock';
    return '';
  }
  function assetClass() { var p = plat(); return state.trade.assetClass || inferred() || (p && p.cls) || 'Stock'; }
  function symbolOptions() {
    var q = String(state.trade.symbol || '').trim().toUpperCase();
    return SYMBOLS.filter(function (s) { return !q || s.indexOf(q) > -1; });
  }
  function askPV() {
    var sym = String(state.trade.symbol || '').trim().toUpperCase();
    if (!sym || (state.symOpen && symbolOptions().length > 0)) return false;
    if (INDEX_FAMILY[sym]) return true;
    var cls = assetClass();
    return cls === 'Future' || cls === 'Future Option' || (SYMBOLS.indexOf(sym) < 0 && cls !== 'Stock' && cls !== 'Forex');
  }
  function filled(r) { return Boolean(r.dateTime || r.price || r.size); }
  function validate(rows) {
    var errs = [], prev = null, lead = rows[0].side, net = 0;
    rows.forEach(function (r, i) {
      if (i > 0 && !filled(r)) return;
      if (!r.dateTime) errs.push({ row: i, field: 'dateTime', msg: 'A time is required.' });
      if (!String(r.price).trim()) errs.push({ row: i, field: 'price', msg: 'A price is required.' });
      else if (isNaN(Number(r.price))) errs.push({ row: i, field: 'price', msg: 'Price must be a number.' });
      if (!String(r.size).trim()) errs.push({ row: i, field: 'size', msg: 'A size is required.' });
      else if (!(Number(r.size) > 0)) errs.push({ row: i, field: 'size', msg: 'Size must be greater than zero.' });
      if (r.dateTime && prev && r.dateTime < prev) errs.push({ row: i, field: 'dateTime', msg: 'This fill is before the one above it.' });
      if (r.dateTime) prev = r.dateTime;
      net += (r.side === lead ? 1 : -1) * (Number(r.size) || 0);
      if (net < -1e-9) errs.push({ row: i, field: 'size', msg: 'These fills close more than they open. Check the sizes.' });
    });
    return errs;
  }
  function errorsFor(errs, i, f) { return errs.filter(function (e) { return e.row === i && e.field === f; }); }
  function shownErrors() {
    return (state.touched ? validate(state.rows) : []).filter(function (e) { return state.showErrors || state.seen[e.row + ':' + e.field]; });
  }
  function reachable(step) {
    if (step === 'platform') return true;
    if (step === 'method') return Boolean(state.platform);
    if (step === 'configure') return Boolean(state.platform && state.method);
    if (step === 'review') return reachable('configure') && state.method === 'manual' && state.touched && validate(state.rows).length === 0;
    if (step === 'done') return Boolean(state.outcome);
    return false;
  }

  function stepper() {
    var at = 0;
    STEPS.forEach(function (s, i) { if (s[0] === state.step) at = i; });
    return '<ol class="iw-steps" aria-label="Steps">' + STEPS.map(function (s, i) {
      return '<li' + (i === at ? ' aria-current="step"' : '') + '>' + (i + 1) + ' ' + s[1] + '</li>';
    }).join('') + '</ol>';
  }

  function stepPlatform() {
    var q = state.q.toLowerCase();
    var plats = PLATFORMS.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) > -1; });
    var providers = PROVIDERS_LIST.filter(function (b) { return !q || b[0].toLowerCase().indexOf(q) > -1; });
    var connects = function (methods) { return methods.indexOf('sync') > -1; };
    var all = plats.length + providers.length;
    var now = plats.filter(function (p) { return connects(p.methods); }).length + providers.filter(function (b) { return connects(platById(b[1]).methods); }).length;
    if (state.bfilter === 'now') { plats = plats.filter(function (p) { return connects(p.methods); }); providers = providers.filter(function (b) { return connects(platById(b[1]).methods); }); }
    if (state.bfilter === 'file') { plats = plats.filter(function (p) { return !connects(p.methods); }); providers = providers.filter(function (b) { return !connects(platById(b[1]).methods); }); }
    var fbtn = function (id, words) { return '<button type="button" class="ctl" data-act="bfilter" data-value="' + id + '" aria-pressed="' + (state.bfilter === id) + '">' + words + '</button>'; };
    return '<header class="iw-head"><h1>Where are your trades?</h1><p>Pick the platform or provider. Each one says how its trades can come in.</p></header>' +
      '<label class="sr-only" for="pq">Search platforms, providers and ledgers</label>' +
      '<input class="input" id="pq" type="search" placeholder="Search platform, provider or ledger…" value="' + esc(state.q) + '">' +
      (q ? '' : '<section class="iw-ledgers"><h2 style="font-size:14px;margin:16px 0 6px">Migrating from another ledger?</h2><div class="iw-tiles" style="grid-template-columns:repeat(5,1fr)">' +
        LEDGERS.map(function (j) { return '<button type="button" class="iw-tile is-ledger" style="min-height:64px" data-act="ledger" data-value="' + esc(j) + '"><b>' + esc(j) + '</b><span class="note">File upload</span></button>'; }).join('') + '</div></section>') +
      '<h2 style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#5b6472;margin:8px 0">' + all + ' platforms and providers</h2>' +
      '<div role="group" aria-label="Show" style="display:flex;gap:6px">' + fbtn('all', 'All ' + all) + fbtn('now', 'Connects now ' + now) + fbtn('file', 'File upload ' + (all - now)) + '</div>' +
      '<div class="iw-tiles">' + plats.map(function (p) {
        return '<button type="button" class="iw-tile is-platform" data-act="platform" data-value="' + p.id + '" aria-pressed="' + (state.platform === p.id) + '"><b>' + esc(p.name) + '</b><span class="badge">' + esc(p.badge) + '</span><span class="note">' + esc(p.note) + '</span></button>';
      }).join('') + providers.map(function (b) {
        var p = platById(b[1]);
        return '<button type="button" class="iw-tile is-provider" data-act="provider" data-platform="' + p.id + '"><b>' + esc(b[0]) + '</b><span class="badge">' + esc(p.name) + '</span><span class="note">Through ' + esc(p.name) + '.</span></button>';
      }).join('') + '</div>' +
      (plats.length + providers.length === 0 ? '<p>Nothing matches. Pick "Something else" to upload a file or type the trade in.</p>' : '');
  }
  function platById(id) { for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].id === id) return PLATFORMS[i]; return PLATFORMS[8]; }

  function stepMethod() {
    var p = plat();
    var order = p.methods.filter(function (m) { return m !== 'sync'; }).concat(p.methods.indexOf('sync') > -1 ? ['sync'] : []);
    return backlink('platform', 'Back to platform') + '<header class="iw-head"><h1>How would you like to add them?</h1><p>' + esc(p.name) + ' supports ' + (p.methods.length === 3 ? 'all three routes' : 'file upload and manual entry') + '. The connection is the one you set up once.</p></header>' +
      '<div class="iw-methods-grid">' + order.map(function (id) {
        var m = METHOD[id];
        return '<button type="button" class="iw-method" data-act="method" data-value="' + id + '" aria-pressed="' + (state.method === id) + '">' +
          (id === 'sync' ? '<span class="pill">Pro</span>' : '') + '<b>' + esc(m.name) + '</b><span>' + esc(m.what) + '</span>' +
          '<dl><div><dt>Suits</dt><dd>' + esc(m.who) + '</dd></div><div><dt>Effort</dt><dd>' + esc(m.effort) + '</dd></div><div><dt>Cadence</dt><dd>' + esc(m.cadence) + '</dd></div></dl></button>';
      }).join('') + '</div>';
  }

  function backlink(step, words) { return '<button type="button" class="iw-backlink" data-act="goto" data-value="' + step + '">‹ ' + words + '</button>'; }

  function newAccountCurrencyField() {
    return '<div class="iw-field"><label for="iwNewCurrency">New account currency<i aria-hidden="true">*</i></label><select class="sel" id="iwNewCurrency" data-act="new-currency" required>' +
      '<option value="">Choose the currency your provider reports P&amp;L in</option>' +
      CURRENCIES.map(function (c) { return '<option value="' + c + '"' + (state.newCurrency === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') +
      '</select><span class="iw-hint" style="font-size:12px;color:#5b6472">This labels imported amounts; it does not convert them.</span></div>';
  }
  // As the real destinationField (IB:5289-5325): no account, one account, or a choice of two or more.
  function destinationField() {
    if (!ACCOUNTS.length) {
      var p = plat();
      return '<div class="iw-field"><span class="iw-lab">Account</span><b class="iw-dest-fixed">A new ' + esc(p ? p.name + ' ' : '') + 'account</b><span class="iw-hint" style="font-size:12px;color:#5b6472">Created when you save this trade.</span></div>' + newAccountCurrencyField();
    }
    if (ACCOUNTS.length === 1) return '<div class="iw-field"><span class="iw-lab">Account</span><b class="iw-dest-fixed">' + esc(ACCOUNTS[0].label) + '</b></div>';
    return '<div class="iw-field"><label for="dest">Account<i aria-hidden="true">*</i></label><select class="sel" id="dest" data-act="account">' +
      ACCOUNTS.map(function (a) { return '<option value="' + a.id + '"' + (a.id === state.account ? ' selected' : '') + '>' + esc(a.label) + '</option>'; }).join('') +
      '<option value="__new"' + (state.account === '__new' ? ' selected' : '') + '>Create a new account…</option></select>' +
      (state.account === '__new' ? '<span class="iw-hint" style="font-size:12px;color:#5b6472">A new account will be created.</span>' : '') + '</div>' +
      (state.account === '__new' ? newAccountCurrencyField() : '');
  }
  function symbolField() {
    var opts = state.symOpen ? symbolOptions().slice(0, 60) : [];
    var act = Math.max(0, Math.min(state.symActive || 0, opts.length - 1));
    var open = opts.length > 0;
    return '<div class="iw-field iw-combo"><label for="f-symbol">Symbol<i aria-hidden="true">*</i></label>' +
      '<input class="input" id="f-symbol" type="text" data-field="symbol" role="combobox" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="symList" aria-expanded="' + open + '"' + (open ? ' aria-activedescendant="sym-' + act + '"' : '') + ' value="' + esc(state.trade.symbol) + '" placeholder="e.g. ABCXYZ, NQ, AAPL">' +
      (open ? '<ul class="iw-combo-list" id="symList" role="listbox" aria-label="Symbols">' + opts.map(function (s, i) {
        return '<li id="sym-' + i + '" role="option" aria-selected="' + (i === act) + '" data-act="pick-symbol" data-value="' + esc(s) + '">' + esc(s) + (TRADED[s] ? '<span>traded</span>' : '') + '</li>';
      }).join('') + '</ul>' : '') + '</div>';
  }
  function classField() {
    var picked = assetClass();
    var from = inferred() && !state.trade.assetClass ? 'From ' + esc(String(state.trade.symbol).toUpperCase()) : '';
    return '<div class="iw-field"><label for="f-assetClass">Asset class<i aria-hidden="true">*</i></label><select class="sel" id="f-assetClass" data-field="assetClass">' +
      CLASSES.map(function (c) { return '<option' + (c === picked ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      (from ? '<span class="iw-hint" style="font-size:12px;color:#5b6472">' + from + '</span>' : '') + '</div>';
  }
  function directionField() {
    var d = state.rows[0].side === 'SELL' ? 'short' : 'long';
    return '<div class="iw-field"><span class="iw-lab">Direction<i aria-hidden="true">*</i></span><div class="seg iw-dir" role="group" aria-label="Direction">' +
      [['long', 'Long'], ['short', 'Short']].map(function (o) { return '<button type="button" data-act="dir" data-value="' + o[0] + '" aria-pressed="' + (d === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div></div>';
  }
  function fillsBlock(errs) {
    var cls = assetClass(), pv = askPV(), sizeLabel = cls === 'Forex' ? 'Lot size' : 'Contracts';
    var lead = state.rows[0].side, net = 0;
    state.rows.forEach(function (r) { net += (r.side === lead ? 1 : -1) * (Number(r.size) || 0); });
    function cell(r, i, key, type) {
      var e = errorsFor(errs, i, key), id = 'fl-' + key + '-' + i;
      return '<td' + (e.length ? ' class="has-error"' : '') + '><label class="sr-only" for="' + id + '">' + key + ' for fill ' + (i + 1) + '</label>' +
        '<input class="input" id="' + id + '" type="' + type + '" value="' + esc(r[key]) + '" data-fill="' + i + '" data-field="' + key + '"' + (e.length ? ' aria-invalid="true"' : '') + '>' +
        (e.length ? '<span class="iw-err">' + esc(e[0].msg) + '</span>' : '') + '</td>';
    }
    var tz = [['local', 'My local time'], ['utc', 'UTC'], ['utc+1', 'UTC+1'], ['utc+2', 'UTC+2 (most PX5 servers)'], ['utc+3', 'UTC+3'], ['utc-5', 'UTC-5 (New York)'], ['utc-6', 'UTC-6 (Chicago)']];
    return '<section class="iw-block"><header><h2>What happened</h2><div class="iw-tz"><label for="iwTz">I’m typing times in</label><select class="sel" style="width:auto" id="iwTz" data-act="tz">' +
      tz.map(function (t) { return '<option value="' + t[0] + '"' + (state.tz === t[0] ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('') + '</select></div></header>' +
      '<div class="iw-tablewrap"><table class="iw-fills"><thead><tr><th></th><th>Side</th><th>Date and time</th>' + (pv ? '<th>$ per point</th>' : '') + '<th>' + sizeLabel + '</th><th>Price</th><th>Comm.</th><th>Fee</th><th></th></tr></thead><tbody>' +
      state.rows.map(function (r, i) {
        var role = i === 0 ? 'Entry' : (r.side === lead ? 'Add' : 'Exit');
        return '<tr><td>' + role + '</td><td><div class="seg" role="group" aria-label="Side for fill ' + (i + 1) + '">' +
          ['BUY', 'SELL'].map(function (s) { return '<button type="button" data-act="fill-side" data-value="' + i + ':' + s + '" aria-pressed="' + (r.side === s) + '">' + s + '</button>'; }).join('') + '</div></td>' +
          cell(r, i, 'dateTime', 'datetime-local') + (pv ? cell(r, i, 'mult', 'text') : '') + cell(r, i, 'size', 'text') + cell(r, i, 'price', 'text') + cell(r, i, 'comm', 'text') + cell(r, i, 'fee', 'text') +
          '<td>' + (i >= 2 ? '<button type="button" class="ctl" data-act="remove-fill" data-value="' + i + '">Remove</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:6px"><button type="button" class="ctl" data-act="add-fill">+ Add another fill</button><span>' + (Math.abs(net) < 1e-9 ? 'Position closed' : (Math.round(net * 1000) / 1000) + ' still open') + '</span></div></section>';
  }
  function planBlock() {
    return '<section class="iw-block"><header><h2>Stop loss and take profit</h2></header><div class="iw-fields">' +
      '<div class="iw-field"><label for="f-stop-0">Stop loss</label><input class="input" id="f-stop-0" type="text" data-row="0" data-field="stop" value="' + esc(state.stop) + '"></div>' +
      '<div class="iw-field"><label for="f-target-0">Take profit</label><input class="input" id="f-target-0" type="text" data-row="0" data-field="target" value="' + esc(state.target) + '"></div></div></section>';
  }
  function stepManual() {
    var errs = shownErrors();
    var all = state.touched ? validate(state.rows) : [];
    return backlink('method', 'Back to method') + '<header class="iw-head"><h1>Enter the trade</h1><p>One trade, with each fill. Times are in the zone you pick below.</p></header>' +
      (state.showErrors && all.length ? '<div class="iw-note bad">' + all.length + ' field' + (all.length > 1 ? 's need' : ' needs') + ' attention. Each is marked against the field it belongs to.</div>' : '') +
      '<section class="iw-block"><header><h2>The trade</h2></header><div class="iw-fields">' + destinationField() + symbolField() + classField() + directionField() + '</div></section>' +
      fillsBlock(errs) + planBlock();
  }
  function stepFile() {
    return backlink(state.method ? 'method' : 'platform', 'Back') + '<header class="iw-head"><h1>Upload your file</h1><p>Export your history and drop the file here.</p></header>' +
      '<label class="iw-block" style="display:block">Trades file <input type="file" id="iwFile" accept=".csv,.xlsx,.html"></label>';
  }
  function stepSync() {
    return backlink('method', 'Back to method') + '<header class="iw-head"><h1>Part of Pro</h1><p>Connecting the platform is part of Pro. File upload and manual entry are free.</p></header>';
  }
  function fillsSummary() {
    return '<table aria-label="Fills"><thead><tr><th>Side</th><th>Date and time</th><th>Size</th><th>Price</th></tr></thead><tbody>' +
      state.rows.filter(function (r, i) { return i === 0 || filled(r); }).map(function (r) {
        return '<tr><td>' + r.side + '</td><td>' + esc(r.dateTime.replace('T', ' ')) + '</td><td>' + esc(r.size) + '</td><td>' + esc(r.price) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function stepReview() {
    if (state.saving) return '<div class="iw-final" role="status"><h1>Saving your trade</h1><p>Writing it to your record. This takes a moment.</p></div>';
    var a = acct(state.account), p = plat();
    var dir = state.rows[0].side === 'SELL' ? 'Short' : 'Long';
    var cls = assetClass();
    return backlink('configure', 'Back to the trade') + '<header class="iw-head"><h1>Check your trade</h1><p>Nothing is saved until you press Save trade.</p></header>' +
      (state.error ? '<div class="iw-note bad" role="alert"><b>Nothing was saved.</b> ' + esc(state.error) + '</div>' : '') +
      '<section class="iw-block"><h2>' + esc(String(state.trade.symbol).toUpperCase() || 'No symbol') + '<span class="pill">' + dir + '</span><span class="pill">' + esc(cls) + '</span> <button type="button" class="ctl" data-act="goto" data-value="configure">Edit</button></h2>' +
      '<p>' + esc(state.rows[0].size) + ' ' + (cls === 'Forex' ? 'lots' : 'contracts') + ' · into ' + esc(a ? a.label : 'a new account') + ' · ' + esc(p ? p.name : '') + '</p>' + fillsSummary() + '</section>' +
      (state.stop ? '<p>Stop loss ' + esc(state.stop) + (state.target ? ' · Take profit ' + esc(state.target) : '') + '</p>' : '<div class="iw-note warn">No stop loss. <button type="button" class="ctl" data-act="goto" data-value="configure">Add one</button></div>');
  }
  function stepDone() {
    var o = state.outcome;
    return '<div class="iw-final ok iw-done" role="status"><h1>' + esc(o.symbol) + ' saved</h1><p>' + esc(o.recap) + '</p>' +
      '<p>It is in your record under <b>' + esc(o.account) + '</b> and on the calendar.</p>' +
      '<div class="row"><a class="btn pri" href="' + BASE + 'trade/' + esc(o.id) + '">Open the trade</a><button type="button" class="btn" data-act="add-another">Add another trade</button><a class="btn" href="' + BASE + 'trades">All trades</a></div></div>';
  }
  function body() {
    if (state.step === 'platform') return stepPlatform();
    if (state.step === 'method') return stepMethod();
    if (state.step === 'configure') return state.method === 'manual' ? stepManual() : state.method === 'sync' ? stepSync() : stepFile();
    if (state.step === 'review') return stepReview();
    return stepDone();
  }
  function actions() {
    var s = state.step;
    if (s === 'done') return '';
    var gate = '', next = '';
    if (s === 'platform') gate = 'Pick where your trades are.';
    if (s === 'method') gate = 'Pick how to add them.';
    if (s === 'configure' && state.method === 'manual') {
      var n = validate(state.rows).length, blocked = !state.touched || n > 0;
      gate = blocked ? (state.showErrors && n ? n + ' field' + (n > 1 ? 's' : '') + ' still to fix.' : 'Fill in the trade to continue.') : 'Ready to check.';
      next = '<button type="button" class="btn pri" data-act="next"' + (blocked ? ' aria-describedby="iwGate"' : '') + '>Continue</button>';
    } else if (s === 'configure') {
      gate = state.method === 'sync' ? 'Upgrade to connect.' : 'Choose a file to continue.';
      next = '<button type="button" class="btn pri" data-act="next" aria-describedby="iwGate">Continue</button>';
    }
    if (s === 'review') next = '<button type="button" class="btn pri" data-act="save"' + (state.saving ? ' disabled aria-busy="true"' : '') + '>Save trade</button>';
    return (s !== 'platform' ? '<button type="button" class="btn" data-act="back">Back</button>' : '') + '<a href="' + BASE + 'trades" class="iw-cancel">Cancel</a><span class="grow"></span>' +
      (gate ? '<span class="iw-gate" role="status" id="iwGate">' + gate + '</span>' : '') + next;
  }

  var shellDone = false, rendering = false;
  function render() {
    rendering = true;
    try { paint(); } finally { rendering = false; }
  }
  function paint() {
    var el = document.activeElement, id = el && el.id, sel = null;
    try { if (el && el.selectionStart != null) sel = [el.selectionStart, el.selectionEnd]; } catch (e) { sel = null; }
    var bodyEl = document.getElementById('iwBody'), top = bodyEl ? bodyEl.scrollTop : 0;
    if (!shellDone) { root.innerHTML = '<div id="iwStepper"></div><div id="iwBody" data-scroll="intended"></div><div id="iwActions"></div>'; shellDone = true; }
    document.getElementById('iwStepper').innerHTML = stepper();
    document.getElementById('iwBody').innerHTML = body();
    document.getElementById('iwActions').innerHTML = actions();
    document.getElementById('iwBody').scrollTop = top;
    if (id) {
      var again = document.getElementById(id);
      if (again && again !== el) {
        again.focus({ preventScroll: true });
        try { if (sel) again.setSelectionRange(sel[0], sel[1]); } catch (e) { /* datetime-local has no caret */ }
      }
    }
  }
  function go(step, replace) {
    if (step !== state.step) document.getElementById('iwBody') && (document.getElementById('iwBody').scrollTop = 0);
    state.step = step;
    var url = BASE + 'import/' + step;
    if (replace) history.replaceState({ step: step }, '', url); else history.pushState({ step: step }, '', url);
    render();
    var b = document.getElementById('iwBody'); if (b) b.scrollTop = 0;
  }
  function closeSym() { if (state.symOpen) { state.symOpen = false; render(); } }
  function pickSymbol(s) { state.trade.symbol = s; state.symOpen = false; state.touched = true; }

  root.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    var act = t.getAttribute('data-act'), v = t.getAttribute('data-value');
    if (t.tagName === 'SELECT') return;
    if (act === 'platform') { state.platform = v; state.method = null; return go('method'); }
    if (act === 'provider') { state.platform = t.getAttribute('data-platform'); state.method = null; return go('method'); }
    if (act === 'ledger') { state.platform = 'other'; state.method = 'file'; return go('configure'); }
    if (act === 'bfilter') { state.bfilter = v; return render(); }
    if (act === 'method') { state.method = v; return go('configure'); }
    if (act === 'goto') { if (reachable(v)) go(v); return; }
    if (act === 'back') {
      var order = ['platform', 'method', 'configure', 'review'], i = order.indexOf(state.step);
      if (state.step === 'configure' && state.method === 'file' && LEDGERS.length && !state.method) i = 1;
      if (i > 0) go(order[i - 1]);
      return;
    }
    if (act === 'pick-symbol') { pickSymbol(v); return render(); }
    if (act === 'dir') {
      var want = v === 'short' ? 'SELL' : 'BUY';
      if (state.rows[0].side !== want) state.rows.forEach(function (r) { r.side = r.side === 'BUY' ? 'SELL' : 'BUY'; });
      state.touched = true; return render();
    }
    if (act === 'fill-side') { var p = v.split(':'); state.rows[Number(p[0])].side = p[1]; state.touched = true; return render(); }
    if (act === 'add-fill') { state.rows.push({ side: state.rows[0].side === 'BUY' ? 'SELL' : 'BUY', dateTime: '', size: '', price: '', comm: '', fee: '', mult: '' }); return render(); }
    if (act === 'remove-fill') { state.rows.splice(Number(v), 1); return render(); }
    if (act === 'next') {
      if (state.step !== 'configure' || state.method !== 'manual') return;
      if (!state.touched || validate(state.rows).length) { state.touched = true; state.showErrors = true; return render(); }
      state.error = '';
      return go('review');
    }
    if (act === 'save') return save();
    if (act === 'add-another') {
      state.trade = { symbol: '', assetClass: '' }; state.rows = blankRows(); state.stop = ''; state.target = ''; state.touched = false; state.seen = {}; state.showErrors = false; state.outcome = null; state.error = '';
      return go('configure');
    }
  });
  root.addEventListener('mousedown', function (ev) {
    if (state.symOpen && !ev.target.closest('.iw-combo')) setTimeout(closeSym, 0);
  });
  root.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'pq') { state.q = t.value; return render(); }
    if (t.hasAttribute('data-fill')) { state.rows[Number(t.getAttribute('data-fill'))][t.getAttribute('data-field')] = t.value; state.touched = true; return render(); }
    var f = t.getAttribute('data-field');
    if (f === 'symbol') {
      state.trade.symbol = t.value; state.touched = true; state.symOpen = true; state.symActive = 0;
      var opts = symbolOptions(), up = t.value.trim().toUpperCase();
      if (opts.length === 1 && opts[0] === up) state.symOpen = false;
      return render();
    }
    if (f === 'stop' || f === 'target') { state[f] = t.value; return render(); }
  });
  root.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.id === 'dest') { state.account = t.value; return render(); }
    if (t.id === 'iwNewCurrency') { state.newCurrency = t.value; return render(); }
    if (t.id === 'f-assetClass') { state.trade.assetClass = t.value; state.touched = true; return render(); }
    if (t.id === 'iwTz') { state.tz = t.value; return render(); }
  });
  root.addEventListener('focusin', function (ev) {
    if (rendering) return;
    if (ev.target.id === 'f-symbol' && !state.symOpen) { state.symOpen = true; state.symActive = 0; render(); }
  });
  root.addEventListener('focusout', function (ev) {
    if (rendering) return;
    var t = ev.target;
    if (!t.isConnected) return;
    if (t.hasAttribute && t.hasAttribute('data-fill')) { state.seen[t.getAttribute('data-fill') + ':' + t.getAttribute('data-field')] = true; setTimeout(render, 0); }
  });
  root.addEventListener('keydown', function (ev) {
    if (ev.target.id !== 'f-symbol') return;
    var opts = state.symOpen ? symbolOptions() : [];
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!state.symOpen) state.symOpen = true; else state.symActive = Math.min(opts.length - 1, state.symActive + 1); return render(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); state.symActive = Math.max(0, state.symActive - 1); return render(); }
    if (ev.key === 'Enter') { ev.preventDefault(); if (opts.length) { pickSymbol(opts[Math.min(state.symActive, opts.length - 1)]); render(); } return; }
    if (ev.key === 'Escape') { ev.preventDefault(); return closeSym(); }
    if (ev.key === 'Tab') { setTimeout(closeSym, 0); }
  });
  window.addEventListener('beforeunload', function (ev) {
    if (state.touched && state.step !== 'done' && !state.saving) { ev.preventDefault(); ev.returnValue = ''; }
  });
  window.addEventListener('popstate', function () {
    var m = /\/import\/(\w+)/.exec(location.pathname), s = m ? m[1] : 'platform';
    state.step = reachable(s) ? s : 'platform';
    render();
  });

  function save() {
    if (BROKEN) return;
    if (state.saving) return;
    var sym = String(state.trade.symbol || '').trim().toUpperCase();
    if (!sym) { state.error = 'Enter the instrument before saving.'; return render(); }
    if (askPV() && state.rows.some(function (r, i) { return (i === 0 || filled(r)) && !String(r.mult).trim(); })) {
      state.error = 'We do not know what a point of ' + sym + ' is worth. Fill in "$ per point" for each fill.'; return render();
    }
    state.saving = true; state.error = ''; render();
    fetch(BASE + 'api/trades', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      account: state.account, newCurrency: state.newCurrency, platform: state.platform, symbol: sym, assetClass: assetClass(), tz: state.tz, stop: state.stop, target: state.target,
      fills: state.rows.filter(function (r, i) { return i === 0 || filled(r); })
    }) }).then(function (r) { return r.json(); }).then(function (res) {
      state.saving = false;
      if (!res.ok) { state.error = res.error; return render(); }
      state.outcome = res; state.touched = false;
      go('done');
    }, function () { state.saving = false; state.error = 'The connection dropped. Try again.'; render(); });
  }

  // Where to start: /import?platform=…&method=manual opens the form; the step in the address is clamped.
  var qs = new URLSearchParams(location.search);
  if (qs.get('platform') && platById(qs.get('platform')).id === qs.get('platform')) state.platform = qs.get('platform');
  if (state.platform && /^(manual|file|sync)$/.test(qs.get('method') || '') && plat().methods.indexOf(qs.get('method')) > -1) state.method = qs.get('method');
  var asked = (/\/import\/(\w+)/.exec(location.pathname) || [])[1];
  var start = state.method ? 'configure' : state.platform ? 'method' : 'platform';
  if (asked && reachable(asked)) start = asked;
  go(start, true);
})();
`;

function wizardPage(prefix: string, broken: boolean, accounts: readonly Account[]): string {
  const data = JSON.stringify({ accounts: accounts.map(({ id, label }) => ({ id, label })), currencies: CURRENCIES }).replace(/</g, "\\u003c");
  return shell(prefix, "import", "Add trades", "Manually, from a file, or by connecting the platform",
    `<div class="iw" id="wizard"></div>`,
    `<script type="application/json" id="si-data">${data}</script><script>document.body.setAttribute('data-broken','${broken ? "1" : "0"}');</script><script>${WIZARD_JS}</script>`);
}

const SEED: readonly Omit<SiTrade, "id">[] = [
  { date: "2026-11-12", symbol: "ABCXYZ", assetClass: "Forex", direction: "Long", size: "0.5", entry: "1.0712", exit: "1.0748", pnl: "+$180.00", account: ACCOUNTS[0]!.label },
  { date: "2026-11-14", symbol: "DEFXYZ", assetClass: "Forex", direction: "Short", size: "0.2", entry: "1.2690", exit: "1.2655", pnl: "+$70.00", account: ACCOUNTS[0]!.label },
  { date: "2026-11-17", symbol: "XAUUSD", assetClass: "CFD", direction: "Long", size: "0.1", entry: "2391.50", exit: "2385.20", pnl: "-$63.00", account: ACCOUNTS[1]!.label },
];

interface Fill {
  side?: string;
  dateTime?: string;
  size?: string;
  price?: string;
  mult?: string;
}

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;

/** The ledger: its pages, its API, and the trades it holds. `prefix`: "/si/" or "/sib/" (saving broken). */
export function siApp(prefix: string, broken: boolean, o: { lockedFirst?: boolean; accounts?: readonly Account[]; needsExit?: boolean } = {}) {
  // The real form pins the first account (accountId IB:5021-5039), which may be a verified one.
  const base = o.accounts ?? ACCOUNTS;
  const accounts: Account[] = o.lockedFirst ? [...base].sort((a, b) => Number(b.locked) - Number(a.locked)) : [...base];
  let n = 0;
  const trades: SiTrade[] = SEED.map((t) => ({ ...t, id: `T-${(1000 + n++).toString(16)}` }));

  /** A save, checked as the real one is; on success the trade is recorded and `note` logs it. */
  function record(body: Record<string, unknown>, note: (path: string) => void): { ok: true; id: string; symbol: string; account: string; recap: string } | { ok: false; error: string } {
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    if (!symbol) return { ok: false, error: "Enter the instrument before saving." };
    const fills = (Array.isArray(body.fills) ? body.fills : []) as Fill[];
    const priced = fills.filter((f) => f.dateTime && f.price && !Number.isNaN(Number(f.price)));
    if (!priced.length) return { ok: false, error: "Enter at least one fill with a time and a price." };
    // As saveManual (importBridge.ts:163-230): a new account is created first; an existing one is checked.
    let account: Account | undefined;
    let created = false;
    if (body.account === "__new") {
      const currency = String(body.newCurrency ?? "");
      if (!CURRENCIES.includes(currency)) return { ok: false, error: "Choose the actual currency of the new account before saving." };
      account = { id: `acc-new-${accounts.length + 1}`, label: "Manual · My account", locked: false };
      created = true;
    } else {
      account = accounts.find((a) => a.id === body.account);
      if (!account) return { ok: false, error: "That account is not on your record — pick another one." };
      if (account.locked) return { ok: false, error: LOCKED };
    }
    // FIXTURE-ONLY (/si2/): Sam's rule that a trade has two executions; the real app accepts an open position.
    const lead0 = priced[0]!.side === "SELL" ? "SELL" : "BUY";
    if (o.needsExit && !priced.some((f) => f.side !== lead0)) return { ok: false, error: NEEDS_EXIT };
    if (created) {
      accounts.push(account);
      note(`${prefix}ledger/account-created?currency=${encodeURIComponent(String(body.newCurrency))}`);
    }
    const first = priced[0]!;
    if (!(Number(first.size) > 0)) return { ok: false, error: "This trade has no size. Fill in the size of the first fill." };
    const lead = first.side === "SELL" ? "SELL" : "BUY";
    const exit = priced.find((f) => f.side !== lead);
    const cls = String(body.assetClass ?? "Stock");
    const size = Number(first.size);
    const unit = cls === "Forex" ? 100000 : Number(first.mult) || 1;
    const pnl = exit ? (Number(exit.price) - Number(first.price)) * (lead === "BUY" ? 1 : -1) * size * unit : undefined;
    const t: SiTrade = {
      id: `T-${(1000 + n++).toString(16)}`,
      date: String(first.dateTime).slice(0, 10),
      symbol,
      assetClass: cls,
      direction: lead === "BUY" ? "Long" : "Short",
      size: String(first.size),
      entry: String(first.price),
      exit: exit ? String(exit.price) : "",
      pnl: pnl === undefined ? "Open" : money(pnl),
      account: account.label,
    };
    trades.push(t);
    note(`${prefix}ledger/saved?symbol=${encodeURIComponent(symbol)}&side=${lead}&size=${encodeURIComponent(t.size)}&price=${encodeURIComponent(t.entry)}&account=${encodeURIComponent(account.id)}`);
    // A closed trade (an entry and an exit fill): the oracle of a task whose goal means a whole trade.
    if (exit) note(`${prefix}ledger/closed?symbol=${encodeURIComponent(symbol)}&fills=${priced.length}&exit=${encodeURIComponent(t.exit)}`);
    return { ok: true, id: t.id, symbol, account: account.label, recap: `${t.direction} ${t.size} ${cls === "Forex" ? "lots" : "contracts"} · ${t.pnl}` };
  }

  /** Answers a request under the prefix (true), or leaves it (false). `note` adds a line to the site's log. */
  function handle(req: IncomingMessage, res: ServerResponse, url: URL, note: (path: string) => void): boolean {
    const p = url.pathname;
    if (!p.startsWith(prefix) && p !== prefix.slice(0, -1)) return false;
    const rest = p.slice(prefix.length);
    const html = (content: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(content);
    if (rest === "" || rest === "brief") return html(brief(prefix, trades)), true;
    if (rest === "trades") return html(tradesPage(prefix, trades)), true;
    if (rest === "import" || rest === "import/" || /^import\/(platform|method|configure|review|done)$/.test(rest)) return html(wizardPage(prefix, broken, accounts)), true;
    const one = /^trade\/(T-[0-9a-f]+)$/.exec(rest);
    if (one) {
      const t = trades.find((x) => x.id === one[1]);
      if (t) return html(tradePage(prefix, t)), true;
    }
    if (rest === "api/trades" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // an empty body is refused below
        }
        const out = record(body, note);
        // "Writing it to your record. This takes a moment."
        setTimeout(() => res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out)), 600);
      });
      return true;
    }
    if (["calendar", "insights", "settings"].includes(rest)) return html(shell(prefix, "other", rest[0]!.toUpperCase() + rest.slice(1), "", `<main class="content"><p>Nothing here in the fixture.</p></main>`)), true;
    return false;
  }
  return { prefix, handle, trades: () => [...trades] };
}
