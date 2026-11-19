/**
 * The app's one page: the shared stylesheet, every screen's css, and one script under the nonce that
 * holds the shell runtime and each screen's render(), inlined by their source text. Loads nothing from
 * the web. ui-server serves it in place of uiPage once integrated (see INTEGRATE.md).
 */
import type { AppRoute, ScreenModule } from "../../contracts.ts";
import { shellMain } from "./client.ts";
import { ICONS } from "./icons.ts";
import { SHELL_CSS, TOKENS_CSS } from "./style.ts";
import { issuesScreen, runScreen, runsScreen, testScreen, testsScreen } from "./lists.ts";
import { settingsScreen } from "./settings.ts";
import { startScreen } from "./start.ts";

/** The shell's own screens. A screen from another lane for the same route is listed first and wins. */
export const SHELL_SCREENS: ScreenModule[] = [startScreen, testsScreen, testScreen, runsScreen, runScreen, issuesScreen, settingsScreen];

/** Every AppRoute, so the router knows the ones no module has yet ("Coming soon" rather than "Not found"). */
export const ALL_ROUTES: AppRoute[] = ["/", "/p/:pid/tests", "/p/:pid/tests/new", "/p/:pid/tests/:tid", "/p/:pid/runs", "/p/:pid/runs/:rid", "/p/:pid/live", "/p/:pid/issues", "/p/:pid/issues/:iid", "/p/:pid/accounts", "/p/:pid/settings"];

/** A function's source as an expression: a method `render(a, b) {…}` becomes `({ render(a, b) {…} }).render`. */
export function fnSource(fn: Function): string {
  const src = Function.prototype.toString.call(fn).trim();
  if (/^(async\s+)?function\b/.test(src) || /^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>/.test(src)) return "(" + src + ")";
  const name = /^(async\s+)?([\w$]+)\s*\(/.exec(src);
  if (name) return "({ " + src + " })." + name[2];
  throw new Error("Can't inline this function: " + src.slice(0, 60));
}

/** Keep the script's text from closing its own tag. */
const safe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

/** An always-mounted part (the Set up sign-in pop-up): routes [] or `overlay: true`. */
export const isOverlay = (s: ScreenModule): boolean => s.routes.length === 0 || (s as ScreenModule & { overlay?: boolean }).overlay === true;

/** Run lane screens first, then the shell's: the first module that lists a route renders it. */
export function orderScreens(others: ScreenModule[]): ScreenModule[] {
  return others.concat(SHELL_SCREENS);
}

export function appPage(o: { token: string; nonce: string; screens?: ScreenModule[] }): string {
  const screens = o.screens ?? SHELL_SCREENS;
  const css = TOKENS_CSS + SHELL_CSS + screens.map((s) => `\n/* ${s.id.replace(/\*\//g, "")} */\n` + s.css).join("\n");
  const screenJs = screens.map((s) => `{ id: ${JSON.stringify(s.id)}, routes: ${JSON.stringify(s.routes)}, overlay: ${isOverlay(s)}, render: ${fnSource(s.render)} }`).join(",\n");
  const routes = Array.from(new Set(ALL_ROUTES.concat(screens.flatMap((s) => s.routes))));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Context Machines</title>
<style>${css.replace(/<\/style/gi, "<\\/style")}</style>
</head>
<body>
<script nonce="${o.nonce}">
"use strict";
${safe(`(${Function.prototype.toString.call(shellMain)})({
  token: ${JSON.stringify(o.token)},
  icons: ${JSON.stringify(ICONS)},
  routes: ${JSON.stringify(routes)},
  screens: [
${screenJs}
  ]
});`)}
</script>
</body>
</html>
`;
}
