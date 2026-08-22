// This file runs with bun.
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX,
  beginRecognitionListening,
  recognitionErrorMessage,
  WORKER_ISOLATE_WARMUP_FAILURE_NOTICE_PREFIX,
} from "./recognition-listen";

describe("beginRecognitionListening", () => {
  it("normalizes empty and non-Error failures", () => {
    expect(recognitionErrorMessage(new Error("   "))).toBe("予期しないエラーが発生しました");
    expect(recognitionErrorMessage("failure")).toBe("予期しないエラーが発生しました");
  });

  it("starts Workers AI ASR immediately even when Vibrato warmup fails", async () => {
    const start = vi.fn();
    const onWarmupNotice = vi.fn();
    const onWarmupError = vi.fn();
    let rejectWarmup: ((error: Error) => void) | undefined;
    const warmup = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectWarmup = reject;
        }),
    );

    beginRecognitionListening({
      provider: "workers-ai-asr",
      start,
      warmBrowserVibrato: warmup,
      onWarmupNotice,
      onWarmupError,
      requireVibratoWarmup: true,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(warmup).toHaveBeenCalledTimes(1);

    rejectWarmup?.(new Error("IPADIC missing"));
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onWarmupError).not.toHaveBeenCalled();
    expect(onWarmupNotice).toHaveBeenCalledWith(
      `${BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX}IPADIC missing`,
    );
  });

  it("does not wait for Vibrato warmup before Workers AI ASR start", async () => {
    const start = vi.fn();
    let resolveWarmup: (() => void) | undefined;
    const warmup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWarmup = resolve;
        }),
    );

    beginRecognitionListening({
      provider: "workers-ai-asr",
      start,
      warmBrowserVibrato: warmup,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(warmup).toHaveBeenCalledTimes(1);
    resolveWarmup?.();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("blocks Web Speech start when browser-vibrato warmup fails", async () => {
    const start = vi.fn();
    const onWarmupNotice = vi.fn();
    const onWarmupError = vi.fn();

    beginRecognitionListening({
      provider: "web-speech",
      start,
      warmBrowserVibrato: () => Promise.reject(new Error("dict failed")),
      onWarmupNotice,
      onWarmupError,
      requireVibratoWarmup: true,
    });

    expect(start).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(onWarmupError).toHaveBeenCalledWith("dict failed");
    expect(onWarmupNotice).not.toHaveBeenCalled();
  });

  it("logs Workers AI ASR start failures without a Next overlay pageerror throw", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const scheduled: Array<() => void> = [];
    const micro = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      scheduled.push(callback);
    });

    beginRecognitionListening({
      provider: "workers-ai-asr",
      start: () => Promise.reject(new Error("マイクを開始できません")),
      warmBrowserVibrato: async () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(logged, "start failure must console.error").toHaveBeenCalled();
    const loggedError = logged.mock.calls[0]?.[0];
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe("マイクを開始できません");
    expect(scheduled, "must not queueMicrotask throw for Next overlay").toHaveLength(0);
    expect(micro).not.toHaveBeenCalled();

    beginRecognitionListening({
      provider: "workers-ai-asr",
      start: () => Promise.reject("microphone unavailable"),
      warmBrowserVibrato: async () => undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(logged.mock.calls[1]?.[0]).toMatchObject({
      message: "予期しないエラーが発生しました",
    });

    logged.mockRestore();
    micro.mockRestore();
  });

  it("fires Worker isolate warmup immediately and never waits for it before start", async () => {
    const start = vi.fn();
    const warmWorkerIsolate = vi.fn(() => new Promise<void>(() => undefined));

    beginRecognitionListening({
      provider: "workers-ai-asr",
      start,
      warmBrowserVibrato: () => new Promise<void>(() => undefined),
      warmWorkerIsolate,
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(warmWorkerIsolate).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("fires isolate warmup immediately for Web Speech before Vibrato warmup finishes", () => {
    const start = vi.fn();
    const warmWorkerIsolate = vi.fn(() => Promise.resolve());
    const warmBrowserVibrato = vi.fn(() => new Promise<void>(() => undefined));

    beginRecognitionListening({
      provider: "web-speech",
      start,
      warmBrowserVibrato,
      warmWorkerIsolate,
      requireVibratoWarmup: true,
    });

    expect(warmWorkerIsolate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts Web Speech even when isolate warmup fails", async () => {
    const start = vi.fn();
    const onWarmupNotice = vi.fn();
    const onWarmupError = vi.fn();

    beginRecognitionListening({
      provider: "web-speech",
      start,
      warmBrowserVibrato: () => Promise.resolve(),
      warmWorkerIsolate: () => Promise.reject(new Error("isolate cold")),
      onWarmupNotice,
      onWarmupError,
      requireVibratoWarmup: true,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(onWarmupError).not.toHaveBeenCalled();
    expect(onWarmupNotice).toHaveBeenCalledWith(
      `${WORKER_ISOLATE_WARMUP_FAILURE_NOTICE_PREFIX}isolate cold`,
    );
  });

  it("starts Web Speech after warmup notice when Vibrato is optional", async () => {
    const start = vi.fn();
    const onWarmupNotice = vi.fn();
    const onWarmupError = vi.fn();

    beginRecognitionListening({
      provider: "web-speech",
      start,
      warmBrowserVibrato: () => Promise.reject(new Error("dict failed")),
      onWarmupNotice,
      onWarmupError,
      requireVibratoWarmup: false,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(onWarmupNotice).toHaveBeenCalledWith(
      `${BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX}dict failed`,
    );
    expect(onWarmupError).not.toHaveBeenCalled();
  });
});
