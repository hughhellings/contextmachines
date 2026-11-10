/**
 * The Context Machines mark, shown once, at the top of `init`: `learn` begins with a setup line
 * instead, the way a test runner does (see run-screen.ts). A log, a pipe or a narrow window gets the
 * plain name: it is read by people scrolling and by tools, and a picture there would only push the
 * result away. Our own
 * letters, drawn by hand on a pixel grid: "context" over "machines", two pixels to a terminal row in
 * half blocks, which makes each pixel about square.
 */
import { colors, colorWanted, columnsOf } from "./term.ts";

/** Each letter as pixels, bottom-aligned: tall letters (t, h, i) simply have more rows. */
const LETTERS: Record<string, readonly string[]> = {
  a: [".####.", "######", "....##", ".#####", "######", "##..##", "######", ".#####"],
  c: [".####.", "######", "##....", "##....", "##....", "##....", "######", ".####."],
  e: [".####.", "######", "##..##", "######", "######", "##....", "######", ".#####"],
  h: ["##....", "##....", "#####.", "######", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##"],
  i: ["##", "##", "..", "##", "##", "##", "##", "##", "##", "##"],
  m: ["#######.", "########", "##.##.##", "##.##.##", "##.##.##", "##.##.##", "##.##.##", "##.##.##"],
  n: ["#####.", "######", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##"],
  o: [".####.", "######", "##..##", "##..##", "##..##", "##..##", "######", ".####."],
  s: [".#####", "######", "##....", "#####.", ".#####", "....##", "######", "#####."],
  t: [".##..", ".##..", "#####", "#####", ".##..", ".##..", ".##..", ".##..", ".####", "..###"],
  x: ["##..##", "##..##", ".####.", "..##..", "..##..", ".####.", "##..##", "##..##"],
};

/** The tallest letter, so that every word's rows pair up the same way into half blocks. */
const WORD_HEIGHT = 10;

/** A word as rows of pixels, one blank pixel between its letters. */
function pixels(word: string): string[] {
  return Array.from({ length: WORD_HEIGHT }, (_, row) =>
    [...word]
      .map((letter) => {
        const glyph = LETTERS[letter]!;
        const above = WORD_HEIGHT - glyph.length;
        return row < above ? ".".repeat(glyph[0]!.length) : glyph[row - above]!;
      })
      .join("."),
  );
}

/** Two rows of pixels to one row of text: the whole block, the upper half, the lower half or nothing. */
function halfBlocks(rows: readonly string[]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const upper = rows[y]!;
    const lower = rows[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < upper.length; x++) {
      const top = upper[x] === "#";
      const bottom = lower[x] === "#";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const CONTEXT = halfBlocks(pixels("context"));
const MACHINES = halfBlocks(pixels("machines"));

/** The narrowest terminal that gets the drawn mark. It is what the fallback is measured against. */
export const WORDMARK_MIN_COLUMNS = 60;

/**
 * The mark for a stream, or the plain name in bold where blocks would be noise or would break: a
 * narrow terminal wraps them into rubble, and a pipe or a log has no use for a picture. NO_COLOR gets
 * the plain name too, since the two-tone word break is what makes the mark read as two words.
 */
export function wordmark(stream: { isTTY?: boolean; columns?: number }, env: NodeJS.ProcessEnv = process.env): string {
  const wanted = colorWanted(stream, env);
  const c = colors(wanted);
  if (!stream.isTTY || !wanted || columnsOf(stream) < WORDMARK_MIN_COLUMNS) return c.bold("Context Machines");
  return [...CONTEXT.map((line) => c.bold(line)), "", ...MACHINES.map((line) => c.cyan(line))].join("\n");
}
