import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS,
  ADAPTIVE_GATE_AMBIENT_CEILING_DB,
  ADAPTIVE_GATE_FLOOR_ADMIT_DB,
  ADAPTIVE_GATE_MARGIN_DB,
  ADAPTIVE_GATE_MIN_ABSOLUTE_DB,
  ADAPTIVE_GATE_WARMUP_CHUNKS,
  AUDIO_CONTEXT_MAX_DURATION_MS,
  AUDIO_CONTEXT_OVERLAP_MS,
  AUDIO_CONTEXT_RESET_SILENCE_MS,
  AUDIO_WORKLET_FRAME_SAMPLES,
  AudioCaptureError,
  applyPeakNormalize,
  applyMicrophoneProcessing,
  bytesToBase64,
  calculatePeak,
  calculateRmsDb,
  createAdaptiveSilenceGate,
  createMicrophoneConstraints,
  createRollingAudioContext,
  desiredAudioProcessingConstraints,
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  float32ToPcm16,
  formatAudioCaptureDiagnostics,
  getLastAudioCaptureDiagnostics,
  MicrophoneCapture,
  makeAudioChunk,
  microphoneConstraintStrategies,
  openMicrophoneStream,
  PARTIAL_FLUSH_MIN_MS,
  partialAudioDurationMs,
  passesAdaptiveSilenceGate,
  passesSilenceGate,
  pcm16ToBase64,
  resampleLinear,
  rmsDbToMeterLevel,
  SCRIPT_PROCESSOR_BUFFER_SIZE,
  shouldFlushPartialAudio,
  TARGET_SAMPLE_RATE,
  updateAdaptiveSilenceGate,
} from "./audio";
import { DEFAULT_AUDIO_CHUNK_MS, DEFAULT_SILENCE_GATE_DB } from "./defaults";
import { clearDiagnosticEvents, getDiagnosticEvents } from "./diagnostics";
import { clearPipelineDrops, snapshotPipelineDrops } from "./dropDiagnostics";
import { isVerbosePipelineLogging, setVerbosePipelineLogging } from "./pipelineStages";
import type { AudioChunk } from "./types";

const FULL_CAPTURE_CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * DEFAULT_AUDIO_CHUNK_MS) / 1_000;

beforeEach(() => {
  clearDiagnosticEvents();
  clearPipelineDrops();
});

afterEach(() => {
  clearDiagnosticEvents();
  clearPipelineDrops();
});

