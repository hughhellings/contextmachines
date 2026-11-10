// Builds the publishable CLI: one JavaScript file (Node 22+) behind a small startup shim, the snippet
// beside it, the licence and notes, the bundled packages' licences, and a package.json. Playwright stays a dependency: it manages its
// own browser download.
//   node cli/build.mjs [--name <npm name>] [--version <x.y.z>]
// The version is cli/package.json's unless --version says otherwise (a release passes its tag),
// and it is stamped into the bundle, so `contextmachines --version` is always the package's own.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

/** Where the project lives, and the CLI's folder in it (for package.json: links are from the root). */
const REPO = "hughhellings/contextmachines";
const DIRECTORY = "cli";

/**
 * Relative markdown links and images made absolute, to the repository's main branch. Anchors and full
 * addresses are left alone. The notes the package ships are the repository's own, written at its root
 * (the CLI's folder only links to them), so their links are read from the root, never from cli/.
 */
export function absoluteLinks(markdown) {
  return markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang, text, href, title) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return all;
    const path = new URL(href, "https://x/").pathname.slice(1);
    const image = bang || /\.(png|jpe?g|gif|svg|webp)$/i.test(href.split(/[?#]/)[0]);
    // GitHub shows a folder's page at its blob address too.
    const base = image ? `https://raw.githubusercontent.com/${REPO}/main/` : `https://github.com/${REPO}/blob/main/`;
    return `${bang}[${text}](${base}${path}${title})`;
  });
}

/** The file beside the bundle that carries the licence of every package bundled into it. */
export const THIRD_PARTY = "THIRD-PARTY-NOTICES.txt";

/**
 * The licence and notice texts of the packages esbuild put in the bundle, read from its metafile.
 * Their licences (MIT, Apache-2.0 and others) ask that every copy carries them, and the bundle drops
 * the comments they came in, so they ship in a file of their own. A bundled package that names no
 * licence stops the build: someone must look at it before it is published.
 */
export function thirdPartyNotices(inputs, cwd = process.cwd()) {
  const roots = new Map();
  for (const input of Object.keys(inputs)) {
    if (!/(^|[\\/])node_modules[\\/]/.test(input)) continue;
    // The package's own folder: the nearest package.json above the file that has a name.
    for (let dir = dirname(resolve(cwd, input)); dir !== dirname(dir); dir = dirname(dir)) {
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (!pkg.name) continue;
      roots.set(dir, pkg);
      break;
    }
  }
  const packages = [...roots].sort(([, a], [, b]) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const line = "=".repeat(72);
  const parts = [`The bundle (contextmachines.mjs) contains code from these ${packages.length} packages. Their licence and notice texts follow.\n`];
  for (const [dir, pkg] of packages) {
    const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
    if (!license) throw new Error(`${pkg.name}@${pkg.version} is bundled but names no licence`);
    const texts = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(f)).sort();
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    parts.push(`${line}\n${pkg.name}@${pkg.version} (${license})${repo ? `\n${repo}` : ""}\n${line}\n`);
    if (!texts.length) parts.push(`The package ships no licence file. Its package.json says: ${license}.\n`);
    for (const f of texts) parts.push(`${texts.length > 1 ? `--- ${f}\n` : ""}${readFileSync(join(dir, f), "utf8").trim()}\n`);
  }
  return parts.join("\n");
}

// Imported (by the tests) for absoluteLinks alone: nothing is built.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

async function main() {
  const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
  const own = JSON.parse(readFileSync(here("./package.json"), "utf8"));
  const { values } = parseArgs({ options: { name: { type: "string", default: "contextmachines" }, version: { type: "string", default: own.version } } });
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(values.version)) throw new Error(`--version must look like 1.2.3 (got "${values.version}")`);
  const out = here("./dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Always built afresh: a release must never ship an older snippet than its source.
  const snippet = here("../packages/snippet/dist/snippet.min.js");
  execFileSync(process.execPath, [here("../packages/snippet/build.mjs")], { stdio: "inherit" });
  // The Playwright the package depends on: the same one this repository is tested with.
  const playwright = own.dependencies.playwright;
  const shipped = ["README.md", "LICENSE", "NOTICE", "PRIVACY.md", "CHANGELOG.md"];

  const result = await build({
    entryPoints: [here("./contextmachines.ts")],
    outfile: `${out}/contextmachines.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["playwright", "playwright-core"],
    define: { __CONTEXTMACHINES_VERSION__: JSON.stringify(values.version) },
    // Some bundled dependencies are CommonJS and call require().
    banner: { js: 'import { createRequire as __contextmachinesRequire } from "node:module";\nconst require = __contextmachinesRequire(import.meta.url);' },
    // The bundled packages' licences ship in THIRD-PARTY-NOTICES.txt instead.
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
  writeFileSync(`${out}/${THIRD_PARTY}`, thirdPartyNotices(result.metafile.inputs));
  copyFileSync(here("./bin.mjs"), `${out}/bin.mjs`);
  chmodSync(`${out}/bin.mjs`, 0o755);
  copyFileSync(snippet, `${out}/snippet.min.js`);
  // What init offers to put in a project: it looks for them beside the bundle.
  cpSync(here("../skills/contextmachines"), `${out}/skills/contextmachines`, { recursive: true });
  mkdirSync(`${out}/examples/github-action`, { recursive: true });
  copyFileSync(here("../examples/github-action/contextmachines.yml"), `${out}/examples/github-action/contextmachines.yml`);
  for (const file of ["LICENSE", "NOTICE"]) copyFileSync(here(`./${file}`), `${out}/${file}`);
  // The notes are read on npm, where a link to another file of the repository has nothing behind it:
  // each relative link goes to the file on GitHub, and each relative image to its raw copy.
  for (const file of shipped.filter((f) => f.endsWith(".md"))) writeFileSync(`${out}/${file}`, absoluteLinks(readFileSync(here(`./${file}`), "utf8")));

  writeFileSync(`${out}/package.json`, `${JSON.stringify({
    name: values.name,
    version: values.version,
    description: "Learns a web product from the outside and writes down what it understood: screens, actions, journeys, and provable issues (buttons that do nothing, script errors, failed requests, broken links), plus what a pull request changes.",
    license: "Apache-2.0",
    author: "Hugh Hellings",
    type: "module",
    // No "./": npm 11 drops a bin path that starts with one when it publishes (npm pack keeps it).
    bin: { contextmachines: "bin.mjs" },
    repository: { type: "git", url: `git+https://github.com/${REPO}.git`, directory: DIRECTORY },
    homepage: `https://github.com/${REPO}#readme`,
    bugs: { url: `https://github.com/${REPO}/issues` },
    keywords: ["product", "context", "coding-agent", "agents-md", "claude-code", "codex", "playwright", "pull-request", "github-action", "broken-links", "smoke-test", "ux"],
    files: ["bin.mjs", "contextmachines.mjs", "snippet.min.js", "skills", "examples", THIRD_PARTY, ...shipped],
    // The release lines CI tests on: 22, 24 and 26.
    engines: { node: ">=22" },
    publishConfig: { access: "public" },
    dependencies: { playwright },
  }, null, 2)}\n`);
  console.log(`built ${out} (${values.name}@${values.version})`);
}
