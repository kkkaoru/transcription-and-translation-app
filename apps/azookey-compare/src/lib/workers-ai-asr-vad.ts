/**
 * Workers AI ASR utterance segmentation, aligned with Parapper (not the old
 * 750ms energy hangover).
 *
 * Sources of truth:
 * - Silero engine contract: `packages/parapper-asr/src-tauri/src/recognition/segmentation/vad/engine.rs`
 * - Segment builder: `packages/parapper-asr/src-tauri/src/recognition/segmentation/segment/builder/`
 *   (`config.rs`, `facade.rs`)
 * - Defaults: `packages/parapper-asr/src-tauri/src/config/settings.rs`
 *   (`DEFAULT_VAD_INTERVAL_MS=32`, `DEFAULT_VAD_THRESHOLD=0.5`,
 *   `segment_start_speech_ms=96`, `turn.check_silence_ms=320`,
 *   `MAX_PHRASE_MILLIS=25_000`)
 * - Energy fallback gate: desktop `DEFAULT_SILENCE_GATE_DB = -50`
 *   (`apps/desktop/src/core/defaults.ts` + `apps/desktop/src/core/audio.ts`)
 *
 * Compare has no Namo / grammar turn detector. Utterance end is Parapper
 * `turn_check_silence` only. Silero ONNX runs in the browser for Workers AI
 * ASR; this energy engine is the load-failure fallback.
 */

export const WORKERS_AI_ASR_VAD_DEFAULTS = {
  vadIntervalMs: 32,
  vadThreshold: 0.5,
  segmentStartSpeechMs: 96,
  checkSilenceMs: 320,
  maxPhraseMs: 25_000,
  silenceGateDb: -50,
  sileroChunkSamples: 512,
} as const;

export const SILERO_CHUNK_SAMPLES = 512;
export const SILERO_CONTEXT_SAMPLES = 64;
export const SILERO_INPUT_SAMPLES = SILERO_CONTEXT_SAMPLES + SILERO_CHUNK_SAMPLES;
export const SILERO_STATE_LEN = 2 * 128;
export const SILERO_STATE_SHAPE = [2, 1, 128] as const;
export const SILERO_SAMPLE_RATE = 16_000;
export const ENERGY_PROBABILITY_FLOOR_DB = -100;

export type WorkersAiAsrVadConfig = {
  vadIntervalMs: number;
  vadThreshold: number;
  segmentStartSpeechMs: number;
  checkSilenceMs: number;
  maxPhraseMs: number;
  silenceGateDb: number;
  sileroChunkSamples: number;
};

export type VadResult = {
  probability: number;
  isSpeech: boolean;
};

export interface VadEngine {
  process(samples: Float32Array): VadResult | Promise<VadResult>;
  setThreshold?(threshold: number): void;
  dispose?(): void;
}

export type WorkersAiAsrVadPhase = "idle" | "pending" | "speech";
export type WorkersAiAsrVadEndReason = "silence" | "max-duration";

export type WorkersAiAsrVadEvent =
  | { type: "pending-start" }
  | { type: "pending-cancel" }
  | {
      type: "utterance-start";
      audioSoFar: Float32Array;
      utteranceChunks: number;
      preSpeechChunks: number;
    }
  | {
      type: "utterance-end";
      reason: WorkersAiAsrVadEndReason;
      fullAudio: Float32Array;
      utteranceChunks: number;
    };

export type WorkersAiAsrVadFrame = {
  rmsDb: number;
  durationMs: number;
};

export type WorkersAiAsrVadSnapshot = {
  phase: WorkersAiAsrVadPhase;
  pendingSpeechChunks: number;
  silenceChunks: number;
  audioChunks: number;
  preSpeechChunks: number;
};

const EPSILON = Number.EPSILON;

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const positiveOr = (value: unknown, fallback: number): number => {
  const resolved = finiteOr(value, fallback);
  return resolved > 0 ? resolved : fallback;
};

