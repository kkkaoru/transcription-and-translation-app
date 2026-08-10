import { describe, expect, it } from "vitest";
import { pendingSpeechUtterance, rememberDispatchedSpeech } from "./speech-utterance";

describe("pendingSpeechUtterance", () => {
  it("flushes leftover interim when recognition ends without isFinal", () => {
    expect(pendingSpeechUtterance("", "きょうははれ", [])).toBe("きょうははれ");
    expect(pendingSpeechUtterance("こんにちは", "きょうははれ", ["こんにちは"])).toBe(
      "きょうははれ",
    );
    expect(pendingSpeechUtterance("final", "interim", ["interim"])).toBe("final");
  });

  it("does not re-emit a final that onFinalText already dispatched", () => {
    expect(pendingSpeechUtterance("こんにちは", "", ["こんにちは"])).toBeUndefined();
    expect(
      pendingSpeechUtterance("こんにちは きょうははれ", "", ["こんにちは", "きょうははれ"]),
    ).toBe(undefined);
  });

  it("emits only the undispatched tail of accumulated finals", () => {
    expect(pendingSpeechUtterance("こんにちは きょうははれ", "", ["こんにちは"])).toBe(
      "きょうははれ",
    );
    expect(pendingSpeechUtterance("きょうははれ", "", [])).toBe("きょうははれ");
    expect(pendingSpeechUtterance("hello", "", ["hell"])).toBe("o");
  });

  it("skips blank transcripts", () => {
    expect(pendingSpeechUtterance("   ", "  ", [])).toBeUndefined();
    expect(pendingSpeechUtterance("", "", [])).toBeUndefined();
  });

  it("dedupes rememberDispatchedSpeech", () => {
    expect(rememberDispatchedSpeech([], "  こんにちは  ")).toEqual(["こんにちは"]);
    expect(rememberDispatchedSpeech(["こんにちは"], "こんにちは")).toEqual(["こんにちは"]);
    expect(rememberDispatchedSpeech([], "   ")).toEqual([]);
  });

  it("suppresses recognition-end tails already represented by the last dispatch", () => {
    expect(pendingSpeechUtterance("きょうははれ", "", ["きょうははれ"])).toBeUndefined();
    expect(pendingSpeechUtterance("前文 きょうははれ", "", ["きょうははれ"])).toBeUndefined();
    expect(pendingSpeechUtterance("別文", "", ["こんにちは"])).toBe("別文");
    expect(pendingSpeechUtterance("きょうははれ", "", [])).toBe("きょうははれ");
    expect(pendingSpeechUtterance("追加のみ", "", ["こんにちは"])).toBe("追加のみ");
  });
});
