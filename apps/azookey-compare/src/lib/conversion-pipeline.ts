/**
 * Comparison conversion pipeline.
 *
 * `browser-vibrato` (ブラウザ完結) runs Vibrato then AzooKey entirely in the
 * browser and never opens `/ws/azookey`. `worker-vibrato` still uses inference.
 */

import { shouldRunBrowserVibratoPrePass } from "./azookey-reading";
import type { BrowserAzookeyResult } from "./browser-azookey";
import type { BrowserVibratoConfig, BrowserVibratoResult } from "./browser-vibrato";
import type { ComparisonAuth, ComparisonMode } from "./contract";
import { elapsedSinceMs, nowMs } from "./conversion-timing";
import type { ConverterModel } from "./converter-models";
import { isZenzConverterModel } from "./converter-models";
import type { ConversionStage } from "./path-labels";
import type { AzooKeyConvertResult, VibratoExecution } from "./worker-client";

export const BROWSER_COMPACT_ZENZ_UNSUPPORTED_MESSAGE =
  "ブラウザ完結では Zenzai は使えません。AzooKey WASM を選ぶか Cloudflare Worker 依存モードに切り替えてください。";

export const usesWorkerConversion = (mode: ComparisonMode): boolean => mode === "worker-vibrato";

export interface ConversionPipelineInput {
  sourceText: string;
  mode: ComparisonMode;
  converterModel: ConverterModel;
  language: string;
  auth: ComparisonAuth;
  phoneticInput?: string;
  wasmModuleUrl?: string;
  dictionaryUrl?: string;
  wasmGlobalName?: string;
}

export interface ConversionPipelineResult {
  convertedText: string;
  vibratoInput: string;
  wasmElapsedMs?: number;
  azookeyElapsedMs?: number;
  workerElapsedMs?: number;
  /** Browser-side wall clock: Vibrato + AzooKey + Worker round-trip. */
  totalElapsedMs: number;
  usedWebSocket: boolean;
  ranBrowserVibrato: boolean;
  vibratoExecution: VibratoExecution;
  model?: string;
  requestedModel?: string;
  modelFallback?: string;
}

export interface ConversionWorkerRequest {
  source: "web-speech";
  language: string;
  sourceText: string;
  vibratoInput: string;
  mode: ComparisonMode;
  model?: string;
  vibratoExecution: VibratoExecution;
  auth?: ComparisonAuth;
}

export interface ConversionPipelineDependencies {
  runBrowserVibrato: (text: string, options: BrowserVibratoConfig) => Promise<BrowserVibratoResult>;
  runBrowserAzookey: (text: string) => Promise<BrowserAzookeyResult>;
  connectWorker?: () => Promise<void>;
  convertWithWorker?: (request: ConversionWorkerRequest) => Promise<AzooKeyConvertResult>;
  onStage?: (stage: ConversionStage) => void;
}

export const runComparisonConversion = async (
  input: ConversionPipelineInput,
  deps: ConversionPipelineDependencies,
): Promise<ConversionPipelineResult> => {
  const startedAt = nowMs();
  const sourceText = input.sourceText.trim();
  const phonetic = input.phoneticInput?.trim();
  let vibratoInput = phonetic || sourceText;
  let wasmElapsedMs: number | undefined;
  let ranBrowserVibrato = false;
  deps.onStage?.("setup");

  if (input.mode === "browser-vibrato" && isZenzConverterModel(input.converterModel)) {
    throw new Error(BROWSER_COMPACT_ZENZ_UNSUPPORTED_MESSAGE);
  }

  if (
    input.mode === "worker-vibrato" &&
    input.auth.scheme === "bearer" &&
    !input.auth.token?.trim()
  ) {
    throw new Error("Bearer token を入力してください");
  }

  if (shouldRunBrowserVibratoPrePass(input.mode, sourceText, phonetic)) {
    deps.onStage?.("browser-wasm");
    try {
      const wasmResult = await deps.runBrowserVibrato(sourceText, {
        moduleUrl: input.wasmModuleUrl ?? "",
        dictionaryUrl: input.dictionaryUrl,
        globalName: input.wasmGlobalName,
      });
      vibratoInput = wasmResult.text;
      wasmElapsedMs = wasmResult.elapsedMs;
      ranBrowserVibrato = true;
    } catch (error) {
      if (input.mode === "browser-vibrato") {
        throw error;
      }
      vibratoInput = sourceText;
    }
  }

  const vibratoExecution: VibratoExecution = phonetic
    ? "worker"
    : ranBrowserVibrato || input.mode === "browser-vibrato"
      ? "browser-wasm"
      : "worker";

  if (input.mode === "browser-vibrato") {
    deps.onStage?.("browser-azookey");
    const azookey = await deps.runBrowserAzookey(vibratoInput);
    return {
      convertedText: azookey.text,
      vibratoInput,
      wasmElapsedMs,
      azookeyElapsedMs: azookey.elapsedMs,
      totalElapsedMs: elapsedSinceMs(startedAt),
      usedWebSocket: false,
      ranBrowserVibrato,
      vibratoExecution,
      model: "azookey-rust-wasm",
    };
  }

  if (!deps.connectWorker || !deps.convertWithWorker) {
    throw new Error("Cloudflare Worker WebSocket クライアントを初期化できません");
  }
  deps.onStage?.("worker-connect");
  await deps.connectWorker();
  deps.onStage?.("worker");
  const result = await deps.convertWithWorker({
    source: "web-speech",
    language: input.language,
    sourceText,
    vibratoInput,
    mode: phonetic ? "worker-vibrato" : input.mode,
    model: input.converterModel,
    vibratoExecution,
    auth: input.auth,
  });
  return {
    convertedText: result.convertedText,
    vibratoInput,
    wasmElapsedMs,
    workerElapsedMs: result.elapsedMs,
    totalElapsedMs: elapsedSinceMs(startedAt),
    usedWebSocket: true,
    ranBrowserVibrato,
    vibratoExecution,
    model: result.model,
    requestedModel: result.requestedModel,
    modelFallback: result.modelFallback,
  };
};
