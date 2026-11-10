/**
 * The inspector: lists every request the snippet sends, as it leaves the browser, so a developer
 * can check the exact bytes instead of trusting us. It sees what is handed to fetch/sendBeacon
 * (see index.ts), sends nothing itself, and is ignored by capture like the rest of our UI.
 * Rendered in a shadow root; all text via textContent (never innerHTML).
 */

export interface SentRequest {
  method: string;
  url: string;
  /** "beacon" when sent with navigator.sendBeacon as the page was hidden or closing. */
  via: "fetch" | "beacon";
  /** The request body exactly as sent, or undefined when there was none (a GET). */
  body: string | undefined;
}

/** On when init passes inspect: true, or (unless init passes inspect: false) the page address has ?ctx-inspect. */
export function inspectRequested(win: Window, option: boolean | undefined): boolean {
  return option ?? quiet(() => new URLSearchParams(win.location.search).has("ctx-inspect")) ?? false;
}

/**
 * Like run() in safe.ts, but its failures are not counted: the error count goes out in the next
 * batch, and turning the inspector on must not change a single byte of what is sent.
 */
export function quiet<R>(fn: () => R): R | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const KEEP = 200;

const STYLE = `
:host { all: initial; }
.panel { position: fixed; right: 16px; top: 16px; z-index: 2147483647; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); box-sizing: border-box; display: flex; flex-direction: column;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: #fff; color: #1a1a1a; border: 1px solid #d8d8de; border-left: 4px solid #6b5bd6; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
.head { padding: 10px 12px; border-bottom: 1px solid #e4e4ea; }
.title { font-weight: 600; font-size: 14px; margin: 0; }
.note, .total { margin: 4px 0 0; color: #555; }
.total { color: #1a1a1a; font-weight: 600; }
.actions { display: flex; gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
.list { overflow: auto; padding: 4px 12px 10px; }
.list[hidden] { display: none; }
.item { border-bottom: 1px solid #ececf0; padding: 6px 0; }
summary { cursor: pointer; }
.meta { font-variant-numeric: tabular-nums; color: #555; }
.what { display: block; margin-left: 16px; }
.url { margin: 6px 0 0; color: #555; word-break: break-all; }
pre { margin: 6px 0 0; padding: 8px; background: #f6f6f8; border-radius: 6px; overflow: auto; max-height: 320px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #c9c9d1; background: #f6f6f8; color: #1a1a1a; cursor: pointer; }
button:focus-visible, summary:focus-visible { outline: 2px solid #6b5bd6; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1e1f24; color: #ececf1; border-color: #3a3b44; } .head, .item { border-color: #3a3b44; }
  .note, .meta, .url { color: #b5b6c0; } .total { color: #ececf1; } pre { background: #2a2b31; }
  button { background: #2a2b31; color: #ececf1; border-color: #45464f; }
}`;

export class Inspector {
  private readonly doc: Document;
  private readonly host: HTMLElement;
  private readonly list: HTMLElement;
  private readonly total: HTMLElement;
  private readonly status: HTMLElement;
  private readonly sent: { at: string; req: SentRequest; bytes: number }[] = [];
  private count = 0;
  private bytes = 0;

  constructor(doc: Document) {
    this.doc = doc;
    this.host = doc.createElement("div");
    this.host.setAttribute("data-ctx-inspect", "");
    const root = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLE;

    const panel = this.el("div", "panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Context layer inspector");
    const head = this.el("div", "head");
    this.total = this.el("p", "total");
    this.status = this.el("span", "note");
    this.status.setAttribute("aria-live", "polite");
    this.list = this.el("div", "list");
    const actions = this.el("div", "actions");
    const toggle = this.button("Hide", () => {
      this.list.hidden = !this.list.hidden;
      toggle.textContent = this.list.hidden ? "Show" : "Hide";
    });
    actions.append(this.button("Copy all", () => this.copyAll()), toggle, this.status);
    head.append(
      this.el("p", "title", "Context layer: everything this page sends"),
      this.el("p", "note", "Each request body below is exactly what left this browser, captured as it was sent. This panel sends nothing itself."),
      this.total,
      actions,
    );
    panel.append(head, this.list);
    root.append(style, panel);
    this.renderTotal();
    (doc.body ?? doc.documentElement).append(this.host);
  }

