import { describe, expect, it } from "vitest";
import { buildParapperProvisionalCaption } from "./parapper-provisional";

describe("buildParapperProvisionalCaption", () => {
  const languages = { sourceLanguage: "ja", targetLanguage: "en" };

  it("paints surface text immediately as a provisional source caption", () => {
    const caption = buildParapperProvisionalCaption(
      {
        text: "きょうは",
        sourceText: "今日は",
        azookeyInputText: "きょうは",
        sessionId: "s1",
        turnSessionId: 1,
        turnId: 2,
        elapsedMs: 120,
        isFinal: false,
        captureGeneration: 9,
      },
      languages,
      1_000,
    );

    expect(caption).toMatchObject({
      id: "parapper:s1:1:2",
      sourceText: "今日は",
      azookeyInputText: "きょうは",
      startedAt: 880,
      receivedAt: 1_000,
      stage: "source",
      sequence: 0,
      isFinal: false,
      provisional: true,
      captureGeneration: 9,
    });
  });

  it("falls back to azookeyInputText then text when surface is empty", () => {
    expect(
      buildParapperProvisionalCaption(
        {
          text: "あしたは",
          sourceText: "   ",
          azookeyInputText: "あしたは",
          sessionId: "s1",
          turnSessionId: 0,
          turnId: 0,
          elapsedMs: 0,
          isFinal: false,
        },
        languages,
        500,
      )?.sourceText,
    ).toBe("あしたは");

    expect(
      buildParapperProvisionalCaption(
        {
          text: "はれ",
          sourceText: "",
          azookeyInputText: "  ",
          sessionId: "s1",
          turnSessionId: 0,
          turnId: 1,
          elapsedMs: 10,
          isFinal: true,
        },
        languages,
        500,
      )?.sourceText,
    ).toBe("はれ");
  });

  it("returns null when there is no paintable text", () => {
    expect(
      buildParapperProvisionalCaption(
        {
          text: "   ",
          sourceText: "",
          azookeyInputText: null,
          sessionId: "s1",
          turnSessionId: 0,
          turnId: 0,
          elapsedMs: 0,
          isFinal: false,
        },
        languages,
      ),
    ).toBeNull();
  });

  it("strips Parapper continuation markers from the provisional surface", () => {
    expect(
      buildParapperProvisionalCaption(
        {
          text: "今日は...",
          sourceText: "今日は...",
          sessionId: "s1",
          turnSessionId: 1,
          turnId: 1,
          elapsedMs: 0,
          isFinal: false,
        },
        languages,
        1,
      )?.sourceText,
    ).toBe("今日は");
  });
});
