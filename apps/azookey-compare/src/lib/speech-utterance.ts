/**
 * Page-side dedupe for Web Speech → comparison rows.
 *
 * `onFinalText` / `onUtteranceFinal` already commit `isFinal` and stop/end
 * grace flushes. `onRecognitionEnded` may still carry leftover text; this
 * helper decides whether that snapshot still needs a row.
 */

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
