// What a folder is, worked out from the folder, checked with made-up projects and nothing running:
//   node --test cli/project.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chosenStorageKey, detectProject, detectUrl, listeners, notFoundWords, proxiedPaths, repoRootOf, saidPort, servedFromElsewhere, servesPage, standInExpected, startDev, wallPlan, within } from "./project.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cm-project-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, content: unknown) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
};

describe("which app", () => {
  it("is this folder when it's one", () => {
    write("package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    const project = detectProject(dir);
    assert.equal(project.folder, ".");
    assert.equal(project.framework, "Vite");
    assert.equal(project.url, "http://localhost:5173");
    assert.equal(project.dev?.shown, "npm run dev");
  });

  it("is found below a repository's root, and a library beside it isn't", () => {
    write("package.json", { workspaces: ["apps/*", "packages/*"] });
    write("packages/ui/package.json", { scripts: { build: "tsc" } });
    write("apps/web/package.json", { scripts: { dev: "next dev -p 3100" }, dependencies: { next: "1" } });
    const project = detectProject(dir);
    assert.equal(project.folder, "apps/web");
    assert.equal(project.url, "http://localhost:3100");
    assert.equal(project.framework, "Next.js");
  });

  it("is the folder a server is running from, over any guess", () => {
    write("apps/admin/package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    write("apps/web/package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    const project = detectProject(dir, [{ port: 6001, cwd: join(dir, "apps/web") }]);
    assert.equal(project.folder, "apps/web");
    assert.deepEqual(project.running, [6001]);
  });

  it("isn't tied to a server by anything but its working folder", () => {
    write("package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    assert.deepEqual(detectProject(dir, [{ port: 5173, cwd: tmpdir() }, { port: 5173 }]).running, []);
  });

  it("knows a server framework by its own file", () => {
    write("manage.py", "");
    const project = detectProject(dir);
    assert.equal(project.framework, "Django");
    assert.equal(project.dev?.shown, "python manage.py runserver");
    assert.equal(project.url, "http://localhost:8000");
    assert.equal(project.auth?.held, "server");
  });

  it("still says something for a folder that's no app", () => {
    const project = detectProject(dir);
    assert.equal(project.dev, undefined);
    assert.equal(project.url, "http://localhost:3000");
  });
});

describe("how it's run", () => {
  it("goes by the lockfile, here or above", () => {
    write("pnpm-lock.yaml", "");
    write("apps/web/package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    assert.equal(detectProject(dir).dev?.shown, "pnpm dev");
  });

  it("falls back to a start script, and says a hook that runs first", () => {
    write("package.json", { scripts: { start: "react-scripts start", prestart: "node migrate.js" }, dependencies: { "react-scripts": "1" } });
    const { dev, url } = detectProject(dir);
    assert.equal(dev?.shown, "npm run start");
    assert.equal(dev?.runsFirst, "prestart");
    assert.equal(url, "http://localhost:3000");
  });

  it("reads a port from a framework's config as text", () => {
    write("package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    write("vite.config.ts", "export default defineConfig({ plugins: [], server: { host: true, port: 5175 } })");
    assert.deepEqual(detectUrl(dir), { url: "http://localhost:5175", from: "vite.config.ts" });
  });

  it("never reads an env file for a port", () => {
    write("package.json", { scripts: { dev: "vite" }, devDependencies: { vite: "1" } });
    write(".env", "PORT=9999\n");
    assert.equal(detectUrl(dir).url, "http://localhost:5173");
  });
});

describe("how people sign in", () => {
  const auth = (deps: Record<string, string>) => {
    write("package.json", { dependencies: deps });
    return detectProject(dir).auth;
  };

  it("tells the browser's from the server's", () => {
    assert.deepEqual(auth({ "@supabase/supabase-js": "2" }), { name: "Supabase", held: "browser" });
    assert.deepEqual(auth({ "@supabase/supabase-js": "2", "@supabase/ssr": "1" }), { name: "Supabase", held: "server" });
    assert.deepEqual(auth({ "next-auth": "4" }), { name: "Auth.js", held: "server" });
    assert.deepEqual(auth({ firebase: "10" }), { name: "Firebase", held: "browser" });
  });

  it("only expects a stand-in where there is one", () => {
    assert.equal(standInExpected({ name: "Supabase", held: "browser" }), true);
    assert.equal(standInExpected({ name: "Supabase", held: "server" }), false);
    assert.equal(standInExpected({ name: "Firebase", held: "browser" }), false);
    assert.equal(standInExpected(undefined), false);
  });
});

describe("what a sign-in may be met with", () => {
  const facts = { local: true, ci: false, codeAsked: false, noCode: false, noStandIn: false, saved: undefined, ai: true, real: false };

  it("reads no code without a yes", () => {
    assert.equal(wallPlan(facts).code, false);
    assert.equal(wallPlan({ ...facts, saved: false }).code, false);
    assert.equal(wallPlan({ ...facts, saved: true }).code, true);
    assert.equal(wallPlan({ ...facts, codeAsked: true }).code, true);
  });

  it("holds a saved yes to the local address, and off a build", () => {
    assert.equal(wallPlan({ ...facts, saved: true, local: false }).code, false);
    assert.equal(wallPlan({ ...facts, saved: true, ci: true }).code, false);
    assert.equal(wallPlan({ ...facts, codeAsked: true, local: false }).code, true);
  });

  it("lets --no-code win, and needs an AI", () => {
    assert.equal(wallPlan({ ...facts, saved: true, noCode: true }).code, false);
    assert.equal(wallPlan({ ...facts, saved: true, ai: false }).code, false);
  });

  it("never stands in off this machine, in a build, or beside a real session", () => {
    assert.equal(wallPlan(facts).standIn, true);
    assert.equal(wallPlan({ ...facts, local: false }).standIn, false);
    assert.equal(wallPlan({ ...facts, ci: true }).standIn, false);
    assert.equal(wallPlan({ ...facts, real: true }).standIn, false);
    assert.equal(wallPlan({ ...facts, noStandIn: true }).standIn, false);
  });
});

describe("starting and stopping", () => {
  const up = (url: string) => fetch(url).then(() => true, () => false);
  const script = (body: string) => write("server.mjs", body);
  const SERVER = (port: number) => `import { createServer } from "node:http";
createServer((_q, r) => r.end("hi")).listen(${port}, "127.0.0.1", () => console.log("  \\x1b[32m➜\\x1b[0m  Local:   http://127.0.0.1:${port}/"));`;
  const freePort = () => new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  const dev = { command: process.execPath, args: ["server.mjs"], shown: "node server.mjs" };

  it("comes up where the server says it did, and leaves nothing running", async () => {
    const port = await freePort();
    script(SERVER(port));
    const started = await startDev({ dir, dev, url: "http://localhost:1" }, up, new AbortController().signal);
    assert.equal(started?.url, `http://localhost:${port}`);
    await started!.stop();
    assert.equal(await up(`http://127.0.0.1:${port}/`), false);
  });

  it("gives up on one that exits, and on one that never answers", async () => {
    script("process.exit(1)");
    assert.equal(await startDev({ dir, dev, url: "http://localhost:1" }, up, new AbortController().signal), undefined);
    script("setInterval(() => {}, 1000)");
    assert.equal(await startDev({ dir, dev, url: "http://localhost:1" }, up, new AbortController().signal, 900), undefined);
  });

  it("stops when told to", async () => {
    script("setInterval(() => {}, 1000)");
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    assert.equal(await startDev({ dir, dev, url: "http://localhost:1" }, up, stop.signal), undefined);
  });
});

describe("an app that picks its port in code", () => {
  const up = (url: string) => fetch(url, { redirect: "manual" }).then(() => true, () => false);
  const dev = { command: process.execPath, args: ["server.mjs"], shown: "node server.mjs" };
  const freePort = () => new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
  const page = (port: number, say = "") => `import { createServer } from "node:http";
createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end("<h1>hi</h1>"); }).listen(${port}, "127.0.0.1", () => console.log(${JSON.stringify(say)}));`;
  const nothingExpected = "http://localhost:1";

  it("reads a port from what a server says of itself", () => {
    for (const [line, port] of [["listening on 4413", 4413], ["Server running at 0.0.0.0:8123", 8123], ["\x1b[32mready\x1b[0m on port 3100.", 3100], ["Listening at http://[::1]:5050/", 5050], ["app started on :9090", 9090]] as const) assert.equal(saidPort(line), port, line);
    for (const line of ["started in 4413 ms", "ready at 2026-11-05", "connected to the database", "up at 12:30:45", "listening on 127.0.0.1", "listening on 99999", "bundled 4413 modules"]) assert.equal(saidPort(line), undefined, line);
  });

  it("finds an app that only says 'listening on' its port", async () => {
    const port = await freePort();
    write("server.mjs", page(port, `listening on ${port}`));
    const started = await startDev({ dir, dev, url: nothingExpected }, up, new AbortController().signal, 8000, { listeners: async () => [], servesPage: async () => false });
    assert.equal(started?.url, `http://localhost:${port}`);
    await started!.stop();
  });

  it("finds a new port held by a process from the project's folder, when the app says nothing", { skip: process.platform === "win32" }, async () => {
    const port = await freePort();
    write("server.mjs", page(port));
    const started = await startDev({ dir, dev, url: nothingExpected }, up, new AbortController().signal, 10_000);
    assert.equal(started?.url, `http://localhost:${port}`);
    await started!.stop();
    assert.equal(await up(`http://127.0.0.1:${port}/`), false);
  });

  it("takes neither a port that was there before, nor another folder's, nor one that shows no page", async () => {
    write("server.mjs", "setInterval(() => {}, 1000)");
    let looks = 0;
    const asked: string[] = [];
    const listening = async () => (looks++ === 0 ? [{ port: 5001, cwd: dir }] : [{ port: 5001, cwd: dir }, { port: 5002, cwd: tmpdir() }, { port: 5003 }, { port: 5004, cwd: dir }]);
    const started = await startDev({ dir, dev, url: nothingExpected }, async () => false, new AbortController().signal, 3000, { listeners: listening, servesPage: async (url) => (asked.push(url), false) });
    assert.equal(started, undefined);
    assert.deepEqual([...new Set(asked)], ["http://localhost:5004"]);
  });

  it("doesn't take the expected address when something else was already there", async () => {
    write("server.mjs", "setInterval(() => {}, 1000)");
    const started = await startDev({ dir, dev, url: "http://localhost:5001" }, async () => true, new AbortController().signal, 900, { listeners: async () => [{ port: 5001, cwd: "/somewhere/else" }], servesPage: async () => false });
    assert.equal(started, undefined);
  });

  it("says the app may have started somewhere it didn't look, and how to go on", () => {
    assert.match(notFoundWords("npm start"), /npm start was stopped.*may have started on a port.*Start it yourself, then type its address/);
  });
});

describe("whether a local address shows a page", () => {
  const serve = (reply: (res: import("node:http").ServerResponse) => void) => new Promise<{ url: string; heard: () => number; close: () => void }>((done) => {
    let heard = 0;
    const server = createServer((_q, res) => (heard++, reply(res))).listen(0, "0.0.0.0", () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard: () => heard, close: () => server.close() }));
  });
  const html = (res: import("node:http").ServerResponse) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>hi</h1>");

  it("doesn't go to another host when a local app redirects there", async () => {
    const outside = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "192.0.2.1";
    const away = await serve(html);
    const port = new URL(away.url).port;
    const local = await serve((res) => res.writeHead(302, { location: `http://${outside}:${port}/sign-in?from=local` }).end());
    assert.equal(await servesPage(local.url), false);
    assert.equal(away.heard(), 0, "the other host heard nothing");
    local.close();
    away.close();
  });

  it("counts a redirect that stays on this machine as a page, without following it", async () => {
    const target = await serve(html);
    const onward = await serve((res) => res.writeHead(302, { location: `${target.url.replace("127.0.0.1", "localhost")}/login` }).end());
    const samePlace = await serve((res) => res.writeHead(307, { location: "/login" }).end());
    assert.equal(await servesPage(onward.url), true);
    assert.equal(await servesPage(samePlace.url), true);
    assert.equal(target.heard(), 0);
    onward.close();
    samePlace.close();
    target.close();
  });

  it("isn't taken in by a redirect with no address, an API, or a missing page", async () => {
    for (const reply of [(res: import("node:http").ServerResponse) => res.writeHead(302).end(), (res: import("node:http").ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end("{}"), (res: import("node:http").ServerResponse) => res.writeHead(404, { "content-type": "text/html" }).end("Cannot GET /")]) {
      const server = await serve(reply);
      assert.equal(await servesPage(server.url), false);
      server.close();
    }
    const page = await serve(html);
    assert.equal(await servesPage(page.url), true);
    page.close();
  });
});

describe("what's listening", () => {
  it("finds a server and its working folder here", { skip: process.platform === "win32" }, async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((done) => server.once("listening", done));
    const { port } = server.address() as AddressInfo;
    const found = (await listeners()).find((l) => l.port === port);
    server.close();
    assert.ok(found, "listed");
    assert.ok(found.cwd && within(found.cwd, process.cwd()), String(found.cwd));
  });
});

describe("small things", () => {
  it("takes a chosen storage key only as a literal", () => {
    assert.equal(chosenStorageKey(["createClient(a, b, { auth: { storageKey: 'my-app.auth.v1' } })"]), "my-app.auth.v1");
    assert.equal(chosenStorageKey(["storageKey: key", "const storageKey = 1"]), undefined);
  });

  it("finds the repository from a folder inside it", () => {
    write(".git/HEAD", "");
    write("apps/web/x.txt", "");
    assert.equal(repoRootOf(join(dir, "apps/web")), dir);
    assert.equal(within(dir, join(dir, "apps")), true);
    assert.equal(within(join(dir, "apps"), dir), false);
    assert.equal(within(dir, `${dir}-other`), false);
  });
});

describe("what a dev server hands on", () => {
  const folder = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "cm-proxy-"));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  };

  it("reads Vite's proxy keys, plain and as expressions, and nothing else in the file", () => {
    const dir = folder({ "vite.config.ts": `export default { resolve: { alias: { "/src": "x" } }, server: { port: 5175, proxy: { "/backend": "http://real.example", "^/data/.*": { target: "http://real.example", rewrite: (p) => p, headers: { "/not-a-key": "x" } } } } };` });
    assert.deepEqual(proxiedPaths(dir).sort(), ["/backend", "/data"]);
  });

  it("reads Next's rewrites to another server, and leaves its own alone", () => {
    const dir = folder({ "next.config.mjs": `export default { rewrites: async () => [{ source: "/backend/:path*", destination: "https://real.example/:path*" }, { source: "/old", destination: "/new" }] };` });
    assert.deepEqual(proxiedPaths(dir), ["/backend"]);
  });

  it("reads setupProxy, and takes package.json's proxy for everything", () => {
    assert.deepEqual(proxiedPaths(folder({ "src/setupProxy.js": `module.exports = (app) => { app.use("/backend", createProxyMiddleware({ target: "http://real.example" })); };` })), ["/backend"]);
    assert.deepEqual(proxiedPaths(folder({ "package.json": `{ "proxy": "http://localhost:4000" }` })), ["*"]);
  });

  it("reads the other places a project says so", () => {
    const backend = { "next.config.js": `module.exports = { rewrites: async () => [{ source: "/svc/:p*", destination: \`\${process.env.API}/:p*\` }] };` };
    const cases: Record<string, string>[] = [
      backend,
      { "next.config.mjs": `export default { rewrites: async () => [{ destination: process.env.API + "/:p*", source: "/svc/:p*" }] };` },
      { "vercel.json": `{ "rewrites": [{ "source": "/svc/:p*", "destination": "https://real.example/:p*" }] }` },
      { "netlify.toml": `[[redirects]]\nfrom = "/svc/*"\nto = "https://real.example/:splat"\nstatus = 200\n` },
      { "public/_redirects": `/svc/* https://real.example/:splat 200\n` },
      { "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/svc/**": { proxy: "https://real.example/**" } } });` },
      { "nuxt.config.js": `export default { nitro: { devProxy: { "/svc": "https://real.example" } } };` },
      { "webpack.config.ts": `export default { devServer: { proxy: { "/svc": "https://real.example" } } };` },
      { "webpack.dev.js": `module.exports = { devServer: { proxy: [{ context: ["/svc"], target: "https://real.example" }] } };` },
      { "proxy.conf.js": `module.exports = { "/svc": { target: "https://real.example" } };` },
      { ".proxyrc.json": `{ "/svc": { "target": "https://real.example" } }` },
      { "astro.config.mjs": `export default { vite: { server: { proxy: { "/svc": "https://real.example" } } } };` },
      { "server.js": `app.use("/svc", createProxyMiddleware({ target: "https://real.example" }));` },
      { "dev-server.mjs": `app.use("/svc", proxy("https://real.example"));` },
    ];
    for (const files of cases) assert.deepEqual(proxiedPaths(folder(files)), ["/svc"], Object.keys(files)[0]!);
  });

  it("takes a proxy it can see and can't read for everything", () => {
    const cases: Record<string, string>[] = [
      { "vite.config.ts": `const P = "/svc"; export default { server: { proxy: { [P]: "https://real.example" } } };` },
      { "vite.config.ts": `import { proxy } from "./proxy"; export default { server: { proxy } };` },
      { "vite.config.ts": `export default { server: { proxy: makeProxy() } };` },
      { "vite.config.ts": `export default { server: { proxy: { ...shared } } };` },
      { "webpack.dev.js": `module.exports = { devServer: { proxy: [makeOne()] } };` },
      { "next.config.js": `module.exports = { rewrites: makeRewrites };` },
      { "next.config.js": `module.exports = { rewrites: async () => [{ source: SOURCE, destination: "https://real.example" }] };` },
      { "proxy.conf.js": `module.exports = build();` },
      { "server.js": `const api = createProxyMiddleware({ target }); app.use(path, api);` },
    ];
    for (const files of cases) assert.deepEqual(proxiedPaths(folder(files)), ["*"], Object.values(files)[0]!);
  });

  it("isn't fooled by what only looks like one", () => {
    const cases: Record<string, string>[] = [
      { "vercel.json": `{ "rewrites": [{ "source": "/((?!assets|api).*)", "destination": "/index.html" }], "headers": [{ "source": "/(.*)", "headers": [] }] }` },
      { "vercel.json": `{ "redirects": [{ "source": "/old", "destination": "https://elsewhere.example/", "permanent": true }] }` },
      { "next.config.js": `module.exports = { redirects: async () => [{ source: "/old", destination: "https://elsewhere.example/", permanent: true }] };` },
      { "netlify.toml": `[[redirects]]\nfrom = "/old"\nto = "https://elsewhere.example/"\nstatus = 301\n` },
      { "public/_redirects": `/old https://elsewhere.example/ 301\n/* /index.html 200\n` },
      { "nuxt.config.ts": `export default defineNuxtConfig({ routeRules: { "/about": { prerender: true } } });` },
      { "vite.config.ts": `export default { server: { proxy: false } };` },
      { "vite.config.ts": `// server: { proxy: { "/old": "https://real.example" } }\nexport default { server: { port: 1 } };` },
      { "vite.config.ts": `/* proxy: makeProxy() */\nexport default { plugins: [httpProxyFree()] };` },
      { "server.js": `app.use("/static", express.static("public")); app.get("/", home);` },
    ];
    for (const files of cases) assert.deepEqual(proxiedPaths(folder(files)), [], Object.values(files)[0]!);
  });

  it("a server's other mounts aren't its proxy's", () => {
    assert.deepEqual(proxiedPaths(folder({ "server.js": `app.use("/static", express.static("public")); app.use("/svc", createProxyMiddleware({ target }));` })), ["/svc"]);
  });

  it("finds nothing where nothing's said, and takes an expression it can't read for everything", () => {
    assert.deepEqual(proxiedPaths(folder({ "vite.config.ts": `export default { server: { port: 1 } };` })), []);
    assert.deepEqual(proxiedPaths(folder({ "vite.config.ts": `export default { server: { proxy: { "^/(?!src).*": "http://real.example" } } };` })), ["*"]);
  });
});

describe("a server on this port from another folder", () => {
  it("is told apart from this folder's, and from a folder above or below it", () => {
    // Written as this machine writes a folder (D:\work\clinic on Windows).
    const [petshop, clinic, app] = [resolve("/work/petshop"), resolve("/work/clinic"), resolve("/work/clinic/app")];
    const found = [{ port: 5301, cwd: petshop }, { port: 5302, cwd: app }, { port: 5303 }];
    assert.equal(servedFromElsewhere(5301, clinic, found), petshop);
    assert.equal(servedFromElsewhere(5302, clinic, found), undefined);
    assert.equal(servedFromElsewhere(5303, clinic, found), undefined);
    assert.equal(servedFromElsewhere(9999, clinic, found), undefined);
  });
});
