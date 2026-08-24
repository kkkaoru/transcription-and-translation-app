/**
 * Browser Silero VAD v6 via onnxruntime-web WASM.
 *
 * Tensor packing / state+context update matches the Native engine:
 * `crates/parapper-engine/src/recognition/segmentation/vad/engine.rs`
 *
 * The browser uses this engine only to bound audio uploads. All text
 * processing remains in the combined Cloudflare Worker pipeline.
 */

import {
  SILERO_ORT_WASM_PUBLIC_PATH,
  SILERO_VAD_PUBLIC_MODEL_PATH,
} from "./workers-ai-asr-silero-paths";
import {
  SILERO_CHUNK_SAMPLES,
  SILERO_CONTEXT_SAMPLES,
  SILERO_INPUT_SAMPLES,
  SILERO_SAMPLE_RATE,
  SILERO_STATE_LEN,
  SILERO_STATE_SHAPE,
  type VadEngine,
  type VadResult,
  WORKERS_AI_ASR_VAD_DEFAULTS,
} from "./workers-ai-asr-vad";

export type SileroTensorLike = {
  data: ArrayLike<number> | ArrayLike<bigint>;
  dims?: readonly number[];
};

export type SileroOrtSession = {
  inputNames?: readonly string[];
  outputNames?: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, SileroTensorLike> | SileroTensorLike[]>;
  release?: () => Promise<void> | void;
};

export type SileroOrtRuntime = {
  Tensor: new (
    type: string,
    data: Float32Array | BigInt64Array,
    dims: readonly number[],
  ) => unknown;
  InferenceSession: {
    create(
      path: string | Uint8Array,
      options?: { executionProviders?: string[] },
    ): Promise<SileroOrtSession>;
  };
  env: { wasm: { wasmPaths?: string; numThreads?: number; simd?: boolean } };
};

export type SileroWasmVadEngineOptions = {
  modelUrl?: string;
  wasmPaths?: string;
  threshold?: number;
  loadOrt?: () => Promise<SileroOrtRuntime>;
  createSession?: (ort: SileroOrtRuntime) => Promise<SileroOrtSession>;
};

export type SileroModelWindow = {
  input: Float32Array;
  chunk: Float32Array;
  copyLen: number;
};

const SILERO_INPUT_SHAPE: readonly number[] = [1, SILERO_INPUT_SAMPLES];
const SILERO_SAMPLE_RATE_SHAPE: readonly number[] = [];

export interface SileroReusableBuffers {
  input: Float32Array;
  chunk: Float32Array;
  context: Float32Array;
  state: Float32Array;
  sampleRate: BigInt64Array<ArrayBuffer>;
}

const finiteThreshold = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

export const createSileroReusableBuffers = (): SileroReusableBuffers => ({
  input: new Float32Array(SILERO_INPUT_SAMPLES),
  chunk: new Float32Array(SILERO_CHUNK_SAMPLES),
  context: new Float32Array(SILERO_CONTEXT_SAMPLES),
  state: new Float32Array(SILERO_STATE_LEN),
  sampleRate: BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]),
});

export const writeSileroModelWindow = (
  buffers: Pick<SileroReusableBuffers, "input" | "chunk" | "context">,
  samples: Float32Array,
): number => {
  const copyLen = Math.min(samples.length, SILERO_CHUNK_SAMPLES);
  buffers.chunk.fill(0);
  buffers.chunk.set(samples.subarray(0, copyLen), 0);
  buffers.input.set(buffers.context, 0);
  buffers.input.set(buffers.chunk, SILERO_CONTEXT_SAMPLES);
  return copyLen;
};

export const buildSileroModelWindow = (
  context: Float32Array,
  samples: Float32Array,
): SileroModelWindow => {
  const chunk = new Float32Array(SILERO_CHUNK_SAMPLES);
  const copyLen = Math.min(samples.length, SILERO_CHUNK_SAMPLES);
  chunk.set(samples.subarray(0, copyLen));
  const input = new Float32Array(SILERO_INPUT_SAMPLES);
  input.set(context.subarray(0, SILERO_CONTEXT_SAMPLES));
  input.set(chunk, SILERO_CONTEXT_SAMPLES);
  return { input, chunk, copyLen };
};

export const writeNextSileroContext = (
  context: Float32Array,
  chunk: Float32Array,
  copyLen: number,
): void => {
  const contextStart = Math.max(0, copyLen - SILERO_CONTEXT_SAMPLES);
  const contextLen = copyLen - contextStart;
  context.fill(0);
  context.set(chunk.subarray(contextStart, copyLen), SILERO_CONTEXT_SAMPLES - contextLen);
};

export const nextSileroContext = (chunk: Float32Array, copyLen: number): Float32Array => {
  const context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  writeNextSileroContext(context, chunk, copyLen);
  return context;
};

export const sileroStateTensorShape = (): readonly number[] => SILERO_STATE_SHAPE;

export const createSileroFeeds = (
  Tensor: SileroOrtRuntime["Tensor"],
  input: Float32Array,
  state: Float32Array,
  sampleRate = SILERO_SAMPLE_RATE,
  sampleRateData = BigInt64Array.from([BigInt(sampleRate)]),
): Record<string, unknown> => ({
  input: new Tensor("float32", input, SILERO_INPUT_SHAPE),
  sr: new Tensor("int64", sampleRateData, SILERO_SAMPLE_RATE_SHAPE),
  state: new Tensor("float32", state, SILERO_STATE_SHAPE),
});

