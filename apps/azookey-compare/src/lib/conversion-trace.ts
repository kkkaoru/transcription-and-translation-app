/**
 * Structured per-utterance conversion trace for the comparison UI.
 *
 * Captures normalization, Vibrato pre-pass, the exact AzooKey input string,
 * and converter output for both browser-complete and Cloudflare Worker modes.
 */

import type { ComparisonMode } from "./contract";
import { formatMilliseconds } from "./conversion-timing";
import type { ConverterModel } from "./converter-models";
import { normalizeAsrSourceText } from "./normalize-asr-source-text";
import type { VibratoExecution } from "./worker-client";

export type ConversionTraceStepId =
  | "source"
  | "normalize"
  | "phonetic-override"
  | "browser-vibrato"
  | "vibrato-skipped"
  | "vibrato-fallback"
  | "azookey-input"
  | "browser-azookey"
  | "browser-zenzai-dict"
  | "worker-ws"
  | "converter-output";

export type ConversionTraceLocation = "browser" | "cloudflare-worker" | "none";

export interface ConversionTraceStep {
  id: ConversionTraceStepId;
  /** Japanese step title for the timeline card. */
  title: string;
  detail?: string;
  input?: string;
  output?: string;
  elapsedMs?: number;
  location: ConversionTraceLocation;
}

/** Wire payload fields sent to `/ws/azookey` in Cloudflare Worker mode. */
export interface ConversionWorkerTracePayload {
  sourceText: string;
  vibratoInput: string;
  mode: ComparisonMode;
  vibratoExecution: VibratoExecution;
  model?: ConverterModel;
}

export interface ConversionTrace {
  steps: ConversionTraceStep[];
  /** Source text after Japanese ASR spacing normalization. */
  normalizedSource: string;
  /** Exact string passed to in-page AzooKey WASM or WS `vibratoInput`. */
  azookeyInput: string;
  usedPhoneticOverride: boolean;
  workerRequest?: ConversionWorkerTracePayload;
}

export interface TraceNormalizeInput {
  rawSource: string;
  phoneticInput?: string;
}

export interface TraceVibratoOutcome {
  ran: boolean;
  skippedReason?: "phonetic-override" | "not-required";
  input: string;
  output: string;
  elapsedMs?: number;
  failedOpen?: boolean;
}

export type ZenzaiTraceExecution = "browser-dict";

export interface TraceConverterOutcome {
  mode: ComparisonMode;
  azookeyInput: string;
  convertedText: string;
  elapsedMs?: number;
  model?: string;
  requestedModel?: string;
  modelFallback?: string;
  workerRequest?: ConversionWorkerTracePayload;
  /** Browser-complete Zenzai dictionary (LOUDS) without GGUF inference. */
  zenzaiExecution?: ZenzaiTraceExecution;
  dictionaryUrl?: string;
}

const LOCATION_LABEL: Record<ConversionTraceLocation, string> = {
  browser: "ブラウザ",
  "cloudflare-worker": "Cloudflare Worker",
  none: "—",
};

export const traceStepLocationLabel = (location: ConversionTraceLocation): string =>
  LOCATION_LABEL[location];

export const normalizeSourceText = (rawSource: string): string =>
  normalizeAsrSourceText(rawSource);

export const buildNormalizeStep = (rawSource: string, normalized: string): ConversionTraceStep => ({
  id: "normalize",
  title: "正規化",
  detail:
    rawSource === normalized
      ? "空白の正規化（変更なし）"
      : "前後空白と日本語トークン間の空白を除去しました",
  input: rawSource,
  output: normalized,
  location: "none",
});

export const buildPhoneticOverrideStep = (phonetic: string): ConversionTraceStep => ({
  id: "phonetic-override",
  title: "かな読み指定",
  detail: "ブラウザ Vibrato をスキップし、指定読みを AzooKey 入力に使用します",
  output: phonetic,
  location: "none",
});