export const chunksForMillis = (thresholdMs: number, intervalMs: number): number =>
  Math.max(1, Math.ceil(thresholdMs / Math.max(1, intervalMs)));

export const chunkCountForDurationMs = (durationMs: number, intervalMs: number): number => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  if (durationMs <= intervalMs) {
    return 1;
  }
  return Math.floor(durationMs / intervalMs);
};

export const resolveWorkersAiAsrVadConfig = (
  options?: Partial<WorkersAiAsrVadConfig>,
): WorkersAiAsrVadConfig => {
  const vadIntervalMs = positiveOr(
    options?.vadIntervalMs,
    WORKERS_AI_ASR_VAD_DEFAULTS.vadIntervalMs,
  );
  const vadThreshold = finiteOr(options?.vadThreshold, WORKERS_AI_ASR_VAD_DEFAULTS.vadThreshold);
  const segmentStartSpeechMs = positiveOr(
    options?.segmentStartSpeechMs,
    WORKERS_AI_ASR_VAD_DEFAULTS.segmentStartSpeechMs,
  );
  const checkSilenceMs = positiveOr(
    options?.checkSilenceMs,
    WORKERS_AI_ASR_VAD_DEFAULTS.checkSilenceMs,
  );
  const maxPhraseMs = Math.max(
    segmentStartSpeechMs,
    positiveOr(options?.maxPhraseMs, WORKERS_AI_ASR_VAD_DEFAULTS.maxPhraseMs),
  );
  const silenceGateDb = finiteOr(options?.silenceGateDb, WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb);
  const sileroChunkSamples = Math.max(
    1,
    Math.floor(
      positiveOr(options?.sileroChunkSamples, WORKERS_AI_ASR_VAD_DEFAULTS.sileroChunkSamples),
    ),
  );
  return {
    vadIntervalMs,
    vadThreshold: Math.min(1, Math.max(0, vadThreshold)),
    segmentStartSpeechMs,
    checkSilenceMs,
    maxPhraseMs,
    silenceGateDb,
    sileroChunkSamples,
  };
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

export const float32FromTimeDomainBytes = (bytes: Uint8Array): Float32Array => {
  const samples = new Float32Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    samples[index] = ((bytes[index] ?? 128) - 128) / 128;
  }
  return samples;
};

export const probabilityFromRmsDb = (rmsDb: number): number => {
  if (!Number.isFinite(rmsDb)) {
    return 0;
  }
  return Math.min(
    1,
    Math.max(0, (rmsDb - ENERGY_PROBABILITY_FLOOR_DB) / -ENERGY_PROBABILITY_FLOOR_DB),
  );
};

export const isSpeechRmsDb = (
  rmsDb: number,
  thresholdDb: number = WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb,
): boolean => Number.isFinite(rmsDb) && rmsDb >= thresholdDb;

export const vadResultFromRmsDb = (
  rmsDb: number,
  options?: { silenceGateDb?: number; vadThreshold?: number },
): VadResult => {
  const silenceGateDb = finiteOr(options?.silenceGateDb, WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb);
  const vadThreshold = finiteOr(options?.vadThreshold, WORKERS_AI_ASR_VAD_DEFAULTS.vadThreshold);
  const probability = probabilityFromRmsDb(rmsDb);
  return {
    probability,
    isSpeech: isSpeechRmsDb(rmsDb, silenceGateDb) || probability > vadThreshold,
  };
};

export const resampleMono = (
  input: Float32Array,
  inputRate: number,
  outputRate = SILERO_SAMPLE_RATE,
): Float32Array => {
  if (!Number.isFinite(inputRate) || inputRate <= 0 || input.length === 0) {
    return new Float32Array(0);
  }
  if (inputRate === outputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outLength = Math.max(0, Math.floor(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const srcIndex = index * ratio;
    const left = Math.floor(srcIndex);
    const frac = srcIndex - left;
    const a = input[left] ?? 0;
    const b = input[left + 1] ?? a;
    output[index] = a + (b - a) * frac;
  }
  return output;
};

type SegmentChunk = {
  samples: Float32Array;
  vad: VadResult;
};

const concatAudio = (chunks: readonly SegmentChunk[]): Float32Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
  const audio = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk.samples, offset);
    offset += chunk.samples.length;
  }
  return audio;
};

