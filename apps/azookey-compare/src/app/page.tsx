"use client";

// This file runs with bun.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CustomDictionaryPanel from "../components/CustomDictionaryPanel";
import PipelineVisualization from "../components/PipelineVisualization";
import { COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH } from "../lib/inference-proxy";
import type {
  BrowserAsrModel,
  BrowserConversionModel,
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
  vibratoText: string;
  azookeyText: string;
  audioSeconds: number;
  pipeline: string;
  asrModel: string;
  conversionModel: string;
  usedCompletion: boolean;
  logs: WorkersAiPipelineLog[];
  completedAt: number;
}

interface UsageTotals {
  audioSeconds: number;
  workerRequests: number;
  workerCpuMs: number;
  containerActiveMs: number;
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
const LIVE_COST_REFRESH_MS = 250;
const EMPTY_USAGE: UsageTotals = {
  audioSeconds: 0,
  workerRequests: 0,
  workerCpuMs: 0,
  containerActiveMs: 0,
};
const CONTAINER_VCPU = 2;
const CONTAINER_MEMORY_GIB = 8;
const CONTAINER_DISK_GB = 16;
const CONTAINER_VCPU_USD_PER_SECOND = 0.00002;
const CONTAINER_GIB_USD_PER_SECOND = 0.0000025;
const CONTAINER_GB_DISK_USD_PER_SECOND = 0.00000007;
const LANGUAGE_OPTIONS = ["ja", "en", "zh", "ko", "es", "fr", "de", "it", "pt"];

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(value);

const elapsedWorkerCpuMs = (logs: WorkersAiPipelineLog[]): number =>
  logs.filter((entry) => entry.stage !== "asr").reduce((sum, entry) => sum + entry.elapsedMs, 0);

const estimateCost = (
  usage: UsageTotals,
  liveAudioSeconds: number,
  asrModel: BrowserAsrModel,
): CostEstimate => {
  const audioSeconds = usage.audioSeconds + liveAudioSeconds;
  const asrUsd = (audioSeconds / 60) * ASR_PRICES[asrModel];
  const requestUsd = (usage.workerRequests / ONE_MILLION) * WORKER_USD_PER_MILLION_REQUESTS;
  const cpuUsd = (usage.workerCpuMs / ONE_MILLION) * WORKER_USD_PER_MILLION_CPU_MS;
  const containerSeconds = usage.containerActiveMs / 1_000;
  const containerUsd =
    containerSeconds *
    (CONTAINER_VCPU * CONTAINER_VCPU_USD_PER_SECOND +
      CONTAINER_MEMORY_GIB * CONTAINER_GIB_USD_PER_SECOND +
      CONTAINER_DISK_GB * CONTAINER_GB_DISK_USD_PER_SECOND);
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
  ({ asr: "ASR", vibrato: "Vibrato", azookey: "AzooKey + Zenz" })[stage];

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
  const [clock, setClock] = useState(Date.now());
  const [asrModel, setAsrModel] = useState<BrowserAsrModel>("@cf/deepgram/nova-3");
  const [conversionModel, setConversionModel] =
    useState<BrowserConversionModel>("zenz-v3.2-xsmall-gguf");
  const [language, setLanguage] = useState("ja");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const controllerRef = useRef<WorkersAiAsrController | undefined>(undefined);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
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

  const handleResult = useCallback((payload: WorkersAiAsrUtteranceFinal): void => {
    const logs = payload.logs ?? [];
    setResult({
      asrText: payload.text,
      vibratoText: payload.vibratoText ?? payload.text,
      azookeyText: payload.convertedText ?? payload.text,
      audioSeconds: payload.audioSeconds,
      pipeline: payload.pipeline ?? "workers-ai-language-gated-azookey-v3",
      asrModel: payload.model ?? "unknown",
      conversionModel: payload.conversionModel ?? "not-run",
      usedCompletion: payload.usedCompletion ?? false,
      logs,
      completedAt: Date.now(),
    });
    setUsage((current) => ({
      audioSeconds: current.audioSeconds + payload.audioSeconds,
      workerRequests: current.workerRequests + 1,
      workerCpuMs: current.workerCpuMs + elapsedWorkerCpuMs(logs),
      containerActiveMs:
        current.containerActiveMs +
        (logs.find((entry) => entry.stage === "azookey")?.elapsedMs ?? 0),
    }));
  }, []);

  const createController = useCallback((): WorkersAiAsrController => {
    controllerRef.current?.dispose();
    const controller = new WorkersAiAsrController(language, {
      language,
      model: asrModel,
      conversionModel,
      ...(deviceId ? { deviceId } : {}),
      endpointUrl: COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH,
      onStateChange: (nextState) => {
        setState(nextState);
        listeningStartedAtRef.current = nextState === "listening" ? Date.now() : undefined;
        if (nextState === "listening") void refreshMicrophones();
      },
      onTranscript: ({ interimText }) => setInterim(interimText),
      onUtteranceFinal: handleResult,
      onVadNotice: setInterim,
      onError: setError,
    });
    controllerRef.current = controller;
    return controller;
  }, [asrModel, conversionModel, deviceId, handleResult, language, refreshMicrophones]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), LIVE_COST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => controllerRef.current?.dispose(), []);

  const toggleListening = useCallback(async (): Promise<void> => {
    setError("");
    if (state === "listening" || state === "starting") {
      await controllerRef.current?.stop();
      return;
    }
    await createController().start();
  }, [createController, state]);

  const liveAudioSeconds = useMemo(() => {
    const startedAt = listeningStartedAtRef.current;
    return state === "listening" && startedAt ? Math.max(0, (clock - startedAt) / 1_000) : 0;
  }, [clock, state]);
  const cost = useMemo(
    () => estimateCost(usage, liveAudioSeconds, asrModel),
    [asrModel, liveAudioSeconds, usage],
  );
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
              <span>{language === "ja" ? "AzooKey 最終結果" : "ASR 結果（日本語後処理なし）"}</span>
              <strong>{result.azookeyText || "（空の結果）"}</strong>
              <small>
                {result.asrModel} · {result.conversionModel} · 音声 {result.audioSeconds.toFixed(2)}{" "}
                秒
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
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
            <label>
              AzooKey GGUF
              <select
                value={conversionModel}
                disabled={settingsDisabled || language !== "ja"}
                onChange={(event) =>
                  setConversionModel(
                    event.target.value === "zenz-v3.2-small-gguf"
                      ? "zenz-v3.2-small-gguf"
                      : "zenz-v3.2-xsmall-gguf",
                  )
                }
              >
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
            Nova-3 は realtime より安い HTTP batch ($0.0052/音声分) を維持し、Silero
            で無音を送らず、再分割や再認識も行いません。Whisper は $0.00051/音声分。Container は
            standard-3 の active 時間から上限寄りに推定しています。1分の idle 保持、無料枠、実請求
            CPU は含みません。
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
        />
      </details>

      <CustomDictionaryPanel />
    </main>
  );
}
