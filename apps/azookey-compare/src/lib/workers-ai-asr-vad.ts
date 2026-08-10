/**
 * Browser-side energy VAD for Workers AI ASR.
 *
 * Nova-3 has no streaming endpoint here, so compare must slice utterances
 * locally. This module is a pure RMS/dBFS gate plus a hangover state machine:
 * consecutive speech for `minSpeechMs` starts an utterance; silence for
 * `endSilenceMs` (or a max cap) ends it. Brief noise blips never commit.
 */

export const WORKERS_AI_ASR_VAD_DEFAULTS = {
  /** dBFS gate; ambient room noise is typically below this. */
  speechThresholdDb: -45,
  /** Consecutive speech required before a blip becomes an utterance. */
  minSpeechMs: 250,
  /** Silence after committed speech that ends the utterance (600–900ms). */
  endSilenceMs: 750,
  /** Hard cap so loud noise cannot record forever (15–20s). */
  maxUtteranceMs: 18_000,
} as const;

export type WorkersAiAsrVadConfig = {
  speechThresholdDb: number;
  minSpeechMs: number;
  endSilenceMs: number;
  maxUtteranceMs: number;
};

export type WorkersAiAsrVadPhase = "idle" | "candidate" | "speech";

export type WorkersAiAsrVadEndReason = "silence" | "max-duration";

export type WorkersAiAsrVadEvent =
  | { type: "candidate-start" }
  | { type: "candidate-cancel" }
  | { type: "utterance-start" }
  | { type: "utterance-end"; reason: WorkersAiAsrVadEndReason };

export type WorkersAiAsrVadFrame = {
  rmsDb: number;
  durationMs: number;
};

const EPSILON = Number.EPSILON;

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const positiveOr = (value: unknown, fallback: number): number => {
  const resolved = finiteOr(value, fallback);
  return resolved > 0 ? resolved : fallback;
};

export const resolveWorkersAiAsrVadConfig = (
  options?: Partial<WorkersAiAsrVadConfig>,
): WorkersAiAsrVadConfig => {
  const speechThresholdDb = finiteOr(
    options?.speechThresholdDb,
    WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb,
  );
  const minSpeechMs = positiveOr(options?.minSpeechMs, WORKERS_AI_ASR_VAD_DEFAULTS.minSpeechMs);
  const endSilenceMs = positiveOr(options?.endSilenceMs, WORKERS_AI_ASR_VAD_DEFAULTS.endSilenceMs);
  const maxUtteranceMs = Math.max(
    minSpeechMs,
    positiveOr(options?.maxUtteranceMs, WORKERS_AI_ASR_VAD_DEFAULTS.maxUtteranceMs),
  );
  return { speechThresholdDb, minSpeechMs, endSilenceMs, maxUtteranceMs };
};

export const rmsFromFloat32 = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
};

export const rmsDbFromRms = (rms: number): number => {
  if (!Number.isFinite(rms) || rms <= EPSILON) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(rms);
};

export const rmsDbFromFloat32 = (samples: ArrayLike<number>): number =>
  rmsDbFromRms(rmsFromFloat32(samples));

/** PCM16 samples in the -32768…32767 range, treated as full-scale ±1.0. */
export const rmsDbFromPcm16 = (samples: Int16Array): number => {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const sample of samples) {
    const normalized = sample / 0x8000;
    sum += normalized * normalized;
  }
  return rmsDbFromRms(Math.sqrt(sum / samples.length));
};

/**
 * AnalyserNode `getByteTimeDomainData` bytes: 128 is silence, 0/255 are peaks.
 */
export const rmsDbFromTimeDomainBytes = (bytes: Uint8Array): number => {
  if (bytes.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const byte of bytes) {
    const normalized = (byte - 128) / 128;
    sum += normalized * normalized;
  }
  return rmsDbFromRms(Math.sqrt(sum / bytes.length));
};

export const isSpeechRmsDb = (
  rmsDb: number,
  thresholdDb: number = WORKERS_AI_ASR_VAD_DEFAULTS.speechThresholdDb,
): boolean => Number.isFinite(rmsDb) && rmsDb >= thresholdDb;

export class WorkersAiAsrVad {
  private readonly config: WorkersAiAsrVadConfig;
  private phase: WorkersAiAsrVadPhase = "idle";
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;

  public constructor(options?: Partial<WorkersAiAsrVadConfig>) {
    this.config = resolveWorkersAiAsrVadConfig(options);
  }

  public get currentPhase(): WorkersAiAsrVadPhase {
    return this.phase;
  }

  public get snapshot(): {
    phase: WorkersAiAsrVadPhase;
    speechMs: number;
    silenceMs: number;
    utteranceMs: number;
  } {
    return {
      phase: this.phase,
      speechMs: this.speechMs,
      silenceMs: this.silenceMs,
      utteranceMs: this.utteranceMs,
    };
  }

  public reset(): void {
    this.phase = "idle";
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
  }

  public pushFrame(frame: WorkersAiAsrVadFrame): WorkersAiAsrVadEvent[] {
    const durationMs = frame.durationMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return [];
    }
    const speech = isSpeechRmsDb(frame.rmsDb, this.config.speechThresholdDb);
    if (this.phase === "idle") {
      return this.pushIdle(speech, durationMs);
    }
    if (this.phase === "candidate") {
      return this.pushCandidate(speech, durationMs);
    }
    return this.pushSpeech(speech, durationMs);
  }

  private pushIdle(speech: boolean, durationMs: number): WorkersAiAsrVadEvent[] {
    if (!speech) {
      return [];
    }
    this.phase = "candidate";
    this.speechMs = durationMs;
    this.silenceMs = 0;
    this.utteranceMs = durationMs;
    if (this.speechMs < this.config.minSpeechMs) {
      return [{ type: "candidate-start" }];
    }
    return this.commitSpeech();
  }

  private pushCandidate(speech: boolean, durationMs: number): WorkersAiAsrVadEvent[] {
    if (!speech) {
      this.reset();
      return [{ type: "candidate-cancel" }];
    }
    this.speechMs += durationMs;
    this.utteranceMs += durationMs;
    this.silenceMs = 0;
    if (this.speechMs < this.config.minSpeechMs) {
      return [];
    }
    return this.commitSpeech();
  }

  private pushSpeech(speech: boolean, durationMs: number): WorkersAiAsrVadEvent[] {
    this.utteranceMs += durationMs;
    if (speech) {
      this.speechMs += durationMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += durationMs;
    }
    if (this.utteranceMs >= this.config.maxUtteranceMs) {
      return this.endUtterance("max-duration");
    }
    if (this.silenceMs >= this.config.endSilenceMs) {
      return this.endUtterance("silence");
    }
    return [];
  }

  private commitSpeech(): WorkersAiAsrVadEvent[] {
    this.phase = "speech";
    if (this.utteranceMs >= this.config.maxUtteranceMs) {
      return [{ type: "utterance-start" }, ...this.endUtterance("max-duration")];
    }
    return [{ type: "utterance-start" }];
  }

  private endUtterance(reason: WorkersAiAsrVadEndReason): WorkersAiAsrVadEvent[] {
    this.reset();
    return [{ type: "utterance-end", reason }];
  }
}
