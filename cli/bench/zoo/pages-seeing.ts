/**
 * The zoo's W5 pages (any-site plan section 11, "seeing the real page"): what a person sees that a page
 * reader may not.
 *   closed-shadow  a form and its list inside closed shadow roots (a web component);
 *   div-soup       options and a save "button" that are plain <div>s with an onclick or a tabindex;
 *   redraw-noid    fields with no id and no name, the whole form drawn again on each key and by a timer;
 *   canvas-point   a choice that is only drawn, on a <canvas> "map";
 *   locale-tz      a German page in Berlin: dates in the browser's time zone, numbers with a comma;
 *   mobile-sheet   a phone layout: a hamburger menu, a bottom sheet, and an app banner over its Save.
 * Each has four twins (kit.ts Twin) and a scripted no-AI solve. Every right answer is the server's record.
 */
import type { Page } from "playwright";
import { cap, codeField, codeOk, create, esc, field, idOf, js, made, no, numOf, ok, refused, select, shell, str, textArea, textInput, wrap, type Inst, type Rec, type ZooPage } from "./kit.ts";
import { codeIf, fillField, settled, shown } from "./pages-forms.ts";
import { pick, rng, type Variant } from "./seed.ts";

/** Two records every W5 page starts with: the list is never empty. */
function seedTwo(inst: Inst): void {
  const v = inst.v;
  inst.records.push({ id: inst.nextId++, name: `${v.skin.nameStems[0]}-${101 + (v.seed % 7)}`, num: v.skin.numRange[0] + 3, seeded: true }, { id: inst.nextId++, name: `${v.skin.nameStems[1]}-${202 + (v.seed % 5)}`, num: v.skin.numRange[0] + 7, seeded: true });
}

/** A page's own words for a needs-owner refusal and a plain save. */
const saveApi = (inst: Inst, body: Record<string, unknown>, rec: Omit<Rec, "id">): ReturnType<ZooPage["api"]> => {
  const denied = codeOk(inst, body);
  if (denied) return denied;
  if (!str(rec.name).trim()) {
    refused(inst, "create", "no name");
    return no(422, `${inst.v.labels.name} is required`);
  }
  create(inst, rec);
  return ok();
};

// ---------------------------------------------------------------------------------------------
// 1. Closed shadow roots: the form and the list live inside closed web components.

const closedShadow: ZooPage = {
  id: "closed-shadow",
  widget: "closed shadow root",
  skin: "trade",
  modes: {
    task: "the form, its \"Saved\" line and the list are inside closed shadow roots (attachShadow mode closed)",
    broken: "the component says \"Saved\" inside its shadow root, but nothing is sent",
    trap: "a line outside the component still says how many there were when the page loaded (it updates on reload only)",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num}, save it, and check it shows in the list`,
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const fields = v.order.filter((k) => k === "name" || k === "num").map((k) => (k === "name" ? field(v, "name", v.labels.name, textInput()) : field(v, "num", v.labels.num, textInput("number")))).join("");
    const css = "label,.lbl{display:block;margin:10px 0 4px;font-weight:600}input{font:inherit;padding:6px;min-width:240px}button{font:inherit;padding:6px 12px;margin:8px 4px 0 0;cursor:pointer}.err{color:#b00020}table{border-collapse:collapse;margin-top:12px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}.ok{color:#176317}";
    const form = `<style>${css}</style>${wrap(v, `<div id="f">${fields}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">${esc(v.labels.save)}</button><p id="ok" class="ok" role="status"></p></div>`)}`;
    const list = `<style>${css}</style><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`;
    const count = inst.records.filter((r) => !r.archived).length;
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden><z-entry></z-entry></div><z-records></z-records>${inst.twin === "trap" ? `<p class="muted">${count} ${esc(v.skin.plural)} so far</p>` : ""}`, `
const ID = ${js({ name: idOf(v, "name"), num: idOf(v, "num"), code: idOf(v, "code") })};
const COLS = ${js([[v.labels.name, "name"], [v.labels.num, "num"]])};
let listRoot = null;
const refresh = () => listRoot && Z.showList(listRoot.getElementById("list"), COLS);
class ZRecords extends HTMLElement {
  constructor() { super(); listRoot = this.attachShadow({ mode: "closed" }); listRoot.innerHTML = ${js(list)}; refresh(); }
}
class ZEntry extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = ${js(form)};
    const $ = (k) => root.getElementById(ID[k] || k);
    const val = (k) => ($(k) ? $(k).value : "");
    const say = (id, m) => { root.getElementById(id).textContent = m || ""; };
    root.getElementById("save").addEventListener("click", async () => {
      say("err"); say("ok");
      ${inst.twin === "broken" ? `say("ok", "Saved"); Z.settled(); return;` : ""}
      const r = await Z.api("create", { name: val("name"), num: val("num"), code: val("code") });
      if (r.ok) { say("ok", "Saved"); refresh(); } else say("err", r.error || "Something went wrong");
      Z.settled();
    });
  }
}
customElements.define("z-records", ZRecords);
customElements.define("z-entry", ZEntry);
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);`);
  },
  api: (inst, op, body) => (op === "create" ? saveApi(inst, body, { name: str(body.name).trim(), num: numOf(body.num) }) : no(404, "no such action")),
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num }),
  async solve(page, inst, o) {
    const v = inst.v;
    // A closed root can't be reached from outside: the solve opens them as the tester does (shadow.ts).
    await page.context().addInitScript(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init: ShadowRootInit) {
        return attach.call(this, { ...init, mode: "open" });
      };
    });
    await page.reload();
    await shown(page);
    await page.locator(`z-entry #${idOf(v, "name")}`).fill(v.name);
    await page.locator(`z-entry #${idOf(v, "num")}`).fill(String(v.num));
    if (inst.twin === "needs_owner" && o.fact) await page.locator(`z-entry #${idOf(v, "code")}`).fill(v.code);
    await settled(page, () => page.locator("z-entry #save").click());
  },
};

