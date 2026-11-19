/**
 * S3: a new test. Describe a flow and Generate (one plan ask) gives editable step cards; or Run now
 * runs the sentence straight away; or the Discovery tab explores the site. The cards are the plan the
 * run will follow: Act, Assert (measured, or judged when it names nothing the browser can measure) and
 * Login (an account picked by label; a value is never shown). Editing a saved step's words drops its
 * saved clicks (C5), so the AI plans that step again and the rest still replay.
 *
 * render is self-contained (the shell inlines its source): it uses only ctx and browser globals.
 */
import { scope } from "./css.ts";
import type { AccountSummary, Check, CheckMode, EnvKind, ExploreLimits, PlanStep, ScreenCtx, ScreenModule, StepKind } from "../../contracts.ts";

export const NEWTEST_CSS = `
.rn-new { max-width: 820px; margin: 0 auto; padding: 28px 16px 120px; }
.rn-new h1 { font-size: 22px; letter-spacing: -0.01em; margin: 0 0 4px; }
.rn-new .rn-lede { color: var(--muted); margin: 0 0 18px; }
.rn-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--soft); border: 1px solid var(--line); margin-bottom: 16px; }
.rn-tab { border: 0; background: none; padding: 6px 14px; border-radius: 7px; cursor: pointer; color: var(--muted); font-weight: 500; }
.rn-tab[aria-selected="true"] { background: var(--card); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.rn-box { border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); padding: 16px; }
.rn-box textarea, .rn-in, .rn-sel { width: 100%; font: inherit; font-size: 14px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
.rn-box textarea { min-height: 84px; resize: vertical; font-size: 15px; }
.rn-in:focus, .rn-sel:focus, .rn-box textarea:focus, .rn-card textarea:focus { outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
.rn-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rn-row.end { justify-content: flex-end; margin-top: 12px; }
.rn-grow { flex: 1; }
.rn-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-weight: 500; white-space: nowrap; color: var(--fg); }
.rn-btn:hover { background: var(--hover); }
.rn-btn:disabled { opacity: .45; cursor: default; }
.rn-btn.primary { background: var(--primary); color: var(--primaryfg); border-color: var(--primary); }
.rn-btn.small { padding: 3px 9px; font-size: 13px; }
.rn-btn .ico { width: 14px; height: 14px; }
.rn-btn:focus-visible, .rn-icon:focus-visible, .rn-plus:focus-visible, .rn-tab:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.rn-icon { border: 1px solid transparent; background: none; padding: 4px; border-radius: 6px; cursor: pointer; color: var(--muted); display: inline-flex; }
.rn-icon:hover { background: var(--hover); color: var(--fg); }
.rn-icon:disabled { opacity: .35; cursor: default; }
.rn-icon .ico { width: 14px; height: 14px; }
.rn-err { margin-top: 12px; padding: 9px 12px; border-radius: 8px; background: var(--failbg); color: var(--fail); overflow-wrap: anywhere; }
.rn-warnline { margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; background: var(--warnbg); color: var(--warn); font-size: 13px; display: flex; gap: 8px; align-items: flex-start; }
.rn-warnline .ico { margin-top: 2px; }
.rn-note { color: var(--muted); font-size: 12px; }
.rn-sugg:empty { display: none; }
.rn-sugg { margin-top: 12px; }
.rn-sugglist { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rn-sugglist .rn-btn { width: 100%; justify-content: flex-start; text-align: left; white-space: normal; }
.rn-cards { list-style: none; margin: 18px 0 0; padding: 0; background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 16px 16px; border-radius: 12px; padding: 12px; }
.rn-card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 10px 12px; display: grid; gap: 8px; }
.rn-card.k-assert { border-color: color-mix(in srgb, var(--pass) 45%, var(--line)); }
.rn-card.k-login { border-color: color-mix(in srgb, var(--fg) 30%, var(--line)); }
.rn-card.off { opacity: .55; }
.rn-card.bad { border-color: var(--fail); }
.rn-chead { display: flex; gap: 8px; align-items: center; min-width: 0; }
.rn-num { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; width: 1.4em; text-align: right; flex: none; }
.rn-kind { appearance: none; -webkit-appearance: none; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; border: 1px solid var(--line); background: var(--soft); color: var(--fg); cursor: pointer; flex: none; }
.rn-kind.k-assert { background: var(--passbg); color: var(--pass); border-color: color-mix(in srgb, var(--pass) 40%, transparent); }
.rn-kind.k-login { background: var(--sel); border-color: color-mix(in srgb, var(--fg) 35%, transparent); }
.rn-title { flex: 1; min-width: 0; border: 1px solid transparent; background: none; font-weight: 500; padding: 4px 6px; border-radius: 6px; color: var(--fg); font: inherit; }
.rn-title:hover { border-color: var(--line); }
.rn-title:focus { border-color: var(--line); outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); }
.rn-tools { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.rn-on { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); margin-right: 4px; cursor: pointer; }
.rn-on input { width: 15px; height: 15px; accent-color: var(--primary); margin: 0; }
.rn-card textarea { width: 100%; font: inherit; font-size: 13px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); min-height: 38px; resize: vertical; }
.rn-sub { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.rn-sub > label { color: var(--muted); font-size: 12px; }
.rn-sub .rn-sel, .rn-sub .rn-in { width: auto; padding: 5px 8px; font-size: 13px; }
.rn-sub .rn-in { flex: 1; min-width: 120px; }
.rn-mode { font-size: 11px; border-radius: 999px; padding: 0 8px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.rn-mode.judged { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.rn-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; white-space: nowrap; }
.rn-chip .ico { width: 12px; height: 12px; }
.rn-cardnote { font-size: 12px; color: var(--muted); margin: 0; }
.rn-cardnote.warn { color: var(--warn); }
.rn-cardnote.bad { color: var(--fail); }
.rn-gap { display: flex; justify-content: center; position: relative; height: 30px; align-items: center; }
.rn-gap::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: var(--line); }
.rn-plus { position: relative; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--line); background: var(--card); color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1; padding: 0; }
.rn-plus:hover { color: var(--fg); background: var(--hover); }
.rn-plus:disabled { opacity: .35; cursor: default; }
.rn-foot { position: sticky; bottom: 0; margin-top: 16px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); box-shadow: var(--shadow); }
.rn-count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }
.rn-count.full { color: var(--warn); }
.rn-envsel { width: auto; max-width: 200px; padding: 6px 8px; font-size: 13px; }
.rn-limits { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.rn-limits label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.rn-confirm { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; font-size: 13px; }
.rn-confirm input { margin-top: 3px; accent-color: var(--primary); }
.rn-gates { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.rn-spin { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; animation: rnspin .8s linear infinite; display: inline-block; flex: none; }
@keyframes rnspin { to { transform: rotate(360deg); } }
@media (max-width: 600px) {
  .rn-new { padding: 18px 12px 120px; }
  .rn-chead { flex-wrap: wrap; }
  .rn-title { flex-basis: calc(100% - 120px); }
  .rn-limits { grid-template-columns: minmax(0, 1fr); }
  .rn-foot .rn-grow { flex-basis: 100%; height: 0; }
}
`;

