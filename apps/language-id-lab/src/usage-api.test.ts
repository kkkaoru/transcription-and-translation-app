// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import { fetchContainerUsage, parseContainerUsageResponse } from "./usage-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("validates dynamic Container usage and hourly prices", () => {
  expect(
    parseContainerUsageResponse({
      available: true,
      source: "containersUsageAdaptiveGroups",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      updatedAt: "2026-08-31T12:00:00.000Z",
      cpuSeconds: 2,
      memoryGibHours: 3,
      diskGbHours: 4,
      transmittedGb: 5,
      grossResourceUsd: 0.1,
      estimatedOverageUsd: 0,
      includedUsageApplied: true,
      prices: [
        {
          tier: "basic",
          vcpu: 0.25,
          memoryGib: 1,
          diskGb: 4,
          provisionedHourlyUsd: 0.010008,
          maximumHourlyUsd: 0.028008,
        },
      ],
      detail: "estimate",
    }),
  ).toStrictEqual({
    available: true,
    source: "containersUsageAdaptiveGroups",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    updatedAt: "2026-08-31T12:00:00.000Z",
    cpuSeconds: 2,
    memoryGibHours: 3,
    diskGbHours: 4,
    transmittedGb: 5,
    grossResourceUsd: 0.1,
    estimatedOverageUsd: 0,
    includedUsageApplied: true,
    prices: [
      {
        tier: "basic",
        vcpu: 0.25,
        memoryGib: 1,
        diskGb: 4,
        provisionedHourlyUsd: 0.010008,
        maximumHourlyUsd: 0.028008,
      },
    ],
    detail: "estimate",
  });
});

it("rejects malformed usage payloads and tiers", () => {
  expect(() => parseContainerUsageResponse(null)).toThrow("response is invalid");
  expect(() => parseContainerUsageResponse({ prices: [] })).toThrow("missing available");
  expect(() =>
    parseContainerUsageResponse({
      available: true,
      source: "source",
      periodStart: "start",
      periodEnd: "end",
      updatedAt: "now",
      cpuSeconds: 0,
      memoryGibHours: 0,
      diskGbHours: 0,
      transmittedGb: 0,
      grossResourceUsd: 0,
      estimatedOverageUsd: 0,
      includedUsageApplied: true,
      prices: [
        {
          tier: "premium",
          vcpu: 1,
          memoryGib: 1,
          diskGb: 1,
          provisionedHourlyUsd: 1,
          maximumHourlyUsd: 1,
        },
      ],
      detail: "detail",
    }),
  ).toThrow("tier is invalid");
});

it("rejects missing string and numeric usage fields", () => {
  const valid = {
    available: true,
    source: "source",
    periodStart: "start",
    periodEnd: "end",
    updatedAt: "now",
    cpuSeconds: 0,
    memoryGibHours: 0,
    diskGbHours: 0,
    transmittedGb: 0,
    grossResourceUsd: 0,
    estimatedOverageUsd: 0,
    includedUsageApplied: true,
    prices: [],
    detail: "detail",
  };
  expect(() => parseContainerUsageResponse({ ...valid, source: null })).toThrow("missing source");
  expect(() => parseContainerUsageResponse({ ...valid, cpuSeconds: null })).toThrow(
    "missing cpuSeconds",
  );
  expect(() => parseContainerUsageResponse({ ...valid, includedUsageApplied: null })).toThrow(
    "missing includedUsageApplied",
  );
  expect(() => parseContainerUsageResponse({})).toThrow("response is invalid");
});

it("fetches and validates live Container usage", async () => {
  const payload = {
    available: false,
    source: "containersUsageAdaptiveGroups",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    updatedAt: "2026-08-31T12:00:00.000Z",
    cpuSeconds: 0,
    memoryGibHours: 0,
    diskGbHours: 0,
    transmittedGb: 0,
    grossResourceUsd: 0,
    estimatedOverageUsd: 0,
    includedUsageApplied: false,
    prices: [],
    detail: "token unavailable",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(payload))),
  );
  await expect(fetchContainerUsage()).resolves.toStrictEqual(payload);

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
  );
  await expect(fetchContainerUsage()).rejects.toThrow("request failed: 503");
});