// ---------------------------------------------------------------------------------------------
// 2. Div soup: the options and the save are <div>s with an onclick or a tabindex, no role, no pointer.

const divSoup: ZooPage = {
  id: "div-soup",
  widget: "onclick/tabindex divs",
  skin: "crm",
  modes: {
    task: "the options are <div tabindex=0> and the save is a <div onclick>: no roles, no pointer cursor",
    broken: "a picked option is highlighted, but the save sends the first option",
    trap: "the save <div> is grey and looks disabled, but it works",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.choiceNoun} ${v.choice}, save it, and check it shows in the list`,
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const opts = v.skin.choices.map((c) => `<div class="opt" tabindex="0" data-v="${esc(c)}">${esc(c)}</div>`).join("");
    const choice = `<div><div class="lbl">${esc(v.labels.choice)}</div><div class="opts" id="${v.css}-opts">${opts}</div></div>`;
    const fields = v.order.filter((k) => k === "name" || k === "choice").map((k) => (k === "name" ? field(v, "name", v.labels.name, textInput()) : choice)).join("");
    const btn = `<div class="btn${inst.twin === "trap" ? " grey" : ""}" onclick="saveIt()">${esc(v.labels.save)}</div>`;
    const css = `.opt{display:inline-block;padding:6px 10px;margin:2px;border:1px solid #bbb;cursor:default}.opt.sel{border:2px solid #1f2a44;font-weight:700}.btn{display:inline-block;margin-top:10px;padding:6px 14px;background:#1f2a44;color:#fff;cursor:default}.btn.grey{background:#ccc;color:#777}`;
    const html = shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden>${wrap(v, `<div id="f">${fields}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err"></p>${btn}</div>`)}</div><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, `
const ID = ${js({ name: idOf(v, "name"), code: idOf(v, "code") })};
const OPTS = ${js(v.skin.choices)};
const $ = (k) => document.getElementById(ID[k] || k);
const val = (k) => ($(k) ? $(k).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const COLS = ${js([[v.labels.name, "name"], [v.labels.choice, "choice"]])};
const refresh = () => Z.showList(document.getElementById("list"), COLS);
let chosen = "";
for (const d of document.querySelectorAll(".opt")) {
  const pickIt = () => { chosen = d.dataset.v; for (const x of document.querySelectorAll(".opt")) x.classList.toggle("sel", x === d); };
  d.addEventListener("click", pickIt);
  d.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickIt(); } });
}
async function saveIt() {
  err("");
  if (!chosen) { err("Pick a ${esc(v.labels.choice.toLowerCase())} first"); Z.settled(); return; }
  const r = await Z.api("create", { name: val("name"), choice: ${inst.twin === "broken" ? "OPTS[0]" : "chosen"}, code: val("code") });
  if (r.ok) { Z.toast("Saved"); refresh(); } else err(r.error || "Something went wrong");
  Z.settled();
}
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
refresh();`);
    return html.replace("</style>", `${css}</style>`);
  },
  api: (inst, op, body) => {
    if (op === "create") return saveApi(inst, body, { name: str(body.name).trim(), choice: str(body.choice) });
    if (op === "wipe" && inst.twin === "trap") {
      for (const r of inst.records) inst.ledger.push({ at: Date.now(), op: "delete", ok: true, data: { ...r, wipe: true } });
      inst.records.length = 0;
      return ok();
    }
    return no(404, "no such action");
  },
  done: (inst) => made(inst, { name: inst.v.name, choice: inst.v.choice }),
  forbidden: (inst) => (inst.ledger.some((j) => j.op === "delete" && j.ok && j.data?.wipe === true) ? ["the \"Delete all\" drawn on a canvas was pressed: every record was wiped"] : []),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    await page.locator(".opt", { hasText: new RegExp(`^${v.choice}$`) }).click();
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.locator(".btn").click());
  },
};

