/**
 * This file runs with bun.
 *
 * Single-request Workers AI speech pipeline: browser Silero utterance → ASR →
 * optional Input N5 LM → optional Vibrato and AzooKey GGUF conversion.
 */

import { GatewayError } from "@caption-bridge/inference-server-core";
import {
  handleWorkersAiAsrTranscription,
  type WorkersAiAsrEnvironment,
  type WorkersAiAsrRun,
} from "./workers-ai-asr.js";
import {
  parseConversionModel,
  parseZenzContainerProfile,
  type ZenzContainerProfile,
  type ZenzConversionModel,
} from "./zenz-container-profile.js";

export const WORKERS_AI_SPEECH_PIPELINE_PATH = "/v1/speech/workers-ai/azookey";
export const WORKERS_AI_SPEECH_PIPELINE_ID = "workers-ai-profiled-azookey-v4";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface SpeechPipelineConversionInput {
  text: string;
  model: Exclude<ZenzConversionModel, "none">;
  leftContext: string;
  profile: ZenzContainerProfile;
  useUserLexicon: boolean;
}

export interface SpeechPipelineConversionResult {
  text: string;
  model: string;
  usedCompletion: boolean;
  modelFallback?: string;
}

export interface SpeechPipelineN5Result {
  text: string;
  model: "input_n5_lm_v1";
  elapsedMs: number;
}

interface SettledSpeechPipelineConversion {
  result?: SpeechPipelineConversionResult;
  error?: unknown;
}

interface FinalizeConversionOptions {
  dependencies: WorkersAiSpeechPipelineDependencies;
  input: SpeechPipelineConversionInput;
  speculativeInput: string;
  speculativeStartedAt: number;
  speculative: Promise<SettledSpeechPipelineConversion>;
}

interface TimedSpeechPipelineConversion {
  result: SpeechPipelineConversionResult;
  elapsedMs: number;
}

export interface WorkersAiSpeechPipelineDependencies {
  asrEnvironment: WorkersAiAsrEnvironment;
  vibrato: (text: string, language: string) => Promise<string>;
  releaseVibrato?: () => void;
  convert: (input: SpeechPipelineConversionInput) => Promise<SpeechPipelineConversionResult>;
  rescoreN5: (text: string, profile: ZenzContainerProfile) => Promise<SpeechPipelineN5Result>;
  run?: WorkersAiAsrRun;
}

export interface SpeechPipelineStageLog {
  stage: "asr" | "n5_lm" | "vibrato" | "azookey";
  engine: string;
  input: string;
  output: string;
  elapsedMs: number;
  estimatedUsd?: number;
}

export interface WorkersAiSpeechAsrPayload {
  text: string;
  reading: string;
  language: string;
  model: string;
  requestedModel?: string;
  asrModelFallback?: string;
  transport?: string;
  segmentation?: string;
}

const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const workersAiSpeechAsrPayload = (value: unknown): WorkersAiSpeechAsrPayload => {
  if (!isRecord(value) || typeof value["text"] !== "string") {
    throw new GatewayError(
      HTTP_BAD_GATEWAY,
      "invalid_asr_response",
      "Workers AI ASR response is missing text",
    );
  }
  return {
    text: value["text"],
    reading: typeof value["reading"] === "string" ? value["reading"] : value["text"],
    language: typeof value["language"] === "string" ? value["language"] : "und",
    model: typeof value["model"] === "string" ? value["model"] : "@cf/deepgram/nova-3",
    ...(typeof value["requestedModel"] === "string"
      ? { requestedModel: value["requestedModel"] }
      : {}),
    ...(typeof value["asrModelFallback"] === "string"
      ? { asrModelFallback: value["asrModelFallback"] }
      : {}),
    ...(typeof value["transport"] === "string" ? { transport: value["transport"] } : {}),
    ...(typeof value["segmentation"] === "string" ? { segmentation: value["segmentation"] } : {}),
  };
};

const invalidProfileResponse = (): Response =>
  json(HTTP_BAD_REQUEST, {
    error: {
      code: "invalid_container_profile",
      message: "computeTier, n5Lm, conversionModel, containerModel, and userLexicon are invalid",
    },
  });

const pipelineResponse = (
  asr: WorkersAiSpeechAsrPayload,
  fields: Record<string, unknown>,
): Response => json(HTTP_OK, { ...asr, pipeline: WORKERS_AI_SPEECH_PIPELINE_ID, ...fields });

const settleConversion = async (
  conversion: Promise<SpeechPipelineConversionResult>,
): Promise<SettledSpeechPipelineConversion> => {
  try {
    return { result: await conversion };
  } catch (error) {
    return { error };
  }
};

const settledResult = (
  settled: SettledSpeechPipelineConversion,
): SpeechPipelineConversionResult => {
  if (settled.result) return settled.result;
  throw settled.error;
};

const finalizeConversion = async (
  options: FinalizeConversionOptions,
): Promise<TimedSpeechPipelineConversion> => {
  if (options.input.text === options.speculativeInput) {
    return {
      result: settledResult(await options.speculative),
      elapsedMs: Math.max(0, performance.now() - options.speculativeStartedAt),
    };
  }
  const finalStartedAt = performance.now();
  const finalConversion = options.dependencies.convert(options.input);
  const [, result] = await Promise.all([options.speculative, finalConversion]);
  return { result, elapsedMs: Math.max(0, performance.now() - finalStartedAt) };
};

