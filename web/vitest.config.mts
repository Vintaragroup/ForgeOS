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
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
