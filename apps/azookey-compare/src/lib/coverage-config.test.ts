import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

type CoverageConfig = {
  include?: readonly string[];
  exclude?: readonly string[];
  thresholds?: Record<string, number>;
};

describe("azookey-compare coverage configuration", () => {
  it("measures library modules including the inference proxy", () => {
    const coverage = config.test?.coverage as unknown as CoverageConfig | undefined;
    expect(coverage?.include).toEqual(["src/lib/**/*.ts"]);
    expect(coverage?.exclude).toEqual(["src/**/*.test.ts", "src/lib/vibrato-browser.ts"]);
    expect(coverage?.thresholds).toEqual({
      statements: 95,
      branches: 95,
      functions: 95,
      lines: 95,
    });
  });
});
