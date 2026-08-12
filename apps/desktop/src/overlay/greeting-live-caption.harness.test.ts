/**
 * Greeting live-caption regression harness.
 *
 * Fixture table: `greeting-live-caption-fixtures.json`.
 * Gate: `bun run verify:greeting-caption` (no microphone).
 * Optional playback: `KOTOBA_BEACON_GREETING_WAV=apps/desktop/src/overlay/fixtures/greeting-kikoemasu.wav bun run verify:tauri:ui`.
 */
import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCaptionMergeDiagnostics, mergeCaptionPayload } from "../core/caption-updates";
import type { CaptionPayload } from "../core/types";
import { captionTextLines, sanitizeCaptionDisplayText } from "./captions";
import fixtures from "./greeting-live-caption-fixtures.json";

const caption = (
  partial: Partial<CaptionPayload> & Pick<CaptionPayload, "id" | "sourceText">,
): CaptionPayload => ({
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

describe("greeting live-caption harness (check-in-able, no live audio)", () => {
  beforeEach(() => {
    clearCaptionMergeDiagnostics();
  });

  it("repairs ASR/ZenZ greeting + hearing-check slips to the overlay surface", () => {
    expect(fixtures.sanitize.length).toBeGreaterThanOrEqual(8);
    for (const row of fixtures.sanitize) {
      expect(sanitizeCaptionDisplayText(row.input), row.id).toBe(row.expectedOverlay);
    }
  });

  it("keeps こんにちは + きこえますか across early finals, acks, and remints", () => {
    expect(fixtures.merge.length).toBeGreaterThanOrEqual(4);
    for (const row of fixtures.merge) {
      const current = caption(row.current);
      const merged = mergeCaptionPayload(current, caption(row.next));
      // null means the painted plate stays (e.g. こんにちは must not become はい).
      const overlay = merged?.sourceText ?? current.sourceText;
      if ("expectedOverlay" in row && row.expectedOverlay) {
        expect(overlay, row.id).toBe(row.expectedOverlay);
      }
      if ("expectedOverlayContains" in row && row.expectedOverlayContains) {
        expect(overlay, row.id).toContain(row.expectedOverlayContains);
      }
    }
  });

  it("does not page or wrap away こんにちは / きこえますか on the overlay plate", () => {
    expect(fixtures.paging.length).toBeGreaterThanOrEqual(15);
    for (const row of fixtures.paging) {
      const text = row.sanitize ? sanitizeCaptionDisplayText(row.text) : row.text;
      if ("expectedVisible" in row && row.expectedVisible) {
        expect(
          selectVisibleCaptionSentence(text, {
            sentenceEndOffsets: row.sentenceEndOffsets,
          }),
          row.id,
        ).toBe(row.expectedVisible);
        expect(
          captionTextLines({
            key: "source",
            text,
            maxChars: row.maxChars ?? 28,
            sentenceEndOffsets: row.sentenceEndOffsets,
          }).join(""),
          row.id,
        ).toBe(row.expectedVisible);
      }
      if ("expectedLines" in row && row.expectedLines) {
        expect(
          captionTextLines({
            key: "source",
            text,
            maxChars: row.maxChars ?? 28,
            sentenceEndOffsets: row.sentenceEndOffsets,
          }),
          row.id,
        ).toEqual(row.expectedLines);
      }
    }
  });
});
