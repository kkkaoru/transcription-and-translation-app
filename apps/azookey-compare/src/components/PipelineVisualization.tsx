"use client";

// This file runs with bun.
import { select } from "d3";
import { useEffect, useRef } from "react";
import type {
  BrowserAsrModel,
  BrowserComputeTier,
  BrowserConversionModel,
  BrowserN5Mode,
} from "../lib/workers-ai-asr-client";

interface PipelineNode {
  id: string;
  label: string;
  detail: string;
  zone: string;
  x: number;
  y: number;
  color: string;
  disabled: boolean;
}

interface PipelineEdge {
  source: string;
  target: string;
  label: string;
  dashed?: boolean;
}

export interface PipelineVisualizationProps {
  activeStage?: "capture" | "gateway" | "asr" | "n5_lm" | "vibrato" | "azookey" | "response";
  asrModel?: BrowserAsrModel;
  conversionModel?: BrowserConversionModel;
  computeTier?: BrowserComputeTier;
  n5Lm?: BrowserN5Mode;
  language?: string;
}

const SVG_WIDTH = 1480;
const SVG_HEIGHT = 390;
const NODE_Y = 112;
const DICTIONARY_Y = 270;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 76;
const NODE_GAP = 30;
const NODE_START_X = 16;
const nodeX = (index: number): number => NODE_START_X + index * (NODE_WIDTH + NODE_GAP);

const asrLabel = (model: BrowserAsrModel): string =>
  model === "@cf/deepgram/nova-3" ? "Nova-3" : "Whisper V3 Turbo";

const conversionLabel = (model: BrowserConversionModel): string =>
  model === "none"
    ? "AzooKey off"
    : model === "zenz-v3.2-small-gguf"
      ? "Zenz Small GGUF"
      : "Zenz XSmall GGUF";

const edgePath = (source: PipelineNode, target: PipelineNode): string => {
  const sourceX = source.x + NODE_WIDTH;
  const sourceY = source.y + NODE_HEIGHT / 2;
  const targetX = target.x;
  const targetY = target.y + NODE_HEIGHT / 2;
  const controlX = (sourceX + targetX) / 2;
  return `M${String(sourceX)},${String(sourceY)} C${String(controlX)},${String(sourceY)} ${String(controlX)},${String(targetY)} ${String(targetX)},${String(targetY)}`;
};

