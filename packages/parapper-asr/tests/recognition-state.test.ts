import { describe, expect, it } from "vitest";

import { advanceRecognitionGeneration } from "../src/hooks/use-app-state";
import {
  recognitionTextEventKey,
  recognitionTurnKey,
  trimRecognitionLogRows,
  translationTextEventKey,
  upsertRecognizedText,
  upsertTranslatedText,
  withEventGeneration,
} from "../src/lib/recognition-state";
import {
  recognitionSourceRowId,
  recognitionTextRowId,
  translationTextRowId,
} from "../src/lib/recognition-source";
import type {
  AsrModel,
  RecognizedTextEvent,
  TranslationTextEvent,
} from "../src/lib/types";

const source = (turn = 1, revision = 0, outputSequence = 1) => ({
  turn_session_id: 7,
  turn_id: turn,
  turn_revision: revision,
  output_sequence: outputSequence,
  segment_id: turn,
  previous_segment_id: null,
});

const recognized = (
  id: string,
  text: string,
  options: {
    update_mode?: "append" | "replace";
    is_final?: boolean;
    turn?: number;
    revision?: number;
    outputSequence?: number;
    generation?: number;
  } = {},
): RecognizedTextEvent => ({
  id,
  generation: options.generation,
  source: source(options.turn, options.revision, options.outputSequence),
  is_final: options.is_final ?? false,
  update_mode: options.update_mode ?? "append",
  text,
  source_asr_model: "reazonspeech_k2_v2" as AsrModel,
  source_language: "japanese",
  detected_language: "ja",
  recognized_at_millis: 1,
  audio_seconds: 0.1,
  elapsed_millis: 1,
  audio_frames: 1,
  debug_asr_audio_sample_rate: null,
  debug_asr_audio_samples: null,
});

const translated = (
  id: string,
  text: string,
  options: {
    update_mode?: "append" | "replace";
    is_final?: boolean;
    turn?: number;
    revision?: number;
    outputSequence?: number;
    generation?: number;
  } = {},
): TranslationTextEvent => ({
  id,
  generation: options.generation,
  source_recognition_id: id,
  source: source(options.turn, options.revision, options.outputSequence),
  source_asr_model: "reazonspeech_k2_v2" as AsrModel,
  source_text: "字幕",
  source_detected_language: "ja",
  target_lang: "en",
  translated_text: text,
  is_final: options.is_final ?? false,
  update_mode: options.update_mode ?? "append",
  translated_at_millis: 1,
  elapsed_millis: 1,
  status: "success",
  error: null,
});

