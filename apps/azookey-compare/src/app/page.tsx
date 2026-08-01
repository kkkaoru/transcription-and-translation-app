"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VibratoModeSelector } from "../components/VibratoModeSelector";
import { runBrowserVibrato } from "../lib/browser-vibrato";
import { type BrowserWasmState, browserWasmStateAfterStage } from "../lib/browser-wasm-status";
import {
  browserWasmConfigurationStatus,
  buildVibratoWebSocketUrl,
  type ComparisonAuth,
  type ComparisonConfig,
  type ComparisonMode,
  comparisonModeOptions,
  DEFAULT_COMPARISON_CONFIG,
} from "../lib/contract";
import {
  attemptedPathLabel,
  type ConversionStage,
  comparisonPathSummary,
} from "../lib/path-labels";
import {
  type SpeechRecognitionState,
  type SpeechTranscriptUpdate,
  WebSpeechController,
} from "../lib/web-speech";
import {
  type AzooKeyConvertResult,
  AzooKeyWorkerClient,
  type WorkerConnectionState,
} from "../lib/worker-client";

type ComparisonRowState = "queued" | "wasm" | "sending" | "done" | "error";

interface ComparisonRow {
  id: string;
  sourceText: string;
  vibratoInput?: string;
  convertedText?: string;
  state: ComparisonRowState;
  mode: ComparisonMode;
  wasmElapsedMs?: number;
  workerElapsedMs?: number;
  error?: string;
  failedStage?: ConversionStage;
  createdAt: number;
}

const MAX_ROWS = 24;

