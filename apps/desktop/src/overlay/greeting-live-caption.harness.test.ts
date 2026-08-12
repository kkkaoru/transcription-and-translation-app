/**
 * Greeting live-caption regression harness.
 *
 * Fixture table: `greeting-live-caption-fixtures.json`.
 * Gate: `bun run verify:greeting-caption` (no microphone).
 * Optional playback: `KOTOBA_BEACON_GREETING_WAV=<wav> bun run verify:tauri:ui`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearCaptionMergeDiagnostics, mergeCaptionPayload } from "../core/caption-updates";
import type { CaptionPayload } from "../core/types";
import { sanitizeCaptionDisplayText } from "./captions";
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
});
