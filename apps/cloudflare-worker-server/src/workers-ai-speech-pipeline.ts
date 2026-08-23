/**
 * This file runs with bun.
 *
 * Single-request Workers AI speech pipeline: browser-segmented WAV → Nova-3
 * transcription → Worker-local AzooKey conversion.
 */

import { GatewayError } from "@caption-bridge/inference-server-core";
import {
  handleWorkersAiAsrTranscription,
  type WorkersAiAsrEnvironment,
  type WorkersAiAsrRun,
} from "./workers-ai-asr.js";

export const WORKERS_AI_SPEECH_PIPELINE_PATH = "/v1/speech/workers-ai/azookey";

const HTTP_OK = 200;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface SpeechPipelineConversionInput {
  text: string;
  model: "zenz-v3.2-xsmall-gguf" | "zenz-v3.2-small-gguf";
  leftContext: string;
}

export interface SpeechPipelineConversionResult {
  text: string;
  model: string;
  usedCompletion: boolean;
  modelFallback?: string;
}

export interface WorkersAiSpeechPipelineDependencies {
  asrEnvironment: WorkersAiAsrEnvironment;
  vibrato: (text: string, language: string) => Promise<string>;
  convert: (input: SpeechPipelineConversionInput) => Promise<SpeechPipelineConversionResult>;
  run?: WorkersAiAsrRun;
}

export interface SpeechPipelineStageLog {
  stage: "asr" | "vibrato" | "azookey";
  engine: string;
  input: string;
  output: string;
  elapsedMs: number;
  estimatedUsd?: number;
}

export interface WorkersAiSpeechAsrPayload {
  text: string;
  reading?: string;
  language: string;
  model: string;
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
    ...(typeof value["reading"] === "string" ? { reading: value["reading"] } : {}),
    language: typeof value["language"] === "string" ? value["language"] : "ja",
    model: typeof value["model"] === "string" ? value["model"] : "@cf/deepgram/nova-3",
    ...(typeof value["transport"] === "string" ? { transport: value["transport"] } : {}),
    ...(typeof value["segmentation"] === "string" ? { segmentation: value["segmentation"] } : {}),
  };
};

export const handleWorkersAiSpeechPipeline = async (
  request: Request,
  dependencies: WorkersAiSpeechPipelineDependencies,
): Promise<Response> => {
  const metadataRequest = request.clone();
  const asrStartedAt = performance.now();
  const asrResponse = await handleWorkersAiAsrTranscription(
    request,
    dependencies.asrEnvironment,
    dependencies.run,
  );
  if (!asrResponse.ok) {
    return asrResponse;
  }

  const asr: WorkersAiSpeechAsrPayload = workersAiSpeechAsrPayload(await asrResponse.json());
  const asrElapsedMs = Math.max(0, performance.now() - asrStartedAt);

  const form = await metadataRequest.formData();
  const conversionModelValue = form.get("conversionModel");
  const conversionModel =
    conversionModelValue === "zenz-v3.2-small-gguf"
      ? "zenz-v3.2-small-gguf"
      : conversionModelValue === "zenz-v3.2-xsmall-gguf"
        ? "zenz-v3.2-xsmall-gguf"
        : undefined;
  if (!conversionModel) {
    return json(400, {
      error: {
        code: "invalid_conversion_model",
        message: "conversionModel must be zenz-v3.2-xsmall-gguf or zenz-v3.2-small-gguf",
      },
    });
  }
  const leftContextValue = form.get("leftContext");
  const leftContext = typeof leftContextValue === "string" ? leftContextValue : "";
  const sourceText = asr.text.trim();
  if (!sourceText) {
    return json(HTTP_OK, {
      ...asr,
      convertedText: "",
      vibratoText: "",
      conversionModel,
      usedCompletion: false,
      pipeline: "workers-ai-language-gated-azookey-v3",
      logs: [],
    });
  }

  const asrLog: SpeechPipelineStageLog = {
    stage: "asr",
    engine: asr.model,
    input: "audio/wav",
    output: sourceText,
    elapsedMs: asrElapsedMs,
  };
  if (asr.language.toLowerCase() !== "ja") {
    return json(HTTP_OK, {
      ...asr,
      vibratoText: sourceText,
      convertedText: sourceText,
      conversionModel,
      usedCompletion: false,
      pipeline: "workers-ai-language-gated-azookey-v3",
      logs: [asrLog],
    });
  }

  try {
    const vibratoStartedAt = performance.now();
    const vibratoText = await dependencies.vibrato(sourceText, asr.language);
    const vibratoElapsedMs = Math.max(0, performance.now() - vibratoStartedAt);
    const azookeyStartedAt = performance.now();
    const conversion = await dependencies.convert({
      text: vibratoText,
      model: conversionModel,
      leftContext,
    });
    const convertedText = conversion.text;
    const azookeyElapsedMs = Math.max(0, performance.now() - azookeyStartedAt);
    const logs: SpeechPipelineStageLog[] = [
      asrLog,
      {
        stage: "vibrato",
        engine: "vibrato-ipadic-wasm",
        input: sourceText,
        output: vibratoText,
        elapsedMs: vibratoElapsedMs,
      },
      {
        stage: "azookey",
        engine: conversion.model,
        input: vibratoText,
        output: convertedText,
        elapsedMs: azookeyElapsedMs,
      },
    ];
    // biome-ignore lint/suspicious/noConsole: Workers Observability ingests structured pipeline logs
    console.log(JSON.stringify({ event: "speech_pipeline", logs }));
    return json(HTTP_OK, {
      ...asr,
      vibratoText,
      convertedText,
      conversionModel,
      usedCompletion: conversion.usedCompletion,
      ...(conversion.modelFallback ? { modelFallback: conversion.modelFallback } : {}),
      pipeline: "workers-ai-language-gated-azookey-v3",
      logs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AzooKey conversion failed";
    return json(HTTP_SERVICE_UNAVAILABLE, {
      error: { code: "azookey_conversion_failed", message },
    });
  }
};
