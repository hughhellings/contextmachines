/**
 * The zoo's form pages (plan section 12): combobox, React-like controlled input, datetime with a
 * time zone, a multi-page wizard, an autosave switch, Enter-to-submit, a refusal with a rule, a silent
 * save failure next to a look-alike row, a restored draft, and a file upload. Each has four twins
 * (kit.ts Twin) and a scripted no-AI solve. Every right answer is the server's own record.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import { cap, codeField, codeOk, create, esc, field, idOf, js, made, no, numOf, ok, refused, select, shell, str, textArea, textInput, wrap, type Inst, type Rec, type ZooPage } from "./kit.ts";
import { pick, rng, type Variant } from "./seed.ts";

// ---------------------------------------------------------------------------------------------
// Shared by the form pages.

export type Key = "name" | "num" | "choice" | "notes";

/**
 * A standard "new record" page: the fields asked for, in the seed's order and labelled its way, the
 * owner-code field on the needs-owner twin, an error line, the save button, and the list under it.
 * The form shows after the seed's delay. No <form> element (as in many React apps).
 */
export function formPage(inst: Inst, keys: readonly Key[], o: { controls?: Partial<Record<Key, string>>; extra?: string; listCols?: [string, string][]; script: string; title?: string }): string {
  const v = inst.v;
  const defaults: Record<Key, string> = {
    name: field(v, "name", v.labels.name, textInput()),
    num: field(v, "num", v.labels.num, textInput("number")),
    choice: field(v, "choice", v.labels.choice, select(v.skin.choices)),
    notes: field(v, "notes", v.labels.notes, textArea),
  };
  const fields = v.order.filter((k) => keys.includes(k)).map((k) => o.controls?.[k] ?? defaults[k]).join("\n");
  const form = `<div id="f">${fields}${inst.twin === "needs_owner" ? codeField(v) : ""}${o.extra ?? ""}<p id="err" class="err" role="alert"></p><button type="button" id="save">${esc(v.labels.save)}</button></div>`;
  const cols = o.listCols ?? [[v.labels.name, "name"]];
  const ids = Object.fromEntries(["name", "num", "choice", "notes", "code", "when", "zone", "file", "item"].map((k) => [k, idOf(v, k)]));
  const script = `
const ID = ${js(ids)};
const $ = (k) => document.getElementById(ID[k] || k);
const val = (k) => ($(k) ? $(k).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const COLS = ${js(cols)};
const refresh = () => Z.showList(document.getElementById("list"), COLS);
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
refresh();
${o.script}`;
  return shell(inst, o.title ?? `New ${v.skin.entity}`, `<h1>${esc(o.title ?? `New ${v.skin.entity}`)}</h1><div id="host" hidden>${wrap(v, form)}</div><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, script);
}

/** The usual save: post, show the error or "Saved", refresh the list. `body` is a JS expression. */
export const SAVE = (body: string, op = "create") => `
async function save() {
  err("");
  const r = await Z.api(${js(op)}, ${body});
  if (r.ok) { Z.toast("Saved"); refresh(); } else err(r.error || "Something went wrong");
  Z.settled();
  return r;
}`;

/** A solve's helpers: fill a field by its id, press save and wait until the page says it finished. */
export async function fillField(page: Page, v: Variant, key: string, value: string | number): Promise<void> {
  await page.locator(`#${idOf(v, key)}`).fill(String(value));
}
export async function settled(page: Page, act: () => Promise<void>, timeout = 9000): Promise<void> {
  const n = await page.evaluate(() => Number(document.body.dataset.zdone || 0));
  await act();
  await page.waitForFunction((m) => Number(document.body.dataset.zdone || 0) > m, n, { timeout });
}
export async function shown(page: Page): Promise<void> {
  await page.locator("#host").waitFor({ state: "visible" });
}
export const codeIf = async (page: Page, inst: Inst, fact?: boolean) => {
  if (inst.twin === "needs_owner" && fact) await fillField(page, inst.v, "code", inst.v.code);
};


// ---------------------------------------------------------------------------------------------
// 1. Combobox: a custom ARIA combobox; typing alone sets nothing, an option must be picked.

const combobox: ZooPage = {
  id: "combobox",
  widget: "combobox",
  skin: "trade",
  modes: {
    task: "a custom combobox (role=combobox, a listbox that filters as you type); only a picked option counts",
    broken: "picking an option shows it, but the save sends the list's first option",
    trap: "the options take over a second to load (\"Loading options…\")",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.choiceNoun} ${v.choice}, save it, and check it shows in the list`,
  render(inst, path, q) {
    if (path !== "") return undefined;
    void q;
    const v = inst.v;
    const options = [...v.skin.choices, "Other", "Unsorted"];
    const cb = field(v, "choice", v.labels.choice, (a) => `<input type="text" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${v.css}-lb" autocomplete="off" ${a}><ul role="listbox" id="${v.css}-lb" hidden style="list-style:none;padding:0;margin:0;border:1px solid #aaa;max-width:260px"></ul>`);
    return formPage(inst, ["name", "choice"], {
      controls: { choice: cb },
      listCols: [[v.labels.name, "name"], [v.labels.choice, "choice"]],
      script: `
const OPTS = ${js(options)};
const box = $("choice"), lb = document.getElementById(${js(`${v.css}-lb`)});
let chosen = "", loaded = ${inst.twin === "trap" ? "false" : "true"}, active = -1;
${inst.twin === "trap" ? "let asked = false; box.addEventListener('focus', () => { if (asked) return; asked = true; setTimeout(() => { loaded = true; draw(); }, 1300); });" : ""}
function draw() {
  const q = box.value.trim().toLowerCase();
  const shownOpts = OPTS.filter((o) => o.toLowerCase().includes(q));
  lb.innerHTML = !loaded ? '<li class="muted">Loading options…</li>' : shownOpts.length ? shownOpts.map((o, i) => '<li role="option" id="${v.css}-o' + i + '" aria-selected="' + (i === active) + '" data-v="' + Z.esc(o) + '" style="padding:4px;cursor:pointer">' + Z.esc(o) + '</li>').join("") : '<li class="muted">No matches</li>';
  lb.hidden = false; box.setAttribute("aria-expanded", "true");
}
function close() { lb.hidden = true; box.setAttribute("aria-expanded", "false"); active = -1; box.removeAttribute("aria-activedescendant"); }
function choose(x) { chosen = x; box.value = x; close(); }
box.addEventListener("focus", draw);
box.addEventListener("input", () => { chosen = ""; active = -1; draw(); });
box.addEventListener("blur", () => setTimeout(close, 200));
box.addEventListener("keydown", (e) => {
  const all = [...lb.querySelectorAll("[role=option]")];
  if (e.key === "ArrowDown" && all.length) { active = Math.min(all.length - 1, active + 1); draw(); box.setAttribute("aria-activedescendant", all[active].id); e.preventDefault(); }
  if (e.key === "Enter" && all[active]) { choose(all[active].dataset.v); e.preventDefault(); }
  if (e.key === "Escape") close();
});
lb.addEventListener("mousedown", (e) => { const li = e.target.closest("[role=option]"); if (li) { e.preventDefault(); choose(li.dataset.v); } });
${SAVE(`{ name: val("name"), choice: ${inst.twin === "broken" ? "chosen ? OPTS[0] : \"\"" : "chosen"}, code: val("code") }`)}
document.getElementById("save").addEventListener("click", () => { if (!chosen) { err("Pick a ${esc(v.labels.choice.toLowerCase())} from the list"); Z.settled(); return; } save(); });`,
    });
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim() || !str(body.choice)) {
      refused(inst, "create", "missing a field", { name: str(body.name) });
      return no(422, "Fill in every field");
    }
    create(inst, { name: str(body.name).trim(), choice: str(body.choice) });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, choice: inst.v.choice }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    const box = page.locator(`#${idOf(v, "choice")}`);
    await box.click();
    await box.pressSequentially(v.choice.slice(0, 3));
    await page.locator(`#${v.css}-lb [role=option]`, { hasText: v.choice }).first().click({ timeout: 5000 });
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 2. React-like controlled input: React's real value tracker, and the whole form redrawn on each key.

