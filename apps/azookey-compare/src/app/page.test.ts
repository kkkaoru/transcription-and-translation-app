import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { syncSpeechLanguage } from "../lib/speech-language";

describe("compare page speech settings", () => {
  it("updates the existing recognition controller for repeated language edits", () => {
    const controller = { setLanguage: vi.fn() };

    // A language input emits one update per keystroke. The page must route
    // those edits to the same controller rather than constructing a new one
    // and disposing the active recognition session.
    syncSpeechLanguage(controller, "j");
    syncSpeechLanguage(controller, "ja");
    syncSpeechLanguage(controller, "ja-JP");

    expect(controller.setLanguage).toHaveBeenCalledTimes(3);
    expect(controller.setLanguage).toHaveBeenNthCalledWith(1, "j");
    expect(controller.setLanguage).toHaveBeenNthCalledWith(2, "ja");
    expect(controller.setLanguage).toHaveBeenNthCalledWith(3, "ja-JP");
  });

  it("does not require a controller before the speech effect has mounted", () => {
    expect(() => syncSpeechLanguage(null, "ja-JP")).not.toThrow();
  });

  it("places the recognition lane above settings", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const speechLane = source.indexOf('data-testid="speech-lane"');
    const settings = source.indexOf('aria-label="比較設定"');
    expect(speechLane).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(speechLane);
  });

  it("keeps the hosted architecture diagram on the page", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('kind="overview"');
    expect(source).toContain("ComparisonPathDiagram");
    expect(source).toContain("ブラウザ完結");
  });

  it("wires Web Speech utterance and session-end callbacks", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain("onFinalText");
    expect(source).toContain("onUtteranceFinal");
    expect(source).toContain("onRecognitionEnded");
  });

  it("renders per-utterance conversion trace on comparison rows", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="utterance-trace"');
    expect(source).toContain("conversionTraceDisplayLines");
    expect(source).toContain("trace: result.trace");
  });

  it("collapses configuration on mobile via details disclosure", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="config-panel-disclosure"');
    expect(source).toContain('data-testid="config-panel-toggle"');
    expect(source).toContain('data-testid="config-panel"');
    expect(source).toContain("config-panel-disclosure");
  });

  it("renders per-utterance Cloudflare conversion cost on comparison rows", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="utterance-cost-card"');
    expect(source).toContain('data-testid="utterance-conversion-cost"');
    expect(source).toContain('data-testid="utterance-asr-cost"');
    expect(source).toContain("estimateCloudflareConversionCost");
    expect(source).toContain("formatCloudflareCostUsd");
    expect(source).toContain("料金（推定）");
    expect(source).toContain("Cloudflare Worker（変換）");
    expect(source).toContain("Workers AI（ASR）");
  });
});
