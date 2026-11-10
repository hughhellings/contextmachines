// Builds the browser bundle and enforces the size budget. Fails the build if exceeded.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const BUDGET_GZIP_BYTES = 30 * 1024;
const outfile = here("./dist/snippet.min.js");
mkdirSync(here("./dist"), { recursive: true });

await build({
  entryPoints: [here("./src/browser.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020", // evergreen browsers from 2020 onward
  outfile,
  legalComments: "none",
  logLevel: "warning",
});

const code = readFileSync(outfile);
const gz = gzipSync(code, { level: 9 }).length;
const sri = `sha384-${createHash("sha384").update(code).digest("base64")}`;
writeFileSync(here("./dist/manifest.json"), JSON.stringify({ bytes: code.length, gzipBytes: gz, integrity: sri }, null, 2));
console.log(`snippet: ${code.length} B, ${gz} B gzip (budget ${BUDGET_GZIP_BYTES}), integrity ${sri}`);
if (gz > BUDGET_GZIP_BYTES) {
  console.error("Size budget exceeded");
  process.exit(1);
}