/**
 * React keeps a "tracker" on each input: it wraps the node's own `value` setter, so a value set from
 * script (el.value = x) is remembered, and the next input event whose value equals the remembered one
 * is ignored (no onChange). Real typing changes the value inside the browser, past the setter, so it
 * counts. This page does the same, and redraws the form (new nodes) on every change.
 */
const reactInput: ZooPage = {
  id: "react-input",
  widget: "react controlled input",
  skin: "gym",
  modes: {
    task: "React's value tracker (a value set from script is ignored) and the form redrawn, new nodes, on every key",
    broken: "the save sends the state from one change before (a stale closure): the last field typed is lost",
    trap: "the save button looks disabled with a red \"Fill in every field\" until every field is filled",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num} and notes "${v.notes}", save it, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const keys: Key[] = v.order.filter((k) => k !== "choice");
    const labels: Record<string, string> = { name: v.labels.name, num: v.labels.num, notes: v.labels.notes, code: "Team code" };
    const all = [...keys, ...(inst.twin === "needs_owner" ? ["code"] : [])];
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden>${wrap(v, `<div id="root"></div>`)}</div><h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, `
const KEYS = ${js(all)}, LABELS = ${js(labels)}, ARIA = ${js(v.aria)}, CSS = ${js(v.css)}, SAVE_WORD = ${js(v.labels.save)};
const state = { name: "", num: "", notes: "", code: "" };
let prev = Object.assign({}, state), focusKey = null, caret = null, error = "";
const valid = () => KEYS.every((k) => String(state[k]).trim());
function control(k) {
  const id = CSS + "-" + k, v = Z.esc(state[k]);
  const a = 'id="' + id + '" name="' + k + '"' + (ARIA === "aria-label" ? ' aria-label="' + Z.esc(LABELS[k]) + '"' : ARIA === "labelledby" ? ' aria-labelledby="' + id + '-l"' : ARIA === "placeholder" ? ' placeholder="' + Z.esc(LABELS[k]) + '"' : "");
  // A number as text with inputmode (as many React apps do it): the caret can be put back after a redraw.
  const input = k === "notes" ? "<textarea rows=2 " + a + ">" + v + "</textarea>" : '<input type="text"' + (k === "num" ? ' inputmode="decimal"' : "") + ' value="' + v + '" ' + a + ">";
  if (ARIA === "for") return '<div><label for="' + id + '">' + Z.esc(LABELS[k]) + "</label>" + input + "</div>";
  if (ARIA === "wrap") return "<div><label>" + Z.esc(LABELS[k]) + " " + input + "</label></div>";
  if (ARIA === "labelledby") return '<div><div class="lbl" id="' + id + '-l">' + Z.esc(LABELS[k]) + "</div>" + input + "</div>";
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
  const ready = valid();
  root.innerHTML = KEYS.map(control).join("") + '<p id="err" class="err" role="alert">' + Z.esc(error) + "</p>" +
    ${inst.twin === "trap" ? `(ready ? "" : '<p class="err">Fill in every field to save</p>') + '<button type="button" id="save" aria-disabled="' + !ready + '">' + Z.esc(SAVE_WORD) + "</button>"` : `'<button type="button" id="save">' + Z.esc(SAVE_WORD) + "</button>"`};
  for (const k of KEYS) track(document.getElementById(CSS + "-" + k), k);
  document.getElementById("save").addEventListener("click", save);
  if (focusKey) { const el = document.getElementById(CSS + "-" + focusKey); el.focus(); try { el.setSelectionRange(caret, caret); } catch {} }
}
async function save() {
  ${inst.twin === "trap" ? "if (!valid()) return;" : ""}
  const sent = ${inst.twin === "broken" ? "prev" : "state"};
  const r = await Z.api("create", { name: sent.name, num: sent.num, notes: sent.notes, code: sent.code });
  error = r.ok ? "" : r.error || "Something went wrong";
  focusKey = null; render();
  if (r.ok) { Z.toast("Saved"); Z.showList(document.getElementById("list"), ${js([[v.labels.name, "name"], [v.labels.num, "num"], [v.labels.notes, "notes"]])}); }
  Z.settled();
}
render();
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
Z.showList(document.getElementById("list"), ${js([[v.labels.name, "name"], [v.labels.num, "num"], [v.labels.notes, "notes"]])});`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim()) {
      refused(inst, "create", "no name");
      return no(422, `${inst.v.labels.name} is required`);
    }
    create(inst, { name: str(body.name).trim(), num: numOf(body.num), notes: str(body.notes).trim() });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num, notes: inst.v.notes }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    // Typed key by key: each key redraws the form, so each field is found again by its id.
    for (const k of v.order.filter((x) => x !== "choice")) {
      const el = page.locator(`#${v.css}-${k}`);
      await el.click();
      await el.pressSequentially(String(k === "name" ? v.name : k === "num" ? v.num : v.notes), { delay: 5 });
    }
    if (inst.twin === "needs_owner" && o.fact) await page.locator(`#${v.css}-code`).pressSequentially(v.code, { delay: 5 });
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 3. Datetime-local with a time zone: the moment saved is what counts.

