"use client";

import { useId } from "react";
import {
  type ArchitectureBox,
  type ArchitectureDiagramKind,
  type ArchitecturePath,
  architectureDiagram,
  architectureDiagramCaption,
  BODY_SIZE,
  BOX_PAD_TOP,
  BOX_PAD_X,
  CHIP_ROW,
  fittedBoxContent,
  rectsOverlap,
  routeEdge,
  TITLE_LINE,
  TITLE_SIZE,
} from "../lib/architecture-diagram";
import type { ComparisonMode } from "../lib/contract";
import type { ConverterModel } from "../lib/converter-models";
import { comparisonPathSummary } from "../lib/path-labels";

export interface ComparisonPathDiagramProps {
  kind?: ArchitectureDiagramKind;
  mode?: ComparisonMode;
  browserWasmConfigured?: boolean;
  converterModel?: ConverterModel;
  caption?: string;
  className?: string;
}

const TONE_FILL: Record<ArchitectureBox["tone"], string> = {
  browser: "#eef5fb",
  worker: "#e5f2ef",
  desktop: "#f6f1ea",
  dict: "#f8f5e8",
  model: "#fff0e9",
  io: "#f4f6f5",
  warn: "#fdece6",
};

const TONE_STROKE: Record<ArchitectureBox["tone"], string> = {
  browser: "#6f8eab",
  worker: "#17756d",
  desktop: "#8d6b49",
  dict: "#9a8640",
  model: "#d86951",
  io: "#7b8583",
  warn: "#c45b45",
};

const LANE_FILL = {
  browser: "#f7fbfe",
  worker: "#f4faf8",
  desktop: "#fbf7f2",
};

const LANE_STROKE = {
  browser: "#c5d6e6",
  worker: "#cfe4df",
  desktop: "#e4d5c5",
};

const BAND_FILL = {
  device: "#f3f8fc",
  internet: "#fbf3ef",
};

const BAND_STROKE = {
  device: "#7ea3bf",
  internet: "#d49a86",
};

const PATH_STROKE: Record<ArchitecturePath, string> = {
  device: "#0f5a54",
  internet: "#c45b45",
  depends: "#9a8640",
};

const labelSize = (text: string): { w: number; h: number } => ({
  w: Math.max(36, text.length * 8.2 + 14),
  h: 20,
});

const nudgeLabel = (
  cx: number,
  cy: number,
  text: string,
  boxes: ArchitectureBox[],
): { x: number; y: number } => {
  const size = labelSize(text);
  for (const delta of [0, -26, 26, -48, 48, -72, 72]) {
    const candidate = { x: cx - size.w / 2, y: cy + delta - size.h / 2, w: size.w, h: size.h };
    if (!boxes.some((box) => rectsOverlap(candidate, box, 6))) {
      return { x: cx, y: cy + delta };
    }
  }
  return { x: cx, y: cy - 32 };
};

const diagramCaption = (
  kind: ArchitectureDiagramKind,
  mode: ComparisonMode | undefined,
  fallback: string | undefined,
): string => fallback ?? architectureDiagramCaption(kind, mode ?? "worker-vibrato");

const edgePath = (path: ArchitecturePath | undefined): ArchitecturePath => path ?? "device";

/**
 * Freeform SVG architecture: device vs internet, code vs static files, model/dict deps.
 */
