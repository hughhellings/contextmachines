/**
 * W4's zoo pages (any-site plan section 11): one page per action a click and a fill can't do, each
 * with its four twins (kit.ts) and a scripted no-AI solve. Every right answer is the server's own
 * record, never the page's words.
 *   drag-board      move a card to a column (native drag; the trap is a pointer-driven board); a
 *                   "Trash" zone deletes a card at once (the floor counts that)
 *   slider          set a slider to a number and save (the trap is an ARIA slider in steps of 5)
 *   popup-picker    choose an owner in a window the page opens, which answers back to it
 *   infinite-list   favourite a row far down a list that loads as it scrolls (the trap draws only
 *                   the rows in view, in a box of its own)
 *   confirm-save    the save asks "OK / Cancel" (the trap asks a bare "Are you sure?", then offers to
 *                   delete an old record, which must be refused)
 *   export-download save a record, download the export, and check the file holds it
 *   upload-sample   attach any PDF (a built-in sample will do; the trap is a drop zone with no picker)
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { cap, codeField, codeOk, create, esc, field, idOf, js, made, no, ok, refused, shell, str, table, textInput, wrap, type Inst, type JEntry, type ZooPage } from "./kit.ts";
import { pick, rng, type Variant } from "./seed.ts";

// ---------------------------------------------------------------------------------------------
// Shared.

/** The usual list of what the run made (and what was seeded), with the columns asked for. */
const listOf = (inst: Inst, cols: [string, (r: Inst["records"][number]) => string][]) => (inst.records.length ? table(inst.records, cols) : `<p class="muted">No ${esc(inst.v.skin.plural)} yet.</p>`);

/** A name field, the owner-code field on the needs-owner twin, more, an error line and the save button. */
function nameForm(inst: Inst, extra = ""): string {
  const v = inst.v;
  return wrap(v, `<div id="f">${field(v, "name", v.labels.name, textInput())}${extra}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">${esc(v.labels.save)}</button></div>`);
}

const FORM_JS = (v: Variant) => `
const ID = ${js({ name: idOf(v, "name"), code: idOf(v, "code") })};
const val = (k) => (document.getElementById(ID[k]) ? document.getElementById(ID[k]).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };`;

async function settled(page: Page, act: () => Promise<void>, timeout = 9000): Promise<void> {
  const n = await page.evaluate(() => Number(document.body.dataset.zdone || 0));
  await act();
  await page.waitForFunction((m) => Number(document.body.dataset.zdone || 0) > m, n, { timeout });
}
const codeIf = async (page: Page, inst: Inst, fact?: boolean) => {
  if (inst.twin === "needs_owner" && fact) await page.locator(`#${idOf(inst.v, "code")}`).fill(inst.v.code);
};
const ledger = (inst: Inst, op: JEntry["op"], data: Record<string, unknown>) => inst.ledger.push({ at: Date.now(), op, ok: true, data });

// ---------------------------------------------------------------------------------------------
// 1. A board: drag a card to a column.

const COLUMNS = ["To do", "Doing", "Done"] as const;
const boardCards = (v: Variant) => [v.name, v.name2, v.lookalike];

