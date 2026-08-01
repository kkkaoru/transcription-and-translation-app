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

  it("drops a late same-id source-stage result after translation already landed", () => {
    // Event path may deliver translation before the invoke Promise resolves with the
    // original source-stage payload. That late result must not regress stage/sequence
    // or clear the translated text.
    const translated = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "Hello",
      startedAt: 1,
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const lateSourceInvoke = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, lateSourceInvoke)).toBeNull();
  });

  it("still accepts same-id translation after source when sequence advances", () => {
    const source = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const translated = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "Hello",
      startedAt: 1,
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(source, translated)).toEqual(translated);
  });

  it("upgrades progressive ASR text to normalized source on the same utterance id", () => {
    const rawAsr = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const normalized = caption({
      id: "u-1",
      sourceText: "今日は",
      translationText: "",
      startedAt: 1,
      receivedAt: 15,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(rawAsr, normalized)).toEqual(normalized);
  });

  it("returns the current reference when event and invoke paint the same caption", () => {
    const live = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const duplicate = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1,
      receivedAt: 12,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    // receivedAt differs but display fields match → preserve React identity.
    expect(mergeCaptionPayload(live, duplicate)).toBe(live);
  });
});
