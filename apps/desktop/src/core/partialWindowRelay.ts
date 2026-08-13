import type { PartialWindowCaption } from "./types";

/**
 * Last accepted partial-window identity in one renderer.  This fence is
 * deliberately independent from caption freshness/merge state: an OPEN
 * segment suffix may be cleared while the committed caption remains visible.
 */
export type PartialWindowRelayFence = Pick<
  PartialWindowCaption,
  | "captureGeneration"
  | "outputSequence"
  | "relaySequence"
  | "revision"
  | "segmentId"
  | "sessionId"
  | "turnSessionId"
  | "turnId"
>;

export const partialWindowRelayFence = (
  caption: PartialWindowCaption,
): PartialWindowRelayFence => ({
  captureGeneration: caption.captureGeneration,
  outputSequence: caption.outputSequence,
  relaySequence: caption.relaySequence,
  revision: caption.revision,
  segmentId: caption.segmentId,
  sessionId: caption.sessionId,
  turnSessionId: caption.turnSessionId,
  turnId: caption.turnId,
});

const generationOf = (caption: Pick<PartialWindowCaption, "captureGeneration">): number =>
  caption.captureGeneration ?? -1;

/**
 * Accept only an advancing Main relay sequence, then independently reject a
 * stale capture/session/segment result should a delayed native invoke survive
 * a renderer restart.  Empty text is a real clear event, so it deliberately
 * advances the fence without requiring a newer sidecar revision.
 */
export const shouldApplyPartialWindowRelay = (
  previous: PartialWindowRelayFence | null,
  next: PartialWindowCaption,
): boolean => {
  if (!previous) {
    return true;
  }
  if (next.relaySequence <= previous.relaySequence) {
    return false;
  }
  const nextGeneration = generationOf(next);
  const previousGeneration = generationOf(previous);
  if (nextGeneration < previousGeneration) {
    return false;
  }
  if (nextGeneration > previousGeneration) {
    return true;
  }
  if (next.sessionId !== previous.sessionId) {
    return false;
  }
  if (!next.text.trim()) {
    return true;
  }
  if (next.turnSessionId !== previous.turnSessionId || next.turnId !== previous.turnId) {
    return false;
  }
  if (next.segmentId < previous.segmentId) {
    return false;
  }
  if (next.segmentId === previous.segmentId) {
    if (next.revision < previous.revision) {
      return false;
    }
    if (next.revision === previous.revision && next.outputSequence <= previous.outputSequence) {
      return false;
    }
  }
  return true;
};
