import type { ComparisonMode } from "./contract";

/** User-visible conversion path after a single utterance is processed. */
export const conversionPathLabel = (mode: ComparisonMode): string =>
  mode === "browser-vibrato"
    ? "Browser WASM pre-pass → Worker AzooKey WASM"
    : "Worker AzooKey WASM";

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