const ZONES: readonly [string, string, number][] = [
  ["Europe/London", "London", 0], ["America/New_York", "New York", -5], ["Asia/Tokyo", "Tokyo", 9],
  ["Europe/Berlin", "Berlin", 1], ["Australia/Sydney", "Sydney", 11], ["America/Los_Angeles", "Los Angeles", -8],
];
/** The seed's wanted local time (a December day, so each zone's offset is fixed) and zones. */
export function whenOf(v: Variant): { local: string; words: string; zone: [string, string, number]; start: [string, string, number]; utc: string } {
  const r = rng(v.seed * 7 + 3);
  const day = 1 + Math.floor(r() * 20);
  const hour = 7 + Math.floor(r() * 11);
  const minute = pick(r, [0, 15, 30, 45]);
  const zone = pick(r, ZONES.filter((z) => z[2] !== 0));
  const start = pick(r, ZONES.filter((z) => z[0] !== zone[0]));
  const p2 = (n: number) => String(n).padStart(2, "0");
  const local = `2026-12-${p2(day)}T${p2(hour)}:${p2(minute)}`;
  return { local, words: `${day} December 2026 at ${p2(hour)}:${p2(minute)}`, zone, start, utc: toUtc(local, zone[2]) };
}
const toUtc = (local: string, offset: number) => new Date(Date.parse(`${local}:00Z`) - offset * 3600_000).toISOString();
const shownIn = (utc: string, offset: number) => new Date(Date.parse(utc) + offset * 3600_000).toISOString().slice(0, 16).replace("T", " ");