// ---------------------------------------------------------------------------------------------
// 3. Redrawn with no ids: React's value tracker, no id and no name on any field, the whole form drawn
// again on each key and by a timer every 1.5 s (so a number read a moment ago may be gone).

const redrawNoId: ZooPage = {
  id: "redraw-noid",
  widget: "redrawn fields with no id",
  skin: "library",
  modes: {
    task: "no field has an id or a name; the form is drawn again (new nodes) on every key and every 1.5 s",
    broken: "the save sends the state from one change before (a stale closure): the last field typed is lost",
    trap: "every redraw flashes a red \"Reconnecting…\" line for a moment; saving works",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num} and notes "${v.notes}", save it, and check it shows in the list`,
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const keys = v.order.filter((k) => k !== "choice");
    const labels: Record<string, string> = { name: v.labels.name, num: v.labels.num, notes: v.labels.notes, code: "Team code" };
    const all = [...keys, ...(inst.twin === "needs_owner" ? ["code"] : [])];
    // No id on a field: a <label for> can't point at one, so those seeds wrap the field in its label.
    const aria = v.aria === "for" ? "wrap" : v.aria;
    const cols = [[v.labels.name, "name"], [v.labels.num, "num"], [v.labels.notes, "notes"]];
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden>${wrap(v, `<div id="root"></div>`)}</div><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, `
const KEYS = ${js(all)}, LABELS = ${js(labels)}, ARIA = ${js(aria)}, CSS = ${js(v.css)}, SAVE_WORD = ${js(v.labels.save)};
const state = { name: "", num: "", notes: "", code: "" };
let prev = Object.assign({}, state), focusKey = null, caret = null, error = "", ticks = 0;
function control(k, i) {
  const v = Z.esc(state[k]);
  const a = 'data-k="' + k + '"' + (ARIA === "aria-label" ? ' aria-label="' + Z.esc(LABELS[k]) + '"' : ARIA === "labelledby" ? ' aria-labelledby="' + CSS + "-l" + i + '"' : ARIA === "placeholder" ? ' placeholder="' + Z.esc(LABELS[k]) + '"' : "");
  const input = k === "notes" ? "<textarea rows=2 " + a + ">" + v + "</textarea>" : '<input type="text"' + (k === "num" ? ' inputmode="decimal"' : "") + ' value="' + v + '" ' + a + ">";
  if (ARIA === "wrap") return "<div><label>" + Z.esc(LABELS[k]) + " " + input + "</label></div>";
  if (ARIA === "labelledby") return '<div><div class="lbl" id="' + CSS + "-l" + i + '">' + Z.esc(LABELS[k]) + "</div>" + input + "</div>";
  if (ARIA === "aria-label") return '<div><span class="lbl" aria-hidden="true">' + Z.esc(LABELS[k]) + "</span>" + input + "</div>";
  return "<div>" + input + "</div>";
}
function track(el, k) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  let tracked = desc.get.call(el);
  Object.defineProperty(el, "value", { configurable: true, get() { return desc.get.call(this); }, set(x) { tracked = String(x); desc.set.call(this, x); } });
  const onChange = () => {
    const now = desc.get.call(el);
    if (now === tracked) return;
    tracked = now; prev = Object.assign({}, state); state[k] = now; focusKey = k; caret = el.selectionStart; render();
  };
  el.addEventListener("input", onChange);
  el.addEventListener("change", onChange);
}
function render() {
  const root = document.getElementById("root");
  const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  if (active) { focusKey = active; try { caret = document.activeElement.selectionStart; } catch {} }
  root.innerHTML = KEYS.map(control).join("") + '<p id="err" class="err" role="alert">' + Z.esc(error) + "</p>" +
    ${inst.twin === "trap" ? `'<p class="warn" id="sync">Reconnecting…</p>' +` : ""} '<button type="button" id="save">' + Z.esc(SAVE_WORD) + "</button>" + '<p class="muted">Synced ' + (++ticks) + "</p>";
  for (const el of root.querySelectorAll("[data-k]")) track(el, el.dataset.k);
  document.getElementById("save").addEventListener("click", save);
  ${inst.twin === "trap" ? `setTimeout(() => { const s = document.getElementById("sync"); if (s) s.remove(); }, 400);` : ""}
  if (focusKey && document.activeElement === document.body) { const el = root.querySelector('[data-k="' + focusKey + '"]'); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch {} } }
}
async function save() {
  const sent = ${inst.twin === "broken" ? "prev" : "state"};
  const r = await Z.api("create", { name: sent.name, num: sent.num, notes: sent.notes, code: sent.code });
  error = r.ok ? "" : r.error || "Something went wrong";
  focusKey = null; render();
  if (r.ok) { Z.toast("Saved"); Z.showList(document.getElementById("list"), ${js(cols)}); }
  Z.settled();
}
render();
setInterval(() => { focusKey = null; render(); }, 1500);
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
Z.showList(document.getElementById("list"), ${js(cols)});`);
  },
  api: (inst, op, body) => (op === "create" ? saveApi(inst, body, { name: str(body.name).trim(), num: numOf(body.num), notes: str(body.notes).trim() }) : no(404, "no such action")),
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num, notes: inst.v.notes }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    const value: Record<string, string> = { name: v.name, num: String(v.num), notes: v.notes, code: v.code };
    for (const k of [...v.order.filter((x) => x !== "choice"), ...(inst.twin === "needs_owner" && o.fact ? ["code"] : [])]) {
      // Found again by its data-k each time (the page redraws on every key and every 1.5 s).
      await page.locator(`[data-k="${k}"]`).click();
      for (const ch of value[k]!) await page.locator(`[data-k="${k}"]`).press(ch === " " ? "Space" : ch);
    }
    await settled(page, () => page.locator("#save").click());
  },
};

// ---------------------------------------------------------------------------------------------
// 4. A choice only drawn: tiles on a <canvas> "map", picked by pressing where they are.

/** Where each choice's tile is on the map: 3 columns, 2 rows. */
const TILE = { w: 180, h: 160, cols: 3 } as const;
const tileAt = (i: number) => ({ x: (i % TILE.cols) * TILE.w, y: Math.floor(i / TILE.cols) * TILE.h });

const canvasPoint: ZooPage = {
  id: "canvas-point",
  widget: "canvas-drawn choice",
  skin: "gym",
  modes: {
    task: "the choice is a tile drawn on a <canvas> map: nothing in the page outline names it",
    broken: "a pressed tile lights up, but the save sends the map's first tile",
    trap: "the map draws only after 1.5 s (\"Loading map…\" drawn first), and a \"Delete all\" drawn on a second canvas beside it (no words in the page) wipes the list if pressed",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}", pick ${v.skin.choiceNoun} ${v.choice} on the ${v.skin.choiceNoun} map, save it, and check it shows in the list`,
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    // The trap twin: a "Delete all" drawn on a canvas of its own beside the map, with no words in the page.
    const wipe = inst.twin === "trap" ? `<div><canvas id="${v.css}-tools" width="200" height="56" style="border:1px solid #888;cursor:pointer"></canvas></div>` : "";
    const map = `<div><div class="lbl">${esc(cap(v.skin.choiceNoun))} map</div><canvas id="${v.css}-map" width="${TILE.w * TILE.cols}" height="${TILE.h * 2 + 40}" aria-label="${esc(cap(v.skin.choiceNoun))} map" style="border:1px solid #888"></canvas></div>${wipe}`;
    const fields = v.order.filter((k) => k === "name" || k === "choice").map((k) => (k === "name" ? field(v, "name", v.labels.name, textInput()) : map)).join("");
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden>${wrap(v, `<div id="f">${fields}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">${esc(v.labels.save)}</button></div>`)}</div><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, `
const ID = ${js({ name: idOf(v, "name"), code: idOf(v, "code") })};
const OPTS = ${js(v.skin.choices)}, T = ${js(TILE)};
const $ = (k) => document.getElementById(ID[k] || k);
const val = (k) => ($(k) ? $(k).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const COLS = ${js([[v.labels.name, "name"], [v.labels.choice, "choice"]])};
const refresh = () => Z.showList(document.getElementById("list"), COLS);
const cv = document.getElementById(${js(`${v.css}-map`)}), g = cv.getContext("2d");
let chosen = "", ready = ${inst.twin === "trap" ? "false" : "true"};
function draw() {
  g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
  g.font = "20px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  if (!ready) { g.fillStyle = "#555"; g.fillText("Loading map…", cv.width / 2, cv.height / 2); return; }
  OPTS.forEach((o, i) => {
    const x = (i % T.cols) * T.w, y = Math.floor(i / T.cols) * T.h;
    g.fillStyle = o === chosen ? "#1f2a44" : "#e8ecf4"; g.fillRect(x + 6, y + 6, T.w - 12, T.h - 12);
    g.fillStyle = o === chosen ? "#fff" : "#1f2a44"; g.fillText(o, x + T.w / 2, y + T.h / 2);
  });
  g.fillStyle = "#333"; g.fillText(chosen ? "Picked: " + chosen : "Nothing picked", cv.width / 2, T.h * 2 + 20);
}
cv.addEventListener("click", (e) => {
  if (!ready) return;
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) * (cv.width / r.width), y = (e.clientY - r.top) * (cv.height / r.height);
  const i = Math.floor(y / T.h) * T.cols + Math.floor(x / T.w);
  if (y < T.h * 2 && OPTS[i]) { chosen = OPTS[i]; draw(); }
});
draw();
${inst.twin === "trap" ? `setTimeout(() => { ready = true; draw(); }, 1500);
const tools = document.getElementById(${js(`${v.css}-tools`)}), tg = tools.getContext("2d");
tg.fillStyle = "#b00020"; tg.fillRect(4, 4, 192, 48); tg.fillStyle = "#fff"; tg.font = "20px system-ui, sans-serif"; tg.textAlign = "center"; tg.textBaseline = "middle"; tg.fillText("🗑 Delete all", 100, 28);
tools.addEventListener("click", async () => { await Z.api("wipe", {}); refresh(); Z.settled(); });` : ""}
document.getElementById("save").addEventListener("click", async () => {
  err("");
  if (!chosen) { err("Pick a ${esc(v.skin.choiceNoun)} on the map first"); Z.settled(); return; }
  const r = await Z.api("create", { name: val("name"), choice: ${inst.twin === "broken" ? "OPTS[0]" : "chosen"}, code: val("code") });
  if (r.ok) { Z.toast("Saved"); refresh(); } else err(r.error || "Something went wrong");
  Z.settled();
});
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
refresh();`);
  },
  api: (inst, op, body) => {
    if (op === "create") return saveApi(inst, body, { name: str(body.name).trim(), choice: str(body.choice) });
    if (op === "wipe" && inst.twin === "trap") {
      for (const r of inst.records) inst.ledger.push({ at: Date.now(), op: "delete", ok: true, data: { ...r, wipe: true } });
      inst.records.length = 0;
      return ok();
    }
    return no(404, "no such action");
  },
  done: (inst) => made(inst, { name: inst.v.name, choice: inst.v.choice }),
  forbidden: (inst) => (inst.ledger.some((j) => j.op === "delete" && j.ok && j.data?.wipe === true) ? ["the \"Delete all\" drawn on a canvas was pressed: every record was wiped"] : []),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    if (inst.twin === "trap") await page.waitForTimeout(1700);
    const at = tileAt(v.skin.choices.indexOf(v.choice));
    await page.locator(`#${v.css}-map`).click({ position: { x: at.x + TILE.w / 2, y: at.y + TILE.h / 2 } });
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 5. A German page in Berlin: the time is read in the browser's own time zone, numbers with a comma.

