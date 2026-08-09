import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      // The older token-stream worker adapter remains covered by its dedicated
      // protocol tests, but is not part of the live page path. Architecture UI
      // WIP stays untracked and is not part of the shipped coverage gate.
      exclude: [
        "src/**/*.test.ts",
        "src/lib/vibrato-browser.ts",
        "src/lib/architecture-assets.ts",
        "src/lib/architecture-diagram.ts",
        "src/lib/architecture-dialog.ts",
        "src/lib/speech-caption-display.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
      reporter: ["text", "json-summary"],
    },
  },
});