export const handleWorkersAiSpeechPipeline = async (
  request: Request,
  dependencies: WorkersAiSpeechPipelineDependencies,
): Promise<Response> => {
  const pipelineStartedAt = performance.now();
  const form = await request.formData();
  const conversionModel = parseConversionModel(form.get("conversionModel"));
  const userLexiconValue = form.get("userLexicon");
  if (
    !conversionModel ||
    (userLexiconValue !== null && userLexiconValue !== "on" && userLexiconValue !== "off")
  ) {
    return invalidProfileResponse();
  }
  const useUserLexicon = userLexiconValue !== "off";
  const profile = parseZenzContainerProfile(form, conversionModel);
  if (!profile) return invalidProfileResponse();
  const requestedLanguageValue = form.get("language");
  const requestedLanguage =
    typeof requestedLanguageValue === "string" && requestedLanguageValue.trim()
      ? requestedLanguageValue.trim()
      : undefined;
  const leftContextValue = form.get("leftContext");
  const leftContext = typeof leftContextValue === "string" ? leftContextValue : "";

  const asrStartedAt = performance.now();
  const asrResponse = await handleWorkersAiAsrTranscription(request, dependencies.asrEnvironment, {
    ...(dependencies.run ? { run: dependencies.run } : {}),
    preparedForm: form,
  });
  if (!asrResponse.ok) return asrResponse;
  const asr: WorkersAiSpeechAsrPayload = workersAiSpeechAsrPayload(await asrResponse.json());
  const sourceText = asr.text.trim();
  const asrLog: SpeechPipelineStageLog = {
    stage: "asr",
    engine: asr.model,
    input: "audio/wav",
    output: sourceText,
    elapsedMs: Math.max(0, performance.now() - asrStartedAt),
  };
  const commonFields: Record<string, unknown> = {
    conversionModel,
    containerProfile: profile,
  };
  if (!sourceText) {
    return pipelineResponse(asr, {
      ...commonFields,
      convertedText: "",
      n5Text: "",
      vibratoText: "",
      usedCompletion: false,
      logs: [],
    });
  }

  const isJapanesePostProcessing = requestedLanguage?.toLowerCase() === "ja";
  if (!isJapanesePostProcessing || (conversionModel === "none" && profile.n5Mode === "off")) {
    return pipelineResponse(asr, {
      ...commonFields,
      n5Text: sourceText,
      vibratoText: sourceText,
      convertedText: sourceText,
      usedCompletion: false,
      logs: [asrLog],
    });
  }

  try {
    const logs: SpeechPipelineStageLog[] = [asrLog];
    // input_n5_lm_v1 models kana ASR confusions. Derive a kana reading from a
    // kanji-bearing ASR surface first; the Vibrato converter preserves pure
    // kana so particles are not rewritten to their pronunciation.
    const vibratoStartedAt = performance.now();
    const vibratoText = await dependencies.vibrato(sourceText, requestedLanguage);
    const vibratoElapsedMs = Math.max(0, performance.now() - vibratoStartedAt);
    if (profile.computeTier === "basic") dependencies.releaseVibrato?.();
    logs.push({
      stage: "vibrato",
      engine: "vibrato-ipadic-wasm",
      input: sourceText,
      output: vibratoText,
      elapsedMs: vibratoElapsedMs,
    });
    const speculativeStartedAt = performance.now();
    const speculative =
      conversionModel === "none"
        ? undefined
        : settleConversion(
            dependencies.convert({
              text: vibratoText,
              model: conversionModel,
              leftContext,
              profile,
              useUserLexicon,
            }),
          );
    const n5Result: SpeechPipelineN5Result =
      profile.n5Mode === "on"
        ? await dependencies.rescoreN5(vibratoText, profile)
        : { text: vibratoText, model: "input_n5_lm_v1", elapsedMs: 0 };
    if (profile.n5Mode === "on") {
      logs.push({
        stage: "n5_lm",
        engine: n5Result.model,
        input: vibratoText,
        output: n5Result.text,
        elapsedMs: n5Result.elapsedMs,
      });
    }
    if (conversionModel === "none") {
      return pipelineResponse(asr, {
        ...commonFields,
        n5Text: n5Result.text,
        vibratoText,
        convertedText: n5Result.text,
        usedCompletion: false,
        logs,
      });
    }

    if (!speculative) throw new Error("AzooKey speculative conversion is unavailable");
    const conversion = await finalizeConversion({
      dependencies,
      input: {
        text: n5Result.text,
        model: conversionModel,
        leftContext,
        profile,
        useUserLexicon,
      },
      speculativeInput: vibratoText,
      speculativeStartedAt,
      speculative,
    });
    logs.push({
      stage: "azookey",
      engine: conversion.result.model,
      input: n5Result.text,
      output: conversion.result.text,
      elapsedMs: conversion.elapsedMs,
    });
    // biome-ignore lint/suspicious/noConsole: Workers Observability ingests privacy-safe timings
    console.log(
      JSON.stringify({
        event: "speech_pipeline_metrics",
        profile,
        asrModel: asr.model,
        asrMs: asrLog.elapsedMs,
        vibratoMs: vibratoElapsedMs,
        n5Ms: n5Result.elapsedMs,
        azookeyMs: conversion.elapsedMs,
        totalMs: Math.max(0, performance.now() - pipelineStartedAt),
        usedCompletion: conversion.result.usedCompletion,
        modelFallback: conversion.result.modelFallback ?? "none",
      }),
    );
    return pipelineResponse(asr, {
      ...commonFields,
      n5Text: n5Result.text,
      vibratoText,
      convertedText: conversion.result.text,
      usedCompletion: conversion.result.usedCompletion,
      ...(conversion.result.modelFallback
        ? { modelFallback: conversion.result.modelFallback }
        : {}),
      logs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Japanese post-processing failed";
    return json(HTTP_SERVICE_UNAVAILABLE, {
      error: { code: "japanese_postprocessing_failed", message },
    });
  }
};
