/**
 * U10: the "Set up sign-in" pop-up (A1). A run never waits for a person: there is no pop-up during a
 * run. Before the runs, under Accounts, "Set up sign-in" opens a real browser window on the person's own
 * computer, where they sign in themselves once (type the code from their email or phone, open the magic
 * link, solve a captcha, sign in with Google). This pop-up only says so and waits for their Done or Give
 * up; nothing of that window comes to this page, and nothing typed here goes anywhere.
 *
 * Mounted once by the shell (routes: []), on every screen. render is self-contained.
 */
import { scope } from "./css.ts";
import type { HandOverRequest, ScreenCtx } from "../../contracts.ts";
import type { OverlayModule, RunLiveEvent } from "./ext.ts";

export const HANDOVER_CSS = `
.rn-ho-back { position: fixed; inset: 0; background: color-mix(in srgb, #000 45%, transparent); z-index: 40; display: flex; align-items: center; justify-content: center; padding: 16px; }
.rn-ho { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.3); display: grid; gap: 12px; padding: 16px; }
.rn-ho .h { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.rn-ho .h b { font-size: 17px; flex: 1; min-width: 0; }
.rn-ho p { margin: 0; overflow-wrap: anywhere; }
.rn-ho .m { color: var(--muted); font-size: 13px; }
.rn-ho .left { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.rn-ho .acts { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
.rn-ho .rn-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 7px 14px; cursor: pointer; font-weight: 500; white-space: nowrap; color: var(--fg); font-size: 13px; }
.rn-ho .rn-btn:hover { background: var(--hover); }
.rn-ho .rn-btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-ho .rn-btn:disabled { opacity: .45; cursor: default; }
.rn-ho .rn-btn:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.rn-ho .err { color: var(--fail); font-size: 13px; }
@media (max-width: 600px) { .rn-ho { padding: 12px; } .rn-ho .h b { font-size: 15px; } }
`;

export const handoverOverlay: OverlayModule = {
  id: "run.handover",
  routes: [],
  overlay: true,
  css: scope(".rn-hor", HANDOVER_CSS),
  render: function renderHandover(root: HTMLElement, ctx: ScreenCtx) {
    const { ui, api, events } = ctx;
    let open: { testId: string; req: HandOverRequest } | null = null;
    let busy = false;
    let error = "";
    let before: Element | null = null;

    /** What is still open, from what was said so far (a reload, or the server's replay after a reconnect). */
    const stillOpen = (): { testId: string; req: HandOverRequest } | null => {
      const ended = new Set<string>();
      const all = events.history() as readonly RunLiveEvent[];
      for (let k = all.length - 1; k >= 0; k--) {
        const e = all[k]!;
        if (e.type !== "handover") continue;
        if (e.state !== "needed") ended.add(e.handover);
        else if (e.request.reason === "sign_in_setup" && !ended.has(e.request.id) && Date.parse(e.request.deadline) > Date.now()) return { testId: e.id, req: e.request };
      }
      return null;
    };
    open = stillOpen();
    /** Between the server's "hello" and "replayed" it is replaying its log (a reconnect): nothing is decided, or said, until it ends. */
    let replaying = false;

    const back = ui.el("div", "rn-ho-back"); back.hidden = true;
    const box = ui.el("div", "rn-ho"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "rn-ho-title");
    back.append(box);
    const hor = ui.el("div", "rn-hor");
    hor.append(back);
    root.append(hor);

    const leftTag = ui.el("span", "left");
    const errP = ui.el("p", "err"); errP.setAttribute("role", "alert");
    const doneB = ui.el("button", "rn-btn primary", "Done"); doneB.type = "button"; doneB.dataset.role = "done";
    const giveB = ui.el("button", "rn-btn", "Give up"); giveB.type = "button"; giveB.dataset.role = "cancel";

    function paint() {
      back.hidden = !open;
      if (!open) return;
      const r = open.req;
      box.replaceChildren();
      // A real window on this computer: nothing of it comes to this page.
      const h = ui.el("div", "h");
      const t = ui.el("b", null, "Set up sign-in" + (r.account ? " for " + r.account : "")); t.id = "rn-ho-title";
      h.append(ui.icon("warn"), t, leftTag);
      box.append(h, ui.el("p", null, r.words), ui.el("p", "m", r.host + ". Done is checked: the session is saved only once the page shows you signed in. Runs then reuse it with no one there."));
      errP.textContent = error; errP.hidden = !error;
      box.append(errP);
      const acts = ui.el("div", "acts");
      doneB.disabled = busy; giveB.disabled = busy;
      acts.append(giveB, doneB);
      box.append(acts);
      tick();
    }
    function tick() {
      if (!open) return;
      const s = Math.max(0, Math.floor((Date.parse(open.req.deadline) - Date.now()) / 1000));
      leftTag.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " left";
    }
    function show(testId: string, req: HandOverRequest) {
      if (Date.parse(req.deadline) <= Date.now()) return;
      const was = open?.req.id === req.id;
      open = { testId, req }; error = ""; busy = false;
      if (was) { paint(); return; }
      before = document.activeElement;
      paint();
      doneB.focus();
    }
    function close(words?: string) {
      if (!open) return;
      open = null;
      paint();
      if (words && !replaying) ui.toast(words);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    }
    box.addEventListener("keydown", (e) => {
      // Focus stays in the pop-up while it is open.
      if (e.key !== "Tab") return;
      const f = [...box.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1]?.focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0]?.focus(); }
    });
    doneB.addEventListener("click", async () => {
      if (!open) return;
      busy = true; paint();
      const r = await api.call("POST /api/handover/:id/done", { id: open.req.id });
      busy = false;
      if (!r.ok && open) { error = r.error; paint(); } else paint();
    });
    giveB.addEventListener("click", async () => {
      if (!open) return;
      busy = true; paint();
      const r = await api.call("POST /api/handover/:id/cancel", { id: open.req.id });
      busy = false;
      if (!r.ok && open) { error = r.error; paint(); } else paint();
    });

    const offs = [
      events.on("hello", () => { replaying = true; }),
      events.on("replayed", () => {
        if (!replaying) return;
        replaying = false;
        const now = stillOpen();
        if (!now) close();
        else show(now.testId, now.req);
      }),
      events.on("handover", (e) => {
        if (replaying) return;
        if (e.state === "needed") { if (e.request.reason === "sign_in_setup") show(e.id, e.request); return; }
        if (!open || e.handover !== open.req.id) return;
        close(e.state === "resumed" ? "Checking that you're signed in…" : e.state === "timedOut" ? "Nobody finished signing in in time: nothing was saved" : "Given up: nothing was saved");
      }),
    ];
    const timer = setInterval(tick, 1000);
    paint();
    return () => { clearInterval(timer); for (const off of offs) off(); };
  },
};
