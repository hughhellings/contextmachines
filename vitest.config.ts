import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "schemas", root: "packages/schemas", environment: "node" } },
      { test: { name: "rules-core", root: "packages/rules-core", environment: "node" } },
      { test: { name: "snippet", root: "packages/snippet", environment: "happy-dom", execArgv: ["--no-experimental-webstorage"], setupFiles: ["./test/quiet-frames.ts"] } },
      { test: { name: "understanding", root: "packages/understanding", environment: "node" } },
      { test: { name: "scanner", root: "packages/scanner", environment: "node", testTimeout: 30000 } },
    ],
  },
});
