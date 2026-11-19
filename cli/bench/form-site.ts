/**
 * Forms that a real user fills in completely, in four styles that have nothing to do with dealing: the
 * proof that "fill the form like a real user" (packages/scanner/src/tester/fill.ts) is general, and
 * that it leaves alone what a real user leaves alone.
 *
 *   /fo/  an invoice form whose line-item table shows TWO rows by default (and "+ Add line"): right
 *         only when both rows were filled and saved, and no third row was added;
 *   /fp/  a new-contact form with optional "Address line 2" and "Phone": right only when both were filled;
 *   /fs/  a new-product form with a site search box above it, a "Filter categories" box, a "Compare
 *         with another product" box (worded with none of the engine's words) and a photo upload inside
 *         it: right when it is saved with its optional SKU, stock and description filled, the search,
 *         filter and compare boxes never typed in and no file chosen;
 *   /fg/  a trap: a delivery-address form with a "Gift options" section switched off (its "Gift
 *         message" disabled until "This delivery is a gift" is ticked), a "Promo code (only if you
 *         were given one)" and a "Tell a friend about Parcelly" box (none of the engine's words):
 *         right when it is saved with its optional delivery instructions and none of those touched.
 *
 * Each save is a plain GET form to <prefix>save; the server logs what it measured as <prefix>… lines
 * in the site's request log (the bench's oracle). Typing in a box that must stay alone, or choosing a
 * file, is logged by the page itself (<prefix>typed-…). No AI, no network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#fafafa;color:#1b1b1f}
header{display:flex;gap:18px;align-items:center;padding:12px 24px;background:#fff;border-bottom:1px solid #e5e5ea}header b{margin-right:12px}header a{color:#1b1b1f}
main{max-width:820px;margin:22px auto;padding:0 20px}form.card,.card{background:#fff;border:1px solid #e5e5ea;border-radius:12px;padding:18px 22px;margin-bottom:16px}
label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px}input,select,textarea{width:100%;padding:8px 10px;border:1px solid #c9c9d1;border-radius:8px;font:inherit}
input[type=checkbox]{width:auto}textarea{min-height:64px}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.opt{font-weight:400;color:#6b6b76}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:13px;color:#6b6b76;padding:4px}td{padding:4px}
button{padding:9px 16px;border-radius:8px;border:1px solid #c9c9d1;background:#fff;font:inherit;cursor:pointer}button.pri{background:#3b5bdb;color:#fff;border-color:#3b5bdb}
.err{background:#fdecec;color:#8a1c1c;border-radius:8px;padding:10px 12px;margin-bottom:12px}fieldset{border:1px solid #e5e5ea;border-radius:10px;padding:10px 14px;margin-top:14px}fieldset[disabled]{opacity:.55}
form[role=search]{display:flex;gap:8px;margin-left:auto}form[role=search] input{width:240px}`;

const page = (title: string, app: string, prefix: string, body: string, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} — ${esc(app)}</title><style>${CSS}</style></head><body>` +
  `<header><b>${esc(app)}</b><a href="${prefix}">Home</a><a href="${prefix}new">New</a>${prefix === "/fs/" ? `<form role="search" action="${prefix}search"><input type="search" name="q" aria-label="Search products" placeholder="Search products"><button>Search</button></form>` : ""}</header>` +
  `<main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

/** The page logs a typed-in box or a chosen file: a box that must stay alone was touched. */
const beacons = (prefix: string, pairs: [selector: string, event: string, what: string][]) =>
  pairs.map(([sel, ev, what]) => `document.querySelectorAll(${JSON.stringify(sel)}).forEach(function (el) { el.addEventListener(${JSON.stringify(ev)}, function () { fetch(${JSON.stringify(`${prefix}typed-${what}`)}, { cache: "no-store" }); }); });`).join("\n");

interface Saved {
  id: string;
  title: string;
  lines: string[];
}

const filled = (v: string | null) => Boolean(v && v.trim());
const positive = (v: string | null) => Number(String(v ?? "").replace(/[^0-9.\-]/g, "")) > 0;

