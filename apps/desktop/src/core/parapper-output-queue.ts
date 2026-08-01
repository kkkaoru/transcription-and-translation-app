/**
 * Bounded queue for Parapper turn events.
 *
 * Parapper can emit interim revisions faster than the local AzooKey bridge can
 * normalize them. A plain Promise chain therefore creates an unbounded tail:
 * every stale partial waits in line before the final turn is displayed. Keep
 * at most one pending partial (latest wins), while retaining every final event
 * in arrival order. The currently running item is never cancelled, so a final
 * can only wait for one in-flight normalizer call.
 */

export type ParapperOutputQueueItem = {
  isFinal: boolean;
};

export type ParapperOutputQueueStats = {
  processed: number;
  droppedPartials: number;
  pending: number;
  inFlight: boolean;
};

export type ParapperOutputQueue<T extends ParapperOutputQueueItem> = {
  enqueue: (item: T) => void;
  /** Resolve once all accepted items have finished processing. */
  whenIdle: () => Promise<void>;
  /** Drop queued items and ignore future events for this capture attempt. */
  close: () => void;
  getStats: () => ParapperOutputQueueStats;
};

type Waiter = () => void;

export const createParapperOutputQueue = <T extends ParapperOutputQueueItem>(
  process: (item: T) => Promise<void> | void,
): ParapperOutputQueue<T> => {
  let pending: T[] = [];
  let inFlight = false;
  let closed = false;
  let processed = 0;
  let droppedPartials = 0;
  const idleWaiters: Waiter[] = [];

  const isIdle = (): boolean => !inFlight && pending.length === 0;

  const resolveIdle = (): void => {
    if (!isIdle()) {
      return;
    }
    while (idleWaiters.length > 0) {
      idleWaiters.shift()?.();
    }
  };

  const run = async (): Promise<void> => {
    if (inFlight || closed) {
      return;
    }
    inFlight = true;
    while (!closed && pending.length > 0) {
      const item = pending.shift();
      if (!item) {
        continue;
      }
      try {
        await process(item);
      } catch {
        // A per-event failure must not strand later finals or stop()'s drain.
      }
      processed += 1;
    }
    inFlight = false;
    resolveIdle();
  };

  return {
    enqueue: (item) => {
      if (closed) {
        return;
      }
      if (item.isFinal) {
        // Any partials waiting before this final are superseded by the final
        // turn text. Preserve previously queued finals for turn ordering.
        while (pending.length > 0 && !pending[pending.length - 1]?.isFinal) {
          pending.pop();
          droppedPartials += 1;
        }
        pending.push(item);
      } else if (pending.length > 0 && !pending[pending.length - 1]?.isFinal) {
        // Replace only the trailing partial. A queued final belongs to an
        // earlier turn and must remain ahead of this newer partial.
        pending[pending.length - 1] = item;
        droppedPartials += 1;
      } else {
        pending.push(item);
      }
      void run();
    },
    whenIdle: () => {
      if (isIdle()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    close: () => {
      closed = true;
      pending = [];
      resolveIdle();
    },
    getStats: () => ({
      processed,
      droppedPartials,
      pending: pending.length,
      inFlight,
    }),
  };
};