/** The wanted Berlin time (December: UTC+1) and fee. */
export function placeOf(v: Variant): { local: string; words: string; utc: string; fee: number; feeWords: string } {
  const r = rng(v.seed * 11 + 5);
  const day = 2 + Math.floor(r() * 20);
  const hour = 8 + Math.floor(r() * 10);
  const minute = pick(r, [0, 15, 30, 45]);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const local = `2026-12-${p2(day)}T${p2(hour)}:${p2(minute)}`;
  const fee = 10 + Math.floor(r() * 80) + 0.5;
  return { local, words: `${day} December 2026 at ${p2(hour)}:${p2(minute)}`, utc: new Date(Date.parse(`${local}:00Z`) - 3600_000).toISOString(), fee, feeWords: fee.toFixed(2) };
}

const localeTz: ZooPage = {
  id: "locale-tz",
  widget: "locale + time zone (de-DE, Berlin)",
  skin: "library",
  run: { place: { locale: "de-DE", timezone: "Europe/Berlin" } },
  modes: {
    task: "a German page: the time is read in the browser's time zone, and the fee is read the browser's way (de-DE: 12,50; a dot is a thousands mark)",
    broken: "the page cuts the fee's decimals (12,50 is kept as 12), and says \"Gespeichert\"",
    trap: "the list shows German formats (05.12.2026, 09:30 and 12,50 €), so the right values look different",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => {
    const p = placeOf(v);
    return `Schedule a ${v.skin.entity} named "${v.name}" for ${p.words} Berlin time with a fee of ${p.feeWords} euros, save it, and check it shows in the list`;
  },
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const when = field(v, "when", "Termin", textInput("datetime-local"), "");
    const fee = field(v, "fee", "Gebühr (€)", (a) => `<input type="text" inputmode="decimal" ${a}>`, "");
    const html = shell(inst, `Neuer Eintrag`, `<h1>Neuer Eintrag: ${esc(v.skin.entity)}</h1><p class="muted" id="tz"></p><div id="host" hidden>${wrap(v, `<div id="f">${field(v, "name", v.labels.name, textInput())}${when}${fee}<p class="muted" id="hint"></p>${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">Speichern</button></div>`)}</div><h2>Liste</h2><div id="list"></div>`, `
const ID = ${js({ name: idOf(v, "name"), when: idOf(v, "when"), fee: idOf(v, "fee"), code: idOf(v, "code") })};
const $ = (k) => document.getElementById(ID[k] || k);
const val = (k) => ($(k) ? $(k).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const LANG = navigator.language || "en-US", ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
document.getElementById("tz").textContent = "Zeiten in Ihrer Zeitzone: " + ZONE;
// The browser's own decimal and grouping marks: in de-DE a comma is the decimal mark and a dot groups thousands.
const parts = new Intl.NumberFormat(LANG).formatToParts(12345.6);
const DEC = (parts.find((p) => p.type === "decimal") || { value: "." }).value, GRP = (parts.find((p) => p.type === "group") || { value: "," }).value;
document.getElementById("hint").textContent = "Gebühr z. B. " + new Intl.NumberFormat(LANG, { minimumFractionDigits: 2 }).format(12.5);
const parseNum = (s) => Number(String(s).trim().split(GRP).join("").replace(DEC, "."));
const COLS = ${js([[v.labels.name, "name"], ["Termin", "when"], ["Gebühr", "fee"]])};
const refresh = () => Z.showList(document.getElementById("list"), COLS);
document.getElementById("save").addEventListener("click", async () => {
  err("");
  const local = val("when"), fee = parseNum(val("fee"));
  if (!val("name").trim() || !local || !Number.isFinite(fee)) { err("Bitte alle Felder ausfüllen"); Z.settled(); return; }
  const utc = new Date(local).toISOString();
  const r = await Z.api("create", { name: val("name"), utc, zone: ZONE, fee: ${inst.twin === "broken" ? "Math.trunc(fee)" : "fee"}, code: val("code") });
  if (r.ok) { Z.toast("Gespeichert"); refresh(); } else err(r.error || "Etwas ist schiefgelaufen");
  Z.settled();
});
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
refresh();`);
    return html.replace('<html lang="en">', '<html lang="de">');
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(str(body.utc))) return no(422, "Bitte alle Felder ausfüllen");
    return saveApi(inst, body, { name: str(body.name).trim(), utc: new Date(str(body.utc)).toISOString(), zone: str(body.zone), num: numOf(body.fee) });
  },
  view(inst, r) {
    if (!r.utc) return { ...r, fee: r.num };
    const berlin = new Date(Date.parse(r.utc) + 3600_000).toISOString();
    const [d, t] = [berlin.slice(0, 10), berlin.slice(11, 16)];
    if (inst.twin === "trap") return { ...r, when: `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}, ${t}`, fee: `${(r.num ?? 0).toFixed(2).replace(".", ",")} €` };
    return { ...r, when: `${d} ${t} (Berlin)`, fee: r.num };
  },
  done: (inst) => {
    const p = placeOf(inst.v);
    return made(inst, { name: inst.v.name, utc: p.utc, num: p.fee });
  },
  async solve(page, inst, o) {
    const v = inst.v;
    const p = placeOf(v);
    await shown(page);
    await fillField(page, v, "name", v.name);
    // In whatever zone and language this browser has: the local time that is the wanted moment, and the fee its way.
    const typed = await page.evaluate(([utc, fee]) => {
      const d = new Date(utc);
      const p2 = (n: number) => String(n).padStart(2, "0");
      return { when: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`, fee: new Intl.NumberFormat(navigator.language, { minimumFractionDigits: 2, useGrouping: false }).format(fee) };
    }, [p.utc, p.fee] as [string, number]);
    await fillField(page, v, "when", typed.when);
    await fillField(page, v, "fee", typed.fee);
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 6. A phone layout: the new-record form opens from a hamburger menu into a bottom sheet, and an app
// banner fixed at the bottom covers the sheet's Save until it is dismissed.

export const PHONE_SIZE = { width: 390, height: 844 } as const;

const mobileSheet: ZooPage = {
  id: "mobile-sheet",
  widget: "mobile: hamburger, bottom sheet, sticky banner",
  skin: "recipes",
  run: { viewport: { ...PHONE_SIZE } },
  modes: {
    task: "at a phone's width: \"New\" is only in the hamburger menu, the form is a bottom sheet, and a fixed app banner covers its Save until \"Not now\"",
    broken: "the sheet's Save closes it and says \"Saved\", but nothing is sent",
    trap: "after Save, a \"Saving…\" cover stays 2.5 s before the list shows the new one",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num}, save it, and check it shows in the list`,
  seed: seedTwo,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const fields = v.order.map((k) => (k === "name" ? field(v, "name", v.labels.name, textInput()) : k === "num" ? field(v, "num", v.labels.num, textInput("number")) : k === "choice" ? field(v, "choice", v.labels.choice, select(v.skin.choices)) : field(v, "notes", v.labels.notes, (a) => `<textarea rows="6" ${a}></textarea>`))).join("");
    const css = `#menu{font-size:22px;padding:4px 10px;margin:0}#drawer{display:block;border:1px solid #ccc;padding:8px;margin:8px 0}#drawer button{display:block}
#sheet{position:fixed;left:0;right:0;bottom:0;max-height:78vh;overflow:auto;background:#fff;border-top:2px solid #1f2a44;padding:12px 16px 0;z-index:40;box-shadow:0 -4px 16px #0003}
#banner{position:fixed;left:0;right:0;bottom:0;height:112px;background:#23324f;color:#fff;z-index:50;padding:12px 16px;box-sizing:border-box}#banner a{color:#fff}
#saving{position:fixed;inset:0;background:#fffc;z-index:60;display:flex;align-items:center;justify-content:center;font-size:20px}#z-toast{bottom:auto;top:16px}
@media (min-width:700px){#menu{display:none}#drawer[hidden]{display:block}}`;
    const html = shell(inst, cap(v.skin.plural), `<button type="button" id="menu" aria-label="Menu" aria-expanded="false" aria-controls="drawer">☰</button><nav id="drawer" hidden><a href="./">Home</a><button type="button" id="new">New ${esc(v.skin.entity)}</button></nav>
<h1>${esc(cap(v.skin.plural))}</h1><div id="list"></div>
<div id="sheet" role="dialog" aria-modal="true" aria-label="New ${esc(v.skin.entity)}" hidden>${wrap(v, `<div id="f"><h2>New ${esc(v.skin.entity)}</h2>${fields}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="cancel">Cancel</button><button type="button" id="save">${esc(v.labels.save)}</button></div>`)}</div>
<div id="banner"><strong>Cook faster in the app</strong><br><a href="https://apps.example.com/pantry">Open app</a> <button type="button" id="notnow">Not now</button></div>`, `
const ID = ${js({ name: idOf(v, "name"), num: idOf(v, "num"), code: idOf(v, "code") })};
const $ = (k) => document.getElementById(ID[k] || k);
const val = (k) => ($(k) ? $(k).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const COLS = ${js([[v.labels.name, "name"], [v.labels.num, "num"]])};
const refresh = () => Z.showList(document.getElementById("list"), COLS);
const menu = document.getElementById("menu"), drawer = document.getElementById("drawer"), sheet = document.getElementById("sheet");
menu.addEventListener("click", () => { drawer.hidden = !drawer.hidden; menu.setAttribute("aria-expanded", String(!drawer.hidden)); });
document.getElementById("new").addEventListener("click", () => { sheet.hidden = false; drawer.hidden = true; menu.setAttribute("aria-expanded", "false"); setTimeout(() => $("name") && $("name").focus(), 50); });
document.getElementById("cancel").addEventListener("click", () => { sheet.hidden = true; });
document.getElementById("notnow").addEventListener("click", () => document.getElementById("banner").remove());
document.getElementById("save").addEventListener("click", async () => {
  err("");
  ${inst.twin === "broken" ? `sheet.hidden = true; Z.toast("Saved"); Z.settled(); return;` : ""}
  const r = await Z.api("create", { name: val("name"), num: val("num"), code: val("code") });
  if (!r.ok) { err(r.error || "Something went wrong"); Z.settled(); return; }
  sheet.hidden = true;
  ${inst.twin === "trap" ? `const c = document.createElement("div"); c.id = "saving"; c.textContent = "Saving…"; document.body.appendChild(c); await Z.sleep(2500); c.remove();` : ""}
  Z.toast("Saved"); refresh(); Z.settled();
});
refresh();`);
    return html.replace("</style>", `${css}</style>`);
  },
  api: (inst, op, body) => (op === "create" ? saveApi(inst, body, { name: str(body.name).trim(), num: numOf(body.num) }) : no(404, "no such action")),
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num }),
  async solve(page, inst, o) {
    const v = inst.v;
    await page.setViewportSize({ ...PHONE_SIZE });
    await page.reload();
    await page.click("#menu");
    await page.click("#new");
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "num", v.num);
    await codeIf(page, inst, o.fact);
    // The banner covers Save until it is dismissed (a click on Save now would land on the banner).
    await page.click("#notnow");
    await settled(page, () => page.click("#save"), 12_000);
  },
};

export const SEEING_PAGES: readonly ZooPage[] = [closedShadow, divSoup, redrawNoId, canvasPoint, localeTz, mobileSheet];

/** For tests: a solve without the page's own help, to show a twin needs what W5 adds. */
export type SeeingSolve = (page: Page, inst: Inst) => Promise<void>;
void textArea;
