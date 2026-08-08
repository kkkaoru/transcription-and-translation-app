/**
 * Phonetic regression fixtures for the standalone AzooKey Worker WASM path
 * (`azookey-rust` converter + official LOUDS dictionary).
 *
 * These cases exercise the Worker / comparison stack on their own — they do
 * not require the Kotoba Beacon desktop app.
 */
export interface AzookeyConversionFixture {
  /** Stable id for UI / tests. */
  id: string;
  /** Label shown in the fixture picker. */
  label: string;
  /** Phonetic (kana) input sent as vibratoInput / sourceText. */
  reading: string;
  /** Expected kana-kanji surface when the official dictionary is healthy. */
  expected: string;
  /** Why this case matters for conversion quality. */
  note: string;
}

export const AZOOKEY_CONVERSION_FIXTURES: readonly AzookeyConversionFixture[] = [
  {
    id: "greeting-okure",
    label: "お疲れ様でした",
    reading: "おつかれさまでした",
    expected: "お疲れ様でした",
    note: "Honorific greeting must stay natural",
  },
  {
    id: "totemo",
    label: "とても",
    reading: "とても",
    expected: "とても",
    note: "Must not become 迚",
  },
  {
    id: "soup-wa",
    label: "スープは",
    reading: "すーぷは",
    expected: "スープは",
    note: "Must not become スープ歯",
  },
  {
    id: "weather-ashita",
    label: "あしたのてんきははれ",
    reading: "あしたのてんきははれ",
    expected: "明日の天気は晴れ",
    note: "Caption-style weather phrase",
  },
  {
    id: "weather-asatte",
    label: "あさってのてんきはあめです",
    reading: "あさってのてんきはあめです",
    expected: "明後日の天気は雨です",
    note: "Second independent weather turn; must not merge with ashita",
  },
  {
    id: "homophone-kouka",
    label: "紙幣・硬貨・10円",
    reading: "しへい、こうか、じゅうえん",
    expected: "紙幣、硬貨、10円",
    note: "Homophone pressure: こうか should prefer 硬貨 over 効果",
  },
  {
    id: "homophone-kenshou",
    label: "一等賞・懸賞・応募",
    reading: "いっとうしょう、けんしょう、おうぼ",
    expected: "一等賞、懸賞、応募",
    note: "Must not invent non-dictionary 券小",
  },
  {
    id: "homophone-kikaku",
    label: "工業・規格・統一",
    reading: "こうぎょう、きかく、とういつ",
    expected: "工業、規格、統一",
    note: "Must not invent non-dictionary 機各",
  },
];

export const fixtureById = (id: string): AzookeyConversionFixture | undefined =>
  AZOOKEY_CONVERSION_FIXTURES.find((fixture) => fixture.id === id);
