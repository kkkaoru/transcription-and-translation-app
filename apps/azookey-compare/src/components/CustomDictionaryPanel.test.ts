/**
 * Source contract for the Worker-backed user-lexicon panel.
 *
 * This file runs with bun.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("is only a Worker editor with search and one page of results", () => {
  const source = readFileSync(new URL("./CustomDictionaryPanel.tsx", import.meta.url), "utf8");
  expect(source.indexOf("localStorage")).toBe(-1);
  expect(source.indexOf("sessionStorage")).toBe(-1);
  expect(source.indexOf("indexedDB")).toBe(-1);
  expect(source.indexOf("CacheStorage")).toBe(-1);
  expect(source.indexOf("onTsvChange")).toBe(-1);
  expect(source.indexOf("userDictionaryTsv")).toBe(-1);
  expect(source.indexOf("parseUserDictionaryImportFile")).toBe(-1);
  expect(source.indexOf("file.text(")).toBe(-1);
  expect(source.indexOf("listUserLexiconEntries")).not.toBe(-1);
  expect(source.indexOf("addUserLexiconEntry")).not.toBe(-1);
  expect(source.indexOf("deleteUserLexiconEntry")).not.toBe(-1);
  expect(source.indexOf("startUserLexiconQueuedImport")).not.toBe(-1);
  expect(source.indexOf("USER_LEXICON_PAGE_LIMIT")).not.toBe(-1);
  expect(source.indexOf("USER_LEXICON_MIN_READING_CHARS")).not.toBe(-1);
  expect(source.indexOf("よみはひらがな2文字以上必要です。")).not.toBe(-1);
  expect(source.indexOf("/azookey/user-lexicon")).not.toBe(-1);
  expect(source.indexOf('data-testid="custom-dictionary-search"')).not.toBe(-1);
  expect(source.indexOf('data-testid="custom-dictionary-pager"')).not.toBe(-1);
  expect(source.indexOf("次へ")).not.toBe(-1);
  expect(source.indexOf("前へ")).not.toBe(-1);
});
