import { describe, expect, it } from "vitest";
import { mergeCaptionPayload } from "./caption-updates";
import type { CaptionPayload } from "./types";

const base = {
  sourceLanguage: "ja",
  targetLanguage: "en",
  confidence: undefined as number | undefined,
};

const caption = (overrides: Partial<CaptionPayload>): CaptionPayload => ({
  id: "u-1",
  sourceText: "こんにちは",
  translationText: "",
  startedAt: 1,
  receivedAt: 1,
  ...base,
  ...overrides,
});

describe("mergeCaptionPayload", () => {
  it("keeps recognized source immediately and merges translation by utterance id", () => {
    const first = caption({});
    const translated = caption({
      sourceText: "こんにちは",
      translationText: "Hello",
      receivedAt: 2,
    });

    const staged = mergeCaptionPayload(first, translated);

    expect(staged).toEqual({
      ...first,
      translationText: "Hello",
      receivedAt: 2,
    });
  });

  it("shows source with empty translation for a new caption id", () => {
    const previous = caption({
      id: "preview",
      sourceText: "preview",
      translationText: "Preview",
    });
    const sourceOnly = caption({
      id: "u-live",
      sourceText: "音声認識結果",
      translationText: "",
      startedAt: 10,
      receivedAt: 10,
    });

    expect(mergeCaptionPayload(previous, sourceOnly)).toEqual(sourceOnly);
  });

  it("preserves source when a same-id translation update omits sourceText", () => {
    const first = caption({ sourceText: "こんにちは" });
    const translatedOnly = caption({
      sourceText: "",
      translationText: "Hello",
      receivedAt: 2,
    });

    expect(mergeCaptionPayload(first, translatedOnly)).toEqual({
      ...first,
      translationText: "Hello",
      receivedAt: 2,
    });
  });

  it("does not clear the live caption on silence soft-skip", () => {
    const live = caption({
      translationText: "Hello",
    });
    const silence = caption({
      id: "silence-1",
      sourceText: "",
      translationText: "",
      startedAt: 0,
      receivedAt: 0,
    });

    expect(mergeCaptionPayload(live, silence)).toBeNull();
  });

  it("drops stale translation from older chunks when a newer source exists", () => {
    const newerSource = caption({
      id: "u-2",
      sourceText: "新しい文",
      translationText: "",
      startedAt: 2,
      receivedAt: 40,
    });
    const staleTranslation = caption({
      id: "u-1",
      sourceText: "古い文",
      translationText: "Old",
      startedAt: 1,
      receivedAt: 100,
    });

    expect(mergeCaptionPayload(newerSource, staleTranslation)).toBeNull();
  });

  it("replaces source for a newer chunk and clears previous translation until ready", () => {
    const current = caption({
      id: "u-1",
      sourceText: "古い文",
      translationText: "Old",
      startedAt: 1,
      receivedAt: 10,
    });
    const nextSource = caption({
      id: "u-2",
      sourceText: "新しい文",
      translationText: "",
      startedAt: 2,
      receivedAt: 20,
    });

    expect(mergeCaptionPayload(current, nextSource)).toEqual(nextSource);
  });
});
