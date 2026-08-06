import { describe, expect, it } from "vitest";
import { DESKTOP_AZOOKEY_FIXTURES, fixtureById } from "./desktop-fixtures";

describe("desktop AzooKey fixtures", () => {
  it("exposes unique ids and non-empty readings for each case", () => {
    const ids = DESKTOP_AZOOKEY_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of DESKTOP_AZOOKEY_FIXTURES) {
      expect(fixture.reading.trim().length).toBeGreaterThan(0);
      expect(fixture.expected.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the Item 2 natural-conversion regressions", () => {
    expect(fixtureById("totemo")).toMatchObject({ reading: "とても", expected: "とても" });
    expect(fixtureById("soup-wa")).toMatchObject({ reading: "すーぷは", expected: "スープは" });
    expect(fixtureById("greeting-okure")).toMatchObject({
      reading: "おつかれさまでした",
      expected: "お疲れ様でした",
    });
  });

  it("returns undefined for unknown fixture ids", () => {
    expect(fixtureById("missing")).toBeUndefined();
  });
});
