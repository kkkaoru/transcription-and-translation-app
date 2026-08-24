// This file runs with bun.
import { describe, expect, it } from "vitest";
import { hasUserLexiconEntries } from "./CustomDictionaryPanel";

describe("CustomDictionaryPanel", () => {
  it("enables the user lexicon only after at least one entry is loaded", () => {
    expect(hasUserLexiconEntries(0)).toBe(false);
    expect(hasUserLexiconEntries(1)).toBe(true);
  });
});
