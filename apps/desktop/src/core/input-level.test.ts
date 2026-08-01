import { describe, expect, it } from "vitest";
import {
  clearInputLevelDb,
  getInputLevelDb,
  getInputLevelRevision,
  setInputLevelDb,
  subscribeInputLevel,
} from "./input-level";

describe("input level store", () => {
  it("quantizes and notifies only on meaningful level changes", () => {
    clearInputLevelDb();
    const revisions: number[] = [];
    const unsubscribe = subscribeInputLevel(() => {
      revisions.push(getInputLevelRevision());
    });

    setInputLevelDb(-42.1);
    expect(getInputLevelDb()).toBe(-42);
    setInputLevelDb(-42.2); // same 0.5 dB bucket after quantize? -42.2 * 2 = -84.4 → -84 → -42
    setInputLevelDb(-42.4); // -42.4 * 2 = -84.8 → -85 → -42.5
    expect(getInputLevelDb()).toBe(-42.5);
    setInputLevelDb(null);
    expect(getInputLevelDb()).toBeNull();
    setInputLevelDb(null);
    unsubscribe();

    expect(revisions.length).toBeGreaterThanOrEqual(3);
  });
});
