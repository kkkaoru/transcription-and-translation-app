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

import { isShorterSameUtteranceSurface } from "./caption-updates";
import { recordPipelineDrop } from "./dropDiagnostics";

export type ParapperOutputQueueItem = {
  isFinal: boolean;
  /** Optional protocol cursor fields (legacy callers may omit them). */
  sessionId?: string;
  turnSessionId?: number;
  turnId?: number;
  revision?: number;
  outputSequence?: number;
  segmentId?: number;
  /** Optional recognized surface used to keep a longer rewrite over a truncated later partial. */
  text?: string;
  sourceText?: string | null;
};

export type ParapperOutputQueueStats = {
  processed: number;
  droppedPartials: number;
  droppedFinals: number;
  pending: number;
  /** Bounded cursor cache size, exposed for live-backlog diagnostics. */
  trackedTurns: number;
  inFlight: boolean;
};

export type ParapperOutputQueue<T extends ParapperOutputQueueItem> = {
  enqueue: (item: T) => void;
  /**
   * Resolve once all accepted items have finished processing. Rejects after a
   * finite timeout so teardown cannot wait forever on a stuck normalizer.
   */
  whenIdle: (timeoutMs?: number) => Promise<void>;
  /** Drop queued items and ignore future events for this capture attempt. */
  close: () => void;
  getStats: () => ParapperOutputQueueStats;
};

type IdleWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bound pending work even if the normalizer is permanently stalled. */
export const PARAPPER_OUTPUT_QUEUE_MAX_PENDING = 32;
/** Cursor de-duplication is session-scoped but must not grow for a long stream. */
export const PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS = 128;
export const DEFAULT_PARAPPER_OUTPUT_QUEUE_IDLE_TIMEOUT_MS = 8_000;
const MIN_IDLE_TIMEOUT_MS = 1;

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

const queueItemSurface = (item: ParapperOutputQueueItem): string => {
  if (typeof item.sourceText === "string" && item.sourceText.trim()) {
    return item.sourceText.trim();
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text.trim();
  }
  return "";
};

const isShorterRewriteOfPending = (
  candidate: ParapperOutputQueueItem,
  pendingItem: ParapperOutputQueueItem,
): boolean => {
  const candidateText = queueItemSurface(candidate);
  const pendingText = queueItemSurface(pendingItem);
  if (!candidateText || !pendingText) {
    return false;
  }
  // Prefix cuts and much-shorter conversions are not enough: a later
  // `きこえますか` is a suffix of `こんにちはきこえますか` and is not always
  // "much shorter" by grapheme count. Latest-wins must keep the long surface.
  return isShorterSameUtteranceSurface(candidateText, pendingText);
};

/** Skip AzooKey for a stale shorter partial when a longer same-id surface already painted. */
export const shouldSkipParapperNormalize = (
  painted: { id: string; sourceText: string },
  output: ParapperOutputQueueItem,
): boolean => {
  if (output.isFinal) {
    return false;
  }
  if (
    hasTurnIdentity(output) &&
    painted.id !== `parapper:${output.sessionId}:${output.turnSessionId}:${output.turnId}`
  ) {
    return false;
  }
  return isShorterSameUtteranceSurface(queueItemSurface(output), painted.sourceText);
};

