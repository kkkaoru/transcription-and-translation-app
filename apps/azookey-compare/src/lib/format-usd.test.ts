import { describe, expect, it } from "vitest";
import { formatDecimalUsd } from "./format-usd";

describe("formatDecimalUsd", () => {
  it("returns $0 for zero, negative, and non-finite", () => {
    expect(formatDecimalUsd(0)).toBe("$0");
    expect(formatDecimalUsd(-1)).toBe("$0");
    expect(formatDecimalUsd(Number.NaN)).toBe("$0");
    expect(formatDecimalUsd(Number.POSITIVE_INFINITY)).toBe("$0");
  });

  it("formats whole dollars without a trailing decimal point", () => {
    expect(formatDecimalUsd(10)).toBe("$10");
    expect(formatDecimalUsd(1)).toBe("$1");
    expect(formatDecimalUsd(1.5)).toBe("$1.5");
  });

  it("returns $0 when the amount is smaller than 16 decimal places", () => {
    expect(formatDecimalUsd(1e-20)).toBe("$0");
  });

  it("never uses scientific or hex notation for 1e-12 .. 10", () => {
    const samples = [1e-12, 2.6e-7, 4.8e-7, 0.00000026, 0.00000125, 0.0000093, 0.0052, 1, 10];
    for (const usd of samples) {
      const formatted = formatDecimalUsd(usd);
      expect(formatted.startsWith("$")).toBe(true);
      expect(formatted).not.toMatch(/[eE]/);
      expect(formatted).not.toMatch(/\$[0-9.]*[eE]/);
      expect(formatted).not.toMatch(/0x/i);
      expect(formatted).not.toBe("$0");
      expect(formatted).not.toBe("$0.00");
    }
  });

  it("keeps tiny Nova-3 ASR amounts readable as decimals", () => {
    expect(formatDecimalUsd(0.000_000_26)).toBe("$0.00000026");
    expect(formatDecimalUsd(2.6e-7)).toBe("$0.00000026");
  });

  it("keeps micro-dollar conversion totals readable as decimals", () => {
    expect(formatDecimalUsd(4.8e-7)).toBe("$0.00000048");
    expect(formatDecimalUsd(0.00000125)).toBe("$0.00000125");
    expect(formatDecimalUsd(0.0000093)).toBe("$0.0000093");
  });
});
