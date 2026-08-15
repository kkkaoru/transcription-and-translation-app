/**
 * Comparison conversion pipeline.
 *
 * `browser-vibrato` (ブラウザ完結) runs Vibrato then AzooKey entirely in the
 * browser and never opens `/ws/azookey`. `worker-vibrato` still uses inference.
 *
 * Optional `input_n5_lm_v1` rescore sits after Vibrato (or normalize when
 * Vibrato is skipped) and before AzooKey — same stage order as desktop.
 */

import { shouldRunBrowserVibratoPrePass } from "./azookey-reading";
import type { BrowserAzookeyResult } from "./browser-azookey";
import type { BrowserVibratoConfig, BrowserVibratoResult } from "./browser-vibrato";
import type { BrowserZenzaiDictExecution, BrowserZenzaiDictResult } from "./browser-zenzai";
import { isBrowserZenzaiDictModel } from "./browser-zenzai";
import type { ComparisonAuth, ComparisonMode } from "./contract";
import { elapsedSinceMs, nowMs } from "./conversion-timing";
import {
  assembleConversionTrace,
  type ConversionTrace,
  normalizeSourceText,
  type TraceRescoreOutcome,
} from "./conversion-trace";
import type { ConverterModel } from "./converter-models";
import { isZenzConverterModel } from "./converter-models";
import { applyInputN5LmRescore } from "./input-n5-lm-rescore";
import type { ConversionStage } from "./path-labels";
import type { AzooKeyConvertResult, VibratoExecution } from "./worker-client";

export const usesWorkerConversion = (mode: ComparisonMode): boolean => mode === "worker-vibrato";

export const ZENZ_CONTEXT_MAX_GRAPHEMES = 40;

const graphemesOf = (input: string): string[] => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(input)].map(
      (segment) => segment.segment,
    );
  }
  return [...input];
};

export const trimZenzLeftContext = (
  leftContext: string,
  maxGraphemes = ZENZ_CONTEXT_MAX_GRAPHEMES,
): string => {
  const graphemes = graphemesOf(leftContext.trim());
  if (graphemes.length <= maxGraphemes) {
    return graphemes.join("");
  }
  return graphemes.slice(graphemes.length - maxGraphemes).join("");
};

export const previousConvertedLeftContext = (
  convertedTexts: readonly (string | undefined)[],
): string | undefined => {
  const latest = [...convertedTexts]
    .reverse()
    .find((text) => typeof text === "string" && text.trim().length > 0);
  if (latest === undefined) {
    return undefined;
  }
  const trimmed = trimZenzLeftContext(latest);
  return trimmed.length > 0 ? trimmed : undefined;
};

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
  /** Opt-in input_n5_lm_v1 rescore. Defaults to off when omitted. */
  inputN5LmRescoreEnabled?: boolean;
  /** Previous converted caption used as Zenz left context. */
  leftContext?: string;
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
  /** Set when browser-complete runs Zenzai dictionary (LOUDS) without GGUF inference. */
  zenzaiExecution?: BrowserZenzaiDictExecution;
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
  leftContext?: string;
}

export interface ConversionPipelineDependencies {
  runBrowserVibrato: (text: string, options: BrowserVibratoConfig) => Promise<BrowserVibratoResult>;
  runBrowserAzookey: (text: string) => Promise<BrowserAzookeyResult>;
  runBrowserZenzaiDict?: (text: string, model: ConverterModel) => Promise<BrowserZenzaiDictResult>;
  connectWorker?: () => Promise<void>;
  convertWithWorker?: (request: ConversionWorkerRequest) => Promise<AzooKeyConvertResult>;
  onStage?: (stage: ConversionStage) => void;
}

const maybeRescoreReading = (
  reading: string,
  enabled: boolean | undefined,
): { azookeyInput: string; rescore?: TraceRescoreOutcome } => {
  if (!enabled) {
    return { azookeyInput: reading };
  }
  const result = applyInputN5LmRescore(reading, true);
  return {
    azookeyInput: result.text,
    rescore: {
      ran: true,
      input: reading,
      output: result.text,
      ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
    },
  };
};

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

  const { azookeyInput, rescore } = maybeRescoreReading(
    vibratoInput,
    input.inputN5LmRescoreEnabled,
  );

  if (input.mode === "browser-vibrato") {
    if (isZenzConverterModel(input.converterModel)) {
      if (!deps.runBrowserZenzaiDict) {
        throw new Error("ブラウザ Zenzai 辞書クライアントを初期化できません");
      }
      deps.onStage?.("browser-azookey");
      const zenz = await deps.runBrowserZenzaiDict(azookeyInput, input.converterModel);
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
        ...(rescore ? { rescore } : {}),
        converter: {
          mode: input.mode,
          azookeyInput,
          convertedText: zenz.text,
          elapsedMs: zenz.elapsedMs,
          model: zenz.model,
          zenzaiExecution: zenz.execution,
          dictionaryUrl: zenz.dictionaryUrl,
        },
      });
      return {
        convertedText: zenz.text,
        vibratoInput,
        wasmElapsedMs,
        azookeyElapsedMs: zenz.elapsedMs,
        totalElapsedMs: elapsedSinceMs(startedAt),
        usedWebSocket: false,
        ranBrowserVibrato,
        vibratoExecution,
        model: zenz.model,
        zenzaiExecution: zenz.execution,
        trace,
        steps: trace.steps,
      };
    }
    deps.onStage?.("browser-azookey");
    const azookey = await deps.runBrowserAzookey(azookeyInput);
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
      ...(rescore ? { rescore } : {}),
      converter: {
        mode: input.mode,
        azookeyInput,
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
    vibratoInput: azookeyInput,
    mode: workerMode,
    vibratoExecution,
    model: input.converterModel,
  };
  const result = await deps.convertWithWorker({
    source: "web-speech",
    language: input.language,
    sourceText,
    vibratoInput: azookeyInput,
    mode: workerMode,
    model: input.converterModel,
    vibratoExecution,
    auth: input.auth,
    ...(input.leftContext ? { leftContext: input.leftContext } : {}),
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
    ...(rescore ? { rescore } : {}),
    converter: {
      mode: input.mode,
      azookeyInput,
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

/** True when browser-complete will use the Zenzai dictionary path for this model. */
export const usesBrowserZenzaiDictPath = (mode: ComparisonMode, model: ConverterModel): boolean =>
  mode === "browser-vibrato" && isBrowserZenzaiDictModel(model);
