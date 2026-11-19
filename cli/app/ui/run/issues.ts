/**
 * S7: the Issues inbox and one issue's page. An issue is something a run measured, deduped across
 * runs: a failed step, a console or page error, a 4xx or 5xx answer, friction, or an accessibility
 * rule. Its severity comes from the data lane's fixed rule table, never from an AI. Each row shows the
 * severity, how often it was seen, when it was last seen and its status.
 *
 * The status buttons (Resolve, False positive, Reopen) are stored by the server. "Go to" opens that
 * run at the occurrence's moment in its video. "Copy prompt to fix" copies the server's prompt as it
 * gives it: leak-checked, with the site's words fenced as untrusted data (C23).
 *
 * Every word from a site is set as text. render is self-contained.
 */
import { scope } from "./css.ts";
import type { Issue, IssueKind, IssueStatus, ScreenCtx, ScreenModule } from "../../contracts.ts";

export const ISSUES_CSS = `
.rn-iss { max-width: 1000px; margin: 0 auto; padding: 24px 16px 64px; }
.rn-iss h1 { font-size: 22px; letter-spacing: -0.01em; margin: 0 0 14px; }
.rn-ibar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.rn-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); flex-wrap: wrap; }
.rn-seg button { border: 0; background: none; padding: 5px 12px; border-radius: 7px; cursor: pointer; color: var(--muted); font-weight: 500; font-size: 13px; }
.rn-seg button[aria-pressed="true"] { background: var(--card); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.rn-seg .c { font-variant-numeric: tabular-nums; margin-left: 4px; color: var(--faint); }
.rn-isel, .rn-isearch { font: inherit; font-size: 13px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
.rn-isearch { flex: 1; min-width: 140px; }
.rn-irows { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); overflow: hidden; }
.rn-irow { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); text-decoration: none; color: var(--fg); }
.rn-irows li:last-child .rn-irow { border-bottom: 0; }
.rn-irow:hover { background: var(--hover); }
.rn-irow:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
.rn-irow .t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-irow .m { color: var(--muted); font-size: 12px; white-space: nowrap; }
.rn-sev { font-size: 11px; font-weight: 700; border-radius: 6px; padding: 1px 7px; flex: none; font-variant-numeric: tabular-nums; background: var(--soft); color: var(--muted); }
.rn-sev.s4, .rn-sev.s5 { background: var(--failbg); color: var(--fail); }
.rn-sev.s3 { background: var(--warnbg); color: var(--warn); }
.rn-kindtag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.rn-stat2 { font-size: 11px; border-radius: 999px; padding: 0 8px; white-space: nowrap; border: 1px solid var(--line); color: var(--muted); }
.rn-stat2.open { color: var(--fg); border-color: color-mix(in srgb, var(--fg) 35%, transparent); }
.rn-stat2.resolved { color: var(--pass); border-color: color-mix(in srgb, var(--pass) 40%, transparent); }
.rn-none { color: var(--muted); padding: 28px 14px; text-align: center; margin: 0; }
.rn-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-weight: 500; white-space: nowrap; color: var(--fg); font-size: 13px; text-decoration: none; }
.rn-btn:hover { background: var(--hover); }
.rn-btn:disabled { opacity: .45; cursor: default; }
.rn-btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-btn .ico { width: 14px; height: 14px; }
.rn-btn:focus-visible, .rn-seg button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.rn-ihead { border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); padding: 14px 16px; display: grid; gap: 10px; }
.rn-ihead .h { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rn-ihead .h b { font-size: 16px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-imeta { color: var(--muted); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
.rn-back { color: var(--muted); font-size: 13px; text-decoration: none; display: inline-block; margin-bottom: 10px; }
.rn-back:hover { color: var(--fg); }
.rn-occ { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 8px; }
.rn-occ li { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 10px 12px; display: grid; gap: 6px; }
.rn-occ .h { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.rn-occ .h .t { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.rn-ev { margin: 0; background: var(--soft); border-radius: 8px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.rn-measured { font-size: 10px; font-weight: 700; letter-spacing: .03em; color: var(--muted); }
details.rn-prompt { margin-top: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
details.rn-prompt summary { cursor: pointer; padding: 8px 12px; font-size: 13px; color: var(--muted); }
details.rn-prompt pre { margin: 0; padding: 10px 12px; border-top: 1px solid var(--line); max-height: 360px; overflow: auto; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.rn-ierr { margin: 12px 0; padding: 9px 12px; border-radius: 8px; background: var(--failbg); color: var(--fail); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .rn-irow { flex-wrap: wrap; }
  .rn-irow .t { flex-basis: calc(100% - 50px); }
  .rn-iss { padding: 16px 12px 48px; }
}
`;

