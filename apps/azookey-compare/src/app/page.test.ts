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
    const overviewStart = source.indexOf("<ComparisonPathDiagram");
    const modeStart = source.indexOf('kind="mode"');
    expect(overviewStart).toBeGreaterThan(-1);
    expect(modeStart).toBeGreaterThan(overviewStart);
    expect(source.slice(overviewStart, modeStart)).toContain(
      "recognitionProvider={config.recognitionProvider}",
    );
    expect(source.slice(modeStart, modeStart + 500)).toContain(
      "recognitionProvider={config.recognitionProvider}",
    );
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
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
    expect(source).toContain('data-testid="config-panel-disclosure"');
    expect(source).toContain('data-testid="config-panel-toggle"');
    expect(source).toContain('data-testid="config-panel"');
    expect(source).toContain("config-panel-disclosure");
    expect(source).toContain("config-panel-heading-desktop");
    expect(source).toContain("config-panel-body");
    expect(source).toContain("open={configPanelOpen}");
    expect(source).toContain('DESKTOP_CONFIG_MEDIA_QUERY = "(min-width: 641px)"');
    const configPanel = source.indexOf('data-testid="config-panel"');
    const desktopHeading = source.indexOf("config-panel-heading-desktop");
    const disclosure = source.indexOf('data-testid="config-panel-disclosure"');
    expect(configPanel).toBeGreaterThan(-1);
    expect(desktopHeading).toBeGreaterThan(configPanel);
    expect(disclosure).toBeGreaterThan(desktopHeading);
    expect(css).toMatch(/\.config-panel-disclosure\s*\{\s*display:\s*contents;/);
  });

  it("applies the shared mode-selector styles to recognition and conversion selects", () => {
    const recognition = readFileSync(
      new URL("../components/RecognitionModeSelector.tsx", import.meta.url),
      "utf8",
    );
    const vibrato = readFileSync(
      new URL("../components/VibratoModeSelector.tsx", import.meta.url),
      "utf8",
    );
    const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
    expect(recognition).toContain("mode-selector");
    expect(vibrato).toContain("mode-selector");
    expect(css).toContain(".mode-selector select");
    expect(css).toContain(".mode-selector > label");
  });

  it("labels the live recognition heading for Workers AI ASR", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('config.recognitionProvider === "workers-ai-asr"');
    expect(source).toContain("Workers AI ASR 認識結果");
    expect(source).toContain("Web Speech 認識結果");
  });

  it("starts Workers AI ASR without waiting on Vibrato warmup success", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain("beginRecognitionListening");
    expect(source).toContain('requireVibratoWarmup: config.mode === "browser-vibrato"');
    const toggle = source.slice(
      source.indexOf("const toggleListening"),
      source.indexOf("const connectWorker"),
    );
    expect(toggle).toContain("beginRecognitionListening");
    expect(toggle).not.toContain(
      "void warmBrowserVibratoIfNeeded(workerVibratoConfiguredRef.current)",
    );
  });

  it("recreates recognition controllers from scheme and token, not the auth object", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const effectClose = source.indexOf(
      "}, [config.recognitionProvider, config.auth.scheme, config.auth.token, dispatchSpeechText]);",
    );
    expect(effectClose).toBeGreaterThan(-1);
    expect(source).not.toContain("}, [config.recognitionProvider, config.auth, config.language]);");
    const createEffect = source.slice(
      source.indexOf('if (config.recognitionProvider === "workers-ai-asr")'),
      effectClose,
    );
    expect(createEffect).toContain(
      "auth: { scheme: config.auth.scheme, token: config.auth.token }",
    );
    expect(createEffect).toContain("ensureWorkersAiAsrController");
  });

  it("starts Workers AI ASR without waiting for the effect tick after selecting it", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const toggle = source.slice(
      source.indexOf("const toggleListening"),
      source.indexOf("const connectWorker"),
    );
    expect(toggle).toContain("ensureAsrController");
    expect(toggle).toContain("gateWorkersAiAsrStart");
    expect(toggle).toContain("gate.controller.start()");
    expect(toggle).not.toContain("このブラウザは Workers AI ASR 録音に対応していません");
    expect(toggle).toContain("WEB_SPEECH_UNSUPPORTED_JA");
    expect(source).toContain("asrCaptureSupported");
    expect(source).toContain("webSpeechSupported");
    expect(source).not.toContain("const [speechSupported, setSpeechSupported]");
  });

  it("uses Silero VAD only for Workers AI ASR and skips it on Web Speech", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain("WorkersAiAsrController");
    expect(source).toContain("onVadNotice");
    expect(source).toContain("Silero VAD v6");
    expect(source).toContain("Silero ONNX / ORT WASM は読み込みません");
    expect(source).toContain("asrRef.current?.dispose()");
    expect(source).toContain("ensureWorkersAiAsrController");
    expect(source.indexOf("ensureWorkersAiAsrController")).toBeLessThan(
      source.indexOf("new WebSpeechController"),
    );
    expect(source).not.toMatch(/import\s+.*onnxruntime-web/);
    expect(source).not.toContain("/models/silero_vad_v6/");
    const controller = readFileSync(
      new URL("../lib/workers-ai-asr-controller.ts", import.meta.url),
      "utf8",
    );
    expect(controller).toContain("SileroWasmVadEngine");
    expect(controller).toContain("disableSilero");
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
    expect(source).toContain("shouldShowWorkersAiAsrCostAmount");
    expect(source).toContain("utteranceAsrCostFields");
    expect(source).toContain(
      "recognitionProvider: options.recognitionProvider ?? config.recognitionProvider",
    );
    expect(source).not.toContain("toExponential");
    expect(source).not.toContain("asrCostUsd > 0");
  });
});
