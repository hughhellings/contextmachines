/**
 * Scopes a screen's stylesheet under its root class, so screens that share class names (.rn-btn,
 * .rn-step …) never restyle each other when the shell puts every screen's css on one page.
 * Module-level (not inside a render), so it is never inlined.
 */
export function scope(root: string, css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) { out += css.slice(i); break; }
    const head = css.slice(i, open).trim();
    if (head.startsWith("@keyframes")) {
      const end = matching(css, open);
      out += css.slice(i, end + 1) + "\n";
      i = end + 1;
      continue;
    }
    if (head.startsWith("@media") || head.startsWith("@supports")) {
      const end = matching(css, open);
      out += head + " {\n" + scope(root, css.slice(open + 1, end)) + "}\n";
      i = end + 1;
      continue;
    }
    const close = css.indexOf("}", open);
    const sel = head.split(",").map((s) => {
      const t = s.trim();
      if (!t) return t;
      return t === root || t.startsWith(root + ".") || t.startsWith(root + ":") || t.startsWith(root + " ") || t.startsWith(root + "[") ? t : root + " " + t;
    }).join(", ");
    out += sel + " " + css.slice(open, close + 1) + "\n";
    i = close + 1;
  }
  return out;
}

function matching(css: string, open: number): number {
  let depth = 0;
  for (let k = open; k < css.length; k++) {
    if (css[k] === "{") depth++;
    else if (css[k] === "}" && --depth === 0) return k;
  }
  return css.length - 1;
}
