import type { ComparisonMode } from "./contract";
import type { ConverterModel } from "./converter-models";
import { DEFAULT_CONVERTER_MODEL, isZenzConverterModel } from "./converter-models";
import { COMPARE_WORKER_ORIGIN } from "./inference-proxy";

export type ArchitectureDiagramKind = "overview" | "mode";
export type ArchitectureTone = "browser" | "worker" | "desktop" | "dict" | "model" | "io" | "warn";
export type ArchitectureArtifact = "code" | "static" | "model" | "runtime" | "dict";
export type ArchitecturePath = "device" | "internet" | "depends";
export type ArchitectureVia = "top" | "boundary" | "gutter" | "vertical";
export type ArchitectureCost = "light" | "io" | "cpu" | "model";

export const ARCHITECTURE_ASSET_SIZES = {
  ipadicZst: "7.7 MB",
  azkdictGz: "9.6 MB",
  vibratoWasm: "281 KB",
  azookeyWasm: "249 KB",
  zenzXsmall: "21 MB",
  zenzSmall: "74 MB",
} as const;

/** Where compare-UI dictionaries actually load from, and what they do. */
export const ARCHITECTURE_DICTIONARIES = {
  ipadic: {
    file: "system.dic.zst",
    upstream: "ipadic-mecab-2_7_0",
    browserUrl: "/vibrato/system.dic.zst",
    workerEnv: "VIBRATO_DICTIONARY_URL",
    workerUpstreamEnv: "VIBRATO_UPSTREAM_URL",
    workerHostedAsset: false,
    usedBy: "Vibrato",
    fn: "漢字→ひらがな F[7]",
  },
  azookey: {
    file: "system.azkdict.gz",
    format: "AZKDIC01",
    browserUrl: "/azookey/system.azkdict.gz",
    workerUrl: "/azookey/system.azkdict.gz",
    workerEnv: "AZOOKEY_DICTIONARY_URL",
    workerHostedAsset: true,
    usedBy: "AzooKey WASM / Zenzai 辞書（ブラウザ）",
    fn: "かな漢字変換 LOUDS/MM/CID",
    unusedBy: "Zenzai GGUF 推論",
  },
} as const;

/** Zenzai GGUF inference uses llama-server; browser-complete uses LOUDS dictionary only. */
export const ARCHITECTURE_ZENZAI = {
  env: "MODEL_ROUTES",
  endpoint: "/completion",
  loader: "llama-server",
  file: "ggml-model-Q5_K_M.gguf",
  note: "Cloudflare Worker は GGUF を持たない",
  browserDictLabel: "Zenzai 辞書（LOUDS）",
  browserDictUrl: "/azookey/system.azkdict.gz",
  xsmall: {
    id: "zenz-v3.2-xsmall-gguf",
    hf: "Miwa-Keita/zenz-v3.2-xsmall-gguf",
    rev: "4f5423f",
    size: ARCHITECTURE_ASSET_SIZES.zenzXsmall,
    local: "127.0.0.1:8081",
  },
  small: {
    id: "zenz-v3.2-small-gguf",
    hf: "Miwa-Keita/zenz-v3.2-small-gguf",
    rev: "c67e03e",
    size: ARCHITECTURE_ASSET_SIZES.zenzSmall,
    local: "127.0.0.1:8082",
  },
} as const;

export interface ArchitectureBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  tone: ArchitectureTone;
  badge?: string;
  artifact?: ArchitectureArtifact;
  cost?: ArchitectureCost;
  size?: string;
}

export interface ArchitectureLane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  tone: "browser" | "worker" | "desktop";
}

export interface ArchitectureBand {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  subtitle: string;
  tone: "device" | "internet";
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  path?: ArchitecturePath;
  via?: ArchitectureVia;
  corridorY?: number;
}

export interface ArchitectureDiagram {
  viewBox: string;
  width: number;
  height: number;
  compactLayout?: boolean;
  bands?: ArchitectureBand[];
  boundaryX?: number;
  corridorY?: number;
  gutterX?: number;
  lanes: ArchitectureLane[];
  boxes: ArchitectureBox[];
  edges: ArchitectureEdge[];
}

