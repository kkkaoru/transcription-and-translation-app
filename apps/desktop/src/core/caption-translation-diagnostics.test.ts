import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCaptionTranslationDispositions,
  recordCaptionTranslationDisposition,
  snapshotCaptionTranslationDispositions,
} from "./caption-translation-diagnostics";
import type { CaptionPayload } from "./types";

const caption = (overrides: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "u-1",
  sourceText: "こんにちは",
  azookeyInputText: "こんにちは",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...overrides,
});

describe("caption translation dispositions", () => {
  beforeEach(() => {
    clearCaptionTranslationDispositions();
  });

  it("records explicit accepted and dropped translation decisions without transcript text", () => {
    const current = caption();
    const incoming = caption({
      translationText: "Hello",
      stage: "translation",
      sequence: 1,
      isFinal: true,
    });

    recordCaptionTranslationDisposition(current, incoming, incoming, "accepted");
    recordCaptionTranslationDisposition(current, incoming, null, "out-of-order");

    expect(snapshotCaptionTranslationDispositions()).toEqual([
      expect.objectContaining({
        reason: "accepted",
        incomingTranslationChars: 5,
        outputTranslationChars: 5,
        incomingTranslationPreserved: true,
        sourceMatched: true,
        sourceEquivalentIgnoringPunctuation: true,
        readingMatched: true,
      }),
      expect.objectContaining({
        reason: "out-of-order",
        incomingTranslationChars: 5,
        outputTranslationChars: 0,
        incomingTranslationPreserved: false,
      }),
    ]);
    expect(JSON.stringify(snapshotCaptionTranslationDispositions())).not.toContain("Hello");
    expect(JSON.stringify(snapshotCaptionTranslationDispositions())).not.toContain("こんにちは");
  });

  it("identifies punctuation-only source revisions even when readings differ", () => {
    const current = caption({
      sourceText: "もう一度",
      azookeyInputText: "もういち度",
    });
    const incoming = caption({
      sourceText: "もう一度。",
      azookeyInputText: "もういちど",
      translationText: "Once more.",
    });

    recordCaptionTranslationDisposition(current, incoming, incoming, "accepted");

    expect(snapshotCaptionTranslationDispositions()[0]).toMatchObject({
      sourceMatched: false,
      sourceEquivalentIgnoringPunctuation: true,
      readingMatched: false,
    });
  });

  it("normalizes katakana readings in the same way as caption merge", () => {
    const current = caption({ azookeyInputText: "コンニチハ" });
    const incoming = caption({
      azookeyInputText: "こんにちは",
      translationText: "Hello",
    });

    recordCaptionTranslationDisposition(current, incoming, incoming, "accepted");

    expect(snapshotCaptionTranslationDispositions()[0]?.readingMatched).toBe(true);
  });

  it("ignores source-only merges and retains only the newest 32 translation decisions", () => {
    recordCaptionTranslationDisposition(caption(), caption(), null, "source-only");
    for (let index = 0; index < 40; index += 1) {
      const incoming = caption({ id: `u-${index}`, translationText: "T" });
      recordCaptionTranslationDisposition(caption(), incoming, incoming, `accepted-${index}`);
    }

    const snapshot = snapshotCaptionTranslationDispositions();
    expect(snapshot).toHaveLength(32);
    expect(snapshot[0]?.reason).toBe("accepted-8");
    expect(snapshot.at(-1)?.reason).toBe("accepted-39");
  });
});
