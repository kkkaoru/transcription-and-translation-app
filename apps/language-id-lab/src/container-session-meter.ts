// Runs with Bun during build and test.

export interface ContainerActivityMeter {
  accumulatedMs: number;
  windowStartedAtMs: number | null;
  lastActivityAtMs: number | null;
}

const CONTAINER_IDLE_TIMEOUT_MS: number = 30_000;

export const emptyContainerActivityMeter = (): ContainerActivityMeter => ({
  accumulatedMs: 0,
  windowStartedAtMs: null,
  lastActivityAtMs: null,
});

export const estimatedContainerActiveMs = (meter: ContainerActivityMeter, atMs: number): number => {
  if (meter.windowStartedAtMs === null || meter.lastActivityAtMs === null) {
    return meter.accumulatedMs;
  }
  const activeUntilMs: number = Math.min(
    Math.max(atMs, meter.windowStartedAtMs),
    meter.lastActivityAtMs + CONTAINER_IDLE_TIMEOUT_MS,
  );
  return meter.accumulatedMs + Math.max(0, activeUntilMs - meter.windowStartedAtMs);
};

export const touchContainerActivity = (
  meter: ContainerActivityMeter,
  atMs: number,
): ContainerActivityMeter => {
  if (meter.windowStartedAtMs === null || meter.lastActivityAtMs === null) {
    return { ...meter, windowStartedAtMs: atMs, lastActivityAtMs: atMs };
  }
  if (atMs <= meter.lastActivityAtMs + CONTAINER_IDLE_TIMEOUT_MS) {
    return { ...meter, lastActivityAtMs: Math.max(atMs, meter.lastActivityAtMs) };
  }
  return {
    accumulatedMs:
      meter.accumulatedMs +
      meter.lastActivityAtMs +
      CONTAINER_IDLE_TIMEOUT_MS -
      meter.windowStartedAtMs,
    windowStartedAtMs: atMs,
    lastActivityAtMs: atMs,
  };
};

export const releaseContainerActivity = (
  meter: ContainerActivityMeter,
  atMs: number,
): ContainerActivityMeter => ({
  accumulatedMs: estimatedContainerActiveMs(meter, atMs),
  windowStartedAtMs: null,
  lastActivityAtMs: null,
});
