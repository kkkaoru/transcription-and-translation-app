"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VibratoModeSelector } from "../components/VibratoModeSelector";
import {
  shouldRunBrowserVibratoPrePass,
  shouldWarmBrowserDictionaryAfterConfigChange,
  shouldWarmBrowserVibratoDictionary,
} from "../lib/azookey-reading";
import {
  browserVibratoConfigFromComparison,
  runBrowserVibrato,
  warmupBrowserVibrato,
} from "../lib/browser-vibrato";
import { type BrowserWasmState, browserWasmStateAfterStage } from "../lib/browser-wasm-status";
import {
  browserWasmConfigurationStatus,
  buildVibratoWebSocketUrl,
  type ComparisonAuth,
  type ComparisonConfig,
  type ComparisonMode,
  comparisonModeOptions,
  DEFAULT_COMPARISON_CONFIG,
  hasBrowserWasmConfiguration,
} from "../lib/contract";
import {
  AZOOKEY_CONVERSION_FIXTURES,
  type AzookeyConversionFixture,
} from "../lib/conversion-fixtures";
import { converterModelOptions, isConverterModel } from "../lib/converter-models";
import { type ConversionStage, comparisonPathSummary, rowPathLabel } from "../lib/path-labels";
import { syncSpeechLanguage } from "../lib/speech-language";
import {
  type SpeechRecognitionState,
  type SpeechTranscriptUpdate,
  WebSpeechController,
} from "../lib/web-speech";
import {
  type AzooKeyConvertResult,
  AzooKeyWorkerClient,
  type WorkerConnectionState,
  workerErrorStage,
} from "../lib/worker-client";

type ComparisonRowState = "queued" | "wasm" | "sending" | "done" | "error";
type ComparisonRowOrigin = "web-speech" | "manual" | "fixture";

