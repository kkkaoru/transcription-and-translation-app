import type { CaptionPayload } from "./types";

const MAX_TRANSLATION_DISPOSITIONS = 32;

export type CaptionTranslationDisposition = {
  at: number;
  decisionSource: "merge" | "display";
  captionId: string;
  reason: string;
  incomingTranslationChars: number;
  outputTranslationChars: number;
  incomingTranslationPreserved: boolean;
  currentSourceChars: number;
  incomingSourceChars: number;
  sourceMatched: boolean;
  sourceEquivalentIgnoringPunctuation: boolean;
  readingMatched: boolean;
};

const dispositions: CaptionTranslationDisposition[] = [];

const pushDisposition = (entry: CaptionTranslationDisposition): void => {
  dispositions.push(entry);
  if (dispositions.length > MAX_TRANSLATION_DISPOSITIONS) {
    dispositions.splice(0, dispositions.length - MAX_TRANSLATION_DISPOSITIONS);
  }
};

const normalizedReading = (caption: CaptionPayload): string => {
  if (typeof caption.azookeyInputText !== "string") {
    return "";
  }
  return [...caption.azookeyInputText.normalize("NFKC").trim()]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x30a1 && codePoint <= 0x30f6
        ? String.fromCodePoint(codePoint - 0x60)
        : character;
    })
    .join("");
};

/**
 * Retain every translation merge decision independently of log level and capture lifecycle.
 * Keeping positive and negative decisions means diagnostics never infer a drop from absence.
 */
export const recordCaptionTranslationDisposition = (
  current: CaptionPayload,
  incoming: CaptionPayload,
  output: CaptionPayload | null,
  reason: string,
): void => {
  const incomingTranslation = incoming.translationText.trim();
  if (!incomingTranslation) {
    return;
  }
  const currentReading = normalizedReading(current);
  const incomingReading = normalizedReading(incoming);
  const currentSourceIdentity = current.sourceText.normalize("NFKC").replace(/[\p{P}\p{Z}]/gu, "");
  const incomingSourceIdentity = incoming.sourceText
    .normalize("NFKC")
    .replace(/[\p{P}\p{Z}]/gu, "");
  pushDisposition({
    at: Date.now(),
    decisionSource: "merge",
    captionId: incoming.id,
    reason,
    incomingTranslationChars: [...incomingTranslation].length,
    outputTranslationChars: output ? [...output.translationText.trim()].length : 0,
    incomingTranslationPreserved: output?.translationText.trim() === incomingTranslation,
    currentSourceChars: [...current.sourceText.trim()].length,
    incomingSourceChars: [...incoming.sourceText.trim()].length,
    sourceMatched: current.sourceText.trim() === incoming.sourceText.trim(),
    sourceEquivalentIgnoringPunctuation: Boolean(
      currentSourceIdentity &&
        incomingSourceIdentity &&
        currentSourceIdentity === incomingSourceIdentity,
    ),
    readingMatched: Boolean(
      currentReading && incomingReading && currentReading === incomingReading,
    ),
  });
};

/** Record the display gate after a translation has already survived merge. */
export const recordCaptionTranslationDisplayDisposition = (
  caption: CaptionPayload,
  outputTranslationText: string,
  reason: "displayed" | "prediction-only-plate" | "no-displayable-translation",
): void => {
  const incomingTranslation = caption.translationText.trim();
  if (!incomingTranslation) {
    return;
  }
  const incomingTranslationChars = [...incomingTranslation].length;
  const outputTranslationChars = [...outputTranslationText.trim()].length;
  const sourceChars = [...caption.sourceText.trim()].length;
  const duplicate = dispositions.some(
    (entry) =>
      entry.decisionSource === "display" &&
      entry.captionId === caption.id &&
      entry.reason === reason &&
      entry.incomingTranslationChars === incomingTranslationChars &&
      entry.outputTranslationChars === outputTranslationChars &&
      entry.currentSourceChars === sourceChars,
  );
  if (duplicate) {
    return;
  }
  pushDisposition({
    at: Date.now(),
    decisionSource: "display",
    captionId: caption.id,
    reason,
    incomingTranslationChars,
    outputTranslationChars,
    incomingTranslationPreserved: outputTranslationText.trim() === incomingTranslation,
    currentSourceChars: sourceChars,
    incomingSourceChars: sourceChars,
    sourceMatched: true,
    sourceEquivalentIgnoringPunctuation: true,
    readingMatched: true,
  });
};

export const snapshotCaptionTranslationDispositions = (): CaptionTranslationDisposition[] =>
  dispositions.map((entry) => ({ ...entry }));

/** Test-only reset; production capture stop intentionally never calls this. */
export const clearCaptionTranslationDispositions = (): void => {
  dispositions.length = 0;
};
