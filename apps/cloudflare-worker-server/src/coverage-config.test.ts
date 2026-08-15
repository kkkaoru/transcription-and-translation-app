import { describe, expect, it } from "vitest";
import config from "../vitest.config";

type CoverageConfig = {
  include?: readonly string[];
  exclude?: readonly string[];
  thresholds?: Record<string, number>;
};

describe("Worker coverage configuration", () => {
  it("measures every TypeScript runtime module while excluding test-only files", () => {
    const coverage = config.test?.coverage as unknown as CoverageConfig | undefined;

    expect(coverage?.include).toEqual(["src/**/*.ts"]);
    expect(coverage?.exclude).toEqual([
      "src/**/*.test.ts",
      "src/**/*.d.ts",
      "src/wasm.test-stub.ts",
      // Vitest replaces this Worker-only Wasm import with wasm.test-stub.ts,
      // so the real module is unreachable in unit tests.
      "src/azookey-wasm.ts",
    ]);
  });

  it("keeps the repository coverage gate at 95 percent for every metric", () => {
    const coverage = config.test?.coverage as unknown as CoverageConfig | undefined;
    expect(coverage?.thresholds).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });
});
