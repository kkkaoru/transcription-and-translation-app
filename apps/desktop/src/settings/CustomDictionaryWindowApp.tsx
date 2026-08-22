import { type ChangeEvent, type SyntheticEvent, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../core/bridge";
import {
  exportCustomDictionaryCsv,
  importCustomDictionaryCsv,
} from "../core/custom-dictionary-csv";
import {
  filterCustomDictionaryEntries,
  isReadingLongEnough,
  readingNeedsWarning,
} from "../core/dictionary-fuzzy-search";
import type { CustomDictionaryEntry } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";

const createEntryId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dictionary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const CustomDictionaryView = ({ normalizer }: { normalizer?: string }) => {
  const { t } = useI18n();
  const [entries, setEntries] = useState<CustomDictionaryEntry[]>([]);
  const [readingQuery, setReadingQuery] = useState("");
  const [wordQuery, setWordQuery] = useState("");
  const [reading, setReading] = useState("");
  const [word, setWord] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let mounted = true;
    void bridge
      .getCustomDictionary()
      .then((loaded) => {
        if (mounted) {
          setEntries(loaded);
          setReady(true);
        }
      })
      .catch(() => {
        if (mounted) {
          setNotice(t("customDictionary.loadFailed"));
          setReady(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, [t]);

  const filteredEntries = useMemo(
    () =>
      filterCustomDictionaryEntries(entries, {
        reading: readingQuery,
        word: wordQuery,
      }),
    [entries, readingQuery, wordQuery],
  );

  const resetDraft = () => {
    setReading("");
    setWord("");
    setEditingId(null);
  };

  const submitEntry = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextReading = reading.trim();
    const nextWord = word.trim();
    if (!isReadingLongEnough(nextReading) || !nextWord) {
      return;
    }
    if (editingId) {
      setEntries((current) =>
        current.map((entry) =>
          entry.id === editingId ? { ...entry, reading: nextReading, word: nextWord } : entry,
        ),
      );
    } else {
      setEntries((current) => [
        ...current,
        { id: createEntryId(), reading: nextReading, word: nextWord },
      ]);
    }
    resetDraft();
  };

  const editEntry = (entry: CustomDictionaryEntry) => {
    setEditingId(entry.id);
    setReading(entry.reading);
    setWord(entry.word);
  };

  const deleteEntry = (id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    if (editingId === id) {
      resetDraft();
    }
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    try {
      const rows = importCustomDictionaryCsv(await file.text());
      setEntries((current) => [
        ...current,
        ...rows.map((row) => ({ ...row, id: createEntryId() })),
      ]);
      setNotice(t("customDictionary.imported", { count: rows.length }));
    } catch {
      setNotice(t("customDictionary.importFailed"));
    }
  };

  const exportCsv = () => {
    const blob = new Blob([exportCustomDictionaryCsv(entries)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "kotoba-beacon-custom-dictionary.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(t("customDictionary.exported", { count: entries.length }));
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const saved = await bridge.saveCustomDictionary(entries);
      // Keep this explicit reload even though current native saves also clear
      // their cache, so older/native-compatible backends cannot retain a TSV
      // loaded from the same path.
      await bridge.reloadCustomDictionary();
      setEntries(saved);
      setNotice(t("customDictionary.saved"));
    } catch {
      setNotice(t("customDictionary.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="custom-dictionary-content" data-testid="custom-dictionary-view">
      <div className="content-heading">
        <div>
          <h2>{t("customDictionary.title")}</h2>
          <p>{t("customDictionary.lead")}</p>
        </div>
        <div className="heading-actions">
          <input
            ref={importInputRef}
            className="visually-hidden"
            type="file"
            accept=".csv,text/csv"
            data-testid="custom-dictionary-import-input"
            onChange={(event) => void importCsv(event)}
          />
          <button
            className="text-button"
            type="button"
            onClick={() => importInputRef.current?.click()}
          >
            {t("customDictionary.importCsv")}
          </button>
          <button className="text-button" type="button" onClick={exportCsv} disabled={!ready}>
            {t("customDictionary.exportCsv")}
          </button>
          <button
            className="primary-button"
            type="button"
            data-testid="save-custom-dictionary"
            onClick={() => void save()}
            disabled={!ready || saving}
          >
            {saving ? t("customDictionary.saving") : t("customDictionary.save")}
          </button>
        </div>
      </div>

      {ready && entries.length > 0 && normalizer && normalizer !== "azookey-rust" ? (
        <div className="notice" role="alert" data-testid="custom-dictionary-normalizer-warning">
          <span className="notice-text">{t("customDictionary.normalizerWarning")}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="notice" role="status">
          <span className="notice-text">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("common.close")}>
            ×
          </button>
        </div>
      ) : null}

      <section className="panel settings-section">
        <form className="custom-dictionary-form" onSubmit={submitEntry}>
          <label className="field">
            <span>{t("customDictionary.readingLabel")}</span>
            <input
              data-testid="custom-dictionary-reading"
              value={reading}
              onChange={(event) => setReading(event.currentTarget.value)}
              placeholder={t("customDictionary.readingHint")}
              required
            />
            {reading.trim() && !isReadingLongEnough(reading) ? (
              <small
                className="field-warning"
                role="status"
                data-testid="custom-dictionary-reading-too-short"
              >
                {t("customDictionary.readingTooShort")}
              </small>
            ) : null}
            {readingNeedsWarning(reading) ? (
              <small className="field-warning" role="status">
                {t("customDictionary.readingInvalid")}
              </small>
            ) : null}
          </label>
          <label className="field">
            <span>{t("customDictionary.wordLabel")}</span>
            <input
              data-testid="custom-dictionary-word"
              value={word}
              onChange={(event) => setWord(event.currentTarget.value)}
              required
            />
          </label>
          <div className="heading-actions custom-dictionary-form-actions">
            {editingId ? (
              <button className="text-button" type="button" onClick={resetDraft}>
                {t("customDictionary.cancel")}
              </button>
            ) : null}
            <button
              className="primary-button"
              type="submit"
              disabled={!isReadingLongEnough(reading) || !word.trim()}
            >
              {editingId ? t("customDictionary.update") : t("customDictionary.add")}
            </button>
          </div>
        </form>
      </section>

      <section className="panel settings-section">
        <div className="custom-dictionary-search">
          <label className="field">
            <span>{t("customDictionary.readingLabel")}</span>
            <input
              type="search"
              data-testid="custom-dictionary-search-reading"
              value={readingQuery}
              onChange={(event) => setReadingQuery(event.currentTarget.value)}
              placeholder={t("customDictionary.searchReading")}
            />
          </label>
          <label className="field">
            <span>{t("customDictionary.wordLabel")}</span>
            <input
              type="search"
              data-testid="custom-dictionary-search-word"
              value={wordQuery}
              onChange={(event) => setWordQuery(event.currentTarget.value)}
              placeholder={t("customDictionary.searchWord")}
            />
          </label>
        </div>

        {!ready ? null : entries.length === 0 ? (
          <p className="empty-state">{t("customDictionary.empty")}</p>
        ) : filteredEntries.length === 0 ? (
          <p className="empty-state">{t("customDictionary.noResults")}</p>
        ) : (
          <div className="custom-dictionary-table-wrap">
            <table className="custom-dictionary-table">
              <thead>
                <tr>
                  <th>{t("customDictionary.readingLabel")}</th>
                  <th>{t("customDictionary.wordLabel")}</th>
                  <th aria-label={t("customDictionary.edit")} />
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.reading}</td>
                    <td>{entry.word}</td>
                    <td>
                      <div className="heading-actions">
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => editEntry(entry)}
                        >
                          {t("customDictionary.edit")}
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => deleteEntry(entry.id)}
                        >
                          {t("customDictionary.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

/** Legacy dedicated-window route retained for older shortcuts. */
export const CustomDictionaryWindowApp = () => (
  <div className="app-shell" data-testid="custom-dictionary-window">
    <div className="workspace">
      <main className="content">
        <CustomDictionaryView />
      </main>
    </div>
  </div>
);
