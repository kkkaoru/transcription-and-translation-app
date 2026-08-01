/**
 * External store for live mic RMS (dBFS).
 *
 * Isolated from React caption/status state so ~12 Hz meter ticks do not re-render
 * the preview overlay, transcript panel, or the rest of the live shell.
 */

const listeners = new Set<() => void>();
let levelDb: number | null = null;
/** Monotonic revision for useSyncExternalStore getSnapshot identity. */
let revision = 0;

const notify = (): void => {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
};

export const getInputLevelDb = (): number | null => levelDb;

/** Snapshot token — changes only when the published level changes. */
export const getInputLevelRevision = (): number => revision;

export const setInputLevelDb = (next: number | null): void => {
  if (next === null) {
    if (levelDb === null) {
      return;
    }
    levelDb = null;
    notify();
    return;
  }
  if (!Number.isFinite(next)) {
    return;
  }
  // Quantize to 0.5 dB so tiny RMS jitter does not thrash subscribers.
  const quantized = Math.round(next * 2) / 2;
  if (levelDb === quantized) {
    return;
  }
  levelDb = quantized;
  notify();
};

export const clearInputLevelDb = (): void => {
  setInputLevelDb(null);
};

export const subscribeInputLevel = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
