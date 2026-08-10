import { describe, expect, it } from "vitest";
import {
  ARCHITECTURE_ASSET_SIZES,
  ARCHITECTURE_DICTIONARIES,
  ARCHITECTURE_ZENZAI,
  architectureDiagram,
  architectureDiagramText,
  boxesCollidingWithLaneTitles,
  edgesCrossingForeignBoxes,
  modeArchitecture,
  overflowingBoxIds,
  overlappingBoxIds,
  overviewArchitecture,
} from "./architecture-diagram";

const overviewTerms = [
  "Web Speech",
  "Vibrato",
  "AzooKey",
  "かな漢字",
  "ブラウザ簡潔",
  "Worker 依存",
  ARCHITECTURE_ZENZAI.loader,
  ARCHITECTURE_ZENZAI.file,
  ARCHITECTURE_ZENZAI.env,
  ARCHITECTURE_ZENZAI.endpoint,
  ARCHITECTURE_ZENZAI.note,
  "/ws/azookey",
];

describe("architecture SVG diagram models", () => {
  it("overview is a narrow fork without Tauri or bands", () => {
    const overview = overviewArchitecture();
    const text = architectureDiagramText(overview);
    for (const term of overviewTerms) {
      expect(text).toContain(term);
    }
    expect(text).not.toContain("Tauri");
    expect(text).toContain("失敗時");
    expect(text).toContain(`${ARCHITECTURE_ZENZAI.env}[model].baseUrl`);
    expect(text).toContain(`${ARCHITECTURE_ZENZAI.loader} が読む`);
    expect(overview.width).toBeLessThanOrEqual(720);
    expect(overview.bands).toBeUndefined();
    expect(overview.lanes).toEqual([]);
    expect(overview.boxes.map((box) => box.id)).toEqual([
      "speech",
      "b-vib",
      "w-ws",
      "w-azk",
      "z-gguf",
    ]);
    expect(overview.boxes.some((box) => box.artifact === "code")).toBe(true);
    expect(overview.boxes.some((box) => box.cost === "model")).toBe(true);
    expect(overview.edges.some((edge) => edge.path === "internet")).toBe(true);
    expect(overview.edges.some((edge) => edge.dashed)).toBe(true);
    expect(overview.gutterX).toBeGreaterThan(
      overview.boxes.find((box) => box.id === "b-vib")?.x ?? 0,
    );
  });

  it("keeps boxes and edges readable without overlap or wrap", () => {
    const diagrams = [
      overviewArchitecture(),
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm"),
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
      modeArchitecture("browser-vibrato", false, "azookey-rust-wasm"),
    ];
    for (const diagram of diagrams) {
      expect(diagram.width).toBeLessThanOrEqual(720);
      expect(overlappingBoxIds(diagram)).toEqual([]);
      expect(overflowingBoxIds(diagram)).toEqual([]);
      expect(boxesCollidingWithLaneTitles(diagram)).toEqual([]);
      expect(edgesCrossingForeignBoxes(diagram)).toEqual([]);
      expect(architectureDiagramText(diagram)).not.toContain("Tauri");
    }
  });

  it("mode diagrams include the selected converter and IPADIC warning", () => {
    const worker = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "azookey-rust-wasm"),
    );
    expect(worker).toContain("Worker Vibrato");
    expect(worker).toContain("azookey-rust-wasm");
    expect(worker).toContain("system.azkdict.gz");

    const zenz = architectureDiagramText(
      modeArchitecture("worker-vibrato", true, "zenz-v3.2-xsmall-gguf"),
    );
    expect(zenz).toContain("zenz-v3.2-xsmall-gguf");
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.file);
    expect(zenz).toContain(ARCHITECTURE_ZENZAI.xsmall.size);

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
    expect(browser).toContain(ARCHITECTURE_DICTIONARIES.ipadic.browserUrl);
    expect(ARCHITECTURE_ASSET_SIZES.ipadicZst).toMatch(/MB/);
  });

  it("architectureDiagram dispatches kinds", () => {
    expect(architectureDiagram({ kind: "overview" }).boxes).toHaveLength(5);
    const mode = architectureDiagram({
      kind: "mode",
      mode: "browser-vibrato",
      browserWasmConfigured: true,
      converterModel: "zenz-v3.2-small-gguf",
    });
    expect(architectureDiagramText(mode)).toContain("zenz-v3.2-small-gguf");
  });
});
