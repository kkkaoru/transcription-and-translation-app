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

  it("continues a rolling-context source suffix across backend caption ids", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "chunk-2",
      sourceText: "晴れ",
      translationText: "",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, continuation)).toMatchObject({
      id: "chunk-2",
      sourceText: "明日の天気は晴れ",
      translationText: "",
    });
  });

  it("joins overlapping rolling-context text once without duplicating the overlap", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "chunk-2",
      sourceText: "天気は晴れ",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, continuation)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("keeps terminal punctuation when appending a rolling suffix", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "chunk-2",
      sourceText: "晴れ。",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(previous, continuation)?.sourceText).toBe("明日の天気は晴れ。");
  });

  it("uses lexical overlap even when legacy payloads omit timing metadata", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "chunk-2",
      sourceText: "明日の天気は晴れ",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, continuation)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("uses a legacy lexical prefix when the next chunk is shorter", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は晴れ",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const shorter = caption({
      id: "chunk-2",
      sourceText: "明日の天気は",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, shorter)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("uses a legacy lexical overlap when timing metadata is unavailable", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const overlap = caption({
      id: "chunk-2",
      sourceText: "天気は晴れ",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, overlap)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("accepts a same-id source when the previous payload was empty", () => {
    const current = caption({
      id: "u-1",
      sourceText: "",
      translationText: "",
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const source = caption({
      id: "u-1",
      sourceText: "音声認識結果",
      translationText: "",
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, source)?.sourceText).toBe("音声認識結果");
  });

  it("falls back safely when rolling timing metadata is non-finite", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: Number.NaN,
      receivedAt: Number.NaN,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "chunk-2",
      sourceText: "別の文です",
      startedAt: 2_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, next)?.sourceText).toBe("別の文です");
  });

  it("falls back to receipt ordering when same-id timestamps are non-finite", () => {
    const current = caption({
      id: "u-1",
      sourceText: "雨",
      startedAt: Number.NaN,
      receivedAt: Number.NaN,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const correction = caption({
      id: "u-1",
      sourceText: "晴れ",
      startedAt: Number.NaN,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, correction)?.sourceText).toBe("晴れ");
  });

  it("does not regress to a shorter cross-id source revision", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気は晴れ",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const shorter = caption({
      id: "chunk-2",
      sourceText: "明日の天気は",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, shorter)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("starts a new punctuated source instead of appending it to the prior utterance", () => {
    const previous = caption({
      id: "chunk-1",
      sourceText: "明日の天気です。",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const next = caption({
      id: "chunk-2",
      sourceText: "今日は晴れ",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, next)?.sourceText).toBe("今日は晴れ");
  });

  it("drops a late translation for the prior rolling-context chunk", () => {
    const current = caption({
      id: "chunk-2",
      sourceText: "明日の天気は晴れ",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const staleTranslation = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      startedAt: 1_000,
      receivedAt: 1_700,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, staleTranslation)).toBeNull();
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

  it("drops an unchanged late same-id source-stage result after translation landed", () => {
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

  it("rejects a malformed sequence-0 translation instead of treating it as source", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "Hello",
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const malformed = caption({
      id: "u-1",
      sourceText: "こんばんは",
      translationText: "Good evening",
      receivedAt: 30,
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, malformed)).toBeNull();
  });

  it("replaces a same-id source with a newer recognition revision after translation", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      startedAt: 1,
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const newerRecognition = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      translationText: "",
      startedAt: 1,
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    const merged = mergeCaptionPayload(translated, newerRecognition);

    expect(merged).not.toBeNull();
    expect(merged).toMatchObject({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      // Keep the already-painted translation until its sequence-1 revision
      // arrives; source updates must not blank the translation line.
      translationText: "The weather tomorrow",
      stage: "source",
      sequence: 0,
    });
  });

  it("orders a same-id source revision by audio start before receipt time", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      startedAt: 10,
      receivedAt: 100,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const newerRecognition = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      translationText: "",
      startedAt: 20,
      // Completion can race and arrive before the older translation's event.
      receivedAt: 90,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, newerRecognition)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("keeps a newer source revision when source and translation share a timestamp", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const newerRecognition = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      translationText: "",
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, newerRecognition)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("still drops an older changed source revision after translation", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      translationText: "The weather tomorrow is sunny",
      receivedAt: 30,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const staleRecognition = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "",
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, staleRecognition)).toBeNull();
  });

  it("drops an older same-sequence source revision", () => {
    const current = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const stale = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, stale)).toBeNull();
  });

  it("does not let an old translation roll back a newer source revision", () => {
    const revisedSource = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      // Keep the currently painted translation while the revised source is
      // waiting for its own translation result.
      translationText: "The weather tomorrow",
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const oldTranslation = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      receivedAt: 40,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(revisedSource, oldTranslation);

    expect(merged).toBe(revisedSource);
  });

  it("drops an older same-id translation revision", () => {
    const current = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      translationText: "The weather tomorrow is sunny",
      startedAt: 30,
      receivedAt: 30,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const stale = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      translationText: "The weather tomorrow",
      startedAt: 20,
      receivedAt: 40,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, stale)).toBeNull();
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

  it("does not regress a same-id rolling revision to a shorter prefix", () => {
    const current = caption({
      id: "u-1",
      sourceText: "明日の天気は晴れ",
      startedAt: 1_000,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const shorter = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, shorter)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("appends a same-id suffix only when the audio start advances", () => {
    const current = caption({
      id: "u-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const suffix = caption({
      id: "u-1",
      sourceText: "晴れ",
      startedAt: 1_640,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, suffix)?.sourceText).toBe("明日の天気は晴れ");
  });

  it("keeps a long same-id utterance together when windows end mid-word", () => {
    const fragments = ["となりの", "きゃくはよく", "かきくうきゃくだ"];
    let current = caption({
      id: "utt-long",
      sourceText: fragments[0],
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    for (const [index, sourceText] of fragments.slice(1).entries()) {
      const startedAt = 1_640 + index * 640;
      const merged = mergeCaptionPayload(
        current,
        caption({
          id: "utt-long",
          sourceText,
          startedAt,
          receivedAt: startedAt,
          stage: "source",
          sequence: 0,
          isFinal: false,
        }),
      );
      expect(merged).not.toBeNull();
      current = merged ?? current;
    }

    expect(current.sourceText).toBe("となりのきゃくはよくかきくうきゃくだ");
  });

  it("keeps a short Japanese prefix when Parapper closes an interim segment", () => {
    const current = caption({
      id: "u-1",
      sourceText: "あつい",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "u-1",
      sourceText: "りょうりはおいしい",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, continuation)?.sourceText).toBe("あついりょうりはおいしい");
  });

  it("does not join a short prefix after the utterance id changes", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "あつい",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "chunk-2",
      sourceText: "りょうりはおいしい",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, continuation)?.sourceText).toBe("りょうりはおいしい");
  });

  it("does not append after a finalized short source", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "あつい",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const next = caption({
      id: "chunk-2",
      sourceText: "りょうりはおいしい",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, next)?.sourceText).toBe("りょうりはおいしい");
  });

  it("keeps same-start semantic source corrections as replacements", () => {
    const current = caption({
      id: "u-1",
      sourceText: "雨",
      startedAt: 1_000,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const correction = caption({
      id: "u-1",
      sourceText: "晴れ",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, correction)?.sourceText).toBe("晴れ");
  });

  it("upgrades provisional ASR text to normalized source when startedAt arrives earlier (pipeline start → ASR stage start)", () => {
    // Progressive paint path: provisional ASR (raw output, high receivedAt from ASR stage end)
    // is later replaced by real normalized source (low startedAt from pipeline start).
    // This tests the bug mentioned by advisor: the real normalized text must not be rejected
    // as stale because its startedAt is earlier than the provisional's startedAt.
    const provisional = caption({
      id: "u-1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1200, // ASR stage start (after some silence gate, audio processing delay)
      receivedAt: 1500, // ASR stage end (wall time when result arrived)
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true, // Client-side synthesized provisional ASR from pipeline:stage event
    });
    const normalized = caption({
      id: "u-1",
      sourceText: "こんにちは、元気ですか", // Normalizer may clean/expand text
      translationText: "",
      startedAt: 1000, // Pipeline/chunk start (earlier than ASR stage start)
      receivedAt: 1600, // Normalize stage end (wall time after ASR + normalize chain)
      stage: "source",
      sequence: 0,
      isFinal: false,
      // No provisional key: this is the real backend-sourced normalized caption
    });

    const merged = mergeCaptionPayload(provisional, normalized);

    expect(merged).not.toBeNull();
    expect(merged?.sourceText).toBe("こんにちは、元気ですか");
  });

  it("replaces a same-id provisional source caption with normalized source when no overlap exists", () => {
    const provisional = caption({
      id: "u-1",
      sourceText: "あしたは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_100,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const normalized = caption({
      id: "u-1",
      sourceText: "明日は",
      translationText: "",
      startedAt: 1_300,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(provisional, normalized)?.sourceText).toBe("明日は");
  });

  it("drops a late provisional kana revision after normalized source arrives", () => {
    const normalized = caption({
      id: "u-1",
      sourceText: "明日は",
      translationText: "",
      startedAt: 1_300,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const provisional = caption({
      id: "u-1",
      sourceText: "あしたは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(normalized, provisional)).toBeNull();
  });

  it("drops a late provisional kana context revision after canonical expansion", () => {
    const normalized = caption({
      id: "u-1",
      sourceText: "明日は晴れです",
      translationText: "",
      startedAt: 1_300,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const provisional = caption({
      id: "u-1",
      sourceText: "あしたははれです",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(normalized, provisional)).toBeNull();
  });

  it("keeps a translated canonical source when a provisional event arrives late", () => {
    const translated = caption({
      id: "u-1",
      sourceText: "明日は晴れです",
      translationText: "Tomorrow will be sunny",
      startedAt: 1_300,
      receivedAt: 1_500,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const provisional = caption({
      id: "u-1",
      sourceText: "あしたははれです",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(translated, provisional)).toBeNull();
  });

  it("coalesces same-id kana-to-surface revision and translation into one caption", () => {
    const provisional = caption({
      id: "overlay-utterance",
      sourceText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_100,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const normalized = caption({
      id: "overlay-utterance",
      sourceText: "明日は",
      startedAt: 1_300,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const translated = caption({
      id: "overlay-utterance",
      sourceText: "明日は",
      translationText: "Tomorrow",
      startedAt: 1_300,
      receivedAt: 1_400,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    const normalizedCaption = mergeCaptionPayload(provisional, normalized);
    const merged = normalizedCaption && mergeCaptionPayload(normalizedCaption, translated);

    expect(normalizedCaption?.sourceText).toBe("明日は");
    expect(merged).toMatchObject({
      id: "overlay-utterance",
      sourceText: "明日は",
      translationText: "Tomorrow",
      stage: "translation",
      sequence: 1,
    });
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
