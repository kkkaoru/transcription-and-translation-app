// Runs in the browser; built and tested with Bun.
import type { ActiveSpeech, MainThreadLoadMetrics, VadTimingMetrics } from "./model";

interface TimingSummaryInput {
  active: ActiveSpeech;
  segmentationWallMs: number;
  postProcessingMs: number;
  audioFrameMs: number;
}

interface LoadMonitorHandlers {
  onLongTask: (durationMs: number) => void;
  onEventLoopLag: (lagMs: number) => void;
}

const EVENT_LOOP_INTERVAL_MS: number = 100;
const EXPECTED_FRAME_MS: number = 32;
const EMPTY_NUMBER: number = 0;
const ascending = (left: number, right: number): number => left - right;
const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
const average = (values: readonly number[]): number =>
  values.length === 0 ? EMPTY_NUMBER : sum(values) / values.length;
const maximum = (values: readonly number[]): number =>
  values.length === 0 ? EMPTY_NUMBER : Math.max(...values);
const standardDeviation = (values: readonly number[]): number => {
  const mean: number = average(values);
  return values.length === 0
    ? EMPTY_NUMBER
    : Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
};

export const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) {
    return EMPTY_NUMBER;
  }
  const sorted: number[] = [...values].sort(ascending);
  const index: number = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? EMPTY_NUMBER;
};

export const buildTimingMetrics = ({
  active,
  segmentationWallMs,
  postProcessingMs,
  audioFrameMs,
}: TimingSummaryInput): VadTimingMetrics => ({
  segmentationWallMs,
  callbackProcessingMs: sum(active.callbackDurationsMs),
  callbackAverageMs: average(active.callbackDurationsMs),
  callbackMaximumMs: maximum(active.callbackDurationsMs),
  postProcessingMs,
  frameCount: active.frameCount,
  audioFrameMs,
  frameIntervalAverageMs: average(active.frameIntervalsMs),
  frameIntervalP50Ms: percentile(active.frameIntervalsMs, 0.5),
  frameIntervalP95Ms: percentile(active.frameIntervalsMs, 0.95),
  frameIntervalMaximumMs: maximum(active.frameIntervalsMs),
  frameIntervalJitterMs: standardDeviation(active.frameIntervalsMs),
  framesPerSecond: segmentationWallMs === 0 ? 0 : (active.frameCount / segmentationWallMs) * 1_000,
  realTimeFactor: audioFrameMs === 0 ? 0 : segmentationWallMs / audioFrameMs,
  delayedFrameCount: active.frameIntervalsMs.filter(
    (interval) => interval > EXPECTED_FRAME_MS * 1.5,
  ).length,
});

export const buildMainThreadLoadMetrics = (active: ActiveSpeech): MainThreadLoadMetrics => ({
  longTaskSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
  longTaskCount: active.longTaskCount,
  longTaskTotalMs: active.longTaskTotalMs,
  longTaskMaximumMs: active.longTaskMaximumMs,
  eventLoopLagAverageMs:
    active.eventLoopSampleCount === 0
      ? 0
      : active.eventLoopLagTotalMs / active.eventLoopSampleCount,
  eventLoopLagMaximumMs: active.eventLoopLagMaximumMs,
  eventLoopSampleCount: active.eventLoopSampleCount,
});

export class BrowserLoadMonitor {
  private readonly handlers: LoadMonitorHandlers;
  private intervalId: number | null = null;
  private observer: PerformanceObserver | null = null;
  private expectedTickMs = 0;

  public constructor(handlers: LoadMonitorHandlers) {
    this.handlers = handlers;
  }

  public start(): void {
    this.expectedTickMs = performance.now() + EVENT_LOOP_INTERVAL_MS;
    this.intervalId = window.setInterval(this.measureEventLoopLag, EVENT_LOOP_INTERVAL_MS);
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      this.observer = new PerformanceObserver((list) =>
        list.getEntries().map((entry) => this.handlers.onLongTask(entry.duration)),
      );
      this.observer.observe({ entryTypes: ["longtask"] });
    }
  }

  public stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.observer?.disconnect();
    this.observer = null;
  }

  private readonly measureEventLoopLag = (): void => {
    const nowMs: number = performance.now();
    this.handlers.onEventLoopLag(Math.max(0, nowMs - this.expectedTickMs));
    this.expectedTickMs = nowMs + EVENT_LOOP_INTERVAL_MS;
  };
}
