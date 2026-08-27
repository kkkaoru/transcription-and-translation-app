// This file runs with bun.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));

import { identitiesMatch, parseSnapshotDescriptor, startupDeltaPercent } from "./snapshot-poc";

describe("Container snapshot probe", () => {
  it("accepts a complete snapshot handle read from Cloudflare Cache", () => {
    expect(
      parseSnapshotDescriptor({
        id: "snapshot-123",
        size: 4096,
        name: "zenz-xsmall",
      }),
    ).toStrictEqual({
      id: "snapshot-123",
      size: 4096,
      name: "zenz-xsmall",
    });
  });

  it("accepts a snapshot handle without a name", () => {
    expect(
      parseSnapshotDescriptor({
        id: "snapshot-456",
        size: 0,
        name: null,
      }),
    ).toStrictEqual({
      id: "snapshot-456",
      size: 0,
      name: null,
    });
  });

  it("rejects malformed cached snapshot metadata", () => {
    expect(
      parseSnapshotDescriptor({
        id: "snapshot-789",
        size: "4096",
        name: "zenz-xsmall",
      }),
    ).toBeNull();
  });

  it("reports the startup reduction relative to a cold control", () => {
    expect(startupDeltaPercent(2000, 1500)).toBe(25);
  });

  it("requires both VM and process identity evidence to match", () => {
    expect(
      identitiesMatch(
        { processStartTicks: "120", bootId: "boot-123" },
        { processStartTicks: "120", bootId: "boot-123" },
      ),
    ).toBe(true);
    expect(
      identitiesMatch(
        { processStartTicks: "120", bootId: "boot-123" },
        { processStartTicks: "120", bootId: "boot-456" },
      ),
    ).toBe(false);
  });

  it("rejects missing process identity evidence", () => {
    expect(
      identitiesMatch(
        { processStartTicks: "missing", bootId: "boot-123" },
        { processStartTicks: "missing", bootId: "boot-123" },
      ),
    ).toBe(false);
  });
});
