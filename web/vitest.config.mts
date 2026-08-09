import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    // Test files share one forgeos_test Postgres database with overlapping
    // tables (Company/Opportunity/Estimate). Running files in parallel
    // races their afterEach cleanups against each other's fixtures --
    // force sequential execution instead.
    fileParallelism: false,
    // Vitest's default exclude list doesn't cover .next -- output:
    // "standalone" (next.config.ts) copies the whole src/ tree into
    // .next/standalone, so without this every *.test.ts runs twice, once
    // from a build artifact whose relative fixture paths don't resolve.
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
