// Runs with Bun during build and test.

export interface ContainerPrice {
  tier: "basic" | "standard";
  vcpu: number;
  memoryGib: number;
  diskGb: number;
  provisionedHourlyUsd: number;
  maximumHourlyUsd: number;
}

export interface ContainerUsage {
  available: boolean;
  source: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberValue = (value: unknown, key: string): number => {
  if (!isRecord(value) || typeof value[key] !== "number") {
    throw new Error(`Container usage is missing ${key}`);
  }
  return value[key];
};

const stringValue = (value: unknown, key: string): string => {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`Container usage is missing ${key}`);
  }
  return value[key];
};

const booleanValue = (value: unknown, key: string): boolean => {
  if (!isRecord(value) || typeof value[key] !== "boolean") {
    throw new Error(`Container usage is missing ${key}`);
  }
  return value[key];
};

const parsePrice = (value: unknown): ContainerPrice => {
  const tier: string = stringValue(value, "tier");
  if (tier !== "basic" && tier !== "standard") throw new Error("Container tier is invalid");
  return {
    tier,
    vcpu: numberValue(value, "vcpu"),
    memoryGib: numberValue(value, "memoryGib"),
    diskGb: numberValue(value, "diskGb"),
    provisionedHourlyUsd: numberValue(value, "provisionedHourlyUsd"),
    maximumHourlyUsd: numberValue(value, "maximumHourlyUsd"),
  };
};

export const parseContainerUsageResponse = (value: unknown): ContainerUsage => {
  if (!isRecord(value) || !Array.isArray(value.prices)) {
    throw new Error("Container usage response is invalid");
  }
  return {
    available: booleanValue(value, "available"),
    source: stringValue(value, "source"),
    periodStart: stringValue(value, "periodStart"),
    periodEnd: stringValue(value, "periodEnd"),
    updatedAt: stringValue(value, "updatedAt"),
    cpuSeconds: numberValue(value, "cpuSeconds"),
    memoryGibHours: numberValue(value, "memoryGibHours"),
    diskGbHours: numberValue(value, "diskGbHours"),
    transmittedGb: numberValue(value, "transmittedGb"),
    grossResourceUsd: numberValue(value, "grossResourceUsd"),
    estimatedOverageUsd: numberValue(value, "estimatedOverageUsd"),
    includedUsageApplied: booleanValue(value, "includedUsageApplied"),
    prices: value.prices.map(parsePrice),
    detail: stringValue(value, "detail"),
  };
};

export const fetchContainerUsage = async (): Promise<ContainerUsage> => {
  const response: Response = await fetch("/api/container-usage");
  if (!response.ok) throw new Error(`Container usage request failed: ${String(response.status)}`);
  const payload: unknown = await response.json();
  return parseContainerUsageResponse(payload);
};