export default function PipelineVisualization({
  activeStage,
  asrModel = "@cf/deepgram/nova-3",
  conversionModel = "zenz-v3.2-xsmall-gguf",
  computeTier = "standard",
  n5Lm = "off",
  language = "ja",
}: PipelineVisualizationProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const japanese = language === "ja";
    const usesAzookey = japanese && conversionModel !== "none";
    const usesN5 = japanese && n5Lm === "on";
    const nodes: PipelineNode[] = [
      {
        id: "capture",
        label: "Browser",
        detail: "mic + Silero VAD",
        zone: "BROWSER",
        x: nodeX(0),
        y: NODE_Y,
        color: "#2563eb",
        disabled: false,
      },
      {
        id: "gateway",
        label: "Compare Worker",
        detail: "Access + binding",
        zone: "COMPARE WORKER",
        x: nodeX(1),
        y: NODE_Y,
        color: "#ea580c",
        disabled: false,
      },
      {
        id: "asr",
        label: asrLabel(asrModel),
        detail: "one Silero utterance",
        zone: "INFERENCE WORKER",
        x: nodeX(2),
        y: NODE_Y,
        color: "#7c3aed",
        disabled: false,
      },
      {
        id: "n5_lm",
        label: "Input N5 LM",
        detail: usesN5 ? `${computeTier} / measured` : "off / bypass",
        zone: "PROFILE CONTAINER",
        x: nodeX(3),
        y: NODE_Y,
        color: "#b45309",
        disabled: !usesN5,
      },
      {
        id: "vibrato",
        label: "Vibrato",
        detail: usesAzookey ? "ja reading / IPADIC" : "bypass",
        zone: "INFERENCE WORKER",
        x: nodeX(4),
        y: NODE_Y,
        color: "#0891b2",
        disabled: !usesAzookey,
      },
      {
        id: "azookey",
        label: "AzooKey lattice",
        detail: usesAzookey ? "system + user lexicon" : "off / bypass",
        zone: "INFERENCE WORKER",
        x: nodeX(5),
        y: NODE_Y,
        color: "#0f766e",
        disabled: !usesAzookey,
      },
      {
        id: "zenz",
        label: conversionLabel(conversionModel),
        detail: usesAzookey ? `${computeTier} / GGUF` : "no completion",
        zone: "PROFILE CONTAINER",
        x: nodeX(6),
        y: NODE_Y,
        color: "#059669",
        disabled: !usesAzookey,
      },
      {
        id: "response",
        label: "Browser result",
        detail: "timing + cost",
        zone: "BROWSER",
        x: nodeX(7),
        y: NODE_Y,
        color: "#2563eb",
        disabled: false,
      },
      {
        id: "dictionary",
        label: "Custom dictionary",
        detail: "DO revision + isolate cache",
        zone: "WORKER-OWNED STORAGE",
        x: nodeX(5),
        y: DICTIONARY_Y,
        color: "#475569",
        disabled: !usesAzookey,
      },
    ];
    const edges: PipelineEdge[] = [
      { source: "capture", target: "gateway", label: "speech WAV" },
      { source: "gateway", target: "asr", label: "binding" },
      { source: "asr", target: "n5_lm", label: usesN5 ? "reading" : "bypass" },
      { source: "n5_lm", target: "vibrato", label: "text" },
      { source: "vibrato", target: "azookey", label: "reading" },
      { source: "azookey", target: "zenz", label: usesAzookey ? "N-best" : "bypass" },
      { source: "zenz", target: "response", label: "JSON" },
      { source: "dictionary", target: "azookey", label: "revision cache", dashed: true },
    ];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const root = select(svgRef.current);
    root.selectAll("*").remove();
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
      .selectAll("path.pipeline-edge")
      .data(edges)
      .join("path")
      .attr("class", "pipeline-edge")
      .attr("d", (edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        return source && target ? edgePath(source, target) : "";
      })
      .attr("fill", "none")
      .attr("stroke", "#64748b")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", (edge) => (edge.dashed ? "6 5" : null))
      .attr("marker-end", "url(#pipeline-arrow)");

    root
      .selectAll("text.pipeline-edge-label")
      .data(edges.filter((edge) => edge.source !== "dictionary"))
      .join("text")
      .attr("class", "pipeline-edge-label")
      .attr("x", (edge) => {
        const source = byId.get(edge.source);
        const target = byId.get(edge.target);
        return source && target ? (source.x + NODE_WIDTH + target.x) / 2 : 0;
      })
      .attr("y", NODE_Y + NODE_HEIGHT + 24)
      .attr("text-anchor", "middle")
      .text((edge) => edge.label);

    const groups = root
      .selectAll("g.pipeline-node")
      .data(nodes)
      .join("g")
      .attr("class", "pipeline-node")
      .attr("transform", (node) => `translate(${String(node.x)},${String(node.y)})`)
      .attr("opacity", (node) => (node.disabled ? 0.36 : 1));
    groups
      .append("rect")
      .attr("width", NODE_WIDTH)
      .attr("height", NODE_HEIGHT)
      .attr("rx", 14)
      .attr("fill", (node) => node.color)
      .attr("stroke", (node) => (node.id === activeStage ? "#0f172a" : "transparent"))
      .attr("stroke-width", 4);
    groups
      .append("text")
      .attr("x", NODE_WIDTH / 2)
      .attr("y", -26)
      .attr("text-anchor", "middle")
      .attr("class", "pipeline-zone-label")
      .text((node) => node.zone);
    groups
      .append("text")
      .attr("x", NODE_WIDTH / 2)
      .attr("y", 31)
      .attr("text-anchor", "middle")
      .attr("class", "pipeline-node-title")
      .text((node) => node.label);
    groups
      .append("text")
      .attr("x", NODE_WIDTH / 2)
      .attr("y", 55)
      .attr("text-anchor", "middle")
      .attr("class", "pipeline-node-detail")
      .text((node) => node.detail);
  }, [activeStage, asrModel, computeTier, conversionModel, language, n5Lm]);

  return (
    <svg
      ref={svgRef}
      className="pipeline-visualization"
      viewBox={`0 0 ${String(SVG_WIDTH)} ${String(SVG_HEIGHT)}`}
      role="img"
      aria-label="Silero speech capture, Cloudflare Workers, profile Containers, N5 LM, GGUF, and Worker-owned custom dictionary flow"
    />
  );
}