/** One form app under a prefix. */
interface FormApp {
  app: string;
  /** The new-record form, with an error said at its top when a save was refused. */
  form(error?: string): { title: string; body: string; script?: string };
  /** A save: what is wrong, or the record's title and lines; `note` logs what the oracle reads. */
  save(q: URLSearchParams, note: (line: string) => void): { error: string } | { title: string; lines: string[] };
  home: string;
}

const INVOICE: FormApp = {
  app: "Ledgerly",
  home: "Invoices",
  form(error) {
    const line = (i: number) => `<tr><td><input name="desc${i}" aria-label="Description, line ${i}"></td><td><input name="qty${i}" type="number" min="0" step="1" aria-label="Qty, line ${i}"></td><td><input name="price${i}" type="number" min="0" step="0.01" aria-label="Unit price, line ${i}"></td></tr>`;
    return {
      title: "New invoice",
      body: `<h1>New invoice</h1><form class="card" action="/fo/save" method="get">${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<div class="row"><div><label for="client">Client name</label><input id="client" name="client" required></div><div><label for="ref">Your reference <span class="opt">(optional)</span></label><input id="ref" name="ref"></div></div>
<div class="row"><div><label for="date">Invoice date</label><input id="date" name="date" type="date" required></div><div><label for="due">Due date</label><input id="due" name="due" type="date"></div></div>
<h2 style="font-size:16px;margin:16px 0 6px">Line items</h2><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th></tr></thead><tbody id="lines">${line(1)}${line(2)}</tbody></table>
<p><button type="button" id="addLine">+ Add line</button></p>
<label for="notes">Notes to the client <span class="opt">(optional)</span></label><textarea id="notes" name="notes"></textarea>
<p><button class="pri" type="submit">Save invoice</button></p></form>`,
      script: `document.getElementById("addLine").addEventListener("click", function () { var n = document.querySelectorAll("#lines tr").length + 1; var tr = document.createElement("tr"); tr.innerHTML = '<td><input name="desc' + n + '" aria-label="Description, line ' + n + '"></td><td><input name="qty' + n + '" type="number" aria-label="Qty, line ' + n + '"></td><td><input name="price' + n + '" type="number" aria-label="Unit price, line ' + n + '"></td>'; document.getElementById("lines").appendChild(tr); });`,
    };
  },
  save(q, note) {
    if (!filled(q.get("client")) || !filled(q.get("date"))) return { error: "Enter the client's name and the invoice date." };
    const lines = [1, 2, 3, 4, 5].filter((i) => filled(q.get(`desc${i}`)) && positive(q.get(`qty${i}`)) && positive(q.get(`price${i}`)));
    if (!lines.length) return { error: "Add at least one line with a description, a quantity and a price." };
    note(`/fo/saved?lines=${lines.length}`);
    if (lines.includes(1) && lines.includes(2)) note("/fo/both-lines");
    if (lines.some((i) => i > 2) || filled(q.get("desc3"))) note("/fo/extra-line");
    return { title: "Invoice saved", lines: [`Client: ${q.get("client")}`, ...lines.map((i) => `${q.get(`desc${i}`)} × ${q.get(`qty${i}`)} at ${q.get(`price${i}`)}`)] };
  },
};

const CONTACT: FormApp = {
  app: "Addressly",
  home: "Contacts",
  form(error) {
    return {
      title: "New contact",
      body: `<h1>New contact</h1><form class="card" action="/fp/save" method="get">${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<div class="row"><div><label for="name">Full name</label><input id="name" name="name" autocomplete="name" required></div><div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div></div>
<label for="a1">Address line 1</label><input id="a1" name="line1" autocomplete="address-line1" required>
<label for="a2">Address line 2 <span class="opt">(optional)</span></label><input id="a2" name="line2" autocomplete="address-line2">
<div class="row"><div><label for="city">Town or city</label><input id="city" name="city" autocomplete="address-level2" required></div><div><label for="pc">Postcode</label><input id="pc" name="postcode" autocomplete="postal-code" required></div></div>
<div class="row"><div><label for="country">Country</label><select id="country" name="country"><option selected>United Kingdom</option><option>Ireland</option><option>France</option></select></div><div><label for="phone">Phone <span class="opt">(optional)</span></label><input id="phone" name="phone" type="tel" autocomplete="tel"></div></div>
<p><button class="pri" type="submit">Save contact</button></p></form>`,
    };
  },
  save(q, note) {
    for (const k of ["name", "email", "line1", "city", "postcode"]) if (!filled(q.get(k))) return { error: "Fill in the name, email, first address line, town and postcode." };
    note("/fp/saved");
    if (filled(q.get("line2")) && filled(q.get("phone"))) note("/fp/complete");
    return { title: "Contact saved", lines: [`Name: ${q.get("name")}`, String(q.get("line1")), String(q.get("line2") ?? ""), `${q.get("city")} ${q.get("postcode")}`].filter(Boolean) };
  },
};

