import { describe, expect, it } from "vitest";
import { exportCustomDictionaryCsv, importCustomDictionaryCsv } from "./custom-dictionary-csv";

describe("custom dictionary CSV", () => {
  it("exports a BOM, Japanese headers, CRLF, and escaped cells", () => {
    expect(
      exportCustomDictionaryCsv([
        { reading: "ぶいあーるちゃっと", word: "VRC" },
        { reading: "かんま", word: 'comma, "quoted"' },
      ]),
    ).toBe('\uFEFFよみ,単語\r\nぶいあーるちゃっと,VRC\r\nかんま,"comma, ""quoted"""\r\n');
  });

  it("imports Japanese or English headers and headerless two-column CSV", () => {
    expect(importCustomDictionaryCsv("\uFEFFよみ,単語\r\nぶいあーるちゃっと,VRC\r\n")).toEqual([
      { reading: "ぶいあーるちゃっと", word: "VRC" },
    ]);
    expect(importCustomDictionaryCsv("reading,word\nkotoba,Kotoba\n")).toEqual([
      { reading: "kotoba", word: "Kotoba" },
    ]);
    expect(importCustomDictionaryCsv("よみ,単語候補")).toEqual([
      { reading: "よみ", word: "単語候補" },
    ]);
  });

  it("rejects malformed, extra-column, empty, and multiline values", () => {
    expect(() => importCustomDictionaryCsv('よみ,単語\n"broken,VRC')).toThrow();
    expect(() => importCustomDictionaryCsv("よみ,単語\na,b,c")).toThrow();
    expect(() => importCustomDictionaryCsv("よみ,単語\na,")).toThrow();
    expect(() => importCustomDictionaryCsv('よみ,単語\n"multi\nline",word')).toThrow();
  });
});