const datetime: ZooPage = {
  id: "datetime",
  widget: "datetime-local + time zone",
  skin: "crm",
  modes: {
    task: "a datetime-local box and a time-zone select that starts on another zone; the moment saved must be right",
    broken: "the server ignores the time zone (stores the local time as UTC); the list shows the wrong time",
    trap: "the list shows every time in UTC (\"times shown in UTC\"), so the right time looks different",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => {
    const w = whenOf(v);
    return `Schedule a ${v.skin.entity} named "${v.name}" for ${w.words}, ${w.zone[1]} time, save it, and check it shows in the list`;
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const w = whenOf(v);
    const zones = field(v, "zone", "Time zone", (a) => `<select ${a}>${ZONES.map(([id, city]) => `<option value="${id}"${id === w.start[0] ? " selected" : ""}>${esc(city)} (${esc(id)})</option>`).join("")}</select>`);
    return formPage(inst, ["name"], {
      extra: field(v, "when", "When", textInput("datetime-local")) + zones,
      listCols: [[v.labels.name, "name"], ["When", "when"]],
      script: `${SAVE(`{ name: val("name"), local: val("when"), zone: val("zone"), code: val("code") }`)}
document.getElementById("save").addEventListener("click", save);`,
    });
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    const zone = ZONES.find((z) => z[0] === str(body.zone));
    if (!str(body.name).trim() || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(str(body.local)) || !zone) {
      refused(inst, "create", "missing a field", { name: str(body.name), local: str(body.local) });
      return no(422, "Fill in the name, the date and time, and the time zone");
    }
    const utc = toUtc(str(body.local).slice(0, 16), inst.twin === "broken" ? 0 : zone[2]);
    create(inst, { name: str(body.name).trim(), utc, zone: zone[0] });
    return ok();
  },
  view: (inst, r) => ({ ...r, when: whenCell(inst, r) }),
  done: (inst) => made(inst, { name: inst.v.name, utc: whenOf(inst.v).utc }),
  async solve(page, inst, o) {
    const v = inst.v;
    const w = whenOf(v);
    await shown(page);
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "when", w.local);
    await page.locator(`#${idOf(v, "zone")}`).selectOption(w.zone[0]);
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};
/** The list's "When" column: in the record's zone, or UTC on the trap. */
export function whenCell(inst: Inst, r: Rec): string {
  if (!r.utc) return "";
  if (inst.twin === "trap") return `${shownIn(r.utc, 0)} UTC`;
  const z = ZONES.find((x) => x[0] === r.zone) ?? ZONES[0]!;
  return `${shownIn(r.utc, z[2])} (${z[1]})`;
}

// ---------------------------------------------------------------------------------------------
// 4. A multi-page wizard: details, a choice, review, finish.

const wizard: ZooPage = {
  id: "wizard",
  widget: "multi-page wizard",
  skin: "recipes",
  modes: {
    task: "three steps (details, a radio choice, review) with Next and Back; the record is made only on the last press",
    broken: "the last press says \"All done\" but nothing is sent",
    trap: "the review step shows a red \"optional notes are empty\" warning, and finishing takes 2 s of \"Processing…\"",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Create a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num} and ${v.skin.choiceNoun} ${v.choice}, finish the steps, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const step1 = `${field(v, "name", v.labels.name, textInput())}${field(v, "num", v.labels.num, textInput("number"))}${inst.twin === "needs_owner" ? codeField(v) : ""}`;
    const step2 = `<fieldset><legend>${esc(v.labels.choice)}</legend>${v.skin.choices.map((c, i) => `<label style="font-weight:400"><input type="radio" name="choice" value="${esc(c)}" id="${v.css}-r${i}"> ${esc(c)}</label>`).join("")}</fieldset>`;
    return shell(inst, `New ${v.skin.entity}`, `<h1>New ${esc(v.skin.entity)}</h1><p id="stepname" class="muted"></p><div id="host" hidden>${wrap(v, `
<div data-step="1">${step1}</div><div data-step="2" hidden>${step2}</div><div data-step="3" hidden><h2>Review</h2><dl id="review"></dl>${inst.twin === "trap" ? `<p class="warn">Optional notes are empty. You can add them later.</p>` : ""}</div>
<p id="err" class="err" role="alert"></p><button type="button" id="back" hidden>Back</button><button type="button" id="next">Next</button><button type="button" id="save" hidden>${esc(v.labels.save)}</button><p id="donemsg" role="status"></p>`)}</div>
<h2>${esc(cap(v.skin.plural))}</h2><div id="list"></div>`, `
const ID = ${js({ name: idOf(v, "name"), num: idOf(v, "num"), code: idOf(v, "code") })};
const val = (k) => (document.getElementById(ID[k]) ? document.getElementById(ID[k]).value : "");
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const COLS = ${js([[v.labels.name, "name"], [v.labels.num, "num"], [v.labels.choice, "choice"]])};
let step = 1;
function show() {
  document.querySelectorAll("[data-step]").forEach((d) => { d.hidden = Number(d.dataset.step) !== step; });
  document.getElementById("stepname").textContent = "Step " + step + " of 3";
  document.getElementById("back").hidden = step === 1;
  document.getElementById("next").hidden = step === 3;
  document.getElementById("save").hidden = step !== 3;
  if (step === 3) document.getElementById("review").innerHTML = "<dt>${esc(v.labels.name)}</dt><dd>" + Z.esc(val("name")) + "</dd><dt>${esc(v.labels.num)}</dt><dd>" + Z.esc(val("num")) + "</dd><dt>${esc(v.labels.choice)}</dt><dd>" + Z.esc(choice()) + "</dd>";
}
const choice = () => { const c = document.querySelector("input[name=choice]:checked"); return c ? c.value : ""; };
document.getElementById("next").addEventListener("click", () => {
  err("");
  if (step === 1 && (!val("name").trim() || !val("num"))) return err("Fill in both fields to go on");
  if (step === 2 && !choice()) return err("Pick one to go on");
  step++; show();
});
document.getElementById("back").addEventListener("click", () => { err(""); step--; show(); });
document.getElementById("save").addEventListener("click", async () => {
  err("");
  ${inst.twin === "broken" ? `document.getElementById("donemsg").textContent = "All done! Your ${esc(v.skin.entity)} is saved."; Z.settled(); return;` : ""}
  ${inst.twin === "trap" ? `document.getElementById("donemsg").textContent = "Processing…"; await Z.sleep(2000);` : ""}
  const r = await Z.api("create", { name: val("name"), num: val("num"), choice: choice(), code: val("code") });
  if (r.ok) { document.getElementById("donemsg").textContent = "All done! Your ${esc(v.skin.entity)} is saved."; Z.showList(document.getElementById("list"), COLS); }
  else { document.getElementById("donemsg").textContent = ""; err(r.error || "Something went wrong"); }
  Z.settled();
});
show();
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
Z.showList(document.getElementById("list"), COLS);`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim() || !str(body.choice)) {
      refused(inst, "create", "missing a field");
      return no(422, "Fill in every step");
    }
    create(inst, { name: str(body.name).trim(), num: numOf(body.num), choice: str(body.choice) });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num, choice: inst.v.choice }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "num", v.num);
    await codeIf(page, inst, o.fact);
    await page.click("#next");
    await page.locator(`#${v.css}-r${v.skin.choices.indexOf(v.choice)}`).check();
    await page.click("#next");
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 5. Autosave switch: a setting that commits the moment it is pressed, with no form and no Save.