const PRODUCT: FormApp = {
  app: "Shelfly",
  home: "Products",
  form(error) {
    const cats = ["Kitchen", "Garden", "Office", "Toys", "Books"];
    return {
      title: "New product",
      body: `<h1>New product</h1><form class="card" action="/fs/save" method="get">${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<div class="row"><div><label for="pname">Product name</label><input id="pname" name="name" required></div><div><label for="sku">SKU</label><input id="sku" name="sku"></div></div>
<div class="row"><div><label for="price">Price</label><input id="price" name="price" type="number" min="0" step="0.01" required></div><div><label for="stock">Stock quantity</label><input id="stock" name="stock" type="number" min="0" step="1"></div></div>
<label for="cmp">Compare with another product <span class="opt">(opens both side by side)</span></label><input id="cmp" placeholder="Type another product's name">
<label for="catFilter">Filter categories</label><input id="catFilter" placeholder="Type to filter the list">
<label for="cat">Category</label><select id="cat" name="category">${cats.map((c) => `<option>${c}</option>`).join("")}</select>
<label for="desc">Description</label><textarea id="desc" name="description"></textarea>
<label for="photo">Product photo <span class="opt">(optional)</span></label><input id="photo" type="file" accept="image/*">
<p><button class="pri" type="submit">Save product</button></p></form>`,
      script: `${beacons("/fs/", [["input[type=search]", "input", "search"], ["#catFilter", "input", "filter"], ["#photo", "change", "upload"], ["#cmp", "input", "compare"]])}
document.getElementById("catFilter").addEventListener("input", function (e) { var w = e.target.value.toLowerCase(); [].forEach.call(document.querySelectorAll("#cat option"), function (o) { o.hidden = w && o.textContent.toLowerCase().indexOf(w) < 0; }); });`,
    };
  },
  save(q, note) {
    if (!filled(q.get("name")) || !positive(q.get("price"))) return { error: "Enter the product's name and a price." };
    note(`/fs/saved?category=${encodeURIComponent(q.get("category") ?? "")}`);
    if (filled(q.get("sku")) && filled(q.get("stock")) && filled(q.get("description"))) note("/fs/complete");
    return { title: "Product saved", lines: [`Name: ${q.get("name")}`, `Price ${q.get("price")}`, `Category ${q.get("category")}`] };
  },
};

