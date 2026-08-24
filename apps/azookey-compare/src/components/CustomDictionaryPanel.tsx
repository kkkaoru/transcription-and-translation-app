"use client";

// This file runs with bun.
import { useCallback, useEffect, useState } from "react";
import {
  addCustomDictionaryEntry,
  type CustomDictionaryEntry,
  clearCustomDictionary,
  deleteCustomDictionaryEntry,
  importCustomDictionary,
  listCustomDictionaryEntries,
} from "../lib/custom-dictionary";

interface CustomDictionaryPanelProps {
  onEntryCountChange?: (entryCount: number) => void;
}

export const hasUserLexiconEntries = (entryCount: number): boolean => entryCount > 0;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Dictionary operation failed";

export default function CustomDictionaryPanel({
  onEntryCountChange,
}: CustomDictionaryPanelProps): React.JSX.Element {
  const [entries, setEntries] = useState<CustomDictionaryEntry[]>([]);
  const [entryCount, setEntryCount] = useState(0);
  const [reading, setReading] = useState("");
  const [word, setWord] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const page = await listCustomDictionaryEntries();
    setEntries(page.entries);
    setEntryCount(page.entryCount);
    onEntryCountChange?.(page.entryCount);
  }, [onEntryCountChange]);

  useEffect(() => {
    void refresh().catch((error: unknown) => setNotice(errorMessage(error)));
  }, [refresh]);

  const run = useCallback(
    async (operation: () => Promise<void>, success: string): Promise<void> => {
      setBusy(true);
      setNotice("");
      try {
        await operation();
        await refresh();
        setNotice(success);
      } catch (error) {
        setNotice(errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const upload = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (!file || !/\.(csv|tsv)$/i.test(file.name)) {
        setNotice("CSV または TSV ファイルを選択してください");
        return;
      }
      await run(() => importCustomDictionary(file), `${file.name} を Worker 辞書へ取り込みました`);
    },
    [run],
  );

  return (
    <section className="dictionary-panel" aria-labelledby="dictionary-heading">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Worker-owned custom lexicon</p>
          <h2 id="dictionary-heading">AzooKey カスタム辞書</h2>
        </div>
        <span>{entryCount} 語</span>
      </div>
      <p className="fine-print">
        辞書は Cloudflare Worker の Durable Object
        に保存されます。変換時にブラウザへ辞書内容を読み込むことはありません。
      </p>
      <form
        className="dictionary-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () => addCustomDictionaryEntry({ reading: reading.trim(), word: word.trim() }),
            "単語を追加しました",
          ).then(() => {
            setReading("");
            setWord("");
          });
        }}
      >
        <label>
          よみ
          <input value={reading} onChange={(event) => setReading(event.target.value)} required />
        </label>
        <label>
          単語
          <input value={word} onChange={(event) => setWord(event.target.value)} required />
        </label>
        <button type="submit" className="secondary-button" disabled={busy}>
          追加
        </button>
      </form>
      <label
        className={`dictionary-drop-zone${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files[0]);
        }}
      >
        CSV / TSV をここへドロップ、またはファイルを選択
        <input
          type="file"
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          onChange={(event) => void upload(event.target.files?.[0])}
        />
      </label>
      <div className="dictionary-actions">
        <button
          type="button"
          className="danger-outline-button"
          disabled={busy || entryCount === 0}
          onClick={() => {
            if (window.confirm("Worker のカスタム辞書を全削除しますか？")) {
              void run(clearCustomDictionary, "カスタム辞書を全削除しました");
            }
          }}
        >
          全削除
        </button>
        {notice ? <span aria-live="polite">{notice}</span> : null}
      </div>
      <ul className="dictionary-entry-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span>
              <small>{entry.reading}</small>
              <strong>{entry.word}</strong>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => deleteCustomDictionaryEntry(entry.id), "単語を削除しました")
              }
            >
              削除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
