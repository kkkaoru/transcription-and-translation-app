import { describe, expect, it } from "vitest";
import { comparisonPathSummary, conversionPathLabel } from "./path-labels";

describe("comparison path labels", () => {
  it("describes Worker-side AzooKey WASM without marketing Vibrato", () => {
    expect(conversionPathLabel("worker-vibrato")).toBe("Worker AzooKey WASM");
    expect(conversionPathLabel("worker-vibrato").toLowerCase()).not.toContain("vibrato");
    expect(conversionPathLabel("browser-vibrato")).toBe(
      "Browser WASM pre-pass → Worker AzooKey WASM",
    );
    expect(conversionPathLabel("browser-vibrato").toLowerCase()).not.toContain("vibrato");
    expect(conversionPathLabel("browser-vibrato")).toContain("pre-pass");
  });

  it("marks browser WASM pre-pass as unconfigured when settings are absent", () => {
    expect(comparisonPathSummary("worker-vibrato", false)).toBe("Web Speech → Worker AzooKey WASM");
    expect(comparisonPathSummary("worker-vibrato", true)).toBe("Web Speech → Worker AzooKey WASM");
    expect(comparisonPathSummary("browser-vibrato", true)).toBe(
      "Web Speech → Browser WASM pre-pass → Worker AzooKey WASM",
    );
    expect(comparisonPathSummary("browser-vibrato", false)).toBe(
      "Web Speech → Browser WASM pre-pass（未設定） → Worker AzooKey WASM",
    );
    expect(comparisonPathSummary("browser-vibrato", false)).toContain("未設定");
  });
});
