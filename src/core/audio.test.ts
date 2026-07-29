import { describe, expect, it, vi } from "vitest";
import {
  AudioCaptureError,
  bytesToBase64,
  calculateRmsDb,
  createMicrophoneConstraints,
  enumerateAudioInputDevices,
  float32ToPcm16,
  makeAudioChunk,
  pcm16ToBase64,
  resampleLinear,
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

  it("pins capture to the selected microphone when one is chosen", () => {
    expect(createMicrophoneConstraints("default").audio).toMatchObject({
      deviceId: undefined,
      channelCount: 1,
    });
    expect(createMicrophoneConstraints("usb-mic").audio).toMatchObject({
      deviceId: { exact: "usb-mic" },
      channelCount: 1,
    });
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
    expect(makeAudioChunk(new Float32Array([0, 0]), 16_000).durationMs).toBe(0);
    vi.stubGlobal("btoa", undefined);
    expect(() => pcm16ToBase64(pcm)).toThrow("base64 encoding is unavailable");
    vi.unstubAllGlobals();
  });

  it("lists audio input devices after permission is available", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: "audioinput", deviceId: "", label: "", groupId: "group-0" },
          { kind: "audioinput", deviceId: "mic-1", label: "USB Mic", groupId: "group-1" },
          { kind: "videoinput", deviceId: "camera-1", label: "Camera", groupId: "group-2" },
          { kind: "audioinput", deviceId: "", label: "", groupId: "" },
        ]),
      },
    });
    await expect(enumerateAudioInputDevices()).resolves.toEqual([
      { deviceId: "default", label: "", groupId: "group-0" },
      { deviceId: "mic-1", label: "USB Mic", groupId: "group-1" },
      { deviceId: "audio-input-2", label: "", groupId: "" },
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
  });
});
