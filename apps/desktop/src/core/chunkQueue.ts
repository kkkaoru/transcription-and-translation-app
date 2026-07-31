/**
 * Latest-wins audio chunk processor for live captions.
 *
 * Keeps at most one in-flight pipeline call and one pending chunk. When a newer
 * chunk arrives while work is in flight, the pending slot is replaced so stale
 * audio is dropped instead of forming an unbounded backlog behind slow ASR/MT.
 */

export type ChunkTimingStats = {
  /**
   * Wall time of the last completed live invoke (ASR + normalize only).
   * Translation runs off-path after the invoke returns and is not included.
   */
  lastPipelineMs: number | null;
  /** Wall time until the first caption event for the last in-flight chunk (progressive). */
  lastFirstCaptionMs: number | null;
  chunksProcessed: number;
  chunksDropped: number;
  /** True while a pipeline invoke is running. */
  inFlight: boolean;
  /** True when a newer chunk is waiting for the in-flight work to finish. */
  hasPending: boolean;
  updatedAt: string | null;
};

export type LatestWinsProcessorOptions<T> = {
  process: (item: T) => Promise<void>;
  /** Return false to skip dequeue after stop/cancel. Defaults to always active. */
  isActive?: () => boolean;
  now?: () => number;
  /** Invoked whenever internal timing/backlog stats change. */
  onStatsChange?: (stats: ChunkTimingStats) => void;
};

export type LatestWinsProcessor<T> = {
  enqueue: (item: T) => void;
  reset: () => void;
  getStats: () => ChunkTimingStats;
  /** Mark first progressive caption for the current in-flight item (TTFS). */
  markFirstCaption: () => void;
};

const emptyStats = (): ChunkTimingStats => ({
  lastPipelineMs: null,
  lastFirstCaptionMs: null,
  chunksProcessed: 0,
  chunksDropped: 0,
  inFlight: false,
  hasPending: false,
  updatedAt: null,
});

export const createLatestWinsProcessor = <T>(
  options: LatestWinsProcessorOptions<T>,
): LatestWinsProcessor<T> => {
  const now = options.now ?? (() => Date.now());
  let pending: T | null = null;
  let inFlight = false;
  let generation = 0;
  let startedAt = 0;
  let firstCaptionAt: number | null = null;
  let stats = emptyStats();

  const publish = (patch: Partial<ChunkTimingStats> = {}): void => {
    stats = {
      ...stats,
      ...patch,
      inFlight,
      hasPending: pending !== null,
      updatedAt: new Date().toISOString(),
    };
    options.onStatsChange?.({ ...stats });
  };

  const pump = (): void => {
    if (inFlight) {
      return;
    }
    if (options.isActive && !options.isActive()) {
      pending = null;
      publish();
      return;
    }
    const item = pending;
    pending = null;
    if (item === null) {
      publish();
      return;
    }

    inFlight = true;
    startedAt = now();
    firstCaptionAt = null;
    const runGeneration = generation;
    publish();

    void options
      .process(item)
      .catch(() => {
        // Errors are owned by the process callback (UI notices, etc.).
      })
      .finally(() => {
        if (runGeneration !== generation) {
          return;
        }
        const finishedAt = now();
        const pipelineMs = Math.max(0, Math.round(finishedAt - startedAt));
        const firstCaptionMs =
          firstCaptionAt == null ? null : Math.max(0, Math.round(firstCaptionAt - startedAt));
        inFlight = false;
        publish({
          lastPipelineMs: pipelineMs,
          lastFirstCaptionMs: firstCaptionMs,
          chunksProcessed: stats.chunksProcessed + 1,
        });
        pump();
      });
  };

  return {
    enqueue: (item: T) => {
      if (options.isActive && !options.isActive()) {
        return;
      }
      // Replace any waiting chunk so the queue never grows beyond 1 pending.
      if (pending !== null) {
        publish({ chunksDropped: stats.chunksDropped + 1 });
      }
      pending = item;
      publish();
      pump();
    },
    reset: () => {
      generation += 1;
      pending = null;
      inFlight = false;
      firstCaptionAt = null;
      startedAt = 0;
      stats = emptyStats();
    },
    getStats: () => ({ ...stats, inFlight, hasPending: pending !== null }),
    markFirstCaption: () => {
      if (!inFlight || firstCaptionAt != null) {
        return;
      }
      firstCaptionAt = now();
      publish({
        lastFirstCaptionMs: Math.max(0, Math.round(firstCaptionAt - startedAt)),
      });
    },
  };
};

let sharedTiming: ChunkTimingStats = emptyStats();

/** Snapshot used by DebugPanel without React coupling. */
export const getChunkTimingStats = (): ChunkTimingStats => ({ ...sharedTiming });

export const setChunkTimingStats = (next: ChunkTimingStats): void => {
  sharedTiming = { ...next };
};

export const clearChunkTimingStats = (): void => {
  sharedTiming = emptyStats();
};
