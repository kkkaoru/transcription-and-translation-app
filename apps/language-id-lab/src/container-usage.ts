// Runs with Bun during build and test.
import type { ComputeTier } from "./container-backend";

interface UsageTotals {
  cpuSeconds: number;
  memoryByteSeconds: number;
  diskByteSeconds: number;
  transmittedBytes: number;
}

interface ContainerPrice {
  tier: ComputeTier;
  vcpu: number;
  memoryGib: number;
  diskGb: number;
  provisionedHourlyUsd: number;
  maximumHourlyUsd: number;
}

export interface CloudflareUsageEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
}

export interface ContainerUsageResponse {
  available: boolean;
  source: "containersUsageAdaptiveGroups";
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
  cpuSeconds: number;
  memoryGibHours: number;
  diskGbHours: number;
  transmittedGb: number;
  grossResourceUsd: number;
  estimatedOverageUsd: number;
  includedUsageApplied: boolean;
  prices: readonly ContainerPrice[];
  detail: string;
}

const GRAPHQL_ENDPOINT: string = "https://api.cloudflare.com/client/v4/graphql";
const MEMORY_USD_PER_GIB_SECOND: number = 0.000_002_5;
const CPU_USD_PER_VCPU_SECOND: number = 0.000_02;
const DISK_USD_PER_GB_SECOND: number = 0.000_000_07;
const BYTES_PER_GIB: number = 1_073_741_824;
const BYTES_PER_GB: number = 1_000_000_000;
const SECONDS_PER_HOUR: number = 3_600;
const INCLUDED_MEMORY_GIB_HOURS: number = 25;
const INCLUDED_CPU_SECONDS: number = 375 * 60;
const INCLUDED_DISK_GB_HOURS: number = 200;
const EMPTY_USAGE: UsageTotals = {
  cpuSeconds: 0,
  memoryByteSeconds: 0,
  diskByteSeconds: 0,
  transmittedBytes: 0,
};
const CONTAINER_USAGE_QUERY: string = `query ContainerUsage($accountTag: String, $dateStart: Date, $dateEnd: Date) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containersUsageAdaptiveGroups(
        limit: 1000
        filter: { date_geq: $dateStart, date_leq: $dateEnd }
      ) {
        sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
      }
    }
  }
}`;

const hourlyPrice = (options: {
  tier: ComputeTier;
  vcpu: number;
  memoryGib: number;
  diskGb: number;
}): ContainerPrice => {
  const provisionedHourlyUsd: number =
    options.memoryGib * MEMORY_USD_PER_GIB_SECOND * SECONDS_PER_HOUR +
    options.diskGb * DISK_USD_PER_GB_SECOND * SECONDS_PER_HOUR;
  return {
    ...options,
    provisionedHourlyUsd,
    maximumHourlyUsd:
      provisionedHourlyUsd + options.vcpu * CPU_USD_PER_VCPU_SECOND * SECONDS_PER_HOUR,
  };
};

export const CONTAINER_PRICES: readonly ContainerPrice[] = [
  hourlyPrice({ tier: "basic", vcpu: 0.25, memoryGib: 1, diskGb: 4 }),
  hourlyPrice({ tier: "standard", vcpu: 0.5, memoryGib: 4, diskGb: 8 }),
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const usageFromGroup = (value: unknown): UsageTotals => {
  if (!isRecord(value) || !isRecord(value.sum)) return EMPTY_USAGE;
  return {
    cpuSeconds: finiteNumber(value.sum.cpuTimeSec),
    memoryByteSeconds: finiteNumber(value.sum.allocatedMemory),
    diskByteSeconds: finiteNumber(value.sum.allocatedDisk),
    transmittedBytes: finiteNumber(value.sum.txBytes),
  };
};

const addUsage = (left: UsageTotals, right: UsageTotals): UsageTotals => ({
  cpuSeconds: left.cpuSeconds + right.cpuSeconds,
  memoryByteSeconds: left.memoryByteSeconds + right.memoryByteSeconds,
  diskByteSeconds: left.diskByteSeconds + right.diskByteSeconds,
  transmittedBytes: left.transmittedBytes + right.transmittedBytes,
});

export const parseContainerUsage = (payload: unknown): UsageTotals => {
  if (!isRecord(payload)) throw new Error("Cloudflare Analytics returned an invalid payload");
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error("Cloudflare Analytics returned a GraphQL error");
  }
  if (!isRecord(payload.data) || !isRecord(payload.data.viewer)) {
    throw new Error("Cloudflare Analytics response is missing viewer data");
  }
  const accounts: unknown = payload.data.viewer.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error("Cloudflare Analytics response is missing account data");
  }
  const groups: unknown[] = accounts.flatMap((account) => {
    if (!isRecord(account) || !Array.isArray(account.containersUsageAdaptiveGroups)) return [];
    return account.containersUsageAdaptiveGroups;
  });
  return groups.map(usageFromGroup).reduce(addUsage, EMPTY_USAGE);
};

