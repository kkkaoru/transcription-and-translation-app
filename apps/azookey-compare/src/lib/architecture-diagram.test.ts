import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_ZENZAI,
  architectureDiagram,
  architectureDiagramCaption,
  architectureDiagramText,
  boxesCollidingWithLaneTitles,
  edgesCrossingForeignBoxes,
  modeArchitecture,
  overflowingBoxIds,
  overlappingBoxIds,
  overviewArchitecture,
} from "./architecture-diagram";
import { COMPARE_WORKER_ORIGIN } from "./inference-proxy";

const overviewTerms = [
  "Web Speech",
  "Access",
  "OTP + Managed OAuth",
  COMPARE_WORKER_ORIGIN,
  "static Next export",
  "JWT",
  "ブラウザ完結",
  "/ws/azookey なし",
  "Cloudflare Worker 依存",
  "Cloudflare Worker（推論）",
  "compare Cloudflare Worker",
  "worker-vibrato",
  "/ws/azookey",
  "INFERENCE",
  "kotoba-beacon-inference",
  "workers_dev false",
  "公開 URL なし",
  "Zenzai GGUF 推論",
  ARCHITECTURE_ZENZAI.loader,
  ARCHITECTURE_ZENZAI.file,
  ARCHITECTURE_ZENZAI.note,
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
    expect(text).toContain("Vibrato WASM");
    expect(text).toContain("AzooKey WASM");
    expect(overview.width).toBeLessThanOrEqual(720);
    expect(overview.bands).toBeUndefined();
    expect(overview.lanes).toEqual([]);
    expect(overview.boxes.map((box) => box.id)).toEqual([
      "browser",
      "access",
      "compare",
      "browser-complete",
      "worker-ws",
      "inference",
      "zenz",
    ]);
    expect(overview.boxes.some((box) => box.artifact === "code")).toBe(true);
    expect(overview.boxes.some((box) => box.cost === "model")).toBe(true);
    expect(overview.edges.some((edge) => edge.path === "internet")).toBe(true);
    expect(overview.edges.some((edge) => edge.dashed)).toBe(true);
    expect(overview.edges.some((edge) => edge.label === "INFERENCE")).toBe(true);
    expect(architectureDiagramCaption("overview")).toBe("Cloudflare Workers 本番構成");
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
      expect(diagram.width).toBeLessThanOrEqual(720);
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
    expect(architectureDiagramCaption("mode", "worker-vibrato")).toBe("Cloudflare Worker 依存の実行経路");

    const zenz = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
    );
    expect(zenz).toContain("zenz-v3.2-xsmall-gguf");
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.file);
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.xsmall.size);
    expect(zenz).toContain("Cloudflare Worker 依存（推論）");

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
    expect(architectureDiagramCaption("mode", "browser-vibrato")).toBe("ブラウザ完結の実行経路");
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
    expect(architectureDiagram({ kind: "overview" }).boxes).toHaveLength(7);
    const mode = architectureDiagram({
      kind: "mode",
      mode: "browser-vibrato",
      browserWasmConfigured: true,
      converterModel: "zenz-v3.2-small-gguf",
    });
    expect(architectureDiagramText(mode)).toContain("zenz-v3.2-small-gguf");
  });
});