export const buildVibratoSkippedStep = (
  reason: "phonetic-override" | "not-required",
  text: string,
): ConversionTraceStep => ({
  id: "vibrato-skipped",
  title: "Vibrato 前処理",
  detail:
    reason === "phonetic-override"
      ? "かな読み指定のため未実行"
      : "漢字を含まないため未実行",
  input: text,
  output: text,
  location: "browser",
});

export const buildBrowserVibratoStep = (
  input: string,
  output: string,
  elapsedMs?: number,
): ConversionTraceStep => ({
  id: "browser-vibrato",
  title: "ブラウザ Vibrato 読み",
  detail: "ブラウザ IPADIC WASM でひらがな読みへ変換",
  input,
  output,
  ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  location: "browser",
});

export const buildVibratoFallbackStep = (input: string): ConversionTraceStep => ({
  id: "vibrato-fallback",
  title: "Vibrato 前処理（フォールバック）",
  detail:
    "ブラウザ Vibrato に失敗したため、Cloudflare Worker 依存モードでは原文を AzooKey 入力候補に使用します",
  input,
  output: input,
  location: "browser",
});

export const buildAzookeyInputStep = (
  azookeyInput: string,
  mode: ComparisonMode,
): ConversionTraceStep => ({
  id: "azookey-input",
  title: "AzooKey への入力",
  detail:
    mode === "browser-vibrato"
      ? "in-page `azookey_convert` に渡す文字列"
      : "WebSocket リクエストの `vibratoInput` / 推論側 AzooKey 入力",
  output: azookeyInput,
  location: mode === "browser-vibrato" ? "browser" : "cloudflare-worker",
});

export const buildBrowserAzookeyStep = (
  input: string,
  output: string,
  elapsedMs?: number,
  model?: string,
): ConversionTraceStep => ({
  id: "browser-azookey",
  title: "ブラウザ AzooKey 変換",
  detail: model ? `モデル: ${model}` : "in-page AzooKey WASM",
  input,
  output,
  ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  location: "browser",
});

export const buildBrowserZenzaiDictStep = (
  input: string,
  output: string,
  model: string,
  dictionaryUrl: string,
  elapsedMs?: number,
): ConversionTraceStep => ({
  id: "browser-zenzai-dict",
  title: "ブラウザ Zenzai 辞書変換",
  detail: `Zenzai 辞書（LOUDS）のみ · ${dictionaryUrl} · モデル: ${model} · GGUF 推論なし`,
  input,
  output,
  ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  location: "browser",
});

export const buildWorkerWsStep = (payload: ConversionWorkerTracePayload): ConversionTraceStep => ({
  id: "worker-ws",
  title: "Cloudflare Worker へ送信",
  detail: `mode=${payload.mode} · vibratoExecution=${payload.vibratoExecution}${
    payload.model ? ` · model=${payload.model}` : ""
  }`,
  input: payload.vibratoInput,
  output: payload.vibratoInput,
  location: "cloudflare-worker",
});

export const buildConverterOutputStep = (
  output: string,
  mode: ComparisonMode,
  elapsedMs?: number,
  model?: string,
  requestedModel?: string,
  modelFallback?: string,
): ConversionTraceStep => {
  let detail = mode === "browser-vibrato" ? "ブラウザ AzooKey WASM の出力" : "Cloudflare Worker 変換結果";
  if (requestedModel && modelFallback) {
    detail = `${requestedModel} から ${model ?? "AzooKey WASM"} へフォールバック`;
  } else if (model) {
    detail = `モデル: ${model}`;
  }
  return {
    id: "converter-output",
    title: mode === "browser-vibrato" ? "AzooKey 出力" : "Cloudflare Worker 変換出力",
    output,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    detail,
    location: mode === "browser-vibrato" ? "browser" : "cloudflare-worker",
  };
};

