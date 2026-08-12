import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCaptionMergeDiagnostics,
  getCaptionMergeDiagnostics,
  mergeCaptionPayload,
  takePendingCaptionTranslation,
} from "./caption-updates";
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
  beforeEach(() => {
    clearCaptionMergeDiagnostics();
  });

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

  it("drops a finalized cross-id utterance with close timing but no lexical relation", () => {
    // Two finalized Parapper turns where the first ends with a particle (は)
    // and the second arrives within the rolling-context window. With no lexical
    // overlap/prefix and the first turn finished, the second must replace the
    // visible slot instead of appending to the completed utterance.
    const current = caption({
      id: "turn-101",
      sourceText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const next = caption({
      id: "turn-102",
      sourceText: "晴れでしょう",
      startedAt: 2_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, next)).toMatchObject({
      id: "turn-102",
      sourceText: "晴れでしょう",
      translationText: "",
    });
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

  it("does not continue a cross-id source when the next start time is non-finite", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "chunk-2",
      sourceText: "別の文です",
      startedAt: Number.NaN,
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

  it("starts a new caption when a non-final source ends with sentence punctuation", () => {
    // Unlike the finalized case above, the prior chunk is still non-final.
    // The output queue can interleave a newer turn ahead of an older turn's
    // final, so a non-final source ending with terminal punctuation must
    // still start a fresh caption rather than appending the next utterance.
    const previous = caption({
      id: "chunk-1",
      sourceText: "おはようございます。",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "chunk-2",
      sourceText: "こんにちは",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(previous, next)?.sourceText).toBe("こんにちは");
  });

  it("does not append a new source that overlaps a finalized prior caption", () => {
    const previous = caption({
      id: "turn-1",
      sourceText: "明日の天気です。",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const next = caption({
      id: "turn-2",
      sourceText: "です。今日は晴れ",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(previous, next)?.sourceText).toBe("です。今日は晴れ");
  });

  it("does not append lexical overlap after the rolling-context window", () => {
    // A delayed final/interim boundary can leave the prior source non-final
    // even though the next ID starts after a real pause. Timing must still
    // prevent a shared suffix/prefix from joining two utterances.
    const previous = caption({
      id: "turn-1",
      sourceText: "明日の天気は",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "turn-2",
      sourceText: "天気は雨です",
      startedAt: 5_000,
      receivedAt: 5_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(previous, next)?.sourceText).toBe("天気は雨です");
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
    expect(takePendingCaptionTranslation("chunk-1")).toMatchObject(staleTranslation);
  });

  it("preserves a cross-id translation-only payload without attaching it to the newer source", () => {
    const current = caption({
      id: "chunk-2",
      sourceText: "明日の天気は晴れ",
      translationText: "",
      startedAt: 1_640,
      receivedAt: 1_640,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const lateTranslation = caption({
      id: "chunk-1",
      sourceText: "",
      translationText: "The weather tomorrow",
      startedAt: 1_000,
      receivedAt: 1_700,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(current, lateTranslation);

    expect(merged).toBe(current);
    expect(getCaptionMergeDiagnostics()).toEqual({
      crossIdTranslationIdsSaved: 1,
      pendingCrossIdTranslations: 1,
    });
    expect(takePendingCaptionTranslation("chunk-1")).toMatchObject(lateTranslation);
    expect(getCaptionMergeDiagnostics().pendingCrossIdTranslations).toBe(0);
  });

  it("keeps a future source-bearing translation out of the current live slot", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const earlyTranslation = caption({
      id: "chunk-2",
      sourceText: "明日の天気は晴れ",
      translationText: "The weather tomorrow is sunny",
      startedAt: 1_640,
      receivedAt: 1_650,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, earlyTranslation)).toBe(current);
    expect(takePendingCaptionTranslation("chunk-2")).toMatchObject(earlyTranslation);
  });

  it("returns null when a pending translation ID is unknown", () => {
    expect(takePendingCaptionTranslation("missing-translation")).toBeNull();
  });

  it("stores a translation that arrives before its newer source caption", () => {
    const current = caption({
      id: "chunk-1",
      sourceText: "明日の天気は",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const earlyTranslation = caption({
      id: "chunk-2",
      sourceText: "",
      translationText: "The weather tomorrow is sunny",
      startedAt: 1_640,
      receivedAt: 1_650,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, earlyTranslation)).toBe(current);
    expect(takePendingCaptionTranslation("chunk-2")).toMatchObject(earlyTranslation);
  });

  it("evicts the oldest cross-id translation when the bounded side channel is full", () => {
    const current = caption({
      id: "current",
      sourceText: "表示中の文",
      translationText: "",
      startedAt: 10_000,
      receivedAt: 10_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    for (let index = 0; index < 65; index += 1) {
      const pending = caption({
        id: `pending-${index}`,
        sourceText: "",
        translationText: `translation-${index}`,
        startedAt: index + 1,
        receivedAt: index + 1,
        stage: "translation",
        sequence: 1,
        isFinal: true,
      });
      expect(mergeCaptionPayload(current, pending)).toBe(current);
    }

    expect(getCaptionMergeDiagnostics()).toEqual({
      crossIdTranslationIdsSaved: 65,
      pendingCrossIdTranslations: 64,
    });
    expect(takePendingCaptionTranslation("pending-0")).toBeNull();
    expect(takePendingCaptionTranslation("pending-1")).toMatchObject({
      translationText: "translation-1",
    });
  });

  it("paints the first source caption after a reset when current is the empty placeholder", () => {
    // Right after a reset, current.id === "empty" (createEmptyCaption). The
    // first real-utterance payload is cross-id (empty !== u-first), but because
    // it is source-only (no translation), the merge proceeds normally and
    // paints the new source. This pins the normal first-caption path so a
    // pipeline contract change is caught.
    const empty = caption({
      id: "empty",
      sourceText: "",
      translationText: "",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const firstSource = caption({
      id: "u-first",
      sourceText: "最初の発話",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(empty, firstSource)).toEqual(firstSource);
    expect(getCaptionMergeDiagnostics().crossIdTranslationIdsSaved).toBe(0);
  });

  it("preserves a source+translation payload in the side channel when current is the empty placeholder", () => {
    // Pipeline contract (pipeline.rs:973) prevents source+translation arriving
    // together on a new id. If that contract ever changes, this test will
    // fail and force a review: the cross-id translation guard currently
    // returns the empty caption (freezing the live slot) rather than
    // mis-attributing the old utterance's translation onto the new source.
    const empty = caption({
      id: "empty",
      sourceText: "",
      translationText: "",
      startedAt: 0,
      receivedAt: 0,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const firstWithTranslation = caption({
      id: "u-first",
      sourceText: "最初の発話",
      translationText: "First utterance",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(empty, firstWithTranslation)).toBe(empty);
    expect(takePendingCaptionTranslation("u-first")).toMatchObject({
      translationText: "First utterance",
    });
  });

  it("does not increment the saved counter when discarding an older revision of an existing pending entry", () => {
    const current = caption({
      id: "live",
      sourceText: "表示中",
      translationText: "",
      startedAt: 5_000,
      receivedAt: 5_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const newerPending = caption({
      id: "late-1",
      sourceText: "",
      translationText: "Newer translation",
      startedAt: 2_000,
      receivedAt: 5_100,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const olderPending = caption({
      id: "late-1",
      sourceText: "",
      translationText: "Older translation",
      startedAt: 1_000,
      receivedAt: 5_200,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, newerPending)).toBe(current);
    expect(getCaptionMergeDiagnostics().crossIdTranslationIdsSaved).toBe(1);
    // The older revision is discarded; the counter must not increment.
    expect(mergeCaptionPayload(current, olderPending)).toBe(current);
    expect(getCaptionMergeDiagnostics().crossIdTranslationIdsSaved).toBe(1);
    expect(takePendingCaptionTranslation("late-1")).toMatchObject({
      translationText: "Newer translation",
    });
  });

  it("does not save a cross-id translation with an empty or whitespace id", () => {
    const current = caption({
      id: "live",
      sourceText: "表示中",
      translationText: "",
      startedAt: 5_000,
      receivedAt: 5_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const emptyIdTranslation = caption({
      id: "",
      sourceText: "",
      translationText: "No id",
      startedAt: 1_000,
      receivedAt: 5_100,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const whitespaceIdTranslation = caption({
      id: "   ",
      sourceText: "",
      translationText: "Whitespace id",
      startedAt: 1_000,
      receivedAt: 5_200,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, emptyIdTranslation)).toBe(current);
    expect(mergeCaptionPayload(current, whitespaceIdTranslation)).toBe(current);
    expect(getCaptionMergeDiagnostics()).toEqual({
      crossIdTranslationIdsSaved: 0,
      pendingCrossIdTranslations: 0,
    });
    expect(takePendingCaptionTranslation("")).toBeNull();
    expect(takePendingCaptionTranslation("   ")).toBeNull();
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

  it("accepts a same-id final source even when audio duration backdates its start", () => {
    // Parapper interim outputs have no audio duration and therefore use their
    // receive time as startedAt.  A final output backdates startedAt by the
    // measured turn duration; completion must win over that timestamp ordering.
    const interim = caption({
      id: "parapper:session:1:1",
      sourceText: "あしたは",
      startedAt: 2_000,
      receivedAt: 2_010,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const final = caption({
      id: "parapper:session:1:1",
      sourceText: "明日は晴れです",
      startedAt: 1_360,
      receivedAt: 2_020,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(interim, final)).toMatchObject({
      sourceText: "明日は晴れです",
      isFinal: true,
    });
  });

  it("does not let a delayed same-id interim overwrite a final source", () => {
    const final = caption({
      id: "parapper:session:1:1",
      sourceText: "明日は晴れです",
      startedAt: 1_360,
      receivedAt: 2_020,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const delayedInterim = caption({
      id: "parapper:session:1:1",
      sourceText: "あしたは",
      startedAt: 2_000,
      receivedAt: 2_030,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(final, delayedInterim)).toBeNull();
  });

  it("uses receivedAt to reject an older cross-id caption when startedAt is zero", () => {
    const current = caption({
      id: "u-current",
      sourceText: "新しい文",
      startedAt: 0,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const stale = caption({
      id: "u-stale",
      sourceText: "古い文",
      startedAt: 0,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, stale)).toBeNull();
  });

  it("still merges a same-id translation-only payload after a final source", () => {
    const current = caption({
      id: "u-final",
      sourceText: "表示中の原文",
      startedAt: 10,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const translationOnly = caption({
      id: "u-final",
      sourceText: "",
      translationText: "Visible source",
      startedAt: 10,
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, translationOnly)).toEqual({
      ...current,
      translationText: "Visible source",
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
    });
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

  it("replaces kana surface when the incoming AzooKey reading is unchanged", () => {
    const current = caption({
      id: "u-reading",
      sourceText: "あしたは",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const normalized = caption({
      id: "u-reading",
      sourceText: "明日は",
      azookeyInputText: "あしたは",
      startedAt: 1_300,
      receivedAt: 1_300,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, normalized)?.sourceText).toBe("明日は");
  });

  it("normalizes katakana and prolonged-mark variants before comparing readings", () => {
    const current = caption({
      id: "u-reading-normalized",
      sourceText: "すーぱー",
      azookeyInputText: "スーパー",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const normalized = caption({
      id: "u-reading-normalized",
      sourceText: "スーパー",
      azookeyInputText: "すーぱー",
      startedAt: 1_300,
      receivedAt: 1_300,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, normalized)?.sourceText).toBe("スーパー");
  });

  it("replaces the current surface when the incoming AzooKey reading extends it", () => {
    const current = caption({
      id: "u-reading-extension",
      sourceText: "あしたは",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const normalized = caption({
      id: "u-reading-extension",
      sourceText: "明日は晴れ",
      azookeyInputText: "あしたははれ",
      startedAt: 1_300,
      receivedAt: 1_300,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, normalized)?.sourceText).toBe("明日は晴れ");
  });

  it("keeps rolling append behavior when AzooKey readings are unavailable", () => {
    const current = caption({
      id: "u-reading-rolling",
      sourceText: "あつい",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const continuation = caption({
      id: "u-reading-rolling",
      sourceText: "りょうりはおいしい",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, continuation)?.sourceText).toBe("あついりょうりはおいしい");
  });

  it("keeps adjacent turns joined when their readings look like a rolling extension", () => {
    const current = caption({
      id: "turn-1",
      sourceText: "あしたは",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const nextTurn = caption({
      id: "turn-2",
      sourceText: "晴れ",
      azookeyInputText: "あしたははれ",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, nextTurn)?.sourceText).toBe("あしたは晴れ");
  });

  it("replaces a cross-id kana surface when AzooKey keeps the exact reading", () => {
    const current = caption({
      id: "turn-kana",
      sourceText: "あしたは",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const normalized = caption({
      id: "turn-surface",
      sourceText: "明日は",
      azookeyInputText: "あしたは",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, normalized)?.sourceText).toBe("明日は");
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

  it("does not append a new turn onto a non-final particle ending just because timing is close", () => {
    // The output queue can deliver turn N+1's interim while turn N's final is
    // still waiting behind an in-flight normalizer. Close timing alone must not
    // concatenate unrelated turns when the visible caption still ends in a
    // particle (は/が/…) and there is no lexical or AzooKey reading relation.
    const turnOnePartial = caption({
      id: "parapper:socket:4:1",
      sourceText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_010,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const turnTwoPartial = caption({
      id: "parapper:socket:4:2",
      sourceText: "きょうは雨",
      startedAt: 1_800,
      receivedAt: 1_810,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(turnOnePartial, turnTwoPartial)).toMatchObject({
      id: "parapper:socket:4:2",
      sourceText: "きょうは雨",
    });
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

  it("keeps pause-separated Parapper turns as separate captions", () => {
    // The two turns share only the internal 「てんきは」 substring. They are
    // not a prefix/suffix continuation and the pause exceeds the rolling
    // context window, so the second turn must replace the visible slot rather
    // than concatenate both sentences.
    const current = caption({
      id: "turn-101",
      sourceText: "あしたのてんきははれ",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const next = caption({
      id: "turn-102",
      sourceText: "あさってのてんきはあめです",
      startedAt: 5_500,
      receivedAt: 5_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, next)).toMatchObject({
      id: "turn-102",
      sourceText: "あさってのてんきはあめです",
      translationText: "",
    });
  });
  it("keeps two different Parapper turns separate even when a reading extends the prior turn", () => {
    // Two distinct Parapper turns: the first reads 「あしたは」 and is still
    // non-final, the second reads 「はれ」 whose AzooKey reading strictly
    // extends the first turn's reading. Reading-prefix matching plus close
    // timing must not concatenate two different utterances; because the ids
    // are different Parapper turns, the second must replace the visible slot
    // instead of merging into the unfinished first turn.
    const current = caption({
      id: "parapper:0:0:1",
      sourceText: "あしたは",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const nextTurn = caption({
      id: "parapper:0:0:2",
      sourceText: "はれ",
      azookeyInputText: "あしたははれ",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    // The two turns must stay separate: the second turn's text replaces the
    // first turn's slot rather than being appended to it.
    expect(mergeCaptionPayload(current, nextTurn)?.sourceText).toBe("はれ");
  });

  it("keeps independent Parapper turns separate when the second reading has the first as a prefix", () => {
    const current = caption({
      id: "parapper:0:0:10",
      sourceText: "明日",
      azookeyInputText: "あした",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const nextTurn = caption({
      id: "parapper:0:0:11",
      sourceText: "明日の予定",
      azookeyInputText: "あしたのよてい",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, nextTurn)?.sourceText).toBe("明日の予定");
  });

  it("keeps independent Parapper turns separate when readings are blank or whitespace", () => {
    const current = caption({
      id: "parapper:0:0:20",
      sourceText: "明日は",
      azookeyInputText: " ",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const nextTurn = caption({
      id: "parapper:0:0:21",
      sourceText: "今日は雨",
      azookeyInputText: "",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, nextTurn)?.sourceText).toBe("今日は雨");
  });

  it("keeps independent Parapper turns separate when they have the same short reading", () => {
    const current = caption({
      id: "parapper:0:0:30",
      sourceText: "橋",
      azookeyInputText: "はし",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const nextTurn = caption({
      id: "parapper:0:0:31",
      sourceText: "箸",
      azookeyInputText: "はし",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, nextTurn)?.sourceText).toBe("箸");
  });

  it("still replaces an extended reading within one Parapper turn", () => {
    const current = caption({
      id: "parapper:0:0:40",
      sourceText: "明日は",
      azookeyInputText: "あしたは",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const revision = caption({
      id: "parapper:0:0:40",
      sourceText: "明日は晴れ",
      azookeyInputText: "あしたははれ",
      startedAt: 1_500,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, revision)?.sourceText).toBe("明日は晴れ");
  });

  it("keeps a longer same-id interim when a truncated final would cut the converted tail", () => {
    const current = caption({
      id: "u-1",
      sourceText: "今日は良い天気ですね明日も",
      azookeyInputText: "きょうはいいてんきですねあしたも",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const truncated = caption({
      id: "u-1",
      sourceText: "今日は良い天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      startedAt: 1_050,
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, truncated)?.sourceText).toBe("今日は良い天気ですね明日も");
  });

  it("keeps the longer AzooKey reading when a truncated final loses to the painted surface", () => {
    // Completion ASR can finalize on a prefix while a longer provisional already
    // painted the utterance tail. Source text stays long; the shorter final must
    // not overwrite azookeyInputText or later reading-prefix gates desync.
    const painted = caption({
      id: "parapper:session:turn:reading-keep",
      sourceText: "今日は良い天気ですね明日も",
      azookeyInputText: "きょうはいいてんきですねあしたも",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const truncatedFinal = caption({
      id: "parapper:session:turn:reading-keep",
      sourceText: "今日は良い天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      startedAt: 900,
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(painted, truncatedFinal)).toMatchObject({
      sourceText: "今日は良い天気ですね明日も",
      azookeyInputText: "きょうはいいてんきですねあしたも",
      isFinal: true,
    });
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

  it("keeps a longer mid-utterance provisional when a stale shorter normalize completes later", () => {
    // Parapper paints provisional ASAP, then queues normalize. An older
    // in-flight normalize must not erase characters painted from a later
    // provisional revision of the same utterance.
    const provisional = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const staleNormalized = caption({
      id: "u-1",
      sourceText: "今日は",
      azookeyInputText: "きょうは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(provisional, staleNormalized)).toBeNull();
  });

  it("keeps mid-utterance provisional without readings when a shorter prefix normalize arrives stale", () => {
    const provisional = caption({
      id: "u-1",
      sourceText: "隣の客はよく柿を食べる",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const staleNormalized = caption({
      id: "u-1",
      sourceText: "隣の客は",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(provisional, staleNormalized)).toBeNull();
  });

  it("still upgrades provisional when normalize extends or rewrites mid-utterance text", () => {
    const provisional = caption({
      id: "u-1",
      sourceText: "きょうはいいてんき",
      azookeyInputText: "きょうはいいてんき",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const normalized = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(provisional, normalized)?.sourceText).toBe("今日はいい天気ですね");
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

  it("accepts a longer same-id provisional after normalize so the utterance tail can paint", () => {
    // First normalize paints the beginning; later Parapper partials still grow
    // before the next normalize. Those extensions must not be treated as late
    // kana rewrites or the end of the utterance never appears.
    const normalized = caption({
      id: "u-1",
      sourceText: "今日はいい",
      azookeyInputText: "きょうはいい",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const provisionalTail = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(normalized, provisionalTail)).toMatchObject({
      sourceText: "今日はいい天気ですね",
      provisional: true,
    });
  });

  it("accepts a longer provisional surface extension without readings after normalize", () => {
    const normalized = caption({
      id: "u-1",
      sourceText: "隣の客はよく",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const provisionalTail = caption({
      id: "u-1",
      sourceText: "隣の客はよく柿を食べる",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(normalized, provisionalTail)?.sourceText).toBe(
      "隣の客はよく柿を食べる",
    );
  });

  it("accepts a backdated longer same-id final after an early short final", () => {
    // Completion ASR backdates startedAt by the full audio duration. An early
    // short final (こんにちは) therefore looks newer than the later longer
    // completion (こんにちはきこえますか). Dropping that longer final froze
    // the prefix until hold-clear blanked the plate.
    const interim = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const shortFinal = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longerFinal = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんにちはきこえますか",
      translationText: "",
      startedAt: 800,
      receivedAt: 3_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    const afterShort = mergeCaptionPayload(interim, shortFinal);
    expect(afterShort).toMatchObject({
      sourceText: "こんにちは",
      isFinal: true,
    });
    expect(afterShort).not.toBeNull();
    if (afterShort == null) {
      return;
    }
    expect(mergeCaptionPayload(afterShort, longerFinal)).toMatchObject({
      sourceText: "こんにちはきこえますか",
      isFinal: true,
    });
  });

  it("accepts a longer rewritten same-id continuation after an early mid-stream final", () => {
    // Long utterances often finalize a mid-stream hypothesis (extra だ, missing
    // tail). The later revision is not a clean prefix of that frozen surface, so
    // a strict startsWith guard would keep 「…僕は学校」 forever.
    const midStreamFinal = caption({
      id: "parapper:session:turn:delay",
      sourceText: "電車が遅延してただから僕は学校",
      azookeyInputText: "でんしゃがちえんしてただからぼくはがっこう",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longerContinuation = caption({
      id: "parapper:session:turn:delay",
      sourceText: "電車が遅延してたから僕は学校に行かない",
      azookeyInputText: "でんしゃがちえんしてただからぼくはがっこうにいかない",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 5_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(midStreamFinal, longerContinuation)).toMatchObject({
      sourceText: "電車が遅延してたから僕は学校に行かない",
      isFinal: false,
      provisional: true,
    });
  });

  it("accepts a longer rewritten same-id continuation after final without readings", () => {
    const midStreamFinal = caption({
      id: "parapper:session:turn:delay-noreading",
      sourceText: "電車が遅延してただから僕は学校",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longerContinuation = caption({
      id: "parapper:session:turn:delay-noreading",
      sourceText: "電車が遅延してたから僕は学校に行かない",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 5_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(midStreamFinal, longerContinuation)).toMatchObject({
      sourceText: "電車が遅延してたから僕は学校に行かない",
    });
  });

  it("rejects a majority-head same-id rewrite after final when readings are absent", () => {
    // Shared head 「明日の天気は」 is a majority of the painted final, but the
    // remainder is a different question, not a tail continuation.
    const finalized = caption({
      id: "parapper:session:turn:wx",
      sourceText: "明日の天気は晴れです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const rewrittenQuestion = caption({
      id: "parapper:session:turn:wx",
      sourceText: "明日の天気はどうなりますか",
      translationText: "",
      startedAt: 2_200,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, rewrittenQuestion)).toBeNull();
  });

  it("rejects a majority-head rewrite after final when only one side has a reading", () => {
    const finalized = caption({
      id: "parapper:session:turn:wx-one-reading",
      sourceText: "明日の天気は晴れです",
      azookeyInputText: "あしたのてんきははれです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const rewrittenQuestion = caption({
      id: "parapper:session:turn:wx-one-reading",
      sourceText: "明日の天気はどうなりますか",
      translationText: "",
      startedAt: 2_200,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, rewrittenQuestion)).toBeNull();
  });

  it("still drops a majority-head rewrite after final when readings diverge", () => {
    const finalized = caption({
      id: "parapper:session:turn:wx-readings",
      sourceText: "明日の天気は晴れです",
      azookeyInputText: "あしたのてんきははれです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const rewrittenQuestion = caption({
      id: "parapper:session:turn:wx-readings",
      sourceText: "明日の天気はどうなりますか",
      azookeyInputText: "あしたのてんきはどうなりますか",
      translationText: "",
      startedAt: 2_200,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, rewrittenQuestion)).toBeNull();
  });

  it("accepts a strict prefix continuation after final without readings", () => {
    const earlyFinal = caption({
      id: "parapper:session:turn:hot",
      sourceText: "暑い日は",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longer = caption({
      id: "parapper:session:turn:hot",
      sourceText: "暑い日はあった",
      translationText: "",
      startedAt: 1_100,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(earlyFinal, longer)).toMatchObject({
      sourceText: "暑い日はあった",
      isFinal: false,
    });
  });

  it("accepts a short conversion rewrite plus tail after final without readings", () => {
    const earlyFinal = caption({
      id: "parapper:session:turn:hare",
      sourceText: "明日ははれ",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const converted = caption({
      id: "parapper:session:turn:hare",
      sourceText: "明日は晴れです",
      translationText: "",
      startedAt: 1_100,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(earlyFinal, converted)).toMatchObject({
      sourceText: "明日は晴れです",
    });
  });

  it("accepts a continuation after final when the rewrite consumes the painted remainder", () => {
    const earlyFinal = caption({
      id: "parapper:session:turn:da-tail",
      sourceText: "今日はだ",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const continued = caption({
      id: "parapper:session:turn:da-tail",
      sourceText: "今日はですね",
      translationText: "",
      startedAt: 1_100,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(earlyFinal, continued)).toMatchObject({
      sourceText: "今日はですね",
    });
  });

  it("accepts a longer converted surface after final when the reading is already complete", () => {
    const fullReading = "でんしゃがちえんしてただからぼくはがっこうにいかない";
    const midStreamFinal = caption({
      id: "parapper:session:turn:delay-full-reading",
      sourceText: "電車が遅延してただから僕は学校",
      azookeyInputText: fullReading,
      translationText: "",
      startedAt: 1_000,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longerConversion = caption({
      id: "parapper:session:turn:delay-full-reading",
      sourceText: "電車が遅延してたから僕は学校に行かない",
      azookeyInputText: fullReading,
      translationText: "",
      startedAt: 1_000,
      receivedAt: 5_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(midStreamFinal, longerConversion)).toMatchObject({
      sourceText: "電車が遅延してたから僕は学校に行かない",
    });
  });

  it("accepts a backdated longer rewritten final after an early mid-stream final", () => {
    // 052c80c already lets a later same-id final merge despite backdated
    // startedAt. The surface rewrite (してただ → してた) must still replace the
    // frozen mid-stream hypothesis so the tail can paint.
    const midStreamFinal = caption({
      id: "parapper:session:turn:delay-final",
      sourceText: "電車が遅延してただから僕は学校",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const longerFinal = caption({
      id: "parapper:session:turn:delay-final",
      sourceText: "電車が遅延してたから僕は学校に行かない",
      translationText: "",
      startedAt: 800,
      receivedAt: 5_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(midStreamFinal, longerFinal)).toMatchObject({
      sourceText: "電車が遅延してたから僕は学校に行かない",
      isFinal: true,
    });
  });

  it("rejects a backdated diverging same-id final after a newer final", () => {
    const current = caption({
      id: "parapper:session:turn:b-weather",
      sourceText: "明日の天気は晴れです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const olderUnrelated = caption({
      id: "parapper:session:turn:b-weather",
      sourceText: "昨日は雨でしたね",
      translationText: "",
      startedAt: 500,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, olderUnrelated)).toBeNull();
  });

  it("rejects a backdated greeting final that does not continue the painted final", () => {
    const current = caption({
      id: "parapper:session:turn:b-hear",
      sourceText: "聞こえますか",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const olderGreeting = caption({
      id: "parapper:session:turn:b-hear",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 500,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, olderGreeting)).toBeNull();
  });

  it("rejects an earlier-received diverging final when startedAt matches", () => {
    const current = caption({
      id: "parapper:session:turn:b-receipt",
      sourceText: "明日の天気は晴れです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const earlierReceipt = caption({
      id: "parapper:session:turn:b-receipt",
      sourceText: "昨日は雨でしたね",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, earlierReceipt)).toBeNull();
  });

  it("still accepts a newer diverging same-id final as a correction", () => {
    const current = caption({
      id: "parapper:session:turn:b-correct",
      sourceText: "今日は雨です",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const newerCorrection = caption({
      id: "parapper:session:turn:b-correct",
      sourceText: "今日は晴れです",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_400,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, newerCorrection)).toMatchObject({
      sourceText: "今日は晴れです",
      isFinal: true,
    });
  });

  it("keeps a longer finalized surface when a backdated truncated final arrives", () => {
    const current = caption({
      id: "parapper:session:turn:b-trunc",
      sourceText: "こんにちはきこえますか",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const truncated = caption({
      id: "parapper:session:turn:b-trunc",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 800,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, truncated)?.sourceText).toBe("こんにちはきこえますか");
  });

  it("returns the current final when a backdated duplicate final paints the same text", () => {
    const current = caption({
      id: "parapper:session:turn:b-dup",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const duplicate = caption({
      id: "parapper:session:turn:b-dup",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 800,
      receivedAt: 3_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, duplicate)).toBe(current);
  });

  it("drops a whitespace-only backdated final that would otherwise skip ordering", () => {
    const current = caption({
      id: "parapper:session:turn:b-blank",
      sourceText: "明日の天気は晴れです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const blankFinal = caption({
      id: "parapper:session:turn:b-blank",
      sourceText: "   ",
      translationText: "Sunny tomorrow",
      startedAt: 500,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(current, blankFinal)).toBeNull();
  });

  it("accepts a same-id continuation after final so newer characters still paint", () => {
    const finalized = caption({
      id: "u-1",
      sourceText: "今日はいい",
      azookeyInputText: "きょうはいい",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const provisionalTail = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, provisionalTail)).toMatchObject({
      sourceText: "今日はいい天気ですね",
      isFinal: false,
      provisional: true,
    });
  });

  it("accepts a newer Parapper turn even when its startedAt is earlier than a backdated final", () => {
    const finalized = caption({
      id: "parapper:session:turn:1",
      sourceText: "昨日の話は終わりました",
      translationText: "",
      // Finals are backdated by measured audio duration.
      startedAt: 5_000,
      receivedAt: 8_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const nextTurn = caption({
      id: "parapper:session:turn:2",
      sourceText: "今日は雨です",
      translationText: "",
      startedAt: 4_500,
      receivedAt: 8_500,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, nextTurn)).toMatchObject({
      id: "parapper:session:turn:2",
      sourceText: "今日は雨です",
    });
  });

  it("accepts a later Parapper turn after a finalized greeting instead of dropping it", () => {
    const greeting = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんばんは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const nextTurn = caption({
      id: "parapper:session:turn:2",
      sourceText: "こんにちはーきこえますかー",
      translationText: "",
      startedAt: 2_200,
      receivedAt: 2_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(greeting, nextTurn)).toMatchObject({
      id: "parapper:session:turn:2",
      sourceText: expect.stringContaining("きこえますか"),
    });
  });

  it("appends a close Parapper continuation after an early-finalized greeting", () => {
    const greeting = caption({
      id: "parapper:session:turn:hello",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const continuation = caption({
      id: "parapper:session:turn:hello-cont",
      sourceText: "きこえますか",
      translationText: "",
      startedAt: 1_450,
      receivedAt: 1_700,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(greeting, continuation)).toMatchObject({
      id: "parapper:session:turn:hello-cont",
      sourceText: "こんにちはきこえますか",
    });
  });

  it("keeps a painted greeting when ASR substitutes a short ack", () => {
    const greeting = caption({
      id: "parapper:session:turn:hello2",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const ack = caption({
      id: "parapper:session:turn:hello2",
      sourceText: "はい",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(greeting, ack)).toBeNull();
  });

  it("keeps a greeting plate when a later turn is only a short ack", () => {
    const greeting = caption({
      id: "parapper:session:turn:hello3",
      sourceText: "こんにちは",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const ack = caption({
      id: "parapper:session:turn:ack",
      sourceText: "はい",
      translationText: "",
      startedAt: 1_300,
      receivedAt: 1_500,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(greeting, ack)).toBeNull();
  });

  it("drops a same-id rewrite after final so late raw ASR cannot replace the conversion", () => {
    const finalized = caption({
      id: "parapper:session:turn:9",
      sourceText: "昨日の話は終わりました",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const nextSpeech = caption({
      id: "parapper:session:turn:9",
      sourceText: "今日は雨です",
      translationText: "",
      startedAt: 1_500,
      receivedAt: 1_600,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, nextSpeech)).toBeNull();
  });

  it("drops a whitespace-only non-final after a finalized source", () => {
    const finalized = caption({
      id: "parapper:session:turn:blank-interim",
      sourceText: "明日の天気は晴れです",
      translationText: "",
      startedAt: 2_000,
      receivedAt: 3_000,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const blankInterim = caption({
      id: "parapper:session:turn:blank-interim",
      sourceText: "   ",
      translationText: "Sunny tomorrow",
      startedAt: 2_200,
      receivedAt: 4_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, blankInterim)).toBeNull();
  });

  it("drops a shorter same-reading provisional after final", () => {
    const fullReading = "きょうはいいてんきですね";
    const finalized = caption({
      id: "parapper:session:turn:shorter-reading",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: fullReading,
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const shorter = caption({
      id: "parapper:session:turn:shorter-reading",
      sourceText: "今日はいい",
      azookeyInputText: fullReading,
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, shorter)).toBeNull();
  });

  it("still drops a non-extending late provisional after a finalized same-id caption", () => {
    const finalized = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });
    const provisionalRewrite = caption({
      id: "u-1",
      sourceText: "きょうはいいてんきですね",
      azookeyInputText: "きょうはいいてんきですね",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });

    expect(mergeCaptionPayload(finalized, provisionalRewrite)).toBeNull();
  });

  it("keeps a longer painted surface when a truncated final would worsen conversion quality", () => {
    const provisional = caption({
      id: "u-1",
      sourceText: "今日はいい天気ですね",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_100,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const truncatedFinal = caption({
      id: "u-1",
      sourceText: "今日はいい天気",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(provisional, truncatedFinal);
    expect(merged).toMatchObject({
      sourceText: "今日はいい天気ですね",
      isFinal: true,
    });
    expect(merged?.provisional).toBeUndefined();
  });

  it("keeps a longer painted tail when a truncated rewritten final is not a clean prefix", () => {
    // Completion ASR often finalizes a mid-span rewrite (してただ → してた)
    // without the still-spoken tail. That is not a startsWith truncation, so
    // preferring the final would freeze the plate before 「に行かない」.
    const painted = caption({
      id: "parapper:session:turn:delay-tail",
      sourceText: "電車が遅延してただから僕は学校に行かない",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 5_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const truncatedRewriteFinal = caption({
      id: "parapper:session:turn:delay-tail",
      sourceText: "電車が遅延してたから僕は学校",
      sentenceEndOffsets: [14],
      translationText: "",
      startedAt: 1_000,
      receivedAt: 5_400,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(painted, truncatedRewriteFinal);
    expect(merged).toMatchObject({
      sourceText: "電車が遅延してたから僕は学校に行かない",
      isFinal: true,
    });
    expect(merged?.sourceText).toContain("に行かない");
    expect(merged?.sentenceEndOffsets).toBeUndefined();
    expect(merged?.provisional).toBeUndefined();
  });

  it("keeps a longer painted rewrite when a truncated final only converts the remainder", () => {
    const painted = caption({
      id: "parapper:session:turn:da-rewrite",
      sourceText: "今日はですね",
      translationText: "",
      startedAt: 1_100,
      receivedAt: 2_400,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const truncatedFinal = caption({
      id: "parapper:session:turn:da-rewrite",
      sourceText: "今日はだ",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 2_600,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(painted, truncatedFinal)).toMatchObject({
      sourceText: "今日はですね",
      isFinal: true,
    });
  });

  it("drops truncated-final morph offsets when keeping a longer provisional surface", () => {
    const provisional = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんにちはきこえますか",
      azookeyInputText: "こんにちはきこえますか",
      sentenceEndOffsets: [11],
      startedAt: 1_000,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const truncatedFinal = caption({
      id: "parapper:session:turn:1",
      sourceText: "こんにちは",
      azookeyInputText: "こんにちは",
      sentenceEndOffsets: [5],
      startedAt: 900,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(provisional, truncatedFinal);
    expect(merged?.sourceText).toBe("こんにちはきこえますか");
    expect(merged?.azookeyInputText).toBe("こんにちはきこえますか");
    expect(merged?.sentenceEndOffsets).toEqual([11]);
  });

  it("still accepts a finalized conversion that is longer or rewritten", () => {
    const interim = caption({
      id: "u-1",
      sourceText: "きょうは",
      translationText: "",
      startedAt: 1_050,
      receivedAt: 1_100,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
    });
    const finalized = caption({
      id: "u-1",
      sourceText: "今日は晴れです",
      translationText: "",
      startedAt: 1_000,
      receivedAt: 1_200,
      stage: "source",
      sequence: 0,
      isFinal: true,
    });

    expect(mergeCaptionPayload(interim, finalized)).toMatchObject({
      sourceText: "今日は晴れです",
      isFinal: true,
    });
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

  it("treats the very first payload after reset as a cross-id translation when it has translation", () => {
    // Right after reset, current.id === "empty", so the first real payload is always cross-id.
    // If that payload is a translation (e.g., late completion for a prior utterance), it must
    // be preserved in the side channel and not attached to the empty slot.
    const empty = caption({ id: "empty", sourceText: "", translationText: "" });
    const lateTranslation = caption({
      id: "u-1",
      sourceText: "",
      translationText: "Late completion from prior session",
      startedAt: 100,
      receivedAt: 200,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    const merged = mergeCaptionPayload(empty, lateTranslation);

    // Must return empty (unchanged) and preserve the translation in pending.
    expect(merged).toBe(empty);
    expect(getCaptionMergeDiagnostics()).toEqual({
      crossIdTranslationIdsSaved: 1,
      pendingCrossIdTranslations: 1,
    });
    expect(takePendingCaptionTranslation("u-1")).toMatchObject(lateTranslation);
  });

  it("accepts a new source caption immediately after reset", () => {
    const empty = caption({ id: "empty", sourceText: "", translationText: "" });
    const newSource = caption({
      id: "u-1",
      sourceText: "最初の認識結果",
      translationText: "",
      startedAt: 100,
      receivedAt: 200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    const merged = mergeCaptionPayload(empty, newSource);

    expect(merged).toEqual(newSource);
  });

  it("enforces session-boundary contract: clearCaptionMergeDiagnostics must reset pending translations", () => {
    // This test documents the session-boundary contract: at capture start, pending
    // cross-id translations must be cleared to prevent mis-attribution when utterance
    // IDs collide across sessions. startCapture() is responsible for calling
    // clearCaptionMergeDiagnostics(); this test validates what that call must accomplish.
    //
    // IMPORTANT: This is NOT a regression test for the startCapture() call site. A
    // true regression test would render MainApp and call startCapture() end-to-end, then
    // assert the pending map is empty afterward. That would require new mocking for
    // MicrophoneCapture, the bridge, and the parapper stream. This test only verifies
    // that the clearCaptionMergeDiagnostics() function does its job. If startCapture()
    // is modified to delete its clearCaptionMergeDiagnostics() call, this test will
    // still pass because it calls the function directly. To catch that regression, an
    // integration test in MainApp.raw.smoke.test.tsx or similar would be required.

    // Simulate session 1: a source caption with id "u-1" is displayed, then a
    // translation arrives after a newer caption replaced it. The translation
    // is stored as pending and marked for retrieval when u-1 source appears again.
    const session1Current = caption({
      id: "u-2",
      sourceText: "次の認識結果",
      translationText: "",
      startedAt: 200,
      receivedAt: 200,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const session1LateTranslation = caption({
      id: "u-1",
      sourceText: "",
      translationText: "First utterance translation",
      startedAt: 100,
      receivedAt: 250,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    // Store the pending translation: u-1 source has moved on, so u-1 translation
    // is held for future u-1 source lookup.
    mergeCaptionPayload(session1Current, session1LateTranslation);
    expect(getCaptionMergeDiagnostics().pendingCrossIdTranslations).toBe(1);
    expect(takePendingCaptionTranslation("u-1")).toMatchObject(session1LateTranslation);

    // The contract: clearCaptionMergeDiagnostics() must clear the pending map.
    clearCaptionMergeDiagnostics();
    expect(getCaptionMergeDiagnostics().pendingCrossIdTranslations).toBe(0);

    // After the clear: a new source caption with the same id "u-1" arrives
    // (utterance IDs can collide across sessions). The pending translation from
    // session 1 is not retrieved.
    const session2Source = caption({
      id: "u-1",
      sourceText: "新しいセッションの音声",
      translationText: "",
      startedAt: 1000,
      receivedAt: 1000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(takePendingCaptionTranslation("u-1")).toBeNull();

    // The new source caption is displayed without stale translation.
    const empty = caption({ id: "empty", sourceText: "", translationText: "" });
    const merged = mergeCaptionPayload(empty, session2Source);
    expect(merged).toEqual(session2Source);
    expect(merged?.translationText).toBe("");
  });

  it("collapses runaway single-Kanji stutter at three or more 為", () => {
    let current = caption({
      id: "stutter",
      sourceText: "為",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const steps: Array<{ next: string; expected: string }> = [
      { next: "為為", expected: "為為" },
      { next: "為為為", expected: "為為" },
      { next: "為為為為", expected: "為為" },
      { next: "為為為為為", expected: "為為" },
    ];
    for (const step of steps) {
      const merged = mergeCaptionPayload(
        current,
        caption({
          id: "stutter",
          sourceText: step.next,
          startedAt: 1_000,
          receivedAt: current.receivedAt + 10,
          stage: "source",
          sequence: 0,
          isFinal: false,
        }),
      );
      expect(merged).not.toBeNull();
      expect(merged?.sourceText).toBe(step.expected);
      current = merged as typeof current;
    }
  });

  it("does not append another identical Kanji onto an existing stutter tail", () => {
    const current = caption({
      id: "stutter-append",
      sourceText: "今日は為為",
      startedAt: 1_000,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "stutter-append",
      sourceText: "為",
      startedAt: 1_050,
      receivedAt: 1_060,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    expect(mergeCaptionPayload(current, next)?.sourceText).toBe("今日は為為");
  });

  it("keeps a Parapper same-id longer surface when a shorter prefix revision arrives", () => {
    const current = caption({
      id: "parapper:session:turn:1",
      sourceText: "今日は良い天気ですね",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const shorter = caption({
      id: "parapper:session:turn:1",
      sourceText: "今日は",
      startedAt: 1_400,
      receivedAt: 40,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, shorter)?.sourceText).toBe("今日は良い天気ですね");
  });

  it("does not concatenate unrelated Parapper same-id hypotheses", () => {
    const current = caption({
      id: "parapper:session:turn:2",
      sourceText: "昨日の話は終わりました",
      startedAt: 1_000,
      receivedAt: 10,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });
    const next = caption({
      id: "parapper:session:turn:2",
      sourceText: "今日は雨です",
      startedAt: 1_500,
      receivedAt: 30,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(current, next)?.sourceText).toBe("今日は雨です");
  });

  it("clears a stale translation when the same-id source rewrites", () => {
    const translated = caption({
      id: "u-rewrite",
      sourceText: "明日の天気は晴れ",
      translationText: "The weather tomorrow is sunny",
      startedAt: 1_000,
      receivedAt: 20,
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });
    const rewritten = caption({
      id: "u-rewrite",
      sourceText: "今日は雨です",
      translationText: "",
      startedAt: 1_200,
      receivedAt: 40,
      stage: "source",
      sequence: 0,
      isFinal: false,
    });

    expect(mergeCaptionPayload(translated, rewritten)).toMatchObject({
      sourceText: "今日は雨です",
      translationText: "",
    });
  });
});
