import { describe, expect, it } from "vitest";
import {
  detectCaptionSentenceEnds,
  detectCaptionSoftBreaks,
  selectVisibleCaptionSentence,
} from "./index.js";

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
    // 終助詞のあとに新しい内容語が来たら話し終わり前でもページする
    expect(selectVisibleCaptionSentence("行きましたよ次")).toBe("次");
  });

  it("pages after です/ます when the next span is a new clause (not only strong heads)", () => {
    expect(
      selectVisibleCaptionSentence(
        "本日はウェビナーにご参加いただきありがとうございます最後に質問をお受けしますね",
      ),
    ).toBe("最後に質問をお受けしますね");
    expect(
      selectVisibleCaptionSentence(
        "本日はウェビナーにご参加いただきありがとうございます最後に質問を",
      ),
    ).toBe("最後に質問を");
  });

  it("does not page before a prolonged-sound continuation", () => {
    expect(detectCaptionSentenceEnds("こんにちはーきこえますか")).toEqual([12]);
    expect(selectVisibleCaptionSentence("こんにちはーきこえますか")).toBe(
      "こんにちはーきこえますか",
    );
    expect(
      selectVisibleCaptionSentence("こんにちはーきこえますか", { sentenceEndOffsets: [5] }),
    ).toBe("こんにちはーきこえますか");
  });

  it("keeps greetings with same-turn continuations despite Vibrato offsets", () => {
    expect(
      selectVisibleCaptionSentence("こんにちはきこえますか", { sentenceEndOffsets: [5] }),
    ).toBe("こんにちはきこえますか");
    expect(
      selectVisibleCaptionSentence("明日の天気は晴れ水確率は60%", { sentenceEndOffsets: [6] }),
    ).toBe("明日の天気は晴れ水確率は60%");
  });

  it("does not treat また as a past-tense sentence end", () => {
    expect(detectCaptionSentenceEnds("明日また")).toEqual([]);
  });

  it("does not page past-auxiliary た away from following から", () => {
    const train = "でんしゃがちえんしてたからぼくはがっこうにいかない";
    const weather = "あついひはあついたべものをたべたくない";
    expect(detectCaptionSentenceEnds(train)).toEqual([]);
    expect(selectVisibleCaptionSentence(train)).toBe(train);
    expect(detectCaptionSentenceEnds(weather)).toEqual([]);
    expect(selectVisibleCaptionSentence(weather)).toBe(weather);
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
    expect(detectCaptionSentenceEnds("Hi! yes", { key: "translation" })).toEqual([]);
    expect(selectVisibleCaptionSentence("Hi! Yes", { key: "translation" })).toBe("Yes");
  });
});

describe("heuristic edge cases", () => {
  it("treats empty or whitespace captions as having no visible sentence", () => {
    expect(detectCaptionSentenceEnds("")).toEqual([]);
    expect(detectCaptionSentenceEnds("   ")).toEqual([]);
    expect(detectCaptionSentenceEnds("今日は", { sentenceEndOffsets: undefined })).toEqual([]);
    expect(detectCaptionSentenceEnds("今日は", { azookeyInputText: null })).toEqual([]);
    expect(selectVisibleCaptionSentence("")).toBe("");
    expect(selectVisibleCaptionSentence("   ")).toBe("");
    expect(selectVisibleCaptionSentence("\r\n")).toBe("");
  });

  it("reuses the reading only when the surface itself has no end yet", () => {
    expect(detectCaptionSentenceEnds("きょうは", { azookeyInputText: "きょうは" })).toEqual([]);
    expect(detectCaptionSentenceEnds("です\u0301次", { azookeyInputText: "です\u0301次" })).toEqual(
      [],
    );
  });

  it("keeps a copula followed by punctuation-only remainder as one sentence", () => {
    expect(selectVisibleCaptionSentence("今日は晴れです。")).toBe("今日は晴れです。");
    expect(selectVisibleCaptionSentence("です。あしたは")).toBe("あしたは");
  });

  it("pages finished clauses even while live interim marks deferSentencePaging", () => {
    expect(
      selectVisibleCaptionSentence("今日は晴れです明日は雨", { deferSentencePaging: true }),
    ).toBe("明日は雨");
    expect(
      selectVisibleCaptionSentence("それはとても良い天気だと思いますね今日は", {
        deferSentencePaging: true,
      }),
    ).toBe("今日は");
  });

  it("pages past explicit punctuation and honors Vibrato/IPADIC sentence ends", () => {
    expect(
      selectVisibleCaptionSentence("今日は晴れです。明日は雨", { deferSentencePaging: true }),
    ).toBe("明日は雨");
    expect(
      selectVisibleCaptionSentence("It is sunny today. It will rain tomorrow.", {
        key: "translation",
        deferSentencePaging: true,
      }),
    ).toBe("It will rain tomorrow.");
    expect(
      selectVisibleCaptionSentence("短いです続く文", {
        deferSentencePaging: true,
        sentenceEndOffsets: [4],
      }),
    ).toBe("続く文");
  });
});

describe("soft wrap offsets before maxChars", () => {
  it("marks particle + content as a soft break while trailing particles stay open", () => {
    expect(detectCaptionSoftBreaks("今日は晴れ")).toContain(3);
    expect(detectCaptionSoftBreaks("今日は")).toEqual([]);
  });

  it("does not soft-break inside です / でした / でしょう", () => {
    const preview = "これはプレビュー用の字幕です。";
    // Offset 13 would be after で in です — must not wrap there.
    expect(detectCaptionSoftBreaks(preview)).not.toContain(13);
    expect(detectCaptionSoftBreaks("今日は晴れです")).not.toContain(6);
    expect(detectCaptionSoftBreaks("準備でした")).not.toContain(2);
  });

  it("does not soft-break inside fixed greetings before a continuation", () => {
    const spoken = "こんにちはきこえますか";
    const soft = detectCaptionSoftBreaks(spoken);
    expect(soft).not.toContain(3);
    expect(soft).not.toContain(5);
    expect(detectCaptionSoftBreaks("こんにちはーきこえますか")).not.toContain(5);
    // Interior particle offsets from Vibrato must also be ignored.
    expect(
      detectCaptionSoftBreaks(spoken, { softBreakOffsets: [3, 5] }),
    ).toEqual([]);
  });

  it("prefers supplied Vibrato soft-break offsets", () => {
    expect(detectCaptionSoftBreaks("あいうえお", { softBreakOffsets: [2, 4] })).toEqual([2, 4]);
  });

  it("covers blank input, whitespace-only prefixes, and punctuation soft breaks", () => {
    expect(detectCaptionSoftBreaks("")).toEqual([]);
    expect(detectCaptionSoftBreaks("  ")).toEqual([]);
    expect(detectCaptionSoftBreaks("晴れ。次")).toContain(3);
    expect(detectCaptionSoftBreaks("今日、明日")).toContain(3);
  });
});
