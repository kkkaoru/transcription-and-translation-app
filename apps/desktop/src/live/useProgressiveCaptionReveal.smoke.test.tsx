// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionPayload } from "../core/types";
import { useProgressiveCaptionReveal } from "./useProgressiveCaptionReveal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const baseCaption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...partial,
});

const Probe = ({
  caption,
  onPaint,
}: {
  caption: CaptionPayload;
  onPaint: (revealed: CaptionPayload) => void;
}) => {
  const revealed = useProgressiveCaptionReveal(caption);
  onPaint(revealed);
  return null;
};

describe("useProgressiveCaptionReveal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let paints: CaptionPayload[];

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  const renderCaption = (caption: CaptionPayload): void => {
    act(() => {
      root.render(
        <Probe
          caption={caption}
          onPaint={(revealed) => {
            paints.push(revealed);
          }}
        />,
      );
    });
  };

  it("reveals a longer same-turn hypothesis one grapheme at a time", () => {
    renderCaption(baseCaption({ sourceText: "" }));
    paints = [];
    renderCaption(baseCaption({ sourceText: "こんにちは" }));
    // First grapheme must paint on the same update — never hold a blank plate
    // for a full progressive step after the first hypothesis arrives.
    expect(paints.at(-1)?.sourceText).toBe("こ");

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(paints.at(-1)?.sourceText).toBe("こん");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(paints.at(-1)?.sourceText).toBe("こんにちは");
  });

  it("snaps immediately when the utterance id changes mid-reveal", () => {
    renderCaption(baseCaption({ sourceText: "" }));
    renderCaption(baseCaption({ sourceText: "こんにちは" }));
    expect(paints.at(-1)?.sourceText).toBe("こ");

    paints = [];
    renderCaption(
      baseCaption({
        id: "parapper:session:turn:2",
        sourceText: "明日は晴れ",
      }),
    );
    expect(paints.at(-1)?.sourceText).toBe("明日は晴れ");
  });

  it("snaps immediately on same-turn kana-to-kanji rewrites", () => {
    renderCaption(baseCaption({ sourceText: "" }));
    renderCaption(baseCaption({ sourceText: "あしたは" }));
    expect(paints.at(-1)?.sourceText).toBe("あ");

    paints = [];
    renderCaption(baseCaption({ sourceText: "明日は" }));
    expect(paints.at(-1)?.sourceText).toBe("明日は");
  });

  it("does not flash prior clauses while revealing a multi-clause final", () => {
    renderCaption(baseCaption({ sourceText: "" }));
    paints = [];
    renderCaption(
      baseCaption({
        sourceText: "今日は晴れです。明日は雨です",
        isFinal: true,
      }),
    );

    // Reveal targets the newest paged sentence. Intermediate paints may be
    // prefixes of 「明日は雨です」 (including 「明」), but must never recreate
    // the finished first clause that sentence paging would then collapse away.
    const midRevealPaints: string[] = [];
    act(() => {
      for (let step = 0; step < 12; step += 1) {
        vi.advanceTimersByTime(20);
        const latest = paints.at(-1)?.sourceText;
        if (typeof latest === "string") {
          midRevealPaints.push(latest);
        }
      }
    });

    expect(midRevealPaints.some((text) => text.includes("今日は晴れです"))).toBe(false);
    expect(
      midRevealPaints
        .filter((text) => text.length > 0 && text !== "今日は晴れです。明日は雨です")
        .every((text) => "明日は雨です".startsWith(text)),
    ).toBe(true);
    expect(paints.at(-1)?.sourceText).toBe("今日は晴れです。明日は雨です");
  });

  it("does not carry final sentenceEndOffsets onto progressive partial paints", () => {
    const spoken = "こんにちはーきこえますか";
    renderCaption(baseCaption({ sourceText: "" }));
    paints = [];
    renderCaption(
      baseCaption({
        sourceText: spoken,
        sentenceEndOffsets: [5],
        softBreakOffsets: [3],
      }),
    );

    expect(paints.at(-1)?.sourceText).toBe("こ");
    expect(paints.at(-1)?.sentenceEndOffsets).toBeUndefined();
    expect(paints.at(-1)?.softBreakOffsets).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    const mid = paints.at(-1);
    expect(mid?.sourceText).toBeTruthy();
    expect(mid?.sourceText).not.toBe(spoken);
    expect(mid?.sentenceEndOffsets).toBeUndefined();
    expect(mid?.softBreakOffsets).toBeUndefined();
    expect(mid?.sourceText).not.toBe("ー");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    const done = paints.at(-1);
    expect(done?.sourceText).toBe(spoken);
    expect(done?.sentenceEndOffsets).toEqual([5]);
    expect(done?.softBreakOffsets).toEqual([3]);
  });

  it("does not carry full-text ends onto last-sentence progressive prefixes", () => {
    const full = "短いです今日はとても良い天気です";
    renderCaption(baseCaption({ sourceText: "" }));
    paints = [];
    renderCaption(
      baseCaption({
        sourceText: full,
        sentenceEndOffsets: [4],
      }),
    );

    expect(paints.at(-1)?.sourceText).toBe("今");
    expect(paints.at(-1)?.sentenceEndOffsets).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(80);
    });
    const mid = paints.at(-1);
    expect(mid?.sourceText).toBeTruthy();
    expect(mid?.sourceText).not.toBe(full);
    expect("今日はとても良い天気です".startsWith(mid?.sourceText ?? "")).toBe(true);
    expect(mid?.sentenceEndOffsets).toBeUndefined();
    expect(mid?.sourceText).not.toBe("て");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    const done = paints.at(-1);
    expect(done?.sourceText).toBe(full);
    expect(done?.sentenceEndOffsets).toEqual([4]);
  });
});
