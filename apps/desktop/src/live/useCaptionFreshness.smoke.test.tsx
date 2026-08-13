// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCaptionBoundaryOffsetCache } from "../core/caption-boundary-offsets";
import { CAPTION_FRESHNESS_MS } from "../core/caption-freshness";
import type { CaptionPayload } from "../core/types";
import { useCaptionFreshness } from "./useCaptionFreshness";
import { useProgressiveCaptionReveal } from "./useProgressiveCaptionReveal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseCaption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "今日は晴れです明日は雨",
  translationText: "It is sunny",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  sentenceEndOffsets: [7],
  softBreakOffsets: [3, 7],
  ...partial,
});

const FreshnessProbe = ({
  caption,
  onPaint,
}: {
  caption: CaptionPayload;
  onPaint: (fresh: CaptionPayload) => void;
}) => {
  onPaint(useCaptionFreshness(caption));
  return null;
};

const OverlayLiveProbe = ({
  caption,
  onOverlay,
  onLive,
}: {
  caption: CaptionPayload;
  onOverlay: (caption: CaptionPayload) => void;
  onLive: (caption: CaptionPayload) => void;
}) => {
  const freshnessCaption = useCaptionFreshness(caption);
  const overlayPaint = useProgressiveCaptionReveal(freshnessCaption, {
    snapAvailablePrefixExtensions: true,
  });
  const livePaint = useProgressiveCaptionReveal(freshnessCaption, {
    snapAvailablePrefixExtensions: true,
  });
  onOverlay(overlayPaint);
  onLive(livePaint);
  return null;
};

describe("useCaptionFreshness", () => {
  let container: HTMLDivElement;
  let root: Root;
  let paints: CaptionPayload[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetCaptionBoundaryOffsetCache();
    vi.mocked(invoke).mockReset();
    window.__TAURI_INTERNALS__ = {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    paints = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetCaptionBoundaryOffsetCache();
    window.__TAURI_INTERNALS__ = undefined;
    vi.useRealTimers();
  });

  const renderFresh = (caption: CaptionPayload): void => {
    act(() => {
      root.render(
        <FreshnessProbe
          caption={caption}
          onPaint={(fresh) => {
            paints.push(fresh);
          }}
        />,
      );
    });
  };

  it("cuts a completed です chunk after 5s and resets stamps when id changes", async () => {
    renderFresh(baseCaption());
    expect(paints.at(-1)?.sourceText).toBe("今日は晴れです明日は雨");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_FRESHNESS_MS);
    });
    expect(paints.at(-1)?.sourceText).toBe("明日は雨");

    paints = [];
    renderFresh(baseCaption({ id: "parapper:session:turn:2" }));
    expect(paints.at(-1)?.sourceText).toBe("今日は晴れです明日は雨");
  });

  it("keeps Overlay and Live on the same freshness result", async () => {
    const overlayPaints: CaptionPayload[] = [];
    const livePaints: CaptionPayload[] = [];
    act(() => {
      root.render(
        <OverlayLiveProbe
          caption={baseCaption()}
          onOverlay={(caption) => overlayPaints.push(caption)}
          onLive={(caption) => livePaints.push(caption)}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_FRESHNESS_MS);
    });
    expect(overlayPaints.at(-1)?.sourceText).toBe("明日は雨");
    expect(livePaints.at(-1)?.sourceText).toBe(overlayPaints.at(-1)?.sourceText);
    expect(livePaints.at(-1)?.translationText).toBe(overlayPaints.at(-1)?.translationText);
  });

  it("invokes Rust only when source identity changes, not on reveal ticks", async () => {
    vi.mocked(invoke).mockResolvedValue({
      tokens: [
        { surface: "です", feature: "助動詞,*,*,*,特殊・デス,基本形,です,デス,デス", charEnd: 7 },
      ],
      sentenceEnds: [7],
      softBreaks: [3, 7],
    });
    renderFresh(baseCaption({ sentenceEndOffsets: undefined, softBreakOffsets: undefined }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("caption_boundary_offsets", {
      text: "今日は晴れです明日は雨",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 20);
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    renderFresh(
      baseCaption({
        sourceText: "今日は晴れです明日は雨です",
        sentenceEndOffsets: undefined,
        softBreakOffsets: undefined,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not invoke when pipeline offsets are already present", async () => {
    renderFresh(baseCaption());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12);
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves preview and empty plates untouched", () => {
    renderFresh(baseCaption({ id: "preview", sourceText: "サンプル字幕" }));
    expect(paints.at(-1)?.sourceText).toBe("サンプル字幕");
  });
});
