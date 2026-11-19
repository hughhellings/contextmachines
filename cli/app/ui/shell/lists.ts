/**
 * The shell's list screens:
 * - S2's Tests list (#/p/:pid/tests): every test with its last verdict, pass rate and Run.
 * - S6 Runs (#/p/:pid/runs): every run, verdict kept apart from status (C12), filter by verdict and test.
 * - A plain run page (#/p/:pid/runs/:rid) with the video and "Go to" per step. It is a fallback: the
 *   ui-run lane's S5 screen wins for that route when it is mounted.
 * - A plain Issues list (#/p/:pid/issues), also a fallback for S7.
 *
 * Each render() is inlined into the page by its source, so each is self-contained.
 */
import type { AppVerdict, Issue, RunRecord, RunSummary, ScreenCtx, ScreenModule, TestDef } from "../../contracts.ts";

export const testsScreen: ScreenModule = {
  id: "shell-tests",
  routes: ["/p/:pid/tests"],
  css: `
.tl .rate { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl .acts { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 560px) { .tl .rate, .tl .meta { display: none; } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon, pill, ago, toast } = ctx.ui;
    const pid = ctx.params.pid || "";
    let alive = true;
    const base = "/p/" + encodeURIComponent(pid);

    const head = el("div", "pagehead");
    const h = el("div", "grow");
    h.append(el("h1", null, "Tests"), el("p", null, "Each test runs in a real browser you can watch. A test that passes is saved, and replays at $0."));
    const add = el("a", "btn primary");
    add.href = ctx.router.href(base + "/tests/new");
    add.append(icon("plus"), el("span", null, "New test"));
    head.append(h, add);

    const card = el("section", "card tl");
    const list = el("ul", "list");
    const loading = el("div", "loading");
    loading.append(el("span", "spin"), el("span", null, "Loading tests…"));
    card.append(loading);
    const foot = el("div", "cardfoot");
    const runAll = el("button", "btn");
    runAll.type = "button";
    runAll.append(icon("play"), el("span", null, "Run all"));
    const explore = el("button", "btn");
    explore.type = "button";
    explore.append(icon("globe"), el("span", null, "Explore and find bugs"));
    foot.append(runAll, explore);
    root.append(head, card);

    async function start(body: { testId?: string }) {
      const r = await ctx.api.call("POST /api/runs", {}, { projectId: pid, source: "manual", ...body });
      if (!r.ok) return toast(r.busy ? "A test is running. Wait for it or stop it first." : r.error);
      ctx.router.go(base + "/live");
    }
    runAll.addEventListener("click", async () => {
      const r = await ctx.api.call("POST /api/runs", {}, { projectId: pid, source: "manual", all: true });
      if (!r.ok) return toast(r.busy ? "A test is running. Wait for it or stop it first." : r.error);
      ctx.router.go(base + "/live");
    });
    explore.addEventListener("click", async () => {
      const env = ctx.project && ((ctx.project.envs || []).find((e) => e.default) || (ctx.project.envs || [])[0]);
      if (env && env.kind === "production") {
        const s = await ctx.api.call("GET /api/settings", {});
        const ask = !(s.ok && s.settings.confirmProduction === false);
        if (ask && !confirm("Explore the live site? It stays on this site, and never buys, posts, sends or deletes.")) return;
        const r = await ctx.api.call("POST /api/explore", {}, { projectId: pid, confirmedProduction: true });
        if (!r.ok) return toast(r.busy ? "A test is running. Wait for it or stop it first." : r.error);
        return ctx.router.go(base + "/live");
      }
      const r = await ctx.api.call("POST /api/explore", {}, { projectId: pid });
      if (!r.ok) return toast(r.busy ? "A test is running. Wait for it or stop it first." : r.error);
      ctx.router.go(base + "/live");
    });

    function paint(tests: TestDef[]) {
      card.replaceChildren();
      if (!tests.length) {
        const e = el("div", "empty");
        e.append(el("b", null, "No tests yet"), el("span", null, "Describe what should work, or let it suggest tests from a look at the site."));
        const row = el("div", "row");
        row.style.justifyContent = "center";
        row.style.marginTop = "14px";
        const n = el("a", "btn primary");
        n.href = ctx.router.href(base + "/tests/new");
        n.append(icon("plus"), el("span", null, "New test"));
        const s = el("a", "btn");
        s.href = ctx.router.href(base + "/tests/new?mode=suggest");
        s.append(icon("sparkle"), el("span", null, "Suggest tests"));
        row.append(n, s);
        e.append(row);
        card.append(e, foot);
        runAll.disabled = true;
        return;
      }
      runAll.disabled = false;
      list.replaceChildren();
      for (const t of tests) {
        const li = el("li", "click");
        li.dataset.test = t.id;
        const name = el("a", "stack");
        name.style.textDecoration = "none";
        name.href = ctx.router.href(base + "/tests/" + encodeURIComponent(t.id));
        name.append(el("span", "name", t.name), el("span", "sub", t.steps.length + (t.steps.length === 1 ? " step" : " steps") + (t.origin === "discovery" ? " · from Discovery" : "")));
        li.append(name);
        if (t.last) {
          li.append(t.last.status === "completed" && t.last.verdict ? pill(t.last.verdict, { judged: t.last.judged }) : pill(t.last.status));
          li.append(el("span", "meta", ago(t.last.startedAt)));
        } else li.append(el("span", "meta", "Not run yet"));
        if (typeof t.passRate === "number") li.append(el("span", "rate", Math.round(t.passRate * 100) + "% pass"));
        const run = el("button", "btn small");
        run.type = "button";
        run.append(icon("play"), el("span", null, "Run"));
        run.setAttribute("aria-label", "Run " + t.name);
        run.addEventListener("click", (e) => { e.stopPropagation(); void start({ testId: t.id }); });
        li.append(run);
        li.addEventListener("click", (e) => { if (e.target === li) name.click(); });
        list.append(li);
      }
      card.append(list, foot);
    }

    async function load() {
      const r = await ctx.api.call("GET /api/projects/:id/tests", { id: pid });
      if (!alive) return;
      if (!r.ok) { card.replaceChildren(el("div", "error", r.error)); return; }
      paint(r.tests || []);
    }
    void load();
    const off = ctx.events.on("run", () => { void load(); });
    return () => { alive = false; off(); };
  },
};

export const runsScreen: ScreenModule = {
  id: "shell-runs",
  routes: ["/p/:pid/runs"],
  css: `
.rl .filters { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.rl .filters select { width: auto; padding: 6px 8px; font-size: 13px; }
.rl .when { min-width: 92px; }
.rl .how { font-size: 12px; color: var(--muted); white-space: nowrap; }
.rl .pillcell { width: 92px; flex: none; display: flex; }
@media (max-width: 640px) { .rl .when { display: none; } .rl .pillcell { width: auto; } .rl .filters { margin-left: 0; width: 100%; } .rl .filters select { flex: 1; } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon, pill, ago } = ctx.ui;
    const pid = ctx.params.pid || "";
    const base = "/p/" + encodeURIComponent(pid);
    let alive = true;
    let runs: RunSummary[] = [];
    let skipped: { path: string; why: string }[] = [];

    const head = el("div", "pagehead");
    const h = el("div", "grow");
    h.append(el("h1", null, "Runs"), el("p", null, "Every run of this project, newest first."));
    head.append(h);
    const card = el("section", "card rl");
    const ch = el("div", "cardhead");
    const count = el("span", "muted small");
    const filters = el("div", "filters");
    const vSel = el("select", "input");
    vSel.setAttribute("aria-label", "Verdict");
    for (const [v, w] of [["", "All verdicts"], ["pass", "Pass"], ["fail", "Fail"], ["blocked", "Blocked"], ["not_sure", "Not sure"], ["flaky", "Flaky"], ["other", "Cancelled or error"]]) {
      const o = el("option", null, w);
      o.value = v as string;
      vSel.append(o);
    }
    const tSel = el("select", "input");
    tSel.setAttribute("aria-label", "Test");
    filters.append(vSel, tSel);
    ch.append(el("h2", null, "History"), count, filters);
    const list = el("ul", "list");
    const note = el("div", "cardbody");
    note.hidden = true;
    const loading = el("div", "loading");
    loading.style.padding = "16px";
    loading.append(el("span", "spin"), el("span", null, "Loading runs…"));
    card.append(ch, loading);
    root.append(head, card);

    const q = ctx.router.current().query;
    function when(iso: string): string {
      const d = new Date(iso);
      if (!isFinite(d.getTime())) return "";
      const now = new Date();
      const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (d.toDateString() === now.toDateString()) return "today " + hm;
      const y = new Date(now.getTime() - 86400000);
      if (d.toDateString() === y.toDateString()) return "yesterday " + hm;
      return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
    }
    function dur(ms?: number): string {
      if (typeof ms !== "number") return "";
      const s = Math.round(ms / 1000);
      return s < 60 ? s + " s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
    }
    function matches(r: RunSummary): boolean {
      const v = vSel.value;
      if (v === "other") { if (r.status === "completed") return false; }
      else if (v) { if (r.status !== "completed" || r.verdict !== (v as AppVerdict)) return false; }
      if (tSel.value && (r.testId || "goal:" + r.name) !== tSel.value) return false;
      return true;
    }
    function paintTests() {
      const keep = tSel.value || q.get("test") || "";
      tSel.replaceChildren();
      const all = el("option", null, "All tests");
      all.value = "";
      tSel.append(all);
      const seen = new Map<string, string>();
      for (const r of runs) { const k = r.testId || "goal:" + r.name; if (!seen.has(k)) seen.set(k, r.name); }
      for (const [k, n] of seen) { const o = el("option", null, n); o.value = k; tSel.append(o); }
      tSel.value = seen.has(keep) ? keep : "";
    }
    function paint() {
      card.replaceChildren(ch);
      const shown = runs.filter(matches);
      count.textContent = shown.length === runs.length ? String(runs.length) : shown.length + " of " + runs.length;
      if (!runs.length) {
        const e = el("div", "empty");
        e.append(el("b", null, "No runs yet"), el("span", null, "Run a test and it shows up here, with its video."));
        card.append(e);
      } else if (!shown.length) {
        card.append(el("div", "empty", "No runs match these filters."));
      } else {
        list.replaceChildren();
        for (const r of shown) {
          const li = el("li", "click");
          li.dataset.run = r.id;
          const pc = el("span", "pillcell");
          pc.append(r.status === "completed" && r.verdict ? pill(r.verdict, { judged: r.judged }) : pill(r.status));
          const a = el("a", "stack");
          a.style.textDecoration = "none";
          a.href = ctx.router.href(base + "/runs/" + encodeURIComponent(r.id));
          const sub = r.reason || (r.status === "completed" ? r.passed + " of " + r.steps + " steps passed" : "");
          a.append(el("span", "name", r.name), el("span", "sub", sub));
          const how = el("span", "how", r.replay ? "replay" : typeof r.aiAsks === "number" ? "AI · " + r.aiAsks + (r.aiAsks === 1 ? " ask" : " asks") : "AI");
          li.append(pc, a);
          if (r.source === "scheduled") li.append(el("span", "tag", "scheduled"));
          li.append(el("span", "meta when", when(r.startedAt)), el("span", "meta", dur(r.ms)), how);
          li.title = ago(r.startedAt);
          li.addEventListener("click", (e) => { if (e.target !== a) a.click(); });
          list.append(li);
        }
        card.append(list);
      }
      if (skipped.length) {
        note.hidden = false;
        note.replaceChildren(el("div", "note warn", skipped.length + (skipped.length === 1 ? " run file couldn't be read and was left out: " : " run files couldn't be read and were left out: ") + skipped.map((s) => s.path + " (" + s.why + ")").slice(0, 3).join("; ")));
        card.append(note);
      }
    }
    async function load() {
      const r = await ctx.api.call("GET /api/projects/:id/runs", { id: pid });
      if (!alive) return;
      if (!r.ok) { card.replaceChildren(ch, el("div", "cardbody", r.error)); return; }
      runs = (r.runs || []).slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      skipped = r.skipped || [];
      paintTests();
      paint();
    }
    if (q.get("verdict")) vSel.value = q.get("verdict") || "";
    vSel.addEventListener("change", paint);
    tSel.addEventListener("change", paint);
    void load();
    const off = ctx.events.on("run", () => { void load(); });
    void icon;
    return () => { alive = false; off(); };
  },
};