const featureOf = (v: Variant) => pick(rng(v.seed * 11 + 5), v.skin.features);

const autosave: ZooPage = {
  id: "autosave",
  widget: "autosave switch",
  skin: "library",
  modes: {
    task: "settings switches (role=switch) that save the moment they are pressed; a \"Saved\" note shows",
    broken: "the switch flips on screen, but the server refuses the change silently; a reload shows it off",
    trap: "no \"Saved\" note at all, and a greyed-out \"Save changes\" button that is never needed",
    needs_owner: "the switches are locked (\"Managed by your workspace owner\") until the owner's PIN is given",
  },
  goal: ({ v }) => `In settings, turn on "${featureOf(v)}" and make sure it is still on after reloading the page`,
  seed(inst) {
    inst.state.settings = Object.fromEntries(inst.v.skin.features.map((f, i) => [f, i === 1 && f !== featureOf(inst.v)]));
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const settings = inst.state.settings as Record<string, boolean>;
    const locked = inst.twin === "needs_owner" && !inst.state.unlocked;
    const rows = v.skin.features.map((f, i) => `<div style="margin:10px 0"><span id="${v.css}-f${i}">${esc(f)}</span> <button type="button" role="switch" aria-labelledby="${v.css}-f${i}" aria-checked="${settings[f] ? "true" : "false"}" data-f="${esc(f)}"${locked ? ' aria-disabled="true"' : ""} style="min-width:56px">${settings[f] ? "On" : "Off"}</button></div>`).join("");
    const lock = locked ? `<p class="warn">Managed by your workspace owner.</p>${field(v, "code", "Owner PIN", textInput("password"))}<button type="button" id="unlock">Unlock</button>` : "";
    return shell(inst, "Settings", `<h1>Settings</h1><div id="host" hidden>${wrap(v, `${lock}<div id="switches">${rows}</div>${inst.twin === "trap" ? `<button type="button" disabled>Save changes</button>` : ""}<p id="err" class="err" role="alert"></p>`)}</div>`, `
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
document.querySelectorAll("[role=switch]").forEach((b) => b.addEventListener("click", async () => {
  if (b.getAttribute("aria-disabled") === "true") return;
  const on = b.getAttribute("aria-checked") !== "true";
  b.setAttribute("aria-checked", String(on)); b.textContent = on ? "On" : "Off";
  const r = await Z.api("setting", { feature: b.dataset.f, on });
  ${inst.twin === "trap" ? "" : `if (r.ok) Z.toast("Saved");`}
  ${inst.twin === "broken" ? "" : `if (!r.ok) { b.setAttribute("aria-checked", String(!on)); b.textContent = !on ? "On" : "Off"; document.getElementById("err").textContent = r.error || "Couldn't save"; }`}
  Z.settled();
}));
const u = document.getElementById("unlock");
if (u) u.addEventListener("click", async () => {
  const r = await Z.api("unlock", { code: document.getElementById(${js(idOf(v, "code"))}).value });
  if (r.ok) location.reload(); else { document.getElementById("err").textContent = r.error; Z.settled(); }
});`);
  },
  api(inst, op, body) {
    if (op === "unlock") {
      if (inst.twin !== "needs_owner") return ok();
      const denied = codeOk(inst, body, "setting");
      if (denied) return denied;
      inst.state.unlocked = true;
      return ok();
    }
    if (op !== "setting") return no(404, "no such action");
    const feature = str(body.feature);
    const settings = inst.state.settings as Record<string, boolean>;
    if (!(feature in settings)) return no(404, "no such setting");
    if (inst.twin === "needs_owner" && !inst.state.unlocked) {
      refused(inst, "setting", "locked", { feature });
      return no(403, "Managed by your workspace owner");
    }
    if (inst.twin === "broken") {
      refused(inst, "setting", "server error", { feature, on: body.on === true });
      return no(500, "Internal error");
    }
    settings[feature] = body.on === true;
    inst.ledger.push({ at: Date.now(), op: "setting", ok: true, data: { feature, on: body.on === true } });
    return ok();
  },
  done(inst) {
    const f = featureOf(inst.v);
    return (inst.state.settings as Record<string, boolean>)[f] === true ? [] : [`"${f}" is not on in the server's settings`];
  },
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    if (inst.twin === "needs_owner" && o.fact) {
      await fillField(page, v, "code", v.code);
      await Promise.all([page.waitForEvent("load"), page.click("#unlock")]);
      await shown(page);
    }
    const sw = page.getByRole("switch", { name: featureOf(v) });
    await settled(page, () => sw.click()).catch(() => undefined);
  },
};

