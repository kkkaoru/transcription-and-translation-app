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
  pcm16ToBase64,
  resampleLinear,
  rmsDbToMeterLevel,
} from "./audio";

describe("audio conversion", () => {
  it("resamples a signal with linear interpolation", () => {
    const output = resampleLinear(new Float32Array([0, 1, 0, -1]), 4, 2);
    expect([...output]).toEqual([0, 0]);
    expect(resampleLinear(new Float32Array([0, 1]), 2, 2)).toEqual(new Float32Array([0, 1]));
    expect(resampleLinear(new Float32Array(), 4, 2)).toEqual(new Float32Array());
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

  it("builds progressive microphone constraints for device selection", () => {
    expect(createMicrophoneConstraints("default").audio).toMatchObject({
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
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
    const chunk = makeAudioChunk(new Float32Array([0, 1, 0, -1]), 4, 1000);
    expect(chunk.sampleRate).toBe(16_000);
    expect(chunk.channels).toBe(1);
    expect(chunk.durationMs).toBe(1000);
    expect(chunk.pcmBase64.length).toBeGreaterThan(0);
    // Sub-millisecond non-empty chunks must still satisfy the Rust duration floor.
    expect(makeAudioChunk(new Float32Array([0, 0]), 16_000).durationMs).toBe(1);
    expect(makeAudioChunk(new Float32Array(), 16_000).durationMs).toBe(0);
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
        captureMode: "worklet",
        constraintMode: "default-relaxed",
        contextState: "running",
        sampleRate: 48_000,
        lastRmsDb: -24.5,
        chunksAccepted: 3,
        lastError: "boom",
      }),
    ).toContain("error=boom");
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
