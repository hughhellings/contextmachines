import { run } from "./safe.ts";

/**
 * The on-screen prompt. Rendered in a shadow root so host-page CSS can't
 * break it and its CSS can't leak into the host page. All text is set with textContent
 * (never innerHTML): messages come from rules and models, so they are untrusted.
 */

export type Feedback = "dismissed" | "helpful" | "not_helpful" | "fixed";

export interface PromptOutcome {
  ruleId: string;
  ruleVersion: number;
  effectiveAction: "nudge" | "fix" | "block";
  message: string;
  reason?: string;
}

export interface PromptOptions {
  onFeedback: (outcome: PromptOutcome, feedback: Feedback) => void;
  /** Present when the site can apply a fix; shows a "Fix it" button on fix-level rules. */
  onFix?: (outcome: PromptOutcome) => void | Promise<void>;
  autoHideMs?: number;
  /** Same rule won't be shown again within this window. */
  dedupeMs?: number;
  maxVisible?: number;
  clock?: () => number;
}

const STYLE = `
:host { all: initial; }
.stack { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; max-width: min(380px, calc(100vw - 32px)); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.card { background: #fff; color: #1a1a1a; border: 1px solid #d8d8de; border-left: 4px solid #3b6cf6; border-radius: 10px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
.card.block { border-left-color: #d93a3a; }
.title { font-weight: 600; margin: 0 0 4px; }
.reason { margin: 6px 0 0; color: #555; font-size: 13px; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid #c9c9d1; background: #f6f6f8; color: #1a1a1a; cursor: pointer; }
button.primary { background: #3b6cf6; border-color: #3b6cf6; color: #fff; }
button:focus-visible { outline: 2px solid #3b6cf6; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .card { background: #1e1f24; color: #ececf1; border-color: #3a3b44; }
  .reason { color: #b5b6c0; }
  button { background: #2a2b31; color: #ececf1; border-color: #45464f; }
}`;

export class Prompter {
  private readonly root: ShadowRoot;
  private readonly host: HTMLElement;
  private readonly stack: HTMLElement;
  private readonly lastShown = new Map<string, number>();
  private readonly opts: PromptOptions;
  private readonly doc: Document;

  constructor(doc: Document, opts: PromptOptions) {
    this.doc = doc;
    this.opts = opts;
    this.host = doc.createElement("div");
    this.host.setAttribute("data-ctx-prompt", "");
    this.root = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.stack = doc.createElement("div");
    this.stack.className = "stack";
    this.root.append(style, this.stack);
    (doc.body ?? doc.documentElement).append(this.host);
  }

  /** The element hosting the UI, so interaction capture can ignore clicks inside it. */
  get element(): HTMLElement {
    return this.host;
  }

  get visibleCount(): number {
    return this.stack.childElementCount;
  }

  show(outcome: PromptOutcome): void {
    const now = (this.opts.clock ?? Date.now)();
    const last = this.lastShown.get(outcome.ruleId);
    if (last !== undefined && now - last < (this.opts.dedupeMs ?? 30_000)) return;
    this.lastShown.set(outcome.ruleId, now);
    while (this.stack.childElementCount >= (this.opts.maxVisible ?? 3)) this.stack.firstElementChild?.remove();

    const d = this.doc;
    const card = d.createElement("div");
    card.className = `card ${outcome.effectiveAction}`;
    card.setAttribute("role", outcome.effectiveAction === "block" ? "alertdialog" : "status");
    card.setAttribute("aria-live", outcome.effectiveAction === "block" ? "assertive" : "polite");
    card.setAttribute("data-rule", outcome.ruleId);

    const title = d.createElement("p");
    title.className = "title";
    title.textContent = outcome.message;
    card.append(title);

    let reason: HTMLElement | undefined;
    if (outcome.reason) {
      reason = d.createElement("p");
      reason.className = "reason";
      reason.textContent = outcome.reason;
      reason.hidden = true;
      card.append(reason);
    }

    const actions = d.createElement("div");
    actions.className = "actions";
    let settled = false;
    const close = (feedback: Feedback) => {
      if (settled) return;
      settled = true;
      card.remove();
      run(() => this.opts.onFeedback(outcome, feedback));
    };

    if (outcome.effectiveAction === "fix" && this.opts.onFix) {
      actions.append(button(d, "Fix it", "primary", () => {
        void Promise.resolve(run(() => this.opts.onFix?.(outcome))).finally(() => close("fixed"));
      }));
    }
    actions.append(button(d, "Got it", outcome.effectiveAction === "fix" && this.opts.onFix ? "" : "primary", () => close("helpful")));
    if (reason) {
      const r = reason;
      actions.append(button(d, "Why?", "", () => {
        r.hidden = !r.hidden;
      }));
    }
    actions.append(button(d, "Not relevant", "", () => close("not_helpful")));
    card.append(actions);
    card.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") close("dismissed");
    });

    this.stack.append(card);
    if (outcome.effectiveAction !== "block") {
      const ms = this.opts.autoHideMs ?? 15_000;
      setTimeout(() => close("dismissed"), ms);
    } else {
      (actions.querySelector("button") as HTMLButtonElement | null)?.focus();
    }
  }

  destroy(): void {
    this.host.remove();
  }
}

function button(d: Document, label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = d.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run(onClick);
  });
  return b;
}
