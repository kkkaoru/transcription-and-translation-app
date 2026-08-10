import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DIAGRAM_MAX_WIDTH,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_ZENZAI,
  architectureDiagram,
  architectureDiagramCaption,
  architectureDiagramText,
  boxesCollidingWithLaneTitles,
  edgesCrossingForeignBoxes,
  MODE_DIAGRAM_PREVIOUS_HEIGHT,
  modeArchitecture,
  OVERVIEW_DIAGRAM_PREVIOUS_HEIGHT,
  overflowingBoxIds,
  overlappingBoxIds,
  overviewArchitecture,
} from "./architecture-diagram";
import type { ComparisonMode } from "./contract";
import type { ConverterModel } from "./converter-models";
import { COMPARE_WORKER_ORIGIN, COMPARE_WORKERS_AI_ASR_PATH } from "./inference-proxy";

const overviewTerms = [
  "Access",
  "OTP + Managed OAuth",
  "teadea + avita",
  COMPARE_WORKER_ORIGIN,
  "compare Cloudflare Worker",
  "Access JWT",
  "static Next export",
  "ブラウザ完結",
  "/ws/azookey なし",
  "Cloudflare Worker 依存",
  "Cloudflare Worker（推論）",
  "worker-vibrato",
  "/ws/azookey",
  "INFERENCE",
  "kotoba-beacon-inference",
  "workers.dev 無し",
  "AzooKey WASM",
  ARCHITECTURE_DICTIONARIES.azookey.file,
  "LOUDS",
  ARCHITECTURE_ZENZAI.env,
  "Zenzai GGUF",
  "LOUDS dict フォールバック",
];

