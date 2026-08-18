/**
 * Browser custom dictionary (reading → word) for AzooKey conversion.
 *
 * This file runs with bun.
 */

export const CUSTOM_DICTIONARY_STORAGE_KEY = "azookey-compare.custom-dictionary.v1";
export const CUSTOM_DICTIONARY_VERSION = 1;
export const CUSTOM_DICTIONARY_MAX_ENTRIES = 10_000;
export const CUSTOM_DICTIONARY_MAX_ID_CHARS = 128;
export const CUSTOM_DICTIONARY_MAX_READING_CHARS = 256;
export const CUSTOM_DICTIONARY_MAX_WORD_CHARS = 512;
export const CUSTOM_DICTIONARY_SAMPLE_ID = "sample-vrchat-vrc";
export const CUSTOM_DICTIONARY_SAMPLE_READING = "ぶいあーるちゃっと";
export const CUSTOM_DICTIONARY_SAMPLE_WORD = "VRC";

export interface CustomDictionaryEntry {
  id: string;
  reading: string;
  word: string;
}

export interface CustomDictionaryFile {
  version: number;
  entries: CustomDictionaryEntry[];
}

export interface CustomDictionaryValidationError {
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const sampleCustomDictionaryEntries = (): CustomDictionaryEntry[] => [
  {
    id: CUSTOM_DICTIONARY_SAMPLE_ID,
    reading: CUSTOM_DICTIONARY_SAMPLE_READING,
    word: CUSTOM_DICTIONARY_SAMPLE_WORD,
  },
];

export const createCustomDictionaryEntryId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dictionary-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const fieldError = (index: number, name: string, detail: string): string =>
  `entry ${index + 1} ${name} ${detail}`;

export const validateCustomDictionaryEntries = (
  entries: readonly CustomDictionaryEntry[],
): CustomDictionaryEntry[] => {
  if (entries.length > CUSTOM_DICTIONARY_MAX_ENTRIES) {
    throw new Error(`custom dictionary supports at most ${CUSTOM_DICTIONARY_MAX_ENTRIES} entries`);
  }
  const ids = new Set<string>();
  return entries.map((entry, index) => {
    const id = entry.id.trim();
    const reading = entry.reading.trim();
    const word = entry.word.trim();
    if (!id || [...id].length > CUSTOM_DICTIONARY_MAX_ID_CHARS) {
      throw new Error(fieldError(index, "id", "is invalid"));
    }
    if (ids.has(id)) {
      throw new Error(fieldError(index, "id", "is duplicated"));
    }
    ids.add(id);
    if (!reading) {
      throw new Error(fieldError(index, "reading", "is required"));
    }
    if (!word) {
      throw new Error(fieldError(index, "word", "is required"));
    }
    if (/[\t\r\n]/u.test(reading) || /[\t\r\n]/u.test(word)) {
      throw new Error(fieldError(index, "reading or word", "cannot contain tabs or newlines"));
    }
    if ([...reading].length > CUSTOM_DICTIONARY_MAX_READING_CHARS) {
      throw new Error(fieldError(index, "reading", "is too long"));
    }
    if ([...word].length > CUSTOM_DICTIONARY_MAX_WORD_CHARS) {
      throw new Error(fieldError(index, "word", "is too long"));
    }
    if (reading.startsWith("#")) {
      throw new Error(fieldError(index, "reading", "cannot start with #"));
    }
    return { id, reading, word };
  });
};

export const customDictionaryEntriesToTsv = (entries: readonly CustomDictionaryEntry[]): string =>
  entries.length === 0
    ? ""
    : `${entries.map((entry) => `${entry.reading}\t${entry.word}`).join("\n")}\n`;

export const parseCustomDictionaryTsv = (body: string): CustomDictionaryEntry[] => {
  const rows = body
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return validateCustomDictionaryEntries(
    rows.map((line, index) => {
      const columns = line.split("\t");
      if (columns.length < 2) {
        throw new Error(`TSV row ${index + 1} must contain reading and word`);
      }
      return {
        id: createCustomDictionaryEntryId(),
        reading: columns[0] ?? "",
        word: columns[1] ?? "",
      };
    }),
  );
};

export const parseCustomDictionaryJson = (body: string): CustomDictionaryEntry[] => {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error("custom dictionary JSON must be an object");
  }
  if (parsed["version"] !== CUSTOM_DICTIONARY_VERSION) {
    throw new Error("unsupported custom dictionary version");
  }
  const rawEntries = parsed["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new Error("custom dictionary JSON entries must be an array");
  }
  return validateCustomDictionaryEntries(
    rawEntries.map((value, index) => {
      if (!isRecord(value)) {
        throw new Error(`entry ${index + 1} must be an object`);
      }
      const id = value["id"];
      const reading = value["reading"];
      const word = value["word"];
      if (typeof id !== "string" || typeof reading !== "string" || typeof word !== "string") {
        throw new Error(`entry ${index + 1} is missing id, reading, or word`);
      }
      return { id, reading, word };
    }),
  );
};

