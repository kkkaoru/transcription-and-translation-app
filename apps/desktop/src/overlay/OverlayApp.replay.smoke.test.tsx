// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_HOLD_CLEAR_MS, captionHoldClearEpoch } from "../core/caption-hold-clear";
import { clearCaptionLatency, getCaptionLatencySpan } from "../core/caption-latency";
import { clearCaptionMergeDiagnostics, getCaptionMergeDiagnostics } from "../core/caption-updates";
import { createDefaultConfig } from "../core/defaults";
import * as displayTiming from "../core/display-timing";
import type { CaptionPayload, PipelineStageEvent, RuntimeStatus, UnlistenFn } from "../core/types";
import { isOverlayCaption, OverlayApp } from "./OverlayApp";

const noopUnlisten: UnlistenFn = () => undefined;

const holdClearApi = vi.hoisted(() => ({
  onClear: null as null | ((expectedEpoch: string) => void),
}));

vi.mock("../live/useCaptionHoldClear", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live/useCaptionHoldClear")>();
  return {
    useCaptionHoldClear: (
      caption: CaptionPayload,
      onClear: (expectedEpoch: string) => void,
    ): void => {
      holdClearApi.onClear = onClear;
      actual.useCaptionHoldClear(caption, onClear);
    },
  };
});

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getLatestCaption: vi.fn(),
  getPipelineStageHistory: vi.fn(),
  isDesktop: vi.fn(),
  listenCaptions: vi.fn(),
  listenConfig: vi.fn(),
  listenPipelineStages: vi.fn(),
  listenRuntime: vi.fn(),
  publishOverlayFrame: vi.fn(),
}));

