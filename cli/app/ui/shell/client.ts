/**
 * The app shell's browser runtime: router, API client, live events, UI kit, the left rail and top bar,
 * and the mounting of screen modules. page.ts inlines `shellMain`'s source (Function.prototype.toString)
 * under the page nonce, so this function is self-contained: it uses only its argument and browser
 * globals. Types are erased by Node's type stripping and by the page build, so they cost nothing.
 *
 * Every word from a site, an AI or the data is set as textContent. The only markup set from a string
 * is the page's own icons (boot.icons).
 */
import type { ApiClient, AppRoute, AppVerdict, EventStream, LiveEvent, Project, RouteKey, RunStatus, ScreenCtx, UiKit } from "../../contracts.ts";

/** A screen as the page carries it: its render function, routes and id (css is in the page's <style>). */
export interface BootScreen {
  id: string;
  routes: AppRoute[];
  /** Mounted once at boot into its own root, never cleared (the Set up sign-in pop-up). */
  overlay?: boolean;
  render: (root: HTMLElement, ctx: ScreenCtx) => void | (() => void);
}

export interface Boot {
  token: string;
  icons: Record<string, string>;
  screens: BootScreen[];
  /** Routes in the order they are tried; the shell sorts literal segments before params. */
  routes: AppRoute[];
}

/** Fired on window by a screen that changed a project (name, envs, delete), so the rail refreshes. */
export const PROJECTS_CHANGED = "cm:projects-changed";

