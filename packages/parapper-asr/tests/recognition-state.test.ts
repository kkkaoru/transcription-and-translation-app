import { describe, expect, it } from "bun:test";

import {
  recognitionTextEventKey,
  trimRecognitionLogRows,
  translationTextEventKey,
  upsertRecognizedText,
  upsertTranslatedText,
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
});