export const runScreen: ScreenModule = {
  id: "shell-run",
  routes: ["/p/:pid/runs/:rid"],
  css: `
.rd { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 16px; align-items: start; }
.rd video { width: 100%; display: block; background: var(--stage); border-radius: 8px; aspect-ratio: 16 / 10; }
.rd .steps li { align-items: flex-start; }
.rd .steps li.playing { background: var(--sel); }
.rd .n { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex: none; color: var(--muted); }
.rd .ok { color: var(--pass); } .rd .bad { color: var(--fail); } .rd .meh { color: var(--warn); }
@media (max-width: 860px) { .rd { grid-template-columns: minmax(0, 1fr); } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon, pill, clock } = ctx.ui;
    const pid = ctx.params.pid || "";
    const rid = ctx.params.rid || "";
    let alive = true;
    const back = el("a", "link", "← All runs");
    back.href = ctx.router.href("/p/" + encodeURIComponent(pid) + "/runs");
    const head = el("div", "pagehead");
    const loading = el("div", "loading");
    loading.append(el("span", "spin"), el("span", null, "Loading the run…"));
    root.append(back, head, loading);

    function paint(run: RunRecord) {
      loading.remove();
      const s = run.summary;
      const h = el("div", "grow");
      const t = el("div", "row");
      t.append(el("h1", null, s.name), s.status === "completed" && s.verdict ? pill(s.verdict, { judged: s.judged }) : pill(s.status));
      const sub = s.reason || (s.passed === s.steps ? "All " + s.steps + " steps passed" : s.passed + " of " + s.steps + " steps passed");
      h.append(t, el("p", null, sub + (typeof s.ms === "number" ? " · " + Math.round(s.ms / 1000) + " s" : "") + (s.replay ? " · replay, 0 AI asks" : typeof s.aiAsks === "number" ? " · " + s.aiAsks + " AI asks" : "")));
      head.append(h);
      const grid = el("div", "rd");
      const stepsCard = el("section", "card");
      const sh = el("div", "cardhead");
      sh.append(el("h2", null, "Steps"));
      const list = el("ul", "list steps");
      const video = el("video");
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("playsinline", "");
      const items: { li: HTMLElement; at: number }[] = [];
      run.result.steps.forEach((st, i) => {
        const li = el("li");
        const ok = st.verdict === "passed";
        const bad = st.verdict === "failed";
        li.append(el("span", "n", String(i + 1)));
        const txt = el("div", "stack");
        txt.append(el("span", "name", st.title), el("span", "sub", st.reason || ""));
        li.append(txt, icon(ok ? "okc" : bad ? "badc" : "mehc", ok ? "ok" : bad ? "bad" : "meh"));
        if (typeof st.at === "number" && s.video) {
          const go = el("button", "btn small", "Go to " + clock(st.at));
          go.type = "button";
          go.addEventListener("click", () => { video.currentTime = st.at || 0; void video.play().catch(() => undefined); });
          li.append(go);
          items.push({ li, at: st.at });
        }
        list.append(li);
      });
      stepsCard.append(sh, list);
      const vidCard = el("section", "card");
      const vb = el("div", "cardbody");
      if (s.video) { video.src = ctx.api.fileUrl(s.id, s.video); vb.append(video); }
      else vb.append(el("div", "empty", "No video was recorded for this run."));
      vidCard.append(vb);
      video.addEventListener("timeupdate", () => {
        let cur: HTMLElement | null = null;
        for (const it of items) if (video.currentTime >= it.at) cur = it.li;
        for (const it of items) it.li.classList.toggle("playing", it.li === cur);
      });
      grid.append(stepsCard, vidCard);
      root.append(grid);
    }
    ctx.api.call("GET /api/runs/:id", { id: rid }).then((r) => {
      if (!alive) return;
      if (!r.ok) { loading.replaceWith(el("div", "error", r.error)); return; }
      paint(r.run);
    });
    return () => { alive = false; };
  },
};

export const issuesScreen: ScreenModule = {
  id: "shell-issues",
  routes: ["/p/:pid/issues"],
  css: `
.il .sev { font-weight: 700; font-size: 12px; width: 28px; flex: none; color: var(--muted); }
.il .sev.s4, .il .sev.s5 { color: var(--fail); }
.il .sev.s3 { color: var(--warn); }
.il .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.il .tabs button[aria-pressed="true"] { background: var(--sel); box-shadow: inset 0 0 0 1px var(--fg); }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, ago } = ctx.ui;
    const pid = ctx.params.pid || "";
    let alive = true;
    let issues: Issue[] = [];
    let counts: Record<string, number> = {};
    let status = "open";
    const head = el("div", "pagehead");
    const h = el("div", "grow");
    h.append(el("h1", null, "Issues"), el("p", null, "Problems the runs measured, one row each however often they were seen. Severity comes from fixed rules, never from the AI."));
    head.append(h);
    const card = el("section", "card il");
    const ch = el("div", "cardhead");
    const tabs = el("div", "tabs");
    ch.append(tabs);
    const list = el("ul", "list");
    card.append(ch, list);
    root.append(head, card);
    function paint() {
      tabs.replaceChildren();
      for (const [k, w] of [["open", "Open"], ["resolved", "Resolved"], ["false_positive", "False positive"]] as const) {
        const b = el("button", "btn small", w + " " + (counts[k] || 0));
        b.type = "button";
        b.setAttribute("aria-pressed", String(status === k));
        b.addEventListener("click", () => { status = k; paint(); });
        tabs.append(b);
      }
      list.replaceChildren();
      const shown = issues.filter((i) => i.status === status);
      if (!shown.length) { const li = el("li"); li.append(el("span", "muted", status === "open" ? "No open issues." : "None.")); list.append(li); return; }
      for (const i of shown) {
        const li = el("li", "click");
        li.append(el("span", "sev s" + i.severity, "S" + i.severity));
        const a = el("a", "stack");
        a.style.textDecoration = "none";
        a.href = ctx.router.href("/p/" + encodeURIComponent(pid) + "/issues/" + encodeURIComponent(i.id));
        a.append(el("span", "name", i.title), el("span", "sub", i.kind.replace(/_/g, " ")));
        li.append(a, el("span", "meta", "seen " + i.count + "×"), el("span", "meta", ago(i.lastSeen)));
        li.addEventListener("click", (e) => { if (e.target !== a) a.click(); });
        list.append(li);
      }
    }
    async function load() {
      const r = await ctx.api.call("GET /api/projects/:id/issues", { id: pid });
      if (!alive) return;
      if (!r.ok) { list.replaceChildren(el("li", null, r.error)); return; }
      issues = r.issues || [];
      counts = r.counts || {};
      paint();
    }
    void load();
    const off = ctx.events.on("issues", () => { void load(); });
    return () => { alive = false; off(); };
  },
};