const assertOverviewLayout = (overview: ReturnType<typeof overviewArchitecture>) => {
  expect(overview.width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
  expect(overview.height).toBeLessThan(OVERVIEW_DIAGRAM_PREVIOUS_HEIGHT);
  expect(overview.viewBox.startsWith("0 0 680 ")).toBe(true);
  expect(overview.bands).toBeUndefined();
  expect(overview.lanes).toEqual([]);
  expect(overview.boxes.map((box) => box.id)).toEqual([
    "browser",
    "access",
    "compare",
    "browser-complete",
    "worker-ws",
    "inference",
  ]);
  expect(overlappingBoxIds(overview)).toEqual([]);
  expect(overflowingBoxIds(overview)).toEqual([]);
  expect(boxesCollidingWithLaneTitles(overview)).toEqual([]);
  expect(edgesCrossingForeignBoxes(overview)).toEqual([]);
};

describe("architecture SVG diagram models", () => {
  it("overview matches hosted Cloudflare Workers compare + inference", () => {
    const overview = overviewArchitecture();
    const text = architectureDiagramText(overview);
    for (const term of overviewTerms) {
      expect(text).toContain(term);
    }
    expect(text).not.toContain("Tauri");
    expect(text).not.toContain("ブラウザ簡潔");
    expect(text).not.toContain("Service Worker");
    expect(text).toContain("Vibrato WASM");
    expect(text).toContain("Web Speech API のみ");
    expect(text).toContain("Silero ONNX / ORT WASM なし");
    expect(text).not.toContain("silero_vad.onnx");
    expect(text).not.toContain(COMPARE_WORKERS_AI_ASR_PATH);
    expect(text).not.toContain("Cloudflare Workers AI Nova-3 ASR");
    expect(overview.boxes.some((box) => box.artifact === "code")).toBe(true);
    expect(overview.boxes.some((box) => box.cost === "model")).toBe(true);
    expect(overview.edges.some((edge) => edge.path === "internet")).toBe(true);
    expect(overview.edges.some((edge) => edge.label === "INFERENCE")).toBe(true);
    expect(overview.edges.some((edge) => edge.from === "compare" && edge.to === "inference")).toBe(
      false,
    );
    expect(architectureDiagramCaption("overview")).toBe(
      "compare / inference Cloudflare Worker 本番構成",
    );
    assertOverviewLayout(overview);
  });

  it("overview Workers AI ASR draws Silero → transcriptions → Nova-3 boxes and edges", () => {
    const overview = overviewArchitecture("workers-ai-asr");
    const text = architectureDiagramText(overview);
    const browser = overview.boxes.find((box) => box.id === "browser");
    const compare = overview.boxes.find((box) => box.id === "compare");
    const inference = overview.boxes.find((box) => box.id === "inference");
    for (const term of overviewTerms) {
      expect(text).toContain(term);
    }
    expect(browser?.lines).toEqual([
      "Silero VAD v6（ONNX + ORT WASM）",
      "発話切り出し",
      ARCHITECTURE_DICTIONARIES.silero.browserUrl,
    ]);
    expect(compare?.lines).toContain(`POST ${COMPARE_WORKERS_AI_ASR_PATH}（Access JWT）`);
    expect(inference?.lines).toContain("Cloudflare Workers AI Nova-3 ASR");
    expect(inference?.lines).toContain("@cf/deepgram/nova-3 · env.AI.run");
    expect(text).toContain("Silero VAD v6");
    expect(text).toContain("/models/silero_vad_v6/silero_vad.onnx");
    expect(text).toContain(COMPARE_WORKERS_AI_ASR_PATH);
    expect(text).toContain("Nova-3");
    expect(text).not.toContain("Web Speech API のみ");
    expect(overview.edges).toContainEqual({
      from: "compare",
      to: "inference",
      path: "internet",
      via: "gutter",
      label: "Cloudflare Workers AI ASR",
    });
    expect(overview.edges.some((edge) => edge.label === "INFERENCE")).toBe(true);
    expect(
      overview.edges.some((edge) => edge.from === "compare" && edge.to === "browser-complete"),
    ).toBe(true);
    assertOverviewLayout(overview);
  });

  it("overview Web Speech does not claim Silero is running", () => {
    const overview = overviewArchitecture("web-speech");
    const text = architectureDiagramText(overview);
    expect(text).toContain("Web Speech API のみ");
    expect(text).toContain("Silero ONNX / ORT WASM なし");
    expect(text).not.toContain("silero_vad.onnx");
    expect(text).not.toContain("発話切り出し");
    expect(text).not.toContain(COMPARE_WORKERS_AI_ASR_PATH);
    expect(text).not.toContain("@cf/deepgram/nova-3");
    expect(overview.edges.some((edge) => edge.label === "Cloudflare Workers AI ASR")).toBe(false);
  });

  it("keeps diagram within viewport width and hides horizontal overflow", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.path-diagram-svg\s*\{[\s\S]*overflow-x:\s*hidden/);
    expect(overviewArchitecture().width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
    expect(overviewArchitecture("workers-ai-asr").width).toBeLessThanOrEqual(
      ARCHITECTURE_DIAGRAM_MAX_WIDTH,
    );
  });

  it("keeps mode diagrams compact without horizontal overflow", () => {
    const modeCases: Array<[ComparisonMode, boolean, ConverterModel]> = [
      ["worker-vibrato", true, "azookey-rust-wasm"],
      ["worker-vibrato", true, "zenz-v3.2-xsmall-gguf"],
      ["worker-vibrato", true, "zenz-v3.2-small-gguf"],
      ["browser-vibrato", false, "azookey-rust-wasm"],
      ["browser-vibrato", true, "azookey-rust-wasm"],
      ["browser-vibrato", true, "zenz-v3.2-xsmall-gguf"],
      ["browser-vibrato", true, "zenz-v3.2-small-gguf"],
    ];
    for (const [mode, browserWasmConfigured, converterModel] of modeCases) {
      const diagram = modeArchitecture(mode, browserWasmConfigured, converterModel);
      expect(diagram.compactLayout).toBe(true);
      expect(diagram.width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
      expect(diagram.height).toBeLessThan(MODE_DIAGRAM_PREVIOUS_HEIGHT);
      const asrDiagram = modeArchitecture(
        mode,
        browserWasmConfigured,
        converterModel,
        "workers-ai-asr",
      );
      expect(asrDiagram.boxes.some((box) => box.id === "asr")).toBe(true);
      expect(architectureDiagramText(asrDiagram)).toContain("Silero VAD v6");
      expect(architectureDiagramText(asrDiagram)).toContain(
        "/models/silero_vad_v6/silero_vad.onnx",
      );
      expect(architectureDiagramText(asrDiagram)).toContain(COMPARE_WORKERS_AI_ASR_PATH);
      expect(asrDiagram.edges).toContainEqual({
        from: "asr",
        to: "vib",
        path: "device",
        via: "vertical",
      });
      expect(
        asrDiagram.edges.some(
          (edge) => edge.from === "asr" && edge.to === "vib" && edge.path === "internet",
        ),
      ).toBe(false);
      expect(architectureDiagramText(diagram)).toContain("Web Speech API");
      expect(architectureDiagramText(diagram)).toContain("Silero ONNX / ORT WASM なし");
      expect(architectureDiagramText(diagram)).not.toContain("silero_vad.onnx");
      expect(asrDiagram.height).toBeLessThan(MODE_DIAGRAM_PREVIOUS_HEIGHT + 80);
    }
  });

  it("keeps boxes and edges readable without overlap or wrap", () => {
    const diagrams = [
      overviewArchitecture(),
      overviewArchitecture("web-speech"),
      overviewArchitecture("workers-ai-asr"),
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm"),
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm", "workers-ai-asr"),
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
      modeArchitecture("browser-vibrato", false, "azookey-rust-wasm"),
      modeArchitecture("browser-vibrato", true, "zenz-v3.2-small-gguf"),
      modeArchitecture("browser-vibrato", true, "zenz-v3.2-small-gguf", "workers-ai-asr"),
    ];
    for (const diagram of diagrams) {
      expect(diagram.width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
      expect(overlappingBoxIds(diagram)).toEqual([]);
      expect(overflowingBoxIds(diagram)).toEqual([]);
      expect(boxesCollidingWithLaneTitles(diagram)).toEqual([]);
      expect(edgesCrossingForeignBoxes(diagram)).toEqual([]);
      expect(architectureDiagramText(diagram)).not.toContain("Tauri");
      expect(architectureDiagramText(diagram)).not.toContain("ブラウザ簡潔");
    }
  });

  it("mode diagrams include the selected converter and IPADIC warning", () => {
    const worker = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm"),
    );
    expect(worker).toContain("Cloudflare Worker（推論）Vibrato");
    expect(worker).toContain("azookey-rust-wasm");
    expect(worker).toContain("system.azkdict.gz");
    expect(worker).toContain("INFERENCE");
    expect(worker).toContain("kotoba-beacon-inference");
    expect(worker).toContain("公開 URL なし");
    expect(architectureDiagramCaption("mode", "worker-vibrato")).toBe(
      "Web Speech + Cloudflare Worker 依存の実行経路",
    );
    expect(
      architectureDiagramText(modeArchitecture("worker-vibrato", true, "azookey-rust-wasm")),
    ).toContain("Silero ONNX / ORT WASM なし");
    expect(
      architectureDiagramText(
        modeArchitecture("worker-vibrato", true, "azookey-rust-wasm", "workers-ai-asr"),
      ),
    ).toContain("ブラウザ Silero VAD v6");

    const zenz = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
    );
    expect(zenz).toContain("zenz-v3.2-xsmall-gguf");
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.file);
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.xsmall.size);
    expect(zenz).toContain("Cloudflare Worker 依存（推論）");
    expect(zenz).toContain("inference LOUDS dict");

    const small = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-small-gguf"),
    );
    expect(small).toContain(ARCHITECTURE_ZENZAI.small.size);

    const browser = architectureDiagramText(
      modeArchitecture("browser-vibrato", false, "azookey-rust-wasm"),
    );
    expect(browser).toContain("ブラウザ Vibrato");
    expect(browser).toContain("未設定");
    expect(browser).toContain("vibrato_wasm.js");
    expect(browser).toContain("利用不可");
    expect(browser).toContain("/ws/azookey なし");
    expect(browser).toContain(ARCHITECTURE_DICTIONARIES.ipadic.browserUrl);
    expect(architectureDiagramCaption("mode", "browser-vibrato")).toBe(
      "Web Speech + ブラウザ完結の実行経路",
    );
    expect(architectureDiagramCaption("mode", "worker-vibrato", "workers-ai-asr")).toBe(
      "Cloudflare Workers AI ASR + Cloudflare Worker 依存の実行経路",
    );
    expect(ARCHITECTURE_ASSET_SIZES.ipadicZst).toMatch(/MB/);

    const browserZenz = architectureDiagramText(
      modeArchitecture("browser-vibrato", true, "zenz-v3.2-xsmall-gguf"),
    );
    expect(browserZenz).toContain(ARCHITECTURE_ZENZAI.browserDictLabel);
    expect(browserZenz).toContain(ARCHITECTURE_DICTIONARIES.azookey.browserUrl);
    expect(browserZenz).toContain("LOUDS 辞書のみ");
    expect(browserZenz).toContain("GGUF 推論なし");
    expect(browserZenz).toContain("辞書のみ");
  });

  it("architectureDiagram dispatches kinds", () => {
    expect(architectureDiagram({ kind: "overview" }).boxes).toHaveLength(6);
    expect(architectureDiagramText(architectureDiagram({ kind: "overview" }))).toContain(
      "Web Speech API のみ",
    );
    expect(
      architectureDiagramText(
        architectureDiagram({ kind: "overview", recognitionProvider: "workers-ai-asr" }),
      ),
    ).toContain("Silero VAD v6");
    expect(
      architectureDiagramText(
        architectureDiagram({ kind: "overview", recognitionProvider: "web-speech" }),
      ),
    ).not.toContain("silero_vad.onnx");
    const mode = architectureDiagram({
      kind: "mode",
      mode: "browser-vibrato",
      browserWasmConfigured: true,
      converterModel: "zenz-v3.2-small-gguf",
    });
    expect(architectureDiagramText(mode)).toContain("zenz-v3.2-small-gguf");
  });
});
