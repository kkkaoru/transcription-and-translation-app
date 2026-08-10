"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchitectureAssetTable } from "../components/ArchitectureAssetTable";
import { ComparisonPathDiagram } from "../components/ComparisonPathDiagram";
import { VibratoModeSelector } from "../components/VibratoModeSelector";
import { RecognitionModeSelector } from "../components/RecognitionModeSelector";
import { isArchitectureDialogForced } from "../lib/architecture-dialog";
import {
  shouldWarmBrowserDictionaryAfterConfigChange,
  shouldWarmBrowserVibratoDictionary,
} from "../lib/azookey-reading";
import { runBrowserAzookey, warmupBrowserAzookey } from "../lib/browser-azookey";
import {
  BROWSER_ZENZAI_DICT_NOTICE,
  runBrowserZenzaiDict,
  warmupBrowserZenzaiDict,
} from "../lib/browser-zenzai";
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
  type RecognitionProvider,
  comparisonModeOptions,
  DEFAULT_COMPARISON_CONFIG,
  hasBrowserWasmConfiguration,
} from "../lib/contract";
import {
  AZOOKEY_CONVERSION_FIXTURES,
  type AzookeyConversionFixture,
} from "../lib/conversion-fixtures";
import { runComparisonConversion, usesBrowserZenzaiDictPath } from "../lib/conversion-pipeline";
import { formatMilliseconds, formatRowTiming } from "../lib/conversion-timing";
import {
  conversionTraceDisplayLines,
  type ConversionTrace,
  traceStepLocationLabel,
} from "../lib/conversion-trace";
import {
  CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL,
  estimateCloudflareConversionCost,
  formatCloudflareCostUsd,
  usesExternalGgufUpstream,
  type CloudflareConversionCostEstimate,
} from "../lib/cloudflare-conversion-cost";
import { buildWorkersAiAsrUrl } from "../lib/inference-proxy";
import {
  estimateWorkersAiAsrCost,
  webSpeechAsrCostSummaryJa,
  workersAiAsrCostSummaryJa,
} from "../lib/workers-ai-asr-cost";
import {
  WorkersAiAsrController,
  type WorkersAiAsrState,
} from "../lib/workers-ai-asr-controller";
import {
  converterModelOptions,
  DEFAULT_CONVERTER_MODEL,
  isConverterModel,
  isZenzConverterModel,
} from "../lib/converter-models";
import { type ConversionStage, comparisonPathSummary, rowPathLabel } from "../lib/path-labels";
import { visibleWebSpeechCaption } from "../lib/speech-caption-display";
import { syncSpeechLanguage } from "../lib/speech-language";
import { pendingSpeechUtterance, rememberDispatchedSpeech } from "../lib/speech-utterance";
import {
  type SpeechRecognitionEnded,
  type SpeechRecognitionState,
  type SpeechTranscriptUpdate,
  type SpeechUtteranceFinal,
  WebSpeechController,
} from "../lib/web-speech";
import {
  AzooKeyWorkerClient,
  type WorkerConnectionState,
  workerErrorStage,
} from "../lib/worker-client";

type ComparisonRowState = "queued" | "wasm" | "sending" | "done" | "error";
type ComparisonRowOrigin = "web-speech" | "workers-ai-asr" | "manual" | "fixture";

interface ComparisonRow {
  id: string;
  sourceText: string;
  vibratoInput?: string;
  convertedText?: string;
  expectedText?: string;
  state: ComparisonRowState;
  mode: ComparisonMode;
  origin: ComparisonRowOrigin;
  recognitionProvider?: RecognitionProvider;
  audioSeconds?: number;
  fixtureId?: string;
  wasmElapsedMs?: number;
  workerElapsedMs?: number;
  totalElapsedMs?: number;
  error?: string;
  failedStage?: ConversionStage;
  trace?: ConversionTrace;
  usedWebSocket?: boolean;
  openedNewWebSocket?: boolean;
  requestedModel?: string;
  resolvedModel?: string;
  modelFallback?: string;
  failedBeforeInference?: boolean;
  /** Workers AI ASR estimate when an ASR path ran (filled by ASR lane). */
  asrCostUsd?: number;
  asrCostSummaryJa?: string;
  createdAt: number;
}

