import { describe, expect, it, vi } from "vitest";
import { createParapperOutputQueue, type ParapperOutputQueueItem } from "./parapper-output-queue";

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
});
