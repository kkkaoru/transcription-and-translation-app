import { describe, expect, it } from "vitest";

import {
  recognitionSourceRowId,
  recognitionTextRowId,
  translationTextRowId,
} from "../src/lib/recognition-source";
import type {
  AsrModel,
  AsrLanguage,
  RecognizedTextEvent,
  RecognitionSourceMeta,
  TranslationTextEvent,
} from "../src/lib/types";

const source = (
  overrides: Partial<RecognitionSourceMeta> = {},
): RecognitionSourceMeta => ({
  turn_session_id: 7,
  turn_id: 3,
  turn_revision: 0,
  output_sequence: 1,
  segment_id: 3,
  previous_segment_id: null,
  ...overrides,
});

const recognized = (
  id: string,
  text: string,
  overrides: Partial<RecognizedTextEvent> = {},
): RecognizedTextEvent => ({
  id,
  generation: 0,
  source: source(),
  is_final: false,
  update_mode: "replace",
  text,
  source_asr_model: "reazonspeech_k2_v2" as AsrModel,
  source_language: "japanese" as AsrLanguage,
  detected_language: "ja",
  recognized_at_millis: 1,
  audio_seconds: 0.1,
  elapsed_millis: 1,
  audio_frames: 1,
  debug_asr_audio_sample_rate: null,
  debug_asr_audio_samples: null,
  ...overrides,
});

const translated = (
  id: string,
  text: string,
  overrides: Partial<TranslationTextEvent> = {},
): TranslationTextEvent => ({
  id,
  generation: 0,
  source_recognition_id: "turn-7-3-0",
  source: source(),
  source_asr_model: "reazonspeech_k2_v2" as AsrModel,
  source_text: "字幕",
  source_detected_language: "ja",
  target_lang: "en",
  translated_text: text,
  is_final: false,
  update_mode: "replace",
  translated_at_millis: 1,
  elapsed_millis: 1,
  status: "success",
  error: null,
  ...overrides,
});

describe("recognitionSourceRowId", () => {
  it("uses the legacy one-argument form without a generation segment", () => {
    expect(recognitionSourceRowId(source())).toBe("turn-7-3");
  });

  it("prepends the generation when a numeric generation is supplied", () => {
    expect(recognitionSourceRowId(source(), 0)).toBe("turn-0-7-3");
    expect(recognitionSourceRowId(source(), 2)).toBe("turn-2-7-3");
  });

  it("treats generation 0 as a real generation, not the legacy undefined form", () => {
    expect(recognitionSourceRowId(source(), 0)).not.toBe(
      recognitionSourceRowId(source()),
    );
  });

  it("distinguishes turns with the same turn_id across different sessions", () => {
    const sessionA = source({ turn_session_id: 7 });
    const sessionB = source({ turn_session_id: 9 });
    expect(recognitionSourceRowId(sessionA, 1)).not.toBe(
      recognitionSourceRowId(sessionB, 1),
    );
  });
});