export interface DiagramLayoutMetrics {
  boxPadTop: number;
  boxPadBottom: number;
  titleLine: number;
  bodyLine: number;
  chipRow: number;
  titleSize: number;
  bodySize: number;
}

export interface ArchitectureDiagramOptions {
  kind: ArchitectureDiagramKind;
  mode?: ComparisonMode;
  browserWasmConfigured?: boolean;
  converterModel?: ConverterModel;
}

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

type BoxDraft = Omit<ArchitectureBox, "x" | "y" | "w" | "h">;

export const BOX_PAD_X = 18;
export const BOX_PAD_TOP = 10;
export const BOX_PAD_BOTTOM = 14;
export const TITLE_SIZE = 14;
export const BODY_SIZE = 11;
export const TITLE_LINE = 20;
export const BODY_LINE = 16;
export const CHIP_ROW = 22;
export const LANE_TITLE_HEIGHT = 36;
export const STACK_GAP = 40;
export const OVERVIEW_STACK_GAP = 16;
export const OVERVIEW_DIAGRAM_PREVIOUS_HEIGHT = 504;
export const OVERVIEW_DIAGRAM_TARGET_MAX_HEIGHT = 280;
export const MODE_BOX_PAD_TOP = 8;
export const MODE_BOX_PAD_BOTTOM = 10;
export const MODE_TITLE_LINE = 17;
export const MODE_BODY_LINE = 14;
export const MODE_CHIP_ROW = 18;
export const MODE_TITLE_SIZE = 13;
export const MODE_BODY_SIZE = 10;
export const MODE_STACK_Y = 10;
export const MODE_BOTTOM_PAD = 10;
export const MODE_DIAGRAM_PREVIOUS_HEIGHT = 194;
export const ARCHITECTURE_DIAGRAM_MAX_WIDTH = 720;

export const diagramLayoutMetrics = (
  diagram: Pick<ArchitectureDiagram, "compactLayout">,
): DiagramLayoutMetrics =>
  diagram.compactLayout
    ? {
        boxPadTop: MODE_BOX_PAD_TOP,
        boxPadBottom: MODE_BOX_PAD_BOTTOM,
        titleLine: MODE_TITLE_LINE,
        bodyLine: MODE_BODY_LINE,
        chipRow: MODE_CHIP_ROW,
        titleSize: MODE_TITLE_SIZE,
        bodySize: MODE_BODY_SIZE,
      }
    : {
        boxPadTop: BOX_PAD_TOP,
        boxPadBottom: BOX_PAD_BOTTOM,
        titleLine: TITLE_LINE,
        bodyLine: BODY_LINE,
        chipRow: CHIP_ROW,
        titleSize: TITLE_SIZE,
        bodySize: BODY_SIZE,
      };

export const measureText = (text: string, fontSize: number): number => {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code <= 0x7e ? fontSize * 0.62 : fontSize;
  }
  return width;
};

export const titleMaxWidth = (box: Pick<ArchitectureBox, "w" | "artifact" | "badge">): number =>
  Math.max(48, box.w - BOX_PAD_X - 10);

export const bodyMaxWidth = (box: Pick<ArchitectureBox, "w">): number =>
  Math.max(48, box.w - BOX_PAD_X - 10);

export const fittedBoxContent = (
  box: Pick<ArchitectureBox, "title" | "lines">,
): { titleLines: string[]; bodyLines: string[] } => ({
  titleLines: [box.title],
  bodyLines: [...box.lines],
});

export const requiredBoxHeight = (
  box: Pick<ArchitectureBox, "w" | "title" | "lines" | "artifact" | "badge" | "cost" | "size">,
  compact = false,
): number => {
  const metrics = compact ? diagramLayoutMetrics({ compactLayout: true }) : diagramLayoutMetrics({});
  const chipRow = box.badge ? metrics.chipRow : 0;
  return (
    metrics.boxPadTop +
    chipRow +
    metrics.titleLine +
    box.lines.length * metrics.bodyLine +
    metrics.boxPadBottom
  );
};

