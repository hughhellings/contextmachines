/**
 * S1: "What do you want to test?" One address in (localhost, 127.0.0.1, staging or production), four
 * ways to start, and the first-run checklist told truthfully (C3, C21, Q7). Pressing the button saves
 * the site as a project and goes on in one screen.
 *
 * Where each choice goes (the ui-run lane reads these on #/p/:pid/tests/new):
 * - Suggest tests            -> #/p/:pid/tests/new?mode=suggest
 * - Test a path              -> #/p/:pid/tests/new?mode=path&path=/checkout
 * - Describe a test          -> #/p/:pid/tests/new?mode=describe&goal=<sentence>
 * - Test the whole site      -> POST /api/explore, then #/p/:pid/live
 *
 * render() is inlined into the page by its source, so it is self-contained.
 */
import type { Project, ScreenCtx, ScreenModule, SetupState } from "../../contracts.ts";

/** Pure: read what was typed as an address. Exported for tests; render keeps its own copy. */
export function readAddress(raw: string): { url: string; host: string; kind: "local" | "staging" | "production" } | { error: string } {
  let s = raw.trim();
  if (!s) return { error: "Put in a website address." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const hostPart = s.split(/[/?#]/)[0] || "";
    const local = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(hostPart) || /\.(localhost|test)(:\d+)?$/i.test(hostPart);
    s = (local ? "http://" : "https://") + s;
  }
  let u: URL;
  try { u = new URL(s); } catch { return { error: "That doesn't look like a website address." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http and https addresses can be tested." };
  if (u.username || u.password) return { error: "Leave the user name and password out of the address. Add a test account in Settings instead." };
  if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost" && !u.hostname.startsWith("["))) return { error: "That doesn't look like a website address." };
  const h = u.hostname.toLowerCase();
  // Local only for this computer: 127.0.0.1.evil.com or a .local network name is not (the safe
      // mistake is calling a site production, never the other way round).
      const local = h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "[::1]" || h === "0.0.0.0" || /\.(localhost|test)$/.test(h);
  // Staging only from a subdomain label: acme.dev, dev.to and test.com are live sites.
      const staging = !local && h.split(".").slice(0, -2).some((part) => /^(staging|stage|stg|dev|qa|test|preview|sandbox|uat)(-|\d|$)/.test(part));
  u.hash = "";
  // The same rule as the engine's withoutSecrets (cache.ts): a secret-like name or a long token-like value.
      for (const [k, v] of Array.from(u.searchParams)) if (/(^|[-_.])(access|api|apikey|auth|bypass|code|credential|credentials|jwt|key|nonce|otp|pass|passwd|password|pwd|secret|session|sessionid|sid|sig|signature|state|ticket|token)s?($|[-_.])|token|secret|password|apikey|signature|credential|oobcode|^__clerk/i.test(k) || /^(?=.*\d)(?=.*[a-z])[\w~+/=%.-]{20,}$/i.test(v)) u.searchParams.delete(k);
  return { url: u.toString(), host: u.host, kind: local ? "local" : staging ? "staging" : "production" };
}

export const startScreen: ScreenModule = {
  id: "shell-start",
  routes: ["/"],
  css: `
.s1 { max-width: 640px; margin: 24px auto 0; }
.s1 .hero { text-align: center; margin-bottom: 22px; }
.s1 .badge { width: 52px; height: 52px; border-radius: 12px; border: 1px solid var(--line); background: var(--soft); display: inline-flex; align-items: center; justify-content: center; margin-bottom: 14px; }
.s1 .badge .ico { width: 24px; height: 24px; }
.s1 h1 { font-size: 26px; letter-spacing: -0.02em; margin: 0 0 6px; }
.s1 .lede { color: var(--muted); margin: 0; }
.s1 .urlbox { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 0 12px; }
.s1 .urlbox:focus-within { outline: 2px solid color-mix(in srgb, var(--fg) 25%, transparent); outline-offset: 1px; }
.s1 .urlbox input { flex: 1; min-width: 0; border: 0; background: none; padding: 11px 0; font-size: 15px; outline: none; }
.s1 .urlbox .ico { color: var(--muted); }
.s1 .kindline { display: flex; align-items: center; gap: 8px; min-height: 22px; margin-top: 8px; font-size: 12.5px; color: var(--muted); flex-wrap: wrap; }
.s1 .choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
.s1 .choice { position: relative; display: flex; gap: 10px; align-items: flex-start; text-align: left; border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 12px; cursor: pointer; }
.s1 .choice:hover { background: var(--hover); }
.s1 .choice[aria-checked="true"] { border-color: var(--fg); box-shadow: inset 0 0 0 1px var(--fg); }
.s1 .choice:disabled { cursor: default; opacity: .55; }
.s1 .choice:disabled:hover { background: var(--card); }
.s1 .choice .ico { width: 18px; height: 18px; margin-top: 1px; }
.s1 .choice b { display: block; font-size: 14px; }
.s1 .choice span.sub { display: block; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.s1 .extra { margin-top: 12px; }
.s1 .go { display: flex; align-items: center; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.s1 .go .btn.primary { padding: 9px 16px; }
.s1 .checklist { margin-top: 22px; }
.s1 .checklist li { gap: 10px; }
.s1 .checklist .ok { color: var(--pass); }
.s1 .checklist .bad { color: var(--warn); }
.s1 .confirm { margin-top: 14px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warnbg); color: var(--fg); border-radius: 10px; padding: 12px 14px; }
.s1 .confirm ul { margin: 6px 0 10px; padding-left: 18px; color: var(--muted); }
.s1 .projects { margin-top: 22px; }
@media (max-width: 560px) { .s1 { margin-top: 4px; } .s1 .choices { grid-template-columns: minmax(0, 1fr); } .s1 h1 { font-size: 22px; } }
`,
  render(root: HTMLElement, ctx: ScreenCtx) {
    const { el, icon } = ctx.ui;
    let alive = true;

    function readAddr(raw: string): { url: string; host: string; kind: "local" | "staging" | "production" } | { error: string } {
      let s = raw.trim();
      if (!s) return { error: "Put in a website address." };
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        const hostPart = s.split(/[/?#]/)[0] || "";
        const local = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(hostPart) || /\.(localhost|test)(:\d+)?$/i.test(hostPart);
        s = (local ? "http://" : "https://") + s;
      }
      let u: URL;
      try { u = new URL(s); } catch { return { error: "That doesn't look like a website address." }; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http and https addresses can be tested." };
      if (u.username || u.password) return { error: "Leave the user name and password out of the address. Add a test account in Settings instead." };
      if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost" && !u.hostname.startsWith("["))) return { error: "That doesn't look like a website address." };
      const h = u.hostname.toLowerCase();
      // Local only for this computer: 127.0.0.1.evil.com or a .local network name is not (the safe
      // mistake is calling a site production, never the other way round).
      const local = h === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "[::1]" || h === "0.0.0.0" || /\.(localhost|test)$/.test(h);
      // Staging only from a subdomain label: acme.dev, dev.to and test.com are live sites.
      const staging = !local && h.split(".").slice(0, -2).some((part) => /^(staging|stage|stg|dev|qa|test|preview|sandbox|uat)(-|\d|$)/.test(part));
      u.hash = "";
      // The same rule as the engine's withoutSecrets (cache.ts): a secret-like name or a long token-like value.
      for (const [k, v] of Array.from(u.searchParams)) if (/(^|[-_.])(access|api|apikey|auth|bypass|code|credential|credentials|jwt|key|nonce|otp|pass|passwd|password|pwd|secret|session|sessionid|sid|sig|signature|state|ticket|token)s?($|[-_.])|token|secret|password|apikey|signature|credential|oobcode|^__clerk/i.test(k) || /^(?=.*\d)(?=.*[a-z])[\w~+/=%.-]{20,}$/i.test(v)) u.searchParams.delete(k);
      return { url: u.toString(), host: u.host, kind: local ? "local" : staging ? "staging" : "production" };
    }

    const wrap = el("div", "s1");
    const hero = el("div", "hero");
    const badge = el("span", "badge");
    badge.append(icon("folderplus"));
    hero.append(badge, el("h1", null, "What do you want to test?"), el("p", "lede", "Enter a website address and we'll set up the project for you. A local one like localhost:3000 works too."));

    const form = el("form");
    form.autocomplete = "off";
    form.noValidate = true;
    const lab = el("label", "sr", "Website address");
    lab.htmlFor = "s1-url";
    const box = el("div", "urlbox");
    const input = el("input");
    input.id = "s1-url";
    input.type = "text";
    input.inputMode = "url";
    input.spellcheck = false;
    input.placeholder = "acme.com or localhost:3000";
    input.setAttribute("autocapitalize", "off");
    box.append(icon("globe"), input);
    const kindline = el("div", "kindline");
    kindline.setAttribute("aria-live", "polite");

    type Choice = "suggest" | "path" | "whole" | "describe";
    const CHOICES: { id: Choice; ico: string; words: string; sub: string; button: string }[] = [
      { id: "suggest", ico: "sparkle", words: "Suggest tests", sub: "Look at the site and suggest what a visitor would do.", button: "Suggest tests" },
      { id: "path", ico: "route", words: "Test a path", sub: "Test one page or flow, like /checkout.", button: "Test this path" },
      { id: "whole", ico: "globe", words: "Test the whole site", sub: "Explore and find bugs: 12 steps or 15 minutes at most.", button: "Explore the site" },
      { id: "describe", ico: "wand", words: "Describe a test in plain English", sub: "Say what should work; get steps you can edit.", button: "Generate steps" },
    ];
    let choice: Choice = "suggest";
    const choices = el("div", "choices");
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-label", "How to start");
    const choiceBtns: HTMLButtonElement[] = [];
    for (const c of CHOICES) {
      const b = el("button", "choice");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.choice = c.id;
      const t = el("span");
      t.append(el("b", null, c.words), el("span", "sub", c.sub));
      b.append(icon(c.ico), t);
      b.addEventListener("click", () => pick(c.id));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const live = choiceBtns.filter((x) => !x.disabled);
        const i = live.indexOf(b);
        const next = live[(i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : live.length - 1)) % live.length];
        if (next) { pick(next.dataset.choice as Choice); next.focus(); }
      });
      choiceBtns.push(b);
      choices.append(b);
    }

    const extra = el("div", "extra");
    const pathField = el("label", "field");
    const pathInput = el("input");
    pathInput.type = "text";
    pathInput.placeholder = "/checkout";
    pathInput.spellcheck = false;
    pathField.append(el("span", null, "Path or page"), pathInput);
    const goalField = el("label", "field");
    const goalInput = el("textarea");
    goalInput.rows = 3;
    goalInput.maxLength = 500; // the editor (ui-run) and ui-server take 500
    goalInput.placeholder = "A new visitor can search for a product and add it to the cart";
    goalField.append(el("span", null, "What should work?"), goalInput);
    extra.append(pathField, goalField);

    const go = el("div", "go");
    const submit = el("button", "btn primary");
    submit.type = "submit";
    const submitWords = el("span", null, "Suggest tests");
    submit.append(submitWords, icon("arrow"));
    const only = el("button", "btn");
    only.type = "button";
    only.textContent = "Just create the project";
    const busy = el("span", "muted small");
    go.append(submit, only, busy);
    const error = el("div", "error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    error.style.marginTop = "12px";
    const confirmBox = el("div", "confirm");
    confirmBox.hidden = true;

    form.append(lab, box, kindline, choices, extra, go, error, confirmBox);

    const checklist = el("section", "card checklist");
    const clHead = el("div", "cardhead");
    clHead.append(el("h2", null, "Ready to test"));
    const clList = el("ul", "list");
    const loading = el("li");
    loading.append(el("span", "spin"), el("span", "muted", "Checking the AI and the browser…"));
    clList.append(loading);
    checklist.append(clHead, clList);

    const projectsBox = el("section", "card projects");
    projectsBox.hidden = true;

    wrap.append(hero, form, checklist, projectsBox);
    root.append(wrap);

    let setup: SetupState | null = null;
    let projects: Project[] = [];
    let aiReady = true;
    let sending = false;
    let confirmed = false;

    function pick(c: Choice) {
      choice = c;
      for (const b of choiceBtns) {
        const on = b.dataset.choice === c;
        b.setAttribute("aria-checked", String(on));
        b.tabIndex = on ? 0 : -1;
      }
      pathField.hidden = c !== "path";
      goalField.hidden = c !== "describe";
      const def = CHOICES.find((x) => x.id === c);
      submitWords.textContent = def ? def.button : "Create project";
      confirmed = false;
      confirmBox.hidden = true;
      paint();
    }

    function paintKind() {
      kindline.replaceChildren();
      const v = input.value.trim();
      if (!v) return;
      const r = readAddr(v);
      if ("error" in r) return;
      const chip = el("span", "chip " + r.kind, r.kind === "local" ? "Local" : r.kind === "staging" ? "Staging" : "Production");
      kindline.append(chip);
      if (r.kind === "production") kindline.append(el("span", null, "A live site: the tester never buys, posts, sends or deletes there, and doesn't sign up."));
      else if (r.kind === "local") kindline.append(el("span", null, "A site on this computer."));
      else kindline.append(el("span", null, "A test copy of the site."));
    }

    function paint() {
      const needsAi = choice !== null;
      submit.disabled = sending || (needsAi && !aiReady);
      only.disabled = sending;
      for (const b of choiceBtns) {
        b.disabled = !aiReady;
        b.title = aiReady ? "" : "Needs an AI: sign in to Claude Code or Codex first.";
      }
    }

    function paintSetup() {
      clList.replaceChildren();
      if (!setup) {
        const li = el("li");
        li.append(icon("mehc", "bad"), el("span", null, "Couldn't check the AI and the browser. The app may have stopped."));
        clList.append(li);
        return;
      }
      const ai = el("li");
      ai.dataset.check = "ai";
      const aiText = el("div", "stack");
      aiText.append(el("span", "name", setup.ai.ready ? "AI ready" + (setup.ai.via ? ": " + setup.ai.via : "") : "No AI signed in"), el("span", "sub", setup.ai.words));
      ai.append(icon(setup.ai.ready ? "okc" : "mehc", setup.ai.ready ? "ok" : "bad"), aiText);
      const br = el("li");
      br.dataset.check = "browser";
      const brText = el("div", "stack");
      brText.append(el("span", "name", setup.browser.ready ? "Browser ready" : "Browser not ready"), el("span", "sub", setup.browser.words));
      br.append(icon(setup.browser.ready ? "okc" : "mehc", setup.browser.ready ? "ok" : "bad"), brText);
      clList.append(ai, br);
      if (setup.practiceUrl) {
        const li = el("li");
        const t = el("div", "stack");
        t.append(el("span", "name", "New here?"), el("span", "sub", "Try it on a practice shop that runs on this computer."));
        const b = el("button", "btn small", "Try the practice site");
        b.type = "button";
        b.addEventListener("click", () => { input.value = setup && setup.practiceUrl ? setup.practiceUrl : ""; paintKind(); input.focus(); });
        li.append(icon("flask"), t, b);
        clList.append(li);
      }
      if (!setup.ai.ready) {
        const li = el("li");
        li.append(el("div", "note warn", "New tests need an AI. Run `claude` (Claude Code) or `codex` once in a terminal and sign in, then reload this page. Until then you can still create a project and replay saved tests at $0."));
        clList.append(li);
      }
    }

    function paintProjects() {
      projectsBox.replaceChildren();
      projectsBox.hidden = projects.length === 0;
      const head = el("div", "cardhead");
      head.append(el("h2", null, "Your projects"), el("span", "muted small", String(projects.length)));
      const list = el("ul", "list");
      for (const p of projects) {
        const li = el("li", "click");
        const a = el("a", "stack");
        a.href = ctx.router.href("/p/" + encodeURIComponent(p.id) + "/tests");
        a.style.textDecoration = "none";
        a.append(el("span", "name", p.name), el("span", "sub", p.url));
        const env = (p.envs || []).find((e) => e.default) || (p.envs || [])[0];
        li.append(icon("folder"), a);
        if (env) li.append(el("span", "chip " + env.kind, env.kind === "local" ? "Local" : env.kind === "staging" ? "Staging" : "Production"));
        li.addEventListener("click", (e) => { if (e.target !== a) a.click(); });
        list.append(li);
      }
      projectsBox.append(head, list);
    }

    function fail(words: string) {
      error.textContent = words;
      error.hidden = false;
    }

    async function ensureProject(addr: { url: string; host: string; kind: "local" | "staging" | "production" }): Promise<Project | null> {
      const same = projects.find((p) => p.url === addr.url || (p.envs || []).some((e) => e.url === addr.url));
      if (same) return same;
      const r = await ctx.api.call("POST /api/projects", {}, { url: addr.url, kind: addr.kind });
      if (!r.ok) { fail(r.error); return null; }
      dispatchEvent(new CustomEvent("cm:projects-changed"));
      return r.project;
    }

    function showConfirm(): void {
      confirmBox.replaceChildren();
      confirmBox.hidden = false;
      confirmBox.append(el("b", null, "Explore a live site?"));
      const ul = el("ul");
      for (const w of ["It stays on this site's address.", "It never buys, posts, comments, sends or deletes.", "It doesn't sign up or sign in unless you add a test account.", "It never tries to get past a captcha or bot check."]) ul.append(el("li", null, w));
      const row = el("div", "row");
      const yes = el("button", "btn primary small", "Explore the live site");
      yes.type = "button";
      yes.addEventListener("click", () => { confirmed = true; confirmBox.hidden = true; void start(false); });
      const no = el("button", "btn small", "Cancel");
      no.type = "button";
      no.addEventListener("click", () => { confirmBox.hidden = true; });
      row.append(yes, no);
      confirmBox.append(ul, row);
      yes.focus();
    }

    async function start(projectOnly: boolean) {
      error.hidden = true;
      const addr = readAddr(input.value);
      if ("error" in addr) { fail(addr.error); input.focus(); return; }
      if (!projectOnly && choice === "path") {
        const p = pathInput.value.trim();
        if (!p) { fail("Put in the path to test, like /checkout."); pathInput.focus(); return; }
      }
      if (!projectOnly && choice === "describe" && !goalInput.value.trim()) { fail("Say in a sentence what should work."); goalInput.focus(); return; }
      // Explore runs on the project's default environment: when the address is already a project, its
      // stored kind decides, so a production project always asks (the server would refuse otherwise).
      const known = projects.find((p) => p.url === addr.url || (p.envs || []).some((e) => e.url === addr.url));
      const knownEnv = known && ((known.envs || []).find((e) => e.default) || (known.envs || [])[0]);
      const production = addr.kind === "production" || (!!knownEnv && knownEnv.kind === "production");
      if (!projectOnly && choice === "whole" && production && !confirmed) {
        let ask = true;
        const s = await ctx.api.call("GET /api/settings", {});
        if (s.ok && s.settings && s.settings.confirmProduction === false) ask = false;
        if (ask) { showConfirm(); return; }
      }
      sending = true;
      busy.textContent = "Setting up the project…";
      paint();
      try {
        const project = await ensureProject(addr);
        if (!project || !alive) return;
        const base = "/p/" + encodeURIComponent(project.id);
        if (projectOnly) return ctx.router.go(base + "/tests");
        if (choice === "suggest") return ctx.router.go(base + "/tests/new?mode=suggest");
        if (choice === "path") {
          let p = pathInput.value.trim();
          try { const u = new URL(p, addr.url); p = u.pathname + u.search; } catch { /* keep as typed */ }
          return ctx.router.go(base + "/tests/new?mode=path&path=" + encodeURIComponent(p));
        }
        if (choice === "describe") return ctx.router.go(base + "/tests/new?mode=describe&goal=" + encodeURIComponent(goalInput.value.trim()));
        busy.textContent = "Starting the explore run…";
        const r = await ctx.api.call("POST /api/explore", {}, { projectId: project.id, confirmedProduction: production ? confirmed : undefined });
        if (!r.ok) { fail(r.busy ? "A test is running. Wait for it to end, or stop it, then try again." : r.error); return; }
        ctx.router.go(base + "/live");
      } finally {
        sending = false;
        busy.textContent = "";
        if (alive) paint();
      }
    }

    form.addEventListener("submit", (e) => { e.preventDefault(); confirmed = false; void start(false); });
    only.addEventListener("click", () => { void start(true); });
    input.addEventListener("input", () => { error.hidden = true; confirmBox.hidden = true; paintKind(); });

    const q = ctx.router.current().query;
    if (q.get("url")) input.value = q.get("url") || "";
    pick("suggest");
    paintKind();
    input.focus();

    Promise.all([ctx.api.call("GET /api/setup", {}), ctx.api.call("GET /api/projects", {})]).then(([s, p]) => {
      if (!alive) return;
      setup = s.ok ? { ai: s.ai, browser: s.browser, practiceUrl: s.practiceUrl } : null;
      aiReady = !!(setup && setup.ai.ready);
      if (p.ok) projects = p.projects || [];
      paintSetup();
      paintProjects();
      paint();
    });

    return () => { alive = false; };
  },
};
