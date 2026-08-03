import { describe, expect, it, vi } from "vitest";
import { mergeCaptionPayload } from "./caption-updates";
import {
  type ChunkProcessContext,
  clearChunkTimingStats,
  createLatestWinsProcessor,
  getChunkTimingStats,
  setChunkTimingStats,
} from "./chunkQueue";
import { clearCaptionDisplayTiming, markCaptionDisplay } from "./display-timing";
import type { CaptionPayload } from "./types";

describe("latest-wins chunk processor", () => {
  it("runs a single item and records pipeline latency", async () => {
    let clock = 1_000;
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      now: () => clock,
      process: (item) => {
        processed.push(item);
        clock += 40;
        return Promise.resolve();
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });

    const stats = processor.getStats();
    expect(stats.chunksProcessed).toBe(1);
    expect(stats.chunksDropped).toBe(0);
    expect(stats.lastPipelineMs).toBe(40);
    expect(stats.hasPending).toBe(false);
    // An already-idle processor resolves immediately (stopCapture uses this
    // path when no partial tail was queued).
    await processor.whenIdle();
  });

  it("drains a stop-time tail before the active attempt is reset", async () => {
    let active = true;
    const processed: string[] = [];
    const processor = createLatestWinsProcessor<string>({
      isActive: () => active,
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    processor.enqueue("full-window");
    await processor.whenIdle();

    // This mirrors MicrophoneCapture.stop(): enqueue the owned partial tail
    // while the capture attempt is still active, then await queue idle before
    // invalidating/resetting the processor.
    processor.enqueue("partial-tail");
    await processor.whenIdle();
    expect(processed).toEqual(["full-window", "partial-tail"]);

    active = false;
    processor.reset();
    expect(processor.getStats().inFlight).toBe(false);
  });

  it("keeps only the newest pending chunk while one is in flight", async () => {
    const processed: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered = false;

    const processor = createLatestWinsProcessor<number>({
      process: async (item) => {
        processed.push(item);
        if (!firstEntered) {
          firstEntered = true;
          await gate;
        }
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    expect(processor.getStats().inFlight).toBe(true);

    // While 1 is in flight, 2 then 3 arrive — only 3 should remain pending.
    processor.enqueue(2);
    processor.enqueue(3);
    expect(processor.getStats().hasPending).toBe(true);
    expect(processor.getStats().chunksDropped).toBe(1);

    release();
    await vi.waitFor(() => {
      expect(processed).toEqual([1, 3]);
    });
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
    expect(processor.getStats().chunksProcessed).toBe(2);
    expect(processor.getStats().hasPending).toBe(false);
  });

  it("resolves whenIdle only after the newest pending chunk has settled", async () => {
    const processed: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const processor = createLatestWinsProcessor<number>({
      process: async (item) => {
        processed.push(item);
        if (item === 1) {
          await firstGate;
        }
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processed).toEqual([1]));
    processor.enqueue(2);
    const idle = processor.whenIdle();
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseFirst();
    await idle;
    expect(processed).toEqual([1, 2]);
    expect(processor.getStats()).toMatchObject({ inFlight: false, hasPending: false });
  });

  it("does not start ASR for a second chunk until the first invoke finishes", async () => {
    // Still serial ASR (1 in-flight) — progressive translation is off the critical path
    // in the backend, but we never run unbounded concurrent recognize_source calls.
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      process: async (item) => {
        log.push(`start:${item}`);
        if (item === 0) {
          await gate;
        }
        log.push(`end:${item}`);
      },
    });

    processor.enqueue(0);
    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(log).toEqual(["start:0"]);
    });
    expect(log).not.toContain("start:1");

    release();
    await vi.waitFor(() => {
      expect(log).toEqual(["start:0", "end:0", "start:1", "end:1"]);
    });
  });

  it("records progressive first-caption latency via markFirstCaption", async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      now: () => clock,
      process: async () => {
        await gate;
        clock += 10;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(true);
    });
    clock = 25;
    processor.markFirstCaption();
    expect(processor.getStats().lastFirstCaptionMs).toBe(25);

    release();
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
    expect(processor.getStats().lastFirstCaptionMs).toBe(25);
    expect(processor.getStats().lastPipelineMs).toBe(35);
  });

  it("releases the queue on normalized source so a newer chunk is not blocked by translation", async () => {
    // Mirrors MainApp: process races whenFirstCaption() against a long invoke.
    // After normalized source paints, process returns and the next pending chunk
    // may start even while the previous invoke is still translating.
    const log: string[] = [];
    let releaseSlowInvoke!: () => void;
    const slowInvoke = new Promise<void>((resolve) => {
      releaseSlowInvoke = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      process: async (item, { whenFirstCaption }) => {
        log.push(`start:${item}`);
        if (item === 1) {
          const invoke = slowInvoke.then(() => {
            log.push(`invoke-done:${item}`);
          });
          void invoke;
          await Promise.race([whenFirstCaption(), invoke]);
          log.push(`process-return:${item}`);
          return;
        }
        log.push(`process-return:${item}`);
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(log).toEqual(["start:1"]);
    });
    expect(processor.getStats().inFlight).toBe(true);

    // Normalized source paint arrives before the slow translation completes.
    processor.markFirstCaption();
    await vi.waitFor(() => {
      expect(log).toContain("process-return:1");
    });
    expect(processor.getStats().inFlight).toBe(false);
    expect(log).not.toContain("invoke-done:1");

    // A newer chunk must start immediately — not wait for the slow invoke.
    processor.enqueue(2);
    await vi.waitFor(() => {
      expect(log).toContain("start:2");
    });
    expect(log.indexOf("start:2")).toBeLessThan(
      log.indexOf("invoke-done:1") === -1 ? 999 : log.indexOf("invoke-done:1"),
    );
    expect(log).toEqual(["start:1", "process-return:1", "start:2", "process-return:2"]);

    releaseSlowInvoke();
    await vi.waitFor(() => {
      expect(log).toContain("invoke-done:1");
    });
  });

  it("invalidates isCurrent for a prior flight once a newer flight starts", async () => {
    const currency: Array<{ item: number; current: boolean }> = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let flight1Context!: { isCurrent: () => boolean };

    const processor = createLatestWinsProcessor<number>({
      process: async (item, context) => {
        if (item === 1) {
          flight1Context = context;
          const invoke = slow.then(() => {
            currency.push({ item, current: context.isCurrent() });
          });
          void invoke;
          await Promise.race([context.whenFirstCaption(), invoke]);
          return;
        }
        currency.push({ item, current: context.isCurrent() });
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));
    processor.markFirstCaption();
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));

    processor.enqueue(2);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(currency).toEqual([{ item: 2, current: true }]);

    releaseSlow();
    await vi.waitFor(() => expect(currency).toHaveLength(2));
    expect(currency[1]).toEqual({ item: 1, current: false });
    expect(flight1Context.isCurrent()).toBe(false);
  });

  it("reset clears backlog and ignores in-flight completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      process: async (item) => {
        processed.push(item);
        await gate;
      },
    });

    processor.enqueue(1);
    processor.enqueue(2);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    processor.reset();
    expect(processor.getStats().chunksProcessed).toBe(0);
    expect(processor.getStats().hasPending).toBe(false);
    expect(processor.getStats().inFlight).toBe(false);

    release();
    await Promise.resolve();
    // In-flight work finished after reset must not revive queue state.
    expect(processor.getStats().chunksProcessed).toBe(0);
    expect(processed).toEqual([1]);
  });

  it("resolves an idle waiter when reset invalidates an in-flight flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = createLatestWinsProcessor<number>({
      process: async () => {
        await gate;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));
    const idle = processor.whenIdle();
    processor.reset();
    await idle;
    release();
    expect(processor.getStats().inFlight).toBe(false);
  });

  it("does not let asynchronous timing telemetry wedge the queue", async () => {
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      onStatsChange: () => Promise.resolve(),
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processed).toEqual([1]));
    await processor.whenIdle();
    expect(processor.getStats().chunksProcessed).toBe(1);
  });

  it("recovers after a synchronous process throw and runs the next chunk", async () => {
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      process: (item) => {
        processed.push(item);
        if (item === 1) {
          throw new Error("sync failure");
        }
        return Promise.resolve();
      },
    });

    // A callback is allowed to throw before returning its Promise. That must be
    // treated like a rejected flight rather than escaping enqueue() and wedging
    // the queue inFlight forever.
    expect(() => processor.enqueue(1)).not.toThrow();
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    processor.enqueue(2);
    await vi.waitFor(() => expect(processed).toEqual([1, 2]));
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(processor.getStats().chunksProcessed).toBe(2);
  });

  it("keeps pumping when stats telemetry throws", async () => {
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      onStatsChange: () => {
        throw new Error("telemetry unavailable");
      },
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    expect(() => processor.enqueue(1)).not.toThrow();
    await vi.waitFor(() => expect(processed).toEqual([1]));
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(processor.getStats().chunksProcessed).toBe(1);
  });

  it("allows a null-valued item when the queue type includes null", async () => {
    const processed: Array<number | null> = [];
    const processor = createLatestWinsProcessor<number | null>({
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    processor.enqueue(null);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(processed).toEqual([null]);
  });

  it("shares timing stats for the Debug panel snapshot", () => {
    clearChunkTimingStats();
    expect(getChunkTimingStats().lastPipelineMs).toBeNull();
    setChunkTimingStats({
      lastPipelineMs: 120,
      lastFirstCaptionMs: 45,
      chunksProcessed: 3,
      chunksDropped: 1,
      inFlight: false,
      hasPending: false,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(getChunkTimingStats()).toMatchObject({
      lastPipelineMs: 120,
      lastFirstCaptionMs: 45,
      chunksDropped: 1,
    });
    clearChunkTimingStats();
    expect(getChunkTimingStats().chunksProcessed).toBe(0);
  });

  it("enqueue ignores items when isActive returns false", async () => {
    let active = false;
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      isActive: () => active,
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    processor.enqueue(1);
    await Promise.resolve();
    expect(processed).toHaveLength(0);
    expect(processor.getStats().hasPending).toBe(false);

    active = true;
    processor.enqueue(2);
    await vi.waitFor(() => expect(processed).toEqual([2]));
  });

  it("drops a pending chunk when capture pauses mid-flight and resumes cleanly", async () => {
    // Pause/resume maps to the stopCapture/startCapture lifecycle: isActive
    // flips false while a flight is still running, and the chunk waiting
    // behind it must be dropped instead of transcribed. Chunks arriving
    // during the pause are silently ignored, and a resumed capture processes
    // new chunks again.
    let active = true;
    const processed: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered = false;
    const processor = createLatestWinsProcessor<number>({
      isActive: () => active,
      process: async (item) => {
        processed.push(item);
        if (!firstEntered) {
          firstEntered = true;
          await gate;
        }
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    processor.enqueue(2);
    expect(processor.getStats().hasPending).toBe(true);

    // The user pauses while chunk 1 is still in flight: the pending chunk 2
    // must never reach ASR when the flight completes.
    active = false;
    release();
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
    expect(processed).toEqual([1]);
    expect(processor.getStats()).toMatchObject({ chunksDropped: 1, hasPending: false });

    // Chunks arriving during the pause are dropped without counting.
    processor.enqueue(3);
    await Promise.resolve();
    expect(processed).toEqual([1]);
    expect(processor.getStats()).toMatchObject({ chunksDropped: 1, chunksProcessed: 1 });

    // Resume: new chunks are transcribed again.
    active = true;
    processor.enqueue(4);
    await vi.waitFor(() => {
      expect(processor.getStats()).toMatchObject({ chunksProcessed: 2, hasPending: false });
    });
    expect(processed).toEqual([1, 4]);
  });

  it("markFirstCaption ignores calls when not in flight", () => {
    const processor = createLatestWinsProcessor<number>({
      process: () => Promise.resolve(),
    });

    processor.markFirstCaption();
    expect(processor.getStats().lastFirstCaptionMs).toBeNull();
  });

  it("markFirstCaption ignores subsequent calls on the same flight", async () => {
    let clock = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      now: () => clock,
      process: async () => {
        await gate;
        clock += 30;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));
    clock = 10;
    processor.markFirstCaption();
    const firstCall = processor.getStats().lastFirstCaptionMs;
    expect(firstCall).toBe(10);

    clock = 20;
    processor.markFirstCaption();
    expect(processor.getStats().lastFirstCaptionMs).toBe(firstCall);

    release();
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(processor.getStats().lastFirstCaptionMs).toBe(firstCall);
  });

  it("handles whenFirstCaption when no longer current due to reset", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let capturedContext!: ChunkProcessContext;

    const processor = createLatestWinsProcessor<number>({
      process: async (_item, context) => {
        capturedContext = context;
        await gate;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));

    processor.reset();
    release();

    const promise = capturedContext.whenFirstCaption();
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolveFirstCaptionWaiters clears pending waiters on concurrent reset", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitCalls: boolean[] = [];

    const processor = createLatestWinsProcessor<number>({
      process: async (_item, { whenFirstCaption }) => {
        const promise = whenFirstCaption();
        void promise.then(() => waitCalls.push(true));
        await gate;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(true));

    processor.reset();
    release();

    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(waitCalls).toHaveLength(1);
  });
});

/**
 * These tests replay the real MainApp wiring end to end (LatestWinsProcessor →
 * mergeCaptionPayload → markCaptionDisplay) instead of exercising chunkQueue.ts
 * in isolation. That is the actual "critical path" a recognized utterance
 * travels before it is visible: process() mirrors `transcribe_audio_chunk`
 * (resolves once ASR+normalize/source text is ready), and a translation event
 * mirrors the backend's independently-spawned `caption:update` that arrives
 * later and is merged in place without blocking the source paint.
 */
describe("progressive caption paint (critical path: enqueue → source paint → translate)", () => {
  const basePayload = (overrides: Partial<CaptionPayload> = {}): CaptionPayload => ({
    id: "seed",
    sourceText: "",
    translationText: "",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: 0,
    receivedAt: 0,
    stage: "source",
    sequence: 0,
    isFinal: false,
    confidence: undefined,
    ...overrides,
  });

  it("waits for normalized source before painting and before translation resolves", async () => {
    let painted: CaptionPayload = basePayload();
    const paints: CaptionPayload[] = [];
    const applyCaption = (incoming: CaptionPayload) => {
      const merged = mergeCaptionPayload(painted, incoming);
      if (merged && merged !== painted) {
        painted = merged;
        paints.push(merged);
      }
    };

    let releaseNormalize!: () => void;
    const normalizeGate = new Promise<void>((resolve) => {
      releaseNormalize = resolve;
    });
    let releaseTranslate!: () => void;
    const translateGate = new Promise<void>((resolve) => {
      releaseTranslate = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      process: async (_item, { whenFirstCaption }) => {
        // Raw ASR remains a debug-only stage result; the source paint waits for
        // the normalizer to complete.
        void normalizeGate.then(() => {
          applyCaption(
            basePayload({ id: "u-1", startedAt: 1, sourceText: "今日は", stage: "source" }),
          );
        });
        // Translation is a separate off-path event; never awaited for source UI.
        void translateGate.then(() => {
          applyCaption(
            basePayload({
              id: "u-1",
              startedAt: 1,
              sourceText: "今日は",
              translationText: "Good afternoon",
              stage: "translation",
              sequence: 1,
              isFinal: true,
            }),
          );
        });
        // MainApp races first caption vs full invoke — release as soon as the
        // normalized source paints.
        await whenFirstCaption();
      },
    });

    processor.enqueue(1);
    // Provisional ASR must not be visible before normalize resolves.
    expect(paints).toHaveLength(0);
    expect(painted.sourceText).toBe("");
    expect(painted.translationText).toBe("");

    releaseNormalize();
    await vi.waitFor(() => expect(painted.sourceText).toBe("今日は"));
    processor.markFirstCaption();
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    // Only normalized source is visible; translation remains gated.
    expect(paints).toHaveLength(1);
    expect(painted.sourceText).toBe("今日は");
    expect(painted.translationText).toBe("");

    releaseTranslate();
    await vi.waitFor(() => expect(paints).toHaveLength(2));
    expect(painted.translationText).toBe("Good afternoon");
  });

  it("does not let a slow translation for an older utterance stall a newer chunk's source paint", async () => {
    let painted: CaptionPayload = basePayload();
    const paints: CaptionPayload[] = [];
    const applyCaption = (incoming: CaptionPayload) => {
      const merged = mergeCaptionPayload(painted, incoming);
      if (merged && merged !== painted) {
        painted = merged;
        paints.push(merged);
      }
    };

    let releaseSlowTranslate!: () => void;
    const slowTranslateGate = new Promise<void>((resolve) => {
      releaseSlowTranslate = resolve;
    });

    const processor = createLatestWinsProcessor<{ id: string; startedAt: number; text: string }>({
      // Not `async`: a slow translation for u-1 must not delay u-2's source paint.
      process: (chunk) => {
        applyCaption(
          basePayload({
            id: chunk.id,
            startedAt: chunk.startedAt,
            sourceText: chunk.text,
            stage: "source",
          }),
        );
        if (chunk.id === "u-1") {
          // u-1's translation is slow and intentionally not awaited here — mirrors
          // the backend's fire-and-forget translate task.
          void slowTranslateGate.then(() => {
            applyCaption(
              basePayload({
                id: "u-1",
                startedAt: chunk.startedAt,
                sourceText: chunk.text,
                translationText: "slow translation",
                stage: "translation",
                sequence: 1,
                isFinal: true,
              }),
            );
          });
        }
        return Promise.resolve();
      },
    });

    processor.enqueue({ id: "u-1", startedAt: 1, text: "最初の文" });
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(painted.id).toBe("u-1");
    expect(painted.sourceText).toBe("最初の文");
    expect(painted.translationText).toBe("");

    // A newer chunk's normalized-source paint must complete without waiting on
    // u-1's still-pending (slow) translation.
    processor.enqueue({ id: "u-2", startedAt: 2, text: "次の文" });
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(painted.id).toBe("u-2");
    expect(painted.sourceText).toBe("次の文");

    // The older utterance's slow translation resolving afterward must not regress
    // the caption that is already on screen.
    releaseSlowTranslate();
    await Promise.resolve();
    await Promise.resolve();
    expect(painted.id).toBe("u-2");
    expect(painted.sourceText).toBe("次の文");
  });

  it("never schedules a timer to gate the first caption paint", () => {
    clearCaptionDisplayTiming();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      let painted: CaptionPayload | null = null;
      const processor = createLatestWinsProcessor<number>({
        // Not `async`: process() runs to completion synchronously, so any
        // timer scheduled here would be gating the very first paint.
        process: () => {
          const first = basePayload({ id: "u-1", startedAt: 1, sourceText: "遅延なし" });
          painted = first;
          markCaptionDisplay(first);
          return Promise.resolve();
        },
      });

      processor.enqueue(1);

      // No `await`, no fake-timer advance: process() already ran synchronously
      // to completion (it has no internal `await`) before enqueue() returned.
      // If first paint were gated behind a setTimeout/dwell timer instead of
      // painting on receipt, `painted` would still be null here.
      expect(painted).not.toBeNull();
      expect((painted as CaptionPayload | null)?.sourceText).toBe("遅延なし");
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      clearCaptionDisplayTiming();
    }
  });

  it("provisional ASR paint is upgraded to normalized source on same utterance id", async () => {
    // Tests requirement (a): provisional ASR text paints immediately and is
    // replaced in place when normalization lands.
    let painted: CaptionPayload = basePayload();
    const paints: CaptionPayload[] = [];
    const applyCaption = (incoming: CaptionPayload) => {
      const merged = mergeCaptionPayload(painted, incoming);
      if (merged && merged !== painted) {
        painted = merged;
        paints.push(merged);
        markCaptionDisplay(merged);
      }
    };

    let releaseNormalize!: () => void;
    const normalizeGate = new Promise<void>((resolve) => {
      releaseNormalize = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      process: async (_item, { whenFirstCaption }) => {
        // Provisional ASR (from frontend pipeline:stage listener, not awaited)
        applyCaption(
          basePayload({
            id: "u-1",
            startedAt: 1200, // ASR stage start time
            receivedAt: 1500, // ASR stage end time
            sourceText: "こんにちは",
            stage: "source",
            provisional: true,
          }),
        );
        // Real normalized source (from backend invoke result)
        void normalizeGate.then(() => {
          applyCaption(
            basePayload({
              id: "u-1",
              startedAt: 1000, // Pipeline/chunk start (earlier)
              receivedAt: 1600, // Normalize stage end
              sourceText: "こんにちは、元気ですか",
              stage: "source",
            }),
          );
          processor.markFirstCaption();
        });
        await whenFirstCaption();
      },
    });

    processor.enqueue(1);
    // Provisional should appear first
    expect(paints).toHaveLength(1);
    expect(paints[0]?.sourceText).toBe("こんにちは");
    expect(paints[0]?.provisional).toBe(true);

    // Normalized source replaces it (same id, no new caption entry)
    releaseNormalize();
    await vi.waitFor(() => expect(paints).toHaveLength(2));
    expect(paints[1]?.sourceText).toBe("こんにちは、元気ですか");
    expect(paints[1]?.provisional).toBeUndefined();
    expect(paints[1]?.id).toBe("u-1");
  });

  it("provisional ASR for one utterance does not delay source paint of a newer utterance", async () => {
    // Tests requirement (b): when u-1 has a slow translation, a newer u-2's
    // normalized source must paint immediately without waiting for u-1's provisional
    // or translation to complete.
    let painted: CaptionPayload = basePayload();
    const paints: CaptionPayload[] = [];
    const applyCaption = (incoming: CaptionPayload) => {
      const merged = mergeCaptionPayload(painted, incoming);
      if (merged && merged !== painted) {
        painted = merged;
        paints.push(merged);
        markCaptionDisplay(merged);
      }
    };

    let releaseTranslate!: () => void;
    const translateGate = new Promise<void>((resolve) => {
      releaseTranslate = resolve;
    });

    const processor = createLatestWinsProcessor<{ id: string; text: string }>({
      // Not async: process() runs synchronously, painting source immediately.
      process: (chunk) => {
        applyCaption(
          basePayload({
            id: chunk.id,
            startedAt: chunk.id === "u-1" ? 1000 : 2000,
            sourceText: chunk.text,
            stage: "source",
          }),
        );
        if (chunk.id === "u-1") {
          // Intentionally slow translation for u-1, not awaited
          void translateGate.then(() => {
            applyCaption(
              basePayload({
                id: "u-1",
                startedAt: 1000,
                sourceText: chunk.text,
                translationText: "slow translation",
                stage: "translation",
                sequence: 1,
                isFinal: true,
              }),
            );
          });
        }
        return Promise.resolve();
      },
    });

    processor.enqueue({ id: "u-1", text: "最初" });
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(painted.id).toBe("u-1");
    expect(paints).toHaveLength(1);

    // Newer chunk's source must paint immediately, not blocked by u-1's slow translation
    processor.enqueue({ id: "u-2", text: "次の文" });
    await vi.waitFor(() => expect(processor.getStats().inFlight).toBe(false));
    expect(painted.id).toBe("u-2");
    expect(painted.sourceText).toBe("次の文");
    expect(paints).toHaveLength(2);

    // Resolve u-1's translation; it must not regress the on-screen caption
    releaseTranslate();
    await Promise.resolve();
    expect(painted.id).toBe("u-2");
    expect(paints).toHaveLength(2); // No additional paint
  });

  it("skips enqueue when isActive returns false", async () => {
    let isActive = false;
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      isActive: () => isActive,
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
    });

    processor.enqueue(1);
    expect(processed).toHaveLength(0);
    expect(processor.getStats().hasPending).toBe(false);

    isActive = true;
    processor.enqueue(2);
    await vi.waitFor(() => {
      expect(processed).toEqual([2]);
    });
  });

  it("markFirstCaption is a no-op when not in flight", () => {
    const processor = createLatestWinsProcessor<number>({
      process: () => Promise.resolve(),
    });

    const stats1 = processor.getStats();
    expect(stats1.inFlight).toBe(false);

    processor.markFirstCaption();

    const stats2 = processor.getStats();
    expect(stats2.lastFirstCaptionMs).toBeNull();
  });

  it("markFirstCaption is a no-op when already called", async () => {
    let releaseProcess!: () => void;
    const processGate = new Promise<void>((resolve) => {
      releaseProcess = resolve;
    });

    const processor = createLatestWinsProcessor<number>({
      process: async () => {
        await processGate;
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(true);
    });

    processor.markFirstCaption();
    const stats1 = processor.getStats();
    expect(stats1.lastFirstCaptionMs).not.toBeNull();
    const firstCaptionMs = stats1.lastFirstCaptionMs;

    processor.markFirstCaption();
    const stats2 = processor.getStats();
    expect(stats2.lastFirstCaptionMs).toBe(firstCaptionMs);

    releaseProcess();
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
  });

  it("recovers when onStatsChange throws", async () => {
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
      onStatsChange: () => {
        throw new Error("Stats callback error");
      },
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
    expect(processor.getStats().chunksProcessed).toBe(1);
  });

  it("recovers when onStatsChange returns a rejected promise", async () => {
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      process: (item) => {
        processed.push(item);
        return Promise.resolve();
      },
      onStatsChange: () => Promise.reject(new Error("Async error")),
    });

    processor.enqueue(1);
    await vi.waitFor(() => {
      expect(processed).toEqual([1]);
    });
    await vi.waitFor(() => {
      expect(processor.getStats().inFlight).toBe(false);
    });
    expect(processor.getStats().chunksProcessed).toBe(1);
  });
});
