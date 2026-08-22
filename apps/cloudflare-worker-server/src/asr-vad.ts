/**
 * This file runs with bun.
 *
 * Parapper-aligned energy VAD / utterance segmentation for Worker ASR.
 * Same defaults as compare `workers-ai-asr-vad.ts` and the Native engine:
 * 32 ms frames, 0.5 speech threshold, 96 ms speech start, and 480 ms turn silence.
 * Hosted `/v1/asr/workers-ai/transcriptions` uses this before Nova-3.
 */

export interface WorkerAsrVadConfig {
  vadIntervalMs: number;
  vadThreshold: number;
  segmentStartSpeechMs: number;
  checkSilenceMs: number;
  maxPhraseMs: number;
  silenceGateDb: number;
  chunkSamples: number;
}

export interface WorkerAsrVadResult {
  probability: number;
  isSpeech: boolean;
}

export interface WorkerAsrUtterance {
  pcm: Uint8Array;
  reason: WorkerAsrVadEndReason;
}

export type WorkerAsrVadPhase = "idle" | "pending" | "speech";
export type WorkerAsrVadEndReason = "silence" | "max-duration" | "flush";

interface WorkerAsrVadChunk {
  samples: Float32Array;
  vad: WorkerAsrVadResult;
}

const PCM16_FULL_SCALE: number = 0x8000;
const ENERGY_PROBABILITY_FLOOR_DB: number = -100;
const EPSILON: number = Number.EPSILON;

export const WORKER_ASR_VAD_DEFAULTS: WorkerAsrVadConfig = {
  vadIntervalMs: 32,
  vadThreshold: 0.5,
  segmentStartSpeechMs: 96,
  checkSilenceMs: 480,
  maxPhraseMs: 25_000,
  silenceGateDb: -50,
  chunkSamples: 512,
};

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const chunksForMillis = (thresholdMs: number, intervalMs: number): number =>
  Math.max(1, Math.ceil(thresholdMs / Math.max(1, intervalMs)));

export const rmsFromFloat32 = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) {
    return 0;
  }
  const total = Array.from(samples).reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(total / samples.length);
};

export const rmsDbFromRms = (rms: number): number => {
  if (!Number.isFinite(rms) || rms <= EPSILON) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(rms);
};

export const rmsDbFromFloat32 = (samples: ArrayLike<number>): number =>
  rmsDbFromRms(rmsFromFloat32(samples));

export const isSpeechRmsDb = (
  rmsDb: number,
  thresholdDb: number = WORKER_ASR_VAD_DEFAULTS.silenceGateDb,
): boolean => Number.isFinite(rmsDb) && rmsDb >= thresholdDb;

export const probabilityFromRmsDb = (rmsDb: number): number => {
  if (!Number.isFinite(rmsDb)) {
    return 0;
  }
  return Math.min(
    1,
    Math.max(0, (rmsDb - ENERGY_PROBABILITY_FLOOR_DB) / -ENERGY_PROBABILITY_FLOOR_DB),
  );
};

export const vadResultFromRmsDb = (
  rmsDb: number,
  options?: { silenceGateDb?: number; vadThreshold?: number },
): WorkerAsrVadResult => {
  const silenceGateDb = finiteOr(options?.silenceGateDb, WORKER_ASR_VAD_DEFAULTS.silenceGateDb);
  const vadThreshold = finiteOr(options?.vadThreshold, WORKER_ASR_VAD_DEFAULTS.vadThreshold);
  const probability = probabilityFromRmsDb(rmsDb);
  return {
    probability,
    isSpeech: isSpeechRmsDb(rmsDb, silenceGateDb) || probability > vadThreshold,
  };
};

export const float32FromPcm16Bytes = (pcm: Uint8Array): Float32Array => {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  return Float32Array.from(view, (sample) => sample / PCM16_FULL_SCALE);
};

export const pcm16BytesFromFloat32 = (samples: Float32Array): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, Math.round(clipped * 0x7fff), true);
  });
  return bytes;
};

const concatAudio = (chunks: readonly WorkerAsrVadChunk[]): Float32Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.samples.length, 0);
  return chunks.reduce(
    (audio, chunk) => {
      audio.buffer.set(chunk.samples, audio.offset);
      return { buffer: audio.buffer, offset: audio.offset + chunk.samples.length };
    },
    { buffer: new Float32Array(length), offset: 0 },
  ).buffer;
};

export class WorkerEnergyVadEngine {
  private readonly silenceGateDb: number;
  private readonly vadThreshold: number;
  private readonly chunkSamples: number;

  public constructor(
    options?: Partial<Pick<WorkerAsrVadConfig, "silenceGateDb" | "vadThreshold" | "chunkSamples">>,
  ) {
    this.silenceGateDb = finiteOr(options?.silenceGateDb, WORKER_ASR_VAD_DEFAULTS.silenceGateDb);
    this.vadThreshold = finiteOr(options?.vadThreshold, WORKER_ASR_VAD_DEFAULTS.vadThreshold);
    this.chunkSamples = Math.max(
      1,
      Math.floor(finiteOr(options?.chunkSamples, WORKER_ASR_VAD_DEFAULTS.chunkSamples)),
    );
  }

  public process(samples: Float32Array): WorkerAsrVadResult {
    if (samples.length === 0) {
      return { probability: 0, isSpeech: false };
    }
    return Array.from({ length: Math.ceil(samples.length / this.chunkSamples) }, (_, index) =>
      samples.subarray(index * this.chunkSamples, (index + 1) * this.chunkSamples),
    ).reduce<WorkerAsrVadResult>(
      (best, chunk) => {
        const next = vadResultFromRmsDb(rmsDbFromFloat32(chunk), {
          silenceGateDb: this.silenceGateDb,
          vadThreshold: this.vadThreshold,
        });
        return {
          probability: Math.max(best.probability, next.probability),
          isSpeech: best.isSpeech || next.isSpeech,
        };
      },
      { probability: 0, isSpeech: false },
    );
  }
}

