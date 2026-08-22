// Runs with bun.
import { normalizeAzookeyReading } from "./caption-updates";
import type { CustomDictionaryEntry } from "./types";

export interface CustomDictionaryQuery {
  reading: string;
  word: string;
}

export const MIN_READING_CHARS: number = 2;

export const normalizeDictionaryReading = (value: string): string =>
  normalizeAzookeyReading(value).trim().toLocaleLowerCase();

export const normalizeDictionaryWord = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

/**
 * Warn rather than reject when a reading contains non-hiragana characters.
 * AzooKey is fail-open and normalizes katakana itself, so saving remains safe.
 */
export const readingNeedsWarning = (value: string): boolean => {
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && !/^[\u3040-\u309fー]+$/u.test(normalized);
};

/** User-dictionary readings must contain at least two Unicode characters. */
export const isReadingLongEnough = (value: string): boolean =>
  [...value.trim()].length >= MIN_READING_CHARS;

/** Filter independently by reading and word; when both are set, both must match. */
export const filterCustomDictionaryEntries = (
  entries: readonly CustomDictionaryEntry[],
  query: CustomDictionaryQuery,
): CustomDictionaryEntry[] => {
  const readingQuery = normalizeDictionaryReading(query.reading);
  const wordQuery = normalizeDictionaryWord(query.word);
  return entries.filter((entry) => {
    const readingMatches =
      !readingQuery || normalizeDictionaryReading(entry.reading).startsWith(readingQuery);
    const wordMatches = !wordQuery || normalizeDictionaryWord(entry.word).startsWith(wordQuery);
    return readingMatches && wordMatches;
  });
};
