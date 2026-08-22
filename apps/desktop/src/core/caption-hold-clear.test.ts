import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEmptyCaption, createHoldClearedCaption } from "../overlay/captions";
import {
  CAPTION_HOLD_CLEAR_MAX_MS,
  CAPTION_HOLD_CLEAR_MIN_MS,
  CAPTION_HOLD_CLEAR_MS,
  captionHoldClearDelayMs,
  captionHoldClearEpoch,
  isOpenCaptionClause,
  isRelatedCaptionContinuation,
  logCaptionDisplayLifecycle,
  shouldApplyCaptionHoldClear,
  shouldBlankCaptionForHoldClear,
} from "./caption-hold-clear";
import { mergeCaptionPayload } from "./caption-updates";
import { clearStructuredLogs, getStructuredLogs } from "./structuredLog";
import type { CaptionPayload } from "./types";

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

describe("logCaptionDisplayLifecycle", () => {
  it("records numeric lifecycle changes without caption text", () => {
    clearStructuredLogs();
    logCaptionDisplayLifecycle(
      "hold",
      caption({
        id: "parapper:s:1:2",
        sourceText: "秘密の字幕",
        translationText: "secret",
        receivedAt: 1_000,
        captureGeneration: 4,
      }),
      9_500,
    );
    const row = getStructuredLogs({ limit: 1 })[0];
    expect(row?.message).toBe(
      "caption display lifecycle=hold age_ms=8500 generation=4 has_translation=true",
    );
    expect(row?.fields).toMatchObject({
      lifecycle: "hold",
      ageMs: 8500,
      generation: 4,
      hasTranslation: true,
    });
    expect(JSON.stringify(row)).not.toContain("秘密の字幕");
    expect(JSON.stringify(row)).not.toContain("secret");

    clearStructuredLogs();
    logCaptionDisplayLifecycle(
      "clear",
      caption({ sourceText: "", captureGeneration: Number.NaN }),
      9_500,
    );
    expect(getStructuredLogs({ limit: 1 })[0]?.message).toBe(
      "caption display lifecycle=clear age_ms=9499 generation=none has_translation=false",
    );
  });
});

