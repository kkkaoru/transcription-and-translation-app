import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ComparisonMode } from "./contract";
import type { ConverterModel } from "./converter-models";
import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_DIAGRAM_MAX_WIDTH,
  ARCHITECTURE_ZENZAI,
  architectureDiagram,
  architectureDiagramCaption,
  architectureDiagramText,
  boxesCollidingWithLaneTitles,
  edgesCrossingForeignBoxes,
  MODE_DIAGRAM_PREVIOUS_HEIGHT,
  modeArchitecture,
  overflowingBoxIds,
  overlappingBoxIds,
  OVERVIEW_DIAGRAM_PREVIOUS_HEIGHT,
  overviewArchitecture,
} from "./architecture-diagram";
import { COMPARE_WORKER_ORIGIN } from "./inference-proxy";

const overviewTerms = [
  "Web Speech",
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
  "Workers AI Nova-3 ASR",
  "Workers AI ASR",
  "@cf/deepgram/nova-3",
];

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
    expect(overview.width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
    expect(overview.height).toBeLessThan(OVERVIEW_DIAGRAM_PREVIOUS_HEIGHT);
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
    expect(overview.boxes.some((box) => box.artifact === "code")).toBe(true);
    expect(overview.boxes.some((box) => box.cost === "model")).toBe(true);
    expect(overview.edges.some((edge) => edge.path === "internet")).toBe(true);
    expect(overview.edges.some((edge) => edge.label === "INFERENCE")).toBe(true);
    expect(overview.edges.some((edge) => edge.label === "Workers AI ASR")).toBe(true);
    expect(architectureDiagramCaption("overview")).toBe("Cloudflare Workers 本番構成");
  });

  it("keeps diagram within viewport width and hides horizontal overflow", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.path-diagram-svg\s*\{[^}]*overflow-x:\s*hidden/s);
    expect(overviewArchitecture().width).toBeLessThanOrEqual(ARCHITECTURE_DIAGRAM_MAX_WIDTH);
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
      const asrDiagram = modeArchitecture(mode, browserWasmConfigured, converterModel, "workers-ai-asr");
      expect(asrDiagram.boxes.some((box) => box.id === "asr")).toBe(true);
      expect(asrDiagram.height).toBeLessThan(MODE_DIAGRAM_PREVIOUS_HEIGHT + 80);
    }
  });

  it("keeps boxes and edges readable without overlap or wrap", () => {
    const diagrams = [
      overviewArchitecture(),
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm"),
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
      modeArchitecture("browser-vibrato", false, "azookey-rust-wasm"),
      modeArchitecture("browser-vibrato", true, "zenz-v3.2-small-gguf"),
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
      "Workers AI ASR + Cloudflare Worker 依存の実行経路",
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
    const mode = architectureDiagram({
      kind: "mode",
      mode: "browser-vibrato",
      browserWasmConfigured: true,
      converterModel: "zenz-v3.2-small-gguf",
    });
    expect(architectureDiagramText(mode)).toContain("zenz-v3.2-small-gguf");
  });
});
