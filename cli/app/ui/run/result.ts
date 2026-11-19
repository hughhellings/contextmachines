/**
 * S5: one run's result. A pill: PASS, FAIL, BLOCKED, NOT SURE or FLAKY, or a status such as Cancelled
 * (kept apart, C12). Its reason in one line. Tabs for the steps, the app log (console and network),
 * accessibility and friction. The video follows the steps both ways: "Go to" seeks, and the playing
 * step is marked. Speed is 1x, 2x or 4x.
 *
 * A BLOCKED run that met a captcha or bot check gets a card. On a site you own it shows the exact
 * one-line test-mode setup from the protect lane. On any other site it says plainly that the tester
 * never solves or gets around a check.
 *
 * Every word from a site or an AI is set as text. render is self-contained.
 */
import { scope } from "./css.ts";
import type { AppLogEntry, PlanStep, RunRecord, ScreenCtx, ScreenModule, StepResult } from "../../contracts.ts";

export const RESULT_CSS = `
.rn-res { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 20px; max-width: 1400px; margin: 0 auto; padding: 20px 16px 64px; align-items: start; }
.rn-res > * { min-width: 0; }
.rn-res .rn-vid { position: sticky; top: 64px; }
.rn-head { border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); padding: 14px 16px; display: grid; gap: 8px; }
.rn-h1 { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.rn-h1 b { font-size: 16px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-name { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.rn-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 12px; }
.rn-meta .dot::before { content: "·"; margin: 0 2px; }
.rn-acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.rn-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 5px 11px; cursor: pointer; font-weight: 500; white-space: nowrap; color: var(--fg); font-size: 13px; text-decoration: none; }
.rn-btn:hover { background: var(--hover); }
.rn-btn:disabled { opacity: .45; cursor: default; }
.rn-btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-btn[aria-pressed="true"] { background: var(--sel); border-color: var(--fg); }
.rn-btn .ico { width: 14px; height: 14px; }
.rn-btn:focus-visible, .rn-tabb:focus-visible, .rn-goto:focus-visible, .rn-srow:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.rn-said { background: var(--soft); border-radius: 8px; padding: 8px 10px; margin: 0; overflow-wrap: anywhere; }
.rn-block { border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 12px; background: var(--card); padding: 12px 14px; display: grid; gap: 8px; margin-top: 12px; }
.rn-block .t { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rn-block .t b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-block p { margin: 0; overflow-wrap: anywhere; }
.rn-setup { display: flex; gap: 8px; align-items: center; background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.rn-setup code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.rn-tabs2 { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin: 16px 0 8px; overflow-x: auto; }
.rn-tabb { border: 0; background: none; padding: 8px 10px; cursor: pointer; color: var(--muted); font-weight: 500; border-bottom: 2px solid transparent; white-space: nowrap; font-size: 13px; }
.rn-tabb[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--fg); }
.rn-tabb .c { font-variant-numeric: tabular-nums; color: var(--faint); margin-left: 4px; }
.rn-list { list-style: none; margin: 0; padding: 0; }
.rn-step { border-radius: 10px; }
.rn-step.open { background: var(--soft); }
.rn-srow { display: flex; align-items: flex-start; gap: 8px; padding: 8px; width: 100%; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 10px; color: var(--fg); font: inherit; }
.rn-srow:hover { background: var(--hover); }
.rn-step.playing > .rn-srow { box-shadow: inset 2px 0 0 var(--fg); background: var(--sel); }
.rn-n { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); flex: none; background: var(--card); font-variant-numeric: tabular-nums; }
.rn-st { flex: 1; min-width: 0; overflow-wrap: anywhere; padding-top: 1px; }
.rn-step.skipped .rn-st { color: var(--muted); }
.rn-tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; display: inline-flex; gap: 4px; align-items: center; margin-top: 2px; }
.rn-tag.assert { color: var(--pass); border-color: color-mix(in srgb, var(--pass) 40%, transparent); }
.rn-tag.judged { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.rn-tag.measured { color: var(--muted); }
.rn-tag .ico { width: 11px; height: 11px; }
.rn-stat { width: 16px; height: 16px; flex: none; margin-top: 3px; display: inline-flex; }
.rn-ok { color: var(--pass); } .rn-bad { color: var(--fail); } .rn-meh { color: var(--warn); } .rn-off { color: var(--faint); }
.rn-goto { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 1px 7px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--fg); margin-top: 1px; }
.rn-goto:hover { background: var(--hover); }
.rn-goto .ico { width: 10px; height: 10px; }
.rn-in { padding: 0 10px 10px 38px; display: grid; gap: 6px; }
.rn-sub { display: flex; gap: 8px; align-items: flex-start; color: var(--muted); font-size: 13px; }
.rn-sub .l { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-sub.err .l { color: var(--fail); }
.rn-sub.blocked .l { color: var(--warn); }
.rn-sub.playing { color: var(--fg); }
.rn-reason { margin: 0; font-size: 12px; color: var(--fail); overflow-wrap: anywhere; }
.rn-reason.warn { color: var(--warn); } .rn-reason.note { color: var(--muted); }
.rn-shot { width: 100%; max-width: 360px; border: 1px solid var(--line); border-radius: 8px; display: block; }
details.rn-look { border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
details.rn-look summary { cursor: pointer; padding: 6px 10px; font-size: 12px; color: var(--muted); }
details.rn-look pre { margin: 0; padding: 8px 10px; max-height: 280px; overflow: auto; font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; border-top: 1px solid var(--line); }
.rn-log { list-style: none; margin: 0; padding: 0; }
.rn-log li { display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px; border-bottom: 1px solid var(--line); font-size: 13px; }
.rn-log .x { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-log .x code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.rn-log .u { display: block; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.rn-lvl { font-size: 10px; font-weight: 700; border-radius: 5px; padding: 0 6px; flex: none; margin-top: 2px; background: var(--soft); color: var(--muted); }
.rn-lvl.error { background: var(--failbg); color: var(--fail); }
.rn-lvl.warn { background: var(--warnbg); color: var(--warn); }
.rn-filt { display: flex; gap: 6px; margin: 0 0 8px; flex-wrap: wrap; }
.rn-none { color: var(--muted); padding: 12px 8px; margin: 0; }
.rn-window { width: 100%; border-radius: 10px; overflow: hidden; background: var(--card); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 18px 48px rgba(0,0,0,.14); border: 1px solid var(--line); }
.rn-chrome { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: var(--soft); border-bottom: 1px solid var(--line); }
.rn-dots { display: inline-flex; gap: 6px; }
.rn-dots i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; background: var(--line); }
.rn-addr { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 6px; background: var(--bg); color: var(--muted); font-size: 12px; border: 1px solid var(--line); }
.rn-addr .ico { width: 11px; height: 11px; }
.rn-addr span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-screen { position: relative; aspect-ratio: 1280 / 800; background: #000; }
.rn-screen video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
/* E9: a run at a phone's width plays in a phone-shaped frame. */
.rn-window.rn-phone { max-width: 400px; margin: 0 auto; border-radius: 24px; }
.rn-window.rn-phone .rn-screen { aspect-ratio: 390 / 844; }
.rn-novid { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); background: var(--bg); padding: 16px; text-align: center; }
.rn-speed { display: flex; gap: 6px; align-items: center; margin-top: 8px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
.rn-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 8px; }
.rn-shots button { border: 1px solid var(--line); border-radius: 8px; padding: 0; overflow: hidden; background: none; cursor: pointer; position: relative; }
.rn-shots img { width: 100%; display: block; aspect-ratio: 16 / 10; object-fit: cover; }
.rn-shots span { position: absolute; left: 4px; bottom: 4px; font-size: 10px; background: rgba(0,0,0,.6); color: #fff; border-radius: 4px; padding: 0 4px; }
.rn-plan { margin: 4px 0 0; padding-left: 20px; font-size: 13px; }
.rn-plan li { margin: 3px 0; overflow-wrap: anywhere; }
.rn-thanks { color: var(--muted); font-size: 12px; }
.rn-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.rn-load { color: var(--muted); padding: 48px 16px; text-align: center; }
.rn-errbox { margin: 32px auto; max-width: 560px; padding: 12px 14px; border-radius: 8px; background: var(--failbg); color: var(--fail); overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .rn-res { grid-template-columns: minmax(0, 1fr); padding: 12px 12px 48px; }
  .rn-res .rn-vid { position: static; order: -1; }
}
`;

