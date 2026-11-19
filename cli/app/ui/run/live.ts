/**
 * S4: the live run, side by side. On the left are the steps. The running one opens to what the AI is
 * doing, line by line, and "Thinking… n s" counts while an AI is asked. At the bottom are the timer and
 * Stop. On the right is the live browser in a window frame. When the test ends the frame becomes its
 * video, and every step gets a "Go to".
 *
 * It reads the protocol ui-server sends today (job, test, ev, frame, noscreen, notrun, couldnt,
 * result, jobEnd, busy) and the app's additions (working, protection, run, screen). It is
 * rebuilt from events.history() on open, so a reload, or coming back from another screen, shows the
 * same run. Leaving the screen never stops the run.
 *
 * Status and verdict are kept apart (C12): Stop shows "Cancelled", never FAIL. A sign-in is shown live
 * like the rest of the run, its boxes as dots (cover.ts); a "screen hidden" window the server opens
 * (C8, C20b) paints no frame that arrives in it.
 *
 * render is self-contained: the shell inlines its source.
 */
import type { ProtectionFinding, ScreenCtx, ScreenModule, StepResult, TestEvent, TestResult } from "../../contracts.ts";
import { scope } from "./css.ts";
import type { ResultEventFull, RunLiveEvent } from "./ext.ts";

export const LIVE_CSS = `
.rn-live { display: grid; grid-template-columns: minmax(300px, 400px) minmax(0, 1fr); height: calc(100vh - 48px); min-height: 480px; }
.rn-left { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; min-width: 0; background: var(--bg); }
.rn-right { background: var(--stage, var(--soft)); display: flex; align-items: center; justify-content: center; padding: 24px; min-width: 0; min-height: 0; }
.rn-lhead { padding: 12px 16px 6px; display: flex; flex-direction: column; gap: 4px; }
.rn-lhead b { font-size: 15px; overflow-wrap: anywhere; }
.rn-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 12px; }
.rn-tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; display: inline-flex; gap: 4px; align-items: center; }
.rn-tag.assert { color: var(--pass); border-color: color-mix(in srgb, var(--pass) 40%, transparent); }
.rn-tag .ico { width: 11px; height: 11px; }
.rn-jobs { border-bottom: 1px solid var(--line); padding: 6px 8px; max-height: 28vh; overflow: auto; flex: none; }
.rn-jobs button { display: flex; width: 100%; gap: 8px; align-items: center; text-align: left; border: 0; background: none; padding: 6px 8px; border-radius: 8px; cursor: pointer; color: var(--fg); }
.rn-jobs button:hover { background: var(--hover); }
.rn-jobs button[aria-current="true"] { background: var(--sel); }
.rn-jobs .g { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-scroll { flex: 1; min-height: 0; overflow: auto; }
.rn-steps { list-style: none; margin: 0; padding: 4px 8px 12px; }
.rn-step { border-radius: 10px; margin-bottom: 2px; }
.rn-step.running, .rn-step.open { background: var(--soft); }
.rn-srow { display: flex; align-items: flex-start; gap: 8px; padding: 8px; width: 100%; border: 0; background: none; text-align: left; cursor: pointer; border-radius: 10px; color: var(--fg); font: inherit; }
.rn-srow:hover { background: var(--hover); }
.rn-srow:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
.rn-n { width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); flex: none; font-variant-numeric: tabular-nums; background: var(--card); }
.rn-step.running .rn-n { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-st { flex: 1; min-width: 0; overflow-wrap: anywhere; padding-top: 1px; }
.rn-step.running .rn-st { font-weight: 600; }
.rn-step.pending .rn-st, .rn-step.skipped .rn-st { color: var(--muted); }
.rn-stat { width: 16px; height: 16px; flex: none; margin-top: 3px; display: inline-flex; }
.rn-ok { color: var(--pass); } .rn-bad { color: var(--fail); } .rn-meh { color: var(--warn); } .rn-off { color: var(--faint); }
.rn-subs { list-style: none; margin: 0; padding: 0 10px 8px 38px; }
.rn-sub { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; color: var(--muted); font-size: 13px; }
.rn-sub .l { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-sub .ico { width: 14px; height: 14px; margin-top: 2px; }
.rn-sub.err .l { color: var(--fail); }
.rn-sub.blocked .l { color: var(--warn); }
.rn-sub .why { display: block; font-size: 12px; color: var(--fail); }
.rn-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; background: var(--card); font-variant-numeric: tabular-nums; }
.rn-pill.think { color: var(--fg); }
.rn-reason { margin: 0 10px 8px 38px; font-size: 12px; color: var(--fail); overflow-wrap: anywhere; }
.rn-reason.warn { color: var(--warn); }
.rn-reason.note { color: var(--muted); }
.rn-goto { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; border: 1px solid var(--line); background: var(--card); border-radius: 6px; padding: 1px 7px; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--fg); margin-top: 1px; }
.rn-goto:hover { background: var(--hover); }
.rn-goto .ico { width: 10px; height: 10px; }
.rn-step.playing > .rn-srow { box-shadow: inset 2px 0 0 var(--fg); background: var(--sel); }
.rn-card2 { margin: 6px 12px 10px; border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--card); box-shadow: var(--shadow); display: grid; gap: 8px; }
.rn-card2 .h { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rn-card2 .h b { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-card2 p { margin: 0; overflow-wrap: anywhere; }
.rn-said { background: var(--soft); border-radius: 8px; padding: 8px 10px; }
.rn-protect { border-left: 3px solid var(--warn); }
.rn-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); color: var(--muted); flex: none; background: var(--bg); }
.rn-bar .w { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rn-sq { width: 9px; height: 9px; background: currentColor; border-radius: 1px; display: inline-block; }
.rn-window { width: 100%; max-width: 1100px; border-radius: 10px; overflow: hidden; background: var(--card); box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 18px 48px rgba(0,0,0,.14); border: 1px solid var(--line); }
.rn-chrome { height: 36px; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: var(--soft); border-bottom: 1px solid var(--line); }
.rn-dots { display: inline-flex; gap: 6px; }
.rn-dots i { width: 11px; height: 11px; border-radius: 50%; display: inline-block; background: var(--line); }
.rn-addr { flex: 1; min-width: 0; max-width: 560px; margin: 0 auto; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 6px; background: var(--bg); color: var(--muted); font-size: 12px; border: 1px solid var(--line); }
.rn-addr .ico { width: 11px; height: 11px; }
.rn-addr span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn-screen { position: relative; aspect-ratio: 1280 / 800; background: var(--bg); }
.rn-screen img, .rn-screen video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.rn-screen video { background: #000; }
.rn-vnote { margin: 0; padding: 6px 10px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); }
.rn-wait { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; padding: 16px; }
.rn-wait b { font-size: 15px; }
.rn-orb { width: 64px; height: 64px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, var(--faint), var(--muted) 70%); margin-bottom: 8px; animation: rnpulse 1.6s ease-in-out infinite; }
.rn-lockbig { width: 40px; height: 40px; color: var(--muted); margin-bottom: 6px; }
.rn-lockbig svg { width: 100%; height: 100%; }
@keyframes rnpulse { 50% { transform: scale(.94); opacity: .8; } }
.rn-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-weight: 500; white-space: nowrap; color: var(--fg); font-size: 13px; }
.rn-btn:hover { background: var(--hover); }
.rn-btn:disabled { opacity: .45; cursor: default; }
.rn-btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-btn .ico { width: 14px; height: 14px; }
.rn-spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; animation: rnspin .8s linear infinite; display: inline-block; flex: none; }
@keyframes rnspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .rn-spin, .rn-orb { animation-duration: 3s; } }
.rn-empty { max-width: 520px; margin: 64px auto; text-align: center; color: var(--muted); padding: 0 16px; }
/* E9: a run at a phone's width is shown in a phone-shaped frame, as tall as it is. */
.rn-window.rn-phone { max-width: 400px; margin: 0 auto; border-radius: 24px; }
.rn-window.rn-phone .rn-screen { aspect-ratio: 390 / 844; }
@media (max-width: 860px) {
  .rn-live { grid-template-columns: minmax(0, 1fr); height: auto; }
  .rn-left { border-right: 0; border-bottom: 1px solid var(--line); }
  .rn-right { padding: 12px; order: -1; }
  .rn-bar { position: sticky; bottom: 0; }
}
`;

