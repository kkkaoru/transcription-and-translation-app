import { describe, expect, it, vi } from "vitest";
import {
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
  bytesToBase64,
  calculatePeak,
  calculateRmsDb,
  createAdaptiveSilenceGate,
  createMicrophoneConstraints,
  createRollingAudioContext,
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
import type { AudioChunk } from "./types";

const FULL_CAPTURE_CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * DEFAULT_AUDIO_CHUNK_MS) / 1_000;

describe("audio conversion", () => {
  it("keeps a speech-aware partial tail only when it reaches the minimum duration", () => {
    expect(PARTIAL_FLUSH_MIN_MS).toBe(160);
    expect(partialAudioDurationMs(7_680, 48_000)).toBe(160);
    expect(partialAudioDurationMs(2_560, 16_000)).toBe(160);
    expect(shouldFlushPartialAudio(7_679, 48_000)).toBe(false);
    expect(shouldFlushPartialAudio(7_680, 48_000)).toBe(true);
    expect(shouldFlushPartialAudio(1, 0)).toBe(false);
    expect(shouldFlushPartialAudio(0, 16_000)).toBe(false);
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
    expect(createMicrophoneConstraints("default").audio).toMatchObject({
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    // Explicit raw path: NS/AEC off, AGC still on for quiet mics.
    expect(createMicrophoneConstraints("default", { noiseSuppression: false }).audio).toMatchObject(
      {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    );
    expect(
      (createMicrophoneConstraints("default").audio as MediaTrackConstraints).deviceId,
    ).toBeUndefined();
    expect(createMicrophoneConstraints("usb-mic").audio).toMatchObject({
      deviceId: { exact: "usb-mic" },
      channelCount: { ideal: 1 },
      noiseSuppression: true,
    });
    expect(createMicrophoneConstraints("usb-mic", { idealDevice: true }).audio).toMatchObject({
      deviceId: { ideal: "usb-mic" },
    });
    expect(createMicrophoneConstraints("default", { relaxProcessing: true }).audio).toMatchObject({
      channelCount: { ideal: 1 },
    });
    expect(
      (
        createMicrophoneConstraints("default", { relaxProcessing: true })
          .audio as MediaTrackConstraints
      ).echoCancellation,
    ).toBeUndefined();
  });

  it("orders constraint strategies from strict device pin to relaxed default", () => {
    expect(microphoneConstraintStrategies("mic-1").map((entry) => entry.mode)).toEqual([
      "exact-device",
      "ideal-device",
      "default",
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
    // Default (noiseSuppression=true): NS/AEC/AGC requested until the final
    // relaxed fallback, which omits them so a picky WebView can still open.
    const ladder = microphoneConstraintStrategies("mic-1");
    for (const entry of ladder.slice(0, -1)) {
      const audio = entry.constraints.audio as MediaTrackConstraints;
      expect(audio.noiseSuppression).toBe(true);
      expect(audio.echoCancellation).toBe(true);
      expect(audio.autoGainControl).toBe(true);
    }
    const relaxedEntry = ladder.at(-1);
    const relaxed = relaxedEntry?.constraints.audio as MediaTrackConstraints;
    expect(relaxed.noiseSuppression).toBeUndefined();
    expect(relaxed.echoCancellation).toBeUndefined();
    expect(relaxed.autoGainControl).toBeUndefined();
    // Explicit raw capture: NS/AEC off but AGC stays on for quiet mics.
    const raw = microphoneConstraintStrategies("mic-1", false);
    for (const entry of raw.slice(0, -1)) {
      const audio = entry.constraints.audio as MediaTrackConstraints;
      expect(audio.noiseSuppression).toBe(false);
      expect(audio.autoGainControl).toBe(true);
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

  it("falls back through microphone constraint strategies", async () => {
    const stream = { id: "stream-1" } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("bad device", "OverconstrainedError"))
      .mockRejectedValueOnce(new DOMException("still bad", "OverconstrainedError"))
      .mockResolvedValueOnce(stream);

    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });

    await expect(openMicrophoneStream("stale-device")).resolves.toEqual({
      stream,
      mode: "default",
    });
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    // First successful strategy should request noise suppression by default.
    const lastConstraints = getUserMedia.mock.calls.at(-1)?.[0] as MediaStreamConstraints;
    expect((lastConstraints.audio as MediaTrackConstraints).noiseSuppression).toBe(true);
    vi.unstubAllGlobals();
  });

  it("retries microphone capture on NotReadableError with relaxed defaults", async () => {
    const stream = { id: "stream-2" } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("busy", "NotReadableError"))
      .mockRejectedValueOnce(new DOMException("still busy", "NotReadableError"))
      .mockResolvedValueOnce(stream);

    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
    });

    await expect(openMicrophoneStream("mic-1")).resolves.toEqual({
      stream,
      mode: "default",
    });
    expect(getUserMedia).toHaveBeenCalledTimes(3);
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
      }),
    ).toMatch(/rms=-24\.5dB/);
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