export const resultScreen: ScreenModule = {
  id: "run.result",
  routes: ["/p/:pid/runs/:rid"],
  css: scope(".rn-rw", RESULT_CSS),
  render: function renderResult(root: HTMLElement, ctx: ScreenCtx) {
    const { ui, api, router, events } = ctx;
    const pid = ctx.params.pid ?? "";
    const rid = ctx.params.rid ?? "";
    let alive = true;
    const rw = ui.el("div", "rn-rw");
    root.append(rw);
    rw.append(ui.el("p", "rn-load", "Loading the run…"));
    const st = { tab: "steps", open: new Set<number>(), logFilter: "all", shots: false, plan: false, rated: null as null | boolean, exported: "", busy: false, error: "" };
    let rec: RunRecord | null = null;
    let video: HTMLVideoElement | null = null;
    let syncNow: () => void = () => {};
    const page = ui.el("div", "rn-res");
    const main = ui.el("div");
    const side = ui.el("div", "rn-vid");
    const cleanups: (() => void)[] = [];

    const took = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };
    const WORDS: Record<string, string> = { environment: "the environment (the site or its address)", credentials: "credentials (an account or its password)", bot_wall: "a bot check or captcha", setup: "setup (something to set first)", automation: "automation (the browser couldn't do it)", safety_gate: "the safety gate (buy, post, send or delete)" };
    const STAT: Record<string, [string, string]> = { passed: ["okc", "rn-ok"], failed: ["badc", "rn-bad"], blocked: ["mehc", "rn-meh"], not_sure: ["mehc", "rn-meh"], skipped: ["offc", "rn-off"] };
    const statIcon = (v: string) => { const [n, c] = STAT[v] ?? ["offc", "rn-off"]; return ui.icon(n, "rn-stat " + c); };
    const seek = (at: number) => { if (!video) return; try { video.currentTime = at; void video.play().catch(() => {}); } catch { /* not loaded yet */ } };
    const goto = (at: number, tiny: boolean) => {
      const b = ui.el("button", "rn-goto"); b.type = "button"; b.title = "Go to " + ui.clock(at) + " in the video";
      b.append(ui.icon("play"), document.createTextNode((tiny ? "" : "Go to ") + ui.clock(at)));
      b.addEventListener("click", (e) => { e.stopPropagation(); seek(at); });
      return b;
    };
    const planOf = (n: number): PlanStep | undefined => rec?.plan?.[n - 1];
    // With no card for it (a run planned again from its goal shows the new plan's steps): a step that did something is an Act step.
    const kindOf = (s: StepResult) => planOf(s.n)?.kind ?? (s.check.kind === "signed_in" || s.check.kind === "password_gone" || (/\b(sign(ing|s)?[ -]?in|log(ging|s)?[ -]?in|login)\b/i.test(s.title) && !/^(check|verify|confirm|make sure|ensure|see|expect|assert|look for)\b/i.test(s.title.trim())) ? "login" : s.check.kind !== "none" && !s.actions?.length ? "assert" : "act");
    // Judged when its check is a judged one, when an AI's look passed it (a second opinion too), or when its card says so.
    const modeOf = (s: StepResult) => (s.check.kind === "judged" || s.judged ? "judged" : planOf(s.n)?.checkMode ?? "measured");
    const copy = async (text: string, what: string) => {
      try { await navigator.clipboard.writeText(text); ui.toast(what + " copied"); }
      catch { const t = ui.el("textarea"); t.value = text; document.body.append(t); t.select(); try { document.execCommand("copy"); ui.toast(what + " copied"); } catch { ui.toast("Couldn't copy: select it by hand"); } t.remove(); }
    };

    function headline(r: RunRecord): string {
      const s = r.summary; const res = r.result;
      if (s.status === "cancelled") return "Cancelled: you stopped it before it finished. A stopped run is not a failure.";
      if (s.status === "error") return "It couldn't run: " + (s.reason || "see the run folder");
      if (s.status === "interrupted") return "Interrupted before it finished: " + (s.reason || "the app closed");
      if (s.status === "skipped_busy") return "Skipped: another run was going when it was due.";
      if (s.status !== "completed") return "Still " + s.status + "…";
      const first = res.steps.find((x) => x.verdict !== "passed" && x.verdict !== "skipped");
      const ran = res.steps.filter((x) => x.verdict !== "skipped").length;
      if (s.verdict === "pass") return "All " + ran + " step" + (ran === 1 ? "" : "s") + " passed";
      if (s.verdict === "flaky") return "Flaky: it failed, then passed on a retry. Not a pass." + (s.reason ? " " + s.reason : "");
      if (s.verdict === "blocked") return "Blocked by " + (WORDS[s.blockedGroup ?? ""] ?? "something in the way") + (s.reason ? ": " + s.reason : first?.reason ? ": " + first.reason : "");
      if (first) return "Step " + first.n + ", " + first.title + ": " + (first.reason || first.verdict.replace("_", " "));
      return s.reason || res.stopped || "";
    }

    function paint() {
      if (!alive || !rec) return;
      const r = rec; const s = r.summary; const res = r.result;
      const first = !main.isConnected;
      if (first) { rw.replaceChildren(page); page.append(main, side); }
      main.replaceChildren();

      // ----- the head card --------------------------------------------------------------------
      const head = ui.el("section", "rn-head");
      const h1 = ui.el("div", "rn-h1");
      // A judged check that ran takes part in the verdict: the pill says so even when the summary forgot (never a bare PASS).
      const judged = Boolean(s.judged) || res.steps.some((x) => x.verdict !== "skipped" && (Boolean(x.judged) || x.check.kind === "judged" || (kindOf(x) === "assert" && modeOf(x) === "judged")));
      const pill = s.status === "completed" && s.verdict ? ui.pill(s.verdict, judged ? { judged: true } : undefined) : ui.pill(s.status);
      pill.dataset.role = "verdict";
      const hl = ui.el("b", null, headline(r)); hl.dataset.role = "headline";
      h1.append(pill, hl);
      head.append(h1, ui.el("div", "rn-name", s.name));
      const meta = ui.el("div", "rn-meta");
      const bits = [s.ms !== undefined ? took(s.ms) : res.ms ? took(res.ms) : "", s.replay ? "replay, 0 AI asks" : s.aiAsks !== undefined ? "AI, " + s.aiAsks + " ask" + (s.aiAsks === 1 ? "" : "s") : "", ui.ago(s.startedAt), s.source !== "manual" ? s.source : "", judged ? "a judged check took part" : "", res.siteNotes ? "used your notes about this site" : "", (r.handovers ?? []).some((h) => h.outcome === "resumed") ? ((r.handovers ?? []).every((h) => h.request.reason === "sign_in_code") ? "a person typed a sign-in code" : "a person passed a check") : ""].filter(Boolean);
      bits.forEach((b, i) => { if (i) meta.append(ui.el("span", "dot")); meta.append(ui.el("span", null, b)); });
      head.append(meta);
      if (res.replanned) head.append(ui.el("p", "rn-reason warn", res.replanned));
      if (res.startWarning) head.append(ui.el("p", "rn-reason warn", res.startWarning));
      if (res.stopped && s.status === "completed") head.append(ui.el("p", "rn-reason warn", "Stopped early: " + res.stopped));
      // NOT SURE or BLOCKED for what may be a rule of the site (not a bot check, a sign-in or a stop): the reason,
      // and a way to tell the tester about the site (Settings, "What the tester should know about this site").
      const why = (res.steps.find((x) => x.verdict !== "passed" && x.verdict !== "skipped")?.reason ?? s.reason ?? "").replace(/\s+/g, " ").trim();
      if (s.status === "completed" && (s.verdict === "not_sure" || s.verdict === "blocked") && !/\b(bot check|captcha|CODE_|SMS_|AUTH_|SESSION|stopped by you|DEVICE_CHECK|BOT_CHECK)/i.test(why) && s.blockedGroup !== "bot_wall" && s.blockedGroup !== "credentials") {
        const tell = ui.el("button", "rn-btn", "Tell the tester about this site");
        tell.type = "button";
        tell.dataset.role = "tell-notes";
        tell.title = "If it got stuck on a rule of your site, write the rule in plain words: every run reads it.";
        tell.addEventListener("click", () => {
          try { sessionStorage.setItem("cm-notes-from-run", why.slice(0, 400)); } catch { /* the box still opens */ }
          router.go("/p/" + pid + "/settings");
        });
        const line = ui.el("p", "rn-reason note", /^SEED_DATA_MISSING\b/.test(why) ? "The site had nothing the form could use: add it on the site first. If it has one already, name it for the tester in plain words. " : "If it got stuck on a rule of your site (what a complete record needs, which account to use), tell the tester in plain words. ");
        line.append(tell);
        head.append(line);
      }

      const acts = ui.el("div", "rn-acts");
      const shots = res.steps.filter((x) => x.screenshot && !x.sameShotAs);
      const shotsB = ui.el("button", "rn-btn"); shotsB.type = "button"; shotsB.setAttribute("aria-pressed", String(st.shots)); shotsB.disabled = !shots.length;
      shotsB.append(ui.icon("image"), document.createTextNode("Screenshots (" + shots.length + ")"));
      shotsB.addEventListener("click", () => { st.shots = !st.shots; paint(); });
      const planB = ui.el("button", "rn-btn", "View test plan"); planB.type = "button"; planB.setAttribute("aria-pressed", String(st.plan));
      planB.addEventListener("click", () => { st.plan = !st.plan; paint(); });
      const exportB = ui.el("button", "rn-btn", "Export report"); exportB.type = "button"; exportB.disabled = st.busy;
      exportB.addEventListener("click", async () => {
        st.busy = true; paint();
        const x = await api.call("POST /api/runs/:id/export", { id: s.id });
        st.busy = false;
        if (x.ok) st.exported = x.file; else st.error = x.error;
        paint();
      });
      const againB = ui.el("button", "rn-btn primary"); againB.type = "button"; againB.disabled = st.busy;
      againB.append(ui.icon("play"), document.createTextNode("Run again"));
      againB.addEventListener("click", async () => {
        st.busy = true; paint();
        const body = s.testId ? { projectId: pid, testId: s.testId, ...(s.envId ? { envId: s.envId } : {}) } : { projectId: pid, goal: res.goal, ...(r.plan ? { steps: r.plan } : {}), ...(s.envId ? { envId: s.envId } : {}) };
        const x = await api.call("POST /api/runs", {}, body);
        st.busy = false;
        if (x.ok) router.go("/p/" + pid + "/live"); else { st.error = x.error; paint(); }
      });
      acts.append(shotsB, planB, exportB, againB);
      head.append(acts);
      if (st.error) { const e = ui.el("p", "rn-reason", st.error); e.setAttribute("role", "alert"); head.append(e); }
      if (st.exported) { const e = ui.el("p", "rn-meta"); e.append(ui.el("span", null, "Report written to "), ui.el("code", "rn-code", st.exported)); head.append(e); }
      if (s.dir) { const d = ui.el("p", "rn-meta"); d.style.margin = "0"; d.append(ui.el("span", null, "Run folder: "), ui.el("code", "rn-code", s.dir)); head.append(d); }

      // Helpful / Not helpful (C14): kept on this machine, never sent anywhere.
      const rate = ui.el("div", "rn-acts");
      rate.append(ui.el("span", "rn-thanks", "Was this result helpful?"));
      const rated = st.rated ?? r.rating?.helpful ?? null;
      for (const [v, words] of [[true, "Helpful"], [false, "Not helpful"]] as const) {
        const b = ui.el("button", "rn-btn", words); b.type = "button"; b.setAttribute("aria-pressed", String(rated === v)); b.dataset.rate = String(v);
        b.addEventListener("click", async () => {
          const x = await api.call("POST /api/runs/:id/rating", { id: s.id }, { helpful: v });
          if (x.ok) { st.rated = v; ui.toast("Thanks: kept on this machine only"); } else st.error = x.error;
          paint();
        });
        rate.append(b);
      }
      head.append(rate);
      if (st.plan) {
        const ol = ui.el("ol", "rn-plan");
        const plan = r.plan ?? res.steps.map((x) => ({ title: x.title, intent: x.intent, check: x.check, kind: x.check.kind !== "none" ? "assert" : "act", checkMode: "measured", enabled: true, id: "s" + x.n } as PlanStep));
        for (const p of plan) {
          const li = ui.el("li");
          li.append(ui.el("span", "rn-tag" + (p.kind === "assert" ? " assert" : ""), p.kind === "login" ? "Login" + (p.accountLabel ? ": " + p.accountLabel : "") : p.kind === "assert" ? "Assert" : "Act"), document.createTextNode(" " + p.title + (p.enabled ? "" : " (off)")));
          if (p.kind === "assert") li.append(document.createTextNode(" "), ui.el("span", "rn-tag " + p.checkMode, p.checkMode));
          const ck = p.check as { kind: string; text?: string; name?: string };
          if (ck.kind !== "none") li.append(ui.el("span", "rn-meta", " · checks " + (ck.text ? ck.kind.replace(/_/g, " ") + ' "' + ck.text + '"' : ck.name ? 'element "' + ck.name + '" shows' : ck.kind.replace(/_/g, " "))));
          ol.append(li);
        }
        head.append(ol);
      }
      if (st.shots && shots.length) {
        const g = ui.el("div", "rn-shots");
        for (const x of shots) {
          const b = ui.el("button"); b.type = "button"; b.title = "Step " + x.n + ": " + x.title;
          const im = ui.el("img"); im.src = api.fileUrl(s.id, x.screenshot!); im.alt = b.title; im.loading = "lazy";
          b.append(im, ui.el("span", null, "Step " + x.n));
          b.addEventListener("click", () => seek(x.at + x.ms / 1000));
          g.append(b);
        }
        head.append(g);
      }
      main.append(head);

      // ----- BLOCKED by a captcha or bot check (E10): never solved, a setup line only on your own site.
      const walls = (r.protection ?? []).filter((f) => f.blocking || s.blockedGroup === "bot_wall");
      for (const f of walls) {
        const c = ui.el("section", "rn-block"); c.dataset.role = "protection";
        const t = ui.el("div", "t");
        t.append(ui.icon("warn", "rn-meh"), ui.el("b", null, (f.testMode ? "Met " : "Blocked by ") + f.name), ui.pill(f.testMode ? "pass" : "blocked"));
        c.append(t, ui.el("p", "rn-meta", f.host + (f.page ? " · " + f.page : "") + (f.at !== undefined ? " · at " + ui.clock(f.at) : "")));
        if (f.testMode) c.append(ui.el("p", null, "Its test mode is on, so the run could go on. Nothing was solved."));
        else if (f.owned && f.setup) {
          c.append(ui.el("p", null, "This is your site. Turn on " + f.name + "'s test mode, then run again:"));
          const line = ui.el("div", "rn-setup");
          const code = ui.el("code", null, f.setup); code.dataset.role = "setup";
          const cb = ui.el("button", "rn-btn", "Copy"); cb.type = "button";
          cb.addEventListener("click", () => void copy(f.setup ?? "", "Setup line"));
          line.append(code, cb);
          c.append(line);
          if (f.docUrl && /^https:\/\//.test(f.docUrl)) { const a = ui.el("a", "rn-meta", "The provider's page on test mode"); a.href = f.docUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; c.append(a); }
        } else c.append(ui.el("p", null, "This site isn't yours (it didn't pass the ownership check), so the run stays BLOCKED. The tester never solves or gets around a captcha or bot check. Run it on a site you own or its staging address, or watch the run and solve the check yourself when it asks."));
        c.append(ui.el("p", "rn-reason note", "Measured: " + f.evidence));
        main.append(c);
      }
      if (!walls.length && s.verdict === "blocked" && res.botWall) {
        const c = ui.el("section", "rn-block"); c.dataset.role = "protection";
        c.append(ui.el("b", null, "Blocked by the site's bot check (" + res.botWall + ")"), ui.el("p", null, "The tester never gets past a bot check. Try a site you own, its staging address, or ask the owner to let the tester through."));
        main.append(c);
      }
      // Only runs from before A1 have these (a run then could pause for a person); none is made now.
      for (const h of r.handovers ?? []) {
        const c = ui.el("section", "rn-block"); c.dataset.role = "handover";
        const code = h.request.reason === "sign_in_code";
        const what = code ? (h.request.wants === "link" ? "the sign-in link" : "the sign-in code") : "the check";
        const words = h.outcome === "resumed" ? (code ? "You typed " + what + " for " + h.request.host + ", and the run went on." : "You solved the check on " + h.request.host + ", and the run went on.") + (h.sessionSaved ? " The session was saved for later runs." : "")
          : h.outcome === "timedOut" ? "Nobody gave " + what + " on " + h.request.host + " in time, so the run ended BLOCKED." : "Giving " + what + " on " + h.request.host + " was given up, so the run ended BLOCKED.";
        c.append(ui.el("p", null, words));
        main.append(c);
      }

      // ----- tabs ------------------------------------------------------------------------------
      const log = r.log ?? [];
      const a11y = r.a11y?.findings ?? [];
      const tabs = ui.el("div", "rn-tabs2"); tabs.setAttribute("role", "tablist");
      const TABS: [string, string, number | null][] = [["steps", "Steps", res.steps.length], ["log", "Console & network", r.log ? log.length : null], ["a11y", "Accessibility", r.a11y ? a11y.length : null], ["friction", "Friction", res.friction.length]];
      for (const [id, words, n] of TABS) {
        const b = ui.el("button", "rn-tabb", words); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(st.tab === id)); b.dataset.tab = id;
        if (n !== null) b.append(ui.el("span", "c", String(n)));
        b.addEventListener("click", () => { st.tab = id; paint(); });
        tabs.append(b);
      }
      main.append(tabs);
      const panel = ui.el("div"); panel.setAttribute("role", "tabpanel");
      main.append(panel);
      if (st.tab === "steps") panel.append(stepsList(r));
      else if (st.tab === "log") panel.append(logList(r.log));
      else if (st.tab === "a11y") {
        if (!r.a11y) panel.append(ui.el("p", "rn-none", "Accessibility wasn't scanned in this run."));
        else if (!a11y.length) panel.append(ui.el("p", "rn-none", "No accessibility problems found on " + r.a11y.pages + " page" + (r.a11y.pages === 1 ? "" : "s") + "."));
        else {
          const ul = ui.el("ul", "rn-log");
          for (const f of a11y) { const li = ui.el("li"); const x = ui.el("span", "x"); x.append(ui.el("span", null, f.what), ui.el("span", "u", f.kind.replace(/_/g, " ") + " · " + f.wcag + " · " + f.page)); li.append(ui.el("span", "rn-lvl warn", "A11Y"), x); ul.append(li); }
          panel.append(ul);
        }
      } else {
        if (!res.friction.length) panel.append(ui.el("p", "rn-none", "Nothing in the way: no pop-ups, retries or slow steps were met."));
        else { const ul = ui.el("ul", "rn-log"); for (const f of res.friction) { const li = ui.el("li"); const x = ui.el("span", "x"); x.append(ui.el("span", null, f.says), ui.el("span", "u", f.kind.replace(/_/g, " ") + " · step " + f.step)); li.append(ui.el("span", "rn-lvl", "NOTE"), x); ul.append(li); } panel.append(ul); }
      }

      if (first) paintSide(r);
      syncNow();
    }

    /** The video and its speed, built once: painting the list again never reloads it. */
    function paintSide(r: RunRecord) {
      const s = r.summary; const res = r.result;
      const shots = res.steps.filter((x) => x.screenshot && !x.sameShotAs);
      side.replaceChildren();
      const win = ui.el("div", "rn-window");
      const chrome = ui.el("div", "rn-chrome");
      const dots = ui.el("span", "rn-dots"); dots.append(ui.el("i"), ui.el("i"), ui.el("i"));
      const addr = ui.el("span", "rn-addr"); const addrWords = ui.el("span", null, res.url);
      addr.append(ui.icon("lock"), addrWords);
      chrome.append(dots, addr);
      const screen = ui.el("div", "rn-screen");
      win.append(chrome, screen);
      side.append(win);
      const name = s.video ?? res.video;
      if (name) {
        const v = ui.el("video"); v.controls = true; v.playsInline = true; v.preload = "auto"; v.src = api.fileUrl(s.id, name);
        const poster = shots[0]?.screenshot; if (poster) v.poster = api.fileUrl(s.id, poster);
        screen.append(v);
        v.addEventListener("loadedmetadata", () => { if (v.videoWidth && v.videoHeight) win.classList.toggle("rn-phone", v.videoHeight > v.videoWidth); });
        video = v;
        const speed = ui.el("div", "rn-speed");
        speed.append(ui.el("span", null, "Speed"));
        for (const rate of [1, 2, 4]) {
          const b = ui.el("button", "rn-btn", rate + "x"); b.type = "button"; b.dataset.speed = String(rate); b.setAttribute("aria-pressed", String(v.playbackRate === rate));
          b.addEventListener("click", () => { v.playbackRate = rate; v.defaultPlaybackRate = rate; for (const x of speed.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b)); });
          speed.append(b);
        }
        side.append(speed);
        // The sign-in's own video (sign-in.webm), when the test signed in just before it began: its boxes show dots.
        if (res.signInVideo) { const a = ui.el("a", "rn-btn", "Watch the sign-in (its boxes show dots)"); a.href = api.fileUrl(s.id, res.signInVideo); a.target = "_blank"; a.rel = "noopener"; side.append(a); }
        const sync = () => {
          const now = v.currentTime;
          let cur = 0;
          for (const x of res.steps) if (x.verdict !== "skipped" && x.at <= now + 0.05) cur = x.n;
          for (const li of root.querySelectorAll<HTMLElement>(".rn-step")) li.classList.toggle("playing", Number(li.dataset.n) === cur && now > 0);
          let sub: Element | null = null;
          for (const x of root.querySelectorAll<HTMLElement>(".rn-step.playing .rn-sub[data-at]")) if (Number(x.dataset.at) <= now + 0.05) sub = x;
          for (const x of root.querySelectorAll(".rn-sub.playing")) if (x !== sub) x.classList.remove("playing");
          sub?.classList.add("playing");
          let u = res.url;
          for (const p of res.urls ?? []) { if (p.t > now + 0.05) break; u = p.url; }
          addrWords.textContent = u;
        };
        for (const ev of ["timeupdate", "seeked", "play", "pause"]) v.addEventListener(ev, sync);
        syncNow = sync;
        const t0 = Number(router.current().query.get("t"));
        const start = Number.isFinite(t0) && t0 > 0 ? t0 : 0;
        if (start) v.addEventListener("loadedmetadata", () => { v.currentTime = start; sync(); }, { once: true });
      } else {
        video = null;
        screen.append(ui.el("div", "rn-novid", s.status === "completed" ? "No video for this run." : "No video: the run didn't get that far."));
      }
    }

    function stepsList(r: RunRecord) {
      const ol = ui.el("ol", "rn-list");
      const hasVideo = Boolean(r.summary.video ?? r.result.video);
      for (const x of r.result.steps) {
        const open = st.open.has(x.n);
        const li = ui.el("li", "rn-step " + x.verdict + (open ? " open" : "")); li.dataset.n = String(x.n);
        const row = ui.el("button", "rn-srow"); row.type = "button"; row.setAttribute("aria-expanded", String(open));
        const k = kindOf(x);
        const tag = ui.el("span", "rn-tag" + (k === "assert" ? " assert" : "")); tag.append(ui.icon(k === "assert" ? "eye" : k === "login" ? "lock" : "wand"), document.createTextNode(k === "assert" ? "Assert" : k === "login" ? "Login" : "Act"));
        row.append(ui.el("span", "rn-n", String(x.n)), ui.el("span", "rn-st", x.title), tag);
        if (k === "assert") { const m = modeOf(x); const mt = ui.el("span", "rn-tag " + m, m); mt.dataset.role = "mode"; row.append(mt); }
        if (hasVideo && x.verdict !== "skipped") row.append(goto(x.at, false));
        row.append(statIcon(x.verdict));
        row.addEventListener("click", () => { if (st.open.has(x.n)) st.open.delete(x.n); else st.open.add(x.n); paint(); });
        li.append(row);
        if (open) {
          const box = ui.el("div", "rn-in");
          if (x.verdict === "skipped" && planOf(x.n)?.enabled === false) box.append(ui.el("p", "rn-reason note", "Switched off in the plan: not run."));
          for (const a of x.actions) {
            const sl = ui.el("div", "rn-sub" + (a.blocked ? " blocked" : a.error ? " err" : "")); sl.dataset.at = String(a.at);
            sl.append(ui.icon(a.blocked ? "stop" : a.cached ? "heal" : "pointer"), ui.el("span", "l", a.label + (a.cached ? " (replayed)" : "")));
            if (hasVideo) sl.append(goto(a.at, true));
            box.append(sl);
            if (a.error) box.append(ui.el("p", "rn-reason", "didn't work: " + a.error));
          }
          // A step that never started (a sign-in BLOCKED before it, or a later step not run) says only its reason.
          if (!x.actions.length && !(x.verdict === "blocked" && /^[A-Z_]{6,}: /.test(x.reason ?? "")) && x.verdict !== "skipped") box.append(ui.el("p", "rn-reason note", "Nothing was done in this step: its check was measured as it stood."));
          if (x.reason && x.verdict !== "passed") box.append(ui.el("p", "rn-reason" + (x.verdict === "failed" ? "" : " warn"), x.reason));
          if (x.evidence) box.append(ui.el("p", "rn-reason", "Expected " + x.evidence.expected + "; found " + x.evidence.found));
          if (x.weak && x.verdict === "passed") box.append(ui.el("p", "rn-reason note", "Note: " + x.weak + "."));
          // What the step filled at its save (fill.ts): counts and the labels left empty, never a value.
          if (x.fill && x.verdict !== "skipped") { const F = x.fill; box.append(ui.el("p", "rn-reason note", "Filled " + F.filled + " of " + F.shown + " field" + (F.shown === 1 ? "" : "s") + " shown" + (F.empty.length ? "; left empty: " + F.empty.slice(0, 6).join(", ") + (F.empty.length > 6 ? " and " + (F.empty.length - 6) + " more" : "") + (F.kept ? " (" + F.kept + ")" : "") : "") + ".")); }
          if (x.healed) box.append(ui.el("p", "rn-reason note", "Healed: " + x.healed.from.join(" → ") + " no longer worked; now " + (x.healed.to.join(" → ") || "nothing more") + "."));
          if (x.judged?.by === "second opinion") box.append(ui.el("p", "rn-reason note", "Judged by AI (a second opinion): the planned check didn't hold, and an AI looking at the page said the goal was met. " + (x.judged.overruled ? "Overruled: " + x.judged.overruled + ". " : "") + "Its reason: " + x.judged.reason));
          else if (modeOf(x) === "judged") box.append(ui.el("p", "rn-reason note", "This check was judged by an AI looking at the page, not measured. A judged check never makes a PASS on its own." + (x.judged?.reason ? " Its reason: " + x.judged.reason : "")));
          const shot = x.screenshot ?? (x.sameShotAs ? r.result.steps[x.sameShotAs - 1]?.screenshot : undefined);
          if (shot) { const im = ui.el("img", "rn-shot"); im.src = ctx.api.fileUrl(r.summary.id, shot); im.alt = "The page at the end of step " + x.n; im.loading = "lazy"; im.addEventListener("error", () => im.remove()); box.append(im); }
          // What the AI was given, masked, and why the verdict (C10). Never a secret: the server masks it.
          for (const l of (r.looks ?? []).filter((l) => l.step === x.n)) {
            const d = ui.el("details", "rn-look"); const sm = ui.el("summary", null, "What the AI saw at " + ui.clock(l.at) + (l.why ? ": " + l.why : ""));
            d.append(sm, ui.el("pre", null, l.snapshot));
            box.append(d);
          }
          li.append(box);
        }
        ol.append(li);
      }
      return ol;
    }

    function logList(log: AppLogEntry[] | undefined) {
      const wrap = ui.el("div");
      if (!log) { wrap.append(ui.el("p", "rn-none", "This run was made before the app log existed.")); return wrap; }
      const filt = ui.el("div", "rn-filt");
      const errs = log.filter((e) => e.level === "error").length;
      const net = log.filter((e) => e.kind === "http_error" || e.kind === "request_failed").length;
      for (const [id, words] of [["all", "All " + log.length], ["errors", "Errors " + errs], ["network", "Network " + net]] as const) {
        const b = ui.el("button", "rn-btn", words); b.type = "button"; b.setAttribute("aria-pressed", String(st.logFilter === id)); b.dataset.filter = id;
        b.addEventListener("click", () => { st.logFilter = id; paint(); });
        filt.append(b);
      }
      wrap.append(filt);
      const shown = log.filter((e) => st.logFilter === "all" || (st.logFilter === "errors" ? e.level === "error" : e.kind === "http_error" || e.kind === "request_failed"));
      if (!shown.length) { wrap.append(ui.el("p", "rn-none", log.length ? "Nothing of that kind." : "Nothing logged: no console errors, failed requests or 4xx/5xx answers.")); return wrap; }
      const ul = ui.el("ul", "rn-log");
      const hasVideo = Boolean(rec?.summary.video ?? rec?.result.video);
      for (const e of shown) {
        const li = ui.el("li");
        const lvl = ui.el("span", "rn-lvl " + e.level, e.status ? String(e.status) : e.kind === "pageerror" ? "ERROR" : e.kind === "navigation" ? "NAV" : e.level.toUpperCase());
        const x = ui.el("span", "x");
        x.append(ui.el("code", null, e.text + (e.count && e.count > 1 ? " (×" + e.count + ")" : "")));
        x.append(ui.el("span", "u", [e.kind.replace(/_/g, " "), e.method && e.url ? e.method + " " + e.url : e.url ?? "", "step " + e.step].filter(Boolean).join(" · ")));
        li.append(lvl, x);
        if (hasVideo) li.append(goto(e.at, true));
        ul.append(li);
      }
      wrap.append(ul);
      return wrap;
    }

    async function load() {
      const r = await api.call("GET /api/runs/:id", { id: rid });
      if (!alive) return;
      if (!r.ok) { rw.replaceChildren(ui.el("div", "rn-errbox", r.error)); return; }
      rec = r.run;
      // A failed or not-sure step opens by itself, as in the live view.
      for (const x of rec.result.steps) if (x.verdict === "failed" || x.verdict === "not_sure" || x.verdict === "blocked") st.open.add(x.n);
      paint();
    }
    void load();
    // A route change within this screen (?t= from an issue's Go to) seeks the video.
    cleanups.push(router.onChange(() => { const c = router.current(); if (c.route !== "/p/:pid/runs/:rid" || c.params.rid !== rid) return; const t = Number(c.query.get("t")); if (Number.isFinite(t) && t > 0) seek(t); }));
    // The run was stored again (a rating from another tab, a heal): show it fresh.
    cleanups.push(events.on("run", (e) => { if (e.summary.id === rid) void load(); }));
    return () => { alive = false; video?.pause(); for (const c of cleanups) c(); };
  },
};
