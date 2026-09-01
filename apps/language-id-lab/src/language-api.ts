// Runs with Bun during build and test.
import type { InferenceMethod } from "./inference-methods";

export type EcapaPattern = "utterance" | "rolling-context";

export interface LanguageProbability {
  language: string;
  probability: number;
}

export interface HsmmDiagnostics {
  durationTicks: number;
  transitionHazard: number;
  posterior: readonly LanguageProbability[];
}

export type SprtState = "idle" | "accumulating" | "accepted";
export type HysteresisState = "unlocked" | "retaining" | "challenged" | "switched";

export interface SprtDiagnostics {
  candidateLanguage: string | null;
  llr: number;
  acceptLlr: number;
  rejectLlr: number;
  state: SprtState;
}

export interface HysteresisDiagnostics {
  stablePosterior: number;
  enterPosterior: number;
  retainPosterior: number;
  state: HysteresisState;
  challengerLanguage: string | null;
  challengerPosterior: number;
}

export interface ProviderBilling {
  audioSeconds: number;
  usdPerAudioMinute: number;
  estimatedUsd: number;
  transport: string;
}

export interface LanguageInference {
  sessionId: string;
  stableLanguage: string;
  stableConfidence: number;
  rawLanguages: readonly LanguageProbability[];
  hsmm: HsmmDiagnostics;
  sprt: SprtDiagnostics;
  hysteresis: HysteresisDiagnostics;
  quality: number;
  speechSeconds: number;
  inferenceMs: number;
  model: string;
  pattern: EcapaPattern;
  providerBilling: ProviderBilling | null;
}

interface InferOptions {
  samples: Float32Array;
  capturedAtMs: number;
  method: InferenceMethod;
  pattern: EcapaPattern;
  sessionId: string;
}