export const liveScreen: ScreenModule = {
  id: "run.live",
  routes: ["/p/:pid/live"],
  css: scope(".rn-lw", LIVE_CSS),
  render: function renderLive(root: HTMLElement, ctx: ScreenCtx) {
    const { ui, api, router, events } = ctx;
    const pid = ctx.params.pid ?? "";
    type SubState = "running" | "ok" | "err" | "blocked" | "stopped";
    interface Sub { label: string; state: SubState; at?: number; error?: string; act?: boolean; heal?: boolean; since?: number; ai?: boolean }
    interface Step { n: number; title: string; intent: string; check: StepResult["check"]; state: string; subs: Sub[]; open: boolean; reason?: string; evidence?: StepResult["evidence"]; weak?: string; at?: number; ms?: number; healed?: StepResult["healed"]; kind?: "act" | "assert" | "login" }
    interface Test {
      id: string; goal: string; url: string; status: string; steps: Step[]; phase: string; phaseSince: number; replay: boolean;
      began?: number; ended?: number; result?: TestResult; video?: string; signInVideo?: string; signingWords?: string; why?: string; noScreen?: string; runId?: string; folder?: string;
      /** The live screen is hidden (a secret is typed, or a sign-in runs), and by whom: the server's window ends only with its own end. */
      hidden?: string; hiddenBy?: "server" | "page"; signingIn?: boolean; session?: string; protections: ProtectionFinding[];
    }
    const S = {
      busy: null as string | null,
      job: null as null | { id: string; explore: boolean; began: number; ended?: number },
      tests: new Map<string, Test>(),
      order: [] as string[],
      sel: null as string | null,
      follow: true,
      frames: new Map<string, { jpeg: string; url: string }>(),
      jobEnd: null as null | { summary: string; ms: number },
      stopping: false,
      /** A test was stopped by you in this job: a test left running when the job ends was stopped too, not broken. */
      stoppedByYou: false,
      error: "",
    };
    const STOPPED = /^stopped by you$|^Stopped\.?$/i;
    /** An action or working line that types a secret: a sign-in word, or a masked value ('{name}'). The server's own window is the real guard; this is a second one. */
    const SECRET = /^Securely\b|\b(password|passcode|passphrase|secret|one-time code|otp|pin|2fa|token|api key|card number|cvc|cvv)\b|'\{[^}']+\}'/i;
    const hide = (t: Test, words: string, by: "server" | "page") => { if (t.hiddenBy !== "server") { t.hidden = words; t.hiddenBy = by; } S.frames.delete(t.id); };
    const unhide = (t: Test, by: "server" | "page" | "all") => { if (by === "all" || t.hiddenBy === by || (by === "server" && t.hiddenBy === "page")) { delete t.hidden; delete t.hiddenBy; } };

    const test = (id: string | null) => (id ? S.tests.get(id) : undefined);
    const finishWorking = (st: Step, ok: boolean) => { for (const s of st.subs) if (s.state === "running") s.state = ok ? "ok" : "err"; };
    const stopAll = (t: Test) => {
      for (const s of t.steps) {
        for (const x of s.subs) if (x.state === "running") x.state = "stopped";
        if (s.state === "running" || s.state === "pending") s.state = s.state === "running" ? "stopped" : "skipped";
      }
    };
    /** The card's kind when the plan came from cards; otherwise a sign-in check reads as Login, a step that only looks ("Check…", "Verify…") as Assert, and the rest as Act. */
    const kindOf = (st: Step) => st.kind ?? (st.check.kind === "signed_in" || st.check.kind === "password_gone" || (/\b(sign(ing|s)?[ -]?in|log(ging|s)?[ -]?in|login)\b/i.test(st.title) && !/^(check|verify|confirm|make sure|ensure|see|expect|assert|look for)\b/i.test(st.title.trim())) ? "login" : /^(check|verify|confirm|make sure|ensure|see|expect|assert|look for)\b(?!\s+(out|in|off)\b)/i.test(st.title) ? "assert" : "act");

    function apply(m: RunLiveEvent) {
      switch (m.type) {
        case "busy":
          S.busy = m.busy;
          if (!m.busy) {
            // A test the job left running or queued: stopped by you only when you stopped it; otherwise the job broke (an error), never "cancelled".
            const byYou = S.stopping || S.stoppedByYou || /^Stopped\.?$/i.test(S.error);
            S.stopping = false;
            for (const t of S.tests.values()) if (t.status === "running" || t.status === "queued") {
              if (byYou) { t.status = "cancelled"; t.why = t.why || "Stopped before it finished."; }
              else { t.status = "couldnt"; t.why = S.error || "The run ended before this test finished."; }
              t.ended = Date.now(); stopAll(t);
            }
          }
          break;
        case "error": S.error = m.words; break;
        case "job":
          S.job = { id: m.id, explore: m.explore, began: Date.now() };
          S.jobEnd = null; S.tests = new Map(); S.order = []; S.frames = new Map(); S.follow = true; S.error = ""; S.stoppedByYou = false;
          for (const t of m.tests) { S.tests.set(t.id, { id: t.id, goal: t.goal, url: t.url, status: "queued", steps: [], phase: "", phaseSince: Date.now(), replay: t.replay, protections: [] }); S.order.push(t.id); }
          S.sel = S.order[0] ?? null;
          break;
        case "test": {
          const t = test(m.id); if (!t) break;
          t.status = "running"; t.began = m.at; t.phase = "Opening the site"; t.phaseSince = m.at; if (m.noScreen) t.noScreen = m.noScreen;
          if (S.job && S.order[0] === m.id) S.job.began = m.at;
          if (S.follow) S.sel = t.id;
          break;
        }
        case "noscreen": { const t = test(m.id); if (t) t.noScreen = m.words; S.frames.delete(m.id); break; }
        case "screen": {
          const t = test(m.id); if (!t) break;
          if (m.hidden) { t.hidden = m.words || "Hidden while a secret is typed"; t.hiddenBy = "server"; S.frames.delete(m.id); } else unhide(t, "server");
          break;
        }
        case "signin": {
          const t = test(m.id); if (!t) break;
          // The sign-in's own page is shown live (its boxes as dots): only the words over it change.
          if (m.state === "start") { t.signingWords = m.words || "Signing in…"; t.signingIn = true; S.frames.delete(m.id); } else t.signingIn = false;
          break;
        }
        case "session": { const t = test(m.id); if (t) t.session = m.words; break; }
        case "ev": {
          const t = test(m.id); if (!t) break;
          const e: TestEvent = m.e;
          if (e.type === "phase") { t.phase = e.words; t.phaseSince = Date.now(); break; }
          if (e.type === "planned") { t.steps = e.steps.map((s, i) => ({ n: i + 1, title: s.title, intent: s.intent, check: s.check, ...(s.kind ? { kind: s.kind } : {}), state: "pending", subs: [], open: false })); t.phase = ""; break; }
          const n = e.type === "stepEnd" ? e.step.n : e.n;
          const st = t.steps[n - 1];
          if (!st) break;
          if (e.type === "step") { for (const o of t.steps) o.open = false; st.state = "running"; st.open = true; }
          else if (e.type === "working") {
            const last = st.subs[st.subs.length - 1];
            if (last && last.state === "running" && last.label === e.words) break; // its "working" twin came first
            finishWorking(st, true);
            st.subs.push({ label: e.words, state: "running", ...(e.at !== undefined ? { at: e.at } : {}), since: Date.now(), ai: /^Asking the AI/i.test(e.words) });
            if (SECRET.test(e.words)) hide(t, "Hidden while a secret is typed", "page");
          } else if (e.type === "action") {
            finishWorking(st, true);
            const a = e.action;
            st.subs.push({ label: a.label, state: a.blocked ? "blocked" : a.error ? "err" : "ok", at: a.at, act: true, ...(a.error ? { error: a.error } : {}) });
            if (SECRET.test(a.label)) hide(t, "Hidden while a secret is typed", "page");
          } else if (e.type === "healing") { finishWorking(st, true); st.subs.push({ label: e.unfinished ? "The saved actions stopped short: " + e.missing + (e.ai ? ": asking the AI to finish it" : "") : "Can't find " + e.missing + (e.ai ? ": asking the AI for this step" : ""), state: "ok", heal: true }); }
          else if (e.type === "stepEnd") {
            const r = e.step; finishWorking(st, r.verdict === "passed");
            st.state = r.verdict; st.at = r.at; st.ms = r.ms;
            if (r.reason) st.reason = r.reason; if (r.evidence) st.evidence = r.evidence; if (r.weak) st.weak = r.weak; if (r.healed) st.healed = r.healed;
            st.open = r.verdict !== "passed" && r.verdict !== "skipped";
            unhide(t, "page");
          }
          break;
        }
        case "working": {
          // The server's own clock for when this ask began, so the ticker is true after a reload too.
          const t = test(m.id); const st = t?.steps[m.n - 1]; if (!t || !st) break;
          const last = st.subs[st.subs.length - 1];
          if (last && last.state === "running" && last.label === m.words) { last.since = m.since; last.ai = m.ai; }
          else { finishWorking(st, true); st.subs.push({ label: m.words, state: "running", since: m.since, ai: m.ai }); }
          break;
        }
        case "frame": if (!test(m.id)?.hidden) S.frames.set(m.id, { jpeg: m.jpeg, url: m.url }); break;
        case "protection": {
          // Each kind once per page: a later reading of the same box (found blocking once it drew) replaces the first.
          const t = test(m.id); if (!t) break;
          const k = t.protections.findIndex((f) => f.kind === m.finding.kind && f.page === m.finding.page);
          if (k >= 0) t.protections[k] = m.finding; else t.protections.push(m.finding);
          break;
        }
        case "result": {
          const r = m as ResultEventFull;
          const t = test(m.id); if (!t) break;
          t.status = "done"; t.result = r.result; t.ended = Date.now(); unhide(t, "all");
          if (r.video) t.video = r.video; if (r.signInVideo) t.signInVideo = r.signInVideo; if (r.folder) t.folder = r.folder;
          t.steps = r.result.steps.map((x) => {
            const was = t.steps[x.n - 1];
            const acts: Sub[] = x.actions.map((a) => ({ label: a.label, state: a.blocked ? "blocked" : a.error ? "err" : "ok", at: a.at, act: true, ...(a.error ? { error: a.error } : {}) }));
            let subs = acts;
            if (was && was.subs.filter((s) => s.act).length === acts.length) { let k = 0; subs = was.subs.map((s) => (s.act ? acts[k++]! : { ...s, state: s.state === "running" ? "ok" : s.state })); }
            // The card's kind (Act, Assert, Login) is kept: the result's steps don't carry it.
            const st: Step = { n: x.n, title: x.title, intent: x.intent, check: x.check, ...(was?.kind ? { kind: was.kind } : {}), state: x.verdict, at: x.at, ms: x.ms, open: was ? was.open : x.verdict !== "passed" && x.verdict !== "skipped", subs };
            if (x.reason) st.reason = x.reason; if (x.evidence) st.evidence = x.evidence; if (x.weak) st.weak = x.weak; if (x.healed) st.healed = x.healed;
            return st;
          });
          break;
        }
        case "run": { const t = test(m.id); if (t) t.runId = m.summary.id; break; }
        case "couldnt": { const t = test(m.id); if (t) { t.status = "couldnt"; t.why = m.words; t.ended = Date.now(); stopAll(t); } break; }
        case "notrun": { const t = test(m.id); if (STOPPED.test(m.words)) S.stoppedByYou = true; if (t) { t.status = STOPPED.test(m.words) ? "cancelled" : "not_run"; t.why = m.words; t.ended = Date.now(); stopAll(t); } break; }
        case "jobEnd": S.jobEnd = { summary: m.summary, ms: m.ms }; if (S.job) S.job.ended = Date.now(); break;
        default: break;
      }
    }

    // ----- layout -------------------------------------------------------------------------------
    const view = ui.el("div", "rn-live");
    const left = ui.el("aside", "rn-left");
    const jobs = ui.el("div", "rn-jobs");
    const head = ui.el("div", "rn-lhead");
    const scroll = ui.el("div", "rn-scroll");
    const steps = ui.el("ol", "rn-steps"); steps.setAttribute("aria-label", "Steps");
    const card = ui.el("div");
    scroll.append(head, steps, card);
    const bar = ui.el("div", "rn-bar");
    const barWords = ui.el("span", "w"); barWords.setAttribute("aria-live", "off");
    const stopB = ui.el("button", "rn-btn"); stopB.type = "button";
    stopB.append(ui.el("span", "rn-sq"), document.createTextNode("Stop test"));
    const newB = ui.el("a", "rn-btn", "New test"); newB.href = router.href("/p/" + pid + "/tests/new");
    bar.append(ui.icon("flask"), barWords, stopB, newB);
    left.append(jobs, scroll, bar);
    const right = ui.el("section", "rn-right");
    const win = ui.el("div", "rn-window");
    const chrome = ui.el("div", "rn-chrome");
    const dots = ui.el("span", "rn-dots"); dots.append(ui.el("i"), ui.el("i"), ui.el("i"));
    const addr = ui.el("span", "rn-addr"); const addrWords = ui.el("span");
    addr.append(ui.icon("lock"), addrWords);
    chrome.append(dots, addr);
    const screen = ui.el("div", "rn-screen");
    const img = ui.el("img"); img.alt = "The browser, live"; img.hidden = true;
    const video = ui.el("video"); video.controls = true; video.playsInline = true; video.preload = "auto"; video.hidden = true;
    const wait = ui.el("div", "rn-wait"); wait.setAttribute("role", "status");
    screen.append(img, video, wait);
    // E9: a portrait screen (a run at a phone's width) gets the phone frame.
    const phoneFrame = (w: number, h: number) => { if (w && h) win.classList.toggle("rn-phone", h > w); };
    img.addEventListener("load", () => phoneFrame(img.naturalWidth, img.naturalHeight));
    video.addEventListener("loadedmetadata", () => phoneFrame(video.videoWidth, video.videoHeight));
    // What the video leaves out (the sign-in, a typed stored value), said under it.
    const vnote = ui.el("p", "rn-vnote"); vnote.hidden = true;
    // The sign-in's own video, when the test signed in just before it began.
    const svid = ui.el("a", "rn-vnote", "Watch the sign-in (its boxes show dots)"); svid.target = "_blank"; svid.rel = "noopener"; svid.hidden = true;
    win.append(chrome, screen, vnote, svid);
    right.append(win);
    view.append(left, right);
    const empty = ui.el("div", "rn-empty");
    empty.append(ui.el("p", null, "Nothing is running."));
    const emptyA = ui.el("a", "rn-btn primary", "New test"); emptyA.href = router.href("/p/" + pid + "/tests/new");
    empty.append(emptyA);
    const lw = ui.el("div", "rn-lw");
    lw.append(view, empty);
    root.append(lw);

    stopB.addEventListener("click", async () => {
      S.stopping = true; stopB.disabled = true; paintBar();
      const r = await api.call("POST /api/stop", {});
      if (!r.ok) { S.stopping = false; S.error = r.error; paint(); }
    });

    // ----- painting -----------------------------------------------------------------------------
    const took = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
    const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
    const STAT: Record<string, [string, string]> = { passed: ["okc", "rn-ok"], failed: ["badc", "rn-bad"], blocked: ["mehc", "rn-meh"], not_sure: ["mehc", "rn-meh"], skipped: ["offc", "rn-off"], pending: ["offc", "rn-off"], stopped: ["offc", "rn-off"] };
    const statIcon = (state: string) => {
      if (state === "running") return ui.el("span", "rn-spin rn-stat");
      const [n, c] = STAT[state] ?? ["offc", "rn-off"];
      return ui.icon(n, "rn-stat " + c);
    };
    const subIcon = (s: Sub) => {
      const l = s.label;
      return ui.icon(s.state === "blocked" ? "stop" : s.heal ? "heal" : /^Capturing/.test(l) ? "search" : /^Asking the AI/.test(l) ? "sparkle" : /^Checking/.test(l) ? "eye" : /^Clicking/.test(l) ? "pointer" : /^(Securely|Filling|Typing|Pressing|Choosing|Selecting)/.test(l) ? "type" : /^Scrolling/.test(l) ? "arrows" : /^Going to/.test(l) ? "globe" : /^Waiting/.test(l) ? "clock" : "wand");
    };
    const goto = (at: number, tiny: boolean) => {
      const b = ui.el("button", "rn-goto"); b.type = "button"; b.title = "Go to " + ui.clock(at) + " in the video";
      b.append(ui.icon("play"), document.createTextNode((tiny ? "" : "Go to ") + ui.clock(at)));
      b.addEventListener("click", (e) => { e.stopPropagation(); try { video.currentTime = at; void video.play().catch(() => {}); } catch { /* not loaded yet */ } });
      return b;
    };
    const thinking = (s: Sub) => {
      const p = ui.el("span", "rn-pill" + (s.ai ? " think" : ""));
      p.dataset.since = String(s.since ?? Date.now());
      p.dataset.ai = s.ai ? "1" : "";
      p.append(ui.el("span", "rn-spin"), ui.el("span", "t", tickWords(s.since ?? Date.now(), Boolean(s.ai))));
      return p;
    };
    function tickWords(since: number, ai: boolean) {
      const n = Math.max(0, Math.floor((Date.now() - since) / 1000));
      return ai ? "Thinking… " + n + " s" : n >= 2 ? "Running " + n + " s" : "Running";
    }

    function paint() {
      const t = test(S.sel);
      const any = S.order.length > 0;
      view.hidden = !any; empty.hidden = any;
      if (!any) return;
      // Several tests: a list, each with its pill; the picked one shows side by side.
      jobs.hidden = S.order.length < 2;
      jobs.replaceChildren();
      if (S.order.length > 1) S.order.forEach((id, i) => {
        const x = test(id)!; const b = ui.el("button"); b.type = "button";
        b.setAttribute("aria-current", String(id === S.sel));
        b.append(ui.el("span", "rn-n", String(i + 1)), pillOf(x), ui.el("span", "g", x.goal));
        b.title = x.goal;
        b.addEventListener("click", () => { S.sel = id; S.follow = x.status === "running"; paint(); });
        jobs.append(b);
      });
      head.replaceChildren();
      if (t) {
        head.append(ui.el("b", null, t.goal));
        const meta = ui.el("div", "rn-meta");
        meta.append(ui.el("span", null, host(t.url)));
        if (t.replay) meta.append(ui.el("span", "rn-tag", "replayed from the saved test"));
        if (S.job?.explore) meta.append(ui.el("span", "rn-tag", "exploring"));
        if (t.session) { const c = ui.el("span", "rn-tag", t.session); c.dataset.role = "session"; meta.append(c); }
        head.append(meta);
      }
      const keep = scroll.scrollTop;
      steps.replaceChildren();
      const done = Boolean(t && t.status === "done");
      const hasVideo = Boolean(done && t?.video);
      if (t && !t.steps.length) {
        const li = ui.el("li", "rn-step running"); const row = ui.el("div", "rn-srow");
        const words = t.status === "running" ? (t.phase || "Getting ready") + "…" : t.why || "Waiting its turn";
        row.append(t.status === "running" || t.status === "queued" ? ui.el("span", "rn-spin rn-stat") : ui.icon("mehc", "rn-stat rn-meh"), ui.el("span", "rn-st", words));
        if (t.status === "running" && /^Planning/i.test(t.phase)) row.append(thinking({ label: t.phase, state: "running", since: t.phaseSince, ai: true }));
        li.append(row); steps.append(li);
      }
      if (t) for (const st of t.steps) {
        const li = ui.el("li", "rn-step " + st.state + (st.open ? " open" : ""));
        li.dataset.n = String(st.n);
        const row = ui.el("button", "rn-srow"); row.type = "button"; row.setAttribute("aria-expanded", String(st.open));
        const kind = kindOf(st);
        const tag = ui.el("span", "rn-tag " + kind); tag.append(ui.icon(kind === "assert" ? "eye" : kind === "login" ? "lock" : "wand"), document.createTextNode(kind === "assert" ? "Assert" : kind === "login" ? "Login" : "Act"));
        row.append(ui.el("span", "rn-n", String(st.n)), ui.el("span", "rn-st", st.title), tag);
        if (hasVideo && st.state !== "skipped" && st.at !== undefined) row.append(goto(st.at, false));
        row.append(statIcon(st.state));
        row.addEventListener("click", () => { st.open = !st.open; paint(); });
        li.append(row);
        if (st.open) {
          const subs = ui.el("ol", "rn-subs");
          for (const s of st.subs) {
            const sl = ui.el("li", "rn-sub " + s.state);
            if (s.at !== undefined) sl.dataset.at = String(s.at);
            sl.append(subIcon(s), ui.el("span", "l", s.label));
            if (s.state === "running") sl.append(thinking(s));
            else {
              if (hasVideo && s.at !== undefined) sl.append(goto(s.at, true));
              sl.append(s.state === "stopped" ? ui.el("span", "rn-pill", "Stopped") : statIcon(s.state === "ok" ? "passed" : s.state === "err" ? "failed" : "blocked"));
            }
            subs.append(sl);
            if (s.error) { const w = ui.el("li", "rn-sub"); w.append(ui.el("span", "why", "didn't work: " + s.error)); subs.append(w); }
          }
          if (!st.subs.length && st.state === "running") { const sl = ui.el("li", "rn-sub running"); sl.append(ui.icon("wand"), ui.el("span", "l", "Starting the step"), thinking({ label: "", state: "running", since: Date.now() })); subs.append(sl); }
          if (!st.subs.length && st.state !== "running") subs.append(ui.el("li", "rn-sub", st.state === "skipped" ? "Not run: switched off, or the test ended first." : "Nothing was done in this step."));
          li.append(subs);
          if (st.reason && st.state !== "passed") li.append(ui.el("p", "rn-reason" + (st.state === "failed" ? "" : " warn"), st.reason));
          if (st.evidence) li.append(ui.el("p", "rn-reason", "Expected " + st.evidence.expected + "; found " + st.evidence.found));
          if (st.weak && st.state === "passed") li.append(ui.el("p", "rn-reason note", "Note: " + st.weak + "."));
          if (st.healed) li.append(ui.el("p", "rn-reason note", "Healed: " + st.healed.from.join(" → ") + " no longer worked; now " + (st.healed.to.join(" → ") || "nothing more") + "."));
        }
        steps.append(li);
      }
      scroll.scrollTop = keep;
      if (t && t.status === "running" && S.follow) steps.querySelector(".rn-step.running")?.scrollIntoView({ block: "nearest" });

      // The card under the steps: protection met, and how it ended. A run never waits for a person (A1).
      card.replaceChildren();
      if (S.error) { const c = ui.el("div", "rn-card2"); c.setAttribute("role", "alert"); c.append(ui.el("p", "rn-reason", S.error)); card.append(c); }
      // Only a run from before A1 could have had a person pass a check mid-run.
      const byPerson = Boolean(t?.result?.handovers?.some((x) => x.outcome === "resumed"));
      if (t) for (const f of t.protections) {
        const c = ui.el("div", "rn-card2 rn-protect"); const h = ui.el("div", "h");
        const passed = f.blocking && !f.testMode && byPerson;
        h.append(ui.icon("warn", "rn-meh"), ui.el("b", null, f.name + " on " + f.host), ui.pill(f.testMode || passed ? "pass" : "blocked"));
        c.append(h, ui.el("p", "rn-said", f.testMode ? "Test mode is on: the run can go on." : passed ? "You passed it by hand, and the run went on. The tester never solves or gets around a check." : f.blocking ? "It stands in the way. The tester never solves or gets around a check." : "Seen on the page; not in the way yet."));
        if (f.owned && f.setup && !f.testMode) c.append(ui.el("p", "rn-reason note", "On your own site, turn on its test mode: " + f.setup));
        card.append(c);
      }
      if (t && (done || t.status === "cancelled" || t.status === "couldnt" || t.status === "not_run")) {
        const c = ui.el("div", "rn-card2"); const h = ui.el("div", "h");
        const r = t.result;
        h.append(pillOf(t), ui.el("b", null, r ? (r.verdict === "pass" ? passWords(r) : summaryOf(r)) : t.status === "cancelled" ? "Cancelled" : t.status === "couldnt" ? "Couldn't run" : "Not run"));
        if (r) h.append(ui.el("span", "rn-tag", took(r.ms)));
        c.append(h);
        if (!r && t.why) c.append(ui.el("p", "rn-said", t.status === "cancelled" ? "You stopped it. A stopped run is cancelled, not failed." : t.why));
        if (r?.botWall) c.append(ui.el("p", "rn-reason warn", "The site checks for bots (" + r.botWall + ") and didn't let the test browser in. The tester never gets past a bot check."));
        const links = ui.el("div", "h");
        if (t.runId) { const a = ui.el("a", "rn-btn primary", "See full result"); a.href = router.href("/p/" + pid + "/runs/" + t.runId); links.append(a); }
        if (t.folder) { const f = ui.el("span", "rn-meta"); f.append(ui.el("span", null, "Run folder: "), ui.el("code", null, t.folder)); links.append(f); }
        if (links.childNodes.length) c.append(links);
        card.append(c);
      }
      paintBar();
      paintScreen(t);
    }
    /** A pass in words, counting only the steps that ran: a switched-off step is said, never counted as passed. */
    function passWords(r: TestResult) {
      const ran = r.steps.filter((x) => x.verdict !== "skipped").length;
      const off = r.steps.length - ran;
      return (off ? ran + " step" + (ran === 1 ? "" : "s") + " passed, " + off + " skipped" : "All " + ran + " step" + (ran === 1 ? "" : "s") + " passed");
    }
    function summaryOf(r: TestResult) {
      const first = r.steps.find((s) => s.verdict !== "passed");
      return first ? "Step " + first.n + ", " + first.title + ": " + (first.reason || first.verdict) : r.stopped || r.verdict;
    }
    function pillOf(t: Test) {
      if (t.status === "done" && t.result) return ui.pill(t.result.verdict);
      if (t.status === "running") { const p = ui.el("span", "rn-pill"); p.append(ui.el("span", "rn-spin"), document.createTextNode("Running")); return p; }
      if (t.status === "queued") return ui.pill("queued");
      if (t.status === "cancelled") return ui.pill("cancelled");
      return ui.pill("error");
    }
    function paintBar() {
      const t = test(S.sel);
      const running = S.busy === "run";
      stopB.hidden = !running; stopB.disabled = S.stopping;
      newB.hidden = running;
      const n = S.order.length;
      if (running) {
        const began = (n > 1 ? S.job?.began : t?.began) ?? S.job?.began;
        const which = n > 1 ? "Testing " + (S.order.findIndex((id) => test(id)?.status === "running") + 1 || 1) + " of " + n + "… " : "Testing your website… ";
        barWords.textContent = S.stopping ? "Stopping…" : began ? which + took(Date.now() - began) : "Starting…";
      } else if (S.jobEnd && n > 1) barWords.textContent = S.jobEnd.summary + " · " + took(S.jobEnd.ms);
      else if (t?.result) barWords.textContent = "Finished in " + took(t.result.ms);
      else barWords.textContent = t?.status === "cancelled" ? "Cancelled" : "Not running";
    }
    let shownVideo = "";
    function paintScreen(t: Test | undefined) {
      vnote.textContent = t?.status === "done" && t.video ? t.result?.videoNote || "" : t?.signingIn && t.status === "running" ? (t.signingWords || "Signing in…") + " The sign-in page shows here; every box a stored value is typed into shows dots." : "";
      vnote.hidden = !vnote.textContent;
      const sv = t?.status === "done" && t.video ? t.signInVideo || "" : "";
      if (sv) svid.href = sv; else svid.removeAttribute("href");
      svid.hidden = !sv;
      if (t && t.status === "done" && t.video) {
        img.hidden = true; wait.hidden = true; video.hidden = false;
        if (shownVideo !== t.video) { shownVideo = t.video; video.src = t.video; }
        addrWords.textContent = t.result?.endUrl || t.url;
        return;
      }
      if (!video.hidden) { video.pause(); video.hidden = true; }
      paintFrame();
    }
    function waiting(title: string, sub: string, lock: boolean) {
      wait.replaceChildren();
      if (lock) wait.append(ui.icon("lock", "rn-lockbig")); else wait.append(ui.el("span", "rn-orb"));
      wait.append(ui.el("b", null, title), ui.el("span", "rn-meta", sub));
    }
    function paintFrame() {
      const t = test(S.sel);
      if (!t || (t.status === "done" && t.video)) return;
      const f = t.hidden ? undefined : S.frames.get(t.id);
      if (f) {
        const src = "data:image/jpeg;base64," + f.jpeg;
        if (img.getAttribute("src") !== src) img.src = src;
        img.hidden = false; wait.hidden = true;
        addrWords.textContent = (/^https?:/.test(f.url) ? f.url : t.url) || "";
        return;
      }
      img.hidden = true; img.removeAttribute("src"); wait.hidden = false;
      addrWords.textContent = t.url || "";
      if (t.signingIn && !t.hidden) waiting(t.signingWords || "Signing in…", "The sign-in page shows here as it opens; its boxes show dots.", false);
      else if (t.hidden) waiting("Screen hidden", t.hidden + ". It comes back when the step ends.", true);
      else if (t.noScreen) waiting("No live screen", t.noScreen, true);
      else if (t.status === "running") waiting("Getting ready…", (t.phase || "Opening the site") + "…", false);
      else if (t.status === "queued") waiting("Waiting its turn", "It runs after the tests before it.", false);
      else if (t.status === "done") waiting("No video for this run", "The steps and their photos are in the result.", false);
      else waiting(t.status === "cancelled" ? "Cancelled" : "Not run", t.why || "", false);
    }
    /** Every second (and a bit): the tickers and the timer, without building the list again. */
    function tick() {
      for (const p of root.querySelectorAll<HTMLElement>(".rn-pill[data-since]")) {
        const t = p.querySelector(".t");
        if (t) t.textContent = tickWords(Number(p.dataset.since), p.dataset.ai === "1");
      }
      paintBar();
    }

    // ----- events -------------------------------------------------------------------------------
    for (const e of events.history() as readonly RunLiveEvent[]) apply(e);
    // A test the job never reached, or one still running, when the page opened mid-run.
    paint();
    const on = events.on as unknown as (type: string, fn: (e: RunLiveEvent) => void) => () => void;
    const TYPES = ["busy", "error", "job", "test", "noscreen", "screen", "signin", "session", "ev", "working", "frame", "protection", "result", "run", "couldnt", "notrun", "jobEnd"];
    const offs = TYPES.map((type) => on(type, (e) => {
      apply(e);
      if (e.type === "frame") paintFrame(); else paint();
    }));
    const timer = setInterval(tick, 250);
    // Leaving the screen never stops the run: it only stops listening.
    return () => { clearInterval(timer); for (const off of offs) off(); video.pause(); };
  },
};