export class EnergyVadEngine implements VadEngine {
  private readonly silenceGateDb: number;
  private readonly vadThreshold: number;
  private readonly chunkSamples: number;

  public constructor(
    options?: Partial<
      Pick<WorkersAiAsrVadConfig, "silenceGateDb" | "vadThreshold" | "sileroChunkSamples">
    >,
  ) {
    this.silenceGateDb = finiteOr(
      options?.silenceGateDb,
      WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb,
    );
    this.vadThreshold = finiteOr(options?.vadThreshold, WORKERS_AI_ASR_VAD_DEFAULTS.vadThreshold);
    this.chunkSamples = Math.max(
      1,
      Math.floor(
        positiveOr(options?.sileroChunkSamples, WORKERS_AI_ASR_VAD_DEFAULTS.sileroChunkSamples),
      ),
    );
  }

  public process(samples: Float32Array): VadResult {
    if (samples.length === 0) {
      return { probability: 0, isSpeech: false };
    }
    let probability = 0;
    let isSpeech = false;
    for (let offset = 0; offset < samples.length; offset += this.chunkSamples) {
      const chunk = samples.subarray(offset, Math.min(offset + this.chunkSamples, samples.length));
      const rmsDb = rmsDbFromFloat32(chunk);
      const result = vadResultFromRmsDb(rmsDb, {
        silenceGateDb: this.silenceGateDb,
        vadThreshold: this.vadThreshold,
      });
      probability = Math.max(probability, result.probability);
      isSpeech ||= result.isSpeech;
    }
    return { probability, isSpeech };
  }
}

/**
 * Parapper SegmentBuilder without Namo / interim-result ASR.
 * Idle keeps `checkSilenceMs` of pre-speech padding; consecutive speech ≥
 * `segmentStartSpeechMs` starts an utterance; silence ≥ `checkSilenceMs` or
 * `maxPhraseMs` ends it.
 */
export class WorkersAiAsrVad {
  private readonly config: WorkersAiAsrVadConfig;
  private readonly segmentStartChunks: number;
  private readonly turnCheckChunks: number;
  private readonly maxChunks: number;
  private readonly preSpeechMaxChunks: number;
  private phase: WorkersAiAsrVadPhase = "idle";
  private preSpeech: SegmentChunk[] = [];
  private pendingSpeech: SegmentChunk[] = [];
  private active: SegmentChunk[] = [];
  private audioChunks = 0;
  private silenceChunks = 0;

  public constructor(options?: Partial<WorkersAiAsrVadConfig>) {
    this.config = resolveWorkersAiAsrVadConfig(options);
    this.segmentStartChunks = chunksForMillis(
      this.config.segmentStartSpeechMs,
      this.config.vadIntervalMs,
    );
    this.turnCheckChunks = chunksForMillis(this.config.checkSilenceMs, this.config.vadIntervalMs);
    this.maxChunks = chunksForMillis(this.config.maxPhraseMs, this.config.vadIntervalMs);
    this.preSpeechMaxChunks = this.turnCheckChunks;
  }

  public get currentPhase(): WorkersAiAsrVadPhase {
    return this.phase;
  }

  public get snapshot(): WorkersAiAsrVadSnapshot {
    return {
      phase: this.phase,
      pendingSpeechChunks: this.pendingSpeech.length,
      silenceChunks: this.silenceChunks,
      audioChunks: this.audioChunks,
      preSpeechChunks: this.preSpeech.length,
    };
  }

  public reset(): void {
    this.phase = "idle";
    this.preSpeech = [];
    this.pendingSpeech = [];
    this.active = [];
    this.audioChunks = 0;
    this.silenceChunks = 0;
  }

