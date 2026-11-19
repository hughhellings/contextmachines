/**
 * The pay gate (D14): whether a press that reads like paying may happen, given what paymode.ts
 * sees on the page and its frames right now. Pure; the engine calls it in front of the deny list
 * (see INTEGRATE.md). It never widens anything when payments are off: the deny list stands.
 *
 * Two kinds of press:
 *   - "start": goes to a checkout and moves no money ("Pay with PayPal", "Buy now", "Subscribe").
 *     A shop's own page often shows no provider marker at all (PayPal's redirect, a Shopify
 *     storefront), so a start press needs only "not live".
 *   - "final": every other pay-like press ("Pay", "Pay now", "Complete Purchase", "Subscribe now",
 *     "Pay $165.00", "Place order"). Needs test mode seen on this page or its frames (`mayPay`).
 * And three stops:
 *   - a live checkout on sight ends the run BLOCKED at once, before anything is typed into it
 *     (`liveOnSight`), whatever the next press would be;
 *   - one final press per run: after it, whatever came of it (paid, declined, 3D Secure failed), no
 *     final press again ("never retry a payment after a failed action"). Counting presses, not
 *     reading the page for a decline, can't be fooled by wording;
 *   - only on a host the person marked as theirs, with payments turned on for the run.
 */
import type { PayModeResult } from "./paymode.ts";

export type PressKind = "start" | "final";

/**
 * Whole names that only lead to a checkout, wherever they are. "Pay with" only names a provider or a
 * card form: "Pay with card ending 4242", "Pay with saved card", "Pay with Apple Pay" or "Pay with Link"
 * can charge a stored method in one press, so they are final.
 */
const START = /^(pay (with|on|via|by) (paypal|venmo|stripe|paddle|klarna|afterpay|affirm|card|a card|(a )?(credit|debit) card|(a )?(debit or credit|credit or debit) card)|(go|proceed|continue) to (checkout|payment|pay)|check ?out|checkout( now)?)$/i;
/** Start names only on the shop's own page. On a provider's page (Stripe Checkout's subscription button says "Subscribe") they pay. */
const START_ON_SHOP = /^(buy( it)? now|subscribe|upgrade)$/i;

/** A press's kind. `onProvider`: the page or frame the control is in is a payment provider's (paymode.providerOf). */
export function pressKind(name: string, onProvider = false): PressKind {
  const n = name.replace(/\s+/g, " ").replace(/[\s.!…→>›]+$/u, "").trim();
  // "Pay now", "Pay $165.00", "Subscribe now" are final even though they start like a start.
  if (/^pay (now|\$|€|£|\d)/i.test(n)) return "final";
  if (START.test(n)) return "start";
  return !onProvider && START_ON_SHOP.test(n) ? "start" : "final";
}

export interface GateInput {
  /** The control's accessible name. */
  name: string;
  /** payMode of the page and every frame, read just before the press. */
  mode: PayModeResult;
  /**
   * The control is in a payment provider's page or frame (by host: paymode.providerOf on the top
   * page's address and on the control's frame's address). There, "Subscribe" or "Buy now" pays.
   */
  onProvider: boolean;
  /** The page's host is one the person marked as theirs (accounts' owned hosts), or a provider page reached from one in this run. */
  owned: boolean;
  /** The run allows payments at all (opted in for this test). */
  paymentsOn: boolean;
  /** Final presses already made in this run. */
  finalPresses: number;
}

export type GateAnswer = { allow: true; kind: PressKind } | { allow: false; kind: PressKind; why: string };

export function payGate(i: GateInput): GateAnswer {
  const kind = pressKind(i.name, i.onProvider);
  const no = (why: string): GateAnswer => ({ allow: false, kind, why });
  if (!i.paymentsOn) return no("payments are off for this test");
  if (!i.owned) return no("payments are made only on a site marked as yours");
  if (i.mode.mode === "live") return no(`the checkout is live (${i.mode.reason})`);
  if (kind === "start") return { allow: true, kind };
  if (!i.mode.mayPay) return no(`test mode can't be seen on this checkout (${i.mode.reason})`);
  if (i.finalPresses > 0) return no("a payment was already tried in this run, and a payment is never tried again");
  return { allow: true, kind };
}

/**
 * A reason to stop the run BLOCKED now, in a run that may pay: a live checkout is on the page, or the
 * page itself is a provider's checkout (`onProviderPage`: paymode.providerOf(page.url())) whose test
 * mode can't be seen. The second stops a Shopify checkout with no test gateway before anything is
 * typed into it, as a live one is; a shop's own page with only a provider's script is not stopped.
 */
export function liveOnSight(mode: PayModeResult, onProviderPage = false): string | undefined {
  if (mode.mode === "live") return `BLOCKED: a live checkout is open (${mode.reason}); live payments are never made`;
  if (onProviderPage && !mode.mayPay) return `BLOCKED: a checkout whose test mode can't be seen is open (${mode.reason}); it is treated as live`;
  return undefined;
}
