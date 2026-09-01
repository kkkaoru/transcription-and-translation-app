// Runs with Bun during build and test.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/i18n.ts", "src/container-usage.ts", "src/language-api.ts", "src/usage-api.ts"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