export const layoutStack = (
  x: number,
  startY: number,
  width: number,
  gap: number,
  items: BoxDraft[],
  compact = false,
): ArchitectureBox[] => {
  let y = startY;
  return items.map((item) => {
    const box: ArchitectureBox = { ...item, x, y, w: width, h: 0 };
    box.h = requiredBoxHeight(box, compact);
    y += box.h + gap;
    return box;
  });
};

export const layoutRow = (
  startX: number,
  y: number,
  gap: number,
  items: Array<BoxDraft & { w: number }>,
  compact = false,
): ArchitectureBox[] => {
  let x = startX;
  return items.map((item) => {
    const box: ArchitectureBox = { ...item, x, y, h: 0 };
    box.h = requiredBoxHeight(box, compact);
    x += box.w + gap;
    return box;
  });
};

export const rectsOverlap = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  gap = 0,
): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

export const overlappingBoxIds = (diagram: ArchitectureDiagram): string[] => {
  const hits: string[] = [];
  for (let index = 0; index < diagram.boxes.length; index += 1) {
    for (let other = index + 1; other < diagram.boxes.length; other += 1) {
      const left = diagram.boxes[index];
      const right = diagram.boxes[other];
      if (rectsOverlap(left, right)) {
        hits.push(`${left.id}|${right.id}`);
      }
    }
  }
  return hits;
};

export const overflowingBoxIds = (diagram: ArchitectureDiagram): string[] => {
  const compact = diagram.compactLayout === true;
  const metrics = diagramLayoutMetrics(diagram);
  return diagram.boxes
    .filter((box) => {
      if (requiredBoxHeight(box, compact) > box.h + 0.5) {
        return true;
      }
      if (measureText(box.title, metrics.titleSize) > titleMaxWidth(box)) {
        return true;
      }
      return box.lines.some((line) => measureText(line, metrics.bodySize) > bodyMaxWidth(box));
    })
    .map((box) => box.id);
};

export const boxesCollidingWithLaneTitles = (diagram: ArchitectureDiagram): string[] => {
  const hits: string[] = [];
  for (const lane of diagram.lanes) {
    const titleRect = { x: lane.x, y: lane.y, w: lane.w, h: LANE_TITLE_HEIGHT };
    for (const box of diagram.boxes) {
      if (rectsOverlap(box, titleRect)) {
        hits.push(`${box.id}@${lane.id}`);
      }
    }
  }
  return hits;
};

export const boxAnchor = (box: ArchitectureBox, other: ArchitectureBox): Point => {
  const fromCx = box.x + box.w / 2;
  const fromCy = box.y + box.h / 2;
  const toCx = other.x + other.w / 2;
  const toCy = other.y + other.h / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: dx > 0 ? box.x + box.w : box.x, y: fromCy };
  }
  return { x: fromCx, y: dy > 0 ? box.y + box.h : box.y };
};

