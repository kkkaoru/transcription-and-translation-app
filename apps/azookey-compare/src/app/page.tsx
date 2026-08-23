"use client";

// This file runs with bun.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PipelineVisualization from "../components/PipelineVisualization";
import { COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH } from "../lib/inference-proxy";
import type { WorkersAiPipelineLog } from "../lib/workers-ai-asr-client";
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
  logs: WorkersAiPipelineLog[];
  completedAt: number;
}

interface UsageTotals {
  audioSeconds: number;
  workerRequests: number;
  workerCpuMs: number;
}

interface CostEstimate {
  audioSeconds: number;
  asrUsd: number;
  requestUsd: number;
  cpuUsd: number;
  totalUsd: number;
}

const NOVA_3_BATCH_USD_PER_AUDIO_MINUTE = 0.0052;
const WORKER_USD_PER_MILLION_REQUESTS = 0.3;
const WORKER_USD_PER_MILLION_CPU_MS = 0.02;
const ONE_MILLION = 1_000_000;
const LIVE_COST_REFRESH_MS = 250;
const EMPTY_USAGE: UsageTotals = { audioSeconds: 0, workerRequests: 0, workerCpuMs: 0 };

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(value);

const elapsedWorkerCpuMs = (logs: WorkersAiPipelineLog[]): number =>
  logs
    .filter((entry) => entry.stage !== "asr")
    .reduce((total, entry) => total + entry.elapsedMs, 0);

const estimateCost = (usage: UsageTotals, liveAudioSeconds: number): CostEstimate => {
  const audioSeconds = usage.audioSeconds + liveAudioSeconds;
  const asrUsd = (audioSeconds / 60) * NOVA_3_BATCH_USD_PER_AUDIO_MINUTE;
  const requestUsd = (usage.workerRequests / ONE_MILLION) * WORKER_USD_PER_MILLION_REQUESTS;
  const cpuUsd = (usage.workerCpuMs / ONE_MILLION) * WORKER_USD_PER_MILLION_CPU_MS;
  return { audioSeconds, asrUsd, requestUsd, cpuUsd, totalUsd: asrUsd + requestUsd + cpuUsd };
};

