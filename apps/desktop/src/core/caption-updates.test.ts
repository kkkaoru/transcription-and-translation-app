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
});
