import type { ConversionStage } from "./path-labels";

/** Browser WASM pre-pass status shown in the comparison settings panel. */
export type BrowserWasmState = "idle" | "loading" | "ready" | "error";

/**
 * Next browser WASM status after a conversion stage completes.
 *
 * The browser pre-pass owns the browser WASM status exclusively. A Worker or
 * setup failure must never report a pre-pass that already succeeded as failed,
 * and a pre-pass failure must never be blamed on the Worker: only the browser
 * stage transitions the status, every other stage leaves it untouched.
 */
export const browserWasmStateAfterStage = (
  current: BrowserWasmState,
  stage: ConversionStage,
  ok: boolean,
): BrowserWasmState => {
  if (stage !== "browser-wasm") {
    return current;
  }
  return ok ? "ready" : "error";
};
