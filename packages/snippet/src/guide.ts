import type { Delivery } from "@contextmachines/schemas";
import { findControlByLabel, findFieldByLabel } from "./page.ts";
import { run } from "./safe.ts";

/**
 * Shows a delivered guidance suggestion at the level the server chose:
 *   tell  a card with the message (and "Why?")
 *   show  the card plus the steps, and "Show me" highlights the real button
 *   do    "Take me there" (navigation) or "Do it for me" (one safe press, after
 *         the user confirms)
 * One suggestion at a time. All text via textContent. Every outcome is
 * reported: shown, did_it, dismissed, not_relevant, element_missing.
 */

export type GuideValue = "shown" | "did_it" | "dismissed" | "not_relevant" | "element_missing";

export interface GuideOptions {
  report: (delivery: Delivery, value: GuideValue) => void;
  /** Current page path (normalised), to know whether a step is on this page. */
  currentPath: () => string | undefined;
  navigate: (path: string) => void;
  /**
   * Whether navigate() can reach a page. Pages for one record ("/book/:id") have no
   * address we know (record ids are never kept), so they are reachable only by going back.
   */
  canNavigate?: (path: string) => boolean;
  /** How long a highlight stays (ms). */
  highlightMs?: number;
}

const STYLE = `
:host { all: initial; }
.card { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; width: min(360px, calc(100vw - 32px)); box-sizing: border-box;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: #fff; color: #1a1a1a; border: 1px solid #d8d8de;
  border-left: 4px solid #1f9d6b; border-radius: 10px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
.card.right { left: auto; right: 16px; }
.title { font-weight: 600; margin: 0 0 6px; }
.why { margin: 4px 0 0; color: #555; font-size: 13px; }
ol { margin: 8px 0 0; padding-left: 20px; font-size: 13px; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 6px; border: 1px solid #c9c9d1; background: #f6f6f8; color: #1a1a1a; cursor: pointer; }
button.primary { background: #1f9d6b; border-color: #1f9d6b; color: #fff; }
button:focus-visible { outline: 2px solid #1f9d6b; outline-offset: 2px; }
.ring { position: fixed; z-index: 2147483645; pointer-events: none; border: 3px solid #1f9d6b; border-radius: 8px; box-shadow: 0 0 0 4px rgba(31,157,107,.25); }
.tip { position: fixed; z-index: 2147483646; pointer-events: none; background: #1f9d6b; color: #fff; font: 600 12px/1.3 system-ui, sans-serif; padding: 4px 8px; border-radius: 6px; }
@media (prefers-color-scheme: dark) { .card { background: #1e1f24; color: #ececf1; border-color: #3a3b44; } .why { color: #b5b6c0; } button { background: #2a2b31; color: #ececf1; border-color: #45464f; } }
@media (prefers-reduced-motion: no-preference) { .ring { transition: all .15s ease; } }`;

export class Guide {
  private readonly doc: Document;
  private readonly opts: GuideOptions;
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private current: Delivery | undefined;
  private cleanupHighlight: (() => void) | undefined;

  constructor(doc: Document, opts: GuideOptions) {
    this.doc = doc;
    this.opts = opts;
    this.host = doc.createElement("div");
    this.host.setAttribute("data-ctx-guide", "");
    this.root = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
    (doc.body ?? doc.documentElement).append(this.host);
  }

  get element(): HTMLElement {
    return this.host;
  }

  get showing(): string | undefined {
    return this.current?.suggestionId;
  }

