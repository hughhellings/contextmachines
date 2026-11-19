/**
 * S8: Settings (#/p/:pid/settings) and the Accounts panel (#/p/:pid/accounts, the same module showing
 * only that panel). Plain forms:
 * - Project: name, default AI, default test account (a label), agent instructions (4,000 characters at
 *   most, to the planner only: they can't switch off a gate, C24).
 * - What the tester should know about this site: the person's notes (4,000 characters at most), saved in
 *   the project's contextmachines/context.md, to the planner, the actor and the judges; never a secret.
 * - Environments: name, address, kind; one default; "owned" is the server's D12 check, shown, never set here.
 * - Accounts: labels and session state only. Values live in the Keychain and never reach this page (C20a).
 * - Schedules: presets or cron, a time zone, a target; AI is fixed to none (replay only, $0); they run
 *   only while the app is open, and a busy app skips them (Q3, C18).
 * - App: a notification on a failed run, and asking once before exploring production (Q7).
 *
 * render() is inlined into the page by its source, so it is self-contained.
 */
import type { AccountSummary, AppSchedule, AppSettings, EnvKind, Environment, Group, Project, ScreenCtx, ScreenModule, TestDef } from "../../contracts.ts";

export const settingsScreen: ScreenModule = {
  id: "shell-settings",
  routes: ["/p/:pid/settings", "/p/:pid/accounts"],
  css: `
.st { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.st > * { min-width: 0; }
.st .card + .card { margin-top: 0; }
.st .cardbody { display: grid; gap: 12px; }
.st .counter { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
.st .counter.over, .st .notes-counter.over { color: var(--fail); font-weight: 600; }
.st .notes-counter { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
.st .envform { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) 140px auto; gap: 8px; align-items: end; }
.st .schedform { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-items: end; }
.st .fixed { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
.st .ok { color: var(--pass); } .st .meh { color: var(--warn); }
.st .danger { border-color: color-mix(in srgb, var(--fail) 35%, var(--line)); }
@media (max-width: 760px) { .st .envform, .st .schedform { grid-template-columns: minmax(0, 1fr); } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon, toast, ago } = ctx.ui;
    const pid = ctx.params.pid || "";
    const onlyAccounts = ctx.router.current().route === "/p/:pid/accounts";
    const MAX = 4000;
    let alive = true;
    let project: Project | undefined = ctx.project;
    let accounts: AccountSummary[] = [];
    let tests: TestDef[] = [];
    let groups: Group[] = [];
    const changed = () => dispatchEvent(new CustomEvent("cm:projects-changed"));
    const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
    const kindWord = (k: EnvKind) => (k === "local" ? "Local" : k === "staging" ? "Staging" : "Production");
    function guessKind(url: string): EnvKind {
      let h = "";
      try { h = new URL(url).hostname.toLowerCase(); } catch { return "production"; }
      // The same rule as S1's readAddress: only this computer is local; staging only from a subdomain label.
      if (h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "[::1]" || h === "0.0.0.0" || /\.(localhost|test)$/.test(h)) return "local";
      if (h.split(".").slice(0, -2).some((p) => /^(staging|stage|stg|dev|qa|test|preview|sandbox|uat)(-|\d|$)/.test(p))) return "staging";
      return "production";
    }
    function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
      const f = el("label", "field");
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) control.setAttribute("aria-label", label);
      f.append(el("span", null, label), control);
      if (hint) f.append(el("span", "hint", hint));
      return f;
    }
    function section(title: string, sub?: string): { card: HTMLElement; body: HTMLElement; head: HTMLElement } {
      const card = el("section", "card");
      const head = el("div", "cardhead");
      const t = el("div", "grow");
      t.append(el("h2", null, title));
      if (sub) t.append(el("div", "muted small", sub));
      head.append(t);
      const body = el("div", "cardbody");
      card.append(head, body);
      return { card, body, head };
    }

    const head = el("div", "pagehead");
    const h = el("div", "grow");
    h.append(el("h1", null, onlyAccounts ? "Accounts" : "Settings"), el("p", null, onlyAccounts ? "Test accounts the tester can sign in with. Labels only: the values never come to this page." : "This project's address, environments, accounts and schedules."));
    head.append(h);
    const wrap = el("div", "st");
    root.append(head, wrap);

    // ------------------------------------------------------------------ Project
    const proj = section("Project");
    const nameIn = el("input");
    nameIn.type = "text";
    nameIn.maxLength = 120;
    const aiSel = el("select");
    for (const [v, w] of [["claude-code", "Claude Code (your plan, $0 extra)"], ["codex", "Codex (your plan)"], ["none", "None: replay saved tests only, $0"]]) {
      const o = el("option", null, w);
      o.value = v as string;
      aiSel.append(o);
    }
    const acctSel = el("select");
    const instr = el("textarea");
    instr.rows = 5;
    instr.placeholder = "Dismiss the cookie banner first. Treat a red toast as a failure. Never press Delete account.";
    const counter = el("div", "counter");
    const projErr = el("div", "error");
    projErr.hidden = true;
    const projSave = el("button", "btn primary", "Save");
    projSave.type = "button";
    const g2 = el("div", "grid2");
    g2.append(field("Name", nameIn), field("Default AI", aiSel));
    proj.body.append(g2, field("Default test account", acctSel, "Used by Login steps unless a step picks another."), field("Agent instructions", instr, "Sent to the planner with every run. They can't switch off the buy, post and delete gate."), counter, projErr);
    const projFoot = el("div", "cardfoot");
    projFoot.append(projSave);
    proj.card.append(projFoot);

    function paintCounter() {
      const n = instr.value.length;
      counter.textContent = n.toLocaleString() + " / " + MAX.toLocaleString();
      counter.classList.toggle("over", n > MAX);
      projSave.disabled = n > MAX || !nameIn.value.trim();
    }
    instr.addEventListener("input", paintCounter);
    nameIn.addEventListener("input", paintCounter);
    function fillProject() {
      if (!project) return;
      nameIn.value = project.name;
      aiSel.value = project.ai || "claude-code";
      instr.value = project.instructions || "";
      notesBox.value = project.context || "";
      paintNotesCounter();
      paintAccountSelect();
      paintCounter();
    }
    function paintAccountSelect() {
      acctSel.replaceChildren();
      const none = el("option", null, "None: signed out, as a visitor");
      none.value = "";
      acctSel.append(none);
      const labels = new Set(accounts.map((a) => a.label));
      if (project && project.defaultAccount) labels.add(project.defaultAccount);
      for (const l of labels) { const o = el("option", null, l); o.value = l; acctSel.append(o); }
      acctSel.value = (project && project.defaultAccount) || "";
    }
    projSave.addEventListener("click", async () => {
      projErr.hidden = true;
      if (instr.value.length > MAX) { projErr.textContent = "Agent instructions can be 4,000 characters at most."; projErr.hidden = false; return; }
      projSave.disabled = true;
      const r = await ctx.api.call("POST /api/projects/:id", { id: pid }, { name: nameIn.value.trim(), ai: aiSel.value, instructions: instr.value, defaultAccount: acctSel.value });
      projSave.disabled = false;
      if (!r.ok) { projErr.textContent = r.error; projErr.hidden = false; return; }
      project = r.project;
      changed();
      toast("Project saved");
    });

    // ------------------------------------------------------------------ What the tester should know about this site
    // The person's own notes about how the site works (contextmachines/context.md): to the planner, the actor and
    // the judges with every run, fenced after their rules. Refused (never cut) over 4,000 characters or when they
    // look like they hold a password, key or token. A run that ended NOT SURE or BLOCKED links here with its reason.
    const know = section("What the tester should know about this site", "Plain facts about how your site works, read with every run by the planner, the actor and the judges. Saved in this project's contextmachines/context.md (the terminal reads it too).");
    know.card.id = "site-notes";
    const notesBox = el("textarea");
    notesBox.rows = 6;
    notesBox.placeholder = "For example: An order needs a delivery date before it can be saved. Use the Demo workspace, not Production.";
    const notesCounter = el("div", "notes-counter");
    const notesErr = el("div", "error");
    notesErr.hidden = true;
    const notesWhy = el("p", "hint");
    notesWhy.hidden = true;
    const notesSave = el("button", "btn primary", "Save notes");
    notesSave.type = "button";
    know.body.append(notesWhy, field("What the tester should know about this site", notesBox, "They can't switch off any rule: it still never pays, posts or deletes, and a step still passes only when the page shows it. Never put a password, key or token here: those go under Accounts."), notesCounter, notesErr);
    const knowFoot = el("div", "cardfoot");
    knowFoot.append(notesSave);
    know.card.append(knowFoot);
    function paintNotesCounter() {
      const n = notesBox.value.length;
      notesCounter.textContent = n.toLocaleString() + " / " + MAX.toLocaleString();
      notesCounter.classList.toggle("over", n > MAX);
      notesSave.disabled = n > MAX;
    }
    notesBox.addEventListener("input", paintNotesCounter);
    notesSave.addEventListener("click", async () => {
      notesErr.hidden = true;
      if (notesBox.value.length > MAX) { notesErr.textContent = "What the tester should know about this site can be 4,000 characters at most."; notesErr.hidden = false; return; }
      notesSave.disabled = true;
      const r = await ctx.api.call("POST /api/projects/:id", { id: pid }, { context: notesBox.value });
      notesSave.disabled = false;
      if (!r.ok) { notesErr.textContent = r.error; notesErr.hidden = false; return; }
      project = r.project;
      changed();
      toast(notesBox.value.trim() ? "Saved: the next run reads it" : "Notes cleared");
    });
    // Sent here from a run's result ("Tell the tester about this site"): its reason shown above the box, never written into it.
    let fromRun = "";
    try { fromRun = sessionStorage.getItem("cm-notes-from-run") || ""; sessionStorage.removeItem("cm-notes-from-run"); } catch { fromRun = ""; }
    if (fromRun) {
      notesWhy.textContent = "The run said: " + fromRun.slice(0, 400) + " If a rule of your site explains it, write the rule here in plain words.";
      notesWhy.hidden = false;
      setTimeout(() => { if (alive) { know.card.scrollIntoView({ block: "start" }); notesBox.focus(); } }, 50);
    }

    // ------------------------------------------------------------------ Environments
    const envs = section("Environments", "The tester only goes to these addresses. Sign-ups, test payments and test-mode setup lines only work on ones marked as yours.");
    const envList = el("ul", "list");
    const envForm = el("div", "envform");
    const envName = el("input");
    envName.placeholder = "Staging";
    const envUrl = el("input");
    envUrl.placeholder = "https://staging.acme.com";
    envUrl.spellcheck = false;
    const envKind = el("select");
    for (const k of ["local", "staging", "production"] as EnvKind[]) { const o = el("option", null, kindWord(k)); o.value = k; envKind.append(o); }
    const envAdd = el("button", "btn");
    envAdd.type = "button";
    envAdd.append(icon("plus"), el("span", null, "Add"));
    envForm.append(field("Name", envName), field("Address", envUrl), field("Kind", envKind), envAdd);
    const envErr = el("div", "error");
    envErr.hidden = true;
    envs.body.append(envList, envForm, envErr);
    envUrl.addEventListener("input", () => { if (envUrl.value.trim()) envKind.value = guessKind(/^https?:\/\//i.test(envUrl.value.trim()) ? envUrl.value.trim() : "https://" + envUrl.value.trim()); });

    async function saveEnvs(next: Environment[]): Promise<boolean> {
      envErr.hidden = true;
      const r = await ctx.api.call("POST /api/projects/:id", { id: pid }, { envs: next });
      if (!r.ok) { envErr.textContent = r.error; envErr.hidden = false; return false; }
      project = r.project;
      changed();
      paintEnvs();
      return true;
    }
    function paintEnvs() {
      envList.replaceChildren();
      // The account form follows the default environment's ownership (declared below; called once it exists).
      if (typeof paintAccountForm === "function" && accForm) paintAccountForm();
      const list = (project && project.envs) || [];
      for (const e of list) {
        const li = el("li");
        li.dataset.env = e.id;
        const t = el("div", "stack");
        t.append(el("span", "name", e.name), el("span", "sub", e.url));
        li.append(t, el("span", "chip " + e.kind, kindWord(e.kind)));
        const own = el("span", "tag", e.owned ? "owned" : e.signInOk ? "sign-in OK" : "not yours");
        own.title = e.owned ? "Passed the ownership check on this computer." : e.signInOk ? "You said you sign in with your own account here. It isn't marked as yours, so no sign-ups, payments or setup lines." : "Sign-ups, payments and test-mode setup lines are used only on a host you mark as yours. An account signs in here once you say it's your own account.";
        li.append(own);
        if (!e.owned) {
          const mine = el("button", "btn small", "This site is mine");
          mine.type = "button"; mine.dataset.key = "mine-" + e.id;
          mine.title = "Mark " + e.url + " as yours, so tests may also sign up and pay in test mode there. Only for a site you run.";
          mine.addEventListener("click", () => { void markMine(e); });
          li.append(mine);
        }
        if (e.default) li.append(el("span", "tag", "default"));
        else {
          const def = el("button", "btn small", "Make default");
          def.type = "button";
          def.addEventListener("click", () => { void saveEnvs(list.map((x) => { const y: Environment = { ...x }; delete y.default; if (x.id === e.id) y.default = true; return y; })); });
          const rm = el("button", "iconbtn");
          rm.type = "button";
          rm.setAttribute("aria-label", "Remove " + e.name);
          rm.append(icon("trash"));
          rm.addEventListener("click", () => { void saveEnvs(list.filter((x) => x.id !== e.id)); });
          li.append(def, rm);
        }
        envList.append(li);
      }
    }
    async function markMine(e: Environment) {
      let host = e.url;
      try { host = new URL(e.url).host; } catch { /* the address as it is */ }
      if (!confirm("Is " + host + " a site you run? Tests may create real accounts and pay in test mode there, and its setup lines will name your own keys.")) return;
      const r = await ctx.api.call("POST /api/projects/:id/owned", { id: pid }, { envId: e.id, yes: true });
      if (!alive) return;
      if (!r.ok) { toast(r.error); return; }
      project = r.project;
      changed();
      paintEnvs();
      paintAccountForm();
      toast(host + " is marked as yours");
    }
    envAdd.addEventListener("click", async () => {
      envErr.hidden = true;
      let raw = envUrl.value.trim();
      if (!raw) { envErr.textContent = "Put in the environment's address."; envErr.hidden = false; return; }
      if (!/^https?:\/\//i.test(raw)) raw = (/^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?([/?#]|$)/i.test(raw) ? "http://" : "https://") + raw;
      let u: URL;
      try { u = new URL(raw); } catch { envErr.textContent = "That doesn't look like a website address."; envErr.hidden = false; return; }
      if (u.username || u.password) { envErr.textContent = "Leave the user name and password out of the address."; envErr.hidden = false; return; }
      const list = (project && project.envs) || [];
      if (list.some((x) => x.url === u.toString())) { envErr.textContent = "That address is already an environment."; envErr.hidden = false; return; }
      const env: Environment = { id: "env_" + hex(), name: envName.value.trim() || kindWord(envKind.value as EnvKind), url: u.toString(), kind: envKind.value as EnvKind, owned: false, signInOk: false };
      if (await saveEnvs(list.concat([env]))) { envName.value = ""; envUrl.value = ""; }
    });

    // ------------------------------------------------------------------ Accounts
    const acc = section("Accounts", "Labels only. Passwords and codes stay in this computer's secret store (the macOS Keychain, or an owner-only file) and never reach this page or the AI.");
    const accList = el("ul", "list");
    const accForm = el("div", "envform"); accForm.dataset.role = "account-form";
    const accLabel = el("input"); accLabel.placeholder = "admin"; accLabel.maxLength = 32; accLabel.autocomplete = "off";
    const accUser = el("input"); accUser.placeholder = "test@example.com"; accUser.maxLength = 300; accUser.autocomplete = "off";
    const accPass = el("input"); accPass.type = "password"; accPass.autocomplete = "new-password"; accPass.placeholder = "Stored, never shown";
    const accSave = el("button", "btn", "Save account"); accSave.type = "button"; accSave.dataset.key = "account-save";
    const accErr = el("div", "note meh"); accErr.hidden = true; accErr.setAttribute("role", "alert");
    const accPassField = field("Password", accPass);
    accForm.append(field("Label", accLabel), field("Email or user name", accUser), accPassField, accSave);
    const accNote = el("div", "note");
    acc.body.append(accList, accForm, accErr, accNote);
    /** The default environment, where an account added here signs in. */
    const accEnv = () => (project?.envs.find((x) => x.default) ?? project?.envs[0]);
    function paintAccountForm() {
      const e = accEnv();
      const ok = Boolean(e?.owned || e?.signInOk);
      let host = e ? e.url : "this site";
      try { if (e) host = new URL(e.url).host; } catch { /* the address as it is */ }
      accForm.hidden = !e;
      accForm.style.display = e ? "" : "none";
      // No secret field until the person has said it's their own account there.
      accPassField.hidden = !ok;
      accPassField.style.display = ok ? "" : "none";
      accNote.textContent = ok ? "For a test account on " + (e ? e.url : "this site") + ". The password goes to the secret store; it never comes back to this page or the AI." : "Saving an account here asks you to confirm it's your own account on " + host + ".";
    }
    /** The words the person says yes to before an account signs in on a site that isn't theirs (accounts.ts signInOkWords). */
    const signInOkWords = (host: string) => "I'm signing in with my own account on " + host + ". The tester still won't post, pay, send or delete there.";
    accSave.addEventListener("click", async () => {
      accErr.hidden = true;
      const e = accEnv();
      const label = accLabel.value.trim();
      if (!e || !label) { accErr.textContent = "Give the account a label, like admin."; accErr.hidden = false; return; }
      if (!e.owned && !e.signInOk) {
        let host = e.url;
        try { host = new URL(e.url).host; } catch { /* the address as it is */ }
        if (!confirm(signInOkWords(host))) { accPass.value = ""; return; }
        const ok = await ctx.api.call("POST /api/projects/:id/signin-ok", { id: pid }, { envId: e.id, yes: true });
        if (!alive) return;
        if (!ok.ok) { accPass.value = ""; accErr.textContent = ok.error; accErr.hidden = false; return; }
        project = ok.project;
        changed();
        paintEnvs();
        // The password field shows only now: nothing is saved yet, so the account isn't kept without it.
        paintAccountForm();
        accErr.textContent = "Confirmed for " + host + ". Now type the password (if the account has one), then press Save account.";
        accErr.hidden = false;
        accPass.focus();
        return;
      }
      accSave.disabled = true;
      const r = await ctx.api.call("POST /api/projects/:id/accounts", { id: pid }, { envId: e.id, label, ...(accUser.value.trim() ? { username: accUser.value.trim() } : {}), ...(accPass.value ? { password: accPass.value } : {}) });
      accSave.disabled = false;
      // The password field is emptied whatever happened: it is never kept on the page.
      accPass.value = "";
      if (!alive) return;
      if (!r.ok) { accErr.textContent = r.error; accErr.hidden = false; return; }
      accounts = r.accounts;
      // The first account saved is the project's default now: Settings shows it.
      if (r.project) project = r.project;
      accLabel.value = ""; accUser.value = "";
      paintAccounts();
      paintAccountSelect();
      toast("Saved " + label);
    });
    function paintAccounts() {
      accList.replaceChildren();
      if (!accounts.length) { const li = el("li"); li.append(el("span", "muted", "No test accounts. Tests run signed out, as a visitor.")); accList.append(li); return; }
      for (const a of accounts) {
        const li = el("li");
        li.dataset.account = a.label;
        const t = el("div", "stack");
        t.append(el("span", "name", a.label), el("span", "sub", a.host + " · " + a.firstStep.replace(/-/g, " ")));
        li.append(icon("key"), t);
        if (a.problem) li.append(el("span", "tag meh", a.problem));
        // A1: runs never wait for a person. A code by email or text, a magic link, a captcha or Google is
        // passed once here, by the person, in a window on this computer; runs then reuse the saved session.
        if (a.firstStep !== "sign-up") {
          const bh = el("button", "btn small", "Set up sign-in"); bh.type = "button"; bh.dataset.key = "setup-" + a.label;
          bh.title = "Opens a browser window on this computer. Sign in there yourself once (type the code, open the link, solve the check); runs then reuse the session with no one there. Nothing of the window is recorded.";
          bh.addEventListener("click", async () => {
            const e = accEnv();
            if (!e) return;
            const r = await ctx.api.call("POST /api/projects/:id/sign-in-setup", { id: pid }, { envId: e.id, label: a.label });
            if (!alive) return;
            toast(r.ok ? "A browser window is opening on this computer: sign in there, then press Done." : r.error);
          });
          li.append(bh);
        }
        if (a.session) {
          const mins = Math.round(a.session.ageMs / 60000);
          li.append(el("span", "tag " + (a.session.fresh ? "ok" : "meh"), (a.session.fresh ? "Signed in · " : "Session old · ") + (mins < 60 ? mins + "m" : Math.round(mins / 60) + "h")));
        } else li.append(el("span", "tag", "No session yet"));
        accList.append(li);
      }
    }

    // ------------------------------------------------------------------ Schedules
    const sch = section("Schedules", "Replays saved tests on a timetable. They run only while this app is open. If a test is running, the scheduled run is skipped, never run at the same time.");
    const schList = el("ul", "list");
    const schForm = el("div", "schedform");
    const preset = el("select");
    for (const [v, w] of [["hourly", "Every hour"], ["daily", "Every day at 9:00"], ["weekdays", "Weekdays at 9:00"], ["cron", "Custom (cron)"]]) { const o = el("option", null, w); o.value = v as string; preset.append(o); }
    const cronIn = el("input");
    cronIn.placeholder = "0 9 * * 1-5";
    cronIn.spellcheck = false;
    const cronField = field("Cron", cronIn);
    cronField.hidden = true;
    const tz = el("input");
    tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    tz.spellcheck = false;
    const target = el("select");
    const schEnv = el("select");
    const schAdd = el("button", "btn");
    schAdd.type = "button";
    schAdd.append(icon("plus"), el("span", null, "Add schedule"));
    schForm.append(field("When", preset), cronField, field("Time zone", tz), field("What", target), field("Environment", schEnv));
    const fixed = el("span", "fixed");
    fixed.append(icon("lock"), el("span", null, "Scheduled runs use no AI, whatever the default: they replay saved tests only, $0."));
    const schFoot = el("div", "row");
    schFoot.append(schAdd, fixed);
    const schErr = el("div", "error");
    schErr.hidden = true;
    sch.body.append(schList, schForm, schFoot, schErr);
    preset.addEventListener("change", () => { cronField.hidden = preset.value !== "cron"; });
    let schedules: AppSchedule[] = [];
    function targetWords(t: AppSchedule["target"]): string {
      if ("all" in t) return "All saved tests";
      if ("group" in t) { const g = groups.find((x) => x.id === t.group); return "Group: " + (g ? g.name : t.group); }
      const s = tests.find((x) => x.id === t.test);
      return "Test: " + (s ? s.name : t.test);
    }
    function paintTargets() {
      target.replaceChildren();
      const all = el("option", null, "All saved tests");
      all.value = "all";
      target.append(all);
      for (const g of groups) { const o = el("option", null, "Group: " + g.name); o.value = "group:" + g.id; target.append(o); }
      for (const t of tests) { const o = el("option", null, "Test: " + t.name); o.value = "test:" + t.id; target.append(o); }
      schEnv.replaceChildren();
      for (const e of (project && project.envs) || []) { const o = el("option", null, e.name + (e.default ? " (default)" : "")); o.value = e.id; if (e.default) o.selected = true; schEnv.append(o); }
    }
    function paintSchedules() {
      schList.replaceChildren();
      if (!schedules.length) { const li = el("li"); li.append(el("span", "muted", "No schedules.")); schList.append(li); return; }
      for (const s of schedules) {
        const li = el("li");
        li.dataset.schedule = s.id;
        const t = el("div", "stack");
        const when = s.preset === "hourly" ? "Every hour" : s.preset === "daily" ? "Every day at 9:00" : s.preset === "weekdays" ? "Weekdays at 9:00" : "Cron " + s.cron;
        t.append(el("span", "name", when + " · " + targetWords(s.target)), el("span", "sub", s.timeZone + " · no AI (replays only)" + (s.lastFired ? " · last ran " + ago(s.lastFired) : "") + (s.lastSkippedBusy ? " · skipped (busy) " + ago(s.lastSkippedBusy) : "")));
        li.append(icon("calendar"), t);
        if (!s.enabled) li.append(el("span", "tag", "paused"));
        const rm = el("button", "iconbtn");
        rm.type = "button";
        rm.setAttribute("aria-label", "Delete schedule");
        rm.append(icon("trash"));
        rm.addEventListener("click", async () => {
          const r = await ctx.api.call("POST /api/schedules/:id/delete", { id: s.id });
          if (!r.ok) return toast(r.error);
          schedules = schedules.filter((x) => x.id !== s.id);
          paintSchedules();
        });
        li.append(rm);
        schList.append(li);
      }
    }
    schAdd.addEventListener("click", async () => {
      schErr.hidden = true;
      const p = preset.value as AppSchedule["preset"];
      if (p === "cron" && cronIn.value.trim().split(/\s+/).length !== 5) { schErr.textContent = "A cron line has 5 parts, like 0 9 * * 1-5."; schErr.hidden = false; return; }
      const tv = target.value;
      const tgt: AppSchedule["target"] = tv.startsWith("group:") ? { group: tv.slice(6) } : tv.startsWith("test:") ? { test: tv.slice(5) } : { all: true };
      const r = await ctx.api.call("POST /api/projects/:id/schedules", { id: pid }, { preset: p, cron: p === "cron" ? cronIn.value.trim() : undefined, timeZone: tz.value.trim() || "UTC", target: tgt, envId: schEnv.value || undefined, enabled: true });
      if (!r.ok) { schErr.textContent = r.error; schErr.hidden = false; return; }
      schedules = schedules.concat([r.schedule]);
      paintSchedules();
      toast("Schedule added");
    });

    // ------------------------------------------------------------------ App
    const appS = section("This app");
    const notify = el("input");
    notify.type = "checkbox";
    const notifyL = el("label", "check");
    notifyL.append(notify, el("span", null, "Show a Mac notification when a run fails"));
    const confirmP = el("input");
    confirmP.type = "checkbox";
    const confirmL = el("label", "check");
    confirmL.append(confirmP, el("span", null, "Ask once before exploring a production site"));
    appS.body.append(notifyL, confirmL);
    async function saveSettings(patch: Partial<AppSettings>) {
      const r = await ctx.api.call("POST /api/settings", {}, patch);
      if (!r.ok) return toast(r.error);
      notify.checked = r.settings.notifyOnFail;
      confirmP.checked = r.settings.confirmProduction;
      toast("Saved");
    }
    notify.addEventListener("change", () => { void saveSettings({ notifyOnFail: notify.checked }); });
    confirmP.addEventListener("change", () => { void saveSettings({ confirmProduction: confirmP.checked }); });

    // ------------------------------------------------------------------ Delete
    const del = section("Delete project", "Removes the project from this app. Its tests and run folders stay on disk.");
    del.card.classList.add("danger");
    const delBtn = el("button", "btn danger");
    delBtn.type = "button";
    delBtn.append(icon("trash"), el("span", null, "Delete project"));
    let armed = false;
    delBtn.addEventListener("click", async () => {
      if (!armed) { armed = true; (delBtn.lastChild as HTMLElement).textContent = "Click again to delete"; setTimeout(() => { if (alive) { armed = false; (delBtn.lastChild as HTMLElement).textContent = "Delete project"; } }, 4000); return; }
      const r = await ctx.api.call("POST /api/projects/:id/delete", { id: pid });
      if (!r.ok) return toast(r.error);
      changed();
      ctx.router.go("/");
    });
    del.body.append(delBtn);

    if (onlyAccounts) wrap.append(acc.card);
    else wrap.append(proj.card, know.card, envs.card, acc.card, sch.card, appS.card, del.card);

    fillProject();
    paintEnvs();
    paintAccountForm();
    Promise.all([
      ctx.api.call("GET /api/projects/:id/accounts", { id: pid }),
      onlyAccounts ? Promise.resolve(null) : ctx.api.call("GET /api/projects/:id/tests", { id: pid }),
      onlyAccounts ? Promise.resolve(null) : ctx.api.call("GET /api/projects/:id/groups", { id: pid }),
      onlyAccounts ? Promise.resolve(null) : ctx.api.call("GET /api/projects/:id/schedules", { id: pid }),
      onlyAccounts ? Promise.resolve(null) : ctx.api.call("GET /api/settings", {}),
    ]).then(([a, t, g, s, st]) => {
      if (!alive) return;
      if (a.ok) accounts = a.accounts || [];
      else accList.replaceChildren(el("li", null, a.error));
      if (t && t.ok) tests = t.tests || [];
      if (g && g.ok) groups = g.groups || [];
      if (s && s.ok) schedules = s.schedules || [];
      if (st && st.ok) { notify.checked = st.settings.notifyOnFail; confirmP.checked = st.settings.confirmProduction; }
      if (a.ok) paintAccounts();
      paintAccountSelect();
      paintTargets();
      paintSchedules();
    });
    const off = ctx.events.on("schedule", () => {
      ctx.api.call("GET /api/projects/:id/schedules", { id: pid }).then((s) => { if (alive && s.ok) { schedules = s.schedules; paintSchedules(); } });
    });
    // After "Set up sign-in" ends, the accounts are read again: the session tag shows whether it was saved
    // (its signed-in check is measured first, so this asks a few times).
    const offSetup = ctx.events.on("handover", (e) => {
      if (e.state === "needed") return;
      let n = 0;
      const again = () => ctx.api.call("GET /api/projects/:id/accounts", { id: pid }).then((r) => {
        if (!alive || !r.ok) return;
        accounts = r.accounts || [];
        paintAccounts();
        if (++n < 5) setTimeout(again, 1500);
      });
      setTimeout(again, 800);
    });
    return () => { alive = false; off(); offSetup(); };
  },
};
