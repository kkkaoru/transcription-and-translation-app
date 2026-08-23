"use client";

// This file runs with bun.
import { select } from "d3";
import { useEffect, useRef } from "react";

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

export interface PipelineVisualizationProps {
  activeStage?: "capture" | "asr" | "vibrato" | "azookey" | "response";
}

const SVG_WIDTH = 960;
const SVG_HEIGHT = 190;
const NODE_Y = 72;
const NODE_WIDTH = 150;
const NODE_HEIGHT = 68;
const nodes: PipelineNode[] = [
  { id: "capture", label: "Browser", detail: "microphone / WAV", x: 20, color: "#2563eb" },
  { id: "asr", label: "Nova-3", detail: "speech → text", x: 215, color: "#7c3aed" },
  { id: "vibrato", label: "Vibrato", detail: "morphology / reading", x: 410, color: "#0891b2" },
  { id: "azookey", label: "AzooKey", detail: "kana-kanji correction", x: 605, color: "#059669" },
  { id: "response", label: "Browser", detail: "one JSON response", x: 800, color: "#ea580c" },
];
const edges: PipelineEdge[] = [
  { sourceX: 170, targetX: 215, label: "audio" },
  { sourceX: 365, targetX: 410, label: "text" },
  { sourceX: 560, targetX: 605, label: "reading" },
  { sourceX: 755, targetX: 800, label: "JSON" },
];

export default function PipelineVisualization({
  activeStage,
}: PipelineVisualizationProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
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
      .attr("fill", "#94a3b8");

    root
      .selectAll("line.pipeline-edge")
      .data(edges)
      .join("line")
      .attr("class", "pipeline-edge")
      .attr("x1", (edge) => edge.sourceX)
      .attr("x2", (edge) => edge.targetX - 8)
      .attr("y1", NODE_Y + NODE_HEIGHT / 2)
      .attr("y2", NODE_Y + NODE_HEIGHT / 2)
      .attr("stroke", "#94a3b8")
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
      .attr("transform", (node) => `translate(${node.x},${NODE_Y})`);

    groups
      .append("rect")
      .attr("width", NODE_WIDTH)
      .attr("height", NODE_HEIGHT)
      .attr("rx", 14)
      .attr("fill", (node) => node.color)
      .attr("stroke", (node) => (node.id === activeStage ? "#f8fafc" : "transparent"))
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
  }, [activeStage]);

  return (
    <svg
      ref={svgRef}
      className="pipeline-visualization"
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
      role="img"
      aria-label="Browser audio is sent to one Cloudflare Worker, processed by Nova-3, Vibrato, and AzooKey, then returned to the browser as text"
    />
  );
}