vi.mock("../core/bridge", () => ({
  bridge: mocks,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sourceCaption = (): CaptionPayload => ({
  id: "normalized-1",
  sourceText: "正規化された字幕",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 10,
  receivedAt: 20,
  stage: "source",
  sequence: 0,
  isFinal: false,
});

const translationCaption = (): CaptionPayload => ({
  ...sourceCaption(),
  translationText: "Normalized caption",
  receivedAt: 30,
  stage: "translation",
  sequence: 1,
  isFinal: true,
});

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
};

const nativeRendererRoot = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('[data-testid="native-renderer-root"]');

describe("OverlayApp caption replay", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captionListener: ((caption: CaptionPayload) => void) | null;
  let pipelineListener: ((stage: PipelineStageEvent) => void) | null;
  let runtimeListener: ((status: RuntimeStatus) => void) | null;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(sourceCaption());
    mocks.getPipelineStageHistory.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    captionListener = null;
    pipelineListener = null;
    runtimeListener = null;
    holdClearApi.onClear = null;
    mocks.listenCaptions
      .mockReset()
      .mockImplementation((callback: (caption: CaptionPayload) => void) => {
        captionListener = callback;
        return Promise.resolve(noopUnlisten);
      });
    mocks.listenPipelineStages
      .mockReset()
      .mockImplementation((callback: (stage: PipelineStageEvent) => void) => {
        pipelineListener = callback;
        return Promise.resolve(noopUnlisten);
      });
    mocks.listenRuntime
      .mockReset()
      .mockImplementation((callback: (status: RuntimeStatus) => void) => {
        runtimeListener = callback;
        return Promise.resolve(noopUnlisten);
      });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("replays a normalized source emitted before the listener Promise settles", async () => {
    let resolveListen!: (dispose: UnlistenFn) => void;
    mocks.listenCaptions.mockImplementation((callback: (caption: CaptionPayload) => void) => {
      captionListener = callback;
      return new Promise<UnlistenFn>((resolve) => {
        resolveListen = resolve;
      });
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(mocks.getLatestCaption).toHaveBeenCalled();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      captionListener?.(translationCaption());
      resolveListen(noopUnlisten);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-translation")?.textContent).toBe(
      "Normalized caption",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("keeps the overlay responsive when listener registration rejects", async () => {
    mocks.listenCaptions.mockRejectedValue(new Error("webview disconnected"));

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");
    expect(mocks.getLatestCaption).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("does not paint raw ASR stage payloads on the OBS route", async () => {
    mocks.getLatestCaption.mockResolvedValue({
      ...sourceCaption(),
      id: "asr-1",
      sourceText: "raw ASR text",
      stage: "asr" as CaptionPayload["stage"],
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("coalesces same-id source and translation updates into one overlay", async () => {
    const source = {
      ...sourceCaption(),
      id: "overlay-utterance",
      sourceText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_100,
      provisional: true,
    };
    mocks.getLatestCaption.mockResolvedValue(source);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      captionListener?.({
        ...source,
        sourceText: "明日は",
        provisional: undefined,
        receivedAt: 1_200,
      });
      captionListener?.({
        ...source,
        sourceText: "明日は",
        provisional: undefined,
        translationText: "Tomorrow",
        receivedAt: 1_300,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      });
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelectorAll(".caption-line-source")).toHaveLength(1);
    expect(container.querySelectorAll(".caption-line-translation")).toHaveLength(1);
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("明日は");
    expect(container.querySelector(".caption-line-translation")?.textContent).toBe("Tomorrow");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("renders a raw source-mode caption directly on the standard source line", async () => {
    mocks.getLatestCaption.mockResolvedValue({
      ...sourceCaption(),
      id: "raw-utterance",
      sourceText: "漢字とひらがな",
      translationText: "",
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelectorAll(".caption-line-source")).toHaveLength(1);
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("漢字とひらがな");
    // Empty translation keeps a reserved slot so layout does not jump when EN arrives.
    expect(container.querySelector(".caption-line-translation")?.getAttribute("data-empty")).toBe(
      "true",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("starts the native-renderer route with preview text for OBS layout", async () => {
    history.pushState({}, "", "/?overlay=1&native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")).toBeNull();
    expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
      "これはプレビュー用の字幕です。",
    );
    expect(nativeRendererRoot(container)?.getAttribute("data-translation-text")).toBe(
      "This is a preview caption.",
    );
    expect(container.querySelector(".native-output-canvas")).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    history.replaceState({}, "", "/");
    container.remove();
  });

  it("replaces native preview text with the first live caption", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")).toBeNull();
    expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      captionListener?.(sourceCaption());
      await Promise.resolve();
    });
    expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
      "正規化された字幕",
    );

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "macos",
        backendReachable: true,
        nativeOutput: "syphon",
        lastError: null,
      });
      await Promise.resolve();
    });
    expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
      "これはプレビュー用の字幕です。",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    history.replaceState({}, "", "/");
    container.remove();
  });

  it("paints ASR pipeline stages as provisional source on the native-renderer before caption:update", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();

      await act(async () => {
        pipelineListener?.({
          stage: "asr",
          utteranceId: "parapper:s:1:8",
          modelId: "parapper-ja",
          inputSnippet: "",
          outputText: "きょうは",
          surfaceText: "今日は",
          startedAt: 10,
          at: 40,
          durationMs: 30,
          ok: true,
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe("今日は");
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("replays the latest ASR stage from native history before caption:update", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);
    mocks.getPipelineStageHistory.mockResolvedValue([
      {
        stage: "normalize",
        utteranceId: "parapper:s:1:7",
        modelId: "azookey-rust",
        inputSnippet: "",
        outputText: "古い正規化",
        startedAt: 1,
        at: 20,
        durationMs: 19,
        ok: true,
      },
      {
        stage: "asr",
        utteranceId: "parapper:s:1:8",
        modelId: "parapper-ja",
        inputSnippet: "",
        outputText: "きょうは",
        surfaceText: "今日は",
        startedAt: 10,
        at: 40,
        durationMs: 30,
        ok: true,
      },
    ]);

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe("今日は");
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("does not first-paint a short getLatestCaption over preview before longer ASR history", async () => {
    history.pushState({}, "", "/?native=1");
    let resolveHistory!: (events: PipelineStageEvent[]) => void;
    mocks.getLatestCaption.mockResolvedValue({
      id: "parapper:s:1:8",
      sourceText: "今日は",
      translationText: "",
      sourceLanguage: "ja",
      targetLanguage: "en",
      startedAt: 10,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    mocks.getPipelineStageHistory.mockReturnValue(
      new Promise<PipelineStageEvent[]>((resolve) => {
        resolveHistory = resolve;
      }),
    );

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "これはプレビュー用の字幕です。",
      );

      await act(async () => {
        resolveHistory([
          {
            stage: "asr",
            utteranceId: "parapper:s:1:8",
            modelId: "parapper-ja",
            inputSnippet: "",
            outputText: "きょうはいいてんきですね",
            startedAt: 40,
            at: 80,
            durationMs: 40,
            ok: true,
          },
        ]);
        await Promise.resolve();
      });
      await flush();
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("keeps longer ASR history when a short getLatestCaption would replace preview first", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue({
      id: "parapper:s:1:8",
      sourceText: "今日は",
      translationText: "",
      sourceLanguage: "ja",
      targetLanguage: "en",
      startedAt: 10,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    mocks.getPipelineStageHistory.mockResolvedValue([
      {
        stage: "asr",
        utteranceId: "parapper:s:1:8",
        modelId: "parapper-ja",
        inputSnippet: "",
        outputText: "きょうはいいてんきですね",
        startedAt: 40,
        at: 80,
        durationMs: 40,
        ok: true,
      },
    ]);

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("keeps a longer ASR provisional when a stale shorter caption:update races in", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();

      await act(async () => {
        pipelineListener?.({
          stage: "asr",
          utteranceId: "parapper:s:1:8",
          modelId: "parapper-ja",
          inputSnippet: "",
          outputText: "きょうはいいてんきですね",
          startedAt: 40,
          at: 80,
          durationMs: 40,
          ok: true,
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );

      await act(async () => {
        captionListener?.({
          id: "parapper:s:1:8",
          sourceText: "今日は",
          translationText: "",
          sourceLanguage: "ja",
          targetLanguage: "en",
          startedAt: 10,
          receivedAt: 20,
          stage: "source",
          sequence: 0,
          isFinal: false,
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("keeps a longer ASR provisional when a truncated final caption:update races in", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();

      await act(async () => {
        pipelineListener?.({
          stage: "asr",
          utteranceId: "parapper:s:1:8",
          modelId: "parapper-ja",
          inputSnippet: "",
          outputText: "きょうはいいてんきですね",
          startedAt: 40,
          at: 80,
          durationMs: 40,
          ok: true,
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );

      await act(async () => {
        captionListener?.({
          id: "parapper:s:1:8",
          sourceText: "今日は",
          translationText: "",
          sourceLanguage: "ja",
          targetLanguage: "en",
          startedAt: 10,
          receivedAt: 90,
          stage: "source",
          sequence: 0,
          isFinal: true,
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe(
        "きょうはいいてんきですね",
      );
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("joins flattened *_at from an ASR stage onto the overlay first-paint span", async () => {
    history.pushState({}, "", "/?native=1");
    mocks.getLatestCaption.mockResolvedValue(null);
    clearCaptionLatency();

    try {
      await act(async () => {
        root.render(<OverlayApp />);
        await Promise.resolve();
      });
      await flush();

      await act(async () => {
        pipelineListener?.({
          stage: "asr",
          utteranceId: "parapper:s:1:8",
          modelId: "parapper-ja",
          inputSnippet: "",
          outputText: "きょうは",
          surfaceText: "今日は",
          startedAt: 10,
          at: 40,
          durationMs: 30,
          ok: true,
          asrLatency: {
            speech_start_at: 1_000,
            asr_dispatch_at: 1_010,
            first_partial_at: 1_040,
            asr_final_at: null,
          },
        });
        await Promise.resolve();
      });
      expect(nativeRendererRoot(container)?.getAttribute("data-source-text")).toBe("今日は");
      expect(getCaptionLatencySpan("parapper:s:1:8")).toMatchObject({
        speech_start_at: 1_000,
        first_partial_at: 1_040,
        speech_to_event_ms: 40,
      });
      expect(
        getCaptionLatencySpan("parapper:s:1:8")?.speech_to_first_paint_ms,
      ).toBeGreaterThanOrEqual(40);
    } finally {
      clearCaptionLatency();
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      history.replaceState({}, "", "/");
      container.remove();
    }
  });

  it("clears on successful idle and ignores caption events that arrive afterward", async () => {
    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "error",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "capture failed",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "capture failed",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "idle",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: null,
      });
      captionListener?.(translationCaption());
      await Promise.resolve();
    });

    expect(container.querySelector(".caption-line-source")?.getAttribute("data-empty")).toBe(
      "true",
    );
    expect(container.querySelector(".caption-line-translation")?.getAttribute("data-empty")).toBe(
      "true",
    );

    await act(async () => {
      runtimeListener?.({
        status: "capturing",
        platform: "unknown",
        backendReachable: true,
        nativeOutput: "unsupported",
        lastError: null,
      });
      captionListener?.({
        ...sourceCaption(),
        id: "normalized-after-restart",
        startedAt: Date.now() + 1,
        receivedAt: Date.now() + 2,
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("commits overlay merges once under StrictMode without duplicating display marks", async () => {
    // React StrictMode double-invokes state updaters. Merge + markCaptionDisplay
    // must run outside setState so each live event paints and times exactly once.
    mocks.getLatestCaption.mockResolvedValue(null);
    const markSpy = vi.spyOn(displayTiming, "markCaptionDisplay");
    clearCaptionMergeDiagnostics();

    await act(async () => {
      root.render(
        <StrictMode>
          <OverlayApp />
        </StrictMode>,
      );
      await Promise.resolve();
    });
    await flush();
    markSpy.mockClear();

    const live = {
      ...sourceCaption(),
      id: "overlay-strict-live",
      sourceText: "ライブ字幕",
      receivedAt: 50,
    };
    await act(async () => {
      captionListener?.(live);
      await Promise.resolve();
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.textContent).toBe("ライブ字幕");
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(markSpy.mock.calls[0]?.[0]?.id).toBe("overlay-strict-live");

    markSpy.mockClear();
    clearCaptionMergeDiagnostics();
    await act(async () => {
      captionListener?.({
        id: "older-turn",
        sourceText: "",
        translationText: "Stale translation",
        sourceLanguage: "ja",
        targetLanguage: "en",
        startedAt: 1,
        receivedAt: 60,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      });
      await Promise.resolve();
    });
    await flush();

    // Cross-id translation must stay off the live plate and land once in the
    // pending side channel (not twice from a StrictMode updater replay).
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("ライブ字幕");
    expect(markSpy).not.toHaveBeenCalled();
    expect(getCaptionMergeDiagnostics()).toMatchObject({
      crossIdTranslationIdsSaved: 1,
      pendingCrossIdTranslations: 1,
    });

    markSpy.mockRestore();
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("blanks a finalized overlay caption after hold-clear via captionRef", async () => {
    vi.useFakeTimers();
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    const finalized = {
      ...sourceCaption(),
      id: "overlay-hold-clear",
      sourceText: "ホールド後に消える",
      isFinal: true,
      receivedAt: 80,
    };
    await act(async () => {
      captionListener?.(finalized);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("ホールド後に消える");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_HOLD_CLEAR_MS);
    });
    await flush();

    expect(container.querySelector(".caption-line-source")?.getAttribute("data-empty")).toBe(
      "true",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.useRealTimers();
    container.remove();
  });

  it("ignores a stale hold-clear after a newer overlay caption replaces the plate", async () => {
    vi.useFakeTimers();
    mocks.getLatestCaption.mockResolvedValue(null);
    holdClearApi.onClear = null;

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    const oldFinal = {
      ...sourceCaption(),
      id: "overlay-hold-old",
      sourceText: "古い最終字幕",
      isFinal: true,
      receivedAt: 90,
    };
    await act(async () => {
      captionListener?.(oldFinal);
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_HOLD_CLEAR_MS - 1);
    });
    await act(async () => {
      captionListener?.({
        ...sourceCaption(),
        id: "overlay-hold-new",
        sourceText: "新しい最終字幕",
        isFinal: true,
        receivedAt: 100,
      });
      await Promise.resolve();
    });
    await flush();

    // Simulate a late timer from the replaced utterance: captionRef already
    // points at the newer final, so blanking must no-op.
    await act(async () => {
      holdClearApi.onClear?.(captionHoldClearEpoch(oldFinal));
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("新しい最終字幕");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_HOLD_CLEAR_MS);
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.getAttribute("data-empty")).toBe(
      "true",
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.useRealTimers();
    container.remove();
  });

  it("does not revive a hold-cleared plate from a late older payload", async () => {
    vi.useFakeTimers();
    mocks.getLatestCaption.mockResolvedValue(null);

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    const finalized = {
      ...sourceCaption(),
      id: "overlay-hold-stale-revive",
      sourceText: "消えたあとに戻ってはいけない",
      isFinal: true,
      startedAt: 70,
      receivedAt: 80,
    };
    await act(async () => {
      captionListener?.(finalized);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe(
      "消えたあとに戻ってはいけない",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_HOLD_CLEAR_MS);
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.getAttribute("data-empty")).toBe(
      "true",
    );

    // Same utterance, slightly newer receipt than the painted final, but still
    // older than the hold-clear itself. createEmptyCaption() used receivedAt: 0,
    // so merge treated this as the first live caption after reset.
    await act(async () => {
      captionListener?.({
        ...finalized,
        receivedAt: 90,
      });
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.getAttribute("data-empty")).toBe(
      "true",
    );

    await act(async () => {
      captionListener?.({
        ...sourceCaption(),
        id: "overlay-after-hold-clear",
        sourceText: "新しい発話",
        isFinal: false,
        startedAt: Date.now(),
        receivedAt: Date.now() + 1,
      });
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("新しい発話");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.useRealTimers();
    container.remove();
  });
});

describe("isOverlayCaption", () => {
  it("rejects non-display stages even when text is present", () => {
    expect(isOverlayCaption({ ...sourceCaption(), stage: "asr" as CaptionPayload["stage"] })).toBe(
      false,
    );
    expect(
      isOverlayCaption({ ...sourceCaption(), stage: "translate" as CaptionPayload["stage"] }),
    ).toBe(false);
  });

  it("accepts a caption with only a trimmed source line", () => {
    expect(isOverlayCaption({ ...sourceCaption(), translationText: "" })).toBe(true);
  });

  it("accepts a caption whose translation is non-empty even when source is blank", () => {
    expect(
      isOverlayCaption({ ...sourceCaption(), sourceText: "   ", translationText: "訳文" }),
    ).toBe(true);
  });

  it("rejects a caption with only whitespace on both lines", () => {
    expect(isOverlayCaption({ ...sourceCaption(), sourceText: " \t", translationText: "  " })).toBe(
      false,
    );
  });
});
describe("OverlayApp listener cleanup robustness", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.getPipelineStageHistory.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenPipelineStages.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("tolerates a promise-like unlisten and a throwing unlisten on unmount", async () => {
    const promiseLike = (): PromiseLike<unknown> => Promise.resolve().then(() => undefined);
    mocks.listenConfig.mockResolvedValue(promiseLike as unknown as UnlistenFn);
    mocks.listenCaptions.mockResolvedValue(() => {
      throw new Error("webview gone");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("keeps the previous caption when runtime reports an error status", async () => {
    mocks.getLatestCaption.mockResolvedValue(sourceCaption());
    let runtimeListener: ((status: RuntimeStatus) => void) | null = null;
    mocks.listenRuntime.mockImplementation((callback: (status: RuntimeStatus) => void) => {
      runtimeListener = callback;
      return Promise.resolve(noopUnlisten);
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      runtimeListener?.({
        status: "error",
        platform: "unknown",
        backendReachable: false,
        nativeOutput: "unsupported",
        lastError: "boom",
      });
      await Promise.resolve();
    });
    expect(container.querySelector(".caption-line-source")?.textContent).toBe("正規化された字幕");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});
describe("OverlayApp synchronous bridge throws", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.getPipelineStageHistory.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenPipelineStages.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("survives a bridge.getLatestCaption() that throws synchronously", async () => {
    mocks.getLatestCaption.mockImplementation(() => {
      throw new Error("ipc unavailable");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    // The overlay still mounts and subscribes even when history replay throws.
    expect(mocks.listenCaptions).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it("falls back cleanly when bridge.listenCaptions throws synchronously", async () => {
    mocks.listenCaptions.mockImplementation(() => {
      throw new Error("listen unavailable");
    });

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await flush();
    // No crash; the reject path still runs a best-effort history read.
    expect(mocks.getLatestCaption).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });
});
describe("OverlayApp resolves listeners after unmount", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.getPipelineStageHistory.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenPipelineStages.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("disposes a late-resolving config listener after unmount", async () => {
    let resolveConfig!: (dispose: UnlistenFn) => void;
    mocks.listenConfig.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          resolveConfig = resolve;
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    // Resolve the config listener only after unmount: the else-dispose path runs.
    await act(async () => {
      resolveConfig(() => {
        throw new Error("late dispose");
      });
      await Promise.resolve();
    });
    container.remove();
  });

  it("disposes a late-resolving runtime listener after unmount", async () => {
    let resolveRuntime!: (dispose: UnlistenFn) => void;
    mocks.listenRuntime.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          resolveRuntime = resolve;
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    await act(async () => {
      resolveRuntime(() => undefined);
      await Promise.resolve();
    });
    container.remove();
  });
});

describe("OverlayApp caption listener late dispose", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.isDesktop.mockReset().mockReturnValue(false);
    mocks.getConfig.mockReset().mockResolvedValue(createDefaultConfig());
    mocks.getLatestCaption.mockReset().mockResolvedValue(null);
    mocks.getPipelineStageHistory.mockReset().mockResolvedValue([]);
    mocks.listenConfig.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenCaptions.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenPipelineStages.mockReset().mockResolvedValue(noopUnlisten);
    mocks.listenRuntime.mockReset().mockImplementation(() => Promise.resolve(noopUnlisten));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("disposes a caption listener that resolves after unmount", async () => {
    let resolved = false;
    mocks.listenCaptions.mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(() => undefined);
          }, 0);
        }),
    );

    await act(async () => {
      root.render(<OverlayApp />);
      await Promise.resolve();
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(resolved).toBe(true);
    container.remove();
  });
});
