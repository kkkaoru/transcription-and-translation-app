import type { ComparisonMode } from "./contract";

/** User-visible conversion path after a single utterance is processed. */
export const conversionPathLabel = (mode: ComparisonMode): string =>
  mode === "browser-vibrato"
    ? "Browser WASM pre-pass → Worker AzooKey WASM"
    : "Worker AzooKey WASM";

/**
 * Stage that was in flight when a conversion failed.
 *
 * `worker-connect` sits between the two real stages: the browser pre-pass has
 * already finished, but the Worker was never reached. Folding it into either
 * neighbour would blame a stage that did not fail. `worker-request` is the same
 * idea one step later: the Worker answered, but refused the request (auth,
 * back-pressure, contract) without ever invoking the converter.
 */
export type ConversionStage =
  | "setup"
  | "browser-wasm"
  | "worker-connect"
  | "worker-request"
  | "worker";

/**
 * Path a row actually reached. A failed row must not advertise stages it never
 * ran: a browser pre-pass failure never reaches the Worker, and a setup failure
 * (bad auth, missing client) reaches neither.
 */
export const attemptedPathLabel = (mode: ComparisonMode, failedStage?: ConversionStage): string => {
  if (failedStage === undefined) {
    return conversionPathLabel(mode);
  }
  if (failedStage === "setup") {
    return "未実行";
  }
  if (failedStage === "worker-connect") {
    return mode === "browser-vibrato"
      ? "Browser WASM pre-pass 完了 / Worker AzooKey WASM 未実行"
      : "Worker AzooKey WASM 未実行";
  }
  if (failedStage === "worker-request") {
    return mode === "browser-vibrato"
      ? "Browser WASM pre-pass 完了 / Worker がリクエストを拒否（AzooKey WASM 未実行）"
      : "Worker がリクエストを拒否（AzooKey WASM 未実行）";
  }
  if (mode !== "browser-vibrato") {
    return "Worker AzooKey WASM（失敗）";
  }
  return failedStage === "browser-wasm"
    ? "Browser WASM pre-pass（失敗） / Worker AzooKey WASM 未実行"
    : "Browser WASM pre-pass → Worker AzooKey WASM（失敗）";
};

/**
 * Live path chip for the comparison surface.
 * Browser mode marks the pre-pass as unconfigured when neither module URL nor
 * an explicit global name is present in the form (runtime may still attempt a
 * historical default global name).
 */
export const comparisonPathSummary = (
  mode: ComparisonMode,
  browserWasmConfigured: boolean,
): string =>
  mode === "worker-vibrato"
    ? "Web Speech → Worker AzooKey WASM"
    : `Web Speech → Browser WASM pre-pass${
        browserWasmConfigured ? "" : "（未設定）"
      } → Worker AzooKey WASM`;
