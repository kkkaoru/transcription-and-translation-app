import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // HTTP routing and input validation live in the portable core package and
      // are exercised through this adapter's contract tests. Keep this metric
      // focused on the Node/Parapper implementation that remains here.
      exclude: ["src/**/*.test.ts", "src/main.ts", "src/server.ts"],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
      reporter: ["text", "html", "json-summary"],
      clean: true,
      cleanOnRerun: true,
    },
  },
});
