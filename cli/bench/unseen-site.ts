/**
 * Two UNSEEN forms for the generality review of "fill the form like a real user" (built by the
 * reviewer, not the builder). Styles deliberately unlike form-site.ts:
 *
 *   /uv/  a vet appointment, NO <form> element: fields in a <section>, the "Confirm appointment request" button
 *         in a separate sticky footer, saved by fetch(). Optional "Pet's weight (kg)" and "Notes for
 *         the vet". An "Insurance" panel whose inputs are readonly + aria-disabled until a switch is
 *         turned on (words the engine's lists don't know), and a "Nearest clinic" postcode box above
 *         the sections that is for another purpose (no role=search, no "search/find/filter" word).
 *         Right: saved with weight AND notes filled; insurance and clinic box never typed in.
 *   /ul/  a library loan desk: a table showing THREE item rows by default, cells with NO labels of
 *         their own (only column headers), the table re-rendered (innerHTML) on every change, and a
 *         status "N of 3 rows complete". Right: saved with all three rows complete (barcode, title,
 *         due date) and no fourth row.
 *
 * Oracle lines go to the site log (<prefix>…). No AI, no network.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.5 Georgia,serif;background:#f4f1ea;color:#222}
header{display:flex;gap:14px;align-items:center;padding:10px 20px;background:#2f4f4f;color:#fff}header input{padding:6px;border-radius:4px;border:0}
main{max-width:760px;margin:20px auto;padding:0 16px 120px}section{background:#fff;padding:16px;border-radius:6px;margin-bottom:14px}
.f{margin:10px 0}.f span{display:block;font-size:13px;font-weight:bold}.f input,.f select,.f textarea{width:100%;padding:7px;border:1px solid #bbb;border-radius:4px;font:inherit}
.off{opacity:.5}footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #ccc;padding:12px 20px;text-align:right}
footer button,button{padding:8px 14px;font:inherit;cursor:pointer}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ddd;padding:4px;text-align:left}td input{width:100%;padding:5px}
.ok{background:#e6f4ea;padding:12px;border-radius:6px}`;

const shell = (title: string, app: string, header: string, body: string, script: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · ${app}</title><style>${CSS}</style></head><body><header><b>${app}</b>${header}</header><main>${body}</main><script>${script}</script></body></html>`;

const VET = shell(
  "Request a visit",
  "PawPoint Vets",
  ``,
  `<h1>Request a visit</h1>
<div style="margin:0 0 12px"><label>Nearest clinic to you: <input id="clinic" placeholder="Your postcode" style="padding:5px"></label> <small>(shows opening hours; not part of the request)</small></div>
<section id="pet"><h2>Your pet</h2>
<label class="f"><span>Pet's name</span><input id="pname" required></label>
<label class="f"><span>Species</span><select id="species" required><option value="">Choose…</option><option>Dog</option><option>Cat</option><option>Rabbit</option></select></label>
<label class="f"><span>Pet's weight (kg)</span><input id="weight" type="number" step="0.1" min="0"></label>
<label class="f"><span>Preferred day</span><input id="day" type="date" required></label>
<label class="f"><span>Owner's name</span><input id="owner" required></label>
<label class="f"><span>Notes for the vet</span><textarea id="notes" placeholder="Symptoms, medication, anything we should know"></textarea></label>
</section>
<section id="ins" class="off" aria-disabled="true"><h2>Insurance</h2>
<label><input type="checkbox" role="switch" id="insOn"> My pet is insured with a provider</label>
<label class="f"><span>Insurer</span><input id="insurer" readonly></label>
<label class="f"><span>Policy reference</span><input id="policy" readonly></label>
</section>
<div id="done"></div>
<footer><button id="book">Confirm appointment request</button></footer>`,
  `function beacon(w){fetch('/uv/'+w,{cache:'no-store'})}
document.getElementById('clinic').addEventListener('input',function(){beacon('typed-clinic')});
['insurer','policy'].forEach(function(id){document.getElementById(id).addEventListener('input',function(){beacon('typed-insurance')})});
document.getElementById('insOn').addEventListener('change',function(e){beacon('typed-insurance');var s=document.getElementById('ins');s.classList.toggle('off',!e.target.checked);s.setAttribute('aria-disabled',String(!e.target.checked));['insurer','policy'].forEach(function(id){document.getElementById(id).readOnly=!e.target.checked})});
document.getElementById('book').addEventListener('click',function(){
 var v=function(id){return document.getElementById(id).value.trim()};
 var q=new URLSearchParams({name:v('pname'),species:v('species'),weight:v('weight'),day:v('day'),owner:v('owner'),notes:v('notes')});
 fetch('/uv/save?'+q,{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
  var d=document.getElementById('done');
  if(j.error){d.innerHTML='<p role="alert" style="color:#a00">'+j.error+'</p>';return}
  document.getElementById('pet').remove();document.getElementById('ins').remove();document.querySelector('footer').remove();
  d.innerHTML='<div class="ok" role="status"><h2>Appointment requested</h2><p>Request '+j.id+' for '+j.name+' on '+j.day+'.</p></div>';
 });
});`,
);

const LIB = shell(
  "Lend items",
  "Shelfmark Library",
  `<nav><a style="color:#fff" href="/ul/">Loans</a></nav>`,
  `<h1>Lend items</h1>
<section><label class="f"><span>Borrower's name</span><input id="who" required></label>
<label class="f"><span>Loan date</span><input id="ldate" type="date" required></label>
<h2>Items</h2><p id="stat"></p>
<table><thead><tr><th>Barcode</th><th>Title</th><th>Due back</th></tr></thead><tbody id="rows"></tbody></table>
<p><button type="button" id="more">+ Another item</button></p>
<p><button type="button" id="lend">Lend items</button></p><div id="msg"></div></section>`,
  `var data=[{b:'',t:'',d:''},{b:'',t:'',d:''},{b:'',t:'',d:''}];
function done(r){return r.b.trim()&&r.t.trim()&&r.d}
function draw(){var tb=document.getElementById('rows');tb.innerHTML=data.map(function(r,i){return '<tr><td><input data-i="'+i+'" data-k="b" value="'+r.b.replace(/"/g,'&quot;')+'"></td><td><input data-i="'+i+'" data-k="t" value="'+r.t.replace(/"/g,'&quot;')+'"></td><td><input type="date" data-i="'+i+'" data-k="d" value="'+r.d+'"></td></tr>'}).join('');
 document.getElementById('stat').textContent=data.filter(done).length+' of '+data.length+' rows complete';}
document.getElementById('rows').addEventListener('change',function(e){var t=e.target;if(!t.dataset)return;data[+t.dataset.i][t.dataset.k]=t.value;draw()});
document.getElementById('more').addEventListener('click',function(){data.push({b:'',t:'',d:''});fetch('/ul/added-row',{cache:'no-store'});draw()});
document.getElementById('lend').addEventListener('click',function(){
 [].forEach.call(document.querySelectorAll('#rows input'),function(el){data[+el.dataset.i][el.dataset.k]=el.value});
 var q=new URLSearchParams({who:document.getElementById('who').value,ldate:document.getElementById('ldate').value,rows:JSON.stringify(data)});
 fetch('/ul/save?'+q,{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
  if(j.error){document.getElementById('msg').innerHTML='<p role="alert" style="color:#a00">'+j.error+'</p>';return}
  document.querySelector('main').innerHTML='<div class="ok" role="status"><h1>Loan saved</h1><p>Loan '+j.id+' for '+j.who+': '+j.n+' item(s).</p></div>';
 });
});
draw();`,
);

export function unseenApps(): { handle(req: IncomingMessage, res: ServerResponse, url: URL, note: (line: string) => void): boolean } {
  let n = 500;
  return {
    handle(_req, res, url, note) {
      const p = url.pathname;
      if (!p.startsWith("/uv/") && !p.startsWith("/ul/")) return false;
      const html = (s: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(s);
      const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(o));
      const q = url.searchParams;
      const has = (k: string) => Boolean((q.get(k) ?? "").trim());
      if (p === "/uv/" || p === "/uv/new") return html(VET), true;
      if (p === "/ul/" || p === "/ul/new") return html(LIB), true;
      if (/^\/u[vl]\/(typed-|added-row)/.test(p)) return res.writeHead(204).end(), true;
      if (p === "/uv/save") {
        for (const k of ["name", "species", "day", "owner"]) if (!has(k)) return json({ error: "Please give your pet's name, species, a day and your name." }), true;
        note("/uv/saved");
        if (has("weight") && Number(q.get("weight")) > 0 && has("notes")) note("/uv/complete");
        return json({ id: `V-${n++}`, name: q.get("name"), day: q.get("day") }), true;
      }
      if (p === "/ul/save") {
        if (!has("who") || !has("ldate")) return json({ error: "Enter the borrower and the loan date." }), true;
        let rows: { b: string; t: string; d: string }[] = [];
        try { rows = JSON.parse(q.get("rows") ?? "[]"); } catch { /* none */ }
        const ok = rows.filter((r) => r.b?.trim() && r.t?.trim() && r.d);
        if (!ok.length) return json({ error: "Scan at least one item: barcode, title and due date." }), true;
        const ldate = q.get("ldate") ?? "";
        note(`/ul/saved?rows=${ok.length}`);
        if (ok.length >= 3 && rows.slice(0, 3).every((r) => r.b?.trim() && r.t?.trim() && r.d)) note("/ul/three-rows");
        if (rows.length > 3) note("/ul/extra-row");
        if (ok.every((r) => r.d >= ldate)) note("/ul/dates-sane");
        return json({ id: `L-${n++}`, who: q.get("who"), n: ok.length }), true;
      }
      return false;
    },
  };
}
