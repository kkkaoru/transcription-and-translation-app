import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/core/**/*.test.ts", "src/i18n/**/*.test.{ts,tsx}", "src/**/*.smoke.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/i18n/messages.ts"],
      exclude: [
        "src/core/**/*.test.ts",
        "src/i18n/**/*.test.ts",
        "src/core/types.ts",
        "src/core/bridge.ts",
      ],
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
