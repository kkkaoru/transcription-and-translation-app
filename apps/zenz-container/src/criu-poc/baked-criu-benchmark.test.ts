// This file runs with bun.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers-outbound", () => ({ Container: class {} }));

import { fasterMode } from "./baked-criu-benchmark";

describe("Baked CRIU cold-start benchmark", () => {
  it("selects normal startup when total latency is lower", () => {
    expect(
      fasterMode(
        {
          recordedAt: "2026-08-27T00:00:00.000Z",
          mode: "normal",
          readyMs: 400,
          firstCompletionMs: 100,
          totalMs: 500,
          healthStatus: 200,
          completionStatus: 200,
        },
        {
          recordedAt: "2026-08-27T00:00:01.000Z",
          mode: "baked-criu",
          readyMs: 500,
          firstCompletionMs: 100,
          totalMs: 600,
          healthStatus: 200,
          completionStatus: 200,
        },
      ),
    ).toBe("normal");
  });

  it("selects baked CRIU startup when total latency is lower", () => {
    expect(
      fasterMode(
        {
          recordedAt: "2026-08-27T00:00:00.000Z",
          mode: "normal",
          readyMs: 700,
          firstCompletionMs: 200,
          totalMs: 900,
          healthStatus: 200,
          completionStatus: 200,
        },
        {
          recordedAt: "2026-08-27T00:00:01.000Z",
          mode: "baked-criu",
          readyMs: 400,
          firstCompletionMs: 100,
          totalMs: 500,
          healthStatus: 200,
          completionStatus: 200,
        },
      ),
    ).toBe("baked-criu");
  });
});