// ---------------------------------------------------------------------------------------------
// 6. Enter-to-submit: a quick-add box with no button.

const enterSubmit: ZooPage = {
  id: "enter-submit",
  widget: "enter to submit",
  skin: "trade",
  modes: {
    task: "a quick-add box with no button: type, then press Enter",
    broken: "Enter adds the row on screen only; nothing is sent, and a reload loses it",
    trap: "60 rows already, the new one lands at the bottom out of view, the box keeps its text, and nothing is said",
    needs_owner: "names must start with the team's tag, which only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" to the list`,
  seed(inst) {
    const n = inst.twin === "trap" ? 60 : 5;
    for (let i = 0; i < n; i++) inst.records.push({ id: inst.nextId++, name: `${inst.v.skin.nameStems[i % inst.v.skin.nameStems.length]}-${200 + i * 7}`, seeded: true });
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const items = inst.records.map((r) => `<li>${esc(r.name)}</li>`).join("");
    const box = field(v, "name", `New ${v.skin.entity}`, (a) => `<input type="text" autocomplete="off" ${a}>`, "press Enter to add");
    return shell(inst, cap(v.skin.plural), `<h1>${esc(cap(v.skin.plural))}</h1><div id="host" hidden>${wrap(v, `${box}<p id="err" class="err" role="alert"></p>`)}</div><ul id="items">${items}</ul>`, `
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
const box = document.getElementById(${js(idOf(v, "name"))});
box.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const name = box.value.trim();
  document.getElementById("err").textContent = "";
  if (!name) { Z.settled(); return; }
  const add = (n) => { const li = document.createElement("li"); li.textContent = n; document.getElementById("items").appendChild(li); };
  ${inst.twin === "broken" ? "add(name); box.value = \"\"; Z.toast(\"Added\"); Z.settled(); return;" : ""}
  const r = await Z.api("create", { name });
  if (r.ok) { add(r.name); ${inst.twin === "trap" ? "" : "box.value = \"\"; Z.toast(\"Added\");"} }
  else document.getElementById("err").textContent = r.error || "Couldn't add it";
  Z.settled();
});`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const name = str(body.name).trim();
    if (inst.twin === "needs_owner" && !name.toUpperCase().startsWith(`${inst.v.code} `)) {
      refused(inst, "create", "team tag", { name });
      return no(403, "Names must start with your team's tag. Your workspace owner knows it.");
    }
    if (!name) return no(422, "Type a name first");
    create(inst, { name });
    return ok({ name });
  },
  done: (inst) => made(inst, { name: inst.twin === "needs_owner" ? `${inst.v.code} ${inst.v.name}` : inst.v.name }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    const box = page.locator(`#${idOf(v, "name")}`);
    await box.fill(inst.twin === "needs_owner" && o.fact ? `${v.code} ${v.name}` : v.name);
    await settled(page, () => box.press("Enter"));
  },
};

// ---------------------------------------------------------------------------------------------
// 7. A refusal with a rule: the server says no, and why; the task twin can be fixed from the page.

const limitOf = (v: Variant) => Math.floor(v.num / 2);

const refusal: ZooPage = {
  id: "refusal",
  widget: "refusal with a rule",
  skin: "crm",
  modes: {
    task: "the first save is refused: over the limit needs a box ticked, which then shows; tick it and save again",
    broken: "still refused after the box is ticked, every time",
    trap: "the first save warns \"a similar one exists — Save anyway?\"; Save anyway works",
    needs_owner: "over the limit needs an approval code from the account owner",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num}, save it, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const big = `<div id="bigbox" hidden><label style="font-weight:400"><input type="checkbox" id="${v.css}-big"> Large ${esc(v.skin.numNoun)}</label></div>`;
    const approval = `<div id="approval" hidden>${field(v, "code", "Approval code", textInput())}</div>`;
    const inner = formPage({ ...inst, twin: inst.twin === "needs_owner" ? "task" : inst.twin }, ["name", "num"], {
      extra: inst.twin === "needs_owner" ? approval : big,
      listCols: [[v.labels.name, "name"], [v.labels.num, "num"]],
      script: `
let force = false;
${SAVE(`{ name: val("name"), num: val("num"), large: Boolean(document.getElementById(${js(`${v.css}-big`)}) && document.getElementById(${js(`${v.css}-big`)}).checked), code: val("code"), force }`)}
async function go() {
  const r = await save();
  if (r.status === 422 && document.getElementById("bigbox")) document.getElementById("bigbox").hidden = false;
  if (r.status === 403 && document.getElementById("approval")) document.getElementById("approval").hidden = false;
  if (r.status === 409) { const b = document.createElement("button"); b.type = "button"; b.id = "anyway"; b.textContent = "Save anyway"; b.onclick = () => { force = true; b.remove(); go(); }; document.getElementById("err").after(b); }
}
document.getElementById("save").addEventListener("click", go);`,
    });
    return inner;
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const v = inst.v;
    const name = str(body.name).trim();
    const num = numOf(body.num);
    if (!name || !Number.isFinite(num)) {
      refused(inst, "create", "missing a field");
      return no(422, "Fill in every field");
    }
    const limit = limitOf(v);
    if (inst.twin === "trap") {
      if (body.force !== true) {
        refused(inst, "create", "possible duplicate");
        return no(409, `A ${v.skin.entity} with a similar name already exists. Save anyway?`);
      }
    } else if (num > limit) {
      if (inst.twin === "needs_owner" && str(body.code).trim().toUpperCase() !== v.code) {
        refused(inst, "create", "approval code");
        return no(403, `${v.labels.num} over ${limit} needs an approval code from your account owner.`);
      }
      if (inst.twin !== "needs_owner" && (body.large !== true || inst.twin === "broken")) {
        refused(inst, "create", "large box");
        return no(422, `${v.labels.num} over ${limit} needs the "Large ${v.skin.numNoun}" box ticked.`);
      }
    }
    create(inst, { name, num });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "num", v.num);
    await settled(page, () => page.click("#save"));
    if (inst.twin === "trap") await settled(page, () => page.click("#anyway"));
    else if (inst.twin === "needs_owner") {
      if (!o.fact) return;
      await fillField(page, v, "code", v.code);
      await settled(page, () => page.click("#save"));
    } else {
      await page.locator(`#${v.css}-big`).check();
      await settled(page, () => page.click("#save"));
    }
  },
};