/**
 * Parapper SegmentBuilder without Namo. Consecutive speech ≥ 96 ms starts an
 * utterance; silence ≥ 480 ms or max-phrase / flush ends it. Mid-phrase gaps
 * shorter than 480 ms stay inside the same utterance.
 */
export class WorkerAsrVad {
  private readonly segmentStartChunks: number;
  private readonly turnCheckChunks: number;
  private readonly maxChunks: number;
  private readonly preSpeechMaxChunks: number;
  private phase: WorkerAsrVadPhase = "idle";
  private preSpeech: WorkerAsrVadChunk[] = [];
  private pendingSpeech: WorkerAsrVadChunk[] = [];
  private active: WorkerAsrVadChunk[] = [];
  private audioChunks = 0;
  private silenceChunks = 0;

  public constructor() {
    this.segmentStartChunks = chunksForMillis(
      WORKER_ASR_VAD_DEFAULTS.segmentStartSpeechMs,
      WORKER_ASR_VAD_DEFAULTS.vadIntervalMs,
    );
    this.turnCheckChunks = chunksForMillis(
      WORKER_ASR_VAD_DEFAULTS.checkSilenceMs,
      WORKER_ASR_VAD_DEFAULTS.vadIntervalMs,
    );
    this.maxChunks = chunksForMillis(
      WORKER_ASR_VAD_DEFAULTS.maxPhraseMs,
      WORKER_ASR_VAD_DEFAULTS.vadIntervalMs,
    );
    this.preSpeechMaxChunks = this.turnCheckChunks;
  }

  public reset(): void {
    this.phase = "idle";
    this.preSpeech = [];
    this.pendingSpeech = [];
    this.active = [];
    this.audioChunks = 0;
    this.silenceChunks = 0;
  }

  public pushVadResult(vad: WorkerAsrVadResult, samples: Float32Array): WorkerAsrUtterance[] {
    return this.phase === "speech"
      ? this.pushActive(vad, samples)
      : this.pushIdleOrPending(vad, samples);
  }

  public flush(): WorkerAsrUtterance[] {
    if (this.phase !== "speech") {
      this.reset();
      return [];
    }
    return this.endUtterance("flush");
  }

  private pushIdleOrPending(vad: WorkerAsrVadResult, samples: Float32Array): WorkerAsrUtterance[] {
    if (vad.isSpeech) {
      this.pendingSpeech = [...this.pendingSpeech, { samples, vad }];
      this.phase = "pending";
      if (this.pendingSpeech.length < this.segmentStartChunks) {
        return [];
      }
      this.active = [...this.preSpeech, ...this.pendingSpeech];
      this.audioChunks = this.segmentStartChunks;
      this.silenceChunks = 0;
      this.preSpeech = [];
      this.pendingSpeech = [];
      this.phase = "speech";
      return [];
    }
    this.pendingSpeech = [];
    this.preSpeech = [...this.preSpeech, { samples, vad }].slice(-this.preSpeechMaxChunks);
    this.phase = "idle";
    return [];
  }

  private pushActive(vad: WorkerAsrVadResult, samples: Float32Array): WorkerAsrUtterance[] {
    this.active = [...this.active, { samples, vad }];
    this.audioChunks += 1;
    this.silenceChunks = vad.isSpeech ? 0 : this.silenceChunks + 1;
    if (this.audioChunks >= this.maxChunks) {
      return this.endUtterance("max-duration");
    }
    return this.silenceChunks >= this.turnCheckChunks ? this.endUtterance("silence") : [];
  }

  private endUtterance(reason: WorkerAsrVadEndReason): WorkerAsrUtterance[] {
    const trailing =
      reason === "silence"
        ? this.active
            .slice()
            .reverse()
            .reduce<{ chunks: WorkerAsrVadChunk[]; done: boolean }>(
              (state, chunk) => {
                if (state.done || chunk.vad.isSpeech) {
                  return { chunks: state.chunks, done: true };
                }
                return { chunks: [chunk, ...state.chunks], done: false };
              },
              { chunks: [], done: false },
            ).chunks
        : [];
    const trailingPadChunks = reason === "silence" && trailing.length > 0 ? 1 : 0;
    const upload =
      trailing.length > 0
        ? this.active.slice(0, this.active.length - trailing.length + trailingPadChunks)
        : this.active;
    const pcm = pcm16BytesFromFloat32(concatAudio(upload));
    this.reset();
    this.preSpeech = trailing.slice(-this.preSpeechMaxChunks);
    return [{ pcm, reason }];
  }
}

export const segmentPcm16Utterances = (pcm: Uint8Array): WorkerAsrUtterance[] => {
  if (pcm.length < 2) {
    return [];
  }
  const samples = float32FromPcm16Bytes(pcm);
  const engine = new WorkerEnergyVadEngine();
  const vad = new WorkerAsrVad();
  const chunkSamples = WORKER_ASR_VAD_DEFAULTS.chunkSamples;
  const chunkCount = Math.ceil(samples.length / chunkSamples);
  const streamed = Array.from({ length: chunkCount }, (_, index) => {
    const chunk = samples.subarray(index * chunkSamples, (index + 1) * chunkSamples);
    return vad.pushVadResult(engine.process(chunk), chunk);
  }).flat();
  return [...streamed, ...vad.flush()];
};
