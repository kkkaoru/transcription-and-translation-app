// This file runs with bun.

export interface CustomDictionaryEntry {
  id: string;
  reading: string;
  word: string;
}

interface CustomDictionaryPage {
  entryCount: number;
  entries: CustomDictionaryEntry[];
}

export const CUSTOM_DICTIONARY_PATH = "/azookey/user-lexicon";
export const CUSTOM_DICTIONARY_ENTRIES_PATH = `${CUSTOM_DICTIONARY_PATH}/entries`;
export const CUSTOM_DICTIONARY_IMPORT_PATH = `${CUSTOM_DICTIONARY_PATH}/import`;
const PAGE_LIMIT = 100;

const responseError = async (response: Response): Promise<Error> => {
  const payload: unknown = await response.json().catch(() => undefined);
  const message =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
      ? payload.error.message
      : `Dictionary request failed (${String(response.status)})`;
  return new Error(message);
};

const checked = async (response: Response): Promise<Response> => {
  if (!response.ok) {
    throw await responseError(response);
  }
  return response;
};

export const listCustomDictionaryEntries = async (
  fetchImpl: typeof fetch = fetch,
): Promise<CustomDictionaryPage> => {
  const response = await checked(
    await fetchImpl(`${CUSTOM_DICTIONARY_ENTRIES_PATH}?limit=${String(PAGE_LIMIT)}`),
  );
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    !("entryCount" in payload) ||
    typeof payload.entryCount !== "number" ||
    !("entries" in payload) ||
    !Array.isArray(payload.entries)
  ) {
    throw new Error("Dictionary response is invalid");
  }
  const entries = payload.entries.filter(
    (entry): entry is CustomDictionaryEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "reading" in entry &&
      typeof entry.reading === "string" &&
      "word" in entry &&
      typeof entry.word === "string",
  );
  return { entryCount: payload.entryCount, entries };
};

export const addCustomDictionaryEntry = async (
  entry: { reading: string; word: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  await checked(
    await fetchImpl(CUSTOM_DICTIONARY_ENTRIES_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }),
  );
};

export const deleteCustomDictionaryEntry = async (
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  await checked(
    await fetchImpl(`${CUSTOM_DICTIONARY_ENTRIES_PATH}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
};

export const clearCustomDictionary = async (fetchImpl: typeof fetch = fetch): Promise<void> => {
  await checked(await fetchImpl(CUSTOM_DICTIONARY_PATH, { method: "DELETE" }));
};

export const importCustomDictionary = async (
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const contentType = file.name.toLowerCase().endsWith(".csv")
    ? "text/csv"
    : "text/tab-separated-values";
  await checked(
    await fetchImpl(CUSTOM_DICTIONARY_IMPORT_PATH, {
      method: "POST",
      headers: { "content-type": `${contentType}; charset=utf-8` },
      body: file,
    }),
  );
};
