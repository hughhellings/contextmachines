import { afterEach, describe, expect, it, vi } from "vitest";
import { Prompter, type Feedback, type PromptOutcome } from "../src/ui.ts";

const nudge: PromptOutcome = { ruleId: "R4", ruleVersion: 1, effectiveAction: "nudge", message: "Add a rubric before publishing.", reason: "The rubric field is empty." };
let prompter: Prompter | undefined;
afterEach(() => {
  prompter?.destroy();
  vi.useRealTimers();
});

const cards = () => [...(prompter?.element.shadowRoot?.querySelectorAll(".card") ?? [])] as HTMLElement[];
const buttons = (card: HTMLElement) => Object.fromEntries([...card.querySelectorAll("button")].map((b) => [b.textContent, b as HTMLButtonElement]));

describe("Prompter", () => {
  it("renders untrusted text safely and reveals the reason on demand", () => {
    prompter = new Prompter(document, { onFeedback: () => {} });
    prompter.show({ ...nudge, message: "<img src=x onerror=alert(1)>" });
    const [card] = cards();
    expect(card?.querySelector("img")).toBeNull();
    expect(card?.querySelector(".title")?.textContent).toBe("<img src=x onerror=alert(1)>");
    const reason = card?.querySelector(".reason") as HTMLElement;
    expect(reason.hidden).toBe(true);
    buttons(card as HTMLElement)["Why?"]?.click();
    expect(reason.hidden).toBe(false);
  });

  it("reports feedback once and removes the card", () => {
    const feedback: Feedback[] = [];
    prompter = new Prompter(document, { onFeedback: (_, f) => feedback.push(f) });
    prompter.show(nudge);
    buttons(cards()[0] as HTMLElement)["Not relevant"]?.click();
    expect(feedback).toEqual(["not_helpful"]);
    expect(prompter.visibleCount).toBe(0);
  });

  it("offers Fix it only when the host can fix, and records the fix", async () => {
    const feedback: Feedback[] = [];
    const onFix = vi.fn();
    prompter = new Prompter(document, { onFeedback: (_, f) => feedback.push(f), onFix });
    prompter.show({ ...nudge, effectiveAction: "fix" });
    buttons(cards()[0] as HTMLElement)["Fix it"]?.click();
    await vi.waitFor(() => expect(feedback).toEqual(["fixed"]));
    expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "R4" }));

    prompter.destroy();
    prompter = new Prompter(document, { onFeedback: () => {} });
    prompter.show({ ...nudge, effectiveAction: "fix" });
    expect(buttons(cards()[0] as HTMLElement)["Fix it"]).toBeUndefined();
  });

  it("dedupes the same rule, caps visible prompts, and auto-hides nudges but not blocks", () => {
    vi.useFakeTimers();
    let now = 0;
    const feedback: Feedback[] = [];
    prompter = new Prompter(document, { onFeedback: (_, f) => feedback.push(f), clock: () => now, maxVisible: 2, autoHideMs: 1000 });
    prompter.show(nudge);
    prompter.show(nudge);
    expect(prompter.visibleCount).toBe(1);
    prompter.show({ ...nudge, ruleId: "R5" });
    prompter.show({ ...nudge, ruleId: "R6", effectiveAction: "block" });
    expect(cards().map((c) => c.dataset.rule)).toEqual(["R5", "R6"]);
    expect(cards()[1]?.getAttribute("role")).toBe("alertdialog");
    vi.advanceTimersByTime(1001);
    expect(cards().map((c) => c.dataset.rule)).toEqual(["R6"]);
    now = 31_000;
    prompter.show(nudge);
    expect(prompter.visibleCount).toBe(2);
  });
});
