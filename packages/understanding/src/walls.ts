import type { NetworkEvent } from "@contextmachines/schemas";

/**
 * Walls: replies that mean "not for you", not "broken". The user's plan
 * doesn't include it, their role isn't allowed to do it, or they have hit a
 * usage limit (a trial that has ended counts as a plan). Nothing is wrong, so
 * a wall is never counted as a failure, never gets help, and never teaches us
 * anything about how the site works.
 *
 * Recognised only from what the app itself replies: the status, or its own
 * error code. 401 (signed out) is not a wall: signing in again fixes it.
 */
export type Wall = "plan" | "role" | "limit";

const PLAN_CODE = /plan|upgrade|subscri|tier|paywall|entitle|trial/i;
const LIMIT_CODE = /limit|quota|exceeded|too_many/i;
const ROLE_CODE = /forbidden|permission|not_?allowed|unauthori[sz]ed|role|admin_only/i;

export function wallOf(event: Pick<NetworkEvent, "status" | "errorCode">): Wall | undefined {
  const code = event.errorCode ?? "";
  if (event.status === 402 || PLAN_CODE.test(code)) return "plan";
  if (event.status === 429 || LIMIT_CODE.test(code)) return "limit";
  if (event.status === 403 || ROLE_CODE.test(code)) return "role";
  return undefined;
}

/** Languages help can be worded in. For anyone else we stay quiet rather than speak the wrong one. */
export const HELP_LANGUAGES = new Set(["en"]);
export const speaks = (lang: string | undefined) => lang === undefined || HELP_LANGUAGES.has(lang);
