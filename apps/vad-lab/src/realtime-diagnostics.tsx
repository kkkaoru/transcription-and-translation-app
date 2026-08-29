// Runs in the browser; built and tested with Bun.
import { axisBottom, axisLeft, line, scaleLinear, select } from "d3";
import { useEffect, useRef } from "react";
import type { RealtimeDiagnosticSample } from "./model";

interface RealtimeDiagnosticsProps {
  samples: readonly RealtimeDiagnosticSample[];
  audioWorkletAvailable: boolean;
}

export interface ChartPoint {
  elapsedSeconds: number;
  probability: number;
  frameIntervalMs: number;
  callbackMs: number;
  eventLoopLagMs: number;
  memoryMiB: number;
}

const WIDTH: number = 920;
const HEIGHT: number = 300;
const MARGIN_LEFT: number = 58;
const MARGIN_RIGHT: number = 20;
const MARGIN_TOP: number = 18;
const MARGIN_BOTTOM: number = 36;
const MEMORY_BYTES_PER_MIB: number = 1_048_576;
const EMPTY_MEMORY: number = 0;

export const toChartPoints = (samples: readonly RealtimeDiagnosticSample[]): ChartPoint[] => {
  const firstTimestamp: number = samples[0]?.timestampMs ?? 0;
  return samples.map((sample) => ({
    elapsedSeconds: (sample.timestampMs - firstTimestamp) / 1_000,
    probability: sample.speechProbability,
    frameIntervalMs: sample.frameIntervalMs ?? 0,
    callbackMs: sample.callbackMs,
    eventLoopLagMs: sample.eventLoopLagMs,
    memoryMiB:
      sample.memoryBytes === null ? EMPTY_MEMORY : sample.memoryBytes / MEMORY_BYTES_PER_MIB,
  }));
};

const maximumLoad = (points: readonly ChartPoint[]): number =>
  Math.max(
    50,
    ...points.map((point) =>
      Math.max(point.frameIntervalMs, point.callbackMs, point.eventLoopLagMs),
    ),
  );

export function RealtimeDiagnostics({ samples, audioWorkletAvailable }: RealtimeDiagnosticsProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const element: SVGSVGElement | null = svgRef.current;
    const points: ChartPoint[] = toChartPoints(samples);
    if (element === null || points.length === 0) {
      return;
    }
    const svg = select(element);
    svg.selectAll("*").remove();
    const x = scaleLinear()
      .domain([0, Math.max(1, points.at(-1)?.elapsedSeconds ?? 1)])
      .range([MARGIN_LEFT, WIDTH - MARGIN_RIGHT]);
    const probabilityY = scaleLinear()
      .domain([0, 1])
      .range([HEIGHT / 2 - 12, MARGIN_TOP]);
    const memoryValues: number[] = points
      .map((point) => point.memoryMiB)
      .filter((value) => value > 0);
    const memoryMinimum: number = Math.min(...memoryValues, 0);
    const memoryMaximum: number = Math.max(...memoryValues, 1);
    const memoryY = scaleLinear()
      .domain([memoryMinimum, memoryMaximum === memoryMinimum ? memoryMinimum + 1 : memoryMaximum])
      .range([HEIGHT / 2 - 12, MARGIN_TOP]);
    const loadY = scaleLinear()
      .domain([0, maximumLoad(points)])
      .range([HEIGHT - MARGIN_BOTTOM, HEIGHT / 2 + 18]);
    const probabilityLine = line<ChartPoint>()
      .x((point) => x(point.elapsedSeconds))
      .y((point) => probabilityY(point.probability));
    const memoryLine = line<ChartPoint>()
      .x((point) => x(point.elapsedSeconds))
      .y((point) => memoryY(point.memoryMiB));
    const frameLine = line<ChartPoint>()
      .x((point) => x(point.elapsedSeconds))
      .y((point) => loadY(point.frameIntervalMs));
    const lagLine = line<ChartPoint>()
      .x((point) => x(point.elapsedSeconds))
      .y((point) => loadY(point.eventLoopLagMs));
    svg
      .append("g")
      .attr("transform", `translate(0,${HEIGHT - MARGIN_BOTTOM})`)
      .call(axisBottom(x).ticks(8));
    svg
      .append("g")
      .attr("transform", `translate(${MARGIN_LEFT},0)`)
      .call(axisLeft(probabilityY).ticks(4));
    svg
      .append("path")
      .datum(points)
      .attr("class", "chart-line probability-line")
      .attr("d", probabilityLine);
    svg.append("path").datum(points).attr("class", "chart-line memory-line").attr("d", memoryLine);
    svg.append("path").datum(points).attr("class", "chart-line frame-line").attr("d", frameLine);
    svg.append("path").datum(points).attr("class", "chart-line lag-line").attr("d", lagLine);
    svg
      .append("line")
      .attr("x1", MARGIN_LEFT)
      .attr("x2", WIDTH - MARGIN_RIGHT)
      .attr("y1", HEIGHT / 2)
      .attr("y2", HEIGHT / 2)
      .attr("class", "chart-divider");
  }, [samples]);

  const latest: ChartPoint | null = toChartPoints(samples).at(-1) ?? null;
  return (
    <section className="realtime-diagnostics" aria-labelledby="realtime-heading">
      <details>
        <summary>
          <span>
            <span className="eyebrow">D3 LIVE DIAGNOSTICS</span>
            <strong id="realtime-heading">リアルタイム技術解説</strong>
          </span>
          <span className={audioWorkletAvailable ? "worklet-status active" : "worklet-status"}>
            {audioWorkletAvailable ? "AudioWorklet利用可能" : "ScriptProcessor fallback"}
          </span>
        </summary>
        <svg
          ref={svgRef}
          role="img"
          aria-label="Silero speech probability, frame interval, and event-loop lag over time"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        />
        <div className="chart-legend">
          <span className="probability-key">発話確率 0–1</span>
          <span className="memory-key">page memory MiB</span>
          <span className="frame-key">frame間隔 ms（理想32 ms）</span>
          <span className="lag-key">event-loop lag ms</span>
        </div>
        <div className="technical-grid">
          <p>
            <strong>Silero判定:</strong> 16 kHz音声を512 samples（32 ms）単位でONNX Runtime
            WASMへ入力します。
          </p>
          <p>
            <strong>処理負荷:</strong> frame間隔、callback時間、event-loop lag、Long
            Taskを実時間で収集します。
          </p>
          <p>
            <strong>RAM:</strong> page memory APIの観測値を250
            ms間隔で取得し、発話ごとの開始・終了・ピークを保存します。
          </p>
          <p>
            <strong>現在値:</strong> probability {latest?.probability.toFixed(3) ?? "—"} / frame{" "}
            {latest?.frameIntervalMs.toFixed(2) ?? "—"} ms / memory{" "}
            {latest?.memoryMiB.toFixed(2) ?? "—"} MiB
          </p>
        </div>
      </details>
    </section>
  );
}
