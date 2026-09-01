// Runs with Bun during build and test.
import { axisBottom, axisLeft } from "d3-axis";
import { scaleLinear } from "d3-scale";
import { select } from "d3-selection";
import { line } from "d3-shape";
import { useEffect, useRef } from "react";
import type { LanguageInference } from "./language-api";

export interface InferenceTimelineEntry {
  sequence: number;
  inference: LanguageInference;
}

interface RealtimeExplainerProps {
  history: readonly InferenceTimelineEntry[];
  title: string;
  detail: string;
  providerDetail: string;
  providerOnly: boolean;
}

interface TimelinePoint {
  sequence: number;
  raw: number;
  state: number;
  enter: number;
  retain: number;
}

const WIDTH: number = 760;
const HEIGHT: number = 250;
const MARGIN = { top: 18, right: 24, bottom: 38, left: 48 };

export function RealtimeExplainer({
  history,
  title,
  detail,
  providerDetail,
  providerOnly,
}: RealtimeExplainerProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const element: SVGSVGElement | null = svgRef.current;
    if (element === null) return;
    const svg = select<SVGSVGElement, unknown>(element);
    svg.selectAll("*").remove();
    const points: TimelinePoint[] = history.map(({ sequence, inference }) => ({
      sequence,
      raw: inference.rawLanguages[0]?.probability ?? 0,
      state: inference.hysteresis.stablePosterior,
      enter: inference.hysteresis.enterPosterior,
      retain: inference.hysteresis.retainPosterior,
    }));
    const sequenceMax: number = Math.max(1, points.at(-1)?.sequence ?? 1);
    const sequenceMin: number = Math.max(0, sequenceMax - 29);
    const x = scaleLinear()
      .domain([sequenceMin, sequenceMax])
      .range([MARGIN.left, WIDTH - MARGIN.right]);
    const y = scaleLinear()
      .domain([0, 1])
      .range([HEIGHT - MARGIN.bottom, MARGIN.top]);
    svg
      .append("g")
      .attr("transform", `translate(0,${String(HEIGHT - MARGIN.bottom)})`)
      .call(
        axisBottom(x)
          .ticks(6)
          .tickFormat((value) => `#${String(Math.round(Number(value)))}`),
      );
    svg
      .append("g")
      .attr("transform", `translate(${String(MARGIN.left)},0)`)
      .call(
        axisLeft(y)
          .ticks(5)
          .tickFormat((value) => `${String(Math.round(Number(value) * 100))}%`),
      );
    const draw = (key: keyof Omit<TimelinePoint, "sequence">, className: string) => {
      const path = line<TimelinePoint>()
        .x((point) => x(point.sequence))
        .y((point) => y(point[key]));
      svg
        .append("path")
        .datum(points)
        .attr("class", className)
        .attr("fill", "none")
        .attr("d", path);
    };
    draw("raw", "timeline-line timeline-raw");
    draw("state", "timeline-line timeline-state");
    if (!providerOnly) {
      draw("enter", "timeline-line timeline-enter");
      draw("retain", "timeline-line timeline-retain");
    }
  }, [history, providerOnly]);

  return (
    <section className="explainer-section panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">D3.js · streaming evidence</p>
          <h2>{title}</h2>
          <p>{providerOnly ? providerDetail : detail}</p>
        </div>
      </div>
      <div className="signal-flow" role="img" aria-label="audio inference signal flow">
        <span>16 kHz PCM</span>
        <i>→</i>
        <span>VAD</span>
        <i>→</i>
        <span>{providerOnly ? "Workers AI · Nova-3" : "ECAPA / AmberNet"}</span>
        <i>→</i>
        <span>{providerOnly ? "Language detection" : "Rust HSMM → SPRT → Hysteresis"}</span>
      </div>
      <div className="timeline-legend">
        <span className="legend-raw">Raw top probability</span>
        <span className="legend-state">Stable posterior</span>
        {!providerOnly ? <span className="legend-enter">Enter threshold</span> : null}
        {!providerOnly ? <span className="legend-retain">Retain threshold</span> : null}
      </div>
      <svg
        ref={svgRef}
        className="timeline-chart"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={title}
      />
    </section>
  );
}