interface ComparisonRow {
  id: string;
  sourceText: string;
  vibratoInput?: string;
  convertedText?: string;
  expectedText?: string;
  state: ComparisonRowState;
  mode: ComparisonMode;
  origin: ComparisonRowOrigin;
  fixtureId?: string;
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
      return "ブラウザ Vibrato WASM 中";
    // This state spans connecting, sending, and awaiting the response, so it
    // must not claim the AzooKey WASM conversion is already running, nor that
    // the request is still being sent.
    case "sending":
      return "Worker 通信中";
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
    ...(process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_DICTIONARY_URL
      ? { browserWasmDictionaryUrl: process.env.NEXT_PUBLIC_AZOO_KEY_VIBRATO_DICTIONARY_URL }
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
  const [droppedRows, setDroppedRows] = useState(0);
  const [latestWorker, setLatestWorker] = useState<ComparisonRow | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [manualReading, setManualReading] = useState("おつかれさまでした");
  const [selectedFixtureId, setSelectedFixtureId] = useState(
    AZOOKEY_CONVERSION_FIXTURES[0]?.id ?? "",
  );
  const [fixtureBusy, setFixtureBusy] = useState(false);

  const speechRef = useRef<WebSpeechController | null>(null);
  const initialSpeechLanguageRef = useRef(config.language);
  const workerRef = useRef<AzooKeyWorkerClient | null>(null);
  const workerVibratoConfiguredRef = useRef<boolean | undefined>(undefined);
  const workerGenerationRef = useRef(0);
  const rowsRef = useRef<ComparisonRow[]>([]);
  const finalTextHandlerRef = useRef<(text: string) => void>(() => undefined);
  /** Serialize browser pre-pass + Worker work so rapid finals retain order. */
  const dispatchQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const generation = workerGenerationRef.current + 1;
    workerGenerationRef.current = generation;
    let endpoint = config.websocketUrl;
    try {
      endpoint = buildVibratoWebSocketUrl({ websocketUrl: config.websocketUrl });
    } catch {
      // The input remains editable; connect/submit surfaces the validation error.
    }
    const client = new AzooKeyWorkerClient({
      endpoint,
      onStateChange: (state) => {
        // A close/error callback from a retired client must not overwrite the
        // state of the replacement client created for the edited URL.
        if (workerGenerationRef.current === generation) {
          setWorkerState(state);
        }
      },
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
    const controller = new WebSpeechController(initialSpeechLanguageRef.current, {
      onStateChange: (state) => {
        setSpeechState(state);
        if (state === "listening") {
          setError("");
        }
      },
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
  }, []);

  // Keep one browser recognition session alive while settings are edited. A
  // dependency on `config.language` here would dispose the active controller,
  // leave the button showing "stop", and route future finals to an idle
  // replacement. The Web Speech implementation picks up the new language on
  // the next browser restart without losing the current state machine.
  useEffect(() => {
    syncSpeechLanguage(speechRef.current, config.language);
  }, [config.language]);

  const appendRow = useCallback((row: ComparisonRow): void => {
    const current = rowsRef.current;
    const overflow = Math.max(0, current.length + 1 - MAX_ROWS);
    const next = [row, ...current].slice(0, MAX_ROWS);
    rowsRef.current = next;
    setRows(next);
    if (overflow > 0) {
      setDroppedRows((count) => count + overflow);
      setNotice(`履歴は最大 ${MAX_ROWS} 件です。古い ${overflow} 件を省略しました`);
    }
  }, []);

  const dispatchFinalText = useCallback(
    async (
      sourceText: string,
      mode: ComparisonMode,
      wasmModuleUrl: string,
      dictionaryUrl: string,
      wasmGlobalName: string,
      language: string,
      auth: ComparisonAuth,
      converterModel: string,
      options: {
        origin?: ComparisonRowOrigin;
        expectedText?: string;
        fixtureId?: string;
        /**
         * When set, skip browser Vibrato and feed this string as `vibratoInput`.
         * Manual / fixture checks already supply a phonetic reading, so they
         * exercise the Worker AzooKey path directly.
         */
        phoneticInput?: string;
      } = {},
    ): Promise<void> => {
      const normalizedSource = sourceText.trim();
      if (!normalizedSource) {
        return;
      }
      const origin = options.origin ?? "web-speech";
      const id = createId();
      const initialRow: ComparisonRow = {
        id,
        sourceText: normalizedSource,
        state: "queued",
        mode,
        origin,
        ...(options.expectedText !== undefined ? { expectedText: options.expectedText } : {}),
        ...(options.fixtureId !== undefined ? { fixtureId: options.fixtureId } : {}),
        createdAt: Date.now(),
      };
      appendRow(initialRow);
      setLatestWorker(initialRow);
      setError("");

      const patchRow = (patch: Partial<ComparisonRow>): void => {
        const nextRows = rowsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row));
        rowsRef.current = nextRows;
        setRows(nextRows);
        setLatestWorker((current) => (current?.id === id ? { ...current, ...patch } : current));
      };

      const forcedPhonetic = options.phoneticInput?.trim();
      let vibratoInput = forcedPhonetic || normalizedSource;
      let wasmElapsedMs: number | undefined;
      let ranBrowserVibrato = false;
      // Tracks the stage in flight so a failure is attributed to the stage that
      // actually failed, rather than to whichever stage happened to run last.
      let stage: ConversionStage = "setup";
      try {
        if (auth.scheme === "bearer" && !auth.token?.trim()) {
          throw new Error("Bearer token を入力してください");
        }
        // Phonetic fixture/manual checks already supply the reading AzooKey
        // expects. Worker mode still runs browser Vibrato for kanji-bearing
        // Web Speech so mixed ASR matches Tauri when Worker Vibrato is passthrough.
        if (shouldRunBrowserVibratoPrePass(mode, normalizedSource, forcedPhonetic)) {
          setBrowserWasmState("loading");
          patchRow({ state: "wasm" });
          stage = "browser-wasm";
          try {
            const wasmResult = await runBrowserVibrato(normalizedSource, {
              moduleUrl: wasmModuleUrl,
              dictionaryUrl,
              globalName: wasmGlobalName,
            });
            vibratoInput = wasmResult.text;
            wasmElapsedMs = wasmResult.elapsedMs;
            ranBrowserVibrato = true;
            setBrowserWasmState((current) =>
              browserWasmStateAfterStage(current, "browser-wasm", true),
            );
          } catch (caught) {
            if (mode === "browser-vibrato") {
              // Browser mode requires the pre-pass. Worker mode fail-opens like Tauri.
              setBrowserWasmState((current) =>
                browserWasmStateAfterStage(current, "browser-wasm", false),
              );
              throw caught;
            }
            vibratoInput = normalizedSource;
          }
          patchRow({ state: "sending", vibratoInput, wasmElapsedMs });
        } else {
          patchRow({ state: "sending", vibratoInput });
        }

        // Reaching the Worker is its own stage: staying on browser-wasm would
        // blame a pre-pass that already succeeded, and entering the worker stage
        // would report a conversion failure for a call that never happened.
        // `convert` connects on demand, so the connection is awaited here to keep
        // a connect failure out of the conversion stage.
        stage = "worker-connect";
        const client = workerRef.current;
        if (!client) {
          throw new Error("Worker WebSocket クライアントを初期化できません");
        }
        const workerGeneration = workerGenerationRef.current;
        if (workerRef.current !== client || workerGenerationRef.current !== workerGeneration) {
          throw new Error("Worker 設定が変更されました。発話を再送してください");
        }
        await client.connect();
        if (workerRef.current !== client || workerGenerationRef.current !== workerGeneration) {
          throw new Error("Worker 設定が変更されました。発話を再送してください");
        }
        stage = "worker";
        const result: AzooKeyConvertResult = await client.convert({
          source: "web-speech",
          language,
          sourceText: normalizedSource,
          vibratoInput,
          mode: forcedPhonetic ? "worker-vibrato" : mode,
          model: converterModel,
          vibratoExecution: forcedPhonetic
            ? "worker"
            : ranBrowserVibrato || mode === "browser-vibrato"
              ? "browser-wasm"
              : "worker",
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
        // A protocol refusal, transport failure, and converter failure are
        // different outcomes; only the Worker can prove which one occurred.
        const failedStage = stage === "worker" ? workerErrorStage(caught) : stage;
        patchRow({ state: "error", error: message, vibratoInput, failedStage });
        setError(message);
      }
    },
    [appendRow],
  );

  // Keep the controller callback stable while routing each final utterance to
  // the latest selected mode and WASM settings.
  finalTextHandlerRef.current = (text) => {
    const dispatch = dispatchQueueRef.current.then(() =>
      dispatchFinalText(
        text,
        config.mode,
        config.browserWasmModuleUrl ?? "",
        config.browserWasmDictionaryUrl ?? "",
        config.browserWasmGlobalName ?? "",
        config.language,
        config.auth,
        config.converterModel,
        { origin: "web-speech" },
      ),
    );
    // Keep the chain alive after an unexpected observer/React failure. The
    // conversion function normally catches stage errors itself, but this
    // guard prevents one rapid utterance from blocking all later finals.
    dispatchQueueRef.current = dispatch.catch(() => undefined);
    void dispatch;
  };

  const enqueueConversion = useCallback(
    (sourceText: string, options: Parameters<typeof dispatchFinalText>[8]): void => {
      const dispatch = dispatchQueueRef.current.then(() =>
        dispatchFinalText(
          sourceText,
          config.mode,
          config.browserWasmModuleUrl ?? "",
          config.browserWasmDictionaryUrl ?? "",
          config.browserWasmGlobalName ?? "",
          config.language,
          config.auth,
          config.converterModel,
          options,
        ),
      );
      dispatchQueueRef.current = dispatch.catch(() => undefined);
      void dispatch;
    },
    [
      config.auth,
      config.browserWasmDictionaryUrl,
      config.browserWasmGlobalName,
      config.browserWasmModuleUrl,
      config.converterModel,
      config.language,
      config.mode,
      dispatchFinalText,
    ],
  );

  const submitManualReading = (): void => {
    const reading = manualReading.trim();
    if (!reading) {
      setError("かな読みを入力してください");
      return;
    }
    setNotice("かな読みを Worker AzooKey へ送信しています");
    enqueueConversion(reading, {
      origin: "manual",
      phoneticInput: reading,
    });
  };

  const runConversionFixture = (fixture: AzookeyConversionFixture): void => {
    setNotice(`フィクスチャ「${fixture.label}」を Worker へ送信しています`);
    enqueueConversion(fixture.reading, {
      origin: "fixture",
      phoneticInput: fixture.reading,
      expectedText: fixture.expected,
      fixtureId: fixture.id,
    });
  };

  const runSelectedFixture = (): void => {
    const fixture = AZOOKEY_CONVERSION_FIXTURES.find((entry) => entry.id === selectedFixtureId);
    if (!fixture) {
      setError("フィクスチャを選択してください");
      return;
    }
    runConversionFixture(fixture);
  };

  const runAllConversionFixtures = async (): Promise<void> => {
    if (fixtureBusy) {
      return;
    }
    setFixtureBusy(true);
    setNotice("変換フィクスチャを順に実行しています");
    try {
      for (const fixture of AZOOKEY_CONVERSION_FIXTURES) {
        await new Promise<void>((resolve) => {
          const dispatch = dispatchQueueRef.current.then(() =>
            dispatchFinalText(
              fixture.reading,
              config.mode,
              config.browserWasmModuleUrl ?? "",
              config.browserWasmDictionaryUrl ?? "",
              config.browserWasmGlobalName ?? "",
              config.language,
              config.auth,
              config.converterModel,
              {
                origin: "fixture",
                phoneticInput: fixture.reading,
                expectedText: fixture.expected,
                fixtureId: fixture.id,
              },
            ),
          );
          dispatchQueueRef.current = dispatch
            .catch(() => undefined)
            .then(() => {
              resolve();
            });
        });
      }
      setNotice("変換フィクスチャの実行が完了しました");
    } finally {
      setFixtureBusy(false);
    }
  };

  const browserWasmConfigured = hasBrowserWasmConfiguration(config);

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
            browserWasmDictionaryUrl: config.browserWasmDictionaryUrl,
            browserWasmGlobalName: config.browserWasmGlobalName,
          })
        : "",
    [
      config.mode,
      config.browserWasmModuleUrl,
      config.browserWasmDictionaryUrl,
      config.browserWasmGlobalName,
    ],
  );

