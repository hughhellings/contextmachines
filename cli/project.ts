/**
 * What this folder is, worked out from the folder itself, so setup needs no typing: which app, what
 * it's built with, how it starts, where it listens, how people sign in to it, and whether it is
 * running right now.
 *
 * Only named files are read: package.json, framework configs and the marker files of a few server
 * frameworks. Never an .env file, in any spelling: a port kept there just stays unknown. A process's
 * working folder is what ties a server to this project, not its port or its pages, since two copies
 * of an app answer with identical pages.
 *
 * Starting the project's dev command runs the project's code, so it lives here behind one function
 * that only a person's explicit yes reaches (see init.ts).
 */
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

/** Dev server configs that can hand addresses on to another server. */
const PROXY_FILES = [
  "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs", "vue.config.js", "astro.config.mjs", "astro.config.ts", "astro.config.js", "svelte.config.js", "craco.config.js", "rsbuild.config.ts", "rspack.config.js",
  "webpack.config.js", "webpack.config.ts", "webpack.config.cjs", "webpack.config.mjs", "webpack.dev.js", "webpack.dev.ts", "webpack.dev.config.js", "webpack.config.dev.js", "config/webpackDevServer.config.js",
];
/** Files that are a proxy's table and nothing else. */
const PROXY_TABLES = ["proxy.conf.json", "src/proxy.conf.json", "proxy.conf.js", "proxy.conf.mjs", "proxy.conf.cjs", "proxy.conf.ts", "src/proxy.conf.js", ".proxyrc", ".proxyrc.json", ".proxyrc.js", ".proxyrc.cjs"];
const REWRITE_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", "vercel.json"];
const NUXT_FILES = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"];
const REDIRECT_FILES = ["_redirects", "public/_redirects", "static/_redirects"];
/** Where a project's own dev server tends to live, for one that mounts a proxy in code. */
const SERVER_FILES = ["src/setupProxy.js", "src/setupProxy.ts", "src/setupProxy.cjs", "server.js", "server.mjs", "server.cjs", "server.ts", "dev-server.js", "dev-server.mjs", "dev-server.ts", "devServer.js", "devServer.ts", "server/index.js", "server/index.mjs", "server/index.ts", "server/dev.js", "server/dev.ts"];
const PROXY_CODE = /\b(?:createProxyMiddleware|createProxyServer|http-proxy|express-http-proxy|httpProxy|proxyReq)\b|\bproxy\(/;

/** Where each dev server listens unless told otherwise. Only the ones that say nothing in the script. */
const DEFAULT_PORTS: readonly (readonly [string, number])[] = [["next", 3000], ["vite", 5173], ["astro", 4321], ["nuxt", 3000], ["gatsby", 8000], ["@angular/cli", 4200], ["react-scripts", 3000], ["@vue/cli-service", 8080]];
export const DEFAULT_URL = "http://localhost:3000";

/** How each framework is called to a person, by the dependency that shows it. The first found wins, so a framework built on Vite goes ahead of Vite. */
const FRAMEWORKS: readonly (readonly [string, string])[] = [["next", "Next.js"], ["nuxt", "Nuxt"], ["@remix-run/dev", "Remix"], ["@sveltejs/kit", "SvelteKit"], ["astro", "Astro"], ["gatsby", "Gatsby"], ["@angular/cli", "Angular"], ["react-scripts", "Create React App"], ["@vue/cli-service", "Vue CLI"], ["vite", "Vite"]];

/** Frameworks that aren't Node's: a file that only they have, how they start, where they listen. */
const SERVERS: readonly { marker: string; framework: string; command: string; args: string[]; port: number; auth: Auth }[] = [
  { marker: "manage.py", framework: "Django", command: "python", args: ["manage.py", "runserver"], port: 8000, auth: { name: "Django", held: "server" } },
  { marker: "artisan", framework: "Laravel", command: "php", args: ["artisan", "serve"], port: 8000, auth: { name: "Laravel", held: "server" } },
  { marker: "bin/rails", framework: "Rails", command: "bin/rails", args: ["server"], port: 3000, auth: { name: "Rails", held: "server" } },
  { marker: "mix.exs", framework: "Phoenix", command: "mix", args: ["phx.server"], port: 4000, auth: { name: "Phoenix", held: "server" } },
];

export interface Auth {
  name: string;
  /** Where who's signed in is decided: in the browser a stand-in user can pass it, on a server nothing in a browser can. */
  held: "browser" | "server";
}

/** Sign-in libraries, by the dependency that shows them. The server's own goes first: a project can hold both. */
const AUTH: readonly (readonly [RegExp, Auth])[] = [
  [/^@supabase\/ssr$|^@supabase\/auth-helpers-/, { name: "Supabase", held: "server" }],
  [/^@supabase\/supabase-js$/, { name: "Supabase", held: "browser" }],
  [/^next-auth$|^@auth\/core$/, { name: "Auth.js", held: "server" }],
  [/^@auth0\/nextjs-auth0$/, { name: "Auth0", held: "server" }],
  [/^@auth0\//, { name: "Auth0", held: "browser" }],
  [/^@clerk\/nextjs$/, { name: "Clerk", held: "server" }],
  [/^@clerk\//, { name: "Clerk", held: "browser" }],
  [/^firebase$|^@angular\/fire$/, { name: "Firebase", held: "browser" }],
  [/^aws-amplify$/, { name: "Amplify", held: "browser" }],
  [/^better-auth$|^lucia$|^passport$|^express-session$/, { name: "server sessions", held: "server" }],
];

/** Sign-in libraries the stand-in user has an answer for. Names only: the scanner's own list decides at run time. */
const STAND_IN_KNOWS = new Set(["Supabase"]);

/** Whether a stand-in user is expected to get past this sign-in. Only ever said as an expectation: the run finds out. */
export const standInExpected = (auth: Auth | undefined) => auth?.held === "browser" && STAND_IN_KNOWS.has(auth.name);

export interface DevCommand {
  command: string;
  args: string[];
  /** As a person would type it. */
  shown: string;
  /** A hook that runs first, said out loud: a predev script can migrate a database. */
  runsFirst?: string;
}

export interface Listener {
  port: number;
  /** The process's working folder, when it can be read on this machine. */
  cwd?: string;
}

export interface Project {
  /** The folder the app is in, as an absolute path. */
  dir: string;
  /** The same from where setup was run: "." for here. */
  folder: string;
  framework?: string;
  /** The address it should answer at, and what says so. */
  url: string;
  urlFrom?: string;
  dev?: DevCommand;
  auth?: Auth;
  /** Ports a process running from this folder listens on, lowest first. */
  running: number[];
}

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  workspaces?: unknown;
}

function readPackage(dir: string): PackageJson | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    return pkg && typeof pkg === "object" && !Array.isArray(pkg) ? (pkg as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

const hasDep = (pkg: PackageJson, name: string) => pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined;
const depNames = (pkg: PackageJson) => [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
const scriptOf = (pkg: PackageJson) => (typeof pkg.scripts?.dev === "string" ? "dev" : typeof pkg.scripts?.start === "string" ? "start" : undefined);

/** Config files that can hold a dev server's port, as plain text. Never run, so a computed port just isn't found. */
const CONFIG_FILES = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs", "astro.config.mjs", "astro.config.ts", "nuxt.config.ts", "nuxt.config.js", "vue.config.js", "webpack.config.js"];
const CONFIG_PORT = /\b(?:server|devServer)\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/;

function configPort(cwd: string): { port: string; file: string } | undefined {
  for (const file of CONFIG_FILES) {
    try {
      const port = CONFIG_PORT.exec(readFileSync(join(cwd, file), "utf8"))?.[1];
      if (port) return { port, file };
    } catch {
      // no such file: on to the next
    }
  }
  return undefined;
}

/**
 * The likely address from the project's own files: a port named in the dev script wins, then one in
 * the framework's config, then the framework's default. Anything unusual falls back to the default.
 */
export function detectUrl(cwd: string): { url: string; from?: string } {
  const pkg = readPackage(cwd);
  if (!pkg) return { url: DEFAULT_URL };
  const name = typeof pkg.scripts?.dev === "string" ? "dev" : "start";
  const script = typeof pkg.scripts?.[name] === "string" ? (pkg.scripts[name] as string) : "";
  const port = /(?:--port[= ]|\s-p[= ]?|\bPORT=)(\d{2,5})\b/.exec(script)?.[1];
  if (port) return { url: `http://localhost:${port}`, from: `your ${name} script` };
  const config = configPort(cwd);
  if (config) return { url: `http://localhost:${config.port}`, from: config.file };
  const framework =
    DEFAULT_PORTS.find(([word]) => new RegExp(`(^|[\\s/])${word.replace(/^.*\//, "")}\\b`).test(script)) ??
    DEFAULT_PORTS.find(([word]) => hasDep(pkg, word));
  return framework ? { url: `http://localhost:${framework[1]}`, from: `${framework[0]}'s default` } : { url: DEFAULT_URL };
}

/** The package manager that owns this folder, from the lockfile here or in a folder above, up to where setup was run. */
function packageManager(dir: string, top: string): string {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(at, "yarn.lock"))) return "yarn";
    if (existsSync(join(at, "bun.lockb")) || existsSync(join(at, "bun.lock"))) return "bun";
    if (at === top || dirname(at) === at) return "npm";
  }
}

function devCommand(dir: string, top: string): DevCommand | undefined {
  const pkg = readPackage(dir);
  const script = pkg && scriptOf(pkg);
  if (pkg && script) {
    const manager = packageManager(dir, top);
    const args = manager === "npm" || script !== "dev" ? ["run", script] : [script];
    const hook = typeof pkg.scripts?.[`pre${script}`] === "string" ? `pre${script}` : undefined;
    return { command: manager, args, shown: `${manager} ${args.join(" ")}`, ...(hook ? { runsFirst: hook } : {}) };
  }
  const server = SERVERS.find((s) => existsSync(join(dir, s.marker)));
  return server ? { command: server.command, args: server.args, shown: `${server.command} ${server.args.join(" ")}` } : undefined;
}

function frameworkOf(dir: string): string | undefined {
  const pkg = readPackage(dir);
  const found = pkg && FRAMEWORKS.find(([dep]) => hasDep(pkg, dep));
  return found ? found[1] : SERVERS.find((s) => existsSync(join(dir, s.marker)))?.framework;
}

function authOf(dirs: readonly string[]): Auth | undefined {
  const names = dirs.flatMap((dir) => {
    const pkg = readPackage(dir);
    return pkg ? depNames(pkg) : [];
  });
  for (const [pattern, auth] of AUTH) if (names.some((name) => pattern.test(name))) return auth;
  return dirs.flatMap((dir) => SERVERS.filter((s) => existsSync(join(dir, s.marker))).map((s) => s.auth))[0];
}

/** Folders that are never the app, whatever is in them. */
const NOT_APP = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "docs", "doc", "examples", "example", "test", "tests", "e2e", "scripts", "public", "static", "tmp"]);
/** What apps are usually called, for telling one from a library next to it. */
const APP_NAME = /^(?:web|app|apps|site|www|frontend|front-end|client|dashboard|ui|portal)$/i;

