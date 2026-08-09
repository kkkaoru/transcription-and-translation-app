import { describe, expect, it } from "vitest";
import {
  elapsedSinceMs,
  formatMilliseconds,
  formatRowTiming,
  sumElapsedMs,
} from "./conversion-timing";

describe("conversion timing display", () => {
  it("formats worker and total milliseconds without dropping either", () => {
    expect(formatMilliseconds(undefined)).toBe("未計測");
    expect(formatMilliseconds(0)).toBe("0 ms");
    expect(formatMilliseconds(12.4)).toBe("12 ms");
    expect(sumElapsedMs(4, 9)).toBe(13);
    expect(sumElapsedMs(undefined, 12)).toBe(12);
    expect(sumElapsedMs()).toBeUndefined();
    expect(elapsedSinceMs(100, 137.2)).toBe(37);
    expect(
      formatRowTiming({
        wasmElapsedMs: 4,
        workerElapsedMs: 12,
        totalElapsedMs: 41,
      }),
    ).toBe("処理時間 Vibrato 4 ms · Worker 12 ms · 合計処理時間 41 ms");
    expect(
      formatRowTiming({
        azookeyElapsedMs: 9,
        totalElapsedMs: 13,
      }),
    ).toBe("処理時間 Worker 9 ms · 合計処理時間 13 ms");
    expect(
      formatRowTiming({
        workerElapsedMs: 0,
        totalElapsedMs: 41,
      }),
    ).toBe("処理時間 Worker 0 ms · 合計処理時間 41 ms");
    expect(formatRowTiming({})).toBe("処理時間 Worker 未計測 · 合計処理時間 未計測");
  });
});