export const routeEdge = (
  from: ArchitectureBox,
  to: ArchitectureBox,
  edge: ArchitectureEdge,
  diagram: ArchitectureDiagram,
): { d: string; labelAt: Point; segments: Segment[] } => {
  const start = boxAnchor(from, to);
  const end = boxAnchor(to, from);
  if (edge.via === "vertical") {
    const start = { x: from.x + from.w / 2, y: from.y + from.h };
    const end = { x: to.x + to.w / 2, y: to.y };
    const midY = edge.corridorY ?? (start.y + end.y) / 2;
    return {
      d: `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`,
      labelAt: { x: (start.x + end.x) / 2, y: midY },
      segments: [
        { a: start, b: { x: start.x, y: midY } },
        { a: { x: start.x, y: midY }, b: { x: end.x, y: midY } },
        { a: { x: end.x, y: midY }, b: end },
      ],
    };
  }
  if (edge.via === "top") {
    const y = edge.corridorY ?? diagram.corridorY ?? Math.min(from.y, to.y) - 28;
    return {
      d: `M ${start.x} ${start.y} L ${start.x} ${y} L ${end.x} ${y} L ${end.x} ${end.y}`,
      labelAt: { x: (start.x + end.x) / 2, y },
      segments: [
        { a: start, b: { x: start.x, y } },
        { a: { x: start.x, y }, b: { x: end.x, y } },
        { a: { x: end.x, y }, b: end },
      ],
    };
  }
  if (edge.via === "gutter" && typeof diagram.gutterX === "number") {
    const x = diagram.gutterX;
    return {
      d: `M ${start.x} ${start.y} L ${x} ${start.y} L ${x} ${end.y} L ${end.x} ${end.y}`,
      labelAt: { x, y: (start.y + end.y) / 2 },
      segments: [
        { a: start, b: { x, y: start.y } },
        { a: { x, y: start.y }, b: { x, y: end.y } },
        { a: { x, y: end.y }, b: end },
      ],
    };
  }
  if (edge.via === "boundary" && typeof diagram.boundaryX === "number") {
    const x = diagram.boundaryX;
    const labelY = diagram.bands?.[0] ? diagram.bands[0].y + 28 : (start.y + end.y) / 2;
    return {
      d: `M ${start.x} ${start.y} L ${x} ${start.y} L ${x} ${end.y} L ${end.x} ${end.y}`,
      labelAt: { x, y: labelY },
      segments: [
        { a: start, b: { x, y: start.y } },
        { a: { x, y: start.y }, b: { x, y: end.y } },
        { a: { x, y: end.y }, b: end },
      ],
    };
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = start.x + dx / 2;
    return {
      d: `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`,
      labelAt: { x: midX, y: (start.y + end.y) / 2 },
      segments: [
        { a: start, b: { x: midX, y: start.y } },
        { a: { x: midX, y: start.y }, b: { x: midX, y: end.y } },
        { a: { x: midX, y: end.y }, b: end },
      ],
    };
  }
  const midY = start.y + dy / 2;
  return {
    d: `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`,
    labelAt: { x: (start.x + end.x) / 2, y: midY },
    segments: [
      { a: start, b: { x: start.x, y: midY } },
      { a: { x: start.x, y: midY }, b: { x: end.x, y: midY } },
      { a: { x: end.x, y: midY }, b: end },
    ],
  };
};

const insetRect = (
  box: { x: number; y: number; w: number; h: number },
  pad: number,
): { x: number; y: number; w: number; h: number } => ({
  x: box.x + pad,
  y: box.y + pad,
  w: Math.max(0, box.w - pad * 2),
  h: Math.max(0, box.h - pad * 2),
});

const segmentHitsRect = (
  segment: Segment,
  rect: { x: number; y: number; w: number; h: number },
): boolean => {
  if (rect.w <= 0 || rect.h <= 0) {
    return false;
  }
  const minX = Math.min(segment.a.x, segment.b.x);
  const maxX = Math.max(segment.a.x, segment.b.x);
  const minY = Math.min(segment.a.y, segment.b.y);
  const maxY = Math.max(segment.a.y, segment.b.y);
  const horizontal = Math.abs(segment.a.y - segment.b.y) < 0.5;
  if (horizontal) {
    return (
      segment.a.y > rect.y &&
      segment.a.y < rect.y + rect.h &&
      maxX > rect.x &&
      minX < rect.x + rect.w
    );
  }
  const vertical = Math.abs(segment.a.x - segment.b.x) < 0.5;
  if (vertical) {
    return (
      segment.a.x > rect.x &&
      segment.a.x < rect.x + rect.w &&
      maxY > rect.y &&
      minY < rect.y + rect.h
    );
  }
  return false;
};

export const edgesCrossingForeignBoxes = (diagram: ArchitectureDiagram): string[] => {
  const hits: string[] = [];
  const boxes = new Map(diagram.boxes.map((box) => [box.id, box]));
  for (const edge of diagram.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) {
      continue;
    }
    const routed = routeEdge(from, to, edge, diagram);
    for (const box of diagram.boxes) {
      if (box.id === from.id || box.id === to.id) {
        continue;
      }
      if (routed.segments.some((segment) => segmentHitsRect(segment, insetRect(box, 8)))) {
        hits.push(`${edge.from}->${edge.to}@${box.id}`);
      }
    }
  }
  return hits;
};

const converterLabel = (model: ConverterModel): string => {
  switch (model) {
    case "zenz-v3.2-xsmall-gguf":
      return "Zenzai v3.2 xsmall";
    case "zenz-v3.2-small-gguf":
      return "Zenzai v3.2 small";
    default:
      return "AzooKey Rust WASM";
  }
};