export function shellMain(boot: Boot): void {
  const doc = document;
  const TOKEN = boot.token;
  const CHANGED = "cm:projects-changed";

  // ---------------------------------------------------------------------------------------------
  // UI kit: text only, own icons only
  // ---------------------------------------------------------------------------------------------
  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string): HTMLElementTagNameMap[K] {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function icon(name: string, cls?: string): HTMLElement {
    const s = el("span", "ico" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = boot.icons[name] || ""; // our own markup only
    return s;
  }
  const clock = (s: number, fine?: boolean): string => {
    const v = Math.max(0, s || 0);
    const m = Math.floor(v / 60);
    const sec = v - m * 60;
    return m + ":" + (fine ? sec.toFixed(1).padStart(4, "0") : String(Math.floor(sec)).padStart(2, "0"));
  };
  const ago = (iso: string): string => {
    const t = Date.parse(iso);
    if (!isFinite(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    const d = Math.round(h / 24);
    if (d < 30) return d + "d ago";
    return new Date(t).toLocaleDateString();
  };
  const VERDICT: Record<string, string> = { pass: "PASS", fail: "FAIL", blocked: "BLOCKED", not_sure: "NOT SURE", flaky: "FLAKY" };
  const STATUS: Record<string, string> = { queued: "Queued", running: "Running", completed: "Done", cancelled: "Cancelled", error: "Error", interrupted: "Interrupted", skipped_busy: "Skipped (busy)" };
  function pill(v: AppVerdict | RunStatus, o?: { judged?: boolean }): HTMLElement {
    // Own keys only: "toString" or "constructor" from bad data is shown as plain words, never as a verdict.
    const own = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
    const isVerdict = own(VERDICT, String(v));
    const p = el("span", "pill " + (isVerdict ? v : "status"), isVerdict ? VERDICT[v] : own(STATUS, String(v)) ? STATUS[v] : String(v));
    p.dataset.v = String(v);
    if (isVerdict && o && o.judged) p.append(el("span", "judged", "· judged"));
    return p;
  }
  let toasts: HTMLElement | null = null;
  function toast(words: string): void {
    if (!toasts) { toasts = el("div", "toasts"); toasts.setAttribute("role", "status"); doc.body.append(toasts); }
    const t = el("div", "toast", words);
    toasts.append(t);
    setTimeout(() => t.remove(), 3500);
  }
  const ui: UiKit = { el, icon, clock, ago, pill, toast };

  // ---------------------------------------------------------------------------------------------
  // API client: token on every ask, JSON POSTs, never throws on an HTTP error
  // ---------------------------------------------------------------------------------------------
  const api: ApiClient = {
    async call(route, params, body) {
      const sp = String(route).indexOf(" ");
      const method = String(route).slice(0, sp);
      const path = String(route).slice(sp + 1).replace(/:(\w+)/g, (_m: string, k: string) => encodeURIComponent(String((params as Record<string, string>)[k] ?? "")));
      try {
        const init: RequestInit = { method, headers: { "x-cm-token": TOKEN } };
        if (method === "POST") {
          init.headers = { "x-cm-token": TOKEN, "Content-Type": "application/json" };
          init.body = JSON.stringify(body === undefined ? {} : body);
        }
        const res = await fetch(path, init);
        const text = await res.text();
        let j: unknown;
        try { j = JSON.parse(text); } catch { j = null; }
        if (j && typeof j === "object" && "ok" in (j as object)) return j as never;
        return { ok: false, error: res.ok ? "The app sent back something it shouldn't." : "The app said " + res.status + "." } as never;
      } catch {
        return { ok: false, error: "Couldn't reach the app. Is `contextmachines ui` still running?" } as never;
      }
    },
    fileUrl(runId, name) {
      return "/files/" + encodeURIComponent(TOKEN) + "/" + encodeURIComponent(runId) + "/" + encodeURIComponent(name);
    },
  };
  const call = <K extends RouteKey>(route: K, params: object, body?: unknown) => api.call(route, params as never, body as never);

  // ---------------------------------------------------------------------------------------------
  // Router: hash routes, literal segments win over params, then the order given (run lane first)
  // ---------------------------------------------------------------------------------------------
  const patterns = boot.routes.slice().sort((a, b) => score(b) - score(a));
  function score(p: string): number {
    return p.split("/").reduce((n, s) => n + (s === "" ? 0 : s.startsWith(":") ? 1 : 3), 0);
  }
  function parse(): { route: AppRoute | null; params: Record<string, string>; query: URLSearchParams; path: string } {
    const raw = location.hash.replace(/^#/, "") || "/";
    const qi = raw.indexOf("?");
    const path = (qi >= 0 ? raw.slice(0, qi) : raw) || "/";
    const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    const segs = path.split("/").filter(Boolean);
    for (const p of patterns) {
      const ps = p.split("/").filter(Boolean);
      if (ps.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < ps.length; i++) {
        const want = ps[i] as string;
        const got = segs[i] as string;
        if (want.startsWith(":")) {
          try { params[want.slice(1)] = decodeURIComponent(got); } catch { ok = false; break; }
        } else if (want !== got) { ok = false; break; }
      }
      if (ok) return { route: p, params, query, path };
    }
    return { route: null, params: {}, query, path };
  }
  const listeners = new Set<() => void>();
  const router = {
    current() {
      const c = parse();
      return { route: (c.route || "/") as AppRoute, params: c.params, query: c.query };
    },
    go(path: string) {
      const h = "#" + (path.startsWith("/") ? path : "/" + path);
      if (location.hash === h) { for (const f of listeners) f(); } else location.hash = h;
    },
    href(path: string) { return "#" + (path.startsWith("/") ? path : "/" + path); },
    onChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  addEventListener("hashchange", () => { for (const f of Array.from(listeners)) f(); });

  // ---------------------------------------------------------------------------------------------
  // Live events (/events, SSE). The server replays its log on connect; ids already seen are kept.
  // ---------------------------------------------------------------------------------------------
  const seen: LiveEvent[] = [];
  /** Frames (base64 JPEGs) are not kept in the history: only each test's latest, as the server keeps them. */
  const lastFrames = new Map<string, LiveEvent>();
  const subs = new Map<string, Set<(e: never) => void>>();
  let isConnected = false;
  const events: EventStream = {
    on(type, fn) {
      let s = subs.get(type);
      if (!s) { s = new Set(); subs.set(type, s); }
      s.add(fn as (e: never) => void);
      return () => { s && s.delete(fn as (e: never) => void); };
    },
    history() { return lastFrames.size ? seen.concat(Array.from(lastFrames.values())) : seen; },
    connected() { return isConnected; },
  };
  function dispatch(e: LiveEvent) {
    if (e.type === "frame") lastFrames.set(String((e as { id?: unknown }).id), e);
    else seen.push(e);
    if (seen.length > 5000) seen.splice(0, seen.length - 5000);
    const s = subs.get(e.type);
    if (s) for (const f of Array.from(s)) { try { f(e as never); } catch (err) { console.error(err); } }
  }
  let firstOpen = true;
  function connect() {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/events?t=" + encodeURIComponent(TOKEN));
    es.onopen = () => {
      isConnected = true;
      // A reconnect replays the server's log: start the history again so nothing doubles.
      if (!firstOpen) { seen.length = 0; lastFrames.clear(); }
      firstOpen = false;
      setConn();
    };
    es.onerror = () => { isConnected = false; setConn(); };
    es.onmessage = (m) => {
      let e: LiveEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e && typeof e.type === "string") dispatch(e);
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The frame: rail, top bar, content
  // ---------------------------------------------------------------------------------------------
  const app = el("div", "app bare");
  const rail = el("nav", "rail");
  rail.setAttribute("aria-label", "Project");
  const main = el("div", "main");
  const top = el("header", "top");
  const content = el("main", "content");
  content.id = "content";
  content.tabIndex = -1;
  main.append(top, content);
  app.append(rail, main);
  doc.body.append(app);

  const menuBtn = el("button", "iconbtn menu");
  menuBtn.type = "button";
  menuBtn.setAttribute("aria-label", "Menu");
  menuBtn.append(icon("menu"));
  let scrim: HTMLElement | null = null;
  function setDrawer(open: boolean) {
    app.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    if (open && !scrim) { scrim = el("div", "scrim"); scrim.addEventListener("click", () => setDrawer(false)); app.append(scrim); }
    if (!open && scrim) { scrim.remove(); scrim = null; }
  }
  menuBtn.addEventListener("click", () => setDrawer(!app.classList.contains("open")));

  const conn = el("span", "conn", "Reconnecting…");
  conn.hidden = true;
  let hadConnection = false;
  function setConn() {
    if (isConnected) hadConnection = true;
    conn.hidden = isConnected || !hadConnection;
  }

  let projects: Project[] = [];
  let projectsLoaded = false;
  let running: string | null = null;
  let runningProject: string | null = null;
  let openIssues: Record<string, number> = {};

  async function loadProjects() {
    const r = await call("GET /api/projects", {});
    if (r.ok) projects = (r as { projects: Project[] }).projects || [];
    projectsLoaded = true;
  }
  async function loadIssueCount(pid: string) {
    const r = await call("GET /api/projects/:id/issues", { id: pid });
    if (r.ok) {
      const counts = (r as { counts?: Record<string, number> }).counts;
      openIssues[pid] = counts && typeof counts.open === "number" ? counts.open : 0;
      paintCount();
    }
  }

  /** Only the Issues badge: the rest of the rail (and the picker the person may be using) stays put. */
  function paintCount() {
    const pid = parse().params.pid;
    const a = rail.querySelector('a[data-nav="issues"]');
    if (!pid || !a) return;
    const old = a.querySelector(".count");
    if (old) old.remove();
    const n = openIssues[pid] || 0;
    if (!n) return;
    const b = el("span", "count", String(n));
    b.setAttribute("aria-label", n + " open");
    a.append(b);
  }

  const NAV: { key: string; words: string; ico: string; path: string }[] = [
    { key: "tests", words: "Tests", ico: "flask", path: "tests" },
    { key: "runs", words: "Runs", ico: "history", path: "runs" },
    { key: "issues", words: "Issues", ico: "bug", path: "issues" },
    { key: "accounts", words: "Accounts", ico: "key", path: "accounts" },
    { key: "settings", words: "Settings", ico: "gear", path: "settings" },
  ];

  function paintRail() {
    const c = parse();
    const pid = c.params.pid;
    rail.replaceChildren();
    if (!pid) return;
    const brand = el("a", "brand");
    brand.href = "#/";
    brand.append(el("span", "logo"), el("span", null, "Context Machines"));
    const pick = el("label", "picker");
    const sel = el("select");
    sel.setAttribute("aria-label", "Project");
    for (const p of projects) {
      const o = el("option", null, p.name);
      o.value = p.id;
      if (p.id === pid) o.selected = true;
      sel.append(o);
    }
    if (!projects.some((p) => p.id === pid)) {
      const o = el("option", null, "Unknown project");
      o.value = pid;
      o.selected = true;
      sel.append(o);
    }
    const add = el("option", null, "+ New project");
    add.value = "";
    sel.append(add);
    sel.addEventListener("change", () => {
      setDrawer(false);
      if (!sel.value) return router.go("/");
      const section = (c.route || "").split("/")[3] || "tests";
      const keep = NAV.some((n) => n.path === section) ? section : "tests";
      router.go("/p/" + encodeURIComponent(sel.value) + "/" + keep);
    });
    pick.append(icon("folder"), sel, icon("chev"));
    const nav = el("div", "nav");
    const here = (c.route || "").split("/")[3] || "";
    for (const n of NAV) {
      const a = el("a");
      a.href = router.href("/p/" + encodeURIComponent(pid) + "/" + n.path);
      a.append(icon(n.ico), el("span", null, n.words));
      a.dataset.nav = n.key;
      if (here === n.path) a.setAttribute("aria-current", "page");
      if (n.key === "issues" && openIssues[pid]) {
        const b = el("span", "count", String(openIssues[pid]));
        b.setAttribute("aria-label", openIssues[pid] + " open");
        a.append(b);
      }
      a.addEventListener("click", () => setDrawer(false));
      nav.append(a);
    }
    const foot = el("div", "foot", "Local only · 127.0.0.1");
    rail.append(brand, pick, nav, foot);
  }

  function paintTop(project: Project | undefined) {
    top.replaceChildren();
    const c = parse();
    if (!c.params.pid) {
      const brand = el("a", "brand");
      brand.href = "#/";
      brand.append(el("span", "logo"), el("span", null, "Context Machines"));
      top.append(brand, el("span", "grow"), conn, runningChip(undefined));
      return;
    }
    const where = el("div", "where");
    if (project) {
      const env = (project.envs || []).find((e) => e.default) || (project.envs || [])[0];
      const url = el("span", "url", env ? env.url : project.url);
      url.title = env ? env.url : project.url;
      where.append(el("b", null, project.name));
      if (env) {
        const chip = el("span", "chip " + env.kind, env.kind === "local" ? "Local" : env.kind === "staging" ? "Staging" : "Production");
        chip.title = env.name;
        where.append(chip);
      }
      where.append(url);
    }
    top.append(menuBtn, where, el("span", "grow"), conn, runningChip(project));
  }

  function runningChip(project: Project | undefined): HTMLElement {
    const a = el("a", "chip running");
    a.hidden = !running;
    a.append(el("span", "dot"), el("span", null, "Running"));
    const pid = runningProject || (project && project.id);
    a.href = pid ? router.href("/p/" + encodeURIComponent(pid) + "/live") : "#/";
    a.title = running ? "A test is running: go back to it" : "";
    a.id = "running";
    return a;
  }
  function paintRunning() {
    const chip = doc.getElementById("running");
    if (!chip) return;
    chip.hidden = !running;
    const pid = runningProject || parse().params.pid;
    if (pid) (chip as HTMLAnchorElement).href = router.href("/p/" + encodeURIComponent(pid) + "/live");
  }
  events.on("busy", (e) => { running = e.busy; if (!running) runningProject = null; paintRunning(); });
  // ui-server ends its replay with the busy state now: the log may have been trimmed, this is the truth.
  events.on("replayed", (e) => { running = e.busy; if (!running) runningProject = null; paintRunning(); });
  events.on("job", () => { running = running || "run"; if (!runningProject) runningProject = parse().params.pid || null; paintRunning(); });
  events.on("jobEnd", () => { running = null; runningProject = null; paintRunning(); });
  events.on("run", (e) => { if (e.summary && e.summary.projectId) loadIssueCount(e.summary.projectId); });
  events.on("issues", (e) => { if (e.projectId) loadIssueCount(e.projectId); });

  // ---------------------------------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------------------------------
  let cleanup: (() => void) | null = null;
  let mountSeq = 0;
  let lastPid: string | undefined;
  const narrowQuery = matchMedia("(max-width: 767px)");

  function screenFor(route: AppRoute | null): BootScreen | undefined {
    if (!route) return undefined;
    return boot.screens.find((s) => !s.overlay && s.routes.indexOf(route) >= 0);
  }

  function notBuilt(root: HTMLElement, words: string, sub: string) {
    const card = el("div", "card");
    const e = el("div", "empty");
    e.append(el("b", null, words), el("span", null, sub));
    card.append(e);
    root.append(card);
  }

  async function mount() {
    const seq = ++mountSeq;
    if (cleanup) { try { cleanup(); } catch (err) { console.error(err); } cleanup = null; }
    const c = parse();
    const pid = c.params.pid;
    app.classList.toggle("bare", !pid);
    setDrawer(false);
    if (!projectsLoaded || (pid && !projects.some((p) => p.id === pid)) || pid !== lastPid) await loadProjects();
    if (seq !== mountSeq) return;
    if (pid && pid !== lastPid) loadIssueCount(pid);
    lastPid = pid;
    const project = pid ? projects.find((p) => p.id === pid) : undefined;
    overlayCtx.params = c.params;
    overlayCtx.project = project;
    overlayCtx.narrow = narrowQuery.matches;
    paintRail();
    paintTop(project);
    content.replaceChildren();
    const root = el("div", "screen");
    content.append(root);
    if (!c.route) {
      notBuilt(root, "Not found", "There's no page at this address. Go to the start to pick a project.");
      const b = el("a", "btn", "Go to the start");
      b.href = "#/";
      root.append(b);
      return;
    }
    if (pid && !project) {
      notBuilt(root, "Project not found", "It may have been deleted. Pick another from the start screen.");
      const b = el("a", "btn", "Go to the start");
      b.href = "#/";
      root.append(b);
      return;
    }
    const s = screenFor(c.route);
    document.title = (project ? project.name + " · " : "") + "Context Machines";
    if (!s) {
      notBuilt(root, "Coming soon", "This screen isn't in this build yet.");
      return;
    }
    root.dataset.screen = s.id;
    const ctx: ScreenCtx = { api, router, events, ui, params: c.params, project, narrow: narrowQuery.matches };
    try {
      const done = s.render(root, ctx);
      cleanup = typeof done === "function" ? done : null;
    } catch (err) {
      console.error(err);
      root.replaceChildren(el("div", "error", "This screen hit a problem: " + String((err && (err as Error).message) || err)));
    }
  }

  // Overlays (the Set up sign-in pop-up): mounted once, each into its own root that is never cleared. Their
  // ctx is one object whose params, project and narrow follow the route.
  const overlayCtx: ScreenCtx = { api, router, events, ui, params: {}, project: undefined, narrow: narrowQuery.matches };
  function mountOverlays() {
    for (const s of boot.screens) {
      if (!s.overlay) continue;
      const r = el("div", "overlay-root");
      r.dataset.overlay = s.id;
      doc.body.append(r);
      try { s.render(r, overlayCtx); } catch (err) { console.error(err); }
    }
  }

  addEventListener(CHANGED, () => { projectsLoaded = false; loadProjects().then(() => { const c = parse(); paintRail(); paintTop(projects.find((p) => p.id === c.params.pid)); }); });
  router.onChange(() => { void mount(); content.focus({ preventScroll: true }); scrollTo(0, 0); });
  overlayCtx.params = parse().params;
  mountOverlays();
  connect();
  void mount();
}