const firstNumber = (value: ArrayLike<number> | ArrayLike<bigint> | undefined): number => {
  if (!value || value.length === 0) {
    return 0;
  }
  const item = value[0];
  if (typeof item === "bigint") {
    return Number(item);
  }
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
};

export const probabilityFromOrtOutput = (
  outputs: Record<string, SileroTensorLike> | SileroTensorLike[],
  reusableState?: Float32Array,
): { probability: number; nextState?: Float32Array } => {
  const values = Array.isArray(outputs) ? outputs : Object.values(outputs);
  const probability = firstNumber(values[0]?.data);
  const stateData = values[1]?.data;
  let nextState: Float32Array | undefined;
  if (stateData && stateData.length === SILERO_STATE_LEN) {
    const target = reusableState ?? new Float32Array(SILERO_STATE_LEN);
    nextState = target;
    if (stateData instanceof Float32Array) {
      target.set(stateData);
    } else {
      target.forEach((_, index) => {
        target[index] = Number(stateData[index] ?? 0);
      });
    }
  }
  return { probability, nextState };
};

const defaultLoadOrt = async (): Promise<SileroOrtRuntime> => {
  const ort = (await import("onnxruntime-web/wasm")) as unknown as SileroOrtRuntime;
  return ort;
};

export class SileroWasmVadEngine implements VadEngine {
  private readonly modelUrl: string;
  private readonly wasmPaths: string;
  private readonly loadOrt: () => Promise<SileroOrtRuntime>;
  private readonly createSession?: (ort: SileroOrtRuntime) => Promise<SileroOrtSession>;
  private threshold: number;
  private session: SileroOrtSession | null = null;
  private ort: SileroOrtRuntime | null = null;
  private initPromise: Promise<void> | null = null;
  private processTail: Promise<void> = Promise.resolve();
  private readonly buffers = createSileroReusableBuffers();

  public constructor(options?: SileroWasmVadEngineOptions) {
    this.modelUrl = options?.modelUrl?.trim() || SILERO_VAD_PUBLIC_MODEL_PATH;
    this.wasmPaths = options?.wasmPaths?.trim() || SILERO_ORT_WASM_PUBLIC_PATH;
    this.threshold = finiteThreshold(options?.threshold, WORKERS_AI_ASR_VAD_DEFAULTS.vadThreshold);
    this.loadOrt = options?.loadOrt ?? defaultLoadOrt;
    this.createSession = options?.createSession;
  }

  public setThreshold(threshold: number): void {
    this.threshold = finiteThreshold(threshold, this.threshold);
  }

  public async init(): Promise<void> {
    if (this.session) {
      return;
    }
    if (!this.initPromise) {
      this.initPromise = this.createOrtSession();
    }
    await this.initPromise;
  }

  public process(samples: Float32Array): Promise<VadResult> {
    const pending = this.processTail.then(() => this.processSerial(samples));
    this.processTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async processSerial(samples: Float32Array): Promise<VadResult> {
    if (samples.length === 0) {
      return { probability: 0, isSpeech: false };
    }
    await this.init();
    const session = this.session;
    const ort = this.ort;
    if (!session || !ort) {
      throw new Error("Silero VAD session is not initialized");
    }
    let probability = 0;
    let isSpeech = false;
    for (let offset = 0; offset < samples.length; offset += SILERO_CHUNK_SAMPLES) {
      const slice = samples.subarray(
        offset,
        Math.min(offset + SILERO_CHUNK_SAMPLES, samples.length),
      );
      const chunkProbability = await this.processModelChunk(session, ort, slice);
      probability = Math.max(probability, chunkProbability);
      isSpeech ||= chunkProbability > this.threshold;
    }
    return { probability, isSpeech };
  }

  public dispose(): void {
    const session = this.session;
    this.session = null;
    this.ort = null;
    this.initPromise = null;
    this.buffers.state.fill(0);
    this.buffers.context.fill(0);
    this.buffers.chunk.fill(0);
    this.buffers.input.fill(0);
    try {
      void session?.release?.();
    } catch {
      // Best-effort ORT teardown when leaving Workers AI ASR.
    }
  }

  private async createOrtSession(): Promise<void> {
    const ort = await this.loadOrt();
    ort.env.wasm.wasmPaths = this.wasmPaths.endsWith("/") ? this.wasmPaths : `${this.wasmPaths}/`;
    ort.env.wasm.numThreads = 1;
    const session = this.createSession
      ? await this.createSession(ort)
      : await ort.InferenceSession.create(this.modelUrl, { executionProviders: ["wasm"] });
    this.ort = ort;
    this.session = session;
  }

  private async processModelChunk(
    session: SileroOrtSession,
    ort: SileroOrtRuntime,
    samples: Float32Array,
  ): Promise<number> {
    const copyLen = writeSileroModelWindow(this.buffers, samples);
    const feeds = createSileroFeeds(
      ort.Tensor,
      this.buffers.input,
      this.buffers.state,
      SILERO_SAMPLE_RATE,
      this.buffers.sampleRate,
    );
    const outputs = await session.run(feeds);
    const { probability } = probabilityFromOrtOutput(outputs, this.buffers.state);
    writeNextSileroContext(this.buffers.context, this.buffers.chunk, copyLen);
    return probability;
  }
}
