import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_COMPACT_ZENZ_UNSUPPORTED_MESSAGE,
  runComparisonConversion,
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

    const result = await runComparisonConversion(
      { ...baseInput, mode: "browser-vibrato", converterModel: "azookey-rust-wasm" },
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
      azookeyElapsedMs: 9,
    });
    expect(connectWorker).not.toHaveBeenCalled();
    expect(convertWithWorker).not.toHaveBeenCalled();
    expect(stages).toEqual(["setup", "browser-wasm", "browser-azookey"]);
    expect(usesWorkerConversion("browser-vibrato")).toBe(false);
  });

  it("does not silently fall back to Worker AzooKey when Zenzai is selected in browser-compact", async () => {
    const convertWithWorker = vi.fn();
    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "browser-vibrato", converterModel: "zenz-v3.2-xsmall-gguf" },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
          convertWithWorker,
        },
      ),
    ).rejects.toThrow(BROWSER_COMPACT_ZENZ_UNSUPPORTED_MESSAGE);
    expect(convertWithWorker).not.toHaveBeenCalled();
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
    const result = await runComparisonConversion(
      { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
      {
        runBrowserVibrato: vi.fn(() =>
          Promise.resolve({ text: "きょうはいいてんき", elapsedMs: 1 }),
        ),
        runBrowserAzookey: vi.fn(),
        connectWorker,
        convertWithWorker,
      },
    );
    expect(result.usedWebSocket).toBe(true);
    expect(result.convertedText).toBe("今日はいい天気");
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
    ).rejects.toThrow(/Worker WebSocket/);

    await expect(
      runComparisonConversion(
        { ...baseInput, mode: "worker-vibrato", converterModel: "azookey-rust-wasm" },
        {
          runBrowserVibrato: vi.fn(),
          runBrowserAzookey: vi.fn(),
          connectWorker: vi.fn(() => Promise.resolve()),
        },
      ),
    ).rejects.toThrow(/Worker WebSocket/);
  });
});