  public pushFrame(frame: WorkersAiAsrVadFrame): WorkersAiAsrVadEvent[] {
    const chunks = chunkCountForDurationMs(frame.durationMs, this.config.vadIntervalMs);
    if (chunks === 0) {
      return [];
    }
    const vad = vadResultFromRmsDb(frame.rmsDb, {
      silenceGateDb: this.config.silenceGateDb,
      vadThreshold: this.config.vadThreshold,
    });
    const events: WorkersAiAsrVadEvent[] = [];
    const placeholder = new Float32Array(1);
    for (let index = 0; index < chunks; index += 1) {
      events.push(...this.pushVadResult(vad, placeholder));
    }
    return events;
  }

  public pushVadResult(
    vad: VadResult,
    samples: Float32Array = new Float32Array(0),
  ): WorkersAiAsrVadEvent[] {
    if (this.phase === "speech") {
      return this.pushActive(vad, samples);
    }
    return this.pushIdleOrPending(vad, samples);
  }

  private pushIdleOrPending(vad: VadResult, samples: Float32Array): WorkersAiAsrVadEvent[] {
    if (vad.isSpeech) {
      const wasIdle = this.phase === "idle" && this.pendingSpeech.length === 0;
      this.pendingSpeech.push({ samples, vad });
      this.phase = "pending";
      if (this.pendingSpeech.length < this.segmentStartChunks) {
        return wasIdle ? [{ type: "pending-start" }] : [];
      }
      const preSpeechChunks = this.preSpeech.length;
      const started = [...this.preSpeech, ...this.pendingSpeech];
      this.active = started;
      this.audioChunks = this.segmentStartChunks;
      this.silenceChunks = 0;
      this.preSpeech = [];
      this.pendingSpeech = [];
      this.phase = "speech";
      const events: WorkersAiAsrVadEvent[] = [];
      if (wasIdle) {
        events.push({ type: "pending-start" });
      }
      events.push({
        type: "utterance-start",
        audioSoFar: concatAudio(started),
        utteranceChunks: this.audioChunks,
        preSpeechChunks,
      });
      return events;
    }

    const hadPending = this.pendingSpeech.length > 0;
    for (const chunk of this.pendingSpeech) {
      this.pushPreSpeech(chunk);
    }
    this.pendingSpeech = [];
    this.pushPreSpeech({ samples, vad });
    this.phase = "idle";
    return hadPending ? [{ type: "pending-cancel" }] : [];
  }

  private pushActive(vad: VadResult, samples: Float32Array): WorkersAiAsrVadEvent[] {
    this.active.push({ samples, vad });
    this.audioChunks += 1;
    if (vad.isSpeech) {
      this.silenceChunks = 0;
    } else {
      this.silenceChunks += 1;
    }
    if (this.audioChunks >= this.maxChunks) {
      return this.endUtterance("max-duration");
    }
    if (this.silenceChunks >= this.turnCheckChunks) {
      return this.endUtterance("silence");
    }
    return [];
  }

  private endUtterance(reason: WorkersAiAsrVadEndReason): WorkersAiAsrVadEvent[] {
    const fullAudio = concatAudio(this.active);
    const utteranceChunks = this.audioChunks;
    const trailingSilence: SegmentChunk[] = [];
    if (reason === "silence") {
      for (let index = this.active.length - 1; index >= 0; index -= 1) {
        const chunk = this.active[index];
        if (!chunk || chunk.vad.isSpeech) {
          break;
        }
        trailingSilence.unshift(chunk);
      }
    }
    this.reset();
    this.preSpeech = trailingSilence.slice(-this.preSpeechMaxChunks);
    return [{ type: "utterance-end", reason, fullAudio, utteranceChunks }];
  }

  private pushPreSpeech(chunk: SegmentChunk): void {
    this.preSpeech.push(chunk);
    while (this.preSpeech.length > this.preSpeechMaxChunks) {
      this.preSpeech.shift();
    }
  }
}