describe("captionHoldClearDelayMs", () => {
  it("skips empty, preview, and placeholder captions", () => {
    expect(captionHoldClearDelayMs(caption({ sourceText: "", translationText: "" }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ id: "preview" }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ id: "empty", sourceText: "x" }))).toBeNull();
  });

  it("gives finalized and translated captions a stream-readable hold", () => {
    expect(CAPTION_HOLD_CLEAR_MS).toBe(4_000);
    expect(CAPTION_HOLD_CLEAR_MIN_MS).toBe(4_000);
    expect(CAPTION_HOLD_CLEAR_MAX_MS).toBe(7_000);
    expect(captionHoldClearDelayMs(caption({ isFinal: true, sourceText: "こんにちは" }))).toBe(
      4_000,
    );
    expect(
      captionHoldClearDelayMs(caption({ isFinal: false, translationText: "It is sunny today" })),
    ).toBe(4_000);
  });

  it("holds a two-line Japanese plate longer than a short greeting and under 8000 ms", () => {
    const shortFinal = caption({ isFinal: true, sourceText: "こんにちは" });
    const longFinal = caption({
      isFinal: true,
      sourceText:
        "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよわん",
    });
    const shortHold = captionHoldClearDelayMs(shortFinal);
    const longHold = captionHoldClearDelayMs(longFinal);
    expect(shortHold).toBe(4_000);
    expect(longHold).toBe(6_000);
    expect(longHold === null || shortHold === null).toBe(false);
    expect((longHold ?? 0) > (shortHold ?? 0)).toBe(true);
    expect((longHold ?? 0) <= 7_999).toBe(true);
  });

  it("does not auto-clear a related continuation before the next clause is ready", () => {
    const openClause = caption({
      isFinal: true,
      sourceText: "今日は",
    });
    const notReady = caption({
      id: "u-2",
      sourceText: "",
      isFinal: false,
    });
    const relatedTail = caption({
      id: "u-1",
      sourceText: "今日は晴れですので午後もこの話を続けます",
      isFinal: false,
    });
    expect(isOpenCaptionClause("今日は")).toBe(true);
    expect(isOpenCaptionClause("確認して")).toBe(true);
    expect(isOpenCaptionClause("だから")).toBe(true);
    expect(captionHoldClearDelayMs(openClause)).toBe(7_000);
    expect(captionHoldClearDelayMs(caption({ isFinal: true, sourceText: "確認して" }))).toBe(7_000);
    expect(captionHoldClearDelayMs(caption({ isFinal: true, sourceText: "だから" }))).toBe(7_000);
    expect(isRelatedCaptionContinuation(openClause, notReady)).toBe(true);
    expect(isRelatedCaptionContinuation(openClause, relatedTail)).toBe(true);
    expect(captionHoldClearDelayMs(openClause, notReady)).toBe(7_000);
    expect(captionHoldClearDelayMs(openClause, relatedTail)).toBe(7_000);
  });

  it("treats a greeting ending in は as a finished turn, not an open clause", () => {
    const greeting = caption({
      isFinal: true,
      sourceText: "こんにちは",
    });
    const unrelated = caption({
      id: "u-2",
      sourceText: "明日は雨です。",
      isFinal: true,
    });
    expect(isOpenCaptionClause("")).toBe(false);
    expect(isOpenCaptionClause("こんにちは")).toBe(false);
    expect(isOpenCaptionClause("こんばんは")).toBe(false);
    expect(isRelatedCaptionContinuation(greeting, unrelated)).toBe(false);
    expect(captionHoldClearDelayMs(greeting)).toBe(4_000);
    expect(captionHoldClearDelayMs(greeting, unrelated)).toBe(4_000);
  });

  it("clears a finished punctuated turn inside the reading envelope", () => {
    const finished = caption({
      isFinal: true,
      sourceText: "今日は晴れです。",
    });
    const nextTurn = caption({
      id: "u-2",
      sourceText: "明日は雨です。",
      isFinal: true,
    });
    expect(isRelatedCaptionContinuation(finished, nextTurn)).toBe(false);
    expect(captionHoldClearDelayMs(finished)).toBe(4_000);
    expect(captionHoldClearDelayMs(finished, nextTurn)).toBe(4_000);
  });

  it("does not auto-clear non-final captions during long speech gaps", () => {
    expect(captionHoldClearDelayMs(caption({ isFinal: false, provisional: true }))).toBeNull();
    expect(captionHoldClearDelayMs(caption({ isFinal: false }))).toBeNull();
  });
});

describe("shouldApplyCaptionHoldClear", () => {
  it("rejects a stale hold when a newer utterance already replaced the plate", () => {
    const held = caption({
      id: "parapper:s:t:1",
      sourceText: "今日は晴れです",
      isFinal: true,
      receivedAt: 1_000,
    });
    const nextTurn = caption({
      id: "parapper:s:t:2",
      sourceText: "明日は雨です",
      isFinal: true,
      receivedAt: 1_000 + CAPTION_HOLD_CLEAR_MS,
    });
    const heldEpoch = captionHoldClearEpoch(held);
    expect(shouldApplyCaptionHoldClear(heldEpoch, held)).toBe(true);
    expect(shouldApplyCaptionHoldClear(heldEpoch, nextTurn)).toBe(false);
  });
});

describe("shouldBlankCaptionForHoldClear", () => {
  it("blanks only when the epoch still matches a non-empty live caption", () => {
    const held = caption({
      id: "parapper:s:t:1",
      sourceText: "今日は晴れです",
      isFinal: true,
      receivedAt: 1_000,
    });
    const heldEpoch = captionHoldClearEpoch(held);
    expect(shouldBlankCaptionForHoldClear(heldEpoch, held)).toBe(true);
    expect(
      shouldBlankCaptionForHoldClear(
        heldEpoch,
        caption({
          id: "parapper:s:t:2",
          sourceText: "明日は雨です",
          isFinal: true,
          receivedAt: 1_000 + CAPTION_HOLD_CLEAR_MS,
        }),
      ),
    ).toBe(false);
    expect(
      shouldBlankCaptionForHoldClear(
        captionHoldClearEpoch(caption({ id: "preview" })),
        caption({ id: "preview" }),
      ),
    ).toBe(false);
    expect(
      shouldBlankCaptionForHoldClear(
        captionHoldClearEpoch(caption({ sourceText: "", translationText: "", isFinal: true })),
        caption({ sourceText: "", translationText: "", isFinal: true }),
      ),
    ).toBe(false);
  });
});

