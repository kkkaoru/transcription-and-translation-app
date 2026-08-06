/**
 * Phonetic inputs that mirror the Tauri desktop AzooKey normalizer path
 * (`convert_with_dictionary` with `ConversionOptions::default()`).
 *
 * The Worker WASM uses the same `azookey-rust` converter and official LOUDS
 * dictionary, so these cases verify that local kotoba-beacon matches the
 * caption pipeline's expected surfaces.
 */
export interface DesktopAzookeyFixture {
  /** Stable id for UI / tests. */
  id: string;
  /** Label shown in the fixture picker. */
  label: string;
  /** Phonetic input equivalent to desktop `azookey_input_text`. */
  reading: string;
  /** Expected kana-kanji surface when the official dictionary is healthy. */
  expected: string;
  /** Why this case matters for desktop parity. */
  note: string;
}

export const DESKTOP_AZOOKEY_FIXTURES: readonly DesktopAzookeyFixture[] = [
  {
    id: "greeting-okure",
    label: "お疲れ様でした",
    reading: "おつかれさまでした",
    expected: "お疲れ様でした",
    note: "Item 2 regression: honorific greeting must stay natural",
  },
  {
    id: "totemo",
    label: "とても",
    reading: "とても",
    expected: "とても",
    note: "Item 2 regression: must not become 迚",
  },
  {
    id: "soup-wa",
    label: "スープは",
    reading: "すーぷは",
    expected: "スープは",
    note: "Item 2 regression: must not become スープ歯",
  },
  {
    id: "weather-ashita",
    label: "あしたのてんきははれ",
    reading: "あしたのてんきははれ",
    expected: "明日の天気は晴れ",
    note: "Caption-style weather phrase used by merge audits",
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

export const fixtureById = (id: string): DesktopAzookeyFixture | undefined =>
  DESKTOP_AZOOKEY_FIXTURES.find((fixture) => fixture.id === id);