const DELIVERY: FormApp = {
  app: "Parcelly",
  home: "Addresses",
  form(error) {
    return {
      title: "New delivery address",
      body: `<h1>New delivery address</h1><form class="card" action="/fg/save" method="get">${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<label for="who">Recipient's full name</label><input id="who" name="name" required>
<label for="street">Street address</label><input id="street" name="street" required>
<div class="row"><div><label for="town">Town</label><input id="town" name="town" required></div><div><label for="post">Postcode</label><input id="post" name="postcode" required></div></div>
<label for="instr">Delivery instructions <span class="opt">(optional)</span></label><input id="instr" name="instructions" placeholder="e.g. leave with a neighbour">
<fieldset id="giftBox" disabled><legend>Gift options</legend><label for="gm">Gift message</label><textarea id="gm" name="giftMessage"></textarea></fieldset>
<p><label style="display:inline;font-weight:400"><input type="checkbox" id="isGift" name="gift"> This delivery is a gift</label></p>
<label for="friend">Tell a friend about Parcelly <span class="opt">(their first name; we'll say hello)</span></label><input id="friend" name="friend">
<label for="promo">Promo code <span class="opt">(only if you were given one)</span></label><input id="promo" name="promo">
<p><button class="pri" type="submit">Save address</button></p></form>`,
      script: `${beacons("/fg/", [["#gm", "input", "gift"], ["#promo", "input", "promo"], ["#isGift", "change", "gift-on"], ["#friend", "input", "friend"]])}
document.getElementById("isGift").addEventListener("change", function (e) { document.getElementById("giftBox").disabled = !e.target.checked; });`,
    };
  },
  save(q, note) {
    for (const k of ["name", "street", "town", "postcode"]) if (!filled(q.get(k))) return { error: "Fill in the recipient, street, town and postcode." };
    note("/fg/saved");
    if (filled(q.get("instructions"))) note("/fg/complete");
    if (filled(q.get("friend"))) note("/fg/typed-friend");
    if (filled(q.get("promo"))) note("/fg/typed-promo");
    if (filled(q.get("giftMessage")) || q.get("gift")) note("/fg/typed-gift");
    return { title: "Delivery address saved", lines: [`Recipient: ${q.get("name")}`, String(q.get("street")), `${q.get("town")} ${q.get("postcode")}`] };
  },
};

/** The four form apps, each under its own prefix: answers a request under it (true), or leaves it (false). */
export function formApps(): { handle(req: IncomingMessage, res: ServerResponse, url: URL, note: (line: string) => void): boolean } {
  const apps: Record<string, FormApp> = { "/fo/": INVOICE, "/fp/": CONTACT, "/fs/": PRODUCT, "/fg/": DELIVERY };
  const saved: Record<string, Saved[]> = { "/fo/": [], "/fp/": [], "/fs/": [], "/fg/": [] };
  let n = 1000;
  return {
    handle(_req, res, url, note) {
      const prefix = Object.keys(apps).find((p) => url.pathname.startsWith(p) || url.pathname === p.slice(0, -1));
      if (!prefix) return false;
      const a = apps[prefix]!;
      const rest = url.pathname.slice(prefix.length);
      const html = (s: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(s);
      if (rest.startsWith("typed-")) return res.writeHead(204).end(), true;
      if (rest === "" || rest === "list") {
        const list = saved[prefix]!.map((r) => `<li><a href="${prefix}view?id=${r.id}">${esc(r.title.replace(/ saved$/, ""))}</a> · ${esc((r.lines[0] ?? "").replace(/^[A-Za-z]+: /, ""))}</li>`).join("");
        return html(page(a.home, a.app, prefix, `<h1>${esc(a.home)}</h1><div class="card">${list ? `<ul>${list}</ul>` : "<p>Nothing here yet.</p>"}<p><a href="${prefix}new">New</a></p></div>`)), true;
      }
      if (rest === "new") {
        const f = a.form();
        return html(page(f.title, a.app, prefix, f.body, f.script)), true;
      }
      if (rest === "search") return html(page("Search", a.app, prefix, `<h1>Search results</h1><p>No products match.</p>`)), true;
      if (rest === "save") {
        const out = a.save(url.searchParams, note);
        if ("error" in out) {
          const f = a.form(out.error);
          return html(page(f.title, a.app, prefix, f.body, f.script)), true;
        }
        const id = `R-${n++}`;
        saved[prefix]!.push({ id, title: out.title.replace(/ saved$/, ` ${id} saved`), lines: out.lines });
        return res.writeHead(302, { location: `${prefix}view?id=${id}`, "cache-control": "no-store" }).end(), true;
      }
      if (rest === "view") {
        const r = saved[prefix]!.find((x) => x.id === url.searchParams.get("id"));
        if (!r) return html(page("Not found", a.app, prefix, "<h1>Not found</h1>")), true;
        return html(page(r.title, a.app, prefix, `<div class="card" role="status"><h1>${esc(r.title)}</h1><p>Saved just now. Reference ${esc(r.id)}.</p><ul>${r.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p><a href="${prefix}">All ${esc(a.home.toLowerCase())}</a></p></div>`)), true;
      }
      return false;
    },
  };
}
