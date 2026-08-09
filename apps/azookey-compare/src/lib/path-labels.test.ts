import { describe, expect, it } from "vitest";
import {
  attemptedPathLabel,
  comparisonPathSteps,
  comparisonPathSummary,
  conversionPathLabel,
  rowPathLabel,
} from "./path-labels";

describe("comparison path labels", () => {
  it("describes the configured Worker Vibrato and AzooKey stages", () => {
    expect(conversionPathLabel("worker-vibrato")).toBe("Worker Vibrato → Worker AzooKey WASM");
    expect(conversionPathLabel("worker-vibrato").toLowerCase()).toContain("vibrato");
    expect(conversionPathLabel("browser-vibrato")).toBe(
      "Browser Vibrato WASM → Browser AzooKey WASM",
    );
    expect(conversionPathLabel("browser-vibrato").toLowerCase()).toContain("vibrato");
  });

  it("marks browser Vibrato WASM as unconfigured when settings are absent", () => {
    expect(comparisonPathSummary("worker-vibrato", false)).toBe(
      "Web Speech → Worker Vibrato → AzooKey WASM",
    );
    expect(comparisonPathSummary("worker-vibrato", true)).toBe(
      "Web Speech → Worker Vibrato → AzooKey WASM",
    );
    expect(comparisonPathSummary("browser-vibrato", true)).toBe(
      "Web Speech → Browser Vibrato WASM → Browser AzooKey WASM",
    );
    expect(comparisonPathSummary("browser-vibrato", false)).toBe(
      "Web Speech → Browser Vibrato WASM（未設定） → Browser AzooKey WASM",
    );
    expect(comparisonPathSummary("browser-vibrato", false)).toContain("未設定");
    expect(comparisonPathSteps("worker-vibrato", true).map((step) => step.location)).toEqual([
      "browser",
      "worker",
      "worker",
    ]);
    expect(comparisonPathSteps("browser-vibrato", true).map((step) => step.location)).toEqual([
      "browser",
      "browser",
      "browser",
    ]);
    expect(comparisonPathSteps("browser-vibrato", false)[1]?.warning).toBe("未設定");
  });

  it("never advertises stages a failed row did not run", () => {
    expect(attemptedPathLabel("browser-vibrato")).toBe(
      "Browser Vibrato WASM → Browser AzooKey WASM",
    );
    expect(attemptedPathLabel("worker-vibrato")).toBe("Worker Vibrato → Worker AzooKey WASM");
    expect(attemptedPathLabel("browser-vibrato", "setup")).toBe("未実行");
    expect(attemptedPathLabel("worker-vibrato", "setup")).toBe("未実行");
    expect(attemptedPathLabel("worker-vibrato", "browser-wasm")).toBe(
      "Browser Vibrato WASM（失敗） / Worker AzooKey WASM 未実行",
    );
    expect(attemptedPathLabel("worker-vibrato", "worker")).toBe(
      "Worker Vibrato / AzooKey WASM（失敗）",
    );
    expect(attemptedPathLabel("browser-vibrato", "browser-wasm")).toBe(
      "Browser Vibrato WASM（失敗） / Browser AzooKey WASM 未実行",
    );
    expect(attemptedPathLabel("browser-vibrato", "browser-azookey")).toBe(
      "Browser Vibrato WASM → Browser AzooKey WASM（失敗）",
    );
    expect(attemptedPathLabel("browser-vibrato", "worker")).toBe(
      "Browser Vibrato WASM → Browser AzooKey WASM（失敗）",
    );
  });

  it("keeps a refused request from claiming the converter ran", () => {
    // busy / unauthorized / contract errors are answered before the converter
    // is invoked, so the label must not report a WASM conversion failure.
    const label = attemptedPathLabel("browser-vibrato", "worker-request");
    expect(label).toBe(
      "Browser Vibrato WASM 完了 / Worker がリクエストを拒否（AzooKey WASM 未実行）",
    );
    expect(label).not.toContain("pre-pass（失敗）");
    expect(label).not.toContain("AzooKey WASM（失敗）");
    expect(attemptedPathLabel("worker-vibrato", "worker-request")).toBe(
      "Worker がリクエストを拒否（Vibrato / AzooKey WASM 未実行）",
    );
    expect(attemptedPathLabel("browser-vibrato", "worker-transport")).toBe(
      "Browser Vibrato WASM 完了 / Worker 処理結果不明（AzooKey WASM 実行不明）",
    );
    expect(attemptedPathLabel("worker-vibrato", "worker-transport")).toBe(
      "Worker 処理結果不明（Vibrato / AzooKey WASM 実行不明）",
    );
    // A genuine conversion failure must stay specific rather than collapsing
    // into the refusal or transport wording.
    expect(attemptedPathLabel("worker-vibrato", "worker")).toBe(
      "Worker Vibrato / AzooKey WASM（失敗）",
    );
  });

  it("keeps a succeeded pre-pass out of a failure to reach the Worker", () => {
    // Losing the Worker client after the pre-pass finished must not report the
    // pre-pass as failed, nor claim a Worker conversion that never ran.
    const label = attemptedPathLabel("browser-vibrato", "worker-connect");
    expect(label).toBe("Browser Vibrato WASM 完了 / Worker AzooKey WASM 未実行");
    expect(label).not.toContain("pre-pass（失敗）");
    expect(attemptedPathLabel("worker-vibrato", "worker-connect")).toBe(
      "Worker Vibrato / AzooKey WASM 未実行",
    );
  });

  it("marks an in-flight row's route as planned rather than reached", () => {
    // A row has no failedStage until it settles, so labelling it with the full
    // route would claim a Worker conversion that has not run yet.
    for (const state of ["queued", "wasm", "sending"] as const) {
      expect(rowPathLabel("worker-vibrato", state)).toBe(
        "Worker Vibrato → Worker AzooKey WASM（予定）",
      );
      expect(rowPathLabel("browser-vibrato", state)).toBe(
        "Browser Vibrato WASM → Browser AzooKey WASM（予定）",
      );
    }
    // Settled rows keep describing what actually happened.
    expect(rowPathLabel("worker-vibrato", "done")).toBe("Worker Vibrato → Worker AzooKey WASM");
    expect(rowPathLabel("browser-vibrato", "error", "browser-wasm")).toBe(
      "Browser Vibrato WASM（失敗） / Browser AzooKey WASM 未実行",
    );
  });
});