function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NOT_APP.has(e.name)).map((e) => join(dir, e.name)).sort();
  } catch {
    return [];
  }
}

/** This folder and what lies one or two folders down: a monorepo's app is rarely deeper than apps/web. */
function places(cwd: string): string[] {
  const near = folders(cwd);
  return [cwd, ...near, ...near.flatMap(folders)];
}

/** How much a folder looks like the app: a framework is the most anyone can tell, and a way to start it next. */
function appScore(dir: string, top: string): number {
  const framework = frameworkOf(dir);
  const dev = devCommand(dir, top);
  if (!framework && !dev) return 0;
  return (framework ? 4 : 0) + (dev ? 2 : 0) + (dir === top ? 1 : 0) + (APP_NAME.test(relative(top, dir).split(sep).at(-1) ?? "") ? 1 : 0);
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
/** Whether a folder is this one or lies inside it. */
export const within = (folder: string, path: string) => {
  const [a, b] = [real(folder), real(path)];
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
};

/** What an app's folder holds on its own, past what appScore knows: a page, a source folder, a server file, another language's project file. */
const APP_FILES = ["package.json", "index.html", "src", "app", "pages", "public/index.html", "deno.json", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile", "composer.json", "Cargo.toml", "pom.xml", "build.gradle"];

/**
 * Whether a folder holds an app's code, for saying so before a run that would find no file:line to
 * point a fix at (run from a home folder, say). This folder only, by names, so it costs nothing: a
 * framework or a way to start it (appScore), a server framework's marker, or one of APP_FILES.
 */
export function hasAppCode(dir: string): boolean {
  return appScore(dir, dir) > 0 || [...APP_FILES, ...SERVER_FILES, ...SERVERS.map((s) => s.marker)].some((name) => existsSync(join(dir, name)));
}

/**
 * The project in this folder. A folder a server is running from right now wins over any guess; then
 * this folder if it's an app; then the most app-like folder below it.
 */
export function detectProject(cwd: string, listeners: readonly Listener[] = []): Project {
  const all = places(cwd);
  const serving = listeners.flatMap((l) => (l.cwd && within(cwd, l.cwd) ? [l.cwd] : []));
  const scored = all.map((dir) => ({ dir, score: appScore(dir, cwd), serving: serving.some((path) => within(dir, path)) })).filter((p) => p.score > 0);
  // The deepest folder a server runs from, or a repository's root would beat the app inside it.
  const best = [...scored].sort((a, b) => Number(b.serving) - Number(a.serving) || b.score - a.score)[0];
  const dir = best?.dir ?? cwd;
  const url = detectUrl(dir);
  const server = SERVERS.find((s) => existsSync(join(dir, s.marker)));
  const fromServer = !url.from && server ? { url: `http://localhost:${server.port}`, from: `${server.framework}'s default` } : url;
  const dev = devCommand(dir, cwd);
  const framework = frameworkOf(dir);
  const auth = authOf(dir === cwd ? [dir] : [dir, cwd]);
  return {
    dir,
    folder: relative(cwd, dir).split(sep).join("/") || ".",
    url: fromServer.url,
    ...(fromServer.from ? { urlFrom: fromServer.from } : {}),
    ...(framework ? { framework } : {}),
    ...(dev ? { dev } : {}),
    ...(auth ? { auth } : {}),
    running: [...new Set(listeners.flatMap((l) => (l.cwd && within(dir, l.cwd) ? [l.port] : [])))].sort((a, b) => a - b),
  };
}

/** The folder a server on this port runs from, when that's a different project from this folder. */
export function servedFromElsewhere(port: number, cwd: string, found: readonly Listener[]): string | undefined {
  const server = found.find((l) => l.port === port);
  return server?.cwd && !within(cwd, server.cwd) && !within(server.cwd, cwd) ? server.cwd : undefined;
}

/** Comments, which may hold an old proxy, taken out. Only whole-line and block ones: "//" is also half of every address. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");

/** The quoted keys at the top of the object that opens here, and whether anything else stood where a key should. */
function keysOf(text: string, open: number): { keys: string[]; unread: boolean } {
  const keys: string[] = [];
  let unread = false;
  let depth = 0;
  let wantKey = false;
  for (let at = open; at < text.length; at++) {
    const char = text[at]!;
    if (/\s/.test(char)) continue;
    if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && wantKey) {
        const after = /^\s*:/.test(text.slice(end + 1, end + 40));
        if (after) keys.push(text.slice(at + 1, end));
        else unread = true;
        wantKey = false;
      }
      at = end;
      continue;
    }
    if (depth === 1 && wantKey && char !== "}") {
      unread = true;
      wantKey = false;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth++;
      if (depth === 1) wantKey = true;
    } else if (char === "}" || char === "]" || char === ")") {
      depth--;
      if (depth === 0) break;
    } else if (char === "," && depth === 1) wantKey = true;
  }
  return { keys, unread };
}

