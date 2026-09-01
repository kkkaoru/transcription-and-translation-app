// Runs with Bun during test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayLanguageName, isUiLocale, messagesFor, preferredUiLocale } from "./i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("language-id-lab i18n", () => {
  it("provides complete English and Japanese operational copy", () => {
    const english = messagesFor("en");
    const japanese = messagesFor("ja");

    expect(english.heroTitle).toBe("Speak. See the evidence change.");
    expect(japanese.heroTitle).toBe("話す。推論の変化を見る。");
    expect(english.rollingPattern).toBe("Rolling 6 s context");
    expect(japanese.rollingPattern).toBe("直近6秒の文脈");
    expect(english.seconds("1.25")).toBe("1.25 s");
    expect(japanese.seconds("1.25")).toBe("1.25秒");
    expect(english.perHour("0.01")).toBe("$0.01/h");
    expect(japanese.perHour("0.01")).toBe("$0.01/時");
    expect(english.microphoneName(2)).toBe("Microphone 2");
    expect(japanese.microphoneName(2)).toBe("マイク 2");
    expect(english.temporalStatePosterior).toBe("Temporal language state posterior");
    expect(japanese.temporalStatePosterior).toBe("時間平滑化した言語状態確率");
    expect(english.sprtAccumulating).toBe("Accumulating evidence");
    expect(japanese.hysteresisChallenged).toBe("対抗言語が維持閾値以上");
    expect(english.muteMicrophone).toBe("Mute");
    expect(japanese.unmuteMicrophone).toBe("ミュート解除");
  });

  it("resolves UI locale and multilingual display names", () => {
    expect(preferredUiLocale("ja-JP")).toBe("ja");
    expect(preferredUiLocale("en-US")).toBe("en");
    expect(preferredUiLocale("ko-KR")).toBe("en");
    expect(isUiLocale("ja")).toBe(true);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("fr")).toBe(false);
    expect(isUiLocale(null)).toBe(false);
    expect(displayLanguageName("unknown", "en")).toBe("Unknown");
    expect(displayLanguageName("unknown", "ja")).toBe("不明");
    expect(displayLanguageName("ko", "en")).toBe("Korean");
    expect(displayLanguageName("ko", "ja")).toBe("韓国語");
    vi.spyOn(Intl.DisplayNames.prototype, "of").mockReturnValue(undefined);
    expect(displayLanguageName("xy", "en")).toBe("XY");
  });
});