/**
 * A test's own page (#/p/:pid/tests/:tid, C11): its steps with their badges, its last 10 runs, its pass
 * rate (BLOCKED left out), Run, and "Edit steps" (the ui-run lane's editor, ?from=<tid>).
 */
export const testScreen: ScreenModule = {
  id: "shell-test",
  routes: ["/p/:pid/tests/:tid"],
  css: `
.tp { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.tp .card + .card { margin-top: 0; }
.tp .kind { font-size: 11px; font-weight: 600; border-radius: 6px; padding: 1px 7px; border: 1px solid var(--line); white-space: nowrap; }
.tp .kind.act { color: var(--info); } .tp .kind.assert { color: var(--pass); } .tp .kind.login { color: var(--warn); }
.tp li.off { opacity: .5; }
.tp .n { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; flex: none; color: var(--muted); }
@media (max-width: 860px) { .tp { grid-template-columns: minmax(0, 1fr); } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon, pill, ago, toast } = ctx.ui;
    const pid = ctx.params.pid || "";
    const tid = ctx.params.tid || "";
    const base = "/p/" + encodeURIComponent(pid);
    let alive = true;
    const back = el("a", "link", "← All tests");
    back.href = ctx.router.href(base + "/tests");
    const loading = el("div", "loading");
    loading.append(el("span", "spin"), el("span", null, "Loading the test…"));
    root.append(back, loading);
    ctx.api.call("GET /api/tests/:id", { id: tid }).then((r) => {
      if (!alive) return;
      if (!r.ok) { loading.replaceWith(el("div", "error", r.error)); return; }
      loading.remove();
      const t = r.test;
      const runs = (r.runs || []).slice(0, 10);
      const head = el("div", "pagehead");
      const h = el("div", "grow");
      const counted = runs.filter((x) => x.status === "completed" && x.verdict && x.verdict !== "blocked");
      const rate = counted.length ? Math.round((100 * counted.filter((x) => x.verdict === "pass").length) / counted.length) : null;
      h.append(el("h1", null, t.name), el("p", null, t.steps.length + (t.steps.length === 1 ? " step" : " steps") + (rate === null ? "" : " · " + rate + "% pass over the last " + counted.length)));
      const edit = el("a", "btn");
      edit.href = ctx.router.href(base + "/tests/new?from=" + encodeURIComponent(t.id));
      edit.append(icon("wand"), el("span", null, "Edit steps"));
      const run = el("button", "btn primary");
      run.type = "button";
      run.append(icon("play"), el("span", null, "Run"));
      run.addEventListener("click", async () => {
        const s = await ctx.api.call("POST /api/runs", {}, { projectId: pid, testId: t.id, source: "manual" });
        if (!s.ok) return toast(s.busy ? "A test is running. Wait for it or stop it first." : s.error);
        ctx.router.go(base + "/live");
      });
      head.append(h, edit, run);
      const grid = el("div", "tp");
      const sc = el("section", "card");
      const sh = el("div", "cardhead");
      sh.append(el("h2", null, "Steps"));
      // A test saved from a run that signed in first: it signs in as its account before step 1.
      if (t.account) sh.append(el("span", "tag", "signs in as " + t.account + " first"));
      const sl = el("ul", "list");
      t.steps.forEach((st, i) => {
        const li = el("li", st.enabled === false ? "off" : null);
        const k = st.kind || "act";
        const txt = el("div", "stack");
        txt.append(el("span", "name", st.title), el("span", "sub", k === "login" && st.accountLabel ? "as " + st.accountLabel : st.intent));
        li.append(el("span", "n", String(i + 1)), txt, el("span", "kind " + k, k === "act" ? "Act" : k === "assert" ? "Assert" : "Login"));
        if (k === "assert") li.append(el("span", "tag", st.checkMode === "judged" ? "judged" : "measured"));
        if (st.enabled === false) li.append(el("span", "tag", "off"));
        sl.append(li);
      });
      sc.append(sh, sl);
      const rc = el("section", "card");
      const rh = el("div", "cardhead");
      rh.append(el("h2", null, "Last runs"));
      const all = el("a", "link", "All runs");
      all.href = ctx.router.href(base + "/runs?test=" + encodeURIComponent(t.id));
      rh.append(el("span", "grow"), all);
      const rl = el("ul", "list");
      if (!runs.length) { const li = el("li"); li.append(el("span", "muted", "Not run yet.")); rl.append(li); }
      for (const x of runs) {
        const li = el("li", "click");
        const a = el("a", "stack");
        a.style.textDecoration = "none";
        a.href = ctx.router.href(base + "/runs/" + encodeURIComponent(x.id));
        a.append(el("span", "name", ago(x.startedAt)), el("span", "sub", x.reason || x.passed + " of " + x.steps + " steps passed"));
        li.append(x.status === "completed" && x.verdict ? pill(x.verdict, { judged: x.judged }) : pill(x.status), a);
        li.addEventListener("click", (e) => { if (e.target !== a) a.click(); });
        rl.append(li);
      }
      rc.append(rh, rl);
      grid.append(sc, rc);
      root.append(head, grid);
    });
    return () => { alive = false; };
  },
};