/** The object around a place in the text. */
function objectAround(text: string, at: number): string {
  let from = at;
  for (let depth = 0; from > 0; from--) {
    if (text[from] === "}") depth++;
    if (text[from] === "{" && depth-- === 0) break;
  }
  let to = at;
  for (let depth = 0; to < text.length; to++) {
    if (text[to] === "{") depth++;
    if (text[to] === "}" && depth-- === 0) break;
  }
  return text.slice(from, to + 1);
}

/**
 * What this project's dev server hands on to another server: a path that reads like a file can
 * still end up at the real service. Read from the named config files, as text, never run. "*" is a
 * project that hands on what can't be listed: everything the dev server doesn't have
 * (package.json's "proxy"), or a proxy that's plainly there and can't be read from the text (a
 * computed key, a helper, a destination in a variable is fine: it's the source that matters). A
 * rewrite to the app's own address (a single-page app's fallback) goes nowhere. What no file here
 * shows stays the seal's to refuse by its own rule (see isFile in stand-in.ts).
 */
export function proxiedPaths(dir: string): string[] {
  const text = (file: string) => {
    try {
      return withoutComments(readFileSync(join(dir, file), "utf8"));
    } catch {
      return "";
    }
  };
  const found = new Set<string>();
  /** A proxy key is a path or a regular expression: what's certain is the fixed part it starts with. */
  const add = (key: string | undefined) => {
    const fixed = /^\^?(\/[\w/-]*)/.exec(key ?? "")?.[1]?.replace(/\/+$/, "");
    if (fixed) found.add(fixed);
    else found.add("*");
  };
  const addObject = (config: string, open: number) => {
    const { keys, unread } = keysOf(config, open);
    keys.forEach(add);
    if (unread) found.add("*");
  };
  for (const file of PROXY_TABLES) {
    const table = text(file);
    const open = table.indexOf("{");
    if (/\.c?m?js$|\.ts$/.test(file) && !/^\s*(?:module\.exports|export default)\s*=?\s*\{/m.test(table)) {
      if (table.trim()) found.add("*");
    } else if (open >= 0) addObject(table, open);
  }
  for (const file of PROXY_FILES) {
    const config = text(file);
    for (const key of config.matchAll(/\bproxy\b\s*(:\s*)?(.?)/g)) {
      const [, colon, next] = key;
      const after = key.index + key[0].length - (next ? 1 : 0);
      if (colon && next === "{") addObject(config, after);
      else if (colon && next === "[") {
        const entries = config.slice(after, after + 2000);
        const context = [...entries.matchAll(/\bcontext\s*:\s*\[([^\]]*)\]|\bcontext\s*:\s*["'`]([^"'`]+)/g)].flatMap((m) => (m[2] ? [m[2]] : [...(m[1] ?? "").matchAll(/["'`]([^"'`]+)/g)].map((q) => q[1]!)));
        if (context.length) context.forEach(add);
        else found.add("*");
      } else if ((colon && !/^(?:false|undefined|null)\b/.test(config.slice(after))) || (!colon && (next === "," || next === "}"))) found.add("*");
    }
  }
  for (const file of REWRITE_FILES) {
    const config = text(file);
    const rules = [...config.matchAll(/["'`]?\bdestination\b["'`]?\s*:/g)];
    for (const rule of rules) {
      const entry = objectAround(config, rule.index);
      if (/\b(?:permanent|statusCode)\b/.test(entry)) continue; // a redirect: the browser's to follow, and the host rule stops that
      const to = /["'`]?\bdestination\b["'`]?\s*:\s*(?:(["'`])([^"'`]*)\1|(.))/.exec(entry);
      if (to?.[2]?.startsWith("/") && !to[2].includes("${")) continue; // the app's own address
      const source = /["'`]?\bsource\b["'`]?\s*:\s*["'`]([^"'`]+)/.exec(entry)?.[1];
      add(source);
    }
    if (rules.length === 0 && /\brewrites\b/.test(config)) found.add("*"); // built somewhere this can't see
  }
  for (const file of NUXT_FILES) {
    const config = text(file);
    for (const [, rule] of config.matchAll(/["'`](\/[^"'`]*)["'`]\s*:\s*\{[^{}]*\bproxy\s*:/g)) add(rule);
    for (const dev of config.matchAll(/\bdevProxy\s*:\s*\{/g)) addObject(config, dev.index + dev[0].length - 1);
  }
  for (const rule of text("netlify.toml").split(/\[\[redirects\]\]/).slice(1)) {
    const from = /^\s*from\s*=\s*["']([^"']+)/m.exec(rule)?.[1];
    const to = /^\s*to\s*=\s*["']([^"']+)/m.exec(rule)?.[1];
    const status = /^\s*status\s*=\s*(\d+)/m.exec(rule)?.[1];
    if (from && to && /^https?:/.test(to) && status === "200") add(from);
  }
  for (const file of REDIRECT_FILES) {
    for (const [, from] of text(file).matchAll(/^\s*(\/\S*)\s+https?:\S+\s+200!?\s*$/gm)) add(from);
  }
  for (const file of SERVER_FILES) {
    const code = text(file);
    if (!PROXY_CODE.test(code) && !file.includes("setupProxy")) continue;
    const before = found.size;
    for (const [, prefix, called] of code.matchAll(/\.(?:use|all)\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*(?:\w+\.)?(?:createProxyMiddleware|httpProxy|proxy)\b|(?:createProxyMiddleware|\bproxy)\(\s*["'`](\/[^"'`]*)["'`]/g)) add(prefix ?? called);
    for (const [, prefix] of code.matchAll(/\b(?:pathFilter|context)\s*:\s*["'`](\/[^"'`]*)/g)) add(prefix);
    if (found.size === before && code.trim() && PROXY_CODE.test(code)) found.add("*");
  }
  try {
    const { proxy } = JSON.parse(text("package.json")) as { proxy?: unknown };
    if (proxy) found.add("*");
  } catch { /* no package.json to read */ }
  return [...found];
}

const run = promisify(execFile);

/** Fields of lsof's machine output: "p123" for a process, "n*:5173" for what it has open. */
function parseLsof(text: string): { pid: string; value: string }[] {
  const out: { pid: string; value: string }[] = [];
  let pid = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n")) out.push({ pid, value: line.slice(1) });
  }
  return out;
}

/**
 * The ports listening on this machine and each process's working folder, so a server can be tied to
 * a project. Nothing is sent anywhere. Where the tools aren't there (Windows, a bare container) this
 * is empty, and the address is only checked by whether it answers.
 */
export async function listeners(): Promise<Listener[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 4000 });
    const open = parseLsof(stdout).flatMap(({ pid, value }) => {
      const port = Number(/:(\d+)$/.exec(value)?.[1]);
      return port ? [{ pid, port }] : [];
    });
    const pids = [...new Set(open.map((o) => o.pid))];
    if (pids.length === 0) return [];
    const { stdout: folders } = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { timeout: 4000 }).catch(() => ({ stdout: "" }));
    const cwd = new Map(parseLsof(folders).map(({ pid, value }) => [pid, value]));
    return open.map(({ pid, port }) => ({ port, ...(cwd.has(pid) ? { cwd: cwd.get(pid)! } : {}) }));
  } catch {
    return [];
  }
}

/** Addresses on this machine: going to one leaves nothing, and neither does looking at it. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w-]+\.localhost)$/i;

/**
 * Whether what answers there is a web page, not an API or a database. Redirects aren't followed: a
 * local app that sends / to a hosted sign-in would have this reach that service before anyone said
 * yes. One that goes on to this machine is an app with a page; one that leaves it can't be shown to
 * be, by a look that stays here. A missing page or a server error is no front door either.
 */
export async function servesPage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { accept: "text/html" }, redirect: "manual", signal: AbortSignal.timeout(2000) });
    void res.body?.cancel();
    if (res.status >= 300 && res.status < 400) return LOCAL_HOST.test(new URL(res.headers.get("location") ?? "", url).hostname) && res.headers.has("location");
    return res.status < 400 && /html/i.test(res.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}