  present(d: Delivery): void {
    if (this.current) return; // one at a time
    this.current = d;
    const card = this.el("div", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Suggestion");
    card.append(this.text("p", "title", d.message));

    if (d.why) {
      const why = this.text("p", "why", d.why);
      why.hidden = true;
      card.append(why);
      this.actionsLater.push(this.button("Why?", "", () => (why.hidden = !why.hidden)));
    }
    if (d.level !== "tell" && d.steps.length > 0) {
      const list = this.el("ol");
      for (const step of d.steps) list.append(this.text("li", "", describe(step)));
      card.append(list);
    }

    const actions = this.el("div", "actions");
    const here = this.opts.currentPath();
    const pressHere = d.steps.find((s) => s.type === "press" && (!s.page || s.page === here));
    const firstGo = d.steps.find((s) => s.type === "go" && s.page !== here);

    if (d.level === "do" && d.doStep?.type === "press") {
      const label = d.doStep.label;
      let armed = false;
      const doIt = this.button("Do it for me", "primary", () => {
        if (!armed) {
          armed = true;
          doIt.textContent = `Confirm: press "${label}"`;
          return;
        }
        const target = findControlByLabel(this.doc, label);
        if (!target) return this.finish("element_missing");
        this.finish("did_it");
        target.click();
      });
      actions.append(doIt);
    } else if (((d.level === "do" && d.doStep?.type === "go") || (d.level === "show" && firstGo?.type === "go")) && this.opts.canNavigate?.(d.doStep?.type === "go" ? d.doStep.page : (firstGo as { page: string }).page) !== false) {
      const page = d.doStep?.type === "go" ? d.doStep.page : (firstGo as { page: string }).page;
      actions.append(this.button("Take me there", "primary", () => {
        this.finish("did_it");
        this.opts.navigate(page);
      }));
    }
    const fillHere = d.steps.find((s) => s.type === "fill" && (!s.page || s.page === here) && s.fields.length > 0);
    if (d.level === "show" && fillHere?.type === "fill" && fillHere.fields.length === 1) {
      // One field to fill: point at it, not at the button.
      const field = fillHere.fields[0] as string;
      actions.append(this.button("Show me", !firstGo ? "primary" : "", () => {
        if (!this.highlight(field, "field")) this.report("element_missing");
      }));
    } else if (d.level === "show" && pressHere?.type === "press") {
      actions.append(this.button("Show me", d.level === "show" && !firstGo ? "primary" : "", () => {
        if (!this.highlight(pressHere.label)) this.report("element_missing");
      }));
    }
    for (const b of this.actionsLater.splice(0)) actions.append(b);
    actions.append(this.button("Not now", "", () => this.finish("dismissed")));
    actions.append(this.button("Not relevant", "", () => this.finish("not_relevant")));
    card.append(actions);
    card.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.finish("dismissed");
    });
    this.root.append(card);
    this.avoidCovering(card);
    this.report("shown");
  }

  /**
   * The user moved to another page. Help about the page they left would be in
   * the way, so it closes quietly (no dismissal is recorded: they didn't
   * reject it). Help whose steps lead to this page stays.
   */
  pageChanged(path: string): void {
    const d = this.current;
    if (!d) return;
    if (d.steps.some((s) => s.page === path)) {
      // Staying for this page: re-check, once it has rendered, that it isn't covering what it points to.
      const card = this.root.querySelector<HTMLElement>(".card");
      if (card) setTimeout(() => this.avoidCovering(card), 300);
      return;
    }
    this.current = undefined;
    this.cleanupHighlight?.();
    this.root.querySelector(".card")?.remove();
  }

  /** Never sit on top of a button or field the user needs: move to the other corner if that one is clear. */
  private avoidCovering(card: HTMLElement): void {
    run(() => {
      const controls = [...this.doc.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button]")].slice(0, 300);
      const covers = () => {
        const a = card.getBoundingClientRect();
        return controls.some((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        });
      };
      card.classList.remove("right");
      if (!covers()) return;
      card.classList.add("right");
      if (covers()) card.classList.remove("right"); // both corners busy: stay where people expect it
    });
  }

  /** Outlines the real control and labels it; follows scroll/resize; ends when it's pressed or after a while. */
  highlight(label: string, kind: "control" | "field" = "control"): boolean {
    const target = kind === "field" ? findFieldByLabel(this.doc, label) : findControlByLabel(this.doc, label);
    if (!target) return false;
    this.cleanupHighlight?.();
    target.scrollIntoView?.({ block: "center", behavior: "smooth" });
    const ring = this.el("div", "ring");
    const tip = this.text("div", "tip", kind === "field" ? `Fill in "${label.replace(/\.+$/, "")}"` : `Press "${label}"`);
    this.root.append(ring, tip);
    const win = this.doc.defaultView;
    const place = () =>
      run(() => {
        const r = target.getBoundingClientRect();
        Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
        Object.assign(tip.style, { left: `${r.left}px`, top: `${Math.max(4, r.top - 30)}px` });
      });
    place();
    const onPressed = () => {
      cleanup();
      if (this.current) this.finish("did_it");
    };
    const timer = setTimeout(() => cleanup(), this.opts.highlightMs ?? 15_000);
    win?.addEventListener("scroll", place, true);
    win?.addEventListener("resize", place);
    target.addEventListener(kind === "field" ? "input" : "click", onPressed, { once: true, capture: true });
    const cleanup = () => {
      clearTimeout(timer);
      win?.removeEventListener("scroll", place, true);
      win?.removeEventListener("resize", place);
      target.removeEventListener(kind === "field" ? "input" : "click", onPressed, { capture: true });
      ring.remove();
      tip.remove();
      if (this.cleanupHighlight === cleanup) this.cleanupHighlight = undefined;
    };
    this.cleanupHighlight = cleanup;
    return true;
  }

  destroy(): void {
    this.cleanupHighlight?.();
    this.host.remove();
  }

  private actionsLater: HTMLButtonElement[] = [];

  private finish(value: GuideValue) {
    const d = this.current;
    if (!d) return;
    this.report(value);
    this.current = undefined;
    this.cleanupHighlight?.();
    this.root.querySelector(".card")?.remove();
  }

  private report(value: GuideValue) {
    const d = this.current;
    if (d) run(() => this.opts.report(d, value));
  }

  private el(tag: string, className = ""): HTMLElement {
    const e = this.doc.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  private text(tag: string, className: string, text: string): HTMLElement {
    const e = this.el(tag, className);
    e.textContent = text;
    return e;
  }

  private button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = this.el("button", className) as HTMLButtonElement;
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      run(onClick);
    });
    return b;
  }
}

function describe(step: Delivery["steps"][number]): string {
  if (step.type === "go") return `Go to ${step.label}`;
  if (step.type === "fill") return `Fill in: ${step.fields.join(", ")}`;
  return step.times > 1 ? `Press "${step.label}" (${step.times} more times)` : `Press "${step.label}"`;
}