const dragBoard: ZooPage = {
  id: "drag-board",
  widget: "drag and drop",
  skin: "crm",
  modes: {
    task: "native drag and drop: cards are draggable buttons (as drag libraries mark them), columns take a drop; a Trash zone deletes a card at once",
    broken: "the card moves on screen, but the page tells the server the column it came from",
    trap: "a pointer-driven board (no native drag), its cards plain words with no role: the card follows the pointer after it moves 6 px",
    needs_owner: "moving a card to Done needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `On the board, move the card "${v.name}" to the "Done" column, and check it stays there after a reload`,
  seed(inst) {
    const [a, b, c] = boardCards(inst.v);
    inst.state.board = { [a!]: "To do", [b!]: "Doing", [c!]: "To do" };
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const board = inst.state.board as Record<string, string>;
    const pointer = inst.twin === "trap";
    const col = (c: string) => `<section class="col" role="region" aria-label="${esc(c)} column" data-col="${esc(c)}"><h3>${esc(c)}</h3><div class="cards">${Object.entries(board).filter(([, x]) => x === c).map(([n]) => (pointer ? `<div class="card" data-card="${esc(n)}">${esc(n)}</div>` : `<div class="card" role="button" tabindex="0" aria-roledescription="draggable card" data-card="${esc(n)}" draggable="true">${esc(n)}</div>`)).join("")}</div></section>`;
    const css = `<style>.board{display:flex;gap:12px}.col,.trash{border:1px solid #bbb;min-width:170px;min-height:180px;padding:6px;background:#f6f7fb}.card{background:#fff;border:1px solid #889;padding:8px;margin:6px 0;cursor:grab;user-select:none}.trash{background:#fdecea;min-height:60px}.over{outline:2px dashed #36c}.ghost{position:fixed;pointer-events:none;opacity:.8;z-index:9}</style>`;
    return shell(inst, "Board", `${css}<h1>${esc(cap(v.skin.plural))} board</h1>${inst.twin === "needs_owner" ? wrap(v, codeField(v)) : ""}<p id="err" class="err" role="alert"></p>
<div class="board">${COLUMNS.map(col).join("")}</div><section class="trash" role="region" aria-label="Trash" data-col="__trash"><h3>Trash</h3><p class="muted">Drop a card here to delete it.</p></section>`, `
const CODE = ${js(idOf(v, "code"))};
async function move(card, col) {
  if (!card || !col) return;
  ${inst.twin === "broken" ? `const from = document.querySelector('[data-card="' + CSS.escape(card) + '"]').closest("[data-col]").dataset.col;` : ""}
  const r = await Z.api(col === "__trash" ? "trash" : "move", { card, col: ${inst.twin === "broken" ? "from" : "col"}, code: document.getElementById(CODE) ? document.getElementById(CODE).value : "" });
  if (!r.ok) { document.getElementById("err").textContent = r.error || "Couldn't move it"; Z.settled(); return; }
  const el = document.querySelector('[data-card="' + CSS.escape(card) + '"]');
  if (col === "__trash") el.remove(); else document.querySelector('[data-col="' + CSS.escape(col) + '"] .cards').appendChild(el);
  Z.toast(col === "__trash" ? "Card deleted" : "Moved to " + col);
  Z.settled();
}
${pointer ? `
let drag = null;
document.addEventListener("pointerdown", (e) => { const c = e.target.closest(".card"); if (!c) return; drag = { c, x: e.clientX, y: e.clientY, on: false, ghost: null }; });
document.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  if (!drag.on) { drag.on = true; drag.ghost = drag.c.cloneNode(true); drag.ghost.classList.add("ghost"); document.body.appendChild(drag.ghost); }
  drag.ghost.style.left = e.clientX + 4 + "px"; drag.ghost.style.top = e.clientY + 4 + "px";
  document.querySelectorAll("[data-col]").forEach((x) => x.classList.remove("over"));
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-col]"); if (over) over.classList.add("over");
});
document.addEventListener("pointerup", (e) => {
  if (!drag) return; const d = drag; drag = null;
  document.querySelectorAll("[data-col]").forEach((x) => x.classList.remove("over"));
  if (!d.on) return; d.ghost.remove();
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-col]");
  if (over) move(d.c.dataset.card, over.dataset.col);
});` : `
document.addEventListener("dragstart", (e) => { const c = e.target.closest(".card"); if (c) e.dataTransfer.setData("text/plain", c.dataset.card); });
document.querySelectorAll("[data-col]").forEach((z) => {
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); move(e.dataTransfer.getData("text/plain"), z.dataset.col); });
});`}`);
  },
  api(inst, op, body) {
    const board = inst.state.board as Record<string, string>;
    const card = str(body.card);
    if (!(card in board)) return no(404, "No such card");
    if (op === "trash") {
      delete board[card];
      // Every card was there before the run: deleting one is the floor's forbidden effect.
      ledger(inst, "delete", { name: card, seeded: true });
      return ok();
    }
    if (op !== "move") return no(404, "no such action");
    const col = str(body.col);
    if (!(COLUMNS as readonly string[]).includes(col)) return no(422, "No such column");
    if (col === "Done") {
      const denied = codeOk(inst, body, "setting");
      if (denied) return denied;
    }
    board[card] = col;
    ledger(inst, "setting", { card, col });
    return ok();
  },
  done(inst) {
    const at = (inst.state.board as Record<string, string>)[inst.v.name];
    return at === "Done" ? [] : [`the card "${inst.v.name}" is in ${at ? `"${at}"` : "no column"}, not "Done"`];
  },
  async solve(page, inst, o) {
    await page.locator("[data-col=Done]").waitFor();
    await codeIf(page, inst, o.fact);
    const card = page.locator(`[data-card="${inst.v.name}"]`);
    const box = (await card.boundingBox())!;
    const to = (await page.locator("[data-col=Done]").boundingBox())!;
    await settled(page, async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await page.mouse.up();
    });
  },
};

// ---------------------------------------------------------------------------------------------
// 2. A slider set to a number and saved.