const stageLabel = (stage: WorkersAiPipelineLog["stage"]): string =>
  ({ asr: "ASR", vibrato: "Vibrato", azookey: "AzooKey" })[stage];

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
  const [interim, setInterim] = useState<string>("");
  const [result, setResult] = useState<PipelineResult>();
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);
  const [error, setError] = useState<string>("");
  const [clock, setClock] = useState<number>(Date.now());
  const controllerRef = useRef<WorkersAiAsrController | undefined>(undefined);
  const listeningStartedAtRef = useRef<number | undefined>(undefined);
  const supported = typeof window === "undefined" || isWorkersAiAsrCaptureSupported();

  const handleResult = useCallback((payload: WorkersAiAsrUtteranceFinal): void => {
    const logs = payload.logs ?? [];
    setResult({
      asrText: payload.text,
      vibratoText: payload.vibratoText ?? "",
      azookeyText: payload.convertedText ?? "",
      audioSeconds: payload.audioSeconds,
      pipeline: payload.pipeline ?? "workers-ai-vibrato-azookey-v2",
      logs,
      completedAt: Date.now(),
    });
    setUsage((current) => ({
      audioSeconds: current.audioSeconds + payload.audioSeconds,
      workerRequests: current.workerRequests + 1,
      workerCpuMs: current.workerCpuMs + elapsedWorkerCpuMs(logs),
    }));
  }, []);

  const createController = useCallback((): WorkersAiAsrController => {
    const existing = controllerRef.current;
    if (existing && !existing.isDisposed) {
      return existing;
    }
    const controller = new WorkersAiAsrController("ja", {
      language: "ja",
      endpointUrl: COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH,
      onStateChange: (nextState) => {
        setState(nextState);
        if (nextState === "listening") {
          listeningStartedAtRef.current = Date.now();
        }
        if (nextState === "idle" || nextState === "error") {
          listeningStartedAtRef.current = undefined;
        }
      },
      onTranscript: ({ interimText }) => setInterim(interimText),
      onUtteranceFinal: handleResult,
      onVadNotice: (message) => setInterim(message),
      onError: (message) => setError(message),
    });
    controllerRef.current = controller;
    return controller;
  }, [handleResult]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), LIVE_COST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = undefined;
    },
    [],
  );

  const toggleListening = useCallback(async (): Promise<void> => {
    setError("");
    const controller = createController();
    if (state === "listening" || state === "starting") {
      await controller.stop();
      return;
    }
    await controller.start();
  }, [createController, state]);

  const reset = useCallback((): void => {
    setResult(undefined);
    setUsage(EMPTY_USAGE);
    setError("");
  }, []);

  const liveAudioSeconds = useMemo((): number => {
    const startedAt = listeningStartedAtRef.current;
    return state === "listening" && startedAt ? Math.max(0, (clock - startedAt) / 1_000) : 0;
  }, [clock, state]);
  const cost = useMemo(() => estimateCost(usage, liveAudioSeconds), [usage, liveAudioSeconds]);
  const activeStage = state === "listening" ? "capture" : interim === "認識中…" ? "asr" : undefined;

  return (
    <main className="verification-shell">
      <header className="hero">
        <p className="eyebrow">KOTOBA BEACON / TECHNICAL VERIFICATION</p>
        <h1>Cloudflare 音声処理パイプライン</h1>
        <p>
          経路は1つだけです。Browser は音声だけを送り、単一の Cloudflare Worker が Nova-3、
          Vibrato、AzooKey を順番に実行して文字列を返します。
        </p>
      </header>

      <section className="visualization-panel" aria-labelledby="pipeline-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">D3.js visualization</p>
            <h2 id="pipeline-heading">固定された処理経路</h2>
          </div>
          <span className={`state-badge state-${state}`}>{stateLabel(state)}</span>
        </div>
        <PipelineVisualization activeStage={activeStage} />
      </section>

      <section className="control-grid">
        <article className="control-panel">
          <h2>音声入力</h2>
          <p>
            ブラウザ内の Silero VAD は送信単位の切り出しだけに使用します。文字処理は行いません。
          </p>
          <button
            type="button"
            className={state === "listening" ? "stop-button" : "start-button"}
            disabled={!supported || state === "stopping"}
            onClick={() => void toggleListening()}
          >
            {state === "listening" || state === "starting" ? "録音を停止" : "マイクを開始"}
          </button>
          {!supported ? (
            <p className="error-message">このブラウザでは音声取得を利用できません。</p>
          ) : null}
          {interim ? <p className="interim-message">{interim}</p> : null}
          {error ? <p className="error-message">{error}</p> : null}
        </article>

        <article className="cost-panel" aria-live="polite">
          <div className="cost-heading">
            <div>
              <p className="section-kicker">Live estimate</p>
              <h2>Cloudflare 推定費用</h2>
            </div>
            <strong>{formatUsd(cost.totalUsd)}</strong>
          </div>
          <dl className="cost-breakdown">
            <div>
              <dt>Nova-3 ({cost.audioSeconds.toFixed(1)} 秒)</dt>
              <dd>{formatUsd(cost.asrUsd)}</dd>
            </div>
            <div>
              <dt>Worker requests ({usage.workerRequests})</dt>
              <dd>{formatUsd(cost.requestUsd)}</dd>
            </div>
            <div>
              <dt>Worker CPU estimate ({usage.workerCpuMs.toFixed(1)} ms)</dt>
              <dd>{formatUsd(cost.cpuUsd)}</dd>
            </div>
          </dl>
          <p className="fine-print">
            Nova-3 HTTP $0.0052/音声分、Workers $0.30/百万request、$0.02/百万CPU-msで動的推定。
            無料枠・月額枠と実請求CPUは含みません。
          </p>
        </article>
      </section>

      <section className="result-card" aria-labelledby="result-heading">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Single result card</p>
            <h2 id="result-heading">Worker 処理結果とログ</h2>
          </div>
          <button type="button" className="secondary-button" onClick={reset}>
            結果をクリア
          </button>
        </div>
        {result ? (
          <div className="result-content">
            <div className="final-output">
              <span>最終 AzooKey 変換</span>
              <strong>{result.azookeyText || "（空の結果）"}</strong>
              <small>
                {result.pipeline} · 音声 {result.audioSeconds.toFixed(2)} 秒
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
              完了: {new Date(result.completedAt).toLocaleString("ja-JP")}
            </p>
          </div>
        ) : (
          <p className="empty-result">
            マイクを開始して発話すると、3段階のログがここに表示されます。
          </p>
        )}
      </section>
    </main>
  );
}
