import { describe, expect, it, vi } from "vitest";
import {
  AudioCaptureError,
  bytesToBase64,
  calculateRmsDb,
  createMicrophoneConstraints,
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  float32ToPcm16,
  formatAudioCaptureDiagnostics,
  getLastAudioCaptureDiagnostics,
  makeAudioChunk,
  microphoneConstraintStrategies,
  openMicrophoneStream,
  passesSilenceGate,
  pcm16ToBase64,
  resampleLinear,
  rmsDbToMeterLevel,
  TARGET_SAMPLE_RATE,
} from "./audio";
import { DEFAULT_SILENCE_GATE_DB } from "./defaults";

describe("audio conversion", () => {
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

  it("builds progressive microphone constraints for device selection", () => {
    expect(createMicrophoneConstraints("default").audio).toMatchObject({
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      // AGC on so quiet mics are not stuck near the silence floor.
      autoGainControl: true,
    });
    expect(
      (createMicrophoneConstraints("default").audio as MediaTrackConstraints).deviceId,
    ).toBeUndefined();
    expect(createMicrophoneConstraints("usb-mic").audio).toMatchObject({
      deviceId: { exact: "usb-mic" },
      channelCount: { ideal: 1 },
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
      "exact-device-raw",
      "ideal-device-raw",
      "default-raw",
      "default-relaxed",
    ]);
    expect(microphoneConstraintStrategies("default").map((entry) => entry.mode)).toEqual([
      "default-raw",
      "default-relaxed",
    ]);
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
    const chunk = makeAudioChunk(new Float32Array([0, 1, 0, -1]), 4, 1000);
    expect(chunk.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(chunk.channels).toBe(1);
    expect(chunk.durationMs).toBe(1000);
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
      mode: "default-raw",
    });
    expect(getUserMedia).toHaveBeenCalledTimes(3);
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
      mode: "default-raw",
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
    // Hardware may report 48 kHz; diagnostics must still advertise encode target 16 kHz.
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        active: true,
        captureMode: "worklet",
        sampleRate: 48_000,
        lastRmsDb: -54.2,
        chunksAccepted: 8,
      }),
    ).toMatch(/sr=48000.*encodeSr=16000|encodeSr=16000.*sr=48000/);
    expect(
      formatAudioCaptureDiagnostics({
        ...snapshot,
        captureMode: "script-processor",
        lastRmsDb: -24.5,
        chunksAccepted: 3,
      }),
    ).toMatch(/rms=-24\.5dB/);
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
    await expect(ensureMicrophoneAccess()).resolves.toBe("default-raw");
    expect(getUserMedia).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