export const ComparisonPathDiagram = ({
  kind = "mode",
  mode = "worker-vibrato",
  browserWasmConfigured = true,
  converterModel,
  caption,
  className,
}: ComparisonPathDiagramProps) => {
  const uid = useId().replace(/:/g, "");
  const diagram = architectureDiagram({
    kind,
    mode,
    browserWasmConfigured,
    converterModel,
  });
  const title = diagramCaption(kind, mode, caption);
  const summary = comparisonPathSummary(mode, browserWasmConfigured);
  const shadowId = `arch-shadow-${uid}`;
  const boxes = new Map(diagram.boxes.map((box) => [box.id, box]));
  const marker = (path: ArchitecturePath) => `arch-arrow-${uid}-${path}`;

  return (
    <figure
      className={["path-diagram", className].filter(Boolean).join(" ")}
      aria-label={kind === "mode" ? summary : title}
      data-testid="comparison-path-diagram"
      data-kind={kind}
      data-mode={mode}
    >
      <figcaption className="path-diagram-caption">
        <span className="path-diagram-caption-title">{title}</span>
        {kind === "overview" ? (
          <span className="path-diagram-legend-inline" data-testid="architecture-legend">
            実線: 処理の流れ · 赤: Cloudflare Worker 境界を越える · 点線: 任意 / フォールバック
          </span>
        ) : null}
      </figcaption>
      <div className="path-diagram-svg" data-overflow-x="hidden">
        <svg
          viewBox={diagram.viewBox}
          role="img"
          aria-labelledby={`${uid}-title`}
          data-testid="architecture-svg"
        >
          <title id={`${uid}-title`}>{title}</title>
          <defs>
            <filter id={shadowId} x="-4%" y="-6%" width="110%" height="118%">
              <feDropShadow
                dx="0"
                dy="2"
                stdDeviation="3"
                floodColor="#24322e"
                floodOpacity="0.06"
              />
            </filter>
            {(Object.keys(PATH_STROKE) as ArchitecturePath[]).map((path) => (
              <marker
                key={path}
                id={marker(path)}
                viewBox="0 0 12 12"
                refX="10"
                refY="6"
                markerWidth="9"
                markerHeight="9"
                orient="auto"
              >
                <path d="M0 1.2 L11 6 L0 10.8 Z" fill={PATH_STROKE[path]} />
              </marker>
            ))}
          </defs>
          {(diagram.bands ?? []).map((band) => (
            <g key={band.id} data-band={band.tone}>
              <rect
                x={band.x}
                y={band.y}
                width={band.w}
                height={band.h}
                rx="26"
                fill={BAND_FILL[band.tone]}
                stroke={BAND_STROKE[band.tone]}
                strokeWidth="1.25"
              />
              <text
                x={band.x + 20}
                y={band.y + 24}
                fill={BAND_STROKE[band.tone]}
                fontSize="16"
                fontWeight="800"
              >
                {band.title}
              </text>
              <text x={band.x + 20} y={band.y + 44} fill="#5c6566" fontSize="11">
                {band.subtitle}
              </text>
            </g>
          ))}
          {typeof diagram.boundaryX === "number" ? (
            <g data-testid="architecture-boundary">
              <line
                x1={diagram.boundaryX}
                y1={diagram.bands?.[0]?.y ?? 72}
                x2={diagram.boundaryX}
                y2={diagram.height - 12}
                stroke="#c45b45"
                strokeWidth="3"
                strokeDasharray="7 6"
              />
              <rect
                x={diagram.boundaryX - 62}
                y={(diagram.bands?.[0]?.y ?? 72) + 6}
                width="124"
                height="20"
                rx="10"
                fill="#c45b45"
              />
              <text
                x={diagram.boundaryX}
                y={(diagram.bands?.[0]?.y ?? 72) + 20}
                textAnchor="middle"
                fill="#fff"
                fontSize="11"
                fontWeight="800"
              >
                Cloudflare Worker 境界
              </text>
            </g>
          ) : null}
          {diagram.lanes.map((lane) => (
            <g key={lane.id}>
              {diagram.bands?.length ? null : (
                <rect
                  x={lane.x}
                  y={lane.y}
                  width={lane.w}
                  height={lane.h}
                  rx="22"
                  fill={LANE_FILL[lane.tone]}
                  stroke={LANE_STROKE[lane.tone]}
                  strokeWidth="1.5"
                />
              )}
              <text
                x={lane.x + 18}
                y={lane.y + 24}
                fill={TONE_STROKE[lane.tone]}
                fontSize="13"
                fontWeight="800"
              >
                {lane.title}
              </text>
            </g>
          ))}
          {diagram.edges.map((edge) => {
            const from = boxes.get(edge.from);
            const to = boxes.get(edge.to);
            if (!from || !to) {
              return null;
            }
            const pathKind = edgePath(edge.path);
            const stroke = PATH_STROKE[pathKind];
            const routed = routeEdge(from, to, edge, diagram);
            const labelAt = edge.label
              ? nudgeLabel(routed.labelAt.x, routed.labelAt.y, edge.label, diagram.boxes)
              : null;
            const size = edge.label ? labelSize(edge.label) : null;
            return (
              <g
                key={`${edge.from}->${edge.to}:${edge.label ?? ""}:${edge.dashed ? "dash" : "solid"}:${pathKind}`}
                data-path={pathKind}
              >
                <path
                  d={routed.d}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={pathKind === "internet" ? 2.4 : edge.dashed ? 1.7 : 2.1}
                  strokeDasharray={edge.dashed || pathKind === "depends" ? "6 5" : undefined}
                  markerEnd={`url(#${marker(pathKind)})`}
                />
                {edge.label && labelAt && size ? (
                  <g>
                    <rect
                      x={labelAt.x - size.w / 2}
                      y={labelAt.y - size.h / 2}
                      width={size.w}
                      height={size.h}
                      rx="10"
                      fill="#fff"
                      stroke={stroke}
                    />
                    <text
                      x={labelAt.x}
                      y={labelAt.y + 4}
                      textAnchor="middle"
                      fill={stroke}
                      fontSize="10"
                      fontWeight="700"
                    >
                      {edge.label}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {diagram.boxes.map((box) => {
            const content = fittedBoxContent(box);
            const chipRow = box.badge ? CHIP_ROW : 0;
            const titleY = box.y + BOX_PAD_TOP + chipRow + 14;
            return (
              <g key={box.id} filter={`url(#${shadowId})`}>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx="16"
                  fill={TONE_FILL[box.tone]}
                  stroke={TONE_STROKE[box.tone]}
                  strokeWidth={box.cost === "model" || box.cost === "cpu" ? 2.4 : 1.8}
                />
                <rect
                  x={box.x}
                  y={box.y}
                  width="7"
                  height={box.h}
                  rx="4"
                  fill={TONE_STROKE[box.tone]}
                />
                {box.badge ? (
                  <g>
                    <rect
                      x={box.x + box.w - 70}
                      y={box.y + 8}
                      width="58"
                      height="18"
                      rx="9"
                      fill="#fff"
                      stroke={TONE_STROKE[box.tone]}
                    />
                    <text
                      x={box.x + box.w - 41}
                      y={box.y + 21}
                      textAnchor="middle"
                      fill={TONE_STROKE[box.tone]}
                      fontSize="10"
                      fontWeight="800"
                    >
                      {box.badge}
                    </text>
                  </g>
                ) : null}
                {content.titleLines.map((line) => (
                  <text
                    key={`${box.id}-title-${line}`}
                    x={box.x + BOX_PAD_X}
                    y={titleY}
                    fill="#20252b"
                    fontSize={TITLE_SIZE}
                    fontWeight="800"
                  >
                    {line}
                  </text>
                ))}
                {content.bodyLines.map((line, lineIndex) => (
                  <text
                    key={`${box.id}-body-${line}`}
                    x={box.x + BOX_PAD_X}
                    y={titleY + TITLE_LINE + lineIndex * 16}
                    fill="#4e585a"
                    fontSize={BODY_SIZE}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
};
