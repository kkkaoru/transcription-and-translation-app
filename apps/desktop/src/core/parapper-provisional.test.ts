import { describe, expect, it } from "vitest";
import {
  buildParapperProvisionalCaption,
  buildProvisionalCaptionFromAsrStage,
  pickLatestSuccessfulAsrStage,
} from "./parapper-provisional";

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

  it("maps a successful ASR stage onto a provisional source caption", () => {
    expect(
      buildProvisionalCaptionFromAsrStage(
        {
          stage: "asr",
          ok: true,
          utteranceId: "parapper:s:1:8",
          outputText: "きょうは",
          surfaceText: "今日は",
          startedAt: 10,
          at: 40,
          captureGeneration: 3,
        },
        languages,
      ),
    ).toMatchObject({
      id: "parapper:s:1:8",
      sourceText: "今日は",
      azookeyInputText: "きょうは",
      stage: "source",
      provisional: true,
      startedAt: 10,
      receivedAt: 40,
      captureGeneration: 3,
    });
  });

  it("copies flattened ASR sidecar timestamps onto the provisional caption", () => {
    expect(
      buildProvisionalCaptionFromAsrStage(
        {
          stage: "asr",
          ok: true,
          utteranceId: "parapper:s:1:8",
          outputText: "きょうは",
          startedAt: 10,
          at: 40,
          asrLatency: {
            speech_start_at: 1,
            asr_dispatch_at: 2,
            first_partial_at: 3,
            asr_final_at: null,
          },
        },
        languages,
      )?.asrLatency,
    ).toEqual({
      speech_start_at: 1,
      asr_dispatch_at: 2,
      first_partial_at: 3,
      asr_final_at: null,
    });
  });

  it("ignores failed or non-ASR stages and empty surfaces", () => {
    expect(
      buildProvisionalCaptionFromAsrStage(
        {
          stage: "normalize",
          ok: true,
          utteranceId: "u-1",
          outputText: "今日は",
          startedAt: 1,
          at: 2,
        },
        languages,
      ),
    ).toBeNull();
    expect(
      buildProvisionalCaptionFromAsrStage(
        {
          stage: "asr",
          ok: false,
          utteranceId: "u-1",
          outputText: "今日は",
          startedAt: 1,
          at: 2,
        },
        languages,
      ),
    ).toBeNull();
    expect(
      buildProvisionalCaptionFromAsrStage(
        {
          stage: "asr",
          ok: true,
          utteranceId: "u-1",
          outputText: "  ",
          startedAt: 1,
          at: 2,
        },
        languages,
      ),
    ).toBeNull();
  });
});

describe("pickLatestSuccessfulAsrStage", () => {
  it("picks the newest successful ASR row and ignores failed or empty stages", () => {
    expect(
      pickLatestSuccessfulAsrStage([
        {
          stage: "normalize",
          ok: true,
          utteranceId: "u-old",
          outputText: "正規化",
          startedAt: 1,
          at: 90,
        },
        {
          stage: "asr",
          ok: false,
          utteranceId: "u-fail",
          outputText: "失敗",
          startedAt: 1,
          at: 80,
        },
        {
          stage: "asr",
          ok: true,
          utteranceId: "u-1",
          outputText: "きょうは",
          surfaceText: "今日は",
          startedAt: 10,
          at: 40,
        },
        {
          stage: "asr",
          ok: true,
          utteranceId: "u-2",
          outputText: "はれです",
          startedAt: 50,
          at: 70,
        },
        {
          stage: "asr",
          ok: true,
          utteranceId: "u-empty",
          outputText: "  ",
          startedAt: 1,
          at: 100,
        },
      ])?.utteranceId,
    ).toBe("u-2");
  });

  it("returns null when history has no paintable ASR", () => {
    expect(pickLatestSuccessfulAsrStage([])).toBeNull();
    expect(
      pickLatestSuccessfulAsrStage([
        {
          stage: "translate",
          ok: true,
          utteranceId: "u-1",
          outputText: "Hello",
          startedAt: 1,
          at: 2,
        },
      ]),
    ).toBeNull();
  });

  it("keeps a longer same-id ASR surface over a later truncated hearing-check tail", () => {
    const longer = {
      stage: "asr" as const,
      ok: true,
      utteranceId: "parapper:s:1:8",
      outputText: "こんにちはきこえますか",
      startedAt: 10,
      at: 40,
      asrLatency: { speech_start_at: 1, first_partial_at: 20 },
    };
    const truncated = {
      stage: "asr" as const,
      ok: true,
      utteranceId: "parapper:s:1:8",
      outputText: "きこえますか",
      startedAt: 10,
      at: 80,
    };
    expect(pickLatestSuccessfulAsrStage([longer, truncated])?.outputText).toBe(
      "こんにちはきこえますか",
    );
    expect(pickLatestSuccessfulAsrStage([truncated, longer])?.outputText).toBe(
      "こんにちはきこえますか",
    );
  });

  it("folds a same-id disjoint tail onto the lead instead of keep-longer of the lead", () => {
    const lead = {
      stage: "asr" as const,
      ok: true,
      utteranceId: "parapper:s:1:8",
      outputText: "会議を始めます",
      startedAt: 10,
      at: 40,
    };
    const tail = {
      stage: "asr" as const,
      ok: true,
      utteranceId: "parapper:s:1:8",
      outputText: "続きがあります",
      startedAt: 10,
      at: 80,
    };
    const picked = pickLatestSuccessfulAsrStage([lead, tail]);
    expect(picked?.outputText).toContain("会議を始めます");
    expect(picked?.outputText).toContain("続きがあります");
  });

  it("still prefers the newest turn when a later utterance is shorter", () => {
    expect(
      pickLatestSuccessfulAsrStage([
        {
          stage: "asr",
          ok: true,
          utteranceId: "parapper:s:1:8",
          outputText: "こんにちはきこえますか",
          startedAt: 10,
          at: 40,
        },
        {
          stage: "asr",
          ok: true,
          utteranceId: "parapper:s:1:9",
          outputText: "はい",
          startedAt: 90,
          at: 100,
        },
      ])?.utteranceId,
    ).toBe("parapper:s:1:9");
  });
});
