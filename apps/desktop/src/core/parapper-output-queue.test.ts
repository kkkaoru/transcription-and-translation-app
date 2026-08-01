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
});