interface ReleaseOptions {
  method: InferenceMethod;
  sessionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (record: Record<string, unknown>, key: string): string => {
  const value: unknown = record[key];
  if (typeof value !== "string") throw new Error(`Inference response is missing ${key}`);
  return value;
};

const numberValue = (record: Record<string, unknown>, key: string): number => {
  const value: unknown = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Inference response is missing ${key}`);
  }
  return value;
};

const probability = (value: unknown): LanguageProbability => {
  if (!isRecord(value)) throw new Error("Inference probability is invalid");
  return {
    language: stringValue(value, "language"),
    probability: numberValue(value, "probability"),
  };
};

const probabilities = (value: unknown): readonly LanguageProbability[] => {
  if (!Array.isArray(value)) throw new Error("Inference probability list is invalid");
  return value.map(probability);
};

const providerBilling = (value: unknown): ProviderBilling | null => {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error("Provider billing is invalid");
  return {
    audioSeconds: numberValue(value, "audio_seconds"),
    usdPerAudioMinute: numberValue(value, "usd_per_audio_minute"),
    estimatedUsd: numberValue(value, "estimated_usd"),
    transport: stringValue(value, "transport"),
  };
};

const sprtState = (value: unknown): SprtState => {
  if (value === "idle" || value === "accumulating" || value === "accepted") return value;
  throw new Error("SPRT state is invalid");
};

const hysteresisState = (value: unknown): HysteresisState => {
  if (
    value === "unlocked" ||
    value === "retaining" ||
    value === "challenged" ||
    value === "switched"
  ) {
    return value;
  }
  throw new Error("Hysteresis state is invalid");
};

const optionalLanguage = (value: unknown, error: string): string | null => {
  if (value === null || typeof value === "string") return value;
  throw new Error(error);
};

export const parseLanguageInference = (value: unknown): LanguageInference => {
  if (!isRecord(value) || !isRecord(value.hsmm) || !isRecord(value.sprt)) {
    throw new Error("Language inference response is invalid");
  }
  if (!isRecord(value.hysteresis)) throw new Error("Hysteresis diagnostics are invalid");
  const candidate: string | null = optionalLanguage(
    value.sprt.candidate_language,
    "SPRT candidate language is invalid",
  );
  const challenger: string | null = optionalLanguage(
    value.hysteresis.challenger_language,
    "Hysteresis challenger language is invalid",
  );
  const pattern: string = stringValue(value, "pattern");
  if (pattern !== "utterance" && pattern !== "rolling-context") {
    throw new Error("ECAPA pattern is invalid");
  }
  return {
    sessionId: stringValue(value, "session_id"),
    stableLanguage: stringValue(value, "stable_language"),
    stableConfidence: numberValue(value, "stable_confidence"),
    rawLanguages: probabilities(value.raw_languages),
    hsmm: {
      durationTicks: numberValue(value.hsmm, "duration_ticks"),
      transitionHazard: numberValue(value.hsmm, "transition_hazard"),
      posterior: probabilities(value.hsmm.posterior),
    },
    sprt: {
      candidateLanguage: candidate,
      llr: numberValue(value.sprt, "llr"),
      acceptLlr: numberValue(value.sprt, "accept_llr"),
      rejectLlr: numberValue(value.sprt, "reject_llr"),
      state: sprtState(value.sprt.state),
    },
    hysteresis: {
      stablePosterior: numberValue(value.hysteresis, "stable_posterior"),
      enterPosterior: numberValue(value.hysteresis, "enter_posterior"),
      retainPosterior: numberValue(value.hysteresis, "retain_posterior"),
      state: hysteresisState(value.hysteresis.state),
      challengerLanguage: challenger,
      challengerPosterior: numberValue(value.hysteresis, "challenger_posterior"),
    },
    quality: numberValue(value, "quality"),
    speechSeconds: numberValue(value, "speech_seconds"),
    inferenceMs: numberValue(value, "inference_ms"),
    model: stringValue(value, "model"),
    pattern,
    providerBilling: providerBilling(value.provider_billing),
  };
};

const errorFromResponse = async (response: Response): Promise<Error> => {
  const payload: unknown = await response.json().catch(() => null);
  const message: unknown = isRecord(payload) ? payload.error : null;
  return new Error(
    typeof message === "string" ? message : `Request failed: ${String(response.status)}`,
  );
};

export const inferLanguage = async (options: InferOptions): Promise<LanguageInference> => {
  const query = new URLSearchParams({
    at_ms: String(options.capturedAtMs),
    pattern: options.pattern,
  });
  const body = new ArrayBuffer(options.samples.byteLength);
  new Uint8Array(body).set(
    new Uint8Array(options.samples.buffer, options.samples.byteOffset, options.samples.byteLength),
  );
  const response: Response = await fetch(
    `/api/language/${options.method}/infer?${query.toString()}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-kotoba-session-id": options.sessionId,
      },
      body,
    },
  );
  if (!response.ok) throw await errorFromResponse(response);
  const payload: unknown = await response.json();
  return parseLanguageInference(payload);
};

export const warmLanguageContainer = async (options: ReleaseOptions): Promise<void> => {
  const response: Response = await fetch(`/api/language/${options.method}/warmup`, {
    method: "POST",
    headers: { "x-kotoba-session-id": options.sessionId },
  });
  if (!response.ok) throw await errorFromResponse(response);
};

export const resetLanguageInference = async (options: ReleaseOptions): Promise<void> => {
  const response: Response = await fetch(`/api/language/${options.method}/reset`, {
    method: "POST",
    headers: { "x-kotoba-session-id": options.sessionId },
  });
  if (!response.ok) throw await errorFromResponse(response);
};

export const releaseLanguageContainer = async (options: ReleaseOptions): Promise<void> => {
  const response: Response = await fetch(`/api/language/${options.method}/release`, {
    method: "POST",
    headers: { "x-kotoba-session-id": options.sessionId },
    keepalive: true,
  });
  if (!response.ok) throw await errorFromResponse(response);
};
