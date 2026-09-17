import * as path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

// Resolve workspace packages to SOURCE so `vitest run` works without a prior
// build; production/CI still builds first (gate-p0 runs `tsc -b`).
const pkgs = [
  "schema",
  "capture-core",
  "protocol-catalog",
  "fixtures",
  "security",
  "artifacts",
  "archive-service",
  "sync",
  "mcp-contract",
  "analysis",
  "browser-adapter",
];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      pkgs.map((p) => [`@arena/${p}`, path.join(root, "packages", p, "src", "index.ts")]),
    ),
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      enabled: false,
    },
  },
});
