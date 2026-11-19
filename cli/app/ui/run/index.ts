/**
 * The ui-run lane's screens, for the shell to mount: S3 new test, S4 live, S5 result, S7 issues, and
 * the Set up sign-in pop-up (mounted once, on every screen). Each render is self-contained, so the shell
 * inlines it as `(${module.render.toString()})` under the page's nonce.
 */
import type { ScreenModule } from "../../contracts.ts";
import type { OverlayModule } from "./ext.ts";
import { handoverOverlay } from "./handover.ts";
import { issuesScreen } from "./issues.ts";
import { liveScreen } from "./live.ts";
import { newTestScreen } from "./newtest.ts";
import { resultScreen } from "./result.ts";

export { handoverOverlay, issuesScreen, liveScreen, newTestScreen, resultScreen };
export type { OverlayModule, ResultEventFull, RunLiveEvent, ScreenEvent, SessionEvent, SignInEvent } from "./ext.ts";

/** Route screens. */
export const runScreens: ScreenModule[] = [newTestScreen, liveScreen, resultScreen, issuesScreen];
/** Always-mounted parts (routes: []). */
export const runOverlays: OverlayModule[] = [handoverOverlay];