export const newTestScreen: ScreenModule = {
  id: "run.newtest",
  routes: ["/p/:pid/tests/new"],
  css: scope(".rn-new", NEWTEST_CSS),
  render: function renderNewTest(root: HTMLElement, ctx: ScreenCtx) {
    const { ui, api, router } = ctx;
    const pid = ctx.params.pid ?? "";
    const MAX = 30;
    const EXAMPLES = ["Search for a word and open the first result", "Open the pricing page and check the plans are listed", "Sign in and reach the dashboard"];
    const CHECKS: { kind: Check["kind"]; words: string; field?: "text" | "element" }[] = [
      { kind: "text_visible", words: "Page shows", field: "text" },
      { kind: "url_contains", words: "Address contains", field: "text" },
      { kind: "title_contains", words: "Title contains", field: "text" },
      { kind: "element_visible", words: "Element shows", field: "element" },
      { kind: "signed_in", words: "Signed in" },
      { kind: "password_gone", words: "Sign-in form gone" },
      { kind: "video_playing", words: "Video playing" },
      { kind: "video_paused", words: "Video paused" },
      { kind: "none", words: "Nothing measurable (judged)" },
    ];
    const KINDS: { kind: StepKind; words: string; icon: string }[] = [
      { kind: "act", words: "Act", icon: "wand" },
      { kind: "assert", words: "Assert", icon: "eye" },
      { kind: "login", words: "Login", icon: "lock" },
    ];
    const q = router.current().query;
    const st = {
      tab: q.get("tab") === "discovery" ? "discovery" : "describe",
      // S1 hands over what was picked (shell start.ts): ?mode=describe&goal=… fills the box; ?mode=path&path=… names the path.
      goal: (q.get("goal") || (q.get("mode") === "path" && q.get("path") ? "Open " + q.get("path") + " and check it works" : "")).slice(0, 500),
      name: "",
      steps: [] as PlanStep[],
      /** Steps loaded from a saved test, by id: their saved clicks are dropped when their words change (C5). */
      saved: new Map<string, string>(),
      testId: q.get("from") || "",
      envId: (ctx.project?.envs.find((e) => e.default) ?? ctx.project?.envs[0])?.id ?? "",
      accounts: null as AccountSummary[] | null,
      busy: "" as "" | "plan" | "save" | "run" | "explore" | "load" | "suggest",
      /** "Suggest tests" (?mode=suggest): the goals the AI suggested from a look at the site, to pick one. */
      suggestions: null as { goal: string; area: string }[] | null,
      busySince: 0,
      error: "",
      problems: new Map<string, string>(),
      limits: { maxSteps: 12, maxMinutes: 15, maxFailsInRow: 3 } as ExploreLimits,
      confirmed: false,
      nextId: 1,
    };
    let alive = true;
    const timer = setInterval(() => { if (st.busy === "plan") paintBusy(); }, 250);

    const env = () => ctx.project?.envs.find((e) => e.id === st.envId);
    const envKind = (): EnvKind | undefined => env()?.kind;
    const newId = () => { while (st.steps.some((s) => s.id === "s" + st.nextId)) st.nextId++; return "s" + st.nextId++; };
    const fingerprint = (s: PlanStep) => JSON.stringify([s.intent, s.check]);
    const modeOf = (s: PlanStep): CheckMode => (s.check.kind === "judged" || (s.kind === "assert" && s.check.kind === "none") ? "judged" : "measured");
    /** Old saved steps have no kind: act, or assert when they check something (C4). */
    const normal = (s: Partial<PlanStep> & { title?: string; intent?: string; check?: Check }, i: number): PlanStep => {
      const check: Check = s.check ?? { kind: "none" };
      const kind: StepKind = s.kind ?? (check.kind !== "none" ? "assert" : "act");
      const out: PlanStep = { id: s.id || "s" + (i + 1), title: s.title ?? "", intent: s.intent ?? "", check, kind, checkMode: "measured", enabled: s.enabled !== false };
      out.checkMode = s.checkMode === "judged" || modeOf(out) === "judged" ? "judged" : "measured";
      if (s.accountLabel) out.accountLabel = s.accountLabel;
      if (s.edited) out.edited = true;
      if (s.warning) out.warning = s.warning;
      return out;
    };
    const touched = (s: PlanStep) => {
      s.checkMode = modeOf(s);
      const was = st.saved.get(s.id);
      if (was !== undefined && was !== fingerprint(s)) s.edited = true;
      st.problems.delete(s.id);
      paintFoot();
    };

    // ----- layout -----------------------------------------------------------------------------
    const wrap = ui.el("div", "rn-new");
    const h1 = ui.el("h1", null, st.testId ? "Edit test" : "New test");
    const lede = ui.el("p", "rn-lede", "Describe what a person does on the site. You'll get steps you can edit before anything runs.");
    const tabs = ui.el("div", "rn-tabs");
    tabs.setAttribute("role", "tablist");
    const tabBtn = (id: string, words: string) => {
      const b = ui.el("button", "rn-tab", words);
      b.type = "button"; b.id = "rn-tab-" + id; b.setAttribute("role", "tab"); b.dataset.key = "tab-" + id;
      b.addEventListener("click", () => { st.tab = id; st.error = ""; paint(); });
      return b;
    };
    const tDescribe = tabBtn("describe", "Describe a flow");
    const tDiscovery = tabBtn("discovery", "Discovery");
    tabs.append(tDescribe, tDiscovery);
    const prod = ui.el("div", "rn-warnline");
    const body = ui.el("div");
    wrap.append(h1, lede, tabs, prod, body);
    root.append(wrap);

    // ----- the Describe box ---------------------------------------------------------------------
    const box = ui.el("div", "rn-box");
    const label = ui.el("label", "rn-note", "What do you want to test?");
    label.htmlFor = "rn-goal";
    const goal = ui.el("textarea");
    goal.id = "rn-goal"; goal.dataset.key = "goal"; goal.maxLength = 500; goal.placeholder = "Sign in and reach the dashboard";
    goal.value = st.goal;
    goal.addEventListener("input", () => { st.goal = goal.value; paintButtons(); });
    const exampleB = ui.el("button", "rn-btn", "Example"); exampleB.type = "button"; exampleB.dataset.key = "example";
    let exampleN = 0;
    exampleB.addEventListener("click", () => { st.goal = EXAMPLES[exampleN++ % EXAMPLES.length] ?? ""; goal.value = st.goal; paintButtons(); goal.focus(); });
    const runNowB = ui.el("button", "rn-btn"); runNowB.type = "button"; runNowB.dataset.key = "runnow"; runNowB.title = "Run the sentence now: the AI plans and acts as it goes, with no stop to edit";
    runNowB.append(ui.icon("play"), document.createTextNode("Run now"));
    const genB = ui.el("button", "rn-btn primary"); genB.type = "button"; genB.dataset.key = "generate";
    const genWords = ui.el("span", null, "Generate");
    const genIco = ui.el("span"); genIco.append(ui.icon("sparkle"));
    genB.append(genIco, genWords);
    const boxRow = ui.el("div", "rn-row end");
    boxRow.append(exampleB, ui.el("span", "rn-grow"), runNowB, genB);
    const err = ui.el("div", "rn-err"); err.setAttribute("role", "alert");
    const sugg = ui.el("div", "rn-sugg"); sugg.dataset.role = "suggestions";
    box.append(label, goal, boxRow, sugg);
    function paintSuggestions() {
      sugg.replaceChildren();
      if (st.busy === "suggest") { const p = ui.el("p", "rn-note"); p.append(ui.el("span", "rn-spin"), document.createTextNode(" Looking at the site and asking the AI for tests a visitor would try…")); sugg.append(p); return; }
      if (!st.suggestions?.length) return;
      sugg.append(ui.el("p", "rn-note", "Suggested tests: pick one to plan its steps."));
      const ul = ui.el("ul", "rn-sugglist");
      for (const t of st.suggestions) {
        const li = ui.el("li");
        const b = ui.el("button", "rn-btn", t.goal); b.type = "button"; b.dataset.key = "suggestion";
        if (t.area) b.title = t.area;
        b.addEventListener("click", () => { st.goal = t.goal; goal.value = t.goal; paintButtons(); genB.click(); });
        li.append(b); ul.append(li);
      }
      sugg.append(ul);
    }

    const cards = ui.el("ol", "rn-cards"); cards.setAttribute("aria-label", "Steps");
    const foot = ui.el("div", "rn-foot");
    const count = ui.el("span", "rn-count");
    const nameIn = ui.el("input", "rn-in"); nameIn.placeholder = "Test name"; nameIn.setAttribute("aria-label", "Test name"); nameIn.dataset.key = "name"; nameIn.style.maxWidth = "260px"; nameIn.maxLength = 120;
    nameIn.addEventListener("input", () => { st.name = nameIn.value; });
    const envSel = ui.el("select", "rn-sel rn-envsel"); envSel.setAttribute("aria-label", "Environment to run on"); envSel.dataset.key = "env";
    for (const e of ctx.project?.envs ?? []) { const o = ui.el("option", null, e.name + " · " + e.kind); o.value = e.id; envSel.append(o); }
    envSel.value = st.envId;
    // A new environment asks for the production tick again, and lists its own accounts.
    envSel.addEventListener("change", () => { st.envId = envSel.value; st.accounts = null; st.confirmed = false; confirmBox.checked = false; st.problems.clear(); loadAccounts(); paint(); });
    const saveB = ui.el("button", "rn-btn", "Save"); saveB.type = "button"; saveB.dataset.key = "save";
    const runB = ui.el("button", "rn-btn primary"); runB.type = "button"; runB.dataset.key = "run";
    runB.append(ui.icon("play"), document.createTextNode("Run"));
    foot.append(count, nameIn, ui.el("span", "rn-grow"), envSel, saveB, runB);

    // ----- the Discovery box --------------------------------------------------------------------
    const dbox = ui.el("div", "rn-box");
    const dgoal = ui.el("p", null, "Explore the app and find bugs");
    dgoal.style.margin = "0 0 4px"; dgoal.style.fontWeight = "600";
    const dnote = ui.el("p", "rn-note", "It visits the pages a person would, on this project's addresses only, and files what it measures (failed steps, errors, slow or confusing spots) as issues. It never buys, posts, sends or deletes.");
    dnote.style.margin = "0";
    const limits = ui.el("div", "rn-limits");
    const limitIn = (key: keyof ExploreLimits, words: string, min: number, max: number) => {
      const l = ui.el("label", null, words);
      const i = ui.el("input", "rn-in"); i.type = "number"; i.min = String(min); i.max = String(max); i.value = String(st.limits[key]); i.dataset.key = "limit-" + key;
      i.addEventListener("input", () => { const n = Math.round(Number(i.value)); if (Number.isFinite(n)) st.limits[key] = Math.min(max, Math.max(min, n)); });
      i.addEventListener("change", () => { i.value = String(st.limits[key]); });
      l.append(i);
      return l;
    };
    limits.append(limitIn("maxSteps", "Steps at most", 1, 30), limitIn("maxMinutes", "Minutes at most", 1, 60), limitIn("maxFailsInRow", "Stop after failures in a row", 1, 10));
    const confirm = ui.el("label", "rn-confirm");
    const confirmBox = ui.el("input"); confirmBox.type = "checkbox"; confirmBox.dataset.key = "confirm";
    confirmBox.addEventListener("change", () => { st.confirmed = confirmBox.checked; paintButtons(); });
    const confirmWords = ui.el("span");
    confirmWords.append(ui.el("span", null, "I understand this is a live site. It still never:"));
    const gates = ui.el("ul", "rn-gates");
    for (const g of ["buys, pays, posts, comments, sends or deletes", "creates accounts", "goes to another site", "solves or gets around a captcha or bot check"]) gates.append(ui.el("li", null, g));
    confirmWords.append(gates);
    confirm.append(confirmBox, confirmWords);
    const dRow = ui.el("div", "rn-row end");
    const startB = ui.el("button", "rn-btn primary"); startB.type = "button"; startB.dataset.key = "explore";
    startB.append(ui.icon("globe"), document.createTextNode("Start exploring"));
    dRow.append(startB);
    dbox.append(dgoal, dnote, limits, confirm, dRow);

    // ----- painting -----------------------------------------------------------------------------
    const keepFocus = (fn: () => void) => {
      const a = document.activeElement as HTMLElement | null;
      const key = a && root.contains(a) ? a.dataset.key : undefined;
      const sel = a && "selectionStart" in a ? [(a as HTMLInputElement).selectionStart, (a as HTMLInputElement).selectionEnd] : null;
      fn();
      if (key) {
        const b = root.querySelector<HTMLElement>('[data-key="' + key + '"]');
        if (b && b !== document.activeElement) {
          b.focus();
          if (sel && "setSelectionRange" in b) try { (b as HTMLInputElement).setSelectionRange(sel[0] ?? null, sel[1] ?? null); } catch { /* not a text field */ }
        }
      }
    };

    function paintBusy() {
      if (!alive) return;
      const s = Math.floor((Date.now() - st.busySince) / 1000);
      genWords.textContent = st.busy === "plan" ? "Planning… " + s + " s" : "Generate";
    }
    function paintButtons() {
      const busy = Boolean(st.busy);
      const has = Boolean(st.goal.trim());
      genB.disabled = busy || !has;
      runNowB.disabled = busy || !has;
      exampleB.disabled = busy;
      genIco.replaceChildren(st.busy === "plan" ? ui.el("span", "rn-spin") : ui.icon("sparkle"));
      paintBusy();
      saveB.disabled = busy || !st.steps.length;
      runB.disabled = busy || !st.steps.some((s) => s.enabled);
      startB.disabled = busy || (envKind() === "production" && !st.confirmed);
      err.hidden = !st.error;
      err.textContent = st.error;
    }
    function paintFoot() {
      count.textContent = st.steps.length + " / " + MAX + " steps";
      count.classList.toggle("full", st.steps.length >= MAX);
      for (const b of cards.querySelectorAll<HTMLButtonElement>(".rn-plus")) b.disabled = st.steps.length >= MAX || Boolean(st.busy);
      paintButtons();
    }
    function paint() {
      if (!alive) return;
      keepFocus(() => {
        tDescribe.setAttribute("aria-selected", String(st.tab === "describe"));
        tDiscovery.setAttribute("aria-selected", String(st.tab === "discovery"));
        tDescribe.tabIndex = st.tab === "describe" ? 0 : -1;
        tDiscovery.tabIndex = st.tab === "discovery" ? 0 : -1;
        const k = envKind();
        prod.hidden = k !== "production";
        prod.replaceChildren(ui.icon("warn"), ui.el("span", null, st.tab === "discovery"
          ? "This is a production address. Discovery asks you to confirm first; buy, post, send and delete stay blocked."
          : "This is a production address. Buy, post, send and delete stay blocked, and no accounts are created here."));
        body.replaceChildren();
        // The environment picker goes where the run starts: beside Run with cards, beside Run now
        // before them, and beside Start on Discovery. A single picker, so the choice is one.
        if (st.tab === "describe") {
          body.append(box, err);
          if (st.steps.length) {
            paintCards();
            foot.insertBefore(envSel, saveB);
            body.append(cards, foot);
          } else boxRow.insertBefore(envSel, runNowB);
        } else {
          confirm.hidden = k !== "production";
          dRow.prepend(envSel);
          body.append(dbox, err);
        }
        envSel.hidden = (ctx.project?.envs.length ?? 0) < 2;
        paintFoot();
      });
    }

    function gap(at: number) {
      const li = ui.el("li", "rn-gap");
      const b = ui.el("button", "rn-plus", "+"); b.type = "button"; b.title = "Add a step here"; b.setAttribute("aria-label", "Add a step at " + (at + 1)); b.dataset.key = "plus-" + at;
      b.addEventListener("click", () => {
        if (st.steps.length >= MAX) return;
        const s: PlanStep = { id: newId(), title: "New step", intent: "", check: { kind: "none" }, kind: "act", checkMode: "measured", enabled: true };
        st.steps.splice(at, 0, s);
        paint();
        root.querySelector<HTMLElement>('[data-key="title-' + s.id + '"]')?.focus();
      });
      li.append(b);
      return li;
    }

    function paintCards() {
      cards.replaceChildren();
      cards.append(gap(0));
      st.steps.forEach((s, i) => {
        const li = ui.el("li", "rn-card k-" + s.kind + (s.enabled ? "" : " off") + (st.problems.has(s.id) ? " bad" : ""));
        li.dataset.id = s.id;
        const head = ui.el("div", "rn-chead");
        const kind = ui.el("select", "rn-kind k-" + s.kind);
        kind.setAttribute("aria-label", "Step " + (i + 1) + " kind"); kind.dataset.key = "kind-" + s.id;
        for (const k of KINDS) { const o = ui.el("option", null, k.words); o.value = k.kind; kind.append(o); }
        kind.value = s.kind;
        kind.addEventListener("change", () => {
          const to = kind.value as StepKind;
          s.kind = to;
          if (to === "act") s.check = { kind: "none" };
          if (to === "assert" && s.check.kind === "none") s.check = { kind: "text_visible", text: "" };
          if (to === "login") { s.check = { kind: "signed_in" }; s.accountLabel = s.accountLabel ?? ctx.project?.defaultAccount; if (!s.intent) s.intent = "Sign in"; }
          else delete s.accountLabel;
          touched(s);
          paint();
        });
        const title = ui.el("input", "rn-title");
        title.value = s.title; title.maxLength = 120; title.setAttribute("aria-label", "Step " + (i + 1) + " title"); title.dataset.key = "title-" + s.id;
        title.addEventListener("input", () => { s.title = title.value; });
        const tools = ui.el("span", "rn-tools");
        const on = ui.el("label", "rn-on");
        const onBox = ui.el("input"); onBox.type = "checkbox"; onBox.checked = s.enabled; onBox.dataset.key = "on-" + s.id;
        onBox.setAttribute("aria-label", "Step " + (i + 1) + " on");
        onBox.addEventListener("change", () => { s.enabled = onBox.checked; paint(); });
        on.append(onBox, ui.el("span", null, "On"));
        const tool = (key: string, ico: string, words: string, disabled: boolean, fn: () => void) => {
          const b = ui.el("button", "rn-icon"); b.type = "button"; b.title = words; b.setAttribute("aria-label", words + " (step " + (i + 1) + ")"); b.dataset.key = key + "-" + s.id; b.disabled = disabled;
          b.append(ui.icon(ico));
          if (key === "down") b.style.transform = "none";
          if (key === "up") b.firstElementChild?.setAttribute("style", "transform: rotate(180deg)");
          b.addEventListener("click", fn);
          return b;
        };
        const move = (d: number) => () => {
          const j = i + d;
          if (j < 0 || j >= st.steps.length) return;
          const [x] = st.steps.splice(i, 1);
          if (x) st.steps.splice(j, 0, x);
          paint();
          const again = root.querySelector<HTMLButtonElement>('[data-key="' + (d < 0 ? "up" : "down") + "-" + s.id + '"]');
          (again && !again.disabled ? again : root.querySelector<HTMLElement>('[data-key="title-' + s.id + '"]'))?.focus();
        };
        tools.append(on,
          tool("up", "chev", "Move up", i === 0, move(-1)),
          tool("down", "chev", "Move down", i === st.steps.length - 1, move(1)),
          tool("del", "x", "Delete step", false, () => {
            st.steps.splice(i, 1);
            st.saved.delete(s.id);
            paint();
            const next = st.steps[Math.min(i, st.steps.length - 1)];
            root.querySelector<HTMLElement>(next ? '[data-key="title-' + next.id + '"]' : '[data-key="goal"]')?.focus();
          }));
        head.append(ui.el("span", "rn-num", String(i + 1)), kind, title, tools);
        li.append(head);

        const intent = ui.el("textarea");
        intent.value = s.intent; intent.maxLength = 500; intent.rows = 1; intent.placeholder = s.kind === "assert" ? "What should be true" : "What to do";
        intent.setAttribute("aria-label", "Step " + (i + 1) + " what to do"); intent.dataset.key = "intent-" + s.id;
        intent.addEventListener("input", () => { s.intent = intent.value; touched(s); paintNotes(); });
        li.append(intent);

        // An Act step's own check is shown too: what a PASS measured is never hidden.
        if (s.kind === "assert" || (s.kind === "act" && s.check.kind !== "none")) {
          const row = ui.el("div", "rn-sub");
          const lab = ui.el("label", null, s.kind === "act" ? "Then check" : "Check");
          const ck = ui.el("select", "rn-sel"); ck.setAttribute("aria-label", "Step " + (i + 1) + " check"); ck.dataset.key = "check-" + s.id;
          for (const c of CHECKS) { const o = ui.el("option", null, c.words); o.value = c.kind; ck.append(o); }
          ck.value = s.check.kind;
          ck.addEventListener("change", () => {
            const k = ck.value as Check["kind"];
            const text = "text" in s.check && typeof s.check.text === "string" ? s.check.text : "";
            s.check = k === "text_visible" || k === "url_contains" || k === "title_contains" ? { kind: k, text } : k === "element_visible" ? { kind: k, role: "button", name: text } : k === "signed_in" ? { kind: k } : ({ kind: k } as Check);
            touched(s);
            paint();
          });
          row.append(lab, ck);
          const c = s.check;
          if (c.kind === "text_visible" || c.kind === "url_contains" || c.kind === "title_contains") {
            const t = ui.el("input", "rn-in"); t.value = c.text; t.placeholder = c.kind === "url_contains" ? "/dashboard" : "Welcome back"; t.maxLength = 200;
            t.setAttribute("aria-label", "Step " + (i + 1) + " check words"); t.dataset.key = "ctext-" + s.id;
            t.addEventListener("input", () => { c.text = t.value; touched(s); });
            row.append(t);
          } else if (c.kind === "element_visible") {
            const r = ui.el("input", "rn-in"); r.value = c.role; r.style.maxWidth = "110px"; r.placeholder = "button"; r.setAttribute("aria-label", "Step " + (i + 1) + " element role"); r.dataset.key = "crole-" + s.id;
            r.addEventListener("input", () => { c.role = r.value; touched(s); });
            const n = ui.el("input", "rn-in"); n.value = c.name; n.placeholder = "Its name"; n.setAttribute("aria-label", "Step " + (i + 1) + " element name"); n.dataset.key = "cname-" + s.id;
            n.addEventListener("input", () => { c.name = n.value; touched(s); });
            row.append(r, n);
          }
          const mode = ui.el("span", "rn-mode " + modeOf(s), modeOf(s));
          mode.title = modeOf(s) === "judged" ? "No measurable check: an AI looks and judges it. Labelled judged everywhere, and it never makes a PASS alone." : "The browser measures this check. The AI never decides it.";
          mode.dataset.role = "mode";
          row.append(mode);
          li.append(row);
        }

        if (s.kind === "login") {
          const row = ui.el("div", "rn-sub");
          const lab = ui.el("label", null, "Account"); lab.htmlFor = "rn-acct-" + s.id;
          const sel = ui.el("select", "rn-sel"); sel.id = "rn-acct-" + s.id; sel.dataset.key = "acct-" + s.id;
          const e = env();
          const list = st.accounts ?? [];
          if (e && !e.owned && !e.signInOk) {
            sel.disabled = true;
            sel.append(ui.el("option", null, "Not on this environment"));
            row.append(lab, sel, ui.el("span", "rn-note", "Confirm under Accounts that it's your own account on this site first."));
          } else if (st.accounts === null) {
            sel.disabled = true; sel.append(ui.el("option", null, "Loading accounts…"));
            row.append(lab, sel);
          } else if (!list.length) {
            sel.disabled = true; sel.append(ui.el("option", null, "No test accounts yet"));
            const a = ui.el("a", "rn-note", "Add one in Accounts"); a.href = router.href("/p/" + pid + "/accounts");
            row.append(lab, sel, a);
          } else {
            const none = ui.el("option", null, "Pick an account"); none.value = ""; sel.append(none);
            for (const a of list) { const o = ui.el("option", null, a.label); o.value = a.label; sel.append(o); }
            sel.value = s.accountLabel && list.some((a) => a.label === s.accountLabel) ? s.accountLabel : "";
            sel.addEventListener("change", () => { if (sel.value) s.accountLabel = sel.value; else delete s.accountLabel; st.problems.delete(s.id); paint(); });
            row.append(lab, sel);
            const acct = list.find((a) => a.label === s.accountLabel);
            if (acct) {
              const chip = ui.el("span", "rn-chip"); chip.dataset.role = "session";
              chip.append(ui.icon(acct.session?.fresh ? "okc" : "clock"), document.createTextNode(acct.session ? (acct.session.fresh ? "Session saved" : "Session old: signs in again") : "Signs in at the start"));
              row.append(chip);
              if (acct.problem) row.append(ui.el("span", "rn-cardnote bad", acct.problem));
            }
          }
          li.append(row);
        }
        const notes = ui.el("div"); notes.dataset.role = "notes"; li.append(notes);
        const paintNotes = () => {
          notes.replaceChildren();
          if (s.edited) notes.append(ui.el("p", "rn-cardnote", "Edited: the AI plans this step again on the next run. The other steps still replay."));
          if (s.warning) notes.append(ui.el("p", "rn-cardnote warn", s.warning));
          if (!s.enabled) notes.append(ui.el("p", "rn-cardnote", "Off: shown in the run as skipped."));
          const p = st.problems.get(s.id);
          if (p) notes.append(ui.el("p", "rn-cardnote bad", p));
        };
        paintNotes();
        cards.append(li, gap(i + 1));
      });
    }

    // ----- actions ------------------------------------------------------------------------------
    /**
     * A login card with no account picked takes the one the goal names ("as viewer"), else the project's
     * default, else its only account (pick-account.ts, the server's picker, said again here: this runs in the page).
     */
    function presetAccounts() {
      const list = st.accounts ?? [];
      if (!list.length) return;
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
      const named = list.filter((a) => new RegExp("\\bas\\s+(?:the\\s+|an?\\s+|my\\s+)?" + esc(a.label) + "\\b", "i").test(st.goal));
      const def = ctx.project?.defaultAccount;
      const pick = named.length === 1 ? named[0]!.label : def && list.some((a) => a.label === def) ? def : list.length === 1 ? list[0]!.label : undefined;
      if (!pick) return;
      // Never a card that has its own account (one not here is the server's to say), is switched off, or is a
      // negative test: signed out, a sign-in meant to fail, or typing its own values (NOT_SIGNING_IN in types.ts, said again here).
      const NOT_SIGNING_IN = /\b(?:sign(?:ed|s|ing)?[ -]?out|log(?:ged|s|ging)?[ -]?(?:out|off)|not (?:signed|logged)[ -]?in|without (?:signing|logging)[ -]?in|(?:wrong|bad|invalid|incorrect|unknown|empty|blank|missing|fake) (?:password|e-?mail|username|credentials|details|log[ -]?in|sign[ -]?in)|(?:password|e-?mail|username|credentials) (?:is |are )?(?:wrong|invalid|incorrect)|(?:sign|log)[ -]?in (?:fails?|failed|failing|errors?|is (?:rejected|refused|denied))|redirect(?:s|ed)? (?:you )?(?:back )?to (?:the )?(?:log|sign)[ -]?in|(?:sends?|takes?|bounces?|goes|kicks?) (?:you )?(?:back )?to (?:the )?(?:log|sign)[ -]?in|as an? (?:visitor|guest|anonymous)|anonymous(?:ly)?|logged-out)\b|\{bad\.|\{wrong\./i;
      for (const s of st.steps) if (s.kind === "login" && s.enabled !== false && !s.accountLabel && !NOT_SIGNING_IN.test(s.title + " " + s.intent) && !/\{[\w-]+(?:\.[\w-]+)?\}/.test(s.title + " " + s.intent)) { s.accountLabel = pick; st.problems.delete(s.id); }
    }
    function loadAccounts() {
      const e = env();
      if (!e || (!e.owned && !e.signInOk)) return;
      if (st.accounts) { presetAccounts(); return; }
      void api.call("GET /api/projects/:id/accounts", { id: pid }).then((r) => {
        if (!alive) return;
        st.accounts = r.ok ? r.accounts : [];
        presetAccounts();
        if (st.steps.some((s) => s.kind === "login")) paint();
      });
    }
    const begin = (b: typeof st.busy) => { st.busy = b; st.busySince = Date.now(); st.error = ""; paintFoot(); };
    const end = (error?: string) => { st.busy = ""; if (error !== undefined) st.error = error; if (alive) paint(); };
    /** The cards as sent: each check's mode as shown, and nothing the editor keeps for itself. */
    const outSteps = (forRun = false): PlanStep[] => st.steps.map((s) => {
      const o: PlanStep = { ...s, title: s.title.trim() || s.intent.trim().slice(0, 60) || "Step", checkMode: modeOf(s) };
      // No account label goes with a run on an address where accounts may not sign in (a saved test keeps its cards as they are).
      if (forRun && o.kind === "login" && env() && !env()!.owned && !env()!.signInOk) delete o.accountLabel;
      return o;
    });
    /** Every problem a card has, said on the card (the run is still the server's to refuse). */
    const check = (): boolean => {
      st.problems.clear();
      const e = env();
      for (const s of st.steps) {
        if (!s.enabled) continue; // a switched-off card isn't run, so it can't stop the others
        if (!s.intent.trim() && s.kind !== "login") st.problems.set(s.id, "Say what to do in this step.");
        // Accounts only where you said it's your own account (or it's yours): a login card elsewhere is refused here, not left to the server.
        else if (s.kind === "login" && e && !e.owned && !e.signInOk) st.problems.set(s.id, "You haven't said you sign in with your own account on this address. Confirm it under Accounts, or switch the step off.");
        else if (s.kind === "login" && !s.accountLabel) st.problems.set(s.id, "Pick the account to sign in as.");
        else if (s.kind === "assert" && "text" in s.check && typeof s.check.text === "string" && !s.check.text.trim()) st.problems.set(s.id, "Say what the check looks for, or choose Nothing measurable.");
        else if (s.kind === "assert" && s.check.kind === "element_visible" && !s.check.name.trim()) st.problems.set(s.id, "Say the element's name, or choose Nothing measurable.");
      }
      if (st.problems.size) { st.error = "Some steps need a word more: see the cards marked in red."; paint(); return false; }
      return true;
    };

    genB.addEventListener("click", async () => {
      if (!st.goal.trim() || st.busy) return;
      begin("plan");
      const r = await api.call("POST /api/plan", {}, { projectId: pid, ...(st.envId ? { envId: st.envId } : {}), goal: st.goal.trim() });
      if (!alive) return;
      if (!r.ok) return end(r.error);
      st.steps = r.steps.slice(0, MAX).map(normal);
      st.saved.clear();
      st.problems.clear();
      if (!st.name) { st.name = st.goal.trim().slice(0, 80); nameIn.value = st.name; }
      end("");
      loadAccounts();
      root.querySelector<HTMLElement>(".rn-card select")?.focus();
    });
    runNowB.addEventListener("click", async () => {
      if (!st.goal.trim() || st.busy) return;
      begin("run");
      const r = await api.call("POST /api/runs", {}, { projectId: pid, ...(st.envId ? { envId: st.envId } : {}), goal: st.goal.trim(), source: "manual" });
      if (!alive) return;
      if (!r.ok) return end(r.error);
      end("");
      router.go("/p/" + pid + "/live");
    });
    async function save(): Promise<string | null> {
      const steps = outSteps();
      const name = st.name.trim() || st.goal.trim().slice(0, 80) || "Untitled test";
      const r = st.testId
        ? await api.call("POST /api/tests/:id", { id: st.testId }, { name, goal: st.goal.trim(), steps, ...(st.envId ? { envId: st.envId } : {}) })
        : await api.call("POST /api/projects/:id/tests", { id: pid }, { name, goal: st.goal.trim(), steps, origin: "describe", ...(st.envId ? { envId: st.envId } : {}) });
      if (!r.ok) { end(r.error); return null; }
      st.testId = r.test.id;
      // What was saved is now the saved test: a later edit drops that step's saved clicks.
      st.saved = new Map(r.test.steps.map((s) => [s.id, fingerprint(s)]));
      return r.test.id;
    }
    saveB.addEventListener("click", async () => {
      if (st.busy || !check()) return;
      begin("save");
      const id = await save();
      if (!alive || !id) return;
      end("");
      ui.toast("Saved");
      router.go("/p/" + pid + "/tests/" + id);
    });
    runB.addEventListener("click", async () => {
      if (st.busy || !check()) return;
      begin("run");
      const r = await api.call("POST /api/runs", {}, { projectId: pid, ...(st.envId ? { envId: st.envId } : {}), ...(st.testId ? { testId: st.testId } : {}), goal: st.goal.trim(), steps: outSteps(true), source: "manual" });
      if (!alive) return;
      if (!r.ok) return end(r.error);
      end("");
      router.go("/p/" + pid + "/live");
    });
    startB.addEventListener("click", async () => {
      if (st.busy) return;
      begin("explore");
      const r = await api.call("POST /api/explore", {}, { projectId: pid, ...(st.envId ? { envId: st.envId } : {}), limits: { ...st.limits }, ...(envKind() === "production" ? { confirmedProduction: st.confirmed } : {}) });
      if (!alive) return;
      if (!r.ok) return end(r.error);
      end("");
      router.go("/p/" + pid + "/live");
    });
    tabs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      st.tab = st.tab === "describe" ? "discovery" : "describe";
      paint();
      (st.tab === "describe" ? tDescribe : tDiscovery).focus();
    });

    // A saved test opened to edit: its steps, as saved; changing one's words drops its saved clicks.
    if (st.testId) {
      begin("load");
      void api.call("GET /api/tests/:id", { id: st.testId }).then((r) => {
        if (!alive) return;
        if (!r.ok) { st.testId = ""; return end(r.error); }
        st.goal = r.test.goal; goal.value = st.goal;
        st.name = r.test.name; nameIn.value = st.name;
        if (r.test.envId && ctx.project?.envs.some((e) => e.id === r.test.envId)) { st.envId = r.test.envId; envSel.value = st.envId; }
        st.steps = r.test.steps.map(normal);
        st.saved = new Map(st.steps.map((s) => [s.id, fingerprint(s)]));
        loadAccounts();
        end("");
      });
    }
    paint();
    // S1's choices: "Suggest tests" asks for suggestions; "Describe a test" and "Test a path" plan the goal they filled.
    const mode = q.get("mode");
    if (!st.testId && mode === "suggest") {
      begin("suggest");
      paintSuggestions();
      void api.call("POST /api/suggest", {}, { projectId: pid, ...(st.envId ? { envId: st.envId } : {}) }).then((r) => {
        if (!alive) return;
        st.suggestions = r.ok ? r.tasks : [];
        end(r.ok ? "" : r.error);
        paintSuggestions();
      });
    } else if (!st.testId && (mode === "describe" || mode === "path") && st.goal.trim()) {
      // Only with an AI ready: without one, the box stays filled and Generate says why when pressed.
      void api.call("GET /api/setup", {}).then((r) => { if (alive && r.ok && r.ai.ready && !st.steps.length && !st.busy) genB.click(); });
    }
    return () => { alive = false; clearInterval(timer); };
  },
};
