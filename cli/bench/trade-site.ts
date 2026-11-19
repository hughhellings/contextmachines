/**
 * A trade ledger on the fixture site (bench/site.ts), for the false pass seen on a real signed-in app
 * (2026-11-18): the goal "add a trade, a manual trade, any entry", a step checked by the word "Manual",
 * and an "Add trade" button that opens an import wizard whose subtitle already says "Manually, from a
 * file or by connecting the platform". One click made the check hold; nothing was filled or saved,
 * and the test passed.
 *
 * Two ledgers, the same pages under two prefixes:
 *   /tj/   saving works: the manual form's "Save trade" sends it, and the trades list says "Trade saved"
 *          with the new row in it (the save is logged as /tj/trades/save?…, so a bench sees it happen);
 *   /tjb/  saving is broken: "Save trade" does nothing at all, so the goal can't be done.
 *
 * No AI, no network. Served by the fixture site, so its request log is the bench's right answer.
 */

export interface Trade {
  symbol: string;
  side: string;
  quantity: string;
  price: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const doc = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — Fixture Ledger</title><style>body{font-family:sans-serif;margin:0}nav{display:flex;gap:16px;padding:12px;border-bottom:1px solid #ccc}main{padding:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}.tabs a{margin-right:12px}label{display:block;margin:8px 0}.ok{background:#e6ffe6;border:1px solid #6c6;padding:8px;margin-bottom:12px}</style></head><body>${body}</body></html>`;

const nav = (p: string) => `<nav aria-label="Main"><a href="${p}">Fixture Ledger</a><a href="${p}brief">Brief</a><a href="${p}trades">Trades</a><a href="${p}settings">Settings</a></nav>`;

const SUBTITLE = "Manually, from a file or by connecting the platform";

const wizard = (p: string, tab: "platform" | "file" | "manual", inner: string) => `${nav(p)}<main><h1>Add trades</h1><p>${SUBTITLE}</p>
<div class="tabs" role="navigation" aria-label="How to add trades">
<a href="${p}import/platform"${tab === "platform" ? ' aria-current="page"' : ""}>Connect platform</a>
<a href="${p}import/file"${tab === "file" ? ' aria-current="page"' : ""}>Upload file</a>
<a href="${p}import/manual"${tab === "manual" ? ' aria-current="page"' : ""}>Manual entry</a>
</div>${inner}</main>`;

const PLATFORM = `<h2>Choose your platform</h2><p>Pick the platform your trades are on.</p><ul><li>MetaTrader 5</li><li>cTrader</li><li>Interactive Providers</li></ul><p>Connecting needs a platform account.</p>`;
const FILE = `<h2>Upload a file</h2><p>CSV exports from most platforms work.</p><input type="file" aria-label="Trades file" accept=".csv">`;

/** The manual form: sends a GET to <prefix>trades/save, or (broken) a "Save trade" button that does nothing. */
const manual = (p: string, broken: boolean) => `<h2>Enter a trade</h2>
<form ${broken ? 'onsubmit="return false"' : `method="get" action="${p}trades/save"`}>
<label>Symbol <input name="symbol" required autocomplete="off"></label>
<label>Side <select name="side"><option>Long</option><option>Short</option></select></label>
<label>Quantity <input name="quantity" type="number" min="0" step="any" required></label>
<label>Entry price <input name="price" type="number" min="0" step="any" required></label>
<button ${broken ? 'type="button"' : 'type="submit"'}>Save trade</button>
</form>`;

const tradesPage = (p: string, trades: readonly Trade[], saved: boolean) => doc("Trades", `${nav(p)}<main>
${saved ? '<div class="ok" role="status">Trade saved <button type="button" onclick="this.parentNode.remove()">OK</button></div>' : ""}
<h1>Trades</h1>
<button type="button" onclick="location.href='${p}import'">Add trade</button>
<table aria-label="Your trades"><thead><tr><th>Symbol</th><th>Side</th><th>Quantity</th><th>Entry</th></tr></thead><tbody>
${trades.map((t) => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.side)}</td><td>${esc(t.quantity)}</td><td>${esc(t.price)}</td></tr>`).join("\n")}
</tbody></table></main>`);

const BRIEF = (p: string) => doc("Brief", `${nav(p)}<main><h1>Your brief</h1><p>Good morning. Markets open in 2 hours.</p><section aria-label="Today"><h2>Today</h2><p>No trades yet today.</p></section></main>`);

/** What the ledger answers: a page, a redirect, or nothing (not a ledger address). */
export type LedgerAnswer = { html: string } | { redirect: string } | undefined;

/** A ledger's pages and its saved trades. `prefix`: "/tj/" or "/tjb/" (broken saving). */
export function ledger(prefix: string, broken: boolean) {
  const trades: Trade[] = [{ symbol: "MSFT", side: "Long", quantity: "5", price: "410.00" }];
  const answer = (path: string, q: URLSearchParams): LedgerAnswer => {
    if (!path.startsWith(prefix)) return undefined;
    const rest = path.slice(prefix.length);
    if (rest === "" || rest === "brief") return { html: BRIEF(prefix) };
    if (rest === "trades") return { html: tradesPage(prefix, trades, q.get("saved") === "1") };
    if (rest === "import") return { redirect: `${prefix}import/platform` };
    if (rest === "import/platform") return { html: doc("Add trades", wizard(prefix, "platform", PLATFORM)) };
    if (rest === "import/file") return { html: doc("Add trades", wizard(prefix, "file", FILE)) };
    if (rest === "import/manual") return { html: doc("Add trades", wizard(prefix, "manual", manual(prefix, broken))) };
    if (rest === "trades/save" && !broken) {
      const t = { symbol: q.get("symbol") ?? "", side: q.get("side") ?? "", quantity: q.get("quantity") ?? "", price: q.get("price") ?? "" };
      if (!t.symbol.trim() || !t.quantity.trim() || !t.price.trim()) return { html: doc("Add trades", wizard(prefix, "manual", `<p role="alert">Fill in every field.</p>${manual(prefix, broken)}`)) };
      trades.push(t);
      return { redirect: `${prefix}trades?saved=1` };
    }
    if (rest === "settings") return { html: doc("Settings", `${nav(prefix)}<main><h1>Settings</h1></main>`) };
    return undefined;
  };
  return { answer, trades: () => [...trades] };
}
