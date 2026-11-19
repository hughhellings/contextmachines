/**
 * The zoo's proof-trap pages (plan section 7): saves that look done on screen and aren't kept.
 *   optimistic  the new row shows at once, before the server answers; the broken twin's server answers
 *               200 with an error body ({ ok: false, errors }), which the page ignores, so the row stays
 *               and it says "Saved"; the trap's server is slow (2.5 s of "Saving…") but keeps it.
 *   rollback    the new row shows at once; the broken twin's server refuses it (409) and the row quietly
 *               goes 1.5 s later with nothing said; the trap's first try fails with "Connection lost,
 *               retrying…" and the page retries by itself and keeps it.
 * Each has a needs-owner twin (a team code only the workspace owner knows). Every right answer is the
 * server's own record; the run's screen never decides it.
 */
import type { Page } from "playwright";
import { cap, codeField, codeOk, create, esc, field, idOf, js, made, no, ok, refused, shell, str, textInput, wrap, type ApiReply, type Inst, type ZooPage } from "./kit.ts";

/** A form (name, and the team code on the needs-owner twin) above a list the page draws itself. */
function optimisticPage(inst: Inst, script: string): string {
  const v = inst.v;
  const form = `<div id="f">${field(v, "name", v.labels.name, textInput())}${inst.twin === "needs_owner" ? codeField(v) : ""}<p id="err" class="err" role="alert"></p><p id="note" class="muted"></p><button type="button" id="save">${esc(v.labels.save)}</button></div>`;
  const body = `<h1>New ${esc(v.skin.entity)}</h1><div id="host" hidden>${wrap(v, form)}</div><h2>${esc(cap(v.skin.plural))}</h2><table><thead><tr><th>${esc(v.labels.name)}</th><th>State</th></tr></thead><tbody id="rows"></tbody></table>`;
  return shell(inst, `New ${v.skin.entity}`, body, `
const NAME = ${js(idOf(v, "name"))}, CODE = ${js(idOf(v, "code"))};
const val = (id) => (document.getElementById(id) ? document.getElementById(id).value : "");
const rows = document.getElementById("rows");
const row = (name, state) => { const tr = document.createElement("tr"); tr.innerHTML = "<td></td><td class=muted></td>"; tr.children[0].textContent = name; tr.children[1].textContent = state; rows.appendChild(tr); return tr; };
const err = (m) => { document.getElementById("err").textContent = m || ""; };
const note = (m) => { document.getElementById("note").textContent = m || ""; };
(async () => { const j = await Z.api("records"); for (const r of j.records || []) row(r.name, "Saved"); })();
setTimeout(() => { document.getElementById("host").hidden = false; }, Z.delay);
${script}`);
}

/** Shared server side: the code check, then a create of the name (or why not). */
function createName(inst: Inst, body: Record<string, unknown>): ApiReply | undefined {
  const denied = codeOk(inst, body);
  if (denied) return denied;
  if (!str(body.name).trim()) {
    refused(inst, "create", "missing a field");
    return no(422, "Fill in every field");
  }
  return undefined;
}

async function shown(page: Page): Promise<void> {
  await page.locator("#host").waitFor({ state: "visible" });
}
async function settled(page: Page, act: () => Promise<void>, timeout = 12_000): Promise<void> {
  const n = await page.evaluate(() => Number(document.body.dataset.zdone || 0));
  await act();
  await page.waitForFunction((m) => Number(document.body.dataset.zdone || 0) > m, n, { timeout });
}
async function fill(page: Page, inst: Inst, fact?: boolean): Promise<void> {
  await page.locator(`#${idOf(inst.v, "name")}`).fill(inst.v.name);
  if (inst.twin === "needs_owner" && fact) await page.locator(`#${idOf(inst.v, "code")}`).fill(inst.v.code);
}

/** The optimistic trap twin's save is sent this late (a slow save, as far as the tester can tell). */
const SLOW_MS = 2500;