/** A running dev server this tool started: it goes when the tool does. */
export interface Started {
  url: string;
  stop: () => Promise<void>;
}

/** How long a dev server gets to answer: a first start can compile for a while. */
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 3000;
/** The first local address a dev server prints about itself. Only that is read from what it prints, and none of it is shown. */
const SAYS_ADDRESS = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}/;
/**
 * The port in a line like "listening on 4413", "Server running at 0.0.0.0:8123" or "ready on port
 * 3100". Only after a word for being up, and never a time or a date: "started in 4413 ms" and "up at
 * 2026-11-05" aren't ports. A wrong number costs nothing: whether it answers is checked.
 */
const SAYS_PORT = /\b(?:listen\w*|running|serving|started|ready|up|available)\b[^\n]{0,40}?\b(?:on|at)\s+(?:port\s+)?(?:(?:[a-z]+:\/\/)?(?:[\w.-]+|\[[^\]]*\]|\*)?:)?(\d{4,5})(?![\w:-]|\.\d)/i;
/** How many of startDev's looks go by between each look at what's listening, which is slower than asking an address. */
const LISTENER_EVERY = 5;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The port a line a dev server printed says it's on, or nothing. */
export function saidPort(line: string): number | undefined {
  const port = SAYS_PORT.exec(line.replace(ANSI, ""))?.[1];
  return port && Number(port) <= 65535 ? Number(port) : undefined;
}