const MAX_ROWS = 24;

const createId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `utterance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const speechStateLabel = (state: SpeechRecognitionState | WorkersAiAsrState): string => {
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

const conversionCostBreakdownLabelJa = (label: string): string => {
  switch (label) {
    case "compare WebSocket Upgrade":
      return "Cloudflare Worker WebSocket Upgrade";
    case "inference 変換（service binding）":
      return "Cloudflare Worker 推論変換";
    case "compare Upgrade CPU（ログ cpuTime 中央値）":
      return "Cloudflare Worker Upgrade CPU（ログ cpuTime 中央値）";
    case "compare CPU（ログ校正）":
      return "Cloudflare Worker CPU（ログ校正）";
    case "inference CPU（ログ cpuTime）":
      return "Cloudflare Worker 推論 CPU（ログ cpuTime）";
    case "inference CPU（ログ校正）":
      return "Cloudflare Worker 推論 CPU（ログ校正）";
    default:
      return label;
  }
};

const utteranceCostTotalUsd = (
  conversion: CloudflareConversionCostEstimate,
  asrCostUsd?: number,
): number => {
  const asr = asrCostUsd !== undefined && Number.isFinite(asrCostUsd) ? asrCostUsd : 0;
  return conversion.usd + asr;
};

const utteranceAsrCostFields = (
  provider: RecognitionProvider | undefined,
  audioSeconds?: number,
): Pick<ComparisonRow, "asrCostUsd" | "asrCostSummaryJa"> => {
  if (provider === "workers-ai-asr") {
    const estimate = estimateWorkersAiAsrCost(audioSeconds ?? 0);
    return {
      asrCostUsd: estimate.usd,
      asrCostSummaryJa: workersAiAsrCostSummaryJa(estimate),
    };
  }
  return {
    asrCostUsd: 0,
    asrCostSummaryJa: webSpeechAsrCostSummaryJa(),
  };
};

const formatQuantityForCost = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

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
      return "Cloudflare Worker 通信中";
    case "done":
      return "完了";
    default:
      return "失敗";
  }
};

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
  const [speechState, setSpeechState] = useState<SpeechRecognitionState | WorkersAiAsrState>("idle");
  const [workerState, setWorkerState] = useState<WorkerConnectionState>("idle");
  const [browserWasmState, setBrowserWasmState] = useState<BrowserWasmState>("idle");
  const [speechFinalText, setSpeechFinalText] = useState("");
  const [speechInterimText, setSpeechInterimText] = useState("");
  const [latestSpeechSegment, setLatestSpeechSegment] = useState("");
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
  const [architectureOpen, setArchitectureOpen] = useState(false);

  const speechRef = useRef<WebSpeechController | null>(null);
  const asrRef = useRef<WorkersAiAsrController | null>(null);
  const initialSpeechLanguageRef = useRef(config.language);
  const speechTranscriptRef = useRef({ finalText: "", interimText: "" });
  const dispatchedSpeechRef = useRef<string[]>([]);
  const workerRef = useRef<AzooKeyWorkerClient | null>(null);
  const workerVibratoConfiguredRef = useRef<boolean | undefined>(undefined);
  const workerGenerationRef = useRef(0);
  const rowsRef = useRef<ComparisonRow[]>([]);
  const finalTextHandlerRef = useRef<(text: string, audioSeconds?: number) => void>(() => undefined);
  /** Serialize browser pre-pass + Worker work so rapid finals retain order. */
  const dispatchQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    setArchitectureOpen(isArchitectureDialogForced(window.location.search));
  }, []);

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
    const dispatchSpeechText = (text: string, audioSeconds?: number): void => {
      const nextDispatched = rememberDispatchedSpeech(dispatchedSpeechRef.current, text);
      if (nextDispatched.length === dispatchedSpeechRef.current.length) {
        return;
      }
      dispatchedSpeechRef.current = nextDispatched;
      setLatestSpeechSegment(text.trim());
      finalTextHandlerRef.current(text, audioSeconds);
    };

    speechRef.current?.dispose();
    asrRef.current?.dispose();
    speechRef.current = null;
    asrRef.current = null;

    if (config.recognitionProvider === "workers-ai-asr") {
      const asrEndpoint =
        typeof window !== "undefined" ? buildWorkersAiAsrUrl(window.location.origin) : undefined;
      const controller = new WorkersAiAsrController(initialSpeechLanguageRef.current, {
        language: config.language,
        endpointUrl: asrEndpoint,
        auth: config.auth,
        onStateChange: (state) => {
          setSpeechState(state);
          if (state === "listening") {
            setError("");
          }
        },
        onTranscript: ({ interimText }) => {
          setSpeechInterimText(interimText);
        },
        onFinalText: (text) => {
          setSpeechFinalText((current) => (current ? `${current} ${text}` : text));
        },
        onUtteranceFinal: ({ text, audioSeconds }) => {
          dispatchSpeechText(text, audioSeconds);
        },
        onError: (message) => {
          setError(message);
        },
      });
      asrRef.current = controller;
      setSpeechSupported(controller.supported);
      return () => {
        controller.dispose();
        if (asrRef.current === controller) {
          asrRef.current = null;
        }
      };
    }

    const controller = new WebSpeechController(initialSpeechLanguageRef.current, {
      onStateChange: (state) => {
        setSpeechState(state);
        if (state === "listening") {
          setError("");
        }
      },
      onTranscript: ({ finalText, interimText }: SpeechTranscriptUpdate) => {
        speechTranscriptRef.current = { finalText, interimText };
        setSpeechFinalText(finalText);
        setSpeechInterimText(interimText);
      },
      onFinalText: (text) => {
        dispatchSpeechText(text);
      },
      onUtteranceFinal: ({ text }: SpeechUtteranceFinal) => {
        dispatchSpeechText(text);
      },
      onRecognitionEnded: ({ finalText, interimText }: SpeechRecognitionEnded) => {
        speechTranscriptRef.current = { finalText, interimText };
        setSpeechFinalText(finalText);
        setSpeechInterimText(interimText);
        const pending = pendingSpeechUtterance(finalText, interimText, dispatchedSpeechRef.current);
        if (pending) {
          dispatchSpeechText(pending);
        }
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
  }, [config.recognitionProvider, config.auth, config.language]);

  // Keep one browser recognition session alive while settings are edited. A
  // dependency on `config.language` here would dispose the active controller,
  // leave the button showing "stop", and route future finals to an idle
  // replacement. The Web Speech implementation picks up the new language on
  // the next browser restart without losing the current state machine.
  useEffect(() => {
    syncSpeechLanguage(speechRef.current, config.language);
    asrRef.current?.setLanguage(config.language);
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
        recognitionProvider?: RecognitionProvider;
        audioSeconds?: number;
        /**
         * When set, skip browser Vibrato and feed this string as `vibratoInput`.
         * Manual / fixture checks already supply a phonetic reading.
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
      const asrCost = utteranceAsrCostFields(
        options.recognitionProvider ?? config.recognitionProvider,
        options.audioSeconds,
      );
      const initialRow: ComparisonRow = {
        id,
        sourceText: normalizedSource,
        state: "queued",
        mode,
        origin,
        ...asrCost,
        ...(options.expectedText !== undefined ? { expectedText: options.expectedText } : {}),
        ...(options.fixtureId !== undefined ? { fixtureId: options.fixtureId } : {}),
        ...(options.recognitionProvider !== undefined
          ? { recognitionProvider: options.recognitionProvider }
          : {}),
        ...(options.audioSeconds !== undefined ? { audioSeconds: options.audioSeconds } : {}),
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
      let openedNewWebSocket = false;
      let cloudflareConnectAttempted = false;
      // Tracks the stage in flight so a failure is attributed to the stage that
      // actually failed, rather than to whichever stage happened to run last.
      const stageRef: { current: ConversionStage } = { current: "setup" };
      try {
        const model = isConverterModel(converterModel) ? converterModel : DEFAULT_CONVERTER_MODEL;
        const result = await runComparisonConversion(
          {
            sourceText: normalizedSource,
            mode,
            converterModel: model,
            language,
            auth,
            phoneticInput: forcedPhonetic,
            wasmModuleUrl,
            dictionaryUrl,
            wasmGlobalName,
          },
          {
            onStage: (nextStage) => {
              stageRef.current = nextStage;
              if (nextStage === "browser-wasm") {
                setBrowserWasmState("loading");
                patchRow({ state: "wasm" });
              }
              if (nextStage === "browser-azookey" || nextStage === "worker-connect") {
                patchRow({
                  state: "sending",
                  vibratoInput,
                  ...(wasmElapsedMs !== undefined ? { wasmElapsedMs } : {}),
                });
              }
            },
            runBrowserVibrato: async (text, options) => {
              try {
                const wasmResult = await runBrowserVibrato(text, options);
                vibratoInput = wasmResult.text;
                wasmElapsedMs = wasmResult.elapsedMs;
                setBrowserWasmState((current) =>
                  browserWasmStateAfterStage(current, "browser-wasm", true),
                );
                return wasmResult;
              } catch (caught) {
                if (mode === "browser-vibrato") {
                  setBrowserWasmState((current) =>
                    browserWasmStateAfterStage(current, "browser-wasm", false),
                  );
                }
                throw caught;
              }
            },
            runBrowserAzookey: (text) => runBrowserAzookey(text),
            runBrowserZenzaiDict: (text, model) => runBrowserZenzaiDict(text, { model }),
            connectWorker: async () => {
              const client = workerRef.current;
              if (!client) {
                throw new Error("Cloudflare Worker WebSocket クライアントを初期化できません");
              }
              cloudflareConnectAttempted = true;
              const workerGeneration = workerGenerationRef.current;
              if (
                workerRef.current !== client ||
                workerGenerationRef.current !== workerGeneration
              ) {
                throw new Error("Cloudflare Worker 設定が変更されました。発話を再送してください");
              }
              const wsAlreadyOpen = client.connectionState === "open";
              await client.connect();
              if (!wsAlreadyOpen) {
                openedNewWebSocket = true;
              }
              if (
                workerRef.current !== client ||
                workerGenerationRef.current !== workerGeneration
              ) {
                throw new Error("Cloudflare Worker 設定が変更されました。発話を再送してください");
              }
            },
            convertWithWorker: (request) => {
              const client = workerRef.current;
              if (!client) {
                throw new Error("Cloudflare Worker WebSocket クライアントを初期化できません");
              }
              return client.convert({
                ...request,
                auth: authForRequest(auth),
              });
            },
          },
        );
        vibratoInput = result.vibratoInput;
        patchRow({
          state: "done",
          convertedText: result.convertedText,
          vibratoInput: result.vibratoInput,
          trace: result.trace,
          usedWebSocket: result.usedWebSocket,
          openedNewWebSocket,
          ...(result.requestedModel !== undefined ? { requestedModel: result.requestedModel } : {}),
          ...(result.model !== undefined ? { resolvedModel: result.model } : {}),
          ...(result.modelFallback !== undefined ? { modelFallback: result.modelFallback } : {}),
          ...(result.wasmElapsedMs !== undefined ? { wasmElapsedMs: result.wasmElapsedMs } : {}),
          ...(result.workerElapsedMs !== undefined || result.azookeyElapsedMs !== undefined
            ? { workerElapsedMs: result.workerElapsedMs ?? result.azookeyElapsedMs }
            : {}),
          totalElapsedMs: result.totalElapsedMs,
        });
        if (result.zenzaiExecution) {
          setNotice(BROWSER_ZENZAI_DICT_NOTICE);
        } else if (result.modelFallback && result.requestedModel) {
          setNotice(
            result.modelFallback === "upstream-failed"
              ? `${result.requestedModel} の上流に接続できなかったため AzooKey WASM で変換しました`
              : `${result.requestedModel} は Cloudflare Worker（推論）に未設定のため AzooKey WASM で変換しました`,
          );
        }
      } catch (caught) {
        // The browser WASM status is owned by the browser stage above; a Worker
        // or setup failure must not report a pre-pass that succeeded as failed.
        const message = errorMessage(caught);
        // A protocol refusal, transport failure, and converter failure are
        // different outcomes; only the Worker can prove which one occurred.
        const failedStage =
          stageRef.current === "worker" ? workerErrorStage(caught) : stageRef.current;
        patchRow({
          state: "error",
          error: message,
          vibratoInput,
          failedStage,
          ...(mode === "worker-vibrato" && cloudflareConnectAttempted
            ? {
                usedWebSocket: true,
                openedNewWebSocket,
                failedBeforeInference: stageRef.current !== "worker",
              }
            : mode === "browser-vibrato"
              ? { usedWebSocket: false }
              : {}),
        });
        setError(message);
      }
    },
    [appendRow, config.recognitionProvider],
  );

  // Keep the controller callback stable while routing each final utterance to
  // the latest selected mode and WASM settings.
  finalTextHandlerRef.current = (text, audioSeconds) => {
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
        {
          origin:
            config.recognitionProvider === "workers-ai-asr" ? "workers-ai-asr" : "web-speech",
          recognitionProvider: config.recognitionProvider,
          ...(audioSeconds !== undefined ? { audioSeconds } : {}),
        },
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
          {
            ...options,
            recognitionProvider: options.recognitionProvider ?? config.recognitionProvider,
          },
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
      config.recognitionProvider,
      dispatchFinalText,
    ],
  );

  const submitManualReading = (): void => {
    const reading = manualReading.trim();
    if (!reading) {
      setError("かな読みを入力してください");
      return;
    }
    setNotice(
      config.mode === "browser-vibrato"
        ? "かな読みをブラウザ AzooKey で変換しています"
        : "かな読みを Cloudflare Worker（推論）AzooKey へ送信しています",
    );
    enqueueConversion(reading, {
      origin: "manual",
      phoneticInput: reading,
    });
  };

  const runConversionFixture = (fixture: AzookeyConversionFixture): void => {
    setNotice(
      config.mode === "browser-vibrato"
        ? `フィクスチャ「${fixture.label}」をブラウザ AzooKey で変換しています`
        : `フィクスチャ「${fixture.label}」を Cloudflare Worker へ送信しています`,
    );
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

  const browserZenzaiDictNotice = useMemo(
    () =>
      usesBrowserZenzaiDictPath(config.mode, config.converterModel)
        ? BROWSER_ZENZAI_DICT_NOTICE
        : "",
    [config.converterModel, config.mode],
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
        if (config.mode === "browser-vibrato") {
          if (isZenzConverterModel(config.converterModel)) {
            await warmupBrowserZenzaiDict({ model: config.converterModel });
          } else {
            await warmupBrowserAzookey();
          }
        }
        setBrowserWasmState("ready");
      } catch (caught) {
        setBrowserWasmState("error");
        throw caught;
      }
    },
    [config],
  );

  const toggleListening = (): void => {
    const usingWorkersAi = config.recognitionProvider === "workers-ai-asr";
    const controller = usingWorkersAi ? asrRef.current : speechRef.current;
    if (!controller || !speechSupported) {
      setError(
        usingWorkersAi
          ? "このブラウザは Workers AI ASR 録音に対応していません"
          : "このブラウザは Web Speech API に対応していません",
      );
      return;
    }
    if (speechState === "listening" || speechState === "starting") {
      controller.stop();
      return;
    }
    dispatchedSpeechRef.current = [];
    setLatestSpeechSegment("");
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
        void controller.start();
      });
  };

  const connectWorker = async (): Promise<void> => {
    const client = workerRef.current;
    if (!client) {
      setError("Cloudflare Worker WebSocket クライアントを初期化できません");
      return;
    }
    try {
      if (config.auth.scheme === "bearer" && !config.auth.token?.trim()) {
        throw new Error("Bearer token を入力してください");
      }
      buildVibratoWebSocketUrl(config);
      await client.connect();
      let notice = "Cloudflare Worker WebSocket に接続しました";
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
            "Cloudflare Worker（推論）は内蔵語彙のみです。AZOOKEY_DICTIONARY_URL を設定しないと Tauri より精度が落ちます";
        } else if (health?.dictionary?.transport === "portable-wasm") {
          notice = "Cloudflare Worker WebSocket に接続しました（公式 AzooKey 辞書）";
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
        key === "converterModel" ||
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
      .then(async () => {
        if (next.mode === "browser-vibrato") {
          if (isZenzConverterModel(next.converterModel)) {
            await warmupBrowserZenzaiDict({ model: next.converterModel });
          } else {
            await warmupBrowserAzookey();
          }
        }
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
    setLatestSpeechSegment("");
    speechTranscriptRef.current = { finalText: "", interimText: "" };
    dispatchedSpeechRef.current = [];
    setNotice("履歴をクリアしました");
  };

  const configPanelHeading = (
    <div className="panel-heading">
      <div>
        <p className="eyebrow">CONFIGURATION</p>
        <h3>接続と方式</h3>
      </div>
      <span className={`state-pill state-${workerState}`}>{workerStateLabel(workerState)}</span>
    </div>
  );

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
          <h2 id="intro-title">ブラウザ認識と Cloudflare Worker 変換を同じ発話で見比べる</h2>
          <p className="intro-copy">
            Web Speech API の結果はすぐに表示し、AzooKey の Cloudflare Worker
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

      <section className="panel speech-panel speech-panel-hero" data-testid="speech-lane">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">WEB SPEECH API</p>
            <h3>認識レーン</h3>
          </div>
          <span className={`state-pill state-${speechState}`}>{speechStateLabel(speechState)}</span>
        </div>
        <p className="support-line">
          {speechSupported ? "このブラウザで利用できます" : "このブラウザでは利用できません"}
        </p>
        <button
          className={`button button-primary ${speechState === "listening" ? "is-listening" : ""}`}
          type="button"
          onClick={toggleListening}
          disabled={!speechSupported}
        >
          <span className="record-dot" aria-hidden="true" />
          {speechState === "listening" || speechState === "starting" ? "認識を停止" : "認識を開始"}
        </button>
        <p className="field-help">
          マイク権限を許可すると、確定した発話ごとに変換します。認識終了（final /
          onend）でも行を残します。
        </p>
      </section>

      <details
        className="architecture-disclosure"
        open={architectureOpen || undefined}
        data-testid="architecture-disclosure"
      >
        <summary>本番構成図（Cloudflare Workers）</summary>
        <ComparisonPathDiagram kind="overview" />
        <ComparisonPathDiagram
          kind="mode"
          mode={config.mode}
          browserWasmConfigured={browserWasmConfigured}
          converterModel={config.converterModel}
          recognitionProvider={config.recognitionProvider}
        />
        <ArchitectureAssetTable />
      </details>

      <div className="workspace-grid">
        <aside className="control-stack" aria-label="比較設定">
          <details className="config-panel-disclosure" data-testid="config-panel-disclosure">
            <summary className="config-panel-toggle" data-testid="config-panel-toggle">
              {configPanelHeading}
            </summary>
            <section className="panel config-panel" data-testid="config-panel">
              <div className="config-panel-heading-desktop" aria-hidden="true">
                {configPanelHeading}
              </div>

            <RecognitionModeSelector
              provider={config.recognitionProvider}
              onProviderChange={(recognitionProvider) => {
                updateConfig("recognitionProvider", recognitionProvider);
              }}
              label="音声認識"
            />

            <VibratoModeSelector
              mode={config.mode}
              onModeChange={(mode) => {
                updateConfig("mode", mode);
              }}
              label="変換（前処理の実行場所）"
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
              {browserZenzaiDictNotice ? (
                <>
                  {" "}
                  <span data-testid="browser-zenzai-dict-notice">{browserZenzaiDictNotice}</span>
                </>
              ) : null}
            </p>

            <label className="field-label" htmlFor="worker-url">
              Cloudflare Worker WebSocket URL
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
                  が未設定のためプリパスを実行できず失敗します（Cloudflare Worker 側 Vibrato
                  へはサイレントフォールバックしません）。空の global 名で実行した場合のみ、
                  実行時フォールバックとして既定名 `__AZOOKEY_VIBRATO_WASM__` を試します。
                  ブラウザ完結のかな→漢字は 同じページの AzooKey WASM で実行し、`/ws/azookey`
                  は呼びません。
                </p>
                <div className={`mini-status wasm-${browserWasmState}`}>
                  <span className="status-dot" aria-hidden="true" />
                  ブラウザ WASM: {browserWasmState === "idle" ? "未実行" : browserWasmState}
                </div>
              </div>
            ) : null}

            <div className="subsection auth-settings">
              <p className="subsection-title">認証（Cloudflare Worker の契約に合わせる）</p>
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
              Cloudflare Worker に接続
            </button>
            </section>
          </details>

          <section className="panel reading-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">PHONETIC INPUT</p>
                <h3>読み入力</h3>
              </div>
            </div>
            <p className="field-help">
              かな読みを AzooKey へ直接送り、変換結果を確認します。ブラウザ完結では in-page、Cloudflare Worker
              依存では推論 Cloudflare Worker で変換します。
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
              <p className="live-text">
                {visibleWebSpeechCaption(speechFinalText, latestSpeechSegment) ||
                  speechInterimText ||
                  "発話するとここに表示されます"}
              </p>
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
                  <p className="eyebrow">CLOUDFLARE WORKER</p>
                  <h3>Cloudflare Worker AzooKey 変換結果</h3>
                </div>
                <span className="lane-index">02</span>
              </div>
              <p
                className={`live-text ${latestWorker?.state === "error" ? "live-text-error" : ""}`}
              >
                {latestWorker?.convertedText ??
                  (latestWorker
                    ? rowStateLabel(latestWorker.state)
                    : "Cloudflare Worker の応答を待っています")}
              </p>
              <p className="interim-text">
                {latestWorker?.error ??
                  (latestWorker
                    ? rowPathLabel(latestWorker.mode, latestWorker.state, latestWorker.failedStage)
                    : "")}
              </p>
              <div className="live-card-footer">
                <span>処理時間</span>
                <strong>
                  合計処理時間 {formatMilliseconds(latestWorker?.totalElapsedMs)} / Cloudflare Worker{" "}
                  {formatMilliseconds(latestWorker?.workerElapsedMs)}
                </strong>
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
                  Web Speech、手動読み、または変換フィクスチャから Cloudflare Worker 変換を実行できます。
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
                              : row.origin === "workers-ai-asr"
                                ? "Workers AI ASR"
                                : "Web Speech"}
                        </span>
                        {row.trace ? (
                          <dl className="row-trace" data-testid="utterance-trace">
                            {conversionTraceDisplayLines(row.trace).map((line) => (
                              <div className="row-trace-step" key={`${row.id}-${line.key}`}>
                                <dt>{line.label}</dt>
                                <dd>
                                  <span className="row-trace-value">{line.value}</span>
                                  {line.detail ? (
                                    <span className="row-meta row-trace-detail">{line.detail}</span>
                                  ) : null}
                                  {line.timing ? (
                                    <span className="row-meta row-trace-timing">{line.timing}</span>
                                  ) : null}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <>
                            <p>{row.sourceText}</p>
                            {row.vibratoInput && row.vibratoInput !== row.sourceText ? (
                              <span className="row-meta">vibratoInput: {row.vibratoInput}</span>
                            ) : null}
                          </>
                        )}
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
                          {rowPathLabel(row.mode, row.state, row.failedStage)} ·{" "}
                          {formatRowTiming(row)}
                        </span>
                        {(() => {
                          const cost = estimateCloudflareConversionCost({
                            usedWebSocket:
                              row.mode === "browser-vibrato"
                                ? false
                                : (row.usedWebSocket ?? row.mode === "worker-vibrato"),
                            openedNewWebSocket: row.openedNewWebSocket ?? false,
                            workerElapsedMs: row.workerElapsedMs,
                            failedBeforeInference: row.failedBeforeInference,
                            usesExternalGgufUpstream: usesExternalGgufUpstream({
                              requestedModel: row.requestedModel ?? row.trace?.workerRequest?.model,
                              resolvedModel: row.resolvedModel,
                              modelFallback: row.modelFallback,
                            }),
                          });
                          const asrCostUsd = row.asrCostUsd;
                          const hasAsrCost =
                            asrCostUsd !== undefined &&
                            Number.isFinite(asrCostUsd) &&
                            asrCostUsd > 0;
                          const totalUsd = utteranceCostTotalUsd(cost, asrCostUsd);
                          return (
                            <div className="utterance-cost-card" data-testid="utterance-cost-card">
                              <h4 className="utterance-cost-heading">料金（推定）</h4>
                              <p className="utterance-cost-total" data-testid="utterance-cost-total">
                                {formatCloudflareCostUsd(totalUsd)}
                              </p>
                              <dl className="utterance-cost-breakdown">
                                <div
                                  className="utterance-cost-row"
                                  data-testid="utterance-conversion-cost"
                                >
                                  <dt>Cloudflare Worker（変換）</dt>
                                  <dd>
                                    <span className="utterance-cost-row-amount">
                                      {cost.browserComplete
                                        ? CF_CONVERSION_COST_BROWSER_COMPLETE_LABEL
                                        : formatCloudflareCostUsd(cost.usd)}
                                    </span>
                                    {!cost.browserComplete ? (
                                      <span className="utterance-cost-row-detail">
                                        リクエスト {cost.requests} · billed CPU {cost.billedCpuMs}{" "}
                                        ms
                                      </span>
                                    ) : null}
                                    {cost.breakdown.length > 0 ? (
                                      <ul className="utterance-cost-line-items">
                                        {cost.breakdown.map((line) => (
                                          <li key={`${row.id}-${line.label}`}>
                                            {conversionCostBreakdownLabelJa(line.label)} ·{" "}
                                            {formatQuantityForCost(line.quantity)} {line.unitLabel}{" "}
                                            · {formatCloudflareCostUsd(line.usd)}
                                          </li>
                                        ))}
                                      </ul>
                                    ) : null}
                                  </dd>
                                </div>
                                <div
                                  className="utterance-cost-row"
                                  data-testid="utterance-asr-cost"
                                  hidden={!hasAsrCost && !row.asrCostSummaryJa}
                                >
                                  <dt>Workers AI（ASR）</dt>
                                  <dd>
                                    {hasAsrCost ? (
                                      <span className="utterance-cost-row-amount">
                                        {formatCloudflareCostUsd(asrCostUsd)}
                                      </span>
                                    ) : null}
                                    {row.asrCostSummaryJa ? (
                                      <span className="utterance-cost-row-detail">
                                        {row.asrCostSummaryJa}
                                      </span>
                                    ) : hasAsrCost ? null : (
                                      <span className="utterance-cost-row-detail utterance-cost-row-empty">
                                        未計測
                                      </span>
                                    )}
                                  </dd>
                                </div>
                              </dl>
                            </div>
                          );
                        })()}
                        {row.trace?.workerRequest ? (
                          <span className="row-meta row-trace-worker-payload">
                            Cloudflare Worker 送信: sourceText={row.trace.workerRequest.sourceText} ·
                            vibratoInput={row.trace.workerRequest.vibratoInput} ·
                            vibratoExecution={row.trace.workerRequest.vibratoExecution}
                            {row.trace.workerRequest.model
                              ? ` · model=${row.trace.workerRequest.model}`
                              : ""}
                          </span>
                        ) : row.trace && row.mode === "browser-vibrato" ? (
                          <span className="row-meta row-trace-worker-payload">
                            ブラウザ完結（usedWebSocket: false） · AzooKey 入力=
                            {row.trace.azookeyInput}
                          </span>
                        ) : null}
                        {row.trace ? (
                          <span className="row-meta">
                            {row.trace.steps
                              .filter((step) => step.location !== "none")
                              .map((step) => traceStepLocationLabel(step.location))
                              .filter((label, idx, labels) => labels.indexOf(label) === idx)
                              .join(" → ")}
                          </span>
                        ) : null}
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