export const assembleConversionTrace = (parts: {
  rawSource: string;
  normalizedSource: string;
  phoneticInput?: string;
  vibrato: TraceVibratoOutcome;
  converter: TraceConverterOutcome;
}): ConversionTrace => {
  const steps: ConversionTraceStep[] = [
    {
      id: "source",
      title: "Web Speech 認識結果",
      detail: "変換パイプラインの入力（sourceText）",
      output: parts.rawSource,
      location: "browser",
    },
    buildNormalizeStep(parts.rawSource, parts.normalizedSource),
  ];

  const phonetic = parts.phoneticInput?.trim();
  const usedPhoneticOverride = Boolean(phonetic);

  if (usedPhoneticOverride && phonetic) {
    steps.push(buildPhoneticOverrideStep(phonetic));
    steps.push(buildVibratoSkippedStep("phonetic-override", phonetic));
  } else if (parts.vibrato.failedOpen) {
    steps.push(buildVibratoFallbackStep(parts.vibrato.input));
  } else if (!parts.vibrato.ran) {
    steps.push(buildVibratoSkippedStep(parts.vibrato.skippedReason ?? "not-required", parts.vibrato.output));
  } else {
    steps.push(buildBrowserVibratoStep(parts.vibrato.input, parts.vibrato.output, parts.vibrato.elapsedMs));
  }

  steps.push(buildAzookeyInputStep(parts.converter.azookeyInput, parts.converter.mode));

  if (parts.converter.mode === "browser-vibrato") {
    if (parts.converter.zenzaiExecution === "browser-dict" && parts.converter.model) {
      steps.push(
        buildBrowserZenzaiDictStep(
          parts.converter.azookeyInput,
          parts.converter.convertedText,
          parts.converter.model,
          parts.converter.dictionaryUrl ?? "/azookey/system.azkdict.gz",
          parts.converter.elapsedMs,
        ),
      );
    } else {
      steps.push(
        buildBrowserAzookeyStep(
          parts.converter.azookeyInput,
          parts.converter.convertedText,
          parts.converter.elapsedMs,
          parts.converter.model,
        ),
      );
    }
  } else {
    if (parts.converter.workerRequest) {
      steps.push(buildWorkerWsStep(parts.converter.workerRequest));
    }
    steps.push(
      buildConverterOutputStep(
        parts.converter.convertedText,
        parts.converter.mode,
        parts.converter.elapsedMs,
        parts.converter.model,
        parts.converter.requestedModel,
        parts.converter.modelFallback,
      ),
    );
  }

  return {
    steps,
    normalizedSource: parts.normalizedSource,
    azookeyInput: parts.converter.azookeyInput,
    usedPhoneticOverride,
    ...(parts.converter.workerRequest ? { workerRequest: parts.converter.workerRequest } : {}),
  };
};

export const formatTraceStepTiming = (step: ConversionTraceStep): string | undefined =>
  step.elapsedMs === undefined ? undefined : formatMilliseconds(step.elapsedMs);

/** One-line summary for compact row meta (legacy path label companion). */
export const formatTraceStepSummary = (step: ConversionTraceStep): string => {
  const timing = formatTraceStepTiming(step);
  const location = step.location === "none" ? "" : ` · ${traceStepLocationLabel(step.location)}`;
  const timingSuffix = timing ? ` · ${timing}` : "";
  return `${step.title}${location}${timingSuffix}`;
};

export interface TraceDisplayLine {
  key: string;
  label: string;
  value: string;
  detail?: string;
  timing?: string;
}

/** Flatten trace steps into labeled rows for utterance comparison cards. */
export const conversionTraceDisplayLines = (trace: ConversionTrace): TraceDisplayLine[] =>
  trace.steps.flatMap((step) => {
    const timing = formatTraceStepTiming(step);
    const primaryValue = step.output ?? step.input ?? "—";
    const lines: TraceDisplayLine[] = [
      {
        key: `${step.id}-value`,
        label: step.title,
        value: primaryValue,
        ...(step.detail ? { detail: step.detail } : {}),
        ...(timing ? { timing } : {}),
      },
    ];
    if (step.input && step.output && step.input !== step.output) {
      lines.push({
        key: `${step.id}-input`,
        label: `${step.title}（入力）`,
        value: step.input,
      });
    }
    return lines;
  });
