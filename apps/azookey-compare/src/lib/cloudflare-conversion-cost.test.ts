import { describe, expect, it } from "vitest";
import {
  CF_CONVERSION_COST_BILLED_CPU_NOTE,
  CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
  CF_WORKERS_CPU_USD_PER_MS,
  CF_WORKERS_PRICING_SOURCE_URL,
  CF_WORKERS_REQUEST_USD_PER_REQUEST,
  compareWsUpgradeBilledCpuMs,
  estimateBilledCpuMsFromWall,
  estimateCloudflareConversionCost,
  formatCloudflareCostUsd,
  usesExternalGgufUpstream,
} from "./cloudflare-conversion-cost";
import { INFERENCE_WS_CONVERT_CALIBRATION, COMPARE_WS_UPGRADE_CALIBRATION } from "./workers-billed-cpu-calibration";

describe("cloudflare-conversion-cost", () => {
  describe("estimateBilledCpuMsFromWall", () => {
    it("returns 0 for missing or non-positive wall ms", () => {
      expect(estimateBilledCpuMsFromWall(undefined, INFERENCE_WS_CONVERT_CALIBRATION)).toBe(0);
      expect(estimateBilledCpuMsFromWall(0, INFERENCE_WS_CONVERT_CALIBRATION)).toBe(0);
      expect(estimateBilledCpuMsFromWall(-3, INFERENCE_WS_CONVERT_CALIBRATION)).toBe(0);
    });

    it("maps wall ms via log-calibrated cpu/wall ratio", () => {
      expect(estimateBilledCpuMsFromWall(918, INFERENCE_WS_CONVERT_CALIBRATION)).toBe(664);
      expect(estimateBilledCpuMsFromWall(12, INFERENCE_WS_CONVERT_CALIBRATION)).toBe(9);
    });
  });

  describe("compareWsUpgradeBilledCpuMs", () => {
    it("uses median compare WS cpuTime from tail logs", () => {
      expect(compareWsUpgradeBilledCpuMs()).toBe(4);
    });
  });

  describe("formatCloudflareCostUsd", () => {
    it("returns $0 for zero and negative", () => {
      expect(formatCloudflareCostUsd(0)).toBe("$0");
      expect(formatCloudflareCostUsd(-1)).toBe("$0");
    });

    it("preserves small nonzero values in scientific notation", () => {
      const usd = 9 * CF_WORKERS_CPU_USD_PER_MS + CF_WORKERS_REQUEST_USD_PER_REQUEST;
      expect(formatCloudflareCostUsd(usd)).toBe("$4.80e-7");
    });

    it("formats larger micro-dollar amounts without rounding to $0.00", () => {
      expect(formatCloudflareCostUsd(0.00000125)).toBe("$0.00000125");
    });
  });

  describe("estimateCloudflareConversionCost", () => {
    it("returns browser-complete zero cost", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: false,
        openedNewWebSocket: false,
      });
      expect(estimate).toMatchObject({
        usd: 0,
        requests: 0,
        billedCpuMs: 0,
        wallMs: 0,
        browserComplete: true,
        summaryJa: CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
      });
      expect(estimate.breakdown).toHaveLength(0);
    });

    it("estimates WS-reused inference with log-calibrated billed CPU", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(1);
      expect(estimate.wallMs).toBe(12);
      expect(estimate.billedCpuMs).toBe(9);
      expect(estimate.usd).toBe(
        Math.round((CF_WORKERS_REQUEST_USD_PER_REQUEST + 9 * CF_WORKERS_CPU_USD_PER_MS) * 1e9) /
          1e9,
      );
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$4.80e-7");
      expect(estimate.summaryJa).toContain("wall 12 ms");
      expect(estimate.summaryJa).toContain("billed CPU 9 ms");
      expect(estimate.note).toContain(CF_CONVERSION_COST_BILLED_CPU_NOTE);
      expect(estimate.sourceUrl).toBe(CF_WORKERS_PRICING_SOURCE_URL);
      expect(estimate.browserComplete).toBe(false);
    });

    it("uses factual workerBilledCpuMs when provided on the wire", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 12,
        workerBilledCpuMs: 450,
      });
      expect(estimate.billedCpuMs).toBe(450);
      expect(estimate.breakdown.some((line) => line.label.includes("ログ cpuTime"))).toBe(true);
    });

    it("adds compare WebSocket Upgrade request and median upgrade CPU", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(2);
      expect(estimate.billedCpuMs).toBe(13);
      expect(estimate.usd).toBe(
        Math.round(
          (2 * CF_WORKERS_REQUEST_USD_PER_REQUEST + 13 * CF_WORKERS_CPU_USD_PER_MS) * 1e9,
        ) / 1e9,
      );
      expect(estimate.breakdown.some((line) => line.label.includes("Upgrade"))).toBe(true);
      expect(estimate.breakdown.some((line) => line.label.includes("inference"))).toBe(true);
    });

    it("includes compare wall-calibrated CPU when compareElapsedMs provided", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        compareElapsedMs: 100,
        workerElapsedMs: 12,
      });
      const compareProxy = estimateBilledCpuMsFromWall(100, COMPARE_WS_UPGRADE_CALIBRATION);
      expect(estimate.billedCpuMs).toBe(compareProxy + 9);
    });

    it("counts upgrade-only when inference failed before WASM", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        failedBeforeInference: true,
      });
      expect(estimate.requests).toBe(1);
      expect(estimate.billedCpuMs).toBe(4);
      expect(estimate.note).toContain("推論前に失敗");
    });

    it("notes external GGUF upstream without inventing upstream cost", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 20,
        usesExternalGgufUpstream: true,
      });
      expect(estimate.note).toContain("外部 GGUF");
      expect(estimate.usd).toBeGreaterThan(0);
    });

    it("never rounds nonzero totals to zero", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 1,
      });
      expect(estimate.usd).toBeGreaterThan(0);
      expect(formatCloudflareCostUsd(estimate.usd)).not.toBe("$0");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toBe("$0.00");
    });

    it("matches a real inference tail sample when wall equals logged wallTime", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 633,
        workerBilledCpuMs: 450,
      });
      expect(estimate.billedCpuMs).toBe(450);
      expect(estimate.usd).toBe(
        Math.round((CF_WORKERS_REQUEST_USD_PER_REQUEST + 450 * CF_WORKERS_CPU_USD_PER_MS) * 1e9) /
          1e9,
      );
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$0.0000093");
    });
  });

  describe("usesExternalGgufUpstream", () => {
    it("is false for azookey wasm", () => {
      expect(
        usesExternalGgufUpstream({
          requestedModel: "azookey-rust-wasm",
          resolvedModel: "azookey-rust-wasm",
        }),
      ).toBe(false);
    });

    it("is true when GGUF requested and resolved without fallback", () => {
      expect(
        usesExternalGgufUpstream({
          requestedModel: "zenz-v3.2-xsmall-gguf",
          resolvedModel: "zenz-v3.2-xsmall-gguf",
        }),
      ).toBe(true);
    });

    it("is false when fallback to azookey wasm occurred", () => {
      expect(
        usesExternalGgufUpstream({
          requestedModel: "zenz-v3.2-xsmall-gguf",
          resolvedModel: "azookey-rust-wasm",
          modelFallback: "upstream-failed",
        }),
      ).toBe(false);
    });
  });
});
