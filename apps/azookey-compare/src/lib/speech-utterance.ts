/**
 * Page-side Web Speech utterance flush.
 *
 * The recognition controller owns `onend` / `isFinal`. This helper only
 * decides whether leftover transcript still needs a comparison row after
 * those callbacks, so a stop without `isFinal` does not drop the utterance.
 */

/** Slightly longer than the controller's late-`isFinal` grace (100ms). */
export const SPEECH_END_FLUSH_MS = 120;

export const normalizeSpeechText = (value: string): string => value.replace(/\s+/gu, " ").trim();

export const pendingSpeechUtterance = (
  finalText: string,
  interimText: string,
  dispatchedSegments: readonly string[],
): string | undefined => {
  const dispatched = dispatchedSegments.map(normalizeSpeechText).filter(Boolean);
  const interim = normalizeSpeechText(interimText);
  if (interim && !dispatched.includes(interim)) {
    return interim;
  }
  const accumulated = normalizeSpeechText(finalText);
  if (!accumulated) {
    return undefined;
  }
  const already = dispatched.join(" ").trim();
  if (!already) {
    return accumulated;
  }
  if (accumulated === already) {
    return undefined;
  }
  if (accumulated.startsWith(already)) {
    const remainder = accumulated.slice(already.length).trim();
    return remainder || undefined;
  }
  const last = dispatched.at(-1) ?? "";
  if (last && (accumulated === last || accumulated.endsWith(last))) {
    return undefined;
  }
  return accumulated;
};

export const rememberDispatchedSpeech = (
  dispatchedSegments: readonly string[],
  text: string,
): string[] => {
  const normalized = normalizeSpeechText(text);
  if (!normalized || dispatchedSegments.map(normalizeSpeechText).includes(normalized)) {
    return [...dispatchedSegments];
  }
  return [...dispatchedSegments, normalized];
};
