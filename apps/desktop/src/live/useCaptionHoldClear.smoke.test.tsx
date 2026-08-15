// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_HOLD_CLEAR_MS, captionHoldClearEpoch } from "../core/caption-hold-clear";
import { __resetStructuredLogForTests, getStructuredLogs } from "../core/structuredLog";
import type { CaptionPayload } from "../core/types";
import { useCaptionHoldClear } from "./useCaptionHoldClear";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseCaption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "今日は晴れです",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1_000,
  stage: "source",
  sequence: 0,
  isFinal: true,
  captureGeneration: 1,
  ...partial,
});

const Probe = ({
  caption,
  onClear,
}: {
  caption: CaptionPayload;
  onClear: (expectedEpoch: string) => void;
}) => {
  useCaptionHoldClear(caption, onClear);
  return null;
};

describe("useCaptionHoldClear", () => {
  let container: HTMLDivElement;
  let root: Root;
  let cleared: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    __resetStructuredLogForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cleared = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    __resetStructuredLogForTests();
    vi.useRealTimers();
  });

  const renderHold = (caption: CaptionPayload): void => {
    act(() => {
      root.render(
        <Probe
          caption={caption}
          onClear={(expectedEpoch) => {
            cleared.push(expectedEpoch);
          }}
        />,
      );
    });
  };

  it("does not restart the hold timer when a same-epoch caption object is replaced", async () => {
    const first = baseCaption();
    const later = baseCaption({ captureGeneration: 2, startedAt: 1_500 });
    expect(captionHoldClearEpoch(first)).toBe(captionHoldClearEpoch(later));

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderHold(first);
    const holdTimersAfterFirst = setTimeoutSpy.mock.calls.filter(
      (call) => call[1] === CAPTION_HOLD_CLEAR_MS,
    ).length;
    expect(holdTimersAfterFirst).toBeGreaterThan(0);

    renderHold(later);
    const holdTimersAfterRerender = setTimeoutSpy.mock.calls.filter(
      (call) => call[1] === CAPTION_HOLD_CLEAR_MS,
    ).length;
    expect(holdTimersAfterRerender).toBe(holdTimersAfterFirst);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CAPTION_HOLD_CLEAR_MS - 1);
    });
    expect(cleared).toStrictEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(cleared).toStrictEqual([captionHoldClearEpoch(first)]);
  });

  it("does not schedule a hold timer for a non-final caption without translation", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderHold(baseCaption({ isFinal: false, translationText: "" }));
    expect(
      setTimeoutSpy.mock.calls.filter((call) => call[1] === CAPTION_HOLD_CLEAR_MS),
    ).toHaveLength(0);
    expect(cleared).toStrictEqual([]);
  });

  it("logs the caption that is current when the hold starts, not a stale render", () => {
    const first = baseCaption({ captureGeneration: 1 });
    const current = baseCaption({ captureGeneration: 7, startedAt: 1_500 });
    expect(captionHoldClearEpoch(first)).toBe(captionHoldClearEpoch(current));

    act(() => {
      root.render(
        <Probe
          caption={first}
          onClear={(expectedEpoch) => {
            cleared.push(expectedEpoch);
          }}
        />,
      );
      root.render(
        <Probe
          caption={current}
          onClear={(expectedEpoch) => {
            cleared.push(expectedEpoch);
          }}
        />,
      );
    });

    const holdLogs = getStructuredLogs().filter((row) =>
      row.message.startsWith("caption display lifecycle=hold"),
    );
    expect(holdLogs).toHaveLength(1);
    expect(holdLogs[0]?.message).toBe(
      "caption display lifecycle=hold age_ms=1000 generation=7 has_translation=false",
    );
    expect(holdLogs[0]?.fields).toMatchObject({
      lifecycle: "hold",
      ageMs: 1000,
      generation: 7,
    });
    expect(JSON.stringify(holdLogs[0])).not.toContain("今日は晴れです");
  });
});
