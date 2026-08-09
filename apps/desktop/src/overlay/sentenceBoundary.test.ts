import { describe, expect, it } from "vitest";
import { detectCaptionSentenceEnds, selectVisibleCaptionSentence } from "./sentenceBoundary";

describe("Japanese sentence-end detection", () => {
  it("treats AzooKey copula endings and punctuation as completing boundaries", () => {
    expect(detectCaptionSentenceEnds("今日は晴れです")).toEqual([7]);
    expect(detectCaptionSentenceEnds("今日は晴れです。")).toEqual([8]);
    expect(detectCaptionSentenceEnds("行きましたよ")).toEqual([6]);
  });

  it("does not split mid-clause ですが / ですので continuations", () => {
    expect(detectCaptionSentenceEnds("晴れですが寒い")).toEqual([]);
    expect(detectCaptionSentenceEnds("晴れですので")).toEqual([]);
    expect(detectCaptionSentenceEnds("だったら行く")).toEqual([]);
    expect(detectCaptionSentenceEnds("ですからね")).toEqual([]);
    expect(detectCaptionSentenceEnds("ですら知らない")).toEqual([]);
    expect(selectVisibleCaptionSentence("ましたら連絡します")).toBe("ましたら連絡します");
    expect(selectVisibleCaptionSentence("行きましたよ次")).toBe("行きましたよ次");
  });

  it("does not treat また as a past-tense sentence end", () => {
    expect(detectCaptionSentenceEnds("明日また")).toEqual([]);
  });

  it("pages to the in-progress sentence after a completed ending", () => {
    expect(selectVisibleCaptionSentence("今日は晴れです明日は雨")).toBe("明日は雨");
    expect(selectVisibleCaptionSentence("今日は晴れです。明日は雨です。")).toBe("明日は雨です。");
  });

  it("keeps a single incomplete utterance intact", () => {
    expect(selectVisibleCaptionSentence("となりのきゃくはよく")).toBe("となりのきゃくはよく");
  });

  it("prefers Vibrato offsets from the native pipeline", () => {
    expect(selectVisibleCaptionSentence("短いです続く文", { sentenceEndOffsets: [4] })).toBe(
      "続く文",
    );
  });

  it("does not page verb/adjective stems until a strong topic restart arrives", () => {
    expect(detectCaptionSentenceEnds("もう走る次いく")).toEqual([]);
    expect(selectVisibleCaptionSentence("もう走る次いく")).toBe("もう走る次いく");
    expect(detectCaptionSentenceEnds("今日は寒い明日は")).toEqual([]);
    expect(selectVisibleCaptionSentence("今日は寒い明日は", { sentenceEndOffsets: [5] })).toBe(
      "明日は",
    );
  });

  it("uses the AzooKey reading only when it is the display surface", () => {
    expect(
      detectCaptionSentenceEnds("きょうははれですあした", {
        azookeyInputText: "きょうははれですあした",
      }),
    ).toEqual([8]);
    expect(
      detectCaptionSentenceEnds("今日は晴れです明日", {
        azookeyInputText: "きょうははれですあした",
      }),
    ).toEqual([7]);
  });
});

describe("Vibrato POS offsets page messy live speech", () => {
  const cases: Array<{
    label: string;
    text: string;
    sentenceEndOffsets: number[];
    visible: string;
  }> = [
    {
      label: "助動詞基本形のあと新しい名詞句へ切替",
      text: "今日は晴れです明日は雨",
      sentenceEndOffsets: [7],
      visible: "明日は雨",
    },
    {
      label: "動詞基本形+次だけでは切らない",
      text: "もう走る次いく",
      sentenceEndOffsets: [],
      visible: "もう走る次いく",
    },
    {
      label: "形容詞基本形のあと切替",
      text: "今日は寒い明日は",
      sentenceEndOffsets: [5],
      visible: "明日は",
    },
    {
      label: "終助詞のあと今日はへ切替",
      text: "行きましたよ今日は",
      sentenceEndOffsets: [6],
      visible: "今日は",
    },
    {
      label: "フィラー＋未完の主題は切らない",
      text: "えー今日は",
      sentenceEndOffsets: [],
      visible: "えー今日は",
    },
    {
      label: "格助詞で途切れた発話は切らない",
      text: "となりのきゃくは",
      sentenceEndOffsets: [],
      visible: "となりのきゃくは",
    },
    {
      label: "連用形て止めは切らない",
      text: "ちょっと待って",
      sentenceEndOffsets: [],
      visible: "ちょっと待って",
    },
    {
      label: "応答と本題は同一発話のまま",
      text: "うん今日行く",
      sentenceEndOffsets: [],
      visible: "うん今日行く",
    },
    {
      label: "かなだけのASRでもオフセットで切替",
      text: "きょうははれですあしたはあめ",
      sentenceEndOffsets: [8],
      visible: "あしたはあめ",
    },
  ];

  it.each(cases)("$label", ({ text, sentenceEndOffsets, visible }) => {
    expect(selectVisibleCaptionSentence(text, { sentenceEndOffsets })).toBe(visible);
  });
});

describe("English sentence paging", () => {
  it("switches after . ? ! without splitting abbreviations mid-token", () => {
    expect(
      selectVisibleCaptionSentence("It is sunny today. It will rain tomorrow.", {
        key: "translation",
      }),
    ).toBe("It will rain tomorrow.");
    expect(selectVisibleCaptionSentence("Hello, world.", { key: "translation" })).toBe(
      "Hello, world.",
    );
  });
});