const monthStart = (date: Date): string =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);

const dateOnly = (date: Date): string => date.toISOString().slice(0, 10);

const usageResponse = (options: {
  totals: UsageTotals;
  start: string;
  end: string;
  now: Date;
}): ContainerUsageResponse => {
  const memoryGibHours: number =
    options.totals.memoryByteSeconds / BYTES_PER_GIB / SECONDS_PER_HOUR;
  const diskGbHours: number = options.totals.diskByteSeconds / BYTES_PER_GB / SECONDS_PER_HOUR;
  const grossResourceUsd: number =
    options.totals.cpuSeconds * CPU_USD_PER_VCPU_SECOND +
    options.totals.memoryByteSeconds * (MEMORY_USD_PER_GIB_SECOND / BYTES_PER_GIB) +
    options.totals.diskByteSeconds * (DISK_USD_PER_GB_SECOND / BYTES_PER_GB);
  const estimatedOverageUsd: number =
    Math.max(0, options.totals.cpuSeconds - INCLUDED_CPU_SECONDS) * CPU_USD_PER_VCPU_SECOND +
    Math.max(0, memoryGibHours - INCLUDED_MEMORY_GIB_HOURS) *
      MEMORY_USD_PER_GIB_SECOND *
      SECONDS_PER_HOUR +
    Math.max(0, diskGbHours - INCLUDED_DISK_GB_HOURS) * DISK_USD_PER_GB_SECOND * SECONDS_PER_HOUR;
  return {
    available: true,
    source: "containersUsageAdaptiveGroups",
    periodStart: options.start,
    periodEnd: options.end,
    updatedAt: options.now.toISOString(),
    cpuSeconds: options.totals.cpuSeconds,
    memoryGibHours,
    diskGbHours,
    transmittedGb: options.totals.transmittedBytes / BYTES_PER_GB,
    grossResourceUsd,
    estimatedOverageUsd,
    includedUsageApplied: true,
    prices: CONTAINER_PRICES,
    detail:
      "Cloudflare dashboard-aligned Container usage estimate. Final invoice, Workers, Durable Objects, logs, and regional egress can differ.",
  };
};

const unavailableResponse = (now: Date, detail: string): ContainerUsageResponse => ({
  available: false,
  source: "containersUsageAdaptiveGroups",
  periodStart: monthStart(now),
  periodEnd: dateOnly(now),
  updatedAt: now.toISOString(),
  cpuSeconds: 0,
  memoryGibHours: 0,
  diskGbHours: 0,
  transmittedGb: 0,
  grossResourceUsd: 0,
  estimatedOverageUsd: 0,
  includedUsageApplied: false,
  prices: CONTAINER_PRICES,
  detail,
});

export const fetchContainerUsage = async (
  env: CloudflareUsageEnvironment,
  now: Date,
): Promise<ContainerUsageResponse> => {
  if (
    typeof env.CLOUDFLARE_ANALYTICS_TOKEN !== "string" ||
    env.CLOUDFLARE_ANALYTICS_TOKEN.trim() === ""
  ) {
    return unavailableResponse(now, "Set CLOUDFLARE_ANALYTICS_TOKEN with Account Analytics: Read.");
  }
  const start: string = monthStart(now);
  const end: string = dateOnly(now);
  try {
    const response: Response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: CONTAINER_USAGE_QUERY,
        variables: { accountTag: env.CLOUDFLARE_ACCOUNT_ID, dateStart: start, dateEnd: end },
      }),
    });
    if (!response.ok) {
      return unavailableResponse(
        now,
        `Cloudflare Analytics returned HTTP ${String(response.status)}.`,
      );
    }
    const payload: unknown = await response.json();
    return usageResponse({ totals: parseContainerUsage(payload), start, end, now });
  } catch (error) {
    const detail: string = error instanceof Error ? error.message : "Unknown Analytics failure";
    return unavailableResponse(now, detail);
  }
};
