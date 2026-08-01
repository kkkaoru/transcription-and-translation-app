import { describe, expect, it } from "vitest";
import { attemptedPathLabel, comparisonPathSummary, conversionPathLabel } from "./path-labels";

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

  it("never advertises stages a failed row did not run", () => {
    expect(attemptedPathLabel("browser-vibrato")).toBe(
      "Browser WASM pre-pass → Worker AzooKey WASM",
    );
    expect(attemptedPathLabel("worker-vibrato")).toBe("Worker AzooKey WASM");
    expect(attemptedPathLabel("browser-vibrato", "setup")).toBe("未実行");
    expect(attemptedPathLabel("worker-vibrato", "setup")).toBe("未実行");
    expect(attemptedPathLabel("worker-vibrato", "browser-wasm")).toBe(
      "Worker AzooKey WASM（失敗）",
    );
    expect(attemptedPathLabel("worker-vibrato", "worker")).toBe("Worker AzooKey WASM（失敗）");
    expect(attemptedPathLabel("browser-vibrato", "browser-wasm")).toBe(
      "Browser WASM pre-pass（失敗） / Worker AzooKey WASM 未実行",
    );
    expect(attemptedPathLabel("browser-vibrato", "worker")).toBe(
      "Browser WASM pre-pass → Worker AzooKey WASM（失敗）",
    );
  });

  it("keeps a refused request from claiming the converter ran", () => {
    // busy / unauthorized / contract errors are answered before the converter
    // is invoked, so the label must not report a WASM conversion failure.
    const label = attemptedPathLabel("browser-vibrato", "worker-request");
    expect(label).toBe(
      "Browser WASM pre-pass 完了 / Worker がリクエストを拒否（AzooKey WASM 未実行）",
    );
    expect(label).not.toContain("pre-pass（失敗）");
    expect(label).not.toContain("AzooKey WASM（失敗）");
    expect(attemptedPathLabel("worker-vibrato", "worker-request")).toBe(
      "Worker がリクエストを拒否（AzooKey WASM 未実行）",
    );
    // A genuine conversion failure must stay specific rather than collapsing
    // into the refusal wording.
    expect(attemptedPathLabel("worker-vibrato", "worker")).toBe("Worker AzooKey WASM（失敗）");
  });

  it("keeps a succeeded pre-pass out of a failure to reach the Worker", () => {
    // Losing the Worker client after the pre-pass finished must not report the
    // pre-pass as failed, nor claim a Worker conversion that never ran.
    const label = attemptedPathLabel("browser-vibrato", "worker-connect");
    expect(label).toBe("Browser WASM pre-pass 完了 / Worker AzooKey WASM 未実行");
    expect(label).not.toContain("pre-pass（失敗）");
    expect(attemptedPathLabel("worker-vibrato", "worker-connect")).toBe(
      "Worker AzooKey WASM 未実行",
    );
  });
});