/** What startDev looks at besides the address it was told: what's listening, and whether it's a web page. */
export interface StartWatch {
  listeners: () => Promise<Listener[]>;
  servesPage: (url: string) => Promise<boolean>;
}

/** Said when a dev command was stopped without an address: true whether it never came up or came up where this couldn't see it. */
export const notFoundWords = (shown: string) => `${shown} was stopped: nothing answered where this tool looked, and it may have started on a port it didn't find. Start it yourself, then type its address.`;

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The dev command is a tree (npm, a shell, the server): its own group goes as one.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, signal);
  } catch {
    // gone already
  }
}

/**
 * Runs the project's dev command and waits until it answers. This runs the project's own code, so
 * it's only ever called after a person's yes for this very command, and never under --yes. What the
 * server prints is drained and thrown away: it may hold anything. Undefined when it didn't come up,
 * and then nothing of it is left running.
 */
export async function startDev(project: Pick<Project, "dir" | "dev" | "url">, reachable: (url: string) => Promise<boolean>, stop: AbortSignal, timeoutMs = START_TIMEOUT_MS, watch: StartWatch = { listeners, servesPage }): Promise<Started | undefined> {
  const dev = project.dev;
  if (!dev) return undefined;
  // What was listening before this started is someone else's, however well it answers. Taken first,
  // or a quick server would be in it.
  const before = new Set((await watch.listeners().catch(() => [] as Listener[])).map((l) => l.port));
  if (stop.aborted) return undefined;
  const portOf = (url: string) => new URL(url).port || "80";
  const notBefore = (url: string) => !before.has(Number(portOf(url)));
  return new Promise((done) => {
    const child = spawn(dev.command, dev.args, { cwd: project.dir, detached: process.platform !== "win32", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROWSER: "none" } });
    const said = new Set<string>();
    let settled = false;
    const leaveNothing = () => kill(child, "SIGKILL");
    process.on("exit", leaveNothing);
    const read = (chunk: Buffer) => {
      const text = chunk.toString().replace(ANSI, "");
      const address = SAYS_ADDRESS.exec(text)?.[0];
      if (address) said.add(address);
      for (const line of text.split(/\r?\n/)) {
        const port = saidPort(line);
        if (port) said.add(`http://localhost:${port}`);
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const stopNow = async () => {
      process.off("exit", leaveNothing);
      kill(child, "SIGTERM");
      await new Promise<void>((gone) => {
        if (child.exitCode !== null || child.signalCode !== null) return gone();
        const hard = setTimeout(() => {
          kill(child, "SIGKILL");
          gone();
        }, STOP_TIMEOUT_MS);
        hard.unref();
        child.once("close", () => {
          clearTimeout(hard);
          gone();
        });
      });
    };
    const finish = async (url: string | undefined) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(limit);
      stop.removeEventListener("abort", onStop);
      if (url) return done({ url, stop: stopNow });
      await stopNow();
      done(undefined);
    };
    const onStop = () => void finish(undefined);
    stop.addEventListener("abort", onStop);
    child.on("error", () => void finish(undefined));
    child.on("close", () => void finish(undefined));
    const limit = setTimeout(() => void finish(undefined), timeoutMs);
    /** A new port held by a process running from this folder that shows a web page: an app that picks its port in code. */
    const listening = async (): Promise<string | undefined> => {
      const found = await watch.listeners().catch(() => [] as Listener[]);
      const ports = [...new Set(found.filter((l) => !before.has(l.port) && l.cwd !== undefined && within(project.dir, l.cwd)).map((l) => l.port))].sort((a, b) => a - b);
      for (const port of ports) {
        if (await watch.servesPage(`http://localhost:${port}`)) return `http://localhost:${port}`;
      }
      return undefined;
    };
    /** What it said of itself goes first, then the address expected, then what's listening. */
    const answering = async (lookAtPorts: boolean): Promise<string | undefined> => {
      for (const url of [...said, project.url].filter(notBefore)) {
        if (await reachable(url)) return url;
      }
      return lookAtPorts ? listening() : undefined;
    };
    let asking = false;
    let looks = 0;
    const poll = setInterval(() => {
      if (asking) return;
      asking = true;
      void answering(++looks % LISTENER_EVERY === 0).then((url) => {
        asking = false;
        if (url) void finish(new URL(url).origin.replace("127.0.0.1", "localhost").replace("[::1]", "localhost"));
      });
    }, 400);
  });
}

