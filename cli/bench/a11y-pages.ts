/**
 * The accessibility scan's fixture pages (a11y.ts): a planted page with an exact count of each kind of
 * issue, and its traps that must not count; and a clean page with none. Used by a11y.test.ts and served
 * by the bench's fixture site at /a11y and /a11y-clean.
 */
import type { A11yKind } from "../../packages/scanner/src/tester/a11y.ts";

/** A small square icon, as an image source. */
export const ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg>');

/**
 * The planted page: exactly 3 unnamed controls, 2 images with no alt (and 1 with alt="", decorative,
 * which must not count), no lang, 2 unlabeled fields and 1 labelled only by its placeholder, 1 heading
 * skip (h2 then h4), 2 duplicated ids, 3 small targets close together, and a link inside a sentence
 * (small, but inline: it must not count).
 */
export const PLANTED_PAGE = `<!doctype html><html><head><title>Planted</title>
<style>
  body { font: 16px sans-serif; margin: 20px; }
  .big { width: 44px; height: 44px; margin: 20px; display: inline-block; }
  .tiny { width: 16px; height: 16px; padding: 0; margin: 0 2px; border: 1px solid #333; }
  section { margin: 30px 0; }
</style></head><body>
<h1>Planted page</h1>
<section>
  <h2>Controls</h2>
  <button class="big" id="close"><svg width="20" height="20" aria-hidden="true"><rect width="20" height="20"/></svg></button>
  <button class="big"></button>
  <div class="big" role="button" tabindex="0"></div>
  <button class="big" aria-label="Named fine"></button>
  <button class="big" aria-hidden="true"></button>
  <button class="big" style="display:none"></button>
</section>
<section>
  <h4>Images</h4>
  <img src="${ICON}" width="40" height="40">
  <img src="${ICON}" width="40" height="40">
  <img src="${ICON}" width="40" height="40" alt="">
  <img src="${ICON}" width="40" height="40" alt="A grey square">
  <img src="${ICON}" width="1" height="1">
</section>
<section>
  <h2>Fields</h2>
  <input type="text" style="margin:20px">
  <textarea style="margin:20px"></textarea>
  <input type="email" placeholder="Your email" style="margin:20px">
  <label style="margin:20px">Name <input type="text"></label>
  <label for="city">City</label> <input id="city" type="text" style="margin:20px">
  <input type="hidden" name="t">
</section>
<section>
  <div id="dup">one</div><div id="dup">two</div>
  <div id="twice">a</div><span id="twice">b</span>
  <svg width="0" height="0"><defs><linearGradient id="g1"></linearGradient></defs></svg>
  <svg width="0" height="0"><defs><linearGradient id="g1"></linearGradient></defs></svg>
</section>
<section>
  <h3>Small</h3>
  <button class="tiny" aria-label="Bold"></button><button class="tiny" aria-label="Italic"></button><button class="tiny" aria-label="Underline"></button>
</section>
<section>
  <p>Please read the <a href="#terms">terms</a> before you start using the planted page.</p>
</section>
</body></html>`;

/** The planted counts, per kind. */
export const PLANTED: Record<A11yKind, number> = { no_name: 3, img_no_alt: 2, no_lang: 1, field_no_label: 2, placeholder_only: 1, heading_order: 1, duplicate_id: 2, small_target: 3 };

/** A clean page: 0 findings. */
export const CLEAN_PAGE = `<!doctype html><html lang="en"><head><title>Clean</title>
<style>body { font: 16px sans-serif; margin: 20px; } a.nav, button { display: inline-block; padding: 12px; margin: 8px; min-width: 44px; min-height: 44px; box-sizing: border-box; }</style></head><body>
<nav><a class="nav" href="/">Home</a><a class="nav" href="/about">About</a></nav>
<h1>A clean page</h1>
<h2>Sign up</h2>
<form>
  <label for="email">Email</label> <input id="email" type="email" placeholder="you@example.com">
  <label>Message <textarea></textarea></label>
  <input type="text" aria-label="Search">
  <button type="submit">Send</button>
  <button aria-label="Close"><svg width="20" height="20" aria-hidden="true"></svg></button>
</form>
<h3>Pictures</h3>
<img src="${ICON}" width="40" height="40" alt="A grey square"><img src="${ICON}" width="40" height="40" alt="">
<p>Read the <a href="#terms">terms</a> first.</p>
</body></html>`;
