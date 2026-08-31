// Runs with Bun during test.
import { describe, expect, it } from "vitest";
import { isUiLocale, messagesFor, preferredUiLocale } from "./i18n";

describe("language lab i18n", () => {
  it("provides complete Japanese and English interface copy", () => {
    const japanese = messagesFor("ja");
    const english = messagesFor("en");

    expect(japanese.stableHeading).toBe("現在の安定言語");
    expect(english.stableHeading).toBe("Current stable language");
    expect(japanese.languageNames.unsupported).toBe("未対応言語");
    expect(english.languageNames.unsupported).toBe("Unsupported");
    expect(japanese.scenarios["ja-en-ja"]?.label).toBe("日本語 → 英語 → 日本語");
    expect(english.scenarios["ja-en-ja"]?.label).toBe("JA → EN → JA");
    expect(japanese.microphoneName(2)).toBe("マイク 2");
    expect(english.microphoneName(3)).toBe("Microphone 3");
    expect(japanese.sampledSeconds("2.5")).toBe("2.5秒を表示");
    expect(english.sampledSeconds("1.5")).toBe("1.5s sampled");
    expect(japanese.revision(4)).toBe("リビジョン 4");
    expect(english.revision(5)).toBe("revision 5");
  });

  it("selects Japanese only for Japanese browser locales", () => {
    expect(preferredUiLocale("ja-JP")).toBe("ja");
    expect(preferredUiLocale("JA")).toBe("ja");
    expect(preferredUiLocale("en-US")).toBe("en");
    expect(preferredUiLocale("ko-KR")).toBe("en");
  });

  it("accepts only supported persisted locales", () => {
    expect(isUiLocale("ja")).toBe(true);
    expect(isUiLocale("en")).toBe(true);
    expect(isUiLocale("fr")).toBe(false);
    expect(isUiLocale(null)).toBe(false);
  });
});
