import { describe, expect, it } from "vitest";
import { browserWasmStateAfterStage } from "./browser-wasm-status";

describe("browser WASM status attribution", () => {
  it("marks the pre-pass ready only for a browser-stage success", () => {
    expect(browserWasmStateAfterStage("idle", "browser-wasm", true)).toBe("ready");
    expect(browserWasmStateAfterStage("loading", "browser-wasm", true)).toBe("ready");
  });

  it("marks the pre-pass failed only for a browser-stage failure", () => {
    expect(browserWasmStateAfterStage("loading", "browser-wasm", false)).toBe("error");
  });

  it("never touches the browser status for setup or Worker outcomes", () => {
    for (const stage of ["setup", "worker"] as const) {
      expect(browserWasmStateAfterStage("ready", stage, false)).toBe("ready");
      expect(browserWasmStateAfterStage("error", stage, false)).toBe("error");
      expect(browserWasmStateAfterStage("idle", stage, true)).toBe("idle");
    }
  });
});
