import { describe, expect, it } from "vitest";
import {
  COMPARE_WS_UPGRADE_CALIBRATION,
  INFERENCE_WS_CONVERT_CALIBRATION,
  WORKERS_BILLED_CPU_CAPTURED_AT,
  WORKERS_BILLED_CPU_FIELD_CPU,
  WORKERS_BILLED_CPU_FIELD_WALL,
  WORKERS_BILLED_CPU_UNIT,
} from "./workers-billed-cpu-calibration";

describe("workers-billed-cpu-calibration", () => {
  it("documents wrangler tail field names and millisecond units", () => {
    expect(WORKERS_BILLED_CPU_FIELD_CPU).toBe("cpuTime");
    expect(WORKERS_BILLED_CPU_FIELD_WALL).toBe("wallTime");
    expect(WORKERS_BILLED_CPU_UNIT).toBe("ms");
    expect(WORKERS_BILLED_CPU_CAPTURED_AT).toMatch(/^2026-/);
  });

  it("records compare WS upgrade medians from tail samples", () => {
    expect(COMPARE_WS_UPGRADE_CALIBRATION.sampleSize).toBe(2);
    expect(COMPARE_WS_UPGRADE_CALIBRATION.medianCpuMs).toBe(4);
    expect(COMPARE_WS_UPGRADE_CALIBRATION.medianWallMs).toBe(957.5);
    expect(COMPARE_WS_UPGRADE_CALIBRATION.cpuWallRatio).toBeCloseTo(4 / 957.5);
  });

  it("records inference WS convert medians from tail samples", () => {
    expect(INFERENCE_WS_CONVERT_CALIBRATION.sampleSize).toBe(2);
    expect(INFERENCE_WS_CONVERT_CALIBRATION.medianCpuMs).toBe(664);
    expect(INFERENCE_WS_CONVERT_CALIBRATION.medianWallMs).toBe(918);
    expect(INFERENCE_WS_CONVERT_CALIBRATION.cpuWallRatio).toBeCloseTo(664 / 918);
  });
});