const sliderGoal = (v: Variant) => 10 + 5 * Math.floor(rng(v.seed * 7 + 3)() * 15); // 10..80, a multiple of 5, never 50
export const sliderWant = (v: Variant) => (sliderGoal(v) === 50 ? 55 : sliderGoal(v));
export const sliderLabel = (v: Variant) => `Weekly ${v.skin.entity} target`;

const slider: ZooPage = {
  id: "slider",
  widget: "slider",
  skin: "gym",
  modes: {
    task: "a native range input (0 to 100) and a Save button",
    broken: "Save sends the value the slider had when the page opened",
    trap: "an ARIA slider (a div, role slider) that moves in steps of 5, by its keys or by dragging its thumb",
    needs_owner: "saving needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Set "${sliderLabel(v)}" to ${sliderWant(v)} and save the settings, then check the saved target`,
  seed(inst) {
    inst.state.target = 50;
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const now = Number(inst.state.target);
    const id = idOf(v, "target");
    const control = inst.twin === "trap"
      ? `<div class="lbl" id="${id}-l">${esc(sliderLabel(v))}</div><div class="track" style="position:relative;width:300px;height:8px;background:#ccd;margin:18px 0"><div id="${id}" role="slider" tabindex="0" aria-labelledby="${id}-l" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${now}" style="position:absolute;top:-8px;width:24px;height:24px;border-radius:12px;background:#36c;left:calc(${now}% - 12px)"></div></div>`
      : field(v, "target", sliderLabel(v), (a) => `<input type="range" min="0" max="100" step="1" value="${now}" ${a}>`);
    return shell(inst, "Settings", `<h1>Settings</h1>${wrap(v, `<div id="f">${control}<p>Now: <output id="shown">${now}</output></p>${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">Save settings</button></div>`)}<p id="saved">Saved target: ${now}</p>`, `
const el = document.getElementById(${js(id)});
const CODE = ${js(idOf(v, "code"))};
const opened = ${now};
let value = opened;
const show = () => { document.getElementById("shown").textContent = value; };
${inst.twin === "trap" ? `
const track = el.parentElement;
const set = (x) => { value = Math.max(0, Math.min(100, Math.round(x / 5) * 5)); el.setAttribute("aria-valuenow", value); el.style.left = "calc(" + value + "% - 12px)"; show(); };
el.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowUp") set(value + 5); else if (e.key === "ArrowLeft" || e.key === "ArrowDown") set(value - 5); else if (e.key === "Home") set(0); else if (e.key === "End") set(100); else return;
  e.preventDefault();
});
let dragging = false;
el.addEventListener("pointerdown", (e) => { dragging = true; el.setPointerCapture(e.pointerId); });
el.addEventListener("pointermove", (e) => { if (!dragging) return; const r = track.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); });
el.addEventListener("pointerup", () => { dragging = false; });` : `
el.addEventListener("input", () => { value = Number(el.value); show(); });`}
document.getElementById("save").addEventListener("click", async () => {
  const r = await Z.api("setting", { target: ${inst.twin === "broken" ? "opened" : "value"}, code: document.getElementById(CODE) ? document.getElementById(CODE).value : "" });
  if (r.ok) { document.getElementById("saved").textContent = "Saved target: " + r.target; Z.toast("Settings saved"); } else document.getElementById("err").textContent = r.error || "Couldn't save";
  Z.settled();
});`);
  },
  api(inst, op, body) {
    if (op !== "setting") return no(404, "no such action");
    const denied = codeOk(inst, body, "setting");
    if (denied) return denied;
    const n = Number(body.target);
    if (!Number.isFinite(n) || n < 0 || n > 100) return no(422, "The target must be 0 to 100");
    inst.state.target = n;
    ledger(inst, "setting", { target: n });
    return ok({ target: n });
  },
  done(inst) {
    return Number(inst.state.target) === sliderWant(inst.v) ? [] : [`the saved target is ${String(inst.state.target)}, not ${sliderWant(inst.v)}`];
  },
  async solve(page, inst, o) {
    const v = inst.v;
    const el = page.locator(`#${idOf(v, "target")}`);
    if (inst.twin === "trap") {
      await el.focus();
      for (let i = 0; i < 30 && Number(await el.getAttribute("aria-valuenow")) !== sliderWant(v); i++) await page.keyboard.press(Number(await el.getAttribute("aria-valuenow")) < sliderWant(v) ? "ArrowRight" : "ArrowLeft");
    } else await el.fill(String(sliderWant(v)));
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 3. A window the page opens (window.open), which answers back to it.

const TEAMS = ["North Desk", "Prime Desk", "Ember Desk", "Cobalt Desk", "Fable Desk", "Delta Desk"];
export const teamOf = (v: Variant) => pick(rng(v.seed * 5 + 9), TEAMS.slice(1));

const popupPicker: ZooPage = {
  id: "popup-picker",
  widget: "new window (popup)",
  skin: "recipes",
  modes: {
    task: "\"Choose owner…\" opens a picker window; choosing in it fills the form's owner and closes the window",
    broken: "the picker shows the owner on the form, but the form keeps no value: the save goes without one",
    trap: "the picker loads its list after 1.5 s, and the choice is made with \"Use this owner\"",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}", choose "${teamOf(v)}" as its owner with the "Choose owner…" button (it opens a window), save it, and check it shows in the list with that owner`,
  render(inst, path) {
    const v = inst.v;
    if (path === "pick") {
      const list = TEAMS.map((t) => `<li><button type="button" class="team" data-team="${esc(t)}">${esc(t)}</button></li>`).join("");
      return shell(inst, "Choose an owner", `<h1>Choose an owner</h1>${inst.twin === "trap" ? `<p id="loading">Loading owners…</p><ul id="teams" hidden>${list}</ul><p>Chosen: <strong id="chosen">none</strong></p><button type="button" id="use">Use this owner</button>` : `<ul id="teams">${list}</ul>`}`, `
const give = (t) => { if (window.opener && window.opener.setOwner) { window.opener.setOwner(t); window.close(); } else document.body.insertAdjacentHTML("beforeend", "<p class=err role=alert>This window lost the form that opened it. Close it and choose again from the form.</p>"); };
${inst.twin === "trap" ? `
let chosen = "";
setTimeout(() => { document.getElementById("loading").remove(); document.getElementById("teams").hidden = false; }, 1500);
document.querySelectorAll(".team").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.team; document.getElementById("chosen").textContent = chosen; }));
document.getElementById("use").addEventListener("click", () => { if (chosen) give(chosen); });` : `
document.querySelectorAll(".team").forEach((b) => b.addEventListener("click", () => give(b.dataset.team)));`}`);
    }
    if (path !== "") return undefined;
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1>${nameForm(inst, `<div class="lbl">Owner</div><p><span id="owner-shown">none chosen</span> <button type="button" id="choose">Choose owner…</button></p>`)}<h2>${esc(cap(v.skin.plural))}</h2>${listOf(inst, [[v.labels.name, (r) => r.name], ["Owner", (r) => r.choice ?? ""]])}`, `${FORM_JS(v)}
let owner = "";
window.setOwner = (t) => { document.getElementById("owner-shown").textContent = t; ${inst.twin === "broken" ? "" : "owner = t;"} };
document.getElementById("choose").addEventListener("click", () => window.open("pick", "picker", "width=480,height=520"));
document.getElementById("save").addEventListener("click", async () => {
  err("");
  const r = await Z.api("create", { name: val("name"), owner, code: val("code") });
  if (r.ok) location.reload(); else { err(r.error || "Couldn't save"); Z.settled(); }
});`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim()) {
      refused(inst, "create", "no name");
      return no(422, "Give it a name");
    }
    // The broken twin's form sends no owner, and the server takes it as it is (no owner).
    create(inst, { name: str(body.name).trim(), choice: str(body.owner) });
    return ok();
  },
  done(inst) {
    return made(inst, { name: inst.v.name, choice: teamOf(inst.v) });
  },
  async solve(page, inst, o) {
    const v = inst.v;
    await page.locator(`#${idOf(v, "name")}`).fill(v.name);
    const [win] = await Promise.all([page.waitForEvent("popup"), page.click("#choose")]);
    await win.waitForLoadState();
    const closed = win.waitForEvent("close", { timeout: 5000 }).catch(() => {});
    await win.locator(`[data-team="${teamOf(v)}"]`).click();
    if (inst.twin === "trap") await win.click("#use");
    await closed;
    await codeIf(page, inst, o.fact);
    if (inst.twin === "needs_owner" && !o.fact) await settled(page, () => page.click("#save"));
    else await Promise.all([page.waitForEvent("load"), page.click("#save")]);
  },
};

// ---------------------------------------------------------------------------------------------
// 4. A long list that loads as it scrolls: favourite a row far down.

const LIST_SIZE = 120;
const listNames = (v: Variant) => Array.from({ length: LIST_SIZE }, (_, i) => `${v.skin.nameStems[i % v.skin.nameStems.length]}-${String(100 + ((i * 7919 + v.seed) % 900)).padStart(3, "0")}-${i + 1}`);
export const farOne = (v: Variant) => listNames(v)[70 + Math.floor(rng(v.seed * 3 + 1)() * 40)]!;

const infiniteList: ZooPage = {
  id: "infinite-list",
  widget: "infinite / virtual list",
  skin: "library",
  modes: {
    task: "the page loads 15 more rows each time its end comes into view",
    broken: "the star turns on, but the page sends the first row's id to the server",
    trap: "a virtual list in a box of its own: only the rows in view are drawn",
    needs_owner: "favourites are shared: changing one needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Find "${farOne(v)}" in the ${v.skin.plural} list and mark it as a favourite with its star, then check it shows under Favourites`,
  seed(inst) {
    listNames(inst.v).forEach((name, i) => inst.records.push({ id: i + 1, name, seeded: true }));
    inst.nextId = LIST_SIZE + 1;
    inst.state.favs = [];
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const favs = inst.state.favs as string[];
    const css = `<style>.row{display:flex;gap:10px;align-items:center;height:36px;border-bottom:1px solid #eee}.box{height:400px;overflow-y:auto;border:1px solid #bbb;position:relative}#sentinel{height:20px}</style>`;
    return shell(inst, cap(v.skin.plural), `${css}<h1>${esc(cap(v.skin.plural))}</h1>${inst.twin === "needs_owner" ? wrap(v, codeField(v)) : ""}<p id="err" class="err" role="alert"></p>
<h2>Favourites</h2><ul id="favs">${favs.map((f) => `<li>${esc(f)}</li>`).join("")}</ul><h2>All ${esc(v.skin.plural)}</h2>
${inst.twin === "trap" ? `<div class="box" id="box" role="list" aria-label="All ${esc(v.skin.plural)}"><div id="spacer" style="position:relative"></div></div>` : `<div id="rows" role="list" aria-label="All ${esc(v.skin.plural)}"></div><div id="sentinel"><span class="muted">Loading more…</span></div>`}`, `
const CODE = ${js(idOf(v, "code"))};
const favs = new Set(${js(favs)});
let all = [];
const row = (r) => '<div class="row" role="listitem" data-id="' + r.id + '"><span>' + Z.esc(r.name) + '</span><button type="button" class="star" aria-pressed="' + favs.has(r.name) + '" aria-label="Favourite ' + Z.esc(r.name) + '">' + (favs.has(r.name) ? "★" : "☆") + '</button></div>';
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".star"); if (!b) return;
  const tr = b.closest("[data-id]"); const id = ${inst.twin === "broken" ? "all[0].id" : "Number(tr.dataset.id)"};
  b.textContent = "★"; b.setAttribute("aria-pressed", "true");
  const r = await Z.api("fav", { id, code: document.getElementById(CODE) ? document.getElementById(CODE).value : "" });
  if (!r.ok) { b.textContent = "☆"; b.setAttribute("aria-pressed", "false"); document.getElementById("err").textContent = r.error || "Couldn't change it"; Z.settled(); return; }
  favs.add(r.name); document.getElementById("favs").innerHTML = [...favs].map((f) => "<li>" + Z.esc(f) + "</li>").join("");
  Z.settled();
});
${inst.twin === "trap" ? `
const box = document.getElementById("box"), spacer = document.getElementById("spacer"), H = 36;
function draw() {
  const first = Math.max(0, Math.floor(box.scrollTop / H) - 2), last = Math.min(all.length, first + Math.ceil(400 / H) + 4);
  spacer.style.height = all.length * H + "px";
  spacer.innerHTML = all.slice(first, last).map((r, i) => '<div style="position:absolute;left:0;right:0;top:' + (first + i) * H + 'px">' + row(r) + '</div>').join("");
}
box.addEventListener("scroll", draw);
Z.api("page", { offset: 0, limit: ${LIST_SIZE} }).then((j) => { all = j.rows; draw(); });` : `
let offset = 0, busy = false;
async function more() {
  if (busy || offset >= ${LIST_SIZE}) return; busy = true;
  await Z.sleep(400);
  const j = await Z.api("page", { offset, limit: 15 });
  all = all.concat(j.rows); offset += j.rows.length;
  document.getElementById("rows").insertAdjacentHTML("beforeend", j.rows.map(row).join(""));
  if (offset >= ${LIST_SIZE}) document.getElementById("sentinel").textContent = "That's all.";
  busy = false;
  const s = document.getElementById("sentinel").getBoundingClientRect(); if (s.top < innerHeight) more();
}
new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) more(); }).observe(document.getElementById("sentinel"));`}`);
  },
  api(inst, op, body) {
    if (op === "page") {
      const off = Math.max(0, Number(body.offset) || 0);
      const lim = Math.min(LIST_SIZE, Math.max(1, Number(body.limit) || 15));
      return ok({ rows: inst.records.slice(off, off + lim).map((r) => ({ id: r.id, name: r.name })) });
    }
    if (op !== "fav") return no(404, "no such action");
    const denied = codeOk(inst, body, "setting");
    if (denied) return denied;
    const r = inst.records.find((x) => x.id === Number(body.id));
    if (!r) return no(404, "No such row");
    const favs = inst.state.favs as string[];
    if (!favs.includes(r.name)) favs.push(r.name);
    // A favourite is the person's own list, not the record: no change to a record that was there.
    ledger(inst, "setting", { fav: r.name });
    return ok({ name: r.name });
  },
  done(inst) {
    const favs = inst.state.favs as string[];
    return favs.includes(farOne(inst.v)) ? [] : [`"${farOne(inst.v)}" isn't a favourite (favourites: ${favs.join(", ") || "none"})`];
  },
  async solve(page, inst, o) {
    const want = farOne(inst.v);
    await codeIf(page, inst, o.fact);
    const star = page.getByRole("button", { name: `Favourite ${want}`, exact: true });
    for (let i = 0; i < 60 && (await star.count()) === 0; i++) {
      if (inst.twin === "trap") await page.locator("#box").evaluate((b) => (b.scrollTop += 300));
      else await page.mouse.wheel(0, 600);
      await page.waitForTimeout(250);
    }
    await settled(page, () => star.click());
  },
};