describe("live hold-clear receipt barrier", () => {
  const lateSameUtterance = (): CaptionPayload =>
    caption({
      id: "live-hold-stale-revive",
      sourceText: "消えたあとに戻ってはいけない",
      isFinal: true,
      startedAt: 70,
      receivedAt: 90,
    });

  it("proves createEmptyCaption after hold-clear would revive a late same-utterance payload", () => {
    // Live MainApp historically blanked with createEmptyCaption() (receivedAt: 0).
    // Merge then treated any finite receipt as the first post-reset caption.
    const emptyPlate = createEmptyCaption();
    expect(emptyPlate.receivedAt).toBe(0);
    expect(mergeCaptionPayload(emptyPlate, lateSameUtterance())?.sourceText).toBe(
      "消えたあとに戻ってはいけない",
    );
  });

  it("drops a late older payload after hold-clear while accepting a newer utterance", () => {
    const cleared = createHoldClearedCaption(5_000);
    expect(cleared.receivedAt).toBe(5_000);
    expect(cleared.startedAt).toBe(0);
    expect(mergeCaptionPayload(cleared, lateSameUtterance())).toBeNull();
    expect(
      mergeCaptionPayload(
        cleared,
        caption({
          id: "live-after-hold-clear",
          sourceText: "新しい発話",
          isFinal: false,
          startedAt: 4_900,
          receivedAt: 5_001,
        }),
      )?.sourceText,
    ).toBe("新しい発話");
  });

  it("keeps session-reset empty at receivedAt 0 so the first post-reset caption still lands", () => {
    const reset = createEmptyCaption();
    expect(reset.receivedAt).toBe(0);
    expect(
      mergeCaptionPayload(
        reset,
        caption({
          id: "live-first-after-reset",
          sourceText: "リセット後の最初の字幕",
          isFinal: false,
          startedAt: 10,
          receivedAt: 20,
        }),
      )?.sourceText,
    ).toBe("リセット後の最初の字幕");
  });

  it("wires MainApp blankDisplayedCaption to createHoldClearedCaption and keeps clearCaptionState on createEmptyCaption", () => {
    const mainAppPath = join(dirname(fileURLToPath(import.meta.url)), "../live/MainApp.tsx");
    const source = readFileSync(mainAppPath, "utf8");
    expect(source).toMatch(
      /import\s*\{[^}]*\bcreateHoldClearedCaption\b[^}]*\}\s*from\s*"\.\.\/overlay\/captions"/,
    );

    const blankMatch = source.match(
      /const blankDisplayedCaption = useCallback\(\s*\(expectedEpoch: string\): void => \{([\s\S]*?)\},\s*\[clearPartialWindowSlot, stickyRefs\]\s*,\s*\);/,
    );
    expect(blankMatch?.[1]).toMatch(/createHoldClearedCaption\s*\(/);
    expect(blankMatch?.[1]).not.toMatch(/createEmptyCaption\s*\(/);
    expect(blankMatch?.[1]).toMatch(/clearPartialWindowSlot\s*\(/);

    const clearMatch = source.match(
      /const clearCaptionState = useCallback\(\(\): void => \{([\s\S]*?)\},\s*\[clearPartialWindowSlot, stickyRefs\]\s*\);/,
    );
    expect(clearMatch?.[1]).toMatch(/createEmptyCaption\s*\(/);
    expect(clearMatch?.[1]).not.toMatch(/createHoldClearedCaption\s*\(/);
    expect(clearMatch?.[1]).toMatch(/clearPartialWindowSlot\s*\(/);
  });
});
