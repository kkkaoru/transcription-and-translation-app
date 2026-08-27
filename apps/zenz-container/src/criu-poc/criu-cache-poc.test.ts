// This file runs with bun.
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers-outbound", () => ({
  Container: class {},
  ContainerProxy: class {},
}));

import { cacheSequenceSucceeded, parseOutputNumber } from "./criu-cache-poc";

describe("CRIU Workers Cache probe", () => {
  it("accepts an R2 miss followed by a Workers Cache hit", () => {
    expect(cacheSequenceSucceeded("MISS", "HIT")).toBe(true);
  });

  it("rejects two R2 misses", () => {
    expect(cacheSequenceSucceeded("MISS", "MISS")).toBe(false);
  });

  it("parses a measured checkpoint download", () => {
    expect(parseOutputNumber("workers_cache=HIT\ndownload_ms=4.25\n", "download_ms")).toBe(4.25);
  });

  it("rejects missing measurements", () => {
    expect(() => parseOutputNumber("workers_cache=MISS\n", "archive_bytes")).toThrow(
      "Invalid archive_bytes in restore output",
    );
  });
});