  get element(): HTMLElement {
    return this.host;
  }

  /** Called with each request as it is handed to the browser. */
  record(req: SentRequest): void {
    const bytes = req.body === undefined ? 0 : new TextEncoder().encode(req.body).length;
    const at = new Date().toLocaleTimeString();
    this.count++;
    this.bytes += bytes;
    this.sent.push({ at, req, bytes });
    if (this.sent.length > KEEP) this.sent.shift();
    this.renderTotal();

    const item = this.el("details", "item");
    const summary = this.el("summary");
    const via = req.via === "beacon" ? " · sendBeacon (page closing)" : "";
    summary.append(this.el("span", "meta", `${at} · ${req.method} · ${formatBytes(bytes)}${via}`), this.el("span", "what", describe(req)));
    item.append(summary, this.el("p", "url", req.url), this.el("pre", "", pretty(req.body)));
    this.list.prepend(item); // newest first
    while (this.list.childElementCount > KEEP) this.list.lastElementChild?.remove();
  }

  destroy(): void {
    this.host.remove();
  }

  private renderTotal(): void {
    const kept = this.count > KEEP ? ` (showing the latest ${KEEP})` : "";
    this.total.textContent = `${plural(this.count, "request", "requests")} sent, ${formatBytes(this.bytes)} in total${kept}`;
  }

  private copyAll(): void {
    // Oldest first, each body byte for byte as sent.
    const text = this.sent.map(({ at, req, bytes }) => `// ${at} ${req.method} ${req.url} (${formatBytes(bytes)}, ${req.via})\n${req.body ?? "(no body)"}\n`).join("\n");
    const done = (ok: boolean) => (this.status.textContent = ok ? `Copied ${plural(this.sent.length, "request", "requests")}` : "Copy failed: select the text in a request instead");
    const clipboard = this.doc.defaultView?.navigator.clipboard;
    if (clipboard) void clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  }

  private el(tag: string, className = "", text?: string): HTMLElement {
    const e = this.doc.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = this.el("button", "", label) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => quiet(onClick));
    return b;
  }
}

const KINDS: Record<string, [string, string]> = {
  click: ["click", "clicks"],
  submit: ["form submit", "form submits"],
  network: ["request (shape only)", "requests (shapes only)"],
  page: ["page snapshot", "page snapshots"],
  route: ["page view", "page views"],
  struggle: ["struggle signal", "struggle signals"],
  decision: ["rule result", "rule results"],
  feedback: ["prompt response", "prompt responses"],
  guidance: ["guidance response", "guidance responses"],
};

/** One plain-English line: "4 clicks, 2 requests (shapes only), 1 page snapshot". */
export function describe(req: SentRequest): string {
  if (req.body === undefined) return req.method === "GET" ? "Settings fetch: sends your publishable key only, no page data" : "No body";
  const data = quiet(() => JSON.parse(req.body as string) as { events?: { kind?: string; type?: string }[]; final?: boolean; context?: { action?: { id?: string } } });
  if (Array.isArray(data?.events)) {
    const counts = new Map<string, number>();
    for (const e of data.events) {
      const k = (e.kind === "interaction" ? e.type : e.kind) ?? "other";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const parts = [...counts].map(([k, n]) => plural(n, ...(KINDS[k] ?? [`${k} event`, `${k} events`])));
    return (parts.join(", ") || "No events") + (data.final ? " (sent as the page was hidden or closed)" : "");
  }
  if (data?.context) return `Rule check for "${data.context.action?.id ?? "?"}" (field shapes only)`;
  return "Request";
}

function pretty(body: string | undefined): string {
  if (body === undefined) return "(no body)";
  return quiet(() => JSON.stringify(JSON.parse(body), null, 2)) ?? body;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const formatBytes = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "byte" : "bytes"}`;
