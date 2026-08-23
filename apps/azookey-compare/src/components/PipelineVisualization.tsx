"use client";

// This file runs with bun.
import { select } from "d3";
import { useEffect, useRef } from "react";
import type { BrowserAsrModel, BrowserConversionModel } from "../lib/workers-ai-asr-client";

interface PipelineNode {
  id: string;
  label: string;
  detail: string;
  x: number;
  color: string;
}

interface PipelineEdge {
  sourceX: number;
  targetX: number;
  label: string;
}

interface PipelineZone {
  label: string;
  x: number;
  width: number;
  fill: string;
}

export interface PipelineVisualizationProps {
  activeStage?: "capture" | "gateway" | "asr" | "vibrato" | "azookey" | "response";
  asrModel?: BrowserAsrModel;
  conversionModel?: BrowserConversionModel;
}

const SVG_WIDTH = 1160;
const SVG_HEIGHT = 250;
const NODE_Y = 100;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 68;
const zones: PipelineZone[] = [
  { label: "BROWSER", x: 8, width: 174, fill: "#eff6ff" },
  { label: "CLOUDFLARE COMPARE WORKER / SERVICE BINDING", x: 192, width: 174, fill: "#fff7ed" },
  { label: "CLOUDFLARE INFERENCE WORKER", x: 376, width: 358, fill: "#f5f3ff" },
  { label: "CLOUDFLARE ZENZ CONTAINER", x: 744, width: 222, fill: "#ecfdf5" },
  { label: "BROWSER", x: 976, width: 176, fill: "#eff6ff" },
];
const edges: PipelineEdge[] = [
  { sourceX: 170, targetX: 202, label: "WAV" },
  { sourceX: 352, targetX: 386, label: "binding" },
  { sourceX: 536, targetX: 570, label: "text" },
  { sourceX: 720, targetX: 754, label: "reading" },
  { sourceX: 904, targetX: 988, label: "JSON" },
];

const asrLabel = (model: BrowserAsrModel): string =>
  model === "@cf/deepgram/nova-3" ? "Nova-3" : "Whisper V3 Turbo";

const conversionLabel = (model: BrowserConversionModel): string =>
  model === "zenz-v3.2-small-gguf" ? "Zenz Small GGUF" : "Zenz XSmall GGUF";

export default function PipelineVisualization({
  activeStage,
  asrModel = "@cf/deepgram/nova-3",
  conversionModel = "zenz-v3.2-xsmall-gguf",
}: PipelineVisualizationProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const nodes: PipelineNode[] = [
      { id: "capture", label: "Browser", detail: "mic / Silero VAD", x: 20, color: "#2563eb" },
      {
        id: "gateway",
        label: "Compare Worker",
        detail: "Access / service binding",
        x: 202,
        color: "#ea580c",
      },
      {
        id: "asr",
        label: asrLabel(asrModel),
        detail: "batch speech → text",
        x: 386,
        color: "#7c3aed",
      },
      { id: "vibrato", label: "Vibrato", detail: "ja only / IPADIC", x: 570, color: "#0891b2" },
      {
        id: "azookey",
        label: conversionLabel(conversionModel),
        detail: "GGUF + Worker lexicon",
        x: 754,
        color: "#059669",
      },
      {
        id: "response",
        label: "Browser",
        detail: "result / cost / timing",
        x: 988,
        color: "#2563eb",
      },
    ];
    const root = select(svgRef.current);
    root.selectAll("*").remove();
    root
      .selectAll("rect.pipeline-zone")
      .data(zones)
      .join("rect")
      .attr("class", "pipeline-zone")
      .attr("x", (zone) => zone.x)
      .attr("y", 8)
      .attr("width", (zone) => zone.width)
      .attr("height", 226)
      .attr("rx", 14)
      .attr("fill", (zone) => zone.fill)
      .attr("stroke", "#cbd5e1");
    root
      .selectAll("text.pipeline-zone-label")
      .data(zones)
      .join("text")
      .attr("class", "pipeline-zone-label")
      .attr("x", (zone) => zone.x + 12)
      .attr("y", 32)
      .text((zone) => zone.label);
    root
      .append("defs")
      .append("marker")
      .attr("id", "pipeline-arrow")
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 8)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#64748b");
    root
      .selectAll("line.pipeline-edge")
      .data(edges)
      .join("line")
      .attr("class", "pipeline-edge")
      .attr("x1", (edge) => edge.sourceX)
      .attr("x2", (edge) => edge.targetX - 8)
      .attr("y1", NODE_Y + NODE_HEIGHT / 2)
      .attr("y2", NODE_Y + NODE_HEIGHT / 2)
      .attr("stroke", "#64748b")
      .attr("stroke-width", 2)
      .attr("marker-end", "url(#pipeline-arrow)");
    root
      .selectAll("text.pipeline-edge-label")
      .data(edges)
      .join("text")
      .attr("class", "pipeline-edge-label")
      .attr("x", (edge) => (edge.sourceX + edge.targetX) / 2)
      .attr("y", NODE_Y + 20)
      .attr("text-anchor", "middle")
      .text((edge) => edge.label);
    const groups = root
      .selectAll("g.pipeline-node")
      .data(nodes)
      .join("g")
      .attr("class", "pipeline-node")
      .attr("transform", (node) => `translate(${String(node.x)},${String(NODE_Y)})`);
    groups
      .append("rect")
      .attr("width", NODE_WIDTH)
      .attr("height", NODE_HEIGHT)
      .attr("rx", 14)
      .attr("fill", (node) => node.color)
      .attr("stroke", (node) => (node.id === activeStage ? "#0f172a" : "transparent"))
      .attr("stroke-width", 4)
      .attr("opacity", (node) => (activeStage && node.id !== activeStage ? 0.55 : 1));
    groups
      .append("text")
      .attr("x", NODE_WIDTH / 2)
      .attr("y", 28)
      .attr("text-anchor", "middle")
      .attr("class", "pipeline-node-title")
      .text((node) => node.label);
    groups
      .append("text")
      .attr("x", NODE_WIDTH / 2)
      .attr("y", 49)
      .attr("text-anchor", "middle")
      .attr("class", "pipeline-node-detail")
      .text((node) => node.detail);
  }, [activeStage, asrModel, conversionModel]);

  return (
    <svg
      ref={svgRef}
      className="pipeline-visualization"
      viewBox={`0 0 ${String(SVG_WIDTH)} ${String(SVG_HEIGHT)}`}
      role="img"
      aria-label="Browser capture, Cloudflare compare Worker service binding, and Cloudflare inference Worker boundaries"
    />
  );
}
