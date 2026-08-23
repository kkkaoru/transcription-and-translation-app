// This file runs with bun.
import { expect, it, vi } from "vitest";
import {
  addCustomDictionaryEntry,
  clearCustomDictionary,
  deleteCustomDictionaryEntry,
  importCustomDictionary,
  listCustomDictionaryEntries,
} from "./custom-dictionary";

it("lists only validated Worker dictionary entries", async () => {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      Response.json({
        entryCount: 2,
        entries: [
          { id: "one", reading: "ぶいあーる", word: "VR" },
          { id: 2, reading: "bad", word: "bad" },
        ],
      }),
    ),
  );
  await expect(listCustomDictionaryEntries(fetchImpl)).resolves.toStrictEqual({
    entryCount: 2,
    entries: [{ id: "one", reading: "ぶいあーる", word: "VR" }],
  });
});

it("creates and deletes one entry on the Worker", async () => {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  );
  await addCustomDictionaryEntry({ reading: "ぶいあーる", word: "VR" }, fetchImpl);
  await deleteCustomDictionaryEntry("entry/id", fetchImpl);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("/azookey/user-lexicon/entries");
  expect(fetchImpl.mock.calls[1]?.[0]).toBe("/azookey/user-lexicon/entries/entry%2Fid");
});

it("uploads CSV and TSV File bodies without parsing them into browser state", async () => {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  );
  const csv = new File(["よみ,単語"], "words.csv", { type: "text/csv" });
  const tsv = new File(["よみ\t単語"], "words.tsv", { type: "text/tab-separated-values" });
  await importCustomDictionary(csv, fetchImpl);
  await importCustomDictionary(tsv, fetchImpl);
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(csv);
  expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(tsv);
});

it("clears the Worker dictionary and surfaces bounded API errors", async () => {
  const clearFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json({ ok: true })),
  );
  await clearCustomDictionary(clearFetch);
  expect(clearFetch.mock.calls[0]?.[1]?.method).toBe("DELETE");

  const failingFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json({ error: { message: "invalid row" } }, { status: 400 })),
  );
  await expect(clearCustomDictionary(failingFetch)).rejects.toThrow("invalid row");
});

it("rejects malformed list responses", async () => {
  const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json({ entries: "bad" })),
  );
  await expect(listCustomDictionaryEntries(fetchImpl)).rejects.toThrow(
    "Dictionary response is invalid",
  );
});
