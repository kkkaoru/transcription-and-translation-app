import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX,
  beginRecognitionListening,
} from "./recognition-listen";

describe("beginRecognitionListening", () => {
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