const shouldDropForCursor = (
  candidate: ParapperOutputQueueItem,
  current: ParapperOutputQueueItem,
): boolean => {
  if (!sameTurn(candidate, current)) {
    return false;
  }
  // A final closes the turn; a late partial can never reopen it — unless that
  // partial is a longer same-utterance continuation of an early-finalized
  // prefix (`こんにちは` then `こんにちはーきこえますかー`). Dropping it left
  // overlay with greeting-only because the tail never reached caption:update.
  if (current.isFinal && !candidate.isFinal) {
    const currentText = queueItemSurface(current);
    const candidateText = queueItemSurface(candidate);
    if (currentText && candidateText && isShorterSameUtteranceSurface(currentText, candidateText)) {
      return false;
    }
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
  const idleWaiters: IdleWaiter[] = [];

  const isIdle = (): boolean => !inFlight && pending.length === 0;

  const resolveIdle = (force = false): void => {
    if (!force && !isIdle()) {
      return;
    }
    while (idleWaiters.length > 0) {
      const waiter = idleWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const rememberLatestTurn = (key: string, item: T): void => {
    // Updating an existing entry must move it to the newest end of the Map so
    // overflow evicts the least recently observed turn cursor.
    latestByTurn.delete(key);
    latestByTurn.set(key, item);
    while (latestByTurn.size > PARAPPER_OUTPUT_QUEUE_MAX_TRACKED_TURNS) {
      const oldest = latestByTurn.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      latestByTurn.delete(oldest);
    }
  };

  const boundPending = (): void => {
    while (pending.length > PARAPPER_OUTPUT_QUEUE_MAX_PENDING) {
      // Preserve finals when possible, but never allow an unbounded final
      // backlog to pin memory/UI teardown forever. If all entries are finals,
      // newest wins and the oldest final is explicitly accounted for.
      const partialIndex = pending.findIndex((queued) => !queued.isFinal);
      const dropIndex = partialIndex >= 0 ? partialIndex : 0;
      const [dropped] = pending.splice(dropIndex, 1);
      if (dropped?.isFinal) {
        droppedFinals += 1;
        recordPipelineDrop("parapper-output-queue", 1, "pending-overflow-final");
      } else {
        droppedPartials += 1;
        recordPipelineDrop("parapper-output-queue", 1, "pending-overflow-partial");
      }
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
      if (
        !item.isFinal &&
        pending.some(
          (queued) => sameTurnOrLegacy(item, queued) && isShorterRewriteOfPending(item, queued),
        )
      ) {
        droppedPartials += 1;
        recordPipelineDrop("parapper-output-queue", 1, "drain-superseded-partial");
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
            recordPipelineDrop("parapper-output-queue", 1, "stale-final-cursor");
          } else {
            droppedPartials += 1;
            recordPipelineDrop("parapper-output-queue", 1, "stale-partial-cursor");
          }
          return;
        }
      }
      const trailing = pending.length > 0 ? pending[pending.length - 1] : undefined;
      if (
        !item.isFinal &&
        trailing &&
        !trailing.isFinal &&
        sameTurnOrLegacy(item, trailing) &&
        isShorterRewriteOfPending(item, trailing)
      ) {
        // Latest-wins must not drop a longer pending rewrite in favor of a
        // truncated later partial. The longer surface still needs normalize.
        droppedPartials += 1;
        recordPipelineDrop("parapper-output-queue", 1, "truncated-rewrite-partial");
        return;
      }
      if (key !== null) {
        rememberLatestTurn(key, item);
      }
      if (item.isFinal) {
        // Partials waiting for this same turn are superseded by its final,
        // except a longer pending rewrite that this final truncates.
        // Keep a newer turn's partial intact even if transport delivery is
        // briefly interleaved.
        while (
          pending.length > 0 &&
          !pending[pending.length - 1]?.isFinal &&
          sameTurnOrLegacy(item, pending[pending.length - 1] as T)
        ) {
          const trailingPartial = pending[pending.length - 1] as T;
          // Truncated completion ASR must not discard a longer pending rewrite
          // that has not painted yet. Keep that surface in front of this final
          // so merge can stitch the utterance tail instead of dropping it.
          if (isShorterRewriteOfPending(item, trailingPartial)) {
            break;
          }
          pending.pop();
          droppedPartials += 1;
          recordPipelineDrop("parapper-output-queue", 1, "final-superseded-partial");
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
        recordPipelineDrop("parapper-output-queue", 1, "partial-replaced");
      } else {
        pending.push(item);
      }
      boundPending();
      void run();
    },
    whenIdle: (timeoutMs = DEFAULT_PARAPPER_OUTPUT_QUEUE_IDLE_TIMEOUT_MS) => {
      if (isIdle()) {
        return Promise.resolve();
      }
      const safeTimeout = Number.isFinite(timeoutMs)
        ? Math.max(MIN_IDLE_TIMEOUT_MS, Math.floor(timeoutMs))
        : DEFAULT_PARAPPER_OUTPUT_QUEUE_IDLE_TIMEOUT_MS;
      return new Promise<void>((resolve, reject) => {
        const waiter: IdleWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = idleWaiters.indexOf(waiter);
            if (index >= 0) {
              idleWaiters.splice(index, 1);
            }
            reject(new Error("Parapper output queue did not become idle before timeout"));
          }, safeTimeout),
        };
        idleWaiters.push(waiter);
      });
    },
    close: () => {
      closed = true;
      const droppedPending = pending;
      const droppedPendingPartials = droppedPending.filter((queued) => !queued.isFinal).length;
      const droppedPendingFinals = droppedPending.length - droppedPendingPartials;
      if (droppedPendingPartials > 0) {
        droppedPartials += droppedPendingPartials;
        recordPipelineDrop(
          "parapper-output-queue",
          droppedPendingPartials,
          "close-pending-partial",
        );
      }
      if (droppedPendingFinals > 0) {
        droppedFinals += droppedPendingFinals;
        recordPipelineDrop("parapper-output-queue", droppedPendingFinals, "close-pending-final");
      }
      pending = [];
      latestByTurn.clear();
      // Close deliberately abandons the active normalization result, so
      // callers waiting to tear down must not remain blocked by that Promise.
      resolveIdle(true);
    },
    getStats: () => ({
      processed,
      droppedPartials,
      droppedFinals,
      pending: pending.length,
      trackedTurns: latestByTurn.size,
      inFlight,
    }),
  };
};
