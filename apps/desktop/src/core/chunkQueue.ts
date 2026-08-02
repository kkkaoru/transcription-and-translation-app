/**
 * Latest-wins audio chunk processor for live captions.
 *
 * Keeps at most one *queued* pending chunk and one logical flight. When a newer
 * chunk arrives while work is in flight, the pending slot is replaced so stale
 * audio is dropped instead of forming an unbounded backlog behind slow ASR/MT.
 *
 * Progressive first paint: `process` may return as soon as `whenFirstCaption`
 * resolves (normalized source on screen). That releases the queue so a newer
 * chunk is not head-of-line blocked by translation still running for the
 * previous utterance.
 *
 * This queue only gates on the *normalized* source paint — it is deliberately
 * unaware of the even-earlier raw-ASR provisional paint. The caller (MainApp)
 * paints raw ASR text immediately from the `asr` pipeline-stage event, fully
 * outside this queue's flight/whenFirstCaption bookkeeping, so that earlier
 * paint cannot change when the next chunk is allowed to start and the
 * existing no-head-of-line-blocking guarantee below is unaffected. See
 * `caption-updates.ts` for how the provisional paint is upgraded in place
 * once the normalized source (this module's `markFirstCaption` trigger)
 * arrives.
 */

import { recordPipelineDrop } from "./dropDiagnostics";

export type ChunkTimingStats = {
  /**
   * Wall time until process() returned for the last flight.
   * With progressive paint this is typically time-to-first-caption after ASR +
   * normalization, not full translation. Silence / error paths that never paint
   * measure full invoke duration instead.
   */
  lastPipelineMs: number | null;
  /** Wall time until the first normalized source caption for the last chunk. */
  lastFirstCaptionMs: number | null;
  chunksProcessed: number;
  chunksDropped: number;
  /** True while a process() flight has not yet returned. */
  inFlight: boolean;
  /** True when a newer chunk is waiting for the in-flight work to finish. */
  hasPending: boolean;
  updatedAt: string | null;
};

/** Helpers passed into each process() flight. */
export type ChunkProcessContext = {
  /**
   * Resolves once `markFirstCaption()` is called for this flight (normalized
   * source paint). Never rejects. Safe to race against the backend invoke.
   */
  whenFirstCaption: () => Promise<void>;
  /** False after `reset()` invalidates this flight. */
  isCurrent: () => boolean;
};

export type LatestWinsProcessorOptions<T> = {
  process: (item: T, context: ChunkProcessContext) => Promise<void>;
  /** Return false to skip dequeue after stop/cancel. Defaults to always active. */
  isActive?: () => boolean;
  now?: () => number;
  /** Invoked whenever internal timing/backlog stats change. */
  onStatsChange?: (stats: ChunkTimingStats) => void;
};