describe("generation-aware Parapper display state", () => {
  it("advances once on a cursor regression and keeps restart updates together", () => {
    const running = {
      generation: 0,
      highestTurnSessionId: 7,
      latestSourceCursor: source(3, 2, 4),
    };

    const restarted = advanceRecognitionGeneration(running, source(1, 0, 1));
    const duplicateRestart = advanceRecognitionGeneration(
      restarted,
      source(1, 0, 1),
    );
    const partial = advanceRecognitionGeneration(
      duplicateRestart,
      source(1, 0, 2),
    );
    const final = advanceRecognitionGeneration(partial, source(1, 1, 3));

    expect(restarted.generation).toBe(1);
    expect(restarted.latestSourceCursor).toEqual(source(1, 0, 1));
    expect(duplicateRestart.generation).toBe(1);
    expect(partial.generation).toBe(1);
    expect(final.generation).toBe(1);
    expect(final.latestSourceCursor).toEqual(source(1, 1, 3));
  });

  it("does not duplicate an identical append event but keeps distinct cumulative appends", () => {
    const first = recognized("turn-7-1-0-a", "字幕", {
      outputSequence: 1,
    });
    const second = recognized("turn-7-1-0-b", "字幕 続き", {
      outputSequence: 2,
    });
    const once = upsertRecognizedText([], first);
    const duplicate = upsertRecognizedText(once, { ...first });
    const cumulative = upsertRecognizedText(duplicate, second);
    const sameCursorRevision = upsertRecognizedText(cumulative, {
      ...first,
      text: "字幕 更新",
    });

    expect(duplicate).toBe(once);
    expect(cumulative.map((event) => event.text)).toEqual([
      "字幕",
      "字幕 続き",
    ]);
    expect(recognitionTextRowId(first)).not.toBe(recognitionTextRowId(second));
    expect(recognitionTextEventKey(first)).not.toBe(
      recognitionTextEventKey(second),
    );
    expect(sameCursorRevision).toHaveLength(3);
  });

  it("replaces only a newer event in the same generation", () => {
    const partial = recognized("turn-7-1-0", "途中", {
      update_mode: "replace",
      outputSequence: 1,
    });
    const final = recognized("turn-7-1-0", "確定", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 2,
    });
    const merged = upsertRecognizedText([partial], final);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("確定");
    expect(upsertRecognizedText(merged, { ...final })).toBe(merged);
  });

  it("keeps a restarted sidecar turn separate even when native ids collide", () => {
    const previous = recognized("turn-7-1-0", "前の字幕", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 2,
      generation: 0,
    });
    const restarted = recognized("turn-7-1-0", "再起動後の字幕", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 2,
      generation: 1,
    });
    const merged = upsertRecognizedText([previous], restarted);

    expect(merged.map((event) => event.text)).toEqual([
      "前の字幕",
      "再起動後の字幕",
    ]);
    expect(
      recognitionSourceRowId(previous.source, previous.generation),
    ).not.toBe(recognitionSourceRowId(restarted.source, restarted.generation));
    expect(recognitionTextEventKey(previous)).not.toBe(
      recognitionTextEventKey(restarted),
    );
  });

  it("deduplicates translated appends and keeps generation-aware translation keys", () => {
    const first = translated("turn-7-1-0|en", "first", {
      outputSequence: 1,
      generation: 0,
    });
    const duplicate = upsertTranslatedText([first], { ...first });
    const restarted = translated("turn-7-1-0|en", "after restart", {
      outputSequence: 1,
      generation: 1,
    });

    expect(duplicate).toBeInstanceOf(Array);
    expect(duplicate).toHaveLength(1);
    expect(translationTextEventKey(first)).not.toBe(
      translationTextEventKey(restarted),
    );
    expect(translationTextRowId(first)).not.toBe(
      translationTextRowId(restarted),
    );
    expect(upsertTranslatedText(duplicate, restarted)).toHaveLength(2);
  });

  it("bounds rows while retaining the newest configured display amount", () => {
    const rows = Array.from({ length: 12 }, (_, index) => index);
    expect(trimRecognitionLogRows(rows, 4)).toEqual([8, 9, 10, 11]);
    expect(trimRecognitionLogRows(rows, null, 6)).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it("refuses to replace an older final event with a partial one", () => {
    const final = recognized("turn-7-1-0", "前の字幕", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 2,
    });
    const partial = recognized("turn-7-1-0", "途中", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 3,
    });
    const existing = [final];
    const merged = upsertRecognizedText(existing, partial);
    expect(merged).toBe(existing);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("前の字幕");
  });

  it("refuses to replace with an equal or older revision at the same output sequence", () => {
    const newer = recognized("turn-7-1-0", "新しい確定", {
      update_mode: "replace",
      is_final: true,
      revision: 3,
      outputSequence: 4,
    });
    const older = recognized("turn-7-1-0", "古い確定", {
      update_mode: "replace",
      is_final: true,
      revision: 2,
      outputSequence: 4,
    });
    const merged = upsertRecognizedText([newer], older);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("新しい確定");
  });

  it("refuses to replace a final event with a non-final event at the same revision", () => {
    const final = recognized("turn-7-1-0", "確定", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 3,
    });
    const partial = recognized("turn-7-1-0", "途中", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 3,
    });
    const merged = upsertRecognizedText([final], partial);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("確定");
  });

  it("tracks the display generation across a sidecar restart", () => {
    const previous = {
      generation: 0,
      highestTurnSessionId: 7,
      latestSourceCursor: source(1, 0, 2),
    };
    const restarted = advanceRecognitionGeneration(previous, source(1, 0, 1));
    expect(restarted.generation).toBe(1);
    expect(restarted.latestSourceCursor).toEqual(source(1, 0, 1));

    const appended = advanceRecognitionGeneration(restarted, source(1, 0, 2));
    expect(appended.generation).toBe(1);
  });

  it("resolves a translated-text replace for an older final as an append", () => {
    const final = translated("turn-7-1-0|en", "english", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 1,
    });
    const stopped = translated("turn-7-1-0|en", "older", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 0,
    });
    const merged = upsertTranslatedText([final], stopped);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.translated_text).toBe("english");
  });

  it("replaces a translated event with a newer revision in the same language", () => {
    const older = translated("turn-7-1-0|en", "old", {
      update_mode: "replace",
      is_final: true,
      revision: 2,
      outputSequence: 3,
    });
    const newer = translated("turn-7-1-0|en", "new", {
      update_mode: "replace",
      is_final: true,
      revision: 3,
      outputSequence: 4,
    });
    const merged = upsertTranslatedText([older], newer);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.translated_text).toBe("new");
  });

  it("replaces a translated event with a higher output sequence at the same revision", () => {
    const partial = translated("turn-7-1-0|en", "partial", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 1,
    });
    const final = translated("turn-7-1-0|en", "final", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 2,
    });
    const merged = upsertTranslatedText([partial], final);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.translated_text).toBe("final");
  });

  it("deduplicates translated appends that carry a non-null error field", () => {
    const failed = translated("turn-7-1-0|en", "partial", {
      update_mode: "append",
      outputSequence: 1,
    });
    const withError: TranslationTextEvent = {
      ...failed,
      error: "timeout",
      status: "failure",
    };
    const once = upsertTranslatedText([], withError);
    const duplicate = upsertTranslatedText(once, { ...withError });
    expect(duplicate).toBe(once);
    expect(translationTextEventKey(withError)).toBe(
      translationTextEventKey({ ...withError }),
    );
  });

  it("returns the same object when the generation already matches", () => {
    const event = recognized("turn-7-1-0", "字幕", { generation: 2 });
    expect(withEventGeneration(event, 2)).toBe(event);
  });

  it("clones the event with a new generation when it differs", () => {
    const event = recognized("turn-7-1-0", "字幕", { generation: 2 });
    const updated = withEventGeneration(event, 3);
    expect(updated).not.toBe(event);
    expect(updated.generation).toBe(3);
    expect(event.generation).toBe(2);
  });

  it("replaces a partial event with a final event at the same revision and sequence", () => {
    const partial = recognized("turn-7-1-0", "途中", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 1,
    });
    const final = recognized("turn-7-1-0", "確定", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 1,
    });
    const merged = upsertRecognizedText([partial], final);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("確定");
  });

  it("keeps a newer partial when an identical partial arrives at the same revision and sequence", () => {
    const partial = recognized("turn-7-1-0", "途中", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 1,
    });
    const same = recognized("turn-7-1-0", "途中 更新", {
      update_mode: "replace",
      is_final: false,
      outputSequence: 1,
      revision: 0,
    });
    const existing = [partial];
    const merged = upsertRecognizedText(existing, same);
    expect(merged).toBe(existing);
    expect(merged[0]?.text).toBe("途中");
  });

  it("appends a translated replace that targets a different language", () => {
    const en = translated("turn-7-1-0|en", "english", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 1,
    });
    const ja: TranslationTextEvent = { ...en, target_lang: "ja" };
    const merged = upsertTranslatedText([en], ja);
    expect(merged).toHaveLength(2);
    expect(merged.map((event) => event.target_lang)).toEqual(["en", "ja"]);
  });

  it("replaces a translated event that is not the first row", () => {
    const first = translated("turn-7-3-0|en", "first", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 1,
      turn: 3,
    });
    const second = translated("turn-7-1-0|en", "second", {
      update_mode: "replace",
      is_final: true,
      outputSequence: 1,
      turn: 1,
    });
    const replacement = {
      ...second,
      id: "turn-7-1-1|en",
      source_recognition_id: "turn-7-1-1",
      translated_text: "replaced",
    };
    const merged = upsertTranslatedText([first, second], replacement);
    expect(merged).toHaveLength(2);
    expect(merged.map((event) => event.translated_text)).toEqual([
      "first",
      "replaced",
    ]);
  });

  it("uses the default generation zero when none is supplied to recognitionTurnKey", () => {
    expect(recognitionTurnKey({ turn_session_id: 7, turn_id: 3 })).toBe(
      "0|7|3",
    );
  });

  it("returns rows unchanged when the bounded count is at or above the length", () => {
    const rows = [1, 2, 3];
    expect(trimRecognitionLogRows(rows, 4)).toBe(rows);
    expect(trimRecognitionLogRows(rows, undefined)).toBe(rows);
  });

  it("falls back to the maximum row count for a non-finite limit", () => {
    const rows = Array.from({ length: 12 }, (_, index) => index);
    expect(trimRecognitionLogRows(rows, Number.NaN)).toBe(rows);
    expect(trimRecognitionLogRows(rows, Number.POSITIVE_INFINITY)).toBe(rows);
  });

  it("clamps the bounded count to at least one row", () => {
    const rows = Array.from({ length: 12 }, (_, index) => index);
    expect(trimRecognitionLogRows(rows, 0)).toEqual([rows[11]]);
  });
});
