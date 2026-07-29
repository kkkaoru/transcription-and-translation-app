import { describe, expect, it } from "vitest";
import { messages, resolveLocale, translate } from "./messages";

describe("i18n messages", () => {
  it("keeps Japanese and English dictionaries aligned", () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.ja).sort());
  });

  it("resolves supported locales with Japanese as the fallback", () => {
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("fr")).toBe("ja");
    expect(resolveLocale(undefined)).toBe("ja");
  });

  it("translates and interpolates message parameters", () => {
    expect(translate("ja", "audio.fallbackDevice", { number: 2 })).toBe("マイク 2");
    expect(translate("en", "audio.fallbackDevice", { number: 2 })).toBe("Microphone 2");
    expect(translate("en", "settings.title")).toBe("Settings");
  });
});