export type LatestWinsProcessor<T> = {
  enqueue: (item: T) => void;
  /** Resolve after the current flight and pending newest item have settled. */
  whenIdle: () => Promise<void>;
  reset: () => void;
  getStats: () => ChunkTimingStats;
  /** Mark first normalized source caption for the current in-flight item (TTFS). */
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
  // Keep presence separate from the value so a caller can legitimately queue
  // `null` when T includes it (null is not our empty-slot sentinel).
  let hasPending = false;
  let inFlight = false;
  /** Bumped on reset(); invalidates all flights (stop capture). */
  let generation = 0;
  /**
   * Bumped at the start of every process flight. When normalized first-paint
   * releases the queue early, a newer flight increments this so the previous
   * invoke's late completion cannot markFirstCaption / claim isCurrent().
   */
  let flightSerial = 0;
  let startedAt = 0;
  let firstCaptionAt: number | null = null;
  let firstCaptionWaiters: Array<() => void> = [];
  let idleWaiters: Array<() => void> = [];
  let stats = emptyStats();

  const notifyStatsChange = (): void => {
    try {
      const result = options.onStatsChange?.({ ...stats });
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Timing telemetry must never make enqueue/pump throw or strand a flight.
    }
  };

  const publish = (patch: Partial<ChunkTimingStats> = {}): void => {
    stats = {
      ...stats,
      ...patch,
      inFlight,
      hasPending,
      updatedAt: new Date().toISOString(),
    };
    notifyStatsChange();
    if (!inFlight && !hasPending && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  };

  const resolveFirstCaptionWaiters = (): void => {
    if (firstCaptionWaiters.length === 0) {
      return;
    }
    const waiters = firstCaptionWaiters;
    firstCaptionWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  };

  const pump = (): void => {
    if (inFlight) {
      return;
    }
    if (options.isActive && !options.isActive()) {
      if (hasPending) {
        recordPipelineDrop("chunk-queue", 1, "inactive-pending");
        publish({ chunksDropped: stats.chunksDropped + 1 });
      }
      pending = null;
      hasPending = false;
      publish();
      return;
    }
    const runHasPending = hasPending;
    const item = pending;
    pending = null;
    hasPending = false;
    if (!runHasPending) {
      publish();
      return;
    }

    inFlight = true;
    startedAt = now();
    firstCaptionAt = null;
    firstCaptionWaiters = [];
    const runGeneration = generation;
    const runFlight = ++flightSerial;
    publish();

    const isThisFlight = (): boolean => runGeneration === generation && runFlight === flightSerial;

    const context: ChunkProcessContext = {
      whenFirstCaption: () => {
        if (!isThisFlight()) {
          return Promise.resolve();
        }
        if (firstCaptionAt != null) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          if (!isThisFlight() || firstCaptionAt != null) {
            resolve();
            return;
          }
          firstCaptionWaiters.push(resolve);
        });
      },
      isCurrent: isThisFlight,
    };

    let processPromise: Promise<void>;
    try {
      // Promise.resolve() normalizes a legacy callback that returns void while
      // the try/catch converts synchronous throws into a rejected flight.
      // Invoking the callback directly also preserves the queue's synchronous
      // first-paint behavior for callbacks that do not await anything.
      processPromise = Promise.resolve(options.process(item as T, context));
    } catch (error) {
      processPromise = Promise.reject(error);
    }

    void processPromise
      .catch(() => {
        // Errors are owned by the process callback (UI notices, etc.).
      })
      .finally(() => {
        // process() may return early on first caption while a background invoke
        // continues. Only the active flight may clear inFlight / pump the next.
        if (!isThisFlight()) {
          return;
        }
        const finishedAt = now();
        const pipelineMs = Math.max(0, Math.round(finishedAt - startedAt));
        const firstCaptionMs =
          firstCaptionAt == null ? null : Math.max(0, Math.round(firstCaptionAt - startedAt));
        inFlight = false;
        // Drop any stranded waiters so a late whenFirstCaption() cannot hang.
        resolveFirstCaptionWaiters();
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
      if (hasPending) {
        publish({ chunksDropped: stats.chunksDropped + 1 });
        recordPipelineDrop("chunk-queue", 1, "pending-replaced");
      }
      pending = item;
      hasPending = true;
      publish();
      pump();
    },
    whenIdle: () => {
      if (!inFlight && !hasPending) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    reset: () => {
      if (hasPending) {
        recordPipelineDrop("chunk-queue", 1, "reset-pending");
      }
      generation += 1;
      flightSerial += 1;
      pending = null;
      hasPending = false;
      inFlight = false;
      firstCaptionAt = null;
      startedAt = 0;
      resolveFirstCaptionWaiters();
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      stats = emptyStats();
      notifyStatsChange();
    },
    getStats: () => ({ ...stats, inFlight, hasPending }),
    markFirstCaption: () => {
      if (!inFlight || firstCaptionAt != null) {
        return;
      }
      firstCaptionAt = now();
      publish({
        lastFirstCaptionMs: Math.max(0, Math.round(firstCaptionAt - startedAt)),
      });
      resolveFirstCaptionWaiters();
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