  const warmBrowserVibratoIfNeeded = useCallback(
    async (workerVibratoConfigured?: boolean): Promise<void> => {
      if (!shouldWarmBrowserVibratoDictionary(config.mode, workerVibratoConfigured)) {
        return;
      }
      setBrowserWasmState("loading");
      try {
        await warmupBrowserVibrato(browserVibratoConfigFromComparison(config));
        setBrowserWasmState("ready");
      } catch (caught) {
        setBrowserWasmState("error");
        throw caught;
      }
    },
    [config],
  );

  const toggleListening = (): void => {
    const controller = speechRef.current;
    if (!controller || !speechSupported) {
      setError("このブラウザは Web Speech API に対応していません");
      return;
    }
    if (speechState === "listening" || speechState === "starting") {
      controller.stop();
      return;
    }
    setError("");
    void warmBrowserVibratoIfNeeded(workerVibratoConfiguredRef.current)
      .catch((caught: unknown) => {
        if (config.mode === "browser-vibrato") {
          setError(errorMessage(caught));
          return false;
        }
        setNotice(`ブラウザ辞書の先行読み込みに失敗しました: ${errorMessage(caught)}`);
        return true;
      })
      .then((shouldStart) => {
        if (shouldStart === false) {
          return;
        }
        controller.start();
      });
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
      let notice = "Worker WebSocket に接続しました";
      let workerVibratoConfigured: boolean | undefined;
      try {
        const healthUrl = new URL(config.websocketUrl.trim());
        healthUrl.protocol = healthUrl.protocol === "wss:" ? "https:" : "http:";
        healthUrl.pathname = "/v1/azookey";
        healthUrl.search = "";
        healthUrl.hash = "";
        const health = await fetch(healthUrl).then(async (response) =>
          response.ok
            ? ((await response.json()) as {
                dictionary?: { transport?: string };
                vibrato?: { workerStage?: string };
              })
            : null,
        );
        workerVibratoConfigured = health?.vibrato?.workerStage === "configured";
        workerVibratoConfiguredRef.current = workerVibratoConfigured;
        if (health?.dictionary?.transport === "builtin") {
          notice =
            "Worker は内蔵語彙のみです。AZOOKEY_DICTIONARY_URL を設定しないと Tauri より精度が落ちます";
        } else if (health?.dictionary?.transport === "portable-wasm") {
          notice = "Worker WebSocket に接続しました（公式 AzooKey 辞書）";
        }
      } catch {
        // Health is observability only; conversion can still proceed.
      }
      try {
        await warmBrowserVibratoIfNeeded(workerVibratoConfigured);
        if (shouldWarmBrowserVibratoDictionary(config.mode, workerVibratoConfigured)) {
          notice = `${notice} / ブラウザ IPADIC を先行読み込み済み`;
        }
      } catch (caught) {
        if (config.mode === "browser-vibrato") {
          throw caught;
        }
        notice = `${notice}（ブラウザ辞書の先行読み込みは後続発話時に再試行します）`;
      }
      setNotice(notice);
      setError("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const updateConfig = <K extends keyof ComparisonConfig>(key: K, value: ComparisonConfig[K]) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    // The browser WASM status describes the previous settings. A changed mode
    // or pre-pass configuration must not keep claiming ready/error until the
    // new configuration has actually been exercised.
    if (!shouldWarmBrowserDictionaryAfterConfigChange(String(key), speechState, workerState)) {
      if (
        key === "mode" ||
        key === "browserWasmModuleUrl" ||
        key === "browserWasmDictionaryUrl" ||
        key === "browserWasmGlobalName"
      ) {
        setBrowserWasmState("idle");
      }
      return;
    }
    if (!shouldWarmBrowserVibratoDictionary(next.mode, workerVibratoConfiguredRef.current)) {
      setBrowserWasmState("idle");
      return;
    }
    setBrowserWasmState("loading");
    void warmupBrowserVibrato(browserVibratoConfigFromComparison(next))
      .then(() => {
        setBrowserWasmState("ready");
      })
      .catch((caught: unknown) => {
        setBrowserWasmState("error");
        if (next.mode === "browser-vibrato") {
          setError(errorMessage(caught));
          return;
        }
        setNotice(`ブラウザ辞書の先行読み込みに失敗しました: ${errorMessage(caught)}`);
      });
  };

  const clearComparison = (): void => {
    rowsRef.current = [];
    setRows([]);
    setDroppedRows(0);
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
        {/* Derived from the selected mode and the settings form, so it states the
            chosen route rather than one a request has travelled. */}
        <div className="path-chip" role="status" aria-label="選択中の処理経路">
          <span
            className={`status-dot ${
              config.mode === "browser-vibrato" && !browserWasmConfigured ? "" : "status-dot-live"
            }`}
            aria-hidden="true"
          />
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
              }}
              label="前処理の実行場所"
              description={selectedModeOption?.description}
            />

