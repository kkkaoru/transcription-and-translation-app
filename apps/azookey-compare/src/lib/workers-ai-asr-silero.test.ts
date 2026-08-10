import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSileroModelWindow,
  createSileroFeeds,
  nextSileroContext,
  probabilityFromOrtOutput,
  type SileroOrtRuntime,
  type SileroOrtSession,
  type SileroTensorLike,
  SileroWasmVadEngine,
  sileroStateTensorShape,
} from "./workers-ai-asr-silero";
import { SILERO_VAD_PUBLIC_MODEL_PATH } from "./workers-ai-asr-silero-paths";
import {
  SILERO_CHUNK_SAMPLES,
  SILERO_CONTEXT_SAMPLES,
  SILERO_INPUT_SAMPLES,
  SILERO_SAMPLE_RATE,
  SILERO_STATE_LEN,
} from "./workers-ai-asr-vad";

const compareRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publicModelPath = resolve(compareRoot, "public/models/silero_vad_v6/silero_vad.onnx");
const cacheModelPath = resolve(compareRoot, ".cache/silero-vad/silero_vad.onnx");
const modelPath = existsSync(publicModelPath)
  ? publicModelPath
  : existsSync(cacheModelPath)
    ? cacheModelPath
    : "";

class FakeTensor {
  public readonly type: string;
  public readonly data: Float32Array | BigInt64Array;
  public readonly dims: readonly number[];

  public constructor(type: string, data: Float32Array | BigInt64Array, dims: readonly number[]) {
    this.type = type;
    this.data = data;
    this.dims = dims;
  }
}

describe("Silero tensor packing matches Parapper engine.rs", () => {
  it("pads to 512, prepends 64-sample context, and shapes state [2,1,128]", () => {
    expect(sileroStateTensorShape()).toEqual([2, 1, 128]);
    const context = Float32Array.from({ length: SILERO_CONTEXT_SAMPLES }, (_, index) => index + 1);
    const samples = Float32Array.from({ length: 100 }, (_, index) => index + 100);
    const window = buildSileroModelWindow(context, samples);
    expect(window.copyLen).toBe(100);
    expect(window.chunk.length).toBe(SILERO_CHUNK_SAMPLES);
    expect(window.chunk[0]).toBe(100);
    expect(window.chunk[99]).toBe(199);
    expect(window.chunk[100]).toBe(0);
    expect(window.input.length).toBe(SILERO_INPUT_SAMPLES);
    expect(Array.from(window.input.slice(0, SILERO_CONTEXT_SAMPLES))).toEqual(Array.from(context));
    expect(
      Array.from(window.input.slice(SILERO_CONTEXT_SAMPLES, SILERO_CONTEXT_SAMPLES + 100)),
    ).toEqual(Array.from(samples));

    const next = nextSileroContext(window.chunk, window.copyLen);
    expect(next.length).toBe(SILERO_CONTEXT_SAMPLES);
    expect(Array.from(next)).toEqual(Array.from(samples.slice(36)));
    const short = nextSileroContext(
      Float32Array.from({ length: SILERO_CHUNK_SAMPLES }, (_, index) => index + 1),
      32,
    );
    expect(Array.from(short.slice(0, 32))).toEqual(Array.from({ length: 32 }, () => 0));
    expect(Array.from(short.slice(32))).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1),
    );

    const full = Float32Array.from({ length: SILERO_CHUNK_SAMPLES }, (_, index) => index);
    const fullWindow = buildSileroModelWindow(new Float32Array(SILERO_CONTEXT_SAMPLES), full);
    const fullNext = nextSileroContext(fullWindow.chunk, fullWindow.copyLen);
    expect(Array.from(fullNext)).toEqual(Array.from(full.slice(SILERO_CHUNK_SAMPLES - 64)));

    const feeds = createSileroFeeds(FakeTensor, window.input, new Float32Array(SILERO_STATE_LEN));
    const input = feeds.input as FakeTensor;
    const sr = feeds.sr as FakeTensor;
    const state = feeds.state as FakeTensor;
    expect(input.dims).toEqual([1, SILERO_INPUT_SAMPLES]);
    expect(sr.type).toBe("int64");
    expect(sr.dims).toEqual([]);
    expect(Array.from(sr.data as BigInt64Array)).toEqual([BigInt(SILERO_SAMPLE_RATE)]);
    expect(state.dims).toEqual([2, 1, 128]);
    expect(state.data.length).toBe(SILERO_STATE_LEN);
  });

  it("reads probability scalar and next state from ORT outputs", () => {
    const named = probabilityFromOrtOutput({
      output: { data: new Float32Array([0.81]) },
      stateN: { data: Float32Array.from({ length: SILERO_STATE_LEN }, (_, index) => index / 100) },
    });
    expect(named.probability).toBeCloseTo(0.81);
    expect(named.nextState?.length).toBe(SILERO_STATE_LEN);
    expect(named.nextState?.[2]).toBeCloseTo(0.02);
    expect(probabilityFromOrtOutput([]).probability).toBe(0);
    expect(
      probabilityFromOrtOutput({ output: { data: new Float32Array([]) } }).nextState,
    ).toBeUndefined();
    const holeyState = { length: SILERO_STATE_LEN, 0: BigInt(2) } as ArrayLike<bigint>;
    const fromArray = probabilityFromOrtOutput([
      { data: BigInt64Array.from([BigInt(1)]) },
      { data: holeyState },
    ]);
    expect(fromArray.probability).toBe(1);
    expect(fromArray.nextState?.[0]).toBe(2);
    expect(fromArray.nextState?.[1]).toBe(0);
    expect(probabilityFromOrtOutput([{ data: [Number.NaN] }]).probability).toBe(0);
  });
});