const optimistic: ZooPage = {
  id: "optimistic",
  widget: "optimistic row, 200 with an error body",
  skin: "library",
  modes: {
    task: "the new row shows at once (\"Saving…\"), then \"Saved\" when the server keeps it",
    broken: "the server answers 200 with { ok: false, errors } and keeps nothing; the page reads only the status, so the row stays and it says \"Saved\"",
    trap: "the save takes 2.5 s (\"Saving…\" all that time), then the server keeps it",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}", save it, and check it shows in the list`,
  render(inst, path) {
    if (path !== "") return undefined;
    return optimisticPage(inst, `
document.getElementById("save").addEventListener("click", async () => {
  err(""); const name = val(NAME).trim();
  const tr = row(name, "Saving…");
  ${inst.twin === "trap" ? `await Z.sleep(${SLOW_MS});` : ""}
  const r = await Z.api("create", { name, code: val(CODE) });
  // The page trusts the status alone (the planted bug, on the broken twin, is the server's 200 with an error body).
  if (r.status === 200) { tr.children[1].textContent = "Saved"; Z.toast("Saved"); }
  else { tr.remove(); err(r.error || "Couldn't save"); }
  Z.settled();
});`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const bad = createName(inst, body);
    if (bad) return bad;
    if (inst.twin === "broken") {
      refused(inst, "create", "200 with an error body", { name: str(body.name) });
      return { status: 200, body: { ok: false, errors: [{ message: "Storage quota exceeded" }] } };
    }
    create(inst, { name: str(body.name).trim() });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name }),
  async solve(page, inst, o) {
    await shown(page);
    await fill(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

const rollback: ZooPage = {
  id: "rollback",
  widget: "optimistic row that rolls back",
  skin: "recipes",
  modes: {
    task: "the new row shows at once, and stays when the server keeps it",
    broken: "the server refuses it (409); the row quietly goes 1.5 s later, with nothing said",
    trap: "the first try answers 503 and the page says \"Connection lost, retrying…\"; it retries by itself and the server keeps it",
    needs_owner: "the save needs a team code only the workspace owner knows",
  },
  goal: ({ v }) => `Add a ${v.skin.entity} named "${v.name}", save it, and check it shows in the list`,
  seed(inst) {
    inst.state.tries = 0;
  },
  render(inst, path) {
    if (path !== "") return undefined;
    return optimisticPage(inst, `
document.getElementById("save").addEventListener("click", async () => {
  err(""); note(""); const name = val(NAME).trim();
  const tr = row(name, "");
  let r = await Z.api("create", { name, code: val(CODE) });
  if (r.status === 503) { note("Connection lost, retrying…"); await Z.sleep(1000); r = await Z.api("create", { name, code: val(CODE) }); note(""); }
  if (r.ok) { Z.settled(); return; }
  // A refusal: the row goes quietly a moment later (the planted bug says nothing); an owner's refusal is said.
  if (r.status === 409) { setTimeout(() => { tr.remove(); Z.settled(); }, 1500); return; }
  tr.remove(); err(r.error || "Couldn't save"); Z.settled();
});`);
  },
  api(inst, op, body) {
    if (op !== "create") return no(404, "no such action");
    const bad = createName(inst, body);
    if (bad) return bad;
    if (inst.twin === "broken") {
      refused(inst, "create", "409 conflict", { name: str(body.name) });
      return no(409, "Conflict");
    }
    if (inst.twin === "trap" && (inst.state.tries as number) === 0) {
      inst.state.tries = 1;
      refused(inst, "create", "503 first try", { name: str(body.name) });
      return no(503, "Service unavailable");
    }
    create(inst, { name: str(body.name).trim() });
    return ok();
  },
  done: (inst) => made(inst, { name: inst.v.name }),
  async solve(page, inst, o) {
    await shown(page);
    await fill(page, inst, o.fact);
    await settled(page, () => page.click("#save"));
  },
};

export const PROOF_PAGES: readonly ZooPage[] = [optimistic, rollback];