            <label className="field-label" htmlFor="converter-model">
              変換モデル
              <select
                id="converter-model"
                data-testid="converter-model-select"
                value={config.converterModel}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isConverterModel(next)) {
                    updateConfig("converterModel", next);
                  }
                }}
                aria-describedby="converter-model-description"
              >
                {converterModelOptions.map((option) => (
                  <option key={option.value} value={option.value} title={option.description}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p
              className="field-help"
              id="converter-model-description"
              data-testid="converter-model-description"
            >
              {converterModelOptions.find((option) => option.value === config.converterModel)
                ?.description ?? ""}
            </p>

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
              既定はローカル wrangler（`ws://127.0.0.1:8787/ws/azookey`）。接続エラーなら `bun run
              worker:dev` を先に起動してください。デプロイ先は `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL`
              で上書きできます。
            </p>

            {config.mode === "browser-vibrato" ? (
              <div className="subsection browser-wasm-settings">
                <p className="subsection-title">Browser Vibrato WASM 設定（このモードでは必須）</p>
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
                <label className="field-label" htmlFor="wasm-dictionary-url">
                  Vibrato 辞書 URL（IPADIC F[7]、生成 module では必須）
                  <input
                    id="wasm-dictionary-url"
                    type="url"
                    inputMode="url"
                    value={config.browserWasmDictionaryUrl ?? ""}
                    onChange={(event) =>
                      updateConfig("browserWasmDictionaryUrl", event.target.value)
                    }
                    placeholder="/vibrato/system.dic.zst"
                    spellCheck={false}
                  />
                </label>
                <p className="field-help">
                  既定の wasm-bindgen module（`/vibrato/vibrato_wasm.js`）は `VibratoTokenizer` と
                  `initSync` を export し、この辞書の IPADIC F[7] を ひらがなへ変換します。独自
                  module を使う場合は、`convert(text)`、 `transform(text)`、`tokenize(text)`
                  のいずれかを export する wrapper の URL、または注入済み global
                  を指定します。モジュール URL も global 名も空のときはブラウザ Vibrato WASM
                  が未設定のためプリパスを実行できず失敗します（Worker 側 Vibrato
                  へはサイレントフォールバックしません）。空の global 名で実行した場合のみ、
                  実行時フォールバックとして既定名 `__AZOOKEY_VIBRATO_WASM__` を試します。 AzooKey
                  のかな→漢字変換は常に Worker 側の AzooKey WASM で実行します。
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

          <section className="panel reading-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">PHONETIC INPUT</p>
                <h3>読み入力</h3>
              </div>
            </div>
            <p className="field-help">
              かな読みを Worker の AzooKey WASM へ直接送り、変換結果を確認します。
            </p>
            <label className="field-label" htmlFor="manual-reading">
              かな読み
              <textarea
                id="manual-reading"
                rows={3}
                value={manualReading}
                onChange={(event) => setManualReading(event.target.value)}
                placeholder="おつかれさまでした"
                spellCheck={false}
              />
            </label>
            <button className="button button-primary" type="button" onClick={submitManualReading}>
              読みを変換
            </button>

            <div className="subsection fixture-settings">
              <p className="subsection-title">変換フィクスチャ</p>
              <label className="field-label" htmlFor="conversion-fixture">
                ケース
                <select
                  id="conversion-fixture"
                  value={selectedFixtureId}
                  onChange={(event) => setSelectedFixtureId(event.target.value)}
                >
                  {AZOOKEY_CONVERSION_FIXTURES.map((fixture) => (
                    <option key={fixture.id} value={fixture.id}>
                      {fixture.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-help">
                {AZOOKEY_CONVERSION_FIXTURES.find((fixture) => fixture.id === selectedFixtureId)
                  ?.note ?? ""}
              </p>
              <div className="button-row">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={runSelectedFixture}
                  disabled={fixtureBusy}
                >
                  選択ケースを実行
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void runAllConversionFixtures()}
                  disabled={fixtureBusy}
                >
                  全ケース実行
                </button>
              </div>
            </div>
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
                    ? rowPathLabel(latestWorker.mode, latestWorker.state, latestWorker.failedStage)
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
                <span>
                  Web Speech、手動読み、または変換フィクスチャから Worker 変換を実行できます。
                </span>
              </div>
            ) : (
              <ol className="comparison-list">
                {rows.map((row, index) => {
                  const expectationMet =
                    row.state === "done" &&
                    row.expectedText !== undefined &&
                    row.convertedText === row.expectedText;
                  const expectationMissed =
                    row.state === "done" &&
                    row.expectedText !== undefined &&
                    row.convertedText !== row.expectedText;
                  return (
                    <li className="comparison-row" key={row.id}>
                      <span className="row-number">
                        {String(rows.length - index).padStart(2, "0")}
                      </span>
                      <div className="row-source">
                        <span className="row-label">
                          {row.origin === "fixture"
                            ? "Fixture"
                            : row.origin === "manual"
                              ? "Manual reading"
                              : "Web Speech"}
                        </span>
                        <p>{row.sourceText}</p>
                        {row.vibratoInput && row.vibratoInput !== row.sourceText ? (
                          <span className="row-meta">vibratoInput: {row.vibratoInput}</span>
                        ) : null}
                        {row.expectedText ? (
                          <span
                            className={`row-meta ${expectationMissed ? "row-meta-miss" : expectationMet ? "row-meta-hit" : ""}`}
                          >
                            expected: {row.expectedText}
                            {expectationMet ? " ✓" : expectationMissed ? " ✗" : ""}
                          </span>
                        ) : null}
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
                          {rowPathLabel(row.mode, row.state, row.failedStage)}
                          {row.wasmElapsedMs !== undefined
                            ? ` · WASM ${formatMilliseconds(row.wasmElapsedMs)}`
                            : ""}
                          {row.workerElapsedMs !== undefined
                            ? ` · Worker ${formatMilliseconds(row.workerElapsedMs)}`
                            : ""}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
            {droppedRows > 0 ? (
              <p className="field-help" role="status">
                表示上限に達したため、古い発話 {droppedRows} 件を省略しています。履歴をクリアすると
                件数をリセットできます。
              </p>
            ) : null}
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
          {droppedRows > 0 ? ` · ${droppedRows} omitted` : ""}
        </span>
      </footer>
    </main>
  );
}