describe("audio conversion", () => {
  it("keeps a speech-aware partial tail only when it reaches the minimum duration", () => {
    expect(PARTIAL_FLUSH_MIN_MS).toBe(160);
    expect(partialAudioDurationMs(7_680, 48_000)).toBe(160);
    expect(partialAudioDurationMs(2_560, 16_000)).toBe(160);
    expect(shouldFlushPartialAudio(7_679, 48_000)).toBe(false);
    expect(shouldFlushPartialAudio(7_680, 48_000)).toBe(true);
    expect(shouldFlushPartialAudio(1, 0)).toBe(false);
    expect(shouldFlushPartialAudio(0, 16_000)).toBe(false);
    // Malformed per-call thresholds must fail back to the safe production minimum.
    expect(shouldFlushPartialAudio(2_560, 16_000, Number.NaN)).toBe(true);
  });

  it("uses bounded worklet batches and an explicit script-processor fallback size", () => {
    // AudioWorklet render quanta are commonly 128 samples. Batching avoids a
    // structured-clone wakeup for every quantum while keeping sub-25 ms capture
    // granularity at the 48 kHz hardware rate.
    expect(AUDIO_WORKLET_FRAME_SAMPLES).toBe(1_024);
    expect((AUDIO_WORKLET_FRAME_SAMPLES / 48_000) * 1_000).toBeLessThan(25);
    expect(SCRIPT_PROCESSOR_BUFFER_SIZE).toBe(4_096);
  });

  it("carries cumulative speech context into each ASR chunk", () => {
    expect(AUDIO_CONTEXT_OVERLAP_MS).toBe(640);
    expect(AUDIO_CONTEXT_RESET_SILENCE_MS).toBe(640);
    expect(AUDIO_CONTEXT_MAX_DURATION_MS).toBeGreaterThanOrEqual(1_280);

    const context = createRollingAudioContext();
    const first = new Float32Array(640).fill(0.1);
    const second = new Float32Array(640).fill(0.2);

    expect(context.append(first, 1_000)).toEqual(first);
    const contextual = context.append(second, 1_000);
    // The second request contains the full preceding window followed by the
    // current window; this is what lets an ASR decoder recover a word split at
    // the fixed 640 ms boundary.
    expect(contextual.length).toBe(1_280);
    expect([...contextual.slice(0, 640)]).toEqual([...first]);
    expect([...contextual.slice(640)]).toEqual([...second]);

    // Do not discard the beginning after one overlap. A later request must be
    // self-contained when latest-wins replaces an intermediate queued request.
    const third = new Float32Array(640).fill(0.3);
    const cumulative = context.append(third, 1_000);
    expect(cumulative).toHaveLength(1_920);
    expect([...cumulative.slice(0, 640)]).toEqual([...first]);
    expect([...cumulative.slice(640, 1_280)]).toEqual([...second]);
    expect([...cumulative.slice(1_280)]).toEqual([...third]);
    expect(context.getContextSamples()).toHaveLength(1_920);
  });

  it("keeps a long utterance boundary when intermediate requests are dropped", () => {
    const context = createRollingAudioContext();
    const windows = Array.from({ length: 6 }, (_, index) =>
      new Float32Array(640).fill((index + 1) / 10),
    );
    const windowAt = (index: number): Float32Array => {
      const window = windows[index];
      if (!window) {
        throw new Error(`missing test window ${index}`);
      }
      return window;
    };

    // The queue may process window 1 and then replace pending windows 2–5 with
    // window 6. Window 6 still carries the complete recent speech history
    // through the bounded context, so a decoder never receives only a suffix.
    context.append(windowAt(0), 1_000);
    context.append(windowAt(1), 1_000);
    context.append(windowAt(2), 1_000);
    context.append(windowAt(3), 1_000);
    context.append(windowAt(4), 1_000);
    const newest = context.append(windowAt(5), 1_000);
    // The default 3.2 s cap retains five 640 ms windows. The oldest part may
    // fall out only after the cap, never merely because another request was
    // emitted or replaced in the latest-wins queue.
    expect(AUDIO_CONTEXT_MAX_DURATION_MS).toBe(3_200);
    expect(newest).toHaveLength(3_200);
    expect([...newest.slice(0, 640)]).toEqual([...windowAt(1)]);
    expect([...newest.slice(640, 1_280)]).toEqual([...windowAt(2)]);
    expect([...newest.slice(1_280, 1_920)]).toEqual([...windowAt(3)]);
    expect([...newest.slice(1_920, 2_560)]).toEqual([...windowAt(4)]);
    expect([...newest.slice(2_560)]).toEqual([...windowAt(5)]);

    // A full gated pause ends the utterance, so the next speech request starts
    // from its own boundary instead of carrying stale history forward.
    context.markSilence(AUDIO_CONTEXT_RESET_SILENCE_MS);
    expect(context.getContextSamples()).toHaveLength(0);
    const afterSilence = context.append(new Float32Array(640).fill(0.9), 1_000);
    expect(afterSilence).toHaveLength(640);
  });

  it("resets rolling context after a full silent gap and on rate changes", () => {
    const context = createRollingAudioContext({ overlapMs: 640, resetSilenceMs: 640 });
    const speech = new Float32Array(640).fill(0.1);
    const nextSpeech = new Float32Array(640).fill(0.2);
    context.append(speech, 1_000);
    context.markSilence(640);
    expect(context.getContextSamples()).toHaveLength(0);
    expect(context.append(nextSpeech, 1_000)).toEqual(nextSpeech);

    // A sample-rate switch cannot safely reuse a sample-count overlap.
    expect(context.append(new Float32Array(320).fill(0.3), 500)).toHaveLength(320);
    expect(context.getSilenceMs()).toBe(0);
  });

  it("uses a safe sample rate and caps an oversized rolling window", () => {
    const context = createRollingAudioContext({ overlapMs: 100, maxDurationMs: 100 });
    const oversized = new Float32Array(3_200).fill(0.25);

    const bounded = context.append(oversized, Number.NaN);

    expect(context.getSampleRate()).toBe(TARGET_SAMPLE_RATE);
    expect(bounded).toHaveLength(1_600);
    expect(context.hasContext()).toBe(true);
    context.markSilence(Number.NaN);
    expect(context.getSilenceMs()).toBe(0);
  });

  it("keeps short pauses in context while bounding contextual duration", () => {
    const context = createRollingAudioContext({
      overlapMs: 640,
      resetSilenceMs: 640,
      maxDurationMs: 900,
    });
    const speech = new Float32Array(640).fill(0.1);
    const continuation = new Float32Array(640).fill(0.2);
    context.append(speech, 1_000);
    context.markSilence(320);
    const joined = context.append(continuation, 1_000);
    // maxDurationMs leaves only 260 ms of prefix for a 640 ms current window.
    expect(joined).toHaveLength(900);
    expect([...joined.slice(-640)]).toEqual([...continuation]);
  });

  it("resamples a signal with linear interpolation", () => {
    const output = resampleLinear(new Float32Array([0, 1, 0, -1]), 4, 2);
    expect([...output]).toEqual([0, 0]);
    expect(resampleLinear(new Float32Array([0, 1]), 2, 2)).toEqual(new Float32Array([0, 1]));
    expect(resampleLinear(new Float32Array(), 4, 2)).toEqual(new Float32Array());
    // 48 kHz hardware rate → 16 kHz mono for Rust pcm_base64_to_wav.
    const oneSecond48k = new Float32Array(48_000).map((_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 48_000),
    );
    const down = resampleLinear(oneSecond48k, 48_000, 16_000);
    expect(down.length).toBe(16_000);
    expect(() => resampleLinear(new Float32Array([1]), 0, 16_000)).toThrow(/invalid sample rate/);
    expect(() => resampleLinear(new Float32Array([1]), 48_000, Number.NaN)).toThrow(
      /invalid sample rate/,
    );
  });

  it("converts float samples to signed PCM16", () => {
    expect([...float32ToPcm16(new Float32Array([-1, 0, 1, 2]))]).toEqual([-32768, 0, 32767, 32767]);
    expect(float32ToPcm16(new Float32Array())).toEqual(new Int16Array());
  });

  it("calculates a dBFS silence gate", () => {
    expect(calculateRmsDb(new Float32Array())).toBe(Number.NEGATIVE_INFINITY);
    expect(calculateRmsDb(new Float32Array([0, 0]))).toBe(Number.NEGATIVE_INFINITY);
    expect(calculateRmsDb(new Float32Array([1, -1]))).toBe(0);
  });

  it("filters ambient -54 dB chunks that previously reached Parapper", () => {
    // Exact user-facing pathology: rms≈-54.2 dB with default-raw + old -55 gate
    // sent noise-only WAV → HTTP 422 transcript_missing.
    expect(DEFAULT_SILENCE_GATE_DB).toBe(-50);
    expect(passesSilenceGate(-54.2, DEFAULT_SILENCE_GATE_DB)).toBe(false);
    expect(passesSilenceGate(-54.2, -55)).toBe(true);
    expect(passesSilenceGate(-40, DEFAULT_SILENCE_GATE_DB)).toBe(true);
    expect(passesSilenceGate(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(passesSilenceGate(Number.NaN)).toBe(false);
  });

  describe("adaptive noise-floor gate", () => {
    /** Feed a chunk into the gate and return whether it passed. */
    const feed = (
      state: ReturnType<typeof createAdaptiveSilenceGate>,
      chunkDb: number,
    ): boolean => {
      const passed = passesAdaptiveSilenceGate(state, chunkDb);
      updateAdaptiveSilenceGate(state, chunkDb, passed);
      return passed;
    };

    it("passes speech at -54.2 dB over a -65 dB ambient floor", () => {
      // Regression for the exact user report: real speech RMS -54.2 dB in a
      // room with a ~-65 dB floor. The OLD fixed gate (-50) silently dropped
      // this user's speech — this test fails against that logic.
      const state = createAdaptiveSilenceGate();
      // Warmup: two ambient chunks establish the floor.
      expect(feed(state, -65)).toBe(true);
      expect(feed(state, -65)).toBe(true);
      expect(state.floorDb).toBe(-65);
      // Speech just 11 dB over the floor must pass (old gate: -54.2 < -50 fails).
      expect(feed(state, -54.2)).toBe(true);
      // Ambient at -60 still fails: floor -65 + margin 9 = -56.
      expect(feed(state, -60)).toBe(false);
      expect(feed(state, -54.2)).toBe(true);
    });

    it("fails the old fixed-gate logic", () => {
      // The invariant the fixed -50 gate violated: -54.2 dB speech in a
      // -65 dB room is real speech and must be transcribed.
      expect(passesSilenceGate(-54.2, DEFAULT_SILENCE_GATE_DB)).toBe(false);
      const state = createAdaptiveSilenceGate();
      feed(state, -65);
      feed(state, -65);
      expect(passesAdaptiveSilenceGate(state, -54.2)).toBe(true);
    });

    it("blocks digital silence with an absolute floor even during warmup", () => {
      const state = createAdaptiveSilenceGate();
      const boundary = createAdaptiveSilenceGate();
      expect(feed(boundary, ADAPTIVE_GATE_MIN_ABSOLUTE_DB)).toBe(false);
      expect(boundary.fedChunks).toBe(0);
      expect(feed(state, -75)).toBe(false);
      expect(feed(state, -75)).toBe(false);
      expect(feed(state, -71)).toBe(false);
      // A real chunk still establishes a floor afterward.
      expect(feed(state, -64)).toBe(true);
      expect(state.floorDb).toBe(-64);
      // Warmup lets a second real chunk through (floor learns -64)…
      expect(feed(state, -63.5)).toBe(true);
      // …then steady state rejects anything within the 9 dB margin of the floor.
      expect(feed(state, -63.5)).toBe(false);
    });

    it("never lets speech drag the floor upward once established", () => {
      const state = createAdaptiveSilenceGate();
      feed(state, -65);
      feed(state, -65);
      // A long run of speech at -50 must not move the floor (floor stays -65).
      for (let index = 0; index < 40; index += 1) {
        feed(state, -50);
      }
      expect(state.floorDb).toBe(-65);
      // Speech at -54 (11 dB over floor) still passes afterwards.
      expect(feed(state, -54)).toBe(true);
      expect(feed(state, -57)).toBe(false);
    });

    it("keeps passing continuous speech that starts before any ambient sample", () => {
      // Regression: a streamer who talks from the very first chunk never gives
      // the gate a quiet window. Speech must NOT seed the floor — otherwise the
      // floor lands on speech level and the whole first utterance is silently
      // dropped until the user pauses (same silent-failure class as the -50 gate).
      const state = createAdaptiveSilenceGate();
      expect(feed(state, -54.2)).toBe(true);
      expect(feed(state, -54.2)).toBe(true);
      // Speech never becomes the ambient estimate.
      expect(state.floorDb).toBeNull();
      // Past warmup, continuous speech keeps flowing instead of being gated out.
      for (let index = 0; index < 20; index += 1) {
        expect(feed(state, -54.2)).toBe(true);
      }
      expect(state.floorDb).toBeNull();
    });

    it("passes -54.2 dB speech over EVERY learnable ambient floor", () => {
      // The floor can never exceed the ambient ceiling, so the strictest
      // reachable threshold is ceiling + margin. If that ever rises above the
      // reported speech level, quiet speech is silently dropped in moderately
      // noisy rooms — the exact class of bug this gate exists to prevent.
      expect(ADAPTIVE_GATE_AMBIENT_CEILING_DB + ADAPTIVE_GATE_MARGIN_DB).toBeLessThanOrEqual(-54.2);
      // Swept end-to-end: a -61 dB room silently gated this speech out while
      // the ceiling was -60.
      for (const ambient of [-70, -68, -66, -65, -64, -61, -58]) {
        const state = createAdaptiveSilenceGate();
        feed(state, ambient);
        feed(state, ambient);
        expect(feed(state, -54.2)).toBe(true);
      }
    });

    it("learns the floor from the first genuinely quiet window, then gates ambient", () => {
      const state = createAdaptiveSilenceGate();
      // Speech first: fails open, no floor.
      expect(feed(state, -54)).toBe(true);
      expect(feed(state, -52)).toBe(true);
      expect(state.floorDb).toBeNull();
      // The user pauses: this quiet window establishes ambient.
      expect(feed(state, -65)).toBe(true);
      expect(state.floorDb).toBe(-65);
      // Now ambient is rejected and speech over the margin still passes.
      expect(feed(state, -65)).toBe(false);
      expect(feed(state, -54)).toBe(true);
    });

    it("tracks a slowly rising ambient floor", () => {
      const state = createAdaptiveSilenceGate();
      feed(state, -65);
      feed(state, -65);
      // Room warms up: ambient drifts to -62 within the admit window.
      feed(state, -64);
      feed(state, -63.5);
      const floor = state.floorDb;
      if (floor === null) {
        throw new Error("floor must be established after warmup");
      }
      expect(floor).toBeGreaterThan(-65);
      expect(floor).toBeLessThan(-63.5);
      // Speech only 6 dB over the new floor is still rejected (margin 9 dB).
      expect(feed(state, floor + 6)).toBe(false);
      // Speech 12 dB over passes.
      expect(feed(state, floor + 12)).toBe(true);
    });

    it("ignores non-finite and below-floor readings without corrupting state", () => {
      const state = createAdaptiveSilenceGate();
      expect(passesAdaptiveSilenceGate(state, Number.NaN)).toBe(false);
      expect(passesAdaptiveSilenceGate(state, Number.NEGATIVE_INFINITY)).toBe(false);
      updateAdaptiveSilenceGate(state, Number.NaN, false);
      expect(state.fedChunks).toBe(0);
      feed(state, -65);
      expect(state.fedChunks).toBe(1);
      // A null floor in steady phase means no ambient window has ever been
      // observed (continuous speech). Fail open — gating here would silently
      // drop every chunk. Digital silence is still blocked by the hard floor.
      expect(
        passesAdaptiveSilenceGate(
          { floorDb: null, fedChunks: ADAPTIVE_GATE_WARMUP_CHUNKS + 5 },
          -60,
        ),
      ).toBe(true);
      expect(
        passesAdaptiveSilenceGate(
          { floorDb: null, fedChunks: ADAPTIVE_GATE_WARMUP_CHUNKS + 5 },
          -75,
        ),
      ).toBe(false);
    });

    it("exposes tunable constants consistent with the user scenario", () => {
      expect(ADAPTIVE_GATE_MIN_ABSOLUTE_DB).toBe(-70);
      expect(ADAPTIVE_GATE_WARMUP_CHUNKS).toBeGreaterThan(0);
      // Margin must be small enough that -54.2 over -65 passes (10.8 dB gap).
      expect(ADAPTIVE_GATE_MARGIN_DB).toBeLessThanOrEqual(10);
      // Floor admit window must be far below the speech gap (11 dB) so speech
      // chunks never feed the floor.
      expect(ADAPTIVE_GATE_FLOOR_ADMIT_DB).toBeLessThan(ADAPTIVE_GATE_MARGIN_DB);
    });
  });

  it("surfaces a bounded warning for repeated absolute-floor drops", () => {
    const capture = new MicrophoneCapture();
    const internals = capture as unknown as {
      context: { sampleRate: number };
      handler: (chunk: AudioChunk) => void;
      gateMode: "adaptive";
      adaptiveGate: ReturnType<typeof createAdaptiveSilenceGate>;
      chunksAccepted: number;
      publishDiagnostics: () => void;
      acceptSamples: (samples: Float32Array) => void;
    };
    internals.context = { sampleRate: TARGET_SAMPLE_RATE };
    internals.handler = vi.fn();
    internals.gateMode = "adaptive";
    internals.adaptiveGate = createAdaptiveSilenceGate();
    internals.chunksAccepted = 2;
    internals.publishDiagnostics = () => undefined;

    const silentChunk = new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES);
    const warningEvents = () =>
      getDiagnosticEvents().filter((event) => event.message === "Absolute floor drop warning");
    for (let index = 0; index < ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS - 1; index += 1) {
      internals.acceptSamples(silentChunk.slice());
    }
    expect(warningEvents()).toHaveLength(0);

    internals.acceptSamples(silentChunk.slice());
    expect(warningEvents()).toHaveLength(1);
    expect(warningEvents()[0]).toMatchObject({ kind: "audio" });
    expect(warningEvents()[0]?.detail).toContain(
      `floor=${ADAPTIVE_GATE_MIN_ABSOLUTE_DB.toFixed(1)}dBFS`,
    );
    expect(capture.getDiagnostics()).toMatchObject({
      absoluteFloorDrops: ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS,
      consecutiveAbsoluteFloorDrops: ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS,
      chunksDroppedSilent: ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS,
      lastAbsoluteFloorDropAt: expect.any(String),
    });
    expect(snapshotPipelineDrops()).toMatchObject({
      total: ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS,
      bySource: { audio: ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS },
      byReason: { "absolute-floor": ABSOLUTE_FLOOR_WARNING_CONSECUTIVE_CHUNKS },
    });

    internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
    expect(capture.getDiagnostics().consecutiveAbsoluteFloorDrops).toBe(0);
  });

  it("soft peak-normalizes quiet speech that already passed the silence gate", () => {
    // Quiet speech peak ~0.05 → gain up toward ~0.35 (capped).
    const quiet = new Float32Array(64).fill(0.05);
    expect(calculatePeak(quiet)).toBeCloseTo(0.05, 5);
    const lifted = applyPeakNormalize(quiet);
    expect(lifted.gain).toBeGreaterThan(1.05);
    expect(calculatePeak(lifted.samples)).toBeCloseTo(0.35, 2);
    // Already-loud speech is left alone.
    const loud = new Float32Array(16).fill(0.6);
    const unchanged = applyPeakNormalize(loud);
    expect(unchanged.gain).toBe(1);
    expect(unchanged.samples).toBe(loud);
    // Silence stays silent (no Infinity gain).
    const silent = new Float32Array(8);
    expect(applyPeakNormalize(silent).gain).toBe(1);
  });

  it("builds progressive microphone constraints for device selection", () => {
    // Default: noise cancelling ON (echoCancellation + noiseSuppression + AGC).
    // Never include channelCount — WKWebView rejects it as "Invalid constraint".
    expect(createMicrophoneConstraints("default").audio).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    // Explicit raw NS path: NS/AEC off; AGC follows its own setting (default on).
    expect(createMicrophoneConstraints("default", { noiseSuppression: false }).audio).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    });
    expect(
      createMicrophoneConstraints("default", {
        noiseSuppression: false,
        autoGainControl: false,
      }).audio,
    ).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(
      (createMicrophoneConstraints("default").audio as MediaTrackConstraints).deviceId,
    ).toBeUndefined();
    expect(createMicrophoneConstraints("usb-mic").audio).toEqual({
      deviceId: { exact: "usb-mic" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(createMicrophoneConstraints("usb-mic", { idealDevice: true }).audio).toMatchObject({
      deviceId: { ideal: "usb-mic" },
    });
    // Fully relaxed default must be `audio: true` (empty object is invalid).
    expect(createMicrophoneConstraints("default", { relaxProcessing: true }).audio).toBe(true);
  });

  it("omits unsupported keys from the permission request but keeps NS/AGC desired", () => {
    // Safari/WKWebView commonly expose echoCancellation but not noiseSuppression
    // or autoGainControl on getSupportedConstraints. The initial getUserMedia
    // must omit them; desiredAudioProcessingConstraints still keeps them on.
    expect(desiredAudioProcessingConstraints(true)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    const webkit = new Set(["deviceId", "echoCancellation", "groupId"]);
    expect(
      createMicrophoneConstraints("default", { supportedConstraints: webkit }).audio,
    ).toEqual({
      echoCancellation: true,
    });
    expect(
      createMicrophoneConstraints("mic-1", {
        noiseSuppression: false,
        supportedConstraints: webkit,
      }).audio,
    ).toEqual({
      deviceId: { exact: "mic-1" },
      echoCancellation: false,
    });
  });

  it("applies noiseSuppression and autoGainControl after microphone permission", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const stream = {
      getAudioTracks: () => [{ applyConstraints }],
    } as unknown as MediaStream;

    await expect(applyMicrophoneProcessing(stream, true)).resolves.toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(applyConstraints).toHaveBeenCalledTimes(3);
    expect(applyConstraints).toHaveBeenNthCalledWith(1, { echoCancellation: true });
    expect(applyConstraints).toHaveBeenNthCalledWith(2, { noiseSuppression: true });
    expect(applyConstraints).toHaveBeenNthCalledWith(3, { autoGainControl: true });
  });

  it("keeps applying remaining processing flags when one applyConstraints fails", async () => {
    const applyConstraints = vi
      .fn()
      .mockRejectedValueOnce(new Error("Invalid constraint"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const stream = {
      getAudioTracks: () => [{ applyConstraints }],
    } as unknown as MediaStream;

    await expect(applyMicrophoneProcessing(stream, true)).resolves.toEqual({
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(applyConstraints).toHaveBeenCalledTimes(3);
  });

  it("keeps explicit device selection pinned while relaxing processing", () => {
    expect(microphoneConstraintStrategies("mic-1").map((entry) => entry.mode)).toEqual([
      "exact-device",
      "exact-device-relaxed",
      "ideal-device",
      "default-relaxed",
    ]);
    expect(microphoneConstraintStrategies("default").map((entry) => entry.mode)).toEqual([
      "default",
      "default-relaxed",
    ]);
    // The ladder must never silently land on a legacy raw mode: every attempt
    // keeps a named mode that openMicrophoneStream surfaces in diagnostics.
    for (const mode of ["exact-device-raw", "ideal-device-raw", "default-raw"]) {
      expect(microphoneConstraintStrategies("mic-1").map((entry) => entry.mode)).not.toContain(
        mode,
      );
    }
  });

  it("keeps noise suppression on through every non-final constraint strategy", () => {
    // Explicit selection keeps the device exact/ideal until the final permission
    // request. Processing is only dropped on the bare `{ audio: true }` step.
    const ladder = microphoneConstraintStrategies("mic-1");
    for (const entry of ladder.slice(0, -1)) {
      const audio = entry.constraints.audio as MediaTrackConstraints;
      if (entry.mode === "exact-device") {
        expect(audio.noiseSuppression).toBe(true);
        expect(audio.echoCancellation).toBe(true);
        expect(audio.autoGainControl).toBe(true);
      }
    }
    const relaxedEntry = ladder.at(-1);
    expect(relaxedEntry?.constraints).toEqual({ audio: true });
    // Explicit raw capture: NS/AEC off; AGC remains on unless disabled.
    const raw = microphoneConstraintStrategies("mic-1", {
      noiseSuppression: false,
      autoGainControl: true,
    });
    for (const entry of raw.slice(0, -1)) {
      if (entry.mode === "exact-device") {
        const audio = entry.constraints.audio as MediaTrackConstraints;
        expect(audio.noiseSuppression).toBe(false);
        expect(audio.autoGainControl).toBe(true);
      }
    }
  });

  it("encodes PCM and creates a mono 16 kHz chunk", () => {
    const pcm = float32ToPcm16(new Float32Array([0, 0.5, -0.5]));
    expect(pcm16ToBase64(pcm)).toBe("AAD/PwDA");
    expect(bytesToBase64(new Uint8Array([0, 1, 255]))).toBe("AAH/");
    // Multi-chunk encode path (buffers larger than the 8 KiB apply step).
    const large = new Uint8Array(20_000);
    for (let index = 0; index < large.length; index += 1) {
      large[index] = index % 256;
    }
    expect(bytesToBase64(large).length).toBeGreaterThan(0);
    expect(atob(bytesToBase64(large)).length).toBe(large.length);
    const chunk = makeAudioChunk(new Float32Array([0, 1, 0, -1]), 4, 1000, {
      utteranceId: "utt-test",
    });
    expect(chunk.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(chunk.channels).toBe(1);
    expect(chunk.durationMs).toBe(1000);
    expect(chunk.utteranceId).toBe("utt-test");
    expect(chunk.pcmBase64.length).toBeGreaterThan(0);
    // Sub-millisecond non-empty chunks must still satisfy the Rust duration floor.
    expect(makeAudioChunk(new Float32Array([0, 0]), 16_000).durationMs).toBe(1);
    expect(makeAudioChunk(new Float32Array(), 16_000).durationMs).toBe(0);
    // A realistic 1.2 s mono 16 kHz caption chunk must encode to non-empty base64.
    const captionSamples = new Float32Array(16_000 * 1.2).map((_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 16_000),
    );
    const captionChunk = makeAudioChunk(captionSamples, 16_000, 1_200);
    expect(captionChunk.durationMs).toBe(1_200);
    expect(captionChunk.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(captionChunk.pcmBase64.length).toBeGreaterThan(1_000);
    // Decode must be even-length PCM16 — Rust rejects odd byte lengths.
    const decoded = atob(captionChunk.pcmBase64);
    expect(decoded.length % 2).toBe(0);
    expect(decoded.length).toBe(16_000 * 1.2 * 2);
    // 48 kHz capture path (diagnostics may show sr=48000): WAV PCM is still 16 kHz mono.
    const from48k = makeAudioChunk(new Float32Array(48_000 * 1.2), 48_000, 1_200);
    expect(from48k.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(from48k.channels).toBe(1);
    expect(from48k.durationMs).toBe(1_200);
    expect(atob(from48k.pcmBase64).length).toBe(TARGET_SAMPLE_RATE * 1.2 * 2);
    // Silent float buffer still encodes as mono 16 kHz (backend soft-skips empty ASR).
    const silent48k = makeAudioChunk(new Float32Array(48_000), 48_000, 1_000);
    expect(silent48k.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(atob(silent48k.pcmBase64).length).toBe(TARGET_SAMPLE_RATE * 2);
    // Duration clamp + invalid rate fallback for Rust validation window.
    expect(makeAudioChunk(new Float32Array([0.1]), 16_000, 0).durationMs).toBe(1);
    expect(makeAudioChunk(new Float32Array([0.1]), 16_000, 50_000).durationMs).toBe(10_000);
    expect(makeAudioChunk(new Float32Array([0.1]), 16_000, Number.NaN).durationMs).toBe(1);
    expect(makeAudioChunk(new Float32Array([0.1]), 0, 100).sampleRate).toBe(TARGET_SAMPLE_RATE);
    vi.stubGlobal("btoa", undefined);
    expect(() => pcm16ToBase64(pcm)).toThrow("base64 encoding is unavailable");
    vi.unstubAllGlobals();
  });

  it("always reports the resampled 16 kHz rate regardless of hardware rate or chunk size", () => {
    // Regression contract: the chunk's sampleRate must equal the gateway's
    // expected 16 kHz — never the hardware (AudioContext) rate — and the PCM
    // payload must be exactly round(len * 16000 / rate) samples for every
    // capture rate and chunk size the pipeline can produce.
    const rates = [8_000, 44_100, 48_000, 96_000];
    const chunkSizes = [1_000, 4_096, 8_192, 43_200, 48_000, 50_000];
    for (const rate of rates) {
      for (const size of chunkSizes) {
        const samples = new Float32Array(size).map((_, index) =>
          Math.sin((2 * Math.PI * 220 * index) / rate),
        );
        const chunk = makeAudioChunk(samples, rate, 900);
        expect(chunk.sampleRate).toBe(TARGET_SAMPLE_RATE);
        expect(chunk.channels).toBe(1);
        const decoded = atob(chunk.pcmBase64);
        expect(decoded.length % 2).toBe(0);
        expect(decoded.length).toBe(Math.round((size * TARGET_SAMPLE_RATE) / rate) * 2);
      }
    }
    // Hardware-rate inputs must never leak into the reported rate.
    expect(makeAudioChunk(new Float32Array(48_000), 48_000, 1_000).sampleRate).toBe(16_000);
  });

  it("preserves signal energy across the 48k→16k linear resample", () => {
    // A 440 Hz sine at 48 kHz downsized to 16 kHz must keep its RMS within a
    // small tolerance (linear interpolation is not lossless, but must not
    // degrade the level a speech gate or ASR relies on).
    const makeSine = (rate: number, length: number): Float32Array =>
      new Float32Array(length).map((_, index) => Math.sin((2 * Math.PI * 440 * index) / rate));
    const at48k = makeSine(48_000, 48_000);
    const downsampled = resampleLinear(at48k, 48_000, 16_000);
    expect(downsampled.length).toBe(16_000);
    const rmsOriginal = calculateRmsDb(at48k);
    const rmsDown = calculateRmsDb(downsampled);
    expect(Math.abs(rmsDown - rmsOriginal)).toBeLessThan(0.5);
    // Round-trip of an arbitrary non-multiple chunk size stays exact.
    const odd = makeSine(48_000, 7_680);
    expect(resampleLinear(odd, 48_000, 16_000).length).toBe(2_560);
  });

  it("lists only real audio input device IDs after permission is available", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: "audioinput", deviceId: "", label: "", groupId: "group-0" },
          { kind: "audioinput", deviceId: "mic-1", label: "USB Mic", groupId: "group-1" },
          { kind: "videoinput", deviceId: "camera-1", label: "Camera", groupId: "group-2" },
          { kind: "audioinput", deviceId: "", label: "", groupId: "" },
          {
            kind: "audioinput",
            deviceId: "built-in",
            label: "Built-in Mic",
            groupId: "group-3",
          },
        ]),
      },
    });
    // Empty deviceIds (pre-permission placeholders) are omitted so the UI cannot
    // select fabricated IDs that break getUserMedia({ deviceId: { exact } }).
    await expect(enumerateAudioInputDevices()).resolves.toEqual([
      { deviceId: "mic-1", label: "USB Mic", groupId: "group-1" },
      { deviceId: "built-in", label: "Built-in Mic", groupId: "group-3" },
    ]);
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    await expect(enumerateAudioInputDevices()).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it("exposes stable capture error codes for localization", () => {
    const error = new AudioCaptureError("microphone-unavailable");
    expect(error.name).toBe("AudioCaptureError");
    expect(error.message).toBe("microphone-unavailable");
    expect(error.code).toBe("microphone-unavailable");
    const withCause = new AudioCaptureError("audio-context-suspended", new Error("blocked"));
    expect(withCause.message).toContain("blocked");
    expect(withCause.causeError).toBeInstanceOf(Error);
  });

  it("does not silently fall back to the default microphone for an explicit device", async () => {
    const permissionStream = {
      id: "permission",
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const deviceStream = {
      id: "device",
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(permissionStream)
      .mockRejectedValueOnce(new DOMException("bad device", "OverconstrainedError"))
      .mockRejectedValueOnce(new DOMException("still bad", "OverconstrainedError"))
      .mockRejectedValueOnce(new DOMException("string id bad", "OverconstrainedError"));

    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });

    // Permission is granted first; device retarget failures keep that stream.
    await expect(openMicrophoneStream("stale-device")).resolves.toEqual({
      stream: permissionStream,
      mode: "default-relaxed",
    });
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({ audio: true });
    vi.unstubAllGlobals();

    const getUserMediaOk = vi
      .fn()
      .mockResolvedValueOnce(permissionStream)
      .mockResolvedValueOnce(deviceStream);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUserMediaOk },
    });
    await expect(openMicrophoneStream("mic-1")).resolves.toEqual({
      stream: deviceStream,
      mode: "exact-device-relaxed",
    });
    vi.unstubAllGlobals();
  });

  it("retries the system default with relaxed constraints", async () => {
    const stream = {
      id: "stream-2",
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });

    await expect(openMicrophoneStream("default")).resolves.toMatchObject({
      stream,
    });
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({ audio: true });
    vi.unstubAllGlobals();
  });

  it("opens with bare audio permission even when processing constraints are invalid", async () => {
    const stream = {
      id: "stream-webkit",
      getTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia,
        getSupportedConstraints: () => ({
          deviceId: true,
          echoCancellation: true,
        }),
      },
    });

    await expect(openMicrophoneStream("default")).resolves.toMatchObject({
      stream,
      mode: expect.stringMatching(/default/),
    });
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({ audio: true });
    vi.unstubAllGlobals();
  });

  it("does not retry getUserMedia after a permission denial", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });
    await expect(openMicrophoneStream("mic-1")).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("exposes capture diagnostics helpers", () => {
    const snapshot = getLastAudioCaptureDiagnostics();
    expect(snapshot).toMatchObject({
      active: false,
      captureMode: "none",
      lastRmsDb: null,
      chunksAccepted: 0,
    });
    expect(formatAudioCaptureDiagnostics(snapshot)).toBe("");
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        active: true,
        captureMode: "worklet",
        constraintMode: "default-relaxed",
        contextState: "running",
        sampleRate: 48_000,
        lastRmsDb: -24.5,
        chunksAccepted: 3,
        lastError: "boom",
      }),
    ).toContain("error=boom");
    // The effective constraint mode must be visible so a fallback to the
    // relaxed (no NS/AEC) strategy is never silent.
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        captureMode: "worklet",
        constraintMode: "default-relaxed",
      }),
    ).toContain("constraints=default-relaxed");
    // Hardware may report 48 kHz; diagnostics must still advertise encode target 16 kHz.
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        active: true,
        captureMode: "worklet",
        sampleRate: 48_000,
        lastRmsDb: -54.2,
        lastAcceptedRmsDb: -48.1,
        lastAcceptedGain: 4.2,
        chunksAccepted: 8,
      }),
    ).toMatch(/sr=48000.*encodeSr=16000|encodeSr=16000.*sr=48000/);
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        lastAcceptedRmsDb: -48.1,
        lastAcceptedGain: 4.2,
        chunksAccepted: 1,
      }),
    ).toMatch(/acceptedRms=-48\.1dB.*gain=4\.20x|gain=4\.20x.*acceptedRms=-48\.1dB/);
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        captureMode: "script-processor",
        lastRmsDb: -24.5,
        chunksAccepted: 3,
        absoluteFloorDrops: 3,
        consecutiveAbsoluteFloorDrops: 2,
      }),
    ).toMatch(/rms=-24\.5dB/);
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        absoluteFloorDrops: 3,
        consecutiveAbsoluteFloorDrops: 2,
      }),
    ).toMatch(/floorDrops=3.*floorStreak=2|floorStreak=2.*floorDrops=3/);
  });

  it("surfaces the silence gate mode in diagnostics", () => {
    const snapshot = getLastAudioCaptureDiagnostics();
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        captureMode: "worklet",
        gateMode: "adaptive",
        adaptiveFloorDb: -65.3,
      }),
    ).toContain("gate=adaptive·floor=-65.3dB");
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        captureMode: "worklet",
        gateMode: "fixed",
        fixedGateDb: -50,
      }),
    ).toContain("gate=fixed(-50.0dB)");
    // Default snapshot reports no gate until a capture session starts.
    expect(formatAudioCaptureDiagnostics(snapshot)).not.toContain("gate=");
  });

  it("includes lifecycle and continuous-stream loss counters in diagnostics", () => {
    const snapshot = getLastAudioCaptureDiagnostics();
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        trackMuteEvents: 1,
        deviceChangeEvents: 2,
        contextStateChanges: 3,
        contextRecoveryAttempts: 1,
        streamFramesDropped: 4,
      }),
    ).toMatch(
      /muteEvents=1.*deviceChanges=2.*contextChanges=3.*contextRecovery=1.*streamDropped=4/,
    );
  });

  it("formats all active capture diagnostics fields for the debug panel", () => {
    const snapshot = getLastAudioCaptureDiagnostics();
    const detail = formatAudioCaptureDiagnostics({
      ...snapshot,
      active: true,
      captureMode: "worklet",
      constraintMode: "default",
      contextState: "running",
      sampleRate: 48_000,
      trackReadyState: "live",
      trackLabel: "Built-in Mic",
      trackMuted: true,
      trackMuteEvents: 1,
      deviceChangeEvents: 1,
      contextStateChanges: 1,
      contextRecoveryAttempts: 1,
      lastRmsDb: -42.5,
      lastAcceptedRmsDb: -38.5,
      lastAcceptedGain: 2,
      chunksAccepted: 1,
      chunksDroppedSilent: 1,
      absoluteFloorDrops: 1,
      consecutiveAbsoluteFloorDrops: 1,
      streamFramesDropped: 1,
      gateMode: "adaptive",
      adaptiveFloorDb: null,
    });

    expect(detail).toContain("track=live");
    expect(detail).toContain("muted");
    expect(detail).toContain("muteEvents=1");
    expect(detail).toContain("deviceChanges=1");
    expect(detail).toContain("contextChanges=1");
    expect(detail).toContain("contextRecovery=1");
    expect(detail).toContain("acceptedRms=-38.5dB");
    expect(detail).toContain("gain=2.00x");
    expect(detail).toContain("silent=1");
    expect(detail).toContain("floorDrops=1");
    expect(detail).toContain("floorStreak=1");
    expect(detail).toContain("streamDropped=1");
    expect(detail).toContain("gate=adaptive");
  });

  it("only allocates verbose chunk logs when pipeline logging is enabled", () => {
    const wasVerbose = isVerbosePipelineLogging();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const capture = new MicrophoneCapture();
      const internals = capture as unknown as {
        context: { sampleRate: number };
        handler: (chunk: AudioChunk) => void;
        chunkMs: number;
        gateMode: "fixed";
        silenceGateDb: number;
        acceptSamples: (samples: Float32Array) => void;
      };
      internals.context = { sampleRate: TARGET_SAMPLE_RATE };
      internals.handler = vi.fn();
      internals.chunkMs = DEFAULT_AUDIO_CHUNK_MS;
      internals.gateMode = "fixed";
      internals.silenceGateDb = -90;

      setVerbosePipelineLogging(false);
      internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
      expect(debug).not.toHaveBeenCalled();

      setVerbosePipelineLogging(true);
      internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
      expect(debug).toHaveBeenCalledWith("[audio] chunk accepted", expect.any(Object));
    } finally {
      setVerbosePipelineLogging(wasVerbose);
      debug.mockRestore();
    }
  });

  it("normalizes malformed chunk windows in start and before the hot sample loop", async () => {
    const capture = new MicrophoneCapture();
    const startInternals = capture as unknown as { chunkMs: number };
    // AudioContext is intentionally unavailable in this unit environment, but
    // start() assigns its validated configuration before opening hardware.
    await expect(capture.start("default", Number.NaN, -50, null)).rejects.toBeInstanceOf(Error);
    expect(startInternals.chunkMs).toBe(DEFAULT_AUDIO_CHUNK_MS);

    const handler = vi.fn();
    const hotCapture = new MicrophoneCapture();
    const internals = hotCapture as unknown as {
      context: { sampleRate: number };
      handler: (chunk: AudioChunk) => void;
      chunkMs: number;
      gateMode: "fixed";
      silenceGateDb: number;
      acceptSamples: (samples: Float32Array) => void;
    };
    internals.context = { sampleRate: TARGET_SAMPLE_RATE };
    internals.handler = handler;
    internals.chunkMs = 0;
    internals.gateMode = "fixed";
    internals.silenceGateDb = -90;

    internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));

    // Zero must not become Math.max(1, 0), which would enqueue 10,240 tiny
    // chunks. It is reset to the normal 640 ms window and emits exactly one.
    expect(internals.chunkMs).toBe(DEFAULT_AUDIO_CHUNK_MS);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("propagates normalized start settings and resolves adaptive/fixed gates", async () => {
    const startPreparedCapture = async (adaptiveGate?: boolean) => {
      const capture = new MicrophoneCapture();
      const track = {
        readyState: "live",
        stop: vi.fn(),
      } as unknown as MediaStreamTrack;
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      const processor = {
        onaudioprocess: null as ScriptProcessorNode["onaudioprocess"],
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const sink = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      const context = {
        state: "running",
        sampleRate: TARGET_SAMPLE_RATE,
        createMediaStreamSource: vi.fn(() => source),
        createScriptProcessor: vi.fn(() => processor),
        createGain: vi.fn(() => sink),
        destination: {},
        close: vi.fn(async () => undefined),
      };
      const internals = capture as unknown as {
        context: AudioContext | null;
        stream: MediaStream | null;
        hardwareReady: boolean;
        deviceIdRequested: string | null;
        processing: { noiseSuppression: boolean; autoGainControl: boolean };
        chunkMs: number;
        gateMode: "adaptive" | "fixed";
        silenceGateDb: number;
      };
      internals.context = context as unknown as AudioContext;
      internals.stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream;
      internals.hardwareReady = true;
      internals.deviceIdRequested = "default";
      internals.processing = { noiseSuppression: true, autoGainControl: true };
      await capture.start("default", 333, -60, null, undefined, undefined, true, {
        adaptiveGate,
      });
      return { capture, internals };
    };

    const adaptive = await startPreparedCapture();
    expect(adaptive.internals).toMatchObject({
      chunkMs: 333,
      gateMode: "adaptive",
      silenceGateDb: DEFAULT_SILENCE_GATE_DB,
    });
    await adaptive.capture.stop();

    const fixed = await startPreparedCapture(false);
    expect(fixed.internals).toMatchObject({
      chunkMs: 333,
      gateMode: "fixed",
      silenceGateDb: -60,
    });
    await fixed.capture.stop();
  });

  it("surfaces synchronous and rejected chunk delivery without throwing from capture", async () => {
    const setup = (handler: (chunk: AudioChunk) => void | Promise<void>) => {
      const capture = new MicrophoneCapture();
      const onError = vi.fn();
      const internals = capture as unknown as {
        context: { sampleRate: number };
        handler: (chunk: AudioChunk) => void | Promise<void>;
        errorHandler: (error: AudioCaptureError) => void;
        chunkMs: number;
        gateMode: "fixed";
        silenceGateDb: number;
        acceptSamples: (samples: Float32Array) => void;
      };
      internals.context = { sampleRate: TARGET_SAMPLE_RATE };
      internals.handler = handler;
      internals.errorHandler = onError;
      internals.chunkMs = DEFAULT_AUDIO_CHUNK_MS;
      internals.gateMode = "fixed";
      internals.silenceGateDb = -90;
      return { capture, internals, onError };
    };

    const synchronous = setup(() => {
      throw new Error("sync chunk rejection");
    });
    expect(() =>
      synchronous.internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1)),
    ).not.toThrow();
    expect(synchronous.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "audio-chunk-delivery-failed" }),
    );

    const asynchronous = setup(() => Promise.reject(new Error("async chunk rejection")));
    asynchronous.internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
    await Promise.resolve();
    expect(asynchronous.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "audio-chunk-delivery-failed" }),
    );
  });

  it("records track mute/unmute without stopping a capture that can recover", () => {
    const listeners = new Map<string, () => void>();
    const track = {
      label: "USB mic",
      muted: false,
      readyState: "live",
      addEventListener: vi.fn((type: string, listener: () => void) =>
        listeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    } as unknown as MediaStreamTrack;
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const internals = capture as unknown as {
      stream: MediaStream | null;
      errorHandler: (error: AudioCaptureError) => void;
      bindTrackEnded: (stream: MediaStream) => void;
    };
    internals.errorHandler = onError;
    internals.stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    internals.bindTrackEnded(internals.stream);

    (track as unknown as { muted: boolean }).muted = true;
    listeners.get("mute")?.();
    expect(capture.getDiagnostics()).toMatchObject({
      trackMuted: true,
      trackMuteEvents: 1,
      lastErrorCode: "microphone-track-muted",
    });
    expect(onError).not.toHaveBeenCalled();

    (track as unknown as { muted: boolean }).muted = false;
    listeners.get("unmute")?.();
    expect(capture.getDiagnostics()).toMatchObject({ trackMuted: false, lastErrorCode: null });
  });

  it("makes one best-effort AudioContext resume after a suspended lifecycle event", async () => {
    const listeners = new Map<string, () => void>();
    const context = {
      state: "suspended",
      sampleRate: TARGET_SAMPLE_RATE,
      resume: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) =>
        listeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    };
    context.resume.mockImplementation(() => {
      context.state = "running";
      return Promise.resolve();
    });
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const internals = capture as unknown as {
      context: AudioContext | null;
      errorHandler: (error: AudioCaptureError) => void;
      bindContextStateChange: (context: AudioContext) => void;
    };
    internals.context = context as unknown as AudioContext;
    internals.errorHandler = onError;
    internals.bindContextStateChange(context as unknown as AudioContext);

    listeners.get("statechange")?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(capture.getDiagnostics()).toMatchObject({
      contextState: "running",
      contextStateChanges: 1,
      contextRecoveryAttempts: 1,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("records device-list changes without reconnecting the microphone", () => {
    const listeners = new Map<string, () => void>();
    const addEventListener = vi.fn((type: string, listener: () => void) =>
      listeners.set(type, listener),
    );
    const removeEventListener = vi.fn((type: string) => listeners.delete(type));
    vi.stubGlobal("navigator", { mediaDevices: { addEventListener, removeEventListener } });
    try {
      const capture = new MicrophoneCapture();
      const internals = capture as unknown as { bindDeviceChange: () => void };
      internals.bindDeviceChange();
      listeners.get("devicechange")?.();
      expect(capture.getDiagnostics()).toMatchObject({ deviceChangeEvents: 1 });
      expect(addEventListener).toHaveBeenCalledWith("devicechange", expect.any(Function));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports dropped continuous PCM frames as a Parapper transport failure", () => {
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const internals = capture as unknown as {
      context: { sampleRate: number };
      streamPcmHandler: (frame: Uint8Array) => void;
      errorHandler: (error: AudioCaptureError) => void;
      acceptSamples: (samples: Float32Array) => void;
    };
    internals.context = { sampleRate: TARGET_SAMPLE_RATE };
    internals.streamPcmHandler = () => {
      throw new Error("socket closed");
    };
    internals.errorHandler = onError;

    internals.acceptSamples(new Float32Array(128).fill(0.1));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "parapper-transport-failed" }),
    );
    expect(capture.getDiagnostics()).toMatchObject({
      streamFramesDropped: 1,
      lastErrorCode: "parapper-transport-failed",
    });
    expect(snapshotPipelineDrops()).toMatchObject({
      total: 1,
      bySource: { audio: 1 },
      byReason: { "stream-frame-delivery-failed": 1 },
    });
  });

  it("contains ScriptProcessor callback failures and disables the failing node", () => {
    const processor = {
      onaudioprocess: null as ScriptProcessorNode["onaudioprocess"],
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const sink = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const internals = capture as unknown as {
      context: AudioContext | null;
      source: MediaStreamAudioSourceNode | null;
      errorHandler: (error: AudioCaptureError) => void;
      startScriptProcessor: () => void;
    };
    internals.context = {
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => sink),
      destination: {},
    } as unknown as AudioContext;
    internals.source = source as unknown as MediaStreamAudioSourceNode;
    internals.errorHandler = onError;
    internals.startScriptProcessor();

    const callback = processor.onaudioprocess;
    expect(() =>
      callback?.call(
        processor as unknown as ScriptProcessorNode,
        {
          inputBuffer: {
            getChannelData: () => {
              throw new Error("frame unavailable");
            },
          },
        } as unknown as AudioProcessingEvent,
      ),
    ).not.toThrow();
    expect(processor.onaudioprocess).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "audio-chunk-delivery-failed" }),
    );
  });

  it("reports an AudioWorklet processor crash once with the active delivery code", () => {
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const worklet = { onprocessorerror: null } as unknown as AudioWorkletNode;
    const internals = capture as unknown as {
      worklet: AudioWorkletNode | null;
      streamPcmHandler: ((frame: Uint8Array) => void) | null;
      errorHandler: (error: AudioCaptureError) => void;
      bindWorkletProcessorError: (node: AudioWorkletNode) => void;
    };
    internals.worklet = worklet;
    internals.streamPcmHandler = () => undefined;
    internals.errorHandler = onError;
    internals.bindWorkletProcessorError(worklet);

    const callback = worklet.onprocessorerror;
    callback?.call(worklet, { message: "processor crashed" } as ErrorEvent);
    callback?.call(worklet, { message: "duplicate crash" } as ErrorEvent);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "parapper-transport-failed",
        message: "parapper-transport-failed: processor crashed",
      }),
    );
    expect(capture.getDiagnostics().lastErrorCode).toBe("parapper-transport-failed");
  });

  it("classifies an AudioWorklet processor crash as chunk delivery outside Parapper mode", () => {
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const worklet = { onprocessorerror: null } as unknown as AudioWorkletNode;
    const internals = capture as unknown as {
      worklet: AudioWorkletNode | null;
      errorHandler: (error: AudioCaptureError) => void;
      bindWorkletProcessorError: (node: AudioWorkletNode) => void;
    };
    internals.worklet = worklet;
    internals.errorHandler = onError;
    internals.bindWorkletProcessorError(worklet);

    worklet.onprocessorerror?.call(worklet, { message: "processor crashed" } as ErrorEvent);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "audio-chunk-delivery-failed" }),
    );
  });

  it("maps dBFS to a 0–1 meter fill", () => {
    expect(rmsDbToMeterLevel(null)).toBe(0);
    expect(rmsDbToMeterLevel(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(rmsDbToMeterLevel(-60)).toBe(0);
    expect(rmsDbToMeterLevel(-6)).toBe(1);
    expect(rmsDbToMeterLevel(-33)).toBeCloseTo(0.5, 5);
  });

  it("primes microphone access then stops temporary tracks", async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });
    // Default constraint ladder now resolves to processed "default" (NS on),
    // not the old raw default that left mics at ~-54 dBFS ambient.
    await expect(ensureMicrophoneAccess()).resolves.toBe("default");
    expect(getUserMedia).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("flushes a speech tail through stop with its measured duration", async () => {
    const capture = new MicrophoneCapture();
    const handler = vi.fn();
    const internals = capture as unknown as {
      pending: Float32Array;
      handler: ((chunk: ReturnType<typeof makeAudioChunk>) => void) | null;
    };
    // 200 ms at the target rate: shorter than the configured 640 ms window,
    // but long enough to preserve a short utterance when capture stops.
    internals.pending = new Float32Array(3_200).fill(0.1);
    internals.handler = handler;

    await capture.stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      sampleRate: TARGET_SAMPLE_RATE,
      durationMs: 200,
    });
  });

  it("flushes a short speech tail through stop even below the streaming minimum", async () => {
    const capture = new MicrophoneCapture();
    const handler = vi.fn();
    const internals = capture as unknown as {
      pending: Float32Array;
      handler: ((chunk: ReturnType<typeof makeAudioChunk>) => void) | null;
    };
    // 100 ms at the target rate would previously be dropped by the
    // PARTIAL_FLUSH_MIN_MS safeguard.
    internals.pending = new Float32Array(1_600).fill(0.1);
    internals.handler = handler;

    await capture.stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      sampleRate: TARGET_SAMPLE_RATE,
      durationMs: 100,
    });
  });

  it("flushes a partial AudioWorklet frame before disabling capture", async () => {
    const capture = new MicrophoneCapture();
    const handler = vi.fn();
    let onMessage: ((event: MessageEvent<unknown>) => void) | null = null;
    const port = {
      set onmessage(value: ((event: MessageEvent<unknown>) => void) | null) {
        onMessage = value;
      },
      postMessage: vi.fn((message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "flush"
        ) {
          onMessage?.({ data: new Float32Array(1_600).fill(0.1) } as MessageEvent<unknown>);
          onMessage?.({ data: { type: "flushed" } } as MessageEvent<unknown>);
        }
      }),
    };
    const internals = capture as unknown as {
      worklet: { port: typeof port };
      context: { sampleRate: number };
      handler: ((chunk: ReturnType<typeof makeAudioChunk>) => void) | null;
      acceptSamples: (samples: Float32Array) => void;
      finishWorkletFlush: () => void;
    };
    internals.worklet = { port };
    internals.context = { sampleRate: TARGET_SAMPLE_RATE };
    internals.handler = handler;
    onMessage = (event) => {
      if (event.data instanceof Float32Array) {
        internals.acceptSamples(event.data);
      } else if (
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as { type?: string }).type === "flushed"
      ) {
        internals.finishWorkletFlush();
      }
    };

    await capture.stop();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ durationMs: 100 });
  });

  it("reports a rejected final tail but still completes microphone cleanup", async () => {
    const capture = new MicrophoneCapture();
    const onError = vi.fn();
    const internals = capture as unknown as {
      pending: Float32Array;
      handler: ((chunk: ReturnType<typeof makeAudioChunk>) => Promise<void>) | null;
      errorHandler: (error: AudioCaptureError) => void;
    };
    internals.pending = new Float32Array(1_600).fill(0.1);
    internals.handler = async () => Promise.reject(new Error("caption queue rejected tail"));
    internals.errorHandler = onError;

    await expect(capture.stop()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "audio-chunk-delivery-failed" }),
    );
    expect(capture.getDiagnostics()).toMatchObject({
      active: false,
      captureMode: "none",
      lastErrorCode: "audio-chunk-delivery-failed",
    });
  });

  it("emits contextual durations from live capture and resets after a gated gap", () => {
    const capture = new MicrophoneCapture();
    const handler = vi.fn();
    const internals = capture as unknown as {
      context: { sampleRate: number };
      handler: (chunk: ReturnType<typeof makeAudioChunk>) => void;
      chunkMs: number;
      gateMode: "fixed";
      silenceGateDb: number;
      acceptSamples: (samples: Float32Array) => void;
    };
    internals.context = { sampleRate: 1_000 };
    internals.handler = handler;
    internals.chunkMs = 640;
    internals.gateMode = "fixed";
    internals.silenceGateDb = -30;

    internals.acceptSamples(new Float32Array(640).fill(0.1));
    internals.acceptSamples(new Float32Array(640).fill(0.2));
    expect(handler.mock.calls.map(([chunk]) => chunk.durationMs)).toEqual([640, 1_280]);
    const firstUtteranceId = handler.mock.calls[0]?.[0].utteranceId;
    expect(firstUtteranceId).toEqual(expect.any(String));
    expect(handler.mock.calls[1]?.[0].utteranceId).toBe(firstUtteranceId);

    // A full gated window starts a new utterance; the next accepted request
    // must not carry stale audio from the previous utterance.
    internals.acceptSamples(new Float32Array(640));
    internals.acceptSamples(new Float32Array(640).fill(0.3));
    expect(handler.mock.calls.map(([chunk]) => chunk.durationMs)).toEqual([640, 1_280, 640]);
    expect(handler.mock.calls[2]?.[0].utteranceId).toEqual(expect.any(String));
    expect(handler.mock.calls[2]?.[0].utteranceId).not.toBe(firstUtteranceId);

    // A hardware sample-rate change also starts a fresh correlation key rather
    // than mixing sample counts from two clocks.
    internals.context.sampleRate = 2_000;
    internals.acceptSamples(new Float32Array(1_280).fill(0.4));
    expect(handler.mock.calls[3]?.[0].durationMs).toBe(640);
    expect(handler.mock.calls[3]?.[0].utteranceId).not.toBe(handler.mock.calls[2]?.[0].utteranceId);
  });

  it("streams raw PCM frames, including silence, without applying the legacy gate", () => {
    const capture = new MicrophoneCapture();
    const frames: Uint8Array[] = [];
    const internals = capture as unknown as {
      context: { sampleRate: number };
      handler: null;
      streamPcmHandler: (frame: Uint8Array) => void;
      acceptSamples: (samples: Float32Array) => void;
    };
    internals.context = { sampleRate: TARGET_SAMPLE_RATE };
    internals.handler = null;
    internals.streamPcmHandler = (frame) => frames.push(frame);

    internals.acceptSamples(new Float32Array(1_024));
    internals.acceptSamples(new Float32Array(1_024).fill(0.25));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(1_024 * 2);
    expect(new Set(frames[0])).toEqual(new Set([0]));
    expect(new Set(frames[1])).not.toEqual(new Set([0]));
    expect(new Set(frames[1]).size).toBeGreaterThan(1);
  });

  it("falls back to monotonic utterance ID when crypto.randomUUID fails", () => {
    // Save the original crypto
    const originalCrypto = globalThis.crypto;

    try {
      // Mock crypto.randomUUID to throw
      Object.defineProperty(globalThis, "crypto", {
        value: {
          randomUUID: vi.fn(() => {
            throw new Error("Crypto unavailable");
          }),
        },
        configurable: true,
      });

      const capture = new MicrophoneCapture();
      const handler = vi.fn();
      const internals = capture as unknown as {
        context: { sampleRate: number };
        handler: (chunk: AudioChunk) => void;
        acceptSamples: (samples: Float32Array) => void;
      };
      internals.context = { sampleRate: TARGET_SAMPLE_RATE };
      internals.handler = handler;

      internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
      expect(handler).toHaveBeenCalled();
      const utteranceId = handler.mock.calls[0]?.[0].utteranceId;
      expect(utteranceId).toMatch(/^utterance-/);
      expect(utteranceId).not.toMatch(/^[a-f0-9-]{36}$/); // Not a UUID
    } finally {
      // Restore original crypto
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it("falls back to monotonic utterance ID when crypto is unavailable", () => {
    // Save the original crypto
    const originalCrypto = globalThis.crypto;

    try {
      // Mock crypto as undefined
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });

      const capture = new MicrophoneCapture();
      const handler = vi.fn();
      const internals = capture as unknown as {
        context: { sampleRate: number };
        handler: (chunk: AudioChunk) => void;
        acceptSamples: (samples: Float32Array) => void;
      };
      internals.context = { sampleRate: TARGET_SAMPLE_RATE };
      internals.handler = handler;

      internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
      expect(handler).toHaveBeenCalled();
      const utteranceId = handler.mock.calls[0]?.[0].utteranceId;
      expect(utteranceId).toMatch(/^utterance-/);
    } finally {
      // Restore original crypto
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it("falls back to monotonic utterance ID when randomUUID is not a function", () => {
    // Save the original crypto
    const originalCrypto = globalThis.crypto;

    try {
      // Mock crypto.randomUUID as not a function
      Object.defineProperty(globalThis, "crypto", {
        value: {
          randomUUID: null,
        },
        configurable: true,
      });

      const capture = new MicrophoneCapture();
      const handler = vi.fn();
      const internals = capture as unknown as {
        context: { sampleRate: number };
        handler: (chunk: AudioChunk) => void;
        acceptSamples: (samples: Float32Array) => void;
      };
      internals.context = { sampleRate: TARGET_SAMPLE_RATE };
      internals.handler = handler;

      internals.acceptSamples(new Float32Array(FULL_CAPTURE_CHUNK_SAMPLES).fill(0.1));
      expect(handler).toHaveBeenCalled();
      const utteranceId = handler.mock.calls[0]?.[0].utteranceId;
      expect(utteranceId).toMatch(/^utterance-/);
    } finally {
      // Restore original crypto
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });
});