export const issuesScreen: ScreenModule = {
  id: "run.issues",
  routes: ["/p/:pid/issues", "/p/:pid/issues/:iid"],
  css: scope(".rn-iss", ISSUES_CSS),
  render: function renderIssues(root: HTMLElement, ctx: ScreenCtx) {
    const { ui, api, router, events } = ctx;
    const pid = ctx.params.pid ?? "";
    let alive = true;
    const KIND: Record<IssueKind, string> = { failed_step: "Failed step", console_error: "Console error", page_error: "Page error", http_error: "HTTP error", friction: "Friction", a11y: "Accessibility", explore: "Found exploring" };
    const STATUS: Record<IssueStatus, string> = { open: "Open", resolved: "Resolved", false_positive: "False positive" };
    const q = router.current().query;
    const st = {
      status: (["open", "resolved", "false_positive"].includes(q.get("status") ?? "") ? q.get("status") : "open") as IssueStatus,
      kind: "" as "" | IssueKind,
      sev: 1,
      words: "",
      issues: null as Issue[] | null,
      counts: { open: 0, resolved: 0, false_positive: 0 } as Record<IssueStatus, number>,
      issue: null as Issue | null,
      prompt: "",
      error: "",
      busy: false,
    };
    const wrap = ui.el("div", "rn-iss");
    root.append(wrap);
    const iid = () => router.current().params.iid ?? "";

    const sev = (n: number) => { const s = ui.el("span", "rn-sev s" + n, "S" + n); s.title = "Severity " + n + " of 5, from a fixed rule (never an AI)"; return s; };
    const statusTag = (s: IssueStatus) => ui.el("span", "rn-stat2 " + s, STATUS[s]);

    function paintList() {
      wrap.replaceChildren(ui.el("h1", null, "Issues"));
      const bar = ui.el("div", "rn-ibar");
      const seg = ui.el("div", "rn-seg"); seg.setAttribute("aria-label", "Status");
      for (const s of ["open", "resolved", "false_positive"] as IssueStatus[]) {
        const b = ui.el("button", null, STATUS[s]); b.type = "button"; b.setAttribute("aria-pressed", String(st.status === s)); b.dataset.status = s;
        b.append(ui.el("span", "c", String(st.counts[s] ?? 0)));
        b.addEventListener("click", () => { st.status = s; paintList(); });
        seg.append(b);
      }
      const kind = ui.el("select", "rn-isel"); kind.setAttribute("aria-label", "Kind"); kind.dataset.role = "kind";
      const all = ui.el("option", null, "Every kind"); all.value = ""; kind.append(all);
      for (const [k, w] of Object.entries(KIND)) { const o = ui.el("option", null, w); o.value = k; kind.append(o); }
      kind.value = st.kind;
      kind.addEventListener("change", () => { st.kind = kind.value as "" | IssueKind; paintRows(); });
      const sevSel = ui.el("select", "rn-isel"); sevSel.setAttribute("aria-label", "Severity at least"); sevSel.dataset.role = "sev";
      for (const n of [1, 2, 3, 4, 5]) { const o = ui.el("option", null, n === 1 ? "Any severity" : "S" + n + " and up"); o.value = String(n); sevSel.append(o); }
      sevSel.value = String(st.sev);
      sevSel.addEventListener("change", () => { st.sev = Number(sevSel.value); paintRows(); });
      const search = ui.el("input", "rn-isearch"); search.type = "search"; search.placeholder = "Search issues"; search.setAttribute("aria-label", "Search issues"); search.value = st.words;
      search.addEventListener("input", () => { st.words = search.value; paintRows(); });
      bar.append(seg, kind, sevSel, search);
      wrap.append(bar);
      if (st.error) { const e = ui.el("div", "rn-ierr", st.error); e.setAttribute("role", "alert"); wrap.append(e); }
      const list = ui.el("ul", "rn-irows"); list.dataset.role = "rows";
      wrap.append(list);
      paintRows();
    }
    function paintRows() {
      const list = wrap.querySelector<HTMLElement>('[data-role="rows"]');
      if (!list) return;
      list.replaceChildren();
      if (!st.issues) { list.append(ui.el("li", "rn-none", "Loading issues…")); return; }
      const words = st.words.trim().toLowerCase();
      const shown = st.issues.filter((i) => i.status === st.status && (!st.kind || i.kind === st.kind) && i.severity >= st.sev && (!words || (i.title + " " + i.key).toLowerCase().includes(words)))
        .sort((a, b) => b.severity - a.severity || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      if (!shown.length) {
        list.append(ui.el("li", "rn-none", st.issues.length ? "No " + STATUS[st.status].toLowerCase() + " issues match." : "No issues yet. They come from what runs measure: failed steps, errors, slow or confusing spots and accessibility."));
        return;
      }
      for (const i of shown) {
        const li = ui.el("li");
        const a = ui.el("a", "rn-irow"); a.href = router.href("/p/" + pid + "/issues/" + i.id); a.dataset.id = i.id;
        a.append(sev(i.severity), ui.el("span", "t", i.title), ui.el("span", "rn-kindtag", KIND[i.kind] ?? i.kind), ui.el("span", "m", "seen " + i.count + "×"), ui.el("span", "m", "last " + ui.ago(i.lastSeen)), statusTag(i.status));
        li.append(a);
        list.append(li);
      }
    }

    function paintOne() {
      wrap.replaceChildren();
      const back = ui.el("a", "rn-back", "← All issues"); back.href = router.href("/p/" + pid + "/issues");
      wrap.append(back);
      const i = st.issue;
      if (st.error) { const e = ui.el("div", "rn-ierr", st.error); e.setAttribute("role", "alert"); wrap.append(e); }
      if (!i) { if (!st.error) wrap.append(ui.el("p", "rn-none", "Loading the issue…")); return; }
      const head = ui.el("section", "rn-ihead");
      const h = ui.el("div", "h");
      const t = ui.el("b", null, i.title); t.dataset.role = "title";
      const stTag = statusTag(i.status); stTag.dataset.role = "status";
      h.append(sev(i.severity), t, ui.el("span", "rn-kindtag", KIND[i.kind] ?? i.kind), stTag);
      head.append(h);
      const meta = ui.el("div", "rn-imeta");
      meta.append(ui.el("span", null, "Seen " + i.count + " time" + (i.count === 1 ? "" : "s")), ui.el("span", null, "First " + ui.ago(i.firstSeen)), ui.el("span", null, "Last " + ui.ago(i.lastSeen)));
      if (i.reopenedAt) meta.append(ui.el("span", null, "Came back " + ui.ago(i.reopenedAt)));
      head.append(meta);
      const acts = ui.el("div", "rn-ibar");
      const set = (to: IssueStatus, words: string, primary: boolean) => {
        const b = ui.el("button", "rn-btn" + (primary ? " primary" : ""), words); b.type = "button"; b.disabled = st.busy; b.dataset.set = to;
        b.addEventListener("click", async () => {
          st.busy = true; st.error = ""; paintOne();
          const r = await api.call("POST /api/issues/:id/status", { id: i.id }, { status: to });
          st.busy = false;
          if (!alive) return;
          if (r.ok) { st.issue = r.issue; ui.toast(to === "open" ? "Reopened" : "Marked " + STATUS[to].toLowerCase()); }
          else st.error = r.error;
          paintOne();
        });
        return b;
      };
      if (i.status === "open") acts.append(set("resolved", "Resolve", false), set("false_positive", "False positive", false));
      else acts.append(set("open", "Reopen", false));
      const copyB = ui.el("button", "rn-btn primary"); copyB.type = "button"; copyB.dataset.role = "copy";
      copyB.append(ui.icon("wand"), document.createTextNode("Copy prompt to fix"));
      copyB.addEventListener("click", async () => {
        const r = await api.call("GET /api/issues/:id/prompt", { id: i.id });
        if (!alive) return;
        if (!r.ok) { st.error = r.error; paintOne(); return; }
        st.prompt = r.prompt;
        // The prompt is the server's, as given: leak-checked, with the site's words fenced as data.
        let done = false;
        try { await navigator.clipboard.writeText(r.prompt); done = true; } catch { /* no clipboard: shown below to copy by hand */ }
        ui.toast(done ? "Prompt copied: paste it into your coding agent" : "Couldn't copy: the prompt is shown below");
        paintOne();
      });
      acts.append(ui.el("span", null), copyB);
      head.append(acts);
      wrap.append(head);
      if (st.prompt) {
        const d = ui.el("details", "rn-prompt"); d.open = true;
        d.append(ui.el("summary", null, "The prompt (the site's words are inside a fence marked as data, not instructions)"), ui.el("pre", null, st.prompt));
        d.dataset.role = "prompt";
        wrap.append(d);
      }
      const ol = ui.el("ol", "rn-occ");
      for (const o of i.occurrences) {
        const li = ui.el("li");
        const hh = ui.el("div", "h");
        const go = ui.el("a", "rn-btn"); go.href = router.href("/p/" + pid + "/runs/" + o.runId + "?t=" + Math.max(0, Math.floor(o.videoAt))); go.dataset.role = "goto";
        go.append(ui.icon("play"), document.createTextNode("Go to " + ui.clock(o.videoAt)));
        hh.append(ui.el("span", "t", o.testName + " · step " + o.step + " · " + ui.ago(o.at)), go);
        li.append(hh);
        const ev = o.evidence;
        const lines = [ev.text];
        if (ev.method || ev.status || ev.url) lines.push([ev.method, ev.status, ev.url].filter((x) => x !== undefined && x !== "").join(" "));
        if (ev.expected) lines.push("Expected " + ev.expected.expected + "; found " + ev.expected.found);
        if (ev.a11y) lines.push(ev.a11y.what + " · " + ev.a11y.wcag + " · " + ev.a11y.page);
        li.append(ui.el("span", "rn-measured", "MEASURED"), ui.el("pre", "rn-ev", lines.join("\n")));
        ol.append(li);
      }
      if (i.count > i.occurrences.length) ol.append(ui.el("li", "rn-imeta", "And " + (i.count - i.occurrences.length) + " older."));
      wrap.append(ol);
    }

    async function loadList() {
      const r = await api.call("GET /api/projects/:id/issues", { id: pid });
      if (!alive) return;
      if (r.ok) { st.issues = r.issues; st.counts = r.counts; st.error = ""; } else { st.issues = []; st.error = r.error; }
      if (!iid()) paintList();
    }
    async function loadOne() {
      const id = iid();
      st.issue = null; st.prompt = ""; st.error = "";
      paintOne();
      const r = await api.call("GET /api/issues/:id", { id });
      if (!alive || iid() !== id) return;
      if (r.ok) st.issue = r.issue; else st.error = r.error;
      paintOne();
    }
    /** Only this screen's own routes: a change to another screen (before the shell cleans up) loads nothing. */
    const here = () => /^\/p\/:pid\/issues(\/:iid)?$/.test(router.current().route);
    const show = () => { if (!alive || !here()) return; if (iid()) void loadOne(); else { paintList(); void loadList(); } };
    show();
    const offRoute = router.onChange(show);
    const offIssues = events.on("issues", (e) => { if (e.projectId !== pid) return; if (iid()) { if (e.changed.includes(iid())) void loadOne(); } else void loadList(); });
    return () => { alive = false; offRoute(); offIssues(); };
  },
};