describe("SileroWasmVadEngine with injectable session", () => {
  it("takes max probability across 512-sample chunks and updates context", async () => {
    const probabilities = [0.2, 0.91, 0.1];
    let runIndex = 0;
    const seenFeeds: Array<Record<string, unknown>> = [];
    const session: SileroOrtSession = {
      run(feeds) {
        seenFeeds.push(feeds);
        const probability = probabilities[runIndex] ?? 0;
        runIndex += 1;
        return Promise.resolve({
          output: { data: new Float32Array([probability]) } satisfies SileroTensorLike,
          stateN: {
            data: Float32Array.from({ length: SILERO_STATE_LEN }, () => probability),
          },
        });
      },
      release() {},
    };
    const ort: SileroOrtRuntime = {
      Tensor: FakeTensor,
      InferenceSession: {
        create: () => Promise.resolve(session),
      },
      env: { wasm: {} },
    };
    const engine = new SileroWasmVadEngine({
      loadOrt: () => Promise.resolve(ort),
      createSession: () => Promise.resolve(session),
      threshold: 0.5,
    });
    const samples = new Float32Array(SILERO_CHUNK_SAMPLES * 3);
    samples.set(
      Float32Array.from({ length: SILERO_CHUNK_SAMPLES }, () => 0.4),
      SILERO_CHUNK_SAMPLES,
    );
    const result = await engine.process(samples);
    expect(result.probability).toBeCloseTo(0.91);
    expect(result.isSpeech).toBe(true);
    expect(seenFeeds).toHaveLength(3);
    expect(await engine.process(new Float32Array(0))).toEqual({ probability: 0, isSpeech: false });
    engine.setThreshold(0.95);
    runIndex = 0;
    const quiet = await engine.process(new Float32Array(SILERO_CHUNK_SAMPLES));
    expect(quiet.isSpeech).toBe(false);
    expect(() => engine.dispose()).not.toThrow();
  });

  it("normalizes wasmPaths, reuses init, and swallows release errors", async () => {
    let createCalls = 0;
    const session: SileroOrtSession = {
      run() {
        return Promise.resolve([{ data: new Float32Array([0.2]) }]);
      },
      release() {
        throw new Error("release failed");
      },
    };
    const ort: SileroOrtRuntime = {
      Tensor: FakeTensor,
      InferenceSession: {
        create: () => {
          createCalls += 1;
          return Promise.resolve(session);
        },
      },
      env: { wasm: {} },
    };
    const engine = new SileroWasmVadEngine({
      modelUrl: "  ",
      wasmPaths: "/ort",
      threshold: Number.NaN,
      loadOrt: () => Promise.resolve(ort),
    });
    await engine.init();
    await engine.init();
    expect(createCalls).toBe(1);
    expect(ort.env.wasm.wasmPaths).toBe("/ort/");
    engine.setThreshold(2);
    const result = await engine.process(new Float32Array(SILERO_CHUNK_SAMPLES));
    expect(result.isSpeech).toBe(false);
    expect(result.probability).toBeCloseTo(0.2);
    expect(() => engine.dispose()).not.toThrow();
  });

  it("fails closed when session creation throws", async () => {
    const engine = new SileroWasmVadEngine({
      loadOrt: () => Promise.reject(new Error("wasm missing")),
    });
    await expect(engine.init()).rejects.toThrow("wasm missing");
  });
});

describe.skipIf(!modelPath)("real Silero v6 ONNX", () => {
  it("loads the WASM EP with extern wasmPaths, not the jsep bundle", () => {
    const source = readFileSync(new URL("./workers-ai-asr-silero.ts", import.meta.url), "utf8");
    expect(source).toContain('import("onnxruntime-web/wasm")');
    expect(source).not.toMatch(/import\("onnxruntime-web"\)/);
    const nextConfig = readFileSync(new URL("../../next.config.mjs", import.meta.url), "utf8");
    expect(nextConfig).toContain("onnxruntime-web-use-extern-wasm");
    expect(nextConfig).not.toContain("transpilePackages");
  });

  it("scores speech-like noise higher than near-silence", async () => {
    expect(modelPath.length).toBeGreaterThan(0);
    expect(SILERO_VAD_PUBLIC_MODEL_PATH).toContain("silero_vad_v6");
    let ortModule: SileroOrtRuntime | undefined;
    try {
      ortModule = (await import("onnxruntime-web")) as unknown as SileroOrtRuntime;
    } catch {
      return;
    }
    ortModule.env.wasm.numThreads = 1;
    const model = readFileSync(modelPath);
    let session: SileroOrtSession;
    try {
      session = await ortModule.InferenceSession.create(new Uint8Array(model), {
        executionProviders: ["wasm"],
      });
    } catch {
      return;
    }
    const engine = new SileroWasmVadEngine({
      loadOrt: () => Promise.resolve(ortModule),
      createSession: () => Promise.resolve(session),
    });
    const silence = await engine.process(new Float32Array(SILERO_CHUNK_SAMPLES));
    const speech = await engine.process(
      Float32Array.from(
        { length: SILERO_CHUNK_SAMPLES },
        (_, index) => Math.sin((2 * Math.PI * 220 * index) / SILERO_SAMPLE_RATE) * 0.6,
      ),
    );
    expect(speech.probability).toBeGreaterThan(silence.probability);
    engine.dispose();
  }, 30_000);
});
