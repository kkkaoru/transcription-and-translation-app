import { describe, expect, it } from "vitest";
import { AZOOKEY_CONVERSION_FIXTURES, fixtureById } from "./conversion-fixtures";

describe("AzooKey conversion fixtures", () => {
  it("keeps stable unique ids and non-empty readings", () => {
    const ids = AZOOKEY_CONVERSION_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of AZOOKEY_CONVERSION_FIXTURES) {
      expect(fixture.reading.trim().length).toBeGreaterThan(0);
      expect(fixture.expected.trim().length).toBeGreaterThan(0);
      expect(fixtureById(fixture.id)).toEqual(fixture);
    }
  });
});
