import { describe, expect, it } from "vitest";
import { AZOOKEY_CONVERSION_FIXTURES, fixtureById } from "./conversion-fixtures";

describe("AzooKey conversion fixtures", () => {
  it("keeps unique ids and the Tauri-aligned weather spot check", () => {
    expect(AZOOKEY_CONVERSION_FIXTURES.map((fixture) => fixture.id)).toStrictEqual([
      "weather-kyou-ii-tenki",
      "greeting-okure",
      "totemo",
      "soup-wa",
      "weather-kyou-atsui",
      "soup-atsui",
      "haishin",
      "weather-ashita",
      "weather-asatte",
      "homophone-kouka",
      "homophone-kenshou",
      "homophone-kikaku",
    ]);
    expect(fixtureById("weather-kyou-ii-tenki")).toStrictEqual({
      id: "weather-kyou-ii-tenki",
      label: "今日はいい天気",
      reading: "きょうはいいてんき",
      expected: "今日はいい天気",
      note: "Tauri-aligned spot check: いい must not become 良い",
    });
    expect(fixtureById("missing-fixture")).toBeUndefined();
  });

  it("pins each official-dictionary reading to its Tauri surface", () => {
    expect(fixtureById("greeting-okure")?.reading).toBe("おつかれさまでした");
    expect(fixtureById("greeting-okure")?.expected).toBe("お疲れ様でした");
    expect(fixtureById("totemo")?.reading).toBe("とても");
    expect(fixtureById("totemo")?.expected).toBe("とても");
    expect(fixtureById("soup-wa")?.reading).toBe("すーぷは");
    expect(fixtureById("soup-wa")?.expected).toBe("スープは");
    expect(fixtureById("weather-kyou-atsui")?.reading).toBe("きょうのてんきはあつい");
    expect(fixtureById("weather-kyou-atsui")?.expected).toBe("今日の天気は暑い");
    expect(fixtureById("soup-atsui")?.reading).toBe("すーぷがあつい");
    expect(fixtureById("soup-atsui")?.expected).toBe("スープが熱い");
    expect(fixtureById("haishin")?.reading).toBe("きょうははいしんです");
    expect(fixtureById("haishin")?.expected).toBe("今日は配信です");
    expect(fixtureById("weather-ashita")?.reading).toBe("あしたのてんきははれ");
    expect(fixtureById("weather-ashita")?.expected).toBe("明日の天気は晴れ");
    expect(fixtureById("weather-asatte")?.reading).toBe("あさってのてんきはあめです");
    expect(fixtureById("weather-asatte")?.expected).toBe("明後日の天気は雨です");
    expect(fixtureById("homophone-kouka")?.reading).toBe("しへい、こうか、じゅうえん");
    expect(fixtureById("homophone-kouka")?.expected).toBe("紙幣、硬貨、10円");
    expect(fixtureById("homophone-kenshou")?.reading).toBe("いっとうしょう、けんしょう、おうぼ");
    expect(fixtureById("homophone-kenshou")?.expected).toBe("一等賞、懸賞、応募");
    expect(fixtureById("homophone-kikaku")?.reading).toBe("こうぎょう、きかく、とういつ");
    expect(fixtureById("homophone-kikaku")?.expected).toBe("工業、規格、統一");
  });
});