/** The git repository a folder is in: the nearest folder above it with a .git. */
export function repoRootOf(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

/**
 * The storage key an app gave its sign-in library, from code already read on this machine. Literal
 * only: a key built at runtime isn't known, and the stand-in then says what it couldn't find.
 */
export function chosenStorageKey(texts: Iterable<string>): string | undefined {
  for (const text of texts) {
    const key = /\bstorageKey\s*:\s*["'`]([\w.:@/-]{3,120})["'`]/.exec(text)?.[1];
    if (key) return key;
  }
  return undefined;
}

/** What decides how a run deals with a sign-in it meets. */
export interface WallFacts {
  /** The address is on this machine. */
  local: boolean;
  /** A build, where nobody is there to have said yes. */
  ci: boolean;
  /** --code was typed for this run. */
  codeAsked: boolean;
  noCode: boolean;
  noStandIn: boolean;
  /** init's saved answer. */
  saved: boolean | undefined;
  /** There's an AI to read with. */
  ai: boolean;
  /** A real session, or real saves: a made-up session is never mixed with either. */
  real: boolean;
}

/**
 * What a run may do at a sign-in. Source code only leaves on a yes: --code for this run, or init's
 * saved answer, which holds for this project's local address and never for a build or an address
 * that may be someone else's. The stand-in sends nothing anywhere, so it needs no yes, but it only
 * ever runs on a local address, and never beside a real session.
 */
export function wallPlan(f: WallFacts): { code: boolean; standIn: boolean } {
  const code = f.ai && !f.noCode && (f.codeAsked || (f.saved === true && f.local && !f.ci));
  return { code, standIn: f.local && !f.ci && !f.noStandIn && !f.real };
}