const placeBox = (box: Omit<ArchitectureBox, "h">): ArchitectureBox => ({
  ...box,
  h: requiredBoxHeight(box),
});

export const overviewArchitecture = (): ArchitectureDiagram => {
  const width = 680;
  const marginX = 8;
  const rowGap = 18;
  const colGap = 9;
  const rowY = 12;
  const [browser, access, compare] = layoutRow(marginX, rowY, colGap, [
    {
      id: "browser",
      w: 132,
      title: "① ブラウザ",
      lines: ["Web Speech 認識"],
      tone: "browser",
      artifact: "runtime",
    },
    {
      id: "access",
      w: 168,
      title: "② Access",
      lines: ["OTP + Managed OAuth", "teadea"],
      tone: "io",
      artifact: "runtime",
    },
    {
      id: "compare",
      w: 340,
      title: "③ compare Cloudflare Worker",
      lines: [COMPARE_WORKER_ORIGIN, "Access JWT + static Next export"],
      tone: "worker",
      artifact: "runtime",
    },
  ]);
  const ingressBottom = Math.max(browser.y + browser.h, access.y + access.h, compare.y + compare.h);
  const forkY = ingressBottom + rowGap;
  const corridorY = ingressBottom + rowGap / 2;
  const [browserComplete, workerWs, inference] = layoutRow(marginX, forkY, colGap, [
    {
      id: "browser-complete",
      w: 213,
      title: "ブラウザ完結",
      lines: [
        "Vibrato WASM + AzooKey WASM",
        "in-page /ws/azookey なし",
        `Zenzai: ${ARCHITECTURE_DICTIONARIES.azookey.file}`,
        "LOUDS 辞書のみ / GGUF なし",
      ],
      tone: "browser",
      artifact: "code",
      cost: "cpu",
    },
    {
      id: "worker-ws",
      w: 196,
      title: "worker-vibrato",
      lines: ["Cloudflare Worker 依存", "/ws/azookey → INFERENCE"],
      tone: "worker",
      artifact: "runtime",
    },
    {
      id: "inference",
      w: 238,
      title: "kotoba-beacon-inference",
      lines: [
        "Cloudflare Worker（推論）",
        "workers.dev 無し",
        "AzooKey WASM + LOUDS dict",
        `${ARCHITECTURE_ZENZAI.env} → Zenzai GGUF`,
        "未設定 → LOUDS dict フォールバック",
      ],
      tone: "worker",
      artifact: "runtime",
      cost: "model",
    },
  ]);
  const height =
    Math.max(browserComplete.y + browserComplete.h, workerWs.y + workerWs.h, inference.y + inference.h) +
    16;

  return {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    corridorY,
    lanes: [],
    boxes: [browser, access, compare, browserComplete, workerWs, inference],
    edges: [
      { from: "browser", to: "access", path: "internet" },
      { from: "access", to: "compare", path: "internet" },
      {
        from: "compare",
        to: "browser-complete",
        path: "device",
        via: "vertical",
        corridorY,
      },
      {
        from: "compare",
        to: "worker-ws",
        path: "device",
        via: "vertical",
        corridorY,
      },
      { from: "worker-ws", to: "inference", path: "device", label: "INFERENCE" },
    ],
  };
};

