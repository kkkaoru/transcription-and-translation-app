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
  /** Optional protocol cursor fields (legacy callers may omit them). */
  sessionId?: string;
  turnSessionId?: number;
  turnId?: number;
  revision?: number;
  outputSequence?: number;
  segmentId?: number;
};

export type ParapperOutputQueueStats = {
  processed: number;
  droppedPartials: number;
  droppedFinals: number;
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

type TurnIdentity = {
  sessionId?: string;
  turnSessionId?: number;
  turnId?: number;
};

const finite = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const hasTurnIdentity = (item: TurnIdentity): boolean =>
  typeof item.sessionId === "string" &&
  item.sessionId.trim().length > 0 &&
  finite(item.turnSessionId) !== null &&
  finite(item.turnId) !== null;

const turnKey = (item: ParapperOutputQueueItem): string | null => {
  if (!hasTurnIdentity(item)) {
    return null;
  }
  return JSON.stringify([item.sessionId, item.turnSessionId, item.turnId]);
};

const sameTurn = (left: ParapperOutputQueueItem, right: ParapperOutputQueueItem): boolean => {
  const leftKey = turnKey(left);
  return leftKey !== null && leftKey === turnKey(right);
};

const sameTurnOrLegacy = (
  left: ParapperOutputQueueItem,
  right: ParapperOutputQueueItem,
): boolean => {
  const leftKey = turnKey(left);
  const rightKey = turnKey(right);
  // Before cursor metadata was added, the queue's historical arrival-order
  // behavior treated all events as one stream. Preserve that fallback while
  // using strict identity whenever both producers provide it.
  return (leftKey === null && rightKey === null) || leftKey === rightKey;
};

/**
 * Compare two outputs from the same turn.  Revision is the semantic turn
 * cursor; output_sequence disambiguates a partial and its final emitted at the
 * same revision.  Segment is the final fallback for older producers that do
 * not expose output_sequence.
 */
export const compareParapperTurnCursor = (
  candidate: ParapperOutputQueueItem,
  current: ParapperOutputQueueItem,
): number => {
  for (const [candidateValue, currentValue] of [
    [finite(candidate.revision), finite(current.revision)],
    [finite(candidate.outputSequence), finite(current.outputSequence)],
    [finite(candidate.segmentId), finite(current.segmentId)],
  ] as const) {
    if (candidateValue === null || currentValue === null || candidateValue === currentValue) {
      continue;
    }
    return candidateValue > currentValue ? 1 : -1;
  }
  if (candidate.isFinal !== current.isFinal) {
    return candidate.isFinal ? 1 : -1;
  }
  return 0;
};

const shouldDropForCursor = (
  candidate: ParapperOutputQueueItem,
  current: ParapperOutputQueueItem,
): boolean => {
  if (!sameTurn(candidate, current)) {
    return false;
  }
  // A final closes the turn; a late partial can never reopen it.
  if (current.isFinal && !candidate.isFinal) {
    return true;
  }
  const order = compareParapperTurnCursor(candidate, current);
  // Equal-cursor duplicate finals/partials are idempotent.  A final at the
  // same cursor is the one intentional upgrade over an interim.
  return order < 0 || (order === 0 && candidate.isFinal === current.isFinal);
};

export const createParapperOutputQueue = <T extends ParapperOutputQueueItem>(
  process: (item: T) => Promise<void> | void,
): ParapperOutputQueue<T> => {
  let pending: T[] = [];
  let inFlight = false;
  let closed = false;
  let processed = 0;
  let droppedPartials = 0;
  let droppedFinals = 0;
  const latestByTurn = new Map<string, T>();
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
      const key = turnKey(item);
      if (key !== null) {
        const current = latestByTurn.get(key);
        if (current && shouldDropForCursor(item, current)) {
          if (item.isFinal) {
            droppedFinals += 1;
          } else {
            droppedPartials += 1;
          }
          return;
        }
        latestByTurn.set(key, item);
      }
      if (item.isFinal) {
        // Partials waiting for this same turn are superseded by its final.
        // Keep a newer turn's partial intact even if transport delivery is
        // briefly interleaved.
        while (
          pending.length > 0 &&
          !pending[pending.length - 1]?.isFinal &&
          sameTurnOrLegacy(item, pending[pending.length - 1] as T)
        ) {
          pending.pop();
          droppedPartials += 1;
        }
        pending.push(item);
      } else if (
        pending.length > 0 &&
        !pending[pending.length - 1]?.isFinal &&
        sameTurnOrLegacy(item, pending[pending.length - 1] as T)
      ) {
        // Replace only the trailing partial for the same turn. A queued final
        // or a partial from another turn must retain its ordering.
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
      droppedFinals,
      pending: pending.length,
      inFlight,
    }),
  };
};
