import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const wasmTestStub = fileURLToPath(new URL("./src/wasm.test-stub.ts", import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "mock-azookey-wasm",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          (importer?.endsWith("/src/index.ts") || importer?.endsWith("/src/index.js")) &&
          source === "./azookey-wasm.js"
        ) {
          return wasmTestStub;
        }
        if (
          (importer?.endsWith("/src/index.ts") || importer?.endsWith("/src/index.js")) &&
          source === "../wasm/vibrato_wasm_bg.wasm"
        ) {
          return wasmTestStub;
        }
        return undefined;
      },
    },
  ],
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/wasm.test-stub.ts",
        "src/cloudflare-workers-stub.ts",
        "src/user-lexicon-do.ts",
        "src/azookey-wasm.ts",
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
