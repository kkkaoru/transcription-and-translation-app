import { describe, expect, it } from "vitest";
import { visibleWebSpeechCaption } from "./speech-caption-display";

describe("visibleWebSpeechCaption", () => {
  it("pages after a finished Japanese sentence like Tauri overlay", () => {
    expect(visibleWebSpeechCaption("こんにちは。聞こえますか", "聞こえますか")).toBe(
      "聞こえますか",
    );
    expect(visibleWebSpeechCaption("今日は晴れです 明日のご飯は", "明日のご飯は")).toBe(
      "明日のご飯は",
    );
  });

  it("resets to the latest Web Speech final when the dump has no sentence end", () => {
    const dump =
      "こんにちは 聞こえますか 隣の客はよく柿食う客だ 暑い日は暑い食べ物を食べたくない 明日のご飯は";
    expect(visibleWebSpeechCaption(dump, "明日のご飯は")).toBe("明日のご飯は");
  });

  it("keeps an in-progress first utterance", () => {
    expect(visibleWebSpeechCaption("こんにちは", "こんにちは")).toBe("こんにちは");
    expect(visibleWebSpeechCaption("")).toBe("");
  });
});
