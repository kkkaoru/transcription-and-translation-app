/**
 * Machine-checkable caption quality contracts.
 *
 * These assertions encode streaming UX requirements so regressions are caught
 * without a human watching OBS/Live preview.
 */
// @vitest-environment jsdom

import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPTION_HOLD_CLEAR_MS,
  captionHoldClearDelayMs,
} from "../core/caption-hold-clear";
import { mergeCaptionPayload } from "../core/caption-updates";
import { createDefaultConfig } from "../core/defaults";
import {
  advanceProgressiveReveal,
  shouldProgressivelyReveal,
} from "../core/progressive-caption-reveal";
import type { CaptionPayload } from "../core/types";
import { CaptionLines } from "./CaptionOverlay";
import {
  captionItems,
  captionTextLines,
  createEmptyCaption,
  createPreviewCaption,
} from "./captions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const caption = (partial: Partial<CaptionPayload>): CaptionPayload => ({
  id: "u-1",
  sourceText: "今日は晴れ",
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

const expectMerged = (value: CaptionPayload | null): CaptionPayload => {
  expect(value).not.toBeNull();
  if (value == null) {
    throw new Error("expected mergeCaptionPayload to accept the revision");
  }
  return value;
};

describe("caption quality contracts (automated, no human eyeball)", () => {
  describe("viewer hold / blank gaps", () => {
    it("keeps finalized captions readable for at least 4 seconds", () => {
      expect(CAPTION_HOLD_CLEAR_MS).toBeGreaterThanOrEqual(4_000);
      expect(captionHoldClearDelayMs(caption({ isFinal: true }))).toBe(CAPTION_HOLD_CLEAR_MS);
    });

    it("does not auto-clear non-final captions during long speech gaps", () => {
      expect(captionHoldClearDelayMs(caption({ isFinal: false }))).toBeNull();
      expect(captionHoldClearDelayMs(caption({ isFinal: false, provisional: true }))).toBeNull();
    });
  });

  describe("prefix-stuck: interim to longer final across reveal and hold-clear", () => {
    it("grows from an early short final to a backdated longer completion", () => {
      const interim = caption({
        id: "parapper:session:turn:1",
        sourceText: "こんにちは",
        provisional: true,
        startedAt: 2_000,
        receivedAt: 2_000,
      });
      expect(captionHoldClearDelayMs(interim)).toBeNull();
      expect(shouldProgressivelyReveal("", interim.sourceText)).toBe(true);

      const shortFinal = expectMerged(
        mergeCaptionPayload(
          interim,
          caption({
            id: "parapper:session:turn:1",
            sourceText: "こんにちは",
            isFinal: true,
            startedAt: 1_000,
            receivedAt: 2_500,
          }),
        ),
      );
      expect(shortFinal.sourceText).toBe("こんにちは");
      expect(shortFinal.isFinal).toBe(true);
      expect(captionHoldClearDelayMs(shortFinal)).toBe(CAPTION_HOLD_CLEAR_MS);

      const longerFinal = expectMerged(
        mergeCaptionPayload(
          shortFinal,
          caption({
            id: "parapper:session:turn:1",
            sourceText: "こんにちはきこえますか",
            isFinal: true,
            startedAt: 800,
            receivedAt: 3_200,
          }),
        ),
      );
      expect(longerFinal.sourceText).toBe("こんにちはきこえますか");
      expect(captionHoldClearDelayMs(longerFinal)).toBe(CAPTION_HOLD_CLEAR_MS);
      expect(shouldProgressivelyReveal(shortFinal.sourceText, longerFinal.sourceText)).toBe(true);

      let displayed = shortFinal.sourceText;
      while (displayed !== longerFinal.sourceText) {
        displayed = advanceProgressiveReveal(displayed, longerFinal.sourceText);
      }
      expect(displayed).toBe("こんにちはきこえますか");

      expect(mergeCaptionPayload(createEmptyCaption(), longerFinal)?.sourceText).toBe(
        "こんにちはきこえますか",
      );
    });
  });

  describe("finished clauses leave the plate (POS / punctuation / offsets)", () => {
    it("pages soft copula + strong restart without waiting for punctuation", () => {
      expect(selectVisibleCaptionSentence("今日は晴れです明日は雨")).toBe("明日は雨");
      expect(selectVisibleCaptionSentence("それはとても良い天気だと思いますね今日は")).toBe(
        "今日は",
      );
    });

    it("pages mid-speech so the newest ending phrase owns the plate", () => {
      const full =
        "本日はウェビナーにご参加いただきありがとうございます最後に質問をお受けしますね";
      expect(selectVisibleCaptionSentence(full)).toBe("最後に質問をお受けしますね");
      expect(
        captionTextLines({ key: "source", text: full, maxChars: 28 }).join(""),
      ).toBe("最後に質問をお受けしますね");
      // While the ending phrase is still open, old thanks must already be gone.
      expect(
        selectVisibleCaptionSentence(
          "本日はウェビナーにご参加いただきありがとうございます最後に質問を",
        ),
      ).toBe("最後に質問を");
    });

    it("keeps elongated greetings with their continuation on the plate", () => {
      const spoken = "こんにちはーきこえますか";
      expect(selectVisibleCaptionSentence(spoken)).toBe(spoken);
      expect(
        selectVisibleCaptionSentence(spoken, { sentenceEndOffsets: [5] }),
      ).toBe(spoken);
      const lines = captionTextLines({ key: "source", text: spoken, maxChars: 28 });
      expect(lines.join("")).toBe(spoken);
      expect(lines).toEqual([spoken]);
    });

    it("does not drop the greeting when stale Vibrato offsets arrive with a longer surface", () => {
      expect(
        selectVisibleCaptionSentence("こんにちはきこえますか", { sentenceEndOffsets: [5] }),
      ).toBe("こんにちはきこえますか");
      expect(
        captionTextLines({
          key: "source",
          text: "こんにちはきこえますか",
          maxChars: 28,
          sentenceEndOffsets: [5],
        }),
      ).toEqual(["こんにちはきこえますか"]);
    });

    it("does not soft-wrap after こんにちは so the continuation stays visible", () => {
      const spoken = "こんにちはきこえますか";
      expect(captionTextLines({ key: "source", text: spoken, maxChars: 28 })).toEqual([spoken]);
    });

    it("keeps greeting when ZenZ inserts a period before 聞こえますか", () => {
      const zenz = "こんにちは。聞こえますか。";
      expect(captionTextLines({ key: "source", text: zenz, maxChars: 28 }).join("")).toBe(
        "こんにちは聞こえますか。",
      );
    });

    it("does not page away the recognized head after a topic は offset", () => {
      const weather = "明日の天気は晴れ水確率は60%";
      expect(selectVisibleCaptionSentence(weather, { sentenceEndOffsets: [6] })).toBe(weather);
      expect(
        captionTextLines({
          key: "source",
          text: weather,
          maxChars: 28,
          sentenceEndOffsets: [6],
        }).join(""),
      ).toBe(weather);
    });

    it("keeps です intact in the preview caption wrap", () => {
      const preview = "これはプレビュー用の字幕です。";
      const lines = captionTextLines({ key: "source", text: preview, maxChars: 28 });
      expect(lines.join("")).toBe(preview);
      expect(lines.some((line) => line.endsWith("で") && !line.endsWith("です"))).toBe(false);
      expect(lines.some((line) => line.includes("です"))).toBe(true);
    });

    it("does not insert line breaks while the utterance fits maxChars", () => {
      const samples = [
        "今日の天気は晴れ。",
        "今日はとても良い天気で明日も",
        "最後に質問をお受けしますね",
        "これはプレビュー用の字幕です。",
      ];
      for (const text of samples) {
        expect(captionTextLines({ key: "source", text, maxChars: 28 })).toEqual([text]);
      }
    });

    it("honors Vibrato/IPADIC sentenceEndOffsets over residual older surface", () => {
      expect(
        selectVisibleCaptionSentence("短いです続く文", { sentenceEndOffsets: [4] }),
      ).toBe("続く文");
      expect(
        captionTextLines({
          key: "source",
          text: "もう走る次いく",
          maxChars: 28,
          sentenceEndOffsets: [4],
        }),
      ).toEqual(["次いく"]);
    });

    it("keeps a single newest clause for non-final live captionItems", () => {
      const items = captionItems(createDefaultConfig(), {
        ...createPreviewCaption(),
        id: "live",
        sourceText: "今日は晴れです。明日は雨",
        translationText: "",
        isFinal: false,
      });
      const source = items.find((item) => item.key === "source");
      expect(captionTextLines(source!)).toEqual(["明日は雨"]);
      expect(captionTextLines(source!).length).toBe(1);
    });
  });

  describe("utterance switch must drop stale prior text", () => {
    it("replaces a prior Parapper turn instead of keeping the old clause on screen", () => {
      const previous = caption({
        id: "parapper:session:turn:1",
        sourceText: "本日はご参加いただきありがとうございます",
        isFinal: true,
        receivedAt: 100,
      });
      const nextTurn = caption({
        id: "parapper:session:turn:2",
        sourceText: "質問をお受けしますね",
        receivedAt: 200,
        startedAt: 50,
      });
      const merged = mergeCaptionPayload(previous, nextTurn);
      expect(merged?.sourceText).toBe("質問をお受けしますね");
      expect(merged?.sourceText).not.toContain("ありがとうございます");
    });
  });

  describe("conversion quality: truncated final must not erase longer surface", () => {
    it("keeps longer painted text when final is a strict prefix truncation", () => {
      const longer = caption({
        sourceText: "今日はいい天気ですね",
        provisional: true,
        receivedAt: 100,
      });
      const truncatedFinal = caption({
        sourceText: "今日はいい天気",
        isFinal: true,
        receivedAt: 200,
        startedAt: 50,
      });
      expect(mergeCaptionPayload(longer, truncatedFinal)?.sourceText).toBe("今日はいい天気ですね");
    });

    it("still accepts a longer rewritten final conversion", () => {
      const interim = caption({
        sourceText: "きょうは",
        provisional: true,
        receivedAt: 100,
      });
      const finalized = caption({
        sourceText: "今日は晴れです",
        isFinal: true,
        receivedAt: 200,
        startedAt: 50,
      });
      expect(mergeCaptionPayload(interim, finalized)?.sourceText).toBe("今日は晴れです");
    });

    it("appends きこえますか after an early-finalized こんにちは turn", () => {
      const greeting = caption({
        id: "parapper:session:turn:g1",
        sourceText: "こんにちは",
        isFinal: true,
        receivedAt: 100,
        startedAt: 50,
      });
      const continuation = caption({
        id: "parapper:session:turn:g2",
        sourceText: "きこえますか",
        receivedAt: 180,
        startedAt: 120,
      });
      expect(mergeCaptionPayload(greeting, continuation)?.sourceText).toBe(
        "こんにちはきこえますか",
      );
    });

    it("does not replace こんにちは with はい", () => {
      const greeting = caption({
        id: "parapper:session:turn:g3",
        sourceText: "こんにちは",
        provisional: true,
        receivedAt: 100,
      });
      const ack = caption({
        id: "parapper:session:turn:g3",
        sourceText: "はい",
        isFinal: true,
        receivedAt: 200,
        startedAt: 50,
      });
      expect(mergeCaptionPayload(greeting, ack)).toBeNull();
    });

    it("keeps the utterance tail stable when Parapper revises to a shorter prefix", () => {
      const withTail = caption({
        id: "parapper:session:turn:tail",
        sourceText: "今日は良い天気ですね",
        receivedAt: 100,
      });
      const shorter = caption({
        id: "parapper:session:turn:tail",
        sourceText: "今日は良い天気",
        receivedAt: 200,
        startedAt: 150,
      });
      expect(mergeCaptionPayload(withTail, shorter)?.sourceText).toBe("今日は良い天気ですね");
    });
  });

  describe("translation presence must not vertically shift source", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    });

    afterEach(() => {
      act(() => root.unmount());
      host.remove();
    });

    it("always reserves source and translation DOM slots", () => {
      const config = createDefaultConfig();
      act(() => {
        root.render(
          <CaptionLines
            config={config}
            caption={caption({ sourceText: "今日は晴れ", translationText: "" })}
          />,
        );
      });
      expect(host.querySelectorAll(".caption-line")).toHaveLength(2);
      expect(host.querySelector(".caption-line-source")).not.toBeNull();
      expect(host.querySelector(".caption-line-translation")?.getAttribute("data-empty")).toBe(
        "true",
      );
      const orderWithoutTranslation = [...host.querySelectorAll(".caption-line")].map((node) =>
        node.className.includes("source") ? "source" : "translation",
      );

      act(() => {
        root.render(
          <CaptionLines
            config={config}
            caption={caption({
              sourceText: "今日は晴れ",
              translationText: "It is sunny today",
              isFinal: true,
            })}
          />,
        );
      });
      expect(host.querySelectorAll(".caption-line")).toHaveLength(2);
      expect(host.querySelector(".caption-line-translation")?.getAttribute("data-empty")).toBeNull();
      const orderWithTranslation = [...host.querySelectorAll(".caption-line")].map((node) =>
        node.className.includes("source") ? "source" : "translation",
      );
      // Same slot order/count → source does not jump when translation appears.
      expect(orderWithTranslation).toEqual(orderWithoutTranslation);
    });
  });
});
