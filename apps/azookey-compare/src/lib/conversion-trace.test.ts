import { describe, expect, it } from "vitest";
import {
  assembleConversionTrace,
  buildAzookeyInputStep,
  buildBrowserAzookeyStep,
  buildBrowserZenzaiDictStep,
  buildBrowserVibratoStep,
  buildConverterOutputStep,
  buildNormalizeStep,
  buildPhoneticOverrideStep,
  buildVibratoFallbackStep,
  buildVibratoSkippedStep,
  buildWorkerWsStep,
  conversionTraceDisplayLines,
  formatTraceStepSummary,
  formatTraceStepTiming,
  normalizeSourceText,
  traceStepLocationLabel,
} from "./conversion-trace";

describe("conversion trace helpers", () => {
  it("normalizes source text and labels locations in Japanese", () => {
    expect(normalizeSourceText("  きょう  ")).toBe("きょう");
    expect(traceStepLocationLabel("cloudflare-worker")).toBe("Cloudflare Worker");
    expect(traceStepLocationLabel("browser")).toBe("ブラウザ");
  });

  it("builds individual step records with timings", () => {
    const normalize = buildNormalizeStep("  abc  ", "abc");
    expect(normalize.detail).toContain("前後空白");
    expect(buildNormalizeStep("abc", "abc").detail).toContain("変更なし");
    expect(buildPhoneticOverrideStep("あ")).toMatchObject({ id: "phonetic-override" });
    expect(buildVibratoSkippedStep("not-required", "abc")).toMatchObject({
      id: "vibrato-skipped",
      detail: expect.stringContaining("漢字"),
    });
    expect(buildVibratoSkippedStep("phonetic-override", "abc").detail).toContain("かな読み");
    expect(buildBrowserVibratoStep("今日", "きょう", 3)).toMatchObject({
      elapsedMs: 3,
      location: "browser",
    });
    expect(buildBrowserVibratoStep("今日", "きょう").elapsedMs).toBeUndefined();
    expect(buildVibratoFallbackStep("今日")).toMatchObject({ id: "vibrato-fallback" });
    expect(buildAzookeyInputStep("きょう", "browser-vibrato").location).toBe("browser");
    expect(buildAzookeyInputStep("きょう", "worker-vibrato").location).toBe("cloudflare-worker");
    expect(formatTraceStepTiming(buildBrowserAzookeyStep("a", "b", 0))).toBe("0 ms");
    expect(formatTraceStepTiming(buildBrowserAzookeyStep("a", "b"))).toBeUndefined();
    expect(formatTraceStepSummary(buildBrowserAzookeyStep("a", "b", 5))).toContain("5 ms");
    expect(traceStepLocationLabel("none")).toBe("—");
    expect(
      buildConverterOutputStep("out", "worker-vibrato", 1, "m1", "m0", "upstream-failed").detail,
    ).toContain("m0");
    expect(
      buildConverterOutputStep("out", "worker-vibrato", 1, undefined, "m0", "upstream-failed").detail,
    ).toContain("AzooKey WASM");
    expect(buildConverterOutputStep("out", "worker-vibrato", undefined, "m1").detail).toBe(
      "モデル: m1",
    );
    expect(buildConverterOutputStep("out", "browser-vibrato").detail).toContain("ブラウザ");
  });

  it("assembles browser-complete traces with vibrato and azookey steps", () => {
    const trace = assembleConversionTrace({
      rawSource: "  きょうはいいてんき  ",
      normalizedSource: "きょうはいいてんき",
      vibrato: {
        ran: true,
        input: "きょうはいいてんき",
        output: "きょうはいいてんき",
        elapsedMs: 4,
      },
      converter: {
        mode: "browser-vibrato",
        azookeyInput: "きょうはいいてんき",
        convertedText: "今日はいい天気",
        elapsedMs: 9,
        model: "azookey-rust-wasm",
      },
    });
    expect(trace.azookeyInput).toBe("きょうはいいてんき");
    expect(trace.usedPhoneticOverride).toBe(false);
    expect(trace.steps.map((step) => step.id)).toEqual([
      "source",
      "normalize",
      "browser-vibrato",
      "azookey-input",
      "browser-azookey",
    ]);
    expect(trace.steps.find((step) => step.id === "azookey-input")?.output).toBe("きょうはいいてんき");
  });

  it("assembles phonetic override and worker traces", () => {
    const phoneticTrace = assembleConversionTrace({
      rawSource: "おつかれ",
      normalizedSource: "おつかれ",
      phoneticInput: "おつかれさまでした",
      vibrato: {
        ran: false,
        skippedReason: "phonetic-override",
        input: "おつかれ",
        output: "おつかれさまでした",
      },
      converter: {
        mode: "browser-vibrato",
        azookeyInput: "おつかれさまでした",
        convertedText: "お疲れ様でした",
        elapsedMs: 2,
      },
    });
    expect(phoneticTrace.usedPhoneticOverride).toBe(true);
    expect(phoneticTrace.steps.some((step) => step.id === "phonetic-override")).toBe(true);

    const workerTrace = assembleConversionTrace({
      rawSource: "今日は晴れ",
      normalizedSource: "今日は晴れ",
      vibrato: {
        ran: false,
        input: "今日は晴れ",
        output: "今日は晴れ",
        failedOpen: true,
      },
      converter: {
        mode: "worker-vibrato",
        azookeyInput: "今日は晴れ",
        convertedText: "今日は晴れ",
        elapsedMs: 12,
        model: "azookey-rust-wasm",
        workerRequest: {
          sourceText: "今日は晴れ",
          vibratoInput: "今日は晴れ",
          mode: "worker-vibrato",
          vibratoExecution: "browser-wasm",
          model: "azookey-rust-wasm",
        },
      },
    });
    expect(workerTrace.workerRequest?.vibratoInput).toBe("今日は晴れ");
    expect(workerTrace.steps.some((step) => step.id === "vibrato-fallback")).toBe(true);
    expect(workerTrace.steps.some((step) => step.id === "worker-ws")).toBe(true);
    expect(buildWorkerWsStep(workerTrace.workerRequest!)).toMatchObject({
      title: "Cloudflare Worker へ送信",
    });
    expect(
      buildWorkerWsStep({
        sourceText: "a",
        vibratoInput: "a",
        mode: "worker-vibrato",
        vibratoExecution: "worker",
      }).detail,
    ).not.toContain("model=");
    expect(
      buildConverterOutputStep("今日は晴れ", "worker-vibrato", 0, "azookey-rust-wasm").elapsedMs,
    ).toBe(0);
  });

  it("flattens trace steps for utterance cards", () => {
    const trace = assembleConversionTrace({
      rawSource: "abc",
      normalizedSource: "abc",
      vibrato: {
        ran: true,
        input: "今日",
        output: "きょう",
        elapsedMs: 1,
      },
      converter: {
        mode: "worker-vibrato",
        azookeyInput: "きょう",
        convertedText: "ABC",
        workerRequest: {
          sourceText: "abc",
          vibratoInput: "きょう",
          mode: "worker-vibrato",
          vibratoExecution: "worker",
        },
      },
    });
    const lines = conversionTraceDisplayLines(trace);
    expect(lines.some((line) => line.label === "AzooKey への入力")).toBe(true);
    expect(lines.some((line) => line.label === "Cloudflare Worker 変換出力")).toBe(true);
    expect(lines.some((line) => line.label.includes("（入力）"))).toBe(true);
    expect(lines.some((line) => line.timing === "1 ms")).toBe(true);
    expect(formatTraceStepSummary(buildNormalizeStep("a", "b"))).toBe("正規化");
    expect(
      conversionTraceDisplayLines({
        steps: [{ id: "source", title: "空", location: "none" }],
        normalizedSource: "",
        azookeyInput: "",
        usedPhoneticOverride: false,
      }),
    ).toEqual([{ key: "source-value", label: "空", value: "—" }]);
    expect(
      assembleConversionTrace({
        rawSource: "abc",
        normalizedSource: "abc",
        vibrato: { ran: false, input: "abc", output: "abc" },
        converter: {
          mode: "browser-vibrato",
          azookeyInput: "abc",
          convertedText: "ABC",
        },
      }).steps.find((step) => step.id === "vibrato-skipped")?.detail,
    ).toContain("漢字");
  });

  it("records browser Zenzai dictionary conversion separately from AzooKey WASM", () => {
    const trace = assembleConversionTrace({
      rawSource: "きょう",
      normalizedSource: "きょう",
      vibrato: { ran: false, input: "きょう", output: "きょう", skippedReason: "not-required" },
      converter: {
        mode: "browser-vibrato",
        azookeyInput: "きょう",
        convertedText: "今日",
        elapsedMs: 3,
        model: "zenz-v3.2-xsmall-gguf",
        zenzaiExecution: "browser-dict",
        dictionaryUrl: "/azookey/system.azkdict.gz",
      },
    });
    expect(trace.steps.some((step) => step.id === "browser-zenzai-dict")).toBe(true);
    expect(trace.steps.some((step) => step.id === "browser-azookey")).toBe(false);
    const zenzStep = trace.steps.find((step) => step.id === "browser-zenzai-dict");
    expect(zenzStep?.detail).toContain("LOUDS");
    expect(zenzStep?.detail).toContain("GGUF 推論なし");
    expect(buildBrowserZenzaiDictStep("in", "out", "zenz-v3.2-xsmall-gguf", "/dict.gz").elapsedMs).toBeUndefined();
    const defaultDictTrace = assembleConversionTrace({
      rawSource: "きょう",
      normalizedSource: "きょう",
      vibrato: { ran: false, input: "きょう", output: "きょう", skippedReason: "not-required" },
      converter: {
        mode: "browser-vibrato",
        azookeyInput: "きょう",
        convertedText: "今日",
        model: "zenz-v3.2-xsmall-gguf",
        zenzaiExecution: "browser-dict",
      },
    });
    expect(defaultDictTrace.steps.find((step) => step.id === "browser-zenzai-dict")?.detail).toContain(
      "/azookey/system.azkdict.gz",
    );
  });
});
