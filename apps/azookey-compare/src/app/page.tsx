"use client";

// This file runs with bun.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CustomDictionaryPanel from "../components/CustomDictionaryPanel";
import PipelineVisualization from "../components/PipelineVisualization";
import { COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH } from "../lib/inference-proxy";
import type {
  BrowserAsrModel,
  BrowserComputeTier,
  BrowserContainerProfile,
  BrowserConversionModel,
  BrowserN5Mode,
  WorkersAiPipelineLog,
} from "../lib/workers-ai-asr-client";
import {
  WorkersAiAsrController,
  type WorkersAiAsrState,
  type WorkersAiAsrUtteranceFinal,
} from "../lib/workers-ai-asr-controller";
import { isWorkersAiAsrCaptureSupported } from "../lib/workers-ai-asr-support";

interface PipelineResult {
  asrText: string;
  n5Text: string;
  vibratoText: string;
  azookeyText: string;
  audioSeconds: number;
  pipeline: string;
  asrModel: string;
  conversionModel: string;
  containerProfile?: BrowserContainerProfile;
  usedCompletion: boolean;
  logs: WorkersAiPipelineLog[];
  completedAt: number;
  speechStartedAtMs: number;
  speechEndedAtMs: number;
  speechToResultMs: number;
  endToResultMs: number;
}

interface UsageTotals {
  audioSeconds: number;
  workerRequests: number;
  workerCpuMs: number;
  containerActiveMs: number;
  containerUsd: number;
}

interface CostEstimate {
  audioSeconds: number;
  asrUsd: number;
  requestUsd: number;
  cpuUsd: number;
  containerUsd: number;
  totalUsd: number;
}

interface MicrophoneOption {
  deviceId: string;
  label: string;
}

const ASR_PRICES: Record<BrowserAsrModel, number> = {
  "@cf/deepgram/nova-3": 0.0052,
  "@cf/openai/whisper-large-v3-turbo": 0.00051,
};
const WORKER_USD_PER_MILLION_REQUESTS = 0.3;
const WORKER_USD_PER_MILLION_CPU_MS = 0.02;
const ONE_MILLION = 1_000_000;
const EMPTY_USAGE: UsageTotals = {
  audioSeconds: 0,
  workerRequests: 0,
  workerCpuMs: 0,
  containerActiveMs: 0,
  containerUsd: 0,
};
const CONTAINER_RESOURCES: Record<
  BrowserComputeTier,
  { vcpu: number; memoryGib: number; diskGb: number }
> = {
  basic: { vcpu: 0.25, memoryGib: 1, diskGb: 4 },
  standard: { vcpu: 2, memoryGib: 8, diskGb: 16 },
};
const CONTAINER_VCPU_USD_PER_SECOND = 0.00002;
const CONTAINER_GIB_USD_PER_SECOND = 0.0000025;
const CONTAINER_GB_DISK_USD_PER_SECOND = 0.00000007;
const LANGUAGE_OPTIONS = ["", "ja", "en", "zh", "ko", "es", "fr", "de", "it", "pt"];

const containerCostUsd = (tier: BrowserComputeTier, elapsedMs: number): number => {
  const resources = CONTAINER_RESOURCES[tier];
  const seconds = elapsedMs / 1_000;
  return (
    seconds *
    (resources.vcpu * CONTAINER_VCPU_USD_PER_SECOND +
      resources.memoryGib * CONTAINER_GIB_USD_PER_SECOND +
      resources.diskGb * CONTAINER_GB_DISK_USD_PER_SECOND)
  );
};

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(value);

const elapsedWorkerCpuMs = (logs: WorkersAiPipelineLog[]): number =>
  logs.filter((entry) => entry.stage !== "asr").reduce((sum, entry) => sum + entry.elapsedMs, 0);

const estimateCost = (usage: UsageTotals, asrModel: BrowserAsrModel): CostEstimate => {
  const audioSeconds = usage.audioSeconds;
  const asrUsd = (audioSeconds / 60) * ASR_PRICES[asrModel];
  const requestUsd = (usage.workerRequests / ONE_MILLION) * WORKER_USD_PER_MILLION_REQUESTS;
  const cpuUsd = (usage.workerCpuMs / ONE_MILLION) * WORKER_USD_PER_MILLION_CPU_MS;
  const containerUsd = usage.containerUsd;
  return {
    audioSeconds,
    asrUsd,
    requestUsd,
    cpuUsd,
    containerUsd,
    totalUsd: asrUsd + requestUsd + cpuUsd + containerUsd,
  };
};