const isCsvHeader = (reading: string, word: string): boolean => {
  const normalizedReading = reading.trim().toLowerCase();
  const normalizedWord = word.trim().toLowerCase();
  return (
    (normalizedReading === "よみ" || normalizedReading === "reading") &&
    (normalizedWord === "単語" || normalizedWord === "word")
  );
};

const splitCsvLine = (line: string): string[] => {
  if (!line.includes('"')) {
    return line.split(",");
  }
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/u).map((cell) => {
    const trimmed = cell.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replaceAll('""', '"');
    }
    return trimmed;
  });
};

export const parseCustomDictionaryCsv = (body: string): CustomDictionaryEntry[] => {
  const lines = body
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const withoutHeader =
    lines[0] === undefined
      ? []
      : (() => {
          const [reading = "", word = ""] = splitCsvLine(lines[0]);
          return isCsvHeader(reading, word) ? lines.slice(1) : lines;
        })();
  return validateCustomDictionaryEntries(
    withoutHeader.map((line, index) => {
      const columns = splitCsvLine(line);
      if (columns.length !== 2) {
        throw new Error(`CSV row ${index + 1} must contain exactly two columns`);
      }
      return {
        id: createCustomDictionaryEntryId(),
        reading: columns[0] ?? "",
        word: columns[1] ?? "",
      };
    }),
  );
};

export const exportCustomDictionaryCsv = (entries: readonly CustomDictionaryEntry[]): string =>
  `\uFEFFよみ,単語\r\n${entries
    .map((entry) => {
      const escapeCsvCell = (value: string): string =>
        /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
      return `${escapeCsvCell(entry.reading)},${escapeCsvCell(entry.word)}`;
    })
    .join("\r\n")}${entries.length > 0 ? "\r\n" : ""}`;

export const parseCustomDictionaryFile = (
  fileName: string,
  body: string,
): CustomDictionaryEntry[] => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".json")) {
    return parseCustomDictionaryJson(body);
  }
  if (lower.endsWith(".tsv")) {
    return parseCustomDictionaryTsv(body);
  }
  if (lower.endsWith(".csv")) {
    return parseCustomDictionaryCsv(body);
  }
  throw new Error("custom dictionary file must be .json, .tsv, or .csv");
};

export const serializeCustomDictionaryFile = (entries: readonly CustomDictionaryEntry[]): string =>
  `${JSON.stringify(
    {
      version: CUSTOM_DICTIONARY_VERSION,
      entries: validateCustomDictionaryEntries(entries),
    } satisfies CustomDictionaryFile,
    null,
    2,
  )}\n`;

export const loadStoredCustomDictionary = (
  storage: Pick<Storage, "getItem"> | undefined,
): CustomDictionaryEntry[] => {
  const raw = storage?.getItem(CUSTOM_DICTIONARY_STORAGE_KEY);
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return sampleCustomDictionaryEntries();
  }
  return parseCustomDictionaryJson(raw);
};

export const saveStoredCustomDictionary = (
  storage: Pick<Storage, "setItem"> | undefined,
  entries: readonly CustomDictionaryEntry[],
): CustomDictionaryEntry[] => {
  const validated = validateCustomDictionaryEntries(entries);
  storage?.setItem(CUSTOM_DICTIONARY_STORAGE_KEY, serializeCustomDictionaryFile(validated));
  return validated;
};

export const addCustomDictionaryEntry = (
  entries: readonly CustomDictionaryEntry[],
  reading: string,
  word: string,
): CustomDictionaryEntry[] =>
  validateCustomDictionaryEntries([
    ...entries,
    { id: createCustomDictionaryEntryId(), reading, word },
  ]);

export const removeCustomDictionaryEntry = (
  entries: readonly CustomDictionaryEntry[],
  id: string,
): CustomDictionaryEntry[] => entries.filter((entry) => entry.id !== id);
