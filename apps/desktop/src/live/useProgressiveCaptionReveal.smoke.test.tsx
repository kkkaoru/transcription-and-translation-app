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
  onPaint: (sourceText: string) => void;
}) => {
  const revealed = useProgressiveCaptionReveal(caption);
  onPaint(revealed.sourceText);
  return null;
};

describe("useProgressiveCaptionReveal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let paints: string[];

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
          onPaint={(sourceText) => {
            paints.push(sourceText);
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
    expect(paints.at(-1)).toBe("こ");

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(paints.at(-1)).toBe("こん");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(paints.at(-1)).toBe("こんにちは");
  });

  it("snaps immediately when the utterance id changes mid-reveal", () => {
    renderCaption(baseCaption({ sourceText: "" }));
    renderCaption(baseCaption({ sourceText: "こんにちは" }));
    expect(paints.at(-1)).toBe("こ");

    paints = [];
    renderCaption(
      baseCaption({
        id: "parapper:session:turn:2",
        sourceText: "明日は晴れ",
      }),
    );
    expect(paints.at(-1)).toBe("明日は晴れ");
  });
});
