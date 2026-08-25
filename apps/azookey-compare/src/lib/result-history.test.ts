// This file runs with bun.
import { describe, expect, it } from "vitest";
import { prependResultHistory } from "./result-history";

describe("recognition result history", () => {
  it("places the newest recognition result first", () => {
    expect(prependResultHistory([2, 1], 3)).toStrictEqual([3, 2, 1]);
  });

  it("bounds retained recognition results", () => {
    const existing = Array.from({ length: 100 }, (_, index) => 100 - index);
    const history = prependResultHistory(existing, 101);

    expect(history.length).toBe(100);
    expect(history[0]).toBe(101);
    expect(history[99]).toBe(2);
  });
});
