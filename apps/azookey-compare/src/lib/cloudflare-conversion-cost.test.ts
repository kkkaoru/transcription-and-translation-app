// This file runs with bun.
import { describe, expect, it } from "vitest";
import {
  CF_CONVERSION_COST_BILLED_CPU_NOTE,
  CF_WORKERS_CPU_USD_PER_MS,
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

    it("preserves small nonzero values as decimals, never scientific notation", () => {
      const usd = 12 * CF_WORKERS_CPU_USD_PER_MS + CF_WORKERS_REQUEST_USD_PER_REQUEST;
      expect(formatCloudflareCostUsd(usd)).toBe("$0.00000054");
      expect(formatCloudflareCostUsd(usd)).not.toMatch(/[eE]/);
    });

    it("formats larger micro-dollar amounts without rounding to $0.00", () => {
      expect(formatCloudflareCostUsd(0.00000125)).toBe("$0.00000125");
    });
  });

  describe("estimateCloudflareConversionCost", () => {
    it("returns browser-complete zero cost with a plugged-in formula", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: false,
        openedNewWebSocket: false,
      });
      expect(estimate.usd).toBe(0);
      expect(estimate.requests).toBe(0);
      expect(estimate.billedCpuMs).toBe(0);
      expect(estimate.wallMs).toBe(0);
      expect(estimate.browserComplete).toBe(true);
      expect(estimate.summaryJa).toBe(
        "Cloudflare 課金なし · 0 × (0.30 / 1,000,000) + 0 × (0.02 / 1,000,000) = $0",
      );
      expect(estimate.breakdown).toStrictEqual([]);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 0 × (0.30 / 1,000,000) + 0 × (0.02 / 1,000,000) = $0\ncpuMs = 0\nrequests = 0 (browser complete)",
      );
    });

    it("estimates a reused-WS convert from this request wall, not log calibration", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(1);
      expect(estimate.wallMs).toBe(12);
      expect(estimate.billedCpuMs).toBe(12);
      expect(estimate.usd).toBe(0.00000054);
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$0.00000054");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toMatch(/[eE]/);
      expect(estimate.summaryJa).toBe(
        "推定 Cloudflare 利用料（Workers Paid 超過単価） $0.00000054 · リクエスト 1 · wall 12 ms · cpuMs 12 ms · 1 × (0.30 / 1,000,000) + 12 × (0.02 / 1,000,000) = $0.00000054",
      );
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 12 × (0.02 / 1,000,000) = $0.00000054\ncpuMs = workerElapsedMs 12 (this request wall; billed cpuTime not on the wire)\nrequests = 1 (this convert)",
      );
      expect(estimate.note).toContain(CF_CONVERSION_COST_BILLED_CPU_NOTE);
      expect(estimate.sourceUrl).toBe(
        "https://developers.cloudflare.com/workers/platform/pricing/",
      );
      expect(estimate.browserComplete).toBe(false);
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference CPU（このリクエスト wall）",
          quantity: 12,
          unitLabel: "ms",
          usd: 0.00000024,
        },
      ]);
    });

    it("uses factual workerBilledCpuMs when provided on this response", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 12,
        workerBilledCpuMs: 450,
      });
      expect(estimate.billedCpuMs).toBe(450);
      expect(estimate.usd).toBe(0.0000093);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 450 × (0.02 / 1,000,000) = $0.0000093\ncpuMs = workerBilledCpuMs 450 (cpuTime from this response)\nrequests = 1 (this convert)",
      );
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference CPU（このレスポンス cpuTime）",
          quantity: 450,
          unitLabel: "ms",
          usd: 0.000009,
        },
      ]);
    });

    it("adds a new-WS convert request without the Aug-10 upgrade median CPU", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        workerElapsedMs: 12,
      });

      expect(estimate.requests).toBe(2);
      expect(estimate.billedCpuMs).toBe(12);
      expect(estimate.usd).toBe(0.00000084);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 2 × (0.30 / 1,000,000) + 12 × (0.02 / 1,000,000) = $0.00000084\ncpuMs = workerElapsedMs 12 (this request wall; billed cpuTime not on the wire)\nrequests = 2 (this convert + this WebSocket Upgrade)",
      );
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "compare WebSocket Upgrade",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference CPU（このリクエスト wall）",
          quantity: 12,
          unitLabel: "ms",
          usd: 0.00000024,
        },
      ]);
    });

    it("adds this-request compare wall when compareElapsedMs is provided", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        compareElapsedMs: 100,
        workerElapsedMs: 12,
      });
      expect(estimate.billedCpuMs).toBe(112);
      expect(estimate.wallMs).toBe(112);
      expect(estimate.usd).toBe(0.00000254);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 112 × (0.02 / 1,000,000) = $0.00000254\ncpuMs = workerElapsedMs 12 (this request wall; billed cpuTime not on the wire) + compareElapsedMs 100 (this request wall; billed cpuTime not on the wire)\nrequests = 1 (this convert)",
      );
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "compare CPU（このリクエスト wall）",
          quantity: 100,
          unitLabel: "ms",
          usd: 0.000002,
        },
        {
          label: "inference CPU（このリクエスト wall）",
          quantity: 12,
          unitLabel: "ms",
          usd: 0.00000024,
        },
      ]);
    });

    it("uses compareBilledCpuMs instead of compare wall when this response has it", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        compareElapsedMs: 100,
        compareBilledCpuMs: 8,
        workerElapsedMs: 12,
      });
      expect(estimate.requests).toBe(2);
      expect(estimate.billedCpuMs).toBe(20);
      expect(estimate.usd).toBe(0.000001);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 2 × (0.30 / 1,000,000) + 20 × (0.02 / 1,000,000) = $0.000001\ncpuMs = workerElapsedMs 12 (this request wall; billed cpuTime not on the wire) + compareBilledCpuMs 8 (cpuTime from this response)\nrequests = 2 (this convert + this WebSocket Upgrade)",
      );
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "compare WebSocket Upgrade",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "compare CPU（このレスポンス cpuTime）",
          quantity: 8,
          unitLabel: "ms",
          usd: 0.00000016,
        },
        {
          label: "inference CPU（このリクエスト wall）",
          quantity: 12,
          unitLabel: "ms",
          usd: 0.00000024,
        },
      ]);
    });

    it("counts upgrade-only when inference failed before WASM and adds no default 4ms", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        failedBeforeInference: true,
      });
      expect(estimate.requests).toBe(1);
      expect(estimate.billedCpuMs).toBe(0);
      expect(estimate.usd).toBe(0.0000003);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 0 × (0.02 / 1,000,000) = $0.0000003\ncpuMs = 0\nrequests = 1 (this WebSocket Upgrade)",
      );
      expect(estimate.note).toContain("推論前に失敗");
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "compare WebSocket Upgrade",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
      ]);
    });

    it("adds this-request compare wall on a failed-before-inference upgrade", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        failedBeforeInference: true,
        compareElapsedMs: 40,
      });
      expect(estimate.requests).toBe(1);
      expect(estimate.billedCpuMs).toBe(40);
      expect(estimate.usd).toBe(0.0000011);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 40 × (0.02 / 1,000,000) = $0.0000011\ncpuMs = compareElapsedMs 40 (this request wall; billed cpuTime not on the wire)\nrequests = 1 (this WebSocket Upgrade)",
      );
    });

    it("notes external GGUF upstream without inventing upstream cost", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 20,
        usesExternalGgufUpstream: true,
      });
      expect(estimate.note).toContain("外部 GGUF");
      expect(estimate.usd).toBe(0.0000007);
      expect(estimate.formula).toBe(
        "USD = requests × (0.30 / 1,000,000) + cpuMs × (0.02 / 1,000,000)\nUSD = 1 × (0.30 / 1,000,000) + 20 × (0.02 / 1,000,000) = $0.0000007\ncpuMs = workerElapsedMs 20 (this request wall; billed cpuTime not on the wire)\nrequests = 1 (this convert)",
      );
    });

    it("never rounds nonzero totals to zero", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 1,
      });
      expect(estimate.usd).toBe(0.00000032);
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$0.00000032");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toBe("$0");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toBe("$0.00");
    });

    it("matches a real inference tail sample when this response includes cpuTime", () => {
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: false,
        workerElapsedMs: 633,
        workerBilledCpuMs: 450,
      });
      expect(estimate.billedCpuMs).toBe(450);
      expect(estimate.usd).toBe(0.0000093);
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$0.0000093");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toMatch(/[eE]/);
    });

    it("keeps a few hundred this-request CPU-ms plus 1–2 requests far below a cent", () => {
      expect(CF_WORKERS_CPU_USD_PER_MS).toBe(0.02 / 1_000_000);
      expect(150 * CF_WORKERS_CPU_USD_PER_MS).toBeCloseTo(0.000003, 12);
      const estimate = estimateCloudflareConversionCost({
        usedWebSocket: true,
        openedNewWebSocket: true,
        workerBilledCpuMs: 150,
      });
      expect(estimate.requests).toBe(2);
      expect(estimate.billedCpuMs).toBe(150);
      expect(estimate.usd).toBe(0.0000036);
      expect(estimate.usd).toBeGreaterThan(0);
      expect(estimate.usd).toBeLessThan(0.01);
      expect(estimate.usd).toBeLessThan(0.0001);
      expect(estimate.usd).not.toBeCloseTo(3, 0);
      expect(formatCloudflareCostUsd(estimate.usd)).toBe("$0.0000036");
      expect(formatCloudflareCostUsd(estimate.usd)).not.toMatch(/[eE]/);
      expect(estimate.breakdown).toStrictEqual([
        {
          label: "compare WebSocket Upgrade",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference 変換（service binding）",
          quantity: 1,
          unitLabel: "リクエスト",
          usd: 0.0000003,
        },
        {
          label: "inference CPU（このレスポンス cpuTime）",
          quantity: 150,
          unitLabel: "ms",
          usd: 0.000003,
        },
      ]);
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
