/**
 * Unbiased A/B: overlay display / merge / punct paging over a lead×tail matrix.
 * Neither こんにちは nor きこえますか is special-cased as the cause.
 */
// @vitest-environment jsdom

import { selectVisibleCaptionSentence } from "@caption-bridge/sentence-boundary";
import { describe, expect, it } from "vitest";
import { mergeCaptionPayload } from "../core/caption-updates";
import {
  resolveProgressiveRevealSourceTarget,
  shouldProgressivelyReveal,
  shouldSnapProgressiveFirstPaint,
} from "../core/progressive-caption-reveal";
import type { CaptionPayload } from "../core/types";
import {
  buildCaptionAbMatrix,
  CAPTION_AB_LEADS,
  CAPTION_AB_TAILS,
} from "./caption-surface-ab.matrix";
import {
  captionTextLines,
  restoreCollapsedGreetingContinuation,
  sanitizeCaptionDisplayText,
} from "./captions";

const caption = (
  partial: Partial<CaptionPayload> & Pick<CaptionPayload, "sourceText">,
): CaptionPayload => ({
  id: "parapper:s:1:1",
  translationText: "",
  sourceLanguage: "ja",
  targetLanguage: "en",
  startedAt: 10,
  receivedAt: 40,
  stage: "source",
  sequence: 0,
  isFinal: false,
  provisional: true,
  ...partial,
});

const MATRIX = buildCaptionAbMatrix();

const paintedKeepsFullLine = (
  painted: string,
  row: { lead: string; tail: string; full: string; id: string },
): void => {
  expect(painted, row.id).toContain(row.lead);
  if (row.tail) {
    expect(painted, row.id).toContain(row.tail);
  }
};

describe("caption surface A/B matrix (lead×tail, not greeting/hearing fixtures)", () => {
  it("builds a matrix that varies both lead and tail", () => {
    expect(CAPTION_AB_LEADS.length).toBeGreaterThanOrEqual(5);
    expect(CAPTION_AB_TAILS).toContain("きこえますか");
    expect(CAPTION_AB_TAILS).toContain("続きがあります");
    expect(CAPTION_AB_TAILS).toContain("終わりますか");
    expect(CAPTION_AB_TAILS).toContain("");
    expect(
      MATRIX.some((row) => row.lead === "会議を始めます" && row.tail === "続きがあります"),
    ).toBe(true);
    expect(MATRIX.some((row) => row.full === "こんにちはーーーきこえますかーーー？")).toBe(true);
    expect(MATRIX.length).toBeGreaterThanOrEqual(30);
  });

  it("keeps the concatenated line on sanitize / paging / wrap for every matrix row", () => {
    for (const row of MATRIX) {
      const sanitized = sanitizeCaptionDisplayText(row.full);
      const leadOff = [...row.lead].length;
      const visible = selectVisibleCaptionSentence(sanitized);
      const visibleAtLead = selectVisibleCaptionSentence(sanitized, {
        sentenceEndOffsets: [leadOff],
      });
      const lines = captionTextLines({ key: "source", text: sanitized, maxChars: 28 }).join("");
      paintedKeepsFullLine(sanitized, row);
      paintedKeepsFullLine(visible, row);
      paintedKeepsFullLine(visibleAtLead, row);
      paintedKeepsFullLine(lines, row);
      const reveal = resolveProgressiveRevealSourceTarget(caption({ sourceText: row.full }));
      paintedKeepsFullLine(reveal, row);
    }
  });

  it("keeps prefix growth after the 16ms first-commit so a later full line is not dropped", () => {
    for (const row of MATRIX) {
      if (!row.tail) {
        continue;
      }
      const target = resolveProgressiveRevealSourceTarget(caption({ sourceText: row.full }));
      expect(shouldSnapProgressiveFirstPaint(row.lead, target, false), row.id).toBe(false);
      expect(shouldProgressivelyReveal(row.lead, target), row.id).toBe(true);
      paintedKeepsFullLine(target, row);
    }
  });

  it("grows a short first paint into the concatenated same-id line for every row", () => {
    for (const row of MATRIX) {
      if (row.full === row.lead) {
        continue;
      }
      const grown = mergeCaptionPayload(
        caption({ sourceText: row.lead }),
        caption({ sourceText: row.full, receivedAt: 80 }),
      )?.sourceText;
      expect(grown, row.id).toBeDefined();
      paintedKeepsFullLine(grown ?? "", row);
    }
  });

  it("appends a same-start disjoint tail instead of dropping it after the lead", () => {
    for (const row of MATRIX) {
      if (!row.tail) {
        continue;
      }
      const twoPiece =
        mergeCaptionPayload(
          caption({ sourceText: row.lead, azookeyInputText: row.lead }),
          caption({
            sourceText: row.tail,
            azookeyInputText: row.tail,
            receivedAt: 80,
          }),
        )?.sourceText ?? row.lead;
      const afterNormalize =
        mergeCaptionPayload(
          caption({
            sourceText: row.lead,
            azookeyInputText: row.lead,
            provisional: false,
          }),
          caption({
            sourceText: row.tail,
            azookeyInputText: row.tail,
            receivedAt: 80,
          }),
        )?.sourceText ?? row.lead;
      paintedKeepsFullLine(twoPiece ?? "", row);
      paintedKeepsFullLine(afterNormalize ?? "", row);
    }
  });

  it("does not let a later prefix or suffix cut erase an already-painted full line", () => {
    for (const row of MATRIX) {
      if (row.full === row.lead) {
        continue;
      }
      const painted = caption({ sourceText: row.full });
      const afterPrefix =
        mergeCaptionPayload(
          painted,
          caption({ sourceText: row.lead, receivedAt: 80, isFinal: true, provisional: false }),
        )?.sourceText ?? painted.sourceText;
      paintedKeepsFullLine(afterPrefix, row);
      if (!row.tail) {
        continue;
      }
      const afterSuffix =
        mergeCaptionPayload(painted, caption({ sourceText: row.tail, receivedAt: 90 }))
          ?.sourceText ?? painted.sourceText;
      paintedKeepsFullLine(afterSuffix, row);
    }
  });

  it("pages mid-clause punct to the remainder unless a general keep rule applies", () => {
    for (const lead of CAPTION_AB_LEADS) {
      for (const tail of CAPTION_AB_TAILS) {
        if (!tail) {
          continue;
        }
        const raw = `${lead}。${tail}`;
        const sanitized = sanitizeCaptionDisplayText(raw);
        const visible = selectVisibleCaptionSentence(sanitized);
        const lines = captionTextLines({ key: "source", text: raw, maxChars: 28 }).join("");
        const leadOnly = visible.includes(lead) && !visible.includes(tail);
        expect(leadOnly, raw).toBe(false);
        if (!visible.includes(lead) && visible.includes(tail)) {
          // General period-page: 。 between clauses shows the remainder, not the lead.
          expect(lines, raw).toContain(tail);
          expect(lines.includes(lead), raw).toBe(false);
        } else {
          expect(visible, raw).toContain(lead);
          expect(visible, raw).toContain(tail);
          expect(lines, raw).toContain(lead);
          expect(lines, raw).toContain(tail);
        }
      }
    }
  });

  it("does not restore a lead-only plate from the concatenated original", () => {
    for (const row of MATRIX) {
      if (row.full === row.lead) {
        continue;
      }
      expect(restoreCollapsedGreetingContinuation(row.full, row.lead), row.id).toBe(row.lead);
    }
  });
});
