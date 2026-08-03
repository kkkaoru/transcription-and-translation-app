import { describe, expect, it, vi } from "vitest";
import {
  createParapperOutputQueue,
  PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
  PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS,
  type ParapperOutputQueueItem,
} from "./parapper-output-queue";

type Item = ParapperOutputQueueItem & { id: string };

const item = (id: string, isFinal = false): Item => ({ id, isFinal });

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Parapper output coalescing queue", () => {
  it("keeps only the newest pending partial while one normalizer is running", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const process = vi.fn(
      (next: Item) =>
        new Promise<void>((resolve) => {
          started.push(next.id);
          release.push(resolve);
        }),
    );
    const queue = createParapperOutputQueue(process);

    queue.enqueue(item("partial-1"));
    await flush();
    queue.enqueue(item("partial-2"));
    queue.enqueue(item("partial-3"));
    queue.enqueue(item("partial-4"));
    expect(queue.getStats()).toMatchObject({ pending: 1, droppedPartials: 2, inFlight: true });
    expect(started).toEqual(["partial-1"]);

    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-1", "partial-4"]);
    expect(queue.getStats().droppedPartials).toBe(2);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 2, pending: 0, inFlight: false });
  });

  it("drops stale partials when a final arrives and processes every final in order", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });

    queue.enqueue(item("partial-active"));
    await flush();
    queue.enqueue(item("partial-stale"));
    queue.enqueue(item("final-1", true));
    queue.enqueue(item("partial-next"));
    queue.enqueue(item("final-2", true));
    expect(queue.getStats()).toMatchObject({ pending: 2, droppedPartials: 2 });

    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-active", "final-1"]);
    release.shift()?.();
    await flush();
    expect(started).toEqual(["partial-active", "final-1", "final-2"]);
    release.shift()?.();
    await queue.whenIdle();
    expect(queue.getStats()).toMatchObject({ processed: 3, pending: 0, inFlight: false });
  });

  it("drains accepted events after a processing failure and can be closed safely", async () => {
    const process = vi
      .fn<(next: Item) => Promise<void>>()
      .mockRejectedValueOnce(new Error("normalizer failed"))
      .mockResolvedValue(undefined);
    const queue = createParapperOutputQueue(process);
    queue.enqueue(item("partial"));
    queue.enqueue(item("final", true));
    await queue.whenIdle();
    expect(process).toHaveBeenCalledTimes(2);
    queue.close();
    queue.enqueue(item("ignored", true));
    await flush();
    expect(process).toHaveBeenCalledTimes(2);
    expect(queue.getStats()).toMatchObject({ pending: 0, inFlight: false });
  });

  it("close drops queued events from a paused session and ignores later arrivals", async () => {
    // stopCapture closes the queue while a normalization can still be in
    // flight with events waiting behind it. Those pending events belong to
    // the paused session: they must be dropped and accounted for, and later
    // outputs must not start processing. A resumed capture owns a fresh
    // queue, so nothing here may leak into it.
    const started: string[] = [];
    const release: Array<() => void> = [];
    const turn = (id: string, turnId: number, isFinal = false): Item => ({
      id,
      isFinal,
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId,
      revision: 0,
    });
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => {
        release.push(resolve);
      });
    });

    queue.enqueue(turn("in-flight-partial", 0));
    await flush();
    queue.enqueue(turn("pending-partial", 1));
    queue.enqueue(turn("pending-final", 2, true));
    expect(queue.getStats()).toMatchObject({ pending: 2, inFlight: true });

    queue.close();
    expect(queue.getStats()).toMatchObject({
      pending: 0,
      droppedPartials: 1,
      droppedFinals: 1,
    });

    // Outputs that arrive while paused are ignored outright.
    queue.enqueue(turn("after-close", 3, true));
    await flush();
    expect(started).toEqual(["in-flight-partial"]);

    // The in-flight normalization settles after close; no queued work may
    // start once the paused session has been torn down. close() abandons the
    // active result but cannot cancel the Promise, so drain after release.
    release.shift()?.();
    await queue.whenIdle();
    expect(started).toEqual(["in-flight-partial"]);
    expect(queue.getStats().pending).toBe(0);
  });

  it("drops a late partial after the same-turn final, even when both share a revision", async () => {
    const processed: string[] = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      processed.push(next.id);
    });
    const base = {
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 8,
      revision: 2,
      segmentId: 11,
    };

    queue.enqueue({ id: "partial", isFinal: false, outputSequence: 10, ...base });
    queue.enqueue({ id: "final", isFinal: true, outputSequence: 11, ...base });
    queue.enqueue({ id: "late-partial", isFinal: false, outputSequence: 10, ...base });
    await queue.whenIdle();

    expect(processed).toEqual(["partial", "final"]);
    expect(queue.getStats()).toMatchObject({ droppedPartials: 1, droppedFinals: 0 });
  });

  it("does not let an older final remove a newer turn's pending partial", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const queue = createParapperOutputQueue<Item>((next) => {
      started.push(next.id);
      return new Promise<void>((resolve) => release.push(resolve));
    });
    queue.enqueue({
      id: "turn-1-partial",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 1,
      revision: 1,
      outputSequence: 1,
    });
    await flush();
    queue.enqueue({
      id: "turn-2-partial",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 2,
      revision: 0,
      outputSequence: 2,
    });
    queue.enqueue({
      id: "turn-1-final",
      isFinal: true,
      sessionId: "socket-1",
      turnSessionId: 4,
      turnId: 1,
      revision: 1,
      outputSequence: 3,
    });
    release.shift()?.();
    await flush();

    expect(started).toEqual(["turn-1-partial", "turn-2-partial"]);
    release.shift()?.();
    await flush();
    expect(started).toEqual(["turn-1-partial", "turn-2-partial", "turn-1-final"]);
    release.shift()?.();
    await queue.whenIdle();
  });

  it("bounds queued finals and cursor tracking while normalization is blocked", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createParapperOutputQueue<Item>(() => blocked);
    queue.enqueue({
      id: "active",
      isFinal: false,
      sessionId: "socket-1",
      turnSessionId: 1,
      turnId: 0,
      revision: 0,
    });
    await flush();
    const finalCount = PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS + 8;
    for (let turnId = 1; turnId <= finalCount; turnId += 1) {
      queue.enqueue({
        id: `final-${turnId}`,
        isFinal: true,
        sessionId: "socket-1",
        turnSessionId: 1,
        turnId,
        revision: 1,
      });
    }

    expect(queue.getStats()).toMatchObject({
      pending: PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
      droppedFinals: finalCount - PARAPPER_OUTPUT_QUEUE_MAX_PENDING,
      trackedTurns: PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS,
    });
    release();
    queue.close();
  });

  it("settles whenIdle after its finite timeout when a normalizer never returns", async () => {
    vi.useFakeTimers();
    const queue = createParapperOutputQueue<Item>(() => new Promise<void>(() => undefined));
    queue.enqueue(item("stuck"));
    const idle = queue.whenIdle(25);
    vi.advanceTimersByTime(25);
    await expect(idle).rejects.toThrow(/did not become idle/i);
    queue.close();
  });
});
