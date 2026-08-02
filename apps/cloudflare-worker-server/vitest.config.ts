import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const wasmTestStub = fileURLToPath(new URL("./src/wasm.test-stub.ts", import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "mock-azookey-wasm",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/src/index.ts") && source === "./azookey-wasm.js") {
          return wasmTestStub;
        }
        if (importer?.endsWith("/src/index.ts") && source === "../wasm/vibrato_wasm_bg.wasm") {
          return wasmTestStub;
        }
        return undefined;
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/wasm.test-stub.ts"],
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