// ---------------------------------------------------------------------------------------------
// 8. A silent save failure next to a look-alike row.

const silentFail: ZooPage = {
  id: "silent-fail",
  widget: "silent save failure",
  skin: "gym",
  modes: {
    task: "the save works; the list already has a row with the same name (an older value) and a row with the same value (a look-alike name)",
    broken: "the save answers OK and says \"Saved\", but nothing is kept; the look-alike rows make it seem done",
    trap: "the save works, but the list's name column is narrow and cut off with an ellipsis",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a new ${v.skin.entity} named "${v.name}" with ${v.skin.numNoun} ${v.num}, save it, and check the new one shows in the list`,
  seed(inst) {
    const v = inst.v;
    const older = v.num + 3 + (v.seed % 5);
    inst.records.push({ id: inst.nextId++, name: v.name, num: older, seeded: true }, { id: inst.nextId++, name: v.lookalike, num: v.num, seeded: true }, { id: inst.nextId++, name: `${v.skin.nameStems[0]}-101`, num: v.num + 11, seeded: true });
  },
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const html = formPage(inst, ["name", "num"], {
      listCols: [[v.labels.name, "name"], [v.labels.num, "num"]],
      script: `${SAVE(`{ name: val("name"), num: val("num"), code: val("code") }`)}
document.getElementById("save").addEventListener("click", save);`,
    });
    return inst.twin === "trap" ? html.replace("</style>", `#list td:first-child{max-width:48px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}</style>`) : html;
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim()) return no(422, "Fill in every field");
    if (inst.twin === "broken") {
      // Answers as if it saved: nothing is kept (the planted bug).
      inst.ledger.push({ at: Date.now(), op: "create", ok: false, why: "dropped silently", data: { name: str(body.name) } });
      return ok();
    }
    create(inst, { name: str(body.name).trim(), num: numOf(body.num) });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, num: inst.v.num }),
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "num", v.num);
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 9. A restored draft: an older unsaved draft comes back from localStorage on load.