export const modeArchitecture = (
  mode: ComparisonMode,
  browserWasmConfigured: boolean,
  converterModel: ConverterModel,
): ArchitectureDiagram => {
  const modelName = converterLabel(converterModel);
  const zenz = isZenzConverterModel(converterModel);
  const ipadicOk = mode !== "browser-vibrato" || browserWasmConfigured;
  const width = 680;
  const boxW = 300;
  const stackY = MODE_STACK_Y;
  const worker = mode === "worker-vibrato";
  const zenzSize =
    converterModel === "zenz-v3.2-small-gguf"
      ? ARCHITECTURE_ZENZAI.small.size
      : ARCHITECTURE_ZENZAI.xsmall.size;
  const reading = layoutStack(
    20,
    stackY,
    boxW,
    0,
    [
      {
        id: "vib",
        title: worker ? "Cloudflare Worker（推論）Vibrato" : "ブラウザ Vibrato",
        lines: worker
          ? ["/ws/azookey → INFERENCE", "kotoba-beacon-inference", "workers.dev 無し"]
          : [
              "/vibrato/vibrato_wasm.js",
              ARCHITECTURE_DICTIONARIES.ipadic.browserUrl,
              ipadicOk
                ? "WASM/辞書 OK · /ws/azookey なし"
                : "WASM/辞書が利用不可 · /ws/azookey なし",
            ],
        tone: worker ? "worker" : ipadicOk ? "browser" : "warn",
        artifact: worker ? "runtime" : "code",
        badge: worker ? undefined : ipadicOk ? undefined : "未設定",
      },
    ],
    true,
  );
  const convert = layoutStack(
    360,
    stackY,
    boxW,
    0,
    [
      {
        id: "model",
        title: zenz && !worker ? ARCHITECTURE_ZENZAI.browserDictLabel : modelName,
        lines: worker
          ? zenz
            ? [
                converterModel,
                `${ARCHITECTURE_ZENZAI.env} → Zenzai GGUF · ${zenzSize}`,
                `${ARCHITECTURE_ZENZAI.loader} · ${ARCHITECTURE_ZENZAI.file}`,
                "Cloudflare Worker 依存（推論）",
                "未設定 → inference LOUDS dict",
              ]
            : [
                converterModel,
                ARCHITECTURE_DICTIONARIES.azookey.workerUrl,
                "かな漢字 · 公開 URL なし",
              ]
          : zenz
            ? [
                converterModel,
                ARCHITECTURE_DICTIONARIES.azookey.browserUrl,
                "LOUDS 辞書のみ · GGUF 推論なし",
              ]
            : [converterModel, "/azookey/azookey.wasm", "in-page かな漢字 · /ws/azookey なし"],
        tone: zenz ? (worker ? "model" : "browser") : worker ? "worker" : "browser",
        artifact: zenz ? (worker ? "model" : "dict") : "code",
        size:
          zenz && worker
            ? zenzSize
            : worker
              ? ARCHITECTURE_ASSET_SIZES.azookeyWasm
              : ARCHITECTURE_ASSET_SIZES.azkdictGz,
        badge: zenz && !worker ? "辞書のみ" : undefined,
      },
    ],
    true,
  );
  const bottom = Math.max(...[...reading, ...convert].map((box) => box.y + box.h));
  return {
    viewBox: `0 0 ${width} ${bottom + MODE_BOTTOM_PAD}`,
    width,
    height: bottom + MODE_BOTTOM_PAD,
    compactLayout: true,
    boxes: [...reading, ...convert],
    lanes: [],
    edges: [{ from: "vib", to: "model", path: "device" }],
  };
};

export const architectureDiagramCaption = (
  kind: ArchitectureDiagramKind,
  mode: ComparisonMode = "worker-vibrato",
): string =>
  kind === "overview"
    ? "Cloudflare Workers 本番構成"
    : mode === "browser-vibrato"
      ? "ブラウザ完結の実行経路"
      : "Cloudflare Worker 依存の実行経路";

export const architectureDiagram = (options: ArchitectureDiagramOptions): ArchitectureDiagram => {
  if (options.kind === "overview") {
    return overviewArchitecture();
  }
  return modeArchitecture(
    options.mode ?? "worker-vibrato",
    options.browserWasmConfigured !== false,
    options.converterModel ?? DEFAULT_CONVERTER_MODEL,
  );
};

export const architectureDiagramText = (diagram: ArchitectureDiagram): string =>
  [
    ...(diagram.bands ?? []).flatMap((band) => [band.title, band.subtitle]),
    ...diagram.lanes.map((lane) => lane.title),
    ...diagram.boxes.flatMap((box) => [
      box.title,
      box.badge ?? "",
      box.artifact ?? "",
      box.cost ?? "",
      box.size ?? "",
      ...box.lines,
    ]),
    ...diagram.edges.flatMap((edge) => [edge.from, edge.to, edge.label ?? "", edge.path ?? ""]),
  ].join("\n");