describe("recognitionTextRowId", () => {
  it("returns the base row id for replace events", () => {
    const event = recognized("turn-7-3-0", "確定", {
      update_mode: "replace",
    });
    expect(recognitionTextRowId(event)).toBe("turn-0-7-3");
  });

  it("appends the event id and source cursor for append events", () => {
    const event = recognized("turn-7-3-0", "字幕", {
      update_mode: "append",
      source: source({ output_sequence: 1 }),
    });
    expect(recognitionTextRowId(event)).toBe(
      "turn-0-7-3|append-turn-7-3-0-0-1-3-",
    );
  });

  it("produces distinct row ids for append events with different event ids", () => {
    const a = recognized("turn-7-3-0-a", "A", { update_mode: "append" });
    const b = recognized("turn-7-3-0-b", "B", { update_mode: "append" });
    expect(recognitionTextRowId(a)).not.toBe(recognitionTextRowId(b));
  });

  it("produces distinct row ids for append events with different output sequences", () => {
    const first = recognized("turn-7-3-0-a", "A", {
      update_mode: "append",
      source: source({ output_sequence: 1 }),
    });
    const second = recognized("turn-7-3-0-b", "B", {
      update_mode: "append",
      source: source({ output_sequence: 2 }),
    });
    expect(recognitionTextRowId(first)).not.toBe(recognitionTextRowId(second));
  });

  it("produces distinct row ids for append events with different segment ids", () => {
    const first = recognized("turn-7-3-0-a", "A", {
      update_mode: "append",
      source: source({ segment_id: 3 }),
    });
    const second = recognized("turn-7-3-0-b", "B", {
      update_mode: "append",
      source: source({ segment_id: 5 }),
    });
    expect(recognitionTextRowId(first)).not.toBe(recognitionTextRowId(second));
  });

  it("distinguishes null previous_segment_id from 0 in the source cursor", () => {
    const withNull = recognized("turn-7-3-0-a", "A", {
      update_mode: "append",
      source: source({ previous_segment_id: null }),
    });
    const withZero = recognized("turn-7-3-0-b", "B", {
      update_mode: "append",
      source: source({ previous_segment_id: 0 }),
    });
    expect(recognitionTextRowId(withNull)).not.toBe(
      recognitionTextRowId(withZero),
    );
  });

  it("produces the same row id for two replace events in the same turn and generation", () => {
    const partial = recognized("turn-7-3-0", "途中", {
      update_mode: "replace",
      is_final: false,
    });
    const final = recognized("turn-7-3-0", "確定", {
      update_mode: "replace",
      is_final: true,
    });
    expect(recognitionTextRowId(partial)).toBe(recognitionTextRowId(final));
  });

  it("produces distinct row ids across different generations for the same turn", () => {
    const gen0 = recognized("turn-7-3-0", "前", {
      update_mode: "replace",
      generation: 0,
    });
    const gen1 = recognized("turn-7-3-0", "後", {
      update_mode: "replace",
      generation: 1,
    });
    expect(recognitionTextRowId(gen0)).not.toBe(recognitionTextRowId(gen1));
  });

  it("produces distinct row ids for different revisions in the source cursor", () => {
    const rev0 = recognized("turn-7-3-0-a", "A", {
      update_mode: "append",
      source: source({ turn_revision: 0 }),
    });
    const rev1 = recognized("turn-7-3-1-a", "B", {
      update_mode: "append",
      source: source({ turn_revision: 1 }),
    });
    expect(recognitionTextRowId(rev0)).not.toBe(recognitionTextRowId(rev1));
  });
});

describe("translationTextRowId", () => {
  it("returns the base row id for replace events", () => {
    const event = translated("turn-7-3-0|en", "translation", {
      update_mode: "replace",
    });
    expect(translationTextRowId(event)).toBe("turn-0-7-3");
  });

  it("appends the source recognition id and source cursor for append events", () => {
    const event = translated("turn-7-3-0|en", "translation", {
      update_mode: "append",
      source_recognition_id: "turn-7-3-0",
      source: source({ output_sequence: 1 }),
    });
    expect(translationTextRowId(event)).toBe(
      "turn-0-7-3|append-turn-7-3-0-0-1-3-",
    );
  });

  it("produces distinct row ids for append events with different source recognition ids", () => {
    const a = translated("turn-7-3-0|en", "A", {
      update_mode: "append",
      source_recognition_id: "turn-7-3-0-a",
    });
    const b = translated("turn-7-3-0|en", "B", {
      update_mode: "append",
      source_recognition_id: "turn-7-3-0-b",
    });
    expect(translationTextRowId(a)).not.toBe(translationTextRowId(b));
  });

  it("produces distinct row ids for append events with different output sequences", () => {
    const first = translated("turn-7-3-0|en-a", "first", {
      update_mode: "append",
      source: source({ output_sequence: 1 }),
    });
    const second = translated("turn-7-3-0|en-b", "second", {
      update_mode: "append",
      source: source({ output_sequence: 2 }),
    });
    expect(translationTextRowId(first)).not.toBe(translationTextRowId(second));
  });

  it("produces the same row id for two replace events in the same turn and generation", () => {
    const partial = translated("turn-7-3-0|en", "partial", {
      update_mode: "replace",
      is_final: false,
    });
    const final = translated("turn-7-3-0|en", "final", {
      update_mode: "replace",
      is_final: true,
    });
    expect(translationTextRowId(partial)).toBe(translationTextRowId(final));
  });

  it("produces distinct row ids across different generations for the same turn", () => {
    const gen0 = translated("turn-7-3-0|en", "前", {
      update_mode: "replace",
      generation: 0,
    });
    const gen1 = translated("turn-7-3-0|en", "後", {
      update_mode: "replace",
      generation: 1,
    });
    expect(translationTextRowId(gen0)).not.toBe(translationTextRowId(gen1));
  });
});
