// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import { CONTAINER_PRICES, fetchContainerUsage, parseContainerUsage } from "./container-usage";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("parses and sums Cloudflare Container usage groups", () => {
  expect(
    parseContainerUsage({
      data: {
        viewer: {
          accounts: [
            {
              containersUsageAdaptiveGroups: [
                {
                  sum: {
                    cpuTimeSec: 10,
                    allocatedMemory: 1_073_741_824,
                    allocatedDisk: 4_000_000_000,
                    txBytes: 100,
                  },
                },
                {
                  sum: {
                    cpuTimeSec: 5,
                    allocatedMemory: 2_147_483_648,
                    allocatedDisk: 8_000_000_000,
                    txBytes: 200,
                  },
                },
              ],
            },
          ],
        },
      },
      errors: null,
    }),
  ).toStrictEqual({
    cpuSeconds: 15,
    memoryByteSeconds: 3_221_225_472,
    diskByteSeconds: 12_000_000_000,
    transmittedBytes: 300,
  });
});

it("rejects malformed and GraphQL error responses", () => {
  expect(() => parseContainerUsage(null)).toThrow("invalid payload");
  expect(() => parseContainerUsage({ errors: [{ message: "denied" }] })).toThrow("GraphQL error");
  expect(() => parseContainerUsage({ data: {} })).toThrow("missing viewer data");
});

it("publishes Basic and Standard list-rate hourly bounds", () => {
  expect(CONTAINER_PRICES[0].tier).toBe("basic");
  expect(CONTAINER_PRICES[0].vcpu).toBe(0.25);
  expect(CONTAINER_PRICES[0].memoryGib).toBe(1);
  expect(CONTAINER_PRICES[0].diskGb).toBe(4);
  expect(CONTAINER_PRICES[0].provisionedHourlyUsd).toBeCloseTo(0.010008);
  expect(CONTAINER_PRICES[0].maximumHourlyUsd).toBeCloseTo(0.028008);
  expect(CONTAINER_PRICES[1].tier).toBe("standard");
  expect(CONTAINER_PRICES[1].vcpu).toBe(0.5);
  expect(CONTAINER_PRICES[1].memoryGib).toBe(4);
  expect(CONTAINER_PRICES[1].diskGb).toBe(8);
  expect(CONTAINER_PRICES[1].provisionedHourlyUsd).toBeCloseTo(0.038016);
  expect(CONTAINER_PRICES[1].maximumHourlyUsd).toBeCloseTo(0.074016);
});

it("returns an unavailable response without an Analytics token", async () => {
  const response = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_ANALYTICS_TOKEN: "" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(response.available).toBe(false);
  expect(response.periodStart).toBe("2026-08-01");
  expect(response.periodEnd).toBe("2026-08-31");
  expect(response.detail).toBe("Set CLOUDFLARE_ANALYTICS_TOKEN with Account Analytics: Read.");
});

it("calculates gross and included-usage overage from live Analytics values", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  containersUsageAdaptiveGroups: [
                    {
                      sum: {
                        cpuTimeSec: 22_501,
                        allocatedMemory: 100_000 * 1_073_741_824,
                        allocatedDisk: 800_000 * 1_000_000_000,
                        txBytes: 1_000_000_000,
                      },
                    },
                  ],
                },
              ],
            },
          },
          errors: null,
        }),
      ),
    ),
  );
  const response = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_ANALYTICS_TOKEN: "token" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(response.available).toBe(true);
  expect(response.cpuSeconds).toBe(22_501);
  expect(response.memoryGibHours).toBeCloseTo(27.7777777778);
  expect(response.diskGbHours).toBeCloseTo(222.2222222222);
  expect(response.transmittedGb).toBe(1);
  expect(response.estimatedOverageUsd).toBeGreaterThan(0);
});

it("normalizes malformed groups and rejects missing accounts", () => {
  expect(() => parseContainerUsage({ data: { viewer: { accounts: null } }, errors: [] })).toThrow(
    "missing account data",
  );
  expect(
    parseContainerUsage({
      data: {
        viewer: {
          accounts: [null, {}, { containersUsageAdaptiveGroups: [null, { sum: null }] }],
        },
      },
      errors: [],
    }),
  ).toStrictEqual({
    cpuSeconds: 0,
    memoryByteSeconds: 0,
    diskByteSeconds: 0,
    transmittedBytes: 0,
  });
  expect(
    parseContainerUsage({
      data: {
        viewer: {
          accounts: [
            {
              containersUsageAdaptiveGroups: [
                {
                  sum: {
                    cpuTimeSec: -1,
                    allocatedMemory: Number.NaN,
                    allocatedDisk: "invalid",
                    txBytes: Number.POSITIVE_INFINITY,
                  },
                },
              ],
            },
          ],
        },
      },
      errors: [],
    }),
  ).toStrictEqual({
    cpuSeconds: 0,
    memoryByteSeconds: 0,
    diskByteSeconds: 0,
    transmittedBytes: 0,
  });
});

it("reports Analytics HTTP, GraphQL, and transport failures without inventing usage", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(null, { status: 503 }))),
  );
  const httpFailure = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_ANALYTICS_TOKEN: "token" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(httpFailure.available).toBe(false);
  expect(httpFailure.detail).toBe("Cloudflare Analytics returned HTTP 503.");

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ errors: [{ message: "denied" }] }))),
  );
  const graphqlFailure = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_ANALYTICS_TOKEN: "token" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(graphqlFailure.detail).toBe("Cloudflare Analytics returned a GraphQL error");

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject("offline")),
  );
  const transportFailure = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_ANALYTICS_TOKEN: "token" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(transportFailure.detail).toBe("Unknown Analytics failure");
});

it("treats a missing token as unavailable", async () => {
  const response = await fetchContainerUsage(
    { CLOUDFLARE_ACCOUNT_ID: "account" },
    new Date("2026-08-31T12:00:00.000Z"),
  );
  expect(response.available).toBe(false);
});
