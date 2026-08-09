import { describe, expect, it } from "vitest";
import {
  shouldRunBrowserVibratoPrePass,
  shouldWarmBrowserDictionaryAfterConfigChange,
  shouldWarmBrowserVibratoDictionary,
} from "./azookey-reading";

describe("browser Vibrato pre-pass selection", () => {
  it("runs browser Vibrato for Web Speech kanji even in worker mode", () => {
    expect(shouldRunBrowserVibratoPrePass("worker-vibrato", "今日は晴れです")).toBe(true);
    expect(shouldRunBrowserVibratoPrePass("worker-vibrato", "きょうははれです")).toBe(false);
    expect(shouldRunBrowserVibratoPrePass("browser-vibrato", "きょうははれです")).toBe(true);
    expect(
      shouldRunBrowserVibratoPrePass("worker-vibrato", "今日は晴れです", "きょうははれです"),
    ).toBe(false);
  });

  it("warms browser IPADIC at capture-start equivalent moments", () => {
    expect(shouldWarmBrowserVibratoDictionary("browser-vibrato")).toBe(true);
    expect(shouldWarmBrowserVibratoDictionary("browser-vibrato", true)).toBe(true);
    expect(shouldWarmBrowserVibratoDictionary("worker-vibrato")).toBe(true);
    expect(shouldWarmBrowserVibratoDictionary("worker-vibrato", false)).toBe(true);
    expect(shouldWarmBrowserVibratoDictionary("worker-vibrato", true)).toBe(false);
  });

  it("warms again when mode or dictionary URL changes during an active session", () => {
    expect(shouldWarmBrowserDictionaryAfterConfigChange("mode", "listening", "idle")).toBe(true);
    expect(shouldWarmBrowserDictionaryAfterConfigChange("mode", "idle", "open")).toBe(true);
    expect(
      shouldWarmBrowserDictionaryAfterConfigChange("browserWasmDictionaryUrl", "starting", "idle"),
    ).toBe(true);
    expect(shouldWarmBrowserDictionaryAfterConfigChange("mode", "idle", "idle")).toBe(false);
    expect(shouldWarmBrowserDictionaryAfterConfigChange("language", "listening", "open")).toBe(
      false,
    );
  });
});
