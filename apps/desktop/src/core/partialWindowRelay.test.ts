import { describe, expect, it } from "vitest";
import {
  type PartialWindowRelayFence,
  partialWindowRelayFence,
  shouldApplyPartialWindowRelay,
} from "./partialWindowRelay";
import type { PartialWindowCaption } from "./types";

const update = (overrides: Partial<PartialWindowCaption> = {}): PartialWindowCaption => ({
  captureGeneration: 4,
  outputSequence: 9,
  relaySequence: 1,
  revision: 3,
  segmentId: 7,
  sessionId: "capture-4",
  text: "OPEN suffix",
  turnId: 11,
  turnSessionId: 10,
  ...overrides,
});

const apply = (
  state: { fence: PartialWindowRelayFence | null; text: string },
  next: PartialWindowCaption,
): void => {
  if (!shouldApplyPartialWindowRelay(state.fence, next)) {
    return;
  }
  state.fence = partialWindowRelayFence(next);
  state.text = next.text;
};

describe("partial-window relay fence", () => {
  it("keeps the slot empty when a delayed set arrives after its clear", () => {
    const state = { fence: null as PartialWindowRelayFence | null, text: "" };
    const set = update({ relaySequence: 41 });
    const clear = update({ relaySequence: 42, text: "" });

    apply(state, set);
    apply(state, clear);
    apply(state, set); // delayed completion of the older async invoke

    expect(state.text).toBe("");
    expect(state.fence?.relaySequence).toBe(42);
  });

  it("cannot paint a prior capture or session after a capture restart", () => {
    const state = { fence: null as PartialWindowRelayFence | null, text: "" };
    apply(state, update({ captureGeneration: 4, relaySequence: 50, sessionId: "capture-4" }));
    apply(
      state,
      update({
        captureGeneration: 5,
        outputSequence: 1,
        relaySequence: 51,
        revision: 1,
        segmentId: 1,
        sessionId: "capture-5",
        text: "new capture",
        turnId: 1,
        turnSessionId: 1,
      }),
    );
    apply(state, update({ captureGeneration: 4, relaySequence: 52, text: "late old capture" }));
    apply(state, update({ captureGeneration: 5, relaySequence: 53, sessionId: "wrong-session" }));

    expect(state.text).toBe("new capture");
    expect(state.fence).toMatchObject({ captureGeneration: 5, sessionId: "capture-5" });
  });

  it("rejects an older OPEN segment revision or output sequence", () => {
    const state = { fence: null as PartialWindowRelayFence | null, text: "" };
    apply(state, update({ outputSequence: 12, relaySequence: 60, revision: 4 }));
    apply(
      state,
      update({ outputSequence: 13, relaySequence: 61, revision: 3, text: "old revision" }),
    );
    apply(state, update({ outputSequence: 12, relaySequence: 62, revision: 4, text: "duplicate" }));

    expect(state.text).toBe("OPEN suffix");
    expect(state.fence).toMatchObject({ outputSequence: 12, revision: 4, segmentId: 7 });
  });
});
