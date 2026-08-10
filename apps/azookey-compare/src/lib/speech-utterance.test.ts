import { describe, expect, it } from "vitest";
import { pendingSpeechUtterance, rememberDispatchedSpeech } from "./speech-utterance";

describe("pendingSpeechUtterance", () => {
  it("flushes leftover interim when recognition ends without isFinal", () => {
    expect(pendingSpeechUtterance("", "きょうははれ", [])).toBe("きょうははれ");
    expect(pendingSpeechUtterance("こんにちは", "きょうははれ", ["こんにちは"])).toBe(
      "きょうははれ",
    );
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
  });

  it("skips blank transcripts", () => {
    expect(pendingSpeechUtterance("   ", "  ", [])).toBeUndefined();
    expect(pendingSpeechUtterance("", "", [])).toBeUndefined();
  });

  it("dedupes rememberDispatchedSpeech", () => {
    expect(rememberDispatchedSpeech([], "  こんにちは  ")).toEqual(["こんにちは"]);
    expect(rememberDispatchedSpeech(["こんにちは"], "こんにちは")).toEqual(["こんにちは"]);
  });
});
