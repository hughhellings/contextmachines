/**
 * E2 (#61): secure fields are painted over in every picture of the page before the picture leaves the
 * browser. That covers step photos, the AI's screenshots and the live screencast's frames. It uses
 * Playwright's screenshot `mask`, which draws the boxes in the page while the browser captures and
 * takes them away after, so no unmasked image is ever made in Node.
 *
 * Masked:
 * - password fields
 * - card fields (autocomplete cc-*, card / cvc / cvv / expiry names)
 * - one-time-code fields (autocomplete one-time-code, otp names, split one-digit boxes)
 * - payment providers' card frames
 * - every field the run filled from a secret (SecretFields, which act.ts fills)
 *
 * The recorded video can't be masked this way: see INTEGRATE.md.
 */
import type { Locator, Page, PageScreenshotOptions } from "playwright";

/** The mask's colour: a calm dark grey, the same in every picture. */
export const MASK_COLOR = "#3A3A3A";

/** Fields whose value is a secret by its kind. Case-insensitive attribute matches. */
export const SECURE_FIELDS: readonly string[] = [
  "input[type=password i]",
  // A "show password" toggle turns the field into type=text: it is still a password by its name or autocomplete.
  "input[autocomplete$='password' i]",
  "input[name*='password' i]",
  "input[id*='password' i]",
  "input[autocomplete^='cc-' i]",
  "input[autocomplete='one-time-code' i]",
  "input[name*='card' i]:not([type=checkbox]):not([type=radio])",
  "input[name*='cvc' i]",
  "input[name*='cvv' i]",
  "input[name*='otp' i]",
  "input[id*='cvc' i]",
  "input[id*='cvv' i]",
  "input[id*='card-number' i]",
  "input[id*='cardnumber' i]",
  "input[id*='otp' i]",
  "input[inputmode=numeric][maxlength='1']",
  // Payment providers' card frames: the whole frame.
  "iframe[src*='js.stripe.com']",
  "iframe[name^='__privateStripeFrame']",
  "iframe[src*='braintreegateway.com']",
  "iframe[src*='checkoutshopper']",
  "iframe[title*='card number' i]",
  "iframe[title*='secure payment' i]",
];

const SELECTOR = SECURE_FIELDS.join(", ");

/** The fields this run typed a secret into ({admin.password}, {card.number}, a code). act.ts adds each one as it fills it. */
export class SecretFields {
  private readonly list: Locator[] = [];
  add(field: Locator): void {
    if (this.list.length < 200) this.list.push(field);
  }
  locators(): readonly Locator[] {
    return this.list;
  }
  get size(): number {
    return this.list.length;
  }
}

/** What to paint over now: the secure fields of the page and its frames, and the run's secret-filled fields. */
export function maskLocators(page: Page, fields?: SecretFields): Locator[] {
  const out: Locator[] = [page.locator(SELECTOR)];
  for (const frame of page.frames()) if (frame !== page.mainFrame()) out.push(frame.locator(SELECTOR));
  if (fields) out.push(...fields.locators());
  return out;
}

/** Options to spread into any page.screenshot() call: `{ ...shotOptions, ...maskOptions(page, fields) }`. */
export function maskOptions(page: Page, fields?: SecretFields): Pick<PageScreenshotOptions, "mask" | "maskColor"> {
  return { mask: maskLocators(page, fields), maskColor: MASK_COLOR };
}

/** A screenshot with every secure field painted over. */
export function maskedScreenshot(page: Page, options: PageScreenshotOptions = {}, fields?: SecretFields): Promise<Buffer> {
  return page.screenshot({ ...options, ...maskOptions(page, fields) });
}
