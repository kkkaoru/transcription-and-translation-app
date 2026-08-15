import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_ZENZAI_DICT_EXECUTION,
  BROWSER_ZENZAI_DICT_LABEL,
  type BrowserZenzaiDictResult,
} from "./browser-zenzai";
import {
  previousConvertedLeftContext,
  runComparisonConversion,
  usesBrowserZenzaiDictPath,
  usesWorkerConversion,
} from "./conversion-pipeline";

const baseInput = {
  sourceText: "きょうはいいてんき",
  language: "ja",
  auth: { scheme: "none" as const },
  wasmModuleUrl: "/vibrato/vibrato_wasm.js",
  dictionaryUrl: "/vibrato/system.dic.zst",
};

describe("comparison conversion pipeline", () => {
  it("runs browser-vibrato entirely locally and never opens a WebSocket", async () => {
    const connectWorker = vi.fn(() => Promise.resolve());
    const convertWithWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r1",
        sourceText: "きょうはいいてんき",
        convertedText: "should-not-run",
        receivedAt: Date.now(),
      }),
    );
    const runBrowserVibrato = vi.fn(() =>
      Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 4 }),
    );
    const runBrowserAzookey = vi.fn(() =>
      Promise.resolve({ text: "今日はいい天気", elapsedMs: 9 }),
    );
    const stages: string[] = [];
    const { dictionaryUrl: _unused, ...inputWithoutDictUrl } = baseInput;

    const result = await runComparisonConversion(
      { ...inputWithoutDictUrl, mode: "browser-vibrato", converterModel: "azookey-rust-wasm" },
      {
        runBrowserVibrato,
        runBrowserAzookey,
        connectWorker,
        convertWithWorker,
        onStage: (stage) => stages.push(stage),
      },
    );

    expect(result).toMatchObject({
      convertedText: "今日はいい天気",
      vibratoInput: "きょうはいいてんき",
      usedWebSocket: false,
      ranBrowserVibrato: true,
      model: "azookey-rust-wasm",
      wasmElapsedMs: 4,
      azookeyElapsedMs: 9,
    });
    expect(result.zenzaiExecution).toBeUndefined();
    expect(result.trace.azookeyInput).toBe("きょうはいいてんき");
    expect(result.trace.steps.some((step) => step.id === "browser-vibrato")).toBe(true);
    expect(result.trace.steps.some((step) => step.id === "azookey-input")).toBe(true);
    expect(result.steps.some((step) => step.id === "browser-azookey")).toBe(true);
    expect(result.totalElapsedMs).toBeGreaterThanOrEqual(0);
    expect(connectWorker).not.toHaveBeenCalled();
    expect(convertWithWorker).not.toHaveBeenCalled();
    expect(stages).toEqual(["setup", "browser-wasm", "browser-azookey"]);
    expect(usesWorkerConversion("browser-vibrato")).toBe(false);
  });

  it("rescored kana with input_n5_lm_v1 after Vibrato when the toggle is on", async () => {
    const runBrowserAzookey = vi.fn(() =>
      Promise.resolve({ text: "おはようございます", elapsedMs: 3 }),
    );
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "おはよございます",
        mode: "browser-vibrato",
        converterModel: "azookey-rust-wasm",
        inputN5LmRescoreEnabled: true,
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "おはよございます", elapsedMs: 1 })),
        runBrowserAzookey,
      },
    );

    expect(result.trace.azookeyInput).toBe("おはようございます");
    expect(runBrowserAzookey).toHaveBeenCalledWith("おはようございます");
    const rescoreStep = result.trace.steps.find((step) => step.id === "rescore");
    expect(rescoreStep).toMatchObject({
      id: "rescore",
      input: "おはよございます",
      output: "おはようございます",
    });
    expect(rescoreStep?.detail).toContain("input-n5-lm-v1");
  });

  it("skips input_n5_lm_v1 rescore when the toggle is off (default)", async () => {
    const runBrowserAzookey = vi.fn(() =>
      Promise.resolve({ text: "おはよございます", elapsedMs: 2 }),
    );
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "おはよございます",
        mode: "browser-vibrato",
        converterModel: "azookey-rust-wasm",
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "おはよございます", elapsedMs: 1 })),
        runBrowserAzookey,
      },
    );

    expect(result.trace.azookeyInput).toBe("おはよございます");
    expect(runBrowserAzookey).toHaveBeenCalledWith("おはよございます");
    expect(result.trace.steps.some((step) => step.id === "rescore")).toBe(false);
  });

  it("feeds rescored kana to the Cloudflare Worker path when enabled", async () => {
    const convertWithWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r-rescore",
        sourceText: "おはよございます",
        convertedText: "おはようございます",
        receivedAt: Date.now(),
        elapsedMs: 5,
        model: "azookey-rust-wasm",
        conversionStatus: 1,
        contextUsed: true,
        contextDiscarded: "dictionary-revision",
        usedCompletion: false,
        completionSkipReason: "lattice-unavailable",
      }),
    );
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "おはよございます",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        inputN5LmRescoreEnabled: true,
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "おはよございます", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker,
      },
    );
    expect(convertWithWorker).toHaveBeenCalledWith(
      expect.objectContaining({ vibratoInput: "おはようございます" }),
    );
    expect(result.trace.steps.some((step) => step.id === "rescore")).toBe(true);
    expect(result.conversionStatus).toBe(1);
    expect(result.contextUsed).toBe(true);
    expect(result.contextDiscarded).toBe("dictionary-revision");
    expect(result.usedCompletion).toBe(false);
    expect(result.completionSkipReason).toBe("lattice-unavailable");
    expect(result.trace.steps.find((step) => step.id === "converter-output")?.detail).toBe(
      "モデル: azookey-rust-wasm · 変換異常: 指定の辞書を使えず内蔵辞書で変換しました · 辞書の版が変わったため前の候補文脈を捨てました · 格子を開けなかったため Zenz の完了を捨てました",
    );
  });

  it("rescored kana on the Zenzai dictionary path when enabled", async () => {
    const runBrowserZenzaiDict = vi.fn(
      (): Promise<BrowserZenzaiDictResult> =>
        Promise.resolve({
          text: "おはようございます",
          elapsedMs: 4,
          execution: BROWSER_ZENZAI_DICT_EXECUTION,
          model: "zenz-v3.2-xsmall-gguf",
          dictionaryUrl: "/azookey/system.azkdict.gz",
          label: BROWSER_ZENZAI_DICT_LABEL,
        }),
    );
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "おはよございます",
        mode: "browser-vibrato",
        converterModel: "zenz-v3.2-xsmall-gguf",
        inputN5LmRescoreEnabled: true,
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "おはよございます", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        runBrowserZenzaiDict,
      },
    );
    expect(runBrowserZenzaiDict).toHaveBeenCalledWith(
      "おはようございます",
      "zenz-v3.2-xsmall-gguf",
    );
    expect(result.trace.azookeyInput).toBe("おはようございます");
  });

  it("throws when browser Zenzai dict client is missing", async () => {
    await expect(
      runComparisonConversion(
        {
          ...baseInput,
          mode: "browser-vibrato",
          converterModel: "zenz-v3.2-xsmall-gguf",
        },
        {
          runBrowserVibrato: vi.fn(() =>
            Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
          ),
          runBrowserAzookey: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Zenzai/);
  });

  it("uses the Zenzai dictionary path in browser-complete without falling back to Worker", async () => {
    const convertWithWorker = vi.fn();
    const runBrowserAzookey = vi.fn();
    const runBrowserZenzaiDict = vi.fn(
      (): Promise<BrowserZenzaiDictResult> =>
        Promise.resolve({
          text: "今日はいい天気",
          elapsedMs: 6,
          execution: BROWSER_ZENZAI_DICT_EXECUTION,
          model: "zenz-v3.2-xsmall-gguf",
          dictionaryUrl: "/azookey/system.azkdict.gz",
          label: BROWSER_ZENZAI_DICT_LABEL,
        }),
    );
    const stages: string[] = [];

    const result = await runComparisonConversion(
      { ...baseInput, mode: "browser-vibrato", converterModel: "zenz-v3.2-xsmall-gguf" },
      {
        runBrowserVibrato: vi.fn(() =>
          Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
        ),
        runBrowserAzookey,
        runBrowserZenzaiDict,
        convertWithWorker,
        onStage: (stage) => stages.push(stage),
      },
    );
    expect(stages).toEqual(["setup", "browser-wasm", "browser-azookey"]);

    expect(result).toMatchObject({
      convertedText: "今日はいい天気",
      usedWebSocket: false,
      model: "zenz-v3.2-xsmall-gguf",
      zenzaiExecution: BROWSER_ZENZAI_DICT_EXECUTION,
      azookeyElapsedMs: 6,
    });
    expect(result.model).not.toBe("azookey-rust-wasm");
    expect(result.steps.some((step) => step.id === "browser-zenzai-dict")).toBe(true);
    expect(result.steps.some((step) => step.id === "browser-azookey")).toBe(false);
    expect(runBrowserAzookey).not.toHaveBeenCalled();
    expect(convertWithWorker).not.toHaveBeenCalled();
    expect(usesBrowserZenzaiDictPath("browser-vibrato", "zenz-v3.2-xsmall-gguf")).toBe(true);
    expect(usesBrowserZenzaiDictPath("worker-vibrato", "zenz-v3.2-xsmall-gguf")).toBe(false);
    expect(usesBrowserZenzaiDictPath("browser-vibrato", "azookey-rust-wasm")).toBe(false);
  });

  it("requires a Zenzai dictionary client in browser-complete mode", async () => {
    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "browser-vibrato", converterModel: "zenz-v3.2-small-gguf" },
        {
          runBrowserVibrato: vi.fn(() =>
            Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
          ),
          runBrowserAzookey: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Zenzai 辞書クライアント/);
  });

  it("skips Vibrato for phonetic fixtures and still stays in-browser", async () => {
    const runBrowserVibrato = vi.fn();
    const result = await runComparisonConversion(
      {
        ...baseInput,
        mode: "browser-vibrato",
        converterModel: "azookey-rust-wasm",
        phoneticInput: "あしたのてんきははれ",
      },
      {
        runBrowserVibrato,
        runBrowserAzookey: vi.fn(() => Promise.resolve({ text: "明日の天気は晴れ", elapsedMs: 2 })),
        convertWithWorker: vi.fn(),
      },
    );
    expect(runBrowserVibrato).not.toHaveBeenCalled();
    expect(result.usedWebSocket).toBe(false);
    expect(result.convertedText).toBe("明日の天気は晴れ");
    expect(result.vibratoInput).toBe("あしたのてんきははれ");
    expect(result.azookeyElapsedMs).toBe(2);
    expect(result.trace.usedPhoneticOverride).toBe(true);
    expect(result.trace.steps.some((step) => step.id === "phonetic-override")).toBe(true);
    expect(result.steps.some((step) => step.id === "phonetic-override")).toBe(true);
    expect(result.totalElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("skips Vibrato in worker mode for hiragana-only source", async () => {
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "きょうははれです",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
      },
      {
        runBrowserVibrato: vi.fn(),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r-skip",
            sourceText: "きょうははれです",
            convertedText: "今日は晴れです",
            receivedAt: Date.now(),
          }),
        ),
      },
    );
    expect(result.ranBrowserVibrato).toBe(false);
    expect(result.steps.some((step) => step.id === "vibrato-skipped")).toBe(true);
  });

  it("uses the Worker path only for worker-vibrato", async () => {
    const connectWorker = vi.fn(() => Promise.resolve());
    const convertWithWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r2",
        sourceText: "きょうはいいてんき",
        convertedText: "今日はいい天気",
        elapsedMs: 12,
        receivedAt: Date.now(),
        model: "azookey-rust-wasm",
      }),
    );
    const workerStages: string[] = [];
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "今日はいい天気",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
      },
      {
        runBrowserVibrato: vi.fn(() =>
          Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
        ),
        runBrowserAzookey: vi.fn(),
        connectWorker,
        convertWithWorker,
        onStage: (stage) => workerStages.push(stage),
      },
    );
    expect(workerStages).toEqual(["setup", "browser-wasm", "worker-connect", "worker"]);
    expect(result.usedWebSocket).toBe(true);
    expect(result.convertedText).toBe("今日はいい天気");
    expect(result.workerElapsedMs).toBe(12);
    expect(result.trace.workerRequest?.vibratoInput).toBe("きょうはいいてんき");
    expect(result.trace.steps.some((step) => step.id === "worker-ws")).toBe(true);
    expect(result.steps.some((step) => step.id === "worker-ws")).toBe(true);
    expect(result.totalElapsedMs).toBeGreaterThanOrEqual(0);

    const zeroElapsed = await runComparisonConversion(
      { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
      {
        runBrowserVibrato: vi.fn(() =>
          Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
        ),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r2-zero",
            sourceText: "きょうはいいてんき",
            convertedText: "今日はいい天気",
            elapsedMs: 0,
            receivedAt: Date.now(),
          }),
        ),
      },
    );
    expect(zeroElapsed.convertedText).toBe("今日はいい天気");
    expect(zeroElapsed.workerElapsedMs).toBe(0);
    expect(zeroElapsed.totalElapsedMs).toBeGreaterThanOrEqual(0);
    expect(connectWorker).toHaveBeenCalledOnce();
    expect(convertWithWorker).toHaveBeenCalledOnce();
    expect(usesWorkerConversion("worker-vibrato")).toBe(true);

    const phoneticWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r2b",
        sourceText: "あしたのてんきははれ",
        convertedText: "明日の天気は晴れ",
        receivedAt: Date.now(),
      }),
    );
    await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "あしたのてんきははれ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        phoneticInput: "あしたのてんきははれ",
      },
      {
        runBrowserVibrato: vi.fn(),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: phoneticWorker,
      },
    );
    expect(phoneticWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "worker-vibrato",
        vibratoExecution: "worker",
        vibratoInput: "あしたのてんきははれ",
      }),
    );
  });

  it("fail-opens browser Vibrato in worker mode and requires Bearer only there", async () => {
    const convertWithWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r3",
        sourceText: "今日は晴れ",
        convertedText: "今日は晴れ",
        receivedAt: Date.now(),
      }),
    );
    const result = await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "今日は晴れ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.reject(new Error("ipadic missing"))),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker,
      },
    );
    expect(result.vibratoInput).toBe("今日は晴れ");
    expect(result.usedWebSocket).toBe(true);
    expect(result.trace.steps.some((step) => step.id === "vibrato-fallback")).toBe(true);
    expect(result.steps.some((step) => step.id === "vibrato-fallback")).toBe(true);
    expect(result.workerElapsedMs).toBeUndefined();
    expect(result.totalElapsedMs).toBeGreaterThanOrEqual(0);

    await expect(
      runComparisonConversion(
        {
          ...baseInput,
          mode: "worker-vibrato",
          converterModel: "azookey-rust-wasm",
          auth: { scheme: "bearer" },
        },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
          connectWorker: vi.fn(() => Promise.resolve()),
          convertWithWorker: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Bearer token/);

    await expect(
      runComparisonConversion(
        {
          ...baseInput,
          mode: "worker-vibrato",
          converterModel: "azookey-rust-wasm",
          auth: { scheme: "bearer", token: "   " },
        },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
          connectWorker: vi.fn(() => Promise.resolve()),
          convertWithWorker: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Bearer token/);

    await expect(
      runComparisonConversion(
        {
          ...baseInput,
          mode: "browser-vibrato",
          converterModel: "azookey-rust-wasm",
          auth: { scheme: "bearer" },
        },
        {
          runBrowserVibrato: vi.fn(() =>
            Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
          ),
          runBrowserAzookey: vi.fn(() => Promise.resolve({ text: "今日はいい天気", elapsedMs: 1 })),
        },
      ),
    ).resolves.toMatchObject({ usedWebSocket: false, convertedText: "今日はいい天気" });
  });

  it("skips browser Vibrato for kana-only worker speech and records not-required trace", async () => {
    const runBrowserVibrato = vi.fn();
    const result = await runComparisonConversion(
      { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
      {
        runBrowserVibrato,
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r-kana",
            sourceText: "きょうはいいてんき",
            convertedText: "今日はいい天気",
            receivedAt: Date.now(),
          }),
        ),
      },
    );
    expect(runBrowserVibrato).not.toHaveBeenCalled();
    expect(result.trace.steps.some((step) => step.id === "vibrato-skipped")).toBe(true);
    expect(result.trace.steps.find((step) => step.id === "vibrato-skipped")?.detail).toContain(
      "漢字",
    );
    expect(result.steps).toEqual(result.trace.steps);
  });

  it("reports worker-connect and worker stages through onStage", async () => {
    const stages: string[] = [];
    await runComparisonConversion(
      { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
      {
        runBrowserVibrato: vi.fn(),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r-stage",
            sourceText: "きょうはいいてんき",
            convertedText: "今日はいい天気",
            receivedAt: Date.now(),
          }),
        ),
        onStage: (stage) => stages.push(stage),
      },
    );
    expect(stages).toEqual(["setup", "worker-connect", "worker"]);
  });

  it("forwards optional Vibrato locator fields to the browser pre-pass", async () => {
    const runBrowserVibrato = vi.fn(() => Promise.resolve({ text: "今日は晴れ", elapsedMs: 2 }));
    await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "今日は晴れ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
        wasmModuleUrl: "/vibrato/vibrato_wasm.js",
        dictionaryUrl: "/vibrato/system.dic.zst",
        wasmGlobalName: "__TEST__",
      },
      {
        runBrowserVibrato,
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r-locator",
            sourceText: "今日は晴れ",
            convertedText: "今日は晴れ",
            receivedAt: Date.now(),
          }),
        ),
      },
    );
    expect(runBrowserVibrato).toHaveBeenCalledWith("今日は晴れ", {
      moduleUrl: "/vibrato/vibrato_wasm.js",
      dictionaryUrl: "/vibrato/system.dic.zst",
      globalName: "__TEST__",
    });
  });

  it("passes undefined optional Vibrato locator fields when omitted", async () => {
    const runBrowserVibrato = vi.fn(() => Promise.resolve({ text: "今日は晴れ", elapsedMs: 1 }));
    const { dictionaryUrl: _dictionaryUrl, ...inputWithoutDictionary } = baseInput;
    await runComparisonConversion(
      {
        ...inputWithoutDictionary,
        sourceText: "今日は晴れ",
        mode: "worker-vibrato",
        converterModel: "azookey-rust-wasm",
      },
      {
        runBrowserVibrato,
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker: vi.fn(() =>
          Promise.resolve({
            requestId: "r-no-locator",
            sourceText: "今日は晴れ",
            convertedText: "今日は晴れ",
            receivedAt: Date.now(),
          }),
        ),
      },
    );
    expect(runBrowserVibrato).toHaveBeenCalledWith("今日は晴れ", {
      moduleUrl: "/vibrato/vibrato_wasm.js",
      dictionaryUrl: undefined,
      globalName: undefined,
    });
  });

  it("fails closed when browser-vibrato Vibrato or the Worker client is missing", async () => {
    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "browser-vibrato", converterModel: "azookey-rust-wasm" },
        {
          runBrowserVibrato: vi.fn(() => Promise.reject(new Error("vibrato wasm missing"))),
          runBrowserAzookey: vi.fn(),
        },
      ),
    ).rejects.toThrow(/vibrato wasm missing/);

    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Cloudflare Worker WebSocket/);

    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
          connectWorker: vi.fn(() => Promise.resolve()),
        },
      ),
    ).rejects.toThrow(/Cloudflare Worker WebSocket/);
  });

  it("sends the previous converted caption as Zenz leftContext on the worker path", async () => {
    const convertWithWorker = vi.fn(() =>
      Promise.resolve({
        requestId: "r-left",
        sourceText: "かんじ",
        convertedText: "感じ",
        receivedAt: Date.now(),
        model: "zenz-v3.2-small-gguf",
      }),
    );
    await runComparisonConversion(
      {
        ...baseInput,
        sourceText: "かんじ",
        mode: "worker-vibrato",
        converterModel: "zenz-v3.2-small-gguf",
        leftContext: "子供がお菓子を食べています。",
      },
      {
        runBrowserVibrato: vi.fn(() => Promise.resolve({ text: "かんじ", elapsedMs: 1 })),
        runBrowserAzookey: vi.fn(),
        connectWorker: vi.fn(() => Promise.resolve()),
        convertWithWorker,
      },
    );
    expect(convertWithWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "zenz-v3.2-small-gguf",
        leftContext: "子供がお菓子を食べています。",
      }),
    );
    expect(previousConvertedLeftContext([undefined, "", "子供がお菓子を食べています。"])).toBe(
      "子供がお菓子を食べています。",
    );
    expect(previousConvertedLeftContext(["あ".repeat(41)])).toBe("あ".repeat(40));
    expect(previousConvertedLeftContext([])).toBeUndefined();
  });
});
