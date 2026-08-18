"use client";

import { useEffect, useState } from "react";
import {
  addCustomDictionaryEntry,
  type CustomDictionaryEntry,
  customDictionaryEntriesToTsv,
  loadStoredCustomDictionary,
  parseCustomDictionaryFile,
  removeCustomDictionaryEntry,
  saveStoredCustomDictionary,
} from "../lib/custom-dictionary";

export interface CustomDictionaryPanelProps {
  onTsvChange: (tsv: string) => void;
}

export const CustomDictionaryPanel = ({ onTsvChange }: CustomDictionaryPanelProps) => {
  const [entries, setEntries] = useState<CustomDictionaryEntry[]>([]);
  const [reading, setReading] = useState("");
  const [word, setWord] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const loaded = loadStoredCustomDictionary(
      typeof window === "undefined" ? undefined : window.localStorage,
    );
    setEntries(loaded);
    setReady(true);
    onTsvChange(customDictionaryEntriesToTsv(loaded));
  }, [onTsvChange]);

  const persist = (next: CustomDictionaryEntry[]): void => {
    const saved = saveStoredCustomDictionary(
      typeof window === "undefined" ? undefined : window.localStorage,
      next,
    );
    setEntries(saved);
    onTsvChange(customDictionaryEntriesToTsv(saved));
  };

  return (
    <div className="subsection" data-testid="custom-dictionary-panel">
      <p className="subsection-title">カスタム辞書</p>
      <p className="field-help">
        よみと単語を追加・削除できます。JSON / TSV / CSV
        を読み込むと一覧を置き換えます。ブラウザ完結と Worker
        依存の両方で、公式辞書のあとこの一覧が変換に使われます。
      </p>
      <form
        className="custom-dictionary-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            persist(addCustomDictionaryEntry(entries, reading, word));
            setReading("");
            setWord("");
            setNotice("");
          } catch (error) {
            setNotice(error instanceof Error ? error.message : "could not add the entry");
          }
        }}
      >
        <label className="field-label" htmlFor="custom-dictionary-reading">
          よみ
          <input
            id="custom-dictionary-reading"
            type="text"
            value={reading}
            onChange={(event) => setReading(event.target.value)}
            placeholder="ぶいあーるちゃっと"
            spellCheck={false}
          />
        </label>
        <label className="field-label" htmlFor="custom-dictionary-word">
          単語
          <input
            id="custom-dictionary-word"
            type="text"
            value={word}
            onChange={(event) => setWord(event.target.value)}
            placeholder="VRC"
            spellCheck={false}
          />
        </label>
        <button className="button button-secondary" type="submit" disabled={!ready}>
          追加
        </button>
      </form>
      <label className="field-label" htmlFor="custom-dictionary-file">
        辞書ファイルを読み込む
        <input
          id="custom-dictionary-file"
          type="file"
          accept=".json,.tsv,.csv,text/csv,text/tab-separated-values,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) {
              return;
            }
            void file.text().then((body) => {
              try {
                persist(parseCustomDictionaryFile(file.name, body));
                setNotice(`${file.name} を読み込みました`);
              } catch (error) {
                setNotice(error instanceof Error ? error.message : "could not load the file");
              }
            });
            event.target.value = "";
          }}
        />
      </label>
      {notice ? (
        <p className="field-help" data-testid="custom-dictionary-notice">
          {notice}
        </p>
      ) : null}
      <ul className="custom-dictionary-list" data-testid="custom-dictionary-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span>
              {entry.reading} → {entry.word}
            </span>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => persist(removeCustomDictionaryEntry(entries, entry.id))}
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