const stageLabel = (stage: WorkersAiPipelineLog["stage"]): string =>
  ({ asr: "ASR", n5_lm: "Input N5 LM", vibrato: "Vibrato", azookey: "AzooKey + Zenz" })[stage];

const stateLabel = (state: WorkersAiAsrState): string =>
  ({
    idle: "停止中",
    starting: "マイク準備中",
    listening: "音声取得中",
    stopping: "残りの音声を処理中",
    error: "エラー",
  })[state];

export default function ComparePage(): React.JSX.Element {
  const [state, setState] = useState<WorkersAiAsrState>("idle");
  const [interim, setInterim] = useState("");
  const [result, setResult] = useState<PipelineResult>();
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);
  const [error, setError] = useState("");
  const [asrModel, setAsrModel] = useState<BrowserAsrModel>("@cf/deepgram/nova-3");
  const [conversionModel, setConversionModel] =
    useState<BrowserConversionModel>("zenz-v3.2-xsmall-gguf");
  const [computeTier, setComputeTier] = useState<BrowserComputeTier>("standard");
  const [containerModel, setContainerModel] = useState<"xsmall" | "small">("xsmall");
  const [n5Lm, setN5Lm] = useState<BrowserN5Mode>("off");
  const [language, setLanguage] = useState("ja");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const controllerRef = useRef<WorkersAiAsrController | undefined>(undefined);
  const supported = typeof window === "undefined" || isWorkersAiAsrCaptureSupported();

  const refreshMicrophones = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `マイク ${String(index + 1)}`,
      }));
    setMicrophones(inputs);
    setDeviceId((current) => current || inputs[0]?.deviceId || "");
  }, []);

  useEffect(() => {
    void refreshMicrophones().catch(() => undefined);
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
  }, [refreshMicrophones]);

  const handleResult = useCallback(
    (payload: WorkersAiAsrUtteranceFinal): void => {
      const logs = payload.logs ?? [];
      const containerActiveMs = logs
        .filter((entry) => entry.stage === "n5_lm" || entry.stage === "azookey")
        .reduce((total, entry) => total + entry.elapsedMs, 0);
      const billedTier = payload.containerProfile?.computeTier ?? computeTier;
      setResult({
        asrText: payload.text,
        n5Text: payload.n5Text ?? payload.text,
        vibratoText: payload.vibratoText ?? payload.text,
        azookeyText: payload.convertedText ?? payload.text,
        audioSeconds: payload.audioSeconds,
        pipeline: payload.pipeline ?? "workers-ai-profiled-azookey-v4",
        asrModel: payload.model ?? "unknown",
        conversionModel: payload.conversionModel ?? "not-run",
        ...(payload.containerProfile ? { containerProfile: payload.containerProfile } : {}),
        usedCompletion: payload.usedCompletion ?? false,
        logs,
        completedAt: payload.resultReturnedAtMs,
        speechStartedAtMs: payload.speechStartedAtMs,
        speechEndedAtMs: payload.speechEndedAtMs,
        speechToResultMs: payload.speechToResultMs,
        endToResultMs: payload.endToResultMs,
      });
      setUsage((current) => ({
        audioSeconds: current.audioSeconds + payload.audioSeconds,
        workerRequests: current.workerRequests + 1,
        workerCpuMs: current.workerCpuMs + elapsedWorkerCpuMs(logs),
        containerActiveMs: current.containerActiveMs + containerActiveMs,
        containerUsd: current.containerUsd + containerCostUsd(billedTier, containerActiveMs),
      }));
    },
    [computeTier],
  );

  const createController = useCallback((): WorkersAiAsrController => {
    controllerRef.current?.dispose();
    const controller = new WorkersAiAsrController(language, {
      language,
      model: asrModel,
      conversionModel,
      computeTier,
      containerModel,
      n5Lm,
      ...(deviceId ? { deviceId } : {}),
      endpointUrl: COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH,
      onStateChange: (nextState) => {
        setState(nextState);
        if (nextState === "listening") void refreshMicrophones();
      },
      onTranscript: ({ interimText }) => setInterim(interimText),
      onUtteranceFinal: handleResult,
      onVadNotice: setInterim,
      onError: setError,
    });
    controllerRef.current = controller;
    return controller;
  }, [
    asrModel,
    computeTier,
    containerModel,
    conversionModel,
    deviceId,
    handleResult,
    language,
    n5Lm,
    refreshMicrophones,
  ]);
  useEffect(() => () => controllerRef.current?.dispose(), []);

  const toggleListening = useCallback(async (): Promise<void> => {
    setError("");
    if (state === "listening" || state === "starting") {
      await controllerRef.current?.stop();
      return;
    }
    await createController().start();
  }, [createController, state]);

  const cost = useMemo(() => estimateCost(usage, asrModel), [asrModel, usage]);
  const activeStage = state === "listening" ? "capture" : interim === "認識中…" ? "asr" : undefined;
  const settingsDisabled = state !== "idle" && state !== "error";

  return (
    <main className="verification-shell">
      <header className="hero">
        <p className="eyebrow">KOTOBA BEACON / TECHNICAL VERIFICATION</p>
        <h1>Cloudflare 音声処理パイプライン</h1>
        <p>
          Browser は Silero VAD で発話だけを切り出し、Cloudflare の batch ASR と Worker-owned
          辞書へ送ります。
        </p>
      </header>

      <section className="result-card result-card-top" aria-labelledby="result-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Recognition result</p>
            <h2 id="result-heading">認識結果</h2>
          </div>
          <button type="button" className="secondary-button" onClick={() => setResult(undefined)}>
            クリア
          </button>
        </div>
        {result ? (
          <div className="result-content">
            <div className="final-output">
              <span>
                {language === "ja" && conversionModel !== "none"
                  ? "AzooKey 最終結果"
                  : "ASR / N5 結果（AzooKey なし）"}
              </span>
              <strong>{result.azookeyText || "（空の結果）"}</strong>
              <small>
                {result.asrModel} · {result.conversionModel} · 課金対象音声{" "}
                {result.audioSeconds.toFixed(2)} 秒
              </small>
              <small>
                発話開始 {new Date(result.speechStartedAtMs).toLocaleTimeString("ja-JP")} · 発話終了{" "}
                {new Date(result.speechEndedAtMs).toLocaleTimeString("ja-JP")} · 終了→結果{" "}
                {result.endToResultMs.toFixed(1)} ms · 開始→結果{" "}
                {result.speechToResultMs.toFixed(1)} ms
              </small>
            </div>
            <div className="stage-logs">
              {result.logs.map((log) => (
                <details key={log.stage} open>
                  <summary>
                    <span>
                      {stageLabel(log.stage)} / {log.engine}
                    </span>
                    <time>{log.elapsedMs.toFixed(1)} ms</time>
                  </summary>
                  <dl>
                    <div>
                      <dt>input</dt>
                      <dd>{log.input}</dd>
                    </div>
                    <div>
                      <dt>output</dt>
                      <dd>{log.output || "（空）"}</dd>
                    </div>
                  </dl>
                </details>
              ))}
            </div>
            <p className="result-timestamp">
              {result.pipeline} · GGUF completion:{" "}
              {result.usedCompletion ? "used" : "not selected by lattice"} · 完了{" "}
              {new Date(result.completedAt).toLocaleString("ja-JP")}
            </p>
          </div>
        ) : (
          <p className="empty-result">
            マイクを開始すると最新の認識結果がページ上部に表示されます。
          </p>
        )}
      </section>

      <section className="control-grid">
        <article className="control-panel">
          <div className="section-heading">
            <h2>音声入力とモデル</h2>
            <span className={`state-badge state-${state}`}>{stateLabel(state)}</span>
          </div>
          <div className="settings-grid">
            <label>
              マイク
              <select
                value={deviceId}
                disabled={settingsDisabled}
                onChange={(event) => setDeviceId(event.target.value)}
              >
                <option value="">OS 既定</option>
                {microphones.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ASR
              <select
                value={asrModel}
                disabled={settingsDisabled}
                onChange={(event) =>
                  setAsrModel(
                    event.target.value === "@cf/openai/whisper-large-v3-turbo"
                      ? "@cf/openai/whisper-large-v3-turbo"
                      : "@cf/deepgram/nova-3",
                  )
                }
              >
                <option value="@cf/deepgram/nova-3">Nova-3 batch</option>
                <option value="@cf/openai/whisper-large-v3-turbo">Whisper Large V3 Turbo</option>
              </select>
            </label>
            <label>
              話者言語コード
              <select
                value={language}
                disabled={settingsDisabled}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {LANGUAGE_OPTIONS.map((code) => (
                  <option key={code || "auto"} value={code}>
                    {code || "指定なし（自動検出・日本語後処理なし）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Container compute
              <select
                value={computeTier}
                disabled={settingsDisabled}
                onChange={(event) =>
                  setComputeTier(event.target.value === "basic" ? "basic" : "standard")
                }
              >
                <option value="basic">basic（比較用・低速）</option>
                <option value="standard">standard（standard-3）</option>
              </select>
            </label>
            <label>
              Input N5 LM
              <select
                value={n5Lm}
                disabled={settingsDisabled}
                onChange={(event) => setN5Lm(event.target.value === "on" ? "on" : "off")}
              >
                <option value="off">off</option>
                <option value="on">on（処理時間を個別表示）</option>
              </select>
            </label>
            <label>
              AzooKey GGUF
              <select
                value={conversionModel}
                disabled={settingsDisabled}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "none") {
                    setConversionModel("none");
                  } else if (value === "zenz-v3.2-small-gguf") {
                    setConversionModel("zenz-v3.2-small-gguf");
                    setContainerModel("small");
                  } else {
                    setConversionModel("zenz-v3.2-xsmall-gguf");
                    setContainerModel("xsmall");
                  }
                }}
              >
                <option value="none">なし（jaでもAzooKeyを実行しない）</option>
                <option value="zenz-v3.2-xsmall-gguf">Zenz v3.2 XSmall GGUF</option>
                <option value="zenz-v3.2-small-gguf">Zenz v3.2 Small GGUF</option>
              </select>
            </label>
          </div>
          <button
            type="button"
            className={state === "listening" ? "stop-button" : "start-button"}
            disabled={!supported || state === "stopping"}
            onClick={() => void toggleListening()}
          >
            {state === "listening" || state === "starting" ? "録音を停止" : "マイクを開始"}
          </button>
          {interim ? <p className="interim-message">{interim}</p> : null}
          {error ? <p className="error-message">{error}</p> : null}
        </article>

        <article className="cost-panel" aria-live="polite">
          <div className="cost-heading">
            <div>
              <p className="section-kicker">Live estimate</p>
              <h2>料金と処理時間</h2>
            </div>
            <strong>{formatUsd(cost.totalUsd)}</strong>
          </div>
          <dl className="cost-breakdown">
            <div>
              <dt>
                {asrModel} ({cost.audioSeconds.toFixed(1)} 秒)
              </dt>
              <dd>{formatUsd(cost.asrUsd)}</dd>
            </div>
            <div>
              <dt>Worker requests ({usage.workerRequests})</dt>
              <dd>{formatUsd(cost.requestUsd)}</dd>
            </div>
            <div>
              <dt>Vibrato + AzooKey Worker CPU ({usage.workerCpuMs.toFixed(1)} ms)</dt>
              <dd>{formatUsd(cost.cpuUsd)}</dd>
            </div>
            <div>
              <dt>Zenz GGUF Container active ({usage.containerActiveMs.toFixed(1)} ms)</dt>
              <dd>{formatUsd(cost.containerUsd)}</dd>
            </div>
            {result?.logs.map((log) => (
              <div key={log.stage}>
                <dt>{stageLabel(log.stage)} latest latency</dt>
                <dd>{log.elapsedMs.toFixed(1)} ms</dd>
              </div>
            ))}
          </dl>
          <p className="fine-print">
            Nova-3 と Whisper は browser Silero が確定した発話だけを送信します。マイク開始中の無音は
            課金対象音声へ加算しません。Whisper は $0.00051/音声分、Nova-3 は $0.0052/音声分。
            Container は選択tierの処理時間から推定し、停止時に明示release、異常終了時も1分でdestroy
            します。cold start、無料枠、Cloudflareの実請求CPU差分は含みません。
          </p>
        </article>
      </section>

      <details className="visualization-panel">
        <summary>
          <span>
            <small>D3.js visualization</small>
            <strong>処理経路を展開</strong>
          </span>
        </summary>
        <p className="fine-print">
          Browser Service Worker は使用していません。Compare Worker が Access を検証し、service
          binding で Inference Worker を呼びます。
        </p>
        <PipelineVisualization
          activeStage={activeStage}
          asrModel={asrModel}
          conversionModel={conversionModel}
          computeTier={computeTier}
          n5Lm={n5Lm}
          language={language}
        />
      </details>

      <CustomDictionaryPanel />
    </main>
  );
}
