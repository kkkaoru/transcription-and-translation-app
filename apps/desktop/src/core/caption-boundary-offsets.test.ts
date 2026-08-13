import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCaptionBoundaryOffsets,
  type CaptionBoundaryOffsets,
  cachedCaptionBoundaryOffsets,
  captionMissingBoundaryOffsets,
  ensureCaptionBoundaryOffsets,
  fetchCaptionBoundaryOffsets,
  resetCaptionBoundaryOffsetCache,
} from "./caption-boundary-offsets";
import type { CaptionPayload } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const caption = (partial: Partial<CaptionPayload> = {}): CaptionPayload => ({
  id: "parapper:session:turn:1",
  sourceText: "今日は晴れです明日は雨",
  translationText: "It is sunny today",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 1,
  receivedAt: 1,
  stage: "source",
  sequence: 0,
  isFinal: false,
  ...partial,
});

const bounds = (partial: Partial<CaptionBoundaryOffsets> = {}): CaptionBoundaryOffsets => ({
  tokens: [{ surface: "今日", feature: "名詞,副詞可能,*,*,*,*,*,*,*", charEnd: 2 }],
  sentenceEnds: [7],
  softBreaks: [3, 7],
  ...partial,
});

describe("caption boundary offset recompute", () => {
  beforeEach(() => {
    resetCaptionBoundaryOffsetCache();
    vi.mocked(invoke).mockReset();
    window.__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    resetCaptionBoundaryOffsetCache();
    window.__TAURI_INTERNALS__ = undefined;
  });

  it("detects merge-dropped offsets on a non-empty source", () => {
    expect(captionMissingBoundaryOffsets(caption())).toBe(true);
    expect(
      captionMissingBoundaryOffsets(caption({ sentenceEndOffsets: [7], softBreakOffsets: [3] })),
    ).toBe(false);
    expect(captionMissingBoundaryOffsets(caption({ sourceText: "  " }))).toBe(false);
    expect(
      captionMissingBoundaryOffsets(caption({ sentenceEndOffsets: [7], softBreakOffsets: [] })),
    ).toBe(true);
  });

  it("invokes Rust once per sourceText identity and keeps the plate on failure", async () => {
    vi.mocked(invoke).mockResolvedValue(bounds());
    const first = caption({ sourceText: "今日は晴れです明日は雨" });
    const restored = await ensureCaptionBoundaryOffsets(first);
    expect(restored.sentenceEndOffsets).toEqual([7]);
    expect(restored.softBreakOffsets).toEqual([3, 7]);
    expect(restored.translationText).toBe("It is sunny today");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("caption_boundary_offsets", {
      text: "今日は晴れです明日は雨",
    });
    expect(cachedCaptionBoundaryOffsets("今日は晴れです明日は雨")).toEqual(bounds());

    await ensureCaptionBoundaryOffsets(caption({ sourceText: "今日は晴れです明日は雨" }));
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("tokenizer busy"));
    const failed = await fetchCaptionBoundaryOffsets("別の本文です");
    expect(failed).toBeNull();
    const kept = await ensureCaptionBoundaryOffsets(
      caption({ sourceText: "別の本文です", translationText: "kept" }),
    );
    expect(kept.sourceText).toBe("別の本文です");
    expect(kept.translationText).toBe("kept");
    expect(kept).toMatchObject({ sourceText: "別の本文です", translationText: "kept" });
  });

  it("does not invoke when offsets are already present", async () => {
    const current = caption({ sentenceEndOffsets: [5], softBreakOffsets: [3] });
    await expect(ensureCaptionBoundaryOffsets(current)).resolves.toBe(current);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves the caption unchanged when invoke fails with no prior offsets", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no dictionary"));
    const current = caption();
    await expect(ensureCaptionBoundaryOffsets(current)).resolves.toBe(current);
    expect(current.sourceText).toBe("今日は晴れです明日は雨");
  });

  it("does not invoke outside the Tauri runtime", async () => {
    window.__TAURI_INTERNALS__ = undefined;
    await expect(fetchCaptionBoundaryOffsets("今日は晴れです明日は雨")).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("applies fetched offsets without mutating the original caption", () => {
    const current = caption();
    const next = applyCaptionBoundaryOffsets(current, bounds());
    expect(current.sentenceEndOffsets).toBeUndefined();
    expect(next).not.toBe(current);
    expect(next.sentenceEndOffsets).toEqual([7]);
  });
});