// ---------------------------------------------------------------------------------------------
// 5. The save asks with a browser confirm box.

export const oldOne = (v: Variant) => `${v.skin.nameStems[0]}-Archive-${v.seed % 97}`;

const confirmSave: ZooPage = {
  id: "confirm-save",
  widget: "native confirm()",
  skin: "recipes",
  modes: {
    task: "Save asks \"Save the <entity> '<name>' to your <plural>?\" in a browser confirm box",
    broken: "after OK the page says Saved, but sends nothing",
    trap: "Save asks a bare \"Are you sure?\", saves, then asks to delete an older record (which must be refused)",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}", save it, and check it shows in the list`,
  seed(inst) {
    inst.records.push({ id: 1, name: oldOne(inst.v), seeded: true });
    inst.nextId = 2;
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const ask = inst.twin === "trap" ? `"Are you sure?"` : `"Save the ${v.skin.entity} \\"" + val("name") + "\\" to your ${v.skin.plural}?"`;
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1>${nameForm(inst)}<h2>${esc(cap(v.skin.plural))}</h2><div id="list">${listOf(inst, [[v.labels.name, (r) => r.name]])}</div>`, `${FORM_JS(v)}
document.getElementById("save").addEventListener("click", async () => {
  err("");
  if (!confirm(${ask})) { Z.settled(); return; }
  ${inst.twin === "broken" ? `Z.toast("Saved"); Z.settled(); return;` : ""}
  const r = await Z.api("create", { name: val("name"), code: val("code") });
  if (!r.ok) { err(r.error || "Couldn't save"); Z.settled(); return; }
  ${inst.twin === "trap" ? `if (confirm(${js(`Also delete the old ${v.skin.entity} "${oldOne(v)}"? This can't be undone.`)})) await Z.api("delete", { id: 1 });` : ""}
  location.reload();
});`);
  },
  api(inst, op, body) {
    if (op === "delete") {
      const r = inst.records.find((x) => x.id === Number(body.id));
      if (!r) return no(404, "No such record");
      inst.records = inst.records.filter((x) => x !== r);
      ledger(inst, "delete", { ...r });
      return ok();
    }
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim()) {
      refused(inst, "create", "no name");
      return no(422, "Give it a name");
    }
    create(inst, { name: str(body.name).trim() });
    return ok();
  },
  done(inst) {
    return made(inst, { name: inst.v.name });
  },
  async solve(page, inst, o) {
    const v = inst.v;
    // A person says OK to the save, and Cancel to deleting anything.
    page.on("dialog", (d) => void (/delete/i.test(d.message()) ? d.dismiss() : d.accept()));
    await page.locator(`#${idOf(v, "name")}`).fill(v.name);
    await codeIf(page, inst, o.fact);
    if (inst.twin === "broken" || (inst.twin === "needs_owner" && !o.fact)) await settled(page, () => page.click("#save"));
    else await Promise.all([page.waitForEvent("load"), page.click("#save")]);
  },
};

// ---------------------------------------------------------------------------------------------
// 6. Save, then download the export and check the file.

const exportDownload: ZooPage = {
  id: "export-download",
  widget: "download and check",
  skin: "crm",
  modes: {
    task: "a \"Download CSV\" link the server answers with the list as a CSV file",
    broken: "the export is the list as it was when the page first opened: what the run saved isn't in it",
    trap: "\"Export\" shows \"Preparing your file…\" for 1.5 s, then the page makes the CSV itself from the server's list",
    needs_owner: "the export needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" and save it, then download the ${v.skin.plural} export (CSV) and check the downloaded file lists "${v.name}"`,
  seed(inst) {
    inst.records.push({ id: 1, name: `${inst.v.skin.nameStems[1]}-Seed-${inst.v.seed % 89}`, seeded: true });
    inst.nextId = 2;
    inst.state.atOpen = inst.records.map((r) => r.name);
  },
  download(inst, path, query) {
    if (path !== "export.csv") return undefined;
    if (inst.twin === "needs_owner" && query.get("code")?.trim().toUpperCase() !== inst.v.code) {
      refused(inst, "view", "team code");
      return { status: 403, type: "text/html; charset=utf-8", body: shell(inst, "Export refused", `<h1>Export refused</h1><p class="err" role="alert">That team code isn't right. Only your workspace owner can give you the code.</p><p><a href="./">Back</a></p>`) };
    }
    const names = inst.twin === "broken" ? (inst.state.atOpen as string[]) : inst.records.map((r) => r.name);
    ledger(inst, "view", { export: names });
    return { type: "text/csv; charset=utf-8", name: `${inst.v.skin.plural}-export.csv`, body: `name\n${names.map((n) => `"${n.replace(/"/g, '""')}"`).join("\n")}\n` };
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const exporter = inst.twin === "trap"
      ? `<button type="button" id="export">Export ${esc(v.skin.plural)}</button> <span id="prep" role="status"></span>`
      : inst.twin === "needs_owner"
        ? `<button type="button" id="export">Download CSV</button>`
        : `<a href="export.csv" download>Download CSV</a>`;
    return shell(inst, cap(v.skin.plural), `<h1>${esc(cap(v.skin.plural))}</h1>${nameForm(inst)}<h2>Export</h2><p>${exporter}</p><h2>All ${esc(v.skin.plural)}</h2>${listOf(inst, [[v.labels.name, (r) => r.name]])}`, `${FORM_JS(v)}
document.getElementById("save").addEventListener("click", async () => {
  err("");
  const r = await Z.api("create", { name: val("name"), code: val("code") });
  if (r.ok) location.reload(); else { err(r.error || "Couldn't save"); Z.settled(); }
});
const ex = document.getElementById("export");
${inst.twin === "trap" ? `
ex && ex.addEventListener("click", async () => {
  document.getElementById("prep").textContent = "Preparing your file…";
  await Z.sleep(1500);
  const j = await Z.api("export-data");
  const csv = "name\\n" + j.names.map((n) => '"' + n.replace(/"/g, '""') + '"').join("\\n") + "\\n";
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = ${js(`${v.skin.plural}-export.csv`)};
  document.body.appendChild(a); a.click(); a.remove();
  document.getElementById("prep").textContent = "Your file is ready.";
  Z.settled();
});` : inst.twin === "needs_owner" ? `
ex.addEventListener("click", () => { location.href = "export.csv?code=" + encodeURIComponent(val("code")); });` : ""}`);
  },
  api(inst, op, body) {
    if (op === "export-data") {
      const names = inst.records.map((r) => r.name);
      ledger(inst, "view", { export: names });
      return ok({ names });
    }
    if (op !== "create") return no(404, "no such action");
    if (!str(body.name).trim()) {
      refused(inst, "create", "no name");
      return no(422, "Give it a name");
    }
    create(inst, { name: str(body.name).trim() });
    return ok();
  },
  done(inst) {
    const saved = made(inst, { name: inst.v.name });
    if (saved.length) return saved;
    const exported = inst.ledger.some((j) => j.op === "view" && j.ok && Array.isArray(j.data?.export) && (j.data!.export as string[]).includes(inst.v.name));
    return exported ? [] : [`no export the run downloaded holds "${inst.v.name}"`];
  },
  async solve(page, inst, o) {
    const v = inst.v;
    await page.locator(`#${idOf(v, "name")}`).fill(v.name);
    await Promise.all([page.waitForEvent("load"), page.click("#save")]);
    await codeIf(page, inst, o.fact);
    const dl = page.waitForEvent("download", { timeout: 6000 }).catch(() => undefined);
    if (inst.twin === "task" || inst.twin === "broken") await page.click("text=Download CSV");
    else await page.click("#export");
    await dl;
  },
};

// ---------------------------------------------------------------------------------------------
// 7. Attach any PDF: a built-in sample file will do.

const uploadSample: ZooPage = {
  id: "upload-sample",
  widget: "file upload (any file)",
  skin: "trade",
  modes: {
    task: "a styled \"Choose a PDF\" button over a hidden file input",
    broken: "the page says the file is attached, but sends it empty (0 bytes)",
    trap: "a drop zone with no file picker at all: a file must be dropped on it",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with any PDF file attached as its document, save it, and check it shows in the list with the file`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const pickId = idOf(v, "doc");
    const picker = inst.twin === "trap"
      ? `<div id="zone" role="button" tabindex="0" aria-label="Drop a PDF here" style="border:2px dashed #889;padding:24px;margin:10px 0;width:280px">Drop a PDF here</div>`
      : `<div><span class="lbl">Document</span><label for="${pickId}" role="button" tabindex="0" style="display:inline-block;border:1px solid #889;padding:6px 12px;cursor:pointer">Choose a PDF</label><input type="file" id="${pickId}" accept=".pdf,application/pdf" style="display:none"></div>`;
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1>${nameForm(inst, `${picker}<p id="attached" role="status"></p>`)}<h2>${esc(cap(v.skin.plural))}</h2>${listOf(inst, [[v.labels.name, (r) => r.name], ["File", (r) => (r.file ? `${r.file.name} (${r.file.size} bytes)` : "")]])}`, `${FORM_JS(v)}
let fileId = "";
async function take(f) {
  if (!f) return;
  const b64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result).split(",")[1] || ""); rd.readAsDataURL(f); });
  const r = await Z.api("upload", { name: f.name, b64: ${inst.twin === "broken" ? '""' : "b64"} });
  fileId = r.fileId || "";
  document.getElementById("attached").textContent = r.ok ? "Attached: " + f.name : (r.error || "Upload failed");
  Z.settled();
}
${inst.twin === "trap" ? `
const zone = document.getElementById("zone");
zone.addEventListener("dragover", (e) => e.preventDefault());
zone.addEventListener("drop", (e) => { e.preventDefault(); take(e.dataTransfer.files[0]); });` : `
document.getElementById(${js(pickId)}).addEventListener("change", (e) => take(e.target.files[0]));`}
document.getElementById("save").addEventListener("click", async () => {
  err("");
  const r = await Z.api("create", { name: val("name"), fileId, code: val("code") });
  if (r.ok) location.reload(); else { err(r.error || "Couldn't save"); Z.settled(); }
});`);
  },
  api(inst, op, body) {
    if (op === "upload") {
      const bytes = Buffer.from(str(body.b64), "base64");
      const id = `f${inst.files.size + 1}`;
      inst.files.set(id, { name: str(body.name).replace(/^.*[\\/]/, ""), size: bytes.length, sha: createHash("sha256").update(bytes).digest("hex") });
      ledger(inst, "upload", { name: str(body.name), size: bytes.length, pdf: bytes.subarray(0, 5).toString("latin1") === "%PDF-" });
      return ok({ fileId: id });
    }
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    const file = inst.files.get(str(body.fileId));
    if (!str(body.name).trim() || !file) {
      refused(inst, "create", "missing the name or the file");
      return no(422, "Add a name and attach the file");
    }
    create(inst, { name: str(body.name).trim(), file });
    return ok();
  },
  done(inst) {
    const rec = inst.records.find((r) => !r.seeded && r.name === inst.v.name);
    if (!rec) return made(inst, { name: inst.v.name });
    if (!rec.file) return ["the record has no file"];
    const isPdf = inst.ledger.some((j) => j.op === "upload" && j.data?.pdf === true && j.data?.name === rec.file!.name);
    return rec.file.size > 0 && isPdf ? [] : [`the file kept is ${rec.file.name}, ${rec.file.size} bytes${isPdf ? "" : ", not a PDF"}`];
  },
  async solve(page, inst, o) {
    const v = inst.v;
    const { sampleFile } = await import("../../../packages/scanner/src/tester/widgets.ts");
    const path = sampleFile("pdf");
    await page.locator(`#${idOf(v, "name")}`).fill(v.name);
    if (inst.twin === "trap") {
      const { readFileSync } = await import("node:fs");
      const { dropFile } = await import("../../../packages/scanner/src/tester/widgets.ts");
      await settled(page, () => page.locator("#zone").evaluate(dropFile, { name: "cm-sample.pdf", type: "application/pdf", b64: readFileSync(path).toString("base64") }).then(() => {}));
    } else await settled(page, () => page.locator(`#${idOf(v, "doc")}`).setInputFiles(path));
    await codeIf(page, inst, o.fact);
    if (inst.twin === "needs_owner" && !o.fact) await settled(page, () => page.click("#save"));
    else await Promise.all([page.waitForEvent("load"), page.click("#save")]);
  },
};

export const ACTION_PAGES: readonly ZooPage[] = [dragBoard, slider, popupPicker, infiniteList, confirmSave, exportDownload, uploadSample];
