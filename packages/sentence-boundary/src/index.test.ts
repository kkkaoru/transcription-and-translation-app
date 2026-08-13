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

  it("does not treat polite ます auxiliary as a sentence end", () => {
    expect(detectCaptionSentenceEnds("準備を進めています")).toEqual([]);
    expect(detectCaptionSentenceEnds("確認できます")).toEqual([]);
    expect(detectCaptionSentenceEnds("しています")).toEqual([]);
  });

  it("does not split mid-clause ですが / ですので continuations", () => {
    expect(detectCaptionSentenceEnds("晴れですが寒い")).toEqual([]);
    expect(detectCaptionSentenceEnds("晴れですので")).toEqual([]);
    expect(detectCaptionSentenceEnds("だったら行く")).toEqual([]);
    expect(detectCaptionSentenceEnds("ですからね")).toEqual([]);
    expect(detectCaptionSentenceEnds("ですら知らない")).toEqual([]);
    expect(selectVisibleCaptionSentence("ましたら連絡します")).toBe("ましたら連絡します");
    // A 1-scalar tail must not replace a longer finished prefix.
    expect(selectVisibleCaptionSentence("行きましたよ次")).toBe("行きましたよ次");
  });

  it("keeps a long utterance when the span after です/ます is shorter than the lead", () => {
    const thanksThenQuestion =
      "本日はウェビナーにご参加いただきありがとうございます最後に質問をお受けしますね";
    const thanksThenOpen = "本日はウェビナーにご参加いただきありがとうございます最後に質問を";
    expect(selectVisibleCaptionSentence(thanksThenQuestion)).toBe(thanksThenQuestion);
    expect(selectVisibleCaptionSentence(thanksThenOpen)).toBe(thanksThenOpen);
  });

  it("does not page before a prolonged-sound continuation", () => {
    expect(detectCaptionSentenceEnds("こんにちはーきこえますか")).toEqual([]);
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
    const topicThenLong = "明日の天気はこれから午後の予定と明日の議題についての確認";
    expect(selectVisibleCaptionSentence(topicThenLong, { sentenceEndOffsets: [6] })).toBe(
      topicThenLong,
    );
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

  it("pages to the in-progress sentence after punctuation, not a shorter copula tail", () => {
    expect(selectVisibleCaptionSentence("今日は晴れです明日は雨")).toBe("今日は晴れです明日は雨");
    expect(selectVisibleCaptionSentence("今日は晴れです。明日は雨です。")).toBe("明日は雨です。");
  });

  it("keeps a single incomplete utterance intact", () => {
    expect(selectVisibleCaptionSentence("となりのきゃくはよく")).toBe("となりのきゃくはよく");
  });

  it("prefers Vibrato offsets from the native pipeline when the next span dominates", () => {
    expect(selectVisibleCaptionSentence("短いです続く文", { sentenceEndOffsets: [4] })).toBe(
      "短いです続く文",
    );
    const lead = "短いです";
    const tail = "これから午後の予定と明日の議題";
    expect(selectVisibleCaptionSentence(`${lead}${tail}`, { sentenceEndOffsets: [4] })).toBe(tail);
  });

  it("does not page verb/adjective stems until a strong topic restart arrives", () => {
    expect(detectCaptionSentenceEnds("もう走る次いく")).toEqual([]);
    expect(selectVisibleCaptionSentence("もう走る次いく")).toBe("もう走る次いく");
    expect(detectCaptionSentenceEnds("今日は寒い明日は")).toEqual([]);
    expect(selectVisibleCaptionSentence("今日は寒い明日は", { sentenceEndOffsets: [5] })).toBe(
      "今日は寒い明日は",
    );
  });

  it("uses the AzooKey reading only when it is the display surface", () => {
    const reading = "きょうははれですこれから午後の予定と明日の議題についての確認";
    expect(
      detectCaptionSentenceEnds(reading, {
        azookeyInputText: reading,
      }),
    ).toEqual([8]);
    expect(
      detectCaptionSentenceEnds("今日は晴れですこれから午後の予定と明日の議題についての確認", {
        azookeyInputText: reading,
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
      label: "助動詞基本形のあと短い名詞句では切替しない",
      text: "今日は晴れです明日は雨",
      sentenceEndOffsets: [7],
      visible: "今日は晴れです明日は雨",
    },
    {
      label: "動詞基本形+次だけでは切らない",
      text: "もう走る次いく",
      sentenceEndOffsets: [],
      visible: "もう走る次いく",
    },
    {
      label: "形容詞基本形のあと短い主題では切替しない",
      text: "今日は寒い明日は",
      sentenceEndOffsets: [5],
      visible: "今日は寒い明日は",
    },
    {
      label: "終助詞のあと短い主題では切替しない",
      text: "行きましたよ今日は",
      sentenceEndOffsets: [6],
      visible: "行きましたよ今日は",
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
      label: "かなだけのASRでも短い次節では切替しない",
      text: "きょうははれですあしたはあめ",
      sentenceEndOffsets: [8],
      visible: "きょうははれですあしたはあめ",
    },
    {
      label: "かなだけのASRで次節が先頭の2倍以上なら切替",
      text: "きょうははれですこれから午後の予定と明日の議題についての確認",
      sentenceEndOffsets: [8],
      visible: "これから午後の予定と明日の議題についての確認",
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
    expect(detectCaptionSentenceEnds("今日は", {})).toEqual([]);
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

  it("keeps the lead sentence when deferSentencePaging skips copula paging", () => {
    expect(
      selectVisibleCaptionSentence("今日は晴れです明日は雨", { deferSentencePaging: true }),
    ).toBe("今日は晴れです明日は雨");
    expect(
      detectCaptionSentenceEnds("今日は晴れです明日は雨", { deferSentencePaging: true }),
    ).toEqual([]);
    expect(
      selectVisibleCaptionSentence("それはとても良い天気だと思いますね今日は", {
        deferSentencePaging: true,
      }),
    ).toBe("それはとても良い天気だと思いますね今日は");
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
    ).toBe("短いです続く文");
  });
});

describe("soft wrap offsets before maxChars", () => {
  it("marks particle + content as a soft break only after a long enough prefix", () => {
    expect(detectCaptionSoftBreaks("今日は")).toEqual([]);
    expect(detectCaptionSoftBreaks("今日は晴れ")).not.toContain(3);
    const longTopic = "本日の会議の議題は予算です";
    expect(detectCaptionSoftBreaks(longTopic).some((offset) => offset >= 8)).toBe(true);
  });

  it("does not soft-break inside です / でした / でしょう", () => {
    const preview = "これはプレビュー用の字幕です。";
    // Offset 13 would be after で in です — must not wrap there.
    expect(detectCaptionSoftBreaks(preview)).not.toContain(13);
    expect(detectCaptionSoftBreaks("今日は晴れです")).not.toContain(6);
    expect(detectCaptionSoftBreaks("準備でした")).not.toContain(2);
  });

  it("does not soft-break a short prefix away from its same-turn continuation", () => {
    const spoken = "こんにちはきこえますか";
    const soft = detectCaptionSoftBreaks(spoken);
    expect(soft).not.toContain(3);
    expect(soft).not.toContain(5);
    expect(detectCaptionSoftBreaks("こんにちはーきこえますか")).not.toContain(5);
    expect(detectCaptionSoftBreaks("準備です続き", { softBreakOffsets: [3, 5] })).toEqual([]);
    expect(detectCaptionSoftBreaks(spoken, { softBreakOffsets: [3, 5] })).toEqual([]);
  });

  it("prefers supplied Vibrato soft-break offsets after a long enough prefix", () => {
    expect(
      detectCaptionSoftBreaks("本日の会議の議題は予算です", { softBreakOffsets: [8, 12] }),
    ).toEqual([8, 12]);
  });

  it("covers blank input, whitespace-only prefixes, and punctuation soft breaks", () => {
    expect(detectCaptionSoftBreaks("")).toEqual([]);
    expect(detectCaptionSoftBreaks("  ")).toEqual([]);
    expect(detectCaptionSoftBreaks("晴れ。次")).toContain(3);
    expect(detectCaptionSoftBreaks("今日、明日")).toContain(3);
    expect(detectCaptionSoftBreaks("晴れ，次")).toContain(3);
    expect(detectCaptionSoftBreaks("ok, next")).toContain(3);
    expect(
      detectCaptionSoftBreaks("本日の会議", { softBreakOffsets: [0, Number.NaN, 99] }),
    ).toEqual([]);
    expect(
      detectCaptionSentenceEnds("本日の会議", { sentenceEndOffsets: [0, Number.NaN, 99] }),
    ).toEqual([]);
  });
});

const scalarCount = (text: string): number => Array.from(text).length;

const discardedLead = (text: string, visible: string): string => {
  if (visible === text || !text.endsWith(visible)) {
    return "";
  }
  return Array.from(text)
    .slice(0, scalarCount(text) - scalarCount(visible))
    .join("");
};

describe("heuristic paging invariants (unknown utterances)", () => {
  const remainderOwnsPlate = (lead: string, tail: string): boolean =>
    scalarCount(tail) >= 2 * scalarCount(lead);

  it("never pages a copula split unless the next span is at least twice the lead", () => {
    const leads = [
      "準備ができました",
      "説明します",
      "確認です",
      "終わります",
      "学生です",
      "本日は説明します",
      "準備を進めています",
    ];
    const tails = [
      "次",
      "続き",
      "質問を",
      "田中さん",
      "次の議題",
      "きこえますか",
      "これから詳細を共有します",
    ];
    for (const lead of leads) {
      for (const tail of tails) {
        if (remainderOwnsPlate(lead, tail)) {
          continue;
        }
        const text = `${lead}${tail}`;
        const visible = selectVisibleCaptionSentence(text);
        expect(visible, text).toBe(text);
        expect(detectCaptionSentenceEnds(text).every((offset) => offset >= scalarCount(text))).toBe(
          true,
        );
      }
    }
    expect(selectVisibleCaptionSentence("確認です次の議題")).toBe("確認です次の議題");
    expect(selectVisibleCaptionSentence("本日は説明しますこれから詳細を共有します")).toBe(
      "本日は説明しますこれから詳細を共有します",
    );
    expect(selectVisibleCaptionSentence("準備を進めていますこれから詳細を共有します")).toBe(
      "準備を進めていますこれから詳細を共有します",
    );
  });

  it("does not page polite ます stems even when the next span is twice the lead", () => {
    const longTail = "これから午後の予定と明日の議題についての確認";
    const masuStems = [
      "しています",
      "できます",
      "わかります",
      "準備を進めています",
      "確認できます",
    ];
    for (const lead of masuStems) {
      expect(scalarCount(longTail), lead).toBeGreaterThanOrEqual(2 * scalarCount(lead));
      const text = `${lead}${longTail}`;
      expect(selectVisibleCaptionSentence(text), text).toBe(text);
      expect(
        selectVisibleCaptionSentence(text, { sentenceEndOffsets: [scalarCount(lead)] }),
        text,
      ).toBe(text);
      expect(detectCaptionSentenceEnds(text), text).not.toContain(scalarCount(lead));
    }
    expect(selectVisibleCaptionSentence("準備を進めています。次")).toBe("次");
  });

  it("pages after a copula only when the next span is at least twice the lead", () => {
    const lead = "終わりです";
    const tail = "これから午後の予定と明日の議題を確認します";
    expect(scalarCount(tail)).toBeGreaterThanOrEqual(2 * scalarCount(lead));
    expect(selectVisibleCaptionSentence(`${lead}${tail}`)).toBe(tail);
  });

  it("still pages on punctuation even when the next span is shorter", () => {
    expect(selectVisibleCaptionSentence("終わりです。次")).toBe("次");
    expect(selectVisibleCaptionSentence("今日は晴れです。雨")).toBe("雨");
  });

  it("does not honor a 1-scalar pipeline offset that would hide a longer lead", () => {
    expect(selectVisibleCaptionSentence("今日はとて", { sentenceEndOffsets: [4] })).toBe(
      "今日はとて",
    );
    expect(selectVisibleCaptionSentence("行きましたよ次", { sentenceEndOffsets: [6] })).toBe(
      "行きましたよ次",
    );
  });

  it("never pages a Vibrato copula split unless the next span is at least twice the lead", () => {
    const leads = [
      "準備ができました",
      "説明します",
      "確認です",
      "終わります",
      "短いです",
      "準備を進めています",
    ];
    const tails = [
      "次",
      "続き",
      "続く文",
      "質問を",
      "田中さん",
      "次の議題",
      "きこえますか",
      "これから詳細を共有します",
    ];
    for (const lead of leads) {
      for (const tail of tails) {
        if (scalarCount(tail) >= 2 * scalarCount(lead)) {
          continue;
        }
        const text = `${lead}${tail}`;
        const offset = scalarCount(lead);
        expect(selectVisibleCaptionSentence(text, { sentenceEndOffsets: [offset] }), text).toBe(
          text,
        );
        expect(
          detectCaptionSentenceEnds(text, { sentenceEndOffsets: [offset] }).every(
            (end) => end >= scalarCount(text),
          ),
          text,
        ).toBe(true);
      }
    }
  });

  it("pages a Vibrato copula offset only when the next span dominates the lead", () => {
    const lead = "終わりです";
    const tail = "これから午後の予定と明日の議題を確認します";
    expect(scalarCount(tail)).toBeGreaterThanOrEqual(2 * scalarCount(lead));
    expect(
      selectVisibleCaptionSentence(`${lead}${tail}`, { sentenceEndOffsets: [scalarCount(lead)] }),
    ).toBe(tail);
  });

  it("does not page Vibrato copula offsets into a grammatical continuation", () => {
    const lead = "準備ができました";
    const tail = "これから午後の予定と明日の議題を確認します";
    const particles = ["が", "ので", "て", "から", "けど"];
    for (const particle of particles) {
      const text = `${lead}${particle}${tail}`;
      const offset = scalarCount(lead);
      expect(selectVisibleCaptionSentence(text), text).toBe(text);
      expect(selectVisibleCaptionSentence(text, { sentenceEndOffsets: [offset] }), text).toBe(text);
    }
    const tara = `だったら${tail}`;
    expect(selectVisibleCaptionSentence(tara, { sentenceEndOffsets: [3] })).toBe(tara);
  });

  it("visible heuristic text is the full utterance or a remainder that dominates the lead", () => {
    const samples = [
      "確認です次の議題",
      "準備ができました続きを話します",
      "本日は説明しますこれから詳細を共有します",
      "学生です田中さんです",
      "終わりますよろしくお願いします",
    ];
    for (const text of samples) {
      const visible = selectVisibleCaptionSentence(text);
      const lead = discardedLead(text, visible);
      if (!lead) {
        expect(visible).toBe(text);
        continue;
      }
      const punctBoundary = /[。．！？!?]$/u.test(lead);
      expect(punctBoundary || scalarCount(visible) >= 2 * scalarCount(lead), text).toBe(true);
    }
  });
});
