#!/usr/bin/env node
// The command's first step, in plain JavaScript that any Node can read: it checks the Node version
// before anything else loads, since the CLI and its dependencies are what an old Node would fail on,
// with a stack trace instead of a sentence. Kept to old syntax (no ?., ??, or top-level await) so
// that even a very old Node gets as far as the sentence.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The oldest Node it runs on: the oldest release line it is tested on. */
const NEEDS = [22, 0];

// A reader that stops early (`contextmachines --help | head -3`) closes the pipe; what it didn't read
// is dropped, rather than ending in an EPIPE stack trace. The CLI does the same once it is loaded.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error && error.code === "EPIPE") return;
    throw error;
  });
}

const have = process.versions.node.split(".").map(Number);
if (have[0] < NEEDS[0] || (have[0] === NEEDS[0] && have[1] < NEEDS[1])) {
  const needs = NEEDS[1] ? NEEDS.join(".") : String(NEEDS[0]);
  process.stderr.write(`Context Machines needs Node ${needs} or newer (you have ${have[0]}.${have[1]}). Update Node, then run it again.\n`);
  process.exit(2);
}

// Published, the bundled CLI sits beside this file; in the repository, Node runs the TypeScript itself.
const bundled = new URL("./contextmachines.mjs", import.meta.url);
if (existsSync(fileURLToPath(bundled))) {
  import(bundled.href);
} else if (process.features && process.features.typescript) {
  import(new URL("./contextmachines.ts", import.meta.url).href);
} else {
  process.stderr.write(`Context Machines runs from source only on a Node that runs TypeScript itself (22.18, 23.6 or newer; you have ${process.versions.node}). Update Node, or run the built package.\n`);
  process.exit(2);
}
