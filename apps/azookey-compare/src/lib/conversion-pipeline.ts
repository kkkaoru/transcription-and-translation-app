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
import {
  assembleConversionTrace,
  normalizeSourceText,
  type ConversionTrace,
} from "./conversion-trace";
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
  /** Per-step inputs/outputs for utterance comparison cards. */
  trace: ConversionTrace;
  /** Flat step list (`trace.steps`) for callers that only need the timeline. */
  steps: ConversionTrace["steps"];
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
  const rawSource = input.sourceText;
  const sourceText = normalizeSourceText(rawSource);
  const phonetic = input.phoneticInput?.trim();
  let vibratoInput = phonetic || sourceText;
  let wasmElapsedMs: number | undefined;
  let ranBrowserVibrato = false;
  let vibratoFailedOpen = false;
  let vibratoSkippedReason: "phonetic-override" | "not-required" | undefined;
  const vibratoStageInput = sourceText;
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

  if (phonetic) {
    vibratoSkippedReason = "phonetic-override";
  } else if (!shouldRunBrowserVibratoPrePass(input.mode, sourceText, phonetic)) {
    vibratoSkippedReason = "not-required";
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
      vibratoFailedOpen = true;
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
    const trace = assembleConversionTrace({
      rawSource,
      normalizedSource: sourceText,
      phoneticInput: phonetic,
      vibrato: {
        ran: ranBrowserVibrato,
        skippedReason: vibratoSkippedReason,
        input: vibratoStageInput,
        output: vibratoInput,
        elapsedMs: wasmElapsedMs,
        failedOpen: vibratoFailedOpen,
      },
      converter: {
        mode: input.mode,
        azookeyInput: vibratoInput,
        convertedText: azookey.text,
        elapsedMs: azookey.elapsedMs,
        model: "azookey-rust-wasm",
      },
    });
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
      trace,
      steps: trace.steps,
    };
  }

  if (!deps.connectWorker || !deps.convertWithWorker) {
    throw new Error("Cloudflare Worker WebSocket クライアントを初期化できません");
  }
  deps.onStage?.("worker-connect");
  await deps.connectWorker();
  deps.onStage?.("worker");
  const workerMode = phonetic ? "worker-vibrato" : input.mode;
  const workerRequest = {
    sourceText,
    vibratoInput,
    mode: workerMode,
    vibratoExecution,
    model: input.converterModel,
  };
  const result = await deps.convertWithWorker({
    source: "web-speech",
    language: input.language,
    sourceText,
    vibratoInput,
    mode: workerMode,
    model: input.converterModel,
    vibratoExecution,
    auth: input.auth,
  });
  const trace = assembleConversionTrace({
    rawSource,
    normalizedSource: sourceText,
    phoneticInput: phonetic,
    vibrato: {
      ran: ranBrowserVibrato,
      skippedReason: vibratoSkippedReason,
      input: vibratoStageInput,
      output: vibratoInput,
      elapsedMs: wasmElapsedMs,
      failedOpen: vibratoFailedOpen,
    },
    converter: {
      mode: input.mode,
      azookeyInput: vibratoInput,
      convertedText: result.convertedText,
      elapsedMs: result.elapsedMs,
      model: result.model,
      requestedModel: result.requestedModel,
      modelFallback: result.modelFallback,
      workerRequest,
    },
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
    trace,
    steps: trace.steps,
  };
};
