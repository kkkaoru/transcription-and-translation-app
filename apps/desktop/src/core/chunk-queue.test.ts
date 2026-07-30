import { describe, expect, it, vi } from "vitest";
import {
  clearChunkTimingStats,
  createLatestWinsProcessor,
  getChunkTimingStats,
  setChunkTimingStats,
} from "./chunkQueue";

describe("latest-wins chunk processor", () => {
  it("runs a single item and records pipeline latency", async () => {
    let clock = 1_000;
    const processed: number[] = [];
    const processor = createLatestWinsProcessor<number>({
      now: () => clock,
      process: async (item) => {
        processed.push(item);
        clock += 40;
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
});