const draft: ZooPage = {
  id: "draft",
  widget: "restored draft",
  skin: "recipes",
  modes: {
    task: "an older unsaved draft is restored into the fields on load; the saved record must hold only the goal's values",
    broken: "the save sends the draft as it was restored, not what is in the fields now",
    trap: "a red \"Unsaved changes will be lost!\" banner with a Discard button, and the page reloads itself once soon after opening",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}" with notes "${v.notes}", save it, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    const stale = { name: `Old draft ${v.skin.nameStems[2]}`, notes: "remember to finish this" };
    const key = `zoo-draft-${inst.id}`;
    const banner = inst.twin === "trap" ? `<p class="warn" id="banner" hidden>Unsaved changes will be lost! <button type="button" id="discard">Discard draft</button></p>` : `<p class="muted" id="banner" hidden>We restored your unsaved draft.</p>`;
    return formPage(inst, ["name", "notes"], {
      extra: banner,
      listCols: [[v.labels.name, "name"], [v.labels.notes, "notes"]],
      script: `
const KEY = ${js(key)};
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, x) => { try { localStorage.setItem(k, x); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
if (!store.get(KEY + ":seen")) { store.set(KEY, ${js(JSON.stringify(stale))}); store.set(KEY + ":seen", "1"); }
let restored = null;
try { restored = JSON.parse(store.get(KEY) || "null"); } catch {}
if (restored) { for (const k of ["name", "notes"]) if ($(k) && restored[k] != null) $(k).value = restored[k]; document.getElementById("banner").hidden = false; }
const keep = () => store.set(KEY, JSON.stringify({ name: val("name"), notes: val("notes") }));
for (const k of ["name", "notes"]) if ($(k)) $(k).addEventListener("input", keep);
${inst.twin === "trap" ? `if (!sessionStorage.getItem(KEY + ":reloaded")) { sessionStorage.setItem(KEY + ":reloaded", "1"); setTimeout(() => location.reload(), 900); }
document.getElementById("discard").addEventListener("click", () => { store.del(KEY); $("name").value = ""; $("notes").value = ""; document.getElementById("banner").hidden = true; });` : ""}
${SAVE(inst.twin === "broken" ? `(restored ? { name: restored.name, notes: restored.notes, code: val("code") } : { name: val("name"), notes: val("notes"), code: val("code") })` : `{ name: val("name"), notes: val("notes"), code: val("code") }`)}
document.getElementById("save").addEventListener("click", async () => { const r = await save(); if (r.ok) { store.del(KEY); document.getElementById("banner").hidden = true; } });`,
    });
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const denied = codeOk(inst, body);
    if (denied) return denied;
    if (!str(body.name).trim()) return no(422, "Fill in every field");
    create(inst, { name: str(body.name).trim(), notes: str(body.notes).trim() });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name, notes: inst.v.notes }),
  async solve(page, inst, o) {
    const v = inst.v;
    if (inst.twin === "trap") {
      // The page reloads itself once: wait for it, as a person would.
      await page.waitForEvent("load", { timeout: 4000 }).catch(() => undefined);
    }
    await shown(page);
    await fillField(page, v, "name", v.name);
    await fillField(page, v, "notes", v.notes);
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

// ---------------------------------------------------------------------------------------------
// 10. File upload: the server must receive the very file named in the goal.

/** The sample file for a seed, written under `dir` (made here, never downloaded). */
export function sampleFile(dir: string, v: Variant): { path: string; size: number; sha: string } {
  mkdirSync(dir, { recursive: true });
  const r = rng(v.seed * 13 + 1);
  const body = `%PDF-1.4\n% zoo sample receipt for ${v.skin.entity} ${v.name}\n${Array.from({ length: 40 }, () => Math.floor(r() * 1e9).toString(36)).join(" ")}\n%%EOF\n`;
  const path = join(dir, `${v.skin.entity}-receipt-${v.seed}.pdf`);
  writeFileSync(path, body);
  return { path, size: Buffer.byteLength(body), sha: createHash("sha256").update(body).digest("hex") };
}

const upload: ZooPage = {
  id: "upload",
  widget: "file upload",
  skin: "library",
  modes: {
    task: "a file input; the file uploads on pick, then Save makes the record with it",
    broken: "the page says the file is attached, but sends it empty (0 bytes)",
    trap: "after the pick, 2 s of \"Scanning for viruses…\" with Save disabled",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v, filesDir }) => `Add a ${v.skin.entity} named "${v.name}", attach the file ${sampleFile(filesDir, v).path}, save it, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    const v = inst.v;
    sampleFile(inst.filesDir, v);
    return formPage(inst, ["name"], {
      extra: field(v, "file", "Receipt", (a) => `<input type="file" ${a}>`) + `<p id="attached" role="status"></p>`,
      listCols: [[v.labels.name, "name"], ["File", "fileName"]],
      script: `
let fileId = "";
const pickEl = $("file");
pickEl.addEventListener("change", () => {
  const f = pickEl.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    const b64 = String(rd.result).split(",")[1] || "";
    ${inst.twin === "trap" ? `document.getElementById("save").disabled = true; document.getElementById("attached").textContent = "Scanning for viruses…"; await Z.sleep(2000);` : ""}
    const r = await Z.api("upload", { name: f.name, b64: ${inst.twin === "broken" ? "\"\"" : "b64"} });
    fileId = r.fileId || "";
    document.getElementById("attached").textContent = r.ok ? "Attached: " + f.name + " ✓" : (r.error || "Upload failed");
    document.getElementById("save").disabled = false;
    Z.settled();
  };
  rd.readAsDataURL(f);
});
${SAVE(`{ name: val("name"), fileId, code: val("code") }`)}
document.getElementById("save").addEventListener("click", save);`,
    });
  },
  api(inst, op, body) {
    if (op === "upload") {
      const bytes = Buffer.from(str(body.b64), "base64");
      const id = `f${inst.files.size + 1}`;
      inst.files.set(id, { name: basename(str(body.name)), size: bytes.length, sha: createHash("sha256").update(bytes).digest("hex") });
      inst.ledger.push({ at: Date.now(), op: "upload", ok: true, data: { name: basename(str(body.name)), size: bytes.length } });
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
  view: (_inst, r) => ({ ...r, fileName: r.file ? `${r.file.name} (${r.file.size} bytes)` : "" }),
  done(inst) {
    const want = sampleFile(inst.filesDir, inst.v);
    const rec = inst.records.find((r) => !r.seeded && r.name === inst.v.name);
    if (!rec) return made(inst, { name: inst.v.name });
    if (!rec.file) return ["the record has no file"];
    return rec.file.sha === want.sha && rec.file.name === basename(want.path) ? [] : [`the file kept is ${rec.file.name}, ${rec.file.size} bytes, not ${basename(want.path)}, ${want.size} bytes`];
  },
  async solve(page, inst, o) {
    const v = inst.v;
    await shown(page);
    await fillField(page, v, "name", v.name);
    await settled(page, () => page.locator(`#${idOf(v, "file")}`).setInputFiles(sampleFile(inst.filesDir, v).path));
    await codeIf(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

export const FORM_PAGES: readonly ZooPage[] = [combobox, reactInput, datetime, wizard, autosave, enterSubmit, refusal, silentFail, draft, upload];
