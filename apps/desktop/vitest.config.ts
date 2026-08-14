import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/core/**/*.test.ts",
      "src/i18n/**/*.test.{ts,tsx}",
      "src/overlay/**/*.test.ts",
      "src/**/*.smoke.test.tsx",
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/core/**/*.ts",
        "src/i18n/messages.ts",
        // Measure display decisions at their hook boundary. MainApp.tsx is
        // Tauri orchestration; move reusable display logic into core/hooks and
        // add it here rather than locking its implementation to broad mocks.
        "src/live/useCaptionFreshness.ts",
        "src/live/useCaptionHoldClear.ts",
        "src/live/useProgressiveCaptionReveal.ts",
        "src/overlay/**/*.{ts,tsx}",
      ],
      exclude: [
        "src/core/**/*.test.ts",
        "src/i18n/**/*.test.ts",
        "src/overlay/**/*.test.ts",
        "src/overlay/**/*.test.tsx",
        "src/overlay/**/*.smoke.test.tsx",
        "src/core/types.ts",
        "src/core/bridge.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
      reporter: ["text", "html", "json-summary", "lcov"],
    },
  },
});
