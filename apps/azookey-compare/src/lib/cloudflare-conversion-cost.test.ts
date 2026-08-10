import { describe, expect, it } from "vitest";
import {
  CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
  CF_WORKERS_CPU_USD_PER_MS,
  CF_WORKERS_PRICING_SOURCE_URL,
  CF_WORKERS_REQUEST_USD_PER_REQUEST,
  estimateCloudflareConversionCost,
  formatCloudflareCostUsd,
  usesExternalGgufUpstream,
} from "./cloudflare-conversion-cost";

describe("cloudflare-conversion-cost", () => {
  describe("formatCloudflareCostUsd", () => {
    it("returns $0 for zero and negative", () => {
      expect(formatCloudflareCostUsd(0)).toBe("$0");
      expect(formatCloudflareCostUsd(-1)).toBe("$0");
    });

    it("preserves small nonzero values in scientific notation", () => {
      const usd = 12 * CF_WORKERS_CPU_USD_PER_MS + CF_WORKERS_REQUEST_USD_PER_REQUEST;
      expect(formatCloudflareCostUsd(usd)).toBe("$5.40e-7");
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
        cpuMs: 0,
        browserComplete: true,
        summaryJa: CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
      });
      expect(estimate.breakdown).toHaveLength(0);
    });

    it("estimates WS-reused inference: 1 request + 12ms CPU proxy", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(1);
      expect(estimate.cpuMs).toBe(12);
      expect(estimate.usd).toBe(
        Math.round((CF_WORKERS_REQUEST_USD_PER_REQUEST + 12 * CF_WORKERS_CPU_USD_PER_MS) * 1e9) /
          1e9,
      );
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$5.40e-7");
      expect(estimate.summaryJa).toContain("推定 Cloudflare 利用料");
      expect(estimate.summaryJa).toContain("リクエスト 1");
      expect(estimate.summaryJa).toContain("CPU ≈ 12 ms");
      expect(estimate.sourceUrl).toBe(CF_WORKERS_PRICING_SOURCE_URL);
      expect(estimate.browserComplete).toBe(false);
    });

    it("adds compare WebSocket Upgrade on first connect", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(2);
      expect(estimate.usd).toBe(
        Math.round(
          (2 * CF_WORKERS_REQUEST_USD_PER_REQUEST + 12 * CF_WORKERS_CPU_USD_PER_MS) * 1e9,
        ) / 1e9,
      );
      expect(estimate.breakdown.some((line) => line.label.includes("Upgrade"))).toBe(true);
      expect(estimate.breakdown.some((line) => line.label.includes("inference"))).toBe(true);
    });

    it("includes compare CPU proxy when provided", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        compareElapsedMs: 5,
        workerElapsedMs: 12,
      });
      expect(estimate.cpuMs).toBe(17);
      expect(estimate.breakdown.some((line) => line.label.includes("compare CPU"))).toBe(true);
    });

    it("counts upgrade-only when inference failed before WASM", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        failedBeforeInference: true,
      });
      expect(estimate.requests).toBe(1);
      expect(estimate.cpuMs).toBe(0);
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
