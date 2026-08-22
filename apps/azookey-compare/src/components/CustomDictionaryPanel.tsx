"use client";

/**
 * Worker-backed user-lexicon editor. The browser only shows one search page.
 *
 * This file runs with bun.
 */

import { useCallback, useEffect, useState } from "react";
import type { ComparisonAuth } from "../lib/contract";
import {
  activateUserLexiconDictionary,
  addUserLexiconEntry,
  createUserLexiconDictionary,
  deleteUserLexiconDictionary,
  deleteUserLexiconEntry,
  listUserLexiconDictionaries,
  listUserLexiconEntries,
  nextUserLexiconCursorState,
  previousUserLexiconCursorState,
  readUserLexiconImportJob,
  renameUserLexiconDictionary,
  startUserLexiconQueuedImport,
  USER_LEXICON_MIN_READING_CHARS,
  USER_LEXICON_PAGE_LIMIT,
  type UserLexiconDictionary,
  type UserLexiconEntry,
  type UserLexiconImportJobResult,
  userLexiconHttpUrlFromWebsocket,
} from "../lib/custom-dictionary";

export interface CustomDictionaryPanelProps {
  websocketUrl: string;
  auth: ComparisonAuth;
}

const noticeFromError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const CustomDictionaryPanel = ({ websocketUrl, auth }: CustomDictionaryPanelProps) => {
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [entries, setEntries] = useState<UserLexiconEntry[]>([]);
  const [entryCount, setEntryCount] = useState(0);
  const [pageCursor, setPageCursor] = useState("");
  const [nextCursor, setNextCursor] = useState("");
  const [previousCursors, setPreviousCursors] = useState<readonly string[]>([]);
  const [reading, setReading] = useState("");
  const [word, setWord] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [dictionaries, setDictionaries] = useState<UserLexiconDictionary[]>([]);
  const [activeId, setActiveId] = useState("");
  const [newDictionaryName, setNewDictionaryName] = useState("");
  const [importJob, setImportJob] = useState<UserLexiconImportJobResult | null>(null);

  const loadPage = useCallback(
    async (input: { q: string; cursor: string; signal?: AbortSignal }): Promise<boolean> => {
      setLoading(true);
      try {
        const page = await listUserLexiconEntries({
          baseUrl: userLexiconHttpUrlFromWebsocket({
            websocketUrl,
            origin: window.location.origin,
          }),
          fetcher: fetch,
          auth: { scheme: auth.scheme, token: auth.token },
          q: input.q,
          limit: USER_LEXICON_PAGE_LIMIT,
          cursor: input.cursor,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        setEntries(page.entries);
        setEntryCount(page.entryCount);
        setNextCursor(page.nextCursor);
        setNotice("");
        return page.entries.length > 0;
      } catch (error) {
        if (input.signal?.aborted) {
          return false;
        }
        setEntries([]);
        setEntryCount(0);
        setNextCursor("");
        setNotice(noticeFromError(error, "could not load the Worker lexicon"));
        return false;
      } finally {
        if (!input.signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [auth.scheme, auth.token, websocketUrl],
  );

  const refreshCatalog = useCallback(async (): Promise<void> => {
    const catalog = await listUserLexiconDictionaries({
      baseUrl: userLexiconHttpUrlFromWebsocket({
        websocketUrl,
        origin: window.location.origin,
      }),
      fetcher: fetch,
      auth: { scheme: auth.scheme, token: auth.token },
    });
    setDictionaries(catalog.dictionaries);
    setActiveId(catalog.activeId);
  }, [auth.scheme, auth.token, websocketUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPage({ q: committedQuery, cursor: pageCursor, signal: controller.signal });
    return () => controller.abort();
  }, [committedQuery, loadPage, pageCursor]);

  useEffect(() => {
    void refreshCatalog().catch((error: unknown) => {
      setNotice(noticeFromError(error, "could not load dictionaries"));
    });
  }, [refreshCatalog]);

  useEffect(() => {
    if (importJob === null || importJob.status === "completed" || importJob.status === "failed") {
      return;
    }
    const timer = window.setInterval(() => {
      void readUserLexiconImportJob({
        baseUrl: userLexiconHttpUrlFromWebsocket({
          websocketUrl,
          origin: window.location.origin,
        }),
        fetcher: fetch,
        auth: { scheme: auth.scheme, token: auth.token },
        dictionaryId: importJob.dictionaryId,
        importId: importJob.id,
      })
        .then((next) => {
          setImportJob(next);
          if (next.status === "completed") {
            setNotice(`Imported ${next.accepted} / ${next.total} rows`);
            void loadPage({ q: committedQuery, cursor: "" });
            void refreshCatalog();
          }
        })
        .catch((error: unknown) => {
          setNotice(noticeFromError(error, "could not read import progress"));
        });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [auth.scheme, auth.token, committedQuery, importJob, loadPage, refreshCatalog, websocketUrl]);

  const baseUrl = (): string =>
    userLexiconHttpUrlFromWebsocket({
      websocketUrl,
      origin: window.location.origin,
    });

  const clientAuth = (): ComparisonAuth => ({ scheme: auth.scheme, token: auth.token });

  return (
    <div className="subsection" data-testid="custom-dictionary-panel">
      <p className="subsection-title">カスタム辞書</p>
      <p className="field-help">
        よみと単語は Cloudflare Worker（`/azookey/user-lexicon`）に保存されます。変換時は Worker
        側の辞書だけが使われ、ブラウザ完結の変換には適用しません。一覧は検索結果の1ページ（最大
        {USER_LEXICON_PAGE_LIMIT} 件）だけを表示します。Worker 上の件数: {entryCount}
      </p>
      <label className="field-label" htmlFor="custom-dictionary-select">
        辞書
        <select
          id="custom-dictionary-select"
          value={activeId}
          onChange={(event) => {
            const id = event.target.value;
            void activateUserLexiconDictionary({
              baseUrl: baseUrl(),
              fetcher: fetch,
              auth: clientAuth(),
              id,
            })
              .then(() => {
                setActiveId(id);
                setPreviousCursors([]);
                setPageCursor("");
                return loadPage({ q: committedQuery, cursor: "" });
              })
              .then(() => refreshCatalog())
              .catch((error: unknown) => {
                setNotice(noticeFromError(error, "could not switch dictionary"));
              });
          }}
        >
          {dictionaries.map((dictionary) => (
            <option key={dictionary.id} value={dictionary.id}>
              {dictionary.name} ({dictionary.entryCount})
            </option>
          ))}
        </select>
      </label>
      <form
        className="custom-dictionary-form"
        onSubmit={(event) => {
          event.preventDefault();
          void createUserLexiconDictionary({
            baseUrl: baseUrl(),
            fetcher: fetch,
            auth: clientAuth(),
            name: newDictionaryName,
          })
            .then((catalog) => {
              setNewDictionaryName("");
              setDictionaries(catalog.dictionaries);
              setNotice("Created a dictionary on the Worker");
            })
            .catch((error: unknown) => {
              setNotice(noticeFromError(error, "could not create the dictionary"));
            });
        }}
      >
        <label className="field-label" htmlFor="custom-dictionary-new-name">
          新しい辞書名
          <input
            id="custom-dictionary-new-name"
            type="text"
            value={newDictionaryName}
            onChange={(event) => setNewDictionaryName(event.target.value)}
          />
        </label>
        <button
          className="button button-secondary"
          type="submit"
          disabled={!newDictionaryName.trim()}
        >
          辞書を追加
        </button>
      </form>
      <button
        className="button button-secondary"
        type="button"
        disabled={!activeId}
        onClick={() => {
          const name = window.prompt(
            "Dictionary name",
            dictionaries.find((item) => item.id === activeId)?.name ?? "",
          );
          if (!name) {
            return;
          }
          void renameUserLexiconDictionary({
            baseUrl: baseUrl(),
            fetcher: fetch,
            auth: clientAuth(),
            id: activeId,
            name,
          })
            .then(() => refreshCatalog())
            .catch((error: unknown) => {
              setNotice(noticeFromError(error, "could not rename the dictionary"));
            });
        }}
      >
        辞書名を変更
      </button>
      <button
        className="button button-secondary"
        type="button"
        disabled={dictionaries.length <= 1}
        onClick={() => {
          void deleteUserLexiconDictionary({
            baseUrl: baseUrl(),
            fetcher: fetch,
            auth: clientAuth(),
            id: activeId,
          })
            .then(() => refreshCatalog())
            .then(() => loadPage({ q: committedQuery, cursor: "" }))
            .catch((error: unknown) => {
              setNotice(noticeFromError(error, "could not delete the dictionary"));
            });
        }}
      >
        辞書を削除
      </button>
      <form
        className="custom-dictionary-form"
        data-testid="custom-dictionary-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPreviousCursors([]);
          setPageCursor("");
          setCommittedQuery(query.trim());
        }}
      >
        <label className="field-label" htmlFor="custom-dictionary-search">
          検索
          <input
            id="custom-dictionary-search"
            data-testid="custom-dictionary-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="よみまたは単語"
            spellCheck={false}
          />
        </label>
        <button className="button button-secondary" type="submit" disabled={loading}>
          検索
        </button>
      </form>
      <form
        className="custom-dictionary-form"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            try {
              await addUserLexiconEntry({
                baseUrl: baseUrl(),
                fetcher: fetch,
                auth: clientAuth(),
                reading,
                word,
              });
              setReading("");
              setWord("");
              setPreviousCursors([]);
              setPageCursor("");
              setNotice("Added the word on the Worker");
              await loadPage({ q: committedQuery, cursor: "" });
            } catch (error) {
              setNotice(noticeFromError(error, "could not add the entry"));
            }
          })();
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
        <p className="field-help">よみはひらがな2文字以上必要です。</p>
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
        <button
          className="button button-secondary"
          type="submit"
          disabled={loading || [...reading.trim()].length < USER_LEXICON_MIN_READING_CHARS}
        >
          追加
        </button>
      </form>
      <label className="field-label" htmlFor="custom-dictionary-file">
        TSV / CSV を Worker へ取り込む（R2 経由のキュー処理、選択中の辞書へ追記）
        <input
          id="custom-dictionary-file"
          type="file"
          accept=".json,.tsv,.csv,text/csv,text/tab-separated-values,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file || !activeId) {
              return;
            }
            void (async () => {
              try {
                const job = await startUserLexiconQueuedImport({
                  baseUrl: baseUrl(),
                  fetcher: fetch,
                  auth: clientAuth(),
                  dictionaryId: activeId,
                  file,
                });
                setImportJob(job);
                setPreviousCursors([]);
                setPageCursor("");
                setNotice(
                  `Import ${job.status}: ${job.accepted} accepted / ${job.processed} processed`,
                );
                if (job.status === "completed") {
                  await loadPage({ q: committedQuery, cursor: "" });
                  await refreshCatalog();
                }
              } catch (error) {
                setNotice(noticeFromError(error, "could not import the file"));
              }
            })();
          }}
        />
      </label>
      {importJob ? (
        <p className="field-help" data-testid="custom-dictionary-import-progress">
          取り込み {importJob.status}: {importJob.processed} / {importJob.total} 行（採用{" "}
          {importJob.accepted}）{importJob.error ? ` — ${importJob.error}` : ""}
        </p>
      ) : null}
      {notice ? (
        <p className="field-help" data-testid="custom-dictionary-notice">
          {notice}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="field-help" data-testid="custom-dictionary-empty">
          {loading ? "Worker から読み込み中…" : "このページに表示する単語はありません。"}
        </p>
      ) : (
        <ul className="custom-dictionary-list" data-testid="custom-dictionary-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>
                {entry.reading} → {entry.word}
              </span>
              <button
                className="button button-secondary"
                type="button"
                disabled={loading}
                onClick={() => {
                  void (async () => {
                    try {
                      await deleteUserLexiconEntry({
                        baseUrl: baseUrl(),
                        fetcher: fetch,
                        auth: clientAuth(),
                        id: entry.id,
                      });
                      const remaining = await loadPage({
                        q: committedQuery,
                        cursor: pageCursor,
                      });
                      if (remaining || previousCursors.length === 0) {
                        setNotice("Deleted the word on the Worker");
                        return;
                      }
                      const previous = previousUserLexiconCursorState({
                        previousCursors,
                        currentCursor: pageCursor,
                      });
                      setPreviousCursors(previous.previousCursors);
                      setPageCursor(previous.currentCursor);
                      setNotice("Deleted the word on the Worker");
                    } catch (error) {
                      setNotice(noticeFromError(error, "could not delete the entry"));
                    }
                  })();
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="custom-dictionary-pager" data-testid="custom-dictionary-pager">
        <button
          className="button button-secondary"
          type="button"
          disabled={loading || previousCursors.length === 0}
          onClick={() => {
            const previous = previousUserLexiconCursorState({
              previousCursors,
              currentCursor: pageCursor,
            });
            setPreviousCursors(previous.previousCursors);
            setPageCursor(previous.currentCursor);
          }}
        >
          前へ
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={loading || nextCursor.length === 0}
          onClick={() => {
            const next = nextUserLexiconCursorState({
              previousCursors,
              currentCursor: pageCursor,
              nextCursor,
            });
            setPreviousCursors(next.previousCursors);
            setPageCursor(next.currentCursor);
          }}
        >
          次へ
        </button>
      </div>
    </div>
  );
};