const createId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `utterance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const speechStateLabel = (state: SpeechRecognitionState): string => {
  switch (state) {
    case "starting":
      return "起動中";
    case "listening":
      return "認識中";
    case "stopping":
      return "停止中";
    case "error":
      return "エラー";
    default:
      return "待機中";
  }
};

const workerStateLabel = (state: WorkerConnectionState): string => {
  switch (state) {
    case "connecting":
      return "接続中";
    case "open":
      return "接続済み";
    case "error":
      return "接続エラー";
    case "closed":
      return "切断";
    default:
      return "未接続";
  }
};

const rowStateLabel = (state: ComparisonRowState): string => {
  switch (state) {
    case "queued":
      return "送信待ち";
    case "wasm":
      return "ブラウザ WASM プリパス中";
    case "sending":
      return "Worker AzooKey WASM 処理中";
    case "done":
      return "完了";
    default:
      return "失敗";
  }
};

const formatMilliseconds = (value: number | undefined): string =>
  value === undefined ? "—" : `${Math.round(value)} ms`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "予期しないエラーが発生しました";

const authForRequest = (auth: ComparisonAuth): ComparisonAuth =>
  auth.scheme === "bearer"
    ? { scheme: "bearer", token: auth.token?.trim() ?? "" }
    : { scheme: "none" };

export default function ComparePage() {
  const [config, setConfig] = useState<ComparisonConfig>(() => ({
    ...DEFAULT_COMPARISON_CONFIG,
    ...(process.env.NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL
      ? { websocketUrl: process.env.NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL }
      : {}),
    ...(process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL
      ? { browserWasmModuleUrl: process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_URL }
      : {}),
    ...(process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_GLOBAL
      ? { browserWasmGlobalName: process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_WASM_GLOBAL }
      : {}),
  }));
  const [speechSupported, setSpeechSupported] = useState(false);
  const [speechState, setSpeechState] = useState<SpeechRecognitionState>("idle");
  const [workerState, setWorkerState] = useState<WorkerConnectionState>("idle");
  const [browserWasmState, setBrowserWasmState] = useState<BrowserWasmState>("idle");
  const [speechFinalText, setSpeechFinalText] = useState("");
  const [speechInterimText, setSpeechInterimText] = useState("");
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [latestWorker, setLatestWorker] = useState<ComparisonRow | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const speechRef = useRef<WebSpeechController | null>(null);
  const workerRef = useRef<AzooKeyWorkerClient | null>(null);
  const finalTextHandlerRef = useRef<(text: string) => void>(() => undefined);

  useEffect(() => {
    let endpoint = config.websocketUrl;
    try {
      endpoint = buildVibratoWebSocketUrl({ websocketUrl: config.websocketUrl });
    } catch {
      // The input remains editable; connect/submit surfaces the validation error.
    }
    const client = new AzooKeyWorkerClient({
      endpoint,
      onStateChange: setWorkerState,
    });
    workerRef.current = client;
    setWorkerState(client.connectionState);
    return () => {
      client.close();
      if (workerRef.current === client) {
        workerRef.current = null;
      }
    };
  }, [config.websocketUrl]);

  useEffect(() => {
    const controller = new WebSpeechController(config.language, {
      onStateChange: setSpeechState,
      onTranscript: ({ finalText, interimText }: SpeechTranscriptUpdate) => {
        setSpeechFinalText(finalText);
        setSpeechInterimText(interimText);
      },
      onFinalText: (text) => {
        finalTextHandlerRef.current(text);
      },
      onError: (message) => {
        setError(message);
      },
    });
    speechRef.current = controller;
    setSpeechSupported(controller.supported);
    return () => {
      controller.dispose();
      if (speechRef.current === controller) {
        speechRef.current = null;
      }
    };
  }, [config.language]);

  const dispatchFinalText = useCallback(
    async (
      sourceText: string,
      mode: ComparisonMode,
      wasmModuleUrl: string,
      wasmGlobalName: string,
      language: string,
      auth: ComparisonAuth,
    ): Promise<void> => {
      const normalizedSource = sourceText.trim();
      if (!normalizedSource) {
        return;
      }
      const id = createId();
      const initialRow: ComparisonRow = {
        id,
        sourceText: normalizedSource,
        state: "queued",
        mode,
        createdAt: Date.now(),
      };
      setRows((current) => [initialRow, ...current].slice(0, MAX_ROWS));
      setLatestWorker(initialRow);
      setError("");

      const patchRow = (patch: Partial<ComparisonRow>): void => {
        setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
        setLatestWorker((current) => (current?.id === id ? { ...current, ...patch } : current));
      };

      let vibratoInput = normalizedSource;
      let wasmElapsedMs: number | undefined;
      // Tracks the stage in flight so a failure is attributed to the stage that
      // actually failed, rather than to whichever stage happened to run last.
      let stage: ConversionStage = "setup";
      try {
        if (auth.scheme === "bearer" && !auth.token?.trim()) {
          throw new Error("Bearer token を入力してください");
        }
        if (mode === "browser-vibrato") {
          setBrowserWasmState("loading");
          patchRow({ state: "wasm" });
          stage = "browser-wasm";
          try {
            const wasmResult = await runBrowserVibrato(normalizedSource, {
              moduleUrl: wasmModuleUrl,
              globalName: wasmGlobalName,
            });
            vibratoInput = wasmResult.text;
            wasmElapsedMs = wasmResult.elapsedMs;
            setBrowserWasmState((current) =>
              browserWasmStateAfterStage(current, "browser-wasm", true),
            );
          } catch (caught) {
            // Only the browser stage may mark the browser WASM status failed.
            setBrowserWasmState((current) =>
              browserWasmStateAfterStage(current, "browser-wasm", false),
            );
            throw caught;
          }
          patchRow({ state: "sending", vibratoInput, wasmElapsedMs });
        } else {
          patchRow({ state: "sending", vibratoInput });
        }

        // A client we could not initialize means the Worker was never reached.
        // This is its own stage: staying on browser-wasm would blame a pre-pass
        // that already succeeded, and entering worker would report a failure for
        // a call that never happened.
        stage = "worker-connect";
        const client = workerRef.current;
        if (!client) {
          throw new Error("Worker WebSocket クライアントを初期化できません");
        }
        stage = "worker";
        const result: AzooKeyConvertResult = await client.convert({
          source: "web-speech",
          language,
          sourceText: normalizedSource,
          vibratoInput,
          mode,
          vibratoExecution: mode === "browser-vibrato" ? "browser-wasm" : "worker",
          auth: authForRequest(auth),
        });
        patchRow({
          state: "done",
          convertedText: result.convertedText,
          workerElapsedMs: result.elapsedMs,
          vibratoInput,
          ...(wasmElapsedMs !== undefined ? { wasmElapsedMs } : {}),
        });
      } catch (caught) {
        // The browser WASM status is owned by the browser stage above; a Worker
        // or setup failure must not report a pre-pass that succeeded as failed.
        const message = errorMessage(caught);
        patchRow({ state: "error", error: message, vibratoInput, failedStage: stage });
        setError(message);
      }
    },
    [],
  );

  // Keep the controller callback stable while routing each final utterance to
  // the latest selected mode and WASM settings.
  finalTextHandlerRef.current = (text) => {
    void dispatchFinalText(
      text,
      config.mode,
      config.browserWasmModuleUrl ?? "",
      config.browserWasmGlobalName ?? "",
      config.language,
      config.auth,
    );
  };

  const browserWasmConfigured =
    Boolean(config.browserWasmModuleUrl?.trim()) || Boolean(config.browserWasmGlobalName?.trim());

  const pathSummary = useMemo(
    () => comparisonPathSummary(config.mode, browserWasmConfigured),
    [config.mode, browserWasmConfigured],
  );

  const selectedModeOption = useMemo(
    () => comparisonModeOptions.find((option) => option.value === config.mode),
    [config.mode],
  );

  const browserWasmStatus = useMemo(
    () =>
      config.mode === "browser-vibrato"
        ? browserWasmConfigurationStatus({
            browserWasmModuleUrl: config.browserWasmModuleUrl,
            browserWasmGlobalName: config.browserWasmGlobalName,
          })
        : "",
    [config.mode, config.browserWasmModuleUrl, config.browserWasmGlobalName],
  );

  const toggleListening = (): void => {
    const controller = speechRef.current;
    if (!controller || !speechSupported) {
      setError("このブラウザは Web Speech API に対応していません");
      return;
    }
    if (speechState === "listening" || speechState === "starting") {
      controller.stop();
    } else {
      setError("");
      controller.start();
    }
  };

  const connectWorker = async (): Promise<void> => {
    const client = workerRef.current;
    if (!client) {
      setError("Worker WebSocket クライアントを初期化できません");
      return;
    }
    try {
      if (config.auth.scheme === "bearer" && !config.auth.token?.trim()) {
        throw new Error("Bearer token を入力してください");
      }
      buildVibratoWebSocketUrl(config);
      await client.connect();
      setNotice("Worker WebSocket に接続しました");
      setError("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const updateConfig = <K extends keyof ComparisonConfig>(key: K, value: ComparisonConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const clearComparison = (): void => {
    setRows([]);
    setLatestWorker(null);
    setSpeechFinalText("");
    setSpeechInterimText("");
    setNotice("履歴をクリアしました");
  };

  return (
    <main className="compare-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <div>
            <p className="brand-kicker">AZOOKEY LAB</p>
            <h1>認識結果の比較</h1>
          </div>
        </div>
        <span className="surface-badge">Next.js / WebSpeech</span>
      </header>

      <section className="intro-block" aria-labelledby="intro-title">
        <div>
          <p className="eyebrow">ASYNC COMPARISON SURFACE</p>
          <h2 id="intro-title">ブラウザ認識と Worker 変換を同じ発話で見比べる</h2>
          <p className="intro-copy">
            Web Speech API の結果はすぐに表示し、AzooKey の Worker
            応答は到着順に独立して更新します。
          </p>
        </div>
        <div className="path-chip" role="status" aria-label="現在の処理経路">
          <span className="status-dot status-dot-live" aria-hidden="true" />
          {pathSummary}
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="control-stack" aria-label="比較設定">
          <section className="panel config-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CONFIGURATION</p>
                <h3>接続と方式</h3>
              </div>
              <span className={`state-pill state-${workerState}`}>
                {workerStateLabel(workerState)}
              </span>
            </div>

            <VibratoModeSelector
              mode={config.mode}
              onModeChange={(mode) => {
                updateConfig("mode", mode);
                setBrowserWasmState("idle");
              }}
              label="前処理の実行場所"
              description={selectedModeOption?.description}
            />

            <label className="field-label" htmlFor="worker-url">
              Worker WebSocket URL
              <input
                id="worker-url"
                type="url"
                inputMode="url"
                value={config.websocketUrl}
                onChange={(event) => updateConfig("websocketUrl", event.target.value)}
                placeholder="ws://127.0.0.1:8787/ws/azookey"
                spellCheck={false}
              />
            </label>
            <p className="field-help">
              既定はローカル wrangler（`ws://127.0.0.1:8787/ws/azookey`）。デプロイ先は
              `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL` で上書きできます。
            </p>

            {config.mode === "browser-vibrato" ? (
              <div className="subsection browser-wasm-settings">
                <p className="subsection-title">Browser WASM プリパス設定（このモードでは必須）</p>
                <p className="field-help" data-testid="browser-wasm-config-status">
                  {browserWasmStatus}
                </p>
                <label className="field-label" htmlFor="wasm-module-url">
                  JS glue module URL（global 未指定時は必須）
                  <input
                    id="wasm-module-url"
                    type="url"
                    inputMode="url"
                    value={config.browserWasmModuleUrl ?? ""}
                    onChange={(event) => updateConfig("browserWasmModuleUrl", event.target.value)}
                    placeholder="https://localhost:3000/azookey-browser.js"
                    spellCheck={false}
                  />
                </label>
                <label className="field-label" htmlFor="wasm-global-name">
                  global runtime 名（module URL 未指定時は必須）
                  <input
                    id="wasm-global-name"
                    type="text"
                    value={config.browserWasmGlobalName ?? ""}
                    onChange={(event) => updateConfig("browserWasmGlobalName", event.target.value)}
                    placeholder="__AZOOKEY_BROWSER_PREPASS__"
                    spellCheck={false}
                  />
                </label>
                <p className="field-help">
                  このアプリはブラウザ WASM を同梱していません。`convert(text)` または
                  `transform(text)` を export する wrapper の URL、または注入済み global
                  を指定します。モジュール URL も global 名も空のときはブラウザ WASM
                  が未設定のためプリパスを実行できず失敗します（Worker
                  のみへはサイレントフォールバックしません）。空の global 名で実行した場合のみ、
                  実行時フォールバックとして歴史的な既定名 `__AZOOKEY_VIBRATO_WASM__`（Vibrato
                  本体ではない convert 用 global）を試します。 AzooKey のかな→漢字変換は常に Worker
                  側の AzooKey WASM で実行します。
                </p>
                <div className={`mini-status wasm-${browserWasmState}`}>
                  <span className="status-dot" aria-hidden="true" />
                  ブラウザ WASM: {browserWasmState === "idle" ? "未実行" : browserWasmState}
                </div>
              </div>
            ) : null}

            <div className="subsection auth-settings">
              <p className="subsection-title">認証（Worker の契約に合わせる）</p>
              <label className="field-label" htmlFor="auth-scheme">
                方式
                <select
                  id="auth-scheme"
                  value={config.auth.scheme}
                  onChange={(event) => {
                    const scheme = event.target.value === "bearer" ? "bearer" : "none";
                    updateConfig(
                      "auth",
                      scheme === "bearer" ? { scheme, token: config.auth.token ?? "" } : { scheme },
                    );
                  }}
                >
                  <option value="none">なし</option>
                  <option value="bearer">Bearer token</option>
                </select>
              </label>
              {config.auth.scheme === "bearer" ? (
                <label className="field-label" htmlFor="auth-token">
                  Token
                  <input
                    id="auth-token"
                    type="password"
                    value={config.auth.token ?? ""}
                    onChange={(event) =>
                      updateConfig("auth", { scheme: "bearer", token: event.target.value })
                    }
                    autoComplete="off"
                  />
                </label>
              ) : null}
              <p className="field-help">
                Token は URL に追加せず、変換リクエストの認証フィールドにだけ送信します。
              </p>
            </div>

            <label className="field-label" htmlFor="speech-language">
              Web Speech language
              <input
                id="speech-language"
                type="text"
                value={config.language}
                onChange={(event) => updateConfig("language", event.target.value)}
                placeholder="ja-JP"
                spellCheck={false}
              />
            </label>

            <button
              className="button button-secondary"
              type="button"
              onClick={() => void connectWorker()}
            >
              Worker に接続
            </button>
          </section>

          <section className="panel speech-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">WEB SPEECH API</p>
                <h3>認識レーン</h3>
              </div>
              <span className={`state-pill state-${speechState}`}>
                {speechStateLabel(speechState)}
              </span>
            </div>
            <p className="support-line">
              {speechSupported ? "このブラウザで利用できます" : "このブラウザでは利用できません"}
            </p>
            <button
              className={`button button-primary ${speechState === "listening" ? "is-listening" : ""}`}
              type="button"
              onClick={toggleListening}
              disabled={!speechSupported || speechState === "stopping"}
            >
              <span className="record-dot" aria-hidden="true" />
              {speechState === "listening" || speechState === "starting"
                ? "認識を停止"
                : "認識を開始"}
            </button>
            <p className="field-help">
              マイク権限を許可すると、確定した発話ごとに Worker へ非同期送信します。
            </p>
          </section>
        </aside>

        <section className="results-stack" aria-label="比較結果">
          <div className="live-grid">
            <section className="panel live-card speech-live-card">
              <div className="live-card-heading">
                <div>
                  <p className="eyebrow">IMMEDIATE</p>
                  <h3>Web Speech 認識結果</h3>
                </div>
                <span className="lane-index">01</span>
              </div>
              <p className="live-text">{speechFinalText || "発話するとここに表示されます"}</p>
              <p className="interim-text" aria-live="polite">
                {speechInterimText ? `認識中: ${speechInterimText}` : ""}
              </p>
              <div className="live-card-footer">
                <span>確定テキスト</span>
                <strong>{speechFinalText.length} 文字</strong>
              </div>
            </section>

            <section className="panel live-card worker-live-card">
              <div className="live-card-heading">
                <div>
                  <p className="eyebrow">ASYNC WORKER</p>
                  <h3>Worker AzooKey 変換結果</h3>
                </div>
                <span className="lane-index">02</span>
              </div>
              <p
                className={`live-text ${latestWorker?.state === "error" ? "live-text-error" : ""}`}
              >
                {latestWorker?.convertedText ??
                  (latestWorker
                    ? rowStateLabel(latestWorker.state)
                    : "Worker の応答を待っています")}
              </p>
              <p className="interim-text">
                {latestWorker?.error ??
                  (latestWorker
                    ? attemptedPathLabel(latestWorker.mode, latestWorker.failedStage)
                    : "")}
              </p>
              <div className="live-card-footer">
                <span>最新レイテンシ</span>
                <strong>{formatMilliseconds(latestWorker?.workerElapsedMs)}</strong>
              </div>
            </section>
          </div>

          <section className="panel history-panel">
            <div className="panel-heading history-heading">
              <div>
                <p className="eyebrow">TIMELINE</p>
                <h3>発話ごとの比較</h3>
              </div>
              <button className="button button-quiet" type="button" onClick={clearComparison}>
                履歴をクリア
              </button>
            </div>
            {rows.length === 0 ? (
              <div className="empty-state">
                <span className="empty-glyph" aria-hidden="true">
                  ◌
                </span>
                <p>確定発話がまだありません</p>
                <span>認識を開始すると、Web Speech と Worker の結果を同じ行で追跡できます。</span>
              </div>
            ) : (
              <ol className="comparison-list">
                {rows.map((row, index) => (
                  <li className="comparison-row" key={row.id}>
                    <span className="row-number">
                      {String(rows.length - index).padStart(2, "0")}
                    </span>
                    <div className="row-source">
                      <span className="row-label">Web Speech</span>
                      <p>{row.sourceText}</p>
                    </div>
                    <span className="row-arrow" aria-hidden="true">
                      →
                    </span>
                    <div className="row-worker">
                      <span className={`row-state row-state-${row.state}`}>
                        {rowStateLabel(row.state)}
                      </span>
                      <p>{row.convertedText ?? row.error ?? "—"}</p>
                      <span className="row-meta">
                        {attemptedPathLabel(row.mode, row.failedStage)}
                        {row.wasmElapsedMs !== undefined
                          ? ` · WASM ${formatMilliseconds(row.wasmElapsedMs)}`
                          : ""}
                        {row.workerElapsedMs !== undefined
                          ? ` · Worker ${formatMilliseconds(row.workerElapsedMs)}`
                          : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </section>
      </div>

      <footer className="status-footer" aria-live="polite">
        <span
          className={`status-dot ${error ? "status-dot-error" : "status-dot-live"}`}
          aria-hidden="true"
        />
        <span>{error || notice || "結果はブラウザ内だけに表示されます"}</span>
        <span className="footer-spacer" />
        <span>
          {rows.length} / {MAX_ROWS} events
        </span>
      </footer>
    </main>
  );
}
