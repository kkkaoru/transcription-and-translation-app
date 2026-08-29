// Runs with Bun.
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserLoadMonitor,
  buildMainThreadLoadMetrics,
  buildTimingMetrics,
  percentile,
} from "./diagnostics";
import type { ActiveSpeech } from "./model";

const activeSpeech = (): ActiveSpeech => ({
  id: "audio-1",
  languageCode: "ja",
  speechStartedAt: "2026-08-28T00:00:00.000Z",
  startedPerformanceMs: 0,
  memoryStartBytes: 100,
  memoryStartBreakdownJson: "[]",
  memoryPeakBytes: 200,
  callbackProcessingMs: 6,
  frameCount: 4,
  probabilitySum: 3,
  probabilityMaximum: 0.9,
  probabilityMinimum: 0.5,
  memorySampleCount: 3,
  memoryMethod: "performance.memory.usedJSHeapSize",
  callbackDurationsMs: [1, 2, 1, 2],
  frameIntervalsMs: [31, 32, 64],
  lastFrameAtMs: 127,
  longTaskCount: 2,
  longTaskTotalMs: 140,
  longTaskMaximumMs: 80,
  eventLoopLagTotalMs: 15,
  eventLoopLagMaximumMs: 8,
  eventLoopSampleCount: 3,
});

class MockLongTaskEntry implements PerformanceEntry {
  public readonly duration: number = 75;
  public readonly entryType: string = "longtask";
  public readonly name: string = "self";
  public readonly startTime: number = 0;

  public toJSON(): object {
    return { duration: this.duration };
  }
}

class MockEntryList implements PerformanceObserverEntryList {
  public getEntries(): PerformanceEntryList {
    return [new MockLongTaskEntry()];
  }

  public getEntriesByName(): PerformanceEntryList {
    return [new MockLongTaskEntry()];
  }

  public getEntriesByType(): PerformanceEntryList {
    return [new MockLongTaskEntry()];
  }
}

class UnsupportedPerformanceObserver implements PerformanceObserver {
  public static readonly supportedEntryTypes: readonly string[] = [];
  public disconnect(): void {}
  public observe(): void {}
  public takeRecords(): PerformanceEntryList {
    return [];
  }
}

class MockPerformanceObserver implements PerformanceObserver {
  public static readonly supportedEntryTypes: readonly string[] = ["longtask"];
  public static callback: PerformanceObserverCallback | null = null;
  public disconnected = false;

  public constructor(callback: PerformanceObserverCallback) {
    MockPerformanceObserver.callback = callback;
  }

  public observe(): void {}

  public takeRecords(): PerformanceEntryList {
    return [];
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

afterEach(() => {
  MockPerformanceObserver.callback = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("calculates percentile boundaries", () => {
  expect(percentile([], 0.95)).toBe(0);
  expect(percentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
  expect(percentile([50, 10, 40, 20, 30], 0.95)).toBe(50);
});

it("summarizes Silero frame timing and delayed frames", () => {
  expect(
    buildTimingMetrics({
      active: activeSpeech(),
      segmentationWallMs: 160,
      postProcessingMs: 4,
      audioFrameMs: 128,
    }),
  ).toStrictEqual({
    segmentationWallMs: 160,
    callbackProcessingMs: 6,
    callbackAverageMs: 1.5,
    callbackMaximumMs: 2,
    postProcessingMs: 4,
    frameCount: 4,
    audioFrameMs: 128,
    frameIntervalAverageMs: 42.333333333333336,
    frameIntervalP50Ms: 32,
    frameIntervalP95Ms: 64,
    frameIntervalMaximumMs: 64,
    frameIntervalJitterMs: 15.326085243430198,
    framesPerSecond: 25,
    realTimeFactor: 1.25,
    delayedFrameCount: 1,
  });
});

it("returns zero load values when a segment has no timing samples", () => {
  vi.stubGlobal("PerformanceObserver", UnsupportedPerformanceObserver);
  const active = activeSpeech();
  active.callbackDurationsMs = [];
  active.frameIntervalsMs = [];
  active.frameCount = 0;
  active.longTaskCount = 0;
  active.longTaskTotalMs = 0;
  active.longTaskMaximumMs = 0;
  active.eventLoopLagTotalMs = 0;
  active.eventLoopLagMaximumMs = 0;
  active.eventLoopSampleCount = 0;

  expect(
    buildTimingMetrics({ active, segmentationWallMs: 0, postProcessingMs: 0, audioFrameMs: 0 }),
  ).toMatchObject({
    callbackAverageMs: 0,
    callbackMaximumMs: 0,
    frameIntervalAverageMs: 0,
    frameIntervalJitterMs: 0,
    framesPerSecond: 0,
    realTimeFactor: 0,
    delayedFrameCount: 0,
  });
  expect(buildMainThreadLoadMetrics(active)).toStrictEqual({
    longTaskSupported: false,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaximumMs: 0,
    eventLoopLagAverageMs: 0,
    eventLoopLagMaximumMs: 0,
    eventLoopSampleCount: 0,
  });
});

it("summarizes Long Tasks and event-loop lag", () => {
  vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);

  expect(buildMainThreadLoadMetrics(activeSpeech())).toStrictEqual({
    longTaskSupported: true,
    longTaskCount: 2,
    longTaskTotalMs: 140,
    longTaskMaximumMs: 80,
    eventLoopLagAverageMs: 5,
    eventLoopLagMaximumMs: 8,
    eventLoopSampleCount: 3,
  });
});

it("does not create a Long Task observer when unsupported", () => {
  vi.useFakeTimers();
  vi.stubGlobal("PerformanceObserver", UnsupportedPerformanceObserver);
  const onEventLoopLag = vi.fn();
  const monitor = new BrowserLoadMonitor({ onLongTask: vi.fn(), onEventLoopLag });
  monitor.start();
  vi.advanceTimersByTime(110);
  monitor.stop();
  monitor.stop();

  expect(onEventLoopLag).toHaveBeenCalledTimes(1);
});

it("monitors event-loop lag and Long Tasks", () => {
  vi.useFakeTimers();
  vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
  const onLongTask = vi.fn();
  const onEventLoopLag = vi.fn();
  const monitor = new BrowserLoadMonitor({ onLongTask, onEventLoopLag });
  monitor.start();
  vi.advanceTimersByTime(110);
  MockPerformanceObserver.callback?.(
    new MockEntryList(),
    new MockPerformanceObserver(() => undefined),
  );
  monitor.stop();

  expect(onEventLoopLag).toHaveBeenCalledTimes(1);
  expect(onLongTask).toHaveBeenCalledWith(75);
});
