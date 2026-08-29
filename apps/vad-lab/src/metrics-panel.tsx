// Runs in the browser; built and tested with Bun.
import type { AudioRecord } from "./model";

interface MetricsPanelProps {
  record: AudioRecord;
}

const formatNumber = (value: number, digits = 2): string => value.toFixed(digits);
const formatBytes = (value: number | null): string =>
  value === null ? "取得不可" : `${new Intl.NumberFormat("ja-JP").format(value)} B`;
const formatConfidence = (value: number | null): string =>
  value === null ? "取得不可" : formatNumber(value, 4);

export function MetricsPanel({ record }: MetricsPanelProps) {
  return (
    <div className="record-metrics">
      <p className="metrics-target mono">対象音声ID: {record.id}</p>
      <div className="metrics-grid expanded">
        <section>
          <h3>VAD timing・frame負荷</h3>
          <dl>
            <div>
              <dt>区間判定時間</dt>
              <dd>{formatNumber(record.vadTiming.segmentationWallMs)} ms</dd>
            </div>
            <div>
              <dt>callback合計</dt>
              <dd>{formatNumber(record.vadTiming.callbackProcessingMs, 3)} ms</dd>
            </div>
            <div>
              <dt>callback平均</dt>
              <dd>{formatNumber(record.vadTiming.callbackAverageMs, 3)} ms</dd>
            </div>
            <div>
              <dt>callback最大</dt>
              <dd>{formatNumber(record.vadTiming.callbackMaximumMs, 3)} ms</dd>
            </div>
            <div>
              <dt>音声後処理時間</dt>
              <dd>{formatNumber(record.vadTiming.postProcessingMs, 3)} ms</dd>
            </div>
            <div>
              <dt>処理フレーム数</dt>
              <dd>{record.vadTiming.frameCount}</dd>
            </div>
            <div>
              <dt>フレーム音声時間</dt>
              <dd>{formatNumber(record.vadTiming.audioFrameMs)} ms</dd>
            </div>
            <div>
              <dt>frame間隔平均</dt>
              <dd>{formatNumber(record.vadTiming.frameIntervalAverageMs, 3)} ms</dd>
            </div>
            <div>
              <dt>frame間隔p50</dt>
              <dd>{formatNumber(record.vadTiming.frameIntervalP50Ms, 3)} ms</dd>
            </div>
            <div>
              <dt>frame間隔p95</dt>
              <dd>{formatNumber(record.vadTiming.frameIntervalP95Ms, 3)} ms</dd>
            </div>
            <div>
              <dt>frame間隔最大</dt>
              <dd>{formatNumber(record.vadTiming.frameIntervalMaximumMs, 3)} ms</dd>
            </div>
            <div>
              <dt>frame jitter</dt>
              <dd>{formatNumber(record.vadTiming.frameIntervalJitterMs, 3)} ms</dd>
            </div>
            <div>
              <dt>処理frame/秒</dt>
              <dd>{formatNumber(record.vadTiming.framesPerSecond, 2)}</dd>
            </div>
            <div>
              <dt>real-time factor</dt>
              <dd>{formatNumber(record.vadTiming.realTimeFactor, 4)}</dd>
            </div>
            <div>
              <dt>48 ms超frame数</dt>
              <dd>{record.vadTiming.delayedFrameCount}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>RAM観測値</h3>
          <dl>
            <div>
              <dt>計測API</dt>
              <dd>{record.vadMemory.method}</dd>
            </div>
            <div>
              <dt>計測範囲</dt>
              <dd>{record.vadMemory.scope === "page" ? "ページ全体" : record.vadMemory.scope}</dd>
            </div>
            <div>
              <dt>サンプル数</dt>
              <dd>{record.vadMemory.sampleCount}</dd>
            </div>
            <div>
              <dt>開始時</dt>
              <dd>{formatBytes(record.vadMemory.startBytes)}</dd>
            </div>
            <div>
              <dt>終了時</dt>
              <dd>{formatBytes(record.vadMemory.endBytes)}</dd>
            </div>
            <div>
              <dt>実測ピーク</dt>
              <dd>{formatBytes(record.vadMemory.peakBytes)}</dd>
            </div>
            <div>
              <dt>観測増減</dt>
              <dd>{formatBytes(record.vadMemory.deltaBytes)}</dd>
            </div>
            <div>
              <dt>Worker帰属RAM（推定）</dt>
              <dd>{formatBytes(record.vadMemory.workerAttributedBytes)}</dd>
            </div>
            <div>
              <dt>WASM帰属RAM（推定）</dt>
              <dd>{formatBytes(record.vadMemory.wasmAttributedBytes)}</dd>
            </div>
            <div>
              <dt>WorkerかつWASM帰属RAM（推定）</dt>
              <dd>{formatBytes(record.vadMemory.workerWasmAttributedBytes)}</dd>
            </div>
            <div>
              <dt>Silero WASM専有量</dt>
              <dd>
                {record.engineInitialization.exactSileroWasmMemoryAvailable
                  ? "取得済み"
                  : "正確な専有量はブラウザAPI非公開。上記はbreakdownの帰属推定値"}
              </dd>
            </div>
          </dl>
          <details>
            <summary>開始・終了memory breakdown</summary>
            <pre>{record.vadMemory.startBreakdownJson}</pre>
            <pre>{record.vadMemory.endBreakdownJson}</pre>
          </details>
        </section>
        <section>
          <h3>Silero初期化負荷</h3>
          <dl>
            <div>
              <dt>初期化時間</dt>
              <dd>{formatNumber(record.engineInitialization.initializationMs, 3)} ms</dd>
            </div>
            <div>
              <dt>初期化前page memory</dt>
              <dd>{formatBytes(record.engineInitialization.memoryBeforeBytes)}</dd>
            </div>
            <div>
              <dt>初期化後page memory</dt>
              <dd>{formatBytes(record.engineInitialization.memoryAfterBytes)}</dd>
            </div>
            <div>
              <dt>初期化中page差分</dt>
              <dd>{formatBytes(record.engineInitialization.measuredPageDeltaBytes)}</dd>
            </div>
            <div>
              <dt>memory API</dt>
              <dd>{record.engineInitialization.memoryMethod}</dd>
            </div>
          </dl>
          <details>
            <summary>初期化前後memory breakdown</summary>
            <pre>{record.engineInitialization.memoryBeforeBreakdownJson}</pre>
            <pre>{record.engineInitialization.memoryAfterBreakdownJson}</pre>
          </details>
        </section>
        <section>
          <h3>Main thread負荷</h3>
          <dl>
            <div>
              <dt>Long Task対応</dt>
              <dd>{record.mainThreadLoad.longTaskSupported ? "対応" : "非対応"}</dd>
            </div>
            <div>
              <dt>Long Task数</dt>
              <dd>{record.mainThreadLoad.longTaskCount}</dd>
            </div>
            <div>
              <dt>Long Task合計</dt>
              <dd>{formatNumber(record.mainThreadLoad.longTaskTotalMs, 3)} ms</dd>
            </div>
            <div>
              <dt>Long Task最大</dt>
              <dd>{formatNumber(record.mainThreadLoad.longTaskMaximumMs, 3)} ms</dd>
            </div>
            <div>
              <dt>event-loop lag平均</dt>
              <dd>{formatNumber(record.mainThreadLoad.eventLoopLagAverageMs, 3)} ms</dd>
            </div>
            <div>
              <dt>event-loop lag最大</dt>
              <dd>{formatNumber(record.mainThreadLoad.eventLoopLagMaximumMs, 3)} ms</dd>
            </div>
            <div>
              <dt>lag sample数</dt>
              <dd>{record.mainThreadLoad.eventLoopSampleCount}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>VAD確率</h3>
          <dl>
            <div>
              <dt>平均</dt>
              <dd>{formatNumber(record.vadProbabilities.averageSpeechProbability, 4)}</dd>
            </div>
            <div>
              <dt>最大</dt>
              <dd>{formatNumber(record.vadProbabilities.maximumSpeechProbability, 4)}</dd>
            </div>
            <div>
              <dt>最小</dt>
              <dd>{formatNumber(record.vadProbabilities.minimumSpeechProbability, 4)}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>音声品質</h3>
          <dl>
            <div>
              <dt>長さ</dt>
              <dd>{formatNumber(record.audioQuality.durationMs)} ms</dd>
            </div>
            <div>
              <dt>サンプルレート</dt>
              <dd>{record.audioQuality.sampleRateHz} Hz</dd>
            </div>
            <div>
              <dt>サンプル数</dt>
              <dd>{record.audioQuality.sampleCount}</dd>
            </div>
            <div>
              <dt>サイズ</dt>
              <dd>{formatBytes(record.audioQuality.byteLength)}</dd>
            </div>
            <div>
              <dt>ピーク振幅</dt>
              <dd>{formatNumber(record.audioQuality.peakAmplitude, 5)}</dd>
            </div>
            <div>
              <dt>peak dBFS</dt>
              <dd>
                {record.audioQuality.peakDbfs === null
                  ? "取得不可"
                  : formatNumber(record.audioQuality.peakDbfs, 3)}
              </dd>
            </div>
            <div>
              <dt>RMS振幅</dt>
              <dd>{formatNumber(record.audioQuality.rmsAmplitude, 5)}</dd>
            </div>
            <div>
              <dt>RMS dBFS</dt>
              <dd>
                {record.audioQuality.rmsDbfs === null
                  ? "取得不可"
                  : formatNumber(record.audioQuality.rmsDbfs, 3)}
              </dd>
            </div>
            <div>
              <dt>平均振幅/DC offset</dt>
              <dd>{formatNumber(record.audioQuality.meanAmplitude, 6)}</dd>
            </div>
            <div>
              <dt>標準偏差</dt>
              <dd>{formatNumber(record.audioQuality.standardDeviation, 6)}</dd>
            </div>
            <div>
              <dt>最小振幅</dt>
              <dd>{formatNumber(record.audioQuality.minimumAmplitude, 5)}</dd>
            </div>
            <div>
              <dt>最大振幅</dt>
              <dd>{formatNumber(record.audioQuality.maximumAmplitude, 5)}</dd>
            </div>
            <div>
              <dt>crest factor</dt>
              <dd>
                {record.audioQuality.crestFactor === null
                  ? "取得不可"
                  : formatNumber(record.audioQuality.crestFactor, 4)}
              </dd>
            </div>
            <div>
              <dt>クリップ率</dt>
              <dd>{formatNumber(record.audioQuality.clippingPercent, 3)}%</dd>
            </div>
            <div>
              <dt>無音率</dt>
              <dd>{formatNumber(record.audioQuality.silencePercent, 3)}%</dd>
            </div>
            <div>
              <dt>ゼロ交差率</dt>
              <dd>{formatNumber(record.audioQuality.zeroCrossingRate, 3)}%</dd>
            </div>
            <div>
              <dt>MIME</dt>
              <dd>{record.audioBlob.type}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>音声単位STT</h3>
          <dl>
            <div>
              <dt>状態</dt>
              <dd>{record.sttStatus}</dd>
            </div>
            <div>
              <dt>処理時間</dt>
              <dd>
                {record.sttProcessingMs === null
                  ? "取得不可"
                  : `${formatNumber(record.sttProcessingMs)} ms`}
              </dd>
            </div>
            <div>
              <dt>信頼度</dt>
              <dd>{formatConfidence(record.sttConfidence)}</dd>
            </div>
            <div>
              <dt>文字列</dt>
              <dd>{record.transcript || "結果なし"}</dd>
            </div>
            <div>
              <dt>エラー</dt>
              <dd>{record.sttError ?? "なし"}</dd>
            </div>
          </dl>
        </section>
      </div>
      <h3>音声ごとの入力・VAD設定</h3>
      <div className="configuration-grid">
        <section>
          <h4>requested microphone</h4>
          <pre>{JSON.stringify(record.captureConfiguration.requestedMicrophone, null, 2)}</pre>
        </section>
        <section>
          <h4>requested VAD</h4>
          <pre>{JSON.stringify(record.captureConfiguration.vad, null, 2)}</pre>
        </section>
        <section>
          <h4>processor</h4>
          <pre>
            {JSON.stringify(
              {
                processorUsed: record.captureConfiguration.processorUsed,
                audioWorkletAvailable: record.captureConfiguration.audioWorkletAvailable,
              },
              null,
              2,
            )}
          </pre>
        </section>
        <section>
          <h4>requested constraints</h4>
          <pre>{record.captureConfiguration.requestedConstraintsJson}</pre>
        </section>
        <section>
          <h4>supported constraints</h4>
          <pre>{record.captureConfiguration.supportedConstraintsJson}</pre>
        </section>
        <section>
          <h4>actual track settings</h4>
          <pre>{record.captureConfiguration.actualSettingsJson}</pre>
        </section>
        <section>
          <h4>track capabilities</h4>
          <pre>{record.captureConfiguration.capabilitiesJson}</pre>
        </section>
      </div>
      <h3>実行環境</h3>
      <pre>{record.environment}</pre>
    </div>
  );
}
